---
name: update
description: Apply a ywr-harness release now instead of waiting for the background auto-update — refresh the plugin's marketplace and update the installed plugin via the CLI, report the on-disk version change, then hand off the two manual steps (reload; conditional scaffold refresh) in order. Use when the user wants the newest release immediately.
disable-model-invocation: true
---

# update — apply a release now

Auto-update already converges every machine "by the next session start" (ADR 0026: background
check after session start, random delay up to 10 minutes; a running session keeps the version it
loaded). This skill is the **apply-now** path for the member who does not want to wait.

It automates exactly the CLI half. The other two steps are structurally manual — say so in the
report instead of pretending otherwise (ADR 0034).

## 1. Resolve the installed plugin

Run `claude plugin list` and find the `ywr-harness@<marketplace>` entry. Record the marketplace
name, the version, the **scope**, and the status. **Never assume the marketplace name or the
scope** — read both from the entry; hardcoding the name breaks any machine that registered the
marketplace under another name, and omitting the scope makes the update target the default
(`user`) scope, which silently misses a project- or local-scope install.

- `claude` not on PATH → report that and stop; nothing here works without the CLI.
- No `ywr-harness@…` entry → report "not installed" and stop. Installation is the member's
  choice (ADR 0010); this skill updates, it never installs.

## 2. Update on disk

```
claude plugin marketplace update <marketplace>
claude plugin update ywr-harness@<marketplace> -s <scope>
```

`<scope>` is the Scope field from the same `claude plugin list` row (`-s` defaults to `user` —
measured 2026-08-06 — so a project- or local-scope install needs the flag; `marketplace update`
takes no scope flag). If the list shows more than one ywr-harness row, run the update once per
listed scope.

Run both, in that order. Whether `claude plugin update` refreshes the catalog by itself is not
documented (neither subcommand's `--help` says — measured 2026-08-06), so refresh first: one
extra command removes the dependency on unverified resolution behavior.
Quote any failure verbatim and stop — do not retry blindly. A failed marketplace refresh keeps
the last good catalog cache rather than dropping the registration (the
`CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE` guard, ADR 0023/0026); say that instead of
treating it as a lost marketplace.

## 3. Report the version change

Run `claude plugin list` again. Report **old → new** on-disk version, or "already newest".
Either way, state plainly: **this session is still running the version it loaded at startup.**
The statusline's `ywr-harness vX.Y.Z` segment shows the on-disk value (ADR 0027), so disk moving
ahead of the session is visible and normal — it *is* the restart-to-apply signal.

## 4. Hand off the manual steps — always print these, in order

1. **Apply in-session**: type `/reload-plugins`, or restart Claude Code. The update CLI itself
   says "restart required to apply"; no skill can type a REPL built-in for you.
2. **Scaffold refresh, only when nudged**: if this release changed vendored toolchain files, the
   session-start nudge (ADR 0033) will name the drifted files at the next session start. Run
   `/ywr-harness:harness-init` **then** — once per repo, commit the result. If the nudge stays
   silent, there is nothing to refresh.

## What this skill never does

It never runs `/ywr-harness:harness-init` itself, even though bundling it looks convenient
(ADR 0034): the nudge's comparison is direction-blind, so an automatic re-run could REVERT a
working tree that is deliberately newer than the installed plugin (ADR 0033); before the reload
has happened, *which* `init.ps1` bytes a path invocation executes is an installation-layout
detail, not a contract; and `ywr-harness:harness-init` is user-invoked by design — a bundle that
shells into its script would bypass that gate.
