# /ywr-harness:slice-close — reference for the rare cases

`SKILL.md` beside this file is the ritual. Each section here is the full text for ONE case, and
`SKILL.md` names it in a single trigger line (marked **→**). Read a section only when its trigger
fires; each one stands on its own.

## Ignored-tree

The emitter's `ignored-tree claims:` line (ywr-harness ADR 0077) rides the trailer after `hooks:`. Quote the
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

## Rebase

A rebase or merge after the review re-arms it only over the overlap (ywr-harness ADR 0072). This applies when
the slice is rebased onto, or merges, a base that other commits advanced after the review ran.

1. Re-run stage 1 over the rebased tree. Always do this: the tree is new, and the gates are cheap.
2. Compute the overlap with the merge-base from before and after the rebase:

   ```
   git -c core.quotepath=false diff --name-only <old-base> <new-base> -- <every file in the reviewed scope>
   ```

   Keep `core.quotepath=false`: git's default prints a non-ASCII path as a quoted octal escape,
   which names no file.

3. **Empty output and no hand-resolved conflict** → the review stands. Record
   `review basis: reviewed at <sha>, rebased onto <sha>, overlap: none` in the close record, with
   the command quoted.
4. **Any listed file, or any file whose conflict was resolved by hand** → run ONE review again over
   exactly those files. This includes a hand-resolved file outside the reviewed scope, because
   resolved conflict text is code nobody reviewed. Run the emitter over exactly those files. A `skip`
   tier needs no review. A `small` or `full` tier runs `medium` (ywr-harness ADR 0218), with the files
   as a path target: `Skill({skill: 'code-review', args: 'medium <file> <file> ...'})`. Two probes,
   recorded as ywr-harness facts 251 and 255, gave the command three files at `high` and at `medium`.
   Each reviewed each named file, whether the file was tracked, untracked or only committed, and no
   other file. Each also reported a defect in an unchanged line of a named file. Nobody probed many files, a hand-resolved conflict file or a repeat run.
   When any listed path holds a space, a quote, a backslash, a control character or a non-ASCII
   character, starts with `-`, holds only digits, names a branch or a level such as `high`, or no
   longer exists in the tree, use the stage-2 call with no target for the whole re-arm instead. git still quotes a path with a quote, a backslash or a
   control character under `core.quotepath=false`. The command
   can read such an argument as something other than a path, and nobody probed those. That call
   reviews the whole slice, so its findings can name other files too.
   A whole-file read also returns findings in code that the incoming commits did not touch, often
   graded `pre_existing`. Every finding gets a bucket under the stage-2 severity rule. Record the
   level, the item count, the usage line and the cap note of stage 2: a count at a known cap can hide the finding
   that the re-arm is for. The review becomes the slice's review. Its fix diffs close under the
   stage-2 rule, and a later rebase applies this section again.

The overlap is file-level on purpose. A foreign change to an unrelated function in a reviewed file
re-arms the review too. That is the cheaper error.

## Prepared

The stages before the close are ordinary session work (ywr-harness ADR 0105). A session may run stages
1–3 before the close runs, typed by the owner or called by the main session (ywr-harness ADR 0201), and end with a ready report: the emitter's
output and the result of every command it printed, the review's level, item count and usage line, every
finding's severity and bucket, every fix verdict, the verify verdict, and LAST the line
`harness_gates.mjs --tree` printed after the final edit.
It writes no handoff and makes no commit. Reuse needs those lines verbatim in THIS session's context.
A summary left by compaction, or a report from another session, is no report: run every stage.
The report is the session's own record, trusted as a close record is. The snapshot proves only
that the tree did not change after it.

1. Take a fresh snapshot:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/harness_gates.mjs" --tree
   ```

   `tree: FAILED` → nothing is reused; run every stage.
2. **The same line as the report** → run the emitter itself again (stage 1's first command, not
   the commands it prints). It takes seconds, and its `hooks:` and `ignored-tree claims:` lines read
   git config and ignored paths that the tree does not hold.
   - **The same output** → stages 1–3 are the report's. Quote them into the close record as
     reported and add `prepared: reused at <the tree line>`. Re-run none of the printed commands,
     the review or verify, except a gate the last paragraph below names, and go to stage 4.
   - **Only a trailer line differs** → handle that line as stage 1 says and keep the rest.
   - **The `gates:` window differs** → run stage 1's commands in full. The review and verify
     still stand on the unchanged tree.
3. **A different line** → something changed after the report. Run stages 1 and 3 in full: their
   results were for the old tree. The review stands only over what did not change. Name what did:

   ```
   git -c core.quotepath=false diff --name-only <report tree id> <fresh tree id>
   ```

   An empty list (HEAD moved, content equal) keeps the review standing. Any listed file re-arms it
   as a rebase overlap does (§Rebase step 4: ONE review, the changed files as its path target under
   that step's fallback, the tier from the emitter run over the changed files). Record
   `review basis: prepared at <report tree id>, changed since: <files | none>`.

The snapshot is the working tree in its STAGED form: tracked content plus untracked, non-ignored
files, after clean filters and eol normalization, with a submodule counted by its commit only.
Edits under assume-unchanged or skip-worktree count, because the snapshot clears those bits in its
index copy. It cannot see a byte change that staging normalizes away (a CRLF-only edit), a
submodule's uncommitted work, an ignored file (a build output), a tool version or a database. When
a gate reads one of those, run that gate again.
