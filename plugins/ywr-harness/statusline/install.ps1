# Install the harness statusline into the USER scope, so it applies to every Claude Code session
# on this machine rather than one repo.
#
# Why an installer instead of a plugin component: a plugin cannot contribute the main status line.
# A plugin's `settings.json` supports only `agent` and `subagentStatusLine` (plugins-reference,
# "File locations reference"). The status line is a user-scope setting, so a user-scope writer is
# the only mechanism that exists. ADR 0016 records the decision and the rejected alternatives.
#
# Two effects, and the second is deliberately conservative — it edits a file this script does not
# own, following the same rule ADR 0015 set for `core.hooksPath`:
#
#   1. SCRIPT — `harness-statusline.js` is copied to <user>/.claude/. TOOLCHAIN: overwritten every
#      run, which is how a canon fix reaches this machine.
#   2. WIRING — `statusLine` in <user>/.claude/settings.json:
#        absent                        -> written
#        already pointing at this file -> left alone
#        anything else                 -> REFUSED, existing value reported, nothing changed
#
# Every other key in settings.json is preserved. Exit 0 = installed (with or without a refusal).
# Exit 1 = the script could not be placed, or settings.json exists and does not parse.

[CmdletBinding()]
param(
    # Override the target .claude directory. Defaults to the user scope.
    [string]$ClaudeDir = (Join-Path $HOME '.claude'),
    # Report what would change and write nothing.
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# pwsh 7.4+ makes a non-zero native exit code terminating under 'Stop'; nothing here depends on
# that behaviour and the branches below read exit codes themselves.
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$SCRIPT_NAME = 'harness-statusline.js'
$src = Join-Path $PSScriptRoot $SCRIPT_NAME
if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
    Write-Host "FAIL — canon not found next to install.ps1 (looked for $src)" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $ClaudeDir -PathType Container)) {
    if ($DryRun) {
        Write-Host "would create $ClaudeDir"
    } else {
        New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null
    }
}
$dst = Join-Path $ClaudeDir $SCRIPT_NAME

Write-Host "harness statusline -> $ClaudeDir$(if ($DryRun) { ' (dry run — nothing written)' })"

# --- 1. the script -------------------------------------------------------------------------------
$scriptState = 'unchanged'
$exists = Test-Path -LiteralPath $dst -PathType Leaf
if ($exists) {
    $a = [IO.File]::ReadAllBytes($src); $b = [IO.File]::ReadAllBytes($dst)
    if ($a.Length -ne $b.Length -or (Compare-Object $a $b)) { $scriptState = 'refreshed' }
} else {
    $scriptState = 'created'
}
if ($scriptState -ne 'unchanged' -and -not $DryRun) {
    try { Copy-Item -LiteralPath $src -Destination $dst -Force }
    catch { Write-Host "  FAIL $SCRIPT_NAME — $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
}
$scriptColor = if ($scriptState -eq 'unchanged') { 'Gray' } else { 'Green' }
Write-Host "  script: $SCRIPT_NAME $scriptState" -ForegroundColor $scriptColor

# --- 2. the wiring -------------------------------------------------------------------------------
# node is what runs the line. Absent node is REPORTED, not silent: the setting would be written and
# the status line would simply never render, which looks identical to "the plugin did nothing".
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '  note: node is not on PATH — the status line will not render until it is' -ForegroundColor Yellow
}

$settingsPath = Join-Path $ClaudeDir 'settings.json'
$wanted = "node `"$dst`""

$settings = $null
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    $rawText = Get-Content -LiteralPath $settingsPath -Raw
    if ([string]::IsNullOrWhiteSpace($rawText)) {
        $settings = [ordered]@{}
    } else {
        try {
            # -AsHashtable keeps an ordered map so unknown keys survive the round trip untouched.
            $settings = $rawText | ConvertFrom-Json -AsHashtable
        } catch {
            # Refusing here is the point: rewriting a file we could not parse would destroy settings.
            Write-Host "  FAIL settings.json does not parse — refusing to rewrite it: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "  Add this yourself:  `"statusLine`": { `"type`": `"command`", `"command`": `"$($wanted -replace '\\','\\')`" }" -ForegroundColor Yellow
            exit 1
        }
    }
} else {
    $settings = @{}
}

$current = $null
if ($settings.ContainsKey('statusLine')) { $current = $settings['statusLine'] }
$currentCmd = if ($current -is [hashtable] -or $current -is [System.Collections.IDictionary]) { [string]$current['command'] } else { '' }

if (-not $current) {
    if ($DryRun) {
        Write-Host "  wiring: statusLine absent — would set it" -ForegroundColor Yellow
    } else {
        $settings['statusLine'] = [ordered]@{ type = 'command'; command = $wanted }
        $json = $settings | ConvertTo-Json -Depth 20
        Set-Content -LiteralPath $settingsPath -Value $json -Encoding utf8
        Write-Host "  wiring: statusLine set — wired" -ForegroundColor Green
    }
} elseif ($currentCmd -eq $wanted) {
    Write-Host '  wiring: statusLine already points here — already wired' -ForegroundColor Green
} else {
    # Same rule as ADR 0015's hooksPath: a value this script did not write is a decision it cannot
    # see the reasons for.
    Write-Host "  wiring: statusLine is already set to something else — REFUSED to change it" -ForegroundColor Yellow
    Write-Host "          existing: $currentCmd" -ForegroundColor Yellow
    Write-Host "          wanted:   $wanted" -ForegroundColor Yellow
    Write-Host '          Edit settings.json yourself if you meant to switch.' -ForegroundColor Yellow
}

exit 0
