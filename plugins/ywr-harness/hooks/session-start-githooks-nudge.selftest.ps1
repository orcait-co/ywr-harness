# Self-test for session-start-githooks-nudge.mjs (ADR 0029; Node since ADR 0116).
# Usage: pwsh plugins/ywr-harness/hooks/session-start-githooks-nudge.selftest.ps1
#
# Fixture provenance: the payload shape below is the SessionStart contract read out of the
# official hooks reference on 2026-08-05 (cwd + source; the event supports a `source` matcher
# that this hook deliberately registers without; additionalContext AND systemMessage both
# consumed) — not a guess; an invented shape is how a sibling hook once stayed green while
# being inert. Every match-based case carries MustNotMatch as well as MustMatch
# (the empty-MustNotMatch class), enforced by the shared assertion core.
#
# The git-dependent cases build REAL repos (git init) because the hook's whole verdict is read
# from `git rev-parse` + `git config --local`; asserting against a faked .git directory would
# test the fake. When git is absent (the Linux container), those cases are a reported
# SKIP, never a silent pass — and the no-git branch is exercised anyway by clearing PATH for
# the child, which works on both kinds of machine.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core + fixture lifecycle
$hook = Join-Path $PSScriptRoot 'session-start-githooks-nudge.mjs'
# The hook is Node (ADR 0116): absent node is a reported skip locally and a FAIL on CI.
Assert-NodeOrExit 'session-start-githooks-nudge'

# Resolved BEFORE any case clears $env:PATH — `& node` resolves at call time and would fail.
$nodeExe = (Get-Command node).Source

function Invoke-Hook([string]$Stdin, [string[]]$NodeArgs = @()) {
    $o = ($Stdin | & $nodeExe @NodeArgs $hook 2>&1 | Out-String)
    $script:HookExit = $LASTEXITCODE
    return $o
}
# Envelope adapter (file-specific, per the assertion-core contract): the nudge speaks through
# TWO fields, so the matched text is systemMessage + additionalContext joined — a pattern that
# lives only in the context half (e.g. 'Do not run it unasked') still gets asserted. When
# additionalContext is present its hookEventName must be SessionStart, or the runtime drops it.
function Assert-Nudge([string]$Name, [string]$Out, [string[]]$MustMatch, [string[]]$MustNotMatch, [string]$NoNegative = '') {
    $pre = @()
    if ($script:HookExit -ne 0) { $pre += "exit $script:HookExit (want 0 — fail-open contract; SessionStart blocks nothing)" }
    $sys = ''; $ctx = ''; $evName = ''
    try {
        $j = ConvertFrom-Json $Out.Trim()
        $sys = [string]$j.systemMessage
        try { $ctx = [string]$j.hookSpecificOutput.additionalContext; $evName = [string]$j.hookSpecificOutput.hookEventName } catch { }
    }
    catch { $pre += 'stdout is not valid JSON' }
    if (-not $sys) { $pre += 'no systemMessage' }
    if ($ctx -and $evName -ne 'SessionStart') { $pre += "hookSpecificOutput.hookEventName is '$evName' (want SessionStart — the runtime drops the context otherwise)" }
    $script:LastFails = Get-AssertionFailure -Text "$sys`n$ctx" -MustMatch $MustMatch -MustNotMatch $MustNotMatch `
        -NoNegative $NoNegative -PreFail $pre -Label 'output'
    return (Write-CaseVerdict -Name $Name -Fail $script:LastFails -Detail $Out)
}
function Assert-EmptyStdout([string]$Name, [string]$Out) {
    $fails = @()
    if ($script:HookExit -ne 0) { $fails += "exit $script:HookExit (want 0 — fail-open contract)" }
    # Plain stdout on exit 0 becomes session context for this event, so "silent" must mean
    # BYTE-silent — a stray warning line would be injected into every session's context.
    if ($Out.Trim()) { $fails += "expected empty stdout, got: $($Out.Trim())" }
    if ($fails) { Write-Host "FAIL [$Name]: $($fails -join ' · ')" -ForegroundColor Red; return $false }
    Write-Host "PASS [$Name]" -ForegroundColor Green
    return $true
}
function New-Payload([hashtable]$Fields) {
    $o = @{ hook_event_name = 'SessionStart'; session_id = 'selftest'; source = 'startup' } + $Fields
    return ($o | ConvertTo-Json -Compress)
}

$ok = $true
$savedPath = $env:PATH
$gitOk = [bool](Get-Command git -ErrorAction SilentlyContinue)
$fx = New-FixtureRoot 'ssghn-selftest'
trap { $env:PATH = $savedPath; Remove-FixtureRoot $fx; break }

# --- fixtures --------------------------------------------------------------------------------
$plain = Join-Path $fx 'plain-dir'                    # no repo, no .githooks
$unknownDir = Join-Path $fx 'unknown-dir'             # no repo, WITH .githooks (no-git branch)
New-Item -ItemType Directory -Force -Path $plain | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $unknownDir '.githooks') | Out-Null

if ($gitOk) {
    $unwired = Join-Path $fx 'repo-unwired'
    $wired = Join-Path $fx 'repo-wired'
    $foreign = Join-Path $fx 'repo-foreign'
    $bare = Join-Path $fx 'repo-nogithooks'
    foreach ($r in @($unwired, $wired, $foreign, $bare)) {
        & git -c init.defaultBranch=main init -q $r 2>$null | Out-Null
    }
    foreach ($r in @($unwired, $wired, $foreign)) {
        New-Item -ItemType Directory -Force -Path (Join-Path $r '.githooks') | Out-Null
    }
    & git -C $wired config core.hooksPath .githooks
    & git -C $foreign config core.hooksPath .husky
    New-Item -ItemType Directory -Force -Path (Join-Path $unwired 'subA/subB') | Out-Null

    # 1. the one speaking state: .githooks/ present, core.hooksPath unset -> both channels
    #    carry the fact, the exact command, and the suggest-only contract
    $out = Invoke-Hook (New-Payload @{ cwd = $unwired })
    $ok = (Assert-Nudge 'unwired clone nudges' $out `
            @('\[hook:githooks-nudge\]', 'repo-unwired', 'core\.hooksPath가 UNSET',
            'git config core\.hooksPath \.githooks', '/ywr-harness:harness-init',
            'feedback latency', 'Do not run it unasked', '제안만 합니다') `
            @('SCHEMA DRIFT', 'UNKNOWN')) -and $ok

    # 2. wired clone -> byte-silent (the permanent steady state must cost nothing)
    $out = Invoke-Hook (New-Payload @{ cwd = $wired })
    $ok = (Assert-EmptyStdout 'wired clone silent' $out) -and $ok

    # 3. FOREIGN value -> silent BY DESIGN (ADR 0029 decision table): that state is a decision,
    #    and the emitter's hooks: line still reports it. A nudge here would nag forever.
    $out = Invoke-Hook (New-Payload @{ cwd = $foreign })
    $ok = (Assert-EmptyStdout 'foreign hooksPath silent' $out) -and $ok

    # 4. a repo with no .githooks/ has nothing to wire -> silent
    $out = Invoke-Hook (New-Payload @{ cwd = $bare })
    $ok = (Assert-EmptyStdout 'repo without .githooks silent' $out) -and $ok

    # 5. subdirectory cwd -> the ROOT is resolved and named; the subdir must not be mistaken
    #    for the repo (that is what rev-parse buys over a bare Join-Path on cwd)
    $out = Invoke-Hook (New-Payload @{ cwd = (Join-Path $unwired 'subA/subB') })
    $ok = (Assert-Nudge 'subdirectory cwd resolves the root' $out `
            @('repo-unwired', 'core\.hooksPath가 UNSET') `
            @('subA', 'SCHEMA DRIFT')) -and $ok

    # 6. BOM-prefixed stdin -> still parses (the config-change-audit 07-23 incident class)
    $out = Invoke-Hook ([char]0xFEFF + (New-Payload @{ cwd = $unwired }))
    $ok = (Assert-Nudge 'BOM-prefixed stdin' $out @('repo-unwired') @('SCHEMA DRIFT')) -and $ok

    # 6a. PowerShell semantics the Node port keeps (ADR 0116): member access and the event compare
    #     are case-insensitive, `[string]` casts the cwd and `.Trim()` strips it. A case-sensitive
    #     lookup would see no `cwd` and report SCHEMA DRIFT; a missing trim would hand git a bad path.
    $out = Invoke-Hook (@{ Hook_Event_Name = 'sessionstart'; CWD = $unwired } | ConvertTo-Json -Compress)
    $ok = (Assert-Nudge 'case-drifted keys and event name still read' $out @('repo-unwired', 'core\.hooksPath가 UNSET') @('SCHEMA DRIFT')) -and $ok
    $out = Invoke-Hook (New-Payload @{ cwd = "  $unwired `t " })
    $ok = (Assert-Nudge 'cwd padded with whitespace is trimmed' $out @('repo-unwired', 'core\.hooksPath가 UNSET') @('SCHEMA DRIFT')) -and $ok

    # 6a2. a non-ASCII work tree path: the git boundary decodes UTF-8 once with quotepath off
    #      (CLAUDE.md, issue #40), so the root the hook names is the real directory name — not a
    #      quoted-octal form and not mojibake.
    $uni = Join-Path $fx 'repo-유니코드 é'
    & git -c init.defaultBranch=main init -q $uni 2>$null | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $uni '.githooks') | Out-Null
    $out = Invoke-Hook (New-Payload @{ cwd = $uni })
    $ok = (Assert-Nudge 'non-ASCII work tree path is named intact' $out `
            @('repo-유니코드 é', 'core\.hooksPath가 UNSET') @('SCHEMA DRIFT', '\\[0-7]{3}', '�')) -and $ok

    # 6a3. A directory name is attacker-authorable text (a cloned repo's) and a model reads this output: the
    #      banner echoes the root through inline(), so no control or Unicode line separator survives.
    #      U+2028 and U+0085 are legal in a Windows file name; a C0 control is added where the OS allows one.
    $hostile = Join-Path $fx ('repo-hostile' + [char]0x2028 + 'dir' + [char]0x85 + 'x' + $(if (-not $IsWindows) { [string][char]7 } else { '' }))
    $hostileMade = $false
    try {
        New-Item -ItemType Directory -Force -Path (Join-Path $hostile '.githooks') -ErrorAction Stop | Out-Null
        & git -c init.defaultBranch=main init -q $hostile 2>$null | Out-Null
        $hostileMade = $true
    } catch { }
    if ($hostileMade) {
        $out = Invoke-Hook (New-Payload @{ cwd = $hostile })
        $ok = (Assert-Nudge '6a3 a path carrying U+2028, U+0085 (and a C0 off Windows) is echoed flattened' $out `
                @('repo-hostile dir x', 'core\.hooksPath가 UNSET') @('SCHEMA DRIFT', '[\u0000-\u0009\u000B-\u001F\u007F\u0085\u2028\u2029]')) -and $ok
    }
    else { Write-Host 'SKIP [6a3] the hostile-named work tree could not be created here — not run (reported, not silent)' -ForegroundColor Yellow }

    # 6b. config read that fails for a reason OTHER than unset -> UNKNOWN, never a nudge
    #     (review 2026-08-05, low). Real git cannot produce this state once rev-parse has
    #     succeeded (measured 2026-08-05: a corrupt .git/config kills rev-parse first, and a
    #     multi-valued key returns exit 0 with the last value), so the only deterministic
    #     reproduction is a stand-in that fails exactly the config call and forwards everything
    #     else to the real binary — what this case tests is the hook's exit-code BRANCH, not
    #     git. A Node hook launches `git` by exec, which runs real executables only (never a
    #     .cmd/.ps1 shim on PATH), so the stand-in is a `node -r` preload that wraps
    #     child_process.spawnSync: a `git ... config ...` call answers exit 3 with no output and
    #     every other call goes to the real spawnSync.
    $failConfig = Join-Path $fx 'git-fail-config.cjs'
    @'
const cp = require('node:child_process')
const real = cp.spawnSync
cp.spawnSync = function (cmd, args) {
  // the hook spawns git by its PATH-resolved absolute path (hook-lib gitRun), so match the file name
  const base = require('node:path').basename(String(cmd)).toLowerCase()
  if ((base === 'git' || base === 'git.exe') && Array.isArray(args) && args.includes('config')) {
    return { status: 3, signal: null, pid: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: [null, Buffer.alloc(0), Buffer.alloc(0)] }
  }
  return real.apply(this, arguments)
}
'@ | Set-Content -LiteralPath $failConfig -Encoding utf8
    $out = Invoke-Hook (New-Payload @{ cwd = $unwired }) @('-r', $failConfig)
    $ok = (Assert-Nudge 'unreadable config reports UNKNOWN, not a nudge' $out `
            @('repo-unwired', '정상적으로 읽을 수 없습니다', 'git config exit 3', 'UNKNOWN, 확인되지 않았습니다') `
            @('UNSET', '제안만 합니다', 'SCHEMA DRIFT')) -and $ok   # 'repo-unwired' proves rev-parse still reached the real git

    # 6c. NON-MUTATION, asserted not assumed (review 2026-08-05, medium): after every
    #     invocation above, each clone's core.hooksPath must read EXACTLY what the fixture
    #     set. The suggest-only contract (ADR 0029) becomes provable by the suite — an
    #     Option-D regression (the hook 'helpfully' wiring a clone) turns a case red here
    #     instead of passing every text assertion.
    $post = @(& git -C $unwired config --local --get core.hooksPath 2>$null)
    $ok = (Assert-True 'non-mutation: unwired clone is still unwired' ($post.Count -eq 0) `
            "core.hooksPath now reads [$($post -join ' ')] — the hook wrote to the clone") -and $ok
    $post = @(& git -C $wired config --local --get core.hooksPath 2>$null)
    $ok = (Assert-True 'non-mutation: wired value untouched' (([string]$post[0]).Trim() -eq '.githooks') `
            "core.hooksPath now reads [$($post -join ' ')]") -and $ok
    $post = @(& git -C $foreign config --local --get core.hooksPath 2>$null)
    $ok = (Assert-True 'non-mutation: foreign value untouched' (([string]$post[0]).Trim() -eq '.husky') `
            "core.hooksPath now reads [$($post -join ' ')]") -and $ok
}
else {
    Write-Host 'SKIP — git not on PATH; 10 git-dependent cases not run (reported, not silent)' -ForegroundColor Yellow
}

# 7. plain non-repo directory -> silent on BOTH branches (with git: rev-parse fails; without
#    git: no .githooks at cwd), so this case runs unguarded
$out = Invoke-Hook (New-Payload @{ cwd = $plain })
$ok = (Assert-EmptyStdout 'non-repo dir silent' $out) -and $ok

# 8. vanished cwd -> silent, and the stdout must be CLEAN (2>&1 is captured, so a stderr wall
#    from git or Test-Path would fail the emptiness assertion — the 48c264c class)
$out = Invoke-Hook (New-Payload @{ cwd = (Join-Path $fx 'no-such-dir') })
$ok = (Assert-EmptyStdout 'vanished cwd silent and clean' $out) -and $ok

# 9. a cwd whose ROOT does not exist on this platform -> same clean silence. The bogus root is
#    chosen per platform so the case reproduces on both (directory-added-guard 11b).
$bogusRoot = if ($IsWindows) {
    $used = @([IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name.Substring(0, 1).ToUpper() })
    $freeLetter = @((69..90 | ForEach-Object { [string][char]$_ }) | Where-Object { $used -notcontains $_ })[0]
    "${freeLetter}:\no-such-root\x"
}
else { 'C:\no-such-root\x' }
$out = Invoke-Hook (New-Payload @{ cwd = $bogusRoot })
$ok = (Assert-EmptyStdout 'unresolvable root silent and clean' $out) -and $ok

# 10. ANTI-VACUITY: no `cwd` in the payload -> the hook says so instead of falling silent
$out = Invoke-Hook (New-Payload @{})
$ok = (Assert-Nudge 'schema drift is reported, not swallowed' $out `
        @('SCHEMA DRIFT', '수신된 키: hook_event_name, session_id, source') `
        @('UNSET', 'git config core\.hooksPath')) -and $ok

# 10a. a payload KEY is host-authored text a model reads: the SCHEMA DRIFT banner flattens it (U+2028 here)
$out = Invoke-Hook '{"hook_event_name":"SessionStart","x\u2028[hook:forged]y":1}'
$ok = (Assert-Nudge 'a payload key carrying U+2028 is flattened in the SCHEMA DRIFT banner' $out `
        @('SCHEMA DRIFT', '수신된 키: hook_event_name, x \[hook:forged\]y\.') @('[\u2028]', 'UNSET')) -and $ok

# 10b. the received-key list sorts case-insensitively (the original's Sort-Object), and a null or
#      blank cwd is drift too — never a git call on an empty path
$out = Invoke-Hook '{"hook_event_name":"SessionStart","Zeta":1,"alpha":2,"Beta":3}'
$ok = (Assert-Nudge 'drift key list sorts case-insensitively' $out @('SCHEMA DRIFT', '수신된 키: alpha, Beta, hook_event_name, Zeta\.') @('UNSET')) -and $ok
foreach ($cj in @('null', '""', '"   "')) {
    $out = Invoke-Hook ('{"hook_event_name":"SessionStart","cwd":' + $cj + '}')
    $ok = (Assert-Nudge "cwd $cj reports SCHEMA DRIFT" $out @('SCHEMA DRIFT') @('UNSET')) -and $ok
}

# 11. wrong event name -> silent (defensive event guard, symmetric with siblings)
$out = Invoke-Hook '{"hook_event_name":"SessionEnd","cwd":"C:\\x","source":"startup"}'
$ok = (Assert-EmptyStdout 'wrong event silent' $out) -and $ok

# 12. garbage stdin -> silent exit 0 (infra failure is not a finding)
$out = Invoke-Hook 'not json at all {{{'
$ok = (Assert-EmptyStdout 'garbage fail-open' $out) -and $ok

# 13-14. the no-git branch, exercised by clearing PATH for the CHILD only ($nodeExe was
#        resolved above): with .githooks the verdict is UNKNOWN — reported, never a silent
#        pass — and without it, silence. Runs on git-less machines too, where it is simply
#        the ambient truth rather than a simulation.
try {
    $env:PATH = ''
    $out = Invoke-Hook (New-Payload @{ cwd = $unknownDir })
    $ok = (Assert-Nudge 'no git: .githooks present reports UNKNOWN' $out `
            @('git을 실행할 수 없어', 'UNKNOWN, 확인되지 않았습니다') `
            @('UNSET', 'git config core\.hooksPath', 'SCHEMA DRIFT')) -and $ok
    $out = Invoke-Hook (New-Payload @{ cwd = $plain })
    $ok = (Assert-EmptyStdout 'no git: no .githooks stays silent' $out) -and $ok
}
finally { $env:PATH = $savedPath }

Remove-FixtureRoot $fx

# R1. REGISTRATION. Every case above pipes a payload straight into the script, so none of them sees
#     whether the runtime ever calls it. This pins the wiring: SessionStart, no matcher (deliberate —
#     see the hook header), exec-form `node <script>` (ADR 0116) and the 15 s timeout. That it FIRES
#     is still only a live `--plugin-dir` probe's to show.
$regFails = @()
try {
    $hj = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'hooks.json') -Raw | ConvertFrom-Json
    $sites = @()
    foreach ($evName in @($hj.hooks.PSObject.Properties.Name | Where-Object { $_ })) {
        foreach ($grp in @($hj.hooks.$evName | Where-Object { $_ })) {
            foreach ($h in @($grp.hooks | Where-Object { $_ })) {
                $parts = @([string]$h.command) + @($h.args | ForEach-Object { [string]$_ })
                if (($parts -join ' ') -match 'session-start-githooks-nudge\.(ps1|mjs)') { $sites += [pscustomobject]@{ Event = $evName; Matcher = [string]$grp.matcher; H = $h } }
            }
        }
    }
    $wantArgs = @('${CLAUDE_PLUGIN_ROOT}/hooks/session-start-githooks-nudge.mjs')
    if ($sites.Count -ne 1) { $regFails += "want exactly 1 registration of session-start-githooks-nudge (.mjs or the retired .ps1), found $($sites.Count)" }
    else {
        $s = $sites[0]
        $gotArgs = @($s.H.args | ForEach-Object { [string]$_ })
        if ($s.Event -cne 'SessionStart') { $regFails += "event '$($s.Event)' (want SessionStart)" }
        if ($s.Matcher) { $regFails += "matcher '$($s.Matcher)' (want none — registered without one on purpose)" }
        if ([string]$s.H.type -cne 'command' -or [string]$s.H.command -cne 'node') { $regFails += "handler type/command '$($s.H.type)'/'$($s.H.command)' (want command/node)" }
        if (($gotArgs -join "`0") -cne ($wantArgs -join "`0")) { $regFails += "args [$($gotArgs -join ' ')] (want exec form [$($wantArgs -join ' ')])" }
        else {
            $resolved = Join-Path (Split-Path $PSScriptRoot -Parent) ($gotArgs[-1] -replace '^\$\{CLAUDE_PLUGIN_ROOT\}/', '')
            if ([IO.Path]::GetFullPath($resolved) -ne [IO.Path]::GetFullPath($hook)) { $regFails += "args resolve to '$resolved', not this suite's script '$hook'" }
        }
        if ([string]$s.H.timeout -ne '15') { $regFails += "timeout '$($s.H.timeout)' (want 15)" }
    }
} catch { $regFails += "hooks.json unreadable: $($_.Exception.Message)" }
$ok = (Assert-True 'R1 hooks.json registers this script once: SessionStart, no matcher, exec-form node <script>' `
        (-not $regFails.Count) ($regFails -join ' · ')) -and $ok

# META — proves this file's WIRING to the shared empty-MustNotMatch guard: a wrapper that
# dropped the -MustNotMatch passthrough would leave the core intact and every case above unguarded.
$script:HookExit = 0
$metaOut = '{"systemMessage":"meta probe"}'
$accepted = Assert-Nudge 'META probe' $metaOut @('meta probe') 6>$null
if ($accepted -or $script:LastFails.Count -ne 1 -or ($script:LastFails[0] -notmatch 'no MustNotMatch')) {
    Write-Host "FAIL [META]: guard did not fire — accepted=$accepted reason='$($script:LastFails -join '; ')'" -ForegroundColor Red
    $ok = $false
}
else { Write-Host 'PASS [META]: negative-less case rejected, on the guard reason alone' -ForegroundColor Green }
if (Assert-Nudge 'META exemption honored' $metaOut @('meta probe') @() 'META: exercises the visible-exemption path so the escape hatch cannot rot unnoticed') {
    Write-Host 'PASS [META]: -NoNegative exemption honored' -ForegroundColor Green
}
else { Write-Host 'FAIL [META]: -NoNegative exemption rejected' -ForegroundColor Red; $ok = $false }

if (-not $ok) { exit 1 }
Write-Host "session-start-githooks-nudge selftest: all cases green$(if (-not $gitOk) { ' (git-dependent cases SKIPPED — no git)' })" -ForegroundColor Green
exit 0
