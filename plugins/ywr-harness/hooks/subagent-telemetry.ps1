# SubagentStop — per-agent delegation ledger line (ADR #112). Complements the
# in-workflow budget laps (which DO capture output tokens): SubagentStop input carries
# NO token/duration fields (doc-verified 2026-07-23), so this ledger records who/what/
# when — covering Agent-tool spawns the workflow laps never see. Workflow agent()
# spawns DO fire this event: the canon's own ledger answered the question this header
# once left open — 584 of 1,653 rows (2026-07-28..09-23) carry agent_type
# 'workflow-subagent'. Only DOCUMENTED SubagentStop fields are recorded: the former
# parent_agent_type column read a field the hooks reference does not list and was empty
# in all 1,653 rows, so it is gone; there is no model column either — the reference
# gives SubagentStop no model field (ADR 0086). last_assistant_message is deliberately
# NOT persisted (secret-adjacent surface — ADR #110 redaction principle); only its
# length is kept.
# Appends JSONL to .claude/telemetry/subagent-stops.jsonl (gitignored). Fail-open.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
try { $payload = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { exit 0 }
if ([string]$payload.hook_event_name -ne 'SubagentStop') { exit 0 }
$root = [string]$env:CLAUDE_PROJECT_DIR
if (-not $root -or -not (Test-Path -LiteralPath $root)) { exit 0 }
try {
    $dir = Join-Path $root '.claude/telemetry'
    New-Item -ItemType Directory -Force $dir | Out-Null
    $line = [ordered]@{
        ts                 = (Get-Date).ToUniversalTime().ToString('o')
        session_id         = [string]$payload.session_id
        agent_id           = [string]$payload.agent_id
        agent_type         = [string]$payload.agent_type
        last_message_chars = ([string]$payload.last_assistant_message).Length
    } | ConvertTo-Json -Compress
    # Parallel fan-out stops collide on Add-Content (Windows share-mode IOException) —
    # retry with jitter, then SPILL to a per-PID file rather than lose the line
    # (review med, 2026-07-23: an empty catch here silently dropped ledger rows).
    # Readers glob subagent-stops*.jsonl.
    # -ErrorAction Stop is load-bearing: Add-Content share-violation errors are
    # NON-terminating by default — without Stop the catch never fires and the loop
    # "succeeds" while the line vanishes (caught live by selftest case 5, 2026-07-23).
    $target = Join-Path $dir 'subagent-stops.jsonl'
    $written = $false
    for ($i = 0; $i -lt 3 -and -not $written; $i++) {
        try { Add-Content -LiteralPath $target -Value $line -Encoding utf8 -ErrorAction Stop; $written = $true }
        catch { Start-Sleep -Milliseconds (20 + (Get-Random -Maximum 60)) }
    }
    if (-not $written) {
        try { Add-Content -LiteralPath (Join-Path $dir "subagent-stops-spill-$PID.jsonl") -Value $line -Encoding utf8 -ErrorAction Stop } catch { }
    }
} catch { }
exit 0
