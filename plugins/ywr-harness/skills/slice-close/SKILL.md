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

The emitter prints four things, all of which belong in the close:

- **`scope:`** — where the file list came from. An empty commit range is called out by name;
  quote that line. A range that matched nothing means everything below rests on the working tree.
- **`gates:`** — the deterministic commands, per declared group, from `.harness.json`. Commands
  marked *whole-program* have no per-file scoping: gate on failures in slice files or newly
  introduced by the slice, and record pre-existing failures elsewhere as debt rather than
  absorbing them into this slice.
- **`ungrouped:`** — files no declared group claims, so **no deterministic gate covers them**.
  Either add a group to `.harness.json` or say plainly that those files went ungated.
- **`review tier:`** with its reason — used by stage 3.

**Run every emitted command and fix failures now.** Record the exact commands and their results
verbatim; they go into the review scope's passed-gates block. Mechanical defects must never reach
an LLM reviewer — that is what makes the review affordable.

## 2. Adversarial review, proportional to the tier

The emitter already decided the tier from mechanical inputs. Do not re-litigate it in prose; if it
looks wrong, the fix is `.harness.json`, not a judgment call here.

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

Use `lensExtra` for repo-specific angles rather than redefining the lens set — a redefined set
never receives later improvements to the canonical lenses.

**Disposition**: every confirmed finding gets fixed, or gets an explicit reason it is not being
fixed. Then judge each one *instance vs class*: a class finding belongs in the
deterministic-rule backlog, because the same defect will otherwise be re-found by an LLM every
slice.

## 3. Verify

Invoke `/ywr-harness:verify` (it forks, so only the report returns). Its verdict is quoted into the
close verbatim — including "no registered verify script maps to this diff", which is a scope
statement and **not** a pass.

## 4. Unmapped files

Product files the mapper flags as having no spec owner are spec debt. Register them in a spec's
`implements_in` rather than hand-picking a verify script.

## 5. Close

- Update the handoff file the emitter named, if this repo declares one.
- Regenerate doc surfaces if any ADR/spec source changed: `pwsh docs/build.ps1`, and commit
  `index.json` + `INDEX.md` with the change.
- Commit. State in the close: the scope line, the gates that passed, the tier **and its reason**,
  the review outcome (confirmed / rejected counts), the verify verdict, and anything left ungated
  or unverified.

The last item is the point of the whole ritual: a close that does not say what it did *not* cover
reads as complete coverage.
