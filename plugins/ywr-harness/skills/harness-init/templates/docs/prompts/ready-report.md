# Stage prompt: ready-report

The `harness_gates.py --tree` run is the last step before the ready report. Check these points before you write it.

- The report's LAST line is this run's output, verbatim. Any edit after this run makes it stale: run it again.
- Every command that the emitter printed ran after the final edit. The report lists each passed gate by name.
- The review ran once, and every confirmed finding has a disposition. A skipped bounded re-review is an owner
  question in this report.
- The report quotes the `fix_proof.py check` output. An exit 3 lists the waivers that the owner must answer. The
  script ships in the ywr-harness plugin, not in this repository: `/ywr-harness:slice-close` stage 2 names its path.
  When this session has no path, the report says so, and the close runs the check.
- The report quotes the verify verdict, or the `verify_map.py` output when the verify skill did not run.
- Each owner question (a cost, a waiver, a skipped re-review) is asked in this report. An unanswered question is
  asked again at the close.
- Each residual risk and each unverified point is a `python scripts/harness/slice_note.py add risk` note.
- Do not write the handoff. Do not commit. The owner types `/ywr-harness:slice-close`.
