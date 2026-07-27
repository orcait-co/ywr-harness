# Selftest for the two shipped git hooks (ADR 0015). They live under templates/ — payload this
# plugin COPIES rather than runs — but they are the only shipped artifacts that can block a commit
# or a push, so "template payload has no selftest here" is the wrong call for these two.
#
# The hooks are RUN, in real throwaway git repositories, against real staged changes and real
# commit ranges. Three findings in this line of work came from running the thing instead of
# asserting on its placement, and a hook is exactly the artifact whose placement tells you least.
#
# Two arms for pre-commit, deliberately:
#   * a STUB emitter, so the hook's parsing and execution contract is deterministic and does not
#     depend on ruff/eslint/uv being installed on the machine running the suite;
#   * the REAL vendored emitter, so the integration is exercised rather than assumed.

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot '../../lib/selftest-lib.ps1')   # assertion core, ADR 0125

$hooksSrc = Join-Path $PSScriptRoot 'templates/githooks'
$preCommit = Join-Path $hooksSrc 'pre-commit'
$prePush = Join-Path $hooksSrc 'pre-push'

foreach ($f in @($preCommit, $prePush)) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) {
        Write-Host "FAIL — hook template missing: $f" -ForegroundColor Red
        exit 1
    }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'SKIP [githooks] git absent (reported, not silent)' -ForegroundColor Yellow
    exit 0
}

function ConvertTo-ShPath([string]$P) {
    # Git's sh on Windows does not accept `C:\a\b` as a script argument — the backslashes are eaten
    # as escapes and it reports "No such file or directory" for a path that plainly exists.
    $full = [IO.Path]::GetFullPath($P)
    if (-not $IsWindows) { return $full }
    return '/' + $full.Substring(0, 1).ToLower() + ($full.Substring(2) -replace '\\', '/')
}

function Find-PosixShell {
    if (-not $IsWindows) {
        return (@('sh', 'bash') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1).Source
    }
    # GIT'S OWN sh, resolved from the git executable — not whatever `sh`/`bash` PATH happens to
    # offer. On this box the first `bash` on PATH is C:\Windows\System32\bash.exe, which is WSL: a
    # different filesystem namespace (/mnt/c, not /c), so every case failed with "No such file or
    # directory" on a path that existed. It is also simply the wrong interpreter to measure with —
    # git runs a hook through its own bundled sh, so that is what this suite must run.
    $gitCmd = (Get-Command git -ErrorAction SilentlyContinue).Source
    if ($gitCmd) {
        $gitRoot = Split-Path -Parent (Split-Path -Parent $gitCmd)
        foreach ($rel in @('usr\bin\sh.exe', 'bin\sh.exe', 'usr\bin\bash.exe', 'bin\bash.exe')) {
            $p = Join-Path $gitRoot $rel
            if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
        }
    }
    return $null
}

$shPath = Find-PosixShell
if (-not $shPath) {
    if ($env:CI) {
        Write-Host 'FAIL — no POSIX sh on CI; the hooks would ship unexercised' -ForegroundColor Red
        exit 1
    }
    Write-Host 'SKIP [githooks] no POSIX sh found (reported, not silent) — CI runs this gate' -ForegroundColor Yellow
    exit 0
}
$shCmd = @{ Source = $shPath }

# When git runs a hook it puts its own POSIX toolchain on PATH. Invoking sh.exe straight from
# PowerShell does not, so `awk`, `sed` and `grep` were missing and `sort` resolved to Windows'
# sort.exe — which made the hooks look broken and, worse, made four cases pass VACUOUSLY (the hook
# bailed early and exited 0, which several assertions read as success). Reproducing git's PATH is
# what makes this suite measure the hook instead of the launcher.
$shExtraPath = @()
if ($IsWindows) {
    $gitRoot = Split-Path -Parent (Split-Path -Parent (Get-Command git).Source)
    foreach ($d in @('usr\bin', 'bin', 'mingw64\bin')) {
        $p = Join-Path $gitRoot $d
        if (Test-Path -LiteralPath $p -PathType Container) { $shExtraPath += $p }
    }
}

# Probe the shell/path-form pairing before asserting anything. A namespace mismatch otherwise
# surfaces as a dozen unrelated-looking case failures rather than one legible line.
$probe = "$(& $shPath -c "test -f '$(ConvertTo-ShPath $prePush)' && echo OK" 2>&1)".Trim()
if ($probe -ne 'OK') {
    Write-Host "FAIL — $shPath cannot resolve $(ConvertTo-ShPath $prePush) (probe returned '$probe')" -ForegroundColor Red
    exit 1
}

$fxBase = New-FixtureRoot 'githooks-selftest'
trap { Remove-FixtureRoot $fxBase; break }
$ok = $true

function New-Repo([string]$Name) {
    $p = Join-Path $fxBase $Name
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    & git -C $p init -q 2>$null
    & git -C $p config user.email 'selftest@example.invalid' 2>$null
    & git -C $p config user.name 'selftest' 2>$null
    # An empty seed commit so HEAD exists; every case below diffs against something.
    & git -C $p commit -q --allow-empty -m seed 2>$null
    return $p
}
function Write-File([string]$Repo, [string]$Rel, [string]$Body) {
    $full = Join-Path $Repo $Rel
    $dir = Split-Path -Parent $full
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    # -NoNewline then an explicit LF keeps the fixtures byte-predictable across platforms.
    [IO.File]::WriteAllText($full, ($Body -replace "`r`n", "`n"))
}
function Invoke-Hook([string]$Repo, [string]$Hook, [string]$StdIn) {
    $sh = ConvertTo-ShPath $Hook
    $prevPath = $env:PATH
    Push-Location $Repo
    try {
        if ($shExtraPath.Count) { $env:PATH = ($shExtraPath -join ';') + ';' + $prevPath }
        if ($null -ne $StdIn) {
            # git feeds a hook LF-terminated lines. PowerShell's pipe into a native process writes
            # CRLF, and the trailing \r landed INSIDE the ref oid — `git rev-list <sha>\r..<sha>`
            # matched nothing, so the scan examined zero commits and reported a clean push. Four
            # cases went green on that. Byte-exact stdin from a file is the only faithful form.
            $stdinFile = Join-Path $fxBase ('stdin-' + [Guid]::NewGuid().ToString('N') + '.txt')
            [IO.File]::WriteAllText($stdinFile, (($StdIn -replace "`r`n", "`n") + "`n"))
            $out = (& $shCmd.Source -c "'$sh' < '$(ConvertTo-ShPath $stdinFile)'" 2>&1) | Out-String
        }
        else { $out = (& $shCmd.Source $sh 2>&1) | Out-String }
        return @{ Out = $out; Code = $LASTEXITCODE }
    } finally { $env:PATH = $prevPath; Pop-Location }
}

# =================================================================================================
# pre-commit
# =================================================================================================

# --- A: no emitter present -> reported skip, commit not blocked --------------------------------
$a = New-Repo 'pc-no-emitter'
Write-File $a 'x.py' "print(1)`n"
& git -C $a add -A 2>$null
$rA = Invoke-Hook $a $preCommit $null
$ok = (Assert-True 'A missing emitter does not block the commit' ($rA.Code -eq 0) "exit=$($rA.Code) out=$($rA.Out)") -and $ok
$ok = (Assert-True 'A missing emitter is REPORTED, not silent' ($rA.Out -match 'SKIP pre-commit gates') $rA.Out) -and $ok

# --- B: nothing staged -> no-op ----------------------------------------------------------------
$b = New-Repo 'pc-nothing-staged'
$rB = Invoke-Hook $b $preCommit $null
$ok = (Assert-True 'B nothing staged exits 0' ($rB.Code -eq 0) "exit=$($rB.Code) out=$($rB.Out)") -and $ok

# --- C-F: STUB emitter — the hook's parse + execute contract, independent of any linter ---------
# The stub prints an emitter-shaped block whose commands are shell builtins, so what is measured is
# the hook's behaviour and nothing else.
function New-StubRepo([string]$Name, [string]$GateBlock) {
    $p = New-Repo $Name
    $stub = @"
import sys
print("scope: 1 explicit file(s)")
print("gates:")
$GateBlock
print("review tier: small — stub")
"@
    Write-File $p 'scripts/harness/harness_gates.py' $stub
    Write-File $p 'app.py' "print(1)`n"
    & git -C $p add -A 2>$null
    return $p
}
$pyAvail = [bool](@('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1)
if (-not $pyAvail) {
    Write-Host 'SKIP [C-G pre-commit] python absent (reported, not silent) — CI has python' -ForegroundColor Yellow
} else {
    # C: a passing file-scoped gate runs and the commit proceeds
    $c = New-StubRepo 'pc-pass' 'print("  [g] 1 file(s)")
print("    true")'
    $rC = Invoke-Hook $c $preCommit $null
    $ok = (Assert-True 'C a passing gate lets the commit through' ($rC.Code -eq 0) "exit=$($rC.Code) out=$($rC.Out)") -and $ok
    $ok = (Assert-True 'C the command that ran is echoed' ($rC.Out -match '\$ true') $rC.Out) -and $ok
    $ok = (Assert-True 'C success is stated' ($rC.Out -match 'deterministic gates passed') $rC.Out) -and $ok

    # D: a FAILING gate blocks the commit. The whole point of the hook.
    $d = New-StubRepo 'pc-fail' 'print("  [g] 1 file(s)")
print("    false")'
    $rD = Invoke-Hook $d $preCommit $null
    $ok = (Assert-True 'D a failing gate BLOCKS the commit' ($rD.Code -eq 1) "exit=$($rD.Code) out=$($rD.Out)") -and $ok
    $ok = (Assert-True 'D the failing command is named' ($rD.Out -match 'FAIL \(\d+\): false') $rD.Out) -and $ok
    $ok = (Assert-True 'D the escape hatch is stated' ($rD.Out -match '--no-verify') $rD.Out) -and $ok

    # E: the "(no gate declared)" parenthetical must NOT be executed.
    # This is a real defect the shipped CI carried: the note is indented the same four spaces as a
    # command, so a naive parser hands `(no gate declared ...)` to sh, which opens a subshell and
    # dies with "no: command not found". The default .harness.json ships a group of exactly that
    # shape, so every scaffolded repo would have hit it.
    $e = New-StubRepo 'pc-parenthetical' 'print("  [g] 1 file(s)")
print("    (no gate declared for this group — nothing deterministic runs on it)")'
    $rE = Invoke-Hook $e $preCommit $null
    $ok = (Assert-True 'E a parenthetical note is not executed' ($rE.Code -eq 0) "exit=$($rE.Code) out=$($rE.Out)") -and $ok
    $ok = (Assert-True 'E and it is not mistaken for a command' ($rE.Out -notmatch 'command not found') $rE.Out) -and $ok

    # F: whole-program gates are deferred to CI, and the deferral is reported
    $f = New-StubRepo 'pc-whole' 'print("  [g] 1 file(s)")
print("    true")
print("    false   # whole-program: gate on slice files or newly introduced only")'
    $rF = Invoke-Hook $f $preCommit $null
    $ok = (Assert-True 'F whole-program gate is not run here' ($rF.Code -eq 0) "exit=$($rF.Code) out=$($rF.Out)") -and $ok
    $ok = (Assert-True 'F the deferral is reported, not silent' ($rF.Out -match '1 whole-program gate\(s\) NOT run here') $rF.Out) -and $ok

    # G: END-TO-END with the REAL vendored emitter. No stub, no linter dependency: a group that
    # matches files but declares no gates is the deterministic path through the real code.
    $g = New-Repo 'pc-e2e'
    New-Item -ItemType Directory -Force -Path (Join-Path $g 'scripts/harness') | Out-Null
    foreach ($n in @('harness_config.py', 'harness_gates.py')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "templates/scripts/harness/$n") -Destination (Join-Path $g "scripts/harness/$n") -Force
    }
    Write-File $g '.harness.json' '{ "groups": [ { "name": "src", "match": "^src/.*\\.py$", "gates": [] } ] }'
    Write-File $g 'src/app.py' "print(1)`n"
    & git -C $g add -A 2>$null
    $rG = Invoke-Hook $g $preCommit $null
    $ok = (Assert-True 'G end-to-end with the real emitter exits 0' ($rG.Code -eq 0) "exit=$($rG.Code) out=$($rG.Out)") -and $ok
    $ok = (Assert-True 'G the real parenthetical is not executed either' ($rG.Out -notmatch 'command not found') $rG.Out) -and $ok
}

# =================================================================================================
# pre-push — secret scan over ADDED lines of the pushed range
# =================================================================================================
function New-PushRepo([string]$Name) {
    $p = New-Repo $Name
    return $p
}
function Invoke-PrePush([string]$Repo, [string]$Base, [string]$Tip) {
    # git's contract: <local ref> <local oid> <remote ref> <remote oid>
    return Invoke-Hook $Repo $prePush "refs/heads/main $Tip refs/heads/main $Base"
}
function Add-Commit([string]$Repo, [string]$Rel, [string]$Body, [string]$Msg) {
    Write-File $Repo $Rel $Body
    & git -C $Repo add -A 2>$null
    & git -C $Repo commit -q -m $Msg 2>$null
    return (& git -C $Repo rev-parse HEAD 2>$null).Trim()
}

# A fake key that matches the AKIA pattern without being anyone's credential.
$fakeKey = 'AKIA' + ('IOSFODNN7EXAMPLE')

# --- H: a clean range passes -------------------------------------------------------------------
$h = New-PushRepo 'pp-clean'
$hBase = (& git -C $h rev-parse HEAD 2>$null).Trim()
$hTip = Add-Commit $h 'readme.md' "# hello`nnothing to see`n" 'clean'
$rH = Invoke-PrePush $h $hBase $hTip
$ok = (Assert-True 'H a clean range is not blocked' ($rH.Code -eq 0) "exit=$($rH.Code) out=$($rH.Out)") -and $ok
$ok = (Assert-True 'H the scan reports what it covered' ($rH.Out -match 'no secret pattern in added lines') $rH.Out) -and $ok

# --- I: a secret in an added line BLOCKS the push ----------------------------------------------
$i = New-PushRepo 'pp-secret'
$iBase = (& git -C $i rev-parse HEAD 2>$null).Trim()
$iTip = Add-Commit $i 'config.txt' "aws_key = $fakeKey`n" 'oops'
$rI = Invoke-PrePush $i $iBase $iTip
$ok = (Assert-True 'I an added secret blocks the push' ($rI.Code -eq 1) "exit=$($rI.Code) out=$($rI.Out)") -and $ok
$ok = (Assert-True 'I the pattern that matched is labelled' ($rI.Out -match 'aws-access-key-id') $rI.Out) -and $ok
$ok = (Assert-True 'I rotation is stated, not just rewriting' ($rI.Out -match 'rotate') $rI.Out) -and $ok

# --- I2: a pattern whose regex STARTS WITH A DASH still runs ------------------------------------
# Regression. `private-key-block` is `-----BEGIN [A-Z ]*PRIVATE KEY-----`, and the scan passed it
# to grep positionally — so grep read it as an option bundle, printed "unknown option", matched
# nothing, and the hook still reported a clean scan. Every other pattern starts with a letter, so
# the whole suite was green while one pattern was dead. Caught on a real push, not by this suite;
# `grep -e` is the fix. Assert the BLOCK, not the absence of the error text: a scanner that
# silently skips a pattern is indistinguishable from a clean scan unless you make it fire.
$i2 = New-PushRepo 'pp-dash-pattern'
$i2Base = (& git -C $i2 rev-parse HEAD 2>$null).Trim()
$i2Body = ('-' * 5) + 'BEGIN RSA PRIVATE KEY' + ('-' * 5) + "`nnot a real key`n"
$i2Tip = Add-Commit $i2 'id_rsa' $i2Body 'leaked a key block'
$rI2 = Invoke-PrePush $i2 $i2Base $i2Tip
$ok = (Assert-True 'I2 a leading-dash pattern still blocks the push' ($rI2.Code -eq 1) "exit=$($rI2.Code) out=$($rI2.Out)") -and $ok
$ok = (Assert-True 'I2 the private-key pattern is the one labelled' ($rI2.Out -match 'private-key-block') $rI2.Out) -and $ok
$ok = (Assert-True 'I2 grep did not reject the pattern as an option' ($rI2.Out -notmatch 'unknown option') $rI2.Out) -and $ok

# --- J: a secret already in history, outside the pushed range, is NOT re-flagged ---------------
# Otherwise every subsequent push is blocked by the same old line and people learn to --no-verify.
$jBase = (& git -C $i rev-parse HEAD 2>$null).Trim()
$jTip = Add-Commit $i 'other.txt' "harmless`n" 'later'
$rJ = Invoke-PrePush $i $jBase $jTip
$ok = (Assert-True 'J a pre-existing secret outside the range does not block' ($rJ.Code -eq 0) "exit=$($rJ.Code) out=$($rJ.Out)") -and $ok

# --- K: the allow marker exempts a line --------------------------------------------------------
$k = New-PushRepo 'pp-allow'
$kBase = (& git -C $k rev-parse HEAD 2>$null).Trim()
$kTip = Add-Commit $k 'doc.md' "example only: $fakeKey   harness:allow-secret`n" 'documented'
$rK = Invoke-PrePush $k $kBase $kTip
$ok = (Assert-True 'K an allow-marked line is exempt' ($rK.Code -eq 0) "exit=$($rK.Code) out=$($rK.Out)") -and $ok

# --- L: branch deletion is a no-op -------------------------------------------------------------
$rL = Invoke-Hook $k $prePush "(delete) 0000000000000000000000000000000000000000 refs/heads/gone $kBase"
$ok = (Assert-True 'L a branch deletion is not scanned' ($rL.Code -eq 0) "exit=$($rL.Code) out=$($rL.Out)") -and $ok

# --- M: the hook does not flag ITS OWN SOURCE --------------------------------------------------
# The pre-push script is a file full of secret regexes. If any of them matches the pattern list
# itself, then committing the hook — which is exactly what /harness-init makes a repo do — blocks
# the next push, and the harness becomes unshippable. Measured rather than reasoned about.
$m = New-PushRepo 'pp-self'
$mBase = (& git -C $m rev-parse HEAD 2>$null).Trim()
Copy-Item -LiteralPath $prePush -Destination (Join-Path $m 'pre-push-copy') -Force
Copy-Item -LiteralPath $preCommit -Destination (Join-Path $m 'pre-commit-copy') -Force
& git -C $m add -A 2>$null
& git -C $m commit -q -m 'add the hooks themselves' 2>$null
$mTip = (& git -C $m rev-parse HEAD 2>$null).Trim()
$rM = Invoke-PrePush $m $mBase $mTip
$ok = (Assert-True 'M the hooks do not flag their own source' ($rM.Code -eq 0) "exit=$($rM.Code) out=$($rM.Out)") -and $ok

# --- N: the generic assigned-secret pattern still catches a real-looking assignment ------------
# M could pass trivially if the patterns matched nothing at all. This is the control for it.
$n = New-PushRepo 'pp-generic'
$nBase = (& git -C $n rev-parse HEAD 2>$null).Trim()
$nTip = Add-Commit $n 'settings.py' "api_key = 'zK3nQ8vR1tYw0pLmXs74'`n" 'generic'
$rN = Invoke-PrePush $n $nBase $nTip
$ok = (Assert-True 'N a generic assigned secret is caught' ($rN.Code -eq 1) "exit=$($rN.Code) out=$($rN.Out)") -and $ok
$ok = (Assert-True 'N labelled as the generic pattern' ($rN.Out -match 'generic-assigned-secret') $rN.Out) -and $ok

Remove-FixtureRoot $fxBase

if (-not $ok) { Write-Host 'githooks selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'githooks selftest: all cases green' -ForegroundColor Green
exit 0
