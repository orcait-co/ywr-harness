// The scaffold's placement map: the one owner of which template lands where. It is data, with no
// side effect, I/O or import, so every reader imports it instead of copying it. Readers are
// init.mjs, the SessionStart refresh nudge, manifest-gate.mjs and the gate emitter's SCAFFOLD_CLAIMS
// pairing case. Two copies of one rule drift apart (ywr-harness ADR 0033).
//
// Each table is an ordered, frozen array of [source, destination] pairs (INTRODUCED_IN holds
// [destination, version]). Order is the placement order and the report order.
//
// Placement modes:
//   TOOLCHAIN    Overwritten on every run. A consuming repo must not hand-edit these (ywr-harness ADR 0010).
//   GUARDED      Placed when absent, refreshed when the file carries GUARD_MARKER, otherwise refused and reported.
//   SEED         Created once, never overwritten. A repo's own decisions live in these files.
//   SEED_CORPUS  Seeded only when the repo holds no decision record yet.
//   RETIRED      No longer placed. Reported when found, never deleted.

const pairs = (list) => Object.freeze(list.map((p) => Object.freeze([...p])))

// Each pair maps a source under templates/ to a destination under the target.
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
  // Vendored so CI needs no access to the canon repo. `${CLAUDE_PLUGIN_ROOT}` exists only when
  // Claude Code spawns a hook, and cross-repo Actions access is closed. manifest-gate.mjs enforces
  // byte identity with the plugin's own copies (ywr-harness ADR 0014).
  ['scripts/harness/harness_config.mjs', 'scripts/harness/harness_config.mjs'],
  ['scripts/harness/harness_git.mjs', 'scripts/harness/harness_git.mjs'],
  ['scripts/harness/harness_gates.mjs', 'scripts/harness/harness_gates.mjs'],
  ['scripts/harness/harness_retro.mjs', 'scripts/harness/harness_retro.mjs'],
  ['scripts/harness/verify_map.mjs', 'scripts/harness/verify_map.mjs'],
  // Not a CI script. CLAUDE.md names this path for the session to record its decisions (ywr-harness ADR 0172).
  ['scripts/harness/slice_note.mjs', 'scripts/harness/slice_note.mjs'],
  // The one source of CI's PR base resolution. The vendored workflow calls it directly with sh (ywr-harness ADR 0043).
  ['scripts/harness/resolve-base.sh', 'scripts/harness/resolve-base.sh'],
  ['.github/workflows/harness-gates.yml', '.github/workflows/harness-gates.yml'],
  ['scripts/harness/gitignore', 'scripts/harness/.gitignore'],
  // The local execution layer (ywr-harness ADR 0015). Toolchain, not seed: a freely edited hook is no
  // longer the same gate everywhere, the divergence ywr-harness ADR 0010 forbids.
  ['githooks/pre-commit', '.githooks/pre-commit'],
  ['githooks/pre-push', '.githooks/pre-push'],
])

// Each entry names a toolchain destination and the plugin version that first shipped it. The
// first-run collision guard (ywr-harness ADR 0055) covers a repo's first run. A repo stamped before
// that version has never received the path from the canon, so a foreign file there is the same
// collision (ywr-harness ADR 0074).
//
// Every new toolchain path gets an entry here, so a stamped repo's existing file at that path is
// guarded, not overwritten and reported as "refreshed".
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

// GUARDED exists for one file. Repos commonly use `post-commit` already, so a toolchain overwrite
// would destroy working automation, and a seed would never deliver the retro to such a repo.
// The mode places when absent, refreshes when the file carries our marker, and refuses and reports
// otherwise. It is the rule of ywr-harness ADR 0015's `core.hooksPath`, applied to a file.
export const GUARD_MARKER = 'ywr-harness:post-commit'
export const GUARDED = pairs([
  ['githooks/post-commit', '.githooks/post-commit'],
])

export const SEED = pairs([
  // CLAUDE.md holds the starter review canon in its `## Review canon` section (ywr-harness ADR 0217).
  // Every session loads the file, so /code-review reads the invariants with no import.
  ['CLAUDE.md', 'CLAUDE.md'],
  ['gitattributes', '.gitattributes'],
  // The root ignore keeps the html surfaces out of the first commit and makes the shipped
  // ".env is gitignored" claims true (ywr-harness ADR 0053). What a repo ignores is its own decision.
  ['gitignore', '.gitignore'],
  // The UNMAPPED exemption list, which doubles as the repo's visible spec-debt register. Its whole
  // content is decisions only this repo has.
  ['githooks/slice-retro-ignore', '.githooks/slice-retro-ignore'],
  // The declaration that the plugin's scripts read for this repo's paths and runner. A re-run
  // overwrite would erase the configuration it exists to carry.
  ['harness.json', '.harness.json'],
  // The stage prompts that the template's `decision_prompts` declares for the /ywr-harness:auto
  // switch (ywr-harness ADR 0180). A repo rewrites them for its own rules.
  ['docs/prompts/review-start.md', 'docs/prompts/review-start.md'],
  ['docs/prompts/ready-report.md', 'docs/prompts/ready-report.md'],
])

// Files that the scaffold no longer places. A re-run never deletes, so init.mjs names each one it
// finds and tells the reader to remove it. `since` is the plugin release that stopped placing it,
// and `adr` is the decision record that says why.
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

// Placed only when docs/adr/ holds no record yet, for two reasons:
//   1. The builder refuses an empty corpus ("found no .md with frontmatter"), so a scaffold that
//      places only templates produces a repo that cannot build.
//   2. A repo with its own 0001 would end up with two records that claim id 0001.
export const SEED_CORPUS = pairs([
  ['docs/adr/0001-adopt-docs-as-code.md', 'docs/adr/0001-adopt-docs-as-code.md'],
])
