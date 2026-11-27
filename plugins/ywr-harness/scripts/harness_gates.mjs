// Changed files to deterministic gate commands and a review-tier verdict. Backend for /ywr-harness:slice-close.
//
// Advisory: nothing runs, and it exits 0 with one exception. When the changed-file scope cannot be resolved
// (a git failure), it prints a stdout `scope: FAILED` marker and exits non-zero (ywr-harness ADR 0041).
// An empty advisory output reads as a pass to CI, which greps this stdout, so an unknown scope fails loudly.
// It prints the commands that a slice close runs before any LLM review, and the review tier that the files earn.
// It checks each declared claude.ai Artifact against the README: link present, title starts with the repo
// name (ywr-harness ADR 0032). The emitter only reports, and the vendored CI fails on `artifact: VIOLATION`.
// After the tier it reports each declared group whose `match` claims a path that the repo's `.gitignore`
// excludes (`ignored-tree claims:`, ywr-harness ADR 0077). Report only; CI does not fail on it.
//
// Usage:
//   node harness_gates.mjs                       # working tree vs HEAD + untracked
//   node harness_gates.mjs --range main~3..HEAD  # slice range UNIONED with the working tree
//   node harness_gates.mjs path/to/file [...]    # explicit files
//   node harness_gates.mjs --all                 # full-tree audit: ls-files + untracked (ywr-harness ADR 0041)
//   node harness_gates.mjs --tree                # prepared-close identity: `tree: <id> · HEAD <id>` (ywr-harness ADR 0105)
//   node harness_gates.mjs --repo <dir>
//
// The gate commands and the tier come from `.harness.json` via harness_config. A repo declares which stack and
// which surfaces it has, never what command runs. Adding a stack changes the closed `GATES` set in the
// ywr-harness plugin (ywr-harness ADR 0012). A repo's own script is a script gate: a closed-set runner and a
// validated repo-relative path (ywr-harness ADR 0024), so the executable is never a repo-supplied string.
// The tier is computed here, never judged in prose, and it prints with the inputs that earned it, so a
// reader can audit and correct a wrong tier (ywr-harness ADR 0013).
//
// ESM, Node built-ins only, synchronous. `main(argv)` returns the exit code and never calls `process.exit`,
// because a piped stdout can be cut by an exit that follows a write. The entry guard at the bottom sets
// `process.exitCode`. Repo-supplied text reaches stdout only through `hc.say`, the one exit that keeps every
// printed line one line (see harness_config.mjs `say`).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as hc from './harness_config.mjs'

const { py_strip } = hc

// Small-tier thresholds. A slice may be small by both measures and still be `full` if it touches
// a declared critical surface. Size never overrides criticality.
export const SMALL_MAX_FILES = 5
export const SMALL_MAX_LINES = 150

// The one file whose schema the harness itself owns (ywr-harness ADR 0038). The safe keys feed reporting only.
// Every other key reaches command composition, tier or gate coverage, so a change to one is critical in every
// repo, and the declaration cannot opt itself out.
// `artifacts` is not a safe key: `items[].check` composes a command that the CI runs, so an artifacts edit is
// critical (ywr-harness ADR 0068), even for a URL or title typo.
export const DECL_FILE = '.harness.json'
export const DECL_SAFE_KEYS = new Set(['docs', 'handoff'])
// Sub-paths of a safe key that reach code execution, reported as their own dotted key so the safe-set test
// fails on them (ywr-harness ADR 0110). `docs.customer.panels[].module` names a .mjs file that the docs builder
// imports (ywr-harness ADR 0060), and CI runs that build.
export const DECL_UNSAFE_SUBPATHS = [['docs', 'customer', 'panels']]

// ---------------------------------------------------------------------------------------------
// Small helpers for the error types a caller branches on. The base reader tags a failed git call
// `CalledProcessError` and a filesystem or spawn failure with a Node `code` and, where it can, a
// Python-style name. Both count as "the operation failed" here. Anything else is a bug and rethrows.
// ---------------------------------------------------------------------------------------------
const _OS_NAMES = new Set(['OSError', 'FileNotFoundError', 'PermissionError', 'NotADirectoryError',
  'IsADirectoryError', 'FileExistsError'])

function is_os_error(e) {
  return Boolean(e) && (typeof e.code === 'string' || _OS_NAMES.has(e.name))
}

function is_git_failure(e) {
  return Boolean(e) && e.name === 'CalledProcessError'
}

function _stat(p) {
  try { return fs.statSync(p) } catch { return null }
}

function _is_file(p) {
  const st = _stat(p)
  return st !== null && st.isFile()
}

function _is_dir(p) {
  const st = _stat(p)
  return st !== null && st.isDirectory()
}

/** `Path.resolve()`: symlinks resolved, a missing tail kept as given. */
function _resolve(p) {
  let cur = path.resolve(p)
  const tail = []
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur)
      return tail.length ? path.join(real, ...[...tail].reverse()) : real
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return path.resolve(p)
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

function _dig(v, keys) {
  for (const k of keys) {
    if (!hc._is_dict(v)) return null
    v = hc._get(v, k)
  }
  return v
}

/** Recursively remove '//'-prefixed keys, the schema's comment convention. A comment edit is prose,
 * not a declaration change, and must compare equal. */
function _drop_comment_keys(v) {
  if (hc._is_dict(v)) {
    return Object.fromEntries(Object.entries(v)
      .filter(([k]) => !k.startsWith('//'))
      .map(([k, x]) => [k, _drop_comment_keys(x)]))
  }
  if (Array.isArray(v)) return v.map(_drop_comment_keys)
  return v
}

// `==` between two JSON values the way Python reads it: `true == 1`, key order never matters.
function _py_eq(a, b) {
  const num = (x) => (typeof x === 'boolean' ? Number(x) : x)
  const isnum = (x) => typeof x === 'number' || typeof x === 'boolean'
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined)
  }
  if (isnum(a) && isnum(b)) return num(a) === num(b)
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => _py_eq(x, b[i]))
  }
  if (hc._is_dict(a)) {
    if (!hc._is_dict(b)) return false
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => hc._has(b, k) && _py_eq(a[k], b[k]))
  }
  return a === b
}

const _STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Top-level declaration keys whose comment-stripped values differ between the diff base and
 * the working tree (plus the dotted name of any changed DECL_UNSAFE_SUBPATHS entry), or null
 * when that cannot be determined. The caller treats unknown as critical, never as safe: a newly
 * added declaration and an unparseable side both land here.
 * The base is the left side of --range when given, else HEAD. A three-dot range uses the left rev
 * as-is, which for A...B can only over-approximate the change set.
 * Decoded as UTF-8 explicitly: a declaration with non-ASCII text (artifact titles) must not
 * fail or mis-compare under a console codepage.
 * @param {string} root @param {string|null} rev_range @returns {string[]|null} */
export function decl_changed_keys(root, rev_range) {
  let base = 'HEAD'
  if (rev_range) {
    const left = py_strip(rev_range.split(/\.\.\.?/)[0])
    if (left) base = left
  }
  let old
  let cur
  try {
    // Through the pinned git boundary (hc.git_run: bytes pipe, explicit UTF-8 decode). A non-UTF-8
    // byte arrives backslash-escaped and fails JSON.parse, which is undeterminable and so critical.
    old = JSON.parse(hc.git_run(root, ['show', `${base}:${DECL_FILE}`]))
    cur = JSON.parse(_STRICT_UTF8.decode(fs.readFileSync(path.join(root, DECL_FILE))))
  } catch (e) {
    // SyntaxError covers a malformed document, TypeError a strict-decode refusal.
    if (e instanceof SyntaxError || e instanceof TypeError || is_os_error(e) || is_git_failure(e)) return null
    throw e
  }
  old = _drop_comment_keys(old)
  cur = _drop_comment_keys(cur)
  if (!hc._is_dict(old) || !hc._is_dict(cur)) return null
  const names = new Set([...Object.keys(old), ...Object.keys(cur)])
  const keys = hc._sorted([...names].filter((k) => !_py_eq(hc._get(old, k), hc._get(cur, k))))
  const dotted = DECL_UNSAFE_SUBPATHS
    .filter((sub) => keys.includes(sub[0]) && !_py_eq(_dig(old, sub), _dig(cur, sub)))
    .map((sub) => sub.join('.'))
  keys.push(...dotted)
  return keys
}

/** The added-line count `git diff --numstat` prints for `p` as a new file, or null for a
 * binary, which numstat prints as `-` and the measure skips. A symlink is one line (its target).
 * A directory, an untracked nested repository, is one line, like a gitlink. `.gitattributes` is
 * not read: a text file marked `binary` or `-diff` there counts its lines, which errs toward the
 * larger tier. The count itself is `hc.text_lines`. Throws an Error that carries a filesystem
 * `code` when the path cannot be read.
 * @param {string} p @returns {number|null} */
export function added_lines(p) {
  let st = null
  try { st = fs.lstatSync(p) } catch { /* absent: text_lines raises the error */ }
  if (st && (st.isSymbolicLink() || st.isDirectory())) return 1
  return hc.text_lines(p)
}

/** [total, counted] added+deleted across the range, the working tree and the `untracked`
 * files of the scope. `counted` excludes paths that `is_exempt` marks as declared docs-only
 * surfaces (ywr-harness ADR 0035), so files with no executable meaning do not inflate the size measure.
 *
 * `git diff` never lists an untracked file, and a slice closes with its new files untracked, so
 * each one would weigh 0 lines, which treats unknown as 0. `untracked` is the list that
 * `hc.changed_files` already ran for the scope, so `added_lines` counts those files with no second
 * git process. A path that cannot be read makes the whole measure unknown.
 *
 * The caller's `is_exempt` must decide by membership in a set built from the same name-only listing
 * that classified the review scope, never by matching patterns against the raw numstat text.
 * A rename record prints as `old => new`, so a `^docs/`-anchored pattern would match the old name's
 * prefix and exempt what is now a code file. A numstat record that is not a listed clean path
 * (a rename record, a quoted path) therefore counts, because unknown is not weightless.
 * The result is null when the diff cannot be measured, reported as unknown rather than assumed
 * small, because an unknown treated as 0 would silently downgrade every tier.
 * @param {string} root @param {string|null} rev_range
 * @param {((p: string) => boolean)|null} [is_exempt] @param {string[]} [untracked]
 * @returns {[number, number]|null} */
export function changed_lines(root, rev_range, is_exempt = null, untracked = []) {
  let total = 0
  let counted = 0
  let got = false
  const argvs = (rev_range ? [['diff', '--numstat', rev_range]] : []).concat([['diff', '--numstat', 'HEAD']])
  for (const args of argvs) {
    let lines
    try {
      lines = hc.git_lines(root, args)
    } catch (e) {
      if (is_git_failure(e)) return null
      throw e
    }
    for (const line of lines) {
      const parts = line.split('\t')
      if (parts.length >= 2 && /^[0-9]+$/.test(parts[0]) && /^[0-9]+$/.test(parts[1])) {
        const n = Number(parts[0]) + Number(parts[1])
        total += n
        const p = parts.length >= 3 ? parts[2] : ''
        if (!(is_exempt && p && is_exempt(p))) counted += n
        got = true
      }
    }
  }
  for (const rel of untracked) {
    let n
    try {
      n = added_lines(path.join(root, rel))
    } catch (e) {
      if (is_os_error(e)) return null
      throw e
    }
    if (n === null) continue
    total += n
    if (!(is_exempt && is_exempt(rel))) counted += n
    got = true
  }
  return got ? [total, counted] : [0, 0]
}

/** POSIX only: the scaffold hooks under `.githooks/` that this checkout holds non-executable.
 * Git runs hooks from the working tree and silently skips one without the bit. Empty string when
 * nothing is wrong or the question does not apply (Windows git invokes hooks through sh regardless
 * of the mode). The committed mode travels with the repo, so a Windows-scaffolded repo (index mode
 * 100644, ywr-harness ADR 0056) surfaces here on every POSIX clone, CI's ubuntu checkout included.
 * Filenames printed are constants from the scaffold's own set, never repo-supplied text.
 * @param {string} root @returns {string} */
export function exec_bit_gap(root) {
  if (process.platform === 'win32') return ''
  const bad = ['pre-commit', 'pre-push', 'post-commit'].filter((h) => {
    const p = path.join(root, '.githooks', h)
    if (!_is_file(p)) return false
    try { fs.accessSync(p, fs.constants.X_OK); return false } catch { return true }
  })
  if (!bad.length) return ''
  return '\n       ' + `${bad.length} hook(s) NOT executable (${bad.join(', ')}) — git silently ` +
    'skips them in this clone (ywr-harness ADR 0056)\n' +
    '       run: chmod +x .githooks/*   (this clone) and commit the mode for every ' +
    'future clone: git update-index --chmod=+x .githooks/*'
}

/** True when the clone's `core.hooksPath` value names `root/rel`, whatever form it was written in.
 * `git config core.hooksPath .githooks` is the scaffold's spelling, but a hand-wired clone may hold
 * `./.githooks`, an absolute path (`C:\...\.githooks`, `/home/.../.githooks`), or, from Git Bash on
 * Windows, the MSYS form `/c/.../.githooks`, which git for Windows honours but no Node path API does.
 * A literal string compare would report each of those as "the harness hooks do not run in this clone"
 * while they run. Git resolves a relative value against the top level of the work tree, so that is the
 * base here. Git expands the `~/`, `~user/` and `%(prefix)/` forms itself before this runs, because the
 * caller reads the value with `git config --path`, the same expansion that the hook runner applies;
 * `--get` alone returns them raw. Both OS-specific rewrites are Windows-only, because a POSIX name may
 * contain a backslash or start `/c/`.
 * @param {string} root @param {string} cur @param {string} rel @returns {boolean} */
function _hooks_path_is(root, cur, rel) {
  if (process.platform === 'win32') {
    const m = /^\/([A-Za-z])\/([^\n]*)$/.exec(cur)
    if (m) cur = `${m[1]}:/${m[2]}`
    cur = cur.replaceAll('\\', '/')
  }
  try {
    const a = _resolve(path.resolve(root, cur))
    const b = _resolve(path.join(root, rel))
    // Windows paths compare without regard to case.
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return false
  }
}

/** One line on whether this clone has the scaffolded git hooks wired, or null when the repo has
 * no `.githooks/` to wire.
 *
 * `core.hooksPath` lives in `.git/config`, which is per-clone and never committed (ywr-harness ADR 0015).
 * A repo can carry `.githooks/` in its tree while a given clone runs none of it, and an unwired clone
 * looks like a wired one. The scaffold cannot reach a machine it never ran on, but this line prints on
 * every /ywr-harness:slice-close and every CI run.
 * The executable bit is the second per-checkout axis of the same gap (ywr-harness ADR 0056). `exec_bit_gap`
 * appends it on the unset and wired branches. The foreign-hooksPath branch omits it, because git does not
 * consult `.githooks/` there and a chmod suggestion would fix nothing.
 * @param {string} root @returns {string|null} */
export function hooks_status(root) {
  if (!_is_dir(path.join(root, '.githooks'))) return null
  // `--show-scope` names the scope that wins. A core.hooksPath set at the worktree scope
  // (`extensions.worktreeConfig`) outranks `.git/config`, so the `--local` read below alone
  // would call a clone wired while git runs hooks from elsewhere. The output is
  // `<scope>\t<value>`, or nothing and exit 1 when the key is unset at every scope.
  // Not through hc.git_run: exit 1 means the key is unset at that scope, a normal state read from the
  // exit code. Both reads use hc.git_result, the boundary's non-throwing form (ywr-harness spec 0007 §3.1).
  let scoped
  let out
  try {
    scoped = hc.git_result(root, ['config', '--show-scope', '--path', '--get', 'core.hooksPath'])
    out = hc.git_result(root, ['config', '--local', '--path', '--get', 'core.hooksPath'])
  } catch (e) {
    if (is_os_error(e)) return '.githooks/ present, but git could not be run here — wiring unknown'
    throw e
  }
  if (scoped.status === 0 && py_strip(scoped.stdout)) {
    const last = hc.splitlines(py_strip(scoped.stdout)).at(-1)
    const tab = last.indexOf('\t')
    const scope = tab < 0 ? last : last.slice(0, tab)
    const value = tab < 0 ? '' : last.slice(tab + 1)
    if (py_strip(scope) === 'worktree' && py_strip(value)) {
      if (_hooks_path_is(root, py_strip(value), '.githooks')) {
        return '.githooks/ wired (core.hooksPath at worktree scope)' + exec_bit_gap(root)
      }
      return `.githooks/ present but core.hooksPath at WORKTREE scope points at ` +
        `'${hc.one_line(py_strip(value))}' — it outranks the local value; the harness hooks ` +
        'do not run in this worktree'
    }
  }
  const cur = py_strip(out.stdout || '')
  if (out.status !== 0 || !cur) {
    return '.githooks/ present but core.hooksPath is UNSET — NO git hook runs in this clone\n' +
      '       run: git config core.hooksPath .githooks' + exec_bit_gap(root)
  }
  if (_hooks_path_is(root, cur, '.githooks')) return '.githooks/ wired (core.hooksPath)' + exec_bit_gap(root)
  // `cur` comes from the clone's own `.git/config`. The unset branch above returns a two-line string,
  // so the status line cannot go through `hc.say()`. The repo-supplied part is sanitized here instead.
  return `.githooks/ present but core.hooksPath points at '${hc.one_line(cur)}' — the harness ` +
    'hooks do not run in this clone'
}

// Case-insensitive hex on purpose: an uppercase artifact id must not fail as "not an artifact URL".
// `$` without the `m` flag matches the very end of the string only. A `$` that also matches before a
// trailing newline would pass `<url>\n`, and a newline can split an output line.
// Both link forms the platform issues are accepted (ywr-harness ADR 0104): the Artifact tool's listing
// returns `claude.ai/artifact/<id>` (a 22-character alphanumeric id), and the tool reads and publishes to
// both that and `claude.ai/code/artifact/<uuid>`.
export const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/artifact\/[0-9A-Fa-f-]+|artifact\/[0-9A-Za-z_-]+)$/

/** [name, source]. The origin remote's basename when one exists, because a local clone can be
 * renamed and the remote survives it, else the work-tree directory name. The source is always
 * reported, so a title judged against an unexpected name is diagnosable from the output alone.
 * @param {string} root @returns {[string, string]} */
export function repo_name(root) {
  try {
    // Through the pinned git boundary: the decode is explicit UTF-8, never the console codepage.
    // No origin gives exit 2 and the fallback.
    const url = hc.git_run(root, ['remote', 'get-url', 'origin'])
    let tail = py_strip(url).replaceAll('\\', '/').replace(/\/+$/, '').split(/[/:]/).at(-1)
    tail = tail.endsWith('.git') ? tail.slice(0, -4) : tail
    if (tail) return [tail, 'origin remote']
  } catch (e) {
    if (!(is_os_error(e) || is_git_failure(e))) throw e
  }
  return [path.basename(root), 'directory name']
}

/** True when `title` starts with `name` at a non-alphanumeric boundary, case-insensitively.
 * The convention is `<repo> · <purpose>`: a bare startswith would bless 'awsome docs' for a
 * repo named 'aws', and a case-sensitive one would block a legitimate 'AWS · …'.
 * @param {string} title @param {string} name @returns {boolean} */
export function title_has_prefix(title, name) {
  const t = py_strip(title)
  if (!t.toLowerCase().startsWith(name.toLowerCase())) return false
  // The boundary character is read by code point, at the offset the name occupies in `t`.
  const rest = [...t].slice([...name].length)
  return !(rest.length > 0 && /^[\p{L}\p{N}]$/u.test(rest[0]))
}

/** [`artifact:` lines, validated drift-check commands]. One line per declared item
 * (ywr-harness ADR 0032), `ok` or `VIOLATION`, or the `none declared` report. The vendored CI fails on
 * `^artifact: VIOLATION`, and the emitter itself stays advisory. Violations are also appended to
 * `warns`: CI's fail step reads stdout, and the pre-commit hook shows stderr to a human.
 * A malformed declaration is a VIOLATION, never a drop, because a typo that silently disabled
 * enforcement would read as coverage.
 *
 * Two per-item keys beyond `url` and `title` (ywr-harness ADR 0068). `source` (the committed Artifact
 * source file) is a completeness check: the path must be allowlist-clean and exist. `check`
 * ({runner, script}, validated by `hc.artifact_check`) composes one whole-program command per valid item.
 * The caller emits it inside the `gates:` window: CI's extraction runs it, pre-commit's `# whole-program`
 * rule defers it, and the window's `seen` set dedupes it against an identical group gate.
 * A check on a VIOLATING item is never returned, because half-validated enforcement would read as enforcement.
 *
 * The lines are returned, not printed. `hc.say()` is the single stdout exit that keeps one line per line,
 * so nothing here needs to escape. That guarantee is required: the echoed values are repo-supplied, and
 * one carrying a newline would forge the `gates:` to `review tier:` window that both output parsers
 * execute from (see `say`).
 * @param {string} root @param {Object} cfg @param {string[]} warns
 * @returns {[string[], string[]]} */
export function artifact_status(root, cfg, warns) {
  const arts = cfg.artifacts
  if (arts.malformed) {
    warns.push('artifacts: declaration malformed — CI fails on this (ywr-harness ADR 0032)')
    return [[`artifact: VIOLATION — .harness.json artifacts is malformed (${arts.malformed})`], []]
  }
  const items = arts.items
  if (!items.length) {
    return [['artifact: none declared — README link check disabled (a repo with a claude.ai ' +
      'Artifact declares it under "artifacts" in .harness.json)'], []]
  }
  const [name, source] = repo_name(root)
  const readme = arts.readme
  let text
  try {
    // Buffer decoding keeps a byte-order mark and replaces an invalid sequence, as a lenient read does.
    text = fs.readFileSync(path.join(root, readme)).toString('utf8')
  } catch (e) {
    if (!is_os_error(e)) throw e
    text = null
  }
  const lines = []
  const checks = []
  let bad = 0
  items.forEach((it, i) => {
    if (!hc._is_dict(it)) {
      lines.push(`artifact: VIOLATION — items[${i}] is not an object with 'url' and 'title'`)
      bad++
      return
    }
    for (const key of Object.keys(it)) {
      if (!['url', 'title', 'source', 'check'].includes(key) && !key.startsWith('//')) {
        warns.push(`artifacts.items[${i}]: unknown key '${key}' ignored ` +
                   '(known: url, title, source, check)')
      }
    }
    const url = hc._str(hc._or(hc._get(it, 'url'), ''))
    const title = hc._str(hc._or(hc._get(it, 'title'), ''))
    const problems = []
    // A control character is refused at the declaration layer too, not only escaped for display.
    // A declaration with a newline is a typo or an attempt to forge an output line, and both
    // get a report instead of a quiet render as `\n`.
    if (hc.has_control(url) || hc.has_control(title)) {
      problems.push('url/title contains a control character (newline, tab, …) — remove it; ' +
                    'a declared value is echoed on ONE status line')
    }
    if (!ARTIFACT_URL.test(url)) {
      problems.push('url is not a claude.ai Artifact URL ' +
                    '(want https://claude.ai/artifact/<id> or ' +
                    'https://claude.ai/code/artifact/<id>)')
    }
    if (!py_strip(title)) {
      problems.push('title missing')
    } else if (!title_has_prefix(title, name)) {
      problems.push(`title does not start with repo name '${name}' (from ${source}) — ` +
                    'convention: <repo> · <purpose>')
    }
    if (text === null) {
      problems.push(`README '${readme}' cannot be read, so the link cannot be verified`)
    } else if (ARTIFACT_URL.test(url) && !text.includes(url)) {
      problems.push(`${readme} does not contain the declared URL — add the link`)
    }
    // Committed source and drift check (ywr-harness ADR 0068).
    // The name is `src` because `source` above is the repo-name provenance from repo_name().
    let src = hc._get(it, 'source')
    const check = hc._get(it, 'check')
    const extras = []
    let src_ok = false
    if (src !== null) {
      src = hc._str(src)
      if (!hc.token_ok(src) || src.startsWith('-')) {
        problems.push(`source '${hc.one_line(src)}' refused (a repo-relative path of ` +
                      "[A-Za-z0-9._/-] only, no '..', no leading '/' or '-')")
      } else if (!_is_file(path.join(root, src))) {
        problems.push(`declared source '${src}' is not a file in the tree — the ` +
                      'committed Artifact source is exactly what this key asserts ' +
                      '(ywr-harness ADR 0068)')
      } else {
        src_ok = true
        extras.push(`source ${src} committed`)
      }
    }
    let cmd = ''
    if (check !== null) {
      if (src === null) {
        problems.push('check declared without source — a drift check needs the ' +
                      'committed file it guards (ywr-harness ADR 0068)')
      } else if (!hc._is_dict(check)) {
        problems.push('check must be an object {runner, script} (ywr-harness ADR 0068)')
      } else {
        cmd = hc.artifact_check(check, `artifacts.items[${i}].check`, problems, warns, root)
        if (cmd) extras.push('check declared — emitted under gates: as whole-program')
      }
    } else if (src_ok) {
      extras.push('no check declared — drift between this source and its generator ' +
                  'is unenforced')
    } else if (src === null) {
      // A url+title-only item (ywr-harness ADR 0032) is legal, but a bare ok line would match none of
      // the artifact-publish skill's step-1 shapes. This line names the shape, hand-published with
      // nothing committed to republish from, and must agree with the skill's taxonomy.
      extras.push('no source declared — hand-published page (ywr-harness ADR 0032 shape); not ' +
                  'publishable via /ywr-harness:artifact-publish')
    }
    if (problems.length) {
      const label = py_strip(title) ? `'${title}'` : (url || `items[${i}]`)
      lines.push(`artifact: VIOLATION — ${label}: ` + problems.join('; '))
      bad++
    } else {
      if (cmd) checks.push(cmd)
      const tail = extras.length ? ' · ' + extras.join(' · ') : ''
      lines.push(`artifact: ok — ${readme} links ${url} · title '${title}' starts with ` +
                 `repo name '${name}' (from ${source})` + tail)
    }
  })
  if (bad) {
    warns.push(`artifacts: ${bad} declared item(s) violate the README-link/title/source ` +
               'rule — CI fails on these (ywr-harness ADR 0032/0068)')
  }
  return [lines, checks]
}

/** Each pattern compiled once, so a bad one warns once whatever the number of files it is
 * matched against. A bad pattern drops out of the list, which narrows the match; never widens it.
 * @param {string[]} patterns @param {string[]} warns @param {string} field @returns {RegExp[]} */
export function compile_all(patterns, warns, field) {
  return patterns.map((p) => hc.compile_re(p, field, warns)).filter((rx) => rx)
}

// A sticky copy of a compiled pattern, anchored at the start, so no RegExp is rebuilt for each path.
function _start_matcher(rx) {
  const sticky = new RegExp(rx.source, rx.flags.replace(/[gy]/g, '') + 'y')
  return (s) => {
    sticky.lastIndex = 0
    return sticky.test(s)
  }
}

// --- ignored-tree claims (ywr-harness ADR 0077) ---------------------------------------------------
// Rules named per group line before the "+N more" note. The line states the cap, so it never applies silently.
export const IGNORED_CLAIMS_MAX_RULES = 3

/** The `.gitignore` files that are part of the commit, root and nested, as `git ls-files` reports them.
 * Membership in this set, not a path-shape test, makes a `check-ignore -v` source "the repo's own".
 * Every other source git consults is per-clone: `.git/info/exclude`, `core.excludesFile` (absolute,
 * `~`-expanded, or relative and pointing at an untracked in-tree file named `.gitignore`, whose source
 * prints as `local/.gitignore`, like a committed one), and an untracked `.gitignore` that a member
 * dropped into the tree. A user's global ignore may exclude `.claude/settings.local.json`, a path that
 * a declared group claims on purpose. Counted, that rule would fire on that machine and never in CI.
 * NUL-separated, paths verbatim.
 * @param {string} root @returns {Set<string>} */
export function tracked_ignore_files(root) {
  const raw = hc.git_run(root, ['ls-files', '-z', '--', '.gitignore', ':(glob)**/.gitignore'])
  return new Set(raw.split('\0').filter((p) => p).map(hc.norm))
}

/** Report every declared group whose `match` also claims a path that the repo's `.gitignore` rules
 * exclude (ywr-harness ADR 0077). Where a group claims an ignored tree, the ungrouped backstop is blind:
 * a force-added (`git add -f`) result or build file is claimed, gated as an ordinary member of the
 * group, and never surfaces as ungrouped. An `evals` group matching `evals/results/**\/*.md` swallows
 * such files unless its pattern carries a `(?!results/)` lookahead. A gitignored untracked file never
 * reaches the emitter (`ls-files --others --exclude-standard`), so this is the only place the overlap
 * is visible before the force-add.
 *
 * Three git calls through the pinned `hc.git_run`, all `-z` so paths travel verbatim. The line-shaped
 * forms C-quote a control character, and a newline-separated `--stdin` list turns into `path\r` through
 * a text-mode pipe on Windows:
 * `ls-files --others --ignored --exclude-standard` for the set that git excludes, from every source;
 * `ls-files -- .gitignore **\/.gitignore` for the committed policy (`tracked_ignore_files`);
 * `check-ignore -v -n --no-index --stdin` over the ignored list for the deciding rule per path.
 * `-n` gives an empty-source record for a path that git listed as ignored but does not re-confirm
 * (a `.gitignore` edited or a file removed between the two calls). That path counts as unconfirmed,
 * and never vanishes from a fixed-stride parse.
 * A rule counts only when its source is a tracked `.gitignore`, read as it stands in the working tree.
 * An uncommitted edit to one counts but shows in `git status`, unlike the per-clone sources that this
 * filter removes. So the rule side of the report follows the commit's policy files, and the path side
 * is what exists in this checkout. A CI clone that never produced the output tree checks nothing and
 * says so. A slice-close run after a build or an eval is where this fires.
 * "Claims" is the partition's own test (the start-anchored match on the same compiled group regex), so
 * the word means what it means in the `gates:` window.
 * It never throws on a git failure and never stays silent: a git failure prints NOT CHECKED.
 * `warns` is the caller's sink for a group regex that does not compile, deduplicated against what the
 * gates loop already queued. On the `--all` empty-tree path that loop never runs, so this is the only
 * place that names such a pattern.
 * Returns lines, which the caller prints through `hc.say`: a column-0 header and 2-space `groups[…]`
 * detail lines. Neither shape is a group header or a command to either output parser. On every path
 * that prints a trailer they sit after `hooks:`, and a `review tier:` line precedes them whenever a
 * tier was computed. The `--all` empty-tree trailer has no tier and no `gates:` window.
 * @param {string} root @param {Object} cfg @param {string[]} warns @returns {string[]} */
export function ignored_claims(root, cfg, warns) {
  let raw
  let tracked
  try {
    raw = hc.git_run(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
    tracked = tracked_ignore_files(root)
  } catch (e) {
    if (!is_git_failure(e)) throw e
    return ['ignored-tree claims: NOT CHECKED — git ls-files failed: ' +
            `${py_strip(e.stderr || '')} (not a pass)`]
  }
  const ignored = raw.split('\0').filter((p) => p).map(hc.norm)
  const rule_of = new Map()   // path -> [source, line, pattern], committed rules only
  let unconfirmed = 0
  if (ignored.length) {
    let out
    try {
      out = hc.git_run(root, ['check-ignore', '-v', '-n', '--no-index', '--stdin', '-z'],
        { stdin: ignored.join('\0') + '\0' })
    } catch (e) {
      if (!is_git_failure(e)) throw e
      // Exit 1 is check-ignore's "no path was ignored", a verdict and not a failure. With `-n` its
      // records are still on stdout, every one empty-source. Any other exit is a failure.
      if (e.returncode !== 1) {
        return ['ignored-tree claims: NOT CHECKED — git check-ignore failed: ' +
                `${py_strip(e.stderr || '')} (not a pass)`]
      }
      out = e.stdout || ''
    }
    // A `-v -n -z` record is four NUL-terminated fields, source, linenum, pattern and pathname, none quoted.
    // A non-matching path carries three empty fields before its name.
    const fields = out.split('\0')
    let records = 0
    for (let i = 0; i < fields.length - 3; i += 4) {
      const [src0, num, pat, p] = fields.slice(i, i + 4)
      records++
      if (!src0) {
        unconfirmed++
        continue
      }
      const src = hc.norm(src0)
      if (/^[0-9]+$/.test(num) && tracked.has(src)) rule_of.set(hc.norm(p), [src, Number(num), pat])
    }
    unconfirmed += Math.max(0, ignored.length - records)
  }
  const note = unconfirmed
    ? ` · ${unconfirmed} path(s) git listed as ignored but check-ignore did not re-confirm — ` +
      'not checked (a .gitignore or the tree changed between the two calls; re-run)'
    : ''
  const checked = hc._sorted(rule_of.keys())
  if (!checked.length) {
    return ['ignored-tree claims: none checked — no path in this checkout is excluded by the ' +
            "repo's committed .gitignore files (a CI checkout sees only what its own steps " +
            `produced; run after a build or an eval to check the output trees)${note}`]
  }
  const lines = []
  for (const g of cfg.groups) {
    const fresh = []
    const rx = hc.compile_re(g.match, `groups[${g.name}].match`, fresh)
    for (const w of fresh) if (!warns.includes(w)) warns.push(w)
    const claims = rx ? _start_matcher(rx) : () => false
    const hits = checked.filter((p) => claims(p))
    if (!hits.length) continue
    const counts = new Map()   // "source\0line\0pattern" -> [rule, count]
    for (const p of hits) {
      const rule = rule_of.get(p)
      const key = `${rule[0]}\0${rule[1]}\0${rule[2]}`
      if (!counts.has(key)) counts.set(key, [rule, 0])
      counts.get(key)[1]++
    }
    // Sort the rules by source (code point), then line number, then pattern.
    const rules = [...counts.values()].map(([rule]) => rule).sort((a, b) =>
      hc._cmp(a[0], b[0]) || a[1] - b[1] || hc._cmp(a[2], b[2]))
    // A pattern is repo-supplied text, and a backtick inside it would close the code span that this line
    // opens around it. That is cosmetic, because one_line handles control characters at the exit.
    const shown = rules.slice(0, IGNORED_CLAIMS_MAX_RULES)
      .map(([src, num, pat]) => `${src}:${num} \`${pat.replaceAll('`', "'")}\``).join(', ')
    const more = rules.length - IGNORED_CLAIMS_MAX_RULES
    const tail = more > 0 ? ` … +${more} more rule(s)` : ''
    lines.push(`  groups[${g.name}] claims ${hits.length} file(s) ignored by ${shown}${tail}`)
  }
  if (!lines.length) {
    return [`ignored-tree claims: none — ${checked.length} gitignored path(s) checked against ` +
            `${cfg.groups.length} group(s)${note}`]
  }
  const head = `ignored-tree claims (${lines.length} group(s) whose match also claims paths the repo's ` +
    '.gitignore excludes — the ungrouped backstop is blind there: a force-added file under ' +
    'such a rule is gated as an ordinary member of the group, never flagged; narrow the ' +
    `match or exclude the tree, e.g. a (?!results/) lookahead — ywr-harness ADR 0077${note}):`
  return [head, ...lines]
}

export const IMPORT_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']

// The whitespace set of Python's `\s` for a str pattern, `str.isspace()`. JavaScript's `\s` differs at
// U+001C-U+001F, U+0085 and U+FEFF. The class is built from numbers, so no source line holds a raw
// separator character.
const _PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f ' + String.fromCharCode(0x85, 0xa0, 0x1680) +
  String.fromCharCode(0x2000) + '-' + String.fromCharCode(0x200a) +
  String.fromCharCode(0x2028, 0x2029, 0x202f, 0x205f, 0x3000)

// `.` is spelled `[^\n]` below. The lines are split on `\n`, `\r` and `\r\n` only, so a line may
// still hold U+2028, which Python's `.` matches and JavaScript's does not.
const _FENCE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/
const _INDENTED = /^(?: {4}|\t)/
const _CLOSER = /^(?:#{1,6}(?:[ \t]|$)|([-*_])(?:[ \t]*\1){2,}[ \t]*$)/
const _SETEXT = /^=+[ \t]*$/
const _SPAN = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/gs
const _IMPORT = new RegExp(`(?:^|(?<=[${_PY_WS}]))@((?:\\\\ |[^${_PY_WS}])+)`, 'g')
const _BOM = String.fromCharCode(0xFEFF)

/** The text of a memory file with its code removed, as Claude Code reads it for imports.
 *
 * Claude Code loads no import from a fenced code block, an indented code block or a code span
 * (ywr-harness fact 250). A fence closes only on its own character, at least as long, with nothing
 * after it, so a `~~~` line inside a backtick fence stays code. An indented line is code after a
 * blank line. It is code too after a column-0 closing fence, ATX heading, thematic break or setext
 * underline, because each of them ends the paragraph before it (ywr-harness fact 256). The same block
 * indented by one to three spaces can sit inside a list item, where the next indented line is item
 * text. The reader tracks no list, so it leaves the state alone after an indented block. A list
 * item's indented paragraph after a blank line reads as code here, which errs toward NOT IMPORTED.
 * A code span can cross a line break, so spans are removed per paragraph.
 * The session-start scaffold nudge has the same reader. Keep the two in step.
 * @param {string} text @returns {string} */
export function import_text(text) {
  const kept = []
  let fence = ''
  let blank = true
  let indented = false
  for (const line of text.split(/\r\n|\r|\n/)) {
    const m = _FENCE.exec(line)
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !py_strip(m[2])) {
        fence = ''
        if ('`~'.includes(line.slice(0, 1))) {
          blank = true
          indented = false
        }
      }
      kept.push('')
      continue
    }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      fence = m[1]
      kept.push('')
      continue
    }
    if (!py_strip(line)) {
      blank = true
      kept.push('')
      continue
    }
    if (_INDENTED.test(line) && (blank || indented)) {
      indented = true
      kept.push('')
      continue
    }
    const closes = _CLOSER.test(line) || (_SETEXT.test(line) && !blank && !indented)
    blank = Boolean(closes)
    indented = false
    kept.push(line)
  }
  return kept.join('\n').split(/\n[ \t]*\n/).map((p) => p.replace(_SPAN, ' ')).join('\n\n')
}

// Windows paths ignore case, so `@C4.MD` loads c4.md there. The fold applies on Windows only.
// `_resolve` expands an 8.3 short name and a link, so an absolute token spelled through either
// still names the file that the session loads (ywr-harness fact 250).
function _norm_target(p) {
  const abs = _resolve(p)
  return process.platform === 'win32' ? abs.replaceAll('/', '\\').toLowerCase() : abs
}

// Expands the `~` and `~/…` forms: the home directory plus the rest of the token.
function _expanduser(tok) {
  return os.homedir().replace(/[\\/]+$/, '') + tok.slice(1)
}

/** The first of IMPORT_FILES that imports `canon`, or '' (ywr-harness ADR 0215).
 *
 * `/code-review` reads CLAUDE.md, never a separate canon file, so a canon outside the memory files
 * reaches the slice review only through an `@<path>` import (ywr-harness ADR 0217). A token counts
 * when it starts a line or follows whitespace, after import_text removed the code. A backslash-escaped space belongs to the token. A relative token
 * resolves against the folder of the file that holds it, `~/` against the home folder, and an
 * absolute token stands as written. An ancestor CLAUDE.md above the repo root is not read.
 * @param {string} root @param {string} canon @returns {string} */
export function canon_importer(root, canon) {
  const want = _norm_target(path.resolve(root, canon))
  for (const rel of IMPORT_FILES) {
    let text
    try {
      text = fs.readFileSync(path.join(root, rel)).toString('utf8').replace(/^\uFEFF+/, '')
    } catch (e) {
      if (!is_os_error(e)) throw e
      continue
    }
    const slash = rel.lastIndexOf('/')
    const folder = path.resolve(root, slash < 0 ? '' : rel.slice(0, slash))
    for (const m of import_text(text).matchAll(_IMPORT)) {
      let tok = m[1].replaceAll('\\ ', ' ')
      if (tok === '~' || tok.startsWith('~/')) tok = _expanduser(tok)
      if (_norm_target(path.resolve(folder, tok)) === want) return rel
    }
  }
  return ''
}

// One line at a time, never with the `m` flag, because JavaScript's `^` and `$` then also break at `\r`,
// U+2028 and U+2029.
const _CANON_HEADING = /^ {0,3}#{1,6}[ \t]+Review canon[ \t]*(?:#+[ \t]*)?$/i

/** True when `canon` is one of IMPORT_FILES, a memory file the session loads at its start
 * (ywr-harness ADR 0217). Such a canon needs no import.
 * @param {string} root @param {string} canon @returns {boolean} */
export function memory_canon(root, canon) {
  const want = _norm_target(path.resolve(root, canon))
  return IMPORT_FILES.some((rel) => _norm_target(path.resolve(root, rel)) === want)
}

/** True when the memory-file canon has an ATX heading `Review canon` outside code
 * (ywr-harness ADR 0217). The heading marks the section that holds the review invariants. The
 * check reads the heading only, so a section that lost its rules still passes.
 * @param {string} root @param {string} canon @returns {boolean} */
export function canon_heading(root, canon) {
  let text
  try {
    text = fs.readFileSync(path.resolve(root, canon)).toString('utf8').replace(/^\uFEFF+/, '')
  } catch (e) {
    if (!is_os_error(e)) throw e
    return false
  }
  return import_text(text).split('\n').some((line) => _CANON_HEADING.test(line))
}

/** The common trailer after the tier line: review canon, handoff, hooks, queued warnings.
 * The per-slice path and the full-tree audit path share it (ywr-harness ADR 0041), so the two never
 * disagree on what a run reports after its verdict.
 * @param {string} root @param {Object} cfg @param {string[]} warns @param {string[]} late
 * @returns {number} */
export function emit_tail(root, cfg, warns, late) {
  const canon = cfg.review_canon
  let state
  if (!fs.existsSync(path.resolve(root, canon))) {
    state = '   (NOT FOUND — invariants must come from somewhere; the close cannot cite a missing file)'
  } else if (memory_canon(root, canon)) {
    // A memory file loads at session start, so it needs no import. A missing heading only warns:
    // a renamed heading must not stop a close whose rules did not change (ywr-harness ADR 0217).
    state = canon_heading(root, canon)
      ? '   (loaded at session start)'
      : '   (loaded at session start, NO HEADING — no ATX heading \'Review canon\' outside code, ' +
        'so the review may run without the canon — ywr-harness ADR 0217)'
  } else {
    // The importing file name is fixed text, never a repo value, so the line stays one line.
    const importer = canon_importer(root, canon)
    state = importer
      ? `   (imported by ${importer})`
      : '   (NOT IMPORTED — no @<path> line for it in CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md; ' +
        '/code-review reads the canon only through that import — ywr-harness ADR 0215, ywr-harness ADR 0217)'
  }
  hc.say(`review canon: ${canon}${state}`)
  if (cfg.handoff) {
    // A trailing '/' declares a per-work-line directory (ywr-harness ADR 0040). The hint keeps the close
    // instruction "update the handoff the emitter named" unambiguous.
    const hint = cfg.handoff.endsWith('/') ? ' — directory: one resume file per work line' : ''
    hc.say(`handoff: ${cfg.handoff}${hint}`)
  }

  // Printed after the tier, so the hook's output parser, which stops at `review tier:`, never
  // mistakes it for a gate command.
  const hooks = hooks_status(root)
  if (hooks) process.stdout.write(`hooks: ${hooks}\n`)

  // A tree fact like `hooks:`, because a declaration-vs-.gitignore overlap is not a diff property.
  // It rides the trailer wherever one prints: a per-slice run with a non-empty scope, and the `--all`
  // audit even over an empty tree. The per-slice empty-scope path prints no trailer at all, `hooks:`
  // included, because a clean tree is not a slice. The report is absent there, never silent about a
  // checked state (ywr-harness spec 0007 §3.2). Report only (ywr-harness ADR 0077); CI does not grep it.
  // `late` is the compile-warning sink.
  for (const line of ignored_claims(root, cfg, late)) hc.say(line)

  for (const w of [...warns, ...late]) hc.warn(w)
  return 0
}

// ---------------------------------------------------------------------------------------------
// Command line. The flags and the messages follow Python's argparse, so a caller's scripts and a person's
// habits keep working: prefix abbreviations of a long option (`--ra`), `--opt=value`, `--` to end the
// options, a positional list that may only start once, and exit status 2 with a usage block on stderr
// for a refusal. The usage block wraps at 78 columns, argparse's width on an 80-column terminal.
// `COLUMNS` is not read.
// ---------------------------------------------------------------------------------------------
const _OPTIONS = [
  { flags: ['-h', '--help'], dest: 'help', takes: false },
  { flags: ['--range'], dest: 'rev_range', takes: true, metavar: 'REV_RANGE' },
  { flags: ['--repo'], dest: 'repo', takes: true, metavar: 'REPO' },
  { flags: ['--all'], dest: 'all_files', takes: false },
  { flags: ['--tree'], dest: 'tree', takes: false },
]
const _TEXT_WIDTH = 78

function _prog() {
  return path.basename(process.argv[1] || 'harness_gates.mjs')
}

function _usage() {
  const prog = _prog()
  const prefix = 'usage: '
  const opt_parts = ['[-h]', '[--range REV_RANGE]', '[--repo REPO]', '[--all]', '[--tree]']
  const pos_parts = ['[files ...]']
  const one = `${prefix}${[prog, ...opt_parts, ...pos_parts].join(' ')}`
  if (one.length <= _TEXT_WIDTH) return one + '\n'
  const indent = ' '.repeat(prefix.length + prog.length + 1)
  const wrap = (parts, first) => {
    const lines = []
    let line = []
    let len = first ? prefix.length - 1 : indent.length - 1
    for (const part of parts) {
      if (len + 1 + part.length > _TEXT_WIDTH && line.length) {
        lines.push(indent + line.join(' '))
        line = []
        len = indent.length - 1
      }
      line.push(part)
      len += part.length + 1
    }
    if (line.length) lines.push(indent + line.join(' '))
    return lines
  }
  const lines = wrap([prog, ...opt_parts], true)
  lines.push(...wrap(pos_parts, false))
  lines[0] = lines[0].slice(indent.length)
  return prefix + lines.join('\n') + '\n'
}

function _help() {
  return _usage() + '\n' +
    'Emit deterministic gate commands and a review tier.\n\n' +
    'positional arguments:\n' +
    '  files\n\n' +
    'options:\n' +
    '  -h, --help         show this help message and exit\n' +
    '  --range REV_RANGE\n' +
    '  --repo REPO\n' +
    '  --all              full-tree audit scope: git ls-files + untracked\n' +
    '                     (ywr-harness ADR 0041 — CI push runs)\n' +
    '  --tree             print only the worktree snapshot a prepared close is\n' +
    '                     reused against (ywr-harness ADR 0105)\n'
}

class _ArgError extends Error {}

function _repr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'"
  return q + s.replaceAll('\\', '\\\\').replaceAll(q, '\\' + q) + q
}

const _NEGATIVE_NUMBER = /^-[0-9]+$|^-[0-9]*\.[0-9]+$/

// How one argument string is read: null = a positional, else {opt, explicit} where `opt` is an
// option record or null for an unknown option that lands in the unrecognized list.
function _classify(arg) {
  if (!arg || arg[0] !== '-') return null
  const exact = _OPTIONS.find((o) => o.flags.includes(arg))
  if (exact) return { opt: exact, flag: arg, explicit: null }
  if (arg.length === 1) return null
  if (arg.includes('=')) {
    const eq = arg.indexOf('=')
    const head = arg.slice(0, eq)
    const found = _OPTIONS.find((o) => o.flags.includes(head))
    if (found) return { opt: found, flag: head, explicit: arg.slice(eq + 1) }
  }
  // Prefix abbreviations. A long option may be shortened to any unambiguous prefix; a single-dash
  // argument reads as its two-letter option plus an explicit remainder.
  const matches = []
  if (arg.startsWith('--')) {
    const head = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    const explicit = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null
    for (const o of _OPTIONS) {
      for (const f of o.flags) if (f.startsWith(head)) matches.push({ opt: o, flag: f, explicit })
    }
  } else {
    const short = arg.slice(0, 2)
    for (const o of _OPTIONS) {
      for (const f of o.flags) {
        if (f === short) matches.push({ opt: o, flag: f, explicit: arg.slice(2) })
        else if (f.startsWith(arg)) matches.push({ opt: o, flag: f, explicit: null })
      }
    }
  }
  if (matches.length > 1) {
    throw new _ArgError(`ambiguous option: ${arg} could match ${matches.map((m) => m.flag).join(', ')}`)
  }
  if (matches.length === 1) return matches[0]
  if (_NEGATIVE_NUMBER.test(arg)) return null
  if (arg.includes(' ')) return null
  return { opt: null, flag: arg, explicit: null }
}

function _optionLabel(o) {
  return o.flags.join('/')
}

/** @param {string[]} argv @returns {{rev_range: string|null, repo: string|null, all_files: boolean,
 *   tree: boolean, files: string[], help: boolean}} */
function _parse_args(argv) {
  const out = { rev_range: null, repo: null, all_files: false, tree: false, files: [], help: false }
  // First pass: the kind of every argument. `--` ends the options, and everything after it is a
  // positional.
  const kinds = []
  let ended = false
  for (const a of argv) {
    if (ended) kinds.push({ kind: 'A' })
    else if (a === '--') { kinds.push({ kind: '-' }); ended = true }
    else {
      const c = _classify(a)
      kinds.push(c === null ? { kind: 'A' } : { kind: 'O', ...c })
    }
  }
  const extras = []
  let positionalsDone = false
  const take_positionals = (from, to) => {
    // Positionals take the run of non-option arguments at `from`; a second run is unrecognized.
    let vals = argv.slice(from, to)
    const dash = vals.indexOf('--')
    if (dash >= 0) vals = [...vals.slice(0, dash), ...vals.slice(dash + 1)]
    if (positionalsDone) extras.push(...vals)
    else {
      out.files = vals
      positionalsDone = true
    }
  }
  const run_end = (from) => {
    let j = from
    while (j < argv.length && kinds[j].kind !== 'O') j++
    return j
  }
  let i = 0
  while (i < argv.length) {
    if (kinds[i].kind !== 'O') {
      const end = run_end(i)
      take_positionals(i, end)
      i = end
      continue
    }
    const { opt, flag, explicit } = kinds[i]
    if (opt === null) {
      extras.push(argv[i])
      i++
      continue
    }
    if (opt.takes) {
      if (explicit !== null) {
        out[opt.dest] = explicit
        i++
      } else if (i + 1 < argv.length && kinds[i + 1].kind === 'A') {
        out[opt.dest] = argv[i + 1]
        i += 2
      } else {
        throw new _ArgError(`argument ${_optionLabel(opt)}: expected one argument`)
      }
      continue
    }
    // A flag. A value glued on with `=` is refused; glued on after a single dash it may be
    // another short flag, and only `-h` exists.
    if (explicit !== null && explicit !== '') {
      if (!flag.startsWith('--') && /^h+$/.test(explicit) && opt.dest === 'help') {
        out.help = true
        return out
      }
      throw new _ArgError(`argument ${_optionLabel(opt)}: ignored explicit argument ${_repr(explicit)}`)
    }
    if (explicit === '' && flag.startsWith('--')) {
      throw new _ArgError(`argument ${_optionLabel(opt)}: ignored explicit argument ''`)
    }
    if (opt.dest === 'help') {
      out.help = true
      return out
    }
    out[opt.dest] = true
    i++
  }
  if (extras.length) throw new _ArgError(`unrecognized arguments: ${extras.join(' ')}`)
  return out
}

// The seam the selftest uses to prove the line measure never runs on a critical verdict: it
// replaces the entry here and calls `main`. An ES module namespace cannot be reassigned, so the
// one call site that the proof needs goes through this object.
export const ops = { changed_lines }

/** The whole run. Returns the exit code, never exits.
 * @param {string[]} [argv] the command-line arguments after the script name
 * @returns {number} */
export function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = _parse_args(argv)
  } catch (e) {
    if (!(e instanceof _ArgError)) throw e
    process.stderr.write(_usage() + `${_prog()}: error: ${e.message}\n`)
    return 2
  }
  if (args.help) {
    process.stdout.write(_help())
    return 0
  }

  const root = args.repo ? _resolve(args.repo) : hc.find_repo_root(process.cwd())
  if (args.tree) {
    // Its own mode, never a line in the per-slice output: CI and pre-commit parse that output,
    // and a snapshot writes git objects that no gate run should pay for.
    if (args.all_files || args.rev_range || args.files.length) {
      process.stderr.write('note: --tree given — ignoring --all, --range and explicit files\n')
    }
    let tree
    let head
    try {
      [tree, head] = hc.worktree_snapshot(root)
    } catch (e) {
      // An OS failure prints the same marker: a locked or unreadable index, or no temp dir,
      // never gives a traceback that a reader might retry or paraphrase.
      if (is_git_failure(e)) process.stderr.write(`git failed: ${py_strip(e.stderr || '')}\n`)
      else if (is_os_error(e)) process.stderr.write(`snapshot failed: ${e.message}\n`)
      else throw e
      hc.say('tree: FAILED — the working tree could not be snapshotted; nothing prepared ' +
             'can be reused against it (ywr-harness ADR 0105).')
      return 1
    }
    hc.say(`tree: ${tree} · HEAD ${head}`)
    return 0
  }
  const [cfg, warns] = hc.load(root)

  if (args.all_files && (args.rev_range || args.files.length)) {
    process.stderr.write('note: --all given — ignoring --range and explicit files\n')
  }

  let files
  let prov
  try {
    [files, prov] = hc.changed_files(root, args.rev_range, args.files, { all_files: args.all_files })
  } catch (e) {
    if (!is_git_failure(e)) throw e
    // The one non-zero exit in this advisory script (ywr-harness ADR 0041). A silent return would pass
    // every downstream consumer: CI greps stdout, and an empty stdout carries no ungrouped marker, no
    // artifact line and no gate commands, so a job that ran nothing reads green. Typical triggers are an
    // unreachable ref, a force-pushed base branch and a stale fetch.
    process.stderr.write(`git failed: ${py_strip(e.stderr || '')}\n`)
    hc.say('scope: FAILED — git could not resolve the changed-file scope; NOTHING below was ' +
           'computed. This run must not be read as a pass (ywr-harness ADR 0041).')
    return 1
  }

  const late = []
  hc.print_scope(files, prov)
  // Above `gates:`, outside the window that both output parsers consume, and before the empty-scope
  // return, because CI's push-to-main run has no changed files and is an enforcement point.
  // The drift-check commands ride the gates window below (ywr-harness ADR 0068), so the empty-scope path
  // prints the completeness lines and runs no check. The next real slice and the publish skill re-check.
  const [art_lines, art_checks] = artifact_status(root, cfg, late)
  for (const line of art_lines) hc.say(line)
  if (!files.length) {
    if (prov.source === 'all') {
      // The trailer facts of a full-tree audit (review-canon existence, hooks wiring) are tree facts,
      // not diff facts. An empty tree still has answers, and hooks_status prints on every CI run.
      hc.say('no changed files — nothing to gate')
      return emit_tail(root, cfg, warns, late)
    }
    for (const w of [...warns, ...late]) hc.warn(w)
    hc.say('no changed files — nothing to gate')
    return 0
  }

  // Groups to gate commands, keyed by position, never by name. Two groups can share a name, and
  // two different declared names can collapse to the same escaped display string. A name-keyed map
  // would hand one group the other's file list, so a group's gates would run against files it never
  // claimed. The index is the only key that is unique by construction.
  const grouped = cfg.groups.map((g) => {
    const rx = hc.compile_re(g.match, `groups[${g.name}].match`, late)
    if (!rx) return []
    const claims = _start_matcher(rx)
    return hc._sorted(files.filter((f) => claims(f)))
  })

  const claimed = new Set(grouped.flat())
  const leftover = files.filter((f) => !claimed.has(f))
  // Built-in claims (ywr-harness ADR 0044): scaffold-placed paths that no declared group matched.
  // Declared groups win, because only leftovers are consulted. The claim is reported below, because
  // an absorbed file that printed nowhere would read as coverage.
  const builtin = new Set([...hc.SCAFFOLD_CLAIMS, ...hc.RETIRED_SCAFFOLD_CLAIMS])
  const leftover_set = new Set(leftover)
  const scaffold_claimed = hc._sorted([...leftover_set].filter((f) => builtin.has(f)))
  const ungrouped = hc._sorted([...leftover_set].filter((f) => !builtin.has(f)))

  hc.say('gates:')
  let emitted = 0
  const seen = new Set()
  cfg.groups.forEach((g, i) => {
    let fs_ = grouped[i]
    if (!fs_.length) return
    hc.say(`  [${g.name}] ${fs_.length} file(s)`)
    if (!g.gates.length) {
      hc.say('    (no gate declared for this group — nothing deterministic runs on it)')
    }
    // A deleted file is never a file-scoped argument (ywr-harness ADR 0112). Nothing is left to check,
    // a plain name fails the tool for nothing, and a `[id]` name is globbed by eslint or prettier onto
    // a sibling that then passes. The drop comes before the unsafe check, because a deleted name is not
    // an ungated file, and it prints on parenthesized lines like the exclusions below.
    const absent = g.gates.some((gate) => hc.gate_is_scoped(gate)) ? hc.absent_files(root, fs_) : []
    if (absent.length) {
      hc.say(`    (${absent.length} changed file(s) absent from the working tree — deleted, ` +
             'or removed from disk while still staged — nothing on disk for this group\'s ' +
             'file-scoped gates to read)')
      for (const f of absent) hc.say(`    (absent: ${f})`)
      const gone = new Set(absent)
      fs_ = fs_.filter((f) => !gone.has(f))
    }
    // A filename is repo-supplied text. A name with a space, quote or '#' cannot pass through `sh -c`
    // or either output parser as one argument, so it stays out of the gate's argument list.
    // The exclusion is always printed, because an excluded file is an ungated file.
    const unsafe = hc.unsafe_files(g, fs_)
    if (unsafe.length && g.gates.some((gate) => hc.gate_is_scoped(gate))) {
      // "UNGATED" would overstate the loss when the group also declares a whole-program gate. That gate
      // runs regardless of the argument list, so only the file-scoped coverage is lost. The coverage
      // claim must match what runs, in both the note and the warning.
      const whole_covers = g.gates.some((gate) => !hc.gate_is_scoped(gate))
      if (whole_covers) {
        hc.say(`    (${unsafe.length} file(s) EXCLUDED from this group's file-scoped gate ` +
               'arguments — unsafe characters for a command argument; the group\'s ' +
               'whole-program gate still covers them)')
      } else {
        hc.say(`    (${unsafe.length} file(s) EXCLUDED from this group's gate arguments — unsafe ` +
               'characters for a command argument, so no deterministic gate covers them)')
      }
      for (const f of unsafe) {
        // A filename is repo-supplied text, and this line sits inside the gate-command window. The leading
        // `(` keeps the first line out of both parsers, but a name with a newline would put its remainder
        // on a line that starts with four spaces and no `(`, which is a forged command. git's default
        // `core.quotePath` escapes such names, a mitigation in someone else's config and no guarantee.
        hc.say(`    (excluded: ${f})`)
      }
      if (whole_covers) {
        late.push(`groups[${g.name}]: ${unsafe.length} changed file(s) could not be ` +
                  'passed as file-scoped gate arguments — the group\'s whole-program ' +
                  'gate still covers them; rename them to restore file-scoped coverage')
      } else {
        late.push(`groups[${g.name}]: ${unsafe.length} changed file(s) could not be passed ` +
                  'to a gate command and are UNGATED — rename them or gate them by hand')
      }
    }
    for (const gate of g.gates) {
      const cmd = hc.gate_command(gate, g, fs_, late)
      if (cmd.startsWith('(')) {
        // gate_command refused or skipped this one. It is already a parenthetical, so it prints as-is
        // (both parsers skip it). It must not count toward `emitted`, because a refusal that inflated
        // the count would read as a gate that ran.
        hc.say(`    ${cmd}`)
        continue
      }
      if (seen.has(cmd)) {
        // A whole-program gate declared on several groups composes to the same command, and running it
        // once per group adds no coverage. The '(' prefix keeps this line out of both output parsers.
        hc.say(`    (already emitted above — deduplicated: ${cmd})`)
        continue
      }
      seen.add(cmd)
      const whole = hc.gate_is_scoped(gate) ? '' : '   # whole-program: gate on slice files or newly introduced only'
      hc.say(`    ${cmd}${whole}`)
      emitted++
    }
  })
  // Declared-artifact drift checks (ywr-harness ADR 0068) come after the group gates, inside the same window,
  // so CI's extraction runs them and pre-commit's `# whole-program` rule defers them.
  // The header keeps the group-header shape (2-space `[label]`). The two command parsers (CI sed and
  // pre-commit CMDS awk) skip it. The third pre-commit parser, the MATCHED_GROUPS awk, reads 2-space
  // `[label]` lines as group names and skips it by an explicit rule that matches the leading
  // `[artifacts] N declared drift check` text. Without that rule the report is garbled on every commit
  // that declares an artifact check and has an empty CMDS. Changing that text means changing the awk rule.
  // `seen` collapses a check that a group already declared as its own gate.
  if (art_checks.length) {
    hc.say(`  [artifacts] ${art_checks.length} declared drift check(s) — run on every slice ` +
           '(ywr-harness ADR 0068)')
    for (const cmd of art_checks) {
      if (seen.has(cmd)) {
        hc.say(`    (already emitted above — deduplicated: ${cmd})`)
        continue
      }
      seen.add(cmd)
      hc.say(`    ${cmd}   # whole-program: declared-artifact drift check (ywr-harness ADR 0068)`)
      emitted++
    }
  }
  if (emitted === 0) {
    // Three causes share this line. The third is easy to miss: a group can declare gates and still
    // emit none, because each was refused at load or skipped or refused at composition (the
    // parentheticals above). The ywr-harness plugin's selftests match this exact string.
    hc.say('  (none — no declared group matched, matched groups declare no gates, or every ' +
           'declared gate was refused or skipped)')
  }

  // Built-in scaffold claims, stated with every path (ywr-harness ADR 0044). The line shapes suit the two
  // output parsers: a column-0 header that matches neither window-close sentinel (`^ungrouped (` and
  // `^review tier:`) nor CI's `^ungrouped (` failure grep, and 2-space file lines that neither extractor
  // (`^ {4}[^ (]`, awk `/^    [^ (]/`) can read as a command.
  // The paths printed here are constants from the closed set, never repo-supplied text.
  if (scaffold_claimed.length) {
    hc.say(`scaffold-claimed (${scaffold_claimed.length} file(s) — placed or written by ` +
           '/ywr-harness:harness-init and claimed built-in; no groups entry needed — ywr-harness ADR 0044):')
    for (const f of scaffold_claimed) hc.say(`  ${f}`)
  }

  // Never silent: a file that no group claims is a file that no deterministic gate sees.
  if (ungrouped.length) {
    // The tail names the consequence. CI's "Fail on ungrouped files" step hard-fails on this header
    // while every local run stays advisory (ywr-harness ADR 0041), so without the tail a repo reads as
    // passing until its first CI run (ywr-harness ADR 0062).
    hc.say(`ungrouped (${ungrouped.length} file(s) — no declared group matched, so NO deterministic gate covers them; ` +
           "CI's harness-gates run FAILS on this — add a groups entry to .harness.json):")
    for (const f of ungrouped) hc.say(`  ${f}`)
  }

  // Review tier.
  if (prov.source === 'all') {
    // A tier is a slice property (ywr-harness ADR 0041). A whole tree earning "small" in a tiny repo
    // would be a meaningless label, and the declaration-diff and line-count measures below answer
    // questions that no full-tree audit asks. The line keeps the `review tier:` prefix, which both
    // output parsers (CI sed, pre-commit awk) use as their window-close sentinel. An audit run that
    // dropped it would hand the parsers an unterminated window.
    hc.say('review tier: full-tree audit — a tier applies to a slice; this run checks ' +
           'partition, artifact, and gate coverage over the whole tree (ywr-harness ADR 0041)')
    return emit_tail(root, cfg, warns, late)
  }

  const rev = cfg.review
  // docs_only is compiled once. The same patterns are consulted per changed file and per numstat path,
  // and compile_re warns on every call for a bad pattern. One warning per pattern is the signal.
  const docs_rx = rev.docs_only.map((p) => hc.compile_re(p, 'review.docs_only', late)).filter((rx) => rx)

  const docs_exempt = (p) => docs_rx.some((rx) => rx.test(p))

  // The exemption sets come from `files`, the same name-only listing that builds `code_files` below, and
  // changed_lines gets a membership test, never the regexes. One classification serves two measures, so
  // the branch decision and the printed figures cannot disagree. A numstat rename record (`old => new`)
  // can never regex-match its old name into an exemption, which would count a docs-to-code rename as docs-only.
  const docs_paths = new Set(files.filter(docs_exempt))

  // Derived-copy exemption (ywr-harness ADR 0037): a changed file under a declared copies prefix whose
  // current bytes equal its mapped source's adds no review surface, because the deterministic identity
  // gate owns that relationship. Identity is a tree property, so both sides are read from the worktree.
  // A drifted or deleted copy counts fully, and the identity gate fails the build anyway.
  // Chains are not resolved: every copies prefix maps directly to its canonical source.
  const derived_source = (p) => {
    for (const d of rev.derived) {
      for (const c of d.copies) {
        if (p.startsWith(c)) return d.source + p.slice(c.length)
      }
    }
    return null
  }

  const identical_to_source = (p) => {
    const src = derived_source(p)
    if (!src || src === p) return false
    try {
      const a = path.join(root, p)
      const b = path.join(root, src)
      // A symlink's diff is its target string, but a content read follows it. A link retargeted at the
      // source itself would compare identical while the reviewed change is a redirection. So a link is
      // never an exempt copy, on either side.
      const link = (x) => { try { return fs.lstatSync(x).isSymbolicLink() } catch { return false } }
      if (link(a) || link(b)) return false
      return fs.readFileSync(a).equals(fs.readFileSync(b))
    } catch (e) {
      if (!is_os_error(e)) throw e
      return false
    }
  }

  const derived_paths = new Set(files.filter((f) => !docs_paths.has(f) && identical_to_source(f)))
  const exempt_paths = new Set([...docs_paths, ...derived_paths])
  // `skip` stays a docs-only decision (ywr-harness ADR 0037). Derived files never contribute to the
  // all-docs test, so a pure propagation diff earns `small` via an empty counted set, not `skip`.
  // The exemption narrows the measure and the criticality attribution, never the trust class.
  const docs_only = rev.docs_only.length > 0 && files.every((f) => docs_paths.has(f))
  const critical_rx = compile_all(rev.critical, late, 'review.critical')
  const critical_all = files.filter((f) => hc.any_match(critical_rx, f))
  // A byte-identical copy cannot force `critical`, because the source's own classification decides
  // (ywr-harness ADR 0037). The tier line below states the suppression.
  let critical = critical_all.filter((f) => !derived_paths.has(f))
  const crit_suppressed = critical_all.filter((f) => derived_paths.has(f))
  const code_files = files.filter((f) => !exempt_paths.has(f))
  const layer_rx = code_files.length ? compile_all(rev.harness_layer, late, 'review.harness_layer') : []
  const harness_only = layer_rx.length > 0 && code_files.every((f) => hc.any_match(layer_rx, f))

  // The declaration's criticality is computed from which keys changed (ywr-harness ADR 0038). The safe
  // keys feed reporting only. Any other key, or a diff that cannot be determined, is critical in every
  // repo. Either way the verdict is stated with its input.
  let decl_note = ''
  if (files.includes(DECL_FILE)) {
    // Explicit-files mode ignores --range everywhere else (print_scope says so on stderr),
    // so the base must not come from it here either. HEAD is the base for a worktree question.
    const keys = decl_changed_keys(root, prov.source !== 'explicit' ? args.rev_range : null)
    if (keys !== null && keys.every((k) => DECL_SAFE_KEYS.has(k))) {
      critical = critical.filter((f) => f !== DECL_FILE)
      decl_note = (keys.length
        ? `declaration change confined to metadata keys (${keys.join(', ')})`
        : 'declaration change is comment-only') + ' — not counted as critical'
    } else {
      if (!critical.includes(DECL_FILE)) critical.unshift(DECL_FILE)
      const shown = keys && keys.length ? keys.join(', ') : 'undetermined'
      decl_note = `declaration keys changed (${shown}) — the declaration decides what ` +
        'runs and what gets reviewed, so it is critical in every repo'
    }
  }

  // Size is measured over the non-exempt subset (ywr-harness ADR 0035, ywr-harness ADR 0037). Docs-only
  // files and byte-identical derived copies that ride along with a small behavioral change inflate the
  // total without adding review surface. The scope is never narrowed, only the measure, and the tier
  // line states a non-empty exclusion. With neither class in the diff, the counted figures equal the
  // totals and the wording below is byte-identical to the unweighted form.
  const ex_parts = []
  if (docs_paths.size) ex_parts.push(`${docs_paths.size} docs-only file(s)`)
  if (derived_paths.size) {
    ex_parts.push(`${derived_paths.size} byte-identical derived ` + (derived_paths.size === 1 ? 'copy' : 'copies'))
  }
  const exempt_note = ex_parts.length
    ? ` — ${ex_parts.join(' and ')} excluded from the size measure, still in review scope`
    : ''

  let tier
  let why
  if (critical.length) {
    tier = 'full'
    why = `critical surface touched (${critical.slice(0, 3).join(', ')}) — size never overrides criticality`
  } else if (docs_only) {
    tier = 'skip'
    why = 'every changed file is a declared docs surface; deterministic gates suffice'
  } else if (harness_only) {
    tier = 'small'
    why = 'code-bearing changes are confined to the declared harness layer'
  } else {
    // Measured only here. No earlier branch reads a line count, and the measure reads every untracked
    // file of the scope to its end, so a critical, skip or harness-layer verdict pays neither that read
    // nor the numstat calls. `prov.untracked` has no default: a scope without the list must fail loudly,
    // never weigh its new files at 0 lines.
    const sizes = prov.source !== 'explicit'
      ? ops.changed_lines(root, args.rev_range, (p) => exempt_paths.has(p), hc._idx(prov, 'untracked'))
      : null
    if (sizes === null) {
      tier = 'full'
      why = prov.unborn_head
        ? 'no commit yet (unborn HEAD) — no base to count changed lines against — unknown is not small'
        : 'changed-line count could not be measured — unknown is not small'
    } else {
      const [lines, counted] = sizes
      if (code_files.length <= SMALL_MAX_FILES && counted <= SMALL_MAX_LINES) {
        tier = 'small'
        why = exempt_note
          ? `${code_files.length} counted file(s) / ${counted} counted line(s), no critical surface${exempt_note}`
          : `${files.length} file(s) / ${lines} changed line(s), no critical surface`
      } else {
        tier = 'full'
        why = exempt_note
          ? `${code_files.length} counted file(s) / ${counted} counted line(s)${exempt_note}`
          : `${files.length} file(s) / ${lines} changed line(s)`
      }
    }
  }

  // A narrowing that changes what could escalate is appended to the reason, whatever branch won. The
  // size measure is the exempt_note above. A suppressed critical match or a refined declaration must
  // show on the one line that every consumer reads.
  const tier_notes = []
  if (crit_suppressed.length) {
    tier_notes.push(`${crit_suppressed.length} critical match(es) on byte-identical derived ` +
                    'copies not counted — criticality follows the source')
  }
  if (decl_note) tier_notes.push(decl_note)
  if (tier_notes.length) why += ' [' + tier_notes.join('; ') + ']'

  hc.say(`review tier: ${tier} — ${why}`)
  if (!(rev.docs_only.length || rev.harness_layer.length || rev.critical.length)) {
    process.stderr.write('  warn: no review surfaces declared in .harness.json — the tier rests on size alone\n')
  }
  return emit_tail(root, cfg, warns, late)
}

// Run only as the entry script, so a selftest can import this file.
const _is_entry = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (_is_entry) process.exitCode = main()
