// In-slice decision notes (ywr-harness ADR 0172). The session appends; a compaction and /ywr-harness:slice-close read.
//
// A compaction between a decision and the slice close can drop the reason with the summary. This
// script keeps one line per decision where neither the summary nor the work tree can touch it.
//
// Usage:
//   node slice_note.mjs add <decision|rejected|owner|fact|risk> <text...>
//   node slice_note.mjs show [--range <a>..<b> | --all] [--max N]
//   node slice_note.mjs --repo <dir> ...
//
// The journal lives under `git rev-parse --git-path` (per worktree, never tracked), so a note never
// moves the `--tree` snapshot that a ready report ends with. Each record carries the HEAD it was
// written at and the slice base it was written under. The base is the last commit that touched the
// handoff that `.harness.json` declares, or HEAD when no handoff is declared or committed. `show`
// takes the notes at the base, at every commit after it, and under the current base, so an amend or
// a rebase of the slice's own commits keeps its notes (ywr-harness ADR 0172). The next close retires
// them with no delete step. The journal is append-only.
//
// A note is the session's own claim. The SessionStart `compact` hook re-injects `show`'s output
// marked as such, and /ywr-harness:slice-close checks each note against the tree: input, never proof.
//
// The journal format is one JSON object per line, keys in the order ts, head, base, kind, text,
// with `", "` and `": "` separators and every non-ASCII character as a `\uXXXX` escape. Readers and
// writers of other plugin versions must agree on those bytes, so `dumps` spells the format out
// instead of leaving it to `JSON.stringify`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as hc from './harness_config.mjs'

export const JOURNAL = 'ywr-harness/slice-notes.jsonl'
export const KINDS = ['decision', 'rejected', 'owner', 'fact', 'risk']
// Counted in UTF-16 code units, not code points. The host caps each hook string at 10,000
// characters, and an astral character is two units. The compact hook sizes its note count from
// this bound, so a code-point count would let 17 notes overflow it.
export const MAX_TEXT = 500
// Control, format, line/paragraph separator and lone surrogates: each can break the one-line shape
// or hide text from the reader (a bidi override, U+2028). Hangul and every other letter pass.
const REFUSED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u
export const UNBORN = 'none'
// The shapes `add` writes. `show` holds a hand-written line to them too, so no field of a valid record can
// grow a `show` line past the bound the compact hook is sized from.
const TS_RX = /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z/
const HEAD_RX = /none|[0-9a-f]{40}|[0-9a-f]{64}/
const BASE_RX = /|[0-9a-f]{40}|[0-9a-f]{64}/
export const SHORT = 12
const TAIL = 'input, never proof (ywr-harness ADR 0172)'

function pyError(name, message) {
  const e = new Error(message)
  e.name = name
  return e
}

/** Python's `repr` of a string: the quoted form an error message shows a bad value in. */
function py_repr(s) {
  return hc._str([s]).slice(1, -1)
}

// An operating-system failure: a Node fs or spawn error carries a string `code`, and the base library
// names the same failures with the exception type a caller branches on.
const OS_NAMES = new Set(['OSError', 'FileNotFoundError', 'PermissionError', 'NotADirectoryError',
  'IsADirectoryError', 'FileExistsError'])
function isOSError(e) {
  return Boolean(e) && (typeof e.code === 'string' || OS_NAMES.has(e.name))
}

// `str(OSError)` as a person reads it: `[Errno 13] Permission denied: '<path>'`. A spawn failure keeps
// the message the git boundary wrote.
const ERRNO = {
  EPERM: [1, 'Operation not permitted'], ENOENT: [2, 'No such file or directory'],
  EACCES: [13, 'Permission denied'], EEXIST: [17, 'File exists'], ENOTDIR: [20, 'Not a directory'],
  EISDIR: [21, 'Is a directory'],
}
function osErrorText(e) {
  let code = e.code
  // Windows refuses to open a directory as a file with a permission error, as the host runtime reports it.
  if (code === 'EISDIR' && process.platform === 'win32') code = 'EACCES'
  const known = ERRNO[code]
  if (!known || !e.path) return e.message
  return `[Errno ${known[0]}] ${known[1]}: ${py_repr(String(e.path))}`
}

/** `Path(p).resolve()`: absolute, symlinks resolved, a missing tail kept as given. */
function resolve_path(p) {
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

function is_file(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

export function journal_path(root) {
  return path.resolve(root, hc.py_strip(hc.git_run(root, ['rev-parse', '--git-path', JOURNAL])))
}

/** HEAD's commit id, or `none` on an unborn branch. Any other git failure throws. */
export function head_of(root) {
  try {
    return hc.py_strip(hc.git_run(root, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']))
  } catch (e) {
    if (e.name !== 'CalledProcessError' || e.returncode !== 1) throw e
  }
  // `-q --verify` exits 1 both on an unborn branch and outside a repository; only the first is a HEAD.
  hc.git_run(root, ['rev-parse', '--git-dir'])
  return UNBORN
}

/** The UTF-16 length, as a JavaScript string counts it. */
export function units(text) {
  return text.length
}

/** '' when the text is a valid note body, else why not. */
export function text_problem(text) {
  if (!text) return 'the text is empty'
  if (units(text) > MAX_TEXT) return `the text has ${units(text)} UTF-16 units, more than ${MAX_TEXT}`
  for (const ch of text) {
    if (REFUSED.test(ch)) {
      return `the text holds U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}, a control, format or line separator character`
    }
  }
  return ''
}

const isStr = (v) => typeof v === 'string'

export function valid(rec) {
  return hc._is_dict(rec) && ['ts', 'head', 'kind', 'text'].every((k) => isStr(hc._get(rec, k)))
    && Boolean(hc.re_fullmatch(TS_RX, rec.ts)) && Boolean(hc.re_fullmatch(HEAD_RX, rec.head))
    && isStr(hc._get(rec, 'base', '')) && Boolean(hc.re_fullmatch(BASE_RX, hc._get(rec, 'base', '')))
    && KINDS.includes(rec.kind) && !text_problem(rec.text)
}

export function read_notes(file) {
  if (!is_file(file)) return []
  const out = []
  // A non-fatal decode: torn bytes become a line that fails the checks below and is named, never a
  // crash. The byte-order mark stays in the text, and a lone `\r` or a `\r\n` ends a line.
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(with_path(file, () => fs.readFileSync(file)))
    .replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const lines = text.split('\n')
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]
    if (!hc.py_strip(line)) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      rec = null
    }
    if (!valid(rec)) {
      hc.warn(`${path.basename(file)}:${k + 1} is not a slice note — ignored`)
      continue
    }
    out.push(rec)
  }
  return out
}

// One JSON string the way Python's `json.dumps(ensure_ascii=True)` writes it: everything outside
// space..`~` becomes a lower-case `\uXXXX` escape, one per UTF-16 unit.
function jstr(s) {
  return JSON.stringify(s).replace(/[^ -~]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

export function dumps(rec) {
  return `{"ts": ${jstr(rec.ts)}, "head": ${jstr(rec.head)}, "base": ${jstr(rec.base)}, "kind": ${jstr(rec.kind)}, "text": ${jstr(rec.text)}}`
}

// A journal failure names the journal: some host errors (a write to a directory) carry no path.
function with_path(file, fn) {
  try {
    return fn()
  } catch (e) {
    if (isOSError(e) && !e.path) e.path = file
    throw e
  }
}

export function append(file, rec) {
  with_path(file, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, dumps(rec) + '\n', 'utf8')
  })
}

export function stamp() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

/**
 * The last commit on HEAD's history that touched the declared handoff, or '' (no handoff, unborn).
 * A refused handoff value narrows the slice to HEAD; its warning goes to `notices` for the caller.
 */
export function slice_base(root, head, notices) {
  if (head === UNBORN) return ''
  const [cfg, warns] = hc.load(root)
  notices.push(...warns.filter((w) => w.startsWith('handoff')).map((w) => `${w} — the slice is then HEAD only`))
  const handoff = hc._get(cfg, 'handoff') || ''
  if (!handoff) return ''
  // `:(literal)`: a declared value is a path, never pathspec magic such as `:(glob)` or `:(exclude)`.
  return hc.py_strip(hc.git_run(root, ['log', '-1', '--format=%H', 'HEAD', '--', ':(literal)' + handoff]))
}

/** `<a>` itself plus every commit `git rev-list <a>..<b>` lists. Throws a ValueError on a bad shape. */
export function range_heads(root, rng) {
  const parts = rng.split('..')
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1].startsWith('.')) {
    throw pyError('ValueError', `not a <a>..<b> range: ${hc.one_line(rng)}`)
  }
  const base = hc.py_strip(hc.git_run(root, ['rev-parse', '--verify', '--end-of-options', parts[0] + '^{commit}']))
  return new Set([base, ...hc.git_lines(root, ['rev-list', '--end-of-options', rng])])
}

export function line_for(i, rec, with_head) {
  const where = with_head ? ` ${rec.head.slice(0, SHORT)}` : ''
  return `  ${i}. ${rec.ts}${where} ${rec.kind}: ${rec.text}`
}

// ---------------------------------------------------------------------------------------------
// The command line. It follows argparse's rules and wording: an abbreviated long option,
// `--name=value`, a negative number as a value, `--` before a value that starts with a dash, `-h`,
// and exit 2 with a usage line for a bad invocation.
// ---------------------------------------------------------------------------------------------
class Exit extends Error {
  constructor(code) {
    super(`exit ${code}`)
    this.name = 'Exit'
    this.code = code
  }
}

const PROG = 'slice_note.mjs'

const USAGE = {
  main: `usage: ${PROG} [-h] [--repo REPO] {add,show} ...`,
  add: `usage: ${PROG} add [-h]\n${' '.repeat(`usage: ${PROG} add `.length)}{decision,rejected,owner,fact,risk} text [text ...]`,
  show: `usage: ${PROG} show [-h] [--range RNG | --all] [--max MAX]`,
}

const HELP = {
  main: `${USAGE.main}

Append and show the session's in-slice decision notes (ywr-harness ADR 0172).

positional arguments:
  {add,show}
    add        append one note at the current HEAD
    show       print the notes at the current HEAD (input, never proof)

options:
  -h, --help   show this help message and exit
  --repo REPO
`,
  add: `${USAGE.add}

positional arguments:
  {decision,rejected,owner,fact,risk}
  text

options:
  -h, --help            show this help message and exit
`,
  show: `${USAGE.show}

options:
  -h, --help   show this help message and exit
  --range RNG  also the notes at <a> and at each commit of <a>..<b>
  --all        every note, with its HEAD
  --max MAX    only the newest N notes of the selection
`,
}

const PROG_OF = { main: PROG, add: `${PROG} add`, show: `${PROG} show` }

function usage_error(which, message) {
  process.stderr.write(`${USAGE[which]}\n${PROG_OF[which]}: error: ${message}\n`)
  throw new Exit(2)
}

const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/

// One token as the parser sees it: an option (`flag` null when no flag matches it), a value, or an
// ambiguous abbreviation. `flags` lists the long flags; a bare `-h` is the one short flag.
function classify(tok, flags) {
  if (!tok.startsWith('-')) return { type: 'A' }
  if (tok === '-h' || flags.includes(tok)) return { type: 'O', flag: tok }
  if (tok.length === 1) return { type: 'A' }
  if (tok.includes('=')) {
    const i = tok.indexOf('=')
    const name = tok.slice(0, i)
    if (flags.includes(name)) return { type: 'O', flag: name, explicit: tok.slice(i + 1) }
  }
  if (tok.startsWith('--')) {
    const stem = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok
    const hits = flags.filter((f) => f.startsWith(stem))
    if (hits.length > 1) return { type: 'AMBIGUOUS', stem, hits }
    if (hits.length === 1) {
      return { type: 'O', flag: hits[0], explicit: tok.includes('=') ? tok.slice(tok.indexOf('=') + 1) : undefined }
    }
  }
  if (NEGATIVE_NUMBER.test(tok)) return { type: 'A' }
  if (tok.includes(' ')) return { type: 'A' }
  return { type: 'O', flag: null }
}

/**
 * Walk `argv` for one parser. `spec.valued` lists the long flags that take one value, `spec.switches`
 * the long flags that take none. Returns `{opts, seq}`: `seq` is every other token in the order it
 * came, each `{t: 'A'|'X'|'DD'|'OPT', tok}` (a value, an option no flag matches, the `--` marker, a
 * flag that was read), for the caller to assign to its positional arguments.
 */
function scan(which, argv, spec) {
  const flags = [...spec.valued, ...spec.switches, '--help']
  const opts = {}
  const seq = []
  let after_dd = false
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (!after_dd && tok === '--') { after_dd = true; seq.push({ t: 'DD', tok }); continue }
    const c = after_dd ? { type: 'A' } : classify(tok, flags)
    if (c.type === 'AMBIGUOUS') {
      usage_error(which, `ambiguous option: ${c.stem} could match ${c.hits.join(', ')}`)
    }
    if (c.type === 'A') { seq.push({ t: 'A', tok }); continue }
    if (c.flag === null) { seq.push({ t: 'X', tok }); continue }
    if (c.flag === '-h' || c.flag === '--help') {
      if (c.explicit !== undefined) usage_error(which, `argument -h/--help: ignored explicit argument ${py_repr(c.explicit)}`)
      process.stdout.write(HELP[which])
      throw new Exit(0)
    }
    if (spec.valued.includes(c.flag)) {
      let value = c.explicit
      if (value === undefined) {
        const next = argv[i + 1]
        if (next === undefined || next === '--' || classify(next, flags).type !== 'A') {
          usage_error(which, `argument ${c.flag}: expected one argument`)
        }
        value = next
        i++
      }
      spec.on_valued(which, c.flag, value, opts)
    } else {
      if (c.explicit !== undefined) usage_error(which, `argument ${c.flag}: ignored explicit argument ${py_repr(c.explicit)}`)
      spec.on_switch(which, c.flag, opts)
    }
    seq.push({ t: 'OPT' })
  }
  return { opts, seq }
}

/**
 * Give the value tokens of `seq` to the positional arguments in `specs` (`{name, nargs: 1|'+', choices?}`),
 * run by run: a run is the value tokens between two options. Each run fills the arguments still
 * waiting, in order, and what no argument takes is unrecognized. Returns `{vals, extras}`, `extras` in
 * the order the tokens came. The `--` is dropped from a value list and kept in an unrecognized one.
 */
function assign(which, seq, specs) {
  const vals = {}
  const extras = []
  let pending = 0
  let run = []
  const flush = () => {
    let items = run
    run = []
    while (items.some((x) => x.t === 'A') && pending < specs.length) {
      const spec = specs[pending]
      if (spec.nargs === 1) {
        const at = items.findIndex((x) => x.t === 'A')
        vals[spec.name] = items[at].tok
        items = items.slice(at + 1)
        if (spec.choices && !spec.choices.includes(vals[spec.name])) {
          usage_error(which, `argument ${spec.name}: invalid choice: ${py_repr(vals[spec.name])} (choose from ${spec.choices.join(', ')})`)
        }
      } else {
        vals[spec.name] = items.filter((x) => x.t === 'A').map((x) => x.tok)
        items = []
      }
      pending++
    }
    for (const x of items) extras.push(x.t === 'DD' ? '--' : x.tok)
  }
  for (const item of seq) {
    if (item.t === 'A' || item.t === 'DD') { run.push(item); continue }
    flush()
    if (item.t === 'X') extras.push(item.tok)
  }
  flush()
  return { vals, extras }
}

function parse_int(flag, text, which) {
  // The same text an integer parser accepts: optional sign, ASCII digits with single underscores
  // between them, surrounding whitespace.
  const t = hc.py_strip(text)
  if (!/^[+-]?[0-9]+(_[0-9]+)*$/.test(t)) {
    usage_error(which, `argument ${flag}: invalid int value: ${py_repr(text)}`)
  }
  return Number(t.replaceAll('_', ''))
}

export function parse_args(argv) {
  // Top level: options up to the command word, then everything after it belongs to the command.
  const top_flags = ['--repo', '--help']
  const extras = []
  let repo = null
  let cmd = null
  let rest = []
  let after_dd = false
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (!after_dd && tok === '--') { after_dd = true; continue }
    const c = after_dd ? { type: 'A' } : classify(tok, top_flags)
    if (c.type === 'AMBIGUOUS') usage_error('main', `ambiguous option: ${c.stem} could match ${c.hits.join(', ')}`)
    if (c.type === 'A') {
      if (!['add', 'show'].includes(tok)) usage_error('main', `argument cmd: invalid choice: ${py_repr(tok)} (choose from add, show)`)
      cmd = tok
      rest = argv.slice(i + 1)
      break
    }
    if (c.flag === null) { extras.push(tok); continue }
    if (c.flag === '-h' || c.flag === '--help') {
      if (c.explicit !== undefined) usage_error('main', `argument -h/--help: ignored explicit argument ${py_repr(c.explicit)}`)
      process.stdout.write(HELP.main)
      throw new Exit(0)
    }
    // `--repo`
    if (c.explicit !== undefined) { repo = c.explicit; continue }
    const next = argv[i + 1]
    if (next === undefined || next === '--' || classify(next, top_flags).type !== 'A') {
      usage_error('main', 'argument --repo: expected one argument')
    }
    repo = next
    i++
  }
  if (cmd === null) usage_error('main', 'the following arguments are required: cmd')

  const args = { repo, cmd }
  let sub_extras
  if (cmd === 'add') {
    const r = scan('add', rest, { valued: [], switches: [], on_valued() {}, on_switch() {} })
    const a = assign('add', r.seq, [{ name: 'kind', nargs: 1, choices: KINDS }, { name: 'text', nargs: '+' }])
    const missing = ['kind', 'text'].filter((k) => !(k in a.vals))
    if (missing.length) usage_error('add', `the following arguments are required: ${missing.join(', ')}`)
    args.kind = a.vals.kind
    args.text = a.vals.text
    sub_extras = a.extras
  } else {
    const r = scan('show', rest, {
      valued: ['--range', '--max'], switches: ['--all'],
      on_valued(which, flag, value, opts) {
        if (flag === '--range') {
          if (opts.all) usage_error(which, 'argument --range: not allowed with argument --all')
          opts.rng = value
        } else {
          opts.max = parse_int('--max', value, which)
        }
      },
      on_switch(which, flag, opts) {
        if (opts.rng !== undefined) usage_error(which, 'argument --all: not allowed with argument --range')
        opts.all = true
      },
    })
    args.rng = r.opts.rng ?? null
    args.all = Boolean(r.opts.all)
    args.max = r.opts.max ?? null
    // No positional argument: every value token is unrecognized, in the order it came.
    sub_extras = assign('show', r.seq, []).extras
  }
  const left = extras.concat(sub_extras)
  if (left.length) usage_error('main', `unrecognized arguments: ${left.join(' ')}`)
  return args
}

function main(argv) {
  try {
    return note_main(argv)
  } catch (e) {
    if (e instanceof Exit) return e.code
    if (!isOSError(e)) throw e
    hc.say(`slice notes: FAILED — journal I/O: ${osErrorText(e)} (ywr-harness ADR 0172)`)
    return 2
  }
}

function note_main(argv) {
  const args = parse_args(argv)

  let text
  if (args.cmd === 'add') {
    text = hc.py_strip(args.text.join(' '))
    const problem = text_problem(text)
    if (problem) {
      hc.say(`slice note: REFUSED — ${problem}; nothing was written (ywr-harness ADR 0172)`)
      return 2
    }
  } else if (args.max !== null && args.max < 1) {
    hc.say('slice notes: FAILED — --max needs a number of 1 or more')
    return 2
  }

  const root = args.repo ? resolve_path(args.repo) : hc.find_repo_root(process.cwd())
  let file
  let head
  let heads
  const notices = []
  let base
  try {
    file = journal_path(root)
    head = head_of(root)
    heads = new Set([head])
    base = slice_base(root, head, notices)
    if (args.cmd === 'show') {
      if (base && base !== head) for (const h of range_heads(root, `${base}..${head}`)) heads.add(h)
      if (args.rng !== null) for (const h of range_heads(root, args.rng)) heads.add(h)
    }
  } catch (e) {
    if (e.name === 'ValueError') {
      hc.say(`slice notes: FAILED — ${e.message}`)
      return 2
    }
    if (e.name === 'CalledProcessError') {
      process.stderr.write(`git failed: ${hc.py_strip(e.stderr || '')}\n`)
      hc.say('slice notes: FAILED — git could not resolve the repository, HEAD or the range (ywr-harness ADR 0172)')
      return 2
    }
    if (isOSError(e)) {
      // A git that cannot start (not on PATH, repository directory unreadable) surfaces here,
      // before any journal write; the handler in main() is for the journal alone.
      hc.say(`slice notes: FAILED — git could not be run: ${osErrorText(e)} (ywr-harness ADR 0172)`)
      return 2
    }
    throw e
  }

  const notes = read_notes(file)
  if (args.cmd === 'add') {
    for (const n of notices) hc.warn(n)
    append(file, { ts: stamp(), head, base, kind: args.kind, text })
    const n = 1 + notes.filter((r) => r.head === head).length
    hc.say(`slice note ${n} recorded (${args.kind}) at HEAD ${head.slice(0, SHORT)}`)
    return 0
  }

  // A note stays in the slice by its commit, or by the base it was written under (an amend or a rebase
  // rewrites the commit, never the base).
  const picked = args.all ? notes : notes.filter((r) => heads.has(r.head) || (base && hc._get(r, 'base') === base))
  const others = notes.length - picked.length
  let what
  if (args.all) {
    what = 'in the journal'
  } else {
    what = `at HEAD ${head.slice(0, SHORT)}`
    if (base && base !== head) what += ` since the handoff commit ${base.slice(0, SHORT)}`
    if (args.rng !== null) what += ` and the range ${hc.one_line(args.rng)}`
  }
  // A narrowed selection is said on stdout and FIRST: the compact hook reads stdout only, and it stays
  // silent on a first line of `slice notes: none`.
  for (const n of notices) hc.say(`slice notes: warning — ${n}`)
  hc.say(`slice notes: ${picked.length || 'none'} ${what} · ${TAIL}`)
  let dropped = 0
  if (args.max !== null && picked.length > args.max) dropped = picked.length - args.max
  for (let k = dropped; k < picked.length; k++) hc.say(line_for(k + 1, picked[k], args.all))
  if (dropped) hc.say(`slice notes: ${dropped} older not shown (--max ${args.max})`)
  if (others) hc.say(`slice notes: ${others} more at other HEADs (show --all)`)
  return 0
}

function is_entry() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (is_entry()) process.exitCode = main(process.argv.slice(2))
