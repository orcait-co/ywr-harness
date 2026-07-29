---
name: verify
description: Single entry over a repo's spec-owned verify scripts. Maps changed files to owning specs via the generated docs index (implements_in) and runs only the registered scripts — never a hardcoded list, which drifts. Use to verify a change end-to-end, or as the verify step of a slice close.
context: fork
agent: worker
background: false
---

> **Runs as a forked subagent**: the verify tool-call log stays out of the main context and only
> the report returns. Both companion keys are load-bearing, not decoration:
> - `agent: worker` — omitting `agent` defaults to `general-purpose`, which carries no
>   `model`/`effort` pins and would inherit a deep-work session's model and effort. `worker` is
>   pinned sonnet · high. Not `mech`: precondition triage is judgment, and mech's contract is to
>   stop rather than judge.
> - `background: false` — a slice close consumes this result in the same turn, and a backgrounded
>   fork would additionally run with the narrower background-subagent tool set.
>
> The fork gets **no conversation history**. Scope must be self-derivable: the `$ARGUMENTS` range
> below, else working tree vs HEAD. Never infer scope from something "we discussed" — it is not in
> this context.

# /verify — spec-owned verification

Selection is deterministic. Never guess which verify script covers a change.

## 1. Map changed files to verify scripts (advisory, zero tokens)

```
python "${CLAUDE_PLUGIN_ROOT}/scripts/verify_map.py"                       # working tree vs HEAD + untracked
python "${CLAUDE_PLUGIN_ROOT}/scripts/verify_map.py" --range main~3..HEAD  # slice range ∪ working tree
python "${CLAUDE_PLUGIN_ROOT}/scripts/verify_map.py" <file> [...]          # explicit files
```

`--range` unions in the current working tree (including untracked files), so running it
pre-commit still sees everything. The mapper reads `.harness.json` for this repo's paths and
runner, and the generated docs index for `implements_in` — **not** the spec files. If spec
frontmatter changed this session, run `pwsh docs/build.ps1` first.

Invocation argument: `$ARGUMENTS` — when non-empty, use it as the range (or explicit file list).
Sanity-check it first (`git rev-parse` both endpoints, or `git diff --stat <range>` succeeds); on
failure, report the broken scope and stop. **Do NOT silently fall back to the working-tree
default** — a scope you did not verify produces a verdict about files nobody asked about.

Exit 0 is not enough. An **empty commit range** (both endpoints the same, or the commits already
in HEAD) passes every check above and then maps only the working tree — the silent fallback in a
different costume. The mapper prints a `scope:` line and warns when a range matched zero files;
**quote that line** and call an empty range out by name.

## 2. Check preconditions before running anything

Preconditions are repo knowledge, not harness knowledge: read this repo's `CLAUDE.md` for the
local stack, seeds, migrations, credentials, and any environment that a verify script assumes.

Two rules regardless of repo:

- A check you could not run is **reported as skipped, never as passed**. If a dependency is
  missing (a gateway, a service, a key), run the rest and say plainly which section did not run.
- If a script fails for an environmental reason that looks like a code bug, say so and name the
  environmental cause. A false failure reported as a code failure costs more than no run at all.

## 3. Run the printed commands

Run what appears after `run:`, and **only** that. A line labelled `REFUSED:` instead of `run:` is
not a command and must never be executed — the mapper could not compose a safe command for that
script's registered path. Report it as a coverage gap and quote the accompanying warning; a refused
script reported as a failing script blames the code for a declaration problem.

Judge from script output only — registered scripts self-report pass/fail counts. Report per-script
results verbatim. A partial run is a partial run.

**Return contract** — your final message IS the verify record the caller quotes; nothing behind the
fork boundary is re-readable. Per script: the exact command, the script's own self-reported counts
verbatim, and the verdict. A fork boundary is not a rounding opportunity: never compress a partial,
skipped, or failed run into a green summary.

When the map registers **nothing** for the diff (a docs-only slice, for instance), the report is
"no registered verify script maps to this diff". That is a scope statement, **not a pass**.

**Coverage honesty**: registered scripts cover what they cover. If the mapper prints the UI note,
a green run did not exercise component rendering — cover it with a browser-level test where one
exists, or say plainly that the surface was not verified.

## 4. Unmapped files

Files the mapper flags as unmapped have no spec owner. Register them in a spec's `implements_in`
rather than hand-picking a verify script — hand-picking is the guess this skill exists to remove.

A new verify script must be registered in its spec's `implements_in`. That is the only place this
skill looks.
