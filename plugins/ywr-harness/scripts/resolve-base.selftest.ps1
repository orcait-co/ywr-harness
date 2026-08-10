# Selftest for scripts/resolve-base.sh — CI diff-range base resolution (ADR 0043).
#
# Ported from ywr-platform's resolve-base.selftest.ps1 and made HERMETIC: the platform version
# ran against its real repo (case F skipped without an origin/main ref); this one builds a
# fixture repo in the OS temp dir — three linear commits plus a synthesized remote-tracking ref —
# so all ten cases are deterministic everywhere, including the Linux parity container, which
# mounts the plugin read-only and has no host .git to lean on.
#
# The mode-divergence class is the point (it broke the platform's advisory contract when this
# logic was five inline copies): the SAME bad input (explicit dispatch base, failed PR
# merge-base) must hard-fail in blocking mode and degrade-with-warning (exit 0) in advisory
# mode; every branch ends in a validated BASE or a LOUD degrade/error. GITHUB_OUTPUT is a
# per-call temp file. Runs via sh (/bin/sh on the ubuntu runner; Git's own sh.exe on Windows —
# never WSL bash, fact 12/26 class).
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # Assert-True + fixture lifecycle + decoding pin

$Target = (Join-Path $PSScriptRoot 'resolve-base.sh') -replace '\\', '/'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    if ($env:CI) { Write-Host 'FAIL — git absent on CI; a missing interpreter is not a pass' -ForegroundColor Red; exit 1 }
    Write-Host 'SKIP [resolve-base] git absent (reported, not silent) — CI runs this gate' -ForegroundColor Yellow
    exit 0
}
# sh: on PATH on the ubuntu runner and in the parity container; on Windows it ships with Git
# (not on PATH by default) — resolve it relative to git.exe (<git>\cmd\..\bin\sh.exe).
$Sh = (Get-Command sh -ErrorAction SilentlyContinue).Source
if (-not $Sh) {
    $gitHome = Split-Path (Split-Path (Get-Command git).Source)
    $cand = Join-Path (Join-Path $gitHome 'bin') 'sh.exe'
    if (Test-Path -LiteralPath $cand) { $Sh = $cand }
}
if (-not $Sh) {
    if ($env:CI) { Write-Host 'FAIL — no sh interpreter on CI (PATH or Git bin); a missing interpreter is not a pass' -ForegroundColor Red; exit 1 }
    Write-Host 'SKIP [resolve-base] no sh interpreter found (reported, not silent) — CI runs this gate' -ForegroundColor Yellow
    exit 0
}

$fx = New-FixtureRoot 'resolve-base-selftest'
trap { Remove-FixtureRoot $fx; break }

# --- fixture repo: three linear commits, a synthesized origin/<branch> at the first ----------
$repo = Join-Path $fx 'repo'
New-Item -ItemType Directory -Force -Path $repo | Out-Null
& git -C $repo init -q 2>$null
& git -C $repo config user.email 'selftest@example.invalid' 2>$null
& git -C $repo config user.name 'selftest' 2>$null
function Commit-File([string]$Rel, [string]$Content, [string]$Msg) {
    [IO.File]::WriteAllText((Join-Path $repo $Rel), $Content)
    & git -C $repo add -A 2>$null
    & git -C $repo commit -q -m $Msg 2>$null
}
Commit-File 'a.txt' "one`n"   'chore: c1'
Commit-File 'a.txt' "two`n"   'chore: c2'
Commit-File 'a.txt' "three`n" 'chore: c3'
$mainBranch = (& git -C $repo symbolic-ref --short HEAD).Trim()
$c1 = (& git -C $repo rev-parse 'HEAD~2').Trim()
$head1 = (& git -C $repo rev-parse 'HEAD~1').Trim()   # the degrade target
& git -C $repo update-ref "refs/remotes/origin/$mainBranch" $c1 2>$null
$badSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

$EnvNames = @('EVENT_NAME', 'BASE_REF', 'EVENT_BEFORE', 'DISPATCH_BASE', 'MODE', 'GITHUB_OUTPUT')

function Invoke-Target([hashtable]$Vars) {
    $gh = Join-Path $fx "gh-output-$(Get-Random).txt"
    $saved = @{}
    foreach ($n in $EnvNames) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
    Push-Location $repo
    try {
        # clear ALL script inputs first — cases must not inherit a prior case's vars
        foreach ($n in $EnvNames) { [Environment]::SetEnvironmentVariable($n, $null) }
        foreach ($k in $Vars.Keys) { [Environment]::SetEnvironmentVariable($k, $Vars[$k]) }
        # forward slashes — the sh redirect target must survive Git's sh on Windows
        $env:GITHUB_OUTPUT = $gh -replace '\\', '/'
        $out = & $Sh $Target 2>&1 | Out-String
        $code = $LASTEXITCODE
        $baseLine = if (Test-Path -LiteralPath $gh) {
            @(Get-Content -LiteralPath $gh | Where-Object { $_ -match '^base=' }) | Select-Object -Last 1
        }
        return @{ Out = $out; Code = $code; Base = ($baseLine -replace '^base=', '') }
    }
    finally {
        Pop-Location
        foreach ($n in $EnvNames) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
        Remove-Item $gh -ErrorAction SilentlyContinue
    }
}

$ok = $true

# A: blocking + valid explicit dispatch base -> passes through untouched
$r = Invoke-Target @{ EVENT_NAME = 'workflow_dispatch'; DISPATCH_BASE = $head1; MODE = 'blocking' }
$ok = (Assert-True 'A blocking valid base' ($r.Code -eq 0 -and $r.Base -eq $head1) "exit $($r.Code), base '$($r.Base)': $($r.Out)") -and $ok

# B: bad explicit base, MODE unset -> default is blocking, hard-fail BEFORE any output
# (an explicit operator range is never silently degraded)
$r = Invoke-Target @{ EVENT_NAME = 'workflow_dispatch'; DISPATCH_BASE = $badSha }
$ok = (Assert-True 'B blocking bad base (default mode)' ($r.Code -ne 0 -and $r.Out -match 'not an ancestor' -and -not $r.Base) `
    "exit $($r.Code), base '$($r.Base)': $($r.Out)") -and $ok

# C: the SAME bad base in advisory mode -> exit 0 + warning + degrade to HEAD~1
# (the mode-divergence class this selftest exists for)
$r = Invoke-Target @{ EVENT_NAME = 'workflow_dispatch'; DISPATCH_BASE = $badSha; MODE = 'advisory' }
$ok = (Assert-True 'C advisory bad base never fails' ($r.Code -eq 0 -and $r.Out -match '::warning::' -and $r.Base -eq $head1) `
    "exit $($r.Code), base '$($r.Base)': $($r.Out)") -and $ok

# D: push with unreachable event.before (force-push shape) -> loud degrade, exit 0
$r = Invoke-Target @{ EVENT_NAME = 'push'; EVENT_BEFORE = '0000000000000000000000000000000000000000' }
$ok = (Assert-True 'D push unreachable before degrades loudly' ($r.Code -eq 0 -and $r.Out -match 'range base unavailable' -and $r.Base -eq $head1) `
    "exit $($r.Code), base '$($r.Base)': $($r.Out)") -and $ok

# E: push with a reachable event.before -> passes through, NO warning
$r = Invoke-Target @{ EVENT_NAME = 'push'; EVENT_BEFORE = $head1 }
$ok = (Assert-True 'E push valid before passes through' ($r.Code -eq 0 -and $r.Base -eq $head1 -and $r.Out -notmatch '::warning::') `
    "exit $($r.Code), base '$($r.Base)': $($r.Out)") -and $ok

# F: pull_request path — merge-base with the synthesized origin/<branch> = exactly c1.
# Deterministic here (the platform version had to SKIP without a real remote-tracking ref).
$r = Invoke-Target @{ EVENT_NAME = 'pull_request'; BASE_REF = $mainBranch }
$ok = (Assert-True 'F pull_request merge-base resolves to the fork point' ($r.Code -eq 0 -and $r.Base -eq $c1) `
    "exit $($r.Code), base '$($r.Base)' (want $c1): $($r.Out)") -and $ok

# G: PR merge-base failure in blocking mode -> loud error, no silent empty BASE
$r = Invoke-Target @{ EVENT_NAME = 'pull_request'; BASE_REF = '__no-such-branch__' }
$ok = (Assert-True 'G PR merge-base failure hard-fails (blocking)' ($r.Code -ne 0 -and $r.Out -match 'cannot resolve PR merge-base' -and -not $r.Base) `
    "exit $($r.Code), base '$($r.Base)': $($r.Out)") -and $ok

# H: the SAME PR failure in advisory mode -> exit 0 + warning + degrade
$r = Invoke-Target @{ EVENT_NAME = 'pull_request'; BASE_REF = '__no-such-branch__'; MODE = 'advisory' }
$ok = (Assert-True 'H PR merge-base failure degrades (advisory)' ($r.Code -eq 0 -and $r.Out -match '::warning::' -and $r.Base -eq $head1) `
    "exit $($r.Code), base '$($r.Base)': $($r.Out)") -and $ok

# I: dispatch WITHOUT a base input never hard-fails, even in blocking mode —
# only an EXPLICIT bad base does; empty input = documented degrade path
$r = Invoke-Target @{ EVENT_NAME = 'workflow_dispatch'; MODE = 'blocking' }
$ok = (Assert-True 'I dispatch without base degrades in blocking mode' ($r.Code -eq 0 -and $r.Out -match 'range base unavailable' -and $r.Base -eq $head1) `
    "exit $($r.Code), base '$($r.Base)': $($r.Out)") -and $ok

# J: unknown MODE is a loud config error — a typo'd mode: must never silently
# flip advisory back to blocking
$r = Invoke-Target @{ EVENT_NAME = 'workflow_dispatch'; DISPATCH_BASE = $badSha; MODE = 'Advisory' }
$ok = (Assert-True 'J unknown MODE fails loudly' ($r.Code -ne 0 -and $r.Out -match 'MODE must be') `
    "exit $($r.Code), base '$($r.Base)': $($r.Out)") -and $ok

# K: a dash-prefixed dispatch base is operator text in a git argument position (review
# 2026-08-10, med): it must fail as a clean blocking refusal — parsed as a REVISION that does
# not resolve, never as a git OPTION — and emit no base.
$r = Invoke-Target @{ EVENT_NAME = 'workflow_dispatch'; DISPATCH_BASE = '--all'; MODE = 'blocking' }
$ok = (Assert-True 'K dash-prefixed base refused cleanly (blocking)' ($r.Code -ne 0 -and $r.Out -match 'not an ancestor' -and -not $r.Base) `
    "exit $($r.Code), base '$($r.Base)': $($r.Out)") -and $ok
$r = Invoke-Target @{ EVENT_NAME = 'workflow_dispatch'; DISPATCH_BASE = '--all'; MODE = 'advisory' }
$ok = (Assert-True 'K2 the same value degrades in advisory mode' ($r.Code -eq 0 -and $r.Out -match '::warning::' -and $r.Base -eq $head1) `
    "exit $($r.Code), base '$($r.Base)': $($r.Out)") -and $ok

# L: a symbolic dispatch base (branch name) is CANONICALIZED — the value written to
# $GITHUB_OUTPUT must be the 40-hex commit id, never the operator's text (review 2026-08-10,
# med: downstream splices this output into range strings).
& git -C $repo branch basemark $head1 2>$null
$r = Invoke-Target @{ EVENT_NAME = 'workflow_dispatch'; DISPATCH_BASE = 'basemark'; MODE = 'blocking' }
$ok = (Assert-True 'L a ref-name base emerges as its 40-hex commit id' ($r.Code -eq 0 -and $r.Base -eq $head1) `
    "exit $($r.Code), base '$($r.Base)' (want $head1): $($r.Out)") -and $ok

Remove-FixtureRoot $fx

if (-not $ok) { Write-Host 'resolve-base selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'resolve-base selftest: all cases green' -ForegroundColor Green
exit 0
