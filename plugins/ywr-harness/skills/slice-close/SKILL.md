---
name: slice-close
description: Slice-close ritual as one command — scope resolution, deterministic gates before any LLM review, proportional adversarial review, spec-owned verify, and the handoff. Use when a slice is functionally done and needs closing.
disable-model-invocation: true
---

# /slice-close — slice closing ritual

Run the stages in order; each later stage consumes the earlier stage's output. **Skipping a stage
is a decision to surface, never a silent default.**

## 1. Scope and gates (one command)

```
python "${CLAUDE_PLUGIN_ROOT}/scripts/harness_gates.py"                       # working tree vs HEAD
python "${CLAUDE_PLUGIN_ROOT}/scripts/harness_gates.py" --range <a>..<b>      # slice range ∪ working tree
```

`$ARGUMENTS`, when non-empty, is the range. Sanity-check it first (`git rev-parse` both endpoints,
or `git diff --stat <range>` succeeds). On failure, confirm the scope with the user rather than
proceeding on a broken range.

One exit-code exception to know (ADR 0041): if git cannot resolve the changed-file scope at all
(unreachable ref, stale fetch), the emitter prints `scope: FAILED` on stdout and exits
**non-zero** — nothing below it was computed, and that run must never be quoted as a pass. Fix
the scope and re-run; do not proceed to review on a FAILED scope.

The emitter prints five things, all of which belong in the close:

- **`scope:`** — where the file list came from. An empty commit range is called out by name;
  quote that line. A range that matched nothing means everything below rests on the working tree.
- **`artifact:`** — the declared-Artifact check (ADR 0032). An `artifact: VIOLATION` line is a
  defect to fix **before** the close (CI fails on it): make the README carry the declared link,
  or correct the declaration. `none declared` is a report, not a failure.
- **`gates:`** — the deterministic commands, per declared group, from `.harness.json`. Commands
  marked *whole-program* have no per-file scoping: gate on failures in slice files or newly
  introduced by the slice, and record pre-existing failures elsewhere as debt rather than
  absorbing them into this slice.
- **`ungrouped:`** — files no declared group claims, so **no deterministic gate covers them**.
  Either add a group to `.harness.json` or say plainly that those files went ungated.
- **`review tier:`** with its reason — used by stage 2.

**Run every emitted command and fix failures now.** Record the exact commands and their results
verbatim; they go into the review scope's passed-gates block. Mechanical defects must never reach
an LLM reviewer — that is what makes the review affordable.

## 2. Adversarial review, proportional to the tier

The emitter already decided the tier from mechanical inputs. Do not re-litigate it in prose; if it
looks wrong, the fix is `.harness.json`, not a judgment call here. **This table consumes the slice
scope's tier exactly once per slice.** A tier the emitter prints for a later *fix diff* of this
review's own findings is not an input to this table — that run's gate and `ungrouped:` output
still apply (fix disposition below), but its tier line triggers nothing.

| tier | action |
|---|---|
| `skip` | No LLM review. Deterministic gates suffice. Record "review skipped: docs-only". |
| `small` | `Workflow({name:'ywr-harness:adversarial-review', args:{scope:…, tier:'small'}})` — 2 merged lenses. |
| `full` | Same call without `tier`. |

Assemble `args.scope` as an **object**, never a bare string — a template that receives an object
where it expects a string renders `[object Object]` and the scope silently vanishes:

```
Workflow({name: 'ywr-harness:adversarial-review', args: {
  tier: '<small when the emitter said small; omit otherwise>',
  scope: {
    files: [<the emitter's file list>],
    context: '<1-3 lines: what the slice does + key design decisions>',
    invariants: [<copied from the review canon the emitter named — never an inline list here>],
    gates_passed: '<stage-1 commands + results, verbatim>'
  },
  lensExtra: '<house-specific review angles, if this repo has any>'
}})
```

`invariants` come from the canon file the emitter printed. If it said **NOT FOUND**, stop and
resolve that first: a review whose invariants nobody can cite is a review nobody can audit.

Three scope habits decide the review's wall-clock and token cost (ADR 0070, measured):

- **Name the LOCAL path of every source a claim rests on** — the ADR, spec, schema, or generated
  file inside the repo. A finder reads a local path in one call; a URL or a bare "the docs say"
  costs a `curl` round-trip, and round-trips are what a review's time is made of.
- **Order `files` so files that changed together sit next to each other.** Finder shards are cut
  along that order, so coupled files land in the same shard.
- **`shards` is opt-in, for round-trip-bound finders only.** Measured (ADR 0070): with the two
  habits above a 5-file review's finders finished in 2 requests each and the remaining time was
  output generation — sharding then cut no time and cost +69% tokens (more finders → more raw
  findings → more skeptics), buying recall. Add `shards: 'auto'` when the previous review's
  busiest finder ran past ~10 requests or the scope exceeds ~8 files; explicit groups
  `shards: [[…], […]]` (an exact partition of `files`) when the coupling is known; never on a
  string scope (it throws).

Use `lensExtra` for repo-specific angles rather than redefining the lens set — a redefined set
never receives later improvements to the canonical lenses.

**Disposition**: every confirmed finding gets fixed, or gets an explicit reason it is not being
fixed. Then judge each one *instance vs class*: a class finding belongs in the
deterministic-rule backlog, because the same defect will otherwise be re-found by an LLM every
slice.

**The fix diff does not re-enter the review.** The review runs once per slice, over the slice
scope. Close each fix by:

1. **Gates**: re-run the emitter over the fix diff and run every emitted command. Its gate and
   `ungrouped:` output are consumed exactly as in stage 1 — a fix that adds or touches a file no
   group claims is called out, never silently passed. Its `review tier:` line is **not** an input
   to the table above; a fix diff never earns a review by tier.
2. **Per-finding fix check**: read the fix against the finding's own claim and failure scenario.
   For a **high or medium** finding, spawn ONE skeptic leg on the plugin's pinned worker agent
   (`ywr-harness:worker`), given the finding (severity · title · claim · evidence) plus the files
   the fix touched, prompted to refute that the fix closes the claimed scenario without opening
   an adjacent one, and answering exactly `fixed: true|false` plus a reason. Quote each verdict
   into the close. A low finding closes on the closer's own reading; a nit needs none.

Do **not** start a second review over the fix diff. One bounded exception: when a fix is a new
mechanism rather than a patch — it adds a surface or rewrites control/data flow beyond the
finding's own lines, or touches a `critical` group the original scope did not — run at most ONE
re-review over the fix diff and name that criterion in the close. That re-review's findings are
dispositioned under this same rule; there is never a third pass.

**A rebase or merge after the review re-arms it only over the overlap (ADR 0072).** When the
slice is rebased onto, or merges, a base that other commits advanced after the review ran: re-run
stage 1 over the rebased tree (always — the tree is new, the gates are cheap), then compute the
overlap with the merge-base before and after the rebase:

```
git diff --name-only <old-base> <new-base> -- <every file in the reviewed scope>
```

Empty output and no hand-resolved conflict → the review stands; record
`review basis: reviewed at <sha>, rebased onto <sha>, overlap: none` in the close, command
quoted. Any listed file, or any file whose conflict was resolved by hand (in the reviewed scope or
not — resolved conflict text is code nobody reviewed) → run ONE review over exactly those files
(scope object as above, `context` naming the incoming range, tier from the emitter over that
scope). That review becomes the slice's review: its fix diffs close under the rule above, and a
later rebase applies this paragraph again. The overlap is file-level on purpose — a foreign change
to an unrelated function in a reviewed file re-arms too; that is the cheaper error.

## 3. Verify

Invoke `/ywr-harness:verify` (it forks, so only the report returns). Its verdict is quoted into the
close verbatim — including "no registered verify script maps to this diff", which is a scope
statement and **not** a pass.

## 4. Unmapped files

Product files the mapper flags as having no spec owner are spec debt. Register them in a spec's
`implements_in` rather than hand-picking a verify script.

## 5. Close

- Update the handoff the emitter named, if this repo declares one. A declaration ending in `/`
  is a directory holding one resume file per work line (ADR 0040) — update, or create, the file
  for the line this slice belongs to, named after the work line, never after a person.
- A handoff is a resume point, not a ledger: when this close supersedes the previous
  `## Current state`, move the superseded section (with its slice-close records) to
  `docs/handoff-archive/<same filename>`, newest first. Keep in the handoff only what resuming
  needs; a decision worth keeping belongs in an ADR or spec, not in accreted history.
- Regenerate doc surfaces if any ADR/spec source changed: `pwsh docs/build.ps1`, and commit
  `index.json` + `INDEX.md` with the change.
- Commit. State in the close: the scope line, the gates that passed, the tier **and its reason**,
  the review outcome (confirmed / rejected counts), the fix disposition (gate re-runs + per-finding
  fix checks; the triggering criterion, if a re-review ran), the verify verdict, and anything left
  ungated or unverified.

The last item is the point of the whole ritual: a close that does not say what it did *not* cover
reads as complete coverage.
