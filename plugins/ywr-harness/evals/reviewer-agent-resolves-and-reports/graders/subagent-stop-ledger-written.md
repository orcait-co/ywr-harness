---
type: regex
target: { source: file, path: .claude/telemetry/subagent-stops.jsonl }
pattern: '"agent_type":"[^"]*reviewer'
arm: with-only
---
