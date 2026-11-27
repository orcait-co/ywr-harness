// Self-test for session-start-githooks-nudge.mjs (ADR 0029; Node since ADR 0116).
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout hooks/session-start-githooks-nudge.selftest.mjs
//
// The payload shape is the SessionStart contract of the official hooks reference: cwd and source.
// The event supports a `source` matcher, which this hook registers without on purpose. The hook
// consumes additionalContext and systemMessage. An invented shape once kept a sibling hook green
// while it was inert. Every match-based case carries mustNotMatch as well as mustMatch, which
// matchFailures of lib/selftest-lib.mjs enforces.
//
// The git-dependent cases build real repos with `git init`, because the hook reads its verdict from
// `git rev-parse` and `git config --local`, and a faked .git directory would test the fake. Without
// git (the Linux container) those cases are a reported SKIP, never a silent pass. The no-git branch
// runs anyway, by clearing PATH for the child.
//
// Each test is `GN<n> <name>`, and the parity check of ADR 0227 decision 8 matches the names.
// Patterns follow toRx in lib/selftest-lib.mjs and match case-insensitively. Git runs through
// scripts/harness_git.mjs for the fixtures too.
//
// Every special character is built from a code point. The class under test is C0, DEL, NEL, LS and
// PS, and escape text for those can materialize as the literal character through an editor, so no
// such character, and no escape for one, appears in this source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, matchFailures } from '../lib/selftest-lib.mjs'
import { git_absent, git_result, git_run } from '../scripts/harness_git.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hook = path.join(here, 'session-start-githooks-nudge.mjs')
const ch = (...c) => String.fromCharCode(...c)
// The child keeps its own slashes, so a fixture path has the mixed shape that a Windows hook sees.
const J = (a, b) => a.replace(/[\\/]+$/u, '') + path.sep + b
const win = process.platform === 'win32'
const gitOk = !git_absent()

// The stdin is the text plus one newline. The result joins stdout and stderr.
function invokeHook(stdin, { nodeArgs = [], env } = {}) {
  const r = spawnSync(process.execPath, [...nodeArgs, hook], { input: Buffer.from(stdin + '\n', 'utf8'), env, windowsHide: true })
  return { out: (r.stdout?.toString('utf8') ?? '') + (r.stderr?.toString('utf8') ?? ''), exit: r.status }
}
// The child environment with PATH emptied. The node that runs the hook starts by its absolute path,
// so only the hook's own git lookup sees the empty PATH.
function envWithoutPath() {
  const e = {}
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'PATH') e[k] = v
  e.PATH = ''
  return e
}

// The nudge speaks through two fields, so the matched text joins systemMessage and additionalContext.
// A pattern that lives only in the context half, such as 'Do not run it unasked', still gets asserted.
// A present additionalContext needs hookEventName SessionStart, or the runtime drops it.
function nudgeFailures({ out, exit }, mustMatch, mustNotMatch, noNegative = '') {
  const pre = []
  if (exit !== 0) pre.push(`exit ${exit} (want 0 — fail-open contract; SessionStart blocks nothing)`)
  let sys = ''; let ctx = ''; let evName = ''
  try {
    const j = JSON.parse(out.trim())
    sys = String(j.systemMessage ?? '')
    ctx = String(j.hookSpecificOutput?.additionalContext ?? '')
    evName = String(j.hookSpecificOutput?.hookEventName ?? '')
  } catch { pre.push('stdout is not valid JSON') }
  if (!sys) pre.push('no systemMessage')
  if (ctx && evName !== 'SessionStart') pre.push(`hookSpecificOutput.hookEventName is '${evName}' (want SessionStart — the runtime drops the context otherwise)`)
  return matchFailures(`${sys}\n${ctx}`, { mustMatch, mustNotMatch, noNegative, preFail: pre, label: 'output' })
}
function assertNudge(r, mustMatch, mustNotMatch) {
  const f = nudgeFailures(r, mustMatch, mustNotMatch)
  assert.deepEqual(f, [], `${f.join(' · ')}\n--- output ---\n${r.out}`)
}
function assertEmptyStdout({ out, exit }) {
  const f = []
  if (exit !== 0) f.push(`exit ${exit} (want 0 — fail-open contract)`)
  // Plain stdout on exit 0 becomes session context for this event, so silent means byte-silent.
  // A stray warning line would enter every session's context.
  if (out.trim()) f.push(`expected empty stdout, got: ${out.trim()}`)
  assert.deepEqual(f, [], f.join(' · '))
}
// The characters that inline() flattens, built from code points: C0 except the tab, DEL, NEL, LS and PS.
const separatorClass = '[' + ch(0) + '-' + ch(9) + ch(0x0b) + '-' + ch(0x1f) + ch(0x7f, 0x85, 0x2028, 0x2029) + ']'
const payload = (fields) => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'selftest', source: 'startup', ...fields })

const fx = fixtureRoot('ssghn-selftest')
process.on('exit', () => removeFixtureRoot(fx))
const mk = (p) => { fs.mkdirSync(p, { recursive: true }); return p }
const gitInit = (p) => git_result(fx, ['-c', 'init.defaultBranch=main', 'init', '-q', p])
// The git-dependent cases are a reported SKIP without git, never a silent pass.
const gtest = gitOk ? test : (name, fn) => test(name, { skip: 'git not on PATH — git-dependent case not run (reported, not silent)' }, fn)

// --- fixtures --------------------------------------------------------------------------------
const plain = mk(path.join(fx, 'plain-dir'))                  // no repo, no .githooks
const unknownDir = path.join(fx, 'unknown-dir')               // no repo, WITH .githooks (no-git branch)
mk(path.join(unknownDir, '.githooks'))

// A `node -r` preload wraps spawnSync and logs each git call, so a case observes that no git ran.
const spyLog = path.join(fx, 'git-spy.log')
const spyPre = path.join(fx, 'git-spy.cjs')
fs.writeFileSync(spyPre, `const cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path')
const real = cp.spawnSync
cp.spawnSync = function (cmd) {
  const base = path.basename(String(cmd)).toLowerCase()
  if (base === 'git' || base === 'git.exe') fs.appendFileSync(process.env.YWR_SPY_LOG, 'git\\n')
  return real.apply(this, arguments)
}
`)
function invokeSpied(cwd) {
  fs.rmSync(spyLog, { force: true })
  const r = invokeHook(payload({ cwd }), { nodeArgs: ['-r', spyPre], env: { ...process.env, YWR_SPY_LOG: spyLog } })
  const gitCalls = fs.existsSync(spyLog) ? fs.readFileSync(spyLog, 'utf8').split('\n').filter(Boolean).length : 0
  return { ...r, gitCalls }
}
const lazy = (fn) => { let v; return () => (v ??= fn()) }

let unwired, wired, foreign, bare
if (gitOk) {
  unwired = path.join(fx, 'repo-unwired')
  wired = path.join(fx, 'repo-wired')
  foreign = path.join(fx, 'repo-foreign')
  bare = path.join(fx, 'repo-nogithooks')
  for (const r of [unwired, wired, foreign, bare]) gitInit(r)
  for (const r of [unwired, wired, foreign]) mk(path.join(r, '.githooks'))
  git_run(wired, ['config', 'core.hooksPath', '.githooks'])
  git_run(foreign, ['config', 'core.hooksPath', '.husky'])
  mk(J(unwired, 'subA/subB'))
}
const bareRun = lazy(() => invokeSpied(bare))

// The one speaking state: .githooks/ present and core.hooksPath unset. Both channels carry the
// fact, the exact command and the suggest-only contract.
gtest('GN1 unwired clone nudges', () => {
  assertNudge(invokeHook(payload({ cwd: unwired })),
    [String.raw`\[hook:githooks-nudge\]`, 'repo-unwired', 'core\\.hooksPath가 UNSET',
      String.raw`git config core\.hooksPath \.githooks`, '/ywr-harness:harness-init',
      'feedback latency', 'Do not run it unasked', '제안만 합니다'],
    ['SCHEMA DRIFT', 'UNKNOWN'])
})

// A wired clone is byte-silent, because the permanent steady state costs nothing.
gtest('GN2 wired clone silent', () => { assertEmptyStdout(invokeHook(payload({ cwd: wired }))) })

// A foreign value is silent by design (ADR 0029 decision table). That state is a decision, the
// emitter's hooks: line still reports it, and a nudge would nag forever.
gtest('GN3 foreign hooksPath silent', () => { assertEmptyStdout(invokeHook(payload({ cwd: foreign }))) })

// A repo with no .githooks/ has nothing to wire and stays silent.
gtest('GN4 repo without .githooks silent', () => { assertEmptyStdout(bareRun()) })
gtest('GN5 repo without .githooks spawns no git', () => {
  const r = bareRun()
  assert.ok(r.gitCalls === 0, `${r.gitCalls} git call(s)`)
})

// A subdirectory cwd resolves and names the root, so the subdirectory is never taken for the repo.
// That is what rev-parse buys over a path join on cwd.
gtest('GN6 subdirectory cwd resolves the root', () => {
  assertNudge(invokeHook(payload({ cwd: J(unwired, 'subA/subB') })),
    ['repo-unwired', 'core\\.hooksPath가 UNSET'], ['subA', 'SCHEMA DRIFT'])
})

// BOM-prefixed stdin still parses.
gtest('GN7 BOM-prefixed stdin', () => {
  assertNudge(invokeHook(ch(0xfeff) + payload({ cwd: unwired })), ['repo-unwired'], ['SCHEMA DRIFT'])
})

// Key lookup and the event compare are case-insensitive (ADR 0116), and the cwd is cast to a string
// and trimmed. A case-sensitive lookup would see no `cwd` and report SCHEMA DRIFT, and a missing
// trim would hand git a bad path.
gtest('GN8 case-drifted keys and event name still read', () => {
  assertNudge(invokeHook(JSON.stringify({ Hook_Event_Name: 'sessionstart', CWD: unwired })),
    ['repo-unwired', 'core\\.hooksPath가 UNSET'], ['SCHEMA DRIFT'])
})
gtest('GN9 cwd padded with whitespace is trimmed', () => {
  assertNudge(invokeHook(payload({ cwd: `  ${unwired} \t ` })), ['repo-unwired', 'core\\.hooksPath가 UNSET'], ['SCHEMA DRIFT'])
})

// A non-ASCII work tree path: the git boundary decodes UTF-8 once with quotepath off (spec 0007 §4),
// so the hook names the real directory name, neither quoted-octal nor mojibake.
gtest('GN10 non-ASCII work tree path is named intact', () => {
  const uni = path.join(fx, 'repo-유니코드 é')
  gitInit(uni)
  mk(path.join(uni, '.githooks'))
  assertNudge(invokeHook(payload({ cwd: uni })),
    ['repo-유니코드 é', 'core\\.hooksPath가 UNSET'], ['SCHEMA DRIFT', String.raw`\\[0-7]{3}`, ch(0xfffd)])
})

// A directory name is attacker-authorable text from a cloned repo, and a model reads this output.
// The banner echoes the root through inline(), so no control or Unicode line separator survives.
// U+2028 and U+0085 are legal in a Windows file name, and a C0 control is added where the OS allows one.
test('GN11 6a3 a path carrying U+2028, U+0085 (and a C0 off Windows) is echoed flattened', (t) => {
  const hostile = path.join(fx, 'repo-hostile' + ch(0x2028) + 'dir' + ch(0x85) + 'x' + (win ? '' : ch(7)))
  let made = false
  try { mk(path.join(hostile, '.githooks')); gitInit(hostile); made = gitOk } catch { /* not creatable here */ }
  if (!made) return t.skip('the hostile-named work tree could not be created here — not run (reported, not silent)')
  assertNudge(invokeHook(payload({ cwd: hostile })),
    ['repo-hostile dir x', 'core\\.hooksPath가 UNSET'],
    ['SCHEMA DRIFT', separatorClass])
})

// A config read that fails for a reason other than unset reports UNKNOWN, never a nudge.
// Real git cannot produce this state once rev-parse has succeeded: a corrupt .git/config kills
// rev-parse first, and a multi-valued key returns exit 0 with the last value. The only
// deterministic reproduction is a stand-in that fails exactly the config call and forwards every
// other call to the real binary. The case tests the hook's exit-code branch, not git.
// A Node hook launches `git` by exec, which runs real executables only and never a .cmd or .ps1
// shim on PATH, so the stand-in is a `node -r` preload that wraps child_process.spawnSync. A
// `git ... config ...` call answers exit 3 with no output.
gtest('GN12 unreadable config reports UNKNOWN, not a nudge', () => {
  const failConfig = path.join(fx, 'git-fail-config.cjs')
  fs.writeFileSync(failConfig, `const cp = require('node:child_process')
const real = cp.spawnSync
cp.spawnSync = function (cmd, args) {
  // the hook spawns git by its PATH-resolved absolute path (hook-lib gitRun), so match the file name
  const base = require('node:path').basename(String(cmd)).toLowerCase()
  if ((base === 'git' || base === 'git.exe') && Array.isArray(args) && args.includes('config')) {
    return { status: 3, signal: null, pid: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: [null, Buffer.alloc(0), Buffer.alloc(0)] }
  }
  return real.apply(this, arguments)
}
`)
  // 'repo-unwired' proves that rev-parse still reached the real git.
  assertNudge(invokeHook(payload({ cwd: unwired }), { nodeArgs: ['-r', failConfig] }),
    ['repo-unwired', '정상적으로 읽을 수 없습니다', 'git config exit 3', 'UNKNOWN, 확인되지 않았습니다'],
    ['UNSET', '제안만 합니다', 'SCHEMA DRIFT'])
})

// Non-mutation: after every invocation above, each clone's core.hooksPath reads exactly what the
// fixture set. This makes the suggest-only contract (ADR 0029) provable. A hook that wires a clone
// turns a case red here instead of passing every text assertion.
const hooksPathLines = (repo) => git_result(repo, ['config', '--local', '--get', 'core.hooksPath']).stdout.split('\n').filter((l) => l.trim())
gtest('GN13 non-mutation: unwired clone is still unwired', () => {
  const post = hooksPathLines(unwired)
  assert.ok(post.length === 0, `core.hooksPath now reads [${post.join(' ')}] — the hook wrote to the clone`)
})
gtest('GN14 non-mutation: wired value untouched', () => {
  const post = hooksPathLines(wired)
  assert.ok(String(post[0]).trim() === '.githooks', `core.hooksPath now reads [${post.join(' ')}]`)
})
gtest('GN15 non-mutation: foreign value untouched', () => {
  const post = hooksPathLines(foreign)
  assert.ok(String(post[0]).trim() === '.husky', `core.hooksPath now reads [${post.join(' ')}]`)
})

// Where the folders above cwd cannot prove silence, the git path still runs. GN5 and GN20 assert
// that a folder with no `.githooks/` on the way up spawns no git. A gitfile `.git` is not proof,
// because its git dir is elsewhere, and core.worktree makes git name a work tree outside the folders above cwd.
const gitfileRun = lazy(() => {
  const gitfile = mk(path.join(fx, 'repo-gitfile'))
  fs.writeFileSync(path.join(gitfile, '.git'), 'gitdir: ./nowhere')
  return invokeSpied(gitfile)
})
gtest('GN16 6d gitfile .git without .githooks: silent', () => { assertEmptyStdout(gitfileRun()) })
gtest('GN17 6d a gitfile .git is not proof: git is still asked', () => {
  assert.ok(gitfileRun().gitCalls >= 1, 'no git call')
})
gtest('GN18 6d core.worktree pointing at a repo with .githooks: git names that work tree and it nudges', () => {
  const redirect = path.join(fx, 'repo-redirect')
  gitInit(redirect)
  git_run(redirect, ['config', 'core.worktree', unwired])
  assertNudge(invokeSpied(redirect), ['repo-unwired', 'core\\.hooksPath가 UNSET'], ['repo-redirect', 'SCHEMA DRIFT'])
})

// A plain non-repo directory is silent on both branches (with git rev-parse fails, without git
// there is no .githooks at cwd), so these cases run unguarded.
const plainRun = lazy(() => invokeSpied(plain))
test('GN19 non-repo dir silent', () => { assertEmptyStdout(plainRun()) })
test('GN20 non-repo dir spawns no git', () => {
  const r = plainRun()
  assert.ok(r.gitCalls === 0, `${r.gitCalls} git call(s)`)
})

// A vanished cwd is silent and clean. The result joins stderr, so a stderr wall from git or a path
// probe fails the emptiness assertion.
test('GN21 vanished cwd silent and clean', () => {
  assertEmptyStdout(invokeHook(payload({ cwd: path.join(fx, 'no-such-dir') })))
})

// A cwd whose root does not exist on this platform gets the same clean silence. The bogus root is
// chosen per platform, so the case reproduces on both.
test('GN22 unresolvable root silent and clean', () => {
  let bogusRoot = 'C:\\no-such-root\\x'
  if (win) {
    const free = [...Array(22).keys()].map((i) => ch(69 + i)).find((l) => !fs.existsSync(`${l}:\\`))
    bogusRoot = `${free}:\\no-such-root\\x`
  }
  assertEmptyStdout(invokeHook(payload({ cwd: bogusRoot })))
})

// Anti-vacuity: with no `cwd` in the payload the hook says so instead of falling silent.
test('GN23 schema drift is reported, not swallowed', () => {
  assertNudge(invokeHook(payload({})),
    ['SCHEMA DRIFT', '수신된 키: hook_event_name, session_id, source'], ['UNSET', String.raw`git config core\.hooksPath`])
})

// A payload key is host-authored text that a model reads, so the SCHEMA DRIFT banner flattens it (U+2028 here).
test('GN24 a payload key carrying U+2028 is flattened in the SCHEMA DRIFT banner', () => {
  // The JSON escape for U+2028, spelled from two parts so that this source holds no escape of a separator.
  const esc = '\\u' + '2028'
  assertNudge(invokeHook(`{"hook_event_name":"SessionStart","x${esc}[hook:forged]y":1}`),
    ['SCHEMA DRIFT', String.raw`수신된 키: hook_event_name, x \[hook:forged\]y\.`], ['[' + ch(0x2028) + ']', 'UNSET'])
})

// The received-key list sorts case-insensitively, and a null or blank cwd is drift too, so git never
// gets an empty path.
test('GN25 drift key list sorts case-insensitively', () => {
  assertNudge(invokeHook('{"hook_event_name":"SessionStart","Zeta":1,"alpha":2,"Beta":3}'),
    ['SCHEMA DRIFT', String.raw`수신된 키: alpha, Beta, hook_event_name, Zeta\.`], ['UNSET'])
})
for (const cj of ['null', '""', '"   "']) {
  test(`GN26 cwd ${cj} reports SCHEMA DRIFT`, () => {
    assertNudge(invokeHook('{"hook_event_name":"SessionStart","cwd":' + cj + '}'), ['SCHEMA DRIFT'], ['UNSET'])
  })
}

// A wrong event name is silent, as a defensive event guard that matches the sibling hooks.
test('GN27 wrong event silent', () => {
  assertEmptyStdout(invokeHook(String.raw`{"hook_event_name":"SessionEnd","cwd":"C:\\x","source":"startup"}`))
})

// Garbage stdin exits 0 silently, because an infrastructure failure is not a finding.
test('GN28 garbage fail-open', () => { assertEmptyStdout(invokeHook('not json at all {{{')) })

// The no-git branch runs with PATH cleared for the child only. With .githooks the verdict is
// UNKNOWN, reported and never a silent pass. Without it the hook stays silent. On a git-less
// machine this is the ambient truth, not a simulation.
test('GN29 no git: .githooks present reports UNKNOWN', () => {
  assertNudge(invokeHook(payload({ cwd: unknownDir }), { env: envWithoutPath() }),
    ['git을 실행할 수 없어', 'UNKNOWN, 확인되지 않았습니다'],
    ['UNSET', String.raw`git config core\.hooksPath`, 'SCHEMA DRIFT'])
})
test('GN30 no git: no .githooks stays silent', () => {
  assertEmptyStdout(invokeHook(payload({ cwd: plain }), { env: envWithoutPath() }))
})

// R1 pins the registration. Every case above pipes a payload straight into the script, so none
// sees whether the runtime calls it. The wiring is SessionStart, no matcher on purpose, exec-form
// `node <script>` (ADR 0116) and the 15 s timeout. Only a live `--plugin-dir` probe shows that it fires.
test('R1 hooks.json registers this script once: SessionStart, no matcher, exec-form node <script>', () => {
  const fails = []
  try {
    const hj = JSON.parse(fs.readFileSync(path.join(here, 'hooks.json'), 'utf8'))
    const sites = []
    for (const [ev, groups] of Object.entries(hj.hooks ?? {})) {
      for (const grp of [groups].flat().filter(Boolean)) {
        for (const h of [grp.hooks].flat().filter(Boolean)) {
          const parts = [String(h.command ?? ''), ...[h.args ?? []].flat().map(String)]
          if (/session-start-githooks-nudge\.(ps1|mjs)/iu.test(parts.join(' '))) sites.push({ ev, matcher: String(grp.matcher ?? ''), h })
        }
      }
    }
    const wantArgs = ['${CLAUDE_PLUGIN_ROOT}/hooks/session-start-githooks-nudge.mjs']
    if (sites.length !== 1) fails.push(`want exactly 1 registration of session-start-githooks-nudge (.mjs or the retired .ps1), found ${sites.length}`)
    else {
      const s = sites[0]
      const gotArgs = [s.h.args ?? []].flat().map(String)
      if (s.ev !== 'SessionStart') fails.push(`event '${s.ev}' (want SessionStart)`)
      if (s.matcher) fails.push(`matcher '${s.matcher}' (want none — registered without one on purpose)`)
      if (String(s.h.type) !== 'command' || String(s.h.command) !== 'node') fails.push(`handler type/command '${s.h.type}'/'${s.h.command}' (want command/node)`)
      if (gotArgs.join('\0') !== wantArgs.join('\0')) fails.push(`args [${gotArgs.join(' ')}] (want exec form [${wantArgs.join(' ')}])`)
      else {
        const resolved = path.join(path.dirname(here), gotArgs.at(-1).replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//u, ''))
        if (path.resolve(resolved) !== path.resolve(hook)) fails.push(`args resolve to '${resolved}', not this suite's script '${hook}'`)
      }
      if (String(s.h.timeout) !== '15') fails.push(`timeout '${s.h.timeout}' (want 15)`)
    }
  } catch (e) { fails.push(`hooks.json unreadable: ${e.message}`) }
  assert.deepEqual(fails, [], fails.join(' · '))
})

// META proves this file's wiring to the shared empty-mustNotMatch guard. A wrapper that dropped
// the mustNotMatch passthrough would leave every case above unguarded.
const metaOut = { out: '{"systemMessage":"meta probe"}', exit: 0 }
test('GN31 META', () => {
  const f = nudgeFailures(metaOut, ['meta probe'], [])
  assert.ok(f.length === 1 && /no mustNotMatch/iu.test(f[0]), `guard did not fire — reason='${f.join('; ')}'`)
})
test('GN32 META exemption honored', () => {
  const f = nudgeFailures(metaOut, ['meta probe'], [], 'META: exercises the visible-exemption path so the escape hatch cannot rot unnoticed')
  assert.deepEqual(f, [], '-NoNegative exemption rejected')
})
