# pwsh 7 required (ConvertFrom-Json -AsHashtable is PS 6+); under 5.1 the #Requires line turns
# a wrong-interpreter run into an explicit refusal instead of a mid-run parse error (issue #51).
#Requires -Version 7.0

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
    # Override the target .claude directory. When omitted, the default is the user scope THIS
    # SESSION runs under: CLAUDE_CONFIG_DIR when set, else ~/.claude (ADR 0046). A default that
    # ignored the env var installed into a directory a config-dir session never reads — silently,
    # which looks identical to "the plugin did nothing".
    [string]$ClaudeDir,
    # Report what would change and write nothing.
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# pwsh 7.4+ makes a non-zero native exit code terminating under 'Stop'; nothing here depends on
# that behaviour and the branches below read exit codes themselves.
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Resolve the default target (ADR 0046). An explicit -ClaudeDir is trusted verbatim; the env var
# is NOT — a relative or blank-but-set value (an unexpanded '$HOME/.claude', a stray './cfg')
# would resolve against whatever directory this script was run FROM, recreating exactly the
# silent wrong-dir install this default exists to prevent. A value this script cannot interpret
# is refused loudly, the same posture as the foreign-statusLine refusal below (review 2026-08-11).
if (-not $PSBoundParameters.ContainsKey('ClaudeDir')) {
    $rawCfg = [string]$env:CLAUDE_CONFIG_DIR
    if ($rawCfg) {
        $trimCfg = $rawCfg.Trim()
        if (-not $trimCfg -or -not [System.IO.Path]::IsPathRooted($trimCfg)) {
            Write-Host "FAIL — CLAUDE_CONFIG_DIR ('$rawCfg') is not an absolute path; refusing to resolve it against the current directory. Fix the variable or pass -ClaudeDir." -ForegroundColor Red
            exit 1
        }
        $ClaudeDir = $trimCfg
    } else {
        $ClaudeDir = Join-Path $HOME '.claude'
    }
}

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

# The block this script writes carries a 30s refresh timer alongside the command (ADR 0059):
# event-driven renders go quiet while a session idles on background agents, and the timer keeps
# the quota/git-state segments current. On a block that already points here, refreshInterval is
# ADD-IF-ABSENT only — a present value, whatever it is, is a member decision this script cannot
# see the reasons for (the ADR 0015 rule, same as the foreign-statusLine refusal below).
$REFRESH_SECONDS = 30
if (-not $current) {
    if ($DryRun) {
        Write-Host "  wiring: statusLine absent — would set it (refreshInterval ${REFRESH_SECONDS}s)" -ForegroundColor Yellow
    } else {
        $settings['statusLine'] = [ordered]@{ type = 'command'; command = $wanted; refreshInterval = $REFRESH_SECONDS }
        $json = $settings | ConvertTo-Json -Depth 20
        Set-Content -LiteralPath $settingsPath -Value $json -Encoding utf8
        Write-Host "  wiring: statusLine set — wired (refreshInterval ${REFRESH_SECONDS}s)" -ForegroundColor Green
    }
} elseif ($currentCmd -eq $wanted) {
    # $current is necessarily a dictionary here — $currentCmd is only non-empty for one.
    if (-not $current.Contains('refreshInterval')) {
        if ($DryRun) {
            Write-Host "  wiring: statusLine already points here — would add refreshInterval ${REFRESH_SECONDS}s" -ForegroundColor Yellow
        } else {
            $current['refreshInterval'] = $REFRESH_SECONDS
            $json = $settings | ConvertTo-Json -Depth 20
            Set-Content -LiteralPath $settingsPath -Value $json -Encoding utf8
            Write-Host "  wiring: statusLine already points here — refreshInterval ${REFRESH_SECONDS}s added" -ForegroundColor Green
        }
    } else {
        Write-Host '  wiring: statusLine already points here — already wired' -ForegroundColor Green
    }
} else {
    # Same rule as ADR 0015's hooksPath: a value this script did not write is a decision it cannot
    # see the reasons for.
    Write-Host "  wiring: statusLine is already set to something else — REFUSED to change it" -ForegroundColor Yellow
    Write-Host "          existing: $currentCmd" -ForegroundColor Yellow
    Write-Host "          wanted:   $wanted" -ForegroundColor Yellow
    Write-Host '          Edit settings.json yourself if you meant to switch.' -ForegroundColor Yellow
}

exit 0
