// The scaffold's placement map: the one owner of which template lands where. It is DATA — no side
// effect at import, no I/O, no imports — so every reader imports it instead of copying it:
// init.mjs places by it, the SessionStart refresh nudge compares by it, manifest-gate.mjs sweeps the
// canon's own placements by it, and the gate emitter's SCAFFOLD_CLAIMS pairing case reads it.
// Two copies of one rule is how they end up disagreeing (ywr-harness ADR 0033).
//
// Every table is an ordered, frozen array of [source, destination] pairs (INTRODUCED_IN: [destination,
// version]). Order is the placement order and the order of the report lines. A reader that needs a
// lookup builds its own Map from the pairs.
//
// Placement modes, the hard split that is the whole point of the scaffold:
//   TOOLCHAIN — overwritten on every run. The builder and the rule/template documents are the canon's
//               copies; re-running is how a plugin-side improvement reaches a repo. A consuming repo
//               must not hand-edit these (ywr-harness ADR 0010): an edit is silently reverted on the
//               next run, which is the intended signal.
//   GUARDED   — place when absent, refresh when the existing file carries GUARD_MARKER, refuse and
//               report otherwise.
//   SEED      — created once, never overwritten: a repo's own decisions live in these files.
//   SEED_CORPUS — seeded only when the repo holds no decision record yet.
//   RETIRED   — no longer placed; reported when found, never deleted.

const pairs = (list) => Object.freeze(list.map((p) => Object.freeze([...p])))

// relative source under templates/  ->  relative destination under the target
export const TOOLCHAIN = pairs([
  ['docs/README.md', 'docs/README.md'],
  ['docs/adr/README.md', 'docs/adr/README.md'],
  ['docs/adr/0000-template.md', 'docs/adr/0000-template.md'],
  ['docs/spec/README.md', 'docs/spec/README.md'],
  ['docs/spec/0000-template.md', 'docs/spec/0000-template.md'],
  ['docs/build.mjs', 'docs/build.mjs'],
  ['docs/build.sh', 'docs/build.sh'],
  ['docs/build_docs.mjs', 'docs/build_docs.mjs'],
  ['docs/check_docs.mjs', 'docs/check_docs.mjs'],
  // Vendored so CI needs no access to the canon repo. `${CLAUDE_PLUGIN_ROOT}` is substituted when
  // Claude Code spawns a hook and does not exist in a CI step, and the canon is private with
  // cross-repo Actions access closed — a reusable workflow would require widening that. Byte
  // identity with the plugin's own copies is enforced by manifest-gate.mjs (ywr-harness ADR 0014).
  ['scripts/harness/harness_config.mjs', 'scripts/harness/harness_config.mjs'],
  ['scripts/harness/harness_git.mjs', 'scripts/harness/harness_git.mjs'],
  ['scripts/harness/harness_gates.mjs', 'scripts/harness/harness_gates.mjs'],
  ['scripts/harness/harness_retro.mjs', 'scripts/harness/harness_retro.mjs'],
  ['scripts/harness/verify_map.mjs', 'scripts/harness/verify_map.mjs'],
  // Not a CI script: the session names this path from CLAUDE.md to record its decisions (ywr-harness ADR 0172).
  ['scripts/harness/slice_note.mjs', 'scripts/harness/slice_note.mjs'],
  // CI 의 PR base 해석 단일 소스(ywr-harness ADR 0043) — 벤더링된 워크플로가 직접 sh 로 부른다.
  ['scripts/harness/resolve-base.sh', 'scripts/harness/resolve-base.sh'],
  ['.github/workflows/harness-gates.yml', '.github/workflows/harness-gates.yml'],
  ['scripts/harness/gitignore', 'scripts/harness/.gitignore'],
  // The local execution layer (ywr-harness ADR 0015). TOOLCHAIN, not SEED: a hook a repo may edit freely is a
  // hook that stops being the same gate everywhere, which is the divergence ywr-harness ADR 0010 forbids.
  ['githooks/pre-commit', '.githooks/pre-commit'],
  ['githooks/pre-push', '.githooks/pre-push'],
])

// Destinations whose TOOLCHAIN entry was added to this scaffold AFTER repos could already be stamped
// by an earlier plugin version, and the plugin version that FIRST shipped each. The first-run
// collision guard (ywr-harness ADR 0055) is scoped to the REPO's first run — but a path introduced
// later has its OWN first appearance the moment it enters TOOLCHAIN: a repo stamped BEFORE that
// version is not first-run overall, yet has never received this path from the canon, so an existing
// foreign file there is exactly the ywr-harness ADR 0055 collision, not a normal refresh
// (ywr-harness ADR 0074 extends ywr-harness ADR 0055 to a path's first appearance).
//
// Rule for future additions: every NEW TOOLCHAIN path gets an entry here naming the version it ships
// in, so a stamped repo's pre-existing file at that new path is guarded the same as a first-run
// collision instead of being silently overwritten and reported as "refreshed".
export const INTRODUCED_IN = pairs([
  ['docs/check_docs.mjs', '0.85.0'],
  ['docs/build_docs.mjs', '0.85.0'],
  ['scripts/harness/harness_config.mjs', '0.85.0'],
  ['scripts/harness/harness_git.mjs', '0.85.0'],
  ['scripts/harness/harness_gates.mjs', '0.85.0'],
  ['scripts/harness/harness_retro.mjs', '0.85.0'],
  ['scripts/harness/verify_map.mjs', '0.85.0'],
  ['scripts/harness/slice_note.mjs', '0.85.0'],
  ['docs/build.mjs', '0.84.0'],
])

// GUARDED — the third mode, and it exists for exactly one file. `post-commit` is a filename repos
// commonly already use (a repo may use it to republish a docs artifact), so blind TOOLCHAIN overwrite
// would destroy working automation. But making it a SEED means a repo that already has one never
// receives the retro at all, silently.
//
// So: place when absent, REFRESH when the existing file carries our marker, REFUSE and report
// otherwise. Same rule as ywr-harness ADR 0015's `core.hooksPath`, applied to a file instead of a config key.
export const GUARD_MARKER = 'ywr-harness:post-commit'
export const GUARDED = pairs([
  ['githooks/post-commit', '.githooks/post-commit'],
])

export const SEED = pairs([
  // CLAUDE.md also holds the starter review canon in its `## Review canon` section (ywr-harness ADR 0217):
  // every session loads the file, so /code-review reads the invariants with no import. A REVIEW.md
  // that an older scaffold placed stays where it is, because a re-run never deletes a file.
  ['CLAUDE.md', 'CLAUDE.md'],
  ['gitattributes', '.gitattributes'],
  // Root ignore (ywr-harness ADR 0053): makes the shipped claims true at placement — the html surfaces
  // stay out of the first commit, the telemetry ledger's "(gitignored)" header holds, and
  // CLAUDE.md's ".env is gitignored" line is true. What a repo ignores is its decision → SEED.
  ['gitignore', '.gitignore'],
  // The UNMAPPED exemption list, which doubles as the repo's visible spec-debt register. A SEED
  // for the same reason .harness.json is one: its whole content is decisions only this repo has.
  ['githooks/slice-retro-ignore', '.githooks/slice-retro-ignore'],
  // The declaration the plugin's scripts read for this repo's paths and runner. A SEED, not
  // TOOLCHAIN: its whole purpose is to hold values only this repo knows, so overwriting it on a
  // re-run would erase exactly the configuration it exists to carry.
  ['harness.json', '.harness.json'],
  // The stage prompts that the template's `decision_prompts` declares for the /ywr-harness:auto switch
  // (ywr-harness ADR 0180). SEED: a repo rewrites them for its own rules, and they do nothing while the switch is off.
  ['docs/prompts/review-start.md', 'docs/prompts/review-start.md'],
  ['docs/prompts/ready-report.md', 'docs/prompts/ready-report.md'],
])

// Files an earlier release placed and the current one no longer places. A re-run never deletes a
// file, so such a file stays in a repo that took the older scaffold; init.mjs names each one it finds
// and tells the reader to remove it. `since` is the plugin release that stopped placing it, `adr` the
// decision record that says why.
export const RETIRED = Object.freeze([
  Object.freeze({ dest: 'docs/build.ps1', since: '0.84.0', adr: '0220' }),
  Object.freeze({ dest: 'docs/build_docs.py', since: '0.85.0', adr: '0223' }),
  Object.freeze({ dest: 'docs/check_docs.py', since: '0.85.0', adr: '0223' }),
  Object.freeze({ dest: 'scripts/harness/harness_config.py', since: '0.85.0', adr: '0223' }),
  Object.freeze({ dest: 'scripts/harness/harness_gates.py', since: '0.85.0', adr: '0223' }),
  Object.freeze({ dest: 'scripts/harness/harness_retro.py', since: '0.85.0', adr: '0223' }),
  Object.freeze({ dest: 'scripts/harness/verify_map.py', since: '0.85.0', adr: '0223' }),
  Object.freeze({ dest: 'scripts/harness/slice_note.py', since: '0.85.0', adr: '0223' }),
])

// Placed ONLY when docs/adr/ holds no record yet. Two reasons, both load-bearing:
//   1. The builder refuses an empty corpus ("found no .md with frontmatter") — correct behavior,
//      but it means a scaffold that places only templates produces a repo that cannot build, so
//      no tooling can query its decisions. Measured on the first end-to-end run.
//   2. Unconditional placement would collide: a repo that already has its own 0001 would end up
//      with two records claiming id 0001.
// So: seed the corpus when it is empty, and stay out of the way when it is not.
export const SEED_CORPUS = pairs([
  ['docs/adr/0001-adopt-docs-as-code.md', 'docs/adr/0001-adopt-docs-as-code.md'],
])
