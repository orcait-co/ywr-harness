# Self-test for subagent-telemetry.mjs (harness-scope gate).
# Temp CLAUDE_PROJECT_DIR fixture — never touches the real repo's telemetry file.
# Usage: pwsh .claude/hooks/subagent-telemetry.selftest.ps1
$ErrorActionPreference = 'Stop'
# Dot-sourced for the FIXTURE half of the core only — this file's Pass/Fail shape
# has no MustMatch/MustNotMatch pair, so the assertion half does not apply to it.
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')
$hook = Join-Path $PSScriptRoot 'subagent-telemetry.mjs'
# The hook is Node (ADR 0116): absent node is a reported skip locally and a FAIL on CI. Ahead of the
# fixture root, so neither early exit leaves a tree behind.
Assert-NodeOrExit 'subagent-telemetry'
$fx = New-FixtureRoot 'subagent-telemetry-selftest'
trap { Remove-FixtureRoot $fx; break }   # exception-safe teardown
$log = Join-Path $fx '.claude/telemetry/subagent-stops.jsonl'

function Invoke-Hook([string]$Stdin, [string]$Root) {
    $env:CLAUDE_PROJECT_DIR = $Root
    try { $o = ($Stdin | & node $hook 2>&1 | Out-String) }
    finally { Remove-Item Env:CLAUDE_PROJECT_DIR -ErrorAction SilentlyContinue }
    $script:HookExit = $LASTEXITCODE
    return $o
}
function Fail([string]$Name, [string]$Why) { Write-Host "FAIL [$Name]: $Why" -ForegroundColor Red; $script:ok = $false }
function Pass([string]$Name) { Write-Host "PASS [$Name]" -ForegroundColor Green }
function Get-LogLineCount([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-Content -LiteralPath $Path).Count } else { 0 } }

$ok = $true
# 1. valid SubagentStop -> one JSONL line, message text NOT persisted (length only).
#    The payload is the DOCUMENTED SubagentStop shape (hooks reference, read 2026-09-23: agent_id,
#    agent_type, agent_transcript_path, last_assistant_message, stop_hook_active + common fields) —
#    the former `parent_agent_type` fixture field is not in the reference and the host never sent it
#    (empty in all 1,653 canon ledger rows), so asserting it tested a fake.
$out = Invoke-Hook '{"hook_event_name":"SubagentStop","session_id":"s1","agent_id":"a1","agent_type":"worker","agent_transcript_path":"/tmp/agent-a1.jsonl","stop_hook_active":false,"last_assistant_message":"SECRETISH finding text"}' $fx
if ($HookExit -ne 0) { Fail 'ledger write' "exit $HookExit" }
elseif (-not (Test-Path -LiteralPath $log)) { Fail 'ledger write' 'no JSONL file created' }
else {
    $rec = Get-Content -LiteralPath $log | Select-Object -Last 1 | ConvertFrom-Json
    if ($rec.agent_type -ne 'worker' -or $rec.agent_id -ne 'a1') { Fail 'ledger write' "wrong fields: $($rec | ConvertTo-Json -Compress)" }
    elseif ($rec.PSObject.Properties.Name -contains 'last_assistant_message') { Fail 'ledger write' 'message text persisted — redaction contract broken' }
    elseif ($rec.last_message_chars -ne 22) { Fail 'ledger write' "length $($rec.last_message_chars) != 22" }
    else { Pass 'ledger write' }
    # 1b. the row carries EXACTLY the documented-source columns — no parent_agent_type (never a
    #     documented field), no model (the reference gives SubagentStop none — ADR 0086). A column
    #     added from an undocumented field fails here, not in a reader months later.
    $want = @('agent_id', 'agent_type', 'last_message_chars', 'session_id', 'ts')
    $got = @($rec.PSObject.Properties.Name | Sort-Object)
    if (($got -join ',') -ne ($want -join ',')) { Fail 'ledger columns are the documented set' "columns: $($got -join ',') (want $($want -join ','))" }
    else { Pass 'ledger columns are the documented set' }
}
# 2. wrong event name -> no write
$before = Get-LogLineCount $log
$out = Invoke-Hook '{"hook_event_name":"Stop","agent_id":"a2"}' $fx
$after = Get-LogLineCount $log
if ($HookExit -eq 0 -and $after -eq $before) { Pass 'wrong event no-op' } else { Fail 'wrong event no-op' "exit $HookExit, lines $before->$after" }
# 3. garbage stdin -> silent exit 0, no write
$out = Invoke-Hook 'garbage {{{' $fx
$after2 = Get-LogLineCount $log
if ($HookExit -eq 0 -and $after2 -eq $after -and -not $out.Trim()) { Pass 'garbage fail-open' } else { Fail 'garbage fail-open' "exit $HookExit, out: $($out.Trim())" }
# 4. missing CLAUDE_PROJECT_DIR root -> silent no-op
$out = Invoke-Hook '{"hook_event_name":"SubagentStop","agent_id":"a3"}' (Join-Path $fx 'does-not-exist')
if ($HookExit -eq 0 -and -not $out.Trim()) { Pass 'missing root fail-open' } else { Fail 'missing root fail-open' "exit $HookExit, out: $($out.Trim())" }

# 5. contention spill: target unwritable -> line lands in the per-PID spill file
#    (review med 2026-07-23: silent drop under parallel fan-out; spill = no lost lines)
#    Windows: an exclusive FileShare.None handle is a real OS share lock, so Node's append fails as under
#    fan-out. Elsewhere .NET's FileShare.None is an ADVISORY lock that Node ignores (the append succeeded and
#    no spill was written — CI ubuntu, 2026-10-01), so the ledger path becomes a directory for the call
#    instead: the append fails with EISDIR on every attempt, root included, and the same retry-then-spill
#    path runs. The ledger is restored before case 6.
$payload5 = '{"hook_event_name":"SubagentStop","session_id":"s2","agent_id":"a5","agent_type":"locked","last_assistant_message":"x"}'
if ($IsWindows) {
    $handle = [IO.File]::Open($log, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { $out = Invoke-Hook $payload5 $fx }
    finally { $handle.Close() }
} else {
    $aside = "$log.aside"
    [IO.File]::Move($log, $aside)
    [void][IO.Directory]::CreateDirectory($log)
    try { $out = Invoke-Hook $payload5 $fx }
    finally { [IO.Directory]::Delete($log); [IO.File]::Move($aside, $log) }
}
$spill = @(Get-ChildItem (Join-Path $fx '.claude/telemetry') -Filter 'subagent-stops-spill-*.jsonl' -ErrorAction SilentlyContinue)
if ($HookExit -eq 0 -and $spill.Count -ge 1 -and ((Get-Content -LiteralPath $spill[0].FullName -Raw) -match '"agent_type":"locked"')) { Pass 'contention spill' }
else { Fail 'contention spill' "exit $HookExit, spill files: $($spill.Count)" }
# 6. partial/odd-typed payload: missing agent_id, numeric agent_type -> fail-open row,
#    fields stringified, no crash (pins the [string]-cast degradation visibly)
$before6 = Get-LogLineCount $log
$out = Invoke-Hook '{"hook_event_name":"SubagentStop","session_id":"s3","agent_type":123}' $fx
$after6 = Get-LogLineCount $log
if ($HookExit -eq 0 -and $after6 -eq ($before6 + 1)) {
    $rec6 = Get-Content -LiteralPath $log | Select-Object -Last 1 | ConvertFrom-Json
    if ($rec6.agent_type -eq '123' -and $rec6.agent_id -eq '' -and $rec6.last_message_chars -eq 0) { Pass 'partial payload' }
    else { Fail 'partial payload' "unexpected row: $($rec6 | ConvertTo-Json -Compress)" }
} else { Fail 'partial payload' "exit $HookExit, lines $before6->$after6" }

# 7. empty CLAUDE_PROJECT_DIR root -> silent no-op (the other arm of the compound
#    guard: case 4 covers "-not (Test-Path root)", this covers "-not $root")
$out = Invoke-Hook '{"hook_event_name":"SubagentStop","agent_id":"a4"}' ''
if ($HookExit -eq 0 -and -not $out.Trim()) { Pass 'empty root fail-open' } else { Fail 'empty root fail-open' "exit $HookExit, out: $($out.Trim())" }

# 8. UTF-8 BOM prefixed stdin -> still writes a ledger row (reproduced+fixed
#    2026-07-23: a bare TrimStart([char]0xFEFF) alone is not enough, the BOM bytes
#    decode to garbage under the console's default codepage unless InputEncoding
#    is set to UTF8 first)
$before8 = Get-LogLineCount $log
$out = Invoke-Hook ([char]0xFEFF + '{"hook_event_name":"SubagentStop","session_id":"s4","agent_id":"a8","agent_type":"worker","last_assistant_message":"bom"}') $fx
$after8 = Get-LogLineCount $log
if ($HookExit -eq 0 -and $after8 -eq ($before8 + 1)) {
    $rec8 = Get-Content -LiteralPath $log | Select-Object -Last 1 | ConvertFrom-Json
    if ($rec8.agent_id -eq 'a8') { Pass 'BOM-prefixed stdin' } else { Fail 'BOM-prefixed stdin' "unexpected row: $($rec8 | ConvertTo-Json -Compress)" }
} else { Fail 'BOM-prefixed stdin' "exit $HookExit, lines $before8->$after8" }

# 9. REAL concurrency (the node port's counterpart of case 5's forced lock): a parallel fan-out of
#    hook processes started together against one fresh root must lose no row and tear none — every
#    line lands in the ledger or a spill file, whole, one per agent.
$parRoot = Join-Path $fx 'par'
New-Item -ItemType Directory -Force $parRoot | Out-Null
$nodeExe = (Get-Command node).Source
$procs = @()
foreach ($n in 1..12) {
    $psi = [Diagnostics.ProcessStartInfo]::new($nodeExe)
    $psi.ArgumentList.Add($hook)
    $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $psi.Environment['CLAUDE_PROJECT_DIR'] = $parRoot
    $proc = [Diagnostics.Process]::Start($psi)
    # drain both pipes asynchronously from the start: an unread redirected pipe fills and deadlocks the
    # child (and would hide what a chatty regression printed)
    $procs += , @{ N = $n; P = $proc; Out = $proc.StandardOutput.ReadToEndAsync(); Err = $proc.StandardError.ReadToEndAsync() }
}
foreach ($pr in $procs) {
    $pr.P.StandardInput.Write("{`"hook_event_name`":`"SubagentStop`",`"session_id`":`"par`",`"agent_id`":`"p$($pr.N)`",`"agent_type`":`"fanout`",`"last_assistant_message`":`"x`"}")
    $pr.P.StandardInput.Close()
}
# a child still running after 30 s is killed and named: its pipes never close, so an unbounded .Result
# read below would hang the suite instead of failing it
$hung = @($procs | Where-Object { -not $_.P.WaitForExit(30000) } | ForEach-Object { try { $_.P.Kill($true) } catch { }; "p$($_.N)" })
$badExit = @($procs | Where-Object { -not $_.P.HasExited -or $_.P.ExitCode -ne 0 }).Count
# non-speaking path: every child's stdout AND stderr must be empty (byte-silent)
$chatter = @($procs | ForEach-Object {
        $o = if ($_.Out.Wait(5000)) { $_.Out.Result } else { '(unread)' }
        $e = if ($_.Err.Wait(5000)) { $_.Err.Result } else { '(unread)' }
        if ($o -or $e) { "p$($_.N) stdout[$o] stderr[$e]" } })
if ($hung) { $chatter += "hung after 30 s and killed: $($hung -join ',')" }
$rows = @(Get-ChildItem (Join-Path $parRoot '.claude/telemetry') -Filter 'subagent-stops*.jsonl' -ErrorAction SilentlyContinue |
        ForEach-Object { Get-Content -LiteralPath $_.FullName } | Where-Object { $_ })
$ids = @()
$torn = 0
foreach ($row in $rows) { try { $ids += ($row | ConvertFrom-Json).agent_id } catch { $torn++ } }
$wantIds = @(1..12 | ForEach-Object { "p$_" })
if ($badExit -eq 0 -and -not $chatter.Count -and $torn -eq 0 -and $rows.Count -eq 12 -and (($ids | Sort-Object) -join ',') -eq (($wantIds | Sort-Object) -join ',')) { Pass 'parallel fan-out loses and tears no row' }
else { Fail 'parallel fan-out loses and tears no row' "non-zero exits $badExit, torn $torn, rows $($rows.Count) (want 12), ids $($ids -join ','), output: $($chatter -join ' | ')" }

# 10. ts keeps the shape `ToString('o')` wrote — UTC, 7 fractional digits, Z — and parses as that
#     instant. Read raw: ConvertFrom-Json would turn the string into a DateTime and hide the shape.
$tsRaw = [regex]::Match((Get-Content -LiteralPath $log -Raw), '"ts":"([^"]*)"').Groups[1].Value
$tsParsed = [datetime]::MinValue
if ($tsRaw -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$' -and [datetime]::TryParse($tsRaw, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$tsParsed) -and [Math]::Abs(([datetime]::UtcNow - $tsParsed).TotalMinutes) -lt 30) { Pass 'ts shape' }
else { Fail 'ts shape' "ts '$tsRaw'" }

# 9b. PSCustomObject member access is case-insensitive, so a case-drifted payload still fills the row
#     (every field AND the event name; the exact-case path is case 1).
$before9b = Get-LogLineCount $log
$out = Invoke-Hook '{"Hook_Event_Name":"SubagentStop","Session_Id":"s9","Agent_Id":"a9b","Agent_Type":"Cased","Last_Assistant_Message":"abcd"}' $fx
if ($HookExit -eq 0 -and (Get-LogLineCount $log) -eq ($before9b + 1)) {
    $rec9b = Get-Content -LiteralPath $log | Select-Object -Last 1 | ConvertFrom-Json
    if ($rec9b.session_id -ceq 's9' -and $rec9b.agent_id -ceq 'a9b' -and $rec9b.agent_type -ceq 'Cased' -and $rec9b.last_message_chars -eq 4) { Pass 'case-drifted keys fill the row' }
    else { Fail 'case-drifted keys fill the row' "unexpected row: $($rec9b | ConvertTo-Json -Compress)" }
} else { Fail 'case-drifted keys fill the row' "exit $HookExit, lines $before9b->$(Get-LogLineCount $log)" }

# 11. REGISTRATION: the runtime must call THIS script, in exec form, on SubagentStop. Every case above
#     pipes into the script directly, and the manifest gate checks only that a handler's path
#     resolves — a wrong event key or a `node` that regressed to a shell string would leave the
#     ledger silently empty with all of them green.
$regFails = @()
try {
    $hj = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'hooks.json') -Raw | ConvertFrom-Json
    $sites = @()
    foreach ($evName in @($hj.hooks.PSObject.Properties.Name | Where-Object { $_ })) {
        foreach ($grp in @($hj.hooks.$evName | Where-Object { $_ })) {
            foreach ($h in @($grp.hooks | Where-Object { $_ })) {
                if ((@([string]$h.command) + @($h.args | ForEach-Object { [string]$_ })) -join ' ' -match 'subagent-telemetry\.(ps1|mjs)') { $sites += [pscustomobject]@{ Event = $evName; H = $h } }
            }
        }
    }
    if ($sites.Count -ne 1) { $regFails += "want exactly 1 registration, found $($sites.Count)" }
    else {
        $gotArgs = @($sites[0].H.args | ForEach-Object { [string]$_ })
        if ($sites[0].Event -cne 'SubagentStop') { $regFails += "event '$($sites[0].Event)' (want SubagentStop)" }
        if ([string]$sites[0].H.type -cne 'command' -or [string]$sites[0].H.command -cne 'node') { $regFails += "handler type/command '$($sites[0].H.type)'/'$($sites[0].H.command)' (want command/node)" }
        if (($gotArgs -join "`0") -cne '${CLAUDE_PLUGIN_ROOT}/hooks/subagent-telemetry.mjs') { $regFails += "args [$($gotArgs -join ' ')] (want exec form [`${CLAUDE_PLUGIN_ROOT}/hooks/subagent-telemetry.mjs])" }
        if ([string]$sites[0].H.timeout -ne '10') { $regFails += "timeout '$($sites[0].H.timeout)' (want 10)" }
    }
} catch { $regFails += "hooks.json unreadable: $($_.Exception.Message)" }
if (-not $regFails.Count) { Pass 'hooks.json registers this script once: SubagentStop, exec-form node <script>' } else { Fail 'registration' ($regFails -join ' · ') }

Remove-FixtureRoot $fx
if (-not $ok) { exit 1 }
Write-Host 'subagent-telemetry selftest: all cases green' -ForegroundColor Green
exit 0
