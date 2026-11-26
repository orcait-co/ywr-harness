# Self-test for the slice-close skill's text contract (ADR 0090).
# Self-contained, no fixtures, no child processes. Usage: pwsh plugins/ywr-harness/skills/slice-close/slice-close.selftest.ps1
#
# The skill is prose a model executes, so what can regress silently is (1) a rare-case pointer
# that no longer resolves and (2) a contract line reverting to the old, costlier ritual. Case T1 is
# structural: every trigger in SKILL.md names a section reference.md has, and every section has a
# trigger (ADR 0090, S10 - the rare cases moved out behind one-line triggers, and a dangling
# trigger is exactly how a rare case goes missing). The C cases pin the ADR 0090 contract lines,
# each with the old wording as its negative, so a partial revert turns red instead of passing on
# presence alone. Non-ASCII in patterns is spelled as \uXXXX so this file stays ASCII.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../lib/selftest-lib.ps1')   # assertion core
$skillPath = Join-Path $PSScriptRoot 'SKILL.md'
$refPath = Join-Path $PSScriptRoot 'reference.md'

function Assert-Text([string]$Name, [string]$Text, [string[]]$MustMatch, [string[]]$MustNotMatch, [string]$NoNegative = '') {
    $script:LastFails = Get-AssertionFailure -Text $Text -MustMatch $MustMatch -MustNotMatch $MustNotMatch -NoNegative $NoNegative
    return (Write-CaseVerdict -Name $Name -Fail $script:LastFails)
}

$ok = $true
$ok = (Assert-True 'T0 SKILL.md and reference.md both exist beside this suite' ((Test-Path -LiteralPath $skillPath -PathType Leaf) -and (Test-Path -LiteralPath $refPath -PathType Leaf)) `
        "missing: $(@($skillPath, $refPath | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }) -join ', ')") -and $ok
if (-not $ok) { Write-Host 'slice-close selftest: FAILED' -ForegroundColor Red; exit 1 }
$skill = Get-Content -LiteralPath $skillPath -Raw -Encoding utf8
$ref = Get-Content -LiteralPath $refPath -Raw -Encoding utf8

# --- T1: triggers resolve, both directions ---------------------------------------------------------
$triggers = @([regex]::Matches($skill, '`reference\.md` \u00A7([A-Za-z][A-Za-z-]*)') | ForEach-Object { $_.Groups[1].Value })
$markers = [regex]::Matches($skill, '\*\*\u2192 ').Count
$sections = @([regex]::Matches($ref, '(?m)^## (.+?)\s*$') | ForEach-Object { $_.Groups[1].Value })
$dangling = @($triggers | Where-Object { $sections -cnotcontains $_ })
$orphans = @($sections | Where-Object { $triggers -cnotcontains $_ })
$dupes = @($triggers | Group-Object -CaseSensitive | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
$t1 = ($triggers.Count -ge 1) -and ($dangling.Count -eq 0) -and ($orphans.Count -eq 0) -and ($dupes.Count -eq 0) -and ($markers -eq $triggers.Count)
$ok = (Assert-True 'T1 every SKILL.md trigger names a reference.md section, every section has exactly one marked trigger' $t1 `
        "triggers=[$($triggers -join ', ')] sections=[$($sections -join ', ')] dangling=[$($dangling -join ', ')] orphans=[$($orphans -join ', ')] duplicated=[$($dupes -join ', ')] markers=$markers") -and $ok
$ok = (Assert-Text 'T2 SKILL.md names the reference file by its plugin path, and the rare-case detail stays out of it' $skill `
        @([regex]::Escape('${CLAUDE_PLUGIN_ROOT}/skills/slice-close/reference.md')) `
        @('git diff --name-only <old-base> <new-base>', 'did not re-confirm', 'min\(4, ceil')) -and $ok
$ok = (Assert-Text 'T3 reference.md carries the moved detail (rebase overlap command, ignored-tree forms), and no workflow or shard text' $ref `
        @('git -c core\.quotepath=false diff --name-only <old-base> <new-base>', 'review basis: reviewed at <sha>, rebased onto <sha>, overlap: none', 'did not re-confirm', 'none checked', 'A `small` or `full` tier runs `medium` \(ywr-harness ADR 0218\), with the files\s+as a path target', [regex]::Escape("Skill({skill: 'code-review', args: 'medium <file> <file> ...'})"), 'facts 251 and 255', 'When any listed path holds a space, a quote, a backslash, a control character or a non-ASCII\s+character, starts with `-`, holds only digits, names a branch or a level such as `high`, or no\s+longer exists in the tree, use the stage-2 call with no target for the whole re-arm', 'Nobody probed many\s+files', 'Record the\s+level, the item count, the usage line and the cap note of stage 2', 'the changed files as its path target') `
        @('`/slice-close`', '`/verify`', "Workflow\(\{\s*name:\s*'(ywr-harness:)?adversarial-review'", '(?m)^## Ultracode', '(?m)^## Shards', '(?m)^## Old-digest', 'stage-2\s+scope object')) -and $ok

# --- C: the ADR 0090 contract lines -----------------------------------------------------------------
$ok = (Assert-Text 'C1 stage 1: the range goes straight to the emitter, whose scope: FAILED is the range check (ADR 0041)' $skill `
        @('pass it to `--range` as given', 'the emitter is the\s+range check \(ywr-harness ADR 0041\)', 'scope: FAILED') `
        @('Sanity-check it first', 'git rev-parse')) -and $ok
# C2: the review is /code-review at `medium` for both review tiers (ADR 0215, ADR 0218). What can regress silently is
# the workflow call back in the table, a level other than `medium`, a target or findings cap the close never chose, or a
# close that reads the canon file as if the command did.
$ok = (Assert-Text 'C2 stage 2: /code-review through the Skill tool, small and full run medium (ADR 0218), no target, default cap, the canon through CLAUDE.md' $skill `
        @([regex]::Escape("| ``small`` | ``Skill({skill: 'code-review', args: 'medium'})`` |"), [regex]::Escape("| ``full`` | ``Skill({skill: 'code-review', args: 'medium'})`` |"), 'at `medium` for both review tiers \(ywr-harness ADR 0218\)', 'built-in `/code-review` command \(ywr-harness ADR 0215\)', 'with no target', 'Pass no `--max-findings`', [regex]::Escape('`git log --oneline origin/HEAD..HEAD`'), 'record that the commit list and the review''s base are unknown', 'Wait for its task notification', 'reaches the command only through `CLAUDE\.md`', 'never a separate canon file', '\*\*`\(loaded at session start\)`\*\*', '\*\*`NO HEADING`\*\*', '\*\*`\(imported by <file>\)`\*\*', '\*\*`NOT IMPORTED`\*\*', '\*\*`NOT FOUND`\*\*', 'Do not move the canon into `CLAUDE\.md` unasked', 'Record the level and the item count', 'the\s+cap can hide findings', '\*\*Record the usage line too\*\*: the duration, the tool uses and the tokens', 'When the notification carries no usage line, record that') `
        @('imports the file that the emitter printed as', 'Workflow\(\{', 'adversarial-review', 'sessionModel', 'stats\.worker_pins', 'gates_passed', "shards: 'auto'", 'lensExtra')) -and $ok
# C3: every finding gets a bucket (ADR 0215 decision 5), and the severity limits the bucket (ADR 0216). What can
# regress silently is a severity filter that lists nit findings instead of dispositioning them, an important finding
# deferred to an open item, or a fix on an untested host behaviour without a probe.
$ok = (Assert-Text 'C3 disposition: every finding a bucket per site, the severity recorded and limiting the bucket, important never deferred, a nit open item only for a design or coverage change, probe first' $skill `
        @('every finding ends in exactly one of three buckets', '`important`, `pre_existing`, `nit` or none', 'it limits the buckets \(ywr-harness ADR 0216\)', 'a bucket per site', 'only for a `nit` whose fix would change a design or a coverage', 'An `important` finding, a `pre_existing` finding and a finding with no severity end fixed or false on\s+reading\. Never valid, no action', '\*\*Probe first\*\*', 'probe on the real use path before the fix', 'ask the owner with AskUserQuestion\s+before the fix') `
        @('(?i)\bnits?\b[^.]{0,40}(are|is) listed', '(?i)lows are listed', 'every confirmed \*\*high or medium\*\* finding ends', 'No rule reads it', 'whatever its severity')) -and $ok
$ok = (Assert-Text 'C4 fix gates: the emitter over the fix''s own files, suite-level iteration' $skill `
        @([regex]::Escape('harness_gates.mjs" <every file the fix touched>'), 'never a default run', 'own test file\s+directly') `
        @('re-run the emitter over the fix diff')) -and $ok
$ok = (Assert-Text 'C5 fix checks: every fixed finding but a nit, batched legs, at most 4, per-finding verdicts, critical gets its own, the pinned worker under ultracode too' $skill `
        @('ywr-harness ADR 0090', 'every fixed finding except a `nit` goes to a\s+skeptic leg', '\*\*batched\*\*', 'at most 4 findings per leg', 'leg of its own for a fix that touches a declared critical surface', '\*\*per finding\*\* exactly `fixed: true\|false`', 'ultracode or not, ywr-harness ADR 0108', 'A fixed `nit` goes through the gates of step 1 and gets no leg') `
        @('spawn ONE skeptic leg', '\*\*High and medium\*\* findings go to skeptic legs', '`general-purpose` under ultracode', '(?i)a fixed `?nit`? gets a (fix check|leg)')) -and $ok
$ok = (Assert-Text 'C6 stage 3: mapper first, no run: line means no verify spawn and a verbatim scope statement' $skill `
        @([regex]::Escape('scripts/verify_map.mjs" [--range <a>..<b>]'), 'No `run:` line', 'do \*\*not\*\*\s+invoke the verify skill', 'scope statement, \*\*not\*\* a pass', '/ywr-harness:verify <a>\.\.<b>') `
        @('(?m)^Invoke `/ywr-harness:verify`')) -and $ok
$ok = (Assert-Text 'C7 stage 5: one commit, record in the body, handoff names the commit carrying it, no no-change commit' $skill `
        @('\*\*ONE commit\*\*', 'message body', 'at most 72 characters', 'the commit carrying this handoff', [regex]::Escape('git log -1 --format=%h -- <handoff>'), 'Delete DONE items', 'never gets a commit', 'harness_retro\.mjs', 'the emitter''s `review canon:` line, and\s+whether the canon, its import or its section changed during this session') `
        @('(?m)^- Commit\. State in the close:', 'kept for the lettering', 'whether this session started with that import')) -and $ok
$ok = (Assert-Text 'C8 ADR 0072 rule stays named in SKILL.md in one line' $skill `
        @('re-arms it only over the overlap \(ywr-harness ADR 0072\)', 'hand-resolved conflict', 'review basis:') `
        @('\(in the reviewed scope or\s+not')) -and $ok

# C9: the verify procedure (spec 0007 s3.7) follows C1's rule - its agent passes the range to the mapper
# as given; the old git pre-check wording is the negative, the no-silent-fallback rule must survive.
$procPath = Join-Path $PSScriptRoot '../verify/procedure.md'
$proc = if (Test-Path -LiteralPath $procPath -PathType Leaf) { Get-Content -LiteralPath $procPath -Raw -Encoding utf8 } else { '' }
$ok = (Assert-Text 'C9 verify procedure: range goes to the mapper as given, no own git pre-check, no silent fallback' $proc `
        @('Pass it to the mapper as given', 'the mapper is the range check \(ywr-harness ADR 0041', 'Do NOT silently fall back', 'scope: FAILED') `
        @('Sanity-check it first', 'git rev-parse')) -and $ok

# C10: the prepared close (ADR 0105). What can regress silently is reuse without the identity check
# (a report taken on trust), a same-line reuse that skips the emitter's trailer (config and ignored
# paths are outside the tree), a changed tree that still skips stages 1 and 3, or a changed file that
# never re-arms the review. The negatives are the loosened rules a rewrite could slip in beside the
# required lines (review 2026-09-28, low: presence alone let a contradicting sentence pass).
$ok = (Assert-Text 'C10 prepared close: reuse only on an identical --tree line, verbatim in this session, with the emitter re-run; a change re-runs stages 1+3 and re-arms the review over the changed files' $ref `
        @([regex]::Escape('scripts/harness_gates.mjs" --tree'), 'verbatim in THIS session', 'is no report: run every stage', 'tree: FAILED` \u2192 nothing is reused', 'run the emitter itself again', 'Re-run none of the printed commands,\s+the review or verify', 'The `gates:` window differs', 'prepared: reused at <the tree line>', 'Run stages 1 and 3 in full', [regex]::Escape('git -c core.quotepath=false diff --name-only <report tree id> <fresh tree id>'), 'review basis: prepared at', 'writes no handoff and makes no commit') `
        @('(?i)(paraphrase|summary)[^.]{0,40}(is enough|suffices|counts as (a|the) report)', '(?i)another session[^.]{0,40}(may|can) be reused', '(?i)the tree line alone', '(?i)owner-typed')) -and $ok
$ok = (Assert-Text 'C10 SKILL.md states who runs the close, asks open owner questions first, and records a reused preparation' $skill `
        @('\*\*The person or the main session runs it\*\* \(ywr-harness ADR 0201\)', 'every owner question of the slice has an answer', 'refuses a call from a subagent', 'prepared: reused at') `
        @('(?m)^disable-model-invocation:', '(?i)owner-typed on purpose', 'ywr-harness ADR 0198')) -and $ok
# The description is the one line the host shows for model invocation: it must say that the main session may call the
# close once every owner question has an answer, that a subagent never does, and no longer say "owner-typed".
$descLine = [regex]::Match($skill, '(?m)^description:.*$').Value
$ok = (Assert-Text 'C10 SKILL.md description (frontmatter): the main session calls it once every owner question of the slice has an answer; a subagent never calls it; no owner-typed' $descLine `
        @('^description: ', 'the person types it, or the main session calls it after its ready report', 'once every owner question of the slice has an answer', 'A subagent never calls it\.') `
        @('(?i)owner-typed')) -and $ok

# C11: the three disposition buckets (ADR 0163, pstack candidate 9). What
# can regress silently is a "valid, no action" with no record behind it, a "false on reading" with no
# quoted line, or the old two-way wording that let a true claim close on a bare reason.
$ok = (Assert-Text 'C11 disposition: three buckets, no-action names its record, false-on-reading quotes the code' $skill `
        @('ends in exactly one of three buckets', '\*\*fixed\*\*', '\*\*valid, no action\*\*', 'names the record that keeps it', 'A true claim with no record is not this bucket', '\*\*false on reading\*\*', 'quotes the line or guard', 'count per bucket') `
        @('every confirmed finding is fixed or gets an explicit reason')) -and $ok
# C11b: ADR 0215 retires the low list, the class line and the fix proof. What can regress silently is one of
# them back in the skill or the stage-5 record list, or the prepared report still asking for proof output.
$ok = (Assert-Text 'C11b no low list, no class line, no class tally, no fix proof in the skill; the record carries level, count and buckets' $skill `
        @('the level, the item count, the usage line and the cap note of stage 2', 'each finding''s severity and bucket', 'each fix passed to an open item or `none`') `
        @('fix_proof', '(?i)class line', '(?i)class tally', 'high_ids', '(?i)lows are listed', 'the low list of stage 2', 'commit-msg hook', '`--coverage`')) -and $ok
$ok = (Assert-Text 'C12 the prepared report carries the level, the item count, the usage line, every bucket and every fix verdict, and no fix-proof output' $ref `
        @('the review''s level, item count and usage line, every\s+finding''s severity and bucket, every fix verdict') `
        @('fix_proof', 'digest', '(?i)waiver')) -and $ok

# --- META: the assertion guard must be able to fail -----------------------------------------------
$accepted = Assert-Text 'META probe' 'meta probe' @('meta probe') @() 6>$null
if ($accepted -or $script:LastFails.Count -ne 1 -or ($script:LastFails[0] -notmatch 'no MustNotMatch')) {
    Write-Host "FAIL [META]: guard did not fire - accepted=$accepted reason='$($script:LastFails -join '; ')'" -ForegroundColor Red
    $ok = $false
}
else { Write-Host 'PASS [META]: negative-less case rejected, on the guard reason alone' -ForegroundColor Green }
$missed = Assert-Text 'META miss probe' 'abc' @('zzz') @('qqq') 6>$null
$ok = (Assert-True 'META a MustMatch miss is reported as a failure' (-not $missed) 'Assert-Text passed on a non-matching text') -and $ok

if (-not $ok) { Write-Host 'slice-close selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'slice-close selftest: all cases green' -ForegroundColor Green
exit 0
