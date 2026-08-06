---
name: harness-init
description: Scaffold the docs-as-code shape (docs/adr + docs/spec + templates + build pipeline) into a repo, or refresh an already-scaffolded repo's toolchain from the canon. Use when starting a repo that should accumulate decisions, or after a ywr-harness plugin update.
disable-model-invocation: true
---

# harness-init

Places the docs-as-code shape so a repo can accumulate decisions: `docs/adr/` (why, append-only),
`docs/spec/` (how it works now, living), the templates and rule documents for both, and the build
pipeline that regenerates `index.json` · `INDEX.md` · `docs.html`.

Run it:

```
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/skills/harness-init/init.ps1" -Target <repo root>
```

Add `-DryRun` to see the plan without writing. `-Target` defaults to the current directory.

## What re-running does

Safe by construction, and the split is the reason to re-run rather than diff by hand:

- **Toolchain is overwritten** — the builder, templates, and rule documents come from the canon.
  Re-running is how a plugin-side improvement reaches this repo. Do not hand-edit these files:
  the next run reverts them, which is the intended signal (ywr-harness ADR 0010 — harness defects
  are fixed in the canon, not patched locally).
- **Seeds are never overwritten** — an existing `CLAUDE.md` or `.gitattributes` is preserved
  byte-identical and reported as preserved.
- **Nothing is ever deleted.** Accumulated ADRs and specs are untouched.
- **Placement writes LF** — no matter how the installed plugin cache was checked out
  (`core.autocrlf` can stamp CRLF onto it), CRLF in a template folds to LF on write (only the
  pair — a lone 0x0D is content and survives), and a file that differs from its template only in
  line endings is left alone rather than counted as a refresh (ADR 0036; same comparison contract
  as the refresh nudge, ADR 0033).

## After running

1. **Fill every `<placeholder>` in `CLAUDE.md`.** Anything still in angle brackets is a line
   nobody has decided yet — leaving them is worse than deleting the section.
2. Read `docs/README.md` — it carries the append-only rule, the frontmatter-is-truth rule, and
   the rebuild step.
3. Write the repo's first ADR from `docs/adr/0000-template.md`. Record rejected options; that is
   what makes the record worth keeping.
4. Rebuild and commit `index.json` + `INDEX.md` with the source change.

If the run reported `SKIP build — python not on PATH`, the three surfaces do not exist yet: no
tooling can query this repo's decisions until `pwsh docs/build.ps1` succeeds.

## The execution layer

Beyond the docs shape, the scaffold vendors the pieces that actually run the gates:

- `.github/workflows/harness-gates.yml` + `scripts/harness/*.py` — CI. Vendored rather than a
  reusable workflow because `${CLAUDE_PLUGIN_ROOT}` does not exist in a CI step and cross-repo
  Actions access is closed (ADR 0014).
- `.githooks/pre-commit` — runs the emitter's **file-scoped** gates on staged files. Whole-program
  gates (tests, typecheck) are deferred to CI and the deferral is reported.
- `.githooks/pre-push` — scans **added lines** of the pushed range for secrets. A false positive is
  exempted per line with the marker `harness:allow-secret`, not with `--no-verify`.
- `.githooks/post-commit` + `scripts/harness/harness_retro.py` — the slice retro gate: seven
  deterministic docs-drift checks at zero token cost, advisory, silent when clean (ADR 0017).
  Placed **GUARDED** — an existing `post-commit` without the `ywr-harness:post-commit` marker is
  refused rather than overwritten, and the one-line manual wiring is printed instead.

`core.hooksPath` is wired **conditionally** (ADR 0015): set when unset, left alone when already
`.githooks`, and **refused** when it points anywhere else — a repo that aims its hooks elsewhere
made that choice for reasons this scaffold cannot see.

It lives in `.git/config`, which is per-clone and never committed, so this wires only the machine
that ran the scaffold. Every other clone is caught by the `hooks:` line `harness_gates.py` prints
on each `/ywr-harness:slice-close` and CI run:

```
hooks: .githooks/ present but core.hooksPath is UNSET — NO git hook runs in this clone
       run: git config core.hooksPath .githooks
```

## What this does NOT install

Stack-specific lint tooling. The gates are **selectors** from a closed set (`ruff`, `eslint`, `tsc`,
…) declared in `.harness.json`; installing the tools they name is the repo's job. A gate whose tool
is missing fails loudly rather than passing quietly. A repo whose gate is its own script (a test
entry point no selector could name) declares a **script gate** — a closed-set runner plus a
validated repo-relative path, never a command string (ADR 0024); what that script does is the
repo's code to review, like any code.
