---
name: artifact-publish
description: Republish this repo's declared claude.ai Artifacts safely. Lists every artifacts.items[] entry from .harness.json (url · title · committed source · drift check), runs each declared check, and after ONE confirmation performs the Artifact-tool publish with the enforced read-before-republish sequence and a byte-level lockstep proof against the committed source. Use after regenerating a committed Artifact source (onboarding guide, docs page, customer page) or at a release step that says the Artifact is next.
disable-model-invocation: true
---

# artifact-publish — verify a declared Artifact source, then publish it, once confirmed

A repo that commits a GENERATED Artifact source declares it in `.harness.json` under
`artifacts.items[]` with `source` (the committed file) and `check` (its drift gate) — ADR 0068.
This skill is the publish half: the harness can enforce that the source exists and matches its
generator, but the publish itself is an interactive, owner-account act — headless sessions have
no Artifact tool (measured, ywr-harness ADR 0063), so it is never automated and never runs from
a hook.

Invoke: `/ywr-harness:artifact-publish`. One confirmation before anything leaves the machine.

## 1. List what is declared

Run the emitter and read its `artifact:` lines (the vendored copy is the repo's own):

```
python scripts/harness/harness_gates.py --all
```

- `artifact: ok — … · source <path> committed · check declared …` — a publishable item.
- `artifact: VIOLATION — …` — fix the declaration or the tree FIRST; never publish past a
  violation (a missing source or a refused check means the page you would publish is not the
  page the repo asserts).
- `none declared` — nothing to publish; a repo declares its Artifact before this skill applies
  (first publish happens by hand, THEN the declaration — ADR 0032's contract).
- An ok line ending `no check declared — drift … is unenforced` may still be published, but say
  so in the confirmation: nothing proved the committed page matches its generator.
- An ok line ending `no source declared — hand-published page (ADR 0032 shape); not publishable
  via /ywr-harness:artifact-publish` — a url+title-only declaration: the page was published by
  hand and no committed source exists to republish from. OUT of this skill's scope; republishing
  it is a hand act from the owning account. When EVERY declared item has this shape, report
  exactly that and stop — nothing publishable is this skill's intended terminal state, not a
  failure.

## 2. Run every declared check

The check commands are printed inside the emitter's `gates:` window under the `[artifacts]`
header. **A check is repo-committed code**: the harness validated the path shape, not what the
script does (ywr-harness ADR 0024/0068) — it is trusted exactly as far as this repo's code is.
In the member's own repo, where every change went through review, run each command exactly as
printed. On a repo the member does not control or has just cloned, read the check script first,
like any code about to run on their machine — and its contract ("default mode is a drift check
that writes nothing") is that contract, not a verified property.

Exit 0 = the committed source matches its generator. Exit 1 = DRIFT: stop, tell the member to
regenerate with the repo's own regeneration command (whatever the repo documents — `pwsh
docs/build.ps1` for the docs surfaces; a check script has no write mode by contract, the
generator does), commit, and re-invoke. Exit 2 = REFUSED: misuse, or a corpus/declaration the
generator itself refuses — regeneration will not help; fix the cause the check names, then
re-invoke. Never publish a drifted source, and never
regenerate on your own initiative — the regeneration is a tree change the member commits.

## 3. ONE confirmation

Show the member what will be published — for each item: the title, the target URL, the source
path, and the check result (passed / not declared). Ask ONE question: publish / stop. Nothing
has left the machine yet. On stop, print what remains so the member can come back.

## 4. Publish, with the enforced read sequence

For each confirmed item, publish `source` to its declared `url` with the Artifact tool. The
tool's precondition is that THIS conversation has fetched the live version (`action: read` of
the URL) or published it before; a publish without it is REFUSED and the served page lands in a
local file the tool then demands be Read line by line — that is the contract, not an error
(ywr-harness fact 43). Two HASH proofs bracket the publish, both over a file the tool saves
(`action: read_file`, `path: "index.html"` — the page itself; the result names the saved path,
its byte count and its sha256). A proof never READS the page (fact 38): above the tool's
small-file band that call is ONE result line in context (measured at 131–134 KB, 2026-09-14);
for a SMALL page the tool's contract also echoes the file's text in the result — the proof is
still the hash over the saved file, and the echo costs the page's own size, never more than the
`action: read` it replaces. The precondition read (step 2) is the one read the sequence pays by
design. The sequence:

1. **Nothing-lost proof, before anything else**: `Artifact action: read_file` with the item's
   `url` and `path: "index.html"`. Strip the wrapper (step 5's rule) and find the served body
   in the source's COMMITTED HISTORY: `git log --format=%h -- <source>` lists every state the
   repo has had (`--follow` if the source was ever renamed); hash each (`git show <sha>:<source>`,
   newest first — the first match is enough) and the body must equal one of them
   (allowing the one trailing LF). A match names the commit whose state is live — say which in
   the close; in a repo that tags releases it is normally the previous tag's copy, but the
   search decides, never the tag and never a fixed "N commits back" guess (a source regenerated
   twice between publishes is the ordinary case, and only the search tells which state went
   live). No match anywhere in the history is a hand edit or a publish from another tree: stop
   and report it — publishing over it is the member's decision, not a step.
2. `Artifact action: read` of the `url` — the precondition, paid once (the page enters context;
   ~45k tokens at 131 KB — the pre-publish page of the 2026-09-14 trial; post-publish it was
   134 KB). `read_file` does NOT satisfy it: with a `read_file` copy already saved, the publish
   was refused twice until this call ran.
3. `Artifact publish` of `source` to `url`, immediately after. Keep the favicon; label per the
   repo's convention (e.g. `v<version>-rn`). If the tool still refuses and hands over a saved
   copy with a line-complete Read demand, Read it in the slices below and publish again — step
   2's `action: read` stands (the precondition is per conversation), so do NOT repeat it for
   that; only if the second publish is refused too, naming a fetch of the URL, run `action:
   read` once more and publish — that is the measured 2026-09-14 order (publish → refusal →
   Read → `action: read` → publish), it ended in a success, and there is no fourth shape.
   Whether step 2 placed first removes the refusal is UNMEASURED at this version: record the
   outcome of the first republish under it in the close, and fold it into this step.
4. Do not fight a refusal with `force`, and do not read the served copy into context for a
   comparison — the hash is the proof (fact 38).

The refusal has two shapes, both normal. For a small page the tool demands a line-complete Read
of the saved copy before the next publish — size the slices to the per-call TOKEN cap, not to
a line count: denser lines need smaller slices (measured once, 2026-09-07, on a ~2,000-line
page: 250-line reads exceeded the cap past the middle of the file, ~125-line slices did not).
For a large page (megabytes) the saved copy counts as viewed and no Read is demanded. Neither
is an error; step 1's hash is what proves nothing is lost either way — the refusal's saved copy
is never needed for a proof.

A publish refused for OWNERSHIP is final for this machine: only the account that owns the URL
can redeploy it. Report which account owns it and stop — never work around it.

## 5. Lockstep proof

After publishing, prove served == committed by byte comparison: `Artifact action: read_file`
(`path: "index.html"`) again — the saved copy on disk, the result as in §4 (one line above the
tool's small-file band, a small page's text echoed too); never `action: read` here (it reads the
whole page into context by design, fact 38). Strip the frame-runtime head through
`<body>\n` and the trailing `</body></html>`, hash the remainder, compare with the committed
source file. **The serve wrapper appends ONE trailing LF before `</body></html>`** (measured
2026-09-01, pre- and post-publish; earlier serves lacked it) — treat served-stripped ==
committed + one trailing LF as identical. A raw hash mismatch of exactly that one-byte shape is
lockstep, not drift; anything else is drift. In bytes, with `s` the saved copy and `c` the
committed file: `body = s[s.index(b'<body>\n') + 7 : s.rindex(b'</body></html>')]`, lockstep iff
`body == c or body == c + b'\n'`. State both hashes in the close. This is the release-checklist
item the gate layer cannot perform (it cannot see claude.ai — ADR 0032).

Measured 2026-09-14 (v0.49.0 republish, a 134 KB page): the head through `<body>\n` was 355
bytes and served == head + committed + LF + `</body></html>` byte for byte. This `read_file`
replaced the lockstep page read (~45k tokens at that size) with one result line, and step 1's
`read_file` freed the nothing-lost proof from the refusal's saved copy, so it stands even when
no refusal happens. Per republish the served page entered context twice instead of three times
(~140k → ~95k tokens at 134 KB — a smaller page saves proportionally less, and below the tool's
small-file band the echo makes the proofs cost the page size again); with step 2 placed first
and no refusal, once.

## What this skill never does

Publish without the confirmation · publish past a VIOLATION or a failed check · regenerate or
commit tree changes on its own · run headless or from a hook · use `force` on a refusal ·
retry an ownership refusal.
