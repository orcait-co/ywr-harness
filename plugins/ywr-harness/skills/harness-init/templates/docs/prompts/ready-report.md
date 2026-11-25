# Stage prompt: ready-report

The `harness_gates.py --tree` run is the last step before the ready report. Check these points before you write it.

- The report's LAST line is this run's output, verbatim. Any edit after this run makes it stale: run it again.
- Every command that the emitter printed ran after the final edit. The report lists each passed gate by name.
- The review ran once, or again only over a rebase overlap. The report states its level, its item count and the
  usage line of its task notification as printed, and the cap note when the count equals a known cap. When the
  notification carries no usage line, the report says so. Every finding has a severity and a disposition. The
  report names each fix that went to an open item, or says `none`.
- The report quotes the verify verdict, or the `verify_map.py` output when the verify skill did not run.
- Each owner question (a cost) is listed in this report. The questions are asked with
  AskUserQuestion after the report, never as plain text in it.
- Each residual risk and each unverified point is a `python scripts/harness/slice_note.py add risk` note.
- Do not write the handoff. Do not commit. The close does both.
- After the report, ask each open owner question with AskUserQuestion. When every question has an answer,
  call the `ywr-harness:slice-close` skill yourself in the main session (ywr-harness ADR 0201). A subagent never calls it.
  The person can also type `/ywr-harness:slice-close`.
