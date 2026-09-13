---
description: The plugin's SessionStart version-announce hook (ADR 0030/0031) fires in a fresh isolated session and its additionalContext reaches the model. Automates spec 0012 §3 row 1 (hook events and payload delivery) for the exec-form pwsh hooks.
expected_outcome: The reply names the ywr-harness plugin with a semantic version and says this is the first recorded run, without calling any tool. Without the plugin the model has no such context and says so.
tags: [hooks, smoke]
model: claude-sonnet-5
max_turns: 2
allowed_tools: []
---

Which version of the ywr-harness plugin is active in this session, and is this its first recorded run on this machine? Answer in one sentence using only the context you already have. Do not search the filesystem and do not call any tool. If you have no such context, say exactly that.
