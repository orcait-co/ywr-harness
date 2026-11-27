// Selftest for harness_retro.mjs — the slice retro gate (ADR 0017).
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout scripts/harness_retro.selftest.mjs
//
// The gate is advisory and exits 0 (except a git failure, case N), so every case asserts on OUTPUT. Two properties are
// asserted for each of the eight checks: that it fires when it should, and that it stays SILENT
// when it should not. The silence half is the one that matters — an advisory gate that cries wolf
// is an advisory gate people stop reading, and there is no exit code to notice the regression.
//
// The subtlest case in the file is D2: a body-only ADR edit must NOT demand a rebuild, because the
// committed outputs are frontmatter-derived. That distinction was learned the expensive way in
// ywr-platform and is the single most likely thing to be broken by a well-meaning simplification.
//
// This is the Node port of the pwsh suite of the same name (ADR 0227). The pwsh suite named the cases of
// sections A, B, C, E, F, G, H, I, J, K and Q with a bare letter, which is no case ID. Each such test here
// is `RT<n> <the old name>`, so the parity check of ADR 0227 decision 8 matches the names. The cases that
// carried an ID keep it. Patterns are pwsh -match sources (case-insensitive; see toRx in lib/selftest-lib.mjs).
//
// The pwsh suite built each section's fixture repos in line, one section after the next, and later sections
// reused earlier repos (the G repo feeds I and K2, the K repo feeds SZ6, the DL5 ledger feeds DL6). A
// section here is one `lazy` scenario that builds its repos and runs the retro, and a test then asserts on the
// stored run. A scenario that needs an earlier repo calls that scenario, and the two share one worker group
// (see GROUPS), so a dependent scenario still sees the repo state that the pwsh suite gave it. A throw in a
// scenario fails every test of it with that cause.
//
// The pwsh suite wrote the three small child scripts of D7, D8 and G4 as text files. Here each is a function
// whose source is written to a file and run by `node`, so the child keeps its own process and its own module
// cache, as before. The pwsh suite ran the retro with `node` found on PATH; this suite runs it with the node
// that runs the suite. The `node absent` skip of the pwsh suite has no case here: the suite is running on node.
//
// Speed (O207). The scenarios share no repo, no folder and no state beyond the dependencies named in GROUPS,
// and each spends its time waiting on child processes. The first test runs each group in its own worker
// thread of this same file, a few at a time, and every test then reads the stored result as before. A worker
// thread runs the same synchronous scenario code, so the code of a scenario is unchanged, and each retro run
// stays a child process. A seed repo is built once and copied with fs.cpSync into each fixture repo that
// declares the same config, instead of `git init`, `git add` and `git commit` per repo.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker, SHARE_ENV, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { fixtureRoot, removeFixtureRoot, runNode, toRx, innerJobs } from '../lib/selftest-lib.mjs'
import { git_result } from './harness_git.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const retro = path.join(here, 'harness_retro.mjs')
const fxBase = fixtureRoot('harness-retro-selftest')
if (isMainThread) after(() => { removeFixtureRoot(fxBase) })

// Fixture identity through the environment, once: a per-repo `git config user.*` was two spawns per
// fixture repo. Neither harness_retro nor a case reads a repo-local user.* value.
process.env.GIT_AUTHOR_NAME = 'selftest'; process.env.GIT_COMMITTER_NAME = 'selftest'
process.env.GIT_AUTHOR_EMAIL = 'selftest@example.invalid'; process.env.GIT_COMMITTER_EMAIL = 'selftest@example.invalid'

// The fixture repos need git. A missing git is a reported skip, never a pass. This lookup scans a PATH string
// itself and never asks harness_git.mjs: that module is read by this suite as a subject, and a defect in its
// git lookup would otherwise read as "git absent" and skip every case, a green run that checked nothing.
function gitOnPath(envPath) {
  const exts = process.platform === 'win32' ? ['.exe', '.com'] : ['']
  for (const dir of String(envPath ?? '').split(path.delimiter)) {
    if (!dir.trim() || !path.isAbsolute(dir)) continue
    for (const ext of exts) {
      try { if (fs.statSync(path.join(dir, `git${ext}`)).isFile()) return true } catch { /* absent here, keep looking */ }
    }
  }
  return false
}
const skip = gitOnPath(process.env.PATH) ? false : 'git absent (reported, not silent)'
// A worker thread loads this file only for its scenarios: it registers no test.
// Each test awaits the one scenario run first (see `ready` below).
const t = (name, fn) => { if (isMainThread) test(name, { skip }, async (...a) => { await ready(); return fn(...a) }) }
const has = (s, p) => toRx(p).test(s)
const ok = (cond, detail) => assert.ok(cond, String(detail))
const blank = (s) => !String(s).trim()

const CFG = `{
  "retro": {
    "source_scope": ["^src/.*\\\\.py$"],
    "dep_manifests": ["^pyproject\\\\.toml$"],
    "migrations": ["^migrations/versions/"],
    "ignore_file": ".githooks/slice-retro-ignore"
  }
}
`

// stdout and stderr together, as `2>&1` read them. The retro writes its stderr lines first.
function runRetro(args, env) {
  const r = runNode([retro, ...args], { env: env ? { ...process.env, ...env } : undefined })
  return { out: r.stderr + r.stdout, code: r.status }
}
const invokeRetro = (repo, extra = [], env) => runRetro(['--repo', repo, ...extra], env)
const git = (repo, args, opts) => git_result(repo, args, opts)
function writeF(repo, rel, body) {
  const full = path.join(repo, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, String(body).replace(/\r\n/gu, '\n'))
}
function seedRepo(p, config) {
  fs.mkdirSync(p, { recursive: true })
  git(p, ['init', '-q'])
  if (config) writeF(p, '.harness.json', config)
  writeF(p, 'docs/index.json', '{}')
  writeF(p, 'seed.txt', 'seed')
  git(p, ['add', '-A'])
  git(p, ['commit', '-q', '-m', 'chore: seed'])
  return p
}
// A repo whose config is the seed's is a copy of the seed repo, `.git` folder included: a copied `.git` is a
// real repository, and the copy holds the same seed commit that a fresh init would make.
const seedFor = workerData?.seeds ?? {}
function newRepo(name, config) {
  const p = path.join(fxBase, name)
  const seed = config === CFG ? seedFor.cfg : undefined
  if (!seed) return seedRepo(p, config)
  fs.cpSync(seed, p, { recursive: true })
  return p
}
function commit(repo, msg) {
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', msg])
}
const gitOut = (repo, args) => git(repo, args).stdout.trim()
// A living spec with an inline implements_in list.
const spec = (id, files) => `---\nid: "${id}"\ntype: spec\ntitle: "s${id}"\nstatus: active\nimplements_in: [${files.map((f) => `"${f}"`).join(', ')}]\n---\n# ${id}. spec\n`
const adr = (id, extra = '', body = '') => `---\nid: "${id}"\ntype: adr\n${extra}---\n# ${id}\n${body}`

// A scenario runs once. In a worker thread it runs on first use, so a scenario that needs an earlier one calls
// it. In the main thread it reads the result that its worker stored (see `ready` below). A throw in
// the setup fails every test of the scenario with that cause.
const scenarios = new Map()
function lazy(name, fn) {
  let done = false; let value; let error
  const get = () => {
    if (!done) { done = true; try { value = fn() } catch (e) { error = e } }
    if (error) throw error
    return value
  }
  scenarios.set(name, { run: get, state: () => (error ? { error: String(error?.stack ?? error) } : { value }) })
  return isMainThread ? () => {
    const r = stored.get(name)
    if (!r) throw new Error(`scenario ${name} has no stored result`)
    if (r.error) throw new Error(r.error)
    return r.value
  } : get
}
const stored = new Map()
// The scenarios run once, on the first test's await, not in a root `before` hook: Node 22.0.0 starts the tests
// without awaiting an async root hook. The first test starts after this module has evaluated.
let readyRun = null
function ready() {
  readyRun ??= (async () => {
    if (skip) return
    const grouped = GROUPS.flat()
    const missing = [...scenarios.keys()].filter((n) => !grouped.includes(n))
    const twice = grouped.filter((n, i) => grouped.indexOf(n) !== i)
    const unknown = grouped.filter((n) => !scenarios.has(n))
    if (missing.length || twice.length || unknown.length) {
      throw new Error(`scenario groups: in no group [${missing}], in two [${twice}], unknown [${unknown}]`)
    }
    const seeds = { cfg: seedRepo(path.join(fxBase, 'seed-cfg'), CFG) }
    const queue = [...GROUPS]
    const lanes = Array.from({ length: Math.min(POOL, queue.length) }, async () => {
      for (let names = queue.shift(); names; names = queue.shift()) {
        for (const [n, r] of Object.entries(await runGroup(names, seeds))) stored.set(n, r)
      }
    })
    await Promise.all(lanes)
  })()
  return readyRun
}
// A small child script: a function with no free variables, written to a file and run by `node` with its
// arguments. The pwsh suite wrote the same scripts as text.
function runChild(name, fn, args) {
  const file = path.join(fxBase, `${name}.mjs`)
  fs.writeFileSync(file, `await (${fn.toString()})(...process.argv.slice(2))\n`)
  const r = runNode([file, ...args])
  return r.stderr + r.stdout
}
const rxEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

// --- A: DEP — manifest changed with no new ADR ---------------------------------------------------
const A = lazy('A', () => {
  const a = newRepo('dep', CFG)
  writeF(a, 'pyproject.toml', "[project]\nname='x'\n")
  commit(a, 'chore: add dep')
  const rA = invokeRetro(a)
  writeF(a, 'pyproject.toml', "[project]\nname='x'\nversion='2'\n")
  writeF(a, 'docs/adr/0001-a.md', adr('0001'))
  commit(a, 'chore: dep with adr')
  const rA2 = invokeRetro(a)
  // A3: a rename can TRIGGER a check but never SATISFY one (ADR 0081 arm, B low). Renaming the
  // existing ADR is not a new decision — `added` counted R, so the rename used to silence DEP.
  writeF(a, 'pyproject.toml', "[project]\nname='x'\nversion='3'\n")
  git(a, ['mv', 'docs/adr/0001-a.md', 'docs/adr/0001-renamed.md'])
  commit(a, 'chore: dep with a renamed adr')
  return { rA, rA2, rA3: invokeRetro(a) }
})
t('RT1 A DEP fires on a manifest change with no ADR', () => { ok(has(A().rA.out, 'DEP:'), A().rA.out) })
t('RT1 A the gate stays advisory (exit 0)', () => { ok(A().rA.code === 0, `exit=${A().rA.code}`) })
t('A2 DEP is SILENT when an ADR is added with it', () => { ok(!has(A().rA2.out, 'DEP:'), A().rA2.out) })
t('A3 DEP still fires when the only ADR in scope is a RENAME of an old one', () => { ok(has(A().rA3.out, 'DEP:'), A().rA3.out) })

// --- B: MIGRATION — migration added with no spec touched ----------------------------------------
const B = lazy('B', () => {
  const b = newRepo('migration', CFG)
  writeF(b, 'migrations/versions/001_init.py', '# migration\n')
  commit(b, 'feat: schema')
  const rB = invokeRetro(b)

  const b2 = newRepo('migration-ok', CFG)
  writeF(b2, 'migrations/versions/002_x.py', '# migration\n')
  writeF(b2, 'docs/spec/0001-s.md', spec('0001', []))
  commit(b2, 'feat: schema with spec')
  const rB2 = invokeRetro(b2)

  // B3: a spec moved WITHOUT an edit (R100) updated nothing, so it cannot satisfy MIGRATION; the
  // migration itself still triggers as added.
  writeF(b2, 'migrations/versions/003_y.py', '# migration\n')
  git(b2, ['mv', 'docs/spec/0001-s.md', 'docs/spec/0001-moved.md'])
  commit(b2, 'feat: schema with a moved spec')
  const rB3 = invokeRetro(b2)

  // B4: a DELETED spec updated nothing either (review 2026-09-26: the D line's path sat in the
  // suppressor set).
  writeF(b2, 'migrations/versions/004_z.py', '# migration\n')
  git(b2, ['rm', '-q', 'docs/spec/0001-moved.md'])
  commit(b2, 'feat: schema with a deleted spec')
  const rB4 = invokeRetro(b2)

  // B5: a rename INTO scope still TRIGGERS — the other half of the rule (UNMAPPED keeps R).
  writeF(b2, 'tools/helper.py', 'x = 1\n')
  commit(b2, 'chore: helper outside scope')
  fs.mkdirSync(path.join(b2, 'src'), { recursive: true })
  git(b2, ['mv', 'tools/helper.py', 'src/helper.py'])
  commit(b2, 'chore: move helper into src')
  return { rB, rB2, rB3, rB4, rB5: invokeRetro(b2) }
})
t('RT2 B MIGRATION fires', () => { ok(has(B().rB.out, 'MIGRATION:'), B().rB.out) })
t('B2 MIGRATION is SILENT when a spec is touched', () => { ok(!has(B().rB2.out, 'MIGRATION:'), B().rB2.out) })
t('B3 MIGRATION still fires when the only spec in scope is a pure rename', () => { ok(has(B().rB3.out, 'MIGRATION:'), B().rB3.out) })
t('B4 MIGRATION still fires when the only spec in scope was deleted', () => { ok(has(B().rB4.out, 'MIGRATION:'), B().rB4.out) })
t('B5 a file renamed INTO source_scope fires UNMAPPED (a rename triggers)', () => { ok(has(B().rB5.out, String.raw`UNMAPPED: new file src/helper\.py`), B().rB5.out) })

// --- C: SPEC — a mapped file changed, its spec did not ------------------------------------------
const C = lazy('C', () => {
  const c = newRepo('spec', CFG)
  writeF(c, 'src/app.py', 'x = 1\n')
  writeF(c, 'docs/spec/0001-s.md', spec('0001', ['src/app.py']))
  commit(c, 'chore: map it')
  writeF(c, 'src/app.py', 'x = 2\n')
  commit(c, 'fix: change mapped file only')
  const rC = invokeRetro(c)

  writeF(c, 'src/app.py', 'x = 3\n')
  writeF(c, 'docs/spec/0001-s.md', `${spec('0001', ['src/app.py'])}updated\n`)
  commit(c, 'fix: change both')
  return { rC, rC2: invokeRetro(c) }
})
t('RT3 C SPEC fires when a mapped file changes alone', () => { ok(has(C().rC.out, String.raw`SPEC:.*0001-s\.md`), C().rC.out) })
t('C2 SPEC is SILENT when the spec moves with it', () => { ok(!has(C().rC2.out, 'SPEC:'), C().rC2.out) })

// --- D: BUILD — keyed to FRONTMATTER, not to file content ---------------------------------------
// D1 fires (frontmatter changed, index untouched). D2 must NOT fire: an append-only body edit is
// the normal way to correct a committed ADR, and it provably yields no index delta because the
// builder drops _-prefixed keys and docs.html is gitignored. Getting D2 wrong makes the gate cry
// wolf on a recurring class whose only answer is "rebuild and confirm nothing changed".
const D = lazy('D', () => {
  const d = newRepo('build', CFG)
  writeF(d, 'docs/adr/0001-a.md', adr('0001', 'status: proposed\n', 'body v1\n'))
  commit(d, 'docs: add adr')
  writeF(d, 'docs/adr/0001-a.md', adr('0001', 'status: accepted\n', 'body v1\n'))
  commit(d, 'docs: accept it')
  const rD = invokeRetro(d)

  writeF(d, 'docs/adr/0001-a.md', adr('0001', 'status: accepted\n', 'body v1\n\n## Addendum\nmore prose\n'))
  commit(d, 'docs: append an addendum (body only)')
  const rD2 = invokeRetro(d)

  // D4/D5: the frontmatter of every modified doc is read in one batch. D4 puts the one frontmatter
  // change after two body-only edits, so a batch that misaligned its replies or stopped early would
  // stay silent. D5 edits three bodies only and must stay silent. D6: a changed index answers the
  // check, so the same frontmatter change is silent when the commit also touches the index.
  writeF(d, 'docs/adr/0002-b.md', adr('0002', '', 'v1\n'))
  writeF(d, 'docs/adr/0003-c.md', adr('0003', 'status: proposed\n', 'v1\n'))
  commit(d, 'docs: add two adrs')
  writeF(d, 'docs/adr/0001-a.md', adr('0001', 'status: accepted\n', 'body v2\n'))
  writeF(d, 'docs/adr/0002-b.md', adr('0002', '', 'v2\n'))
  writeF(d, 'docs/adr/0003-c.md', adr('0003', 'status: accepted\n', 'v2\n'))
  commit(d, 'docs: two bodies and one frontmatter')
  const rD4 = invokeRetro(d)
  writeF(d, 'docs/adr/0001-a.md', adr('0001', 'status: accepted\n', 'body v3\n'))
  writeF(d, 'docs/adr/0002-b.md', adr('0002', '', 'v3\n'))
  writeF(d, 'docs/adr/0003-c.md', adr('0003', 'status: accepted\n', 'v3\n'))
  commit(d, 'docs: three bodies only')
  const rD5 = invokeRetro(d)
  writeF(d, 'docs/adr/0003-c.md', adr('0003', 'status: superseded\n', 'v3\n'))
  writeF(d, 'docs/index.json', '{}\n')
  commit(d, 'docs: frontmatter change with the index')
  return { rD, rD2, rD4, rD5, rD6: invokeRetro(d) }
})
t('D1 BUILD fires when frontmatter changed and the index did not', () => { ok(has(D().rD.out, 'BUILD:'), D().rD.out) })
t('D1 names the index path from the declaration', () => { ok(has(D().rD.out, String.raw`docs/index\.json`), D().rD.out) })
t('D2 BUILD is SILENT for a body-only edit — the subtle one', () => { ok(!has(D().rD2.out, 'BUILD:'), D().rD2.out) })
t('D4 BUILD fires when the last of three modified docs changed its frontmatter', () => { ok(has(D().rD4.out, 'BUILD:'), D().rD4.out) })
t('D5 BUILD is SILENT when three modified docs keep their frontmatter', () => { const r = D().rD5; ok(!has(r.out, 'BUILD:') && r.code === 0, `exit=${r.code}: ${r.out}`) })
t('D6 BUILD is SILENT when the commit also changes the index', () => { ok(!has(D().rD6.out, 'BUILD:'), D().rD6.out) })

// D7: the git boundary starts the real git.exe of a Git for Windows install, never its `cmd`
// launcher, because a hidden start through the launcher costs about 26 ms more per call. Layout
// `a` has both binaries. Layout `b` has only the launcher. A git outside a `cmd` folder and an
// empty PATH answer pass through. Off Windows every path passes through.
const D7 = lazy('D7', () => {
  const gl = path.join(fxBase, 'git-layout')
  for (const dir of ['a/cmd', 'a/mingw64/bin', 'b/cmd']) fs.mkdirSync(path.join(gl, dir), { recursive: true })
  for (const file of ['a/cmd/git.exe', 'a/mingw64/bin/git.exe', 'b/cmd/git.exe']) fs.writeFileSync(path.join(gl, file), 'x\n')
  const out = runChild('real-git', async (scriptsDir, r) => {
    const path = (await import('node:path')).default
    const { pathToFileURL } = await import('node:url')
    const g = await import(pathToFileURL(path.join(scriptsDir, 'harness_git.mjs')).href)
    const cases = [path.join(r, 'a', 'cmd', 'git.exe'), path.join(r, 'b', 'cmd', 'git.exe'), path.join(r, 'a', 'mingw64', 'bin', 'git.exe'), '']
    console.log('D7:' + cases.map((c) => (g._real_git(c) === c ? 'same' : path.relative(r, g._real_git(c)).split(path.sep).join('/'))).join('|'))
  }, [here, gl])
  return { out, want: process.platform === 'win32' ? 'D7:a/mingw64/bin/git.exe|same|same|same' : 'D7:same|same|same|same' }
})
t('D7 a Git for Windows cmd launcher resolves to the real git.exe beside it, and every other path passes through', () => {
  const { out, want } = D7(); ok(out.trim() === want, `want ${want}, got ${out}`)
})

// D8: the batch read never confuses two paths. git drops a CR before the LF of each batch line, so
// `x.md` + CR would read `x.md`: such a path takes the per-path read. The index entry is made with
// --cacheinfo, so no file system has to hold the CR. A non-ASCII path that is absent reads as null,
// not as a throw. The last call shows that the batch refuses a CR outright.
const D8 = lazy('D8', () => {
  const d8 = newRepo('batch-names', CFG)
  const d8a = git(d8, ['hash-object', '-w', '--stdin'], { stdin: '---\nid: plain\n---\n' }).stdout.trim()
  const d8b = git(d8, ['hash-object', '-w', '--stdin'], { stdin: '---\nid: carriage\n---\n' }).stdout.trim()
  git(d8, ['update-index', '--add', '--cacheinfo', `100644,${d8a},docs/adr/x.md`])
  // Git for Windows refuses a CR in a path by default (core.protectNTFS), so the fixture lifts it.
  const built = git(d8, ['-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${d8b},docs/adr/x.md\r`])
  git(d8, ['commit', '-q', '-m', 'docs: two names one CR apart']) // no add -A: the entries have no files
  const out = runChild('batch-names', async (scriptsDir, root) => {
    const path = (await import('node:path')).default
    const { pathToFileURL } = await import('node:url')
    const retro = await import(pathToFileURL(path.join(scriptsDir, 'harness_retro.mjs')).href)
    const g = await import(pathToFileURL(path.join(scriptsDir, 'harness_git.mjs')).href)
    const fm = retro.frontmatters_at(root, [['HEAD', 'docs/adr/x.md\r'], ['HEAD', 'docs/adr/x.md']])
    const absent = g.git_objects(root, ['HEAD:docs/spec/0001-한글.md'])
    let refused = 'no'
    try { g.git_objects(root, ['HEAD:docs/adr/x.md\r']) } catch (e) { refused = e.name }
    // D9: git_result_async gives the result of git_result, stdin and exit code included, and rejects like it.
    const pick = (r) => JSON.stringify([r.status, r.stdout, r.stderr !== '', r.cmd])
    const same = []
    for (const [args, opts] of [[['cat-file', '--batch-check'], { stdin: 'HEAD:docs/adr/x.md\nHEAD:docs/spec/0001-한글.md\n' }], [['rev-parse', '--verify', '--quiet', 'nope'], {}]]) {
      same.push(pick(await g.git_result_async(root, args, opts)) === pick(g.git_result(root, args, opts)))
    }
    let rejected = 'no'
    try { await g.git_result_async(path.join(root, 'no-such-dir'), ['status']) } catch (e) { rejected = e.name }
    console.log(JSON.stringify({ fm, absent, refused, same, rejected }))
  }, [here, d8])
  return { out, builtStatus: built.status }
})
t('D8 fixture: the index took the CR-ended path', () => { const { builtStatus } = D8(); ok(builtStatus === 0, `update-index exit ${builtStatus}`) })
t('D8 a CR-ended path reads its own blob, an absent non-ASCII path is null, and the batch refuses a CR; D9 git_result_async matches git_result and rejects a missing root', () => {
  const rej = process.platform === 'win32' ? 'NotADirectoryError' : 'FileNotFoundError'
  const want = `{"fm":["id: carriage","id: plain"],"absent":[null],"refused":"ValueError","same":[true,true],"rejected":"${rej}"}`
  const { out } = D8(); ok(out.trim() === want, `want ${want}, got ${out}`)
})

// D3: a rename OUT of docs/ drops an index entry, so it must fire even though the final path is
// not a doc. This is why every path field is matched, not just the last.
const D3 = lazy('D3', () => {
  const d3 = newRepo('build-rename', CFG)
  writeF(d3, 'docs/adr/0001-a.md', adr('0001'))
  commit(d3, 'docs: add')
  git(d3, ['mv', 'docs/adr/0001-a.md', 'notes.md'])
  commit(d3, 'chore: move it out')
  return invokeRetro(d3)
})
t('D3 BUILD fires on a rename OUT of docs/', () => { ok(has(D3().out, 'BUILD:'), D3().out) })

// --- E: FEAT — a feat commit with no docs at all -------------------------------------------------
const E = lazy('E', () => {
  const e = newRepo('feat', CFG)
  writeF(e, 'other.txt', 'x\n')
  commit(e, 'feat: something with no docs')
  const rE = invokeRetro(e)

  const e2 = newRepo('feat-ok', CFG)
  writeF(e2, 'other.txt', 'x\n')
  writeF(e2, 'docs/adr/0002-b.md', adr('0002'))
  writeF(e2, 'docs/index.json', '{"adr":[]}')
  commit(e2, 'feat: something with docs')
  return { e, e2, rE, rE2: invokeRetro(e2) }
})
t('RT4 E FEAT fires', () => { ok(has(E().rE.out, 'FEAT:'), E().rE.out) })
t('E2 FEAT is SILENT when docs moved too', () => { ok(!has(E().rE2.out, 'FEAT:'), E().rE2.out) })

// --- CL: no class check (ywr-harness ADR 0215). Piggybacks on the E2 repo: a close body whose digest counts findings and
// holds no class line draws no finding, and --coverage prints no class tally. The retro run costs ~0.5 s each.
const CL = lazy('CL', () => {
  const { e, e2 } = E()
  writeF(e2, 'cl1.txt', 'x\n')
  commit(e2, 'chore: cl1\n\nReview: confirmed 3 (h0 m2 l1)')
  const msgFile = path.join(e2, 'cl1.txt')
  const rCL = invokeRetro(e2)
  const rCL2 = invokeRetro(e2, ['--coverage'])
  // The call has the older hook's shape: the message file alone, no --repo.
  const rCL3 = runRetro(['--class-message', msgFile])
  // CL9: a bare revision is the commits after it, the same span its file diff covers. On the E repo the feat commit is
  // HEAD~1 after one more commit: given HEAD~1, the subjects stop short of the feat commit, so FEAT is silent; given
  // HEAD~2 (the seed), the span holds it and FEAT fires. Mutation anchor: reading `git log <rev>` whole fires both.
  writeF(e, 'other2.txt', 'y\n')
  commit(e, 'chore: after the feat')
  const rCL9 = invokeRetro(e, ['HEAD~1'])
  const rCL9b = invokeRetro(e, ['HEAD~2'])
  const rCL4 = invokeRetro(e2, ['--coverage', '--class-message', msgFile])
  // The refusal text says "no other argument", so --repo is refused too (dist #18). An older commit-msg hook passes the
  // message file alone, so this refuses no hook call. The call names --repo itself, so it does not rest on invokeRetro.
  const rCL4b = runRetro(['--class-message', msgFile, '--repo', e2])
  return { rCL, rCL2, rCL3, rCL9, rCL9b, rCL4, rCL4b }
})
t('CL1 a body with a digest and no class line gives no finding', () => { const r = CL().rCL; ok(r.code === 0 && r.out.trim() === '', `exit=${r.code} out=${r.out}`) })
t('CL2 --coverage prints no class-line tally and still prints the ignore register', () => {
  const r = CL().rCL2; ok(r.code === 0 && !has(r.out, 'class lines') && has(r.out, 'ignore register'), `exit=${r.code} out=${r.out}`)
})
t('CL3 --class-message is accepted and ignored: exit 0, silent, so an older commit-msg hook never refuses a message', () => {
  const r = CL().rCL3; ok(r.code === 0 && blank(r.out), `exit=${r.code} out=${r.out}`)
})
t('CL9 a bare revision reads only the commits after it (HEAD~1 leaves the feat commit out, HEAD~2 holds it)', () => {
  const { rCL9, rCL9b } = CL(); ok(!has(rCL9.out, 'FEAT:') && has(rCL9b.out, 'FEAT:'), `HEAD~1: ${rCL9.out} | HEAD~2: ${rCL9b.out}`)
})
t('CL4 --class-message with another mode is refused, exit 2, so a coverage run never ends silent', () => {
  const r = CL().rCL4; ok(r.code === 2 && has(r.out, 'takes no other argument'), `exit=${r.code} out=${r.out}`)
})
t('CL4b --class-message with --repo is refused, exit 2', () => {
  const r = CL().rCL4b; ok(r.code === 2 && has(r.out, 'takes no other argument'), `exit=${r.code} out=${r.out}`)
})

// --- F: UNMAPPED — added in-scope file no spec owns ----------------------------------------------
const F = lazy('F', () => {
  const f = newRepo('unmapped', CFG)
  writeF(f, 'src/new.py', 'y = 1\n')
  commit(f, 'chore: add unowned source')
  const rF = invokeRetro(f)

  // F2: the ignore register exempts it.
  writeF(f, '.githooks/slice-retro-ignore', '# plumbing\nsrc/ignored\\.py\n')
  writeF(f, 'src/ignored.py', 'z = 1\n')
  commit(f, 'chore: add ignored source')
  const rF2 = invokeRetro(f)

  // F3: MODIFYING an unowned file is not UNMAPPED — added-files-only is the adoption strategy, and
  // without this case the check would spam every commit that touches legacy code.
  writeF(f, 'src/new.py', 'y = 2\n')
  commit(f, 'fix: modify the unowned file')
  const rF3 = invokeRetro(f)

  // F4: an owned file does not fire, and the BLOCK form of implements_in parses. A parser that only
  // understood the inline form would drop half a real corpus while reporting full coverage.
  const f4 = newRepo('unmapped-owned', CFG)
  writeF(f4, 'docs/spec/0001-s.md', '---\nid: "0001"\ntype: spec\nimplements_in:\n  - src/owned.py\n---\n# spec\n')
  writeF(f4, 'src/owned.py', 'a = 1\n')
  commit(f4, 'chore: add owned source')
  const rF4 = invokeRetro(f4)

  // F5: the MULTI-LINE flow form owns its files too (dist issue #6). Before 0.54.0 this parser read
  // nothing from it — `\[(.*?)\]` needs the `]` on the key's own line — so both files fired UNMAPPED
  // while the builder (after the same fix) indexed them as owned: the two parsers disagreed on one field.
  const f5 = newRepo('unmapped-owned-flow', CFG)
  writeF(f5, 'docs/spec/0001-s.md', '---\nid: "0001"\ntype: spec\nimplements_in: [\n  "src/flow_a.py",\n  src/flow_b.py,   # trailing comma\n]\ntags: [x]\n---\n# spec\n')
  writeF(f5, 'src/flow_a.py', 'a = 1\n')
  writeF(f5, 'src/flow_b.py', 'b = 1\n')
  commit(f5, 'chore: add flow-owned sources')
  const rF5 = invokeRetro(f5)

  // F6: a block list with a comment HEAD, a comment line between items and an inline comment on an
  // item — the builder's comment rule, applied item by item.
  const f6 = newRepo('unmapped-owned-block-comments', CFG)
  writeF(f6, 'docs/spec/0001-s.md', '---\nid: "0001"\ntype: spec\nimplements_in:   # owned files\n  - src/blk_a.py   # why\n\n  # between\n  - "src/blk_b.py"\n---\n# spec\n')
  writeF(f6, 'src/blk_a.py', 'a = 1\n')
  writeF(f6, 'src/blk_b.py', 'b = 1\n')
  commit(f6, 'chore: add block-owned sources')
  return { rF, rF2, rF3, rF4, rF5, rF6: invokeRetro(f6) }
})
t('RT5 F UNMAPPED fires on a new unowned in-scope file', () => { ok(has(F().rF.out, String.raw`UNMAPPED: new file src/new\.py`), F().rF.out) })
t('F2 an ignored file does not fire UNMAPPED', () => { ok(!has(F().rF2.out, String.raw`UNMAPPED: new file src/ignored\.py`), F().rF2.out) })
t('F3 modifying an unowned file does NOT fire UNMAPPED', () => { ok(!has(F().rF3.out, 'UNMAPPED'), F().rF3.out) })
t('F4 a block-form implements_in owns the file (no UNMAPPED)', () => { ok(!has(F().rF4.out, 'UNMAPPED'), F().rF4.out) })
t('F5 a multi-line flow implements_in owns both files (no UNMAPPED)', () => { ok(!has(F().rF5.out, 'UNMAPPED'), F().rF5.out) })
t('F5 and maps no junk path (no DEADMAP)', () => { ok(!has(F().rF5.out, 'DEADMAP'), F().rF5.out) })
t('F6 a commented block list owns both files, comments cut (no UNMAPPED, no DEADMAP)', () => { const o = F().rF6.out; ok(!has(o, 'UNMAPPED') && !has(o, 'DEADMAP'), o) })

// --- G: DEADMAP — implements_in points at a missing file -----------------------------------------
const G = lazy('G', () => {
  const g = newRepo('deadmap', CFG)
  writeF(g, 'docs/spec/0001-s.md', spec('0001', ['src/gone.py']))
  commit(g, 'docs: map a file that does not exist')
  const rG = invokeRetro(g)

  // G2: an item carrying ']' (the Next.js catch-all route) in a one-line list (dist issue #6). The
  // lazy `\[(.*?)\]` stopped at the FIRST ']': it mapped `app/api/auth/[...nextauth` — a false
  // DEADMAP on every commit — and dropped every later item, so src/c.py fired UNMAPPED as well.
  const g2 = newRepo('deadmap-bracket-item', CFG)
  writeF(g2, 'app/api/auth/[...nextauth]/route.ts', 'export {}\n')
  writeF(g2, 'src/c.py', 'c = 1\n')
  writeF(g2, 'docs/spec/0001-s.md', spec('0001', ['app/api/auth/[...nextauth]/route.ts', 'src/c.py']))
  commit(g2, 'chore: map a catch-all route')
  const rG2 = invokeRetro(g2)

  // G3: the SHIPPED spec template, verbatim. Its `implements_in: [ ]` line carries an inline comment
  // whose example is itself a bracketed list (`예: ["docs/build_docs.py"]`), and `[0-9]*.md` DOES scan
  // 0000-template.md. A greedy `\[(.*)\]` — the obvious fix for G2 — reaches into that comment and
  // maps junk to the template: a DEADMAP on every repo carrying the template. The inline-comment cut
  // (whitespace + '#', the builder's rule) is what keeps both G2 and G3 green.
  const g3 = newRepo('deadmap-template-comment', CFG)
  const tmplSrc = path.join(here, '..', 'skills', 'harness-init', 'templates', 'docs', 'spec', '0000-template.md')
  writeF(g3, 'docs/spec/0000-template.md', fs.readFileSync(tmplSrc, 'utf8'))
  commit(g3, 'docs: place the spec template')
  const rG3 = invokeRetro(g3)
  const rG3c = invokeRetro(g3, ['--coverage'])

  // G5: the multi-line form of G2's class, end to end — a last item ending in `]` (a Next.js dynamic
  // route DIRECTORY) with the closing `]` on its own line. The old close rule (first line ending in
  // `]`) cut it to `app/[slug` in both parsers alike, so the pairing passed while the retro fired a
  // false DEADMAP on every commit; the bracket balance reads the item whole.
  const g5 = newRepo('deadmap-bracket-dir-multiline', CFG)
  writeF(g5, 'app/[slug]/page.tsx', 'export {}\n')
  writeF(g5, 'src/a.py', 'a = 1\n')
  writeF(g5, 'docs/spec/0001-s.md', '---\nid: "0001"\ntype: spec\nimplements_in: [\n  src/a.py,\n  app/[slug]\n]\ntags: [x]\n---\n# spec\n')
  commit(g5, 'chore: map a dynamic-route directory in a multi-line list')
  const rG5 = invokeRetro(g5)
  const rG5c = invokeRetro(g5, ['--coverage'])
  return { g, rG, rG2, rG3, rG3c, rG5, rG5c }
})
t('RT6 G DEADMAP fires', () => { ok(has(G().rG.out, String.raw`DEADMAP:.*src/gone\.py`), G().rG.out) })
t('G2 an item containing ] is read whole — no false DEADMAP', () => { ok(!has(G().rG2.out, 'DEADMAP'), G().rG2.out) })
t('G2 the item AFTER it is still owned (no UNMAPPED for src/c.py)', () => { ok(!has(G().rG2.out, 'UNMAPPED'), G().rG2.out) })
t('G3 the shipped template maps nothing out of its own comment (no DEADMAP)', () => { ok(!has(G().rG3.out, 'DEADMAP'), G().rG3.out) })
t('G3 --coverage agrees: no dead mappings', () => { ok(has(G().rG3c.out, 'dead mappings: none'), G().rG3c.out) })

// G4: PAIRING — this parser against the docs builder's, shape by shape. They are two parsers of one
// field by necessity (the retro reads committed sources, not an index that may not be rebuilt), and
// until 0.54.0 they disagreed on three shapes (dist issue #6). The builder is the TEMPLATE copy the
// plugin ships (byte-identical to the canon's docs/build_docs.mjs — manifest-gate's dogfood sweep).
// Each shape carries the EXPECTED builder value, compared TYPED (type name + value, so an int 7 is
// not a string '7'): the retro must equal it as a list, or [] where the builder indexes a non-list,
// and the builder must equal it exactly — so a rule dropped from BOTH parsers (the column-0 key
// guard, the bracket balance, the comment-only cut) still fails, which a bare pairing cannot see.
// "flow unclosed before a key" is the guard's pin: without the guard both parsers swallow `next: 3`
// into the list and close it at the stray `]`. The "ends in ]" shapes are the balance rule's pin: the
// old rule (first line ending in `]` closes) truncated `app/[slug]` to `app/[slug` in both parsers.
const G4 = lazy('G4', () => runChild('pairing', async (scriptsDir, builderPath) => {
  const path = (await import('node:path')).default
  const { pathToFileURL } = await import('node:url')
  const retro = await import(pathToFileURL(path.join(scriptsDir, 'harness_retro.mjs')).href)
  const bd = await import(pathToFileURL(builderPath).href)
  const AB = ['src/a.py', 'src/b.py']
  // [name, block, expected builder value]; a null expectation is the builder's absent value
  const shapes = [
    ['one-line', 'implements_in: ["src/a.py", "src/b.py"]', AB],
    ['one-line bracket item', 'implements_in: [app/api/auth/[...nextauth]/route.ts, src/c.py]',
      ['app/api/auth/[...nextauth]/route.ts', 'src/c.py']],
    ['one-line empty', 'implements_in: []', []],
    ['template comment', 'implements_in: [ ]         # x (예: ["docs/build_docs.mjs"]), y', []],
    ['block', 'implements_in:\n  - src/a.py\n  - "src/b.py"', AB],
    ['block compact', 'implements_in:\n- src/a.py\n- src/b.py', AB],
    ['block commented', 'implements_in:   # files\n  - src/a.py   # why\n\n  # between\n  - "src/b.py"  # quoted\n  -\n  - # empty\nnext: 1', AB],
    ['flow multi-line', 'implements_in: [\n  "src/a.py",\n  src/b.py,   # c\n]\nnext: 2', AB],
    ['flow first item inline', 'implements_in: ["src/a.py",\n  "src/b.py"]', AB],
    ['flow last item ends in ]', 'implements_in: [\n  src/a.py,\n  app/[slug]\n]\nnext: 5', ['src/a.py', 'app/[slug]']],
    ['flow head line ends in ]', 'implements_in: [src/a.py, app/[slug]\n]\nnext: 6', ['src/a.py', 'app/[slug]']],
    ['flow bracketed dir mid-path', 'implements_in: [\n  app/[slug]/page.tsx\n]', ['app/[slug]/page.tsx']],
    ['flow quoted item carrying ]', 'implements_in: [\n  "src/x]y.py",\n  src/a.py\n]', ['src/x]y.py', 'src/a.py']],
    ['flow unterminated', 'implements_in: [\n  "src/a.py",\nnext: 3', '['],
    ['flow unclosed before a key', 'implements_in: [\n  "src/a.py",\nnext: 3\n]', '['],
    ['flow closed with trailing text', 'implements_in: [\n  src/a.py,\n] x\nnext: 7', '['],
    ['comment-only value', 'implements_in:   # TBD\nnext: 8', null],
    ['empty then key', 'implements_in:\nnext: 4', null],
    ['numeric items', 'implements_in: [7, "0001", 0002, src/a.py]', [7, '0001', 2, 'src/a.py']],
    ['block numeric items', 'implements_in:\n  - 7\n  - "8"', [7, '8']],
    ['quoted empty item', 'implements_in: ["", src/a.py]', ['', 'src/a.py']],
    ['duplicate key, last wins', 'implements_in: [src/a.py]\nimplements_in:\n  - src/z.py', ['src/z.py']],
    ['absent', 'title: x', null],
  ]
  // a value with its type name, so a number 7 is not the string '7'
  const typed = (v) => (Array.isArray(v) ? v.map((x) => [typeof x, x]) : [v === null || v === undefined ? 'null' : typeof v, v ?? null])
  const fails = []
  for (const [name, block, want] of shapes) {
    const [meta] = bd.parse_frontmatter('---\n' + block + '\n---\n')
    const got = meta.has('implements_in') ? meta.get('implements_in') : null
    if (JSON.stringify(typed(got)) !== JSON.stringify(typed(want))) {
      fails.push(`${name}: builder ${JSON.stringify(got)} != expected ${JSON.stringify(want)}`)
    }
    const mine = retro.implements_in(block.split('\n'))
    if (JSON.stringify(typed(mine)) !== JSON.stringify(typed(Array.isArray(want) ? want : []))) {
      fails.push(`${name}: retro ${JSON.stringify(mine)} != builder-as-list ${JSON.stringify(want)}`)
    }
  }
  console.log(fails.length ? 'G4-FAIL: ' + fails.join(' | ') : 'G4-OK')
}, [here, path.join(here, '..', 'skills', 'harness-init', 'templates', 'docs', 'build_docs.mjs')]))
t('G4 the retro parser and the docs builder agree, typed, with the expected value of every implements_in shape', () => { ok(has(G4(), 'G4-OK'), G4()) })

t('G5 a multi-line list whose last item ends in ] maps it whole (no DEADMAP, no UNMAPPED)', () => { const o = G().rG5.out; ok(!has(o, 'DEADMAP') && !has(o, 'UNMAPPED'), o) })
t('G5 --coverage agrees: no dead mappings', () => { ok(has(G().rG5c.out, 'dead mappings: none'), G().rG5c.out) })

// --- H: a clean commit is completely silent -------------------------------------------------------
// The property that makes an advisory gate readable at all.
const H = lazy('H', () => {
  const h = newRepo('clean', CFG)
  writeF(h, 'notes.txt', 'just a note\n')
  commit(h, 'chore: nothing interesting')
  return invokeRetro(h)
})
t('RT7 H a clean commit prints nothing', () => { ok(blank(H().out), `got: ${H().out}`) })
t('RT7 H exits 0', () => { ok(H().code === 0, `exit=${H().code}`) })

// --- I: SLICE_RETRO=0 skips entirely --------------------------------------------------------------
const I = lazy('I', () => invokeRetro(G().g, [], { SLICE_RETRO: '0' }))
t('RT8 I SLICE_RETRO=0 silences a repo that otherwise reports', () => { ok(blank(I().out), `got: ${I().out}`) })

// --- J: range mode absorbs a mid-slice split ------------------------------------------------------
// The docs commit follows the code commit. Per-commit the first one reports; over the range it
// must not — that is the entire reason range mode exists.
const J = lazy('J', () => {
  const j = newRepo('range', CFG)
  writeF(j, 'src/app.py', 'x = 1\n')
  writeF(j, 'docs/spec/0001-s.md', spec('0001', ['src/app.py']))
  commit(j, 'chore: base')
  const base = gitOut(j, ['rev-parse', 'HEAD'])
  writeF(j, 'src/app.py', 'x = 2\n')
  commit(j, 'fix: code only')
  const rJ1 = invokeRetro(j)
  writeF(j, 'docs/spec/0001-s.md', `${spec('0001', ['src/app.py'])}now updated\n`)
  writeF(j, 'docs/index.json', '{"spec":[]}')
  commit(j, 'docs: catch the spec up')
  return { rJ1, rJ2: invokeRetro(j, [`${base}..HEAD`]) }
})
t('RT9 J per-commit reports the split', () => { ok(has(J().rJ1.out, 'SPEC:'), J().rJ1.out) })
t('RT9 J over the whole range it is silent', () => { ok(!has(J().rJ2.out, 'SPEC:'), J().rJ2.out) })

// --- L: a merge commit is a range in disguise (ADR 0043) -----------------------------------------
// diff-tree without -m prints NOTHING for a merge commit, so before the fix the retro ran all
// seven checks over an empty change set — a conflicted `git pull` concluded with `git commit`
// fired post-commit and passed silently having checked nothing. L1 is the mutation anchor: it
// fails when the HEAD^2 probe is removed. L2 pins the silence half — first-parent scope must not
// over-report a merge that landed nothing interesting.
const L = lazy('L', () => {
  const l = newRepo('merge', CFG)
  writeF(l, 'src/app.py', 'x = 1\n')
  writeF(l, 'docs/spec/0001-s.md', spec('0001', ['src/app.py']))
  commit(l, 'chore: base')
  const mainBranch = gitOut(l, ['symbolic-ref', '--short', 'HEAD'])
  git(l, ['checkout', '-q', '-b', 'side'])
  writeF(l, 'src/app.py', 'x = 2\n')
  commit(l, 'fix: change the mapped file on a branch, spec untouched')
  git(l, ['checkout', '-q', mainBranch])
  git(l, ['merge', '-q', '--no-ff', '--no-edit', 'side'])
  const rL = invokeRetro(l)

  git(l, ['checkout', '-q', '-b', 'side2'])
  writeF(l, 'notes.txt', 'nothing interesting\n')
  commit(l, 'chore: an innocuous branch change')
  git(l, ['checkout', '-q', mainBranch])
  git(l, ['merge', '-q', '--no-ff', '--no-edit', 'side2'])
  const rL2 = invokeRetro(l)

  // L3: an octopus merge is covered by the same range. The review's octopus concern (2026-08-10, low)
  // claimed non-first legs escape the diff. They do not — HEAD^1..HEAD is a tree diff plus a
  // reachability log, both of which include every leg — and this case MEASURES that: the SPEC-firing
  // change lives on the SECOND merged branch.
  const l3 = newRepo('merge-octopus', CFG)
  writeF(l3, 'src/app.py', 'x = 1\n')
  writeF(l3, 'docs/spec/0001-s.md', spec('0001', ['src/app.py']))
  commit(l3, 'chore: base')
  const mainBranch3 = gitOut(l3, ['symbolic-ref', '--short', 'HEAD'])
  git(l3, ['checkout', '-q', '-b', 'legA'])
  writeF(l3, 'notes-a.txt', 'leg a\n')
  commit(l3, 'chore: innocuous leg A')
  git(l3, ['checkout', '-q', mainBranch3])
  git(l3, ['checkout', '-q', '-b', 'legB'])
  writeF(l3, 'src/app.py', 'x = 2\n')
  commit(l3, 'fix: mapped-file change on leg B, spec untouched')
  git(l3, ['checkout', '-q', mainBranch3])
  git(l3, ['merge', '-q', '--no-edit', 'legA', 'legB'])
  return { rL, rL2, rL3: invokeRetro(l3) }
})
t('L1 a merge commit fires the checks over its first-parent diff', () => { ok(has(L().rL.out, String.raw`SPEC:.*0001-s\.md`), L().rL.out) })
t('L1 stays advisory on a merge (exit 0)', () => { ok(L().rL.code === 0, `exit=${L().rL.code}`) })
t('L2 a clean merge is completely silent', () => { ok(blank(L().rL2.out), `got: ${L().rL2.out}`) })
t("L3 an octopus merge fires on a non-first leg's change", () => { ok(has(L().rL3.out, String.raw`SPEC:.*0001-s\.md`), L().rL3.out) })

// --- K: --coverage reports DISABLED checks rather than passing quietly --------------------------
// Silence must mean clean, never "not configured".
const K = lazy('K', () => {
  const k = newRepo('nocfg', '{ "retro": {} }')
  const rK = invokeRetro(k, ['--coverage'])
  const rK2 = invokeRetro(G().g, ['--coverage'])
  // K3: the report survives a console that cannot encode it (dist issue #6 claimed a cp949 crash;
  // not reproduced — the UTF-8 pin has run at import since v0.9.0). This is the regression guard for
  // that pin: ascii:strict is the harshest stdout a member's console can hand the old Python gate, and the
  // DISABLED lines carry '—'. Removing the pin raises UnicodeEncodeError here and exits 1.
  return { k, rK, rK2, rK3: invokeRetro(k, ['--coverage'], { PYTHONIOENCODING: 'ascii:strict' }) }
})
t('RT10 K an undeclared scope is reported as DISABLED', () => { ok(has(K().rK.out, 'source_scope not declared.*DISABLED'), K().rK.out) })
t('RT10 K all three undeclared checks are named', () => { ok((K().rK.out.match(/DISABLED/giu) ?? []).length >= 3, K().rK.out) })
t('K2 coverage lists dead mappings', () => { ok(has(K().rK2.out, 'dead mappings.*1'), K().rK2.out) })
t('K2 coverage names the ignore register', () => { ok(has(K().rK2.out, 'ignore register'), K().rK2.out) })
t('K3 --coverage on an ascii:strict console exits 0 with no UnicodeEncodeError', () => {
  const r = K().rK3; ok(r.code === 0 && !has(r.out, 'UnicodeEncodeError'), `exit=${r.code}: ${r.out}`)
})
t('K3 and the em dash arrives intact (UTF-8, not a replacement)', () => { ok(has(K().rK3.out, 'not declared — the checks it drives are DISABLED'), K().rK3.out) })

// --- N: a git failure is LOUD, never a false clean retro (O41(c), ADR 0041's principle) ---------
// git() swallowed every failure as empty output, so an unresolvable range read as "nothing
// changed" — silent, exit 0, indistinguishable from case H. Now: a stdout FAILED marker, exit 1
// (the post-commit hook's `|| true` keeps the commit untouched). N2 is the silence half: the
// semantic exits (rev-parse -q --verify on a root commit's HEAD^) still read as absent.
const N = lazy('N', () => {
  const n = newRepo('git-failure', CFG)
  return { rN: invokeRetro(n, ['no-such-rev..HEAD']), rN2: invokeRetro(n) }
})
t('N1 an unresolvable range prints a FAILED marker on stdout', () => {
  const o = N().rN.out; ok(has(o, String.raw`\[slice-retro\] FAILED — git diff`) && has(o, 'NO retro check ran'), o)
})
t('N1 and exits non-zero, no traceback', () => { const r = N().rN; ok(r.code === 1 && !has(r.out, 'Traceback'), `exit=${r.code}: ${r.out}`) })
t('N2 a root commit (HEAD^ absent, exit 1) is still a clean silent run', () => { const r = N().rN2; ok(r.code === 0 && blank(r.out), `exit=${r.code}: ${r.out}`) })

// --- O: a path carrying U+2028 stays ONE path (O41(c), ADR 0077) ---------------------------------
// `.splitlines()` over `diff-tree --name-status` broke `src/a<U+2028>b.py` into `src/a` (no .py —
// out of scope) + `b.py` (no tab — dropped), so UNMAPPED stayed SILENT on a new unowned file.
// The separator is built from its code point at runtime, never a literal in this file.
const O = lazy('O', () => {
  const ls = String.fromCharCode(0x2028)
  const o = newRepo('line-sep-path', CFG)
  writeF(o, `src/a${ls}b.py`, 'x = 1\n')
  commit(o, 'chore: add a file whose name carries U+2028')
  return { ls, rO: invokeRetro(o), rO2: invokeRetro(o, ['--coverage']) }
})
t('O1 per-commit: UNMAPPED names the U+2028 path as ONE file', () => {
  const { ls, rO } = O(); ok(has(rO.out, `UNMAPPED: new file ${rxEscape(`src/a${ls}b.py`)} is owned`), rO.out)
})
t('O2 --coverage: the U+2028 path is ONE unowned file (ls-files -z)', () => {
  const { ls, rO2 } = O()
  ok(has(rO2.out, 'unowned files \\(in scope, no spec, not ignored\\): 1 of 1') && rO2.out.includes(`src/a${ls}b.py`), rO2.out)
})

// --- P: frontmatter_at — absence is asked structurally, every other git fatal is LOUD ------------
// `git show pre:path` exited 128 both for "absent at pre" and for any fatal, so a missing blob
// read as "absent" (a silent difference). P1 deletes the loose object of the pre-side ADR blob:
// ls-tree still lists the path, the batch reply is `missing`, and `git show` must fail → FAILED marker, exit 1. P2 is the silence
// half: an ADR ADDED in the commit (absent at pre) still reads as a difference, not a failure.
function dropLooseBlob(repo, blob) {
  const obj = path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2))
  const had = fs.existsSync(obj)
  if (had) { fs.chmodSync(obj, 0o666); fs.rmSync(obj, { force: true }) }
  return { had, obj }
}
const P = lazy('P', () => {
  const p1 = newRepo('fm-missing-blob', CFG)
  writeF(p1, 'docs/adr/0001-a.md', adr('0001', 'status: proposed\n'))
  commit(p1, 'docs: add adr')
  const p1Blob = gitOut(p1, ['rev-parse', 'HEAD:docs/adr/0001-a.md'])
  writeF(p1, 'docs/adr/0001-a.md', adr('0001', 'status: accepted\n'))
  commit(p1, 'docs: accept it')
  const d1 = dropLooseBlob(p1, p1Blob)
  const rP1 = invokeRetro(p1)

  const p2 = newRepo('fm-added', CFG)
  writeF(p2, 'docs/adr/0001-a.md', adr('0001'))
  commit(p2, 'docs: add adr, no index')
  const rP2 = invokeRetro(p2)
  // P3: a commit that also changes the index answers BUILD, so the retro reads no frontmatter. The
  // missing pre-side blob of P1 then raises nothing: the finding would be silent either way.
  const p3 = newRepo('fm-missing-blob-index', CFG)
  writeF(p3, 'docs/adr/0001-a.md', adr('0001', 'status: proposed\n'))
  commit(p3, 'docs: add adr')
  const p3Blob = gitOut(p3, ['rev-parse', 'HEAD:docs/adr/0001-a.md'])
  writeF(p3, 'docs/adr/0001-a.md', adr('0001', 'status: accepted\n'))
  writeF(p3, 'docs/index.json', '{}\n')
  commit(p3, 'docs: accept it, with the index')
  const d3 = dropLooseBlob(p3, p3Blob)
  return { p2, d1, rP1, rP2, d3, rP3: invokeRetro(p3) }
})
t('P1 fixture: the pre-side blob was a loose object and is now gone', () => { const { d1 } = P(); ok(d1.had, d1.obj) })
t('P1 a missing pre-side blob is a FAILED marker, not "absent at pre"', () => {
  const o = P().rP1.out; ok(has(o, String.raw`\[slice-retro\] FAILED — git show`) && has(o, 'NO retro check ran'), o)
})
t('P1 and exits 1, no traceback', () => { const r = P().rP1; ok(r.code === 1 && !has(r.out, 'Traceback'), `exit=${r.code}: ${r.out}`) })
t('P3 fixture: the pre-side blob was a loose object and is now gone', () => { const { d3 } = P(); ok(d3.had, d3.obj) })
t('P3 a changed index reads no frontmatter: no FAILED marker, no BUILD, exit 0', () => {
  const r = P().rP3; ok(r.code === 0 && !has(r.out, 'FAILED|BUILD:'), `exit=${r.code}: ${r.out}`)
})
t('P2 an ADR absent at pre (added) is a difference: BUILD fires, exit 0', () => {
  const r = P().rP2; ok(r.code === 0 && has(r.out, 'BUILD:') && !has(r.out, 'FAILED'), `exit=${r.code}: ${r.out}`)
})

// --- Q: git absent from PATH is the FAILED marker, never a traceback -----------------------------
// PATH is one empty directory: the gate is invoked by absolute path, and node's own directory is no
// narrowing — stock Ubuntu puts git beside it in /usr/bin (fact 42). The absence is still asserted.
const Q = lazy('Q', () => {
  const qBin = path.join(fxBase, 'q-empty-path')
  fs.mkdirSync(qBin, { recursive: true })
  // The environment key is `Path` on Windows. A copy keeps that spelling, so drop every spelling first.
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = qBin
  return { qBin, gitGone: !gitOnPath(qBin), rQ: runNode([retro, '--repo', P().p2], { env }) }
})
t('RT11 Q fixture: git is not resolvable on the narrowed PATH', () => { const { gitGone, qBin } = Q(); ok(gitGone, `PATH=${qBin}`) })
t('RT11 Q a missing git binary prints the FAILED marker and exits 1, no traceback', () => {
  const r = Q().rQ; const out = r.stderr + r.stdout
  ok(r.status === 1 && has(out, String.raw`\[slice-retro\] FAILED — git could not be run`) && !has(out, 'Traceback'), `exit=${r.status}: ${out}`)
})

// --- R: a directory implements_in entry owns every file below it (ADR 0104, dist issue #7) -------
// Exact-string ownership read every file added under a directory entry as UNMAPPED, and a change
// there never fired SPEC. The prefix is `entry + "/"`: `src/notice` must not own `src/notice_old.py`.
const R = lazy('R', () => {
  const r = newRepo('dir-entry', CFG)
  writeF(r, 'docs/spec/0001-s.md', spec('0001', ['src/notice', 'src/board/']))
  commit(r, 'docs: spec maps directories')
  writeF(r, 'src/notice/service.py', 'x = 1\n')
  writeF(r, 'src/notice/sub/deep.py', 'x = 1\n')
  writeF(r, 'src/board/x.py', 'x = 1\n')
  writeF(r, 'src/notice_old.py', 'x = 1\n')
  commit(r, 'chore: add files under the mapped directories')
  const rR = invokeRetro(r)
  const rRc = invokeRetro(r, ['--coverage'])
  // R3: a DELETION under a directory entry still belongs to its spec — why owns() does no disk lookup.
  fs.rmSync(path.join(r, 'src/notice/sub/deep.py'))
  commit(r, 'chore: delete a file under the mapped directory')
  return { rR, rRc, rR3: invokeRetro(r) }
})
t('R1 files added under a directory entry are owned, nested and trailing-slash too (no UNMAPPED)', () => { ok(!has(R().rR.out, 'UNMAPPED: new file src/(notice/|board/)'), R().rR.out) })
t('R1 a sibling sharing the name prefix is still UNMAPPED', () => { ok(has(R().rR.out, String.raw`UNMAPPED: new file src/notice_old\.py`), R().rR.out) })
t('R1 a change under a directory entry fires SPEC for its spec', () => { ok(has(R().rR.out, String.raw`SPEC:.*0001-s\.md`), R().rR.out) })
t('R1 an existing directory entry is not a DEADMAP', () => { ok(!has(R().rR.out, 'DEADMAP'), R().rR.out) })
t('R2 --coverage agrees: only the sibling is unowned', () => {
  const o = R().rRc.out
  ok(has(o, String.raw`unowned files \(in scope, no spec, not ignored\): 1 of 4`) && has(o, String.raw`src/notice_old\.py`), o)
})
t('R3 a deletion under a directory entry fires SPEC for its spec', () => { ok(has(R().rR3.out, String.raw`SPEC:.*0001-s\.md`), R().rR3.out) })

// --- S: a docs source that opens with an HTML comment is read like the builder reads it (canon #59) -
// spec_map and frontmatter_at kept their own looser parse until 0.60.1 and required line 1 to be `---`;
// the index (build_docs.split_frontmatter, via hc.fm_block) skips a leading HTML comment. So a spec
// written `<!-- note -->` + frontmatter was INDEXED as owning its files while the retro read it as
// owning nothing (a false UNMAPPED), and a frontmatter edit under such a header read as
// `<no-frontmatter>` on both sides (a silently missed BUILD).
const S = lazy('S', () => {
  const s1 = newRepo('comment-led-spec', CFG)
  writeF(s1, 'docs/spec/0001-s.md', '<!-- note -->\n---\nid: "0001"\ntype: spec\nimplements_in: ["src/a.py"]\n---\n# spec\n')
  writeF(s1, 'src/a.py', 'a = 1\n')
  writeF(s1, 'src/b.py', 'b = 1\n')
  commit(s1, 'chore: add owned and unowned sources')
  const rS1 = invokeRetro(s1)

  const s2 = newRepo('comment-led-frontmatter', CFG)
  writeF(s2, 'docs/adr/0001-a.md', `<!-- note -->\n${adr('0001', 'status: proposed\n', 'body v1\n')}`)
  writeF(s2, 'docs/index.json', '{"adr":[]}')
  commit(s2, 'docs: add adr under a comment header')
  writeF(s2, 'docs/adr/0001-a.md', `<!-- note -->\n${adr('0001', 'status: accepted\n', 'body v1\n')}`)
  commit(s2, 'docs: accept it')
  const rS2 = invokeRetro(s2)
  writeF(s2, 'docs/adr/0001-a.md', `<!-- note -->\n${adr('0001', 'status: accepted\n', 'body v1\n\n## Addendum\nmore prose\n')}`)
  commit(s2, 'docs: append an addendum (body only)')
  return { rS1, rS2, rS3: invokeRetro(s2) }
})
t('S1 a spec led by an HTML comment owns its file (no UNMAPPED for src/a.py)', () => {
  const o = S().rS1.out; ok(!has(o, String.raw`UNMAPPED: new file src/a\.py`) && !has(o, 'DEADMAP'), o)
})
t('S1 control: the unowned sibling in the same commit still fires UNMAPPED', () => { ok(has(S().rS1.out, String.raw`UNMAPPED: new file src/b\.py`), S().rS1.out) })
t('S2 BUILD fires for a frontmatter change under a leading HTML comment', () => { ok(has(S().rS2.out, 'BUILD:'), S().rS2.out) })
t('S3 BUILD is SILENT for a body-only edit under a leading HTML comment', () => { ok(!has(S().rS3.out, 'BUILD:'), S().rS3.out) })

// --- DL: --delegations reads the delegation ledger's slot files (ADR 0120) -----------------------
// No git needed: the report reads files only. DL2 is the D6 counter's control and its exclusions in
// one session split over two slots (ADR 0118's LRU residual), one of them with step_fields REORDERED
// and no complete.usage, so a positional step read sums the wrong column.
const LEDGER = ['.claude', 'telemetry', 'delegations']
const fieldsStd = ['index', 'model', 'effort', 'message_count', 'stop_reason', 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'usage_model']
const fieldsRev = [...fieldsStd].reverse()
// One ledger loop. `usage` null writes complete.usage as null; `steps` rows follow step_fields.
function dlLoop(kind, models, efforts, evicted, usage, steps, spawn = null, stepsDropped = 0, agentId = null) {
  return {
    ts: 't', loop: kind, agent_id: agentId, turn_id: 'u', spawn, spawn_rows_evicted: evicted, steps, steps_dropped: stepsDropped,
    models, efforts, complete: { reason: 'answer', aborted: false, duration_ms: 1500, usage },
  }
}
function slotFile(ledgerDir, name, obj) { writeF(ledgerDir, name, typeof obj === 'string' ? obj : JSON.stringify(obj)) }
const slot = (sessionId, n, updated, stepFields, loopsDropped, loops) => ({ schema: 2, session_id: sessionId, slot: n, updated, step_fields: stepFields, loops_dropped: loopsDropped, loops })
const u = { model: 'm', input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 3 }
const newLedgerRoot = (name) => {
  const d = path.join(fxBase, name)
  fs.mkdirSync(d, { recursive: true })
  writeF(d, '.harness.json', '{}')
  return d
}
const ledger = (root) => path.join(root, ...LEDGER)

const DL1 = lazy('DL1', () => {
  const dl = path.join(fxBase, 'delegations')
  fs.mkdirSync(dl, { recursive: true })
  writeF(dl, '.harness.json', '{}')
  return { dl, r: invokeRetro(dl, ['--delegations']) }
})
t('DL1 no ledger directory: one line naming where the module writes, exit 0', () => {
  const r = DL1().r; ok(r.code === 0 && has(r.out, String.raw`no ledger at \.claude/telemetry/delegations`), `exit=${r.code}: ${r.out}`)
})

const DL2 = lazy('DL2', () => {
  const { dl } = DL1()
  const dir = ledger(dl)
  const mech = { subagent_type: 'ywr-harness:mech', model_param: null, model: 'claude-haiku-4-5' }
  const loopsA = [
    dlLoop('main', ['claude-opus-5-5'], ['xhigh'], 0, u, []),
    dlLoop('unspawned', ['claude-opus-5-5'], ['xhigh'], 0, u, []), //      inherit signature
    dlLoop('unspawned', ['claude-opus-5-5'], ['low'], 0, u, []), //        opus · low pin: on main, other effort
    dlLoop('unspawned', ['claude-haiku-4-5'], [], 0, u, []), //            pinned elsewhere: not counted
    dlLoop('agent-tool', ['claude-haiku-4-5'], [], 0, u, [], mech),
  ]
  slotFile(dir, 'slot-00.json', slot('sess-A', 0, '2026-10-02T01:00:00Z', fieldsStd, 2, loopsA))
  // Second file of the same session: an evicted-spawn unspawned on the main model (not attributed) and a
  // loop whose tokens come from its steps, read by NAME under a reversed step_fields.
  const stepsRev = [[null, 40, 30, 20, 10, 'end_turn', 3, 'xhigh', 'claude-opus-5-5', 0], [null, 1, 1, 1, 1, 'end_turn', 4, 'xhigh', 'claude-opus-5-5', 1]]
  const loopsB = [
    dlLoop('unspawned', ['claude-opus-5-5'], ['xhigh'], 3, u, []),
    dlLoop('main', ['claude-opus-5-5'], ['xhigh'], 0, null, stepsRev, null, 5),
  ]
  slotFile(dir, 'slot-07.json', slot('sess-A', 7, '2026-10-02T02:00:00Z', fieldsRev, 0, loopsB))
  // Skips, each named: a partial write, a schema-1 file; ignored without a word: a non-slot name.
  slotFile(dir, 'slot-03.json', '{"schema":2,"session_id":"sess-B","loo')
  slotFile(dir, 'slot-04.json', '{"schema":1,"session_id":"sess-C"}')
  slotFile(dir, 'notes.json', 'not a slot')
  return { dl, r: invokeRetro(dl, ['--delegations']) }
})
t('DL2 exit 0; two readable files, ONE session (merged by session_id), seven loops', () => {
  const r = DL2().r
  ok(r.code === 0 && has(r.out, String.raw`2 slot file\(s\), 1 session\(s\), 7 loop\(s\)`) && has(r.out, String.raw`session sess-A · slot-00\.json, slot-07\.json`), `exit=${r.code}: ${r.out}`)
})
t('DL2 D6 counts the two unspawned loops on the main model, one at its effort', () => {
  ok(has(DL2().r.out, String.raw`ADR 0117 D6: 2 unspawned loop\(s\) on their session's main model in 1 session\(s\); 1 also at the main loop's effort`), DL2().r.out)
})
t('DL2 the evicted-spawn loop is reported apart, never counted', () => { ok(has(DL2().r.out, 'not attributed: 1 with spawn rows evicted'), DL2().r.out) })
t('DL2 steps are read by step_fields NAME (reversed fields: in 11 · out 21 · read 31 · write 41)', () => {
  ok(has(DL2().r.out, String.raw`main · claude-opus-5-5 · xhigh — 2 loop\(s\), 3\.0 s, tokens in 16 · out 28 · cache read 131 · cache write 44 \(1 loop\(s\) without complete\.usage`), DL2().r.out)
})
t('DL2 an agent-tool row names its type and model_param', () => { ok(has(DL2().r.out, String.raw`agent-tool ywr-harness:mech \(model_param none\) · claude-haiku-4-5`), DL2().r.out) })
t('DL2 caps are surfaced (2 loops, 5 steps dropped)', () => { ok(has(DL2().r.out, String.raw`caps: 2 loop\(s\) dropped by the file caps, 5 step row\(s\)`), DL2().r.out) })
t('DL2 the partial and the schema-1 file are each named as skipped; notes.json is not read', () => {
  const o = DL2().r.out
  ok(has(o, String.raw`skipped: slot-03\.json \(not JSON`) && has(o, String.raw`skipped: slot-04\.json \(not a schema 2 slot\)`) && !has(o, String.raw`notes\.json`), o)
})

// DL3: a null session id groups per FILE (every id-less session writes the same header).
const DL3 = lazy('DL3', () => {
  const { dl } = DL2()
  const dir = ledger(dl)
  slotFile(dir, 'slot-03.json', slot(null, 3, 'x', fieldsStd, 0, [dlLoop('main', ['m'], [], 0, u, [])]))
  slotFile(dir, 'slot-04.json', slot(null, 4, 'y', fieldsStd, 0, [dlLoop('main', ['m'], [], 0, u, [])]))
  return invokeRetro(dl, ['--delegations'])
})
t('DL3 two null-id files stay two sessions', () => {
  const o = DL3().out
  ok(has(o, String.raw`4 slot file\(s\), 3 session\(s\)`) && has(o, String.raw`session \(no session id\) slot-03\.json`) && has(o, String.raw`session \(no session id\) slot-04\.json`), o)
})

// DL4: usage errors — the report takes no range and does not combine with --coverage.
const DL4 = lazy('DL4', () => {
  DL3() // the order of the pwsh suite: the two null-id slot files exist when the usage errors run
  const { dl } = DL1()
  return { r: invokeRetro(dl, ['--delegations', 'HEAD~1..HEAD']), rb: invokeRetro(dl, ['--delegations', '--coverage']) }
})
t('DL4 --delegations with a range or --coverage is a usage error (exit 2)', () => {
  const { r, rb } = DL4(); ok(r.code === 2 && rb.code === 2 && has(r.out, 'takes no range'), `range exit=${r.code}, coverage exit=${rb.code}: ${r.out}`)
})

// DL5: unknown effort on both sides is no inherit signature (a Haiku main loop sends none); a session
// with no main loop is counted apart; a directory at a slot name is named as skipped.
const DL5 = lazy('DL5', () => {
  const dl5 = newLedgerRoot('delegations-5')
  const dir = ledger(dl5)
  // A teammate (2.1.289+) is written as an agent-tool loop whose spawn row says teammate: true.
  const mate = { subagent_type: 'researcher', model_param: null, model: 'claude-sonnet-5-5', teammate: true }
  // Controls: `teammate: false` (every non-teammate spawn the 0.62.1 writer emits) and a non-boolean "true"
  // stay agent-tool — the reader re-kinds on the boolean true only.
  const notMate = { subagent_type: 'Explore', model_param: null, model: 'claude-haiku-4-5', teammate: false }
  const strMate = { subagent_type: 'Plan', model_param: null, model: 'claude-haiku-4-5', teammate: 'true' }
  const loops5 = [
    dlLoop('main', ['claude-haiku-4-5'], [], 0, u, []),
    dlLoop('unspawned', ['claude-haiku-4-5'], [], 0, u, []),
    dlLoop('agent-tool', ['claude-sonnet-5-5'], ['high'], 0, u, [], mate),
    dlLoop('agent-tool', ['claude-haiku-4-5'], [], 0, u, [], notMate),
    dlLoop('agent-tool', ['claude-haiku-4-5'], [], 0, u, [], strMate),
  ]
  slotFile(dir, 'slot-00.json', slot('haiku-main', 0, 'a', fieldsStd, 0, loops5))
  slotFile(dir, 'slot-01.json', slot('no-main', 1, 'b', fieldsStd, 0, [dlLoop('unspawned', ['m'], ['low'], 0, u, [])]))
  fs.mkdirSync(path.join(dir, 'slot-02.json'), { recursive: true })
  return { dl5, r: invokeRetro(dl5, ['--delegations']) }
})
t('DL5 an effort-less main and worker on one model: on the main model, NOT at its effort', () => {
  ok(has(DL5().r.out, String.raw`ADR 0117 D6: 1 unspawned loop\(s\) on their session's main model in 1 session\(s\); 0 also at`), DL5().r.out)
})
t('DL5 the no-main session\'s worker is counted apart', () => {
  const o = DL5().r.out
  ok(has(o, 'not attributed: 0 with spawn rows evicted .*1 in a session with no main loop recorded') && has(o, 'session no-main .* main: no main loop recorded'), o)
})
t('DL5 a directory at a slot name is skipped and named', () => { ok(has(DL5().r.out, String.raw`skipped: slot-02\.json \(not a regular file\)`), DL5().r.out) })
t('DL5 a teammate spawn row reads as its own teammate row, never agent-tool', () => {
  const o = DL5().r.out; ok(has(o, String.raw`teammate researcher \(model_param none\) · claude-sonnet-5-5 · high`) && !has(o, 'agent-tool researcher'), o)
})
t('DL5 teammate false and a non-boolean "true" stay agent-tool rows', () => {
  const o = DL5().r.out
  ok(has(o, String.raw`agent-tool Explore \(model_param none\)`) && has(o, String.raw`agent-tool Plan \(model_param none\)`) && !has(o, 'teammate (Explore|Plan)'), o)
})

// DL7: workflow loops (2.1.292+, ADR 0126). Only the unnamed-type worker with no model given counts, and
// the count must not follow the resolved model: the counted one runs on sonnet (not main's opus), while a
// worker given `opus` runs on main's model and a named type with no model given (it may pin) is not
// counted either. Two counted loops against one on main's model: a model-equality rule reads 1, not 2.
// The unspawned control keeps its old line.
const wf = (type, modelParam, model, runId, idx) => ({ subagent_type: type, model_param: modelParam, model, teammate: false, workflow: { run_id: runId, agent_index: idx } })
const wfNone = wf('workflow-subagent', null, 'claude-sonnet-5-5', 'wf_a', 2)
const DL7 = lazy('DL7', () => {
  const dl7 = newLedgerRoot('delegations-7')
  const wfGiven = wf('workflow-subagent', 'haiku', 'claude-haiku-4-5', 'wf_a', 1)
  const wfNone2 = wf('workflow-subagent', null, 'claude-sonnet-5-5', 'wf_b', 1)
  const wfOnMain = wf('workflow-subagent', 'opus', 'claude-opus-5-5', 'wf_a', 3)
  const wfNamed = wf('ywr-harness:mech', null, 'claude-haiku-4-5', 'wf_a', 4)
  const loops7 = [
    dlLoop('main', ['claude-opus-5-5'], ['xhigh'], 0, u, []),
    dlLoop('workflow', ['claude-haiku-4-5'], [], 0, u, [], wfGiven),
    dlLoop('workflow', ['claude-sonnet-5-5'], ['low'], 0, u, [], wfNone),
    dlLoop('workflow', ['claude-sonnet-5-5'], ['low'], 0, u, [], wfNone2),
    dlLoop('workflow', ['claude-opus-5-5'], ['low'], 0, u, [], wfOnMain),
    dlLoop('workflow', ['claude-haiku-4-5'], [], 0, u, [], wfNamed),
    dlLoop('unspawned', ['claude-opus-5-5'], ['xhigh'], 0, u, []),
  ]
  slotFile(ledger(dl7), 'slot-00.json', slot('wf-sess', 0, 'a', fieldsStd, 0, loops7))
  return invokeRetro(dl7, ['--delegations']).out
})
t('DL7 workflow rows name their type and model_param, ordered before unspawned', () => {
  const o = DL7()
  ok(has(o, String.raw`workflow workflow-subagent \(model_param haiku\) · claude-haiku-4-5`) && has(o, String.raw`workflow workflow-subagent \(model_param none\) · claude-sonnet-5-5 · low`) && has(o, String.raw`workflow ywr-harness:mech \(model_param none\) · claude-haiku-4-5`), o)
})
t('DL7 D6 counts the workflow loops with no model given and no type named, per session and in the summary', () => {
  const o = DL7(); ok(has(o, 'workflow with no model given: 2 of 5') && has(o, String.raw`ADR 0126 D6: 2 of 5 workflow loop\(s\) with no model given in 1 session\(s\)`), o)
})
t('DL7 the unspawned heuristic is unchanged and workflow loops stay out of it', () => {
  ok(has(DL7(), String.raw`ADR 0117 D6: 1 unspawned loop\(s\) on their session's main model in 1 session\(s\); 1 also at the main loop's effort`), DL7())
})
t('DL7 workflow sorts after main and before unspawned', () => {
  const o = DL7()
  ok(o.indexOf('workflow workflow-subagent') < o.indexOf('   unspawned ·') && o.indexOf('   main ·') < o.indexOf('workflow workflow-subagent'), o)
})

// DL8: malformed workflow rows. A list `model_param` was an unhashable row key and a number beside a
// string broke the row sort, so each was a traceback; an empty `model_param` counted as an inherit. A
// non-string or empty value reads as "?" and never counts as an inherit. A null spawn and a missing type stay "?" rows. The one well-formed inherit still counts, and
// a step_fields entry that is not a string makes the file a named skip, not a zip over a list key.
const DL8 = lazy('DL8', () => {
  const dl8 = newLedgerRoot('delegations-8')
  const wfList = wf('workflow-subagent', ['opus'], 'claude-opus-5-5', 'wf_m', 1)
  const wfNum = wf('workflow-subagent', 5, 'claude-sonnet-5-5', 'wf_m', 2)
  const wfNumType = wf(7, null, 'claude-sonnet-5-5', 'wf_m', 3)
  const wfNoType = wf('x', null, 'claude-sonnet-5-5', 'wf_m', 4)
  delete wfNoType.subagent_type
  const wfEmpty = wf('workflow-subagent', '', 'claude-sonnet-5-5', 'wf_m', 5)
  const loops8 = [
    dlLoop('main', ['claude-opus-5-5'], ['xhigh'], 0, u, []),
    dlLoop('workflow', ['claude-opus-5-5'], ['low'], 0, u, [], wfList),
    dlLoop('workflow', ['claude-sonnet-5-5'], ['low'], 0, u, [], wfNum),
    dlLoop('workflow', ['claude-sonnet-5-5'], ['low'], 0, u, [], wfNone),
    dlLoop('workflow', ['claude-sonnet-5-5'], ['low'], 0, u, [], wfNumType),
    dlLoop('workflow', ['claude-sonnet-5-5'], ['low'], 0, u, [], wfNoType),
    dlLoop('workflow', ['claude-sonnet-5-5'], ['low'], 0, u, [], wfEmpty),
    dlLoop('workflow', ['claude-sonnet-5-5'], ['low'], 0, u, []),
    dlLoop('agent-tool', ['claude-haiku-4-5'], [], 0, u, [], { subagent_type: 'Explore', model_param: ['x'], model: 'claude-haiku-4-5' }),
  ]
  slotFile(ledger(dl8), 'slot-00.json', slot('bad-wf', 0, 'a', fieldsStd, 0, loops8))
  slotFile(ledger(dl8), 'slot-01.json', slot('bad-fields', 1, 'b', [['index']], 0, [dlLoop('main', ['m'], [], 0, null, [[1]])]))
  return invokeRetro(dl8, ['--delegations'])
})
t('DL8 malformed spawn fields exit 0 with no traceback', () => { const r = DL8(); ok(r.code === 0 && !has(r.out, 'Traceback'), `exit=${r.code}: ${r.out}`) })
t('DL8 a list, numeric or empty model_param reads as "?" on a workflow and an agent-tool row', () => {
  const o = DL8().out
  ok(has(o, String.raw`workflow workflow-subagent \(model_param \?\) · claude-opus-5-5 · low`) && has(o, String.raw`workflow workflow-subagent \(model_param \?\) · claude-sonnet-5-5 · low — 2 loop`) && has(o, String.raw`agent-tool Explore \(model_param \?\)`), o)
})
t('DL8 a numeric type, a missing type and a null spawn are one "?" row of three loops', () => { ok(has(DL8().out, String.raw`workflow \? \(model_param none\) · claude-sonnet-5-5 · low — 3 loop`), DL8().out) })
t('DL8 only the well-formed unnamed worker with no model counts: 1 of 7', () => {
  const o = DL8().out; ok(has(o, 'workflow with no model given: 1 of 7') && has(o, String.raw`ADR 0126 D6: 1 of 7 workflow loop\(s\)`), o)
})
t('DL8 a non-string step_fields entry skips its file, named', () => {
  const o = DL8().out; ok(has(o, String.raw`skipped: slot-01\.json \(not a schema 2 slot\)`) && !has(o, 'session bad-fields'), o)
})

// DL9: resumes (ADR 0147 counts them on the spawn row, ADR 0171 reports them). A loop carries the spawn row as
// it stood when the loop ended, so an agent resumed twice leaves three loops that read 0, 1 and 2: the count of
// an agent is the MAXIMUM over its loops (2), never the sum (3). Agent a1 (0, 1, 2) and agent a2 (1) give the
// row `3 resume(s)`. Agent a3 resumes once on sonnet and again on haiku: its loops land in TWO rows (the row
// key holds the models), and its maximum 2 is credited once, to the row of the loop that holds it, never 1 + 2.
// Loops with no string agent_id cannot be matched, so each adds its own value. A zero, a
// missing field, a string, a negative number and a boolean all read 0 through _count(), so those rows print
// exactly what they printed before.
const DL9 = lazy('DL9', () => {
  const dl9 = newLedgerRoot('delegations-9')
  const dl9Spawn = (type, resumes) => ({ subagent_type: type, model_param: null, model: 'claude-sonnet-5-5', ...(resumes === undefined ? {} : { resumes }) })
  const dl9Loop = (type, resumes, agentId = null, models = ['claude-sonnet-5-5']) => dlLoop('agent-tool', models, ['high'], 0, u, [], dl9Spawn(type, resumes), 0, agentId)
  const loops9 = [
    dlLoop('main', ['claude-opus-5-5'], ['xhigh'], 0, u, []),
    dl9Loop('ywr-harness:worker', 0, 'a1'),
    dl9Loop('ywr-harness:worker', 1, 'a1'),
    dl9Loop('ywr-harness:worker', 2, 'a1'),
    dl9Loop('ywr-harness:worker', 1, 'a2'),
    dl9Loop('Split', 1, 'a3'),
    dl9Loop('Split', 2, 'a3', ['claude-haiku-4-5']),
    dl9Loop('Loose', 1),
    dl9Loop('Loose', 1, 7),
    dl9Loop('Zero', 0),
    dl9Loop('Absent', undefined),
    dl9Loop('Str', '3'),
    dl9Loop('Neg', -2),
    dl9Loop('Bool', true),
  ]
  slotFile(ledger(dl9), 'slot-00.json', slot('resumed', 0, 'a', fieldsStd, 0, loops9))
  return invokeRetro(dl9, ['--delegations'])
})
t('DL9 a row prints the maximum per agent id, summed over agents (a1 max 2 + a2 1), after the loop count', () => {
  const r = DL9(); ok(r.code === 0 && has(r.out, String.raw`agent-tool ywr-harness:worker \(model_param none\) · claude-sonnet-5-5 · high — 4 loop\(s\), 3 resume\(s\), 6\.0 s, tokens`), r.out)
})
t('DL9 an agent split over two rows by its model is credited once: 2 resumes on the haiku row, none on the sonnet row', () => {
  const o = DL9().out
  ok(has(o, String.raw`agent-tool Split \(model_param none\) · claude-haiku-4-5 · high — 1 loop\(s\), 2 resume\(s\), 1\.5 s`) && has(o, String.raw`agent-tool Split \(model_param none\) · claude-sonnet-5-5 · high — 1 loop\(s\), 1\.5 s`), o)
})
t('DL9 loops with no string agent_id (null, a number) cannot be matched: each adds its own value', () => {
  ok(has(DL9().out, String.raw`agent-tool Loose \(model_param none\) · claude-sonnet-5-5 · high — 2 loop\(s\), 2 resume\(s\), 3\.0 s`), DL9().out)
})
t('DL9 a zero, an absent, a string, a negative and a boolean count read 0 and print no resume text', () => {
  const o = DL9().out
  ok(has(o, String.raw`agent-tool Zero \(model_param none\) · claude-sonnet-5-5 · high — 1 loop\(s\), 1\.5 s`) && has(o, String.raw`agent-tool Absent .* — 1 loop\(s\), 1\.5 s`) &&
    has(o, String.raw`agent-tool Str .* — 1 loop\(s\), 1\.5 s`) && has(o, String.raw`agent-tool Neg .* — 1 loop\(s\), 1\.5 s`) && has(o, String.raw`agent-tool Bool .* — 1 loop\(s\), 1\.5 s`) &&
    (o.match(/resume\(s\)/giu) ?? []).length === 3, o)
})
t('DL2 control: a ledger with no resumes prints no resume text anywhere', () => { ok(!has(DL2().r.out, 'resume'), DL2().r.out) })

// --- SZ: SIZE — an in-scope file that CROSSES 1,000 lines in the checked range (ADR 0171) ---------
// Three fixture repos and a dozen runs, on purpose: each retro run costs ~0.5 s of this suite's wall time.
// SZ1 pins the boundary both ways: 999 -> 1000 reports (post >= limit), 1000 -> 1001 stays silent (the
// crossing is pre < limit, a file already over never reports again). A `>` for `>=` on the post side
// turns the 1000 run red, a `<=` for `<` on the pre side turns the 1001 run red.
const lines = (n) => 'x = 1\n'.repeat(n)
function invokeRetroTraced(repo, extra) {
  // GIT_TRACE logs every git process the run starts; the speed rule is asserted from it (SZ7).
  const tr = path.join(fxBase, 'sz-trace.log')
  fs.rmSync(tr, { force: true })
  const r = invokeRetro(repo, extra, { GIT_TRACE: tr })
  r.trace = fs.existsSync(tr) ? fs.readFileSync(tr, 'utf8') : ''
  fs.rmSync(tr, { force: true })
  return r
}
const SZ1 = lazy('SZ1', () => {
  const sz = newRepo('size', CFG)
  writeF(sz, 'src/big.py', lines(999))
  commit(sz, 'chore: c0 999 lines')
  const szC0 = gitOut(sz, ['rev-parse', 'HEAD'])
  const rSZ1a = invokeRetroTraced(sz, [])
  // c1: 1000 lines, plus a binary file of 2000 newlines (a NUL in its first bytes) that must never report.
  const szBin = Buffer.from(lines(2000), 'ascii'); szBin[3] = 0
  writeF(sz, 'src/big.py', lines(1000))
  fs.writeFileSync(path.join(sz, 'src/blob.py'), szBin)
  commit(sz, 'chore: c1 1000 lines and a binary file')
  const rSZ1b = invokeRetroTraced(sz, [])
  git(sz, ['tag', 'szmark'])
  writeF(sz, 'src/big.py', lines(1001))
  commit(sz, 'chore: c2 1001 lines')
  const rSZ1c = invokeRetro(sz)
  // SZ2: a post rev that is not HEAD asks git for both ends. c2 is HEAD, so the tag `szmark` (= c1) is a
  // non-HEAD post: c0..szmark reports at c1 (binary skipped through git's -I too). c0.. ends at HEAD, where
  // the file holds 1001 lines and 999 before: it crosses within the range, still reported.
  const rSZ2a = invokeRetro(sz, [`${szC0}..szmark`])
  const rSZ2b = invokeRetro(sz, [`${szC0}..`])
  // The file shrinks again: the same range from c0 now ends under the limit and is silent.
  writeF(sz, 'src/big.py', lines(5))
  commit(sz, 'chore: c3 shrinks it')
  const rSZ2c = invokeRetro(sz, [`${szC0}..HEAD`])
  // A bare rev has no start to compare (git diffs it against the working tree, and the retro reads that rev as
  // the post side): SIZE skips it. Without the skip this run reports big.py as crossing at the old rev.
  const rSZ2d = invokeRetro(sz, ['szmark'])
  return { rSZ1a, rSZ1b, rSZ1c, rSZ2a, rSZ2b, rSZ2c, rSZ2d, rSZ8c: invokeRetro(sz, ['--coverage']) }
})
t('SZ1 999 lines is SILENT', () => { ok(!has(SZ1().rSZ1a.out, 'SIZE:'), SZ1().rSZ1a.out) })
t('SZ1 999 -> 1000 lines reports the crossing with the new count', () => { ok(has(SZ1().rSZ1b.out, String.raw`SIZE: src/big\.py crossed 1,000 lines \(now 1,000\)`), SZ1().rSZ1b.out) })
t('SZ1 1000 -> 1001 is SILENT: a file already over before the range never reports', () => { ok(!has(SZ1().rSZ1c.out, 'SIZE:'), SZ1().rSZ1c.out) })
t('SZ1 stays advisory (exit 0)', () => { ok(SZ1().rSZ1b.code === 0, `exit=${SZ1().rSZ1b.code}`) })
t('SZ4 a binary file reports no SIZE on the HEAD path (fixture: UNMAPPED saw it)', () => {
  const o = SZ1().rSZ1b.out; ok(has(o, String.raw`UNMAPPED: new file src/blob\.py`) && !has(o, 'SIZE: src/blob'), o)
})

// SZ7: the speed rule. The 999-line commit touches no large file: NO git grep and NO numstat. The commit
// that crosses starts both.
t('SZ7 fixture: the trace saw both retro runs', () => {
  const { rSZ1a, rSZ1b } = SZ1(); ok(has(rSZ1a.trace, 'diff-tree') && has(rSZ1b.trace, 'diff-tree'), `A: ${rSZ1a.trace}`)
})
t('SZ7 a commit with no large file starts no git grep and no numstat', () => {
  const tr = SZ1().rSZ1a.trace; ok(!has(tr, String.raw`\bgrep\b`) && !has(tr, 'numstat'), tr)
})
t('SZ7 a commit with a large file starts both', () => {
  const tr = SZ1().rSZ1b.trace; ok(has(tr, String.raw`\bgrep\b`) && has(tr, 'numstat'), tr)
})

t('SZ2 a range ending at a tag reports the crossing at that rev (git prints the tag as the prefix)', () => { ok(has(SZ1().rSZ2a.out, String.raw`SIZE: src/big\.py crossed 1,000 lines \(now 1,000\)`), SZ1().rSZ2a.out) })
t('SZ2 the binary file is skipped through git on a non-HEAD post rev', () => {
  const o = SZ1().rSZ2a.out; ok(has(o, String.raw`UNMAPPED: new file src/blob\.py`) && !has(o, 'SIZE: src/blob'), o)
})
t('SZ2 the open range X.. ends at HEAD and reports the crossing with the count at HEAD', () => { ok(has(SZ1().rSZ2b.out, String.raw`SIZE: src/big\.py crossed 1,000 lines \(now 1,001\)`), SZ1().rSZ2b.out) })
t('SZ2 shrunk again at HEAD, c0..HEAD is silent', () => { ok(!has(SZ1().rSZ2c.out, 'SIZE:'), SZ1().rSZ2c.out) })
t('SZ2 a bare rev (no start) skips SIZE', () => { const r = SZ1().rSZ2d; ok(r.code === 0 && !has(r.out, 'SIZE:'), r.out) })
t('SZ8 with no in-scope file at or over the limit --coverage prints a none line (the binary file is not listed)', () => { ok(has(SZ1().rSZ8c.out, 'files at or over 1,000 lines: none'), SZ1().rSZ8c.out) })

// SZ3: a file ADDED at 1500 lines counts 0 before; a name with a space is read whole. In the next commit
// git detects three renames (ADR 0188): a 1200-line file moves INTO scope, an in-scope 1000-line file moves,
// and a 900-line file moves and grows to 1100. A rename counts its old path's lines before, so only the
// growth reports. The 1500-line file is deleted (a deleted file never reports). The repo sets every color
// key that `hc.GIT_PINS` pins to `always` (dist #14): without the pins, git grep prints ESC codes before
// each path, and SZ3 and SZ8 go red. The other keys guard a later caller; on git 2.53 no other parsed
// command colors its output. The keys go into the repo's config file in one write, and one git read
// asserts that each took, so a failed write cannot weaken the anchor unseen (twelve `git config` calls
// cost ~0.85 s).
const SZ3 = lazy('SZ3', () => {
  const sz3 = newRepo('size-added', CFG)
  const colors = ['ui', 'grep', 'diff', 'status', 'branch', 'showBranch']
  fs.appendFileSync(path.join(sz3, '.git', 'config'), `[color]\n${colors.map((c) => `\t${c} = always\n`).join('')}`)
  const read = git(sz3, ['config', '--get-regexp', '^color\\.']).stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  const missing = colors.filter((c) => !read.includes(`color.${c.toLowerCase()} always`))
  writeF(sz3, 'src/my big file.py', lines(1500))
  writeF(sz3, 'src/edge.py', lines(1000))
  writeF(sz3, 'src/under.py', lines(999))
  writeF(sz3, 'tools/moved.py', lines(1200))
  writeF(sz3, 'other/huge.txt', lines(3000))
  writeF(sz3, 'src/grow.py', 'g = 7\n'.repeat(900)) // its own content, so git pairs its rename alone
  commit(sz3, 'chore: add files of several sizes')
  const rSZ3 = invokeRetro(sz3)
  // SZ8: --coverage lists each tracked in-scope file at or over the limit with its count, biggest first.
  const rSZ8 = invokeRetro(sz3, ['--coverage'])
  const at = rSZ8.out.indexOf('-- files at or over')
  if (at < 0) throw new Error(`no '-- files at or over' section in: ${rSZ8.out}`)
  git(sz3, ['mv', 'tools/moved.py', 'src/moved.py'])
  git(sz3, ['mv', 'src/edge.py', 'src/edge2.py'])
  git(sz3, ['mv', 'src/grow.py', 'src/grown.py'])
  writeF(sz3, 'src/grown.py', 'g = 7\n'.repeat(1100))
  git(sz3, ['rm', '-q', 'src/my big file.py'])
  commit(sz3, 'chore: move three files, grow one, delete another')
  return { read, missing, rSZ3, rSZ8, list: rSZ8.out.slice(at), rSZ3b: invokeRetro(sz3) }
})
t('SZ3 fixture: every pinned color key reads back as always', () => { const { missing, read } = SZ3(); ok(missing.length === 0, `missing: ${missing.join(', ')} · read: ${read.join('; ')}`) })
t('SZ3 an added 1500-line file reports, a name with a space whole', () => { ok(has(SZ3().rSZ3.out, String.raw`SIZE: src/my big file\.py crossed 1,000 lines \(now 1,500\)`), SZ3().rSZ3.out) })
t('SZ3 a file at exactly 1000 reports, one at 999 and an out-of-scope one never do', () => {
  const o = SZ3().rSZ3.out
  ok(has(o, String.raw`SIZE: src/edge\.py crossed 1,000 lines \(now 1,000\)`) && !has(o, String.raw`SIZE: src/under\.py`) && !has(o, String.raw`SIZE: [^\n]*(huge|moved)\.`), o)
})
t('SZ8 --coverage lists the two in-scope files at or over 1,000 lines with their counts', () => {
  const { list, rSZ8 } = SZ3()
  ok(has(list, String.raw`tracked at HEAD\): 2`) && has(list, String.raw`src/my big file\.py\t1,500`) && has(list, String.raw`src/edge\.py\t1,000`), rSZ8.out)
})
t('SZ8 and lists neither the 999-line file nor the out-of-scope ones; the larger file comes first', () => {
  const { list, rSZ8 } = SZ3()
  ok(!has(list, String.raw`under\.py`) && !has(list, String.raw`huge\.txt`) && !has(list, String.raw`moved\.py`) && list.indexOf('my big file') < list.indexOf('edge.py'), rSZ8.out)
})
t('SZ3 a rename alone never reports, into scope or within it (ADR 0188)', () => { ok(!has(SZ3().rSZ3b.out, String.raw`SIZE: src/(moved|edge2)\.py`), SZ3().rSZ3b.out) })
t('SZ3 a renamed file that grows across the limit reports, counted from its old path', () => { ok(has(SZ3().rSZ3b.out, String.raw`SIZE: src/grown\.py crossed 1,000 lines \(now 1,100\)`), SZ3().rSZ3b.out) })
t('SZ3 the deleted file never reports', () => { ok(!has(SZ3().rSZ3b.out, 'my big file'), SZ3().rSZ3b.out) })

// SZ5: the HEAD path is a pre-filter, git has the last word. a.py: HEAD's blob holds 999 lines while the
// working tree holds 1200 (a retro with no exact confirm would print "now 1,200"). b.py names the residual
// (spec 0007 §3.4): HEAD holds 1000 (a real crossing), an unstaged edit shortened the file, and it stays hidden.
const SZ5 = lazy('SZ5', () => {
  const sz5 = newRepo('size-worktree', CFG)
  writeF(sz5, 'src/a.py', lines(5))
  commit(sz5, 'chore: small')
  writeF(sz5, 'src/a.py', lines(999))
  writeF(sz5, 'src/b.py', lines(1000))
  commit(sz5, 'chore: 999 and 1000 at HEAD')
  writeF(sz5, 'src/a.py', lines(1200))
  writeF(sz5, 'src/b.py', lines(10))
  return invokeRetro(sz5)
})
t('SZ5 fixture: the run saw the commit (UNMAPPED names b.py)', () => { ok(has(SZ5().out, String.raw`UNMAPPED: new file src/b\.py`), SZ5().out) })
t('SZ5 a working tree over the limit above a HEAD blob under it is no crossing', () => { ok(!has(SZ5().out, String.raw`SIZE: src/a\.py`), SZ5().out) })
t('SZ5 residual: an unstaged edit that shortens the file hides its crossing', () => { ok(!has(SZ5().out, String.raw`SIZE: src/b\.py`), SZ5().out) })

// SZ6: an empty source_scope disables SIZE with the other scope checks (the K fixture declares none).
const SZ6 = lazy('SZ6', () => {
  const { k } = K()
  writeF(k, 'src/big.py', lines(1500))
  commit(k, 'chore: big, no scope')
  return invokeRetro(k)
})
t('SZ6 an empty scope disables SIZE', () => { ok(!has(SZ6().out, 'SIZE:'), SZ6().out) })

// DL6: SLICE_RETRO=0 skips the per-commit run, never an explicit --delegations request (ADR 0120).
const DL6 = lazy('DL6', () => {
  const { dl5 } = DL5()
  const env = { SLICE_RETRO: '0' }
  return {
    r: invokeRetro(dl5, ['--delegations'], env), ra: invokeRetro(dl5, ['--deleg'], env),
    rb: invokeRetro(dl5, ['--delegations', 'HEAD~1..HEAD'], env), rc: invokeRetro(dl5, ['--coverage'], env),
  }
})
t('DL6 under SLICE_RETRO=0 the report still prints and the usage error still fires', () => {
  const { r, rb } = DL6(); ok(has(r.out, 'ADR 0117 D6:') && rb.code === 2, `exit=${rb.code}: ${r.out}`)
})
t('DL6 an abbreviated flag (--deleg, argparse prefix) is the same request', () => { ok(has(DL6().ra.out, 'ADR 0117 D6:'), DL6().ra.out) })
t('DL6 control: SLICE_RETRO=0 still silences --coverage', () => { const { rc } = DL6(); ok(rc.code === 0 && !rc.out.trim(), rc.out) })

// --- scenario workers (O207) ---------------------------------------------------------------------
// One group is the scenarios that must run in ONE worker, in this order: each needs the repo of an earlier one
// (I and K read the G repo, SZ6 changes the K repo, DL2 to DL4 grow one ledger, DL6 reads the DL5 ledger, Q runs
// on the P2 repo). The groups are listed longest first, so the pool ends close together. Every scenario is in
// exactly one group, and the check below fails the run on a scenario that is in none or in two.
const GROUPS = [
  ['G', 'I', 'K', 'SZ6'], ['L'], ['F'], ['SZ1'], ['D'], ['P', 'Q'], ['E', 'CL'], ['B'], ['S'], ['SZ3'], ['R'],
  ['J'], ['C'], ['A'], ['O'], ['SZ5'],
  ['G4', 'H', 'N', 'D3', 'D7', 'D8', 'DL1', 'DL2', 'DL3', 'DL4', 'DL5', 'DL6', 'DL7', 'DL8', 'DL9'],
]
const POOL = innerJobs(6, 1)

function runGroup(names, seeds) {
  return new Promise((resolve) => {
    const failAll = (why) => resolve(Object.fromEntries(names.map((n) => [n, { error: why }])))
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { names, seeds }, env: SHARE_ENV })
    let got = null
    w.once('message', (m) => { got = m })
    w.once('error', (e) => failAll(`worker for ${names.join('+')} failed: ${e?.stack ?? e}`))
    w.once('exit', (code) => { if (got) resolve(got); else failAll(`worker for ${names.join('+')} exited ${code} with no result`) })
  })
}

if (!isMainThread) {
  for (const name of workerData.names) { try { scenarios.get(name).run() } catch { /* the stored state carries the error */ } }
  parentPort.postMessage(Object.fromEntries(workerData.names.map((n) => [n, scenarios.get(n).state()])))
}
