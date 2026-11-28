#!/usr/bin/env node
// Docs drift check (ywr-harness ADR 0074), STE-lite gate (ywr-harness ADR 0128) and skeleton placeholder
// check (ywr-harness ADR 0208).
//
// It is the ready-made Artifact `check` (ywr-harness ADR 0068) for the generated docs surfaces of this repo.
// Declare it as `check: {runner: node, script: docs/check_docs.mjs}`.
// The default mode is the drift check: exit 0 on a match, exit 1 on drift, and it writes nothing.
// A flag (an argument that starts with `-`) is misuse and exits 2. Regeneration is `node docs/build.mjs`.
//
// Path arguments are triggers, never a scope (ywr-harness ADR 0094). A `.harness.json` group may declare this
// script with `files: true`, so the pre-commit hook runs it on a staged ADR or spec. The drift check is
// corpus-wide, because the index is assembled from every source.
//
// With path arguments the STE-lite gate runs too (ywr-harness ADR 0128, ywr-harness ADR 0170, docs/README.md
// §Writing style). It reads each passed spec and new ADR against HEAD (`git diff HEAD`, the working tree that
// the pre-commit hook gates). R5, R3 and R8 check every changed spec section whole, and R7 checks the words
// that `.harness.json` `docs.ste_words` maps to a replacement. A new ADR must record at least two options.
// R8, R7 and the option count block only under `docs.ste_marks: true`. Findings fail the run only under
// `docs.ste_lite: true`, and otherwise print as advice.
// A passed file that `.harness.json` `docs.ste_files` lists gets R3, R5 and R8 (ywr-harness ADR 0237).
// A records section is not checked, because nobody rewrites a ledger row. A heading that names change notes
// or a ledger, or one with `<!-- ste-lite: records -->`, is a records section.
// `<!-- ste-lite: verbatim -->` on its own line exempts the next block, so text that a script reads stays
// byte-identical.
// A clean tree (CI) has no change against HEAD, so the gate finds nothing there. With no arguments the run
// is the drift check alone, as the Artifact `check` contract requires.
//
// With path arguments a placeholder check runs over the same files and changed lines (ywr-harness ADR 0208).
// It reads records sections too, because a skeleton lands in a ledger note, and it skips code spans and
// fenced blocks. A placeholder is an angle-bracket span on one line that holds U+2026 or starts with `judge:`
// or `NO KEY SET`. A finding fails the run under no key. `<!-- ste-lite: verbatim -->` exempts the next block.
//
// TOOLCHAIN placement (ywr-harness ADR 0010): scaffold-owned, re-placed verbatim by
// `/ywr-harness:harness-init` on every run. Edit the template upstream, never this copy.
//
// Node 22 or later, built-in modules only. The only sibling import is the declared reader
// `scripts/harness/harness_config.mjs`, loaded with a dynamic import() in the entry path. A repo without
// that reader still gets the drift check and a named NOT CHECKED line.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIMIT = 25 // R5: a descriptive sentence
const STEP_LIMIT = 20 // R5: a procedure step, read as an ordered-list item
const MIN_OPTIONS = 2 // a new ADR records the option it took and at least one it rejected (ywr-harness ADR 0170)

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
const fullre = (src, flags = '') => pyre('^(?:' + src + ')\\Z', flags)

/** `re.escape`: the same set of strings matches. Only characters that are special to a RegExp get a backslash. */
const re_escape = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')

const DOC_RX = pyre('^[0-9]{4}-.+\\.md$')
const HEADING_RX = pyre('^(#{1,6})\\s+(.*?)\\s*#*\\s*$')
const NUMBERED_RX = pyre('^§?[0-9]+(\\.[0-9]+)*\\.?(\\s|$)')
const RECORDS_RX = pyre('change notes|ledger|변경 이력', 'i')
const FENCE_RX = pyre('^\\s*(`{3,}(?=[^`]*$)|~{3,})')
const ITEM_RX = pyre('^(\\s*)([-*+]|[0-9]+[.)])\\s+(.*)$')
const MARK_RX = pyre('^\\s*<!--\\s*ste-lite:\\s*(records|verbatim)\\s*-->\\s*$')
const HUNK_RX = pyre('^@@ -[0-9]+(?:,[0-9]+)? \\+([0-9]+)(?:,([0-9]+))? @@')
const SEP_ROW_RX = pyre('^\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$')
const OPTIONS_RX = pyre('(?<!\\w)(?:options?|alternatives?)(?!\\w)|선택지|대안', 'i')
// R8: marks a translator reads more than one way (docs/README.md §Writing style, ywr-harness ADR 0170).
const R8_DASH = '\\u2014|&mdash;|&#8212;|&#x2014;'
const R8_MARKS = [['em dash', pyre(R8_DASH, 'i')],
  ['"(s)"', pyre('\\w\\(e?s\\)')],
  ['"and/or"', pyre('(?<!\\w)and/or(?!\\w)', 'i')]]
const R8_DASH_ONLY = fullre(R8_DASH, 'i')
const ENTITY_RX = pyre('&(?:#[0-9]+|#x[0-9a-f]+|[a-z]+);', 'gi')
// R8: a closed pair of brackets or double quotes; its semicolons join no clauses. A bracket pair holds no
// bracket, so only the innermost pair of a nest guards: an error toward a report. A straight quote opens
// only after no word character and closes only before none, so an inch mark such as 3" never opens a
// pair with the next real quote.
const QUOTED_RX = [pyre('\\[[^\\[\\]]*\\]', 'g'), pyre('(?<!\\w)"[^"]*"(?!\\w)', 'g'),
  pyre('\u201c[^\u201c\u201d]*\u201d', 'g')]
// ywr-harness ADR 0208: an unfilled skeleton, as `cc_sweep.mjs --note` prints it. One line, no bracket inside.
const ELLIPSIS = '\u2026'
const PLACEHOLDER_RX = pyre('<([^<>\\n]*)>', 'g')
const CODE_SPAN_RX = pyre('(`+)(.+?)\\1', 'gs')
const COMMENT_RX = pyre('<!--.*?-->', 'gs')
const ABBREV = new Set(['e.g.', 'i.e.', 'etc.', 'vs.', 'cf.', 'approx.', 'incl.', 'no.', 'fig.'])
// R3: words a short reference may use besides id-like tokens (docs/README.md §Writing style).
const REF_WORDS = new Set(['adr', 'adrs', 'spec', 'specs', 'fact', 'facts', 'issue', 'issues', 'slice',
  'slices', 'sweep', 'sweeps', 'step', 'steps', 'invariant', 'invariants', 'rule',
  'rules', 'option', 'options', 'owner', 'see', 'item', 'items', 'row', 'rows',
  'case', 'cases', 'run', 'runs', 'review', 'section', 'sections', 'dist', 'canon',
  'plugin', 'host', 'version', 'release', 'handoff', 'record', 'manifest', 'tree',
  'final', 'commit', 'tag', 'eval', 'ledger', 'and', 'or', 'also', 'in'])

// ------------------------------------------------------------------------------------------------
// Python string semantics: these helpers read files as Python's str and pathlib do, so one tree gives one
// set of findings.
// ------------------------------------------------------------------------------------------------
function _isspace(c) {
  return (c >= 9 && c <= 13) || (c >= 0x1c && c <= 0x20) || c === 0x85 || c === 0xa0 ||
    c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000
}

/** `str.strip()` with no argument: Python's whitespace set. */
function py_strip(s) {
  let a = 0
  let b = s.length
  while (a < b && _isspace(s.charCodeAt(a))) a++
  while (b > a && _isspace(s.charCodeAt(b - 1))) b--
  return s.slice(a, b)
}

/** `str.lstrip(chars)` / `str.strip(chars)` for a character set. */
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

/** `s[:n]` by code point. */
const cp_head = (s, n) => Array.from(s).slice(0, n).join('')

/**
 * `str.splitlines()`: breaks on \n, \r, \r\n, \x0b, \x0c, \x1c, \x1d, \x1e, \x85, U+2028 and U+2029. A
 * trailing break yields no empty last item.
 */
function splitlines(text) {
  const o = []
  const n = text.length
  let start = 0
  let i = 0
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 10 || c === 11 || c === 12 || c === 13 || c === 0x1c || c === 0x1d || c === 0x1e ||
        c === 0x85 || c === 0x2028 || c === 0x2029) {
      o.push(text.slice(start, i))
      i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1
      start = i
    } else i++
  }
  if (start < n) o.push(text.slice(start))
  return o
}

/** `text.encode("ascii", "backslashreplace").decode("ascii")`. */
function _ascii(text) {
  return text.replace(/[^\x00-\x7f]/gu, (ch) => {
    const c = ch.codePointAt(0)
    return c < 0x100 ? '\\x' + c.toString(16).padStart(2, '0')
      : c < 0x10000 ? '\\u' + c.toString(16).padStart(4, '0')
        : '\\U' + c.toString(16).padStart(8, '0')
  })
}

/**
 * `Path.read_text(encoding="utf-8", errors="replace")`: universal newlines (a CR or a CRLF reads as
 * "\n"), the BOM kept as a character, each bad byte sequence read as U+FFFD. A filesystem error carries
 * the Python exception name.
 */
function read_text(p) {
  let buf
  try {
    buf = fs.readFileSync(p)
  } catch (e) {
    e.name = os_err_name(e)
    throw e
  }
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(buf).replace(/\r\n?/g, '\n')
}

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

// The exception types that the callers of the diff read treat as "this file cannot be read against HEAD":
// ValueError (a path outside the repo), CalledProcessError (git refused) and the OSError family.
const DIFF_ERRORS = new Set(['ValueError', 'CalledProcessError', 'OSError', 'FileNotFoundError',
  'PermissionError', 'IsADirectoryError', 'NotADirectoryError', 'FileExistsError'])

const is_file = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

/** `Path(a).resolve()`: absolute, symlinks resolved when the path exists. */
function resolve_path(a) {
  const abs = path.resolve(a)
  try { return fs.realpathSync.native(abs) } catch { return abs }
}

/** Path equality as `pathlib` reads it: case-insensitive on Windows. */
const same_path = (a, b) => (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b))

/** `p.relative_to(root).as_posix()`; a path outside `root` throws an Error named ValueError. */
function relative_to(root, p) {
  const rel = path.relative(root, p)
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    const e = new Error(`'${p}' is not in the subpath of '${root}'`)
    e.name = 'ValueError'
    throw e
  }
  return rel.split(path.sep).join('/')
}

const out = (line = '') => { process.stdout.write(line + '\n') }

// ------------------------------------------------------------------------------------------------
// STE-lite rules
// ------------------------------------------------------------------------------------------------
// Inline markdown to countable text: a code span is one word, a link keeps its label.
const PLAIN_CODE = pyre('(`+)(.+?)\\1', 'g')
const PLAIN_LINK = pyre('!?\\[([^\\]]*)\\]\\([^)]*\\)', 'g')
const PLAIN_ANGLE_URL = pyre('<https?://[^>]*>', 'g')
const PLAIN_URL = pyre('https?://[^\\s)>]+', 'g')
const PLAIN_TAG = pyre('<[^>]+>', 'g')

function _plain(text) {
  text = text.replace(PLAIN_CODE, ' CODE ')
  text = text.replace(PLAIN_LINK, (m, label) => label)
  text = text.replace(PLAIN_ANGLE_URL, ' URL ')
  text = text.replace(PLAIN_URL, ' URL ') // a bare URL: no R8 or R7 match inside it
  return text.replace(PLAIN_TAG, ' ')
}

const WORD_CHAR = pyre('\\w')
function _words(sentence) {
  return py_split(sentence).filter((t) => WORD_CHAR.test(t)).length
}

const SENTENCE_END = pyre('[.!?][)"\'*_\\]]*(\\s+)(?=\\S)', 'g')
function _sentences(text) {
  const o = []
  let start = 0
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length
    const nxt = text[end]
    const words = py_split(text.slice(0, m.index + 1))
    const word = strip_chars(words[words.length - 1].toLowerCase(), '*_("\'', true, false)
    if (('a' <= nxt && nxt <= 'z') || ABBREV.has(word)) continue
    o.push(text.slice(start, m.index + 1))
    start = end
  }
  o.push(text.slice(start))
  return o.map(py_strip).filter((s) => s)
}

const REF_DIGIT = pyre('[0-9§#]')
const REF_UPPER = fullre('[A-Z][A-Z0-9]{1,7}')
const REF_JOINED = pyre('\\w[-/._]\\w')
function _ref_token(tok) {
  const t = strip_chars(tok, '.,;:')
  return t !== '' && (REF_WORDS.has(t.toLowerCase()) || t === 'CODE' || REF_DIGIT.test(t) ||
    REF_UPPER.test(t) || REF_JOINED.test(t))
}

const REF_SPLIT = /[,;/\u00b7]/
// R3: each outermost parenthesized group that is not a single token or a reference list.
function _claims(text) {
  const found = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') {
      if (depth === 0) start = i + 1
      depth += 1
    } else if (ch === ')' && depth) {
      depth -= 1
      if (depth === 0) {
        const inner = py_strip(text.slice(start, i))
        if (py_split(inner).length > 1 &&
            !inner.split(REF_SPLIT).every((part) => py_split(part).every(_ref_token))) {
          found.push(inner)
        }
      }
    }
  }
  return found
}

/**
 * R8: semicolons outside parentheses, brackets and closed double quotes. A reference list such as
 * "(ADR 1; spec 2)" may use one, a quote keeps its source text, and an HTML entity ends in one. A quote or
 * bracket that does not close in the text guards nothing, so a stray inch mark never hides a later
 * semicolon (ywr-harness ADR 0188).
 */
function _joining_semicolons(text) {
  text = text.replace(ENTITY_RX, ' ')
  for (const rx of QUOTED_RX) text = text.replace(rx, ' ')
  let depth = 0
  let n = 0
  for (const ch of text) {
    if (ch === '(') depth += 1
    else if (ch === ')' && depth) depth -= 1
    else if (ch === ';' && !depth) n += 1
  }
  return n
}

/**
 * R8 and the declared R7 words in one cell or unit of plain text: [rule, label] per kind found. A table
 * cell that holds only an em dash, as the character or as an entity, is the empty-cell mark, not a dash in
 * a sentence.
 */
function _marks(text, words) {
  const found = []
  if (!R8_DASH_ONLY.test(py_strip(text))) {
    for (const [label, rx] of R8_MARKS) if (rx.test(text)) found.push(['R8', label])
  }
  if (_joining_semicolons(text)) found.push(['R8', 'joining semicolon'])
  for (const [word, use] of Object.entries(words)) {
    if (pyre('(?<!\\w)' + re_escape(word) + '(?!\\w)', 'i').test(text)) found.push(['R7', `"${word}" -> "${use}"`])
  }
  return found
}

/**
 * A new ADR's options: [heading line, count] for its first level-2 options heading, or null without one.
 * Each table body row, list item and sub-heading in that section counts once, so a nested list or a
 * non-option row counts too: the count errs toward a pass (ywr-harness ADR 0170).
 */
function _option_count(heads, units) {
  const head = heads.find((h) => h.level === 2 && OPTIONS_RX.test(h.text))
  if (head === undefined) return null
  const nxt = heads.find((h) => h.line > head.line && h.level <= 2)
  const end = nxt ? nxt.line : 10 ** 9
  let count = units.filter((u) => head.line < u.start && u.start < end && u.kind !== 'para').length
  count += heads.filter((h) => head.line < h.line && h.line < end).length
  return [head.line, count]
}

/**
 * Parse a document body into headings and checkable units, each with its 1-based line span. A unit is a
 * paragraph, a list item or one table body row; fences, comments and frontmatter hold none. A `verbatim`
 * marker exempts the next block; a `records` marker names its section.
 */
function _units(lines) {
  const heads = []
  const units = []
  const marks = []
  let i = 0
  const n = lines.length
  let verbatim = false
  let pending = false
  if (lines.length && py_strip(lines[0]) === '---') {
    let k = 1
    while (k < n && py_strip(lines[k]) !== '---') k++
    i = k < n ? k + 1 : n
  }
  let cur = null
  let in_table = false

  const close = () => {
    if (cur) units.push(cur)
    cur = null
  }

  while (i < n) {
    const line = lines[i]
    const ln = i + 1
    const s = py_strip(line)
    const fence = FENCE_RX.exec(line)
    if (fence) {
      close(); in_table = false
      const tick = fence[1]
      i += 1
      const closer = new RegExp('^' + tick[0] + '{' + tick.length + ',}$')
      while (i < n && !closer.test(py_strip(lines[i]))) i += 1
      i += 1; verbatim = pending = false
      continue
    }
    const mk = MARK_RX.exec(line)
    if (mk) {
      close(); in_table = false
      if (mk[1] === 'verbatim') pending = true
      else marks.push(ln)
      i += 1
      continue
    }
    if (s.startsWith('<!--')) {
      close(); in_table = false
      while (i < n && !lines[i].includes('-->')) i += 1
      i += 1
      continue
    }
    const h = HEADING_RX.exec(line)
    if (h) {
      close(); in_table = false
      heads.push({ line: ln, level: h[1].length, text: h[2], numbered: NUMBERED_RX.test(h[2]) })
      i += 1
      continue
    }
    if (!s) {
      close(); in_table = false
      i += 1
      continue
    }
    if (s.startsWith('|')) {
      close()
      if (!in_table) {
        in_table = true
        verbatim = pending; pending = false
        if (i + 1 < n && SEP_ROW_RX.test(py_strip(lines[i + 1]))) {
          i += 1 // a header row, the label row above a separator
          continue
        }
      }
      if (!SEP_ROW_RX.test(s)) {
        units.push({ start: ln, end: ln, kind: 'row', text: s, skip: verbatim })
      }
      i += 1
      continue
    }
    in_table = false
    const it = ITEM_RX.exec(line)
    if (it) {
      close()
      if (!units.length || !['item', 'step'].includes(units[units.length - 1].kind) ||
          units[units.length - 1].end !== ln - 1) {
        verbatim = pending; pending = false
      }
      cur = { start: ln, end: ln, kind: /[0-9]/.test(it[2][0]) ? 'step' : 'item', text: it[3], skip: verbatim }
      i += 1
      continue
    }
    if (cur) {
      cur.text += ' ' + strip_chars(s, '> ', true, false)
      cur.end = ln
    } else {
      verbatim = pending; pending = false
      cur = { start: ln, end: ln, kind: 'para', text: strip_chars(s, '> ', true, false), skip: verbatim }
    }
    i += 1
  }
  close()
  return [heads, units, marks]
}

/**
 * The changed section that owns line `ln`, named by its heading line (0 = the preamble): the deepest
 * numbered heading whose scope holds the line, up to the next numbered heading; with no numbered heading
 * in scope, the nearest heading above (docs/README.md §Writing style).
 */
function _section_of(heads, ln) {
  const above = heads.filter((h) => h.line <= ln)
  if (!above.length) return 0
  let stack = [] // the numbered headings whose scope is still open
  for (const h of above) {
    stack = stack.filter((o) => o.level < h.level)
    if (h.numbered) stack.push(h)
  }
  return stack.length ? stack[stack.length - 1].line : above[above.length - 1].line
}

const _DIFFS = new Map() // `root` and `rel` -> result: STE-lite and the placeholder check share one git read

/** `_diff_against_head`, read once per file for the run. */
function _changed_lines(root, rel, hc) {
  const key = root + '\0' + rel
  if (!_DIFFS.has(key)) _DIFFS.set(key, _diff_against_head(root, rel, hc))
  return _DIFFS.get(key)
}

/**
 * [changed, anchors] against HEAD; null when the file is new against HEAD. `changed` holds the
 * working-tree lines a hunk adds or rewrites. `anchors` holds, for each pure deletion, the line above it,
 * which selects that section. A deletion whose first non-blank removed line is a heading removed whole
 * sections and selects nothing.
 */
function _diff_against_head(root, rel, hc) {
  try { // `./`: relative to `root`, not to the git top level
    hc.git_run(root, ['cat-file', '-e', `HEAD:./${rel}`])
  } catch (e) {
    if (e.name === 'CalledProcessError') return null
    throw e
  }
  const diff = hc.git_run(root, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '-U0',
    'HEAD', '--', rel])
  const changed = new Set()
  const anchors = new Set()
  let pending = null
  for (const line of splitlines(diff)) {
    const m = HUNK_RX.exec(line)
    if (m) {
      const start = parseInt(m[1], 10)
      const count = m[2] !== undefined ? parseInt(m[2], 10) : 1
      for (let k = start; k < start + count; k++) changed.add(k)
      pending = count === 0 ? Math.max(start, 1) : null
    } else if (pending !== null && line.startsWith('-') && py_strip(line.slice(1))) {
      if (!HEADING_RX.test(line.slice(1))) anchors.add(pending)
      pending = null
    }
  }
  return [changed, anchors]
}

const CELL_SPLIT = pyre('(?<!\\\\)\\|')

/**
 * Check one file; append report lines to `o`. Returns [sections checked, R3 and R5 findings, R8, R7 and
 * option-count findings]. `words` maps each declared R7 word to its replacement; `adr` marks a new ADR,
 * whose options section is counted too.
 */
function _check_file(p, rel, diff, o, words = {}, adr = false) {
  const lines = splitlines(read_text(p))
  const [heads, units, marks] = _units(lines)
  const names = new Map(heads.map((h) => [h.line, h.text]))
  names.set(0, '(preamble)')
  let touched
  if (diff === null) {
    touched = new Set(units.map((u) => _section_of(heads, u.start)))
  } else {
    let fm_end = 0
    if (lines.length && py_strip(lines[0]) === '---') {
      let k = 1
      while (k < lines.length && py_strip(lines[k]) !== '---') k++
      fm_end = k < lines.length ? k + 1 : 0
    }
    // A blank line selects nothing: an added section's leading blank sits above its heading.
    const changed = [...diff[0]].filter((ln) => ln > fm_end && ln <= lines.length && py_strip(lines[ln - 1]))
    touched = new Set([...changed, ...diff[1]].filter((ln) => ln > fm_end).map((ln) => _section_of(heads, ln)))
  }
  // A records section (change notes, a ledger) is not checked at all: nobody rewrites a ledger row, so a
  // finding there is noise (ywr-harness ADR 0128).
  const records = new Set([...touched].filter((sec) => RECORDS_RX.test(names.has(sec) ? names.get(sec) : '')))
  for (const m of marks) records.add(_section_of(heads, m))
  let findings = 0
  let marked = 0
  for (const sec of [...touched].sort((a, b) => a - b)) {
    const mode = records.has(sec) ? 'records, not checked' : 'whole'
    o.push(`[ste-lite]   ${rel} ${_ascii(names.has(sec) ? names.get(sec) : '?')} (${mode})`)
  }
  for (const u of units) {
    const sec = _section_of(heads, u.start)
    if (!touched.has(sec) || records.has(sec) || u.skip) continue
    const texts = u.kind === 'row' ? py_strip(u.text).replace(/^\|+|\|+$/g, '').split(CELL_SPLIT) : [u.text]
    const limit = u.kind === 'step' ? STEP_LIMIT : LIMIT
    for (const t of texts) {
      const plain = _plain(t)
      for (const [rule, label] of _marks(plain, words)) {
        marked += 1
        o.push(`[ste-lite]   ${rule} ${rel}:${u.start} ${_ascii(label)}: "${_ascii(py_split(plain).slice(0, 8).join(' '))} ..."`)
      }
      for (const s of _sentences(plain)) {
        const w = _words(s)
        if (w > limit) {
          findings += 1
          const head = py_split(s).slice(0, 8).join(' ')
          o.push(`[ste-lite]   R5 ${rel}:${u.start} ${w} words > ${limit}: "${_ascii(head)} ..."`)
        }
      }
      for (const c of _claims(plain)) {
        findings += 1
        o.push(`[ste-lite]   R3 ${rel}:${u.start} claim in parentheses: "(${_ascii(cp_head(c, 60))})"`)
      }
    }
  }
  if (adr) {
    const opts = _option_count(heads, units)
    if (opts === null || opts[1] < MIN_OPTIONS) {
      marked += 1
      o.push(`[ste-lite]   OPT ${rel}:${opts ? opts[0] : 1} ` +
        (opts ? `${opts[1]} option, fewer than ${MIN_OPTIONS}` : 'no options section') +
        ': record the option taken and at least one rejected option')
    }
  }
  return [[...touched].filter((sec) => !records.has(sec)).length, findings, marked]
}

/** The passed paths that are a spec or ADR file of this docs tree. */
function _pick(here, paths) {
  const docs = [path.join(here, 'spec'), path.join(here, 'adr')]
  return paths.map(resolve_path).filter((p) => {
    const name = path.basename(p)
    return docs.some((d) => same_path(path.dirname(p), d)) && DOC_RX.test(name) && !name.startsWith('0000-') && is_file(p)
  })
}

/** The passed existing .md files that are not in `picked`: candidates for `docs.ste_files` (ywr-harness ADR 0237). */
function _others(paths, picked) {
  return paths.map(resolve_path).filter((p) => p.endsWith('.md') && is_file(p) && !picked.some((q) => same_path(p, q)))
}

// Blank each code span and HTML comment, keeping every newline so line numbers hold.
function _mask(text) {
  const blank = (m) => m.replace(/[^\n]/gu, ' ')
  return text.replace(CODE_SPAN_RX, blank).replace(COMMENT_RX, blank)
}

/**
 * ywr-harness ADR 0208: report each skeleton placeholder on a changed line; returns the count. `_units`
 * holds no frontmatter, fence or comment line, and its `verbatim` flag exempts a block. A records section
 * is read too. A heading line is read, and a marker never exempts it.
 */
function _placeholders(p, rel, diff, o) {
  const lines = splitlines(read_text(p))
  const [heads, units] = _units(lines)
  const spans = heads.map((h) => [h.line, h.line])
  for (const u of units) if (!u.skip) spans.push([u.start, u.end])
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let found = 0
  for (const [start, end] of spans) {
    const masked = _mask(lines.slice(start - 1, end).join('\n')).split('\n')
    masked.forEach((text, off) => {
      const ln = start + off
      if (diff !== null && !diff[0].has(ln)) return
      for (const m of text.matchAll(PLACEHOLDER_RX)) {
        const inner = m[1]
        if (inner.includes(ELLIPSIS) || inner.startsWith('judge:') || inner.startsWith('NO KEY SET')) {
          found += 1
          o.push(`[placeholder] ${rel}:${ln} unfilled skeleton placeholder: "${_ascii(cp_head(m[0], 60))}"`)
        }
      }
    })
  }
  return found
}

/**
 * The declared reader, imported on demand: `{hc}` or `{error}`. Only the entry path calls this, because
 * a dynamic import is the one asynchronous step in the file.
 */
async function import_hc(here) {
  const reader = path.join(path.dirname(here), 'scripts', 'harness', 'harness_config.mjs')
  try {
    return { hc: await import(pathToFileURL(reader).href), error: null, reader }
  } catch (error) {
    return { hc: null, error, reader }
  }
}

// The reader is missing only when its own file is absent. The reader imports harness_git.mjs, so a
// module-not-found error can also name that dependency while harness_config.mjs is present: that is a
// broken toolchain, not a repo without the reader, and it must not pass as one.
const reader_missing = (error, reader) => error_name(error) === 'ModuleNotFoundError' && !fs.existsSync(reader)

// A thrown value names itself, so a control character in it is escaped before it reaches a printed line.
const error_name = (e) => _ascii(e && e.code === 'ERR_MODULE_NOT_FOUND' ? 'ModuleNotFoundError' : String((e && e.name) || 'Error'))
  .replace(/[\u0000-\u001f\u007f]/gu, (ch) => '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0'))

/**
 * Run the placeholder check (ywr-harness ADR 0208) over the passed paths. Returns 1 when a finding fails
 * the run. No key gates it. A file whose changed lines cannot be read is read whole: the check never
 * passes a file unread (ywr-harness ADR 0208).
 */
async function placeholders(here, paths) {
  here = resolve_path(here)
  const picked = _pick(here, paths)
  if (!picked.length) {
    out('[placeholder] OK - no spec or ADR of this docs tree among the passed paths')
    return 0
  }
  let { hc, error } = await import_hc(here)
  let root = null
  if (hc !== null) {
    try {
      root = hc.find_repo_root(here)
    } catch (e) {
      hc = null
      error = e
    }
  }
  if (hc === null) { // no diff without the git boundary: read whole files
    root = path.dirname(here)
    out('[placeholder] WHOLE FILES (scripts/harness/harness_config.mjs unusable: ' +
        `${error_name(error)} - re-run /ywr-harness:harness-init); every line is read`)
  }
  const o = []
  let found = 0
  let files = 0
  for (const p of picked) {
    let rel = path.basename(p)
    let whole = hc === null
    let changed = null
    if (hc !== null) {
      try {
        rel = relative_to(root, p)
        changed = _changed_lines(root, rel, hc)
      } catch (e) {
        if (!DIFF_ERRORS.has(e.name)) throw e
        whole = true
        out(`[placeholder] WHOLE FILE (${_ascii(rel)}: ${e.name} reading the diff); every line is read`)
      }
    }
    if (!whole && same_path(path.dirname(p), path.join(here, 'adr')) && changed !== null) {
      continue // an accepted ADR is append-only: never rewritten
    }
    files += 1
    found += _placeholders(p, rel, changed, o)
  }
  for (const line of o) out(line)
  if (found) {
    out(`[placeholder] FAIL - ${found} finding(s). Fill or remove each skeleton placeholder ` +
        '(ywr-harness ADR 0208).')
    return 1
  }
  out(`[placeholder] OK - ${files} file(s) read, no unfilled skeleton placeholder`)
  return 0
}

/** Run the STE-lite gate over the passed paths. Returns 1 when a finding must fail the run. */
async function ste_lite(here, paths) {
  here = resolve_path(here)
  const picked = _pick(here, paths)
  const others = _others(paths, picked)
  if (!picked.length && !others.length) {
    out('[ste-lite] OK - no spec or ADR of this docs tree among the passed paths')
    return 0
  }
  const { hc, error, reader } = await import_hc(here)
  if (hc === null) {
    const missing = reader_missing(error, reader)
    if (!picked.length) {
      if (missing) { // no reader, so no declared file: the same line as a run without any .md path
        out('[ste-lite] OK - no spec or ADR of this docs tree among the passed paths')
        return 0
      }
      // A broken reader stops no commit that passes no spec or ADR, but the run says what it skipped.
      out(`[ste-lite] NOT CHECKED (scripts/harness/harness_config.mjs failed to load: ${error_name(error)})` +
          '; docs.ste_files is unreadable, so no listed file was checked and the gate does not block')
      return 0
    }
    if (!missing) {
      // A reader that is present but fails to load is a broken toolchain, so a passed spec or ADR blocks.
      out(`[ste-lite] FAIL (scripts/harness/harness_config.mjs failed to load: ${error_name(error)} - re-run ` +
          '/ywr-harness:harness-init); a spec or ADR was passed and no line of it was checked')
      return 1
    }
    // The mode is unreadable, so the gate cannot block.
    out('[ste-lite] NOT CHECKED (scripts/harness/harness_config.mjs missing - re-run ' +
        '/ywr-harness:harness-init); the gate did not run and does not block')
    return 0
  }
  const root = hc.find_repo_root(here)
  const [cfg, warns] = hc.load(root)
  const declared = others.filter((p) => (cfg.ste_files || []).some((d) => same_path(p, resolve_path(path.join(root, d)))))
  const mode_warns = picked.length || declared.length
    ? ['docs.ste_lite', 'docs.ste_marks', 'docs.ste_words', 'docs.ste_files'] : ['docs.ste_files']
  for (const w of warns) {
    if (mode_warns.some((k) => w.startsWith(k))) out(`[ste-lite] WARN ${_ascii(w)}`)
  }
  if (!picked.length && !declared.length) {
    out('[ste-lite] OK - no spec or ADR of this docs tree among the passed paths')
    return 0
  }
  // Two keys (ywr-harness ADR 0170): R3 and R5 block under docs.ste_lite, which the scaffold seed declares.
  // R8, the R7 words and the option count block only under docs.ste_marks, which it does not.
  const core_blocks = cfg.ste_lite === true
  const marks_block = cfg.ste_marks === true
  const blocking = core_blocks || marks_block
  const o = []
  let findings = 0
  let marked = 0
  let sections = 0
  let files = 0
  let adrs = 0
  let spec_files = 0
  for (const p of [...picked, ...declared]) {
    const arg = p
    const is_declared = !picked.includes(p)
    let rel
    let changed
    try {
      rel = relative_to(root, p)
      changed = _changed_lines(root, rel, hc)
    } catch (e) {
      if (!DIFF_ERRORS.has(e.name)) throw e
      for (const line of o) out(line) // the files read so far still report
      out(`[ste-lite] NOT CHECKED (${_ascii(String(arg))}: ${e.name})` +
          (blocking ? '' : '; advisory mode, so the gate does not block'))
      return blocking ? 1 : 0
    }
    const is_adr = !is_declared && same_path(path.dirname(p), path.join(here, 'adr'))
    if (is_adr && changed !== null) continue // an accepted ADR is append-only: never rewritten
    // A declared file gets R3, R5 and R8 only: no R7 words and no option count (ywr-harness ADR 0237).
    const [n, f, m] = _check_file(p, rel, changed, o, is_declared ? {} : hc_words(cfg), is_adr)
    if (!is_declared) spec_files += 1
    if (is_adr) adrs += 1
    if (n || f || m) files += 1
    sections += n
    findings += f
    marked += m
  }
  for (const line of o) out(line)
  if (!files) {
    out('[ste-lite] OK - no checked section: nothing changed outside records sections')
    return 0
  }
  if (!findings && !marked) {
    out(`[ste-lite] OK - ${sections} section(s) in ${files} file(s) pass R3, R5, R8` +
        (spec_files && Object.keys(hc_words(cfg)).length ? ', R7 words' : '') +
        (adrs ? ' and the ADR option count' : ''))
    return 0
  }
  const fails = (core_blocks && findings > 0) || (marks_block && marked > 0)
  const verdict = fails ? 'FAIL' : 'ADVISORY'
  out(`[ste-lite] ${verdict} - ${findings + marked} finding(s). Rewrite each listed section in ` +
      'STE-lite (docs/README.md §Writing style).')
  if (findings && !core_blocks) {
    out('[ste-lite]   advisory: declare "docs": {"ste_lite": true} in .harness.json ' +
        'to make R3 and R5 block (ywr-harness ADR 0128).')
  }
  if (marked && !marks_block) {
    out('[ste-lite]   advisory: declare "docs": {"ste_marks": true} in .harness.json ' +
        'to make R8, the R7 words and the ADR option count block (ywr-harness ADR 0170).')
  }
  return fails ? 1 : 0
}

// The declared R7 words as a word-to-replacement object, empty when none are declared.
const hc_words = (cfg) => (cfg.ste_words && typeof cfg.ste_words === 'object' ? cfg.ste_words : {})

async function main() {
  const args = process.argv.slice(2)
  if (args.some((a) => a.startsWith('-'))) {
    out('usage: node docs/check_docs.mjs [changed paths...]  (no flags — the check is the ' +
        'only mode; paths trigger it and do not narrow it)')
    process.exitCode = 2
    return
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  // The drift check is the builder's --check mode, run as its own process so that its output and exit
  // code reach this run unchanged.
  const r = spawnSync(process.execPath, [path.join(here, 'build_docs.mjs'), '--check'], { stdio: 'inherit' })
  const drift = r.error ? 1 : (r.status ?? 1)
  if (!args.length) {
    process.exitCode = drift
    return
  }
  const ste = await ste_lite(here, args)
  const holders = await placeholders(here, args)
  process.exitCode = drift === 2 ? 2 : Math.max(drift, ste, holders)
}

main().catch((e) => {
  process.stderr.write((e && e.stack ? e.stack : String(e)) + '\n')
  process.exitCode = 1
})
