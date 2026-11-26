#!/usr/bin/env node
// docs-as-code generator. It reads docs/adr/*.md and docs/spec/*.md (YAML frontmatter plus a body)
// and writes four surfaces in one run:
//
//   docs/index.json         structured metadata and the dependency graph, for agents and machines
//   docs/INDEX.md           a short table of contents, for people and agents
//   docs/docs.html          one browsable page: status badges, a meta panel, cross links
//   docs/docs.artifact.html a claude.ai Artifact fragment (the host wraps the document skeleton)
//
// The sources are the truth. Status, date and relations live in the frontmatter only, so the four
// outputs are never edited by hand: change a source `.md`, then run this file again. The file reads
// `0000-*` files as templates and skips them.
//
// Usage:
//   node docs/build_docs.mjs            build the four surfaces (and the customer surface when declared)
//   node docs/build_docs.mjs --customer [--version <label>]
//                                       build the legacy audience-whitelist surface docs/customer.html
//   node docs/build_docs.mjs --check    write nothing, compare the surfaces with a fresh assembly
//                                       (`docs/check_docs.mjs` wraps this mode). It cannot combine with
//                                       --customer, because customer.html embeds today's date and a byte
//                                       comparison could never hold. Exit 0: every present surface
//                                       matches. Exit 1: DRIFT, or MISSING for a surface that must be
//                                       committed. Exit 2: REFUSED, a misuse or a corpus or declaration
//                                       the build itself refuses; a rebuild cannot fix it, so it never
//                                       reads as drift.
// The file rejects an unknown argument with exit 2 before it writes. One YYYY-MM-DD argument is read
// and ignored, because an older wrapper passed one.
//
// Branding: the declared `docs.site_title` of `.harness.json` is the source of the page title. The
// environment variable DOCS_SITE_TITLE is a one-run override only. If the environment were the only
// source, a caller that does not know the repo value (a harness-init re-run, a CI rebuild) would
// reset the committed title to the default. With neither, the title is "Docs · ADR & Spec".
//
// Customer whitelist surface: only documents whose frontmatter says `audience: customer` go into
// docs/customer.html. The default audience is internal, so an internal document never reaches this
// surface. DOCS_CUSTOMER_TITLE sets its title (default: the site title plus a suffix). `--version`
// feeds the header stamp only.
//
// Customer corpus surface: when `.harness.json` declares `docs.customer` (not null), the builder
// also writes `docs/customer.artifact.html` (and `docs/PROJECTS.md` when asked) from the per-program
// corpus `docs/customer/<Program>/{spec.md,user-guide.md,release-notes.md}`. Only
// `scripts/harness/harness_config.mjs` validates the declaration, through its `customer_decl()`. A
// declaration with no importable reader fails at once. A silent fall back to the four-surface build
// would leave the customer surface stale without a signal. The whitelist surface above is separate.
//
// Runtime: Node 22 or later, built-in modules only. The file stays standalone: it imports no sibling
// except the declared reader, and that one only through a dynamic import() when a declaration needs it.
// Panel modules are `.mjs` files that the builder imports the same way.
//
// Copyright (c) 2026 YWR Labs Inc. All rights reserved.
// Author: Hyungjun Kim (John Kim) <johnkim@ywrlabs.com>
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const ADR_DIR = path.join(ROOT, 'adr')
const SPEC_DIR = path.join(ROOT, 'spec')
const OUT_JSON = path.join(ROOT, 'index.json')
const OUT_INDEX_MD = path.join(ROOT, 'INDEX.md')
const OUT_HTML = path.join(ROOT, 'docs.html')
const OUT_ARTIFACT = path.join(ROOT, 'docs.artifact.html')
const OUT_CUSTOMER = path.join(ROOT, 'customer.html')
const OUT_CUSTOMER_ARTIFACT = path.join(ROOT, 'customer.artifact.html')
const OUT_PROJECTS = path.join(ROOT, 'PROJECTS.md')

const SCHEMA_VERSION = 'docs-as-code/1'
const COPYRIGHT = '© 2026 YWR Labs Inc. All rights reserved.'

const STATUS_LABEL = new Map([
  ['proposed', 'Proposed'], ['accepted', 'Accepted'], ['rejected', 'Rejected'],
  ['deprecated', 'Deprecated'], ['superseded', 'Superseded'],
  ['draft', 'Draft'], ['active', 'Active'],
])

// ------------------------------------------------------------------------------------------------
// Python semantics. The corpus text is read the way Python read it (universal newlines, Unicode
// `\s \w \d`, code-point slicing and sorting), so one corpus gives one set of bytes in either
// runtime. Each helper below names the Python behavior it keeps.
// ------------------------------------------------------------------------------------------------

// `sys.exit(<message>)` as an exception: a string code prints to stderr and exits 1, a number is the
// exit code. Nothing in this file calls process.exit(), because a piped stdout could be cut short.
class PyExit extends Error {
  constructor(code) {
    super(typeof code === 'string' ? code : String(code))
    this.name = 'SystemExit'
    this.code = code
  }
}
const sys_exit = (code) => { throw new PyExit(code) }

function named_error(name, message) {
  const e = new Error(message)
  e.name = name
  return e
}

// Python's `\s` for a str pattern: the characters `str.isspace()` accepts. JavaScript's `\s` differs at
// U+001C-U+001F and U+0085 (Python only) and at U+FEFF (JavaScript only).
const WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const WORD = '\\p{L}\\p{N}_'

/**
 * Compile a Python `re` source to a JavaScript RegExp that reads it the way Python reads a str pattern:
 * `\s \w \d` are Unicode, `.` matches everything but "\n", `$` also matches before a final "\n", `\Z`
 * is the end of the text, and a `]` right after `[` is a member. Always the `u` flag; the `s` flag is
 * folded into `.`. A source escape that Python accepts and `u` mode refuses must be written without it.
 */
function pyre(src, flags = '') {
  const dotall = flags.includes('s')
  let out = ''
  let cls = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      const x = src[++i]
      if (x === 's') out += cls ? WS : `[${WS}]`
      else if (x === 'w') out += cls ? WORD : `[${WORD}]`
      else if (x === 'd') out += '\\p{Nd}'
      else if (!cls && x === 'S') out += `[^${WS}]`
      else if (!cls && x === 'W') out += `[^${WORD}]`
      else if (!cls && x === 'D') out += '\\P{Nd}'
      else if (!cls && x === 'Z') out += '(?![\\s\\S])'
      else if (x === 'S' || x === 'W' || x === 'D' || x === 'b' || x === 'B') {
        throw new Error(`pyre: \\${x} in this position is not supported`)
      } else out += c + x
    } else if (cls) {
      if (c === ']') cls = false
      out += c
    } else if (c === '[') {
      cls = true
      out += c
      if (src[i + 1] === '^') { out += '^'; i++ }
      if (src[i + 1] === ']') { out += '\\]'; i++ }
    } else if (c === '.') out += dotall ? '[\\s\\S]' : '[^\\n]'
    else if (c === '$') out += '(?=\\n?$)'
    else out += c
  }
  return new RegExp(out, flags.replace('s', '') + 'u')
}

/** `re.fullmatch(src, text)` as a RegExp: the whole text, no tolerance for a final "\n". */
function fullre(src, flags = '') {
  return pyre('^(?:' + src + ')\\Z', flags)
}

/** `re.escape`: the same set of strings matches. Only characters that are special to a RegExp get a backslash. */
function re_escape(s) {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function _isspace(c) {
  return (c >= 9 && c <= 13) || (c >= 0x1c && c <= 0x20) || c === 0x85 || c === 0xa0 ||
    c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000
}

/** `str.strip()` / `lstrip()` / `rstrip()` with no argument: Python's whitespace set. */
function py_strip(s, left = true, right = true) {
  let a = 0
  let b = s.length
  if (left) while (a < b && _isspace(s.charCodeAt(a))) a++
  if (right) while (b > a && _isspace(s.charCodeAt(b - 1))) b--
  return s.slice(a, b)
}
const py_lstrip = (s) => py_strip(s, true, false)
const py_rstrip = (s) => py_strip(s, false, true)

/** `str.strip(chars)` / `lstrip(chars)`: strips only the listed characters. */
function strip_chars(s, chars, left = true, right = true) {
  let a = 0
  let b = s.length
  if (left) while (a < b && chars.includes(s[a])) a++
  if (right) while (b > a && chars.includes(s[b - 1])) b--
  return s.slice(a, b)
}

/** `str.split()` with no argument. */
function py_split(s) {
  const t = py_strip(s)
  return t === '' ? [] : t.split(pyre('\\s+'))
}

/** `s[a:b]` by code point. */
function cp_slice(s, a, b) {
  return Array.from(s).slice(a, b).join('')
}

/** Order two strings by code point, as Python sorts `str` (JavaScript sorts by UTF-16 unit). */
function cmp(a, b) {
  if (a === b) return 0
  const la = a.length
  const lb = b.length
  let i = 0
  let j = 0
  while (i < la && j < lb) {
    const x = a.codePointAt(i)
    const y = b.codePointAt(j)
    if (x !== y) return x < y ? -1 : 1
    i += x > 0xffff ? 2 : 1
    j += y > 0xffff ? 2 : 1
  }
  return i < la ? 1 : j < lb ? -1 : 0
}
const sorted = (items) => [...items].sort(cmp)

// Python reads a decimal digit of any script in `\d` and in `int()`. `digit_value` maps one such
// character to 0-9: the decimal digits of a script are consecutive runs of ten.
const _ND = /^\p{Nd}$/u
function digit_value(ch) {
  let cpv = ch.codePointAt(0)
  if (cpv < 128) return cpv - 48
  let start = cpv
  while (_ND.test(String.fromCodePoint(start - 1))) start--
  return (cpv - start) % 10
}

/** `int(text)` for a text the caller has matched as an optional minus and decimal digits; a BigInt when it exceeds 2^53. */
function py_int(text) {
  let neg = false
  let t = text
  if (t[0] === '-') { neg = true; t = t.slice(1) } else if (t[0] === '+') t = t.slice(1)
  const digits = Array.from(t).map(digit_value).join('')
  const n = BigInt(digits)
  const v = neg ? -n : n
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v
}

/** `int(str)` as Python parses it: surrounding space, a sign, digits with single underscores. Null where Python raises ValueError. */
function py_int_parse(text) {
  const t = py_strip(text)
  if (!pyre('^[+-]?\\d+(?:_\\d+)*\\Z').test(t)) return null
  return py_int(t.replaceAll('_', ''))
}

const is_int = (v) => typeof v === 'number' || typeof v === 'bigint'

/** `"%04d" % n`. */
function fmt04(n) {
  const s = String(n)
  return s.startsWith('-') ? '-' + s.slice(1).padStart(3, '0') : s.padStart(4, '0')
}

// Python's `repr` of a str keeps a printable character as it is and escapes the rest.
const _NONPRINT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u
function _repr_str(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = q
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (ch === q || ch === '\\') out += '\\' + ch
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (ch !== ' ' && _NONPRINT.test(ch)) {
      out += c < 0x100 ? '\\x' + c.toString(16).padStart(2, '0')
        : c < 0x10000 ? '\\u' + c.toString(16).padStart(4, '0')
          : '\\U' + c.toString(16).padStart(8, '0')
    } else out += ch
  }
  return out + q
}

/** `repr(v)` for a frontmatter value: None, an int, a str, or a list of them. */
function py_repr(v) {
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (is_int(v)) return String(v)
  if (typeof v === 'string') return _repr_str(v)
  if (Array.isArray(v)) return '[' + v.map(py_repr).join(', ') + ']'
  return String(v)
}

/** `str(v)`: a str as it is, anything else as its repr. */
function py_str(v) {
  return typeof v === 'string' ? v : py_repr(v)
}

/** `ascii(s)` for a str: the repr with every non-ASCII character escaped. */
function py_ascii(s) {
  return py_repr(s).replace(/[^\x00-\x7f]/gu, (ch) => {
    const c = ch.codePointAt(0)
    return c < 0x100 ? '\\x' + c.toString(16).padStart(2, '0')
      : c < 0x10000 ? '\\u' + c.toString(16).padStart(4, '0')
        : '\\U' + c.toString(16).padStart(8, '0')
  })
}

/** `text.encode("ascii", "backslashreplace").decode("ascii")`. */
function ascii_bs(text) {
  return text.replace(/[^\x00-\x7f]/gu, (ch) => {
    const c = ch.codePointAt(0)
    return c < 0x100 ? '\\x' + c.toString(16).padStart(2, '0')
      : c < 0x10000 ? '\\u' + c.toString(16).padStart(4, '0')
        : '\\U' + c.toString(16).padStart(8, '0')
  })
}

/** Python truthiness of a frontmatter value. */
function T(v) {
  if (v === null || v === undefined || v === false) return false
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'bigint') return v !== 0n
  if (typeof v === 'string' || Array.isArray(v)) return v.length > 0
  if (v instanceof Map) return v.size > 0
  return true
}

/** `type(v).__name__` for the values a panel module can hand back. */
function py_type_name(v) {
  if (v === null || v === undefined) return 'NoneType'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float'
  if (typeof v === 'bigint') return 'int'
  if (typeof v === 'string') return 'str'
  if (Array.isArray(v)) return 'list'
  if (typeof v === 'function') return 'function'
  if (v instanceof Promise) return 'Promise'
  return 'dict'
}

/** What Python iterates in `for x in v` or `map(str, v)`: a str by code point, a list as it is. */
function seq(v) {
  if (typeof v === 'string') return Array.from(v)
  if (Array.isArray(v)) return v
  throw named_error('TypeError', `'${py_type_name(v)}' object is not iterable`)
}

/** `dict.get(key)` on an entry (a Map): null when absent. */
const g = (e, k) => (e.has(k) ? e.get(k) : null)
/** `dict.get(key, default)`. */
const gd = (e, k, d) => (e.has(k) ? e.get(k) : d)
/** `dict.get(key)` on a plain JSON object, own properties only. */
const pget = (o, k) => (o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : null)
const is_dict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Map)

/** The Python exception name for a Node filesystem error. */
function os_err_name(e) {
  switch (e && e.code) {
    case 'ENOENT': return 'FileNotFoundError'
    case 'EACCES': case 'EPERM': return 'PermissionError'
    // Python opens a directory with PermissionError on Windows and IsADirectoryError elsewhere.
    case 'EISDIR': return process.platform === 'win32' ? 'PermissionError' : 'IsADirectoryError'
    case 'ENOTDIR': return 'NotADirectoryError'
    default: return typeof (e && e.code) === 'string' ? 'OSError' : (e && e.name) || 'Error'
  }
}
const OS_ERRORS = new Set(['OSError', 'FileNotFoundError', 'PermissionError', 'IsADirectoryError',
  'NotADirectoryError', 'FileExistsError'])

/**
 * `open(path, encoding="utf-8")` then `.read()`: universal newlines (a CR or a CRLF reads as "\n"), the
 * BOM kept as a character. A filesystem error carries its Python name. With `strict`, invalid UTF-8
 * throws UnicodeDecodeError; without it each bad sequence becomes U+FFFD, as errors="replace" does.
 */
function read_text(p, strict = true) {
  let buf
  try {
    buf = fs.readFileSync(p)
  } catch (e) {
    e.name = os_err_name(e)
    throw e
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: strict, ignoreBOM: true }).decode(buf)
  } catch {
    throw named_error('UnicodeDecodeError', "'utf-8' codec can't decode the file")
  }
  return text.replace(/\r\n?/g, '\n')
}

const is_file = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const is_dir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }

const out = (line = '') => { process.stdout.write(line + '\n') }
const err = (line = '') => { process.stderr.write(line + '\n') }

/** `json.dumps(v, ensure_ascii=False, indent=2)`: Python's separators, indent and key order. */
function json_dumps(v, level = 0) {
  if (v === null || v === undefined) return 'null'
  if (v === true) return 'true'
  if (v === false) return 'false'
  if (is_int(v)) return String(v)
  if (typeof v === 'string') return JSON.stringify(v)
  const pad = ' '.repeat(2 * (level + 1))
  const end = ' '.repeat(2 * level)
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    return '[\n' + v.map((x) => pad + json_dumps(x, level + 1)).join(',\n') + '\n' + end + ']'
  }
  const entries = v instanceof Map ? [...v] : Object.entries(v)
  if (!entries.length) return '{}'
  return '{\n' + entries.map(([k, x]) => pad + JSON.stringify(String(k)) + ': ' + json_dumps(x, level + 1))
    .join(',\n') + '\n' + end + '}'
}

// ------------------------------------------------------------------------------------------------
// Declaration lookup
// ------------------------------------------------------------------------------------------------
let _decl_cache = null

/**
 * Walk up from ROOT to the `.harness.json` and return [repo_root, raw object or null]. One walk serves
 * the site title and the customer declaration: two walks could diverge, and a cache keeps one warning
 * from printing twice. The walk stops at a repository boundary (a `.git` directory or file, a worktree
 * and a submodule have a file), because climbing on would pick up the declaration of an unrelated
 * parent tree. An unreadable file or a non-object value is reported to stderr and gives
 * [root, null]: a silent revert is the defect this lookup exists to prevent, and the caller still
 * decides whether to go on. The cache assumes the file system does not change during one run.
 */
function find_declaration() {
  if (_decl_cache) return _decl_cache
  let d = ROOT
  let decl_path
  for (;;) {
    decl_path = path.join(d, '.harness.json')
    if (is_file(decl_path)) break
    if (fs.existsSync(path.join(d, '.git'))) return (_decl_cache = [d, null])
    const parent = path.dirname(d)
    if (parent === d) return (_decl_cache = [d, null])
    d = parent
  }
  let decl
  try {
    decl = JSON.parse(read_text(decl_path))
  } catch (e) {
    const name = e instanceof SyntaxError ? 'JSONDecodeError' : os_err_name(e)
    err(`warn: .harness.json unreadable (${name})`)
    return (_decl_cache = [d, null])
  }
  return (_decl_cache = [d, is_dict(decl) ? decl : null])
}

let _site_title = null

/**
 * The page title: the environment override, then `.harness.json` docs.site_title, then the default.
 * Validation belongs to the gate layer. The value read here is a display string that reaches HTML
 * only through escaping; it never runs as a command.
 */
function site_title() {
  if (_site_title !== null) return _site_title
  return (_site_title = resolve_site_title())
}

function resolve_site_title() {
  const env = process.env.DOCS_SITE_TITLE
  if (env) return env
  const [, decl] = find_declaration()
  if (decl === null) return 'Docs · ADR & Spec'
  const docs = pget(decl, 'docs')
  const title = is_dict(docs) ? pget(docs, 'site_title') : null
  if (typeof title === 'string' && py_strip(title)) return py_strip(title)
  if (title !== null && typeof title !== 'string') {
    err('warn: .harness.json docs.site_title is not a string -- default site title used')
  }
  return 'Docs · ADR & Spec'
}

const FILE_RE = pyre('^\\d{4}-.*\\.md$')

// ------------------------------------------------------------------------------------------------
// Frontmatter
// ------------------------------------------------------------------------------------------------
const RX_LEAD_COMMENT = pyre('^\\s*<!--.*?-->\\s*', 's')

/**
 * Extract the frontmatter block: [block or null, rest]. The rules are CRLF folding, a skipped leading
 * HTML comment, an opening `---` line, and a closing line whose strip() is `---`. `fm_digest()` and
 * the recomputation in `scripts/harness/verify_map.mjs` share them as a contract: a change here needs
 * the same change there, and the pairing cases of the build-docs selftest pin it.
 */
function split_frontmatter(text) {
  text = text.replaceAll('\r\n', '\n')
  const lead = RX_LEAD_COMMENT.exec(text)
  if (lead && text.slice(lead[0].length).startsWith('---\n')) text = text.slice(lead[0].length)
  if (!text.startsWith('---\n')) return [null, text]
  const lines = text.split('\n')
  // The closing fence is a line that is exactly `---`, so a typo such as `----` never closes it.
  for (let idx = 1; idx < lines.length; idx++) {
    if (py_strip(lines[idx]) === '---') {
      return [lines.slice(1, idx).join('\n'), lines.slice(idx + 1).join('\n')]
    }
  }
  return [null, text]
}

const FM_KEY_RE = pyre('^([A-Za-z0-9_]+)\\s*:\\s*(.*)$')
// A block list item line: `  - item`, and the unindented `- item` that YAML allows. A space or the
// line end must follow the `-`, so `-1`, `--x` and `---` are no items.
const FM_ITEM_RE = pyre('^[ \\t]*-(?:[ \\t]+(.*))?$')
const RX_COMMENT_START = pyre('(?:^|\\s)#')

/**
 * The YAML subset between the `---` lines, as a Map (insertion order is the output order). Returns
 * [meta, body]. A template copy may keep an explanatory `<!-- -->` comment above the frontmatter;
 * `split_frontmatter` alone decides where the block is.
 *
 * A list has three shapes and all of them read as the same list. Reading only the one-line shape
 * would turn a block list into null and a multi-line flow list into the string `[`, and
 * verify_map would fail on that.
 *   key: [a, b]          one-line flow
 *   key:                 block: the value is empty or only a comment, the next lines are `- item`
 *     - a
 *     - b
 *   key: [               multi-line flow: it opens with a `[` that does not balance on its line and
 *     a,                 closes on the line where the bracket balance (`flow_depth`, counted outside
 *     app/[slug]         quoted items) reaches 0. An unquoted `app/[slug]` item balances itself, so it
 *   ]                    neither opens nor closes the list.
 * An empty value with no block item after it, and a `[` that does not close before the next column-0
 * key or the block end (or that has text after the closing `]`), read by the one-line rule. A
 * comment-only value (`key:   # note`) is null: a space then `#` starts a comment (ywr-harness spec 0001 §3).
 */
function parse_frontmatter(text) {
  const [block, rest] = split_frontmatter(text)
  if (block === null) return [new Map(), rest]
  const meta = new Map()
  const lines = block.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    i += 1
    if (!py_strip(line) || py_lstrip(line).startsWith('#')) continue
    const m = FM_KEY_RE.exec(line)
    if (!m) continue
    const key = m[1]
    const raw = py_strip(m[2])
    const head = cut_comment(raw)
    if (head === '') {
      const [items, nxt] = block_items(lines, i)
      if (items !== null) {
        meta.set(key, items)
        i = nxt
        continue
      }
    } else if (head.startsWith('[') && flow_depth(head) > 0) {
      const [joined, nxt] = flow_lines(lines, i, head)
      if (joined !== null) {
        meta.set(key, parse_value(joined))
        i = nxt
        continue
      }
    }
    meta.set(key, parse_value(raw))
  }
  return [meta, rest]
}

// Inline comment cut: only a `#` after whitespace is a comment, so a `#` inside a value (URL#frag)
// stays. A leading `#` counts too: the whitespace of `key:   # note` is already eaten by the key
// pattern, and every caller passes a stripped value or line. This is the one implementation of the
// comment rule.
function cut_comment(v) {
  const cm = RX_COMMENT_START.exec(v)
  return py_strip(cm ? v.slice(0, cm.index) : v)
}

/**
 * The bracket balance of a flow list: `[` is +1 and `]` is -1. A bracket inside a quoted item (a quote
 * at the head of an item up to the same quote, the shape `parse_item` reads as quoted) does not count,
 * and a quote in the middle of an item (`it's.md`) opens nothing. The same function lives in
 * `scripts/harness/harness_retro.mjs` and the two stay identical; the pairing case of the retro
 * selftest pins them.
 */
function flow_depth(text) {
  let depth = 0
  let quote = null
  let at_item = true
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (at_item && (ch === '"' || ch === "'")) quote = ch
    else if (ch === '[') depth += 1
    else if (ch === ']') depth -= 1
    at_item = ch === '[' || ch === ',' || (at_item && _isspace(ch.charCodeAt(0)))
  }
  return depth
}

/**
 * The `- item` lines of lines[i:] as [list, next index], or [null, i] when no item line follows. A
 * blank or comment line between items does not end the list, as in YAML.
 */
function block_items(lines, i) {
  const items = []
  let j = i
  let end = null
  while (j < lines.length) {
    const s = lines[j]
    j += 1
    if (!py_strip(s) || py_lstrip(s).startsWith('#')) continue
    const im = FM_ITEM_RE.exec(s)
    if (!im) break
    end = j
    let text = py_strip(im[1] ?? '')
    const q = text.slice(0, 1)
    let qe = q === '"' ? dq_end(text) : -1
    if (qe === -1 && (q === '"' || q === "'")) qe = text.indexOf(q, 1)
    if (qe !== -1) text = text.slice(0, qe + 1) // a quoted scalar: what follows the closing quote is a comment
    else text = cut_comment(text) // `- # note` is an empty item
    const item = parse_item(text)
    if (item !== null) items.push(item)
  }
  return end !== null ? [items, end] : [null, i]
}

/**
 * Join a value opened by an unbalanced `[` (`head`) up to the line where the balance reaches 0:
 * [one-line string, next index]. When the closing line does not end in `]`, or a column-0 `key:` line
 * or the block end comes first, the result is [null, i]: the next key is not swallowed and the
 * one-line rule applies.
 */
function flow_lines(lines, i, head) {
  const parts = [head]
  let j = i
  while (j < lines.length) {
    const s = lines[j]
    if (FM_KEY_RE.test(s)) return [null, i]
    j += 1
    const seg = cut_comment(s)
    if (seg) {
      parts.push(seg)
      const joined = parts.join(' ')
      if (flow_depth(joined) <= 0) return joined.endsWith(']') ? [joined, j] : [null, i]
    }
  }
  return [null, i]
}

// The position of the closing quote of a double-quoted scalar (s[0] is the quote); `\"` and `\\` are
// skipped. -1 when there is none.
function dq_end(s) {
  let i = 1
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2
      continue
    }
    if (s[i] === '"') return i
    i += 1
  }
  return -1
}

// Inside a double-quoted scalar only `\"` and `\\` unescape. Any other `\x` stays two characters, so a
// value such as a path never changes silently.
function dq_unescape(body) {
  return body.replace(/\\(["\\])/g, '$1')
}

const RX_INT = fullre('-?\\d+')

// The list item rule shared by the one-line, block and multi-line shapes. An empty item is null (skipped).
function parse_item(item) {
  item = py_strip(item)
  if (item === '') return null
  if (item.slice(0, 1) === '"' && item.length > 1 && dq_end(item) === item.length - 1) {
    return dq_unescape(item.slice(1, -1)) // one quoted scalar to the end: unescape it
  }
  const quoted = item.slice(0, 1) === '"' || item.slice(0, 1) === "'"
  item = strip_chars(strip_chars(item, '"'), "'")
  // Only an unquoted pure integer becomes an int. A quoted one stays an id string: "0001".
  return !quoted && RX_INT.test(item) ? py_int(item) : item
}

function parse_value(v) {
  // A value that starts with a quote stays a quoted string (an id such as "0001").
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0]
    let end = q === '"' ? dq_end(v) : -1
    if (end !== -1) return dq_unescape(v.slice(1, end))
    end = v.indexOf(q, 1)
    if (end !== -1) return v.slice(1, end)
    return strip_chars(v, q)
  }
  v = cut_comment(v)
  if (v === '' || v.toLowerCase() === 'null' || v.toLowerCase() === '~') return null
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = py_strip(v.slice(1, -1))
    if (!inner) return []
    const items = []
    for (const part of inner.split(',')) {
      const item = parse_item(part)
      if (item !== null) items.push(item)
    }
    return items
  }
  if (RX_INT.test(v)) return py_int(v)
  return v
}

// ------------------------------------------------------------------------------------------------
// Markdown to HTML
// ------------------------------------------------------------------------------------------------
// One escape for text and attribute values alike, so a quote cannot break out of an attribute.
function esc(text) {
  return py_str(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

const RX_CODE = pyre('`([^`]+)`', 'g')
const RX_LINK = pyre('\\[([^\\]]+)\\]\\(([^)]+)\\)', 'g')
const RX_BOLD = pyre('\\*\\*(.+?)\\*\\*', 'g')
const RX_ITALIC = pyre('(?<!\\*)\\*([^*]+)\\*(?!\\*)', 'g')
const RX_CODE_REF = pyre('\\x00(\\d+)\\x00', 'g')
const RX_BAD_SCHEME = pyre('^\\s*(?:javascript|vbscript|data):', 'i')

function inline(text) {
  const codes = []
  text = text.replace(RX_CODE, (m, code) => {
    codes.push(code)
    return `\x00${codes.length - 1}\x00`
  })
  text = esc(text)
  text = text.replace(RX_LINK, (m, label, href_in) => {
    // Neutralize an untrusted scheme. The text went through esc already, so a quote is safe. A browser
    // deletes tab, CR and LF anywhere in a URL and strips leading control characters and spaces before it
    // reads the scheme, so the comparison runs after the same normalization.
    let href = href_in
    const probe = href.replace(/[\t\r\n]/g, '').replace(/^[\x00-\x20]+/, '')
    if (RX_BAD_SCHEME.test(probe)) href = '#'
    return `<a href="${href}">${label}</a>`
  })
  text = text.replace(RX_BOLD, (m, s) => `<strong>${s}</strong>`)
  text = text.replace(RX_ITALIC, (m, s) => `<em>${s}</em>`)
  text = text.replace(RX_CODE_REF, (m, n) => {
    const idx = py_int(n)
    if (idx >= codes.length) throw named_error('IndexError', 'list index out of range')
    return `<code>${esc(codes[idx])}</code>`
  })
  return text
}

// One line of a ```diff fence, with a class (+ added, - removed, @@ hunk; the +++ and --- headers
// excluded). Release notes use it to show a source change.
function diff_line(line) {
  const e = esc(line)
  if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="d-add">${e}</span>`
  if (line.startsWith('-') && !line.startsWith('---')) return `<span class="d-del">${e}</span>`
  if (line.startsWith('@@')) return `<span class="d-hunk">${e}</span>`
  return e
}

const RX_INDENTED = pyre('^[ \\t]+\\S')
const RX_BULLET_S = pyre('^[-*]\\s+')
const RX_NUMBER_S = pyre('^\\d+\\.\\s+')
const RX_HR = pyre('^-{3,}$')

// A hard-wrapped continuation of a list item: a line that starts indented and opens no new structure
// (marker, fence, table, heading, quote, rule). A continuation without a marker would otherwise close
// the list and fall into a separate paragraph, which cuts the sentence apart.
function is_list_continuation(line) {
  if (!RX_INDENTED.test(line)) return false
  const s = py_strip(line)
  if (RX_BULLET_S.test(s) || RX_NUMBER_S.test(s)) return false
  if (s.startsWith('```') || s.startsWith('>') || s.startsWith('#') || s.startsWith('|') || RX_HR.test(s)) {
    return false
  }
  return true
}

const RX_TABLE_SEP = pyre('^\\s*\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)*\\|?\\s*$')
function is_table_sep(line) {
  return RX_TABLE_SEP.test(line) && line.includes('-')
}

function split_row(line) {
  let s = py_strip(line)
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => py_strip(c))
}

const RX_HEADING = pyre('^(#{1,6})\\s+(.*)$')
const RX_HEADING_START = pyre('^#{1,6}\\s+')
const RX_QUOTE_PREFIX = pyre('^\\s*>\\s?')
const RX_BULLET = pyre('^\\s*[-*]\\s+')
const RX_NUMBERED = pyre('^\\s*\\d+\\.\\s+')
const RX_NUMBERED_START = pyre('^\\s*(\\d+)\\.')

function convert_body(lines) {
  const o = []
  let i = 0
  const n = lines.length
  while (i < n) {
    const line = lines[i]
    const stripped = py_strip(line)
    if (stripped === '') {
      i += 1
      continue
    }
    if (stripped.startsWith('<!--')) { // an HTML comment block is skipped whole and never rendered
      while (i < n && !lines[i].includes('-->')) i += 1
      i += 1
      continue
    }
    if (RX_HR.test(stripped)) {
      o.push('<hr>')
      i += 1
      continue
    }
    if (stripped.startsWith('```')) {
      const lang = py_strip(stripped.slice(3)).toLowerCase()
      i += 1
      const buf = []
      while (i < n && !py_strip(lines[i]).startsWith('```')) {
        buf.push(lines[i])
        i += 1
      }
      i += 1
      if (lang === 'diff') o.push(`<pre class="diff">${buf.map(diff_line).join('\n')}</pre>`)
      else o.push(`<pre>${esc(buf.join('\n'))}</pre>`)
      continue
    }
    const m = RX_HEADING.exec(line)
    if (m) {
      const level = m[1].length
      o.push(`<h${level}>${inline(py_strip(m[2]))}</h${level}>`)
      i += 1
      continue
    }
    if (line.includes('|') && i + 1 < n && is_table_sep(lines[i + 1])) {
      const header = split_row(line)
      i += 2
      const rows = []
      while (i < n && lines[i].includes('|') && py_strip(lines[i]) !== '') {
        rows.push(split_row(lines[i]))
        i += 1
      }
      // The table sits in a scroll wrapper: a `display:block` table makes only the border box 100% wide,
      // the rows end at their content width, and the right side looks cut off.
      const t = ['<div class="tblwrap"><table>',
        `<thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`, '<tbody>']
      for (const row of rows) t.push(`<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
      t.push('</tbody>', '</table></div>')
      o.push(t.join('\n'))
      continue
    }
    if (stripped.startsWith('>')) {
      const raw = []
      while (i < n && py_strip(lines[i]).startsWith('>')) {
        raw.push(lines[i])
        i += 1
      }
      const inner = raw.map((r) => r.replace(RX_QUOTE_PREFIX, ''))
      const buf = inner.filter((x) => py_strip(x) !== '').map((x) => inline(py_rstrip(x)))
      o.push(`<blockquote>${buf.join('<br>\n')}</blockquote>`)
      continue
    }
    if (RX_BULLET.test(line)) {
      const items = []
      while (i < n && RX_BULLET.test(lines[i])) {
        let item = py_rstrip(lines[i].replace(RX_BULLET, ''))
        i += 1
        while (i < n && is_list_continuation(lines[i])) {
          item += ' ' + py_strip(lines[i])
          i += 1
        }
        items.push(inline(item))
      }
      o.push(`<ul>\n${items.map((it) => `<li>${it}</li>`).join('\n')}\n</ul>`)
      continue
    }
    if (RX_NUMBERED.test(line)) {
      // Keep the start number of the source (the start attribute).
      const start = py_int(RX_NUMBERED_START.exec(line)[1])
      const items = []
      while (i < n && RX_NUMBERED.test(lines[i])) {
        let item = py_rstrip(lines[i].replace(RX_NUMBERED, ''))
        i += 1
        while (i < n && is_list_continuation(lines[i])) {
          item += ' ' + py_strip(lines[i])
          i += 1
        }
        items.push(inline(item))
      }
      const attr = start !== 1 ? ` start="${start}"` : ''
      o.push(`<ol${attr}>\n${items.map((it) => `<li>${it}</li>`).join('\n')}\n</ol>`)
      continue
    }
    const buf = []
    while (i < n) {
      const cur = lines[i]
      const cs = py_strip(cur)
      if (cs === '' || cs.startsWith('<!--') || RX_HR.test(cs) || cs.startsWith('>') || cs.startsWith('```') ||
          RX_HEADING_START.test(cur) || RX_BULLET.test(cur) || RX_NUMBERED.test(cur) ||
          (cur.includes('|') && i + 1 < n && is_table_sep(lines[i + 1]))) {
        break
      }
      buf.push([py_strip(cur), cur.endsWith('  ')])
      i += 1
    }
    // inline() runs after the hard-wrapped lines are joined. Run per line, a **bold** or `code` span that
    // crosses a line break would not match and the markdown characters would show as literal text.
    // A two-space hard break stays.
    const chunks = []
    let curch = []
    for (const [text, hard_break] of buf) {
      curch.push(text)
      if (hard_break) {
        chunks.push(curch.join(' '))
        curch = []
      }
    }
    if (curch.length) chunks.push(curch.join(' '))
    o.push(`<p>${chunks.map(inline).join('<br>')}</p>`)
  }
  return o.join('\n')
}

// Remove the leading H1 of a body, the duplicate of the title. The frontmatter is the single source of
// the title and the renderers already draw it, on the internal and the customer surfaces alike.
const RX_H1 = pyre('^#\\s+')
function strip_leading_h1(body_lines) {
  let k = 0
  while (k < body_lines.length && py_strip(body_lines[k]) === '') k++
  if (k < body_lines.length && RX_H1.test(body_lines[k])) body_lines.splice(k, 1)
  return body_lines
}

// ------------------------------------------------------------------------------------------------
// Collection
// ------------------------------------------------------------------------------------------------
function collect(directory) {
  const entries = []
  // id -> file name. A duplicate collides only inside one kind (a directory): the graph keys carry an
  // `adr:` or `spec:` prefix, so the same number in two kinds is legal, and collect() runs per directory.
  const seen = new Map()
  if (!is_dir(directory)) return entries
  for (const fn of sorted(fs.readdirSync(directory))) {
    if (!FILE_RE.test(fn) || fn.startsWith('0000-')) continue
    const p = path.join(directory, fn)
    // An unreadable file (permission, a directory with a document name, invalid UTF-8) is a named
    // refusal, never a traceback: the same rule as the duplicate id. The builder never builds around a
    // broken corpus. The tolerance in fm_digest (replace, None) serves an advisory recomputation, so its
    // role differs.
    let meta
    let body
    try {
      [meta, body] = parse_frontmatter(read_text(p))
    } catch (e) {
      const name = e.name
      if (name !== 'UnicodeDecodeError' && !OS_ERRORS.has(name)) throw e
      sys_exit(`[오류] 읽을 수 없는 문서: ${fn} (${name}) — 권한/인코딩/이름만 문서인 디렉토리를 ` +
               '확인하세요. 깨진 코퍼스로는 빌드하지 않습니다.')
    }
    // The id is always a string. An unquoted 0001 parses as the int 1 and would break DOM ids and
    // dictionary keys, so a number is padded to four digits.
    if (is_int(g(meta, 'id'))) meta.set('id', fmt04(meta.get('id')))
    else if (g(meta, 'id') !== null) meta.set('id', py_str(meta.get('id')))
    if (!T(g(meta, 'id'))) {
      out(`  [경고] frontmatter id 없음, 건너뜀: ${fn}`)
      continue
    }
    // A duplicate id fails the build, deterministically. Parallel branches each take "the next number",
    // each PR passes its own drift gate, and the clash shows only in the merged corpus. Going on would
    // commit an index where the graph kept the link of one side only.
    const id = meta.get('id')
    if (seen.has(id)) {
      sys_exit(`[오류] id 중복: ${seen.get(id)} 와 ${fn} 가 같은 id '${id}' 를 선언합니다 — 병렬 브랜치가 ` +
               "각자 '다음 번호'를 잡은 병합의 전형입니다(ywr-harness ADR 0043). 한쪽을 다음 빈 번호로 " +
               '옮기고 참조(related_*, based_on_adr, supersedes)를 갱신한 뒤 재빌드하세요.')
    }
    seen.set(id, fn)
    // No audience means internal, the safe side. The customer surface takes only a document whose value
    // is exactly "customer".
    if (g(meta, 'audience') !== 'customer') meta.set('audience', 'internal')
    meta.set('_file', fn)
    meta.set('_relpath', path.relative(ROOT, p).replaceAll('\\', '/'))
    // The leading H1 (a duplicate of the title) is removed: the viewer's doc-h already shows the title.
    meta.set('_body_html', convert_body(strip_leading_h1(body.split('\n'))))
    entries.push(meta)
  }
  return entries
}

// ------------------------------------------------------------------------------------------------
// Narrowing (ywr-harness ADR 0196)
// ------------------------------------------------------------------------------------------------
// ADR frontmatter `narrows: [N, ...]` names the older ADRs whose decision this ADR changes in part (the
// older ADR stays accepted). The reverse (narrowed_by) is derived here and never authored: a hand-written
// narrowed_by key is ignored. The derived values sit under underscore keys (_narrows, _narrowed_by):
// the graph, INDEX.md and the meta panel read only those. The adr[] and spec[] arrays of index.json carry
// the frontmatter as written, the underscore keys stripped. The rule applies to ADRs only; a spec's
// narrows makes no relation.
// A narrowing ADR in one of these three states is left out of the reverse list: a narrowing that no
// longer has effect is not shown.
const NARROW_INACTIVE = ['superseded', 'rejected', 'deprecated']

// A narrows item as a four-digit ADR id string; null when the item is not an ADR number (an int, or a
// string of digits).
const RX_DIGITS = fullre('[0-9]+')
function adr_key(item) {
  if (is_int(item) && item >= 0) return fmt04(item)
  if (typeof item === 'string' && RX_DIGITS.test(item)) return fmt04(py_int(item))
  return null
}

// The number a surface prints: a numeric id as an int (0028 is 28), any other id as the string it is.
function adr_num(adr_id) {
  return RX_DIGITS.test(adr_id) ? py_int(adr_id) : adr_id
}

// Check every narrows over the whole ADR list and derive the reverse once. A bad value exits through
// sys_exit: assemble() carries it, so a normal build stops and --check reports REFUSED (exit 2).
function resolve_narrows(adrs) {
  const by_key = new Map()
  for (const e of adrs) by_key.set(adr_key(e.get('id')) || e.get('id'), e)
  const rev = new Map()
  for (const e of adrs) {
    const val = g(e, 'narrows')
    if (val === null || (Array.isArray(val) && val.length === 0)) continue
    const nums = []
    if (!Array.isArray(val)) {
      sys_exit(`[오류] narrows 값 오류: ${e.get('_file')} 의 narrows 가 리스트가 아닙니다(값: ${py_repr(val)}) — ` +
               'ADR 번호 리스트로 적으세요(예: [28, 70], ywr-harness ADR 0196).')
    }
    for (const item of val) {
      const key = adr_key(item)
      if (key === null) {
        sys_exit(`[오류] narrows 값 오류: ${e.get('_file')} 의 narrows 항목 ${py_repr(item)} 가 ADR 번호가 ` +
                 '아닙니다 — 정수 또는 숫자 문자열이어야 합니다(ywr-harness ADR 0196).')
      }
      const target = by_key.get(key)
      if (target === undefined) {
        sys_exit(`[오류] narrows 값 오류: ${e.get('_file')} 의 narrows 항목 ${py_repr(item)} 가 코퍼스의 어떤 ` +
                 'ADR 도 가리키지 않습니다(ywr-harness ADR 0196).')
      }
      if (target === e) {
        sys_exit(`[오류] narrows 값 오류: ${e.get('_file')} 의 narrows 항목 ${py_repr(item)} 가 자기 ` +
                 '자신입니다 — ADR 은 다른 ADR 만 좁힐 수 있습니다(ywr-harness ADR 0196).')
      }
      if (!NARROW_INACTIVE.includes(g(e, 'status'))) {
        const tid = target.get('id')
        if (!rev.has(tid)) rev.set(tid, new Set())
        rev.get(tid).add(e.get('id'))
      }
      // A surface prints one shape of the number: "0004", "4" and 4 are the same ADR, and a plain string
      // would not link. The same number written twice stays once.
      const num = adr_num(target.get('id'))
      if (!nums.includes(num)) nums.push(num)
    }
    e.set('_narrows', nums)
  }
  for (const e of adrs) {
    if (rev.has(e.get('id'))) e.set('_narrowed_by', sorted(rev.get(e.get('id'))))
  }
}

// ------------------------------------------------------------------------------------------------
// JSON and index
// ------------------------------------------------------------------------------------------------
/**
 * The deterministic digest of the corpus frontmatter: the `fm_digest` stamp of index.json. The file
 * rules equal collect() (NNNN-*.md, `0000-` skipped, a sorted walk) and the block rule equals
 * `split_frontmatter`. A body-only edit leaves the digest alone: an append-only ADR addendum must not
 * demand an index rebuild, the same principle as the BUILD check of `harness_retro.mjs`.
 * `scripts/harness/verify_map.mjs` recomputes the digest by the same rules to raise the staleness
 * signal. The pairing cases of the build-docs selftest hold the two implementations together, and a
 * change on one side alone breaks them.
 * Location contract: adr/ and spec/ are sibling directories of this file (and of the index.json it
 * writes). verify_map derives the corpus from the parent of the declared index path, so `docs/` is
 * never hardcoded.
 */
function fm_digest() {
  const h = crypto.createHash('sha256')
  for (const [kind, directory] of [['adr', ADR_DIR], ['spec', SPEC_DIR]]) {
    if (!is_dir(directory)) continue
    for (const fn of sorted(fs.readdirSync(directory))) {
      if (!FILE_RE.test(fn) || fn.startsWith('0000-')) continue
      let block
      try {
        [block] = split_frontmatter(read_text(path.join(directory, fn), false))
      } catch (e) {
        if (!OS_ERRORS.has(e.name)) throw e
        block = null
      }
      h.update(Buffer.from(`${kind}/${fn}\0${block || ''}\0`, 'utf8'))
    }
  }
  return h.digest('hex')
}

function build_json(adrs, specs, digest = null) {
  const strip = (e) => {
    const d = new Map([...e].filter(([k]) => !k.startsWith('_')))
    d.set('path', g(e, '_relpath'))
    return d
  }
  const graph = new Map()
  for (const e of adrs) {
    const node = new Map([
      ['related_adr', T(g(e, 'related_adr')) ? e.get('related_adr') : []],
      ['related_spec', T(g(e, 'related_spec')) ? e.get('related_spec') : []],
      ['superseded_by', g(e, 'superseded_by')],
    ])
    // Written only when non-empty: a new key in the committed index of a corpus that never uses
    // narrows would fail that repo's drift check until a rebuild (ywr-harness ADR 0196).
    if (T(g(e, '_narrows'))) node.set('narrows', e.get('_narrows'))
    if (T(g(e, '_narrowed_by'))) node.set('narrowed_by', e.get('_narrowed_by').map((i) => adr_num(i)))
    graph.set('adr:' + e.get('id'), node)
  }
  for (const e of specs) {
    graph.set('spec:' + e.get('id'), new Map([['based_on_adr', T(g(e, 'based_on_adr')) ? e.get('based_on_adr') : []]]))
  }
  const o = new Map([
    ['schema', SCHEMA_VERSION],
    ['counts', new Map([['adr', adrs.length], ['spec', specs.length]])],
    ['adr', adrs.map(strip)],
    ['spec', specs.map(strip)],
    ['graph', graph],
  ])
  // The schema stays docs-as-code/1: this is an added key, and every consumer reads it with a default.
  if (digest) o.set('fm_digest', digest)
  return o
}

function status_label(status) {
  if (Array.isArray(status)) throw named_error('TypeError', "unhashable type: 'list'")
  return typeof status === 'string' && STATUS_LABEL.has(status) ? STATUS_LABEL.get(status) : null
}

function build_index_md(adrs, specs) {
  const L = ['# docs 인덱스 (자동 생성 — 직접 편집 금지)', '',
    '> `node docs/build_docs.mjs` 로 재생성. 진실원은 adr/·spec/ 의 .md frontmatter.', '']
  L.push(`## ADR (${adrs.length})`)
  L.push('')
  L.push('| # | 제목 | 상태 | 날짜 | 관련 스펙 |')
  L.push('|---|---|---|---|---|')
  for (const e of adrs) {
    const spec = seq(T(g(e, 'related_spec')) ? e.get('related_spec') : []).map(py_str).join(', ') || '—'
    const lab = status_label(g(e, 'status'))
    let status = lab !== null ? lab : (T(g(e, 'status')) ? e.get('status') : '—')
    if (T(g(e, '_narrowed_by'))) { // ywr-harness ADR 0196: only a narrowed ADR changes its status cell
      if (typeof status !== 'string') throw named_error('TypeError', 'can only concatenate str')
      status += ' · narrowed by ' + e.get('_narrowed_by').map((i) => `#${adr_num(i)}`).join(', ')
    }
    L.push(`| [${e.get('id')}](${e.get('_relpath')}) | ${py_str(gd(e, 'title', ''))} | ${py_str(status)} | ` +
           `${py_str(T(g(e, 'date')) ? e.get('date') : '—')} | ${spec} |`)
  }
  L.push('', `## SPEC (${specs.length})`, '', '| # | 스펙 | 상태 | 근거 ADR |', '|---|---|---|---|')
  for (const e of specs) {
    const based = seq(T(g(e, 'based_on_adr')) ? e.get('based_on_adr') : []).map((a) => `#${py_str(a)}`).join(', ') || '—'
    const lab = status_label(g(e, 'status'))
    L.push(`| [${e.get('id')}](${e.get('_relpath')}) | ${py_str(gd(e, 'title', ''))} | ` +
           `${py_str(lab !== null ? lab : (T(g(e, 'status')) ? e.get('status') : '—'))} | ${based} |`)
  }
  return L.join('\n') + '\n'
}

// ------------------------------------------------------------------------------------------------
// HTML
// ------------------------------------------------------------------------------------------------
const CSS = `
:root{
  --bg:#0f1117;--surface:#171a23;--surface-2:#1e222e;--line:#2a2f3d;--line-soft:#222633;
  --ink:#e8eaf0;--ink-soft:#a8aec1;--ink-dim:#6f7589;--accent:#6d8bff;--accent-soft:#243056;
  --ok-bg:#143222;--ok:#5fd29a;--warn-bg:#3a3015;--warn:#e8b54a;--bad-bg:#3a1d1f;--bad:#f08a8a;
  --radius:12px;--mono:'SFMono-Regular',ui-monospace,'Cascadia Code',Consolas,monospace;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font:15px/1.68 -apple-system,'Segoe UI',Roboto,'Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}

/* ── 상단 바 + 탭 ───────────────────────────────────── */
header.app{position:sticky;top:0;z-index:20;background:rgba(15,17,23,.86);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.app-in{max-width:1280px;margin:0 auto;padding:16px 28px 0}
.app-title{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.app-title h1{margin:0;font-size:19px;font-weight:680;letter-spacing:-.01em}
.app-title .sub{color:var(--ink-dim);font-size:12.5px}
footer.cpy{max-width:1280px;margin:0 auto;padding:0 28px 32px;color:var(--ink-dim);font-size:12px}
.app-title .sub code{color:var(--ink-soft)}
.tabs{display:flex;gap:4px;margin-top:14px}
.tab{appearance:none;border:0;background:none;color:var(--ink-soft);font:inherit;font-size:14px;font-weight:560;padding:9px 16px;border-radius:8px 8px 0 0;cursor:pointer;border-bottom:2px solid transparent;display:flex;align-items:center;gap:7px}
.tab:hover{color:var(--ink);background:var(--surface)}
.tab[aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent)}
.tab .ct{font-size:11px;font-weight:700;color:var(--ink-dim);background:var(--surface-2);border-radius:999px;padding:1px 8px}
.tab[aria-selected=true] .ct{color:var(--accent);background:var(--accent-soft)}

main{max-width:1280px;margin:0 auto;padding:24px 28px 64px}
.tabpanel{display:none}.tabpanel.on{display:block}

/* ── 문서 뷰(2-pane) ─────────────────────────────────── */
.docview{display:grid;grid-template-columns:300px 1fr;gap:26px;align-items:start}
.doclist{position:sticky;top:120px;max-height:calc(100vh - 144px);overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px}
.search{position:relative}
.search input{width:100%;background:var(--surface);border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:9px 12px 9px 32px;font:inherit;font-size:13.5px}
.search input:focus{outline:none;border-color:var(--accent)}
.search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--ink-dim)}
.docitem{text-align:left;appearance:none;cursor:pointer;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:11px 13px;color:var(--ink);display:flex;flex-direction:column;gap:5px;transition:border-color .12s,background .12s}
.docitem:hover{border-color:#3a4256}
.docitem[aria-current=true]{border-color:var(--accent);background:var(--accent-soft)}
.docitem .di-top{display:flex;align-items:center;gap:8px}
.docitem .di-id{font:600 11.5px/1 var(--mono);color:var(--ink-dim)}
.docitem .di-title{font-size:13.5px;font-weight:560;line-height:1.4}
.docitem.hidden{display:none}

.docmain{min-width:0}
.doc{display:none;animation:fade .18s ease}.doc.on{display:block}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.doc-h{font-size:23px;line-height:1.3;margin:0 0 4px;font-weight:700;letter-spacing:-.015em}
.doc-kicker{font:600 12px/1 var(--mono);letter-spacing:.06em;color:var(--accent);text-transform:uppercase;margin-bottom:10px}

/* ── 메타 패널 ───────────────────────────────────────── */
.meta{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px 22px;font-size:13px;color:var(--ink-soft);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 20px;margin:14px 0 8px}
.meta span{display:block}.meta b{display:block;color:var(--ink-dim);font-weight:600;font-size:11px;letter-spacing:.05em;text-transform:uppercase;margin-bottom:2px}
.tags{margin:10px 0 22px}
.tag{display:inline-block;background:var(--surface-2);color:var(--ink-soft);border:1px solid var(--line-soft);border-radius:7px;padding:2px 9px;font-size:12px;margin:0 5px 5px 0}
.badge{display:inline-block;padding:2px 11px;border-radius:999px;font-size:11.5px;font-weight:700;letter-spacing:.02em}
.s-accepted,.s-active{background:var(--ok-bg);color:var(--ok)}
.s-proposed,.s-draft{background:var(--warn-bg);color:var(--warn)}
.s-superseded,.s-deprecated,.s-rejected{background:var(--bad-bg);color:var(--bad)}
.s-unknown{background:var(--surface-2);color:var(--ink-soft)}

/* ── 본문 마크다운 ───────────────────────────────────── */
.body{font-size:14.5px}
.body h1{font-size:19px;margin:30px 0 10px}.body h2{font-size:17px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line-soft)}
.body h3{font-size:15px;margin:20px 0 6px}.body h4{font-size:13.5px;color:var(--ink-soft);margin:16px 0 4px}
.body p{margin:9px 0}.body ul,.body ol{margin:9px 0;padding-left:22px}.body li{margin:3px 0}
.body .tblwrap{margin:14px 0;overflow-x:auto;border:1px solid var(--line);border-radius:10px}
.body table{border-collapse:collapse;width:100%;font-size:13px}
.body th,.body td{border-bottom:1px solid var(--line-soft);border-right:1px solid var(--line-soft);padding:8px 12px;text-align:left;vertical-align:top}
.body th{background:var(--surface-2);color:var(--ink);font-weight:640;white-space:nowrap}
.body tr:last-child td{border-bottom:0}.body td:last-child,.body th:last-child{border-right:0}
.body pre{background:#0b0d13;border:1px solid var(--line);color:#cdd3e8;padding:15px 17px;border-radius:10px;overflow-x:auto;font:12.5px/1.6 var(--mono)}
.body pre .d-add{color:var(--ok)}.body pre .d-del{color:var(--bad)}.body pre .d-hunk{color:var(--accent)}
.body code{background:var(--surface-2);color:#cdd3e8;padding:1.5px 6px;border-radius:5px;font:.88em var(--mono)}
.body pre code{background:none;padding:0}
.body blockquote{margin:12px 0;padding:10px 16px;border-left:3px solid var(--accent);background:var(--surface);border-radius:0 8px 8px 0;color:var(--ink-soft)}
.body hr{border:0;border-top:1px solid var(--line-soft);margin:22px 0}
.body strong{color:var(--ink);font-weight:680}

/* ── 개요 대시보드 ───────────────────────────────────── */
.ov-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin:6px 0 28px}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px}
.stat .n{font-size:30px;font-weight:740;letter-spacing:-.02em}.stat .l{color:var(--ink-dim);font-size:12.5px;margin-top:2px}
.ov-sec{font-size:13px;font-weight:640;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.06em;margin:26px 0 12px}
.ov-table{width:100%;border-collapse:collapse;font-size:13.5px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.ov-table th,.ov-table td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--line-soft)}
.ov-table th{background:var(--surface-2);color:var(--ink-soft);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.ov-table tr:last-child td{border-bottom:0}
.ov-table tr.clickable{cursor:pointer}.ov-table tr.clickable:hover td{background:var(--surface-2)}
.ov-table .lnk{color:var(--accent);font:600 12.5px/1 var(--mono)}
.rel{color:var(--ink-dim);font-size:12.5px}.rel a{font-family:var(--mono);font-size:12px}

@media(max-width:860px){
  .docview{grid-template-columns:1fr}
  .doclist{position:static;max-height:none;flex-direction:row;flex-wrap:wrap;overflow:visible}
  .doclist .search{flex-basis:100%}.docitem{flex:1 1 200px}
}
@media print{
  header.app{position:static}.tabs,.doclist,.tab{display:none}
  .tabpanel{display:block!important}.doc{display:block!important;page-break-after:always}
  body{background:#fff;color:#000}
}
`

function badge(status) {
  const lab = status_label(status)
  const label = lab !== null ? lab : (T(status) ? status : '?')
  return `<span class="badge s-${esc(T(status) ? status : 'unknown')}">${esc(label)}</span>`
}

function link_adr(num, by_id) {
  const sid = is_int(num) ? fmt04(num) : py_str(num)
  if (by_id.has(sid)) return `<a href="#adr-${esc(sid)}">#${esc(py_str(num))}</a>`
  return `#${esc(py_str(num))}`
}

function link_spec(sid, spec_ids) {
  sid = py_str(sid)
  if (spec_ids.has(sid)) return `<a href="#spec-${esc(sid)}">spec ${esc(sid)}</a>`
  return `spec ${esc(sid)}`
}

function meta_panel(e, adr_ids, spec_ids, customer = false) {
  const rows = [`<b>상태</b> ${badge(g(e, 'status'))}`]
  if (T(g(e, 'date'))) rows.push(`<b>날짜</b> ${esc(py_str(e.get('date')))}`)
  if (T(g(e, 'updated'))) rows.push(`<b>갱신</b> ${esc(py_str(e.get('updated')))}`)
  // The customer surface never shows the deciders (internal staff data) or any cross-reference row that
  // points at internal documents (related and base ADRs and specs, supersede, implementation paths):
  // an internal reference number means nothing to a customer and exposes the internal structure.
  if (!customer) {
    if (T(g(e, 'deciders'))) rows.push(`<b>결정자</b> ${seq(e.get('deciders')).map((x) => esc(py_str(x))).join(', ')}`)
    if (T(g(e, 'related_adr'))) rows.push(`<b>관련 ADR</b> ${seq(e.get('related_adr')).map((a) => link_adr(a, adr_ids)).join(', ')}`)
    if (T(g(e, 'based_on_adr'))) rows.push(`<b>근거 ADR</b> ${seq(e.get('based_on_adr')).map((a) => link_adr(a, adr_ids)).join(', ')}`)
    if (T(g(e, 'related_spec'))) rows.push(`<b>관련 스펙</b> ${seq(e.get('related_spec')).map((s) => link_spec(s, spec_ids)).join(', ')}`)
    if (T(g(e, 'supersedes'))) rows.push(`<b>대체함</b> ${seq(e.get('supersedes')).map((a) => link_adr(a, adr_ids)).join(', ')}`)
    if (T(g(e, 'superseded_by'))) rows.push(`<b>대체됨</b> ${link_adr(e.get('superseded_by'), adr_ids)}`)
    // ywr-harness ADR 0196: the underscore keys exist on ADRs only (a spec's narrows is ignored). An
    // empty list makes no row.
    if (T(g(e, '_narrows'))) rows.push(`<b>좁힘</b> ${e.get('_narrows').map((a) => link_adr(a, adr_ids)).join(', ')}`)
    if (T(g(e, '_narrowed_by'))) rows.push(`<b>좁혀짐</b> ${e.get('_narrowed_by').map((a) => link_adr(adr_num(a), adr_ids)).join(', ')}`)
    if (T(g(e, 'implements_in'))) rows.push(`<b>구현</b> ${seq(e.get('implements_in')).map((p) => `<code>${esc(p)}</code>`).join(', ')}`)
  }
  let panel = `<div class="meta">${rows.map((r) => `<span>${r}</span>`).join('')}</div>`
  if (T(g(e, 'tags'))) {
    panel += `<div class="tags">${seq(e.get('tags')).map((t) => `<span class="tag">${esc(py_str(t))}</span>`).join('')}</div>`
  }
  return panel
}

const SEARCH_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`

const JS = `
(function(){
  var tabs=[].slice.call(document.querySelectorAll('.tab'));
  var panels=[].slice.call(document.querySelectorAll('.tabpanel'));
  function showTab(name){
    tabs.forEach(function(t){t.setAttribute('aria-selected', String(t.dataset.tab===name));});
    panels.forEach(function(p){p.classList.toggle('on', p.dataset.tab===name);});
  }
  function ensureDefault(kind){
    var main=document.querySelector('.docmain[data-kind="'+kind+'"]');
    if(main && !main.querySelector('.doc.on')){
      var first=main.querySelector('.doc');
      if(first){first.classList.add('on'); mark(first.id);}
    }
  }
  function mark(target){
    document.querySelectorAll('.docitem').forEach(function(b){
      b.setAttribute('aria-current', String(b.dataset.target===target));});
  }
  function showDoc(target){
    var kind=target.split('-')[0];
    showTab(kind);
    document.querySelectorAll('.doc').forEach(function(d){d.classList.toggle('on', d.id===target);});
    mark(target);
    var it=document.querySelector('.docitem[data-target="'+target+'"]');
    if(it) it.scrollIntoView({block:'nearest'});
    window.scrollTo({top:0,behavior:'smooth'});
  }
  tabs.forEach(function(t){t.addEventListener('click',function(){
    showTab(t.dataset.tab); ensureDefault(t.dataset.tab);
    history.replaceState(null,'','#tab-'+t.dataset.tab);
  });});
  document.querySelectorAll('[data-target]').forEach(function(el){
    el.addEventListener('click',function(ev){
      if(el.tagName==='A') ev.preventDefault();
      var t=el.dataset.target; if(t){showDoc(t); history.replaceState(null,'','#'+t);}
    });
  });
  document.querySelectorAll('.search input').forEach(function(inp){
    inp.addEventListener('input',function(){
      var q=inp.value.toLowerCase(), list=inp.closest('.doclist');
      list.querySelectorAll('.docitem').forEach(function(it){
        it.classList.toggle('hidden', !!q && it.dataset.search.indexOf(q)===-1);});
    });
  });
  function fromHash(){
    var h=(location.hash||'').slice(1);
    if(h.indexOf('tab-')===0){showTab(h.slice(4));}
    else if(h && document.getElementById(h)){showDoc(h);}
    else {showTab('overview');}
    ['adr','spec'].forEach(ensureDefault);
  }
  window.addEventListener('hashchange',fromHash);
  fromHash();
})();
`

function doc_item(e, kind) {
  const search = (py_str(gd(e, 'title', '')) + ' ' + e.get('id') + ' ' +
    seq(T(g(e, 'tags')) ? e.get('tags') : []).map(py_str).join(' ')).toLowerCase()
  const short_id = e.get('id').replace(/^0+/, '') || '0'
  return `<button class="docitem" data-target="${kind}-${esc(e.get('id'))}" data-search="${esc(search)}">` +
    `<div class="di-top"><span class="di-id">${esc(short_id)}</span>${badge(g(e, 'status'))}</div>` +
    `<div class="di-title">${esc(gd(e, 'title', ''))}</div></button>`
}

function doc_article(e, kind, adr_ids, spec_ids, customer = false) {
  const kicker = kind === 'adr' ? 'ADR · 왜 그렇게 정했나' : 'SPEC · 지금 어떻게'
  return `<article class="doc" id="${kind}-${esc(e.get('id'))}">` +
    `<div class="doc-kicker">${kicker}</div>` +
    `<h2 class="doc-h">${esc(e.get('id'))} · ${esc(gd(e, 'title', ''))}</h2>` +
    `${meta_panel(e, adr_ids, spec_ids, customer)}<div class="body">${e.get('_body_html')}</div></article>`
}

function pane(kind, label, entries, adr_ids, spec_ids, customer = false) {
  const items = entries.map((e) => doc_item(e, kind)).join('')
  const articles = entries.map((e) => doc_article(e, kind, adr_ids, spec_ids, customer)).join('')
  return `<div class="tabpanel" data-tab="${kind}"><div class="docview">` +
    `<aside class="doclist"><div class="search">${SEARCH_ICON}` +
    `<input type="search" placeholder="${label} 검색 (제목·태그·번호)" aria-label="검색"></div>${items}</aside>` +
    `<div class="docmain" data-kind="${kind}">${articles}</div></div></div>`
}

function overview(adrs, specs, customer = false) {
  const row = (e, kind) => {
    // The relations column is an internal cross-reference too: the customer surface never renders it
    // (the same rule as meta_panel).
    let relations
    if (customer) relations = '—'
    else if (kind === 'adr') {
      const rel = []
      if (T(g(e, 'related_spec'))) rel.push('spec ' + seq(e.get('related_spec')).map(py_str).join(', '))
      if (T(g(e, 'related_adr'))) rel.push('adr #' + seq(e.get('related_adr')).map(py_str).join(', #'))
      relations = rel.join(' · ') || '—'
    } else {
      relations = T(g(e, 'based_on_adr')) ? '근거 adr #' + seq(e.get('based_on_adr')).map(py_str).join(', #') : '—'
    }
    return `<tr class="clickable" data-target="${kind}-${esc(e.get('id'))}"><td><span class="lnk">${kind.toUpperCase()} ${esc(e.get('id'))}</span></td>` +
      `<td>${esc(gd(e, 'title', ''))}</td><td>${badge(g(e, 'status'))}</td><td>${esc(py_str(T(g(e, 'date')) ? e.get('date') : T(g(e, 'updated')) ? e.get('updated') : '—'))}</td><td class="rel">${esc(relations)}</td></tr>`
  }
  const rows = adrs.map((e) => row(e, 'adr')).join('') + specs.map((e) => row(e, 'spec')).join('')
  const accepted = adrs.filter((e) => g(e, 'status') === 'accepted').length
  return '<div class="tabpanel on" data-tab="overview">' +
    '<div class="ov-grid">' +
    `<div class="stat"><div class="n">${adrs.length}</div><div class="l">결정 (ADR)</div></div>` +
    `<div class="stat"><div class="n">${specs.length}</div><div class="l">스펙 (Spec)</div></div>` +
    `<div class="stat"><div class="n">${accepted}</div><div class="l">Accepted ADR</div></div>` +
    `<div class="stat"><div class="n">${adrs.length + specs.length}</div><div class="l">총 문서</div></div>` +
    '</div>' +
    '<div class="ov-sec">전체 문서 — 행 클릭 시 해당 문서로 이동</div>' +
    '<table class="ov-table"><thead><tr><th>문서</th><th>제목</th><th>상태</th>' +
    `<th>날짜</th><th>관계</th></tr></thead><tbody>${rows}</tbody></table>` +
    '<div class="ov-sec">규칙 — ADR은 <b>왜</b>(불변, append-only) · Spec은 <b>지금 어떻게</b>(living). ' +
    'frontmatter가 단일 진실원, 기계질의는 <code>index.json</code>.</div>' +
    '</div>'
}

/**
 * The header and the body (`<header>...</header><main>...</main>`), the markup every wrapper shares.
 * `site_title_in` and `version_stamp` serve the customer whitelist surface only (the default build uses
 * the site title and no stamp). With `customer` true, meta_panel and overview leave out the deciders and
 * every internal cross-reference row.
 */
function build_shell(adrs, specs, site_title_in = null, customer = false, version_stamp = null) {
  const title = site_title_in || site_title()
  const adr_ids = new Set(adrs.map((e) => e.get('id')))
  const spec_ids = new Set(specs.map((e) => e.get('id')))
  const tabs = '<button class="tab" data-tab="overview" aria-selected="true">개요</button>' +
    `<button class="tab" data-tab="adr">ADR<span class="ct">${adrs.length}</span></button>` +
    `<button class="tab" data-tab="spec">SPEC<span class="ct">${specs.length}</span></button>`
  const body = overview(adrs, specs, customer) +
    pane('adr', 'ADR', adrs, adr_ids, spec_ids, customer) +
    pane('spec', 'SPEC', specs, adr_ids, spec_ids, customer)
  const sub = version_stamp ? `<span class="sub">${esc(version_stamp)}</span>` : ''
  return '<header class="app"><div class="app-in">' +
    `<div class="app-title"><h1>${esc(title)}</h1>${sub}` +
    `</div><div class="tabs">${tabs}</div></div></header>` +
    `<main>${body}</main>` +
    `<footer class="cpy">${esc(COPYRIGHT)}</footer>`
}

// The standalone page for people (GitHub Pages hosting).
function build_html(adrs, specs) {
  return '<!doctype html><html lang="ko"><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${esc(site_title())}</title><style>${CSS}</style></head><body>` +
    `${build_shell(adrs, specs)}<script>${JS}</script></body></html>`
}

// The single self-contained customer file docs/customer.html, for mail attachments. It takes only the
// documents with `audience: customer` (a whitelist), so an internal document cannot slip in: the
// default is internal, and a missing value excludes the document. Zero documents is an error with exit
// 1, because an empty file must never go out.
function local_date() {
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

function build_customer(adrs, specs, version) {
  const c_adrs = adrs.filter((e) => g(e, 'audience') === 'customer')
  const c_specs = specs.filter((e) => g(e, 'audience') === 'customer')
  if (!c_adrs.length && !c_specs.length) {
    sys_exit('[오류] audience: customer 문서가 없습니다 — 빈 파일 발송을 막기 위해 중단합니다.')
  }
  const title = process.env.DOCS_CUSTOMER_TITLE || (site_title() + ' — 고객 배포판')
  const today = local_date()
  const stamp = version ? `${version} · ${today}` : today
  const html = '<!doctype html><html lang="ko"><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${esc(title)}</title><style>${CSS}</style></head><body>` +
    `${build_shell(c_adrs, c_specs, title, true, stamp)}<script>${JS}</script></body></html>`
  fs.writeFileSync(OUT_CUSTOMER, html, 'utf8')
  const date_compact = today.replaceAll('-', '')
  const fname = version ? `customer-${version}-${date_compact}.html` : `customer-${date_compact}.html`
  out(`[OK] 고객 배포 표면 생성 (ADR ${c_adrs.length} · SPEC ${c_specs.length}, audience: customer 화이트리스트)`)
  out('     - docs/customer.html')
  out(`     첨부 파일명 제안: ${fname}`)
}

// The claude.ai Artifact fragment. The host wraps the doctype, html, head and body tags, so none go in
// here. The title and meta tags stay for the gallery label.
function build_artifact(adrs, specs) {
  return `<title>${esc(site_title())}</title>` +
    '<meta name="description" content="ADR(결정)·Spec(스펙) 브라우징 — 소스(.md)에서 자동 생성">' +
    `<style>${CSS}</style>` +
    `${build_shell(adrs, specs)}<script>${JS}</script>`
}

// ------------------------------------------------------------------------------------------------
// Customer corpus surface
//
// When `.harness.json` declares `docs.customer` (not null), the per-program corpus
// `docs/customer/<Program>/{spec.md,user-guide.md,release-notes.md}` gives one repo-wide
// `docs/customer.artifact.html` (and an optional `docs/PROJECTS.md`). Only `customer_decl()` of the
// vendored `scripts/harness/harness_config.mjs` validates the declaration. This file holds no second
// validator: two validators diverge, and the customer surface then goes stale without a signal. The
// audience-whitelist surface above (build_customer, docs/customer.html) is separate.
// ------------------------------------------------------------------------------------------------
const CUSTOMER_FILES = ['spec.md', 'user-guide.md', 'release-notes.md']
const RECENT_GROUP_LABEL = '최근 업데이트'
// The css class of a default badge (FUT/UAT/PROD) is `rs-` plus the lower-cased tag, byte for byte what
// the consumer repo that used this vocabulary first had (rs-fut, rs-uat, rs-prod). Only a custom tag gets
// the helper class rs-mid or rs-fin, which tells the final stage from a middle one (see the CSS).
const KNOWN_STAGE_CLASSES = new Set(['rs-fut', 'rs-uat', 'rs-prod'])

// A UI display default fills in only when the declarer did not write the key at all: an explicit ""
// is an intended blank (the `declared` contract of customer_decl in the reader).
function declared(cfg, key, fallback) {
  return cfg.declared.includes(key) ? cfg[key] : fallback
}

/**
 * Load and check `docs.customer`. No declaration (absent or null) gives null, and the four-surface
 * build goes on. A declaration with no importable reader, an outdated reader, or a malformed
 * declaration exits 1 at once: a customer surface that silently goes stale is the defect this reader
 * exists to prevent.
 */
async function load_customer_decl() {
  const [root, raw] = find_declaration()
  const docs = is_dict(raw) ? pget(raw, 'docs') : null
  if (!is_dict(docs) || pget(docs, 'customer') === null) return null
  const hc_dir = path.join(root, 'scripts', 'harness')
  const reader_path = path.join(hc_dir, 'harness_config.mjs')
  let hc
  try {
    hc = await import(pathToFileURL(reader_path).href)
  } catch (e) {
    // The reader imports harness_git.mjs, so the failing module can be that dependency: name the cause.
    const cause = String((e && e.message) || e).split(/\r?\n/, 1)[0]
    sys_exit('[오류] .harness.json 의 docs.customer 가 선언됐지만 scripts/harness/harness_config.mjs ' +
             `를 import 할 수 없습니다 (${reader_path}: ${cause}) — 고객 표면은 이 리더 없이 빌드하지 않습니다. ` +
             '/ywr-harness:harness-init 로 툴체인을 다시 배치하세요.')
  }
  // A successful import is not the right reader. A vendored copy placed before docs.customer existed is
  // there, but it knows neither `customer_decl` nor `cfg.customer`: filling in the declaration first and
  // running init later is exactly this state, and dying with a bare error would break the rule that an
  // exit names the file and the path. An exception from the reader itself is handled the same way.
  const stale = '[오류] scripts/harness/harness_config.mjs 가 구버전입니다(docs.customer 를 모르는 ' +
    `리더: ${reader_path}) — 고객 표면은 이 리더로 빌드하지 않습니다. /ywr-harness:harness-init 을 ` +
    '먼저 재실행해 빌더와 리더를 함께 갱신한 뒤 다시 빌드하세요.'
  if (!('load' in hc) || !('customer_decl' in hc)) sys_exit(stale)
  let cfg
  let warns
  try {
    [cfg, warns] = hc.load(root)
  } catch (e) { // any exception of the reader becomes a named exit, never a traceback
    sys_exit(`[오류] scripts/harness/harness_config.mjs 의 load() 가 실패했습니다: ${reader_path} (${e.name}: ${e.message}) — ` +
             '고객 표면을 빌드할 수 없습니다.')
  }
  for (const w of warns) err(`warn: ${w}`)
  if (!is_dict(cfg) || !Object.hasOwn(cfg, 'customer')) sys_exit(stale)
  const cust = cfg.customer
  if (cust === null || cust === undefined) return null
  if (T(pget(cust, 'malformed'))) {
    sys_exit(`[오류] docs.customer 선언이 사용 불가(${cust.malformed}) — 고객 표면을 빌드할 수 없습니다. ` +
             '경고를 보고 선언을 고치세요.')
  }
  return cust
}

/**
 * Scan the program directories under docs.customer.dir: a list with one record per program.
 *
 * The corpus contract is fixed. Every subdirectory is a program and holds spec.md, user-guide.md and
 * release-notes.md, all three (a missing one fails at once and names all three). The program key of each
 * frontmatter equals the directory name, and title and updated are required. spec.md is the program
 * record and must also carry the declared chip_field (when not empty) and every key of
 * required_frontmatter. A directory that starts with "." or "_" and an entry that is no directory are
 * skipped silently.
 */
function collect_customer_docs(cfg, root) {
  const rel_dir = cfg.dir
  const directory = path.join(root, rel_dir)
  if (!is_dir(directory)) {
    sys_exit(`[오류] docs.customer.dir '${rel_dir}' 가 없습니다 — 고객 코퍼스 디렉터리가 필요합니다.`)
  }
  const group_field = cfg.group_field
  const project_field = cfg.project_field
  const chip_field = cfg.chip_field
  const required_fm = cfg.required_frontmatter
  const programs = []
  for (const name of sorted(fs.readdirSync(directory))) {
    const p = path.join(directory, name)
    if (!is_dir(p)) continue
    if (name.startsWith('.') || name.startsWith('_')) continue
    const docs = new Map()
    for (const fname of CUSTOMER_FILES) {
      const fpath = path.join(p, fname)
      if (!is_file(fpath)) {
        sys_exit(`[오류] ${rel_dir}/${name}/${fname} 없음 — 프로그램 디렉터리마다 ${CUSTOMER_FILES.join(' · ')} 가 모두 있어야 합니다.`)
      }
      const [meta, body] = parse_frontmatter(read_text(fpath))
      if (py_str(T(g(meta, 'program')) ? meta.get('program') : '') !== name) {
        sys_exit(`[오류] ${rel_dir}/${name}/${fname} frontmatter의 program(${py_repr(g(meta, 'program'))})이 디렉터리명(${py_repr(name)})과 다릅니다.`)
      }
      if (!T(g(meta, 'title'))) sys_exit(`[오류] ${rel_dir}/${name}/${fname} frontmatter에 title 이 없습니다.`)
      if (!T(g(meta, 'updated'))) sys_exit(`[오류] ${rel_dir}/${name}/${fname} frontmatter에 updated 가 없습니다.`)
      docs.set(fname, { meta, html: convert_body(strip_leading_h1(body.split('\n'))) })
    }
    const spec_meta = docs.get('spec.md').meta
    const missing = []
    if (chip_field && !T(g(spec_meta, chip_field))) missing.push(chip_field)
    for (const key of required_fm) {
      if (!T(g(spec_meta, key))) missing.push(key)
    }
    if (missing.length) {
      sys_exit(`[오류] ${rel_dir}/${name}/spec.md frontmatter에 다음 키가 없습니다: ${missing.join(', ')}`)
    }
    const release_html = mark_release_status(docs.get('release-notes.md').html, cfg.release_stages)
    programs.push({
      program: name,
      title: g(spec_meta, 'title'),
      updated: g(spec_meta, 'updated'),
      chip: chip_field && T(g(spec_meta, chip_field)) ? py_str(spec_meta.get(chip_field)) : '',
      group_value: T(g(spec_meta, group_field)) ? py_str(spec_meta.get(group_field)) : '',
      menu_name: T(g(spec_meta, 'menu_name')) ? py_str(spec_meta.get('menu_name')) : '',
      project: T(g(spec_meta, project_field)) ? py_str(spec_meta.get(project_field)) : '',
      release_html,
      // The release-note entry count is the number of H2 in the body. At 0 the program is left out of
      // the release-notes tab list.
      release_entries: docs.get('release-notes.md').html.split('<h2>').length - 1,
      spec_html: docs.get('spec.md').html,
      guide_html: docs.get('user-guide.md').html,
    })
  }
  return programs
}

/**
 * Replace the `[TAG]` token at the end of a release-notes H2 with the badge of the declared
 * release_stages. The default vocabulary (FUT/UAT/PROD) keeps the css class `rs-` plus the lower-cased
 * tag, byte for byte as the consumer repo that used it first; only a custom tag gets the helper class
 * rs-mid or rs-fin.
 */
function mark_release_status(html_text, stages) {
  if (!stages.length) return html_text
  const by_tag = new Map(stages.map((s) => [s.tag, s.label]))
  const final_tag = stages[stages.length - 1].tag
  const tags_re = stages.map((s) => re_escape(s.tag)).join('|')
  const rx = pyre(`<h2>(.*?)\\s*\\[(${tags_re})\\]</h2>`, 'g')
  return html_text.replace(rx, (m, head, tag) => {
    const label = by_tag.has(tag) ? by_tag.get(tag) : tag
    const base = 'rs-' + tag.toLowerCase()
    const cls = KNOWN_STAGE_CLASSES.has(base) ? base : base + (tag === final_tag ? ' rs-fin' : ' rs-mid')
    return `<h2>${py_rstrip(head)} <span class="relstat ${cls}">${esc(label)}</span></h2>`
  })
}

const RX_BADGE_H2 = pyre('<h2>(.*?)\\s*<span class="relstat ([\\w -]+)">[^<]*</span></h2>', 'g')

/**
 * Badge tidy-up for the article body: a release goes out per program, so the status is monotonic inside
 * the document (top is newest, older below). A repeated badge of the same status carries no information,
 * so it stays only on the top tagged entry and at each status change. The original release_html (which
 * `latest_release` parses for the feed card) stays as it is; only the rendering step filters.
 */
function dedupe_release_badges(html_text) {
  let last = null
  return html_text.replace(RX_BADGE_H2, (m, head, cls) => {
    if (cls === last) return `<h2>${py_rstrip(head)}</h2>`
    last = cls
    return m
  })
}

const RX_RELSTAT = pyre('class="relstat ([\\w -]+)"', 'g')

/**
 * The chip of a program in the list: the top badge decides. The final stage means complete, any other
 * means in progress, and no badged entry (changes that need no test) means no chip. A release goes out
 * per program, so the top badged entry of the document is the current state of the program, the same
 * model as `dedupe_release_badges`.
 */
function release_posture(p, stages) {
  if (!stages.length) return ''
  const final_tag = stages[stages.length - 1].tag
  const stats = [...p.release_html.matchAll(RX_RELSTAT)].map((m) => m[1])
  if (!stats.length) return ''
  const top_class = py_split(stats[0])[0] // mark_release_status always puts the base class first
  if (top_class === 'rs-' + final_tag.toLowerCase()) return '<span class="relstat rs-prod">완료</span>'
  return '<span class="relstat rs-going">진행 중</span>'
}

const RX_RELEASE_HEAD = pyre('<h2>([^<]+?)\\s*(?:<span class="relstat ([\\w -]+)">([^<]+)</span>)?</h2>', 'g')

// The five entities esc() writes. The captured heading text is output of esc() alone: every `&` in it
// opens one of these, so one left-to-right pass equals Python's `html.unescape` on this input.
const RX_ESC_ENTITY = /&(amp|lt|gt|quot|#39);/g
const ESC_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }
const html_unescape = (s) => s.replace(RX_ESC_ENTITY, (m, name) => ESC_ENTITY[name])

/**
 * The newest release-notes entry as [date, title, badge_html], or null. The common date key of the feed
 * and the recent group (always the date of the newest change). Only the date is compared: the maximum of
 * the whole string would break a same-date tie by the title code points and pick an arbitrary entry. For
 * the same date the entry higher in the document is the newest (cumulative history convention) and
 * stands for it.
 */
function latest_release(p) {
  const heads = [...p.release_html.matchAll(RX_RELEASE_HEAD)].map((m) => [m[1], m[2] ?? '', m[3] ?? ''])
  if (!heads.length) return null
  let best_date = cp_slice(heads[0][0], 0, 10)
  for (const h of heads) {
    const d = cp_slice(h[0], 0, 10)
    if (cmp(d, best_date) > 0) best_date = d
  }
  const latest = heads.find((h) => cp_slice(h[0], 0, 10) === best_date)
  // The captured H2 text holds HTML-escaped entities (&quot; and the like). The feed card escapes it
  // again with esc(), which would show them twice, so the original text is restored here.
  const text = html_unescape(latest[0])
  const k = text.indexOf(' — ')
  const date = k === -1 ? text : text.slice(0, k)
  const title = k === -1 ? '' : text.slice(k + ' — '.length)
  const badge_html = latest[1] ? `<span class="relstat ${latest[1]}">${esc(latest[2])}</span>` : ''
  return [py_strip(date), py_strip(title) || py_strip(text), badge_html]
}

function group_key(group_value) {
  if (!group_value) return null
  return py_int_parse(py_strip(py_str(group_value).split(',')[0]).split('.')[0])
}

function customer_group(p, cfg) {
  const top = group_key(p.group_value)
  for (const gr of cfg.groups) {
    if (top !== null && gr.keys.includes(top)) return gr.label
  }
  if (top !== null) return declared(cfg, 'other_label', '기타')
  return declared(cfg, 'unkeyed_label', '기타 (분류 없음)')
}

/**
 * The ordered list of [label, [program]]: the pinned recent group first, then the declared groups in
 * order. The recent group holds the programs with a release history by newest change date, descending,
 * at most 8.
 */
function customer_sidebar_groups(programs, cfg) {
  const o = []
  let recent = []
  for (const p of programs) {
    const r = latest_release(p)
    if (r) recent.push([r[0], p])
  }
  recent = recent.map((x, idx) => [x, idx]).sort((a, b) => cmp(b[0][0], a[0][0]) || a[1] - b[1])
    .map(([x]) => x[1]).slice(0, 8)
  if (recent.length) o.push([RECENT_GROUP_LABEL, recent])
  const grouped = new Map()
  for (const p of programs) {
    const label = customer_group(p, cfg)
    if (!grouped.has(label)) grouped.set(label, [])
    grouped.get(label).push(p)
  }
  const order = cfg.groups.map((gr) => gr.label)
  order.push(declared(cfg, 'other_label', '기타'), declared(cfg, 'unkeyed_label', '기타 (분류 없음)'))
  const seen = new Set()
  for (const label of order) {
    if (seen.has(label) || !grouped.has(label)) continue
    seen.add(label)
    o.push([label, grouped.get(label)])
  }
  return o
}

// The chip text. An HTML chip shows the frontmatter value as it is; `chip_suffix` goes only on the file
// form in PROJECTS.md (for example `xgglbsrp.p`). If the suffix spread to the screen chip, every chip
// of an existing consumer would change.
function chip_text(cfg, p, file_form = false) {
  if (!p.chip) return ''
  return p.chip + (file_form ? cfg.chip_suffix : '')
}

// The extra info chip (menu or group number plus name), only for a program where the value is known.
function group_chip(p) {
  const label = [p.group_value, p.menu_name].filter((x) => x).join(' ')
  if (!label) return ''
  return `<span class="chip">${esc(label)}</span>`
}

/**
 * docs/PROJECTS.md: the project_field value mapped to customer specs. GENERATED: the only source is the
 * project_field of the spec.md frontmatter and nobody edits the file by hand. A spec without a tag does
 * not appear here.
 */
function build_projects_md(programs, cfg) {
  const by_proj = new Map()
  for (const p of programs) {
    if (p.project) {
      if (!by_proj.has(p.project)) by_proj.set(p.project, [])
      by_proj.get(p.project).push(p)
    }
  }
  const lines = [
    '# PROJECTS — project → customer specs',
    '',
    '> GENERATED by `node docs/build.mjs` — do not hand-edit. Source of',
    `> truth = \`${cfg.dir}/<Program>/spec.md\` frontmatter \`${cfg.project_field}\`.`,
    '> A spec without the field is simply not listed here.',
    '',
  ]
  if (!by_proj.size) lines.push('(no project-tagged specs yet)', '')
  for (const proj of sorted(by_proj.keys())) {
    lines.push(`## #${proj}`)
    lines.push('')
    for (const p of [...by_proj.get(proj)].sort((a, b) => cmp(a.program, b.program))) {
      if (cfg.chip_field) lines.push(`- ${p.program} (\`${chip_text(cfg, p, true)}\`) — ${py_str(p.title)}`)
      else lines.push(`- ${p.program} — ${py_str(p.title)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ------------------------------------------------------------------------------------------------
// Customer artifact theme
// ------------------------------------------------------------------------------------------------
const CUSTOMER_CSS = `
:root{
  --bg:#f5f7f5;--surface:#ffffff;--surface-2:#f0f4f1;--ink:#1b2420;--ink-soft:#57635c;--ink-dim:#65706a;
  --line:#dce3de;--line-soft:#e7ece8;--accent:#1e6b4f;--accent-ink:#175540;--accent-soft:#e7f1ec;
  --code-bg:#eef2ef;--th-bg:#f0f4f1;--radius:12px;
  --ok:#2e7d4f;--ok-soft:#e4f1e9;--warn:#b07a1e;--warn-soft:#f7eeda;--crit:#b3452e;--crit-soft:#f8e7e2;
  --mono:'Cascadia Code',Consolas,'D2Coding',ui-monospace,monospace;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#121815;--surface:#1a221d;--surface-2:#1f2922;--ink:#e5ebe6;--ink-soft:#9cab9f;--ink-dim:#7c8b80;
    --line:#2a352e;--line-soft:#233029;--accent:#55b389;--accent-ink:#7cc9a5;--accent-soft:#1c3329;
    --code-bg:#212b25;--th-bg:#1f2922;
    --ok:#5cb885;--ok-soft:#17301f;--warn:#d8a44a;--warn-soft:#332812;--crit:#dd7a5f;--crit-soft:#391d15;
  }
}
:root[data-theme="dark"]{
  --bg:#121815;--surface:#1a221d;--surface-2:#1f2922;--ink:#e5ebe6;--ink-soft:#9cab9f;--ink-dim:#7c8b80;
  --line:#2a352e;--line-soft:#233029;--accent:#55b389;--accent-ink:#7cc9a5;--accent-soft:#1c3329;
  --code-bg:#212b25;--th-bg:#1f2922;
  --ok:#5cb885;--ok-soft:#17301f;--warn:#d8a44a;--warn-soft:#332812;--crit:#dd7a5f;--crit-soft:#391d15;
}
:root[data-theme="light"]{
  --bg:#f5f7f5;--surface:#ffffff;--surface-2:#f0f4f1;--ink:#1b2420;--ink-soft:#57635c;--ink-dim:#65706a;
  --line:#dce3de;--line-soft:#e7ece8;--accent:#1e6b4f;--accent-ink:#175540;--accent-soft:#e7f1ec;
  --code-bg:#eef2ef;--th-bg:#f0f4f1;
  --ok:#2e7d4f;--ok-soft:#e4f1e9;--warn:#b07a1e;--warn-soft:#f7eeda;--crit:#b3452e;--crit-soft:#f8e7e2;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15.5px/1.7 -apple-system,'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR','Segoe UI',sans-serif;
  -webkit-font-smoothing:antialiased}
a{color:var(--accent-ink)}
code{font-family:var(--mono);font-size:.88em;background:var(--code-bg);
  border:1px solid var(--line);border-radius:5px;padding:1px 6px;
  white-space:pre-wrap;overflow-wrap:break-word;word-break:break-all}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

header.cust-app{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--line)}
.cust-in{max-width:1280px;margin:0 auto;padding:16px 28px 0}
.eyebrow{font-size:12px;font-weight:600;letter-spacing:.08em;color:var(--accent-ink);text-transform:uppercase}
.toptabs{display:flex;gap:6px;margin-top:4px}
.toptab{appearance:none;border:0;background:none;color:var(--ink-dim);font:inherit;font-size:20px;
  font-weight:700;letter-spacing:-.02em;padding:8px 14px 12px;cursor:pointer;
  border-bottom:3px solid transparent;border-radius:10px 10px 0 0;
  display:flex;align-items:center;gap:10px}
.toptab:hover{color:var(--ink);background:var(--surface-2)}
.toptab[aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent)}
.toppanel{display:none}.toppanel.on{display:block}
.chip{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--accent-ink);
  background:var(--accent-soft);border:1px solid var(--line);border-radius:999px;padding:2px 11px;letter-spacing:0;
  white-space:nowrap}
.chip.mono{font-family:var(--mono)}

main.cust-main{max-width:1280px;margin:0 auto;padding:24px 28px 64px}
.docview{display:grid;grid-template-columns:300px 1fr;gap:26px;align-items:start}
.doclist{position:sticky;top:104px;max-height:calc(100vh - 128px);overflow:auto;
  display:flex;flex-direction:column;gap:8px;padding-right:6px;
  scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.doclist::-webkit-scrollbar{width:8px}
.doclist::-webkit-scrollbar-track{background:transparent}
.doclist::-webkit-scrollbar-thumb{background:var(--line);border-radius:999px}
.doclist::-webkit-scrollbar-thumb:hover{background:var(--accent)}
.search{position:sticky;top:0;z-index:2;background:var(--bg);padding-bottom:2px}
.search input{width:100%;background:var(--surface);border:1px solid var(--line);color:var(--ink);
  border-radius:9px;padding:9px 12px 9px 32px;font:inherit;font-size:13.5px}
.search input:focus{outline:none;border-color:var(--accent)}
.search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--ink-dim)}
.proglist{display:flex;flex-direction:column;gap:4px}
.pgroup{margin:0}
.pgroup.hidden{display:none}
.pghead{appearance:none;border:0;background:none;width:100%;cursor:pointer;display:flex;
  align-items:center;gap:8px;font:inherit;font-size:12px;font-weight:700;letter-spacing:.04em;
  color:var(--ink-soft);padding:7px 6px;border-radius:8px;text-align:left}
.pghead:hover{background:var(--surface-2);color:var(--ink)}
.pgarrow{font-size:10px;color:var(--ink-dim);transition:transform .12s}
.pghead[aria-expanded="true"] .pgarrow{transform:rotate(90deg)}
.pgcount{margin-left:auto;font-size:11px;font-weight:600;color:var(--ink-dim);
  background:var(--surface-2);border-radius:999px;padding:1px 8px}
.pgitems{display:none}
.pgitems.on{display:flex;flex-direction:column;gap:8px;margin:6px 0 4px}
.proglist.offmode{display:none}
.relflat{display:none;flex-direction:column;gap:14px}
.relflat.on{display:flex}
.relmonth{display:flex;flex-direction:column;gap:8px}
.relmonth.hidden{display:none}
.rm-head{font-size:12px;font-weight:700;letter-spacing:.04em;color:var(--ink-soft);
  padding:2px 6px;border-bottom:1px solid var(--line)}
.relitem{text-align:left;appearance:none;cursor:pointer;background:var(--surface);
  border:1px solid var(--line);border-radius:10px;padding:11px 13px;color:var(--ink);
  display:flex;flex-direction:column;gap:6px;font:inherit;transition:border-color .12s,background .12s}
.relitem:hover{border-color:var(--accent)}
.relitem[aria-current=true]{border-color:var(--accent);background:var(--accent-soft)}
.relitem.hidden{display:none}
.ri-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ri-date{font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--accent-ink)}
.ri-title{font-size:13.5px;font-weight:600;line-height:1.4}
.relstat{display:inline-block;font-size:11px;font-weight:700;line-height:1;
  padding:4px 9px;border-radius:999px;white-space:nowrap;vertical-align:2px}
.rs-fut{background:#e8862d;color:#241300}
.rs-uat{background:#f2c94c;color:#2b2100}
.rs-prod{background:var(--ok);color:var(--bg)}
.rs-going{background:#f2c94c;color:#2b2100}
/* 커스텀(비-기본) release_stages 태그 전용 보조 클래스 — 중간 단계는 웜톤, 최종 단계는 초록 */
.rs-mid{background:#f2c94c;color:#2b2100}
.rs-fin{background:var(--ok);color:var(--bg)}
.body h2 .relstat{margin-left:8px;font-size:12px}
.ri-sub{font-size:12px;color:var(--ink-soft);line-height:1.4}
.progitem{text-align:left;appearance:none;cursor:pointer;background:var(--surface);border:1px solid var(--line);
  border-radius:10px;padding:11px 13px;color:var(--ink);display:flex;flex-direction:column;gap:6px;
  font:inherit;transition:border-color .12s,background .12s}
.progitem:hover{border-color:var(--accent)}
.progitem[aria-current=true]{border-color:var(--accent);background:var(--accent-soft)}
.progitem.hidden{display:none}
.pi-title{font-size:13.5px;font-weight:600;line-height:1.4}
.pi-meta{display:flex;align-items:center;flex-wrap:nowrap;gap:6px;min-width:0}
.pi-meta .chip{flex:0 0 auto}
.chip.clip{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.pi-proj{min-width:0;display:flex}
.pi-proj .chip.clip{max-width:100%}
.pi-meta .chip,.pi-proj .chip{color:var(--ink)}
.pi-date{font-size:11.5px;color:var(--ink-dim);white-space:nowrap;align-self:flex-end}

.docmain{min-width:0}
.prog{display:none}.prog.on{display:block}
.prog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;
  position:sticky;top:var(--headh,64px);z-index:5;background:var(--bg);
  padding:10px 0 8px;margin-bottom:6px;border-bottom:1px solid var(--line-soft)}
.prog-head h2{flex:1 1 auto;min-width:0}
.prog-head .ptabs{flex-shrink:0;margin-top:4px}
.prog-head h2{margin:0;font-size:20px;font-weight:700;letter-spacing:-.015em;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ptabs{display:flex;gap:4px}
.ptab{appearance:none;border:0;background:none;color:var(--ink-soft);font:inherit;font-size:14px;
  font-weight:600;padding:8px 14px;border-radius:8px 8px 0 0;cursor:pointer;border-bottom:2px solid transparent}
.ptab:hover{color:var(--ink);background:var(--surface-2)}
.ptab[aria-selected=true]{color:var(--accent-ink);border-bottom-color:var(--accent)}
.tabpanel{display:none;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  padding:26px 30px;margin-top:14px}
.tabpanel.on{display:block}

.body p{margin:12px 0}
.body ul,.body ol{margin:12px 0;padding-left:24px}
.body li{margin:6px 0}
.body li::marker{color:var(--accent-ink)}
.body h1,.body h2,.body h3,.body h4{color:var(--ink);letter-spacing:-.01em}
.body h2{font-size:17px;margin:24px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line-soft)}
.body h3{font-size:15px;margin:18px 0 6px}
.body .tblwrap{margin:14px 0;overflow-x:auto;border:1px solid var(--line);border-radius:10px}
.body table{border-collapse:collapse;width:100%;margin:0;font-size:13.5px}
.body th,.body td{border-bottom:1px solid var(--line-soft);border-right:1px solid var(--line-soft);
  padding:9px 13px;text-align:left;vertical-align:top}
.body th{background:var(--th-bg);color:var(--ink-soft);font-weight:650;white-space:nowrap}
.body tr:last-child td{border-bottom:0}.body td:last-child,.body th:last-child{border-right:0}
.body blockquote{display:flex;gap:12px;background:var(--accent-soft);border:1px solid var(--line);
  border-left:3px solid var(--accent);border-radius:0 10px 10px 0;padding:14px 18px;margin:16px 0;
  font-size:14.5px;color:var(--ink)}
.body pre{background:var(--code-bg);border:1px solid var(--line);color:var(--ink);padding:15px 17px;
  border-radius:10px;overflow-x:auto;font:12.5px/1.6 var(--mono)}
.body pre .d-add{color:var(--ok)}.body pre .d-del{color:var(--crit)}.body pre .d-hunk{color:var(--accent-ink)}
.body strong{color:var(--ink);font-weight:700}

footer.cust-foot{max-width:1280px;margin:0 auto;padding:0 28px 40px;display:flex;
  justify-content:space-between;gap:16px;flex-wrap:wrap;color:var(--ink-dim);font-size:13px}
footer.cust-foot b{color:var(--ink-soft);font-weight:650}

@media(max-width:860px){
  .docview{grid-template-columns:1fr}
  .doclist{position:static;max-height:40vh;order:-1}
  .docmain{order:0}
  .prog-head{flex-wrap:wrap}
}
.prog-head .chip{white-space:normal;word-break:keep-all}
.noresult{padding:14px 6px;font-size:13px;color:var(--ink-dim);text-align:center}
.noresult[hidden]{display:none}
.projtag{margin-top:26px;padding-top:14px;border-top:1px solid var(--line-soft)}
.proj-chip{appearance:none;cursor:pointer;font:600 12.5px/1 var(--mono);
  color:var(--accent-ink);background:var(--accent-soft);border:1px solid var(--line);
  border-radius:999px;padding:6px 12px;word-break:keep-all}
.proj-chip:hover{border-color:var(--accent)}
`

const CUSTOMER_JS = `
(function(){
  var apphead=document.querySelector('header.cust-app');
  function setHeadH(){
    if(apphead){ document.documentElement.style.setProperty('--headh', apphead.offsetHeight+'px'); }
  }
  setHeadH(); window.addEventListener('resize', setHeadH);
  var toptabs=[].slice.call(document.querySelectorAll('.toptab'));
  var toppanels=[].slice.call(document.querySelectorAll('.toppanel'));
  function showTop(id){
    toptabs.forEach(function(t){t.setAttribute('aria-selected', String(t.dataset.top===id));});
    toppanels.forEach(function(p){p.classList.toggle('on', p.dataset.top===id);});
  }
  toptabs.forEach(function(t){
    t.addEventListener('click', function(){
      showTop(t.dataset.top);
      history.replaceState(null,'','#top-'+t.dataset.top);
    });
  });
  var progs=[].slice.call(document.querySelectorAll('.prog'));
  var items=[].slice.call(document.querySelectorAll('.progitem'));
  var inp=document.querySelector('.search input');
  var mode=(function(){
    var t=document.querySelector('.prog.on .ptab[aria-selected="true"]');
    return t ? t.dataset.tab : 'spec';
  })();
  var groups=[].slice.call(document.querySelectorAll('.pgroup'));
  function setOpen(g, open){
    var b=g.querySelector('.pghead');
    if(b){ b.setAttribute('aria-expanded', String(open)); }
    var it=g.querySelector('.pgitems');
    if(it){ it.classList.toggle('on', open); }
  }
  groups.forEach(function(g){
    var b=g.querySelector('.pghead');
    if(b){ b.addEventListener('click', function(){
      setOpen(g, b.getAttribute('aria-expanded')!=='true');
    }); }
  });
  var relflat=document.querySelector('.relflat');
  var relitems=[].slice.call(document.querySelectorAll('.relitem'));
  var proglist=document.querySelector('.proglist');
  var noresult=document.querySelector('.noresult');
  function applyFilter(){
    var q=(inp && inp.value || '').toLowerCase().replace(/\\s+/g,'');
    function hit(hay){ return hay.replace(/\\s+/g,'').indexOf(q)!==-1; }
    var rel=(mode==='release');
    if(proglist){ proglist.classList.toggle('offmode', rel); }
    if(relflat){ relflat.classList.toggle('on', rel); }
    if(inp){ inp.placeholder = rel ? '릴리즈 노트 검색 (날짜·변경·프로그램·프로젝트)'
                                   : '프로그램 검색 (제목·코드·분류·#프로젝트)'; }
    if(rel){
      relitems.forEach(function(it){
        it.classList.toggle('hidden', !!q && !hit(it.dataset.search));
      });
      [].slice.call(document.querySelectorAll('.relmonth')).forEach(function(mn){
        mn.classList.toggle('hidden', mn.querySelectorAll('.relitem:not(.hidden)').length===0);
      });
      if(noresult){ noresult.hidden = relitems.some(function(it){return !it.classList.contains('hidden');}); }
      return;
    }
    items.forEach(function(it){
      it.classList.toggle('hidden', !!q && !hit(it.dataset.search));
    });
    if(noresult){ noresult.hidden = items.some(function(it){return !it.classList.contains('hidden');}); }
    groups.forEach(function(g){
      var vis=g.querySelectorAll('.progitem:not(.hidden)').length;
      g.classList.toggle('hidden', vis===0);
      var c=g.querySelector('.pgcount'); if(c){ c.textContent=vis; }
      if(q && vis>0){ setOpen(g, true); }
    });
  }
  [].slice.call(document.querySelectorAll('.proj-chip')).forEach(function(b){
    b.addEventListener('click', function(){
      if(inp){ inp.value=b.dataset.q; applyFilter(); inp.focus(); }
    });
  });
  function showProg(id){
    progs.forEach(function(p){p.classList.toggle('on', p.id==='prog-'+id);});
    items.forEach(function(it){
      var cur=it.dataset.prog===id;
      it.setAttribute('aria-current', String(cur));
      if(cur){ var g=it.closest('.pgroup'); if(g){ setOpen(g, true); } }
    });
    relitems.forEach(function(it){ it.setAttribute('aria-current','false'); });
  }
  relitems.forEach(function(it){
    it.addEventListener('click', function(){
      showProg(it.dataset.prog);
      it.setAttribute('aria-current','true');
      var art=document.getElementById('prog-'+it.dataset.prog);
      if(art) mode=setTab(art, 'release');
      applyFilter();
      history.replaceState(null,'','#'+it.dataset.prog);
    });
  });
  function setTab(art, tab){
    var btn=art.querySelector('.ptab[data-tab="'+tab+'"]') || art.querySelector('.ptab');
    tab=btn.dataset.tab;
    art.querySelectorAll('.ptab').forEach(function(b){b.setAttribute('aria-selected', String(b===btn));});
    art.querySelectorAll('.tabpanel').forEach(function(p){p.classList.toggle('on', p.dataset.tab===tab);});
    return tab;
  }
  document.querySelectorAll('.ptab').forEach(function(t){
    t.addEventListener('click', function(){
      mode=setTab(t.closest('.prog'), t.dataset.tab);
      applyFilter();
    });
  });
  items.forEach(function(it){
    it.addEventListener('click', function(){
      showProg(it.dataset.prog);
      var art=document.getElementById('prog-'+it.dataset.prog);
      if(art) mode=setTab(art, mode);
      applyFilter();
      history.replaceState(null,'','#'+it.dataset.prog);
      it.scrollIntoView({block:'nearest'});
    });
  });
  document.querySelectorAll('.etab').forEach(function(t){
    t.addEventListener('click', function(){
      document.querySelectorAll('.etab').forEach(function(b){b.setAttribute('aria-selected', String(b===t));});
      document.querySelectorAll('.epanel').forEach(function(p){p.classList.toggle('on', p.dataset.env===t.dataset.env);});
    });
  });
  document.addEventListener('keydown', function(ev){
    if(ev.key!=='ArrowLeft' && ev.key!=='ArrowRight') return;
    var t=ev.target;
    if(!t || !t.classList) return;
    var sel = t.classList.contains('toptab') ? '.toptab'
            : t.classList.contains('ptab') ? '.ptab'
            : t.classList.contains('etab') ? '.etab' : null;
    if(!sel) return;
    var scope = sel==='.ptab' ? t.parentElement : document;
    var tabs=[].slice.call(scope.querySelectorAll(sel));
    var i=tabs.indexOf(t);
    if(i<0) return;
    ev.preventDefault();
    var n=tabs[(i+(ev.key==='ArrowRight'?1:tabs.length-1))%tabs.length];
    n.focus(); n.click();
  });
  if(inp){ inp.addEventListener('input', applyFilter); }
  function fromHash(){
    var h=(location.hash||'').slice(1);
    if(h.indexOf('top-')===0){showTop(h.slice(4));}
    else if(h && document.getElementById('prog-'+h)){
      showTop('docs'); showProg(h);
      var t=document.querySelector('#prog-'+h+' .ptab[aria-selected="true"]');
      if(t){ mode=t.dataset.tab; }
      applyFilter();
    }
  }
  window.addEventListener('hashchange', fromHash);
  fromHash();
  applyFilter();
})();
`

function customer_doc_item(cfg, p, first = false) {
  const fields = ['title', 'program', 'chip', 'group_value', 'menu_name'].map((k) => py_str(T(p[k]) ? p[k] : ''))
  if (p.project) {
    // Added with the '#', so '#name' and the bare name both match as a partial.
    fields.push('#' + p.project)
  }
  const search = fields.join(' ').toLowerCase()
  const ctext = chip_text(cfg, p)
  let chips = ctext ? `<span class="chip mono">${esc(ctext)}</span>` : ''
  const group_short = p.group_value || p.menu_name || ''
  if (group_short) chips += `<span class="chip clip">${esc(group_short)}</span>`
  const group_full = [p.group_value, p.menu_name].filter((x) => x).join(' ')
  const tooltip = [ctext, group_full].filter((x) => x).join(' · ')
  let proj_row = ''
  if (p.project) {
    proj_row = `<div class="pi-proj" title="#${esc(p.project)}"><span class="chip clip">#${esc(p.project)}</span></div>`
  }
  return `<button type="button" class="progitem" data-prog="${esc(p.program)}" data-search="${esc(search)}"` +
    ` data-hasrel="${p.release_entries > 0 ? '1' : '0'}" aria-current="${first ? 'true' : 'false'}">` +
    `<div class="pi-title">${esc(T(p.title) ? p.title : '')}</div>` +
    `<div class="pi-meta" title="${esc(tooltip)}">${chips}</div>${proj_row}` +
    `<div class="pi-date">${esc(py_str(T(p.updated) ? p.updated : ''))}</div>` +
    '</button>'
}

/**
 * The program article: the tabs run release notes, spec, user guide. The release-notes tab shows for
 * every program: with no history, the notice text (the release-notes.md body) shows as it is. The
 * default tab is the release notes when there is a history, else the spec.
 */
function customer_program_article(cfg, p, first = false) {
  const has_rel = p.release_entries > 0
  const tabs = [['release', '릴리즈 노트'], ['spec', '명세'], ['guide', '사용자 가이드']]
  const dflt = has_rel ? 'release' : 'spec'
  let spec_html = p.spec_html
  if (p.project) {
    spec_html += `<div class="projtag"><button type="button" class="proj-chip" data-q="#${esc(p.project)}">` +
      `#${esc(p.project)}</button></div>`
  }
  const html_map = { release: dedupe_release_badges(p.release_html), spec: spec_html, guide: p.guide_html }
  const tab_btns = tabs.map(([k, label]) =>
    `<button type="button" class="ptab" role="tab" data-tab="${k}" aria-selected="${k === dflt ? 'true' : 'false'}">${label}</button>`).join('')
  const panes = tabs.map(([k]) =>
    `<div class="tabpanel${k === dflt ? ' on' : ''}" role="tabpanel" data-tab="${k}"><div class="body">${html_map[k]}</div></div>`).join('')
  const ctext = chip_text(cfg, p)
  const chip_html = ctext ? `<span class="chip mono">${esc(ctext)}</span>` : ''
  return `<article class="prog${first ? ' on' : ''}" id="prog-${esc(p.program)}">` +
    `<div class="prog-head"><h2>${esc(T(p.title) ? p.title : '')} ${chip_html}${group_chip(p)}</h2>` +
    `<div class="ptabs" role="tablist">${tab_btns}</div></div>${panes}</article>`
}

/**
 * Load docs.customer.panels[]: each entry is a repo-relative `.mjs` module path plus a tab label. The
 * module exports render_panel(repo_root) -> string, and may export `CSS` (a string appended inside the
 * style element), `UPDATED` (an ISO date of its own content, which joins the maximum of the footer date)
 * and `TAB_CHIPS` (a list of chip strings for the tab button, in the place of the count chip of the
 * documents tab). The path check belongs to the panels validation of `harness_config.mjs`: this function
 * takes validated values only and names a missing file or a failed load here.
 */
export async function _load_panels(cfg, root) {
  const panels = []
  const used_ids = new Set(['docs'])
  const decls = T(pget(cfg, 'panels')) ? cfg.panels : []
  for (const [i, decl] of decls.entries()) {
    const mod_rel = is_dict(decl) ? pget(decl, 'module') : null
    const decl_label = is_dict(decl) ? pget(decl, 'label') : null
    const label = T(decl_label) ? decl_label : `패널 ${i + 1}`
    if (!T(mod_rel)) sys_exit(`[오류] docs.customer.panels[${i}] 에 module 이 없습니다.`)
    // A panel is code the builder imports, so only an `.mjs` module can be one. A module of another kind
    // (a `.py` panel kept from before the Node port) refuses the whole build here, before any surface is
    // written, rather than dropping the tab with a warning: a silent drop would leave the customer surface
    // without a tab that its readers expect.
    if (!py_str(mod_rel).endsWith('.mjs')) {
      sys_exit(`[오류] docs.customer.panels[${i}] 의 모듈 '${py_str(mod_rel)}' 은 .mjs 모듈이어야 합니다 — ` +
               '패널은 render_panel(repoRoot) 를 내보내는 .mjs 모듈이어야 하며 CSS, UPDATED, TAB_CHIPS 는 선택입니다.')
    }
    const mod_path = path.isAbsolute(py_str(mod_rel)) ? py_str(mod_rel) : path.join(root, py_str(mod_rel))
    if (!is_file(mod_path)) sys_exit(`[오류] docs.customer.panels 모듈을 찾을 수 없습니다: ${mod_path}`)
    let mod
    try {
      mod = await import(pathToFileURL(mod_path).href)
    } catch (e) {
      sys_exit(`[오류] 패널 모듈을 import 할 수 없습니다: ${mod_path} (${e && e.message})`)
    }
    if (!('render_panel' in mod)) {
      sys_exit(`[오류] 패널 모듈에 render_panel(repo_root) 함수가 없습니다: ${mod_path}`)
    }
    // The render call sits under the same guard as the import: a common slip in code the customer writes
    // (a missing file, a type error) must end in an exit that names the module, not in a traceback. The
    // return type is part of the contract: anything but a string cannot be attached as a fragment.
    let html_frag
    try {
      html_frag = mod.render_panel(root)
    } catch (e) {
      sys_exit(`[오류] 패널 모듈의 render_panel() 이 실패했습니다: ${mod_path} (${e && e.name}: ${e && e.message})`)
    }
    if (typeof html_frag !== 'string') {
      sys_exit(`[오류] 패널 모듈의 render_panel() 은 HTML 문자열(str)을 반환해야 합니다: ${mod_path} ` +
               `(반환 타입 ${py_type_name(html_frag)})`)
    }
    const css = T(mod.CSS) ? mod.CSS : ''
    if (typeof css !== 'string') {
      sys_exit(`[오류] 패널 모듈의 CSS 는 문자열이어야 합니다: ${mod_path} (타입 ${py_type_name(css)})`)
    }
    // The reader fixes the tab id (the declared `id`, else a slug of the label or `panel-N`; the
    // default_tab check must see the same set, so one place decides). Only a builder paired with an
    // older reader that gives no id fills it in itself, by the label slug or `panel-N` rule. The build
    // does not stop, and the new key stays as an unknown-key warning.
    let pid = is_dict(decl) ? pget(decl, 'id') : null
    if (!T(pid)) {
      // The fallback of an older reader also prevents a duplicate: two equal data-top values would make
      // showTop turn both panels on at once. The label slug, else the first free panel-N.
      pid = strip_chars(py_str(label).toLowerCase().replace(/[^a-z0-9]+/g, '-'), '-')
      if (!pid || used_ids.has(pid)) {
        let n = i
        while (used_ids.has(`panel-${n}`)) n += 1
        pid = `panel-${n}`
      }
    }
    used_ids.add(pid)
    // Optional module attributes. UPDATED is an ISO date of the module's own content and joins the
    // maximum of the footer date (the no-clock rule holds: the module speaks for its own content, it is
    // not today's date). TAB_CHIPS is a list of chip strings inside the tab button, in the place of the
    // count chip of the documents tab. A wrong type exits and names the module, as CSS does: dropping it
    // silently would hide that the contract exists.
    const updated = mod.UPDATED === undefined ? null : mod.UPDATED
    if (updated !== null && !(typeof updated === 'string' && RX_ISO_DATE.test(updated))) {
      sys_exit(`[오류] 패널 모듈의 UPDATED 는 'YYYY-MM-DD' 문자열이어야 합니다: ${mod_path} (값 ${py_repr(updated)})`)
    }
    let chips = mod.TAB_CHIPS === undefined ? null : mod.TAB_CHIPS
    if (chips === null) chips = []
    if (!Array.isArray(chips) || !chips.every((c) => typeof c === 'string')) {
      sys_exit(`[오류] 패널 모듈의 TAB_CHIPS 는 문자열 목록이어야 합니다: ${mod_path}`)
    }
    const position = is_dict(decl) && T(pget(decl, 'position')) ? decl.position : 'after-docs'
    panels.push({ id: pid, label, html: html_frag, css, module: py_str(mod_rel), position,
      updated: updated || '', chips: [...chips] })
  }
  // Isolation is a scope class plus the author's discipline: the CSS is not rewritten. Only a selector
  // that touches a class name of the canon or of another panel outside `.panel-<id>` warns, as one line
  // on stderr and never as a refusal. A unique name (`.pm-card`) stays quiet: a leak needs a name clash.
  for (const pl of panels) {
    const others = css_classes(CUSTOMER_CSS)
    for (const q of panels) {
      if (q !== pl) for (const c of css_classes(q.css)) others.add(c)
    }
    for (const [sel, cls] of leaking_selectors(pl.css, pl.id, others)) {
      err(`[경고] 패널 CSS 의 선택자 '${sel}' 가 캐논/다른 패널의 클래스 '.${cls}' 를 스코프 없이 덮어씁니다 — ` +
          `'.panel-${pl.id} ${sel}' 처럼 스코프하세요 (${pl.module})`)
    }
  }
  return panels
}

const RX_ISO_DATE = pyre('^\\d{4}-\\d{2}-\\d{2}\\Z')
const RX_ATTR_SEL = pyre('\\[[^\\]]*\\]', 'g')
const RX_QUOTED = pyre('"[^"]*"|\'[^\']*\'', 'g')
const RX_CLASS_NAME = pyre('\\.([A-Za-z_-][\\w-]*)', 'g')
const RX_CSS_COMMENT = pyre('/\\*.*?\\*/', 'gs')
const RX_DECL_BLOCK = pyre('\\{[^{}]*\\}', 'g')
const RX_AT_STATEMENT = pyre('@[a-zA-Z-]+[^{;]*;', 'g')
const RX_AT_OPEN = pyre('@[a-zA-Z-]+[^{]*\\{', 'g')
const RX_RULE_HEAD = pyre('([^{}]+)\\{', 'g')

// The class names of a selector text. An attribute selector (`[href$=".mono"]`) and a `.` inside a quoted
// string are no classes, so they go first (the source of false alarms).
function selector_classes(sel) {
  sel = sel.replace(RX_ATTR_SEL, '').replace(RX_QUOTED, '')
  return [...sel.matchAll(RX_CLASS_NAME)].map((m) => m[1])
}

// The set of class names that CSS text uses in selectors (a value such as `.png` inside a declaration
// block is left out).
function css_classes(css) {
  let text = (css || '').replace(RX_CSS_COMMENT, '')
  text = text.replace(RX_DECL_BLOCK, '{}')
  return new Set(selector_classes(text))
}

/**
 * Find the selectors of a panel CSS that touch a class in `other_classes` (the canon and the other panels)
 * and own no class of the panel: such a rule lands later at the same specificity and overrides the
 * documents tab (for example a `.mono` or `.clip` rule of the panel). A class unique to the panel
 * anywhere in the selector (`.envpanel .mono`, `.pm-dom.on`) limits the rule to that element and its
 * descendants, so the selector counts as scoped. This is a heuristic: it strips comments and at-rule
 * heads, then reads only the selector list of each rule. The result is a list of (selector, overlapping
 * class) pairs.
 */
function leaking_selectors(css, pid, other_classes) {
  let text = (css || '').replace(RX_CSS_COMMENT, '')
  text = text.replace(RX_AT_STATEMENT, '') // @import and @charset
  text = text.replace(RX_AT_OPEN, '') // only the opening of @media and the like
  const scope = `panel-${pid}`
  const found = []
  for (const m of text.matchAll(RX_RULE_HEAD)) {
    for (let sel of m[1].split(',')) {
      sel = py_strip(sel)
      if (!sel) continue
      const classes = selector_classes(sel)
      const hit = classes.filter((c) => other_classes.has(c))
      const owned = classes.filter((c) => !other_classes.has(c) || c === scope)
      if (hit.length && !owned.length) found.push([sel, hit[0]])
    }
  }
  return found
}

const RX_TAGS = pyre('<[^>]+>', 'g')

/**
 * docs/customer.artifact.html: the claude.ai Artifact fragment (the host wraps doctype, html, head and
 * body; the contract of build_artifact). No internal document (ADR or spec), repository path or internal
 * cross-reference ever renders on this customer surface. No clock: the newest `updated` value of the
 * corpus stands for the document creation date, so one corpus gives the same bytes whenever it is built.
 */
function build_customer_artifact(programs, cfg, panels) {
  const title = declared(cfg, 'title', site_title() + ' — 고객 문서')
  const eyebrow = declared(cfg, 'eyebrow', '고객 문서')
  const description = declared(cfg, 'description', '프로그램별 릴리즈 노트·명세·사용자 가이드')
  let contact_row = ''
  if (cfg.declared.includes('contact')) contact_row = `<span><b>문의처</b> — ${esc(cfg.contact)}</span>`
  const count = programs.length
  const rel_count = programs.filter((p) => p.release_entries > 0).length

  let relitems = []
  for (const p of programs) {
    const r = latest_release(p)
    if (r) relitems.push([r[0], r[1], release_posture(p, cfg.release_stages), p])
  }
  relitems = relitems.map((x, idx) => [x, idx]).sort((a, b) => cmp(b[0][0], a[0][0]) || a[1] - b[1]).map(([x]) => x)
  const months = new Map()
  relitems.forEach(([date, rtitle, badge_html, p], idx) => {
    const ym = cp_slice(date, 0, 7)
    if (!months.has(ym)) months.set(ym, [])
    months.get(ym).push([idx, date, rtitle, badge_html, p])
  })
  const month_head = (ym) => {
    const y4 = cp_slice(ym, 0, 4)
    if (Array.from(ym).length >= 7 && y4 && /^\p{Nd}+$/u.test(y4)) {
      const mm = py_int_parse(cp_slice(ym, 5, 7))
      if (mm === null) throw named_error('ValueError', `invalid literal for int() with base 10: ${py_repr(cp_slice(ym, 5, 7))}`)
      return `${py_int(y4)}년 ${mm}월`
    }
    return ym || '날짜 미상'
  }
  const relflat = [...months.entries()].sort((a, b) => cmp(b[0], a[0])).map(([ym, entries]) =>
    `<div class="relmonth"><div class="rm-head">${esc(month_head(ym))}</div>${entries.map(([idx, date, rtitle, badge_html, p]) =>
      `<button type="button" class="relitem" data-prog="${esc(p.program)}" data-ri="${idx}" data-search="${
        esc((date + ' ' + rtitle + ' ' + chip_text(cfg, p) + ' ' + py_str(T(p.title) ? p.title : '') +
          (badge_html ? ' ' + badge_html.replace(RX_TAGS, '') : '') +
          (p.project ? ' #' + p.project : '')).toLowerCase())}">` +
      `<div class="ri-top"><span class="ri-date">${esc(date)}</span><span class="chip mono">${esc(chip_text(cfg, p))}</span></div>` +
      `<div class="ri-title">${esc(py_str(T(p.title) ? p.title : ''))}</div><div class="ri-sub">${esc(rtitle)}${badge_html ? ' ' + badge_html : ''}</div></button>`).join('')}</div>`).join('')
  // The first article is the head of the "recent updates" group (the newest release date; the same date
  // keeps the sort order). That group is open on first paint, so the selection starts there.
  // programs[0] is the first directory in ASCII order (upper case first), which makes a poor first
  // article. With no release history at all the fallback is programs[0]. The article and the sidebar
  // aria-current must read the same first_id: two criteria (i == 0 and first_id) would split the selection.
  const groups = customer_sidebar_groups(programs, cfg)
  const recent_group = groups.find(([label]) => label === RECENT_GROUP_LABEL)
  const recent = recent_group ? recent_group[1] : null
  const first_id = programs.length ? (recent ? recent[0] : programs[0]).program : ''
  // The open group is the recent group. In the fallback with no recent group, the group that holds
  // first_id opens: otherwise the aria-current item hides inside a collapsed (display:none) group.
  const opened_of = (label, members) => {
    if (recent) return label === RECENT_GROUP_LABEL
    return members.some((p) => p.program === first_id)
  }
  const items = groups.map(([label, members]) => {
    const opened = opened_of(label, members)
    return `<section class="pgroup"><button type="button" class="pghead" aria-expanded="${opened ? 'true' : 'false'}">` +
      `<span class="pgarrow">▸</span>${esc(label)}<span class="pgcount">${members.length}</span></button>` +
      `<div class="pgitems${opened ? ' on' : ''}">${members.map((p) => customer_doc_item(cfg, p, p.program === first_id)).join('')}</div></section>`
  }).join('')
  const articles = programs.map((p) => customer_program_article(cfg, p, p.program === first_id)).join('')
  // The footer date is the maximum of the corpus `updated` and the panel UPDATED values (no clock).
  const dates = [...programs.map((p) => py_str(T(p.updated) ? p.updated : '')), ...panels.filter((pl) => pl.updated).map((pl) => pl.updated)]
  const max_updated = dates.reduce((a, b) => (cmp(b, a) > 0 ? b : a), dates.length ? dates[0] : '')
  const footer_label = declared(cfg, 'footer_date_label', '문서 생성일')

  // Tab order: the before-docs panels (declared order), the documents tab, the after-docs panels (declared
  // order). The first selected tab is the declared default_tab, else the first tab in render order:
  // CUSTOMER_JS changes nothing on an empty hash, so the aria-selected and .on set here are the first
  // screen as it is.
  const docs_tab = { id: 'docs', chips: [`명세 ${count}건`, `릴리즈 노트 ${rel_count}건`] }
  const ordered = [...panels.filter((pl) => pl.position === 'before-docs'), docs_tab,
    ...panels.filter((pl) => pl.position !== 'before-docs')]
  const known_ids = ordered.map((t) => t.id)
  let initial = T(cfg.default_tab) ? cfg.default_tab : ''
  if (!known_ids.includes(initial)) initial = known_ids[0]

  const tab_button = (tid, label_html, chips) =>
    `<button type="button" class="toptab" role="tab" data-top="${esc(tid)}" aria-selected="${tid === initial ? 'true' : 'false'}">${label_html}` +
    `${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</button>`

  const docs_view = '<div class="docview">' +
    `<aside class="doclist"><div class="search">${SEARCH_ICON}` +
    '<input type="search" placeholder="프로그램 검색 (제목·코드·분류·#프로젝트)" aria-label="프로그램 검색"></div>' +
    `<div class="proglist">${items}</div>` +
    `<div class="relflat">${relflat}</div>` +
    '<div class="noresult" hidden>검색 결과가 없습니다</div></aside>' +
    `<div class="docmain">${articles}</div>` +
    '</div>'
  const top_tabs = []
  const top_panels = []
  let extra_css = ''
  for (const t of ordered) {
    const on = t.id === initial ? ' on' : ''
    if (t === docs_tab) {
      top_tabs.push(tab_button('docs', '문서 모음 ', t.chips))
      top_panels.push(`<div class="toppanel${on}" data-top="docs">${docs_view}</div>`)
      continue
    }
    top_tabs.push(tab_button(t.id, esc(t.label), t.chips))
    // The container carries the panel-<id> scope class: the panel CSS scopes its selectors under it.
    top_panels.push(`<div class="toppanel panel-${esc(t.id)}${on}" data-top="${esc(t.id)}">${t.html}</div>`)
    if (t.css) extra_css += t.css
  }

  const body = '<header class="cust-app"><div class="cust-in">' +
    `<div class="eyebrow">${esc(eyebrow)}</div>` +
    `<div class="toptabs" role="tablist">${top_tabs.join('')}</div>` +
    '</div></header>' +
    `<main class="cust-main">${top_panels.join('')}</main>` +
    `<footer class="cust-foot">${contact_row}<span>${esc(footer_label)} ${esc(max_updated)}</span></footer>`

  return `<title>${esc(title)}</title>` +
    `<meta name="description" content="${esc(description)}">` +
    `<style>${CUSTOMER_CSS}${extra_css}</style>` +
    `${body}<script>${CUSTOMER_JS}</script>`
}

function assert_(cond, msg) {
  if (!cond) throw named_error('AssertionError', msg)
}

/**
 * A build-time determinism gate for the release helpers. The badge and tie logic regresses silently (a
 * UAT chip can vanish from a card and nothing fails), so a synthetic fixture pins the contract. main()
 * never calls it: the selftest calls it directly through an import of this file (importing it has no
 * side effect beyond the lazy site title).
 */
export function _selfcheck_release_helpers() {
  const stages = [{ tag: 'FUT', label: 'FUT' }, { tag: 'UAT', label: 'UAT' },
    { tag: 'PROD', label: 'COMPLETE' }]
  const raw = '## 2026-08-14 — A-first [UAT]\n' +
    '## 2026-08-14 — Z-second\n' +
    '## 2026-08-03 — old [PROD]\n'
  const fx = { release_html: mark_release_status(convert_body(raw.split('\n')), stages) }
  const r = latest_release(fx)
  // The maximum of the whole string would pick Z-second on the same date. The entry higher in the
  // document must win.
  assert_(r && r[0] === '2026-08-14' && r[1] === 'A-first', `_latest_release tie-break regression: ${JSON.stringify(r)}`)
  assert_(release_posture(fx, stages).includes('진행 중'), 'posture: 활성 최상단 배지는 진행 중')
  const empty_fx = { release_html: mark_release_status(convert_body('## 2026-08-01 — x\n'.split('\n')), stages) }
  assert_(release_posture(empty_fx, stages) === '', 'posture: 배지 없는 문서는 무칩')
  const prod_fx = { release_html: mark_release_status(convert_body('## 2026-08-01 — x [PROD]\n'.split('\n')), stages) }
  assert_(release_posture(prod_fx, stages).includes('완료'), 'posture: 최상단 PROD 는 완료')
  // The check uses tags that the fixture carries (UAT and PROD). Asserting a [FUT] badge that the fixture
  // lacks would always fail.
  assert_(fx.release_html.includes('<span class="relstat rs-uat">UAT</span>') &&
          prod_fx.release_html.includes('<span class="relstat rs-prod">COMPLETE</span>'),
  '기본 어휘의 배지 클래스는 rs-uat/rs-prod 그대로, PROD 라벨은 COMPLETE (포크와 바이트 동일)')
}

// ------------------------------------------------------------------------------------------------
// Check mode
// ------------------------------------------------------------------------------------------------
// The base of every <rel> (repo-root-relative, forward slash): the parent of ROOT (docs/).
const repo_root = () => path.dirname(ROOT)

// REQUIRED: the surfaces the docs-as-code contract demands as committed. The scaffold gitignore
// template does not ignore these three (and PROJECTS.md when declared), docs.yml and every consumer
// assume they exist. A missing one is MISSING (counted as a failure, exit 1): a deleted committed
// surface never passes silently. OPTIONAL: a render the template gitignores; absence is ABSENT (skipped).
const REQUIRED_OUTPUTS = [OUT_JSON, OUT_INDEX_MD, OUT_PROJECTS]

/**
 * The one assembly that the build path and --check share: collect, the empty-corpus guard, the customer
 * corpus (when declared) and the outputs list. If the two paths each copied the assembly, that alone
 * would cause silent drift (they would compare and generate different surface lists), so only one place
 * makes it. Every failure is reported through sys_exit(<Korean message>): the default build path ends
 * the process on it, and the --check path (run_check) catches it and reports REFUSED, which differs from DRIFT.
 */
async function assemble() {
  const adrs = collect(ADR_DIR)
  const specs = collect(SPEC_DIR)
  if (!adrs.length && !specs.length) sys_exit('adr/·spec/ 에서 frontmatter 포함 .md 를 찾지 못했습니다.')
  resolve_narrows(adrs) // ywr-harness ADR 0196: a bad narrows is refused here (--check reports REFUSED)

  // Every surface is built in memory first. If a refusal of the customer surface (sys_exit) left a
  // half product where only the four surfaces were rewritten, a caller that never reads the exit code
  // would commit "internal docs current, customer docs stale". Files are written only after every check
  // has passed (disk writes belong to the build path of main(); --check never writes).
  const outputs = [
    [OUT_JSON, json_dumps(build_json(adrs, specs, fm_digest()))],
    [OUT_INDEX_MD, build_index_md(adrs, specs)],
    [OUT_HTML, build_html(adrs, specs)],
    [OUT_ARTIFACT, build_artifact(adrs, specs)],
  ]

  // The customer corpus surface: only when declared, on top of the four-surface build.
  const cust = await load_customer_decl()
  let cust_count = 0
  if (cust !== null) {
    const [root] = find_declaration()
    const programs = collect_customer_docs(cust, root)
    const panels = await _load_panels(cust, root)
    outputs.push([OUT_CUSTOMER_ARTIFACT, build_customer_artifact(programs, cust, panels)])
    if (T(pget(cust, 'projects_md'))) outputs.push([OUT_PROJECTS, build_projects_md(programs, cust)])
    cust_count = programs.length
  }
  return [adrs, specs, outputs, cust, cust_count]
}

/**
 * The shared output of an assembly failure under --check: REFUSED (exit 2), ASCII only. A defect that a
 * rebuild cannot fix (a duplicate id, an empty corpus, a customer declaration or corpus defect, a panel
 * module exception, every refusal that assemble() raises) must differ from DRIFT (exit 1). Otherwise a
 * CI or an operator that reads exit 1 as "rebuild fixes it" would repeat the rebuild on a defect it
 * cannot fix. The original builder message (Korean included) follows as one more line, ASCII-safe through
 * backslashreplace: the original text is not dropped.
 */
function report_refused(message) {
  out("[check] REFUSED - the build itself refuses this corpus/declaration " +
      "(regeneration will not help; run 'node docs/build.mjs' locally to see " +
      "the builder's message)")
  out(`[check]   builder: ${ascii_bs(message)}`)
  sys_exit(2)
}

/**
 * --check: compare bytes with the disk and write nothing.
 *
 * The assembly (collect, the empty-corpus guard, the customer declaration, collect_customer_docs,
 * load_panels) is exactly the assemble() the build path uses: comparing a different list than main()
 * writes today would itself be silent drift. Not only the SystemExit that assemble() raises but also a
 * caught exception (a code path that is not yet wrapped, a panel module for example) reads as REFUSED:
 * both say that this corpus or declaration cannot be built at all.
 *
 * The surfaces split into REQUIRED (REQUIRED_OUTPUTS: index.json, INDEX.md and, when declared,
 * PROJECTS.md, the surfaces that must be committed) and OPTIONAL (the others, renders the template
 * gitignores). A missing REQUIRED surface prints MISSING and adds to the failure count (exit 1); a
 * missing OPTIONAL surface prints ABSENT and is skipped.
 *
 * The byte comparison drops every CR of the disk side, whether paired or not, when the expected text has
 * no CR at all (the builder always writes LF). That is the rule of init.mjs and manifest-gate.mjs (every
 * 0x0D is dropped, ywr-harness ADR 0033). Folding only the \r\n pairs would read a checkout with a lone
 * CR as DRIFT.
 *
 * The output is ASCII only (the default build output stays Korean), which removes the encoding worry of
 * a consumer CI log.
 */
async function run_check() {
  let outputs
  try {
    [, , outputs] = await assemble()
  } catch (e) {
    if (e instanceof PyExit) report_refused(typeof e.code === 'string' ? e.code : String(e.code))
    report_refused(`${e.name}: ${e.message}`)
  }
  const root = repo_root()
  const total = outputs.length
  let absent = 0
  let failing = 0
  for (const [p, text] of outputs) {
    const rel = path.relative(root, p).replaceAll('\\', '/')
    const expected = Buffer.from(text, 'utf8')
    const required = REQUIRED_OUTPUTS.includes(p)
    if (!is_file(p)) {
      if (required) {
        out(`[check] MISSING ${rel} (required surface not present)`)
        failing += 1
      } else {
        out(`[check] ABSENT  ${rel} (not present - skipped)`)
        absent += 1
      }
      continue
    }
    let actual = fs.readFileSync(p)
    if (!expected.includes(13)) actual = Buffer.from(actual.filter((b) => b !== 13))
    if (actual.equals(expected)) out(`[check] OK      ${rel}`)
    else {
      out(`[check] DRIFT   ${rel}`)
      failing += 1
    }
  }
  if (failing) {
    out(`[check] DRIFT - ${failing} of ${total} surface(s) differ or are missing - run ` +
        "'node docs/build.mjs' (or 'bash docs/build.sh') and commit the result")
    sys_exit(1)
  }
  const tail = absent === 0 ? '' : ` (${absent} absent, skipped)`
  out(`[check] OK - ${total} generated surface(s) match${tail}`)
}

// ------------------------------------------------------------------------------------------------
// Main
// ------------------------------------------------------------------------------------------------
const RX_DATE_ARG = fullre('[0-9]{4}-[0-9]{2}-[0-9]{2}')

async function main() {
  // A plain argument scan: no parser is needed for three flags and one value. Any unknown argument is
  // refused with exit 2 before anything is written: a typo such as `--chek` that quietly became a full
  // writing build would let a caller who asked for a check overwrite files.
  const argv = process.argv.slice(2)
  let customer_mode = false
  let check_mode = false
  let version = null
  let date_seen = false
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    i += 1
    if (a === '--customer') customer_mode = true
    else if (a === '--check') check_mode = true
    else if (a === '--version') {
      if (i >= argv.length || argv[i].startsWith('-')) {
        out('[build] refused: --version needs a value (--version <label>)')
        sys_exit(2)
      }
      version = argv[i]
      i += 1
    } else if (RX_DATE_ARG.test(a) && !date_seen) {
      date_seen = true // the date an older wrapper passed: it is not read
    } else {
      out(`[build] refused: unknown argument ${py_ascii(a)} (known: --customer, --check, --version <label>)`)
      sys_exit(2)
    }
  }

  // --check cannot combine with the legacy --customer surface (docs/customer.html): that surface embeds
  // today's date in the header, so a byte comparison can never hold. Exit 2: exit 1 is for drift only, so
  // a misuse gets another code.
  if (check_mode && customer_mode) {
    out('[check] refused: --check cannot be combined with --customer ' +
        '(docs/customer.html embeds the current date and can never be byte-checked)')
    sys_exit(2)
  }

  if (customer_mode) {
    const adrs = collect(ADR_DIR)
    const specs = collect(SPEC_DIR)
    if (!adrs.length && !specs.length) sys_exit('adr/·spec/ 에서 frontmatter 포함 .md 를 찾지 못했습니다.')
    build_customer(adrs, specs, version)
    return
  }

  if (check_mode) {
    await run_check()
    return
  }

  const [adrs, specs, outputs, cust, cust_count] = await assemble()

  for (const [p, text] of outputs) fs.writeFileSync(p, text, 'utf8')

  const suffix = cust !== null ? ` · 고객 프로그램 ${cust_count}` : ''
  out(`[OK] 생성 완료 (ADR ${adrs.length} · SPEC ${specs.length}${suffix})`)
  out('     - index.json        (에이전트/기계)')
  out('     - INDEX.md           (경량 목차)')
  out('     - docs.html          (사람용 브라우징)')
  out('     - docs.artifact.html (claude.ai Artifact 발행용)')
  if (cust !== null) {
    out(`     - customer.artifact.html (claude.ai Artifact 발행용 — 고객, ${cust_count}개 프로그램)`)
    if (T(pget(cust, 'projects_md'))) out('     - PROJECTS.md        (프로젝트 -> 고객 명세 매핑)')
  }
}

// The parsing and rendering helpers, under the names the Python builder gave them. A selftest pairing or a
// panel module imports them; an import never runs main(). `parse_frontmatter` returns [meta, body] with
// meta as a Map in source order.
export { split_frontmatter, parse_frontmatter, fm_digest, convert_body, esc, inline,
  strip_leading_h1 as _strip_leading_h1, flow_depth as _flow_depth }

// Run main() only as the entry script. An import (the selftest probes) loads the exports and stays quiet.
// The exit code goes through process.exitCode and never process.exit(), so a piped stdout is not cut.
async function run_main() {
  try {
    await main()
  } catch (e) {
    if (e instanceof PyExit) {
      if (typeof e.code === 'string') {
        err(e.code)
        process.exitCode = 1
      } else process.exitCode = e.code
    } else {
      err(e && e.stack ? e.stack : String(e))
      process.exitCode = 1
    }
  }
}

const is_entry = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (is_entry) run_main()
