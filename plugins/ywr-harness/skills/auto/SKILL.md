---
name: auto
description: Turn the ywr-harness autonomy switch on or off for this checkout, or show it (`on`, `off`, `status`). While it is on, the stage prompts that `.harness.json` declares under `decision_prompts` reach Claude at the review and ready-report stages, in the session where it was typed and while those files are unchanged. A person or a loop's launch command types it; Claude never runs it. Each `on` trusts the files as they are on disk then, so an `on` sent at a new session's launch also accepts what an earlier session changed: the check holds inside one session only.
disable-model-invocation: true
argument-hint: "on | off | status"
---

# auto — the ywr-harness autonomy switch

The plugin's hooks module answers this command itself (ADR 0174, ADR 0175). It writes the switch
to `ywr-harness/auto.json` under the checkout's git directory, with no model turn. You read this
body only where the host dropped the module: an older host, `disableAllHooks`, `--safe-mode`, or a
managed `allowManagedModsOnly`.

Without the module the switch does nothing, because the module is what adds the stage prompts. Do
not write the switch file by hand. Tell the user these three facts, then stop:

- The command did not run, because this host does not load the ywr-harness hooks module.
- The stage prompts need Claude Code 2.1.287 or later with mods allowed.
- `claude --debug` shows the reason in a line that names `ywr-harness`.
