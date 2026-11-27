// Changed files -> deterministic gate commands + a review-tier verdict. Backend for /ywr-harness:slice-close.
//
// Advisory — nothing is executed, and it exits 0 with ONE exception: when the changed-file scope
// itself cannot be resolved (a git failure), it prints a stdout `scope: FAILED` marker and exits
// non-zero (ywr-harness ADR 0041). An empty advisory output reads as a pass to every consumer — CI greps this
// stdout, and no ungrouped marker + no artifact line + no gate commands is indistinguishable from
// "all clear" — so unknown must fail loudly, the same principle the tier logic already applies
// ("unknown is not small"). It prints the commands a slice close should run BEFORE any LLM review,
// and the review tier those files earn. It also checks any declared claude.ai Artifact against the
// README — link present, title starts with the repo name (ywr-harness ADR 0032); the emitter only reports, and
// the vendored CI fails on `artifact: VIOLATION`. After the tier it also reports every declared group
// whose `match` claims a path the repo's own `.gitignore` rules exclude (`ignored-tree claims:`,
// ywr-harness ADR 0077) — there the ungrouped backstop is blind: a force-added output file would be gated as an
// ordinary member of the group instead of surfacing as ungrouped. Report only; CI does not fail on it.
//
// Usage:
//   node harness_gates.mjs                       # working tree vs HEAD + untracked
//   node harness_gates.mjs --range main~3..HEAD  # slice range UNIONED with the working tree
//   node harness_gates.mjs path/to/file [...]    # explicit files
//   node harness_gates.mjs --all                 # full-tree audit: ls-files + untracked (ywr-harness ADR 0041)
//   node harness_gates.mjs --tree                # prepared-close identity: `tree: <id> · HEAD <id>` (ywr-harness ADR 0105)
//   node harness_gates.mjs --repo <dir>
//
// Both the gate commands and the tier come from `.harness.json` via harness_config, so a repo
// declares WHICH stack and WHICH surfaces it has, never what command runs. Adding a stack is a
// change to the closed `GATES` set in the ywr-harness plugin — reviewed once, available to every repo. A gate
// that is the repo's own script (a path no repo-independent selector could name) is declared as a
// script gate — closed-set runner + validated repo-relative path, ywr-harness ADR 0024 — so the executable is
// still never a repo-supplied string.
//
// ## Why the tier is computed here and not judged in prose
//
// Review proportionality has a cheap wrong answer in both directions: a `/code-review` run on a
// docs-only diff burns tokens, and a skipped review on a diff that touches a critical surface leaves
// the riskiest change unread. The inputs (file count, changed lines, which surfaces
// matched) are mechanical, so they are computed and PRINTED WITH THE REASON — a tier a reader cannot
// audit is a tier nobody can correct.
//
// ## Port conventions
//
// ESM, Node built-ins only, synchronous. `main(argv)` returns the exit code and never calls
// `process.exit`: a piped stdout can be cut by an exit that follows a write. The entry guard at the
// bottom sets `process.exitCode`. Repo-supplied text reaches stdout only through `hc.say`, the one
// exit that keeps every printed line one line (see harness_config.mjs `say`).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as hc from './harness_config.mjs'

const { py_strip } = hc

// Small-tier thresholds. A slice may be small by both measures and still be `full` if it touches
// a declared critical surface — size never overrides criticality.
export const SMALL_MAX_FILES = 5
export const SMALL_MAX_LINES = 150

// The one file whose schema the harness itself owns (ywr-harness ADR 0038). The safe keys feed REPORTING only;
// every other key reaches command composition, tier, or gate coverage, so a change to one is
// critical in every repo, declared or not — the declaration cannot opt itself out.
// `artifacts` is not a safe key: `items[].check` composes a command the CI runs, so an artifacts
// edit is critical (ywr-harness ADR 0068) — over-approximate for a URL/title typo, and erring toward critical
// is the posture the whole mechanism stands on.
export const DECL_FILE = '.harness.json'
export const DECL_SAFE_KEYS = new Set(['docs', 'handoff'])
// Sub-paths of a safe key that reach code execution, reported as their own dotted key so the
// safe-set test fails on them (ywr-harness ADR 0110): `docs.customer.panels[].module` names a .mjs file the
// docs builder IMPORTS (ywr-harness ADR 0060), and CI runs that build.
export const DECL_UNSAFE_SUBPATHS = [['docs', 'customer', 'panels']]

// ---------------------------------------------------------------------------------------------
// Small helpers for the error types a caller branches on. The base reader tags a failed git call
// `CalledProcessError` and a filesystem or spawn failure with a Node `code` and, where it can, the
// Python-style name; both count as "the operation failed" here, anything else is a bug and rethrows.
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

/** Recursively remove '//'-prefixed keys — the schema's comment convention everywhere. A
 * comment edit is prose, not a declaration change, and must compare equal. */
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
 * when that cannot be determined — the caller treats unknown as
 * critical, never as safe (a newly added declaration and an unparseable side both land here).
 * Base = the left side of --range when given, else HEAD; a three-dot range uses the left rev
 * as-is, which for A...B can only over-approximate the change set — erring toward critical.
 * Decoded as UTF-8 explicitly: a declaration carrying non-ASCII (artifact titles do) must not
 * fail or silently mis-compare under a console codepage.
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
    // Through the pinned git boundary (hc.git_run: bytes pipe, explicit UTF-8 decode): a
    // non-UTF-8 byte arrives backslash-escaped and fails JSON.parse (SyntaxError →
    // undeterminable → critical).
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
 * binary, which numstat prints as `-` and the measure skips. A symlink is one line (its target),
 * a directory — an untracked nested repository — one line, like a gitlink. `.gitattributes` is
 * not read: a text file marked `binary` or `-diff` there counts its lines, an error toward the
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
 * files of the scope. `counted` excludes
 * paths `is_exempt` marks as declared docs-only surfaces (ywr-harness ADR 0035) — the size measure should
 * not be inflated by files the declaration already says carry no executable meaning.
 *
 * `git diff` never lists an untracked file, and a slice closes with its new files untracked, so
 * each one would weigh 0 lines — the "unknown treated as 0" error forbidden below. `untracked`
 * is the list `hc.changed_files` already ran for the scope, so their lines are counted here
 * by `added_lines`, with no second git process; a path that cannot be read makes the
 * whole measure unknown.
 *
 * The caller's `is_exempt` must decide by MEMBERSHIP in a set built from the same name-only
 * listing that classified the review scope, never by matching patterns against this function's
 * raw numstat text: a rename record prints as `old => new`, so a `^docs/`-anchored pattern
 * would match the OLD name's prefix and exempt what is now a code file (a docs→code rename
 * carrying hundreds of changed lines would earn `small`). A numstat record that is not a listed clean path (a rename record, a quoted path) therefore
 * COUNTS: unknown is not weightless. null when the diff cannot be measured — reported as
 * unknown rather than assumed small, because an unknown treated as 0 would silently downgrade
 * every tier.
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

/** POSIX only: the scaffold hooks present under `.githooks/` that this checkout holds
 * NON-executable — git runs hooks from the working tree and silently skips one without the
 * bit. Empty string when nothing is wrong or the question does not apply (Windows git invokes
 * hooks through sh regardless of the mode). The committed mode travels with the repo, so a
 * Windows-scaffolded repo (index mode 100644, ywr-harness ADR 0056) surfaces here on every POSIX clone —
 * including CI's ubuntu checkout, which is what makes the gap visible to an all-Windows org.
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

/** True when the clone's `core.hooksPath` value names `root/rel`, whatever FORM it was written
 * in. `git config core.hooksPath .githooks` is the scaffold's spelling, but a hand-wired clone may
 * hold `./.githooks`, an absolute path (`C:\...\.githooks`, `/home/.../.githooks`), or — from Git
 * Bash on Windows — the MSYS form `/c/.../.githooks`, which git for Windows honours but no Node
 * path API does. A literal string compare would report every one of those as "the harness hooks
 * do not run in this clone" while they run. Git resolves a relative value against the work tree's top level, so that is the base here. The
 * `~/`, `~user/` and `%(prefix)/` forms git ALSO accepts for a pathname variable are expanded by
 * git itself before this runs — the caller reads the value with `git config --path`, which is the
 * same expansion the hook runner applies; `--get` alone returns them raw. Both OS-specific
 * rewrites are Windows-only: a POSIX name may legitimately contain a backslash or start `/c/`.
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
    // Windows paths compare without regard to case, as Python's WindowsPath does.
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return false
  }
}

/** One line on whether THIS CLONE has the scaffolded git hooks wired, or null when the repo has
 * no `.githooks/` to wire.
 *
 * `core.hooksPath` lives in `.git/config`, which is per-clone and never committed (ywr-harness ADR 0015). So a
 * repo can carry `.githooks/` in its tree while any given clone runs none of it, and an unwired
 * clone is otherwise indistinguishable from a wired one — the scaffold cannot reach a machine it
 * never ran on, but this line does, because it prints on every /ywr-harness:slice-close and every CI run.
 * The executable bit is the second per-checkout axis of the same gap (ywr-harness ADR 0056), appended by
 * `exec_bit_gap` on the UNSET and wired branches. The foreign-hooksPath branch deliberately
 * omits it: git is not consulting `.githooks/` there, so a chmod suggestion would read as a
 * remedy that fixes nothing — the only remedy on that branch is the hooksPath one.
 * @param {string} root @returns {string|null} */
export function hooks_status(root) {
  if (!_is_dir(path.join(root, '.githooks'))) return null
  // `--show-scope` names the scope that WINS. A core.hooksPath set at the worktree scope
  // (`extensions.worktreeConfig`) outranks `.git/config`, so the `--local` read below alone
  // would call a clone wired while git runs hooks from elsewhere. The output is
  // `<scope>\t<value>`; nothing and exit 1 when the key is unset at every scope.
  // Deliberately NOT through hc.git_run: exit 1 here means the key is unset at that scope — a
  // normal state read from the exit code, not a failure to raise on — so both reads use
  // hc.git_result, the boundary's non-throwing form (ywr-harness spec 0007 §3.1).
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
  // `cur` comes from the clone's own `.git/config`, and the UNSET branch above returns a
  // deliberately TWO-line string — so this is the one status line that cannot go through
  // `hc.say()`. The repo-supplied part is sanitized here instead, which is the documented
  // awkward path for intentional multi-line output.
  return `.githooks/ present but core.hooksPath points at '${hc.one_line(cur)}' — the harness ` +
    'hooks do not run in this clone'
}

// Case-insensitive hex on purpose — an uppercase artifact id must not fail as "not an artifact
// URL" (an over-strict URL gate is a false BLOCK, not a leak).
// `$` without the `m` flag matches the very end of the string only. Python's `$` ALSO matches just
// before a trailing newline, so a `$`-anchored full-match there would pass `<url>\n` while it
// carries the one character that can split an output line: an anchor that admits a newline is not
// a full-match anchor.
// Both link forms the platform issues are accepted (ywr-harness ADR 0104): the Artifact tool's own listing
// returns `claude.ai/artifact/<id>` (a 22-char alphanumeric id) and it reads and publishes to both
// that and `claude.ai/code/artifact/<uuid>`. Accepting only one form would fail CI for a repo
// that declares what the listing handed it.
export const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/artifact\/[0-9A-Fa-f-]+|artifact\/[0-9A-Za-z_-]+)$/

/** [name, source]. The origin remote's basename when one exists — a local clone can be
 * renamed freely, the remote survives it — falling back to the work-tree directory name. The
 * source is always reported: a title judged against a name the reader did not expect must be
 * diagnosable from the output alone.
 * @param {string} root @returns {[string, string]} */
export function repo_name(root) {
  try {
    // Through the pinned git boundary: the decode is explicit UTF-8, never the console codepage.
    // No origin → exit 2 → the fallback.
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
 * (ywr-harness ADR 0032) — `ok` or `VIOLATION` — or the `none declared` report. The vendored CI fails on
 * `^artifact: VIOLATION`; the emitter itself stays advisory. Violations are ALSO appended to
 * `warns`: stdout is where CI's fail step reads, stderr is what the pre-commit hook shows a
 * human. A malformed declaration is a VIOLATION, never a drop — a typo that silently disabled
 * enforcement would read as coverage (the same posture as CI failing on an unparseable
 * settings file).
 *
 * Two per-item keys beyond `url` and `title` (ywr-harness ADR 0068). `source` (the committed Artifact source file) is
 * completeness: the path must be allowlist-clean and EXIST. `check` ({runner, script},
 * validated by `hc.artifact_check`) composes ONE whole-program command per valid item,
 * returned for the caller to emit inside the `gates:` window — CI's existing extraction runs
 * it, pre-commit's existing `# whole-program` rule defers it, and the window's `seen` set
 * dedupes it against an identical group gate. A check on a VIOLATING item is never returned:
 * half-validated enforcement reading as enforcement is the defect class this line exists for.
 *
 * The lines are returned, not printed: `hc.say()` is the single stdout exit that guarantees one
 * line per line, so nothing here needs to remember to escape. That guarantee is load-bearing —
 * the values echoed below are repo-supplied, and one carrying a newline would otherwise forge the
 * `gates:` … `review tier:` window both output parsers execute from (see `say`).
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
    // A control character is refused at the DECLARATION layer too, not only escaped for
    // display: `one_line()` keeps the output honest whatever is declared, but a declaration
    // carrying a newline is either a typo or an attempt to forge an output line, and both
    // deserve to be told rather than quietly rendered as `\n`.
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
    // --- ywr-harness ADR 0068: committed source + drift check ----------------------------------
    // `src` on purpose — `source` above is the repo-NAME provenance from repo_name().
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
      // A url+title-only item (ywr-harness ADR 0032's shape) is legal, but a bare ok line would match
      // none of the artifact-publish skill's step-1 shapes and leave the skill without a
      // defined outcome. Name the shape: hand-published, nothing committed to republish
      // from — the skill's taxonomy and this line must agree.
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

// A sticky copy of a compiled pattern: `re.match`, anchored at the start, without rebuilding the
// RegExp for every path.
function _start_matcher(rx) {
  const sticky = new RegExp(rx.source, rx.flags.replace(/[gy]/g, '') + 'y')
  return (s) => {
    sticky.lastIndex = 0
    return sticky.test(s)
  }
}

// --- ignored-tree claims (ywr-harness ADR 0077) ---------------------------------------------------
// Rules named per group line before the "+N more" note. The cap is SAID on the line, never
// applied silently (a capped report states its cap).
export const IGNORED_CLAIMS_MAX_RULES = 3

/** The `.gitignore` files that are part of the COMMIT — root and nested — as `git ls-files`
 * reports them. Membership in this set, not a path-shape test, is what makes a `check-ignore -v`
 * source "the repo's own": every other source git consults is per-clone — `.git/info/exclude`,
 * `core.excludesFile` (absolute, `~`-expanded, or RELATIVE and pointing at an untracked in-tree
 * file that happens to be named `.gitignore`: its source prints as `local/.gitignore`,
 * byte-for-byte like a committed one), and an untracked `.gitignore` a member dropped into the
 * tree. Example: a user's global ignore may exclude `.claude/settings.local.json`, a path a
 * declared group claims on purpose — counted, the line would fire on that machine and never in
 * CI. NUL-separated, paths verbatim.
 * @param {string} root @returns {Set<string>} */
export function tracked_ignore_files(root) {
  const raw = hc.git_run(root, ['ls-files', '-z', '--', '.gitignore', ':(glob)**/.gitignore'])
  return new Set(raw.split('\0').filter((p) => p).map(hc.norm))
}

/** Report every declared group whose `match` also claims a path the repo's `.gitignore` rules
 * exclude (ywr-harness ADR 0077). Where a group claims an ignored tree the ungrouped backstop is blind: a
 * result or build file that is force-added (`git add -f`) is claimed, gated as an ordinary
 * member of the group, and never surfaces as ungrouped — for example an `evals` group matching
 * `evals/results/**\/*.md` swallows such files unless its pattern carries a `(?!results/)`
 * lookahead. A gitignored UNTRACKED file never reaches the emitter (`ls-files --others
 * --exclude-standard`), so this is the only place the overlap is visible before the force-add.
 *
 * Three git calls through the pinned `hc.git_run`, all `-z` so paths travel verbatim (the
 * line-shaped forms C-quote a control character, and a newline-separated `--stdin` list is not
 * a shape this boundary should ever send — a text-mode pipe on Windows turns it into `path\r`;
 * the boundary is bytes, and `-z` keeps the paths verbatim):
 * `ls-files --others --ignored --exclude-standard` for the set git excludes (every source, so
 * it is exactly what the partition never sees); `ls-files -- .gitignore **\/.gitignore` for the
 * COMMITTED policy (`tracked_ignore_files`); `check-ignore -v -n --no-index --stdin` over the
 * ignored list for the DECIDING rule per path — `-n` so a path git listed as ignored but does
 * not re-confirm (a `.gitignore` edited or a file removed between the two calls) yields an
 * empty-source record and is COUNTED as unconfirmed instead of vanishing from a fixed-stride
 * parse. A rule counts only when its source is a TRACKED `.gitignore`,
 * read as it stands in the working tree (an uncommitted edit to one counts but shows in `git
 * status`, unlike the invisible per-clone sources this filter removes), so the RULE side of
 * this report follows the commit's policy files; the PATH side is what exists in this
 * checkout — a CI clone that never produced the output tree checks nothing and says so,
 * a slice-close run after a build or an eval is where this fires. "Claims" is the
 * partition's own test (the start-anchored match on the same compiled group regex), so the word means
 * exactly what it means in the `gates:` window. Never throws on a git failure, never silent — a
 * git failure prints NOT CHECKED. `warns` is the caller's sink for a group regex that does not compile,
 * deduplicated against what the gates loop already queued (on the `--all` empty-tree path
 * that loop never runs, so this is the only place such a pattern is named). Returns lines; the
 * caller prints them through `hc.say` (column-0 header, 2-space `groups[…]` detail lines —
 * neither shape is a group header or a command to either output parser, and on every path
 * that prints a trailer they sit after `hooks:`; a `review tier:` line precedes them whenever
 * a tier was computed — the `--all` empty-tree trailer has none, and no `gates:` window
 * either, so no parser range is open there).
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
      // Exit 1 is check-ignore's "no path was ignored" — a verdict, not a failure; with
      // `-n` its records are still on stdout (every one empty-source). Anything else is.
      if (e.returncode !== 1) {
        return ['ignored-tree claims: NOT CHECKED — git check-ignore failed: ' +
                `${py_strip(e.stderr || '')} (not a pass)`]
      }
      out = e.stdout || ''
    }
    // `-v -n -z` records are four NUL-terminated fields: source · linenum · pattern · pathname,
    // nothing quoted; a non-matching path carries three EMPTY fields before its name.
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
    // Python sorts the rule tuples: source by code point, then line number, then pattern.
    const rules = [...counts.values()].map(([rule]) => rule).sort((a, b) =>
      hc._cmp(a[0], b[0]) || a[1] - b[1] || hc._cmp(a[2], b[2]))
    // A pattern is repo-supplied text: a backtick inside one would close the code span this
    // line opens around it (cosmetic; control characters are one_line's job at the exit).
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

// Python's `\s` for a str pattern is the set `str.isspace()` accepts; JavaScript's `\s` differs at
// U+001C-U+001F, U+0085 and U+FEFF. The class is built from numbers, so no source line holds a raw
// separator character.
const _PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f ' + String.fromCharCode(0x85, 0xa0, 0x1680) +
  String.fromCharCode(0x2000) + '-' + String.fromCharCode(0x200a) +
  String.fromCharCode(0x2028, 0x2029, 0x202f, 0x205f, 0x3000)

// `.` is spelled `[^\n]` below: the lines are split on `\n`, `\r` and `\r\n` only, so a line may
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
 * A probe on host 2.1.331 (ywr-harness fact 250) loaded no import from a fenced code block, an
 * indented code block or a code span. A fence closes only on its own character, at least as
 * long, with nothing after it, so a `~~~` line inside a backtick fence stays code. An indented
 * line is code after a blank line. It is code too after a column-0 closing fence, ATX heading,
 * thematic break or setext underline, because each of them ends the paragraph before it
 * (ywr-harness fact 256). The same block indented by one to three spaces can sit inside a list
 * item, where the next indented line is item text. The reader tracks no list, so it leaves the
 * state alone after an indented block. A list item's indented paragraph after a blank line reads
 * as code here, which errs toward NOT IMPORTED. A code span can cross a line break, so spans are
 * removed per paragraph. The session-start scaffold nudge has the same reader in Node; keep the
 * two in step.
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

// Windows paths ignore case, and the probe loaded `@C4.MD` for c4.md there; the fold applies on
// Windows only. `_resolve` expands an 8.3 short name and a link, so an absolute token spelled
// through either still names the file that the session loads.
function _norm_target(p) {
  const abs = _resolve(p)
  return process.platform === 'win32' ? abs.replaceAll('/', '\\').toLowerCase() : abs
}

// `os.path.expanduser` for the `~` and `~/…` forms: the home directory plus the rest of the token.
function _expanduser(tok) {
  return os.homedir().replace(/[\\/]+$/, '') + tok.slice(1)
}

/** The first of IMPORT_FILES that imports `canon`, or '' (ywr-harness ADR 0215).
 *
 * `/code-review` reads CLAUDE.md, never a separate canon file, so a canon outside the memory files
 * reaches the slice review only through an `@<path>` import (ywr-harness ADR 0217). A token counts when it starts a line or follows whitespace, after
 * import_text removed the code. A backslash-escaped space belongs to the token. A relative token
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

// One line at a time, never with the `m` flag: JavaScript's `^` and `$` then also break at `\r`,
// U+2028 and U+2029, and Python's break at `\n` only.
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

/** The common trailer after the tier line — review canon, handoff, hooks, queued warnings.
 * Shared by the per-slice path and the full-tree audit path (ywr-harness ADR 0041) so the two can never
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
    // A trailing '/' declares a per-work-line directory (ywr-harness ADR 0040); annotated here so the
    // close instruction "update the handoff the emitter named" is unambiguous where it is read.
    const hint = cfg.handoff.endsWith('/') ? ' — directory: one resume file per work line' : ''
    hc.say(`handoff: ${cfg.handoff}${hint}`)
  }

  // Printed AFTER the tier so the hook's output parser (which stops at `review tier:`) can never
  // mistake it for a gate command.
  const hooks = hooks_status(root)
  if (hooks) process.stdout.write(`hooks: ${hooks}\n`)

  // A tree fact like `hooks:` — a declaration-vs-.gitignore overlap is not a diff property —
  // so it rides the trailer wherever one prints: a per-slice run with a NON-EMPTY scope, and
  // the `--all` audit even over an empty tree. The per-slice empty-scope path prints no trailer
  // at all (no `hooks:` either, by the same design — a clean tree is not a slice;
  // `--all` is the tree audit), so the report is ABSENT there rather than silent about a
  // checked state (ywr-harness spec 0007 §3.2 and the slice-close skill say so). Report only (ywr-harness ADR 0077); CI does not grep it. `late` is the compile-warning sink.
  for (const line of ignored_claims(root, cfg, late)) hc.say(line)

  for (const w of [...warns, ...late]) hc.warn(w)
  return 0
}

// ---------------------------------------------------------------------------------------------
// Command line. The flags and the messages follow Python's argparse, which the original script
// used, so a caller's scripts and a person's habits keep working: prefix abbreviations of a long
// option (`--ra`), `--opt=value`, `--` to end the options, a positional list that may only start
// once, and exit status 2 with a usage block on stderr for a refusal. The usage block wraps at 78
// columns, argparse's width on an 80-column terminal; `COLUMNS` is not read.
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
    // Its own mode, never a line in the per-slice output: that output is what CI and
    // pre-commit parse, and a snapshot writes git objects no gate run should pay for.
    if (args.all_files || args.rev_range || args.files.length) {
      process.stderr.write('note: --tree given — ignoring --all, --range and explicit files\n')
    }
    let tree
    let head
    try {
      [tree, head] = hc.worktree_snapshot(root)
    } catch (e) {
      // An OS failure too: a locked or unreadable index, or no temp dir, must print the same
      // marker, never a traceback a reader might retry or paraphrase.
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
    // The one non-zero exit in this advisory script (ywr-harness ADR 0041). A silent return here passed
    // every downstream consumer: stdout is what CI greps, and an empty stdout carries no
    // ungrouped marker, no artifact line, and no gate commands — a job that ran nothing
    // reads green. Typical triggers: an unreachable ref, a force-pushed base branch, a
    // stale fetch.
    process.stderr.write(`git failed: ${py_strip(e.stderr || '')}\n`)
    hc.say('scope: FAILED — git could not resolve the changed-file scope; NOTHING below was ' +
           'computed. This run must not be read as a pass (ywr-harness ADR 0041).')
    return 1
  }

  const late = []
  hc.print_scope(files, prov)
  // Above `gates:` on purpose — outside the window both output parsers consume — and BEFORE the
  // empty-scope return: CI's push-to-main run has no changed files and is an enforcement point.
  // The drift-check COMMANDS ride the gates window below instead (ywr-harness ADR 0068), so the empty-scope
  // path prints the completeness lines but runs no check; the next real slice and the publish
  // skill re-check.
  const [art_lines, art_checks] = artifact_status(root, cfg, late)
  for (const line of art_lines) hc.say(line)
  if (!files.length) {
    if (prov.source === 'all') {
      // A full-tree audit's trailer facts (review-canon existence, hooks wiring) are TREE
      // facts, not diff facts — an empty tree still has answers, and hooks_status's own
      // contract says it prints on every CI run.
      hc.say('no changed files — nothing to gate')
      return emit_tail(root, cfg, warns, late)
    }
    for (const w of [...warns, ...late]) hc.warn(w)
    hc.say('no changed files — nothing to gate')
    return 0
  }

  // --- groups -> gate commands ---------------------------------------------------------------
  // Keyed by POSITION, not by name. A name is a label — two groups can legitimately share one, and
  // since names are sanitized for display two DIFFERENT declared names can also collapse to the
  // same escaped string. Either way a name-keyed map silently hands one group the other's file
  // list, so each group's own gates would run against files it never claimed. The index is the
  // only key that is unique by construction.
  const grouped = cfg.groups.map((g) => {
    const rx = hc.compile_re(g.match, `groups[${g.name}].match`, late)
    if (!rx) return []
    const claims = _start_matcher(rx)
    return hc._sorted(files.filter((f) => claims(f)))
  })

  const claimed = new Set(grouped.flat())
  const leftover = files.filter((f) => !claimed.has(f))
  // Built-in claims (ywr-harness ADR 0044): scaffold-placed paths no declared group matched. Declared
  // groups win by construction — only leftovers are consulted — and the claim is REPORTED
  // below, never silent: an absorbed file that printed nowhere would read as coverage.
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
    // A deleted file is never a file-scoped argument (ywr-harness ADR 0112): nothing is left to check, a
    // plain one fails the tool for nothing, and a `[id]` one is globbed by eslint/prettier onto
    // a sibling that then passes. Dropped before the unsafe check (a deleted name is not an
    // ungated file) and said on parenthesized lines, like the exclusions below.
    const absent = g.gates.some((gate) => hc.gate_is_scoped(gate)) ? hc.absent_files(root, fs_) : []
    if (absent.length) {
      hc.say(`    (${absent.length} changed file(s) absent from the working tree — deleted, ` +
             'or removed from disk while still staged — nothing on disk for this group\'s ' +
             'file-scoped gates to read)')
      for (const f of absent) hc.say(`    (absent: ${f})`)
      const gone = new Set(absent)
      fs_ = fs_.filter((f) => !gone.has(f))
    }
    // A filename is repo-supplied text: one containing a space, quote or '#' cannot be passed
    // through `sh -c` (or past either output parser) as one argument, so it is left OUT of the
    // gate's argument list. Never silent — an excluded file is an ungated file.
    const unsafe = hc.unsafe_files(g, fs_)
    if (unsafe.length && g.gates.some((gate) => hc.gate_is_scoped(gate))) {
      // "UNGATED" would overstate the loss when the group ALSO declares a whole-program gate:
      // that gate runs regardless of the argument list, so the excluded file is still
      // covered by it — only the file-scoped coverage is lost. The
      // coverage claim must match what actually runs, in both the note and the warning.
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
        // A filename is repo-supplied text, and this line sits INSIDE the gate-command
        // window: the leading `(` keeps the first line out of both parsers, but a name
        // carrying a newline would put its remainder on a line that starts with four
        // spaces and no `(` — a forged command. git's default `core.quotePath` escapes such
        // names, which is a mitigation living in someone else's config, not a guarantee.
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
        // gate_command refused or skipped this one. It is already a parenthetical, so it
        // prints as-is (both parsers skip it) and must NOT count toward `emitted` — a
        // refusal that inflated the count would read as a gate that ran.
        hc.say(`    ${cmd}`)
        continue
      }
      if (seen.has(cmd)) {
        // A whole-program gate declared on several groups composes to the same command,
        // and running it once per group is waste, not coverage. The '(' prefix keeps this
        // line out of both output parsers (CI extraction and pre-commit exclude it).
        hc.say(`    (already emitted above — deduplicated: ${cmd})`)
        continue
      }
      seen.add(cmd)
      const whole = hc.gate_is_scoped(gate) ? '' : '   # whole-program: gate on slice files or newly introduced only'
      hc.say(`    ${cmd}${whole}`)
      emitted++
    }
  })
  // Declared-artifact drift checks (ywr-harness ADR 0068) — after the group gates, inside the same window,
  // so CI's extraction runs them and pre-commit's `# whole-program` rule defers them. The
  // header keeps the group-header shape (2-space `[label]`); the two COMMAND parsers (CI sed +
  // pre-commit CMDS awk) skip it, and pre-commit's THIRD parser — the MATCHED_GROUPS awk, which
  // reads 2-space `[label]` lines as group names — skips it by an explicit rule that matches
  // the header's leading `[artifacts] N declared drift check` text. Without that rule the
  // report is garbled on every commit that declares an artifact check and has an empty CMDS.
  // Changing that leading text means changing the awk rule too.
  // `seen` collapses a check a group already declared as its own gate.
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
    // Three causes share this line, and the third is easy to miss: a group can DECLARE gates
    // and still emit none, because every one was refused at load or skipped/refused at
    // composition (the parentheticals above). The ywr-harness plugin's own selftests match
    // this exact string, so a change here is a change to the plugin, not to this copy.
    hc.say('  (none — no declared group matched, matched groups declare no gates, or every ' +
           'declared gate was refused or skipped)')
  }

  // Built-in scaffold claims, stated with every path (ywr-harness ADR 0044). Line shapes are chosen for
  // the two output parsers: a column-0 header that matches neither window-close sentinel
  // (`^ungrouped (` / `^review tier:`) nor CI's `^ungrouped (` failure grep, and 2-space file
  // lines that neither extractor (`^ {4}[^ (]`, awk `/^    [^ (]/`) can read as a command.
  // The paths printed here are constants from the closed set, never repo-supplied text.
  if (scaffold_claimed.length) {
    hc.say(`scaffold-claimed (${scaffold_claimed.length} file(s) — placed or written by ` +
           '/ywr-harness:harness-init and claimed built-in; no groups entry needed — ywr-harness ADR 0044):')
    for (const f of scaffold_claimed) hc.say(`  ${f}`)
  }

  // Never silent: a file no group claims is a file no deterministic gate sees.
  if (ungrouped.length) {
    // The tail names the consequence: CI's "Fail on ungrouped files" step hard-fails on this
    // header while every local run stays advisory (ywr-harness ADR 0041's exit contract), so without it a
    // repo reads as passing right up to its first CI run (ywr-harness ADR 0062).
    hc.say(`ungrouped (${ungrouped.length} file(s) — no declared group matched, so NO deterministic gate covers them; ` +
           "CI's harness-gates run FAILS on this — add a groups entry to .harness.json):")
    for (const f of ungrouped) hc.say(`  ${f}`)
  }

  // --- review tier ---------------------------------------------------------------------------
  if (prov.source === 'all') {
    // A tier is a slice property (ywr-harness ADR 0041): a whole tree earning "small" in a tiny repo
    // would be a meaningless label, and the declaration-diff and line-count measures below
    // answer questions no full-tree audit is asking. The line keeps the `review tier:`
    // prefix, which both output parsers (CI sed, pre-commit awk) use as their window-close
    // sentinel — an audit run that dropped it would hand the parsers an unterminated window.
    hc.say('review tier: full-tree audit — a tier applies to a slice; this run checks ' +
           'partition, artifact, and gate coverage over the whole tree (ywr-harness ADR 0041)')
    return emit_tail(root, cfg, warns, late)
  }

  const rev = cfg.review
  // docs_only is compiled ONCE: the same patterns are consulted per changed file AND per
  // numstat path, and compile_re warns on every call for a bad pattern — once per pattern is
  // the signal, N× is noise.
  const docs_rx = rev.docs_only.map((p) => hc.compile_re(p, 'review.docs_only', late)).filter((rx) => rx)

  const docs_exempt = (p) => docs_rx.some((rx) => rx.test(p))

  // The exemption sets are built from `files` — the SAME name-only listing that builds
  // `code_files` below — and changed_lines gets a membership test, never the regexes: one
  // classification, two measures, so the branch decision and the printed figures cannot
  // disagree, and a numstat rename record (`old => new`) can never regex-match its OLD name
  // into an exemption (a docs→code rename would otherwise count as docs-only).
  const docs_paths = new Set(files.filter(docs_exempt))

  // Derived-copy exemption (ywr-harness ADR 0037): a changed file under a declared copies prefix whose
  // CURRENT bytes equal its mapped source's adds no review surface — the deterministic
  // identity gate owns that relationship. Identity is a tree property, so BOTH sides are read
  // from the worktree: a drifted or deleted copy counts fully (and the identity gate fails the
  // build anyway). Chains are not resolved — every copies prefix maps directly to its
  // canonical source.
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
      // A symlink's DIFF is its target string, but a content read follows it — a link
      // retargeted at the source itself would compare "identical" while the reviewed
      // change is a redirection. Refused in the conservative direction: a link is never
      // an exempt copy, on either side.
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
  // `skip` stays a docs-only decision (ywr-harness ADR 0037): derived files never contribute to the
  // all-docs test, so a pure propagation diff earns `small` via an empty counted set, not
  // `skip` — the exemption narrows the measure and the criticality attribution, never the
  // trust class.
  const docs_only = rev.docs_only.length > 0 && files.every((f) => docs_paths.has(f))
  const critical_rx = compile_all(rev.critical, late, 'review.critical')
  const critical_all = files.filter((f) => hc.any_match(critical_rx, f))
  // A byte-identical copy cannot force `critical` — the source's own classification decides
  // (ywr-harness ADR 0037). Suppression is stated on the tier line below, never silent.
  let critical = critical_all.filter((f) => !derived_paths.has(f))
  const crit_suppressed = critical_all.filter((f) => derived_paths.has(f))
  const code_files = files.filter((f) => !exempt_paths.has(f))
  const layer_rx = code_files.length ? compile_all(rev.harness_layer, late, 'review.harness_layer') : []
  const harness_only = layer_rx.length > 0 && code_files.every((f) => hc.any_match(layer_rx, f))

  // The declaration's criticality is COMPUTED from which keys changed (ywr-harness ADR 0038): the safe
  // keys feed reporting only; anything else — or a diff that cannot be determined — is
  // critical in every repo, declared or not. Either way the verdict is stated with its input.
  let decl_note = ''
  if (files.includes(DECL_FILE)) {
    // Explicit-files mode ignores --range everywhere else (print_scope says so on stderr),
    // so the base must not come from it here either — HEAD is the honest base for a
    // worktree question.
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

  // Size is measured over the non-exempt subset (ywr-harness ADR 0035/0037): docs_only files
  // and byte-identical derived copies riding along with a small behavioral change inflate the
  // total without adding review surface. The SCOPE is not narrowed anywhere — only the measure
  // — and a non-empty exclusion is stated on the tier line, never silent. With neither class
  // in the diff the counted figures equal the totals and the wording below is byte-identical
  // to the unweighted form.
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
    // Measured only here: no earlier branch reads a line count, and the measure reads every
    // untracked file of the scope to its end, so a critical, skip or harness-layer verdict
    // pays neither that read nor the numstat calls. `prov.untracked` has no default: a
    // scope without the list must fail loudly, never weigh its new files at 0 lines.
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

  // Narrowings that changed WHAT could escalate — as opposed to the size measure, which the
  // exempt_note above covers — are appended to the reason itself, whatever branch won: a
  // suppressed critical match or a refined declaration must be visible on the one line every
  // consumer reads (no silent caps).
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

// Run as a script, not when another file imports it (the selftest driver does).
const _is_entry = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (_is_entry) process.exitCode = main()
