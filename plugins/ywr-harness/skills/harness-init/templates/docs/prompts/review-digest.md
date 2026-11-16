# Stage prompt: review-digest

The adversarial review returned its digest. Dispose of it under the harness rules before you edit anything.

- `canary_ok false` means the review did not prove that its finders work. Report this to the owner. Do not treat the
  review as passed.
- `COVERAGE LOSS` names lost legs. Put each lost leg in the ready report. A finding whose skeptic legs all
  died stays in `confirmed` with `unverified: true` (`unverified_by_death` counts them). Read a high or medium one
  against its claim before you fix it or give it a disposition. A low one goes in the low list, marked `unverified`.
- `high_ids` other than `none`: each high id needs its fix proof through `fix_proof.py`, which `/ywr-harness:slice-close`
  runs. The script ships in the ywr-harness plugin, not in this repository: slice-close stage 2 names its path and the
  `run` form that goes before the fix. Only the owner can waive a high. Never accept your own exemption.
- Each confirmed high or medium finding, and each site in its `also_at` list, gets one of three dispositions: **fixed**;
  **valid, no action**, whose reason names the record that keeps it (an ADR residual, a spec known limit, a handoff
  item or a `BACKLOG.md` entry); or **false on reading**, whose reason quotes the line that shows it.
  `/ywr-harness:slice-close` defines the three. A high or medium in `rejected[]` whose votes split 1–1 is read
  against its claim before it counts as rejected. If the claim holds, the finding gets one of the three
  dispositions.
- Each confirmed high or medium finding also gets one class line in the close record (ywr-harness ADR 0208):
  `class: <id> instance — <reason>`, or `class: <id> BACKLOG — <deterministic owner>` with one bullet appended to
  `docs/handoff-archive/BACKLOG.md`, which you create with a title line when the repo has none.
- A confirmed low gets no disposition and no class judgment (ywr-harness ADR 0206). This covers an out-of-scope low and an
  unverified low too. The close record, the slice commit body, lists each low: its id, title, `file:line` and
  `also_at` count. Mark it `fixed` when you fix it anyway at every site, `fixed in part` with the fixed sites when
  you fix some, and `unverified` when the review did. A fixed low goes through the fix gates and gets no fix check.
  The list is no handoff item, no open item, no `BACKLOG.md` entry and no next-slice candidate.
- An out-of-scope confirmed high or medium finding becomes a handoff open item candidate. Fix it in this slice only when its file is
  already in the slice.
- A fix closes on re-run gates over the fix's own files and one fix check per high or medium finding. A worker leg takes at most four
  findings. A fix on a critical surface gets its own leg.
- No fix gets a re-review in this slice, a patch or a new mechanism (ywr-harness ADR 0200). A rebase re-arm over the overlap is
  no fix re-review. When you judge that a fix needs more review, record this note on one line:
  `python scripts/harness/slice_note.py add risk "open item: review <files and lines> of the <id> fix; <why>"`.
  The close puts it in the handoff. This is your decision, not an owner question.
- Record each high or medium disposition with `python scripts/harness/slice_note.py add decision "<id> fixed: <how>"`, or with
  `add rejected "<id> <disposition>: <reason>"` for a finding that gets no fix.
