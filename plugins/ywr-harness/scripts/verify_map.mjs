// Changed-files -> verify-script reverse index. Backend for the /ywr-harness:verify skill.
//
// Reads the generated docs index (single source of truth: spec frontmatter `implements_in`), maps
// changed files to owning specs, and prints the verify scripts registered under those specs.
// Advisory — no LLM, no network, nothing executed; exits 0 with TWO exceptions, each printing a
// stdout FAILED marker and exiting non-zero because an empty advisory output reads as a pass to
// every consumer: a git failure resolving the changed-file scope (`scope: FAILED`, ywr-harness ADR 0041), and a
// docs index that exists but cannot be read (`index: FAILED`, ywr-harness ADR 0110). An ABSENT index is a
// stdout `index: ABSENT` line with exit 0 — a repo with no docs corpus yet.
//
// Usage:
//   node verify_map.mjs                       # working tree vs HEAD + untracked
//   node verify_map.mjs --range main~3..HEAD  # slice range UNIONED with the working tree
//   node verify_map.mjs path/to/file [...]    # explicit files
//   node verify_map.mjs --repo <dir>          # repo root (default: search upward)
//
// --range is a union with the current working tree (tracked changes AND untracked files), so
// "verify the slice" always includes the not-yet-committed state; after a clean commit the union
// degenerates to the range alone.
//
// The committed index carries a frontmatter digest (`fm_digest`, ywr-harness ADR 0043); this script recomputes
// it and prints an `index: STALE` advisory line when the docs sources have moved on — the local
// mid-slice complement to CI's on-merge drift gate. A missing stamp is reported, never silent.
//
// Unowned product files are listed as unmapped unless the slice retro's ignore register
// (`retro.ignore_file`) exempts them — one register for both readers (ywr-harness ADR 0115); an exempt file is
// counted, never dropped silently.
//
// Repo-specific values come from `.harness.json` via harness_config — one reader, one validator.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as hc from './harness_config.mjs'

// ---------------------------------------------------------------------------------------------
// Staleness-stamp recomputation (ywr-harness ADR 0043). MUST mirror the docs builder's `fm_digest`
// exactly — the file rule (sorted NNNN-*.md, 0000- excluded) and the block rule (`hc.fm_block`, the
// builder's split_frontmatter: CRLF fold, lead-HTML-comment skip, opening '---' line, closing
// line strip() == '---'). The two implementations are held together by a pairing selftest
// (build-docs.selftest.ps1): change one side alone and that suite fails. There is no shared
// import because the builder stays a standalone file (ywr-harness spec 0001); the
// duplication is deliberate and selftest-gated.
//
// The digest hashes the bytes the builder hashes: each file is read as UTF-8 with undecodable bytes
// replaced, and a lone `\r` or a `\r\n` read as `\n` (the builder reads in text mode), then the
// text of the block is encoded back to UTF-8.
//
// The corpus location is DERIVED, never assumed: the builder resolves adr/ and spec/ as siblings
// of its own file, and it writes index.json into that same directory — so the corpus dirs are
// always siblings of the index the declaration points at. Hardcoding `docs/` here would report
// a permanent false STALE for any repo that customizes docs.index, and a false alarm that never
// clears teaches readers to ignore the real one.
// ---------------------------------------------------------------------------------------------
// The builder's file rule `^\d{4}-.*\.md$`: `\d` reads any Unicode decimal digit, `.` any character but
// a line feed, and `$` also matches before one trailing line feed.
const FM_FILE_RE = /^\p{Nd}{4}-[^\n]*\.md(?=\n?$)/u

function is_dir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function is_symlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink() } catch { return false }
}

/** The file as text: UTF-8 with undecodable bytes replaced, line ends folded to `\n`. */
function read_text_lenient(p) {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(fs.readFileSync(p))
    .replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

export function fm_digest(docs_dir) {
  const h = crypto.createHash('sha256')
  for (const kind of ['adr', 'spec']) {
    const directory = path.join(docs_dir, kind)
    if (!is_dir(directory)) continue
    for (const fn of hc._sorted(fs.readdirSync(directory))) {
      if (!FM_FILE_RE.test(fn) || fn.startsWith('0000-')) continue
      let block
      try {
        block = hc.fm_block(read_text_lenient(path.join(directory, fn)))
      } catch (e) {
        if (!(e && typeof e.code === 'string')) throw e
        block = null
      }
      h.update(`${kind}/${fn}\0${block || ''}\0`, 'utf8')
    }
  }
  return h.digest('hex')
}

// `json.dumps` as the base interpreter writes it: `, ` and `: ` separators, every character outside
// space..`~` as a `\uXXXX` escape. A message that quotes an index value shows it in that form.
function jstr(s) {
  return JSON.stringify(s).replace(/[^ -~]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function py_json(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return jstr(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return '[' + v.map(py_json).join(', ') + ']'
  return '{' + Object.entries(v).map(([k, x]) => jstr(k) + ': ' + py_json(x)).join(', ') + '}'
}

/**
 * The normalized `implements_in` paths of one index entry — never a crash on its shape.
 *
 * An index is a generated file, but the generator that wrote it may be older than this script:
 * builders before plugin 0.54.0 parsed only the one-line `[a, b]` list, so a spec written as a
 * block list lands as `null` and a multi-line flow list as the string `"["`. Iterating either
 * would crash (`null`: a non-zero exit that fails CI's verify step) or silently walk
 * the string character by character into an empty mapping. Both read as "this spec owns
 * nothing" and are WARNED, naming the spec, because either one is an ownership hole the
 * reader must see. An absent key is an honest empty list and stays silent.
 *
 * A current builder also writes a non-list for a value that is not a list in the source — an
 * empty or comment-only `implements_in:` (null), an unterminated `[` (a string) — and a rebuild
 * reproduces it, so the warning names that remedy too: a warning whose only named fix cannot
 * clear it is the alarm fatigue this script exists to avoid.
 * @param {Object} spec @param {string[]} warns @returns {string[]}
 */
export function spec_files(spec, warns) {
  const raw = hc._get(spec, 'implements_in', [])
  const sid = hc._str(hc._get(spec, 'id', '?'))   // repo-supplied, but these land in warn(), which escapes
  if (!Array.isArray(raw)) {
    const shown = raw === null ? 'null' : `${hc._type_name(raw)} ${py_json(raw).slice(0, 40)}`
    warns.push(`spec ${sid}: implements_in in the index is ${shown}, not a list ` +
               '— treated as owning NO files. If the spec declares a block or multi-line ' +
               'list, rebuild the index (node docs/build.mjs): builders before 0.54.0 read ' +
               'only the one-line [a, b] form. If a rebuilt index still shows this, the ' +
               'value itself is not a list — write it as [a, b], or [] for a spec that ' +
               'owns nothing yet')
    return []
  }
  const bad = raw.filter((p) => typeof p !== 'string')
  if (bad.length) {
    warns.push(`spec ${sid}: ${bad.length} non-string implements_in ` +
               `entr${bad.length === 1 ? 'y' : 'ies'} in the index skipped — implements_in ` +
               'lists repo-relative paths (quote a path that looks like a number)')
  }
  return raw.filter((p) => typeof p === 'string').map((p) => hc.norm(p))
}

// ---------------------------------------------------------------------------------------------
// The command line. It reads and refuses what the interpreter's own option parser did, with the same
// words: an abbreviated long option, `--name=value`, a negative number as a value, `--` before a
// value that starts with a dash, `-h`, and an exit of 2 with a usage line for a bad invocation.
// ---------------------------------------------------------------------------------------------
class Exit extends Error {
  constructor(code) {
    super(`exit ${code}`)
    this.name = 'Exit'
    this.code = code
  }
}

const PROG = 'verify_map.mjs'
const USAGE = `usage: ${PROG} [-h] [--range REV_RANGE] [--repo REPO] [files ...]`
const HELP = `${USAGE}

Map changed files to spec-owned verify scripts.

positional arguments:
  files              explicit changed files (skip git diff)

options:
  -h, --help         show this help message and exit
  --range REV_RANGE  git rev range (e.g. main~3..HEAD); default: HEAD vs
                     working tree
  --repo REPO        repo root (default: search upward)
`

function usage_error(message) {
  process.stderr.write(`${USAGE}\n${PROG}: error: ${message}\n`)
  throw new Exit(2)
}

/** Python's `repr` of a string: the quoted form an error message shows a bad value in. */
function py_repr(s) {
  return hc._str([s]).slice(1, -1)
}

const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/
const FLAGS = ['--range', '--repo', '--help']

// One token as the parser sees it: an option (known, or unknown with `flag: null`), a value, or an
// ambiguous abbreviation.
function classify(tok) {
  if (!tok.startsWith('-')) return { type: 'A' }
  if (tok === '-h' || FLAGS.includes(tok)) return { type: 'O', flag: tok }
  if (tok.length === 1) return { type: 'A' }
  const eq = tok.indexOf('=')
  if (eq >= 0 && FLAGS.includes(tok.slice(0, eq))) return { type: 'O', flag: tok.slice(0, eq), explicit: tok.slice(eq + 1) }
  if (tok.startsWith('--')) {
    const stem = eq >= 0 ? tok.slice(0, eq) : tok
    const hits = FLAGS.filter((f) => f.startsWith(stem))
    if (hits.length > 1) return { type: 'AMBIGUOUS', stem, hits }
    if (hits.length === 1) return { type: 'O', flag: hits[0], explicit: eq >= 0 ? tok.slice(eq + 1) : undefined }
  }
  if (NEGATIVE_NUMBER.test(tok)) return { type: 'A' }
  if (tok.includes(' ')) return { type: 'A' }
  return { type: 'O', flag: null }
}

export function parse_args(argv) {
  const opts = { rev_range: null, repo: null }
  const extras = []
  const files = []
  let have_files = false
  let run = []
  let after_dd = false
  // The first run of value tokens is the file list; a later run has no argument to take it.
  const flush = () => {
    if (run.length && !have_files) {
      files.push(...run.filter((x) => x.t === 'A').map((x) => x.tok))
      have_files = true
    } else {
      for (const x of run) extras.push(x.t === 'DD' ? '--' : x.tok)
    }
    run = []
  }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (!after_dd && tok === '--') { after_dd = true; run.push({ t: 'DD', tok }); continue }
    const c = after_dd ? { type: 'A' } : classify(tok)
    if (c.type === 'AMBIGUOUS') usage_error(`ambiguous option: ${c.stem} could match ${c.hits.join(', ')}`)
    if (c.type === 'A') { run.push({ t: 'A', tok }); continue }
    flush()
    if (c.flag === null) { extras.push(tok); continue }
    if (c.flag === '-h' || c.flag === '--help') {
      if (c.explicit !== undefined) usage_error(`argument -h/--help: ignored explicit argument ${py_repr(c.explicit)}`)
      process.stdout.write(HELP)
      throw new Exit(0)
    }
    let value = c.explicit
    if (value === undefined) {
      const next = argv[i + 1]
      if (next === undefined || next === '--' || classify(next).type !== 'A') {
        usage_error(`argument ${c.flag}: expected one argument`)
      }
      value = next
      i++
    }
    if (c.flag === '--range') opts.rev_range = value
    else opts.repo = value
  }
  flush()
  if (extras.length) usage_error(`unrecognized arguments: ${extras.join(' ')}`)
  return { rev_range: opts.rev_range, repo: opts.repo, files }
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

// The Python exception type behind a failure to read or parse the index, for the FAILED line.
function index_error_name(e) {
  if (e && e.name === 'SyntaxError') return 'JSONDecodeError'
  if (e && typeof e.code === 'string') return hc._oserr(e).name
  return e.name
}

function main(argv) {
  const args = parse_args(argv)

  const root = args.repo ? resolve_path(args.repo) : hc.find_repo_root(process.cwd())
  const [cfg, warns] = hc.load(root)
  for (const w of warns) hc.warn(w)

  // An ABSENT index is a repo with no docs corpus yet — stated on stdout, exit 0
  // (ywr-harness ADR 0110). An index that exists but cannot be read as an object with a `spec`
  // list is a broken build, the same class as the scope failure below: it must print a FAILED
  // line on stdout and exit non-zero, because a consumer reading stdout plus the exit code
  // would otherwise see a clean "nothing mapped" run.
  const index_path = path.join(root, cfg.index)
  if (!fs.existsSync(index_path) && !is_symlink(index_path)) {  // a dangling link is FAILED below
    hc.say(`index: ABSENT — ${cfg.index} does not exist, so no spec owns any file and ` +
           'nothing below is spec-verified; build it: node docs/build.mjs')
    return 0
  }
  let index
  try {
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(fs.readFileSync(index_path)).replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    } catch (e) {
      if (e instanceof TypeError) {
        const err = new Error(`'utf-8' codec can't decode the index: ${e.message}`)
        err.name = 'UnicodeDecodeError'
        throw err
      }
      throw e
    }
    index = JSON.parse(text)
    if (!hc._is_dict(index) || !Array.isArray(hc._get(index, 'spec', []))) {
      const err = new Error("not an object with a 'spec' list")
      err.name = 'ValueError'
      throw err
    }
  } catch (e) {
    const known = (e && typeof e.code === 'string') || ['SyntaxError', 'UnicodeDecodeError', 'ValueError'].includes(e && e.name)
    if (!known) throw e
    const name = index_error_name(e)
    process.stderr.write(`${cfg.index} unreadable (${name}: ${e.message})\n`)
    hc.say(`index: FAILED — ${cfg.index} exists but cannot be read (${name}); ` +
           'NOTHING was mapped or verified. This run must not be read as a pass (ywr-harness ADR 0110); ' +
           'rebuild: node docs/build.mjs')
    return 1
  }
  const specs = hc._get(index, 'spec', [])  // a non-object entry is REFUSED per entry in the loop below

  // Staleness signal (ywr-harness ADR 0043). The committed index carries a digest of the corpus
  // frontmatter; recompute it and ADVISE when the sources have moved on — the local mid-slice
  // run otherwise maps changed files against ownership someone forgot to rebuild, silently.
  // Advisory only: CI's drift gate is the enforcement on merge. A missing stamp is reported
  // too — silence has to mean "current", never "too old to know".
  const stamp = hc._get(index, 'fm_digest')
  if (stamp === null) {
    hc.say('index: no staleness stamp (index predates ywr-harness ADR 0043) — rebuild once to enable: ' +
           'node docs/build.mjs')
  } else if (fm_digest(path.dirname(path.join(root, cfg.index))) !== stamp) {
    hc.say('index: STALE — the adr/spec frontmatter beside the index differs from the ' +
           'committed index, so the spec ownership below may be out of date; rebuild: ' +
           "node docs/build.mjs (advisory — CI's drift gate enforces this on merge)")
  }

  let files
  let prov
  try {
    [files, prov] = hc.changed_files(root, args.rev_range, args.files)
  } catch (e) {
    if (e.name !== 'CalledProcessError') throw e
    // The one non-zero exit (ywr-harness ADR 0041) — same principle as the gate emitter's scope path:
    // a silent empty output is indistinguishable from "nothing to verify", and the /ywr-harness:verify
    // skill would read exactly that.
    process.stderr.write(`git diff failed: ${hc.py_strip(e.stderr || '')}\n`)
    hc.say('scope: FAILED — git could not resolve the changed-file scope; NOTHING was ' +
           'verified. This run must not be read as a pass (ywr-harness ADR 0041).')
    return 1
  }
  hc.print_scope(files, prov)
  if (!files.length) {
    hc.say('no changed files — nothing to verify')
    return 0
  }

  const late = []
  const verify_re = hc.compile_re(cfg.script_pattern, 'verify.script_pattern', late)
  const scope_re = hc.compile_re(cfg.product_scope, 'verify.product_scope', late)
  for (const w of late) hc.warn(w)

  // Collected during composition below and printed at the END of the run. NOT appended to
  // `late`: that list is already drained above, so anything added afterwards would be swallowed
  // — and a swallowed warning about a refused value looks exactly like a good configuration.
  const refused = []
  const hits = new Map()
  const owned = new Set()
  specs.forEach((spec, k) => {
    const n = k + 1
    if (!hc._is_dict(spec)) {
      refused.push(`index spec entry ${n} is not an object — skipped, it maps nothing; ` +
                   'rebuild the index (node docs/build.mjs)')
      return
    }
    // An entry without a usable id still MAPS: dropping it would hide its verify
    // scripts — a coverage gap reading as "no spec owns this". Shown under a placeholder and
    // WARNED, the same "never crash, never silent" rule as a non-list implements_in.
    let sid = hc._get(spec, 'id')
    if (typeof sid !== 'string' || !hc.py_strip(sid)) {
      sid = `(index entry ${n}, no id)`
      refused.push(`index spec entry ${n} (title ${py_json(hc._get(spec, 'title', '')).slice(0, 60)}) ` +
                   'has no id — mapped under a placeholder; give the spec an `id:` in its ' +
                   'frontmatter and rebuild the index (node docs/build.mjs)')
    }
    const impl = spec_files(spec, refused)
    const verify = hc._sorted(impl.filter((p) => verify_re && hc.re_match(verify_re, p)))
    const matched = hc._sorted(files.filter((f) => hc.owned(impl, f)))
    for (const p of impl) owned.add(p)
    if (matched.length) hits.set(sid, { title: hc._get(spec, 'title', ''), matched, verify })
  })

  let unmapped = scope_re ? hc._sorted(files.filter((f) => hc.re_match(scope_re, f) && !hc.owned(owned, f))) : []
  // The retro's ignore register exempts the same files here (ywr-harness ADR 0115): the list below
  // calls itself "a slice-retro UNMAPPED finding in the making", which needs both readers on one
  // register — otherwise a file the register exempts would be listed here as debt the retro never
  // reports. One register is necessary, not sufficient: the SCOPES stay two declarations
  // (`verify.product_scope` here, `retro.source_scope` there), so a file inside the first and
  // outside the second is still listed — the repo keeps the two in step. Exempt files are COUNTED,
  // never dropped silently; a bad register line is warned at the end like any refusal, and only
  // on a run with something unmapped to filter (no list, no read).
  const ign = unmapped.length ? hc.load_ignore(root, cfg.retro_ignore_file, refused) : []
  const exempt = unmapped.filter((f) => hc.any_match(ign, f))
  unmapped = unmapped.filter((f) => !hc.any_match(ign, f))

  if (!hits.size) {
    hc.say(`${files.length} changed file(s) map to no spec — no registered verify script.`)
  }
  for (const sid of hc._sorted([...hits.keys()])) {
    const h = hits.get(sid)
    // Everything below is printed through `hc.say()`, the single stdout exit. It matters most
    // here of all places: id, title and the filenames are repo-supplied, and this output's
    // consumer is a MODEL told to run the `run:` lines — so a newline in any of them could spell
    // a `run:` line nobody registered (same rule as for a shell consumer, here with a model).
    hc.say(`spec ${sid} — ${hc._str(h.title)}`)
    for (const f of h.matched) hc.say(`  changed: ${f}`)
    if (h.verify.length) {
      for (const v of h.verify) {
        const cmd = hc.verify_command(cfg, v, refused)
        // A refusal must NOT occupy the `run:` slot. This output's only consumer is the
        // /ywr-harness:verify skill — an LLM told to run the printed commands — and unlike the two
        // shell parsers it has no `(`-prefix convention to fall back on. So a refused
        // path gets a differently-labelled line that reads as a finding, not a command.
        hc.say(!cmd.startsWith('(')
          ? `  run:     ${cmd}`
          : "  REFUSED: this spec's registered verify script path is not a safe " +
            'command argument — see the warning below. NOTHING was run for it, and ' +
            'that is a coverage gap, not a pass.')
      }
    } else {
      hc.say('  (no verify script registered in implements_in for this spec)')
    }
    if (cfg.ui_prefix && h.matched.some((f) => f.startsWith(cfg.ui_prefix))) {
      hc.say('  note:    UI surface changed — registered scripts do not cover component' +
             ' rendering; say so plainly or cover it with a browser-level test')
    }
  }
  if (unmapped.length) {
    hc.say('unmapped product files (no spec owner — a slice-retro UNMAPPED finding in the making):')
    for (const f of unmapped) hc.say(`  ${f}`)
  }
  if (exempt.length) {
    hc.say(`exempt by the ignore register (${cfg.retro_ignore_file}): ${exempt.length} unowned ` +
           'product file(s) — recorded debt or a stated exemption, not listed as unmapped')
  }
  for (const w of refused) hc.warn(w)
  return 0
}

function is_entry() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (is_entry()) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    if (!(e instanceof Exit)) throw e
    process.exitCode = e.code
  }
}
