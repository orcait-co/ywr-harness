# REVIEW.md — house review invariants (starter seed)

> **This is a starter placed by /ywr-harness:harness-init (ADR 0054) — replace its content with
> THIS repo's own decisions.** It is a SEED: never overwritten, and deliberately outside the
> re-run drift report, so what you write here stays yours. Until it is rewritten, reviews run
> against the generic invariants below — real, but not this repo's.

This file is the single source of review invariants for every review path in this repo:
`/ywr-harness:slice-close` assembles its `invariants` block from it, and ad-hoc PR or human
reviews cite it. Edit here, never keep inline copies elsewhere. When reviewing, trim to the
invariants the change can actually violate (proportionality).

## Invariants

Each entry: **bold claim**, the mechanism that enforces or checks it, and the source decision
(ADR/spec number) so a reviewer can read why. Two starters every repo shares — keep them, then
add the invariants only this repo can know (its data guarantees, its security boundaries, its
deterministic cores):

1. **Secrets are never committed** — `.env` is gitignored (root seed, ADR 0053); commit
   `.env.example` only. The pre-push hook scans added lines; a false positive is exempted per
   line with `harness:allow-secret`, never with `--no-verify`.
2. **Skipped checks are reported as skipped, never counted as passed** — and any coverage cap
   (top-N, sampling, an exclusion filter) is stated with the result. A green that silently
   covered less than it claims is worse than a red.

<!-- Add this repo's own invariants here, e.g.:
3. **<data guarantee>** — <mechanism that enforces it> (<ADR NNNN>).
4. **<boundary that must hold>** — <check that catches a violation> (<spec NNNN>).
-->

## Review-time gotchas

Things a reviewer must know that cost a real debugging session — each entry: the trap, how it
was measured, what to do instead. Empty is honest for a new repo; the first entry usually
arrives with the first postmortem.

## Finding disposition — fix the class, not the instance

For every confirmed finding, judge: is this one instance of a defect CLASS? If yes, name the
deterministic owner that would retire the class (a lint rule, a CI check, a selftest assertion)
and record it as a decision candidate; fixing only the instance is an incomplete disposition.
