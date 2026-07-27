# Self-test for workflow-gates.mjs (ADR 0124) — the file the ADR 0106 router discovers, which is
# how the JS-side gates reach CI at all: naming it *.selftest.ps1 needs zero ci.yml wiring
# (ADR 0123), and .claude/workflows/ now routes to the scripts group that owns it.
#
# Two arms, the ADR 0123 shape:
#   live      the real repo corpus — exit 0, and the known workflow file must appear by name so a
#             silently shrinking corpus is visible. Counts are printed, NOT asserted exactly:
#             adding a second workflow is legitimate growth, removing the only one is not.
#   fixture   temp trees driving every terminal branch, including the clean cases. Without those
#             the arm could be green by rejecting everything (ADR 0118 vacuous-pass discipline).
#
# Usage: pwsh plugins/ywr-harness/scripts/workflow-gates.selftest.ps1  (exit 0 = all green). ~3 s.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core, ADR 0125
$gate = Join-Path $PSScriptRoot 'workflow-gates.mjs'
# The LIVE corpus here is this plugin's own workflows/ (plugin root = one level up from scripts/),
# not a repo's .claude/workflows — the gate takes the corpus dir as an option for exactly this
# reason. The fixtures below deliberately keep using .claude/workflows, so the default path stays
# exercised too: if only the option were tested, the default could rot unnoticed in consumers.
$liveRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$liveDir = 'workflows'

# Terminal branches of the node dependency, all three asserted below (M1-M3). The pwsh Linux
# image (ADR 0122) ships WITHOUT node, so a hard failure there would report Linux breakage that
# does not exist — the exact reason git is installed in that image rather than skipped around.
# CI's ubuntu runner does have node and runs this same file, so absence THERE means the gate
# stopped running and must be loud.
function Resolve-NodeVerdict([bool]$NodePresent, [bool]$OnCi) {
    if ($NodePresent) { return @{ Verdict = 'run'; Message = '' } }
    if ($OnCi) { return @{ Verdict = 'fail'; Message = 'node absent on CI — a missing interpreter is not a pass' } }
    return @{ Verdict = 'skip'; Message = 'node absent (reported, not silent) — CI ubuntu runs this gate; the pwsh Linux image has no node' }
}

function New-Fixture([string]$Name, [hashtable]$Files) {
    $rootDir = Join-Path $fxBase $Name
    $wf = Join-Path $rootDir '.claude/workflows'
    New-Item -ItemType Directory -Force $wf | Out-Null
    foreach ($k in $Files.Keys) { [IO.File]::WriteAllText((Join-Path $wf $k), $Files[$k]) }
    return $rootDir
}

function Invoke-Gate([string]$Root, [string]$Dir) {
    $a = @('--root', $Root)
    if ($Dir) { $a += @('--dir', $Dir) }
    $out = & node $gate @a 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}

# The ADR #116 empty-MustNotMatch guard and the match loops live in the shared assertion core
# (ADR 0125) — this file's copy called itself the sixth and was actually the seventh. Keeping
# the selftest runnable alone was the reason given for duplicating it; a dot-source keeps that
# property, since the library is a repo file and not a module install.
function Assert-Case([string]$Name, $R, [int]$ExpectExit, [string[]]$MustMatch, [string[]]$MustNotMatch, [string]$NoNegative = '') {
    $pre = @()
    if ($R.Code -ne $ExpectExit) { $pre += "exit $($R.Code) (expected $ExpectExit)" }
    $script:LastFails = Get-AssertionFailure -Text $R.Out -MustMatch $MustMatch -MustNotMatch $MustNotMatch `
        -NoNegative $NoNegative -PreFail $pre
    return (Write-CaseVerdict -Name $Name -Fail $script:LastFails -Detail $R.Out)
}

$node = Resolve-NodeVerdict ([bool](Get-Command node -ErrorAction SilentlyContinue)) ([bool]$env:GITHUB_ACTIONS)
if ($node.Verdict -eq 'fail') { Write-Host "FAIL [node]: $($node.Message)" -ForegroundColor Red; exit 1 }
if ($node.Verdict -eq 'skip') { Write-Host "SKIP [workflow-gates]: $($node.Message)" -ForegroundColor Yellow; exit 0 }

# Fixture root AFTER the node gate on purpose (ADR 0126): the two early exits above leave
# before anything is created, so neither of them has a tree to leak. New-Fixture below reads
# $fxBase and is never called ahead of this line.
$fxBase = New-FixtureRoot 'workflow-gates-selftest'
trap { Remove-FixtureRoot $fxBase; break }   # exception-safe teardown, ADR 0126

# The awkward shape the gate exists for: `export const meta` AND a top-level return/await in one
# file. Case D proves `node --check` rejects exactly this, which is why the transform exists.
$legal = @'
export const meta = { name: 'fx', description: 'fixture', phases: [{ title: 'P' }] }
phase('P')
const r = await agent('x', { model: 'sonnet', effort: 'low' })
return { r }
'@
$broken = @'
export const meta = { name: 'bad', description: 'fixture' }
const r = await agent('x'
return { r }
'@
$noMeta = @'
const meta = { name: 'nometa', description: 'fixture' }
return meta
'@
$passSelftest = "process.exit(0)`n"
$failSelftest = "console.log('fixture selftest is meant to fail');`nprocess.exit(1)`n"

$ok = $true

# A live: the real corpus. Negatives pin that no arm reported a failure and that the vacuity
# guards stayed quiet — a green run whose counts came from an empty glob is the class this gate
# is built to refuse.
$ok = (Assert-Case 'A live corpus' (Invoke-Gate $liveRoot $liveDir) 0 `
        @('ok — parsed workflows/adversarial-review\.js',
        'ok — selftest passed workflows/adversarial-review\.selftest\.mjs',
        'green — [1-9][0-9]* workflow script\(s\) parsed, [1-9][0-9]* selftest file\(s\) passed') `
        @('FAIL —', 'vacuous')) -and $ok

# B a syntax error is caught and named. Negatives: a parse failure must not coexist with a green
# verdict — that combination is the whole failure mode ADR 0115 recorded as ungated.
$fxBroken = New-Fixture 'broken' @{ 'bad.js' = $broken; 'bad.selftest.mjs' = $passSelftest }
$ok = (Assert-Case 'B syntax error fails' (Invoke-Gate $fxBroken) 1 `
        @('FAIL — \.claude/workflows/bad\.js: SyntaxError') @('green —')) -and $ok

# C the legal-but-awkward shape stays CLEAN, and its selftest is actually executed.
$fxLegal = New-Fixture 'legal' @{ 'good.js' = $legal; 'good.selftest.mjs' = $passSelftest }
$ok = (Assert-Case 'C legal shape clean' (Invoke-Gate $fxLegal) 0 `
        @('ok — parsed \.claude/workflows/good\.js', 'ok — selftest passed .*good\.selftest\.mjs', 'green —') `
        @('FAIL —')) -and $ok

# D why this gate is not a `node --check` wrapper, MEASURED rather than argued (2026-07-25, node
# v24.14.0): the `export` line makes the file module-detected and NOT syntax-checked, so --check
# exits 0 on the same broken file case B rejects — proven on the real adversarial-review.js with
# an unbalanced paren injected mid-file, not only on this fixture. ADR 0115 recorded the opposite
# direction (a false alarm on a valid file); the direction that matters is the silent pass.
# A node version that starts rejecting it does NOT break anything here, so this WARNs rather than
# fails — it is the trigger to re-read the ADR 0124 rationale, not a defect signal.
$dOut = (& node --check (Join-Path $fxBroken '.claude/workflows/bad.js') 2>&1 | Out-String)
$dRc = $LASTEXITCODE
if ($dRc -eq 0 -and $dOut -notmatch 'SyntaxError') {
    Write-Host 'PASS [D node --check is vacuous on this class]' -ForegroundColor Green
}
else {
    Write-Host "WARN [D]: node --check now rejects the broken workflow (rc=$dRc) — the custom parser is still correct, but re-read the ADR 0124 rationale before citing --check as unusable" -ForegroundColor Yellow
}

# E vacuous corpus: an empty directory FAILS both arms rather than printing a green zero.
$fxEmpty = New-Fixture 'empty' @{}
$ok = (Assert-Case 'E empty corpus fails' (Invoke-Gate $fxEmpty) 1 `
        @('zero workflow scripts', 'zero \*\.selftest\.mjs') @('green —')) -and $ok

# F the behavioral arm is wired, not merely discovered: a selftest exiting non-zero fails the gate
# and its own stdout reaches the log (stdio is inherited).
$fxFailing = New-Fixture 'failing' @{ 'good.js' = $legal; 'good.selftest.mjs' = $failSelftest }
$ok = (Assert-Case 'F failing selftest fails the gate' (Invoke-Gate $fxFailing) 1 `
        @('fixture selftest is meant to fail', 'FAIL — selftest failed \(exit 1\)') @('green —')) -and $ok

# G a workflow without the `export const meta` anchor is rejected. The transform is anchored on
# it and the Workflow tool requires it, so a file missing it is dead on arrival.
$fxNoMeta = New-Fixture 'nometa' @{ 'plain.js' = $noMeta; 'plain.selftest.mjs' = $passSelftest }
$ok = (Assert-Case 'G missing meta anchor fails' (Invoke-Gate $fxNoMeta) 1 `
        @('no .export const meta. declaration') @('green —')) -and $ok

# H a root with no .claude/workflows/ at all: still a failure, not a skip. The gate is only ever
# invoked on this repo, so an absent corpus means the path moved and nothing is being checked.
$fxNoDir = Join-Path $fxBase 'nodir'
New-Item -ItemType Directory -Force $fxNoDir | Out-Null
$ok = (Assert-Case 'H missing corpus dir fails' (Invoke-Gate $fxNoDir) 1 `
        @('\.claude/workflows/ not found') @('green —', 'ok — parsed')) -and $ok

# I a nested workflow is discovered too — the glob is recursive, so a file parked one level down
# cannot sit outside the gate while the summary still counts green.
$fxNested = New-Fixture 'nested' @{ 'good.js' = $legal; 'good.selftest.mjs' = $passSelftest }
New-Item -ItemType Directory -Force (Join-Path $fxNested '.claude/workflows/sub') | Out-Null
[IO.File]::WriteAllText((Join-Path $fxNested '.claude/workflows/sub/deep.js'), $broken)
$ok = (Assert-Case 'I nested file is gated' (Invoke-Gate $fxNested) 1 `
        @('FAIL — \.claude/workflows/sub/deep\.js: SyntaxError') @('green —')) -and $ok

# M1-M3 node-dependency branches, called directly so all three are exercised without a child
# process: absent+CI must FAIL (the gate silently stopped running), absent+local must SKIP with a
# reason, present must run.
foreach ($m in @(
        @{ Name = 'M1 node absent on CI fails'; Present = $false; Ci = $true; Verdict = 'fail' },
        @{ Name = 'M2 node absent locally skips'; Present = $false; Ci = $false; Verdict = 'skip' },
        @{ Name = 'M3 node present runs'; Present = $true; Ci = $true; Verdict = 'run' })) {
    $v = Resolve-NodeVerdict $m.Present $m.Ci
    if ($v.Verdict -ne $m.Verdict) {
        Write-Host "FAIL [$($m.Name)]: verdict '$($v.Verdict)' (expected '$($m.Verdict)')" -ForegroundColor Red
        $ok = $false
    }
    elseif ($v.Verdict -ne 'run' -and -not $v.Message) {
        Write-Host "FAIL [$($m.Name)]: non-run verdict with no reason — a silent skip is the thing being prevented" -ForegroundColor Red
        $ok = $false
    }
    else { Write-Host "PASS [$($m.Name)]" -ForegroundColor Green }
}

# META — the ADR #116 guard must fire through this file's wrapper, and on the guard reason alone.
# Since ADR 0125 the guard is shared, so this proves the WIRING, not the guard.
$accepted = Assert-Case 'META probe' @{ Code = 0; Out = 'meta probe' } 0 @('meta probe') @() 6>$null
if ($accepted -or $script:LastFails.Count -ne 1 -or ($script:LastFails[0] -notmatch 'no MustNotMatch')) {
    Write-Host "FAIL [META]: guard did not fire — accepted=$accepted reason='$($script:LastFails -join '; ')'" -ForegroundColor Red
    $ok = $false
}
else { Write-Host 'PASS [META]: negative-less case rejected, on the guard reason alone' -ForegroundColor Green }
# The OTHER arm: since ADR 0125 the -NoNegative forwarding is this wrapper's job, and no real
# case here passes a reason, so without this the parameter is write-only and a dropped
# passthrough stays invisible until someone needs the escape hatch.
if (Assert-Case 'META exemption honored' @{ Code = 0; Out = 'meta probe' } 0 @('meta probe') @() 'META: proves this wrapper forwards -NoNegative to the shared core (ADR 0125)') {
    Write-Host 'PASS [META]: -NoNegative exemption honored' -ForegroundColor Green
}
else { Write-Host 'FAIL [META]: -NoNegative exemption rejected' -ForegroundColor Red; $ok = $false }

Remove-FixtureRoot $fxBase
if (-not $ok) { exit 1 }
Write-Host 'workflow-gates selftest: all cases green' -ForegroundColor Green
exit 0
