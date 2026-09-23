# /ywr-harness:slice-close — reference for the rare cases

`SKILL.md` beside this file is the ritual. Each section here is the full text for ONE case, and
`SKILL.md` names it in a single trigger line (marked **→**). Read a section only when its trigger
fires; each one stands on its own.

## Ignored-tree

The emitter's `ignored-tree claims:` line (ADR 0077) rides the trailer after `hooks:`. Quote the
line in the close record exactly as printed, whichever form it takes:

- **A claim list** — a declared group whose `match` also claims paths the repo's COMMITTED
  `.gitignore` files exclude, named with the deciding rule (`source:line`). There the `ungrouped:`
  backstop is blind: a force-added output file is gated as an ordinary member of the group, never
  flagged. Report-only: narrow the match or add a lookahead in `.harness.json` in this slice, or
  say plainly why the overlap stays.
- **`none — N … checked`** — the clean verdict.
- **`none checked`** — no gitignored path exists in this checkout, so nothing was tested. Run the
  emitter again after a build or an eval before you read it as clean.
- **`NOT CHECKED — git … failed`** — a failure, never a pass. Treat it like `scope: FAILED`: fix
  it, re-run, and do not proceed on it.
- **An `… did not re-confirm` tail** — the tree or a `.gitignore` changed between the emitter's two
  git calls. Re-run.
- **No line at all** — the line rides the trailer, so an EMPTY per-slice scope prints no trailer and
  no report (the same as `hooks:`). Audit a clean tree with `--all`.

## Shards

Sharding buys recall, not time (ADR 0070, ADR 0090):

- ADR 0070 measured it on a 5-file scope. With the other two scope habits the finders finished in 2
  requests each and the rest of their time was output generation. Sharding then cut no time and
  cost +69% tokens, because more finders produce more raw findings and more skeptic legs.
- ADR 0090 records 5 full-tier sharded runs against 18 unsharded ones, over different scopes (not a
  paired comparison): $6.73 against $2.45 per run, 570 s against 412 s, 10.4 against 6.1 confirmed
  findings, precision 0.69 against 0.87 (the one small-tier sharded run: $1.99, 283 s, 8 confirmed,
  precision 1.00 — one run, not a rate). The extra confirmed findings are the reason to shard a
  dense or critical scope. The price is the reason not to shard anything else.
- Count only the files that stay in `files` after the stage-2 exclusions. An excluded file costs
  no finder anything, so it must not buy a shard.
- `shards: 'auto'` makes `min(4, ceil(files/4))` shards, cut along the order of `files`. That is
  why coupled files sit next to each other.
- When the coupling is known, pass explicit groups instead: `shards: [[…], […]]`. The groups must
  be an exact partition of `files`; a missing, extra or duplicated file throws and is named.
- `shards` on a string scope throws. It is never a silent unsharded run.
- The ~10-requests trigger is about time: finders that make many round-trips are waiting, not
  generating, and a shard gives each one fewer files to wait on.

## Ultracode

`ultracode: true` lifts every model and effort pin in the review (ADR 0084). The canary, the
finders, the dedupe grouping (when it runs) and the skeptics all run on the session model at ONE
explicit effort:

- Pass `effort: '<the session's level>'` when you know it. The default is `xhigh`, the level
  ultracode itself sends. Under a keyword-only opt-in that can be above the session's own level.
- `effort` without `ultracode: true` throws. In the pinned mode each stage's effort is fixed.
- The result's `stats.worker_pins` names the mode. Record it in the close record.
- Stage 2's fix-check legs follow the same rule. They run on `general-purpose` instead of
  `ywr-harness:worker`, because `general-purpose` inherits the session model and effort and the
  Agent tool has no effort parameter.
- The signal is the host's, not the word. The host says ultracode is on for the session, or it
  confirms the prompt's `ultracode` keyword opt-in. A bare mention of the word is not the opt-in.
  A missed flag degrades to the pinned mode, which is safe.

## Rebase

A rebase or merge after the review re-arms it only over the overlap (ADR 0072). This applies when
the slice is rebased onto, or merges, a base that other commits advanced after the review ran.

1. Re-run stage 1 over the rebased tree. Always do this: the tree is new, and the gates are cheap.
2. Compute the overlap with the merge-base from before and after the rebase:

   ```
   git diff --name-only <old-base> <new-base> -- <every file in the reviewed scope>
   ```

3. **Empty output and no hand-resolved conflict** → the review stands. Record
   `review basis: reviewed at <sha>, rebased onto <sha>, overlap: none` in the close record, with
   the command quoted.
4. **Any listed file, or any file whose conflict was resolved by hand** → run ONE review over
   exactly those files. This includes a hand-resolved file outside the reviewed scope, because
   resolved conflict text is code nobody reviewed. Use the stage-2 scope object, with a `context`
   that names the incoming range, and take the tier from the emitter run over that scope. That
   review becomes the slice's review. Its fix diffs close under the stage-2 rule, and a later
   rebase applies this section again.

The overlap is file-level on purpose. A foreign change to an unrelated function in a reviewed file
re-arms the review too. That is the cheaper error.
