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

**Owner-typed on purpose** (ywr-harness ADR 0105): stage 5 writes the handoff and the commit, a state change
is the person's call (ywr-harness ADR 0034), and a skill the model cannot call costs no always-on context.
While `/ywr-harness:auto` holds in the session, the auto module may answer a model call on a non-default branch (ywr-harness ADR 0198).
Stages 1–3 are ordinary session work that a session may run first and report.
**→ This session already reported the slice ready, ending in a `tree:` line: `reference.md` §Prepared.**

## 1. Scope and gates (one command)

```
python "${CLAUDE_PLUGIN_ROOT}/scripts/harness_gates.py"                       # working tree vs HEAD
python "${CLAUDE_PLUGIN_ROOT}/scripts/harness_gates.py" --range <a>..<b>      # slice range ∪ working tree
```

`$ARGUMENTS`, when non-empty, is the range; pass it to `--range` as given — the emitter is the
range check (ywr-harness ADR 0041). When git cannot resolve the scope (unreachable ref, stale fetch, a typo)
it prints `scope: FAILED` and exits **non-zero**: nothing below it was computed and the run is
never quoted as a pass. Fix the scope (with the user, if the range was theirs) and re-run.

Six parts of the emitter's output belong in the close record:

- **`scope:`** — where the file list came from. An empty commit range is called out by name;
  quote that line. A range that matched nothing means everything below rests on the working tree.
- **`artifact:`** — the declared-Artifact check (ywr-harness ADR 0032). `artifact: VIOLATION` is a defect to
  fix **before** the close (CI fails on it); `none declared` is a report, not a failure.
- **`gates:`** — the deterministic commands per declared group. A *whole-program* command has no
  per-file scoping: gate on failures in slice files or new with the slice; record pre-existing
  failures elsewhere as debt.
- **`ungrouped:`** — files no group claims, so **no deterministic gate covers them**. Add a group to
  `.harness.json` or say plainly that those files went ungated.
- **`review tier:`** with its reason — used by stage 2.
- **`ignored-tree claims:`** (ywr-harness ADR 0077) — `none — N … checked` is clean; **`NOT CHECKED — git …
  failed`** is a failure, treated like `scope: FAILED`.
  **→ A claim list, any other form, or no line at all: `reference.md` §Ignored-tree.**

The emitter also prints `review canon:` for stage 2. For stage 5 it prints `handoff:` when the
repo declares one, and `hooks:` when the repo has a `.githooks/` directory.

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

`args.scope` is an **object**, never a bare string (a string scope cannot shard, loses the out-of-scope bucket and skeptic #2's gate check):

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
  shards: '<auto only per the shard habit below; omit otherwise>'
}})
```

**Leave out of `files`** only what a deterministic gate already answered, named in `context`
(`excluded: <files> — <why>`): a **generated surface whose drift gate passed** in stage 1 (its
sources stay in scope); the **declared handoff** and its `docs/handoff-archive/` copy (resume
state, not shipped); a file whose **whole diff a named gate checks** — e.g. `plugin.json` +
`marketplace.json` carrying only the version bump, with `lockstep: manifest-gate PASS` in
`gates_passed`. Everything else stays in scope.

Every session runs the review workers on the same pins (ywr-harness ADR 0197), and ultracode does not
change them (ywr-harness ADR 0108). Do not pass `sessionModel`: the workflow ignores it and logs one
`[retired]` line. Record the result's `stats.worker_pins`.

`invariants` come from the canon file the emitter printed. If it said **NOT FOUND**, stop and
resolve that first: a review whose invariants nobody can cite is a review nobody can audit.

Scope habits (ywr-harness ADR 0070, measured): **name the LOCAL path of every source a claim rests on** (a
URL or "the docs say" costs a finder a `curl` round-trip); **order `files` so files that changed
together sit together** (shards are cut along that order); **`shards` is a recall lever for dense
or critical scopes, not a speed lever** — add `shards: 'auto'` when more than ~8 files remain after
the exclusions, or the previous review's busiest finder ran past ~10 requests; never on a string
scope (it throws). **→ Explicit shard groups, or the measurements: `reference.md` §Shards.**
Put repo-specific angles in `lensExtra`; a redefined lens set never receives canonical updates.

**Read the result's `digest` first** — its first key, one line: confirmed count by severity,
`multi_lens` (confirmed findings that two or more lenses raised), out-of-scope / nit / rejected
counts, `high_ids` (the highs step 3 below must prove), any coverage loss (dead lenses, finders or skeptics, unverified findings, capped finds), tier, shards, pin mode and `canary_ok`. A completion notice truncates
around 14k characters, so the digest survives it; open the full lists only for what it names.

**Disposition**: every confirmed finding ends in exactly one of three buckets — and so does each
site in its `also_at` list (the same claim at another file:line): a site is dispositioned on its
own, never by its representative's verdict (ywr-harness ADR 0163):

- **fixed** — the fix is checked as below.
- **valid, no action** — the claim is true, but no change is worth making now. The reason says
  why and names the record that keeps it: an ADR residual, a spec known limit, a handoff item or
  a `BACKLOG.md` entry. A true claim with no record is not this bucket.
- **false on reading** — the closer read the claim against the code and it does not hold. The
  reason quotes the line or guard that shows it. Two or more keys in the finding's `lenses` mean
  independent lenses raised it; the reason then answers each lens's claim in `also_at`.

A confirmed finding marked `unverified: true` (every skeptic leg died, twice) is read against its
claim before it is fixed or dispositioned. A **high or medium** in `rejected[]` whose skeptic
votes split 1–1 is read by the closer against its claim before it counts as rejected; if true, it
is dispositioned like a confirmed one. A result with only `rejected_count`: `reference.md`
§Old-digest. Judge each finding *instance vs class*: a class belongs in the
deterministic-rule backlog, or an LLM re-finds it every slice.

**The fix diff does not re-enter the review** (ywr-harness ADR 0028). Close each fix by:

1. **Gates**: `python "${CLAUDE_PLUGIN_ROOT}/scripts/harness_gates.py" <every file the fix touched>`
   and every command it prints — never a default run, which re-covers the whole uncommitted slice.
   Its gate, `ungrouped:` and `ignored-tree claims:` output count exactly as in stage 1; its
   `review tier:` line is **not** an input to the table above. While iterating, run the touched
   component's own test file directly; a full runner this run prints is the
   close gate, run once on the final tree.
2. **Per-finding fix check** (ywr-harness ADR 0090): read each fix against its finding's claim and failure
   scenario. **High and medium** findings go to skeptic legs on the pinned worker agent
   (`ywr-harness:worker` on every session model — a single Agent-tool leg, not a review
   workflow's fan-out, ywr-harness ADR 0109; ultracode or not, ywr-harness ADR 0108),
   **batched**: one leg per
   group whose fixes touch the same files or the same defect class, **at most 4 findings per leg**,
   and a leg of its own for a fix that touches a declared critical surface. A leg gets its findings
   (severity · title · claim · evidence · `also_at`) plus the files the fixes touched, tries to
   refute, finding by finding, that each fix closes its scenario without opening an adjacent one,
   and answers **per finding** exactly `fixed: true|false` plus a reason. Legs run in parallel.
   Quote every verdict into the close record; `fixed: false` reopens that finding — patch it, then
   re-check it alone. A low closes on the closer's own reading; a nit needs none.
3. **Fix proof for every high the digest names** (ywr-harness ADR 0169): the script runs the command and
   records its exit code against the `--tree` snapshots before and after it, so the proof is never
   the closer's own line. **The review picks the keys, not the closer**: the digest's `high_ids`
   gives a count and then the `id` of every in-scope confirmed high (`F<n>-<fingerprint>`) and of
   every rejected high that not every vote refuted (`R<n>-…`: a 1–1 split, or a refute beside a
   dead leg). A fixed `O<n>-…` high may be added; nothing can be left out. The fingerprint ties an
   id to its finding, so a re-review's `F1` never inherits an earlier `F1`'s proof. **Before
   editing a fix**, run a command that shows the finding's scenario, and after the fix run the
   SAME argv again:

   ```
   python "${CLAUDE_PLUGIN_ROOT}/scripts/fix_proof.py" run <id> -- <command> [args...]
   python "${CLAUDE_PLUGIN_ROOT}/scripts/fix_proof.py" waive <id> --reason "<bucket>: <why no proof>"
   python "${CLAUDE_PLUGIN_ROOT}/scripts/fix_proof.py" check --digest "<the digest line, verbatim>" [<O id> ...]
   ```

   `run` executes at the repo root with no shell — wrap a shell line in `pwsh -NoProfile -Command`
   or `sh -c`. A run that changes the tree (a snapshot test, codegen, a formatter writing a
   non-ignored file) cannot count: ignore or remove its output and run again. Any non-zero exit is
   a failing half, and the PROVEN line prints the code — read a code other than 1 as the test
   failing, not its invocation (a missing file, a bad flag). A listed high that is not proven
   takes a waiver whose reason names its bucket: a fix no command can show (prose, a race, a
   hosted service), **valid, no action** or **false on reading**. `check` runs after the last
   edit and after every review, and every line it prints goes into the close record. **Exit 0** —
   every key proven. **Exit 1** — a key has no proof or waiver: the close stops. **Exit 3** — only
   waivers remain: the session never accepts its own waiver, so the ready report lists them, and
   in this close ask the owner about each waived key with its reason
   (AskUserQuestion), quote each answer into the close record, and stop on any refusal. On the model
   path of ywr-harness ADR 0198 nobody answers: the close stops at exit 3 with no handoff and no
   commit, and the report lists the waivers. **Exit 2**
   — `check` could not read its input (the digest, a key, the git snapshot or the journal): it
   checked nothing, so the close stops until a fixed input reaches exit 0, 1 or 3.
   **→ A digest with no `high_ids`, or a result with only `rejected_count`:
   `reference.md` §Old-digest.** A command
   that passed before the fix proves nothing; the check reports it MISSING. The skeptic leg above
   still runs: the proof shows the scenario closed, the leg looks for damage beside it.

No second review over the fix diff — except ONCE when a fix is a new mechanism rather than a
patch: its hunks reach outside the finding's lines (a moved call, another function, a new
branch), it adds a surface, or it touches a critical surface the original scope did not. Name
that criterion in the close record. The re-review's findings close under this same rule; there
is never a third pass. Only the owner can skip a due re-review: the ready report asks, this
close asks again when no answer exists, and the close record quotes the answer. On the model path of
ywr-harness ADR 0198 an open owner question stops the close with no handoff and no commit.

**A rebase or merge after the review re-arms it only over the overlap (ywr-harness ADR 0072)** — reviewed
files the incoming commits also touched, plus any hand-resolved conflict; an empty overlap keeps
the review standing, recorded as `review basis:`. **→ Rebased or merged after the review:
`reference.md` §Rebase.**

## 3. Verify

Run the mapper first (zero tokens), over the stage-1 range when there was one:

```
python "${CLAUDE_PLUGIN_ROOT}/scripts/verify_map.py" [--range <a>..<b>]
```

- **`scope: FAILED`** or **`index: FAILED`** → stop, as in stage 1. **`index: STALE`** → rebuild the docs index (stage
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
is written **once**, in that commit's message body (ywr-harness ADR 0090).

- **Handoff**: update the one the emitter named, if declared. A declaration ending in `/` is a
  directory of per-work-line resume files (ywr-harness ADR 0040): update or create the file named after this
  slice's work line, never after a person.
- **Resume state only** (ywr-harness ADR 0040): the current-state section keeps what changed (one paragraph),
  open risks, next actions and facts established at cost — no close record. It names this slice's
  commit "the commit carrying this handoff", never a sha it cannot know yet (a reader recovers it:
  `git log -1 --format=%h -- <handoff>`). Delete DONE items from the open list, never keep them for
  numbering; refer to items by name. Move a superseded current-state section to
  `docs/handoff-archive/<same filename>`, newest first; a decision worth keeping goes to an ADR or
  spec.
- **Slice notes** (ywr-harness ADR 0172): run
  `python "${CLAUDE_PLUGIN_ROOT}/scripts/slice_note.py" show [--range <a>..<b>]` with the stage-1
  range. When it also counts notes at other HEADs and a rebase brought in a commit that touched the
  handoff, or the repo declares no handoff, run `show --all` and read those notes too. Each note is the session's own claim, written during the
  slice: input, never proof (ywr-harness ADR 0105). Check each one against the tree and the stage outputs. Keep the decisions, rejected
  options and owner answers that still hold for the record body; put the facts and risks that stay
  open into the handoff. Correct or drop a note the tree contradicts, and never let a note stand in
  for a gate run, the digest, a fix proof or the ready report.
- Regenerate doc surfaces if any ADR/spec source changed (`pwsh docs/build.ps1`), committing
  `index.json` + `INDEX.md` with the change.
- **Commit**: subject at most 72 characters; the **close record in the body** — the `scope:` line;
  the gates that passed; the tier **and its reason**; the `ignored-tree claims:` line as printed (a
  standing claim with its reason; `none checked` / `NOT CHECKED` quoted, never summarised as
  clean); `prepared: reused at …` when stages 1–3 came from a ready report; the review outcome
  (confirmed / rejected counts, `multi_lens`, `stats.worker_pins`, and `stats.find_omitted` with
  `capped_finders` when a finder hit its cap, and `stats.cap_unreported` when a finder did not say
  whether it did — unknown coverage, never read as full) or the skip reason;
  the fix disposition (each finding's bucket — fixed / valid, no action / false on reading — with
  the count per bucket, gate re-runs, every per-finding verdict, `also_at` sites and split
  rejections, the `fix_proof.py check` lines and the owner's answer on each waiver, any re-review criterion);
  the slice notes kept, as corrected, with the `show` count line; `review basis:` after a rebase; the verify verdict; and
  what went ungated or unverified. **Never paste a CI skip directive into the body** — GitHub skips
  every push- and PR-triggered workflow when the pushed commit's message contains one (the
  bracketed `skip ci` / `ci skip` / `no ci` / `skip actions` / `actions skip` forms, or a
  `skip-checks: true` trailer), so a finding that quotes one would silently switch off the gates of
  record for this code commit. Paraphrase it ("the skip-ci marker").
- **After the commit**, quote the post-commit retro's output (or that it printed nothing) in the
  close report; if the emitter's `hooks:` line says the hooks do not run here, run
  `python "${CLAUDE_PLUGIN_ROOT}/scripts/harness_retro.py"` by hand. A follow-up commit only when a
  retro finding changes an ADR, a spec or the docs index (ywr-harness ADR 0017); a "no change" result is not
  resume state and never gets a commit.

The last item of the record is the point of the whole ritual: a close that does not say what it
did *not* cover reads as complete coverage.
