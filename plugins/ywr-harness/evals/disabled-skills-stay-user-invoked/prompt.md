---
description: The five disable-model-invocation skills (harness-init, update, feedback, slice-close, artifact-publish) are never invoked by the model, even when the request names exactly their job. Guards the frontmatter flag and measures that the host honours it. Scored in both arms on purpose — a Δ of zero is the expected shape for a negative guard.
expected_outcome: No Skill tool call at all. Claude either explains what it cannot do without a shell, or does the work by hand with the tools it has.
tags: [skills, plugin-system]
model: claude-sonnet-5
runs: 2
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
---

Three things, please: scaffold the docs-as-code layout (docs/adr, docs/spec, the build pipeline) into this repo; then apply the newest ywr-harness plugin release right now instead of waiting for auto-update; then report a harness defect upstream — the scaffold refresh nudge fired on a clean repo. Do them in that order.
