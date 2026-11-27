// Self-test for session-start-slice-notes.mjs (ADR 0172; spec 0006 §3.2).
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout hooks/session-start-slice-notes.selftest.mjs
//
// Fixture provenance: the payload is the SessionStart contract of the official hooks reference (cwd +
// source; `additionalContext` joins the model's context, `systemMessage` is shown to the member; each such
// string is capped at 10,000 characters). The hook is registered with the matcher `compact`, so these
// cases pass `source = compact`.
//
// The cases build REAL throwaway repos under the temp root and write notes with the REAL slice_note.mjs:
// the hook's verdict is read from `git rev-parse` and from `slice_note.mjs show`, and a faked journal would
// test the fake. The one exception is the worst-case size case, which writes journal lines directly so it
// does not pay 24 `node` starts; it then checks that `show` accepted every one of them.
//
// "Reader not started" is PROVEN, not assumed: a `node -r` preload wraps child_process.spawnSync and logs
// every spawn of slice_note.mjs to a file before forwarding it. The no-journal cases assert the log stays absent; the
// journal cases assert it exists, so a spy that never fires cannot make the first assertion vacuous. The same
// preload fakes a non-zero exit, a timeout and a spawn error, which no real reader produces on demand.
// Every match-based case carries MustNotMatch as well as MustMatch (the empty-MustNotMatch class).
//
// Patterns are regex sources matched case-insensitively (see toRx in lib/selftest-lib.mjs). Git runs
// through scripts/harness_git.mjs, the one git boundary (spec 0007 §4).
//
// Special characters in values and patterns are built from code points: the cases use U+2028 and U+FEFF,
// and escape text for a separator character can materialize as the literal character through an editor.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, matchFailures, runNode } from '../lib/selftest-lib.mjs'
import { git_result, git_run, which_on_path } from '../scripts/harness_git.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hook = path.join(here, 'session-start-slice-notes.mjs')
const noteScript = path.join(path.dirname(here), 'scripts/slice_note.mjs')
const ch = (...c) => String.fromCharCode(...c)
const rxEscape = s => s.replace(/[\\*+?|{[()^$.#]/g, '\\$&')
// The native real path: the hook passes git's top level, which never holds an 8.3 short name (`RUNNER~1`), while
// the fixture root under a short TEMP does.
const realOrSelf = p => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
const fullPath = p => (process.platform === 'win32' ? realOrSelf(p).toLowerCase() : realOrSelf(p))

// Resolved BEFORE any case changes the PATH of a child: a child with another PATH cannot find git.
const gitExe = which_on_path('git')
const gitOk = Boolean(gitExe)
const onCi = Boolean(process.env.CI)
const gitSkip = gitOk ? false : `git on PATH: ${gitOk}; the repo-dependent cases were not run (reported, not silent)`
if (!gitOk && onCi) test('SN0 tools: git on PATH', () => assert.fail(`git on PATH: ${gitOk} — a missing tool on CI is not a pass`))

const fx = fixtureRoot('ssslicenotes-selftest')
after(() => removeFixtureRoot(fx))

// --- the spy preload -------------------------------------------------------------------------
// Wraps child_process.spawnSync before the hook imports it. Every spawn of slice_note.mjs is logged as one JSON line
// (command, args, the options the contract pins) and, in a fault mode, answered with a canned result instead
// of the real process. Anything else — the hook's git calls — goes to the real spawnSync.
const spy = path.join(fx, 'spy.cjs')
fs.writeFileSync(spy, String.raw`const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const real = cp.spawnSync
function canned(extra) {
  return Object.assign({ status: null, signal: null, pid: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: [null, Buffer.alloc(0), Buffer.alloc(0)] }, extra)
}
cp.spawnSync = function (cmd, args, opts) {
  const base = path.basename(String(cmd)).toLowerCase()
  if (/^node(\.exe)?$/.test(base) && path.basename(String((args || [])[0])) === 'slice_note.mjs') {
    try {
      const o = opts || {}
      fs.appendFileSync(process.env.SLICE_SPY_LOG, JSON.stringify({ cmd: String(cmd), args, shell: o.shell || false, stdio: o.stdio, timeout: o.timeout, windowsHide: o.windowsHide }) + '\n')
    } catch { }
    const mode = process.env.SLICE_SPY_MODE
    if (mode === 'exit3') return canned({ status: 3 })
    if (mode === 'timeout') { const e = new Error('spawnSync node ETIMEDOUT'); e.code = 'ETIMEDOUT'; return canned({ signal: 'SIGTERM', error: e }) }
    if (mode === 'enoent') { const e = new Error('spawnSync node ENOENT'); e.code = 'ENOENT'; return canned({ error: e }) }
  }
  return real.apply(this, arguments)
}
`)
const spyArgs = ['-r', spy]
const spyLog = path.join(fx, 'reader-spawns.log')

// stdin is the text plus one newline. The result joins stdout and stderr, like `2>&1`.
// pathEnv, when given, replaces the PATH of the child only.
function invokeHook(stdin, { args = [], spyMode = '', pathEnv } = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!(pathEnv !== undefined && k.toUpperCase() === 'PATH')) env[k] = v
  if (pathEnv !== undefined) env.PATH = pathEnv
  env.SLICE_SPY_LOG = spyLog
  if (spyMode) env.SLICE_SPY_MODE = spyMode
  else delete env.SLICE_SPY_MODE
  const r = spawnSync(process.execPath, [...args, hook], { input: Buffer.from(stdin + '\n', 'utf8'), env, windowsHide: true })
  return { out: (r.stdout?.toString('utf8') ?? '') + (r.stderr?.toString('utf8') ?? ''), exit: r.status }
}

// Envelope adapter (file-specific): additionalContext and systemMessage are parsed apart, because the
// contract differs per path — a note path speaks only through additionalContext, a failure path only
// through systemMessage. Returns the failures and the context text.
function speaksFailures({ out, exit }, wantSys, wantCtx, mustMatch, mustNotMatch, noNegative = '') {
  const pre = []
  if (exit !== 0) pre.push(`exit ${exit} (want 0 — fail-open contract; SessionStart blocks nothing)`)
  let sys = '', ctx = '', evName = ''
  try {
    const j = JSON.parse(out.trim())
    sys = typeof j.systemMessage === 'string' ? j.systemMessage : ''
    const h = j.hookSpecificOutput
    if (h && typeof h === 'object') {
      ctx = typeof h.additionalContext === 'string' ? h.additionalContext : ''
      evName = typeof h.hookEventName === 'string' ? h.hookEventName : ''
    }
  } catch { pre.push('stdout is not valid JSON') }
  if (wantSys && !sys) pre.push('no systemMessage')
  if (!wantSys && sys) pre.push(`unexpected systemMessage: ${sys}`)
  if (wantCtx && !ctx) pre.push('no additionalContext')
  if (!wantCtx && ctx) pre.push('unexpected additionalContext')
  if (ctx && evName.toLowerCase() !== 'sessionstart') pre.push(`hookSpecificOutput.hookEventName is '${evName}' (want SessionStart — the runtime drops the context otherwise)`)
  const fails = matchFailures(`${sys}\n${ctx}`, { mustMatch, mustNotMatch, noNegative, preFail: pre, label: 'output' })
  return { fails, ctx }
}
let lastCtx = ''
function assertSpeaks(r, wantSys, wantCtx, mustMatch, mustNotMatch) {
  const { fails, ctx } = speaksFailures(r, wantSys, wantCtx, mustMatch, mustNotMatch)
  lastCtx = ctx
  assert.deepEqual(fails, [], `${fails.join(' · ')}\n--- output ---\n${r.out}`)
}
// Plain stdout on exit 0 becomes session context for this event, so "silent" must mean BYTE-silent.
function assertEmptyStdout({ out, exit }) {
  const fails = []
  if (exit !== 0) fails.push(`exit ${exit} (want 0 — fail-open contract)`)
  if (out.trim()) fails.push(`expected empty stdout, got: ${out.trim()}`)
  assert.deepEqual(fails, [], fails.join(' · '))
}
const newPayload = (fields = {}) => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'selftest', source: 'compact', ...fields })
const getSpyLines = () => (fs.existsSync(spyLog) ? fs.readFileSync(spyLog, 'utf8').split(/\r?\n/).filter(l => l.trim()) : [])
const resetSpy = () => { if (fs.existsSync(spyLog)) fs.rmSync(spyLog, { force: true }) }
function invokeGit(repo, gitArgs) {
  const r = git_result(fx, ['-C', repo, '-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', '-c', 'commit.gpgsign=false', ...gitArgs])
  if (r.status !== 0) throw new Error(`git ${gitArgs.join(' ')} failed in ${repo} (exit ${r.status})`)
}
function newRepo(p) {
  git_result(fx, ['-c', 'init.defaultBranch=main', 'init', '-q', p])
  invokeGit(p, ['commit', '--allow-empty', '-q', '-m', 'one'])
}
function addNote(repo, kind, text) {
  const r = runNode([noteScript, '--repo', repo, 'add', kind, text])
  if (r.status !== 0) throw new Error(`slice_note.mjs add failed: ${r.stdout}${r.stderr}`)
}

// --- fixtures that need no repo ----------------------------------------------------------------
const plain = path.join(fx, 'plain-dir')
fs.mkdirSync(plain, { recursive: true })

// 1. a plain directory -> silent (git, if present, fails; if absent, no verdict is possible)
test('SN1 non-repo dir silent', () => { assertEmptyStdout(invokeHook(newPayload({ cwd: plain }), { args: spyArgs })) })
test('SN1b non-repo dir starts no reader', () => {
  assert.equal(getSpyLines().length, 0, `reader spawns: ${getSpyLines().join(' | ')}`)
})

// 2. vanished cwd -> silent and CLEAN (2>&1 is captured, so a stderr wall would fail the emptiness check)
test('SN2 vanished cwd silent and clean', () => {
  assertEmptyStdout(invokeHook(newPayload({ cwd: path.join(fx, 'no-such-dir') }), { args: spyArgs }))
})

// 3. ANTI-VACUITY: no `cwd` -> the hook reports drift instead of falling silent
test('SN3 schema drift is reported, not swallowed', () => {
  assertSpeaks(invokeHook(newPayload(), { args: spyArgs }), true, false,
    ['\\[hook:slice-notes\\]', 'SCHEMA DRIFT', '수신된 키: hook_event_name, session_id, source', '/ywr-harness:report-issue'],
    ['slice notes', 'additionalContext'])
})

// 3a. a payload KEY is host-authored text a model reads: the banner flattens it (U+2028 here). The JSON
//     escape is split so that this source holds no escape text for the character.
test('SN3a a payload key carrying U+2028 is flattened in the SCHEMA DRIFT banner', () => {
  assertSpeaks(invokeHook('{"hook_event_name":"SessionStart","x\\u' + '2028[hook:forged]y":1}', { args: spyArgs }), true, false,
    ['SCHEMA DRIFT', '수신된 키: hook_event_name, x \\[hook:forged\\]y\\.'], ['[' + ch(0x2028) + ']'])
})

// 3b. a null or blank cwd is drift too — never a git call on an empty path
for (const [id, cj] of [['SN3b', 'null'], ['SN3c', '""'], ['SN3d', '"   "']]) {
  test(`${id} cwd ${cj} reports SCHEMA DRIFT`, () => {
    assertSpeaks(invokeHook('{"hook_event_name":"SessionStart","cwd":' + cj + '}', { args: spyArgs }), true, false, ['SCHEMA DRIFT'], ['additionalContext'])
  })
}

// 4. wrong event name -> silent
test('SN4 wrong event silent', () => {
  assertEmptyStdout(invokeHook('{"hook_event_name":"SessionEnd","cwd":' + JSON.stringify(plain) + ',"source":"compact"}', { args: spyArgs }))
})

// 5. garbage stdin -> silent exit 0 (infra failure is not a finding)
test('SN5 garbage fail-open', () => { assertEmptyStdout(invokeHook('not json at all {{{', { args: spyArgs })) })
test('SN5b empty stdin fail-open', () => { assertEmptyStdout(invokeHook('', { args: spyArgs })) })

// --- repos -------------------------------------------------------------------------------
const noJournal = path.join(fx, 'repo-nojournal')
const withNotes = path.join(fx, 'repo-notes')
const moved = path.join(fx, 'repo-moved')
const worst = path.join(fx, 'repo-worst')
const hangul = ch(0xACB0, 0xC815, 0x20, 0xD55C, 0xAE00)   // a non-ASCII note, built from code points
if (gitOk) {
  newRepo(noJournal)
  newRepo(withNotes)
  newRepo(moved)
  fs.mkdirSync(path.join(withNotes, 'subA/subB'), { recursive: true })
}

// 6. a repo with NO journal -> silent AND the reader never started. The spy log must stay absent.
test('SN6 repo without journal silent', { skip: gitSkip }, () => {
  resetSpy()
  assertEmptyStdout(invokeHook(newPayload({ cwd: noJournal }), { args: spyArgs }))
})
test('SN6b repo without journal starts no reader', { skip: gitSkip }, () => {
  assert.equal(getSpyLines().length, 0, `reader spawns: ${getSpyLines().join(' | ')}`)
})

// 7. a journal with notes at HEAD -> additionalContext carries the framing and the notes; no systemMessage.
test('SN7 journal with notes at HEAD re-injects them', { skip: gitSkip }, () => {
  addNote(withNotes, 'decision', 'chose option D over C because the snapshot must not move')
  addNote(withNotes, 'rejected', `dropped the tracked file (${hangul})`)
  resetSpy()
  assertSpeaks(invokeHook(newPayload({ cwd: withNotes }), { args: spyArgs }), false, true,
    ["(?m)^These are this session's own slice notes", 'before the context compaction', 'input never proof',
      'check each one against the tree', 'ADR 0172', 'slice notes: 2 at HEAD',
      String.raw`1\. \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ decision: chose option D over C because the snapshot must not move`,
      String.raw`2\. \S+ rejected: dropped the tracked file \(` + rxEscape(hangul) + String.raw`\)`],
    ['slice notes: none', 'SCHEMA DRIFT', 'FAILED', 'hook:slice-notes', ch(13)])
})
test('SN7b the framing is the FIRST line of the context, the show output follows', { skip: gitSkip }, () => {
  const ok = lastCtx.startsWith('These are this session') && (lastCtx.split('\n')[1] ?? '').startsWith('slice notes: 2 at HEAD')
  assert.ok(ok, `context starts: ${lastCtx.slice(0, 120)}`)
})
test('SN7c the note path really ran the reader (the no-journal assertions above are not vacuous)', { skip: gitSkip }, () => {
  assert.equal(getSpyLines().length, 1, `reader spawns: ${getSpyLines().length}`)
})
test('SN7d the reader is spawned by absolute path, no shell, stdin ignored, windowsHide, 10 s timeout', { skip: gitSkip }, () => {
  const rows = getSpyLines().map(l => JSON.parse(l))
  assert.equal(rows.length, 1, `reader spawns: ${rows.length}`)
  const p = rows[0]
  const ok = path.isAbsolute(p.cmd) && !p.shell && p.stdio[0] === 'ignore' && p.stdio[1] === 'pipe' && p.windowsHide === true && p.timeout === 10000
  assert.ok(ok, `cmd=${p.cmd} shell=${p.shell} stdio=${(p.stdio ?? []).join(',')} windowsHide=${p.windowsHide} timeout=${p.timeout}`)
})
test('SN7e argv is <plugin>/scripts/slice_note.mjs --repo <top> show --max 17', { skip: gitSkip }, () => {
  const rows = getSpyLines().map(l => JSON.parse(l))
  assert.equal(rows.length, 1, `reader spawns: ${rows.length}`)
  const a = rows[0].args.map(String)
  const trim = p => fullPath(p).replace(/[\\/]+$/, '')
  const ok = a.length === 6 && fullPath(a[0]) === fullPath(noteScript) && a[1] === '--repo' &&
    trim(a[2]) === trim(withNotes) && a.slice(3, 6).join(' ') === 'show --max 17'
  assert.ok(ok, `argv: ${a.join(' | ')}`)
})

// 8. a subdirectory cwd resolves the work tree root (the journal sits under the repo, not under the subdir)
test('SN8 subdirectory cwd resolves the root and finds the journal', { skip: gitSkip }, () => {
  assertSpeaks(invokeHook(newPayload({ cwd: path.join(withNotes, 'subA/subB') }), { args: spyArgs }), false, true,
    ['slice notes: 2 at HEAD', 'chose option D'], ['SCHEMA DRIFT', 'FAILED'])
})

// 9. case-drifted keys and a padded cwd still read (ADR 0116)
test('SN9 case-drifted keys and a padded cwd still read', { skip: gitSkip }, () => {
  assertSpeaks(invokeHook(JSON.stringify({ Hook_Event_Name: 'sessionstart', CWD: `  ${withNotes} \t ` }), { args: spyArgs }), false, true,
    ['slice notes: 2 at HEAD'], ['SCHEMA DRIFT'])
})

// 10. BOM-prefixed stdin -> still parses
test('SN10 BOM-prefixed stdin', { skip: gitSkip }, () => {
  assertSpeaks(invokeHook(ch(0xFEFF) + newPayload({ cwd: withNotes }), { args: spyArgs }), false, true, ['slice notes: 2 at HEAD'], ['SCHEMA DRIFT'])
})

// 11. notes written at ANOTHER head -> `show` prints `slice notes: none`; the hook stays silent. The reader DID run.
test('SN11 notes all at another HEAD are silent', { skip: gitSkip }, () => {
  addNote(moved, 'decision', 'a note from the slice before the close')
  invokeGit(moved, ['commit', '--allow-empty', '-q', '-m', 'two'])
  resetSpy()
  assertEmptyStdout(invokeHook(newPayload({ cwd: moved }), { args: spyArgs }))
})
test('SN11b the other-HEAD case ran the reader (silence came from show, not from a skipped spawn)', { skip: gitSkip }, () => {
  assert.equal(getSpyLines().length, 1, `reader spawns: ${getSpyLines().length}`)
})

// 12. WORST CASE vs the 10,000-character cap on one hook string (hooks reference). 24 notes at HEAD, each of the
//     longest kind and 500 characters (the maximum), plus two at another HEAD so every trailer line prints. The hook
//     asks for the newest 17: the context must hold exactly 17 numbered lines, name the 7 left out, and stay under the cap.
test('SN12 worst case: 24 maximum-length notes are capped to the newest 17', { skip: gitSkip }, () => {
  newRepo(worst)
  const head = git_run(worst, ['rev-parse', 'HEAD']).trim()
  const jp = path.join(worst, '.git/ywr-harness/slice-notes.jsonl')
  fs.mkdirSync(path.dirname(jp), { recursive: true })
  const lines = []
  for (let i = 1; i <= 24; i++) lines.push(JSON.stringify({ ts: '2026-10-26T12:00:00Z', head, kind: 'rejected', text: 'w'.repeat(499) + String(i % 10) }))
  for (let i = 1; i <= 2; i++) lines.push(JSON.stringify({ ts: '2026-10-26T12:00:00Z', head: '0'.repeat(40), kind: 'rejected', text: 'elsewhere' }))
  fs.writeFileSync(jp, lines.join('\n') + '\n')
  assertSpeaks(invokeHook(newPayload({ cwd: worst }), { args: spyArgs }), false, true,
    ['slice notes: 24 at HEAD', String.raw`slice notes: 7 older not shown \(--max 17\)`, 'slice notes: 2 more at other HEADs'],
    ['slice notes: none', 'FAILED', 'not a slice note', 'elsewhere'])
})
test('SN12b worst case: the context is under the 10,000-character cap with margin and holds 17 numbered notes', { skip: gitSkip }, () => {
  const ctxLen = lastCtx.length
  const numbered = (lastCtx.match(/^ {2}\d+\. /gm) ?? []).length
  assert.ok(ctxLen < 9900 && numbered === 17, `context length ${ctxLen} (want < 9900; the cap is 10000) · numbered lines ${numbered} (want 17)`)
})

// 13. fault modes the spy fakes — the real reader cannot be told to time out or fail on demand. Each speaks ONE
//     Korean systemMessage that names the failure and the `show` command, and never an additionalContext.
for (const [id, fault] of [
  ['SN13', { mode: 'exit3', want: ['exit 3 로 끝났습니다'] }],
  ['SN13b', { mode: 'timeout', want: ['10초 안에 끝나지 않았습니다'] }],
  ['SN13c', { mode: 'enoent', want: ['node 실행 오류 ENOENT'] }],
]) {
  test(`${id} fault ${fault.mode}: one Korean systemMessage, no context`, { skip: gitSkip }, () => {
    assertSpeaks(invokeHook(newPayload({ cwd: withNotes }), { args: spyArgs, spyMode: fault.mode }), true, false,
      ['\\[hook:slice-notes\\]', 'repo-notes', String.raw`node scripts/harness/slice_note\.mjs show`, 'ADR 0172', ...fault.want],
      ['SCHEMA DRIFT', 'These are this session', 'chose option D'])
  })
}

// 14. node ABSENT from PATH with a journal present -> the notes still come. The hook runs the reader with its own
//     `process.execPath`, so a PATH that holds git's directory only (git is needed to find the work tree) changes nothing.
test('SN14 node absent from PATH still re-injects the notes (no PATH lookup)', { skip: gitSkip }, () => {
  assertSpeaks(invokeHook(newPayload({ cwd: withNotes }), { pathEnv: path.dirname(gitExe) }), false, true,
    ['slice notes: 2 at HEAD', 'chose option D'], ['\\[hook:slice-notes\\]', 'SCHEMA DRIFT', 'FAILED'])
})
// the same PATH with NO journal stays silent
test('SN14b node absent from PATH and no journal stays silent', { skip: gitSkip }, () => {
  assertEmptyStdout(invokeHook(newPayload({ cwd: noJournal }), { pathEnv: path.dirname(gitExe) }))
})

// 15. NON-MUTATION: the hook only reads. The journal bytes and the work tree must be unchanged by every run above.
test('SN15 non-mutation: the work tree stays clean (the journal is under .git)', { skip: gitSkip }, () => {
  const status = git_run(withNotes, ['status', '--porcelain']).trim()
  assert.ok(!status, `git status: ${status}`)
})

// 16. the no-git branch: PATH empty for the CHILD only. A repo exists, git cannot run,
//     so the hook has no verdict and is silent. Runs on git-less machines too, where it is the ambient truth.
test('SN16 no git on PATH is silent', () => {
  assertEmptyStdout(invokeHook(newPayload({ cwd: plain }), { pathEnv: '' }))
})

// I1. every echo goes through hook-lib: the hook imports inline() and gitRun from it and carries no
//     copy of its own, and it never exits the process (hook-lib header: exiting before stdout drains truncates it).
const hookText = fs.readFileSync(hook, 'utf8')
test('I1 the hook imports its helpers from hook-lib.mjs and defines no copy of its own', () => {
  const importsLib = name => new RegExp(String.raw`^import\s*\{[^}]*\b${name}\b[^}]*\}\s*from\s*'\./hook-lib\.mjs'\s*$`, 'im').test(hookText)
  const ownCopy = /^\s*(export\s+)?(function\s+(inline|gitRun)\b|(const|let|var)\s+(inline|gitRun)\s*=)/im.test(hookText)
  const missing = ['inline', 'gitRun', 'emit', 'driftKeys'].filter(n => !importsLib(n))
  assert.ok(!missing.length && !ownCopy, `not imported: ${missing.join(', ')} · own copy present: ${ownCopy}`)
})
test('I2 the hook never exits the process explicitly', () => {
  assert.ok(!/process\.exit\s*\(/i.test(hookText), 'process.exit( found')
})
test('I3 the hook spawns the reader with process.execPath, without a shell and never by the bare name', () => {
  const ok = !/shell\s*:\s*true/i.test(hookText) && !/spawnSync\(\s*'(python|node)'/i.test(hookText) && /spawnSync\(process\.execPath,/i.test(hookText)
  assert.ok(ok, 'a shell option, a bare-name spawn, or no process.execPath spawn')
})

// R1. REGISTRATION. Every case above pipes a payload straight into the script, so none of them sees whether the
//     runtime ever calls it. This pins the wiring: SessionStart, a matcher of exactly `compact` (the matcher is
//     case-sensitive, and a wider one would spawn the reader on every session start — ADR 0172 option H), exec-form
//     `node <script>` (ADR 0116) and the 15 s timeout. That it FIRES is still only a live probe's to show.
test('R1 hooks.json registers this script once: SessionStart, matcher exactly compact, exec-form node <script>, timeout 15', () => {
  const regFails = []
  try {
    const hj = JSON.parse(fs.readFileSync(path.join(here, 'hooks.json'), 'utf8'))
    const sites = []
    for (const [ev, groups] of Object.entries(hj.hooks ?? {})) {
      for (const grp of [groups].flat().filter(Boolean)) {
        for (const h of [grp.hooks].flat().filter(Boolean)) {
          const parts = [String(h.command ?? ''), ...[h.args ?? []].flat().map(String)]
          if (/session-start-slice-notes\.mjs/i.test(parts.join(' '))) sites.push({ event: ev, matcher: String(grp.matcher ?? ''), group: grp, h })
        }
      }
    }
    const wantArgs = ['${CLAUDE_PLUGIN_ROOT}/hooks/session-start-slice-notes.mjs']
    if (sites.length !== 1) regFails.push(`want exactly 1 registration of session-start-slice-notes, found ${sites.length}`)
    else {
      const s = sites[0]
      const gotArgs = [s.h.args ?? []].flat().map(String)
      const groupHooks = [s.group.hooks].flat().filter(Boolean)
      if (s.event !== 'SessionStart') regFails.push(`event '${s.event}' (want SessionStart)`)
      if (s.matcher !== 'compact') regFails.push(`matcher '${s.matcher}' (want exactly 'compact' — the match is case-sensitive)`)
      if (groupHooks.length !== 1) regFails.push(`the compact group holds ${groupHooks.length} hooks (want only this one, so no other hook rides the matcher)`)
      if (String(s.h.type) !== 'command' || String(s.h.command) !== 'node') regFails.push(`handler type/command '${s.h.type}'/'${s.h.command}' (want command/node)`)
      if (gotArgs.join('\0') !== wantArgs.join('\0')) regFails.push(`args [${gotArgs.join(' ')}] (want exec form [${wantArgs.join(' ')}])`)
      else {
        const resolved = path.join(path.dirname(here), gotArgs.at(-1).replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, ''))
        if (path.resolve(resolved) !== path.resolve(hook)) regFails.push(`args resolve to '${resolved}', not this suite's script '${hook}'`)
      }
      if (String(s.h.timeout) !== '15') regFails.push(`timeout '${s.h.timeout}' (want 15)`)
    }
  } catch (e) { regFails.push(`hooks.json unreadable: ${e.message}`) }
  assert.deepEqual(regFails, [], regFails.join(' · '))
})

// META — proves this file's WIRING to the shared empty-MustNotMatch guard: a wrapper that dropped the
// mustNotMatch passthrough would leave the core intact and every case above unguarded.
const metaOut = { out: '{"systemMessage":"meta probe"}', exit: 0 }
test('SN17 META', () => {
  const { fails } = speaksFailures(metaOut, true, false, ['meta probe'], [])
  assert.ok(fails.length === 1 && /no mustNotMatch/i.test(fails[0]), `guard did not fire — reason='${fails.join('; ')}'`)
})
const metaExemption = 'META: exercises the visible-exemption path so the escape hatch cannot rot unnoticed'
test('SN18 META exemption honored', () => {
  const { fails } = speaksFailures(metaOut, true, false, ['meta probe'], [], metaExemption)
  assert.deepEqual(fails, [], 'noNegative exemption rejected')
})
test('SN19 META', () => {
  const { fails } = speaksFailures(metaOut, true, false, ['meta probe'], [], metaExemption)
  assert.ok(!fails.some(f => /no mustNotMatch/i.test(f)), 'noNegative exemption rejected')
})
