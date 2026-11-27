// Self-test for session-start-version-announce.mjs (ADR 0030, ADR 0116).
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout hooks/session-start-version-announce.selftest.mjs
//
// The hook's verdict comes from three files that it resolves itself: its own plugin.json and
// CHANGELOG.md beside its own directory, and the state file under the env-derived home. So the
// suite runs a copy of the hook, plus the hook-lib.mjs that it imports, inside fixture plugin trees
// with controlled versions and notes. USERPROFILE and HOME point at a fixture home, because the hook
// reads those variables directly. CLAUDE_CONFIG_DIR is cleared, because the host's own value would
// redirect the state (ADR 0136). Every match-based case carries mustNotMatch as well as mustMatch,
// which the shared assertion core enforces.
//
// The announce-once contract is asserted from both observables: the output, which speaks exactly
// when stored < current, and the state file, which is seeded or updated on every path the decision
// table says and is byte-equal to the version. Mutation confinement is asserted at the end: after
// the full run the fixture home holds exactly one file, the state file. That proves the bound on
// the user-scope write of ADR 0030.
//
// Each child gets its own environment object, so the suite process never changes.
// Each test is `VA<n> <name>`, and the parity check of ADR 0227 decision 8 matches the names.
// The META tests are `VA<n> META`, `VA<n> META exemption honored` and `VA<n> META`. Cases R1 and G1
// keep their IDs. Patterns follow toRx in lib/selftest-lib.mjs and match case-insensitively.
//
// Node opens every file with FileShare.Delete, so it cannot hold a file against a rename. The
// Windows rename cases start a Windows PowerShell child that holds the state file open, and the
// child releases it on the suite's signal.
//
// The seed fixture notes carry CRLF, so the CHANGELOG reader meets both line ends.
//
// The names of the config-dir == home cases carry the fixture path, which holds the process id,
// and the drive-less cases carry a random GUID.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fixtureRoot, removeFixtureRoot, matchFailures, runNode } from '../lib/selftest-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hookSrc = path.join(here, 'session-start-version-announce.mjs')
const hookLibSrc = path.join(here, 'hook-lib.mjs')
const gitLibSrc = path.join(here, '../scripts/harness_git.mjs')   // hook-lib imports it from <plugin>/scripts
const isWin = process.platform === 'win32'
const ch = (...c) => String.fromCharCode(...c)
const fullPath = p => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p))
const sleep = ms => new Promise(r => setTimeout(r, ms))

const fx = fixtureRoot('ssva-selftest')
after(() => removeFixtureRoot(fx))

// The first test with this name prefix is VA1, and the numbers follow the file order.
let caseNo = 0
const vt = (name, fn, opts = {}) => test(`VA${++caseNo} ${name}`, opts, fn)
const memo = fn => { let v; let done = false; return () => { if (!done) { v = fn(); done = true } return v } }

// --- child runs --------------------------------------------------------------------------------
// The host's USERPROFILE, HOME and CLAUDE_CONFIG_DIR never reach a child, and the names clear
// case-insensitively, as Windows reads them. home '' sets both home variables empty. cfg undefined
// or '' leaves CLAUDE_CONFIG_DIR unset.
function hookEnv({ home = fxHome, cfg, extra = {} } = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    const u = k.toUpperCase()
    if (u === 'USERPROFILE' || u === 'HOME' || u === 'CLAUDE_CONFIG_DIR') continue
    env[k] = v
  }
  // No home means two empty variables, never two missing ones. On Windows a child that lacks
  // USERPROFILE gets the host's value back, so a deleted variable would hand the hook the real home.
  env.USERPROFILE = home
  env.HOME = home
  if (cfg !== undefined && cfg !== '') env.CLAUDE_CONFIG_DIR = cfg
  return Object.assign(env, extra)
}
// The stdin is the text plus one newline. The result joins stdout and stderr.
function invokeHook(stdin, hookPath, { home, cfg, cwd } = {}) {
  const r = spawnSync(process.execPath, [hookPath], { input: Buffer.from(stdin + '\n', 'utf8'), env: hookEnv({ home, cfg }), cwd, windowsHide: true })
  return { out: (r.stdout?.toString('utf8') ?? '') + (r.stderr?.toString('utf8') ?? ''), exit: r.status }
}
const newPayload = (fields = {}) => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'selftest', source: 'startup', cwd: 'C:\\anywhere', ...fields })

// --- assertions --------------------------------------------------------------------------------
// The announcement speaks through systemMessage and additionalContext, so the matched text joins both.
// A present additionalContext needs hookEventName SessionStart, or the runtime drops it.
function announceFailures({ out, exit }, mustMatch, mustNotMatch, noNegative = '') {
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
  if (!sys) pre.push('no systemMessage')
  if (ctx && evName.toLowerCase() !== 'sessionstart') pre.push(`hookSpecificOutput.hookEventName is '${evName}' (want SessionStart — the runtime drops the context otherwise)`)
  return matchFailures(`${sys}\n${ctx}`, { mustMatch, mustNotMatch, noNegative, preFail: pre, label: 'output' })
}
function assertAnnounce(r, mustMatch, mustNotMatch) {
  const f = announceFailures(r, mustMatch, mustNotMatch)
  assert.deepEqual(f, [], `${f.join(' · ')}\n--- output ---\n${r.out}`)
}
// Plain stdout on exit 0 becomes session context for this event, so silent means byte-silent.
// A stray warning line would enter every session's context.
function assertEmptyStdout({ out, exit }) {
  const fails = []
  if (exit !== 0) fails.push(`exit ${exit} (want 0 — fail-open contract)`)
  if (out.trim()) fails.push(`expected empty stdout, got: ${out.trim()}`)
  assert.deepEqual(fails, [], fails.join(' · '))
}

// --- fixtures --------------------------------------------------------------------------------
// The versions are synthetic (2.4.0 and 2.5.0), so the suite needs no edit on a release. The 2.5.0
// entry carries four bullets, one wrapped across lines, so the visible cap (3 shown and "외 1건")
// and the joining of continuation lines are both observable.
const fxHome = path.join(fx, 'home')
fs.mkdirSync(fxHome, { recursive: true })
const stateFile = path.join(fxHome, '.claude/ywr-harness/announced-version')
const stateDirPath = path.dirname(stateFile)
const claudeDir = path.join(fxHome, '.claude')
const setState = v => { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, v) }
const getState = () => (fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8').trim() : null)
const clearLegacyState = () => fs.rmSync(stateFile, { force: true })
const stateAtFile = dir => path.join(dir, 'ywr-harness/announced-version')
const getStateAt = dir => (fs.existsSync(stateAtFile(dir)) ? fs.readFileSync(stateAtFile(dir), 'utf8').trim() : null)
const setStateAt = (dir, v) => { fs.mkdirSync(path.join(dir, 'ywr-harness'), { recursive: true }); fs.writeFileSync(stateAtFile(dir), v) }
const tmpFilesIn = dir => fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.tmp'))
const crlf = lines => lines.join('\r\n') + '\r\n'

function newFixturePlugin(name, manifestText, changelog) {
  const p = path.join(fx, name)
  fs.mkdirSync(path.join(p, '.claude-plugin'), { recursive: true })
  fs.mkdirSync(path.join(p, 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(p, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(p, '.claude-plugin/plugin.json'), manifestText + '\n')
  if (changelog !== null) fs.writeFileSync(path.join(p, 'CHANGELOG.md'), changelog)
  fs.copyFileSync(hookSrc, path.join(p, 'hooks/session-start-version-announce.mjs'))
  fs.copyFileSync(hookLibSrc, path.join(p, 'hooks/hook-lib.mjs'))
  fs.copyFileSync(gitLibSrc, path.join(p, 'scripts/harness_git.mjs'))
  return path.join(p, 'hooks/session-start-version-announce.mjs')
}

const notes = crlf([
  '# fixture 릴리스 노트',
  '',
  '## v2.5.0 — 2026-08-05',
  '',
  '- 첫 번째 변경: `백틱 조각`과 **강조 표시**가 섞여 있습니다.',
  '- 두 번째 변경이 여러 줄로',
  '  이어집니다.',
  '- 세 번째 변경.',
  '- 네 번째 변경은 목록에서 잘립니다.',
  '',
  '## v2.4.0 — 2026-08-01',
  '',
  '- 이전 버전 항목입니다.',
])
const hook = newFixturePlugin('plug', '{"name":"ywr-harness","version":"2.5.0"}', notes)
const hookNoNotes = newFixturePlugin('plug-nonotes', '{"name":"ywr-harness","version":"2.5.0"}', null)
const hookBroken = newFixturePlugin('plug-broken', 'not json {{{', notes)
// A hand-edited manifest with comments and a trailing comma still reads, so the announcement does
// not degrade to the "unreadable manifest" report (hook-lib parseJsonLoose, ADR 0116).
const hookLoose = newFixturePlugin('plug-loose', '{\n  // loaded version\n  "name": "ywr-harness", /* x */\n  "version": "2.5.0",\n}', notes)
// A non-hyphenated suffix passes the gate's front-anchored version-shape check. The section lookup
// is token equality against the raw manifest string, not a \b match, and this fixture pins it.
const notesRc = crlf([
  '# fixture 릴리스 노트',
  '',
  '## v2.5.0rc1 — 2026-08-05',
  '',
  '- 접미사 버전 항목이 조회됩니다.',
])
const hookRc = newFixturePlugin('plug-rc', '{"name":"ywr-harness","version":"2.5.0rc1"}', notesRc)
const hookOld = newFixturePlugin('plug-old', '{"name":"ywr-harness","version":"2.4.0"}', notes)

// A first run whose seed cannot record, because a file squats on the state directory path, is
// byte-silent. A welcome that cannot be recorded would repeat every session, the nag class of
// ADR 0029, and it protects no news (the write-then-speak order of ADR 0031).
vt('unseedable first run: silent', () => {
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(stateDirPath, 'squatter')
  try { assertEmptyStdout(invokeHook(newPayload(), hook)) } finally { fs.rmSync(stateDirPath, { force: true }) }
})

// With no state file (a fresh install or a first run of the feature) the hook gives the link-only
// welcome (ADR 0031). It is true in both indistinguishable states, so it has no version arrow, no
// "업데이트됨" and no bullets. The state seeds, so the machine hears it once.
vt('fresh: link-only welcome', () => {
  assertAnnounce(invokeHook(newPayload(), hook),
    ['\\[hook:version-announce\\]', 'v2\\.5\\.0 적용 중', '첫 버전 안내',
      'artifact/a4387fdf-63d1-4a3d-9c8e-c362c9215a54#rn', 'Team 좌석 로그인', 'once per machine'],
    ['업데이트됨', '→', '첫 번째 변경', '외 \\d+건', '주요 변경'])
})
vt('fresh: state seeded to current', () => { assert.equal(getState(), '2.5.0', `state reads [${getState()}] (want 2.5.0)`) })

// The first-run seed is an exclusive create, so two sessions that start together welcome once
// (spec 0006 §3.2). A timing race between two child processes could pass without the fix, so the
// real function is imported from the hook module (the `?lib` query makes it define its functions
// and run nothing) and run against a state file that already exists, the loser's position. It must
// refuse (false) and leave the winner's bytes alone. The same call against an absent path is the
// success path, which the fresh case covers through the hook, and this pins the bytes.
const seedDriver = path.join(fx, 'seed-driver.mjs')
fs.writeFileSync(seedDriver, [
  "import { pathToFileURL } from 'node:url'",
  "const m = await import(pathToFileURL(process.argv[2]).href + '?lib')",
  "if (typeof m.newStateExclusive !== 'function') { process.stdout.write('MISSING'); process.exit(0) }",
  "process.stdout.write(String(m.newStateExclusive(process.argv[3], process.argv[4], '9.9.9')))",
  '',
].join('\n'))
const runDriver = args => { const r = runNode(args); return `${r.stdout}${r.stderr}`.trim() }
const seedOnExisting = memo(() => runDriver([seedDriver, hook, stateDirPath, stateFile]))
vt('exclusive seed: newStateExclusive is exported by the hook module', () => {
  assert.notEqual(seedOnExisting(), 'MISSING', 'function not exported — the first-run seed is no longer an exclusive create')
})
vt('exclusive seed: an existing state file refuses the seed', () => {
  assert.equal(seedOnExisting(), 'false', `returned [${seedOnExisting()}] (want false — a concurrent first run must not seed twice)`)
})
vt("exclusive seed: the winner's state is untouched", () => { assert.equal(getState(), '2.5.0', `state reads [${getState()}] (want 2.5.0)`) })
vt('exclusive seed: an absent path is created (dir included) with exactly the version bytes', () => {
  const seedDir = path.join(fx, 'seed-fresh/nested')
  const seedFresh = runDriver([seedDriver, hook, seedDir, path.join(seedDir, 'announced-version')])
  const seedFile = path.join(seedDir, 'announced-version')
  const seedBytes = fs.existsSync(seedFile) ? [...fs.readFileSync(seedFile)] : []
  assert.ok(seedFresh === 'true' && seedBytes.join(',') === [...Buffer.from('9.9.9', 'utf8')].join(','), `returned [${seedFresh}], bytes [${seedBytes.join(',')}]`)
})

// A state equal to the current version is the permanent steady state and costs nothing.
vt('same version: silent', () => { assertEmptyStdout(invokeHook(newPayload(), hook)) })

// A state older than the current version gets the announcement: the version pair, the first three
// bullets, the visible "외 1건" cap, and the RN-tab link with its login qualifier. The wrapped bullet
// is joined whole. The markdown bullet is flattened, because systemMessage is plain text and `code`
// and **bold** markers must not reach the member. The state file moves to current, so a re-fire is silent.
vt('older state announces', () => {
  setState('2.4.0')
  assertAnnounce(invokeHook(newPayload(), hook),
    ['\\[hook:version-announce\\]', 'v2\\.4\\.0 → v2\\.5\\.0', '업데이트됨',
      '첫 번째 변경: 백틱 조각과 강조 표시가 섞여',
      '두 번째 변경이 여러 줄로 이어집니다', '세 번째 변경',
      '외 1건', 'artifact/a4387fdf-63d1-4a3d-9c8e-c362c9215a54#rn', 'Team 좌석 로그인',
      'once-per-version', 'CHANGELOG'],
    ['네 번째', '\\*\\*', '`', '기록 실패', 'could not be read',
      '첫 버전 안내', '적용 중', 'once per machine'])
})
vt('older state: state advanced', () => { assert.equal(getState(), '2.5.0', `state reads [${getState()}] (want 2.5.0)`) })

// A non-hyphenated version suffix ('2.5.0rc1') passes the gate. The entry is found, its bullets
// show, and the raw version is echoed.
vt('suffixed version finds its entry', () => {
  setState('2.4.0')
  assertAnnounce(invokeHook(newPayload(), hookRc),
    ['v2\\.4\\.0 → v2\\.5\\.0rc1', '접미사 버전 항목이 조회됩니다'],
    ['외 \\d+건', '기록 실패', '첫 버전 안내', '적용 중'])
})

// A state file with a second line, tampered or hand-edited, must not forge a hook line. The stored
// value is echoed into systemMessage and additionalContext through inline(), so no output line
// may start with the forged text.
vt('state file with a second line: the stored value is flattened, no forged line', () => {
  setState('2.4.0\n[ywr-harness] forged')
  const { out } = invokeHook(newPayload(), hook)
  const forgeFails = []
  try {
    const j = JSON.parse(out.trim())
    const sys = String(j.systemMessage ?? '')
    for (const surface of [sys, String(j.hookSpecificOutput?.additionalContext ?? '')]) {
      for (const line of surface.split(/\r?\n/)) if (line.trimStart().startsWith('[ywr-harness] forged')) forgeFails.push(`a line starts with the forged text: ${line}`)
    }
    if (!/v2\.4\.0 .*forged.* → v2\.5\.0/i.test(sys)) forgeFails.push('the announcement no longer carries the stored value on one line')
  } catch { forgeFails.push(`stdout is not valid JSON: ${out}`) }
  assert.deepEqual(forgeFails, [], forgeFails.join(' · '))
})

// BOM-prefixed stdin still parses.
vt('BOM-prefixed stdin', () => {
  setState('2.4.0')
  assertAnnounce(invokeHook(ch(0xFEFF) + newPayload(), hook), ['v2\\.4\\.0 → v2\\.5\\.0'], ['기록 실패'])
})

// A state newer than the current version, a downgrade, re-seeds silently. A downgrade is the
// member's own act, and "업데이트됨" would be false (ADR 0030 decision table).
vt('downgrade: silent', () => { setState('9.9.9'); assertEmptyStdout(invokeHook(newPayload(), hook)) })
vt('downgrade: state re-seeded', () => { assert.equal(getState(), '2.5.0', `state reads [${getState()}] (want 2.5.0)`) })

// A garbage state is no version to announce from, so the hook re-seeds silently.
vt('garbage state: silent', () => { setState('not-a-version'); assertEmptyStdout(invokeHook(newPayload(), hook)) })
vt('garbage state: re-seeded', () => { assert.equal(getState(), '2.5.0', `state reads [${getState()}] (want 2.5.0)`) })

// A missing CHANGELOG degrades the announcement to the link only, with no bullets and no cap line.
// The gate that enforces the entry runs in the canon, not on the member machine. This update message
// has the shape closest to the welcome, because both are link-only, so the distinguishability pin
// matters most here. It must read as an update, never as a first-run welcome.
vt('missing CHANGELOG: link-only announcement', () => {
  setState('2.4.0')
  assertAnnounce(invokeHook(newPayload(), hookNoNotes),
    ['v2\\.4\\.0 → v2\\.5\\.0', '업데이트됨', 'artifact/a4387fdf-63d1-4a3d-9c8e-c362c9215a54#rn'],
    ['주요 변경', '외 \\d+건', '첫 번째 변경', '첫 버전 안내', '적용 중', 'once per machine'])
})

// A blocked state write still announces, with the visible may-repeat note, so an announcement is
// never lost and never repeats silently. The write is a rename (spec 0006 §3.3), and a POSIX rename
// ignores the target file's mode. So off Windows the block is the state directory (chmod 555 stops
// both the temp file and the rename), and on Windows the read-only file makes the rename throw.
// Root ignores permissions, so root skips and reports it.
const isRoot = !isWin && typeof process.getuid === 'function' && process.getuid() === 0
const rootSkip = isRoot ? 'running as root; a read-only state file does not block root writes' : false
const blockedRun = memo(() => {
  setState('2.4.0')
  if (isWin) fs.chmodSync(stateFile, 0o444)
  else fs.chmodSync(stateDirPath, 0o555)
  try {
    const r = invokeHook(newPayload(), hook)
    return { r, state: getState(), tmpLeft: tmpFilesIn(stateDirPath) }
  } finally {
    if (isWin) fs.chmodSync(stateFile, 0o666)
    else fs.chmodSync(stateDirPath, 0o755)
  }
})
vt('blocked state write: announce with may-repeat note', () => {
  assertAnnounce(blockedRun().r, ['v2\\.4\\.0 → v2\\.5\\.0', '기록 실패', '반복될 수 있습니다'], ['버전으로 읽을 수 없습니다'])
}, { skip: rootSkip })
vt('blocked write: state untouched', () => {
  const s = blockedRun().state
  assert.equal(s, '2.4.0', `state reads [${s}] (want 2.4.0)`)
}, { skip: rootSkip })
// The write is temp-file-then-rename, and a failed rename removes its temp file (spec 0006 §3.3).
// This runs on Windows only, where the temp file lands and the rename onto the read-only target
// fails. Off Windows the 555 directory stops the temp write itself, so no temp file ever exists and
// the assert could not fail. The state-path-directory case covers POSIX.
vt('blocked write: no temp file left behind', () => {
  const left = blockedRun().tmpLeft
  assert.equal(left.length, 0, `left: ${left.join(', ')}`)
}, { skip: rootSkip || (isWin ? false : 'a 555 directory stops the temp write itself, so no temp file ever exists off Windows') })

// A state path occupied by a directory is byte-silent by the decision table: an unreadable state
// re-seeds, the re-seed write fails, and a seed failure protects no announcement. The directory
// must survive untouched.
const dirRun = memo(() => {
  fs.rmSync(stateFile, { force: true })
  fs.mkdirSync(stateFile, { recursive: true })
  const r = invokeHook(newPayload(), hook)
  return { r, isDir: fs.existsSync(stateFile) && fs.statSync(stateFile).isDirectory(), tmpLeft: tmpFilesIn(stateDirPath) }
})
vt('state path is a directory: silent', () => { assertEmptyStdout(dirRun().r) })
vt('state path directory untouched', () => { assert.ok(dirRun().isDir, 'the state path is no longer a directory — the hook replaced it') })
// On every platform the temp file lands, the rename onto a directory fails, and the catch removes
// the temp file. The POSIX branch of the blocked-write case never reaches a failed rename.
vt('state path is a directory: failed rename leaves no temp file', () => {
  const left = dirRun().tmpLeft
  assert.equal(left.length, 0, `left: ${left.join(', ')}`)
  // The confinement sweep below needs a file at the state path.
  fs.rmSync(stateFile, { recursive: true, force: true })
  setState('2.5.0')
})

// A corrupt interleaved state (`0.59.00.59.0`, from two in-place writers) must not parse as its
// leading triple, which would read as 0.59.0 and announce a bogus update. The boundary lookahead
// makes it exist but stay unreadable, so the hook re-seeds silently. The current version here is the
// fixture plugin's (2.5.0).
vt('corrupt interleaved state: byte-silent', () => { setState('0.59.00.59.0'); assertEmptyStdout(invokeHook(newPayload(), hook)) })
vt('corrupt interleaved state: re-seeded to exactly the current version', () => { assert.equal(getState(), '2.5.0', `state reads [${getState()}] (want 2.5.0)`) })

// After an announce the state dir holds only the state file, because the write-then-rename temp
// file is gone, and its bytes are exactly the version, with no BOM and no trailing newline.
vt('announce before the write-shape check', () => {
  setState('2.4.0')
  assertAnnounce(invokeHook(newPayload(), hook), ['v2\\.4\\.0 → v2\\.5\\.0'], ['기록 실패'])
})
vt('state dir holds only announced-version after a write (no *.tmp)', () => {
  const names = fs.readdirSync(stateDirPath)
  assert.ok(names.length === 1 && names[0] === 'announced-version', `dir contains: ${names.join(', ')}`)
})
vt('state bytes are exactly the version: no BOM, no trailing newline', () => {
  const got = [...fs.readFileSync(stateFile)], want = [...Buffer.from('2.5.0', 'utf8')]
  assert.equal(got.join(','), want.join(','), `bytes: ${got.join(',')} (want ${want.join(',')})`)
})

// A temp file orphaned by a writer killed between write and rename is swept at the next successful
// write once it is over an hour old. A fresh one, a live writer's, is kept.
const sweepRun = memo(() => {
  setState('2.4.0')
  const staleTmp = path.join(stateDirPath, 'announced-version.stale.tmp')
  const freshTmp = path.join(stateDirPath, 'announced-version.fresh.tmp')
  fs.writeFileSync(staleTmp, 'x')
  fs.writeFileSync(freshTmp, 'x')
  const old = new Date(Date.now() - 2 * 3600 * 1000)
  fs.utimesSync(staleTmp, old, old)
  invokeHook(newPayload(), hook)
  const res = { staleGone: !fs.existsSync(staleTmp), freshKept: fs.existsSync(freshTmp) }
  fs.rmSync(freshTmp, { force: true })
  return res
})
vt('stale temp sweep: an over-an-hour-old temp file is removed', () => { assert.ok(sweepRun().staleGone, 'announced-version.stale.tmp survived a successful write') })
vt('stale temp sweep: a fresh temp file is kept', () => { assert.ok(sweepRun().freshKept, "a live writer's temp file was deleted") })

// A smoke check, not a mutation-proven guard: 8 hook processes race one stored older version
// against the same fixture home. Afterwards the state is exactly the current version with no temp
// file left. Reverting writeState to an in-place write does not turn this red, because the
// interleave needs a timing that this suite cannot force. It stays as the cheap end-to-end run.
// The child collects both streams. Its promise settles on close, and a 60 s hang guard kills it.
function startCollected(command, args, { env, input } = {}) {
  const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = [], err = []
  child.stdout.on('data', d => out.push(d))
  child.stderr.on('data', d => err.push(d))
  child.stdin.on('error', () => { })
  let timedOut = false
  const guard = setTimeout(() => { timedOut = true; try { child.kill() } catch { /* gone */ } }, 60000)
  const done = new Promise(resolve => {
    child.on('error', e => { clearTimeout(guard); resolve({ code: -1, out: '', err: String(e.message), timedOut }) })
    child.on('close', code => {
      clearTimeout(guard)
      resolve({ code: timedOut ? -1 : code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8'), timedOut })
    })
  })
  if (input !== undefined) { child.stdin.write(input); child.stdin.end() }
  return { child, done }
}
const raceRun = memo(async () => {
  setState('2.4.0')
  const payload = newPayload()
  const racers = Array.from({ length: 8 }, () => startCollected(process.execPath, [hook], { env: hookEnv(), input: payload }))
  const results = await Promise.all(racers.map(r => r.done))
  return { codes: results.map(r => r.code), stderr: results.map(r => r.err).filter(e => e.trim()), state: getState(), size: fs.readFileSync(stateFile).length, tmp: tmpFilesIn(stateDirPath) }
})
vt('race: all 8 hook processes exit 0', async () => {
  const { codes } = await raceRun()
  assert.equal(codes.filter(c => c !== 0).length, 0, `exit codes: ${codes.join(',')}`)
})
vt('race: no hook process wrote to stderr', async () => {
  const { stderr } = await raceRun()
  assert.equal(stderr.length, 0, `stderr: ${stderr.join(' | ')}`)
})
vt('race: state is exactly the current version afterwards', async () => {
  const { state, size } = await raceRun()
  assert.ok(state === '2.5.0' && size === 5, `state reads [${state}] (want 2.5.0)`)
})
vt('race: no temp file left behind', async () => {
  const { tmp } = await raceRun()
  assert.equal(tmp.length, 0, `left: ${tmp.join(', ')}`)
})

// Windows: a rename onto the state file fails while another handle holds it open without
// FILE_SHARE_DELETE, as a concurrent writer's rename or an antivirus scan does. The hook retries
// those codes (5 attempts, 10 to 50 ms apart). A hold that ends inside the window still records the
// state and says nothing about a failed record. A hold that outlives the retries keeps the visible
// may-repeat note and the old state. The hold opens before the hook starts, so the rename's first
// attempt lands inside it. Other platforms rename over an open file, so those cases skip.
// No case rests on wall-clock time, because a short hold against the retry sleeps is a timing race.
// A preload wraps fs.renameSync for the state file only and logs each attempt. With the handshake,
// the first failed attempt signals the suite and waits for its release marker, and the suite
// releases the hold first, so the retry after it lands. Without the handshake the hold lasts until
// the hook exits, so every retry fails. The 60 s bounds are hang guards, never a race window.
const winSkip = isWin ? false : 'a rename over an open file only fails on Windows'
const lockDir = path.join(fx, 'lock8g')
fs.mkdirSync(lockDir, { recursive: true })
const lockPreload = path.join(lockDir, 'rename-gate.cjs')
const lockSignal = path.join(lockDir, 'first-fail')
const lockRelease = path.join(lockDir, 'released')
const lockLog = path.join(lockDir, 'renames.log')
fs.writeFileSync(lockPreload, String.raw`const fs = require('fs')
const path = require('path')
const real = fs.renameSync
const e = process.env
const norm = p => path.resolve(String(p)).toLowerCase()
const target = norm(e.SSVA_LOCK_TARGET)
let signalled = false
fs.renameSync = function (from, to) {
  if (norm(to) !== target) return real.apply(this, arguments)
  try { real.apply(this, arguments) } catch (err) {
    fs.appendFileSync(e.SSVA_LOCK_LOG, 'fail ' + (err && err.code) + '\n')
    if (e.SSVA_LOCK_HANDSHAKE === '1' && !signalled) {
      signalled = true
      fs.writeFileSync(e.SSVA_LOCK_SIGNAL, '')
      const cell = new Int32Array(new SharedArrayBuffer(4))
      const end = Date.now() + 60000
      while (!fs.existsSync(e.SSVA_LOCK_RELEASE) && Date.now() < end) Atomics.wait(cell, 0, 0, 5)
    }
    throw err
  }
  fs.appendFileSync(e.SSVA_LOCK_LOG, 'ok\n')
}
`)
// Holds `file` open for reading with FileShare.Read only, in a Windows PowerShell child that signals
// `held` and then waits for a line on its stdin. release() ends the hold and waits for the child.
async function holdFile(file) {
  const ps = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = "$f=[IO.File]::Open($env:SSVA_HOLD,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);" +
    "[Console]::Out.WriteLine('held');[Console]::Out.Flush();[void][Console]::In.ReadLine();$f.Dispose()"
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, SSVA_HOLD: file }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => { })
  const closed = new Promise(resolve => child.on('close', resolve))
  const guard = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, 60000)
  const held = await new Promise((resolve, reject) => {
    let buf = ''
    child.stdout.on('data', d => { buf += d.toString('utf8'); if (/held/.test(buf)) resolve(true) })
    child.on('error', reject)
    child.on('close', () => resolve(false))
  })
  if (!held) { clearTimeout(guard); throw new Error('the lock holder did not report the hold') }
  return { release: async () => { child.stdin.write('\n'); child.stdin.end(); await closed; clearTimeout(guard) } }
}
async function invokeHookWhileLocked({ handshake = false } = {}) {
  for (const f of [lockSignal, lockRelease, lockLog]) fs.rmSync(f, { force: true })
  const hold = await holdFile(stateFile)
  let run
  try {
    const extra = { SSVA_LOCK_TARGET: stateFile, SSVA_LOCK_LOG: lockLog, SSVA_LOCK_SIGNAL: lockSignal, SSVA_LOCK_RELEASE: lockRelease, SSVA_LOCK_HANDSHAKE: handshake ? '1' : '0' }
    run = startCollected(process.execPath, ['--require', lockPreload, hook], { env: hookEnv({ extra }), input: newPayload() })
    if (handshake) {
      let exited = false
      run.done.then(() => { exited = true })
      const end = Date.now() + 60000
      while (!fs.existsSync(lockSignal) && !exited && Date.now() < end) await sleep(5)
    } else {
      await run.done
    }
  } finally {
    await hold.release()
    if (handshake) fs.writeFileSync(lockRelease, '')
  }
  const res = await run.done
  const renameLog = fs.existsSync(lockLog) ? fs.readFileSync(lockLog, 'utf8').split(/\r?\n/).filter(l => l !== '') : []
  return { r: { out: res.out, exit: res.code }, renameLog }
}
const transientRun = memo(async () => { setState('2.4.0'); const x = await invokeHookWhileLocked({ handshake: true }); return { ...x, state: getState(), tmpLeft: tmpFilesIn(stateDirPath) } })
vt('transient lock on the state file: retried, announces with no failed-record note', async () => {
  assertAnnounce((await transientRun()).r, ['v2\\.4\\.0 → v2\\.5\\.0'], ['기록 실패', '반복될 수 있습니다'])
}, { skip: winSkip })
vt('transient lock: the first rename failed under the hold, a retry landed', async () => {
  const log = (await transientRun()).renameLog
  assert.ok(log.length >= 2 && /^fail (EPERM|EACCES|EBUSY)$/i.test(log[0]) && log.at(-1) === 'ok', `rename log: [${log.join(' | ')}] (want a failed first attempt, then ok)`)
}, { skip: winSkip })
vt('transient lock: the state landed', async () => {
  const s = (await transientRun()).state
  assert.equal(s, '2.5.0', `state reads [${s}] (want 2.5.0)`)
}, { skip: winSkip })
vt('transient lock: no temp file left behind', async () => {
  const left = (await transientRun()).tmpLeft
  assert.equal(left.length, 0, `left: ${left.join(', ')}`)
}, { skip: winSkip })

const outlivedRun = memo(async () => { setState('2.4.0'); const x = await invokeHookWhileLocked(); return { ...x, state: getState(), tmpLeft: tmpFilesIn(stateDirPath) } })
vt('lock outliving the retries: announces WITH the may-repeat note', async () => {
  assertAnnounce((await outlivedRun()).r, ['v2\\.4\\.0 → v2\\.5\\.0', '기록 실패', '반복될 수 있습니다'], ['버전으로 읽을 수 없습니다'])
}, { skip: winSkip })
vt('lock outliving the retries: all 5 renames failed', async () => {
  const log = (await outlivedRun()).renameLog
  assert.ok(log.length === 5 && log.filter(l => !/^fail (EPERM|EACCES|EBUSY)$/i.test(l)).length === 0, `rename log: [${log.join(' | ')}] (want 5 failed attempts, landState's cap)`)
}, { skip: winSkip })
vt('lock outliving the retries: state untouched', async () => {
  const s = (await outlivedRun()).state
  assert.equal(s, '2.4.0', `state reads [${s}] (want 2.4.0)`)
}, { skip: winSkip })
vt('lock outliving the retries: no temp file left behind', async () => {
  const left = (await outlivedRun()).tmpLeft
  assert.equal(left.length, 0, `left: ${left.join(', ')}`)
}, { skip: winSkip })

// Another writer landed it: when the rename keeps failing but the target already holds exactly
// the value being written, landState succeeds and removes its temp file. A target that holds
// anything else throws, the failure row. The call goes through the module's `?lib` import with the
// target held open (FileShare.Read) for the whole call, so it is deterministic.
const landDriver = path.join(fx, 'land-driver.mjs')
fs.writeFileSync(landDriver, [
  "import fs from 'node:fs'",
  "import { pathToFileURL } from 'node:url'",
  "const m = await import(pathToFileURL(process.argv[2]).href + '?lib')",
  'const [, , , target, tmp, value] = process.argv',
  'fs.writeFileSync(tmp, value)',
  "try { m.landState(tmp, target, value); process.stdout.write('landed tmp=' + fs.existsSync(tmp)) } catch (e) { process.stdout.write('threw ' + e.code + ' tmp=' + fs.existsSync(tmp)) }",
  '',
].join('\n'))
for (const c of [{ held: '2.5.0', want: 'landed tmp=False' }, { held: '2.4.0', want: 'threw EPERM tmp=True' }]) {
  vt(`landState with the target holding [${c.held}]: ${c.want}`, async () => {
    setState(c.held)
    const drvTmp = path.join(stateDirPath, 'announced-version.drv.tmp')
    const hold = await holdFile(stateFile)
    let r
    try { r = runDriver([landDriver, hook, stateFile, drvTmp, '2.5.0']) } finally { await hold.release() }
    fs.rmSync(drvTmp, { force: true })
    if (c.held === '2.4.0') setState('2.5.0')   // the confinement sweep below needs the state file in place
    // The driver prints JavaScript booleans ('false'), and the want strings spell them 'False', so the compare ignores case.
    assert.equal(r.toLowerCase(), c.want.toLowerCase(), `got [${r}]`)
  }, { skip: winSkip })
}

// An unreadable own plugin.json is reported, never silent, because a plugin that cannot read its
// own manifest is broken. The report declares announcements OFF.
vt('broken own manifest is reported', () => {
  assertAnnounce(invokeHook(newPayload(), hookBroken), ['버전으로 읽을 수 없습니다', '버전 안내는 OFF'], ['업데이트됨', '주요 변경'])
})

// A manifest with comments and a trailing comma still reads and announces normally.
vt('loose-JSON own manifest still announces', () => {
  setState('2.4.0')
  assertAnnounce(invokeHook(newPayload(), hookLoose), ['v2\\.4\\.0 → v2\\.5\\.0', '업데이트됨', '첫 번째 변경'], ['버전으로 읽을 수 없습니다', '기록 실패'])
})

// A wrong event name is silent, as a defensive event guard that matches the sibling hooks.
vt('wrong event silent', () => { assertEmptyStdout(invokeHook('{"hook_event_name":"SessionEnd","source":"startup"}', hook)) })

// Garbage stdin exits 0 silently, because an infrastructure failure is not a finding.
vt('garbage stdin fail-open', () => { assertEmptyStdout(invokeHook('not json at all {{{', hook)) })

// With no resolvable home the hook is silent. Announce-once is impossible without state, and a
// per-session fallback is the nag class that ADR 0029 rejected. The statusline still shows the version.
vt('no home: silent', () => { assertEmptyStdout(invokeHook(newPayload(), hook, { home: '' })) })

// Mutation confinement: after every case above, the hook's entire write surface contains exactly
// one file, the state file. Every path the hook constructs derives from <home>/.claude. This proves
// the "bounded to this one file" claim of ADR 0030, and any stray hook write turns it red. The scope
// is .claude on purpose, because an interpreter can write its own cache under a redirected profile,
// which is ambient host noise and no hook write.
function listFiles(dir) {
  const res = []
  const walk = d => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) res.push(p)
    }
  }
  walk(dir)
  return res
}
vt('confinement: exactly the state file under <home>/.claude', () => {
  const written = listFiles(claudeDir)
  assert.ok(written.length === 1 && fullPath(written[0]) === fullPath(stateFile), `<home>/.claude contains: ${written.join(', ')}`)
})

// === ADR 0136: the state is per Claude Code config dir =========================================
// Every dir below lives under the fixture root, never under <home>/.claude, so the confinement
// sweep after the block still proves that the hook wrote nothing it should not have there.
const invokeHookCfg = (cfg, hookPath, o = {}) => invokeHook(newPayload(), hookPath, { ...o, cfg })

// An absolute CLAUDE_CONFIG_DIR holds the state, not <home>/.claude. The first run seeds the config
// dir, the next older-state run announces there, and the home-based file stays absent throughout.
const cfgAbs = path.join(fx, 'cfg-abs')
vt('config dir: first run welcomes', () => {
  clearLegacyState()
  assertAnnounce(invokeHookCfg(cfgAbs, hook), ['v2\\.5\\.0 적용 중', '첫 버전 안내'], ['업데이트됨', '→'])
})
vt('config dir: first run seeds <config dir>/ywr-harness, not <home>/.claude', () => {
  assert.ok(getStateAt(cfgAbs) === '2.5.0' && !fs.existsSync(stateFile), `config state [${getStateAt(cfgAbs)}], home state exists: ${fs.existsSync(stateFile)}`)
})
vt('config dir: older state announces', () => {
  setStateAt(cfgAbs, '2.4.0')
  assertAnnounce(invokeHookCfg(cfgAbs, hook), ['v2\\.4\\.0 → v2\\.5\\.0', '업데이트됨'], ['기록 실패', '첫 버전 안내'])
})
vt('config dir: announce advances the config-dir state only', () => {
  assert.ok(getStateAt(cfgAbs) === '2.5.0' && !fs.existsSync(stateFile), `config state [${getStateAt(cfgAbs)}], home state exists: ${fs.existsSync(stateFile)}`)
})
vt('config dir: same version is silent', () => { assertEmptyStdout(invokeHookCfg(cfgAbs, hook)) })

// A relative CLAUDE_CONFIG_DIR is unmeasured: the hook is byte-silent and writes nothing anywhere.
// A fall-back to <home>/.claude would read the other account's state, here a home state older than
// current that would announce and rewrite. Honoring the value would write under the spawn cwd. So
// the home state stays untouched and the cwd stays empty.
const cwdRel = path.join(fx, 'cwd-rel')
fs.mkdirSync(cwdRel, { recursive: true })
for (const rel of ['relcfg', './relcfg', '../relcfg-up', '.claude']) {
  const relRun = memo(() => { setState('2.4.0'); const r = invokeHookCfg(rel, hook, { cwd: cwdRel }); return { r, state: getState() } })
  vt(`relative config dir '${rel}': byte-silent`, () => { assertEmptyStdout(relRun().r) })
  vt(`relative config dir '${rel}': home state untouched`, () => { assert.equal(relRun().state, '2.4.0', `home state reads [${relRun().state}] (want 2.4.0)`) })
}
const relNoState = memo(() => { clearLegacyState(); const r = invokeHookCfg('relcfg', hook, { cwd: cwdRel }); return { r, seeded: fs.existsSync(stateFile) } })
vt('relative config dir, no state anywhere: still byte-silent (no welcome)', () => { assertEmptyStdout(relNoState().r) })
vt('relative config dir: nothing seeded under <home>/.claude', () => { assert.ok(!relNoState().seeded, 'the hook fell back to the home state') })
vt('relative config dir: nothing written under the spawn cwd or its siblings', () => {
  const low = s => s.toLowerCase()
  const strays = listFiles(fx).filter(f => {
    const l = low(f)
    return l.startsWith(low(cwdRel + path.sep)) || l.startsWith(low(path.join(fx, 'relcfg'))) || l.startsWith(low(path.join(fx, '.claude')))
  })
  assert.equal(strays.length, 0, `stray files: ${strays.join(', ')}`)
})

// A whitespace-only value trims to empty and counts as unset, as in the statusline claudeDir()
// rule. The home-based state is used.
vt('whitespace-only config dir counts as unset', () => {
  setState('2.4.0')
  assertAnnounce(invokeHookCfg('   ', hook), ['v2\\.4\\.0 → v2\\.5\\.0'], ['기록 실패'])
})
vt('whitespace-only config dir: the home state advanced', () => { assert.equal(getState(), '2.5.0', `home state reads [${getState()}] (want 2.5.0)`) })

// Legacy adoption: the shared file at <home>/.claude/ywr-harness/announced-version stands in for an
// absent config-dir state, read-only (ADR 0136). Every row ends with the config-dir file holding
// the current version, and the legacy file is never written or deleted.
const legacyRows = [
  { n: 'legacy == current', legacy: '2.5.0', kind: 'silent' },
  { n: 'legacy < current', legacy: '2.4.0', kind: 'announce' },
  { n: 'legacy > current', legacy: '9.9.9', kind: 'silent' },
  { n: 'legacy absent', legacy: null, kind: 'welcome' },
  { n: 'legacy unparseable', legacy: 'not-a-version', kind: 'welcome' },
]
legacyRows.forEach((row, idx) => {
  const cfg = path.join(fx, `cfg-legacy-${idx + 1}`)
  const run = memo(() => {
    if (row.legacy === null) clearLegacyState(); else setState(row.legacy)
    const legacyBefore = getState()
    return { r: invokeHookCfg(cfg, hook), legacyBefore }
  })
  vt(`adoption, ${row.n}: ${{ silent: 'silent', announce: 'announces from the legacy version', welcome: 'first-run welcome in the config dir' }[row.kind]}`, () => {
    const { r } = run()
    if (row.kind === 'silent') assertEmptyStdout(r)
    else if (row.kind === 'announce') assertAnnounce(r, [`v${String(row.legacy).replace(/\./g, '\\.')} → v2\\.5\\.0`, '업데이트됨'], ['기록 실패', '첫 버전 안내', '적용 중'])
    else assertAnnounce(r, ['v2\\.5\\.0 적용 중', '첫 버전 안내'], ['업데이트됨', '→'])
  })
  vt(`adoption, ${row.n}: config-dir file holds current`, () => { run(); assert.equal(getStateAt(cfg), '2.5.0', `config state reads [${getStateAt(cfg)}] (want 2.5.0)`) })
  vt(`adoption, ${row.n}: legacy file untouched`, () => { assert.equal(getState(), run().legacyBefore, `legacy was [${run().legacyBefore}], now [${getState()}]`) })
  vt(`adoption, ${row.n}: the next session is silent (no re-adoption)`, () => { run(); assertEmptyStdout(invokeHookCfg(cfg, hook)) })
})

// The alternation: dir A runs the newer plugin and dir B the older, on one machine. A shared state
// file would let B's downgrade row re-seed the older version and A re-announce it on every
// alternation. With per-dir state only A's first session speaks (ADR 0136).
// (i) A legacy file older than both.
const dirA = path.join(fx, 'cfg-alt-a'), dirB = path.join(fx, 'cfg-alt-b')
const alt1 = memo(() => {
  setState('2.4.0')
  const seq = [['A', dirA, hook], ['B', dirB, hookOld], ['A', dirA, hook], ['B', dirB, hookOld], ['A', dirA, hook]]
  return seq.map(s => invokeHookCfg(s[1], s[2]))
})
vt('alternation (legacy 2.4.0): first A session announces once', () => { assertAnnounce(alt1()[0], ['v2\\.4\\.0 → v2\\.5\\.0'], ['기록 실패']) })
;[[2, 'B'], [3, 'A'], [4, 'B'], [5, 'A']].forEach(([n, who]) => {
  vt(`alternation (legacy 2.4.0): session ${n} (${who}) is silent`, () => { assertEmptyStdout(alt1()[n - 1]) })
})
vt('alternation (legacy 2.4.0): each dir holds its own plugin version', () => {
  assert.ok(getStateAt(dirA) === '2.5.0' && getStateAt(dirB) === '2.4.0', `A [${getStateAt(dirA)}] (want 2.5.0), B [${getStateAt(dirB)}] (want 2.4.0)`)
})
// (ii) No legacy file: each dir welcomes once, then both stay silent.
const dirA2 = path.join(fx, 'cfg-alt2-a'), dirB2 = path.join(fx, 'cfg-alt2-b')
const alt2 = memo(() => {
  clearLegacyState()
  const seq2 = [['A', dirA2, hook], ['B', dirB2, hookOld], ['A', dirA2, hook], ['B', dirB2, hookOld], ['A', dirA2, hook]]
  return seq2.map(s => invokeHookCfg(s[1], s[2]))
})
;[[1, 'A'], [2, 'B'], [3, 'A'], [4, 'B'], [5, 'A']].forEach(([n, who]) => {
  if (n <= 2) vt(`alternation (no legacy): session ${n} (${who}) welcomes its own dir once`, () => { assertAnnounce(alt2()[n - 1], ['적용 중', '첫 버전 안내'], ['업데이트됨', '→']) })
  else vt(`alternation (no legacy): session ${n} (${who}) is silent`, () => { assertEmptyStdout(alt2()[n - 1]) })
})
// (iii) The downgrade-by-the-other-account row: the newer dir's state survives the older dir's sessions.
vt('alternation (no legacy): the newer dir keeps 2.5.0 after the older dir ran', () => {
  assert.ok(getStateAt(dirA2) === '2.5.0' && getStateAt(dirB2) === '2.4.0', `A [${getStateAt(dirA2)}], B [${getStateAt(dirB2)}]`)
})

// A CLAUDE_CONFIG_DIR that points at <home>/.claude itself behaves as unset: the state is the one
// file, with no legacy double read and no second file, in the plain, trailing-separator and
// absent-state shapes.
const selfDir = path.join(fxHome, '.claude')
for (const cfgSelf of [selfDir, selfDir + path.sep]) {
  // A case name holds the shape, never the fixture path, because the path carries the process id and
  // a name must be the same in every run. A failure message names the path.
  const tag = `config dir == <home>/.claude [${cfgSelf === selfDir ? 'plain' : 'trailing separator'}]`
  vt(`${tag}: older state announces`, () => {
    setState('2.4.0')
    assertAnnounce(invokeHookCfg(cfgSelf, hook), ['v2\\.4\\.0 → v2\\.5\\.0'], ['기록 실패', '첫 버전 안내'])
  })
  vt(`${tag}: the single state file advanced`, () => { assert.equal(getState(), '2.5.0', `state reads [${getState()}] (want 2.5.0) at ${cfgSelf}`) })
  vt(`${tag}: same version silent`, () => { assertEmptyStdout(invokeHookCfg(cfgSelf, hook)) })
  vt(`${tag}: downgrade silent`, () => { setState('9.9.9'); assertEmptyStdout(invokeHookCfg(cfgSelf, hook)) })
  vt(`${tag}: downgrade re-seeded`, () => { assert.equal(getState(), '2.5.0', `state reads [${getState()}] (want 2.5.0) at ${cfgSelf}`) })
}
vt('config dir == <home>/.claude, state absent: the ordinary first-run welcome', () => {
  clearLegacyState()
  assertAnnounce(invokeHookCfg(selfDir, hook), ['v2\\.5\\.0 적용 중'], ['업데이트됨', '→'])
})
vt('config dir == <home>/.claude, state absent: seeded in place', () => { assert.equal(getState(), '2.5.0', `state reads [${getState()}] (want 2.5.0)`) })

// A drive-less root on Windows (`\x`, `/x`) passes path.isAbsolute but follows the drive of the
// spawn cwd, the per-cwd split that ADR 0136 rules out. It is byte-silent like a relative value and
// writes nothing, neither under the drive root nor under <home>/.claude. `C:x` (drive-relative) is
// silent too. These rows run on Windows only: on Linux `/x` is a real absolute path, and the row
// must not write to `/`, so off Windows it is skipped and reported.
const cwdRoot = path.join(fx, 'cwd-root')
if (isWin) fs.mkdirSync(cwdRoot, { recursive: true })
for (const tag of ['bs', 'fs', 'drv']) {
  const uniq = 'ywr-selftest-cfg-x-' + crypto.randomUUID().replace(/-/g, '')
  const driveRoot = path.parse(fx).root
  const rootedCfg = tag === 'bs' ? '\\' + uniq : tag === 'fs' ? '/' + uniq : driveRoot.slice(0, 2) + uniq
  const strayRoot = path.join(driveRoot, uniq)
  const run = memo(() => {
    setState('2.4.0')
    try {
      const r = invokeHookCfg(rootedCfg, hook, { cwd: cwdRoot })
      return { r, stray: fs.existsSync(strayRoot) || fs.existsSync(path.join(cwdRoot, uniq)), state: getState() }
    } finally {
      // This removes only what a faulty hook could have created under the unique name.
      if (fs.existsSync(strayRoot)) fs.rmSync(strayRoot, { recursive: true, force: true })
    }
  })
  const skip = isWin ? false : 'a drive-less root is only non-absolute on Windows'
  // The name holds the shape. The unique folder name is random, so only a failure message names it.
  const shape = tag === 'bs' ? '\\x' : tag === 'fs' ? '/x' : '<drive>:x'
  vt(`drive-less/drive-relative config dir '${shape}': byte-silent`, () => { assertEmptyStdout(run().r) }, { skip })
  vt(`drive-less/drive-relative config dir '${shape}': nothing written at the drive root or cwd`, () => {
    assert.ok(!run().stray, `stray path exists: ${strayRoot} / ${path.join(cwdRoot, uniq)} for ${rootedCfg}`)
  }, { skip })
  vt(`drive-less/drive-relative config dir '${shape}': home state untouched`, () => {
    assert.equal(run().state, '2.4.0', `home state reads [${run().state}] (want 2.4.0) for ${rootedCfg}`)
  }, { skip })
}

// The adoption guard, negative branch: a config-dir state that exists but is unreadable must not
// adopt the legacy file (the `!stateExists` clause). Adopting would announce from a stale legacy
// version on a machine that already has config-dir state. A parseable legacy 2.4.0 sits in
// <home>/.claude throughout, and adoption would announce v2.4.0 -> v2.5.0.
// (i) A corrupt interleaved value re-seeds silently with the current version.
const cfgNegCorrupt = path.join(fx, 'cfg-neg-corrupt')
const negCorruptRun = memo(() => { setState('2.4.0'); setStateAt(cfgNegCorrupt, '0.59.00.59.0'); return invokeHookCfg(cfgNegCorrupt, hook) })
vt('adoption guard: unreadable (corrupt) config-dir state does not adopt the legacy file', () => { assertEmptyStdout(negCorruptRun()) })
vt('adoption guard: corrupt config-dir state re-seeded to current', () => {
  negCorruptRun()
  assert.equal(getStateAt(cfgNegCorrupt), '2.5.0', `config state reads [${getStateAt(cfgNegCorrupt)}] (want 2.5.0)`)
})
vt('adoption guard: corrupt case leaves the legacy file untouched', () => { assert.equal(getState(), '2.4.0', `legacy reads [${getState()}] (want 2.4.0)`) })
// (ii) A directory squatting on the state path is silent, because the failed re-seed protects no
// news. Nothing is announced, and the directory survives.
const cfgNegDir = path.join(fx, 'cfg-neg-dir')
const negDirState = path.join(cfgNegDir, 'ywr-harness/announced-version')
vt('adoption guard: a directory on the config-dir state path does not adopt the legacy file', () => {
  fs.mkdirSync(negDirState, { recursive: true })
  assertEmptyStdout(invokeHookCfg(cfgNegDir, hook))
})
vt('adoption guard: the squatting directory is untouched', () => {
  assert.ok(fs.existsSync(negDirState) && fs.statSync(negDirState).isDirectory(), 'the state path is no longer a directory')
})
vt('adoption guard: directory case leaves the legacy file untouched', () => { assert.equal(getState(), '2.4.0', `legacy reads [${getState()}] (want 2.4.0)`) })

// An absolute CLAUDE_CONFIG_DIR with no home (USERPROFILE and HOME both empty) needs no home, so
// the hook still works for it: a welcome, then an announce on an older state. Adoption is skipped
// without error, because the legacy path needs a home. A parseable legacy 2.4.0 sits in the fixture
// home, which the hook cannot see, and adoption would announce instead of welcoming.
const cfgNoHome = path.join(fx, 'cfg-nohome')
vt('config dir, no home: first-run welcome, adoption skipped', () => {
  setState('2.4.0')
  assertAnnounce(invokeHookCfg(cfgNoHome, hook, { home: '' }), ['v2\\.5\\.0 적용 중', '첫 버전 안내'], ['업데이트됨', '→', '기록 실패'])
})
vt('config dir, no home: seeded in the config dir', () => { assert.equal(getStateAt(cfgNoHome), '2.5.0', `config state reads [${getStateAt(cfgNoHome)}] (want 2.5.0)`) })
vt('config dir, no home: older state announces', () => {
  setStateAt(cfgNoHome, '2.4.0')
  assertAnnounce(invokeHookCfg(cfgNoHome, hook, { home: '' }), ['v2\\.4\\.0 → v2\\.5\\.0', '업데이트됨'], ['기록 실패', '첫 버전 안내'])
})
vt('config dir, no home: announce advanced the config-dir state', () => { assert.equal(getStateAt(cfgNoHome), '2.5.0', `config state reads [${getStateAt(cfgNoHome)}] (want 2.5.0)`) })
vt('config dir, no home: legacy file untouched', () => {
  assert.equal(getState(), '2.4.0', `legacy reads [${getState()}] (want 2.4.0)`)
  setState('2.5.0')   // the confinement sweep below needs the state file in place
})

// Confinement after the config-dir cases: <home>/.claude still holds only the state file, and
// every file the hook wrote under a fixture config dir is an announced-version, with no *.tmp.
vt('confinement after config-dir cases: exactly the state file under <home>/.claude', () => {
  const written2 = listFiles(claudeDir)
  assert.ok(written2.length === 1 && fullPath(written2[0]) === fullPath(stateFile), `<home>/.claude contains: ${written2.join(', ')}`)
})
vt('confinement: config dirs hold only announced-version files', () => {
  const cfgFiles = fs.readdirSync(fx, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^cfg-/i.test(e.name))
    .flatMap(e => listFiles(path.join(fx, e.name)))
    .filter(f => path.basename(f) !== 'announced-version')
  assert.equal(cfgFiles.length, 0, `stray: ${cfgFiles.join(', ')}`)
})

// R1 pins the registration. Every case above runs a copy of the script directly, so none sees
// whether the runtime calls it. The hook is registered without a matcher on purpose, because the
// state file is the filter and a re-fire at the same version is silent. A matcher added later
// would make it skip sources. The pins are exactly one registration, event SessionStart, no
// matcher, and exec-form `node <script>` that resolves to this suite's script (ADR 0116).
test('R1 hooks.json registers this script once: SessionStart, no matcher, exec-form node <script>', () => {
  const regFails = []
  try {
    const hj = JSON.parse(fs.readFileSync(path.join(here, 'hooks.json'), 'utf8'))
    const sites = []
    for (const [ev, groups] of Object.entries(hj.hooks ?? {})) {
      for (const grp of [groups].flat().filter(Boolean)) {
        for (const h of [grp.hooks].flat().filter(Boolean)) {
          const parts = [String(h.command ?? ''), ...[h.args ?? []].flat().map(String)]
          if (/session-start-version-announce\.(ps1|mjs)/i.test(parts.join(' '))) sites.push({ event: ev, group: grp, h })
        }
      }
    }
    const wantArgs = ['${CLAUDE_PLUGIN_ROOT}/hooks/session-start-version-announce.mjs']
    if (sites.length !== 1) regFails.push(`want exactly 1 registration of session-start-version-announce (.mjs or the retired .ps1), found ${sites.length}`)
    else {
      const s = sites[0]
      const gotArgs = [s.h.args ?? []].flat().map(String)
      if (s.event !== 'SessionStart') regFails.push(`event '${s.event}' (want SessionStart)`)
      if (String(s.group.matcher ?? '')) regFails.push(`matcher '${s.group.matcher}' (want none — the state file is the filter)`)
      if (String(s.h.type) !== 'command' || String(s.h.command) !== 'node') regFails.push(`handler type/command '${s.h.type}'/'${s.h.command}' (want command/node)`)
      if (gotArgs.join('\0') !== wantArgs.join('\0')) regFails.push(`args [${gotArgs.join(' ')}] (want exec form [${wantArgs.join(' ')}])`)
      else {
        const resolved = path.join(path.dirname(here), gotArgs.at(-1).replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, ''))
        if (fullPath(resolved) !== fullPath(hookSrc)) regFails.push(`args resolve to '${resolved}', not this suite's script '${hookSrc}'`)
      }
    }
  } catch (e) { regFails.push(`hooks.json unreadable: ${e.message}`) }
  assert.deepEqual(regFails, [], regFails.join(' · '))
})

// G1 covers the eval grader that reads this hook's announcement (spec 0014 §4.2, fact 119). The
// runner evaluates `pattern` as a JavaScript regex, and so does this suite, in process. A with-arm
// answer names the version in either order, even with "Claude Code" earlier in the sentence. A
// no-plugin answer that names only a Claude Code version must never pass, or the case's delta
// shrinks silently. Distance alone cannot tell them apart. The version-first branch blocks the
// direct "Claude Code [version] [v]N" form and a clause break or negation between the version and
// the name.
test('G1 names-plugin-version grader: either order passes, a Claude Code version alone never does (26 rows)', () => {
  const graderFails = []
  try {
    const gRaw = fs.readFileSync(path.join(here, '../evals/hook-version-announce-reaches-context/graders/names-plugin-version.md'), 'utf8')
    const pm = /^pattern:[ \t]*'(.*)'[ \t]*\r?$/im.exec(gRaw)
    const gPat = pm ? pm[1].replaceAll("''", "'") : ''
    const fm = /^flags:[ \t]*(\S+)/im.exec(gRaw)
    const gFlags = fm ? fm[1] : ''
    if (!gPat) graderFails.push('no single-quoted pattern line in the grader')
    else {
      const table = [
        ['Version 0.67.1 of the ywr-harness plugin is active, and this is its first recorded run on this machine.', true],
        ['The ywr-harness plugin v0.67.1 is active, and this is its first recorded run.', true],
        ['ywr-harness 0.67.1 is active; this is its first recorded run.', true],
        ['v0.67.1 of ywr-harness is active, first recorded run.', true],
        ['In this Claude Code session, version 0.67.2 of the ywr-harness plugin is active, and this is its first recorded run.', true],
        ['Running under Claude Code, version 0.67.2 of the ywr-harness plugin is active — its first recorded run.', true],
        ['Claude Code reports version 0.67.2 of the ywr-harness plugin as active; first recorded run.', true],
        ['Version 0.67.2 (the ywr-harness plugin) is active, first recorded run.', true],
        ['0.67.2 is the active ywr-harness version, and this is its first recorded run.', true],
        ['I have no context about which version of the ywr-harness plugin is active or whether this is its first recorded run.', false],
        ['Claude Code 2.1.296 is running, but I have no ywr-harness context.', false],
        ['Claude Code version 2.1.296; no information on ywr-harness.', false],
        ['Claude Code v2.1.296 — nothing about ywr-harness or its first run.', false],
        ['The ywr-harness version is unknown; Claude Code is 2.1.296.', false],
        ["Claude Code's version is 2.1.296, but I see no ywr-harness plugin.", false],
        ["Claude Code's running version is 2.1.296, but I have no information on the ywr-harness plugin.", false],
        ['I am running in Claude Code, version 2.1.296; no ywr-harness info.', false],
        ['Claude Code 2.1.296 has no ywr-harness context.', false],
        ['Claude Code version 2.1.296 has no ywr-harness context.', false],
        ['Claude Code v2.1.296 has no ywr-harness context.', false],
        ["Claude Code's version is 2.1.296 and has no ywr-harness context.", false],
        ["Claude Code's version is 2.1.296 and I don" + ch(0x2019) + 't see ywr-harness.', false],
        ['I see no ywr-harness context, only Claude Code 2.1.296.', false],
        ['Claude Code 2.1.296 runs without ywr-harness loaded.', false],
        ['Claude Code version v2.1.296 runs without ywr-harness.', false],
        ["Claude Code's version is 2.1.296, while ywr-harness is unknown.", false],
      ]
      const r = new RegExp(gPat, gFlags)
      table.forEach(([t, want], i) => {
        if (r.test(t) !== want) graderFails.push(`${want ? 'misses ' : 'matches '}row ${i + 1}: ${t}`)
      })
    }
  } catch (e) { graderFails.push(`grader unreadable: ${e.message}`) }
  assert.deepEqual(graderFails, [], graderFails.join(' · '))
})

// META proves this file's wiring to the shared empty-mustNotMatch guard. A wrapper that dropped
// the mustNotMatch passthrough would leave every case above unguarded.
const metaOut = { out: '{"systemMessage":"meta probe"}', exit: 0 }
vt('META', () => {
  const f = announceFailures(metaOut, ['meta probe'], [])
  assert.ok(f.length === 1 && /no mustNotMatch/i.test(f[0]), `guard did not fire — reason='${f.join('; ')}'`)
})
const metaExemption = 'META: exercises the visible-exemption path so the escape hatch cannot rot unnoticed'
vt('META exemption honored', () => {
  const f = announceFailures(metaOut, ['meta probe'], [], metaExemption)
  assert.deepEqual(f, [], 'noNegative exemption rejected')
})
vt('META', () => {
  const f = announceFailures(metaOut, ['meta probe'], [], metaExemption)
  assert.ok(!f.some(x => /no mustNotMatch/i.test(x)), 'noNegative exemption rejected')
})
