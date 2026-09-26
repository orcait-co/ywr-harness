---
name: slice-close
description: Slice-close ritual as one command — scope resolution, deterministic gates before any LLM review, proportional adversarial review, spec-owned verify, and one commit that carries the slice, its handoff and the close record. Use when a slice is functionally done and needs closing.
disable-model-invocation: true
---

# /slice-close — slice closing ritual

Run the stages in order; each later stage consumes the earlier stage's output. **Skipping a stage
is a decision to surface, never a silent default.** Rare cases live in
`${CLAUDE_PLUGIN_ROOT}/skills/slice-close/reference.md`, each behind ONE **→** trigger line below
naming its section; read a section only when its trigger fires.

## 1. Scope and gates (one command)

```
python "${CLAUDE_PLUGIN_ROOT}/scripts/harness_gates.py"                       # working tree vs HEAD
python "${CLAUDE_PLUGIN_ROOT}/scripts/harness_gates.py" --range <a>..<b>      # slice range ∪ working tree
```

`$ARGUMENTS`, when non-empty, is the range; pass it to `--range` as given — the emitter is the
range check (ADR 0041). When git cannot resolve the scope (unreachable ref, stale fetch, a typo)
it prints `scope: FAILED` and exits **non-zero**: nothing below it was computed and the run is
never quoted as a pass. Fix the scope (with the user, if the range was theirs) and re-run.

The emitter prints six things, all of which belong in the close record:

- **`scope:`** — where the file list came from. An empty commit range is called out by name;
  quote that line. A range that matched nothing means everything below rests on the working tree.
- **`artifact:`** — the declared-Artifact check (ADR 0032). `artifact: VIOLATION` is a defect to
  fix **before** the close (CI fails on it); `none declared` is a report, not a failure.
- **`gates:`** — the deterministic commands per declared group. A *whole-program* command has no
  per-file scoping: gate on failures in slice files or new with the slice; record pre-existing
  failures elsewhere as debt.
- **`ungrouped:`** — files no group claims, so **no deterministic gate covers them**. Add a group to
  `.harness.json` or say plainly that those files went ungated.
- **`review tier:`** with its reason — used by stage 2.
- **`ignored-tree claims:`** (ADR 0077) — `none — N … checked` is clean; **`NOT CHECKED — git …
  failed`** is a failure, treated like `scope: FAILED`.
  **→ A claim list, any other form, or no line at all: `reference.md` §Ignored-tree.**

**Run every emitted command and fix failures now.** Record the exact commands and results verbatim
for the review's passed-gates block: mechanical defects never reach an LLM reviewer.

## 2. Adversarial review, proportional to the tier

The emitter decided the tier mechanically; if it looks wrong, fix `.harness.json`, do not argue it
here. **This table consumes the slice scope's tier exactly once per slice** — a tier printed for a
later *fix diff* triggers nothing (its gate and `ungrouped:` output still apply, below).

| tier | action |
|---|---|
| `skip` | No LLM review. Deterministic gates suffice. Record "review skipped: docs-only". |
| `small` | `Workflow({name:'ywr-harness:adversarial-review', args:{scope:…, tier:'small'}})` — 2 merged lenses. |
| `full` | Same call without `tier`. |

`args.scope` is an **object**, never a bare string (a string template renders `[object Object]`):

```
Workflow({name: 'ywr-harness:adversarial-review', args: {
  tier: '<small when the emitter said small; omit otherwise>',
  scope: {
    files: [<the emitter's file list minus the exclusions below; coupled files adjacent>],
    context: '<1-3 lines: what the slice does + key design decisions; then the exclusions, named>',
    invariants: [<copied from the review canon the emitter named — never an inline list here>],
    gates_passed: '<stage-1 commands + results, verbatim; plus "<what>: <gate> PASS" per gate-covered exclusion>'
  },
  root: '<the session's repo root, absolute — lets absolute and relative reports of one site merge>',
  lensExtra: '<house-specific review angles, if this repo has any>',
  shards: '<auto only per the shard habit below; omit otherwise>',
  ultracode: <true ONLY when the host says ultracode is on for the session or confirms the
              prompt's `ultracode` keyword opt-in; a bare mention of the word is not it; omit otherwise>,
  effort: '<only beside ultracode (alone it throws): the session's level when known; omit for xhigh>'
}})
```

**Leave out of `files`** only what a deterministic gate already answered, named in `context`
(`excluded: <files> — <why>`): a **generated surface whose drift gate passed** in stage 1 (its
sources stay in scope); the **declared handoff** and its `docs/handoff-archive/` copy (resume
state, not shipped); a file whose **whole diff a named gate checks** — e.g. `plugin.json` +
`marketplace.json` carrying only the version bump, with `lockstep: manifest-gate PASS` in
`gates_passed`. Everything else stays in scope.

`ultracode: true` lifts every model and effort pin in the review (ADR 0084); record the result's
`stats.worker_pins`. **→ Choosing `effort`, or what runs on which model: `reference.md` §Ultracode.**

`invariants` come from the canon file the emitter printed. If it said **NOT FOUND**, stop and
resolve that first: a review whose invariants nobody can cite is a review nobody can audit.

Scope habits (ADR 0070, measured): **name the LOCAL path of every source a claim rests on** (a
URL or "the docs say" costs a finder a `curl` round-trip); **order `files` so files that changed
together sit together** (shards are cut along that order); **`shards` is a recall lever for dense
or critical scopes, not a speed lever** — add `shards: 'auto'` when more than ~8 files remain after
the exclusions, or the previous review's busiest finder ran past ~10 requests; never on a string
scope (it throws). **→ Explicit shard groups, or the measurements: `reference.md` §Shards.**
Put repo-specific angles in `lensExtra`; a redefined lens set never receives canonical updates.

**Disposition**: every confirmed finding is fixed or gets an explicit reason — and so does each
site in its `also_at` list (the same claim at another file:line): a site is dispositioned on its
own, never by its representative's verdict. A confirmed finding marked `unverified: true` (every skeptic leg died, twice) is read against its
claim before it is fixed or dispositioned. A **high or medium** in `rejected[]` whose skeptic
votes split 1–1 is read by the closer against its claim before it counts as rejected; if true, it
is dispositioned like a confirmed one (a result with only `rejected_count` is an older workflow —
record that splits went unread). Judge each finding *instance vs class*: a class belongs in the
deterministic-rule backlog, or an LLM re-finds it every slice.

**The fix diff does not re-enter the review** (ADR 0028). Close each fix by:

1. **Gates**: `python "${CLAUDE_PLUGIN_ROOT}/scripts/harness_gates.py" <every file the fix touched>`
   and every command it prints — never a default run, which re-covers the whole uncommitted slice.
   Its gate, `ungrouped:` and `ignored-tree claims:` output count exactly as in stage 1; its
   `review tier:` line is **not** an input to the table above. While iterating, run the touched
   component's own test file directly (one `*.selftest.ps1`); a full runner this run prints is the
   close gate, run once on the final tree.
2. **Per-finding fix check** (ADR 0090): read each fix against its finding's claim and failure
   scenario. **High and medium** findings go to skeptic legs on the pinned worker agent
   (`ywr-harness:worker`; `general-purpose` under ultracode, ADR 0084), **batched**: one leg per
   group whose fixes touch the same files or the same defect class, **at most 4 findings per leg**,
   and a leg of its own for a fix that touches a declared critical surface. A leg gets its findings
   (severity · title · claim · evidence · `also_at`) plus the files the fixes touched, tries to
   refute, finding by finding, that each fix closes its scenario without opening an adjacent one,
   and answers **per finding** exactly `fixed: true|false` plus a reason. Legs run in parallel.
   Quote every verdict into the close record; `fixed: false` reopens that finding — patch it, then
   re-check it alone. A low closes on the closer's own reading; a nit needs none.

No second review over the fix diff — except ONCE when a fix is a new mechanism rather than a
patch (it adds a surface, rewrites control/data flow beyond the finding's lines, or touches a
critical surface the original scope did not); name that criterion in the close record. Its
findings close under this same rule; there is never a third pass.

**A rebase or merge after the review re-arms it only over the overlap (ADR 0072)** — reviewed
files the incoming commits also touched, plus any hand-resolved conflict; an empty overlap keeps
the review standing, recorded as `review basis:`. **→ Rebased or merged after the review:
`reference.md` §Rebase.**

## 3. Verify

Run the mapper first (zero tokens), over the stage-1 range when there was one:

```
python "${CLAUDE_PLUGIN_ROOT}/scripts/verify_map.py" [--range <a>..<b>]
```

- **`scope: FAILED`** → stop, as in stage 1. **`index: STALE`** → rebuild the docs index (stage
  5's regeneration) and re-run before reading the output.
- **No `run:` line** (no owning spec, no registered script, or only `REFUSED:` lines) → do **not**
  invoke the verify skill; quote the mapper's output verbatim as the verify verdict. "No registered
  verify script" is a scope statement, **not** a pass; a `REFUSED:` line is a coverage gap.
- **A `run:` line** → invoke `/ywr-harness:verify <a>..<b>` (no argument when stage 1 had none) and
  quote its verdict verbatim. Its "do not run the mapper yourself" rule governs only its own turn.

## 4. Unmapped files

Product files the mapper flags as having no spec owner are spec debt. Register them in a spec's
`implements_in` rather than hand-picking a verify script.

## 5. Close — one commit

The slice, its handoff update and any regenerated surfaces land in **ONE commit**; the close record
is written **once**, in that commit's message body (ADR 0090).

- **Handoff**: update the one the emitter named, if declared. A declaration ending in `/` is a
  directory of per-work-line resume files (ADR 0040): update or create the file named after this
  slice's work line, never after a person.
- **Resume state only** (ADR 0040): the current-state section keeps what changed (one paragraph),
  open risks, next actions and facts established at cost — no close record. It names this slice's
  commit "the commit carrying this handoff", never a sha it cannot know yet (a reader recovers it:
  `git log -1 --format=%h -- <handoff>`). Delete DONE items from the open list, never keep them for
  numbering; refer to items by name. Move a superseded current-state section to
  `docs/handoff-archive/<same filename>`, newest first; a decision worth keeping goes to an ADR or
  spec.
- Regenerate doc surfaces if any ADR/spec source changed (`pwsh docs/build.ps1`), committing
  `index.json` + `INDEX.md` with the change.
- **Commit**: subject at most 72 characters; the **close record in the body** — the `scope:` line;
  the gates that passed; the tier **and its reason**; the `ignored-tree claims:` line as printed (a
  standing claim with its reason; `none checked` / `NOT CHECKED` quoted, never summarised as
  clean); the review outcome (confirmed / rejected counts, `stats.worker_pins`, and
  `stats.find_omitted` with `capped_finders` when a finder hit its cap, and `stats.cap_unreported`
  when a finder did not say whether it did — unknown coverage, never read as full) or the skip reason;
  the fix disposition (gate re-runs, every per-finding verdict, `also_at` sites and split
  rejections, any re-review criterion); `review basis:` after a rebase; the verify verdict; and
  what went ungated or unverified. **Never paste a CI skip directive into the body** — GitHub skips
  every push- and PR-triggered workflow when the pushed commit's message contains one (the
  bracketed `skip ci` / `ci skip` / `no ci` / `skip actions` / `actions skip` forms, or a
  `skip-checks: true` trailer), so a finding that quotes one would silently switch off the gates of
  record for this code commit. Paraphrase it ("the skip-ci marker").
- **After the commit**, quote the post-commit retro's output (or that it printed nothing) in the
  close report; if the emitter's `hooks:` line says the hooks do not run here, run
  `python "${CLAUDE_PLUGIN_ROOT}/scripts/harness_retro.py"` by hand. A follow-up commit only when a
  retro finding changes an ADR, a spec or the docs index (ADR 0017); a "no change" result is not
  resume state and never gets a commit.

The last item of the record is the point of the whole ritual: a close that does not say what it
did *not* cover reads as complete coverage.
