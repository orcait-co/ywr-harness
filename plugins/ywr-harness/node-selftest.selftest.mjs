// Self-test for node-selftest.mjs, the Node wrapper (ywr-harness ADR 0227 decision 6). Each case copies the wrapper and
// the shared reporter into a fixture plugin directory with a fake manifest gate and fake suites, and runs that copy as a
// node child. It never runs the real plugin tree: the wrapper discovers the suites beside itself, and a run of the real
// tree from this suite would run this suite again.
//
// Case IDs: NW1 and NW1b the empty discovery, NW2 a failed gate that does not stop the suites, NW3 and NW3b a failing
// suite, NW4 and NW4b a green run and the no-PASS guard, NW5 --list, NW6 the shard partition, NW7 malformed --shard
// values, NW8 malformed options, NW9 and NW9b --jobs reaching node --test, NW10 --help and the header, NW11 the
// template payload, NW12 a missing gate.
//
// Usage: node --test-reporter=<file URL of lib/selftest-reporter.mjs> --test-reporter-destination=stdout node-selftest.selftest.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertMatch, fixtureRoot, innerJobs, matchFailures, removeFixtureRoot, runNode } from './lib/selftest-lib.mjs'
import { availableParallelism } from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = fixtureRoot('node-selftest-selftest')
after(() => removeFixtureRoot(root))

// This suite may run under `node --test` itself. That sets NODE_TEST_CONTEXT, and a nested `node --test` that inherits it
// writes a serialized stream for its parent instead of the reporter's lines. Each child here runs without it.
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT

let seq = 0
// A fixture plugin directory: the wrapper copy, the reporter copy, a fake gate and the given suites. The gate writes
// `gate.ran`, so a case can tell whether it ran. gate is 'pass', 'fail' or 'missing'.
function plugin({ gate = 'pass', suites = {} } = {}) {
  const dir = path.join(root, `p${++seq}`)
  mkdirSync(path.join(dir, 'lib'), { recursive: true })
  copyFileSync(path.join(here, 'node-selftest.mjs'), path.join(dir, 'node-selftest.mjs'))
  copyFileSync(path.join(here, 'lib', 'selftest-reporter.mjs'), path.join(dir, 'lib', 'selftest-reporter.mjs'))
  if (gate !== 'missing') {
    const body = "import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('./gate.ran', import.meta.url), '1')\n" +
      (gate === 'fail' ? "console.log('FAIL — stub gate failed')\nprocess.exit(1)\n" : "console.log('PASS  stub manifest gate')\n")
    writeFileSync(path.join(dir, 'manifest-gate.mjs'), body)
  }
  for (const [rel, text] of Object.entries(suites)) {
    const p = path.join(dir, ...rel.split('/'))
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, text)
  }
  return dir
}
const run = (dir, ...argv) => {
  const r = runNode([path.join(dir, 'node-selftest.mjs'), ...argv], { env, timeoutMs: 120000 })
  return { ...r, out: r.stdout + r.stderr }
}
// The failures of one run: the exit code folded in with the match check, so one failing case names both.
// A JavaScript regex has no inline `(?m)`: a pattern that starts with it becomes a multiline RegExp, so a line anchor
// reads like the pwsh suites' `(?m)^`.
const rx = (p) => (p.startsWith('(?m)') ? new RegExp(p.slice(4), 'mu') : p)
const prepared = (opts, r, code) => ({
  ...opts, mustMatch: (opts.mustMatch ?? []).map(rx), mustNotMatch: (opts.mustNotMatch ?? []).map(rx),
  preFail: [...(opts.preFail ?? []), ...(r.status === code ? [] : [`exit ${r.status} (expected ${code})`])],
})
const problems = (r, code, opts) => matchFailures(r.out, prepared(opts, r, code))
const check = (r, code, opts) => assertMatch(r.out, prepared(opts, r, code))
// An aggregate case collects its failures and ends with all of them.
const finish = (fails) => { if (fails.length) assert.fail(fails.join('\n')) }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const passing = (id, n = 1) => "import test from 'node:test'\n" + Array.from({ length: n }, (_, i) => `test('${id}${i + 1} ok', () => {})`).join('\n') + '\n'
const broken = "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('B1 broken on purpose', () => { assert.fail('boom-detail') })\n"
const listed = (r) => r.out.split(/\r?\n/u).map((l) => /^ {2}- (.+)$/u.exec(l)?.[1]).filter(Boolean)

test('NW1 zero discovered is exit 1, the gate does not run, and a templates/ payload is excluded, counted and rescues nothing', () => {
  const dir = plugin({ suites: { 'templates/p/payload.selftest.mjs': passing('P') } })
  check(run(dir), 1, {
    mustMatch: ['FAIL — no \\*\\.selftest\\.mjs discovered', 'empty set is not a pass', 'template payload excluded: 1'],
    mustNotMatch: ['LIST ONLY', '--- manifest-gate', 'suites: discovered', 'payload\\.selftest\\.mjs'],
    preFail: existsSync(path.join(dir, 'gate.ran')) ? ['the gate ran on an empty discovery'] : [],
  })
})

test('NW1b zero discovered is exit 1 under --list too', () => {
  check(run(plugin(), '--list'), 1, { mustMatch: ['FAIL — no \\*\\.selftest\\.mjs discovered', 'template payload excluded: 0'], mustNotMatch: ['LIST ONLY'] })
})

test('NW2 a failed gate fails the run, and the suites still run', () => {
  const r = run(plugin({ gate: 'fail', suites: { 'a.selftest.mjs': passing('A') } }))
  check(r, 1, {
    mustMatch: ['(?m)^--- manifest-gate\\.mjs', '(?m)^FAIL — stub gate failed', '(?m)^PASS \\[A1 ok\\]', 'tests passed=1 failed=0', '(?m)^FAIL — manifest-gate\\.mjs\\s*$'],
    mustNotMatch: ['node suites green'],
  })
})

test('NW3 a failing suite exits 1 with its message, and the suite beside it still reports', () => {
  const r = run(plugin({ suites: { 'a.selftest.mjs': passing('A', 2), 'b.selftest.mjs': broken } }))
  check(r, 1, {
    mustMatch: ['(?m)^PASS \\[A1 ok\\]', '(?m)^PASS \\[A2 ok\\]', '(?m)^FAIL \\[B1 broken on purpose\\]: boom-detail', 'tests passed=2 failed=1 skipped=0', '(?m)^FAIL — node --test \\(exit 1\\)\\s*$'],
    mustNotMatch: ['node suites green'],
  })
})

test('NW3b a suite file that does not load fails the run and is named', () => {
  const r = run(plugin({ suites: { 'a.selftest.mjs': passing('A'), 'bad-syntax.selftest.mjs': 'this is not javascript (\n' } }))
  check(r, 1, {
    mustMatch: ['(?m)^PASS \\[A1 ok\\]', '(?m)^FAIL \\[[^\\]]*bad-syntax\\.selftest\\.mjs\\]', 'failed=[1-9]', '(?m)^FAIL — node --test \\(exit 1\\)\\s*$'],
    mustNotMatch: ['node suites green'],
  })
})

test('NW4 an all-green run exits 0: the gate output streams, the counts name tests, a SKIP line is a skip', () => {
  const skipped = "import test from 'node:test'\ntest('S1 skipped', { skip: 'for this reason' }, () => {})\ntest('S2 ok', () => {})\n"
  const r = run(plugin({ suites: { 'a.selftest.mjs': passing('A', 2), 'sub/b.selftest.mjs': skipped } }), '--jobs=2')
  check(r, 0, {
    mustMatch: ['suites: discovered=2 template-excluded=0', '(?m)^--- manifest-gate\\.mjs', '(?m)^PASS  stub manifest gate', 'jobs=2\\b', '(?m)^PASS \\[A1 ok\\]', '(?m)^PASS \\[S2 ok\\]',
      '(?m)^SKIP \\[S1 skipped\\]: for this reason', 'node-selftests: discovered=2 tests passed=3 failed=0 skipped=1', 'node suites green'],
    mustNotMatch: ['(?m)^FAIL', 'shard='],
  })
})

test('NW4b a suite file that registers no test fails the run by name and stays out of the PASS count', () => {
  const r = run(plugin({ suites: { 'a.selftest.mjs': passing('A'), 'empty.selftest.mjs': 'export {}\n' } }))
  check(r, 1, {
    mustMatch: ['(?m)^FAIL — empty\\.selftest\\.mjs registered no test', '(?m)^PASS \\[A1 ok\\]', 'tests passed=1 failed=0', '(?m)^FAIL — empty\\.selftest\\.mjs \\(no test\\)\\s*$'],
    mustNotMatch: ['node suites green'],
  })
})

test('NW5 --list prints the discovery in ordinal order and runs nothing: not the gate, not a suite', () => {
  const mark = "import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('./suite.ran', import.meta.url), '1')\n"
  const dir = plugin({ suites: { 'sub/c.selftest.mjs': mark, 'b.selftest.mjs': mark, '_.selftest.mjs': mark, 'Z.selftest.mjs': mark, 'a.selftest.mjs': mark } })
  const r = run(dir, '--list')
  const ran = ['gate.ran', 'suite.ran', 'sub/suite.ran'].filter((f) => existsSync(path.join(dir, ...f.split('/'))))
  const order = listed(r).join('|')
  check(r, 0, {
    mustMatch: ['suites: discovered=5 template-excluded=0', '(?m)^LIST ONLY — nothing ran\\s*$'],
    mustNotMatch: ['--- manifest-gate', 'node suites green', '(?m)^PASS \\[', 'shard='],
    preFail: [...(ran.length ? [`ran under --list: ${ran.join(', ')}`] : []),
      ...(order === 'Z.selftest.mjs|_.selftest.mjs|a.selftest.mjs|b.selftest.mjs|sub/c.selftest.mjs' ? [] : [`listing order was ${order}`])],
  })
})

test('NW6 the shards partition the discovery: union equals the unsharded list, disjoint, non-empty, balanced, dealt round-robin', () => {
  const names = ['Z', '_', 'a', 'b', 'c', 'd', 'e']
  const dir = plugin({ suites: Object.fromEntries(names.map((n) => [`${n}.selftest.mjs`, passing('S')])) })
  const base = listed(run(dir, '--list'))
  const fails = []
  if (base.length !== names.length) fails.push(`baseline lists ${base.length}, expected ${names.length}`)
  for (const n of [1, 3, 4]) {
    const parts = Array.from({ length: n }, (_, k) => {
      const r = run(dir, '--list', `--shard=${k + 1}/${n}`)
      if (r.status !== 0) fails.push(`shard ${k + 1}/${n} exit ${r.status}`)
      if (!new RegExp(`shard=${k + 1}/${n} selected=${listed(r).length}\\b`, 'u').test(r.out)) fails.push(`shard ${k + 1}/${n} header and selected count differ`)
      return listed(r)
    })
    const union = parts.flat()
    if (new Set(union).size !== union.length) fails.push(`N=${n}: a suite sits in two shards`)
    if ([...base].sort().join('|') !== [...union].sort().join('|')) fails.push(`N=${n}: union differs from the baseline`)
    const sizes = parts.map((p) => p.length)
    if (Math.min(...sizes) === 0 || Math.max(...sizes) - Math.min(...sizes) > 1) fails.push(`N=${n}: sizes ${sizes.join(',')}`)
    if (n === 3 && parts[1].join('|') !== [base[1], base[4]].join('|')) fails.push(`N=3: shard 2/3 is ${parts[1].join('|')}, expected the 2nd and 5th suite`)
  }
  finish(fails)
})

test('NW7 a malformed --shard is exit 1 before anything is listed or run, and an empty slice is exit 1', () => {
  const dir = plugin({ suites: { 'a.selftest.mjs': passing('A') } })
  const fails = []
  for (const bad of ['0/4', '5/4', 'a/b', '1/0', '01/4', '1/4/2', '4', '99999999999999999999/2', '1/99999999999999999999']) {
    fails.push(...problems(run(dir, `--shard=${bad}`), 1, {
      label: `'${bad}'`, mustMatch: ['FAIL — --shard must be i/N with 1 <= i <= N', esc(`got '${bad}'`)], mustNotMatch: ['suites: discovered', 'LIST ONLY', '--- manifest-gate'] }))
  }
  fails.push(...problems(run(dir, '--list', '--shard=2/2'), 1, {
    label: 'empty slice', mustMatch: ['selects 0 of 1 suites', 'an empty slice is not a pass', 'selected=0\\b'], mustNotMatch: ['LIST ONLY', '(?m)^ {2}- '] }))
  finish(fails)
})

test('NW8 a malformed --jobs, an unknown option and a positional argument are exit 1', () => {
  const dir = plugin({ suites: { 'a.selftest.mjs': passing('A') } })
  const fails = []
  // A bad --jobs value is a named refusal. An unknown option or a positional argument also prints the usage.
  const cases = [['--jobs=0', 'FAIL — --jobs must be a whole number >= 1 \\(got 0\\)', false], ['--jobs=-3', 'FAIL — --jobs must be a whole number >= 1 \\(got -3\\)', false],
    ['--jobs=abc', 'FAIL — --jobs must be a whole number >= 1 \\(got abc\\)', false], ['--jobs=1.5', '\\(got 1\\.5\\)', false],
    ['--jobs=99999999999999999999', 'FAIL — --jobs must be a whole number', false], ['--bogus', 'FAIL — .*bogus', true], ['stray', 'FAIL — ', true]]
  for (const [arg, pattern, usage] of cases) {
    fails.push(...problems(run(dir, arg), 1, {
      label: arg, mustMatch: usage ? [pattern, 'Usage: node node-selftest\\.mjs'] : [pattern],
      mustNotMatch: ['suites: discovered', '--- manifest-gate', 'LIST ONLY', ...(usage ? [] : ['Usage:'])] }))
  }
  finish(fails)
})

// Two suites that each wait for the other to start. They finish only when node --test runs both files at once.
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
  const r = run(plugin({ suites: { 'a.selftest.mjs': handshake('a', 'b'), 'b.selftest.mjs': handshake('b', 'a') } }), '--jobs=2')
  check(r, 0, { mustMatch: ['jobs=2\\b', '(?m)^PASS \\[A1 starts beside b\\]', '(?m)^PASS \\[B1 starts beside a\\]', 'tests passed=2 failed=0'], mustNotMatch: ['(?m)^FAIL', 'never started'] })
})

// With one slot the second file starts only after the first has ended, so the log shows no overlap. The first file
// waits 1.2 s for a start of the second that cannot come. A wrapper that ignores --jobs overlaps them when the
// default concurrency is 2 or more, which is the case on a box with 3 CPUs or more.
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
  const dir = plugin({ suites: { 'a.selftest.mjs': logged('a', 'b', true), 'b.selftest.mjs': logged('b', 'a', false) } })
  const r = run(dir, '--jobs=1')
  const logFile = path.join(dir, 'order.log')
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split(/\r?\n/u).join(',') : 'no log'
  check(r, 0, {
    mustMatch: ['jobs=1\\b', 'tests passed=2 failed=0'], mustNotMatch: ['(?m)^FAIL'],
    preFail: log === 'a-start,a-end,b-start,b-end' ? [] : [`suite spans were ${log}, expected a-start,a-end,b-start,b-end`],
  })
})

test('NW10 --help prints the usage and exits 0, and the usage and the header both say that read-set selection and a suite timeout are missing', () => {
  const r = run(plugin(), '--help')
  const head = readFileSync(path.join(here, 'node-selftest.mjs'), 'utf8').split('\n').slice(0, 20).join('\n')
  check(r, 0, {
    mustMatch: ['Usage: node node-selftest\\.mjs', '--list', '--shard=i/N', '--jobs=N', 'read-set selection and a suite timeout', 'Counts are tests, not suites'],
    mustNotMatch: ['FAIL', 'suites: discovered'],
    preFail: /read-set selection/u.test(head) && /suite timeout/u.test(head) ? [] : ['the header comment of node-selftest.mjs does not state the missing read-set selection and suite timeout'],
  })
})

test('NW11 a templates/ payload is excluded and counted, and never listed', () => {
  const dir = plugin({ suites: { 'a.selftest.mjs': passing('A'), 'skills/x/templates/y/payload.selftest.mjs': passing('P'), 'templates/q.selftest.mjs': passing('Q') } })
  check(run(dir, '--list'), 0, { mustMatch: ['suites: discovered=1 template-excluded=2', '(?m)^ {2}- a\\.selftest\\.mjs', 'LIST ONLY'], mustNotMatch: ['payload\\.selftest', 'q\\.selftest', 'FAIL'] })
})

test('NW12 a missing gate is a failure, and the suites still run', () => {
  const r = run(plugin({ gate: 'missing', suites: { 'a.selftest.mjs': passing('A') } }))
  check(r, 1, {
    mustMatch: ['(?m)^FAIL — manifest-gate\\.mjs missing \\(the wiring gate is not optional\\)', '(?m)^PASS \\[A1 ok\\]', 'FAIL — manifest-gate\\.mjs \\(missing\\)'],
    mustNotMatch: ['node suites green', '--- manifest-gate'],
  })
})

test('NW13 the wrapper gives each suite min(--jobs, suites) as YWR_SELFTEST_OUTER_JOBS', () => {
  const probe = (id) => `import test from 'node:test'\ntest(\`${id} outer=\${process.env.YWR_SELFTEST_OUTER_JOBS}\`, () => {})\n`
  // Two suites under --jobs=3: at most two run at once, so each gets 2, not 3.
  const r = run(plugin({ suites: { 'a.selftest.mjs': probe('O1'), 'b.selftest.mjs': probe('O2') } }), '--jobs=3')
  check(r, 0, { mustMatch: ['(?m)^PASS \\[O1 outer=2\\]', '(?m)^PASS \\[O2 outer=2\\]'], mustNotMatch: ['(?m)^FAIL'] })
  // One suite alone gets every CPU: the value is 1, which innerJobs reads as no division.
  const one = run(plugin({ suites: { 'a.selftest.mjs': probe('O3') } }), '--jobs=3')
  check(one, 0, { mustMatch: ['(?m)^PASS \\[O3 outer=1\\]'], mustNotMatch: ['(?m)^FAIL'] })
})

test('NW14 innerJobs takes the CPU share under a runner, every CPU alone, and stays between min and cap', () => {
  const cpus = availableParallelism()
  const fails = []
  const want = (got, exp, what) => { if (got !== exp) fails.push(`${what}: got ${got}, want ${exp}`) }
  // An empty value stands for "no runner": undefined would fall back to this process's own environment, which
  // a runner sets.
  want(innerJobs(1000, 1, ''), cpus, 'alone takes every CPU')
  want(innerJobs(1000, 1, '1'), cpus, 'one outer job takes every CPU')
  want(innerJobs(1000, 1, 'x'), cpus, 'a value that is no number counts as alone')
  want(innerJobs(1000, 1, String(cpus * 4)), 1, 'the min holds when the share is 0')
  want(innerJobs(1000, 2, '2'), Math.max(2, Math.floor(cpus / 2)), 'the share is CPUs divided by the outer jobs')
  want(innerJobs(1, 1, ''), 1, 'the cap holds')
  finish(fails)
})
