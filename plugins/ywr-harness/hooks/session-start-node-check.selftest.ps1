# Self-test for session-start-node-check.ps1 (the "node is not on PATH" notice).
# Usage: pwsh plugins/ywr-harness/hooks/session-start-node-check.selftest.ps1
#
# Hermetic by construction: every child runs with PATH replaced by fixture directories holding fake
# files (existence is all the hook probes), so the machine's real node — or the lack of one — never
# reaches a verdict. The child is started by absolute path, so a PATH without pwsh in it is fine.
# Payload shape: the SessionStart contract of the raw hooks doc (`source`, optional `model`); the hook
# needs only `hook_event_name`, so the cases send the documented fields and nothing invented.
# The non-Windows cases (an executable `node` is found, a `node` without an execute bit is named) are
# SKIP on Windows and run on CI ubuntu; there is no macOS runner, so macOS is covered only through that
# shared Unix path.
# Every match-based case carries MustNotMatch as well as MustMatch (the empty-MustNotMatch class).
# The output is serialized by .NET, which writes non-ASCII as \uXXXX, so every text assertion runs on
# the PARSED systemMessage / additionalContext, never on the raw line.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core + fixture lifecycle
$hook = Join-Path $PSScriptRoot 'session-start-node-check.ps1'
$pwshExe = (Get-Command pwsh).Source
$isWin = [IO.Path]::DirectorySeparatorChar -eq '\'
$sep = [string][IO.Path]::PathSeparator

$fx = New-FixtureRoot 'ssnc-selftest'
$savedPath = [Environment]::GetEnvironmentVariable('PATH')
function Restore-Env { [Environment]::SetEnvironmentVariable('PATH', $savedPath) }
trap { Restore-Env; Remove-FixtureRoot $fx; break }

function New-Dir([string]$Name, [string[]]$Files = @()) {
    $d = Join-Path $fx $Name
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    foreach ($f in $Files) {
        $p = Join-Path $d $f
        [IO.File]::WriteAllText($p, 'fixture')
        if (-not $isWin) { [IO.File]::SetUnixFileMode($p, [IO.UnixFileMode]'UserRead, UserWrite, UserExecute') }
    }
    return $d
}
$platformNode = if ($isWin) { 'node.exe' } else { 'node' }
$otherFlavour = if ($isWin) { 'node' } else { 'node.exe' }
$dirNode = New-Dir 'with-node' @($platformNode)
$dirNear = New-Dir 'near-miss' @('node-gyp.exe', 'nodemon', 'nodejs.exe', 'xnode.exe', 'node.txt')
$dirEmpty = New-Dir 'empty'

$defaultStdin = '{"hook_event_name":"SessionStart","session_id":"selftest","source":"startup"}'
# PATH is the literal value the child gets ($null = unset). Stdin defaults to a SessionStart payload.
function Invoke-Hook([string]$PathValue, [string]$Stdin = $defaultStdin) {
    [Environment]::SetEnvironmentVariable('PATH', $(if ($PathValue) { $PathValue } else { $null }))
    try { $o = ($Stdin | & $pwshExe -NoProfile -File $hook 2>&1 | Out-String); $script:HookExit = $LASTEXITCODE }
    finally { Restore-Env }
    return $o
}
function Assert-Warn([string]$Name, [string]$Out, [string[]]$SysMatch, [string[]]$SysNotMatch, [string[]]$CtxMatch = @(), [string[]]$CtxNotMatch = @('zzz-never')) {
    $pre = @()
    if ($script:HookExit -ne 0) { $pre += "exit $script:HookExit (want 0 — SessionStart blocks nothing)" }
    $sys = ''; $ctx = ''; $ev = ''
    try {
        $j = ConvertFrom-Json $Out.Trim()
        $sys = [string]$j.systemMessage; $ctx = [string]$j.hookSpecificOutput.additionalContext; $ev = [string]$j.hookSpecificOutput.hookEventName
    }
    catch { $pre += 'stdout is not valid JSON' }
    if (-not $sys) { $pre += 'no systemMessage (the member-facing notice)' }
    if (-not $ctx) { $pre += 'no additionalContext (the model-facing note)' }
    if ($ev -cne 'SessionStart') { $pre += "hookEventName '$ev' (want SessionStart)" }
    foreach ($bad in @('permissionDecision', 'updatedInput', '"decision"')) { if ($Out -match [regex]::Escape($bad)) { $pre += "output carries $bad — the notice blocks nothing" } }
    foreach ($surf in @(@('systemMessage', $sys), @('additionalContext', $ctx))) {
        if ($surf[1] -match '[\r\n\u0085\u2028\u2029]') { $pre += "$($surf[0]) is not one line" }
        if ($surf[1] -match '(?i)\bADR\s*[#-]?\s*\d') { $pre += "$($surf[0]) cites a decision number (spec 0006 §3.1)" }
    }
    $f1 = Get-AssertionFailure -Text $sys -MustMatch $SysMatch -MustNotMatch $SysNotMatch -PreFail $pre -Label 'systemMessage'
    $f2 = Get-AssertionFailure -Text $ctx -MustMatch $CtxMatch -MustNotMatch $CtxNotMatch -Label 'additionalContext'
    $script:LastFails = @($f1) + @($f2) | Where-Object { $_ }
    return (Write-CaseVerdict -Name $Name -Fail @($script:LastFails) -Detail $Out)
}
function Assert-Silent([string]$Name, [string]$Out) {
    $fails = @()
    if ($script:HookExit -ne 0) { $fails += "exit $script:HookExit (want 0)" }
    if ($Out.Trim()) { $fails += "expected byte-silent stdout (it would become session context), got: $($Out.Trim())" }
    return (Write-CaseVerdict -Name $Name -Fail $fails)
}
function Write-Skip([string]$Name, [string]$Why) { Write-Host "SKIP [$Name]: $Why" -ForegroundColor Yellow }

$ok = $true
$sysCore = @('^\[hook:node-check\]', 'PATH 에서 `node` 를 찾지 못해', 'Node 로 도는 ywr-harness 의 다른 훅 8개', '세션 시작·설정 변경·디렉터리 추가·Agent 호출·서브에이전트 종료 때마다',
    '훅 오류를 표시합니다\(아무것도 차단되지는 않습니다\)', 'Node\.js LTS 를 설치하고\(Windows: `winget install OpenJS\.NodeJS\.LTS`, macOS: `brew install node`, Linux: 배포판 패키지 또는 nodejs\.org\)',
    'Claude Code 를 다시 시작하면 이 안내와 오류가 사라집니다', '이미 설치돼 있다면\(nvm 등, 또는 GUI·Dock 에서 실행해', '터미널에서 Claude Code 를 시작', 'PATH 에 넣으세요')
$ctxCore = @('Node\.js is not on PATH', 'the eight ywr-harness hooks that run on Node', 'at session start, on a config change, on an added directory', 'every Agent call and on every subagent stop',
    'not from a defect in the user''s repository', 'nothing was blocked', 'restarting Claude Code', 'start Claude Code from a terminal where `node` resolves', 'GUI/Dock')

# --- silent: node is found ----------------------------------------------------------------------
$ok = (Assert-Silent "S1 $platformNode on PATH -> byte-silent" (Invoke-Hook $dirNode)) -and $ok
$ok = (Assert-Silent 'S2 node found past a directory without it -> byte-silent' (Invoke-Hook ($dirNear, $dirEmpty, $dirNode -join $sep))) -and $ok
$ok = (Assert-Silent 'S3 empty, whitespace-only and quoted entries are tolerated; the quoted dir holding node is found' `
        (Invoke-Hook ($sep + $sep + '   ' + $sep + $dirEmpty + $sep + '"' + $dirNode + '"' + $sep))) -and $ok
if ($isWin) {
    $dirShimFirst = New-Dir 'shim-first' @('node.cmd')
    $ok = (Assert-Silent 'S4 a real node.exe later on PATH beats an earlier node.cmd shim -> byte-silent' (Invoke-Hook ($dirShimFirst, $dirNode -join $sep))) -and $ok
    Write-Skip 'S5 non-Windows executable node file' 'Windows — the platform file is node.exe (S1)'
    Write-Skip 'S6 executable node beats an earlier non-executable one' 'Windows — there is no execute bit'
    Write-Skip 'S7 node as a symlink to an executable file' 'Windows — a Unix symlink case'
    Write-Skip 'S8 a dangling node link does not hide a real node' 'Windows — a Unix symlink case'
    Write-Skip 'W10 a dangling node link is absent, not "not executable"' 'Windows — a Unix symlink case'
    Write-Skip 'W11 a symlink to a non-executable file is named as not executable' 'Windows — a Unix symlink case'
}
else {
    $dirX = New-Dir 'exec-node' @('node')
    $ok = (Assert-Silent 'S5 a non-Windows executable `node` file -> byte-silent' (Invoke-Hook $dirX)) -and $ok
    $dirNoX = New-Dir 'noexec-node'
    [IO.File]::WriteAllText((Join-Path $dirNoX 'node'), 'fixture')
    [IO.File]::SetUnixFileMode((Join-Path $dirNoX 'node'), [IO.UnixFileMode]'UserRead, UserWrite, GroupRead, OtherRead')
    $ok = (Assert-Silent 'S6 an executable node later on PATH beats an earlier non-executable one -> byte-silent' (Invoke-Hook ($dirNoX, $dirX -join $sep))) -and $ok
    Write-Skip 'S4 node.exe beats a node.cmd shim' 'non-Windows — shims are a Windows case'
    # Homebrew (/opt/homebrew/bin/node) and nvm install node as a SYMLINK, and the host's exec follows it
    # (on .NET 10, File.Exists is true for a dangling link too; GetUnixFileMode follows it and throws).
    $linkTargets = New-Dir 'link-targets'
    $realX = Join-Path $linkTargets 'node-real'; $realNx = Join-Path $linkTargets 'node-real-noexec'
    [IO.File]::WriteAllText($realX, 'fixture'); [IO.File]::SetUnixFileMode($realX, [IO.UnixFileMode]'UserRead, UserWrite, UserExecute')
    [IO.File]::WriteAllText($realNx, 'fixture'); [IO.File]::SetUnixFileMode($realNx, [IO.UnixFileMode]'UserRead, UserWrite')
    $dirLinkX = New-Dir 'link-exec'; [void][IO.File]::CreateSymbolicLink((Join-Path $dirLinkX 'node'), $realX)
    $dirLinkNx = New-Dir 'link-noexec'; [void][IO.File]::CreateSymbolicLink((Join-Path $dirLinkNx 'node'), $realNx)
    $dirDangling = New-Dir 'link-dangling'; [void][IO.File]::CreateSymbolicLink((Join-Path $dirDangling 'node'), (Join-Path $linkTargets 'missing'))
    $ok = (Assert-Silent 'S7 `node` as a symlink to an executable file elsewhere (Homebrew/nvm shape) -> byte-silent' (Invoke-Hook $dirLinkX)) -and $ok
    $ok = (Assert-Silent 'S8 a dangling `node` link earlier on PATH does not hide a real node later -> byte-silent' (Invoke-Hook ($dirDangling, $dirLinkX -join $sep))) -and $ok
}

# --- speaks: node is absent ---------------------------------------------------------------------
$ok = (Assert-Warn 'W1 PATH without node -> notice on both channels: the events of the eight Node hooks, the install commands, the restart and the installed-but-invisible clause' (Invoke-Hook ($dirNear, $dirEmpty -join $sep)) `
        $sysCore @('shim') $ctxCore @('shim')) -and $ok
$ok = (Assert-Warn 'W2 an unset PATH is absent too (no crash)' (Invoke-Hook '') $sysCore @('shim') $ctxCore @('shim')) -and $ok
$ok = (Assert-Warn 'W3 empty, quoted and illegal entries around no node -> still the notice, no crash' `
        (Invoke-Hook ($sep + '"' + $dirEmpty + '"' + $sep + $sep + 'C:\bad|path<>' + $sep + '"')) $sysCore @('shim') $ctxCore @('shim')) -and $ok
$ok = (Assert-Warn 'W4 the other flavour of the file (node on Windows, node.exe elsewhere) is not node' `
        (Invoke-Hook (New-Dir 'other-flavour' @($otherFlavour))) $sysCore @('shim') $ctxCore @('shim')) -and $ok
$ok = (Assert-Warn 'W5 the event name matches case-insensitively, like the other pwsh hooks' `
        (Invoke-Hook $dirEmpty '{"Hook_Event_Name":"sessionstart","source":"resume"}') $sysCore @('shim') $ctxCore @('shim')) -and $ok
if ($isWin) {
    foreach ($shimName in @('node.cmd', 'node.bat', 'node.ps1')) {
        $dShim = New-Dir ("shim-" + $shimName) @($shimName)
        $shimPath = Join-Path $dShim $shimName
        $ok = (Assert-Warn "W6 only $shimName on PATH -> the notice names the shim and says exec-form needs node.exe" (Invoke-Hook ($dirEmpty, $dShim -join $sep)) `
                ($sysCore + @(([regex]::Escape($shimPath) + ' 는 찾았지만'), '실제 node\.exe 만 실행할 수 있습니다')) @('zzz-never') `
                ($ctxCore + @('A node shim was found on PATH', 'needs a real node executable')) @('zzz-never')) -and $ok
    }
    # a crafted PATH entry (a backtick is legal in a Windows directory name) renders without a backtick of its own
    $dCraft = New-Dir 'craft`dir' @('node.cmd')
    Write-Skip 'W8 a node file without the execute bit is named' 'Windows — there is no execute bit'
    Write-Skip 'W9 crafted non-executable path flattened' 'Windows — there is no execute bit'
    $ok = (Assert-Warn 'W7 a crafted shim path is flattened: no backtick of its own, still one line' (Invoke-Hook $dCraft) `
            ($sysCore + @('craft dir\\node\.cmd 는 찾았지만')) @('craft`dir') @('A node shim was found') @('craft`dir')) -and $ok
}
else {
    Write-Skip 'W6 node.cmd / node.bat / node.ps1 shim named in the notice' 'non-Windows — shims are a Windows case'
    Write-Skip 'W7 crafted shim path flattened' 'non-Windows — shims are a Windows case'
    $noxPath = Join-Path $dirNoX 'node'
    $ok = (Assert-Warn 'W8 a `node` file without the execute bit is not node: the notice names it and says it lacks permission' (Invoke-Hook $dirNoX) `
            ($sysCore + @(([regex]::Escape($noxPath) + ' 는 찾았지만 실행 권한이 없습니다'), 'chmod \+x')) @('shim', 'node\.exe') `
            ($ctxCore + @('A node file was found on PATH, but it is not executable')) @('shim')) -and $ok
    $ok = (Assert-Warn 'W10 a DANGLING `node` link and no other node -> the plain notice: absent, not named, not "not executable"' (Invoke-Hook $dirDangling) `
            $sysCore @('는 찾았지만', '실행 권한', 'shim') $ctxCore @('not executable', 'shim')) -and $ok
    $linkPath = Join-Path $dirLinkNx 'node'
    $ok = (Assert-Warn 'W11 a symlink to a NON-executable file is named (by its PATH entry) as lacking execute permission' (Invoke-Hook $dirLinkNx) `
            ($sysCore + @(([regex]::Escape($linkPath) + ' 는 찾았지만 실행 권한이 없습니다'))) @('shim', 'node\.exe') `
            ($ctxCore + @('A node file was found on PATH, but it is not executable')) @('shim')) -and $ok
    $dCraft = New-Dir 'craft`dir'
    [IO.File]::WriteAllText((Join-Path $dCraft 'node'), 'fixture')
    [IO.File]::SetUnixFileMode((Join-Path $dCraft 'node'), [IO.UnixFileMode]'UserRead, UserWrite')
    $ok = (Assert-Warn 'W9 a crafted non-executable path is flattened: no backtick of its own, still one line' (Invoke-Hook $dCraft) `
            ($sysCore + @('craft dir/node 는 찾았지만 실행 권한이 없습니다')) @('craft`dir') @('not executable') @('craft`dir')) -and $ok
}

# --- fail-open ----------------------------------------------------------------------------------
# PATH holds no node in every case below, so a run that did not stop at the guard WOULD speak.
foreach ($c in @(
        @{ n = 'F1 unparseable stdin is silent (fail-open)'; s = 'not json {{{' },
        @{ n = 'F2 a wrong event is silent'; s = '{"hook_event_name":"PreToolUse","tool_name":"Agent"}' },
        @{ n = 'F3 a payload with no event name is silent'; s = '{"source":"startup"}' },
        @{ n = 'F4 a non-object payload is silent'; s = '[1,2]' },
        @{ n = 'F5 a non-string event name is silent'; s = '{"hook_event_name":5}' },
        @{ n = 'F6 empty stdin is silent'; s = '' })) {
    $ok = (Assert-Silent $c.n (Invoke-Hook $dirEmpty $c.s)) -and $ok
}
$ok = (Assert-Silent 'F7 a BOM-prefixed SessionStart payload with node present is still silent, and parses' (Invoke-Hook $dirNode ([char]0xFEFF + $defaultStdin))) -and $ok
$ok = (Assert-Warn 'F8 a BOM-prefixed SessionStart payload still speaks when node is absent' (Invoke-Hook $dirEmpty ([char]0xFEFF + $defaultStdin)) $sysCore @('shim') $ctxCore @('shim')) -and $ok

# Inline() is one class spread over hook-lib.mjs's inline() and the three other pwsh hooks' own copies
# (spec 0006 §3.1): this copy must flatten exactly what the Node module flattens, or the shim path
# in the banner could forge a line. Behavioural (lib/selftest-lib.ps1).
$ok = (Assert-InlineParity 'I1 Inline() behaves exactly like hook-lib.mjs''s inline()' $hook) -and $ok

# --- registration -------------------------------------------------------------------------------
# Every case above pipes a payload straight into the script, so none of them sees whether the host
# ever calls it, and the manifest gate checks only that a handler's path resolves.
$regFails = @()
try {
    $hk = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'hooks.json') -Raw | ConvertFrom-Json
    $sites = @()
    foreach ($evName in @($hk.hooks.PSObject.Properties.Name | Where-Object { $_ })) {
        foreach ($grp in @($hk.hooks.$evName | Where-Object { $_ })) {
            foreach ($h in @($grp.hooks | Where-Object { $_ })) {
                if ((@([string]$h.command) + @($h.args | ForEach-Object { [string]$_ })) -join ' ' -match 'session-start-node-check\.ps1') { $sites += [pscustomobject]@{ Event = $evName; Matcher = [string]$grp.matcher; H = $h } }
            }
        }
    }
    if ($sites.Count -ne 1) { $regFails += "want exactly 1 registration, found $($sites.Count)" }
    else {
        $s = $sites[0]
        $gotArgs = @($s.H.args | ForEach-Object { [string]$_ })
        $wantArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '${CLAUDE_PLUGIN_ROOT}/hooks/session-start-node-check.ps1')
        if ($s.Event -cne 'SessionStart') { $regFails += "event '$($s.Event)' (want SessionStart)" }
        if ($s.Matcher -cne 'startup|resume|fork') { $regFails += "matcher '$($s.Matcher)' (want exactly 'startup|resume|fork' — clear/compact keep the process env)" }
        if ([string]$s.H.type -cne 'command' -or [string]$s.H.command -cne 'pwsh') { $regFails += "handler type/command '$($s.H.type)'/'$($s.H.command)' (want command/pwsh — it detects node's absence, so it cannot run on node)" }
        if (($gotArgs -join "`0") -cne ($wantArgs -join "`0")) { $regFails += "args [$($gotArgs -join ' ')] (want exec form [$($wantArgs -join ' ')])" }
        else {
            $resolved = Join-Path (Split-Path $PSScriptRoot -Parent) ($gotArgs[-1] -replace '^\$\{CLAUDE_PLUGIN_ROOT\}/', '')
            if ([IO.Path]::GetFullPath($resolved) -ne [IO.Path]::GetFullPath($hook)) { $regFails += "args resolve to '$resolved', not this suite's script" }
        }
        if ([string]$s.H.timeout -ne '10') { $regFails += "timeout '$($s.H.timeout)' (want 10)" }
    }
}
catch { $regFails += "hooks.json unreadable: $($_.Exception.Message)" }
$ok = (Assert-True 'R1 hooks.json registers this script once: SessionStart, matcher startup|resume|fork, exec-form pwsh -File, timeout 10' (-not $regFails.Count) ($regFails -join ' · ')) -and $ok

# META — the silent assertion must refuse a speaking run, or S1-S5 and F1-F7 prove nothing.
$metaOut = Invoke-Hook $dirEmpty
$ok = (Assert-True 'META Assert-Silent refuses a speaking run' (-not (Assert-Silent 'probe' $metaOut 6>$null))) -and $ok

Remove-FixtureRoot $fx
if ($ok) { Write-Host 'session-start-node-check selftest: all cases green' -ForegroundColor Green; exit 0 }
Write-Host 'session-start-node-check selftest: FAILED' -ForegroundColor Red
exit 1
