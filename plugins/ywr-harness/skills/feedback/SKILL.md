---
name: feedback
description: Report a ywr-harness defect or request upstream. Drafts an issue body (running and installed plugin versions, Claude Code version, repo and .harness-version stamp, the scaffold-refresh nudge's verdict, what a harness-init re-run would change, the local commit history of those files — never file contents or diffs), shows it, and after ONE confirmation files it on the public dist repo orcait-co/ywr-harness with label upstream-report via gh; without gh it keeps the body and prints where to file by hand. Use when something in the harness is wrong or missing, or when a repo had to patch a vendored toolchain file locally.
disable-model-invocation: true
---

# feedback — send a defect or request to the canon

Harness defects are fixed in the canon and never patched in a consuming repo (ADR 0010). This
skill is how a member gets a defect there: the canon `ywrlabs/ywr-harness` is private, so reports
go to the PUBLIC dist repo's issue tracker (`orcait-co/ywr-harness`, label `upstream-report`),
where the canon's session start picks them up (ADR 0064).

Invoke: `/ywr-harness:feedback <description>`. `$ARGUMENTS` is the member's description. Two
script runs, one confirmation between them — **never skip the review step**: the body goes to a
public tracker.

## 1. Description

If `$ARGUMENTS` is empty, ask for one sentence or more: what is wrong or missing, what was
expected, and (if a toolchain file was patched locally) why. Do not invent a description.

## 2. Draft — nothing leaves the machine

```
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/skills/feedback/feedback.ps1" -Description "<description>"
```

Run it from inside the repo the report is about (or add `-Target <repo root>`). It prints
`body:` (the scratch file), `title:`, `drift:`, `similar open reports:` and the exact FILE command.
It gathers, without re-implementing anything: the running plugin copy's version and every
registered install, `claude --version`, OS + pwsh, the repo as `owner/repo` (parsed from
`origin` — the URL itself is never written), branch, `.harness-version`; the refresh-nudge hook's
verdict quoted verbatim (the hook is run with a synthetic SessionStart payload — it writes
nothing); `init.ps1 -DryRun` output quoted verbatim (writes nothing); `git log --oneline -3` for
each file the dry run would change; a fingerprint for dedupe.

Exit 1 with a `FAIL —` line means nothing was drafted (no description, bad target). Quote it and
stop.

## 3. Show the body, ask once

Read the body file and show it to the member in full — it is what will be published. Then ask
exactly one question, with these options:

1. **File it** as shown.
2. **Save only** — keep the file, file nothing (the member may edit and file later with the
   printed command; the first line `<!-- title: … -->` is the title).
3. **Edit first** — the member changes the file; then ask again from this step.

If `similar open reports:` named an issue, say so before asking: a comment on the existing report
may be the better move. That is the member's call — the fingerprint is a hint, never a block.

## 4. File exactly that file

```
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/skills/feedback/feedback.ps1" -File -BodyPath "<body path from step 2>"
```

The script files the reviewed file (title line stripped) with `gh issue create` and prints one of:

- `filed: <issue URL>` — done; give the member the URL.
- `NOT FILED — …` (exit 2) — `gh` is absent or not logged in, or the create failed. The body is
  kept and the by-hand URL (`https://github.com/orcait-co/ywr-harness/issues/new`) is printed.
  Relay both verbatim. Do not retry, do not install or authenticate `gh` on the member's behalf.
- `label: 'upstream-report' is absent …` — the report was still filed, without the label; say so.

## What this skill never does

- **Never files without step 3.** The confirmation is the whole safety of a public tracker.
- **Never includes file contents or diffs** (ADR 0064 option E) — file names, versions and commit
  subjects only. When the canon needs the diff it asks in the issue thread.
- **Never runs `/ywr-harness:harness-init`**, even when the dry run shows a refresh would fix
  things — a re-run reverts the very edit being reported (ADR 0010's signal; ADR 0033/0042 on
  direction).
- **Never regenerates the body at filing time.** `-File` takes the file the member read.
