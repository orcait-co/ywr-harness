// Self-test for report-issue.mjs (ADR 0064, spec 0013).
// Usage: node --test-reporter=<file URL of ../../lib/selftest-reporter.mjs> --test-reporter-destination=stdout skills/report-issue/report-issue.selftest.mjs
//
// The network boundary is `gh`, and every case that would cross it runs against a FAKE gh: a copy of the
// node binary named `gh` (`gh.exe` on Windows) in a fixture directory, put FIRST on a PATH that holds only
// that directory, git's and node's (node runs the refresh-nudge hook report-issue.mjs quotes, ADR 0116; the
// real gh, python and claude are unreachable for the child — the "claude: not on PATH" line is deterministic
// here, unless node's directory also holds claude). report-issue.mjs starts gh by absolute path without a
// shell, so the fake must be a real executable: a `.ps1` or `.cmd` fake cannot start that way. The copy
// runs the preload `fake-gh.cjs` (through NODE_OPTIONS, set by invokeFeedback), which answers as gh when
// the running binary is the copy and does nothing in any other node process. Where gh shares a directory
// with git or node (GitHub's ubuntu runner: /usr/bin), the gh-absent PATH is a private directory of links to
// just those two — see the noGhOk block. The fake logs every argv it receives (one line per call, fields
// joined by U+001F) so the assertions read what gh WAS ASKED, not what a mock returned.
//
// The scaffolded fixture is built by the REAL init.mjs (spec 0009) and then hand-patched, because
// the script's drift section is the refresh nudge's and the dry run's own output — asserting
// against a faked drift would test the fake. Content-leak assertions use a marker string planted
// in the patch: it must be in the repo and NEVER in the body.
//
// This file ports report-issue.selftest.ps1 (ADR 0227). Each test name is the old case name, whose first
// token is the case ID. Patterns are pwsh -match sources (case-insensitive; see toRx in
// lib/selftest-lib.mjs). This suite adds one case: P1 reports the gh-absent premise, which the pwsh
// suite printed as a SKIP line only. The pwsh suite set its fixture environment on
// the process (`GIT_ALLOW_PROTOCOL`, the git identity, the fake-gh mode and log). This suite passes the same
// variables to each child instead, so no case changes the environment of a later one. A Node suite starts
// git through scripts/harness_git.mjs (the one git boundary of the canon, spec 0007 §4).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, matchFailures, innerJobs } from '../../lib/selftest-lib.mjs'
import { which_on_path, git_result, _real_git } from '../../scripts/harness_git.mjs'

const WIN = process.platform === 'win32'
const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, 'report-issue.mjs')
const skillMd = path.join(here, 'SKILL.md')
const pluginRoot = path.resolve(here, '../..')
const initMjs = path.join(pluginRoot, 'skills/harness-init/init.mjs')
const manifestVer = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8')).version
const sep = path.delimiter
const US = String.fromCharCode(0x1f)
const T = '`'
const ch = (...c) => String.fromCharCode(...c)
const escapeRx = (s) => String(s).replace(/[\\*+?|{[()^$.#]/gu, '\\$&')   // [regex]::Escape of .NET

const gitSrc = which_on_path('git')
const gitOk = Boolean(gitSrc)
const gitSkip = 'git not on PATH — report-issue.selftest needs real repos for its fixtures (reported, not silent)'
// A case that needs git: with no git on PATH it is a reported SKIP, never a silent pass.
const tc = (name, fn) => (gitOk ? test(name, fn) : test(name, { skip: gitSkip }, () => {}))

const nodeExe = process.execPath
const nodeDir = path.dirname(nodeExe)

// A child gets the environment of the suite, minus NODE_TEST_CONTEXT, plus the overrides. On Windows the
// PATH variable may be spelled `Path`, so an override removes every spelling first.
function envWith(over) {
  const up = new Set(Object.keys(over).map((k) => k.toUpperCase()))
  const e = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'NODE_TEST_CONTEXT') continue
    if (WIN && up.has(k.toUpperCase())) continue
    e[k] = v
  }
  return Object.assign(e, over)
}

// What Get-Command resolved: the first launchable `name` on a PATH value, or ''. Windows: a PATHEXT entry or
// .ps1. Elsewhere: an executable regular file. A relative entry is skipped.
function resolveUnder(pathVar, name) {
  const exts = WIN ? [...String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean), '.ps1'] : ['']
  for (let dir of String(pathVar ?? '').split(sep)) {
    dir = dir.trim().replace(/^"(.*)"$/u, '$1')
    if (!dir || !path.isAbsolute(dir)) continue
    for (const ext of exts) {
      const p = path.join(dir, name + ext)
      try {
        if (!fs.statSync(p).isFile()) continue
        if (!WIN) fs.accessSync(p, fs.constants.X_OK)
        return p
      } catch { /* absent, dangling or not executable: keep looking */ }
    }
  }
  return ''
}

// ADR 0149 §2 (L2): on Windows the PATH `git` is the cmd\git.exe LAUNCHER (one extra process per git call);
// the narrowed PATHs below carry the worker's directory (mingw64\bin) in its place — but ONLY when that
// directory holds no gh, claude, python (python3 and py too: kept in the guard's list) or node under any
// extension PowerShell would resolve: those names
// are the "unreachable" premise of every narrowed-PATH case here. A directory that shadows one keeps the
// launcher directory and says so with a visible WARN line (never silent). Non-Windows: unchanged.
function getShadowingCommand(dir) {
  const exts = [...new Set(['', ...(WIN ? String(process.env.PATHEXT ?? '').split(';').filter(Boolean) : []), '.ps1'])]
  const hits = []
  for (const name of ['gh', 'claude', 'python', 'python3', 'py', 'node']) {
    for (const e of exts) {
      try { if (fs.statSync(path.join(dir, name + e)).isFile()) hits.push(name + e) } catch { /* absent */ }
    }
  }
  return hits
}
let gitDir = gitOk ? path.dirname(gitSrc) : ''
if (gitOk && WIN) {
  const real = _real_git(gitSrc)
  const gitWorkerDir = real && real !== gitSrc ? path.dirname(real) : ''
  if (gitWorkerDir) {
    const shadow = getShadowingCommand(gitWorkerDir)
    if (shadow.length) console.log(`WARN [L2 git worker dir] ${gitWorkerDir} holds ${shadow.join(', ')}, which the narrowed PATH must not reach — keeping the cmd\\ launcher directory ${gitDir} (ADR 0149 §2)`)
    else gitDir = gitWorkerDir
  }
}

// --- fixture state ---------------------------------------------------------------------------------
const fx = fixtureRoot('feedback-selftest')
after(() => removeFixtureRoot(fx))
// L4 (ADR 0149): the fixture commits take their identity from the environment of each git call — the four
// per-fixture `git config user.*` spawns are gone. Nothing in report-issue.mjs or init.mjs reads user.name/email.
// git is the other network boundary: init.mjs fetches the origin before its upstream-ahead check, under
// --dry-run too (ADR 0137), and the scaffolded fixture's origin is a github.com ssh URL. Unblocked, each of
// the 12 init runs below made a real ssh attempt that failed in ~2 s, so ~24 s of this suite was network
// (fact 131). `file` refuses ssh and https before any transport starts. init.mjs's own fetch code
// still runs as written, and the FETCH FAILED line it prints is the same. N1 proves the refusal holds:
// without it, the suite stays green and goes back to the network.
const gitEnv = {
  GIT_ALLOW_PROTOCOL: 'file',
  GIT_AUTHOR_NAME: 'selftest', GIT_COMMITTER_NAME: 'selftest',
  GIT_AUTHOR_EMAIL: 'selftest@example.invalid', GIT_COMMITTER_EMAIL: 'selftest@example.invalid',
}
const fakeDir = path.join(fx, 'fake-gh')
const fakeGhJs = path.join(fx, 'fake-gh.cjs')
const plain = path.join(fx, 'plain')                 // a repo with no scaffold
const scaff = path.join(fx, 'scaff')
// The preload every child node of a case gets. A case that adds its own preload appends to it (B1d, B1e).
const fakeGhOption = `--require "${fakeGhJs.replaceAll('\\', '/')}"`
const pathWithGh = `${fakeDir}${sep}${gitDir}${sep}${nodeDir}`
let pathNoGh = `${gitDir}${sep}${nodeDir}`
const pathNoNode = `${fakeDir}${sep}${gitDir}`      // B1c: node genuinely absent (checked there)
let noGhOk = true
let noGhNote = ''
let noGhSkip = ''

// The fake gh, as a function whose text becomes fake-gh.cjs: a preload that acts only in the copy of node
// named gh, and exits before node reads argv as a script. It never runs inside this suite. Characters that a
// typed escape could turn into a raw separator are built from code points.
function fakeGhPreload() {
  const path = require('node:path'), fs = require('node:fs')
  if (path.basename(process.execPath).toLowerCase().replace(/\.exe$/, '') === 'gh') {
    const US = String.fromCharCode(31), BS = String.fromCharCode(92)
    // node turned the first argument into an absolute script path; gh's subcommand is its last segment.
    const rest = process.argv.slice(1)
    if (rest.length) rest[0] = path.basename(rest[0])
    const mode = process.env.YWR_FAKE_GH_MODE
    if (process.env.YWR_FAKE_GH_LOG) fs.appendFileSync(process.env.YWR_FAKE_GH_LOG, rest.join(US) + '\n', 'utf8')
    // Synchronous writes, then an immediate exit: node would otherwise go on to load argv[1] as its main module.
    const out = (t) => fs.writeSync(1, t + '\n'), err = (t) => fs.writeSync(2, t + '\n')
    const sub = `${rest[0]} ${rest[1]}`
    let code = 0
    if (sub === 'auth status') { if (mode === 'unauth') { err('You are not logged into any GitHub hosts. To log in, run: gh auth login'); code = 1 } else out('github.com: Logged in') }
    // Kept although report-issue.mjs no longer lists labels (ADR 0085): a regression that re-adds the
    // preflight is then LOGGED (F2b reads the log) instead of dying on the unexpected-subcommand arm.
    else if (sub === 'label list') out('[{"name":"bug"},{"name":"upstream-report"}]')
    else if (sub === 'issue list') {
      if (mode === 'similar') out('[{"number":12,"title":"[upstream-report] acme/widget: same drift"}]')
      // GitHub's server-side shape (ADR 0085): the earlier report was filed by a read-role member,
      // so its label was dropped — a `-l upstream-report` search cannot see it, an unfiltered one can.
      else if (mode === 'unlabelled') out(rest.some(x => x === '-l' || x.startsWith('--label')) ? '[]' : '[{"number":6,"title":"[upstream-report] acme/scaffolded: earlier read-role report","author":{"login":"member-a"}}]')
      // A stranger's issue carrying a published fingerprint, with a hostile title: ESC, NEL, U+2028, CR/LF (JSON escapes).
      else if (mode === 'hostile') out('[{"number":7,"title":"fake' + BS + 'u001b[2Jreport' + BS + 'u0085line' + BS + 'u2028two' + BS + 'r' + BS + 'nthree","author":{"login":"stranger"}}]')
      else if (mode === 'many') out('[' + Array.from({ length: 20 }, (_, i) => `{"number":${i + 1},"title":"dup ${i + 1}"}`).join(',') + ']')
      else out('[]')
    }
    else if (sub === 'issue create') { if (mode === 'createfail') { err('GraphQL: Resource not accessible by integration (createIssue)'); code = 1 } else out('https://github.com/orcait-co/ywr-harness/issues/999') }
    else { err(`fake gh: unexpected subcommand '${sub}'`); code = 64 }
    process.exit(code)
  }
}

before(() => {
  if (!gitOk) return
  fs.mkdirSync(fakeDir, { recursive: true })
  fs.copyFileSync(nodeExe, path.join(fakeDir, WIN ? 'gh.exe' : 'gh'))
  fs.writeFileSync(fakeGhJs, `(${fakeGhPreload.toString()})()\n`, 'utf8')
  // "gh absent" must be TRUE, not assumed: on GitHub's ubuntu runner node, git AND gh can all live in
  // /usr/bin, so a PATH of "git dir + node dir" still resolves the real (unauthenticated) gh — the
  // first CI run of this suite failed F1 on exactly that ("not authenticated" where "not on PATH" was
  // asserted; the pwsh docker image passed only because it has no gh at all). When gh still resolves
  // on the narrowed PATH, a private bin directory holding links to ONLY git and node becomes the
  // gh-absent PATH; if even that leaves gh resolvable, the gh-absent cases are a reported SKIP.
  let ghLeak = resolveUnder(pathNoGh, 'gh')
  if (ghLeak) {
    const binNoGh = path.join(fx, 'bin-nogh')
    fs.mkdirSync(binNoGh, { recursive: true })
    let leakWhy = ghLeak
    try {
      for (const t of [gitSrc, nodeExe]) fs.symlinkSync(t, path.join(binNoGh, path.basename(t)))
      pathNoGh = binNoGh
      ghLeak = resolveUnder(pathNoGh, 'gh')
      leakWhy = ghLeak
    } catch (e) { leakWhy = String(e.message ?? e) }   // a failed link keeps ghLeak set, so the premise is a SKIP
    if (ghLeak) {
      noGhSkip = `gh shares a directory with git/node and a private link dir could not isolate them (${leakWhy}) — F1 and B3 are NOT run (reported, not silent)`
      noGhOk = false
    } else {
      noGhNote = `note: gh shares a directory with git/node here; gh-absent cases use a private link dir (${binNoGh})`
    }
  }
  // fixtures
  fs.mkdirSync(plain, { recursive: true })
  gitq(plain, ['-c', 'init.defaultBranch=main', 'init', '-q'])
  fs.writeFileSync(path.join(plain, 'README.md'), `plain${os.EOL}`)
  gitq(plain, ['add', '-A']); gitq(plain, ['commit', '-q', '-m', 'init'])
})

function gitq(repo, args) { git_result(repo, args, { env: gitEnv }) }

// --- run-ahead ---------------------------------------------------------------------------------------
// Each child run below is independent of the others: it reads a repository of its own (a copy of the
// fixture, made at the state the case expects), writes its drafts to a folder of its own and logs gh calls to
// a file of its own. So every run starts ahead of its test, on a small pool, and the test awaits the result
// and makes the same assertions as before. A copied `.git` folder is a real repository.
const POOL = innerJobs(8, 2)
let activeRuns = 0
const waitingRuns = []
function takeSlot(first) {
  return new Promise((resolve) => {
    const go = () => {
      activeRuns++
      resolve(() => { activeRuns--; const next = waitingRuns.shift(); if (next) next() })
    }
    if (activeRuns < POOL) go()
    else if (first) waitingRuns.unshift(go)
    else waitingRuns.push(go)
  })
}
// A run-ahead result is {value} or {error}: a rejection nobody has awaited yet is never an unhandled one.
const task = (fn, { first = false, after = null } = {}) => (async () => {
  try {
    if (after) await got(after)
    const release = await takeSlot(first)
    try { return { value: await fn() } } finally { release() }
  } catch (error) { return { error } }
})()
async function got(p) { const r = await p; if (r.error) throw r.error; return r.value }
// A work folder of one run: its own repo copies, draft folder and gh log.
function workDir(name) {
  const dir = path.join(fx, name)
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
  return { dir, out: path.join(dir, 'out'), log: path.join(dir, 'gh-calls.log') }
}
// A copy keeps the folder's own name: the draft title carries it (A1).
function copyRepo(src, w) {
  const dst = path.join(w.dir, path.basename(src))
  fs.cpSync(src, dst, { recursive: true })
  return dst
}
function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(nodeExe, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const so = []; const se = []
    c.stdout.on('data', (d) => so.push(d)); c.stderr.on('data', (d) => se.push(d))
    c.on('error', reject)
    c.on('close', (code) => resolve({ out: `${Buffer.concat(so).toString('utf8')}${Buffer.concat(se).toString('utf8')}`, exit: code }))
  })
}

// report-issue.mjs runs as a node child (ADR 0220), the shape members run. The child's stdout and stderr are
// both captured, as `2>&1` captured them, and the text is decoded as UTF-8. The call sites pass the Node
// flags in the `--name=value` form, so a '-Word' description stays a value (A4). The fake gh mode and log
// travel in the child's environment, so no case changes the environment of another.
function invokeFeedback(argv, pathVar, { mode = 'ok', log, extraNodeOptions = '' } = {}) {
  const env = envWith({
    ...gitEnv, PATH: pathVar, NODE_OPTIONS: `${fakeGhOption} ${extraNodeOptions}`.trim(),
    YWR_FAKE_GH_MODE: mode, YWR_FAKE_GH_LOG: log,
  })
  return runNode([script, ...argv], env)
}
function getBodyPath(out) {
  const m = /^\s*body:\s*(.+?)\s*$/mi.exec(out)
  return m ? m[1].trim() : ''
}
function readBody(p) { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' }
// Callers build preFail from conditional expressions that yield '' when the condition is false, and the
// match check counts an EMPTY entry as a failure. Only non-empty reasons are failures.
function assertText(text, mustMatch, mustNotMatch, preFail = []) {
  const fails = matchFailures(text, { mustMatch, mustNotMatch, preFail: preFail.filter(Boolean), label: 'text' })
  if (fails.length) assert.fail(`${fails.join(' · ')}\n${text}`)
}
const assertTrue = (cond, detail = '') => { if (!cond) assert.fail(detail || 'condition was false') }
const exitIs = (r, want) => (r.exit !== want ? `exit ${r.exit} (want ${want})` : '')
function getGhCalls(ghLog) { return fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').split(/\r\n|\r|\n/u).filter(Boolean) : [] }
// ADR 0085: no label in ANY spelling — the short `-l`, the long `--label` / `--label=<x>`, or a bare
// `upstream-report` argv element (the title value after `-t` may CONTAIN the prefix; it is never the whole element).
function testLabelArg(call) { return call.split(US).some((x) => x.toLowerCase() === '-l' || x.toLowerCase().startsWith('--label') || x.toLowerCase() === 'upstream-report') }
const issueList = (log) => getGhCalls(log).filter((c) => new RegExp(`^issue${US}list`, 'iu').test(c))
const createCalls = (log) => getGhCalls(log).filter((c) => new RegExp(`^issue${US}create`, 'iu').test(c))

// --- the run-ahead inputs and starts (defined before the first case, which can start the root hook) ----
const descA = 'the gate emitter prints nothing\nsecond line'
const a1Must = [String.raw`(?m)^\s*body:\s`, String.raw`(?m)^\s*title:\s*\[upstream-report\] \(no origin remote\) plain: the gate emitter prints nothing`,
  String.raw`(?m)^<!-- title: \[upstream-report\] `, '## Report', String.raw`the gate emitter prints nothing\s+second line`, '## Environment',
  String.raw`running \(this copy\): \*\*v` + escapeRx(manifestVer) + String.raw`\*\*`, 'claude: not on PATH', 'not a scaffolded repo',
  String.raw`fingerprint: ${T}fb[0-9a-f]{10}${T}`, 'similar open reports: not searched', 'No file contents or diffs']
const a1Not = ['@@', String.raw`\+\+\+ `, 'Traceback', String.raw`\[hook:scaffold-refresh-nudge\]`, 'harness-init ->']
const getMasked = (text, bodyFile) => text.replace(/\r\n/gu, '\n').replace(new RegExp(escapeRx(bodyFile), 'gi'), '<body>').trim()
const stamp = (d) => {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// The B group's fixture mutations. The pwsh suite applied them one after the other to ONE repository, so a
// later case saw the earlier cases' changes; each case now starts from its own copy and replays exactly the
// changes that earlier cases had made: B4 (the post-commit), B6 (the hostile branch and commit), B7 (the stamp).
const marker = 'LOCAL-PATCH-MARKER-7f3e9a'
const tick3 = T.repeat(3)
const fenceLine = T.repeat(4)
const gatesRel = 'scripts/harness/harness_gates.mjs'
const gatesPy = path.join(scaff, gatesRel)
const mutB4 = (r) => fs.writeFileSync(path.join(r, '.githooks/post-commit'), `#!/bin/sh\necho foreign hook${os.EOL}`, 'utf8')
const mutB6 = (r) => {
  gitq(r, ['checkout', '-q', '-b', `fix/a${T}b`])
  fs.appendFileSync(path.join(r, gatesRel), `# second local edit${os.EOL}`, 'utf8')
  gitq(r, ['add', '-A']); gitq(r, ['commit', '-q', '--no-verify', '-m', `close ${tick3} early ![x](http://evil.invalid/track) ## forged heading`])
}
const mutB7 = (r) => fs.writeFileSync(path.join(r, '.harness-version'), `99.0.0${os.EOL}`, 'ascii')
// B1d/B1e (N4): the NODE_OPTIONS preloads of the two stderr cases.
const noisy = path.join(fx, 'stderr-noise.cjs')
const boom = path.join(fx, 'preload-boom.cjs')
const reviewedText = `<!-- title: [upstream-report] acme/widget: reviewed title -->\n## Report\n\nreviewed body text\n${os.EOL}`

const R = {}   // the run-ahead results, filled by startRuns() when the fixtures are ready
function startRuns() {
  // A1 and its rerun A1c: one repository, one after the other (the canary pair).
  R.a1 = task(async () => {
    const w = workDir('ta1'); const repo = copyRepo(plain, w)
    const r = await invokeFeedback([`--description=${descA}`, `--target=${repo}`, `--out-dir=${w.out}`], pathWithGh, { log: w.log })
    const bodyA = getBodyPath(r.out)
    const a = { out: r.out, exit: r.exit, bodyA, textA: readBody(bodyA), outDir: w.out }
    // A1c: its own OutDir, seeded with an empty draft for every second from 1 s before to 300 s after (a loaded
    // runner delays the run's clock read; 302 empty files cost nothing): the run must take the
    // `-2` name beside its second's seed and leave the seed empty (O93 — before it, a same-second run overwrote it).
    const outDirRs = path.join(w.dir, 'out-a1c')
    fs.mkdirSync(outDirRs, { recursive: true })
    const seedFrom = new Date()
    for (let s = -1; s <= 300; s++) fs.writeFileSync(path.join(outDirRs, `ywr-harness-report-issue-${stamp(new Date(seedFrom.getTime() + s * 1000))}.md`), '')
    const r2 = await invokeFeedback([`--description=${descA}`, `--target=${repo}`, `--out-dir=${outDirRs}`], pathWithGh, { log: w.log })
    const bodyRs = getBodyPath(r2.out)
    return { a, rs: { r: r2, bodyRs, textRs: readBody(bodyRs), outDirRs }, calls: getGhCalls(w.log) }
  })
  // A2..A5 share one repository that has an origin (A5 reads the repo name A2 gave it).
  R.a2 = task(async () => {
    const w = workDir('ta2'); const repo = copyRepo(plain, w)
    gitq(repo, ['remote', 'add', 'origin', 'https://someuser:ghp_SECRETTOKEN123@github.com/acme/widget.git'])
    const r2 = await invokeFeedback(['--description=remote test', `--target=${repo}`, `--out-dir=${w.out}`], pathWithGh, { log: w.log })
    const text2 = readBody(getBodyPath(r2.out))
    const before = fs.readdirSync(w.out).length
    const r3 = await invokeFeedback([`--target=${repo}`, `--out-dir=${w.out}`], pathWithGh, { log: w.log })
    const after = fs.readdirSync(w.out).length
    const r4 = await invokeFeedback(['--description=-Word', '--title=custom title here', `--target=${repo}`, `--out-dir=${w.out}`], pathWithGh, { log: w.log })
    const text4 = readBody(getBodyPath(r4.out))
    const r5 = await invokeFeedback([`--description=${'w'.repeat(100)}`, `--target=${repo}`, `--out-dir=${w.out}`], pathWithGh, { log: w.log })
    return { r2, text2, r3, before, after, r4, text4, r5 }
  })

  // B0: the scaffold, built by the real init.mjs; the B cases copy it.
  R.build = task(async () => {
    fs.mkdirSync(scaff, { recursive: true })
    gitq(scaff, ['-c', 'init.defaultBranch=main', 'init', '-q'])
    gitq(scaff, ['remote', 'add', 'origin', 'git@github.com:acme/scaffolded.git'])
    // Real scaffold run with gh off the PATH; the docs build runs on the Node that runs init.mjs.
    const ri = await runNode([initMjs, `--target=${scaff}`], envWith({ ...gitEnv, PATH: pathNoGh }))
    const initExit = ri.exit
    const ready = initExit === 0 && fs.existsSync(gatesPy) && fs.existsSync(path.join(scaff, '.harness-version'))
    if (ready) {
      // --no-verify on the fixture's commits: init.mjs wires core.hooksPath, and since ADR 0094 the
      // seeded docs groups run check_docs.mjs at pre-commit, and a hook that refuses the commit would leave the
      // history block empty (B1/B6 red). This suite tests the feedback draft, not the hooks.
      gitq(scaff, ['add', '-A']); gitq(scaff, ['commit', '-q', '--no-verify', '-m', 'scaffold via harness-init'])
      fs.appendFileSync(gatesPy, `// REPO-LOCAL: ${marker} — report upstream${os.EOL}`, 'utf8')
      gitq(scaff, ['add', '-A']); gitq(scaff, ['commit', '-q', '--no-verify', '-m', 'local patch: fix gate emitter (REPO-LOCAL, report upstream)'])
      // a second, UNCOMMITTED toolchain edit
      fs.appendFileSync(path.join(scaff, '.githooks/pre-commit'), `# uncommitted local tweak${os.EOL}`, 'utf8')
    }
    return { initExit, ready }
  }, { first: true })

  // One B run: a copy of the built scaffold with the mutations of the earlier cases replayed on it.
  const bRun = (name, desc, pathVar, { mode = 'ok', extraNodeOptions = '', mut = [] } = {}) => task(async () => {
    if (!(await got(R.build)).ready) return null
    const w = workDir(name); const repo = copyRepo(scaff, w)
    for (const m of mut) m(repo)
    const r = await invokeFeedback([`--description=${desc}`, `--target=${repo}`, `--out-dir=${w.out}`], pathVar, { mode, log: w.log, extraNodeOptions })
    return { r, text: readBody(getBodyPath(r.out)), log: w.log }
  }, { first: true, after: R.build })
  R.b1 = bRun('tb1', 'the emitter mislabels ungrouped files', pathWithGh)
  if (!resolveUnder(pathNoNode, 'node')) R.b1c = bRun('tb1c', 'node absent', pathNoNode)
  fs.writeFileSync(noisy, `if (/scaffold-refresh-nudge\\.mjs$/.test(process.argv[1] || "")) process.stderr.write("PRELOAD-STDERR-NOISE\\n")${os.EOL}`, 'utf8')
  fs.writeFileSync(boom, `if (/scaffold-refresh-nudge\\.mjs$/.test(process.argv[1] || "")) throw new Error("PRELOAD-BOOM")${os.EOL}`, 'utf8')
  R.b1d = bRun('tb1d', 'noisy stderr', pathWithGh, { extraNodeOptions: `--require "${noisy.replaceAll('\\', '/')}"` })
  R.b1e = bRun('tb1e', 'failing node', pathWithGh, { extraNodeOptions: `--require "${boom.replaceAll('\\', '/')}"` })
  R.b2 = bRun('tb2', 'again', pathWithGh, { mode: 'similar' })
  R.b2b = bRun('tb2b', 'again', pathWithGh, { mode: 'unlabelled' })
  R.b2c = bRun('tb2c', 'again', pathWithGh, { mode: 'hostile' })
  if (noGhOk) R.b3 = bRun('tb3', 'again', pathNoGh, { mode: 'hostile' })
  R.b4 = bRun('tb4', 'foreign', pathWithGh, { mut: [mutB4] })
  R.b5 = bRun('tb5', 'many', pathWithGh, { mode: 'many', mut: [mutB4] })
  R.b6 = bRun('tb6', 'hostile', pathWithGh, { mut: [mutB4, mutB6] })
  R.b7 = bRun('tb7', 'downgrade', pathWithGh, { mut: [mutB4, mutB6, mutB7] })

  // F: FILE mode, one folder per case (the run writes a `.filed.md` copy beside its body file).
  const fRun = (name, body, argvOf, pathVar, mode = 'ok') => task(async () => {
    const w = workDir(name)
    const bodyPath = path.join(w.dir, body)
    if (body) fs.writeFileSync(bodyPath, reviewedText, 'utf8')
    const r = await invokeFeedback(argvOf(bodyPath), pathVar, { mode, log: w.log })
    return { r, w, bodyPath }
  })
  if (noGhOk) R.f1 = fRun('tf1', 'reviewed.md', (b) => ['--file', `--body-path=${b}`], pathNoGh)
  R.f2 = fRun('tf2', 'reviewed.md', (b) => ['--file', `--body-path=${b}`], pathWithGh, 'ok')
  R.f4 = fRun('tf4', 'reviewed.md', (b) => ['--file', `--body-path=${b}`], pathWithGh, 'unauth')
  R.f5 = fRun('tf5', 'reviewed.md', (b) => ['--file', `--body-path=${b}`], pathWithGh, 'createfail')
  R.f6 = fRun('tf6', '', () => ['--file'], pathWithGh, 'ok')
  R.f7 = fRun('tf7', 'reviewed.md', (b) => ['--file', `--body-path=${b}`, '--repo=acme/other'], pathWithGh, 'ok')
  R.f8 = task(async () => {
    const w = workDir('tf8')
    const noTitle = path.join(w.dir, 'notitle.md')
    fs.writeFileSync(noTitle, `## Report\nbody only\n${os.EOL}`, 'utf8')
    return { r: await invokeFeedback(['--file', `--body-path=${noTitle}`], pathWithGh, { log: w.log }) }
  })
}

// --- N1: git refuses the network transports -------------------------------------------------------
// The refusal text is gettext-translated, so the probe pins LC_ALL=C for its own call.
for (const [proto, url] of [['ssh', 'git@github.com:acme/scaffolded.git'], ['https', 'https://github.com/acme/scaffolded.git']]) {
  tc(`N1 fixture git refuses the ${proto} transport before any network call`, () => {
    const r = git_result(fx, ['ls-remote', url], { env: { ...gitEnv, LC_ALL: 'C' } })
    const n1 = `${r.stdout}${r.stderr}`
    assertTrue(r.status !== 0 && new RegExp(`transport '${proto}' not allowed`, 'i').test(n1), n1.trim())
  })
}

// --- P1: the gh-absent premise --------------------------------------------------------------------
tc('P1 gh-absent premise', (t) => {
  if (noGhNote) console.log(noGhNote)
  if (!noGhOk) { t.skip(noGhSkip); return }
  assertTrue(!resolveUnder(pathNoGh, 'gh'), `gh resolves on the gh-absent PATH: ${resolveUnder(pathNoGh, 'gh')}`)
})

// --- Z0: the contracts the child-process runner rests on (Node counterparts of the old runspace pins) -----
// The verdict is the child's exit code, and the captured text is all it wrote. report-issue.mjs reports through
// one writer (stdout); a stray console.error/warn would reach the captured text by a second path. It never
// calls process.exit: that can end the process before a piped stdout is flushed, and a truncated report
// could still match a loose assertion. Its last statement sets process.exitCode from main(), so the exit
// code is always its own verdict.
const zSrc = fs.readFileSync(script, 'utf8').split(/\r\n|\r|\n/u).filter((l) => l.trim() && !/^\/\//u.test(l.trim()))
test('Z0 report-issue.mjs reports through one writer, stdout (no console.*, no process.stderr)', () => {
  const zWide = zSrc.filter((l) => /\bconsole\.|process\.stderr/iu.test(l))
  assertTrue(zWide.length === 0, `lines: ${zWide.join(' | ')}`)
})
test('Z0 report-issue.mjs never calls process.exit (a piped stdout is always flushed)', () => {
  const zExit = zSrc.filter((l) => /process\.exit\s*\(/iu.test(l))
  assertTrue(zExit.length === 0, `lines: ${zExit.join(' | ')}`)
})
test('Z0 report-issue.mjs ends by setting process.exitCode from main() (Code is always its own verdict)', () => {
  const zLast = zSrc[zSrc.length - 1]
  assertTrue(/^\s*process\.exitCode\s*=\s*main\(\)\s*$/iu.test(zLast), `last statement: ${zLast}`)
})

// L2 guard self-check (ADR 0149 §2): a worker directory holding gh / claude / python / node under ANY
// resolvable spelling is seen by getShadowingCommand, and an empty one is clean — so the guard cannot go
// blind and let the narrowed PATH reach a real gh.
tc('L2 the worker-dir guard sees a shadowing gh/claude/python/python3/py/node in every spelling and passes a clean directory', () => {
  const zClean = path.join(fx, 'l2-clean'); const zDirty = path.join(fx, 'l2-dirty')
  fs.mkdirSync(zClean, { recursive: true }); fs.mkdirSync(zDirty, { recursive: true })
  fs.writeFileSync(path.join(zClean, 'git.exe'), `x${os.EOL}`)
  // The spellings follow what the guard resolves on this platform: PATHEXT exists on Windows only, so Linux
  // (CI ubuntu) resolves a bare name or .ps1 and the Windows spellings would not be seen there.
  const zDirtyNames = WIN ? ['gh.cmd', 'claude', 'python.exe', 'python3.exe', 'py.exe', 'node.ps1'] : ['gh', 'claude', 'python', 'python3', 'py.ps1', 'node']
  for (const f of zDirtyNames) fs.writeFileSync(path.join(zDirty, f), `x${os.EOL}`)
  const zHit = getShadowingCommand(zDirty)
  assertTrue(zHit.length === 6 && getShadowingCommand(zClean).length === 0, `dirty hits: ${zHit.join(', ')}`)
})

// =================================================================================================
// A. DRAFT mode — plain repo
// =================================================================================================
tc('A1 draft on a plain repo: exit 0, body written, sections present, no scaffold readers run', async () => {
  // A1 is the CANARY: the first child run; A1c repeats it and must agree.
  const { a } = await got(R.a1)
  assertText(`${a.out}\n=====\n${a.textA}`, a1Must, a1Not, [exitIs(a, 0), !a.bodyA ? 'no body: line' : ''])
})
// A1b (ADR 0152): the draft file name is the renamed contract — <OutDir>/ywr-harness-report-issue-<yyyyMMdd-HHmmss>.md.
tc('A1b draft file is <OutDir>/ywr-harness-report-issue-<yyyyMMdd-HHmmss>.md', async () => {
  const { a } = await got(R.a1)
  const { bodyA } = a
  assertTrue(Boolean(bodyA) && /^ywr-harness-report-issue-\d{8}-\d{6}\.md$/u.test(path.basename(bodyA)) &&
    path.resolve(path.dirname(bodyA)).toLowerCase() === path.resolve(a.outDir).toLowerCase(), `body: ${bodyA}`)
})
// A1c: the SAME case run again must agree with A1 on the exit code, on every A1 assertion, and on the output
// and body text themselves once the per-run body file name is masked — a run-to-run divergence goes red here.
tc('A1c the canary case run again matches the first child run: same exit code, same A1 assertions, same output and body', async () => {
  const { a, rs } = await got(R.a1)
  const { r, bodyRs, textRs } = rs
  const maskOut = getMasked(a.out, a.bodyA); const maskOutRs = getMasked(r.out, bodyRs)
  const maskBody = getMasked(a.textA, a.bodyA); const maskBodyRs = getMasked(textRs, bodyRs)
  assertText(`${r.out}\n=====\n${textRs}`, a1Must, a1Not,
    [r.exit !== a.exit ? `exit differs: second run ${r.exit} vs first ${a.exit}` : '',
      bodyRs.toLowerCase() === a.bodyA.toLowerCase() ? 'the second run reused the first body file' : '',
      maskOutRs !== maskOut ? `output differs after masking the body path\n--- first ---\n${maskOut}\n--- second ---\n${maskOutRs}` : '',
      maskBodyRs !== maskBody ? 'body text differs between the two runs' : ''])
})
tc('A1d a draft in a second that already has one takes the -2 name and leaves the earlier file untouched', async () => {
  const { rs } = await got(R.a1)
  const { bodyRs, outDirRs } = rs
  const seedRs = bodyRs ? path.basename(bodyRs).replace(/-2\.md$/iu, '.md') : ''
  assertTrue(Boolean(bodyRs) && /^ywr-harness-report-issue-\d{8}-\d{6}-2\.md$/u.test(path.basename(bodyRs)) &&
    fs.statSync(path.join(outDirRs, seedRs)).size === 0, `body: ${bodyRs}`)
})
tc('A1b no gh call is made when there is no drift (fingerprint search skipped)', async () => {
  const { calls } = await got(R.a1)
  assertTrue(calls.length === 0, `calls: ${calls.join(' | ')}`)
})

// A2: origin with embedded credentials -> owner/repo only, the URL never appears
tc('A2 origin is reduced to owner/repo; credentials in the remote URL never reach the body', async () => {
  const { r2: r, text2: textA2 } = await got(R.a2)
  assertText(`${r.out}\n${textA2}`,
    [`repo: ${T}acme/widget${T}`, String.raw`\[upstream-report\] acme/widget: remote test`],
    ['ghp_SECRETTOKEN123', 'someuser', 'https://someuser', String.raw`github\.com/acme`], [exitIs(r, 0)])
})

// A3: no description -> exit 1, nothing drafted
tc('A3 no description -> exit 1 with a FAIL line and no body file', async () => {
  const { r3: r, before, after } = await got(R.a2)
  assertText(r.out, ['FAIL — a report needs a description'], [String.raw`(?m)^\s*body:`], [exitIs(r, 1), after !== before ? 'a body file was written' : ''])
})

// A4: -Title override. The description is shaped like a parameter name: the `--description=-Word` form
// binds it as the value (the `--description -Word` form is refused by the Node parser).
tc('A4 -Title is used verbatim as the body title line; a -Word description binds as the value', async () => {
  const { r4: r, text4: textA4 } = await got(R.a2)
  assertText(textA4, [String.raw`(?m)^<!-- title: custom title here -->`, String.raw`(?m)^-Word\s*$`], [String.raw`\[upstream-report\]`], [exitIs(r, 0)])
})

// A5: a long first line is truncated in the default title, with an ellipsis
tc('A5 default title truncates a long first line', async () => {
  const { r5: r } = await got(R.a2)
  assertText(r.out, [String.raw`(?m)^\s*title:\s*\[upstream-report\] acme/widget: w{67}…\s*$`], ['w{70}'])
})

// =================================================================================================
// B. DRAFT mode — a scaffolded repo with a hand-patched toolchain file (the #55 shape)
// =================================================================================================
let scaffReady = false
const scaffSkip = 'B1–B7 not run: the scaffold fixture did not build'
// A case of the B group: skipped, with a reason, when the scaffold fixture did not build.
const tb = (name, fn) => tc(name, async (t) => { if (!scaffReady) { t.skip(scaffSkip); return } return fn(t) })
tc('B0 fixture: init.mjs scaffolded the repo (stamp + vendored gate script present)', async () => {
  const { initExit, ready } = await got(R.build)
  scaffReady = ready
  assertTrue(scaffReady, `init exit=${initExit}`)
})
tb('B1 scaffolded + patched: nudge verdict quoted, dry run names both files, history names the local commit, marker never leaks', async () => {
  const { r, text: textB } = await got(R.b1)
  assertText(`${r.out}\n=====\n${textB}`,
    [String.raw`\[hook:scaffold-refresh-nudge\]`, String.raw`scripts/harness/harness_gates\.mjs`, String.raw`\.githooks/pre-commit`,
      String.raw`harness-init -> .*\(dry run — nothing written\)`, String.raw`~ scripts/harness/harness_gates\.mjs \(toolchain refreshed from canon\)`,
      '## Local history', String.raw`(?m)^scripts/harness/harness_gates\.mjs$`, 'local patch: fix gate emitter',
      String.raw`(?m)^\.githooks/pre-commit · uncommitted changes present$`,
      String.raw`2 toolchain file\(s\) a re-run would change: ${T}\.githooks/pre-commit${T}, ${T}scripts/harness/harness_gates\.mjs${T}`,
      'stamp: ' + escapeRx(manifestVer), String.raw`repo: ${T}acme/scaffolded${T}`, 'similar open reports: none'],
    ['LOCAL-PATCH-MARKER', '@@', String.raw`\+\+\+ `, 'Traceback', 'uncommitted local tweak', 'not a scaffolded repo'],
    [exitIs(r, 0), !getBodyPath(r.out) ? 'no body: line' : ''])
})
// ADR 0085: the search covers EVERY open dist issue — no `-l` in the argv, the quoted fingerprint
// is the discriminator (a read-role member's earlier report carries no label).
tb('B1b the fingerprint search asked gh for ALL open dist issues matching the quoted fingerprint — no -l label filter', async () => {
  const { log } = await got(R.b1)
  const calls = getGhCalls(log)
  const listCall = issueList(log)
  assertTrue(listCall.length === 1 && /orcait-co\/ywr-harness/iu.test(listCall[0]) && new RegExp(`-S${US}"fb[0-9a-f]{10}"`, 'iu').test(listCall[0]) &&
    new RegExp(`--state${US}open`, 'iu').test(listCall[0]) && !testLabelArg(listCall[0]) && !/upstream-report/iu.test(listCall[0]), `calls: ${calls.join(' | ')}`)
})
// B1c (ADR 0116): the refresh nudge is a Node hook that the host starts as an exec-form `node` from PATH, and
// report-issue.mjs looks for that `node` on PATH the same way. With node absent the report
// must SAY the verdict could not be read — never a silent pass, never a fabricated "no drift" line —
// while the dry run, which needs no node, still runs and still names the drifted files.
tb('B1c no node on PATH: the nudge section says the hook could not run; the dry run still names both files', async (t) => {
  const nodeLeak = resolveUnder(pathNoNode, 'node')
  if (nodeLeak) { t.skip(`B1c node-absent premise: node still resolves on a PATH of the fake-gh + git directories (${nodeLeak}) — B1c is NOT run (reported, not silent)`); return }
  const { r, text: textB1c } = await got(R.b1c)
  assertText(`${r.out}\n=====\n${textB1c}`,
    ['the refresh nudge could not run: node is not on PATH', 'no toolchain-drift verdict was read',
      String.raw`harness-init -> .*\(dry run — nothing written\)`, String.raw`~ scripts/harness/harness_gates\.mjs \(toolchain refreshed from canon\)`,
      String.raw`2 toolchain file\(s\) a re-run would change: ${T}\.githooks/pre-commit${T}, ${T}scripts/harness/harness_gates\.mjs${T}`],
    [String.raw`\[hook:scaffold-refresh-nudge\]`, 'silent — the refresh nudge reported no toolchain drift', 'hook invocation failed', 'hook output was not JSON', 'Traceback'],
    [exitIs(r, 0), !textB1c ? 'no body written' : ''])
})
// B1d/B1e (N4): node's stderr is not part of the verdict. A NODE_OPTIONS preload that writes to stderr on every
// run of the HOOK must not turn the hook's JSON into "not JSON" (the verdict is still the hook's systemMessage, and the noise
// stays out of the report); a run that FAILS (the preload throws -> exit 1, no stdout) says so and quotes stderr.
// report-issue.mjs is a node process too, so each preload acts only in the hook process, by its script name.
tb('B1d node stderr noise does not break the verdict: the nudge is still parsed and quoted, the noise is not in the report', async () => {
  const { r, text: textB1d } = await got(R.b1d)
  assertText(`${r.out}\n=====\n${textB1d}`,
    [String.raw`\[hook:scaffold-refresh-nudge\]`, String.raw`2 toolchain file\(s\) a re-run would change`],
    ['PRELOAD-STDERR-NOISE', 'hook output was not JSON', 'the refresh nudge exited', 'Traceback'],
    [exitIs(r, 0), !textB1d ? 'no body written' : ''])
})
tb('B1e a failing node run is reported with its exit code and stderr, never as a silent pass', async () => {
  const { r, text: textB1e } = await got(R.b1e)
  assertText(`${r.out}\n=====\n${textB1e}`,
    ['the refresh nudge exited 1 with no output', 'PRELOAD-BOOM', String.raw`harness-init -> .*\(dry run — nothing written\)`],
    ['silent — the refresh nudge reported no toolchain drift', String.raw`\[hook:scaffold-refresh-nudge\]`],
    [exitIs(r, 0), !textB1e ? 'no body written' : ''])
})

// B2: a similar report exists -> named on the summary line (informational, exit still 0)
tb('B2 a matching open report is named, drafting still succeeds', async () => {
  const { r } = await got(R.b2)
  assertText(r.out, [String.raw`similar open reports: #12 \[upstream-report\] acme/widget: same drift`, String.raw`(?m)^\s*body:`], ['NOT CHECKED'], [exitIs(r, 0)])
})

// B2b (ADR 0085): the earlier report was filed by a READ-ROLE member, so GitHub dropped its label;
// the fake answers a label-filtered search with [] and an unfiltered one with the hit — the dedupe
// must still find it (the dist #6 shape: fingerprint in the body, labels=[]).
tb('B2b an unlabelled earlier report (read-role filer) is still found by the fingerprint search', async () => {
  const { r } = await got(R.b2b)
  assertText(r.out, [String.raw`similar open reports: #6 \[upstream-report\] acme/scaffolded: earlier read-role report \(by member-a\)`], ['similar open reports: none', 'NOT CHECKED'], [exitIs(r, 0)])
})

// B2c: without the label ANY account's issue can carry a published fingerprint — its title renders on
// ONE line with no terminal escape (ESC, NEL, U+2028, CR/LF all become spaces) and names its author.
tb('B2c a hostile stranger title renders on one line, control-free, with its author', async () => {
  const { r } = await got(R.b2c)
  const simLine = r.out.split(/\r?\n/u).filter((l) => /similar open reports:/iu.test(l))
  // Built from code points: the class of a C0 control, DEL, NEL, U+2028 and U+2029.
  const ctrl = new RegExp(`[${ch(0)}-${ch(8)}${ch(0x0b)}-${ch(0x1f)}${ch(0x7f)}${ch(0x85)}${ch(0x2028)}${ch(0x2029)}]`)
  assertTrue(simLine.length === 1 && /#7 fake \[2Jreport line two {2}three \(by stranger\)/iu.test(simLine[0]) &&
    !ctrl.test(simLine[0]) && !r.out.includes(ch(0x1b)) &&
    r.out.split(/\r?\n/u).filter((l) => /^\s*three/iu.test(l)).length === 0, `line: ${simLine.join(' || ')}`)
})

// B3: gh absent -> the search is reported NOT CHECKED, never silently 'none'
tb('B3 without gh the similarity search says NOT CHECKED', async (t) => {
  if (!noGhOk) { t.skip('gh-absent premise: B3 is NOT run'); return }
  const { r } = await got(R.b3)
  assertText(r.out, [String.raw`similar open reports: NOT CHECKED \(gh absent or not authenticated\)`], ['similar open reports: none'], [exitIs(r, 0)])
})

// B4: the dry run's guarded marker-less refusal is FOREIGN, not drift (the canon's own post-commit shape)
tb('B4 a marker-less post-commit is listed as foreign, not counted as a file a re-run would change', async () => {
  const { text: textB4 } = await got(R.b4)
  assertText(textB4,
    [String.raw`refused as foreign and left alone \(not drift\): ${T}\.githooks/post-commit${T}`, String.raw`2 toolchain file\(s\) a re-run would change`],
    ['3 toolchain file'])
})

// B5: a full search page -> the search cap is STATED (review 2026-08-28, low)
tb('B5 a full page of similar reports states the search cap', async () => {
  const { r } = await got(R.b5)
  assertText(r.out, [String.raw`similar open reports: #1 dup 1 · .*#20 dup 20 \(search capped at 20 — more may exist\)`], ['NOT CHECKED'], [exitIs(r, 0)])
})

// B6: markdown-hostile repo text never becomes live markdown (review 2026-08-28, medium x2) — a commit
// subject carrying a triple-backtick run and an image link, a branch name carrying a backtick: the
// history block's fence grows to 4 backticks, the subject is quoted verbatim INSIDE it, the branch
// loses its backtick inside the inline code span.
let textB6 = ''
tb('B6 hostile commit subject and branch: 4-backtick fence, subject verbatim inside it, branch backtick neutralised', async () => {
  const { r, text } = await got(R.b6)
  textB6 = text
  assertText(textB6,
    ['(?m)^' + escapeRx(fenceLine) + '$', 'close ' + escapeRx(tick3) + String.raw` early !\[x\]\(http://evil\.invalid/track\) ## forged heading`, `branch ${T}fix/a b${T}`],
    [`branch ${T}fix/a${T}b${T}`, '(?m)^## forged heading'], [exitIs(r, 0)])
})
// the 4-backtick fence must OPEN and CLOSE around the history (two lines), so the subject's own
// triple-backtick run cannot terminate the block early
tb('B6b exactly two 4-backtick fence lines (open + close) around the history block', async () => {
  textB6 = (await got(R.b6)).text
  const fenceCount = (textB6.match(new RegExp(`^${escapeRx(fenceLine)}$`, 'gm')) ?? []).length
  assertTrue(fenceCount === 2, `count=${fenceCount}`)
})

// B7: init.mjs refuses a DOWNGRADE (stamp newer than this copy, ADR 0042) -> the dry run exits 1
// before comparing -> drift is UNKNOWN, never "none" (review 2026-08-28, high)
tb('B7 downgrade-refused dry run -> drift UNKNOWN, search not run, REFUSED text quoted', async () => {
  const { r, text: textB7 } = await got(R.b7)
  assertText(`${r.out}\n=====\n${textB7}`,
    [String.raw`toolchain drift: UNKNOWN — init\.mjs --dry-run exited 1 before comparing`, String.raw`similar open reports: not searched \(drift UNKNOWN`,
      String.raw`REFUSED — this repo.s toolchain was last scaffolded by ywr-harness v99\.0\.0`, String.raw`stamp: 99\.0\.0`],
    ['none — a re-run would change nothing', String.raw`toolchain file\(s\) a re-run would change`], [exitIs(r, 0)])
})
tb('B7b no gh search was attempted while drift is UNKNOWN', async () => {
  const { log } = await got(R.b7)
  assertTrue(issueList(log).length === 0, `calls: ${getGhCalls(log).join(' | ')}`)
})

// =================================================================================================
// F. FILE mode — every gh outcome
// =================================================================================================
// F1: gh absent -> NOT FILED, exit 2, by-hand URL, body kept
tc('F1 gh absent -> exit 2, NOT FILED, by-hand URL, body kept', async (t) => {
  if (!noGhOk) { t.skip('gh-absent premise: F1 is NOT run'); return }
  const { r, bodyPath } = await got(R.f1)
  assertText(r.out,
    ['NOT FILED — gh is not on PATH', String.raw`https://github\.com/orcait-co/ywr-harness/issues/new`, String.raw`title: \[upstream-report\] acme/widget: reviewed title`],
    ['filed: https', 'label: upstream-report'],
    [exitIs(r, 2), !fs.existsSync(bodyPath) ? 'body file was removed' : ''])
})

// F2: gh ok -> filed; the create call carries repo, title and body file — and NO label (ADR 0085)
const f2Of = async () => {
  const { r, w, bodyPath } = await got(R.f2)
  const filedCopy = `${bodyPath}.filed.md`
  return { r, calls: getGhCalls(w.log), create: createCalls(w.log), filedText: fs.existsSync(filedCopy) ? fs.readFileSync(filedCopy, 'utf8') : '' }
}
tc('F2 gh ok -> filed: URL, exit 0, no label line', async () => {
  const { r } = await f2Of()
  assertText(r.out, [String.raw`filed: https://github\.com/orcait-co/ywr-harness/issues/999`], ['NOT FILED', String.raw`(?m)^\s*label:`], [exitIs(r, 0)])
})
// ADR 0085: GitHub silently drops a label set by a filer without push access, so the member side
// neither preflights one (`gh label list`) nor passes `-l`; the canon inbox lists every open issue.
tc('F2b the create call: -R orcait-co/ywr-harness, -t <title>, -F <reviewed>.filed.md, NO -l; auth ran first; no label list call', async () => {
  const { calls, create } = await f2Of()
  assertTrue(create.length === 1 && new RegExp(`-R${US}orcait-co/ywr-harness`, 'iu').test(create[0]) &&
    new RegExp(`-t${US}\\[upstream-report\\] acme/widget: reviewed title`, 'iu').test(create[0]) &&
    new RegExp(`-F${US}[^${US}]*reviewed\\.md\\.filed\\.md`, 'iu').test(create[0]) && !testLabelArg(create[0]) &&
    /^auth/iu.test(calls[0]) && calls.filter((c) => /^label/iu.test(c)).length === 0, `calls: ${calls.join(' | ')}`)
})
tc('F2c the filed body is the reviewed file minus the title line', async () => {
  const { filedText } = await f2Of()
  assertText(filedText, ['^## Report', 'reviewed body text'], ['<!-- title'])
})

// F4: gh unauthenticated -> NOT FILED, exit 2, no create attempted
tc('F4 gh unauthenticated -> exit 2, NOT FILED names the auth failure', async () => {
  const { r } = await got(R.f4)
  assertText(r.out, ['NOT FILED — gh is not authenticated', 'issues/new'], ['filed: https'], [exitIs(r, 2)])
})
tc('F4b no create call was attempted while unauthenticated', async () => {
  const { w } = await got(R.f4)
  assertTrue(createCalls(w.log).length === 0, `calls: ${getGhCalls(w.log).join(' | ')}`)
})

// F5: create fails -> exit 2, gh's own text quoted, no retry
tc('F5 create failure -> exit 2, NOT FILED quotes gh, by-hand URL', async () => {
  const { r } = await got(R.f5)
  assertText(r.out, ['NOT FILED — gh issue create exited 1', 'Resource not accessible', 'issues/new'], ['filed: https'], [exitIs(r, 2)])
})
tc('F5b exactly one create attempt — no blind retry', async () => {
  const { w } = await got(R.f5)
  assertTrue(createCalls(w.log).length === 1, `calls: ${getGhCalls(w.log).join(' | ')}`)
})

// F6: --file without --body-path -> exit 1 (usage), nothing called
tc('F6 -File without -BodyPath is a usage error', async () => {
  const { r, w } = await got(R.f6)
  assertText(r.out, ['FAIL — --file needs --body-path'], ['filed:', 'NOT FILED'], [exitIs(r, 1), getGhCalls(w.log).length ? 'gh was called' : ''])
})

// F7: -Repo override reaches the create call (the test seam the ADR names)
tc('F7 -Repo override is what gh is asked to file on', async () => {
  const { w } = await got(R.f7)
  const create = createCalls(w.log)
  assertTrue(create.length === 1 && new RegExp(`-R${US}acme/other`, 'iu').test(create[0]), `create: ${create.join(' | ')}`)
})

// F8: a body with no title line and no -Title -> exit 1
tc('F8 no title anywhere -> exit 1', async () => {
  const { r } = await got(R.f8)
  assertText(r.out, ['FAIL — no title'], ['filed:'], [exitIs(r, 1)])
})

// =================================================================================================
// S. SKILL.md contract lines
// =================================================================================================
test('S1 SKILL.md: user-invoked only, namespaced references, both script modes named, the never-list, the no-label inbox claim', () => {
  const skill = fs.readFileSync(skillMd, 'utf8')
  // The label clauses (ADR 0085): the member is no longer told the report carries `upstream-report` —
  // for a read-role filer GitHub drops it — and IS told the canon inbox lists every open dist issue.
  assertText(skill,
    ['(?m)^disable-model-invocation: true', '/ywr-harness:report-issue', String.raw`report-issue\.mjs" --description=`, String.raw`report-issue\.mjs" --file --body-path=`,
      'Never files without step 3', 'Never includes file contents or diffs', `Never runs ${T}/ywr-harness:harness-init${T}`,
      'inbox lists every open dist issue', 'ADR 0085'],
    [`${T}/report-issue${T}`, `${T}/harness-init${T}`, `label ${T}upstream-report${T}`, 'with label upstream-report', "label: 'upstream-report' is absent"])
})

// =================================================================================================
// I. One flattening rule: report-issue.mjs imports hook-lib's inline() and holds no copy of the class
// =================================================================================================
// The pwsh original carried its own copy of the one-line rule, and I1 pinned that copy over every UTF-16
// code unit. The Node port imports hook-lib.mjs's inline(), whose class hook-lib.selftest pins the same way,
// so I1 now pins the import and the absence of a second copy: no other character class over the flattened
// set (U+2028, U+2029, U+0085) in the script. B2c still drives the rule end to end through a hostile title.
// (Cases G1-G3 pinned pwsh's module auto-loading switch around the git/gh/claude lookups; Node has no such
// switch, so they left with report-issue.ps1.)
test('I1 report-issue.mjs flattens through hook-lib inline() (imported, no second copy of the class)', () => {
  const iSrc = fs.readFileSync(script, 'utf8')
  const iFail = []
  if (!/^import \{[^}]*\binline\b[^}]*\} from '\.\.\/\.\.\/hooks\/hook-lib\.mjs'/miu.test(iSrc)) iFail.push("no import of inline from '../../hooks/hook-lib.mjs'")
  // The spellings a second copy of the class would use: a backslash, then u2028, u2029, u0085 or x85. Built from a code point.
  const bs = ch(0x5c)
  const spelled = new RegExp(['u2028', 'u2029', 'u0085', 'x85'].map((s) => `${bs}${bs}${s}`).join('|'), 'iu')
  if (spelled.test(iSrc)) iFail.push('the script spells a flattened code point itself (a second copy of the class)')
  assertTrue(iFail.length === 0, iFail.join(' · '))
})

// --- META: the harness itself must be able to fail ------------------------------------------------
test('META a MustMatch miss is reported as a failure', () => {
  const fails = matchFailures('abc', { mustMatch: ['zzz'], mustNotMatch: [], preFail: [], label: 'text' })
  assertTrue(fails.length > 0, 'assertText passed on a non-matching text')
})

// Every case is registered: start the child runs the cases await (the fixtures were built by the root hook above).
if (gitOk) startRuns()