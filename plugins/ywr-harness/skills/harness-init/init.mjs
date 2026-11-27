// Scaffolds the docs-as-code shape into a repo. Placement is deterministic, with no model judgment.
//
// Run: node init.mjs --target <dir> [--dry-run] [--force] [--allow-upstream-ahead]
//                    [--fetch-timeout-seconds N]
// Output goes to stdout through the one writer `say`. This script never writes to stderr. A caller
// reads a crash from Node's own stderr report.
//
// The placement map lives in placement.mjs. Each file lands in one of these modes:
//   TOOLCHAIN    Overwritten on every re-run. A consuming repo must not hand-edit these (ywr-harness ADR 0010).
//   GUARDED      Placed when absent, refreshed when the file carries the guard marker, otherwise refused and reported.
//   SEED         Created once, never overwritten. An existing seed is reported as preserved.
//   SEED_CORPUS  A seed placed only when the repo holds no decision record.
// A retired file is no longer placed and is only reported. This script never deletes a file.
//
// On a first run (no .harness-version stamp), an existing differing file at a toolchain path is
// refused, not replaced (ywr-harness ADR 0055). --force replaces it. The stamp is withheld while a
// refusal stands.
//
// Exit codes:
//   0  Placement completed, with or without preserved seeds and refusals.
//   1  Target unusable, template missing, write failed, or a guard refused before any write
//      (downgrade, ywr-harness ADR 0042; upstream ahead, ywr-harness ADR 0135). A failed pre-check
//      fetch is one line, never an exit (ywr-harness ADR 0137).
//   2  Usage error: an unknown flag or a value out of range.
// A crash is never caught here. Node prints its uncaught-error report to stderr, which ends with a
// `Node.js vNN.N.N` line, and exits 1. A caller tells a crash from verdict 1 by that trailer.
//
// The script never calls process.exit(), because a piped stdout can be cut short. It sets
// process.exitCode once, on the last line.

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
// Repo-authored text that reaches a console line is flattened with this.
const FLATTEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

function say(line) { process.stdout.write(line + '\n') }

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const ciIncludes = (list, s) => { const l = String(s).toLowerCase(); return list.some((x) => String(x).toLowerCase() === l) }
const readBytes = (p) => fs.readFileSync(p)
const readTextFile = (p) => readBytes(p).toString('utf8').replace(/^\uFEFF/, '')
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const psTruthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '')
const lines = (text) => { const l = text.split(/\r?\n/); if (l.length && l[l.length - 1] === '') l.pop(); return l }

// --- git: every parsed call goes through harness_git.mjs, the one subprocess boundary -------------
// The boundary pins `core.quotepath=false`, so git never octal-quotes a path (ywr-harness ADR 0077).
// This script parses single values, never a path list. The one call outside the boundary is the
// detached fetch below, which needs its own process group and a timeout that kills the whole tree.
function git(args) {
  try {
    const r = git_result(process.cwd(), args)
    return { absent: false, status: r.status, out: r.stdout }
  } catch (e) {
    return { absent: Boolean(e && e.code === 'ENOENT'), status: -1, out: '' }
  }
}
const gitAbsent = () => git_absent()

// The first match in PATH order.
function findOnPath(name) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  // On Windows an extensionless file cannot start, so only PATHEXT program extensions match.
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

// A version with four numeric components. '0.28' pads with 0 to 0.28.0.0, never with -1, which
// would compare '0.28' below '0.28.0' and flip the downgrade verdict. The refresh nudge's direction
// probe uses the same rule. More than four components is invalid.
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

// --- regex translation (a declared pattern in Python syntax -> a JavaScript RegExp) ---------------
// Group regexes keep the `re.match` rule of harness_config.mjs: anchored at the start only.
// The pattern compiles alone first. Wrapped unchecked, `x)|(.*` would escape the group and claim
// every path, where Python refuses it.
// The translation covers named groups, a leading `(?i)` / `(?s)` / `(?m)` flag, and `\A` / `\Z`.
// A letter escape that JavaScript would read as the bare letter (`\a`, `\z`, `\U`, `\N`) throws.
// Any other Python-only construct, or a pattern JavaScript refuses, claims nothing. A repo pattern
// then errs toward speaking. init.selftest pins that every template pattern compiles here.
// A caller calls this inside the try of its RegExp compile.
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
        // `\k<name>` is the named backreference made above. Any other letter must mean the same in both engines.
        if (n === 'k' && !inClass && p[i + 1] === '<') { out += '\\k'; continue }
        if (!JS_LETTER_ESCAPES.has(n)) throw new SyntaxError(`escape \\${n} has no JavaScript equivalent`)
      }
      out += c + n
      continue
    }
    if (inClass) { if (c === ']') inClass = false }
    else if (c === '[') {
      inClass = true
      // A `]` right after `[` or `[^` is a literal member in Python. JavaScript reads `[]` as an empty class.
      if (p[i + 1] === '^') { out += '[^'; i++ } else out += c
      if (p[i + 1] === ']') { out += '\\]'; i++ }
      continue
    }
    out += c
  }
  return { p: out, flags }
}

// A JavaScript regex has no match timeout, and `^(a+)+$` on a long non-match never returns.
// A vm context stops the match at the limit and throws.
const timedContext = vm.createContext({})
function timedTest(rx, s, ms) {
  timedContext.rx = rx
  timedContext.s = s
  return vm.runInContext('rx.test(s)', timedContext, { timeout: ms })
}

// Files directly in `dir`, or under it when `deep`. Hidden entries and links are never listed.
// A generator, so a caller that catches a failure keeps what the walk had listed.
// An inaccessible directory is skipped.
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
  // The bound on the pre-check fetch (ywr-harness ADR 0137). Tests lower it to reach the timeout path.
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
  // `.harness-version` records the plugin version that last scaffolded this repo. It is generated,
  // never a template, because a templated stamp would change every release (ywr-harness ADR 0033).
  // A stamp newer than this copy means another writer refreshed the repo, and proceeding would
  // place older templates over that refresh. The refusal comes before any write. --force rolls back.
  // A missing or unparseable stamp proceeds: refusing could never protect newer work.
  const stampPath = path.join(root, STAMP_FILE)
  let ownVersionRaw = null
  try {
    const mf = JSON.parse(readTextFile(path.join(SELF_DIR, '..', '..', '.claude-plugin', 'plugin.json')))
    if (isObj(mf) && typeof mf.version === 'string' && /\d/.test(mf.version)) ownVersionRaw = mf.version.trim()
  } catch { ownVersionRaw = null }
  const ownVersion = toVersionOrNull(ownVersionRaw)
  // First run means no stamp file, whatever its content. A file at a toolchain path on a first run is
  // not a canon artifact, so those collisions are refused below (ywr-harness ADR 0055). A garbage stamp
  // still counts as "has run": refusing there could only protect files a previous run placed.
  const isFirstRun = !isFile(stampPath)
  let repoStamp = null
  let repoStampRaw = ''
  if (isFile(stampPath)) {
    try {
      // A bounded read, never a whole-file read: a stamp with no newline would read whole, and a
      // symlink to a device never returns. 64 bytes is generous for a version token.
      const fd = fs.openSync(stampPath, 'r')
      let buf, n
      try { buf = Buffer.alloc(64); n = fs.readSync(fd, buf, 0, 64, 0) } finally { fs.closeSync(fd) }
      const off = n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0
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
  // A stamp equal to this plugin's version means the canon cannot have changed a placed file since
  // the last scaffold. A refresh-path delta is then a local hand edit, which ywr-harness ADR 0010
  // wants surfaced upstream. Placement collects the drift and the report follows it.
  // A first run has no stamp, so it never qualifies.
  // When this script runs from the target tree (the canon dogfood, ywr-harness ADR 0018), newer
  // templates are the intended source-to-placement propagation. A visible one-line note replaces the verdict.
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
  // A teammate may have scaffolded and pushed while this clone has not pulled. The downgrade guard
  // cannot see that, because this clone's own stamp is the old one. This function reads the
  // remote-tracking refs for commits this checkout lacks that touch the stamp. It makes no network call.
  // Candidate refs, in order: the current branch's upstream, then origin/HEAD (ywr-harness ADR 0062).
  // The path is the stamp alone: a same-version re-run places identical templates, so it cannot
  // collide, and counting a hand edit would refuse init behind a hand-edited main.
  // The commit walk is patch-equivalence filtered (--cherry-pick --right-only over HEAD...ref), so a
  // local rebase of a stamp commit is not upstream-ahead.
  // Absent git, no refs or any git failure is no hit, never an error line.
  // The refusal comes before the first write and applies under --dry-run too.
  // The switch is --allow-upstream-ahead, never --force, which also bypasses the ywr-harness ADR 0055
  // collision refusals. The refresh nudge uses the same detection (ywr-harness ADR 0135).
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
      // A ref name is repo-authored text that reaches a console line, so it is flattened.
      const name = ref.replace(/^refs\/remotes\//, '').replace(FLATTEN, ' ')
      return { ref: name, sha: f[0], date: f.length > 1 ? f[1] : '' }
    }
    return null
  }

  // --- pre-check fetch (ywr-harness ADR 0137) ----------------------------------------------------------------
  // The check above reads the refs as of the last fetch. This script fetches the candidate remotes
  // itself: the current branch's upstream remote, then origin. Only configured remote names qualify,
  // because a URL-valued branch.<b>.remote cannot ride --multiple. A local upstream ('.') adds none.
  // One git process, pinned against the member's config: --no-tags --no-prune
  // --no-recurse-submodules, and no auto gc or maintenance, whose kill is the widest lock window.
  // The fetch is non-interactive: GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never, stdin closed, and ssh
  // in BatchMode only when neither GIT_SSH_COMMAND, GIT_SSH nor core.sshCommand names the member's own ssh.
  // --fetch-timeout-seconds bounds it, and a timeout stops the whole process tree. A stop can strand
  // *.lock files, so the line names up to 3 locks written since the fetch began, counts the rest, and deletes none: an IDE's
  // background fetch may own it.
  // The fetch runs under --dry-run too, because it moves only remote-tracking refs and objects, and
  // the dry run must show the real run's refusals (ywr-harness ADR 0135). Under --allow-upstream-ahead
  // it is skipped, because no outcome waits on it.
  // A failure or timeout never blocks: one line, then the check reads the last fetch. The line never
  // quotes git's output, which can carry a credentialed URL. Success is silent. With no candidate
  // remote there is no fetch and no line. The SessionStart nudge stays network-free (ywr-harness ADR 0033).
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
    // Lock files a stopped fetch can leave: top-level ones and any under refs/remotes/. The cut has
    // 2 s of slack for coarse mtimes.
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
  // A hung transport is a grandchild of git, so killing git alone would leave it running.
  function killTree(child) {
    try {
      if (WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      else process.kill(-child.pid, 'SIGKILL')
    } catch { /* already gone */ }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  async function invokeCandidateFetch(remotes) {
    // Returns null on success, otherwise the failure clause for the one line.
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
    // harness:git-boundary a detached, timeout-killed fetch with no captured output; git_result runs to completion and offers no handle to kill, so only the PATH lookup comes from harness_git
    const gitExe = which_on_path('git')
    if (!gitExe) return 'could not start git'
    try { child = spawn(gitExe, args, { env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, detached: !WIN }) } catch { return 'could not start git' }
    const done = new Promise((resolve) => {
      child.once('error', () => resolve({ error: true }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    let timerHandle
    const timer = new Promise((resolve) => { timerHandle = setTimeout(() => resolve({ timeout: true }), fetchTimeoutSeconds * 1000) })
    // Off Windows the fetch has its own process group, so a timeout kills the whole tree and a
    // terminal's Ctrl+C does not reach it. An interrupt stops the tree first, then ends this script.
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
      // The scan is advice on a path that must never block, so a throw reads as no lock.
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
  // ywr-harness ADR 0055 has two buckets: first-run toolchain collisions refused, and --force
  // replacements, which the report never labels "refreshed". ywr-harness ADR 0074 adds a third refusal
  // bucket: a stamped re-run that collides on a path INTRODUCED_IN dates after the stamp. It is
  // reported apart because its cause differs from "this repo was never scaffolded".
  const firstRunRefused = []; const replaced = []; const introducedRefused = []

  function testPathIntroducedAfterStamp(dest) {
    // True when `dest` has an INTRODUCED_IN entry newer than this repo's stamp. The path did not exist
    // in the plugin version that last scaffolded this repo, so a foreign file there is a first
    // appearance, not an ordinary re-run collision (ywr-harness ADR 0074).
    // A missing or unparsable stamp treats every introduced path as introduced later. This fails
    // closed, unlike the downgrade guard's absent-stamp case, because failing open would overwrite a
    // file that never went through this guard.
    // A malformed INTRODUCED_IN value reads as not gated, so it cannot jam placement.
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

    // Placement writes LF only. The consumer's git can materialize the installed plugin with CRLF
    // (core.autocrlf), and copying those bytes breaks sh hooks on POSIX ("/bin/sh^M: bad
    // interpreter") and shows as modified files in an eol=lf repo.
    // Latin1 maps bytes 1:1, so this is a byte transform, not a decode. The write folds only
    // CRLF to LF. A lone CR is content, and encoding and BOM stay exact.
    const text = readBytes(src).toString('latin1').replaceAll('\r\n', '\n')

    if (exists) {
      // Identical content is not a refresh. The compare drops every 0x0D, paired or not, as the
      // refresh nudge does (ywr-harness ADR 0033), so the two never disagree on what counts as a
      // change. A raw compare would call a CRLF checkout of an identical template refreshed on every run.
      const existing = readBytes(dst).toString('latin1').replaceAll('\r', '')
      if (existing === text.replaceAll('\r', '')) return
    }

    // First-run toolchain collision (ywr-harness ADR 0055): the file differs and no stamp says this
    // scaffold has run here, so it is not canon output. Refused unless --force.
    // A guarded caller that proved ownership by marker passes ownershipKnown.
    // The refusal applies under --dry-run too.
    // ywr-harness ADR 0074 extends it to a re-run on a path the stamp predates
    // (testPathIntroducedAfterStamp). The bucket follows the condition that fired.
    let isReplacement = false
    const introducedLater = testPathIntroducedAfterStamp(dest)
    if (exists && overwrite && !ownershipKnown && (isFirstRun || introducedLater)) {
      if (force) isReplacement = true
      else if (isFirstRun) { firstRunRefused.push(dest); return }
      else { introducedRefused.push(dest); return }
    }

    // Same-version drift (ywr-harness ADR 0067): an existing overwrite-mode file on a same-version
    // re-run differs from the template, so it is a local hand edit that this overwrite reverts.
    // The drift goes to the upstream: block. A real run copies the local content aside first, so the
    // revert never destroys the only copy. A failed copy is reported per file and never blocks the refresh.
    if (exists && overwrite && sameVersionRun) {
      sameVersionDrift.push(dest)
      // An in-tree (dogfood) run skips the copy: the local content is the canon's own tree.
      if (!dryRun && !inTreeRun) {
        try {
          if (!revertDir) {
            // The process id is in the name because the timestamp has 1 s resolution, so two runs in the
            // same second would share the dir and overwrite each other's backups.
            const d = new Date()
            const p2 = (n) => String(n).padStart(2, '0')
            const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
            revertDir = path.join(os.tmpdir(), 'ywr-harness-reverted', `${path.basename(root)}-${stamp}-${process.pid}`)
          }
          const bak = path.join(revertDir, dest)
          fs.mkdirSync(path.dirname(bak), { recursive: true })
          fs.copyFileSync(dst, bak)
          // revertDir is set before the copy that can fail, so the "pre-revert copies:" line keys on
          // revertSaved. Otherwise an all-failed run would name a dir that holds nothing.
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
        // Not ours. The file may do real work for reasons this scaffold cannot see.
        refused.push(dest)
        return
      }
    }
    // Ownership is settled (absent, or proved by the marker), so place() must not re-judge it with
    // the first-run collision guard (ywr-harness ADR 0055).
    place(rel, dest, true, true)
  }

  let considered = 0
  for (const [k, v] of TOOLCHAIN) { place(k, v, true); considered++ }
  for (const [k, v] of GUARDED) { placeGuarded(k, v); considered++ }
  for (const [k, v] of SEED) { place(k, v, false); considered++ }

  // The corpus seed is placed only when the repo holds no decision records, whatever their naming
  // convention (prefixed, bare-numbered or dated names) or home. A second 0001 would fork the decision history.
  // Two scopes share one record predicate:
  //   - docs/adr/: any .md record counts. The scaffold's own 0000-template.md and README.md are
  //     non-records by name, never by provenance, so the check reads the same under --dry-run.
  //   - conventional homes elsewhere: named locations, not a tree-wide glob, which would
  //     false-positive on unrelated notes.
  // A readme or a template is not a record, in any case, because checkout filesystems differ.
  // The template exclusion anchors to the filename suffix: '0007-template-engine-selection.md'
  // counts, 'decision-template.md' does not. The residual edge ('...-html-template.md') suppresses
  // the seed, which is loud, instead of placing it, which forks the history.
  const isDecisionRecord = (name) => !(/^readme\.md$/i.test(name) || /template\.md$/i.test(name))
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
    // The two reports are independent: a repo can hold records in both places, and the foreign ones
    // need a report even when docs/adr/ is populated.
    if (existingRecords.length > 0) {
      let msg = `corpus seed not placed — docs/adr/ already holds ${existingRecords.length} record(s)`
      // The builder indexes only `NNNN-*.md` (build_docs.mjs FILE_RE). Records it cannot see leave the
      // corpus unbuildable, and this report carries the cause for the later 'SKIP build' line.
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
  // A preserved seed has no update path, so this probe reports, never merges, what the template
  // carries that the seed lacks. The toolchain stamp (ywr-harness ADR 0042) and the refresh nudge
  // (ywr-harness ADR 0033) do not see seed drift. The comparator is per seed, a closed set:
  //   harness.json  Template key paths absent here. `//` comment keys are skipped. Arrays are
  //                 leaves, because their content is repo-specific.
  //   line-based    Template lines (trimmed, non-empty, non-#) absent here, as a count and the first one.
  // CLAUDE.md is absent on purpose: a repo rewrites it wholesale, so every template line would read
  // as missing forever.
  // The probe is read-only. An unparseable seed is a reported skip, never fatal.
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

  // Scaffold gate lines (ywr-harness ADR 0129). Arrays are leaves above, so a repo whose docs group
  // lacks the file-scoped gate line (ywr-harness ADR 0094) never learns it. The STE-lite gate
  // (ywr-harness ADR 0128) runs only when pre-commit hands check_docs.mjs the staged paths.
  // The template is the list, with no second copy here: each script gate it declares on a toolchain
  // script must run in the repo on every path the template routes to it.
  // The emitter runs the gates of every group whose `match` claims a path (harness_gates.mjs), so
  // some repo group claiming the path must carry the gate. A line present only in a group that
  // never claims the path is no coverage.
  // The probe paths are the scaffold's own placements, the template's docs.index unless the repo
  // moved its index, and the real files beside the placements (getScaffoldGateNote).
  function getScaffoldGateKey(gate) {
    if (!isObj(gate)) return ''
    if (!own(gate, 'runner') || !own(gate, 'script') || typeof gate.runner !== 'string' || typeof gate.script !== 'string') return ''
    // An absent `files` is false, the emitter's default (harness_config.script_gate). A non-boolean
    // matches nothing here, because the emitter already warns about it.
    let files = false
    if (own(gate, 'files')) { if (typeof gate.files !== 'boolean') return ''; files = gate.files }
    return `${gate.runner}|${gate.script}|${files ? 'True' : 'False'}`
  }

  // Each declaration's groups compile once into matchers (anchored regex and gate keys).
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

  // One alternation per gate key and side, so a probe path costs one test per side. Each part is
  // anchored and compiled alone, so the alternation changes no claim, except for a group reference
  // (a backreference or a conditional): a number shifts in an alternation and a name can repeat.
  // A set with such a part, or with flags, stays one regex per group.
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
    // A repo may move its docs.index. The template's index path is then no probe, because it would
    // report a gap for a file the repo does not have.
    const tdocs = isObj(template) && psTruthy(template.docs) ? template.docs : undefined
    const ipHas = isObj(tdocs) && own(tdocs, 'index')
    const ipVal = ipHas ? tdocs.index : undefined
    const rdocs = isObj(repo) && own(repo, 'docs') && isObj(repo.docs) ? repo.docs : undefined
    const rpHas = Boolean(rdocs) && own(rdocs, 'index')
    const rpVal = rpHas ? rdocs.index : undefined
    let index = []
    if (ipHas && typeof ipVal === 'string' && ipVal && (!rpHas || rpVal === ipVal)) index = [ipVal]
    // Each scaffold gate key maps to the gate, the template groups carrying it, and a matcher set per side.
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
    // The placed paths are samples, and pre-commit stages the repo's real specs. A repo group can
    // claim the placed files and miss every real spec. So the working-tree files under each directory
    // that holds a placed path a scaffold gate claims join the probes. The listing makes no git
    // call, and it can name an untracked or ignored draft (ywr-harness ADR 0129). The index's own
    // directory is not listed, because the index path itself is probed. Real files lead the list, so
    // the display cap never hides a real spec behind a template file.
    const seen = new Set([...samples, ...index])
    const dirs = new Set()
    for (const p of samples) {
      const i = p.lastIndexOf('/')
      if (i <= 0 || dirs.has(p.slice(0, i))) continue
      for (const n of need.values()) for (const x of n.t) { if (x.test(p)) dirs.add(p.slice(0, i)) }
    }
    const real = []
    // A listing can still throw, for a directory removed mid-walk or a path too long. A failure keeps
    // what the walk listed and every sample gap, and says so.
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
    // Each gate key maps to the probe paths the repo leaves uncovered and the template groups that claim them.
    const gaps = new Map()
    for (const p of [...real, ...samples, ...index]) {
      for (const [key, n] of need) {
        if (!n.t.some((x) => x.test(p))) continue
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
      let shown = w.paths; let more = ''
      if (w.paths.length > 6) { shown = w.paths.slice(0, 6); more = `, +${w.paths.length - 6} more` }
      out.push(`no group claiming ${shown.join(', ')}${more} declares the scaffold gate ${json} (template: ${w.groups.join(', ')})`)
    }
    for (const s of stopped) out.push(`real-file listing stopped under ${s}`)
    return out.join('; ')
  }

  // review.docs_only value probe (ywr-harness ADR 0191). Arrays are leaves to the key probe, so a seed
  // whose docs_only lacks the template's exclusions would exempt those paths from review unnoticed.
  // Only the wider direction is named: a path the repo exempts and the template reviews.
  // A narrower repo value is safe and silent. The template is the list, with no copy here.
  function getDocsOnlyRegexes(decl) {
    const out = { rx: [], bad: 0, notList: false }
    if (!isObj(decl)) return out
    if (!own(decl, 'review') || !isObj(decl.review)) return out
    if (!own(decl.review, 'docs_only')) return out
    const dv = decl.review.docs_only
    // The emitter ignores a non-list value, so it exempts nothing. The note says the value was not
    // compared (ywr-harness ADR 0191 Decision 5).
    if (!Array.isArray(dv)) { out.notList = psTruthy(dv); return out }
    for (const p of dv) {
      // The emitter skips an empty pattern. It reads a non-string item through str(), which JavaScript
      // cannot reproduce exactly, so such an item is not compared.
      if (typeof p === 'string' && !p) continue
      if (typeof p !== 'string') { out.bad++; continue }
      // Unanchored, because the emitter's docs_exempt is `rx.search` (harness_gates.mjs). A match is
      // bounded by timedTest, and a timeout becomes a probe skip in the caller.
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
    // init.selftest pins the template, so this is a skip, never a false list.
    if (t.bad || t.notList) return 'review.docs_only probe skipped: a template pattern the regex engine cannot read'
    const placed = []
    for (const p of [...TOOLCHAIN.map((e) => e[1]), ...SEED.map((e) => e[1]), ...SEED_CORPUS.map((e) => e[1])]) { if (!placed.includes(p)) placed.push(p) }
    const tdocs = isObj(template) && psTruthy(template.docs) ? template.docs : undefined
    const ip = isObj(tdocs) && own(tdocs, 'index') ? tdocs.index : undefined
    if (typeof ip === 'string' && ip && !placed.includes(ip)) placed.push(ip)
    // Real files: the root's own files, and every file under each directory that holds a placed
    // path. A directory under another listed directory is not listed twice.
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
        // One message covers read and parse failures, so a locked file does not read as a syntax error.
        return 'drift probe skipped: seed could not be read or parsed as JSON'
      }
      const have = getJsonKeyPaths(r)
      const missing = getJsonKeyPaths(t).filter((k) => !ciIncludes(have, k))
      const parts = []
      if (missing.length) {
        // A minimal declaration can lack dozens of keys. The display is capped and the count is exact.
        let shown = missing; let more = ''
        if (missing.length > 6) { shown = missing.slice(0, 6); more = `, +${missing.length - 6} more` }
        parts.push(`template has ${missing.length} key(s) this seed lacks: ${shown.join(', ')}${more}`)
      }
      // A throw here would turn a completed placement into a non-zero exit (ywr-harness ADR 0051).
      let gateNote
      try { gateNote = getScaffoldGateNote(t, r) } catch (e) { gateNote = 'scaffold gate probe skipped: ' + e.message }
      if (gateNote) parts.push(gateNote)
      let docsNote
      try { docsNote = getDocsOnlyNote(t, r) } catch (e) { docsNote = 'review.docs_only probe skipped: ' + e.message }
      if (docsNote) parts.push(docsNote)
      return parts.join('; ')
    }
    // Line-based seeds. Latin1 is the same byte-faithful read as place(), so a decode cannot skew the compare.
    const readLines = (p) => readBytes(p).toString('latin1').replaceAll('\r', '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    // isFile proves existence, not readability. An unguarded read of a locked seed would fail the
    // whole run after every placement succeeded (ywr-harness ADR 0051).
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
  // A --force replacement is never labeled "refreshed", because the old content was not canon (ywr-harness ADR 0055).
  for (const f of replaced) say(`  ~ ${f} (REPLACED a pre-existing non-canon file under --force — previous content survives only in git history; ywr-harness ADR 0055)`)
  for (const f of firstRunRefused) {
    say(`  ! ${f} REFUSED — first run found an existing file at this TOOLCHAIN path (ywr-harness ADR 0055)`)
    say('      Nothing marks it as this scaffold\'s output, so it was left byte-identical. Merge or move it,')
    say('      then re-run; a deliberate replacement re-runs with --force (the previous content then survives')
    say('      only in git history).')
  }
  if (firstRunRefused.length) {
    // A scaffolded repo can lose its stamp, and the refusals above then land on legitimate toolchain
    // drift. The message states the inference and its remedy.
    say(`      (No ${STAMP_FILE} stamp was found, so this run treated the repo as never scaffolded. If it WAS`)
    say('      scaffolded and only the stamp is missing, --force IS the normal re-run: toolchain files return')
    say('      to canon, and seeds are never touched either way.)')
  }
  for (const f of introducedRefused) {
    // This repo is stamped, but the path entered the toolchain after that stamp. A foreign file there
    // is the same data loss that ywr-harness ADR 0055 refuses (ywr-harness ADR 0074).
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
  // A retired file is named so the reader removes it. It is never a `~` or `!` line, which
  // report-issue's dry-run parser reads as drift. It has no effect on the exit code or the stamp.
  for (const r of RETIRED) {
    if (isFile(path.join(root, r.dest))) {
      say(`  retired: ${r.dest} — ywr-harness no longer places this file since ${r.since} (ywr-harness ADR ${r.adr}); delete it with git rm`)
    }
  }

  // --- same-version drift report (ywr-harness ADR 0067) ---------------------------------------------------------
  // The prefix `upstream: SAME-VERSION drift` is a contract: the harness-init SKILL keys on it to
  // start the report flow. report-issue's dry-run parser must keep ignoring these lines.
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
  // Only a run that placed successfully stamps. The refresh nudge reads the stamp after it finds
  // byte drift, to orient its advice, and never as the trigger. The stamp is in no placement map on
  // purpose, so the manifest-gate sweep and the nudge's template comparison never count it as drift.
  if (firstRunRefused.length || introducedRefused.length) {
    // A stamp now would make the next run treat these paths as resolved and overwrite the files
    // the refusals above protected (ywr-harness ADR 0055/0074).
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
  // This is the one thing init does besides write files, so it is bounded:
  //   unset           set it
  //   .githooks       leave it
  //   anything else   refuse and report the existing value
  // `core.hooksPath` lives in .git/config, which is per-clone, so this wires only the machine that
  // ran the scaffold. The `hooks:` line of harness_gates.mjs catches a clone that never ran it.
  const hookFiles = ['.githooks/pre-commit', '.githooks/pre-push', '.githooks/post-commit']

  if (!dryRun && !WIN) {
    // The placement write sets no executable bit, and git skips a non-executable hook on POSIX.
    // Windows needs nothing, because git runs hooks through sh regardless of the bit.
    // A refused hook (a first-run collision or a marker-less post-commit) never gets +x. Granting it
    // would turn a preserved foreign script into a live hook once the wiring below lands. The
    // emitter's hooks: line reports the bit gap, and the member decides (ywr-harness ADR 0056).
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
    // Follows every link (an NTFS junction or a directory symlink) to its target, and stays lexical
    // from the first component that does not exist. The emitter's `_hooks_path_is` compares real
    // paths, so a lexical compare would say REFUSED for a `.githooks` reached through a junction
    // where the emitter says wired.
    // The native realpath also expands a Windows 8.3 short name (`RUNNER~1`), which git never reports.
    let full
    try { full = path.resolve(p) } catch { return p }
    let cur = full
    const tail = []
    for (;;) {
      try {
        const real = fs.realpathSync.native(cur)
        return tail.length ? path.join(real, ...tail.reverse()) : real
      } catch {
        const parent = path.dirname(cur)
        if (parent === cur) return full
        tail.push(path.basename(cur))
        cur = parent
      }
    }
  }

  function testHooksPathNames(cur, rootDir, rel) {
    // True when the clone's `core.hooksPath` names `rootDir/rel` in any spelling, as the emitter's
    // hooks: line does (harness_gates._hooks_path_is).
    // A hand-wired clone may hold `./.githooks`, an absolute path, or the MSYS form `/c/…/.githooks`
    // from Git Bash, which git for Windows honours and no Node path API does. A literal compare
    // would refuse each of those and call the placed hooks inert while they run on every commit.
    // Git resolves a relative value against the work tree's top level, so that is the base.
    // The caller's `git config --path` read expands `~/`, `~user/` and `%(prefix)/`, as the hook
    // runner does. The backslash and `/c/` rewrites are Windows-only, because a POSIX name may
    // contain a backslash or start `/c/`. Both sides compare as real paths (resolveRealPath).
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
    } else if (!compareRepoPath(resolveRealPath(root), resolveRealPath(top.trim()))) {
      // Setting hooksPath from a subdirectory would reconfigure the whole repository from a run scoped
      // to one subtree. The message names the real root.
      wire = `target is not the repository root (${top.trim()}) — core.hooksPath NOT set, because setting it here would reconfigure the entire repository`
    } else {
      // `--path` applies git's own expansion (`~/`, `%(prefix)/`), as the hook runner does. A plain
      // `--get` returns the raw text, and a tilde-wired clone would read as foreign.
      // `--show-scope` names the winning scope. A worktree-scope core.hooksPath
      // (`extensions.worktreeConfig`) outranks `.git/config`, so a `--local` read alone could call
      // the clone wired while git runs hooks from elsewhere. Output is `<scope>\t<value>`. Git
      // prints nothing and exits 1 when the key is unset at every scope.
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
        // The worktree scope decides. This branch writes at neither scope, because a local write
        // would be a no-op that reads as success.
        if (testHooksPathNames(effVal, root, HOOKS_DIR)) {
          wire = `core.hooksPath at worktree scope is '${effVal}', which names '${HOOKS_DIR}' (left as written) — already wired`
        } else {
          wire = `core.hooksPath at WORKTREE scope is '${effVal}' — it outranks the local value, so the placed hooks do not run in this worktree; REFUSED to change it. Set it yourself if that is what you meant: git config --worktree core.hooksPath ${HOOKS_DIR}`
        }
      } else if (cur === HOOKS_DIR) {
        wire = `core.hooksPath already '${HOOKS_DIR}' — already wired`
      } else if (testHooksPathNames(cur, root, HOOKS_DIR)) {
        // The same directory in another spelling counts as wired. The value stays as written.
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

  // The vendored workflow's push trigger lists `branches: [main, master]`. `on:` takes no
  // expressions, and the placed copy must stay byte-identical to the template (ywr-harness ADR 0014).
  // A repo with another default branch gets no push run, and nothing in CI reports that. The
  // scaffold knows the repo, so it warns here (ywr-harness ADR 0062).
  // origin/HEAD is the only offline default-branch signal. When it is unset, nothing is printed,
  // because the current branch would be a guess and a wrong warning teaches readers to ignore the line.
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
    // The wrapper, not build_docs.mjs directly, is the one entry that members and CI run. A second
    // caller would copy its contract.
    const wrapper = path.join(root, 'docs/build.mjs')
    if (fs.existsSync(wrapper)) {
      const r = spawnSync(process.execPath, [wrapper], { cwd: root, stdio: 'ignore', windowsHide: true })
      const code = r.error ? 1 : (r.status ?? 1)
      // The four surfaces include docs.artifact.html, the artifact-publish path's input (ywr-harness ADR 0032/0048).
      if (code === 0) say('  built: index.json · INDEX.md · docs.html · docs.artifact.html')
      else say(`  SKIP build — docs/build.mjs exited ${code}; run it directly and read the error`)
    } else {
      // A refused collision or a failed write can leave the wrapper unplaced.
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
