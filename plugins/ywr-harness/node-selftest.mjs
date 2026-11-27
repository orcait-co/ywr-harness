// The Node wrapper of the plugin's Node suites (ywr-harness ADR 0227 decision 6), the future runner of phase 3.
// It does what selftest.ps1 does for the suites of the shape `*.selftest.mjs`, in three steps:
//   1. It runs manifest-gate.mjs, with the output streamed. A failed gate fails the run, and the suites still run.
//   2. It discovers every `*.selftest.mjs` under its own directory. A file under a `templates/` directory is
//      scaffold payload, so the wrapper excludes it and counts it. Zero discovered is a failure, not a pass.
//   3. It runs the suites in one `node --test` child with the shared reporter lib/selftest-reporter.mjs.
// The suite order is ordinal by plugin-relative path with `/` separators, and `--shard=i/N` deals it round-robin,
// as selftest.ps1 does, so the N shards partition the discovery by construction.
//
// Not in this wrapper yet (ywr-harness ADR 0227 decision 7): the read-set selection of selftest-reads.json and a
// suite timeout. The pwsh runners keep both until the last slice of phase 3, so a Node suite that hangs under this
// wrapper hangs the run. Run a full set here only when no hang is expected.
//
// Counts: `node --test` with the shared reporter gives no verdict for each file. The summary line therefore counts
// tests, read from the PASS, FAIL and SKIP lines of the reporter, not suites. The exit code of the `node --test`
// child is the verdict. A suite file that registers no test reports one PASS line named by its own path. The wrapper
// reads that line as a failure and keeps it out of the count. A run that exits 0 without one PASS line fails too.
//
// Exit contract: exit 0 means the gate passed, at least one suite was discovered, and every test passed.
// Exit 1 means anything else.

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const pluginDir = path.dirname(fileURLToPath(import.meta.url))

const USAGE = `Usage: node node-selftest.mjs [--list] [--shard=i/N] [--jobs=N] [--help]

Runs manifest-gate.mjs, then every *.selftest.mjs under this directory with node --test.
  --list        print the discovery and the selection, run nothing, exit 0
  --shard=i/N   run only the i-th of N slices of the discovery (1-based, round-robin by ordinal path order)
  --jobs=N      how many suite files run at once, passed as --test-concurrency (default min(CPUs, 8))
  --help        print this text
Not yet in this wrapper (ywr-harness ADR 0227 decision 7): read-set selection and a suite timeout.
The pwsh runners keep both. A suite that hangs under this wrapper hangs the run.
Counts are tests, not suites: node --test gives no verdict for each file through the shared reporter.`

// --- output --------------------------------------------------------------------------------------------
const say = (line = '') => process.stdout.write(`${line}\n`)
const fail = (line) => say(`FAIL — ${line}`)

// --- arguments -----------------------------------------------------------------------------------------
let args
try {
  args = parseArgs({
    args: process.argv.slice(2),
    options: { list: { type: 'boolean' }, shard: { type: 'string' }, jobs: { type: 'string' }, help: { type: 'boolean' } },
    strict: true,
    allowPositionals: false,
  }).values
} catch (e) {
  fail(e.message)
  say(USAGE)
  process.exit(1)
}
if (args.help) { say(USAGE); process.exit(0) }

// A whole number from 1 up, with no leading zero and no sign: the form `^[1-9][0-9]*$` that selftest.ps1 uses for
// -Shard. A digit run past the safe integer range is refused by name, never turned into a rounded number.
const wholeNumber = (s) => (/^[1-9][0-9]*$/u.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null)

const defaultJobs = Math.min(availableParallelism(), 8)
let jobs = defaultJobs
if (args.jobs !== undefined) {
  jobs = wholeNumber(args.jobs)
  if (jobs === null) { fail(`--jobs must be a whole number >= 1 (got ${args.jobs})`); process.exit(1) }
}
let shardIndex = 0
let shardCount = 0
if (args.shard !== undefined) {
  const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(args.shard)
  const i = m ? wholeNumber(m[1]) : null
  const n = m ? wholeNumber(m[2]) : null
  if (i === null || n === null || i > n) { fail(`--shard must be i/N with 1 <= i <= N (got '${args.shard}')`); process.exit(1) }
  shardIndex = i
  shardCount = n
}

// --- discovery -----------------------------------------------------------------------------------------
// Recursive, so a suite anywhere in the plugin is discovered. The one exclusion is the same as selftest.ps1 makes:
// a file under a `templates/` directory is payload that the plugin copies into a consuming repo. It is counted and
// printed, never silent. The test runs on the plugin-relative path with a leading `/`.
function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.isFile() && /\.selftest\.mjs$/iu.test(e.name)) out.push(full)
  }
}
const found = []
walk(pluginDir, found)
const toRel = (full) => path.relative(pluginDir, full).split(path.sep).join('/')
const templateRx = /[\\/]templates[\\/]/u
const rels = found.map(toRel).filter((r) => !templateRx.test(`/${r}`))
const templateExcluded = found.length - rels.length
// Ordinal: UTF-16 code unit order, the order of [StringComparer]::Ordinal, so the deal is the same on every OS.
rels.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

if (rels.length === 0) {
  fail(`no *.selftest.mjs discovered (empty set is not a pass; template payload excluded: ${templateExcluded})`)
  process.exit(1)
}

const selected = shardCount ? rels.filter((_, k) => (k % shardCount) + 1 === shardIndex) : rels
if (shardCount) {
  say(`suites: discovered=${rels.length} shard=${shardIndex}/${shardCount} selected=${selected.length} template-excluded=${templateExcluded}`)
  if (selected.length === 0) {
    fail(`shard ${args.shard} selects 0 of ${rels.length} suites (N exceeds the discovery) — an empty slice is not a pass`)
    process.exit(1)
  }
} else {
  say(`suites: discovered=${rels.length} template-excluded=${templateExcluded}`)
}
for (const r of selected) say(`  - ${r}`)

if (args.list) {
  say('LIST ONLY — nothing ran')
  process.exit(0)
}

// --- running -------------------------------------------------------------------------------------------
const failed = []

// A child with its stdout and stderr passed straight through, for the gate.
function runStreamed(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
    child.on('error', (e) => { fail(`could not start ${path.basename(file)}: ${e.message}`); resolve(-1) })
    child.on('close', (code, signal) => resolve(code ?? (signal ? -1 : 0)))
  })
}

// The node --test child. Its stdout is printed line by line as it arrives and read for the reporter's line shapes
// at the same time. A line that does not start with PASS, FAIL or SKIP and a bracket is printed and not counted.
function runSuites(files) {
  const reporter = pathToFileURL(path.join(pluginDir, 'lib', 'selftest-reporter.mjs')).href
  const argv = ['--test', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', `--test-concurrency=${jobs}`, ...files]
  return new Promise((resolve) => {
    const counts = { pass: 0, fail: 0, skip: 0, empty: [] }
    const fileSet = new Set(files.map((f) => path.resolve(f)))
    let tail = ''
    const take = (line) => {
      const named = /^PASS \[(.+)\]$/u.exec(line)
      if (named && fileSet.has(path.resolve(named[1]))) counts.empty.push(named[1])
      else if (/^PASS \[/u.test(line)) counts.pass++
      else if (/^FAIL \[/u.test(line)) counts.fail++
      else if (/^SKIP \[/u.test(line)) counts.skip++
      say(line)
    }
    // The child loses NODE_TEST_CONTEXT: a node that inherits it from a parent test run writes a serialized
    // stream, not reporter lines. YWR_SELFTEST_STDOUT_INDENT makes the reporter indent each suite's own
    // output, so a suite that prints a `FAIL [x]` line of a child run never changes the counts here.
    // YWR_SELFTEST_OUTER_JOBS gives each suite its share of the CPUs (innerJobs of lib/selftest-lib.mjs). At most
    // min(jobs, suites) run at once, so one suite alone gets every CPU.
    const env = { ...process.env, YWR_SELFTEST_STDOUT_INDENT: '    ', YWR_SELFTEST_OUTER_JOBS: String(Math.min(jobs, files.length)) }
    delete env.NODE_TEST_CONTEXT
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, env })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      const parts = (tail + chunk).split(/\r?\n/u)
      tail = parts.pop()
      parts.forEach(take)
    })
    child.on('error', (e) => { fail(`could not start node --test: ${e.message}`); resolve({ code: -1, counts }) })
    child.on('close', (code, signal) => {
      if (tail) take(tail)
      resolve({ code: code ?? (signal ? -1 : 0), counts })
    })
  })
}

// Gate first, never a short-circuit: the suites run even when the gate failed.
const gate = path.join(pluginDir, 'manifest-gate.mjs')
if (!existsSync(gate)) {
  fail('manifest-gate.mjs missing (the wiring gate is not optional)')
  failed.push('manifest-gate.mjs (missing)')
} else {
  say('--- manifest-gate.mjs')
  const code = await runStreamed(gate)
  if (code !== 0) failed.push('manifest-gate.mjs')
}

say(`--- suites: ${selected.length} selected, jobs=${jobs}, one node --test run — every PASS, FAIL and SKIP line of the reporter follows`)
const run = await runSuites(selected.map((r) => path.join(pluginDir, ...r.split('/'))))
for (const f of run.counts.empty) {
  fail(`${toRel(f)} registered no test (a suite file that registers no test is not a pass)`)
  failed.push(`${toRel(f)} (no test)`)
}
if (run.code !== 0) failed.push(`node --test (exit ${run.code})`)
else if (run.counts.pass === 0 && run.counts.empty.length === 0) {
  fail(`node --test exited 0 but printed no PASS line for ${selected.length} suite file(s) — a suite that registers no test is not a pass`)
  failed.push('node --test (no PASS line)')
} else if (run.counts.fail > 0) {
  fail(`node --test exited 0 but printed ${run.counts.fail} FAIL line(s)`)
  failed.push('node --test (FAIL lines with exit 0)')
}

say('')
const shardNote = shardCount ? ` shard=${shardIndex}/${shardCount} selected=${selected.length}` : ''
say(`node-selftests: discovered=${rels.length}${shardNote} tests passed=${run.counts.pass} failed=${run.counts.fail} skipped=${run.counts.skip} (counts are tests, not suites)`)
if (failed.length) {
  fail(failed.join(', '))
  process.exit(1)
}
say(`ywr-harness plugin: node suites green, the pwsh suites did not run here${shardCount ? ` (shard ${shardIndex}/${shardCount})` : ''}`)
process.exit(0)
