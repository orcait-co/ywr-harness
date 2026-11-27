// Self-test for session-start-version-announce.mjs (ADR 0030, ADR 0116).
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout hooks/session-start-version-announce.selftest.mjs
//
// The hook's whole verdict comes from three files it resolves itself — its own plugin.json and
// CHANGELOG.md relative to its own directory, and the state file under the env-derived home — so the
// suite runs a COPY of the hook (plus hook-lib.mjs, which it imports) inside fixture plugin trees
// (controlled versions and notes) with
// USERPROFILE/HOME redirected to a fixture home (the harness-statusline suite's hermetic-home
// technique; the hook reads the env vars directly for exactly this reason) and CLAUDE_CONFIG_DIR
// cleared (ADR 0136: the host's own value would otherwise redirect the state). Every match-based
// case carries MustNotMatch as well as MustMatch (the empty-MustNotMatch class), enforced by
// the shared assertion core.
//
// The announce-once contract is asserted from BOTH observables: the output (speaks exactly when
// stored < current) and the state file (seeded/updated on every path the table says, byte-equal
// to the version). Mutation CONFINEMENT is asserted at the end: after the full run the fixture
// home contains exactly one file — the state file. ADR 0030's user-scope write is bounded, and
// this is where that claim is proved rather than assumed.
//
// The pwsh suite changed the environment of its own process around each child. Here each child gets its
// own environment object, so the suite process never changes. The pwsh suite named most cases without IDs.
// Each test here is `VA<n> <the old name>`, so the parity check of ADR 0227 decision 8 matches the
// names. The old META cases print the names `META`, `META exemption honored` and `META`, so the tests are
// `VA<n> META`, `VA<n> META exemption honored` and `VA<n> META`. Cases R1 and G1
// keep their IDs. Patterns are pwsh -match sources (case-insensitive; see toRx in lib/selftest-lib.mjs).
//
// The pwsh suite held a state file open with .NET FileShare.Read for the Windows rename cases. Node opens
// every file with FileShare.Delete, so it cannot hold such a lock. The suite starts a Windows PowerShell
// child that holds the file, and it releases the child on its own signal.
//
// The seed fixture notes carry CRLF, as the pwsh here-string did (the pwsh sources are eol=crlf on every
// platform), so the CHANGELOG reader meets both line ends.
//
// Cases whose old name carries a run-specific part keep that part. The names of the config-dir == home
// cases carry the fixture path, which holds the process id. The drive-less cases carry a random GUID.
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
// The environment of a child: the host's USERPROFILE, HOME and CLAUDE_CONFIG_DIR never reach it (the names
// clear case-insensitively, as Windows reads them). home '' sets both home variables empty; cfg
// undefined or '' leaves CLAUDE_CONFIG_DIR unset.
function hookEnv({ home = fxHome, cfg, extra = {} } = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    const u = k.toUpperCase()
    if (u === 'USERPROFILE' || u === 'HOME' || u === 'CLAUDE_CONFIG_DIR') continue
    env[k] = v
  }
  // No home is two EMPTY variables, never two missing ones: on Windows a child that lacks USERPROFILE gets
  // the host's value back (measured with Node 24), so a deleted variable would hand the hook the real home.
  env.USERPROFILE = home
  env.HOME = home
  if (cfg !== undefined && cfg !== '') env.CLAUDE_CONFIG_DIR = cfg
  return Object.assign(env, extra)
}
// stdin as pwsh piped it: the text plus one newline. stdout and stderr together, as `2>&1` read them.
function invokeHook(stdin, hookPath, { home, cfg, cwd } = {}) {
  const r = spawnSync(process.execPath, [hookPath], { input: Buffer.from(stdin + '\n', 'utf8'), env: hookEnv({ home, cfg }), cwd, windowsHide: true })
  return { out: (r.stdout?.toString('utf8') ?? '') + (r.stderr?.toString('utf8') ?? ''), exit: r.status }
}
const newPayload = (fields = {}) => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'selftest', source: 'startup', cwd: 'C:\\anywhere', ...fields })

// --- assertions --------------------------------------------------------------------------------
// Envelope adapter (file-specific, per the assertion-core contract): announcement speech spans
// systemMessage + additionalContext, so both are matched joined. When additionalContext is
// present its hookEventName must be SessionStart, or the runtime drops it.
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
// Plain stdout on exit 0 becomes session context for this event, so "silent" must mean
// BYTE-silent — a stray warning line would be injected into every session's context.
function assertEmptyStdout({ out, exit }) {
  const fails = []
  if (exit !== 0) fails.push(`exit ${exit} (want 0 — fail-open contract)`)
  if (out.trim()) fails.push(`expected empty stdout, got: ${out.trim()}`)
  assert.deepEqual(fails, [], fails.join(' · '))
}

// --- fixtures --------------------------------------------------------------------------------
// Synthetic versions (2.4.0 -> 2.5.0), NOT the real plugin's: the suite must not need editing
// on every release. The 2.5.0 entry carries FOUR bullets — one wrapped across lines — so the
// visible cap (3 shown + "외 1건") and continuation-joining are both observable.
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
// A hand-edited manifest ConvertFrom-Json still read (comments, trailing comma): the announcement must
// not degrade to the "unreadable manifest" report for it (hook-lib parseJsonLoose, ADR 0116).
const hookLoose = newFixturePlugin('plug-loose', '{\n  // loaded version\n  "name": "ywr-harness", /* x */\n  "version": "2.5.0",\n}', notes)
// A NON-hyphenated suffix passes the gate's front-anchored version-shape check, and the first
// draft's \b-based section lookup missed exactly this heading (review 2026-08-05, low) — the
// lookup is token equality against the raw manifest string now, and this fixture pins it.
const notesRc = crlf([
  '# fixture 릴리스 노트',
  '',
  '## v2.5.0rc1 — 2026-08-05',
  '',
  '- 접미사 버전 항목이 조회됩니다.',
])
const hookRc = newFixturePlugin('plug-rc', '{"name":"ywr-harness","version":"2.5.0rc1"}', notesRc)
const hookOld = newFixturePlugin('plug-old', '{"name":"ywr-harness","version":"2.4.0"}', notes)

// 0. first run whose SEED CANNOT RECORD (a file squats on the state DIRECTORY path) ->
//    byte-silent: a welcome that cannot be recorded would repeat every session — the 0029
//    nag class — and it protects no news (ADR 0031's write-then-speak order, asserted).
vt('unseedable first run: silent', () => {
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(stateDirPath, 'squatter')
  try { assertEmptyStdout(invokeHook(newPayload(), hook)) } finally { fs.rmSync(stateDirPath, { force: true }) }
})

// 1. no state file (fresh install / feature first run) -> the LINK-ONLY WELCOME (ADR 0031):
//    true in both indistinguishable states, so no version arrow, no "업데이트됨", no bullets
//    — and the state seeds, so the machine hears it exactly once.
vt('fresh: link-only welcome', () => {
  assertAnnounce(invokeHook(newPayload(), hook),
    ['\\[hook:version-announce\\]', 'v2\\.5\\.0 적용 중', '첫 버전 안내',
      'artifact/a4387fdf-63d1-4a3d-9c8e-c362c9215a54#rn', 'Team 좌석 로그인', 'once per machine'],
    ['업데이트됨', '→', '첫 번째 변경', '외 \\d+건', '주요 변경'])
})
vt('fresh: state seeded to current', () => { assert.equal(getState(), '2.5.0', `state reads [${getState()}] (want 2.5.0)`) })

// 1b. the first-run seed is an EXCLUSIVE create (ADR 0081 arm, B low: two sessions starting
//     together both saw the path absent and both welcomed). A timing race between two child
//     processes could pass without the fix, so the REAL function is imported from the hook
//     module (the `?lib` query makes it define its functions and run nothing) and run against
//     a state file that already exists — the loser's exact position: it must refuse (false)
//     and leave the winner's bytes alone. The same call against an absent path is the
//     success path (case 1 covers it through the hook; this pins the bytes).
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

// 2. state == current -> the permanent steady state costs nothing
vt('same version: silent', () => { assertEmptyStdout(invokeHook(newPayload(), hook)) })

// 3. state < current -> THE announcement: version pair, first three bullets (the wrapped one
//    joined whole, the markdown one FLATTENED — systemMessage is plain text, so `code` and
//    **bold** markers must not reach the member; review 2026-08-05, medium), the visible
//    "외 1건" cap, the RN-tab link with its login qualifier — and the state file moves to
//    current so the re-fire goes silent.
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

// 3b. a NON-hyphenated version suffix ('2.5.0rc1') — the gate-passing shape the first
//     draft's \b lookup missed: the entry must be FOUND, bullets shown, raw version echoed
vt('suffixed version finds its entry', () => {
  setState('2.4.0')
  assertAnnounce(invokeHook(newPayload(), hookRc),
    ['v2\\.4\\.0 → v2\\.5\\.0rc1', '접미사 버전 항목이 조회됩니다'],
    ['외 \\d+건', '기록 실패', '첫 버전 안내', '적용 중'])
})

// 3c. a state file with a SECOND line (a tampered or hand-edited file) must not forge a hook line:
//     the stored value is echoed into systemMessage and additionalContext, so it goes through
//     inline() and no output line may start with the forged text.
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

// 4. BOM-prefixed stdin -> still parses (the config-change-audit 07-23 incident class)
vt('BOM-prefixed stdin', () => {
  setState('2.4.0')
  assertAnnounce(invokeHook(ch(0xFEFF) + newPayload(), hook), ['v2\\.4\\.0 → v2\\.5\\.0'], ['기록 실패'])
})

// 5. state > current (downgrade) -> silent re-seed: a downgrade is the member's own act, and
//    "업데이트됨" would be false (ADR 0030 decision table)
vt('downgrade: silent', () => { setState('9.9.9'); assertEmptyStdout(invokeHook(newPayload(), hook)) })
vt('downgrade: state re-seeded', () => { assert.equal(getState(), '2.5.0', `state reads [${getState()}] (want 2.5.0)`) })

// 6. garbage state -> not a version to announce from; silent re-seed
vt('garbage state: silent', () => { setState('not-a-version'); assertEmptyStdout(invokeHook(newPayload(), hook)) })
vt('garbage state: re-seeded', () => { assert.equal(getState(), '2.5.0', `state reads [${getState()}] (want 2.5.0)`) })

// 7. CHANGELOG missing entirely -> announce DEGRADED: link only, no bullets, no cap line.
//    The gate that enforces the entry runs in the canon, not on the member machine. This is
//    the update message whose SHAPE is closest to the welcome (both link-only), so the
//    distinguishability pin matters most here: it must still read as an UPDATE, never as a
//    first-run welcome (review 2026-08-05, medium — the pin was one-directional).
vt('missing CHANGELOG: link-only announcement', () => {
  setState('2.4.0')
  assertAnnounce(invokeHook(newPayload(), hookNoNotes),
    ['v2\\.4\\.0 → v2\\.5\\.0', '업데이트됨', 'artifact/a4387fdf-63d1-4a3d-9c8e-c362c9215a54#rn'],
    ['주요 변경', '외 \\d+건', '첫 번째 변경', '첫 버전 안내', '적용 중', 'once per machine'])
})

// 8. state write blocked -> announce ANYWAY with the visible may-repeat note (never a lost
//    announcement, never a silent repeat). Since O49 the write is a rename, and a POSIX rename
//    ignores the target file's mode — so off Windows the block is the state DIRECTORY
//    (chmod 555: neither the temp file nor the rename can land); on Windows the read-only
//    file makes File.Move throw. Root ignores permissions, so root SKIPs (reported).
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
// O49: the write is temp-file-then-rename; a failed rename must remove its temp file.
// Windows only: there the temp file lands and the Move onto the read-only target
// fails. Off Windows the 555 directory stops the temp write itself, so no temp file
// ever exists and the assert could not fail — case 8b covers the POSIX path.
vt('blocked write: no temp file left behind', () => {
  const left = blockedRun().tmpLeft
  assert.equal(left.length, 0, `left: ${left.join(', ')}`)
}, { skip: rootSkip || (isWin ? false : 'a 555 directory stops the temp write itself, so no temp file ever exists off Windows') })

// 8b. state PATH occupied by a directory -> byte-silent by the decision table's own
//     arithmetic (unreadable state -> re-seed; the re-seed write fails; a seed failure
//     protects no announcement) — asserted rather than assumed (review 2026-08-05, low),
//     and the directory must survive untouched.
const dirRun = memo(() => {
  fs.rmSync(stateFile, { force: true })
  fs.mkdirSync(stateFile, { recursive: true })
  const r = invokeHook(newPayload(), hook)
  return { r, isDir: fs.existsSync(stateFile) && fs.statSync(stateFile).isDirectory(), tmpLeft: tmpFilesIn(stateDirPath) }
})
vt('state path is a directory: silent', () => { assertEmptyStdout(dirRun().r) })
vt('state path directory untouched', () => { assert.ok(dirRun().isDir, 'the state path is no longer a directory — the hook replaced it') })
// O49 on EVERY platform: the temp file lands, the rename onto a directory fails, and the
// catch must remove the temp file (case 8's POSIX branch never reaches a failed rename).
vt('state path is a directory: failed rename leaves no temp file', () => {
  const left = dirRun().tmpLeft
  assert.equal(left.length, 0, `left: ${left.join(', ')}`)
  // restore a file at the state path for the confinement sweep below
  fs.rmSync(stateFile, { recursive: true, force: true })
  setState('2.5.0')
})

// 8c. O49: a corrupt interleaved state (`0.59.00.59.0`, two in-place writers) must NOT parse as
//     its leading triple. The old front-anchored regex read it as 0.59.0 (< current) and
//     announced a bogus update; the boundary lookahead makes it exists-but-unreadable, so it is
//     re-seeded silently. The current version here is the fixture plugin's (2.5.0).
vt('corrupt interleaved state: byte-silent', () => { setState('0.59.00.59.0'); assertEmptyStdout(invokeHook(newPayload(), hook)) })
vt('corrupt interleaved state: re-seeded to exactly the current version', () => { assert.equal(getState(), '2.5.0', `state reads [${getState()}] (want 2.5.0)`) })

// 8d. O49: after an announce the state dir holds ONLY the state file (the write-then-rename
//     temp file is gone) and its bytes are exactly the version — no BOM, no trailing newline.
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

// 8f. a temp file orphaned by a writer killed between write and rename is swept at the next
//     successful write once it is over an hour old; a fresh one (a live writer's) is kept.
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

// 8e. SMOKE check, NOT a mutation-proven guard: 8 hook processes race one stored older version
//     against the same fixture home. Afterwards the state must be exactly the current version
//     with no temp file left. Reverting writeState to the old in-place write did not turn
//     this red on the owner's box (2026-09-29 probe of the pwsh original) — the O49 interleave needs a timing this
//     cannot force — so it is kept for the cheap end-to-end run, not as proof of the fix.
// A child that collects both streams; its promise settles on close, and a 60 s hang guard kills it.
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

// 8g. R3 (Windows): a rename onto the state file fails while another handle holds it open without
//     FILE_SHARE_DELETE (a concurrent writer's rename, an antivirus scan). The hook retries those
//     codes (5 attempts, 10-50 ms apart), so a hold that ends inside the window still records the
//     state AND says nothing about a failed record; a hold that outlives the retries keeps the
//     visible may-repeat note and the old state. The hold opens BEFORE the hook starts, so the
//     rename's first attempt lands inside it. Other platforms rename over an open file: SKIP.
//     No case rests on wall-clock (O190: a 130 ms hold against 40-200 ms of retry sleeps failed a
//     tag CI). A preload wraps fs.renameSync for the state file only and logs each attempt. With
//     the handshake, the first failed attempt signals the suite and waits for its release marker; the
//     suite releases the hold first, so the retry after it lands. Without it the hold lasts until
//     the hook exits, so every retry fails. The 60 s bounds are hang guards, never a race window.
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

// 8h. "another writer landed it": when the rename keeps failing but the target already holds
//     EXACTLY the value being written, landState succeeds and removes its temp file; a target
//     holding anything else throws (the failure row). Called through the module's `?lib` import
//     with the target held open (FileShare.Read) for the whole call, so it is deterministic.
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
    if (c.held === '2.4.0') setState('2.5.0')   // the confinement sweep below wants the state file in place
    // The pwsh `-eq` ignored case, and the driver prints JavaScript booleans: 'false' stands for 'False'.
    assert.equal(r.toLowerCase(), c.want.toLowerCase(), `got [${r}]`)
  }, { skip: winSkip })
}

// 9. the hook's own plugin.json unreadable -> reported, never silent (a plugin that cannot
//    read its own manifest is broken; anti-vacuity posture), and announcements declared OFF
vt('broken own manifest is reported', () => {
  assertAnnounce(invokeHook(newPayload(), hookBroken), ['버전으로 읽을 수 없습니다', '버전 안내는 OFF'], ['업데이트됨', '주요 변경'])
})

// 9b. a manifest with comments and a trailing comma still reads: announces normally
vt('loose-JSON own manifest still announces', () => {
  setState('2.4.0')
  assertAnnounce(invokeHook(newPayload(), hookLoose), ['v2\\.4\\.0 → v2\\.5\\.0', '업데이트됨', '첫 번째 변경'], ['버전으로 읽을 수 없습니다', '기록 실패'])
})

// 10. wrong event name -> silent (defensive event guard, symmetric with siblings)
vt('wrong event silent', () => { assertEmptyStdout(invokeHook('{"hook_event_name":"SessionEnd","source":"startup"}', hook)) })

// 11. garbage stdin -> silent exit 0 (infra failure is not a finding)
vt('garbage stdin fail-open', () => { assertEmptyStdout(invokeHook('not json at all {{{', hook)) })

// 12. no resolvable home -> silent: announce-once is impossible without state, and a
//     per-session fallback is the nag class ADR 0029 rejected. The statusline still shows
//     the version, so the state is not invisible.
vt('no home: silent', () => { assertEmptyStdout(invokeHook(newPayload(), hook, { home: '' })) })

// 13. MUTATION CONFINEMENT, asserted not assumed: after every case above, the hook's entire
//     write surface — every path it constructs derives from <home>/.claude — contains EXACTLY
//     one file: the state file. ADR 0030's "bounded to this one file" claim is proved here;
//     any stray hook write turns this red. Scoped to .claude deliberately: the interpreter
//     may write its own cache under a redirected profile (the pwsh original's runtime wrote
//     AppData/.../StartupProfileData-NonInteractive — measured 2026-08-05), which is ambient
//     host noise, not a hook write.
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
// sweep after the block can still prove the hook wrote nothing there it should not have.
const invokeHookCfg = (cfg, hookPath, o = {}) => invokeHook(newPayload(), hookPath, { ...o, cfg })

// 14a. CLAUDE_CONFIG_DIR absolute -> the state lives under it, NOT under <home>/.claude: the
//      first run seeds the config dir, the next older-state run announces there, and the
//      home-based file stays absent throughout.
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

// 14b. CLAUDE_CONFIG_DIR set but RELATIVE -> unmeasured: byte-silent, nothing written anywhere.
//      A fall-back to <home>/.claude would read the other account's state (here a home state
//      older than current, which would announce and rewrite), and honoring the value would write
//      under the spawn cwd — so the home state must be untouched and the cwd must stay empty.
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

// 14b2. a whitespace-only value trims to empty, i.e. UNSET (the statusline claudeDir() rule): the
//       home-based state is used, exactly as before.
vt('whitespace-only config dir counts as unset', () => {
  setState('2.4.0')
  assertAnnounce(invokeHookCfg('   ', hook), ['v2\\.4\\.0 → v2\\.5\\.0'], ['기록 실패'])
})
vt('whitespace-only config dir: the home state advanced', () => { assert.equal(getState(), '2.5.0', `home state reads [${getState()}] (want 2.5.0)`) })

// 14c. LEGACY ADOPTION: the pre-0136 shared file at <home>/.claude/ywr-harness/announced-version
//      stands in for an ABSENT config-dir state, read-only. Every row ends with the config-dir
//      file holding the CURRENT version, and the legacy file is never written or deleted.
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

// 14d. THE ALTERNATION (the defect): dir A runs the newer plugin, dir B the older, one machine.
//      Pre-0136 they shared a state file: B's downgrade row re-seeded the older version and A then
//      re-announced it, every alternation. Now only A's first session may speak.
//      (i) a legacy file older than both.
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
//      (ii) no legacy file: each dir welcomes ONCE, then both stay silent.
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
//      (iii) the downgrade-by-the-other-account row: the newer dir's state must survive the older
//      dir's sessions (it used to be overwritten by them).
vt('alternation (no legacy): the newer dir keeps 2.5.0 after the older dir ran', () => {
  assert.ok(getStateAt(dirA2) === '2.5.0' && getStateAt(dirB2) === '2.4.0', `A [${getStateAt(dirA2)}], B [${getStateAt(dirB2)}]`)
})

// 14e. CLAUDE_CONFIG_DIR pointing at <home>/.claude ITSELF behaves exactly as unset: the state is
//      the one file (no legacy double read, no second file), in the plain, trailing-separator and
//      absent-state shapes.
const selfDir = path.join(fxHome, '.claude')
for (const cfgSelf of [selfDir, selfDir + path.sep]) {
  // A case name holds the shape, never the fixture path: the path carries the process id, and a name must be
  // the same in every run. A failure message names the path.
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

// 14g. a DRIVE-LESS ROOT on Windows (`\x`, `/x`) passes path.isAbsolute but follows the drive of the
//      spawn cwd — the per-cwd split ADR 0136 rules out — so it is byte-silent like a relative value
//      and writes nothing (not under the drive root, not under <home>/.claude). `C:x` (drive-relative)
//      is silent too. Windows only: on Linux `/x` is a real absolute path, and the row must not
//      write to `/` — so off Windows it is skipped, reported.
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
      // only what a faulty hook could have created under the unique name
      if (fs.existsSync(strayRoot)) fs.rmSync(strayRoot, { recursive: true, force: true })
    }
  })
  const skip = isWin ? false : 'a drive-less root is only non-absolute on Windows'
  // The name holds the shape; the unique folder name is random, so only a failure message names it.
  const shape = tag === 'bs' ? '\\x' : tag === 'fs' ? '/x' : '<drive>:x'
  vt(`drive-less/drive-relative config dir '${shape}': byte-silent`, () => { assertEmptyStdout(run().r) }, { skip })
  vt(`drive-less/drive-relative config dir '${shape}': nothing written at the drive root or cwd`, () => {
    assert.ok(!run().stray, `stray path exists: ${strayRoot} / ${path.join(cwdRoot, uniq)} for ${rootedCfg}`)
  }, { skip })
  vt(`drive-less/drive-relative config dir '${shape}': home state untouched`, () => {
    assert.equal(run().state, '2.4.0', `home state reads [${run().state}] (want 2.4.0) for ${rootedCfg}`)
  }, { skip })
}

// 14h. ADOPTION GUARD, negative branch: a config-dir state that EXISTS but is unreadable must NOT
//      adopt the legacy file (the `!stateExists` clause) — adopting would announce from a stale
//      legacy version about a machine that already has config-dir state. A parseable legacy 2.4.0
//      sits in <home>/.claude throughout (adoption would announce v2.4.0 -> v2.5.0).
//      (i) a corrupt interleaved value -> the existing row: silent re-seed with the current version.
const cfgNegCorrupt = path.join(fx, 'cfg-neg-corrupt')
const negCorruptRun = memo(() => { setState('2.4.0'); setStateAt(cfgNegCorrupt, '0.59.00.59.0'); return invokeHookCfg(cfgNegCorrupt, hook) })
vt('adoption guard: unreadable (corrupt) config-dir state does not adopt the legacy file', () => { assertEmptyStdout(negCorruptRun()) })
vt('adoption guard: corrupt config-dir state re-seeded to current', () => {
  negCorruptRun()
  assert.equal(getStateAt(cfgNegCorrupt), '2.5.0', `config state reads [${getStateAt(cfgNegCorrupt)}] (want 2.5.0)`)
})
vt('adoption guard: corrupt case leaves the legacy file untouched', () => { assert.equal(getState(), '2.4.0', `legacy reads [${getState()}] (want 2.4.0)`) })
//      (ii) a DIRECTORY squatting on the state path -> silent (the failed re-seed protects no news),
//      nothing announced, the directory survives.
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

// 14i. CLAUDE_CONFIG_DIR absolute with NO home (USERPROFILE and HOME both empty): the config dir
//      needs no home, so the hook still works for it — welcome, then announce on an older state —
//      and adoption is skipped (the legacy path needs a home) without error. A parseable legacy
//      2.4.0 sits in the fixture home, which the hook cannot see: adoption would announce instead
//      of welcoming.
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
  setState('2.5.0')   // the confinement sweep below wants the state file in place
})

// 14f. CONFINEMENT after the config-dir cases: <home>/.claude still holds only the state file, and
//      every file the hook wrote under a fixture config dir is an announced-version (no *.tmp).
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

// R1. REGISTRATION. Every case above runs a copy of the script directly, so none sees whether the
//     runtime ever calls it. The hook is registered WITHOUT a matcher on purpose (the state file is
//     the filter — re-fires at the same version are silent), so a matcher added later would make it
//     skip sources. Pins: exactly one registration, event SessionStart, no matcher, exec-form
//     `node <script>` resolving to this suite's script (ADR 0116).
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

// G1 — the eval grader that reads this hook's announcement (spec 0014 §4.2, fact 119). The runner
// evaluates `pattern` as a JavaScript regex, and so does this suite, in process: .NET reads a variable
// lookbehind differently. A with-arm answer names the version in either order, "Claude Code" earlier in
// the sentence included; a no-plugin answer that names only a Claude Code version must never pass, or
// the case's delta silently shrinks. Distance alone cannot tell them apart (slice 104 review): the
// version-first branch blocks the direct "Claude Code [version] [v]N" form and a clause break or
// negation between the version and the name.
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

// META — proves this file's WIRING to the shared empty-MustNotMatch guard: a wrapper that
// dropped the mustNotMatch passthrough would leave the core intact and every case above unguarded.
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
