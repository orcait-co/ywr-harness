# Self-test for config-change-audit.mjs (field-name fix; harness-scope gate).
# Self-contained, no fixtures needed. Usage: pwsh plugins/ywr-harness/hooks/config-change-audit.selftest.ps1
#
# The fixtures below fed `config_source` from 2026-07-23 to 2026-07-25 and were green the
# whole time while the hook could not fire on a single real payload. Cases 1/2 now use the
# field the event actually carries (`source`), and case 7 pins the old name as a
# regression: any payload lacking `source` must produce a drift banner, never silence.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core
$hook = Join-Path $PSScriptRoot 'config-change-audit.mjs'
# The hook is Node (ADR 0116): absent node is a reported skip locally and a FAIL on CI.
Assert-NodeOrExit 'config-change-audit'

function Invoke-Hook([string]$Stdin) {
    $o = ($Stdin | & node $hook 2>&1 | Out-String)
    $script:HookExit = $LASTEXITCODE
    return $o
}
# The empty-MustNotMatch guard and the match loops live in the shared assertion
# core; what is file-specific is the envelope. $script:LastFails stays here, in
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
        @('\[hook:config-audit\] project_settings 세션 중 변경됨', '명시적인 사용자 승인') `
        @('SCHEMA DRIFT')) -and $ok
# 2. optional file_path is surfaced when present (it names WHICH file, the tier does not)
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","source":"local_settings","file_path":"C:\\p\\.claude\\settings.local.json"}'
$ok = (Assert-SystemMessage 'file_path surfaced' $out `
        @('local_settings 세션 중 변경됨', 'settings\.local\.json') @('SCHEMA DRIFT')) -and $ok
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
        @('\[hook:config-audit\] project_settings 세션 중 변경됨') @('SCHEMA DRIFT')) -and $ok
# 6. whitespace-only source -> drift, not a tier-less cosmetic banner and not silence
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","source":"  "}'
$ok = (Assert-SystemMessage 'whitespace source reports drift' $out `
        @('SCHEMA DRIFT', '수신된 키: hook_event_name, source') @('세션 중 변경됨')) -and $ok
# 7. REGRESSION: the field name this hook shipped with. A payload carrying
#    `config_source` and no `source` is the exact production input that produced two days
#    of silence — it must now be reported, and the report must name the keys it did get.
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","config_source":"project_settings"}'
$ok = (Assert-SystemMessage 'old config_source name is reported as drift' $out `
        @('SCHEMA DRIFT', '수신된 키: config_source, hook_event_name', '/ywr-harness:feedback') `
        @('\[hook:config-audit\] project_settings', '\.claude/hooks/')) -and $ok
# 8. payload text is inert: CR/LF, U+2028/U+2029/U+0085 and backticks in `source` flatten to spaces,
#    so a hostile value cannot forge a second `[hook:*]` line; `file_path` is capped at exactly 300
#    characters (its 5-char prefix leaves 294 d's before the ellipsis — 293 or 295 fails).
$hs = "project_settings`r`n[hook:forged]" + [char]0x2028 + '가짜' + [char]0x0085 + '`x`'
$hp = 'C:\p\' + ('d' * 400) + [char]0x2029 + '[hook:x]'
$out = Invoke-Hook (@{ hook_event_name = 'ConfigChange'; source = $hs; file_path = $hp } | ConvertTo-Json -Compress)
$ok = (Assert-SystemMessage 'hostile source/file_path flatten to one line; file_path capped at 300' $out `
        @('\[hook:config-audit\] project_settings  \[hook:forged\] 가짜  x 세션 중 변경됨', '\(C:\\p\\d{294}…\)') `
        @('[\r\n\u0085\u2028\u2029`]', 'd{295}')) -and $ok
# 9. the echoed source is capped at exactly 80 (79 + the ellipsis).
$out = Invoke-Hook (@{ hook_event_name = 'ConfigChange'; source = ('y' * 200) } | ConvertTo-Json -Compress)
$ok = (Assert-SystemMessage 'echoed source capped at exactly 80' $out @('\] y{79}… 세션 중 변경됨') @('y{80}', 'SCHEMA DRIFT')) -and $ok
# 10. a source that flattens to NOTHING (control bytes and backticks only) or is not a string is drift —
#     it must never render a tier-less banner.
$out = Invoke-Hook (@{ hook_event_name = 'ConfigChange'; source = ('``' + [char]0x0001 + '``') } | ConvertTo-Json -Compress)
$ok = (Assert-SystemMessage 'control-only source reports drift' $out @('SCHEMA DRIFT', '수신된 키: hook_event_name, source') @('세션 중 변경됨')) -and $ok
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","source":123}'
$ok = (Assert-SystemMessage 'non-string source reports drift' $out @('SCHEMA DRIFT', '문자열이 아니어서') @('세션 중 변경됨', '123 세션')) -and $ok

# 11. PSCustomObject member access and `-ne` were case-insensitive in the original; the port keeps both:
#     a lowercase event name and case-drifted KEYS still produce the banner (a case-sensitive lookup would
#     see no `source` and report drift).
$out = Invoke-Hook '{"Hook_Event_Name":"configchange","SOURCE":"user_settings","File_Path":"/x/y"}'
$ok = (Assert-SystemMessage 'case-drifted keys and a lowercase event name still audit' $out `
        @('\[hook:config-audit\] user_settings 세션 중 변경됨 \(/x/y\)') @('SCHEMA DRIFT')) -and $ok
# 12. file_path goes through PowerShell's [string] cast: a number renders as its digits, true as True,
#     an array as its elements joined by a space (never "undefined"/"null"/a JSON dump); null is absent.
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","source":"user_settings","file_path":42}'
$ok = (Assert-SystemMessage 'numeric file_path renders as its digits' $out @('user_settings 세션 중 변경됨 \(42\) \(') @('SCHEMA DRIFT', 'undefined')) -and $ok
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","source":"user_settings","file_path":true}'
$ok = (Assert-SystemMessage 'boolean file_path renders as True' $out @('(?-i)변경됨 \(True\) \(') @('SCHEMA DRIFT', 'undefined')) -and $ok   # (?-i): the assertion core matches case-insensitively
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","source":"user_settings","file_path":["a","b"]}'
$ok = (Assert-SystemMessage 'array file_path renders space-joined' $out @('변경됨 \(a b\) \(') @('SCHEMA DRIFT', 'a,b')) -and $ok
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","source":"user_settings","file_path":null}'
$ok = (Assert-SystemMessage 'null file_path is no path' $out @('user_settings 세션 중 변경됨 \(대부분') @('SCHEMA DRIFT', 'null', '변경됨 \(\)')) -and $ok
# 13. the drift banner's key list is payload text too: a key carrying a line break or U+2028 flattens, and the
#     list is sorted case-insensitively (the original's Sort-Object).
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","x\n[hook:forged]\u2028y":1,"Alpha":2,"beta":3}'
$ok = (Assert-SystemMessage 'a hostile key name in the drift banner flattens; keys sort case-insensitively' $out `
        @('SCHEMA DRIFT', '수신된 키: Alpha, beta, hook_event_name, x \[hook:forged\] y\.') @('[\r\n\u2028]')) -and $ok
# 14. a payload string stays a string (spec 0006 §3.1): ConvertFrom-Json turned an ISO-date-shaped source into a
#     DateTime, which then read as "not a string" and reported drift.
$out = Invoke-Hook '{"hook_event_name":"ConfigChange","source":"2026-01-02T03:04:05Z"}'
$ok = (Assert-SystemMessage 'a date-shaped source string is still a tier name' $out @('\] 2026-01-02T03:04:05Z 세션 중 변경됨') @('SCHEMA DRIFT')) -and $ok

# Inline(): the hook owns no copy — it imports hook-lib.mjs's inline(), the one class every Node hook
# shares (hook-lib.selftest.ps1 holds that function's behaviour). The flattening cases above (8-10, 13)
# are behavioural through the real hook. A local Inline/inline would split the class again.
$src = [IO.File]::ReadAllText($hook)
$importsInline = [regex]::IsMatch($src, "(?m)^import\s*\{[^}]*\binline\b[^}]*\}\s*from\s*'\./hook-lib\.mjs'")
$ownCopy = [regex]::IsMatch($src, '(?i)\bfunction\s+inline\b|\b(?:const|let|var)\s+inline\b')
$ok = (Assert-True 'inline() is imported from hook-lib.mjs and the hook defines no Inline/inline of its own' `
        ($importsInline -and -not $ownCopy) "imports inline from hook-lib: $importsInline · defines its own: $ownCopy") -and $ok

# R1. REGISTRATION. Every case above pipes a payload straight into the script, so none of them sees whether
#     the runtime ever calls it, and the manifest gate checks only that a handler's path resolves — not its
#     event key or matcher. This pins the wiring (exec form, ADR 0116); that it FIRES is a live probe's to show.
$regFails = @()
try {
    $hj = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'hooks.json') -Raw | ConvertFrom-Json
    $sites = @()
    foreach ($evName in @($hj.hooks.PSObject.Properties.Name | Where-Object { $_ })) {
        foreach ($grp in @($hj.hooks.$evName | Where-Object { $_ })) {
            foreach ($h in @($grp.hooks | Where-Object { $_ })) {
                $parts = @([string]$h.command) + @($h.args | ForEach-Object { [string]$_ })
                if (($parts -join ' ') -match 'config-change-audit\.(ps1|mjs)') { $sites += [pscustomobject]@{ Event = $evName; Matcher = [string]$grp.matcher; H = $h } }
            }
        }
    }
    $wantArgs = @('${CLAUDE_PLUGIN_ROOT}/hooks/config-change-audit.mjs')
    $wantMatcher = 'user_settings|project_settings|local_settings|policy_settings'   # never `skills` (fires on every skill load)
    if ($sites.Count -ne 1) { $regFails += "want exactly 1 registration of config-change-audit (.mjs or the retired .ps1), found $($sites.Count)" }
    else {
        $s1 = $sites[0]
        $gotArgs = @($s1.H.args | ForEach-Object { [string]$_ })
        if ($s1.Event -cne 'ConfigChange') { $regFails += "event '$($s1.Event)' (want ConfigChange)" }
        if ($s1.Matcher -cne $wantMatcher) { $regFails += "matcher '$($s1.Matcher)' (want '$wantMatcher')" }
        if ([string]$s1.H.type -cne 'command' -or [string]$s1.H.command -cne 'node') { $regFails += "handler type/command '$($s1.H.type)'/'$($s1.H.command)' (want command/node)" }
        if (($gotArgs -join "`0") -cne ($wantArgs -join "`0")) { $regFails += "args [$($gotArgs -join ' ')] (want exec form [$($wantArgs -join ' ')])" }
        else {
            $resolved = Join-Path (Split-Path $PSScriptRoot -Parent) ($gotArgs[-1] -replace '^\$\{CLAUDE_PLUGIN_ROOT\}/', '')
            if ([IO.Path]::GetFullPath($resolved) -ne [IO.Path]::GetFullPath($hook)) { $regFails += "args resolve to '$resolved', not this suite's script '$hook'" }
        }
        if ([string]$s1.H.timeout -ne '10') { $regFails += "timeout '$($s1.H.timeout)' (want 10)" }
    }
} catch { $regFails += "hooks.json unreadable: $($_.Exception.Message)" }
$ok = (Assert-True 'R1 hooks.json registers this script once: ConfigChange, the four settings tiers (no skills), exec-form node <script>' `
        (-not $regFails.Count) ($regFails -join ' · ')) -and $ok

# META — every case above already carried a negative, so the empty-MustNotMatch guard in
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
