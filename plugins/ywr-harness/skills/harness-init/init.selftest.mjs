// Selftest for init.mjs — the scaffold writes into somebody's repo, so every terminal branch is
// enumerated here rather than trusted. The two that matter most are the ones a "it worked on my
// empty directory" check would never reach: a locally-edited TOOLCHAIN file must be reverted, and
// an existing SEED file must survive byte-identical. Getting those backwards either silently
// discards a repo's own CLAUDE.md or silently pins it to a stale builder.
// Usage: node --test-reporter=<file URL of ../../lib/selftest-reporter.mjs> --test-reporter-destination=stdout skills/harness-init/init.selftest.mjs
//
// Fixtures live under the system temp root and are removed when the process ends.
//
// A test with no case ID is named `IN<n> <name>`, so the parity check of ADR 0227 decision 8 matches the names.
// Patterns are regex sources (case-insensitive, `(?-i)` for a case-sensitive match; see toRx in
// lib/selftest-lib.mjs).
//
// How the cases share state: each chain of runs is a `section` (see below). Sections start together and
// share a small pool of child processes. A section that continues an earlier one awaits it. The tests run
// one at a time in the order written, after every section has settled. A test that reads a fixture that a
// later step of its chain changes reads a value that the section recorded at the right point instead
// (case R). A section that throws fails each test that needs it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, runNode, toRx, innerJobs, shortAlias } from '../../lib/selftest-lib.mjs'
import { git_result, git_absent, which_on_path } from '../../scripts/harness_git.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const WIN = process.platform === 'win32'
const R = String.raw
const init = path.join(here, 'init.mjs')
const templates = path.join(here, 'templates')
const pluginRoot = path.join(here, '..', '..')
const fxBase = fixtureRoot('harness-init-selftest')
process.on('exit', () => removeFixtureRoot(fxBase))

// --- small helpers -------------------------------------------------------------------------------------
// `m` matches case-insensitively and `cm` case-sensitively. toRx reads a leading `(?m)`.
const m = (s, rx) => toRx(rx).test(String(s ?? ''))
const cm = (s, rx) => toRx(`(?-i)${rx}`).test(String(s ?? ''))
const eqi = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
// Regex-escape a string, leaving white space alone, which a JavaScript pattern needs no escape for.
const esc = (s) => String(s).replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
// The number of matches of a pattern in a text, case-sensitive.
const countRx = (text, src, flags = 'g') => [...String(text).matchAll(new RegExp(src, flags))].length
const ok = (cond, detail = '') => assert.ok(cond, String(detail || 'condition was false'))

const ID_RX = /^[A-Z][A-Za-z]*\d+[a-z]*$/u
let inCount = 0
// A name with no case ID gets the next `IN<n>`. Every call counts, whatever the platform, so a number
// never moves between two machines.
const nm = (name) => (ID_RX.test(name.split(' ')[0]) ? name : `IN${++inCount} ${name}`)

// How the runs overlap. A `section` is one chain of init.mjs runs on its own fixture directory. Each section
// starts while the file is read, runs its children through a small pool, and keeps its value or its error. A
// chain that continues an earlier one (B after A, C after B) awaits the earlier section's `done`. A test waits
// until every section has settled, then reads the section's value synchronously, so a section that threw
// fails each test that needs it. Independent chains share no directory, no cwd and no environment, so
// they only trade wall time for load. A disabled section never starts (its tests carry the matching skip).
const POOL = innerJobs(6, 2)
let slots = POOL
const waiters = []
const acquire = () => (slots > 0 ? (slots--, Promise.resolve()) : new Promise((res) => waiters.push(res)))
const release = () => { const next = waiters.shift(); if (next) next(); else slots++ }
const sections = []
function section(fn, { enabled = true } = {}) {
  let state = enabled ? null : { e: new Error('section disabled on this platform') }
  const done = enabled
    ? Promise.resolve().then(fn).then((v) => { state = { v } }, (e) => { state = { e } })
    : Promise.resolve()
  sections.push(done)
  const get = () => {
    if (!state) throw new Error('section read before it settled')
    if ('e' in state) throw state.e
    return state.v
  }
  get.done = done
  return get
}
// A continuation reads the section it follows, waiting for it first; its error propagates.
const after = async (...secs) => { await Promise.all(secs.map((s) => s.done)); return secs.map((s) => s()) }
let settled
const allSettled = () => (settled ??= Promise.all(sections))
const T = (name, fn, opts = {}) => test(nm(name), opts, async () => { await allSettled(); return fn() })

const read = (p) => fs.readFileSync(p, 'utf8')
const write = (p, text) => fs.writeFileSync(p, text)
const mk = (p) => fs.mkdirSync(p, { recursive: true })
const exists = (p) => fs.existsSync(p)
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const stampOf = (dir) => read(path.join(dir, '.harness-version')).trim()
const rmQuiet = (p) => { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* fixture hygiene only */ } }
function target(name) {
  const p = path.join(fxBase, name)
  mk(p)
  return p
}
function listFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.push(p)
    }
  }
  walk(dir)
  return out
}

// The env of a child: the process env without NODE_TEST_CONTEXT (a nested `node` that inherits it from a
// `node --test` parent writes a stream for the parent) and with `extra` on top. On Windows names compare
// without case, so an extra key replaces a differently cased key of the same name.
// The git worker binary ahead of the cmd\git.exe launcher (ADR 0111). On Windows the PATH `git` is the launcher,
// which starts mingw64\bin\git.exe and waits, so each git call costs two processes. The init.mjs children inherit
// this PATH, so the git starts of init.mjs that do not go through harness_git.mjs take the short path too. Only
// the exact Git for Windows layout counts; any other shape leaves PATH alone.
function gitWorkerDir() {
  if (!WIN) return ''
  const exe = which_on_path('git')
  if (!exe || path.basename(path.dirname(exe)).toLowerCase() !== 'cmd') return ''
  const dir = path.join(path.dirname(path.dirname(exe)), 'mingw64', 'bin')
  return isFile(path.join(dir, 'git.exe')) ? dir : ''
}
const GIT_WORKER_DIR = gitWorkerDir()
function childEnv(extra = {}) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path')
  if (GIT_WORKER_DIR && pathKey) env[pathKey] = GIT_WORKER_DIR + path.delimiter + env[pathKey]
  for (const [k, v] of Object.entries(extra)) {
    if (WIN) for (const e of Object.keys(env)) if (e.toLowerCase() === k.toLowerCase()) delete env[e]
    env[k] = v
  }
  return env
}

// Child invocation (ADR 0220): init.mjs runs as a `node` child process, its stdout and stderr decoded
// as UTF-8 bytes. The returned shape is code, out and aborted:
//   code    — init.mjs's own exit code: 0 placed, 1 a guard refused or a write failed, 2 a usage error.
//   aborted — true with code -1 when the script never ran or crashed: the file is missing, the child
//             was stopped at the time bound, or it exited non-zero AND Node's uncaught-error report is on
//             stderr. That report always ends with a `Node.js vNN.N.N` line, whether the cause is a throw,
//             a rejected promise, a failed import or a syntax error, and init.mjs itself writes nothing
//             to stderr (Z0), so the trailer separates a crash from the verdict 1 that cases G, H and S1
//             accept as "refused as required" — an infrastructure failure can never pass as one of them.
//   out     — stdout, then stderr.
function settleChild(scriptPath, r) {
  if (r.error?.code === 'ETIMEDOUT') return { out: `child stopped after 300 s: ${scriptPath}`, code: -1, aborted: true }
  if (r.error || r.status === null) return { out: `child did not finish: ${r.error?.message ?? r.signal}`, code: -1, aborted: true }
  const out = r.stdout + r.stderr
  if (r.status !== 0 && /^Node\.js v\d+\.\d+\.\d+\s*$/mu.test(r.stderr)) return { out, code: -1, aborted: true }
  return { out, code: r.status, aborted: false }
}
function invokeNodeScript(scriptPath, nodeArgs = [], env = {}) {
  if (!isFile(scriptPath)) return { out: `script not found: ${scriptPath}`, code: -1, aborted: true }
  return settleChild(scriptPath, runNode([scriptPath, ...nodeArgs], { env: childEnv(env), timeoutMs: 300000 }))
}
// The same contract for a section: the child runs asynchronously, through the pool, so other sections go on while
// it works. The 300 s bound, the UTF-8 decode and the crash trailer are the sync form's.
async function invokeNodeScriptA(scriptPath, nodeArgs = [], env = {}) {
  if (!isFile(scriptPath)) return { out: `script not found: ${scriptPath}`, code: -1, aborted: true }
  await acquire()
  const t0 = performance.now()
  try {
    const r = await new Promise((resolve) => {
      const out = [], err = []
      let timedOut = false
      const child = spawn(process.execPath, [scriptPath, ...nodeArgs], { env: childEnv(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => { timedOut = true; child.kill() }, 300000)
      child.stdout.on('data', (d) => out.push(d))
      child.stderr.on('data', (d) => err.push(d))
      child.on('error', (error) => { clearTimeout(timer); resolve({ status: null, signal: null, stdout: '', stderr: '', error }) })
      child.on('close', (status, signal) => {
        clearTimeout(timer)
        resolve({
          status, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
          error: timedOut ? Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) : undefined,
        })
      })
    })
    // `elapsed` counts from the start of the child, after the wait for a pool slot, so a bound on a run is a bound on the child.
    return { ...settleChild(scriptPath, r), elapsed: (performance.now() - t0) / 1000 }
  } finally { release() }
}
// Call sites pass argv arrays such as ('-Target', x, '-DryRun'). This is the one place that maps them to
// init.mjs's flags: -DryRun -> --dry-run, -Target x -> --target=x. A switch takes no value. Any other name
// takes the next token, joined with '=' so a value that starts with '-' stays a value.
function convertToInitArgv(args) {
  const switches = ['DryRun', 'Force', 'AllowUpstreamAhead']
  const argv = []
  for (let i = 0; i < args.length; i++) {
    const nameM = /^-([A-Z][A-Za-z]*)$/u.exec(args[i])
    if (!nameM) throw new Error(`runInit: '${args[i]}' is not a -Name token`)
    const name = nameM[1]
    const flag = '--' + name.replace(/(?<=[a-z])(?=[A-Z])/gu, '-').toLowerCase()
    if (switches.includes(name)) { argv.push(flag); continue }
    if (i + 1 >= args.length) throw new Error(`runInit: '${args[i]}' has no value`)
    argv.push(`${flag}=${args[i + 1]}`); i++
  }
  return argv
}
const runInit = (args, script = init, env = {}) => invokeNodeScript(script, convertToInitArgv(args), env)
const runInitA = (args, script = init, env = {}) => invokeNodeScriptA(script, convertToInitArgv(args), env)

// `-Script` runs a COPY of init.mjs (cases H, R, X5, T8n, T8o, T8v rewrite the skill dir).
// A copy of the skill that can run: init.mjs imports ../../scripts/harness_git.mjs, so the copy sits at
// <fixture>/<name>/skills/harness-init beside <fixture>/<name>/scripts/harness_git.mjs, the plugin's shape.
// The selftests of the skill dir are left out of the copy: no case reads them.
function copySkill(name) {
  const root = path.join(fxBase, name)
  const dest = path.join(root, 'skills', 'harness-init')
  mk(path.dirname(dest))
  fs.cpSync(here, dest, { recursive: true, force: true, filter: (src) => !/\.selftest\.(mjs|ps1)$/u.test(src) })
  mk(path.join(root, 'scripts'))
  fs.copyFileSync(path.join(pluginRoot, 'scripts', 'harness_git.mjs'), path.join(root, 'scripts', 'harness_git.mjs'))
  return dest
}

// --- git helpers ---------------------------------------------------------------------------------------
// Every git call goes through harness_git.mjs, the one subprocess boundary, as the scripts under test do.
const GIT = !git_absent()
const NO_GIT = GIT ? false : 'git absent (reported, not silent) — CI has git'
function gitOk(dir, args) {
  const r = git_result(dir, args)
  if (r.status !== 0) throw new Error(`fixture git failed (exit ${r.status}): git ${args.join(' ')} in ${dir}: ${r.stderr}`)
  return r
}
// One `git init` and two config writes build a repository once; each target gets a copy of its .git folder, which is
// a real repository, so a fixture costs a copy and no git start.
let gitBase = ''
function newGitTarget(name) {
  if (!gitBase) {
    gitBase = path.join(fxBase, 'git-base')
    mk(gitBase)
    git_result(gitBase, ['init', '-q'])
    git_result(gitBase, ['config', 'user.email', 'selftest@example.invalid'])
    git_result(gitBase, ['config', 'user.name', 'selftest'])
  }
  const p = target(name)
  fs.cpSync(path.join(gitBase, '.git'), path.join(p, '.git'), { recursive: true })
  return p
}
function getHooksPath(repo) {
  const r = git_result(repo, ['config', '--local', '--get', 'core.hooksPath'])
  return r.status !== 0 ? '' : r.stdout.trim()
}
const hooksLine = (run) => run.out.split('\n').filter((l) => m(l, R`\bhooks:`)).join(' ')

// --- pwsh, for the one case that needs a PowerShell process ---------------------------------------------
// Case T6 holds a file open from pwsh, because Node cannot open a file without sharing. A Microsoft Store install puts pwsh on PATH only as an
// app execution alias: a reparse point under WindowsApps that stat cannot read (EACCES) and CreateProcess
// starts. which_on_path skips it, so on Windows such an alias `pwsh.exe` is accepted by its link entry.
function resolvePwsh() {
  const exe = which_on_path('pwsh')
  if (exe || !WIN) return exe
  for (let dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    dir = dir.trim().replace(/^"(.*)"$/u, '$1')
    if (!dir || !path.isAbsolute(dir)) continue
    const p = path.join(dir, 'pwsh.exe')
    try { if (fs.lstatSync(p).isSymbolicLink()) return p } catch { /* absent: keep looking */ }
  }
  return ''
}
const PWSH = resolvePwsh()
const NO_PWSH = PWSH ? false : 'pwsh absent (reported, not silent) — case T6 holds the file open from a pwsh process'
const psq = (s) => `'${String(s).replace(/'/gu, "''")}'`

// ======================================================================================================
// Z0: the contracts the child-process adapter rests on
// init.mjs reports through ONE writer, `say`, to stdout, and never to stderr. Node's own crash report is the
// only thing on stderr, so the crash trailer of invokeNodeScript can never be forged by init.mjs's own text.
const srcLines = read(init).split(/\r\n|\n|\r/u)
const srcCode = srcLines.map((line, i) => ({ n: i + 1, line })).filter((x) => x.line.trim() && !/^\/\//u.test(x.line.trim()))
const stderrUse = srcCode.filter((x) => /\bconsole\.(error|warn)\b|process\.stderr/u.test(x.line))
const stdoutUse = srcCode.filter((x) => /\bconsole\.log\b|process\.stdout/u.test(x.line))
T('Z0 init.mjs reports through one stdout writer and never to stderr (the crash-trailer contract)', () =>
  ok(stderrUse.length === 0 && stdoutUse.length === 1, `stderr lines: ${stderrUse.map((x) => x.n).join(', ')} · stdout lines: ${stdoutUse.map((x) => x.n).join(', ')}`))
// The verdict is the child's exit code, set once as process.exitCode. A process.exit() call would cut a piped
// stdout short and could end the run before the report is whole.
const procExit = srcCode.filter((x) => /process\.(exit|abort|reallyExit)\b/u.test(x.line))
T('Z0 init.mjs never calls a process-exit API (its exit code is its own verdict, set once)', () =>
  ok(procExit.length === 0, `lines: ${procExit.map((x) => x.n).join(', ')}`))
// A crash is NOT an exit code. No case reaches the crash path through init.mjs — every fallible step there ends
// in an explicit `return 1` — so drive it with scripts that crash, and with a path that does not exist: each must
// come back -1/aborted with the reason, never as the 1 that cases G, H and S1 accept as "refused as required".
const crashers = {
  'an uncaught throw': "throw new Error('boom from the fixture')\n",
  'a rejected promise': "await Promise.reject(new Error('boom from the fixture'))\n",
  'a failed import': "import './no-such-module.mjs'\nconsole.log('boom from the fixture')\n",
  'a syntax error': 'const boom from the fixture = [\n',
}
for (const [name, body] of Object.entries(crashers)) {
  T(`Z0n ${name} is an abort (code -1), not an exit code`, () => {
    const cf = path.join(fxBase, `crash-${name.replace(/\W+/gu, '-')}.mjs`)
    write(cf, body)
    const rc = runInit(['-Target', fxBase], cf)
    ok(rc.code === -1 && rc.aborted, `code=${rc.code} aborted=${rc.aborted} out=${rc.out}`)
  })
}
const thrower = path.join(fxBase, 'thrower.mjs')
T('Z0n a crash keeps its message', () => {
  write(thrower, "throw new Error('boom from the fixture')\n")
  const r = runInit(['-Target', fxBase], thrower)
  ok(m(r.out, 'boom from the fixture'), r.out)
})
T('Z0n a missing .mjs is an abort (code -1), not an exit code', () => {
  const r = runInit(['-Target', fxBase], path.join(fxBase, 'no-such-init.mjs'))
  ok(r.code === -1 && r.aborted && m(r.out, 'script not found'), `code=${r.code} out=${r.out}`)
})
// The verdicts stay codes: a script that exits 1 on purpose is code 1 and not an abort, even though it wrote to
// stderr; exit 2 and exit 0 are codes too. Only Node's own report makes an abort.
const verdict = path.join(fxBase, 'verdict.mjs')
for (const want of [0, 1, 2]) {
  T(`Z0n a deliberate exit ${want} is code ${want}, not an abort`, () => {
    write(verdict, "console.error('refused on purpose')\nprocess.exitCode = Number(process.argv[2])\n")
    const rv = invokeNodeScript(verdict, [String(want)])
    ok(rv.code === want && !rv.aborted, `code=${rv.code} aborted=${rv.aborted} out=${rv.out}`)
  })
}
// An unknown flag of the real script is a usage error (exit 2) with the usage line, and a value out of range is the same.
T('Z0n an unknown flag is a usage error (exit 2) naming it, not an abort', () => {
  const r = invokeNodeScript(init, ['--bogus'])
  ok(r.code === 2 && !r.aborted && m(r.out, R`Unknown option '--bogus'`) && m(r.out, R`usage: node init\.mjs`), `code=${r.code} out=${r.out}`)
})
for (const bad of ['0', '601', 'ten', '1.5']) {
  T(`Z0n --fetch-timeout-seconds ${bad} is refused as a usage error (exit 2), range 1..600`, () => {
    const r = runInit(['-Target', fxBase, '-FetchTimeoutSeconds', bad])
    ok(r.code === 2 && !r.aborted && m(r.out, R`from 1 to 600`), `code=${r.code} out=${r.out}`)
  })
}

// Code is the child's exit code; init.mjs sets it once, on its last statement — pin that statement so a trailing
// edit that drops it fails here by name.
const lastStmt = srcCode.at(-1).line
T('Z0 init.mjs ends by setting its verdict explicitly (Code is always its own verdict)', () =>
  ok(m(lastStmt, R`^process\.exitCode = await main\(\)\s*$`), `last statement: ${lastStmt}`))

// Every file init.mjs places. Hardcoded on purpose: deriving it from init.mjs's own tables would
// make the test agree with a typo in the thing it is testing.
const EXPECT = [
  'docs/README.md', 'docs/adr/README.md', 'docs/adr/0000-template.md',
  'docs/spec/README.md', 'docs/spec/0000-template.md',
  'docs/build.mjs', 'docs/build.sh', 'docs/build_docs.mjs', 'docs/check_docs.mjs',
  'CLAUDE.md', '.gitattributes', '.harness.json',
  // Root ignore seed (ADR 0053). No REVIEW.md: the starter review canon is a section of the seed CLAUDE.md (ADR 0217).
  '.gitignore',
  'docs/adr/0001-adopt-docs-as-code.md', // corpus seed — without it the builder has nothing to index
  // Vendored so a consuming repo's CI needs no access to the private canon (ADR 0014).
  'scripts/harness/harness_config.mjs', 'scripts/harness/harness_git.mjs', 'scripts/harness/harness_gates.mjs',
  'scripts/harness/verify_map.mjs', '.github/workflows/harness-gates.yml',
  'scripts/harness/.gitignore',
  // CI PR-base resolver (ADR 0043) — the vendored workflow invokes it via sh.
  'scripts/harness/resolve-base.sh',
  // Local execution layer (ADR 0015). Placement is asserted here; the WIRING branches are cases
  // K-O, and the hooks' own behaviour is githooks.selftest.mjs.
  '.githooks/pre-commit', '.githooks/pre-push',
  // Slice retro gate (ADR 0017). post-commit is GUARDED rather than TOOLCHAIN — cases Q1/Q2.
  'scripts/harness/harness_retro.mjs', '.githooks/post-commit', '.githooks/slice-retro-ignore',
  // Session-time decision notes (ADR 0172), named from the seeded CLAUDE.md.
  'scripts/harness/slice_note.mjs',
  // Stage prompts of the /ywr-harness:auto switch, declared by the template (ADR 0180).
  'docs/prompts/review-start.md', 'docs/prompts/ready-report.md',
]
const EXPECT_N = EXPECT.length
const manifestVer = JSON.parse(read(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))).version

// --- A: empty directory gets the whole shape ---------------------------------------------------------
const secA = section(async () => { const a = target('empty'); return { a, rA: await runInitA(['-Target', a]) } })
T('A exit 0 on an empty directory', () => { const { rA } = secA(); ok(rA.code === 0, `exit=${rA.code} out=${rA.out}`) })
T(`A all ${EXPECT_N} files placed`, () => {
  const { a } = secA()
  const missing = EXPECT.filter((f) => !isFile(path.join(a, f)))
  ok(missing.length === 0, `missing: ${missing.join(', ')}`)
})
T(`A reports created=${EXPECT_N}`, () => ok(m(secA().rA.out, R`created=${EXPECT_N}\b`), secA().rA.out))
// ADR 0217: the review canon is a section of the placed CLAUDE.md, the placed .harness.json declares that file as the
// canon, and no REVIEW.md is placed.
T('A no REVIEW.md is placed; the canon is a CLAUDE.md section that .harness.json declares', () => {
  const { a } = secA()
  const aClaude = read(path.join(a, 'CLAUDE.md'))
  const aDecl = JSON.parse(read(path.join(a, '.harness.json')))
  ok(!exists(path.join(a, 'REVIEW.md')) && m(aClaude, R`(?m)^## Review canon\s*$`) && eqi(aDecl.review?.canon, 'CLAUDE.md'),
    `REVIEW.md exists: ${exists(path.join(a, 'REVIEW.md'))}; canon=${aDecl.review?.canon}`)
})
T('A reports the hook wiring outcome', () => ok(m(secA().rA.out, 'hooks: '), secA().rA.out))
// ADR 0042: every successful run stamps which plugin version scaffolded the repo. Compared
// against plugin.json directly — a stamp that drifted from the manifest would misdirect the
// refresh nudge's direction verdict on every machine.
T('A stamp written with the plugin version', () => {
  const { a, rA } = secA()
  ok(isFile(path.join(a, '.harness-version')) && eqi(stampOf(a), manifestVer), `stamp missing or wrong; manifest=${manifestVer} out=${rA.out}`)
})
T('A stamp is reported', () => ok(m(secA().rA.out, R`stamp: \.harness-version`), secA().rA.out))
// Issue #52: the emitter claims the stamp built-in (ADR 0044), so the output must not tell a member to
// declare an entry for it in .harness.json groups.
T('A stamp line says claimed built-in, not claim-it-yourself', () => {
  const o = secA().rA.out
  ok(m(o, 'claimed built-in by the emitter') && !m(o, R`claim it in \.harness\.json groups`), o)
})
// The point of the corpus seed: a scaffolded repo must BUILD. Without a record the builder exits 1
// ("found no .md with frontmatter") and no tooling can query the repo's decisions.
// The build runs with the Node that runs init.mjs, so no tool lookup can skip it.
T('A build produced index.json', () => ok(isFile(path.join(secA().a, 'docs', 'index.json')), `out=${secA().rA.out}`))
T('A build reported, not skipped', () => ok(m(secA().rA.out, R`built: index\.json`), secA().rA.out))

// --- B: re-run is a no-op (idempotence) --------------------------------------------------------------
// The report must say unchanged, not "refreshed": a no-op counted as a refresh hides which files
// the canon actually changed on a real update.
const secB = section(async () => { const [{ a }] = await after(secA); return { rB: await runInitA(['-Target', a]) } })
T('B re-run exits 0', () => ok(secB().rB.code === 0, `exit=${secB().rB.code}`))
T('B re-run creates nothing', () => ok(m(secB().rB.out, 'created=0'), secB().rB.out))
T('B re-run refreshes nothing (identical content is not a refresh)', () => ok(m(secB().rB.out, 'refreshed=0'), secB().rB.out))

// --- C: an edited TOOLCHAIN file is reverted ---------------------------------------------------------
const secC = section(async () => {
  const [, { a }] = await after(secB, secA)
  write(path.join(a, 'docs', 'build_docs.mjs'), '# locally hacked')
  const rC = await runInitA(['-Target', a])
  cleanRevert(rC.out)
  return { rC }
})
T('C edited toolchain file is refreshed', () => ok(m(secC().rC.out, 'refreshed=1'), secC().rC.out))
T('C toolchain content matches canon after refresh', () =>
  ok(read(path.join(secA().a, 'docs', 'build_docs.mjs')) === read(path.join(templates, 'docs', 'build_docs.mjs')), 'builder still holds local edit'))
// C is a same-version re-run, so ADR 0067 makes it save a pre-revert copy in temp — parse the
// printed dir and clean it (the X cases own the block's assertions; this is fixture hygiene).
const cleanRevert = (out) => { const mm = /pre-revert copies: (.+)/u.exec(out); const dir = mm?.[1].trim(); if (dir && exists(dir)) rmQuiet(dir) }

// --- D: an existing SEED file survives byte-identical ------------------------------------------------
const mine = '# my own CLAUDE.md\nkeep me\n'
const mineReview = '# my own REVIEW.md\nhouse invariants\n'
// D2 reads this same run: one stage prompt exists, the other is absent (ADR 0180)
const minePrompt = '# my own ready-report prompt\nkeep me\n'
const secD = section(async () => {
  const d = target('seeded')
  write(path.join(d, 'CLAUDE.md'), mine)
  write(path.join(d, 'REVIEW.md'), mineReview)
  mk(path.join(d, 'docs', 'prompts'))
  write(path.join(d, 'docs', 'prompts', 'ready-report.md'), minePrompt)
  return { d, rD: await runInitA(['-Target', d]) }
})
T('D existing seeds reported preserved', () => ok(m(secD().rD.out, R`preserved=2\b`), secD().rD.out))
T('D existing seed is byte-identical afterwards', () => ok(read(path.join(secD().d, 'CLAUDE.md')) === mine, 'CLAUDE.md was modified'))
// The scaffold places no REVIEW.md (ADR 0217): the run neither counts nor touches one that an older scaffold seeded.
T('D an existing REVIEW.md is byte-identical afterwards and not counted as a preserved seed (ADR 0217)', () =>
  ok(read(path.join(secD().d, 'REVIEW.md')) === mineReview, 'REVIEW.md was modified'))
T('D preserved seed still warns the reader', () => ok(m(secD().rD.out, 'never clobber'), secD().rD.out))
// CLAUDE.md is deliberately OUTSIDE the drift probe (ADR 0051): it is placeholder prose a repo
// rewrites wholesale, so a note would be permanent noise. The seed shares zero lines with its
// template, and the run reads no REVIEW.md — a note here means the exclusion regressed.
T('D rewritten CLAUDE.md/REVIEW.md never carry a drift note', () => ok(!m(secD().rD.out, 'this seed lacks'), secD().rD.out))

// --- D2: the stage prompt seeds (ADR 0180) -----------------------------------------------------------
// Seeds: an existing file survives byte-identical, an absent one is placed, and the template
// declares both with no `check`, so the placed .harness.json turns the switch's stages on as soon as
// the member types `on`. No regex of `review.docs_only` exempts docs/prompts/. The declaration checks
// read the .harness.json this run PLACED, not the template, so a placement that rewrote it fails here.
// It reads case D's run, so it costs no init run of its own.
T('D2 an existing stage prompt is byte-identical afterwards (ADR 0180 - SEED)', () =>
  ok(read(path.join(secD().d, 'docs', 'prompts', 'ready-report.md')) === minePrompt, 'ready-report.md was modified'))
T('D2 the absent stage prompt is placed, equal to its template', () =>
  ok(read(path.join(secD().d, 'docs', 'prompts', 'review-start.md')) === read(path.join(templates, 'docs', 'prompts', 'review-start.md')), 'review-start.md missing or differs'))
T('D2 the placed .harness.json declares review-start and ready-report with their seed paths and no check', () => {
  const decl = JSON.parse(read(path.join(secD().d, '.harness.json')))
  const stages = Object.keys(decl.decision_prompts ?? {})
  const withCheck = Object.values(decl.decision_prompts ?? {}).filter((v) => Object.keys(v).some((k) => eqi(k, 'check')))
  ok(stages.length === 2 && decl.decision_prompts['review-start']?.prompt === 'docs/prompts/review-start.md' &&
    decl.decision_prompts['ready-report']?.prompt === 'docs/prompts/ready-report.md' && withCheck.length === 0, `stages=${stages.join(',')}`)
})
T('D2 review.docs_only exempts a doc and no prompt file, no placed script', () => {
  const decl = JSON.parse(read(path.join(secD().d, '.harness.json')))
  const docsOnly = decl.review.docs_only.map((p) => new RegExp(`^(?:${p})`, 'u'))
  const exempt = (p) => docsOnly.some((r) => r.test(p))
  ok(exempt('docs/adr/0002-x.md') && !exempt('docs/prompts/ready-report.md') && !exempt('docs/build_docs.mjs'), 'docs_only regex moved')
})

// --- E: content files are never touched --------------------------------------------------------------
// A repo's accumulated decisions are the one thing a re-runnable scaffold must not endanger.
const adrBody = '---\nid: "0001"\n---\n# 0001. a real decision\n'
const secE = section(async () => {
  const [, { a }] = await after(secC, secA)
  const adr =path.join(a, 'docs', 'adr', '0001-a-real-decision.md')
  write(adr, adrBody)
  return { adr, rE: await runInitA(['-Target', a]) }
})
T('E existing ADR still present', () => ok(isFile(secE().adr), 'ADR vanished'))
T('E existing ADR unmodified', () => ok(read(secE().adr) === adrBody, 'ADR content changed'))
T('E run exits 0', () => ok(secE().rE.code === 0, `exit=${secE().rE.code}`))

// --- F: dry run writes nothing -----------------------------------------------------------------------
const secF = section(async () => { const f = target('dry'); return { f, rF: await runInitA(['-Target', f, '-DryRun']) } })
T('F dry run exits 0', () => ok(secF().rF.code === 0, `exit=${secF().rF.code}`))
T('F dry run says so', () => ok(m(secF().rF.out, 'dry run'), secF().rF.out))
T('F dry run reports what it would create', () => ok(m(secF().rF.out, R`created=${EXPECT_N}\b`), secF().rF.out))
T('F dry run wrote no file', () => { const left = listFiles(secF().f); ok(left.length === 0, `wrote ${left.length} file(s)`) })
T('F dry run reports the stamp it would write', () => ok(m(secF().rF.out, R`stamp: would write \.harness-version`), secF().rF.out))

// --- G: unusable targets fail loudly -----------------------------------------------------------------
T('G1 missing target exits 1', () => { const r = runInit(['-Target', path.join(fxBase, 'does-not-exist')]); ok(r.code === 1, `exit=${r.code}`) })
T('G2 file-as-target exits 1', () => {
  const fileTarget = path.join(fxBase, 'i-am-a-file.txt')
  write(fileTarget, 'x')
  const r = runInit(['-Target', fileTarget])
  ok(r.code === 1, `exit=${r.code}`)
})

// --- H: a template missing from the plugin fails, and does not half-scaffold silently ----------------
// Runs a COPY of the skill with one template deleted; the real plugin is never modified.
const secH = section(async () => {
  const brokenSkill = copySkill('broken-skill')
  fs.rmSync(path.join(brokenSkill, 'templates', 'docs', 'build.sh'), { force: true })
  const h = target('broken')
  return await runInitA(['-Target', h], path.join(brokenSkill, 'init.mjs'))
})
T('H missing template exits 1', () => ok(secH().code === 1, `exit=${secH().code} out=${secH().out}`))
T('H missing template is named', () => ok(m(secH().out, 'template missing in plugin'), secH().out))

// --- I: an existing corpus suppresses the seed (no duplicate id 0001) --------------------------------
// The other half of the conditional seed. Placing it unconditionally would give a repo that already
// numbered its own 0001 two records claiming the same id.
const seedPath = (dir) => path.join(dir, 'docs', 'adr', '0001-adopt-docs-as-code.md')
const secI = section(async () => {
  const i = target('has-records')
  mk(path.join(i, 'docs', 'adr'))
  const mine0001 = path.join(i, 'docs', 'adr', '0001-my-own-first-decision.md')
  write(mine0001, '---\nid: "0001"\n---\n# 0001. mine\n')
  return { mine0001, rI: await runInitA(['-Target', i]), i }
})
T('I seed suppressed when a record exists', () => ok(!isFile(seedPath(secI().i)), 'corpus seed placed over an existing 0001'))
T('I suppression is reported', () => ok(m(secI().rI.out, 'corpus seed not placed'), secI().rI.out))
T('I existing record untouched', () => ok(m(read(secI().mine0001), 'mine'), 'existing 0001 changed'))
T('I run exits 0', () => ok(secI().rI.code === 0, `exit=${secI().rI.code}`))

// --- I2: records that do not match ^\d{4}- still suppress the seed -----------------------------------
// Detection must not match only `^\d{4}-` names: a repo whose log uses another convention
// (ADR-001-*, 001-*, dated names) must not get a second decision log.
const secI2 = section(async () => {
  const i2 = target('has-records-other-naming')
  mk(path.join(i2, 'docs', 'adr'))
  write(path.join(i2, 'docs', 'adr', 'ADR-007-choose-database.md'), '# ADR-007\n')
  return { i2, rI2: await runInitA(['-Target', i2]) }
})
T('I2 non-standard-named record suppresses the seed', () => ok(!isFile(seedPath(secI2().i2)), 'seed placed next to ADR-007-*'))
T('I2 suppression is reported', () => ok(m(secI2().rI2.out, 'corpus seed not placed'), secI2().rI2.out))
// ADR-007-* is invisible to the builder (FILE_RE wants NNNN-*.md), so this repo's corpus is
// unbuildable after suppression — the report must carry that cause, not just the suppression.
T('I2 unbuildable corpus is explained with the rename path', () => ok(m(secI2().rI2.out, 'docs build will refuse') && m(secI2().rI2.out, 'rename'), secI2().rI2.out))
T('I2 run exits 0', () => ok(secI2().rI2.code === 0, `exit=${secI2().rI2.code}`))

// --- I3: records in a conventional home OUTSIDE docs/adr/ suppress the seed and name it --------------
// Seeding 0001 next to a foreign log (doc/adr, docs/decisions, ...) forks the repo's decision
// history; the operator must migrate, and the report must say where the records are and what to do.
const secI3 = section(async () => {
  const i3 = target('has-records-elsewhere')
  mk(path.join(i3, 'doc', 'adr'))
  write(path.join(i3, 'doc', 'adr', '0001-use-postgres.md'), '# 0001\n')
  return { i3, rI3: await runInitA(['-Target', i3]) }
})
T('I3 foreign-location record suppresses the seed', () => ok(!isFile(seedPath(secI3().i3)), 'seed placed while doc/adr/ holds records'))
T('I3 the location is named', () => ok(m(secI3().rI3.out, 'doc/adr'), secI3().rI3.out))
T('I3 the migration path is stated', () => ok(m(secI3().rI3.out, 'migrate them into docs/adr/'), secI3().rI3.out))
T('I3 run exits 0', () => ok(secI3().rI3.code === 0, `exit=${secI3().rI3.code}`))

// --- I4: README/template files are NOT records — no over-suppression ---------------------------------
// The negative half of I2/I3: a doc/adr/ holding only a README must still count as empty, or the
// broadened detection would deny the seed (and with it a buildable corpus) to repos it should serve.
const secI4 = section(async () => {
  const i4 = target('readme-only-elsewhere')
  mk(path.join(i4, 'doc', 'adr'))
  write(path.join(i4, 'doc', 'adr', 'README.md'), '# about ADRs\n')
  write(path.join(i4, 'doc', 'adr', 'decision-template.md'), '# template\n')
  return { i4, rI4: await runInitA(['-Target', i4]) }
})
T('I4 README/template alone do not suppress', () => ok(isFile(seedPath(secI4().i4)), `seed not placed; out=${secI4().rI4.out}`))
T('I4 run exits 0', () => ok(secI4().rI4.code === 0, `exit=${secI4().rI4.code}`))

// --- I5: 'template' inside a record's TITLE does not exclude it (anchored suffix match) --------------
// An unanchored match on 'template' would exclude a real record about templating and seed a second
// log, through the file name instead of the convention.
const secI5 = section(async () => {
  const i5 = target('record-about-templating')
  mk(path.join(i5, 'doc', 'adr'))
  write(path.join(i5, 'doc', 'adr', '0007-template-engine-selection.md'), '# 0007\n')
  return { i5, rI5: await runInitA(['-Target', i5]) }
})
T('I5 a record about templating still suppresses the seed', () => ok(!isFile(seedPath(secI5().i5)), `seed placed despite 0007-template-engine-selection.md; out=${secI5().rI5.out}`))
T('I5 run exits 0', () => ok(secI5().rI5.code === 0, `exit=${secI5().rI5.code}`))

// --- I6: records in BOTH docs/adr/ and a foreign home -> both reported -------------------------------
// A transitional repo (standard log started, old log not yet migrated) must hear about the
// foreign location too; an if/elseif that stops at the docs/adr/ count hides it.
const secI6 = section(async () => {
  const i6 = target('records-both-places')
  mk(path.join(i6, 'docs', 'adr'))
  mk(path.join(i6, 'doc', 'adr'))
  write(path.join(i6, 'docs', 'adr', '0001-first.md'), '# 0001\n')
  write(path.join(i6, 'doc', 'adr', '0009-legacy.md'), '# 0009\n')
  return { rI6: await runInitA(['-Target', i6]) }
})
T('I6 docs/adr records reported', () => ok(m(secI6().rI6.out, 'docs/adr/ already holds 1 record'), secI6().rI6.out))
T('I6 foreign location reported in the same run', () => ok(m(secI6().rI6.out, 'outside docs/adr/.*doc/adr'), secI6().rI6.out))
T('I6 run exits 0', () => ok(secI6().rI6.code === 0, `exit=${secI6().rI6.code}`))

// --- J: a hostile console encoding must not break the build ------------------------------------------
// The builder is Node and ignores PYTHONIOENCODING, so the variable set below reaches no subject. The
// case checks that the build output and index.json arrive intact, and proves no encoding defence.
const secJ = section(async () => { const j = target('cp1252'); return { j, rJ: await runInitA(['-Target', j], init, { PYTHONIOENCODING: 'cp1252' }) } })
T('J build survives an inherited cp1252 stdout encoding', () => ok(m(secJ().rJ.out, R`built: index\.json`), secJ().rJ.out))
T('J index.json exists under cp1252', () => ok(isFile(path.join(secJ().j, 'docs', 'index.json')), 'index.json missing'))

// --- K-O: core.hooksPath wiring (ADR 0015) -----------------------------------------------------------
// This is the ONLY thing init.mjs does that is not a file write, so every branch is enumerated. The
// case that matters most is M: a repo pointing hooksPath somewhere of its own must come out of a
// scaffold run with that value intact, because init.mjs's whole credibility is "never clobbers what
// it did not write".
const secK = section(async () => { const k = newGitTarget('wire-unset'); return { k, rK: await runInitA(['-Target', k]) } }, { enabled: GIT })
T('K unset hooksPath gets wired', () => { const { k, rK } = secK(); ok(getHooksPath(k) === '.githooks', `value='${getHooksPath(k)}' out=${rK.out}`) }, { skip: NO_GIT })
T('K wiring is reported', () => ok(m(secK().rK.out, 'hooks: .*wired'), secK().rK.out), { skip: NO_GIT })
T('K hooks are actually on disk', () => {
  const { k } = secK()
  ok(isFile(path.join(k, '.githooks', 'pre-commit')) && isFile(path.join(k, '.githooks', 'pre-push')), 'a hook file is missing')
}, { skip: NO_GIT })
// The executable bit is not cosmetic on POSIX: git skips a non-executable hook WITHOUT SAYING SO,
// which is the same silent-inert failure the wiring branches above exist to prevent. Windows is
// exempt because git there invokes hooks through sh regardless of the mode.
T(WIN ? 'K exec bit' : 'K placed hooks are executable', () => {
  const { k } = secK()
  const noExec = ['.githooks/pre-commit', '.githooks/pre-push'].filter((f) => (fs.statSync(path.join(k, f)).mode & 0o100) === 0)
  ok(noExec.length === 0, `not executable: ${noExec.join(', ')}`)
}, { skip: NO_GIT || (WIN ? 'Windows — git invokes hooks through sh regardless of the mode bit' : false) })

// K2: the target named by its 8.3 short alias gets wired. git reports the long top level, and a lexical compare of
// the two refused the wiring as "not the repository root" (the GitHub Windows runner's TEMP is a short name).
const NO_SHORT = shortAlias(fxBase) === '' ? 'no 8.3 short name for the fixture root on this host' : false
const secK2 = section(async () => {
  const k2 = newGitTarget('wire-short-alias')
  const k2s = shortAlias(k2)
  return { k2, k2s, rK2: await runInitA(['-Target', k2s]) }
}, { enabled: GIT && !NO_SHORT })
T('K2 a target named by its 8.3 short alias gets wired', () => {
  const { k2, k2s, rK2 } = secK2()
  ok(k2s !== '' && getHooksPath(k2) === '.githooks' && m(rK2.out, 'hooks: .*wired'), `target=${k2s} value='${getHooksPath(k2)}' out=${rK2.out}`)
}, { skip: NO_GIT || NO_SHORT })

// L: already .githooks -> no-op, still reported
const secL = section(async () => { const [{ k }] = await after(secK); return { rL: await runInitA(['-Target', k]) } }, { enabled: GIT })
T('L re-run leaves the wired value alone', () => { secL(); ok(getHooksPath(secK().k) === '.githooks', `value='${getHooksPath(secK().k)}'`) }, { skip: NO_GIT })
T('L re-run says already wired', () => ok(m(secL().rL.out, 'already wired'), secL().rL.out), { skip: NO_GIT })

// M: a foreign value is REFUSED, not overwritten
const secM = section(async () => {
  const mm = newGitTarget('wire-foreign')
  git_result(mm, ['config', '--local', 'core.hooksPath', '.myhooks'])
  return { mm, rM: await runInitA(['-Target', mm]) }
}, { enabled: GIT })
T('M foreign hooksPath survives byte-identical', () => ok(getHooksPath(secM().mm) === '.myhooks', `value='${getHooksPath(secM().mm)}'`), { skip: NO_GIT })
T('M refusal is reported', () => ok(m(secM().rM.out, 'REFUSED'), secM().rM.out), { skip: NO_GIT })
T('M the existing value is named in the report', () => ok(m(secM().rM.out, R`\.myhooks`), secM().rM.out), { skip: NO_GIT })
T('M run still exits 0', () => ok(secM().rM.code === 0, `exit=${secM().rM.code}`), { skip: NO_GIT })

// N: dry run touches no git config
const secN = section(async () => { const n = newGitTarget('wire-dry'); return { n, rN: await runInitA(['-Target', n, '-DryRun']) } }, { enabled: GIT })
T('N dry run sets nothing', () => ok(getHooksPath(secN().n) === '', `value='${getHooksPath(secN().n)}'`), { skip: NO_GIT })
T('N dry run says what it would do', () => ok(m(secN().rN.out, 'would set it'), secN().rN.out), { skip: NO_GIT })

// O: a subdirectory of a repo is refused — setting hooksPath there reconfigures the whole repo
const secO = section(async () => {
  const [{ k }] = await after(secK, secL)
  const o = path.join(k, 'sub', 'tree')
  mk(o)
  return { rO: await runInitA(['-Target', o]) }
}, { enabled: GIT })
T('O subdirectory target refuses to wire', () => ok(m(secO().rO.out, 'not the repository root'), secO().rO.out), { skip: NO_GIT })
T('O parent repo hooksPath is untouched', () => { secO(); ok(getHooksPath(secK().k) === '.githooks', `parent value='${getHooksPath(secK().k)}'`) }, { skip: NO_GIT })

// Y: the same directory in another spelling is "already wired", never REFUSED, and the value stays
// byte-identical: the scaffold does not rewrite a value that it did not write. A literal compare
// against '.githooks' would REFUSE an absolute value, a './' prefix, the Git-Bash-on-Windows MSYS form
// and a '~/'-wired clone, and tell the reader that the placed hooks are inert while they run on every
// commit. The emitter applies the same resolved-path compare to its hooks: line (harness_gates.selftest
// K6-K6e), and this is the scaffold's half of the rule. The literal compare fails Y1/Y2/Y3, and a
// `--get` read with no tilde expansion fails Y4. Y5 is the control: a DIFFERENT absolute directory
// stays REFUSED and untouched. Assertions read the `hooks:` LINE, not the whole run, because the
// summary line's `refused=0` matches a case-insensitive 'REFUSED'.
const secY = section(async () => {
  const y = newGitTarget('wire-spelling')
  const absY = path.join(y, '.githooks')
  git_result(y, ['config', '--local', 'core.hooksPath', absY])
  const rY1 = await runInitA(['-Target', y]); const hY1 = hooksLine(rY1); const stored1 = getHooksPath(y)
  git_result(y, ['config', '--local', 'core.hooksPath', './.githooks'])
  const rY2 = await runInitA(['-Target', y]); const hY2 = hooksLine(rY2); const stored2 = getHooksPath(y)
  const o = { y, absY, rY1, hY1, stored1, rY2, hY2, stored2 }
  const winM = WIN ? /^([A-Za-z]):\\(.*)$/u.exec(absY) : null
  if (winM) {
    o.msysY = `/${winM[1].toLowerCase()}/${winM[2].replace(/\\/gu, '/')}`
    git_result(y, ['config', '--local', 'core.hooksPath', o.msysY])
    o.rY3 = await runInitA(['-Target', y]); o.hY3 = hooksLine(o.rY3); o.stored3 = getHooksPath(y)
  }
  // Y4: git expands `~/` when it RUNS hooks; the scaffold must read the value the same way
  // (`git config --path`), or a tilde-wired clone reads as foreign. HOME is pinned to the fixture
  // so `~/.githooks` resolves there on every platform (git prefers HOME over USERPROFILE on
  // Windows too). The value is a literal: no shell expands it here. The survival check
  // compares against the value git stored, whatever form that took on this platform.
  git_result(y, ['config', '--local', 'core.hooksPath', '~/.githooks'])
  o.storedY4 = getHooksPath(y)
  o.rY4 = await runInitA(['-Target', y], init, { HOME: y })
  o.afterY4 = getHooksPath(y)
  o.hY4 = hooksLine(o.rY4)
  o.otherY = path.join(y, '.other-hooks')
  git_result(y, ['config', '--local', 'core.hooksPath', o.otherY])
  o.rY5 = await runInitA(['-Target', y]); o.hY5 = hooksLine(o.rY5); o.stored5 = getHooksPath(y)
  return o
}, { enabled: GIT })
T('Y1 an absolute path to .githooks is already wired, not REFUSED', () => {
  const { hY1 } = secY()
  ok(m(hY1, 'already wired') && !cm(hY1, 'REFUSED') && !m(hY1, 'inert'), hY1)
}, { skip: NO_GIT })
T('Y1 the absolute value survives byte-identical (never rewritten to .githooks)', () => ok(secY().stored1 === secY().absY, `value='${secY().stored1}'`), { skip: NO_GIT })
T('Y1 run exits 0', () => ok(secY().rY1.code === 0, `exit=${secY().rY1.code}`), { skip: NO_GIT })
T('Y2 ./.githooks is already wired', () => ok(m(secY().hY2, 'already wired') && !cm(secY().hY2, 'REFUSED'), secY().hY2), { skip: NO_GIT })
T('Y2 the ./ spelling survives', () => ok(secY().stored2 === './.githooks', `value='${secY().stored2}'`), { skip: NO_GIT })
const NO_MSYS = NO_GIT || (WIN ? false : 'not Windows — the /c/ rewrite is Windows-only by design')
T('Y3 the MSYS /c/... form is already wired on Windows', () => ok(m(secY().hY3, 'already wired') && !cm(secY().hY3, 'REFUSED'), secY().hY3), { skip: NO_MSYS })
T('Y3 the MSYS spelling survives', () => ok(secY().stored3 === secY().msysY, `value='${secY().stored3}'`), { skip: NO_MSYS })
T('Y4 a ~/ hooksPath (git tilde expansion) is already wired', () => ok(m(secY().hY4, 'already wired') && !cm(secY().hY4, 'REFUSED'), secY().hY4), { skip: NO_GIT })
T('Y4 the stored value survives byte-identical', () => {
  const { afterY4, storedY4 } = secY()
  ok(afterY4 === storedY4 && storedY4 !== '', `before='${storedY4}' after='${afterY4}'`)
}, { skip: NO_GIT })
T('Y5 an absolute path to a DIFFERENT directory is still REFUSED', () => ok(cm(secY().hY5, 'REFUSED') && !m(secY().hY5, 'already wired'), secY().hY5), { skip: NO_GIT })
T('Y5 the foreign value survives byte-identical', () => ok(secY().stored5 === secY().otherY, `value='${secY().stored5}'`), { skip: NO_GIT })

// A directory link is made where the platform allows it: an NTFS junction on Windows (no privilege needed; a
// symlink needs admin there), a symlink on POSIX. The probe runs once, so the names of the cases that need a
// link are fixed when the file is read.
const LINK = (() => {
  const real = path.join(fxBase, 'link-probe-real')
  const link = path.join(fxBase, 'link-probe')
  try { mk(real); fs.symlinkSync(real, link, WIN ? 'junction' : 'dir'); return { ok: true, reason: '' } } catch (e) {
    return { ok: false, reason: `cannot create a ${WIN ? 'Junction' : 'SymbolicLink'} here (reported, not silent): ${String(e.message).split('\n')[0]}` }
  }
})()

// Y6: `.githooks` reached THROUGH a link and core.hooksPath written as the link's REAL target. Git runs
// the hooks that the scaffold placed (it opens the target directory), and the emitter's
// `_hooks_path_is` follows the link and says wired. A lexical compare would say REFUSED, so the
// scaffold compares real paths. SKIP is reported when the link cannot be made.
const secY6 = section(async () => {
  const y6 = newGitTarget('wire-linked')
  const y6real = path.join(fxBase, 'wire-linked-real-hooks')
  mk(y6real)
  fs.symlinkSync(y6real, path.join(y6, '.githooks'), WIN ? 'junction' : 'dir')
  git_result(y6, ['config', '--local', 'core.hooksPath', y6real])
  const rY6 = await runInitA(['-Target', y6])
  return { y6, y6real, rY6, hY6: hooksLine(rY6) }
}, { enabled: GIT && LINK.ok })
const Y6SKIP = NO_GIT || (LINK.ok ? false : LINK.reason)
T('Y6 the REAL target of a linked .githooks is already wired (realpath compare — emitter parity)', () => ok(m(secY6().hY6, 'already wired') && !cm(secY6().hY6, 'REFUSED'), secY6().hY6), { skip: Y6SKIP })
T('Y6 the real-target value survives byte-identical', () => ok(getHooksPath(secY6().y6) === secY6().y6real, `value='${getHooksPath(secY6().y6)}'`), { skip: Y6SKIP })
T('Y6 the hooks were placed through the link', () => ok(isFile(path.join(secY6().y6real, 'pre-commit')), 'pre-commit missing in the real directory'), { skip: Y6SKIP })

// Y7: a WORKTREE-scoped core.hooksPath (`extensions.worktreeConfig`) outranks `.git/config`. A
// `--local`-only read would call this clone "already wired" while git runs hooks from `.elsewhere`.
// Nothing is written at either scope on that branch. Y7b: the worktree value naming `.githooks`
// is wired.
const secY7 = section(async () => {
  const y7 = newGitTarget('wire-worktree-scope')
  git_result(y7, ['config', '--local', 'core.hooksPath', '.githooks'])
  git_result(y7, ['config', 'extensions.worktreeConfig', 'true'])
  git_result(y7, ['config', '--worktree', 'core.hooksPath', '.elsewhere'])
  const rY7 = await runInitA(['-Target', y7]); const hY7 = hooksLine(rY7)
  const wtValue = git_result(y7, ['config', '--worktree', '--get', 'core.hooksPath']).stdout.trim()
  const localValue = getHooksPath(y7)
  git_result(y7, ['config', '--worktree', 'core.hooksPath', path.join(y7, '.githooks')])
  const rY7b = await runInitA(['-Target', y7])
  return { y7, rY7, hY7, wtValue, localValue, hY7b: hooksLine(rY7b) }
}, { enabled: GIT })
T('Y7 a foreign worktree-scoped value is reported as outranking — not "already wired"', () => {
  const { hY7 } = secY7()
  ok(m(hY7, 'WORKTREE scope') && m(hY7, 'do not run') && !m(hY7, 'already wired'), hY7)
}, { skip: NO_GIT })
T('Y7 the worktree value survives', () => ok(eqi(secY7().wtValue, '.elsewhere'), 'worktree value changed'), { skip: NO_GIT })
T('Y7 the local value survives', () => ok(secY7().localValue === '.githooks', `local='${secY7().localValue}'`), { skip: NO_GIT })
T('Y7 run exits 0', () => ok(secY7().rY7.code === 0, `exit=${secY7().rY7.code}`), { skip: NO_GIT })
T('Y7b a worktree-scoped value naming .githooks is already wired', () => ok(m(secY7().hY7b, 'worktree scope') && m(secY7().hY7b, 'already wired'), secY7().hY7b), { skip: NO_GIT })

// --- Q: GUARDED placement — post-commit is the one filename repos already use ------------------------
// TOOLCHAIN would destroy a repo's own post-commit automation, and SEED would silently deny the
// retro to any repo that has one. So the scaffold refreshes its own copy and refuses a foreign one.
const mineQ = '#!/bin/sh\n# my own post-commit\necho hello\n'
const secQ = section(async () => {
  const q = target('guarded-foreign')
  mk(path.join(q, '.githooks'))
  write(path.join(q, '.githooks', 'post-commit'), mineQ)
  return { q, rQ: await runInitA(['-Target', q]) }
})
T('Q1 a foreign post-commit survives byte-identical', () => ok(read(path.join(secQ().q, '.githooks', 'post-commit')) === mineQ, 'post-commit was overwritten'))
T('Q1 the refusal is reported', () => ok(m(secQ().rQ.out, 'REFUSED'), secQ().rQ.out))
T('Q1 refused is counted separately', () => ok(m(secQ().rQ.out, 'refused=1'), secQ().rQ.out))
T('Q1 the one-line workaround is printed', () => ok(m(secQ().rQ.out, R`harness_retro\.mjs`), secQ().rQ.out))
T('Q1 run still exits 0', () => ok(secQ().rQ.code === 0, `exit=${secQ().rQ.code}`))

// Q2: a post-commit carrying the marker is OURS, so it refreshes like any toolchain file.
const secQ2 = section(async () => {
  const q2 = target('guarded-ours')
  mk(path.join(q2, '.githooks'))
  write(path.join(q2, '.githooks', 'post-commit'), '#!/bin/sh\n# ywr-harness:post-commit\n# stale copy\n')
  return { q2, rQ2: await runInitA(['-Target', q2]) }
})
T('Q2 a marked post-commit is refreshed from canon', () =>
  ok(read(path.join(secQ2().q2, '.githooks', 'post-commit')) === read(path.join(templates, 'githooks', 'post-commit')), 'marked copy was not refreshed'))
T('Q2 nothing is refused', () => ok(m(secQ2().rQ2.out, 'refused=0'), secQ2().rQ2.out))

// --- R: a CRLF-materialized plugin cache still places LF ---------------------------------------------
// The installed plugin is checked out by the CONSUMER's git, where core.autocrlf stamps CRLF onto
// every template. Verbatim placement would give an eol=lf repo spurious modifications after every
// re-run, and a POSIX clone sh hooks that die with "/bin/sh^M: bad interpreter". Placement owns the
// line discipline: LF out, whatever came in.
// Runs a COPY of the skill with CRLF stamped onto every template; the real plugin is never modified.
const secR = section(async () => {
  const crlfSkill = copySkill('crlf-skill')
  for (const f of listFiles(path.join(crlfSkill, 'templates'))) {
    const stamped = fs.readFileSync(f).toString('latin1').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')
    fs.writeFileSync(f, Buffer.from(stamped, 'latin1'))
  }
  const r = target('crlf-cache')
  const crlfInit = path.join(crlfSkill, 'init.mjs')
  const rR = await runInitA(['-Target', r], crlfInit)
  // Read at the point where the first run ends: the lone-CR case below appends a byte to a placed file, so a later read would see it.
  const withCr = EXPECT.filter((f) => isFile(path.join(r, f)) && fs.readFileSync(path.join(r, f)).includes(13))
  return { r, crlfInit, rR, withCr }
})
T('R run against a CRLF cache exits 0', () => ok(secR().rR.code === 0, `exit=${secR().rR.code} out=${secR().rR.out}`))
T('R no placed file carries a CR', () => {
  const { withCr } = secR()
  ok(withCr.length === 0, `CR found in: ${withCr.join(', ')}`)
})
// Re-run against the same CRLF cache. The CR-absence assertion above kills a revert to verbatim
// placement. THIS assertion kills the normalize-write-but-raw-compare regression (ADR 0036's rejected
// Option C: LF on disk against a CRLF template differs raw, so every re-run would report every
// placement as refreshed). A full revert passes this assertion alone, because verbatim run 1 makes
// run 2's raw compare byte-identical.
const secR2 = section(async () => { const [{ r, crlfInit }] = await after(secR); return (await runInitA(['-Target', r], crlfInit)).out })
T('R re-run refreshes nothing (CR-only delta is not a change)', () => ok(m(secR2(), 'refreshed=0') && m(secR2(), 'created=0'), secR2()))
// A LONE CR (0x0D with no LF after it) is also not a change: the compare is ADR 0033's fold, which
// drops every 0x0D, not a CRLF-pair fold, so the scaffold and the refresh nudge agree on lone-CR
// deltas. The byte itself is left as placed: the compare only decides whether a re-run would
// change anything, and line endings belong to git's attributes.
const secR3 = section(async () => {
  const [, { r, crlfInit }] = await after(secR2, secR)
  const loneTarget = path.join(r, 'docs', 'build.mjs')
  fs.writeFileSync(loneTarget, Buffer.concat([fs.readFileSync(loneTarget), Buffer.from([13])]))
  return { loneTarget, out: (await runInitA(['-Target', r], crlfInit)).out }
})
T('R lone-CR delta is not a change (0033 fold, not a CRLF-pair fold)', () => ok(m(secR3().out, 'refreshed=0') && m(secR3().out, 'created=0'), secR3().out))
T('R the lone CR is left as placed, not rewritten', () => { const b = fs.readFileSync(secR3().loneTarget); ok(b.at(-1) === 13, 'lone CR was rewritten away') })

// A scaffolded tree to start from. A case that only needs "a repo the scaffold already ran in" (its own first run is no
// assertion) takes a copy of one real run's result, so a fixture costs a copy and not a run. The cases whose first
// run IS an assertion (S, AA, V, RT1, RT2) keep their own run.
const scaffoldBase = section(async () => {
  const b = target('scaffold-base')
  const r = await runInitA(['-Target', b])
  if (r.code !== 0) throw new Error(`the scaffold base run exited ${r.code}: ${r.out}`)
  return b
})
async function scaffolded(name) {
  const [b] = await after(scaffoldBase)
  const p = path.join(fxBase, name)
  fs.cpSync(b, p, { recursive: true })
  return p
}

// --- S: downgrade guard + stamp lifecycle (ADR 0042) -------------------------------------------------
// The multi-writer destructive path this section pins: writer A refreshes a repo at vN+1 and merges,
// and writer B (plugin vN) re-runs the scaffold. B must REFUSE before it writes anything, because it
// would place older templates over A's refresh. -Force stays the deliberate-rollback path.
const secS = section(async () => {
  const s = target('stamp-newer')
  const rS0 = await runInitA(['-Target', s])
  // Drift one toolchain file AND raise the stamp: the refusal must leave the drift in place.
  const sBuilder = path.join(s, 'docs', 'build_docs.mjs')
  write(sBuilder, '# writer A newer copy')
  write(path.join(s, '.harness-version'), '99.0.0\n')
  const rS1 = await runInitA(['-Target', s])
  const o = { s, sBuilder, rS0, rS1, builderAfterS1: read(sBuilder), stampAfterS1: stampOf(s) }
  // S2: -Force is the deliberate-rollback path — proceeds, says so, reverts the file, re-stamps.
  o.rS2 = await runInitA(['-Target', s, '-Force'])
  o.builderAfterS2 = read(sBuilder); o.stampAfterS2 = stampOf(s)
  return o
})
T('S setup run exits 0', () => ok(secS().rS0.code === 0, `exit=${secS().rS0.code}`))
T('S1 newer stamp refuses with exit 1', () => ok(secS().rS1.code === 1, `exit=${secS().rS1.code} out=${secS().rS1.out}`))
T('S1 both versions are named', () => ok(m(secS().rS1.out, R`v99\.0\.0`) && m(secS().rS1.out, 'NEWER'), secS().rS1.out))
T('S1 the update remedy is named', () => ok(m(secS().rS1.out, '/ywr-harness:update'), secS().rS1.out))
T('S1 nothing was placed over the newer copy', () => ok(secS().builderAfterS1 === '# writer A newer copy', 'the refused run still overwrote a file'))
T('S1 the stamp itself is untouched by a refusal', () => ok(secS().stampAfterS1 === '99.0.0', 'refusal rewrote the stamp'))
T('S2 -Force proceeds with exit 0', () => ok(secS().rS2.code === 0, `exit=${secS().rS2.code} out=${secS().rS2.out}`))
T('S2 the forced downgrade is announced', () => ok(m(secS().rS2.out, 'DOWNGRADE FORCED'), secS().rS2.out))
T('S2 the toolchain file is placed from canon', () => ok(secS().builderAfterS2 === read(path.join(templates, 'docs', 'build_docs.mjs')), 'forced run did not place'))
T('S2 the stamp is rewritten to this plugin version', () => ok(eqi(secS().stampAfterS2, manifestVer), `stamp=${secS().stampAfterS2}`))
// S3: an unparseable stamp must not strand the repo — proceed (fail-open direction: refusing on
// garbage could never destroy newer work, but it would dead-end every corrupted stamp forever),
// and the run rewrites it to a valid value.
const secS3 = section(async () => {
  const s3 = await scaffolded('stamp-garbage')
  write(path.join(s3, '.harness-version'), 'not a version\n')
  const rS3 = await runInitA(['-Target', s3])
  return { s3, rS3 }
})
T('S3 garbage stamp proceeds', () => ok(secS3().rS3.code === 0, `exit=${secS3().rS3.code} out=${secS3().rS3.out}`))
T('S3 garbage stamp is rewritten to the plugin version', () => ok(eqi(stampOf(secS3().s3), manifestVer), 'stamp not repaired'))

// --- UA: upstream-ahead guard (ADR 0135) -------------------------------------------------------------
// A teammate scaffolded the repo and pushed; this clone has not pulled. Scenario 2 (never scaffolded) is
// the one with no stamp to look at: the clone is a plain repo whose origin carries the scaffold. ONE bare
// remote, the stale clone (ua-c, one README commit) and the pusher (ua-b, a real init.mjs run, committed
// and pushed) carry every leg; the stale clone only fetches. Scenario 1 (an older stamp) reaches the
// same guard through the same git query — UA6 below pins it through init.mjs, the hook suite's 10b legs
// through the hook. The guard's path is the stamp ALONE (UA5): a toolchain-only upstream commit is a hand
// edit, not a scaffold run. UA7 pins the patch-equivalence filter (a rebased or amended stamp commit).
// The legs run in one function. It records what each case reads, and the tests below assert on those
// records.
const uaGit = (dir, args) => gitOk(dir, ['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', '-c', 'commit.gpgsign=false', ...args])
const uaRev = (dir, args) => git_result(dir, args).stdout.trim()
// A path-and-hash list of every file outside .git, so "nothing was written" is a byte comparison.
function treeSnapshot(dir) {
  const prefix = path.resolve(dir).replace(/[\\/]+$/u, '').length + 1
  const rows = listFiles(dir).filter((f) => !/[\\/]\.git[\\/]/u.test(f))
    .map((f) => `${f.slice(prefix)}:${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`)
  return rows.sort().join('\n')
}
const REF_LINE = R`REFUSED — origin/main has commit\(s\) not in this checkout that change the scaffold`
const secUA = section(async () => {
  const o = {}
  const uaRemote = path.join(fxBase, 'ua-remote.git')
  git_result(fxBase, ['-c', 'init.defaultBranch=main', 'init', '-q', '--bare', uaRemote])
  const uaC = target('ua-c')
  git_result(uaC, ['-c', 'init.defaultBranch=main', 'init', '-q'])
  write(path.join(uaC, 'README.md'), 'a repo that was never scaffolded\n')
  uaGit(uaC, ['add', '-A'])
  uaGit(uaC, ['commit', '-q', '-m', 'C: first commit'])
  uaGit(uaC, ['remote', 'add', 'origin', uaRemote])
  uaGit(uaC, ['push', '-q', '-u', 'origin', 'main'])
  const uaB = path.join(fxBase, 'ua-b')
  uaGit(fxBase, ['clone', '-q', uaRemote, uaB])
  o.rUAB = await runInitA(['-Target', uaB])
  o.pusherStamped = isFile(path.join(uaB, '.harness-version'))
  uaGit(uaB, ['config', '--local', '--unset', 'core.hooksPath']) // init.mjs wired the scaffold's hooks; the fixture commit bypasses them
  uaGit(uaB, ['add', '-A'])
  uaGit(uaB, ['commit', '-q', '-m', 'B: scaffold'])
  uaGit(uaB, ['push', '-q', 'origin', 'main'])

  // The three legs below do not share state beyond what the lines above leave. Each runs on its own copy of
  // that state (a copied .git folder is a real repository), so the legs overlap: leg 1 (the stale clone has not
  // fetched), leg 2 (fetched, not merged) and leg 3 (UA5-UA8b, where the pusher moves the remote). Leg 3 pushes, so it
  // gets its own bare remote and its own pusher; legs 1 and 2 only fetch from the shared one. Inside a leg the
  // steps stay in order, because each builds on the state the last one left.
  const copyOf = (src, name) => { const p = path.join(fxBase, name); fs.cpSync(src, p, { recursive: true }); return p }
  const uaC1 = copyOf(uaC, 'ua-c-leg1')
  const uaC2 = copyOf(uaC, 'ua-c-leg2')
  const uaRemote3 = copyOf(uaRemote, 'ua-remote3.git')
  const uaB3 = copyOf(uaB, 'ua-b-leg3')
  const uaC3 = copyOf(uaC, 'ua-c-leg3')
  uaGit(uaB3, ['remote', 'set-url', 'origin', uaRemote3])
  uaGit(uaC3, ['remote', 'set-url', 'origin', uaRemote3])
  const leg1 = async (uaC) => {
    const o = {}
    // UA1 (ADR 0137): the clone has NOT fetched — its refs know nothing of the push. With the remote
    // unreachable (the URL points at a missing path for this leg only), the pre-check fetch fails: ONE yellow
    // line, never a block, and the check reads the old refs — no hit, the dry run proceeds (the freshness limit).
    const uaUnfetched = uaRev(uaC, ['rev-parse', 'origin/main'])
    uaGit(uaC, ['remote', 'set-url', 'origin', path.join(fxBase, 'ua-missing.git')])
    o.rUA1 = await runInitA(['-Target', uaC, '-DryRun'])
    // UA1a: -AllowUpstreamAhead skips the fetch — no outcome waits on it — so the same unreachable remote prints nothing.
    o.rUA1a = await runInitA(['-Target', uaC, '-DryRun', '-AllowUpstreamAhead'])
    uaGit(uaC, ['remote', 'set-url', 'origin', uaRemote])
    // UA1b: the same unfetched clone, remote reachable again: the run fetches by itself, so the refusal sees the
    // push that no one fetched, the case that ADR 0135 leaves to the skill's prose. Dry run: nothing written.
    o.rUA1b = await runInitA(['-Target', uaC, '-DryRun'])
    o.uaFetchedMoved = uaRev(uaC, ['rev-parse', 'origin/main']) !== uaUnfetched
    o.uaCStampedAfter1b = isFile(path.join(uaC, '.harness-version'))

    return o
  }
  const leg2 = async (uaC) => {
    const o = {}
    uaGit(uaC, ['fetch', '-q', 'origin'])
    o.uaSha = uaRev(uaC, ['log', '-1', '--format=%h', 'origin/main'])
    o.uaBefore = treeSnapshot(uaC)
    o.fixtureFetchedNotMerged = /^[0-9a-f]{4,}$/u.test(o.uaSha) && !isFile(path.join(uaC, '.harness-version'))
    // UA2: dry run AND real run refuse with exit 1 and write nothing — the dry run must show the real run's refusal.
    o.ua2 = {}
    for (const [mode, args] of [['dry run', ['-Target', uaC, '-DryRun']], ['real run', ['-Target', uaC]], ['-Force run', ['-Target', uaC, '-Force']]]) {
      const r = await runInitA(args)
      o.ua2[mode] = { r, unchanged: treeSnapshot(uaC) === o.uaBefore && !isFile(path.join(uaC, '.harness-version')) && !getHooksPath(uaC) }
    }
    // UA2's third mode is the design point: -Force is NOT the override (it also bypasses ADR 0055's first-run collision refusals).
    // UA2b: -DryRun together with -AllowUpstreamAhead: the ALLOWED line once, exit 0, and still nothing written.
    o.rUA2b = await runInitA(['-Target', uaC, '-DryRun', '-AllowUpstreamAhead'])
    o.ua2bUnchanged = treeSnapshot(uaC) === o.uaBefore && !isFile(path.join(uaC, '.harness-version')) && !getHooksPath(uaC)
    // UA3: -AllowUpstreamAhead is the deliberate-divergence path — one Yellow line, then the normal run.
    o.rUA3 = await runInitA(['-Target', uaC, '-AllowUpstreamAhead'])
    o.ua3Placed = isFile(path.join(uaC, '.harness-version')) && isFile(path.join(uaC, 'scripts', 'harness', 'harness_gates.mjs'))
    return o
  }
  const leg3 = async (uaC, uaB, uaRemote) => {
    const o = {}
    // UA5-UA7 reuse the stale clone: put it on the pushed tip (the placement UA3 left is untracked noise),
    // then the pusher moves the remote and the clone only fetches. The fixture commits bypass the wired hooks.
    git_result(uaC, ['config', '--local', '--unset', 'core.hooksPath'])
    git_result(uaC, ['clean', '-fdxq'])
    uaGit(uaC, ['fetch', '-q', 'origin']) // this leg's clone has not fetched yet; the legs before it fetched in their own copies
    uaGit(uaC, ['reset', '-q', '--hard', 'origin/main'])
    const uaStamp = read(path.join(uaB, '.harness-version')).trim()
    // UA5: an upstream commit that touches ONLY a toolchain file (a hand edit on main, no stamp) is NOT a scaffold
    // run: no refusal, no ALLOWED line. The stamp is the guard's only path.
    fs.appendFileSync(path.join(uaB, 'scripts', 'harness', 'harness_gates.mjs'), '# upstream hand edit\n')
    uaGit(uaB, ['add', '-A'])
    uaGit(uaB, ['commit', '-q', '-m', 'B: hand edit of a toolchain file'])
    uaGit(uaB, ['push', '-q', 'origin', 'main'])
    uaGit(uaC, ['fetch', '-q', 'origin'])
    o.ua5Fixture = Number(uaRev(uaC, ['rev-list', '--count', 'HEAD..origin/main'])) === 1 && !uaRev(uaC, ['log', '-1', '--format=%h', 'HEAD..origin/main', '--', '.harness-version'])
    o.rUA5 = await runInitA(['-Target', uaC, '-DryRun'])
    // UA6: scenario 1 through init.mjs itself — the clone has an OLDER stamp committed and upstream bumped it: REFUSED.
    write(path.join(uaB, '.harness-version'), '0.0.1\n')
    uaGit(uaB, ['add', '-A'])
    uaGit(uaB, ['commit', '-q', '-m', 'B: old stamp'])
    uaGit(uaB, ['push', '-q', 'origin', 'main'])
    uaGit(uaC, ['fetch', '-q', 'origin'])
    uaGit(uaC, ['reset', '-q', '--hard', 'origin/main'])
    write(path.join(uaB, '.harness-version'), `${uaStamp}\n`)
    uaGit(uaB, ['add', '-A'])
    uaGit(uaB, ['commit', '-q', '-m', 'B: stamp bump'])
    uaGit(uaB, ['push', '-q', 'origin', 'main'])
    uaGit(uaC, ['fetch', '-q', 'origin'])
    o.uaSha6 = uaRev(uaC, ['log', '-1', '--format=%h', 'origin/main'])
    o.ua6Fixture = read(path.join(uaC, '.harness-version')).trim() === '0.0.1'
    o.rUA6 = await runInitA(['-Target', uaC, '-DryRun'])
    // UA7: patch-equivalence — the clone amends (or rebases) the commit that carries the stamp bump; the pre-rewrite
    // commit is still on origin/main until a force-push, but its patch is already in HEAD: NOT upstream-ahead.
    uaGit(uaC, ['reset', '-q', '--hard', 'origin/main'])
    uaGit(uaC, ['commit', '-q', '--amend', '-m', 'C: the stamp bump, amended'])
    o.ua7Fixture = Boolean(uaRev(uaC, ['log', '-1', '--format=%h', 'HEAD..origin/main', '--', '.harness-version']))
    o.rUA7 = await runInitA(['-Target', uaC, '-DryRun'])
    // UA8 (ADR 0137): a fetch that hangs is stopped at the timeout and never blocks. The hang is an ssh
    // transport whose command sleeps (git runs core.sshCommand through its shell, which drops the rest after
    // '#'); -FetchTimeoutSeconds 1 keeps the leg short. One yellow line, then the run goes on (UA7's state:
    // no hit). The wall-clock bound proves the process tree was stopped, not waited out. A set core.sshCommand
    // is the member's own ssh, so the BatchMode default stays off and the sleep runs as written.
    uaGit(uaC, ['remote', 'set-url', 'origin', 'ssh://selftest.invalid/ua.git'])
    uaGit(uaC, ['config', '--local', 'core.sshCommand', 'sleep 30 #'])
    o.rUA8 = await runInitA(['-Target', uaC, '-DryRun', '-FetchTimeoutSeconds', '1'])
    o.ua8Elapsed = o.rUA8.elapsed
    // UA8b: a stop can strand git's lock files. The hung transport writes one first (as a fetch killed mid ref
    // update would); an OLD lock is the control. The line names the fresh lock ONLY and deletes neither — an
    // IDE's background fetch may own a lock.
    const lockNew = path.join(uaC, '.git', 'packed-refs.lock')
    const lockOld = path.join(uaC, '.git', 'refs', 'remotes', 'origin', 'old.lock')
    write(lockOld, '')
    const hourAgo = new Date(Date.now() - 3600 * 1000)
    fs.utimesSync(lockOld, hourAgo, hourAgo)
    uaGit(uaC, ['config', '--local', 'core.sshCommand', `touch '${lockNew.replaceAll('\\', '/')}'; sleep 30 #`])
    o.rUA8b = await runInitA(['-Target', uaC, '-DryRun', '-FetchTimeoutSeconds', '1'])
    o.ua8bLocksKept = exists(lockNew) && exists(lockOld)
    rmQuiet(lockNew); rmQuiet(lockOld)
    uaGit(uaC, ['config', '--local', '--unset', 'core.sshCommand'])
    uaGit(uaC, ['remote', 'set-url', 'origin', uaRemote])
    return o
  }
  const legs = await Promise.all([leg1(uaC1), leg2(uaC2), leg3(uaC3, uaB3, uaRemote3)])
  for (const l of legs) Object.assign(o, l)
  return o
}, { enabled: GIT })
const UA = (name, fn) => T(name, fn, { skip: NO_GIT })
const ALLOWED_ONCE = R`UPSTREAM AHEAD ALLOWED — origin/main has commit`
UA('UA fixture: the pusher scaffolded its clone', () => { const o = secUA(); ok(o.rUAB.code === 0 && o.pusherStamped, `exit=${o.rUAB.code} out=${o.rUAB.out}`) })
UA('UA1a -AllowUpstreamAhead: no fetch, so no FETCH FAILED line on an unreachable remote', () => {
  const r = secUA().rUA1a
  ok(r.code === 0 && !m(r.out, 'FETCH FAILED'), `exit=${r.code} out=${r.out}`)
})
UA('UA1 failed fetch: one FETCH FAILED line, no hit, the dry run proceeds (freshness limit)', () => {
  const r = secUA().rUA1
  ok(r.code === 0 && countRx(r.out, R`FETCH FAILED — git fetch origin exited \d+; the upstream-ahead check reads the remote-tracking refs as of the last fetch \(ywr-harness ADR 0137\)\.`) === 1 &&
    !m(r.out, 'not in this checkout') && !m(r.out, 'UPSTREAM AHEAD') && !m(r.out, 'ua-missing'), `exit=${r.code} out=${r.out}`)
})
UA('UA1b unfetched push: the self-fetch moves origin/main and the dry run REFUSES, saying the refs are fresh', () => {
  const o = secUA(); const r = o.rUA1b
  ok(r.code === 1 && o.uaFetchedMoved && cm(r.out, REF_LINE) &&
    m(r.out, R`This run fetched the remote-tracking refs just before the check \(ywr-harness ADR 0137\)\.`) && !m(r.out, 'FETCH FAILED') &&
    !m(r.out, "as of the last fetch — 'git fetch' first") && !o.uaCStampedAfter1b, `exit=${r.code} out=${r.out}`)
})
UA('UA fixture: the stale clone has the pusher commit fetched but not merged', () => ok(secUA().fixtureFetchedNotMerged, `sha='${secUA().uaSha}'`))
for (const mode of ['dry run', 'real run', '-Force run']) {
  UA(`UA2 ${mode}: REFUSED with exit 1, naming the ref, the sha and the date`, () => {
    const o = secUA(); const r = o.ua2[mode].r
    ok(r.code === 1 && cm(r.out, REF_LINE) && m(r.out, esc(`newest ${o.uaSha}, `)) &&
      m(r.out, R`\d{4}-\d{2}-\d{2}\): another clone scaffolded or refreshed this repo and pushed\. Nothing was written\.`), `exit=${r.code} out=${r.out}`)
  })
  UA(`UA2 ${mode}: the remedy, the freshness limit and the override are named`, () => {
    const r = secUA().ua2[mode].r
    ok(m(r.out, R`Remedy: pull first \(git pull, or merge/rebase origin/main\), then re-run`) && m(r.out, 'This run fetched the remote-tracking refs just before the check') &&
      m(r.out, 'with --allow-upstream-ahead'), r.out)
  })
  UA(`UA2 ${mode}: nothing was written (no stamp, no placement, no wiring, tree unchanged)`, () => ok(secUA().ua2[mode].unchanged, 'the refused run changed the tree'))
}
UA('UA2b -DryRun -AllowUpstreamAhead: ALLOWED once, exit 0, no refusal', () => {
  const r = secUA().rUA2b
  ok(r.code === 0 && countRx(r.out, ALLOWED_ONCE) === 1 && !cm(r.out, R`REFUSED — origin/main`), `exit=${r.code} out=${r.out}`)
})
UA('UA2b -DryRun -AllowUpstreamAhead: nothing was written', () => ok(secUA().ua2bUnchanged, 'the dry run changed the tree'))
UA('UA3 -AllowUpstreamAhead proceeds with exit 0 and says so once', () => {
  const r = secUA().rUA3
  ok(r.code === 0 && countRx(r.out, ALLOWED_ONCE) === 1 && m(r.out, R`proceeding because --allow-upstream-ahead was given \(ywr-harness ADR 0135\)`) && !cm(r.out, R`REFUSED — origin/main`), `exit=${r.code} out=${r.out}`)
})
UA('UA3 the scaffold was placed and stamped', () => ok(secUA().ua3Placed, secUA().rUA3.out))
UA('UA5 fixture: origin/main is ahead of the stale clone by the toolchain-only commit', () => ok(secUA().ua5Fixture, 'the fixture is not toolchain-only'))
UA('UA5 a toolchain-only upstream commit: no refusal, exit 0 (the stamp is the only path)', () => {
  const r = secUA().rUA5
  ok(r.code === 0 && !cm(r.out, 'REFUSED —') && !m(r.out, 'not in this checkout') && !m(r.out, 'UPSTREAM AHEAD'), `exit=${r.code} out=${r.out}`)
})
UA('UA6 fixture: the clone carries the OLD stamp committed', () => ok(secUA().ua6Fixture, 'the stale clone is not at the old stamp'))
UA('UA6 older stamp committed, upstream bumped it: REFUSED with exit 1, naming the ref and the newest sha', () => {
  const o = secUA(); const r = o.rUA6
  ok(r.code === 1 && cm(r.out, REF_LINE) && m(r.out, esc(`newest ${o.uaSha6}, `)), `exit=${r.code} out=${r.out}`)
})
UA('UA7 fixture: a plain walk still sees the pre-rewrite commit (so only --cherry-pick explains the silence)', () => ok(secUA().ua7Fixture, 'the amend did not diverge from origin/main'))
UA('UA7 an amended stamp commit is patch-equivalent: no refusal', () => {
  const r = secUA().rUA7
  ok(r.code === 0 && !cm(r.out, 'REFUSED —') && !m(r.out, 'not in this checkout') && !m(r.out, 'UPSTREAM AHEAD'), `exit=${r.code} out=${r.out}`)
})
UA('UA8 hung fetch: stopped at the timeout with one FETCH FAILED line, the run goes on (exit 0)', () => {
  const o = secUA(); const r = o.rUA8
  ok(r.code === 0 && countRx(r.out, R`FETCH FAILED — git fetch origin did not finish in 1 s and was stopped; the upstream-ahead check reads the remote-tracking refs as of the last fetch \(ywr-harness ADR 0137\)\.`) === 1 &&
    o.ua8Elapsed < 20, `exit=${r.code} elapsed=${o.ua8Elapsed}s out=${r.out}`)
})
UA('UA8b stopped fetch: the line names the fresh lock (never the old one), deletes neither, exit 0', () => {
  const o = secUA(); const r = o.rUA8b
  ok(r.code === 0 && o.ua8bLocksKept &&
    m(r.out, R`was stopped — it may have left lock file\(s\) \.git/packed-refs\.lock; if no other git command is running, delete them before the next fetch; the upstream-ahead check reads`) &&
    !m(r.out, R`old\.lock`), `exit=${r.code} kept=${o.ua8bLocksKept} out=${r.out}`)
})
// UA4: no remote — case K's target is a git repo with no remote and no commits: unchanged, silent, no guard
// line at all, and no fetch line either (no candidate remote, ADR 0137).
UA('UA4 a git repo with no remote: the guard stays silent and the run exits 0', () => {
  const r = secK().rK
  ok(r.code === 0 && !m(r.out, 'not in this checkout') && !m(r.out, 'UPSTREAM AHEAD') && !m(r.out, 'FETCH FAILED'), `exit=${r.code} out=${r.out}`)
})

// --- T: preserved-seed drift note (ADR 0051) — report only, never a merge ----------------------------
// Issue #44: a repo scaffolded at vN re-runs at vN+k, and its preserved .harness.json /
// .gitattributes silently lack template-side additions (review.derived; the load-bearing
// `.githooks/* text eol=lf` line) that only a hand diff finds.
const tplDecl = () => JSON.parse(read(path.join(templates, 'harness.json')))
const writeJson = (p, obj) => write(p, JSON.stringify(obj, null, 2))
const secT = section(async () => {
  const t = target('seed-drift')
  const declT = tplDecl()
  delete declT.review.derived
  writeJson(path.join(t, '.harness.json'), declT)
  write(path.join(t, '.gitattributes'), '* text=auto eol=lf\n*.sh text eol=lf\n*.ps1 text eol=crlf\n')
  // -DryRun first: the probe is read-only, so it must report identically with nothing written.
  const rT = await runInitA(['-Target', t, '-DryRun'])
  const rTr = await runInitA(['-Target', t])
  return { t, rT, rTr }
})
T('T1 missing declaration key is named (dry run — probe is read-only)', () => ok(m(secT().rT.out, R`template has 1 key\(s\) this seed lacks: review\.derived`), secT().rT.out))
T('T2 missing line is counted and exampled', () => ok(m(secT().rT.out, R`template has 1 line\(s\) this seed lacks, e\.g\. '\.githooks/\* text eol=lf'`), secT().rT.out))
T('T3 the note rides the real run too, which still exits 0', () => ok(secT().rTr.code === 0 && m(secT().rTr.out, R`review\.derived`), `exit=${secT().rTr.code} out=${secT().rTr.out}`))
T('T3 the seeds themselves are untouched (report only)', () => ok(!m(read(path.join(secT().t, '.gitattributes')), esc('.githooks/*')), 'the probe wrote into a seed'))

// T4: a template-complete seed carries NO note — including one with repo-only additions, which
// are normal (the declaration exists to accumulate repo-specific content, ADR 0051's scope is
// template-side additions only).
const secT4 = section(async () => {
  const t4 = target('seed-no-drift')
  const declC = tplDecl()
  declC.repo_only_extra = 'kept'
  writeJson(path.join(t4, '.harness.json'), declC)
  fs.copyFileSync(path.join(templates, 'gitattributes'), path.join(t4, '.gitattributes'))
  return { rT4: await runInitA(['-Target', t4]) }
})
T('T4 complete seeds (with repo-only additions) carry no note', () => ok(secT4().rT4.code === 0 && !m(secT4().rT4.out, 'this seed lacks'), `exit=${secT4().rT4.code} out=${secT4().rT4.out}`))

// T5: an unparseable seed is a REPORTED probe skip — never fatal, never silent.
const secT5 = section(async () => { const t5 = target('seed-bad-json'); write(path.join(t5, '.harness.json'), '{ not json'); return { rT5: await runInitA(['-Target', t5]) } })
T('T5 unparseable seed: probe skip is reported, run exits 0', () => ok(secT5().rT5.code === 0 && m(secT5().rT5.out, 'drift probe skipped'), `exit=${secT5().rT5.code} out=${secT5().rT5.out}`))

// T6: an UNREADABLE line-based seed must not abort the run: an uncaught throw from the probe's read
// of a locked seed would turn a successful placement into a non-zero exit. Windows-gated: the
// exclusive-share lock that forces the read failure is mandatory there and advisory on POSIX (CI's
// windows-latest runs it). Node cannot open a file with no sharing, so a pwsh child holds the lock
// (FileShare.None) while init runs.
const T6SKIP = WIN ? NO_PWSH : 'POSIX — FileShare.None is advisory there; windows-latest CI runs this case'
function withExclusiveLock(file, fn) {
  const script = `$f = [IO.File]::Open(${psq(file)}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Dispose()`
  const child = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const ended = new Promise((resolve) => child.on('exit', resolve))
  return new Promise((resolve, reject) => {
    let buf = ''
    let released = false
    child.on('error', reject)
    child.stdout.on('data', (d) => {
      buf += d
      if (released || !buf.includes('locked')) return
      released = true
      Promise.resolve().then(fn).then((res) => { child.kill(); return ended.then(() => resolve(res)) },
        (err) => { child.kill(); return ended.then(() => reject(err)) })
    })
    child.on('exit', () => { if (!released) reject(new Error(`the lock holder ended before it held the lock: ${buf}`)) })
  })
}
const secT6 = section(async () => {
  const t6 = target('seed-locked')
  const ga = path.join(t6, '.gitattributes')
  write(ga, '* text=auto eol=lf\n')
  return { rT6: await withExclusiveLock(ga, () => runInitA(['-Target', t6])) }
}, { enabled: !T6SKIP })
T('T6 a locked line-based seed is a reported probe skip, run exits 0', () => {
  const { rT6 } = secT6()
  ok(rT6.code === 0 && m(rT6.out, 'drift probe skipped: seed or template could not be read'), `exit=${rT6.code} out=${rT6.out}`)
}, { skip: T6SKIP })
T('T6 the run still completes its tail reports (stamp line present)', () => { const { rT6 } = secT6(); ok(m(rT6.out, 'stamp: '), rT6.out) }, { skip: T6SKIP })

// T7: the root .gitignore joins the line-based drift probe (ADR 0053) — an existing ignore
// missing template lines gets the count + first example, and is never merged into.
const t7gi = 'docs/docs.html\n'
const secT7 = section(async () => { const t7 = target('seed-gitignore-drift'); write(path.join(t7, '.gitignore'), t7gi); return { t7, rT7: await runInitA(['-Target', t7]) } })
T('T7 gitignore drift note names count + first missing line', () =>
  ok(m(secT7().rT7.out, R`= \.gitignore \(existing seed preserved — template has \d+ line\(s\) this seed lacks, e\.g\. 'docs/docs\.artifact\.html'`), secT7().rT7.out))
T('T7 the seed itself is untouched (report only)', () => ok(read(path.join(secT7().t7, '.gitignore')) === t7gi, 'the probe wrote into .gitignore'))

// T8: scaffold gate lines (ADR 0129). Arrays are leaves to the key probe, so a docs group without
// the file-scoped check_docs.mjs line (ADR 0094) would hide it, and that line is the one path by
// which the STE-lite gate (ADR 0128) sees a staged spec. Coverage is per PATH: the emitter runs the
// gates of every group whose match claims a path, so the line must sit in a group that claims the
// path, and the line in some other group is no coverage (docs-generated alone never sees a spec).
// The note names the uncovered scaffold paths, the exact line and the template groups.
const t8Gate = esc(' declares the scaffold gate { "runner": "node", "script": "docs/check_docs.mjs", "files": true } (template: ')
const t8Corpus = R`docs/adr/README\.md, docs/adr/0000-template\.md, docs/spec/README\.md, docs/spec/0000-template\.md, docs/adr/0001-adopt-docs-as-code\.md`
const t8All = `no group claiming ${t8Corpus}, docs/index\\.json${t8Gate}` + R`docs-corpus, docs-generated\)`
// A seed that is the template declaration changed by `mutate`, written with the repo's own formatting.
function newT8Seed(name, mutate) {
  const dir = target(name)
  const d = tplDecl()
  mutate(d)
  writeJson(path.join(dir, '.harness.json'), d)
  return dir
}
const docsGroups = (d, pred) => d.groups.filter(pred)
// One memoized seed + run. `args` and `script` follow runInit; `files` adds fixture files after the seed is made.
function t8Run(name, mutate, { args = [], script = init, setup = () => {} } = {}) {
  return section(async () => {
    const dir = newT8Seed(name, mutate)
    setup(dir)
    return { dir, r: await runInitA(['-Target', dir, ...args], script) }
  })
}
const t8a = t8Run('seed-gate-empty', (d) => { for (const g of docsGroups(d, (g) => g.name.startsWith('docs-'))) g.gates = [] }, { args: ['-DryRun'] })
T('T8a gates: [] in both docs groups names every uncovered path, the line once, the template groups', () =>
  ok(m(t8a().r.out, R`= \.harness\.json \(existing seed preserved — ${t8All}\)`), t8a().r.out))
const t8b = t8Run('seed-gate-whole-program', (d) => { for (const g of docsGroups(d, (g) => g.name.startsWith('docs-'))) g.gates[0].files = false })
T('T8b the pre-ADR 0094 files:false gate is not the line (runner + script + files)', () => ok(t8b().r.code === 0 && m(t8b().r.out, t8All), `exit=${t8b().r.code} out=${t8b().r.out}`))
// The line in docs-generated only: present in the file, absent where specs land.
const t8g = t8Run('seed-gate-generated-only', (d) => { for (const g of docsGroups(d, (g) => g.name === 'docs-corpus')) g.gates = [] })
T('T8g the line in docs-generated alone still names the corpus paths', () =>
  ok(m(t8g().r.out, R`\(existing seed preserved — no group claiming ${t8Corpus}${t8Gate}` + R`docs-corpus\)\)`), t8g().r.out))
// Specs split into their own group without the line: only the spec paths are uncovered.
const t8h = t8Run('seed-gate-split-specs', (d) => {
  for (const g of docsGroups(d, (g) => g.name === 'docs-corpus')) g.match = '^docs/adr/.*\\.md$'
  d.groups.push({ name: 'specs', match: '^docs/spec/.*\\.md$', cwd: '', strip_prefix: '', gates: [] })
})
T('T8h a split-off spec group without the line names the spec paths only', () =>
  ok(m(t8h().r.out, R`\(existing seed preserved — no group claiming docs/spec/README\.md, docs/spec/0000-template\.md${t8Gate}` + R`docs-corpus\)\)`), t8h().r.out))
// Group names are the repo's: a renamed group that claims the paths and carries the line covers them.
// The seed also carries T9b: a narrower docs_only (ADR 0191) adds no note.
const t8c = t8Run('seed-gate-renamed', (d) => {
  for (const g of docsGroups(d, (g) => g.name === 'docs-corpus')) g.name = 'decision-records'
  d.review.docs_only = ['^docs/adr/']
})
T('T8c a renamed group that claims the paths and carries the line gets no note', () =>
  ok(t8c().r.code === 0 && !m(t8c().r.out, 'declares the scaffold gate') && !m(t8c().r.out, 'this seed lacks'), t8c().r.out))
// Selectors and paths are exact to the emitter, so a case variant is not the line.
// The seed also carries T9f: a non-list docs_only (ADR 0191).
const t8d = t8Run('seed-gate-case', (d) => {
  for (const g of docsGroups(d, (g) => g.name.startsWith('docs-'))) g.gates[0].runner = 'Node'
  d.review.docs_only = '^docs/'
})
T('T8d a case-variant runner does not satisfy the line', () => ok(m(t8d().r.out, t8All), t8d().r.out))
// Both halves on one line: the key half first, then the gate half (the ADR 0128 consumer shape).
// The seed also carries T9j: a backtracking docs_only pattern against a root file name (ADR 0191).
const t8e = t8Run('seed-gate-and-key', (d) => {
  delete d.docs.ste_lite
  for (const g of docsGroups(d, (g) => g.name.startsWith('docs-'))) g.gates = []
  d.review.docs_only = ['^(a+)+$']
}, { setup: (dir) => write(path.join(dir, `${'a'.repeat(40)}!`), 'x\n') })
T('T8e a missing docs.ste_lite key and the gate line join with "; "', () =>
  ok(m(t8e().r.out, R`template has 1 key\(s\) this seed lacks: docs\.ste_lite; ${t8All}`), t8e().r.out))
// A top level that is not an object declares no group: reported, never fatal.
const t8f = section(async () => { const dir = target('seed-gate-array'); write(path.join(dir, '.harness.json'), '[]'); return { r: await runInitA(['-Target', dir]) } })
T('T8f a bare-array seed names the gate line and the run exits 0', () => ok(t8f().r.code === 0 && m(t8f().r.out, t8All), `exit=${t8f().r.code} out=${t8f().r.out}`))
// A match that the engine refuses claims nothing, so the note speaks rather than staying silent.
const t8i = t8Run('seed-gate-bad-regex', (d) => { for (const g of docsGroups(d, (g) => g.name === 'docs-generated')) g.match = '^docs/(index' })
T('T8i an unparseable group match leaves its path uncovered, run exits 0', () =>
  ok(t8i().r.code === 0 && m(t8i().r.out, R`no group claiming docs/index\.json${t8Gate}` + R`docs-generated\)`), `exit=${t8i().r.code} out=${t8i().r.out}`))
// T8j: a repo that moved its docs.index (its own declaration) is not probed at the template's
// index path, because that file does not exist there.
const t8j = t8Run('seed-gate-moved-index', (d) => {
  d.docs.index = 'documentation/index.json'
  for (const g of docsGroups(d, (g) => g.name === 'docs-generated')) { g.match = '^documentation/index\\.json$'; g.gates = [] }
})
T('T8j a moved docs.index gets no note for the template index path', () => ok(t8j().r.code === 0 && !m(t8j().r.out, 'declares the scaffold gate'), t8j().r.out))
// T8k: Python's named group spelling is valid to the emitter, so it must claim here too.
const t8k = t8Run('seed-gate-python-named', (d) => { for (const g of docsGroups(d, (g) => g.name === 'docs-corpus')) g.match = '^docs/(?P<k>adr|spec)/.*\\.md$' })
T('T8k a (?P<name>...) match claims its paths (no false gap)', () => ok(!m(t8k().r.out, 'declares the scaffold gate'), t8k().r.out))
// T8l: a pattern Python refuses must not escape the \A(?:...) wrapper and claim every path.
const t8l = t8Run('seed-gate-escape', (d) => {
  for (const g of docsGroups(d, (g) => g.name === 'docs-corpus')) g.gates = []
  d.groups.push({ name: 'greedy', match: '^zz)|(.*', cwd: '', strip_prefix: '', gates: [{ runner: 'node', script: 'docs/check_docs.mjs', files: true }] })
})
T('T8l an unbalanced match claims nothing, so the corpus gap still speaks', () => ok(m(t8l().r.out, R`no group claiming ${t8Corpus}${t8Gate}` + R`docs-corpus\)`), t8l().r.out))
// T8m: the template side is ours — a template match the engine refused would silence the probe for
// every consumer, so every one must compile here, alone and wrapped.
// One node run compiles every template match and docs_only pattern the way init.mjs does (Python's
// (?P<n> spellings translated, alone and wrapped in ^(?:...)) and prints the refused ones.
const rxCheckSrc = [
  "import fs from 'node:fs'",
  "const t = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))",
  "const tr = (s) => s.replace(/\\(\\?P</g, '(?<').replace(/\\(\\?P=(\\w+)\\)/g, '\\\\k<$1>')",
  'const groups = []; const docs = []',
  "for (const g of t.groups) { try { new RegExp(tr(g.match)); new RegExp('^(?:' + tr(g.match) + ')') } catch { groups.push(g.name) } }",
  'for (const p of t.review.docs_only) { try { new RegExp(tr(p)) } catch { docs.push(p) } }',
  'console.log(JSON.stringify({ groups, docs }))',
  '',
].join('\n')
const rxRun = section(async () => {
  const rxCheck = path.join(fxBase, 'template-regex-check.mjs')
  write(rxCheck, rxCheckSrc)
  const run = await invokeNodeScriptA(rxCheck, [path.join(templates, 'harness.json')])
  return { run, refused: JSON.parse(run.out) }
})
T('T8m every template group match compiles in the engine init.mjs uses', () => {
  const { run, refused } = rxRun()
  ok(run.code === 0 && refused.groups.length === 0, `refused: ${refused.groups.join(', ')} run: ${run.out}`)
})
// T8n: a template gate on a script the scaffold does not place is the repo's own, never a
// scaffold gate. Runs a COPY of the skill with that gate added; the real plugin is never modified.
const t8n = section(async () => {
  const ownSkill = copySkill('own-gate-skill')
  const tp = path.join(ownSkill, 'templates', 'harness.json')
  const ownDecl = JSON.parse(read(tp))
  for (const g of ownDecl.groups) if (g.name === 'docs-corpus') g.gates.push({ runner: 'python', script: 'scripts/own_check.py', files: true })
  // The copy also carries T9k: a template docs_only pattern the regex engine cannot read (ADR 0191).
  ownDecl.review.docs_only = [...ownDecl.review.docs_only, '^zz*+']
  writeJson(tp, ownDecl)
  const dir = newT8Seed('seed-gate-own-script', (d) => { d.review.docs_only = ['^CLAUDE\\.md$'] })
  return { r: await runInitA(['-Target', dir], path.join(ownSkill, 'init.mjs')) }
})
T('T8n a template gate on a non-TOOLCHAIN script is never a scaffold gate', () => {
  const { r } = t8n()
  ok(r.code === 0 && !m(r.out, 'own_check') && !m(r.out, 'declares the scaffold gate'), `exit=${r.code} out=${r.out}`)
})
// T8o: an unforeseen throw inside the probe is a reported skip, never a non-zero exit (ADR 0051).
// Runs a COPY of the skill whose probe throws; the real plugin is never modified.
const throwHook = 'function getScaffoldGateNote(template, repo) {'
// The copy also carries T9g: the docs_only probe throws too (ADR 0191).
const t9gHook = 'function getDocsOnlyNote(template, repo) {'
const t8o = section(async () => {
  const throwSkill = copySkill('gate-throw-skill')
  const throwInit = path.join(throwSkill, 'init.mjs')
  const throwSrc = read(throwInit)
  const injected = throwSrc.split(throwHook).join(`${throwHook} throw new Error('injected probe failure');`)
    .split(t9gHook).join(`${t9gHook} throw new Error('injected docs_only failure');`)
  write(throwInit, injected)
  const dir = newT8Seed('seed-gate-throw', () => {})
  return { throwSrc, r: await runInitA(['-Target', dir], throwInit) }
})
T('T8o the probe function signature is where the injection expects it', () => ok(t8o().throwSrc.includes(throwHook), 'signature moved — update the injection'))
T('T9g the probe function signature is where the injection expects it', () => ok(t8o().throwSrc.includes(t9gHook), 'signature moved — update the injection'))
T('T8o a throwing probe is a reported skip, the run exits 0 and still stamps', () => {
  const { r } = t8o()
  ok(r.code === 0 && m(r.out, 'scaffold gate probe skipped: injected probe failure') && m(r.out, 'stamp: '), `exit=${r.code} out=${r.out}`)
})
// T8p: the placed paths are samples. A gated group that claims the placed template files but no real
// spec must still get a note: the real spec under the same directory is probed, and it leads the list
// so the display cap never hides it.
const t8p = t8Run('seed-gate-real-spec', (d) => {
  for (const g of docsGroups(d, (g) => g.name === 'docs-corpus')) g.match = '^docs/(adr|spec)/(0000-template|README|0001-adopt-docs-as-code)\\.md$'
}, { args: ['-DryRun'], setup: (dir) => { mk(path.join(dir, 'docs', 'spec')); write(path.join(dir, 'docs', 'spec', '0002-real.md'), '# real spec\n') } })
T('T8p a real spec outside the gated group is named first, though every placed path is covered', () =>
  ok(m(t8p().r.out, R`\(existing seed preserved — no group claiming docs/spec/0002-real\.md${t8Gate}` + R`docs-corpus\)\)`), t8p().r.out))
// T8q: one alternation per side renumbers capture groups, so a backreference would read another
// group's capture. A repo set with a backreference stays one regex per group: the spec group's
// `\1` must still mean its own `(docs)`, and the real spec it claims gets no note.
const t8q = t8Run('seed-gate-backref', (d) => {
  for (const g of docsGroups(d, (g) => g.name === 'docs-corpus')) g.match = '^docs/(adr)/.*\\.md$'
  d.groups.push({ name: 'specs', match: '^(docs)/spec/(.*\\1|README|0000-template)\\.md$', cwd: '', strip_prefix: '', gates: [{ runner: 'node', script: 'docs/check_docs.mjs', files: true }] })
}, { args: ['-DryRun'], setup: (dir) => { mk(path.join(dir, 'docs', 'spec')); write(path.join(dir, 'docs', 'spec', '0002-docs.md'), '# real spec\n') } })
T('T8q a backreference keeps its own group numbering (no false gap)', () => ok(!m(t8q().r.out, 'declares the scaffold gate'), t8q().r.out))
// T8r: a conditional `(?(1)…)` is a Python construct that JavaScript cannot compile. It is refused like
// any pattern the engine refuses: the group claims nothing, so the note speaks and names the real spec
// it cannot cover.
const t8r = t8Run('seed-gate-conditional', (d) => {
  for (const g of docsGroups(d, (g) => g.name === 'docs-corpus')) g.match = '^docs/(adr)/.*\\.md$'
  d.groups.push({ name: 'specs', match: '^(docs)?(?(1)/spec/.*\\.md|zz)$', cwd: '', strip_prefix: '', gates: [{ runner: 'node', script: 'docs/check_docs.mjs', files: true }] })
}, { args: ['-DryRun'], setup: (dir) => { mk(path.join(dir, 'docs', 'spec')); write(path.join(dir, 'docs', 'spec', '0002-real.md'), '# real spec\n') } })
T('T8r a conditional group reference claims nothing in JavaScript: the note speaks and names the real spec, the run exits 0', () =>
  ok(t8r().r.code === 0 && m(t8r().r.out, R`no group claiming [^;]*docs/spec/0002-real\.md[^;]*declares the scaffold gate`), `exit=${t8r().r.code} out=${t8r().r.out}`))
// T8s: the index's own directory is not listed — the index path itself is the probe. Listing docs/
// would name docs/INDEX.md, which the template's docs-generated claims and this repo narrowed away.
const t8s = t8Run('seed-gate-index-dir', (d) => { for (const g of docsGroups(d, (g) => g.name === 'docs-generated')) g.match = '^docs/index\\.json$' },
  { args: ['-DryRun'], setup: (dir) => { mk(path.join(dir, 'docs')); write(path.join(dir, 'docs', 'INDEX.md'), '# index\n') } })
T('T8s the docs.index directory is not listed', () => ok(!m(t8s().r.out, 'declares the scaffold gate'), t8s().r.out))
// T8t: the listing recurses — a nested spec the repo's flat match misses is named.
const t8Flat = '^docs/(adr|spec)/(?!\\.)[^/]*\\.md$'
const t8t = t8Run('seed-gate-nested', (d) => { for (const g of docsGroups(d, (g) => g.name === 'docs-corpus')) g.match = t8Flat },
  { args: ['-DryRun'], setup: (dir) => { mk(path.join(dir, 'docs', 'spec', 'sub')); write(path.join(dir, 'docs', 'spec', 'sub', '0003-nested.md'), '# nested\n') } })
T('T8t a nested real spec outside the flat match is named', () =>
  ok(m(t8t().r.out, R`\(existing seed preserved — no group claiming docs/spec/sub/0003-nested\.md${t8Gate}` + R`docs-corpus\)\)`), t8t().r.out))
// T8u: hidden entries and directory links are not listed. Each would be a gap under the flat
// match if listed: a hidden draft, and a spec reached only through a linked directory.
const t8u = t8Run('seed-gate-hidden-link', (d) => { for (const g of docsGroups(d, (g) => g.name === 'docs-corpus')) g.match = t8Flat }, {
  args: ['-DryRun'],
  setup: (dir) => {
    mk(path.join(dir, 'docs', 'spec'))
    const hidden = path.join(dir, 'docs', 'spec', '.draft.md')
    write(hidden, '# hidden draft\n')
    if (WIN) spawnSync('attrib', ['+H', hidden], { windowsHide: true })
    const outside = path.join(fxBase, 'gate-link-outside')
    mk(outside)
    write(path.join(outside, 'linked.md'), '# outside\n')
    if (LINK.ok) fs.symlinkSync(outside, path.join(dir, 'docs', 'spec', 'linked'), WIN ? 'junction' : 'dir')
  },
})
T(`T8u a hidden draft${LINK.ok ? ' and a linked directory are' : ' is'} not listed`, () => ok(!m(t8u().r.out, 'declares the scaffold gate'), t8u().r.out))
if (!LINK.ok) T('T8u link half', () => {}, { skip: `could not create a directory link: ${LINK.reason}` })
// T8v: a listing that throws keeps the sample gaps and says where it stopped. Runs a COPY of the skill
// whose listing throws; the real plugin is never modified.
const listHook = 'listFiles(full, true)'
// The copy also carries T9i: the docs_only listing throws too (ADR 0191).
const t9iHook = "listFiles(full, d !== '')"
const t8v = section(async () => {
  const listSkill = copySkill('gate-list-throw-skill')
  const listInit = path.join(listSkill, 'init.mjs')
  const listSrc = read(listInit)
  write(listInit, listSrc.split(listHook).join("(() => { throw new Error('injected listing failure') })()")
    .split(t9iHook).join("(() => { throw new Error('injected docs_only listing failure') })()"))
  const dir = newT8Seed('seed-gate-list-throw', (d) => {
    for (const g of docsGroups(d, (g) => g.name.startsWith('docs-'))) g.gates = []
    d.review.docs_only = ['^CLAUDE\\.md$']
  })
  return { listSrc, r: await runInitA(['-Target', dir], listInit) }
})
T('T8v the listing call is where the injection expects it', () => ok(t8v().listSrc.includes(listHook), 'listing call moved — update the injection'))
T('T9i the docs_only listing call is where the injection expects it', () => ok(t8v().listSrc.includes(t9iHook), 'listing call moved — update the injection'))
T('T8v a throwing listing keeps the sample gaps and names where it stopped', () => {
  const { r } = t8v()
  ok(r.code === 0 && m(r.out, t8All) && m(r.out, R`real-file listing stopped under docs/adr \(injected listing failure\)`), `exit=${r.code} out=${r.out}`)
})
T('T4 a template-complete seed names no scaffold gate', () => ok(!m(secT4().rT4.out, 'declares the scaffold gate'), secT4().rT4.out))

// T9: review.docs_only value probe (ADR 0191, dist #15). Arrays are leaves to the key probe, so a
// docs_only that exempts CLAUDE.md, docs/ code or the stage prompts from review needs this probe. The
// probe names each probe path the repo exempts and the template reviews; the narrower direction is
// safe and silent. T9a is the reported seed value. T9b, T9f, T9g, T9i, T9j and T9k assert on the T8
// runs above, whose seeds or skill copies carry their case: a skill copy costs about a second.
const t9Tmpl = esc(String.raw`(template: ["^docs/(?!prompts/)(?!.*\\.(py|ps1|sh|mjs)$)","^(?!(CLAUDE|AGENTS|REVIEW)\\.md$)[^/]*\\.md$"])`)
const newT9Seed = (name, docsOnly) => newT8Seed(name, (d) => { d.review.docs_only = docsOnly })
// 9 = the 7 placed paths the old value exempts, plus AGENTS.md and docs/tools/gen.py. GOAL.md is
// exempt on both sides, so it is not counted.
const t9a = section(async () => {
  const dir = newT9Seed('seed-docs-only-old', ['^docs/', '^[^/]*\\.md$'])
  write(path.join(dir, 'AGENTS.md'), '# agents\n')
  write(path.join(dir, 'GOAL.md'), '# goal\n')
  mk(path.join(dir, 'docs', 'tools'))
  write(path.join(dir, 'docs', 'tools', 'gen.py'), 'print(1)\n')
  const r = await runInitA(['-Target', dir, '-DryRun'])
  return { r, line: r.out.split('\n').filter((l) => m(l, R`= \.harness\.json `)).join(' ') }
})
T('T9a the old docs_only value names the count, the first paths and the template value', () => {
  const { r, line } = t9a()
  ok(r.code === 0 && m(line, R`\(existing seed preserved — review\.docs_only exempts 9 probed path\(s\) the template reviews: ` +
    R`docs/build\.mjs, docs/build\.sh, docs/build_docs\.mjs, docs/check_docs\.mjs, CLAUDE\.md, docs/prompts/review-start\.md, \+3 more ${t9Tmpl}\)`), `exit=${r.code} line=${line}`)
})
T('T9a the probe holds no copy of the template exclusions', () => ok(!m(read(init), R`CLAUDE\|AGENTS`), 'init.mjs names the exclusion regex'))
T('T9b a narrower docs_only gets no note', () => ok(t8c().r.code === 0 && !m(t8c().r.out, R`review\.docs_only`), t8c().r.out))
T('T9b a template-complete seed gets no docs_only note', () => ok(!m(secT4().rT4.out, R`review\.docs_only`), secT4().rT4.out))
// T9c: one seed for the pattern forms. `prompts/` is unanchored and matches mid-path, as the emitter's
// rx.search does. A Python named group converts. A pattern the regex engine refuses and a non-string item are
// named as not compared, and the other patterns still compare. A real root file follows the placed
// paths in the displayed list. The scaffold places no REVIEW.md (ADR 0217), and the probe still lists
// one as a real root file.
const t9c = section(async () => {
  const dir = newT9Seed('seed-docs-only-forms', ['prompts/', '^(?P<n>CLAUDE)\\.md$', '^zz*+', 5, '^(REVIEW|AGENTS)\\.md$'])
  write(path.join(dir, 'AGENTS.md'), '# agents\n')
  write(path.join(dir, 'REVIEW.md'), '# review\n')
  return { r: await runInitA(['-Target', dir, '-DryRun']) }
})
T('T9c unanchored and named-group patterns compare; a refused pattern and a non-string item are not compared', () => {
  const { r } = t9c()
  ok(r.code === 0 && m(r.out, R`review\.docs_only exempts 5 probed path\(s\) the template reviews: CLAUDE\.md, ` +
    R`docs/prompts/review-start\.md, docs/prompts/ready-report\.md, AGENTS\.md, REVIEW\.md \(template: [^;]*\); review\.docs_only: 2 pattern\(s\) the regex engine cannot read, not compared`), r.out)
})
T('T9f a non-list docs_only is named as not compared, the run exits 0', () =>
  ok(t8d().r.code === 0 && m(t8d().r.out, R`; review\.docs_only is not a list, not compared\)`), `exit=${t8d().r.code} out=${t8d().r.out}`))
T('T9g a throwing probe is a reported skip, the run exits 0 and still stamps', () => {
  const { r } = t8o()
  ok(r.code === 0 && m(r.out, R`review\.docs_only probe skipped: injected docs_only failure`) && m(r.out, 'stamp: '), `exit=${r.code} out=${r.out}`)
})
T('T9i a throwing listing keeps the placed-path gap and names where it stopped', () => {
  const { r } = t8v()
  ok(r.code === 0 && m(r.out, R`exempts 1 probed path\(s\) the template reviews: CLAUDE\.md \(template: `) &&
    m(r.out, R`docs_only listing stopped under \. \(injected docs_only listing failure\)`), `exit=${r.code} out=${r.out}`)
})
T('T9j a backtracking pattern is a reported skip, the run exits 0', () =>
  ok(t8e().r.code === 0 && m(t8e().r.out, R`review\.docs_only probe skipped: [^\r\n]*timed out`), `exit=${t8e().r.code} out=${t8e().r.out}`))
T('T9k a template pattern the regex engine cannot read is a skip line, never a false list', () => {
  const { r } = t8n()
  ok(r.code === 0 && m(r.out, R`review\.docs_only probe skipped: a template pattern the regex engine cannot read`) && !m(r.out, R`review\.docs_only exempts`), `exit=${r.code} out=${r.out}`)
})
// T9h: the template side is ours — a template pattern the engine refused would compare nothing.
T('T9h every template docs_only pattern compiles in the engine init.mjs uses', () => {
  const bad = rxRun().refused.docs
  ok(bad.length === 0, `refused: ${bad.join(', ')}`)
})

// --- U: first-run TOOLCHAIN collision refuses (ADR 0055, issue #50) ----------------------------------
// A brownfield repo's own docs/README.md must not be silently replaced and labeled "toolchain
// refreshed from canon" on the FIRST run. No stamp file means first run. A differing file at a
// toolchain path is then refused, the stamp is withheld (else the next run would overwrite and the
// guard would defeat itself), and -Force is the deliberate replacement.
const ownDocs = "# my own docs index — not the canon's\n"
const secU = section(async () => {
  const u = target('first-run-collision')
  mk(path.join(u, 'docs'))
  write(path.join(u, 'docs', 'README.md'), ownDocs)
  const rU1 = await runInitA(['-Target', u])
  const o = { u, rU1, docsAfterU1: read(path.join(u, 'docs', 'README.md')), stampAfterU1: isFile(path.join(u, '.harness-version')) }
  // U2: the protection is not one-shot — with the stamp withheld, a re-run is STILL a first run.
  o.rU2 = await runInitA(['-Target', u]); o.stampAfterU2 = isFile(path.join(u, '.harness-version'))
  // U3: -DryRun shows the same refusal (the SKILL.md brownfield advice depends on this).
  o.rU3 = await runInitA(['-Target', u, '-DryRun'])
  // U4: -Force replaces, labeled truthfully (never "refreshed"), and the run then stamps.
  o.rU4 = await runInitA(['-Target', u, '-Force'])
  o.docsAfterU4 = read(path.join(u, 'docs', 'README.md')); o.stampAfterU4 = isFile(path.join(u, '.harness-version')) && eqi(stampOf(u), manifestVer)
  return o
})
T('U1 first-run collision refuses, run exits 0', () => {
  const { rU1 } = secU()
  ok(rU1.code === 0 && m(rU1.out, R`docs/README\.md REFUSED — first run found an existing file at this TOOLCHAIN path`), `exit=${rU1.code} out=${rU1.out}`)
})
T('U1 the colliding file survives byte-identical', () => ok(secU().docsAfterU1 === ownDocs, 'first run overwrote a pre-existing file'))
T('U1 refusal is counted (docs/README.md)', () => ok(m(secU().rU1.out, 'refused=1'), secU().rU1.out))
T('U1 the stamp is withheld while refusals stand', () => ok(!secU().stampAfterU1 && m(secU().rU1.out, 'stamp: NOT written'), secU().rU1.out))
T('U1 never labeled as a canon refresh', () => ok(!m(secU().rU1.out, R`docs/README\.md \(toolchain refreshed`), secU().rU1.out))
// "First run" is inferred from the stamp's absence, and a scaffolded repo can lose its stamp, so the
// refusal must state the inference and the stamp-lost remedy and never assert the file's origin as fact.
T('U1 the refusal states the inference and the stamp-lost remedy', () => ok(m(secU().rU1.out, 'Nothing marks it as this scaffold') && m(secU().rU1.out, 'only the stamp is missing'), secU().rU1.out))
T('U2 re-run still refuses (stamp was withheld, so still a first run)', () => ok(m(secU().rU2.out, 'REFUSED — first run') && !secU().stampAfterU2, secU().rU2.out))
T('U3 dry run shows the refusal too', () => ok(m(secU().rU3.out, 'REFUSED — first run'), secU().rU3.out))
T('U4 -Force replaces with the truthful label', () => {
  const { rU4 } = secU()
  ok(rU4.code === 0 && m(rU4.out, R`docs/README\.md \(REPLACED a pre-existing non-canon file under --force`) && m(rU4.out, 'replaced=1'), `exit=${rU4.code} out=${rU4.out}`)
})
T('U4 the canon copy is placed', () => ok(secU().docsAfterU4 === read(path.join(templates, 'docs', 'README.md')), 'forced run did not place the canon copy'))
T('U4 the stamp is written once resolved', () => ok(secU().stampAfterU4, secU().rU4.out))
// U5: identical content at a toolchain path is a silent no-op, never a refusal — a repo that
// hand-copied a canon file must not be told to merge with itself.
const secU5 = section(async () => {
  const u5 = target('first-run-identical')
  mk(path.join(u5, 'docs'))
  fs.copyFileSync(path.join(templates, 'docs', 'README.md'), path.join(u5, 'docs', 'README.md'))
  return { u5, rU5: await runInitA(['-Target', u5]) }
})
T('U5 identical-content collision is a no-op, not a refusal; run stamps', () => {
  const { u5, rU5 } = secU5()
  ok(rU5.code === 0 && !m(rU5.out, 'REFUSED — first run') && isFile(path.join(u5, '.harness-version')), `exit=${rU5.code} out=${rU5.out}`)
})
// U6: a REFUSED hook keeps its mode, because "left byte-identical" includes the executable bit. The
// chmod block must never grant +x to a first-run-refused hook (or a marker-less post-commit), which
// would turn a preserved foreign script into a live hook once wired. POSIX-gated: the mode bit does
// not exist on Windows, and CI ubuntu runs this case.
const U6SKIP = WIN ? 'Windows — no POSIX mode bit; CI ubuntu runs this case' : false
const secU6 = section(async () => {
  const u6 = target('first-run-foreign-hook-mode')
  mk(path.join(u6, '.githooks'))
  write(path.join(u6, '.githooks', 'pre-commit'), '#!/bin/sh\n# my experiment, deliberately not executable\n')
  write(path.join(u6, '.githooks', 'post-commit'), '#!/bin/sh\n# my own post-commit, no marker\n')
  return { u6, rU6: await runInitA(['-Target', u6]) }
}, { enabled: !U6SKIP })
T('U6 refused hooks stay non-executable', () => {
  const { u6, rU6 } = secU6()
  const execRefused = ['.githooks/pre-commit', '.githooks/post-commit'].filter((f) => (fs.statSync(path.join(u6, f)).mode & 0o100) !== 0)
  ok(execRefused.length === 0, `chmod +x landed on: ${execRefused.join(', ')} out=${rU6.out}`)
}, { skip: U6SKIP })
T('U6 a hook this run PLACED is still made executable', () => {
  const { u6, rU6 } = secU6()
  ok((fs.statSync(path.join(u6, '.githooks', 'pre-push')).mode & 0o100) !== 0, rU6.out)
}, { skip: U6SKIP })

// --- AA: first-appearance TOOLCHAIN collision guard (ADR 0074, extending ADR 0055) -------------------
// Case U's guard fires only on a first run, computed once from whether ANY .harness-version stamp
// exists. A repo already stamped by an EARLIER plugin version (e.g. 0.46.0) is not first-run overall,
// but for a path that the scaffold started shipping LATER (docs/check_docs.mjs, ADR 0074) it IS a
// first appearance: that repo may have created its own file at the same plausible name, and nothing
// proves that the canon's file is what sits there. Case U's guard alone would overwrite it and report
// "refreshed", the ADR 0055 data loss. The guard must ask "has this PATH been offered to this repo
// before", not only "has this REPO run before".
// The case ID AA is the first unused name: every single letter A-Z is a case in this file.
const aaForeign = '# my own drift check\n'
const aaIntroducedM = /\['docs\/check_docs\.mjs',\s*'(\d+\.\d+\.\d+)'\]/u.exec(read(path.join(here, 'placement.mjs')))
const secAA = section(async () => {
  const aa = target('introduced-later')
  const rAA0 = await runInitA(['-Target', aa])
  // Roll the stamp back to BEFORE the path's introduction, and drop in a plausible foreign file at
  // the SAME name the canon uses (the collision the guard exists for is same-name, not same-content).
  write(path.join(aa, '.harness-version'), '0.46.0')
  write(path.join(aa, 'docs', 'check_docs.mjs'), aaForeign)
  // Perturb an OLD-path toolchain file too (no INTRODUCED_IN entry): a 0.46.0 stamp is a normal
  // back-version update for this one, so it must still refresh in the SAME run that refuses
  // check_docs.mjs — proving the guard is scoped per path, not per repo.
  const aaBuilder = path.join(aa, 'docs', 'build.sh')
  write(aaBuilder, '# locally hacked, old-path file')
  // AA1: re-run without -Force refuses, names both versions, leaves the foreign file untouched, and
  // still refreshes the old-path file in the same run.
  const rAA1 = await runInitA(['-Target', aa])
  const o = { aa, rAA0, rAA1, foreignAfter1: read(path.join(aa, 'docs', 'check_docs.mjs')), stampAfter1: stampOf(aa), builderAfter1: read(aaBuilder) }
  // AA2: -Force replaces it, labeled truthfully (never "refreshed"), counted as replaced=1, and the
  // stamp then advances now that nothing stands refused.
  o.rAA2 = await runInitA(['-Target', aa, '-Force'])
  o.checkAfter2 = read(path.join(aa, 'docs', 'check_docs.mjs')); o.stampAfter2 = stampOf(aa)
  return o
})
T('AA setup run exits 0', () => ok(secAA().rAA0.code === 0, `exit=${secAA().rAA0.code}`))
T('AA1 run exits 0', () => ok(secAA().rAA1.code === 0, `exit=${secAA().rAA1.code}`))
T('AA1 REFUSED names the path', () => ok(m(secAA().rAA1.out, R`docs/check_docs\.mjs REFUSED`), secAA().rAA1.out))
// The introducing version is the INTRODUCED_IN entry for the path, read from placement.mjs itself,
// never the manifest version, which moves with every release. A missing entry fails loudly here
// rather than letting the assertion pass on an empty pattern.
T('AA1 placement.mjs carries an INTRODUCED_IN entry for docs/check_docs.mjs', () => ok(Boolean(aaIntroducedM), 'no entry parsed — the guard under test has no version to name'))
T('AA1 the introducing version is named', () => {
  const aaIntroduced = aaIntroducedM ? aaIntroducedM[1] : 'NO-ENTRY-PARSED'
  ok(m(secAA().rAA1.out, `new in ${esc(aaIntroduced)}`), `want 'new in ${aaIntroduced}' in: ${secAA().rAA1.out}`)
})
T("AA1 the repo's stamped version is named", () => ok(m(secAA().rAA1.out, R`stamped 0\.46\.0`), secAA().rAA1.out))
T('AA1 refused is counted (check_docs.mjs)', () => ok(m(secAA().rAA1.out, 'refused=1'), secAA().rAA1.out))
T('AA1 the foreign bytes are unchanged on disk', () => ok(secAA().foreignAfter1 === aaForeign, 'foreign check_docs.mjs was overwritten'))
T('AA1 the stamp is untouched (still the pre-refusal value)', () => ok(secAA().stampAfter1 === '0.46.0', 'refusal rewrote the stamp'))
T('AA1 an OLD-path file still refreshes in the same run (guard is per-path)', () =>
  ok(secAA().builderAfter1 === read(path.join(templates, 'docs', 'build.sh')), 'old-path file did not refresh alongside the refusal'))
T('AA2 -Force replaces, run exits 0', () => ok(secAA().rAA2.code === 0, `exit=${secAA().rAA2.code}`))
T('AA2 the truthful REPLACED label is used', () => ok(m(secAA().rAA2.out, R`docs/check_docs\.mjs \(REPLACED`), secAA().rAA2.out))
T('AA2 replaced is counted', () => ok(m(secAA().rAA2.out, 'replaced=1'), secAA().rAA2.out))
T('AA2 the canon copy is placed', () => ok(secAA().checkAfter2 === read(path.join(templates, 'docs', 'check_docs.mjs')), 'forced run did not place the canon copy'))
T('AA2 the stamp advances once resolved', () => ok(eqi(secAA().stampAfter2, manifestVer), 'stamp did not advance'))

// AA3: byte-identical foreign content at the same stale stamp is a silent no-op, never a
// refusal — a repo that happens to already hold the canon's own bytes must not be told to merge
// with itself.
const secAA3 = section(async () => {
  const aa3 = await scaffolded('introduced-later-identical')
  write(path.join(aa3, '.harness-version'), '0.46.0')
  fs.copyFileSync(path.join(templates, 'docs', 'check_docs.mjs'), path.join(aa3, 'docs', 'check_docs.mjs'))
  return { rAA3: await runInitA(['-Target', aa3]) }
})
T('AA3 identical content is a no-op, not a refusal', () => {
  const { rAA3 } = secAA3()
  ok(rAA3.code === 0 && !m(rAA3.out, R`docs/check_docs\.mjs REFUSED`) && m(rAA3.out, 'refused=0'), rAA3.out)
})
// AA4 (control): a repo already stamped AT the path's introducing version follows the same-version
// drift semantics (ADR 0067): no "new in" refusal, just the revert-and-report path that
// testPathIntroducedAfterStamp never reaches (introduced > stamp is false when they are equal).
const secAA4 = section(async () => {
  const aa4 = await scaffolded('introduced-later-control')
  write(path.join(aa4, 'docs', 'check_docs.mjs'), '# hand edit at the current version')
  const rAA4 = await runInitA(['-Target', aa4])
  cleanRevert(rAA4.out)
  return { rAA4 }
})
T('AA4 no "new in" refusal when already stamped at the introducing version', () => ok(!m(secAA4().rAA4.out, R`docs/check_docs\.mjs REFUSED`), secAA4().rAA4.out))
T("AA4 today's same-version drift semantics still apply (revert + upstream note)", () => ok(m(secAA4().rAA4.out, 'refreshed=1') && m(secAA4().rAA4.out, 'upstream: SAME-VERSION drift'), secAA4().rAA4.out))
// AA5: -DryRun reports the would-be refusal identically, writing nothing.
const aa5Foreign = '# my own drift check (dry run fixture)\n'
const secAA5 = section(async () => {
  const aa5 = await scaffolded('introduced-later-dryrun')
  write(path.join(aa5, '.harness-version'), '0.46.0')
  write(path.join(aa5, 'docs', 'check_docs.mjs'), aa5Foreign)
  return { aa5, rAA5: await runInitA(['-Target', aa5, '-DryRun']) }
})
T('AA5 dry run reports the would-be refusal', () => ok(m(secAA5().rAA5.out, R`docs/check_docs\.mjs REFUSED`), secAA5().rAA5.out))
T('AA5 dry run writes nothing to the foreign file', () => ok(read(path.join(secAA5().aa5, 'docs', 'check_docs.mjs')) === aa5Foreign, 'dry run modified the foreign file'))
T('AA5 dry run leaves the stamp untouched', () => ok(stampOf(secAA5().aa5) === '0.46.0', 'dry run rewrote the stamp'))
// Removing the INTRODUCED_IN comparison from testPathIntroducedAfterStamp, or hardcoding it to false,
// turns AA1 and AA5 red: the refusal never fires, and check_docs.mjs is silently "refreshed". AA3 and
// AA4 are the controls and stay green either way. AA3 never reaches the collision check, because
// place() returns earlier on identical content. AA4's equal-version stamp already fails
// "introduced > stamp" on its own, so it exercises the same-version-drift branch.

// --- V: the install→init E2E of issues #47/#48 — a fresh scaffold must pass its OWN
// full-tree audit (ADR 0041) after the first commit, html surfaces and ledger ignored (ADR 0052/
// 0053), review canon present (ADR 0054), and the growth loop (a new ADR) must stay claimed.
const secV = section(async () => {
  const v = newGitTarget('audit-clean')
  write(path.join(v, 'README.md'), '# fixture repo\n')
  const rV0 = await runInitA(['-Target', v])
  // The first commit exactly as SKILL.md instructs (`git add -A` + commit). The placed hooks
  // are bypassed via a nonexistent hooksPath: their behavior is githooks.selftest.mjs's job,
  // and this case must measure the audit, not the hooks.
  git_result(v, ['add', '-A'])
  git_result(v, ['-c', 'core.hooksPath=.git/no-hooks', 'commit', '-q', '-m', 'scaffold'])
  const tracked = git_result(v, ['ls-files']).stdout.split('\n').map((l) => l.replace(/\r$/u, '')).filter(Boolean)
  const o = { v, rV0, tracked, ignored: git_result(v, ['check-ignore', '-q', '.claude/telemetry/delegations/slot-00.json']).status }
  const audit = async () => (await invokeNodeScriptA(path.join(v, 'scripts', 'harness', 'harness_gates.mjs'), ['--all', '--repo', v])).out
  o.rV1 = await audit()
  // The growth loop: After-running step 3 writes an ADR, and the audit must stay green (issue #47).
  write(path.join(v, 'docs', 'adr', '0002-first-decision.md'), '---\nid: "0002"\n---\n# 0002. first\n')
  o.rV2 = await audit()
  return o
}, { enabled: GIT })
const V = (name, fn) => T(name, fn, { skip: NO_GIT })
V('V scaffold run exits 0', () => ok(secV().rV0.code === 0, `exit=${secV().rV0.code} out=${secV().rV0.out}`))
V('V regenerable html surfaces stayed out of the first commit (ADR 0053)', () =>
  ok(!secV().tracked.some((l) => m(l, R`docs/docs\.html|docs/docs\.artifact\.html`)), `tracked: ${secV().tracked.join(', ')}`))
V('V committed outputs ARE tracked (index.json + INDEX.md)', () => {
  const tr = secV().tracked.map((l) => l.toLowerCase())
  ok(tr.includes('docs/index.json') && tr.includes('docs/index.md'), `tracked: ${secV().tracked.join(', ')}`)
})
V('V telemetry ledger path is ignored before it exists (audit M3)', () => ok(secV().ignored === 0, 'check-ignore says not ignored'))
V('V full-tree audit reports ZERO ungrouped (the #47 red first push)', () => ok(!m(secV().rV1, R`ungrouped \(`), secV().rV1))
V('V review canon is FOUND (the #49 first-close hard stop)', () => ok(!m(secV().rV1, 'NOT FOUND'), secV().rV1))
V('V a newly written ADR stays claimed (docs-corpus group)', () => ok(!m(secV().rV2, R`ungrouped \(`), secV().rV2))

// --- W: CI push-trigger warning (ADR 0062, issue #55) ------------------------------------------------
// The vendored workflow enumerates `branches: [main, master]`; a repo whose default branch is
// outside that list never gets a push run and GitHub never registers the workflow. The scaffold is
// the only step that knows the repo, so it warns — and stays quiet when the branch is in the list
// or origin/HEAD is unset (the current branch is a guess, not a default-branch signal).
const secW = section(async () => {
  const w1 = newGitTarget('ci-trigger-develop')
  git_result(w1, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'])
  const rW1 = await runInitA(['-Target', w1])
  const w2 = newGitTarget('ci-trigger-master')
  git_result(w2, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master'])
  return { rW1, rW2: await runInitA(['-Target', w2]) }
}, { enabled: GIT })
T('W1 a default branch outside [main, master] is warned about', () => ok(m(secW().rW1.out, "ci trigger: default branch 'develop' is NOT in"), secW().rW1.out), { skip: NO_GIT })
T('W1 the warning does not fail the run', () => ok(secW().rW1.code === 0, `exit=${secW().rW1.code}`), { skip: NO_GIT })
T('W2 a default branch IN the list prints no ci trigger line', () => ok(!m(secW().rW2.out, 'ci trigger:'), secW().rW2.out), { skip: NO_GIT })
// K's fixture is a remote-less repo: origin/HEAD unset -> quiet, never a guess from HEAD.
T('W3 unset origin/HEAD prints no ci trigger line', () => ok(!m(secK().rK.out, 'ci trigger:'), secK().rK.out), { skip: NO_GIT })

// --- X: same-version conflict signal (ADR 0067) ------------------------------------------------------
// stamp == running version + toolchain drift = a local hand edit the re-run reverts (the #55
// shape). The block must fire on dry AND real runs, save pre-revert copies on the real one,
// stay quiet across versions (an older stamp is expected canon change), and fold to the dogfood
// note — with no copies — when the plugin runs from inside the target tree.
const secX = section(async () => {
  const x = await scaffolded('same-version-drift')
  const xEdit = path.join(x, 'scripts', 'harness', 'harness_gates.mjs')
  write(xEdit, '# local patch (issue #55 shape)')
  // X1: dry run — block printed, nothing changed, no copies made or named.
  const rX1 = await runInitA(['-Target', x, '-DryRun'])
  const o = { x, xEdit, rX1, editAfterX1: read(xEdit) }
  // X2: real run — revert happens, block + copies dir printed, the copy holds the LOCAL content.
  o.rX2 = await runInitA(['-Target', x])
  o.editAfterX2 = read(xEdit)
  o.xDir = (/pre-revert copies: (.+)/u.exec(o.rX2.out)?.[1] ?? '').trim()
  o.xBak = o.xDir ? path.join(o.xDir, 'scripts', 'harness', 'harness_gates.mjs') : ''
  o.bakHoldsLocal = Boolean(o.xBak) && isFile(o.xBak) && m(read(o.xBak), 'local patch')
  if (o.xDir && exists(o.xDir)) rmQuiet(o.xDir)
  return o
})
T('X1 dry run prints the SAME-VERSION block', () => ok(m(secX().rX1.out, 'upstream: SAME-VERSION drift'), secX().rX1.out))
T('X1 dry run says to report BEFORE the real run', () => ok(m(secX().rX1.out, 'BEFORE the real run'), secX().rX1.out))
T('X1 dry run leaves the local edit in place', () => ok(m(secX().editAfterX1, 'local patch'), 'edit reverted by a DRY run'))
T('X1 dry run names no pre-revert copies', () => ok(!m(secX().rX1.out, 'pre-revert copies:'), secX().rX1.out))
T('X1 the report pointer is the namespaced skill', () => ok(m(secX().rX1.out, '/ywr-harness:report-issue'), secX().rX1.out))
T('X2 real run prints the SAME-VERSION block', () => ok(m(secX().rX2.out, 'upstream: SAME-VERSION drift'), secX().rX2.out))
T('X2 the file is reverted to canon', () => ok(!m(secX().editAfterX2, 'local patch'), 'local edit survived a real refresh'))
T('X2 pre-revert copy exists and holds the local content', () => ok(secX().bakHoldsLocal, `dir='${secX().xDir}' out=${secX().rX2.out}`))
// The dir name must carry a per-process component after the second-resolution timestamp, because two
// same-second runs that share the dir would overwrite each other's backups.
T('X2 copies dir name ends in timestamp-pid, never timestamp alone', () => ok(m(secX().xDir, R`-\d{8}-\d{6}-\d+$`), `dir='${secX().xDir}'`))

// X3: an OLDER stamp is a normal update — refresh happens, no conflict verdict. The drifted file is one
// that no INTRODUCED_IN entry names: a file at a path introduced after the stamp is refused, not refreshed (AA).
const secX3 = section(async () => {
  const x3 = await scaffolded('cross-version-drift')
  write(path.join(x3, 'docs', 'build.sh'), '# local patch')
  write(path.join(x3, '.harness-version'), '0.0.1\n')
  return { rX3: await runInitA(['-Target', x3]) }
})
T('X3 older-stamp drift refreshes WITHOUT the block', () => ok(m(secX3().rX3.out, 'refreshed=1') && !m(secX3().rX3.out, 'SAME-VERSION drift'), secX3().rX3.out))
// X4: same version, clean tree — no upstream line at all.
const secX4 = section(async () => { const [{ x }] = await after(secX); return { rX4: await runInitA(['-Target', x]) } })
T('X4 no drift, no upstream line', () => ok(!m(secX4().rX4.out, 'upstream:'), secX4().rX4.out))

// X6: an ALL-FAILED copy run must say FAILED and must NOT print the "pre-revert copies:" line: the dir
// name is assigned before the copy that can fail, so an unguarded print would name a dir that holds
// nothing. The refresh itself must still proceed. Failure is injected by pointing the CHILD's temp at
// a fixture whose 'ywr-harness-reverted' is a FILE, so the backup dir cannot be created. os.tmpdir()
// reads TMP/TEMP (Windows) and TMPDIR (POSIX).
const secX6 = section(async () => {
  const x6 = await scaffolded('copy-fail-drift')
  write(path.join(x6, 'scripts', 'harness', 'harness_gates.mjs'), '# local patch')
  const x6Tmp = target('copy-fail-tmp')
  write(path.join(x6Tmp, 'ywr-harness-reverted'), 'a file where the dir must go')
  const rX6 = await runInitA(['-Target', x6], init, { TMP: x6Tmp, TEMP: x6Tmp, TMPDIR: x6Tmp })
  return { x6, rX6, after: read(path.join(x6, 'scripts', 'harness', 'harness_gates.mjs')) }
})
T('X6 all-failed copies: FAILED line names the file, run exits 0', () => {
  const { rX6 } = secX6()
  ok(rX6.code === 0 && m(rX6.out, R`pre-revert copy FAILED for: .*harness_gates\.mjs`), `exit=${rX6.code} out=${rX6.out}`)
})
T('X6 all-failed copies: the "pre-revert copies:" line is NOT printed', () => ok(!m(secX6().rX6.out, 'pre-revert copies:'), secX6().rX6.out))
T('X6 the refresh still proceeded (copy failure never blocks the update path)', () => ok(!m(secX6().after, 'local patch'), 'local edit survived'))

// X5: in-tree run (the canon dogfood shape, ADR 0018) — the verdict folds to the visible note:
// no report prompt, no pre-revert copies. Fixture: this whole skill dir + the plugin manifest
// copied INSIDE the target, then THAT init.mjs is run against the target.
const secX5 = section(async () => {
  const x5 = target('dogfood-intree')
  const x5Skill = path.join(x5, 'plugins', 'p', 'skills', 'harness-init')
  mk(path.dirname(x5Skill))
  fs.cpSync(here, x5Skill, { recursive: true, force: true, filter: (src) => !/\.selftest\.(mjs|ps1)$/u.test(src) })
  mk(path.join(x5, 'plugins', 'p', 'scripts'))
  fs.copyFileSync(path.join(pluginRoot, 'scripts', 'harness_git.mjs'), path.join(x5, 'plugins', 'p', 'scripts', 'harness_git.mjs'))
  mk(path.join(x5, 'plugins', 'p', '.claude-plugin'))
  fs.copyFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), path.join(x5, 'plugins', 'p', '.claude-plugin', 'plugin.json'))
  const x5Init = path.join(x5Skill, 'init.mjs')
  await runInitA(['-Target', x5], x5Init)
  write(path.join(x5, 'scripts', 'harness', 'harness_gates.mjs'), '# canon-side propagation edit')
  return (await runInitA(['-Target', x5], x5Init)).out
})
// `cm` is case-sensitive: the dogfood note itself says "same-version drift" in lowercase, and `m` is
// case-insensitive. The second assertion is the real discriminator: the dogfood note never prompts
// for a report.
T('X5 in-tree run prints the dogfood note, not the report prompt', () =>
  ok(m(secX5(), 'canon dogfood') && !cm(secX5(), 'SAME-VERSION drift') && !m(secX5(), 'ywr-harness:report-issue'), secX5()))
T('X5 in-tree run makes no pre-revert copies', () => ok(!m(secX5(), 'pre-revert copies:'), secX5()))

// --- RT1: a retired file is named, never removed (ADR 0220) ------------------------------------------
// docs/build.ps1 is a docs wrapper that the scaffold no longer places (docs/build.mjs replaces it). A
// re-run never deletes a file, so a repo that took an older scaffold still holds it: init names it
// once, on a dry run and a real run alike, asks for `git rm`, leaves the file byte-identical, and
// changes neither the exit code nor the stamp. The line starts with neither `~` nor `!`, the two
// shapes that report-issue reads as drift or foreign.
const rtOld = '# the wrapper an older scaffold placed\n'
const rtLine = '^  retired: docs/build\\.ps1 — ywr-harness no longer places this file since 0\\.84\\.0 \\(ywr-harness ADR 0220\\); delete it with git rm\\r?$'
const secRT1 = section(async () => {
  const rt = target('retired-file')
  const rtFirst = await runInitA(['-Target', rt])
  write(path.join(rt, 'docs', 'build.ps1'), rtOld)
  const modes = {}
  for (const [mode, args] of [['dry run', ['-Target', rt, '-DryRun']], ['real run', ['-Target', rt]]]) {
    const r = await runInitA(args)
    modes[mode] = { r, same: read(path.join(rt, 'docs', 'build.ps1')) === rtOld, stamp: stampOf(rt) }
  }
  return { rtFirst, modes }
})
for (const mode of ['dry run', 'real run']) {
  T(`RT1 ${mode}: the retired file is named once, with the git rm advice`, () => {
    const { r } = secRT1().modes[mode]
    ok(r.code === 0 && countRx(r.out, rtLine, 'gm') === 1 && countRx(r.out, 'retired:') === 1, `exit=${r.code} out=${r.out}`)
  })
  T(`RT1 ${mode}: the line starts with neither ~ nor !, and the file is left byte-identical`, () => {
    const { r, same } = secRT1().modes[mode]
    ok(!m(r.out, R`(?m)^\s*[~!] .*docs/build\.ps1`) && same, `out=${r.out}`)
  })
  T(`RT1 ${mode}: the stamp still names this plugin and nothing else is refused`, () => {
    const { r, stamp } = secRT1().modes[mode]
    ok(eqi(stamp, manifestVer) && m(r.out, 'refused=0'), `out=${r.out}`)
  })
}
T('RT1 a target without the retired file gets no retired line', () => ok(!m(secB().rB.out, 'retired:') && !m(secRT1().rtFirst.out, 'retired:'), `out=${secB().rB.out}`))

// --- RT2: the seven retired Python files are named, never removed (ywr-harness ADR 0223) ------
// A repo that took the 0.84.0 scaffold holds docs/build_docs.py, docs/check_docs.py and five scripts/harness
// Python files. The update places the .mjs successors, names each old file once with the same git rm advice,
// and leaves every old file byte-identical, on a dry run and a real run alike.
const rt2Names = ['docs/build_docs.py', 'docs/check_docs.py', 'scripts/harness/harness_config.py', 'scripts/harness/harness_gates.py',
  'scripts/harness/harness_retro.py', 'scripts/harness/verify_map.py', 'scripts/harness/slice_note.py']
const rt2Body = '# a file the 0.84.0 scaffold placed\n'
const secRT2 = section(async () => {
  const rt2 = target('retired-python')
  const rt2First = await runInitA(['-Target', rt2])
  for (const n of rt2Names) { mk(path.dirname(path.join(rt2, n))); write(path.join(rt2, n), rt2Body) }
  const modes = {}
  for (const [mode, args] of [['dry run', ['-Target', rt2, '-DryRun']], ['real run', ['-Target', rt2]]]) {
    const r = await runInitA(args)
    const lines = [...r.out.matchAll(/^ {2}retired: (\S+) — ywr-harness no longer places this file since 0\.85\.0 \(ywr-harness ADR 0223\); delete it with git rm\r?$/gmu)].map((x) => x[1])
    modes[mode] = { r, lines, same: rt2Names.every((n) => read(path.join(rt2, n)) === rt2Body), successor: isFile(path.join(rt2, 'scripts', 'harness', 'harness_gates.mjs')) }
  }
  return { rt2First, modes }
})
for (const mode of ['dry run', 'real run']) {
  T(`RT2 ${mode}: each of the seven Python files is named once, and nothing else is`, () => {
    const { r, lines } = secRT2().modes[mode]
    ok(r.code === 0 && [...lines].sort().join(',') === [...rt2Names].sort().join(',') && countRx(r.out, 'retired:') === 7, `exit=${r.code} out=${r.out}`)
  })
  T(`RT2 ${mode}: every old file is left byte-identical and the Node successors are placed`, () => {
    const { same, successor } = secRT2().modes[mode]
    ok(same && successor, 'an old file changed, or a successor is missing')
  })
}
T('RT2 a target without the old Python files gets no retired line', () => ok(!m(secRT2().rt2First.out, 'retired:'), `out=${secRT2().rt2First.out}`))

// --- P: a non-git target places the hooks and says they will not run ---------------------------------
// The fixture targets in A-J are plain directories, so this is the branch they all exercised
// implicitly. Asserted explicitly so "placed but inert" can never become silent.
T('P non-git target reports the hooks are not wired', () => ok(m(secA().rA.out, 'hooks: .*(not a git repository|NOT set)'), secA().rA.out))
