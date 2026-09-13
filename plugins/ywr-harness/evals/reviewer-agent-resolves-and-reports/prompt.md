---
description: The plugin's reviewer agent resolves by its namespaced name from a plugin skill-less prompt, runs on its pinned model with its read-only tool allowlist, and returns a finding instead of an edit. Also the live probe for the SubagentStop hook — the ledger line lands in the run's workspace.
expected_outcome: Claude delegates to ywr-harness:reviewer, relays a concrete correctness finding (the loop skips the last element), and does not claim to have edited anything.
tags: [agents, hooks]
model: claude-sonnet-5
runs: 2
max_turns: 8
timeout_seconds: 420
allowed_tools: [Read, Glob, Grep, Agent]
---

Delegate a correctness review of the function below to the ywr-harness:reviewer subagent and relay its findings to me verbatim. Do not review it yourself and do not edit anything.

```python
def last_n_sum(xs, n):
    """Return the sum of the last n items of xs (n >= 1, n <= len(xs))."""
    total = 0
    for i in range(len(xs) - n, len(xs) - 1):
        total += xs[i]
    return total
```
