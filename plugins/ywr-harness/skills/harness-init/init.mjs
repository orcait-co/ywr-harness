// Scaffold the docs-as-code shape into a repo. Deterministic placement, no model judgment —
// that is why this is a script and not prose in SKILL.md: a scaffold that cannot be tested is a
// scaffold nobody can trust to re-run.
//
// Run: node init.mjs --target <dir> [--dry-run] [--force] [--allow-upstream-ahead]
//                    [--fetch-timeout-seconds N]
// Node 22.0 or later, built-in modules only. Output is plain text on stdout, through the one writer
// `say`. Nothing is ever written to stderr by this script: stderr carries only what Node itself prints
// when the script crashes, and a caller reads a crash from that report (see "Exit codes").
//
// Re-runnable by design, with a hard split that is the whole point of the file. The placement map —
// which template lands where, in which mode — lives in placement.mjs, the one owner every reader
// imports:
//
//   TOOLCHAIN — overwritten on every run. The builder and the rule/template documents are the
//               canon's copies; re-running is how a plugin-side improvement reaches this repo.
//               A consuming repo must not hand-edit these (ywr-harness ADR 0010): edit them here
//               and they are silently reverted on the next run, which is the intended signal.
//   SEED      — created once, NEVER overwritten. A repo's CLAUDE.md and .gitattributes carry
//               decisions this script cannot know. Clobbering them would destroy work, so an
//               existing file is reported as preserved and left byte-identical.
//
// Nothing is ever deleted. There is no path through this script that removes a file.
//
// TOOLCHAIN overwrite applies to RE-runs only: on a FIRST run (no .harness-version stamp) an
// existing, differing file at a toolchain path is refused rather than replaced — it is not the
// canon's output, and overwriting it is data loss, not an update (ywr-harness ADR 0055). --force replaces
// deliberately; the stamp is withheld while such refusals stand.
//
// Exit codes. 0 = placement completed (with or without preserved seeds and refusals). 1 = target
// unusable, a template is missing from the plugin, a write failed, or a guard refused before any
// write (downgrade, ywr-harness ADR 0042; upstream ahead, ywr-harness ADR 0135). A failed pre-check fetch
// (ywr-harness ADR 0137) is one line, never an exit. 2 = a usage error (an unknown flag, a value out of
// range). A crash of this script is none of these: it is never caught here, so Node prints its
// uncaught-error report to stderr, which ends with a `Node.js vNN.N.N` line, and exits 1. A caller that
// must tell a crash from the verdict 1 reads that trailer.
//
// The script never calls process.exit(): a piped stdout can be cut short by it. The verdict is
// process.exitCode, set once on the last line.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawn, spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { git_result, git_absent, which_on_path } from '../../scripts/harness_git.mjs'
import { TOOLCHAIN, INTRODUCED_IN, GUARD_MARKER, GUARDED, SEED, SEED_CORPUS, RETIRED } from './placement.mjs'

const WIN = process.platform === 'win32'
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
const STAMP_FILE = '.harness-version'
const HOOKS_DIR = '.githooks'
// Control, format and line/paragraph-separator characters: repo-authored text that lands on a
// console line is flattened with this.
const FLATTEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

// The one output writer.
function say(line) { process.stdout.write(line + '\n') }

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
// PowerShell's `-contains` / `-notcontains` compare strings case-insensitively.
const ciIncludes = (list, s) => { const l = String(s).toLowerCase(); return list.some((x) => String(x).toLowerCase() === l) }
const readBytes = (p) => fs.readFileSync(p)
const readTextFile = (p) => readBytes(p).toString('utf8').replace(/^\uFEFF/, '')
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const psTruthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '')
const lines = (text) => { const l = text.split(/\r?\n/); if (l.length && l[l.length - 1] === '') l.pop(); return l }

// --- git: every parsed call goes through harness_git.mjs, the one subprocess boundary -------------
// An argv array and no shell, git spawned by absolute path, the output decoded once as UTF-8 and
// `core.quotepath=false` pinned, so a path that git prints is never octal-quoted whatever the member's
// global config says (ywr-harness ADR 0077). This script parses no path list, only single values. The
// one git call outside the boundary is the detached candidate fetch below: it needs its own process
// group and a timeout that kills the whole tree, which a synchronous call cannot give.
function git(args) {
  try {
    const r = git_result(process.cwd(), args)
    return { absent: false, status: r.status, out: r.stdout }
  } catch (e) {
    return { absent: Boolean(e && e.code === 'ENOENT'), status: -1, out: '' }
  }
}
const gitAbsent = () => git_absent()

// `Get-Command`: a name found on PATH, the first match in PATH order (PATHEXT on Windows).
function findOnPath(name) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  // On Windows a program or a batch file in PATHEXT order, never an extensionless file, which cannot
  // start there.
  const exts = WIN
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toUpperCase()).filter(e => ['.COM', '.EXE', '.BAT', '.CMD'].includes(e))
    : ['']
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e)
      try {
        fs.lstatSync(p)
        if (!WIN) fs.accessSync(p, fs.constants.X_OK)
        return p
      } catch { /* not here */ }
    }
  }
  return null
}

// A version with four numeric components, comparable. '0.28' pads to 0.28.0.0 — padding with -1, as a
// .NET [version] does, would compare '0.28' BELOW '0.28.0' and flip the downgrade verdict. The same
// rule as the refresh nudge's direction probe, cross-referenced there; more than four components stays
// invalid.
function toVersionOrNull(s) {
  if (!s) return null
  const t = String(s).trim().replace(/^v/i, '')
  if (!/^\d+(\.\d+)+$/.test(t)) return null
  const parts = t.split('.')
  if (parts.length > 4) return null
  const n = parts.map(Number)
  while (n.length < 4) n.push(0)
  return n.some((x) => !Number.isFinite(x) || x > 2147483647) ? null : n
}
function cmpVersion(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

// --- regex translation (a declared pattern written in Python syntax -> a JavaScript RegExp) ---------
// Group regexes keep the `re.match` rule of harness_config.mjs: anchored at the start only, so `^(?:…)`
// is that anchor here. The pattern compiles ALONE first: wrapped unchecked, `x)|(.*` would escape the group
// and claim every path where Python refuses it. Python's named-group spellings `(?P<n>` and `(?P=n)`
// become JavaScript's; a leading `(?i)` / `(?s)` / `(?m)` becomes a flag. Python's `\A` and `\Z` (start
// and end of the string) become lookarounds that mean the same. A letter escape that a non-unicode
// JavaScript regex would read silently as the bare letter (`\a`, `\z`, `\U`, `\N` ...) throws instead.
// Any other Python-only construct (a conditional `(?(1)…)`, an atomic group `(?>…)`, a verbose `(?x)`,
// a possessive quantifier), or a pattern JavaScript refuses, claims nothing. On the repo side that errs
// toward speaking. The template side is ours, and init.selftest pins that every template match
// compiles here, so no consumer goes silent. A caller calls this inside the try of its RegExp compile.
const JS_LETTER_ESCAPES = new Set('bBdDwWsSfnrtvxu')
function translatePattern(pattern) {
  let p = pattern.replace(/\(\?P</g, '(?<').replace(/\(\?P=(\w+)\)/g, '\\k<$1>')
  let flags = ''
  const m = /^\(\?([ism]+)\)/.exec(p)
  if (m) { flags = [...new Set(m[1])].join(''); p = p.slice(m[0].length) }
  let out = ''
  let inClass = false
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '\\' && i + 1 < p.length) {
      const n = p[i + 1]
      i++
      if (/[A-Za-z]/.test(n)) {
        if (!inClass && n === 'A') { out += '(?<![\\s\\S])'; continue }
        if (!inClass && n === 'Z') { out += '(?![\\s\\S])'; continue }
        // `\k<name>` is the named backreference made above; any other letter must mean the same in both engines.
        if (n === 'k' && !inClass && p[i + 1] === '<') { out += '\\k'; continue }
        if (!JS_LETTER_ESCAPES.has(n)) throw new SyntaxError(`escape \\${n} has no JavaScript equivalent`)
      }
      out += c + n
      continue
    }
    if (inClass) { if (c === ']') inClass = false }
    else if (c === '[') {
      inClass = true
      // A `]` right after `[` or `[^` is a literal member in Python; JavaScript reads `[]` as an empty
      // class, so it is escaped.
      if (p[i + 1] === '^') { out += '[^'; i++ } else out += c
      if (p[i + 1] === ']') { out += '\\]'; i++ }
      continue
    }
    out += c
  }
  return { p: out, flags }
}

// A JavaScript regex has no match timeout, and `^(a+)+$` on a long non-match never returns. A match
// that must be bounded runs in a vm context, which stops the script at the limit and throws.
const timedContext = vm.createContext({})
function timedTest(rx, s, ms) {
  timedContext.rx = rx
  timedContext.s = s
  return vm.runInContext('rx.test(s)', timedContext, { timeout: ms })
}

// Files directly in `dir`, or under it when `deep`: hidden entries (a dot name) and links — to a
// directory or a file — are never listed. A generator, so a caller that catches a failure keeps what
// the walk had listed. An inaccessible directory is skipped, not an error.
function* listFiles(dir, deep) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue
    const full = path.join(dir, e.name)
    if (e.isFile()) yield full
    else if (deep && e.isDirectory()) yield* listFiles(path.join(dir, e.name), true)
  }
}

const usage = 'usage: node init.mjs --target <dir> [--dry-run] [--force] [--allow-upstream-ahead] [--fetch-timeout-seconds N]'

async function main() {
  // --- arguments ---------------------------------------------------------------------------------
  let values
  try {
    values = parseArgs({
      args: process.argv.slice(2),
      options: {
        target: { type: 'string' },
        'dry-run': { type: 'boolean' },
        force: { type: 'boolean' },
        'allow-upstream-ahead': { type: 'boolean' },
        'fetch-timeout-seconds': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }).values
  } catch (e) {
    say(`USAGE — ${e.message}`)
    say(usage)
    return 2
  }
  const target = values.target ?? '.'
  const dryRun = Boolean(values['dry-run'])
  const force = Boolean(values.force)
  const allowUpstreamAhead = Boolean(values['allow-upstream-ahead'])
  // The bound on the pre-check fetch of the candidate remotes (ywr-harness ADR 0137). The default is the
  // decision; overridable for tests, which pin the timeout path without a 10 s wait.
  let fetchTimeoutSeconds = 10
  if (values['fetch-timeout-seconds'] !== undefined) {
    const raw = values['fetch-timeout-seconds']
    fetchTimeoutSeconds = /^\d+$/.test(raw) ? Number(raw) : NaN
    if (!(fetchTimeoutSeconds >= 1 && fetchTimeoutSeconds <= 600)) {
      say(`USAGE — --fetch-timeout-seconds must be a whole number from 1 to 600, got '${raw}'`)
      say(usage)
      return 2
    }
  }

  const templates = path.join(SELF_DIR, 'templates')
  if (!isDir(templates)) {
    say(`FAIL — templates/ not found next to init.mjs (looked in ${templates})`)
    return 1
  }

  const root = path.resolve(target)
  if (!fs.existsSync(root)) { say(`FAIL — target not found: ${target}`); return 1 }
  if (!isDir(root)) { say(`FAIL — target is not a directory: ${root}`); return 1 }

  // --- downgrade guard (ywr-harness ADR 0042) --------------------------------------------------------
  // `.harness-version` records which plugin version last scaffolded this repo — written below on
  // every successful non-dry run, GENERATED and never a template (a templated stamp would change
  // every release and nag every repo, ywr-harness ADR 0033's recorded reason for rejecting a stamp in the trigger
  // role). When the repo's stamp is NEWER than this copy, another writer refreshed the repo with a
  // newer plugin (the multi-writer everyday state), and proceeding would place older templates over
  // their refresh. Refused BEFORE anything is written; --force is the deliberate-rollback path. A
  // missing or unparseable stamp proceeds: refusing on absence could never destroy newer work, but
  // it would strand every pre-0042 repo.
  const stampPath = path.join(root, STAMP_FILE)
  let ownVersionRaw = null
  try {
    const mf = JSON.parse(readTextFile(path.join(SELF_DIR, '..', '..', '.claude-plugin', 'plugin.json')))
    if (isObj(mf) && typeof mf.version === 'string' && /\d/.test(mf.version)) ownVersionRaw = mf.version.trim()
  } catch { ownVersionRaw = null }
  const ownVersion = toVersionOrNull(ownVersionRaw)
  // First run = no stamp FILE, whatever its content (only this scaffold plausibly writes that
  // name). On a first run an existing file at a TOOLCHAIN path is by definition not a canon
  // artifact, so overwriting it is data loss, not an update — those collisions are refused below
  // (ywr-harness ADR 0055). A present-but-garbage stamp still counts as "has run": refusing there could only
  // protect files a previous run already placed.
  const isFirstRun = !isFile(stampPath)
  let repoStamp = null
  let repoStampRaw = ''
  if (isFile(stampPath)) {
    try {
      // BOUNDED read — never a whole-file read: a stamp with no newline before EOF would be read WHOLE
      // as "line 1", and a symlink at a device never returns. 64 bytes is generous for a version token.
      const fd = fs.openSync(stampPath, 'r')
      let buf, n
      try { buf = Buffer.alloc(64); n = fs.readSync(fd, buf, 0, 64, 0) } finally { fs.closeSync(fd) }
      const off = n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0
      // ASCII decode: a byte above 0x7F is '?'
      let line = buf.subarray(off, n).toString('latin1').replace(/[\x80-\xff]/g, '?')
      const cut = line.search(/[\r\n]/)
      if (cut >= 0) line = line.slice(0, cut)
      repoStampRaw = line.trim()
      repoStamp = toVersionOrNull(repoStampRaw)
    } catch { repoStamp = null; repoStampRaw = '' }
  }
  if (repoStamp && ownVersion && cmpVersion(repoStamp, ownVersion) > 0) {
    if (force) {
      say(`DOWNGRADE FORCED — repo stamp v${repoStampRaw} > this plugin v${ownVersionRaw}; proceeding because --force was given (ywr-harness ADR 0042).`)
    } else {
      say(`REFUSED — this repo's toolchain was last scaffolded by ywr-harness v${repoStampRaw}, NEWER than this copy (v${ownVersionRaw}).`)
      say('  Placing these templates would DOWNGRADE files another writer refreshed (ywr-harness ADR 0042). Nothing was written.')
      say("  Remedy: update the plugin first — /ywr-harness:update (or 'claude plugin update'), then restart or /reload-plugins.")
      say('  A deliberate rollback re-runs with --force.')
      return 1
    }
  }

  // --- same-version conflict signal (ywr-harness ADR 0067) ----------------------------------------------
  // stamp == this plugin's version means the canon cannot have changed a placed file since the last
  // scaffold — a refresh-path delta on this run is a LOCAL hand edit (or a modified plugin copy),
  // the #55 shape ywr-harness ADR 0010 wants surfaced upstream. Collected during placement, reported after it.
  // First runs can never qualify (no stamp), so this never overlaps ywr-harness ADR 0055's collision buckets.
  // When this script itself runs FROM the target tree (the canon dogfood, ywr-harness ADR 0018), templates newer
  // than the stamp's release are the intended source->placement propagation, not a hand edit — the
  // verdict is replaced by a visible one-line note, never silently dropped.
  const sameVersionRun = Boolean(repoStamp && ownVersion && cmpVersion(repoStamp, ownVersion) === 0)
  let inTreeRun = false
  try {
    const eq = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b)
    const selfDir = path.resolve(SELF_DIR).replace(/[\\/]+$/, '')
    const rootFull = path.resolve(root).replace(/[\\/]+$/, '')
    inTreeRun = eq(selfDir, rootFull) ||
      (WIN ? selfDir.toLowerCase() : selfDir).startsWith((WIN ? rootFull.toLowerCase() : rootFull) + path.sep) ||
      (WIN ? selfDir.toLowerCase() : selfDir).startsWith((WIN ? rootFull.toLowerCase() : rootFull) + '/')
  } catch { inTreeRun = false }
  const sameVersionDrift = []
  let revertDir = ''
  const revertSaved = []
  const revertFailed = []

  const introducedIn = new Map(INTRODUCED_IN)

  // --- upstream-ahead guard (ywr-harness ADR 0135) ---------------------------------------------------------
  // Multi-writer, the other direction: a teammate ran this scaffold (first run or refresh) and pushed;
  // this clone has not pulled. A run here would place files that collide with theirs at the next pull,
  // or put older templates over their refresh — and the downgrade guard above cannot see it, because
  // this clone's own stamp is the OLD one. So: look at the remote-tracking refs for commits this
  // checkout lacks that touch the stamp. This function makes no network call — the refs are as of the
  // LAST FETCH, which the pre-check fetch below makes this run's own when it succeeds (ywr-harness ADR 0137).
  // Candidate refs, in order: the current branch's upstream, then the remote default
  // branch (origin/HEAD, already the offline default-branch signal below, ywr-harness ADR 0062). Path: the stamp
  // ALONE. This script writes the stamp on every run that changes the version and on a first run; a
  // same-version re-run places byte-identical templates, so it cannot collide at a pull. A hand edit of a
  // toolchain or guarded file is not a scaffold run (the ywr-harness ADR 0042 equal-version branch owns hand edits),
  // and counting it would refuse init on any long-lived branch behind a hand-edited main. The commit
  // walk is patch-equivalence filtered (--cherry-pick --right-only over HEAD...ref): a local rebase or
  // amend of a stamp commit is not upstream-ahead merely because the pre-rewrite commit is still on the
  // ref until the force-push. git absent, not a repo, no refs, or any git failure is no hit:
  // behaviour as before the guard, never an error line. The refusal sits before the first write, and it applies under
  // --dry-run too — the dry run must show the real run's refusals. Own switch (--allow-upstream-ahead), never --force: --force also bypasses the ywr-harness ADR 0055
  // first-run collision refusals. The refresh nudge runs the same detection (same definition, ywr-harness ADR 0135).
  function findUpstreamScaffoldAhead() {
    if (gitAbsent()) return null
    const refs = []
    const up = git(['-C', root, 'rev-parse', '--symbolic-full-name', '@{upstream}'])
    const upL = lines(up.out)
    if (up.status === 0 && upL.length && upL[0].trim().startsWith('refs/')) refs.push(upL[0].trim())
    const oh = git(['-C', root, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    const ohL = lines(oh.out)
    if (oh.status === 0 && ohL.length && ohL[0].trim().startsWith('refs/')) {
      const o = ohL[0].trim()
      if (!ciIncludes(refs, o)) refs.push(o)
    }
    for (const ref of refs) {
      const r = git(['--literal-pathspecs', '-C', root, 'log', '-1', '--cherry-pick', '--right-only', '--format=%h%x09%cs', `HEAD...${ref}`, '--', STAMP_FILE])
      const hit = lines(r.out)
      if (r.status !== 0 || !hit.length || !hit[0].trim()) continue
      const f = hit[0].trim().split('\t')
      // A ref name is repo-authored text that lands on a console line: flatten controls, format
      // characters and line/paragraph separators (git itself already forbids C0 controls).
      const name = ref.replace(/^refs\/remotes\//, '').replace(FLATTEN, ' ')
      return { ref: name, sha: f[0], date: f.length > 1 ? f[1] : '' }
    }
    return null
  }

  // --- pre-check fetch (ywr-harness ADR 0137) ----------------------------------------------------------------
  // The refs above are as of the last fetch, and the skill's "git fetch first" prose was skippable, so a
  // teammate's unfetched push slipped past the refusal. This script fetches the candidate remotes itself:
  // the current branch's upstream remote, then origin — configured remote NAMES only (a URL-valued
  // branch.<b>.remote cannot ride --multiple), a local upstream ('.') adds none. One git process, pinned
  // against the member's config: --no-tags --no-prune --no-recurse-submodules, and no auto gc/maintenance
  // (a killed gc is the widest lock window). Non-interactive: GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never,
  // stdin closed, and ssh in BatchMode — set ONLY when neither GIT_SSH_COMMAND, GIT_SSH nor core.sshCommand
  // names the member's own ssh, which is never overridden. Bounded by --fetch-timeout-seconds, after which
  // the whole process tree is stopped; a stop can strand git's *.lock files, so the line NAMES any lock
  // under the git dir written since the fetch began — never deletes one: an IDE's background fetch may own
  // it. Under --dry-run too: the fetch moves remote-tracking refs and objects only, never the working tree,
  // and the dry run must show the real run's refusals (ywr-harness ADR 0135). Skipped under --allow-upstream-ahead: there
  // the check only prints the ALLOWED line, and no outcome waits on a fetch. A failure or timeout NEVER
  // blocks — one line, then the check reads the last fetch. The line never quotes git's output: it
  // can carry a credentialed URL. Success is silent; the refusal block then says the refs are fresh. No
  // candidate remote: no fetch, no line. The SessionStart nudge stays network-free (ywr-harness ADR 0033).
  function getFetchCandidateRemotes() {
    if (gitAbsent()) return []
    const rem = git(['-C', root, 'remote'])
    const names = lines(rem.out).map((l) => l.trim()).filter(Boolean)
    if (rem.status !== 0 || !names.length) return []
    const want = []
    const br = git(['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'])
    const brL = lines(br.out)
    if (br.status === 0 && brL.length && brL[0].trim()) {
      const r = git(['-C', root, 'config', '--get', `branch.${brL[0].trim()}.remote`])
      const rL = lines(r.out)
      if (r.status === 0 && rL.length) want.push(rL[0].trim())
    }
    want.push('origin')
    const out = []
    for (const w of want) if (names.includes(w) && !out.includes(w)) out.push(w)
    return out
  }
  function getStrandedFetchLocks(sinceMs) {
    // Lock files a stopped fetch can leave: top-level (packed-refs.lock, shallow.lock, ...) and any under
    // refs/remotes/. Written since the fetch began (2 s slack for coarse mtimes). Display paths only.
    const cd = git(['-C', root, 'rev-parse', '--git-common-dir'])
    const cdL = lines(cd.out)
    if (cd.status !== 0 || !cdL.length || !cdL[0].trim()) return []
    let gd = cdL[0].trim()
    if (!path.isAbsolute(gd)) gd = path.join(root, gd)
    const cut = sinceMs - 2000
    const locks = []
    const scan = (dir, deep) => {
      let ents
      try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        const full = path.join(dir, e.name)
        if (e.isFile() && e.name.toLowerCase().endsWith('.lock')) locks.push(full)
        else if (deep && e.isDirectory()) scan(full, true)
      }
    }
    scan(gd, false)
    const rr = path.join(gd, 'refs', 'remotes')
    if (isDir(rr)) scan(rr, true)
    const rootFull = path.resolve(root).replace(/[\\/]+$/, '')
    return locks.filter((f) => { try { return fs.statSync(f).mtimeMs >= cut } catch { return false } })
      .map((full) => {
        const show = full.toLowerCase().startsWith((rootFull + path.sep).toLowerCase()) ? full.slice(rootFull.length + 1) : full
        return show.replace(/\\/g, '/').replace(FLATTEN, ' ')
      }).sort()
  }
  // Stops git and every process it started: a hung transport is a grandchild, and killing git alone
  // would leave it running.
  function killTree(child) {
    try {
      if (WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      else process.kill(-child.pid, 'SIGKILL')
    } catch { /* already gone */ }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  async function invokeCandidateFetch(remotes) {
    // null = fetched; otherwise the failure clause for the one line.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
    let ownSsh = Boolean(process.env.GIT_SSH_COMMAND || process.env.GIT_SSH)
    if (!ownSsh) {
      const sc = git(['-C', root, 'config', '--get', 'core.sshCommand'])
      const scL = lines(sc.out)
      ownSsh = sc.status === 0 && scL.length > 0 && Boolean(scL[0].trim())
    }
    if (!ownSsh) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
    const began = Date.now()
    const args = ['-C', root, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '--quiet', '--no-tags', '--no-prune',
      '--no-recurse-submodules', '--multiple', '--', ...remotes]
    let child
    const gitExe = which_on_path('git')
    if (!gitExe) return 'could not start git'
    try { child = spawn(gitExe, args, { env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, detached: !WIN }) } catch { return 'could not start git' }
    const done = new Promise((resolve) => {
      child.once('error', () => resolve({ error: true }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    let timerHandle
    const timer = new Promise((resolve) => { timerHandle = setTimeout(() => resolve({ timeout: true }), fetchTimeoutSeconds * 1000) })
    // Off Windows the fetch runs in its own process group (so a timeout can kill its whole tree), which
    // also keeps a terminal's Ctrl+C from reaching it. While it runs, an interrupt of this script stops
    // the tree first and then ends this script with the same signal.
    const onSignal = (sig) => {
      killTree(child)
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal)
      process.kill(process.pid, sig)
    }
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal)
    let res
    try { res = await Promise.race([done, timer]) }
    finally {
      clearTimeout(timerHandle)
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal)
    }
    if (res.error) return 'could not start git'
    if (res.timeout) {
      killTree(child)
      await Promise.race([done, new Promise((r) => setTimeout(r, 2000))])
      let clause = `did not finish in ${fetchTimeoutSeconds} s and was stopped`
      // The scan is advice on a path that must never block: any throw reads as no lock.
      let locks = []
      try { locks = getStrandedFetchLocks(began) } catch { locks = [] }
      if (locks.length) {
        let named = locks.slice(0, 3).join(', ')
        if (locks.length > 3) named += ` and ${locks.length - 3} more`
        clause += ` — it may have left lock file(s) ${named}; if no other git command is running, delete them before the next fetch`
      }
      return clause
    }
    if (res.code !== 0) return `exited ${res.code ?? res.signal}`
    return null
  }
  let fetchedFresh = false
  if (!allowUpstreamAhead) {
    const fetchRemotes = getFetchCandidateRemotes()
    if (fetchRemotes.length) {
      const fetchShow = fetchRemotes.join(' ').replace(FLATTEN, ' ')
      const fetchFail = await invokeCandidateFetch(fetchRemotes)
      if (fetchFail) {
        say(`FETCH FAILED — git fetch ${fetchShow} ${fetchFail}; the upstream-ahead check reads the remote-tracking refs as of the last fetch (ywr-harness ADR 0137).`)
      } else { fetchedFresh = true }
    }
  }
  const upstreamAhead = findUpstreamScaffoldAhead()
  if (upstreamAhead) {
    const uaClause = `${upstreamAhead.ref} has commit(s) not in this checkout that change the scaffold (newest ${upstreamAhead.sha}, ${upstreamAhead.date})`
    if (allowUpstreamAhead) {
      say(`UPSTREAM AHEAD ALLOWED — ${uaClause}; proceeding because --allow-upstream-ahead was given (ywr-harness ADR 0135).`)
    } else {
      say(`REFUSED — ${uaClause}: another clone scaffolded or refreshed this repo and pushed. Nothing was written.`)
      const freshness = fetchedFresh
        ? 'This run fetched the remote-tracking refs just before the check (ywr-harness ADR 0137).'
        : "Remote-tracking refs are as of the last fetch — 'git fetch' first to see the newest state."
      say(`  Remedy: pull first (git pull, or merge/rebase ${upstreamAhead.ref}), then re-run. ${freshness}`)
      say('  A deliberate run on a diverging branch re-runs with --allow-upstream-ahead.')
      return 1
    }
  }

  const created = []; const refreshed = []; const preserved = []; const failed = []; const skippedSeed = []; const refused = []
  // ywr-harness ADR 0055's two buckets: first-run TOOLCHAIN collisions refused (differing content, no stamp,
  // no --force), and the --force replacements — labeled truthfully, never as "refreshed". ywr-harness ADR 0074
  // adds a third refusal bucket: a re-run (stamped) that collides on a path INTRODUCED_IN says this
  // repo's stamp predates — same refusal shape, counted and reported separately because the cause
  // ("this path is new since your stamp") differs from "this repo was never scaffolded".
  const firstRunRefused = []; const replaced = []; const introducedRefused = []

  function testPathIntroducedAfterStamp(dest) {
    // True when `dest` has an INTRODUCED_IN entry whose version is STRICTLY NEWER than this repo's
    // stamp — i.e. the path did not exist in the plugin version that last scaffolded this repo, so
    // an existing foreign file there is the PATH's first appearance here, not an ordinary re-run
    // collision (ywr-harness ADR 0074). An unparsable or missing repo stamp treats every introduced path as
    // "introduced later" — refusing is the safe side (the ywr-harness ADR 0042
    // downgrade guard's absent-stamp case is fail-OPEN; this one is deliberately the opposite,
    // because here failing open would silently overwrite a file that never went through this
    // guard). A malformed INTRODUCED_IN value (should never happen — reviewed at the one call
    // site that adds entries) reads as "not gated", never as "unsafe", so it can't jam placement.
    if (!introducedIn.has(dest)) return false
    const introduced = toVersionOrNull(introducedIn.get(dest))
    if (!introduced) return false
    if (!repoStamp) return true
    return cmpVersion(introduced, repoStamp) > 0
  }

  function place(rel, dest, overwrite, ownershipKnown = false) {
    const src = path.join(templates, rel)
    if (!isFile(src)) {
      failed.push(`template missing in plugin: ${rel}`)
      return
    }
    const dst = path.join(root, dest)
    const exists = isFile(dst)

    if (exists && !overwrite) { preserved.push(dest); return }

    // Placement owns the line discipline: whatever it writes is LF. The installed plugin is
    // materialized by the CONSUMER's git, where core.autocrlf stamps CRLF onto every template
    // (measured: the v0.23.0 cache carried 162 CRLF pairs in githooks/pre-commit) — copying those
    // bytes verbatim broke sh hooks on POSIX checkouts ("/bin/sh^M: bad interpreter") and showed
    // as spurious modifications in an eol=lf repo. Latin1 maps bytes 1:1 to chars (byte-faithful
    // both ways), so this is a byte transform, not a decode: the WRITE folds only CRLF -> LF
    // (a lone 0x0D is content and stays); everything else — encoding, BOM — is exact.
    const text = readBytes(src).toString('latin1').replaceAll('\r\n', '\n')

    if (exists) {
      // Identical content is not a refresh — saying "refreshed" for a no-op inflates the report
      // and hides which files the canon actually changed. The COMPARE is ywr-harness ADR 0033's fold
      // VERBATIM — drop every 0x0D, paired or not — so this surface and the refresh nudge can
      // never disagree on what counts as a change (a CRLF-pair fold here would count a lone-CR
      // delta as a refresh the nudge stays silent on). The seed .gitattributes pins
      // `*.ps1 eol=crlf`, so a CRLF checkout of a byte-identical template is not a change — a raw
      // compare would say "refreshed" on every run forever.
      const existing = readBytes(dst).toString('latin1').replaceAll('\r', '')
      if (existing === text.replaceAll('\r', '')) return
    }

    // First-run TOOLCHAIN collision (ywr-harness ADR 0055): the file exists, its content DIFFERS (the
    // identical case returned above), and no stamp says this scaffold has run here — so it is
    // not the canon's output and overwriting it is data loss, not an update. Refused unless
    // --force; a GUARDED caller that already proved ownership by marker passes ownershipKnown.
    // Applies under --dry-run too: the dry run must show the same refusals the real run makes.
    //
    // ywr-harness ADR 0074 extends the same refusal to a RE-run: `dest` may be a path this repo's stamp
    // predates (testPathIntroducedAfterStamp) — that repo is not first-run overall, but for
    // THIS path it is, so a foreign file there is the identical data-loss shape, just counted and
    // reported under its own reason (bucket picked by which condition actually fired).
    let isReplacement = false
    const introducedLater = testPathIntroducedAfterStamp(dest)
    if (exists && overwrite && !ownershipKnown && (isFirstRun || introducedLater)) {
      if (force) isReplacement = true
      else if (isFirstRun) { firstRunRefused.push(dest); return }
      else { introducedRefused.push(dest); return }
    }

    // Same-version drift (ywr-harness ADR 0067): reaching here with an existing overwrite-mode file on a
    // RE-run means the content differs from the template while the stamp already equals this
    // plugin's version — a local hand edit this overwrite is about to revert (first runs never
    // set sameVersionRun, so isReplacement can't reach here with it). Recorded for the
    // upstream: block; on a real run the local content is copied aside FIRST, so the revert
    // never destroys the only copy of an uncommitted patch. A failed copy is reported per file
    // and never blocks the refresh — a temp-dir hiccup must not break the update path.
    if (exists && overwrite && sameVersionRun) {
      sameVersionDrift.push(dest)
      // In-tree (dogfood) runs skip the copy: the "local" content is the canon's own tree,
      // nothing uncommitted is being lost, and a silent temp write per propagation run is waste.
      if (!dryRun && !inTreeRun) {
        try {
          if (!revertDir) {
            // The process id in the name: the timestamp alone is second-resolution, so two runs in
            // the same second (a quick retry, or two same-leaf worktrees on one machine)
            // would share the dir and --force would silently overwrite each other's
            // backups — the one thing this mechanism exists to keep.
            const d = new Date()
            const p2 = (n) => String(n).padStart(2, '0')
            const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
            revertDir = path.join(os.tmpdir(), 'ywr-harness-reverted', `${path.basename(root)}-${stamp}-${process.pid}`)
          }
          const bak = path.join(revertDir, dest)
          fs.mkdirSync(path.dirname(bak), { recursive: true })
          fs.copyFileSync(dst, bak)
          // Success is tracked separately from revertDir being set: the dir name is
          // assigned BEFORE the copy that can fail, so the report must key the
          // "pre-revert copies:" line on at least one LANDED copy, or an all-failed run
          // would name a dir that holds nothing.
          revertSaved.push(dest)
        } catch { revertFailed.push(dest) }
      }
    }

    if (dryRun) {
      if (isReplacement) replaced.push(dest)
      else if (exists) refreshed.push(dest)
      else created.push(dest)
      return
    }
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.writeFileSync(dst, Buffer.from(text, 'latin1'))
      if (isReplacement) replaced.push(dest)
      else if (exists) refreshed.push(dest)
      else created.push(dest)
    } catch (e) { failed.push(`${dest} — ${e.message}`) }
  }

  function placeGuarded(rel, dest) {
    const src = path.join(templates, rel)
    if (!isFile(src)) {
      failed.push(`template missing in plugin: ${rel}`)
      return
    }
    const dst = path.join(root, dest)
    if (isFile(dst)) {
      let body = ''
      try { body = readTextFile(dst) } catch { body = '' }
      if (!body.toLowerCase().includes(GUARD_MARKER.toLowerCase())) {
        // Not ours. Refusing is the only safe reading: the file may be doing real work whose
        // reasons this scaffold cannot see.
        refused.push(dest)
        return
      }
    }
    // Ownership is settled here (absent, or the marker proved it ours), so the first-run
    // collision guard inside place() must not re-judge it (ywr-harness ADR 0055).
    place(rel, dest, true, true)
  }

  let considered = 0
  for (const [k, v] of TOOLCHAIN) { place(k, v, true); considered++ }
  for (const [k, v] of GUARDED) { placeGuarded(k, v); considered++ }
  for (const [k, v] of SEED) { place(k, v, false); considered++ }

  // "Empty" means NO existing decision records, whatever they are named and wherever they live.
  // The first shipped version matched only `^\d{4}-` names inside docs/adr/ — so a repo whose log
  // used another convention (ywr-harness ADR-001-*, 001-*, dated names) or another conventional home (doc/adr,
  // docs/decisions, ...) was seeded with a second 0001, forking its decision history. Two scopes,
  // ONE record predicate:
  //   - docs/adr/: any .md record counts. The scaffold's own placements (0000-template.md,
  //     README.md) are non-records under the predicate, so the check reads the same whether this
  //     run placed them, a previous run did, or — under --dry-run, where nothing is written —
  //     nobody has yet: exclusion is by name, never by provenance.
  //   - conventional homes elsewhere: named locations, not a tree-wide glob — a heuristic sweep
  //     would false-positive on unrelated notes.
  // A readme or a template is not a record, wherever it lives and whatever its case (deliberately
  // case-insensitive — checkout filesystems differ, and a lowercase readme.md is still a readme).
  // The template exclusion is anchored to the FILENAME SUFFIX: a real record about templating
  // ('0007-template-engine-selection.md') counts; 'decision-template.md' / '0000-template.md' do
  // not. The residual edge ('...-html-template.md') errs toward suppressing the seed, which is
  // loud, over placing it, which forks a repo's history.
  const isDecisionRecord = (name) => !(/^readme\.md$/i.test(name) || /template\.md$/i.test(name))
  // *.md files directly in a directory, hidden ones skipped, that are decision records.
  const recordsIn = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name.toLowerCase().endsWith('.md') && isDecisionRecord(e.name))
        .map((e) => e.name)
    } catch { return [] }
  }
  const adrDir = path.join(root, 'docs/adr')
  const existingRecords = isDir(adrDir) ? recordsIn(adrDir) : []
  const FOREIGN_ADR_DIRS = ['doc/adr', 'adr', 'docs/decisions', 'doc/architecture/decisions', 'docs/architecture/decisions']
  const foreignRecords = []
  for (const rel of FOREIGN_ADR_DIRS) {
    const p = path.join(root, rel)
    if (isDir(p)) {
      const found = recordsIn(p)
      if (found.length > 0) foreignRecords.push(`${rel} (${found.length})`)
    }
  }
  if (existingRecords.length === 0 && foreignRecords.length === 0) {
    for (const [k, v] of SEED_CORPUS) { place(k, v, false); considered++ }
  } else {
    // Independent reports: a transitional repo can hold records in BOTH places, and the operator
    // needs to hear about the foreign ones even when docs/adr/ is populated.
    if (existingRecords.length > 0) {
      let msg = `corpus seed not placed — docs/adr/ already holds ${existingRecords.length} record(s)`
      // The builder indexes only `NNNN-*.md` (build_docs.mjs FILE_RE). Suppressing the seed over
      // records the builder cannot see leaves the corpus unbuildable — the report must carry
      // the cause, or the later 'SKIP build' line states a failure with no explanation.
      const indexable = existingRecords.filter((n) => /^\d{4}-/.test(n))
      if (indexable.length === 0) {
        msg += ". NONE match the builder's NNNN-<slug>.md pattern, so the docs build will " +
          'refuse the corpus as empty — rename the records to NNNN-<slug>.md and give each ' +
          'frontmatter (see docs/adr/0000-template.md)'
      }
      skippedSeed.push(msg)
    }
    if (foreignRecords.length > 0) {
      skippedSeed.push('corpus seed not placed — existing decision records found outside docs/adr/: ' +
        `${foreignRecords.join('; ')}. The builder indexes docs/ only: migrate them into docs/adr/ ` +
        '(keep numbering, add frontmatter per docs/adr/0000-template.md), or the docs build will ' +
        'refuse the empty corpus.')
    }
  }

  // --- preserved-seed drift note (ywr-harness ADR 0051) ---------------------------------------------------------
  // A preserved seed is the one placement mode with no update path, so this probe REPORTS — never
  // merges — what the current template carries that the seed lacks. It closes the measured blind
  // spot between the toolchain stamp (ywr-harness ADR 0042) and the refresh nudge (ywr-harness ADR 0033): seed drift was
  // found only by hand (issue #44 — a repo missing `review.derived` and the load-bearing
  // `.githooks/* text eol=lf` line through five releases). Per-seed comparator, a closed set:
  //   harness.json  -> STRUCTURAL: template key paths absent here. `//` comment keys are skipped
  //                    and arrays are leaves — their content (groups, items) is repo-specific by
  //                    design and must not be compared.
  //   line-based    -> template lines (trimmed, non-empty, non-#) absent here; count + first one.
  // CLAUDE.md is deliberately absent: it is placeholder prose a repo rewrites wholesale, its review
  // canon section included, so every template line would read as "missing" forever — a
  // permanent-noise note is worse than none.
  // Read-only by construction; an unparseable seed is a reported probe skip, never fatal.
  const DRIFT_SEEDS = ['harness.json', 'gitattributes', 'gitignore', 'githooks/slice-retro-ignore']
  const seedRelByDest = new Map(SEED.map(([k, v]) => [v, k]))

  function getJsonKeyPaths(node, prefix = '') {
    const out = []
    if (!isObj(node)) return out
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('//')) continue
      const full = prefix ? `${prefix}.${k}` : k
      out.push(full)
      if (isObj(v)) out.push(...getJsonKeyPaths(v, full))
    }
    return out
  }

  // Scaffold gate lines (ywr-harness ADR 0129). Arrays are leaves above, so a repo whose docs group predates
  // ywr-harness ADR 0094 (`gates: []`, or the gate with `files: false`) never learns the file-scoped line — and the
  // STE-lite gate (ywr-harness ADR 0128) runs only when pre-commit hands check_docs.mjs the staged paths. The
  // template is the list, never a second copy here: each script gate it declares on a TOOLCHAIN
  // script must run, in the repo too, on every path the template routes to it. The emitter runs the
  // gates of EVERY group whose `match` claims a path (harness_gates.mjs), so a path is covered when
  // SOME repo group claiming it carries the gate — group names are the repo's to choose. A line
  // merely present somewhere is not coverage: in docs-generated alone it never sees a staged spec.
  // The probe paths are the scaffold's own placements, the template's docs.index unless the repo
  // moved its index, and the real files beside the placements (getScaffoldGateNote).
  function getScaffoldGateKey(gate) {
    if (!isObj(gate)) return ''
    if (!own(gate, 'runner') || !own(gate, 'script') || typeof gate.runner !== 'string' || typeof gate.script !== 'string') return ''
    // Absent = false, the emitter's default (harness_config.script_gate); a non-boolean is a
    // declaration the emitter already warns about, so it matches nothing here.
    let files = false
    if (own(gate, 'files')) { if (typeof gate.files !== 'boolean') return ''; files = gate.files }
    return `${gate.runner}|${gate.script}|${files ? 'True' : 'False'}`
  }

  // Each declaration's groups compile ONCE into matchers (anchored regex + gate keys).
  function getGroupMatchers(decl) {
    const out = []
    if (!isObj(decl)) return out
    if (!own(decl, 'groups')) return out
    const groups = Array.isArray(decl.groups) ? decl.groups : [decl.groups]
    for (const g of groups) {
      if (!isObj(g)) continue
      if (!own(g, 'match') || typeof g.match !== 'string') continue
      let p, flags, rx
      try {
        ({ p, flags } = translatePattern(g.match))
        new RegExp(p, flags)
        rx = new RegExp(`^(?:${p})`, flags)
      } catch { continue }
      const gates = []; const keys = []
      if (own(g, 'gates')) {
        for (const gate of (Array.isArray(g.gates) ? g.gates : [g.gates])) { const k = getScaffoldGateKey(gate); if (k) { gates.push(gate); keys.push(k) } }
      }
      out.push({ name: own(g, 'name') ? String(g.name ?? '') : '', anchored: `^(?:${p})`, flags, rx, gates, keys })
    }
    return out
  }

  // One alternation per gate key and side, so a probe path costs one test per side, not one per
  // group. Each part is anchored and compiled alone above, so the alternation cannot change what a
  // part claims — except a reference to a group: a backreference (`\1`, `\k<n>`) or a conditional.
  // A number shifts in an alternation and a name can repeat, so such a set stays one regex per group.
  // A set whose parts carry flags stays one regex per group too.
  function getUnionMatchers(parts) {
    if (!parts.length) return []
    if (parts.length === 1 || (!parts.some((x) => x.flags) && !parts.some((x) => /\\[1-9]|\\k<|\(\?\(/.test(x.anchored)))) {
      return [new RegExp(parts.map((x) => x.anchored).join('|'), parts[0].flags)]
    }
    return parts.map((x) => new RegExp(x.anchored, x.flags))
  }

  function getScaffoldGateNote(template, repo) {
    const placed = TOOLCHAIN.map((e) => e[1])
    const samples = [...placed, ...SEED_CORPUS.map((e) => e[1])]
    // The index is the one probe path a repo may move (its own docs.index). A moved index is not
    // at the template's path, so that probe would report a gap for a file the repo does not have.
    const tdocs = isObj(template) && psTruthy(template.docs) ? template.docs : undefined
    const ipHas = isObj(tdocs) && own(tdocs, 'index')
    const ipVal = ipHas ? tdocs.index : undefined
    const rdocs = isObj(repo) && own(repo, 'docs') && isObj(repo.docs) ? repo.docs : undefined
    const rpHas = Boolean(rdocs) && own(rdocs, 'index')
    const rpVal = rpHas ? rdocs.index : undefined
    let index = []
    if (ipHas && typeof ipVal === 'string' && ipVal && (!rpHas || rpVal === ipVal)) index = [ipVal]
    // scaffold gate key -> the gate, the template groups carrying it, and one matcher set per side
    const need = new Map()
    for (const g of getGroupMatchers(template)) {
      for (let j = 0; j < g.gates.length; j++) {
        if (!placed.includes(g.gates[j].script)) continue
        const key = g.keys[j]
        if (!need.has(key)) need.set(key, { key, gate: g.gates[j], tGroups: [], t: [], r: [] })
        need.get(key).tGroups.push(g)
      }
    }
    if (!need.size) return ''
    const rAll = getGroupMatchers(repo)
    for (const n of need.values()) {
      n.t = getUnionMatchers(n.tGroups)
      n.r = getUnionMatchers(rAll.filter((g) => g.keys.includes(n.key)))
    }
    // The placed paths are samples; the repo's real specs are what pre-commit will stage. A repo
    // group can claim the placed template files and miss every real spec, and the samples alone
    // stay silent then. So the working-tree files under each directory that holds a placed path a
    // scaffold gate claims join the probes — a directory listing, no git call. The listing is the working tree, not the tracked set: an untracked or ignored draft
    // there can be named too (ywr-harness ADR 0129 records it). The index's own directory is not listed: the
    // index path itself is probed. The listing skips hidden entries and links and inaccessible
    // directories. Real files lead the list, so the display cap never hides a real
    // spec behind a template file.
    const seen = new Set([...samples, ...index])
    const dirs = new Set()
    for (const p of samples) {
      const i = p.lastIndexOf('/')
      if (i <= 0 || dirs.has(p.slice(0, i))) continue
      for (const n of need.values()) for (const x of n.t) { if (x.test(p)) dirs.add(p.slice(0, i)) }
    }
    const real = []
    // A listing can still throw past a skipped inaccessible directory (a directory removed mid-walk, a
    // path too long). One directory's failure keeps what it listed and every sample gap, and says so.
    const stopped = []
    for (const d of dirs) {
      const full = path.join(root, d)
      if (!isDir(full)) continue
      try {
        for (const f of listFiles(full, true)) {
          const rel = d + '/' + path.relative(full, f).split(path.sep).join('/')
          if (!seen.has(rel)) { seen.add(rel); real.push(rel) }
        }
      } catch (e) { stopped.push(`${d} (${e.message})`) }
    }
    real.sort()
    // gate key -> the probe paths the repo leaves uncovered and the template groups that claim them
    const gaps = new Map()
    for (const p of [...real, ...samples, ...index]) {
      for (const [key, n] of need) {
        if (!n.t.some((x) => x.test(p))) continue
        // The repo side compares exact keys: runner and script are exact selectors and paths.
        if (n.r.some((x) => x.test(p))) continue
        if (!gaps.has(key)) gaps.set(key, { groups: [], paths: [] })
        const gp = gaps.get(key)
        if (!gp.paths.includes(p)) gp.paths.push(p)
        for (const tg of n.tGroups) {
          if (tg.rx.test(p) && !gp.groups.includes(tg.name)) gp.groups.push(tg.name)
        }
      }
    }
    const out = []
    for (const [key, w] of gaps) {
      const gate = need.get(key).gate
      const json = `{ "runner": ${JSON.stringify(gate.runner)}, "script": ${JSON.stringify(gate.script)}, "files": ${key.endsWith('|True') ? 'true' : 'false'} }`
      // Cap the path display like the key display above; the count stays exact.
      let shown = w.paths; let more = ''
      if (w.paths.length > 6) { shown = w.paths.slice(0, 6); more = `, +${w.paths.length - 6} more` }
      out.push(`no group claiming ${shown.join(', ')}${more} declares the scaffold gate ${json} (template: ${w.groups.join(', ')})`)
    }
    for (const s of stopped) out.push(`real-file listing stopped under ${s}`)
    return out.join('; ')
  }

  // review.docs_only value probe (ywr-harness ADR 0191). Arrays are leaves to the key probe, so a seed
  // whose docs_only predates the template's exclusions (CLAUDE.md, AGENTS.md, REVIEW.md, docs/ code,
  // docs/prompts/) made those paths review-exempt with no note (dist #15). Only the wider direction is
  // named: a path the repo exempts and the template reviews. A narrower repo value is safe and silent.
  // The template is the list; this function holds no copy of its exclusions.
  function getDocsOnlyRegexes(decl) {
    const out = { rx: [], bad: 0, notList: false }
    if (!isObj(decl)) return out
    if (!own(decl, 'review') || !isObj(decl.review)) return out
    if (!own(decl.review, 'docs_only')) return out
    const dv = decl.review.docs_only
    // The emitter ignores a non-list value with a warning, so it exempts nothing. The note still
    // says the value was not compared (ywr-harness ADR 0191 Decision 5).
    if (!Array.isArray(dv)) { out.notList = psTruthy(dv); return out }
    for (const p of dv) {
      // compile_re skips an empty pattern. The emitter reads a non-string item as its str(),
      // which JavaScript text cannot reproduce exactly, so such an item is not compared.
      if (typeof p === 'string' && !p) continue
      if (typeof p !== 'string') { out.bad++; continue }
      // Unanchored: the emitter's docs_exempt is `rx.search` (harness_gates.mjs). A match is bounded
      // by timedTest: a timeout throws, and the caller reports a probe skip.
      try { const { p: src, flags } = translatePattern(p); out.rx.push(new RegExp(src, flags)) } catch { out.bad++ }
    }
    return out
  }

  function getDocsOnlyNote(template, repo) {
    const r = getDocsOnlyRegexes(repo)
    if (r.notList) return 'review.docs_only is not a list, not compared'
    const bad = r.bad ? `review.docs_only: ${r.bad} pattern(s) the regex engine cannot read, not compared` : ''
    if (!r.rx.length) return bad
    const t = getDocsOnlyRegexes(template)
    // A template pattern that does not compile would make each path it exempts read as reviewed.
    // The template is ours and init.selftest pins it, so this is a skip, never a false list.
    if (t.bad || t.notList) return 'review.docs_only probe skipped: a template pattern the regex engine cannot read'
    const placed = []
    for (const p of [...TOOLCHAIN.map((e) => e[1]), ...SEED.map((e) => e[1]), ...SEED_CORPUS.map((e) => e[1])]) { if (!placed.includes(p)) placed.push(p) }
    const tdocs = isObj(template) && psTruthy(template.docs) ? template.docs : undefined
    const ip = isObj(tdocs) && own(tdocs, 'index') ? tdocs.index : undefined
    if (typeof ip === 'string' && ip && !placed.includes(ip)) placed.push(ip)
    // Real files: the root's own files, and every file under each directory that holds a placed
    // path. A directory under another listed directory is not listed twice. The listing skips
    // hidden entries and links, like the scaffold gate listing above.
    const dirs = []
    for (const p of placed) { const i = p.lastIndexOf('/'); if (i > 0 && !dirs.includes(p.slice(0, i))) dirs.push(p.slice(0, i)) }
    dirs.sort()
    const roots = []
    for (const d of dirs) { if (!roots.some((x) => d.startsWith(`${x}/`))) roots.push(d) }
    const seen = new Set(placed)
    const real = []
    const stopped = []
    for (const d of ['', ...roots]) {
      const full = d ? path.join(root, d) : root
      if (!isDir(full)) continue
      try {
        for (const f of listFiles(full, d !== '')) {
          let rel = path.relative(full, f).split(path.sep).join('/')
          if (d) rel = `${d}/${rel}`
          if (!seen.has(rel)) { seen.add(rel); real.push(rel) }
        }
      } catch (e) { stopped.push(`${d || '.'} (${e.message})`) }
    }
    real.sort()
    const wide = []
    for (const p of [...placed, ...real]) {
      if (!r.rx.some((x) => timedTest(x, p, 200))) continue
      if (!t.rx.some((x) => timedTest(x, p, 200))) wide.push(p)
    }
    const out = []
    if (wide.length) {
      let shown = wide; let more = ''
      if (wide.length > 6) { shown = wide.slice(0, 6); more = `, +${wide.length - 6} more` }
      const tv = template.review.docs_only
      out.push(`review.docs_only exempts ${wide.length} probed path(s) the template reviews: ${shown.join(', ')}${more} (template: ${JSON.stringify(Array.isArray(tv) ? tv : [tv])})`)
    }
    if (bad) out.push(bad)
    for (const s of stopped) out.push(`docs_only listing stopped under ${s}`)
    return out.join('; ')
  }

  function getSeedDriftNote(rel, dest) {
    const src = path.join(templates, rel)
    const dst = path.join(root, dest)
    if (!isFile(src) || !isFile(dst)) return ''
    if (rel === 'harness.json') {
      let t, r
      try {
        t = JSON.parse(readTextFile(src))
        r = JSON.parse(readTextFile(dst))
      } catch {
        // One message for read AND parse failures — naming only JSON here sent an operator
        // hunting a syntax error in a merely-locked file.
        return 'drift probe skipped: seed could not be read or parsed as JSON'
      }
      const have = getJsonKeyPaths(r)
      const missing = getJsonKeyPaths(t).filter((k) => !ciIncludes(have, k))
      const parts = []
      if (missing.length) {
        // A hand-written minimal declaration can lack dozens of keys — cap the display so the
        // note stays one line; the count is always exact.
        let shown = missing; let more = ''
        if (missing.length > 6) { shown = missing.slice(0, 6); more = `, +${missing.length - 6} more` }
        parts.push(`template has ${missing.length} key(s) this seed lacks: ${shown.join(', ')}${more}`)
      }
      // Guarded like the reads above: an unforeseen throw here would turn a completed placement into a
      // non-zero exit (the ywr-harness ADR 0051 exit contract).
      let gateNote
      try { gateNote = getScaffoldGateNote(t, r) } catch (e) { gateNote = 'scaffold gate probe skipped: ' + e.message }
      if (gateNote) parts.push(gateNote)
      let docsNote
      try { docsNote = getDocsOnlyNote(t, r) } catch (e) { docsNote = 'review.docs_only probe skipped: ' + e.message }
      if (docsNote) parts.push(docsNote)
      return parts.join('; ')
    }
    // Line-based seeds. Latin1 is the same byte-faithful read as place() — both sides go through
    // the identical transform, so the comparison can never be skewed by a decode.
    const readLines = (p) => readBytes(p).toString('latin1').replaceAll('\r', '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    // Guarded like the JSON branch: an unguarded read on a locked or ACL-denied seed would abort
    // the WHOLE run non-zero after every placement already succeeded — the exact exit-contract
    // violation ywr-harness ADR 0051 forbids (isFile proves existence, never readability).
    let missing
    try {
      const have = readLines(dst)
      missing = readLines(src).filter((l) => !ciIncludes(have, l))
    } catch { return 'drift probe skipped: seed or template could not be read' }
    if (!missing.length) return ''
    return `template has ${missing.length} line(s) this seed lacks, e.g. '${missing[0]}'`
  }

  const mode = dryRun ? ' (dry run — nothing written)' : ''
  say(`harness-init -> ${root}${mode}`)
  const refusedTotal = refused.length + firstRunRefused.length + introducedRefused.length
  say(`  created=${created.length} refreshed=${refreshed.length} replaced=${replaced.length} preserved=${preserved.length} refused=${refusedTotal} unchanged=${considered - created.length - refreshed.length - replaced.length - preserved.length - refusedTotal}`)
  for (const f of created) say(`  + ${f}`)
  for (const f of refreshed) say(`  ~ ${f} (toolchain refreshed from canon)`)
  // --force over a first-run collision is never labeled "refreshed": the previous content was not
  // the canon's, and the label must say what actually happened to it (ywr-harness ADR 0055).
  for (const f of replaced) say(`  ~ ${f} (REPLACED a pre-existing non-canon file under --force — previous content survives only in git history; ywr-harness ADR 0055)`)
  for (const f of firstRunRefused) {
    say(`  ! ${f} REFUSED — first run found an existing file at this TOOLCHAIN path (ywr-harness ADR 0055)`)
    say('      Nothing marks it as this scaffold\'s output, so it was left byte-identical. Merge or move it,')
    say('      then re-run; a deliberate replacement re-runs with --force (the previous content then survives')
    say('      only in git history).')
  }
  if (firstRunRefused.length) {
    // "First run" is INFERRED from the stamp's absence, and a scaffolded repo can lose its stamp
    // (never committed, or cleaned) — in that state the refusals above land on legitimate
    // toolchain drift, so the inference and its remedy must be stated, not implied.
    say(`      (No ${STAMP_FILE} stamp was found, so this run treated the repo as never scaffolded. If it WAS`)
    say('      scaffolded and only the stamp is missing, --force IS the normal re-run: toolchain files return')
    say('      to canon, and seeds are never touched either way.)')
  }
  for (const f of introducedRefused) {
    // ywr-harness ADR 0074: this repo IS stamped (unlike the block above), but the path entered TOOLCHAIN in a
    // plugin version newer than that stamp — so for this one path it is still a first appearance,
    // and an existing foreign file there is the same data loss ywr-harness ADR 0055 refuses, not a refresh.
    say(`  ! ${f} REFUSED — this TOOLCHAIN path is new in ${introducedIn.get(f)} (repo stamped ${repoStampRaw}) and a different file already exists there; not the canon's output — re-run with --force to replace it (ywr-harness ADR 0074, extends the first-run guard ywr-harness ADR 0055)`)
  }
  for (const f of preserved) {
    let note = ''
    const rel = seedRelByDest.get(f)
    if (rel && ciIncludes(DRIFT_SEEDS, rel)) note = getSeedDriftNote(rel, f)
    if (note) say(`  = ${f} (existing seed preserved — ${note})`)
    else say(`  = ${f} (existing seed preserved — not overwritten)`)
  }
  for (const f of refused) {
    say(`  ! ${f} REFUSED — an existing file without the '${GUARD_MARKER}' marker`)
    say('      It is doing something this scaffold did not write, so it was left alone.')
    say('      To get the retro too, add this line to it ABOVE any early exit — a line after an')
    say('      exit looks wired and never runs (the retro itself never blocks a commit):')
    say('        [ "$SLICE_RETRO" = "0" ] || node scripts/harness/harness_retro.mjs || true')
  }
  for (const f of skippedSeed) say(`  - ${f}`)
  // A file an earlier release placed and this one no longer does: named so the reader removes it. Never
  // deleted here (nothing is), never a `~` or `!` line (report-issue's dry-run parser reads those as
  // drift), and no effect on the exit code or the stamp. Real and dry runs alike.
  for (const r of RETIRED) {
    if (isFile(path.join(root, r.dest))) {
      say(`  retired: ${r.dest} — ywr-harness no longer places this file since ${r.since} (ywr-harness ADR ${r.adr}); delete it with git rm`)
    }
  }

  // --- same-version drift report (ywr-harness ADR 0067) ---------------------------------------------------------
  // The prefix `upstream: SAME-VERSION drift` is a stable contract: the harness-init SKILL keys on
  // it to start the draft->confirm->file flow, and report-issue's dry-run parser must keep ignoring
  // these lines (they match none of its `~`/`!` shapes).
  if (sameVersionDrift.length) {
    if (inTreeRun) {
      say(`  upstream: same-version drift on ${sameVersionDrift.length} file(s), but this plugin copy runs FROM the target tree (canon dogfood, ywr-harness ADR 0018) — source->placement propagation, not a hand edit; no report (ywr-harness ADR 0067).`)
    } else {
      say(`  upstream: SAME-VERSION drift — ${sameVersionDrift.length} file(s) marked ~ above differed from this plugin's templates while the stamp already reads v${repoStampRaw}.`)
      if (dryRun) {
        say('      At the same version that is a LOCAL hand edit (or a modified plugin copy), never a canon update (ywr-harness ADR 0010/0067). A real run will REVERT them; nothing was changed yet.')
        say('      Report it upstream BEFORE the real run (the draft reads the drift still in the working tree): /ywr-harness:report-issue — one confirmation before anything is filed.')
      } else {
        say('      At the same version that is a LOCAL hand edit (or a modified plugin copy), never a canon update (ywr-harness ADR 0010/0067). This run REVERTED them.')
        if (revertSaved.length) say(`      pre-revert copies: ${revertDir}`)
        if (revertFailed.length) say(`      pre-revert copy FAILED for: ${revertFailed.join(', ')} — that content now survives only in git history.`)
        say('      Report it upstream so the canon fixes it for every repo: /ywr-harness:report-issue — one confirmation before anything is filed.')
      }
    }
  }

  if (failed.length) {
    for (const f of failed) say(`  FAIL ${f}`)
    return 1
  }

  // --- toolchain stamp (ywr-harness ADR 0042) ------------------------------------------------------------------
  // Stamped only on a run that placed successfully (the failed-exit above never reaches here). The
  // refresh nudge reads this AFTER byte drift is found, to orient its advice; it is never the
  // trigger. In no placement map on purpose: manifest-gate's map-driven sweep and the nudge's
  // template comparison must never see it, so it can never itself count as drift.
  if (firstRunRefused.length || introducedRefused.length) {
    // A stamp means "scaffolded" (and, per-path, "scaffolded at least at this version") — writing
    // it now would make the very next run believe these paths were already resolved, silently
    // overwriting exactly the files the refusals above just protected (ywr-harness ADR 0055/0074).
    const unresolved = firstRunRefused.length + introducedRefused.length
    say(`  stamp: NOT written — ${unresolved} toolchain collision(s) above are unresolved; a stamped repo re-runs with overwrite semantics (ywr-harness ADR 0055/0074)`)
  } else if (ownVersionRaw) {
    if (dryRun) {
      say(`  stamp: would write ${STAMP_FILE} = ${ownVersionRaw} (dry run)`)
    } else {
      try {
        fs.writeFileSync(stampPath, Buffer.from(`${ownVersionRaw}\n`, 'ascii'))
        say(`  stamp: ${STAMP_FILE} = ${ownVersionRaw} (which plugin version last scaffolded this repo — ywr-harness ADR 0042; claimed built-in by the emitter, ywr-harness ADR 0044)`)
      } catch (e) {
        say(`  stamp: FAILED to write ${STAMP_FILE} — ${e.message} (reported, not silent)`)
      }
    }
  } else {
    say("  stamp: SKIPPED — this plugin copy's own version is unreadable from .claude-plugin/plugin.json (reported, not silent)")
  }

  // --- git hooks: executable bit, then CONDITIONAL wiring (ywr-harness ADR 0015) ------------------------------
  // This is the only thing init does that is not a file write, so it is bounded hard:
  //   unset       -> set it
  //   .githooks   -> leave it
  //   anything else -> REFUSE and report the existing value
  // `core.hooksPath` lives in .git/config, which is per-clone and never committed, so this wires the
  // machine that ran the scaffold and nothing else. The clone that never ran it is caught by the
  // `hooks:` line harness_gates.mjs prints — that report, not this block, is what closes the gap.
  const hookFiles = ['.githooks/pre-commit', '.githooks/pre-push', '.githooks/post-commit']

  if (!dryRun && !WIN) {
    // The placement write does not carry an executable bit, and git will not run a non-executable
    // hook on a POSIX checkout. No-op on Windows, where git invokes hooks through sh regardless of
    // the bit. NEVER on a hook this run REFUSED (a first-run collision or a marker-less
    // post-commit): "left byte-identical" must include the mode — granting +x would turn a
    // preserved foreign script into a live hook the moment the wiring below lands. The emitter's
    // hooks: line reports the resulting bit gap (ywr-harness ADR 0056), so the member makes that call, not this block.
    if (findOnPath('chmod')) {
      const notOurs = [...firstRunRefused, ...refused]
      for (const h of hookFiles) {
        if (ciIncludes(notOurs, h)) continue
        const hp = path.join(root, h)
        if (isFile(hp)) spawnSync('chmod', ['+x', hp], { stdio: 'ignore' })
      }
    }
  }

  function compareRepoPath(a, b) {
    let x, y
    try {
      x = path.resolve(a).replace(/[\\/]+$/, '')
      y = path.resolve(b).replace(/[\\/]+$/, '')
    } catch { return false }
    return WIN ? x.toLowerCase() === y.toLowerCase() : x === y
  }

  function resolveRealPath(p) {
    // realpath: every component's link — an NTFS junction or a directory symlink — followed to its
    // final target, lexical from the first component that does not exist. A lexical path alone would
    // differ from the emitter's `_hooks_path_is`, which compares a resolved real path and DOES
    // follow links — so a `.githooks` reached through a junction (or a repo root mounted through
    // one) with core.hooksPath written as the real target would say REFUSED where the emitter says
    // wired.
    let full
    try { full = path.resolve(p) } catch { return p }
    const base = path.parse(full).root
    const rest = full.slice(base.length).replace(/^[\\/]+|[\\/]+$/g, '')
    let cur = base
    if (rest === '') return cur
    for (const seg of rest.split(/[\\/]+/)) {
      if (seg === '') continue
      cur = path.join(cur, seg)
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) cur = fs.realpathSync(cur)
      } catch { /* absent: stay lexical from here */ }
    }
    return cur
  }

  function testHooksPathNames(cur, rootDir, rel) {
    // True when the clone's `core.hooksPath` names `rootDir/rel` in WHATEVER spelling it was written
    // — the same rule as the emitter's hooks: line (harness_gates._hooks_path_is).
    // `.githooks` is this scaffold's spelling, but a hand-wired clone may hold `./.githooks`, an
    // absolute path (`C:\…\.githooks`, `/home/…/.githooks`) or — from Git Bash on Windows — the MSYS
    // form `/c/…/.githooks`, which git for Windows honours but no Node path API does. A literal
    // compare would REFUSE every one of those as "points its hooks elsewhere" and tell the
    // reader the placed hooks were inert while they ran on every commit.
    // Git resolves a relative value against the work tree's top level, so that is the base here;
    // `~/`, `~user/` and `%(prefix)/` are expanded by the caller's `git config --path` read — the
    // same expansion the hook runner applies. Both rewrites are Windows-only: a POSIX name may
    // legitimately contain a backslash or start `/c/`. Both sides are compared as REAL paths
    // (resolveRealPath), the emitter's `resolve()` semantics.
    if (!cur || !cur.trim()) return false
    let c = cur
    if (WIN) {
      const m = /^\/([A-Za-z])\/(.*)$/.exec(c)
      if (m) c = `${m[1]}:/${m[2]}`
      c = c.replace(/\\/g, '/')
    }
    try {
      if (!path.isAbsolute(c)) c = path.join(rootDir, c)
    } catch { return false }
    return compareRepoPath(resolveRealPath(c), resolveRealPath(path.join(rootDir, rel)))
  }

  let wire = ''
  if (gitAbsent()) {
    wire = 'git not on PATH — core.hooksPath NOT set; the hooks are placed but will not run'
  } else {
    const topR = git(['-C', root, 'rev-parse', '--show-toplevel'])
    const top = lines(topR.out).join(' ')
    if (topR.status !== 0 || !top.trim()) {
      wire = 'not a git repository — core.hooksPath NOT set; the hooks are placed but will not run'
    } else if (!compareRepoPath(root, top.trim())) {
      // Setting hooksPath from a subdirectory would reconfigure the WHOLE repository from a scaffold
      // run that was scoped to one subtree. Refused, and the real root is named so the reader can
      // re-run there if that is what they meant.
      wire = `target is not the repository root (${top.trim()}) — core.hooksPath NOT set, because setting it here would reconfigure the entire repository`
    } else {
      // `--path`: git's own pathname expansion (`~/`, `%(prefix)/`) — the value the hook runner
      // applies. A plain `--get` returns the raw text, and a tilde-wired clone read as foreign.
      // `--show-scope` names the scope that WINS: a core.hooksPath set at the worktree scope
      // (`extensions.worktreeConfig`) outranks `.git/config`, so a `--local` read alone could call
      // the clone "already wired" while git ran hooks from elsewhere, or set a local value that
      // never took effect. Output is `<scope>\t<value>`; git prints
      // nothing and exits 1 when the key is unset at every scope.
      const scopedR = git(['-C', root, 'config', '--show-scope', '--path', '--get', 'core.hooksPath'])
      let effScope = ''; let effVal = ''
      const scopedL = lines(scopedR.out)
      if (scopedR.status === 0 && scopedL.length) {
        const last = scopedL[scopedL.length - 1]
        const tab = last.indexOf('\t')
        if (tab > 0) { effScope = last.slice(0, tab).trim(); effVal = last.slice(tab + 1).trim() }
      }
      const curR = git(['-C', root, 'config', '--local', '--path', '--get', 'core.hooksPath'])
      const cur = curR.status !== 0 ? '' : lines(curR.out).join(' ').trim()
      if (effScope === 'worktree' && effVal !== '') {
        // The worktree scope decides, whatever `.git/config` says. Nothing is written at either
        // scope on this branch: the scaffold did not write the worktree value and a local write
        // would be a no-op that reads as success.
        if (testHooksPathNames(effVal, root, HOOKS_DIR)) {
          wire = `core.hooksPath at worktree scope is '${effVal}', which names '${HOOKS_DIR}' (left as written) — already wired`
        } else {
          wire = `core.hooksPath at WORKTREE scope is '${effVal}' — it outranks the local value, so the placed hooks do not run in this worktree; REFUSED to change it. Set it yourself if that is what you meant: git config --worktree core.hooksPath ${HOOKS_DIR}`
        }
      } else if (cur === HOOKS_DIR) {
        wire = `core.hooksPath already '${HOOKS_DIR}' — already wired`
      } else if (testHooksPathNames(cur, root, HOOKS_DIR)) {
        // The same directory in another spelling. Wired — and the value stays byte-identical:
        // the scaffold did not write this spelling, so it does not rewrite it, not even to its own.
        wire = `core.hooksPath is '${cur}', which names '${HOOKS_DIR}' (left as written) — already wired`
      } else if (cur !== '') {
        wire = `core.hooksPath is '${cur}' — REFUSED to change it; this repo points its hooks elsewhere deliberately. The placed hooks stay inert until you merge them into '${cur}' or set the value yourself`
      } else if (dryRun) {
        wire = `core.hooksPath unset — would set it to '${HOOKS_DIR}'`
      } else {
        const setR = git(['-C', root, 'config', '--local', 'core.hooksPath', HOOKS_DIR])
        if (setR.status === 0) wire = `core.hooksPath set to '${HOOKS_DIR}' — wired`
        else wire = `git config failed (exit ${setR.status}) — core.hooksPath NOT set; run: git config core.hooksPath ${HOOKS_DIR}`
      }
    }
  }
  say(`  hooks: ${wire}`)

  // ywr-harness ADR 0062 (issue #55). The vendored workflow's push trigger ENUMERATES `branches: [main, master]`
  // — `on:` takes no expressions, `$default-branch` exists only in GitHub's starter templates, and
  // the placed copy must stay byte-identical to the template (ywr-harness ADR 0014), so per-repo substitution is
  // out. A repo whose default branch is outside the list never gets a push run, and GitHub does not
  // even register a workflow no event has matched — nothing in CI can report a run that never
  // happens. The scaffold is the one step that knows the repo, so it says it here. origin/HEAD is the
  // only default-branch signal available offline; when it is unset (a `git init` + `remote add`
  // clone never sets it) nothing is printed — the current branch would be a guess, and a wrong
  // warning on every feature branch teaches readers to ignore the line.
  const CI_PUSH_BRANCHES = ['main', 'master']
  if (!gitAbsent() && !/^(git not on PATH|not a git repository)/.test(wire)) {
    const headR = git(['-C', root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    const head = lines(headR.out).join(' ')
    if (headR.status === 0 && head.trim()) {
      const defaultBranch = head.trim().replace(/^origin\//i, '')
      if (!CI_PUSH_BRANCHES.includes(defaultBranch)) {
        say(`  ci trigger: default branch '${defaultBranch}' is NOT in the vendored workflow's push list [${CI_PUSH_BRANCHES.join(', ')}] — harness-gates never runs on push here (PR and workflow_dispatch runs still do). A default branch outside the list needs a canon change, not a local edit (ywr-harness ADR 0062).`)
      }
    }
  }

  if (!dryRun) {
    // Generating the four surfaces runs the wrapper with this Node, so no tool lookup can skip it.
    // Invoke the WRAPPER, not build_docs.mjs directly: docs/build.mjs is the one entry that the
    // member and the CI run, and a second caller would be a second copy of its contract.
    const wrapper = path.join(root, 'docs/build.mjs')
    if (fs.existsSync(wrapper)) {
      const r = spawnSync(process.execPath, [wrapper], { cwd: root, stdio: 'ignore', windowsHide: true })
      const code = r.error ? 1 : (r.status ?? 1)
      // All FOUR surfaces — docs.artifact.html is the artifact-publish path's input
      // (ywr-harness ADR 0032/0048) and omitting it here taught readers a three-surface pipeline (issue #45).
      if (code === 0) say('  built: index.json · INDEX.md · docs.html · docs.artifact.html')
      else say(`  SKIP build — docs/build.mjs exited ${code}; run it directly and read the error`)
    } else {
      // A refused first-run collision or a failed write can leave the wrapper unplaced.
      say('  SKIP build — docs/build.mjs is not in this repo (reported, not silent); resolve its line above, then run: node docs/build.mjs')
    }
  }

  if (preserved.length) {
    say('')
    say('Preserved seeds were NOT updated. Notes above name template-side keys/lines a seed')
    say('lacks, and scaffold gate lines no claiming group declares (report only — ywr-harness ADR 0051, 0129);')
    say('anything beyond additions still needs a hand compare')
    say('against skills/harness-init/templates/. This script will never clobber them.')
  }
  return 0
}

process.exitCode = await main()
