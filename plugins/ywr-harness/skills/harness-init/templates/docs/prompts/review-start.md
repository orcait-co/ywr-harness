# Stage prompt: review-start

The slice review started: `/code-review` runs in the background (ywr-harness ADR 0215). Wait for its task notification
before you edit anything, then dispose of its findings under the harness rules.

- Record the level and the item count. When the count equals a known cap (10 in a `claude -p` run, 32 in the findings
  tool), the record says that the cap can hide findings.
- Record the usage line of the task notification as printed: the duration, the tool uses and the tokens of the review
  agent. When the notification carries no usage line, record that.
- The review reads the review canon from `CLAUDE.md`: its `## Review canon` section, or a canon file that `CLAUDE.md`
  imports. Record the `review canon:` line of the gate emitter. When that line says NOT FOUND, NOT IMPORTED or NO
  HEADING, record that the review ran without the review canon. When the canon section, the canon file or its import
  changed during this session, record that nobody verified whether the review read the change.
- Every finding gets one of three dispositions: **fixed**; **valid, no action**, whose reason names the open item that
  keeps it; or **false on reading**, whose reason quotes the line that shows it. `/ywr-harness:slice-close` defines
  the three. The severity (`important`, `pre_existing`, `nit` or none) goes in the record and limits the disposition
  (ywr-harness ADR 0216). An `important`, `pre_existing` or ungraded finding ends fixed or false on reading. Only a
  `nit` whose fix would change a design or a coverage ends valid, no action. A fix that rests on an untested host
  behaviour gets a probe first. When the owner defers that probe, the finding ends valid, no action as the owner's
  decision, with an open item. A finding that names more than one site gets a disposition per site.
- The review cannot leave out the handoff or a drift-gated generated surface. A finding there gets a disposition too.
  A finding on a generated surface is fixed at its source.
- A fix closes on re-run gates over the fix's own files. Every fixed finding except a `nit` also gets a fix check on
  `ywr-harness:worker`. A leg takes at most four findings. A fix on a critical surface gets its own leg. A fixed `nit`
  gets no leg.
- No fix gets a re-review in this slice, a patch or a new mechanism (ywr-harness ADR 0200). A rebase re-arm over the
  overlap is no fix re-review. When you judge that a fix needs more review, record this note on one line:
  `python scripts/harness/slice_note.py add risk "open item: review <files and lines> of the <file:line> fix; <why>"`.
  The close puts it in the handoff. This is your decision, not an owner question.
- Record each disposition with `python scripts/harness/slice_note.py add decision "<file:line> fixed: <how>"`, or with
  `add rejected "<file:line> <disposition>: <reason>"` for a finding that gets no fix.
