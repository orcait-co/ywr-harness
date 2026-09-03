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
  link (CI fails on drift; ywr-harness ADR 0032). A GENERATED Artifact also declares its
  committed `source` file and a `check` drift gate, and is republished via
  `/ywr-harness:artifact-publish` — one confirmation, never headless (ywr-harness ADR 0068).
- `docs/adr/` is append-only; `docs/spec/` is living. Detail in `docs/README.md`.
- Adversarial code review before closing a slice:
  `Workflow({name: 'ywr-harness:adversarial-review', args: {scope: '<files + invariants + passed gates>'}})`.
  Put house-specific review angles in `args.lensExtra` rather than redefining the lens set —
  redefining means later improvements to the canonical lenses never reach this repo.
  The review invariants canon is `REVIEW.md` (seeded at the repo root by harness-init —
  replace the starter with this repo's own invariants; ywr-harness ADR 0054).
- The review runs once per slice: a fix diff for its confirmed findings closes with re-run gates
  + per-finding fix checks, never a second full review — one bounded re-review only when the fix
  is a new mechanism rather than a patch, with the criterion named in the close (ywr-harness
  ADR 0028). A rebase or merge after the review re-arms it only over the overlap — reviewed files
  the incoming commits also touched, plus any hand-resolved conflict; an empty overlap keeps the
  review standing, recorded in the close as `review basis:` (ywr-harness ADR 0072).
- Close each slice with a commit plus an updated handoff — the resume file the `handoff` key in
  `.harness.json` names. A value ending in `/` is a DIRECTORY holding one resume file per work
  line (multi-writer repos), each named after the work line, never after a person (ywr-harness
  ADR 0040). Either form is a resume point, not a ledger: the close that supersedes a
  `## Current state` section moves it to `docs/handoff-archive/<same filename>`, newest first.
  Start the next slice in a NEW session from the handoff.
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
