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

- Before adding a dependency or pattern, check `docs/adr` for an existing decision.
  A new decision → write the ADR first.
- Never commit secrets. `.env` is gitignored; commit `.env.example` only.
- A claude.ai Artifact this repo publishes is titled **`<repo-name> · <purpose>`** and declared
  under `artifacts` in `.harness.json` — the harness then enforces that the README carries the
  link (CI fails on drift; ywr-harness ADR 0032).
- `docs/adr/` is append-only; `docs/spec/` is living. Detail in `docs/README.md`.
- Adversarial code review before closing a slice:
  `Workflow({name: 'ywr-harness:adversarial-review', args: {scope: '<files + invariants + passed gates>'}})`.
  Put house-specific review angles in `args.lensExtra` rather than redefining the lens set —
  redefining means later improvements to the canonical lenses never reach this repo.
  The review invariants canon is `REVIEW.md` (shipped by the ywr-harness plugin).
- The review runs once per slice: a fix diff for its confirmed findings closes with re-run gates
  + per-finding fix checks, never a second full review — one bounded re-review only when the fix
  is a new mechanism rather than a patch, with the criterion named in the close.
- Run the deterministic gates (lint, format, typecheck) on the slice scope BEFORE any LLM
  review, and state which gates passed in the review scope. Mechanical defects should never
  cost review tokens.

## Deliverable length

Match each document's length to the task. This file and any always-loaded handoff are the
strictest: every line here is re-read on every session. Cut padding, never substance —
rejected options, residual risks, and "not verified" statements stay.

<!--
  Scaffolded by the ywr-harness plugin (`/ywr-harness:harness-init`). Replace every <placeholder>.
  Anything still in angle brackets is a line nobody has decided yet.
-->
