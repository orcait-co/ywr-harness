// Shared helpers for the plugin's Node hooks (hooks.json exec form: command `node`). Node built-ins
// only, ESM, no install step (ywr-harness ADR 0220).
//
// `node` is one command name on every OS and a real .exe on Windows. An exec-form `command` must
// resolve to a real executable, never a .cmd/.bat shim.
//
// Contract every hook built on this file keeps: fail-open (a parse or I/O failure is a silent
// exit 0, never a blocked tool call), one compact JSON line on stdout, UTF-8 without BOM both ways.
// No file here may exit the process: exiting before stdout drains truncates the hook's output.
// A hook returns and lets Node end naturally.
import fs from 'node:fs'
import path from 'node:path'
import { git_result, which_on_path } from '../scripts/harness_git.mjs'

/**
 * The first launchable `name` on PATH, as an absolute path, or '' (ywr-harness ADR 0220 decision 9
 * names `harness_git.mjs` as its one owner). Re-exported so a hook finds `gh` or `claude` with the same
 * rule that finds git.
 */
export const whichOnPath = which_on_path

/**
 * One git call at the parse boundary (ywr-harness ADR 0223), run through `harness_git.mjs`:
 * the pins, no shell, stdout captured as bytes and decoded once as UTF-8, git spawned by absolute path.
 * { absent } is true when no git is on PATH or the spawn reports ENOENT; { status } is the exit code
 * (null when the call could not complete). stderr is read and dropped.
 */
export function gitRun(args) {
  try {
    const r = git_result(process.cwd(), args)
    return { absent: false, status: r.status, text: r.stdout }
  } catch (e) {
    return { absent: Boolean(e && e.code === 'ENOENT'), status: null, text: '' }
  }
}

// A `.git` entry that can move the work tree away from the folders above cwd: a gitfile (its git dir
// and config live elsewhere) or a git dir whose config sets `worktree`. Unreadable counts as yes.
function movesWorkTree(gitPath) {
  try {
    if (!fs.statSync(gitPath).isDirectory()) return true
    return /^\s*worktree\s*=/mi.test(fs.readFileSync(path.join(gitPath, 'config'), 'utf8'))
  } catch (e) { return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) }
}

/**
 * Whether the directory `marker` can exist in the work tree root or in cwd, read without git. False
 * only when the folders from cwd upward prove it cannot: none of them holds `marker`, and nothing says
 * that git would name a work tree outside that chain (`GIT_DIR`, `GIT_WORK_TREE`, a gitfile, a
 * `worktree` line in a `.git/config` on the way). The walk runs from cwd as typed and from its real
 * path. A session-start hook that needs `marker` calls it before its first git spawn, which is most of
 * such a hook's run time. A `core.worktree` set only in the global or system config is not seen.
 */
export function markerAbove(cwd, marker) {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return true
  const holds = dir => { try { return fs.statSync(path.join(dir, marker)).isDirectory() } catch { return false } }
  const starts = [path.resolve(cwd)]
  try { const real = fs.realpathSync(cwd); if (real !== starts[0]) starts.push(real) } catch { /* cwd missing */ }
  for (const start of starts) {
    for (let dir = start, up = ''; dir !== up; up = dir, dir = path.dirname(dir)) {
      if (holds(dir) || movesWorkTree(path.join(dir, '.git'))) return true
    }
  }
  return false
}

/** Synchronous sleep, for retry jitter. */
export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * All of stdin as a string: UTF-8 decode, every leading U+FEFF stripped (a BOM-prefixed payload is
 * a real input class). '' when stdin cannot be read.
 */
export function readStdin() {
  const chunks = []
  const buf = Buffer.allocUnsafe(65536)
  const giveUpAt = Date.now() + 2000
  for (;;) {
    let n
    try {
      n = fs.readSync(0, buf, 0, buf.length, null)
    } catch (e) {
      // EAGAIN: a non-blocking pipe with nothing yet, so wait briefly, bounded. Any other error is
      // the end of input: Windows reports a closed pipe as EOF.
      if (e && e.code === 'EAGAIN' && Date.now() < giveUpAt) { sleep(5); continue }
      break
    }
    if (n === 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
  }
  let s = Buffer.concat(chunks).toString('utf8')
  const bom = String.fromCharCode(0xfeff)
  while (s.startsWith(bom)) s = s.slice(1)
  return s
}

/** JSON.parse that fails open: the parsed value, or null for anything unparseable. */
export function parseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

/**
 * A JSON FILE read with the rules of PowerShell 7's `ConvertFrom-Json` (Newtonsoft): `//` and
 * `/* *\/` comments, trailing commas, single-quoted strings and unquoted keys are
 * accepted; `#` comments and doubled commas are refused; `NaN`/`Infinity` come back as the strings
 * PowerShell's `[string]` would print; an empty, blank or comment-only file is null; two keys of one
 * object that differ only by case are refused (an exact repeat is last-wins). Throws on what
 * PowerShell refuses, so a caller keeps its unparseable branch. Two inputs PowerShell takes are
 * refused here, neither a settings-file shape: a leading-zero number (Newtonsoft reads `010` as octal)
 * and an elided array element (`[ , 1]`). Stdin payloads are host-written strict JSON and use
 * `parseJson`.
 */
export function parseJsonLoose(text) {
  const s = String(text)
  const n = s.length
  const LF = 10, CR = 13
  const out = []
  const isWs = (c) => c === 32 || c === 9 || c === LF || c === CR
  const isIdStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36
  const isId = (c) => isIdStart(c) || (c >= 48 && c <= 57)
  // index of the next significant character at or after j (whitespace and comments skipped)
  const skip = (j) => {
    for (;;) {
      while (j < n && isWs(s.charCodeAt(j))) j++
      if (s[j] === '/' && s[j + 1] === '/') { while (j < n && s.charCodeAt(j) !== LF && s.charCodeAt(j) !== CR) j++; continue }
      if (s[j] === '/' && s[j + 1] === '*') {
        const e = s.indexOf('*/', j + 2)
        if (e < 0) throw new SyntaxError('unterminated comment')
        j = e + 2; continue
      }
      return j
    }
  }
  const ESC = { '"': '"', "'": "'", '\\': '\\', '/': '/', b: String.fromCharCode(8), f: String.fromCharCode(12),
    n: String.fromCharCode(LF), r: String.fromCharCode(CR), t: String.fromCharCode(9) }
  // one key map per open object (null for an array): ConvertFrom-Json refused two keys of one object
  // that differ only by case ("use -AsHashTable"); an exact repeat is last-wins, as JSON.parse is
  const scopes = []
  const key = (k) => {
    const m = scopes[scopes.length - 1]
    if (!m) return
    // .NET OrdinalIgnoreCase: SIMPLE per-code-point upper-casing (ß stays ß, ﬁ stays ﬁ) and the
    // Turkish dotted/dotless i (U+0130, U+0131) never fold — JS toUpperCase() maps ß to SS
    let u = ''
    for (const c of k) {
      const cp = c.codePointAt(0)
      const up = cp === 0x130 || cp === 0x131 ? c : c.toUpperCase()
      u += [...up].length === 1 ? up : c
    }
    if (m.has(u) && m.get(u) !== k) throw new SyntaxError('keys differ only by case')
    m.set(u, k)
  }
  let i = 0
  while (i < n) {
    const ch = s[i]
    const c = s.charCodeAt(i)
    if (ch === '"' || ch === "'") {
      let v = ''
      let j = i + 1
      for (;;) {
        if (j >= n) throw new SyntaxError('unterminated string')
        const d = s[j]
        if (d === ch) break
        if (d === '\\') {
          const e = s[j + 1]
          if (e === 'u') {
            const hex = s.slice(j + 2, j + 6)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError('bad \\u escape')
            v += String.fromCharCode(parseInt(hex, 16)); j += 6; continue
          }
          if (!(e in ESC)) throw new SyntaxError('bad escape')
          v += ESC[e]; j += 2; continue
        }
        v += d; j++
      }
      if (s[skip(j + 1)] === ':') key(v)
      out.push(JSON.stringify(v))
      i = j + 1
    } else if (ch === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      i = skip(i)
    } else if (ch === ',') {
      const j = skip(i + 1)
      if (s[j] === ',') throw new SyntaxError('doubled comma')
      if (s[j] !== '}' && s[j] !== ']') out.push(',')
      i = j
    } else if (s.startsWith('-Infinity', i)) {
      out.push(JSON.stringify('-Infinity'))
      i += 9
    } else if ((c >= 48 && c <= 57) || ch === '-' || ch === '.') {
      // a number is one token, so its exponent `e` is never read as an identifier
      let j = i + 1
      while (j < n && /[0-9eE+\-.]/.test(s[j])) j++
      out.push(s.slice(i, j))
      i = j
    } else if (isIdStart(c)) {
      let j = i + 1
      while (j < n && isId(s.charCodeAt(j))) j++
      const word = s.slice(i, j)
      if (s[skip(j)] === ':') { key(word); out.push(JSON.stringify(word)) }
      else if (word === 'true' || word === 'false' || word === 'null') out.push(word)
      else if (word === 'NaN' || word === 'Infinity') out.push(JSON.stringify(word))
      else throw new SyntaxError(`unexpected identifier ${word}`)
      i = j
    } else {
      if (ch === '{') scopes.push(new Map())
      else if (ch === '[') scopes.push(null)
      else if (ch === '}' || ch === ']') scopes.pop()
      out.push(ch)
      i++
    }
  }
  const json = out.join('')
  // an empty, blank or comment-only file is $null to ConvertFrom-Json, not an error
  if (!json.trim()) return null
  return JSON.parse(json)
}

/** A JSON object: not null, not an array (PowerShell's PSCustomObject test, `-is`). */
export function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * PowerShell's `[string]` cast of a parsed JSON value, so a hook records the same text for it:
 * null/missing -> '' (never "undefined"/"null"), booleans -> True/False, an array its
 * elements joined by a space, an object `@{k=v; ...}`.
 */
export function psString(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (Array.isArray(v)) return v.map(psString).join(' ')
  if (typeof v === 'object') return '@{' + Object.entries(v).map(([k, x]) => `${k}=${psString(x)}`).join('; ') + '}'
  return String(v)
}

/** PowerShell's `-eq` on two strings: case-insensitive. Event and tool names compare this way. */
export function ieq(a, b) {
  return a.toUpperCase() === b.toUpperCase()
}

/**
 * PSCustomObject member access (`$payload.tool_name`), which is case-insensitive: an exact-case key
 * wins, else the first key (in Object.keys order) matching case-insensitively. undefined when absent.
 */
export function getProp(obj, name) {
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name]
  const k = Object.keys(obj).find(key => ieq(key, name))
  return k === undefined ? undefined : obj[k]
}

// .NET String.Trim() trims Char.IsWhiteSpace: U+0009-000D, U+0020, U+0085, U+00A0, U+1680,
// U+2000-200A, U+2028, U+2029, U+202F, U+205F, U+3000. JS trim() differs (it trims U+FEFF and not
// U+0085), so the set is spelled out by code unit.
function isNetSpace(c) {
  return (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0x85 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000
}

/** .NET `String.Trim()` semantics. */
export function netTrim(s) {
  let a = 0
  let b = s.length
  while (a < b && isNetSpace(s.charCodeAt(a))) a++
  while (b > a && isNetSpace(s.charCodeAt(b - 1))) b--
  return s.slice(a, b)
}

// The flattened class (harness_config.CONTROL's, plus the backtick): C0 U+0000-001F, DEL U+007F,
// NEL U+0085, LS U+2028, PS U+2029. A model reads hook output and may take any of the three Unicode
// breaks as a line break, so a payload-authored value must not carry one. Match by code unit. Never
// spell these characters or their escapes in source: the escape text can materialize as the
// literal character through an editor.
function isFlattened(c) {
  return c <= 0x1f || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029 || c === 0x60
}

/**
 * Payload-authored text made safe to echo in a banner: every flattened-class character -> a space,
 * trimmed (.NET semantics), then capped at `max` with `max - 1` characters + an ellipsis. Every Node
 * hook imports it. The hooks module `prerequisites.mjs` cannot import this file (a mod has no Node),
 * so its `flatten()` repeats the class, pinned by its own selftest (ywr-harness ADR 0142).
 */
export function inline(text, max = 80) {
  const s = String(text ?? '')
  const out = new Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = isFlattened(s.charCodeAt(i)) ? ' ' : s[i]
  let t = netTrim(out.join(''))
  if (t.length > max) t = t.slice(0, max - 1) + '…'
  return t
}

// Drift-key order: case-insensitive and locale-aware, with an ordinal tiebreak so the order is
// deterministic. The received keys of a real payload are lowercase ASCII, so every culture sorts them
// the same. Exported for scaffold-refresh-nudge's `lastUpdated` order, which compares the same way.
export const collator = new Intl.Collator(undefined, { sensitivity: 'accent' })

/**
 * The received keys a SCHEMA DRIFT banner names: `collator` order with an ordinal tiebreak, joined
 * by ', ' and `inline`d at 300; '(none)' for an object without keys.
 */
export function driftKeys(payload) {
  const k = Object.keys(payload).sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0))
  return k.length ? inline(k.join(', '), 300) : '(none)'
}

/**
 * PowerShell Join-Path's string shape: no doubled separator at the join, `/` becomes `\` on Windows,
 * dot segments and the rest stay as typed (path.join would normalize them).
 */
export function psJoin(parent, child) {
  const c = child.replace(/^[\\/]+/, '')
  const joined = /[\\/]$/.test(parent) ? parent + c : parent + path.sep + c
  return path.sep === '\\' ? joined.replace(/\//g, '\\') : joined
}

/** One compact JSON line on stdout (UTF-8). */
export function emit(obj) {
  process.stdout.on('error', () => { })
  process.stdout.write(JSON.stringify(obj) + '\n')
}
