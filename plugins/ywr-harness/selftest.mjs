// The plugin selftest runner: ywr-harness spec 0008 §3.1, §3.4, §3.9 and ywr-harness ADR 0231.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { git_result } from './scripts/harness_git.mjs'
import { convertToGlobPattern, testAnyMatch } from './lib/selftest-glob.mjs'
import {
  say, sayLine, signalLines, passCount, formatSeconds, installSignalCleanup, runGate, runPool, commonDir, readTimes, startOrder, writeTimes,
} from './lib/selftest-runner.mjs'

const pluginDir = path.dirname(fileURLToPath(import.meta.url))

const USAGE = `Usage: node selftest.mjs [--jobs=N] [--suite-timeout=S] [--shard=i/N] [--list] [--full] [--changed [--base=<ref>]] [--help]

Runs manifest-gate.mjs, the workflow corpus gate, then every *.selftest.mjs under this directory.
  --jobs=N            suites run at once (default min(CPUs, 8))
  --suite-timeout=S   seconds one suite may run before it is killed with its process tree (1..86400, default 900)
  --shard=i/N         run only the i-th of N slices of the discovery (1-based, round-robin by ordinal path order)
  --list              print the discovery and the selection, run nothing, exit 0
  --full              print every suite's full output instead of the condensed view
  --changed           run only the suites whose read set in selftest-reads.json a changed file matches
  --base=<ref>        with --changed: the commit the change is measured from (default HEAD)
  --help              print this text`

const fail = (line) => say(`FAIL — ${line}`, 'red')
const wholeNumber = (s) => (/^[1-9][0-9]*$/u.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null)
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// Git that cannot start reads as a failed call, so a tree without git on PATH is "not in git" (spec 0008 §3.4).
const gitR = (cwd, args) => {
  try { return git_result(cwd, args) } catch (e) { return { status: -1, stdout: '', stderr: String(e?.message ?? e) } }
}

// --- discovery (spec 0008 §3.1) -------------------------------------------------------------------------
// A file under templates/ is scaffold payload: counted, never run (spec 0008 §3.1).
function walk(dir, out, base = '') {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) walk(path.join(dir, e.name), out, rel)
    else if (e.isFile()) out.push(rel)
  }
}

// --- the git work tree and the file list of the map check (spec 0008 §3.4) -------------------------------------
function findGitTop() {
  for (let d = pluginDir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d
    if (path.dirname(d) === d) return null
  }
}

// --- the changed-file selection (spec 0008 §3.4) ----------------------------------------------------------------
const WINDOW_DAYS = 7
const WINDOW_COMMITS = 5

function toolSeries() {
  const git = gitR(pluginDir, ['--version'])
  const m = git.status === 0 ? /\d+\.\d+(?:\.\d+)?\S*/u.exec(git.stdout) : null
  return { os: `${os.type()} ${os.release()}`, git: m ? m[0] : 'n/a', node: process.versions.node }
}

const nulList = (out) => out.split('\0').map((p) => p.replace(/^\n+|\n+$/gu, '')).filter(Boolean)

async function main() {
  let v
  try {
    v = parseArgs({
      args: process.argv.slice(2), strict: true, allowPositionals: false,
      options: {
        jobs: { type: 'string' }, 'suite-timeout': { type: 'string' }, shard: { type: 'string' }, list: { type: 'boolean' },
        full: { type: 'boolean' }, changed: { type: 'boolean' }, base: { type: 'string' }, help: { type: 'boolean' },
      },
    }).values
  } catch (e) { fail(e.message); say(USAGE); return 1 }
  if (v.help) { say(USAGE); return 0 }

  let jobs = Math.min(os.availableParallelism(), 8)
  if (v.jobs !== undefined) {
    jobs = wholeNumber(v.jobs)
    if (jobs === null) { fail(`--jobs must be a whole number >= 1 (got ${v.jobs})`); return 1 }
  }
  let suiteTimeout = 900
  if (v['suite-timeout'] !== undefined) {
    suiteTimeout = wholeNumber(v['suite-timeout'])
    if (suiteTimeout === null || suiteTimeout > 86400) { fail(`--suite-timeout must be a whole number of seconds from 1 to 86400 (got ${v['suite-timeout']})`); return 1 }
  }
  let shardIndex = 0
  let shardCount = 0
  if (v.shard !== undefined) {
    const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(v.shard)
    const i = m ? wholeNumber(m[1]) : null
    const n = m ? wholeNumber(m[2]) : null
    if (i === null || n === null || i > n) { fail(`--shard must be i/N with 1 <= i <= N (got '${v.shard}')`); return 1 }
    shardIndex = i
    shardCount = n
  }
  const changed = v.changed === true
  const baseRef = v.base ?? ''
  if (changed && shardCount) { fail('--changed and --shard do not combine: a shard is a CI slice of the full run (ADR 0157)'); return 1 }
  if (v.base !== undefined && !changed) { fail('--base needs --changed'); return 1 }

  // Discovery runs before the gates, so a refusal and --list cost no gate time (spec 0008 §3.1).
  const templateRx = /(?:^|\/)templates\//u
  const everything = []
  walk(pluginDir, everything)
  const found = everything.filter((r) => /\.selftest\.mjs$/iu.test(r))
  const templateExcluded = found.filter((r) => templateRx.test(r)).length
  const rels = [...new Set(found.filter((r) => !templateRx.test(r)))].sort(ordinal)
  if (rels.length === 0) {
    fail(`no *.selftest.mjs discovered (empty set is not a pass; template payload excluded: ${templateExcluded})`)
    return 1
  }
  const byRel = new Set(rels)
  const failed = []

  // --- read-set map (spec 0008 §3.4) --------------------------------------------------------------------
  let inGit = false
  const gitTop = findGitTop()
  const gitPrefix = gitTop && pluginDir.length > gitTop.length ? `${path.relative(gitTop, pluginDir).split(path.sep).join('/')}/` : ''
  let pluginFiles = []
  let rootFiles = []
  if (gitTop) {
    const ls = gitR(gitTop, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    if (ls.status === 0) {
      inGit = true
      for (const p of nulList(ls.stdout)) {
        // A deleted file stays in the index until it is staged, and no suite reads it (spec 0008 §3.4).
        try { if (!fs.statSync(path.join(gitTop, p)).isFile()) continue } catch { continue }
        if (gitPrefix && p.startsWith(gitPrefix)) pluginFiles.push(p.slice(gitPrefix.length))
        else if (gitPrefix) rootFiles.push(`/${p}`)
        else pluginFiles.push(p)
      }
    }
  }
  if (!inGit) { pluginFiles = everything; rootFiles = [] }
  const nested = Boolean(gitPrefix)
  const mapProblems = []
  const mapPath = path.join(pluginDir, 'selftest-reads.json')
  let map = null
  if (!fs.existsSync(mapPath) || !fs.statSync(mapPath).isFile()) mapProblems.push('selftest-reads.json is missing')
  else {
    try { map = JSON.parse(fs.readFileSync(mapPath, 'utf8').replace(/^﻿/u, '')) } catch (e) { mapProblems.push(`selftest-reads.json does not parse: ${e.message}`) }
    if (map !== null && (typeof map !== 'object' || Array.isArray(map))) { mapProblems.push('selftest-reads.json is not an object'); map = null }
  }
  const globs = (value, where) => {
    if (!Array.isArray(value) || value.some((g) => typeof g !== 'string' || !g)) { mapProblems.push(`${where} is not a list of non-empty strings`); return [] }
    return value.map((g) => {
      const rx = new RegExp(`^${convertToGlobPattern(g)}$`)
      const pool = g.startsWith('/') ? rootFiles : pluginFiles
      if ((nested || !g.startsWith('/')) && !pool.some((f) => rx.test(f))) mapProblems.push(`${where} glob '${g}' matches no file`)
      return { glob: g, rx }
    })
  }
  const suiteRx = new Map()
  let fullRx = []
  let noneRx = []
  let versionRx = []
  if (map) {
    fullRx = globs(map.full, 'full')
    noneRx = globs(map.none, 'none')
    versionRx = Object.hasOwn(map, 'version_only') ? globs(map.version_only, 'version_only') : []
    if (map.suites === null || typeof map.suites !== 'object' || Array.isArray(map.suites)) mapProblems.push('suites is not an object')
    else {
      for (const k of Object.keys(map.suites).sort(ordinal)) {
        if (k.startsWith('//')) continue
        if (!byRel.has(k)) { mapProblems.push(`suites names '${k}', which is not a discovered suite`); continue }
        suiteRx.set(k, globs(map.suites[k], `suites['${k}']`))
      }
      for (const r of rels) if (!suiteRx.has(r)) mapProblems.push(`suite '${r}' has no read set`)
    }
    // An empty glob list claims nothing (spec 0008 §3.4).
    const all = [...fullRx, ...noneRx, ...[...suiteRx.values()].flat()].map((g) => g.rx)
    for (const f of pluginFiles) {
      if (byRel.has(f) || testAnyMatch(all, f)) continue
      mapProblems.push(`'${f}' is claimed by no suite, no full glob and no none glob`)
    }
  }
  if (mapProblems.length) {
    for (const m of mapProblems) fail(`read-set map: ${m}`)
    failed.push('selftest-reads.json')
  }

  // --- selection (spec 0008 §3.4) -------------------------------------------------------------------------
  const common = inGit ? commonDir(gitTop, pluginDir) : null
  const statePath = common ? path.join(common, 'ywr-harness', 'selftest-full-run.json') : null
  const changeSince = (rev) => {
    const d = gitR(gitTop, ['diff', '--name-only', '--no-renames', '-z', rev])
    if (d.status !== 0) return null
    const u = gitR(gitTop, ['ls-files', '-z', '--others', '--exclude-standard'])
    if (u.status !== 0) return null
    return [...new Set([...nulList(d.stdout), ...nulList(u.stdout)])].sort(ordinal)
  }
  // Paths travel as arguments: a piped list gains `\r` on Windows (ywr-harness ADR 0077).
  const contentHashes = (paths) => {
    const h = new Map()
    const live = []
    for (const p of paths) { try { if (fs.statSync(path.join(gitTop, p)).isFile()) { live.push(p); continue } } catch { /* deleted */ } h.set(p, 'deleted') }
    for (let i = 0; i < live.length; i += 200) {
      const chunk = live.slice(i, i + 200)
      const r = gitR(gitTop, ['hash-object', '--', ...chunk])
      const out = r.stdout.split(/\r?\n/u).filter(Boolean)
      if (r.status !== 0 || out.length !== chunk.length) return null
      chunk.forEach((p, k) => h.set(p, out[k].trim()))
    }
    return h
  }

  let tests = rels
  let fullReason = ''
  if (changed) {
    if (!statePath) fullReason = 'the plugin is not in a git work tree, so no change can be read'
    else {
      const ref = baseRef || 'HEAD'
      if (gitR(gitTop, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status !== 0) { fail(`--base does not name a commit: ${ref}`); return 1 }
      let state = null
      if (fs.existsSync(statePath)) { try { state = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^﻿/u, '')) } catch { state = null } }
      const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
      const stateOk = isObj(state) && state.head && state.utc && isObj(state.series) && isObj(state.dirty)
      let stateReason = ''
      let age = null
      let since = -1
      if (stateOk) {
        const now = toolSeries()
        const moved = Object.keys(now).filter((k) => `${state.series[k]}` !== `${now[k]}`).map((k) => `${k} ${state.series[k]} -> ${now[k]}`)
        const t = Date.parse(`${state.utc}`)
        if (!Number.isNaN(t)) age = (Date.now() - t) / 86400000
        if (gitR(gitTop, ['merge-base', '--is-ancestor', `${state.head}`, 'HEAD']).status === 0) {
          const c = gitR(pluginDir, ['rev-list', '--count', `${state.head}..HEAD`, '--', '.'])
          if (c.status === 0) since = Number.parseInt(c.stdout.trim(), 10)
        }
        if (moved.length) stateReason = `a tool changed since the last full run: ${moved.join('; ')}`
        else if (age === null || age < -0.01) stateReason = `the recorded full run has an unreadable or future time (${state.utc})`
        else if (age > WINDOW_DAYS) stateReason = `the last full run is ${Math.round(age * 10) / 10} days old (window ${WINDOW_DAYS} days)`
        else if (since < 0) stateReason = `the last full run's HEAD ${state.head} is not an ancestor of HEAD`
        else if (since >= WINDOW_COMMITS) stateReason = `${since} plugin commits since the last full run (window ${WINDOW_COMMITS})`
      }
      // A usable record anchors the change at its HEAD and its dirty paths (spec 0008 §3.4).
      const fromRecord = stateOk && !stateReason
      const from = fromRecord ? `${state.head}` : ref
      let paths = changeSince(from)
      if (paths !== null && fromRecord) {
        const extra = Object.keys(state.dirty)
        if (baseRef) { const more = changeSince(ref); if (more === null) paths = null; else extra.push(...more) }
        if (paths !== null) {
          paths = [...new Set([...paths, ...extra])].sort(ordinal)
          const seen = paths.filter((p) => Object.hasOwn(state.dirty, p))
          const nowHash = contentHashes(seen)
          if (nowHash === null) paths = null
          else paths = paths.filter((p) => !(Object.hasOwn(state.dirty, p) && `${state.dirty[p]}` === nowHash.get(p)))
        }
      }
      if (paths === null) fullReason = 'git could not list the change'
      else {
        // A repo file outside the plugin counts only through a / glob (spec 0008 §3.4).
        const rootGlobs = [...suiteRx.values()].flat().filter((g) => g.glob.startsWith('/')).map((g) => g.rx)
        let changedFiles = []
        for (const p of paths) {
          if (!gitPrefix) changedFiles.push(p)
          else if (p.startsWith(gitPrefix)) changedFiles.push(p.slice(gitPrefix.length))
          else if (testAnyMatch(rootGlobs, `/${p}`)) changedFiles.push(`/${p}`)
        }
        // A version-line-only diff of a version_only file selects no suite (spec 0008 §3.4).
        const versionLine = /^[+-]\s*"version"\s*:\s*"[^"]*"\s*,?\s*$/u
        const bumped = new Set()
        for (const f of changedFiles) {
          if (!testAnyMatch(versionRx.map((g) => g.rx), f)) continue
          const repoPath = f.startsWith('/') ? f.slice(1) : `${gitPrefix}${f}`
          // A path dirty at the full run gets no exemption (spec 0008 §3.4).
          if (fromRecord && Object.hasOwn(state.dirty, repoPath)) continue
          const d = gitR(gitTop, ['diff', '-U0', '--no-color', '--no-ext-diff', from, '--', repoPath])
          const hunk = d.stdout.split(/\r?\n/u).filter((l) => /^[+-]/u.test(l) && !/^(\+\+\+|---) /u.test(l))
          if (d.status === 0 && hunk.length && hunk.every((l) => versionLine.test(l))) bumped.add(f)
        }
        const fromText = fromRecord ? `the last full run (${from.slice(0, 7)})${baseRef ? ` and ${ref}` : ''}` : ref
        say(`changed: ${changedFiles.length} file(s) since ${fromText}, working tree included`)
        for (const f of changedFiles) say(`  * ${f}${bumped.has(f) ? ' (version line only: selects no suite)' : ''}`)
        const rawCount = changedFiles.length
        changedFiles = changedFiles.filter((f) => !bumped.has(f))
        const shared = changedFiles.filter((f) => testAnyMatch(fullRx.map((g) => g.rx), f))
        if (rawCount === 0) fullReason = 'the change is empty, so the selection would be empty'
        else if (mapProblems.length) fullReason = 'the read-set map failed its check'
        else if (shared.length) fullReason = `a shared input changed: ${shared.join(', ')}`
        else if (!stateOk) fullReason = `no green full run is recorded in this clone (${statePath})`
        else if (stateReason) fullReason = stateReason
        else {
          const picked = new Set()
          const unclaimed = []
          const noneAll = noneRx.map((g) => g.rx)
          for (const f of changedFiles) {
            let hit = f.startsWith('/') || byRel.has(f) || testAnyMatch(noneAll, f)
            if (byRel.has(f)) picked.add(f)
            for (const [k, rxs] of suiteRx) if (testAnyMatch(rxs.map((g) => g.rx), f)) { picked.add(k); hit = true }
            if (!hit) unclaimed.push(f)
          }
          if (unclaimed.length) fullReason = `a changed file matches no read set: ${unclaimed.join(', ')}`
          else {
            tests = rels.filter((r) => picked.has(r))
            say(`selection: ${tests.length} of ${rels.length} suites by read set (last full run ${Math.round(age * 10) / 10} days and ${since} plugin commit(s) ago, same tools)`, 'cyan')
          }
        }
      }
    }
    if (fullReason) say(`selection: FULL RUN — ${fullReason}`, 'yellow')
  }
  if (shardCount) {
    tests = rels.filter((_, k) => (k % shardCount) + 1 === shardIndex)
    say(`suites: discovered=${rels.length} shard=${shardIndex}/${shardCount} selected=${tests.length} template-excluded=${templateExcluded}`)
    if (tests.length === 0) {
      fail(`shard ${v.shard} selects 0 of ${rels.length} suites (N exceeds the discovery) — an empty slice is not a pass`)
      return 1
    }
  } else {
    say(`suites: discovered=${rels.length}${tests.length !== rels.length ? ` selected=${tests.length}` : ''} template-excluded=${templateExcluded}`)
  }
  for (const t of tests) say(`  - ${t}`)

  // --- start order (spec 0008 §3.1, ADR 0161) ------------------------------------------------------------------
  const timesPath = common ? path.join(common, 'ywr-harness', 'selftest-times.json') : null
  const { times, problem: timesProblem } = readTimes(timesPath)
  const ordered = startOrder(tests.map((rel, index) => ({ index, rel, abs: path.join(pluginDir, ...rel.split('/')) })),
    { jobs, timesPath, times, problem: timesProblem })
  const work = ordered.work

  if (v.list) {
    say(`start order: ${ordered.note} — ${work.map((w) => w.rel).join(', ')}`)
    say('LIST ONLY — nothing ran', 'yellow')
    return failed.length ? 1 : 0
  }

  // --- full-run snapshot (spec 0008 §3.4) -------------------------------------------------------------------
  // HEAD and the dirty hashes are read before any suite runs, so a mid-run edit stays a change (spec 0008 §3.4).
  const isFullRun = !shardCount && tests.length === rels.length
  let snapshot = null
  if (isFullRun && statePath) {
    const head = gitR(pluginDir, ['rev-parse', 'HEAD'])
    if (head.status === 0 && head.stdout.trim()) {
      const dirtyPaths = changeSince('HEAD')
      const dirty = dirtyPaths ? contentHashes(dirtyPaths) : null
      if (dirty) snapshot = { head: head.stdout.trim(), dirty: Object.fromEntries(dirty) }
    }
  }

  // --- the two gates -----------------------------------------------------------------------------------------
  // A gate leads its own process group off Windows, so a signal ends its tree only through this handler (spec 0008 §3.1).
  installSignalCleanup('selftest')
  const gate = path.join(pluginDir, 'manifest-gate.mjs')
  if (!fs.existsSync(gate)) {
    fail('manifest-gate.mjs missing (the wiring gate is not optional)')
    failed.push('manifest-gate.mjs (missing)')
  } else {
    say('--- manifest-gate.mjs', 'cyan')
    if ((await runGate(gate, [], { limitSec: suiteTimeout })) !== 0) failed.push('manifest-gate.mjs')
  }
  // The plugin ships no workflow (ywr-harness ADR 0215). A repo's own workflows go through scripts/workflow-gates.mjs.
  const wfGate = path.join(pluginDir, 'scripts', 'workflow-gates.mjs')
  const wfDir = path.join(pluginDir, 'workflows')
  if (fs.existsSync(wfGate) && fs.existsSync(wfDir)) {
    say('--- workflow-gates.mjs (corpus: workflows/)', 'cyan')
    if ((await runGate(wfGate, ['--root', pluginDir, '--dir', 'workflows'], { limitSec: suiteTimeout })) !== 0) failed.push('workflow-gates.mjs')
  } else if (fs.existsSync(wfDir)) {
    fail('workflows/ exists but scripts/workflow-gates.mjs is missing: the corpus would be gated by nothing')
    failed.push('workflow-gates.mjs (missing, corpus present)')
  } else {
    say('--- workflow-gates.mjs: this plugin ships no workflow, so the corpus gate has nothing to run', 'cyan')
  }

  // --- the suites (spec 0008 §3.1) ---------------------------------------------------------------------------
  say(`--- suites: ${work.length} selected, jobs=${jobs}, start order: ${ordered.note} — one 'done' line per suite as it finishes (completion order)`, 'cyan')
  const outerJobs = Math.min(jobs, work.length)
  const t0 = performance.now()
  const results = await runPool(work, {
    jobs, limitSec: suiteTimeout, outerJobs,
    onDone: (r) => say(`done ${r.rel} ${r.code === 0 ? 'PASS' : 'FAIL'} (${formatSeconds(r.seconds)} s, ${passCount(r.lines)} PASS lines)`, r.code === 0 ? 'green' : 'red'),
  })
  const wall = (performance.now() - t0) / 1000

  // Results print in discovery order (spec 0008 §3.1).
  const byIndex = new Map(results.map((r) => [r.index, r]))
  let testFails = 0
  say(`--- results in discovery order: ${v.full ? 'every suite in full (--full)' : 'a failed suite in full, a passing suite as one line plus its SKIP/WARN/FAIL/KEEP lines (--full prints all)'}`, 'cyan')
  for (const w of [...work].sort((a, b) => a.index - b.index)) {
    const r = byIndex.get(w.index)
    if (!r) { fail(`${w.rel} — no result came back from the concurrent run`); failed.push(`${path.basename(w.rel)} (no result)`); testFails++; continue }
    const pass = r.code === 0
    if (!pass) { failed.push(path.basename(w.rel)); testFails++ }
    const stats = `${passCount(r.lines)} PASS lines, ${formatSeconds(r.seconds)} s`
    if (v.full || !pass) {
      say(`--- ${w.rel} ${pass ? 'PASS' : 'FAIL'} (exit ${r.code}, ${stats}) — captured output:`, pass ? 'cyan' : 'red')
      for (const l of r.lines) sayLine(l)
    } else {
      say(`ok   ${w.rel} (${stats})`, 'green')
      for (const l of signalLines(r.lines)) sayLine(l)
    }
  }
  const sum = results.reduce((a, r) => a + r.seconds, 0)
  const slowest = [...results].sort((a, b) => b.seconds - a.seconds)[0]
  say(`timing: suites wall-clock ${formatSeconds(wall)} s at jobs=${jobs} · sum of suite times ${formatSeconds(sum)} s${slowest ? ` · slowest ${slowest.rel} ${formatSeconds(slowest.seconds)} s` : ''}`)
  // A failed write changes no exit code (spec 0008 §3.1).
  if (timesPath && results.length) {
    try { writeTimes(timesPath, { known: byRel, times, results }) } catch (e) {
      say(`WARN [runner] the suite times were not written (${e.message}); the next run starts in the order it can read`, 'yellow')
    }
  }

  say('')
  const shardNote = shardCount ? ` shard=${shardIndex}/${shardCount} selected=${tests.length}` : !isFullRun ? ` selected=${tests.length}` : ''
  say(`selftests: discovered=${rels.length}${shardNote} passed=${tests.length - testFails} failed=${testFails}`)
  if (failed.length) { fail(failed.join(', ')); return 1 }
  // A green full run writes the record; a failed write only costs the next --changed a full run (spec 0008 §3.4).
  if (isFullRun && statePath) {
    try {
      if (!snapshot) throw new Error('git could not read HEAD or hash the working tree before the run')
      const record = { utc: new Date().toISOString(), head: snapshot.head, series: toolSeries(), dirty: snapshot.dirty }
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      const tmp = `${statePath}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8')
      fs.renameSync(tmp, statePath)
      say(`full-run record: ${statePath}`)
    } catch (e) {
      say(`WARN [runner] the full-run record was not written (${e.message}); the next --changed run is a full run`, 'yellow')
    }
  }
  if (!isFullRun && !shardCount) {
    say(`ywr-harness plugin: selected gates green — ${tests.length} of ${rels.length} suites by read set, NOT a full run`, 'green')
    return 0
  }
  say(`ywr-harness plugin: all gates green${shardCount ? ` (shard ${shardIndex}/${shardCount})` : ''}`, 'green')
  return 0
}

process.exitCode = await main()
