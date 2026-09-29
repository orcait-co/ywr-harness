---
name: verify
description: Single entry over a repo's spec-owned verify scripts. Maps changed files to owning specs via the generated docs index (implements_in) and runs only the registered scripts — never a hardcoded list, which drifts. Use to verify a change end-to-end, or as the verify step of a slice close.
---

# /verify — router

This body runs in the calling context and does ONE thing: spawn the verification agent in the
foreground and relay its report. The procedure lives in `procedure.md` beside this file (ADR 0084), and
the prompt below names it by reference, the form ADR 0025 measured; the agent is fixed (ADR 0108).
The verify tool-call log stays inside that agent and only its report returns — the property the
retired `context: fork` gave (ADR 0025).

**The agent is always `ywr-harness:verifier`** (pinned sonnet · effort medium), ultracode or not
(ADR 0108). ADR 0025 measured medium matching high on this procedure's four trap cases
(normal-with-failure, refused, empty range, broken ref), with the procedure given by reference as
the prompt below does.

**Spawn exactly one Agent tool call.** `subagent_type: "ywr-harness:verifier"`; foreground, never
`run_in_background`; no `model` parameter; `description: "spec-owned verify"`; the prompt EXACTLY as
below, nothing added:

```
Read ${CLAUDE_PLUGIN_ROOT}/skills/verify/procedure.md and follow it exactly.
<PLUGIN_ROOT> in that file means: ${CLAUDE_PLUGIN_ROOT}
Invocation argument (empty = working tree vs HEAD): $ARGUMENTS
Your final message is the verify record, per the procedure's return contract.
```

Do not run the mapper or any verify script yourself, before or after. Do not add scope, file names
or context from the conversation — the agent's scope is the argument alone, by design. Relay the
agent's final message verbatim, then one line: `agent: ywr-harness:verifier`. If the spawn ran as any other
type, say so on that line — it is off-contract. If the spawn fails, report that no verification ran — never a pass.
