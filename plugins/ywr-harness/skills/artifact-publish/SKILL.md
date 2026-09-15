---
name: artifact-publish
description: Republish this repo's declared claude.ai Artifacts safely — and only when needed. Lists every artifacts.items[] entry from .harness.json (url · title · committed source · drift check), runs each declared check, shows the LIVE state (the served body hashed against the source's committed history — one tool result line, no page read; already live = stop), and after ONE confirmation performs the Artifact-tool publish with the measured read-before-republish sequence and a byte-level lockstep proof against the committed source. Use after regenerating a committed Artifact source (onboarding guide, docs page, customer page) or at a release step whose verdict says the Artifact is next.
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

## 3. Live state first, then ONE confirmation

Before asking anything, learn what is live — one tool result line, no page read: `Artifact
action: read_file` with the item's `url` and `path: "index.html"` saves the served page to the
scratchpad and names the saved path, its byte count and its sha256 (above the tool's small-file
band; for a small page the tool's contract echoes the file's text too — the proof is the hash over
the saved file either way, and the echo costs the page's own size). Strip the wrapper (§5's rule)
and find the served body in the source's COMMITTED HISTORY: `git log --format=%h -- <source>`
lists every state the repo has had (`--follow` if the source was ever renamed); hash each
(`git show <sha>:<source>`, newest first — the first match is enough), allowing the one trailing
LF. The search decides — never a tag, never a fixed "N commits back" guess (a source regenerated
twice between publishes is the ordinary case, and only the search tells which state went live).

- Body == the committed source at HEAD → the page is **already live**: nothing to publish. Report
  the commit and stop — no confirmation, no precondition read. This is "only when needed" for
  every repo, and it costs one result line.
- Body == an older committed state → that commit is live (name it; in a repo that tags releases,
  its version). The publish would move the page from there to HEAD, and nothing on the live page
  is lost.
- No match anywhere in the history → a hand edit or a publish from another tree. Stop and report;
  publishing over it is the member's decision, not a step.

A repo may have its own reason to decline even when the page differs. ywr-harness's onboarding
page changes at EVERY release by construction (release notes + version strings), so its release
script prints whether the release REQUIRES a republish — the guide template changed — and a
CHANGELOG-only release does not (ywr-harness ADR 0078); the live-state line above verifies that
verdict's assumption (the release it names is what is live).

Then show the member, per item: the title, the target URL, the source path, the check result
(passed / not declared), and live → new (the two commits). Ask ONE question: publish / stop.
Nothing has left the machine yet. On stop, print what remains so the member can come back.

## 4. Publish, with the enforced read sequence

For each confirmed item, publish `source` to its declared `url` with the Artifact tool. The
tool's precondition is that THIS conversation has fetched the live version — and it is
ORDER-SENSITIVE: the fetch counts only AFTER a refusal has handed over the served copy and that
copy has been Read (ywr-harness fact 43; measured on the v0.40.0, v0.49.0 and v0.50.0 releases —
the last one placed `action: read` before the first publish, and it counted for nothing: the
refusals came anyway, +45k tokens). `read_file` never satisfies it (measured). The sequence,
exactly as measured:

1. `Artifact publish` of `source` to `url`. It is REFUSED — the contract, not an error: the tool
   saves the served page to a local file and demands it be Read line by line. Keep the favicon;
   label per the repo's convention (e.g. `v<version>-rn`).
2. Read that saved file line-complete. Size the slices to the per-call TOKEN cap, not to a line
   count — denser lines need smaller slices (measured 2026-09-07 on a ~2,000-line page: 250-line
   reads exceeded the cap past the middle of the file, ~125-line slices did not). ~50k tokens at
   136 KB.
3. `Artifact publish` again. It is REFUSED again, naming the fetch ("identical content already
   refused … fetch the artifact's URL again — re-Reading a file an earlier refusal handed you
   does not count"). The call costs a short result and stays in the sequence: both measured runs
   had it, and whether the tool accepts the fetch without it is unmeasured — leaving it out risks
   a second fetch (~45k), keeping it risks nothing.
4. `Artifact action: read` of the `url` — the fetch AFTER the refusal (~45k tokens at 136 KB; the
   page enters context). Once per conversation.
5. `Artifact publish` — succeeds (the result names the new Version).

For a large page (megabytes) the saved copy counts as viewed and step 2 is not demanded. Never
fight a refusal with `force`, and never read the served copy into context for a comparison — the
hash is the proof (fact 38); §3's `read_file` is what proves nothing is lost, so the refusal's
saved copy is never needed for a proof. Budget ≈95k tokens of served page per republish at 136 KB
(steps 2 and 4); a smaller page costs proportionally less.

A publish refused for OWNERSHIP is final for this machine: only the account that owns the URL
can redeploy it. Report which account owns it and stop — never work around it.

## 5. Lockstep proof

After publishing, prove served == committed by byte comparison: `Artifact action: read_file`
(`path: "index.html"`) again — the saved copy on disk, the result as in §3 (one line above the
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

The wrapper is the Artifact HOST's skeleton, not the repo's: the tool wraps every published file in
the same doctype/head/body frame (its own contract), so the slice points above are the same for
every repo's page — but they were MEASURED on ywr-harness's page (2026-09-01 and 2026-09-14), and a
host change would move them. If `<body>\n` or the closing pair is not found, or the body matches
neither form, print the first ~400 and last ~40 bytes of the saved copy, adapt the slice points to
what the host now serves, and record the new shape in the close — an unrecognised wrapper is a host
change to report, never drift to declare.

Measured 2026-09-14 (v0.49.0 and v0.50.0 republishes, 134–136 KB pages): the head through
`<body>\n` was 355 bytes and served == head + committed + LF + `</body></html>` byte for byte.
The two `read_file` proofs are one result line each at that size (below the tool's small-file
band the echo makes them cost the page size again); the served page enters context twice per
republish (§4 steps 2 and 4, ≈95k tokens at 136 KB) and not at all when §3 finds the page already
live.

## What this skill never does

Publish without the confirmation · publish a page that is already live · publish past a
VIOLATION or a failed check · regenerate or commit tree changes on its own · run headless or from
a hook · use `force` on a refusal · retry an ownership refusal.
