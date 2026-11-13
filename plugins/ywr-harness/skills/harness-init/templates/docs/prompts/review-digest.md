# Stage prompt: review-digest

The adversarial review returned its digest. Dispose of it under the harness rules before you edit anything.

- `canary_ok false` means the review did not prove that its finders work. Report this to the owner. Do not treat the
  review as passed.
- `COVERAGE LOSS` names lost legs. Put each lost leg in the ready report. A dead skeptic leaves its finding
  unverified (`unverified_by_death`), not confirmed.
- `high_ids` other than `none`: each high id needs its fix proof through `fix_proof.py`, which `/ywr-harness:slice-close`
  runs. The script ships in the ywr-harness plugin, not in this repository: slice-close stage 2 names its path and the
  `run` form that goes before the fix. Only the owner can waive a high. Never accept your own exemption.
- Each confirmed finding, and each site in its `also_at` list, gets one of three dispositions: **fixed**;
  **valid, no action**, whose reason names the record that keeps it (an ADR residual, a spec known limit, a handoff
  item or a `BACKLOG.md` entry); or **false on reading**, whose reason quotes the line that shows it.
  `/ywr-harness:slice-close` defines the three. A high or medium in `rejected[]` whose votes split 1–1 is read
  against its claim before it counts as rejected. If the claim holds, the finding gets one of the three
  dispositions.
- An out-of-scope confirmed finding becomes a handoff open item candidate. Fix it in this slice only when its file is
  already in the slice.
- A fix closes on re-run gates over the fix's own files and one fix check per finding. A worker leg takes at most four
  findings. A fix on a critical surface gets its own leg.
- No fix gets a re-review in this slice, a patch or a new mechanism (ywr-harness ADR 0200). A rebase re-arm over the overlap is
  no fix re-review. When you judge that a fix needs more review, record this note on one line:
  `python scripts/harness/slice_note.py add risk "open item: review <files and lines> of the <id> fix; <why>"`.
  The close puts it in the handoff. This is your decision, not an owner question.
- Record each disposition with `python scripts/harness/slice_note.py add decision "<id> fixed: <how>"`, or with
  `add rejected "<id> <disposition>: <reason>"` for a finding that gets no fix.
