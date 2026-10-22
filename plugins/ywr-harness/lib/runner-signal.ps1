# The shared code of the two selftest runners: plugins/ywr-harness/selftest.ps1 and the canon's
# scripts/canon-selftest.ps1 both dot-source this file, so each part has one copy. It holds the
# signal-line rule (ADR 0162) and the suite process with its bounded waits (ADR 0165, ADR 0166); both
# had two copies, held in step by hand. Dot-source it from the runner's script scope; do not run it.
# The $script: variables land in the runner's own script scope. A runner fixture copies this file
# beside its runner copy.
#
# The lines a PASSING suite keeps under condensing (review 2026-09-23): SKIP (a skip is never a
# pass), WARN (a deliberate re-review trigger that does not fail — workflow-gates' `WARN [D]`), FAIL
# (a FAIL line that never reached the exit code is a gate judged from the wrong observable, so it
# stays loud rather than folding into `ok`), KEEP (the lib's kept-fixture path), and a child's
# Write-Warning line — e.g. the lib's `Remove-FixtureRoot refused`. The host LOCALIZES that line's
# label ("WARNING:" in English, a Korean label on the owner's ko-KR box — measured 2026-09-23), so
# it is learned from one probe child of the suites' shape, on first use only (~0.8 s measured; never
# under -Full or -List). A probe that learns no label leaves the WARN word, which covers an English
# host only, so a failed probe is never silent: the runner prints one `WARN [runner]` line with its
# reason (spec 0008 §3.1, spec 0015 §2). A green run with a working probe carries no such line beyond its SKIPs.
# Signal lines are matched on their PLAIN text: a child that decides it may colour its output (NO_COLOR
# unset, e.g. launched from Git Bash) wraps a Write-Warning line in ANSI SGR codes, and a line that
# starts with ESC matches no ^-anchored rule (fix check 2026-09-23: G1c/G1d red from Git Bash). The CSI
# regex is built from [char]27, never an escape typed into the source. The probe child is the
# runner's own pwsh ([Environment]::ProcessPath). The plugin runner starts its suites with that binary;
# the canon runner starts its suites with $PSHOME's pwsh, the same file under a normal pwsh host (ADR 0162).
function Write-SuiteLine([string]$Line) {
    if ($Line -match '^FAIL') { Write-Host $Line -ForegroundColor Red }
    elseif ($Line -match '^(SKIP|WARN|KEEP)') { Write-Host $Line -ForegroundColor Yellow }
    else { Write-Host $Line }
}
$script:ansiRx = [regex]::new([string][char]27 + '\[[0-9;?]*[ -/]*[@-~]')
function ConvertTo-Plain([string]$Line) { return $script:ansiRx.Replace($Line, '') }
$script:signalRx = $null
$script:signalProbeMiss = $null
function Get-SignalRx {
    if ($null -ne $script:signalRx) { return $script:signalRx }
    $rx = '^(SKIP|WARN|FAIL|KEEP)'
    $learned = $false
    try {
        $probe = @(& ([Environment]::ProcessPath) -NoProfile -ExecutionPolicy Bypass -Command '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Write-Warning ''ywr-warning-label-probe''' 2>&1 | ForEach-Object { "$_" })
        foreach ($l in $probe) {
            $m = [regex]::Match((ConvertTo-Plain $l), '^(\S.*?)\s*ywr-warning-label-probe\s*$')
            if ($m.Success) { $rx += '|^' + [regex]::Escape($m.Groups[1].Value); $learned = $true; break }
        }
        if (-not $learned) { $script:signalProbeMiss = "no label line in $($probe.Count) probe line(s)" }
    } catch { $script:signalProbeMiss = "the probe threw: $($_.Exception.Message)" }
    $script:signalRx = $rx
    return $rx
}

# --- the suite process (ADR 0165, ADR 0166) -------------------------------------------------------
# Process.Start passes every inheritable handle of the runner to each suite, and a suite passes them on
# to its own children. The runner's stdout and stderr are inheritable, so a stuck grandchild could keep the
# CALLER's pipe open after the runner exited (fact 169). Each suite gets its own pipes as std handles, so
# clearing the flag costs the suites nothing. Linux needs no step: .NET opens its descriptors
# close-on-exec. The P/Invoke is emitted, not compiled: Add-Type cost ~710 ms, the emit ~35 ms.
# Returns $null, or the reason the flag stays set; the runner prints that reason as one WARN line.
function Clear-StdHandleInherit {
    if (-not $IsWindows) { return $null }
    $miss = $null
    try {
        $tb = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly([Reflection.AssemblyName]::new('RunnerNoInherit'), 'Run').DefineDynamicModule('m').DefineType('K', 'Public, Abstract, Sealed')
        foreach ($sig in @(@('GetStdHandle', [IntPtr], [Type[]]@([int])), @('SetHandleInformation', [bool], [Type[]]@([IntPtr], [uint32], [uint32])))) {
            $tb.DefinePInvokeMethod($sig[0], 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', $sig[1], $sig[2], 'Winapi', 'Auto').SetImplementationFlags('PreserveSig')
        }
        $k32 = $tb.CreateType()
        foreach ($std in -11, -12) {   # STD_OUTPUT_HANDLE, STD_ERROR_HANDLE; HANDLE_FLAG_INHERIT is 1
            if (-not $k32::SetHandleInformation($k32::GetStdHandle($std), 1, 0)) { $miss = "SetHandleInformation returned false for std handle $std" }
        }
    } catch { $miss = "the P/Invoke threw: $($_.Exception.Message)" }
    return $miss
}

# Runs one suite as a Process object, not `& pwsh`: `&` returns only at end-of-file on the pipes, which a
# stuck descendant can hold for hours, and a timeout needs a handle to kill (ADR 0098). Every wait has a
# bound: $Limit seconds, then exit + min($Limit, 30) s for a held pipe, or kill + 30 s. Both pipes are read
# as UTF-8, line by line as the lines arrive, so a held pipe or a kill loses nothing the suite wrote. Lines
# that arrive together keep stdout first, so a stderr line can land after a stdout line written after it;
# nothing keys on that order (the verdict is the exit code). Returns Lines, Code (-1 when no exit code is
# the verdict) and Seconds.
# A runner calls it from ForEach-Object -Parallel threads, which do not see the runner's functions:
# Get-SuiteProcessFn returns this definition as text, and each thread dot-sources it from $using:.
function Invoke-SuiteProcess {
    param([string]$Exe, [string[]]$ArgList, [int]$Limit)
    $grace = [Math]::Min($Limit, 30)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $lines = [Collections.Generic.List[string]]::new()
    $code = -1
    try {
        $psi = [Diagnostics.ProcessStartInfo]::new($Exe)
        foreach ($a in $ArgList) { $psi.ArgumentList.Add($a) }
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
        $psi.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
        $p = [Diagnostics.Process]::Start($psi)
        $readers = @($p.StandardOutput, $p.StandardError)
        $reads = @($readers[0].ReadLineAsync(), $readers[1].ReadLineAsync())   # $null once that pipe hit end-of-file
        $exit = $p.WaitForExitAsync()
        $endAt = $Limit * 1000L   # on $sw: the suite's limit, then exit + grace, or kill + 30 s
        $exited = $false; $timedOut = $false; $held = $false; $unkillable = $false
        # Takes every line already read, dot-sourced so it updates $reads and $lines here. $drainUntil keeps a
        # suite that never stops printing from starving its own deadline.
        $drain = {
            for ($k = 0; $k -lt 2; $k++) {
                while ($reads[$k] -and $reads[$k].IsCompleted -and $sw.ElapsedMilliseconds -lt $drainUntil) {
                    # A faulted read ends that pipe like end-of-file; what came before it is kept.
                    $line = if ($reads[$k].Status -eq 'RanToCompletion') { $reads[$k].Result } else { $null }
                    if ($null -eq $line) { $reads[$k] = $null } else { $lines.Add($line); $reads[$k] = $readers[$k].ReadLineAsync() }
                }
            }
        }
        while ($true) {
            $drainUntil = $endAt; . $drain
            if (-not $exited -and $exit.IsCompleted) {
                $exited = $true
                if (-not $timedOut) { $endAt = $sw.ElapsedMilliseconds + $grace * 1000L }
            }
            if ($exited -and -not $reads[0] -and -not $reads[1]) { break }
            $left = $endAt - $sw.ElapsedMilliseconds
            if ($left -le 0) {
                if ($exited) {
                    # Lines already buffered or read when the grace ran out are kept; one more second caps a
                    # descendant that keeps writing.
                    $drainUntil = $sw.ElapsedMilliseconds + 1000L; . $drain
                    $held = [bool]($reads[0] -or $reads[1])
                    break
                }
                # A kill that threw or did not take must not trade one unbounded wait for another.
                if ($timedOut) { $unkillable = $true; break }
                # The whole tree: a suite's own children (fixture gits, nested pwsh) would otherwise
                # keep the pipes open.
                $timedOut = $true
                try { $p.Kill($true) } catch { }
                $endAt = $sw.ElapsedMilliseconds + 30000L
                continue
            }
            $wait = [Threading.Tasks.Task[]]@(@($reads[0], $reads[1], $(if (-not $exited) { $exit })) | Where-Object { $_ })
            $null = [Threading.Tasks.Task]::WaitAny($wait, [int]$left)
        }
        if ($unkillable) {
            $lines.Add("FAIL — this suite exceeded -SuiteTimeout $Limit s and was still running 30 s after the kill")
        } elseif ($timedOut) {
            $lines.Add("FAIL — this suite exceeded -SuiteTimeout $Limit s and was killed with its process tree")
        } else {
            $code = $p.ExitCode
        }
        if ($held -and -not $unkillable) {
            $lines.Add("WARN [runner] this suite exited, but a process it started still held its output pipe $(if ($timedOut) { 30 } else { $grace }) s later; the runner stopped reading, and the exit code is the verdict")
        }
    } catch {
        # A suite the runner could not even start is a FAILED suite with a reason, never a missing row.
        $lines.Add("FAIL — the runner could not run this suite: $($_.Exception.Message)")
        $code = -1
    }
    $sw.Stop()
    return [pscustomobject]@{ Lines = [string[]]$lines; Code = $code; Seconds = $sw.Elapsed.TotalSeconds }
}
function Get-SuiteProcessFn { "function Invoke-SuiteProcess {${function:Invoke-SuiteProcess}}" }
