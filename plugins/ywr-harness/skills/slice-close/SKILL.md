---
name: slice-close
description: Slice-close ritual as one command — scope resolution, deterministic gates before any LLM review, proportional `/code-review` run, spec-owned verify, and one commit that carries the slice, its handoff and the close record. Use when a slice is functionally done and needs closing — the person types it, or the main session calls it after its ready report once every owner question of the slice has an answer. A subagent never calls it.
---

# /slice-close — slice closing ritual

Run the stages in order; each later stage consumes the earlier stage's output. **Skipping a stage
is a decision to surface, never a silent default.** Rare cases live in
`${CLAUDE_PLUGIN_ROOT}/skills/slice-close/reference.md`, each behind ONE **→** trigger line below
naming its section; read a section only when its trigger fires.

**The person or the main session runs it** (ywr-harness ADR 0201): the person types it, or the main session
calls it after its ready report. Stage 5 writes the handoff and the commit, so the session calls it only when
every owner question of the slice has an answer: ask an open one first (AskUserQuestion). The auto switch is
not needed. The plugin refuses a call from a subagent. Stages 1–3 are ordinary session work that a session
may run first and report.
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

**Run every emitted command and fix failures now**, before the review: mechanical defects never
reach an LLM reviewer. Record the exact commands and results verbatim for the close record.

## 2. Review, proportional to the tier

The emitter decided the tier mechanically; if it looks wrong, fix `.harness.json`, do not argue it
here. **This table consumes the slice scope's tier exactly once per slice** — a tier printed for a
later *fix diff* triggers nothing (its gate and `ungrouped:` output still apply, below).

| tier | action |
|---|---|
| `skip` | No LLM review. Deterministic gates suffice. Record "review skipped: docs-only". |
| `small` | `Skill({skill: 'code-review', args: 'medium'})` |
| `full` | `Skill({skill: 'code-review', args: 'medium'})` |

The review is the built-in `/code-review` command (ywr-harness ADR 0215). It runs on the session
model, at `medium` for both review tiers (ywr-harness ADR 0218), on every session model. Ultracode changes nothing. Call it
from the main session with no target. The default target is the branch's commits that `origin/HEAD`
lacks plus the uncommitted changes, new untracked files included. Before the call, list those
commits with `git log --oneline origin/HEAD..HEAD`. When `origin/HEAD` does not resolve, the
command fails: record that the commit list and the review's base are unknown.
`git remote set-head origin --auto` sets `origin/HEAD` from the remote. When the list holds commits
of an earlier slice, pushed to a branch or not, those enter the review too: record that, and give
their findings buckets like any other. Pass no `--max-findings`: the close keeps the default cap.
In an interactive session the review runs as a background agent. Wait for its task notification
before you edit anything; the notification carries the findings, each with a file, a line, a
summary, a failure scenario and a severity.

**The review canon reaches the command only through `CLAUDE.md`.** The command reads `CLAUDE.md` and
the files that it imports, never a separate canon file. Before the review, read the emitter's
`review canon:` line:

- **`(loaded at session start)`**: the canon is a memory file, `CLAUDE.md`, `.claude/CLAUDE.md` or
  `CLAUDE.local.md`, with a `Review canon` heading outside code (ywr-harness ADR 0217). Go on.
- **`NO HEADING`**: the memory file has no such heading. Go on, record that the review may have run
  without the canon, and tell the person in the ready report.
- **`(imported by <file>)`**: a canon in another file reaches the review through an `@<path>` line
  outside code in that memory file. Go on.
- **`NOT IMPORTED`**: add the import before you call the review. Append the section below to the
  `CLAUDE.md` at the repo root, and create that file when the repo has none. Then run the emitter
  again and confirm `(imported by CLAUDE.md)`. Do not move the canon into `CLAUDE.md` unasked: the
  person decides that move.
- **`NOT FOUND`**: record that the review ran without the canon.

```
## Review canon

The slice-close review, `/code-review`, reads the review canon only through the import below
(ywr-harness ADR 0215). Its invariants also bind every change you write. Its gotchas apply when you
review. Keep the line while the canon holds this repo's review invariants.

@<path>
```

`<path>` is the path that the emitter printed, with a backslash before each space in it
(`@docs/my\ canon.md`): Claude Code ends an unescaped path at its first space. A probe saw a review
that started with the import apply an imported rule. Nobody verified that a canon or an import added
or changed during the session reaches its review. When the canon, its import or its section changed
during this session, record that.

The command takes no scope exclusions and no passed-gates block. It can raise findings on a
generated surface or on the handoff. Disposition those like any other finding.

**Record the level and the item count.** When the count equals a known cap, the record says that the
cap can hide findings. The known caps are 10 items in a `claude -p` run and 32 in the findings tool.
**Record the usage line too**: the duration, the tool uses and the tokens that the task notification
reports for the review agent, as printed. When the notification carries no usage line, record that.
The line is the only size signal of the run. It does not show which files the review read.

**Disposition**: every finding ends in exactly one of three buckets (ywr-harness ADR 0163,
ywr-harness ADR 0215). The severity — `important`, `pre_existing`, `nit` or none — goes in the record
beside the bucket, and it limits the buckets (ywr-harness ADR 0216). A finding that names more than
one site gets a bucket per site:

- **fixed** — the fix is checked as below.
- **valid, no action** — only for a `nit` whose fix would change a design or a coverage. The claim is
  true, and the change waits for a slice that owns it. The reason says why and
  names the record that keeps it, an open item:
  `python "${CLAUDE_PLUGIN_ROOT}/scripts/slice_note.py" add risk "open item: <file:line> <change>; <why>"`.
  A true claim with no record is not this bucket.
- **false on reading** — the closer read the claim against the code and it does not hold. The
  reason quotes the line or guard that shows it.

**The severity limits the bucket** (ywr-harness ADR 0216):

- An `important` finding, a `pre_existing` finding and a finding with no severity end fixed or false on
  reading. Never valid, no action: fix it in this close, even when the fix is large.
- A `nit` ends fixed or false on reading, unless its fix would change a design or a coverage. That
  `nit` ends valid, no action, with its open item.
- **Probe first**: a fix that rests on a host behaviour that no fact, spec or probe of the repo
  records gets a probe on the real use path before the fix. The record names the probe and its
  result. When this session cannot run the probe on that path, ask the owner with AskUserQuestion
  before the fix. When the owner defers the probe, the finding ends valid, no action as the
  owner's decision, with an open item. The session alone never defers an `important` finding.
- **Defect class**: when a finding is one case of a class that a deterministic check could retire,
  such as a lint rule, a CI check or a selftest assertion, the closer can also record the class as a
  decision candidate. The record is one bullet in `docs/handoff-archive/BACKLOG.md`, at the place
  that the file's header names, or at its end. A missing file starts with a title line.

**The fix diff does not re-enter the review** (ywr-harness ADR 0028, ywr-harness ADR 0200). Close each fix by:

1. **Gates**: `python "${CLAUDE_PLUGIN_ROOT}/scripts/harness_gates.py" <every file the fix touched>`
   and every command it prints — never a default run, which re-covers the whole uncommitted slice.
   Its gate, `ungrouped:` and `ignored-tree claims:` output count exactly as in stage 1; its
   `review tier:` line is **not** an input to the table above. While iterating, run the touched
   component's own test file directly; a full runner this run prints is the
   close gate, run once on the final tree.
2. **Per-finding fix check** (ywr-harness ADR 0090): every fixed finding except a `nit` goes to a
   skeptic leg on the pinned worker agent (`ywr-harness:worker` on every session model — a single
   Agent-tool leg, ywr-harness ADR 0109; ultracode or not, ywr-harness ADR 0108), **batched**: one leg per
   group whose fixes touch the same files or the same defect class, **at most 4 findings per leg**,
   and a leg of its own for a fix that touches a declared critical surface. A leg gets its findings
   (severity · summary · failure scenario · file and line) plus the files the fixes touched, tries to
   refute, finding by finding, that each fix closes its scenario without opening an adjacent one,
   and answers **per finding** exactly `fixed: true|false` plus a reason. Legs run in parallel.
   Quote every verdict into the close record; `fixed: false` reopens that finding — patch it, then
   re-check it alone. A fixed `nit` goes through the gates of step 1 and gets no leg.

**No fix gets a re-review in this slice** (ywr-harness ADR 0200, which narrows ywr-harness ADR 0028). A patch
and a new mechanism close the same way: steps 1 and 2 above. When you judge that a fix needs more
review, record the need when you decide it:
`python "${CLAUDE_PLUGIN_ROOT}/scripts/slice_note.py" add risk "open item: review <files and lines> of the <file:line> fix; <why>"`.
Stage 5 puts that note in the handoff as an open item. The next slice that touches those files puts
those hunks in its review. The close record names each fix that went to an open item, or says
`none`. This is your decision. It is no owner question. The rebase re-arm below is a separate
rule: it is no re-review of a fix.

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
  open into the handoff. A risk note that starts with `open item:` becomes an open item there (ywr-harness ADR 0200). Correct or drop a note the tree contradicts, and never let a note stand in
  for a gate run, the review's findings or the ready report.
- Regenerate doc surfaces if any ADR/spec source changed (`pwsh docs/build.ps1`), committing
  `index.json` + `INDEX.md` with the change.
- **Commit**: subject at most 72 characters; the **close record in the body** — the `scope:` line;
  the gates that passed; the tier **and its reason**; the `ignored-tree claims:` line as printed (a
  standing claim with its reason; `none checked` / `NOT CHECKED` quoted, never summarised as
  clean); `prepared: reused at …` when stages 1–3 came from a ready report; the review outcome
  (the level, the item count, the usage line and the cap note of stage 2, the emitter's `review canon:` line, and
  whether the canon, its import or its section changed during this session) or the skip reason; the fix disposition (each finding's severity and bucket — fixed / valid,
  no action / false on reading — with the count per bucket, gate re-runs, every per-finding verdict,
  and each fix passed to an open item or `none`);
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
