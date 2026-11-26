// Shared reader for `.harness.json` — the ONE place repo-specific harness values are parsed.
//
// Imported by the harness scripts as `import * as hc from './harness_config.mjs'`; no script reads
// the file itself. There is deliberately one reader for one schema: two readers of the same file is
// the divergence this plugin exists to prevent (ywr-harness ADR 0010), and a validator that only
// some consumers apply is not a validator.
//
// Port conventions (ESM, Node built-ins only, synchronous only):
//   - Every top-level name keeps the name it has in the Python reader, helpers with a leading
//     underscore included, so a caller reads `hc.name(...)` in both.
//   - A Python tuple, list or dict is an array or a plain object, None is null, a compiled pattern
//     is a RegExp, a `Path` argument is a string. Repo-relative paths stay POSIX (`/`).
//   - A Python keyword argument with a default is a trailing options object. A `warns` list stays a
//     plain array that the function appends to. For `compose`, `verify_command` and `gate_command`
//     the `warns` argument may be the array or `{warns}`.
//   - Where Python raises an exception that a caller catches by type, the Error carries that
//     type name in `.name` (`CalledProcessError`, `FileNotFoundError`, `OSError`, `KeyError`,
//     `UnicodeDecodeError`, `JSONDecodeError`). This library never calls `process.exit` and never
//     raises `SystemExit`.
//   - JSON is read with `JSON.parse`. Known differences from Python's `json`: `1.0` is the integer
//     `1` here and a float there; `NaN` and `Infinity` literals are refused here; an object key that
//     looks like an array index (`"1"`) is iterated before the other keys here.
//
// ## Why selectors instead of command strings
//
// The consumers that print commands PRINT them for a person or an agent to run. `.harness.json` lives
// in the working tree, so a cloned repository could otherwise supply the command that ends up
// executed. Claude Code closed the same hole in its own surface: project-scope `pluginConfigs`
// entries are ignored because those values "would flow into plugin hook commands"
// (plugins-reference). So:
//
// - `runner` is a SELECTOR from the closed set below. A `gates` entry is either a selector from the
//   closed `GATES` set, or a script gate `{runner, script, files}` (ywr-harness ADR 0024) whose
//   runner is a selector from `RUNNERS` and whose script is a validated repo-relative path — the
//   repo points at code it already carries; it never authors argv. A value outside a set is refused,
//   the set is named in the warning, and the entry is dropped (for `verify.runner`, the default
//   substituted).
// - Path values are refused if they contain a shell metacharacter or `..`. Every token that reaches
//   a command position — script paths from here AND from the docs index, plus the changed-file
//   arguments of a file-scoped gate — additionally passes `token_ok()` in the form it will actually
//   be composed (post `strip_prefix`), and `as_arg()` neutralizes a leading dash. A changed-file
//   argument alone passes the wider `file_arg_ok()` (`( ) [ ]` too, always single-quoted;
//   ywr-harness ADR 0112), and a changed file absent from the working tree is never one.
// - A refused value IS echoed in the warning — the reader has to see what was refused — but never
//   reaches a printed command. Those are separate properties, asserted separately.
// - A file that cannot be an argument is EXCLUDED from the gate's arguments and reported as ungated:
//   a filename is repo-supplied text too, and silence there would read as coverage.
// - Regexes are accepted as free strings: they select and report, and cannot name an executable.
//
// Adding a stack means adding a template HERE, reviewed once, available to every consuming repo.
// That is the whole mechanism by which this harness is stack-agnostic and still able to grow. A
// repo-specific entry point — a path no repo-independent selector could ever name — is a script
// gate instead (ywr-harness ADR 0024).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  GIT_PINS, git_run, git_lines, git_paths, git_objects, batchable, git_result, git_absent, which_on_path,
  decode_utf8_backslashreplace, py_strip, _repr_str,
} from './harness_git.mjs'

export {
  GIT_PINS, git_run, git_lines, git_paths, git_objects, batchable, git_result, git_absent, which_on_path,
  decode_utf8_backslashreplace, py_strip, _repr_str,
}

// ---------------------------------------------------------------------------------------------
// Python-semantics helpers. Python and JavaScript differ in small ways that matter for a security
// reader: truthiness, `str()` of a JSON value, the whitespace set, line splitting, code-point sort
// order, and where a regex is anchored. Each difference has one helper here.
// ---------------------------------------------------------------------------------------------
const BS = String.fromCharCode(92)

function _py_error(name, message, props = {}) {
  const e = new Error(message)
  e.name = name
  return Object.assign(e, props)
}

/** Whether `obj` has `key` as an OWN property (`key in dict`); never reads the prototype. */
export function _has(obj, key) {
  return obj !== null && obj !== undefined && Object.hasOwn(obj, key)
}

/** `dict.get(key, default)`: an own property, else `default` (null when none is given). */
export function _get(obj, key, dflt = null) {
  return _has(obj, key) ? obj[key] : dflt
}

/** `dict[key]`: an own property, else an Error named `KeyError`. */
export function _idx(obj, key) {
  if (!_has(obj, key)) throw _py_error('KeyError', `'${key}'`)
  return obj[key]
}

/** `isinstance(v, dict)` for a JSON value. */
export function _is_dict(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Python truthiness of a JSON value (`None`, `False`, 0, `""`, `[]` and `{}` are falsy). */
export function _truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (_is_dict(v)) return Object.keys(v).length > 0
  return true
}

/** `a or b` for JSON values. */
export function _or(a, b) {
  return _truthy(a) ? a : b
}

/** `type(v).__name__` for a JSON value. */
export function _type_name(v) {
  if (v === null || v === undefined) return 'NoneType'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float'
  if (typeof v === 'string') return 'str'
  if (Array.isArray(v)) return 'list'
  return 'dict'
}

// `_repr_str` (Python's `repr` of a string) lives in harness_git.mjs, which builds a failure message
// from it, and is re-exported above.

function _repr(v) {
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'number') return String(v).replace(/e-(\d)$/, 'e-0$1')
  if (typeof v === 'string') return _repr_str(v)
  if (Array.isArray(v)) return '[' + v.map(_repr).join(', ') + ']'
  if (_is_dict(v)) return '{' + Object.entries(v).map(([k, x]) => _repr_str(k) + ': ' + _repr(x)).join(', ') + '}'
  return String(v)
}

/** `str(v)` for a JSON value: a string as it is, `None`, `True`, a number, `['a', 1]`, `{'a': 1}`. */
export function _str(v) {
  return typeof v === 'string' ? v : _repr(v)
}

/**
 * `str.splitlines()`: breaks on \n, \r, \r\n, \x0b, \x0c, \x1c, \x1d, \x1e, \x85, U+2028 and U+2029.
 * A trailing break yields no empty last item.
 * @param {string} text
 * @returns {string[]}
 */
export function splitlines(text) {
  const out = []
  const n = text.length
  let start = 0
  let i = 0
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 10 || c === 11 || c === 12 || c === 13 || c === 0x1c || c === 0x1d || c === 0x1e ||
        c === 0x85 || c === 0x2028 || c === 0x2029) {
      out.push(text.slice(start, i))
      i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1
      start = i
    } else i++
  }
  if (start < n) out.push(text.slice(start))
  return out
}

/** Order two strings by code point, as Python sorts `str` (JavaScript's default sort uses UTF-16 units). */
export function _cmp(a, b) {
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

/** `sorted(strings)` by code point; returns a new array. */
export function _sorted(items) {
  return [...items].sort(_cmp)
}

// Python's `\s` for a str pattern: the characters `str.isspace()` accepts. Built from numbers, so no
// source line holds a raw separator character.
const _PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f ' + String.fromCharCode(0x85, 0xa0, 0x1680) +
  String.fromCharCode(0x2000) + '-' + String.fromCharCode(0x200a) +
  String.fromCharCode(0x2028, 0x2029, 0x202f, 0x205f, 0x3000)

/**
 * `re.match`: anchored at the start only. The returned RegExp is a sticky copy of `rx`.
 * @param {RegExp} rx
 * @param {string} text
 * @returns {RegExpExecArray|null}
 */
export function re_match(rx, text) {
  const sticky = new RegExp(rx.source, rx.flags.replace(/[gy]/g, '') + 'y')
  return sticky.exec(text)
}

/** `re.fullmatch`: anchored at both ends. */
export function re_fullmatch(rx, text) {
  return new RegExp('^(?:' + rx.source + ')$', rx.flags.replace(/[gy]/g, '')).exec(text)
}

/** `shlex.quote`: an argument made only of `[A-Za-z0-9_@%+=:,./-]` stays bare, anything else is single-quoted. */
export function shlex_quote(s) {
  if (!s) return "''"
  if (!/[^A-Za-z0-9_@%+=:,./-]/.test(s)) return s
  return "'" + s.replaceAll("'", "'\"'\"'") + "'"
}

function _os_error_name(e) {
  switch (e && e.code) {
    case 'ENOENT': return 'FileNotFoundError'
    case 'EACCES': case 'EPERM': return 'PermissionError'
    // Python opens a directory with PermissionError on Windows and IsADirectoryError elsewhere.
    case 'EISDIR': return process.platform === 'win32' ? 'PermissionError' : 'IsADirectoryError'
    case 'ENOTDIR': return 'NotADirectoryError'
    case 'EEXIST': return 'FileExistsError'
    default: return 'OSError'
  }
}

/**
 * `str(path).replace("\\", "/").strip()`: backslashes to `/`, Python-stripped. The argument goes
 * through `_str`, so a JSON value that is not a string reads as Python's `str()` of it.
 * @param {*} p @returns {string}
 */
export function norm(p) {
  return py_strip(_str(p).replaceAll(BS, '/'))
}

/** Tag a Node filesystem error with the Python exception name a caller would branch on. */
export function _oserr(e) {
  if (e && typeof e.code === 'string') e.name = _os_error_name(e)
  return e
}

function _is_file(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

function _is_dir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function _lexists(p) {
  try { fs.lstatSync(p); return true } catch { return false }
}

/** `Path.resolve()`: symlinks resolved, and a missing tail kept as given. */
function _realpath(p) {
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

function _warns_arg(x) {
  if (Array.isArray(x)) return x
  if (x && Array.isArray(x.warns)) return x.warns
  return null
}

/** The encoding pin of the Python reader. Node writes UTF-8 to a pipe and a console alike, so nothing is left to pin. */
export function pin_utf8() {}

// Closed set: how a verify script is executed.
export const RUNNERS = {
  'python-uv': ['uv', 'run', 'python'],
  'python': ['python'],
  'poetry': ['poetry', 'run', 'python'],
  'node': ['node'],
  'pwsh': ['pwsh', '-NoProfile', '-File'],
}

// Closed set: deterministic gates that run BEFORE any LLM review.
//   files=true   the changed file list is appended — the gate is scoped to the slice.
//   files=false  whole-program (no per-file scoping). The caller must gate on failures in slice
//                files or newly introduced by the slice; pre-existing failures elsewhere are debt
//                to record, not work to absorb into the slice.
export const GATES = {
  'ruff':         { cmd: ['uv', 'run', 'ruff', 'check'],                    files: true },
  'ruff-format':  { cmd: ['uv', 'run', 'ruff', 'format', '--check'],        files: true },
  'pytest':       { cmd: ['uv', 'run', 'pytest', '-q'],                     files: false },
  'pytest-nondb': { cmd: ['uv', 'run', 'pytest', '-m', 'not db', '-q'],     files: false },
  'eslint':       { cmd: ['npx', 'eslint'],                                 files: true },
  'prettier':     { cmd: ['npx', 'prettier', '--check'],                    files: true },
  'tsc':          { cmd: ['npx', 'tsc', '--noEmit'],                        files: false },
  'vitest':       { cmd: ['npx', 'vitest', 'run'],                          files: false },
  'cargo-clippy': { cmd: ['cargo', 'clippy', '--', '-D', 'warnings'],       files: false },
  'cargo-test':   { cmd: ['cargo', 'test'],                                 files: false },
  'go-vet':       { cmd: ['go', 'vet', './...'],                            files: false },
  'go-test':      { cmd: ['go', 'test', './...'],                           files: false },
  'actionlint':   { cmd: ['actionlint'],                                    files: true },
  // shellcheck: the selector for `*.sh` surfaces. It flags mechanically what a review would
  // otherwise find late (word-list expansion, SC2044/SC2013). The runner rides the ubuntu-latest
  // image (no install step in the vendored CI); the preflight names it if absent.
  'shellcheck':   { cmd: ['shellcheck'],                                    files: true },
}

// Retired script declarations and the file that replaced each. A repo that declared the old script as
// a Python script gate or artifact check gets the replacement while that file exists under the root,
// and a warning that asks for the declaration to be updated. A repo whose tree has not taken the
// replacement yet keeps the declaration it wrote. The list is closed on purpose: a path outside it is
// never rewritten.
export const RETIRED_SCRIPTS = { 'docs/check_docs.py': 'docs/check_docs.mjs' }

// ---------------------------------------------------------------------------------------------
// Built-in claims (ywr-harness ADR 0044): the EXACT destination paths `init.mjs` places or writes
// — every TOOLCHAIN/GUARDED/SEED/SEED_CORPUS destination plus the generated `.harness-version`
// stamp. A changed file that no declared group matched is claimed from this set by the emitter
// (reported under a visible `scaffold-claimed` block, never silently), so a consuming repo never
// authors a groups entry for a file the scaffold itself placed. The claim ships in the same
// refresh as the file it claims, so a refreshed file never fails CI for want of its claim. Exact
// paths, never prefixes or globs: a genuinely new kind of file still surfaces as ungrouped.
// Declared groups always win; this set only consumes leftovers.
//
// SECOND COPY, BY DESIGN: the ywr-harness plugin's `placement.mjs` placement tables are the first. The
// consuming repo's emitter cannot read the plugin's placement.mjs (no plugin exists in CI —
// ywr-harness ADR 0014), so the ywr-harness canon's pairing selftest in
// `harness_gates.selftest.ps1` (case Z) is the drift gate: it imports the placement.mjs tables
// and fails the canon build when either side changes alone. Edit BOTH together.
// `scripts/harness/__pycache__/` is deliberately absent: the vendored `.gitignore` owns it, and
// claiming bytecode would hide a broken ignore (ywr-harness fact 6).
// ---------------------------------------------------------------------------------------------
export const SCAFFOLD_CLAIMS = new Set([
  // TOOLCHAIN destinations
  'docs/README.md',
  'docs/adr/README.md',
  'docs/adr/0000-template.md',
  'docs/spec/README.md',
  'docs/spec/0000-template.md',
  'docs/build.mjs',
  'docs/build.sh',
  'docs/build_docs.mjs',
  'docs/check_docs.mjs',
  'scripts/harness/harness_config.mjs',
  'scripts/harness/harness_git.mjs',
  'scripts/harness/harness_gates.mjs',
  'scripts/harness/harness_retro.mjs',
  'scripts/harness/verify_map.mjs',
  'scripts/harness/slice_note.mjs',
  'scripts/harness/resolve-base.sh',
  '.github/workflows/harness-gates.yml',
  'scripts/harness/.gitignore',
  '.githooks/pre-commit',
  '.githooks/pre-push',
  // GUARDED destination
  '.githooks/post-commit',
  // SEED destinations (content is repo-owned; the PATH is scaffold-decided, which is what a
  // claim asserts — never the bytes)
  'CLAUDE.md',
  '.gitattributes',
  '.gitignore',
  '.githooks/slice-retro-ignore',
  '.harness.json',
  'docs/prompts/review-start.md',
  'docs/prompts/ready-report.md',
  // SEED_CORPUS destination
  'docs/adr/0001-adopt-docs-as-code.md',
  // generated by init.mjs on every successful run (ywr-harness ADR 0042), never a template
  '.harness-version',
])

// Paths that an older scaffold placed and the current one no longer places. A repo that took the older
// scaffold still tracks them, because init.mjs never deletes a file. They stay claimed, so that such a
// repo's partition audit does not fail on them. They are outside the placement.mjs pairing of SCAFFOLD_CLAIMS.
export const RETIRED_SCAFFOLD_CLAIMS = new Set([
  '.githooks/commit-msg',            // the hook left the scaffold in ywr-harness ADR 0215
  'docs/prompts/review-digest.md',   // the seed became docs/prompts/review-start.md (ywr-harness ADR 0215)
  'REVIEW.md',                       // the scaffold keeps the review canon in CLAUDE.md (ywr-harness ADR 0217)
  'docs/build.ps1',                  // the docs wrapper moved to docs/build.mjs (ywr-harness ADR 0220)
  'docs/build_docs.py',              // the docs builder and checker became .mjs files (ywr-harness ADR 0223)
  'docs/check_docs.py',
  'scripts/harness/harness_config.py',   // the five scaffold scripts became .mjs files (ywr-harness ADR 0223)
  'scripts/harness/harness_gates.py',
  'scripts/harness/harness_retro.py',
  'scripts/harness/verify_map.py',
  'scripts/harness/slice_note.py',
])

export const UNSAFE = /[;&|`$<>\n\r"']|\.\./

export const DEFAULTS = {
  index: 'docs/index.json',
  runner: 'python',
  cwd: '',
  strip_prefix: '',
  script_pattern: '^.*/verify_.*\\.py$',
  product_scope: '',
  ui_prefix: '',
  handoff: '',
  review_canon: 'CLAUDE.md',
  retro_ignore_file: '.githooks/slice-retro-ignore',
}

/**
 * Whether one `implements_in` entry owns a repo-relative path (ywr-harness ADR 0104): a file
 * entry owns that file, a directory entry every path below it. A prefix match on `entry + "/"`,
 * so `app/mod` owns `app/mod/x.py` but not `app/module.py`; a trailing slash and a leading `./`
 * read the same (git never prints `./`, so a `./` entry would otherwise own nothing). An empty
 * entry, or `/`, owns nothing — never the whole repo. No disk lookup: the mapper reads an index
 * and a changed-file list, and a deleted directory must still own the deletions under it.
 * @param {string} entry
 * @param {string} p
 * @returns {boolean}
 */
export function owns(entry, p) {
  let e = entry
  while (e.startsWith('./')) e = e.slice(2)
  e = e.replace(/\/+$/, '')
  return e.length > 0 && (p === e || p.startsWith(e + '/'))
}

/** `any(owns(e, path) for e in entries)`. @param {Iterable<string>} entries @param {string} p */
export function owned(entries, p) {
  for (const e of entries) if (owns(e, p)) return true
  return false
}

/**
 * The frontmatter block of a docs source, or null — the docs builder's `split_frontmatter`
 * rule exactly (ywr-harness ADR 0043): CRLF fold, a leading HTML comment skipped, an opening
 * `---` line, a closing line whose strip() is `---`. The ONE reader-side copy: `verify_map`
 * (staleness digest) and `harness_retro` (spec map, frontmatter delta) both call it, so neither
 * can use a looser parse that misses a spec whose frontmatter follows a comment.
 * `build_docs.mjs` stays standalone (ywr-harness spec 0001); the canon's build-docs selftest
 * pairs the two.
 * @param {string} text
 * @returns {string|null}
 */
export function fm_block(text) {
  text = text.replaceAll('\r\n', '\n')
  // Python's `\s`, not JavaScript's: they differ at U+001C-U+001F, U+0085 and U+FEFF.
  const lead = new RegExp('^[' + _PY_WS + ']*<!--[\\s\\S]*?-->[' + _PY_WS + ']*').exec(text)
  if (lead && text.slice(lead[0].length).startsWith('---\n')) text = text.slice(lead[0].length)
  if (!text.startsWith('---\n')) return null
  const lines = text.split('\n')
  for (let idx = 1; idx < lines.length; idx++) {
    if (py_strip(lines[idx]) === '---') return lines.slice(1, idx).join('\n')
  }
  return null
}

/** @param {string} value @param {string} field @param {string[]} warns @returns {string} */
export function safe_path(value, field, warns) {
  const v = norm(value)
  if (v && UNSAFE.test(v)) {
    warns.push(`${field}: rejected (shell metacharacter or '..' in a path value) — using default`)
    return ''
  }
  return v
}

// ---------------------------------------------------------------------------------------------
// The ONE gate every repo-supplied token passes before it can reach a printed command: script
// paths (from `.harness.json` AND from the docs index), and the changed-file arguments appended
// to a file-scoped gate. Composed commands are run by `sh -c` (the vendored CI and pre-commit
// both do), so a token must survive re-splitting byte-for-byte.
//
// An ALLOWLIST, not a blocklist. It excludes whitespace (sh re-splits the token), '#' (BOTH
// output parsers strip a trailing comment), glob characters (the CI runs `sh -c` without
// `set -f`), ':' (drive-absolute), and every shell metacharacter — including the ones nobody
// thought to list.
//
// WHERE the check happens is load-bearing: every token is validated in the form that ACTUALLY
// reaches argv. Validating the DECLARED string while composing the STRIPPED one would let
// `{"strip_prefix": "src/", "script": "src/-c"}` pass validation and reach argv as the bare flag
// `-c` — with `files: true`, the next token is a changed FILENAME, so `python -c <name>` executes
// that name as source. `as_arg()` neutralizes a leading dash on top of that, because a value in
// command position whose FIRST character is hostile is dangerous even when the rest is clean.
//
// The patterns end in `$` with no `m` flag, which in JavaScript matches the very end of the string
// only. Python's `$` ALSO matches just before a trailing newline, so a `$`-anchored full-match
// there would accept `"a.py\n"` — the one character that can split an output line — and the Python
// reader uses `\Z`. Every call path strips first (`norm()`, `safe_path` under `safe_cwd`), but the
// choke point's guarantee must not depend on callers pre-stripping: validate the string that
// becomes the output, not the value it was built from (ywr-harness fact 36).
// ---------------------------------------------------------------------------------------------
export const SAFE_TOKEN = /^[A-Za-z0-9._/-]+$/

/**
 * True when `tok` can be spliced into a printed command as one inert argument.
 *
 * `..` is refused as a path SEGMENT, which is what traversal is — not as a substring, so a file
 * honestly named `a..b.py` stays gated. (`safe_path`'s coarser substring rule stays as it is:
 * it guards declaration-time path values.)
 * @param {string} tok
 * @returns {boolean}
 */
export function token_ok(tok) {
  return tok.length > 0 && SAFE_TOKEN.test(tok) && !tok.split('/').includes('..') && !tok.startsWith('/')
}

// A changed-file ARGUMENT is held to a wider set than every other command-position value
// (ywr-harness ADR 0112): `( ) [ ]` too — Next.js route groups and dynamic segments. They are
// shlex-unsafe, so compose() always single-quotes them, a literal in sh and in pwsh 7. A file
// argument always sits after the runner, where no consumer reads a word; cwd, script paths and
// runner elements do not (the CI awk table reads `$1`/`$2`/`$4` unquoted, ywr-harness fact 65),
// so they stay on `token_ok`. Read by `unsafe_files()` and `gate_command()`'s file filter ONLY.
// `@`/`+` stay out (ywr-harness ADR 0112 option C: emitted bare, and a leading `@` splats in
// PowerShell).
export const FILE_ARG = /^[A-Za-z0-9._/()[\]-]+$/

/**
 * `token_ok` for a changed-file argument: the same `..`-segment and leading-`/` rules over
 * FILE_ARG. Never use it for a value that is emitted unquoted.
 * @param {string} tok
 * @returns {boolean}
 */
export function file_arg_ok(tok) {
  return tok.length > 0 && FILE_ARG.test(tok) && !tok.split('/').includes('..') && !tok.startsWith('/')
}

/**
 * Render an allowlist-clean token for a command position. A leading '-' is neutralized with
 * the POSIX-canonical `./` rather than accepted bare: `python -c` treats its next token as
 * source, and no path token may ever arrive as an option.
 * @param {string} tok
 * @returns {string}
 */
export function as_arg(tok) {
  return tok.startsWith('-') ? `./${tok}` : tok
}

// ---------------------------------------------------------------------------------------------
// The ONE gate every repo-supplied value passes before it becomes an output LINE. Deliberately
// separate from `token_ok`: that one guards a value reaching a COMMAND position, this one guards a
// value that is merely REPORTED — a status label, a refused value echoed so a reader can see it.
// Reported text is not inert. Both output parsers find the gate-command window by matching LINE
// SHAPES in stdout (`^gates:`, `^ {4}[^ (]`, `^review tier:`), so a value carrying a newline does
// not print as one line: it prints as several, and a declaration can spell the window's own start
// and stop anchors and land a command inside it.
//
// Example: a declared artifact title of `inj\ngates:\n    echo INJECTED\nreview tier: full - x`
// would print `artifact: ok`, so CI's `^artifact: VIOLATION` step passes, while the workflow's own
// extraction (`sed -n '/^gates:/,/^\(ungrouped\|review tier\)/p' | grep -E '^ {4}[^ (]'`) returns
// `echo INJECTED` for `sh -c`. A group NAME is a second such site: it is echoed as
// `  [<name>] N file(s)` INSIDE the window.
//
// Same rule as ywr-harness fact 36, one transformation later: validate the string that becomes
// the LINE, not the value it was built from. Callers additionally REFUSE a control character at
// the declaration layer where a declarer can be told (a typo deserves a message); this is the
// structural layer that holds when they cannot.
// ---------------------------------------------------------------------------------------------
// U+0085 NEL and U+2028/U+2029 are in the class even though NEITHER shell parser splits on them
// (sed/grep/awk split on 0x0A only). They are here because the parser set is not the consumer set:
// a line splitter in a script language DOES split all three, and a MODEL reading this output may
// render them as breaks — and a model is exactly the consumer /verify's `run:` lines are printed
// for. One value, one line, under every reader's notion of a line. The three characters are added
// by code point, so that no source line holds a raw separator.
export const CONTROL = new RegExp('[\\x00-\\x1f\\x7f' + String.fromCharCode(0x85, 0x2028, 0x2029) + ']')
const _CONTROL_G = new RegExp(CONTROL.source, 'g')

export const _SHOWN = { '\n': BS + 'n', '\r': BS + 'r', '\t': BS + 't' }

/** One control character as a visible escape: `\n`, `\r`, `\t`, `\xNN` below U+0100, else `\uNNNN`. */
export function _shown(ch) {
  const c = ch.charCodeAt(0)
  return _SHOWN[ch] || (c < 0x100 ? BS + 'x' + c.toString(16).padStart(2, '0')
    : BS + 'u' + c.toString(16).padStart(4, '0'))
}

/**
 * True when repo-supplied text carries a character some reader treats as a line break — C0,
 * DEL, or one of the three Unicode breaks named above.
 * @param {*} value
 * @returns {boolean}
 */
export function has_control(value) {
  return CONTROL.test(_str(value))
}

/**
 * Render repo-supplied text so it can only ever occupy ONE output line. The characters become
 * VISIBLE escapes rather than being dropped: a reader diagnosing a refusal has to see what was
 * declared, and a silently stripped newline reads as a value nobody wrote.
 * @param {*} value
 * @returns {string}
 */
export function one_line(value) {
  return _str(value).replace(_CONTROL_G, (m) => _shown(m))
}

/**
 * The single stdout exit for the two consumers whose output has a LINE-SHAPE contract (the gate
 * emitter, read by the CI/pre-commit window parsers; the verify mapper, read by a model told to
 * run its `run:` lines). The line ends in LF alone.
 *
 * Not a convenience wrapper. Per-call-site escaping misses sites: a forged `gates:` line in the
 * review-tier line (critical-surface filenames) reproduces the injection end to end, because it
 * RE-ARMS `sed`'s range even after the real window closed. A single exit makes forgetting a call
 * site impossible instead of unlikely, which is the whole difference between a rule and a habit.
 *
 * Our own multi-line literals must write to `process.stdout` directly and sanitize the
 * repo-supplied part themselves — deliberately the awkward path, so multi-line output is a
 * decision, never a default.
 * @param {string} [line]
 */
export function say(line = '') {
  process.stdout.write(one_line(line) + '\n')
}

/**
 * The single stderr exit. No machine parser reads this channel (CI captures stdout through
 * `tee`; the pre-commit hook captures stdout through command substitution) — but it is a human
 * DISPLAY, and a raw ESC sequence in a refused value would repaint the committer's terminal
 * during `git commit`, able to overwrite the hook's own preceding line. Escaped, a refused value
 * is still fully legible, which is the property that made echoing it correct in the first
 * place.
 * @param {string} msg
 */
export function warn(msg) {
  process.stderr.write(`warn: ${one_line(msg)}\n`)
}

/** @param {string} p @param {string} strip_prefix @returns {string} */
export function strip_group_prefix(p, strip_prefix) {
  return strip_prefix && p.startsWith(strip_prefix) ? p.slice(strip_prefix.length) : p
}

/**
 * A `cwd` is composed as `cd <cwd> && …`, so it is a command-position token and needs the same
 * allowlist as a path argument — `safe_path` alone permits a space, `#` or `*`. Refused values
 * degrade to the repo root, reported: the command then fails on its stripped paths instead of
 * running in a directory nobody named.
 * @param {*} value @param {string} field @param {string[]} warns @returns {string}
 */
export function safe_cwd(value, field, warns) {
  const v = safe_path(value, field, warns)
  if (v && !token_ok(v)) {
    warns.push(`${field}: '${v}' refused as a working directory (must be a repo-relative path ` +
               "of [A-Za-z0-9._/-], no '..') — commands will be printed WITHOUT a `cd`, so " +
               'they run from the repo root')
    return ''
  }
  return v
}

// The replacement of a retired script declaration, when the root holds it (RETIRED_SCRIPTS). Returns
// the `{runner, script}` pair to use, or null to keep the declaration as written.
function _retired(runner, script, root) {
  if (runner !== 'python' || !_has(RETIRED_SCRIPTS, script)) return null
  const next = RETIRED_SCRIPTS[script]
  if (!_is_file(path.join(root, next))) return null
  return { runner: 'node', script: next }
}

/**
 * Validate a script gate `{runner, script, files}` (ywr-harness ADR 0024). The runner stays a
 * closed-set choice; the script is a repo-relative path. BOTH forms are validated — as declared,
 * and as it will actually be composed after the group's `strip_prefix` — because the second is the
 * one that becomes argv. Returns null (and warns) when it cannot be composed safely; a refused
 * value is echoed in the warning and never composed. A retired script declaration is replaced by
 * its successor when the root holds it (RETIRED_SCRIPTS), with a warning.
 * @param {Object} raw @param {string} group @param {string} strip_prefix @param {string} root
 * @param {string[]} warns
 * @returns {{runner: string, script: string, files: boolean}|null}
 */
export function script_gate(raw, group, strip_prefix, root, warns) {
  const field = `groups[${group}].gates`
  // An unknown key is warned about, never silently dropped — a member declaring `"args":
  // "--fast"` must get a signal that no argument field exists. `//`-prefixed keys stay the
  // comment convention, as everywhere else in the schema. The sweep runs BEFORE the
  // runner/script checks on purpose: a gate dropped for a bad runner still reports its unknown
  // keys, and the two warnings TOGETHER are what diagnose a typo'd key name (`"runer"` →
  // unknown key 'runer' + runner '' not in the closed set).
  for (const key of Object.keys(raw)) {
    if (!['runner', 'script', 'files'].includes(key) && !key.startsWith('//')) {
      warns.push(`${field}: unknown script-gate key '${key}' ignored ` +
                 '(known: runner, script, files)')
    }
  }
  let runner = _str(_or(_get(raw, 'runner'), ''))
  if (!_has(RUNNERS, runner)) {
    warns.push(
      `${field}: script-gate runner '${runner}' is not in the closed set ` +
      `(${_sorted(Object.keys(RUNNERS)).join(', ')}) — dropped`)
    return null
  }
  let script = norm(_str(_or(_get(raw, 'script'), '')))
  let effective = strip_group_prefix(script, strip_prefix)
  if (!token_ok(script) || script.startsWith('-')) {
    warns.push(
      `${field}: script-gate path '${script}' refused (a repo-relative path of ` +
      "[A-Za-z0-9._/-] only, no '..', no leading '/' or '-') — dropped")
    return null
  }
  if (!token_ok(effective) || effective.startsWith('-')) {
    warns.push(
      `${field}: script-gate path '${script}' refused — under strip_prefix ` +
      `'${strip_prefix}' it composes to '${effective}', which is not a usable path in a ` +
      "command position (a leading '-' would be read as an option to the runner) — dropped")
    return null
  }
  const successor = _retired(runner, script, root)
  if (successor) {
    const next = strip_group_prefix(successor.script, strip_prefix)
    if (token_ok(next) && !next.startsWith('-')) {
      warns.push(`${field}: runner '${runner}' with script '${script}' is retired — using runner ` +
                 `'${successor.runner}' with script '${successor.script}'; update .harness.json`)
      runner = successor.runner
      script = successor.script
      effective = next
    }
  }
  if (!_is_file(path.join(root, script))) {
    // Kept, not dropped: dropping would let a typo read as coverage, while the emitted
    // command fails loudly at run time and this warning names the path at emit time.
    warns.push(`${field}: script-gate path '${script}' does not exist — kept; the emitted ` +
               'command will fail until it does')
  }
  let files = _get(raw, 'files', false)
  if (typeof files !== 'boolean') {
    // `bool("false")` is True in Python and a non-empty string is truthy here — a JSON string
    // would silently INVERT the declared intent and append the changed-file list to a script
    // that never asked for one. The default (false, whole-program) is also the conservative
    // direction: the script runs exactly as it would with the key absent.
    warns.push(`${field}: script-gate 'files' must be a JSON boolean (true/false), got ` +
               `'${_str(files)}' — treated as false (whole-program)`)
    files = false
  }
  return { runner, script, files }
}

/**
 * Validate an `artifacts.items[].check` drift check (ywr-harness ADR 0068) and compose the ONE
 * command it emits into the gates window.
 *
 * The script-gate shape (ywr-harness ADR 0024) minus `files`: a check is ALWAYS whole-program — its
 * contract is `build_onboarding.mjs`'s (default mode = drift check, exit 1 on drift, writes
 * nothing). No strip_prefix and no cwd: artifact sources are declared repo-root-relative and
 * the check runs from the root, so the declared path IS the composed path.
 *
 * Shape/refusal failures land in `problems` — the caller renders them as
 * `artifact: VIOLATION`, which CI fails on. NOT the script-gate warn-and-drop posture, on
 * purpose: a declared check that quietly stops composing is unenforced coverage that still
 * reads as coverage. A missing script FILE stays a warn (the emitted command fails loudly at
 * run time — the script-gate stance for the same case). A retired script declaration is replaced
 * by its successor when the root holds it (RETIRED_SCRIPTS), with a warning.
 * @param {Object} raw @param {string} field @param {string[]} problems @param {string[]} warns
 * @param {string} root
 * @returns {string} the command, or '' when refused
 */
export function artifact_check(raw, field, problems, warns, root) {
  for (const key of Object.keys(raw)) {
    if (!['runner', 'script'].includes(key) && !key.startsWith('//')) {
      if (key === 'files') {
        warns.push(`${field}: 'files' is not a check key — a check is always ` +
                   'whole-program; ignored')
      } else {
        warns.push(`${field}: unknown check key '${key}' ignored ` +
                   '(known: runner, script)')
      }
    }
  }
  let runner = _str(_or(_get(raw, 'runner'), ''))
  if (!_has(RUNNERS, runner)) {
    problems.push(`check runner '${one_line(runner)}' is not in the closed set ` +
                  `(${_sorted(Object.keys(RUNNERS)).join(', ')})`)
    return ''
  }
  let script = norm(_str(_or(_get(raw, 'script'), '')))
  if (!token_ok(script) || script.startsWith('-')) {
    problems.push(`check script path '${one_line(script)}' refused (a repo-relative path ` +
                  "of [A-Za-z0-9._/-] only, no '..', no leading '/' or '-')")
    return ''
  }
  const successor = _retired(runner, script, root)
  if (successor) {
    warns.push(`${field}: runner '${runner}' with script '${script}' is retired — using runner ` +
               `'${successor.runner}' with script '${successor.script}'; update .harness.json`)
    runner = successor.runner
    script = successor.script
  }
  if (!_is_file(path.join(root, script))) {
    warns.push(`${field}: check script '${script}' does not exist — kept; the emitted ` +
               'command will fail until it does')
  }
  // Through compose(), the one place argv becomes a command string — its quoting contract then
  // covers this site too, instead of a second hand-rolled join that would silently diverge.
  return compose([...RUNNERS[runner], as_arg(script)], '')
}

// ---------------------------------------------------------------------------------------------
// Declared and ignore-file patterns. EVERY such pattern is compiled through `compile_re`, so the
// readings below hold in one place. One tokenizer, `_py_translate`, applies all of them.
//
// A bare `.` and a bare `$` read differently in Python and JavaScript, and they are the most common
// characters in a declared pattern:
//   .  Python without DOTALL excludes only \n. JavaScript also excludes \r, U+2028 and U+2029, so
//      `src/a<U+2028>b.py` fails `^src/.*\.py$` there. It becomes `[^\n]`.
//   $  Python without MULTILINE also matches before one final \n. JavaScript matches the very end
//      only. It becomes `(?=\n?$)`. A path may end in a newline, because git carries a path verbatim
//      under `-z`.
// Both are rewritten only outside a character class and when not escaped: `\.`, `\$`, `[$.]` and the
// `.` after an escaped backslash (`\\.`) keep their meaning. A `$` or `.` inside a lookbehind is
// rewritten like any other, because Python reads it as an anchor and a dot there too. The pattern
// compiles without flags unless it uses the escapes below.
//
// Python 3 reads `\w \W \d \D \b \B` in a str pattern as Unicode and JavaScript reads them as ASCII,
// even with the `u` flag: `^docs/\w+\.md$` matches `docs/<hangul>.md` in Python only. A pattern that
// uses one is rewritten to Python's meaning and compiled with the `u` flag:
//   \w  [\p{L}\p{N}_]       \W  [^\p{L}\p{N}_]       \d  \p{Nd}       \D  \P{Nd}
//   \b \B  lookarounds built on that \w
// `u` mode rejects an escape that Python accepts (`\-` outside a class, a lone `{`). The pattern is
// then compiled without flags, with only the `.` and `$` rewrite, and one warning says that it reads
// as ASCII.
// `\s` and `\S` stay as JavaScript reads them. They differ from Python at U+001C-U+001F and U+0085,
// which Python counts as space and JavaScript does not, and at U+FEFF, which JavaScript counts and
// Python does not.
// Inside a class `\b` is a backspace in both languages and stays as written.
// A pattern the tokenizer cannot classify (an unterminated class, a lone trailing backslash) is
// compiled as written, and a pattern whose rewrite does not compile but whose original does is
// returned as written with a warning.
// ---------------------------------------------------------------------------------------------
const _WORD = '\\p{L}\\p{N}_'
const _WORD_CLASS = `[${_WORD}]`
const _BOUNDARY = `(?:(?<=${_WORD_CLASS})(?!${_WORD_CLASS})|(?<!${_WORD_CLASS})(?=${_WORD_CLASS}))`
const _NOT_BOUNDARY = `(?:(?<=${_WORD_CLASS})(?=${_WORD_CLASS})|(?<!${_WORD_CLASS})(?!${_WORD_CLASS}))`
const _ANY = '[^\\n]'          // Python's `.` without DOTALL
const _EOL = '(?=\\n?$)'       // Python's `$` without MULTILINE

/**
 * Rewrite one Python pattern for the JavaScript engine: `.` and `$` always, and with `unicode`
 * also `\w \W \d \D \b \B`. Returns `{out, escapes, ok}`: the rewritten source, whether the pattern
 * uses any of the six escapes, and false when the tokenizer met something it cannot classify (the
 * caller then compiles the original).
 * @param {string} src @param {boolean} unicode
 * @returns {{out: string, escapes: boolean, ok: boolean}}
 */
export function _py_translate(src, unicode) {
  let out = ''
  let escapes = false
  let ok = true
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === BS) {
      if (i + 1 >= n) { out += c; i++; ok = false; continue }
      const x = src[i + 1]
      i += 2
      if ('wWdDbB'.includes(x)) escapes = true
      if (!unicode) out += c + x
      else if (x === 'w') out += _WORD_CLASS
      else if (x === 'W') out += `[^${_WORD}]`
      else if (x === 'd') out += '\\p{Nd}'
      else if (x === 'D') out += '\\P{Nd}'
      else if (x === 'b') out += _BOUNDARY
      else if (x === 'B') out += _NOT_BOUNDARY
      else out += c + x
      continue
    }
    if (c === '.') { out += _ANY; i++; continue }
    if (c === '$') {
      // A quantifier after the anchor would apply to a lookahead, which `u` mode refuses.
      out += '*+?{'.includes(src[i + 1] ?? '') ? `(?:${_EOL})` : _EOL
      i++
      continue
    }
    if (c !== '[') { out += c; i++; continue }
    // A character class. Python reads a `]` right after `[` or `[^` as a member. `.` and `$`
    // inside it are literal and stay as written.
    let j = i + 1
    let neg = false
    if (src[j] === '^') { neg = true; j++ }
    let plain = ''
    let hasW = false
    if (src[j] === ']') { plain += '\\]'; j++ }
    let closed = false
    while (j < n) {
      const d = src[j]
      if (d === ']') { closed = true; j++; break }
      if (d === BS && j + 1 < n) {
        const x = src[j + 1]
        j += 2
        if ('wWdD'.includes(x)) escapes = true
        if (!unicode) plain += d + x
        else if (x === 'w') plain += _WORD
        else if (x === 'W') hasW = true
        else if (x === 'd') plain += '\\p{Nd}'
        else if (x === 'D') plain += '\\P{Nd}'
        else plain += d + x
        continue
      }
      plain += d
      j++
    }
    if (!closed) { out += src.slice(i); i = n; ok = false; continue }   // the compiler reports it
    i = j
    if (!hasW) out += `[${neg ? '^' : ''}${plain}]`
    // `\W` has no class-member form in `u` mode, so the class becomes an alternation.
    else if (!neg) out += `(?:${plain ? `[${plain}]|` : ''}[^${_WORD}])`
    else out += `(?:(?=${_WORD_CLASS})${plain ? `[^${plain}]` : '[\\s\\S]'})`
  }
  return { out, escapes, ok }
}

/**
 * The `u`-mode source with Python's Unicode meaning for `\w \W \d \D \b \B` (and the `.` and `$`
 * rewrite), or null when the pattern uses none of the six escapes.
 * @param {string} src
 * @returns {string|null}
 */
export function _py_unicode_escapes(src) {
  const t = _py_translate(src, true)
  return t.escapes ? t.out : null
}

/**
 * Compile one declared pattern, or null for an empty one. An invalid pattern warns and returns
 * null. See the block above for the readings of `.`, `$` and `\w \W \d \D \b \B`. The message of
 * the engine's own error differs from Python's `re.error`.
 * @param {string} pattern @param {string} field @param {string[]} warns
 * @returns {RegExp|null}
 */
export function compile_re(pattern, field, warns) {
  if (!pattern) return null
  const src = String(pattern)
  const uni = _py_translate(src, true)
  if (uni.ok) {
    if (uni.escapes) {
      try { return new RegExp(uni.out, 'u') } catch { /* `u` mode refuses it: read as ASCII below */ }
      try {
        const rx = new RegExp(_py_translate(src, false).out)
        warns.push(`${field}: \\w/\\d/\\b read as ASCII by the Node reader ` +
                   '(pattern not valid in Unicode mode) — write an explicit class')
        return rx
      } catch { /* fall through to the original */ }
    } else {
      try { return new RegExp(uni.out) } catch { /* fall through to the original */ }
    }
  }
  try {
    const rx = new RegExp(src)
    warns.push(`${field}: . and $ read as JavaScript reads them by the Node reader ` +
               '(pattern not rewritable) — write an explicit class')
    return rx
  } catch (e) {
    warns.push(`${field}: not a valid regex (${e.message}) — ignored`)
    return null
  }
}

/**
 * Compiled patterns from the ignore register (`retro.ignore_file`). Comments and blanks are
 * skipped; the file doubles as the visible spec-debt list, so its comments carry meaning for the
 * reader. The ONE reader: the retro's UNMAPPED/--coverage and the mapper's unmapped list both
 * call it (ywr-harness ADR 0115), so the mapper never lists, as "a slice-retro UNMAPPED finding
 * in the making", a file the register exempts and the retro never fires on.
 * @param {string} root @param {string} rel @param {string[]} warns
 * @returns {RegExp[]}
 */
export function load_ignore(root, rel, warns) {
  const pats = []
  const p = path.join(root, rel)
  if (!_is_file(p)) return pats
  try {
    const lines = splitlines(fs.readFileSync(p).toString('utf8'))
    for (let k = 0; k < lines.length; k++) {
      const s = py_strip(lines[k])
      if (!s || s.startsWith('#')) continue
      const rx = compile_re(`^(?:${s})$`, `${rel}:${k + 1}`, warns)
      if (rx) pats.push(rx)
    }
  } catch (e) {
    if (!(e && typeof e.code === 'string')) throw e
    warns.push(`${rel}: unreadable (${_os_error_name(e)}) — no file is exempt from UNMAPPED`)
  }
  return pats
}

/** `any(p.search(path) for p in pats)`. @param {RegExp[]} pats @param {string} p @returns {boolean} */
export function any_match(pats, p) {
  return pats.some((rx) => rx.test(p))
}

// ---------------------------------------------------------------------------------------------
// Customer-corpus surface declaration (ywr-harness ADR 0060). `docs.customer` turns on the docs
// builder's optional program-corpus surface: `<dir>/<Program>/{spec,user-guide,release-notes}.md`
// → one `docs/customer.artifact.html` (+ `docs/PROJECTS.md` when `projects_md`). Parsed and
// VALIDATED here; the builder imports this reader instead of re-reading the file, because two
// validators of one schema diverge: a second copy of the rules inside a consumer's own builder is
// unreachable by any canon fix (ywr-harness ADR 0010).
//
// Nothing here reaches a command position: `dir` selects files the builder READS and renders into
// HTML; every other value is display text or a frontmatter key name. `dir` is still held to the
// path allowlist — a `..` segment would publish files from OUTSIDE the repo into a customer-facing
// page, which is a leak rather than a shell injection and is refused for the same reason. Display
// text is sanitized the way a group name is (control characters escaped, reported): it is echoed
// in warnings and in the builder's stderr, both line-shaped surfaces.
//
// Three states, distinguished on purpose (the `artifacts.malformed` precedent):
//   cfg.customer is null            key absent or null — the surface is OFF; nothing is checked
//   cfg.customer.malformed != ""    declared but unusable — the BUILDER MUST REFUSE (exit 1) and
//                                   the emitter warns; a declared surface that quietly stops
//                                   building is the committed-page-goes-stale defect
//   otherwise                       validated values with defaults filled, plus `declared` —
//                                   the known keys the declarer wrote (non-null), so an
//                                   explicit "" stays distinguishable from an absent key
// An explicitly EMPTY value ("" or []) is never read as absent: it warns and takes the default.
// The three filenames are the corpus CONTRACT, not a key: a role attaches to each (record file ·
// guide · release feed), and a declared name without a role is not expressible.
// ---------------------------------------------------------------------------------------------
export const CUSTOMER_FILES = ['spec.md', 'user-guide.md', 'release-notes.md']
export const CUSTOMER_KEYS = ['dir', 'title', 'eyebrow', 'description', 'contact', 'required_frontmatter',
  'chip_field', 'chip_suffix', 'group_field', 'groups', 'other_label',
  'unkeyed_label', 'project_field', 'projects_md', 'release_stages', 'panels',
  'default_tab', 'footer_date_label']
// Display defaults are deliberately EMPTY here: the builder owns its UI language and fills them.
// `release_stages` is a parsing contract (which `[TAG]` tokens a release entry may carry, in
// stage order — the LAST is the final stage), so its default lives with the validation.
// `panels` is the extension point (ywr-harness ADR 0060): repo-relative `.mjs` modules, each
// contributing one top-level tab — the builder imports the module and calls
// `render_panel(repoRoot)`, which returns the panel's HTML, and reads the optional exports `CSS`,
// `UPDATED` and `TAB_CHIPS`. The module path is a script-gate-class value
// (ywr-harness ADR 0024): a path to code the repo already carries, never a command string, held
// to the same allowlist; a module the builder EXECUTES is exactly why the allowlist matters here
// even though no shell is involved. A module that passes the allowlist but is not an `.mjs` file is
// kept with a warning and the builder refuses the build, so a stale Python panel is never dropped
// silently.
// Each panel has an `id` (the `#top-<id>` deep link; derived here for EVERY kept entry so
// `default_tab` can be validated against the final set) and a `position`. The block-level
// `default_tab` and `footer_date_label` let a panel stop editing the canon DOM
// (ywr-harness ADR 0061).
export const CUSTOMER_DEFAULTS = {
  dir: 'docs/customer',
  title: '', eyebrow: '', description: '', contact: '',
  required_frontmatter: [],
  chip_field: '', chip_suffix: '',
  group_field: 'menu', groups: [], other_label: '', unkeyed_label: '',
  project_field: 'project', projects_md: false,
  release_stages: [{ tag: 'FUT', label: 'FUT' }, { tag: 'UAT', label: 'UAT' },
    { tag: 'PROD', label: 'COMPLETE' }],
  panels: [],
  default_tab: '', footer_date_label: '',
}
export const PANEL_KEYS = ['module', 'label', 'id', 'position']
export const PANEL_POSITIONS = ['before-docs', 'after-docs']
// A tab id is spliced into `data-top`, a CSS class (`panel-<id>`) and a URL fragment — ASCII
// token only; `docs` is the documents tab and is checked separately (reserved).
export const PANEL_ID = /^[a-z][a-z0-9_-]*$/
// parse_frontmatter's key shape (build_docs.mjs: a name of [A-Za-z0-9_] before the colon) — a declared
// key name outside it can never match a parsed key, so it is refused rather than silently never-found.
export const FM_KEY = /^[A-Za-z0-9_]+$/
export const STAGE_TAG = /^[A-Za-z0-9_-]+$/

/**
 * Repo-supplied display text → one-line form, control characters escaped and REPORTED
 * (the groups[].name rule: a value that never exists raw after load cannot be echoed raw).
 * @param {*} value @param {string} field @param {string[]} warns @returns {string}
 */
export function _display(value, field, warns) {
  const s = _str(value)
  if (has_control(s)) {
    warns.push(`${field}: control character(s) in the value were escaped for display ` +
               `('${one_line(s)}') — display text is echoed on line-shaped surfaces`)
  }
  return py_strip(one_line(s))
}

/**
 * A declared frontmatter key name. An EMPTY value is reported, never read as absent: `""`
 * is something a declarer (or their templating) wrote, and a silent default here would be the
 * only path in this block that degrades without a warning.
 * @param {*} value @param {string} field @param {string[]} warns @param {string} [dflt]
 * @returns {string}
 */
export function _fm_key(value, field, warns, dflt = '') {
  const s = py_strip(_str(value !== null && value !== undefined ? value : ''))
  const how = dflt ? `using the default '${dflt}'` : 'ignored'
  if (!s) {
    warns.push(`${field}: declared empty — ${how}`)
    return dflt
  }
  if (!FM_KEY.test(s)) {
    warns.push(`${field}: '${one_line(s)}' is not a frontmatter key name ([A-Za-z0-9_] only) ` +
               `— ${how}`)
    return dflt
  }
  return s
}

/**
 * `isinstance(v, int) and not isinstance(v, bool)` for a JSON value. JSON `1.0` is a float in
 * Python and parses to the integer `1` here, so it counts as an int here and not there.
 * @param {*} v @returns {boolean}
 */
export function _is_int(v) {
  return typeof v === 'number' && Number.isInteger(v)
}

/**
 * Validate `docs.customer`. Returns null (surface off), an object with `malformed` set (declared
 * but unusable — the builder refuses), or the validated declaration with defaults filled. A panel
 * `module` must be a repo-relative `.mjs` path.
 * @param {*} raw @param {string} root @param {string[]} warns
 * @returns {Object|null}
 */
export function customer_decl(raw, root, warns) {
  const field = 'docs.customer'
  if (raw === null || raw === undefined) return null
  if (!_is_dict(raw)) {
    warns.push(`${field}: expected an object (or null to leave the surface off), got ` +
               `${_type_name(raw)} — the customer surface CANNOT be built until fixed`)
    return { malformed: 'expected an object or null' }
  }
  // Defaults are copied one level DEEPER than the list: `release_stages` holds objects, and a
  // shallow copy of the list would hand every load the module constant's own objects — one
  // in-place edit by a consumer (or a selftest) would poison every later load in the process.
  const out = Object.fromEntries(Object.entries(CUSTOMER_DEFAULTS).map(([k, v]) =>
    [k, Array.isArray(v) ? v.map((s) => (_is_dict(s) ? { ...s } : s)) : v]))
  out.malformed = ''
  // Which known keys the declarer actually wrote (non-null). The builder fills its own UI
  // default ONLY for keys absent here, so `"title": ""` is an intentional blank and an absent
  // `title` is "use yours" — without this list the two are the same empty string.
  out.declared = CUSTOMER_KEYS.filter((k) => _get(raw, k) !== null)
  for (const key of Object.keys(raw)) {
    if (!CUSTOMER_KEYS.includes(key) && !key.startsWith('//')) {
      warns.push(`${field}: unknown key '${one_line(key)}' ignored ` +
                 `(known: ${CUSTOMER_KEYS.join(', ')})`)
    }
  }

  // `dir`: the one path. Refused → malformed, never defaulted: a default would build the surface
  // from a directory the declarer did not name. Declared EMPTY → the default, reported.
  if (_get(raw, 'dir') !== null) {
    const d = norm(_str(raw.dir)).replace(/\/+$/, '')
    if (!d) {
      warns.push(`${field}.dir: declared empty — using the default ` +
                 `'${CUSTOMER_DEFAULTS.dir}'`)
    } else if (!token_ok(d) || d.startsWith('-')) {
      warns.push(`${field}.dir: '${one_line(d)}' refused (a repo-relative path of ` +
                 "[A-Za-z0-9._/-] only, no '..', no leading '/' or '-') — the customer " +
                 'surface CANNOT be built until fixed')
      out.malformed = 'dir refused'
    } else {
      out.dir = d
    }
  }
  if (!out.malformed && !_is_dir(path.join(root, out.dir))) {
    // Kept, not dropped — the builder refuses at build time and names the path; this names it
    // at emit time, where CI reads it.
    warns.push(`${field}.dir: '${out.dir}' does not exist — the docs build will refuse ` +
               'until the corpus directory is there')
  }

  for (const key of ['title', 'eyebrow', 'description', 'contact', 'chip_suffix',
    'other_label', 'unkeyed_label', 'footer_date_label']) {
    if (_get(raw, key) === null) continue
    if (typeof raw[key] !== 'string') {
      // "ignored" must mean the builder's default applies: leaving the key in `declared`
      // would make the untouched "" read as an intentional blank.
      warns.push(`${field}.${key}: must be a string — ignored`)
      out.declared = out.declared.filter((k) => k !== key)
      continue
    }
    out[key] = _display(raw[key], `${field}.${key}`, warns)
  }

  for (const key of ['chip_field', 'group_field', 'project_field']) {
    if (_get(raw, key) !== null) {
      out[key] = _fm_key(raw[key], `${field}.${key}`, warns, CUSTOMER_DEFAULTS[key])
    }
  }

  const rf = _get(raw, 'required_frontmatter')
  if (Array.isArray(rf)) {
    out.required_frontmatter = rf.map((k) => _fm_key(k, `${field}.required_frontmatter`, warns)).filter((v) => v)
  } else if (rf !== null) {
    warns.push(`${field}.required_frontmatter: expected a list of frontmatter key names ` +
               '— ignored')
  }

  const grp = _get(raw, 'groups')
  if (Array.isArray(grp)) {
    const kept = []
    grp.forEach((g, i) => {
      const gf = `${field}.groups[${i}]`
      if (!_is_dict(g)) {
        warns.push(`${gf}: expected an object with 'label' and 'keys' — ignored`)
        return
      }
      for (const k of Object.keys(g)) {
        if (k !== 'label' && k !== 'keys' && !k.startsWith('//')) {
          warns.push(`${gf}: unknown key '${one_line(k)}' ignored (known: label, keys)`)
        }
      }
      const label = typeof _get(g, 'label') === 'string' ? _display(g.label, `${gf}.label`, warns) : ''
      const keysRaw = _get(g, 'keys')
      const keys = Array.isArray(keysRaw) ? keysRaw.filter(_is_int) : []
      const bad = Array.isArray(keysRaw) ? keysRaw.filter((k) => !_is_int(k)) : []
      if (!label || !keys.length || bad.length) {
        const shown = bad.length ? ` — refused: ${bad.map((b) => one_line(_str(b))).join(', ')}` : ''
        warns.push(`${gf}: needs a non-empty 'label' and 'keys' as a list of integers ` +
                   `(the leading integer of a program's '${out.group_field}' ` +
                   `value)${shown} — entry ignored`)
        return
      }
      kept.push({ label, keys })
    })
    out.groups = kept
    if (grp.length && !kept.length) {
      warns.push(`${field}.groups: every entry was rejected — every program will land ` +
                 'in the fallback groups')
    }
  } else if (grp !== null) {
    warns.push(`${field}.groups: expected a list of {label, keys} objects — ignored`)
  }

  let pm = _get(raw, 'projects_md', false)
  if (typeof pm !== 'boolean') {
    // The script-gate `files` lesson: a JSON string would read as true and silently INVERT the
    // declared intent. The default (off) is the conservative direction.
    warns.push(`${field}.projects_md: must be a JSON boolean (true/false), got ` +
               `'${one_line(_str(pm))}' — treated as false (no PROJECTS.md)`)
    pm = false
  }
  out.projects_md = pm

  const rs = _get(raw, 'release_stages')
  if (Array.isArray(rs)) {
    if (!rs.length) {
      // An empty list is a declaration too (the `""` rule above, list form): reported as
      // what it is, not as "every entry was rejected".
      warns.push(`${field}.release_stages: declared empty — using the default ` +
                 'vocabulary (FUT, UAT, PROD)')
    }
    const stages = []
    rs.forEach((s, i) => {
      const sf = `${field}.release_stages[${i}]`
      if (!_is_dict(s)) {
        warns.push(`${sf}: expected an object with 'tag' and 'label' — ignored`)
        return
      }
      for (const k of Object.keys(s)) {
        if (k !== 'tag' && k !== 'label' && !k.startsWith('//')) {
          warns.push(`${sf}: unknown key '${one_line(k)}' ignored (known: tag, label)`)
        }
      }
      const tag = py_strip(_str(_get(s, 'tag') !== null ? s.tag : ''))
      if (!STAGE_TAG.test(tag)) {
        warns.push(`${sf}: tag '${one_line(tag)}' must be [A-Za-z0-9_-] — entry ignored`)
        return
      }
      if (stages.some((x) => x.tag === tag)) {
        warns.push(`${sf}: duplicate tag '${tag}' — entry ignored`)
        return
      }
      const label = typeof _get(s, 'label') === 'string' && py_strip(s.label)
        ? _display(s.label, `${sf}.label`, warns) : tag
      stages.push({ tag, label })
    })
    if (stages.length) {
      out.release_stages = stages
    } else if (rs.length) {
      warns.push(`${field}.release_stages: every entry was rejected — using the default ` +
                 'vocabulary (FUT, UAT, PROD)')
    }
  } else if (rs !== null) {
    warns.push(`${field}.release_stages: expected a list of {tag, label} objects ` +
               '— ignored')
  }

  const pn = _get(raw, 'panels')
  if (Array.isArray(pn)) {
    const panels = []
    const usedIds = new Set(['docs'])
    pn.forEach((p, i) => {
      const pf = `${field}.panels[${i}]`
      if (!_is_dict(p)) {
        warns.push(`${pf}: expected an object with 'module' and 'label' — ignored`)
        return
      }
      for (const k of Object.keys(p)) {
        if (!PANEL_KEYS.includes(k) && !k.startsWith('//')) {
          warns.push(`${pf}: unknown key '${one_line(k)}' ignored ` +
                     `(known: ${PANEL_KEYS.join(', ')})`)
        }
      }
      const module = norm(_str(_get(p, 'module') !== null ? p.module : ''))
      // The same refusal as a script-gate path — this is a file the builder will IMPORT.
      if (!module || !token_ok(module) || module.startsWith('-')) {
        warns.push(`${pf}: module '${one_line(module)}' refused (a repo-relative path of ` +
                   "[A-Za-z0-9._/-] only, no '..', no leading '/' or '-') — entry ignored")
        return
      }
      if (!module.endsWith('.mjs')) {
        // Kept, not dropped, like a missing file: dropping the tab would let the page build
        // without it, and the builder must refuse until the panel is an `.mjs` module.
        warns.push(`${pf}: module '${module}' is not an .mjs module — the docs build will ` +
                   'refuse until the panel is an .mjs module exporting render_panel(repoRoot) ' +
                   'and optionally CSS, UPDATED, TAB_CHIPS')
      } else if (!_is_file(path.join(root, module))) {
        // Kept, not dropped — the builder refuses at build time and names the path.
        warns.push(`${pf}: module '${module}' does not exist — the docs build will ` +
                   'refuse until it does')
      }
      const label = typeof _get(p, 'label') === 'string' && py_strip(p.label)
        ? _display(p.label, `${pf}.label`, warns) : ''
      if (!label) {
        warns.push(`${pf}: needs a non-empty 'label' (the tab text) — entry ignored`)
        return
      }
      // `id` (ywr-harness ADR 0061): the tab's `#top-<id>` deep link — a PUBLISHED value, so
      // a refused or duplicate declared id drops the entry rather than silently renaming the
      // link the declarer asked for. Absent → derived (label slug, else `panel-<n>` over the
      // KEPT entries) so existing pages keep their ids; an auto slug that collides falls
      // back to `panel-<n>` with a warning.
      const pidRaw = _get(p, 'id')
      let pid
      if (pidRaw !== null) {
        pid = _str(pidRaw)
        if (!PANEL_ID.test(pid) || usedIds.has(pid)) {
          const why = pid === 'docs' ? 'is reserved for the documents tab'
            : usedIds.has(pid) ? 'is already taken'
              : 'must match ^[a-z][a-z0-9_-]*$'
          warns.push(`${pf}: id '${one_line(pid)}' ${why} — entry ignored`)
          return
        }
      } else {
        pid = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        // The first FREE `panel-<n>` from the kept-entry index: the index alone can land on
        // an id an earlier entry declared (`id: "panel-1"` then a Korean label) and two tabs
        // would share one `data-top` / scope class.
        let n = panels.length
        while (usedIds.has(`panel-${n}`)) n++
        const fallback = `panel-${n}`
        if (pid && usedIds.has(pid)) {
          warns.push(`${pf}: derived id '${pid}' collides with an earlier tab — using ` +
                     `'${fallback}'; declare 'id' to pin it`)
          pid = fallback
        } else if (!pid) {
          pid = fallback
        }
      }
      let position = _get(p, 'position')
      if (position === null) {
        position = 'after-docs'
      } else if (!PANEL_POSITIONS.includes(position)) {
        warns.push(`${pf}: position '${one_line(_str(position))}' is not one of ` +
                   `${PANEL_POSITIONS.join(', ')} — using 'after-docs'`)
        position = 'after-docs'
      }
      usedIds.add(pid)
      panels.push({ module, label, id: pid, position })
    })
    out.panels = panels
    if (pn.length && !panels.length) {
      warns.push(`${field}.panels: every entry was rejected — no extra tab will be built`)
    }
  } else if (pn !== null) {
    warns.push(`${field}.panels: expected a list of {module, label} objects — ignored`)
  }

  // `default_tab` (ywr-harness ADR 0061): validated against the FINAL ids above, so it may name a derived
  // one. The builder's own default is the first tab in rendered order, which is why "" here
  // means "unset", never "the docs tab".
  const dt = _get(raw, 'default_tab')
  if (dt !== null) {
    const known = ['docs', ...out.panels.map((pl) => pl.id)]
    if (typeof dt !== 'string' || !known.includes(dt)) {
      warns.push(`${field}.default_tab: '${one_line(_str(dt))}' is not a tab id ` +
                 `(${known.join(', ')}) — the first tab in rendered order opens`)
    } else {
      out.default_tab = dt
    }
  }
  return out
}

/**
 * Walk upward ONCE: the nearest directory holding .harness.json, or the nearest holding
 * .git — whichever comes first. Falls back to `start`: every consumer is advisory, so a repo
 * with neither marker still works on defaults rather than failing.
 *
 * One walk, not two: a two-pass form (every ancestor for .harness.json, then .git) would attach
 * a nested repository without a declaration of its own (a submodule, a scratch clone inside a
 * scaffolded repo) to the OUTER repo's declaration and gate its files against the wrong tree.
 * A .git boundary ends the walk; a .harness.json below the git root still wins.
 * @param {string} start
 * @returns {string} an absolute path with symlinks resolved
 */
export function find_repo_root(start) {
  const cur = _realpath(start)
  for (let candidate = cur; ; candidate = path.dirname(candidate)) {
    if (fs.existsSync(path.join(candidate, '.harness.json')) || fs.existsSync(path.join(candidate, '.git'))) {
      return candidate
    }
    if (path.dirname(candidate) === candidate) break
  }
  return cur
}

/**
 * One object-valued top-level section; anything else is warned and read as empty. Typed
 * BEFORE any falsy fallback: `"review": []` or `"verify": ""` must warn, not read as {}.
 * @param {Object} raw @param {string} key @param {string[]} warns @returns {Object}
 */
export function _section(raw, key, warns) {
  const val = _get(raw, key)
  if (val === null) return {}
  if (!_is_dict(val)) {
    warns.push(`${key}: expected an object — ignored`)
    return {}
  }
  return val
}

/**
 * Return `[config, warnings]`. Warnings are RETURNED, never printed here — the caller decides
 * where they go, and a silently swallowed warning about a refused value would look exactly like
 * a good configuration. A file that is not valid UTF-8 throws an Error named `UnicodeDecodeError`,
 * as Python's strict read does.
 * @param {string} root
 * @returns {[Object, string[]]}
 */
export function load(root) {
  const warns = []
  const cfg = { ...DEFAULTS }
  // An undeclared review canon is CLAUDE.md, a memory file every session loads (ywr-harness ADR 0217).
  // A root REVIEW.md takes its place: no session loads that file by itself, so the canon line names
  // it and asks for its import instead of passing while no review reads it.
  if (_is_file(path.join(root, 'REVIEW.md'))) cfg.review_canon = 'REVIEW.md'
  cfg.groups = []
  cfg.review = { docs_only: [], harness_layer: [], critical: [], derived: [] }
  // Retro surfaces. Free-string regexes like `review`: they select and report, and cannot name
  // an executable, so the closed-set rule that governs `gates` does not apply here.
  cfg.retro = { source_scope: [], dep_manifests: [], migrations: [] }
  // Declared claude.ai Artifacts (ywr-harness ADR 0032). Parsed here, CHECKED by the gate emitter: the
  // README must carry each declared url, each declared title must start with the repo name.
  // Items are kept raw — per-item validation happens at check time so a malformed entry can
  // fail the check loudly instead of being dropped into silence at load time. `malformed`
  // carries a section-level shape error for the same reason: a declaration that cannot be
  // checked must never read as enforcement.
  cfg.artifacts = { readme: 'README.md', items: [], malformed: '' }
  // Customer-corpus surface (ywr-harness ADR 0060): null = off. Validated by `customer_decl` below.
  cfg.customer = null
  // STE-lite gate mode (ywr-harness ADR 0128): true only for a literal JSON `true` — the docs check then
  // fails on a finding; absent, null or false keeps it advisory (findings print, exit 0).
  cfg.ste_lite = false
  // ywr-harness ADR 0170 check mode: true only for a literal JSON `true` — R8, the R7 words and the ADR
  // option count then fail the docs check. The scaffold seed leaves it out, so consumers get advice.
  cfg.ste_marks = false
  // Declared R7 words (ywr-harness ADR 0170): word → replacement. The STE-lite gate flags each listed word
  // in a checked section. Display text, never a command (ywr-harness ADR 0012); one bad entry drops the map.
  cfg.ste_words = {}

  const file = path.join(root, '.harness.json')
  if (!fs.existsSync(file)) {
    warns.push('.harness.json not found — using defaults (selection and gates will be broad)')
    return [cfg, warns]
  }
  let raw
  try {
    const bytes = fs.readFileSync(file)
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw _py_error('UnicodeDecodeError', "'utf-8' codec can't decode the file")
    }
    try {
      raw = JSON.parse(text)
    } catch (e) {
      throw _py_error('JSONDecodeError', e.message)
    }
  } catch (e) {
    if (e.name === 'UnicodeDecodeError') throw e
    const name = e.name === 'JSONDecodeError' ? 'JSONDecodeError' : _os_error_name(e)
    warns.push(`.harness.json unreadable (${name}) — using defaults`)
    return [cfg, warns]
  }
  // Every section below is read with `_get`, so a non-object top level or section is checked
  // first: unchecked, it would throw instead of reaching the warn-and-default path.
  if (!_is_dict(raw)) {
    warns.push(`.harness.json: expected an object at the top level, got ` +
               `${_type_name(raw)} — using defaults`)
    return [cfg, warns]
  }

  const docs = _section(raw, 'docs', warns)
  if (_truthy(_get(docs, 'index'))) {
    cfg.index = safe_path(docs.index, 'docs.index', warns) || DEFAULTS.index
  }
  cfg.customer = customer_decl(_get(docs, 'customer'), root, warns)
  const ste = _get(docs, 'ste_lite')
  if (ste === true) {
    cfg.ste_lite = true
  } else if (ste !== null && ste !== false) {
    warns.push(`docs.ste_lite: expected true or false, got ${_type_name(ste)} — ` +
               'the STE-lite gate stays advisory')
  }
  const marks = _get(docs, 'ste_marks')
  if (marks === true) {
    cfg.ste_marks = true
  } else if (marks !== null && marks !== false) {
    warns.push(`docs.ste_marks: expected true or false, got ${_type_name(marks)} — ` +
               'the ywr-harness ADR 0170 checks stay advisory')
  }
  let words = _get(docs, 'ste_words')
  if (_is_dict(words)) {  // a "//" key is a comment, as in the other sections
    words = Object.fromEntries(Object.entries(words).filter(([k]) => !k.startsWith('//')))
  }
  if (_is_dict(words) && Object.entries(words).every(([k, v]) => py_strip(k) && typeof v === 'string' && py_strip(v))) {
    cfg.ste_words = Object.fromEntries(Object.entries(words).map(([k, v]) => [py_strip(k), py_strip(v)]))
  } else if (words !== null) {
    const got = _is_dict(words) ? 'an empty or non-string entry' : _type_name(words)
    warns.push('docs.ste_words: expected an object of non-empty word-to-replacement strings, ' +
               `got ${got} — the R7 word check is off`)
  }

  const ver = _section(raw, 'verify', warns)
  let runner = _str(_or(_get(ver, 'runner'), DEFAULTS.runner))
  if (!_has(RUNNERS, runner)) {
    warns.push(
      `verify.runner '${runner}' is not in the closed set ` +
      `(${_sorted(Object.keys(RUNNERS)).join(', ')}) — using '${DEFAULTS.runner}'`)
    runner = DEFAULTS.runner
  }
  cfg.runner = runner
  if (_truthy(_get(ver, 'cwd'))) cfg.cwd = safe_cwd(ver.cwd, 'verify.cwd', warns)
  for (const field of ['strip_prefix', 'ui_prefix']) {
    if (_truthy(_get(ver, field))) cfg[field] = safe_path(ver[field], `verify.${field}`, warns)
  }
  for (const field of ['script_pattern', 'product_scope']) {
    if (_truthy(_get(ver, field))) cfg[field] = _str(ver[field])
  }

  if (_truthy(_get(raw, 'handoff'))) cfg.handoff = safe_path(raw.handoff, 'handoff', warns)

  const rev = _section(raw, 'review', warns)
  if (_truthy(_get(rev, 'canon'))) {
    cfg.review_canon = safe_path(rev.canon, 'review.canon', warns) || cfg.review_canon
  }
  for (const key of ['docs_only', 'harness_layer', 'critical']) {
    const val = _get(rev, key)
    if (Array.isArray(val)) {
      cfg.review[key] = val.map(_str)
    } else if (_truthy(val)) {
      warns.push(`review.${key}: expected a list of regexes — ignored`)
    }
  }

  // Derived-copy mappings (ywr-harness ADR 0037). PATH PREFIXES, not regexes: the copy→source mapping is
  // computed by prefix swap, so each prefix must end with '/' (a bare prefix could match a
  // sibling directory mid-segment) and pass the same token allowlist as any path value. These
  // never reach a command position — the emitter only reads bytes at the mapped paths — but a
  // traversal segment must still be refused: the mapped path is opened relative to the root.
  const der = _get(rev, 'derived')
  if (Array.isArray(der)) {
    der.forEach((d, i) => {
      if (!_is_dict(d)) {
        warns.push(`review.derived[${i}]: expected an object with 'source' and 'copies' — ignored`)
        return
      }
      for (const key of Object.keys(d)) {
        if (key !== 'source' && key !== 'copies' && !key.startsWith('//')) {
          warns.push(`review.derived[${i}]: unknown key '${key}' ignored (known: source, copies)`)
        }
      }
      const src = norm(_str(_or(_get(d, 'source'), '')))
      const rawCopies = _get(d, 'copies')
      const copies = Array.isArray(rawCopies) ? rawCopies.map((c) => norm(_str(c))) : []
      const bad = [src, ...copies].filter((p) => p && !(token_ok(p) && p.endsWith('/')))
      if (!src || !copies.length || copies.some((c) => !c) || bad.length) {
        const shown = bad.length ? ` — refused: ${bad.map(one_line).join(', ')}` : ''
        warns.push(`review.derived[${i}]: 'source' and 'copies' must be path PREFIXES ` +
                   "ending in '/' ([A-Za-z0-9._/-] only, no '..', no leading '/')" +
                   `${shown} — entry ignored`)
        return
      }
      cfg.review.derived.push({ source: src, copies })
    })
  } else if (_truthy(der)) {
    warns.push('review.derived: expected a list of {source, copies} mappings — ignored')
  }

  const ret = _section(raw, 'retro', warns)
  if (_truthy(_get(ret, 'ignore_file'))) {
    cfg.retro_ignore_file = (
      safe_path(ret.ignore_file, 'retro.ignore_file', warns) || DEFAULTS.retro_ignore_file)
  }
  for (const key of ['source_scope', 'dep_manifests', 'migrations']) {
    const val = _get(ret, key)
    if (Array.isArray(val)) {
      cfg.retro[key] = val.map(_str)
    } else if (_truthy(val)) {
      warns.push(`retro.${key}: expected a list of regexes — ignored`)
    }
  }

  const art = _get(raw, 'artifacts')
  if (_is_dict(art)) {
    if (_truthy(_get(art, 'readme'))) {
      cfg.artifacts.readme = safe_path(art.readme, 'artifacts.readme', warns) || 'README.md'
    }
    const items = _get(art, 'items')
    if (Array.isArray(items)) {
      cfg.artifacts.items = [...items]
    } else if (items !== null) {
      cfg.artifacts.malformed = "'items' must be a list of {url, title} objects"
    }
    for (const key of Object.keys(art)) {
      if (key !== 'readme' && key !== 'items' && !key.startsWith('//')) {
        warns.push(`artifacts: unknown key '${key}' ignored (known: readme, items)`)
      }
    }
  } else if (art !== null) {
    cfg.artifacts.malformed = "expected an object with 'readme' and 'items'"
  }

  let rawGroups = _get(raw, 'groups')
  if (rawGroups === null) {
    rawGroups = []
  } else if (!Array.isArray(rawGroups)) {
    warns.push('groups: expected a list of {name, match, gates} objects — ignored')
    rawGroups = []
  }
  rawGroups.forEach((g, i) => {
    if (!_is_dict(g) || !_truthy(_get(g, 'name')) || !_truthy(_get(g, 'match'))) {
      warns.push(`groups[${i}]: needs 'name' and 'match' — ignored`)
      return
    }
    // The name is a LABEL, echoed by the emitter as `  [<name>] N file(s)` — a line inside the
    // gate-command window both output parsers execute from. Sanitized HERE, once, so every
    // downstream use (field labels, the grouping key, the printed label) is the safe form: a
    // value that never exists in its raw shape after load cannot be echoed raw by a later
    // caller. A control character is reported, never silently swallowed.
    const name = one_line(_str(g.name))
    if (has_control(_str(g.name))) {
      warns.push(`groups[${i}]: control character(s) in the group name were escaped for ` +
                 `display ('${name}') — a group name is echoed inside the gate-command ` +
                 'window, so a raw newline there would forge a gate command')
    }
    // Resolved BEFORE the gates: a script gate is validated against the form it composes to
    // under this prefix, so the prefix has to be known (and itself validated) first.
    const gStrip = safe_path(_get(g, 'strip_prefix', ''), `groups[${name}].strip_prefix`, warns)
    const gates = []
    let rawGates = _or(_get(g, 'gates'), [])
    if (!Array.isArray(rawGates)) {
      warns.push(`groups[${name}].gates: expected a list of gate names, got ` +
                 `${_type_name(rawGates)} — ignored`)
      rawGates = []
    }
    for (let gate of rawGates) {
      if (_is_dict(gate)) {
        const sg = script_gate(gate, name, gStrip, root, warns)
        if (sg) gates.push(sg)
        continue
      }
      gate = _str(gate)
      if (_has(GATES, gate)) {
        gates.push(gate)
      } else {
        warns.push(
          `groups[${name}].gates: '${gate}' is not in the closed set ` +
          `(${_sorted(Object.keys(GATES)).join(', ')}) — dropped`)
      }
    }
    cfg.groups.push({
      name,
      match: _str(g.match),
      cwd: safe_cwd(_get(g, 'cwd', ''), `groups[${name}].cwd`, warns),
      strip_prefix: gStrip,
      gates,
    })
  })
  if (rawGroups.length && !cfg.groups.length) {
    warns.push('groups: every entry was rejected — no deterministic gate will be emitted')
  }
  return [cfg, warns]
}

// git's own binary test (`buffer_is_binary`): a NUL byte among the first 8,000 bytes.
export const BINARY_SNIFF = 8000

/**
 * The line count git gives a file: the `\n` count, plus one for an unterminated last line.
 * null for a binary file, by git's own test. Read in chunks, so a large file costs time, never
 * memory. The gate emitter and the retro share this one count; each caller decides what a
 * symlink, a directory or a missing file means. Throws an Error named for the Python OSError
 * subclass (`FileNotFoundError`, `PermissionError`, ...) when the path cannot be read.
 * @param {string} p
 * @returns {number|null}
 */
export function text_lines(p) {
  let fd
  try {
    fd = fs.openSync(p, 'r')
  } catch (e) { throw _oserr(e) }
  try {
    let n = 0
    let last = -1
    const buf = Buffer.alloc(1 << 20)
    let got = fs.readSync(fd, buf, 0, BINARY_SNIFF, null)
    if (buf.subarray(0, got).includes(0)) return null
    while (got > 0) {
      const view = buf.subarray(0, got)
      for (let at = view.indexOf(10); at !== -1; at = view.indexOf(10, at + 1)) n++
      last = buf[got - 1]
      got = fs.readSync(fd, buf, 0, buf.length, null)
    }
    return n + (last !== -1 && last !== 10 ? 1 : 0)
  } catch (e) {
    throw _oserr(e)
  } finally {
    fs.closeSync(fd)
  }
}

// ---------------------------------------------------------------------------------------------
// Scope resolution. Lives here, not in either consumer: both /verify and the gate emitter must
// answer "which files is this slice" the SAME way, and two implementations of that question would
// let a slice pass one gate on a different file set than the other saw. The git boundary itself
// (`git_run`, `git_lines`, `git_paths`, `GIT_PINS`) lives in harness_git.mjs and is re-exported above.
// ---------------------------------------------------------------------------------------------
const _normcase = (s) => (process.platform === 'win32' ? s.replaceAll('/', '\\').toLowerCase() : s)

// Python's `os.path.isabs` since 3.13: on Windows a drive or UNC path only, never a bare `\x`.
const _isabs = (s) => (process.platform === 'win32' ? /^([A-Za-z]:[\\/]|[\\/]{2})/.test(s) : s.startsWith('/'))

// `os.path.normpath`: collapses `.` and `..` and drops a trailing separator.
function _normpath(s) {
  let r = path.normalize(s)
  if (r.length > 1 && r.endsWith(path.sep) && !/^[A-Za-z]:\\$/.test(r)) r = r.slice(0, -1)
  return r
}

/**
 * An explicit file argument as the repo-root-relative POSIX path every group pattern is written
 * against. A relative argument is read from the working directory first, as a shell would, so a
 * path typed inside a sub-directory resolves. When that reading names nothing on disk, or lands
 * outside the repo (`--repo` given from elsewhere), the argument is read from the root: that is
 * the form `git diff --name-only` prints in every directory, a deleted file included. An absolute
 * path inside the repo is cut at the root. A path outside the repo has no such form and stays as
 * given, which the emitter then lists as ungrouped. The directory part is resolved through
 * symlinks and the file itself is not: a tracked symlink names itself.
 * @param {string} root @param {string} raw @returns {string}
 */
export function repo_relative(root, raw) {
  const p = norm(raw)
  if (!p) return p
  const base = _realpath(root)
  const absolute = _normpath(_isabs(p) ? p : path.join(process.cwd(), p))
  const cand = path.join(_realpath(path.dirname(absolute)), path.basename(absolute))
  const key = _normcase(cand)
  const baseKey = _normcase(base)
  const cut = baseKey.replace(/[\\/]+$/, '').length
  if (key.startsWith(baseKey.replace(/[\\/]+$/, '') + path.sep)) {
    // Both keys fold case and separators identically, so the cut offset is the same in `cand`.
    const fromCwd = norm(cand.slice(cut + 1))
    if (_isabs(p) || _lexists(cand)) return fromCwd
    const fromRoot = norm(_normpath(p))
    return fromRoot.startsWith('..') ? fromCwd : fromRoot
  }
  return _isabs(p) ? p : norm(_normpath(p))
}

/**
 * Return `[files, provenance]`. Provenance is REPORTED by the caller, never dropped: a range
 * that matches nothing while the working tree supplies the files is a vacuous pass — the run
 * looks like it covered the range and did not.
 *
 * `all_files` is the full-tree audit scope (ywr-harness ADR 0041): git ls-files + untracked. It exists for
 * CI's push runs, where the worktree is a fresh checkout and every diff-shaped scope is empty
 * by construction — partition and gate coverage are TREE properties there, not diff properties.
 * The fourth argument is `{all_files}` or the boolean itself.
 * @param {string} root @param {string|null} rev_range @param {string[]} explicit
 * @param {{all_files?: boolean}|boolean} [opts]
 * @returns {[string[], Object]}
 */
export function changed_files(root, rev_range, explicit, opts = {}) {
  const all_files = typeof opts === 'boolean' ? opts : Boolean(opts && opts.all_files)
  if (all_files) {
    const tracked = git_paths(root, ['ls-files'])
    const untracked = git_paths(root, ['ls-files', '--others', '--exclude-standard'])
    const files = _sorted(new Set([...tracked, ...untracked]))
    return [files, { source: 'all', tracked_files: tracked.length,
      untracked_files: untracked.length, untracked }]
  }
  if (explicit && explicit.length) {
    const files = [...new Set(explicit.map((p) => repo_relative(root, p)))]
    return [files, { source: 'explicit', explicit: files.length, range: rev_range }]
  }
  const prov = { source: 'git', range: rev_range, range_files: null }
  const files = new Set()
  if (rev_range) {
    const ranged = git_paths(root, ['diff', '--name-only', rev_range])
    prov.range_files = ranged.length
    for (const f of ranged) files.add(f)
  }
  // Current state always counts: staged+unstaged vs HEAD, plus untracked. `git diff` never lists
  // untracked files, and a new file must surface too.
  let worktree
  try {
    worktree = git_paths(root, ['diff', '--name-only', 'HEAD'])
  } catch (e) {
    if (e.name !== 'CalledProcessError') throw e
    // An unborn HEAD (no commit yet — a freshly scaffolded repo before its first commit) is a
    // NORMAL state, not the fail-loud class (ywr-harness ADR 0041: force-pushed base, stale
    // fetch): letting it escalate would fire `scope: FAILED` on `git init && git add`.
    // Verify which failure this is: with HEAD genuinely absent, the honest worktree scope is
    // staged (index vs the empty tree) plus unstaged (index vs worktree), both of which git
    // answers without HEAD. Any other diff failure re-raises and stays loud.
    // The exit code is the answer here; no output is read.
    const probe = git_result(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (probe.status === 0) throw e
    worktree = _sorted(new Set([...git_paths(root, ['diff', '--name-only', '--cached']),
      ...git_paths(root, ['diff', '--name-only'])]))
    prov.unborn_head = true
  }
  const untracked = git_paths(root, ['ls-files', '--others', '--exclude-standard'])
  prov.worktree_files = worktree.length
  prov.untracked_files = untracked.length
  // The list itself too: the emitter's line measure reads these files, and `git diff --numstat`
  // never lists them — handed over here so the measure starts no second ls-files.
  prov.untracked = untracked
  for (const f of worktree) files.add(f)
  for (const f of untracked) files.add(f)
  return [_sorted(files), prov]
}

/**
 * Return `[tree, head]`: the working tree as one git tree id, and HEAD's commit id ("none" when
 * HEAD is unborn). The prepared-close identity (ywr-harness ADR 0105): a session that ran the gates, the
 * review and verify reports this pair, and the owner-typed `/ywr-harness:slice-close` reuses those results
 * only while a fresh snapshot prints the same pair; when it differs, `git diff --name-only
 * <old-tree> <new-tree>` names exactly what changed since.
 *
 * The tree is the worktree in its STAGED form: tracked content plus untracked, non-ignored files,
 * after clean filters and eol normalization, a submodule by its commit only. It is taken through a
 * COPY of the index, so the real index, refs and worktree are never touched; the copy keeps the
 * index's mtime, because git re-hashes a racily clean entry by comparing against the index file's
 * own mtime, and a fresh one would trust stat data the real index would not. The copy's mtime is
 * set one microsecond BELOW the original (Node sets a time from a floating-point number of seconds,
 * which cannot hold a nanosecond count), so a rounding error can only make git re-hash one entry
 * more, never trust a stale one. The copy's assume-unchanged and skip-worktree bits are cleared
 * first, one `update-index` call per bit (one call with both clears only one, measured on git
 * 2.53): `add -A` never looks at a flagged entry, so an edit to one would leave the id unchanged
 * while the gates read the new bytes. The `-c` pins keep `core.ignoreStat` from setting those bits
 * again and keep an fsmonitor or split index out of it. It writes blob and tree objects,
 * unreferenced, which `git gc` prunes like any `git stash create`, plus whatever a clean filter
 * stores (git-lfs's object store). Every git failure throws; the caller prints the loud marker, and
 * nothing is reused.
 * @param {string} root
 * @returns {[string, string]}
 */
export function worktree_snapshot(root) {
  let head
  try {
    head = py_strip(git_run(root, ['rev-parse', '--verify', '--quiet', 'HEAD']))
  } catch (e) {
    if (e.name !== 'CalledProcessError') throw e
    // Unborn is the one failure that means "none": HEAD names a branch that has no ref yet.
    // Anything else (a corrupt ref, a detached HEAD git cannot resolve) stays loud.
    const branch = py_strip(git_run(root, ['symbolic-ref', '-q', 'HEAD']))
    if (py_strip(git_run(root, ['for-each-ref', '--format=%(refname)', branch]))) throw e
    head = 'none'
  }
  const index = path.resolve(root, py_strip(git_run(root, ['rev-parse', '--git-path', 'index'])))
  const tmp = path.join(os.tmpdir(), `ywr-tree-${process.pid}-${Math.random().toString(36).slice(2)}.index`)
  fs.closeSync(fs.openSync(tmp, 'wx'))
  const pins = ['-c', 'core.ignoreStat=false', '-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false']
  let tree
  try {
    if (_is_file(index)) {
      fs.copyFileSync(index, tmp)
      const st = fs.statSync(index, { bigint: true })
      const below = (ns) => (Number(ns / 1000n) - 1) / 1e6
      fs.utimesSync(tmp, below(st.atimeNs), below(st.mtimeNs))
    } else {
      fs.rmSync(tmp)  // no index yet: git creates one; an EMPTY file would read as corrupt
    }
    const env = { GIT_INDEX_FILE: tmp }
    const records = git_run(root, [...pins, 'ls-files', '-v', '-z'], { env }).split('\0').filter((r) => r)
    // `ls-files -v` tags: lowercase = assume-unchanged, `S`/`s` = skip-worktree.
    for (const [flag, paths] of [
      ['--no-assume-unchanged', records.filter((r) => /^[a-z]/.test(r)).map((r) => r.slice(2))],
      ['--no-skip-worktree', records.filter((r) => r[0] === 'S' || r[0] === 's').map((r) => r.slice(2))],
    ]) {
      if (paths.length) {
        git_run(root, [...pins, 'update-index', flag, '-z', '--stdin'],
          { stdin: paths.join('\0') + '\0', env })
      }
    }
    git_run(root, [...pins, 'add', '-A'], { env })
    tree = py_strip(git_run(root, [...pins, 'write-tree'], { env }))
  } finally {
    for (const p of [tmp, tmp + '.lock']) {
      try {
        fs.rmSync(p)
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
    }
  }
  return [tree, head]
}

/**
 * One line naming where the file list came from — the only thing that makes an empty-range run
 * distinguishable from a covered-range run.
 * @param {string[]} files @param {Object} prov
 */
export function print_scope(files, prov) {
  const get = (k, d) => _get(prov, k, d)
  if (get('source') === 'all') {
    say(`scope: full tree — tracked ${get('tracked_files', 0)} · ` +
        `untracked ${get('untracked_files', 0)} = ${files.length} unique file(s) (--all)`)
    return
  }
  if (get('source') === 'explicit') {
    if (_truthy(get('range'))) process.stderr.write('note: explicit files given — ignoring --range\n')
    say(`scope: ${_str(prov.explicit)} explicit file(s)`)
    return
  }
  const parts = []
  if (_truthy(get('range'))) parts.push(`range ${_str(prov.range)} -> ${_str(prov.range_files)}`)
  parts.push(`worktree ${get('worktree_files', 0)}`)
  parts.push(`untracked ${get('untracked_files', 0)}`)
  say(`scope: ${parts.join(' · ')} = ${files.length} unique file(s)`)
  if (_truthy(get('unborn_head'))) {
    warn('no commit yet (unborn HEAD) — the worktree scope is staged+unstaged vs the ' +
         "empty tree; this is a report, not a failure (ywr-harness ADR 0041's loud exit is for a " +
         'scope git could not answer at all)')
  }
  if (_truthy(get('range')) && get('range_files') === 0) {
    warn(`range ${_str(prov.range)} matched 0 file(s) — everything below rests on the ` +
         'WORKING TREE, not the range you asked for (vacuous-pass guard)')
  }
}

/**
 * `cd <cwd> && <cmd>`, or the command alone. `cwd` reaches a command position too, so it is
 * held to the same token gate here — `safe_path` alone permits a space, `#` or `*`, each of
 * which `sh -c` or an output parser would reinterpret. A refused cwd degrades to running from
 * the repo root, which fails loudly on the stripped paths rather than running something else.
 *
 * `warns` is threaded for the same reason `gate_command` threads one: this second-layer refusal
 * is unreachable through `load()` today (`safe_cwd` already scrubbed the value), and a drop
 * with no warns channel is a silent drop waiting for a refactor.
 *
 * Every argv element is shell-quoted (`shlex_quote`), so ONE element reaches `sh -c` as ONE
 * argument. The closed set carries an element with a space — `pytest-nondb`'s `-m "not db"` —
 * and a plain space-join delivered it as `-m not db`: pytest took `db` as a path and exited 4.
 * An element made only of SAFE_TOKEN characters is shell-safe and comes out unquoted, so every
 * other command's bytes are unchanged; the round-trip property (a shell split of
 * `compose(cmd, cwd)` gives back the argv) is pinned over every GATES and RUNNERS entry by the
 * ywr-harness canon's harness_gates.selftest.ps1 (case AD).
 * @param {string[]} parts @param {string} cwd @param {string[]|{warns: string[]}|null} [warns]
 * @returns {string}
 */
export function compose(parts, cwd, warns = null) {
  const w = _warns_arg(warns)
  const cmd = parts.map(shlex_quote).join(' ')
  if (cwd && token_ok(cwd)) return `cd ${as_arg(cwd)} && ${cmd}`
  if (cwd && w !== null) {
    w.push(`cwd '${cwd}' refused at composition — the command was printed WITHOUT a ` +
           '`cd`, so it runs from the repo root')
  }
  return cmd
}

/**
 * Compose the command that runs one spec-registered verify script.
 *
 * The script path comes from the docs index — generated from spec frontmatter, so it is
 * repo-supplied text in the working tree, exactly like a `.harness.json` value. It therefore
 * passes the same token gate, checked on the POST-strip_prefix form that actually becomes argv.
 * A refused path yields a parenthetical that is not a command and does NOT repeat the value:
 * the value belongs in the warning, never in a command position (ywr-harness ADR 0012).
 * @param {Object} cfg @param {string} script @param {string[]|{warns: string[]}|null} [warns]
 * @returns {string}
 */
export function verify_command(cfg, script, warns = null) {
  const w = _warns_arg(warns)
  const rel = strip_group_prefix(norm(script), cfg.strip_prefix)
  if (!token_ok(rel)) {
    if (w !== null) {
      w.push(`verify script path '${script}' refused — under strip_prefix ` +
             `'${cfg.strip_prefix}' it composes to '${rel}', which is not a safe ` +
             'command argument; no run line was composed for it')
    }
    return '(refused — unsafe verify script path; see warning)'
  }
  return compose([..._idx(RUNNERS, cfg.runner), as_arg(rel)], cfg.cwd, w)
}

/**
 * True when the gate takes the changed-file list; false for whole-program. One reader for
 * both gate forms so the emitter never branches on shape itself.
 * @param {string|{files: boolean}} gate @returns {boolean}
 */
export function gate_is_scoped(gate) {
  return _truthy(typeof gate === 'string' ? _idx(_idx(GATES, gate), 'files') : _idx(gate, 'files'))
}

/**
 * Changed files that cannot be passed to a gate command as arguments, in their post-strip
 * form. Reported by the caller so the coverage loss is stated rather than silent: a filename is
 * repo-supplied text too — `sh -c` would re-split one containing a space, and both output
 * parsers truncate one containing '#'. `( ) [ ]` are admitted (ywr-harness ADR 0112, `file_arg_ok`).
 * @param {{strip_prefix: string}} group @param {string[]} files @returns {string[]}
 */
export function unsafe_files(group, files) {
  return _sorted(files.filter((f) => !file_arg_ok(strip_group_prefix(f, group.strip_prefix))))
}

/**
 * Changed files no longer in the working tree — a deletion in a range or worktree scope. A
 * file-scoped gate is never handed one (ywr-harness ADR 0112): a deleted plain path fails eslint, prettier
 * and ruff for nothing to check, and a deleted `[id]` path is read by eslint and prettier as a
 * GLOB that checks a sibling (`i/`, `d/`) and passes. `lexists`, so a symlink or a submodule
 * path is still passed as before.
 * @param {string} root @param {string[]} files @returns {string[]}
 */
export function absent_files(root, files) {
  return _sorted(files.filter((f) => !_lexists(path.join(root, f))))
}

/**
 * Compose one gate command. `gate` is a closed-set selector string or a validated script-gate
 * object from `script_gate()` — a raw object from JSON must never reach here.
 *
 * Every path token is re-checked here even though the declaration was validated at load time.
 * That is deliberate duplication: a validator only some call sites apply is not a validator, and
 * this is the last point before a string becomes a command.
 *
 * `warns` is threaded for the same reason `verify_command` threads one. Today the refusal below
 * is unreachable through `load()` (it derives `strip_prefix` from the same group object), so this
 * is the channel that keeps the SECOND layer honest if a future caller ever makes it fire: a
 * branch whose message says "see warning" while writing to no warning list is a silent drop
 * waiting for a refactor.
 * @param {string|Object} gate @param {Object} group @param {string[]} files
 * @param {string[]|{warns: string[]}|null} [warns]
 * @returns {string}
 */
export function gate_command(gate, group, files, warns = null) {
  const w = _warns_arg(warns)
  let parts
  if (typeof gate === 'string') {
    parts = [..._idx(_idx(GATES, gate), 'cmd')]
  } else {
    // Mirrors verify_command: strip_prefix applies to the script path too, so a group that
    // runs from `cwd` addresses its script the same way it addresses its files.
    const script = strip_group_prefix(_idx(gate, 'script'), group.strip_prefix)
    if (!token_ok(script)) {
      if (w !== null) {
        w.push(
          `groups[${group.name}].gates: script-gate path '${gate.script}' refused ` +
          `at composition — under strip_prefix '${group.strip_prefix}' it becomes ` +
          `'${script}', which is not a safe command argument; NO command was composed`)
      }
      return '(refused — unsafe script-gate path; see warning)'
    }
    parts = [..._idx(RUNNERS, _idx(gate, 'runner')), as_arg(script)]
  }
  if (gate_is_scoped(gate)) {
    const rel = _sorted(files.map((f) => strip_group_prefix(f, group.strip_prefix)).filter(file_arg_ok))
    if (!rel.length) {
      // Emitting the bare command here would be worse than emitting nothing: a file-scoped
      // gate with no file list is a WHOLE-TREE run (`ruff check` lints everything), so a
      // group whose every filename was excluded would silently escalate its own scope.
      return "(skipped — none of this group's changed files can be a command argument)"
    }
    parts.push(...rel.map(as_arg))
  }
  return compose(parts, group.cwd, w)
}
