# The signal-line rule of the two selftest runners: plugins/ywr-harness/selftest.ps1 and the canon's
# scripts/canon-selftest.ps1 both dot-source this file, so the rule has one copy (it had two, held in
# step by hand). Dot-source it from the runner's script scope; do not run it. The $script: variables
# land in the runner's own script scope. A runner fixture copies this file beside its runner copy.
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
