# REVIEW.md — review invariants of the ywr-harness canon

The review contract for EVERY review path in this repo: `/ywr-harness:slice-close` stage 2
(the adversarial-review workflow), ad-hoc PR review, `/code-review`, or a human reviewer.
`.harness.json` `review.canon` names this file (ADR 0018), and slice-close assembles its
`invariants` block from it — edit here, never keep inline copies elsewhere. When reviewing, trim
to the invariants the change can actually violate. Every ADR, spec and fact number here is this
repo's (`docs/adr/`, `docs/spec/`, `docs/FACTS.md`).

This file binds the canon only. A consuming repo reviews against its own root `REVIEW.md`, seeded
by `/ywr-harness:harness-init` (ADR 0054).

## Invariants

1. **Zero-install stack** — PowerShell 7, Python 3.9+ stdlib only, Node built-ins only, no
   dependency manifest. `manifest-gate.mjs` fails a non-stdlib Python import, a non-built-in Node
   import and a dependency manifest (ADR 0158). Review what it cannot parse: an import built at run
   time, a PowerShell module, a new install step in a script or workflow, and the line reader's
   known limits (spec 0008 §3.5: mixed `'''`/`"""` quotes, code after a closing triple quote, a
   one-line `def`/`class` body or a header colon in brackets).
2. **Namespaced names** — `manifest-gate.mjs` fails a bare workflow call and a bare backticked
   skill command in shipped text. Review a bare component name in any other form, such as a
   `subagent_type` value.
3. **Declarations, never command strings** — repo-specific values live in `.harness.json`; every
   command-shaped field is a selector from a closed set (ADR 0012), and a repo's own gate is a
   closed-set runner plus an allowlist-validated path (ADR 0024). A repo-supplied value that
   becomes a printed line or an argv is validated where it leaves (the echoed-value gotcha below).
4. **Honest reporting** — a skipped check is reported as skipped, never as passed, and a coverage
   cap (top-N, sampling, no-retry, an exclusion filter) is surfaced with the result instead of
   truncating silently (org guide).
5. **Docs-as-code (docs/README.md)** — ADRs are append-only (supersede, never edit); frontmatter
   is the single source of truth (no body duplication); new internal doc prose is English. The
   READER decides rendered-surface language (ADR 0045): every hook `systemMessage` is Korean —
   state markers, commands and paths verbatim — while `additionalContext` (model) and internal
   docs stay English; a new hook shipping an English member banner is a finding. A
   `systemMessage` the event never shows the person is English and addressed to the model
   (ADR 0097: DirectoryAdded's goes to the model on `/add-dir`, to the debug log on
   `register_repo_root`) — read the event's delivery in the raw hooks reference before choosing
   the language.
6. **Secrets** — the pre-push hook scans added lines; a false positive takes `harness:allow-secret`
   on its line, never `--no-verify`. Review what no scanner reads: a committed `.env` (only
   `.env.example` is tracked). Separately, NEVER quote a scanner's trigger
   string in comments, handoffs or commit messages — the quotation becomes the next finding on an
   immutable pushed blob; describe it in prose.
7. **Vendored copies stay identical and pinned** — `manifest-gate.mjs` fails a drifted copy
   (ADR 0014), and `ci-enabled-plugins.selftest` fails a `uses:` without a 40-hex SHA plus
   `# vX.Y.Z` (ADR 0087). Review what no gate reads: a pin's freshness.
8. **The shipped tree never moves under a released version** — `manifest-gate.mjs` fails a plugin
   change under a released version that does not bump it (ADR 0073).
9. **One git subprocess boundary** — `harness_config.git_run()`/`git_lines()` and
   `harness_retro.git()` own every git call (issue #40, ADR 0077). `manifest-gate.mjs` fails a
   direct git call in a `.py` file without `# harness:git-boundary <reason>` (ADR 0158). Review each
   new marker's reason, a git argv whose first item is a name, a subprocess call under an alias,
   a git call the line reader cannot see (spec 0008 §3.5), and text mode or a newline-separated path
   list at the boundary.
10. **A changed spec section is rewritten whole** — a diff that edits a spec section rewrites the
    whole lowest-level numbered section in STE-lite (docs/README.md §Writing style, ADR 0125). The
    rewrite covers every sentence and table cell, not only the new ones. With no numbered heading,
    the section is the nearest heading above the change. Check every sentence of each such
    section. Only the exact line or row name that a named script reads stays byte-identical and is
    no finding. Confirm in the script that it reads that text, and check the rest of the section.
    The scope `context` is the author's claim, not a ruling: an exemption it states, a precedent
    included, is a finding. An owner's grant counts only in a record that this diff does not
    edit: a handoff item, an ADR or a spec, named in the scope (sweep #23, owner 2026-10-09).

## Review-time gotchas (each cost a real debugging session)

- **A finding that turns on a field name, an enum member, or the ABSENCE of either must be read
  from the raw source, and must state how it was fetched** — rendered/extracted views drop
  content. Measured: a finder and BOTH skeptics read a doc page through WebFetch and declared a
  field absent; a raw `.md` copy whose SHA256 matched live carried three occurrences, so a
  confirmed `high` was rejected on verification. Absence is the expensive claim — say `curl`-ed
  raw + grepped locally, or do not claim it.
- **A count offered as evidence is only as wide as the population actually enumerated — quote the
  command with the number, and declare every narrowing in it** (a cap · an exclusion filter · an
  undeclared scope). Same class as invariant 4, but it bites in the citation rather than in the
  reported result. Measured shapes: a `head -5`-capped check restated as "38/38", a number the
  command could not have produced · a `grep -v` added to drop a library that also dropped the
  library's own selftest · a census over the set that SHARES a helper instead of the set that HAS
  the defect · a directory-scoped count later incremented as if it had been repo-wide. **Building
  on a recorded count inherits its undeclared narrowing** — re-run the enumeration, and if a
  narrowing stays, quote it with the total.
- **Repo-supplied text that is merely REPORTED is not inert when its reader is a parser that finds
  its window by line shape** — the gate emitter's stdout is parsed by the vendored CI
  (`sed -n '/^gates:/,/^\(ungrouped\|review tier\)/p'` then `grep -E '^ {4}[^ (]'`) and by the
  pre-commit awk, and both then RUN what they extracted. A value carrying a newline therefore does
  not print as one line — it prints as several, and a declaration can spell the window's own start
  and stop anchors. Measured in the ADR 0032 slice's review (three lenses, six skeptics, refuted
  none): a declared artifact
  `title` of `<repo>\ngates:\n    <cmd>\nreview tier: x` reported `artifact: ok`, so the CI step
  that greps `^artifact: VIOLATION` passed, while both parsers extracted `<cmd>`; the same sweep
  found a SECOND site, pre-existing, in the group-name label printed inside the window. **Ask of
  every echoed value: can it become two lines?** Validate the string that becomes the LINE,
  exactly as `token_ok` validates the string that becomes argv. **And put the escaping at the
  EXIT, not at the call sites** — the same slice measured the difference: a sweep that wrapped
  every echo site it could find still missed two, and the bounded re-review reproduced the
  injection through one of them (critical-surface filenames on the `review tier:` line, which sits
  after the window's closing anchor — safe-looking until a forged `gates:` RE-ARMS `sed`'s range
  and reopens it). A "choke point" that callers must remember to call is a habit; one function
  every line leaves through is a rule. Corollary for the channels a threat model skips: "no
  machine parses this stream" does not mean nobody does — the pre-commit hook's stderr lands in a
  terminal, where a raw ESC sequence repaints the hook's own output.

## Finding disposition — fix the class, not the instance

For every confirmed finding, judge: is this one instance of a defect CLASS? If yes, name the
deterministic owner that would retire the class forever — a selftest assertion, a
`manifest-gate.mjs` or emitter check, a CI step — and record it as an ADR-candidate entry in
`docs/handoff-archive/BACKLOG.md`, in the section matching the surface, appended at the END of
that section (the ledger's own header states the append rule; path owned by ADR 0040). The
handoff's §Next actions carries only items whose trigger has fired. Fixing only the instance is an
incomplete disposition.
