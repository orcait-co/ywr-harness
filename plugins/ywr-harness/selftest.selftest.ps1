# Self-test for selftest.ps1 — the runner's own contract (spec 0008 §3.1): discovery, the
# -Shard partition (ADR 0071) and the two loud refusals (empty discovery, empty slice).
#
# Everything here drives the runner with -List, which prints discovery + selection and runs
# NOTHING — so this suite costs ~20 child spawns of a few hundred ms, never a second full run
# (the runner is what discovers and runs this file; a positive end-to-end case would recurse
# into the whole suite set). The partition property is asserted on the same observable CI uses:
# the union of shards 1..N over -List must equal the unsharded list, pairwise disjoint, every
# shard non-empty, sizes within one of each other (round-robin). If that ever fails, a CI matrix
# would be green while a suite ran on no shard — the silent-coverage-loss class this file exists
# to keep loud.
#
# Usage: pwsh plugins/ywr-harness/selftest.selftest.ps1  (exit 0 = all green). ~15 s.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/selftest-lib.ps1')   # assertion core, ADR 0125
$runner = Join-Path $PSScriptRoot 'selftest.ps1'
$fxBase = New-FixtureRoot 'selftest-runner-selftest'
trap { Remove-FixtureRoot $fxBase; break }   # exception-safe teardown, ADR 0126

# NOT `$Args`: that name is PowerShell's automatic unbound-arguments variable, and `@Args` splats
# the (empty) automatic one rather than the parameter — the child then runs the runner with NO
# arguments, i.e. the whole suite set, and this file appears to hang (found on its first run).
function Invoke-Runner([string]$Path, [string[]]$Arguments) {
    $out = & pwsh -NoProfile -ExecutionPolicy Bypass -File $Path @Arguments 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}
# The listing lines are the `  - <plugin-relative path>` form; everything else in the output has
# no leading spaces, so the prefix is the whole parse.
function Get-Listed($R) {
    return @(($R.Out -split "`r?`n") | Where-Object { $_ -match '^  - (.+)$' } | ForEach-Object { $Matches[1] })
}

function Assert-Case([string]$Name, $R, [int]$ExpectExit, [string[]]$MustMatch, [string[]]$MustNotMatch, [string]$NoNegative = '') {
    $pre = @()
    if ($R.Code -ne $ExpectExit) { $pre += "exit $($R.Code) (expected $ExpectExit)" }
    $script:LastFails = Get-AssertionFailure -Text $R.Out -MustMatch $MustMatch -MustNotMatch $MustNotMatch `
        -NoNegative $NoNegative -PreFail $pre
    return (Write-CaseVerdict -Name $Name -Fail $script:LastFails -Detail $R.Out)
}

$ok = $true

# --- A. unsharded listing: the baseline every partition case compares against ----------------
$base = Invoke-Runner $runner @('-List')
$baseList = Get-Listed $base
$ok = (Assert-Case 'A -List: discovery listed, nothing ran' $base 0 `
    @('suites: discovered=\d+', '  - selftest\.selftest\.ps1', '  - manifest-gate\.selftest\.ps1', 'LIST ONLY') `
    @('--- manifest-gate\.ps1', 'all gates green', 'shard=')) -and $ok
$ok = (Assert-True 'A2 listed count equals the discovered count' ($base.Out -match "discovered=$($baseList.Count)\b" -and $baseList.Count -ge 2) `
    "listed=$($baseList.Count) out=$($base.Out)") -and $ok
# Ordinal order by plugin-relative path with `/` separators — what makes the deal identical on
# Windows and Linux. A culture sort would place `-`/`_`/`.` differently per OS.
$sortedCopy = [string[]]$baseList.Clone(); [Array]::Sort($sortedCopy, [System.StringComparer]::Ordinal)
# -CaseSensitive: Compare-Object's default string comparer is case-insensitive, which would let a
# sort that differs from ordinal only by letter case pass this guard (review 2026-09-02, low).
$ok = (Assert-True 'A3 listing is in ordinal order, `/`-separated' (((Compare-Object $baseList $sortedCopy -SyncWindow 0 -CaseSensitive).Count -eq 0) -and -not ($baseList -match '\\')) `
    ($baseList -join "`n")) -and $ok

# --- B. partition: union == baseline, disjoint, non-empty, balanced — for several N ----------
foreach ($n in 1, 3, 4) {
    $union = @(); $sizes = @(); $shardOk = $true; $detail = ''
    for ($i = 1; $i -le $n; $i++) {
        $r = Invoke-Runner $runner @('-List', '-Shard', "$i/$n")
        $l = Get-Listed $r
        if ($r.Code -ne 0) { $shardOk = $false; $detail += "shard $i/$n exit $($r.Code)`n$($r.Out)" }
        if ($l.Count -eq 0) { $shardOk = $false; $detail += "shard $i/$n listed nothing`n" }
        if ($r.Out -notmatch "shard=$i/$n selected=$($l.Count)\b") { $shardOk = $false; $detail += "shard $i/$n header/selected mismatch: $($r.Out)`n" }
        $union += $l; $sizes += $l.Count
    }
    $dupes = @($union | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
    $missing = @($baseList | Where-Object { $union -notcontains $_ })
    $extra = @($union | Where-Object { $baseList -notcontains $_ })
    $spread = ($sizes | Measure-Object -Maximum -Minimum)
    $ok = (Assert-True "B N=$n shards partition the discovery (union == baseline, disjoint, non-empty)" `
        ($shardOk -and $dupes.Count -eq 0 -and $missing.Count -eq 0 -and $extra.Count -eq 0) `
        "dupes=[$($dupes -join ', ')] missing=[$($missing -join ', ')] extra=[$($extra -join ', ')]`n$detail") -and $ok
    $ok = (Assert-True "B N=$n round-robin: shard sizes within one of each other" (($spread.Maximum - $spread.Minimum) -le 1) `
        "sizes=$($sizes -join ',')") -and $ok
}

# --- C. determinism: the same shard lists the same suites twice -----------------------------
$c1 = Invoke-Runner $runner @('-List', '-Shard', '2/4'); $c2 = Invoke-Runner $runner @('-List', '-Shard', '2/4')
$ok = (Assert-True 'C shard 2/4 is deterministic across runs' (((Get-Listed $c1) -join '|') -eq ((Get-Listed $c2) -join '|')) `
    "$($c1.Out)`n---`n$($c2.Out)") -and $ok
$ok = (Assert-Case 'C2 shard 1/1 equals the unsharded list' (Invoke-Runner $runner @('-List', '-Shard', '1/1')) 0 `
    @("shard=1/1 selected=$($baseList.Count)\b") @('selected=0\b')) -and $ok
$ok = (Assert-True 'C3 shard 1/1 lists exactly the baseline' (((Get-Listed (Invoke-Runner $runner @('-List', '-Shard', '1/1'))) -join '|') -eq ($baseList -join '|')) `
    ($baseList -join "`n")) -and $ok

# --- D. malformed -Shard: exit 1 before anything is listed or run -----------------------------
# The 20-digit form pins the TryParse path: a cast would throw a raw overflow instead of the refusal.
foreach ($bad in '0/4', '5/4', 'a/b', '1/0', '01/4', '1/4/2', '4', '99999999999999999999/2') {
    $ok = (Assert-Case "D malformed -Shard '$bad' refused" (Invoke-Runner $runner @('-List', '-Shard', $bad)) 1 `
        @('FAIL — -Shard must be i/N', [regex]::Escape("got '$bad'")) @('suites: discovered', '  - ', 'LIST ONLY')) -and $ok
}

# --- E. empty slice: N beyond the discovery is a misconfiguration, not a pass ----------------
$n = $baseList.Count + 1
$ok = (Assert-Case "E shard $n/$n selects nothing → exit 1" (Invoke-Runner $runner @('-List', '-Shard', "$n/$n")) 1 `
    @('selects 0 of \d+ suites', 'an empty slice is not a pass', 'selected=0\b') @('LIST ONLY', '  - ')) -and $ok

# --- F. empty discovery: a copy of the runner in a tree with no suites is exit 1 -------------
# -List is the fast path here too: the refusal comes BEFORE the gates, so the fixture needs no
# manifest-gate.ps1 — and if the order ever regressed (gates first), this case would print the
# missing-gate FAIL instead of the discovery one and fail on MustNotMatch.
# The tree is NOT bare: it carries one suite under templates/, which is scaffold payload and must
# be excluded (declared in the refusal's count) — so this case also proves the exclusion, and that
# an excluded file never rescues the empty set.
$fxEmpty = Join-Path $fxBase 'empty'
New-Item -ItemType Directory -Force (Join-Path $fxEmpty 'templates/scripts') | Out-Null
Copy-Item -LiteralPath $runner -Destination (Join-Path $fxEmpty 'selftest.ps1')
[IO.File]::WriteAllText((Join-Path $fxEmpty 'templates/scripts/payload.selftest.ps1'), "exit 0`n")
$ok = (Assert-Case 'F zero discovered → exit 1 even under -List; a templates/ suite is excluded, counted, and rescues nothing' (Invoke-Runner (Join-Path $fxEmpty 'selftest.ps1') @('-List')) 1 `
    @('FAIL — no \*\.selftest\.ps1 discovered', 'empty set is not a pass', 'template payload excluded: 1') @('LIST ONLY', 'manifest-gate\.ps1 missing', 'suites: discovered', 'payload\.selftest\.ps1')) -and $ok
# The live tree's count is 0 and says so — the exclusion is declared on every run, not only when it bites.
$ok = (Assert-Case 'F2 the live listing declares template-excluded=0' $base 0 @('template-excluded=0\b') @('template-excluded=[1-9]')) -and $ok

# META — the ADR #116 guard must fire through this file's wrapper, and on the guard reason alone.
# Since ADR 0125 the guard is shared, so this proves the WIRING, not the guard.
$accepted = Assert-Case 'META probe' @{ Code = 0; Out = 'meta probe' } 0 @('meta probe') @() 6>$null
if ($accepted -or $script:LastFails.Count -ne 1 -or ($script:LastFails[0] -notmatch 'no MustNotMatch')) {
    Write-Host "FAIL [META]: guard did not fire — accepted=$accepted reason='$($script:LastFails -join '; ')'" -ForegroundColor Red
    $ok = $false
}
else { Write-Host 'PASS [META]: negative-less case rejected, on the guard reason alone' -ForegroundColor Green }
if (Assert-Case 'META exemption honored' @{ Code = 0; Out = 'meta probe' } 0 @('meta probe') @() 'META: proves this wrapper forwards -NoNegative to the shared core (ADR 0125)') {
    Write-Host 'PASS [META]: -NoNegative exemption honored' -ForegroundColor Green
}
else { Write-Host 'FAIL [META]: -NoNegative exemption rejected' -ForegroundColor Red; $ok = $false }

Remove-FixtureRoot $fxBase
if (-not $ok) { exit 1 }
Write-Host 'selftest runner selftest: all cases green' -ForegroundColor Green
exit 0
