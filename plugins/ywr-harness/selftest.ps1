# pwsh 7 required — the suites this runner spawns use PS7-only surfaces (Latin1, $IsWindows),
# and a 5.1 run would fail per-suite with unrelated-looking errors instead of one clear
# refusal (issue #51).
#Requires -Version 7.0

# Plugin selftest runner — the single entry point for everything this plugin can verify about
# itself: the manifest/wiring gate, the JS-side workflow corpus gate, then every shipped
# PowerShell selftest. The two gates run first, in that order, with their output streamed; the
# suites then run CONCURRENTLY (ADR 0088, `-Jobs`), each still its own `pwsh -NoProfile -File`
# child with stdout+stderr captured.
#
# Exit contract:
#   exit 0 = every gate that RAN passed, and at least one selftest was discovered
#   exit 1 = anything failed, OR nothing was discovered
#
# Zero discovered is a FAILURE, not a pass. A runner that reports green on an empty set is the
# ADR 0127 class: a gate judged from the wrong observable. Counts are always printed so a
# shrinking suite is visible rather than silent, and skips are printed as skips rather than
# folded into the pass count (ADR 0127 again — a SKIP counted as a pass was the original defect).
#
# Suite output contract (ADR 0088): one live `done <rel> PASS|FAIL (<s> s, <n> PASS lines)` line
# per suite as it finishes (completion order), then the results in ordinal DISCOVERY order — a
# failed suite with its full captured output, a passing suite as ONE line plus every captured
# SIGNAL line — one that starts with SKIP, WARN, FAIL or KEEP, or with the host's Write-Warning
# label (see Get-SignalRx) — so condensing never folds a skip, a warning or a stray FAIL into the
# pass. `-Full` prints every suite's full output instead (the pre-0088 view, for debugging). The final
# `selftests: discovered= passed= failed=` line, the `all gates green` line and the exit codes
# are unchanged — CI keys on the exit code, humans on those two lines.
#
# No gate short-circuits: one run should surface every defect, not just the cheapest one.
#
# The child-output decoding pin (ADR 0128) is set here because this runner CAPTURES child
# output: without it a non-UTF-8 console codepage destroys non-ASCII in the captured text
# rather than merely garbling the display. It must stay AHEAD of the first line this script
# prints — measured 2026-09-23 in a fresh console (cp949): a pwsh whose stdout is redirected
# keeps the encoding its output writer had at its first write, so a pin set after any output
# decodes children correctly but re-emits their text in cp949. Being process-wide, it also
# covers the `-Parallel` threads, and the console code page it sets is what each suite child
# starts with, so the children write UTF-8 too.
[CmdletBinding()]
param(
    # `i/N` (1-based): run only the i-th of N deterministic slices of the discovered suites — the
    # CI matrix lever (ADR 0071). Suites are sorted by plugin-relative path (ordinal, `/`
    # separators, so the deal is identical on Windows and Linux) and dealt round-robin, so the N
    # slices PARTITION the discovery by construction: no suite list lives in the CI yaml, and a
    # new suite lands in a slice without anyone naming it. The two gates ahead of the suites
    # (manifest, workflow corpus) run in EVERY slice — they cost seconds, and a slice that skipped
    # them would not be "every gate that ran passed". A slice that selects nothing is exit 1
    # (N larger than the discovery is a matrix misconfiguration, not a pass).
    [string]$Shard = '',
    # Print the discovery and the selection, run nothing, exit 0 — the observable the runner's own
    # selftest (selftest.selftest.ps1) asserts the partition on. The last line says LIST ONLY so
    # the output can never be read as a green run. Discovery and -Shard validation still apply:
    # an empty discovery or a malformed shard is exit 1 here too.
    [switch]$List,
    # How many suites run at once (ADR 0088). Default min(logical CPUs, 8): the suites are
    # process-spawn-bound, and past 8 the slowest suite is the floor anyway. `-Jobs 1` runs them
    # one at a time in discovery order — the fallback if a suite ever proves unsafe to run beside
    # another. Composes with -Shard (the shard selects, -Jobs runs the selection). Below 1 is exit 1.
    [int]$Jobs = [Math]::Min([Environment]::ProcessorCount, 8),
    # Print every suite's full captured output, in discovery order, instead of the condensed
    # one-line-per-passing-suite view. Debugging aid; the verdict and exit code do not change.
    [switch]$Full
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$failed = @()
$skipped = @()

if ($Jobs -lt 1) {
    Write-Host "FAIL — -Jobs must be a whole number >= 1 (got $Jobs)" -ForegroundColor Red
    exit 1
}

# --- shard argument (ADR 0071) ---------------------------------------------------------------
$shardIndex = 0
$shardCount = 0
if ($Shard) {
    # TryParse, not a cast: a digit run beyond Int32 would otherwise throw a raw .NET overflow
    # instead of this named refusal (review 2026-09-02, low).
    $m = [regex]::Match($Shard, '^([1-9][0-9]*)/([1-9][0-9]*)$')
    $i = 0; $n = 0
    $parsed = $m.Success -and [int]::TryParse($m.Groups[1].Value, [ref]$i) -and [int]::TryParse($m.Groups[2].Value, [ref]$n)
    if (-not $parsed -or $i -gt $n) {
        Write-Host "FAIL — -Shard must be i/N with 1 <= i <= N (got '$Shard')" -ForegroundColor Red
        exit 1
    }
    $shardIndex = $i
    $shardCount = $n
}

# --- discovery ------------------------------------------------------------------------------
# Recursive: a selftest sitting anywhere in the plugin is discovered, so adding a directory
# later cannot silently drop its coverage. `.mjs` selftests are driven by the corpus gate below,
# not here — pwsh would not run them.
# Discovery runs BEFORE the gates so the two loud refusals (empty set, empty slice) and -List
# cost no gate time; the gates still run before the suites in a real run.
# ONE declared exclusion, the same one manifest-gate's coverage report makes: files under a
# `templates/` directory are payload this plugin COPIES into a consuming repo, not code it runs —
# a selftest placed there belongs to the repo it lands in. Counted and printed, never silent.
$templateRx = '[\\/]templates[\\/]'
# Plugin-relative, `/`-separated — the one spelling of a suite in the listing, the live lines and
# the results, so a CI log reads the same on Windows and Linux.
function Get-SuiteRel([IO.FileInfo]$File) { $File.FullName.Substring($PSScriptRoot.Length).TrimStart('\', '/').Replace('\', '/') }
$found = @(Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -File -Filter '*.selftest.ps1' -ErrorAction SilentlyContinue)
$templateExcluded = @($found | Where-Object { $_.FullName -match $templateRx }).Count
# Ordinal-keyed on purpose: a plain @{} compares keys case-insensitively and would fold two paths
# that differ only by case into one entry on a case-sensitive filesystem (review 2026-09-02, medium).
$byRel = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
foreach ($f in $found) {
    if ($f.FullName -match $templateRx) { continue }
    $byRel[(Get-SuiteRel $f)] = $f
}
$rels = [string[]]$byRel.Keys
[Array]::Sort($rels, [System.StringComparer]::Ordinal)
$all = @($rels | ForEach-Object { $byRel[$_] })

if ($all.Count -eq 0) {
    Write-Host "FAIL — no *.selftest.ps1 discovered (empty set is not a pass; template payload excluded: $templateExcluded)" -ForegroundColor Red
    exit 1
}

$tests = $all
if ($shardCount) {
    $tests = @(for ($k = 0; $k -lt $all.Count; $k++) { if ((($k % $shardCount) + 1) -eq $shardIndex) { $all[$k] } })
    Write-Host "suites: discovered=$($all.Count) shard=$shardIndex/$shardCount selected=$($tests.Count) template-excluded=$templateExcluded"
    if ($tests.Count -eq 0) {
        Write-Host "FAIL — shard $Shard selects 0 of $($all.Count) suites (N exceeds the discovery) — an empty slice is not a pass" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "suites: discovered=$($all.Count) template-excluded=$templateExcluded"
}
foreach ($t in $tests) { Write-Host "  - $(Get-SuiteRel $t)" }

if ($List) {
    Write-Host 'LIST ONLY — nothing ran' -ForegroundColor Yellow
    exit 0
}

# --- manifest + wiring gate ----------------------------------------------------------------
$gate = Join-Path $PSScriptRoot 'manifest-gate.ps1'
if (Test-Path -LiteralPath $gate) {
    Write-Host '--- manifest-gate.ps1' -ForegroundColor Cyan
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $gate
    if ($LASTEXITCODE -ne 0) { $failed += 'manifest-gate.ps1' }
} else {
    Write-Host 'FAIL — manifest-gate.ps1 missing (the wiring gate is not optional)' -ForegroundColor Red
    $failed += 'manifest-gate.ps1 (missing)'
}

# --- workflow corpus gate (JS side) --------------------------------------------------------
# Two arms: every workflows/*.js compiles, and every workflows/*.selftest.mjs exits 0.
# `node --check` is not a substitute for the parse arm — a file carrying `export` is
# module-detected and NOT syntax-checked, so --check exits 0 on any content after it.
$wfGate = Join-Path $PSScriptRoot 'scripts/workflow-gates.mjs'
$wfDir = Join-Path $PSScriptRoot 'workflows'
if ((Test-Path -LiteralPath $wfGate) -and (Test-Path -LiteralPath $wfDir)) {
    if (Get-Command node -ErrorAction SilentlyContinue) {
        Write-Host '--- workflow-gates.mjs (corpus: workflows/)' -ForegroundColor Cyan
        & node $wfGate --root $PSScriptRoot --dir 'workflows'
        if ($LASTEXITCODE -ne 0) { $failed += 'workflow-gates.mjs' }
    } else {
        Write-Host 'SKIP — node not on PATH; workflow corpus gate NOT run (reported, not silent)' -ForegroundColor Yellow
        $skipped += 'workflow-gates.mjs (no node)'
    }
} elseif (Test-Path -LiteralPath $wfDir) {
    Write-Host 'FAIL — workflows/ exists but scripts/workflow-gates.mjs is missing: the corpus would be gated by nothing' -ForegroundColor Red
    $failed += 'workflow-gates.mjs (missing, corpus present)'
}

# --- shipped PowerShell selftests (concurrent, ADR 0088) ------------------------------------
# Safe side by side because every suite is its own process: fixture roots are $PID- or GUID-named
# under the temp root (New-FixtureRoot in lib/selftest-lib.ps1), env redirection (HOME,
# CLAUDE_CONFIG_DIR, PATH, GIT_CONFIG_GLOBAL) dies with the suite, and no suite writes global git
# config or the plugin tree, or asserts on timing (audited 2026-09-23). A suite that ever breaks
# that is fixed in the suite, not by serialising the runner; -Jobs 1 is the interim fallback.
$work = @(for ($k = 0; $k -lt $tests.Count; $k++) {
        [pscustomobject]@{ Index = $k; Rel = (Get-SuiteRel $tests[$k]); Name = $tests[$k].Name; Path = $tests[$k].FullName }
    })
function Format-Seconds([double]$Seconds) { $Seconds.ToString('0.0', [Globalization.CultureInfo]::InvariantCulture) }
function Get-PassCount([string[]]$Lines) { @($Lines | Where-Object { $_ -match '^PASS' }).Count }
function Write-SuiteLine([string]$Line) {
    if ($Line -match '^FAIL') { Write-Host $Line -ForegroundColor Red }
    elseif ($Line -match '^(SKIP|WARN|KEEP)') { Write-Host $Line -ForegroundColor Yellow }
    else { Write-Host $Line }
}
# The lines a PASSING suite keeps under condensing (review 2026-09-23): SKIP (a skip is never a
# pass), WARN (a deliberate re-review trigger that does not fail — workflow-gates' `WARN [D]`), FAIL
# (a FAIL line that never reached the exit code is the ADR 0127 class, so it stays loud rather than
# folding into `ok`), KEEP (the lib's kept-fixture path), and a child's Write-Warning line — e.g. the
# lib's `Remove-FixtureRoot refused`. The host LOCALIZES that line's label ("WARNING:" in English,
# a Korean label on the owner's ko-KR box — measured 2026-09-23), so it is learned from one probe
# child of the suites' shape, on first use only (~0.8 s measured; never under -Full or -List). A
# probe that yields nothing leaves the WARN word, which covers an English host. A green run carries
# no such line beyond its SKIPs, so this adds nothing to the green output.
# Signal lines are matched on their PLAIN text: a child that decides it may colour its output (NO_COLOR
# unset, e.g. launched from Git Bash) wraps a Write-Warning line in ANSI SGR codes, and a line that
# starts with ESC matches no ^-anchored rule (fix check 2026-09-23: G1c/G1d red from Git Bash). The CSI
# regex is built from [char]27, never an escape typed into the source.
$script:ansiRx = [regex]::new([string][char]27 + '\[[0-9;?]*[ -/]*[@-~]')
function ConvertTo-Plain([string]$Line) { return $script:ansiRx.Replace($Line, '') }
$script:signalRx = $null
function Get-SignalRx {
    if ($null -ne $script:signalRx) { return $script:signalRx }
    $rx = '^(SKIP|WARN|FAIL|KEEP)'
    try {
        $probe = @(& pwsh -NoProfile -ExecutionPolicy Bypass -Command '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Write-Warning ''ywr-warning-label-probe''' 2>&1 | ForEach-Object { "$_" })
        foreach ($l in $probe) {
            $m = [regex]::Match((ConvertTo-Plain $l), '^(\S.*?)\s*ywr-warning-label-probe\s*$')
            if ($m.Success) { $rx += '|^' + [regex]::Escape($m.Groups[1].Value); break }
        }
    } catch { }
    $script:signalRx = $rx
    return $rx
}
Write-Host "--- suites: $($work.Count) selected, jobs=$Jobs — one 'done' line per suite as it finishes (completion order)" -ForegroundColor Cyan
$results = [System.Collections.Generic.List[object]]::new()
$clock = [Diagnostics.Stopwatch]::StartNew()
$work | ForEach-Object -ThrottleLimit $Jobs -Parallel {
    # No per-thread decoding pin, on purpose: [Console]::OutputEncoding is process-wide, so the pin
    # at the top of this file is what decodes here (Start-Job would be a separate cp949 process —
    # not used). Measured 2026-09-23 by mutation: a guarded re-pin in this block changed nothing,
    # and with the top pin removed it still let the Korean case fail, because this script's own
    # stdout writer had already been fixed at its first write.
    $s = $_
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $lines = @()
    $code = -1
    try {
        $global:LASTEXITCODE = -1
        $lines = @(& pwsh -NoProfile -ExecutionPolicy Bypass -File $s.Path 2>&1 | ForEach-Object { "$_" })
        $code = $global:LASTEXITCODE
    } catch {
        # A suite the runner could not even start is a FAILED suite with a reason, never a
        # missing row (and never the previous iteration's exit code on a reused runspace).
        $lines = @($lines) + "FAIL — the runner could not run this suite: $($_.Exception.Message)"
        $code = -1
    }
    $sw.Stop()
    [pscustomobject]@{ Index = $s.Index; Code = $code; Seconds = $sw.Elapsed.TotalSeconds; Lines = [string[]]$lines; Rel = $s.Rel }
} | ForEach-Object {
    $results.Add($_)
    $v = if ($_.Code -eq 0) { 'PASS' } else { 'FAIL' }
    Write-Host "done $($_.Rel) $v ($(Format-Seconds $_.Seconds) s, $(Get-PassCount $_.Lines) PASS lines)" -ForegroundColor $(if ($v -eq 'PASS') { 'Green' } else { 'Red' })
}
$clock.Stop()

# Results in DISCOVERY order, whatever order the suites finished in, so two runs' logs line up.
$byIndex = @{}
foreach ($r in $results) { $byIndex[$r.Index] = $r }
$testFails = 0
$how = if ($Full) { 'every suite in full (-Full)' } else { 'a failed suite in full, a passing suite as one line plus its SKIP/WARN/FAIL/KEEP lines (-Full prints all)' }
Write-Host "--- results in discovery order: $how" -ForegroundColor Cyan
foreach ($w in $work) {
    $r = $byIndex[$w.Index]
    if ($null -eq $r) {
        # A parallel iteration that yielded nothing must not vanish from the count.
        Write-Host "FAIL $($w.Rel) — no result came back from the concurrent run" -ForegroundColor Red
        $failed += "$($w.Name) (no result)"; $testFails++
        continue
    }
    $pass = $r.Code -eq 0
    if (-not $pass) { $failed += $w.Name; $testFails++ }
    $stats = "$(Get-PassCount $r.Lines) PASS lines, $(Format-Seconds $r.Seconds) s"
    if ($Full -or -not $pass) {
        Write-Host "--- $($w.Rel) $(if ($pass) { 'PASS' } else { 'FAIL' }) (exit $($r.Code), $stats) — captured output:" -ForegroundColor $(if ($pass) { 'Cyan' } else { 'Red' })
        foreach ($l in $r.Lines) { Write-SuiteLine $l }
    } else {
        Write-Host "ok   $($w.Rel) ($stats)" -ForegroundColor Green
        $signal = Get-SignalRx
        foreach ($l in $r.Lines) { $p = ConvertTo-Plain $l; if ($p -match $signal) { Write-SuiteLine $p } }
    }
}
$sum = [double]($results | Measure-Object -Property Seconds -Sum).Sum
$slowest = $results | Sort-Object Seconds -Descending | Select-Object -First 1
Write-Host "timing: suites wall-clock $(Format-Seconds $clock.Elapsed.TotalSeconds) s at jobs=$Jobs · sum of suite times $(Format-Seconds $sum) s$(if ($slowest) { " · slowest $($slowest.Rel) $(Format-Seconds $slowest.Seconds) s" })"

Write-Host ''
$shardNote = if ($shardCount) { " shard=$shardIndex/$shardCount selected=$($tests.Count)" } else { '' }
Write-Host "selftests: discovered=$($all.Count)$shardNote passed=$($tests.Count - $testFails) failed=$testFails"
if ($skipped.Count) { Write-Host "skipped gates: $($skipped -join ', ')" -ForegroundColor Yellow }
if ($failed.Count) {
    Write-Host "FAIL — $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "ywr-harness plugin: all gates green$(if ($shardCount) { " (shard $shardIndex/$shardCount)" })$(if ($skipped.Count) { " ($($skipped.Count) skipped — see above)" })" -ForegroundColor Green
exit 0
