# Self-test for subagent-telemetry.ps1 (ADR #112; harness-scope gate ADR #106).
# Temp CLAUDE_PROJECT_DIR fixture — never touches the real repo's telemetry file.
# Usage: pwsh .claude/hooks/subagent-telemetry.selftest.ps1
$ErrorActionPreference = 'Stop'
# Dot-sourced for the FIXTURE half of the core only (ADR 0126) — this file's Pass/Fail shape
# has no MustMatch/MustNotMatch pair, so the assertion half does not apply to it.
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')
$hook = Join-Path $PSScriptRoot 'subagent-telemetry.ps1'
$fx = New-FixtureRoot 'subagent-telemetry-selftest'
trap { Remove-FixtureRoot $fx; break }   # exception-safe teardown, ADR 0126
$log = Join-Path $fx '.claude/telemetry/subagent-stops.jsonl'

function Invoke-Hook([string]$Stdin, [string]$Root) {
    $env:CLAUDE_PROJECT_DIR = $Root
    try { $o = ($Stdin | & pwsh -NoProfile -File $hook 2>&1 | Out-String) }
    finally { Remove-Item Env:CLAUDE_PROJECT_DIR -ErrorAction SilentlyContinue }
    $script:HookExit = $LASTEXITCODE
    return $o
}
function Fail([string]$Name, [string]$Why) { Write-Host "FAIL [$Name]: $Why" -ForegroundColor Red; $script:ok = $false }
function Pass([string]$Name) { Write-Host "PASS [$Name]" -ForegroundColor Green }
function Get-LogLineCount([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-Content -LiteralPath $Path).Count } else { 0 } }

$ok = $true
# 1. valid SubagentStop -> one JSONL line, message text NOT persisted (length only)
$out = Invoke-Hook '{"hook_event_name":"SubagentStop","session_id":"s1","agent_id":"a1","agent_type":"worker","parent_agent_type":"main","last_assistant_message":"SECRETISH finding text"}' $fx
if ($HookExit -ne 0) { Fail 'ledger write' "exit $HookExit" }
elseif (-not (Test-Path -LiteralPath $log)) { Fail 'ledger write' 'no JSONL file created' }
else {
    $rec = Get-Content -LiteralPath $log | Select-Object -Last 1 | ConvertFrom-Json
    if ($rec.agent_type -ne 'worker' -or $rec.agent_id -ne 'a1') { Fail 'ledger write' "wrong fields: $($rec | ConvertTo-Json -Compress)" }
    elseif ($rec.PSObject.Properties.Name -contains 'last_assistant_message') { Fail 'ledger write' 'message text persisted — redaction contract broken' }
    elseif ($rec.last_message_chars -ne 22) { Fail 'ledger write' "length $($rec.last_message_chars) != 22" }
    else { Pass 'ledger write' }
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

# 5. contention spill: target locked exclusively -> line lands in the per-PID spill file
#    (review med 2026-07-23: silent drop under parallel fan-out; spill = no lost lines)
$handle = [IO.File]::Open($log, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try { $out = Invoke-Hook '{"hook_event_name":"SubagentStop","session_id":"s2","agent_id":"a5","agent_type":"locked","parent_agent_type":"main","last_assistant_message":"x"}' $fx }
finally { $handle.Close() }
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
$out = Invoke-Hook ([char]0xFEFF + '{"hook_event_name":"SubagentStop","session_id":"s4","agent_id":"a8","agent_type":"worker","parent_agent_type":"main","last_assistant_message":"bom"}') $fx
$after8 = Get-LogLineCount $log
if ($HookExit -eq 0 -and $after8 -eq ($before8 + 1)) {
    $rec8 = Get-Content -LiteralPath $log | Select-Object -Last 1 | ConvertFrom-Json
    if ($rec8.agent_id -eq 'a8') { Pass 'BOM-prefixed stdin' } else { Fail 'BOM-prefixed stdin' "unexpected row: $($rec8 | ConvertTo-Json -Compress)" }
} else { Fail 'BOM-prefixed stdin' "exit $HookExit, lines $before8->$after8" }

Remove-FixtureRoot $fx
if (-not $ok) { exit 1 }
Write-Host 'subagent-telemetry selftest: all cases green' -ForegroundColor Green
exit 0
