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

> Seeded by the ywr-harness scaffold so this repo has a buildable corpus from the first commit.
> Replace `date` and `deciders` with the real values, then treat it as a normal ADR — it is
> append-only from here.

## Context

Decisions made in a repo are recoverable from git history only as diffs. A diff shows what
changed, never which alternatives were weighed or why they lost, so the same question gets
re-litigated whenever the people or the tooling change. Sessions with an AI assistant make this
sharper: an assistant reads the current state cheaply and cannot recover intent that was never
written down, so it re-derives — or silently contradicts — decisions already settled.

## Options Considered

| 선택지 | 장점 | 단점 | 판정 |
|---|---|---|---|
| **A. ADR (append-only, why) + spec (living, how it is now)** | Intent survives; current behavior has exactly one place to read; a reversal is visible as a supersede rather than an edit | Two documents to keep straight; discipline required to never edit an accepted ADR | ✅ 채택 |
| B. A single living design document | One file to find | Rewrites destroy the record of what was believed before, which is the only thing worth keeping | ❌ |
| C. Git history and PR descriptions only | Zero extra files | Not addressable, not indexable, and rationale is scattered across review threads that decay | ❌ |
| D. External wiki | Rich editing, non-engineer access | Drifts from the code it describes because nothing fails when they disagree | ❌ |

## Decision

We keep two document sets in this repo.

- `docs/adr/` records **why**, and is **append-only**. To reverse a decision, write a new ADR and
  mark the old one `superseded` — never edit its context or decision.
- `docs/spec/` records **how it works now**, and is freely updated; git holds the history.
- **Frontmatter is the single source of truth** for status, dates, and relationships. It is never
  restated in the body, because a fact in two places drifts and the body copy is the one that goes
  stale silently.
- `pwsh docs/build.ps1` regenerates `index.json`, `INDEX.md`, and `docs.html`. The generated index
  is committed with the source change so tooling can query decisions without reading every file.

## Rationale

1. The append-only rule is what makes the record trustworthy. A document that can be edited to
   match the present tells you nothing about the past, so it cannot answer "why is it like this".
2. Splitting *why* from *how it is now* removes the incentive to rewrite history: current behavior
   has a living home, so the ADR never needs updating to stay accurate.
3. A generated, committed index makes the corpus machine-queryable, which is what lets an
   assistant check for an existing decision before proposing a new one.

## Consequences

**긍정**
- Rejected options stay on the record, so settled questions stop reopening.
- Decisions become addressable (`ADR 0007`) in commits, reviews, code comments, and prompts.

**부정 / 트레이드오프**
- Append-only feels wrong the first time a mistake needs correcting; the correct move is a new ADR
  that supersedes, which is more ceremony than an edit.
- The generated surfaces must be rebuilt and committed, and a drift gate is needed to make a stale
  index impossible to merge rather than merely discouraged.

**후속 작업 / 트리거**
- Add the CI drift gate that fails when the committed `index.json`/`INDEX.md` disagree with the
  sources. Until it exists, the index staying current depends on memory.
- Write the first spec when this repo has behavior worth describing separately from its rationale.

## Open Questions

- None yet. Replace this section when the first real one appears.
