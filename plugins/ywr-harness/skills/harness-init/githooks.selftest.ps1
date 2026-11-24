# Selftest for the shipped git hooks (ADR 0015; post-commit ADR 0017; commit-msg ADR 0208). They live under templates/ —
# payload this plugin COPIES rather than runs — but pre-commit and pre-push are the only shipped
# artifacts that can block a commit or a push, so "template payload has no selftest here" is the
# wrong call for them. post-commit cannot block anything; its cases (P) exist because every one of
# its branches exits 0, so only running it shows which branch a repo actually gets.
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
. (Join-Path $PSScriptRoot '../../lib/selftest-lib.ps1')   # assertion core

$hooksSrc = Join-Path $PSScriptRoot 'templates/githooks'
$preCommit = Join-Path $hooksSrc 'pre-commit'
$prePush = Join-Path $hooksSrc 'pre-push'
$postCommit = Join-Path $hooksSrc 'post-commit'
$commitMsg = Join-Path $hooksSrc 'commit-msg'

foreach ($f in @($preCommit, $prePush, $postCommit, $commitMsg)) {
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

# The launcher path, kept for P5's git shim: that case's PATH is narrowed to one dir and must keep
# resolving the same git it always did, so the shim must not follow the worker-dir prepend below.
$gitLauncher = (Get-Command git).Source
# ~370 git calls (fixture builds plus the hooks' own): the worker binary, not the cmd\git.exe launcher
# (lib Use-GitWorkerBinary, ADR 0111). After the resolutions above, which read git's root from
# `(Get-Command git).Source` and need the launcher's layout. Left in place — under `pwsh -File` the
# process ends with it. Every PATH this suite builds starts from the then-current $env:PATH, so the
# worker dir rides along; P5 REPLACES the PATH outright, so it never sees it.
$null = Use-GitWorkerBinary
# Fixture identity through the environment, once: a per-repo `git config user.*` was two spawns per
# fixture repo. No hook under test and no case reads a repo-local user.* value.
$env:GIT_AUTHOR_NAME = 'selftest'; $env:GIT_COMMITTER_NAME = 'selftest'
$env:GIT_AUTHOR_EMAIL = 'selftest@example.invalid'; $env:GIT_COMMITTER_EMAIL = 'selftest@example.invalid'

$fxBase = New-FixtureRoot 'githooks-selftest'
trap { Remove-FixtureRoot $fxBase; break }
$ok = $true

function New-Repo([string]$Name) {
    $p = Join-Path $fxBase $Name
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    & git -C $p init -q 2>$null
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
function Invoke-Hook([string]$Repo, [string]$Hook, [string]$StdIn, [string]$PathOverride = '', [switch]$NoFinalNewline) {
    $sh = ConvertTo-ShPath $Hook
    $prevPath = $env:PATH
    Push-Location $Repo
    try {
        # $PathOverride REPLACES the hook's PATH (no git toolchain prepended) — the P5 no-python arm.
        if ($PathOverride) { $env:PATH = $PathOverride }
        elseif ($shExtraPath.Count) { $env:PATH = ($shExtraPath -join ';') + ';' + $prevPath }
        if ($null -ne $StdIn) {
            # git feeds a hook LF-terminated lines. PowerShell's pipe into a native process writes
            # CRLF, and the trailing \r landed INSIDE the ref oid — `git rev-list <sha>\r..<sha>`
            # matched nothing, so the scan examined zero commits and reported a clean push. Four
            # cases went green on that. Byte-exact stdin from a file is the only faithful form.
            $stdinFile = Join-Path $fxBase ('stdin-' + [Guid]::NewGuid().ToString('N') + '.txt')
            # -NoFinalNewline is the one caller that is not git: a tool that hands the hook an unterminated last line.
            [IO.File]::WriteAllText($stdinFile, (($StdIn -replace "`r`n", "`n") + $(if ($NoFinalNewline) { '' } else { "`n" })))
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

    # D2: a gate whose RUNNER is not on PATH is a counted, reported SKIP — never FAILED (ADR 0015:
    # "a missing interpreter is a reported skip"; dist issue #6: a member without uv was blocked on
    # every commit and --no-verify, which also skips the enabledPlugins refusal, was the only way
    # out). The `true` after it proves the loop continues past the skip; D above is the control that
    # a runner which exists and fails still blocks.
    $d2 = New-StubRepo 'pc-missing-runner' 'print("  [g] 1 file(s)")
print("    ywr-no-such-runner check app.py")
print("    true")'
    $rD2 = Invoke-Hook $d2 $preCommit $null
    $ok = (Assert-True 'D2 a missing runner does not block the commit' ($rD2.Code -eq 0) "exit=$($rD2.Code) out=$($rD2.Out)") -and $ok
    $ok = (Assert-True 'D2 the skip names the runner and says CI still gates' ($rD2.Out -match "SKIP \(runner 'ywr-no-such-runner' not on PATH" -and $rD2.Out -match 'reported, not silent; CI still gates this commit\): ywr-no-such-runner check app\.py') $rD2.Out) -and $ok
    $ok = (Assert-True 'D2 a missing runner is not reported as a FAIL' ($rD2.Out -notmatch 'FAIL \(' -and $rD2.Out -notmatch 'gates FAILED') $rD2.Out) -and $ok
    $ok = (Assert-True 'D2 the loop continues past the skip' ($rD2.Out -match '\$ true') $rD2.Out) -and $ok
    $ok = (Assert-True 'D2 the summary counts the skip and does not call it passed' ($rD2.Out -match '1 gate\(s\) passed, 1 SKIPPED' -and $rD2.Out -notmatch 'deterministic gates passed') $rD2.Out) -and $ok

    # D2b: the `cd <cwd> && <runner> …` shape compose() gives a `groups[].cwd` gate. The runner is
    # the 4th token, as in CI's extraction — reading the first would test `cd`, a builtin that is
    # always found, and the gate would die 127 as a FAIL. `sub/` exists so that mutant's `cd`
    # succeeds and the failure is the runner's, not the directory's.
    $d2b = New-StubRepo 'pc-missing-runner-cwd' 'print("  [g] 1 file(s)")
print("    cd sub && ywr-no-such-runner check x.txt")'
    Write-File $d2b 'sub/x.txt' "x`n"
    & git -C $d2b add -A 2>$null
    $rD2b = Invoke-Hook $d2b $preCommit $null
    $ok = (Assert-True 'D2b a cwd-composed gate derives its runner from the 4th token and skips it' ($rD2b.Code -eq 0 -and $rD2b.Out -match "SKIP \(runner 'ywr-no-such-runner'" -and $rD2b.Out -notmatch 'FAIL \(') "exit=$($rD2b.Code) out=$($rD2b.Out)") -and $ok

    # D2c: the cwd shape with a runner that EXISTS and fails still blocks — the preflight must not
    # swallow a real failure behind the `cd` prefix.
    $d2c = New-StubRepo 'pc-cwd-fail' 'print("  [g] 1 file(s)")
print("    cd sub && false")'
    Write-File $d2c 'sub/x.txt' "x`n"
    & git -C $d2c add -A 2>$null
    $rD2c = Invoke-Hook $d2c $preCommit $null
    $ok = (Assert-True 'D2c a cwd-composed gate whose runner exists and fails still BLOCKS' ($rD2c.Code -eq 1 -and $rD2c.Out -match 'FAIL \(\d+\): cd sub && false' -and $rD2c.Out -notmatch 'SKIP \(runner') "exit=$($rD2c.Code) out=$($rD2c.Out)") -and $ok

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

    # G2: END-TO-END with a declared artifact check (ADR 0068) — the coverage gap that let the
    # first cut ship: the emitter's `  [artifacts]` header shares the group-header shape, and
    # the MATCHED_GROUPS awk spliced its unstripped tail into the report (review 2026-08-31,
    # high — 'matched group(s) [src, artifacts] 1 declared drift check(s) …]'). The check line
    # itself must be DEFERRED (whole-program), never run here.
    $g2 = New-Repo 'pc-e2e-art'
    New-Item -ItemType Directory -Force -Path (Join-Path $g2 'scripts/harness'), (Join-Path $g2 'docs') | Out-Null
    foreach ($n in @('harness_config.py', 'harness_gates.py')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "templates/scripts/harness/$n") -Destination (Join-Path $g2 "scripts/harness/$n") -Force
    }
    $g2url = 'https://claude.ai/code/artifact/00000000-0000-0000-0000-00000000ab68'
    Write-File $g2 '.harness.json' ('{ "artifacts": { "readme": "README.md", "items": [ { "url": "' + $g2url + '", "title": "pc-e2e-art · docs", "source": "docs/page.html", "check": { "runner": "python", "script": "scripts/check_drift.py" } } ] }, "groups": [ { "name": "src", "match": "^src/.*\\.py$", "gates": [] } ] }')
    Write-File $g2 'README.md' "docs: $g2url"
    Write-File $g2 'docs/page.html' '<p>page</p>'
    Write-File $g2 'scripts/check_drift.py' 'print("CHECK-RAN")'
    Write-File $g2 'src/app.py' "print(1)`n"
    & git -C $g2 add -A 2>$null
    $rG2 = Invoke-Hook $g2 $preCommit $null
    $ok = (Assert-True 'G2 artifact-check e2e exits 0' ($rG2.Code -eq 0) "exit=$($rG2.Code) out=$($rG2.Out)") -and $ok
    $ok = (Assert-True 'G2 the matched-group report stays clean — the [artifacts] header is not spliced in' ($rG2.Out -match 'matched group\(s\) \[src\]' -and $rG2.Out -notmatch 'declared drift check\(s\).*\],|\[src, artifacts') $rG2.Out) -and $ok
    $ok = (Assert-True 'G2 the check is deferred to CI, not run by the hook' ($rG2.Out -notmatch 'CHECK-RAN' -and $rG2.Out -match 'whole-program gate\(s\) deferred to CI') $rG2.Out) -and $ok

    # G3: END-TO-END, a non-ASCII staged path under core.quotepath=true (Git for Windows' default;
    # dist issue #6). Unpinned, the hook's STAGED list carried `"docs/\355\225\234...md"` — quoted,
    # octal-escaped — the real emitter reported it ungrouped, and the hook printed a FALSE
    # "matched NO declared group — CI's harness-gates run FAILS" line for a file CI groups
    # correctly (loud, not silent). The pin fixes group matching only; G3b pins what it does not
    # change. The emitter and declaration are COMMITTED first so the Korean file is the
    # only staged path; the name is built from code points (U+D55C U+AE00) so no editor or codepage
    # can rewrite the fixture. The unpinned read is asserted quoted first — without that, a machine
    # whose git never quotes would pass this case vacuously.
    $g3 = New-Repo 'pc-e2e-quotepath'
    New-Item -ItemType Directory -Force -Path (Join-Path $g3 'scripts/harness') | Out-Null
    foreach ($n in @('harness_config.py', 'harness_gates.py')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "templates/scripts/harness/$n") -Destination (Join-Path $g3 "scripts/harness/$n") -Force
    }
    Write-File $g3 '.harness.json' '{ "groups": [ { "name": "docs", "match": "^docs/", "gates": [] } ] }'
    & git -C $g3 add -A 2>$null
    & git -C $g3 commit -q -m 'emitter + declaration' 2>$null
    & git -C $g3 config core.quotepath true 2>$null
    $kRel = 'docs/' + [string]::new([char[]]@([char]0xD55C, [char]0xAE00)) + '.md'
    New-Item -ItemType Directory -Force -Path (Join-Path $g3 'docs') | Out-Null
    [IO.File]::WriteAllText((Join-Path $g3 $kRel), "# k`n", [Text.UTF8Encoding]::new($false))
    & git -C $g3 add -A 2>$null
    $g3Raw = "$(& git -C $g3 diff --cached --name-only 2>$null)".Trim()
    $ok = (Assert-True 'G3 fixture: the UNPINNED staged list is quoted and octal-escaped (case is not vacuous)' ($g3Raw -match '^"docs/\\355\\225\\234\\352\\270\\200\.md"$') "raw=$g3Raw") -and $ok
    $rG3 = Invoke-Hook $g3 $preCommit $null
    $ok = (Assert-True 'G3 a non-ASCII staged path matches its group under core.quotepath=true' ($rG3.Code -eq 0 -and $rG3.Out -match 'matched group\(s\) \[docs\]') "exit=$($rG3.Code) out=$($rG3.Out)") -and $ok
    $ok = (Assert-True 'G3 and it is not reported as ungrouped' ($rG3.Out -notmatch 'matched NO declared group') $rG3.Out) -and $ok
    # G3b: what the pin does NOT change, pinned so the hook's comment cannot overclaim again
    # (review 2026-09-23, nit). A non-ASCII name fails the emitter's SAFE_TOKEN gate, so even
    # matched it never becomes a file-scoped gate argument — here exactly as in CI. The group gains
    # a file-scoped gate (working tree only; the staged list is still the one Korean file): the
    # exclusion is REPORTED and no gate command is composed or run for it.
    Write-File $g3 '.harness.json' '{ "groups": [ { "name": "docs", "match": "^docs/", "gates": ["shellcheck"] } ] }'
    $rG3b = Invoke-Hook $g3 $preCommit $null
    $ok = (Assert-True 'G3b a matched non-ASCII path is still EXCLUDED from file-scoped gate arguments — reported, and no gate runs on it' ($rG3b.Code -eq 0 -and $rG3b.Out -match 'could not be passed' -and $rG3b.Out -match 'matched group\(s\) \[docs\], but none yields a runnable file-scoped gate' -and $rG3b.Out -notmatch 'shellcheck docs/') "exit=$($rG3b.Code) out=$($rG3b.Out)") -and $ok

    # G4: END-TO-END, a route-path file argument (ADR 0112). The real emitter single-quotes
    # `src/app/(admin)/…` and `src/app/[id]/…`; the hook's `set -f` runner split and its `sh -c` must
    # hand both to the gate literally. A stub `shellcheck` first on PATH prints the argv it RECEIVED.
    # The decoy `src/app/i/page.sh` is committed, not staged: a glob of `[id]` would hand IT over.
    $g4 = New-Repo 'pc-e2e-routes'
    New-Item -ItemType Directory -Force -Path (Join-Path $g4 'scripts/harness') | Out-Null
    foreach ($n in @('harness_config.py', 'harness_gates.py')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "templates/scripts/harness/$n") -Destination (Join-Path $g4 "scripts/harness/$n") -Force
    }
    Write-File $g4 '.harness.json' '{ "groups": [ { "name": "sh", "match": "^src/", "gates": ["shellcheck"] } ] }'
    Write-File $g4 'src/app/i/page.sh' "echo i`n"
    & git -C $g4 add -A 2>$null
    & git -C $g4 commit -q -m 'emitter + declaration + decoy' 2>$null
    Write-File $g4 'src/app/(admin)/page.sh' "echo a`n"
    Write-File $g4 'src/app/[id]/page.sh' "echo b`n"
    & git -C $g4 add -A 2>$null
    $g4Stub = Join-Path $fxBase 'g4-stub'
    Write-File $g4Stub 'shellcheck' "#!/bin/sh`nprintf 'STUB shellcheck '`nfor a in `"`$@`"; do printf '<%s>' `"`$a`"; done`nprintf '\n'`n"
    if (-not $IsWindows) { & chmod +x (Join-Path $g4Stub 'shellcheck') }
    $g4Path = $env:PATH
    try {
        $env:PATH = $g4Stub + [IO.Path]::PathSeparator + $env:PATH
        $rG4 = Invoke-Hook $g4 $preCommit $null
    } finally { $env:PATH = $g4Path }
    $ok = (Assert-True 'G4 route-path files reach the file-scoped gate literally, one argument each, and the hook passes' ($rG4.Code -eq 0 -and $rG4.Out -match 'STUB shellcheck <src/app/\(admin\)/page\.sh><src/app/\[id\]/page\.sh>') "exit=$($rG4.Code) out=$($rG4.Out)") -and $ok
    $ok = (Assert-True 'G4 the committed decoy is not globbed in, and nothing is reported excluded' ($rG4.Out -notmatch 'src/app/i/page\.sh' -and $rG4.Out -notmatch 'could not be passed') $rG4.Out) -and $ok
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

# --- I3/I4: added lines that are not valid text are still scanned (dist issue #9) ----------------
# Regression. Under a UTF-8 locale — every Linux CI runner — GNU grep dropped each added line that
# was not valid UTF-8 (a CP949 fixture), printed "binary file matches" on stderr, and the hook still
# reported the commit scanned and clean. The hook now scans in the C locale with `grep -a`. The
# suite FORCES a UTF-8 locale for these runs, so the case reproduces on Windows' Git sh as well as
# on Linux, and proves the hook overrides the caller's locale. I3's generic secret has the CP949
# bytes INSIDE its quoted value: `grep -a` alone would still miss it under UTF-8 (an invalid byte
# matches no bracket class there), so the C locale is what I3 measures. I4 is a NUL byte in a diff
# git prints as text (the `diff` attribute), the binary trigger the C locale does not remove — `-a`
# is what I4 measures.
$enc = [Text.Encoding]::ASCII
$cp949 = [byte[]](0xB0, 0xA1, 0xB0, 0xA1)   # two Hangul syllables in CP949; invalid as UTF-8
$prevLcAll = $env:LC_ALL
try {
    $env:LC_ALL = 'C.UTF-8'
    $i3 = New-PushRepo 'pp-non-utf8'
    $i3Base = (& git -C $i3 rev-parse HEAD 2>$null).Trim()
    [IO.File]::WriteAllBytes((Join-Path $i3 'schema.df'), [byte[]](
            $enc.GetBytes("aws = $fakeKey ") + $cp949 + $enc.GetBytes("`n") +
            $enc.GetBytes("api_key = '") + $cp949 + $enc.GetBytes("zK3nQ8vR1tYw0pLm'`n")))
    & git -C $i3 add -A 2>$null
    & git -C $i3 commit -q -m 'cp949 fixture' 2>$null
    $i3Tip = (& git -C $i3 rev-parse HEAD 2>$null).Trim()
    $rI3 = Invoke-PrePush $i3 $i3Base $i3Tip

    $i4 = New-PushRepo 'pp-nul-text'
    $i4Base = (& git -C $i4 rev-parse HEAD 2>$null).Trim()
    Write-File $i4 '.gitattributes' "*.dat diff`n"
    [IO.File]::WriteAllBytes((Join-Path $i4 'dump.dat'), [byte[]](
            $enc.GetBytes("aws = $fakeKey ") + [byte[]](0x00) + $enc.GetBytes("`n")))
    & git -C $i4 add -A 2>$null
    & git -C $i4 commit -q -m 'nul in a text diff' 2>$null
    $i4Tip = (& git -C $i4 rev-parse HEAD 2>$null).Trim()
    $rI4 = Invoke-PrePush $i4 $i4Base $i4Tip
} finally { $env:LC_ALL = $prevLcAll }
$ok = (Assert-True 'I3 a non-UTF-8 added line blocks the push under a UTF-8 locale' ($rI3.Code -eq 1 -and $rI3.Out -match 'aws-access-key-id') "exit=$($rI3.Code) out=$($rI3.Out)") -and $ok
$ok = (Assert-True 'I3 a secret whose value holds non-UTF-8 bytes is caught' ($rI3.Out -match 'generic-assigned-secret') $rI3.Out) -and $ok
$ok = (Assert-True 'I3 grep treated no line as binary' ($rI3.Out -notmatch '(?i)binary file') $rI3.Out) -and $ok
$ok = (Assert-True 'I4 a NUL byte in a text diff does not hide the line' ($rI4.Code -eq 1 -and $rI4.Out -match 'aws-access-key-id' -and $rI4.Out -notmatch '(?i)binary file') "exit=$($rI4.Code) out=$($rI4.Out)") -and $ok
# The block message must fit a hit in an earlier commit: there "amend" changes the wrong commit.
$ok = (Assert-True 'I3 the block message names the rebase route for a non-tip commit' ($rI3.Out -match 'rebase' -and $rI3.Out -match 'later commit cannot clear') $rI3.Out) -and $ok

# --- I5: a commit list git FAILED to produce is never an empty list ----------------------------------
# A force-push over commits that exist only on the remote hands the hook a remote oid that is no local
# object, so `git rev-list <remote>..<local>` fails. That was read as "nothing to scan" and the push
# passed the secret scan unread. The hook now scans every commit not on a remote instead, and blocks
# loudly when even that list cannot be made. An EMPTY list with exit 0 stays a quiet pass (I5e).
# A loop run costs about 1.5 s per commit on Windows, so the fixtures here are as small as the claim
# allows, and I6c reuses the secret repo.
$i5Gone = 'ab' * 20      # a well-formed oid that no object database holds
$i5 = New-PushRepo 'pp-unfetched'
$i5Clean = Add-Commit $i5 'readme.md' "nothing to see`n" 'clean commit'
$rI5b = Invoke-PrePush $i5 $i5Gone $i5Clean
$rI5c = Invoke-PrePush $i5 $i5Gone ('cd' * 20)
$rI5d = Invoke-PrePush $i5 ('0' * 40) ('cd' * 20)
$rI5e1 = Invoke-PrePush $i5 $i5Clean $i5Clean
& git -C $i5 update-ref refs/remotes/origin/main $i5Clean 2>$null
$rI5e2 = Invoke-PrePush $i5 ('0' * 40) $i5Clean
$i5s = New-PushRepo 'pp-unfetched-secret'
$i5Secret = Add-Commit $i5s 'config.txt' "aws_key = $fakeKey`n" 'secret commit'
$rI5a = Invoke-PrePush $i5s $i5Gone $i5Secret
$ok = (Assert-True 'I5a an unknown remote oid still scans, and a secret in a commit on no remote BLOCKS' ($rI5a.Code -eq 1 -and $rI5a.Out -match 'aws-access-key-id' -and $rI5a.Out -match 'possible secret') "exit=$($rI5a.Code) out=$($rI5a.Out)") -and $ok
$ok = (Assert-True 'I5b clean commits behind an unknown remote oid pass, and the output says the wider scan ran' ($rI5b.Code -eq 0 -and $rI5b.Out -match 'not a local object' -and $rI5b.Out -match 'scanning every commit' -and $rI5b.Out -match 'no secret pattern') "exit=$($rI5b.Code) out=$($rI5b.Out)") -and $ok
$ok = (Assert-True 'I5c when the wider list fails too the push is BLOCKED loudly, naming the ref' ($rI5c.Code -eq 1 -and $rI5c.Out -match 'pre-push BLOCKED' -and $rI5c.Out -match 'could not be resolved' -and $rI5c.Out -match 'refs/heads/main' -and $rI5c.Out -notmatch 'no secret pattern') "exit=$($rI5c.Code) out=$($rI5c.Out)") -and $ok
$ok = (Assert-True 'I5d a failed new-branch list is BLOCKED loudly too' ($rI5d.Code -eq 1 -and $rI5d.Out -match 'pre-push BLOCKED' -and $rI5d.Out -match 'could not be resolved' -and $rI5d.Out -notmatch 'no secret pattern') "exit=$($rI5d.Code) out=$($rI5d.Out)") -and $ok
$ok = (Assert-True 'I5e an EMPTY list with exit 0 is still a quiet pass, on an existing branch and on a new one' ($rI5e1.Code -eq 0 -and $rI5e1.Out.Trim() -eq '' -and $rI5e2.Code -eq 0 -and $rI5e2.Out.Trim() -eq '') "existing: exit=$($rI5e1.Code) out=$($rI5e1.Out) new: exit=$($rI5e2.Code) out=$($rI5e2.Out)") -and $ok

# --- I7: three more ways a push used to pass with nothing read, or to read as scanned when it was not ---
# I7a: `git rev-parse --show-toplevel` fails in a bare repository, and a guard on it ended the hook in
# a silent exit 0, although commit lists and diffs read fine there. I7b: a last stdin line with no
# newline was dropped by `read`, so its ref went unread. I7c: after the wider scan is announced, an
# empty list (every commit already on a remote, as $i5 is since the update-ref above) must say that
# 0 commits were scanned instead of ending silently. All three are clean pushes: no loop run.
$i7Bare = Join-Path $fxBase 'pp-bare.git'
& git clone -q --bare $i5 $i7Bare 2>$null
$rI7a = Invoke-PrePush $i7Bare ('0' * 40) $i5Clean
$ok = (Assert-True 'I7a a push from a bare repository is scanned, not passed in silence' ($rI7a.Code -eq 0 -and $rI7a.Out -match 'commit\(s\) scanned\)') "exit=$($rI7a.Code) out=$($rI7a.Out)") -and $ok
$i7 = New-PushRepo 'pp-last-line'
$i7Tip = Add-Commit $i7 'readme.md' "nothing to see`n" 'clean commit'
$rI7b = Invoke-Hook $i7 $prePush "refs/heads/main $i7Tip refs/heads/main $('0' * 40)" '' -NoFinalNewline
$ok = (Assert-True 'I7b a last stdin line with no newline is still read: its commit is scanned' ($rI7b.Code -eq 0 -and $rI7b.Out -match 'commit\(s\) scanned\)') "exit=$($rI7b.Code) out=$($rI7b.Out)") -and $ok
$rI7c = Invoke-PrePush $i5 $i5Gone $i5Clean
$ok = (Assert-True 'I7c an empty wider scan passes and says that 0 commits were scanned' ($rI7c.Code -eq 0 -and $rI7c.Out -match 'scanning every commit' -and $rI7c.Out -match '0 commits of it were scanned' -and $rI7c.Out -notmatch 'no secret pattern') "exit=$($rI7c.Code) out=$($rI7c.Out)") -and $ok

# --- I6: the one-pass prefilter answers "clean" only with proof it read every commit ------------------
# The per-commit loop started about fourteen processes per commit. The prefilter reads every diff with
# one `git show --stdin` and one grep, and falls to the unchanged loop on a match or when its header
# count does not equal the commit count. A `git` shim logs each `git show` call, so "one call" proves the
# prefilter ran and "one call per commit" proves the loop did. The shim's mode breaks the one-pass read:
# `empty` prints nothing and exits 0 (the header count is short), `cut` stops the stream after the last
# header and exits 141 like a git killed by a broken pipe (the count is full, only the status gives it away).
$shimDir = Join-Path $fxBase 'pp-shim'
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
$shimGit = Join-Path $shimDir 'git'
$shimBody = @"
#!/bin/sh
if [ "`$1" = show ]; then
    echo "`$*" >> "`$HARNESS_SHIM_LOG"
    case "`$*" in *--stdin*)
        case "`$HARNESS_SHIM_MODE" in
            empty) cat > /dev/null; exit 0 ;;
            cut) '$(ConvertTo-ShPath (Get-Command git).Source)' "`$@" | head -n 6; exit 141 ;;
        esac ;;
    esac
fi
exec '$(ConvertTo-ShPath (Get-Command git).Source)' "`$@"
"@
# The suite file is CRLF; a CR in an sh script breaks its shebang.
[IO.File]::WriteAllText($shimGit, ($shimBody -replace "`r", ''), [Text.UTF8Encoding]::new($false))
if (-not $IsWindows) { & chmod +x $shimGit }
function Invoke-PrePushShim([string]$Repo, [string]$Base, [string]$Tip, [string]$Mode) {
    $log = Join-Path $fxBase ('shim-' + [Guid]::NewGuid().ToString('N') + '.log')
    $prevLog = $env:HARNESS_SHIM_LOG; $prevMode = $env:HARNESS_SHIM_MODE
    try {
        $env:HARNESS_SHIM_LOG = ConvertTo-ShPath $log; $env:HARNESS_SHIM_MODE = $Mode
        # The shim dir goes first, ahead of the toolchain dirs Invoke-Hook would otherwise prepend.
        $p = (@($shimDir) + $shExtraPath + @($env:PATH)) -join [IO.Path]::PathSeparator
        $r = Invoke-Hook $Repo $prePush "refs/heads/main $Tip refs/heads/main $Base" $p
    } finally { $env:HARNESS_SHIM_LOG = $prevLog; $env:HARNESS_SHIM_MODE = $prevMode }
    $r.Shows = if (Test-Path -LiteralPath $log) { @([IO.File]::ReadAllLines($log)).Count } else { 0 }
    return $r
}
# A history with a root commit, normal commits and a merge. The merge itself adds $MergeLine (an evil
# merge: the line is in neither parent); $Marked is a secret-shaped line with the allow marker;
# $SideLine is the side branch's file; $WithLast adds a commit after the merge. The ids land in $script:Mr.
function New-MergeRepo([string]$Name, [string]$MergeLine, [string]$Marked, [string]$SideLine, [bool]$WithLast) {
    $r = New-PushRepo $Name
    $mainBranch = (& git -C $r symbolic-ref --short HEAD 2>$null).Trim()
    $first = Add-Commit $r 'a.txt' "one`ntwo`n" 'first'
    if ($Marked) { $null = Add-Commit $r 'doc.md' "example only: $Marked   harness:allow-secret`n" 'documented' }
    & git -C $r checkout -q -b side 2>$null
    $side = Add-Commit $r 's.txt' "$SideLine`n" 'side'
    & git -C $r checkout -q $mainBranch 2>$null
    $null = Add-Commit $r 'm.txt' "main`n" 'main'
    & git -C $r merge --no-ff --no-commit side 2>&1 | Out-Null
    [IO.File]::AppendAllText((Join-Path $r 'a.txt'), "$MergeLine`n")
    & git -C $r add -A 2>$null
    & git -C $r commit -q -m 'merge' 2>$null
    $merge = (& git -C $r rev-parse HEAD 2>$null).Trim()
    $tip = if ($WithLast) { Add-Commit $r 'z.txt' "last`n" 'last' } else { $merge }
    $script:Mr = @{ Base = $first; Side = $side; Merge = $merge; Tip = $tip }
    return $tip
}
$zero40 = '0' * 40
$i6Tip = New-MergeRepo 'pp-fast-clean' 'plain merge line' $fakeKey 'side' $true
$i6 = Join-Path $fxBase 'pp-fast-clean'
$i6N = [int](& git -C $i6 rev-list --count $i6Tip 2>$null)
$i6Marked = (& git -C $i6 log --format=%H -S'harness:allow-secret' 2>$null | Out-String)
$rI6a = Invoke-PrePushShim $i6 $zero40 $i6Tip ''
$ok = (Assert-True 'I6a a clean push of a root commit, normal commits and a merge passes on ONE git show call' ($rI6a.Code -eq 0 -and $rI6a.Shows -eq 1 -and $rI6a.Out -match "\($i6N commit\(s\) scanned\)" -and $i6N -ge 6) "exit=$($rI6a.Code) shows=$($rI6a.Shows) n=$i6N out=$($rI6a.Out)") -and $ok
$ok = (Assert-True 'I6d a marker-exempt secret line is still exempt in the prefilter (and the fixture does hold one)' ($rI6a.Code -eq 0 -and $rI6a.Shows -eq 1 -and $i6Marked.Trim() -ne '') "exit=$($rI6a.Code) shows=$($rI6a.Shows) marked=$i6Marked out=$($rI6a.Out)") -and $ok
# A one-pass read that breaks must never read as clean: the secret in $i5s is still found, by the loop.
$i5sShort = (& git -C $i5s rev-parse --short $i5Secret 2>$null).Trim()
foreach ($m in @('empty', 'cut')) {
    $rI6c = Invoke-PrePushShim $i5s $zero40 $i5Secret $m
    $ok = (Assert-True "I6c a one-pass read that is '$m' still BLOCKS the secret: the loop runs and reports it" ($rI6c.Code -eq 1 -and $rI6c.Shows -gt 1 -and $rI6c.Out -match "\[aws-access-key-id\] in $i5sShort") "exit=$($rI6c.Code) shows=$($rI6c.Shows) out=$($rI6c.Out)") -and $ok
}
# Two hits in a three-commit range, one on a side commit and one that only the merge adds: the report
# names each of those commits once and not the commit between them.
$null = New-MergeRepo 'pp-fast-secret' "evil = '$fakeKey'" '' "aws_key = $fakeKey" $false
$i6b = Join-Path $fxBase 'pp-fast-secret'
$i6bSide = (& git -C $i6b rev-parse --short $script:Mr.Side 2>$null).Trim()
$i6bMerge = (& git -C $i6b rev-parse --short $script:Mr.Merge 2>$null).Trim()
$rI6b = Invoke-PrePushShim $i6b $script:Mr.Base $script:Mr.Tip ''
$i6bHits = @($rI6b.Out -split "`n" | Where-Object { $_ -match '^\s+\[[a-z-]+\] in ' } | ForEach-Object { $_.TrimEnd() } | Sort-Object)
$i6bWant = @("  [aws-access-key-id] in $i6bSide", "  [aws-access-key-id] in $i6bMerge" | Sort-Object)
$ok = (Assert-True 'I6b hits on a side commit and on a merge are each labelled with their own commit, and no other' ($rI6b.Code -eq 1 -and "$i6bHits" -eq "$i6bWant" -and $rI6b.Out -match 'across 3 commit\(s\)' -and $rI6b.Out -match "      \+aws_key = $fakeKey") "exit=$($rI6b.Code) hits=$($i6bHits -join '|') want=$($i6bWant -join '|') out=$($rI6b.Out)") -and $ok

# --- I8: a commit whose diff git cannot print blocks the push (ADR 0213, owner 2026-11-24) --------
# A deleted loose blob makes `git show` print nothing and exit 128. Before ADR 0213 the loop read the
# empty output as "no added line" and reported the commit as scanned. -Force: git writes loose objects
# read-only on Windows, and the removal is asserted, because a silenced failure would pass I8a unread.
function Remove-Blob([string]$Repo, [string]$Spec) {
    $oid = (& git -C $Repo rev-parse $Spec 2>$null).Trim()
    $f = Join-Path $Repo ".git/objects/$($oid.Substring(0, 2))/$($oid.Substring(2))"
    Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
    return -not (Test-Path -LiteralPath $f)
}
# Every commit is made before the blob goes: a commit made after it either writes the blob again or,
# when git finds the index entry stat-clean, fails with "invalid object" (seen 1 run in 8 on Windows).
$i8 = New-PushRepo 'pp-unread'
$i8Base = Add-Commit $i8 'base.txt' "base`n" 'base'
$i8Tip = Add-Commit $i8 'lost.txt' "clean but unreadable`n" 'lost blob'
# The hit line starts with `++` (case I9 below), so one push also covers the header filter.
$i8bHit = Add-Commit $i8 'key.txt' "++aws_key = $fakeKey`n" 'secret after the lost blob'
$i8Gone = Remove-Blob $i8 "$i8Tip`:lost.txt"
$rI8a = Invoke-PrePush $i8 $i8Base $i8Tip
$ok = (Assert-True 'I8a a commit whose git show fails BLOCKS the push and is named, never counted as scanned' ($i8Gone -and $rI8a.Code -eq 1 -and $rI8a.Out -match 'could not print the diff' -and $rI8a.Out -match "  $i8Tip" -and $rI8a.Out -notmatch 'commit\(s\) scanned') "gone=$i8Gone exit=$($rI8a.Code) out=$($rI8a.Out)") -and $ok
# I8b: a hit in a readable commit is still reported beside the unread one, so one push shows both.
$rI8b = Invoke-PrePush $i8 $i8Base $i8bHit
# I9 reads the same run (review of 2026-11-24, medium). An added line whose text starts with `++`
# prints as `+++`, the start of a diff file header. A filter on `^+++` alone dropped that line from
# the prefilter and from the loop, and the push passed with the secret. The run shares the I8 repo to
# save one per-commit loop, about 1.5 s on Windows.
$ok = (Assert-True 'I9 an added line that starts with ++ reaches the patterns and BLOCKS' ($rI8b.Code -eq 1 -and $rI8b.Out -match '\[aws-access-key-id\] in ' -and $rI8b.Out -match "      \+\+\+aws_key = $fakeKey") "exit=$($rI8b.Code) out=$($rI8b.Out)") -and $ok
$ok = (Assert-True 'I8b a hit in a readable commit is reported beside the unread commit, and the push blocks' ($i8Gone -and $rI8b.Code -eq 1 -and $rI8b.Out -match '\[aws-access-key-id\] in ' -and $rI8b.Out -match "  $i8Tip" -and $rI8b.Out -match 'could not print the diff') "exit=$($rI8b.Code) out=$($rI8b.Out)") -and $ok

# --- SS: the vendored CI's secret-scan step drives THIS pre-push over the run's range ------------
# Dist issue #6 moved the step's three workflow values out of its run: text into env: (the file's
# own env-only rule). ci-enabled-plugins WS1 proves no `${{` is left in run: text; this proves the
# values still ARRIVE — a static check passes a step whose env: name and run: name disagree, and
# then a push range silently degrades to the ZERO fallback. The step body AND its env: mapping are
# EXTRACTED from the template by step name (what runs is what ships), and the fixture supplies
# values per workflow context, under whatever names the step declares.
$ssYml = Join-Path $PSScriptRoot 'templates/.github/workflows/harness-gates.yml'
$ssName = "Secret scan over this run's commits (backstop)"
$ssLines = [IO.File]::ReadAllLines($ssYml)
$ssBody = $null; $ssEnv = @{}; $iSs = -1
for ($i = 0; $i -lt $ssLines.Count; $i++) {
    if ($ssLines[$i] -match "^\s*-\s+name:\s+$([regex]::Escape($ssName))\s*$") { $iSs = $i; break }
}
if ($iSs -ge 0) {
    for ($i = $iSs + 1; $i -lt $ssLines.Count; $i++) {
        if ($ssLines[$i] -match '^\s*-\s+name:') { break }
        if ($ssLines[$i] -match '^\s+([A-Z_][A-Z0-9_]*):\s*\$\{\{\s*([\w.]+)\s*\}\}\s*$') { $ssEnv[$Matches[2]] = $Matches[1]; continue }
        if ($ssLines[$i] -match '^(\s*)run:\s*\|\s*$') {
            $keyCol = $Matches[1].Length; $bodyIndent = -1
            $body = New-Object System.Collections.Generic.List[string]
            for ($j = $i + 1; $j -lt $ssLines.Count; $j++) {
                $l = $ssLines[$j]
                if ($l.Trim().Length -eq 0) { $body.Add(''); continue }
                $ind = $l.Length - $l.TrimStart().Length
                if ($ind -le $keyCol) { break }
                if ($bodyIndent -lt 0) { $bodyIndent = $ind }
                $body.Add($l.Substring([Math]::Min($bodyIndent, $ind)))
            }
            $ssBody = ($body -join "`n") + "`n"
            break
        }
    }
}
$ssCtx = @('github.event_name', 'github.base_ref', 'github.event.before')
$ok = (Assert-True 'SS0 the secret-scan step and its env: mapping are extracted from the template by name' ($null -ne $ssBody -and $ssBody -match 'sh \.githooks/pre-push' -and @($ssCtx | Where-Object { -not $ssEnv.ContainsKey($_) }).Count -eq 0) "body=$([bool]$ssBody) env=$(($ssEnv.GetEnumerator() | ForEach-Object { "$($_.Value)=$($_.Key)" }) -join ',')") -and $ok
if ($null -ne $ssBody -and @($ssCtx | Where-Object { -not $ssEnv.ContainsKey($_) }).Count -eq 0) {
    $ssFile = Join-Path $fxBase 'secret-scan-step.sh'
    [IO.File]::WriteAllText($ssFile, $ssBody, [Text.UTF8Encoding]::new($false))
    function Invoke-SecretScanStep([string]$Repo, [hashtable]$Ctx) {
        # `sh -e <file>`, the way the runner runs a run: block (`bash -e {0}`: the path as an
        # ARGUMENT, errexit on). Not through Invoke-Hook: its [string]$StdIn binds $null as '', so
        # it always executes its target directly, and this scratch file has no exec bit — the
        # Linux parity run failed 126 on exactly that.
        $prev = @{}; $prevPath = $env:PATH
        foreach ($k in $ssCtx) { $n = $ssEnv[$k]; $prev[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $Ctx[$k]) }
        Push-Location $Repo
        try {
            if ($shExtraPath.Count) { $env:PATH = ($shExtraPath -join ';') + ';' + $prevPath }
            $out = (& $shCmd.Source -e (ConvertTo-ShPath $ssFile) 2>&1) | Out-String
            return @{ Out = $out; Code = $LASTEXITCODE }
        } finally {
            $env:PATH = $prevPath; Pop-Location
            foreach ($n in $prev.Keys) { [Environment]::SetEnvironmentVariable($n, $prev[$n]) }
        }
    }
    # One repo: a secret committed BEFORE the range, one clean commit inside it. A range that
    # reaches the step scans 1 commit and passes; each value lost on the way fails here — a lost
    # EVENT_BEFORE takes the ZERO fallback and blocks on the older secret (SS1), a lost BASE_REF
    # leaves `origin/` unresolvable (SS2 exits 1), a lost EVENT_NAME takes the ZERO fallback and
    # scans 0 commits once the PR head is a remote ref (SS2, with SS2c as its control).
    $ss = New-PushRepo 'ss-range'
    $ssOld = Add-Commit $ss 'old.txt' "aws_key = $fakeKey`n" 'secret before the range'
    $null = Add-Commit $ss 'new.txt' "clean`n" 'clean commit in the range'
    New-Item -ItemType Directory -Force -Path (Join-Path $ss '.githooks') | Out-Null
    Copy-Item -LiteralPath $prePush -Destination (Join-Path $ss '.githooks/pre-push') -Force
    $zero = '0' * 40
    $rS1 = Invoke-SecretScanStep $ss @{ 'github.event_name' = 'push'; 'github.base_ref' = ''; 'github.event.before' = $ssOld }
    $ok = (Assert-True 'SS1 push: the before SHA reaches the step through env: — only the range is scanned, with no unknown-range warning' ($rS1.Code -eq 0 -and $rS1.Out -match '\(1 commit\(s\) scanned\)' -and $rS1.Out -notmatch '::warning::') "exit=$($rS1.Code) out=$($rS1.Out)") -and $ok
    $rS1c = Invoke-SecretScanStep $ss @{ 'github.event_name' = 'push'; 'github.base_ref' = ''; 'github.event.before' = $zero }
    $ok = (Assert-True 'SS1c control: a ZERO before (branch creation) warns that the push range is unknown (ADR 0213), scans the history and BLOCKS on the older secret' ($rS1c.Code -eq 1 -and $rS1c.Out -match '::warning::secret scan: ' -and $rS1c.Out -match 'aws-access-key-id') "exit=$($rS1c.Code) out=$($rS1c.Out)") -and $ok
    # The PR refs are remote-tracking refs, created only NOW: the ZERO path above scans
    # `--not --remotes`, and an origin/main at the old commit would have hidden the control's secret.
    # A real PR checkout has BOTH: the base (origin/<base_ref>) and the PR head itself
    # (refs/remotes/pull/<n>/merge, HEAD here). The head ref is what makes EVENT_NAME observable:
    # with it, the push/ZERO fallback — where a lost EVENT_NAME lands, since `$EVENT_NAME` is then
    # not `pull_request` — finds 0 commits not on a remote, while the PR path scans
    # origin/<base>..HEAD = 1. Without it both printed `(1 commit(s) scanned)`, so an env: name that
    # disagreed with `$EVENT_NAME` passed SS2 — the mutant that kills the backstop on every real PR,
    # whose head is always a remote ref (review 2026-09-23, medium).
    & git -C $ss update-ref refs/remotes/origin/main $ssOld 2>$null
    & git -C $ss update-ref refs/remotes/pull/1/merge HEAD 2>$null
    $rS2 = Invoke-SecretScanStep $ss @{ 'github.event_name' = 'pull_request'; 'github.base_ref' = 'main'; 'github.event.before' = '' }
    $ok = (Assert-True 'SS2 pull_request: the event name and base ref reach the step through env: — origin/<base>..HEAD is scanned' ($rS2.Code -eq 0 -and $rS2.Out -match '\(1 commit\(s\) scanned\)') "exit=$($rS2.Code) out=$($rS2.Out)") -and $ok
    # SS2c: the control that makes SS2's observable unambiguous — the same refs with the event name
    # LOST (the value a mismatched env: name delivers) take the fallback and scan nothing.
    $rS2c = Invoke-SecretScanStep $ss @{ 'github.event_name' = ''; 'github.base_ref' = 'main'; 'github.event.before' = '' }
    $ok = (Assert-True 'SS2c control: with EVENT_NAME lost, the same PR refs take the ZERO fallback and scan 0 commits — SS2''s count comes only from the PR path' ($rS2c.Code -eq 0 -and $rS2c.Out -notmatch 'commit\(s\) scanned' -and $rS2c.Out -match 'secret scan: ') "exit=$($rS2c.Code) out=$($rS2c.Out)") -and $ok
}

# =================================================================================================
# post-commit — the slice retro's per-commit driver (ADR 0017, spec 0007 §3.4)
# =================================================================================================
# Placement (GUARDED) is init Q's and manifest-gate's; these cases RUN the body. Every branch exits
# 0, so an exit code alone proves nothing: each case asserts what the hook printed, and the stub
# retro's `[stub-retro]` line is what separates "ran the retro" from "exited early".
# Mutation-checked when written (2026-09-27): dropping `|| true` AND the final `exit 0` fails P2
# (either one alone is covered by the other — the pair is the contract); dropping the SLICE_RETRO
# line fails P3; dropping the `[ -f "$RETRO" ]` guard fails P4 with or without python (an
# interpreter error on a missing file, or the SKIP line — non-empty either way); dropping the SKIP
# echo fails P5.
function New-RetroRepo([string]$Name, [string]$StubBody) {
    $p = New-Repo $Name
    if ($StubBody) { Write-File $p 'scripts/harness/harness_retro.py' $StubBody }
    return $p
}
$prevRetroVar = $env:SLICE_RETRO
Remove-Item Env:SLICE_RETRO -ErrorAction SilentlyContinue
try {
    # P4: no vendored retro -> a silent exit 0. The guard runs before python is resolved, so this
    # case needs no python.
    $p4 = New-RetroRepo 'pcm-no-retro' ''
    $rP4 = Invoke-Hook $p4 $postCommit $null
    $ok = (Assert-True 'P4 without scripts/harness/harness_retro.py the hook exits 0 and prints nothing' ($rP4.Code -eq 0 -and $rP4.Out.Trim() -eq '') "exit=$($rP4.Code) out=$($rP4.Out)") -and $ok

    # P5: a retro but no python on PATH -> a REPORTED skip, never a silent pass. PATH is replaced by
    # one directory holding a `git` shim (the hook's first line needs git). Absence is VERIFIED under
    # that PATH before asserting (fact 42: a narrowed PATH can keep a python neighbour).
    $p5 = New-RetroRepo 'pcm-no-python' "print('[stub-retro] ran')`n"
    $binDir = Join-Path $fxBase 'pcm-bin'
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $gitShim = Join-Path $binDir 'git'
    [IO.File]::WriteAllText($gitShim, "#!/bin/sh`nexec '$(ConvertTo-ShPath $gitLauncher)' `"`$@`"`n")
    # POSIX needs the mode bit; Windows has none — git's MSYS sh treats a file opening with `#!` as
    # executable, which is what `command -v git` below proves rather than assumes.
    if (-not $IsWindows) { & chmod +x $gitShim }
    $prevPath = $env:PATH
    try {
        $env:PATH = $binDir
        $pyOnNarrow = "$(& $shPath -c 'command -v python; command -v python3; command -v py' 2>&1)".Trim()
        $gitOnNarrow = "$(& $shPath -c 'command -v git' 2>&1)".Trim()
    } finally { $env:PATH = $prevPath }
    if ($pyOnNarrow -or -not $gitOnNarrow) {
        # Locally a reported SKIP; on CI a FAIL — a probe that keeps failing there would otherwise
        # retire P5's assertion for good behind an all-green run (review 2026-09-27, low).
        $p5Why = "the narrowed PATH is not python-free with git (python='$pyOnNarrow' git='$gitOnNarrow')"
        if ($env:CI) { $ok = (Assert-True 'P5 the git-shim PATH probe resolves on CI' $false $p5Why) -and $ok }
        else { Write-Host "SKIP [P5 post-commit] $p5Why — reported, not silent; CI fails on it" -ForegroundColor Yellow }
    } else {
        $rP5 = Invoke-Hook $p5 $postCommit $null $binDir
        $ok = (Assert-True 'P5 no python on PATH is a reported SKIP line, exit 0, and the retro does not run' ($rP5.Code -eq 0 -and $rP5.Out -match '\[slice-retro\] SKIP — no python on PATH' -and $rP5.Out -notmatch '\[stub-retro\]') "exit=$($rP5.Code) out=$($rP5.Out)") -and $ok
    }

    if (-not $pyAvail) {
        Write-Host 'SKIP [P1-P3 post-commit] python absent (reported, not silent) — CI has python' -ForegroundColor Yellow
    } else {
        # P1: the retro runs with --repo <toplevel> and its output reaches the author verbatim.
        $p1 = New-RetroRepo 'pcm-runs' "import sys`nprint('[stub-retro] ran ' + ' '.join(sys.argv[1:]))`n"
        $rP1 = Invoke-Hook $p1 $postCommit $null
        $ok = (Assert-True 'P1 the retro runs with --repo <toplevel> and its output passes through, exit 0' ($rP1.Code -eq 0 -and $rP1.Out -match '\[stub-retro\] ran --repo \S') "exit=$($rP1.Code) out=$($rP1.Out)") -and $ok

        # P2: a crashing retro never reads as a failed commit — exit 0, and the crash is still shown.
        $p2 = New-RetroRepo 'pcm-crash' "import sys`nprint('[stub-retro] crashing')`nsys.exit(3)`n"
        $rP2 = Invoke-Hook $p2 $postCommit $null
        $ok = (Assert-True 'P2 a retro exiting 3 leaves the hook at exit 0 with the retro output shown' ($rP2.Code -eq 0 -and $rP2.Out -match '\[stub-retro\] crashing') "exit=$($rP2.Code) out=$($rP2.Out)") -and $ok

        # P3: SLICE_RETRO=0 skips this commit's retro. P1 (same stub shape, variable unset) is the control.
        $env:SLICE_RETRO = '0'
        try { $rP3 = Invoke-Hook $p1 $postCommit $null } finally { Remove-Item Env:SLICE_RETRO -ErrorAction SilentlyContinue }
        $ok = (Assert-True 'P3 SLICE_RETRO=0 exits 0 without running the retro' ($rP3.Code -eq 0 -and $rP3.Out -notmatch '\[stub-retro\]') "exit=$($rP3.Code) out=$($rP3.Out)") -and $ok
    }
} finally {
    if ($null -ne $prevRetroVar) { $env:SLICE_RETRO = $prevRetroVar }
}

# =================================================================================================
# commit-msg — refuses a close record that owes `class:` lines and lacks them (ADR 0208, spec 0007)
# =================================================================================================
# Besides pre-commit and pre-push, this is the one shipped hook that blocks. Its branches: a sh pre-filter
# (one `grep -q confirmed`, no cut and no dropped line) that starts no Python when grep finds nothing; the
# Python check when it finds the word; and a REFUSAL, never a silent pass, when grep cannot read the message
# (exit other than 0 or 1), the interpreter or the vendored script is missing, or the check exits other than
# 0 or 1. Piggybacks on two fixtures: cm-ok (the vendored retro and config) and cm-noscript. The python-less
# arm follows P5 (fact 42): absence is VERIFIED under the narrowed PATH before asserting, and that PATH
# carries shims for the other tools the hook needs (git, grep). Without them the pre-filter finds nothing,
# and e1/e2 would pass or fail on a missing grep instead of on the missing python.
$cmDigest2 = "fix: close`n`nReview: confirmed 2 (h0 m2 l0) · multi_lens 4`n"
$tplScripts = Join-Path $PSScriptRoot 'templates/scripts/harness'
function Invoke-CommitMsg([string]$Repo, [string]$Name, [string]$Body, [string]$PathOverride = '', [switch]$Missing) {
    $f = Join-Path $fxBase "cm-$Name.txt"
    # -Missing: hand the hook a path that does not exist (grep cannot read it), writing nothing.
    if (-not $Missing) { [IO.File]::WriteAllText($f, ($Body -replace "`r`n", "`n")) }
    elseif (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force }
    $sh = ConvertTo-ShPath $commitMsg
    $prevPath = $env:PATH
    Push-Location $Repo
    try {
        if ($PathOverride) { $env:PATH = $PathOverride }
        elseif ($shExtraPath.Count) { $env:PATH = ($shExtraPath -join ';') + ';' + $prevPath }
        $out = (& $shCmd.Source $sh (ConvertTo-ShPath $f) 2>&1) | Out-String
        return @{ Out = $out; Code = $LASTEXITCODE }
    } finally { $env:PATH = $prevPath; Pop-Location }
}
$cmOk = New-Repo 'cm-ok'
foreach ($vf in @('harness_retro.py', 'harness_config.py')) {
    Write-File $cmOk "scripts/harness/$vf" ([IO.File]::ReadAllText((Join-Path $tplScripts $vf)))
}
$cmNoScript = New-Repo 'cm-noscript'
if (-not $pyAvail) {
    Write-Host 'SKIP [CM-a..CM-f commit-msg] python absent (reported, not silent) — CI has python' -ForegroundColor Yellow
} else {
    $rCMa = Invoke-CommitMsg $cmOk 'a' ($cmDigest2 + "`nclass: A instance - one-off`n")
    $ok = (Assert-True 'CM-a two owed findings and one class line REFUSE the commit: exit 1, ADR 0208, both line forms, --no-verify' `
        ($rCMa.Code -eq 1 -and $rCMa.Out -match 'REFUSED' -and $rCMa.Out -match 'ADR 0208' -and $rCMa.Out -match 'class: <id> instance' -and $rCMa.Out -match 'class: <id> BACKLOG' -and $rCMa.Out -match 'git commit --no-verify') "exit=$($rCMa.Code) out=$($rCMa.Out)") -and $ok
    $rCMb = Invoke-CommitMsg $cmOk 'b' ($cmDigest2 + "`nclass: A instance - one-off`nclass: B BACKLOG - docs gate`n")
    $ok = (Assert-True 'CM-b one class line per finding passes: exit 0, silent' ($rCMb.Code -eq 0 -and $rCMb.Out.Trim() -eq '') "exit=$($rCMb.Code) out=$($rCMb.Out)") -and $ok
    # CM-c: `git commit -m`/`-F` keep a `#` line in the stored message, so a digest there is REFUSED when short (F1).
    # No scissors section is cut, whatever the comment character is: the check counts the whole file, as the retro does.
    $rCMc = Invoke-CommitMsg $cmOk 'c' "fix: x`n`n#181 Review: confirmed 9 (h5 m4 l0)`n"
    $ok = (Assert-True 'CM-c1 a digest only on a # line is REFUSED (the line is kept in the stored message): exit 1, ADR 0208' ($rCMc.Code -eq 1 -and $rCMc.Out -match 'REFUSED' -and $rCMc.Out -match 'counts 9 confirmed' -and $rCMc.Out -match 'ADR 0208') "exit=$($rCMc.Code) out=$($rCMc.Out)") -and $ok
    $rCMc2 = Invoke-CommitMsg $cmOk 'c2' "fix: x`n`n# ------------------------ >8 ------------------------`ndiff`n+Review: confirmed 9 (h5 m4 l0)`n"
    $ok = (Assert-True 'CM-c2 a digest only below the scissors line is REFUSED (no cut): exit 1, counts 9, ADR 0208' ($rCMc2.Code -eq 1 -and $rCMc2.Out -match 'REFUSED' -and $rCMc2.Out -match 'counts 9 confirmed' -and $rCMc2.Out -match 'ADR 0208') "exit=$($rCMc2.Code) out=$($rCMc2.Out)") -and $ok
    $rCMc3 = Invoke-CommitMsg $cmOk 'c3' "fix: x`n`n; ------------------------ >8 ------------------------  `ndiff`n+Review: confirmed 9 (h5 m4 l0)`n"
    $ok = (Assert-True 'CM-c3 a digest below a ; scissors line (core.commentChar) with trailing spaces is REFUSED: exit 1, counts 9' ($rCMc3.Code -eq 1 -and $rCMc3.Out -match 'REFUSED' -and $rCMc3.Out -match 'counts 9 confirmed') "exit=$($rCMc3.Code) out=$($rCMc3.Out)") -and $ok
    # CM-c4/CM-c5 (F1-3d8a2118): a scissors line ABOVE a short digest. `-m`/`-F` keep it, so the retro counts the digest.
    $rCMc4 = Invoke-CommitMsg $cmOk 'c4' "fix: x`n`n# ------------------------ >8 ------------------------`nReview: confirmed 3 (h1 m2 l0)`n"
    $ok = (Assert-True 'CM-c4 a # scissors line ABOVE a short digest is REFUSED: exit 1, counts 3, has 0 class lines' ($rCMc4.Code -eq 1 -and $rCMc4.Out -match 'REFUSED' -and $rCMc4.Out -match 'counts 3 confirmed' -and $rCMc4.Out -match 'has 0 class line') "exit=$($rCMc4.Code) out=$($rCMc4.Out)") -and $ok
    $rCMc5 = Invoke-CommitMsg $cmOk 'c5' "fix: x`n`n- ------------------------ >8 ------------------------`nReview: confirmed 3 (h1 m2 l0)`n"
    $ok = (Assert-True 'CM-c5 a "- " scissors line ABOVE a short digest is REFUSED: exit 1, counts 3' ($rCMc5.Code -eq 1 -and $rCMc5.Out -match 'REFUSED' -and $rCMc5.Out -match 'counts 3 confirmed') "exit=$($rCMc5.Code) out=$($rCMc5.Out)") -and $ok
    $rCMd = Invoke-CommitMsg $cmOk 'd' "fix: plain`n`nNo review digest here.`n"
    $ok = (Assert-True 'CM-d a message with no digest passes: exit 0, silent' ($rCMd.Code -eq 0 -and $rCMd.Out.Trim() -eq '') "exit=$($rCMd.Code) out=$($rCMd.Out)") -and $ok
    $rCMd2 = Invoke-CommitMsg $cmOk 'd2' "fix: prose`n`nconfirmed 3 findings in prose, no digest shape.`n"
    $ok = (Assert-True 'CM-d2 the loose token without the digest shape reaches Python and passes: exit 0, silent' ($rCMd2.Code -eq 0 -and $rCMd2.Out.Trim() -eq '') "exit=$($rCMd2.Code) out=$($rCMd2.Out)") -and $ok

    # CM-f: the real thing. Git hands the hook its own message file. A refused `git commit` leaves HEAD where
    # it was, and --no-verify is the one bypass. core.hooksPath points at a dir holding only this hook.
    New-Item -ItemType Directory -Force -Path (Join-Path $cmOk '.githooks') | Out-Null
    Copy-Item -LiteralPath $commitMsg -Destination (Join-Path $cmOk '.githooks/commit-msg')
    if (-not $IsWindows) { & chmod +x (Join-Path $cmOk '.githooks/commit-msg') }
    & git -C $cmOk config core.hooksPath .githooks 2>$null
    $headBefore = (& git -C $cmOk rev-parse HEAD 2>$null | Out-String).Trim()
    $gitOut = (& git -C $cmOk commit -q --allow-empty -m 'fix: close' -m 'Review: confirmed 2 (h0 m2 l0)' -m 'class: A instance - one-off' 2>&1 | Out-String)
    $gitCode = $LASTEXITCODE
    $headAfter = (& git -C $cmOk rev-parse HEAD 2>$null | Out-String).Trim()
    $ok = (Assert-True 'CM-f1 git itself runs the hook: a real commit lacking a class line is refused and HEAD does not move' ($gitCode -ne 0 -and $headAfter -eq $headBefore -and $gitOut -match 'REFUSED') "exit=$gitCode out=$gitOut") -and $ok
    # CM-f1b: the reported scenario through real git -F (cleanup=whitespace keeps the scissors line): refused, HEAD stays.
    $cmFFile = Join-Path $fxBase 'cm-f1b.txt'
    [IO.File]::WriteAllText($cmFFile, "fix: close`n`n# ------------------------ >8 ------------------------`nReview: confirmed 3 (h1 m2 l0)`n")
    $f1bOut = (& git -C $cmOk commit -q --allow-empty -F $cmFFile 2>&1 | Out-String)
    $f1bCode = $LASTEXITCODE
    $headF1b = (& git -C $cmOk rev-parse HEAD 2>$null | Out-String).Trim()
    $ok = (Assert-True 'CM-f1b git commit -F with a # scissors line above a short digest is refused and HEAD does not move' ($f1bCode -ne 0 -and $headF1b -eq $headBefore -and $f1bOut -match 'REFUSED' -and $f1bOut -match 'counts 3 confirmed') "exit=$f1bCode out=$f1bOut") -and $ok
    $null = & git -C $cmOk commit -q --no-verify --allow-empty -m 'fix: close' -m 'Review: confirmed 2 (h0 m2 l0)' -m 'class: A instance - one-off' 2>&1
    $nvCode = $LASTEXITCODE
    $headNv = (& git -C $cmOk rev-parse HEAD 2>$null | Out-String).Trim()
    $ok = (Assert-True 'CM-f2 --no-verify commits the same message' ($nvCode -eq 0 -and $headNv -ne $headBefore) "exit=$nvCode") -and $ok

    # CM-f3 (F10): the check exits with a status other than 0 or 1 (here 2, as argparse does) is a crash, and the
    # hook REFUSES it, naming the exit code. The stub replaces the vendored script for this one commit only, then the
    # real bytes come back (e1/e2 below read the same fixture).
    $cmRetroPath = Join-Path $cmOk 'scripts/harness/harness_retro.py'
    $cmRetroReal = [IO.File]::ReadAllText($cmRetroPath)
    try {
        [IO.File]::WriteAllText($cmRetroPath, "import sys`nsys.exit(2)`n")
        $headF3 = (& git -C $cmOk rev-parse HEAD 2>$null | Out-String).Trim()
        $f3Out = (& git -C $cmOk commit -q --allow-empty -m 'fix: close' -m 'Review: confirmed 2 (h0 m2 l0)' -m 'class: A instance - one-off' -m 'class: B instance - one-off' 2>&1 | Out-String)
        $f3Code = $LASTEXITCODE
        $headF3After = (& git -C $cmOk rev-parse HEAD 2>$null | Out-String).Trim()
    } finally { [IO.File]::WriteAllText($cmRetroPath, $cmRetroReal) }
    $ok = (Assert-True 'CM-f3 a check that exits 2 REFUSES the commit, names exit 2 and --no-verify, and HEAD does not move' `
        ($f3Code -ne 0 -and $headF3After -eq $headF3 -and $f3Out -match 'REFUSED' -and $f3Out -match 'exited 2' -and $f3Out -match '--no-verify') "exit=$f3Code out=$f3Out") -and $ok

    # CM-f4 (O183, ADR 0209): core.commentChar `-` and a strip cleanup. Git would store the message without its
    # `- class:` lines, so the hook reads the comment string and refuses; HEAD stays. The control commits the same
    # body with plain `class:` lines.
    & git -C $cmOk config core.commentChar '-' 2>$null
    try {
        $cmF4 = Join-Path $fxBase 'cm-f4.txt'
        [IO.File]::WriteAllText($cmF4, "fix: close`n`nReview: confirmed 2 (h0 m2 l0)`n`n- class: A instance - r`n- class: B instance - r`n")
        $headF4 = (& git -C $cmOk rev-parse HEAD 2>$null | Out-String).Trim()
        $f4Out = (& git -C $cmOk commit -q --allow-empty --cleanup=strip -F $cmF4 2>&1 | Out-String)
        $f4Code = $LASTEXITCODE
        $headF4After = (& git -C $cmOk rev-parse HEAD 2>$null | Out-String).Trim()
        [IO.File]::WriteAllText($cmF4, "fix: close`n`nReview: confirmed 2 (h0 m2 l0)`n`nclass: A instance - r`nclass: B instance - r`n")
        $null = (& git -C $cmOk commit -q --allow-empty --cleanup=strip -F $cmF4 2>&1 | Out-String)
        $f4bCode = $LASTEXITCODE
        $f4bBody = (& git -C $cmOk log -1 --format=%B 2>$null | Out-String)
    } finally { & git -C $cmOk config --unset core.commentChar 2>$null }
    $ok = (Assert-True 'CM-f4 core.commentChar - with a strip cleanup: "- class:" lines do not pay, the commit is REFUSED and HEAD does not move' `
        ($f4Code -ne 0 -and $headF4After -eq $headF4 -and $f4Out -match 'REFUSED' -and $f4Out -match 'comment string `-`') "exit=$f4Code out=$f4Out") -and $ok
    $ok = (Assert-True 'CM-f4 control: plain class lines commit, and git stored both' ($f4bCode -eq 0 -and ([regex]::Matches($f4bBody, '(?m)^class:')).Count -eq 2) "exit=$f4bCode body=$f4bBody") -and $ok
}

# CM-g (F1): grep cannot read the message (a path that does not exist, grep exit 2): the pre-filter is not "no token", so
# the hook REFUSES instead of passing. It needs no Python, so it runs where python is absent too. A chmod 000 arm is not
# used: Windows has no mode bit and a root CI user reads through it, so a missing file is the portable unreadable case.
$rCMg = Invoke-CommitMsg $cmOk 'g-missing' '' -Missing
$ok = (Assert-True 'CM-g a message grep cannot read REFUSES: exit 1, names the grep exit, ADR 0208 and --no-verify (fail closed)' `
    ($rCMg.Code -eq 1 -and $rCMg.Out -match 'REFUSED — could not read the message \(grep exit [2-9]' -and $rCMg.Out -match 'ADR 0208' -and $rCMg.Out -match '--no-verify') "exit=$($rCMg.Code) out=$($rCMg.Out)") -and $ok

# CM-e1..e3: the missing-tool arms. e3 needs no narrowed PATH: the script check runs before the interpreter check.
$rCMe3 = Invoke-CommitMsg $cmNoScript 'e3' $cmDigest2
$ok = (Assert-True 'CM-e3 a digest with no scripts/harness/harness_retro.py REFUSES, naming the script (never a silent pass)' `
    ($rCMe3.Code -eq 1 -and $rCMe3.Out -match 'REFUSED — this message holds a review digest, but scripts/harness/harness_retro.py was not found' -and $rCMe3.Out -match '--no-verify') "exit=$($rCMe3.Code) out=$($rCMe3.Out)") -and $ok
$rCMe3b = Invoke-CommitMsg $cmNoScript 'e3b' "fix: plain`n"
$ok = (Assert-True 'CM-e3 control: the same repo with a digest-free message passes, exit 0, silent' ($rCMe3b.Code -eq 0 -and $rCMe3b.Out.Trim() -eq '') "exit=$($rCMe3b.Code) out=$($rCMe3b.Out)") -and $ok

$cmBin = Join-Path $fxBase 'cm-bin'
New-Item -ItemType Directory -Force -Path $cmBin | Out-Null
$cmShimsOk = $true
foreach ($tool in @('git', 'grep')) {
    if ($tool -eq 'git') { $abs = ConvertTo-ShPath $gitLauncher }
    else {
        $prevP = $env:PATH
        try {
            if ($shExtraPath.Count) { $env:PATH = ($shExtraPath -join ';') + ';' + $prevP }
            $abs = "$(& $shPath -c "command -v $tool" 2>&1)".Trim()
        } finally { $env:PATH = $prevP }
    }
    if (-not $abs) { $cmShimsOk = $false; continue }
    $shim = Join-Path $cmBin $tool
    [IO.File]::WriteAllText($shim, "#!/bin/sh`nexec '$abs' `"`$@`"`n")
    if (-not $IsWindows) { & chmod +x $shim }
}
$prevPath = $env:PATH
try {
    $env:PATH = $cmBin
    $cmPy = "$(& $shPath -c 'command -v python; command -v python3; command -v py' 2>&1)".Trim()
    $cmTools = "$(& $shPath -c 'command -v git && command -v grep' 2>&1)".Trim()
} finally { $env:PATH = $prevPath }
if ($cmPy -or -not $cmShimsOk -or -not $cmTools) {
    $cmWhy = "the narrowed PATH is not python-free with git and grep (python='$cmPy' tools='$cmTools' shims=$cmShimsOk)"
    if ($env:CI) { $ok = (Assert-True 'CM-e1/e2 the shim PATH probe resolves on CI' $false $cmWhy) -and $ok }
    else { Write-Host "SKIP [CM-e1 CM-e2 commit-msg] $cmWhy — reported, not silent; CI fails on it" -ForegroundColor Yellow }
} else {
    $rCMe1 = Invoke-CommitMsg $cmOk 'e1' "fix: plain`n`nNo digest.`n" $cmBin
    $ok = (Assert-True 'CM-e1 no python on PATH and no digest: the commit passes, exit 0, silent (the pre-filter needs no Python)' ($rCMe1.Code -eq 0 -and $rCMe1.Out.Trim() -eq '') "exit=$($rCMe1.Code) out=$($rCMe1.Out)") -and $ok
    $rCMe2 = Invoke-CommitMsg $cmOk 'e2' $cmDigest2 $cmBin
    $ok = (Assert-True 'CM-e2 no python on PATH and a digest: REFUSED with the python line (never a silent pass), exit 1' `
        ($rCMe2.Code -eq 1 -and $rCMe2.Out -match 'REFUSED — this message holds a review digest, but python was not found' -and $rCMe2.Out -match '--no-verify') "exit=$($rCMe2.Code) out=$($rCMe2.Out)") -and $ok
}

Remove-FixtureRoot $fxBase

if (-not $ok) { Write-Host 'githooks selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'githooks selftest: all cases green' -ForegroundColor Green
exit 0
