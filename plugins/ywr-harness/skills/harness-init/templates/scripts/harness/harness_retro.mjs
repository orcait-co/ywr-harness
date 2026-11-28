// Slice retro gate: a zero-token deterministic retrospective, run from `post-commit`.
//
// Seven checks, plus SIZE, which reports an in-scope file that crosses 1,000 lines in the checked
// range (ywr-harness ADR 0171). Everything repo-specific comes from `.harness.json`.
//
// ## Why Node and not POSIX sh
//
// A portable gate has to read its scope from the declaration, and sh cannot parse JSON. Node is
// already required by the plugin hooks, so every member machine has it. It also avoids a
// Git-Bash-on-Windows dependency, which produced vacuous selftest passes (ywr-harness fact 26).
//
// ## Contract
//
// ADVISORY. Exits 0, prints nothing when clean, and never blocks a commit. It runs at post-commit
// rather than pre-commit so a finding prompts a follow-up docs commit instead of standing between
// the author and their own history. The one exception: a git failure prints a
// `[slice-retro] FAILED` line and exits 1, because silence there would be a false clean retro
// (ywr-harness ADR 0041). The hook's `|| true` keeps the commit untouched.
//
//   node harness_retro.mjs                  # the commit just made (HEAD); a merge commit
//                                           # resolves as HEAD^1..HEAD (first-parent, ywr-harness ADR 0043)
//   node harness_retro.mjs main~3..HEAD     # a whole slice, which absorbs mid-slice false positives
//   node harness_retro.mjs --coverage       # full unowned / dead-mapping / large-file audit
//   node harness_retro.mjs --delegations    # the delegation ledger's report (ywr-harness ADR 0120/0171)
//   SLICE_RETRO=0 git commit ...            # skip once
//
// A check whose declaration is empty is DISABLED, and the disablement is reported under --coverage.
// Per-commit silence therefore means "no finding among the ENABLED checks". It cannot tell a clean
// commit from a disabled check, because repeating a deliberate disablement on every commit is the
// noise that gets a hook turned off. `--coverage` names every disabled check, and the slice close runs it, so an unconfigured
// repo is visible once per slice rather than never.
//
// Stdout is buffered and written once at the end, so a piped stdout is never cut by an early exit
// and stdout lines follow the stderr lines. Printed values are echoed raw. It is a human display and
// no machine parser reads it (the CI step only logs it). `hc.warn` escapes the stderr channel.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as hc from './harness_config.mjs'

hc.pin_utf8()

// Declared patterns keep their Python regex meaning (ywr-harness ADR 0223). This is Python's `\s`, built
// from numbers so that no source line holds a raw separator character. JavaScript's own `\s` differs at
// U+001C-U+001F, U+0085 and U+FEFF.
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f ' + String.fromCharCode(0x85, 0xa0, 0x1680) +
  String.fromCharCode(0x2000) + '-' + String.fromCharCode(0x200a) +
  String.fromCharCode(0x2028, 0x2029, 0x202f, 0x205f, 0x3000)

// Python's `$` also matches before one trailing newline, and the lookahead keeps that reading.
// Python's `.` excludes only `\n`, and JavaScript's also `\r`, U+2028 and U+2029, so `[^\n]` stands for it.
export const SPEC_RX = /^docs\/spec\/[0-9][^\n]*\.md(?=\n?$)/
export const ADR_RX = /^docs\/adr\/[0-9][^\n]*\.md(?=\n?$)/
export const DOCS_RX = /^docs\/(adr|spec)\/[0-9][^\n]*\.md(?=\n?$)/

// --- Output ------------------------------------------------------------------------------------
const OUT = []

/** Queues one stdout line for `flush_out`. @param {string} line */
function out(line) {
  OUT.push(line)
}

function flush_out() {
  if (OUT.length) process.stdout.write(OUT.join('\n') + '\n')
  OUT.length = 0
}

// --- Helpers local to this gate ------------------------------------------------------------------
const OS_ERROR_NAMES = new Set(['OSError', 'FileNotFoundError', 'PermissionError', 'NotADirectoryError',
  'IsADirectoryError', 'FileExistsError'])

/** Whether `e` is an OS error: a Node fs error, or one tagged with an OSError subclass name. */
function is_oserr(e) {
  return !!e && (typeof e.code === 'string' || OS_ERROR_NAMES.has(e.name))
}

/** Whether `e` is the `CalledProcessError` of `hc.git_run`. */
function is_cpe(e) {
  return !!e && e.name === 'CalledProcessError'
}

const STRERROR = {
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
  EIO: 'Input/output error',
  ELOOP: 'Too many levels of symbolic links',
  EMFILE: 'Too many open files',
}

/** The OS message of an error, else its type name. */
function strerror(e) {
  if (e && typeof e.code === 'string' && Object.hasOwn(STRERROR, e.code)) return STRERROR[e.code]
  return hc._oserr(e).name || 'OSError'
}

/**
 * A declared pattern with the `.` and `$` of a Python regex (ywr-harness ADR 0223): `.` matches every
 * character but a line feed (JavaScript's also refuses a carriage return, U+2028 and U+2029, so a path
 * holding one would fall out of scope), and `$` also matches before one trailing line feed. Escapes
 * and character classes pass through unchanged.
 * @param {string} src
 * @returns {string}
 */
function py_dot(src) {
  let res = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      res += c + (src[i + 1] ?? '')
      i++
    } else if (c === '[') {
      let j = i + 1
      if (src[j] === '^') j++
      if (src[j] === ']') j++
      while (j < src.length && src[j] !== ']') j += src[j] === '\\' ? 2 : 1
      res += src.slice(i, j + 1)
      i = j
    } else {
      res += c === '.' ? '[^\\n]' : c === '$' ? '(?=\\n?$)' : c
    }
  }
  return res
}

/** Splits at most `maxsplit` times. The last piece keeps the rest, which `String.split`'s limit drops. */
function split_n(s, sep, maxsplit) {
  const parts = []
  let at = 0
  while (parts.length < maxsplit) {
    const i = s.indexOf(sep, at)
    if (i === -1) break
    parts.push(s.slice(at, i))
    at = i + sep.length
  }
  parts.push(s.slice(at))
  return parts
}

const WS_RUN = new RegExp('[' + PY_WS + ']+')

/** Splits on runs of the whitespace class above, with no empty items. */
function py_split(s) {
  return s.split(WS_RUN).filter((x) => x !== '')
}

/** Strips every leading and trailing `ch`, a single character. */
function strip_char(s, ch) {
  let a = 0
  let b = s.length
  while (a < b && s[a] === ch) a++
  while (b > a && s[b - 1] === ch) b--
  return s.slice(a, b)
}

/** An integer with a comma between each group of three digits. @param {number} n */
function fmt_int(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Seconds with one decimal for a whole number of milliseconds. An exact tie rounds to even, where
 * `toFixed` rounds it up. A tie at one decimal is only exact for a quarter second (250, 750, ...).
 * @param {number} ms
 */
function fmt_secs(ms) {
  if (ms % 500 === 250) {
    let q = Math.floor(ms / 100)
    if (q % 2 === 1) q++
    return `${Math.floor(q / 10)}.${q % 10}`
  }
  return (ms / 1000).toFixed(1)
}

function is_file(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

function is_dir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function is_symlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink() } catch { return false }
}

function exists(p) {
  try { return fs.existsSync(p) } catch { return false }
}

/** An absolute path with symlinks resolved. A missing tail stays as given. */
function realpath(p) {
  let cur = path.resolve(p)
  const tail = []
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return path.resolve(p)
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

/**
 * One git call through `hc.git_run`, the one git boundary. Both pipes are bytes and the output is
 * decoded once as UTF-8 with backslashreplace, because a text-mode pipe on Windows translates newlines
 * and decodes with the console codepage. quotepath is off, because git would otherwise C-quote
 * non-ASCII paths as octal escapes, which no anchored pattern matches. Color is off, because a user's
 * `color.grep=always` would put ESC codes before each `git grep` path (`hc.GIT_PINS`).
 * A non-zero exit THROWS, except the exits a caller names in `ok_exits` as a semantic answer
 * (`rev-parse -q --verify` exit 1 = absent), which read as empty output. Never 128: git exits 128
 * for EVERY fatal error (a missing object, a bad rev, a corrupt pack), so no caller can read it
 * as an answer. Reading every failure as empty output would make a failing `git diff`
 * indistinguishable from a commit that changed nothing, a false clean retro. `main` turns the
 * throw into the ywr-harness ADR 0041 `FAILED` marker.
 * @param {string} root @param {string[]} args @param {number[]} [ok_exits]
 * @returns {string}
 */
export function git(root, args, ok_exits = []) {
  try {
    return hc.git_run(root, args)
  } catch (e) {
    if (is_cpe(e) && ok_exits.includes(e.returncode)) return ''
    throw e
  }
}

/**
 * Parse `diff --name-status -z`: a status field, then one path, or two for R/C (old, new).
 * NUL-framed (ywr-harness ADR 0077): a path carrying U+2028, NEL or a tab stays one path.
 * @param {string} raw
 * @returns {Array<[string, string[]]>}
 */
export function name_status_z(raw) {
  const tok = raw.split('\0')
  const res = []
  let i = 0
  while (i < tok.length) {
    const st = tok[i]
    i += 1
    if (!st) continue
    const n = st.slice(0, 1) === 'R' || st.slice(0, 1) === 'C' ? 2 : 1
    const paths = tok.slice(i, i + n).filter((x) => x).map((x) => hc.norm(x))
    i += n
    if (paths.length) res.push([st, paths])
  }
  return res
}

// The docs builder's frontmatter list grammar (docs/build_docs.mjs parse_frontmatter,
// ywr-harness spec 0001 §3), mirrored for the one key this gate reads. It is a second parser
// by necessity, because the retro runs on the committed sources, not on an index that may not be
// rebuilt yet. A pairing test holds it to the builder: two parsers of one field that disagree
// (a block list, an item containing ']', a multi-line flow list) give two different ownership maps.
const FM_KEY_RE = new RegExp('^([A-Za-z0-9_]+)[' + PY_WS + ']*:[' + PY_WS + ']*([^\\n]*)$')
const FM_ITEM_RE = /^[ \t]*-(?:[ \t]+([^\n]*))?$/
const COMMENT_RE = new RegExp('(?:^|[' + PY_WS + '])#')

/**
 * The builder's inline-comment rule: only a '#' after whitespace starts a comment, or a '#'
 * that starts the text, since every caller passes a stripped value or a line and `key:   # x`
 * lost its whitespace to `FM_KEY_RE`. A greedy `[...]` match would instead reach into the
 * comment. The spec template's `implements_in: [ ]   # ... (예: ["docs/build_docs.mjs"])`
 * would then map a file to the template, and `[0-9]*.md` below does scan 0000-template.md.
 * @param {string} v
 * @returns {string}
 */
export function _cut_comment(v) {
  const m = COMMENT_RE.exec(v)
  return hc.py_strip(m ? v.slice(0, m.index) : v)
}

/**
 * The builder's flow-list bracket balance (`_flow_depth`, kept character for character): '['
 * is +1 and ']' is -1. Neither counts inside a quoted item (a quote at an item's head up to the
 * same quote, which is what the item rule reads as quoted). A mid-item quote (`it's.md`) is not a
 * quote. An unquoted `app/[slug]` item is balanced, so it neither opens nor closes a list.
 * @param {string} text
 * @returns {number}
 */
export function _flow_depth(text) {
  let depth = 0
  let quote = null
  let at_item = true
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (at_item && (ch === '"' || ch === "'")) {
      quote = ch
    } else if (ch === '[') {
      depth += 1
    } else if (ch === ']') {
      depth -= 1
    }
    at_item = ch === '[' || ch === ',' || (at_item && hc.py_strip(ch) === '')
  }
  return depth
}

const INT_RX = /^-?\p{Nd}+$/u

/** The value of one Unicode decimal digit. The builder reads every script's digits as integers. */
function digit_value(ch) {
  const c = ch.codePointAt(0)
  if (c < 128) return c - 48
  let base = c
  while (/^\p{Nd}$/u.test(String.fromCodePoint(base - 1))) base--
  return (c - base) % 10
}

/** The integer value of a string that matched `INT_RX`. */
function py_int(text) {
  const neg = text.startsWith('-')
  let n = 0
  for (const ch of neg ? text.slice(1) : text) n = n * 10 + digit_value(ch)
  return neg && n !== 0 ? -n : n
}

/**
 * The builder's item rule (`_parse_item`): a blank item gives null (skipped), and quotes are
 * stripped. An unquoted pure integer becomes a number, as the builder indexes it. verify_map then
 * skips it as a non-path, and `spec_map` drops it the same way, so the two consumers agree on who
 * owns what.
 * @param {string} text
 * @returns {string|number|null}
 */
export function _item(text) {
  text = hc.py_strip(text)
  if (text === '') return null
  const quoted = text.slice(0, 1) === '"' || text.slice(0, 1) === "'"
  text = strip_char(strip_char(text, '"'), "'")
  return !quoted && INT_RX.test(text) ? py_int(text) : text
}

/**
 * `[a, b]` gives items, split on ',' exactly as the builder splits. An item may contain ']'
 * (Next.js `app/api/auth/[...nextauth]/route.ts`), which a lazy `\[(.*?)\]` would truncate.
 * @param {string} v
 * @returns {Array<string|number>}
 */
export function _flow_items(v) {
  return v.slice(1, -1).split(',').map((p) => _item(p)).filter((p) => p !== null)
}

/**
 * `implements_in` of one frontmatter block (its lines, fences excluded), typed exactly as the
 * builder indexes it: a one-line flow `[a, b]`, a block list (`key:` then `- item` lines, blank
 * and comment lines allowed between), or a multi-line flow (a `[` its own line leaves unbalanced,
 * closed on the first later line that balances it and ends in `]`). A later duplicate key wins,
 * as in the builder; a value of any other shape owns nothing (the builder indexes it as a
 * non-list).
 * @param {string[]} block
 * @returns {Array<string|number>}
 */
export function implements_in(block) {
  let found = []
  for (let i = 0; i < block.length; i++) {
    const m = FM_KEY_RE.exec(block[i])
    if (!m || m[1] !== 'implements_in') continue
    const head = _cut_comment(hc.py_strip(m[2]))
    found = []
    if (head === '') {
      for (const s of block.slice(i + 1)) {
        if (!hc.py_strip(s) || hc.py_strip(s).startsWith('#')) continue
        const im = FM_ITEM_RE.exec(s)
        if (!im) break
        let text = hc.py_strip(im[1] || '')
        const q = text.slice(0, 1)
        if ((q === '"' || q === "'") && text.indexOf(q, 1) !== -1) {
          text = text.slice(0, text.indexOf(q, 1) + 1)
        } else {
          text = _cut_comment(text)
        }
        const item = _item(text)
        if (item !== null) found.push(item)
      }
    } else if (head.startsWith('[')) {
      let flow = head
      if (_flow_depth(head) > 0) {
        const parts = [head]
        for (const s of block.slice(i + 1)) {
          if (FM_KEY_RE.test(s)) break // never closed: the builder falls back to the key line's own reading
          const seg = _cut_comment(s)
          if (seg) {
            parts.push(seg)
            const joined = parts.join(' ')
            if (_flow_depth(joined) <= 0) {
              if (joined.endsWith(']')) flow = joined
              break
            }
          }
        }
      }
      if (flow.endsWith(']')) found = _flow_items(flow)
    }
  }
  return found
}

/**
 * (spec_path, implemented_file) pairs from every living spec's `implements_in` frontmatter.
 *
 * Every list shape the builder indexes is accepted (see `implements_in`), because a spec written
 * in any of them is a valid spec, and a parser that silently understood fewer would drop part of
 * the mapping while reporting full coverage. A non-string item (an unquoted number) owns nothing,
 * as verify_map reads the builder's index.
 * @param {string} root
 * @returns {Array<[string, string]>}
 */
export function spec_map(root) {
  const res = []
  const dir = path.join(root, 'docs', 'spec')
  let names = []
  if (is_dir(dir)) {
    try {
      // The glob `[0-9]*.md` is case-insensitive on Windows, and `*` also matches a line break.
      const rx = new RegExp('^[0-9][\\s\\S]*\\.md$', process.platform === 'win32' ? 'i' : '')
      names = fs.readdirSync(dir).filter((n) => rx.test(n))
    } catch (e) {
      if (!is_oserr(e)) throw e
    }
  }
  const key = process.platform === 'win32' ? (n) => n.toLowerCase() : (n) => n
  names.sort((a, b) => hc._cmp(key(a), key(b)))
  for (const name of names) {
    const rel = hc.norm('docs/spec/' + name)
    let text
    try {
      // Every line break folds to `\n`, as the builder reads a file in text mode.
      text = fs.readFileSync(path.join(dir, name)).toString('utf8').replace(/\r\n?/g, '\n')
    } catch (e) {
      if (!is_oserr(e)) throw e
      continue
    }
    // The builder's block rule (`hc.fm_block`): a leading HTML comment is skipped, as the
    // index does. A looser parse here would miss such a spec.
    const block = (hc.fm_block(text) || '').split('\n')
    for (const p of implements_in(block)) {
      if (typeof p === 'string' && p) res.push([rel, hc.norm(p)])
    }
  }
  return res
}

/**
 * @param {string[]} files @param {RegExp[]} scope @param {Iterable<string>} owned @param {RegExp[]} ign
 * @returns {string[]}
 */
export function unowned(files, scope, owned, ign) {
  return files.filter((f) => hc.any_match(scope, f) && !hc.owned(owned, f) && !hc.any_match(ign, f))
}

/**
 * The frontmatter block of <path> at <rev>, by build_docs.mjs's rule (`hc.fm_block`: a leading
 * HTML comment skipped, the block closed by a line whose strip() is `---`).
 *
 * Keyed to frontmatter and NOT to file content, which is the subtlest rule in this gate.
 * Both committed outputs are frontmatter-derived: the builder drops `_`-prefixed keys before
 * writing index.json, and docs.html (the one output embedding the body) is gitignored. A
 * body-only edit therefore produces no delta to regenerate. An append-only ADR addendum has that
 * shape and is the normal way to correct a committed record, so keying on "source changed"
 * would warn on a recurring class whose only answer is to rebuild and confirm no delta by hand.
 * @param {string} root @param {string} rev @param {string} p
 * @returns {string}
 */
export function frontmatter_at(root, rev, p) {
  // Absence is asked structurally, not read off an exit code: `git show rev:path` exits 128 both
  // for an absent path and for every other fatal (a missing object in a shallow clone, a bad
  // rev), and its message is translated under a non-English locale. `ls-tree` answers an absent
  // path with empty output and exit 0, and any failure throws to main's FAILED marker. The
  // caller treats absent as a difference, the conservative side for BUILD.
  if (!git(root, ['--literal-pathspecs', 'ls-tree', '-z', rev, '--', p])) return ''
  const blob = git(root, ['show', `${rev}:${p}`])
  if (!blob) return '' // absent at that rev: the caller treats it as a difference
  const block = hc.fm_block(blob)
  if (block === null) return '<no-frontmatter>' // the builder skips it entirely: a constant, never the body
  return block
}

/**
 * `frontmatter_at` for many [rev, path] pairs, read in one `git cat-file --batch` call: each git
 * start costs tens of milliseconds on Windows, and a slice can touch dozens of docs. A path that
 * cannot travel on the batch's input, one with a line feed or a carriage return, goes through
 * `frontmatter_at`. So does an object that is no blob or that git reports `missing`, so each
 * reads the same as a single call.
 * @param {string} root @param {Array<[string, string]>} sides
 * @returns {string[]}
 */
export function frontmatters_at(root, sides) {
  const batch = sides.filter(([rev, p]) => hc.batchable(`${rev}:${p}`))
  const objs = hc.git_objects(root, batch.map(([rev, p]) => `${rev}:${p}`))
  const got = new Map(batch.map(([rev, p], i) => [`${rev}:${p}`, objs[i]]))
  return sides.map(([rev, p]) => {
    const key = `${rev}:${p}`
    if (!got.has(key)) return frontmatter_at(root, rev, p)
    const o = got.get(key)
    // `missing` is an absent path or a missing object: frontmatter_at tells them apart and throws
    // for the second. An M change has both sides, so this second read is rare.
    if (o === null || o.type !== 'blob') return frontmatter_at(root, rev, p)
    if (o.text === '') return '' // an empty file reads as `git show` reads it
    const block = hc.fm_block(o.text)
    return block === null ? '<no-frontmatter>' : block
  })
}

export const LOG_BODY_FMT = '--format=%x01%h%x00%B'

/**
 * [(short sha, message)] from `git log LOG_BODY_FMT`: a record starts at U+0001, its sha ends at NUL.
 * @param {string} raw
 * @returns {Array<[string, string]>}
 */
export function commit_bodies(raw) {
  const res = []
  for (const rec of raw.split('\x01')) {
    const at = rec.indexOf('\0')
    if (at !== -1) res.push([hc.py_strip(rec.slice(0, at)), rec.slice(at + 1)])
  }
  return res
}

/**
 * (changes, subjects, pre, post). `changes` is [(status, [paths])], and a rename line carries two paths.
 *
 * A merge commit is a RANGE in disguise (ywr-harness ADR 0043): `diff-tree` without `-m` prints
 * NOTHING for one, so treating it as a plain commit would run every check over an empty change
 * set. A merge concluded with `git commit` would fire post-commit and pass silently having
 * checked nothing. The merge reads first-parent semantics (`HEAD^1..HEAD`): everything this merge
 * landed on the line of history, subjects included. Root and ordinary commits use the diff-tree path.
 *
 * The scope is deliberately relative to the first parent: "what arrived on the line the
 * committer stood on". That range fully covers an octopus merge (the tree diff and the
 * subject log both include every non-first leg). A foxtrot merge (first parent is the topic side)
 * therefore reports the other line's changes. That is the stated semantics of an advisory gate,
 * named rather than special-cased: parent order is what the committer's own `git merge` produced.
 * @param {string} root @param {string|null} rev_range
 * @returns {[Array<[string, string[]]>, string[], string, string]}
 */
export function resolve_range(root, rev_range) {
  if (!rev_range && hc.py_strip(git(root, ['rev-parse', '-q', '--verify', 'HEAD^2'], [1]))) {
    rev_range = 'HEAD^1..HEAD'
  }
  let raw
  let bodies
  let pre
  let post
  if (rev_range) {
    raw = git(root, ['diff', '--name-status', '-z', '-M', rev_range])
    // `git log <rev>` lists the whole history behind <rev>, while `git diff <rev>` covers the
    // commits after it. A bare revision reads its messages over `<rev>..HEAD`, the span its diff covers.
    bodies = commit_bodies(git(root, ['log', LOG_BODY_FMT, rev_range.includes('..') ? rev_range : `${rev_range}..HEAD`]))
    if (rev_range.includes('...')) {
      const [a, b] = split_n(rev_range, '...', 1)
      pre = hc.py_strip(git(root, ['merge-base', a, b], [1])) // 1 = no common ancestor
      post = b || 'HEAD'
    } else if (rev_range.includes('..')) {
      const [a, b] = split_n(rev_range, '..', 1)
      pre = hc.py_strip(a)
      post = hc.py_strip(b) || 'HEAD'
    } else {
      pre = ''
      post = rev_range
    }
  } else {
    raw = git(root, ['diff-tree', '-z', '--no-commit-id', '--name-status', '-r', '-M', '--root', 'HEAD'])
    bodies = commit_bodies(git(root, ['log', '-1', LOG_BODY_FMT, 'HEAD']))
    pre = hc.py_strip(git(root, ['rev-parse', '-q', '--verify', 'HEAD^'], [1])) // empty at a root commit
    post = 'HEAD'
  }
  // A subject is the message's first paragraph on one line, as `%s` gives it.
  const subjects = bodies.map(([, m]) => py_split(m.split('\n\n')[0]).join(' '))
  return [name_status_z(raw), subjects.filter((s) => s), pre, post]
}

export const SIZE_LIMIT = 1000
export const _ARGV_BUDGET = 16000 // characters of pathspec per git call; Windows allows ~32k for the whole command line

/**
 * Lines of a working-tree file as `git grep -c ''` counts them, with no git call: 0 for a
 * binary file (a NUL in the first 8000 bytes, git's own test, which `-I` skips), a missing
 * file, a symlink or an unreadable one; otherwise the `\n` count, plus one for an unterminated
 * last line. The HEAD fast path of SIZE only decides WHICH files go to git for the exact count.
 * The count is `hc.text_lines`, read in chunks after the binary test.
 * @param {string} root @param {string} rel
 * @returns {number}
 */
export function worktree_lines(root, rel) {
  const p = path.join(root, rel)
  try {
    if (is_symlink(p) || !is_file(p)) return 0
    return hc.text_lines(p) || 0
  } catch (e) {
    if (is_oserr(e)) return 0
    throw e
  }
}

/** @param {string[]} paths @returns {string[][]} */
export function _chunks(paths) {
  const res = []
  let cur = []
  let size = 0
  for (const x of paths) {
    const len = [...x].length
    if (cur.length && size + len + 1 > _ARGV_BUDGET) {
      res.push(cur)
      cur = []
      size = 0
    }
    cur.push(x)
    size += len + 1
  }
  if (cur.length) res.push(cur)
  return res
}

/**
 * {path: line count at <rev>} by `git grep -I -c --null -e ''`, for the paths that hold at least
 * <min_lines> lines. Git omits a binary file and an empty one, so an absent key reads as 0.
 * Empty <paths> asks for every tracked file at <rev> (the `--coverage` list).
 * The output is `rev:path\0count\n` per file; it is walked by NUL and then newline, never split
 * on `:` (a path can hold one) or on a line break alone (a path can hold one too).
 * @param {string} root @param {string} rev @param {string[]} paths @param {number} [min_lines]
 * @returns {Map<string, number>}
 */
export function counts_at(root, rev, paths, min_lines = 1) {
  const res = new Map()
  const pre = rev.length + 1
  for (const chunk of paths.length ? _chunks(paths) : [[]]) { // no paths = every tracked file at <rev>
    const raw = git(root, ['--literal-pathspecs', 'grep', '-I', '-c', '--null', '-e', '', rev,
      ...(chunk.length ? ['--', ...chunk] : [])], [1]) // exit 1 = no file matched
    let pos = 0
    while (pos < raw.length) {
      const z = raw.indexOf('\0', pos)
      const nl = z >= 0 ? raw.indexOf('\n', z + 1) : -1
      if (z < 0 || nl < 0) break
      const digits = raw.slice(z + 1, nl)
      const n = /^[0-9]+$/.test(digits) ? Number(digits) : 0
      if (n >= min_lines) res.set(hc.norm(raw.slice(pos + pre, z)), n)
      pos = nl + 1
    }
  }
  return res
}

/**
 * [(path, lines after)] for each candidate with fewer than SIZE_LIMIT lines before the range and
 * SIZE_LIMIT or more after it (ywr-harness ADR 0171). A file absent before counts 0.
 * `renamed` maps a new path to the old path of a rename that git detected in the range: the old
 * path's count at `pre` is the count before, so a move alone never crosses (ywr-harness ADR 0188).
 *
 * Speed rule: a commit that touches no large file pays NO git call. With `post` = HEAD the
 * working-tree line count picks the candidates first (a residual, named in ywr-harness spec 0007 §3.4:
 * unstaged edits that shorten a file can hide a crossing); only those go to git, for the exact
 * HEAD count. Any other post rev asks git directly. The count before the range is derived from
 * `diff --numstat`: before = after - added + deleted, 0 for a root commit or a binary side.
 * @param {string} root @param {string[]} cand @param {string} pre @param {string} post
 * @param {Map<string, string>|null} [renamed]
 * @returns {Array<[string, number]>}
 */
export function size_crossings(root, cand, pre, post, renamed = null) {
  if (!cand.length) return []
  if (post === 'HEAD') {
    cand = cand.filter((x) => worktree_lines(root, x) >= SIZE_LIMIT)
    if (!cand.length) return []
  }
  const after = counts_at(root, post, cand, SIZE_LIMIT)
  if (!after.size) return []
  const hit = hc._sorted(after.keys())
  const before = new Map()
  if (pre) {
    const ren = renamed || new Map()
    const moved = new Map(hit.filter((x) => ren.has(x)).map((x) => [x, ren.get(x)]))
    if (moved.size) {
      const old = counts_at(root, pre, hc._sorted(new Set(moved.values())))
      for (const [x, o] of moved) before.set(x, old.has(o) ? old.get(o) : 0)
    }
    for (const chunk of _chunks(hit.filter((x) => !moved.has(x)))) {
      const raw = git(root, ['diff', '--numstat', '-z', '--no-renames', pre, post, '--', ...chunk])
      for (const rec of raw.split('\0')) {
        const cols = split_n(rec, '\t', 2)
        if (cols.length !== 3) continue
        const p = hc.norm(cols[2])
        if (/^[0-9]+$/.test(cols[0]) && /^[0-9]+$/.test(cols[1]) && after.has(p)) {
          before.set(p, Math.max(0, after.get(p) - Number(cols[0]) + Number(cols[1])))
        } else if (after.has(p)) {
          before.set(p, 0) // `-` columns: a binary side counts 0 lines, as git grep -I does
        }
      }
    }
    // A path the diff does not list is unchanged between pre and post: it did not cross.
    for (const x of hit) if (!before.has(x)) before.set(x, after.get(x))
  }
  return hit.filter((x) => (before.has(x) ? before.get(x) : 0) < SIZE_LIMIT).map((x) => [x, after.get(x)])
}

/**
 * @param {string} root @param {Object} cfg @param {string[]} warns @param {string|null} rev_range
 * @returns {string[]}
 */
export function build_findings(root, cfg, warns, rev_range) {
  const [changes, subjects, pre, post] = resolve_range(root, rev_range)
  if (!changes.length) return []

  const last = (c) => c[1][c[1].length - 1]
  const files = changes.map(last) // last field = current path
  // A rename can TRIGGER a check but never SATISFY one. `added` (triggers: MIGRATION, UNMAPPED)
  // keeps renames, because a file moved into a scope is new to it, the conservative reading for an
  // advisory gate. The suppressors take the strict sets: a renamed ADR is not a new decision,
  // and a spec that moved without an edit, or was deleted, updated nothing. Loose sets would let a
  // renamed old ADR silence DEP and a deleted spec silence MIGRATION. BUILD below applies
  // the same "never suppress on what was not checked" rule. Only A counts as new: git reports
  // C only under -C, which neither diff here passes.
  const added = changes.filter((c) => c[0].slice(0, 1) === 'A' || c[0].slice(0, 1) === 'R').map(last)
  const new_files = changes.filter((c) => c[0].slice(0, 1) === 'A').map(last)
  const edited = changes.filter((c) => c[0].slice(0, 1) !== 'D' && c[0] !== 'R100').map(last)
  const fileset = new Set(files)
  const pairs = spec_map(root)
  const owned = new Set(pairs.map(([, p]) => p))
  const compile = (key) => cfg.retro[key].map((p) => hc.compile_re(py_dot(p), `retro.${key}`, warns)).filter((rx) => rx)
  const scope = compile('source_scope')
  const deps = compile('dep_manifests')
  const migs = compile('migrations')
  const ign = hc.load_ignore(root, cfg.retro_ignore_file, warns)

  const f = []

  // 1) DEP: a dependency manifest moved with no new ADR in scope. Lockfile-only changes are a
  //    version bump, not a decision, and the declaration deliberately does not match them.
  if (deps.length && files.some((x) => hc.any_match(deps, x))) {
    if (!new_files.some((x) => ADR_RX.test(x))) {
      f.push('DEP: dependency manifest changed, no new ADR in scope — a new dependency or ' +
             'pattern needs an ADR first')
    }
  }

  // 2) MIGRATION: a schema migration added with no living spec touched.
  if (migs.length && added.some((x) => hc.any_match(migs, x))) {
    if (!edited.some((x) => SPEC_RX.test(x))) {
      f.push('MIGRATION: migration added, no spec updated — check which living spec covers ' +
             'the schema')
    }
  }

  // 3) SPEC: a changed file is some spec's implements_in, but that spec was not updated.
  //    A directory entry counts for every changed file below it (ywr-harness ADR 0104).
  const stale = new Set(pairs.filter(([s, p]) => !fileset.has(s) && [...fileset].some((x) => hc.owns(p, x))).map(([s]) => s))
  for (const sp of hc._sorted(stale)) {
    f.push(`SPEC: changed files are implements_in of ${sp} — spec not updated in scope; ` +
           'verify it still matches')
  }

  // 4) BUILD: doc frontmatter changed but the index was not regenerated. Matched on any path
  //    field, not just the last: a rename out of docs/ drops an entry from the index, and keying
  //    on the final path alone would miss it.
  //    A changed index answers the check, so it reads no frontmatter then. The first difference
  //    decides it, so a non-M change reads none either.
  const doc_changes = changes.filter(([, ps]) => ps.some((p) => DOCS_RX.test(p)))
  const index_rel = hc.norm(cfg.index)
  if (doc_changes.length && !fileset.has(index_rel)) {
    let need = false
    if (!pre || !hc.py_strip(git(root, ['rev-parse', '-q', '--verify', `${pre}^{commit}`], [1]))) {
      need = true // no comparable endpoint: do not suppress what cannot be checked
    } else if (doc_changes.some(([st]) => !st.startsWith('M'))) {
      need = true // add/delete/rename/copy changes the entry set or its path field
    } else {
      const sides = doc_changes.flatMap(([, ps]) => [[pre, ps[0]], [post, ps[ps.length - 1]]])
      const fm = frontmatters_at(root, sides)
      for (let i = 0; i < fm.length; i += 2) {
        if (fm[i] !== fm[i + 1]) { need = true; break }
      }
    }
    if (need) {
      f.push(`BUILD: docs frontmatter changed but ${index_rel} untouched — run: ` +
             'node docs/build.mjs')
    }
  }

  // 5) FEAT: a feat commit with no docs change at all. Coarse on purpose, as the backstop for
  //    everything the structural checks cannot see.
  if (subjects.some((s) => s.startsWith('feat'))) {
    if (!files.some((x) => x.startsWith('docs/'))) {
      f.push('FEAT: feat commit(s) with no docs change — did this slice make a decision ' +
             '(ADR) or change behavior a spec describes?')
    }
  }

  // 6) UNMAPPED: a newly added in-scope file no spec owns. Added-files-only is the same adoption
  //    strategy as staged-only lint: new code is owned from day one and the legacy baseline does
  //    not spam every commit.
  for (const x of unowned(added, scope, owned, ign)) {
    f.push(`UNMAPPED: new file ${x} is owned by no spec — add it to a spec's implements_in, ` +
           `write the missing spec, or add it to ${cfg.retro_ignore_file}`)
  }

  // 7) DEADMAP: an implements_in entry pointing at a file that no longer exists.
  for (const [sp, p] of dead_pairs(root, pairs)) {
    f.push(`DEADMAP: ${sp} maps ${p} which does not exist — renamed or deleted; fix implements_in`)
  }

  // 8) SIZE: an in-scope file that crosses the limit in this range (ywr-harness ADR 0171). Crossing-only is
  //    the UNMAPPED adoption strategy again: new growth reports once, and the baseline stays out of
  //    each commit and lives under --coverage. A deleted file never reports, and a rename that git
  //    detects counts its old path's lines before (ywr-harness ADR 0188). A range with no
  //    start (a bare rev, `..X`) has no before count to compare, so it skips the check.
  if (scope.length && (pre || !rev_range)) {
    const cand = hc._sorted(new Set(changes.filter((c) => c[0].slice(0, 1) !== 'D' && hc.any_match(scope, last(c))).map(last)))
    const renamed = new Map(changes.filter((c) => c[0].slice(0, 1) === 'R' && c[1].length === 2).map((c) => [c[1][1], c[1][0]]))
    for (const [x, n] of size_crossings(root, cand, pre, post, renamed)) {
      f.push(`SIZE: ${x} crossed ${fmt_int(SIZE_LIMIT)} lines (now ${fmt_int(n)}) — consider splitting it`)
    }
  }

  return f
}

/**
 * The distinct (spec, path) pairs whose file is missing, sorted by code point. `path.resolve` keeps an
 * absolute `p` as it is.
 * @param {string} root @param {Array<[string, string]>} pairs
 * @returns {Array<[string, string]>}
 */
function dead_pairs(root, pairs) {
  const seen = new Map()
  for (const [s, p] of pairs) {
    if (!exists(path.resolve(root, p))) seen.set(JSON.stringify([s, p]), [s, p])
  }
  return [...seen.values()].sort((a, b) => hc._cmp(a[0], b[0]) || hc._cmp(a[1], b[1]))
}

/**
 * @param {string} root @param {Object} cfg @param {string[]} warns
 * @returns {number}
 */
export function coverage(root, cfg, warns) {
  out('[slice-retro] coverage report')
  const has_head = !!hc.py_strip(git(root, ['rev-parse', '-q', '--verify', 'HEAD'], [1]))
  const rc = _coverage_body(root, cfg, warns, has_head)
  out(`-- ignore register: ${cfg.retro_ignore_file}` +
      (is_file(path.resolve(root, cfg.retro_ignore_file)) ? '' : '   (absent — nothing is exempt)'))
  for (const w of warns) hc.warn(w)
  return rc
}

/**
 * @param {string} root @param {Object} cfg @param {string[]} warns @param {boolean} has_head
 * @returns {number}
 */
export function _coverage_body(root, cfg, warns, has_head) {
  const pairs = spec_map(root)
  const owned = new Set(pairs.map(([, p]) => p))
  const scope = cfg.retro.source_scope.map((p) => hc.compile_re(py_dot(p), 'retro.source_scope', warns)).filter((rx) => rx)
  const ign = hc.load_ignore(root, cfg.retro_ignore_file, warns)

  // A disabled check is REPORTED. An unconfigured repo must not read as a clean one.
  for (const name of ['source_scope', 'dep_manifests', 'migrations']) {
    if (!cfg.retro[name].length) {
      out(`-- retro.${name} not declared — the checks it drives are DISABLED, not passing`)
    }
  }

  const dead = dead_pairs(root, pairs)
  if (dead.length) {
    out(`-- dead mappings (implements_in -> missing file): ${dead.length}`)
    for (const [s, p] of dead) out(`   ${s}\t${p}`)
  } else {
    out('-- dead mappings: none')
  }

  if (scope.length) {
    const tracked = hc.git_paths(root, ['ls-files'])
    const un = unowned(tracked, scope, owned, ign)
    const in_scope = tracked.filter((x) => hc.any_match(scope, x))
    if (un.length) {
      out(`-- unowned files (in scope, no spec, not ignored): ${un.length} of ${in_scope.length} in scope`)
      for (const x of un) out(`   ${x}`)
    } else {
      out(`-- unowned files: none (${in_scope.length} in scope, all owned or ignored)`)
    }
    // SIZE's baseline (ywr-harness ADR 0171): the files the per-commit check will never report again. One
    // git call over HEAD, and the scope filter runs here, so the argv stays short.
    let big = []
    if (has_head) {
      big = [...counts_at(root, 'HEAD', [], SIZE_LIMIT)].filter(([x]) => hc.any_match(scope, x))
    } // no commit yet: nothing is tracked at HEAD
    if (big.length) {
      out(`-- files at or over ${fmt_int(SIZE_LIMIT)} lines (in scope, tracked at HEAD): ${big.length}`)
      big.sort((a, b) => (b[1] - a[1]) || hc._cmp(a[0], b[0]))
      for (const [x, n] of big) out(`   ${x}\t${fmt_int(n)}`)
    } else {
      out(`-- files at or over ${fmt_int(SIZE_LIMIT)} lines: none`)
    }
  }
  return 0
}

// The delegation ledger (ywr-harness ADR 0117/0118): the slot files the plugin's hooks module writes.
// Read only, on request (ywr-harness ADR 0120), because the ledger is session-scoped and the per-commit
// run is commit-scoped.
export const LEDGER_DIR = ['.claude', 'telemetry', 'delegations']
export const SLOT_RX = /^slot-[0-9]{2}\.json(?=\n?$)/
export const LEDGER_SCHEMA = 2
export const TOKENS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
// `teammate` is read, not written: an `agent-tool` loop whose spawn row says `teammate: true` (an
// agent-team teammate raises `agent.spawn` from Claude Code 2.1.289). `workflow` is the loop of a Workflow
// `agent()` worker from Claude Code 2.1.292 (ywr-harness ADR 0126). `unspawned` is the same worker on
// 2.1.287-2.1.291.
export const KIND_ORDER = new Map([['main', 0], ['agent-tool', 1], ['teammate', 2], ['workflow', 3], ['unspawned', 4]])
export const SPAWNED = ['agent-tool', 'teammate', 'workflow']
// The spawn type of a workflow `agent()` call that names no agent type (ywr-harness fact 99, Claude
// Code 2.1.292).
export const WF_TYPE = 'workflow-subagent'

const g = hc._get

/** A positive integer, else 0. @param {*} v @returns {number} */
export function _count(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0
}

/** The sorted distinct non-empty strings of a list, else an empty list. @param {*} v @returns {string[]} */
export function _names(v) {
  return Array.isArray(v) ? hc._sorted(new Set(v.filter((x) => typeof x === 'string' && x))) : []
}

/**
 * A spawn row's string field: the string, null when absent or null, "?" for an empty string or
 * any other JSON type. A row key must be a string and the row sort compares strings only, so a list
 * or a number there would crash the report. "?" names the row and is truthy, so a malformed field
 * never counts as an inherit (an empty `model_param` must not read as "no model given").
 * @param {*} v @returns {string|null}
 */
export function _text(v) {
  return v === null || v === undefined || (typeof v === 'string' && v) ? (v ?? null) : '?'
}

/**
 * (name, document) for every readable schema-2 slot, and one `name (reason)` per skipped one.
 * A write is a non-atomic whole-file rewrite (ywr-harness ADR 0118), so a partial file is an expected skip.
 * @param {string} d
 * @returns {[Array<[string, Object]>, string[]]}
 */
export function read_slots(d) {
  const docs = []
  const skipped = []
  let entries
  try {
    entries = hc._sorted(fs.readdirSync(d))
  } catch (e) {
    if (!is_oserr(e)) throw e
    return [docs, [`${path.basename(d)}/ (unreadable directory: ${strerror(e)})`]]
  }
  for (const name of entries) {
    if (!SLOT_RX.test(name)) continue
    const full = path.join(d, name)
    if (!is_file(full)) {
      skipped.push(`${name} (not a regular file)`)
      continue
    }
    let buf
    try {
      buf = fs.readFileSync(full)
    } catch (e) {
      if (!is_oserr(e)) throw e
      skipped.push(`${name} (unreadable: ${strerror(e)})`)
      continue
    }
    let doc
    try {
      // Fatal decoding and a kept byte-order mark: an invalid byte or a U+FEFF both read as "not JSON".
      doc = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf))
    } catch {
      skipped.push(`${name} (not JSON — a write in flight or a partial file)`)
      continue
    }
    if (!hc._is_dict(doc) || g(doc, 'schema') !== LEDGER_SCHEMA ||
        !Array.isArray(g(doc, 'step_fields')) || !Array.isArray(g(doc, 'loops')) ||
        !doc.step_fields.every((x) => typeof x === 'string')) {
      skipped.push(`${name} (not a schema ${LEDGER_SCHEMA} slot)`)
      continue
    }
    docs.push([name, doc])
  }
  return [docs, skipped]
}

/**
 * A loop's token sums and whether they are the host's own (`complete.usage`, summed over every
 * request, dropped steps included). Without it the kept steps are summed, read by `step_fields`
 * NAME (ywr-harness ADR 0118: a step is a tuple; a field the file lacks reads as absent).
 * @param {Object} loop @param {string[]} fields
 * @returns {[Object<string, number>, boolean]}
 */
export function loop_tokens(loop, fields) {
  const done = g(loop, 'complete')
  const usage = hc._is_dict(done) ? g(done, 'usage') : null
  if (hc._is_dict(usage)) {
    return [Object.fromEntries(TOKENS.map((k) => [k, _count(g(usage, k))])), true]
  }
  const sums = Object.fromEntries(TOKENS.map((k) => [k, 0]))
  const steps = g(loop, 'steps')
  for (const st of Array.isArray(steps) ? steps : []) {
    const row = new Map()
    if (Array.isArray(st)) {
      for (let i = 0; i < Math.min(fields.length, st.length); i++) row.set(fields[i], st[i])
    }
    for (const k of TOKENS) sums[k] += _count(row.get(k))
  }
  return [sums, false]
}

/** @param {Array<string|null>} key @param {Object} agg @returns {string} */
export function _fmt_row(key, agg) {
  const [kind, stype, mparam, models, efforts] = key
  const who = !SPAWNED.includes(kind) ? kind : `${kind} ${stype || '?'} (model_param ${mparam || 'none'})`
  const tok = agg.tokens
  const resumes = agg.resumes > 0 ? `${agg.resumes} resume(s), ` : ''
  let line = (`   ${who} · ${models || '?'} · ${efforts || '-'} — ${agg.loops} loop(s), ${resumes}` +
              `${fmt_secs(agg.ms)} s, tokens in ${fmt_int(tok.input_tokens)} · out ${fmt_int(tok.output_tokens)} · ` +
              `cache read ${fmt_int(tok.cache_read_input_tokens)} · cache write ${fmt_int(tok.cache_creation_input_tokens)}`)
  if (agg.from_steps) {
    line += ` (${agg.from_steps} loop(s) without complete.usage — kept steps summed)`
  }
  return line
}

/**
 * @param {string} root @param {string[]} warns
 * @returns {number}
 */
export function delegations(root, warns) {
  const d = path.join(root, ...LEDGER_DIR)
  const rel = LEDGER_DIR.join('/')
  out('[slice-retro] delegation ledger (ywr-harness ADR 0120)')
  if (!is_dir(d)) {
    out(`-- no ledger at ${rel} — the hooks module writes it on Claude Code 2.1.287+, only in a ` +
        'root holding .harness.json (ywr-harness ADR 0117)')
    for (const w of warns) hc.warn(w)
    return 0
  }
  const [docs, skipped] = read_slots(d)

  // Sessions across files: ywr-harness ADR 0118's LRU residual can split one session over two slots. A null id
  // is grouped per file, because every id-less session writes the same header and the id joins nothing.
  const sessions = new Map()
  for (const [name, doc] of docs) {
    const sid = g(doc, 'session_id')
    const key = typeof sid === 'string' && sid ? sid : `(no session id) ${name}`
    if (!sessions.has(key)) sessions.set(key, { slots: [], loops: [], loops_dropped: 0, updated: '' })
    const s = sessions.get(key)
    s.slots.push(name)
    s.loops_dropped += _count(g(doc, 'loops_dropped'))
    const upd = g(doc, 'updated')
    if (typeof upd === 'string' && hc._cmp(upd, s.updated) > 0) s.updated = upd
    const fields = doc.step_fields
    for (const lp of doc.loops) if (hc._is_dict(lp)) s.loops.push([lp, fields])
  }

  let n_loops = 0
  for (const s of sessions.values()) n_loops += s.loops.length
  out(`-- ${rel}: ${docs.length} slot file(s), ${sessions.size} session(s), ${n_loops} loop(s)`)
  const d6 = { on_main: 0, same_effort: 0, sessions: 0, evicted: 0, no_main: 0, wf: 0, wf_inherit: 0, wf_sessions: 0 }
  const dropped = { loops: 0, steps: 0 }
  // Newest first. The sort is stable, so reversing the comparison keeps the original order of equal keys.
  const ordered = [...sessions].sort((a, b) => hc._cmp(b[1].updated, a[1].updated))
  for (const [key, s] of ordered) {
    const mains = s.loops.filter(([lp]) => g(lp, 'loop') === 'main').map(([lp]) => lp)
    const main_models = new Set(mains.flatMap((lp) => _names(g(lp, 'models'))))
    const main_efforts = new Set(mains.flatMap((lp) => _names(g(lp, 'efforts'))))
    out(`-- session ${key} · ${s.slots.join(', ')} · updated ${s.updated || '?'} · main: ` +
        (mains.length
          ? `${hc._sorted(main_models).join('+') || '?'} [${hc._sorted(main_efforts).join('+') || '-'}]`
          : 'no main loop recorded'))
    const rows = new Map() // JSON of the row key -> {key, agg}, in first-seen order
    const agent_max = new Map() // agent id -> [max resumes, JSON of the row key of that loop]
    let on_main = 0
    let same = 0
    let wf = 0
    let wf_inherit = 0
    for (const [lp, fields] of s.loops) {
      let kind = typeof g(lp, 'loop') === 'string' ? g(lp, 'loop') : '?'
      const spawn = hc._is_dict(g(lp, 'spawn')) ? g(lp, 'spawn') : {}
      if (kind === 'agent-tool' && g(spawn, 'teammate') === true) kind = 'teammate'
      const models = _names(g(lp, 'models'))
      const efforts = _names(g(lp, 'efforts'))
      const stype = _text(g(spawn, 'subagent_type'))
      const mparam = _text(g(spawn, 'model_param'))
      // A spawned row with no type and one with a malformed type both print "?": one key.
      const spawned = SPAWNED.includes(kind)
      const rk = [kind, spawned ? (stype || '?') : null, spawned ? mparam : null, models.join('+'), efforts.join('+')]
      const rks = JSON.stringify(rk)
      if (!rows.has(rks)) {
        rows.set(rks, {
          key: rk,
          agg: { loops: 0, ms: 0, from_steps: 0, resumes: 0, tokens: Object.fromEntries(TOKENS.map((k) => [k, 0])) },
        })
      }
      const agg = rows.get(rks).agg
      agg.loops += 1
      // ywr-harness ADR 0147 counts resumes on the spawn row, and a loop carries the row as it stood
      // when the loop ended: an agent resumed twice leaves loops that read 0, 1 and 2. The count of
      // an agent is therefore the maximum over its loops, never the sum, credited once per session.
      // A loop with no string agent id cannot be matched to another, so it adds its own value.
      const n_res = _count(g(spawn, 'resumes'))
      const aid = g(lp, 'agent_id')
      if (typeof aid === 'string' && aid) {
        if (!agent_max.has(aid) || n_res > agent_max.get(aid)[0]) { // a tie keeps the first loop
          agent_max.set(aid, [n_res, rks])
        }
      } else {
        agg.resumes += n_res
      }
      const done = hc._is_dict(g(lp, 'complete')) ? g(lp, 'complete') : {}
      agg.ms += _count(g(done, 'duration_ms'))
      const [tok, host] = loop_tokens(lp, fields)
      for (const k of TOKENS) agg.tokens[k] += tok[k]
      agg.from_steps += host ? 0 : 1
      dropped.steps += _count(g(lp, 'steps_dropped'))
      if (kind === 'workflow') {
        // ywr-harness ADR 0126: no `model_param` on a workflow spawn row means the `agent()` call gave no
        // model. With no agent type named (`workflow-subagent`) the worker ran on the session's model.
        // That is a fact, not a heuristic. A named type may pin its own model, so it is never counted.
        wf += 1
        wf_inherit += mparam || stype !== WF_TYPE ? 0 : 1
        continue
      }
      if (kind !== 'unspawned') continue
      // ywr-harness ADR 0117: `unspawned` is a workflow worker only while no spawn row was evicted.
      if (_count(g(lp, 'spawn_rows_evicted'))) {
        d6.evicted += 1
      } else if (!mains.length) {
        d6.no_main += 1
      } else if (models.some((m) => main_models.has(m))) {
        on_main += 1
        // Unknown on both sides (Haiku sends no effort) is no evidence of an inherit.
        const same_efforts = efforts.length === main_efforts.size && efforts.every((e) => main_efforts.has(e))
        same += main_efforts.size && same_efforts ? 1 : 0
      }
    }
    // One map per session credits each agent's maximum to one row, the row of the loop that holds it.
    // Per-row maxima would count an agent twice when its loops land in two rows (a model or effort
    // that changed between runs).
    for (const [n_res, rks] of agent_max.values()) rows.get(rks).agg.resumes += n_res
    // A key part is null for a spawn row without that field: sort it as "" so a string and null never meet.
    const order = (k) => KIND_ORDER.has(k[0]) ? KIND_ORDER.get(k[0]) : 9
    const sorted_rows = [...rows.values()].sort((a, b) => {
      const dk = order(a.key) - order(b.key)
      if (dk) return dk
      for (let i = 0; i < a.key.length; i++) {
        const c = hc._cmp(a.key[i] || '', b.key[i] || '')
        if (c) return c
      }
      return 0
    })
    for (const r of sorted_rows) out(_fmt_row(r.key, r.agg))
    if (wf_inherit) {
      out(`   workflow with no model given: ${wf_inherit} of ${wf} (inherits the session's model)`)
      d6.wf_sessions += 1
    }
    d6.wf += wf
    d6.wf_inherit += wf_inherit
    if (on_main) {
      out(`   unspawned on the main model: ${on_main} (same effort as main: ${same})`)
      d6.sessions += 1
    }
    d6.on_main += on_main
    d6.same_effort += same
    dropped.loops += s.loops_dropped
  }

  out(`-- ywr-harness ADR 0117 D6: ${d6.on_main} unspawned loop(s) on their session's main model in ` +
      `${d6.sessions} session(s); ${d6.same_effort} also at the main loop's effort (the inherit ` +
      'signature — a heuristic for hosts before 2.1.292: a pin equal to the session\'s effort reads ' +
      'the same)')
  out(`-- ywr-harness ADR 0126 D6: ${d6.wf_inherit} of ${d6.wf} workflow loop(s) with no model given in ` +
      `${d6.wf_sessions} session(s) (a direct inherit, Claude Code 2.1.292+, no heuristic)`)
  if (d6.evicted || d6.no_main) {
    out(`   not attributed: ${d6.evicted} with spawn rows evicted (may be Agent-tool loops), ` +
        `${d6.no_main} in a session with no main loop recorded`)
  }
  out(dropped.loops || dropped.steps
    ? `-- caps: ${dropped.loops} loop(s) dropped by the file caps, ${dropped.steps} step row(s) ` +
      'dropped by the per-loop cap'
    : '-- caps: nothing dropped')
  for (const x of skipped) out(`-- skipped: ${x}`)
  for (const w of warns) hc.warn(w)
  return 0
}

// --- Command line --------------------------------------------------------------------------------
// The argument grammar follows argparse: long options may be abbreviated to a unique prefix,
// `--opt=value` and `--opt value` both work, `--` ends the options, a negative number is a
// positional, and a usage error prints the usage and exits 2.
const PROG = 'harness_retro.mjs'
const USAGE = `usage: ${PROG} [-h] [--repo REPO] [--coverage] [--delegations]\n` +
  `${' '.repeat(8 + PROG.length)}[range]`
const HELP = `${USAGE}\n\nDeterministic slice retrospective (advisory).\n\npositional arguments:\n  range\n\n` +
  'options:\n  -h, --help     show this help message and exit\n  --repo REPO\n  --coverage\n  --delegations\n'

// Registration order is the order an "ambiguous option" message lists its matches in.
const OPTIONS = [
  { flags: ['-h', '--help'], dest: 'help', takes: false },
  { flags: ['--repo'], dest: 'repo', takes: true },
  { flags: ['--coverage'], dest: 'coverage', takes: false },
  { flags: ['--delegations'], dest: 'delegations', takes: false },
  // Accepted and ignored. A commit-msg hook that an earlier scaffold version placed still calls this mode, and
  // an unknown flag would make that hook refuse every message holding the word "confirmed" (ywr-harness ADR 0215).
  { flags: ['--class-message'], dest: 'class_message', takes: true },
]
const OPTION_STRINGS = OPTIONS.flatMap((o) => o.flags.map((flag) => [flag, o]))
const NEGATIVE_NUMBER = /^-(?:\d+|\d*\.\d+)$/

class UsageError extends Error {}

/** Writes the usage, then `prog: error: message`, to stderr and returns exit code 2. */
function usage_error(message) {
  process.stderr.write(`${USAGE}\n${PROG}: error: ${message}\n`)
  return 2
}

/**
 * How one argument reads, classified as argparse does: a positional (null), a recognised option,
 * or an unknown option-like string.
 * @param {string} arg
 * @returns {null | {opt: Object|null, flag: string, explicit: string|null}}
 */
function classify(arg) {
  if (!arg || arg[0] !== '-') return null
  const exact = OPTION_STRINGS.find(([flag]) => flag === arg)
  if (exact) return { opt: exact[1], flag: arg, explicit: null }
  if (arg.length === 1) return null
  const eq = arg.indexOf('=')
  if (eq !== -1) {
    const head = OPTION_STRINGS.find(([flag]) => flag === arg.slice(0, eq))
    if (head) return { opt: head[1], flag: head[0], explicit: arg.slice(eq + 1) }
  }
  const matches = []
  if (arg.startsWith('--')) {
    const prefix = eq === -1 ? arg : arg.slice(0, eq)
    const explicit = eq === -1 ? null : arg.slice(eq + 1)
    for (const [flag, opt] of OPTION_STRINGS) if (flag.startsWith(prefix)) matches.push({ opt, flag, explicit })
  } else {
    for (const [flag, opt] of OPTION_STRINGS) {
      if (flag === arg.slice(0, 2)) matches.push({ opt, flag, explicit: arg.slice(2) })
      else if (flag.startsWith(arg)) matches.push({ opt, flag, explicit: null })
    }
  }
  if (matches.length > 1) {
    throw new UsageError(`ambiguous option: ${arg} could match ${matches.map((m) => m.flag).join(', ')}`)
  }
  if (matches.length === 1) return matches[0]
  if (NEGATIVE_NUMBER.test(arg)) return null
  if (arg.includes(' ')) return null
  return { opt: null, flag: arg, explicit: null }
}

/**
 * @param {string[]} argv
 * @returns {{help: true} | {args: {repo: string|null, coverage: boolean, delegations: boolean, range: string|null, class_message: string|null}}}
 */
function parse_args(argv) {
  const args = { repo: null, coverage: false, delegations: false, range: null, class_message: null }
  const extras = []
  // One pass over the tokens: `--` marks the end of the options and everything after it is positional.
  const toks = []
  let seen_dd = false
  for (const a of argv) {
    if (seen_dd) toks.push({ kind: 'A', text: a })
    else if (a === '--') { toks.push({ kind: '-', text: a }); seen_dd = true }
    else {
      const c = classify(a)
      toks.push(c ? { kind: 'O', text: a, ...c } : { kind: 'A', text: a })
    }
  }
  let have_range = false
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.kind === '-') continue
    if (t.kind === 'A') {
      if (!have_range) { args.range = t.text; have_range = true } else extras.push(t.text)
      continue
    }
    if (!t.opt) { extras.push(t.text); continue }
    const names = t.opt.flags.join('/')
    if (t.opt.dest === 'help') {
      // `-hx` still shows the help, as in argparse. A long form or an `=` form takes no value.
      if (t.explicit !== null && (t.flag === '--help' || t.text.includes('='))) {
        throw new UsageError(`argument ${names}: ignored explicit argument '${t.explicit}'`)
      }
      return { help: true }
    }
    if (!t.opt.takes) {
      if (t.explicit !== null) throw new UsageError(`argument ${names}: ignored explicit argument '${t.explicit}'`)
      args[t.opt.dest] = true
      continue
    }
    let value = t.explicit
    if (value === null) {
      if (i + 1 >= toks.length || toks[i + 1].kind !== 'A') throw new UsageError(`argument ${names}: expected one argument`)
      value = toks[i + 1].text
      i += 1
    }
    args[t.opt.dest] = value
  }
  if (extras.length) throw new UsageError(`unrecognized arguments: ${extras.join(' ')}`)
  return { args }
}

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {number} the exit code
 */
export function main(argv) {
  let parsed
  try {
    parsed = parse_args(argv)
  } catch (e) {
    if (e instanceof UsageError) return usage_error(e.message)
    throw e
  }
  if (parsed.help) {
    out(HELP.replace(/\n$/, ''))
    return 0
  }
  const args = parsed.args
  if (args.class_message !== null) {
    if (args.coverage || args.delegations || args.range !== null || args.repo !== null) {
      return usage_error('--class-message takes no other argument')
    }
    return 0
  }
  // The skip hatch belongs to the per-commit run (ywr-harness ADR 0120): an explicit --delegations request is
  // never silenced by it. Read after parsing, so an abbreviated flag (`--deleg`) is the same request.
  if (process.env.SLICE_RETRO === '0' && !args.delegations) return 0
  if (args.delegations && (args.coverage || args.range)) {
    return usage_error('--delegations takes no range and does not combine with --coverage')
  }

  const root = args.repo ? realpath(args.repo) : hc.find_repo_root(process.cwd())
  const [cfg, warns] = hc.load(root)
  if (args.delegations) return delegations(root, warns)

  let findings
  try {
    if (args.coverage) return coverage(root, cfg, warns)
    findings = build_findings(root, cfg, warns, args.range)
  } catch (e) {
    if (is_cpe(e)) {
      // The one non-zero exit (ywr-harness ADR 0041). An empty retro reads as "clean", so a git
      // failure must print a marker, never silence. The post-commit hook calls this with `|| true`,
      // so the commit is untouched either way.
      process.stderr.write(`git failed: ${hc.py_strip(e.stderr || '')}\n`)
      out(`[slice-retro] FAILED — git ${e.cmd.slice(1 + hc.GIT_PINS.length).join(' ')} exited ` +
          `${e.returncode}; NO retro check ran. This is not a clean retro (ywr-harness ADR 0041).`)
      return 1
    }
    if (is_oserr(e)) {
      // git itself could not start (not on PATH, as in a hook environment with a stripped PATH):
      // the same marker, never a raw stack trace.
      process.stderr.write(`git failed to start: ${e.message}\n`)
      out('[slice-retro] FAILED — git could not be run; NO retro check ran. This is not a clean ' +
          'retro (ywr-harness ADR 0041).')
      return 1
    }
    throw e
  }
  if (findings.length) {
    out('[slice-retro] retro gate (zero-token advisory) — findings:')
    for (const x of findings) out(`[slice-retro] ${x}`)
    out('[slice-retro] action: supplement ADR/spec as needed, rebuild the index, and commit ' +
        'the docs; ignore only if intentional.')
  }
  // Warnings go to stderr even on a clean run: a malformed declaration silently narrowing the
  // checks would look identical to a repo that has nothing to report.
  for (const w of warns) hc.warn(w)
  return 0
}

/**
 * Starts the independent git reads of `resolve_range` at the same time, before the synchronous `main`
 * takes them (ywr-harness ADR 0236): the name-status diff, the commit bodies and the parent probes.
 * On a merge commit the three non-merge reads stay untaken until the process exits. Any failure
 * here only costs the overlap: `main` starts each read itself.
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
export async function prefetch(argv) {
  try {
    const parsed = parse_args(argv)
    const args = parsed.args
    if (parsed.help || !args || args.class_message !== null || args.coverage || args.delegations) return
    if (process.env.SLICE_RETRO === '0') return
    const root = args.repo ? realpath(args.repo) : hc.find_repo_root(process.cwd())
    const r = args.range
    await hc.git_prefetch(root, r
      ? [['diff', '--name-status', '-z', '-M', r], ['log', LOG_BODY_FMT, r.includes('..') ? r : `${r}..HEAD`]]
      : [['rev-parse', '-q', '--verify', 'HEAD^2'], ['diff-tree', '-z', '--no-commit-id', '--name-status', '-r', '-M', '--root', 'HEAD'],
          ['log', '-1', LOG_BODY_FMT, 'HEAD'], ['rev-parse', '-q', '--verify', 'HEAD^']])
  } catch { /* the overlap is lost, and main starts every read itself */ }
}

/** True when node runs this file itself, not when another module imports it. */
function is_main() {
  try {
    return !!process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (is_main()) {
  await prefetch(process.argv.slice(2))
  try {
    process.exitCode = main(process.argv.slice(2))
  } finally {
    flush_out()
  }
}
