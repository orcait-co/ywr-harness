// SessionStart (registered WITHOUT a matcher — the state file is the filter: re-fires on
// resume/clear/compact/fork at the same version are byte-silent) — version-change announcement,
// announce-once-per-version (ADR 0030).
//
// ADR 0026 made updates land silently; ADR 0027's statusline segment shows THAT the version
// moved but not WHAT changed. This hook completes the pair: at the first session that actually
// RUNS a new version, it says so once — old → new, up to three bullets from the member
// release-notes canon (../CHANGELOG.md), and the onboarding artifact's release-notes tab — then
// records the version in a one-line user-scope state file and never speaks again for it.
//
// The version compared is the LOADED one (this script's own ../.claude-plugin/plugin.json), not
// the possibly-ahead on-disk install — disk-ahead-of-session is ADR 0027's statusline story, and
// announcing notes for code that is not running yet would be false.
//
// State: <home>/.claude/ywr-harness/announced-version. <home> is USERPROFILE then HOME — the
// os.homedir() semantics the statusline script uses, and env-derived deliberately so a child
// process with a redirected home is a hermetic selftest fixture (the statusline suite documents
// the same reason). This is the plugin's FIRST user-scope write; it is bounded to this one file
// and the selftest asserts the confinement. Announce-once is impossible without state, and a
// stateless per-session notice is the nag class ADR 0029 already rejected.
//
// systemMessage is KOREAN — since ADR 0045 this is the plugin-wide rule, not a per-hook
// divergence: every hook's systemMessage is Korean (the member reader), every additionalContext
// stays English (the model reader). This hook was simply first (ADR 0030); the sibling hooks now
// carry the same split.
//
// Decision table (ADR 0030, absent-state row amended by ADR 0031): own manifest unreadable ->
// reported (a plugin that cannot read its own manifest is broken — visible, never silent). No
// resolvable home -> silent (announce-once needs state; a per-session fallback is the rejected
// nag; the statusline still shows the version). State path truly ABSENT -> first run: seed, and
// when the seed actually recorded, a LINK-ONLY welcome (no bullets, no version arrow, never
// "업데이트됨" — the message must be true for a fresh install AND the mechanism's first arrival,
// which is the whole 0031 point); a failed seed stays byte-silent — a welcome that cannot be
// recorded would repeat every session (the 0029 nag class) while carrying no news the dist
// README lacks. State exists-but-unreadable / newer-than-current -> (re)seed silently ("first
// run" would be a guess; a downgrade is the member's own act). State == current -> silent.
// State < current -> announce, then write; a failed write announces anyway with a visible
// may-repeat note. Non-speaking paths are BYTE-silent because plain stdout on exit 0 becomes
// session context. Exit 0 always — SessionStart cannot block anything and this hook does not try.
//
// Node port (ADR 0116) of the pwsh original; the shared helpers are hook-lib.mjs's. The hook never
// exits the process: it returns, so stdout drains and the exit code stays 0.
// Deliberate differences from the pwsh original (spec 0006 §3.1): the manifest and the payload must
// be JSON OBJECTS (the original also read a one-element array by member enumeration; the manifest
// parses as leniently as ConvertFrom-Json did, via hook-lib's parseJsonLoose); a version
// component over Int32 is an unparseable version, as the original's failed [version] cast was (which
// also wrote an error record to stderr there); the shown state path joins with psJoin() below,
// which keeps Join-Path's string shape (`..` segments stay as typed) rather than path.join's.
//
// The module is importable: with a `?lib` query on its URL (the selftest's seed-exclusivity case) it
// defines its functions and runs nothing. A production load never carries a query, so a misfire
// cannot silence the hook — the gate fails toward running it.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readStdin, parseJson, parseJsonLoose, isObject, getProp, psString, ieq, netTrim, emit, sleep } from './hook-lib.mjs'

// One link, two shipped surfaces: this constant and the CHANGELOG header. manifest-gate.ps1
// asserts the two agree, so neither can drift alone.
const rnUrl = 'https://claude.ai/code/artifact/a4387fdf-63d1-4a3d-9c8e-c362c9215a54#rn'

const hooksDir = path.dirname(fileURLToPath(import.meta.url))
const INT_MAX = 2147483647   // .NET [version] components are Int32; a larger one fails the cast

/** PowerShell Join-Path's string shape: no doubled separator at the join, `/` becomes `\` on Windows, dot segments and the rest stay as typed. */
function psJoin(parent, child) {
  const c = child.replace(/^[\\/]+/, '')
  const joined = /[\\/]$/.test(parent) ? parent + c : parent + path.sep + c
  return path.sep === '\\' ? joined.replace(/\//g, '\\') : joined
}

/** A .NET space (Char.IsWhiteSpace) — the class of regex `\s`/`\S` in the pwsh original. */
function isWs(ch) { return netTrim(ch) === '' }

/** `[version]` of a x.y.z triple as [major, minor, build], or null when the cast would fail (a component over Int32). */
function toVersion(a, b, c) {
  const v = [a, b, c].map(s => (s.length > 10 ? Infinity : Number(s)))
  return v.some(n => n > INT_MAX) ? null : v
}
function cmpVersion(x, y) {
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

/** Get-Content -Raw / -Encoding utf8: the text, one leading BOM consumed; null when unreadable. */
function readText(file) {
  try {
    const s = fs.readFileSync(file, 'utf8')
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
  } catch { return null }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

/**
 * The first-run seed is an EXCLUSIVE create (flag `wx`), not writeState's overwrite: two sessions
 * starting together both see the path absent, and with a check-then-write each would seed and each
 * would welcome (ADR 0081 measurement arm, B low). `wx` lets exactly one win; the loser gets EEXIST,
 * returns false and stays byte-silent — the existing "a failed seed is silent" row, so no new
 * behavior is needed for it. UTF-8 without BOM.
 */
export function newStateExclusive(stateDir, stateFile, value) {
  try {
    if (!isDir(stateDir)) fs.mkdirSync(stateDir, { recursive: true })
    const fd = fs.openSync(stateFile, 'wx')
    // Closed in a guarded finally: a close that threw after a completed write would otherwise report
    // a recorded seed as failed and silence the one welcome this machine gets (review 2026-09-26, low).
    try { fs.writeSync(fd, Buffer.from(value, 'utf8')) } finally { try { fs.closeSync(fd) } catch { /* the bytes landed */ } }
    return true
  } catch { return false }
}

/**
 * The rename that lands a state write. On Windows a rename onto the target fails (EPERM / EACCES /
 * EBUSY) while a concurrent writer's rename or an antivirus scan holds the target open, and that is
 * transient, so those codes alone are retried — up to 5 attempts, 10-50 ms apart. After the last
 * failure, a target that now holds EXACTLY the value being written means another writer landed it:
 * that is success (the temp file is removed), not a "could not record" note on an announcement whose
 * state is in fact correct. Any other failure, or a target holding something else (a read-only file,
 * a directory squatting on the path), throws into writeState's failure row.
 */
export function landState(tmp, stateFile, value) {
  for (let attempt = 1; ; attempt++) {
    try { fs.renameSync(tmp, stateFile); return } catch (e) {
      if (!e || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e
      if (attempt >= 5) {
        if (readText(stateFile) !== value) throw e
        try { fs.unlinkSync(tmp) } catch { /* the sweep takes it later */ }
        return
      }
      sleep(10 + Math.floor(Math.random() * 41))
    }
  }
}

/**
 * Write-then-rename, never an in-place overwrite: concurrent session starts (O49, 2026-09-29)
 * left `0.59.00.59.0` from two in-place writers, and a reader could also catch the file between
 * truncate and write. Each writer fills its own temp file and the rename swaps it in, so a reader
 * sees the old value or a whole new one. A losing rename (the target held open, read-only, or a
 * directory) is a failed write — the existing may-repeat row — and its temp file is removed.
 */
function writeState(stateDir, stateFile, value) {
  let tmp = null
  try {
    if (!isDir(stateDir)) fs.mkdirSync(stateDir, { recursive: true })
    tmp = psJoin(stateDir, `announced-version.${crypto.randomBytes(16).toString('hex')}.tmp`)
    fs.writeFileSync(tmp, value, 'utf8')
    landState(tmp, stateFile, value)
    tmp = null
    // A writer killed between the two calls above leaves its temp file behind. Sweep those
    // older than an hour (a live writer's is milliseconds old); a sweep failure never fails
    // the write that already landed.
    try {
      const cutoff = Date.now() - 3600 * 1000
      for (const ent of fs.readdirSync(stateDir, { withFileTypes: true })) {
        const n = ent.name.toLowerCase()
        if (!ent.isFile() || n.length < 'announced-version..tmp'.length || !n.startsWith('announced-version.') || !n.endsWith('.tmp')) continue
        try {
          const f = psJoin(stateDir, ent.name)
          if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f)
        } catch { /* a sweep miss is not a failed write */ }
      }
    } catch { /* ditto */ }
    return true
  } catch {
    if (tmp) { try { fs.unlinkSync(tmp) } catch { /* nothing left to remove */ } }
    return false
  }
}

/** Test-Path semantics for the state path: absent only on ENOENT/ENOTDIR; any other probe error counts as "exists" (when in doubt, do not welcome). */
function stateExistsAt(file) {
  try { fs.statSync(file); return true } catch (e) { return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) }
}

/**
 * The CHANGELOG bullets of the entry whose heading names the loaded version. Continuation lines are
 * joined so a wrapped bullet reads whole. Line classes are .NET's (`\s` = Char.IsWhiteSpace) and `.`
 * is "anything but LF", as in the original's regexes.
 */
function changelogBullets(currentRaw, currentStr) {
  const bullets = []
  const text = readText(path.join(hooksDir, '..', 'CHANGELOG.md'))
  if (text === null) return bullets
  let inSection = false
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.startsWith('##') && line.length > 2 && isWs(line[2])) {   // ^##\s
      if (inSection) break
      // Token EQUALITY against the raw manifest version first — the same comparison the
      // gate enforces — with the numeric triple as fallback. The first draft matched
      // '^## v<triple>\b', and \b needs a word/non-word transition: a non-hyphenated
      // suffix ('0.18.0rc1') passed the gate yet failed the lookup, degrading the
      // announcement to bullet-less for an entry that exists (review 2026-08-05, low).
      let i = 2
      while (i < line.length && isWs(line[i])) i++
      if (i < line.length && (line[i] === 'v' || line[i] === 'V')) {   // ^##\s+v(\S+)
        let j = ++i
        while (j < line.length && !isWs(line[j])) j++
        if (j > i) { const tok = line.slice(i, j); inSection = ieq(tok, currentRaw) || ieq(tok, currentStr) }
      }
      continue
    }
    if (!inSection) continue
    if (line.startsWith('- ') && line.length > 2) bullets.push(netTrim(line.slice(2)))        // ^- (.+)$
    else if (bullets.length && isWs(line[0] ?? 'x')) {                                           // ^\s+(\S.*)$
      let k = 0
      while (k < line.length && isWs(line[k])) k++
      if (k < line.length) bullets[bullets.length - 1] += ' ' + netTrim(line.slice(k))
    }
  }
  return bullets
}

function main(payload) {
  if (!ieq(psString(getProp(payload, 'hook_event_name')), 'SessionStart')) return

  // --- own version (the loaded one) -------------------------------------------------------------
  let currentRaw = ''
  const mtext = readText(path.join(hooksDir, '..', '.claude-plugin', 'plugin.json'))
  let manifest = null
  try { if (mtext !== null) manifest = parseJsonLoose(mtext) } catch { /* unreadable manifest: reported below */ }
  if (isObject(manifest)) currentRaw = netTrim(psString(getProp(manifest, 'version')))
  // The numeric triple is what gets compared; the raw string is what gets displayed and stored.
  // manifest-gate anchors only the FRONT of the version shape, so a suffix must not break this.
  let current = null
  const cm = /^([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(currentRaw)
  if (cm) current = toVersion(cm[1], cm[2], cm[3])
  if (!current) {
    return emit({ systemMessage: `[hook:version-announce] 이 플러그인 자체의 .claude-plugin/plugin.json을 버전으로 읽을 수 없습니다 (받은 값: '${currentRaw}') — ${path.dirname(hooksDir)} 의 설치가 손상되었습니다; 버전 안내는 OFF이며 확인되지 않았습니다.` })
  }
  const currentStr = current.join('.')

  // --- state ------------------------------------------------------------------------------------
  let homeDir = process.env.USERPROFILE || ''
  if (!homeDir) homeDir = process.env.HOME || ''
  if (!homeDir) return
  const stateDir = psJoin(psJoin(homeDir, '.claude'), 'ywr-harness')
  const stateFile = psJoin(stateDir, 'announced-version')

  // ABSENT is a first run; anything else keeps its ADR 0030 behavior (0031 amends only that row).
  // A DIRECTORY squatting on the path counts as "exists" — welcoming a squatted path would guess
  // "first run" about a machine that already ran. A probe error also counts as "exists".
  const stateExists = stateExistsAt(stateFile)
  const storedRaw = netTrim(readText(stateFile) ?? '')
  let stored = null
  // The triple must END at a non-digit, non-dot boundary: `0.59.00.59.0` (O49's interleaved write)
  // parsed as 0.59.0 before, so a corrupt value could re-announce or suppress a version. It now
  // reads as exists-but-unreadable and is re-seeded silently; a suffix (`0.18.0rc1`) still parses.
  const sm = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?![0-9.])/i.exec(storedRaw)
  if (sm) stored = toVersion(sm[1], sm[2], sm[3])

  if (!stored && !stateExists) {
    // First run on this machine — fresh install, or the first version carrying this mechanism;
    // indistinguishable, and the message below is TRUE in both states (ADR 0031). Write-then-
    // speak, inverted from the update path on purpose: the update announcement protects news,
    // this protects nothing the dist README does not already carry, so a failed seed is silent
    // — and a seed lost to a concurrent first run is a failed seed (newStateExclusive).
    if (newStateExclusive(stateDir, stateFile, currentRaw)) {
      const sys = `[hook:version-announce] ywr-harness v${currentRaw} 적용 중 — 이 머신의 첫 버전 안내입니다(설치 직후이거나, 안내 기능이 이번 버전에서 처음 도착했습니다). 변경 이력: 플러그인의 CHANGELOG.md · 릴리스 노트 탭(가이드 개정 시 갱신) ${rnUrl} (claude.ai Team 좌석 로그인 필요)`
      const ctx = `The ywr-harness plugin v${currentRaw} is active, and this is its first recorded run on this machine — fresh install, or the first version carrying the announce mechanism (ADR 0031). Release notes: the plugin's CHANGELOG.md (Korean, newest-first — every entry lands here first) and the artifact release-notes tab at ${rnUrl} (refreshed only when the onboarding guide itself changes, so it may lag CHANGELOG.md — ADR 0078). This welcome appears once per machine; do not repeat it unprompted.`
      emit({ systemMessage: sys, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } })
    }
    return
  }
  if (!stored || cmpVersion(stored, current) > 0) {
    // Exists-but-unreadable state, or a downgrade: (re)seed and say nothing (ADR 0030 rows,
    // unchanged) — the next session simply retries.
    writeState(stateDir, stateFile, currentRaw)
    return
  }
  if (cmpVersion(stored, current) === 0) return

  // --- stored < current: the announcement -------------------------------------------------------
  // Bullets for the CURRENT version from the member canon. The cap is VISIBLE (외 N건) — a silent
  // truncation would read as "that was everything" (the no-silent-caps house rule).
  const bullets = changelogBullets(currentRaw, currentStr)

  // systemMessage is a plain-text surface, not a Markdown renderer: the two inline forms the
  // canon actually uses — `code` and **bold** — are stripped for display, or the member reads
  // literal backticks and asterisks (review 2026-08-05, medium). The CHANGELOG itself stays
  // Markdown; only this rendering flattens it.
  const shown = bullets.slice(0, 3).map(b => b.replace(/\*\*([^\n]+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1'))
  const more = bullets.length - shown.length
  let body = `[hook:version-announce] ywr-harness v${storedRaw} → v${currentRaw} 업데이트됨 (자동 업데이트).`
  if (shown.length) {
    body += ' 주요 변경:\n' + shown.map(b => `  • ${b}`).join('\n')
    if (more > 0) body += `\n  • …외 ${more}건 — 전체는 플러그인의 CHANGELOG.md 에서.`
    body += '\n'
  } else {
    body += ' '
  }
  body += `릴리스 노트 탭(가이드 개정 시 갱신 — 이 버전 항목은 CHANGELOG.md 에 먼저 실립니다): ${rnUrl} (claude.ai Team 좌석 로그인 필요)`

  if (!writeState(stateDir, stateFile, currentRaw)) {
    body += `\n(안내 기록 실패: ${stateFile} 에 쓸 수 없어 이 안내가 반복될 수 있습니다 — ~/.claude 권한을 확인하세요.)`
  }

  const ctx = `The ywr-harness plugin loaded in this session is v${currentRaw}; the last version announced on this machine was v${storedRaw} (marketplace auto-update, ADR 0026 — updates land at session start, never mid-session). Member release notes: the plugin's CHANGELOG.md (Korean, newest-first — every entry lands here first) and the onboarding artifact's release-notes tab at ${rnUrl} (refreshed only when the onboarding guide itself changes, so it may lag CHANGELOG.md — ADR 0078). If the user asks what changed, read the CHANGELOG entry for v${currentRaw} rather than answering from memory. This announcement is once-per-version (ADR 0030); do not repeat it unprompted.`
  emit({ systemMessage: body, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } })
}

if (!import.meta.url.includes('?')) {
  try {
    const payload = parseJson(readStdin())
    if (isObject(payload)) main(payload)
  } catch { /* fail-open: a hook defect is never a blocked session */ }
}
