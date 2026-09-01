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
regenerate with the repo's own regeneration command (the check script's `--write` mode or
whatever the repo documents), commit, and re-invoke. Never publish a drifted source, and never
regenerate on your own initiative — the regeneration is a tree change the member commits.

## 3. ONE confirmation

Show the member what will be published — for each item: the title, the target URL, the source
path, and the check result (passed / not declared). Ask ONE question: publish / stop. Nothing
has left the machine yet. On stop, print what remains so the member can come back.

## 4. Publish, with the enforced read sequence

For each confirmed item, publish `source` to its declared `url` with the Artifact tool. The
tool REFUSES the first publish to an existing URL and saves the served page to a local file —
that is the contract, not an error (ywr-harness fact 43). The sequence that works:

1. `Artifact publish` (refused; the served copy lands in a file).
2. Hash that saved file against the last committed state of the page BEFORE reading anything —
   this proves nothing on the live page is being lost.
3. Read the saved file in full, then `Artifact` `action: read` of the URL, then publish again
   (succeeds). Keep the favicon; label per the repo's convention (e.g. `v<version>-rn`).
4. Do not fight a refusal with `force`, and do not read the served copy into context for the
   comparison — the hash is the proof (fact 38).

A publish refused for OWNERSHIP is final for this machine: only the account that owns the URL
can redeploy it. Report which account owns it and stop — never work around it.

## 5. Lockstep proof

After publishing, prove served == committed by byte comparison: `Artifact read` saves the
served HTML; strip the frame-runtime head through `<body>\n` and the trailing `</body></html>`,
hash both sides, compare with the committed source file. State the hashes in the close. This is
the release-checklist item the gate layer cannot perform (it cannot see claude.ai — ADR 0032).

## What this skill never does

Publish without the confirmation · publish past a VIOLATION or a failed check · regenerate or
commit tree changes on its own · run headless or from a hook · use `force` on a refusal ·
retry an ownership refusal.
