---
description: The one model-invocable skill, ywr-harness:verify, is chosen on natural phrasing (its description, not its name). Guards the description against a rewrite that stops it triggering. The skill is a router that spawns the pinned verifier agent through the Agent tool. The host exposes that tool although allowed_tools does not list it, so the spawn runs, but the verifier gets only this case's read-only tools and stops without a shell; no verification runs. The sole grader is the Skill call.
expected_outcome: Claude invokes the verify skill (namespaced form accepted) rather than improvising a verification of its own.
tags: [skills, plugin-system]
model: claude-sonnet-5
max_turns: 6
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

I am about to close this slice. Run the spec-owned verification for my current changes end-to-end and give me the report.
