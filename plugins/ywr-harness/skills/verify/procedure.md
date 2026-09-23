# /verify procedure — spec-owned verification

> You were spawned by the `/ywr-harness:verify` router skill (`SKILL.md` beside this file, ADR 0084) — as
> `ywr-harness:verifier` by default, or as `general-purpose` under ultracode. You get **no
> conversation history**. Scope must be self-derivable: the invocation argument your prompt
> carries, else working tree vs HEAD. Never infer scope from something "we discussed" — it is not
> in this context. `<PLUGIN_ROOT>` below is the plugin root path your prompt names.

Selection is deterministic. Never guess which verify script covers a change.

## 1. Map changed files to verify scripts (advisory, zero tokens)

```
python "<PLUGIN_ROOT>/scripts/verify_map.py"                       # working tree vs HEAD + untracked
python "<PLUGIN_ROOT>/scripts/verify_map.py" --range main~3..HEAD  # slice range ∪ working tree
python "<PLUGIN_ROOT>/scripts/verify_map.py" <file> [...]          # explicit files
```

`--range` unions in the current working tree (including untracked files), so running it
pre-commit still sees everything. The mapper reads `.harness.json` for this repo's paths and
runner, and the generated docs index for `implements_in` — **not** the spec files. If spec
frontmatter changed this session, run `pwsh docs/build.ps1` first.

Invocation argument (your prompt carries it) — when non-empty, use it as the range (or explicit file list).
Sanity-check it first (`git rev-parse` both endpoints, or `git diff --stat <range>` succeeds); on
failure, report the broken scope and stop. **Do NOT silently fall back to the working-tree
default** — a scope you did not verify produces a verdict about files nobody asked about.

Exit 0 is not enough. An **empty commit range** (both endpoints the same, or the commits already
in HEAD) passes every check above and then maps only the working tree — the silent fallback in a
different costume. The mapper prints a `scope:` line and warns when a range matched zero files;
**quote that line** and call an empty range out by name.

The converse exists too (ADR 0041): if git cannot resolve the scope at all, the mapper prints
`scope: FAILED` on stdout and exits **non-zero** — NOTHING was verified. Report that as a broken
scope and stop; never read it as "nothing to verify".

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
agent boundary is re-readable. Per script: the exact command, the script's own self-reported counts
verbatim, and the verdict. An agent boundary is not a rounding opportunity: never compress a partial,
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
