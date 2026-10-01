// SubagentStop — per-agent delegation ledger line. Complements the
// in-workflow budget laps (which DO capture output tokens): SubagentStop input carries
// NO token/duration fields (doc-verified 2026-07-23), so this ledger records who/what/
// when — covering Agent-tool spawns the workflow laps never see. Workflow agent()
// spawns DO fire this event: the canon's own ledger answered the question this header
// once left open — 584 of 1,653 rows (2026-07-28..09-23) carry agent_type
// 'workflow-subagent'. Only DOCUMENTED SubagentStop fields are recorded: the former
// parent_agent_type column read a field the hooks reference does not list and was empty
// in all 1,653 rows, so it is gone; there is no model column either — the reference
// gives SubagentStop no model field (ADR 0086). last_assistant_message is deliberately
// NOT persisted (secret-adjacent surface — never persist what may carry a secret); only its
// length is kept.
// Appends JSONL to .claude/telemetry/subagent-stops.jsonl (gitignored). Fail-open.
//
// Row shape is the pwsh original's: ts (UTC, ISO 8601 with 7 fractional digits and a Z — the shape
// `ToString('o')` wrote; JS has milliseconds, so the last four digits are zero), then session_id,
// agent_id, agent_type, last_message_chars — each field the PowerShell `[string]` cast of the
// payload value (missing/null -> '', never "undefined"), the length in UTF-16 code units. One line
// per event ending in a bare LF: the original's Add-Content appended the platform newline (CRLF on
// Windows), and every reader here is line-oriented and indifferent to the choice. UTF-8, no BOM.
import fs from 'node:fs'
import path from 'node:path'
import { readStdin, parseJson, isObject, getProp, psString, ieq, sleep } from './hook-lib.mjs'

function main(payload) {
  const root = process.env.CLAUDE_PROJECT_DIR || ''
  if (!root || !fs.existsSync(root)) return
  try {
    const dir = path.join(root, '.claude', 'telemetry')
    fs.mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({
      ts: new Date().toISOString().replace('Z', '0000Z'),
      session_id: psString(getProp(payload, 'session_id')),
      agent_id: psString(getProp(payload, 'agent_id')),
      agent_type: psString(getProp(payload, 'agent_type')),
      last_message_chars: psString(getProp(payload, 'last_assistant_message')).length,
    }) + '\n'
    // Parallel fan-out stops collide on the append (Windows share-mode error) —
    // retry with jitter, then SPILL to a per-PID file rather than lose the line
    // (review med, 2026-07-23: an empty catch here silently dropped ledger rows).
    // Readers glob subagent-stops*.jsonl.
    const target = path.join(dir, 'subagent-stops.jsonl')
    let written = false
    for (let i = 0; i < 3 && !written; i++) {
      try { fs.appendFileSync(target, line, 'utf8'); written = true } catch { sleep(20 + Math.floor(Math.random() * 60)) }
    }
    if (!written) {
      try { fs.appendFileSync(path.join(dir, `subagent-stops-spill-${process.pid}.jsonl`), line, 'utf8') } catch { /* nothing left to try */ }
    }
  } catch { /* fail-open */ }
}

try {
  const payload = parseJson(readStdin())
  if (isObject(payload) && ieq(psString(getProp(payload, 'hook_event_name')), 'SubagentStop')) main(payload)
} catch { /* fail-open */ }
