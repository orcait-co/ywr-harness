// Shared helpers for the plugin's Node hooks (hooks.json exec form: command `node`). Node built-ins
// only, ESM, no install step — the same stack rule as the rest of the plugin.
//
// Why Node and not pwsh: a pwsh hook costs ~780 ms per invocation on the owner's box (~375 ms
// startup + ~300 ms for the FIRST cmdlet call of any kind, whose module auto-load every hook pays);
// the same logic in Node measures ~70 ms. `node` is one command name on every OS and a real .exe on
// Windows (an exec-form `command` must resolve to a real executable, never a .cmd/.bat shim).
//
// Contract every hook built on this file keeps: fail-open (a parse or I/O failure is a silent
// exit 0, never a blocked tool call), one compact JSON line on stdout, UTF-8 without BOM both ways.
// No file here may exit the process — exiting before stdout drains truncates the hook's output;
// a hook returns and lets Node end naturally.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * The first launchable `name` on PATH, as an absolute path, or '' — the lookup PowerShell's
 * `Get-Command` made, which never looked outside PATH. A bare-name spawn does more: libuv searches
 * the CURRENT directory first on Windows (a `git.exe` planted in the repo would run), and on Unix an
 * unset PATH falls back to the default `/usr/bin:/bin`, so a PATH without git still found it (CI
 * parity image, 2026-10-01). Windows: `<name>.exe` / `<name>.com` only — a `.cmd`/`.bat` shim needs a
 * shell. Elsewhere: an executable regular file `<name>`, symlinks followed.
 */
export function whichOnPath(name, envPath = process.env.PATH) {
  const win = process.platform === 'win32'
  const exts = win ? ['.exe', '.com'] : ['']
  for (let dir of String(envPath ?? '').split(path.delimiter)) {
    dir = dir.trim()
    if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1)
    if (!dir || !path.isAbsolute(dir)) continue
    for (const ext of exts) {
      const p = path.join(dir, name + ext)
      try {
        if (!fs.statSync(p).isFile()) continue
        if (!win) fs.accessSync(p, fs.constants.X_OK)
        return p
      } catch { /* absent, dangling or not executable: keep looking */ }
    }
  }
  return ''
}

let gitExe
/**
 * One git call at the parse boundary (CLAUDE.md's git subprocess rule): `-c core.quotepath=false`,
 * no shell, stdout captured as bytes and decoded once as UTF-8. git is resolved on PATH by
 * `whichOnPath` and spawned by absolute path. { absent } is true when no git is on PATH or the spawn
 * reports ENOENT; { status } is the exit code (null when the call could not complete).
 */
export function gitRun(args) {
  if (gitExe === undefined) gitExe = whichOnPath('git')
  if (!gitExe) return { absent: true, status: null, text: '' }
  const r = spawnSync(gitExe, ['-c', 'core.quotepath=false', ...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  if (r.error) return { absent: r.error.code === 'ENOENT', status: null, text: '' }
  return { absent: false, status: r.status, text: r.stdout ? r.stdout.toString('utf8') : '' }
}

/** Synchronous sleep, for retry jitter. */
export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * All of stdin as a string: UTF-8 decode, every leading U+FEFF stripped (a BOM-prefixed payload is
 * a real input class — config-change-audit 2026-07-23). '' when stdin cannot be read.
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
      // EAGAIN: a non-blocking pipe with nothing yet — wait briefly, bounded. EOF: how Windows
      // reports the end of a closed pipe.
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
 * A JSON FILE the way PowerShell 7's `ConvertFrom-Json` read it (Newtonsoft, measured 2026-10-01 on
 * 7.6.6): `//` and `/* *\/` comments, trailing commas, single-quoted strings and unquoted keys are
 * accepted; `#` comments and doubled commas are refused; `NaN`/`Infinity` come back as the strings
 * PowerShell's `[string]` would print; an empty, blank or comment-only file is null; two keys of one
 * object that differ only by case are refused (an exact repeat is last-wins). Throws on what
 * PowerShell refused, so a caller keeps its old unparseable branch. Two inputs PowerShell took are
 * refused here, neither a settings-file shape: a leading-zero number (Newtonsoft read `010` as octal)
 * and an elided array element (`[ , 1]`). Stdin payloads are host-written strict JSON and keep
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

/** A JSON object — not null, not an array (PowerShell's PSCustomObject test, `-is`). */
export function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * PowerShell's `[string]` cast of a parsed JSON value, so a ported hook records what its .ps1
 * recorded: null/missing -> '' (never "undefined"/"null"), booleans -> True/False, an array its
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

/** PowerShell's `-eq` on two strings: case-insensitive (the .ps1 hooks compared event/tool names so). */
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

// .NET String.Trim() trims Char.IsWhiteSpace — U+0009-000D, U+0020, U+0085, U+00A0, U+1680,
// U+2000-200A, U+2028, U+2029, U+202F, U+205F, U+3000. JS trim() differs (it trims U+FEFF and not
// U+0085), and the pwsh Inline() it was ported from is the reference, so the set is spelled out by code unit.
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
// breaks as a line break, so a payload-authored value must not carry one. By code unit — never
// spell these characters (or their escapes) in source: the escape text can materialize as the
// literal character through an editor.
function isFlattened(c) {
  return c <= 0x1f || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029 || c === 0x60
}

/**
 * Payload-authored text made safe to echo in a banner: every flattened-class character -> a space,
 * trimmed (.NET semantics), then capped at `max` with `max - 1` characters + an ellipsis. Every Node
 * hook imports it; the one pwsh hook left (session-start-node-check.ps1) carries its own Inline(),
 * held to this function's behaviour by `Assert-InlineParity` (lib/selftest-lib.ps1).
 */
export function inline(text, max = 80) {
  const s = String(text ?? '')
  const out = new Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = isFlattened(s.charCodeAt(i)) ? ' ' : s[i]
  let t = netTrim(out.join(''))
  if (t.length > max) t = t.slice(0, max - 1) + '…'
  return t
}

/** One compact JSON line on stdout (UTF-8). */
export function emit(obj) {
  process.stdout.on('error', () => { })
  process.stdout.write(JSON.stringify(obj) + '\n')
}
