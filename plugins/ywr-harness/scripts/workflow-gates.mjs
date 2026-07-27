#!/usr/bin/env node
// JS-side gate for .claude/workflows/ (ADR 0124) — promotes the one-off parse checker ADR 0115
// item 7 recorded but left hand-run, and turns the behavioral selftest from a slice-close habit
// into a discovered gate. Both were run by hand until now, which means a session could forget
// them; ADR 0115 said so in its own Consequences.
//
// Two arms, in this order:
//   parse       every .claude/workflows/*.js compiles. `node --check` cannot do this job, and the
//               reason is the opposite of the one ADR 0115 recorded: measured 2026-07-25 on node
//               v24.14.0, an `export` line makes the file module-detected and NOT syntax-checked,
//               so --check exits 0 for any content after it — including the real
//               adversarial-review.js with an unbalanced paren injected mid-file. On this class
//               (every workflow carries `export const meta`) --check is vacuous, not noisy.
//               So the `export` keyword is stripped and the body compiled inside an async wrapper
//               via `new Function` — which accepts the top-level `return`/`await` a workflow
//               script legitimately has. Compile only; nothing is executed.
//   behavioral  every .claude/workflows/*.selftest.mjs is executed and must exit 0.
//
// The `export const meta` anchor is asserted rather than assumed: the Workflow tool rejects a
// script without it, and the parse transform above is anchored on it. That is one documented
// presence check, deliberately NOT an allow-list of meta fields or a phase-shape schema — those
// have no raw in-repo source, and inventing one is the provenance defect ADR 0123 refused.
//
// Vacuity: zero workflow scripts, or zero selftests, FAILS. A gate reporting green over an empty
// corpus is the ADR 0118 vacuous-pass class. Counts are printed so shrinking coverage is visible
// (ADR 0123), and there is no flag that switches an arm off — an escape hatch here is how the
// behavioral arm would quietly stop running.
//
// Usage: node scripts/ci/workflow-gates.mjs [--root <dir>]
// Exit 0 = green · 1 = parse failure, failing selftest, missing corpus, or vacuous corpus.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const optIdx = argv.indexOf('--root');
const root = resolve(optIdx >= 0 && argv[optIdx + 1] ? argv[optIdx + 1] : '.');
// The corpus directory is an option, not a constant: this gate now ships inside a plugin whose
// own workflows live at `workflows/` (plugin root), while a consuming repo keeps them under
// `.claude/workflows`. Hardcoding either one leaves the other gated by nothing while the summary
// still prints a green count — the exact failure the other arms of this file exist to prevent.
const dirIdx = argv.indexOf('--dir');
const REL = dirIdx >= 0 && argv[dirIdx + 1] ? argv[dirIdx + 1] : '.claude/workflows';
const dir = join(root, REL);

const say = (line) => console.log(`[workflow-gates] ${line}`);
let failures = 0;
const fail = (line) => {
  say(`FAIL — ${line}`);
  failures += 1;
};

if (!existsSync(dir)) {
  say(`FAIL — ${REL}/ not found under ${root} — a missing corpus is not a pass`);
  process.exit(1);
}

// Recursive on purpose: a workflow parked in a subdirectory would otherwise be gated by nothing
// while the summary still printed a green count.
function walk(base, prefix = '') {
  const out = [];
  for (const e of readdirSync(join(base, prefix), { withFileTypes: true })) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(base, p));
    else out.push(p);
  }
  return out;
}

const files = walk(dir).sort();
// The exclusion mirrors the selftest filter EXACTLY, on purpose: a file named `foo.selftest.js`
// is then parse-checked as a workflow script and fails the meta-anchor check, which tells the
// author to rename it. A looser exclusion would leave it gated by nothing at all.
const scripts = files.filter((f) => f.endsWith('.js') && !f.endsWith('.selftest.mjs'));
const selftests = files.filter((f) => f.endsWith('.selftest.mjs'));

// --- parse arm --------------------------------------------------------------------------
const META_RE = /^export\s+const\s+meta\b/m;
for (const f of scripts) {
  const src = readFileSync(join(dir, f), 'utf8');
  if (!META_RE.test(src)) {
    fail(`${REL}/${f}: no \`export const meta\` declaration — the Workflow tool requires it`);
    continue;
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (async () => {\n${src.replace(META_RE, 'const meta')}\n})()`);
    say(`ok — parsed ${REL}/${f}`);
  } catch (e) {
    fail(`${REL}/${f}: ${e.name}: ${e.message}`);
  }
}
if (scripts.length === 0) fail(`zero workflow scripts under ${REL}/ — the parse arm would be vacuous`);

// --- behavioral arm ---------------------------------------------------------------------
if (selftests.length === 0) fail(`zero *.selftest.mjs under ${REL}/ — the behavioral arm would be vacuous`);
for (const f of selftests) {
  const r = spawnSync(process.execPath, [join(dir, f)], { stdio: 'inherit' });
  if (r.status === 0) say(`ok — selftest passed ${REL}/${f}`);
  else fail(`selftest failed (${r.status === null ? `signal ${r.signal}` : `exit ${r.status}`}): ${REL}/${f}`);
}

say(
  failures
    ? `FAILURES — ${failures} (${scripts.length} workflow script(s), ${selftests.length} selftest file(s) discovered)`
    : `green — ${scripts.length} workflow script(s) parsed, ${selftests.length} selftest file(s) passed`,
);
process.exit(failures ? 1 : 0);
