# Self-test for session-start-githooks-nudge.ps1 (ADR 0029).
# Usage: pwsh plugins/ywr-harness/hooks/session-start-githooks-nudge.selftest.ps1
#
# Fixture provenance: the payload shape below is the SessionStart contract read out of the
# official hooks reference on 2026-08-05 (cwd + source; the event supports a `source` matcher
# that this hook deliberately registers without; additionalContext AND systemMessage both
# consumed) — not a guess; an invented shape is how a sibling hook once stayed green while
# being inert. Every match-based case carries MustNotMatch as well as MustMatch (ADR 0116
# class), enforced by the shared assertion core (ADR 0125).
#
# The git-dependent cases build REAL repos (git init) because the hook's whole verdict is read
# from `git rev-parse` + `git config --local`; asserting against a faked .git directory would
# test the fake. When git is absent (the ADR 0122 Linux container), those cases are a reported
# SKIP, never a silent pass — and the no-git branch is exercised anyway by clearing PATH for
# the child, which works on both kinds of machine.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core + fixture lifecycle
$hook = Join-Path $PSScriptRoot 'session-start-githooks-nudge.ps1'

# Resolved BEFORE any case clears $env:PATH — `& pwsh` resolves at call time and would fail.
$pwshExe = (Get-Command pwsh).Source

function Invoke-Hook([string]$Stdin) {
    $o = ($Stdin | & $pwshExe -NoProfile -File $hook 2>&1 | Out-String)
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
            @('\[hook:githooks-nudge\]', 'repo-unwired', 'core\.hooksPath is UNSET',
            'git config core\.hooksPath \.githooks', '/ywr-harness:harness-init',
            'feedback latency', 'Do not run it unasked', 'only suggests') `
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
            @('repo-unwired', 'core\.hooksPath is UNSET') `
            @('subA', 'SCHEMA DRIFT')) -and $ok

    # 6. BOM-prefixed stdin -> still parses (the config-change-audit 07-23 incident class)
    $out = Invoke-Hook ([char]0xFEFF + (New-Payload @{ cwd = $unwired }))
    $ok = (Assert-Nudge 'BOM-prefixed stdin' $out @('repo-unwired') @('SCHEMA DRIFT')) -and $ok

    # 6b. config read that fails for a reason OTHER than unset -> UNKNOWN, never a nudge
    #     (review 2026-08-05, low). Real git cannot produce this state once rev-parse has
    #     succeeded (measured 2026-08-05: a corrupt .git/config kills rev-parse first, and a
    #     multi-valued key returns exit 0 with the last value), so the only deterministic
    #     reproduction is a shim that fails exactly the config call and forwards everything
    #     else to the real binary — what this case tests is the hook's exit-code BRANCH, not
    #     git. The shim resolves first on PATH as an ExternalScript (measured, incl. exit-code
    #     propagation through `& git`).
    $shimDir = Join-Path $fx 'git-shim'
    New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
    $realGit = (Get-Command git).Source
    @"
if (`$args -contains 'config') { exit 3 }
& '$realGit' @args
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath (Join-Path $shimDir 'git.ps1')
    try {
        $env:PATH = "$shimDir$([IO.Path]::PathSeparator)$savedPath"
        $out = Invoke-Hook (New-Payload @{ cwd = $unwired })
        $ok = (Assert-Nudge 'unreadable config reports UNKNOWN, not a nudge' $out `
                @('could not be read cleanly', 'git config exit 3', 'UNKNOWN, not verified') `
                @('UNSET', 'only suggests', 'SCHEMA DRIFT')) -and $ok
    }
    finally { $env:PATH = $savedPath }

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
        @('SCHEMA DRIFT', 'Keys received: hook_event_name, session_id, source') `
        @('UNSET', 'git config core\.hooksPath')) -and $ok

# 11. wrong event name -> silent (defensive event guard, symmetric with siblings)
$out = Invoke-Hook '{"hook_event_name":"SessionEnd","cwd":"C:\\x","source":"startup"}'
$ok = (Assert-EmptyStdout 'wrong event silent' $out) -and $ok

# 12. garbage stdin -> silent exit 0 (infra failure is not a finding)
$out = Invoke-Hook 'not json at all {{{'
$ok = (Assert-EmptyStdout 'garbage fail-open' $out) -and $ok

# 13-14. the no-git branch, exercised by clearing PATH for the CHILD only ($pwshExe was
#        resolved above): with .githooks the verdict is UNKNOWN — reported, never a silent
#        pass — and without it, silence. Runs on git-less machines too, where it is simply
#        the ambient truth rather than a simulation.
try {
    $env:PATH = ''
    $out = Invoke-Hook (New-Payload @{ cwd = $unknownDir })
    $ok = (Assert-Nudge 'no git: .githooks present reports UNKNOWN' $out `
            @('git is not runnable', 'UNKNOWN, not verified') `
            @('UNSET', 'git config core\.hooksPath', 'SCHEMA DRIFT')) -and $ok
    $out = Invoke-Hook (New-Payload @{ cwd = $plain })
    $ok = (Assert-EmptyStdout 'no git: no .githooks stays silent' $out) -and $ok
}
finally { $env:PATH = $savedPath }

Remove-FixtureRoot $fx

# META — proves this file's WIRING to the shared ADR 0116 guard: a wrapper that dropped the
# -MustNotMatch passthrough would leave the core intact and every case above unguarded.
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
