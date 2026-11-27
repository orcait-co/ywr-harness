// SessionStart version-change announcement, once per version (ywr-harness ADR 0030). It registers
// WITHOUT a matcher: the state file is the filter, so re-fires on resume, clear, compact and fork
// at the same version are byte-silent.
//
// At the first session that RUNS a new version it speaks once: old -> new, up to three bullets from
// the member release notes (../CHANGELOG.md), and the release-notes tab link. Then it records the
// version in a one-line user-scope state file. The compared version is the LOADED one (this
// script's own ../.claude-plugin/plugin.json), never a possibly-ahead on-disk install, because
// announcing notes for code that is not running yet would be false (ywr-harness ADR 0027).
//
// State: <config dir>/ywr-harness/announced-version, per Claude Code config dir (ywr-harness ADR 0136).
// The config dir is CLAUDE_CONFIG_DIR when set, non-empty after trim and ABSOLUTE, else <home>/.claude
// (ywr-harness ADR 0046). On win32 "absolute" needs a drive or UNC prefix, so a drive-less root like
// \cfg counts as relative. A set-but-relative value is unmeasured: the hook is byte-silent and writes
// nothing. A relative path would follow the spawn cwd, and a fall-back to ~/.claude would read the
// OTHER account's state. Two config dirs on different plugin versions must not share one state file,
// or each re-announces the other's version.
// <home> is USERPROFILE then HOME, env-derived on purpose so a child process with a redirected home
// is a hermetic selftest fixture. The hook writes only this one file in user scope, and the selftest
// asserts the confinement. A stateless per-session notice is the nag class that ywr-harness ADR 0029 rejects.
//
// Legacy adoption (ywr-harness ADR 0136), once per config dir and read-only on the old file: an older
// version wrote <home>/.claude/ywr-harness/announced-version. Adoption needs CLAUDE_CONFIG_DIR in
// effect, an ABSENT config-dir state, and a legacy file at a DIFFERENT path (compared resolved,
// case-insensitive on win32) holding a parseable version. That version is then the stored value for
// the rows below, and the config-dir file ends up holding the current version. The legacy file is
// never written or deleted. With no legacy value, the ordinary first-run row applies.
//
// systemMessage is Korean (the member reader) and additionalContext is English (the model reader),
// the plugin-wide split (ywr-harness ADR 0045).
//
// Decision table (ywr-harness ADR 0030, absent-state row amended by ywr-harness ADR 0031):
// - Own manifest unreadable: reported, never silent. A plugin that cannot read its own manifest is broken.
// - No resolvable config dir (a relative CLAUDE_CONFIG_DIR, or unset with no resolvable home): silent.
//   Announce-once needs state, and a per-session fallback is the rejected nag.
// - State path ABSENT: first run. Seed, and when the seed recorded, send a LINK-ONLY welcome with no
//   bullets, no version arrow and never "업데이트됨", so it is true for a fresh install and for the
//   mechanism's first arrival (ywr-harness ADR 0031). A failed seed stays byte-silent, because a welcome that
//   cannot be recorded would repeat every session (ywr-harness ADR 0029).
// - State exists but is unreadable, or is newer than current: (re)seed silently. "First run" would be
//   a guess, and a downgrade is the member's own act.
// - State == current: silent.
// - State < current: announce, then write. A failed write announces anyway with a visible may-repeat note.
// An adopted legacy value takes the same rows: equal or newer writes the config-dir file silently,
// older announces "vLEGACY -> vCURRENT". Non-speaking paths are BYTE-silent, because plain stdout on
// exit 0 becomes session context. The hook exits 0 always, and it never exits the process: it
// returns, so stdout drains.
//
// The manifest and the payload must be JSON OBJECTS. The manifest parses leniently through hook-lib's
// parseJsonLoose. A version component over Int32 is an unparseable version. The shown state path
// joins with hook-lib's psJoin(), which keeps `..` segments as typed (ywr-harness spec 0006 §3.1).
//
// The module is importable: with a `?lib` query on its URL (the selftest's seed-exclusivity case) it
// defines its functions and runs nothing. A production load never carries a query, so a misfire
// cannot silence the hook: the gate fails toward running it.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readStdin, parseJson, parseJsonLoose, isObject, getProp, psString, ieq, netTrim, emit, sleep, psJoin, inline } from './hook-lib.mjs'

// One link, two shipped surfaces: this constant and the CHANGELOG header. manifest-gate.mjs
// asserts the two agree, so neither can drift alone.
const rnUrl = 'https://claude.ai/code/artifact/a4387fdf-63d1-4a3d-9c8e-c362c9215a54#rn'

const hooksDir = path.dirname(fileURLToPath(import.meta.url))
const INT_MAX = 2147483647   // a version component over Int32 is unparseable

/** A .NET space (Char.IsWhiteSpace), the class that `\s` names in this file's line patterns. */
function isWs(ch) { return netTrim(ch) === '' }

/** An x.y.z triple as [major, minor, build], or null when a component is over Int32. */
function toVersion(a, b, c) {
  const v = [a, b, c].map(s => (s.length > 10 ? Infinity : Number(s)))
  return v.some(n => n > INT_MAX) ? null : v
}
function cmpVersion(x, y) {
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

/** The file's text with one leading BOM consumed; null when unreadable. */
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
 * The first-run seed is an EXCLUSIVE create (flag `wx`), not writeState's overwrite. Two sessions
 * starting together both see the path absent, and a check-then-write would seed and welcome twice.
 * `wx` lets exactly one win. The loser gets EEXIST, returns false and stays byte-silent, which is
 * the "a failed seed is silent" row. UTF-8 without BOM.
 */
export function newStateExclusive(stateDir, stateFile, value) {
  try {
    if (!isDir(stateDir)) fs.mkdirSync(stateDir, { recursive: true })
    const fd = fs.openSync(stateFile, 'wx')
    // Closed in a guarded finally: a close that threw after a completed write would report a
    // recorded seed as failed and silence the one welcome this machine gets.
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
 * Write-then-rename, never an in-place overwrite: two session starts can write at once, and
 * in-place writers interleave their bytes (`0.59.00.59.0`). A reader could also catch the file
 * between truncate and write. Each writer fills its own temp file and the rename swaps it in, so a
 * reader sees the old value or a whole new one. A losing rename (the target held open, read-only, or
 * a directory) is a failed write, the may-repeat row, and its temp file is removed.
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

/** The state path is absent only on ENOENT/ENOTDIR. Any other probe error counts as "exists", because when in doubt the hook does not welcome. */
function stateExistsAt(file) {
  try { fs.statSync(file); return true } catch (e) { return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) }
}

/**
 * The triple of a stored version string, or null. It must END at a non-digit, non-dot boundary.
 * An interleaved write such as `0.59.00.59.0` reads as exists-but-unreadable and is re-seeded
 * silently, so a corrupt value cannot re-announce or suppress a version. A suffix (`0.18.0rc1`) still parses.
 */
function parseStored(raw) {
  const sm = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?![0-9.])/i.exec(raw)
  return sm ? toVersion(sm[1], sm[2], sm[3]) : null
}

/**
 * ABSOLUTE for CLAUDE_CONFIG_DIR (ywr-harness ADR 0136). On win32 `path.isAbsolute` also accepts a drive-less root
 * (`\cfg`, `/cfg`), which follows the drive of the spawn cwd, a per-cwd split that ywr-harness ADR 0136 rules out.
 * So there only a drive prefix (`C:\` or `C:/`) or a UNC prefix (two leading separators) counts.
 * Anything else is treated like a relative value: byte-silent. Elsewhere `path.isAbsolute` is exact.
 */
function isAbsoluteConfigDir(p) {
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)
  return path.isAbsolute(p)
}

/** Whether two paths name the same file textually once resolved (case-insensitive on win32; no symlink chase). */
function samePath(a, b) {
  const x = path.resolve(a), y = path.resolve(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * The CHANGELOG bullets of the entry whose heading names the loaded version. Continuation lines are
 * joined so a wrapped bullet reads whole. Line classes are .NET's (`\s` = Char.IsWhiteSpace) and `.`
 * is "anything but LF".
 */
function changelogBullets(currentRaw, currentStr) {
  const bullets = []
  const text = readText(path.join(hooksDir, '..', 'CHANGELOG.md'))
  if (text === null) return bullets
  let inSection = false
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.startsWith('##') && line.length > 2 && isWs(line[2])) {   // ^##\s
      if (inSection) break
      // Token EQUALITY against the raw manifest version first, the comparison the gate enforces,
      // with the numeric triple as fallback. A `\b` match on the triple would miss a non-hyphenated
      // suffix ('0.18.0rc1') that the gate accepts, and the announcement would lose its bullets.
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
    return emit({ systemMessage: `[hook:version-announce] 이 플러그인 자체의 .claude-plugin/plugin.json을 버전으로 읽을 수 없습니다 (받은 값: '${inline(currentRaw)}') — ${inline(path.dirname(hooksDir), 300)} 의 설치가 손상되었습니다; 버전 안내는 OFF이며 확인되지 않았습니다.` })
  }
  const currentStr = current.join('.')
  // Every value read from disk or env reaches a message through inline(): a state file with a second
  // line must not start a line of hook output. The raw strings stay for the state write.
  const curShown = inline(currentRaw)

  // --- state ------------------------------------------------------------------------------------
  let homeDir = process.env.USERPROFILE || ''
  if (!homeDir) homeDir = process.env.HOME || ''
  // The config dir (ywr-harness ADR 0136, ywr-harness ADR 0046): CLAUDE_CONFIG_DIR only when ABSOLUTE. Set-but-relative
  // is unmeasured and silent, never a fall-back to <home>/.claude (the other account's state).
  const cfgRaw = netTrim(process.env.CLAUDE_CONFIG_DIR || '')
  let configDir
  if (cfgRaw) {
    if (!isAbsoluteConfigDir(cfgRaw)) return
    configDir = cfgRaw
  } else {
    if (!homeDir) return
    configDir = psJoin(homeDir, '.claude')
  }
  const stateDir = psJoin(configDir, 'ywr-harness')
  const stateFile = psJoin(stateDir, 'announced-version')

  // ABSENT is a first run (ywr-harness ADR 0031). Anything else keeps the ywr-harness ADR 0030 behavior.
  // A DIRECTORY squatting on the path counts as "exists", because welcoming it would guess
  // "first run" about a machine that already ran. A probe error also counts as "exists".
  const stateExists = stateExistsAt(stateFile)
  let storedRaw = netTrim(readText(stateFile) ?? '')
  let stored = parseStored(storedRaw)

  // Legacy adoption (ywr-harness ADR 0136): an ABSENT config-dir state under an explicit CLAUDE_CONFIG_DIR
  // takes its stored value from the shared legacy file when that sits at a different path and holds a
  // parseable version. The legacy file is read-only. It records what this machine last announced, so
  // adopting it keeps the first session after the change from re-welcoming.
  let adopted = false
  if (cfgRaw && !stored && !stateExists && homeDir) {
    const legacyFile = psJoin(psJoin(psJoin(homeDir, '.claude'), 'ywr-harness'), 'announced-version')
    if (!samePath(legacyFile, stateFile)) {
      const legacyRaw = netTrim(readText(legacyFile) ?? '')
      const legacy = parseStored(legacyRaw)
      if (legacy) { stored = legacy; storedRaw = legacyRaw; adopted = true }
    }
  }

  if (!stored && !stateExists) {
    // First run on this machine: a fresh install, or the first version carrying this mechanism. The
    // two are indistinguishable, and the message below is TRUE in both (ywr-harness ADR 0031). It writes
    // first and then speaks, the reverse of the update path on purpose. The update announcement
    // protects news, but this one protects nothing the dist README does not carry, so a failed seed
    // is silent. A seed lost to a concurrent first run is a failed seed (newStateExclusive).
    if (newStateExclusive(stateDir, stateFile, currentRaw)) {
      const sys = `[hook:version-announce] ywr-harness v${curShown} 적용 중 — 이 머신의 첫 버전 안내입니다(설치 직후이거나, 안내 기능이 이번 버전에서 처음 도착했습니다). 변경 이력: 플러그인의 CHANGELOG.md · 릴리스 노트 탭(하네스 관리자가 재발행할 때만 갱신) ${rnUrl} (claude.ai Team 좌석 로그인 필요)`
      const ctx = `The ywr-harness plugin v${curShown} is active, and this is its first recorded run on this machine — fresh install, or the first version carrying the announce mechanism (ywr-harness ADR 0031). Release notes: the plugin's CHANGELOG.md (Korean, newest-first — every entry lands here first) and the artifact release-notes tab at ${rnUrl} (refreshed only when the harness owner republishes it, so it may lag CHANGELOG.md — ywr-harness ADR 0224). This welcome appears once per machine; do not repeat it unprompted.`
      emit({ systemMessage: sys, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } })
    }
    return
  }
  if (!stored || cmpVersion(stored, current) > 0) {
    // Exists-but-unreadable state, or a downgrade: (re)seed and say nothing (ywr-harness ADR 0030).
    // The next session retries.
    writeState(stateDir, stateFile, currentRaw)
    return
  }
  if (cmpVersion(stored, current) === 0) {
    // An adopted legacy value equal to current: the config-dir file is still absent, so record it
    // silently. Otherwise every later session would re-adopt the legacy value (ywr-harness ADR 0136).
    if (adopted) writeState(stateDir, stateFile, currentRaw)
    return
  }

  // --- stored < current: the announcement -------------------------------------------------------
  // Bullets for the CURRENT version from the member release notes. The cap is VISIBLE (외 N건),
  // because a silent truncation would read as "that was everything".
  const bullets = changelogBullets(currentRaw, currentStr)

  // systemMessage is a plain-text surface, not a Markdown renderer. The two inline forms the
  // CHANGELOG uses, `code` and **bold**, are stripped for display, or the member reads literal
  // backticks and asterisks. The CHANGELOG itself stays Markdown.
  const shown = bullets.slice(0, 3).map(b => inline(b.replace(/\*\*([^\n]+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1'), Infinity))
  const more = bullets.length - shown.length
  let body = `[hook:version-announce] ywr-harness v${inline(storedRaw)} → v${curShown} 업데이트됨 (자동 업데이트).`
  if (shown.length) {
    body += ' 주요 변경:\n' + shown.map(b => `  • ${b}`).join('\n')
    if (more > 0) body += `\n  • …외 ${more}건 — 전체는 플러그인의 CHANGELOG.md 에서.`
    body += '\n'
  } else {
    body += ' '
  }
  body += `릴리스 노트 탭(하네스 관리자가 재발행할 때만 갱신 — 이 버전 항목은 CHANGELOG.md 에 먼저 실립니다): ${rnUrl} (claude.ai Team 좌석 로그인 필요)`

  if (!writeState(stateDir, stateFile, currentRaw)) {
    body += `\n(안내 기록 실패: ${inline(stateFile, 300)} 에 쓸 수 없어 이 안내가 반복될 수 있습니다 — ${inline(configDir, 300)} 권한을 확인하세요.)`
  }

  const ctx = `The ywr-harness plugin loaded in this session is v${curShown}; the last version announced on this machine was v${inline(storedRaw)} (marketplace auto-update, ywr-harness ADR 0026 — an update applies at the next session start or at /reload-plugins). Member release notes: the plugin's CHANGELOG.md (Korean, newest-first — every entry lands here first) and the onboarding artifact's release-notes tab at ${rnUrl} (refreshed only when the harness owner republishes it, so it may lag CHANGELOG.md — ywr-harness ADR 0224). If the user asks what changed, read the CHANGELOG entry for v${curShown} rather than answering from memory. This announcement is once-per-version (ywr-harness ADR 0030); do not repeat it unprompted.`
  emit({ systemMessage: body, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } })
}

if (!import.meta.url.includes('?')) {
  try {
    const payload = parseJson(readStdin())
    if (isObject(payload)) main(payload)
  } catch { /* fail-open: a hook defect is never a blocked session */ }
}
