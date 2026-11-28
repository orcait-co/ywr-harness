---
description: The model-invocable skill ywr-harness:verify is chosen on natural phrasing (its description, not its name). The model can also call slice-close (ywr-harness ADR 0201), and the prompt names a slice close, so the case also shows that verify is the skill it picks. Guards the description against a rewrite that stops it triggering. The skill is a router that runs the mapper with Bash first and spawns the pinned verifier agent only for a run line (ywr-harness ADR 0242). allowed_tools lists no Bash, so when the sandbox denies the mapper call the router reports that nothing was verified and spawns no agent; no verification runs either way. The sole grader is the Skill call.
expected_outcome: Claude invokes the verify skill (namespaced form accepted) rather than improvising a verification of its own.
tags: [skills, plugin-system]
model: opus
max_turns: 6
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

I am about to close this slice. Run the spec-owned verification for my current changes end-to-end and give me the report.
