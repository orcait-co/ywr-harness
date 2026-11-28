---
name: verify
description: Single entry over a repo's spec-owned verify scripts. Maps changed files to owning specs via the generated docs index (implements_in) and runs only the registered scripts — never a hardcoded list, which drifts. Use to verify a change end-to-end, or as the verify step of a slice close.
---

# /verify — router

This body runs in the calling context. It runs the mapper first, and it spawns the verification
agent only when the mapper names a script to run (ywr-harness ADR 0242). The procedure for that agent
lives in `procedure.md` beside this file. The verify tool-call log stays inside that agent; only its
report returns.

## 1. Run the mapper (zero tokens)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify_map.mjs"                    # no argument: working tree vs HEAD
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify_map.mjs" --range '<a>..<b>' # a range
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify_map.mjs" '<file>' [...]     # files
```

The argument is: `$ARGUMENTS`. Read it as tokens:

- It starts with `--range` → pass its tokens unchanged.
- It is ONE token that holds `..` and names no existing file (`origin/main..HEAD`) → pass `--range` and
  that token. A wrong guess ends at `scope: FAILED`, rule 2 below.
- Anything else → pass each token as a file. A path that the argument quotes stays one token.

Put each token in single quotes. A token that holds a single quote, a newline or a NUL is refused:
report that nothing was verified, and stop. The mapper is the range check (ywr-harness ADR 0041); never
check the range with git first.

## 2. Decide from its output

Read the rules in this order; the first that matches decides.

1. **The mapper did not run, exited non-zero, or printed no `scope:` line** (a denied tool call, a
   missing `node`, a usage error, a crash) → quote what it printed, stdout and stderr, and report that
   nothing was verified. Stop. This is never a pass.
2. **`scope: FAILED`** or **`index: FAILED`** → quote the output verbatim and report that nothing was
   verified. Stop.
3. **`index: ABSENT`** → quote the output verbatim: the repo has no docs index, so nothing was
   spec-verified. Stop.
4. **`index: STALE`**, or **at least one `run:` line** → spawn the agent (§3).
5. **Otherwise** → quote the mapper output verbatim as the verify record, then say "no registered verify
   script maps to this diff": a scope statement, **not a pass**. When the `scope:` line reports an empty
   range or a range that matched no file, name the empty range: the map then covers the working tree
   only. Each `REFUSED:` line is a coverage gap, never a failing script. End with the line
   `agent: none — no run: line`. Spawn nothing.

## 3. Spawn the agent

**The agent is always `ywr-harness:verifier`** (pinned sonnet · effort medium), ultracode or not
(ywr-harness ADR 0108).

**Spawn exactly one Agent tool call.** `subagent_type: "ywr-harness:verifier"`; foreground, never
`run_in_background`; no `model` parameter; `description: "spec-owned verify"`; the prompt EXACTLY as
below, nothing added:

```
Read ${CLAUDE_PLUGIN_ROOT}/skills/verify/procedure.md and follow it exactly.
<PLUGIN_ROOT> in that file means: ${CLAUDE_PLUGIN_ROOT}
Invocation argument (empty = working tree vs HEAD): $ARGUMENTS
Your final message is the verify record, per the procedure's return contract.
```

The agent runs the mapper again from its own scope. Do not run any verify script yourself, before or
after. Do not add scope, file names or context from the conversation — the agent's scope is the
argument alone, by design. Relay the agent's final message verbatim, then one line:
`agent: ywr-harness:verifier`. If the spawn ran as any other type, say so on that line — it is
off-contract. If the spawn fails, report that no verification ran — never a pass.
