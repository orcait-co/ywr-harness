# Selftest for install.ps1 — it writes into the USER's global settings.json, which is the most
# valuable file this plugin touches anywhere. Every branch is enumerated, and the two that matter
# most are the ones a happy-path check never reaches: an unrelated key must survive the rewrite,
# and an existing statusLine belonging to someone else must not be clobbered.
#
# -ClaudeDir points every case at a fixture, so the real ~/.claude is never involved.

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core, ADR 0125

$install = Join-Path $PSScriptRoot 'install.ps1'
$fxBase = New-FixtureRoot 'statusline-install-selftest'
trap { Remove-FixtureRoot $fxBase; break }
$ok = $true

function Invoke-Install([string]$Dir, [string[]]$Extra) {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $install, '-ClaudeDir', $Dir) + $Extra
    $out = & pwsh @a 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}
function New-Dir([string]$Name) {
    $p = Join-Path $fxBase $Name
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    return $p
}
function Get-Settings([string]$Dir) {
    $p = Join-Path $Dir 'settings.json'
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $null }
    return Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
}

# --- A: empty dir — script placed, statusLine written -------------------------------------------
$a = New-Dir 'fresh'
$rA = Invoke-Install $a @()
$sA = Get-Settings $a
$ok = (Assert-True 'A exits 0' ($rA.Code -eq 0) "exit=$($rA.Code) out=$($rA.Out)") -and $ok
$ok = (Assert-True 'A script is placed' (Test-Path -LiteralPath (Join-Path $a 'harness-statusline.js') -PathType Leaf) 'script missing') -and $ok
$ok = (Assert-True 'A placement is reported as created' ($rA.Out -match 'harness-statusline\.js created') $rA.Out) -and $ok
$ok = (Assert-True 'A statusLine is wired' ($sA.statusLine.command -match 'harness-statusline\.js') "got: $($sA.statusLine.command)") -and $ok
$ok = (Assert-True 'A wiring uses command type' ($sA.statusLine.type -eq 'command') "type=$($sA.statusLine.type)") -and $ok
$ok = (Assert-True 'A wiring is reported' ($rA.Out -match 'wired') $rA.Out) -and $ok

# --- B: re-run is idempotent --------------------------------------------------------------------
$rB = Invoke-Install $a @()
$ok = (Assert-True 'B re-run reports the script unchanged' ($rB.Out -match 'harness-statusline\.js unchanged') $rB.Out) -and $ok
$ok = (Assert-True 'B re-run reports already wired' ($rB.Out -match 'already wired') $rB.Out) -and $ok

# --- C: an edited installed copy is refreshed from canon (TOOLCHAIN) ----------------------------
Set-Content -LiteralPath (Join-Path $a 'harness-statusline.js') -Value '// hacked' -NoNewline
$rC = Invoke-Install $a @()
$canon = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'harness-statusline.js'))
$placed = [IO.File]::ReadAllBytes((Join-Path $a 'harness-statusline.js'))
$ok = (Assert-True 'C an edited copy is refreshed' ($rC.Out -match 'harness-statusline\.js refreshed') $rC.Out) -and $ok
$ok = (Assert-True 'C the refreshed copy is byte-identical to canon' (($canon.Length -eq $placed.Length) -and -not (Compare-Object $canon $placed)) 'copy still differs') -and $ok

# --- D: UNRELATED SETTINGS SURVIVE ---------------------------------------------------------------
# The case that justifies parsing rather than templating the file. A rewrite that dropped a
# permission block or an env var would be silent and expensive.
$d = New-Dir 'has-settings'
$existing = @'
{
  "env": { "PYTHONUTF8": "1" },
  "permissions": { "allow": ["Bash(git *)"], "defaultMode": "auto" },
  "effortLevel": "xhigh",
  "autoCompactEnabled": false
}
'@
Set-Content -LiteralPath (Join-Path $d 'settings.json') -Value $existing -NoNewline
$rD = Invoke-Install $d @()
$sD = Get-Settings $d
$ok = (Assert-True 'D exits 0' ($rD.Code -eq 0) "exit=$($rD.Code)") -and $ok
$ok = (Assert-True 'D env survives' ($sD.env.PYTHONUTF8 -eq '1') 'env lost') -and $ok
$ok = (Assert-True 'D permissions survive' ($sD.permissions.allow -contains 'Bash(git *)') 'permissions lost') -and $ok
$ok = (Assert-True 'D defaultMode survives' ($sD.permissions.defaultMode -eq 'auto') 'defaultMode lost') -and $ok
$ok = (Assert-True 'D effortLevel survives' ($sD.effortLevel -eq 'xhigh') 'effortLevel lost') -and $ok
$ok = (Assert-True 'D a false boolean survives as false' ($sD.autoCompactEnabled -eq $false) "autoCompactEnabled=$($sD.autoCompactEnabled)") -and $ok
$ok = (Assert-True 'D statusLine was added' ($sD.statusLine.command -match 'harness-statusline\.js') 'statusLine missing') -and $ok

# --- E: a FOREIGN statusLine is refused, not overwritten ----------------------------------------
$e = New-Dir 'foreign'
Set-Content -LiteralPath (Join-Path $e 'settings.json') -Value '{ "statusLine": { "type": "command", "command": "node /my/own/line.js" } }' -NoNewline
$rE = Invoke-Install $e @()
$sE = Get-Settings $e
$ok = (Assert-True 'E foreign statusLine survives byte-identical' ($sE.statusLine.command -eq 'node /my/own/line.js') "got: $($sE.statusLine.command)") -and $ok
$ok = (Assert-True 'E refusal is reported' ($rE.Out -match 'REFUSED') $rE.Out) -and $ok
$ok = (Assert-True 'E the existing value is named' ($rE.Out -match '/my/own/line\.js') $rE.Out) -and $ok
$ok = (Assert-True 'E run still exits 0' ($rE.Code -eq 0) "exit=$($rE.Code)") -and $ok
$ok = (Assert-True 'E the script is still installed despite the refusal' (Test-Path -LiteralPath (Join-Path $e 'harness-statusline.js') -PathType Leaf) 'script missing') -and $ok

# --- F: unparseable settings.json — refuse and say so, never rewrite ----------------------------
$f = New-Dir 'broken-json'
$garbage = '{ this is not json'
Set-Content -LiteralPath (Join-Path $f 'settings.json') -Value $garbage -NoNewline
$rF = Invoke-Install $f @()
$ok = (Assert-True 'F unparseable settings exits 1' ($rF.Code -eq 1) "exit=$($rF.Code) out=$($rF.Out)") -and $ok
$ok = (Assert-True 'F the file is left exactly as it was' ((Get-Content -LiteralPath (Join-Path $f 'settings.json') -Raw) -eq $garbage) 'settings.json was modified') -and $ok
$ok = (Assert-True 'F the manual fix is printed' ($rF.Out -match 'statusLine') $rF.Out) -and $ok

# --- G: dry run writes nothing -------------------------------------------------------------------
$g = New-Dir 'dry'
$rG = Invoke-Install $g @('-DryRun')
$ok = (Assert-True 'G dry run exits 0' ($rG.Code -eq 0) "exit=$($rG.Code)") -and $ok
$ok = (Assert-True 'G dry run says so' ($rG.Out -match 'dry run') $rG.Out) -and $ok
$ok = (Assert-True 'G dry run wrote no script' (-not (Test-Path -LiteralPath (Join-Path $g 'harness-statusline.js'))) 'script was written') -and $ok
$ok = (Assert-True 'G dry run wrote no settings' (-not (Test-Path -LiteralPath (Join-Path $g 'settings.json'))) 'settings.json was written') -and $ok

# --- H: the DEFAULT target follows CLAUDE_CONFIG_DIR (ADR 0046) ----------------------------------
# No -ClaudeDir. The env var is the scope a multi-account session runs under; a default that
# ignored it installed into a directory that session never reads — silently. The real ~/.claude
# stays uninvolved: the env var points every no-flag run at a fixture.
$h = New-Dir 'config-dir-default'
$i = New-Dir 'explicit-beats-env'
$prevCfg = $env:CLAUDE_CONFIG_DIR
try {
    $env:CLAUDE_CONFIG_DIR = $h
    $outH = & pwsh -NoProfile -ExecutionPolicy Bypass -File $install 2>&1 | Out-String
    $codeH = $LASTEXITCODE
    # An explicit -ClaudeDir still wins over the env var — every fixture-pointed case in this
    # suite depends on exactly that precedence.
    $rI = Invoke-Install $i @()
} finally {
    if ($null -ne $prevCfg) { $env:CLAUDE_CONFIG_DIR = $prevCfg }
    else { Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
}
$sH = Get-Settings $h
$ok = (Assert-True 'H no-flag run exits 0' ($codeH -eq 0) "exit=$codeH out=$outH") -and $ok
$ok = (Assert-True 'H no-flag run lands in CLAUDE_CONFIG_DIR' (Test-Path -LiteralPath (Join-Path $h 'harness-statusline.js') -PathType Leaf) $outH) -and $ok
$ok = (Assert-True 'H no-flag wiring points into CLAUDE_CONFIG_DIR' ($sH.statusLine.command -like "*$h*") "got: $($sH.statusLine.command)") -and $ok
$ok = (Assert-True 'H explicit -ClaudeDir beats the env var' (Test-Path -LiteralPath (Join-Path $i 'harness-statusline.js') -PathType Leaf) $rI.Out) -and $ok
$ok = (Assert-True 'H explicit-dir wiring does not point at the env dir' ((Get-Settings $i).statusLine.command -notlike "*$h*") "got: $((Get-Settings $i).statusLine.command)") -and $ok

# --- I: a malformed CLAUDE_CONFIG_DIR is REFUSED, never resolved against the cwd -----------------
# (review 2026-08-11, medium) A relative or blank-but-set value — an unexpanded '$HOME/.claude',
# a stray './cfg' — would land the install wherever the script was run FROM, silently. Refusal is
# loud, names the value, and writes nothing; an explicit -ClaudeDir stays trusted verbatim.
$j = New-Dir 'explicit-under-bad-env'
$prevCfg2 = $env:CLAUDE_CONFIG_DIR
try {
    $env:CLAUDE_CONFIG_DIR = 'not-absolute\cfg'
    Push-Location $fxBase
    try {
        $outI2 = & pwsh -NoProfile -ExecutionPolicy Bypass -File $install 2>&1 | Out-String
        $codeI2 = $LASTEXITCODE
    } finally { Pop-Location }
    # Explicit dir under the same malformed env: must still install (trusted verbatim).
    $rJ = Invoke-Install $j @()
} finally {
    if ($null -ne $prevCfg2) { $env:CLAUDE_CONFIG_DIR = $prevCfg2 }
    else { Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
}
$ok = (Assert-True 'I a relative CLAUDE_CONFIG_DIR exits 1' ($codeI2 -eq 1) "exit=$codeI2 out=$outI2") -and $ok
$ok = (Assert-True 'I the refusal names the variable and the value' (($outI2 -match 'CLAUDE_CONFIG_DIR') -and ($outI2 -match 'not-absolute')) $outI2) -and $ok
$ok = (Assert-True 'I nothing was created at the cwd-relative path' (-not (Test-Path (Join-Path $fxBase 'not-absolute'))) 'cwd-relative dir was created') -and $ok
$ok = (Assert-True 'I an explicit -ClaudeDir still installs under the malformed env' (($rJ.Code -eq 0) -and (Test-Path -LiteralPath (Join-Path $j 'harness-statusline.js') -PathType Leaf)) "exit=$($rJ.Code) $($rJ.Out)") -and $ok

Remove-FixtureRoot $fxBase

if (-not $ok) { Write-Host 'statusline install selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'statusline install selftest: all cases green' -ForegroundColor Green
exit 0
