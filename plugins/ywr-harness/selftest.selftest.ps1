# Self-test for selftest.ps1 — the runner's own contract (spec 0008 §3.1): discovery, the
# -Shard partition (ADR 0071), the two loud refusals (empty discovery, empty slice), and the
# concurrent run with its condensed output (ADR 0088, section G).
#
# Sections A–F drive the LIVE runner with -List, which prints discovery + selection and runs
# NOTHING. They run it in a RUNSPACE of this process (ADR 0149; Invoke-Runner, process state saved
# and restored), except two real-child canaries (A, D '0/4') that cases A0p/D0p compare the runspace
# path against. Never a second full run (the runner is what discovers and runs this file; a positive
# end-to-end case over the live tree would recurse into the whole suite set). The partition
# property is asserted on the same observable CI uses: the union of shards 1..N over -List must
# equal the unsharded list, pairwise disjoint, every shard non-empty, sizes within one of each
# other (round-robin). If that ever fails, a CI matrix would be green while a suite ran on no
# shard — the silent-coverage-loss class this file exists to keep loud.
# Section G makes the only real runs — seven (G1, G3, G4, G5, G8, G9, G9b), all of a COPY of the runner in
# a fixture tree of stub suites (three; G8's own tree has two, G9's and G9b's one each); G6 is -List again, G7 reads
# this file's own FAIL echo.
#
# Usage: pwsh plugins/ywr-harness/selftest.selftest.ps1  (exit 0 = all green). 42–82 s measured
# 2026-09-23 on a box shared with other agents' runs (section G is about half of it).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/selftest-lib.ps1')   # assertion core
$runner = Join-Path $PSScriptRoot 'selftest.ps1'
$fxBase = New-FixtureRoot 'selftest-runner-selftest'
trap { Remove-FixtureRoot $fxBase; break }   # exception-safe teardown

# NOT `$Args`: that name is PowerShell's automatic unbound-arguments variable, and `@Args` splats
# the (empty) automatic one rather than the parameter — the child then runs the runner with NO
# arguments, i.e. the whole suite set, and this file appears to hang (found on its first run).
function Invoke-RunnerChild([string]$Path, [string[]]$Arguments) {
    $out = & pwsh -NoProfile -ExecutionPolicy Bypass -File $Path @Arguments 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}
# The -List and refusal cases run the runner in a RUNSPACE of this process (ADR 0149, L3): no pwsh
# cold start (~0.8 s each, 29 cases). Argv-shaped arrays fold by the runner's own parameter metadata
# (the lib's Invoke-ScriptArgv: pairs and switches bind as in a `pwsh -File` child), so `-Jobs -3` binds -3 as the value.
# The runner pins [Console]::OutputEncoding to UTF-8 (process-wide). That pin is NOT undone: the console
# page is shared by every process on the console, and a restore to a non-UTF-8 page is what canon C9
# forbids (fact 140). The current directory, the environment and $PSStyle.OutputRendering are saved
# here and restored after every call; case A0 asserts both. Residual (ADR 0149): the children that run
# after A0 (D '0/4', F3) are read under the UTF-8 page. Under the runner and on CI the page is UTF-8
# from the start, so only a standalone run on a non-UTF-8 console reads them differently from HEAD. Real-child behaviour (F3, section G) and one -List plus one refusal canary stay
# children (A, D '0/4'); A0p/D0p compare the runspace path against those real children.
function Get-ProcessState {
    $envSnap = @{}
    foreach ($e in [Environment]::GetEnvironmentVariables().GetEnumerator()) { $envSnap[[string]$e.Key] = [string]$e.Value }
    return @{ CodePage = [Console]::OutputEncoding.CodePage; Cwd = [Environment]::CurrentDirectory; Loc = (Get-Location).Path
        Render = "$($PSStyle.OutputRendering)"; Env = $envSnap }
}
function Restore-ProcessState($S) {
    $now = Get-ProcessState
    if ($now.Cwd -ne $S.Cwd) { try { [Environment]::CurrentDirectory = $S.Cwd } catch { } }
    if ($now.Loc -ne $S.Loc) { try { Set-Location -LiteralPath $S.Loc } catch { } }
    if ($now.Render -ne $S.Render) { try { $PSStyle.OutputRendering = $S.Render } catch { } }
    foreach ($k in @($now.Env.Keys)) { if (-not $S.Env.ContainsKey($k)) { [Environment]::SetEnvironmentVariable($k, $null) } }
    foreach ($k in $S.Env.Keys) { if ($now.Env[$k] -ne $S.Env[$k]) { [Environment]::SetEnvironmentVariable($k, $S.Env[$k]) } }
}
function Invoke-Runner([string]$Path, [string[]]$Arguments) {
    $state = Get-ProcessState
    try { return Invoke-ScriptArgv $Path $Arguments }
    finally { Restore-ProcessState $state }
}
# The listing lines are the `  - <plugin-relative path>` form; everything else in the output has
# no leading spaces, so the prefix is the whole parse.
function Get-Listed($R) {
    return @(($R.Out -split "`r?`n") | Where-Object { $_ -match '^  - (.+)$' } | ForEach-Object { $Matches[1] })
}

# Every runner transcript this file echoes under a FAIL goes through here: indented, so a failing
# case cannot put a second `selftests:` summary or `all gates green` line at column 0 of the outer
# runner's log, where the real ones are read by line shape (review 2026-09-23 — a measurement
# script read a failing G case's fixture lines ahead of the outer run's own). Case G7 pins it.
function Format-Nested([string]$Text) {
    return ((($Text.TrimEnd()) -split "`r?`n") | ForEach-Object { "    | $_" }) -join "`n"
}

function Assert-Case([string]$Name, $R, [int]$ExpectExit, [string[]]$MustMatch, [string[]]$MustNotMatch, [string]$NoNegative = '', [string[]]$PreFail = @()) {
    $pre = @($PreFail | Where-Object { $_ })
    if ($R.Code -ne $ExpectExit) { $pre += "exit $($R.Code) (expected $ExpectExit)" }
    $script:LastFails = Get-AssertionFailure -Text $R.Out -MustMatch $MustMatch -MustNotMatch $MustNotMatch `
        -NoNegative $NoNegative -PreFail $pre
    return (Write-CaseVerdict -Name $Name -Fail $script:LastFails -Detail (Format-Nested $R.Out))
}

$ok = $true

# --- A. unsharded listing: the baseline every partition case compares against ----------------
# The baseline is a REAL `pwsh -File` child (canary, ADR 0149): the runner is started that way in
# production, so one -List case keeps that path; the runspace path is compared against it in A0p.
$base = Invoke-RunnerChild $runner @('-List')
$baseList = Get-Listed $base
$aMust = @('suites: discovered=\d+', '  - selftest\.selftest\.ps1', '  - manifest-gate\.selftest\.ps1', 'LIST ONLY')
$aMustNot = @('--- manifest-gate\.mjs', 'all gates green', 'shard=')
$ok = (Assert-Case 'A -List: discovery listed, nothing ran' $base 0 $aMust $aMustNot) -and $ok
# A0 — the runspace runs (ADR 0149) rest on three contracts, pinned here by name.
# (1) The runner mutates only the process-wide state this adapter restores: its statements that set
# the console encoding, the environment, the current directory or $PSStyle are exactly the two
# encoding pins. A new one fails here, not as a leak into this suite.
$runnerLines = @(Select-String -LiteralPath $runner -Pattern '^\s*(\[Console\]::\w+\s*=|\$OutputEncoding\s*=|\$env:\w+\s*=|\[Environment\]::(SetEnvironmentVariable|CurrentDirectory\s*=)|Set-Location|Push-Location|Set-Item\s+(-Path\s+)?env:|\$PSStyle\b|\[Threading\.Thread\]::CurrentThread|\[Globalization\.CultureInfo\]::\w*Culture\w*\s*=)' |
        Where-Object { $_.Line -notmatch '^\s*#' } | ForEach-Object { $_.Line.Trim() })
$ok = (Assert-True 'A0 selftest.ps1 sets only the two encoding pins as process-wide state (the runspace save/restore list)' `
    ($runnerLines.Count -eq 2 -and $runnerLines[0] -match '^\[Console\]::OutputEncoding =' -and $runnerLines[1] -match '^\$OutputEncoding =') ($runnerLines -join "`n")) -and $ok
# (2) The runner runs in THIS process: a process-exit API would end the whole suite.
$procExit = @(Select-String -LiteralPath $runner -Pattern 'Environment\]::Exit|SetShouldExit' | Where-Object { $_.Line -notmatch '^\s*#' })
$ok = (Assert-True 'A0 selftest.ps1 never calls a process-exit API (runspace, not child)' ($procExit.Count -eq 0) "lines: $(($procExit | ForEach-Object { $_.LineNumber }) -join ', ')") -and $ok
# (3) A call leaves the process-wide state as it found it — read back, not assumed.
$before = Get-ProcessState
$null = Invoke-Runner $runner @('-List')
$after = Get-ProcessState
$envDiff = @(@($before.Env.Keys) + @($after.Env.Keys) | Sort-Object -Unique | Where-Object { $before.Env[$_] -ne $after.Env[$_] })
$ok = (Assert-True 'A0 a runspace run leaves the directories, $PSStyle rendering and environment unchanged, and the code page unchanged or UTF-8' `
    (($before.CodePage -eq $after.CodePage -or $after.CodePage -eq 65001) -and $before.Cwd -eq $after.Cwd -and $before.Loc -eq $after.Loc -and $before.Render -eq $after.Render -and $envDiff.Count -eq 0) `
    "code page $($before.CodePage)->$($after.CodePage) · cwd $($before.Cwd)->$($after.Cwd) · loc $($before.Loc)->$($after.Loc) · render $($before.Render)->$($after.Render) · env diff [$($envDiff -join ', ')]") -and $ok
# A0p — the runspace path agrees with the real child: same exit code, the same listing, and the same
# verdict on the A case's own patterns.
$aRs = Invoke-Runner $runner @('-List')
$aRsFails = Get-AssertionFailure -Text $aRs.Out -MustMatch $aMust -MustNotMatch $aMustNot -PreFail @()
$ok = (Assert-True 'A0p -List: the runspace run matches the real child (exit code, listing, the asserted lines)' `
    ($aRs.Code -eq $base.Code -and ((Get-Listed $aRs) -join '|') -eq ($baseList -join '|') -and $aRsFails.Count -eq 0) `
    "child exit=$($base.Code) runspace exit=$($aRs.Code) · runspace fails: $($aRsFails -join '; ')`n$(Format-Nested $aRs.Out)") -and $ok
$ok = (Assert-True 'A2 listed count equals the discovered count' ($base.Out -match "discovered=$($baseList.Count)\b" -and $baseList.Count -ge 2) `
    "listed=$($baseList.Count) out:`n$(Format-Nested $base.Out)") -and $ok
# Ordinal order by plugin-relative path with `/` separators — what makes the deal identical on
# Windows and Linux. A culture sort would place `-`/`_`/`.` differently per OS.
$sortedCopy = [string[]]$baseList.Clone(); [Array]::Sort($sortedCopy, [System.StringComparer]::Ordinal)
# -CaseSensitive: Compare-Object's default string comparer is case-insensitive, which would let a
# sort that differs from ordinal only by letter case pass this guard (review 2026-09-02, low).
$ok = (Assert-True 'A3 listing is in ordinal order, `/`-separated' (((Compare-Object $baseList $sortedCopy -SyncWindow 0 -CaseSensitive).Count -eq 0) -and -not ($baseList -match '\\')) `
    ($baseList -join "`n")) -and $ok

# --- B. partition: union == baseline, disjoint, non-empty, balanced — for several N ----------
foreach ($n in 1, 3, 4) {
    $union = @(); $sizes = @(); $shardOk = $true; $detail = ''
    for ($i = 1; $i -le $n; $i++) {
        $r = Invoke-Runner $runner @('-List', '-Shard', "$i/$n")
        $l = Get-Listed $r
        if ($r.Code -ne 0) { $shardOk = $false; $detail += "shard $i/$n exit $($r.Code)`n$(Format-Nested $r.Out)`n" }
        if ($l.Count -eq 0) { $shardOk = $false; $detail += "shard $i/$n listed nothing`n" }
        if ($r.Out -notmatch "shard=$i/$n selected=$($l.Count)\b") { $shardOk = $false; $detail += "shard $i/$n header/selected mismatch:`n$(Format-Nested $r.Out)`n" }
        $union += $l; $sizes += $l.Count
    }
    $dupes = @($union | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
    $missing = @($baseList | Where-Object { $union -notcontains $_ })
    $extra = @($union | Where-Object { $baseList -notcontains $_ })
    $spread = ($sizes | Measure-Object -Maximum -Minimum)
    $ok = (Assert-True "B N=$n shards partition the discovery (union == baseline, disjoint, non-empty)" `
        ($shardOk -and $dupes.Count -eq 0 -and $missing.Count -eq 0 -and $extra.Count -eq 0) `
        "dupes=[$($dupes -join ', ')] missing=[$($missing -join ', ')] extra=[$($extra -join ', ')]`n$detail") -and $ok
    $ok = (Assert-True "B N=$n round-robin: shard sizes within one of each other" (($spread.Maximum - $spread.Minimum) -le 1) `
        "sizes=$($sizes -join ',')") -and $ok
}

# --- C. determinism: the same shard lists the same suites twice -----------------------------
$c1 = Invoke-Runner $runner @('-List', '-Shard', '2/4'); $c2 = Invoke-Runner $runner @('-List', '-Shard', '2/4')
$ok = (Assert-True 'C shard 2/4 is deterministic across runs' (((Get-Listed $c1) -join '|') -eq ((Get-Listed $c2) -join '|')) `
    "$(Format-Nested $c1.Out)`n---`n$(Format-Nested $c2.Out)") -and $ok
$ok = (Assert-Case 'C2 shard 1/1 equals the unsharded list' (Invoke-Runner $runner @('-List', '-Shard', '1/1')) 0 `
    @("shard=1/1 selected=$($baseList.Count)\b") @('selected=0\b')) -and $ok
$ok = (Assert-True 'C3 shard 1/1 lists exactly the baseline' (((Get-Listed (Invoke-Runner $runner @('-List', '-Shard', '1/1'))) -join '|') -eq ($baseList -join '|')) `
    ($baseList -join "`n")) -and $ok

# --- D. malformed -Shard: exit 1 before anything is listed or run -----------------------------
# The 20-digit form pins the TryParse path: a cast would throw a raw overflow instead of the refusal.
# '0/4' is the REAL-child refusal canary (ADR 0149); the rest run in a runspace. D0p compares the two paths.
foreach ($bad in '0/4', '5/4', 'a/b', '1/0', '01/4', '1/4/2', '4', '99999999999999999999/2') {
    $dRun = if ($bad -eq '0/4') { Invoke-RunnerChild $runner @('-List', '-Shard', $bad) } else { Invoke-Runner $runner @('-List', '-Shard', $bad) }
    $dMust = @('FAIL — -Shard must be i/N', [regex]::Escape("got '$bad'")); $dMustNot = @('suites: discovered', '  - ', 'LIST ONLY')
    $ok = (Assert-Case "D malformed -Shard '$bad' refused" $dRun 1 $dMust $dMustNot) -and $ok
    if ($bad -eq '0/4') {
        $dRs = Invoke-Runner $runner @('-List', '-Shard', $bad)
        $dRsFails = Get-AssertionFailure -Text $dRs.Out -MustMatch $dMust -MustNotMatch $dMustNot -PreFail @()
        $ok = (Assert-True "D0p malformed -Shard '$bad': the runspace run matches the real child (exit code, the asserted lines)" `
            ($dRs.Code -eq $dRun.Code -and $dRs.Code -eq 1 -and $dRsFails.Count -eq 0) `
            "child exit=$($dRun.Code) runspace exit=$($dRs.Code) · runspace fails: $($dRsFails -join '; ')`n$(Format-Nested $dRs.Out)") -and $ok
    }
}

# --- E. empty slice: N beyond the discovery is a misconfiguration, not a pass ----------------
$n = $baseList.Count + 1
$ok = (Assert-Case "E shard $n/$n selects nothing → exit 1" (Invoke-Runner $runner @('-List', '-Shard', "$n/$n")) 1 `
    @('selects 0 of \d+ suites', 'an empty slice is not a pass', 'selected=0\b') @('LIST ONLY', '  - ')) -and $ok

# --- F. empty discovery: a copy of the runner in a tree with no suites is exit 1 -------------
# -List is the fast path here too: the refusal comes BEFORE the gates, so the fixture needs no
# manifest-gate.mjs — and if the order ever regressed (gates first), this case would print the
# missing-gate FAIL instead of the discovery one and fail on MustNotMatch.
# The tree is NOT bare: it carries one suite under templates/, which is scaffold payload and must
# be excluded (declared in the refusal's count) — so this case also proves the exclusion, and that
# an excluded file never rescues the empty set.
$fxEmpty = Join-Path $fxBase 'empty'
New-Item -ItemType Directory -Force (Join-Path $fxEmpty 'templates/scripts') | Out-Null
Copy-Item -LiteralPath $runner -Destination (Join-Path $fxEmpty 'selftest.ps1')
[IO.File]::WriteAllText((Join-Path $fxEmpty 'templates/scripts/payload.selftest.ps1'), "exit 0`n")
$ok = (Assert-Case 'F zero discovered → exit 1 even under -List; a templates/ suite is excluded, counted, and rescues nothing' (Invoke-Runner (Join-Path $fxEmpty 'selftest.ps1') @('-List')) 1 `
    @('FAIL — no \*\.selftest\.ps1 discovered', 'empty set is not a pass', 'template payload excluded: 1') @('LIST ONLY', 'manifest-gate\.mjs missing', 'suites: discovered', 'payload\.selftest\.ps1')) -and $ok
# The live tree's count is 0 and says so — the exclusion is declared on every run, not only when it bites.
$ok = (Assert-Case 'F2 the live listing declares template-excluded=0' $base 0 @('template-excluded=0\b') @('template-excluded=[1-9]')) -and $ok

# --- F3. a missing node FAILS the manifest gate (ADR 0141) — never a SKIP, unlike the workflow corpus gate ---
# A real run of a runner copy over one passing stub suite, with PATH narrowed to the runner's own pwsh
# directory: no node resolves there. The suite still runs and passes, so the exit 1 and the failed list
# can come only from the gate branch under test.
$fxNoNode = Join-Path $fxBase 'no-node'
New-Item -ItemType Directory -Force $fxNoNode | Out-Null
Copy-Item -LiteralPath $runner -Destination (Join-Path $fxNoNode 'selftest.ps1')
[IO.File]::WriteAllText((Join-Path $fxNoNode 'manifest-gate.mjs'), "console.log('PASS  stub manifest gate')`n")
[IO.File]::WriteAllText((Join-Path $fxNoNode 'p-pass.selftest.ps1'), "Write-Host 'PASS [stub]'`nexit 0`n")
$pathKeep = $env:PATH
try {
    $env:PATH = $PSHOME
    if (Get-Command node -CommandType Application -ErrorAction SilentlyContinue) { $rNoNode = $null }
    else { $rNoNode = Invoke-RunnerChild (Join-Path $fxNoNode 'selftest.ps1') @('-Jobs', '1') }   # a real run with a narrowed PATH: a child, never a runspace
} finally { $env:PATH = $pathKeep }
if ($null -eq $rNoNode) { Write-Host "SKIP [F3 no node] node resolves inside `$PSHOME ($PSHOME) — cannot hide it (reported, not silent)" -ForegroundColor Yellow }
else {
    $ok = (Assert-Case 'F3 node absent: the manifest gate FAILS, the run is exit 1, the suite still ran' $rNoNode 1 `
        @('FAIL — node not on PATH, so manifest-gate\.mjs cannot run', 'manifest-gate\.mjs \(no node\)', 'passed=1 failed=0') `
        @('PASS  stub manifest gate', 'all gates green', 'SKIP — node not on PATH; workflow corpus')) -and $ok
}

# --- G. concurrent run + condensed output (ADR 0088) — a runner copy over three stub suites ----
# The tree: a stub manifest gate (the runner refuses a tree without one; no workflows/ dir, so the
# corpus gate is not required) and three suites whose ORDINAL order (a, b, c) differs from their
# completion order under concurrency. a-slow prints Korean in its body and in a SKIP line;
# b-fail fails; c-pass passes. The completion order is forced by a barrier, not by a sleep race:
# with `wait-for-c` present, a-slow waits for c-pass's `c.done` marker, then for the process id it
# names to exit, then 2 s more — so with >= 2 slots c finishes before a whatever the machine load.
# Without the control file a-slow only sleeps 2 s — the -Jobs 1 run, where a waiting a-slow would
# block the only slot. The 2 s sleep needs the `a-sleep` marker (ADR 0149, W2): G1 and G3 set it,
# G4 and later cases run without it.
#
# The runner is started in a FRESH HIDDEN console (CreateNoWindow) and read as UTF-8 bytes here.
# The fresh console starts at the system OEM code page (cp949 on the owner's box, measured
# 2026-09-23), not at the UTF-8 this suite's own console was pinned to, so the Korean assertions
# fail if the runner's decoding pin is missing or comes after its first output. On Linux the
# console encoding is UTF-8 already: the cases pass there but cannot catch that regression.
$ko = -join [char[]](0xD55C, 0xAE00)   # the two Hangul syllables for "Hangul"; this file stays ASCII
function Invoke-RunnerFresh([string]$Path, [string[]]$Arguments) {
    $psi = [Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
    foreach ($a in @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Path) + $Arguments) { $psi.ArgumentList.Add($a) }
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $psi.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $p = [Diagnostics.Process]::Start($psi)
    $errTask = $p.StandardError.ReadToEndAsync()   # async: a full stderr pipe must not block stdout
    $out = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit()
    return @{ Out = $out + $errTask.GetAwaiter().GetResult(); Code = $p.ExitCode }
}
# Line index of the first line matching $Rx, -1 when absent — the ordering assertions compare these.
function Get-LineIndex([string]$Text, [string]$Rx) {
    $ls = $Text -split "`r?`n"
    for ($i = 0; $i -lt $ls.Count; $i++) { if ($ls[$i] -match $Rx) { return $i } }
    return -1
}
$fxRun = Join-Path $fxBase 'run'
New-Item -ItemType Directory -Force $fxRun | Out-Null
$fxRunner = Join-Path $fxRun 'selftest.ps1'
Copy-Item -LiteralPath $runner -Destination $fxRunner
[IO.File]::WriteAllText((Join-Path $fxRun 'manifest-gate.mjs'), "console.log('PASS  stub manifest gate')`n")
# Each stub pins UTF-8 as the real suites do (lib/selftest-lib.ps1) and builds its Korean from
# code points, so what is under test is the runner's capture, not the stub's source decoding.
[IO.File]::WriteAllText((Join-Path $fxRun 'a-slow.selftest.ps1'), @'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ko = -join [char[]](0xD55C, 0xAE00)
$done = Join-Path $PSScriptRoot 'c.done'
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'wait-for-c')) {
    # Wait for c's marker, then for c's PROCESS to be gone: the marker alone was not enough — under
    # load a pwsh teardown outlasted a 1 s margin and a finished first (measured 2026-09-23).
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while (-not (Test-Path -LiteralPath $done) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    $cPid = 0
    if ((Test-Path -LiteralPath $done) -and [int]::TryParse(([IO.File]::ReadAllText($done)).Trim(), [ref]$cPid)) {
        while ((Get-Process -Id $cPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    }
    if ([DateTime]::UtcNow -ge $deadline) { Write-Host 'BARRIER TIMEOUT — c-pass never finished' }
}
# The 2 s margin applies only where a case sets `a-sleep` (G1: after the barrier; G3b: serial order).
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'a-sleep')) { Start-Sleep -Seconds 2 }
Write-Host "PASS [a body $ko]"
Write-Host "SKIP [a skip $ko] reported, not silent"
Write-Host 'WARN [a warn] re-review trigger, suite still passes'
Write-Host 'FAIL [a stray] printed by a passing suite'
Write-Host 'KEEP [a keep] fixture kept'
Write-Warning 'A-HOST-WARNING from a passing suite'
# The same warning as a colour-enabled child prints it (NO_COLOR unset): wrapped in ANSI SGR codes.
Write-Host ([string][char]27 + '[33;1mWARNING: A-ANSI-WARNING coloured line' + [string][char]27 + '[0m')
Write-Host 'BODY-MARKER-A'
exit 0
'@)
[IO.File]::WriteAllText((Join-Path $fxRun 'b-fail.selftest.ps1'), @'
Write-Host 'PASS [b one]'
Write-Host 'FAIL [b two]: broken on purpose'
[Console]::Error.WriteLine('b stderr line')
exit 1
'@)
[IO.File]::WriteAllText((Join-Path $fxRun 'c-pass.selftest.ps1'), @'
Write-Host 'PASS [c one]'
Write-Host 'PASS [c two]'
Write-Host 'BODY-MARKER-C'
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'c.done'), "$PID")
exit 0
'@)
$ctl = Join-Path $fxRun 'wait-for-c'
$marker = Join-Path $fxRun 'c.done'
$aSleep = Join-Path $fxRun 'a-sleep'
function Set-ASleep([bool]$On) {
    if ($On) { [IO.File]::WriteAllText($aSleep, 'on') } else { Remove-Item -LiteralPath $aSleep -Force -ErrorAction SilentlyContinue }
}
function Set-Barrier([bool]$On) {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    if ($On) { [IO.File]::WriteAllText($ctl, 'on') } else { Remove-Item -LiteralPath $ctl -Force -ErrorAction SilentlyContinue }
}
$summary = 'selftests: discovered=3 passed=2 failed=1'

# G1 — concurrent (-Jobs 3, all three start at once): the verdict, the failed suite in full, the
# passing suites condensed to one line each, the SKIP line kept — with its Korean intact.
Set-Barrier $true
Set-ASleep $true
$g1 = Invoke-RunnerFresh $fxRunner @('-Jobs', '3')
$ok = (Assert-Case 'G1 concurrent run: exit 1 naming the failed suite; failed body in full, passing suites one line each, SKIP line kept with Korean intact' $g1 1 `
    @([regex]::Escape($summary), 'FAIL — b-fail\.selftest\.ps1', 'jobs=3\b', 'PASS  stub manifest gate',
        '(?m)^--- b-fail\.selftest\.ps1 FAIL \(exit 1, 1 PASS lines', '(?m)^PASS \[b one\]', '(?m)^FAIL \[b two\]: broken on purpose', 'b stderr line',
        '(?m)^ok   a-slow\.selftest\.ps1 \(1 PASS lines, ', '(?m)^ok   c-pass\.selftest\.ps1 \(2 PASS lines, ',
        ('(?m)^SKIP \[a skip ' + [regex]::Escape($ko) + '\] reported, not silent'), '(?m)^timing: suites wall-clock ') `
    @('all gates green', 'BODY-MARKER-A', 'BODY-MARKER-C', '(?m)^PASS \[c one\]', '(?m)^PASS \[a body', 'BARRIER TIMEOUT', '(?m)^--- (a-slow|c-pass)')) -and $ok
# G2 — ordering: completion order differs from discovery order (c finished before a — so the run
# really was concurrent), and the results section is in discovery order regardless.
$dA = Get-LineIndex $g1.Out '^done a-slow\.selftest\.ps1 PASS \('; $dC = Get-LineIndex $g1.Out '^done c-pass\.selftest\.ps1 PASS \('
$rA = Get-LineIndex $g1.Out '^ok   a-slow'; $rB = Get-LineIndex $g1.Out '^--- b-fail'; $rC = Get-LineIndex $g1.Out '^ok   c-pass'
$ok = (Assert-True 'G2 results in discovery order (a, b, c) although c finished before a' `
    ($dA -ge 0 -and $dC -ge 0 -and $dC -lt $dA -and $rA -gt $dA -and $rA -lt $rB -and $rB -lt $rC) `
    "done a=$dA c=$dC · results a=$rA b=$rB c=$rC`n$(Format-Nested $g1.Out)") -and $ok
# G1c — condensing keeps a passing suite's SIGNAL lines, not only its SKIPs (review 2026-09-23): a
# WARN re-review trigger, a FAIL line that never reached the exit code (a gate judged from the
# wrong observable), the lib's KEEP line, and a host Write-Warning line. That label is localized,
# so the case matches the
# message, not the label; on an English host the WARN word already covers it, so only a non-English
# host (the owner's ko-KR box) can catch a lost label probe.
$ok = (Assert-Case 'G1c passing suite condensed: its WARN, FAIL, KEEP and Write-Warning lines are kept' $g1 1 `
    @('(?m)^WARN \[a warn\] re-review trigger', '(?m)^FAIL \[a stray\] printed by a passing suite', '(?m)^KEEP \[a keep\] fixture kept',
        '(?m)^\S[^\r\n]*A-HOST-WARNING from a passing suite', '(?m)^WARNING: A-ANSI-WARNING coloured line') `
    @('BODY-MARKER-A', '(?m)^PASS \[a body', '(?m)^--- a-slow', '\[runner\]')) -and $ok
# G1d — and they sit under their own suite's `ok` line, before the next suite's result.
$kept = @('^SKIP \[a skip', '^WARN \[a warn\]', '^FAIL \[a stray\]', '^KEEP \[a keep\]', '^\S.*A-HOST-WARNING') | ForEach-Object { Get-LineIndex $g1.Out $_ }
$ok = (Assert-True 'G1d the kept lines sit between their suite''s ok line and the next result' `
    ($rA -ge 0 -and @($kept | Where-Object { $_ -le $rA -or $_ -ge $rB }).Count -eq 0) `
    "ok a=$rA · kept=$($kept -join ',') · next=$rB`n$(Format-Nested $g1.Out)") -and $ok

# G3 — -Jobs 1: the same verdict and summary, and genuinely serial (done lines in discovery order;
# without the barrier a-slow sleeps 2 s, so any overlap would let b and c finish first).
Set-Barrier $false   # a-sleep stays set from G1: G3b's serial-order margin
$g3 = Invoke-RunnerFresh $fxRunner @('-Jobs', '1')
$ok = (Assert-Case 'G3 -Jobs 1: same summary and failed-suite line as the concurrent run' $g3 1 `
    @([regex]::Escape($summary), 'FAIL — b-fail\.selftest\.ps1', 'jobs=1\b', ('(?m)^SKIP \[a skip ' + [regex]::Escape($ko) + '\]')) `
    @('all gates green', 'BODY-MARKER-A', 'BODY-MARKER-C')) -and $ok
$s1 = Get-LineIndex $g3.Out '^done a-slow'; $s2 = Get-LineIndex $g3.Out '^done b-fail'; $s3 = Get-LineIndex $g3.Out '^done c-pass'
$ok = (Assert-True 'G3b -Jobs 1 runs one suite at a time (done lines in discovery order)' ($s1 -ge 0 -and $s1 -lt $s2 -and $s2 -lt $s3) `
    "done a=$s1 b=$s2 c=$s3`n$(Format-Nested $g3.Out)") -and $ok

# G4 — -Full, default -Jobs: every suite's body printed, the passing ones included, Korean intact;
# the condensed `ok` lines absent. The default slot count is min(logical CPUs, 8), stated as jobs=.
$defJobs = [Math]::Min([Environment]::ProcessorCount, 8)
Set-ASleep $false   # G4 asserts only that bodies print: no 2 s margin needed
$g4 = Invoke-RunnerFresh $fxRunner @('-Full')
$ok = (Assert-Case "G4 -Full prints every suite's body; the default is jobs=$defJobs" $g4 1 `
    @([regex]::Escape($summary), "jobs=$defJobs\b", 'BODY-MARKER-A', 'BODY-MARKER-C', '(?m)^PASS \[c one\]',
        ('(?m)^PASS \[a body ' + [regex]::Escape($ko) + '\]'), '(?m)^--- a-slow\.selftest\.ps1 PASS \(exit 0, 1 PASS lines, ', '(?m)^--- c-pass\.selftest\.ps1 PASS \(exit 0, 2 PASS lines, ') `
    @('(?m)^ok   ', 'all gates green')) -and $ok

# G5 — -Shard composes with -Jobs: shard 3/3 of (a, b, c) is c alone; the gate still runs; green.
$g5 = Invoke-RunnerFresh $fxRunner @('-Shard', '3/3', '-Jobs', '2')
$ok = (Assert-Case 'G5 -Shard 3/3 -Jobs 2: c-pass alone, the gate still runs, green' $g5 0 `
    @('selftests: discovered=3 shard=3/3 selected=1 passed=1 failed=0', 'all gates green \(shard 3/3\)', 'PASS  stub manifest gate', '(?m)^ok   c-pass\.selftest\.ps1') `
    @('done a-slow', 'done b-fail', '(?m)^FAIL', 'FAIL —')) -and $ok

# G8 — -SuiteTimeout (ADR 0098): a suite that hangs is killed WITH its process tree and counted
# FAILED, the run still finishes and still reports the suite beside it. Its own fixture tree, so G1–G5's
# counts stay three. The hanging stub starts a grandchild pwsh first and records its PID: the case
# checks that child is gone too, since a surviving descendant is what kept a CI job alive. The judged
# limit is 8 s, with ONE fallback at 20 s (ADR 0123, ADR 0111's H): under a loaded 2-CPU container a
# 5 s limit fired while the stub was still spawning (measured 2026-09-27). The stub writes `ready` once
# the grandchild runs; an attempt whose kill beat `ready` proves nothing about the kill, so it is
# discarded and the next limit runs — load costs time, never a red. Discarding stops a grandchild whose
# PID was recorded; one killed between its spawn and that write is left to the runner's tree kill (the
# 300 s sleep bounds it if that missed). The first attempt is a FORCED miss (`hold` makes the stub sleep
# before it spawns anything, killed at 1 s), so the discard-and-continue path runs on every run, not
# only under load (G8F), and spawns no grandchild to orphan.
$fxHang = Join-Path $fxBase 'hang'
New-Item -ItemType Directory -Force $fxHang | Out-Null
$hangRunner = Join-Path $fxHang 'selftest.ps1'
Copy-Item -LiteralPath $runner -Destination $hangRunner
[IO.File]::WriteAllText((Join-Path $fxHang 'manifest-gate.mjs'), "console.log('PASS  stub manifest gate')`n")
[IO.File]::WriteAllText((Join-Path $fxHang 'h-hang.selftest.ps1'), @'
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'hold')) { Start-Sleep -Seconds 300 }
$kid = Start-Process -FilePath ([Environment]::ProcessPath) -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 300' -NoNewWindow -PassThru
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'grandchild.pid'), "$($kid.Id)")
Write-Host 'PASS [h before the hang]'
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'ready'), '1')
Start-Sleep -Seconds 300
exit 0
'@)
[IO.File]::WriteAllText((Join-Path $fxHang 'p-ok.selftest.ps1'), "Write-Host 'PASS [p one]'`nexit 0`n")
$gcFile = Join-Path $fxHang 'grandchild.pid'
$readyFile = Join-Path $fxHang 'ready'
$holdFile = Join-Path $fxHang 'hold'
$g8Forced = $null
foreach ($attempt in @(@{ Limit = 1; Hold = $true }, @{ Limit = 8; Hold = $false }, @{ Limit = 20; Hold = $false })) {
    Remove-Item -LiteralPath $gcFile, $readyFile, $holdFile -Force -ErrorAction SilentlyContinue
    if ($attempt.Hold) { [IO.File]::WriteAllText($holdFile, '1') }
    $hangLimit = $attempt.Limit
    $hangClock = [Diagnostics.Stopwatch]::StartNew()
    $g8 = Invoke-RunnerFresh $hangRunner @('-Jobs', '2', '-SuiteTimeout', "$hangLimit")
    $hangClock.Stop()
    $gcPid = 0
    $gcRead = (Test-Path -LiteralPath $gcFile) -and [int]::TryParse(([IO.File]::ReadAllText($gcFile)).Trim(), [ref]$gcPid)
    $gcAlive = $gcRead -and [bool](Get-Process -Id $gcPid -ErrorAction SilentlyContinue)
    $stubReady = Test-Path -LiteralPath $readyFile
    if ($gcAlive) { Stop-Process -Id $gcPid -Force -ErrorAction SilentlyContinue }
    if ($attempt.Hold) { $g8Forced = @{ Run = $g8; Ready = $stubReady; GcRead = $gcRead }; continue }
    if ($stubReady) { break }
    if ($hangLimit -lt 20) { Write-Host "INFO [G8 the $hangLimit s kill beat the stub's ready marker (load) — re-run at 20 s]" }
}
Remove-Item -LiteralPath $holdFile -Force -ErrorAction SilentlyContinue
$ok = (Assert-True 'G8F the forced 1 s miss is discarded: killed before ready and before any spawn, and the judged attempt ran after it' `
    ((-not $g8Forced.Ready) -and (-not $g8Forced.GcRead) -and ($g8Forced.Run.Out -match 'exceeded -SuiteTimeout 1 s') -and ($hangLimit -ge 8)) `
    "forced ready=$($g8Forced.Ready) pid written=$($g8Forced.GcRead) judged limit=$hangLimit`n$(Format-Nested $g8Forced.Run.Out)") -and $ok
$ok = (Assert-Case "G8 a hung suite is killed at -SuiteTimeout ($hangLimit s) and counted FAILED; the suite beside it still reports" $g8 1 `
    @('selftests: discovered=2 passed=1 failed=1', 'FAIL — h-hang\.selftest\.ps1', '(?m)^done h-hang\.selftest\.ps1 FAIL \(',
        "exceeded -SuiteTimeout $hangLimit s and was killed with its process tree", '(?m)^PASS \[h before the hang\]', '(?m)^ok   p-ok\.selftest\.ps1') `
    @('all gates green', '(?m)^--- p-ok')) -and $ok
$ok = (Assert-True 'G8b the hung suite''s grandchild died with it, and the run ended well before the stub''s 300 s' `
    ($stubReady -and $gcRead -and -not $gcAlive -and $hangClock.Elapsed.TotalSeconds -lt 120) `
    "stub ready before the kill=$stubReady (false: the limit fired mid-spawn — load, not the kill) · grandchild pid read=$gcRead alive=$gcAlive · wall $([int]$hangClock.Elapsed.TotalSeconds) s`n$(Format-Nested $g8.Out)") -and $ok

# G9 / G9b — a label probe that fails is never silent (spec 0008 §3.1). Two copies of the runner: in
# G9 the probe warns WITHOUT its marker (no label line); in G9b the probe calls a pwsh that does not
# exist (it throws). Each must print exactly one `WARN [runner]` line with its reason, and the run stays
# green. A swap that does not land exactly once fails its case, or the case would pass vacuously.
$runnerText = [IO.File]::ReadAllText($runner)
$probeCases = @(
    @{ Id = 'G9'; Dir = 'probe-nolabel'; Old = "Write-Warning ''ywr-warning-label-probe''"; New = "Write-Warning ''label-probe-without-its-marker''"
        Reason = 'no label line in \d+ probe line\(s\)'; Other = 'the probe threw'; What = 'learns no label' },
    @{ Id = 'G9b'; Dir = 'probe-throws'; Old = '$probe = @(& ([Environment]::ProcessPath)'; New = '$probe = @(& (Join-Path $PSScriptRoot ''no-such-pwsh.exe'')'
        Reason = 'the probe threw: \S'; Other = 'no label line in'; What = 'throws' })
foreach ($pc in $probeCases) {
    $fxProbe = Join-Path $fxBase $pc.Dir
    New-Item -ItemType Directory -Force $fxProbe | Out-Null
    $swapCount = ([regex]::Matches($runnerText, [regex]::Escape($pc.Old))).Count
    [IO.File]::WriteAllText((Join-Path $fxProbe 'selftest.ps1'), $runnerText.Replace($pc.Old, $pc.New))
    [IO.File]::WriteAllText((Join-Path $fxProbe 'manifest-gate.mjs'), "console.log('PASS  stub manifest gate')`n")
    [IO.File]::WriteAllText((Join-Path $fxProbe 'p-ok.selftest.ps1'), "Write-Host 'PASS [p one]'`nexit 0`n")
    $rp = Invoke-RunnerFresh (Join-Path $fxProbe 'selftest.ps1') @('-Jobs', '1')
    $warnCount = ([regex]::Matches($rp.Out, '(?m)^WARN \[runner\]')).Count
    $pre = @($(if ($swapCount -ne 1) { "the swap text appears $swapCount time(s) in selftest.ps1, expected 1 — the case proves nothing" }),
        $(if ($warnCount -ne 1) { "$warnCount WARN [runner] line(s), expected exactly 1" }))
    $ok = (Assert-Case "$($pc.Id) a probe that $($pc.What) prints exactly one WARN [runner] line with its reason; the run stays green" $rp 0 `
        @('all gates green', '(?m)^ok   p-ok\.selftest\.ps1', ('(?m)^WARN \[runner\] the Write-Warning label probe failed \(' + $pc.Reason)) `
        @($pc.Other, '(?m)^FAIL') -PreFail $pre) -and $ok
}

# Not cased: the runner's could-not-start and no-result branches. Neither is reachable from a
# fixture without a test hook in the shipped runner — tried 2026-09-23: with PATH pointing at an
# empty dir, the runner's `& pwsh` still resolved and the suites ran.

# G6 — -Jobs below 1 is a named refusal before anything is listed or run; -Jobs composes with -List.
foreach ($bad in '0', '-3') {
    $ok = (Assert-Case "G6 -Jobs $bad refused" (Invoke-Runner $runner @('-List', '-Jobs', $bad)) 1 `
        @('FAIL — -Jobs must be a whole number >= 1', [regex]::Escape("(got $bad)")) @('LIST ONLY', 'suites: discovered')) -and $ok
}
# G6c — -SuiteTimeout outside 1..86400 is refused too; the upper bound keeps the milliseconds in Int32.
foreach ($bad in '0', '-3', '86401') {
    $ok = (Assert-Case "G6c -SuiteTimeout $bad refused" (Invoke-Runner $runner @('-List', '-SuiteTimeout', $bad)) 1 `
        @('FAIL — -SuiteTimeout must be a whole number of seconds from 1 to 86400', [regex]::Escape("(got $bad)")) @('LIST ONLY', 'suites: discovered')) -and $ok
}
$ok = (Assert-Case 'G6b -List -Jobs 2 -Shard 1/2 lists and runs nothing' (Invoke-Runner $runner @('-List', '-Jobs', '2', '-Shard', '1/2')) 0 `
    @('LIST ONLY', 'shard=1/2 selected=\d+') @('--- manifest-gate\.mjs', '--- suites:', 'all gates green')) -and $ok

# G7 — a failing case's echoed transcript never reaches column 0 (review 2026-09-23): a fake runner
# transcript carrying a summary and a green line is failed through Assert-Case, and what it PRINTED
# is read back from the information stream — only its own FAIL verdict line may start at column 0.
$fake = @{ Code = 0; Out = "suites: discovered=3 template-excluded=0`nselftests: discovered=3 passed=3 failed=0`nywr-harness plugin: all gates green`n" }
$printed = @(Assert-Case 'NESTED probe' $fake 1 @('never-present') @('never-present-either') 6>&1 |
        Where-Object { $_ -is [Management.Automation.InformationRecord] } | ForEach-Object { "$($_.MessageData)" }) -join "`n"
$col0 = @(($printed -split "`r?`n") | Where-Object { $_ -match '^\S' })
$ok = (Assert-True 'G7 a failing case echoes a nested runner transcript indented — no second summary/green line at column 0' `
    ($col0.Count -eq 1 -and $col0[0] -match '^FAIL \[NESTED probe\]' -and $printed -match '(?m)^    \| selftests: discovered=3 passed=3 failed=0$' -and $printed -match '(?m)^    \| ywr-harness plugin: all gates green$') `
    ($printed -replace '(?m)^', '    > ')) -and $ok

# META — the empty-MustNotMatch guard must fire through this file's wrapper, and on the guard
# reason alone. The guard is shared, so this proves the WIRING, not the guard.
$accepted = Assert-Case 'META probe' @{ Code = 0; Out = 'meta probe' } 0 @('meta probe') @() 6>$null
if ($accepted -or $script:LastFails.Count -ne 1 -or ($script:LastFails[0] -notmatch 'no MustNotMatch')) {
    Write-Host "FAIL [META]: guard did not fire — accepted=$accepted reason='$($script:LastFails -join '; ')'" -ForegroundColor Red
    $ok = $false
}
else { Write-Host 'PASS [META]: negative-less case rejected, on the guard reason alone' -ForegroundColor Green }
if (Assert-Case 'META exemption honored' @{ Code = 0; Out = 'meta probe' } 0 @('meta probe') @() 'META: proves this wrapper forwards -NoNegative to the shared core') {
    Write-Host 'PASS [META]: -NoNegative exemption honored' -ForegroundColor Green
}
else { Write-Host 'FAIL [META]: -NoNegative exemption rejected' -ForegroundColor Red; $ok = $false }

Remove-FixtureRoot $fxBase
if (-not $ok) { exit 1 }
Write-Host 'selftest runner selftest: all cases green' -ForegroundColor Green
exit 0
