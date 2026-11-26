// ywr-harness:report-issue — the member-side half of the upstream feedback loop (ywr-harness ADR 0064, ywr-harness spec 0013).
// Node 22 or later, built-in modules only (ywr-harness ADR 0220).
//
//   node report-issue.mjs --description=<text> [--title=<t>] [--target=<dir>] [--out-dir=<dir>] [--repo=<owner/repo>]
//   node report-issue.mjs --file --body-path=<file> [--title=<t>] [--repo=<owner/repo>]
//
// The `--name=value` form is the safe spelling: a value that starts with a dash (a description such as
// "-x is broken") is refused by the argument parser in the `--name value` form.
//
// Two modes, and the split IS the contract:
//
//   DRAFT (default)            gather the report, write it to ONE scratch file, print where it is and
//                              the exact command that files it. Nothing is filed. The draft can make read-only
//                              network calls: the dry run fetches the repo's own remotes, and with
//                              toolchain drift `gh` searches the open reports for the fingerprint.
//   FILE  (--file --body-path) file THAT file — the one the member has read — as an issue on the
//                              public dist repo. The body is never regenerated here: what was shown
//                              is what is filed.
//
// No label is set, and none is searched for (ywr-harness ADR 0085): GitHub silently drops a label set at
// creation by a filer without push access, and most dist collaborators are read-role, so a label
// landed only for admins. The canon's session-start inbox lists EVERY open dist issue instead, and
// the `[upstream-report]` title prefix stays as the human-readable marker.
//
// What the body carries is decided in ywr-harness ADR 0064: the member's description verbatim; the running
// and registered plugin versions; `claude --version`; OS + node; the repo as owner/repo (parsed
// from origin — NEVER the URL, which can carry credentials); the refresh-nudge hook's verdict
// VERBATIM (a Node hook since ywr-harness ADR 0116, run with a synthetic SessionStart payload — with no node on
// PATH the report says so instead of a verdict; it writes nothing and exits 0 by contract,
// ywr-harness ADR 0033); `init.mjs --dry-run` output VERBATIM (writes nothing, ywr-harness spec 0009);
// the local git history of every file the dry run would change; a fingerprint for dedupe. Both
// readers are called as black boxes on purpose — the placement map lives in the harness-init skill and the
// hook's header forbids a second copy, so this script owns none of that logic.
//
// What it never does: include diff text (the tracker is PUBLIC — ywr-harness ADR 0064 option E), run
// harness-init, file without --file, retry a failed filing, or fall silent: `gh` absent or
// unauthenticated is a printed NOT FILED with the body kept and the by-hand URL (ywr-harness ADR 0012's
// shape — the script prints, the member acts).
//
// Exit codes: 0 = drafted / filed · 1 = usage or fatal (nothing useful produced) ·
//             2 = NOT FILED (body kept; gh absent, unauthenticated, or the create failed)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { whichOnPath, gitRun, getProp, psString, netTrim, inline, collator, parseJsonLoose } from '../../hooks/hook-lib.mjs'

const say = (line) => process.stdout.write(line + '\n')
const DIST = 'orcait-co/ywr-harness'
const selfPath = fileURLToPath(import.meta.url)
const pluginRoot = path.dirname(path.dirname(path.dirname(selfPath)))

// One value, one line, for every reader (harness_config.CONTROL's class plus the backtick): hook-lib's
// inline() with no length cap — a title from the PUBLIC dist tracker (ANY account can open an issue
// there, ywr-harness ADR 0085) cannot break the summary line or carry a terminal escape.
const one = (text) => inline(text, Infinity)

// Repo-derived text is NEVER live markdown on the public tracker: every quoted block goes inside a code
// fence one backtick longer than the longest backtick run it contains (a subject line carrying a
// triple-backtick run cannot close the fence early), and every inline value goes through one().
function fence(text) {
  let n = 3
  for (const m of text.matchAll(/`+/g)) if (m[0].length >= n) n = m[0].length + 1
  const f = '`'.repeat(n)
  return `${f}\n${text}\n${f}`
}

// Output lines of a finished child, the way PowerShell captured a native command: one entry per
// line, the final empty piece after the last newline dropped.
function lines(text) {
  const a = String(text).split(/\r?\n/)
  if (a.length && a[a.length - 1] === '') a.pop()
  return a
}

// Parsed git output goes through hook-lib's one git boundary (quotepath off, no shell, UTF-8 bytes).
function gitLines(args) {
  const r = gitRun(args)
  if (r.absent || r.status !== 0) return []
  return lines(r.text)
}

let ghExe
function ghPath() { if (ghExe === undefined) ghExe = whichOnPath('gh'); return ghExe }
function gh(args) {
  const r = spawnSync(ghPath(), args, { encoding: 'utf8', windowsHide: true })
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}
// `gh` on PATH AND authenticated. `gh auth status` exits non-zero when no account is logged in; its
// text is not parsed — only the code.
function ghUsable() {
  if (!ghPath()) return false
  return gh(['auth', 'status']).status === 0
}

// `claude --version`. On Windows an npm install puts a `claude.cmd` shim on PATH, which only a shell can
// start; the argument is the fixed `--version`, so the shell sees no member text.
function claudeVersion() {
  const miss = 'not on PATH (a wrapper account may run it under another name — say which in the description)'
  let r
  const exe = whichOnPath('claude')
  if (exe) {
    r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true })
  } else if (process.platform === 'win32') {
    const shim = whichShim('claude')
    if (!shim) return miss
    // cmd.exe's /s drops the outer quote pair, so the path keeps its own quotes inside it and a space in
    // the path cannot split it.
    r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${shim}" --version"`],
      { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true })
  } else {
    return miss
  }
  if (r.error) return 'on PATH, --version failed'
  const first = lines((r.stdout ?? '') + (r.stderr ?? ''))[0]
  return first !== undefined ? netTrim(first) : miss
}
function whichShim(name) {
  for (let dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    dir = dir.trim().replace(/^"(.*)"$/, '$1')
    if (!dir || !path.isAbsolute(dir)) continue
    for (const ext of ['.cmd', '.bat']) {
      const p = path.join(dir, name + ext)
      try { if (fs.statSync(p).isFile()) return p } catch { /* keep looking */ }
    }
  }
  return ''
}

// The `node` an exec-form hook would start: the host never launches a .cmd/.bat shim, so on Windows only
// a real node.exe counts; elsewhere a regular `node` file with an execute bit.
function nodeOnPath() {
  const file = process.platform === 'win32' ? 'node.exe' : 'node'
  for (let dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    dir = dir.trim().replace(/^"+|"+$/g, '')
    if (!dir) continue
    try {
      const cand = path.join(dir, file)
      if (!fs.statSync(cand).isFile()) continue
      if (file === 'node') fs.accessSync(cand, fs.constants.X_OK)
      return cand
    } catch { continue }
  }
  return ''
}

function isFile(p) { try { return fs.statSync(p).isFile() } catch { return false } }
function isDir(p) { try { return fs.statSync(p).isDirectory() } catch { return false } }

// PowerShell's `Sort-Object -Unique` on strings: case-insensitive order and a case-insensitive unique.
function sortUnique(items) {
  const out = []
  for (const s of [...items].sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0))) {
    if (!out.length || collator.compare(out[out.length - 1], s) !== 0) out.push(s)
  }
  return out
}

function main() {
  let a
  try {
    a = parseArgs({
      options: {
        description: { type: 'string', default: '' }, title: { type: 'string', default: '' },
        target: { type: 'string', default: '.' }, file: { type: 'boolean', default: false },
        'body-path': { type: 'string', default: '' }, repo: { type: 'string', default: DIST },
        'out-dir': { type: 'string', default: '' },
      },
      strict: true, allowPositionals: false,
    }).values
  } catch (e) {
    say(`FAIL — ${e.message}`)
    return 1
  }
  return a.file ? fileMode(a) : draftMode(a)
}

// =================================================================================================
// FILE mode
// =================================================================================================
function fileMode(a) {
  const bodyPath = a['body-path']
  const repo = a.repo
  if (!bodyPath) { say('FAIL — --file needs --body-path <the body DRAFT wrote>; the reviewed file is what gets filed, never a regenerated one (ywr-harness ADR 0064).'); return 1 }
  if (!isFile(bodyPath)) { say(`FAIL — body file not found: ${bodyPath}`); return 1 }
  const raw = fs.readFileSync(bodyPath, 'utf8').replace(/^﻿/, '')
  const ls = raw.split(/\r?\n/)
  let fileTitle = a.title
  let bodyStart = 0
  const m = ls.length ? /^<!--\s*title:\s*(.+?)\s*-->\s*$/.exec(ls[0]) : null
  if (m) {
    if (!fileTitle) fileTitle = m[1]
    bodyStart = 1
  }
  if (!fileTitle) { say('FAIL — no title: the body has no `<!-- title: … -->` first line and --title was not given.'); return 1 }
  const body = ls.slice(bodyStart).join('\n').replace(/^\n+/, '')
  if (!netTrim(body)) { say(`FAIL — body is empty after the title line: ${bodyPath}`); return 1 }
  const issuesNew = `https://github.com/${repo}/issues/new`

  if (!ghUsable()) {
    const why = ghPath() ? 'gh is not authenticated (gh auth status failed)' : 'gh is not on PATH'
    say(`  NOT FILED — ${why}. Body kept at: ${bodyPath}`)
    say(`  File it by hand: ${issuesNew}  (title: ${fileTitle})`)
    return 2
  }

  // The body handed to gh is the reviewed file minus its title line — written beside it so the
  // reviewed file itself stays untouched as the member's record.
  const filedPath = `${bodyPath}.filed.md`
  fs.writeFileSync(filedPath, (body + '\n').replace(/\r\n/g, '\n'), 'utf8')
  // No `-l` (ywr-harness ADR 0085): for a read-role filer GitHub drops it silently, so it never carried the
  // report to the inbox — the inbox lists every open dist issue.
  const r = gh(['issue', 'create', '-R', repo, '-t', fileTitle, '-F', filedPath])
  const out = [...lines(r.stdout), ...lines(r.stderr)]
  const url = out.filter(l => /^https:\/\/\S+\/issues\/\d+/.test(l)).pop()
  if (r.status === 0 && url) {
    say(`  filed: ${url}`)
    return 0
  }
  say(`  NOT FILED — gh issue create exited ${r.status ?? 'without an exit code'}${out.length ? ': ' + out.slice(0, 3).join(' | ') : ''}`)
  say(`  Body kept at: ${bodyPath} — file it by hand: ${issuesNew}  (title: ${fileTitle})`)
  return 2
}

// =================================================================================================
// DRAFT mode
// =================================================================================================
function draftMode(a) {
  const description = a.description
  const repo = a.repo
  if (!netTrim(description)) {
    say('FAIL — a report needs a description: --description="<what is wrong or missing, and what you expected>"')
    return 1
  }
  let target
  try { target = fs.realpathSync.native(path.resolve(a.target)) } catch { say(`FAIL — target not found: ${a.target}`); return 1 }
  // realpath resolves links; the shown path keeps the resolved form PowerShell's Resolve-Path gave, minus links.
  target = path.resolve(a.target)
  if (!isDir(target)) { say(`FAIL — target is not a directory: ${target}`); return 1 }
  let root = target
  const top = gitLines(['-C', target, 'rev-parse', '--show-toplevel'])
  if (top.length && netTrim(top[0])) root = path.normalize(netTrim(top[0]))

  // --- environment -------------------------------------------------------------------------------
  let runVer = 'unreadable'
  try {
    const mf = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8').replace(/^﻿/, ''))
    if (typeof mf.version === 'string' && /\d/.test(mf.version)) runVer = `v${mf.version}`
  } catch { /* unreadable */ }

  // Registered installs — the registry is self-located from this copy's path when it is a cache
  // install (<plugins>/cache/<marketplace>/<name>/<version>, registry at <plugins>/installed_plugins.json
  // — the refresh nudge's probe, ywr-harness ADR 0039), else the config dir's. UNDOCUMENTED file, read best-effort.
  const registered = []
  const regPaths = []
  try {
    const rr = path.resolve(pluginRoot)
    const cacheDir = path.dirname(path.dirname(path.dirname(rr)))
    if (cacheDir && path.basename(cacheDir) === 'cache') regPaths.push(path.join(path.dirname(cacheDir), 'installed_plugins.json'))
  } catch { /* not a cache install */ }
  if (process.env.CLAUDE_CONFIG_DIR) regPaths.push(path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins/installed_plugins.json'))
  regPaths.push(path.join(os.homedir(), '.claude/plugins/installed_plugins.json'))
  let regRead = ''
  for (const rp of regPaths) {
    if (!isFile(rp)) continue
    try {
      // Read leniently (comments, trailing commas), as the refresh nudge reads the same file.
      const reg = parseJsonLoose(fs.readFileSync(rp, 'utf8').replace(/^﻿/, ''))
      const plugins = reg && typeof reg.plugins === 'object' && reg.plugins !== null ? reg.plugins : {}
      for (const [name, val] of Object.entries(plugins)) {
        if (!name.toLowerCase().startsWith('ywr-harness@')) continue
        for (const e of Array.isArray(val) ? val : [val]) {
          const ver = e && typeof e.version === 'string' && /\d/.test(e.version) ? 'v' + e.version.replace(/^v/, '') : 'version unknown'
          registered.push(`${ver} (${name}, scope ${psString(e && e.scope)})`)
        }
      }
      regRead = rp
      break
    } catch { /* unreadable registry: try the next one */ }
  }
  const registeredLine = registered.length ? registered.join(' · ')
    : regRead ? 'none (registry read, no ywr-harness entry — a --plugin-dir or in-tree copy is running)'
      : 'registry not found (a --plugin-dir or in-tree copy is running)'

  const claudeVer = claudeVersion()
  const osLine = `${os.type()} ${os.release()} (${os.version()}) · node ${process.version}`

  // Repo identity — owner/repo ONLY. A remote URL can embed a token (https://user:token@host/…);
  // the URL itself is never written into the body.
  let repoId = '(no origin remote) ' + one(path.basename(root))
  const origin = gitLines(['-C', root, 'remote', 'get-url', 'origin'])
  if (origin.length && origin[0]) {
    // Two gates: the path shape, then GitHub's name alphabet — anything else (a backtick, a bracket,
    // a space) is not a repo id and must not reach the body as one.
    let cand = ''
    const om = /[:/]([^/:\s]+)\/([^/\s]+?)(\.git)?\/?$/.exec(origin[0])
    if (om) cand = `${om[1]}/${om[2]}`
    if (cand && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cand)) repoId = cand
    else repoId = '(unrecognized remote shape) ' + one(path.basename(root))
  }
  let branch = '(no git)'
  const br = gitLines(['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'])
  if (br.length && br[0]) branch = netTrim(br[0])

  let stampDisp = '(none)'
  const stampPath = path.join(root, '.harness-version')
  const hasStamp = isFile(stampPath)
  if (hasStamp) {
    try {
      // Bounded read, same reason as the nudge's probe: a stamp is one short token.
      const fd = fs.openSync(stampPath, 'r')
      const buf = Buffer.alloc(64)
      let n
      try { n = fs.readSync(fd, buf, 0, 64, 0) } finally { fs.closeSync(fd) }
      const off = n >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF ? 3 : 0
      let t = buf.subarray(off, n).toString('ascii')
      const cut = t.search(/[\r\n]/)
      if (cut >= 0) t = t.slice(0, cut)
      stampDisp = netTrim(t) ? netTrim(t) : '(empty file)'
    } catch { stampDisp = '(unreadable)' }
  }

  // --- scaffold drift — two existing readers, quoted verbatim, never re-implemented ----------------
  const scaffolded = hasStamp || isDir(path.join(root, 'scripts/harness'))
  let nudgeText = '(not a scaffolded repo — no `scripts/harness/` and no `.harness-version`; the nudge and the dry run were not run)'
  let dryRunText = nudgeText
  const drifted = []
  const foreign = []
  // The dry run can stop BEFORE comparing anything — init.mjs refuses a downgrade (repo stamp newer than
  // this copy, ywr-harness ADR 0042) with four lines and exit 1, so an empty drifted set means UNKNOWN, not
  // "none". Known only when init exited 0 AND printed its per-file summary line.
  let driftKnown = false
  let drCode = -1
  if (scaffolded) {
    const hook = path.join(pluginRoot, 'hooks/session-start-scaffold-refresh-nudge.mjs')
    if (isFile(hook)) {
      // The nudge runs the way the host runs it: an exec-form `node` found on PATH. With none, the host
      // could not run the hook either, so the report says that instead of a verdict.
      const nodeExe = nodeOnPath()
      if (!nodeExe) {
        nudgeText = '(the refresh nudge could not run: node is not on PATH, and the nudge is a Node hook — so no toolchain-drift verdict was read for this repo here; the dry run below is the only drift reader that ran)'
      } else {
        const payload = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'ywr-harness-report-issue', source: 'startup', cwd: root })
        // stdout is the verdict and is all that gets parsed: node's stderr (a NODE_OPTIONS preload's
        // warning, a deprecation notice) is quoted only when the run failed (non-zero exit) or its
        // stdout was not JSON — never merged into the JSON.
        const r = spawnSync(nodeExe, [hook], { input: payload + '\n', encoding: 'utf8', windowsHide: true })
        if (r.error) {
          nudgeText = `(hook invocation failed: ${r.error.message})`
        } else {
          const ho = netTrim(r.stdout ?? '')
          const hookExit = r.status
          const he = netTrim(r.stderr ?? '')
          const heNote = he ? ` [stderr: ${he}]` : ''
          if (!ho) {
            nudgeText = hookExit !== 0 ? `(the refresh nudge exited ${hookExit} with no output${heNote})`
              : '(silent — the refresh nudge reported no toolchain drift for this repo against the running plugin copy)'
          } else {
            let hj
            try { hj = JSON.parse(ho) } catch { hj = undefined }
            if (hj === undefined) {
              nudgeText = `(hook output was not JSON — quoted as-is) ${ho}${heNote}`
            } else {
              nudgeText = psString(hj && typeof hj === 'object' ? getProp(hj, 'systemMessage') : undefined)
              if (!nudgeText) nudgeText = `(hook spoke without a systemMessage: ${ho})`
              if (hookExit !== 0) nudgeText += `\n(the refresh nudge exited ${hookExit}${heNote})`
            }
          }
        }
      }
    } else {
      nudgeText = '(this plugin copy has no hooks/session-start-scaffold-refresh-nudge.mjs — installed copy inconsistent)'
    }

    const init = path.join(pluginRoot, 'skills/harness-init/init.mjs')
    if (isFile(init)) {
      const r = spawnSync(process.execPath, [init, `--target=${root}`, '--dry-run'], { cwd: root, encoding: 'utf8', windowsHide: true })
      if (r.error) {
        dryRunText = `(init.mjs --dry-run invocation failed: ${r.error.message})`
      } else {
        drCode = r.status ?? -1
        const dr = [...lines(r.stdout ?? ''), ...lines(r.stderr ?? '')]
        // Two of init.mjs's line shapes name a file that DIFFERS from its template: `~ <f> (…)`
        // (would be refreshed / replaced) and the first-run collision refusal (ywr-harness ADR 0055). The
        // GUARDED marker-less refusal is different — a foreign file the scaffold leaves alone and
        // the nudge is silent on by design (ywr-harness ADR 0033) — so it is listed as foreign, not as drift.
        for (const ln of dr) {
          let m
          if ((m = /^\s*~\s+(\S+)\s+\(/.exec(ln))) drifted.push(m[1])
          else if ((m = /^\s*!\s+(\S+)\s+REFUSED — first run/.exec(ln))) drifted.push(m[1])
          else if ((m = /^\s*!\s+(\S+)\s+REFUSED/.exec(ln))) foreign.push(m[1])
        }
        driftKnown = drCode === 0 && dr.some(l => /^\s*created=\d+ refreshed=\d+/.test(l))
        const shown = dr.slice(0, 80)
        const capNote = dr.length > shown.length ? `\n(… ${dr.length - shown.length} more lines not shown — capped at 80)` : ''
        dryRunText = shown.join('\n') + capNote
        if (drCode !== 0) dryRunText = `(init.mjs --dry-run exited ${drCode} — output quoted as-is)\n` + dryRunText
      }
    } else {
      dryRunText = '(this plugin copy has no skills/harness-init/init.mjs — installed copy inconsistent)'
    }
  }

  const driftedU = sortUnique(drifted)
  const foreignU = sortUnique(foreign)
  const historyLines = []
  for (const f of driftedU) {
    const lg = gitLines(['-C', root, 'log', '--oneline', '-3', '--', f])
    const st = gitLines(['-C', root, 'status', '--porcelain', '--', f])
    const note = st.length ? ' · uncommitted changes present' : ''
    // Plain text — the whole block is rendered inside a fence, so subjects and paths stay verbatim and inert.
    if (lg.length) { historyLines.push(f + note); for (const l of lg) historyLines.push(`    ${l}`) }
    else historyLines.push(f + ' — no commit touches this path (untracked or no git)' + note)
  }

  // Fingerprint — repo + running version + the drifted set. A dedupe HINT (ywr-harness ADR 0064), never a block.
  const fpInput = `${repoId}|${runVer}|` + driftedU.join(',')
  const fingerprint = 'fb' + crypto.createHash('sha256').update(fpInput, 'utf8').digest('hex').slice(0, 10)

  // --- title + body -------------------------------------------------------------------------------
  let title = a.title
  if (!title) {
    let first = netTrim(description.split(/\r?\n/).find(l => netTrim(l)) ?? '')
    if (first.length > 70) first = first.slice(0, 67).trimEnd() + '…'
    title = `[upstream-report] ${repoId}: ${first}`
  }

  const driftedList = driftedU.map(s => '`' + one(s) + '`')
  const foreignList = foreignU.map(s => '`' + one(s) + '`')
  let driftSummary = !scaffolded ? 'not a scaffolded repo'
    : !driftKnown ? `UNKNOWN — init.mjs --dry-run exited ${drCode} before comparing (its output is quoted below); nothing here can say whether a re-run would change files`
      : drifted.length ? `${drifted.length} toolchain file(s) a re-run would change: ` + driftedList.join(', ')
        : 'none — a re-run would change nothing'
  if (foreign.length) driftSummary += ' · refused as foreign and left alone (not drift): ' + foreignList.join(', ')
  const b = []
  b.push(`<!-- title: ${title} -->`)
  b.push('## Report', '', netTrim(description), '')
  b.push('## Environment', '')
  b.push(`- ywr-harness running (this copy): **${one(runVer)}** · registered install(s): ${one(registeredLine)}`)
  b.push(`- claude: ${one(claudeVer)}`)
  b.push(`- host: ${one(osLine)}`)
  b.push(`- repo: \`${repoId}\` · branch \`${one(branch)}\` · \`.harness-version\` stamp: ${one(stampDisp)}`)
  b.push(`- toolchain drift: ${driftSummary}`)
  b.push(`- fingerprint: \`${fingerprint}\` (repo · running version · drifted set — search open reports for it before filing a duplicate)`)
  b.push('')
  b.push('## Scaffold drift — refresh-nudge verdict (ywr-harness ADR 0033/0042, quoted verbatim)', '', fence(nudgeText), '')
  b.push('## What a `harness-init` re-run would change (`init.mjs --dry-run`, quoted verbatim)', '', fence(dryRunText), '')
  if (drifted.length) {
    b.push('## Local history of the files a re-run would change (`git log --oneline -3`)', '', fence(historyLines.join('\n')), '')
  }
  b.push('---')
  b.push('Drafted by `/ywr-harness:report-issue` (ywr-harness ADR 0064). No file contents or diffs are included — only names, versions and commit subjects; the canon asks for a diff in this thread when it needs one.')
  const bodyBytes = Buffer.from((b.join('\n') + '\n').replace(/\r\n/g, '\n'), 'utf8')

  const outDir = a['out-dir'] || os.tmpdir()
  if (!isDir(outDir)) fs.mkdirSync(outDir, { recursive: true })
  // The name carries the second; a second draft in the same second and directory takes `-2`, `-3`, …
  // The exclusive create ('wx') makes the claim atomic, so two concurrent runs never write one file.
  const stamp = localStamp(new Date())
  let bodyFile = ''
  for (let n = 1; !bodyFile && n <= 100; n++) {
    const cand = path.join(outDir, `ywr-harness-report-issue-${stamp}${n > 1 ? `-${n}` : ''}.md`)
    let fd
    try { fd = fs.openSync(cand, 'wx') }
    catch (e) { if (e.code === 'EEXIST') continue; throw e }
    // A failed write removes its own claim: FILE mode files what DRAFT wrote, never a partial body.
    try { fs.writeSync(fd, bodyBytes); fs.closeSync(fd) }
    catch (e) {
      try { fs.closeSync(fd) } catch { /* the close can fail the same way the write did */ }
      try { fs.unlinkSync(cand) } catch { /* best effort */ }
      throw e
    }
    bodyFile = cand
  }
  if (!bodyFile) { say(`FAIL — 100 draft names for ${stamp} already exist in ${outDir}`); return 1 }

  // --- similar open reports (informational) ---------------------------------------------------------
  let similar = scaffolded && !driftKnown ? 'not searched (drift UNKNOWN — the dry run did not compare)'
    : 'not searched (no toolchain drift — the fingerprint would only name the repo and version)'
  const searchCap = 20
  if (drifted.length) {
    if (ghUsable()) {
      // Every open dist issue, no label filter (ywr-harness ADR 0085): a read-role member's earlier report
      // carries no label, and the quoted 12-char fingerprint is the discriminator.
      // The author is named on every hit: without the label, ANY account's issue can carry a published
      // fingerprint, so the member sees who filed the "similar" report before being steered to it.
      const r = gh(['issue', 'list', '-R', repo, '--state', 'open', '-S', `"${fingerprint}"`, '--json', 'number,title,author', '--limit', String(searchCap)])
      if (r.status === 0) {
        try {
          const parsed = JSON.parse(r.stdout)
          const hits = (Array.isArray(parsed) ? parsed : [parsed]).map(x => {
            const who = one(psString(x && x.author && x.author.login))
            return `#${psString(x && x.number)} ${one(psString(x && x.title))}` + (who ? ` (by ${who})` : '')
          })
          // The search itself is capped; a full page says so — never a silent cap.
          similar = !hits.length ? 'none' : hits.length >= searchCap ? hits.join(' · ') + ` (search capped at ${searchCap} — more may exist)` : hits.join(' · ')
        } catch (e) { similar = `NOT CHECKED (${one(e.message)})` }
      } else { similar = `NOT CHECKED (gh issue list exited ${r.status ?? 'without an exit code'})` }
    } else { similar = 'NOT CHECKED (gh absent or not authenticated)' }
  }

  say(`report-issue -> ${root}`)
  say(`  body: ${bodyFile}`)
  say(`  title: ${title}`)
  say(`  drift: ${driftSummary}`)
  say(`  similar open reports: ${similar}`)
  say('  next: read the body, then file exactly that file with:')
  const repoArg = repo !== DIST ? ` --repo="${repo}"` : ''
  say(`    node "${selfPath}" --file --body-path="${bodyFile}"${repoArg}`)
  return 0
}

// yyyyMMdd-HHmmss in local time.
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

process.exitCode = main()
