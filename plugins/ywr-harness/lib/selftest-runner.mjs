// Suite engine of both runners: ywr-harness spec 0008 §3.1 and §3.7. Git goes through scripts/harness_git.mjs (ywr-harness ADR 0223).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { performance } from 'node:perf_hooks'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { git_result } from '../scripts/harness_git.mjs'

const WIN = process.platform === 'win32'
export const REPORTER_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'selftest-reporter.mjs')).href

// --- output ------------------------------------------------------------------------------------------
const TTY = !!process.stdout.isTTY && !process.env.NO_COLOR
const CODES = { red: '31', green: '32', yellow: '33', cyan: '36' }
export const say = (line = '', color = '') => { process.stdout.write(`${color && TTY ? `\x1b[${CODES[color]}m${line}\x1b[0m` : line}\n`) }

// A signal line starts with SKIP, WARN, FAIL or KEEP, read on its plain text (spec 0008 §3.1).
const ANSI_RX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'gu')
export const stripAnsi = (s) => s.replace(ANSI_RX, '')
export const signalLines = (lines) => lines.map(stripAnsi).filter((l) => /^(SKIP|WARN|FAIL|KEEP)/u.test(l))
export const passCount = (lines) => lines.filter((l) => /^PASS/u.test(l)).length
export const formatSeconds = (s) => s.toFixed(1)
export function sayLine(line) { say(line, /^FAIL/u.test(line) ? 'red' : /^(SKIP|WARN|KEEP)/u.test(line) ? 'yellow' : '') }

// --- process tree ------------------------------------------------------------------------------------
const live = new Set()
const systemExe = (name) => path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', name)

// Windows: taskkill /T. Elsewhere the detached gate or suite leads its own process group.
export function killTree(child) {
  if (!child.pid) return
  if (WIN) {
    try { spawnSync(systemExe('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* the plain kill below */ }
    try { child.kill('SIGKILL') } catch { /* gone already */ }
    return
  }
  try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone already */ } }
}

// A detached gate or suite outlives a killed runner, so the handler ends every live tree first (spec 0008 §3.1).
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']
export function installSignalCleanup(name) {
  const onSignal = (sig) => {
    for (const s of SIGNALS) process.removeAllListeners(s)
    process.stderr.write(`${name}: stopped by ${sig}; ending the running child processes\n`)
    for (const c of live) killTree(c)
    process.kill(process.pid, WIN ? 'SIGTERM' : sig)
  }
  for (const s of SIGNALS) process.on(s, onSignal)
}

// --- one suite (spec 0008 §3.1, ywr-harness ADR 0098, ADR 0165) ------------------------------------------
// The result is { lines, code, seconds }; code -1 means that no exit code is the verdict.
export function runSuite(abs, { limitSec, outerJobs, reporterUrl = REPORTER_URL }) {
  return new Promise((resolve) => {
    const graceMs = Math.min(limitSec, 30) * 1000
    const t0 = performance.now()
    const lines = []
    const env = { ...process.env, YWR_SELFTEST_OUTER_JOBS: String(outerJobs) }
    delete env.NODE_TEST_CONTEXT
    let child
    const startFailed = (e) => resolve({ lines: [`FAIL — the runner could not run this suite: ${e.message || e}`], code: -1, seconds: (performance.now() - t0) / 1000 })
    try {
      child = spawn(process.execPath, [`--test-reporter=${reporterUrl}`, '--test-reporter-destination=stdout', abs],
        { env, windowsHide: true, detached: !WIN, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { startFailed(e); return }
    live.add(child)
    let exitCode = null
    let exited = false
    let timedOut = false
    let held = false
    let unkillable = false
    let done = false
    let open = 2
    const timers = { limit: null, grace: null, drain: null }
    const carry = ['', '']
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')]
    const take = (k, text) => {
      const parts = (carry[k] + text).split(/\r?\n/u)
      carry[k] = parts.pop()
      for (const l of parts) lines.push(l)
    }
    const finish = () => {
      if (done) return
      done = true
      for (const t of Object.values(timers)) clearTimeout(t)
      for (let k = 0; k < 2; k++) { take(k, decoders[k].end()); if (carry[k]) lines.push(carry[k]) }
      // A child that outlived its kill stays in `live` for the signal cleanup, and unref lets the runner exit (spec 0008 §3.1).
      if (exited) live.delete(child)
      else { try { child.unref() } catch { /* gone already */ } }
      try { child.stdout.destroy(); child.stderr.destroy() } catch { /* closed already */ }
      let code = -1
      if (unkillable) lines.push(`FAIL — this suite exceeded --suite-timeout ${limitSec} s and was still running 30 s after the kill`)
      else if (timedOut) lines.push(`FAIL — this suite exceeded --suite-timeout ${limitSec} s and was killed with its process tree`)
      else code = exitCode
      if (held && !unkillable) {
        lines.push(`WARN [runner] this suite exited, but a process it started still held its output pipe ${timedOut ? 30 : graceMs / 1000} s later; the runner stopped reading, and the exit code is the verdict`)
      }
      // An exit 0 with no PASS or SKIP line ran no case (spec 0008 §3.9).
      if (code === 0 && !lines.some((l) => /^(PASS|SKIP) \[/u.test(l))) {
        lines.push('FAIL — this Node suite exited 0 with no PASS or SKIP line, so no case ran')
        code = 1
      }
      resolve({ lines, code, seconds: (performance.now() - t0) / 1000 })
    }
    const settle = () => { if (exited && open === 0) finish() }
    // A held pipe ends the wait: lines already read stay, and 1 s more takes the buffer (ywr-harness ADR 0165).
    const pipeHeld = () => { if (done) return; held = true; timers.drain = setTimeout(finish, 1000) }
    for (const [k, stream] of [[0, child.stdout], [1, child.stderr]]) {
      stream.on('data', (b) => take(k, decoders[k].write(b)))
      stream.on('end', () => { open--; settle() })
      stream.on('error', () => { open--; settle() })
    }
    child.on('error', (e) => { if (!exited && !done) { done = true; for (const t of Object.values(timers)) clearTimeout(t); live.delete(child); startFailed(e) } })
    child.on('exit', (code, signal) => {
      exited = true
      exitCode = code ?? 128 + (os.constants.signals[signal] ?? 0)
      if (!timedOut) { clearTimeout(timers.limit); timers.grace = setTimeout(pipeHeld, graceMs) }
      settle()
    })
    timers.limit = setTimeout(() => {
      if (exited) return
      timedOut = true
      killTree(child)
      // A kill that did not take ends the wait at 30 s (ywr-harness ADR 0098).
      timers.grace = setTimeout(() => { if (!exited) { unkillable = true; finish() } else pipeHeld() }, 30000)
    }, limitSec * 1000)
  })
}

// --- one gate: streamed, with the suite bounds (spec 0008 §3.1, ywr-harness ADR 0098, ADR 0165) ---------------
// The result is the exit code, or -1 when no exit code is the verdict.
export function runGate(file, args, { limitSec }) {
  return new Promise((resolve) => {
    const name = path.basename(file)
    const graceMs = Math.min(limitSec, 30) * 1000
    let child
    try {
      child = spawn(process.execPath, [file, ...args], { windowsHide: true, detached: !WIN, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { say(`FAIL — could not start ${name}: ${e.message}`, 'red'); resolve(-1); return }
    live.add(child)
    let exitCode = null
    let exited = false
    let done = false
    let open = 2
    const timers = { limit: null, grace: null }
    const finish = (code, line = '') => {
      if (done) return
      done = true
      for (const t of Object.values(timers)) clearTimeout(t)
      if (exited) live.delete(child)
      else { try { child.unref() } catch { /* gone already */ } }
      try { child.stdout.destroy(); child.stderr.destroy() } catch { /* closed already */ }
      if (line) sayLine(line)
      resolve(code)
    }
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (b) => process.stdout.write(b))
      stream.on('end', () => { open--; if (exited && open === 0) finish(exitCode) })
      stream.on('error', () => { open--; if (exited && open === 0) finish(exitCode) })
    }
    child.on('error', (e) => { if (!exited) finish(-1, `FAIL — could not start ${name}: ${e.message}`) })
    child.on('exit', (code, signal) => {
      exited = true
      exitCode = code ?? 128 + (os.constants.signals[signal] ?? 0)
      clearTimeout(timers.limit)
      if (done) { live.delete(child); return } // a timed-out gate is already judged, so no grace timer holds the runner (spec 0008 §3.7)
      if (open === 0) { finish(exitCode); return }
      timers.grace = setTimeout(() => finish(exitCode, `WARN [runner] ${name} exited, but a process it started still held its output pipe ${graceMs / 1000} s later; its exit code is the verdict`), graceMs)
    })
    timers.limit = setTimeout(() => {
      if (exited) return
      killTree(child)
      finish(-1, `FAIL — ${name} exceeded --suite-timeout ${limitSec} s and was killed with its process tree`)
    }, limitSec * 1000)
  })
}

// --- the pool ----------------------------------------------------------------------------------------
// work: [{ index, rel, abs }] in start order.
export async function runPool(work, { jobs, limitSec, outerJobs, reporterUrl, onDone }) {
  const results = []
  let next = 0
  const slot = async () => {
    for (;;) {
      const w = work[next++]
      if (!w) return
      const r = await runSuite(w.abs, { limitSec, outerJobs, reporterUrl })
      const res = { index: w.index, rel: w.rel, code: r.code, seconds: r.seconds, lines: r.lines }
      results.push(res)
      onDone?.(res)
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, work.length) }, slot))
  return results
}

// --- the clone's state directory and the suite times (spec 0008 §3.1, ADR 0161) ----------------------------
// The common git dir is read from files, not git, because --list needs it on every call (spec 0008 §3.1).
export function commonDirFromFiles(gitTop) {
  if (!gitTop || process.env.GIT_DIR || process.env.GIT_COMMON_DIR) return null
  try {
    const dotGit = path.join(gitTop, '.git')
    let gitDir = dotGit
    if (!fs.statSync(dotGit).isDirectory()) {
      const m = /^gitdir:\s*(.+)$/mu.exec(fs.readFileSync(dotGit, 'utf8').trim())
      if (!m) return null
      gitDir = path.resolve(gitTop, m[1].trim())
    }
    const cd = path.join(gitDir, 'commondir')
    const common = fs.existsSync(cd) ? path.resolve(gitDir, fs.readFileSync(cd, 'utf8').trim()) : path.resolve(gitDir)
    return fs.statSync(common).isDirectory() ? common : null
  } catch { return null }
}

export function commonDir(gitTop, cwd) {
  const fromFiles = commonDirFromFiles(gitTop)
  if (fromFiles) return fromFiles
  let r
  try { r = git_result(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']) } catch { return null }
  const d = r.status === 0 ? r.stdout.trim() : ''
  return d ? path.resolve(d) : null
}

export function readTimes(timesPath) {
  const times = new Map()
  if (!timesPath || !fs.existsSync(timesPath)) return { times, problem: '' }
  try {
    const doc = JSON.parse(fs.readFileSync(timesPath, 'utf8').replace(/^\uFEFF/u, ''))
    if (doc === null || typeof doc !== 'object' || doc.seconds === null || typeof doc.seconds !== 'object' || Array.isArray(doc.seconds)) throw new Error('it holds no "seconds" object')
    for (const [k, v] of Object.entries(doc.seconds)) if (typeof v === 'number' && Number.isFinite(v) && v >= 0) times.set(k, v)
    return { times, problem: '' }
  } catch (e) { return { times: new Map(), problem: `the times file does not parse (${e.message})` } }
}

// Start order: spec 0008 §3.1 and ywr-harness ADR 0161.
export function startOrder(work, { jobs, timesPath, times, problem }) {
  const timed = work.filter((w) => times.has(w.rel)).length
  if (jobs < 2) return { work, note: 'discovery order (--jobs 1)' }
  if (!timesPath) return { work, note: 'discovery order (not a git clone, so no suite times are kept)' }
  if (problem) return { work, note: `discovery order (${problem})` }
  if (!timed) return { work, note: 'discovery order (no suite time is recorded in this clone)' }
  const sorted = [...work].sort((a, b) => (times.has(a.rel) - times.has(b.rel)) || ((times.get(b.rel) ?? 0) - (times.get(a.rel) ?? 0)) || (a.index - b.index))
  return { work: sorted, note: `longest first by recorded time (${timed} of ${work.length} suites timed)` }
}

// Times merge and write: spec 0008 §3.1.
export function writeTimes(timesPath, { known, times, results }) {
  const merged = new Map()
  for (const [k, v] of times) if (known.has(k)) merged.set(k, v)
  for (const r of results) merged.set(r.rel, Math.round(r.seconds * 10) / 10)
  const seconds = {}
  for (const k of [...merged.keys()].sort()) seconds[k] = merged.get(k)
  const doc = { '//': 'ywr-harness ADR 0161: the seconds of each suite\'s newest run; selftest.mjs starts the longest first at --jobs 2 and above', utc: new Date().toISOString(), seconds }
  fs.mkdirSync(path.dirname(timesPath), { recursive: true })
  const tmp = `${timesPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
  fs.renameSync(tmp, timesPath)
}
