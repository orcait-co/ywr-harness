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
. (Join-Path $PSScriptRoot '../../lib/selftest-lib.ps1')   # assertion core, ADR 0125
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
$ok = (Assert-Text 'T3 reference.md carries the moved detail (rebase overlap command, ignored-tree forms, shard partition)' $ref `
        @('git diff --name-only <old-base> <new-base>', 'review basis: reviewed at <sha>, rebased onto <sha>, overlap: none', 'did not re-confirm', 'none checked', 'exact partition of `files`', 'stats\.worker_pins') `
        @('`/slice-close`', '`/verify`', "Workflow\(\{\s*name:\s*'adversarial-review'")) -and $ok

# --- C: the ADR 0090 contract lines -----------------------------------------------------------------
$ok = (Assert-Text 'C1 stage 1: the range goes straight to the emitter, whose scope: FAILED is the range check (ADR 0041)' $skill `
        @('pass it to `--range` as given', 'the emitter is the\s+range check \(ADR 0041\)', 'scope: FAILED') `
        @('Sanity-check it first', 'git rev-parse')) -and $ok
$ok = (Assert-Text 'C2 stage 2 scope: exclusions named, lockstep noted, ~8 counts what remains, effort slot in the template' $skill `
        @("the emitter's file list minus the exclusions", 'drift gate passed', 'declared handoff', 'lockstep: manifest-gate PASS', 'more than ~8 files remain after\s+the exclusions', 'recall lever', "(?m)^\s+effort: '<only beside ultracode") `
        @("files: \[<the emitter's file list>\]", 'for round-trip-bound finders only')) -and $ok
$ok = (Assert-Text 'C3 disposition: also_at sites and 1-1 split rejections are the closer''s to read' $skill `
        @('also_at', 'rejected\[\]', 'split 1\u20131', 'rejected_count') `
        @('Then judge each one \*instance vs class\*')) -and $ok
$ok = (Assert-Text 'C4 fix gates: the emitter over the fix''s own files, suite-level iteration' $skill `
        @([regex]::Escape('harness_gates.py" <every file the fix touched>'), 'never a default run', 'own test file\s+directly') `
        @('re-run the emitter over the fix diff')) -and $ok
$ok = (Assert-Text 'C5 fix checks: batched legs, at most 4, per-finding verdicts, critical gets its own, general-purpose under ultracode' $skill `
        @('ADR 0090', '\*\*batched\*\*', 'at most 4 findings per leg', 'leg of its own for a fix that touches a declared\s+critical surface', '\*\*per finding\*\* exactly `fixed: true\|false`', '`general-purpose` under ultracode') `
        @('spawn ONE skeptic leg', 'For a \*\*high or medium\*\* finding')) -and $ok
$ok = (Assert-Text 'C6 stage 3: mapper first, no run: line means no verify spawn and a verbatim scope statement' $skill `
        @([regex]::Escape('scripts/verify_map.py" [--range <a>..<b>]'), 'No `run:` line', 'do \*\*not\*\*\s+invoke the verify skill', 'scope statement, \*\*not\*\* a pass', '/ywr-harness:verify <a>\.\.<b>') `
        @('(?m)^Invoke `/ywr-harness:verify`')) -and $ok
$ok = (Assert-Text 'C7 stage 5: one commit, record in the body, handoff names the commit carrying it, no no-change commit' $skill `
        @('\*\*ONE commit\*\*', 'message body', 'at most 72 characters', 'the commit carrying this handoff', [regex]::Escape('git log -1 --format=%h -- <handoff>'), 'Delete DONE items', 'never gets a commit', 'harness_retro\.py') `
        @('(?m)^- Commit\. State in the close:', 'kept for the lettering')) -and $ok
$ok = (Assert-Text 'C8 ADR 0072 rule stays named in SKILL.md in one line' $skill `
        @('re-arms it only over the overlap \(ADR 0072\)', 'hand-resolved conflict', 'review basis:') `
        @('\(in the reviewed scope or\s+not')) -and $ok

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
