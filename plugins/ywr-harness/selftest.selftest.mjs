// Self-test for selftest.mjs, the plugin runner (spec 0008 §3.1, §3.4, §3.9; ywr-harness ADR 0231).
// Each case runs a copy of the runner in a fixture directory; cases A to E list the real tree with --list.
// Run: node --test-reporter=<file URL of lib/selftest-reporter.mjs> --test-reporter-destination=stdout selftest.selftest.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertMatch, fixtureRoot, innerJobs, matchFailures, removeFixtureRoot, runNode } from './lib/selftest-lib.mjs'
import { git_result } from './scripts/harness_git.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const live = path.join(here, 'selftest.mjs')
const root = fixtureRoot('selftest-runner-selftest')
// A holder is killed only while its port still answers: the system may reuse the PID of a holder that exited.
const heldPids = new Map()
after(async () => {
  for (const [pid, port] of heldPids) { if (await portAlive(port)) { try { process.kill(pid) } catch { /* gone already */ } } }
  removeFixtureRoot(root)
})

// Each child runs without NODE_TEST_CONTEXT and the GIT_* variables of a hook, which would redirect a nested run.
const childEnv = (extra = {}) => {
  const env = { ...process.env, ...extra }
  delete env.NODE_TEST_CONTEXT
  for (const k of Object.keys(env)) if (/^git_(dir|work_tree|index_file|common_dir|prefix)$/iu.test(k)) delete env[k]
  return env
}
const KO = String.fromCharCode(0xD55C, 0xAE00)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const finish = (fails) => { if (fails.length) assert.fail(fails.join('\n')) }

// --- fixtures ----------------------------------------------------------------------------------------
const RUNNER_FILES = ['selftest.mjs', 'lib/selftest-runner.mjs', 'lib/selftest-glob.mjs', 'lib/selftest-reporter.mjs', 'scripts/harness_git.mjs']
const write = (dir, rel, text) => {
  const p = path.join(dir, ...rel.split('/'))
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, text)
}
// A stub tree has no git; its map claims every file through none, and the dotfile proves that the listing keeps dotfiles.
function writeStubMap(dir, suites) {
  write(dir, '.dot/probe.txt', 'dotfile probe')
  write(dir, 'selftest-reads.json', JSON.stringify({ full: [], none: ['**', '.dot/probe.txt'], suites: Object.fromEntries(suites.map((s) => [s, []])) }))
}
const GATES = {
  pass: "console.log('PASS  stub manifest gate')\n",
  fail: "console.log('FAIL — stub gate failed')\nprocess.exit(1)\n",
}
let seq = 0
function tree({ name = `t${++seq}`, suites = {}, files = {}, gate = 'pass', map = 'stub' } = {}) {
  const dir = path.join(root, name)
  for (const f of RUNNER_FILES) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); copyFileSync(path.join(here, ...f.split('/')), path.join(dir, ...f.split('/'))) }
  if (gate !== 'missing') write(dir, 'manifest-gate.mjs', `${GATES[gate]}`)
  for (const [rel, text] of Object.entries({ ...suites, ...files })) write(dir, rel, text)
  const rels = Object.keys(suites).filter((r) => /\.selftest\.mjs$/u.test(r) && !/(^|\/)templates\//u.test(r))
  if (map === 'stub') writeStubMap(dir, rels)
  else if (typeof map === 'string') write(dir, 'selftest-reads.json', map)
  return dir
}

// --- running the runner -----------------------------------------------------------------------------------
const run = (dir, ...argv) => {
  const r = runNode([path.join(dir, 'selftest.mjs'), ...argv], { env: childEnv(), timeoutMs: 180000 })
  return { ...r, out: r.stdout + r.stderr, code: r.status }
}
// A run collected later, with an end-of-file check on the caller's pipes (ywr-harness ADR 0165).
function start(dir, argv, { exitLimitMs = 120000 } = {}) {
  const child = spawn(process.execPath, [path.join(dir, 'selftest.mjs'), ...argv], { env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let open = 2
  let eof
  const eofP = new Promise((r) => { eof = r })
  for (const s of [child.stdout, child.stderr]) { s.setEncoding('utf8'); s.on('data', (d) => { out += d }); s.on('close', () => { if (--open === 0) eof(true) }) }
  const exitP = new Promise((r) => child.on('exit', (code) => r(code)))
  return (async () => {
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, exitLimitMs)
    const code = await exitP
    clearTimeout(timer)
    const gotEof = await Promise.race([eofP, sleep(10000).then(() => false)])
    return { out, code, status: code, eof: gotEof, killed: code === null }
  })()
}
const listed = (r) => r.out.split(/\r?\n/u).map((l) => /^ {2}- (.+)$/u.exec(l)?.[1]).filter(Boolean)
const lineIndex = (text, rx) => text.split(/\r?\n/u).findIndex((l) => rx.test(l))
const prepared = (opts, r, code) => ({ ...opts, preFail: [...(opts.preFail ?? []), ...(r.code === code ? [] : [`exit ${r.code} (expected ${code})`])] })
const problems = (r, code, opts) => matchFailures(r.out, prepared(opts, r, code))
const check = (r, code, opts) => assertMatch(r.out, prepared(opts, r, code))
// The reporter indents the echo of a failing case's transcript, so it never reaches column 0 (G7).

// --- stubs --------------------------------------------------------------------------------------------
const passing = (id, n = 1) => `${Array.from({ length: n }, (_, i) => `console.log('PASS [${id}${i + 1} ok]')`).join('\n')}\n`
const nodeTest = (body) => `import test from 'node:test'\n${body}\n`
const brokenSuite = nodeTest("import assert from 'node:assert/strict'\ntest('B1 broken on purpose', () => { assert.fail('boom-detail') })")
// A holder asked by port, never by PID: the system may reuse a PID.
const HOLDER = "const net=require('node:net');const s=net.createServer(()=>{});s.listen(0,'127.0.0.1',()=>{require('node:fs').writeFileSync(process.argv[1],process.pid+' '+s.address().port)});setTimeout(()=>{},300000)"
// The caller's stub imports fs.
const holderStart = (portFile, spawnOpts) => `import { spawn } from 'node:child_process'
const g = spawn(process.execPath, ['-e', ${JSON.stringify(HOLDER)}, ${JSON.stringify(portFile)}], ${spawnOpts})
g.unref()
for (let i = 0; i < 200 && !fs.existsSync(${JSON.stringify(portFile)}); i++) await new Promise((r) => setTimeout(r, 50))
`
function readHolder(portFile) {
  if (!existsSync(portFile)) return null
  const m = /^(\d+) (\d+)/u.exec(readFileSync(portFile, 'utf8'))
  if (!m) return null
  heldPids.set(Number(m[1]), Number(m[2]))
  return { pid: Number(m[1]), port: Number(m[2]) }
}
const portAlive = (port) => new Promise((resolve) => {
  const s = net.connect({ port, host: '127.0.0.1' })
  const t = setTimeout(() => { s.destroy(); resolve(true) }, 5000)
  s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true) })
  s.on('error', () => { clearTimeout(t); resolve(false) })
})
const stopHolder = (h) => { if (h) { try { process.kill(h.pid) } catch { /* gone already */ } } }

// --- G10 and I3 start first and are collected later --------------------------------------------------------
// G10: a held grandchild must not hold the caller's pipe (ywr-harness ADR 0165). A 2 s limit that load defeats reruns at 8 s.
const heldDir = tree({ name: 'held', suites: { 'b-held.selftest.mjs': '' } })
const heldPort = path.join(heldDir, 'holder.port')
write(heldDir, 'b-held.selftest.mjs', `import fs from 'node:fs'
${holderStart(heldPort, "{ stdio: 'inherit', detached: true }")}console.log('PASS [b ok]')\nconsole.log('WARN [b] written before exit')\nprocess.exit(0)\n`)
async function heldCase(limit) {
  rmSync(heldPort, { force: true })
  const r = await start(heldDir, ['--jobs=1', `--suite-timeout=${limit}`])
  const h = readHolder(heldPort)
  const alive = h ? await portAlive(h.port) : false
  stopHolder(h)
  return { ...r, limit, h, alive }
}
const g10p = (async () => {
  let g = await heldCase(2)
  if (/^done b-held\.selftest\.mjs FAIL/mu.test(g.out) || !/^WARN \[b\] written before exit/mu.test(g.out) || !g.h) g = await heldCase(8)
  return g
})()

// I3: m-pass prints Korean and WARN lines, m-fail fails one test, m-empty registers none.
const nodeRunDir = tree({
  name: 'node-run',
  suites: {
    'a-pass.selftest.mjs': "console.log('PASS [a one]')\n",
    'm-pass.selftest.mjs': nodeTest(`const ko = String.fromCharCode(0xD55C, 0xAE00)
test('M1 first', () => {})
test('M2 body ' + ko, () => {})
test('M3 skipped', { skip: 'reported ' + ko }, () => {})
console.log('WARN [m warn] re-review trigger from a Node suite')
console.log('WARN [m outer] ' + process.env.YWR_SELFTEST_OUTER_JOBS)`),
    'm-fail.selftest.mjs': nodeTest("import assert from 'node:assert/strict'\ntest('F1 fine', () => {})\ntest('F2 broken on purpose', () => { assert.fail('boom-detail') })"),
    'm-empty.selftest.mjs': "import test from 'node:test'\n// no test registered\n",
  },
})
const i3p = start(nodeRunDir, ['--jobs=3'])

// --- A. the live listing: the baseline every partition case compares against ---------------------------------------
const base = run(path.dirname(live), '--list')
test('A -List: discovery listed, nothing ran', () => {
  check(base, 0, {
    mustMatch: [/suites: discovered=\d+/u, /^ {2}- selftest\.selftest\.mjs$/mu, /^ {2}- manifest-gate\.selftest\.mjs$/mu, /LIST ONLY/u],
    mustNotMatch: [/--- manifest-gate\.mjs/u, /all gates green/u, /shard=/u, /FAIL — read-set map/u, /selected=/u],
  })
})
const baseList = listed(base)
test('A2 listed count equals the discovered count', () => {
  assert.ok(new RegExp(`discovered=${baseList.length}\\b`, 'u').test(base.out) && baseList.length >= 2, `listed=${baseList.length}\n${base.out}`)
})
// Ordinal order with / separators makes the deal identical on every OS (ywr-harness ADR 0071).
test('A3 listing is in ordinal order, `/`-separated', () => {
  const sorted = [...baseList].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  assert.equal(baseList.join('\n'), sorted.join('\n'))
  assert.ok(!baseList.some((l) => l.includes('\\')), 'a listed path holds a backslash')
})

// --- B. partition: union == baseline, disjoint, non-empty, balanced, for several N -------------------------------
for (const n of [1, 3, 4]) {
  const runsP = Promise.all(Array.from({ length: n }, (_, k) => start(path.dirname(live), ['--list', `--shard=${k + 1}/${n}`])))
  test(`B N=${n} shards partition the discovery (union == baseline, disjoint, non-empty)`, async () => {
    const runs = await runsP
    const fails = []
    const parts = runs.map((r, k) => {
      const l = listed(r)
      if (r.code !== 0) fails.push(`shard ${k + 1}/${n} exit ${r.code}\n${r.out}`)
      if (l.length === 0) fails.push(`shard ${k + 1}/${n} listed nothing`)
      if (!new RegExp(`shard=${k + 1}/${n} selected=${l.length}\\b`, 'u').test(r.out)) fails.push(`shard ${k + 1}/${n} header and selected count differ`)
      return l
    })
    const union = parts.flat()
    const dupes = union.filter((x, i) => union.indexOf(x) !== i)
    if (dupes.length) fails.push(`a suite sits in two shards: ${dupes.join(', ')}`)
    if ([...baseList].sort().join('|') !== [...union].sort().join('|')) fails.push('the union differs from the baseline')
    finish(fails)
  })
  test(`B N=${n} round-robin: shard sizes within one of each other`, async () => {
    const sizes = (await runsP).map((r) => listed(r).length)
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `sizes=${sizes.join(',')}`)
  })
}

// --- C. determinism ------------------------------------------------------------------------------------
test('C shard 2/4 is deterministic across runs', () => {
  const c1 = run(path.dirname(live), '--list', '--shard=2/4')
  const c2 = run(path.dirname(live), '--list', '--shard=2/4')
  assert.equal(listed(c1).join('|'), listed(c2).join('|'))
})
test('C2 shard 1/1 equals the unsharded list', () => {
  check(run(path.dirname(live), '--list', '--shard=1/1'), 0, { mustMatch: [new RegExp(`shard=1/1 selected=${baseList.length}\\b`, 'u')], mustNotMatch: [/selected=0\b/u] })
})
test('C3 shard 1/1 lists exactly the baseline', () => {
  assert.equal(listed(run(path.dirname(live), '--list', '--shard=1/1')).join('|'), baseList.join('|'))
})

// --- D. malformed --shard: exit 1 before anything is listed or run ---------------------------------------------
// The 20-digit form pins the refusal of a number beyond the safe integer range.
for (const bad of ['0/4', '5/4', 'a/b', '1/0', '01/4', '1/4/2', '4', '99999999999999999999/2']) {
  test(`D malformed --shard '${bad}' refused`, () => {
    check(run(path.dirname(live), '--list', `--shard=${bad}`), 1, {
      mustMatch: [/FAIL — --shard must be i\/N/u, new RegExp(esc(`got '${bad}'`), 'u')], mustNotMatch: [/suites: discovered/u, /^ {2}- /mu, /LIST ONLY/u] })
  })
}

// --- E. an empty slice: N beyond the discovery is a misconfiguration, not a pass --------------------------------------
const beyond = baseList.length + 1
test(`E shard ${beyond}/${beyond} selects nothing → exit 1`, () => {
  const n = beyond
  check(run(path.dirname(live), '--list', `--shard=${n}/${n}`), 1, {
    mustMatch: [/selects 0 of \d+ suites/u, /an empty slice is not a pass/u, /selected=0\b/u], mustNotMatch: [/LIST ONLY/u, /^ {2}- /mu] })
})

// --- F. empty discovery ----------------------------------------------------------------------------------
// The refusal comes before the gates, and a templates/ suite never rescues the empty set (spec 0008 §3.1).
test('F zero discovered → exit 1 even under --list; a templates/ suite is excluded, counted, and rescues nothing', () => {
  const dir = tree({ name: 'empty', gate: 'missing', map: null, suites: { 'templates/scripts/payload.selftest.mjs': 'process.exit(0)\n' } })
  check(run(dir, '--list'), 1, {
    mustMatch: [/FAIL — no \*\.selftest\.mjs discovered/u, /empty set is not a pass/u, /template payload excluded: 1/u],
    mustNotMatch: [/LIST ONLY/u, /manifest-gate\.mjs missing/u, /suites: discovered/u, /payload\.selftest\.mjs/u] })
})
test('F2 the live listing declares template-excluded=0', () => {
  check(base, 0, { mustMatch: [/template-excluded=0\b/u], mustNotMatch: [/template-excluded=[1-9]/u] })
})

// --- I. Node suites are discovered, ordered and dealt like every suite --------------------------------------------
// 'Z' sorts before 'a' in ordinal order, which a culture sort would not do.
const nodeListSuites = ['Z-first.selftest.mjs', 'a-mid.selftest.mjs', 'b-last.selftest.mjs']
const nodeListDir = tree({ name: 'node-list', suites: { ...Object.fromEntries(nodeListSuites.map((n) => [n, 'process.exit(0)\n'])), 'templates/x/payload.selftest.mjs': 'process.exit(0)\n' } })
test('I1 -List discovers the suites in ordinal order and excludes a templates/ payload of that shape', () => {
  const r = run(nodeListDir, '--list')
  check(r, 0, {
    mustMatch: [/suites: discovered=3 template-excluded=1\b/u, /^ {2}- Z-first\.selftest\.mjs$/mu, /^ {2}- b-last\.selftest\.mjs$/mu, /LIST ONLY/u],
    mustNotMatch: [/payload\.selftest\.mjs/u, /^FAIL/mu, /selected=/u],
    preFail: listed(r).join('|') === nodeListSuites.join('|') ? [] : [`listing was '${listed(r).join('|')}'`] })
})
test('I1b -List --shard 2/3 deals the middle suite of the list', () => {
  check(run(nodeListDir, '--list', '--shard=2/3'), 0, { mustMatch: [/shard=2\/3 selected=1\b/u, /^ {2}- a-mid\.selftest\.mjs$/mu], mustNotMatch: [/Z-first/u, /b-last/u, /^FAIL/mu] })
})
// A suite needs a read set like any other: the map check names the one that has none.
test('I1c a suite with no read set fails the map check', () => {
  write(nodeListDir, 'selftest-reads.json', JSON.stringify({ full: [], none: ['**', '.dot/probe.txt'], suites: { 'Z-first.selftest.mjs': [], 'a-mid.selftest.mjs': [] } }))
  check(run(nodeListDir, '--list'), 1, { mustMatch: [/FAIL — read-set map: suite 'b-last\.selftest\.mjs' has no read set/u], mustNotMatch: [/all gates green/u, /by read set/u] })
})
test('I2 zero discovered counts a templates/ payload of each directory, and rescues nothing', () => {
  const dir = tree({ name: 'node-empty', gate: 'missing', map: null, suites: { 'templates/a/p1.selftest.mjs': 'process.exit(0)\n', 'templates/b/p2.selftest.mjs': 'process.exit(0)\n' } })
  check(run(dir, '--list'), 1, {
    mustMatch: [/FAIL — no \*\.selftest\.mjs discovered/u, /empty set is not a pass/u, /template payload excluded: 2/u], mustNotMatch: [/LIST ONLY/u, /suites: discovered/u, /p[12]\.selftest/u] })
})

// --- G. the concurrent run and its condensed output (ADR 0088) ----------------------------------------------------
// a-slow waits for c-pass through a marker file, so the finish order differs from the discovery order without a sleep race.
const aSlow = `import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = path.dirname(fileURLToPath(import.meta.url))
const ko = String.fromCharCode(0xD55C, 0xAE00)
const esc = String.fromCharCode(27)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const done = path.join(dir, 'c.done')
if (fs.existsSync(path.join(dir, 'wait-for-c'))) {
  // The marker alone is not enough: under load a teardown outlasts a margin, so c's process must be gone too.
  const deadline = Date.now() + 120000
  while (!fs.existsSync(done) && Date.now() < deadline) await sleep(100)
  const cPid = fs.existsSync(done) ? Number.parseInt(fs.readFileSync(done, 'utf8'), 10) : 0
  while (cPid && alive(cPid) && Date.now() < deadline) await sleep(100)
  if (Date.now() >= deadline) console.log('BARRIER TIMEOUT — c-pass never finished')
}
if (fs.existsSync(path.join(dir, 'a-sleep'))) await sleep(2000)
console.log('PASS [a body ' + ko + ']')
console.log('SKIP [a skip ' + ko + '] reported, not silent')
console.log('WARN [a warn] re-review trigger, suite still passes')
console.log('FAIL [a stray] printed by a passing suite')
console.log('KEEP [a keep] fixture kept')
process.stdout.write(esc + '[33mSKIP [ansi] coloured skip' + esc + '[0m\\n')
console.log('   SKIP indented-not-a-signal')
console.log('BODY-MARKER-A')
`
const runDir = tree({
  name: 'run',
  suites: {
    'a-slow.selftest.mjs': aSlow,
    'b-fail.selftest.mjs': "console.log('PASS [b one]')\nconsole.log('FAIL [b two]: broken on purpose')\nconsole.error('b stderr line')\nprocess.exit(1)\n",
    'c-pass.selftest.mjs': "import fs from 'node:fs'\nimport path from 'node:path'\nimport { fileURLToPath } from 'node:url'\nconsole.log('PASS [c one]')\nconsole.log('PASS [c two]')\nconsole.log('BODY-MARKER-C')\nfs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'c.done'), String(process.pid))\n",
  },
})
const setFlag = (name, on) => { const p = path.join(runDir, name); if (on) writeFileSync(p, 'on'); else rmSync(p, { force: true }) }
const setBarrier = (on) => { rmSync(path.join(runDir, 'c.done'), { force: true }); setFlag('wait-for-c', on) }
const summary = 'selftests: discovered=3 passed=2 failed=1'
let g1
test('G1 concurrent run: exit 1 naming the failed suite; failed body in full, passing suites one line each, SKIP line kept with Korean intact', () => {
  setBarrier(true)
  setFlag('a-sleep', true)
  g1 = run(runDir, '--jobs=3')
  check(g1, 1, {
    mustMatch: [new RegExp(esc(summary), 'u'), /FAIL — b-fail\.selftest\.mjs/u, /jobs=3\b/u, /PASS {2}stub manifest gate/u,
      /workflow-gates\.mjs: this plugin ships no workflow, so the corpus gate has nothing to run/u,
      /^--- b-fail\.selftest\.mjs FAIL \(exit 1, 1 PASS lines/mu, /^PASS \[b one\]/mu, /^FAIL \[b two\]: broken on purpose/mu, /b stderr line/u,
      /^ok {3}a-slow\.selftest\.mjs \(1 PASS lines, /mu, /^ok {3}c-pass\.selftest\.mjs \(2 PASS lines, /mu,
      new RegExp(`^SKIP \\[a skip ${KO}\\] reported, not silent`, 'mu'), /^timing: suites wall-clock /mu],
    mustNotMatch: [/all gates green/u, /BODY-MARKER-A/u, /BODY-MARKER-C/u, /^PASS \[c one\]/mu, /^PASS \[a body/mu, /BARRIER TIMEOUT/u, /^--- (a-slow|c-pass)/mu] })
})
test('G2 results in discovery order (a, b, c) although c finished before a', () => {
  const dA = lineIndex(g1.out, /^done a-slow\.selftest\.mjs PASS \(/u)
  const dC = lineIndex(g1.out, /^done c-pass\.selftest\.mjs PASS \(/u)
  const rA = lineIndex(g1.out, /^ok {3}a-slow/u)
  const rB = lineIndex(g1.out, /^--- b-fail/u)
  const rC = lineIndex(g1.out, /^ok {3}c-pass/u)
  assert.ok(dA >= 0 && dC >= 0 && dC < dA && rA > dA && rA < rB && rB < rC, `done a=${dA} c=${dC} · results a=${rA} b=${rB} c=${rC}\n${g1.out}`)
})
// Condensing keeps the signal lines of a passing suite, ANSI-wrapped ones on their plain text (ywr-harness ADR 0088).
test('G1c passing suite condensed: its WARN, FAIL, KEEP and ANSI-wrapped SKIP lines are kept', () => {
  check(g1, 1, {
    mustMatch: [/^WARN \[a warn\] re-review trigger/mu, /^FAIL \[a stray\] printed by a passing suite/mu, /^KEEP \[a keep\] fixture kept/mu, /^SKIP \[ansi\] coloured skip$/mu],
    mustNotMatch: [/BODY-MARKER-A/u, /^PASS \[a body/mu, /^--- a-slow/mu, /\[runner\]/u, /indented-not-a-signal/u] })
})
test("G1d the kept lines sit between their suite's ok line and the next result", () => {
  const rA = lineIndex(g1.out, /^ok {3}a-slow/u)
  const rB = lineIndex(g1.out, /^--- b-fail/u)
  const kept = [/^SKIP \[a skip/u, /^WARN \[a warn\]/u, /^FAIL \[a stray\]/u, /^KEEP \[a keep\]/u, /^SKIP \[ansi\]/u].map((rx) => lineIndex(g1.out, rx))
  assert.ok(rA >= 0 && kept.every((k) => k > rA && k < rB), `ok a=${rA} · kept=${kept.join(',')} · next=${rB}\n${g1.out}`)
})
// --jobs=1 is serial: a-slow sleeps, so any overlap would let b and c finish first.
let g3
test('G3 --jobs=1: same summary and failed-suite line as the concurrent run', () => {
  setBarrier(false)
  g3 = run(runDir, '--jobs=1')
  check(g3, 1, {
    mustMatch: [new RegExp(esc(summary), 'u'), /FAIL — b-fail\.selftest\.mjs/u, /jobs=1\b/u, new RegExp(`^SKIP \\[a skip ${KO}\\]`, 'mu')],
    mustNotMatch: [/all gates green/u, /BODY-MARKER-A/u, /BODY-MARKER-C/u] })
})
test('G3b --jobs=1 runs one suite at a time (done lines in discovery order)', () => {
  const s = ['a-slow', 'b-fail', 'c-pass'].map((n) => lineIndex(g3.out, new RegExp(`^done ${n}`, 'u')))
  assert.ok(s[0] >= 0 && s[0] < s[1] && s[1] < s[2], `done a=${s[0]} b=${s[1]} c=${s[2]}\n${g3.out}`)
})
// --full prints every body; the default slot count is min(CPUs, 8).
test('G4 --full prints every suite\'s body; the default is jobs=min(CPUs, 8)', () => {
  setFlag('a-sleep', false)
  const defJobs = Math.min(availableParallelism(), 8)
  check(run(runDir, '--full'), 1, {
    mustMatch: [new RegExp(esc(summary), 'u'), new RegExp(`jobs=${defJobs}\\b`, 'u'), /BODY-MARKER-A/u, /BODY-MARKER-C/u, /^PASS \[c one\]/mu,
      new RegExp(`^PASS \\[a body ${KO}\\]`, 'mu'), /^--- a-slow\.selftest\.mjs PASS \(exit 0, 1 PASS lines, /mu, /^--- c-pass\.selftest\.mjs PASS \(exit 0, 2 PASS lines, /mu],
    mustNotMatch: [/^ok {3}/mu, /all gates green/u] })
})
test('G5 --shard 3/3 --jobs=2: c-pass alone, the gate still runs, green', () => {
  check(run(runDir, '--shard=3/3', '--jobs=2'), 0, {
    mustMatch: [/selftests: discovered=3 shard=3\/3 selected=1 passed=1 failed=0/u, /all gates green \(shard 3\/3\)/u, /PASS {2}stub manifest gate/u, /^ok {3}c-pass\.selftest\.mjs/mu],
    mustNotMatch: [/done a-slow/u, /done b-fail/u, /^FAIL/mu, /FAIL —/u] })
})

// G8: a hung suite is killed with its tree (ywr-harness ADR 0098). An attempt whose kill beat the ready marker is discarded and the next limit runs; G8F forces the first miss.
const hangDir = tree({ name: 'hang', suites: { 'h-hang.selftest.mjs': '', 'p-ok.selftest.mjs': "console.log('PASS [p one]')\n" } })
const hangPort = path.join(hangDir, 'holder.port')
write(hangDir, 'h-hang.selftest.mjs', `import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = path.dirname(fileURLToPath(import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (fs.existsSync(path.join(dir, 'hold'))) await sleep(300000)
${holderStart(hangPort, "{ stdio: 'inherit' }")}console.log('PASS [h before the hang]')
fs.writeFileSync(path.join(dir, 'ready'), '1')
await sleep(300000)
`)
const g8p = (async () => {
  let forced = null
  let judged = null
  for (const attempt of [{ limit: 1, hold: true }, { limit: 8, hold: false }, { limit: 20, hold: false }]) {
    for (const f of ['holder.port', 'ready', 'hold']) rmSync(path.join(hangDir, f), { force: true })
    if (attempt.hold) writeFileSync(path.join(hangDir, 'hold'), '1')
    const t0 = Date.now()
    const r = await start(hangDir, ['--jobs=2', `--suite-timeout=${attempt.limit}`])
    const wall = (Date.now() - t0) / 1000
    const h = readHolder(hangPort)
    const gcAlive = h ? await portAlive(h.port) : false
    const ready = existsSync(path.join(hangDir, 'ready'))
    stopHolder(h)
    if (attempt.hold) { forced = { r, ready, gcRead: Boolean(h) }; continue }
    judged = { r, h, gcRead: Boolean(h), gcAlive, ready, wall, limit: attempt.limit }
    if (ready) break
  }
  return { forced, judged }
})()
test('G8F the forced 1 s miss is discarded: killed before ready and before any spawn, and the judged attempt ran after it', async () => {
  const { forced, judged } = await g8p
  assert.ok(!forced.ready && !forced.gcRead && /exceeded --suite-timeout 1 s/u.test(forced.r.out) && judged.limit >= 8,
    `forced ready=${forced.ready} holder written=${forced.gcRead} judged limit=${judged.limit}\n${forced.r.out}`)
})
test('G8 a hung suite is killed at --suite-timeout and counted FAILED; the suite beside it still reports', async () => {
  const { judged } = await g8p
  check(judged.r, 1, {
    mustMatch: [/selftests: discovered=2 passed=1 failed=1/u, /FAIL — h-hang\.selftest\.mjs/u, /^done h-hang\.selftest\.mjs FAIL \(/mu,
      new RegExp(`exceeded --suite-timeout ${judged.limit} s and was killed with its process tree`, 'u'), /^PASS \[h before the hang\]/mu, /^ok {3}p-ok\.selftest\.mjs/mu],
    mustNotMatch: [/all gates green/u, /^--- p-ok/mu] })
})
test("G8b the hung suite's grandchild died with it, and the run ended well before the stub's 300 s", async () => {
  const { judged } = await g8p
  assert.ok(judged.ready && judged.gcRead && !judged.gcAlive && judged.wall < 120,
    `stub ready before the kill=${judged.ready} (false: the limit fired mid-spawn, so load and not the kill) · holder read=${judged.gcRead} alive=${judged.gcAlive} · wall ${Math.round(judged.wall)} s\n${judged.r.out}`)
})

test('G10 a held pipe after exit: the suite is ok with its own line and a held-pipe WARN; the caller\'s pipe reaches end-of-file', async () => {
  const g10 = await g10p
  check(g10, 0, {
    mustMatch: [/^ok {3}b-held\.selftest\.mjs/mu, /^WARN \[b\] written before exit/mu, /all gates green/u,
      new RegExp(`^WARN \\[runner\\] this suite exited, but a process it started still held its output pipe ${g10.limit} s later`, 'mu')],
    mustNotMatch: [/still running 30 s after the kill/u, /the runner could not run this suite/u, /^FAIL/mu],
    preFail: [!g10.h && 'the suite never started its holder, so the case set up no pipe holder', g10.killed && 'the runner was still running 120 s after it started',
      !g10.eof && "the runner's output did not reach end-of-file 10 s after its exit: the grandchild held the caller's pipe",
      g10.eof && g10.h && !g10.alive && "the grandchild was gone at end-of-file, so the case proves nothing about the caller's pipe"].filter(Boolean) })
})

// G11 runs off Windows only: there process.kill runs no signal handler (spec 0008 §5).
test('G11 a signal while a gate runs ends the gate, and the runner names the signal', { skip: process.platform === 'win32' ? 'Windows: process.kill runs no signal handler; the Linux parity run covers G11' : false }, async () => {
  const dir = tree({ name: 'gate-signal', suites: { 'a.selftest.mjs': passing('A') } })
  const portFile = path.join(dir, 'gate.port')
  write(dir, 'manifest-gate.mjs', `import fs from 'node:fs'
import net from 'node:net'
const s = net.createServer(() => {})
s.listen(0, '127.0.0.1', () => { fs.writeFileSync(${JSON.stringify(portFile)}, process.pid + ' ' + s.address().port) })
setTimeout(() => {}, 300000)
`)
  const child = spawn(process.execPath, [path.join(dir, 'selftest.mjs'), '--jobs=1'], { env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  for (const s of [child.stdout, child.stderr]) { s.setEncoding('utf8'); s.on('data', (d) => { out += d }) }
  const exitP = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
  let h = null
  for (let i = 0; i < 1200 && !h; i++) { h = readHolder(portFile); if (!h) await sleep(50) }
  if (!h) { child.kill('SIGKILL'); assert.fail(`the stub gate never wrote its port in 60 s\n${out}`) }
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
  const ended = await exitP
  clearTimeout(timer)
  let gateAlive = true
  for (let i = 0; i < 100 && gateAlive; i++) { gateAlive = await portAlive(h.port); if (gateAlive) await sleep(100) }
  assert.ok(ended.signal === 'SIGTERM' && /selftest: stopped by SIGTERM; ending the running child processes/u.test(out) && !gateAlive && !/--- suites:/u.test(out),
    `runner exit=${ended.code} signal=${ended.signal} · gate alive 10 s after the runner ended=${gateAlive}\n${out}`)
})

// --- H. the read-set map and --changed (ADR 0157) ----------------------------------------------------------------
// A git fixture in the canon shape: the runner sits in plug/, so the / globs are live. Real runs: H3, H12, H12b, H17.
const selDir = tree({
  name: 'select/plug', gate: 'pass', map: null,
  suites: {
    's-a.selftest.mjs': "import fs from 'node:fs'\nimport path from 'node:path'\nimport { fileURLToPath } from 'node:url'\nconst dir = path.dirname(fileURLToPath(import.meta.url))\nif (fs.existsSync(path.join(dir, '../edit-during'))) fs.writeFileSync(path.join(dir, 'a.txt'), 'a during\\n')\nconsole.log('PASS [s-a]')\n",
    's-b.selftest.mjs': "console.log('PASS [s-b]')\n",
  },
  files: { 'a.txt': 'a.txt\n', 'b.txt': 'b.txt\n', 'shared.txt': 'shared.txt\n', 'doc.txt': 'doc.txt\n', 'ver.json': '{\n  "name": "stub",\n  "version": "1.0.0"\n}\n' },
})
const fxSel = path.dirname(selDir)
write(fxSel, 'outside.txt', 'outside\n')
const selMapPath = path.join(selDir, 'selftest-reads.json')
const selMap = `{
  "//": "fixture map",
  "full": ["shared.txt", "selftest.mjs", "selftest-reads.json", "lib/**", "scripts/**"],
  "none": ["doc.txt", "manifest-gate.mjs"],
  "version_only": ["ver.json"],
  "suites": {
    "//s-a.selftest.mjs": "a comment key is not a suite",
    "s-a.selftest.mjs": ["a.txt"],
    "s-b.selftest.mjs": ["b.txt", "ver.json", "/outside.txt"]
  }
}
`
writeFileSync(selMapPath, selMap)
const selGit = (...args) => {
  const r = git_result(fxSel, ['-c', 'core.autocrlf=false', '-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', '-c', 'commit.gpgsign=false', ...args])
  if (r.status !== 0) throw new Error(`selection fixture: git ${args.join(' ')} failed: ${r.stdout}${r.stderr}`)
  return r.stdout.trim()
}
selGit('init', '-q', '--template=')
selGit('add', '-A')
selGit('commit', '-q', '-m', 'fixture')
const selRunner = selDir
const recordPath = path.join(selGit('rev-parse', '--path-format=absolute', '--git-common-dir'), 'ywr-harness', 'selftest-full-run.json')
const timesFile = path.join(path.dirname(recordPath), 'selftest-times.json')
const resetSel = () => { selGit('checkout', '-q', '--', '.'); selGit('clean', '-q', '-f') }
const setSelText = (rel, text) => writeFileSync(path.join(fxSel, ...rel.split('/')), text)
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)
const hashOf = (rel) => selGit('hash-object', '--', rel)
const sel = (...argv) => run(selRunner, ...argv)

test('H1 --changed on a clean tree is a full run: the change is empty, so a selection would be empty', () => {
  check(sel('--changed', '--list'), 0, { mustMatch: [/selection: FULL RUN — the change is empty/u, /^ {2}- s-a\.selftest\.mjs$/mu, /^ {2}- s-b\.selftest\.mjs$/mu, /LIST ONLY/u], mustNotMatch: [/FAIL — read-set map/u, /by read set/u] })
})
test('H2 --changed with no recorded full run is a full run that names the record', () => {
  setSelText('plug/a.txt', 'a changed\n')
  check(sel('--changed', '--list'), 0, {
    mustMatch: [/changed: 1 file\(s\) since HEAD, working tree included/u, /^ {2}\* a\.txt/mu, /selection: FULL RUN — no green full run is recorded in this clone/u, /^ {2}- s-b\.selftest\.mjs$/mu],
    mustNotMatch: [/by read set/u, /^FAIL —/mu] })
})
let h3
test('H3 a green full run writes the record: UTC time, HEAD, tool series, and the content it tested of each dirty path', () => {
  h3 = sel('--jobs=2')
  const rec = readJson(recordPath)
  const bad = !rec || rec.head !== selGit('rev-parse', 'HEAD') || !rec.utc || !rec.series || !rec.series.node || !rec.series.git || !rec.series.os || !rec.dirty || rec.dirty['plug/a.txt'] !== hashOf('plug/a.txt')
  check(h3, 0, { mustMatch: [/all gates green/u, /full-run record: /u, /selftests: discovered=2 passed=2 failed=0/u],
    mustNotMatch: [/^FAIL/mu, /selected gates/u, /selected=/u, /WARN \[runner\] the full-run record/u],
    preFail: bad ? [`record missing or wrong: ${rec ? JSON.stringify(rec) : 'absent'}`] : [] })
})
// H19: the times file sits beside the record (ywr-harness ADR 0161).
test('H19 the first run in a clone starts in discovery order, says why, and records each suite\'s time', () => {
  const t3 = readJson(timesFile)
  const timesBad = !t3 || !t3.utc || typeof t3.seconds !== 'object' || Object.keys(t3.seconds).length !== 2 || !['s-a.selftest.mjs', 's-b.selftest.mjs'].every((k) => typeof t3.seconds[k] === 'number')
  check(h3, 0, { mustMatch: [/--- suites: 2 selected, jobs=2, start order: discovery order \(no suite time is recorded in this clone\)/u], mustNotMatch: [/longest first/u, /WARN \[runner\] the suite times/u],
    preFail: timesBad ? [`times file missing or wrong: ${t3 ? JSON.stringify(t3) : 'absent'}`] : [] })
})
test('H3b a dirty path that still holds the content the full run tested drops out of the change', () => {
  check(sel('--changed', '--list'), 0, { mustMatch: [/changed: 0 file\(s\) since the last full run \([0-9a-f]{7}\), working tree included/u, /selection: FULL RUN — the change is empty/u], mustNotMatch: [/^ {2}\* a\.txt/mu, /by read set/u] })
})
test('H3c reverting a path the full run saw dirty is a change', () => {
  resetSel()
  check(sel('--changed', '--list'), 0, { mustMatch: [/^ {2}\* a\.txt/mu, /selection: 1 of 2 suites by read set/u, /^ {2}- s-a\.selftest\.mjs$/mu], mustNotMatch: [/^ {2}- s-b/mu, /selection: FULL RUN/u] })
})
test('H4 a changed file selects exactly the suites whose read set names it', () => {
  setSelText('plug/a.txt', 'a changed again\n')
  check(sel('--changed', '--list'), 0, {
    mustMatch: [/selection: 1 of 2 suites by read set \(last full run [\d.]+ days and 0 plugin commit\(s\) ago, same tools\)/u, /^ {2}- s-a\.selftest\.mjs$/mu, /suites: discovered=2 selected=1/u],
    mustNotMatch: [/^ {2}- s-b/mu, /selection: FULL RUN/u] })
})
test('H5 a repo file outside the plugin selects through a / glob', () => {
  setSelText('outside.txt', 'outside changed\n')
  check(sel('--changed', '--list'), 0, { mustMatch: [/^ {2}\* \/outside\.txt/mu, /selection: 2 of 2 suites by read set/u, /^ {2}- s-b\.selftest\.mjs$/mu], mustNotMatch: [/selection: FULL RUN/u, /^FAIL/mu] })
})
let recText = ''
test('H12b selecting every suite by read set is a full run: it says all gates green and refreshes the record', () => {
  const h12 = sel('--changed', '--jobs=2')
  recText = existsSync(recordPath) ? readFileSync(recordPath, 'utf8') : ''
  check(h12, 0, { mustMatch: [/selection: 2 of 2 suites by read set/u, /all gates green/u, /full-run record: /u], mustNotMatch: [/NOT a full run/u, /selected=/u] })
})
let t12b
let h12s
test('H12 a selected run runs only its selection, says NOT a full run, and leaves the record alone', () => {
  // outside.txt keeps the content H12b tested, so only a.txt moves on.
  setSelText('plug/a.txt', 'a third\n')
  t12b = readJson(timesFile)
  h12s = sel('--changed', '--jobs=2')
  const recAfter = existsSync(recordPath) ? readFileSync(recordPath, 'utf8') : ''
  check(h12s, 0, { mustMatch: [/selected gates green — 1 of 2 suites by read set, NOT a full run/u, /selftests: discovered=2 selected=1 passed=1 failed=0/u, /^ok {3}s-a\.selftest\.mjs/mu, /PASS {2}stub manifest gate/u],
    mustNotMatch: [/all gates green/u, /done s-b/u, /full-run record:/u, /^ {2}\* \/outside\.txt/mu],
    preFail: recAfter === recText ? [] : ['the selected run rewrote the full-run record'] })
})
test('H19b a selected run orders by recorded time, rewrites its own suite\'s time and keeps the other', () => {
  const t12s = readJson(timesFile)
  const bad = !t12b || !t12s || t12s.utc === t12b.utc || Object.keys(t12s.seconds).length !== 2 || `${t12s.seconds['s-b.selftest.mjs']}` !== `${t12b.seconds['s-b.selftest.mjs']}` || t12s.seconds['s-a.selftest.mjs'] === undefined
  check(h12s, 0, { mustMatch: [/--- suites: 1 selected, jobs=2, start order: longest first by recorded time \(1 of 1 suites timed\)/u], mustNotMatch: [/start order: discovery/u, /WARN \[runner\] the suite times/u],
    preFail: bad ? [`before: ${t12b ? JSON.stringify(t12b) : 'absent'} after: ${t12s ? JSON.stringify(t12s) : 'absent'}`] : [] })
})
// The cases below start from a written record, not a full run.
function setSelRecord(dirty) {
  const r = readJson(recordPath)
  r.head = selGit('rev-parse', 'HEAD')
  r.utc = new Date().toISOString()
  r.dirty = dirty
  writeFileSync(recordPath, JSON.stringify(r, null, 2))
}
test('H13 --base adds its own change: HEAD~1 brings back b.txt, which the full run already tested', () => {
  resetSel()
  setSelText('plug/b.txt', 'b pre\n')
  selGit('commit', '-q', '-am', 'b pre')
  setSelRecord({})
  check(sel('--changed', '--base=HEAD~1', '--list'), 0, {
    mustMatch: [/changed: 1 file\(s\) since the last full run \([0-9a-f]{7}\) and HEAD~1, working tree included/u, /^ {2}\* b\.txt/mu, /selection: 1 of 2 suites by read set/u, /^ {2}- s-b/mu],
    mustNotMatch: [/^ {2}- s-a/mu, /selection: FULL RUN/u] })
})
test('H13b without --base the same clean tree is an empty change', () => {
  check(sel('--changed', '--list'), 0, { mustMatch: [/selection: FULL RUN — the change is empty/u], mustNotMatch: [/by read set/u, /^ {2}\* b\.txt/mu] })
})
test('H6 a file no suite reads selects nothing', () => {
  setSelText('plug/doc.txt', 'doc changed\n')
  check(sel('--changed', '--list'), 0, { mustMatch: [/selection: 0 of 2 suites by read set/u, /suites: discovered=2 selected=0/u], mustNotMatch: [/^ {2}- /mu, /selection: FULL RUN/u] })
})
test('H7 a version_only file whose diff changes only the version line selects nothing', () => {
  resetSel()
  setSelText('plug/ver.json', '{\n  "name": "stub",\n  "version": "1.0.1"\n}\n')
  check(sel('--changed', '--list'), 0, { mustMatch: [/^ {2}\* ver\.json \(version line only: selects no suite\)/mu, /selection: 0 of 2 suites by read set/u], mustNotMatch: [/^ {2}- /mu, /selection: FULL RUN/u] })
})
test('H7b any other changed line in a version_only file selects as usual', () => {
  setSelText('plug/ver.json', '{\n  "name": "stub2",\n  "version": "1.0.1"\n}\n')
  check(sel('--changed', '--list'), 0, { mustMatch: [/selection: 1 of 2 suites by read set/u, /^ {2}- s-b\.selftest\.mjs$/mu], mustNotMatch: [/version line only/u, /^ {2}- s-a/mu, /selection: FULL RUN/u] })
})
test('H8 a full input changes: a full run that names it', () => {
  resetSel()
  setSelText('plug/shared.txt', 'shared changed\n')
  check(sel('--changed', '--list'), 0, { mustMatch: [/selection: FULL RUN — a shared input changed: shared\.txt/u, /^ {2}- s-a/mu, /^ {2}- s-b/mu], mustNotMatch: [/by read set/u, /^FAIL/mu] })
})
test('H9 an untracked file no glob claims fails the map check; --changed does not select around it', () => {
  resetSel()
  setSelText('plug/new.txt', 'new\n')
  check(sel('--changed', '--list'), 1, { mustMatch: [/FAIL — read-set map: 'new\.txt' is claimed by no suite, no full glob and no none glob/u, /selection: FULL RUN — the read-set map failed its check/u], mustNotMatch: [/by read set/u, /all gates green/u] })
})
// H10: the record's guards, each by one mutation of a copy of the record, restored after each.
const recCases = [
  { id: 'H10a', what: 'a tool version differs from the record', edit: (r) => { r.series.node = '0.0.0' }, rx: /FULL RUN — a tool changed since the last full run: node 0\.0\.0 -> / },
  { id: 'H10b', what: 'the record is older than the 7-day window', edit: (r) => { r.utc = new Date(Date.now() - 8 * 86400000).toISOString() }, rx: /FULL RUN — the last full run is 8(\.\d)? days old \(window 7 days\)/ },
  { id: 'H10c', what: "the record's HEAD is not an ancestor", edit: (r) => { r.head = '0'.repeat(40) }, rx: /FULL RUN — the last full run's HEAD 0{40} is not an ancestor of HEAD/ },
  { id: 'H10e', what: "the record's time lies in the future", edit: (r) => { r.utc = new Date(Date.now() + 2 * 86400000).toISOString() }, rx: /FULL RUN — the recorded full run has an unreadable or future time/ },
  { id: 'H10f', what: 'the record has no dirty map', edit: (r) => { delete r.dirty }, rx: /FULL RUN — no green full run is recorded/ },
  { id: 'H10d', what: 'the record does not parse', edit: null, rx: /FULL RUN — no green full run is recorded/ },
]
let recGood = ''
for (const rc of recCases) {
  test(`${rc.id} a full run when ${rc.what}`, () => {
    if (!recGood) { resetSel(); setSelText('plug/a.txt', 'a changed\n'); recGood = readFileSync(recordPath, 'utf8') }
    if (rc.edit) { const r = JSON.parse(recGood); rc.edit(r); writeFileSync(recordPath, JSON.stringify(r, null, 2)) } else writeFileSync(recordPath, '{ not json')
    try { check(sel('--changed', '--list'), 0, { mustMatch: [rc.rx], mustNotMatch: [/by read set/u, /^FAIL/mu] }) } finally { writeFileSync(recordPath, recGood) }
  })
}
// H16: a commit made after the full run is part of the change, though the tree is clean against HEAD.
test('H16 a commit since the full run selects its suites on a clean tree', () => {
  resetSel()
  setSelText('plug/b.txt', 'b post\n')
  selGit('commit', '-q', '-am', 'b post')
  check(sel('--changed', '--list'), 0, { mustMatch: [/^ {2}\* b\.txt/mu, /selection: 1 of 2 suites by read set \(last full run [\d.]+ days and 1 plugin commit\(s\) ago/u, /^ {2}- s-b/mu], mustNotMatch: [/^ {2}- s-a/mu, /selection: FULL RUN/u] })
})
test('H11 five plugin commits since the record force a full run', () => {
  for (const i of [2, 3, 4, 5]) { setSelText('plug/doc.txt', `doc ${i}\n`); selGit('commit', '-q', '-am', `doc ${i}`) }
  setSelText('plug/a.txt', 'a again\n')
  check(sel('--changed', '--list'), 0, { mustMatch: [/selection: FULL RUN — 5 plugin commits since the last full run \(window 5\)/u], mustNotMatch: [/by read set/u, /^FAIL/mu] })
})
// H17: the record holds what the suites tested: s-a edits a.txt during a full run, and that edit is a change afterwards.
test('H17 an edit made during the full run stays a change: a.txt selects s-a beside the b.txt change', () => {
  resetSel()
  const mark = path.join(fxSel, 'edit-during')
  writeFileSync(mark, '1')
  const h17 = sel('--jobs=2')
  rmSync(mark, { force: true })
  setSelText('plug/b.txt', 'b after\n')
  check(sel('--changed', '--list'), 0, { mustMatch: [/^ {2}\* a\.txt/mu, /^ {2}\* b\.txt/mu, /selection: 2 of 2 suites by read set/u], mustNotMatch: [/selection: FULL RUN/u, /^FAIL/mu],
    preFail: h17.code === 0 && /full-run record: /u.test(h17.out) ? [] : [`the H17 full run did not write a record (exit ${h17.code})`] })
})
// H18: a version_only file that was dirty at the full run gets no exemption.
test('H18 a version_only file the full run saw dirty selects when it moves on, even to a version-only diff', () => {
  resetSel()
  setSelText('plug/ver.json', '{\n  "name": "stub3",\n  "version": "1.0.2"\n}\n')
  setSelRecord({ 'plug/ver.json': hashOf('plug/ver.json') })
  setSelText('plug/ver.json', '{\n  "name": "stub",\n  "version": "1.0.2"\n}\n')
  check(sel('--changed', '--list'), 0, { mustMatch: [/^ {2}\* ver\.json/mu, /selection: 1 of 2 suites by read set/u, /^ {2}- s-b/mu], mustNotMatch: [/version line only/u, /selection: FULL RUN/u, /^ {2}- s-a/mu] })
})
test('H14 --changed with --shard is refused', () => {
  resetSel()
  check(sel('--changed', '--shard=1/2', '--list'), 1, { mustMatch: [/FAIL — --changed and --shard do not combine/u], mustNotMatch: [/LIST ONLY/u, /suites: discovered/u] })
})
test('H14b --base without --changed is refused', () => {
  check(sel('--base=HEAD', '--list'), 1, { mustMatch: [/FAIL — --base needs --changed/u], mustNotMatch: [/LIST ONLY/u, /suites: discovered/u] })
})
test('H14c a --base that names no commit is refused', () => {
  check(sel('--changed', '--base=no-such-ref', '--list'), 1, { mustMatch: [/FAIL — --base does not name a commit: no-such-ref/u], mustNotMatch: [/LIST ONLY/u, /suites: discovered/u] })
})
// H15: the map check, one defect per case, on --list (no --changed): each fails the run with its reason.
const mapCases = [
  { id: 'H15a', what: 'a glob that matches no file', text: selMap.replace('["a.txt"]', '["a.txt", "zzz.txt"]'), rx: /suites\['s-a\.selftest\.mjs'\] glob 'zzz\.txt' matches no file/ },
  { id: 'H15b', what: 'a / glob that matches no repo file', text: selMap.replace('"/outside.txt"', '"/nope.txt"'), rx: /suites\['s-b\.selftest\.mjs'\] glob '\/nope\.txt' matches no file/ },
  { id: 'H15c', what: 'a suite with no read set', text: selMap.replace('"s-b.selftest.mjs": ["b.txt", "ver.json", "/outside.txt"]', '"x": []'), rx: /suite 's-b\.selftest\.mjs' has no read set/ },
  { id: 'H15d', what: 'an entry for no discovered suite', text: selMap.replace('"s-a.selftest.mjs": ["a.txt"],', '"s-a.selftest.mjs": ["a.txt"], "s-c.selftest.mjs": [],'), rx: /suites names 's-c\.selftest\.mjs', which is not a discovered suite/ },
  { id: 'H15e', what: 'a map that does not parse', text: '{ "full": [', rx: /selftest-reads\.json does not parse/ },
  { id: 'H15f', what: 'a missing map', text: null, rx: /selftest-reads\.json is missing/ },
]
for (const mc of mapCases) {
  test(`${mc.id} the map check fails the run on ${mc.what}`, () => {
    if (mc.text === null) rmSync(selMapPath, { force: true }); else writeFileSync(selMapPath, mc.text)
    try { check(sel('--list'), 1, { mustMatch: [new RegExp(`FAIL — read-set map: ${mc.rx.source}`, 'u')], mustNotMatch: [/all gates green/u, /by read set/u] }) } finally { writeFileSync(selMapPath, selMap) }
  })
}
// H20: the start order (ADR 0161) from a written times file, on --list. Discovery order is s-a, s-b. Each case states its slots.
const orderCases = [
  { id: 'H20', what: 'the longest recorded suite starts first', jobs: '2', text: '{"seconds": {"s-a.selftest.mjs": 1, "s-b.selftest.mjs": 50.5}}', rx: 'longest first by recorded time \\(2 of 2 suites timed\\) — s-b\\.selftest\\.mjs, s-a\\.selftest\\.mjs', not: /start order: discovery/u },
  { id: 'H20b', what: 'an untimed suite starts before every timed one, and an undiscovered name counts for nothing', jobs: '2', text: '{"seconds": {"s-a.selftest.mjs": 50, "gone.selftest.mjs": 99}}', rx: 'longest first by recorded time \\(1 of 2 suites timed\\) — s-b\\.selftest\\.mjs, s-a\\.selftest\\.mjs', not: /start order: discovery/u },
  { id: 'H20c', what: 'equal times keep discovery order', jobs: '2', text: '{"seconds": {"s-a.selftest.mjs": 5, "s-b.selftest.mjs": 5}}', rx: 'longest first by recorded time \\(2 of 2 suites timed\\) — s-a\\.selftest\\.mjs, s-b\\.selftest\\.mjs', not: /start order: discovery/u },
  { id: 'H20d', what: '--jobs=1 keeps discovery order', jobs: '1', text: '{"seconds": {"s-a.selftest.mjs": 1, "s-b.selftest.mjs": 50}}', rx: 'discovery order \\(--jobs 1\\) — s-a\\.selftest\\.mjs, s-b\\.selftest\\.mjs', not: /longest first/u },
  { id: 'H20e', what: 'a times file that does not parse gives discovery order and says so', jobs: '2', text: '{ "seconds": ', rx: 'discovery order \\(the times file does not parse \\(.+\\)\\) — s-a\\.selftest\\.mjs, s-b\\.selftest\\.mjs', not: /longest first/u },
  { id: 'H20f', what: 'a negative, a boolean or a text time counts for nothing', jobs: '2', text: '{"seconds": {"s-a.selftest.mjs": true, "s-b.selftest.mjs": -1, "x": "9"}}', rx: 'discovery order \\(no suite time is recorded in this clone\\) — s-a\\.selftest\\.mjs, s-b\\.selftest\\.mjs', not: /longest first/u },
  { id: 'H20h', what: 'an infinite time counts for nothing', jobs: '2', text: '{"seconds": {"s-a.selftest.mjs": 1e400, "s-b.selftest.mjs": 1}}', rx: 'longest first by recorded time \\(1 of 2 suites timed\\) — s-a\\.selftest\\.mjs, s-b\\.selftest\\.mjs', not: /start order: discovery/u },
]
for (const oc of orderCases) {
  test(`${oc.id} ${oc.what}`, () => {
    writeFileSync(timesFile, oc.text)
    check(sel('--list', `--jobs=${oc.jobs}`), 0, { mustMatch: [new RegExp(`^start order: ${oc.rx}\\r?$`, 'mu'), /LIST ONLY/u], mustNotMatch: [oc.not, /^FAIL/mu] })
  })
}
// H20i: no git start may carry --git-common-dir, because the runner reads the common dir from files (spec 0008 §3.1).
test("H20i a worktree of the clone orders by the clone's times file, found without a git process", () => {
  const wt = path.join(root, 'select-worktree')
  selGit('worktree', 'add', '-q', '--detach', wt, 'HEAD')
  writeFileSync(timesFile, '{"seconds": {"s-a.selftest.mjs": 1, "s-b.selftest.mjs": 50}}')
  const trace = path.join(root, 'h20i-git-trace.txt')
  const r = runNode([path.join(wt, 'plug', 'selftest.mjs'), '--list', '--jobs=2'], { env: childEnv({ GIT_TRACE2: trace }), timeoutMs: 120000 })
  const traceText = existsSync(trace) ? readFileSync(trace, 'utf8') : ''
  check({ out: r.stdout + r.stderr, code: r.status }, 0, {
    mustMatch: [/^start order: longest first by recorded time \(2 of 2 suites timed\) — s-b\.selftest\.mjs, s-a\.selftest\.mjs\r?$/mu], mustNotMatch: [/start order: discovery/u, /^FAIL/mu],
    preFail: [!/ls-files/u.test(traceText) && 'the GIT_TRACE2 log holds no ls-files start, so it proves nothing', /--git-common-dir/u.test(traceText) && 'the runner started git rev-parse --git-common-dir: the file path fell back'].filter(Boolean) })
})
test('H20g a tree outside git starts in discovery order and says no times are kept', () => {
  check(run(runDir, '--list', '--jobs=2'), 0, {
    mustMatch: [/^start order: discovery order \(not a git clone, so no suite times are kept\) — a-slow\.selftest\.mjs, b-fail\.selftest\.mjs, c-pass\.selftest\.mjs\r?$/mu], mustNotMatch: [/longest first/u, /^FAIL/mu] })
})
// H21: a file where the state dir goes makes the times write throw, and the run still prints its summary (ywr-harness ADR 0161).
test('H21 a failed run reaches the times write; a write that fails prints exactly one WARN line and the run goes on to its summary', () => {
  const dir = tree({ name: 'times-blocked', suites: { 'k-fail.selftest.mjs': "console.log('FAIL [k-fail] on purpose')\nprocess.exit(1)\n" } })
  assert.equal(git_result(dir, ['init', '-q', '--template=']).status, 0, 'times-blocked fixture: git init failed')
  writeFileSync(path.join(dir, '.git', 'ywr-harness'), 'a file where the state dir goes')
  const r = run(dir, '--jobs=2')
  const warns = [...r.out.matchAll(/^WARN \[runner\] the suite times were not written \(/gmu)].length
  check(r, 1, { mustMatch: [/selftests: discovered=1 passed=0 failed=1/u, /FAIL — k-fail\.selftest\.mjs/u], mustNotMatch: [/all gates green/u], preFail: warns === 1 ? [] : [`${warns} times WARN line(s), expected exactly 1`] })
})
// I5: a deleted tracked file needs no claim (spec 0008 §3.4). The stub map's none: ** would claim it, so the case has its own map.
test('I5 a tracked file deleted from disk needs no claim in the map', () => {
  const dir = tree({ name: 'deleted-tracked', suites: { 'q-pass.selftest.mjs': "console.log('PASS [q-pass]')\n" }, files: { 'gone.txt': 'claimed by no glob; deleted before the run' },
    map: JSON.stringify({ full: ['selftest.mjs', 'selftest-reads.json', 'lib/**', 'scripts/**'], none: ['manifest-gate.mjs'], suites: { 'q-pass.selftest.mjs': ['manifest-gate.mjs'] } }) })
  assert.equal(git_result(dir, ['init', '-q', '--template=']).status, 0)
  git_result(dir, ['add', '-A'])
  const c = git_result(dir, ['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'])
  assert.equal(c.status, 0, `deleted-tracked fixture: git commit failed: ${c.stderr}`)
  rmSync(path.join(dir, 'gone.txt'))
  check(run(dir, '--list'), 0, { mustMatch: [/^ {2}- q-pass\.selftest\.mjs$/mu, /LIST ONLY/u], mustNotMatch: [/read-set map/u, /gone\.txt/u] })
})
test('I3 Node suites run through the same suite process: a live done line, an ok line with the PASS-line count, a failed suite in full; one that runs no case fails; SKIP and WARN lines stay under the condensed line', async () => {
  const i3 = await i3p
  check(i3, 1, {
    mustMatch: [/selftests: discovered=4 passed=2 failed=2/u, /FAIL — m-empty\.selftest\.mjs, m-fail\.selftest\.mjs/u, /^FAIL — this Node suite exited 0 with no PASS or SKIP line, so no case ran/mu,
      /^done m-pass\.selftest\.mjs PASS \(/mu, /^ok {3}m-pass\.selftest\.mjs \(2 PASS lines, /mu, /^ok {3}a-pass\.selftest\.mjs \(1 PASS lines, /mu,
      /^--- m-fail\.selftest\.mjs FAIL \(exit 1, 1 PASS lines/mu, /^PASS \[F1 fine\]/mu, /^FAIL \[F2 broken on purpose\]: boom-detail/mu,
      new RegExp(`^SKIP \\[M3 skipped\\]: reported ${KO}`, 'mu'), /^WARN \[m warn\] re-review trigger from a Node suite/mu, /^WARN \[m outer\] 3\b/mu],
    mustNotMatch: [/all gates green/u, /^PASS \[M1/mu, /^PASS \[M2/mu, /the runner could not run this suite/u],
    preFail: i3.eof ? [] : ["the runner's output did not reach end-of-file 10 s after its exit"] })
})

// --- J and M: the --jobs bound and an empty glob list --------------------------------------------------------------
// J1: each suite gets min(jobs, suites) as YWR_SELFTEST_OUTER_JOBS (spec 0008 §3.9).
const outerProbe = (id) => `console.log('PASS [${id} ok]')\nconsole.log('WARN [${id} outer] ' + process.env.YWR_SELFTEST_OUTER_JOBS)\n`
test('J1 --jobs above the selected suites gives each suite the number of suites as YWR_SELFTEST_OUTER_JOBS', () => {
  const r = run(tree({ suites: { 'a.selftest.mjs': outerProbe('O1'), 'b.selftest.mjs': outerProbe('O2') } }), '--jobs=4')
  check(r, 0, { mustMatch: [/--- suites: 2 selected, jobs=4, /u, /^WARN \[O1 outer\] 2$/mu, /^WARN \[O2 outer\] 2$/mu], mustNotMatch: [/^WARN \[O\d outer\] 4$/mu, /^FAIL/mu] })
})
test('J1b one selected suite gets every CPU: YWR_SELFTEST_OUTER_JOBS is 1', () => {
  const r = run(tree({ suites: { 'a.selftest.mjs': outerProbe('O3'), 'b.selftest.mjs': outerProbe('O4') } }), '--jobs=3', '--shard=2/2')
  check(r, 0, { mustMatch: [/--- suites: 1 selected, jobs=3, /u, /^WARN \[O4 outer\] 1$/mu], mustNotMatch: [/^WARN \[O\d outer\] [23]$/mu, /^FAIL/mu] })
})
// M1: an empty glob list claims nothing, so only stray.txt is unclaimed (spec 0008 §3.4).
test('M1 an empty glob list claims no file: an unclaimed plugin file still fails the map check', () => {
  const dir = tree({ suites: { 'a.selftest.mjs': passing('A') }, files: { 'stray.txt': 'no glob claims this' },
    map: JSON.stringify({ full: ['selftest.mjs', 'selftest-reads.json', 'manifest-gate.mjs', 'lib/**', 'scripts/**'], none: [], suites: { 'a.selftest.mjs': [] } }) })
  const r = run(dir, '--list')
  const claims = [...r.out.matchAll(/^FAIL — read-set map: '([^']+)' is claimed by no suite/gmu)].map((m) => m[1])
  check(r, 1, { mustMatch: [/FAIL — read-set map: 'stray\.txt' is claimed by no suite, no full glob and no none glob/u], mustNotMatch: [/is not a list of non-empty strings/u, /all gates green/u],
    preFail: claims.length === 1 ? [] : [`${claims.length} unclaimed file(s) reported (${claims.join(', ')}), expected only stray.txt`] })
})

// --- G6: refusals before anything is listed or run ---------------------------------------------------------------
for (const bad of ['0', '-3']) {
  test(`G6 --jobs=${bad} refused`, () => {
    check(run(path.dirname(live), '--list', `--jobs=${bad}`), 1, { mustMatch: [/FAIL — --jobs must be a whole number >= 1/u, new RegExp(esc(`(got ${bad})`), 'u')], mustNotMatch: [/LIST ONLY/u, /suites: discovered/u] })
  })
}
for (const bad of ['0', '-3', '86401']) {
  test(`G6c --suite-timeout=${bad} refused`, () => {
    check(run(path.dirname(live), '--list', `--suite-timeout=${bad}`), 1, {
      mustMatch: [/FAIL — --suite-timeout must be a whole number of seconds from 1 to 86400/u, new RegExp(esc(`(got ${bad})`), 'u')], mustNotMatch: [/LIST ONLY/u, /suites: discovered/u] })
  })
}
test('G6b --list --jobs=2 --shard=1/2 lists and runs nothing', () => {
  check(run(path.dirname(live), '--list', '--jobs=2', '--shard=1/2'), 0, { mustMatch: [/LIST ONLY/u, /shard=1\/2 selected=\d+/u], mustNotMatch: [/--- manifest-gate\.mjs/u, /--- suites:/u, /all gates green/u] })
})

// G7: a failing assertMatch with a fake transcript, run under the real reporter, leaves no summary line at column 0.
test('G7 a failing case echoes a nested runner transcript indented: no second summary or green line at column 0', () => {
  const libUrl = new URL('./lib/selftest-lib.mjs', import.meta.url).href
  const probe = path.join(root, 'g7-probe.selftest.mjs')
  const transcript = 'suites: discovered=3 template-excluded=0\\nselftests: discovered=3 passed=3 failed=0\\nywr-harness plugin: all gates green\\n'
  writeFileSync(probe, `import test from 'node:test'\nimport { assertMatch } from ${JSON.stringify(libUrl)}\ntest('NESTED probe', () => { assertMatch('${transcript}', { mustMatch: [/never-present/u], mustNotMatch: [/never-present-either/u] }) })\n`)
  const r = runNode([`--test-reporter=${new URL('./lib/selftest-reporter.mjs', import.meta.url).href}`, '--test-reporter-destination=stdout', probe], { env: childEnv() })
  const col0 = (r.stdout + r.stderr).split(/\r?\n/u).filter((l) => /^\S/u.test(l))
  assert.ok(r.status !== 0 && col0.length >= 1 && col0[0].startsWith('FAIL [NESTED probe]') && !col0.some((l) => /^(selftests:|ywr-harness plugin:|suites:)/u.test(l)),
    `column-0 lines: ${col0.join(' | ')}\n${r.stdout}`)
})
// META: the empty-mustNotMatch guard fires through this file's wrapper.
test('META', () => {
  const none = problems({ out: 'meta probe', code: 0 }, 0, { mustMatch: [/meta probe/u], mustNotMatch: [] })
  assert.ok(none.length === 1 && /no mustNotMatch/u.test(none[0]), `guard failures: ${none.join('; ')}`)
})
// A stated noNegative reason is honored.
test('META exemption honored', () => {
  const stated = problems({ out: 'meta probe', code: 0 }, 0, { mustMatch: [/meta probe/u], mustNotMatch: [], noNegative: 'META: proves this wrapper forwards noNegative to the shared core' })
  assert.equal(stated.length, 0, stated.join('; '))
})

// --- NW1 to NW14: discovery, shard, jobs and refusal cases on small fixtures ---
test('NW1 zero discovered is exit 1, the gate does not run, and a templates/ payload is excluded, counted and rescues nothing', () => {
  const dir = tree({ map: null, files: { 'templates/p/payload.selftest.mjs': passing('P') }, gate: 'pass' })
  writeFileSync(path.join(dir, 'manifest-gate.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('./gate.ran', import.meta.url), '1')\n")
  check(run(dir), 1, { mustMatch: [/FAIL — no \*\.selftest\.mjs discovered/u, /empty set is not a pass/u, /template payload excluded: 1/u], mustNotMatch: [/LIST ONLY/u, /--- manifest-gate/u, /suites: discovered/u, /payload\.selftest\.mjs/u],
    preFail: existsSync(path.join(dir, 'gate.ran')) ? ['the gate ran on an empty discovery'] : [] })
})
test('NW1b zero discovered is exit 1 under --list too', () => {
  check(run(tree({ map: null }), '--list'), 1, { mustMatch: [/FAIL — no \*\.selftest\.mjs discovered/u, /template payload excluded: 0/u], mustNotMatch: [/LIST ONLY/u] })
})
test('NW2 a failed gate fails the run, and the suites still run', () => {
  const r = run(tree({ gate: 'fail', suites: { 'a.selftest.mjs': passing('A') } }))
  check(r, 1, { mustMatch: [/^--- manifest-gate\.mjs/mu, /^FAIL — stub gate failed/mu, /^ok {3}a\.selftest\.mjs \(1 PASS lines/mu, /selftests: discovered=1 passed=1 failed=0/u, /^FAIL — manifest-gate\.mjs\s*$/mu], mustNotMatch: [/all gates green/u] })
})
test('NW3 a failing suite exits 1 with its message, and the suite beside it still reports', () => {
  const r = run(tree({ suites: { 'a.selftest.mjs': nodeTest("test('A1 ok', () => {})\ntest('A2 ok', () => {})"), 'b.selftest.mjs': brokenSuite } }))
  check(r, 1, { mustMatch: [/^ok {3}a\.selftest\.mjs \(2 PASS lines/mu, /^--- b\.selftest\.mjs FAIL \(exit 1, /mu, /^FAIL \[B1 broken on purpose\]: boom-detail/mu, /selftests: discovered=2 passed=1 failed=1/u, /^FAIL — b\.selftest\.mjs\s*$/mu], mustNotMatch: [/all gates green/u] })
})
test('NW3b a suite file that does not load fails the run and is named', () => {
  const r = run(tree({ suites: { 'a.selftest.mjs': passing('A'), 'bad-syntax.selftest.mjs': 'this is not javascript (\n' } }))
  check(r, 1, { mustMatch: [/^ok {3}a\.selftest\.mjs/mu, /^--- bad-syntax\.selftest\.mjs FAIL \(exit 1, /mu, /SyntaxError/u, /^FAIL — bad-syntax\.selftest\.mjs\s*$/mu], mustNotMatch: [/all gates green/u] })
})
test('NW4 an all-green run exits 0: the gate output streams, the counts name suites, a SKIP line is a skip', () => {
  const skipped = nodeTest("test('S1 skipped', { skip: 'for this reason' }, () => {})\ntest('S2 ok', () => {})")
  const r = run(tree({ suites: { 'a.selftest.mjs': passing('A', 2), 'sub/b.selftest.mjs': skipped } }), '--jobs=2')
  check(r, 0, { mustMatch: [/suites: discovered=2 template-excluded=0/u, /^--- manifest-gate\.mjs/mu, /^PASS {2}stub manifest gate/mu, /jobs=2\b/u, /^ok {3}a\.selftest\.mjs \(2 PASS lines/mu, /^ok {3}sub\/b\.selftest\.mjs \(1 PASS lines/mu,
    /^SKIP \[S1 skipped\]: for this reason/mu, /selftests: discovered=2 passed=2 failed=0/u, /all gates green/u], mustNotMatch: [/^FAIL/mu, /shard=/u, /selected=/u] })
})
test('NW4b a suite file that registers no test fails the run by name', () => {
  const r = run(tree({ suites: { 'a.selftest.mjs': passing('A'), 'empty.selftest.mjs': 'export {}\n' } }))
  check(r, 1, { mustMatch: [/^FAIL — this Node suite exited 0 with no PASS or SKIP line, so no case ran/mu, /^ok {3}a\.selftest\.mjs/mu, /selftests: discovered=2 passed=1 failed=1/u, /^FAIL — empty\.selftest\.mjs\s*$/mu], mustNotMatch: [/all gates green/u] })
})
test('NW5 --list prints the discovery in ordinal order and runs nothing: not the gate, not a suite', () => {
  const mark = "import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('./suite.ran', import.meta.url), '1')\n"
  const dir = tree({ suites: { 'sub/c.selftest.mjs': mark, 'b.selftest.mjs': mark, '_.selftest.mjs': mark, 'Z.selftest.mjs': mark, 'a.selftest.mjs': mark } })
  writeFileSync(path.join(dir, 'manifest-gate.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('./gate.ran', import.meta.url), '1')\n")
  const r = run(dir, '--list')
  const ran = ['gate.ran', 'suite.ran', 'sub/suite.ran'].filter((f) => existsSync(path.join(dir, ...f.split('/'))))
  const order = listed(r).join('|')
  check(r, 0, { mustMatch: [/suites: discovered=5 template-excluded=0/u, /^LIST ONLY — nothing ran\s*$/mu], mustNotMatch: [/--- manifest-gate/u, /all gates green/u, /^PASS \[/mu, /shard=/u],
    preFail: [...(ran.length ? [`ran under --list: ${ran.join(', ')}`] : []), ...(order === 'Z.selftest.mjs|_.selftest.mjs|a.selftest.mjs|b.selftest.mjs|sub/c.selftest.mjs' ? [] : [`listing order was ${order}`])] })
})
test('NW6 the shards partition a small discovery: union equals the unsharded list, disjoint, non-empty, balanced, dealt round-robin', () => {
  const names = ['Z', '_', 'a', 'b', 'c', 'd', 'e']
  const dir = tree({ suites: Object.fromEntries(names.map((n) => [`${n}.selftest.mjs`, passing('S')])) })
  const baseL = listed(run(dir, '--list'))
  const fails = []
  if (baseL.length !== names.length) fails.push(`baseline lists ${baseL.length}, expected ${names.length}`)
  for (const n of [1, 3, 4]) {
    const parts = Array.from({ length: n }, (_, k) => {
      const r = run(dir, '--list', `--shard=${k + 1}/${n}`)
      if (r.code !== 0) fails.push(`shard ${k + 1}/${n} exit ${r.code}`)
      if (!new RegExp(`shard=${k + 1}/${n} selected=${listed(r).length}\\b`, 'u').test(r.out)) fails.push(`shard ${k + 1}/${n} header and selected count differ`)
      return listed(r)
    })
    const union = parts.flat()
    if (new Set(union).size !== union.length) fails.push(`N=${n}: a suite sits in two shards`)
    if ([...baseL].sort().join('|') !== [...union].sort().join('|')) fails.push(`N=${n}: union differs from the baseline`)
    const sizes = parts.map((p) => p.length)
    if (Math.min(...sizes) === 0 || Math.max(...sizes) - Math.min(...sizes) > 1) fails.push(`N=${n}: sizes ${sizes.join(',')}`)
    if (n === 3 && parts[1].join('|') !== [baseL[1], baseL[4]].join('|')) fails.push(`N=3: shard 2/3 is ${parts[1].join('|')}, expected the 2nd and 5th suite`)
  }
  finish(fails)
})
test('NW7 a malformed --shard is exit 1 before anything is listed or run, and an empty slice is exit 1', () => {
  const dir = tree({ suites: { 'a.selftest.mjs': passing('A') } })
  const fails = []
  for (const bad of ['0/4', '5/4', 'a/b', '1/0', '01/4', '1/4/2', '4', '99999999999999999999/2', '1/99999999999999999999']) {
    fails.push(...problems(run(dir, `--shard=${bad}`), 1, { label: `'${bad}'`, mustMatch: [/FAIL — --shard must be i\/N with 1 <= i <= N/u, new RegExp(esc(`got '${bad}'`), 'u')], mustNotMatch: [/suites: discovered/u, /LIST ONLY/u, /--- manifest-gate/u] }))
  }
  fails.push(...problems(run(dir, '--list', '--shard=2/2'), 1, { label: 'empty slice', mustMatch: [/selects 0 of 1 suites/u, /an empty slice is not a pass/u, /selected=0\b/u], mustNotMatch: [/LIST ONLY/u, /^ {2}- /mu] }))
  finish(fails)
})
test('NW8 a malformed --jobs, an unknown option and a positional argument are exit 1', () => {
  const dir = tree({ suites: { 'a.selftest.mjs': passing('A') } })
  const fails = []
  // A bad --jobs value is a named refusal. An unknown option or a positional argument also prints the usage.
  const cases = [['--jobs=0', 'FAIL — --jobs must be a whole number >= 1 \\(got 0\\)', false], ['--jobs=-3', 'FAIL — --jobs must be a whole number >= 1 \\(got -3\\)', false],
    ['--jobs=abc', 'FAIL — --jobs must be a whole number >= 1 \\(got abc\\)', false], ['--jobs=1.5', '\\(got 1\\.5\\)', false],
    ['--jobs=99999999999999999999', 'FAIL — --jobs must be a whole number', false], ['--bogus', 'FAIL — .*bogus', true], ['stray', 'FAIL — ', true]]
  for (const [arg, pattern, usage] of cases) {
    fails.push(...problems(run(dir, arg), 1, { label: arg, mustMatch: usage ? [pattern, 'Usage: node selftest\\.mjs'] : [pattern],
      mustNotMatch: ['suites: discovered', '--- manifest-gate', 'LIST ONLY', ...(usage ? [] : ['Usage:'])] }))
  }
  finish(fails)
})
// Two suites that each wait for the other to start. They finish only when the runner runs both at once.
const handshake = (me, other) => `import test from 'node:test'
import { existsSync, writeFileSync } from 'node:fs'
test('${me.toUpperCase()}1 starts beside ${other}', async () => {
  writeFileSync(new URL('./${me}.start', import.meta.url), '1')
  const end = Date.now() + 20000
  while (!existsSync(new URL('./${other}.start', import.meta.url)) && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
  if (!existsSync(new URL('./${other}.start', import.meta.url))) throw new Error('${other} never started: the suites did not run side by side')
})
`
test('NW9 --jobs=2 runs two suite files at once', () => {
  const r = run(tree({ suites: { 'a.selftest.mjs': handshake('a', 'b'), 'b.selftest.mjs': handshake('b', 'a') } }), '--jobs=2')
  check(r, 0, { mustMatch: [/jobs=2\b/u, /^ok {3}a\.selftest\.mjs/mu, /^ok {3}b\.selftest\.mjs/mu, /selftests: discovered=2 passed=2 failed=0/u], mustNotMatch: [/^FAIL/mu, /never started/u] })
})
// With one slot the files run one after the other; a runner that ignores --jobs overlaps them.
const logged = (me, other, waits) => {
  const wait = waits ? `
  const end = Date.now() + 1200
  while (!existsSync(new URL('./${other}.seen', import.meta.url)) && Date.now() < end) await new Promise((r) => setTimeout(r, 50))` : ''
  return `import test from 'node:test'
import { appendFileSync, existsSync } from 'node:fs'
test('${me.toUpperCase()}1 logs its span', async () => {
  appendFileSync(new URL('./order.log', import.meta.url), '${me}-start\\n')
  appendFileSync(new URL('./${me}.seen', import.meta.url), '1')${wait}
  appendFileSync(new URL('./order.log', import.meta.url), '${me}-end\\n')
})
`
}
test('NW9b --jobs=1 runs the suite files one after the other', () => {
  const dir = tree({ suites: { 'a.selftest.mjs': logged('a', 'b', true), 'b.selftest.mjs': logged('b', 'a', false) } })
  const r = run(dir, '--jobs=1')
  const logFile = path.join(dir, 'order.log')
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split(/\r?\n/u).join(',') : 'no log'
  check(r, 0, { mustMatch: [/jobs=1\b/u, /selftests: discovered=2 passed=2 failed=0/u], mustNotMatch: [/^FAIL/mu],
    preFail: log === 'a-start,a-end,b-start,b-end' ? [] : [`suite spans were ${log}, expected a-start,a-end,b-start,b-end`] })
})
test('NW10 --help prints the usage and exits 0, and names every flag', () => {
  const r = run(tree(), '--help')
  check(r, 0, { mustMatch: [/Usage: node selftest\.mjs/u, /--jobs=N/u, /--suite-timeout=S/u, /--shard=i\/N/u, /--list/u, /--full/u, /--changed/u, /--base=<ref>/u], mustNotMatch: [/FAIL/u, /suites: discovered/u] })
})
test('NW11 a templates/ payload is excluded and counted, and never listed', () => {
  const dir = tree({ suites: { 'a.selftest.mjs': passing('A'), 'skills/x/templates/y/payload.selftest.mjs': passing('P'), 'templates/q.selftest.mjs': passing('Q') } })
  check(run(dir, '--list'), 0, { mustMatch: [/suites: discovered=1 template-excluded=2/u, /^ {2}- a\.selftest\.mjs/mu, /LIST ONLY/u], mustNotMatch: [/payload\.selftest/u, /q\.selftest/u, /FAIL/u] })
})
test('NW12 a missing gate is a failure, and the suites still run', () => {
  const r = run(tree({ gate: 'missing', suites: { 'a.selftest.mjs': passing('A') } }))
  check(r, 1, { mustMatch: [/^FAIL — manifest-gate\.mjs missing \(the wiring gate is not optional\)/mu, /^ok {3}a\.selftest\.mjs/mu, /FAIL — manifest-gate\.mjs \(missing\)/u], mustNotMatch: [/all gates green/u, /--- manifest-gate/u] })
})
test('NW13 the runner gives each suite min(--jobs, suites) as YWR_SELFTEST_OUTER_JOBS', () => {
  const probe = (id) => nodeTest(`test(\`${id} outer=\${process.env.YWR_SELFTEST_OUTER_JOBS}\`, () => {})`)
  // Two suites under --jobs=3: at most two run at once, so each gets 2, not 3.
  const r = run(tree({ suites: { 'a.selftest.mjs': probe('O1'), 'b.selftest.mjs': probe('O2') } }), '--jobs=3', '--full')
  check(r, 0, { mustMatch: [/^PASS \[O1 outer=2\]/mu, /^PASS \[O2 outer=2\]/mu], mustNotMatch: [/^FAIL/mu] })
  // One suite alone gets every CPU: the value is 1, which innerJobs reads as no division.
  const one = run(tree({ suites: { 'a.selftest.mjs': probe('O3') } }), '--jobs=3', '--full')
  check(one, 0, { mustMatch: [/^PASS \[O3 outer=1\]/mu], mustNotMatch: [/^FAIL/mu] })
})
test('NW14 innerJobs takes the CPU share under a runner, every CPU alone, and stays between min and cap', () => {
  const cpus = availableParallelism()
  const fails = []
  const want = (got, exp, what) => { if (got !== exp) fails.push(`${what}: got ${got}, want ${exp}`) }
  // An empty value stands for "no runner": undefined would fall back to this process's own environment, which a runner sets.
  want(innerJobs(1000, 1, ''), cpus, 'alone takes every CPU')
  want(innerJobs(1000, 1, '1'), cpus, 'one outer job takes every CPU')
  want(innerJobs(1000, 1, 'x'), cpus, 'a value that is no number counts as alone')
  want(innerJobs(1000, 1, String(cpus * 4)), 1, 'the min holds when the share is 0')
  want(innerJobs(1000, 2, '2'), Math.max(2, Math.floor(cpus / 2)), 'the share is CPUs divided by the outer jobs')
  want(innerJobs(1, 1, ''), 1, 'the cap holds')
  finish(fails)
})
