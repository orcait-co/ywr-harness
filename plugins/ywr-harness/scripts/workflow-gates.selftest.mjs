// Self-test for workflow-gates.mjs. The plugin's selftest runner discovers it by name, so it needs no ci.yml wiring.
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout scripts/workflow-gates.selftest.mjs  (exit 0 = all green). ~3 s.
//
// Two arms:
//   fixture   temp trees driving every terminal branch, including the clean cases. Without those
//             the arm could be green by rejecting everything (vacuous-pass discipline).
//   counts    a fixture corpus of two workflows: both must appear by name and in the summary
//             counts, so a silently shrinking corpus is visible.
// The plugin ships no workflow of its own (ywr-harness ADR 0215), so no live corpus arm exists.
//
// Each test is named `WG<n> <case name>` (ADR 0227 decision 1).
// Patterns are case-insensitive regex sources (see toRx in lib/selftest-lib.mjs).
//
// The fixtures use .claude/workflows, the default corpus path of a consuming repo. Case A exercises
// the `--dir` option, so both paths stay tested.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, runNode, matchFailures } from '../lib/selftest-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const gate = path.join(here, 'workflow-gates.mjs')

// The suite runs under node, so it has no absent-node branch (ywr-harness ADR 0231).

const fxBase = fixtureRoot('workflow-gates-selftest')
after(() => removeFixtureRoot(fxBase))

function newFixture(name, files) {
  const rootDir = path.join(fxBase, name)
  const wf = path.join(rootDir, '.claude/workflows')
  mkdirSync(wf, { recursive: true })
  for (const [k, v] of Object.entries(files)) writeFileSync(path.join(wf, k), v)
  return rootDir
}

function invokeGate(root, dir) {
  const a = [gate, '--root', root]
  if (dir) a.push('--dir', dir)
  const r = runNode(a)
  return { out: r.stdout + r.stderr, code: r.status }
}

// The checks of one case: the exit code first, then the match loops of the shared core. Its own
// copy of the empty-mustNotMatch guard lives in lib/selftest-lib.mjs, and noNegative forwards to it.
function caseFailures(r, expectExit, mustMatch, mustNotMatch, noNegative = '') {
  const pre = []
  if (r.code !== expectExit) pre.push(`exit ${r.code} (expected ${expectExit})`)
  return matchFailures(r.out, { mustMatch, mustNotMatch, noNegative, preFail: pre })
}
function assertCase(r, expectExit, mustMatch, mustNotMatch, noNegative = '') {
  const f = caseFailures(r, expectExit, mustMatch, mustNotMatch, noNegative)
  assert.deepEqual(f, [], `${f.join(' · ')}\n--- output ---\n${r.out}`)
}

// The awkward shape the gate exists for: `export const meta` AND a top-level return/await in one
// file. Case D proves `node --check` rejects exactly this, which is why the transform exists.
const legal = `export const meta = { name: 'fx', description: 'fixture', phases: [{ title: 'P' }] }
phase('P')
const r = await agent('x', { model: 'sonnet', effort: 'low' })
return { r }
`
const broken = `export const meta = { name: 'bad', description: 'fixture' }
const r = await agent('x'
return { r }
`
const noMeta = `const meta = { name: 'nometa', description: 'fixture' }
return meta
`
const passSelftest = 'process.exit(0)\n'
const failSelftest = "console.log('fixture selftest is meant to fail');\nprocess.exit(1)\n"

// A counts: a two-workflow corpus under a non-default `--dir`. Negatives pin that no arm reported
// a failure and that the vacuity guards stayed quiet. A green run whose counts came from an empty
// glob is the class this gate refuses.
test('WG1 A counts, --dir corpus', () => {
  const fxCounts = path.join(fxBase, 'counts')
  mkdirSync(path.join(fxCounts, 'flows'), { recursive: true })
  for (const n of ['one', 'two']) {
    writeFileSync(path.join(fxCounts, `flows/${n}.js`), legal)
    writeFileSync(path.join(fxCounts, `flows/${n}.selftest.mjs`), passSelftest)
  }
  assertCase(invokeGate(fxCounts, 'flows'), 0,
    ['ok — parsed flows/one\\.js', 'ok — parsed flows/two\\.js',
      'ok — selftest passed flows/one\\.selftest\\.mjs', 'ok — selftest passed flows/two\\.selftest\\.mjs',
      'green — 2 workflow script\\(s\\) parsed, 2 selftest file\\(s\\) passed'],
    ['FAIL —', 'vacuous'])
})

// B a syntax error is caught and named. Negatives: a parse failure must not coexist with a green
// verdict, the failure mode this gate exists to close.
const fxBroken = newFixture('broken', { 'bad.js': broken, 'bad.selftest.mjs': passSelftest })
test('WG2 B syntax error fails', () => {
  assertCase(invokeGate(fxBroken), 1, ['FAIL — \\.claude/workflows/bad\\.js: SyntaxError'], ['green —'])
})

// C the legal-but-awkward shape stays CLEAN, and its selftest is actually executed.
const fxLegal = newFixture('legal', { 'good.js': legal, 'good.selftest.mjs': passSelftest })
test('WG3 C legal shape clean', () => {
  assertCase(invokeGate(fxLegal), 0,
    ['ok — parsed \\.claude/workflows/good\\.js', 'ok — selftest passed .*good\\.selftest\\.mjs', 'green —'],
    ['FAIL —'])
})

// D why this gate is not a `node --check` wrapper. On some node versions the `export` line makes the
// file module-detected and not syntax-checked, so --check exits 0 on the broken file case B rejects.
// On others --check syntax-checks the file and rejects case B's, and it also rejects case C's legal
// file ("Illegal return statement": a workflow body is a function body, so its top-level `return` is
// not module syntax). Either direction makes --check unusable, so both are a PASS, the second only on
// that exact error. A node whose --check accepts C, or rejects it for any other reason, WARNs rather
// than fails. That is the trigger to re-verify this reasoning, not a defect signal.
// The probe runs when this file loads, so the test name can carry the legal file's exit code.
const dBroken = runNode(['--check', path.join(fxBroken, '.claude/workflows/bad.js')])
const dOut = dBroken.stdout + dBroken.stderr
const dLegal = runNode(['--check', path.join(fxLegal, '.claude/workflows/good.js')])
const dLegalOut = dLegal.stdout + dLegal.stderr
if (dBroken.status === 0 && !/SyntaxError/iu.test(dOut)) {
  test('WG4 D node --check is vacuous on this class', () => {})
} else if (dLegal.status !== 0 && /SyntaxError: Illegal return statement/iu.test(dLegalOut)) {
  test(`WG4 D node --check false-alarms on a legal workflow (rc=${dLegal.status}) — unusable the other way`, () => {})
} else {
  const why = dLegalOut.split(/\r?\n/u).find((l) => /Error/iu.test(l)) ?? ''
  test('WG4 D node --check probe', () => {
    console.log(`WARN [D]: node --check rejects the broken workflow (rc=${dBroken.status}) and the legal one gave rc=${dLegal.status} ${why} — the custom parser is still correct, but re-verify the reasoning above before citing --check as unusable`)
  })
}

// E vacuous corpus: an empty directory FAILS both arms rather than printing a green zero.
test('WG5 E empty corpus fails', () => {
  const fxEmpty = newFixture('empty', {})
  assertCase(invokeGate(fxEmpty), 1, ['zero workflow scripts', 'zero \\*\\.selftest\\.mjs'], ['green —'])
})

// F the behavioral arm is wired, not merely discovered: a selftest exiting non-zero fails the gate
// and its own stdout reaches the log (stdio is inherited).
test('WG6 F failing selftest fails the gate', () => {
  const fxFailing = newFixture('failing', { 'good.js': legal, 'good.selftest.mjs': failSelftest })
  assertCase(invokeGate(fxFailing), 1,
    ['fixture selftest is meant to fail', 'FAIL — selftest failed \\(exit 1\\)'], ['green —'])
})

// G a workflow without the `export const meta` anchor is rejected. The transform is anchored on
// it and the Workflow tool requires it, so a file missing it is dead on arrival.
test('WG7 G missing meta anchor fails', () => {
  const fxNoMeta = newFixture('nometa', { 'plain.js': noMeta, 'plain.selftest.mjs': passSelftest })
  assertCase(invokeGate(fxNoMeta), 1, ['no .export const meta. declaration'], ['green —'])
})

// H a root with no .claude/workflows/ at all: still a failure, not a skip. The gate is only ever
// invoked on this repo, so an absent corpus means the path moved and nothing is being checked.
test('WG8 H missing corpus dir fails', () => {
  const fxNoDir = path.join(fxBase, 'nodir')
  mkdirSync(fxNoDir, { recursive: true })
  assertCase(invokeGate(fxNoDir), 1, ['\\.claude/workflows/ not found'], ['green —', 'ok — parsed'])
})

// I a nested workflow is discovered too. The glob is recursive, so a file one level down
// cannot sit outside the gate while the summary still counts green.
test('WG9 I nested file is gated', () => {
  const fxNested = newFixture('nested', { 'good.js': legal, 'good.selftest.mjs': passSelftest })
  mkdirSync(path.join(fxNested, '.claude/workflows/sub'), { recursive: true })
  writeFileSync(path.join(fxNested, '.claude/workflows/sub/deep.js'), broken)
  assertCase(invokeGate(fxNested), 1, ['FAIL — \\.claude/workflows/sub/deep\\.js: SyntaxError'], ['green —'])
})

// META: the empty-MustNotMatch guard must fire through this file's wrapper, and on the guard
// reason alone. The guard lives in the shared assertion core, so this proves the wiring, not the guard.
test('WG10 META', () => {
  const f = caseFailures({ code: 0, out: 'meta probe' }, 0, ['meta probe'], [])
  assert.ok(f.length === 1 && /no MustNotMatch/iu.test(f[0]),
    `guard did not fire — accepted=${f.length === 0} reason='${f.join('; ')}'`)
})
// The other arm: this wrapper forwards noNegative, and no real case passes a reason. Without this
// case the parameter is write-only and a dropped passthrough stays invisible.
test('WG11 META exemption honored', () => {
  const f = caseFailures({ code: 0, out: 'meta probe' }, 0, ['meta probe'], [], 'META: proves this wrapper forwards noNegative to the shared core')
  assert.deepEqual(f, [], 'noNegative exemption rejected')
})
