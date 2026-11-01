# <REPO NAME>

> One paragraph: what this repo is, and what it is NOT. Name where the context that does not
> live here is kept, so a session knows when to go look elsewhere instead of guessing.

## What this repo is

- <purpose · owner · deployment target>
- <the one or two facts a new session would otherwise get wrong>

## Architecture (settled decisions — detail in docs/adr)

- **<stack>**: <languages · frameworks · datastore · job queue · auth>
- <invariants that must not be violated, each with its ADR number>

## Commands

- Local dev: <command>
- Docs regeneration: `pwsh docs/build.ps1`
- Lint: <per-language lint command, scoped to the slice — not the whole tree>
- Tests: <command>

## Working principles

- The org guide states the general rules. While `.harness.json` is at the repo root, the ywr-harness
  plugin states the slice rules at each session start: the review, the close, the handoff, Artifacts
  and slice notes (ywr-harness ADR 0183). Add here only this repo's own principles.

<!--
  Scaffolded by the ywr-harness plugin (`/ywr-harness:harness-init`). Replace every <placeholder>.
  Anything still in angle brackets is a line nobody has decided yet.
-->
