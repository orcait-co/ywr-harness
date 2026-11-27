// Selftest for the shipped git hooks (ADR 0015; post-commit ADR 0017). They live under templates/ —
// payload this plugin COPIES rather than runs — but pre-commit and pre-push are the only shipped
// artifacts that can block a commit or a push, so "template payload has no selftest here" is the
// wrong call for them. post-commit cannot block anything; its cases (P) exist because every one of
// its branches exits 0, so only running it shows which branch a repo actually gets.
//
// The hooks are RUN, in real throwaway git repositories, against real staged changes and real
// commit ranges. A placement assertion is not a run (fact 6), and a hook is exactly the artifact
// whose placement tells you least.
//
// Two arms for pre-commit, deliberately:
//   * a STUB emitter, so the hook's parsing and execution contract is deterministic and does not
//     depend on ruff/eslint/uv being installed on the machine running the suite;
//   * the REAL vendored emitter, so the integration is exercised rather than assumed.
//
// Usage: node --test-reporter=<file URL of ../../lib/selftest-reporter.mjs> --test-reporter-destination=stdout skills/harness-init/githooks.selftest.mjs
//
// Every hook gets its stdin through a pipe, which is also what git does. A Node pipe writes the bytes it
// is given, so no CRLF reaches the hook. toRx compiles the patterns case-insensitively. A fixture that
// several cases read is built once, as a scenario that starts when the file loads and runs beside the others.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, toRx, innerJobs } from '../../lib/selftest-lib.mjs'
import { git_run, git_absent, which_on_path, _real_git, GIT_PINS } from './templates/scripts/harness/harness_git.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const r = String.raw
const win = process.platform === 'win32'
const M = (text, pat) => toRx(pat).test(text)
const lazy = (fn) => { let done = false; let v; return () => { if (!done) { v = fn(); done = true } return v } }   // sync, for the two fixtures that start no child

const hooksSrc = path.join(here, 'templates/githooks')
const preCommit = path.join(hooksSrc, 'pre-commit')
const prePush = path.join(hooksSrc, 'pre-push')
const postCommit = path.join(hooksSrc, 'post-commit')
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }

// Git's sh on Windows does not accept `C:\a\b` as a script argument — the backslashes are eaten
// as escapes and it reports "No such file or directory" for a path that plainly exists.
function toShPath(p) {
  const full = path.resolve(p)
  if (!win) return full
  return '/' + full[0].toLowerCase() + full.slice(2).replaceAll('\\', '/')
}

// --- preflight: settled before the first case -------------------------------------------------------------
// A missing template is a FAIL, a missing git or POSIX sh is a reported SKIP, and on CI a missing sh is a FAIL.
const gitLauncher = which_on_path('git')   // kept for P5's git shim: that case's PATH is narrowed to one dir and must still resolve the same git
let shPath = ''
let shExtraPath = []
let skipAll = false
let preFail = null
function findPosixShell() {
  if (!win) return which_on_path('sh') || which_on_path('bash')
  // GIT'S OWN sh, resolved from the git executable, not whatever `sh`/`bash` PATH happens to
  // offer. The first `bash` on PATH can be C:\Windows\System32\bash.exe, which is WSL: a
  // different filesystem namespace (/mnt/c, not /c), so every case would fail with "No such file or
  // directory" on a path that exists. It is also the wrong interpreter to measure with:
  // git runs a hook through its own bundled sh, so that is what this suite must run.
  if (gitLauncher) {
    const gitRoot = path.dirname(path.dirname(gitLauncher))
    for (const rel of ['usr\\bin\\sh.exe', 'bin\\sh.exe', 'usr\\bin\\bash.exe', 'bin\\bash.exe']) {
      const p = path.join(gitRoot, rel)
      if (isFile(p)) return p
    }
  }
  return ''
}
for (const f of [preCommit, prePush, postCommit]) {
  if (!isFile(f)) { preFail = `FAIL — hook template missing: ${f}`; break }
}
if (!preFail) {
  if (git_absent() || !gitLauncher) {
    skipAll = 'git absent (reported, not silent)'
  } else {
    shPath = findPosixShell()
    if (!shPath) {
      if (process.env.CI) preFail = 'FAIL — no POSIX sh on CI; the hooks would ship unexercised'
      else skipAll = 'no POSIX sh found (reported, not silent) — CI runs this gate'
    }
  }
}
if (!preFail && !skipAll) {
  // When git runs a hook it puts its own POSIX toolchain on PATH. Invoking sh.exe straight from
  // the suite does not, so `awk`, `sed` and `grep` are missing and `sort` resolves to Windows'
  // sort.exe. That makes the hooks look broken and makes cases pass VACUOUSLY (the hook
  // bails early and exits 0, which several assertions read as success). Reproducing git's PATH is
  // what makes this suite measure the hook instead of the launcher.
  if (win) {
    const gitRoot = path.dirname(path.dirname(gitLauncher))
    for (const d of ['usr\\bin', 'bin', 'mingw64\\bin']) {
      const p = path.join(gitRoot, d)
      if (isDir(p)) shExtraPath.push(p)
    }
  }
  // Probe the shell/path-form pairing before asserting anything. A namespace mismatch otherwise
  // surfaces as a dozen unrelated-looking case failures rather than one legible line.
  const pr = spawnSync(shPath, ['-c', `test -f '${toShPath(prePush)}' && echo OK`], { encoding: 'utf8', windowsHide: true })
  const probe = `${pr.stdout ?? ''}${pr.stderr ?? ''}`.trim()
  if (probe !== 'OK') preFail = `FAIL — ${shPath} cannot resolve ${toShPath(prePush)} (probe returned '${probe}')`
}
if (!preFail && !skipAll && win) {
  // The suite makes hundreds of git calls (fixture builds plus the hooks' own), so they use the worker
  // binary, not the cmd\git.exe launcher (ADR 0111). This runs after the resolutions above, which read
  // git's root from the launcher's path and need the launcher's layout. Every PATH this suite builds
  // starts from the then-current PATH, so the worker dir rides along; P5 REPLACES the PATH outright,
  // so it never sees it.
  const real = _real_git(gitLauncher)
  if (real && real !== gitLauncher) process.env.PATH = path.dirname(real) + path.delimiter + process.env.PATH
}
// Fixture identity through the environment, once: a per-repo `git config user.*` costs two spawns per
// fixture repo. No hook under test and no case reads a repo-local user.* value.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'selftest', GIT_COMMITTER_NAME: 'selftest',
  GIT_AUTHOR_EMAIL: 'selftest@example.invalid', GIT_COMMITTER_EMAIL: 'selftest@example.invalid',
})
// The git that PATH now resolves: the worker binary on Windows, where the shim of I6 execs it.
const gitResolved = which_on_path('git')

test(preFail || !skipAll ? 'GH0 preflight: the hook templates, git and a POSIX sh are present, and sh resolves a template path' : 'GH0 githooks',
  { skip: preFail ? false : skipAll }, () => { if (preFail) assert.fail(preFail) })
const SKIP = preFail ? 'preflight failed — see GH0' : skipAll
const T = (name, fn) => test(name, { skip: SKIP }, fn)
const ec = (x) => `exit=${x.code} out=${x.out}`

const fxBase = fixtureRoot('githooks-selftest')
after(() => removeFixtureRoot(fxBase))

// --- fixture helpers ----------------------------------------------------------------------------
// Fixture git calls throw on a non-zero exit: a fixture that did not build must be a loud failure, never a
// case that passes on an empty repository. The merge of New-MergeRepo is the one that may exit non-zero.
//
// Speed. Every case builds its own repository and runs a hook that starts many processes, and the cases share
// no state except where a comment says so. So each fixture build is one async chain (a scenario) that starts when
// the file loads, and every child start goes through one slot pool of the machine's CPU count (at most 8). The
// cases then only await their scenario. A case that mutates a repository another case reads awaits that
// repository's scenario first, so the order of those two never changes.
const POOL = innerJobs(8, 2)
let poolActive = 0
const poolWait = []
async function slotted(fn) {
  if (poolActive >= POOL) await new Promise((resolve) => poolWait.push(resolve))   // the releaser hands its slot over
  else poolActive++
  try { return await fn() } finally { const next = poolWait.shift(); if (next) next(); else poolActive-- }
}
// One child start, output as bytes. `input` goes to stdin; a hook may exit before it reads it, so EPIPE is ignored.
function spawnA(file, args, { cwd, env, input } = {}) {
  return slotted(() => new Promise((resolve, reject) => {
    const c = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const so = []; const se = []
    c.stdout.on('data', (d) => so.push(d))
    c.stderr.on('data', (d) => se.push(d))
    c.stdin.on('error', () => {})
    c.on('error', reject)
    c.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(so).toString('utf8'), stderr: Buffer.concat(se).toString('utf8') }))
    c.stdin.end(input ?? '')
  }))
}
// The same pins git_run puts before every command, on the git that PATH resolves.
async function gitResultA(repo, args) {
  const x = await spawnA(gitResolved, [...GIT_PINS, ...args], { cwd: repo, env: process.env })
  return { status: x.code, stdout: x.stdout, stderr: x.stderr }
}
async function git(repo, args) {
  const x = await gitResultA(repo, args)
  if (x.status !== 0) throw new Error(`git ${args.join(' ')} exited ${x.status} in ${repo}: ${x.stderr}`)
  return x.stdout
}
const gitOut = async (repo, args) => (await git(repo, args)).trim()
// A scenario starts at once and is read by every case of its ID. Nothing starts when the suite is skipped.
function scn(fn) {
  if (SKIP) return () => Promise.reject(new Error(String(SKIP)))
  const p = Promise.resolve().then(fn)
  p.catch(() => {})   // a failure surfaces in the cases that await it, not as an unhandled rejection
  return () => p
}
// The seed repository (git init and an empty seed commit, so HEAD exists and every case diffs against something)
// is built once; each case gets a copy. A copied .git folder is a real repository.
let seedRepo = null
function newRepo(name) {
  if (!seedRepo) {
    seedRepo = path.join(fxBase, '_seed')
    fs.mkdirSync(seedRepo, { recursive: true })
    git_run(seedRepo, ['init', '-q'])
    git_run(seedRepo, ['commit', '-q', '--allow-empty', '-m', 'seed'])
  }
  const p = path.join(fxBase, name)
  fs.cpSync(seedRepo, p, { recursive: true })
  return p
}
function writeFile(repo, rel, body) {
  const full = path.join(repo, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  // LF only keeps the fixtures byte-predictable across platforms.
  fs.writeFileSync(full, body.replace(/\r\n/g, '\n'), 'utf8')
}
function copyInto(repo, from, rel) {
  const to = path.join(repo, rel)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}
// On Windows the variable is `Path` in a copied environment, and a second key `PATH` would be ambiguous.
function childEnv(over = {}, pathValue) {
  const env = { ...process.env }
  if (pathValue !== undefined) {
    for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k]
    env.PATH = pathValue
  }
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete env[k]; else env[k] = v }
  return env
}
const defaultPath = () => (shExtraPath.length ? shExtraPath.join(path.delimiter) + path.delimiter : '') + process.env.PATH
function runSh(args, repo, input, env) {
  const x = spawnSync(shPath, args, { cwd: repo, input, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return { out: `${x.stdout ?? ''}${x.stderr ?? ''}`, code: x.status ?? -1 }
}
// pathOverride REPLACES the hook's PATH (no git toolchain prepended) — the P5 no-node arm. pathPrefix goes in
// front of the default PATH. noFinalNewline is the one caller that is not git: a tool that hands the hook an
// unterminated last line. The hook runs as a program (its shebang), the way git runs it.
function hookArgs(hook, stdin, { pathOverride = '', pathPrefix = '', noFinalNewline = false, env = {} } = {}) {
  const sh = toShPath(hook)
  const pathValue = pathOverride || (pathPrefix ? pathPrefix + path.delimiter : '') + defaultPath()
  // git feeds a hook LF-terminated lines; a null stdin is an empty line.
  const input = (stdin ?? '').replace(/\r\n/g, '\n') + (noFinalNewline ? '' : '\n')
  return { args: ['-c', `'${sh}'`], input, env: childEnv(env, pathValue) }
}
async function runShA(args, repo, input, env) {
  const x = await spawnA(shPath, args, { cwd: repo, env, input })
  return { out: `${x.stdout}${x.stderr}`, code: x.code }
}
async function invokeHook(repo, hook, stdin = null, opts = {}) {
  const h = hookArgs(hook, stdin, opts)
  return runShA(h.args, repo, h.input, h.env)
}
function invokeHookSync(repo, hook, stdin = null, opts = {}) {
  const h = hookArgs(hook, stdin, opts)
  return runSh(h.args, repo, h.input, h.env)
}

// =================================================================================================
// pre-commit
// =================================================================================================

// --- A: no emitter present -> reported skip, commit not blocked --------------------------------
const rA = scn(async () => {
  const a = newRepo('pc-no-emitter')
  writeFile(a, 'x.py', 'print(1)\n')
  await git(a, ['add', '-A'])
  return await invokeHook(a, preCommit)
})
T('GH1 A missing emitter does not block the commit', async () => { const x = (await rA()); assert.ok(x.code === 0, ec(x)) })
T('GH1 A missing emitter is REPORTED, not silent', async () => { const x = (await rA()); assert.ok(M(x.out, 'SKIP pre-commit gates'), x.out) })

// --- B: nothing staged -> no-op ----------------------------------------------------------------
const rB = scn(async () => invokeHook(newRepo('pc-nothing-staged'), preCommit))
T('GH2 B nothing staged exits 0', async () => {
  const x = await rB()
  assert.ok(x.code === 0, ec(x))
})

// --- B2..B6: a committed enabledPlugins is refused (ADR 0022, supersedes 0021) ------------------
// Deliberately OUTSIDE the stub-emitter block below. The gate protects ADR 0010's non-forcing invariant,
// so it must fire in a repo with no emitter and no node — these fixtures have neither, which is
// what proves the check runs ahead of both skip paths.
const rB2 = scn(async () => {
  const b2 = newRepo('pc-enabled-plugins')
  writeFile(b2, '.claude/settings.json', '{\n  "enabledPlugins": { "ywr-harness@ywrlabs": true }\n}\n')
  await git(b2, ['add', '-A'])
  return await invokeHook(b2, preCommit)
})
T('B2 a staged enabledPlugins BLOCKS the commit', async () => { const x = (await rB2()); assert.ok(x.code === 1, ec(x)) })
T('B2 the forcing consequence is stated, not just the rule', async () => { const x = (await rB2()); assert.ok(M(x.out, 'forces the plugin on everyone'), x.out) })
T('B2 the governing ADRs are named', async () => { const x = (await rB2()); assert.ok(M(x.out, 'ADR 0010/0022'), x.out) })

// B3 is the control for B2/B4/B5. Without it, a check that refused .claude/settings.json
// unconditionally — or one that refused every commit — would score identically to the one we want
// (the unmutated-control lesson, ADR 0013). The file is staged; only the forbidden KEY is absent.
const rB3 = scn(async () => {
  const b3 = newRepo('pc-settings-no-key')
  writeFile(b3, '.claude/settings.json', '{\n  "permissions": { "allow": [] }\n}\n')
  await git(b3, ['add', '-A'])
  return await invokeHook(b3, preCommit)
})
T('B3 the same file WITHOUT the key is not blocked', async () => { const x = (await rB3()); assert.ok(x.code === 0, ec(x)) })
T('B3 and it is not reported as refused', async () => { const x = (await rB3()); assert.ok(!M(x.out, 'REFUSED'), x.out) })

// B4: `--scope local` writes the SAME key into settings.local.json, in the tree, and a refusal
// message may recommend that scope as the fix (ADR 0022). A gate that names one filename and
// recommends the other is worse than no gate.
const rB4 = scn(async () => {
  const b4 = newRepo('pc-enabled-plugins-local')
  writeFile(b4, '.claude/settings.local.json', '{\n  "enabledPlugins": { "ywr-harness@ywrlabs": true }\n}\n')
  // `add -f`: a machine can carry a GLOBAL gitignore entry for .claude/settings.local.json, so
  // `add -A` silently stages nothing here and the case would pass vacuously. A teammate's machine
  // has no such entry, and there the path is trackable.
  await git(b4, ['add', '-f', '.claude/settings.local.json'])
  return await invokeHook(b4, preCommit)
})
T('B4 settings.local.json is gated too', async () => { const x = (await rB4()); assert.ok(x.code === 1, ec(x)) })
T('B4 the refusal names the local file', async () => { const x = (await rB4()); assert.ok(M(x.out, r`settings\.local\.json declares`), x.out) })
T('B4 rescoping is explicitly not a fix', async () => { const x = (await rB4()); assert.ok(M(x.out, 'not a fix'), x.out) })

// B5: an uninstall leaves `{ "enabledPlugins": {} }` behind. ADR 0022 refuses the KEY regardless of
// value, so the inert form is refused too — a deliberate false positive, not an oversight.
const rB5 = scn(async () => {
  const b5 = newRepo('pc-enabled-plugins-empty')
  writeFile(b5, '.claude/settings.json', '{\n  "enabledPlugins": {}\n}\n')
  await git(b5, ['add', '-A'])
  return await invokeHook(b5, preCommit)
})
T('B5 an inert empty enabledPlugins is refused too', async () => { const x = (await rB5()); assert.ok(x.code === 1, ec(x)) })
T('B5 the uninstall residue is explained', async () => { const x = (await rB5()); assert.ok(M(x.out, 'remove the key, not just the entry'), x.out) })

// B6: the hook's KNOWN limit, asserted so it stays known. A \uXXXX-escaped key is the same key to
// any JSON parser and to the host, but a literal grep cannot see it. CI parses and catches this;
// this case exists so the gap is a recorded property rather than a surprise (ADR 0022 Consequences).
const rB6 = scn(async () => {
  const b6 = newRepo('pc-enabled-plugins-escaped')
  // The escape is ASSEMBLED, not typed: a literal backslash-u in source is the kind of thing an editor
  // or a copy-paste normalises away, and a fixture that silently degrades to the plain spelling would
  // invert this case's meaning without failing.
  const escKey = String.fromCharCode(0x5c) + 'u0065' + 'nabledPlugins'   // -> enabledPlugins, i.e. "enabledPlugins"
  writeFile(b6, '.claude/settings.json', `{\n  "${escKey}": { "p@m": true }\n}\n`)
  await git(b6, ['add', '-A'])
  return invokeHook(b6, preCommit)
})
T('B6 the hook does NOT catch an escaped key (known limit, CI does)', async () => {
  const x = await rB6()
  assert.ok(x.code === 0, ec(x))
})

// --- C-F: STUB emitter — the hook's parse + execute contract, independent of any linter ---------
// The stub prints an emitter-shaped block whose commands are shell builtins, so what is measured is
// the hook's behaviour and nothing else.
async function newStubRepo(name, gateBlock) {
  const p = newRepo(name)
  // The gate blocks below are written as print("...") lines; the stub gives them a Node `print`.
  const stub = ['const print = (s) => console.log(s)', 'print("scope: 1 explicit file(s)")', 'print("gates:")', gateBlock,
    'print("review tier: small — stub")', ''].join('\n')
  writeFile(p, 'scripts/harness/harness_gates.mjs', stub)
  writeFile(p, 'app.py', 'print(1)\n')
  await git(p, ['add', '-A'])
  return p
}
const stubRun = (name, gateBlock, extra) => scn(async () => {
  const p = await newStubRepo(name, gateBlock)
  if (extra) { extra(p); await git(p, ['add', '-A']) }
  return await invokeHook(p, preCommit)
})
// The emitter and its stub run on the Node that runs this suite, so no tool lookup can skip these cases.

// C: a passing file-scoped gate runs and the commit proceeds
const rC = stubRun('pc-pass', 'print("  [g] 1 file(s)")\nprint("    true")')
T('GH3 C a passing gate lets the commit through', async () => { const x = (await rC()); assert.ok(x.code === 0, ec(x)) })
T('GH3 C the command that ran is echoed', async () => { const x = (await rC()); assert.ok(M(x.out, r`\$ true`), x.out) })
T('GH3 C success is stated', async () => { const x = (await rC()); assert.ok(M(x.out, 'deterministic gates passed'), x.out) })

// D: a FAILING gate blocks the commit. The whole point of the hook.
const rD = stubRun('pc-fail', 'print("  [g] 1 file(s)")\nprint("    false")')
T('GH4 D a failing gate BLOCKS the commit', async () => { const x = (await rD()); assert.ok(x.code === 1, ec(x)) })
T('GH4 D the failing command is named', async () => { const x = (await rD()); assert.ok(M(x.out, r`FAIL \(\d+\): false`), x.out) })
T('GH4 D the escape hatch is stated', async () => { const x = (await rD()); assert.ok(M(x.out, '--no-verify'), x.out) })

// D2: a gate whose RUNNER is not on PATH is a counted, reported SKIP, never FAILED (ADR 0015:
// "a missing interpreter is a reported skip"). Otherwise a member without uv is blocked on
// every commit, and --no-verify, which also skips the enabledPlugins refusal, is the only way
// out. The `true` after it proves the loop continues past the skip; D above is the control that
// a runner which exists and fails still blocks.
const rD2 = stubRun('pc-missing-runner', 'print("  [g] 1 file(s)")\nprint("    ywr-no-such-runner check app.py")\nprint("    true")')
T('D2 a missing runner does not block the commit', async () => { const x = (await rD2()); assert.ok(x.code === 0, ec(x)) })
T('D2 the skip names the runner and says CI still gates', async () => {
  const x = (await rD2())
  assert.ok(M(x.out, r`SKIP \(runner 'ywr-no-such-runner' not on PATH`) && M(x.out, r`reported, not silent; CI still gates this commit\): ywr-no-such-runner check app\.py`), x.out)
})
T('D2 a missing runner is not reported as a FAIL', async () => { const x = (await rD2()); assert.ok(!M(x.out, r`FAIL \(`) && !M(x.out, 'gates FAILED'), x.out) })
T('D2 the loop continues past the skip', async () => { const x = (await rD2()); assert.ok(M(x.out, r`\$ true`), x.out) })
T('D2 the summary counts the skip and does not call it passed', async () => {
  const x = (await rD2())
  assert.ok(M(x.out, r`1 gate\(s\) passed, 1 SKIPPED`) && !M(x.out, 'deterministic gates passed'), x.out)
})

// D2b: the `cd <cwd> && <runner> …` shape compose() gives a `groups[].cwd` gate. The runner is
// the 4th token, as in CI's extraction — reading the first would test `cd`, a builtin that is
// always found, and the gate would die 127 as a FAIL. `sub/` exists so that mutant's `cd`
// succeeds and the failure is the runner's, not the directory's.
const rD2b = stubRun('pc-missing-runner-cwd', 'print("  [g] 1 file(s)")\nprint("    cd sub && ywr-no-such-runner check x.txt")', (p) => writeFile(p, 'sub/x.txt', 'x\n'))
T('D2b a cwd-composed gate derives its runner from the 4th token and skips it', async () => {
  const x = (await rD2b())
  assert.ok(x.code === 0 && M(x.out, r`SKIP \(runner 'ywr-no-such-runner'`) && !M(x.out, r`FAIL \(`), ec(x))
})

// D2c: the cwd shape with a runner that EXISTS and fails still blocks — the preflight must not
// swallow a real failure behind the `cd` prefix.
const rD2c = stubRun('pc-cwd-fail', 'print("  [g] 1 file(s)")\nprint("    cd sub && false")', (p) => writeFile(p, 'sub/x.txt', 'x\n'))
T('D2c a cwd-composed gate whose runner exists and fails still BLOCKS', async () => {
  const x = (await rD2c())
  assert.ok(x.code === 1 && M(x.out, r`FAIL \(\d+\): cd sub && false`) && !M(x.out, r`SKIP \(runner`), ec(x))
})

// E: the "(no gate declared)" parenthetical must NOT be executed.
// The note is indented the same four spaces as a command, so a naive parser hands
// `(no gate declared ...)` to sh, which opens a subshell and dies with "no: command not found".
// The default .harness.json ships a group of exactly that shape, so every scaffolded repo meets it.
const rE = stubRun('pc-parenthetical', 'print("  [g] 1 file(s)")\nprint("    (no gate declared for this group — nothing deterministic runs on it)")')
T('GH5 E a parenthetical note is not executed', async () => { const x = (await rE()); assert.ok(x.code === 0, ec(x)) })
T('GH5 E and it is not mistaken for a command', async () => { const x = (await rE()); assert.ok(!M(x.out, 'command not found'), x.out) })

// E5: an ungrouped file is REPORTED at commit time (ADR 0062). CI fails on the emitter's
// `ungrouped (` header; the hook does not. The line closes the local/CI asymmetry without changing
// the advisory exit contract, so the commit still proceeds. The stub prints the header VERBATIM as
// harness_gates.mjs emits it (long tail, em dashes): a fixture with a short text would keep passing
// while the real parser drifted. Case G below is the end-to-end pairing with the real emitter.
const rE5 = stubRun('pc-ungrouped', [
  'print("  [g] 1 file(s)")',
  'print("    true")',
  `print("ungrouped (1 file(s) — no declared group matched, so NO deterministic gate covers them; CI's harness-gates run FAILS on this — add a groups entry to .harness.json):")`,
  'print("  weird.rb")',
].join('\n'))
T('E5 an ungrouped file is named as a CI failure at commit time', async () => { const x = (await rE5()); assert.ok(M(x.out, r`1 staged file\(s\) matched NO declared group`), x.out) })
T('E5 but it does not block the commit', async () => { const x = (await rE5()); assert.ok(x.code === 0, ec(x)) })
T('E5 the gate before the header still ran', async () => { const x = (await rE5()); assert.ok(M(x.out, r`\$ true`), x.out) })

// E2/E3: the no-commands report distinguishes DECLARED coverage from a coverage HOLE.
// One message would conflate them: files matching groups that declare `gates: []`
// read identically to files no group claims, and only the second is a warning.
// E2 — no group header in the window at all: the coverage-hole wording stays.
const rE2 = stubRun('pc-unmatched', 'print("  (none — no declared group matched, matched groups declare no gates, or every declared gate was refused or skipped)")')
T('E2 unmatched files keep the no-match wording', async () => { const x = (await rE2()); assert.ok(x.code === 0 && M(x.out, 'no file-scoped gate matched'), ec(x)) })
T('E2 and are not reported as matched', async () => { const x = (await rE2()); assert.ok(!M(x.out, r`matched group\(s\)`), x.out) })

// E3 — groups matched but yield nothing runnable: the groups are NAMED and the no-match
// wording must not appear.
const rE3 = stubRun('pc-matched-no-gates', [
  'print("  [scripts] 3 file(s)")',
  'print("    (no gate declared for this group — nothing deterministic runs on it)")',
  'print("  [meta] 1 file(s)")',
  'print("    (no gate declared for this group — nothing deterministic runs on it)")',
].join('\n'))
T('E3 matched-but-gateless names the groups', async () => { const x = (await rE3()); assert.ok(x.code === 0 && M(x.out, r`matched group\(s\) \[scripts, meta\]`), ec(x)) })
T('E3 and does not claim nothing matched', async () => { const x = (await rE3()); assert.ok(!M(x.out, 'no file-scoped gate matched'), x.out) })

// E4: a group name carrying ']' survives the extraction whole — cutting at the FIRST ']'
// would misname the group in the report. Names reach an echo only.
const rE4 = stubRun('pc-bracket-name', 'print("  [we]ird] 2 file(s)")\nprint("    (no gate declared for this group — nothing deterministic runs on it)")')
T('E4 a bracketed group name is reported whole', async () => { const x = (await rE4()); assert.ok(x.code === 0 && M(x.out, r`matched group\(s\) \[we\]ird\],`), ec(x)) })

// F: whole-program gates are deferred to CI, and the deferral is reported
const rF = stubRun('pc-whole', 'print("  [g] 1 file(s)")\nprint("    true")\nprint("    false   # whole-program: gate on slice files or newly introduced only")')
T('GH6 F whole-program gate is not run here', async () => { const x = (await rF()); assert.ok(x.code === 0, ec(x)) })
T('GH6 F the deferral is reported, not silent', async () => { const x = (await rF()); assert.ok(M(x.out, r`1 whole-program gate\(s\) NOT run here`), x.out) })

// G: END-TO-END with the REAL vendored emitter. No stub, no linter dependency: a group that
// matches files but declares no gates is the deterministic path through the real code.
const realEmitter = (repo) => {
  for (const n of ['harness_config.mjs', 'harness_git.mjs', 'harness_gates.mjs']) {
    copyInto(repo, path.join(here, 'templates/scripts/harness', n), `scripts/harness/${n}`)
  }
}
const rG = scn(async () => {
  const g = newRepo('pc-e2e')
  realEmitter(g)
  writeFile(g, '.harness.json', r`{ "groups": [ { "name": "src", "match": "^src/.*\\.py$", "gates": [] } ] }`)
  writeFile(g, 'src/app.py', 'print(1)\n')
  await git(g, ['add', '-A'])
  return await invokeHook(g, preCommit)
})
T('GH7 G end-to-end with the real emitter exits 0', async () => { const x = (await rG()); assert.ok(x.code === 0, ec(x)) })
T('GH7 G the real parenthetical is not executed either', async () => { const x = (await rG()); assert.ok(!M(x.out, 'command not found'), x.out) })
T('GH7 G the real emitter output yields the matched-group wording (issue #45)', async () => { const x = (await rG()); assert.ok(M(x.out, r`matched group\(s\) \[src\]`), x.out) })

// G2: END-TO-END with a declared artifact check (ADR 0068). The emitter's `  [artifacts]` header
// shares the group-header shape, so the MATCHED_GROUPS awk must not splice its unstripped tail into
// the report ('matched group(s) [src, artifacts] 1 declared drift check(s) …]'). The check line
// itself must be DEFERRED (whole-program), never run here.
const rG2 = scn(async () => {
  const g2 = newRepo('pc-e2e-art')
  realEmitter(g2)
  fs.mkdirSync(path.join(g2, 'docs'), { recursive: true })
  const g2url = 'https://claude.ai/code/artifact/00000000-0000-0000-0000-00000000ab68'
  writeFile(g2, '.harness.json', '{ "artifacts": { "readme": "README.md", "items": [ { "url": "' + g2url + '", "title": "pc-e2e-art · docs", "source": "docs/page.html", "check": { "runner": "python", "script": "scripts/check_drift.py" } } ] }, "groups": [ { "name": "src", "match": "^src/.*\\\\.py$", "gates": [] } ] }')
  writeFile(g2, 'README.md', `docs: ${g2url}`)
  writeFile(g2, 'docs/page.html', '<p>page</p>')
  writeFile(g2, 'scripts/check_drift.py', 'print("CHECK-RAN")')
  writeFile(g2, 'src/app.py', 'print(1)\n')
  await git(g2, ['add', '-A'])
  return await invokeHook(g2, preCommit)
})
T('G2 artifact-check e2e exits 0', async () => { const x = (await rG2()); assert.ok(x.code === 0, ec(x)) })
T('G2 the matched-group report stays clean — the [artifacts] header is not spliced in', async () => {
  const x = (await rG2())
  assert.ok(M(x.out, r`matched group\(s\) \[src\]`) && !M(x.out, r`declared drift check\(s\).*\],|\[src, artifacts`), x.out)
})
T('G2 the check is deferred to CI, not run by the hook', async () => {
  const x = (await rG2())
  assert.ok(!M(x.out, 'CHECK-RAN') && M(x.out, r`whole-program gate\(s\) deferred to CI`), x.out)
})

// G3: END-TO-END, a non-ASCII staged path under core.quotepath=true (Git for Windows' default).
// Unpinned, the hook's STAGED list carries `"docs/\355\225\234...md"`, quoted and octal-escaped.
// The real emitter then reports it ungrouped, and the hook prints a FALSE
// "matched NO declared group — CI's harness-gates run FAILS" line for a file CI groups
// correctly (loud, not silent). The pin fixes group matching only; G3b pins what it does not
// change. The emitter and declaration are COMMITTED first so the Korean file is the
// only staged path; the name is built from code points (U+D55C U+AE00) so no editor or codepage
// can rewrite the fixture. The unpinned read is asserted quoted first: without that, a machine
// whose git never quotes would pass this case vacuously.
const g3state = scn(async () => {
  const g3 = newRepo('pc-e2e-quotepath')
  realEmitter(g3)
  writeFile(g3, '.harness.json', '{ "groups": [ { "name": "docs", "match": "^docs/", "gates": [] } ] }')
  await git(g3, ['add', '-A'])
  await git(g3, ['commit', '-q', '-m', 'emitter + declaration'])
  await git(g3, ['config', 'core.quotepath', 'true'])
  const kRel = 'docs/' + String.fromCharCode(0xd55c, 0xae00) + '.md'
  fs.mkdirSync(path.join(g3, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(g3, kRel), '# k\n', 'utf8')
  await git(g3, ['add', '-A'])
  // The boundary pins core.quotepath=false before the caller's arguments; the later -c wins, so this read is
  // git's own unpinned default under the repo's quotepath=true.
  const raw = (await gitResultA(g3, ['-c', 'core.quotepath=true', 'diff', '--cached', '--name-only'])).stdout.trim()
  const rG3 = await invokeHook(g3, preCommit)
  // G3b: what the pin does NOT change, pinned so the hook's comment cannot overclaim.
  // A non-ASCII name fails the emitter's SAFE_TOKEN gate, so even
  // matched it never becomes a file-scoped gate argument — here exactly as in CI. The group gains
  // a file-scoped gate (working tree only; the staged list is still the one Korean file): the
  // exclusion is REPORTED and no gate command is composed or run for it.
  writeFile(g3, '.harness.json', '{ "groups": [ { "name": "docs", "match": "^docs/", "gates": ["shellcheck"] } ] }')
  const rG3b = await invokeHook(g3, preCommit)
  return { raw, rG3, rG3b }
})
T('G3 fixture: the UNPINNED staged list is quoted and octal-escaped (case is not vacuous)', async () => {
  const { raw } = (await g3state())
  assert.ok(M(raw, r`^"docs/\\355\\225\\234\\352\\270\\200\.md"$`), `raw=${raw}`)
})
T('G3 a non-ASCII staged path matches its group under core.quotepath=true', async () => {
  const { rG3 } = (await g3state()); assert.ok(rG3.code === 0 && M(rG3.out, r`matched group\(s\) \[docs\]`), ec(rG3))
})
T('G3 and it is not reported as ungrouped', async () => { const { rG3 } = (await g3state()); assert.ok(!M(rG3.out, 'matched NO declared group'), rG3.out) })
T('G3b a matched non-ASCII path is still EXCLUDED from file-scoped gate arguments — reported, and no gate runs on it', async () => {
  const { rG3b } = (await g3state())
  assert.ok(rG3b.code === 0 && M(rG3b.out, 'could not be passed') && M(rG3b.out, r`matched group\(s\) \[docs\], but none yields a runnable file-scoped gate`) && !M(rG3b.out, 'shellcheck docs/'), ec(rG3b))
})

// G4: END-TO-END, a route-path file argument (ADR 0112). The real emitter single-quotes
// `src/app/(admin)/…` and `src/app/[id]/…`; the hook's `set -f` runner split and its `sh -c` must
// hand both to the gate literally. A stub `shellcheck` first on PATH prints the argv it RECEIVED.
// The decoy `src/app/i/page.sh` is committed, not staged: a glob of `[id]` would hand IT over.
const rG4 = scn(async () => {
  const g4 = newRepo('pc-e2e-routes')
  realEmitter(g4)
  writeFile(g4, '.harness.json', '{ "groups": [ { "name": "sh", "match": "^src/", "gates": ["shellcheck"] } ] }')
  writeFile(g4, 'src/app/i/page.sh', 'echo i\n')
  await git(g4, ['add', '-A'])
  await git(g4, ['commit', '-q', '-m', 'emitter + declaration + decoy'])
  writeFile(g4, 'src/app/(admin)/page.sh', 'echo a\n')
  writeFile(g4, 'src/app/[id]/page.sh', 'echo b\n')
  await git(g4, ['add', '-A'])
  const g4Stub = path.join(fxBase, 'g4-stub')
  writeFile(g4Stub, 'shellcheck', ['#!/bin/sh', "printf 'STUB shellcheck '", 'for a in "$@"; do printf \'<%s>\' "$a"; done', "printf '\\n'", ''].join('\n'))
  if (!win) fs.chmodSync(path.join(g4Stub, 'shellcheck'), 0o755)
  return await invokeHook(g4, preCommit, null, { pathPrefix: g4Stub })
})
T('G4 route-path files reach the file-scoped gate literally, one argument each, and the hook passes', async () => {
  const x = (await rG4())
  assert.ok(x.code === 0 && M(x.out, r`STUB shellcheck <src/app/\(admin\)/page\.sh><src/app/\[id\]/page\.sh>`), ec(x))
})
T('G4 the committed decoy is not globbed in, and nothing is reported excluded', async () => {
  const x = (await rG4()); assert.ok(!M(x.out, r`src/app/i/page\.sh`) && !M(x.out, 'could not be passed'), x.out)
})

// =================================================================================================
// pre-push — secret scan over ADDED lines of the pushed range
// =================================================================================================
const newPushRepo = (name) => newRepo(name)
const invokePrePush = (repo, base, tip, opts) => invokeHook(repo, prePush, `refs/heads/main ${tip} refs/heads/main ${base}`, opts) // git's contract: <local ref> <local oid> <remote ref> <remote oid>
async function addCommit(repo, rel, body, msg) {
  writeFile(repo, rel, body)
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-q', '-m', msg])
  return await gitOut(repo, ['rev-parse', 'HEAD'])
}
const head = (repo) => gitOut(repo, ['rev-parse', 'HEAD'])

// A fake key that matches the AKIA pattern without being anyone's credential.
const fakeKey = 'AKIA' + 'IOSFODNN7EXAMPLE'

// --- H: a clean range passes -------------------------------------------------------------------
const rH = scn(async () => {
  const h = newPushRepo('pp-clean')
  const base = await head(h)
  const tip = await addCommit(h, 'readme.md', '# hello\nnothing to see\n', 'clean')
  return await invokePrePush(h, base, tip)
})
T('GH8 H a clean range is not blocked', async () => { const x = (await rH()); assert.ok(x.code === 0, ec(x)) })
T('GH8 H the scan reports what it covered', async () => { const x = (await rH()); assert.ok(M(x.out, 'no secret pattern in added lines'), x.out) })

// --- I: a secret in an added line BLOCKS the push ----------------------------------------------
const iState = scn(async () => {
  const i = newPushRepo('pp-secret')
  const base = await head(i)
  const tip = await addCommit(i, 'config.txt', `aws_key = ${fakeKey}\n`, 'oops')
  return { repo: i, r: await invokePrePush(i, base, tip) }
})
T('GH9 I an added secret blocks the push', async () => { const x = (await iState()).r; assert.ok(x.code === 1, ec(x)) })
T('GH9 I the pattern that matched is labelled', async () => { const x = (await iState()).r; assert.ok(M(x.out, 'aws-access-key-id'), x.out) })
T('GH9 I rotation is stated, not just rewriting', async () => { const x = (await iState()).r; assert.ok(M(x.out, 'rotate'), x.out) })

// --- I2: a pattern whose regex STARTS WITH A DASH still runs ------------------------------------
// `private-key-block` is `-----BEGIN [A-Z ]*PRIVATE KEY-----`. Passed to grep positionally, grep
// reads it as an option bundle, prints "unknown option", matches nothing, and the hook still
// reports a clean scan. Every other pattern starts with a letter, so only this case shows a dead
// pattern. `grep -e` is the fix. Assert the BLOCK, not the absence of the error text: a scanner that
// silently skips a pattern is indistinguishable from a clean scan unless you make it fire.
const rI2 = scn(async () => {
  const i2 = newPushRepo('pp-dash-pattern')
  const base = await head(i2)
  const body = '-'.repeat(5) + 'BEGIN RSA PRIVATE KEY' + '-'.repeat(5) + '\nnot a real key\n'
  const tip = await addCommit(i2, 'id_rsa', body, 'leaked a key block')
  return await invokePrePush(i2, base, tip)
})
T('I2 a leading-dash pattern still blocks the push', async () => { const x = (await rI2()); assert.ok(x.code === 1, ec(x)) })
T('I2 the private-key pattern is the one labelled', async () => { const x = (await rI2()); assert.ok(M(x.out, 'private-key-block'), x.out) })
T('I2 grep did not reject the pattern as an option', async () => { const x = (await rI2()); assert.ok(!M(x.out, 'unknown option'), x.out) })

// --- J: a secret already in history, outside the pushed range, is NOT re-flagged ---------------
// Otherwise every subsequent push is blocked by the same old line and people learn to --no-verify.
const rJ = scn(async () => {
  const i = (await iState()).repo   // the commit below lands on I's repository, after I's own run has finished
  const base = await head(i)
  const tip = await addCommit(i, 'other.txt', 'harmless\n', 'later')
  return invokePrePush(i, base, tip)
})
T('GH10 J a pre-existing secret outside the range does not block', async () => {
  const x = await rJ()
  assert.ok(x.code === 0, ec(x))
})

// --- K: the allow marker exempts a line --------------------------------------------------------
const kState = scn(async () => {
  const k = newPushRepo('pp-allow')
  const base = await head(k)
  const tip = await addCommit(k, 'doc.md', `example only: ${fakeKey}   harness:allow-secret\n`, 'documented')
  return { repo: k, base, r: await invokePrePush(k, base, tip) }
})
T('GH11 K an allow-marked line is exempt', async () => { const x = (await kState()).r; assert.ok(x.code === 0, ec(x)) })

// --- L: branch deletion is a no-op -------------------------------------------------------------
const rL = scn(async () => {
  const { repo, base } = (await kState())
  return invokeHook(repo, prePush, `(delete) ${'0'.repeat(40)} refs/heads/gone ${base}`)
})
T('GH12 L a branch deletion is not scanned', async () => {
  const x = await rL()
  assert.ok(x.code === 0, ec(x))
})

// --- M: the hook does not flag ITS OWN SOURCE --------------------------------------------------
// The pre-push script is a file full of secret regexes. If any of them matches the pattern list
// itself, then committing the hook — which is exactly what /harness-init makes a repo do — blocks
// the next push, and the harness becomes unshippable.
const rM = scn(async () => {
  const m = newPushRepo('pp-self')
  const base = await head(m)
  fs.copyFileSync(prePush, path.join(m, 'pre-push-copy'))
  fs.copyFileSync(preCommit, path.join(m, 'pre-commit-copy'))
  await git(m, ['add', '-A'])
  await git(m, ['commit', '-q', '-m', 'add the hooks themselves'])
  return invokePrePush(m, base, await head(m))
})
T('GH13 M the hooks do not flag their own source', async () => {
  const x = await rM()
  assert.ok(x.code === 0, ec(x))
})

// --- N: the generic assigned-secret pattern still catches a real-looking assignment ------------
// M could pass trivially if the patterns matched nothing at all. This is the control for it.
const rN = scn(async () => {
  const n = newPushRepo('pp-generic')
  const base = await head(n)
  const tip = await addCommit(n, 'settings.py', "api_key = 'zK3nQ8vR1tYw0pLmXs74'\n", 'generic') // harness:allow-secret
  return await invokePrePush(n, base, tip)
})
T('GH14 N a generic assigned secret is caught', async () => { const x = (await rN()); assert.ok(x.code === 1, ec(x)) })
T('GH14 N labelled as the generic pattern', async () => { const x = (await rN()); assert.ok(M(x.out, 'generic-assigned-secret'), x.out) })

// --- I3/I4: added lines that are not valid text are still scanned ----------------
// Under a UTF-8 locale, as on every Linux CI runner, GNU grep drops each added line that is not
// valid UTF-8 (a CP949 fixture), prints "binary file matches" on stderr, and the hook would still
// report the commit scanned and clean. The hook scans in the C locale with `grep -a`. The
// suite FORCES a UTF-8 locale for these runs, so the case reproduces on Windows' Git sh as well as
// on Linux, and proves the hook overrides the caller's locale. I3's generic secret has the CP949
// bytes INSIDE its quoted value: `grep -a` alone would still miss it under UTF-8 (an invalid byte
// matches no bracket class there), so the C locale is what I3 measures. I4 is a NUL byte in a diff
// git prints as text (the `diff` attribute), the binary trigger the C locale does not remove — `-a`
// is what I4 measures.
const i34 = scn(async () => {
  const utf8Locale = { env: { LC_ALL: 'C.UTF-8' } }   // each hook run gets the locale; the process environment is never touched
  const ascii = (s) => Buffer.from(s, 'ascii')
  const cp949 = Buffer.from([0xb0, 0xa1, 0xb0, 0xa1])   // two Hangul syllables in CP949; invalid as UTF-8
  const i3 = newPushRepo('pp-non-utf8')
  const i3Base = await head(i3)
  fs.writeFileSync(path.join(i3, 'schema.df'), Buffer.concat([
    ascii(`aws = ${fakeKey} `), cp949, ascii('\n'),
    ascii("api_key = '"), cp949, ascii("zK3nQ8vR1tYw0pLm'\n")]))
  await git(i3, ['add', '-A'])
  await git(i3, ['commit', '-q', '-m', 'cp949 fixture'])
  const rI3 = await invokePrePush(i3, i3Base, await head(i3), utf8Locale)

  const i4 = newPushRepo('pp-nul-text')
  const i4Base = await head(i4)
  writeFile(i4, '.gitattributes', '*.dat diff\n')
  fs.writeFileSync(path.join(i4, 'dump.dat'), Buffer.concat([ascii(`aws = ${fakeKey} `), Buffer.from([0x00]), ascii('\n')]))
  await git(i4, ['add', '-A'])
  await git(i4, ['commit', '-q', '-m', 'nul in a text diff'])
  const rI4 = await invokePrePush(i4, i4Base, await head(i4), utf8Locale)
  return { rI3, rI4 }
})
T('I3 a non-UTF-8 added line blocks the push under a UTF-8 locale', async () => {
  const { rI3 } = (await i34()); assert.ok(rI3.code === 1 && M(rI3.out, 'aws-access-key-id'), ec(rI3))
})
T('I3 a secret whose value holds non-UTF-8 bytes is caught', async () => { const { rI3 } = (await i34()); assert.ok(M(rI3.out, 'generic-assigned-secret'), rI3.out) })
T('I3 grep treated no line as binary', async () => { const { rI3 } = (await i34()); assert.ok(!M(rI3.out, '(?i)binary file'), rI3.out) })
T('I4 a NUL byte in a text diff does not hide the line', async () => {
  const { rI4 } = (await i34()); assert.ok(rI4.code === 1 && M(rI4.out, 'aws-access-key-id') && !M(rI4.out, '(?i)binary file'), ec(rI4))
})
// The block message must fit a hit in an earlier commit: there "amend" changes the wrong commit.
T('I3 the block message names the rebase route for a non-tip commit', async () => {
  const { rI3 } = (await i34()); assert.ok(M(rI3.out, 'rebase') && M(rI3.out, 'later commit cannot clear'), rI3.out)
})

// --- I5: a commit list git FAILED to produce is never an empty list ----------------------------------
// A force-push over commits that exist only on the remote hands the hook a remote oid that is no local
// object, so `git rev-list <remote>..<local>` fails. The hook must not read that as "nothing to
// scan". It scans every commit not on a remote instead, and blocks loudly when even that list
// cannot be made. An EMPTY list with exit 0 stays a quiet pass (I5e).
// A loop run costs about 1.5 s per commit on Windows, so the fixtures here are as small as the claim
// allows, and I6c reuses the secret repo.
const i5Gone = 'ab'.repeat(20)      // a well-formed oid that no object database holds
const i5 = scn(async () => {
  const repo = newPushRepo('pp-unfetched')
  const clean = await addCommit(repo, 'readme.md', 'nothing to see\n', 'clean commit')
  // The four runs before the update-ref read the same repository and write nothing: they run side by side.
  const [rb, rc, rd, re1] = await Promise.all([
    invokePrePush(repo, i5Gone, clean),
    invokePrePush(repo, i5Gone, 'cd'.repeat(20)),
    invokePrePush(repo, '0'.repeat(40), 'cd'.repeat(20)),
    invokePrePush(repo, clean, clean)])
  await git(repo, ['update-ref', 'refs/remotes/origin/main', clean])
  const re2 = await invokePrePush(repo, '0'.repeat(40), clean)
  return { repo, clean, rb, rc, rd, re1, re2 }
})
const i5sState = scn(async () => {
  const repo = newPushRepo('pp-unfetched-secret')
  const secret = await addCommit(repo, 'config.txt', `aws_key = ${fakeKey}\n`, 'secret commit')
  return { repo, secret, ra: await invokePrePush(repo, i5Gone, secret) }
})
T('I5a an unknown remote oid still scans, and a secret in a commit on no remote BLOCKS', async () => {
  const x = (await i5sState()).ra
  assert.ok(x.code === 1 && M(x.out, 'aws-access-key-id') && M(x.out, 'possible secret'), ec(x))
})
T('I5b clean commits behind an unknown remote oid pass, and the output says the wider scan ran', async () => {
  const x = (await i5()).rb
  assert.ok(x.code === 0 && M(x.out, 'not a local object') && M(x.out, 'scanning every commit') && M(x.out, 'no secret pattern'), ec(x))
})
T('I5c when the wider list fails too the push is BLOCKED loudly, naming the ref', async () => {
  const x = (await i5()).rc
  assert.ok(x.code === 1 && M(x.out, 'pre-push BLOCKED') && M(x.out, 'could not be resolved') && M(x.out, 'refs/heads/main') && !M(x.out, 'no secret pattern'), ec(x))
})
T('I5d a failed new-branch list is BLOCKED loudly too', async () => {
  const x = (await i5()).rd
  assert.ok(x.code === 1 && M(x.out, 'pre-push BLOCKED') && M(x.out, 'could not be resolved') && !M(x.out, 'no secret pattern'), ec(x))
})
T('I5e an EMPTY list with exit 0 is still a quiet pass, on an existing branch and on a new one', async () => {
  const { re1, re2 } = (await i5())
  assert.ok(re1.code === 0 && re1.out.trim() === '' && re2.code === 0 && re2.out.trim() === '', `existing: exit=${re1.code} out=${re1.out} new: exit=${re2.code} out=${re2.out}`)
})

// --- I7: three ways a push could pass with nothing read, or read as scanned when it was not ---
// I7a: `git rev-parse --show-toplevel` fails in a bare repository, and a guard on it would end the hook in
// a silent exit 0, although commit lists and diffs read fine there. I7b: a last stdin line with no
// newline is dropped by a bare `read`, so its ref would go unread. I7c: after the wider scan is announced, an
// empty list (every commit already on a remote, as $i5 is since the update-ref above) must say that
// 0 commits were scanned instead of ending silently. All three are clean pushes: no loop run.
const rI7a = scn(async () => {
  const { repo, clean } = (await i5())
  const bare = path.join(fxBase, 'pp-bare.git')
  await git(fxBase, ['clone', '-q', '--bare', repo, bare])
  return invokePrePush(bare, '0'.repeat(40), clean)
})
T('I7a a push from a bare repository is scanned, not passed in silence', async () => {
  const x = await rI7a()
  assert.ok(x.code === 0 && M(x.out, r`commit\(s\) scanned\)`), ec(x))
})
const rI7b = scn(async () => {
  const i7 = newPushRepo('pp-last-line')
  const tip = await addCommit(i7, 'readme.md', 'nothing to see\n', 'clean commit')
  return invokeHook(i7, prePush, `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}`, { noFinalNewline: true })
})
T('I7b a last stdin line with no newline is still read: its commit is scanned', async () => {
  const x = await rI7b()
  assert.ok(x.code === 0 && M(x.out, r`commit\(s\) scanned\)`), ec(x))
})
const rI7c = scn(async () => {
  const { repo, clean } = (await i5())
  return invokePrePush(repo, i5Gone, clean)
})
T('I7c an empty wider scan passes and says that 0 commits were scanned', async () => {
  const x = await rI7c()
  assert.ok(x.code === 0 && M(x.out, 'scanning every commit') && M(x.out, '0 commits of it were scanned') && !M(x.out, 'no secret pattern'), ec(x))
})

// --- I6: the one-pass prefilter answers "clean" only with proof it read every commit ------------------
// The per-commit loop started about fourteen processes per commit. The prefilter reads every diff with
// one `git show --stdin` and one grep, and falls to the unchanged loop on a match or when its header
// count does not equal the commit count. A `git` shim logs each `git show` call, so "one call" proves the
// prefilter ran and "one call per commit" proves the loop did. The shim's mode breaks the one-pass read:
// `empty` prints nothing and exits 0 (the header count is short), `cut` stops the stream after the last
// header and exits 141 like a git killed by a broken pipe (the count is full, only the status gives it away).
const shimDir = path.join(fxBase, 'pp-shim')
const writeShim = lazy(() => {
  fs.mkdirSync(shimDir, { recursive: true })
  const g = toShPath(gitResolved)
  const body = [
    '#!/bin/sh',
    'if [ "$1" = show ]; then',
    '    echo "$*" >> "$HARNESS_SHIM_LOG"',
    '    case "$*" in *--stdin*)',
    '        case "$HARNESS_SHIM_MODE" in',
    '            empty) cat > /dev/null; exit 0 ;;',
    `            cut) '${g}' "$@" | head -n 6; exit 141 ;;`,
    '        esac ;;',
    '    esac',
    'fi',
    `exec '${g}' "$@"`,
    '',
  ].join('\n')
  const shimGit = path.join(shimDir, 'git')
  fs.writeFileSync(shimGit, body, 'utf8')
  if (!win) fs.chmodSync(shimGit, 0o755)
})
async function invokePrePushShim(repo, base, tip, mode) {
  writeShim()
  const log = path.join(fxBase, `shim-${randomUUID().replaceAll('-', '')}.log`)
  // The shim dir goes first, ahead of the toolchain dirs invokeHook would otherwise prepend.
  const p = [shimDir, ...shExtraPath, process.env.PATH].join(path.delimiter)
  const x = await invokeHook(repo, prePush, `refs/heads/main ${tip} refs/heads/main ${base}`, {
    pathOverride: p, env: { HARNESS_SHIM_LOG: toShPath(log), HARNESS_SHIM_MODE: mode || undefined } })
  let shows = 0
  if (isFile(log)) {
    const lines = fs.readFileSync(log, 'utf8').split(/\r\n|\r|\n/)
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    shows = lines.length
  }
  return { ...x, shows }
}
// A history with a root commit, normal commits and a merge. The merge itself adds mergeLine (an evil
// merge: the line is in neither parent); marked is a secret-shaped line with the allow marker;
// sideLine is the side branch's file; withLast adds a commit after the merge. It returns the ids.
async function newMergeRepo(name, mergeLine, marked, sideLine, withLast) {
  const repo = newPushRepo(name)
  const mainBranch = await gitOut(repo, ['symbolic-ref', '--short', 'HEAD'])
  const first = await addCommit(repo, 'a.txt', 'one\ntwo\n', 'first')
  if (marked) await addCommit(repo, 'doc.md', `example only: ${marked}   harness:allow-secret\n`, 'documented')
  await git(repo, ['checkout', '-q', '-b', 'side'])
  const side = await addCommit(repo, 's.txt', `${sideLine}\n`, 'side')
  await git(repo, ['checkout', '-q', mainBranch])
  await addCommit(repo, 'm.txt', 'main\n', 'main')
  await gitResultA(repo, ['merge', '--no-ff', '--no-commit', 'side'])
  fs.appendFileSync(path.join(repo, 'a.txt'), `${mergeLine}\n`, 'utf8')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-q', '-m', 'merge'])
  const merge = await head(repo)
  const tip = withLast ? await addCommit(repo, 'z.txt', 'last\n', 'last') : merge
  return { base: first, side, merge, tip }
}
const zero40 = '0'.repeat(40)
const i6state = scn(async () => {
  const { tip } = await newMergeRepo('pp-fast-clean', 'plain merge line', fakeKey, 'side', true)
  const repo = path.join(fxBase, 'pp-fast-clean')
  const n = Number(await gitOut(repo, ['rev-list', '--count', tip]))
  const marked = await git(repo, ['log', '--format=%H', '-Sharness:allow-secret'])
  return { n, marked, ra: await invokePrePushShim(repo, zero40, tip, '') }
})
T('I6a a clean push of a root commit, normal commits and a merge passes on ONE git show call', async () => {
  const { n, ra } = (await i6state())
  assert.ok(ra.code === 0 && ra.shows === 1 && M(ra.out, `\\(${n} commit\\(s\\) scanned\\)`) && n >= 6, `exit=${ra.code} shows=${ra.shows} n=${n} out=${ra.out}`)
})
T('I6d a marker-exempt secret line is still exempt in the prefilter (and the fixture does hold one)', async () => {
  const { marked, ra } = (await i6state())
  assert.ok(ra.code === 0 && ra.shows === 1 && marked.trim() !== '', `exit=${ra.code} shows=${ra.shows} marked=${marked} out=${ra.out}`)
})
// A one-pass read that breaks must never read as clean: the secret in $i5s is still found, by the loop.
for (const m of ['empty', 'cut']) {
  const rI6c = scn(async () => {
    const { repo, secret } = (await i5sState())
    const short = await gitOut(repo, ['rev-parse', '--short', secret])
    return { short, x: await invokePrePushShim(repo, zero40, secret, m) }
  })
  T(`I6c a one-pass read that is '${m}' still BLOCKS the secret: the loop runs and reports it`, async () => {
    const { short, x } = await rI6c()
    assert.ok(x.code === 1 && x.shows > 1 && M(x.out, `\\[aws-access-key-id\\] in ${short}`), `exit=${x.code} shows=${x.shows} out=${x.out}`)
  })
}
// Two hits in a three-commit range, one on a side commit and one that only the merge adds: the report
// names each of those commits once and not the commit between them.
const rI6b = scn(async () => {
  const Mr = await newMergeRepo('pp-fast-secret', `evil = '${fakeKey}'`, '', `aws_key = ${fakeKey}`, false)
  const repo = path.join(fxBase, 'pp-fast-secret')
  const side = await gitOut(repo, ['rev-parse', '--short', Mr.side])
  const merge = await gitOut(repo, ['rev-parse', '--short', Mr.merge])
  return { side, merge, x: await invokePrePushShim(repo, Mr.base, Mr.tip, '') }
})
T('I6b hits on a side commit and on a merge are each labelled with their own commit, and no other', async () => {
  const { side, merge, x } = await rI6b()
  const hits = x.out.split('\n').filter((l) => /^\s+\[[a-z-]+\] in /i.test(l)).map((l) => l.trimEnd()).sort()
  const want = [`  [aws-access-key-id] in ${side}`, `  [aws-access-key-id] in ${merge}`].sort()
  assert.ok(x.code === 1 && `${hits.join(' ')}`.toLowerCase() === `${want.join(' ')}`.toLowerCase() && M(x.out, r`across 3 commit\(s\)`) && M(x.out, `      \\+aws_key = ${fakeKey}`),
    `exit=${x.code} hits=${hits.join('|')} want=${want.join('|')} out=${x.out}`)
})

// --- I8: a commit whose diff git cannot print blocks the push (ADR 0213) --------
// A deleted loose blob makes `git show` print nothing and exit 128. The loop must not read the
// empty output as "no added line" and report the commit as scanned. The removal is forced, because git
// writes loose objects read-only on Windows, and it is asserted, because a silenced failure would pass
// I8a unread.
async function removeBlob(repo, spec) {
  const oid = await gitOut(repo, ['rev-parse', spec])
  const f = path.join(repo, '.git/objects', oid.slice(0, 2), oid.slice(2))
  try { fs.rmSync(f, { force: true }) } catch { /* the assertion below reads the result */ }
  return !fs.existsSync(f)
}
// Every commit is made before the blob goes: a commit made after it either writes the blob again or,
// when git finds the index entry stat-clean, fails with "invalid object" on Windows.
const i8state = scn(async () => {
  const i8 = newPushRepo('pp-unread')
  const base = await addCommit(i8, 'base.txt', 'base\n', 'base')
  const tip = await addCommit(i8, 'lost.txt', 'clean but unreadable\n', 'lost blob')
  // The hit line starts with `++` (case I9 below), so one push also covers the header filter.
  const hit = await addCommit(i8, 'key.txt', `++aws_key = ${fakeKey}\n`, 'secret after the lost blob')
  const gone = await removeBlob(i8, `${tip}:lost.txt`)
  // I8b: a hit in a readable commit is still reported beside the unread one, so one push shows both.
  // The two runs only read the repository, so they run side by side.
  const [ra, rb] = await Promise.all([invokePrePush(i8, base, tip), invokePrePush(i8, base, hit)])
  return { tip, gone, ra, rb }
})
T('I8a a commit whose git show fails BLOCKS the push and is named, never counted as scanned', async () => {
  const { tip, gone, ra } = (await i8state())
  assert.ok(gone && ra.code === 1 && M(ra.out, 'could not print the diff') && M(ra.out, `  ${tip}`) && !M(ra.out, r`commit\(s\) scanned`), `gone=${gone} exit=${ra.code} out=${ra.out}`)
})
// I9 reads the same run. An added line whose text starts with `++` prints as `+++`, the start of a
// diff file header. A filter on `^+++` alone would drop that line from the prefilter and from the
// loop, and the push would pass with the secret. The run shares the I8 repo to save one per-commit
// loop, about 1.5 s on Windows.
T('I9 an added line that starts with ++ reaches the patterns and BLOCKS', async () => {
  const { rb } = (await i8state())
  assert.ok(rb.code === 1 && M(rb.out, r`\[aws-access-key-id\] in `) && M(rb.out, `      \\+\\+\\+aws_key = ${fakeKey}`), ec(rb))
})
T('I8b a hit in a readable commit is reported beside the unread commit, and the push blocks', async () => {
  const { tip, gone, rb } = (await i8state())
  assert.ok(gone && rb.code === 1 && M(rb.out, r`\[aws-access-key-id\] in `) && M(rb.out, `  ${tip}`) && M(rb.out, 'could not print the diff'), `exit=${rb.code} out=${rb.out}`)
})

// --- SS: the vendored CI's secret-scan step drives THIS pre-push over the run's range ------------
// The step's three workflow values live in env:, never in run: text (the file's own env-only
// rule). ci-enabled-plugins WS1 proves no `${{` is left in run: text; this proves the
// values still ARRIVE — a static check passes a step whose env: name and run: name disagree, and
// then a push range silently degrades to the ZERO fallback. The step body AND its env: mapping are
// EXTRACTED from the template by step name (what runs is what ships), and the fixture supplies
// values per workflow context, under whatever names the step declares.
const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c)
const ssCtx = ['github.event_name', 'github.base_ref', 'github.event.before']
const ssExtract = lazy(() => {
  const ssYml = path.join(here, 'templates/.github/workflows/harness-gates.yml')
  const ssName = "Secret scan over this run's commits (backstop)"
  const text = fs.readFileSync(ssYml, 'utf8').split(/\r\n|\r|\n/)
  if (text.length && text[text.length - 1] === '') text.pop()
  let body = null
  const env = {}
  const nameRx = new RegExp(`^\\s*-\\s+name:\\s+${escRx(ssName)}\\s*$`, 'i')
  let iSs = -1
  for (let i = 0; i < text.length; i++) if (nameRx.test(text[i])) { iSs = i; break }
  if (iSs >= 0) {
    for (let i = iSs + 1; i < text.length; i++) {
      if (/^\s*-\s+name:/i.test(text[i])) break
      let m = /^\s+([A-Z_][A-Z0-9_]*):\s*\$\{\{\s*([\w.]+)\s*\}\}\s*$/i.exec(text[i])
      if (m) { env[m[2]] = m[1]; continue }
      m = /^(\s*)run:\s*\|\s*$/i.exec(text[i])
      if (m) {
        const keyCol = m[1].length
        let bodyIndent = -1
        const lines = []
        for (let j = i + 1; j < text.length; j++) {
          const l = text[j]
          if (l.trim().length === 0) { lines.push(''); continue }
          const ind = l.length - l.trimStart().length
          if (ind <= keyCol) break
          if (bodyIndent < 0) bodyIndent = ind
          lines.push(l.slice(Math.min(bodyIndent, ind)))
        }
        body = lines.join('\n') + '\n'
        break
      }
    }
  }
  return { body, env, complete: body !== null && ssCtx.every((k) => Object.hasOwn(env, k)) }
})
T('SS0 the secret-scan step and its env: mapping are extracted from the template by name', async () => {
  const { body, env } = ssExtract()
  const complete = body !== null && M(body, r`sh \.githooks/pre-push`) && ssCtx.every((k) => Object.hasOwn(env, k))
  assert.ok(complete, `body=${body !== null && body !== ''} env=${Object.entries(env).map(([k, v]) => `${v}=${k}`).join(',')}`)
})
async function invokeSecretScanStep(repo, ctx) {
  // `sh -e <file>`, the way the runner runs a run: block (`bash -e {0}`: the path as an
  // ARGUMENT, errexit on). Not through invokeHook: that always executes its target directly, and this
  // scratch file has no exec bit, so a direct execute fails 126 on Linux.
  const { env } = ssExtract()
  const ssFile = path.join(fxBase, 'secret-scan-step.sh')
  fs.writeFileSync(ssFile, ssExtract().body, 'utf8')
  const over = {}
  for (const k of ssCtx) over[env[k]] = ctx[k] === '' ? undefined : ctx[k]   // an empty value is an unset variable
  return runShA(['-e', toShPath(ssFile)], repo, '', childEnv(over, defaultPath()))
}
// One repo: a secret committed BEFORE the range, one clean commit inside it. A range that
// reaches the step scans 1 commit and passes; each value lost on the way fails here — a lost
// EVENT_BEFORE takes the ZERO fallback and blocks on the older secret (SS1), a lost BASE_REF
// leaves `origin/` unresolvable (SS2 exits 1), a lost EVENT_NAME takes the ZERO fallback and
// scans 0 commits once the PR head is a remote ref (SS2, with SS2c as its control).
const ssState = scn(async () => {
  const ss = newPushRepo('ss-range')
  const ssOld = await addCommit(ss, 'old.txt', `aws_key = ${fakeKey}\n`, 'secret before the range')
  await addCommit(ss, 'new.txt', 'clean\n', 'clean commit in the range')
  fs.mkdirSync(path.join(ss, '.githooks'), { recursive: true })
  fs.copyFileSync(prePush, path.join(ss, '.githooks/pre-push'))
  const zero = '0'.repeat(40)
  // The two runs before the refs exist read the repository and write nothing: they run side by side.
  const [rS1, rS1c] = await Promise.all([
    invokeSecretScanStep(ss, { 'github.event_name': 'push', 'github.base_ref': '', 'github.event.before': ssOld }),
    invokeSecretScanStep(ss, { 'github.event_name': 'push', 'github.base_ref': '', 'github.event.before': zero })])
  // The PR refs are remote-tracking refs, created only NOW: the ZERO path above scans
  // `--not --remotes`, and an origin/main at the old commit would have hidden the control's secret.
  // A real PR checkout has BOTH: the base (origin/<base_ref>) and the PR head itself
  // (refs/remotes/pull/<n>/merge, HEAD here). The head ref is what makes EVENT_NAME observable:
  // with it, the push/ZERO fallback — where a lost EVENT_NAME lands, since `$EVENT_NAME` is then
  // not `pull_request` — finds 0 commits not on a remote, while the PR path scans
  // origin/<base>..HEAD = 1. Without it both print `(1 commit(s) scanned)`, so an env: name that
  // disagrees with `$EVENT_NAME` would pass SS2. That mutant kills the backstop on every real PR,
  // whose head is always a remote ref.
  await git(ss, ['update-ref', 'refs/remotes/origin/main', ssOld])
  await git(ss, ['update-ref', 'refs/remotes/pull/1/merge', 'HEAD'])
  const pRS2 = invokeSecretScanStep(ss, { 'github.event_name': 'pull_request', 'github.base_ref': 'main', 'github.event.before': '' })
  // SS2c: the control that makes SS2's observable unambiguous — the same refs with the event name
  // LOST (the value a mismatched env: name delivers) take the fallback and scan nothing.
  const pRS2c = invokeSecretScanStep(ss, { 'github.event_name': '', 'github.base_ref': 'main', 'github.event.before': '' })
  const [rS2, rS2c] = await Promise.all([pRS2, pRS2c])   // both only read the repository
  return { rS1, rS1c, rS2, rS2c }
})
T('SS1 push: the before SHA reaches the step through env: — only the range is scanned, with no unknown-range warning', async () => {
  const { rS1 } = (await ssState()); assert.ok(rS1.code === 0 && M(rS1.out, r`\(1 commit\(s\) scanned\)`) && !M(rS1.out, '::warning::'), ec(rS1))
})
T('SS1c control: a ZERO before (branch creation) warns that the push range is unknown (ADR 0213), scans the history and BLOCKS on the older secret', async () => {
  const { rS1c } = (await ssState()); assert.ok(rS1c.code === 1 && M(rS1c.out, '::warning::secret scan: ') && M(rS1c.out, 'aws-access-key-id'), ec(rS1c))
})
T('SS2 pull_request: the event name and base ref reach the step through env: — origin/<base>..HEAD is scanned', async () => {
  const { rS2 } = (await ssState()); assert.ok(rS2.code === 0 && M(rS2.out, r`\(1 commit\(s\) scanned\)`), ec(rS2))
})
T("SS2c control: with EVENT_NAME lost, the same PR refs take the ZERO fallback and scan 0 commits — SS2's count comes only from the PR path", async () => {
  const { rS2c } = (await ssState()); assert.ok(rS2c.code === 0 && !M(rS2c.out, r`commit\(s\) scanned`) && M(rS2c.out, 'secret scan: '), ec(rS2c))
})

// =================================================================================================
// post-commit — the slice retro's per-commit driver (ADR 0017, spec 0007 §3.4)
// =================================================================================================
// Placement (GUARDED) is init Q's and manifest-gate's; these cases RUN the body. Every branch exits
// 0, so an exit code alone proves nothing: each case asserts what the hook printed, and the stub
// retro's `[stub-retro]` line is what separates "ran the retro" from "exited early".
// Each guard has a case that fails without it: dropping `|| true` AND the final `exit 0` fails P2
// (either one alone is covered by the other, so the pair is the contract); dropping the SLICE_RETRO
// line fails P3; dropping the `[ -f "$RETRO" ]` guard fails P4 with or without node (an
// interpreter error on a missing file, or the SKIP line, non-empty either way); dropping the SKIP
// echo fails P5.
function newRetroRepo(name, stubBody) {
  const p = newRepo(name)
  if (stubBody) writeFile(p, 'scripts/harness/harness_retro.mjs', stubBody)
  return p
}
// Every post-commit case runs with SLICE_RETRO unset.
const retroOff = { SLICE_RETRO: undefined }

// P4: no vendored retro -> a silent exit 0. The guard runs before node is resolved, so this
// case needs no node.
const rP4 = scn(async () => invokeHook(newRetroRepo('pcm-no-retro', ''), postCommit, null, { env: retroOff }))
T('P4 without scripts/harness/harness_retro.mjs the hook exits 0 and prints nothing', async () => {
  const x = await rP4()
  assert.ok(x.code === 0 && x.out.trim() === '', ec(x))
})

// P5: a retro but no node on PATH -> a REPORTED skip, never a silent pass. PATH is replaced by
// one directory holding a `git` shim (the hook's first line needs git). Absence is VERIFIED under
// that PATH before asserting (fact 42: a narrowed PATH can keep an interpreter neighbour).
let p5 = null
if (!SKIP) {
  const p5repo = newRetroRepo('pcm-no-node', "console.log('[stub-retro] ran')\n")
  const binDir = path.join(fxBase, 'pcm-bin')
  fs.mkdirSync(binDir, { recursive: true })
  const gitShim = path.join(binDir, 'git')
  fs.writeFileSync(gitShim, `#!/bin/sh\nexec '${toShPath(gitLauncher)}' "$@"\n`, 'utf8')
  // POSIX needs the mode bit; Windows has none — git's MSYS sh treats a file opening with `#!` as
  // executable, which is what `command -v git` below proves rather than assumes.
  if (!win) fs.chmodSync(gitShim, 0o755)
  const narrow = childEnv({}, binDir)
  const nodeOnNarrow = runSh(['-c', 'command -v node; command -v nodejs'], undefined, '', narrow).out.trim()
  const gitOnNarrow = runSh(['-c', 'command -v git'], undefined, '', narrow).out.trim()
  p5 = { repo: p5repo, binDir, nodeOnNarrow, gitOnNarrow }
}
if (p5 && (p5.nodeOnNarrow || !p5.gitOnNarrow)) {
  // Locally a reported SKIP; on CI a FAIL — a probe that keeps failing there would otherwise
  // retire P5's assertion for good behind an all-green run.
  const why = `the narrowed PATH is not node-free with git (node='${p5.nodeOnNarrow}' git='${p5.gitOnNarrow}')`
  if (process.env.CI) T('P5 the git-shim PATH probe resolves on CI', () => { assert.fail(why) })
  else test('P5 post-commit', { skip: `${why} — reported, not silent; CI fails on it` }, () => {})
} else {
  const rP5 = scn(async () => invokeHook(p5.repo, postCommit, null, { pathOverride: p5.binDir, env: retroOff }))
  T('P5 no node on PATH is a reported SKIP line, exit 0, and the retro does not run', async () => {
    const x = await rP5()
    assert.ok(x.code === 0 && M(x.out, r`\[slice-retro\] SKIP — no node on PATH`) && !M(x.out, r`\[stub-retro\]`), ec(x))
  })
}

// P1: the retro runs with --repo <toplevel> and its output reaches the author verbatim.
const p1repo = scn(async () => newRetroRepo('pcm-runs', "console.log('[stub-retro] ran ' + process.argv.slice(2).join(' '))\n"))
const rP1 = scn(async () => invokeHook(await p1repo(), postCommit, null, { env: retroOff }))
T('P1 the retro runs with --repo <toplevel> and its output passes through, exit 0', async () => {
  const x = await rP1()
  assert.ok(x.code === 0 && M(x.out, r`\[stub-retro\] ran --repo \S`), ec(x))
})

// P2: a crashing retro never reads as a failed commit — exit 0, and the crash is still shown.
const rP2 = scn(async () => {
  const p2 = newRetroRepo('pcm-crash', "console.log('[stub-retro] crashing')\nprocess.exitCode = 3\n")
  return invokeHook(p2, postCommit, null, { env: retroOff })
})
T('P2 a retro exiting 3 leaves the hook at exit 0 with the retro output shown', async () => {
  const x = await rP2()
  assert.ok(x.code === 0 && M(x.out, r`\[stub-retro\] crashing`), ec(x))
})

// P3: SLICE_RETRO=0 skips this commit's retro. P1 (same stub shape, variable unset) is the control.
const rP3 = scn(async () => invokeHook(await p1repo(), postCommit, null, { env: { SLICE_RETRO: '0' } }))
T('P3 SLICE_RETRO=0 exits 0 without running the retro', async () => {
  const x = await rP3()
  assert.ok(x.code === 0 && !M(x.out, r`\[stub-retro\]`), ec(x))
})
