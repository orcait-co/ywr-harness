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

# --- B2..B6: a committed enabledPlugins is refused (ADR 0022, supersedes 0021) ------------------
# Deliberately OUTSIDE the $pyAvail block below. The gate protects ADR 0010's non-forcing invariant,
# so it must fire in a repo with no emitter and no python — these fixtures have neither, which is
# what proves the check runs ahead of both skip paths.
$b2 = New-Repo 'pc-enabled-plugins'
Write-File $b2 '.claude/settings.json' "{`n  `"enabledPlugins`": { `"ywr-harness@ywrlabs`": true }`n}`n"
& git -C $b2 add -A 2>$null
$rB2 = Invoke-Hook $b2 $preCommit $null
$ok = (Assert-True 'B2 a staged enabledPlugins BLOCKS the commit' ($rB2.Code -eq 1) "exit=$($rB2.Code) out=$($rB2.Out)") -and $ok
$ok = (Assert-True 'B2 the forcing consequence is stated, not just the rule' ($rB2.Out -match 'forces the plugin on everyone') $rB2.Out) -and $ok
$ok = (Assert-True 'B2 the governing ADRs are named' ($rB2.Out -match 'ADR 0010/0022') $rB2.Out) -and $ok

# B3 is the control for B2/B4/B5. Without it, a check that refused .claude/settings.json
# unconditionally — or one that refused every commit — would score identically to the one we want
# (the unmutated-control lesson, ADR 0013). The file is staged; only the forbidden KEY is absent.
$b3 = New-Repo 'pc-settings-no-key'
Write-File $b3 '.claude/settings.json' "{`n  `"permissions`": { `"allow`": [] }`n}`n"
& git -C $b3 add -A 2>$null
$rB3 = Invoke-Hook $b3 $preCommit $null
$ok = (Assert-True 'B3 the same file WITHOUT the key is not blocked' ($rB3.Code -eq 0) "exit=$($rB3.Code) out=$($rB3.Out)") -and $ok
$ok = (Assert-True 'B3 and it is not reported as refused' ($rB3.Out -notmatch 'REFUSED') $rB3.Out) -and $ok

# B4: the file ADR 0021 missed. `--scope local` writes the SAME key into settings.local.json, in
# the tree — measured, and 0021's own refusal message recommended that scope as the fix. A gate
# that names one filename and recommends the other is worse than no gate.
$b4 = New-Repo 'pc-enabled-plugins-local'
Write-File $b4 '.claude/settings.local.json' "{`n  `"enabledPlugins`": { `"ywr-harness@ywrlabs`": true }`n}`n"
# `add -f`, and the reason IS the defect: this author's machine carries a GLOBAL gitignore entry for
# .claude/settings.local.json, so `add -A` silently stages nothing here and the case would pass
# vacuously. No teammate inherits that global file — on their machine the path is perfectly
# trackable, which is exactly how ADR 0021 came to believe the file "is ignored by convention".
& git -C $b4 add -f .claude/settings.local.json 2>$null
$rB4 = Invoke-Hook $b4 $preCommit $null
$ok = (Assert-True 'B4 settings.local.json is gated too' ($rB4.Code -eq 1) "exit=$($rB4.Code) out=$($rB4.Out)") -and $ok
$ok = (Assert-True 'B4 the refusal names the local file' ($rB4.Out -match 'settings\.local\.json declares') $rB4.Out) -and $ok
$ok = (Assert-True 'B4 rescoping is explicitly not a fix' ($rB4.Out -match 'not a fix') $rB4.Out) -and $ok

# B5: an uninstall leaves `{ "enabledPlugins": {} }` behind. ADR 0022 refuses the KEY regardless of
# value, so the inert form is refused too — a deliberate false positive, not an oversight.
$b5 = New-Repo 'pc-enabled-plugins-empty'
Write-File $b5 '.claude/settings.json' "{`n  `"enabledPlugins`": {}`n}`n"
& git -C $b5 add -A 2>$null
$rB5 = Invoke-Hook $b5 $preCommit $null
$ok = (Assert-True 'B5 an inert empty enabledPlugins is refused too' ($rB5.Code -eq 1) "exit=$($rB5.Code) out=$($rB5.Out)") -and $ok
$ok = (Assert-True 'B5 the uninstall residue is explained' ($rB5.Out -match 'remove the key, not just the entry') $rB5.Out) -and $ok

# B6: the hook's KNOWN limit, asserted so it stays known. A \uXXXX-escaped key is the same key to
# any JSON parser and to the host, but a literal grep cannot see it. CI parses and catches this;
# this case exists so the gap is a recorded property rather than a surprise (ADR 0022 Consequences).
$b6 = New-Repo 'pc-enabled-plugins-escaped'
# The escape is ASSEMBLED, not typed: a literal backslash-u in source is the kind of thing an editor
# or a copy-paste normalises away, and a fixture that silently degrades to the plain spelling would
# invert this case's meaning without failing.
$escKey = [char]0x5C + 'u0065' + 'nabledPlugins'   # -> enabledPlugins, i.e. "enabledPlugins"
Write-File $b6 '.claude/settings.json' "{`n  `"$escKey`": { `"p@m`": true }`n}`n"
& git -C $b6 add -A 2>$null
$rB6 = Invoke-Hook $b6 $preCommit $null
$ok = (Assert-True 'B6 the hook does NOT catch an escaped key (known limit, CI does)' ($rB6.Code -eq 0) "exit=$($rB6.Code) out=$($rB6.Out)") -and $ok

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

    # E5: an ungrouped file is REPORTED at commit time (ADR 0062, issue #55). CI fails on the
    # emitter's `ungrouped (` header; the hook does not — the line closes the local/CI asymmetry
    # without changing the advisory exit contract, so the commit still proceeds. The stub prints
    # the header VERBATIM as harness_gates.py emits it since ADR 0062 (long tail, em dashes) — a
    # fixture with the old short text would keep passing while the real parser drifted (review
    # 2026-08-28, medium); case G below is the end-to-end pairing with the real emitter.
    $e5 = New-StubRepo 'pc-ungrouped' 'print("  [g] 1 file(s)")
print("    true")
print("ungrouped (1 file(s) — no declared group matched, so NO deterministic gate covers them; CI''s harness-gates run FAILS on this — add a groups entry to .harness.json):")
print("  weird.rb")'
    $rE5 = Invoke-Hook $e5 $preCommit $null
    $ok = (Assert-True 'E5 an ungrouped file is named as a CI failure at commit time' ($rE5.Out -match '1 staged file\(s\) matched NO declared group') $rE5.Out) -and $ok
    $ok = (Assert-True 'E5 but it does not block the commit' ($rE5.Code -eq 0) "exit=$($rE5.Code) out=$($rE5.Out)") -and $ok
    $ok = (Assert-True 'E5 the gate before the header still ran' ($rE5.Out -match '\$ true') $rE5.Out) -and $ok

    # E2/E3: the no-commands report distinguishes DECLARED coverage from a coverage HOLE
    # (issue #45). One message conflated them: files matching groups that declare `gates: []`
    # read identically to files no group claims, and only the second is a warning.
    # E2 — no group header in the window at all: the coverage-hole wording stays.
    $e2 = New-StubRepo 'pc-unmatched' 'print("  (none — no declared group matched, matched groups declare no gates, or every declared gate was refused or skipped)")'
    $rE2 = Invoke-Hook $e2 $preCommit $null
    $ok = (Assert-True 'E2 unmatched files keep the no-match wording' ($rE2.Code -eq 0 -and $rE2.Out -match 'no file-scoped gate matched') "exit=$($rE2.Code) out=$($rE2.Out)") -and $ok
    $ok = (Assert-True 'E2 and are not reported as matched' ($rE2.Out -notmatch 'matched group\(s\)') $rE2.Out) -and $ok

    # E3 — groups matched but yield nothing runnable: the groups are NAMED and the no-match
    # wording must not appear.
    $e3 = New-StubRepo 'pc-matched-no-gates' 'print("  [scripts] 3 file(s)")
print("    (no gate declared for this group — nothing deterministic runs on it)")
print("  [meta] 1 file(s)")
print("    (no gate declared for this group — nothing deterministic runs on it)")'
    $rE3 = Invoke-Hook $e3 $preCommit $null
    $ok = (Assert-True 'E3 matched-but-gateless names the groups' ($rE3.Code -eq 0 -and $rE3.Out -match 'matched group\(s\) \[scripts, meta\]') "exit=$($rE3.Code) out=$($rE3.Out)") -and $ok
    $ok = (Assert-True 'E3 and does not claim nothing matched' ($rE3.Out -notmatch 'no file-scoped gate matched') $rE3.Out) -and $ok

    # E4: a group name carrying ']' survives the extraction whole — cutting at the FIRST ']'
    # misnamed the group in the report (review 2026-08-12, nit; names reach an echo only).
    $e4 = New-StubRepo 'pc-bracket-name' 'print("  [we]ird] 2 file(s)")
print("    (no gate declared for this group — nothing deterministic runs on it)")'
    $rE4 = Invoke-Hook $e4 $preCommit $null
    $ok = (Assert-True 'E4 a bracketed group name is reported whole' ($rE4.Code -eq 0 -and $rE4.Out -match 'matched group\(s\) \[we\]ird\],') "exit=$($rE4.Code) out=$($rE4.Out)") -and $ok

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
    $ok = (Assert-True 'G the real emitter output yields the matched-group wording (issue #45)' ($rG.Out -match 'matched group\(s\) \[src\]') $rG.Out) -and $ok
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
