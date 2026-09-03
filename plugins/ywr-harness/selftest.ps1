# pwsh 7 required — the suites this runner spawns use PS7-only surfaces (Latin1, $IsWindows),
# and a 5.1 run would fail per-suite with unrelated-looking errors instead of one clear
# refusal (issue #51).
#Requires -Version 7.0

# Plugin selftest runner — the single entry point for everything this plugin can verify about
# itself: the manifest/wiring gate, the JS-side workflow corpus gate, then every shipped
# PowerShell selftest.
#
# Exit contract:
#   exit 0 = every gate that RAN passed, and at least one selftest was discovered
#   exit 1 = anything failed, OR nothing was discovered
#
# Zero discovered is a FAILURE, not a pass. A runner that reports green on an empty set is the
# ADR 0127 class: a gate judged from the wrong observable. Counts are always printed so a
# shrinking suite is visible rather than silent, and skips are printed as skips rather than
# folded into the pass count (ADR 0127 again — a SKIP counted as a pass was the original defect).
#
# No gate short-circuits: one run should surface every defect, not just the cheapest one.
#
# The child-output decoding pin (ADR 0128) is set here because this runner CAPTURES child
# output: without it a non-UTF-8 console codepage destroys non-ASCII in the captured text
# rather than merely garbling the display.
[CmdletBinding()]
param(
    # `i/N` (1-based): run only the i-th of N deterministic slices of the discovered suites — the
    # CI matrix lever (ADR 0071). Suites are sorted by plugin-relative path (ordinal, `/`
    # separators, so the deal is identical on Windows and Linux) and dealt round-robin, so the N
    # slices PARTITION the discovery by construction: no suite list lives in the CI yaml, and a
    # new suite lands in a slice without anyone naming it. The two gates ahead of the suites
    # (manifest, workflow corpus) run in EVERY slice — they cost seconds, and a slice that skipped
    # them would not be "every gate that ran passed". A slice that selects nothing is exit 1
    # (N larger than the discovery is a matrix misconfiguration, not a pass).
    [string]$Shard = '',
    # Print the discovery and the selection, run nothing, exit 0 — the observable the runner's own
    # selftest (selftest.selftest.ps1) asserts the partition on. The last line says LIST ONLY so
    # the output can never be read as a green run. Discovery and -Shard validation still apply:
    # an empty discovery or a malformed shard is exit 1 here too.
    [switch]$List
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$failed = @()
$skipped = @()

# --- shard argument (ADR 0071) ---------------------------------------------------------------
$shardIndex = 0
$shardCount = 0
if ($Shard) {
    # TryParse, not a cast: a digit run beyond Int32 would otherwise throw a raw .NET overflow
    # instead of this named refusal (review 2026-09-02, low).
    $m = [regex]::Match($Shard, '^([1-9][0-9]*)/([1-9][0-9]*)$')
    $i = 0; $n = 0
    $parsed = $m.Success -and [int]::TryParse($m.Groups[1].Value, [ref]$i) -and [int]::TryParse($m.Groups[2].Value, [ref]$n)
    if (-not $parsed -or $i -gt $n) {
        Write-Host "FAIL — -Shard must be i/N with 1 <= i <= N (got '$Shard')" -ForegroundColor Red
        exit 1
    }
    $shardIndex = $i
    $shardCount = $n
}

# --- discovery ------------------------------------------------------------------------------
# Recursive: a selftest sitting anywhere in the plugin is discovered, so adding a directory
# later cannot silently drop its coverage. `.mjs` selftests are driven by the corpus gate below,
# not here — pwsh would not run them.
# Discovery runs BEFORE the gates so the two loud refusals (empty set, empty slice) and -List
# cost no gate time; the gates still run before the suites in a real run.
# ONE declared exclusion, the same one manifest-gate's coverage report makes: files under a
# `templates/` directory are payload this plugin COPIES into a consuming repo, not code it runs —
# a selftest placed there belongs to the repo it lands in. Counted and printed, never silent.
$templateRx = '[\\/]templates[\\/]'
$found = @(Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -File -Filter '*.selftest.ps1' -ErrorAction SilentlyContinue)
$templateExcluded = @($found | Where-Object { $_.FullName -match $templateRx }).Count
# Ordinal-keyed on purpose: a plain @{} compares keys case-insensitively and would fold two paths
# that differ only by case into one entry on a case-sensitive filesystem (review 2026-09-02, medium).
$byRel = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
foreach ($f in $found) {
    if ($f.FullName -match $templateRx) { continue }
    $rel = $f.FullName.Substring($PSScriptRoot.Length).TrimStart('\', '/').Replace('\', '/')
    $byRel[$rel] = $f
}
$rels = [string[]]$byRel.Keys
[Array]::Sort($rels, [System.StringComparer]::Ordinal)
$all = @($rels | ForEach-Object { $byRel[$_] })

if ($all.Count -eq 0) {
    Write-Host "FAIL — no *.selftest.ps1 discovered (empty set is not a pass; template payload excluded: $templateExcluded)" -ForegroundColor Red
    exit 1
}

$tests = $all
if ($shardCount) {
    $tests = @(for ($k = 0; $k -lt $all.Count; $k++) { if ((($k % $shardCount) + 1) -eq $shardIndex) { $all[$k] } })
    Write-Host "suites: discovered=$($all.Count) shard=$shardIndex/$shardCount selected=$($tests.Count) template-excluded=$templateExcluded"
    if ($tests.Count -eq 0) {
        Write-Host "FAIL — shard $Shard selects 0 of $($all.Count) suites (N exceeds the discovery) — an empty slice is not a pass" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "suites: discovered=$($all.Count) template-excluded=$templateExcluded"
}
foreach ($t in $tests) { Write-Host "  - $($t.FullName.Substring($PSScriptRoot.Length).TrimStart('\', '/').Replace('\', '/'))" }

if ($List) {
    Write-Host 'LIST ONLY — nothing ran' -ForegroundColor Yellow
    exit 0
}

# --- manifest + wiring gate ----------------------------------------------------------------
$gate = Join-Path $PSScriptRoot 'manifest-gate.ps1'
if (Test-Path -LiteralPath $gate) {
    Write-Host '--- manifest-gate.ps1' -ForegroundColor Cyan
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $gate
    if ($LASTEXITCODE -ne 0) { $failed += 'manifest-gate.ps1' }
} else {
    Write-Host 'FAIL — manifest-gate.ps1 missing (the wiring gate is not optional)' -ForegroundColor Red
    $failed += 'manifest-gate.ps1 (missing)'
}

# --- workflow corpus gate (JS side) --------------------------------------------------------
# Two arms: every workflows/*.js compiles, and every workflows/*.selftest.mjs exits 0.
# `node --check` is not a substitute for the parse arm — a file carrying `export` is
# module-detected and NOT syntax-checked, so --check exits 0 on any content after it.
$wfGate = Join-Path $PSScriptRoot 'scripts/workflow-gates.mjs'
$wfDir = Join-Path $PSScriptRoot 'workflows'
if ((Test-Path -LiteralPath $wfGate) -and (Test-Path -LiteralPath $wfDir)) {
    if (Get-Command node -ErrorAction SilentlyContinue) {
        Write-Host '--- workflow-gates.mjs (corpus: workflows/)' -ForegroundColor Cyan
        & node $wfGate --root $PSScriptRoot --dir 'workflows'
        if ($LASTEXITCODE -ne 0) { $failed += 'workflow-gates.mjs' }
    } else {
        Write-Host 'SKIP — node not on PATH; workflow corpus gate NOT run (reported, not silent)' -ForegroundColor Yellow
        $skipped += 'workflow-gates.mjs (no node)'
    }
} elseif (Test-Path -LiteralPath $wfDir) {
    Write-Host 'FAIL — workflows/ exists but scripts/workflow-gates.mjs is missing: the corpus would be gated by nothing' -ForegroundColor Red
    $failed += 'workflow-gates.mjs (missing, corpus present)'
}

# --- shipped PowerShell selftests -----------------------------------------------------------
$testFails = 0
foreach ($t in $tests) {
    Write-Host "--- $($t.Name)" -ForegroundColor Cyan
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $t.FullName
    if ($LASTEXITCODE -ne 0) { $failed += $t.Name; $testFails++ }
}

Write-Host ''
$shardNote = if ($shardCount) { " shard=$shardIndex/$shardCount selected=$($tests.Count)" } else { '' }
Write-Host "selftests: discovered=$($all.Count)$shardNote passed=$($tests.Count - $testFails) failed=$testFails"
if ($skipped.Count) { Write-Host "skipped gates: $($skipped -join ', ')" -ForegroundColor Yellow }
if ($failed.Count) {
    Write-Host "FAIL — $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "ywr-harness plugin: all gates green$(if ($shardCount) { " (shard $shardIndex/$shardCount)" })$(if ($skipped.Count) { " ($($skipped.Count) skipped — see above)" })" -ForegroundColor Green
exit 0
