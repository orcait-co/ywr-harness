# Self-test for directory-added-guard.ps1 (ADR #120; harness-scope gate ADR #106).
# Usage: pwsh .claude/hooks/directory-added-guard.selftest.ps1
#
# Fixture provenance matters here: the payload shape asserted below is the zod schema
# read out of the shipped 2.1.220 binary (ADR #120). An invented shape is exactly how
# the sibling config-change-audit hook stayed green while being inert, so cases 1 and 2
# are ground truth, not guesses. Every case carries MustNotMatch as well as MustMatch —
# an assertion set with no negatives is the ADR #116 class this repo has hit three times
# (tracked in ADR #117 follow-ups).
#
# Cases 6-7 exist because the first draft asserted the OPPOSITE (ADR #120 review,
# medium): the `$rich` fixture wrote an EMPTY settings.json and the case demanded the
# banner claim both plugin keys anyway, freezing an existence-vs-selection overclaim as
# the expected answer. The fixture now carries exactly ONE of the two keys, so case 3
# proves the guard names what is there and stays silent about what is not.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core, ADR 0125
$hook = Join-Path $PSScriptRoot 'directory-added-guard.ps1'

function Invoke-Hook([string]$Stdin) {
    $o = ($Stdin | & pwsh -NoProfile -File $hook 2>&1 | Out-String)
    $script:HookExit = $LASTEXITCODE
    return $o
}
# The ADR #116 empty-MustNotMatch guard and the match loops live in the shared assertion
# core (ADR 0125); what is file-specific is the envelope. $script:LastFails stays here, in
# the caller's scope, because the META case inspects it.
function Assert-SystemMessage([string]$Name, [string]$Out, [string[]]$MustMatch, [string[]]$MustNotMatch, [string]$NoNegative = '') {
    $pre = @()
    if ($script:HookExit -ne 0) { $pre += "exit $script:HookExit (want 0 — fail-open contract; a non-zero exit sends output to the debug log)" }
    $msg = ''
    try { $msg = [string]((ConvertFrom-Json $Out.Trim()).systemMessage) } catch { $pre += 'stdout is not valid JSON' }
    if (-not $msg) { $pre += 'no systemMessage (the only field this event consumes)' }
    $script:LastFails = Get-AssertionFailure -Text $msg -MustMatch $MustMatch -MustNotMatch $MustNotMatch `
        -NoNegative $NoNegative -PreFail $pre -Label 'systemMessage'
    return (Write-CaseVerdict -Name $Name -Fail $script:LastFails -Detail $Out)
}
function Assert-EmptyStdout([string]$Name, [string]$Out) {
    $fails = @()
    if ($script:HookExit -ne 0) { $fails += "exit $script:HookExit (want 0 — fail-open contract)" }
    if ($Out.Trim()) { $fails += "expected empty stdout, got: $($Out.Trim())" }
    if ($fails) { Write-Host "FAIL [$Name]: $($fails -join ' · ')" -ForegroundColor Red; return $false }
    Write-Host "PASS [$Name]" -ForegroundColor Green
    return $true
}
function New-Payload([hashtable]$Fields) {
    $o = @{ hook_event_name = 'DirectoryAdded' } + $Fields
    return ($o | ConvertTo-Json -Compress)
}
function New-TempDir([string]$Tag) {
    $p = Join-Path ([IO.Path]::GetTempPath()) ("dag-$Tag-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $p -Force | Out-Null
    return $p
}

$ok = $true
$mdEnvSaved = $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
$dirs = @()
try {
    $bare = New-TempDir 'bare'; $dirs += $bare
    $rich = New-TempDir 'rich'; $dirs += $rich
    $plain = New-TempDir 'plain'; $dirs += $plain
    $broken = New-TempDir 'broken'; $dirs += $broken
    $localmd = New-TempDir 'localmd'; $dirs += $localmd

    foreach ($sub in @('.claude/skills', '.claude/agents')) { New-Item -ItemType Directory -Path (Join-Path $rich $sub) -Force | Out-Null }
    # exactly ONE of the two contributing keys, so the banner must name it and omit the other
    Set-Content -LiteralPath (Join-Path $rich '.claude/settings.json') -Value '{"extraKnownMarketplaces":{}}' -NoNewline
    Set-Content -LiteralPath (Join-Path $rich 'CLAUDE.md') -Value '# other project' -NoNewline
    # a settings file with NO contributing key — the common real-world shape
    New-Item -ItemType Directory -Path (Join-Path $plain '.claude') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $plain '.claude/settings.json') -Value '{"hooks":{},"permissions":{"allow":[]}}' -NoNewline
    New-Item -ItemType Directory -Path (Join-Path $broken '.claude') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $broken '.claude/settings.json') -Value '{ not json at all' -NoNewline
    Set-Content -LiteralPath (Join-Path $localmd 'CLAUDE.local.md') -Value '# local only' -NoNewline

    $bareRx = [regex]::Escape($bare)
    $richRx = [regex]::Escape($rich)

    # 1. /add-dir of a plain directory -> banner names the path + source and states BOTH
    #    consequences; nothing claimed about config it does not have
    $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = $null
    $out = Invoke-Hook (New-Payload @{ directory = $bare; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'slash_command bare dir' $out `
            @('\[hook:dir-added\]', $bareRx, 'source: slash_command', 'convention, not an enforcement',
            'gates none of it', 'CLAUDE_PROJECT_DIR', 'ruff-on-edit', 'append-only guard', 'secret scan', '/permissions') `
            @('SCHEMA DRIFT', 'Configuration loaded from it', 'Instruction files present', 'UNKNOWN')) -and $ok

    # 2. SDK control-request source is reported as itself, not folded into /add-dir
    $out = Invoke-Hook (New-Payload @{ directory = $bare; source = 'register_repo_root' })
    $ok = (Assert-SystemMessage 'register_repo_root source' $out `
            @('source: register_repo_root') @('slash_command', 'SCHEMA DRIFT')) -and $ok

    # 3. the config surfaces that DO load are named, and ONLY the settings key actually
    #    present is claimed (permissions reference 4-row table, read 2026-07-25)
    $out = Invoke-Hook (New-Payload @{ directory = $rich; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'config surfaces enumerated' $out `
            @($richRx, 'skills from \.claude/skills', 'subagent definitions from \.claude/agents',
            'extraKnownMarketplaces from its settings files', '#111/#112') `
            @('SCHEMA DRIFT', 'enabledPlugins', 'UNKNOWN')) -and $ok

    # 4. instruction files present, env var unset -> reported as NOT joining the prompt
    $out = Invoke-Hook (New-Payload @{ directory = $rich; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'CLAUDE.md present, env unset' $out `
            @('Instruction files present \(CLAUDE\.md\)', 'do not join the prompt') @('MERGE into')) -and $ok

    # 5. same directory, env var set -> the severity flips to a prompt merge
    $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
    $out = Invoke-Hook (New-Payload @{ directory = $rich; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'CLAUDE.md present, env set' $out `
            @('MERGE into this session') @('do not join the prompt')) -and $ok
    $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = $null

    # 6. EXISTENCE IS NOT SELECTION (review medium): a settings file carrying neither
    #    contributing key must produce NO configuration claim at all
    $out = Invoke-Hook (New-Payload @{ directory = $plain; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'settings file without the two keys claims nothing' $out `
            @('is now a working directory') `
            @('enabledPlugins', 'extraKnownMarketplaces', 'Configuration loaded from it', 'UNKNOWN')) -and $ok

    # 7. an unparseable settings file is UNKNOWN, never silently absent (REVIEW.md #4)
    $out = Invoke-Hook (New-Payload @{ directory = $broken; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'unparseable settings reports unknown' $out `
            @('UNKNOWN, not absent', 'settings\.json') `
            @('Configuration loaded from it', 'SCHEMA DRIFT')) -and $ok

    # 8. CLAUDE.local.md carries a SECOND precondition the other instruction files do
    #    not (review low) — env set: merges only while the local settings source is on
    $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
    $out = Invoke-Hook (New-Payload @{ directory = $localmd; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'CLAUDE.local.md extra precondition, env set' $out `
            @('CLAUDE\.local\.md is present', 'local` settings source', 'one condition more') `
            @('Instruction files present', 'SCHEMA DRIFT')) -and $ok
    $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = $null

    # 9. env unset -> the local-source caveat is irrelevant and must not be stated
    $out = Invoke-Hook (New-Payload @{ directory = $localmd; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'CLAUDE.local.md, env unset' $out `
            @('does not join the prompt either') @('local` settings source', 'one condition more')) -and $ok

    # 10. ANTI-VACUITY: the field this guard reads is renamed/absent -> it must SAY SO,
    #     not fall silent. This is the case the sibling hook lacked (it read an invented
    #     `config_source` and every real payload made it exit 0 quietly).
    $out = Invoke-Hook '{"hook_event_name":"DirectoryAdded","dir":"C:\\x","source":"slash_command"}'
    $ok = (Assert-SystemMessage 'schema drift is reported, not swallowed' $out `
            @('SCHEMA DRIFT', 'Keys received: dir, hook_event_name, source') `
            @('is now a working directory')) -and $ok

    # 11. directory present but source absent -> still warns, source marked absent.
    #     The path must be platform-neutral: this case shipped as a literal `C:\x`, which
    #     on Linux CI is a NON-EXISTENT DRIVE, and that is what reddened 48c264c.
    $out = Invoke-Hook (New-Payload @{ directory = (Join-Path ([IO.Path]::GetTempPath()) 'dag-no-such-dir') })
    $ok = (Assert-SystemMessage 'missing source still warns' $out `
            @('source: \(source absent\)', 'is now a working directory') @('SCHEMA DRIFT')) -and $ok

    # 11b. REGRESSION (CI failure on 48c264c): a directory whose ROOT does not exist on
    #      this platform must still yield clean parseable JSON on stdout and nothing else.
    #      Join-Path/Test-Path fail NON-TERMINATING there, so the guard's try/catch only
    #      catches it because the block promotes $ErrorActionPreference to Stop. The bogus
    #      root is chosen per platform so the case reproduces on both, which the original
    #      Windows-only run could not do.
    $bogusRoot = if ($IsWindows) {
        $used = @([IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name.Substring(0, 1).ToUpper() })
        $freeLetter = @((69..90 | ForEach-Object { [string][char]$_ }) | Where-Object { $used -notcontains $_ })[0]
        "${freeLetter}:\no-such-root\x"
    }
    else { 'C:\no-such-root\x' }
    $out = Invoke-Hook (New-Payload @{ directory = $bogusRoot; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'unresolvable root emits clean JSON only' $out `
            @('is now a working directory', 'gates none of it') `
            @('SCHEMA DRIFT', 'Cannot find drive', 'Configuration loaded from it', 'UNKNOWN')) -and $ok

    # 12. a path that no longer exists on disk -> banner, no crash, no invented config
    $out = Invoke-Hook (New-Payload @{ directory = (Join-Path $bare 'gone-subdir'); source = 'slash_command' })
    $ok = (Assert-SystemMessage 'vanished path does not crash' $out `
            @('is now a working directory') @('SCHEMA DRIFT', 'Configuration loaded from it', 'UNKNOWN')) -and $ok

    # 13. UTF-8 BOM prefixed stdin -> still parses (config-change-audit incident 07-23:
    #     TrimStart alone is not enough without InputEncoding set to UTF8 first)
    $out = Invoke-Hook ([char]0xFEFF + (New-Payload @{ directory = $bare; source = 'slash_command' }))
    $ok = (Assert-SystemMessage 'BOM-prefixed stdin' $out @($bareRx) @('SCHEMA DRIFT')) -and $ok

    # 14. wrong event name -> silent (defensive event guard, symmetric with siblings)
    $out = Invoke-Hook '{"hook_event_name":"CwdChanged","directory":"C:\\x","source":"slash_command"}'
    $ok = (Assert-EmptyStdout 'wrong event silent' $out) -and $ok

    # 15. garbage stdin -> silent exit 0 (infra failure is not a finding)
    $out = Invoke-Hook 'not json at all {{{'
    $ok = (Assert-EmptyStdout 'garbage fail-open' $out) -and $ok
}
finally {
    $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = $mdEnvSaved
    foreach ($d in $dirs) { if ($d -and (Test-Path -LiteralPath $d)) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue } }
}

# META — every case above already carried a negative (the file's header rule), so the ADR #116
# guard is PREVENTIVE here. This case is what keeps a preventive guard from being deleted with
# nothing turning red. Since ADR 0125 the guard lives in the shared assertion core, so what is
# proven here is this file's WIRING to it: a wrapper that dropped the -MustNotMatch passthrough
# would leave the core intact and every case in this file unguarded.
$script:HookExit = 0
$metaOut = '{"systemMessage":"meta probe"}'
$accepted = Assert-SystemMessage 'META probe' $metaOut @('meta probe') 6>$null
if ($accepted -or $script:LastFails.Count -ne 1 -or ($script:LastFails[0] -notmatch 'no MustNotMatch')) {
    Write-Host "FAIL [META]: guard did not fire — accepted=$accepted reason='$($script:LastFails -join '; ')'" -ForegroundColor Red
    $ok = $false
}
else { Write-Host 'PASS [META]: negative-less case rejected, on the guard reason alone' -ForegroundColor Green }
if (Assert-SystemMessage 'META exemption honored' $metaOut @('meta probe') @() 'META: exercises the visible-exemption path so the escape hatch cannot rot unnoticed') {
    Write-Host 'PASS [META]: -NoNegative exemption honored' -ForegroundColor Green
}
else { Write-Host 'FAIL [META]: -NoNegative exemption rejected' -ForegroundColor Red; $ok = $false }

if (-not $ok) { exit 1 }
Write-Host 'directory-added-guard selftest: all cases green' -ForegroundColor Green
exit 0
