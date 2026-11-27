#!/usr/bin/env node
// Gate for the workflow scripts under .claude/workflows/. Two arms, in this order:
//   parse       every .claude/workflows/*.js compiles. `node --check` cannot do this job: an
//               `export` line makes node treat the file as a module and skip the syntax check, so
//               --check exits 0 for any content after it. Every workflow carries
//               `export const meta`, so --check would always pass.
//               The `export` keyword is stripped and the body compiled inside an async wrapper
//               through `new Function`, which accepts the top-level `return` and `await` that a
//               workflow script has. Compile only. Nothing runs.
//   behavioral  every .claude/workflows/*.selftest.mjs is executed and must exit 0.
//
// The `export const meta` anchor is asserted: the Workflow tool rejects a script without it, and
// the parse transform is anchored on it. The gate checks that one anchor and nothing else about
// meta, because no in-repo source defines a meta schema to check against.
//
// Zero workflow scripts, or zero selftests, FAILS: green over an empty corpus is a vacuous pass.
// Counts are printed so shrinking coverage is visible. No flag switches an arm off, because an
// escape hatch is how the behavioral arm would quietly stop running.
//
// Usage: node scripts/workflow-gates.mjs [--root <dir>] [--dir <corpus dir>]
// Exit 0 = green. Exit 1 = parse failure, failing selftest, missing corpus or vacuous corpus.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const optIdx = argv.indexOf('--root');
const root = resolve(optIdx >= 0 && argv[optIdx + 1] ? argv[optIdx + 1] : '.');
// The corpus directory is an option: a caller whose corpus sits outside `.claude/workflows` passes
// `--dir`. A fixed path would leave that corpus gated by nothing under a green count.
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

// Recursive: a workflow in a subdirectory would otherwise be gated by nothing under a green count.
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
// The exclusion mirrors the selftest filter exactly: a file named `foo.selftest.js` is parse-checked
// as a workflow script and fails the meta-anchor check, which tells the author to rename it. A
// looser exclusion would leave it gated by nothing.
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
