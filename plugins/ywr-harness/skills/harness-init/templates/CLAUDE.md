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

## Review canon

The slice-close review, `/code-review`, reads this section because every session loads `CLAUDE.md`
(ywr-harness ADR 0217). `.harness.json` `review.canon` names this file. The invariants also bind every
change you write. The gotchas apply when you review. Keep the heading: the gate emitter warns when it
is missing. Replace the two starters with this repo's own invariants, and keep the ones that still hold.

### Invariants

Each entry states a bold claim, the mechanism that enforces or checks it, and the decision record
that says why.

1. **Secrets are never committed.** `.env` is gitignored. Commit `.env.example` only. The pre-push
   hook scans added lines. A false positive takes `harness:allow-secret` on its line, never
   `--no-verify`.
2. **A skipped check is reported as skipped, never as passed.** A coverage cap, such as top-N,
   sampling or an exclusion filter, is stated with the result. A green that covered less than it
   claims is worse than a red.

<!-- Add this repo's own invariants here, e.g.:
3. **<data guarantee>** <mechanism that enforces it> (<ADR NNNN>).
4. **<boundary that must hold>** <check that catches a violation> (<spec NNNN>).
-->

### Review-time gotchas

Each entry states a trap that cost a real debugging session, how it was measured, and what to do
instead. A new repo has none yet. The first entry usually comes with the first postmortem.

<!--
  Scaffolded by the ywr-harness plugin (`/ywr-harness:harness-init`). Replace every <placeholder>.
  Anything still in angle brackets is a line nobody has decided yet.
-->
