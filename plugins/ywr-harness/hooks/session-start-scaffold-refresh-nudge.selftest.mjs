// Self-test for session-start-scaffold-refresh-nudge.mjs (ADR 0033).
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout hooks/session-start-scaffold-refresh-nudge.selftest.mjs
//
// Fixture provenance: the scaffolded fixtures are placed by the REAL init.mjs (one run, then
// tree copies) — a hand-copied placement would duplicate the map this hook exists not to
// duplicate, and would test the copy. The fixture-prep assertion below is what fails if
// init.mjs stops placing what the hook reads, which is exactly the coupling ADR 0033 accepts.
//
// The hook's verdict is filesystem-only (unlike the githooks sibling, whose verdict is git
// state), so almost every case runs on a git-less machine too: with git present the fixtures
// are real repos and the root is resolved by rev-parse; with git absent the hook's documented
// cwd-fallback carries the same verdicts. Only the git-dependent cases need git and
// are a reported SKIP without it (the Linux container), never a silent pass.
//
// Slice-note rule (ADR 0172): a scaffold that holds scripts/harness/slice_note.mjs is no longer silent when it
// has no drift: the hook then states the rule as additionalContext, and only that. The cases that used to assert
// byte-silence on a clean scaffold assert the rule instead (assertRuleOnly, the rule text pinned verbatim);
// the drift cases also assert the rule follows the drift text (assertRuleTail); the SCHEMA-DRIFT, EXTRACTION-DRIFT,
// foreign-tree and no-scaffold paths assert it is absent.
//
// Every match-based case carries mustNotMatch as well as mustMatch (the empty-MustNotMatch
// class), enforced by matchFailures of lib/selftest-lib.mjs.
//
// The independent cases run concurrently: each starts its hook as an asynchronous child, and a CPU-sized limit
// bounds how many are in flight. Some cases change a fixture that a later case reads (the one repo copy of the 3a
// cases, the upstream clones of 10b, the fake plugin cache and its stamped repo copy, the noNote copy). Those cases
// sit together in a nested describe of concurrency 1, in file order, and each change sits inside the first case that
// needs it, so the order of the cases in a chain is the order of the states. No case outside a chain changes a
// fixture that another case reads. The non-mutation cases run after the whole block. The pwsh suite
// named most cases without IDs. Each test here is `SR<n> <the old name>`, so the parity check of ADR 0227
// decision 8 matches the names. Patterns are pwsh -match sources (case-insensitive; see toRx in
// lib/selftest-lib.mjs). Git runs through scripts/harness_git.mjs, the one git subprocess boundary, for the
// fixtures and for the release-tag history read too.
//
// Every special character is built from a code point: the class under test is C0/DEL/NEL/LS/PS, and
// escape text for those can materialize as the literal character through an editor, so no such
// character, and no escape for one, appears in this source.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, matchFailures, toRx, innerJobs, shortAlias } from '../lib/selftest-lib.mjs'
import { git_absent, git_result, git_run, git_objects } from '../scripts/harness_git.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hook = path.join(here, 'session-start-scaffold-refresh-nudge.mjs')
const hookLib = path.join(here, 'hook-lib.mjs')                                  // the hook imports it: every copied hook needs it beside it
const gitLib = path.join(here, '../scripts/harness_git.mjs')                     // hook-lib imports it from <plugin>/scripts: a copied tree needs it there
const init = path.join(here, '../skills/harness-init/init.mjs')
const placement = path.join(here, '../skills/harness-init/placement.mjs')        // the placement map the hook imports
const templates = path.join(here, '../skills/harness-init/templates')
const R = String.raw
const ch = (...c) => String.fromCharCode(...c)
const win = process.platform === 'win32'
const gitOk = !git_absent()
// How many independent cases overlap. A case spends most of its time in a hook child process, so this is a CPU-sized pool.
const CONC = innerJobs(8, 2)

// Join-Path semantics: the child keeps its own slashes, so a fixture path has the same mixed shape on Windows
// that the pwsh suite handed the hook.
const J = (a, ...rest) => rest.reduce((acc, p) => acc.replace(/[\\/]+$/u, '') + path.sep + p, a)
const mk = (p) => { fs.mkdirSync(p, { recursive: true }); return p }
const rm = (p) => fs.rmSync(p, { recursive: true, force: true })
const copySync = (src, dest) => fs.cpSync(src, dest, { recursive: true, force: true })
// The copies inside the cases are asynchronous, so a copy overlaps the hook children of other cases instead of stalling them.
const copy = (src, dest) => fsp.cp(src, dest, { recursive: true, force: true })
const read = (p) => fs.readFileSync(p, 'utf8')
const write = (p, s) => fs.writeFileSync(p, s)                                   // [IO.File]::WriteAllText
const setContent = (p, s) => fs.writeFileSync(p, s + os.EOL)                     // Set-Content adds the platform newline
const addContent = (p, s) => fs.appendFileSync(p, s + os.EOL)                    // Add-Content adds the platform newline
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const lazy = (fn) => { let v; return () => (v ??= fn()) }
const has = (s, p) => toRx(p).test(s)
// The .NET Regex.Escape rule: a pattern that matches the text literally.
const rxEscape = (s) => s.replace(/[\\*+?|{}[\]()^$.# ]/gu, '\\$&').replace(/\n/gu, '\\n').replace(/\t/gu, '\\t')
const jsonOf = (out) => { try { return JSON.parse(out.trim()) } catch { return null } }

// stdin as pwsh piped it: the text plus one newline. stdout and stderr together, as `2>&1` read them.
// The run is asynchronous (spawn, not spawnSync) so independent cases overlap their hook starts; the result has the
// same shape the synchronous run had.
function invokeHook(stdin, { hookPath = hook, nodeArgs = [], env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, hookPath], { env, windowsHide: true })
    const outChunks = []; const errChunks = []
    child.stdout.on('data', (d) => outChunks.push(d))
    child.stderr.on('data', (d) => errChunks.push(d))
    child.stdin.on('error', () => {})   // the hook may exit before it reads all of stdin (EPIPE)
    child.on('error', () => resolve({ out: '', exit: null }))
    child.on('close', (code) => resolve({ out: Buffer.concat(outChunks).toString('utf8') + Buffer.concat(errChunks).toString('utf8'), exit: code }))
    child.stdin.end(Buffer.from(stdin + '\n', 'utf8'))
  })
}
// The child environment with PATH emptied: the pwsh suite cleared $env:PATH around the call. The node that
// runs the hook is started by its absolute path, so only the hook's own git lookup sees the empty PATH.
function envWithoutPath() {
  const e = {}
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'PATH') e[k] = v
  e.PATH = ''
  return e
}
const payload = (fields, source = 'startup') => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'selftest', source, ...fields })
const run = (cwd, opts) => invokeHook(payload({ cwd }), opts)

// The slice-note rule (ADR 0172), copied VERBATIM as a pin: a reword in the hook must fail here and be a decision.
const noteRule = "Slice notes (ywr-harness ADR 0172): record each decision of this slice when you make it, with its reason: `node scripts/harness/slice_note.mjs add <kind> \"<what and why>\"`. Kinds: decision (an option chosen), rejected (an option dropped), owner (the owner's answer), fact (a figure established at cost), risk (a known limit or an unverified point). A compaction re-injects the notes, and /ywr-harness:slice-close reads them into the close as input, never proof."
const ruleMark = R`Slice notes \(ywr-harness ADR 0172\)`   // a regex for a mustNotMatch: the rule's own first words
// The slice rules (ADR 0183), copied VERBATIM as a pin: the head line, then one line per rule, joined by LF.
const sliceHead = "ywr-harness slice rules for this repo (ywr-harness ADR 0183). The org guide states the general rules; this repo's CLAUDE.md states its own facts."
const sliceRuleLines = [
  "- Review: before a slice closes, run `/code-review` through the Skill tool: `medium` for a small tier and for a full tier (ywr-harness ADR 0215, ywr-harness ADR 0218). `/ywr-harness:slice-close` makes the call. Every finding gets a bucket: fixed, valid with no action, or false on reading. The review invariants are in the file that `.harness.json` `review.canon` names: the `## Review canon` section of `CLAUDE.md` in a new scaffold, where this repo's own invariants replace the harness-init starters (ywr-harness ADR 0217).",
  "- The review runs once per slice. Every finding gets one of three buckets. The severity limits the bucket: an `important`, `pre_existing` or ungraded finding ends fixed or false on reading, only a `nit` whose fix would change a design or a coverage ends valid with no action with an open item, and a fix that rests on an untested host behaviour gets a probe first; when the owner defers that probe, the finding ends valid with no action as an owner decision, with an open item (ywr-harness ADR 0216). A fix closes with re-run gates over its own files, and every fixed finding except a `nit` gets one fix check (ywr-harness ADR 0215). No fix gets a re-review. When a fix needs more review, record an open item: `node scripts/harness/slice_note.mjs add risk \"open item: review <files and lines> of the <file:line> fix; <why>\"`. A separate rule: a rebase or merge after the review re-arms it only over the overlap: reviewed files that the incoming commits touched, plus each hand-resolved conflict. An empty overlap keeps the review, recorded in the close as `review basis:` (ywr-harness ADR 0028, ywr-harness ADR 0072, ywr-harness ADR 0200).",
  "- The close: `/ywr-harness:slice-close` writes the handoff and the one commit. The person types it, or the main session calls it; a subagent never calls it (ywr-harness ADR 0201). The session prepares the close: it runs every command that `node scripts/harness/harness_gates.mjs` printed, the review with its fix checks, and verify. It writes no handoff and makes no commit itself. Its ready report ends with the line that `node scripts/harness/harness_gates.mjs --tree` printed after the final edit. After the report the session asks each open owner question with AskUserQuestion, then calls the skill. The close reuses the report only while it is verbatim in the same session and that line is unchanged; a new session or a compaction summary runs the full close (ywr-harness ADR 0105).",
  "- Handoff: the `handoff` key in `.harness.json` names the resume file. A value that ends in `/` names a directory with one resume file per work line, named after the work line, never after a person. The close that supersedes a `## Current state` section moves it to `docs/handoff-archive/<same filename>`, newest first (ywr-harness ADR 0040).",
  "- Artifacts: a claude.ai Artifact that this repo publishes has the title `<repo-name> · <purpose>` and is declared under `artifacts` in `.harness.json`; CI then fails when the README lacks its link. A generated Artifact also declares its committed `source` file and a `check` drift gate, and `/ywr-harness:artifact-publish` republishes it with one confirmation, never headless (ywr-harness ADR 0032, ywr-harness ADR 0068).",
]
const sliceRules = [sliceHead, ...sliceRuleLines].join('\n')
// The copy note (ADR 0183): the whole text where the repo CLAUDE.md copies every part.
const copyNote = "This repo's CLAUDE.md or .claude/CLAUDE.md holds its own copy of part of the ywr-harness slice rules, so the plugin does not repeat that part here. After that copy is deleted, the plugin states the current rules at each session start (ywr-harness ADR 0183)."
// A fresh scaffold holds `.harness.json`, `slice_note.mjs` and a seed CLAUDE.md with no copy: both parts, a blank line between.
const ruleText = sliceRules + '\n\n' + noteRule

// Envelope adapter (file-specific): the nudge speaks through systemMessage + optional additionalContext, so
// the matched text is both joined — a pattern that lives only in the context half (the direction-blindness
// caveat) still gets asserted. When additionalContext is present its hookEventName must be SessionStart, or
// the runtime drops it.
function nudgeFailures({ out, exit }, mustMatch, mustNotMatch, noNegative = '') {
  const pre = []
  if (exit !== 0) pre.push(`exit ${exit} (want 0 — fail-open contract; SessionStart blocks nothing)`)
  let sys = ''; let ctx = ''; let evName = ''
  try {
    const j = JSON.parse(out.trim())
    sys = String(j.systemMessage ?? '')
    ctx = String(j.hookSpecificOutput?.additionalContext ?? '')
    evName = String(j.hookSpecificOutput?.hookEventName ?? '')
  } catch { pre.push('stdout is not valid JSON') }
  if (!sys) pre.push('no systemMessage')
  if (ctx && evName !== 'SessionStart') pre.push(`hookSpecificOutput.hookEventName is '${evName}' (want SessionStart — the runtime drops the context otherwise)`)
  // The slice rules name harness_gates.mjs; a placeholder keeps the file-list patterns about the file list.
  ctx = ctx.split(sliceRules).join('<SLICE_RULES>')
  return matchFailures(`${sys}\n${ctx}`, { mustMatch, mustNotMatch, noNegative, preFail: pre, label: 'output' })
}
function assertNudge(r, mustMatch, mustNotMatch) {
  const f = nudgeFailures(r, mustMatch, mustNotMatch)
  assert.deepEqual(f, [], `${f.join(' · ')}\n--- output ---\n${r.out}`)
}
function assertEmptyStdout({ out, exit }) {
  const f = []
  if (exit !== 0) f.push(`exit ${exit} (want 0 — fail-open contract)`)
  // Plain stdout on exit 0 becomes session context for this event, so "silent" must mean
  // BYTE-silent — a stray warning line would be injected into every session's context.
  if (out.trim()) f.push(`expected empty stdout, got: ${out.trim()}`)
  assert.deepEqual(f, [], f.join(' · '))
}
// A repo with the vendored script and NO drift: the rule is the WHOLE output — additionalContext equal to the
// rule, event SessionStart, and no systemMessage (nothing for a person to act on). Never "silent" any more.
function assertRuleOnly({ out, exit }, expected = ruleText) {
  const fails = []
  if (exit !== 0) fails.push(`exit ${exit} (want 0 — fail-open contract)`)
  let sys = ''; let ctx = ''; let evName = ''; let keys = ''
  try {
    const j = JSON.parse(out.trim())
    sys = String(j.systemMessage ?? '')
    keys = Object.keys(j).join(',')
    ctx = String(j.hookSpecificOutput.additionalContext)
    evName = String(j.hookSpecificOutput.hookEventName)
  } catch { fails.push('stdout is not valid JSON') }
  if (sys) fails.push(`unexpected systemMessage: ${sys}`)
  if (keys !== 'hookSpecificOutput') fails.push(`top-level keys [${keys}] (want only hookSpecificOutput)`)
  if (evName !== 'SessionStart') fails.push(`hookEventName '${evName}' (want SessionStart)`)
  if (ctx !== expected) fails.push(`additionalContext is not exactly the rule: [${ctx}]`)
  assert.deepEqual(fails, [], `${fails.join(' · ')}\n--- output ---\n${out}`)
}
// A drift verdict: additionalContext must END with the rule, set off by ONE blank line, and the drift text
// must come first. Run next to the assertNudge of the same output.
function assertRuleTail({ out }) {
  const fails = []
  let ctx = ''
  try { ctx = String(JSON.parse(out.trim()).hookSpecificOutput.additionalContext) } catch { fails.push('stdout is not valid JSON') }
  if (!ctx.endsWith(`\n\n${ruleText}`)) fails.push('additionalContext does not end with a blank line and the rule')
  if (ctx.length <= ruleText.length + 2) fails.push('no drift text precedes the rule')
  if (ctx.indexOf(ruleText) !== ctx.lastIndexOf(ruleText)) fails.push('the rule appears more than once')
  if (ctx.length > 6000) fails.push(`context is ${ctx.length} characters (the host caps a hook string at 10,000; this one should stay far below)`)
  assert.deepEqual(fails, [], `${fails.join(' · ')}\n--- output ---\n${out}`)
}
// The banner and the context of a run that must be a nudge with a context half.
const halves = (out) => { const j = jsonOf(out); return { j, sys: String(j?.systemMessage ?? ''), ctx: String(j?.hookSpecificOutput?.additionalContext ?? '') } }

// The git-dependent cases are a reported SKIP without git, never a silent pass.
const gtest = gitOk ? test : (name, fn) => test(name, { skip: 'git not on PATH — git-dependent case not run (reported, not silent)' }, fn)
const gitInit = (p, ...extra) => git_result(fx, ['-c', 'init.defaultBranch=main', 'init', '-q', ...extra, p])

const fx = fixtureRoot('ssrn-selftest')
process.on('exit', () => removeFixtureRoot(fx))
const mfVer = JSON.parse(read(path.join(here, '../.claude-plugin/plugin.json'))).version

// A `node -r` preload that wraps spawnSync and logs each git call, so "spawns no git" is observed, not assumed.
// Every spied run gets its own log file, because spied runs overlap.
let spySeq = 0
const spyPre = J(fx, 'git-spy.cjs')
write(spyPre, `const cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path')
const real = cp.spawnSync
cp.spawnSync = function (cmd) {
  const base = path.basename(String(cmd)).toLowerCase()
  if (base === 'git' || base === 'git.exe') fs.appendFileSync(process.env.YWR_SPY_LOG, 'git\\n')
  return real.apply(this, arguments)
}
`)
async function invokeSpied(cwd) {
  const spyLog = J(fx, `git-spy-${++spySeq}.log`)
  const r = await run(cwd, { nodeArgs: ['-r', spyPre], env: { ...process.env, YWR_SPY_LOG: spyLog } })
  const gitCalls = fs.existsSync(spyLog) ? read(spyLog).split('\n').filter(Boolean).length : 0
  return { ...r, gitCalls }
}

// --- fixtures --------------------------------------------------------------------------------
// ONE real scaffold run, then tree copies (with .git when present) — each variant then mutates
// exactly the file family its case is about.
const base = mk(J(fx, 'repo-base'))
if (gitOk) gitInit(base)
spawnSync(process.execPath, [init, '--target', base], { stdio: 'ignore', windowsHide: true })

const fresh = J(fx, 'repo-fresh')
const stale = J(fx, 'repo-stale')
const seed = J(fx, 'repo-seededit')
const crlf = J(fx, 'repo-crlf')
const foreignpc = J(fx, 'repo-foreignpc')
const ourspc = J(fx, 'repo-ourspc')
const many = J(fx, 'repo-manydrift')
for (const v of [fresh, stale, seed, crlf, foreignpc, ourspc, many]) copySync(base, v)
// stale: one modified vendored script + one deleted CI workflow (differs AND missing in one verdict)
addContent(J(stale, 'scripts/harness/harness_gates.mjs'), '# selftest drift')
rm(J(stale, '.github/workflows/harness-gates.yml'))
mk(J(stale, 'subA/subB'))
// seed edits only: every SEED family touched, no TOOLCHAIN file
addContent(J(seed, 'CLAUDE.md'), 'repo decision')
addContent(J(seed, '.harness.json'), ' ')
addContent(J(seed, '.gitattributes'), '*.bin binary')
addContent(J(seed, '.githooks/slice-retro-ignore'), '# exempt')
// crlf: same bytes modulo line endings (LF -> CRLF, byte-level so no decode can shift content)
{
  const pcPath = J(crlf, '.githooks/pre-commit')
  const out = []
  for (const b of fs.readFileSync(pcPath)) { if (b === 10) out.push(13); out.push(b) }
  fs.writeFileSync(pcPath, Buffer.from(out))
}
// foreign post-commit: no marker -> init.mjs refuses it -> the hook must skip it the same way
setContent(J(foreignpc, '.githooks/post-commit'), '#!/bin/sh\nexit 0')
// ours post-commit: marker retained, content drifted
addContent(J(ourspc, '.githooks/post-commit'), 'echo extra')
// manydrift: seven TOOLCHAIN placements drifted -> the list caps at 5 and STATES the cap
for (const rel of ['docs/README.md', 'docs/adr/README.md', 'docs/spec/README.md', 'docs/build.mjs',
  'docs/build.sh', 'docs/build_docs.mjs', 'scripts/harness/harness_config.mjs']) addContent(J(many, rel), '# drift')
// not-ours: a scripts/harness/ directory that is NOT a scaffold (file-level sentinel must gate)
const notours = J(fx, 'repo-notours')
mk(J(notours, 'scripts/harness'))
setContent(J(notours, 'scripts/harness/own_tool.py'), 'pass')
// bare: a repo with no scripts/harness at all
const bare = mk(J(fx, 'repo-bare'))
if (gitOk) for (const r of [notours, bare]) gitInit(r)
const plain = mk(J(fx, 'plain-dir'))
// non-mutation baseline (asserted at the end): the hook must never write
const freshHash = sha256(J(fresh, 'docs/build_docs.mjs'))
const staleHash = sha256(J(stale, 'scripts/harness/harness_gates.mjs'))

test('SR1 fixture: real init.mjs scaffolded the base repo', async () => {
  assert.ok(fs.existsSync(J(base, 'scripts/harness/harness_gates.mjs')) && fs.existsSync(J(base, '.githooks/post-commit')),
    'init.mjs did not place the files this suite mutates — every later verdict would be about a broken fixture')
})

// Every case below runs inside one describe with a concurrency limit; the order-dependent chains are nested describes of
// concurrency 1, because each of their cases reads what an earlier case left in the shared fixture.
describe('scaffold-refresh-nudge cases', { concurrency: CONC }, () => {

// 1. the drifted repo nudges — the fixture was scaffolded by THIS plugin and then hand-mutated,
//    so its .harness-version stamp EQUALS the running version and the ADR 0042 verdict is the
//    hand-edit reading: count, both file names (differ + missing), version, the
//    REVERT-hand-edits warning, the suggest-only contract.
const staleRun = lazy(() => run(stale))
test('SR2 drifted scaffold at the same version reads as a hand-edit', async () => {
  assertNudge(await staleRun(),
    [R`\[hook:scaffold-refresh-nudge\]`, 'repo-stale', '2개의 벤더링된 툴체인 파일', R`v\d+\.\d+\.\d+`,
      R`harness_gates\.mjs`, R`harness-gates\.yml \(missing\)`, 'EQUALS', 'hand-edit',
      'REVERT', '제안만 합니다'],
    ['SCHEMA DRIFT', 'EXTRACTION DRIFT', R`\+\d+ more`, '기준이 STALE', 'direction-blind',
      '리프레시: 이 저장소에서', 'NEWER합니다', 'OLDER합니다', 'ADR 0135', '다른 클론'])
})
test('SR3 1 hand-edit branch: the rule follows the drift text', async () => { assertRuleTail(await staleRun()) })

// 1b. REPO-AHEAD (ADR 0042): stamp newer than the running plugin — the multi-writer everyday
//     state (another writer refreshed this repo with a newer release). The advice must FLIP:
//     update the plugin, do NOT init — and the refresh command must not appear as advice.
const aheadRun = lazy(async () => {
  const ahead = J(fx, 'repo-ahead')
  await copy(stale, ahead)
  setContent(J(ahead, '.harness-version'), '99.0.0')
  return await run(ahead)
})
test('SR4 repo-ahead stamp flips the advice to update-the-plugin', async () => {
  assertNudge(await aheadRun(),
    [R`v99\.0\.0`, 'NEWER합니다', '/ywr-harness:harness-init을 실행하지 마세요',
      '/ywr-harness:update', '리프레시를 REVERT', '제안만 합니다'],
    ['리프레시: 이 저장소에서', '시드는 보존', '기준이 STALE', 'direction-blind', 'SCHEMA DRIFT',
      'EXTRACTION DRIFT'])
})
test('SR5 1b repo-ahead branch: the rule follows the drift text', async () => { assertRuleTail(await aheadRun()) })

// 1c. REPO-BEHIND: stamp older than the running plugin — the one state where the refresh advice
//     is measured, not guessed. The pre-0042 uncaveated human banner ('re-run is safe:' without
//     'here') is a deliberate ANTI-anchor: its reappearance fails this case.
const behindRun = lazy(async () => {
  const behind = J(fx, 'repo-behind')
  await copy(stale, behind)
  setContent(J(behind, '.harness-version'), '0.0.1')
  return await run(behind)
})
test('SR6 repo-behind stamp keeps the refresh advice, direction measured', async () => {
  assertNudge(await behindRun(),
    [R`v0\.0\.1`, 'OLDER합니다', '측정된 것입니다', '여기서는',
      '리프레시: 이 저장소에서 /ywr-harness:harness-init', '시드는 보존', '제안만 합니다'],
    ['리프레시를 REVERT', 'direction-blind',
      '기준이 STALE', 'SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})
test('SR7 1c repo-behind branch: the rule follows the drift text', async () => { assertRuleTail(await behindRun()) })

// 1d. NO STAMP (every pre-0042 repo): direction-blind — and the caveat must now sit on the
//     HUMAN surface too, not only in additionalContext: the 2026-08-10 audit's asymmetry
//     (an uncaveated 're-run is safe' banner over a caveated context) is what this anchors.
const nostampRun = lazy(async () => {
  const nostamp = J(fx, 'repo-nostamp')
  await copy(stale, nostamp)
  rm(J(nostamp, '.harness-version'))
  return await run(nostamp)
})
test('SR8 stampless repo gets the direction-blind caveat', async () => {
  assertNudge(await nostampRun(),
    ['direction-blind', R`읽을 수 있는 \.harness-version 스탬프 없음`, 'REVERT', '실행하기 전에',
      '/ywr-harness:update', '제안만 합니다'],
    ['EQUALS', 'NEWER합니다', 'OLDER합니다',
      '기준이 STALE', 'SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})
test('SR9 1d direction-blind branch: the rule follows the drift text', async () => { assertRuleTail(await nostampRun()) })
test('SR10 1d the caveat is in the HUMAN banner, not only the context half', async () => {
  const { sys } = halves((await nostampRun()).out)
  assert.ok(has(sys, 'direction-blind') && has(sys, 'REVERT'), `systemMessage='${sys}'`)
})

// 1e. a stamp with NO newline and megabytes of one-line content must degrade to the
//     direction-blind branch via the BOUNDED read — never a whole-file read on the SessionStart
//     hot path (review 2026-08-10, medium). The device-symlink hang leg is not portably
//     testable; the bounded read retires the class by construction, and this case pins the
//     parse-failure fallback and the clean envelope on the closest committable input.
test('SR11 huge one-line stamp degrades to direction-blind cleanly', async () => {
  const hugestamp = J(fx, 'repo-hugestamp')
  await copy(stale, hugestamp)
  write(J(hugestamp, '.harness-version'), '1.2.3' + 'x'.repeat(5 * 1024 * 1024))
  assertNudge(await run(hugestamp),
    ['direction-blind', R`읽을 수 있는 \.harness-version 스탬프 없음`],
    ['NEWER합니다', 'OLDER합니다', 'EQUALS', '기준이 STALE',
      'SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})

// 1f. component-count normalization (review 2026-08-10, low): a 4-component stamp X.0 names the
//     SAME release as running X, but [version] pads missing components with -1, so without
//     normalization it reads NEWER (revision 0 > -1) and flips the advice to update-the-plugin
//     for a repo that is not ahead. Version-independent fixture: stamp = <manifest>.0.
test('SR12 a 4-component stamp naming the same release reads as EQUALS, not ahead', async () => {
  const padstamp = J(fx, 'repo-padstamp')
  await copy(stale, padstamp)
  setContent(J(padstamp, '.harness-version'), `${mfVer}.0`)
  assertNudge(await run(padstamp),
    ['EQUALS', 'hand-edit'],
    ['NEWER합니다', '/ywr-harness:harness-init을 실행하지 마세요', '기준이 STALE',
      'SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})

// 1g. the shapes a hand-edited or tool-written stamp takes (ADR 0042), read through the bounded 64-byte
//     read: BOM + `v` prefix + CRLF + a second line still names the running release; a two-component
//     stamp is padded, not compared against -1; five components, junk and a non-ASCII byte (the .NET
//     ASCII decode turns it into `?`) are unreadable and degrade to direction-blind.
const stampCases = [
  { n: 'BOM, v prefix, CRLF and a second line still read as the running release', text: ch(0xfeff) + `v${mfVer}\r\nsecond line`,
    want: ['EQUALS', 'hand-edit'], not: ['NEWER합니다', 'OLDER합니다', 'direction-blind', 'SCHEMA DRIFT'] },
  { n: 'an upper-case V prefix reads too', text: `V${mfVer}`,
    want: ['EQUALS'], not: ['NEWER합니다', 'OLDER합니다', 'direction-blind', 'SCHEMA DRIFT'] },
  { n: 'a two-component stamp below the running version is OLDER', text: '0.1',
    want: [R`v0\.1`, 'OLDER합니다'], not: ['NEWER합니다', 'EQUALS', 'direction-blind', 'SCHEMA DRIFT'] },
  { n: 'five components is invalid -> direction-blind', text: '1.2.3.4.5',
    want: ['direction-blind'], not: ['NEWER합니다', 'OLDER합니다', 'EQUALS', 'SCHEMA DRIFT'] },
  { n: 'a component beyond Int32 is invalid -> direction-blind', text: '99999999999.0.0',
    want: ['direction-blind'], not: ['NEWER합니다', 'OLDER합니다', 'EQUALS', 'SCHEMA DRIFT'] },
  { n: 'junk is invalid -> direction-blind', text: 'not-a-version',
    want: ['direction-blind'], not: ['NEWER합니다', 'OLDER합니다', 'EQUALS', 'SCHEMA DRIFT'] },
  { n: 'a non-ASCII byte makes the token unreadable -> direction-blind', text: `${mfVer}${ch(0xe9)}`,
    want: ['direction-blind'], not: ['NEWER합니다', 'OLDER합니다', 'EQUALS', 'SCHEMA DRIFT'] },
  { n: 'an empty stamp -> direction-blind', text: '',
    want: ['direction-blind'], not: ['NEWER합니다', 'OLDER합니다', 'EQUALS', 'SCHEMA DRIFT'] },
]
stampCases.forEach((sc, i) => {
  test(`SR13 1g ${sc.n}`, async () => {
    const sd = J(fx, `repo-stamp${i + 1}`)
    await copy(stale, sd)
    fs.writeFileSync(J(sd, '.harness-version'), Buffer.from(sc.text, 'utf8'))
    assertNudge(await run(sd), sc.want, sc.not)
  })
})
// a stamp that is a DIRECTORY is not a stamp (Leaf only) -> direction-blind, and the hook must not hang or fail
test('SR14 1g a .harness-version directory is no stamp', async () => {
  const sdir = J(fx, 'repo-stampdir')
  await copy(stale, sdir)
  rm(J(sdir, '.harness-version'))
  mk(J(sdir, '.harness-version'))
  assertNudge(await run(sdir), ['direction-blind'], ['NEWER합니다', 'OLDER합니다', 'EQUALS', 'SCHEMA DRIFT'])
})

// 2. freshly scaffolded repo -> NO drift, but the scaffold holds slice_note.mjs (the template map places it), so
//    the slice-note rule (ADR 0172) is the whole output: additionalContext only, exactly the rule, no systemMessage.
test('SR15 fresh scaffold states only the slice-note rule', async () => { assertRuleOnly(await run(fresh)) })

// 2a. SAME repo on every other source: the hook is matcher-less, so a compaction (and a start, resume, clear, fork)
//     carries the rule too — it is the one fact a compaction summary loses and this hook re-injects.
for (const src of ['compact', 'startup', 'resume', 'clear', 'fork']) {
  test(`SR16 2a source=${src} still states the rule`, async () => {
    assertRuleOnly(await invokeHook(payload({ cwd: fresh }, src)))
  })
}

describe('2b chain', { concurrency: 1 }, () => {
// 2b. the vendored script absent -> the placement map says it is missing -> drift, named `(missing)`, and NO rule:
//     the rule is a fact about a scaffold that holds the script. The file must also be a FILE: a directory of that
//     name is no script (isFile), the same drift and the same absence of the rule.
const noNote = J(fx, 'repo-nonote')
test('SR17 2b identical placements but slice_note.mjs absent: drift (missing), no rule', async () => {
  await copy(base, noNote)
  rm(J(noNote, 'scripts/harness/slice_note.mjs'))
  assertNudge(await run(noNote),
    ['1개의 벤더링된 툴체인 파일', R`slice_note\.mjs \(missing\)`, '제안만 합니다'],
    [ruleMark, 'SCHEMA DRIFT', 'EXTRACTION DRIFT', R`node scripts/harness/slice_note\.mjs add`])
})
test('SR18 2b a directory named slice_note.mjs is no script: drift (missing), no rule', async () => {
  const noteDir = J(fx, 'repo-notedir')
  await copy(noNote, noteDir)
  mk(J(noteDir, 'scripts/harness/slice_note.mjs'))
  assertNudge(await run(noteDir), [R`slice_note\.mjs \(missing\)`], [ruleMark, 'SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})

})

// 2c. a repo that is scaffolded and DRIFTED, with the script present: the drift text first, then the rule
//     (see the assertRuleTail calls beside the drift cases 1, 1b, 1c, 1d, 10b-2 and 13b for each branch).
const compactRun = lazy(() => invokeHook(payload({ cwd: stale }, 'compact')))
test('SR19 2c drift on a compact start: the nudge is unchanged', async () => {
  assertNudge(await compactRun(),
    ['repo-stale', '2개의 벤더링된 툴체인 파일', 'hand-edit', '제안만 합니다', rxEscape(`<SLICE_RULES>\n\n${noteRule}`)],
    ['SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})
test('SR20 2c drift on a compact start: the rule follows the drift text', async () => { assertRuleTail(await compactRun()) })

// 3. SEED-only edits -> no drift: seeds are the repo's decisions, never compared (ADR 0033). The rule only.
test('SR21 seed edits state only the rule (no drift)', async () => { assertRuleOnly(await run(seed)) })

describe('3a-3d chain', { concurrency: 1 }, () => {
// 3a. A repo CLAUDE.md that still holds the pre-0.72.0 seed copy (ADR 0183) never gets a rule twice. Each rule has
//     its own markers: phrases only its old seed bullet held, in CLAUDE.md or .claude/CLAUDE.md. A left-out rule is
//     replaced by the copy note. A bare mention of the workflow, the command or an ADR citation is no copy. An
//     unreadable CLAUDE.md is no copy. No .harness.json: the slice-note rule alone.
const oldSeed = `- Adversarial code review before closing a slice (\`/ywr-harness:slice-close\` builds the call):
  Put house-specific review angles in \`args.lensExtra\` rather than redefining the lens set.
- The review runs once per slice ... recorded in the close as \`review basis:\` (ywr-harness ADR 0072).
- The close is owner-typed: \`/ywr-harness:slice-close\` writes the handoff (ywr-harness ADR 0105).
- A claude.ai Artifact this repo publishes is titled **\`<repo-name> · <purpose>\`** (ywr-harness ADR 0032).
- Record each decision: \`node scripts/harness/slice_note.mjs add <decision|rejected|owner|fact|risk> "<what and why>"\`.
- the close moves it to \`docs/handoff-archive/<same filename>\`, newest first (ywr-harness ADR 0040).
`
// One copy serves every 3a case (a full copy per case cost about 0.3 s each); each case rewrites only the files
// it is about, and the last case removes .harness.json.
const cp = J(fx, 'repo-copy3a')
const cpClaude = J(cp, 'CLAUDE.md')
let seedText = ''
let run3a
const setCopyClaude = (extra) => write(cpClaude, seedText + '\n' + extra + '\n')

test('SR22 3a the old seed copies every rule, its close bullet is retired: the close rule, the copy note, the retired part', async () => {
  await copy(fresh, cp)
  seedText = read(cpClaude)
  setCopyClaude(oldSeed)
  const r = await run(cp)
  // ADR 0197 retired sessionModel and the ADR 0190 review-call fill: a copy without it gets no fill. The old close bullet
  // holds retired text (ADR 0207, `The close is owner-typed`), so that copy is no copy: the close rule is stated, the other
  // copied rules stay left out, the copy note follows, the retired-text part comes last, and a person gets one line.
  assertNudge(r,
    [rxEscape('CLAUDE.md (`The close is owner-typed`: v0.72.0, ywr-harness ADR 0201)'), 'seed 파일 1개', '직접 고쳐야', 'ADR 0207', '제안만 합니다'],
    ['SCHEMA DRIFT', 'EXTRACTION DRIFT', '템플릿과 다릅니다', 'Put house review angles', 'review basis:', ruleMark])
  run3a = r
})
test('SR23 3a the retired close copy: exactly the head and the close rule, the copy note, then the retired part', async () => {
  const { ctx } = halves(run3a.out)
  assert.ok(ctx.startsWith([sliceHead, sliceRuleLines[2]].join('\n') + '\n\n' + copyNote + '\n\nRetired seed text (ywr-harness ADR 0207): '),
    `additionalContext: [${ctx}]`)
})

// 3b. Retired seed text (ADR 0207), driven by the hook's own table: every phrase goes into every file its row names,
//     so every row must fire once per file. CLAUDE.md gets each phrase wrapped over lines (the match collapses
//     whitespace); .claude/CLAUDE.md gets it on one line, so its copy markers hit and the restated rules prove that a
//     copy holding retired text is no copy. One hook run without drift, one with drift; the same repo copy as 3a.
// The table is read out of the hook source, from `const CLAUDE_FILES` to the closing bracket of RETIRED_SEED, and
// evaluated alone, as the pwsh suite did in a node -e call. The hook is never imported: its last lines read stdin and
// run main on load.
const hookSrc = read(hook)
const tableFrom = hookSrc.indexOf('const CLAUDE_FILES')
const tableTo = hookSrc.indexOf('\n]', hookSrc.indexOf('const RETIRED_SEED')) + 2
const retiredRows = new Function(`${hookSrc.slice(tableFrom, tableTo)};return RETIRED_SEED`)()
test('SR24 3b the retired table reads from the hook', async () => {
  assert.ok(retiredRows.length > 0 && !retiredRows.some((r) => !r.phrase), `rows: ${retiredRows.length}`)
})
const squashed = (text) => text.replace(/\s+/gu, ' ')
test('SR25 3b each row: a real seed placement, absent from the current seed and from the slice rules, a well-formed version and ADR', async () => {
  const pinned = squashed(sliceRules + ' ' + noteRule + ' ' + copyNote)
  const tableFails = []
  for (const row of retiredRows) {
    if (!/^\d+\.\d+\.\d+$/u.test(row.version) || !/^\d{4}$/u.test(row.adr)) tableFails.push(`${row.phrase}: version '${row.version}' or adr '${row.adr}' is malformed`)
    if (pinned.includes(row.phrase)) tableFails.push(`${row.phrase}: the current slice rules hold it`)
    for (const f of row.files) {
      // .claude/CLAUDE.md is no placement; its seed text is CLAUDE.md's.
      const placed = J(base, f === '.claude/CLAUDE.md' ? 'CLAUDE.md' : f)
      const isFile = fs.existsSync(placed) && fs.statSync(placed).isFile()
      // REVIEW.md is the one retired file: no scaffold places it any more, but a repo that older scaffolds seeded keeps it
      // and an import can load it as the review canon, so the hook still scans it for retired text.
      if (f === 'REVIEW.md' && !isFile) continue
      if (!isFile) { tableFails.push(`${f}: the real init.mjs places no such seed`); continue }
      if (squashed(read(placed)).includes(row.phrase)) tableFails.push(`${row.phrase}: the current seed ${f} holds it`)
    }
  }
  assert.deepEqual(tableFails, [], tableFails.join(' · '))
})

// The version of each row against history (review F1 of slice 236): the seed at the row's release lacks the phrase,
// and the seed at the release before it holds it. The release tags are `ywr-harness--vX.Y.Z`; a checkout without them
// (the CI checkout is shallow) is a reported SKIP. One git cat-file --batch call reads every seed.
const canonRoot = path.resolve(here, '../../..')
const vcmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0 }
let tagVers = []
if (gitOk) {
  try {
    tagVers = git_run(canonRoot, ['tag', '--list', 'ywr-harness--v*']).split('\n').map((l) => l.trim().replace(/^ywr-harness--v/u, ''))
      .filter((v) => /^\d+\.\d+\.\d+$/u.test(v)).sort(vcmp)
  } catch { tagVers = [] }
}
const tagsOk = tagVers.length >= 2
const histName = tagsOk
  ? '3b each row version against the release tags: its release seed lacks the phrase, the release before holds it'
  : '3b each row version against the release tags'
test(`SR26 ${histName}`, { skip: tagsOk ? false : 'no ywr-harness--v* release tags in this checkout' }, async () => {
  // A row of the version that plugin.json names, before its tag exists, reads that release's seed from the working tree.
  const curVer = JSON.parse(read(path.join(canonRoot, 'plugins/ywr-harness/.claude-plugin/plugin.json'))).version
  const specs = []
  for (const row of retiredRows) {
    const prev = tagVers.filter((v) => vcmp(v, row.version) < 0).at(-1)
    const untagged = row.version === curVer && !tagVers.includes(row.version)
    for (const f of row.files) {
      const tmpl = 'plugins/ywr-harness/skills/harness-init/templates/' + (f === '.claude/CLAUDE.md' ? 'CLAUDE.md' : f)
      specs.push({ phrase: row.phrase, file: f, at: untagged ? `WT:${tmpl}` : `ywr-harness--v${row.version}:${tmpl}`, before: prev ? `ywr-harness--v${prev}:${tmpl}` : '' })
    }
  }
  const text = {}
  for (const s of specs) if (s.at.startsWith('WT:')) {
    const p = path.join(canonRoot, s.at.slice(3))
    text[s.at] = fs.existsSync(p) ? squashed(read(p)) : null
  }
  const names = [...new Set(specs.flatMap((s) => [s.at, s.before]).filter((n) => n && !n.startsWith('WT:')))]
  const got = git_objects(canonRoot, names)
  names.forEach((n, i) => { text[n] = got[i] === null ? null : squashed(got[i].text) })
  const fails = []
  for (const s of specs) {
    // The REVIEW.md seed left the scaffold, so the release that removed it has no seed to lack the phrase; the release
    // before must still hold it.
    if (text[s.at] === undefined || text[s.at] === null) { if (s.file !== 'REVIEW.md') fails.push(`${s.phrase} @ ${s.file}: no seed at ${s.at}`) }
    else if (text[s.at].includes(s.phrase)) fails.push(`${s.phrase} @ ${s.file}: the seed of its release still holds it (${s.at})`)
    if (!s.before) fails.push(`${s.phrase} @ ${s.file}: no release before its version`)
    else if (!text[s.before] || !text[s.before].includes(s.phrase)) fails.push(`${s.phrase} @ ${s.file}: the seed of the release before does not hold it (${s.before})`)
  }
  assert.deepEqual(fails, [], fails.join('\n'))
})

const retFiles = new Map()
for (const row of retiredRows) for (const f of row.files) { if (!retFiles.has(f)) retFiles.set(f, []); retFiles.get(f).push(row.phrase) }
let run3b
test('SR27 3b every retired phrase in every file it names: one line names each file, no drift', async () => {
  mk(J(cp, '.claude'))
  for (const [f, lines] of retFiles) {
    if (f === 'CLAUDE.md') { setCopyClaude(lines.map((p) => '- ' + p.replace(/ /gu, '\n  ')).join('\n')); continue }
    addContent(J(cp, f), lines.map((p) => `- ${p}`).join('\n'))
  }
  run3b = await run(cp)
  const retPatterns = [`seed 파일 ${retFiles.size}개`, '직접 고쳐야', rxEscape(path.join('harness-init', 'templates'))]
  assertNudge(run3b, retPatterns, ['SCHEMA DRIFT', 'EXTRACTION DRIFT', '템플릿과 다릅니다', R`\+\d+ more`])
})
test('SR28 3b each row fires once per file, the once and close rules are restated, the retired part is last', async () => {
  const { sys: sys3b, ctx: ctx3b } = halves(run3b.out)
  const rowFails = []
  for (const row of retiredRows) {
    const item = `\`${row.phrase}\`: v${row.version}, ywr-harness ADR ${row.adr}`
    const n = sys3b.split(item).length - 1
    if (n !== row.files.length) rowFails.push(`${row.phrase}: ${n} hits in the line (want ${row.files.length})`)
  }
  const lastPart = ctx3b.substring(ctx3b.lastIndexOf('\n\n') + 2)
  if (!lastPart.startsWith('Retired seed text (ywr-harness ADR 0207): ')) rowFails.push('the retired part is not the last part of additionalContext')
  for (const i of [1, 2]) if (!ctx3b.includes(sliceRuleLines[i])) rowFails.push(`slice rule ${i} is not restated although its copy holds retired text`)
  if (ctx3b.length > 9000 || sys3b.length > 9000) rowFails.push(`a string is long: ctx ${ctx3b.length}, sys ${sys3b.length} (the host caps each at 10,000)`)
  assert.deepEqual(rowFails, [], rowFails.join(' · '))
})

// The same repo with one toolchain drift: the drift banner first, the retired line after a newline; the context
// keeps the drift text first and the retired part last.
let run3c
test('SR29 3b drift and retired text: both lines', async () => {
  addContent(J(cp, 'docs/build.sh'), '# drift')
  run3c = await run(cp)
  assertNudge(run3c, ['1개의 벤더링된 툴체인 파일', R`docs/build\.sh`, `seed 파일 ${retFiles.size}개`], ['SCHEMA DRIFT', 'EXTRACTION DRIFT', R`\(missing\)`])
})
test('SR30 3b drift and retired text: two banner lines in that order, the drift context first and the retired part last', async () => {
  try {
    const { j, sys, ctx } = halves(run3c.out)
    const sysLines = sys.split('\n')
    assert.ok(j !== null && sysLines.length === 2 && sysLines[0].includes('툴체인 파일') && sysLines[1].includes('seed 파일') &&
      ctx.startsWith('The repo at ') && ctx.substring(ctx.lastIndexOf('\n\n') + 2).startsWith('Retired seed text'),
    `sys: [${sys}]`)
  } finally {
    // Restore the copy for the 3a cases below.
    fs.copyFileSync(J(fresh, 'docs/build.sh'), J(cp, 'docs/build.sh'))
    for (const f of retFiles.keys()) {
      if (fs.existsSync(J(fresh, f))) fs.copyFileSync(J(fresh, f), J(cp, f))
      else rm(J(cp, f))   // a retired file that no scaffold places
    }
    rm(J(cp, '.claude'))
  }
})

test('SR31 3a slice-note copy only: the slice rules and the copy note', async () => {
  setCopyClaude('- Notes: `node scripts/harness/slice_note.mjs add <decision|rejected|owner|fact|risk> "x"`')
  assertRuleOnly(await invokeHook(payload({ cwd: cp }, 'compact')), sliceRules + '\n\n' + copyNote)
})

// The close rule's second copy marker (ADR 0201): CLAUDE.md holds ONLY the new close wording, 'main session calls it', and
// no 'owner-typed'. This piggybacks on the .claude/CLAUDE.md run (no extra hook run): the review rule is left out by its
// marker in that file, the close rule by the new wording in CLAUDE.md, and the once-per-slice, handoff and artifact rules stay.
let run3aNew
test('SR32 3a review-rule copy in .claude/CLAUDE.md and the new close wording alone (main session calls it, no owner-typed) in CLAUDE.md: the close and review rules are left out, the other rules and the slice-note rule stay, the copy note', async () => {
  setCopyClaude('- The close: the person types it, or the main session calls it after the ready report.')
  mk(J(cp, '.claude'))
  setContent(J(cp, '.claude/CLAUDE.md'), 'House review angles go in args.lensExtra.')
  run3aNew = await run(cp)
  rm(J(cp, '.claude'))
  const noReviewNoClose = [sliceHead, sliceRuleLines[1], sliceRuleLines[3], sliceRuleLines[4]].join('\n')
  assertRuleOnly(run3aNew, noReviewNoClose + '\n\n' + noteRule + '\n\n' + copyNote)
})
test('SR33 3a the new-wording-only case: CLAUDE.md holds no owner-typed, the close rule text is absent from the output, the once-per-slice rule is present', async () => {
  assert.ok(!read(cpClaude).includes('owner-typed') && !has(run3aNew.out, 'The close: `/ywr-harness:slice-close`') && has(run3aNew.out, 'The review runs once per slice'),
    'the premise of the new-wording case does not hold')
})

test('SR34 3a a bare mention of the review command is no copy: the full text', async () => {
  setCopyClaude('Run /code-review on PRs. We call slice_note.mjs add by hand.')
  assertRuleOnly(await run(cp))
})

test('SR35 3a ADR citations alone are no copy: the full text', async () => {
  setCopyClaude('Our REVIEW.md follows ywr-harness ADR 0054; see also ywr-harness ADR 0028, 0040, 0072, 0105, 0032, 0068 and ywr-harness ADR 0172.')
  assertRuleOnly(await run(cp))
})

// 3d. The review canon (ADR 0215, ADR 0217), on the same copy. The seed declares the canon `CLAUDE.md`, a memory file
//     that the session loads at its start, so it needs no import: the rule only, even beside a root REVIEW.md that the
//     declaration does not name. The import cases below run on the legacy shape, a repo that older scaffolds seeded: a
//     root REVIEW.md that `.harness.json` declares as the canon. A CLAUDE.md that is a folder is no copy and imports
//     nothing: the full rule text, then the canon part, and one Korean line that names the canon. The last two cases
//     leave the canon undeclared: a root REVIEW.md then takes the default, and without it the default is CLAUDE.md.
const hjPath = J(cp, '.harness.json')
let hjText = ''
function setCopyCanon(canon) {
  const h = JSON.parse(hjText)
  if (!Object.hasOwn(h, 'review')) h.review = {}
  if (canon === null) delete h.review.canon
  else h.review.canon = canon
  write(hjPath, JSON.stringify(h, null, 2))
}
const canonPart = '\n\nReview canon import (ywr-harness ADR 0215, ywr-harness ADR 0217): '
const canonLine = (out) => {   // the canon line in the banner and the canon part in the context
  const { j, sys, ctx } = halves(out)
  return j !== null && /review canon `REVIEW\.md`/iu.test(sys) && ctx.includes(canonPart)
}
let run3dFirst
test('SR36 3d fixture: the seed declares canon CLAUDE.md and imports nothing', async () => {
  hjText = read(hjPath)
  setContent(J(cp, 'REVIEW.md'), '# Review canon\n\n1. An invariant.\n')
  setCopyClaude('')
  run3dFirst = await run(cp)
  assert.ok(/"canon":\s*"CLAUDE\.md"/iu.test(hjText) && !/(^|\s)@\S/u.test(seedText), 'the seed no longer declares a memory-file canon or holds an @ import')
})
test('SR37 3d a canon in CLAUDE.md needs no import, a root REVIEW.md the declaration does not name is not checked: the rule only', async () => {
  assertRuleOnly(run3dFirst)
})
test('SR38 3d a CLAUDE.md that is no file imports nothing: the full rule, the canon part last, one Korean line, exit 0', async () => {
  setCopyCanon('REVIEW.md')
  rm(cpClaude)
  mk(cpClaude)
  const r = await run(cp)
  const canonFails = []
  if (r.exit !== 0) canonFails.push(`exit ${r.exit}`)
  const { j, sys, ctx } = halves(r.out)
  if (j === null) canonFails.push('stdout is not valid JSON')
  else {
    if (!/^\[hook:scaffold-refresh-nudge\] .+review canon `REVIEW\.md`.+ywr-harness ADR 0215/iu.test(sys) || sys.includes('\n')) canonFails.push(`systemMessage is not one canon line: [${sys}]`)
    if (!sys.includes('`## Review canon`') || !sys.includes('ywr-harness ADR 0217')) canonFails.push(`systemMessage does not name the \`## Review canon\` section and ywr-harness ADR 0217: [${sys}]`)
    if (!ctx.startsWith(ruleText + canonPart)) canonFails.push(`additionalContext is not the full rule, then the canon part: [${ctx}]`)
    if (!ctx.includes('## Review canon') || !ctx.includes('review.canon')) canonFails.push(`additionalContext does not name the section and the review.canon move: [${ctx}]`)
  }
  assert.deepEqual(canonFails, [], `${canonFails.join(' · ')}\n--- output ---\n${r.out}`)
})
// Each trap loaded nothing on host 2.1.331 (fact 250): a span over two lines, a ~~~ line inside a backtick
// fence, an indented block after a blank line. The same canon part follows.
const fence = '```'
test('SR39 3d code in .claude/CLAUDE.md imports nothing: the canon line and part', async () => {
  mk(J(cp, '.claude'))
  setContent(J(cp, '.claude/CLAUDE.md'), `A span \`starts\n@../REVIEW.md ends\` here.\n\n${fence}md\n~~~\n@../REVIEW.md\n${fence}\n\nCode:\n\n    @../REVIEW.md\n`)
  const r = await run(cp)
  assert.ok(canonLine(r.out), r.out)
})
// A fenced block ends the paragraph before it, so an indented line right after the closing fence is code with no
// blank line between (dist #18). Mutation anchor: a closing fence that leaves the blank state alone keeps the line.
test('SR40 3d an indented line right after a closing fence imports nothing: the canon line and part', async () => {
  setContent(J(cp, '.claude/CLAUDE.md'), `para text\n${fence}\ncode\n${fence}\n    @../REVIEW.md\n`)
  const r = await run(cp)
  assert.ok(canonLine(r.out), r.out)
})
// An ATX heading, a setext underline and a thematic break at column 0 end the paragraph too (fact 256). Mutation
// anchor: dropping any one of the three keeps its line, and the hook prints the rule only.
test('SR41 3d an indented line right after a heading, a setext underline or a thematic break imports nothing: the canon line and part', async () => {
  setContent(J(cp, '.claude/CLAUDE.md'), '# Head\n    @../REVIEW.md\n\nSetext\n===\n    @../REVIEW.md\n\n***\n    @../REVIEW.md\n')
  const r = await run(cp)
  assert.ok(canonLine(r.out), r.out)
})
// Inside a list item the closing fence is indented, and the next indented line is item text that the host loads
// (fact 256). Mutation anchor: a closing fence that ends the paragraph at any indent drops the line.
test('SR42 3d an indented line after a fence inside a list item imports: the rule only', async () => {
  setContent(J(cp, '.claude/CLAUDE.md'), `- item\n  ${fence}\n  x\n  ${fence}\n    @../REVIEW.md\n`)
  assertRuleOnly(await run(cp))
})
test('SR43 3d CLAUDE.local.md imports @REVIEW.md: the rule only', async () => {
  // The next case proves the CLAUDE.local.md import alone, so this file must import nothing again.
  setContent(J(cp, '.claude/CLAUDE.md'), 'No import here.')
  // An import in CLAUDE.local.md counts: the session loads it.
  setContent(J(cp, 'CLAUDE.local.md'), 'Mine: @REVIEW.md')
  const r = await run(cp)
  rm(J(cp, 'CLAUDE.local.md'))
  assertRuleOnly(r)
})
// The absolute token through the copy's 8.3 short alias, where the host has one: git reports the long root, and a
// lexical compare read the short spelling as another file (the GitHub Windows runner's TEMP is a short name).
test('SR43b 3d an absolute import through the 8.3 short alias: the rule only', { skip: shortAlias(fx) === '' ? 'no 8.3 short name for the fixture root on this host' : false }, async () => {
  const cpShort = shortAlias(cp)
  assert.ok(cpShort !== '', `no short alias for ${cp}`)
  setContent(J(cp, 'CLAUDE.local.md'), `Mine: @${cpShort.replaceAll('\\', '/')}/REVIEW.md`)
  const r = await run(cp)
  rm(J(cp, 'CLAUDE.local.md'))
  assertRuleOnly(r)
})
test('SR44 3d .claude/CLAUDE.md imports @../REVIEW.md: the rule only', async () => {
  // The import resolves against the importing file: `@../REVIEW.md` in .claude/CLAUDE.md is the root canon.
  setContent(J(cp, '.claude/CLAUDE.md'), 'Invariants: @../REVIEW.md')
  const r = await run(cp)
  rm(J(cp, '.claude'))
  assertRuleOnly(r)
})
test('SR45 3d a declared canon that does not exist: the rule only', async () => {
  // A declared canon that does not exist is not checked: the emitter names it NOT FOUND instead.
  setCopyCanon('docs/NO-SUCH-CANON.md')
  const r = await run(cp)
  rm(cpClaude)
  setCopyClaude('')
  assertRuleOnly(r)
})
test('SR46 3d an undeclared canon beside a root REVIEW.md that nothing imports: the canon line and part name REVIEW.md', async () => {
  // No `review.canon` and a root REVIEW.md that nothing imports: the default is that file, so the canon line names it.
  setCopyCanon(null)
  const { j, sys, ctx } = halves((await run(cp)).out)
  assert.ok(j !== null && /review canon `REVIEW\.md`/iu.test(sys) && ctx.includes('the review canon `REVIEW.md` that .harness.json names'), JSON.stringify(j))
})
test('SR47 3d an undeclared canon and no REVIEW.md: the default is CLAUDE.md, the rule only', async () => {
  // No `review.canon` and no REVIEW.md: the default is CLAUDE.md, a memory file, so the rule only.
  rm(J(cp, 'REVIEW.md'))
  const r = await run(cp)
  write(hjPath, hjText)
  assertRuleOnly(r)
})

test('SR48 3a no .harness.json: the slice-note rule alone', async () => {
  rm(J(cp, '.harness.json'))
  assertRuleOnly(await run(cp), noteRule)
})

})

// 4. line-ending-only difference -> silent: the seed .gitattributes makes CRLF/LF checkout
//    variance legitimate, so raw byte identity would nudge every clone forever
test('SR49 CRLF-only difference is no drift (the rule only)', async () => { assertRuleOnly(await run(crlf)) })

// 4b. EXACT bytes modulo CR (ADR 0033): "everything else — content, encoding, BOM — stays exact". The
//     pwsh original compared with `-ne`, which ignores letter case and the culture-ignorable U+00AD and
//     NUL, so those three differences passed as identical; the Node port compares ordinally, and each
//     is drift here. A leading BOM is the encoding case the contract names.
async function addByteVariant(name, mutate) {
  const d = J(fx, name)
  await copy(base, d)
  const p = J(d, 'docs/build.sh')
  fs.writeFileSync(p, mutate(fs.readFileSync(p)))
  return d
}
const byteCases = [
  { n: 'a letter-case-only difference is drift', mutate: (b) => { b = Buffer.from(b); for (let i = 0; i < b.length; i++) if (b[i] >= 97 && b[i] <= 122) { b[i] -= 32; break } return b } },
  { n: 'an appended NUL byte is drift', mutate: (b) => Buffer.concat([b, Buffer.from([0])]) },
  { n: 'an appended U+00AD (soft hyphen as a Latin1 byte) is drift', mutate: (b) => Buffer.concat([b, Buffer.from([0xad])]) },
  { n: 'a leading UTF-8 BOM is drift', mutate: (b) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]) },
  { n: 'a lone CR is only a line-ending difference, never drift', mutate: (b) => Buffer.concat([b, Buffer.from([13, 13])]), silent: true },
]
byteCases.forEach((bc, i) => {
  test(`SR50 4b ${bc.n}`, async () => {
    const r = await run(await addByteVariant(`repo-bytes${i + 1}`, bc.mutate))
    if (bc.silent) assertRuleOnly(r)
    else assertNudge(r, ['1개의 벤더링된 툴체인 파일', R`docs/build\.sh`], ['SCHEMA DRIFT', 'EXTRACTION DRIFT', R`\(missing\)`, R`\(unreadable\)`])
  })
})

// 5. marker-less post-commit -> no drift (the rule only, no nudge): init.mjs refuses a foreign file, so a re-run would
//    change nothing — a nudge here would nag forever (the 0029 foreign-value shape)
test('SR51 foreign post-commit is no drift (the rule only)', async () => { assertRuleOnly(await run(foreignpc)) })

// 6. marker-carrying post-commit drifted -> counted like any toolchain file
test('SR52 guarded post-commit with marker counts', async () => {
  assertNudge(await run(ourspc), ['1개의 벤더링된 툴체인 파일', R`\.githooks[\\/]post-commit`], [R`harness_gates\.mjs`, 'SCHEMA DRIFT', R`\(missing\)`])
})

// 7. seven drifts -> five named, cap STATED (a silent truncation reads as full coverage)
test('SR53 file list caps at five and says so', async () => {
  assertNudge(await run(many), ['7개의 벤더링된 툴체인 파일', R`\+2 more`], ['SCHEMA DRIFT', R`harness_config\.mjs`])
})

// 8. scripts/harness/ that is not ours -> silent (file-level sentinel, not the directory gate:
//    counting a stranger's tree as "all missing" would be a false nudge)
test('SR54 foreign scripts/harness silent', async () => { assertEmptyStdout(await run(notours)) })

// 8b. a repo that holds only a Python script an older scaffold placed (no .mjs yet) is still ours: it is the repo
//     this nudge must tell to refresh (ywr-harness ADR 0223)
test('SR55 8b a repo with only the old .py scaffold script still gets the nudge', async () => {
  const oldpy = J(fx, 'repo-oldpy')
  mk(J(oldpy, 'scripts/harness'))
  setContent(J(oldpy, 'scripts/harness/harness_gates.py'), 'pass')
  if (gitOk) gitInit(oldpy)
  assertNudge(await run(oldpy),
    [R`\[hook:scaffold-refresh-nudge\]`, 'repo-oldpy', '벤더링된 툴체인 파일', R`docs/README\.md \(missing\)`],
    ['SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})

// 9. repo without scripts/harness -> silent, and the walk up from cwd finds no scripts/harness/, so no git call
const bareRun = lazy(() => invokeSpied(bare))
test('SR56 unscaffolded repo silent', async () => { assertEmptyStdout(await bareRun()) })
test('SR57 unscaffolded repo spawns no git', async () => {
  const r = await bareRun()
  assert.ok(r.gitCalls === 0, `${r.gitCalls} git call(s)`)
})

// 10. subdirectory cwd -> the ROOT is resolved and named (needs git; reported SKIP without)
gtest('SR58 subdirectory cwd resolves the root', async () => {
  assertNudge(await run(J(stale, 'subA/subB')), ['repo-stale', '2개의 벤더링된 툴체인 파일'], ['subA', 'SCHEMA DRIFT'])
})

describe('10b chain', { concurrency: 1 }, () => {
// 10b. UPSTREAM-AHEAD (ADR 0135): a teammate refreshed the scaffold and pushed; this clone has not pulled.
//      The probe's path is the stamp ALONE (10b-5: a toolchain-only upstream commit is a hand edit, no hit),
//      its walk is patch-equivalence filtered (10b-6: an amended stamp commit is no hit), and repo-AHEAD keeps
//      precedence over a hit (10b-8).
//      Its own stamp is the OLD one, so without the probe the ADR 0042 branch says "genuinely behind, re-run
//      init" — the wrong remedy, the right one is to pull. ONE bare remote and TWO clones carry every leg:
//      clone A (stamp 0.0.1, one drifted toolchain file) is the session under test, clone B pushes the
//      refresh (the canon's file and the real stamp). The remaining legs only move A's refs and branch.
//      The no-remote leg is every drifted fixture above (no remote, unborn HEAD): their 0033/0042 assertions
//      stay unchanged and case 1 below adds the new text to its MustNotMatch.
const uaGit = (dir, ...args) => git_run(dir, ['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', '-c', 'commit.gpgsign=false', ...args])
const uaRemote = J(fx, 'up-remote.git')
const uaA = J(fx, 'up-a')
const uaB = J(fx, 'up-b')
const uaSetup = lazy(async () => {
  gitInit(uaRemote, '--bare')
  await copy(base, uaA)
  addContent(J(uaA, 'scripts/harness/harness_gates.mjs'), '# selftest drift')
  setContent(J(uaA, '.harness-version'), '0.0.1')
  uaGit(uaA, 'config', '--local', '--unset', 'core.hooksPath')   // init.mjs wired the scaffold's hooks; the fixture commits bypass them
  uaGit(uaA, 'add', '-A')
  uaGit(uaA, 'commit', '-q', '-m', 'A: scaffold at an old stamp')
  uaGit(uaA, 'remote', 'add', 'origin', uaRemote)
  uaGit(uaA, 'push', '-q', '-u', 'origin', 'main')
  uaGit(fx, 'clone', '-q', uaRemote, uaB)
  fs.copyFileSync(J(base, 'scripts/harness/harness_gates.mjs'), J(uaB, 'scripts/harness/harness_gates.mjs'))
  setContent(J(uaB, '.harness-version'), mfVer)
  uaGit(uaB, 'add', '-A')
  uaGit(uaB, 'commit', '-q', '-m', 'B: scaffold refresh')
  uaGit(uaB, 'push', '-q', 'origin', 'main')
})
const tip = (dir, rev) => git_run(dir, ['log', '-1', '--format=%h', rev]).trim()
let uaSha = ''; let uaStampPath = ''; let uaStampText = ''; let uaNew = ''; let run10b2

// 10b-1. NOT fetched: A's refs know nothing of B's push, so today's advice stands — the documented
//        freshness limit (refs are as of the last fetch), and the proof the probe makes no network call.
gtest('SR59 10b-1 unfetched refs: no hit, the stamp-direction advice stands (freshness limit)', async () => {
  await uaSetup()
  assertNudge(await run(uaA),
    ['1개의 벤더링된 툴체인 파일', 'OLDER합니다', '리프레시: 이 저장소에서 /ywr-harness:harness-init'],
    ['ADR 0135', 'fetch', '다른 클론', 'SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})

// 10b-2. fetched: the upstream (origin/main) carries B's commit -> upstream-ahead replaces ALL the direction
//        branches. The ref, the newest sha and a date are named; init is forbidden in both halves; the OLDER /
//        "re-run" advice is gone. The model half says not to run or suggest init and to offer pulling.
gtest('SR60 10b-2 fetched upstream ahead: pull first, never re-run init (ADR 0135)', async () => {
  uaGit(uaA, 'fetch', '-q', 'origin')
  uaSha = tip(uaA, 'origin/main')
  run10b2 = await run(uaA)
  assertNudge(run10b2,
    ['1개의 벤더링된 툴체인 파일', R`harness_gates\.mjs`, 'origin/main', rxEscape(uaSha), R`\d{4}-\d{2}-\d{2}`, '다른 클론이',
      '/ywr-harness:harness-init을 실행하지 마세요', 'pull', '마지막 fetch', 'ADR 0135',
      'Do NOT run or suggest /ywr-harness:harness-init', 'Offer pulling', '제안만 합니다'],
    ['OLDER합니다', '측정된 것입니다', '리프레시: 이 저장소에서', 'genuinely behind', 'NEWER합니다', 'EQUALS',
      'direction-blind', '기준이 STALE', 'SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})
gtest('SR61 10b-2 upstream-ahead branch: the rule follows the drift text', async () => { assertRuleTail(run10b2) })
gtest('SR62 10b-2 the sha named is the fetched tip', async () => { assert.ok(/^[0-9a-f]{4,}$/u.test(uaSha), `sha='${uaSha}'`) })

// 10b-3. a feature branch with NO upstream and no origin/HEAD: no candidate ref -> no hit (today's advice) ...
gtest('SR63 10b-3 fixture: the feature branch has no upstream and no origin/HEAD', async () => {
  uaGit(uaA, 'checkout', '-q', '-b', 'feature')
  // git 2.48+ creates origin/HEAD on the first fetch (remote.<name>.followRemoteHEAD), so drop it here.
  git_result(uaA, ['symbolic-ref', '--quiet', '--delete', 'refs/remotes/origin/HEAD'])
  const noUp = git_result(uaA, ['rev-parse', '--symbolic-full-name', '@{upstream}']).status !== 0
  const noHead = git_result(uaA, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).status !== 0
  assert.ok(noUp && noHead, 'the leg below would test a candidate ref, not the empty list')
})
gtest('SR64 10b-3 no upstream and no origin/HEAD: no candidate ref, no hit', async () => {
  assertNudge(await run(uaA), ['OLDER합니다', '리프레시: 이 저장소에서 /ywr-harness:harness-init'], ['ADR 0135', '다른 클론', 'SCHEMA DRIFT'])
})
// ... and with origin/HEAD set, the remote default branch is the second candidate: the same hit.
gtest('SR65 10b-4 no upstream, origin/HEAD ahead: the remote default branch hits', async () => {
  uaGit(uaA, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  assertNudge(await run(uaA),
    ['origin/main', rxEscape(uaSha), 'ADR 0135', '/ywr-harness:harness-init을 실행하지 마세요', 'Offer pulling'],
    ['OLDER합니다', '리프레시: 이 저장소에서', 'SCHEMA DRIFT'])
})

// The legs below put A on B's pushed tip (stamp = the running version, canon files) and re-add the drift as an
// UNCOMMITTED edit, so the stamp equals the running version (the ADR 0042 EQUALS / hand-edit branch is the no-hit
// baseline) and only the REMOTE moves between legs. origin/HEAD stays set, so origin/main is the candidate ref.

// 10b-5. a toolchain-only upstream commit (a hand edit on main — no stamp change) is NOT a scaffold run: no hit,
//        the equal-version hand-edit advice stands.
gtest('SR66 10b-5 fixture: origin/main is ahead by a commit that leaves the stamp alone', async () => {
  uaGit(uaA, 'reset', '-q', '--hard', 'origin/main')
  addContent(J(uaA, 'scripts/harness/harness_gates.mjs'), '# selftest drift')
  uaStampPath = J(uaA, '.harness-version')
  uaStampText = read(uaStampPath)
  addContent(J(uaB, 'scripts/harness/harness_gates.mjs'), '# upstream hand edit')
  uaGit(uaB, 'add', '-A')
  uaGit(uaB, 'commit', '-q', '-m', 'B: hand edit of a toolchain file')
  uaGit(uaB, 'push', '-q', 'origin', 'main')
  uaGit(uaA, 'fetch', '-q', 'origin')
  const uaToolOnly = tip(uaA, 'HEAD..origin/main')
  const stampTouched = git_run(uaA, ['log', '-1', '--format=%h', 'HEAD..origin/main', '--', '.harness-version']).trim()
  assert.ok(/^[0-9a-f]{4,}$/u.test(uaToolOnly) && !stampTouched, `tool-only='${uaToolOnly}'`)
})
gtest('SR67 10b-5 toolchain-only upstream commit: no hit, the hand-edit advice stands (stamp is the only path)', async () => {
  assertNudge(await run(uaA),
    ['1개의 벤더링된 툴체인 파일', R`harness_gates\.mjs`, 'EQUALS', 'hand-edit'],
    ['ADR 0135', '다른 클론', '/ywr-harness:harness-init을 실행하지 마세요', 'SCHEMA DRIFT'])
})

// 10b-6. patch-equivalence: A amends the commit that carries the stamp (a rebase does the same). The pre-rewrite commit is
//        still on origin/main, but HEAD carries its patch: NOT upstream-ahead. The plain walk is the control.
gtest('SR68 10b-6 fixture: a plain walk still sees the pre-rewrite stamp commit (only --cherry-pick explains the silence)', async () => {
  uaGit(uaA, 'commit', '-q', '--amend', '-m', 'A: the stamp commit, amended')
  assert.ok(Boolean(git_run(uaA, ['log', '-1', '--format=%h', 'HEAD..origin/main', '--', '.harness-version']).trim()), 'the amend did not diverge from origin/main')
})
gtest('SR69 10b-6 an amended stamp commit is patch-equivalent: no hit', async () => {
  assertNudge(await run(uaA), [R`harness_gates\.mjs`, 'EQUALS', 'hand-edit'], ['ADR 0135', '다른 클론', 'SCHEMA DRIFT'])
})

// 10b-7. positive control: B pushes a NEW stamp commit the clone lacks -> the hit replaces the equal-version branch.
gtest('SR70 10b-7 a new upstream stamp commit hits and replaces the equal-version branch', async () => {
  setContent(J(uaB, '.harness-version'), '0.0.9')
  uaGit(uaB, 'add', '-A')
  uaGit(uaB, 'commit', '-q', '-m', 'B: a new stamp commit')
  uaGit(uaB, 'push', '-q', 'origin', 'main')
  uaGit(uaA, 'fetch', '-q', 'origin')
  uaNew = tip(uaA, 'origin/main')
  assertNudge(await run(uaA),
    ['origin/main', rxEscape(uaNew), 'ADR 0135', '/ywr-harness:harness-init을 실행하지 마세요', 'Offer pulling'],
    ['EQUALS', 'hand-edit', 'SCHEMA DRIFT'])
})

// 10b-8. F2: with that hit standing, a repo-AHEAD stamp (newer than the running plugin) keeps the ADR 0042 AHEAD advice —
//        "update the plugin, do NOT init" — and the hit does not replace it. Only the working-tree stamp changes.
gtest('SR71 10b-8 repo-AHEAD keeps precedence over an upstream hit (ADR 0042 advice, no pull-first)', async () => {
  setContent(uaStampPath, '99.0.0')
  try {
    assertNudge(await run(uaA),
      ['1개의 벤더링된 툴체인 파일', R`v99\.0\.0`, 'NEWER합니다', 'AHEAD', 'REVERT', '/ywr-harness:update',
        'Do NOT run or suggest /ywr-harness:harness-init', 'NEWER than this session', 'ADR 0042', '제안만 합니다'],
      ['ADR 0135', '다른 클론', 'Offer pulling', '마지막 fetch', 'OLDER합니다', 'EQUALS', 'direction-blind', 'SCHEMA DRIFT'])
  } finally { write(uaStampPath, uaStampText) }
})

})

// 11. BOM-prefixed stdin -> still parses (the config-change-audit 07-23 incident class)
test('SR72 BOM-prefixed stdin', async () => {
  assertNudge(await invokeHook(ch(0xfeff) + payload({ cwd: stale })), ['repo-stale'], ['SCHEMA DRIFT'])
})

// 11b. PowerShell semantics the Node port keeps (ADR 0116): member access and the event compare are
//      case-insensitive, `[string]` casts the cwd and `.Trim()` strips it.
test('SR73 case-drifted keys and event name still read', async () => {
  assertNudge(await invokeHook(JSON.stringify({ Hook_Event_Name: 'sessionstart', CWD: stale })), ['repo-stale', '2개의 벤더링된 툴체인 파일'], ['SCHEMA DRIFT'])
})
test('SR74 cwd padded with whitespace is trimmed', async () => {
  assertNudge(await invokeHook(payload({ cwd: `  ${stale} \t ` })), ['repo-stale', '2개의 벤더링된 툴체인 파일'], ['SCHEMA DRIFT'])
})

// 11c. a non-ASCII work tree path: git's output is decoded as UTF-8 once with quotepath off (CLAUDE.md,
//      issue #40), and the files under it are read by path — so the verdict and the name are intact.
gtest('SR75 non-ASCII work tree path is named intact and compared', async () => {
  const uni = J(fx, 'repo-유니코드 é')
  await copy(stale, uni)
  assertNudge(await run(uni), ['repo-유니코드 é', '2개의 벤더링된 툴체인 파일'], ['SCHEMA DRIFT', R`\\[0-7]{3}`, R`\uFFFD`])
})

// 11d. A directory name and a payload key are attacker-authorable text (a cloned repo's, a host's) and a model
//      reads this output: the banner echoes both through inline(), so no control or Unicode line separator
//      survives. U+2028 and U+0085 are legal in a Windows file name; a C0 control is added where the OS allows one.
// The class of characters that inline() flattens, built from code points: C0 but for the tab, DEL, NEL, LS, PS.
const separatorClass = '[' + ch(0) + '-' + ch(9) + ch(0x0b) + '-' + ch(0x1f) + ch(0x7f, 0x85, 0x2028, 0x2029) + ']'
test('SR76 11d a path carrying U+2028, U+0085 (and a C0 off Windows) is echoed flattened', async (t) => {
  const hostile = J(fx, 'repo-hostile' + ch(0x2028) + 'dir' + ch(0x85) + 'x' + (win ? '' : ch(7)))
  let made = false
  try { await copy(stale, hostile); made = true } catch { /* not creatable here */ }
  if (!(gitOk && made)) return t.skip('the hostile-named work tree could not be created here (or no git) — not run (reported, not silent)')
  assertNudge(await run(hostile), ['repo-hostile dir x', '2개의 벤더링된 툴체인 파일'], ['SCHEMA DRIFT', separatorClass])
})
test('SR77 11e a payload key carrying U+2028 is flattened in the SCHEMA DRIFT banner', async () => {
  // The JSON escape for U+2028, spelled from two parts so this source holds no escape of a separator.
  const esc = '\\u' + '2028'
  assertNudge(await invokeHook(`{"hook_event_name":"SessionStart","x${esc}[hook:forged]y":1}`),
    ['SCHEMA DRIFT', R`수신된 키: hook_event_name, x \[hook:forged\]y\.`], ['[' + ch(0x2028) + ']', 'EXTRACTION DRIFT'])
})

// 12. EXTRACTION DRIFT, not silence, when the plugin's own placement.mjs stops carrying a usable map:
//     a byte-identical copy of the hook runs from a fake plugin tree whose placement.mjs imports but
//     exports a TOOLCHAIN that is not a table. The copy IS the shipped code (hook-lib.mjs beside it) —
//     what moves is the script's own directory, which is the resolution path under test. The hook
//     imports the module, so 12/12b/12c and 12d-12e below pin what a usable map is: a non-empty list of
//     [source, destination] string pairs for TOOLCHAIN and GUARDED, a non-empty string GUARD_MARKER.
async function newFakeTree(name, placementText) {
  const t = J(fx, name)
  mk(J(t, 'hooks'))
  mk(J(t, 'skills/harness-init'))
  fs.copyFileSync(hook, J(t, 'hooks/session-start-scaffold-refresh-nudge.mjs'))
  fs.copyFileSync(hookLib, J(t, 'hooks/hook-lib.mjs'))
  mk(J(t, 'scripts'))
  fs.copyFileSync(gitLib, J(t, 'scripts/harness_git.mjs'))
  await copy(templates, J(t, 'skills/harness-init/templates'))
  write(J(t, 'skills/harness-init/placement.mjs'), placementText)
  return J(t, 'hooks/session-start-scaffold-refresh-nudge.mjs')
}
const gLit = "export const GUARDED = [['githooks/post-commit', '.githooks/post-commit']]\nexport const GUARD_MARKER = 'ywr-harness:post-commit'\n"
const tcOne = "export const TOOLCHAIN = [['scripts/harness/harness_gates.mjs', 'scripts/harness/harness_gates.mjs']]\n"
test('SR78 unreadable placement map reports EXTRACTION DRIFT, not silence', async () => {
  // $stale holds slice_note.mjs, yet no rule here
  assertNudge(await run(stale, { hookPath: await newFakeTree('fake-broken', "export const TOOLCHAIN = 'not a table'\n" + gLit) }),
    ['EXTRACTION DRIFT', 'UNKNOWN, 확인되지 않았습니다', '배치 맵'],
    ['템플릿과 다릅니다', '제안만 합니다', 'SCHEMA DRIFT', ruleMark])
})

// 12b. a PARTIAL entry — a pair whose destination is not a string — must fail extraction WHOLE, never
//      contribute the fragment to the map (the ADR 0033 lesson: a fragment is a wrong path compared quietly).
test('SR79 partial entry fails extraction whole, never a fragment', async () => {
  assertNudge(await run(stale, { hookPath: await newFakeTree('fake-partial', "export const TOOLCHAIN = [['scripts/harness/harness_gates.mjs', 'scripts/harness/' + 5]]\n" + gLit) }),
    ['EXTRACTION DRIFT', 'UNKNOWN, 확인되지 않았습니다', '배치 맵'],
    ['템플릿과 다릅니다', R`\(missing\)`, 'SCHEMA DRIFT'])
})

// 12c. a fully valid map with NO scripts/harness/*.mjs destination -> the ownership sentinel
//      is gone; an unchecked empty list would silently disable the hook on every repo forever.
//      The banner, not silence, is the contract.
test('SR80 sentinel-less map reports EXTRACTION DRIFT, not permanent silence', async () => {
  assertNudge(await run(stale, { hookPath: await newFakeTree('fake-nosentinel', "export const TOOLCHAIN = [['docs/README.md', 'docs/README.md']]\n" + gLit) }),
    ['EXTRACTION DRIFT', 'sentinel', 'UNKNOWN, 확인되지 않았습니다'],
    ['템플릿과 다릅니다', 'SCHEMA DRIFT'])
})

// 13. a template missing from the plugin copy -> the same banner naming the file; freshness is
//     never resolved into a nudge from an incomplete comparison set
test('SR81 missing template reports EXTRACTION DRIFT naming the file', async () => {
  const fakeTmpl = J(fx, 'fake-tmpl')
  mk(J(fakeTmpl, 'hooks'))
  mk(J(fakeTmpl, 'skills/harness-init'))
  fs.copyFileSync(hook, J(fakeTmpl, 'hooks/session-start-scaffold-refresh-nudge.mjs'))
  fs.copyFileSync(hookLib, J(fakeTmpl, 'hooks/hook-lib.mjs'))
  mk(J(fakeTmpl, 'scripts'))
  fs.copyFileSync(gitLib, J(fakeTmpl, 'scripts/harness_git.mjs'))
  fs.copyFileSync(placement, J(fakeTmpl, 'skills/harness-init/placement.mjs'))
  await copy(templates, J(fakeTmpl, 'skills/harness-init/templates'))
  rm(J(fakeTmpl, 'skills/harness-init/templates/docs/build_docs.mjs'))
  assertNudge(await run(fresh, { hookPath: J(fakeTmpl, 'hooks/session-start-scaffold-refresh-nudge.mjs') }),
    ['EXTRACTION DRIFT', '템플릿이 없습니다', R`templates/docs/build_docs\.mjs`],
    ['템플릿과 다릅니다', 'SCHEMA DRIFT'])
})

// 12d-12e. WHAT THE HOOK ACCEPTS. One fake plugin tree (real templates, the hook + hook-lib) per placement.mjs shape.
//     Accepted: a minimal table of two pairs, behind a comment and a computed-but-string-valued entry. Refused
//     (EXTRACTION DRIFT, never a fragment and never silence): an empty table, an entry of the wrong arity, a
//     source repeated in another letter case, a marker that is not a string, a missing GUARDED export, a module
//     that throws at import and a module that does not parse.
const tcDecoys = "// a comment above the table\nconst dir = 'scripts'\nexport const TOOLCHAIN = [\n  [dir + '/harness/harness_gates.mjs', 'scripts/harness/harness_gates.mjs'], // trailing comment\n  ['docs/README.md', 'docs/README.md'],\n]\n"
test('SR82 12d a minimal table behind a comment is read, and only its two files are compared', async () => {
  assertNudge(await run(stale, { hookPath: await newFakeTree('fake-decoys', tcDecoys + gLit) }),
    ['1개의 벤더링된 툴체인 파일', R`harness_gates\.mjs`], ['EXTRACTION DRIFT', 'SCHEMA DRIFT', R`harness-gates\.yml`, 'decoy'])
})
const refused = {
  'an empty table': 'export const TOOLCHAIN = []\n' + gLit,
  'an entry of the wrong arity': "export const TOOLCHAIN = [['scripts/harness/harness_gates.mjs']]\n" + gLit,
  'a source repeated in another letter case': "export const TOOLCHAIN = [['scripts/harness/harness_gates.mjs', 'scripts/harness/harness_gates.mjs'], ['SCRIPTS/harness/harness_gates.mjs', 'scripts/harness/harness_gates.mjs']]\n" + gLit,
  'a marker that is not a string': tcOne + "export const GUARDED = [['githooks/post-commit', '.githooks/post-commit']]\nexport const GUARD_MARKER = ['ywr-harness:post-commit']\n",
  'a missing GUARDED export': tcOne + "export const GUARD_MARKER = 'ywr-harness:post-commit'\n",
  'a module that throws at import': tcOne + gLit + "throw new Error('boom')\n",
  'a module that does not parse': tcOne + gLit + 'export const BROKEN = [\n',
}
Object.entries(refused).forEach(([name, text], i) => {
  test(`SR83 12e ${name} -> EXTRACTION DRIFT, never a fragment or silence`, async () => {
    assertNudge(await run(stale, { hookPath: await newFakeTree(`fake-refused${i + 1}`, text) }),
      ['EXTRACTION DRIFT', 'UNKNOWN, 확인되지 않았습니다'], ['템플릿과 다릅니다', R`\(missing\)`, 'SCHEMA DRIFT'])
  })
})

describe('13b-13k chain', { concurrency: 1 }, () => {
// 13b-13f. STALE-BASIS PROBE (ADR 0039): a byte-identical hook copy runs from a fake VERSIONED
//          CACHE layout (<plugins>/cache/<marketplace>/<name>/<version>) with the real placement.mjs
//          and templates beside it, so the drift verdict itself stays the real one (repo-stale's
//          2 files). What varies per case is the sibling installed_plugins.json — the probe's
//          only input. The running copy's plugin.json is pinned to 0.0.1 so assertions can tell
//          RUNNING (v0.0.1) from REGISTERED (v9.9.9) apart. Every one of these cases must still
//          produce a nudge — the probe may switch the advice, never silence the hook.
const fakePlugins = J(fx, 'fake-plugins')
const staleCopy = J(fakePlugins, 'cache/ywrlabs/ywr-harness/0.0.1')
const staleHook = J(staleCopy, 'hooks/session-start-scaffold-refresh-nudge.mjs')
const fakeRegPath = J(fakePlugins, 'installed_plugins.json')
const manifestPath = J(staleCopy, '.claude-plugin/plugin.json')
// SR87 pins the stamp of the repo these cases run on. They run on their own copy of the stale repo, so that change never
// reaches the cases that read the stale repo while this chain runs.
const staleReg = J(fx, 'repo-stale-registry')
const staleCopySetup = lazy(async () => {
  await copy(stale, staleReg)
  mk(J(staleCopy, 'hooks'))
  mk(J(staleCopy, '.claude-plugin'))
  mk(J(staleCopy, 'skills/harness-init'))
  fs.copyFileSync(hook, staleHook)
  fs.copyFileSync(hookLib, J(staleCopy, 'hooks/hook-lib.mjs'))
  mk(J(staleCopy, 'scripts'))
  fs.copyFileSync(gitLib, J(staleCopy, 'scripts/harness_git.mjs'))
  fs.copyFileSync(placement, J(staleCopy, 'skills/harness-init/placement.mjs'))
  await copy(templates, J(staleCopy, 'skills/harness-init/templates'))
  setContent(manifestPath, '{"name":"ywr-harness","version":"0.0.1"}')
})
// JSON.stringify owns the backslash escaping — hand-built JSON with Windows paths is how a
// fixture silently tests nothing on one platform.
const setFakeRegistry = (entries) => setContent(fakeRegPath, JSON.stringify({ plugins: { 'ywr-harness@ywrlabs': [entries].flat() } }, null, 2))
const stdEntry = { scope: 'user', installPath: J(fakePlugins, 'cache/ywrlabs/ywr-harness/9.9.9'), version: '9.9.9', lastUpdated: '2026-08-07T01:00:00Z' }
const runStale = () => run(staleReg, { hookPath: staleHook })
const normalNudge = ['2개의 벤더링된 툴체인 파일', '리프레시: 이 저장소에서 /ywr-harness:harness-init']
const normalNot = ['기준이 STALE', 'reload-plugins', 'SCHEMA DRIFT', 'EXTRACTION DRIFT']

// 13b. registry lists this plugin but NOT this copy -> STALE advice: running vs registered
//      version named, reload instructed, harness-init forbidden — and the file list stays.
//      Two entries prove the pick order (user scope wins over a more-recent project entry).
let run13b
test('SR84 superseded cache copy reports STALE basis, reload not refresh', async () => {
  await staleCopySetup()
  setFakeRegistry([
    { scope: 'project', installPath: J(fakePlugins, 'cache/ywrlabs/ywr-harness/8.8.8'), version: '8.8.8', lastUpdated: '2026-08-07T09:00:00Z' },
    stdEntry,
  ])
  run13b = await runStale()
  assertNudge(run13b,
    ['비교 기준이 STALE합니다', R`v0\.0\.1`, R`v9\.9\.9`, '/reload-plugins', '/ywr-harness:harness-init을 실행하지 마세요',
      '2개의 벤더링된 툴체인 파일', R`harness_gates\.mjs`, 'REVERT', '제안만 합니다'],
    [R`v8\.8\.8`, '리프레시: 이 저장소에서', '시드는 보존', 'SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})
test('SR85 13b stale-basis branch: the rule follows the drift text', async () => { assertRuleTail(run13b) })
// Both versions must survive in the HUMAN banner alone, not only in the English context half:
// assertNudge matches sys+ctx JOINED, and a version dropped from an interpolation (the pwsh original read a
// Korean particle glued to a variable name as one longer, undefined name) stays green through the ctx half.
// Caught live 2026-08-11: both versions fell out of the banner while this case stayed green.
test('SR86 13b both versions survive in the HUMAN banner (interpolation, not ctx)', async () => {
  const { sys } = halves(run13b.out)
  assert.ok(has(sys, R`v0\.0\.1`) && has(sys, R`v9\.9\.9`), `systemMessage='${sys}'`)
})

// 13c-13i run the NORMAL branch from a fake v0.0.1 cache copy, so pin the fixture's stamp BELOW
// 0.0.1 first — the real-version stamp the scaffold wrote would otherwise flip these
// registry-fallback cases into the ADR 0042 repo-ahead advice and test the wrong branch.
// 0.0.0 < 0.0.1 -> the BEHIND wording ('Refresh: run …') is the expected normal nudge here.

// 13c. registry entry IS this copy -> current install, the normal 0033 nudge unchanged
test('SR87 cache copy that IS the registered install nudges normally', async () => {
  setContent(J(staleReg, '.harness-version'), '0.0.0')
  setFakeRegistry({ scope: 'user', installPath: staleCopy, version: '0.0.1', lastUpdated: '2026-08-07T01:00:00Z' })
  assertNudge(await runStale(), [...normalNudge, R`v0\.0\.1`, '시드는 보존'], normalNot)
})

// 13d. no registry file -> probe yields nothing, normal nudge (fail toward 0033's behavior)
test('SR88 absent registry falls back to the normal nudge', async () => {
  rm(fakeRegPath)
  assertNudge(await runStale(), normalNudge, normalNot)
})

// 13e. unparseable registry -> same fallback, and the envelope must still be clean JSON
//      (2>&1 is captured: a stray error line from the parse would corrupt it)
test('SR89 garbage registry falls back cleanly', async () => {
  setContent(fakeRegPath, 'not json at all {{{')
  assertNudge(await runStale(), normalNudge, normalNot)
})

// 13f. registry carries only OTHER plugins (this one uninstalled mid-session) -> no registered
//      install to reload into; the normal nudge is the conservative fallback
test('SR90 unlisted plugin falls back to the normal nudge', async () => {
  setContent(fakeRegPath, JSON.stringify({ plugins: { 'some-other-plugin@elsewhere': [{ scope: 'user', installPath: J(fakePlugins, 'cache/elsewhere/some-other-plugin/1.0.0'), version: '1.0.0' }] } }, null, 2))
  assertNudge(await runStale(), normalNudge, normalNot)
})

// 13g. SAME version registered at a DIFFERENT path -> normal nudge, never a self-contradictory
//      "runs v0.0.1 while the install is v0.0.1" (review 2026-08-07, medium): a same-version
//      re-registration ships the same templates, so the refresh advice is not inverted
test('SR91 same-version re-registration keeps the normal nudge', async () => {
  setFakeRegistry({ scope: 'user', installPath: J(fakePlugins, 'cache/ywrlabs/ywr-harness/elsewhere-0.0.1'), version: '0.0.1', lastUpdated: '2026-08-07T02:00:00Z' })
  assertNudge(await runStale(), [...normalNudge, R`v0\.0\.1`], normalNot)
})

// 13h. CROSS-MARKETPLACE union (the '@<marketplace>' half is deliberately unpinned — a consuming
//      org may register the marketplace under another name): the original key is emptied
//      (uninstalled there), a DIFFERENT marketplace key carries the registered install at
//      another version -> STALE names THAT version. This is the union path no single-key
//      fixture exercises (review 2026-08-07, low).
test('SR92 cross-marketplace registration is unioned into the STALE verdict', async () => {
  setContent(fakeRegPath, JSON.stringify({
    plugins: {
      'ywr-harness@ywrlabs': [],
      'ywr-harness@otherorg': [{ scope: 'user', installPath: J(fakePlugins, 'cache/otherorg/ywr-harness/7.7.7'), version: '7.7.7', lastUpdated: '2026-08-07T03:00:00Z' }],
    },
  }, null, 2))
  assertNudge(await runStale(),
    ['비교 기준이 STALE합니다', R`v0\.0\.1`, R`v7\.7\.7`, '/reload-plugins'],
    ['리프레시: 이 저장소에서', 'SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})

// 13i. corrupted registered-version shapes are skipped, never rendered: an ARRAY version
//      space-joins under [string] into a digit-bearing "1.0.0 2.0.0" that a bare digit test
//      would accept (review 2026-08-07, low), and the literal 'unknown' sentinel fails the
//      digit test — the one usable entry (project scope 6.6.6) must be the version named
test('SR93 corrupted version shapes are skipped, the usable entry is named', async () => {
  setFakeRegistry([
    { scope: 'user', installPath: J(fakePlugins, 'cache/ywrlabs/ywr-harness/corrupt-a'), version: ['1.0.0', '2.0.0'], lastUpdated: '2026-08-07T09:00:00Z' },
    { scope: 'user', installPath: J(fakePlugins, 'cache/ywrlabs/ywr-harness/corrupt-b'), version: 'unknown', lastUpdated: '2026-08-07T08:00:00Z' },
    { scope: 'project', installPath: J(fakePlugins, 'cache/ywrlabs/ywr-harness/6.6.6'), version: '6.6.6', lastUpdated: '2026-08-07T01:00:00Z' },
  ])
  assertNudge(await runStale(),
    ['비교 기준이 STALE합니다', R`v6\.6\.6`, '/reload-plugins'],
    [R`1\.0\.0 2\.0\.0`, 'version unknown', '리프레시: 이 저장소에서', 'SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})

// 13j-13k. THE TWO JSON FILES THE HOOK READS PARSE AS LENIENTLY AS ConvertFrom-Json DID (PowerShell 7:
//      `//` and `/* */` comments, trailing commas, single-quoted strings, unquoted keys). A strict parse of
//      either would silently turn a hand-edited, commented file into "no manifest" / "no registry" — the
//      wrong version named in the banner, or the stale-basis verdict lost. 13j: the plugin manifest
//      carries comments and a trailing comma; 13k: the registry is single-quoted with unquoted keys,
//      comments and trailing commas. `#` comments stay refused (the registry falls back, 13e's way).
test('SR94 13j a commented manifest with a trailing comma still names the running version', async () => {
  setContent(manifestPath, '// manifest, hand-annotated\n{ "name": "ywr-harness", /* the running copy */ "version": "0.0.1", }')
  setFakeRegistry(stdEntry)
  assertNudge(await runStale(),
    ['비교 기준이 STALE합니다', R`v0\.0\.1`, R`v9\.9\.9`, '2개의 벤더링된 툴체인 파일'],
    ['version unknown', 'SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})
test('SR95 13k a commented single-quoted registry with unquoted keys and trailing commas still reads', async () => {
  setContent(manifestPath, '{"name":"ywr-harness","version":"0.0.1"}')
  setContent(fakeRegPath, "// hand-edited registry\n{ 'plugins': { 'ywr-harness@ywrlabs': [ { scope: 'user', installPath: 'X:/elsewhere/ywr-harness/9.9.9', version: '9.9.9', /* when */ lastUpdated: '2026-08-07T01:00:00Z', }, ], }, }")
  assertNudge(await runStale(),
    ['비교 기준이 STALE합니다', R`v0\.0\.1`, R`v9\.9\.9`, '/reload-plugins'],
    ['리프레시: 이 저장소에서', 'SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})
test('SR96 13k2 a #-commented registry is unparseable -> the normal nudge, as before', async () => {
  setContent(fakeRegPath, '# not a comment in JSON\n{ "plugins": { "ywr-harness@ywrlabs": [ { "scope": "user", "installPath": "X:/elsewhere", "version": "9.9.9" } ] } }')
  assertNudge(await runStale(), normalNudge, ['기준이 STALE', 'SCHEMA DRIFT', 'EXTRACTION DRIFT'])
})

})

// 14. plain non-repo directory -> silent on BOTH branches (with git: rev-parse fails; without
//     git: no scripts/harness at cwd), so this case runs unguarded
const plainRun = lazy(() => invokeSpied(plain))
test('SR97 non-repo dir silent', async () => { assertEmptyStdout(await plainRun()) })
test('SR98 non-repo dir spawns no git', async () => {
  const r = await plainRun()
  assert.ok(r.gitCalls === 0, `${r.gitCalls} git call(s)`)
})

// 14b. where the folders above cwd cannot prove silence, the git path still runs: a gitfile `.git` is not proof
//      (its git dir is elsewhere), and core.worktree makes git name a work tree outside the folders above cwd.
const gitfileRun = lazy(async () => {
  const gitfile = mk(J(fx, 'repo-gitfile'))
  write(J(gitfile, '.git'), 'gitdir: ./nowhere' + os.EOL)
  return await invokeSpied(gitfile)
})
gtest('SR99 14b gitfile .git without a scaffold: silent', async () => { assertEmptyStdout(await gitfileRun()) })
gtest('SR100 14b a gitfile .git is not proof: git is still asked', async () => { assert.ok((await gitfileRun()).gitCalls >= 1, 'no git call') })
gtest('SR101 14b core.worktree pointing at a scaffold: git names that work tree and the rule is stated', async () => {
  const redirect = J(fx, 'repo-redirect')
  gitInit(redirect)
  git_run(redirect, ['config', 'core.worktree', fresh])
  assertRuleOnly(await invokeSpied(redirect))
})

// 15. vanished cwd -> silent, and the stdout must be CLEAN (2>&1 is captured, so a stderr wall
//     would fail the emptiness assertion — the 48c264c class)
test('SR102 vanished cwd silent and clean', async () => { assertEmptyStdout(await run(J(fx, 'no-such-dir'))) })

// 16. a cwd whose ROOT does not exist on this platform -> same clean silence
test('SR103 unresolvable root silent and clean', async () => {
  let bogusRoot = 'C:\\no-such-root\\x'
  if (win) {
    const free = [...Array(22).keys()].map((i) => ch(69 + i)).find((l) => !fs.existsSync(`${l}:\\`))
    bogusRoot = `${free}:\\no-such-root\\x`
  }
  assertEmptyStdout(await run(bogusRoot))
})

// 17. ANTI-VACUITY: no `cwd` in the payload -> the hook says so instead of falling silent
test('SR104 schema drift is reported, not swallowed', async () => {
  assertNudge(await invokeHook(payload({})),
    ['SCHEMA DRIFT', '수신된 키: hook_event_name, session_id, source'], ['템플릿과 다릅니다', 'EXTRACTION DRIFT', ruleMark])
})

// 17b. the received-key list sorts case-insensitively (the original's Sort-Object); a null or blank cwd is drift too
test('SR105 drift key list sorts case-insensitively', async () => {
  assertNudge(await invokeHook('{"hook_event_name":"SessionStart","Zeta":1,"alpha":2,"Beta":3}'),
    ['SCHEMA DRIFT', R`수신된 키: alpha, Beta, hook_event_name, Zeta\.`], ['EXTRACTION DRIFT'])
})
for (const cj of ['null', '""', '"   "']) {
  test(`SR106 cwd ${cj} reports SCHEMA DRIFT`, async () => {
    assertNudge(await invokeHook('{"hook_event_name":"SessionStart","cwd":' + cj + '}'), ['SCHEMA DRIFT'], ['EXTRACTION DRIFT'])
  })
}

// 18. wrong event name -> silent (defensive event guard, symmetric with siblings)
test('SR107 wrong event silent', async () => {
  assertEmptyStdout(await invokeHook(R`{"hook_event_name":"SessionEnd","cwd":"C:\\x","source":"startup"}`))
})

// 19. garbage stdin -> silent exit 0 (infra failure is not a finding)
test('SR108 garbage fail-open', async () => { assertEmptyStdout(await invokeHook('not json at all {{{')) })

// 20-21. the no-git branch, exercised by clearing PATH for the CHILD only: the verdict is
//        filesystem-only, so a drifted scaffold still nudges with cwd as the root — this is
//        the documented degradation, not an UNKNOWN. A plain dir stays silent. Runs on
//        git-less machines too, where it is simply the ambient truth.
test('SR109 no git: filesystem verdict still nudges', async () => {
  assertNudge(await run(stale, { env: envWithoutPath() }), ['repo-stale', '2개의 벤더링된 툴체인 파일', '제안만 합니다'], ['SCHEMA DRIFT', 'UNKNOWN'])
})
test('SR110 no git: plain dir stays silent', async () => { assertEmptyStdout(await run(plain, { env: envWithoutPath() })) })

})

// 22. NON-MUTATION, asserted not assumed: after every invocation above, the fixtures read
//     byte-identical to their prepared state — the suggest-only contract (ADR 0033) becomes
//     provable by the suite. Both directions matter: the hook must not "refresh" the drifted
//     file and must not touch the clean one.
test('SR111 non-mutation: clean placement untouched', async () => {
  assert.ok(sha256(J(fresh, 'docs/build_docs.mjs')) === freshHash, 'repo-fresh/docs/build_docs.mjs changed — the hook wrote to the repo')
})
test('SR112 non-mutation: drifted placement not "refreshed"', async () => {
  assert.ok(sha256(J(stale, 'scripts/harness/harness_gates.mjs')) === staleHash, 'repo-stale/scripts/harness/harness_gates.mjs changed — the hook reverted the drift it only reports')
})

// R1. REGISTRATION. Every case above pipes a payload straight into the script, so none of them sees
//     whether the runtime ever calls it. This pins the wiring: SessionStart, no matcher (deliberate —
//     see the hook header), exec-form `node <script>` (ADR 0116) and the 15 s timeout. That it FIRES
//     is still only a live `--plugin-dir` probe's to show.
test('R1 hooks.json registers this script once: SessionStart, no matcher, exec-form node <script>', async () => {
  const fails = []
  try {
    const hj = JSON.parse(read(path.join(here, 'hooks.json')))
    const sites = []
    for (const [ev, groups] of Object.entries(hj.hooks ?? {})) {
      for (const grp of [groups].flat().filter(Boolean)) {
        for (const h of [grp.hooks].flat().filter(Boolean)) {
          const parts = [String(h.command ?? ''), ...[h.args ?? []].flat().map(String)]
          if (/session-start-scaffold-refresh-nudge\.(ps1|mjs)/iu.test(parts.join(' '))) sites.push({ ev, matcher: String(grp.matcher ?? ''), h })
        }
      }
    }
    const wantArgs = ['${CLAUDE_PLUGIN_ROOT}/hooks/session-start-scaffold-refresh-nudge.mjs']
    if (sites.length !== 1) fails.push(`want exactly 1 registration of session-start-scaffold-refresh-nudge (.mjs or the retired .ps1), found ${sites.length}`)
    else {
      const s = sites[0]
      const gotArgs = [s.h.args ?? []].flat().map(String)
      if (s.ev !== 'SessionStart') fails.push(`event '${s.ev}' (want SessionStart)`)
      if (s.matcher) fails.push(`matcher '${s.matcher}' (want none — registered without one on purpose)`)
      if (String(s.h.type) !== 'command' || String(s.h.command) !== 'node') fails.push(`handler type/command '${s.h.type}'/'${s.h.command}' (want command/node)`)
      if (gotArgs.join('\0') !== wantArgs.join('\0')) fails.push(`args [${gotArgs.join(' ')}] (want exec form [${wantArgs.join(' ')}])`)
      else {
        const resolved = path.join(path.dirname(here), gotArgs.at(-1).replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//u, ''))
        if (path.resolve(resolved) !== path.resolve(hook)) fails.push(`args resolve to '${resolved}', not this suite's script '${hook}'`)
      }
      if (String(s.h.timeout) !== '15') fails.push(`timeout '${s.h.timeout}' (want 15)`)
    }
  } catch (e) { fails.push(`hooks.json unreadable: ${e.message}`) }
  assert.deepEqual(fails, [], fails.join(' · '))
})

// META — proves this file's WIRING to the shared empty-mustNotMatch guard: a wrapper that
// dropped the mustNotMatch passthrough would leave the core intact and every case above unguarded.
const metaOut = { out: '{"systemMessage":"meta probe"}', exit: 0 }
test('SR113 META', async () => {
  const f = nudgeFailures(metaOut, ['meta probe'], [])
  assert.ok(f.length === 1 && /no mustNotMatch/iu.test(f[0]), `guard did not fire — reason='${f.join('; ')}'`)
})
test('SR114 META exemption honored', async () => {
  const f = nudgeFailures(metaOut, ['meta probe'], [], 'META: exercises the visible-exemption path so the escape hatch cannot rot unnoticed')
  assert.deepEqual(f, [], '-NoNegative exemption rejected')
})
