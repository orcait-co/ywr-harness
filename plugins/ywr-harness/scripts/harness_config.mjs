// Shared reader for `.harness.json`: the one place repo-specific harness values are parsed. The
// harness scripts import it as `import * as hc from './harness_config.mjs'`, and no script reads the
// file itself. Two readers of one schema would diverge (ywr-harness ADR 0010).
//
// ESM, Node built-ins only, synchronous only. This library never calls `process.exit`. Where a caller
// catches an error by type, the Error carries the type in `.name` (`CalledProcessError`,
// `FileNotFoundError`, `OSError`, `KeyError`, `UnicodeDecodeError`, `JSONDecodeError`). Repo-relative
// paths stay POSIX (`/`). The `warns` argument is an array that the function appends to. For
// `compose`, `verify_command` and `gate_command` it may be the array or `{warns}`. JSON is read with
// `JSON.parse`, so `1.0` is the integer `1`, the `NaN` and `Infinity` literals are refused, and an
// object key that looks like an array index (`"1"`) iterates before the other keys.
//
// Selectors, not command strings. The consumers print commands for a person or an agent to run, and
// `.harness.json` lives in the working tree, so a cloned repo could otherwise supply the command that
// runs (ywr-harness ADR 0012):
// - `runner` is a selector from a closed set. A `gates` entry is a selector from `GATES`, or a script
//   gate `{runner, script, files}` (ywr-harness ADR 0024) whose runner is from `RUNNERS` and whose
//   script is a validated repo-relative path. A value outside a set is refused, the warning names the
//   set, and the entry is dropped. For `verify.runner` the default is substituted.
// - A path value with a shell metacharacter or `..` is refused. Every token that reaches a command
//   position also passes `token_ok()` in the form it will be composed (after `strip_prefix`), and
//   `as_arg()` neutralizes a leading dash. A changed-file argument alone passes the wider
//   `file_arg_ok()` (`( ) [ ]` too, always single-quoted; ywr-harness ADR 0112), and a changed file
//   absent from the working tree never does.
// - A refused value is echoed in the warning so the reader sees it, and never reaches a printed
//   command. Those are two properties, asserted separately.
// - A file that cannot be an argument is excluded and reported as ungated, because silence would read
//   as coverage.
// - Regexes are free strings: they select and report, and cannot name an executable.
//
// A new stack is a new template here. A repo-specific entry point that no selector can name is a
// script gate (ywr-harness ADR 0024).
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

/** Callers still invoke the encoding pin. Node writes UTF-8 to a pipe and a console alike, so it pins nothing. */
export function pin_utf8() {}

// Closed set: how a verify script is executed.
export const RUNNERS = {
  'python-uv': ['uv', 'run', 'python'],
  'python': ['python'],
  'poetry': ['poetry', 'run', 'python'],
  'node': ['node'],
  'pwsh': ['pwsh', '-NoProfile', '-File'],
}

// Closed set: deterministic gates that run before any LLM review.
//   files=true   the changed file list is appended, so the gate is scoped to the slice.
//   files=false  whole-program. The caller gates on failures in slice files or new in the slice.
//                A pre-existing failure elsewhere is debt to record, not work for the slice.
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
  // shellcheck is the selector for `*.sh` surfaces. The vendored CI installs nothing, so the runner
  // relies on the ubuntu-latest image, and the preflight names it when absent.
  'shellcheck':   { cmd: ['shellcheck'],                                    files: true },
}

// Retired script declarations and the file that replaces each. A repo that declares the old script as
// a script gate or artifact check gets the replacement while that file exists under the root, with a
// warning that asks for the declaration to change. Without the replacement the declaration stays as
// written. The list is closed, so a path outside it is never rewritten.
export const RETIRED_SCRIPTS = { 'docs/check_docs.py': 'docs/check_docs.mjs' }

// ---------------------------------------------------------------------------------------------
// Built-in claims (ywr-harness ADR 0044): the exact destination paths `init.mjs` places or writes,
// meaning every TOOLCHAIN, GUARDED, SEED and SEED_CORPUS destination plus the generated
// `.harness-version` stamp. The emitter claims a changed file that no declared group matched from
// this set and reports it under a `scaffold-claimed` block, so a consuming repo never authors a
// groups entry for a scaffold file. The claim ships in the same refresh as its file. The paths are
// exact, never prefixes or globs, so a new kind of file still surfaces as ungrouped. Declared groups
// win, and this set only consumes leftovers.
//
// This set is a second copy of the `placement.mjs` tables of the ywr-harness plugin. A consuming
// repo's emitter cannot read them, because no plugin exists in CI (ywr-harness ADR 0014). The ywr-harness
// canon's pairing selftest in `harness_gates.selftest.mjs` (case Z) fails when one side changes
// alone, so edit both together. `scripts/harness/__pycache__/` is absent on purpose: the vendored
// `.gitignore` owns it, and claiming bytecode would hide a broken ignore (ywr-harness fact 6).
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
  // SEED destinations: the repo owns the content and the scaffold decides the path, so a claim
  // asserts the path only
  'CLAUDE.md',
  '.gitattributes',
  '.gitignore',
  '.githooks/slice-retro-ignore',
  '.harness.json',
  'docs/prompts/review-start.md',
  'docs/prompts/ready-report.md',
  // SEED_CORPUS destination
  'docs/adr/0001-adopt-docs-as-code.md',
  // generated by init.mjs on every successful run, never a template (ywr-harness ADR 0042)
  '.harness-version',
])

// Paths that an older scaffold placed and the current one does not. A repo that took the older scaffold
// still tracks them, because init.mjs never deletes a file. They stay claimed, so its partition audit
// does not fail on them. The placement.mjs pairing of SCAFFOLD_CLAIMS does not cover them.
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
// The one gate every repo-supplied token passes before it reaches a printed command: script paths
// (from `.harness.json` and from the docs index) and the changed-file arguments of a file-scoped
// gate. The vendored CI and pre-commit run composed commands with `sh -c`, so a token must survive
// re-splitting byte for byte.
//
// An allowlist, not a blocklist. It excludes whitespace (sh re-splits the token), '#' (both output
// parsers strip a trailing comment), glob characters (the CI runs `sh -c` without `set -f`), ':'
// (drive-absolute) and every shell metacharacter.
//
// Validate each token in the form that reaches argv. Validating the declared string while composing
// the stripped one would let `{"strip_prefix": "src/", "script": "src/-c"}` reach argv as the bare
// flag `-c`. With `files: true` the next token is a changed filename, so `python -c <name>` would
// run that name as source. `as_arg()` also neutralizes a leading dash, because a hostile first
// character in command position is dangerous even when the rest is clean.
//
// The patterns end in `$` with no `m` flag, which matches the very end of the string only. Python's
// `$` also matches before a trailing newline, so `"a.py\n"` would pass there, and a newline can split
// an output line. The choke point must not depend on callers stripping first, so it validates the
// string that becomes the output (ywr-harness fact 36).
// ---------------------------------------------------------------------------------------------
export const SAFE_TOKEN = /^[A-Za-z0-9._/-]+$/

/**
 * True when `tok` can be spliced into a printed command as one inert argument.
 *
 * `..` is refused as a path segment, not as a substring, so a file named `a..b.py` stays gated.
 * `safe_path` refuses the substring, because it guards declaration-time path values.
 * @param {string} tok
 * @returns {boolean}
 */
export function token_ok(tok) {
  return tok.length > 0 && SAFE_TOKEN.test(tok) && !tok.split('/').includes('..') && !tok.startsWith('/')
}

// A changed-file argument passes a wider set than every other command-position value
// (ywr-harness ADR 0112): `( ) [ ]` too, for Next.js route groups and dynamic segments. They are
// shlex-unsafe, so compose() always single-quotes them, which is literal in sh and in pwsh 7. A file
// argument sits after the runner, where no consumer reads a word. The cwd, script paths and runner
// elements stay on `token_ok`, because the CI awk table reads `$1`, `$2` and `$4` unquoted
// (ywr-harness fact 65). Only `unsafe_files()` and the file filter of `gate_command()` read this set. `@` and `+`
// stay out, because they are emitted bare and a leading `@` splats in PowerShell (ywr-harness ADR 0112).
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
// The one gate every repo-supplied value passes before it becomes an output line. It is separate
// from `token_ok`, which guards a command position. This one guards a value that is only reported,
// such as a status label or a refused value echoed to the reader. Reported text is not inert. Both
// output parsers find the gate-command window by line shape in stdout (`^gates:`, `^ {4}[^ (]`,
// `^review tier:`), so a value with a newline prints as several lines, and a declaration can spell
// the window's own start and stop anchors and land a command inside it.
//
// Example: a declared artifact title of `inj\ngates:\n    echo INJECTED\nreview tier: full - x`
// prints `artifact: ok`, so the CI step `^artifact: VIOLATION` passes, while the workflow's own
// extraction (`sed -n '/^gates:/,/^\(ungrouped\|review tier\)/p' | grep -E '^ {4}[^ (]'`) returns
// `echo INJECTED` for `sh -c`. A group name is a second site, echoed as `  [<name>] N file(s)`
// inside the window.
//
// This is the rule of ywr-harness fact 36 one step later: validate the string that becomes the line.
// Callers also refuse a control character at the declaration layer, where a declarer can be told.
// This is the structural layer that holds when they cannot.
// ---------------------------------------------------------------------------------------------
// U+0085 NEL and U+2028/U+2029 are in the class although neither shell parser splits on them
// (sed, grep and awk split on 0x0A only). A line splitter in a script language splits all three, and
// a model reading this output, such as the `run:` lines of /verify, may render them as breaks. One
// value then stays one line under every reader. The three characters are added by code point, so no
// source line holds a raw separator.
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
 * Render repo-supplied text so it occupies one output line. The characters become visible escapes
 * instead of being dropped, so a reader diagnosing a refusal sees what was declared.
 * @param {*} value
 * @returns {string}
 */
export function one_line(value) {
  return _str(value).replace(_CONTROL_G, (m) => _shown(m))
}

/**
 * The single stdout exit for the two consumers whose output has a line-shape contract: the gate
 * emitter, read by the CI and pre-commit window parsers, and the verify mapper, read by a model that
 * runs its `run:` lines. The line ends in LF alone.
 *
 * Escaping per call site misses sites. A forged `gates:` line in the review-tier line (critical-surface
 * filenames) re-arms the range of `sed` after the real window closed. One exit makes a forgotten call
 * site impossible.
 *
 * Multi-line literals write to `process.stdout` directly and sanitize the repo-supplied part
 * themselves. The path is awkward on purpose, so multi-line output is a decision.
 * @param {string} [line]
 */
export function say(line = '') {
  process.stdout.write(one_line(line) + '\n')
}

/**
 * The single stderr exit. No machine parser reads this channel, because CI and the pre-commit hook
 * capture stdout only. It is a human display, though, and a raw ESC sequence in a refused value would
 * repaint the committer's terminal during `git commit`. An escaped value stays legible.
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
 * Validate a script gate `{runner, script, files}` (ywr-harness ADR 0024). The runner is a closed-set
 * choice and the script is a repo-relative path. Both forms are validated, as declared and as composed
 * after the group's `strip_prefix`, because the second becomes argv. It returns null and warns when the
 * gate cannot be composed safely. A refused value is echoed in the warning and never composed. A
 * retired script declaration is replaced by its successor when the root holds it (RETIRED_SCRIPTS),
 * with a warning.
 * @param {Object} raw @param {string} group @param {string} strip_prefix @param {string} root
 * @param {string[]} warns
 * @returns {{runner: string, script: string, files: boolean}|null}
 */
export function script_gate(raw, group, strip_prefix, root, warns) {
  const field = `groups[${group}].gates`
  // An unknown key warns, so a declaration such as `"args": "--fast"` learns that no argument field
  // exists. `//`-prefixed keys are comments, as everywhere in the schema. The sweep runs before the
  // runner and script checks, so a gate dropped for a bad runner still reports its unknown keys.
  // The two warnings together diagnose a typo such as `"runer"`.
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
    // Kept, not dropped. A drop would let a typo read as coverage, while the kept command fails
    // loudly at run time.
    warns.push(`${field}: script-gate path '${script}' does not exist — kept; the emitted ` +
               'command will fail until it does')
  }
  let files = _get(raw, 'files', false)
  if (typeof files !== 'boolean') {
    // A non-empty string is truthy, so the JSON string "false" would invert the intent and append
    // the changed-file list to a script that never asked for one. The default, whole-program, runs
    // the script as if the key were absent.
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
 * The script-gate shape (ywr-harness ADR 0024) minus `files`. A check is always whole-program. Its
 * contract is that of `build_onboarding.mjs`: the default mode is a drift check that exits 1 on drift
 * and writes nothing. It has no strip_prefix and no cwd, because artifact sources are declared
 * root-relative and the check runs from the root.
 *
 * A shape or refusal failure lands in `problems`, and the caller renders it as `artifact: VIOLATION`,
 * which CI fails on. It does not warn and drop like a script gate, because a declared check that
 * quietly stops composing is unenforced coverage that still reads as coverage. A missing script file
 * is only a warning, as for a script gate, because the emitted command fails loudly. A retired script
 * declaration is replaced by its successor when the root holds it (RETIRED_SCRIPTS), with a warning.
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
  // compose() is the one place argv becomes a command string, so its quoting contract covers this site.
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
// become one `docs/customer.artifact.html`, plus `docs/PROJECTS.md` when `projects_md` is set. This
// reader validates the declaration and the builder imports it, because a second copy of the rules
// inside a consumer's builder is out of reach of a canon fix (ywr-harness ADR 0010).
//
// Nothing here reaches a command position. `dir` selects files the builder reads and renders into
// HTML, and every other value is display text or a frontmatter key name. `dir` still passes the path
// allowlist, because a `..` segment would publish files from outside the repo into a customer-facing
// page. Display text is escaped and reported like a group name, because warnings and the builder's
// stderr are line-shaped surfaces.
//
// Three states (the `artifacts.malformed` precedent):
//   cfg.customer is null            key absent or null: the surface is off and nothing is checked
//   cfg.customer.malformed != ""    declared but unusable: the builder must refuse (exit 1) and the
//                                   emitter warns, because a declared surface that quietly stops
//                                   building leaves a committed page stale
//   otherwise                       validated values with defaults filled, plus `declared`, the known
//                                   keys the declarer wrote (non-null), so an explicit "" differs
//                                   from an absent key
// An explicitly empty value ("" or []) is never read as absent: it warns and takes the default.
// The three filenames are the corpus contract, not a key, because each has a role (record file,
// guide, release feed).
// ---------------------------------------------------------------------------------------------
export const CUSTOMER_FILES = ['spec.md', 'user-guide.md', 'release-notes.md']
export const CUSTOMER_KEYS = ['dir', 'title', 'eyebrow', 'description', 'contact', 'required_frontmatter',
  'chip_field', 'chip_suffix', 'group_field', 'groups', 'other_label',
  'unkeyed_label', 'project_field', 'projects_md', 'release_stages', 'panels',
  'default_tab', 'footer_date_label']
// Display defaults are empty here, because the builder owns its UI language and fills them.
// `release_stages` is a parsing contract: the `[TAG]` tokens a release entry may carry, in stage
// order, and the last is the final stage. Its default lives with the validation.
// `panels` is the extension point (ywr-harness ADR 0060): repo-relative `.mjs` modules, each adding one
// top-level tab. The builder imports the module, calls `render_panel(repoRoot)` for the panel's HTML,
// and reads the optional exports `CSS`, `UPDATED` and `TAB_CHIPS`. The module path is a script-gate-class
// value (ywr-harness ADR 0024): a path to code the repo carries, held to the same allowlist, because
// the builder executes the module even though no shell is involved. A module that passes the allowlist
// but is not an `.mjs` file is kept with a warning, and the builder refuses the build.
// Each panel has an `id`, the `#top-<id>` deep link, derived for every kept entry so `default_tab`
// validates against the final set, and a `position`. The block-level `default_tab` and
// `footer_date_label` let a panel avoid editing the canon DOM (ywr-harness ADR 0061).
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
// A tab id is spliced into `data-top`, a CSS class (`panel-<id>`) and a URL fragment, so it is an
// ASCII token. `docs` is the documents tab and is reserved.
export const PANEL_ID = /^[a-z][a-z0-9_-]*$/
// The key shape of parse_frontmatter in build_docs.mjs, a name of [A-Za-z0-9_] before the colon. A
// declared key outside it never matches a parsed key, so it is refused.
export const FM_KEY = /^[A-Za-z0-9_]+$/
export const STAGE_TAG = /^[A-Za-z0-9_-]+$/

/**
 * Repo-supplied display text in one-line form, with control characters escaped and reported (the
 * groups[].name rule: a value that is never raw after load cannot be echoed raw).
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
 * A declared frontmatter key name. An empty value is reported, never read as absent. A silent
 * default here would be the only path in this block that degrades without a warning.
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
  // Defaults are copied one level deeper than the list. `release_stages` holds objects, and a shallow
  // copy would hand every load the module constant's own objects, so one in-place edit would poison
  // every later load.
  const out = Object.fromEntries(Object.entries(CUSTOMER_DEFAULTS).map(([k, v]) =>
    [k, Array.isArray(v) ? v.map((s) => (_is_dict(s) ? { ...s } : s)) : v]))
  out.malformed = ''
  // The known keys the declarer wrote (non-null). The builder fills its own UI default only for keys
  // absent here, so `"title": ""` is a blank and an absent `title` means "use yours".
  out.declared = CUSTOMER_KEYS.filter((k) => _get(raw, k) !== null)
  for (const key of Object.keys(raw)) {
    if (!CUSTOMER_KEYS.includes(key) && !key.startsWith('//')) {
      warns.push(`${field}: unknown key '${one_line(key)}' ignored ` +
                 `(known: ${CUSTOMER_KEYS.join(', ')})`)
    }
  }

  // `dir` is the one path. A refused value makes the declaration malformed and is never defaulted,
  // because a default would build from a directory the declarer did not name. An empty value takes
  // the default and is reported.
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
    // Kept. The builder refuses at build time, and this warning names the path where CI reads it.
    warns.push(`${field}.dir: '${out.dir}' does not exist — the docs build will refuse ` +
               'until the corpus directory is there')
  }

  for (const key of ['title', 'eyebrow', 'description', 'contact', 'chip_suffix',
    'other_label', 'unkeyed_label', 'footer_date_label']) {
    if (_get(raw, key) === null) continue
    if (typeof raw[key] !== 'string') {
      // "Ignored" means the builder's default applies, so the key leaves `declared`.
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
    // A JSON string would read as true and invert the declared intent, as for the script-gate `files`.
    // The default is off.
    warns.push(`${field}.projects_md: must be a JSON boolean (true/false), got ` +
               `'${one_line(_str(pm))}' — treated as false (no PROJECTS.md)`)
    pm = false
  }
  out.projects_md = pm

  const rs = _get(raw, 'release_stages')
  if (Array.isArray(rs)) {
    if (!rs.length) {
      // An empty list is a declaration too. It is reported as empty, not as "every entry was rejected".
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
      // The refusal of a script-gate path applies, because the builder imports this file.
      if (!module || !token_ok(module) || module.startsWith('-')) {
        warns.push(`${pf}: module '${one_line(module)}' refused (a repo-relative path of ` +
                   "[A-Za-z0-9._/-] only, no '..', no leading '/' or '-') — entry ignored")
        return
      }
      if (!module.endsWith('.mjs')) {
        // Kept, as for a missing file. A dropped tab would let the page build without it.
        warns.push(`${pf}: module '${module}' is not an .mjs module — the docs build will ` +
                   'refuse until the panel is an .mjs module exporting render_panel(repoRoot) ' +
                   'and optionally CSS, UPDATED, TAB_CHIPS')
      } else if (!_is_file(path.join(root, module))) {
        // Kept. The builder refuses at build time and names the path.
        warns.push(`${pf}: module '${module}' does not exist — the docs build will ` +
                   'refuse until it does')
      }
      const label = typeof _get(p, 'label') === 'string' && py_strip(p.label)
        ? _display(p.label, `${pf}.label`, warns) : ''
      if (!label) {
        warns.push(`${pf}: needs a non-empty 'label' (the tab text) — entry ignored`)
        return
      }
      // `id` (ywr-harness ADR 0061) is the tab's `#top-<id>` deep link, a published value. A refused or
      // duplicate declared id drops the entry instead of renaming the link the declarer asked for. An
      // absent id is derived from the label slug, else `panel-<n>` over the kept entries, so existing
      // pages keep their ids. A derived slug that collides falls back to `panel-<n>` with a warning.
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
        // Take the first free `panel-<n>`. The kept-entry index alone can land on an id an earlier
        // entry declared, and two tabs would then share one `data-top` and scope class.
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

  // `default_tab` (ywr-harness ADR 0061) validates against the final ids above, so it may name a derived
  // one. The builder's default is the first tab in rendered order, so "" means unset, not the docs tab.
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
 * Walk upward once: the nearest directory holding .harness.json or .git, whichever comes first.
 * It falls back to `start`, so a repo with neither marker works on defaults.
 *
 * One walk, not two. A pass for every ancestor's .harness.json followed by one for .git would attach a
 * nested repository with no declaration, such as a submodule, to the outer repo's declaration and gate
 * its files against the wrong tree. A .git boundary ends the walk, and a .harness.json below the git
 * root still wins.
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
 * One object-valued top-level section. Anything else warns and reads as empty. The type check comes
 * before any falsy fallback, so `"review": []` and `"verify": ""` warn.
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
 * Return `[config, warnings]`. Warnings are returned, never printed here. The caller decides where they
 * go, and a swallowed warning about a refused value would look like a good configuration. A file that
 * is not valid UTF-8 throws an Error named `UnicodeDecodeError`.
 * @param {string} root
 * @returns {[Object, string[]]}
 */
export function load(root) {
  const warns = []
  const cfg = { ...DEFAULTS }
  // An undeclared review canon is CLAUDE.md, a memory file every session loads (ywr-harness ADR 0217).
  // A root REVIEW.md takes its place. No session loads that file by itself, so the canon line names it
  // and asks for its import.
  if (_is_file(path.join(root, 'REVIEW.md'))) cfg.review_canon = 'REVIEW.md'
  cfg.groups = []
  cfg.review = { docs_only: [], harness_layer: [], critical: [], derived: [] }
  // Retro surfaces are free-string regexes like `review`. They cannot name an executable, so the
  // closed-set rule of `gates` does not apply.
  cfg.retro = { source_scope: [], dep_manifests: [], migrations: [] }
  // Declared claude.ai Artifacts (ywr-harness ADR 0032). The gate emitter checks them: the README
  // carries each declared url, and each declared title starts with the repo name. Items stay raw, so
  // a malformed entry fails the check loudly instead of vanishing at load time. `malformed` carries a
  // section-level shape error for the same reason.
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

  // Derived-copy mappings (ywr-harness ADR 0037) are path prefixes, not regexes. The copy-to-source
  // mapping is a prefix swap, so each prefix ends with '/', or a bare prefix could match a sibling
  // directory mid-segment, and passes the token allowlist. A mapping never reaches a command position,
  // because the emitter only reads bytes at the mapped paths. A traversal segment is still refused,
  // because the mapped path opens relative to the root.
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
    // The name is a label that the emitter echoes as `  [<name>] N file(s)`, a line inside the
    // gate-command window both output parsers execute from. It is sanitized here once, so every later
    // use (field labels, grouping key, printed label) holds the safe form. A control character is
    // reported.
    const name = one_line(_str(g.name))
    if (has_control(_str(g.name))) {
      warns.push(`groups[${i}]: control character(s) in the group name were escaped for ` +
                 `display ('${name}') — a group name is echoed inside the gate-command ` +
                 'window, so a raw newline there would forge a gate command')
    }
    // Resolved before the gates, because a script gate validates against the form it composes to
    // under this prefix.
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
 * null for a binary file, by git's own test. It reads in chunks, so a large file costs time, not
 * memory. The gate emitter and the retro share this count, and each caller decides what a symlink,
 * a directory or a missing file means. It throws an Error named for the OS error class
 * (`FileNotFoundError`, `PermissionError`, ...) when the path cannot be read.
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
// Scope resolution lives here, not in a consumer. /verify and the gate emitter must answer "which
// files is this slice" the same way, or a slice could pass one gate on a different file set than the
// other saw. The git boundary (`git_run`, `git_lines`, `git_paths`, `GIT_PINS`) is in harness_git.mjs
// and re-exported above (ywr-harness ADR 0223).
// ---------------------------------------------------------------------------------------------
const _normcase = (s) => (process.platform === 'win32' ? s.replaceAll('/', '\\').toLowerCase() : s)

// Absolute on Windows means a drive or UNC path only, never a bare `\x`. Elsewhere it means a leading '/'.
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
 * Return `[files, provenance]`. The caller reports the provenance, because a range that matches
 * nothing while the working tree supplies the files is a vacuous pass.
 *
 * `all_files` is the full-tree audit scope (ywr-harness ADR 0041): git ls-files plus untracked. CI
 * push runs use it, because their worktree is a fresh checkout where every diff-shaped scope is empty.
 * Partition and gate coverage are tree properties there.
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
  // The current state always counts: staged and unstaged against HEAD, plus untracked files, which
  // `git diff` never lists.
  let worktree
  try {
    worktree = git_paths(root, ['diff', '--name-only', 'HEAD'])
  } catch (e) {
    if (e.name !== 'CalledProcessError') throw e
    // An unborn HEAD, a repo before its first commit, is a normal state and not the fail-loud class
    // of ywr-harness ADR 0041 (force-pushed base, stale fetch). Escalating it would fire
    // `scope: FAILED` on `git init && git add`. With HEAD absent, the worktree scope is staged (index
    // against the empty tree) plus unstaged (index against worktree), and git answers both without
    // HEAD. Any other diff failure re-raises. The probe reads the exit code only.
    const probe = git_result(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (probe.status === 0) throw e
    worktree = _sorted(new Set([...git_paths(root, ['diff', '--name-only', '--cached']),
      ...git_paths(root, ['diff', '--name-only'])]))
    prov.unborn_head = true
  }
  const untracked = git_paths(root, ['ls-files', '--others', '--exclude-standard'])
  prov.worktree_files = worktree.length
  prov.untracked_files = untracked.length
  // The emitter's line measure reads the untracked files, and `git diff --numstat` never lists them.
  // The list travels here so the measure starts no second ls-files.
  prov.untracked = untracked
  for (const f of worktree) files.add(f)
  for (const f of untracked) files.add(f)
  return [_sorted(files), prov]
}

/**
 * Return `[tree, head]`: the working tree as one git tree id, and HEAD's commit id ("none" when
 * HEAD is unborn). This pair is the prepared-close identity (ywr-harness ADR 0105). A session that ran
 * the gates, the review and verify reports it, and the owner-typed `/ywr-harness:slice-close` reuses
 * those results only while a fresh snapshot prints the same pair. When it differs, `git diff
 * --name-only <old-tree> <new-tree>` names what changed.
 *
 * The tree is the worktree in its staged form: tracked content plus untracked, non-ignored files,
 * after clean filters and eol normalization, a submodule by its commit only. It is taken through a
 * copy of the index, so the real index, refs and worktree are never touched. The copy keeps the
 * index's mtime, because git re-hashes a racily clean entry by comparing with the index file's own
 * mtime, and a fresh one would trust stat data the real index would not. The copy's mtime is one
 * microsecond below the original, because Node sets a time from floating-point seconds, which cannot
 * hold a nanosecond count. A rounding error then makes git re-hash one entry more and never trust a
 * stale one. The copy's assume-unchanged and skip-worktree bits are cleared first, one `update-index`
 * call per bit, because one call with both clears only one (git 2.53). `add -A` never looks at a
 * flagged entry, so an edit to one would leave the id unchanged while the gates read the new bytes.
 * The `-c` pins keep `core.ignoreStat` from setting those bits again and keep an fsmonitor or split
 * index out. It writes unreferenced blob and tree objects, which `git gc` prunes like any `git stash
 * create`, plus whatever a clean filter stores, such as the git-lfs object store. Every git failure
 * throws, the caller prints the loud marker, and nothing is reused.
 * @param {string} root
 * @returns {[string, string]}
 */
export function worktree_snapshot(root) {
  let head
  try {
    head = py_strip(git_run(root, ['rev-parse', '--verify', '--quiet', 'HEAD']))
  } catch (e) {
    if (e.name !== 'CalledProcessError') throw e
    // Unborn is the one failure that means "none": HEAD names a branch with no ref yet. A corrupt ref
    // or a detached HEAD that git cannot resolve stays loud.
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
 * One line naming where the file list came from. It is the only thing that tells an empty-range run
 * from a covered-range run.
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
 * `cd <cwd> && <cmd>`, or the command alone. `cwd` reaches a command position too, so it passes the
 * same token gate. `safe_path` alone permits a space, `#` or `*`, which `sh -c` or an output parser
 * would reinterpret. A refused cwd runs from the repo root, which fails loudly on the stripped paths
 * instead of running something else.
 *
 * `warns` is threaded as in `gate_command`. This second-layer refusal is unreachable through `load()`,
 * because `safe_cwd` already scrubbed the value, and a drop with no warns channel would be silent after
 * a refactor.
 *
 * Every argv element is shell-quoted (`shlex_quote`), so one element reaches `sh -c` as one argument.
 * The closed set carries an element with a space, `-m "not db"` of `pytest-nondb`, and a plain
 * space-join would deliver `-m not db`, which pytest reads as a path. An element made only of
 * SAFE_TOKEN characters comes out unquoted, so every other command's bytes are unchanged. The
 * ywr-harness canon's harness_gates.selftest.mjs (case AD) pins the round trip over every GATES and
 * RUNNERS entry: a shell split of `compose(cmd, cwd)` gives back the argv.
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
 * The script path comes from the docs index, which is generated from spec frontmatter, so it is
 * repo-supplied text like a `.harness.json` value. It passes the same token gate, checked on the form
 * after `strip_prefix` that becomes argv. A refused path yields a parenthetical that is not a command
 * and does not repeat the value. The value belongs in the warning, never in a command position
 * (ywr-harness ADR 0012).
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
 * True when the gate takes the changed-file list, false for whole-program. One reader serves both
 * gate forms, so the emitter never branches on shape.
 * @param {string|{files: boolean}} gate @returns {boolean}
 */
export function gate_is_scoped(gate) {
  return _truthy(typeof gate === 'string' ? _idx(_idx(GATES, gate), 'files') : _idx(gate, 'files'))
}

/**
 * Changed files that cannot be passed to a gate command as arguments, in their form after
 * `strip_prefix`. The caller reports them, so the coverage loss is stated. A filename is repo-supplied
 * text too: `sh -c` would re-split one with a space, and both output parsers truncate one with '#'.
 * `( ) [ ]` are admitted (ywr-harness ADR 0112, `file_arg_ok`).
 * @param {{strip_prefix: string}} group @param {string[]} files @returns {string[]}
 */
export function unsafe_files(group, files) {
  return _sorted(files.filter((f) => !file_arg_ok(strip_group_prefix(f, group.strip_prefix))))
}

/**
 * Changed files no longer in the working tree: a deletion in a range or worktree scope. A file-scoped
 * gate is never handed one (ywr-harness ADR 0112). A deleted plain path fails eslint, prettier and
 * ruff with nothing to check, and eslint and prettier read a deleted `[id]` path as a glob that checks
 * a sibling (`i/`, `d/`) and passes. It uses `lexists`, so a symlink or a submodule path is still passed.
 * @param {string} root @param {string[]} files @returns {string[]}
 */
export function absent_files(root, files) {
  return _sorted(files.filter((f) => !_lexists(path.join(root, f))))
}

/**
 * Compose one gate command. `gate` is a closed-set selector string or a validated script-gate
 * object from `script_gate()`. A raw object from JSON never reaches here.
 *
 * Every path token is re-checked here although `load()` validated the declaration. The duplication is
 * deliberate, because this is the last point before a string becomes a command.
 *
 * `warns` is threaded as in `verify_command`. The refusal below is unreachable through `load()`,
 * which derives `strip_prefix` from the same group object. The channel keeps the second layer honest
 * if a future caller makes it fire, because a branch that says "see warning" and writes to no warning
 * list is a silent drop.
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
    // As in verify_command, `strip_prefix` applies to the script path, so a group that runs from
    // `cwd` addresses its script as it addresses its files.
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
      // A bare command is worse than none. A file-scoped gate with no file list runs on the whole
      // tree (`ruff check` lints everything), so a group whose every filename was excluded would
      // escalate its own scope.
      return "(skipped — none of this group's changed files can be a command argument)"
    }
    parts.push(...rel.map(as_arg))
  }
  return compose(parts, group.cwd, w)
}
