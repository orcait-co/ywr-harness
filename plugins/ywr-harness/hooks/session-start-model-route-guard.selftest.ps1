# Self-test for session-start-model-route-guard.mjs (ADR 0107, ADR 0116).
# Usage: pwsh plugins/ywr-harness/hooks/session-start-model-route-guard.selftest.ps1
#
# Hermetic by construction (fact 16): every child runs with the guarded variables CLEARED and
# CLAUDE_CONFIG_DIR / CLAUDE_PROJECT_DIR / USERPROFILE / HOME pointed into the fixture, then gets
# only the case's own values — the owner's real settings.json and a CI runner's environment never
# reach a verdict. Payload shape: the SessionStart contract of the raw hooks doc (read 2026-09-29:
# `source`, optional `model`); the hook needs only `hook_event_name` (and `cwd` as a project-dir
# fallback), so the cases send the documented fields and nothing invented.
# Every match-based case carries MustNotMatch as well as MustMatch (the empty-MustNotMatch class).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core + fixture lifecycle
$hook = Join-Path $PSScriptRoot 'session-start-model-route-guard.mjs'
# The hook is Node (ADR 0116): absent node is a reported skip locally and a FAIL on CI.
Assert-NodeOrExit 'session-start-model-route-guard'
$nodeExe = (Get-Command node).Source

$guarded = @('ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_EFFORT_LEVEL')
$pinned = @('CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'USERPROFILE', 'HOME')

$fx = New-FixtureRoot 'ssmrg-selftest'
$saved = @{}
foreach ($k in $guarded + $pinned) { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
function Restore-Env { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
trap { Restore-Env; Remove-FixtureRoot $fx; break }

$userDir = Join-Path $fx 'config'; $proj = Join-Path $fx 'proj'; $homeDir = Join-Path $fx 'home'
foreach ($d in @($userDir, (Join-Path $proj '.claude'), (Join-Path $homeDir '.claude'))) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
function Set-Json([string]$Path, [string]$Text) { if ($Text) { [IO.File]::WriteAllText($Path, $Text) } elseif (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path } }

# Env: the case's variables. Files: user / project / local settings text ('' = absent).
# -NoConfigDir unsets CLAUDE_CONFIG_DIR so the home fallback is read; -NoProjectDir unsets
# CLAUDE_PROJECT_DIR so the payload cwd is the project.
# `[string]` parameters turn $null into '', so the stdin default is '' and tested with -not (a $null test sent
# an empty payload and left every speaking case silent — caught by META).
function Invoke-Guard {
    param([hashtable]$Env = @{}, [string]$User = '', [string]$Project = '', [string]$Local = '', [string]$HomeUser = '',
        [string]$Stdin = '', [switch]$Preflight, [switch]$NoConfigDir, [switch]$NoProjectDir)
    Set-Json (Join-Path $userDir 'settings.json') $User
    Set-Json (Join-Path $proj '.claude/settings.json') $Project
    Set-Json (Join-Path $proj '.claude/settings.local.json') $Local
    Set-Json (Join-Path $homeDir '.claude/settings.json') $HomeUser
    foreach ($k in $guarded) { [Environment]::SetEnvironmentVariable($k, $null) }
    [Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR', $(if ($NoConfigDir) { $null } else { $userDir }))
    [Environment]::SetEnvironmentVariable('CLAUDE_PROJECT_DIR', $(if ($NoProjectDir) { $null } else { $proj }))
    [Environment]::SetEnvironmentVariable('USERPROFILE', $homeDir)
    [Environment]::SetEnvironmentVariable('HOME', $homeDir)
    foreach ($k in $Env.Keys) { [Environment]::SetEnvironmentVariable($k, $Env[$k]) }
    try {
        if ($Preflight) { $o = (& $nodeExe $hook --preflight 2>&1 | Out-String) }
        else {
            if (-not $Stdin) { $Stdin = (@{ hook_event_name = 'SessionStart'; session_id = 'selftest'; source = 'startup'; cwd = $proj } | ConvertTo-Json -Compress) }
            $o = ($Stdin | & $nodeExe $hook 2>&1 | Out-String)
        }
        $script:HookExit = $LASTEXITCODE
    }
    finally { Restore-Env }
    return $o
}
function Assert-Warn([string]$Name, [string]$Out, [string[]]$MustMatch, [string[]]$MustNotMatch) {
    $pre = @()
    if ($script:HookExit -ne 0) { $pre += "exit $script:HookExit (want 0 — SessionStart blocks nothing)" }
    $sys = ''
    try {
        $j = ConvertFrom-Json $Out.Trim()
        $sys = [string]$j.systemMessage
        if ($null -ne $j.hookSpecificOutput) { $pre += 'hookSpecificOutput present — the guard speaks to the member only, never into the model context' }
    }
    catch { $pre += 'stdout is not valid JSON' }
    if (-not $sys) { $pre += 'no systemMessage' }
    if ($sys -match '[\r\n\u0085\u2028\u2029]') { $pre += 'systemMessage is not one line' }
    if ($sys -match '\bADR\s*\d') { $pre += 'systemMessage cites a decision number (spec 0006 §3.1)' }
    $script:LastFails = Get-AssertionFailure -Text $sys -MustMatch $MustMatch -MustNotMatch $MustNotMatch -PreFail $pre -Label 'systemMessage'
    return (Write-CaseVerdict -Name $Name -Fail $script:LastFails -Detail $Out)
}
function Assert-Silent([string]$Name, [string]$Out) {
    $fails = @()
    if ($script:HookExit -ne 0) { $fails += "exit $script:HookExit (want 0)" }
    if ($Out.Trim()) { $fails += "expected byte-silent stdout (it would become session context), got: $($Out.Trim())" }
    return (Write-CaseVerdict -Name $Name -Fail $fails)
}
function Assert-Preflight([string]$Name, [string]$Out, [int]$Want, [string[]]$MustMatch, [string[]]$MustNotMatch) {
    $pre = @(); if ($script:HookExit -ne $Want) { $pre += "exit $script:HookExit (want $Want)" }
    $script:LastFails = Get-AssertionFailure -Text $Out -MustMatch $MustMatch -MustNotMatch $MustNotMatch -PreFail $pre
    return (Write-CaseVerdict -Name $Name -Fail $script:LastFails -Detail $Out)
}

$ok = $true
$core = @('^\[hook:model-route\]', 'family alias', '지우세요', '막지 않았습니다')

# --- preflight (the eval runner's refusal) ---------------------------------------------------
$ok = (Assert-Preflight 'P1 a clean shell is clear, exit 0' (Invoke-Guard -Preflight) 0 @('^preflight: clear') @('REFUSED')) -and $ok
foreach ($c in @(
        @{ n = 'P2 a family override refuses, whatever its value'; e = @{ ANTHROPIC_DEFAULT_OPUS_MODEL = 'opus' }; m = 'ANTHROPIC_DEFAULT_OPUS_MODEL=opus' },
        @{ n = 'P3 a full-id session model refuses'; e = @{ ANTHROPIC_MODEL = 'claude-opus-4-6' }; m = 'ANTHROPIC_MODEL=claude-opus-4-6' },
        @{ n = 'P4 a full-id subagent model refuses'; e = @{ CLAUDE_CODE_SUBAGENT_MODEL = 'claude-sonnet-5' }; m = 'CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5' },
        @{ n = 'P4b an ALIAS subagent model refuses too (it moves every unassigned worker to that family)'; e = @{ CLAUDE_CODE_SUBAGENT_MODEL = 'haiku' }; m = 'CLAUDE_CODE_SUBAGENT_MODEL=haiku' },
        @{ n = 'P5 a cloud provider refuses'; e = @{ CLAUDE_CODE_USE_BEDROCK = '1' }; m = 'CLAUDE_CODE_USE_BEDROCK \(this shell\)' },
        @{ n = 'P6 ANTHROPIC_DEFAULT_MODEL with a full id refuses'; e = @{ ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5' }; m = 'ANTHROPIC_DEFAULT_MODEL=claude-haiku-4-5' })) {
    $ok = (Assert-Preflight $c.n (Invoke-Guard -Preflight -Env $c.e) 1 @("preflight: REFUSED — $($c.m)", 'unset the variable') @('preflight: clear')) -and $ok
}
$ok = (Assert-Preflight 'P7 aliases and off values are clear (sonnet[1m], opusplan, provider 0/false)' `
        (Invoke-Guard -Preflight -Env @{ ANTHROPIC_MODEL = 'sonnet[1m]'; ANTHROPIC_DEFAULT_MODEL = 'opusplan'; CLAUDE_CODE_USE_VERTEX = '0'; CLAUDE_CODE_USE_FOUNDRY = 'false' }) 0 `
        @('^preflight: clear') @('REFUSED')) -and $ok
$ok = (Assert-Preflight 'P8 preflight ignores settings files (an eval child gets its own config dir)' `
        (Invoke-Guard -Preflight -User '{"model":"claude-opus-4-6","modelOverrides":{"claude-opus-5-5":"x"}}') 0 @('^preflight: clear') @('REFUSED')) -and $ok
$ok = (Assert-Preflight 'P9 preflight ignores CLAUDE_CODE_EFFORT_LEVEL (the eval wrapper sets it to low itself, ADR 0103/0130)' `
        (Invoke-Guard -Preflight -Env @{ CLAUDE_CODE_EFFORT_LEVEL = 'xhigh' }) 0 @('^preflight: clear') @('REFUSED', 'EFFORT')) -and $ok

# --- the SessionStart guard --------------------------------------------------------------------
$ok = (Assert-Silent 'S1 nothing set -> byte-silent' (Invoke-Guard)) -and $ok
$ok = (Assert-Silent 'S2 alias-only settings (model: opus[1m], empty modelOverrides, alias env) -> byte-silent' `
        (Invoke-Guard -User '{"model":"opus[1m]","modelOverrides":{},"env":{"ANTHROPIC_DEFAULT_MODEL":"haiku"}}' -Env @{ ANTHROPIC_MODEL = 'Opus' })) -and $ok
$ok = (Assert-Silent 'S3 a wrong event is silent' (Invoke-Guard -Env @{ ANTHROPIC_DEFAULT_SONNET_MODEL = 'x' } -Stdin '{"hook_event_name":"PreToolUse"}')) -and $ok
$ok = (Assert-Silent 'S4 unparseable stdin is silent (fail-open)' (Invoke-Guard -Env @{ ANTHROPIC_DEFAULT_SONNET_MODEL = 'x' } -Stdin 'not json')) -and $ok
$ok = (Assert-Silent 'S5 an unparseable settings file is skipped, not reported' (Invoke-Guard -User '{"model": "claude-opus-4-6",' -Project 'nope')) -and $ok

$ok = (Assert-Warn 'W1 a family override in the environment warns, naming key, value and alias' `
        (Invoke-Guard -Env @{ ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5' }) `
        ($core + @('`ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5` \(환경변수\)', '`sonnet` alias')) @('ANTHROPIC_MODEL', 'modelOverrides')) -and $ok
$ok = (Assert-Warn 'W2 every env kind in one message (session id, subagent id, provider)' `
        (Invoke-Guard -Env @{ ANTHROPIC_MODEL = 'claude-opus-4-6'; CLAUDE_CODE_SUBAGENT_MODEL = 'claude-sonnet-5'; CLAUDE_CODE_USE_FOUNDRY = '1' }) `
        ($core + @('ANTHROPIC_MODEL=claude-opus-4-6', 'CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5', 'CLAUDE_CODE_USE_FOUNDRY', 'provider')) @('ANTHROPIC_DEFAULT_')) -and $ok
$ok = (Assert-Warn 'W3 a full-id model in the user settings warns with the file' `
        (Invoke-Guard -User '{"model":"claude-sonnet-5"}') `
        ($core + @('`model: claude-sonnet-5`', [regex]::Escape((Join-Path $userDir 'settings.json')))) @('modelOverrides', '환경변수')) -and $ok
$ok = (Assert-Warn 'W4 a non-empty modelOverrides in the project settings warns with its count' `
        (Invoke-Guard -Project '{"modelOverrides":{"claude-opus-5-5":"arn:x","claude-sonnet-5-5":"arn:y"}}') `
        ($core + @('`modelOverrides` 2개 항목', [regex]::Escape((Join-Path $proj '.claude/settings.json')))) @('`model:', '환경변수')) -and $ok
$ok = (Assert-Warn 'W4b a hand-edited settings file (// and block comments, a trailing comma) is still read: its full-id model warns (ConvertFrom-Json read these)' `
        (Invoke-Guard -User "{`n  // pinned for the migration`n  `"model`": `"claude-opus-4-6`", /* old route */`n  `"env`": { `"ANTHROPIC_DEFAULT_HAIKU_MODEL`": `"claude-haiku-4-5`", },`n}") `
        ($core + @('`model: claude-opus-4-6`', 'ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5` \(.*settings\.json env\)')) @('환경변수')) -and $ok
$ok = (Assert-Warn 'W5 a settings env key is reported from the local file; the same key in the process env is reported once' `
        (Invoke-Guard -Local '{"env":{"ANTHROPIC_DEFAULT_HAIKU_MODEL":"claude-haiku-4-5","ANTHROPIC_DEFAULT_OPUS_MODEL":"claude-opus-4-6"}}' -Env @{ ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5' }) `
        ($core + @('ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5` \(환경변수\)', 'ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6` \(.*settings\.local\.json env\)')) `
        @('ANTHROPIC_DEFAULT_HAIKU_MODEL[^;]*settings\.local\.json')) -and $ok
$ok = (Assert-Warn 'W6 without CLAUDE_CONFIG_DIR the home settings file is read' `
        (Invoke-Guard -NoConfigDir -HomeUser '{"model":"claude-opus-4-6"}' -User '{"model":"claude-haiku-4-5"}') `
        ($core + @('`model: claude-opus-4-6`', [regex]::Escape((Join-Path $homeDir '.claude')))) @('claude-haiku-4-5')) -and $ok
$ok = (Assert-Warn 'W7 without CLAUDE_PROJECT_DIR the payload cwd names the project' `
        (Invoke-Guard -NoProjectDir -Project '{"model":"claude-sonnet-5"}') `
        ($core + @('`model: claude-sonnet-5`', [regex]::Escape((Join-Path $proj '.claude')))) @('환경변수')) -and $ok
$other = Join-Path $fx 'other'; New-Item -ItemType Directory -Force -Path (Join-Path $other '.claude') | Out-Null
[IO.File]::WriteAllText((Join-Path $other '.claude/settings.json'), '{"model":"claude-haiku-4-5"}')
$ok = (Assert-Warn 'W9 CLAUDE_PROJECT_DIR wins over the payload cwd (a subdirectory session still reads the project)' `
        (Invoke-Guard -Project '{"model":"claude-sonnet-5"}' -Stdin (@{ hook_event_name = 'SessionStart'; source = 'startup'; cwd = $other } | ConvertTo-Json -Compress)) `
        ($core + @('`model: claude-sonnet-5`')) @('claude-haiku-4-5')) -and $ok
# --- the effort pin (ADR 0130) -------------------------------------------------------------------
$effCore = @('^\[hook:model-route\]', 'effort pin 을 덮어쓰는', '역할별', '지우세요', '막지 않았습니다')
$ok = (Assert-Warn 'E1 CLAUDE_CODE_EFFORT_LEVEL in the environment warns alone, with no model clause' `
        (Invoke-Guard -Env @{ CLAUDE_CODE_EFFORT_LEVEL = 'high' }) `
        ($effCore + @('`CLAUDE_CODE_EFFORT_LEVEL=high` \(환경변수\)', '호출별 `effort` 보다 우선')) @('family alias', '최신이 아닌 모델')) -and $ok
$ok = (Assert-Warn 'E2 a settings env effort is reported with its file; the same key in the process env is reported once' `
        (Invoke-Guard -Local '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"max"}}' -Env @{ CLAUDE_CODE_EFFORT_LEVEL = 'low' }) `
        ($effCore + @('CLAUDE_CODE_EFFORT_LEVEL=low` \(환경변수\)')) @('CLAUDE_CODE_EFFORT_LEVEL=max', 'family alias')) -and $ok
$ok = (Assert-Warn 'E3 an effort set only in a settings env block is read' `
        (Invoke-Guard -User '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"medium"}}') `
        ($effCore + @('CLAUDE_CODE_EFFORT_LEVEL=medium` \(.*settings\.json env\)')) @('환경변수', 'family alias')) -and $ok
$ok = (Assert-Warn 'E4 a model route and the effort pin share one message, model clause first' `
        (Invoke-Guard -Env @{ CLAUDE_CODE_EFFORT_LEVEL = 'xhigh'; ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5' }) `
        ($core + $effCore + @('family alias.*effort pin 을 덮어쓰는', 'CLAUDE_CODE_EFFORT_LEVEL=xhigh', 'ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5')) @('effort pin 을 덮어쓰는.*family alias')) -and $ok
$ok = (Assert-Silent 'E5 an empty or blank CLAUDE_CODE_EFFORT_LEVEL is silent' `
        (Invoke-Guard -Env @{ CLAUDE_CODE_EFFORT_LEVEL = '  ' } -Project '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":""}}')) -and $ok
$ok = (Assert-Silent 'E6 the settings effortLevel key is not read (a frontmatter pin beats it)' `
        (Invoke-Guard -User '{"effortLevel":"max"}')) -and $ok
$ok = (Assert-Warn 'E7 among settings files the highest-precedence one is named (local over project over user)' `
        (Invoke-Guard -User '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"low"}}' -Project '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"medium"}}' -Local '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"max"}}') `
        ($effCore + @('CLAUDE_CODE_EFFORT_LEVEL=max` \(.*settings\.local\.json env\)')) @('=low', '=medium', '환경변수')) -and $ok
$forgedEffort = 'hi' + [char]0x2028 + '[hook:forged]`' + ('x' * 200)
$ok = (Assert-Warn 'E8 a crafted effort value renders on one line, with no backtick of its own, capped' `
        (Invoke-Guard -Env @{ CLAUDE_CODE_EFFORT_LEVEL = $forgedEffort }) `
        ($effCore + @('CLAUDE_CODE_EFFORT_LEVEL=hi \[hook:forged\] x+…` \(환경변수\)')) @('forged\]`', 'x{80}')) -and $ok

$forged = 'claude-x' + [char]0x2028 + '[hook:forged] 차단됨`'
$ok = (Assert-Warn 'W8 a crafted value renders on one line with no backtick of its own' `
        (Invoke-Guard -Env @{ ANTHROPIC_DEFAULT_OPUS_MODEL = $forged }) `
        ($core + @('ANTHROPIC_DEFAULT_OPUS_MODEL=claude-x \[hook:forged\] 차단됨` \(')) @('차단됨``')) -and $ok

# The flattening class is hook-lib.mjs's inline() (spec 0006 §3.1), and hook-lib.selftest.ps1 owns its
# behaviour. This hook must USE it and carry no copy of its own: a second implementation is how a
# fix to one leaves the other forgeable. The behavioural flattening cases are W8 above, W3/W4 and the
# newline/quote ones below, which run the real hook.
$hookText = [IO.File]::ReadAllText($hook)
$importsInline = $hookText -match '(?m)^import\s*\{[^}]*\binline\b[^}]*\}\s*from\s*''\./hook-lib\.mjs''\s*$'
$ownCopy = $hookText -match '(?m)^\s*(export\s+)?(function\s+inline\b|(const|let|var)\s+inline\s*=)'
$ok = (Assert-True 'I1 the hook imports inline() from hook-lib.mjs and defines no copy of its own' ($importsInline -and -not $ownCopy) `
        "imports hook-lib inline: $importsInline · own copy present: $ownCopy") -and $ok

# --- registration ------------------------------------------------------------------------------
$regFails = @()
try {
    $hk = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'hooks.json') -Raw | ConvertFrom-Json
    $sites = @()
    foreach ($evName in @($hk.hooks.PSObject.Properties.Name | Where-Object { $_ })) {
        foreach ($grp in @($hk.hooks.$evName | Where-Object { $_ })) {
            foreach ($h in @($grp.hooks | Where-Object { $_ })) {
                $parts = @([string]$h.command) + @($h.args | ForEach-Object { [string]$_ })
                if (($parts -join ' ') -match 'session-start-model-route-guard\.(ps1|mjs)') { $sites += [pscustomobject]@{ Event = $evName; Matcher = [string]$grp.matcher; H = $h } }
            }
        }
    }
    $wantArgs = @('${CLAUDE_PLUGIN_ROOT}/hooks/session-start-model-route-guard.mjs')
    if ($sites.Count -ne 1) { $regFails += "want exactly 1 registration of session-start-model-route-guard (.mjs or the retired .ps1), found $($sites.Count)" }
    else {
        $s = $sites[0]
        $gotArgs = @($s.H.args | ForEach-Object { [string]$_ })
        if ($s.Event -cne 'SessionStart') { $regFails += "event '$($s.Event)' (want SessionStart)" }
        if ($s.Matcher -cne 'startup|resume|fork') { $regFails += "matcher '$($s.Matcher)' (want exactly 'startup|resume|fork' — clear/compact keep the process env)" }
        if ([string]$s.H.type -cne 'command' -or [string]$s.H.command -cne 'node') { $regFails += "handler type/command '$($s.H.type)'/'$($s.H.command)' (want command/node)" }
        if (($gotArgs -join "`0") -cne ($wantArgs -join "`0")) { $regFails += "args [$($gotArgs -join ' ')] (want exec form [$($wantArgs -join ' ')])" }
        else {
            $resolved = Join-Path (Split-Path $PSScriptRoot -Parent) ($gotArgs[-1] -replace '^\$\{CLAUDE_PLUGIN_ROOT\}/', '')
            if ([IO.Path]::GetFullPath($resolved) -ne [IO.Path]::GetFullPath($hook)) { $regFails += "args resolve to '$resolved', not this suite's script '$hook'" }
        }
    }
} catch { $regFails += "hooks.json unreadable: $($_.Exception.Message)" }
$ok = (Assert-True 'R1 registered once under SessionStart with matcher startup|resume|fork, exec-form node <script> (clear/compact keep the process env)' `
        (-not $regFails.Count) ($regFails -join ' · ')) -and $ok

# META — the silent assertion must refuse a speaking run, or S1–S5 prove nothing.
$metaOut = Invoke-Guard -Env @{ ANTHROPIC_DEFAULT_SONNET_MODEL = 'x' }
$ok = (Assert-True 'META Assert-Silent refuses a speaking run' (-not (Assert-Silent 'probe' $metaOut 6>$null))) -and $ok

Remove-FixtureRoot $fx
if ($ok) { Write-Host 'session-start-model-route-guard selftest: all cases green' -ForegroundColor Green; exit 0 }
Write-Host 'session-start-model-route-guard selftest: FAILED' -ForegroundColor Red
exit 1
