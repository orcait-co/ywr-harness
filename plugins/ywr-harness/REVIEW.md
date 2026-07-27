# REVIEW.md — house review invariants (single source, ADR 0098)

The review contract for EVERY review path in this repo: `/ywr-harness:slice-close` stage 3
(adversarial-review, ADR 0050), ad-hoc PR review, `/code-review`, or a human
reviewer. `/ywr-harness:slice-close` assembles its `invariants` block from this file — edit
here, never keep inline copies elsewhere. When reviewing, trim to the
invariants the change can actually violate (proportionality, ADR 0050).

## Invariants

1. **Tenant isolation (spec 0001)** — RLS `FORCE` + `SET LOCAL
   app.current_tenant` inside the request transaction; the tenant id comes ONLY
   from signed JWT claims; the app role has no `BYPASSRLS`. Every table with a
   `tenant_id` column ships RLS enabled + FORCE + at least one policy
   (`test_all_tenant_tables_have_rls_force_policy` is the structural guard).
2. **Deterministic numeric core (ADR 0042)** — P&L / PVM / costing figures come
   from SQL/Python only. No LLM in the numeric path; LLM output is explanation
   and NL interfaces, never the source of a number.
3. **Clean-room (ADR 0047)** — no external ERP identifiers, vendor names, or
   product names from prior/foreign systems in schema, code, docs, or metadata.
4. **Honest reporting** — product surfaces answer "cannot tell from the
   provided data" instead of fabricating (ontology ask, provenance-drill
   fallbacks); harness surfaces report skipped checks as skipped (never
   passed) and surface coverage caps instead of truncating silently (org
   guide rule; ADR 0074 applies it to CI range scoping).
5. **Docs-as-code (docs/README.md)** — ADRs are append-only (supersede, never
   edit); frontmatter is the single source of truth (no body duplication); new
   internal doc prose is English.
6. **Secrets** — never committed (`.env` gitignored, `.env.example` only).
   Gitleaks-pin hygiene: NEVER quote a false-positive trigger string in pin
   comments, handoffs, or commit messages — the quotation becomes the next
   finding on an immutable pushed blob; describe it in prose instead.
7. **Derived data rebuilds with its source (spec 0004 §9)** — a script that
   re-seeds or scope-replaces source data must rebuild (or loudly refuse
   without) its downstream derived artifacts, in dependency order: upstream
   computed tables → graph → embeddings.

## Review-time gotchas (each cost a real debugging session)

- **RLS debugging/E2E connects as the app role (`app:app`), never `postgres`** —
  superusers always bypass RLS, FORCE included, so cross-tenant rows seen from
  a superuser connection are an artifact of the connection, not a bug (and E2E
  run under a superuser `DATABASE_URL` fails falsely with cross-tenant
  contamination). Superuser URLs are for alembic migrations only.
- **On-box (POC) in-process verify needs a one-off dev-jwt container** — the
  serving container runs `AUTH_PROVIDER=cognito`, so dev HS256 tokens all 401
  under `docker compose exec`. See the `/ywr-harness:verify` skill for the exact command.
- **Same-pathname query-only client navigation does not remount client
  components** — a surface that parses `location.search` once on mount must not
  gain an in-app link without a resync path (`useSearchParams` + coord-keyed
  remount; 2026-07-17 provenance sidebar link, confirmed high).
- **A finding that turns on a field name, an enum member, or the ABSENCE of
  either must be read from the raw source, and must state how it was fetched** —
  rendered/extracted views drop content. 2026-07-25 (ADR 0120): a finder and
  BOTH skeptics read a doc page through WebFetch and declared a field absent; a
  raw `.md` copy whose SHA256 matched live carried three occurrences, so a
  confirmed `high` was rejected on verification. Absence is the expensive claim —
  say `curl`-ed raw + grepped locally, or do not claim it.
- **A count offered as evidence is only as wide as the population actually
  enumerated — quote the command with the number, and declare every narrowing in
  it** (a cap · an exclusion filter · an undeclared scope). Same class as
  invariant 4 (surface caps, never truncate silently), but it bites in the
  citation rather than in the product surface. 2026-07-25 (ADR 0121): a
  `head -5`-capped approval check restated as "38/38", a number the command could
  not have produced. Three more surfaced 2026-07-26 — a `grep -v` added to drop
  the library also dropped the library's own selftest, ten for 11 (ADR 0126) · a
  census over the set that SHARES a helper instead of the set that HAS the
  defect, six for eight (ADR 0126) · an ADR 0116 Addendum count scoped to
  `.claude/hooks/` without saying so, which ADR 0122 (five) and 0124 (six) then
  incremented as if it had been repo-wide; the real count was seven (ADR 0125).
  **Building on a recorded count inherits its undeclared narrowing** —
  re-run the enumeration, and if a narrowing stays, quote it with the total.
  Prose-enforced only: the deterministic verifier is still an open ADR-candidate
  (BACKLOG §Harness).

## Finding disposition — fix the class, not the instance (ADR 0098)

For every confirmed finding, judge: is this one instance of a defect CLASS?
If yes, name the deterministic owner that would retire the class forever — a
ruff/eslint rule (gate expansion needs its own ADR, per ADR 0069), a CI check
(ADR 0074), or a verify-script assertion — and record it as an ADR-candidate
entry in `docs/handoff-archive/BACKLOG.md`, whose section matches the surface;
the handoff §Next actions carries only items whose trigger has fired (ADR 0116
Addendum 2). Fixing only the instance is an incomplete disposition.
