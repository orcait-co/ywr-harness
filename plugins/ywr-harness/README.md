# YWR Labs Harness (plugin)

Portable Claude Code platform guards plus the adversarial code-review standard. Everything here
is coupled to Claude Code's own hook payloads and runtime behavior — not to any repo's tech
stack, directory layout, or conventions. That is why it ships as a plugin: the knowledge is
identical in every repo, so it should be maintained in one place and consumed, not re-derived.

Defects in anything here are fixed **in this repo**, never patched in a consuming repo — see
`docs/adr/0010-harness-defects-fixed-in-canon.md`. The sanctioned escape hatch for urgency is
`claude plugin disable`, which is reversible and visible; a local fork is neither.

## Everything here is namespaced

Plugin components resolve as `ywr-harness:<name>`. A bare name does not resolve:

```
/ywr-harness:verify   /ywr-harness:slice-close   /ywr-harness:harness-init   /ywr-harness:feedback   /ywr-harness:artifact-publish
Workflow({name: 'ywr-harness:adversarial-review', args: {...}})
```

This is enforced — `manifest-gate.ps1` fails on a shipped instruction that names a component
bare, in either the `Workflow({name: ...})` or the backticked-slash form. The gate exists because
a live session found exactly that defect in shipped text while every selftest passed: the suite
calls the scripts directly and never goes through the host's component registry.

## Platform guards (hooks)

| Hook | Event | Contract |
|---|---|---|
| `config-change-audit.ps1` | `ConfigChange` | Visibility only. Surfaces mid-session permission/hook self-modification. Never blocks. |
| `directory-added-guard.ps1` | `DirectoryAdded` | Visibility only by construction — the event carries no decision control and fires after the permission refresh. Speaks only when the added directory actually contributes loadable surfaces (`.claude/skills`, `.claude/agents`) or parses one of the two settings keys it can contribute; silence on a bare directory is correct behavior, not a missed hook. |
| `session-start-githooks-nudge.ps1` | `SessionStart` | Suggest-only (ADR 0029). Speaks exactly when the work tree carries `.githooks/` and this clone's `core.hooksPath` is unset — the state where no git hook runs and nothing else says so until slice close or CI. Names the one-line fix; never sets it. A wired clone, a repo without `.githooks/`, and a deliberate foreign `hooksPath` are all silent. |
| `session-start-scaffold-refresh-nudge.ps1` | `SessionStart` | Suggest-only (ADR 0033). Speaks exactly when the work tree carries a ywr-harness scaffold whose TOOLCHAIN placements differ from the installed plugin's templates — the stale-vendor state ADR 0014 recorded as undetected. Byte comparison, EOL-insensitive (the seed `.gitattributes` makes CRLF/LF checkout variance legitimate); the placement map is AST-extracted from `init.ps1` itself, so no second copy exists to drift. Names the count, the files (capped list, cap stated), and the remedy; writes nothing. Seeds are never compared; a marker-less `post-commit` is skipped exactly as the scaffold refuses it. The advice is DIRECTION-AWARE (ADR 0042) via the repo's `.harness-version` stamp (written by `harness-init` on every successful run): repo ahead of this install → update the plugin, `harness-init` forbidden; repo behind → refresh, direction stated as measured; same version → hand-edit named; no readable stamp → the direction-blind caveat on the human banner AND the model context (a canon working tree mid-slice, or a multi-writer repo refreshed by a newer plugin, is *newer* than the installed copy and a re-run would revert it). When the running copy is itself a superseded cache install (a session that outlived a plugin update — ADR 0039), the advice flips: same file list, but the basis is named STALE, `/reload-plugins` (or a restart) is instructed, and `harness-init` is forbidden from that session — the loaded skill would place the old templates. The registry probe is best-effort; any failure returns the normal nudge. |
| `session-start-version-announce.ps1` | `SessionStart` | Announce-once-per-version (ADR 0030). At the first session that loads a new plugin version it says so once — old → new, up to three bullets from `CHANGELOG.md` (the member release-notes canon, Korean), and the onboarding artifact's release-notes tab — then records the version in `~/.claude/ywr-harness/announced-version`, the plugin's only user-scope write. A machine's very first run gets a one-time link-only welcome instead (ADR 0031) — "업데이트됨" is claimed only when a previous version was recorded. Steady state and downgrades are silent; `manifest-gate.ps1` refuses a release whose top CHANGELOG entry does not match `plugin.json`. |
| `subagent-telemetry.ps1` | `SubagentStop` | Appends a per-agent JSONL ledger to `<project>/.claude/telemetry/`. Fail-open. |

## Adversarial review (workflow)

`workflows/adversarial-review.js` — lens finders → semantic dedupe → severity-gated skeptic
verification. Invoke it as a workflow, or by name from the skill listing (a workflow's
`meta.whenToUse` is what surfaces there; there is no separate skill file).

```
Workflow({ name: 'ywr-harness:adversarial-review', args: { scope: '<files + house invariants + passed gates>' } })
```

Lens defaults are deliberately repo-agnostic. Two knobs keep them that way:

| arg | Effect |
|---|---|
| `lensExtra` | A house-specific angle appended to **every** lens prompt. Use this for repo vocabulary — how tenancy isolation is implemented, naming rules, a particular determinism boundary. |
| `lenses` | Full override, `[{key, prompt}]`. An array with no valid entry throws: zero lenses is not a review. |

Prefer `lensExtra`. Redefining the lens set to add one angle means later improvements to the
canonical defaults never reach that repo — the same outcome as a local fork.

`root` is optional. When omitted the "repo root" line is dropped from the prompts entirely and
agents use the session's working directory; baking one repo's absolute path in as a default
would be knowledge that is false everywhere else.

`REVIEW.md` ships alongside it as the review-invariants canon the scope block should cite.

## Local execution layer (git hooks)

`/ywr-harness:harness-init` places two hooks into a consuming repo and wires `core.hooksPath`
**conditionally** — set when unset, left alone when already `.githooks`, refused when it points
anywhere else (ADR 0015).

| Hook | Scope | Contract |
|---|---|---|
| `.githooks/pre-commit` | staged files | Runs the emitter's **file-scoped** gates. Whole-program gates (tests, typecheck) are deferred to CI and the deferral is reported. A failing gate blocks the commit. |
| `.githooks/pre-push` | added lines of the pushed range | Regex secret scan. Pre-existing secrets outside the range are not re-flagged; a false positive is exempted per line with `harness:allow-secret`. |
| `.githooks/post-commit` | the commit just made | Slice retro gate (ADR 0017) — seven deterministic docs-drift checks, zero tokens, silent when clean. Advisory: it never blocks. |

`post-commit` is placed under a third mode, **GUARDED**: written when absent, refreshed when the
existing file carries the `ywr-harness:post-commit` marker, **refused** otherwise. It is the one
hook filename repos commonly already use — this repo's own `post-commit` republishes the docs
artifact — so TOOLCHAIN would destroy working automation while SEED would silently deny the retro
to every repo that has one.

The retro's checks (DEP · MIGRATION · SPEC · BUILD · FEAT · UNMAPPED · DEADMAP) read their scope
from the `retro` block in `.harness.json`. **An empty list disables the checks it drives, and
`--coverage` says so** — silence must mean clean, never "not configured".

```
python scripts/harness/harness_retro.py main~3..HEAD   # whole slice — absorbs mid-slice splits
python scripts/harness/harness_retro.py --coverage     # unowned files + dead implements_in
SLICE_RETRO=0 git commit ...                           # skip once
```

`core.hooksPath` lives in `.git/config`, which is per-clone and never committed — so the scaffold
wires exactly the machine it ran on. That gap is closed by reporting, not by wiring harder:
`harness_gates.py` prints a `hooks:` line on every `/ywr-harness:slice-close` and CI run, so an
unwired clone can never look identical to a wired one.

The emitter also checks any **declared claude.ai Artifact** (ADR 0032): the `artifacts` section
of `.harness.json` names each url and title, and the emitter verifies the README carries the
link and the title starts with the repo name (convention `<repo> · <purpose>`). The emitter only
reports (`artifact: ok | VIOLATION | none declared`); the vendored CI is the enforcement point —
it fails on `artifact: VIOLATION`. The gate cannot see claude.ai, so an undeclared Artifact is
unchecked, and that state is reported rather than silent.

Both hooks degrade the way everything else here does. A missing `python`, `awk`, or emitter is a
**reported skip, never a silent pass** — an unparsed emitter would otherwise read as "no gates
matched", which is the hardest kind of gate failure to notice.

## Status line (user scope)

```
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/statusline/install.ps1"     # add -DryRun to preview
```

Renders `location · model · effort · ctx N%/SIZE · 5h N% · 7d N% · ywr-harness vX.Y.Z`, dropping
the model's `(1M context)` suffix — a session constant costing width on every render — in favour
of how much of that window is actually gone.

The trailing segment is the plugin version **installed on this machine**, read from Claude Code's
install registry (`~/.claude/plugins/installed_plugins.json`). It is deliberately the *on-disk*
value, never the repo's or the marketplace's: with marketplace auto-update on (ADR 0026), disk
moves ahead of a live session, and that visible mismatch is the "restart to apply" signal. A
machine without the plugin installed renders no segment. The org-guide version segment this
replaces is retired (ADR 0027) — guide drift detection is spec 0003 §7's job, where it always
really lived.

**A plugin cannot contribute the main status line**: a plugin's `settings.json` supports only
`agent` and `subagentStatusLine`. So this ships as canon plus an installer that writes the user's
own `~/.claude/` (ADR 0016). Run it once per machine; it is not applied automatically, and nothing
detects a machine that never ran it.

The installer separates its two effects because they carry different risk. The script is TOOLCHAIN,
overwritten on every run. The `statusLine` setting follows ADR 0015's rule — written when absent,
left alone when already ours, **refused** when it points anywhere else. `settings.json` is parsed
and re-emitted so unrelated keys survive; a file that does not parse is a hard refusal that prints
the snippet to add by hand.

A key the payload does not carry **removes its segment** — never `0%`. Unmeasured and zero are
different states, and rate-limit keys are legitimately absent on a session's first render, before
the first API response. Context and quota use different threshold curves: 50% context is ordinary
working state, 50% of a rate limit is already worth watching.

## Upstream feedback (skill)

`/ywr-harness:feedback <description>` — send a defect or request to the canon (ADR 0064). The canon
repo is private, so the report is filed as an issue on the PUBLIC dist repo `orcait-co/ywr-harness`
with label `upstream-report`, which the canon's session start lists. The skill drafts the body
(running + registered plugin versions, `claude --version`, OS, `owner/repo` + `.harness-version`,
the refresh nudge's verdict and `init.ps1 -DryRun` output quoted verbatim, `git log --oneline -3`
of every file a re-run would change, a dedupe fingerprint), shows it, and files it only after ONE
confirmation — the reviewed file is what gets filed. It never includes file contents or diffs
(the tracker is public; the canon asks in-thread), never runs `harness-init`, and without `gh`
keeps the body and prints the by-hand URL (`NOT FILED`, exit 2).

## Artifact publish (skill)

`/ywr-harness:artifact-publish` — republish a declared claude.ai Artifact safely (ADR 0068). A
repo that commits a GENERATED Artifact source declares `source` + `check` on its
`artifacts.items[]` entry; the emitter enforces that the source exists and rides the drift check
through CI, and this skill closes the loop: list the declared items, run each check, ONE
confirmation, then the Artifact-tool publish with the enforced read-before-republish sequence
and a byte-level lockstep proof against the committed file. Never headless (headless sessions
have no Artifact tool — measured), never from a hook, never past a VIOLATION or a failed check;
an ownership refusal is reported, not worked around.

## Apply-now update (skill)

`/ywr-harness:update` — for the member who does not want to wait for the background auto-update
(ADR 0026 converges every machine by its next session start). It reads the plugin's marketplace
and version from `claude plugin list`, runs the two CLI commands (`claude plugin marketplace
update`, then `claude plugin update`), reports the on-disk old → new, and hands off the two
steps no skill can perform: `/reload-plugins` (a REPL built-in — the remedy for the update CLI's
own "restart required to apply"), and `/ywr-harness:harness-init` *only when* the ADR 0033 nudge
reports drifted toolchain files.
It never runs the scaffold refresh itself — the byte comparison alone cannot prove direction
(the `.harness-version` stamp orients the nudge's advice since ADR 0042, but a stampless repo
stays ambiguous), and an automatic re-run could revert a working tree deliberately newer than
the installed plugin (ADR 0034).

## CI-invoked assets

`scripts/workflow-gates.mjs` (parse + behavioral gate over a workflow corpus; `--dir` selects
the corpus, default `.claude/workflows`) and `scripts/resolve-base.sh` (CI diff-range base
resolution — since ADR 0043 vendored by the scaffold as `scripts/harness/resolve-base.sh` and
invoked by the vendored workflow to resolve the PR base once, `MODE=blocking`).
`lib/selftest-lib.ps1` is the shared assertion core the selftests dot-source — dot-source it,
do not run it.

## Prerequisites

- `pwsh` (PowerShell 7+) on `PATH` — every hook is a `.ps1`, invoked in exec form.
- `node` — for `scripts/workflow-gates.mjs` and the workflow corpus gate. Absent `node` is a
  reported skip locally and a hard failure on CI, where the gate must actually run.
- `python` 3.9+ (stdlib only) — every gate script under `scripts/` requires it:
  `harness_gates.py` (invoked by the `pre-commit` hook), `harness_retro.py` (by the
  `post-commit` hook), and `verify_map.py` (by `ywr-harness:verify`).

Hooks run wherever the session runs; the gates and selftests are also exercised on Linux pwsh,
so nothing here may assume Windows.

## Gates

`selftest.ps1` is the single entry point — the manifest/wiring gate, the workflow corpus gate,
then every shipped PowerShell selftest:

```
pwsh -NoProfile -File ./selftest.ps1
```

`manifest-gate.ps1` is deterministic and CLI-free. It fails on the defects with distribution
blast radius: `version` missing (omitted `version` falls back to the git commit SHA, so every
commit ships as a new version to every consumer), a hook path that does not resolve, a
regression from exec form to shell form where a path placeholder is used, and a release-notes
canon that lies (top `CHANGELOG.md` entry ≠ `plugin.json` version, or the artifact link
diverging between the CHANGELOG and the announce hook — ADR 0030).
`manifest-gate.selftest.ps1` proves it can fail — seventeen mutations plus an unmutated control,
because a suite that only ever passes and a gate that fails on everything score identically
without the control. The control has earned its place: it caught a broken identity gate while
the negative suite was reporting every mutation caught.

`claude plugin validate --strict` is the richer manifest check but needs the CLI installed, so
it stays a local pre-commit habit rather than a CI step.

Fixtures live under the OS temp directory with exception-safe teardown — the runner never
writes into the host repository, and it runs unchanged against a read-only mount. An empty
discovery set exits 1, and a skipped gate is reported as skipped rather than folded into the
pass count: both would otherwise be a gate judged from the wrong observable.

CI (`.github/workflows/plugin.yml`) runs the same entry point on `ubuntu-latest` and
`windows-latest` for any change under `plugins/**`. Both matter: hooks run on member machines
(Windows) while a consuming repo's gates run on Linux, and the same `.ps1` serves both.

A consuming repo's CI cannot reach these scripts through the plugin — `${CLAUDE_PLUGIN_ROOT}`
is substituted when Claude Code spawns a hook, not in an arbitrary CI step. So the scaffold
**vendors** them instead (ADR 0014): `/ywr-harness:harness-init` copies `scripts/harness/*.py`
and `.github/workflows/harness-gates.yml` into the consumer, and `manifest-gate.ps1` enforces
byte identity between the two copies so a fix here cannot silently fail to reach them. A
reusable workflow (`on: workflow_call`) was rejected — it needs cross-repo Actions access
widened from `none` to `organization`, which opens every workflow in this repo to the whole org.

### Declared coverage debt

The gate prints `coverage: shipped=N with-selftest=N uncovered=N` on every run and names the
uncovered files. Nothing is excluded from that count but the selftests themselves — excluding
the runner, the gate, or the shared lib would narrow the population without saying so, which
is how a partial count comes to read as full coverage.

Currently uncovered: `selftest-lib.ps1` (its selftest exists in `ywr-platform` and has not been
ported), `harness_config.py` (exercised only through its two consumers), plus `selftest.ps1`
itself, the runner. `resolve-base.sh` left this list with ADR 0043 — its selftest is ported
hermetic (fixture repos, all ten cases deterministic on every platform).

The count reads `template-payload-excluded=N` separately for files under `templates/` — payload
this plugin copies rather than runs, which cannot have a selftest here. Two of them are the
exception: `.githooks/pre-commit` and `.githooks/pre-push` are the only shipped artifacts that
can block a commit or a push, so `githooks.selftest.ps1` runs them for real, in throwaway git
repositories, against real staged changes and real commit ranges. They stay in the excluded
count — it is a placement-based rule, not a claim that nothing tests them.

## Installing this alongside an existing harness

Hook deduplication is by command string (`hooks.md`), and a plugin's path placeholder is
`${CLAUDE_PLUGIN_ROOT}` while a repo's is `${CLAUDE_PROJECT_DIR}` — the strings can never
match, so **nothing is deduplicated**. A repo that already registers these hooks in
`.claude/settings.json` will fire both copies. Consequences are not uniform:

- Visibility hooks emit duplicate banners (noise).
- `subagent-telemetry` appends **two ledger lines per event**, silently doubling every count
  derived from it.
- Permission-decision hooks are safe by precedence (`deny > defer > ask > allow`), so a
  duplicated guard cannot be weakened.

This plugin **replaces** those registrations. Remove the repo's own hook block when installing.
Hooks registered for *other* events, or for the same event with a different purpose, coexist
correctly — all matching hooks run in parallel.
