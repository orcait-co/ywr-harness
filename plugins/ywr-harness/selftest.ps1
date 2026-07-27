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

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$failed = @()
$skipped = @()

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
# Recursive: a selftest sitting anywhere in the plugin is discovered, so adding a directory
# later cannot silently drop its coverage. `.mjs` selftests are driven by the corpus gate above,
# not here — pwsh would not run them.
$tests = @(Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -File -Filter '*.selftest.ps1' -ErrorAction SilentlyContinue | Sort-Object FullName)

if ($tests.Count -eq 0) {
    Write-Host 'FAIL — no *.selftest.ps1 discovered (empty set is not a pass)' -ForegroundColor Red
    $failed += 'discovery (empty)'
}

$testFails = 0
foreach ($t in $tests) {
    Write-Host "--- $($t.Name)" -ForegroundColor Cyan
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $t.FullName
    if ($LASTEXITCODE -ne 0) { $failed += $t.Name; $testFails++ }
}

Write-Host ''
Write-Host "selftests: discovered=$($tests.Count) passed=$($tests.Count - $testFails) failed=$testFails"
if ($skipped.Count) { Write-Host "skipped gates: $($skipped -join ', ')" -ForegroundColor Yellow }
if ($failed.Count) {
    Write-Host "FAIL — $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "ywr-harness plugin: all gates green$(if ($skipped.Count) { " ($($skipped.Count) skipped — see above)" })" -ForegroundColor Green
exit 0
