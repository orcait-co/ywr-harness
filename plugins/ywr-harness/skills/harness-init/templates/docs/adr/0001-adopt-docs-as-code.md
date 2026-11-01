---
id: "0001"
type: adr
title: "Record architecture decisions as append-only ADRs alongside living specs"
status: accepted
date: 2026-01-01
deciders: [ ]
supersedes: []
superseded_by: null
related_adr: []
related_spec: []
tags: [process, docs-as-code]
---

# 0001. Record architecture decisions as append-only ADRs alongside living specs

> The ywr-harness scaffold seeded this ADR, so this repo has a buildable corpus from the first commit.
> Replace `date` and `deciders` with the real values. Then treat this ADR as a normal ADR.
> From that point, this ADR is append-only.

## Context

Git history keeps the decisions of a repo only as diffs. A diff shows what changed. A diff does
not show the alternatives that people weighed, or why those alternatives lost. So the same
question comes back each time the people or the tooling change.

Sessions with an AI assistant make this problem worse. An assistant reads the current state
cheaply. An assistant cannot recover intent that nobody wrote down. So the assistant derives a
settled decision again, or it contradicts that decision without notice.

## Options Considered

| 선택지 | 장점 | 단점 | 판정 |
|---|---|---|---|
| **A. An append-only ADR for why, plus a living spec for how it is now** | Intent survives. Current behavior has exactly one place to read. A reversal shows as a supersede, not as an edit. | People must keep two documents straight. Nobody may edit an accepted ADR, and that rule takes discipline. | ✅ 채택 |
| B. A single living design document | One file to find. | A rewrite destroys the record of what people believed before. That record is the only part worth keeping. | ❌ |
| C. Git history and pull request descriptions only | No extra files. | Nobody can address or index the rationale. The rationale spreads across review threads, and those threads decay. | ❌ |
| D. An external wiki | Rich editing. People outside engineering can use it. | The wiki drifts from the code. Nothing fails when the wiki and the code disagree. | ❌ |

## Decision

This repo keeps two document sets.

- `docs/adr/` records **why**, and it is **append-only**. To reverse a decision, write a new ADR
  and mark the old ADR `superseded`. Never edit the context or the decision of an old ADR.
- `docs/spec/` records **how it works now**. Anyone can update a spec at any time. Git holds the
  history.
- **Frontmatter is the single source of truth** for status, dates and relationships. The body
  never repeats these facts. A fact in two places drifts, and the body copy goes stale without
  notice.
- `pwsh docs/build.ps1` regenerates `index.json`, `INDEX.md` and `docs.html`. Commit the
  generated index with the source change. Then tooling can query decisions without reading every
  file.

## Rationale

1. The append-only rule makes the record trustworthy.
   A document that people edit to match the present tells nothing about the past.
   So that document cannot answer "why is it like this".
2. The split between *why* and *how it is now* removes the reason to rewrite history.
   Current behavior has its own living home.
   So an ADR never needs an update to stay accurate.
3. A generated, committed index makes the corpus machine-queryable.
   An assistant can then check for an existing decision before it proposes a new one.

## Consequences

**긍정**
- Rejected options stay on the record, so settled questions do not reopen.
- Each decision gets an address, such as `ADR 0007`. Commits, reviews, code comments and prompts
  can cite that address.

**부정 / 트레이드오프**
- Append-only feels wrong the first time that a mistake needs a correction. The correct move is a
  new ADR that supersedes the old ADR. A new ADR takes more ceremony than an edit.
- Someone must rebuild and commit the generated surfaces. A rule alone only discourages a stale
  index. A drift gate makes a stale index impossible to merge.

**후속 작업 / 트리거**
- The scaffold declares `docs/check_docs.py` as the drift gate of the docs groups in
  `.harness.json`. Pre-commit and CI run that gate when a document or a generated index changes.
  Keep that declaration when you edit the groups.
- Write the first spec when this repo has behavior worth describing apart from its rationale.

## Open Questions

- None yet. Replace this section when the first real one appears.
