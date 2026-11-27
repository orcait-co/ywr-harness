// Self-test for the slice-close skill's text contract (ADR 0090).
// Self-contained, no fixtures, no child processes.
// Usage: node --test-reporter=<file URL of ../../lib/selftest-reporter.mjs> --test-reporter-destination=stdout skills/slice-close/slice-close.selftest.mjs
//
// The skill is prose a model executes, so what can regress silently is (1) a rare-case pointer
// that no longer resolves and (2) a contract line reverting to the old, costlier ritual. Case T1 is
// structural: every trigger in SKILL.md names a section reference.md has, and every section has a
// trigger (ADR 0090). A dangling trigger is how a rare case goes missing. The C cases pin the
// contract lines, each with the old wording as its negative, so a partial revert turns red instead
// of passing on presence alone. Non-ASCII in patterns is built from code points (SECTION, ARROW below), so this file stays ASCII.
//
// The META cases are named `M<n> META ...`, and the parity check matches the names (ADR 0227 decision 8).
// Patterns are case-insensitive regex sources (toRx in lib/selftest-lib.mjs), written with String.raw.
// A backtick inside such a pattern is written \` , which a regular expression reads as the backtick
// itself. Literal text goes through esc() below.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertMatch, matchFailures } from '../../lib/selftest-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const skillPath = path.join(here, 'SKILL.md')
const refPath = path.join(here, 'reference.md')
const procPath = path.join(here, '..', 'verify', 'procedure.md')
const r = String.raw
// The section sign and the arrow of the skill's trigger lines, built from code points so this file stays ASCII.
const SECTION = String.fromCharCode(0x00A7)
const ARROW = String.fromCharCode(0x2192)
// The text as a literal pattern.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const skill = readText(skillPath)
const ref = readText(refPath)

function textCase(name, text, mustMatch, mustNotMatch, noNegative = '') {
  test(name, () => assertMatch(text, { mustMatch, mustNotMatch, noNegative }))
}

test('T0 SKILL.md and reference.md both exist beside this suite', () => {
  const missing = [skillPath, refPath].filter((p) => !existsSync(p))
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`)
})

// --- T1: triggers resolve, both directions ---------------------------------------------------------
{
  const triggers = [...skill.matchAll(new RegExp('`reference\\.md` ' + SECTION + '([A-Za-z][A-Za-z-]*)', 'gu'))].map((m) => m[1])
  const markers = [...skill.matchAll(new RegExp('\\*\\*' + ARROW + ' ', 'gu'))].length
  const sections = [...ref.matchAll(/^## (.+?)\s*$/gmu)].map((m) => m[1])
  const dangling = triggers.filter((t) => !sections.includes(t))
  const orphans = sections.filter((s) => !triggers.includes(s))
  const dupes = [...new Set(triggers.filter((t, i) => triggers.indexOf(t) !== i))]
  const ok = triggers.length >= 1 && dangling.length === 0 && orphans.length === 0 && dupes.length === 0 && markers === triggers.length
  test('T1 every SKILL.md trigger names a reference.md section, every section has exactly one marked trigger', () => {
    assert.ok(ok, `triggers=[${triggers.join(', ')}] sections=[${sections.join(', ')}] dangling=[${dangling.join(', ')}] orphans=[${orphans.join(', ')}] duplicated=[${dupes.join(', ')}] markers=${markers}`)
  })
}
textCase('T2 SKILL.md names the reference file by its plugin path, and the rare-case detail stays out of it', skill,
  [esc('${CLAUDE_PLUGIN_ROOT}/skills/slice-close/reference.md')],
  ['git diff --name-only <old-base> <new-base>', 'did not re-confirm', r`min\(4, ceil`])
textCase('T3 reference.md carries the moved detail (rebase overlap command, ignored-tree forms), and no workflow or shard text', ref,
  [r`git -c core\.quotepath=false diff --name-only <old-base> <new-base>`,
    'review basis: reviewed at <sha>, rebased onto <sha>, overlap: none',
    'did not re-confirm',
    'none checked',
    r`A \`small\` or \`full\` tier runs \`medium\` \(ywr-harness ADR 0218\), with the files\s+as a path target`,
    esc("Skill({skill: 'code-review', args: 'medium --max-findings default <file> <file> ...'})"),
    'facts 251 and 255',
    r`When any listed path holds a space, a quote, a backslash, a control character or a non-ASCII\s+character, starts with \`-\`, holds only digits, names a branch or a level such as \`high\`, or no\s+longer exists in the tree, use the stage-2 call with no target for the whole re-arm`,
    r`Nobody probed many\s+files`,
    r`Record the\s+level, the item count, the usage line and the cap note of stage 2`,
    'the changed files as its path target'],
  [r`\`/slice-close\``, r`\`/verify\``, r`Workflow\(\{\s*name:\s*'(ywr-harness:)?adversarial-review'`, '(?m)^## Ultracode', '(?m)^## Shards', '(?m)^## Old-digest', r`stage-2\s+scope object`])

// --- C: the ADR 0090 contract lines -----------------------------------------------------------------
textCase('C1 stage 1: the range goes straight to the emitter, whose scope: FAILED is the range check (ADR 0041)', skill,
  [r`pass it to \`--range\` as given`, r`the emitter is the\s+range check \(ywr-harness ADR 0041\)`, 'scope: FAILED'],
  ['Sanity-check it first', 'git rev-parse'])
// C2: the review is /code-review at `medium` for both review tiers (ADR 0215, ADR 0218). What can regress silently is
// the workflow call back in the table, a level other than `medium`, a target the close never chose, a lost `--max-findings default` that lets a saved cap through, or a
// close that reads the canon file as if the command did.
textCase('C2 stage 2: /code-review through the Skill tool, small and full run medium (ADR 0218), no target, default cap, the canon through CLAUDE.md', skill,
  [esc("| `small` | `Skill({skill: 'code-review', args: 'medium --max-findings default'})` |"),
    esc("| `full` | `Skill({skill: 'code-review', args: 'medium --max-findings default'})` |"),
    r`at \`medium\` for both review tiers \(ywr-harness ADR 0218\)`,
    r`built-in \`/code-review\` command \(ywr-harness ADR 0215\)`,
    'with no target',
    r`Pass \`--max-findings default\` as written`,
    esc('`git log --oneline origin/HEAD..HEAD`'),
    "record that the commit list and the review's base are unknown",
    'Wait for its task notification',
    r`reaches the command only through \`CLAUDE\.md\``,
    'never a separate canon file',
    r`\*\*\`\(loaded at session start\)\`\*\*`,
    r`\*\*\`NO HEADING\`\*\*`,
    r`\*\*\`\(imported by <file>\)\`\*\*`,
    r`\*\*\`NOT IMPORTED\`\*\*`,
    r`\*\*\`NOT FOUND\`\*\*`,
    r`Do not move the canon into \`CLAUDE\.md\` unasked`,
    'Record the level and the item count',
    r`the\s+cap can hide findings`,
    r`\*\*Record the usage line too\*\*: the duration, the tool uses and the tokens`,
    'When the notification carries no usage line, record that'],
  ['imports the file that the emitter printed as', r`Workflow\(\{`, 'adversarial-review', 'sessionModel', r`stats\.worker_pins`, 'gates_passed', "shards: 'auto'", 'lensExtra'])
// C3: every finding gets a bucket (ADR 0215 decision 5), and the severity limits the bucket (ADR 0216). What can
// regress silently is a severity filter that lists nit findings instead of dispositioning them, an important finding
// deferred to an open item, or a fix on an untested host behaviour without a probe.
textCase('C3 disposition: every finding a bucket per site, the severity recorded and limiting the bucket, important never deferred, a nit open item only for a design or coverage change, probe first', skill,
  ['every finding ends in exactly one of three buckets',
    r`\`important\`, \`pre_existing\`, \`nit\` or none`,
    r`it limits the buckets \(ywr-harness ADR 0216\)`,
    'a bucket per site',
    r`only for a \`nit\` whose fix would change a design or a coverage`,
    r`An \`important\` finding, a \`pre_existing\` finding and a finding with no severity end fixed or false on\s+reading\. Never valid, no action`,
    r`\*\*Probe first\*\*`,
    'probe on the real use path before the fix',
    r`ask the owner with AskUserQuestion\s+before the fix`],
  [r`(?i)\bnits?\b[^.]{0,40}(are|is) listed`, '(?i)lows are listed', r`every confirmed \*\*high or medium\*\* finding ends`, 'No rule reads it', 'whatever its severity'])
textCase("C4 fix gates: the emitter over the fix's own files, suite-level iteration", skill,
  [esc('harness_gates.mjs" <every file the fix touched>'), 'never a default run', r`own test file\s+directly`],
  ['re-run the emitter over the fix diff'])
textCase('C5 fix checks: every fixed finding but a nit, batched legs, at most 4, per-finding verdicts, critical gets its own, the pinned worker under ultracode too', skill,
  ['ywr-harness ADR 0090',
    r`every fixed finding except a \`nit\` goes to a\s+skeptic leg`,
    r`\*\*batched\*\*`,
    'at most 4 findings per leg',
    'leg of its own for a fix that touches a declared critical surface',
    r`\*\*per finding\*\* exactly \`fixed: true\|false\``,
    'ultracode or not, ywr-harness ADR 0108',
    r`A fixed \`nit\` goes through the gates of step 1 and gets no leg`],
  ['spawn ONE skeptic leg', r`\*\*High and medium\*\* findings go to skeptic legs`, r`\`general-purpose\` under ultracode`, r`(?i)a fixed \`?nit\`? gets a (fix check|leg)`])
textCase('C6 stage 3: mapper first, no run: line means no verify spawn and a verbatim scope statement', skill,
  [esc('scripts/verify_map.mjs" [--range <a>..<b>]'), r`No \`run:\` line`, r`do \*\*not\*\*\s+invoke the verify skill`, r`scope statement, \*\*not\*\* a pass`, r`/ywr-harness:verify <a>\.\.<b>`],
  [r`(?m)^Invoke \`/ywr-harness:verify\``])
textCase('C7 stage 5: one commit, record in the body, handoff names the commit carrying it, no no-change commit', skill,
  [r`\*\*ONE commit\*\*`, 'message body', 'at most 72 characters', 'the commit carrying this handoff', esc('git log -1 --format=%h -- <handoff>'), 'Delete DONE items', 'never gets a commit', r`harness_retro\.mjs`,
    r`the emitter's \`review canon:\` line, and\s+whether the canon, its import or its section changed during this session`],
  [r`(?m)^- Commit\. State in the close:`, 'kept for the lettering', 'whether this session started with that import'])
textCase('C8 ADR 0072 rule stays named in SKILL.md in one line', skill,
  [r`re-arms it only over the overlap \(ywr-harness ADR 0072\)`, 'hand-resolved conflict', 'review basis:'],
  [r`\(in the reviewed scope or\s+not`])

// C9: the verify procedure (spec 0007 section 3.7) follows C1's rule. Its agent passes the range to the mapper
// as given. The git pre-check wording is the negative, and the no-silent-fallback rule must survive.
textCase('C9 verify procedure: range goes to the mapper as given, no own git pre-check, no silent fallback', readText(procPath),
  ['Pass it to the mapper as given', r`the mapper is the range check \(ywr-harness ADR 0041`, 'Do NOT silently fall back', 'scope: FAILED'],
  ['Sanity-check it first', 'git rev-parse'])

// C10: the prepared close (ADR 0105). What can regress silently is reuse without the identity check
// (a report taken on trust), a same-line reuse that skips the emitter's trailer (config and ignored
// paths are outside the tree), a changed tree that still skips stages 1 and 3, or a changed file that
// never re-arms the review. The negatives are the loosened rules a rewrite could slip in beside the
// required lines, because presence alone lets a contradicting sentence pass.
textCase('C10 prepared close: reuse only on an identical --tree line, verbatim in this session, with the emitter re-run; a change re-runs stages 1+3 and re-arms the review over the changed files', ref,
  [esc('scripts/harness_gates.mjs" --tree'),
    'verbatim in THIS session',
    'is no report: run every stage',
    r`tree: FAILED\` ${ARROW} nothing is reused`,
    'run the emitter itself again',
    r`Re-run none of the printed commands,\s+the review or verify`,
    r`The \`gates:\` window differs`,
    'prepared: reused at <the tree line>',
    'Run stages 1 and 3 in full',
    esc('git -c core.quotepath=false diff --name-only <report tree id> <fresh tree id>'),
    'review basis: prepared at',
    'writes no handoff and makes no commit'],
  ['(?i)(paraphrase|summary)[^.]{0,40}(is enough|suffices|counts as (a|the) report)', '(?i)another session[^.]{0,40}(may|can) be reused', '(?i)the tree line alone', '(?i)owner-typed'])
textCase('C10 SKILL.md states who runs the close, asks open owner questions first, and records a reused preparation', skill,
  [r`\*\*The person or the main session runs it\*\* \(ywr-harness ADR 0201\)`, 'every owner question of the slice has an answer', 'refuses a call from a subagent', 'prepared: reused at'],
  ['(?m)^disable-model-invocation:', '(?i)owner-typed on purpose', 'ywr-harness ADR 0198'])
// The description is the one line the host shows for model invocation. It says that the main session may call the
// close once every owner question has an answer, that a subagent never does, and it never says "owner-typed".
const descLine = /^description:.*$/mu.exec(skill)?.[0] ?? ''
textCase('C10 SKILL.md description (frontmatter): the main session calls it once every owner question of the slice has an answer; a subagent never calls it; no owner-typed', descLine,
  ['^description: ', 'the person types it, or the main session calls it after its ready report', 'once every owner question of the slice has an answer', r`A subagent never calls it\.`],
  ['(?i)owner-typed'])

// C11: the three disposition buckets (ADR 0163). What can regress silently is a "valid, no action"
// with no record behind it, a "false on reading" with no quoted line, or a two-way wording that
// lets a true claim close on a bare reason.
textCase('C11 disposition: three buckets, no-action names its record, false-on-reading quotes the code', skill,
  ['ends in exactly one of three buckets', r`\*\*fixed\*\*`, r`\*\*valid, no action\*\*`, 'names the record that keeps it', 'A true claim with no record is not this bucket', r`\*\*false on reading\*\*`, 'quotes the line or guard', 'count per bucket'],
  ['every confirmed finding is fixed or gets an explicit reason'])
// C11b: the skill has no low list, class line or fix proof (ADR 0215). What can regress silently is one of
// them back in the skill or the stage-5 record list, or the prepared report asking for proof output.
textCase('C11b no low list, no class line, no class tally, no fix proof in the skill; the record carries level, count and buckets', skill,
  ['the level, the item count, the usage line and the cap note of stage 2', "each finding's severity and bucket", r`each fix passed to an open item or \`none\``],
  ['fix_proof', '(?i)class line', '(?i)class tally', 'high_ids', '(?i)lows are listed', 'the low list of stage 2', 'commit-msg hook', r`\`--coverage\``])
textCase('C12 the prepared report carries the level, the item count, the usage line, every bucket and every fix verdict, and no fix-proof output', ref,
  [r`the review's level, item count and usage line, every\s+finding's severity and bucket, every fix verdict`],
  ['fix_proof', 'digest', '(?i)waiver'])

// --- META: the assertion guard must be able to fail -----------------------------------------------
test('M1 META', () => {
  const f = matchFailures('meta probe', { mustMatch: ['meta probe'], mustNotMatch: [] })
  assert.ok(f.length === 1 && /no mustNotMatch/iu.test(f[0]), `guard did not fire - reason='${f.join('; ')}'`)
})
test('M2 META a MustMatch miss is reported as a failure', () => {
  const f = matchFailures('abc', { mustMatch: ['zzz'], mustNotMatch: ['qqq'] })
  assert.ok(f.length > 0, 'a non-matching text passed')
})
