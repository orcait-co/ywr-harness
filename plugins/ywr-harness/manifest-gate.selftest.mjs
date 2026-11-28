// Negative test for manifest-gate.mjs — every mutation MUST make the gate exit 1.
// Usage: node --test-reporter=<file URL of lib/selftest-reporter.mjs> --test-reporter-destination=stdout manifest-gate.selftest.mjs
//
// Why this exists: a gate that has only ever been observed passing is not known to work. The
// gate's own comments name the failure class it guards against (green selftests over a payload
// field name nothing carried), and the gate would be an instance of that class if nothing ever
// proved it can fail.
//
// Each case resets a temp copy of the plugin to pristine (asserted), mutates one thing, and runs the gate there.
// The real plugin is never modified.
//
// The pwsh suite named its cases by a tag such as `version-removed` and printed a detail after the name. Each test
// here is `MG<n> <the old tag>`, in the order of the pwsh suite, so the parity check of ADR 0227 decision 8
// matches the names. Patterns are pwsh -match sources (case-insensitive; see toRx in lib/selftest-lib.mjs).
// The pwsh suite counted a mutation as caught on exit 1 and printed a `mutations= caught= missed= control=` line;
// the node:test reporter counts the tests, and the `unmutated-control` test holds the control verdict.
//
// This file is itself scanned by the gate it tests: the stack check reads its import lines and its call-form
// imports, so the fixture text below that holds such a line is assembled from parts, and the ADR number that must
// not resolve is assembled at run time.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync,
  copyFileSync, cpSync, chmodSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, runNode, toRx, innerJobs } from './lib/selftest-lib.mjs'
import { git_result, git_absent } from './scripts/harness_git.mjs'

const src = path.dirname(fileURLToPath(import.meta.url))
// The gate is Node since ADR 0141, and this suite runs under node, so no absent-node branch exists here. The
// git calls of the fixtures run through harness_git.mjs, which starts the real git.exe beside the Git for Windows
// launcher (ADR 0111: two processes per call otherwise), and each gate child resolves it the same way for its own
// lockstep and ADR-reference calls. Teardown is exception-safe: `after` runs on a failure, and removeFixtureRoot
// refuses anything outside the temp root.
const base = fixtureRoot('manifest-gate-selftest')
after(() => removeFixtureRoot(base))

const m = (out, pattern) => toRx(pattern).test(out)
const p2 = (...parts) => path.join(...parts)
const latin1 = (b) => b.toString('latin1')
const fromLatin1 = (s) => Buffer.from(s, 'latin1')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
// A string replace that reads its pattern and its replacement literally, as the .NET String.Replace of the
// pwsh suite did: every occurrence, case-sensitive, no `$` pattern in the replacement.
const replaceAll = (text, a, b) => text.split(a).join(b)
const editFile = (file, fn) => writeFileSync(file, fn(readFileSync(file, 'utf8')))
const editJson = (file, fn) => { const j = JSON.parse(readFileSync(file, 'utf8')); fn(j); writeFileSync(file, JSON.stringify(j, null, 2)) }
const lazy = (build) => {
  let state = null
  return () => {
    if (!state) { try { state = { v: build() } } catch (e) { state = { e } } }
    if (state.e) throw state.e
    return state.v
  }
}

// Test names run in file order and carry a running ID. A conditional test registers under the same ID either way.
//
// Each case is a JOB. The tests still run one after the other, so the names print in file order, but a test
// body starts the jobs of the next AHEAD tests before it awaits its own, and the jobs run concurrently: a case
// is one `node` gate child plus a mutation, and the children are independent processes. Concurrency is bounded
// twice. Each fixture family holds a POOL of working trees, so two cases never share a tree, and a global
// limiter allows at most SLOTS gate children at once. A job reads and writes only the tree it acquired and
// its own fixture directory, so no case sees another's mutation. The reset of a tree stays asserted.
// A job is started by a test body that has already run, so a name filter that selects one test starts the
// next few jobs only. A job that fails keeps its error for its own test: the promise is awaited there.
const SLOTS = innerJobs(4, 2)
const AHEAD = SLOTS * 2
let seq = 0
const jobs = []
function kick(upTo) {
  for (let j = 0; j < jobs.length && j <= upTo; j++) {
    const jb = jobs[j]
    if (jb.started || jb.skip) continue
    jb.started = true
    jb.promise = (async () => jb.fn())()
    jb.promise.catch(() => {})
  }
}
const mg = (tag, fn, opts = {}) => {
  const idx = jobs.length
  const job = { fn, skip: Boolean(opts.skip), started: false, promise: null }
  jobs.push(job)
  test(`MG${++seq} ${tag}`, opts, async () => { kick(idx + AHEAD); await job.promise })
}
// Memoise an async builder: every caller shares the one promise, and a failure is kept and rethrown.
const lazyP = (build) => {
  let p = null
  return () => (p ??= build())
}

// --- the gate run ---------------------------------------------------------------------------------
// One `node` child per gate run (ADR 0141 Decision 3): ~0.06 s to start where the pwsh gate's runspace
// cost ~0.41 s per case. This suite is a NEGATIVE suite — its PASS is "the gate exited 1" — so the abort
// shape matters more here than anywhere: Node itself exits 1 on an uncaught exception, a failed import
// and a syntax error, the very code a caught mutation gives. A gate run therefore counts only when it
// ends in the gate's own summary line for its code (`manifest-gate: FAILED (N)` for 1, `manifest-gate:
// all checks passed` for 0); any other ending, any other code (the gate's own catch exits 2) and a
// missing gate file come back -1/aborted, which no case accepts. Both pipes are read as UTF-8, whatever
// the console's code page. The contracts are pinned as cases at the end.
// A nested `node --test` that inherits NODE_TEST_CONTEXT writes a stream for its parent, so a child never gets it.
function childEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return env
}
// The same child as runNode in lib/selftest-lib.mjs, started without blocking the event loop so that several gate
// runs overlap. Output is decoded once as UTF-8 and stdin gets `input`, as there. A start that fails comes back as
// `error` with a null status, which no case accepts.
function runNodeAsync(args, { env, input } = {}) {
  return new Promise((resolve) => {
    const out = []
    const err = []
    let error
    let done = false
    const finish = (status, signal) => {
      if (done) return
      done = true
      resolve({ status, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), error })
    }
    const c = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    c.stdout.on('data', (d) => out.push(d))
    c.stderr.on('data', (d) => err.push(d))
    c.stdin.on('error', () => {})
    c.on('error', (e) => { error = e; finish(null, null) })
    c.on('close', finish)
    c.stdin.end(input)
  })
}
// At most SLOTS gate children run at once. A waiter takes over the slot of the child that ended.
let slotsInUse = 0
const slotWaiters = []
async function inSlot(fn) {
  if (slotsInUse >= SLOTS) await new Promise((resolve) => slotWaiters.push(resolve))
  else slotsInUse++
  try { return await fn() } finally {
    const next = slotWaiters.shift()
    if (next) next()
    else slotsInUse--
  }
}
async function invokeGate(gatePath, args = [], input = undefined) {
  if (!existsSync(gatePath) || !statSync(gatePath).isFile()) return { out: `script not found: ${gatePath}`, code: -1, aborted: true }
  const r = await inSlot(() => runNodeAsync([gatePath, ...args], { env: childEnv(), input }))
  const out = r.stdout + r.stderr
  const lines = r.stdout.split(/\r?\n/u).filter((l) => l)
  const last = lines.length ? lines[lines.length - 1] : ''
  const summed = (r.status === 1 && /^manifest-gate: FAILED \(\d+\)$/iu.test(last)) ||
    (r.status === 0 && last.toLowerCase() === 'manifest-gate: all checks passed')
  if (!summed) return { out: `exit ${r.status} without the gate's summary line\n${out}`, code: -1, aborted: true }
  return { out, code: r.status, aborted: false, stdout: r.stdout }
}

// --- copy once, reset per case (ADR 0111) --------------------------------------------------------
// Each fixture family copies once into a pristine snapshot plus one working tree. Before every case
// the working tree is reset to the snapshot and the reset is asserted: the full state (every file's relative path and
// SHA-256, every directory, and the Unix mode off Windows) must equal the snapshot's, or the suite
// throws. A case therefore never sees a previous case's mutation — an added file or directory, a
// `.git` from `git init`, a deleted file, an edited byte — and a reset that missed one is a loud
// abort, not a leaked fixture. Copy a directory ITSELF to a not-yet-existing destination:
// pre-creating it would nest the copy one level down.
const win = process.platform === 'win32'
function entriesOf(root) {
  const rootFull = path.resolve(root)
  const out = []
  for (const e of readdirSync(rootFull, { recursive: true, withFileTypes: true })) {
    const full = path.join(e.parentPath ?? e.path, e.name)
    out.push({ rel: path.relative(rootFull, full).split(path.sep).join('/'), full, dir: e.isDirectory() })
  }
  return out
}
const modeOf = (full) => (win ? '' : ` ${statSync(full).mode & 0o777}`)
function getTreeState(root) {
  const state = new Map()
  for (const e of entriesOf(root)) {
    if (e.dir) state.set(`${e.rel}/`, `dir${modeOf(e.full)}`)
    else state.set(e.rel, createHash('sha256').update(readFileSync(e.full)).digest('hex').toUpperCase() + modeOf(e.full))
  }
  return state
}
// The PRE-reset scan is cheap: (length, mtime) per entry, no read. It only decides what to RESTORE — a
// signature that equals the last known-pristine one means "leave it", so a mutation that keeps both
// length and mtime would be missed here, and assertFixturePristine (the full SHA-256 state, unchanged
// and run AFTER every reset) then throws: a miss is a loud abort, never a leaked fixture. Hashing the
// whole tree BEFORE the reset too was 128 x ~250 files = 19.6 s of a 118 s suite (2026-09-29 profile,
// ADR 0111). The signature is re-taken after each asserted reset, so it never depends on whether
// the copy preserves mtimes on the OS.
function getTreeSig(root) {
  const sig = new Map()
  for (const e of entriesOf(root)) {
    if (e.dir) sig.set(`${e.rel}/`, `dir${modeOf(e.full)}`)
    else { const st = statSync(e.full, { bigint: true }); sig.set(e.rel, `${st.size}|${st.mtimeNs}${modeOf(e.full)}`) }
  }
  return sig
}
// build lays the tree at the WORKING path, and the pristine snapshot is one copy of it. On Windows,
// Defender scans a freshly written file on its first open, synchronously: ~2.7 s per 117-file plugin
// copy, .ps1 at ~50 ms a file, and a scanned file stays cheap for any process (fact 165). Built the
// other way round, the copy opened the fresh pristine and the first asserted reset the fresh working
// tree — two scans a family. Now the copy's read is the one scan, the state is taken from the scanned
// working tree, and a pristine file is opened only when a reset restores it. A pristine copy that
// differed would differ from the state on its first restore, which the assert throws on.
// A family is a POOL of working trees (see the jobs note above): `trees[0]` is the tree the build laid, and a case
// that finds every tree busy gets one more copy of the pristine snapshot, up to SLOTS trees. A tree is handed out
// by acquireTree, reset and asserted there, and handed back by releaseTree. A tree beyond the first sits beside the
// first (`<name>.w<n>`), so every tree has the same parent directory and the same depth.
function newFixture(name, build) {
  const work = p2(base, name)
  build(work)
  const pristine = p2(base, `${name}.pristine`)
  cpSync(work, pristine, { recursive: true, force: true })
  const first = { work, sig: getTreeSig(work) }
  return { name, pristine, work, state: getTreeState(work), trees: [first], free: [first], waiters: [] }
}
function assertFixturePristine(fx, t) {
  const have = getTreeState(t.work)
  const diff = [...fx.state.keys()].filter((k) => !have.has(k) || have.get(k) !== fx.state.get(k))
    .concat([...have.keys()].filter((k) => !fx.state.has(k)))
  if (diff.length) throw new Error(`fixture '${fx.name}' reset NOT pristine — a case would see a previous case's mutation: ${diff.slice(0, 5).join(', ')}`)
}
async function acquireTree(fx) {
  let t = fx.free.pop()
  if (!t) {
    if (fx.trees.length < SLOTS) {
      const work = p2(base, `${fx.name}.w${fx.trees.length}`)
      cpSync(fx.pristine, work, { recursive: true, force: true })
      t = { work, sig: getTreeSig(work) }
      fx.trees.push(t)
    } else {
      t = await new Promise((resolve) => fx.waiters.push(resolve))
    }
  }
  try { resetTree(fx, t) } catch (e) { releaseTree(fx, t); throw e }
  return t
}
function releaseTree(fx, t) {
  const next = fx.waiters.shift()
  if (next) next(t)
  else fx.free.push(t)
}
// Runs fn on a reset tree of the family and hands the tree back, whatever fn does. `getFx` may build lazily.
async function withTree(getFx, fn) {
  const fx = await getFx()
  const t = await acquireTree(fx)
  try { return await fn(t.work) } finally { releaseTree(fx, t) }
}
function resetTree(fx, t) {
  const want = t.sig
  const have = getTreeSig(t.work)
  // Remove what the snapshot does not have, then restore what differs or is gone. Shallowest first
  // (an ancestor's path is always the shorter): one recursive remove takes a whole added `.git`, and
  // its ~400 entries are then already gone — removing each one deepest-first was ~2.5 s of a 2.7 s
  // reset in every git case (measured 2026-09-28). The assert below still proves nothing survived.
  for (const rel of [...have.keys()].filter((k) => !want.has(k)).sort((a, b) => a.length - b.length)) {
    const p = p2(t.work, rel.replace(/\/$/u, ''))
    if (existsSync(p)) rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
  }
  for (const rel of want.keys()) {
    if (have.has(rel) && have.get(rel) === want.get(rel)) continue
    const p = p2(t.work, rel.replace(/\/$/u, ''))
    if (rel.endsWith('/')) { mkdirSync(p, { recursive: true }); continue }
    mkdirSync(path.dirname(p), { recursive: true })
    copyFileSync(p2(fx.pristine, rel), p)
  }
  assertFixturePristine(fx, t)
  t.sig = getTreeSig(t.work)
  return t.work
}
// The plugin tree a fixture copies is the WORK TREE MINUS ITS GITIGNORED FILES: `git ls-files --cached
// --others --exclude-standard`, so an unadded new file is in and the owner's eval results, the mod
// build's types, __pycache__ and tsconfig.json are out: they are never shipped, and CI's checkout has
// none of them, so the fixture matches the tree CI gates. Outside a git work tree (the Linux parity image mounts the plugin alone) or on any
// git failure it falls back to the whole-directory copy. A tracked file deleted in the work tree is
// skipped. `to` must not exist yet. `env` adds variables to the git call, for the fallback case.
const gitHere = !git_absent()
function copyPluginTree(from, to, env = null) {
  let list = []
  if (gitHere) {
    const r = git_result(from, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { env })
    if (r.status === 0) list = r.stdout.split('\0').filter(Boolean)
  }
  if (!list.length) { cpSync(from, to, { recursive: true, force: true }); return }
  for (const rel of list) {
    const srcFile = p2(from, rel)
    if (!existsSync(srcFile) || !statSync(srcFile).isFile()) continue
    const dst = p2(to, rel)
    mkdirSync(path.dirname(dst), { recursive: true })
    copyFileSync(srcFile, dst)
    if (!win) chmodSync(dst, statSync(srcFile).mode & 0o777)
  }
}
const pluginFx = lazy(() => newFixture('plugin', (p) => copyPluginTree(src, p)))

// expect: the case's own Bad line must be in the output, so an exit 1 from some OTHER check the
// mutation happens to trip cannot stand in for the check under test (review 2026-10-02, C9).
function tryCase(tag, mutate, expect = '') {
  mg(tag, () => withTree(pluginFx, async (dir) => {
    mutate(dir)
    const g = await invokeGate(p2(dir, 'manifest-gate.mjs'))
    if (g.code === 1) {
      if (expect) assert.ok(m(g.out, expect), `gate exited 1 but not on the check under test (no line matching '${expect}')\n${g.out}`)
      return
    }
    if (g.aborted) assert.fail(`gate ABORTED — not an exit code, nothing was proven: ${g.out.split('\n')[0]}`)
    assert.fail(`gate exited ${g.code} — mutation NOT caught`)
  }))
}

tryCase('version-removed', (d) => { editJson(p2(d, '.claude-plugin/plugin.json'), (j) => { delete j.version }) })
tryCase('version-not-semantic', (d) => { editJson(p2(d, '.claude-plugin/plugin.json'), (j) => { j.version = 'v1' }) })
tryCase('name-not-kebab', (d) => { editJson(p2(d, '.claude-plugin/plugin.json'), (j) => { j.name = 'YWR Harness' }) })
tryCase('displayName-removed', (d) => { editJson(p2(d, '.claude-plugin/plugin.json'), (j) => { delete j.displayName }) })

tryCase('hook-path-broken', (d) => {
  editFile(p2(d, 'hooks/hooks.json'), (t) => replaceAll(t, 'config-change-audit.mjs', 'config-change-audit-MOVED.mjs'))
})

tryCase('exec-form-regressed', (d) => {
  editJson(p2(d, 'hooks/hooks.json'), (j) => {
    const h = j.hooks.ConfigChange[0].hooks[0]
    h.command = '"${CLAUDE_PLUGIN_ROOT}/hooks/config-change-audit.mjs"'
    delete h.args
  })
})

// `modules` (ADR 0117; the entry is mods.mjs since ADR 0138): a moved module file, a second entry, and a suffix the host does not load.
tryCase('module-path-broken', (d) => {
  editFile(p2(d, 'hooks/hooks.json'), (t) => replaceAll(t, '"./mods.mjs"', '"./delegation-ledger-MOVED.mjs"'))
}, 'module path does not exist')

tryCase('module-two-entries', (d) => {
  editFile(p2(d, 'hooks/hooks.json'), (t) => replaceAll(t, '"./mods.mjs"', '"./mods.mjs", "./hook-lib.mjs"'))
}, "'modules' must hold exactly one path")

tryCase('module-bad-suffix', (d) => {
  copyFileSync(p2(d, 'hooks/mods.mjs'), p2(d, 'hooks/delegation-ledger.txt'))
  editFile(p2(d, 'hooks/hooks.json'), (t) => replaceAll(t, '"./mods.mjs"', '"./delegation-ledger.txt"'))
}, 'has a suffix the host does not load')

// An upper-case suffix: the reference names lower-case suffixes, so a case-folding compare is wrong.
tryCase('module-suffix-case', (d) => {
  copyFileSync(p2(d, 'hooks/mods.mjs'), p2(d, 'hooks/delegation-ledger2.MJS'))
  editFile(p2(d, 'hooks/hooks.json'), (t) => replaceAll(t, '"./mods.mjs"', '"./delegation-ledger2.MJS"'))
}, 'has a suffix the host does not load')

// A module that exists in this checkout but outside the plugin root never ships.
tryCase('module-outside-root', (d) => {
  copyFileSync(p2(d, 'hooks/mods.mjs'), p2(path.dirname(d), 'outside-module.mjs'))
  editFile(p2(d, 'hooks/hooks.json'), (t) => replaceAll(t, '"./mods.mjs"', '"../../outside-module.mjs"'))
}, 'resolves outside the plugin root')

tryCase('no-events', (d) => { writeFileSync(p2(d, 'hooks/hooks.json'), '{"hooks":{}}') })

// Same class as no-events, one level down: the event exists but its handler array is empty, so
// the hook is registered and never runs. Enumerated because the no-events defect was an instance
// of "@($null).Count is 1", not a one-off.
tryCase('event-with-no-handlers', (d) => { writeFileSync(p2(d, 'hooks/hooks.json'), '{"hooks":{"SubagentStop":[{"hooks":[]}]}}') })

// The defect a live session found and the whole suite had missed: every selftest calls the scripts
// directly, so nothing went through the host's component registry, where a bare name does not
// resolve. Both forms are pinned — the runtime-fatal one and the copy-paste one. The plugin ships no
// workflow (ywr-harness ADR 0215), so the case adds a fixture workflow for the bare call to name.
tryCase('bare-workflow-call', (d) => {
  mkdirSync(p2(d, 'workflows'), { recursive: true })
  writeFileSync(p2(d, 'workflows/fixture-flow.js'), '// fixture\n')
  appendFileSync(p2(d, 'README.md'), "\nRun it: Workflow({name: 'fixture-flow', args: {}})\n")
})

// The gate reads this file too, so the backticked command is assembled from parts: a literal one would be a bare
// slash invocation on this line.
const tick = '`'
tryCase('bare-skill-slash', (d) => { appendFileSync(p2(d, 'README.md'), `\nThen invoke ${tick}/verify${tick} to check it.\n`) })

// Two copies of one script are only safe while something proves they are the same file. Without
// this case, a fix applied to scripts/ would silently never reach a scaffolded repo, and the symptom
// would read as "the consumer is behind" instead of "the canon ships two different files".
tryCase('vendored-copy-diverged', (d) => {
  appendFileSync(p2(d, 'skills/harness-init/templates/scripts/harness/harness_config.mjs'), '\n# local drift\n')
})

// Same length, same byte multiset, two lines swapped — the copy a set compare (a compare over
// byte arrays, the gate's first cut) read as identical (2026-09-28). The swap is done on the BYTES,
// so length and multiset hold by construction (a text round trip could drop a BOM and fall back to
// what the old length check caught), and the verdict needs the DIVERGED line naming this file — an
// exit 1 from any other check would otherwise keep the case green over a reverted compare (review
// 2026-09-28, both low). The two lines must differ or the swap proves nothing; that throws.
mg('vendored-copy-reordered', () => withTree(pluginFx, async (dir) => {
  const p = p2(dir, 'skills/harness-init/templates/scripts/harness/harness_config.mjs')
  const b = readFileSync(p)
  const e0 = b.indexOf(10)
  const e1 = e0 >= 0 ? b.indexOf(10, e0 + 1) : -1
  if (e1 < 0 || b.subarray(0, e0 + 1).equals(b.subarray(e0 + 1, e1 + 1))) throw new Error('vendored-copy-reordered: harness_config.mjs has no two distinct leading lines to swap')
  writeFileSync(p, Buffer.concat([b.subarray(e0 + 1, e1 + 1), b.subarray(0, e0 + 1), b.subarray(e1 + 1)]))
  const g = await invokeGate(p2(dir, 'manifest-gate.mjs'))
  const diverged = m(g.out, String.raw`vendored copy DIVERGED: harness_config\.mjs`)
  assert.ok(g.code === 1 && diverged, `exit=${g.code} aborted=${g.aborted} diverged-named=${diverged}`)
}))

// ADR 0182 and ADR 0185 share one fixture and one gate run: the two walks read disjoint trees, so one
// run answers both cases without a second fixture copy (+1.7 s measured as a separate case).
// Template half: a bare canon reference in a template fails, in a dot-directory too (the walk must
// not use the hidden-name rule, which drops `.github` off Windows). The same bare text in a markdown
// template and in a `__pycache__` file is out of scope, and a prefixed reference passes, so the case
// asserts exactly the two bare sites, the hyphenated form included.
// Runtime half: a bare reference in a hook comment, in a skill body and in the top CHANGELOG entry
// fails. The canon-only set stays out: the README, a lib file, a selftest and an older CHANGELOG entry
// carry the same bare text and must not be named. The case asserts exactly the three runtime sites,
// so a widened or a narrowed walk both go red. The run is made by the first of the two tests that needs it.
const canonRefRun = lazyP(() => withTree(pluginFx, async (dir) => {
  const tpl = p2(dir, 'skills/harness-init/templates')
  appendFileSync(p2(tpl, '.github/workflows/harness-gates.yml'), '# bare ADR 0062 here; prefixed ywr-harness ADR 0062 there; hyphenated ADR-0063\n')
  appendFileSync(p2(tpl, 'docs/README.md'), '\nSee ADR 0062.\n')
  const pyc = p2(tpl, 'scripts/harness/__pycache__')
  mkdirSync(pyc, { recursive: true })
  writeFileSync(p2(pyc, 'x.cpython-312.pyc'), 'compiled spec 0012 text')
  appendFileSync(p2(dir, 'hooks/decision-prompts.mjs'), '// bare ADR 0175 here; prefixed ywr-harness ADR 0175 there\n')
  appendFileSync(p2(dir, 'skills/verify/SKILL.md'), '\nSee spec 0008 for the gate.\n')
  for (const skip of ['README.md', 'lib/selftest-lib.mjs', 'hooks/hook-lib.selftest.mjs']) {
    appendFileSync(p2(dir, skip), '\n# canon-only: ADR 0175, fact 12\n')
  }
  const cl = p2(dir, 'CHANGELOG.md')
  const clLines = readFileSync(cl, 'utf8').split(/\r\n|\n|\r/u)
  if (clLines.length && clLines[clLines.length - 1] === '') clLines.pop()
  const heads = []
  clLines.forEach((l, i) => { if (/^##\s+v/u.test(l)) heads.push(i) })
  if (heads.length < 2) throw new Error('runtime-canon-ref-bare: the fixture CHANGELOG has fewer than two entries')
  clLines.splice(heads[1] + 1, 0, '- older entry: ADR 0030 stays bare')
  clLines.splice(heads[0] + 1, 0, '- top entry: fact 186 is bare')
  writeFileSync(cl, clLines.join(os.EOL) + os.EOL)
  return { g: await invokeGate(p2(dir, 'manifest-gate.mjs')), head0: heads[0] }
}))
mg('template-canon-ref-bare', async () => {
  const { g } = await canonRefRun()
  const hits = g.out.split('\n').filter((l) => m(l, 'canon reference: templates/'))
  const caught = g.code === 1 && hits.length === 2 &&
    m(hits[0], String.raw`templates/\.github/workflows/harness-gates\.yml:\d+ 'ADR 0062'`) &&
    m(hits[1], String.raw`harness-gates\.yml:\d+ 'ADR-0063'`)
  assert.ok(caught, `exit=${g.code} aborted=${g.aborted} hits=${hits.length}: ${hits.join(' | ')}`)
})
mg('runtime-canon-ref-bare', async () => {
  const { g, head0 } = await canonRefRun()
  const hits = g.out.split('\n').filter((l) => m(l, 'canon reference: ') && !m(l, 'canon reference: templates/'))
  const one = (pat) => hits.filter((l) => m(l, pat)).length === 1
  const caught = g.code === 1 && hits.length === 3 &&
    one(String.raw`hooks/decision-prompts\.mjs:\d+ 'ADR 0175'`) &&
    one(String.raw`skills/verify/SKILL\.md:\d+ 'spec 0008'`) &&
    one(String.raw`CHANGELOG\.md:${head0 + 2} 'fact 186' in the top entry`)
  assert.ok(caught, `exit=${g.code} aborted=${g.aborted} hits=${hits.length}: ${hits.join(' | ')}`)
})

tryCase('vendored-copy-orphaned', (d) => { rmSync(p2(d, 'scripts/harness_config.mjs'), { force: true }) })

tryCase('unparseable-manifest', (d) => { writeFileSync(p2(d, '.claude-plugin/plugin.json'), '{ this is not json') })

// The release-notes canon (ADR 0030): a release shipping without notes, with stale notes, or
// with a link that no longer matches the hook's would each surface only on member machines —
// as a bullet-less or wrong-tab announcement — which is why the gate owns them canon-side.
// The runtime canon-reference check (ADR 0185) must also say that it skipped the top entry, never
// print a PASS that silently drops it; the release-notes failure comes first in the output.
tryCase('changelog-missing', (d) => { rmSync(p2(d, 'CHANGELOG.md'), { force: true }) },
  String.raw`CHANGELOG\.md missing[\s\S]*top CHANGELOG entry was NOT CHECKED`)

tryCase('changelog-version-stale', (d) => {
  const j = JSON.parse(readFileSync(p2(d, '.claude-plugin/plugin.json'), 'utf8'))
  editFile(p2(d, 'CHANGELOG.md'), (t) => replaceAll(t, `## v${j.version}`, '## v0.0.1'))
})

const zeroUrl = 'artifact/00000000-0000-0000-0000-000000000000#rn'
tryCase('rn-url-diverged', (d) => {
  editFile(p2(d, 'CHANGELOG.md'), (t) => t.replace(/artifact\/[0-9a-f-]+#rn/gu, () => zeroUrl))
})

// The same divergence from the OTHER side: the hook is Node now (ADR 0116), and the gate must read
// the `.mjs` constant — a gate still pointed at the retired `.ps1` would read an empty URL for the
// hook and fail as "link missing" for the wrong reason, or pass vacuously if it skipped the check.
tryCase('rn-url-hook-diverged', (d) => {
  editFile(p2(d, 'hooks/session-start-version-announce.mjs'), (t) => t.replace(/artifact\/[0-9a-f-]+#rn/gu, () => zeroUrl))
})

// The interpolation trap ADR 0045 makes reachable in every hook: Korean letters are legal in a
// PS variable name, so "$ver를" interpolates an undefined variable named ver를 as EMPTY — the
// value silently vanishes from the member banner (measured live 2026-08-11; the hook suites'
// joined sys+ctx match stayed green through the English context half). The gate must refuse the
// CLASS on a non-comment line; the comment-skip is what keeps hooks free to DOCUMENT the trap.
tryCase('hangul-glued-variable', (d) => {
  // A new pwsh hook (ADR 0116: the gate scans hooks/*.ps1 only — the trap cannot exist in .mjs).
  // None ships since ADR 0142, so the case creates one.
  appendFileSync(p2(d, 'hooks/session-start-probe.ps1'), '\n$probe = "지금 $ver를 실행"\n')
})

// Class-4 honesty, asserted on the MESSAGE not the exit code: with plugin.json corrupt and the
// CHANGELOG intact, the gate already exits 1 from the manifest Bad — so an exit-code-only case
// can never catch the defect this pins, which was the CHANGELOG check printing a false
// "(matches plugin.json)" PASS for a comparison it never ran (review 2026-08-05, medium). The
// skipped comparison must say NOT CHECKED.
mg('changelog-check-broken-manifest', () => withTree(pluginFx, async (dir) => {
  writeFileSync(p2(dir, '.claude-plugin/plugin.json'), '{ this is not json')
  const g = await invokeGate(p2(dir, 'manifest-gate.mjs'))
  const falseMatch = m(g.out, String.raw`\(matches plugin\.json\)`)
  const notChecked = m(g.out, 'NOT CHECKED')
  assert.ok(g.code === 1 && !falseMatch && notChecked, `exit=${g.code} falseMatchClaim=${falseMatch} notCheckedReported=${notChecked}`)
}))

// --- dogfood placement sweep (ADR 0037 follow-up) ----------------------------------------------
// Canon-shape fixtures: repo/.harness.json + repo/plugins/ywr-harness/<plugin copy>. Placements
// are laid per case — an absent destination is "not placed", never a failure, so a minimal
// fixture exercises exactly the branch under test without running the scaffold (which would drag
// python/git into a suite that needs neither). Positive cases assert the MESSAGE as well as the
// exit code, the changelog-check-broken-manifest precedent.
// One canon-shape fixture serves every canon case below, reset and asserted per case — the git
// cases included: their `.git` is an entry the snapshot lacks, so the reset removes it.
const canonFx = lazy(() => newFixture('canon', (repo) => {
  mkdirSync(p2(repo, 'plugins'), { recursive: true })
  mkdirSync(p2(repo, '.claude-plugin'), { recursive: true })
  copyPluginTree(src, p2(repo, 'plugins/ywr-harness'))
  writeFileSync(p2(repo, '.harness.json'), '{}')
  writeFileSync(p2(repo, '.claude-plugin/marketplace.json'), '{}')
}))
const runGateAt = async (repo) => {
  const g = await invokeGate(p2(repo, 'plugins/ywr-harness/manifest-gate.mjs'))
  return { out: g.out, rc: g.code, aborted: g.aborted }
}
const placementMjs = (r) => p2(r, 'plugins/ywr-harness/skills/harness-init/placement.mjs')

// A drifted TOOLCHAIN placement must fail — this is the exact class ADR 0037 recorded as ungated.
mg('placement-drifted', () => withTree(canonFx, async (r) => {
  mkdirSync(p2(r, '.githooks'), { recursive: true })
  writeFileSync(p2(r, '.githooks/pre-commit'), '#!/bin/sh\necho drifted')
  const g = await runGateAt(r)
  assert.ok(g.rc === 1 && m(g.out, String.raw`dogfood placement DIVERGED: \.githooks/pre-commit`), `exit=${g.rc} diverged-named=${m(g.out, 'DIVERGED')}\n${g.out}`)
}))

// A CR-only difference is NOT drift — ADR 0033's fold contract, shared with the scaffold report
// and the refresh nudge (the seed .gitattributes pins *.ps1 eol=crlf, so raw bytes MUST not decide).
mg('placement-cr-only-not-drift', () => withTree(canonFx, async (r) => {
  const tpl = readFileSync(p2(r, 'plugins/ywr-harness/skills/harness-init/templates/scripts/harness/harness_config.mjs'))
  const crlf = latin1(tpl).replace(/\r\n/gu, '\n').replace(/\n/gu, '\r\n')
  mkdirSync(p2(r, 'scripts/harness'), { recursive: true })
  writeFileSync(p2(r, 'scripts/harness/harness_config.mjs'), fromLatin1(crlf))
  const g = await runGateAt(r)
  assert.ok(g.rc === 0 && m(g.out, String.raw`dogfood placements identical .*1 checked`), `exit=${g.rc} identical-1-checked=${m(g.out, '1 checked')}\n${g.out}`)
}))

// A GUARDED destination without the marker is a foreign file: skipped and NAMED, exactly as the
// scaffold refuses it — never compared, never failed.
mg('placement-foreign-guarded-skipped', () => withTree(canonFx, async (r) => {
  mkdirSync(p2(r, '.githooks'), { recursive: true })
  writeFileSync(p2(r, '.githooks/post-commit'), "#!/bin/sh\n# my own automation, not the scaffold's")
  const g = await runGateAt(r)
  assert.ok(g.rc === 0 && m(g.out, String.raw`foreign \(no scaffold marker\), skipped .*post-commit`), `exit=${g.rc} foreign-named=${m(g.out, 'foreign')}\n${g.out}`)
}))

// A GUARDED file that DOES carry the marker is ours — drift in it must fail like any placement.
mg('placement-guarded-marked-drift', () => withTree(canonFx, async (r) => {
  mkdirSync(p2(r, '.githooks'), { recursive: true })
  writeFileSync(p2(r, '.githooks/post-commit'), '#!/bin/sh\n# ywr-harness:post-commit\necho drifted')
  const g = await runGateAt(r)
  assert.ok(g.rc === 1 && m(g.out, String.raw`dogfood placement DIVERGED: \.githooks/post-commit`), `exit=${g.rc}\n${g.out}`)
}))

// The pair list is imported from placement.mjs — a read that yields nothing must FAIL, not sweep zero
// pairs and read as coverage.
mg('placement-map-unparseable', () => withTree(canonFx, async (r) => {
  editFile(placementMjs(r), (t) => replaceAll(t, 'export const TOOLCHAIN = ', 'export const RENAMED_MAP = '))
  const g = await runGateAt(r)
  assert.ok(g.rc === 1 && m(g.out, 'an empty sweep is not a pass'), `exit=${g.rc}\n${g.out}`)
}))

// A PARTIALLY unreadable map is the silent-narrowing variant: one entry rewritten in a form the
// reader does not accept (a destination that is not a string) must FAIL loudly, not drop that one pair
// while the sweep still counts >0.
mg('placement-map-partial-parse', () => withTree(canonFx, async (r) => {
  editFile(placementMjs(r), (t) => replaceAll(t, "['githooks/pre-commit', '.githooks/pre-commit'],", "['githooks/pre-commit', 5],"))
  const g = await runGateAt(r)
  assert.ok(g.rc === 1 && m(g.out, 'malformed entry'), `exit=${g.rc} malformed-named=${m(g.out, 'malformed entry')}\n${g.out}`)
}))

// Same class, another shape: an entry with no destination (a one-element list) is not a pair, and a
// reader that skipped it would let that placement vanish (review 2026-08-07, medium).
mg('placement-map-bareword-key', () => withTree(canonFx, async (r) => {
  editFile(placementMjs(r), (t) => replaceAll(t, "['githooks/pre-commit', '.githooks/pre-commit'],", "['githooks/pre-commit'],"))
  const g = await runGateAt(r)
  assert.ok(g.rc === 1 && m(g.out, 'malformed entry'), `exit=${g.rc}\n${g.out}`)
}))

// GUARDED emptiness must fail SYMMETRICALLY with TOOLCHAIN: an emptied table reads as a real empty
// list, so a null-check alone lets one family's coverage vanish while the sweep still reports green
// (review 2026-08-07, high). Commenting out the single entry is exactly the merge-accident shape.
mg('placement-map-guarded-emptied', () => withTree(canonFx, async (r) => {
  editFile(placementMjs(r), (t) => replaceAll(t, "  ['githooks/post-commit', '.githooks/post-commit'],", "  // ['githooks/post-commit', '.githooks/post-commit'],"))
  const g = await runGateAt(r)
  assert.ok(g.rc === 1 && m(g.out, 'an empty sweep is not a pass') && m(g.out, 'guarded=0'), `exit=${g.rc} guarded0-named=${m(g.out, 'guarded=0')}\n${g.out}`)
}))

// A consuming repo that hand-vendors the plugin tree has a declaration but NOT the publisher's
// root marketplace manifest — sweeping its placements against a vendored plugin version would
// fail on version skew, not drift, so the shape must skip and say so (review 2026-08-07, low).
mg('placement-skip-vendored-consumer', async () => {
  const r = p2(base, 'placement-skip-vendored-consumer/repo')
  mkdirSync(p2(r, 'plugins'), { recursive: true })
  copyPluginTree(src, p2(r, 'plugins/ywr-harness'))
  writeFileSync(p2(r, '.harness.json'), '{}')
  const g = await invokeGate(p2(r, 'plugins/ywr-harness/manifest-gate.mjs'))
  const skipSaid = m(g.out, 'dogfood placements: skipped')
  const lockSkip = m(g.out, 'release lockstep: skipped — not the canon dogfood shape')
  assert.ok(g.code === 0 && skipSaid && lockSkip, `exit=${g.code} skip-said=${skipSaid} lockstep-skip-said=${m(g.out, 'release lockstep: skipped')}\n${g.out}`)
})

// The plugins/ parent WITHOUT a .harness.json above (the dist/marketplace-cache shape) is not a
// scaffolded repo: the sweep must say it skipped, not pass silently and not fail.
mg('placement-skip-cache-shape', async () => {
  const r = p2(base, 'placement-skip-cache-shape/plugins')
  mkdirSync(r, { recursive: true })
  copyPluginTree(src, p2(r, 'ywr-harness'))
  const g = await invokeGate(p2(r, 'ywr-harness/manifest-gate.mjs'))
  const skipSaid = m(g.out, 'dogfood placements: skipped')
  const lockSkip = m(g.out, 'release lockstep: skipped — not the canon dogfood shape')
  assert.ok(g.code === 0 && skipSaid && lockSkip, `exit=${g.code} skip-said=${skipSaid} lockstep-skip-said=${m(g.out, 'release lockstep: skipped')}\n${g.out}`)
})

// `--audit-paths` (ADR 0186): the prompt-audit surface, read by the canon release preflight. A path on
// stdin comes back iff it is on the surface; the mode checks nothing and exits 0. The input holds a path
// of each kind on and off the surface, a selftest file, a mixed-case path and a Windows separator.
mg('audit-paths-selects-the-surface', () => {
  const apIn = ['REVIEW.md', 'agents/mech.md', 'skills/slice-close/reference.md', 'skills/harness-init/templates/docs/prompts/review-start.md',
    'workflows/fixture-flow.js', 'hooks/decision-prompts.mjs', 'evals/case/graders/g.md', 'SKILLS/X/Y.MD', 'skills\\verify\\SKILL.md',
    'hooks/hooks.json', 'hooks/slice-status.test.ts', 'hooks/x.selftest.mjs', 'scripts/slice_note.py', 'CHANGELOG.md', 'README.md',
    'skills/harness-init/init.mjs', 'lib/selftest-lib.mjs', 'agents/sub/deep.md']
  const apWant = ['REVIEW.md', 'agents/mech.md', 'skills/slice-close/reference.md', 'skills/harness-init/templates/docs/prompts/review-start.md',
    'workflows/fixture-flow.js', 'hooks/decision-prompts.mjs', 'evals/case/graders/g.md', 'SKILLS/X/Y.MD', 'skills\\verify\\SKILL.md']
  const r = runNode([p2(src, 'manifest-gate.mjs'), '--audit-paths'], { env: childEnv(), input: apIn.map((x) => `${x}\0`).join('') })
  const got = r.stdout.split('\0').filter((x) => x !== '')
  assert.ok(r.status === 0 && got.join('|') === apWant.join('|') && r.stdout.endsWith('\0'), `exit=${r.status} got=${got.join(', ')} stderr=${r.stderr.trim()}`)
})

// copyPluginTree's two branches: every fixture above takes the git-listed branch from
// this checkout, so the whole-directory fallback — the Linux parity image's path — needs its own case.
// A GIT_DIR that does not exist makes `ls-files` fail wherever the temp root sits. The fallback must
// carry every file (an ignored-looking one included) and an empty directory, un-nested under `to`.
mg('fixture-copy-fallback-whole-dir', () => {
  const fbSrc = p2(base, 'copy-fallback-src')
  for (const f of ['a.txt', 'sub/b.txt', 'evals/results/r.json']) {
    mkdirSync(path.dirname(p2(fbSrc, f)), { recursive: true })
    writeFileSync(p2(fbSrc, f), f)
  }
  mkdirSync(p2(fbSrc, 'empty'), { recursive: true })
  const fbDst = p2(base, 'copy-fallback-dst')
  copyPluginTree(fbSrc, fbDst, { GIT_DIR: p2(base, 'no-such-git-dir') })
  const missing = ['a.txt', 'sub/b.txt', 'evals/results/r.json'].filter((f) => !existsSync(p2(fbDst, f)))
    .concat(['empty'].filter((f) => !(existsSync(p2(fbDst, f)) && statSync(p2(fbDst, f)).isDirectory())))
  const nested = existsSync(p2(fbDst, 'copy-fallback-src'))
  assert.ok(!missing.length && !nested, `missing=${missing.join(',')} nested=${nested}`)
})
// The git-listed branch: a path this checkout ignores must be absent from the plugin fixture. A clean
// checkout (CI) ignores nothing, which leaves nothing to assert, and the line says so.
mg('fixture-copy-git-skips-ignored', () => {
  let ignored = []
  if (gitHere) {
    const r = git_result(src, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])
    if (r.status === 0) ignored = r.stdout.split('\0').filter(Boolean)
  }
  const fx = pluginFx()
  if (ignored.length) {
    const leaked = ignored.filter((f) => existsSync(p2(fx.pristine, f)) && statSync(p2(fx.pristine, f)).isFile())
    assert.ok(!leaked.length, `ignored=${ignored.length} leaked=${leaked.length}${leaked.length ? ` first=${leaked[0]}` : ''}`)
  } else {
    console.log('no gitignored file in this checkout — nothing to assert (reported, not silent)')
  }
})

// --- release lockstep (ADR 0073) ----------------------------------------------------------------
// Canon-shape fixtures that are git repos: the check needs a tag to compare against. One such repo is
// built per suite run (ADR 0111): the canon shape at version 9.9.9 with README.md as LF and a
// non-ASCII-named file, then init, config, add, commit and tag once, and packed, so `.git` holds a
// handful of files (assertFixturePristine hashes every file of it after every reset). Each case then
// resets that tree with zero fixture spawns and applies only its working-tree mutation. A case that corrupts `.git` (lockstep-git-fails-after-tag
// writes `.git/index`) is undone by the reset like any other mutation, and so is any index refresh the
// gate's own `git diff` writes; the asserted reset proves it. The gate's own three or four git calls
// (≈0.5 s on top of a gate run) stay per case. The plain canon-shape fixtures above are not git
// repos and must report the check SKIPPED, never pass it silently. Identity rides on the commit as `-c`
// flags so no fixture depends on a repo-local or global identity (the harness_gates.selftest precedent).
const gitStep = (cwd, what, ...args) => {
  const r = git_result(cwd, args)
  if (r.status !== 0) throw new Error(`${what}: git ${args[0]} failed (exit ${r.status}) ${r.stderr}`)
}
// The release-notes canon (ADR 0030) must stay green in these fixtures or the exit code stops
// isolating the lockstep check: the top CHANGELOG entry follows the fixture's version.
function setLockstepChangelogTop(repo, version) {
  editFile(p2(repo, 'plugins/ywr-harness/CHANGELOG.md'), (t) => t.replace(/^## v\d+\.\d+\.\d+/mu, () => `## v${version}`))
}
function setLockstepVersion(repo, version) {
  editJson(p2(repo, 'plugins/ywr-harness/.claude-plugin/plugin.json'), (j) => { j.version = version })
  setLockstepChangelogTop(repo, version)
}
const koName = String.fromCharCode(0xD55C, 0xAE00) + '-notes.md'
const koBody = 'ko line one\nko line two\n'
// The one lockstep repo (see the section comment): version 9.9.9 in plugin.json and the CHANGELOG top,
// README.md committed as LF (the CR-only case rewrites it), and a NON-ASCII-named file committed
// (ADR 0102 re-ask, review F6). The name is part of the shared base: no other case touches it, so it
// equals the tag there and moves no other case's expected count.
const lockFx = lazyP(() => withTree(canonFx, (canonWork) => newFixture('lockstep', (repo) => {
  // From a canon WORKING tree after an asserted reset, never its pristine copy: that copy's
  // files are unscanned, and copying them would pay the first-open scan again (fact 165).
  cpSync(canonWork, repo, { recursive: true, force: true })
  setLockstepVersion(repo, '9.9.9')
  const p = p2(repo, 'plugins/ywr-harness/README.md')
  writeFileSync(p, fromLatin1(latin1(readFileSync(p)).replace(/\r\n/gu, '\n')))
  writeFileSync(p2(repo, `plugins/ywr-harness/${koName}`), Buffer.from(koBody, 'ascii'))
  // --template= : no sample hooks in `.git`, so the asserted reset hashes fewer files.
  gitStep(repo, 'lockstep fixture', 'init', '-q', '--template=')
  gitStep(repo, 'lockstep fixture', 'config', 'core.autocrlf', 'false')
  gitStep(repo, 'lockstep fixture', 'add', '-A')
  gitStep(repo, 'lockstep fixture', '-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', 'commit', '-q', '-m', 'fixture')
  gitStep(repo, 'lockstep fixture', 'tag', 'ywr-harness--v9.9.9')
  // One pack instead of a loose object per file (repack -d also removes the packed loose ones).
  gitStep(repo, 'lockstep fixture', 'repack', '-a', '-d', '-q')
})))
const lockSkipReason = gitHere ? undefined : 'git not on PATH — the ten release-lockstep fixture cases did not run (reported, not silent)'
const lockCase = (tag, fn) => mg(tag, fn, { skip: lockSkipReason })
const identicalRx = String.raw`release lockstep: plugins/ywr-harness identical to tag ywr-harness--v9\.9\.9`

// The tag names plugin.json's version and the tree equals the tag: the lockstep holds.
lockCase('lockstep-identical', () => withTree(lockFx, async (r) => {
  const g = await runGateAt(r)
  assert.ok(g.rc === 0 && m(g.out, identicalRx), `exit=${g.rc} identical-said=${m(g.out, 'identical to tag')}\n${g.out}`)
}))

// The #3 shape: a shipped file moves after the tag, plugin.json still names the released version.
lockCase('lockstep-moved-unbumped', () => withTree(lockFx, async (r) => {
  appendFileSync(p2(r, 'plugins/ywr-harness/README.md'), '\nmoved after the tag')
  const g = await runGateAt(r)
  assert.ok(g.rc === 1 && m(g.out, String.raw`release lockstep BROKEN: 1 file\(s\).*plugins/ywr-harness/README\.md`), `exit=${g.rc} broken-named=${m(g.out, 'lockstep BROKEN')}\n${g.out}`)
}))

// An untracked NEW file under the shipped tree is the same defect — `git diff` alone misses it.
lockCase('lockstep-untracked-new-file', () => withTree(lockFx, async (r) => {
  writeFileSync(p2(r, 'plugins/ywr-harness/NEW-SHIPPED-FILE.md'), 'new after the tag')
  const g = await runGateAt(r)
  assert.ok(g.rc === 1 && m(g.out, String.raw`release lockstep BROKEN: 1 file\(s\).*NEW-SHIPPED-FILE\.md`), `exit=${g.rc} broken-named=${m(g.out, 'lockstep BROKEN')}\n${g.out}`)
}))

// The remedy: the same move WITH the bump in the same tree — no tag names the new version, so
// there is nothing to compare and the check says exactly that.
lockCase('lockstep-bumped-unreleased', () => withTree(lockFx, async (r) => {
  appendFileSync(p2(r, 'plugins/ywr-harness/README.md'), '\nmoved after the tag')
  setLockstepVersion(r, '9.9.10')
  const g = await runGateAt(r)
  assert.ok(g.rc === 0 && m(g.out, String.raw`release lockstep: no local tag ywr-harness--v9\.9\.10`) && !m(g.out, 'lockstep BROKEN'), `exit=${g.rc} no-tag-said=${m(g.out, 'no local tag')}\n${g.out}`)
}))

// CR-only divergence is NOT drift — ADR 0033's fold, the contract the dogfood sweep and the
// refresh nudge already use (review 2026-09-03, medium): a .gitattributes renormalization
// between the tag and now must not fail a release whose content did not move. The tag holds
// README.md as LF; the working tree then carries it as CRLF, and only that.
lockCase('lockstep-cr-only-not-drift', () => withTree(lockFx, async (r) => {
  const p = p2(r, 'plugins/ywr-harness/README.md')
  writeFileSync(p, fromLatin1(latin1(readFileSync(p)).replace(/\n/gu, '\r\n')))
  const g = await runGateAt(r)
  assert.ok(g.rc === 0 && m(g.out, identicalRx), `exit=${g.rc} identical-said=${m(g.out, 'identical to tag')} broken-said=${m(g.out, 'lockstep BROKEN')}\n${g.out}`)
}))

// The two "never a false pass" branches (review 2026-09-03, medium — the changelog-check-
// broken-manifest precedent): a tag that WOULD be checked, and the check cannot run.
// (1) plugin.json unreadable while the tag exists: the lockstep line must say NOT CHECKED,
// never "identical" and never "no local tag".
lockCase('lockstep-unreadable-manifest-with-tag', () => withTree(lockFx, async (r) => {
  writeFileSync(p2(r, 'plugins/ywr-harness/.claude-plugin/plugin.json'), '{ not json')
  const g = await runGateAt(r)
  assert.ok(g.rc === 1 && m(g.out, String.raw`release lockstep: plugin.json version unreadable .*NOT CHECKED`) && !m(g.out, 'identical to tag') && !m(g.out, 'no local tag'), `exit=${g.rc} not-checked-said=${m(g.out, 'NOT CHECKED')}\n${g.out}`)
}))
// (2) git itself fails AFTER the tag is confirmed: a corrupt index kills `diff` and `ls-files`
// (both read it) while `rev-parse` of a tag ref does not — the check must fail as NOT
// CHECKED, not report BROKEN over an empty list and not report identical.
lockCase('lockstep-git-fails-after-tag', () => withTree(lockFx, async (r) => {
  writeFileSync(p2(r, '.git/index'), Buffer.from(Array.from({ length: 24 }, (_, i) => i + 1)))
  const g = await runGateAt(r)
  assert.ok(g.rc === 1 && m(g.out, String.raw`release lockstep: git diff / ls-files against ywr-harness--v9\.9\.9 failed .*NOT CHECKED`) && !m(g.out, 'lockstep BROKEN') && !m(g.out, 'identical to tag'), `exit=${g.rc} not-checked-said=${m(g.out, 'NOT CHECKED')}\n${g.out}`)
}))

// A version the tag name cannot be derived from must not route to the no-tag PASS (review
// 2026-09-03, low): the manifest check accepts a suffix, a ref name does not.
lockCase('lockstep-version-suffix-not-checked', () => withTree(lockFx, async (r) => {
  editJson(p2(r, 'plugins/ywr-harness/.claude-plugin/plugin.json'), (j) => { j.version = '9.9.9 rc' })
  const g = await runGateAt(r)
  assert.ok(g.rc === 1 && m(g.out, String.raw`release lockstep: plugin.json version '9\.9\.9 rc' is not a plain major\.minor\.patch.*NOT CHECKED`) && !m(g.out, 'no local tag'), `exit=${g.rc} not-checked-said=${m(g.out, 'not a plain major')}\n${g.out}`)
}))

// The NON-ASCII tracked name of the base (ADR 0102 re-ask, review F6): the -z list and the per-file re-ask
// must see the name as itself — a misdecoded name matches no path, --quiet exits 0, and the moved
// file would read identical. The gate decodes git's bytes once as UTF-8 (hook-lib gitRun), so no
// console code page reaches it; this case pins the decode and the literal pathspec.
lockCase('lockstep-non-ascii-moved', () => withTree(lockFx, async (r) => {
  writeFileSync(p2(r, `plugins/ywr-harness/${koName}`), Buffer.from(`${koBody}moved after the tag\n`, 'ascii'))
  const g = await runGateAt(r)
  assert.ok(g.rc === 1 && m(g.out, String.raw`release lockstep BROKEN: 1 file\(s\).*plugins/ywr-harness/${esc(koName)}`), `exit=${g.rc} broken-named=${m(g.out, 'lockstep BROKEN')} identical-said=${m(g.out, 'identical to tag')}\n${g.out}`)
}))

// The same name with a CR-only change is identical (git 2.34 lists it in --name-only; the
// re-ask must drop it — the non-ASCII pathspec has to reach git intact for that).
lockCase('lockstep-non-ascii-cr-only', () => withTree(lockFx, async (r) => {
  writeFileSync(p2(r, `plugins/ywr-harness/${koName}`), Buffer.from(koBody.replace(/\n/gu, '\r\n'), 'ascii'))
  const g = await runGateAt(r)
  assert.ok(g.rc === 0 && m(g.out, identicalRx), `exit=${g.rc} identical-said=${m(g.out, 'identical to tag')} broken-said=${m(g.out, 'lockstep BROKEN')}\n${g.out}`)
}))

// A canon shape that is NOT a git repo (every fixture above this section) must report the check
// skipped — with git absent the skip names that instead; either way it is said, never silent.
mg('lockstep-not-a-repo-skips', () => withTree(canonFx, async (r) => {
  const g = await runGateAt(r)
  assert.ok(g.rc === 0 && m(g.out, 'release lockstep: skipped — '), `exit=${g.rc} skip-said=${m(g.out, 'release lockstep: skipped')}\n${g.out}`)
}))

// --- canon ADR references (ADR 0095) ---------------------------------------------------------------
// Git fixtures (the check reads `git ls-files`, never a directory walk): the canon shape plus a
// docs/adr/ holding an empty file for every REAL canon ADR, so the copied plugin's own citations
// resolve exactly as in the canon and each case isolates the one reference it adds. The unresolved
// number is assembled at runtime — this file is itself scanned by the gate it tests.
// A plugin tree mounted at a filesystem root (the Linux parity container's /repo) has no grandparent:
// the canon guess is empty there, and the SKIP guard below reports it.
const canonGuess = (() => {
  const up1 = path.dirname(src)
  if (up1 === src) return ''
  const up2 = path.dirname(up1)
  return up2 === up1 ? '' : up2
})()
const realAdrDir = canonGuess ? p2(canonGuess, 'docs/adr') : ''
const badNum = '09' + '99'
// One such repo per suite run (ADR 0111), built lazily: the canon shape minus the owner's gitignored
// eval results, the docs/adr/ stubs, then init, config and add -A once. Each case resets it (asserted)
// and pays one spawn, a `git add` of only the paths the case wrote. The stub ADR files are already in the snapshot's index, and the case's `untracked` files are written after
// that add so they stay untracked. The snapshot holds one commit, for packing only — the check reads
// the index (`git ls-files`), and a case's `git add` stays uncommitted.
const adrSkipReason = (!gitHere || !realAdrDir || !(existsSync(realAdrDir) && statSync(realAdrDir).isDirectory()))
  ? "needs git and the canon's docs/adr/ (a dist or consumer copy has none) — reported, not silent" : undefined
const adrFx = lazyP(() => withTree(canonFx, (canonWork) => newFixture('adr-ref', (repo) => {
  // A canon working tree after an asserted reset, as the lockstep fixture copies it (fact 165).
  cpSync(canonWork, repo, { recursive: true, force: true })
  // The whole-directory fallback of copyPluginTree carries the owner's gitignored eval results (the
  // git-listed copy has none); tracked in the fixture, a model answer
  // quoting a foreign number would fail the control on one machine only.
  rmSync(p2(repo, 'plugins/ywr-harness/evals/results'), { recursive: true, force: true })
  const ad = p2(repo, 'docs/adr')
  mkdirSync(ad, { recursive: true })
  // 0000-template.md is left out: it is a scaffold placement, and an empty copy reads as drift.
  for (const a of readdirSync(realAdrDir, { withFileTypes: true })) {
    if (a.isFile() && /\.md$/iu.test(a.name) && /^\d{4}-/u.test(a.name) && !/^0000-/u.test(a.name)) writeFileSync(p2(ad, a.name), '')
  }
  gitStep(repo, 'adr-ref fixture', 'init', '-q', '--template=')
  gitStep(repo, 'adr-ref fixture', 'config', 'core.autocrlf', 'false')
  gitStep(repo, 'adr-ref fixture', 'add', '-A')
  // Commit + pack only so `.git` is a few files, not a loose object per tracked file (the asserted
  // reset hashes every one after every case); the check reads the index, never HEAD.
  gitStep(repo, 'adr-ref fixture', '-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', 'commit', '-q', '-m', 'fixture')
  gitStep(repo, 'adr-ref fixture', 'repack', '-a', '-d', '-q')
})))
// Lays a case's files on a reset tree of the adr-ref family, runs the gate there and hands the tree back.
function adrRun(tag, files, untracked = {}) {
  return withTree(adrFx, (repo) => {
    const put = (set) => {
      for (const [k, v] of Object.entries(set)) {
        const fp = p2(repo, k)
        mkdirSync(path.dirname(fp), { recursive: true })
        writeFileSync(fp, v)
      }
    }
    put(files)
    if (Object.keys(files).length) gitStep(repo, `adr-ref fixture '${tag}'`, 'add', '--', ...Object.keys(files))
    put(untracked)
    return runGateAt(repo)
  })
}
const adrCase = (tag, fn) => mg(tag, fn, { skip: adrSkipReason })
const lf = (l) => l.join('\n') + '\n'
const unreadRx = String.raw`git boundary: (\d+) \*\.selftest\.mjs file\(s\) and (\d+) harness_git\.mjs file\(s\) not read for the JavaScript check`

// Control: nothing added. The copied plugin's own references all resolve, so the unresolved
// cases below fail for their one added line and nothing else.
const adrControl = lazyP(() => adrRun('adr-ref-control', {}))
adrCase('adr-ref-control-resolves', async () => {
  const g = await adrControl()
  assert.ok(g.rc === 0 && m(g.out, String.raw`adr references: [1-9]\d* reference\(s\) in \d+ of \d+ tracked text file\(s\) resolve`), `exit=${g.rc} resolved-line=${m(g.out, String.raw`adr references: \d+ reference`)}\n${g.out}`)
})
// The same control run carries the stack and git-boundary checks over the copied canon tree (ADR 0158).
// The copied tree holds no .py file (the canon's one Python file, the managed-settings builder, sits outside the
// plugin), so the stack line reads zero python imports and the git-boundary line zero marked sites; the s1.py and
// g1.py fixtures below are the cases that prove each check can fail.
adrCase('stack-control-passes', async () => {
  const g = await adrControl()
  assert.ok(g.rc === 0 && m(g.out, String.raw`PASS  zero-install stack: \d+ python import\(s\) in \d+ file\(s\) and [1-9]\d* js specifier`) &&
    m(g.out, String.raw`PASS  git boundary: \d+ direct git call\(s\) in listed \.py files, each marked`), `exit=${g.rc}\n${g.out}`)
})
// ADR 0228: the copied plugin carries marked JavaScript starts (the gate, init.mjs, the decision hook), so the
// control counts at least one marked site there, and it prints the count of files it did not read.
adrCase('js-git-boundary-control-passes', async () => {
  const g = await adrControl()
  const unread = new RegExp(unreadRx, 'i').exec(g.out)
  assert.ok(g.rc === 0 && m(g.out, String.raw`PASS  git boundary: \d+ direct git call\(s\) in listed \.py files, each marked harness:git-boundary with a reason; [1-9]\d* in listed \.mjs/\.js/\.cjs files, each marked the same way`) && unread, `exit=${g.rc} unread-line=${!!unread}\n${g.out}`)
})

adrCase('adr-ref-unresolved', async () => {
  const g = await adrRun('adr-ref-unresolved', { 'scripts/note.md': `see ADR ${badNum} for why\n` })
  assert.ok(g.rc === 1 && m(g.out, String.raw`scripts/note\.md:1 cites ADR ${badNum}`), `exit=${g.rc} named=${m(g.out, `cites ADR ${badNum}`)}\n${g.out}`)
})

// A list member is checked on its own: the first number resolves, the second does not.
adrCase('adr-ref-list-member', async () => {
  const g = await adrRun('adr-ref-list-member', { 'scripts/list.md': `a line\nper ADRs 0001/${badNum} and more\n` })
  assert.ok(g.rc === 1 && m(g.out, String.raw`scripts/list\.md:2 cites ADR ${badNum}`) && !m(g.out, 'cites ADR 0001'), `exit=${g.rc}\n${g.out}`)
})

// An ASCII-hyphen range is a list too (`ADRs 0010-0017` is how the retro ignore file writes one).
adrCase('adr-ref-hyphen-range', async () => {
  const g = await adrRun('adr-ref-hyphen-range', { 'scripts/range.md': `ADRs 0001-${badNum}\n` })
  assert.ok(g.rc === 1 && m(g.out, String.raw`scripts/range\.md:1 cites ADR ${badNum}`), `exit=${g.rc}\n${g.out}`)
})

// The older hash form resolves zero-padded: `ADR #3` names 0003 (this canon's early specs), a
// hash number with no record fails like any other.
adrCase('adr-ref-hash-form', async () => {
  const hashRef = `ADR #${Number(badNum)}`
  const g = await adrRun('adr-ref-hash-form', { 'scripts/hash.md': `ok ADR #3\nbad ${hashRef} here\n` })
  assert.ok(g.rc === 1 && m(g.out, String.raw`scripts/hash\.md:2 cites ADR ${badNum}`) && !m(g.out, String.raw`hash\.md:1 `), `exit=${g.rc}\n${g.out}`)
})

// History and generated surfaces are excluded: an ADR body (append-only), the handoff archive,
// and the generated index. The same line elsewhere fails (adr-ref-unresolved).
adrCase('adr-ref-excluded-history-and-generated', async () => {
  const g = await adrRun('adr-ref-excluded', {
    'docs/adr/0001-fixture-history.md': `cites ADR ${badNum}\n`,
    'docs/handoff-archive/SESSION_HANDOFF.md': `cites ADR ${badNum}\n`,
    'docs/INDEX.md': `cites ADR ${badNum}\n`,
  })
  assert.ok(g.rc === 0 && !m(g.out, `cites ADR ${badNum}`) && m(g.out, String.raw`adr references: \d+ reference`), `exit=${g.rc}\n${g.out}`)
})

// An UNTRACKED file is not read — the reason the check lists with git instead of walking the tree
// (gitignored eval results and local settings would fail one machine only).
adrCase('adr-ref-untracked-not-read', async () => {
  const g = await adrRun('adr-ref-untracked', {}, { 'scripts/local-only.md': `cites ADR ${badNum}\n` })
  assert.ok(g.rc === 0 && !m(g.out, `cites ADR ${badNum}`), `exit=${g.rc}\n${g.out}`)
})

// Outside a git work tree the check is a REPORTED skip, never a pass line.
const notGitRun = lazyP(() => withTree(canonFx, async (r) => {
  mkdirSync(p2(r, 'docs/adr'), { recursive: true })
  return runGateAt(r)
}))
adrCase('adr-ref-skip-not-git', async () => {
  const g = await notGitRun()
  assert.ok(g.rc === 0 && m(g.out, 'adr references: skipped — the canon shape is not inside a git work tree') && !m(g.out, String.raw`adr references: \d+ reference`), `exit=${g.rc}\n${g.out}`)
})
adrCase('stack-skip-not-git', async () => {
  const g = await notGitRun()
  assert.ok(m(g.out, 'stack and git boundary: skipped — the canon shape is not inside a git work tree') && !m(g.out, String.raw`zero-install stack: \d+`), `exit=${g.rc}\n${g.out}`)
})

// --- canon zero-install stack and git boundary (review canon invariants 1 and 9, ADR 0158) ------
// The same git fixture. The adr-ref control run above passed both checks; each batch below adds
// files that the check must name line by line, beside lines it must leave alone, so one gate run
// proves every branch of its batch. The fixture text is assembled here, in strings that start no line
// the stack check reads as an import: this file is a .mjs file, which the stack check reads, and the
// dynamic import below is built from two parts for that reason.
const tq = '"'.repeat(3)
const dynImport = 'imp' + 'ort'
adrCase('stack-batch-names-each-violation', async () => {
  const stackFiles = {
    'scripts/s1.py': lf(['from __future__ import annotations', 'import os, json as j', 'import localmod', 'from yaml import safe_load', 'import requests.adapters',
      'import os; import yamlsemi', 'try: import tryimp']),
    'scripts/localmod.py': 'x = 1\n',
    'tools/deep/yaml.py': 'x = 1\n',
    'scripts/s2.py': lf([`${tq}Doc.`, 'import notreal', tq, `x = ${tq}one line${tq}`, '# import alsonotreal', 'import tomllib',
      `# a comment that holds ${tq}`, 'import afterhash', `SEP = '${tq}'`, 'import aftersep', `${tq}See ## heading.${tq}`, 'import afterdoc',
      `x = 1  # a trailing comment that holds ${tq}`, 'import aftertrail']),
    'scripts/s7.py': lf(['x = 1', `${tq}never closed`, 'import hidden']),
    'scripts/s3.mjs': lf(["import fs from 'node:fs'", "import { a } from './s4.mjs'", "import x from 'lodash'", "// import y from 'leftpad'", "const p = require('path')",
      'const q = await ' + dynImport + "('chalk')", 'import {', '  b,', "} from 'dayjs'"]),
    'scripts/s4.mjs': lf(["export { c } from 'node:path'", "import t from 'claude-code/testing'"]),
    'hooks/s5.test.ts': lf(["import { test } from 'claude-code/testing'"]),
    'tools/package.json': '{}\n',
  }
  const g = await adrRun('stack-batch', stackFiles, { 'scripts/s6.py': lf(['import untrackedpkg']) })
  const want = [
    "scripts/s1\\.py:4 imports 'yaml'", "scripts/s1\\.py:5 imports 'requests\\.adapters'",
    "scripts/s1\\.py:6 imports 'yamlsemi'", "scripts/s1\\.py:7 imports 'tryimp'",
    "scripts/s2\\.py:6 imports 'tomllib'", "scripts/s2\\.py:8 imports 'afterhash'", "scripts/s2\\.py:10 imports 'aftersep'", "scripts/s2\\.py:12 imports 'afterdoc'",
    "scripts/s2\\.py:14 imports 'aftertrail'",
    'scripts/s7\\.py:2 opens a triple-quoted string that never closes . lines 3-3 NOT CHECKED',
    "scripts/s3\\.mjs:3 imports 'lodash'", "scripts/s3\\.mjs:6 imports 'chalk'", "scripts/s3\\.mjs:9 imports 'dayjs'",
    "scripts/s4\\.mjs:2 imports 'claude-code/testing'",
    'zero-install stack: tools/package\\.json is a dependency manifest',
    "scripts/s6\\.py:1 \\(untracked\\) imports 'untrackedpkg'"]
  // s1:3 imports a sibling module, which reaches; a yaml.py far away does not whitelist yaml (s1:4).
  const spare = ['s1\\.py:[123] ', 's2\\.py:([2-579]|11|13) ', 's3\\.mjs:[1245] ', 's4\\.mjs:1 ', 's5\\.test\\.ts', 's7\\.py:3 ', 'scripts/s1\\.py:[0-9]+ \\(untracked\\)', 'PASS  zero-install stack']
  const missing = want.filter((x) => !m(g.out, x))
  const wrong = spare.filter((x) => m(g.out, x))
  assert.ok(g.rc === 1 && missing.length === 0 && wrong.length === 0, `exit=${g.rc} missing=[${missing.join(' | ')}] wrongly-named=[${wrong.join(' | ')}]\n${g.out}`)
})

// The git batch run feeds three tests: the Python rule, the JavaScript rule and the count line.
const gitBatchRun = lazyP(() => {
  const gitFiles = {
    'scripts/g1.py': lf(['import subprocess', 'subprocess.run(["git", "status"])', 'subprocess.run(["git", "log"])  # harness:git-boundary a test reason',
      '# harness:git-boundary the line below', 'subprocess.run(["git", "diff"])', 'subprocess.run(["git", "show"])  # harness:git-boundary',
      'subprocess.check_output("git rev-parse HEAD", shell=True)', 'subprocess.run(["gitk"])', 'x = ["git"]',
      'subprocess.run(("git", "diff"), text=True)', 'print("git")',
      'subprocess.run(', '    ("git", "log"),', ')', 'def h():', '    return ("git", "status")']),
    // The JavaScript rule (ADR 0228) rides the same fixture copy. j1.mjs: lines 2, 3, 4 and 12 start git unmarked
    // (a call, an array, an exec string, a PATH lookup), line 8 has a marker with no reason, lines 5 and 7 are
    // marked (same line with a backtick quote, comment line above), and lines 9 to 11, 13 to 15 are no start.
    'scripts/j1.mjs': lf(["import cp from 'node:child_process'", "cp.spawnSync('git', ['status'])", "const argv = ['git', 'log']",
      "execSync('git rev-parse HEAD')", "const a = [`git`, 'diff']  // harness:git-boundary a test reason",
      '// harness:git-boundary the line below', "spawn('git.exe', ['show'])", "execFileSync('git', ['log'])  // harness:git-boundary",
      "missing.push('git')", "// spawn('git', ['status'])", "const cfg = opts['git']", "const x = whichOnPath('git')",
      'spawn("gitk", [])', "console.log('git')", "const y = pick('git')"]),
    'scripts/j2.cjs': lf(["require('node:child_process').spawnSync('git', ['x'])"]),
    'scripts/j3.js': lf(['exec(`git status`)']),
    'scripts/j4.ts': lf(["spawnSync('git', ['x'])"]),
    'scripts/j5.selftest.mjs': lf(["import cp from 'node:child_process'", "cp.spawnSync('git', ['init'])"]),
    'tools/deep/harness_git.mjs': lf(["import cp from 'node:child_process'", "cp.spawnSync('git', ['status'])"]),
  }
  return adrRun('git-batch', gitFiles)
})
adrCase('git-boundary-batch-names-each-site', async () => {
  const g = await gitBatchRun()
  const want = ['git boundary: scripts/g1\\.py:2 starts git directly', 'git boundary: scripts/g1\\.py:6 carries harness:git-boundary with no reason',
    'git boundary: scripts/g1\\.py:7 starts git directly', 'git boundary: scripts/g1\\.py:9 starts git directly',
    'git boundary: scripts/g1\\.py:10 starts git directly', 'git boundary: scripts/g1\\.py:13 starts git directly',
    'git boundary: scripts/g1\\.py:16 starts git directly']
  const spare = ['g1\\.py:([1358]|11|12|14|15) ', 'PASS  git boundary']
  const missing = want.filter((x) => !m(g.out, x))
  const wrong = spare.filter((x) => m(g.out, x))
  assert.ok(g.rc === 1 && missing.length === 0 && wrong.length === 0, `exit=${g.rc} missing=[${missing.join(' | ')}] wrongly-named=[${wrong.join(' | ')}]\n${g.out}`)
})

// ADR 0228, same run. Each unmarked start and the empty-reason marker is named by its line; a marked site, a
// comment, an index read, a non-start call and a .ts file are not. A `.cjs` and a `.js` file are read.
adrCase('js-git-boundary-batch-names-each-site', async () => {
  const g = await gitBatchRun()
  const want = ['git boundary: scripts/j1\\.mjs:2 starts git directly', 'git boundary: scripts/j1\\.mjs:3 starts git directly',
    'git boundary: scripts/j1\\.mjs:4 starts git directly', 'git boundary: scripts/j1\\.mjs:8 carries harness:git-boundary with no reason',
    'git boundary: scripts/j1\\.mjs:12 starts git directly', 'git boundary: scripts/j2\\.cjs:1 starts git directly',
    'git boundary: scripts/j3\\.js:1 starts git directly']
  const spare = ['j1\\.mjs:(1|5|6|7|9|10|11|13|14|15) ', 'j4\\.ts', 'PASS  git boundary']
  const missing = want.filter((x) => !m(g.out, x))
  const wrong = spare.filter((x) => m(g.out, x))
  assert.ok(g.rc === 1 && missing.length === 0 && wrong.length === 0, `exit=${g.rc} missing=[${missing.join(' | ')}] wrongly-named=[${wrong.join(' | ')}]\n${g.out}`)
})

// A *.selftest.mjs file and a harness_git.mjs file hold an unmarked start and are not read. The count line prints
// on this failing run too, and it counts the one selftest file this fixture added beyond the control run.
adrCase('js-git-boundary-selftest-and-boundary-not-read', async () => {
  const g = await gitBatchRun()
  const ctl = new RegExp(unreadRx, 'i').exec((await adrControl()).out)
  const batch = new RegExp(unreadRx, 'i').exec(g.out)
  const countOk = !!batch && !!ctl && Number(batch[1]) === Number(ctl[1]) + 1 && Number(batch[2]) === Number(ctl[2]) + 1
  assert.ok(g.rc === 1 && !m(g.out, String.raw`j5\.selftest\.mjs:\d`) && !m(g.out, String.raw`tools/deep/harness_git\.mjs:\d`) && countOk,
    `exit=${g.rc} control=[${ctl?.[1] ?? ''},${ctl?.[2] ?? ''}] batch=[${batch?.[1] ?? ''},${batch?.[2] ?? ''}]\n${g.out}`)
})

// --- code comments tell no history (review canon invariant 12, ADR 0234) --------------------------
// The control run reads the copied canon tree, which names no slice and no open item in a comment.
adrCase('comment-history-control-passes', async () => {
  const g = await adrControl()
  assert.ok(g.rc === 0 && m(g.out, String.raw`PASS  code comments: [1-9]\d* comment line\(s\) in [1-9]\d* code file\(s\) name no slice number and no open-item ID`) &&
    m(g.out, 'code comments: an ID from O1 to O9 is not read'), `exit=${g.rc}\n${g.out}`)
})
// One batch names each history site by its line. A string, a template, a regex, a one-digit case ID, a
// non-sh file under githooks/, a `$#` and a heredoc body are no comment or no finding. A `<<` shift opens
// no heredoc, and a bash hook is read.
adrCase('comment-history-batch-names-each-site', async () => {
  const files = {
    'scripts/c1.mjs': lf(['// slice 12 left this', "const s = 'slice 13 in a string'", 'const t = `O45 in a template`',
      '/* a block that names O123', '   and continues */ const r = /slice 9/', '// case O7 is a case ID',
      'const u = 1 // trailing O88', '// a slicer 5 and Slices 2']),
    'scripts/c2.sh': lf(['#!/bin/sh', '# slice 4 here', 'echo "# O55 not a comment"', 'x=$# # O66 trailing',
      'y=$((x << n))', '# O56 after a shift', "cat <<'EOF'", '# O57 in a heredoc', 'EOF', '# O58 after the heredoc']),
    'tools/githooks/c3': lf(['#!/bin/sh', '# O77 hook']),
    'tools/githooks/c7': lf(['#!/usr/bin/env bash', '# O79 bash hook']),
    'tools/githooks/c4': lf(['not a script', '# O78']),
    'scripts/c5.mjs': lf(['const a = 1', '/* never closed', '// O99']),
    'scripts/c8.sh': lf(['#!/bin/sh', 'cat <<\\EOF', '# O61 in an escaped heredoc', 'EOF', '# O62 after it']),
    'scripts/c9.sh': lf(['#!/bin/sh', '((cd x; ls) | cat)', '# O63 after it']),
    'scripts/c10.sh': lf(['#!/bin/sh', 'y=$((1 +', '  2))', 'cat <<EOF', '# O64 in a heredoc', 'EOF', '# O65 after it']),
  }
  const g = await adrRun('comment-history', files, { 'scripts/c6.mjs': lf(['// slice 1']) })
  const want = ["code comment: scripts/c1\\.mjs:1 names 'slice 12'", "code comment: scripts/c1\\.mjs:4 names 'O123'",
    "code comment: scripts/c1\\.mjs:7 names 'O88'", "code comment: scripts/c1\\.mjs:8 names 'Slices 2'",
    "code comment: scripts/c2\\.sh:2 names 'slice 4'", "code comment: scripts/c2\\.sh:4 names 'O66'",
    "code comment: scripts/c2\\.sh:6 names 'O56'", "code comment: scripts/c2\\.sh:10 names 'O58'",
    "code comment: tools/githooks/c3:2 names 'O77'", "code comment: tools/githooks/c7:2 names 'O79'",
    "code comment: scripts/c5\\.mjs:3 names 'O99'",
    'code comments: scripts/c5\\.mjs:2 opens a block comment that never closes',
    "code comment: scripts/c6\\.mjs:1 \\(untracked\\) names 'slice 1'",
    "code comment: scripts/c8\\.sh:5 names 'O62'", "code comment: scripts/c9\\.sh:3 names 'O63'",
    'code comments: scripts/c9\\.sh:2 opens a `\\(\\(` block that the lexer cannot read as arithmetic',
    "code comment: scripts/c10\\.sh:7 names 'O65'"]
  const spare = ['c1\\.mjs:[2356] ', 'c2\\.sh:([135789]) ', 'c2\\.sh:\\d+ opens', 'githooks/c4', 'PASS  code comments',
    'c8\\.sh:[1-4] ', 'c8\\.sh:\\d+ opens', 'c10\\.sh:[1-6] ', 'c10\\.sh:\\d+ opens']
  const missing = want.filter((x) => !m(g.out, x))
  const wrong = spare.filter((x) => m(g.out, x))
  assert.ok(g.rc === 1 && missing.length === 0 && wrong.length === 0, `exit=${g.rc} missing=[${missing.join(' | ')}] wrongly-named=[${wrong.join(' | ')}]\n${g.out}`)
})
adrCase('comment-history-skip-not-git', async () => {
  const g = await notGitRun()
  assert.ok(m(g.out, 'code comments: skipped — the canon shape is not inside a git work tree') && !m(g.out, String.raw`code comments: \d+ comment`), `exit=${g.rc}\n${g.out}`)
})

// --- eval suite structure (ADR 0076 / spec 0014) -------------------------------------------------
// Four refusals the runner would otherwise deliver only after a PAID run (unknown prompt.md key ·
// unknown grader type · grader-less case) or never (an unpinned or non-worker model — the host has
// no such rule). Each mutation edits ONE case of the shipped suite; the control below proves the
// unmutated suite passes the same section.
const evalCase = p2(src, 'evals/hook-version-announce-reaches-context')
const promptRel = 'evals/hook-version-announce-reaches-context/prompt.md'
// A pwsh -replace over (?m): `.` matches a carriage return, as .NET does, so `[^\n]` stands for it here.
const rx = (source, flags = 'gmu') => new RegExp(source, flags)
const sub = (text, re, to) => text.replace(re, () => to)
if (!existsSync(p2(evalCase, 'prompt.md')) || !statSync(p2(evalCase, 'prompt.md')).isFile()) {
  mg('eval-suite-fixture-missing', () => {
    assert.fail('fixture case evals/hook-version-announce-reaches-context/prompt.md missing — the eval mutations have nothing to mutate')
  })
} else {
  tryCase('eval-unknown-prompt-key', (d) => { editFile(p2(d, promptRel), (t) => sub(t, rx('^model:'), 'max_turn: 5\nmodel:')) })
  // A key the parser cannot read (dashed) must be refused as UNPARSED, not silently skipped past
  // the unknown-key loop — the review's high finding: the first cut printed PASS over it while
  // the runner still rejects the file (a validator that only sees what it parsed).
  tryCase('eval-unparsed-frontmatter-line', (d) => { editFile(p2(d, promptRel), (t) => sub(t, rx('^model:'), 'max-turns: 5\nmodel:')) })
  // haiku IS a worker model, so only the one-suite-one-model rule can catch this — the mutation
  // proves that branch and nothing else.
  tryCase('eval-model-mixed-across-cases', (d) => { editFile(p2(d, promptRel), (t) => sub(t, rx('^model:[^\\n]*$'), 'model: haiku')) })
  tryCase('eval-model-unpinned', (d) => { editFile(p2(d, promptRel), (t) => sub(t, rx('^model:[^\\n]*\\r?\\n'), '')) })
  // ADR 0107: a bare worker alias only. EVERY case is mutated, because a one-case change would also
  // trip the mixed-models rule and prove nothing about the alias check.
  for (const bad of [
    { tag: 'eval-model-not-a-worker', model: 'fable' },
    { tag: 'eval-model-full-id', model: 'claude-opus-5-5' },
    { tag: 'eval-model-suffixed-alias', model: 'opus[1m]' },
    { tag: 'eval-model-alias-wrong-case', model: 'Opus' }]) {
    tryCase(bad.tag, (d) => {
      for (const e of entriesOf(p2(d, 'evals'))) {
        if (!e.dir && path.basename(e.full).toLowerCase() === 'prompt.md') editFile(e.full, (t) => sub(t, rx('^model:[^\\n]*$'), `model: ${bad.model}`))
      }
    })
  }
  tryCase('eval-unknown-grader-type', (d) => {
    editFile(p2(d, 'evals/hook-version-announce-reaches-context/graders/says-first-recorded-run.md'), (t) => sub(t, rx('^type:[^\\n]*$'), 'type: custom_script'))
  })
  tryCase('eval-case-without-graders', (d) => {
    rmSync(p2(d, 'evals/hook-version-announce-reaches-context/graders'), { recursive: true, force: true })
  })
  // The disabled-skills guard's scope (spec 0014 §4.2): unscoped (the run #9 shape), a disabled
  // skill the pattern does not name, and a pattern wide enough to match a model-invocable skill.
  const guard = 'evals/disabled-skills-stay-user-invoked/graders/no-skill-invoked.md'
  tryCase('eval-guard-unscoped', (d) => { editFile(p2(d, guard), (t) => sub(t, rx('^input_match:[^\\n]*\\r?\\n'), '')) })
  tryCase('eval-guard-misses-a-disabled-skill', (d) => {
    editFile(p2(d, 'skills/verify/SKILL.md'), (t) => sub(t, rx('^name:'), 'disable-model-invocation: true\nname:'))
  })
  tryCase('eval-guard-matches-an-invocable-skill', (d) => { editFile(p2(d, guard), (t) => sub(t, rx('^input_match:[^\\n]*$'), `input_match: '"skill"'`)) })
  tryCase('eval-guard-pattern-does-not-compile', (d) => { editFile(p2(d, guard), (t) => sub(t, rx('^input_match:[^\\n]*$'), `input_match: '("skill"'`)) })
  tryCase('eval-guard-pattern-engine-specific', (d) => { editFile(p2(d, guard), (t) => sub(t, rx("^input_match: '"), "input_match: '(?i)")) })
  tryCase('eval-guard-flag-unreadable', (d) => {
    editFile(p2(d, 'skills/update/SKILL.md'), (t) => sub(t, rx('^disable-model-invocation:[^\\n]*$'), 'disable-model-invocation: yes'))
  })
}

// A POSITIVE control: the unmutated copy must still pass. Without it a gate that fails on
// everything (a broken gate) would score a perfect negative suite. The copy sits with no repo
// above it, so the placement sweep must also SAY it skipped (never a silent no-op). The eval
// section must SAY it ran over the shipped suite (a PASS line with a case count): a section that
// silently did nothing would let every eval mutation above be caught by some other check and
// still read as covered.
// It runs on the RESET working tree, so it also proves a reset tree is one the gate passes (the
// reset assertion proves the bytes; this proves the verdict).
mg('unmutated-control', () => withTree(pluginFx, async (ok) => {
  const gc = await invokeGate(p2(ok, 'manifest-gate.mjs'))
  const out = gc.out
  const evalRx = String.raw`PASS  eval suite: [1-9]\d* case\(s\).*disabled-skills guard scoped to [1-9]\d* skill\(s\)`
  assert.ok(gc.code === 0 && m(out, 'dogfood placements: skipped') && m(out, 'release lockstep: skipped — not the canon dogfood shape') && m(out, evalRx),
    `exit=${gc.code} skip-said=${m(out, 'dogfood placements: skipped')} lockstep-skip-said=${m(out, 'release lockstep: skipped')} eval-suite-counted=${m(out, String.raw`PASS  eval suite: [1-9]\d* case\(s\)`)} guard-scope-said=${m(out, 'disabled-skills guard scoped to [1-9]')}\n${out}`)
}))

// --- the contracts invokeGate rests on (review 2026-09-02: a negative suite must never score an
// --- abort as a catch; ADR 0141 Decision 3 carried it to the Node gate) -----------------------------
// The gate sets process.exitCode and returns, so stdout drains and its summary line is the last line;
// a process.exit() could cut the output short of it. Pin that it never calls one.
mg('node-gate-never-calls-process-exit', () => {
  const lines = readFileSync(p2(src, 'manifest-gate.mjs'), 'utf8').split('\n')
  const bad = []
  lines.forEach((l, i) => { if (/process\.exit\s*\(/iu.test(l) && !/^\s*\/\//u.test(l)) bad.push(i + 1) })
  assert.ok(bad.length === 0, `the summary line must be the last; offending lines: ${bad.join(', ')}`)
})
// Node exits 1 on its own for a thrown error and for a syntax error — the code every mutation case
// accepts. Neither prints the summary line, so both must come back -1/aborted.
mg('node-uncaught-throw-is-an-abort-not-exit-1', async () => {
  const thrower = p2(base, 'thrower.mjs')
  writeFileSync(thrower, "throw new Error('boom from the fixture')")
  const gt = await invokeGate(thrower)
  assert.ok(gt.code === -1 && gt.aborted && m(gt.out, 'exit 1 without') && m(gt.out, 'boom from the fixture'), `code=${gt.code} aborted=${gt.aborted} message-kept=${m(gt.out, 'boom from the fixture')}`)
})
mg('node-syntax-error-is-an-abort-not-exit-1', async () => {
  const syntax = p2(base, 'syntax.mjs')
  writeFileSync(syntax, 'this is not ( javascript')
  const gs = await invokeGate(syntax)
  assert.ok(gs.code === -1 && gs.aborted && m(gs.out, 'SyntaxError'), `code=${gs.code} aborted=${gs.aborted}`)
})
// A FAIL line and exit 1 without the summary is not a catch either, and exit 0 without the green
// summary is not a pass: only the gate's own ending counts.
mg('node-exit-1-without-the-summary-is-an-abort', async () => {
  const failOnly = p2(base, 'fail-only.mjs')
  writeFileSync(failOnly, "console.log('FAIL  looks like a gate line'); process.exitCode = 1")
  const gf = await invokeGate(failOnly)
  assert.ok(gf.code === -1 && gf.aborted, `code=${gf.code} aborted=${gf.aborted}`)
})
mg('node-exit-0-without-the-summary-is-an-abort', async () => {
  const silent = p2(base, 'silent.mjs')
  writeFileSync(silent, "console.log('PASS  looks like a gate line')")
  const g0 = await invokeGate(silent)
  assert.ok(g0.code === -1 && g0.aborted, `code=${g0.code} aborted=${g0.aborted}`)
})
// A gate file that is not there (a copy race would have read as "PASS gate exited 1" under an adapter
// that mapped every error to 1 — the 2026-09-02 review's medium finding).
mg('node-missing-gate-is-an-abort-not-exit-1', async () => {
  const gm = await invokeGate(p2(base, 'no-such-dir/manifest-gate.mjs'))
  assert.ok(gm.code === -1 && gm.aborted && m(gm.out, 'script not found'), `code=${gm.code} aborted=${gm.aborted}`)
})
// The REAL gate's own catch: with hooks/hook-lib.mjs gone its import throws inside the try, and the gate
// must say ABORTED and exit 2, never the 1 of a caught mutation.
mg('node-gate-own-throw-exits-2-not-1', () => withTree(pluginFx, async (dir) => {
  rmSync(p2(dir, 'hooks/hook-lib.mjs'), { force: true })
  const gi = await invokeGate(p2(dir, 'manifest-gate.mjs'))
  assert.ok(gi.code === -1 && gi.aborted && m(gi.out, '^exit 2 without') && m(gi.out, 'manifest-gate: ABORTED'), `code=${gi.code} aborted=${gi.aborted} head=${gi.out.split('\n')[0]}`)
}))
