# Self-test for question-notify.mjs (ADR 0202): the Windows toast a hook shows while the model waits for an
# AskUserQuestion answer (PreToolUse) and removes when the answer arrives (PostToolUse).
# Usage: pwsh plugins/ywr-harness/hooks/question-notify.selftest.ps1
#
# Fixture provenance: the payload carries `hook_event_name`, `tool_name`, `session_id`, `cwd` and
# `tool_input`. For AskUserQuestion, `tool_input.questions` is a list of {question, header, options,
# multiSelect}; the hook reads `header` and `question` of the first object entry and the count of entries.
# This suite builds those payloads by hand; it never captured one live.
#
# THIS SUITE NEVER STARTS POWERSHELL. A started child would show a real toast on the machine that runs
# the suite. Two rules keep that true:
#   - the pure half (`notice`, `tagOf`, `script`, `encoded`, `powershellExe`, `optedOut`, `isMain`) is called
#     in ONE node process per group, with an explicit `platform` and explicit `env` objects, so every case is
#     the same on Linux CI and nothing spawns. `run` is called there with a FAKE `spawnFn` that records its
#     call and starts nothing, and with a SystemRoot that holds a PLAIN FILE at the PowerShell path;
#   - each end-to-end case runs the hook as a child process with a `--import` preload module that (a) sets
#     `SystemRoot` in `process.env` before the hook file runs as the main module (a node process cannot START
#     without the real SystemRoot: it aborts in its random-number init, exit 134, measured 2026-11-13, so the
#     child starts with the real one) and (b) replaces `child_process.spawnSync` with a stub that appends its
#     call to a log file and starts nothing (`syncBuiltinESMExports` carries the replacement to the hook's
#     named import). The root is an EMPTY temp dir where a case wants "no powershell.exe", and a dir with a
#     plain file at the PowerShell path where a case wants the hook to reach its spawn. A case that proves a
#     SILENCE (an opt-out, a wrong tool, bad stdin) uses the second root, so a deleted check shows as a logged
#     call: against an empty root that case would pass with the check gone. The root and the log path reach
#     the preload through variables set on the child's ProcessStartInfo only.
#
# Escapes: line-break and control characters are built from [char] codes here, never spelled in the file
# (an escape in an editor can land as the literal character). The node program that drives the pure half
# is a temp file, not `node -e`: argument quoting through pwsh differs by version and platform.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core
$hook = Join-Path $PSScriptRoot 'question-notify.mjs'
# The hook is Node (ADR 0116): absent node is a reported skip locally and a FAIL on CI.
Assert-NodeOrExit 'question-notify'
$nodeExe = (Get-Command node).Source

$fx = New-FixtureRoot 'question-notify-selftest'
trap { Remove-FixtureRoot $fx; break }

$script:ok = $true
function Add-Case([string]$Name, [string[]]$Fail) {
    $f = @($Fail | Where-Object { $_ })
    $script:ok = (Assert-True -Name $Name -Condition (-not $f.Count) -Detail ($f -join ' · ')) -and $script:ok
}

# One child process of node: stdin text in, stdout/stderr text and the exit code out. $Env entries are set
# on the child only (a $null value removes the variable); the parent's environment is never touched.
function Invoke-Node([string[]]$NodeArgs, [string]$Stdin = '', [hashtable]$Env = @{}, [string]$Cwd = $fx) {
    $psi = [Diagnostics.ProcessStartInfo]::new($nodeExe)
    foreach ($a in $NodeArgs) { $psi.ArgumentList.Add($a) }
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $Cwd
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $utf8 = [Text.UTF8Encoding]::new($false)
    $psi.StandardInputEncoding = $utf8
    $psi.StandardOutputEncoding = $utf8
    $psi.StandardErrorEncoding = $utf8
    foreach ($k in @($Env.Keys)) {
        if ($null -eq $Env[$k]) { [void]$psi.Environment.Remove($k) } else { $psi.Environment[$k] = [string]$Env[$k] }
    }
    $p = [Diagnostics.Process]::Start($psi)
    $so = $p.StandardOutput.ReadToEndAsync()
    $se = $p.StandardError.ReadToEndAsync()
    try { $p.StandardInput.Write($Stdin); $p.StandardInput.Close() } catch { }   # node may exit before it reads
    $timedOut = -not $p.WaitForExit(20000)
    if ($timedOut) { try { $p.Kill($true) } catch { }; [void]$p.WaitForExit(5000) }
    return @{ Exit = $(if ($timedOut) { -1 } else { $p.ExitCode }); Out = $so.Result; Err = $se.Result; TimedOut = $timedOut }
}

# ---------------------------------------------------------------------------------------------------
# R1. REGISTRATION. The cases below call the exported functions and run the file by hand, so none of them
#     sees whether the runtime ever calls the hook. A matcher of `askuserquestion` (the exact-string match
#     is case-sensitive) or a wrong event key would leave it inert with every other case green. The hook
#     needs BOTH events: PreToolUse shows the toast and PostToolUse removes it. This pins the wiring; that
#     it FIRES is a live `--plugin-dir` probe's to show.
$regFails = @()
try {
    $hj = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'hooks.json') -Raw | ConvertFrom-Json
    $sites = @()
    foreach ($evName in @($hj.hooks.PSObject.Properties.Name | Where-Object { $_ })) {
        foreach ($grp in @($hj.hooks.$evName | Where-Object { $_ })) {
            foreach ($h in @($grp.hooks | Where-Object { $_ })) {
                $parts = @([string]$h.command) + @($h.args | ForEach-Object { [string]$_ })
                if (($parts -join ' ') -match 'question-notify') { $sites += [pscustomobject]@{ Event = $evName; Matcher = [string]$grp.matcher; H = $h } }
            }
        }
    }
    $wantArgs = @('${CLAUDE_PLUGIN_ROOT}/hooks/question-notify.mjs')
    if ($sites.Count -ne 2) { $regFails += "want exactly 2 registrations of question-notify (PreToolUse and PostToolUse), found $($sites.Count)" }
    foreach ($wantEvent in @('PreToolUse', 'PostToolUse')) {
        $mine = @($sites | Where-Object { $_.Event -ceq $wantEvent })
        if ($mine.Count -ne 1) { $regFails += "event ${wantEvent}: $($mine.Count) registrations (want 1; the event key is case-sensitive)"; continue }
        $s = $mine[0]
        $gotArgs = @($s.H.args | ForEach-Object { [string]$_ })
        if ($s.Matcher -cne 'AskUserQuestion') { $regFails += "$wantEvent matcher '$($s.Matcher)' (want exactly 'AskUserQuestion' — the match is case-sensitive)" }
        if ([string]$s.H.type -cne 'command' -or [string]$s.H.command -cne 'node') { $regFails += "$wantEvent handler type/command '$($s.H.type)'/'$($s.H.command)' (want command/node)" }
        if (($gotArgs -join "`0") -cne ($wantArgs -join "`0")) { $regFails += "$wantEvent args [$($gotArgs -join ' ')] (want exec form [$($wantArgs -join ' ')])" }
        else {
            $resolved = Join-Path (Split-Path $PSScriptRoot -Parent) ($gotArgs[-1] -replace '^\$\{CLAUDE_PLUGIN_ROOT\}/', '')
            if ([IO.Path]::GetFullPath($resolved) -ne [IO.Path]::GetFullPath($hook)) { $regFails += "$wantEvent args resolve to '$resolved', not this suite's script '$hook'" }
        }
        if ([string]$s.H.timeout -ne '10') { $regFails += "$wantEvent timeout '$($s.H.timeout)' (want 10)" }
        # async: the hook waits for its child (CHILD_TIMEOUT_MS), so only an async registration keeps the question dialog unblocked
        if ($s.H.async -isnot [bool] -or $s.H.async -ne $true) { $regFails += "$wantEvent async '$($s.H.async)' (want the boolean true: the hook waits for its child)" }
    }
} catch { $regFails += "hooks.json unreadable: $($_.Exception.Message)" }
Add-Case 'R1 hooks.json registers this script under PreToolUse and PostToolUse: matcher exactly AskUserQuestion, exec-form node <script>, timeout 10, async true' $regFails

# ---------------------------------------------------------------------------------------------------
# The pure half, one node process. Inputs are one JSON file; the output is ASCII JSON (every code unit
# above 126 as \uXXXX), so no console code page can change what is compared.
$ell = [string][char]0x2026
$sep = [IO.Path]::PathSeparator
$longA = 'a' * 500
$flat = 'a' + [char]10 + 'b' + [char]13 + 'c' + [char]0x60 + 'd' + [char]0x2028 + 'e' + [char]0x2029 + 'f' + [char]0x85 + 'g' + [char]9 + 'h' + [char]0 + 'i' + [char]0x7f + 'j'
$flatWant = 'a b c d e f g h i j'

function New-Ask([object[]]$Questions, $Cwd = '/work/demo-repo', [hashtable]$Extra = @{}) {
    $p = @{ hook_event_name = 'PreToolUse'; tool_name = 'AskUserQuestion'; session_id = 'sess-1'; tool_input = @{ questions = $Questions } }
    if ($null -ne $Cwd) { $p.cwd = $Cwd }
    foreach ($k in $Extra.Keys) { $p[$k] = $Extra[$k] }
    return $p
}
function New-Q([string]$Question, [string]$Header = '') {
    $q = @{ question = $Question; options = @(@{ label = 'x'; description = 'y' }, @{ label = 'z'; description = 'w' }); multiSelect = $false }
    if ($Header) { $q.header = $Header }
    return $q
}
$one = New-Ask @((New-Q 'Which one?' 'Scope'))
$post = New-Ask @((New-Q 'Which one?' 'Scope')) '/work/demo-repo' @{ hook_event_name = 'PostToolUse'; tool_response = @{ answers = @{ 'Which one?' = 'x' } } }
$win = 'win32'

$cases = @(
    # silent: not Windows (platform is passed, so Linux CI and Windows read the same), both events
    @{ id = 'linux'; payload = $one; platform = 'linux' }
    @{ id = 'darwin'; payload = $one; platform = 'darwin' }
    @{ id = 'linux-post'; payload = $post; platform = 'linux' }
    # silent: opt-out values, case and edge spaces ignored, both events
    @{ id = 'opt-0'; payload = $one; platform = $win; env = @{ '@OPT' = '0' } }
    @{ id = 'opt-false'; payload = $one; platform = $win; env = @{ '@OPT' = 'false' } }
    @{ id = 'opt-NO'; payload = $one; platform = $win; env = @{ '@OPT' = 'NO' } }
    @{ id = 'opt-off-spaces'; payload = $one; platform = $win; env = @{ '@OPT' = ' off ' } }
    @{ id = 'opt-off-post'; payload = $post; platform = $win; env = @{ '@OPT' = 'off' } }
    # silent: not these events / tools / shapes
    @{ id = 'event-other'; payload = (New-Ask @((New-Q 'q')) '/work/r' @{ hook_event_name = 'Notification' }); platform = $win }
    @{ id = 'event-failure'; payload = (New-Ask @((New-Q 'q')) '/work/r' @{ hook_event_name = 'PostToolUseFailure' }); platform = $win }
    @{ id = 'event-missing'; payload = @{ tool_name = 'AskUserQuestion'; tool_input = @{ questions = @((New-Q 'q')) } }; platform = $win }
    @{ id = 'tool-bash'; payload = (New-Ask @((New-Q 'q')) '/work/r' @{ tool_name = 'Bash' }); platform = $win }
    @{ id = 'tool-bash-post'; payload = (New-Ask @((New-Q 'q')) '/work/r' @{ tool_name = 'Bash'; hook_event_name = 'PostToolUse' }); platform = $win }
    @{ id = 'tool-missing'; payload = @{ hook_event_name = 'PreToolUse'; tool_input = @{ questions = @((New-Q 'q')) } }; platform = $win }
    @{ id = 'payload-string'; payload = 'AskUserQuestion'; platform = $win }
    @{ id = 'payload-number'; payload = 5; platform = $win }
    @{ id = 'payload-array'; payload = @(1, 2); platform = $win }
    @{ id = 'payload-bool'; payload = $true; platform = $win }
    @{ id = 'payload-null'; payload = $null; platform = $win }
    # speaks: not opted out by these
    @{ id = 'opt-1'; payload = $one; platform = $win; env = @{ '@OPT' = '1' } }
    @{ id = 'opt-yes'; payload = $one; platform = $win; env = @{ '@OPT' = 'yes' } }
    @{ id = 'opt-empty'; payload = $one; platform = $win; env = @{ '@OPT' = '' } }
    @{ id = 'opt-unset'; payload = $one; platform = $win; env = @{} }
    @{ id = 'opt-other-var'; payload = $one; platform = $win; env = @{ 'SOMETHING_ELSE' = '0' } }
    # event names compare case-insensitively
    @{ id = 'event-lowercase'; payload = (New-Ask @((New-Q 'q')) '/work/r' @{ hook_event_name = 'pretooluse' }); platform = $win }
    @{ id = 'event-lowercase-post'; payload = (New-Ask @((New-Q 'q')) '/work/r' @{ hook_event_name = 'posttooluse' }); platform = $win }
    # actions and tags
    @{ id = 'show-s1'; payload = $one; platform = $win }
    @{ id = 'clear-s1'; payload = $post; platform = $win }
    @{ id = 'show-s2'; payload = (New-Ask @((New-Q 'q')) '/work/r' @{ session_id = 'sess-2' }); platform = $win }
    @{ id = 'clear-s2'; payload = (New-Ask @((New-Q 'q')) '/work/r' @{ session_id = 'sess-2'; hook_event_name = 'PostToolUse' }); platform = $win }
    @{ id = 'show-nosession'; payload = @{ hook_event_name = 'PreToolUse'; tool_name = 'AskUserQuestion'; tool_input = @{ questions = @((New-Q 'q')) } }; platform = $win }
    @{ id = 'clear-nosession'; payload = @{ hook_event_name = 'PostToolUse'; tool_name = 'AskUserQuestion' }; platform = $win }
    @{ id = 'clear-bare'; payload = @{ hook_event_name = 'PostToolUse'; tool_name = 'AskUserQuestion'; session_id = 'sess-1' }; platform = $win }
    # title
    @{ id = 'title-basename'; payload = (New-Ask @((New-Q 'q')) '/work/demo-repo'); platform = $win }
    @{ id = 'title-no-cwd'; payload = (New-Ask @((New-Q 'q')) $null); platform = $win }
    @{ id = 'title-empty-cwd'; payload = (New-Ask @((New-Q 'q')) ''); platform = $win }
    @{ id = 'title-root-cwd'; payload = (New-Ask @((New-Q 'q')) '/'); platform = $win }
    @{ id = 'title-long-cwd'; payload = (New-Ask @((New-Q 'q')) ('/work/' + ('x' * 100))); platform = $win }
    @{ id = 'title-flat-cwd'; payload = (New-Ask @((New-Q 'q')) ('/work/p' + [char]0x60 + 'q')); platform = $win }
    # text
    @{ id = 'text-header'; payload = $one; platform = $win }
    @{ id = 'text-no-header'; payload = (New-Ask @((New-Q 'Which one?'))); platform = $win }
    @{ id = 'text-more-2'; payload = (New-Ask @((New-Q 'Which one?' 'Scope'), (New-Q 'second'), (New-Q 'third'))); platform = $win }
    @{ id = 'text-more-1'; payload = (New-Ask @((New-Q 'Which one?' 'Scope'), (New-Q 'second'))); platform = $win }
    @{ id = 'text-empty-question'; payload = (New-Ask @((New-Q '' 'Scope'))); platform = $win }
    @{ id = 'text-empty-question-no-header'; payload = (New-Ask @((New-Q ''))); platform = $win }
    @{ id = 'text-no-questions'; payload = (New-Ask @()); platform = $win }
    @{ id = 'text-no-tool-input'; payload = @{ hook_event_name = 'PreToolUse'; tool_name = 'AskUserQuestion'; cwd = '/work/demo-repo' }; platform = $win }
    @{ id = 'text-questions-not-array'; payload = @{ hook_event_name = 'PreToolUse'; tool_name = 'AskUserQuestion'; tool_input = @{ questions = 'Which one?' } }; platform = $win }
    @{ id = 'text-first-object'; payload = (New-Ask @(5, (New-Q 'Q'))); platform = $win }
    @{ id = 'text-long'; payload = (New-Ask @((New-Q $longA 'Scope'))); platform = $win }
    @{ id = 'text-long-header'; payload = (New-Ask @((New-Q 'Q' ('H' * 100)))); platform = $win }
    @{ id = 'text-flat'; payload = (New-Ask @((New-Q $flat))); platform = $win }
    @{ id = 'text-flat-header'; payload = (New-Ask @((New-Q 'Q' $flat))); platform = $win }
)

# powershellExe fixtures. $rootA holds a fake powershell.exe at the real relative location.
$psRel = Join-Path (Join-Path (Join-Path 'System32' 'WindowsPowerShell') 'v1.0') 'powershell.exe'
$rootA = Join-Path $fx 'rootA'; $rootEmpty = Join-Path $fx 'root-empty'; $rootDir = Join-Path $fx 'root-dir'; $rootRel = Join-Path $fx 'relroot'
foreach ($r in @($rootA, $rootRel)) {
    New-Item -ItemType Directory -Force -Path (Split-Path (Join-Path $r $psRel) -Parent) | Out-Null
    Set-Content -LiteralPath (Join-Path $r $psRel) -Value 'x'
}
New-Item -ItemType Directory -Force -Path $rootEmpty | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $rootDir $psRel) | Out-Null   # a DIRECTORY named powershell.exe
$psCases = @(
    @{ id = 'ps-found'; env = @{ SystemRoot = $rootA } }
    @{ id = 'ps-found-upper-key'; env = @{ SYSTEMROOT = $rootA } }
    @{ id = 'ps-found-padded'; env = @{ SystemRoot = "  $rootA  " } }
    @{ id = 'ps-no-file'; env = @{ SystemRoot = $rootEmpty } }
    @{ id = 'ps-relative'; env = @{ SystemRoot = 'relroot' } }   # relroot/System32/... exists under the child's cwd
    @{ id = 'ps-missing'; env = @{ SystemRoot = (Join-Path $fx 'nope') } }
    @{ id = 'ps-empty'; env = @{ SystemRoot = '' } }
    @{ id = 'ps-unset'; env = @{} }
    @{ id = 'ps-dir-not-file'; env = @{ SystemRoot = $rootDir } }
)
$optCases = @('0', 'false', 'NO', ' off ', 'Off', 'no', '1', 'yes', '', 'maybe', '00', 'falsey', $null)
$tagIn = @('', $null, 'abc', 'abd', 'sess-1')

# run(): the fake spawnFn cases. $baseEnv holds a SystemRoot with the plain-file powershell.exe ($rootA) and two
# keys of the parent that must reach the child unchanged. The spec is keyed `@OPT` for the opt-out variable name.
$baseEnv = @{ SystemRoot = $rootA; KEEP_ME = 'v1'; Other_Key = 'v2' }
function New-RunEnv([hashtable]$Extra = @{}) { $e = @{} + $baseEnv; foreach ($k in $Extra.Keys) { $e[$k] = $Extra[$k] }; return $e }
$bashAsk = New-Ask @((New-Q 'q')) '/work/r' @{ tool_name = 'Bash' }
$bashPost = New-Ask @((New-Q 'q')) '/work/r' @{ tool_name = 'Bash'; hook_event_name = 'PostToolUse' }
$runCases = @(
    # speaks once
    @{ id = 'show'; payload = $one; platform = $win; env = (New-RunEnv) }
    @{ id = 'clear'; payload = $post; platform = $win; env = (New-RunEnv) }
    @{ id = 'show-s2'; payload = (New-Ask @((New-Q 'q')) '/work/r' @{ session_id = 'sess-2' }); platform = $win; env = (New-RunEnv) }
    @{ id = 'show-nosession'; payload = @{ hook_event_name = 'PreToolUse'; tool_name = 'AskUserQuestion'; tool_input = @{ questions = @((New-Q 'q')) } }; platform = $win; env = (New-RunEnv) }
    @{ id = 'clear-nosession'; payload = @{ hook_event_name = 'PostToolUse'; tool_name = 'AskUserQuestion' }; platform = $win; env = (New-RunEnv) }
    @{ id = 'show-upper-root'; payload = $one; platform = $win; env = @{ SYSTEMROOT = $rootA; KEEP_ME = 'v1'; Other_Key = 'v2' } }
    # controls for the opt-out cases: same payload, same root, a value that is not an opt-out
    @{ id = 'opt-1-show'; payload = $one; platform = $win; env = (New-RunEnv @{ '@OPT' = '1' }) }
    @{ id = 'opt-yes-post'; payload = $post; platform = $win; env = (New-RunEnv @{ '@OPT' = 'yes' }) }
    @{ id = 'opt-empty-show'; payload = $one; platform = $win; env = (New-RunEnv @{ '@OPT' = '' }) }
    # silent: opted out, with a powershell.exe present, so the opt-out check is the only reason for the silence
    @{ id = 'opt-0'; payload = $one; platform = $win; env = (New-RunEnv @{ '@OPT' = '0' }) }
    @{ id = 'opt-false'; payload = $one; platform = $win; env = (New-RunEnv @{ '@OPT' = 'false' }) }
    @{ id = 'opt-NO'; payload = $one; platform = $win; env = (New-RunEnv @{ '@OPT' = 'NO' }) }
    @{ id = 'opt-off-spaces'; payload = $one; platform = $win; env = (New-RunEnv @{ '@OPT' = ' off ' }) }
    @{ id = 'opt-0-post'; payload = $post; platform = $win; env = (New-RunEnv @{ '@OPT' = '0' }) }
    @{ id = 'opt-off-spaces-post'; payload = $post; platform = $win; env = (New-RunEnv @{ '@OPT' = ' off ' }) }
    # silent: another platform, tool or event, a non-object payload
    @{ id = 'linux'; payload = $one; platform = 'linux'; env = (New-RunEnv) }
    @{ id = 'darwin-post'; payload = $post; platform = 'darwin'; env = (New-RunEnv) }
    @{ id = 'tool-bash'; payload = $bashAsk; platform = $win; env = (New-RunEnv) }
    @{ id = 'tool-bash-post'; payload = $bashPost; platform = $win; env = (New-RunEnv) }
    @{ id = 'event-other'; payload = (New-Ask @((New-Q 'q')) '/work/r' @{ hook_event_name = 'Notification' }); platform = $win; env = (New-RunEnv) }
    @{ id = 'event-failure'; payload = (New-Ask @((New-Q 'q')) '/work/r' @{ hook_event_name = 'PostToolUseFailure' }); platform = $win; env = (New-RunEnv) }
    @{ id = 'event-missing'; payload = @{ tool_name = 'AskUserQuestion'; tool_input = @{ questions = @((New-Q 'q')) } }; platform = $win; env = (New-RunEnv) }
    @{ id = 'payload-string'; payload = 'AskUserQuestion'; platform = $win; env = (New-RunEnv) }
    @{ id = 'payload-null'; payload = $null; platform = $win; env = (New-RunEnv) }
    # silent: no powershell.exe where it is looked for (show and clear)
    @{ id = 'ps-no-file'; payload = $one; platform = $win; env = @{ SystemRoot = $rootEmpty; KEEP_ME = 'v1' } }
    @{ id = 'ps-no-file-post'; payload = $post; platform = $win; env = @{ SystemRoot = $rootEmpty; KEEP_ME = 'v1' } }
    @{ id = 'ps-dir-not-file'; payload = $one; platform = $win; env = @{ SystemRoot = $rootDir; KEEP_ME = 'v1' } }
    @{ id = 'ps-relative'; payload = $one; platform = $win; env = @{ SystemRoot = 'relroot'; KEEP_ME = 'v1' } }
    @{ id = 'ps-missing-root'; payload = $one; platform = $win; env = @{ SystemRoot = (Join-Path $fx 'nope'); KEEP_ME = 'v1' } }
    @{ id = 'ps-unset'; payload = $one; platform = $win; env = @{ KEEP_ME = 'v1' } }
)
# isMain(argv1, url): `url` is the module URL (import.meta.url). The links are made below, before the spec is written.
$hooksReal = $PSScriptRoot
$link = Join-Path $fx 'hooks-link'
$linkType = if ($IsWindows) { 'Junction' } else { 'SymbolicLink' }
$linkMade = $false
try { New-Item -ItemType $linkType -Path $link -Target $hooksReal -ErrorAction Stop | Out-Null; $linkMade = $true }
catch { Write-Host "SKIP [I2 isMain through a $linkType] cannot create it here (reported, not silent): $($_.Exception.Message.Split([char]10)[0])" -ForegroundColor Yellow }
function Remove-HooksLink { if ($linkMade -and (Test-Path -LiteralPath $link)) { try { [IO.Directory]::Delete($link, $false) } catch { Remove-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue } } }
$ismCases = @(
    @{ id = 'own'; argv1 = $hook; urlPath = $hook }
    @{ id = 'other-file'; argv1 = (Join-Path $PSScriptRoot 'hook-lib.mjs'); urlPath = $hook }
    @{ id = 'directory'; argv1 = $PSScriptRoot; urlPath = $hook }
    @{ id = 'missing'; argv1 = (Join-Path $fx 'nope.mjs'); urlPath = $hook }
    @{ id = 'missing-url'; argv1 = $hook; urlPath = (Join-Path $fx 'nope.mjs') }
    @{ id = 'empty'; argv1 = ''; urlPath = $hook }
    @{ id = 'null'; argv1 = $null; urlPath = $hook }
    @{ id = 'default-argv'; useDefault = $true; urlPath = $hook }
    @{ id = 'bad-url'; argv1 = $hook; urlRaw = 'not a url' }
)
if ($linkMade) {
    $ismCases += @(
        @{ id = 'link'; argv1 = (Join-Path $link 'question-notify.mjs'); urlPath = $hook }
        @{ id = 'link-url'; argv1 = $hook; urlPath = (Join-Path $link 'question-notify.mjs') }
        @{ id = 'link-relative'; argv1 = 'hooks-link/question-notify.mjs'; urlPath = $hook }   # the driver's cwd is $fx
        @{ id = 'link-other-file'; argv1 = (Join-Path $link 'hook-lib.mjs'); urlPath = $hook }
    )
}
$spec = @{ notices = $cases; ps = $psCases; opt = $optCases; tags = $tagIn; runs = $runCases; ism = $ismCases }
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $fx 'spec.json'), (ConvertTo-Json -InputObject $spec -Depth 10), $utf8)

$prog = @'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const [modPath, specPath] = process.argv.slice(2)
const m = await import(pathToFileURL(modPath).href)
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
const ascii = s => {
  let o = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    o += c > 126 ? '\\u' + c.toString(16).padStart(4, '0') : s[i]
  }
  return o
}
const notices = spec.notices.map(c => {
  const env = {}
  for (const [k, v] of Object.entries(c.env || {})) env[k === '@OPT' ? m.OPT_OUT : k] = v
  return { id: c.id, r: m.notice(c.payload, env, c.platform) }
})
const mkEnv = c => {
  const env = {}
  for (const [k, v] of Object.entries(c.env || {})) env[k === '@OPT' ? m.OPT_OUT : k] = v
  return env
}
const runs = spec.runs.map(c => {
  const env = mkEnv(c)
  const before = JSON.stringify(Object.keys(env).sort())
  const calls = []
  const fake = (exe, args, options) => { calls.push({ exe, args, options }); return { status: 0 } }
  const r = m.run(c.payload, env, c.platform, fake)
  return {
    id: c.id, n: calls.length, r,
    same: r === null ? null : calls.length === 1 && r.exe === calls[0].exe && r.args === calls[0].args && r.options === calls[0].options,
    parentKeysKept: JSON.stringify(Object.keys(env).sort()) === before,
    parentEnv: Object.keys(env),
    childKeys: r === null ? null : Object.keys(r.options.env),   // JSON drops a key whose value is undefined, so the keys are listed here
    want: m.notice(c.payload, env, c.platform),
  }
})
const ism = spec.ism.map(c => {
  const url = c.urlRaw !== undefined ? c.urlRaw : pathToFileURL(c.urlPath).href
  return { id: c.id, r: c.useDefault ? m.isMain(undefined, url) : m.isMain(c.argv1, url) }
})
const show = m.script('show')
const clear = m.script('clear')
const out = {
  consts: { OPT_OUT: m.OPT_OUT, TITLE_VAR: m.TITLE_VAR, TEXT_VAR: m.TEXT_VAR, TAG_VAR: m.TAG_VAR, GROUP: m.GROUP, APP_ID: m.APP_ID, CHILD_TIMEOUT_MS: m.CHILD_TIMEOUT_MS, CLEAR_AGAIN_S: m.CLEAR_AGAIN_S, TITLE_MAX: m.TITLE_MAX, TEXT_MAX: m.TEXT_MAX },
  types: { run: typeof m.run, isMain: typeof m.isMain, script: typeof m.script },
  runs, ism,
  hasRemovedExports: ['HOLD_S', 'storePwsh'].filter(k => k in m),
  opt: spec.opt.map(v => m.optedOut(v)),
  notices,
  tags: spec.tags.map(v => m.tagOf(v)),
  show, clear,
  showAfter: m.script('show'),
  clearAfter: m.script('clear'),
  encodedShow: m.encoded(show),
  encodedClear: m.encoded(clear),
  encodedText: m.encoded('héllo'),
  ps: spec.ps.map(c => ({ id: c.id, r: m.powershellExe(c.env) })),
}
process.stdout.write(ascii(JSON.stringify(out)))
'@
$progPath = Join-Path $fx 'drive.mjs'
[IO.File]::WriteAllText($progPath, $prog, $utf8)

$run = Invoke-Node @($progPath, $hook, (Join-Path $fx 'spec.json'))
$pure = $null
try { $pure = $run.Out | ConvertFrom-Json } catch { }
Add-Case 'P0 the pure half loads and answers (importing the file runs no hook body)' @(
    if ($run.TimedOut) { 'node timed out: importing the file may have run the hook body and waited on stdin' }
    if ($run.Exit -ne 0) { "node exit $($run.Exit): $($run.Err.Trim())" }
    if (-not $pure) { 'stdout is not JSON' }
)
if (-not $pure) { Remove-HooksLink; Remove-FixtureRoot $fx; Write-Host 'question-notify selftest: FAILED' -ForegroundColor Red; exit 1 }

$res = @{}
foreach ($x in $pure.notices) { $res[$x.id] = $x.r }
function Assert-Silent([string]$Name, [string[]]$Ids) {
    Add-Case $Name @(foreach ($i in $Ids) { if ($null -ne $res[$i]) { "$i returned a result, want null" } })
}
function Assert-Action([string]$Name, [string]$Action, [string[]]$Ids) {
    Add-Case $Name @(foreach ($i in $Ids) {
            if ($null -eq $res[$i]) { "$i returned null, want action '$Action'" }
            elseif ($res[$i].action -cne $Action) { "$i action '$($res[$i].action)', want '$Action'" }
        })
}
function Assert-Equal([string]$Name, [hashtable]$Want) {
    # $Want: id -> @{ field = exact value, ... }; case-sensitive
    Add-Case $Name @(foreach ($i in $Want.Keys) {
            $r = $res[$i]
            if ($null -eq $r) { "$i returned null"; continue }
            foreach ($f in $Want[$i].Keys) {
                if ($r.$f -cne $Want[$i][$f]) { "$i ${f}: got '$($r.$f)', want '$($Want[$i][$f])'" }
            }
        })
}

# C1. constants: the names a member's settings and the child's script rely on, and the platform's limits
$c = $pure.consts
Add-Case 'C1 constants: opt-out and handoff variable names, child timeout below the hook timeout and above the clear wait, CLEAR_AGAIN_S 3, text limits; run, isMain and script are functions; storePwsh and HOLD_S are gone' @(
    if ($c.OPT_OUT -cne 'YWR_HARNESS_QUESTION_NOTIFY') { "OPT_OUT '$($c.OPT_OUT)'" }
    if ($c.TITLE_VAR -cne 'YWR_HARNESS_NOTIFY_TITLE') { "TITLE_VAR '$($c.TITLE_VAR)'" }
    if ($c.TEXT_VAR -cne 'YWR_HARNESS_NOTIFY_TEXT') { "TEXT_VAR '$($c.TEXT_VAR)'" }
    if ($c.TAG_VAR -cne 'YWR_HARNESS_NOTIFY_TAG') { "TAG_VAR '$($c.TAG_VAR)'" }
    if ($null -eq $c.CHILD_TIMEOUT_MS -or [int64]$c.CHILD_TIMEOUT_MS -lt 1000 -or [int64]$c.CHILD_TIMEOUT_MS -ge 10000) { "CHILD_TIMEOUT_MS '$($c.CHILD_TIMEOUT_MS)' (want 1000..9999 ms: under the 10 s hook timeout)" }
    if ($null -eq $c.CLEAR_AGAIN_S -or [int64]$c.CLEAR_AGAIN_S -ne 3) { "CLEAR_AGAIN_S '$($c.CLEAR_AGAIN_S)' (want 3)" }
    elseif ($null -ne $c.CHILD_TIMEOUT_MS -and [int64]$c.CHILD_TIMEOUT_MS -lt ([int64]$c.CLEAR_AGAIN_S * 1000 + 2000)) { "CHILD_TIMEOUT_MS $($c.CHILD_TIMEOUT_MS) leaves under 2 s beyond the $($c.CLEAR_AGAIN_S) s clear wait (the timeout would kill the second removal)" }
    foreach ($fn in @('run', 'isMain', 'script')) { if ($pure.types.$fn -cne 'function') { "export $fn is '$($pure.types.$fn)', want function" } }
    if (-not $c.GROUP) { 'GROUP is empty' }
    if (-not $c.APP_ID) { 'APP_ID is empty' }
    if ($c.TITLE_MAX -ne 63) { "TITLE_MAX $($c.TITLE_MAX) (the title is kept at 63)" }
    if ($c.TEXT_MAX -ne 255) { "TEXT_MAX $($c.TEXT_MAX) (the text is kept at 255)" }
    if (@($pure.hasRemovedExports).Count) { "still exports: $(@($pure.hasRemovedExports) -join ', ')" }
)

# O1. optedOut by value
$optWant = @($true, $true, $true, $true, $true, $true, $false, $false, $false, $false, $false, $false, $false)
Add-Case 'O1 optedOut: 0/false/NO/" off "/Off/no yes; 1/yes/empty/maybe/00/falsey/null no' @(
    for ($i = 0; $i -lt $optCases.Count; $i++) { if ([bool]$pure.opt[$i] -ne $optWant[$i]) { "optedOut('$($optCases[$i])') = $($pure.opt[$i]), want $($optWant[$i])" } }
)

# N. silent, show and clear
Assert-Silent 'N1 notice is null on platform linux and darwin, for PreToolUse and PostToolUse' @('linux', 'darwin', 'linux-post')
Assert-Silent 'N2 notice is null for opt-out 0, false, NO, " off ", on both events' @('opt-0', 'opt-false', 'opt-NO', 'opt-off-spaces', 'opt-off-post')
Assert-Silent 'N3 notice is null for another event (Notification, PostToolUseFailure), a missing event, another tool, a missing tool' @('event-other', 'event-failure', 'event-missing', 'tool-bash', 'tool-bash-post', 'tool-missing')
Assert-Silent 'N4 notice is null for a non-object payload: string, number, array, boolean, null' @('payload-string', 'payload-number', 'payload-array', 'payload-bool', 'payload-null')
Assert-Action 'N5 PreToolUse gives action show, not opted out by 1, yes, empty, unset, or another variable set to 0' 'show' @('opt-1', 'opt-yes', 'opt-empty', 'opt-unset', 'opt-other-var', 'show-s1')
Assert-Action 'N6 event names match case-insensitively (pretooluse shows, posttooluse clears)' 'show' @('event-lowercase')
Assert-Action 'N6b posttooluse clears' 'clear' @('event-lowercase-post')
Assert-Action 'N7 PostToolUse gives action clear, with or without a response or session' 'clear' @('clear-s1', 'clear-s2', 'clear-nosession', 'clear-bare')
Add-Case 'N8 a clear result is exactly {action, tag}: no title or text' @(
    foreach ($i in @('clear-s1', 'clear-nosession')) {
        $names = @($res[$i].PSObject.Properties.Name | Sort-Object)
        if (($names -join ',') -ne 'action,tag') { "$i properties: $($names -join ',')" }
    }
)

# K. tags
function Get-ExpectedTag([string]$S) { 'q-' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($S))).ToLowerInvariant().Substring(0, 16) }
Add-Case 'K1 tagOf: "q" for empty or null, else "q-" + 16 lowercase hex of SHA-256 of the session id' @(
    if ($pure.tags[0] -cne 'q') { "tagOf('') = '$($pure.tags[0])'" }
    if ($pure.tags[1] -cne 'q') { "tagOf(null) = '$($pure.tags[1])'" }
    if ($pure.tags[2] -cne (Get-ExpectedTag 'abc')) { "tagOf('abc') = '$($pure.tags[2])', want $(Get-ExpectedTag 'abc')" }
    if ($pure.tags[4] -cne (Get-ExpectedTag 'sess-1')) { "tagOf('sess-1') = '$($pure.tags[4])'" }
    if ($pure.tags[2] -cnotmatch '^q-[0-9a-f]{16}$') { "tag shape '$($pure.tags[2])'" }
    if ($pure.tags[2] -ceq $pure.tags[3]) { "two session ids share tag '$($pure.tags[2])'" }
)
Add-Case 'K2 notice tags: show and clear of one session share a tag; two sessions differ; no session_id gives "q"' @(
    if ($res['show-s1'].tag -cne $res['clear-s1'].tag) { 'show and clear of sess-1 differ' }
    if ($res['show-s2'].tag -cne $res['clear-s2'].tag) { 'show and clear of sess-2 differ' }
    if ($res['show-s1'].tag -ceq $res['show-s2'].tag) { 'sess-1 and sess-2 share a tag' }
    if ($res['show-s1'].tag -cne $pure.tags[4]) { 'notice tag is not tagOf(session_id)' }
    if ($res['show-nosession'].tag -cne 'q') { "show without session_id: tag '$($res['show-nosession'].tag)'" }
    if ($res['clear-nosession'].tag -cne 'q') { "clear without session_id: tag '$($res['clear-nosession'].tag)'" }
)

# T. title
$titleBase = "Claude Code 질문"
Assert-Equal 'T1 title is the fixed prefix plus the cwd basename' @{ 'title-basename' = @{ title = "$titleBase · demo-repo" } }
Assert-Equal 'T2 no basename: no separator when cwd is missing, empty or a root' @{
    'title-no-cwd' = @{ title = $titleBase }; 'title-empty-cwd' = @{ title = $titleBase }; 'title-root-cwd' = @{ title = $titleBase } }
Assert-Equal 'T3 a 100-char basename is capped at 30 with an ellipsis, so the title stays within the limit' @{
    'title-long-cwd' = @{ title = "$titleBase · $('x' * 29)$ell" } }
Assert-Equal 'T4 a backtick in the basename flattens to a space' @{ 'title-flat-cwd' = @{ title = "$titleBase · p q" } }

# X. text
Assert-Equal 'X1 text is "[header] question"; no brackets without a header' @{
    'text-header' = @{ text = '[Scope] Which one?' }; 'text-no-header' = @{ text = 'Which one?' } }
Assert-Equal 'X2 text adds (+N) for N more questions' @{
    'text-more-1' = @{ text = '[Scope] Which one? (+1)' }; 'text-more-2' = @{ text = '[Scope] Which one? (+2)' } }
$fallback = '답을 기다립니다.'
Assert-Equal 'X3 an empty question, no questions, no tool_input or a non-array list gives the fallback text' @{
    'text-empty-question' = @{ text = "[Scope] $fallback" }; 'text-empty-question-no-header' = @{ text = $fallback }
    'text-no-questions' = @{ text = $fallback }; 'text-no-tool-input' = @{ text = $fallback }; 'text-questions-not-array' = @{ text = $fallback } }
Assert-Equal 'X4 the first object entry is read, and (+N) counts object entries only' @{ 'text-first-object' = @{ text = 'Q' } }
Assert-Equal 'X5 a 500-char question is capped at 200 (199 + an ellipsis); a 100-char header at 30' @{
    'text-long' = @{ text = "[Scope] $('a' * 199)$ell" }; 'text-long-header' = @{ text = "[$('H' * 29)$ell] Q" } }
Assert-Equal 'X6 control chars, backtick, U+2028, U+2029, U+0085, NUL and DEL each become one space (question and header)' @{
    'text-flat' = @{ text = $flatWant }; 'text-flat-header' = @{ text = "[$flatWant] Q" } }

# G1. every show result: title within TITLE_MAX, text within TEXT_MAX, no flattened-class char
$gFails = @()
foreach ($x in $pure.notices) {
    if ($null -eq $x.r -or $x.r.action -cne 'show') { continue }
    if ($x.r.title.Length -gt $c.TITLE_MAX) { $gFails += "$($x.id) title is $($x.r.title.Length) chars" }
    if ($x.r.text.Length -gt $c.TEXT_MAX) { $gFails += "$($x.id) text is $($x.r.text.Length) chars" }
    foreach ($f in @('title', 'text')) {
        foreach ($ch in $x.r.$f.ToCharArray()) {
            $n = [int]$ch
            if ($n -le 0x1f -or $n -eq 0x7f -or $n -eq 0x85 -or $n -eq 0x2028 -or $n -eq 0x2029 -or $n -eq 0x60) { $gFails += "$($x.id) $f carries U+$('{0:X4}' -f $n)"; break }
        }
    }
}
Add-Case 'G1 every show result: title <= TITLE_MAX, text <= TEXT_MAX, no control, line-break or backtick char' $gFails

# S. the child's scripts and their encoding
function Get-ScriptFacts([string]$Text) {
    $errs = $null
    [void][Management.Automation.Language.Parser]::ParseInput($Text, [ref]$null, [ref]$errs)
    return @{ Refs = @([regex]::Matches($Text, '\$env:[A-Za-z0-9_]+') | ForEach-Object { $_.Value } | Sort-Object -Unique); Errors = @($errs | Where-Object { $_ }) }
}
$showS = [string]$pure.show; $clearS = [string]$pure.clear
$sf = Get-ScriptFacts $showS; $cf = Get-ScriptFacts $clearS
$wantShowRefs = @("`$env:$($c.TAG_VAR)", "`$env:$($c.TEXT_VAR)", "`$env:$($c.TITLE_VAR)") | Sort-Object
$wantClearRefs = @("`$env:$($c.TAG_VAR)")
Add-Case 'S1 script(show): reads title, text and tag from $env: only; XML-escapes them; scenario reminder, system dismiss; parses' @(
    if (($sf.Refs -join ',') -cne ($wantShowRefs -join ',')) { "env refs: $($sf.Refs -join ', ')" }
    if (-not $showS.Contains('scenario=""reminder""')) { 'no scenario=""reminder""' }
    if (-not $showS.Contains('activationType=""system""')) { 'no activationType=""system""' }
    if ($showS -cnotmatch 'SecurityElement\]::Escape\(\[string\]\$env:' + $c.TITLE_VAR) { 'title is not XML-escaped from the environment' }
    if ($showS -cnotmatch 'SecurityElement\]::Escape\(\[string\]\$env:' + $c.TEXT_VAR) { 'text is not XML-escaped from the environment' }
    if (-not $showS.Contains($c.APP_ID)) { 'show does not use APP_ID' }
    if (-not $showS.Contains($c.GROUP)) { 'show does not set the GROUP' }
    if ($showS.Contains('History.Remove')) { 'show carries History.Remove' }
    foreach ($e in $sf.Errors) { "show script does not parse: $($e.Message)" }
)
Add-Case 'S2 script(clear): reads the tag from $env: only, calls History.Remove with tag, group and app id; no toast XML; parses' @(
    if (($cf.Refs -join ',') -cne ($wantClearRefs -join ',')) { "env refs: $($cf.Refs -join ', ')" }
    if (-not $clearS.Contains('History.Remove')) { 'no History.Remove call' }
    if (-not $clearS.Contains($c.APP_ID)) { 'clear does not use APP_ID' }
    if (-not $clearS.Contains($c.GROUP)) { 'clear does not use the GROUP' }
    if ($clearS -match 'scenario|LoadXml|CreateToastNotifier') { 'clear carries toast-show code' }
    foreach ($e in $cf.Errors) { "clear script does not parse: $($e.Message)" }
)
# S2b. a PostToolUse that comes before the show child has shown its toast would leave that toast: the clear child
#      removes the tag, waits CLEAR_AGAIN_S, and removes it again (and the show script waits for nothing)
$rm1 = $clearS.IndexOf('History.Remove'); $rm2 = if ($rm1 -ge 0) { $clearS.IndexOf('History.Remove', $rm1 + 1) } else { -1 }
$slp = $clearS.IndexOf('Start-Sleep -Seconds 3')
Add-Case 'S2b script(clear) removes twice with Start-Sleep -Seconds 3 between the removals (CLEAR_AGAIN_S); script(show) never sleeps' @(
    $nRem = ([regex]::Matches($clearS, 'History\.Remove')).Count
    if ($nRem -ne 2) { "clear holds $nRem History.Remove (want 2)" }
    $nSlp = ([regex]::Matches($clearS, 'Start-Sleep')).Count
    if ($nSlp -ne 1) { "clear holds $nSlp Start-Sleep (want 1)" }
    if ($slp -lt 0) { 'clear has no "Start-Sleep -Seconds 3"' }
    elseif (-not ($rm1 -ge 0 -and $rm1 -lt $slp -and $slp -lt $rm2)) { "order is not Remove, Sleep, Remove (remove at $rm1, sleep at $slp, remove at $rm2)" }
    if ($clearS -cnotmatch "Start-Sleep -Seconds $($c.CLEAR_AGAIN_S)(\r?\n|$)") { 'the sleep does not equal CLEAR_AGAIN_S' }
    if ($showS -match 'Start-Sleep') { 'show carries Start-Sleep' }
)
Add-Case 'S3 both scripts are ASCII, hold no payload text, and do not depend on a payload (two calls equal)' @(
    foreach ($pair in @(@('show', $showS, [string]$pure.showAfter), @('clear', $clearS, [string]$pure.clearAfter))) {
        if ($pair[1] -cne $pair[2]) { "script($($pair[0])) differs between two calls" }
        if ($pair[1] -match '[^\x00-\x7f]') { "script($($pair[0])) carries a non-ASCII character" }
        foreach ($bad in @('Which one', 'Scope', 'demo-repo', 'sess-1')) { if ($pair[1].Contains($bad)) { "script($($pair[0])) contains fixture text '$bad'" } }
    }
    if ($showS -ceq $clearS) { 'show and clear scripts are identical' }
)
$decShow = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([string]$pure.encodedShow))
$decClear = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([string]$pure.encodedClear))
$decText = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([string]$pure.encodedText))
Add-Case 'S4 encoded(text) is base64 of UTF-16LE: it decodes back to script(show), script(clear) and non-ASCII text; a command line stays short' @(
    if ($decShow -cne $showS) { 'decode of encoded(script(show)) differs' }
    if ($decClear -cne $clearS) { 'decode of encoded(script(clear)) differs' }
    if ($decText -cne ('h' + [char]0xe9 + 'llo')) { "encoded('h?llo') decodes to '$decText'" }
    if (([string]$pure.encodedShow).Length -gt 8000) { "encoded(show) is $(([string]$pure.encodedShow).Length) chars (a command line holds 32767; keep well under)" }
)

# W. powershellExe
$pres = @{}
foreach ($x in $pure.ps) { $pres[$x.id] = [string]$x.r }
function Test-SamePath([string]$A, [string]$B) { return ($A -and $B -and ([IO.Path]::GetFullPath($A) -ieq [IO.Path]::GetFullPath($B))) }
$wantPs = Join-Path $rootA $psRel
Add-Case 'W1 powershellExe: System32\WindowsPowerShell\v1.0\powershell.exe under an absolute SystemRoot; SYSTEMROOT works; edge spaces trimmed' @(
    foreach ($i in @('ps-found', 'ps-found-upper-key', 'ps-found-padded')) { if (-not (Test-SamePath $pres[$i] $wantPs)) { "${i}: '$($pres[$i])' (want $wantPs)" } }
)
Add-Case 'W2 powershellExe is empty for a relative SystemRoot (even one holding the file), a missing root, no file, a directory named powershell.exe, empty and unset' @(
    foreach ($i in @('ps-relative', 'ps-missing', 'ps-no-file', 'ps-dir-not-file', 'ps-empty', 'ps-unset')) { if ($pres[$i] -ne '') { "${i}: '$($pres[$i])'" } }
)

# N. run(payload, env, platform, spawnFn): the wiring from the action to the one spawn call, through a FAKE spawnFn
$rr = @{}
foreach ($x in $pure.runs) { $rr[$x.id] = $x }
$wantArgsHead = @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand')
function Get-RunFails([string]$Id, [string]$Action) {
    $x = $rr[$Id]
    $f = @()
    if ($null -eq $x) { return @("$Id missing from the driver output") }
    if ($x.n -ne 1) { return @("$Id called the fake spawn $($x.n) times (want 1)") }
    if ($null -eq $x.r) { return @("$Id returned null (want the spawn call)") }
    if ($x.same -ne $true) { $f += "$Id returned something other than what the fake spawn received" }
    if (-not $x.parentKeysKept) { $f += "$Id changed the caller's env object" }
    $r = $x.r
    if (-not (Test-SamePath ([string]$r.exe) $wantPs)) { $f += "$Id exe '$($r.exe)' (want $wantPs)" }
    $a = @($r.args | ForEach-Object { [string]$_ })
    if ($a.Count -ne 6) { $f += "$Id args count $($a.Count) (want 6)" }
    elseif ((($a[0..4]) -join "`0") -cne ($wantArgsHead -join "`0")) { $f += "$Id args [$($a[0..4] -join ' ')] (want [$($wantArgsHead -join ' ')])" }
    else {
        $dec = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($a[5]))
        $wantScript = if ($Action -eq 'show') { $showS } else { $clearS }
        if ($dec -cne $wantScript) { $f += "$Id -EncodedCommand decodes to something other than script('$Action')" }
    }
    $o = $r.options
    if ($o.stdio -cne 'ignore') { $f += "$Id stdio '$($o.stdio)' (want ignore)" }
    if ($o.windowsHide -isnot [bool] -or $o.windowsHide -ne $true) { $f += "$Id windowsHide '$($o.windowsHide)' (want true)" }
    if ([int64]$o.timeout -ne [int64]$c.CHILD_TIMEOUT_MS) { $f += "$Id timeout '$($o.timeout)' (want CHILD_TIMEOUT_MS $($c.CHILD_TIMEOUT_MS))" }
    $w = $x.want
    if ($null -eq $w -or $w.action -cne $Action) { $f += "$Id notice() action is not '$Action'" }
    else {
        $names = @($x.childKeys)
        $addedWant = if ($Action -eq 'show') { @($c.TAG_VAR, $c.TITLE_VAR, $c.TEXT_VAR) } else { @($c.TAG_VAR) }
        $wantKeys = @(@($x.parentEnv) + $addedWant) | Sort-Object -CaseSensitive
        if ((@($names | Sort-Object -CaseSensitive) -join ',') -cne ($wantKeys -join ',')) { $f += "$Id child env keys [$(@($names | Sort-Object -CaseSensitive) -join ',')] (want [$($wantKeys -join ',')])" }
        if ([string]$o.env.($c.TAG_VAR) -cne [string]$w.tag) { $f += "$Id TAG '$($o.env.($c.TAG_VAR))' (want '$($w.tag)')" }
        if ($Action -eq 'show') {
            if ([string]$o.env.($c.TITLE_VAR) -cne [string]$w.title) { $f += "$Id TITLE '$($o.env.($c.TITLE_VAR))' (want '$($w.title)')" }
            if ([string]$o.env.($c.TEXT_VAR) -cne [string]$w.text) { $f += "$Id TEXT '$($o.env.($c.TEXT_VAR))' (want '$($w.text)')" }
        }
        elseif ($names -contains $c.TITLE_VAR -or $names -contains $c.TEXT_VAR) { $f += "$Id (clear) carries a TITLE or TEXT key" }
        if ([string]$o.env.KEEP_ME -cne 'v1') { $f += "$Id parent key KEEP_ME did not reach the child ('$($o.env.KEEP_ME)')" }
        if ($x.parentEnv -contains 'Other_Key' -and [string]$o.env.Other_Key -cne 'v2') { $f += "$Id parent key Other_Key did not reach the child ('$($o.env.Other_Key)')" }
    }
    return $f
}
Add-Case 'RN1 run(PreToolUse): the fake spawn is called once with powershell.exe under SystemRoot, [-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand <script(show)>], stdio ignore, windowsHide, CHILD_TIMEOUT_MS, and an env of the parent plus TITLE, TEXT and TAG equal to notice()' @(
    foreach ($i in @('show', 'show-s2', 'show-nosession', 'show-upper-root', 'opt-1-show', 'opt-empty-show')) { Get-RunFails $i 'show' }
)
Add-Case 'RN2 run(PostToolUse): the fake spawn is called once with script(clear), TAG equal to notice() and no TITLE or TEXT key added; the parent keys come through' @(
    foreach ($i in @('clear', 'clear-nosession', 'opt-yes-post')) { Get-RunFails $i 'clear' }
)
Add-Case 'RN3 run: two sessions get two tags in the child env; show and clear of one session get the same tag' @(
    if ($rr['show'].r.options.env.($c.TAG_VAR) -ceq $rr['show-s2'].r.options.env.($c.TAG_VAR)) { 'sess-1 and sess-2 share a tag in the child env' }
    if ($rr['show'].r.options.env.($c.TAG_VAR) -cne $rr['clear'].r.options.env.($c.TAG_VAR)) { 'show and clear of sess-1 differ in the child env' }
    if ($rr['show-nosession'].r.options.env.($c.TAG_VAR) -cne 'q') { 'no session_id: TAG is not q' }
)
$runSilent = @('opt-0', 'opt-false', 'opt-NO', 'opt-off-spaces', 'opt-0-post', 'opt-off-spaces-post', 'linux', 'darwin-post', 'tool-bash', 'tool-bash-post', 'event-other', 'event-failure', 'event-missing', 'payload-string', 'payload-null', 'ps-no-file', 'ps-no-file-post', 'ps-dir-not-file', 'ps-relative', 'ps-missing-root', 'ps-unset')
function Assert-RunSilent([string]$Name, [string[]]$Ids) {
    Add-Case $Name @(foreach ($i in $Ids) {
            $x = $rr[$i]
            if ($null -eq $x) { "$i missing from the driver output"; continue }
            if ($x.n -ne 0) { "$i called the fake spawn $($x.n) times (want 0)" }
            if ($null -ne $x.r) { "$i returned a spawn call, want null" }
        })
}
Assert-RunSilent 'RN4 run: opt-out 0, false, NO, " off " on both events starts nothing although a powershell.exe is present (the controls opt-1, opt-yes, opt-empty in RN1 and RN2 start it)' @('opt-0', 'opt-false', 'opt-NO', 'opt-off-spaces', 'opt-0-post', 'opt-off-spaces-post')
Assert-RunSilent 'RN5 run: platform linux and darwin, another tool, another event, a missing event, a non-object payload start nothing although a powershell.exe is present' @('linux', 'darwin-post', 'tool-bash', 'tool-bash-post', 'event-other', 'event-failure', 'event-missing', 'payload-string', 'payload-null')
Assert-RunSilent 'RN6 run: no powershell.exe under SystemRoot (no file, a directory, a relative root, a missing root, no SystemRoot) starts nothing, for show and clear' @('ps-no-file', 'ps-no-file-post', 'ps-dir-not-file', 'ps-relative', 'ps-missing-root', 'ps-unset')
Add-Case 'RN7 the RN4 to RN6 case list is the whole silent list of the driver (a case added to the spec without an assertion fails here)' @(
    $inSpec = @($pure.runs | Where-Object { $null -eq $_.r } | ForEach-Object { $_.id } | Sort-Object)
    $listed = @($runSilent | Sort-Object)
    if (($inSpec -join ',') -cne ($listed -join ',')) { "silent in the driver: [$($inSpec -join ',')], asserted: [$($listed -join ',')]" }
    $speaks = @($pure.runs | Where-Object { $null -ne $_.r } | ForEach-Object { $_.id } | Sort-Object)
    $asserted = @(@('show', 'show-s2', 'show-nosession', 'show-upper-root', 'opt-1-show', 'opt-empty-show', 'clear', 'clear-nosession', 'opt-yes-post') | Sort-Object)
    if (($speaks -join ',') -cne ($asserted -join ',')) { "speaking in the driver: [$($speaks -join ',')], asserted: [$($asserted -join ',')]" }
)

# I. isMain: the hook runs only when node runs this file itself, also through a directory link
$ism = @{}
foreach ($x in $pure.ism) { $ism[$x.id] = $x.r }
Add-Case 'I1 isMain: true for the module path; false for another file, a directory, a missing path, a missing module URL, an empty or null path, the default argv (the driver script), a malformed URL' @(
    if ($ism['own'] -ne $true) { 'own path: not true' }
    foreach ($i in @('other-file', 'directory', 'missing', 'missing-url', 'empty', 'null', 'default-argv', 'bad-url')) { if ($ism[$i] -ne $false) { "${i}: $($ism[$i]) (want false)" } }
)
if ($linkMade) {
    Add-Case "I2 isMain through a $linkType to the hooks directory: true by the link path (absolute and relative) and with the link on the URL side; false for another file behind the link" @(
        foreach ($i in @('link', 'link-url', 'link-relative')) { if ($ism[$i] -ne $true) { "${i}: $($ism[$i]) (want true)" } }
        if ($ism['link-other-file'] -ne $false) { "link-other-file: $($ism['link-other-file']) (want false)" }
    )
}

# ---------------------------------------------------------------------------------------------------
# E. The hook as a child process, with the preload (see the header): SystemRoot is set to a temp dir inside every
#    child, and `spawnSync` is a stub that logs. Each case must exit 0 with EMPTY stdout and log the wanted number
#    of spawn calls. `$rootEmpty` has no powershell.exe: `powershellExe` returns '' and nothing reaches the stub.
#    `$rootA` holds a plain file there: the hook reaches the stub, which starts nothing.
$preload = Join-Path $fx 'preload.mjs'
$preloadSrc = @'
import cp from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
for (const k of ['SystemRoot', 'SYSTEMROOT']) process.env[k] = process.env.YWR_SELFTEST_ROOT
// the hook is silent off Windows, so a Linux or macOS run of these cases states the platform it tests
Object.defineProperty(process, 'platform', { value: 'win32' })
// the stub starts nothing: it appends one JSON line per call to the log and answers like a clean exit
cp.spawnSync = (exe, args, options) => {
  const log = process.env.YWR_SELFTEST_CALL_LOG
  const env = (options && options.env) || {}
  if (log) fs.appendFileSync(log, JSON.stringify({ exe, args, timeout: options && options.timeout, stdio: options && options.stdio, windowsHide: options && options.windowsHide, tag: env.YWR_HARNESS_NOTIFY_TAG }) + '\n')
  return { status: 0 }
}
syncBuiltinESMExports()
'@
[IO.File]::WriteAllText($preload, $preloadSrc, $utf8)
$preloadArgs = @('--import', [Uri]::new($preload).AbsoluteUri, $hook)
$linkHook = Join-Path $link 'question-notify.mjs'
$linkArgs = @('--import', [Uri]::new($preload).AbsoluteUri, $linkHook)
$askJson = ConvertTo-Json -InputObject $one -Depth 10 -Compress
$postJson = ConvertTo-Json -InputObject $post -Depth 10 -Compress
$otherJson = ConvertTo-Json -InputObject (New-Ask @((New-Q 'q')) '/work/r' @{ tool_name = 'Bash' }) -Depth 10 -Compress
$otherPostJson = ConvertTo-Json -InputObject (New-Ask @((New-Q 'q')) '/work/r' @{ tool_name = 'Bash'; hook_event_name = 'PostToolUse' }) -Depth 10 -Compress
# One hook child: exit 0, empty stdout, and exactly $WantCalls spawn calls in the stub's log. Returns the calls.
function Invoke-HookCase([string]$Name, [string]$Stdin, [string]$Root, [int]$WantCalls, [hashtable]$ExtraEnv = @{}, [string[]]$NodeArgs = $preloadArgs, [scriptblock]$Check = $null) {
    $log = Join-Path $fx "calls-$([guid]::NewGuid().ToString('N')).log"
    $e = @{ YWR_SELFTEST_ROOT = $Root; YWR_SELFTEST_CALL_LOG = $log }
    foreach ($k in $ExtraEnv.Keys) { $e[$k] = $ExtraEnv[$k] }
    $r = Invoke-Node $NodeArgs $Stdin $e
    $calls = @(if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Encoding utf8 | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json } })
    Add-Case $Name @(
        if ($r.TimedOut) { 'hook did not end within 20 s' }
        if ($r.Exit -ne 0) { "exit $($r.Exit) (want 0 - fail-open contract): $($r.Err.Trim())" }
        if ($r.Out) { "stdout not empty: '$($r.Out.Trim())'" }
        if ($calls.Count -ne $WantCalls) { "$($calls.Count) spawn calls logged (want $WantCalls)" }
        if ($Check -and $calls.Count -eq $WantCalls) { & $Check $calls }
    )
}
function Assert-HookSilent([string]$Name, [string]$Stdin, [hashtable]$ExtraEnv = @{}, [string]$Root = $rootEmpty) {
    Invoke-HookCase $Name $Stdin $Root 0 $ExtraEnv
}
Assert-HookSilent 'E1 a valid PreToolUse AskUserQuestion payload, no powershell.exe under SystemRoot: exit 0, empty stdout, nothing reaches the spawn' $askJson
Assert-HookSilent 'E2 a valid PostToolUse AskUserQuestion payload, no powershell.exe under SystemRoot: exit 0, empty stdout, nothing reaches the spawn' $postJson
Assert-HookSilent 'E3 a non-AskUserQuestion PreToolUse payload, no powershell.exe: exit 0, empty stdout' $otherJson
Assert-HookSilent 'E3b a non-AskUserQuestion PostToolUse payload, no powershell.exe: exit 0, empty stdout' $otherPostJson
# From here the root holds a powershell.exe, so the only reason for a silence is the check under test.
Assert-HookSilent 'E3c a non-AskUserQuestion payload (Pre and Post) with a powershell.exe present: exit 0, empty stdout, no spawn call' $otherJson @{} $rootA
Assert-HookSilent 'E4 an opted-out PreToolUse payload with a powershell.exe present (opt-out in the child only): exit 0, empty stdout, NO spawn call' $askJson @{ YWR_HARNESS_QUESTION_NOTIFY = 'off' } $rootA
Assert-HookSilent 'E4b an opted-out PostToolUse payload with a powershell.exe present: exit 0, empty stdout, NO spawn call' $postJson @{ YWR_HARNESS_QUESTION_NOTIFY = 'NO' } $rootA
Assert-HookSilent 'E5 malformed stdin with a powershell.exe present: exit 0, empty stdout, no spawn call' 'not json at all {{{' @{} $rootA
Assert-HookSilent 'E6 empty stdin with a powershell.exe present: exit 0, empty stdout, no spawn call' '' @{} $rootA
$wantTagS1 = 'q-' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes('sess-1'))).ToLowerInvariant().Substring(0, 16)
function Get-SpawnFails($Call, [string]$Action) {
    $a = @($Call.args | ForEach-Object { [string]$_ })
    if (-not (Test-SamePath ([string]$Call.exe) $wantPs)) { "exe '$($Call.exe)' (want $wantPs)" }
    if ($a.Count -ne 6 -or (($a[0..4]) -join "`0") -cne ($wantArgsHead -join "`0")) { "args [$($a -join ' ')]" }
    else {
        $dec = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($a[5]))
        if ($dec -cne $(if ($Action -eq 'show') { $showS } else { $clearS })) { "-EncodedCommand is not script('$Action')" }
    }
    if ([int64]$Call.timeout -ne [int64]$c.CHILD_TIMEOUT_MS -or $Call.stdio -cne 'ignore' -or $Call.windowsHide -ne $true) { "options: timeout $($Call.timeout), stdio $($Call.stdio), windowsHide $($Call.windowsHide)" }
    if ([string]$Call.tag -cne $wantTagS1) { "TAG '$($Call.tag)' (want $wantTagS1)" }
}
Invoke-HookCase 'E8 a PreToolUse payload with a powershell.exe present: exit 0, empty stdout, ONE spawn call, with script(show) and the session tag (the hook entry: stdin, isMain, run)' $askJson $rootA 1 @{} $preloadArgs { param($calls) Get-SpawnFails $calls[0] 'show' }
Invoke-HookCase 'E8b a PostToolUse payload with a powershell.exe present: exit 0, empty stdout, ONE spawn call, with script(clear) and the session tag' $postJson $rootA 1 @{} $preloadArgs { param($calls) Get-SpawnFails $calls[0] 'clear' }
Invoke-HookCase 'E8c an opt-out value that is not one (1) with a powershell.exe present: ONE spawn call (the control for E4: the same setup speaks)' $askJson $rootA 1 @{ YWR_HARNESS_QUESTION_NOTIFY = '1' } $preloadArgs { param($calls) Get-SpawnFails $calls[0] 'show' }
if ($linkMade) {
    Invoke-HookCase "E9 the hook launched through a $linkType to the hooks directory still runs as the main module: ONE spawn call" $askJson $rootA 1 @{} $linkArgs { param($calls) Get-SpawnFails $calls[0] 'show' }
}
Remove-HooksLink
Add-Case 'E7 the child setup left this process environment alone' @(
    if ($env:SystemRoot -and ($env:SystemRoot -ieq $rootEmpty -or $env:SystemRoot -ieq $rootA)) { 'parent SystemRoot is a temp dir of the suite' }
    if ($env:YWR_SELFTEST_ROOT -or $env:YWR_SELFTEST_CALL_LOG) { 'parent carries a preload variable' }
    if ($env:YWR_HARNESS_QUESTION_NOTIFY -match '^(off|NO|1)$') { 'parent carries an opt-out value a child received' }
)

Remove-FixtureRoot $fx

# META — the comparison helper must be able to fail: a wrong expectation is reported, not absorbed.
$res['meta'] = @{ title = 'x'; text = 'y' }
$probeOk = $script:ok
$script:ok = $true
Assert-Equal 'META probe (must FAIL)' @{ meta = @{ text = 'z' } } 6>$null
$metaAccepted = $script:ok
$script:ok = $probeOk
if ($metaAccepted) { Write-Host 'FAIL [META]: Assert-Equal accepted a wrong expectation' -ForegroundColor Red; $script:ok = $false }
else { Write-Host 'PASS [META]: Assert-Equal refuses a wrong expectation' -ForegroundColor Green }

if (-not $script:ok) { Write-Host 'question-notify selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'question-notify selftest: all cases green' -ForegroundColor Green
exit 0
