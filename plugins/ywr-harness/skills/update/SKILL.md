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

Run `claude plugin list --json` and read every object whose `id` starts with `ywr-harness@`. The
text after `@` is the marketplace name. Record it with the object's `version`, **`scope`** and
`enabled`. **Never assume the marketplace name or the scope** — read both from the object;
hardcoding the name breaks any machine that registered the marketplace under another name, and a
project- or local-scope install sits beside a user-scope one only as its own object.

- `claude` not on PATH → report that and stop; nothing here works without the CLI.
- `--json` refused (a host older than the flag) → run the same command without it and read the
  `ywr-harness@<marketplace>` row of the text list for the same four values.
- No `ywr-harness@…` entry → report "not installed" and stop. Installation is the member's
  choice (ADR 0010); this skill updates, it never installs.

## 2. Update on disk

```
claude plugin marketplace update <marketplace> --json
claude plugin update ywr-harness@<marketplace> -s <scope> --json
```

Each command prints one JSON result line, the last line on stdout. Read its `outcome`: `ok` or
`failed`. A failed `update` line also carries `failureCode` and `message`. These field names were
measured on 2.1.295 (fact 109).

**Text fallback.** When any command refuses `--json` as an unknown option — step 1's `list` or
either command here — run that command again without it, and run every later command without it.
Judge a command run without `--json` by its exit code and its printed message. A command that ran
with `--json` and printed `outcome: "failed"` is a failure, not a refusal: never retry it.

`<scope>` is the `scope` of the same `list` object. Pass it even though `-s` now auto-detects
(`--help`, 2.1.295; it defaulted to `user` when measured 2026-08-06): an explicit scope updates
exactly the install the list named. `marketplace update` takes no scope flag. If the list shows
more than one ywr-harness object, run the update once per listed scope. A `project` or `local`
install belongs to one repo, so run its update from that repo's root. Which such installs the
list shows from another directory is unmeasured. When the update of a `project` or `local` scope
fails, quote it, name the scope, and still finish the other scopes.

Run both, in that order. Whether `claude plugin update` refreshes the catalog by itself is not
documented (neither subcommand's `--help` says — measured 2026-08-06), so refresh first: one
extra command removes the dependency on unverified resolution behavior.
Quote any failure verbatim — the result line's `message`, or the stderr text when no line came —
and stop; do not retry blindly. The one exception is the `project` or `local` scope rule above:
such an install may belong to another repo, so its failure, the command stop below included,
does not block the remaining scopes. A failed marketplace refresh keeps the last good catalog
cache rather than dropping the registration (the `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE`
guard, ADR 0023/0026); say that instead of treating it as a lost marketplace.

Never pass `-y` or `--accept-command`. Both accept a marketplace-declared command, and that
acceptance is the person's call. This skill runs without a terminal, and the CLI requires `-y`
there (`--help`), so an update that brings such a command fails here. The `--help` text says a
`--json` run reports it as `shownCommand`; neither that field nor the refusal text of an unknown
`--json` option was measured, so judge both by the printed message. When the result names a
command to confirm, quote the command and the message, then stop and tell the person to run
`claude plugin update ywr-harness@<marketplace> -s <scope>` in their own terminal. The CLI shows
the command there and asks before it runs.

## 3. Report the version change

Read the `update` result line: report **`oldVersion` → `newVersion`** on disk, or "already
newest" when `updateOutcome` is `up_to_date`. Only `up_to_date` was measured (fact 109). When the
line lacks either version field, or on the text fallback, run `claude plugin list` again and
compare the version with step 1's — never infer a version the CLI did not print.
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
(ADR 0034): the byte comparison alone cannot prove direction (the `.harness-version` stamp
orients the nudge's advice since ADR 0042, and `init.ps1` itself refuses a stamped downgrade —
but a stampless repo stays ambiguous), so an automatic re-run could REVERT a
working tree that is deliberately newer than the installed plugin (ADR 0033); before the reload
has happened, *which* `init.ps1` bytes a path invocation executes is an installation-layout
detail, not a contract; and `ywr-harness:harness-init` is user-invoked by design — a bundle that
shells into its script would bypass that gate.
