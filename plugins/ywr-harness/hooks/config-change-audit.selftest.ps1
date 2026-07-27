# Self-test for config-change-audit.ps1 (ADR #112, field-name fix ADR #120;
# harness-scope gate ADR #106).
# Self-contained, no fixtures needed. Usage: pwsh .claude/hooks/config-change-audit.selftest.ps1
#
# The fixtures below fed `config_source` from 2026-07-23 to 2026-07-25 and were green the
# whole time while the hook could not fire on a single real payload. Cases 1/2 now use the
# field the event actually carries (`source`), and case 7 pins the old name as a
# regression: any payload lacking `source` must produce a drift banner, never silence.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core, ADR 0125
$hook = Join-Path $PSScriptRoot 'config-change-audit.ps1'

function Invoke-Hook([string]$Stdin) {
    $o = ($Stdin | & pwsh -NoProfile -File $hook 2>&1 | Out-String)
    $script:HookExit = $LASTEXITCODE
    return $o
}
# The ADR #116 empty-MustNotMatch guard and the match loops live in the shared assertion
# core (ADR 0125); what is file-specific is the envelope. $script:LastFails stays here, in
# the caller's scope, because the META case inspects it.
function Assert-SystemMessage([string]$Name, [string]$Out, [string[]]$MustMatch, [string[]]$MustNotMatch, [string]$NoNegative = '') {
    # stdout is a JSON envelope (ConfigChange only honors `systemMessage`,
    # doc-verified 2026-07-23) — parse it and assert against the banner text.
    $pre = @()
    if ($script:HookExit -ne 0) { $pre += "exit $script:HookExit (want 0 — fail-open contract)" }
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

$ok = $true
# 1. real payload shape -> systemMessage names the changed tier (user-addressed banner)
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","source":"project_settings"}'
$ok = (Assert-SystemMessage 'audit systemMessage' $out `
        @('\[hook:config-audit\] project_settings modified', 'explicit user approval') `
        @('SCHEMA DRIFT')) -and $ok
# 2. optional file_path is surfaced when present (it names WHICH file, the tier does not)
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","source":"local_settings","file_path":"C:\\p\\.claude\\settings.local.json"}'
$ok = (Assert-SystemMessage 'file_path surfaced' $out `
        @('local_settings modified', 'settings\.local\.json') @('SCHEMA DRIFT')) -and $ok
# 3. garbage stdin -> silent exit 0 (unparseable = infra, not drift)
$out = Invoke-Hook 'not json at all {{{'
$ok = (Assert-EmptyStdout 'garbage fail-open' $out) -and $ok
# 4. wrong event name -> silent (defensive event guard, symmetric with siblings)
$out = Invoke-Hook '{"hook_event_name":"SessionStart","source":"project_settings"}'
$ok = (Assert-EmptyStdout 'wrong event silent' $out) -and $ok
# 5. UTF-8 BOM prefixed stdin -> still parses (reproduced+fixed 2026-07-23: a bare
#    TrimStart([char]0xFEFF) alone is not enough, the BOM bytes decode to garbage
#    under the console's default codepage unless InputEncoding is UTF8 first)
$out = Invoke-Hook ([char]0xFEFF + '{"hook_event_name":"ConfigChange","source":"project_settings"}')
$ok = (Assert-SystemMessage 'BOM-prefixed stdin' $out `
        @('\[hook:config-audit\] project_settings modified') @('SCHEMA DRIFT')) -and $ok
# 6. whitespace-only source -> drift, not a tier-less cosmetic banner and not silence
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","source":"  "}'
$ok = (Assert-SystemMessage 'whitespace source reports drift' $out `
        @('SCHEMA DRIFT', 'Keys received: hook_event_name, source') @('modified mid-session')) -and $ok
# 7. REGRESSION (ADR #120): the field name this hook shipped with. A payload carrying
#    `config_source` and no `source` is the exact production input that produced two days
#    of silence — it must now be reported, and the report must name the keys it did get.
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","config_source":"project_settings"}'
$ok = (Assert-SystemMessage 'old config_source name is reported as drift' $out `
        @('SCHEMA DRIFT', 'Keys received: config_source, hook_event_name') `
        @('project_settings modified')) -and $ok

# META — every case above already carried a negative, so the ADR #116 guard in
# Assert-SystemMessage is PREVENTIVE here rather than a fix. That is exactly why it needs this
# case: without it, a preventive guard can be deleted or broken with nothing turning red.
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
Write-Host 'config-change-audit selftest: all cases green' -ForegroundColor Green
exit 0
