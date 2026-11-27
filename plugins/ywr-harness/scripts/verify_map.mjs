// Changed-files -> verify-script reverse index. Backend for the /ywr-harness:verify skill.
//
// Reads the generated docs index (spec frontmatter `implements_in`), maps changed files to owning
// specs, and prints the verify scripts registered under those specs. Advisory: no LLM, no network,
// nothing executed.
// Exit 0, except two cases that print a stdout FAILED marker and exit non-zero, because an empty
// output reads as a pass to every consumer: a git failure that resolves the changed-file scope
// (`scope: FAILED`, ywr-harness ADR 0041) and an index that exists but cannot be read
// (`index: FAILED`, ywr-harness ADR 0110). An absent index prints `index: ABSENT` and exits 0.
//
// Usage:
//   node verify_map.mjs                       # working tree vs HEAD + untracked
//   node verify_map.mjs --range main~3..HEAD  # slice range UNIONED with the working tree
//   node verify_map.mjs path/to/file [...]    # explicit files
//   node verify_map.mjs --repo <dir>          # repo root (default: search upward)
//
// `--range` is a union with the working tree (tracked changes and untracked files), so a verify run
// always covers the uncommitted state.
//
// The index carries a frontmatter digest (`fm_digest`, ywr-harness ADR 0043). The script recomputes
// it and prints an `index: STALE` line when the docs sources differ. A missing stamp is reported too.
//
// Unowned product files are listed as unmapped, unless the slice retro's ignore register
// (`retro.ignore_file`) exempts them. Both readers share that register (ywr-harness ADR 0115).
// Exempt files are counted, never dropped silently.
//
// Repo-specific values come from `.harness.json` via harness_config.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as hc from './harness_config.mjs'

// ---------------------------------------------------------------------------------------------
// Staleness-stamp recomputation (ywr-harness ADR 0043). It must mirror the docs builder's
// `fm_digest` exactly: the file rule (sorted NNNN-*.md, 0000- excluded) and the block rule
// (`hc.fm_block`, the builder's frontmatter split). The builder is a standalone file with no shared
// import (ywr-harness spec 0001), so a pairing selftest holds the two copies together.
//
// The digest hashes what the builder hashes: UTF-8 text with undecodable bytes replaced and every
// `\r\n` or lone `\r` read as `\n`, then the block encoded back to UTF-8.
//
// The corpus location comes from the index path, never from a hardcoded `docs/`: the builder writes
// the index beside adr/ and spec/, and a fixed path would report a permanent false STALE in a repo
// that customizes `docs.index`.
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
 * The normalized `implements_in` paths of one index entry. Never throws on its shape.
 *
 * An index may come from an older builder that parsed only the one-line `[a, b]` list. A block
 * list then lands as `null` and a multi-line flow list as the string `"["`. Iterating either would
 * crash or walk the string character by character into an empty mapping. Both mean "this spec owns
 * nothing" and are warned with the spec id, because each is an ownership hole. An absent key is an
 * honest empty list and stays silent.
 *
 * A current builder also writes a non-list for a source value that is no list (an empty
 * `implements_in:` or an unterminated `[`), and a rebuild reproduces it. The warning names that
 * remedy too, so the warning's fix can always clear it.
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

// The exception name the FAILED line shows for an unreadable index (`JSONDecodeError` and the like).
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

  // An absent index is a repo with no docs corpus yet: stdout line, exit 0. An index that exists
  // but is no object with a `spec` list prints FAILED and exits non-zero, because a consumer
  // would otherwise read a clean "nothing mapped" run (ywr-harness ADR 0110).
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

  // Staleness signal (ywr-harness ADR 0043): advisory only, CI's drift gate enforces on merge.
  // A missing stamp is reported too, so silence means "current".
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
    // An empty output would read as "nothing to verify" to the /ywr-harness:verify skill (ywr-harness ADR 0041).
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

  // Printed at the end of the run. Not appended to `late`, which is already drained above: a
  // swallowed warning about a refused value looks like a good configuration.
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
    // An entry without a usable id still maps: dropping it would hide its verify scripts as "no
    // spec owns this". It shows under a placeholder and is warned.
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
  // The retro's ignore register exempts the same files (ywr-harness ADR 0115), so this list never
  // shows debt the retro does not report. The scopes stay two declarations (`verify.product_scope`
  // here, `retro.source_scope` there): a file in the first and outside the second is still listed.
  // The register is read only when something is unmapped. A bad register line is warned at the end.
  const ign = unmapped.length ? hc.load_ignore(root, cfg.retro_ignore_file, refused) : []
  const exempt = unmapped.filter((f) => hc.any_match(ign, f))
  unmapped = unmapped.filter((f) => !hc.any_match(ign, f))

  if (!hits.size) {
    hc.say(`${files.length} changed file(s) map to no spec — no registered verify script.`)
  }
  for (const sid of hc._sorted([...hits.keys()])) {
    const h = hits.get(sid)
    // Print through `hc.say()`, the one stdout exit: id, title and filenames are repo-supplied, and a
    // newline in one could forge a `run:` line for the model that reads this output.
    hc.say(`spec ${sid} — ${hc._str(h.title)}`)
    for (const f of h.matched) hc.say(`  changed: ${f}`)
    if (h.verify.length) {
      for (const v of h.verify) {
        const cmd = hc.verify_command(cfg, v, refused)
        // A refusal never takes the `run:` slot: the /ywr-harness:verify skill runs every `run:` line,
        // so a refused path gets a `REFUSED:` line that reads as a finding.
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
