---
name: verify
description: Single entry over a repo's spec-owned verify scripts. Maps changed files to owning specs via the generated docs index (implements_in) and runs only the registered scripts — never a hardcoded list, which drifts. Use to verify a change end-to-end, or as the verify step of a slice close.
---

# /verify — router

This body runs in the calling context and does ONE thing: spawn the verification agent in the
foreground and relay its report. The procedure lives in `procedure.md` beside this file, so the
agent that runs it is chosen per call (ADR 0084). The verify tool-call log stays inside that agent
and only its report returns — the property the retired `context: fork` gave (ADR 0025).

**Pick the agent** — this is the only judgment here:

- **Default → `ywr-harness:verifier`** (pinned sonnet · effort medium). ADR 0025 measured medium
  matching high on this procedure's four trap cases (normal-with-failure, refused, empty range,
  broken ref), with the procedure given by reference as the prompt below does.
- **Ultracode → `general-purpose`**, which inherits the session model and effort (measured, ADR
  0084). That is the session's level, not a forced `xhigh`: the Agent tool has no effort parameter. Ultracode means the host says it is on for the session, or the host confirmed the
  prompt's `ultracode` keyword opt-in. A bare mention of the word is not the opt-in.

**Spawn exactly one Agent tool call.** Foreground, never `run_in_background`; no `model`
parameter; `description: "spec-owned verify"`; the prompt EXACTLY as below, nothing added:

```
Read ${CLAUDE_PLUGIN_ROOT}/skills/verify/procedure.md and follow it exactly.
<PLUGIN_ROOT> in that file means: ${CLAUDE_PLUGIN_ROOT}
Invocation argument (empty = working tree vs HEAD): $ARGUMENTS
Your final message is the verify record, per the procedure's return contract.
```

Do not run the mapper or any verify script yourself, before or after. Do not add scope, file names
or context from the conversation — the agent's scope is the argument alone, by design. Relay the
agent's final message verbatim, then one line naming the agent that ran (`verifier` or
`general-purpose`). If the spawn fails, report that no verification ran — never a pass.
