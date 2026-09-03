# docs-as-code

Two document sets, one rule each.

| | Question it answers | Mutability |
|---|---|---|
| `docs/adr/` | **Why** a decision was made | **Append-only.** Never edit an accepted ADR. |
| `docs/spec/` | **How it works now** | Living. Update freely; git holds the history. |

To reverse a decision, write a NEW ADR and set the old one's `status: superseded` +
`superseded_by`. Editing the original destroys the record of what was believed at the time,
which is the only thing an ADR is for.

## Frontmatter is the single source of truth

Status, dates, and relationships live in the YAML frontmatter — never restated in the body.
A fact in two places drifts; the generated index reads the frontmatter, so the body copy is
the one that goes stale silently.

## After editing

```
pwsh docs/build.ps1        # or: bash docs/build.sh
```

Regenerates four surfaces from the `.md` sources:

- `index.json` — for agents and tooling. Grep or `jq` it; do not read it whole, it grows.
- `INDEX.md` — lightweight table of contents.
- `docs.html` — human browsing.
- `docs.artifact.html` — the claude.ai Artifact publish input (a fragment; the host wraps it).

Commit `index.json` and `INDEX.md` alongside your source change. A CI drift gate that compares
regenerated output against the committed copies will fail the PR otherwise — that is the point:
it makes a stale index impossible to merge rather than merely discouraged.

When a merge conflicts inside `index.json` or `INDEX.md`, never hand-merge them: take either
side, re-run the build, and commit the regenerated output. They are derived from the `.md`
sources, which are the only thing to reconcile.

## Writing a new record

1. Copy `docs/adr/0000-template.md` (or `docs/spec/0000-template.md`) to
   `NNNN-kebab-title.md`, `NNNN` being the next zero-padded number.
2. Fill the frontmatter first.
3. Write the body. Record the options you **rejected** and why — that is what makes the record
   worth keeping a year later.
4. Rebuild and commit.

## Length

Match each document's length to what the decision needs. No filler sections, no summary that
restates the frontmatter, no paragraph that restates the previous one. Cut padding only —
rejected options, residual risks, "not verified" statements, coverage caps, and cost figures
all stay. Recent models write longer files than earlier ones and reasoning effort is not the
lever, so the brake has to be an explicit instruction.

## Language

Write internal recurring-read documents in English. These files are re-read every session, and
the token difference compounds. Read them in your own language via browser translation of
`docs.html` — there is no translation step in the build and no bilingual bodies. Documents
written for customers are a separate set in the customer's language, and internal ADR/spec
surfaces are never shipped to them: they contain rejected options, costs, and trade-offs.
