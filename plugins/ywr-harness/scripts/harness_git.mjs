// The git subprocess boundary of the harness scripts (ywr-harness ADR 0077 and ywr-harness ADR 0220 decision 9).
// Node built-ins only, ESM, no install step: this file is copied into consumer repositories as
// `scripts/harness/harness_git.mjs`, where no plugin exists, so it imports nothing but `node:` modules.
//
// Every git call whose output is parsed goes through `git_run`, `git_lines`, `git_paths`, `git_objects`,
// `git_result` or `git_result_async`. The pins, the UTF-8 decode and the NUL framing live here and nowhere else. Why:
//   - The argv is an array and no shell runs, so a repo-supplied value is never re-split or expanded.
//   - Both pipes are bytes. A text-mode pipe would translate newlines on Windows and turn a
//     newline-separated `--stdin` list into `path\r`, which no exact-name ignore rule matches.
//   - The output is decoded once, as UTF-8, with `backslashreplace` error handling. A path that is
//     not UTF-8 must show up visibly mangled and must keep distinct bytes distinct. A merged
//     U+FFFD would collapse two paths into one set entry and shrink an audit scope silently.
//   - A path LIST travels NUL-separated in both directions (`-z`), because that framing carries a
//     path verbatim.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

/**
 * The options `git_run` puts before every command. The color pins: a user's `color.grep=always`
 * puts ESC codes before each `git grep` path, and the parsed keys silently stop matching.
 * `color.ui=false` alone does not win against a command's own key, so the key of each colored
 * command family is pinned too. `core.quotepath=false` keeps a non-ASCII path raw: git's default
 * octal-escapes it, and no anchored group pattern matches the escaped form.
 */
export const GIT_PINS = Object.freeze(['-c', 'core.quotepath=false', '-c', 'color.ui=false',
  '-c', 'color.grep=false', '-c', 'color.diff=false', '-c', 'color.status=false',
  '-c', 'color.branch=false', '-c', 'color.showBranch=false'])

// ---------------------------------------------------------------------------------------------
// Python-compatible string helpers. They live in this file because `norm` runs at the boundary
// and harness_config.mjs re-exports them. A JavaScript `trim()` differs from Python's `strip()`:
// Python counts U+001C-U+001F, U+0085 and the Unicode spaces, and JavaScript counts U+FEFF.
// ---------------------------------------------------------------------------------------------
function _isspace(c) {
  return (c >= 9 && c <= 13) || (c >= 0x1c && c <= 0x20) || c === 0x85 || c === 0xa0 ||
    c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000
}

/** `str.strip()` with no argument: strips every Python whitespace character at both ends. */
export function py_strip(s) {
  s = String(s)
  let a = 0
  let b = s.length
  while (a < b && _isspace(s.charCodeAt(a))) a++
  while (b > a && _isspace(s.charCodeAt(b - 1))) b--
  return s.slice(a, b)
}

/** `norm(path)`: backslashes to `/`, Python-stripped. */
export function norm(p) {
  return py_strip(String(p).replaceAll('\\', '/'))
}

// Python's `repr` of a string keeps a printable character as it is and escapes the rest. It lives
// here because the failure message of `git_run` is Python's `str(CalledProcessError)`, which prints
// the argv as a list of reprs, and harness_config.mjs re-exports it.
const _NONPRINT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u
const _BS = String.fromCharCode(92)

/** `repr(s)` for a str: single quotes, or double quotes when `s` holds only single ones. */
export function _repr_str(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = q
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (ch === q || ch === _BS) out += _BS + ch
    else if (ch === '\n') out += _BS + 'n'
    else if (ch === '\r') out += _BS + 'r'
    else if (ch === '\t') out += _BS + 't'
    else if (ch !== ' ' && _NONPRINT.test(ch)) {
      out += c < 0x100 ? _BS + 'x' + c.toString(16).padStart(2, '0')
        : c < 0x10000 ? _BS + 'u' + c.toString(16).padStart(4, '0')
          : _BS + 'U' + c.toString(16).padStart(8, '0')
    } else out += ch
  }
  return out + q
}

// ---------------------------------------------------------------------------------------------
// git resolved ONCE on PATH. A bare `git` spawn does more than a PATH lookup: libuv searches the
// current directory first on Windows, so a `git.exe` planted in an untrusted repository would run;
// on Unix an unset PATH falls back to a default one. The absolute path closes both.
// ---------------------------------------------------------------------------------------------
/**
 * The first launchable `name` on PATH, as an absolute path, or '' (the lookup PowerShell's
 * `Get-Command` made, which never looked outside PATH). Windows: `<name>.exe` or `<name>.com` only,
 * because a `.cmd` or `.bat` shim needs a shell. Elsewhere: an executable regular file, symlinks
 * followed. A relative PATH entry is skipped.
 * @param {string} name
 * @param {string} [envPath] defaults to the PATH of this process
 * @returns {string}
 */
export function which_on_path(name, envPath = process.env.PATH) {
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

let _gitExe
function _git() {
  if (_gitExe === undefined) _gitExe = _real_git(which_on_path('git'))
  return _gitExe
}

/**
 * Git for Windows puts a launcher, `<install>\cmd\git.exe`, on PATH. The launcher starts the real
 * `git.exe` from the install's MinGW tree. Every start is hidden (`windowsHide`), because a hook or
 * a background command can run without a console, and then each git would flash a window. Through
 * the launcher, a hidden start cost about 26 ms more per call, a quarter of a git-heavy run. So the
 * real binary is started directly when it sits where the installer puts it. Any other layout keeps
 * the PATH entry.
 * @param {string} exe the git that PATH resolved
 * @returns {string}
 */
export function _real_git(exe) {
  if (!exe || process.platform !== 'win32') return exe
  const dir = path.dirname(exe)
  if (path.basename(dir).toLowerCase() !== 'cmd' || path.basename(exe).toLowerCase() !== 'git.exe') return exe
  for (const tree of ['mingw64', 'clangarm64', 'mingw32']) {
    const real = path.join(path.dirname(dir), tree, 'bin', 'git.exe')
    try { if (fs.statSync(real).isFile()) return real } catch { /* not this layout */ }
  }
  return exe
}

/** True when no git is on PATH. The first call resolves git, and later calls reuse the answer. */
export function git_absent() {
  return !_git()
}

// ---------------------------------------------------------------------------------------------
// Decode: UTF-8 with Python's `errors="backslashreplace"`. TextDecoder can only fatal or
// substitute U+FFFD, so the invalid bytes are escaped here. An ill-formed sequence is cut at its
// maximal valid prefix, as Python's decoder reports it, and each byte of that prefix becomes
// `\xNN` in lower-case hex.
// ---------------------------------------------------------------------------------------------
const _STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Bytes to text, decoded once as UTF-8. Invalid bytes become `\xNN` text. A byte-order mark stays
 * in the text, as in Python.
 * @param {Uint8Array} buf
 * @returns {string}
 */
export function decode_utf8_backslashreplace(buf) {
  try {
    return _STRICT.decode(buf)
  } catch { /* at least one invalid sequence: the slow path below */ }
  const out = []
  const n = buf.length
  const cont = (b) => b >= 0x80 && b <= 0xbf
  let i = 0
  while (i < n) {
    const b = buf[i]
    if (b < 0x80) { out.push(String.fromCharCode(b)); i++; continue }
    let need = 0
    let lo = 0x80
    let hi = 0xbf
    if (b >= 0xc2 && b <= 0xdf) need = 1
    else if (b === 0xe0) { need = 2; lo = 0xa0 }
    else if (b === 0xed) { need = 2; hi = 0x9f }
    else if ((b >= 0xe1 && b <= 0xec) || b === 0xee || b === 0xef) need = 2
    else if (b === 0xf0) { need = 3; lo = 0x90 }
    else if (b === 0xf4) { need = 3; hi = 0x8f }
    else if (b >= 0xf1 && b <= 0xf3) need = 3
    let used = 1
    let ok = need > 0
    if (ok) {
      for (let k = 1; k <= need; k++) {
        const c = buf[i + k]
        const inRange = k === 1 ? (c !== undefined && c >= lo && c <= hi) : (c !== undefined && cont(c))
        if (!inRange) { ok = false; break }
        used++
      }
    }
    if (ok) {
      let cp = need === 1 ? b & 0x1f : need === 2 ? b & 0x0f : b & 0x07
      for (let k = 1; k <= need; k++) cp = (cp << 6) | (buf[i + k] & 0x3f)
      out.push(String.fromCodePoint(cp))
      i += need + 1
    } else {
      for (let k = 0; k < used; k++) out.push('\\x' + buf[i + k].toString(16).padStart(2, '0'))
      i += used
    }
  }
  return out.join('')
}

// ---------------------------------------------------------------------------------------------
// The spawn.
// ---------------------------------------------------------------------------------------------
const _MAX_BUFFER = 2 ** 30   // 1 GiB: a large repository's `ls-files` must never be truncated

function _is_dir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function _spawn_error(name, message, props = {}) {
  const e = new Error(message)
  e.name = name
  return Object.assign(e, props)
}

/**
 * One git command, never throwing for a non-zero exit. Returns `{status, stdout, stderr}`:
 * `status` is the exit code (negative signal number when git was killed), both streams are decoded
 * strings. Throws only when git cannot start, an Error named `FileNotFoundError` (no git on PATH,
 * or `root` is not a directory, `.code` is `ENOENT`) or `OSError` (any other spawn failure).
 * For the commands where the exit code is the answer (`check-ignore`, `config --get`, a `rev-parse
 * --verify` probe).
 * @param {string} root working directory of the command
 * @param {string[]} args git arguments, without the pins
 * @param {{stdin?: string|null, env?: Object<string,string>|null}} [opts] `stdin` is sent as UTF-8
 *   bytes; `env` is added to the inherited environment
 * @returns {{status: number, stdout: string, stderr: string, cmd: string[]}}
 */
export function git_result(root, args, { stdin = null, env = null } = {}) {
  const r = _spawn(root, args, stdin === null || stdin === undefined ? undefined : Buffer.from(stdin, 'utf8'), env)
  return {
    status: r.status,
    stdout: decode_utf8_backslashreplace(r.stdout),
    stderr: decode_utf8_backslashreplace(r.stderr),
    cmd: r.cmd,
  }
}

/**
 * `git_result` without blocking the event loop, so a slow network command such as `fetch` or
 * `ls-remote` overlaps other work (ywr-harness ADR 0233). Same pins, same decode, same result
 * shape. The promise rejects only when git cannot start, with the errors that `git_result` throws.
 * @param {string} root working directory of the command
 * @param {string[]} args git arguments, without the pins
 * @param {{stdin?: string|null, env?: Object<string,string>|null}} [opts]
 * @returns {Promise<{status: number, stdout: string, stderr: string, cmd: string[]}>}
 */
export function git_result_async(root, args, { stdin = null, env = null } = {}) {
  return new Promise((resolve, reject) => {
    const exe = _git()
    if (!exe) { reject(_spawn_error('FileNotFoundError', 'git was not found on PATH', { code: 'ENOENT' })); return }
    const cmd = ['git', ...GIT_PINS, ...args]
    const fail = (e) => {
      let name = e.code === 'ENOENT' ? 'FileNotFoundError' : 'OSError'
      if (name === 'FileNotFoundError' && process.platform === 'win32' && !_is_dir(root)) name = 'NotADirectoryError'
      reject(_spawn_error(name, `git could not run: ${e.message}`, { code: e.code }))
    }
    let child
    try {
      child = spawn(exe, [...GIT_PINS, ...args], {
        cwd: root,
        env: env === null || env === undefined ? undefined : { ...process.env, ...env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) { reject(e); return }   // an invalid argument throws as `spawnSync` throws it in `git_result`
    const out = []
    const err = []
    let pending = true
    child.stdout.on('data', (b) => out.push(b))
    child.stderr.on('data', (b) => err.push(b))
    child.on('error', (e) => { if (pending) { pending = false; fail(e) } })
    // `close` fires after both pipes end, so every byte is read before the decode.
    child.on('close', (code, signal) => {
      if (!pending) return
      pending = false
      const status = code ?? -(os.constants.signals[signal] ?? 1)
      resolve({
        status,
        stdout: decode_utf8_backslashreplace(Buffer.concat(out)),
        stderr: decode_utf8_backslashreplace(Buffer.concat(err)),
        cmd,
      })
    })
    child.stdin.on('error', () => { /* git exited before it read stdin: the exit code is the answer */ })
    child.stdin.end(stdin === null || stdin === undefined ? undefined : Buffer.from(stdin, 'utf8'))
  })
}

/**
 * The one spawn of git. Returns `{status, stdout, stderr, cmd}` with both streams as raw bytes.
 * @param {string} root @param {string[]} args @param {Buffer|undefined} input
 * @param {Object<string,string>|null} env
 * @returns {{status: number, stdout: Buffer, stderr: Buffer, cmd: string[]}}
 */
function _spawn(root, args, input, env) {
  const exe = _git()
  if (!exe) throw _spawn_error('FileNotFoundError', 'git was not found on PATH', { code: 'ENOENT' })
  const cmd = ['git', ...GIT_PINS, ...args]
  const r = spawnSync(exe, [...GIT_PINS, ...args], {
    cwd: root,
    input,
    env: env === null || env === undefined ? undefined : { ...process.env, ...env },
    windowsHide: true, // no console window, even under a parent without one (see `_real_git`)
    maxBuffer: _MAX_BUFFER,
  })
  if (r.error) {
    // A `root` that is not a directory fails the spawn with ENOENT. Python names that failure
    // NotADirectoryError on Windows and FileNotFoundError elsewhere.
    let name = r.error.code === 'ENOENT' ? 'FileNotFoundError' : 'OSError'
    if (name === 'FileNotFoundError' && process.platform === 'win32' && !_is_dir(root)) name = 'NotADirectoryError'
    throw _spawn_error(name, `git could not run: ${r.error.message}`, { code: r.error.code })
  }
  let status = r.status
  if (status === null) status = -(os.constants.signals[r.signal] ?? 1)
  return { status, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0), cmd }
}

/**
 * True when `<rev>:<path>` can travel on the line-based stdin of `git cat-file --batch`.
 * @param {string} spec
 * @returns {boolean}
 */
export function batchable(spec) {
  return !spec.includes('\n') && !spec.includes('\r')
}

/**
 * Many `<rev>:<path>` objects in ONE `git cat-file --batch` call. Each git start costs tens of
 * milliseconds on Windows, so a caller that reads one file at several revisions asks once. The
 * result has one entry per spec, in order: `null` when git answers `missing`, else `{type, text}`
 * with the content decoded like every other output. `missing` covers an absent path and a missing
 * object alike, so a caller that must tell them apart asks again for that spec alone. Any other
 * reply that is no object throws. A spec that holds a line feed or a carriage return cannot
 * travel on the batch's stdin: git splits lines on LF and drops a CR before it, so `a.md\r` would
 * read `a.md`. Such a spec throws before git starts. A non-zero exit or a reply that does not
 * parse throws `CalledProcessError`.
 * @param {string} root
 * @param {string[]} specs `<rev>:<path>` object names
 * @returns {Array<{type: string, text: string}|null>}
 */
export function git_objects(root, specs) {
  if (!specs.length) return []
  for (const s of specs) {
    if (!batchable(s)) throw _spawn_error('ValueError', `object name holds a line feed or a carriage return: ${_repr_str(s)}`)
  }
  const args = ['cat-file', '--batch']
  const r = _spawn(root, args, Buffer.from(specs.join('\n') + '\n', 'utf8'), null)
  const fail = (why) => _spawn_error('CalledProcessError',
    `Command '[${r.cmd.map(_repr_str).join(', ')}]' ${why}.`,
    { status: r.status, returncode: r.status, stdout: '', output: '',
      stderr: decode_utf8_backslashreplace(r.stderr), args, cmd: r.cmd })
  if (r.status !== 0) throw fail(`returned non-zero exit status ${r.status}`)
  const out = r.stdout
  const res = []
  let at = 0
  for (const spec of specs) {
    const nl = out.indexOf(0x0a, at)
    if (nl === -1) throw fail(`ended before the reply for ${_repr_str(spec)}`)
    const head = decode_utf8_backslashreplace(out.subarray(at, nl))
    at = nl + 1
    // git answers `<name> missing` both for an absent path and for a path whose object is gone,
    // as in a shallow clone. Only the caller can tell them apart, so both read as `null`. The
    // name is compared as decoded text, so a non-ASCII path matches too.
    if (head === `${spec} missing`) { res.push(null); continue }
    if (head.endsWith(' missing') || head.endsWith(' ambiguous')) throw fail(`could not read ${_repr_str(spec)}: ${_repr_str(head)}`)
    const m = /^[0-9a-f]+ (\S+) (\d+)$/.exec(head)
    if (!m) throw fail(`gave an unreadable reply header ${_repr_str(head)}`)
    const size = Number(m[2])
    if (at + size + 1 > out.length || out[at + size] !== 0x0a) throw fail(`gave a short reply for ${_repr_str(spec)}`)
    res.push({ type: m[1], text: decode_utf8_backslashreplace(out.subarray(at, at + size)) })
    at += size + 1
  }
  return res
}

/**
 * Run one git command and return its stdout as a string. THE git subprocess boundary for every
 * call whose output is parsed. A non-zero exit throws an Error named `CalledProcessError` with
 * `.status` (also `.returncode`), `.stdout` (also `.output`) and `.stderr` as decoded strings,
 * `.args` (the arguments the caller passed) and `.cmd` (the whole argv, `git`, the pins, then
 * the arguments; a message strips the pins by their count). The fail-loud diagnostic prints legible
 * git text, never a bytes repr.
 * @param {string} root working directory of the command
 * @param {string[]} args git arguments, without the pins
 * @param {{stdin?: string|null, env?: Object<string,string>|null}} [opts] `stdin` feeds a
 *   `--stdin`-shaped command; `env` adds variables to the inherited environment
 * @returns {string}
 */
export function git_run(root, args, opts = {}) {
  const r = git_result(root, args, opts)
  if (r.status !== 0) {
    throw _spawn_error('CalledProcessError',
      `Command '[${r.cmd.map(_repr_str).join(', ')}]' returned non-zero exit status ${r.status}.`,
      { status: r.status, returncode: r.status, stdout: r.stdout, output: r.stdout,
        stderr: r.stderr, args, cmd: r.cmd })
  }
  return r.stdout
}

/**
 * `git_run`, read as non-blank, path-normalised RECORD lines (numstat and the like). Split on
 * `\n` only, never on the wider set of Python's `splitlines`: git prints U+2028, U+2029, NEL and
 * the C0 separators raw inside a path under `core.quotepath=false`, so one path would split into
 * two records. A path LIST goes through `git_paths` instead.
 * @param {string} root
 * @param {string[]} args
 * @returns {string[]}
 */
export function git_lines(root, args) {
  return git_run(root, args).split('\n').filter((line) => py_strip(line)).map(norm)
}

/**
 * A path-LIST git command (`ls-files`, `diff --name-only`) run with `-z` after its first argument
 * and split on NUL: paths travel verbatim, with no C-quoting and no line-separator ambiguity. Only
 * for commands whose `-z` output is one path per record. `--name-status -z` interleaves status
 * and path fields and needs its own parse.
 * @param {string} root
 * @param {string[]} args the first item is the git subcommand
 * @returns {string[]}
 */
export function git_paths(root, args) {
  return git_run(root, [args[0], '-z', ...args.slice(1)]).split('\0').filter((p) => py_strip(p)).map(norm)
}
