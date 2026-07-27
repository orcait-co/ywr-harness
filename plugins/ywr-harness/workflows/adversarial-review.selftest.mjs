// Behavioral selftest for adversarial-review.js — the find-phase dead-finder handling
// (ADR 0115 Decision item 3) plus the ADR 0050 §4 canary abort.
//
// Why it looks like this: a workflow script is not importable. It takes ALL its I/O through
// runtime globals (agent/parallel/log/phase/budget/args) and ends with a top-level `return`,
// so it is neither an ESM module nor a plain script. This harness therefore compiles the real
// file with `new Function`, injects stub globals, and drives each terminal branch. It tests the
// shipped source, not a copy.
//
// Correction 2026-07-25 (ADR 0124): the line here that said `node --check` FAILS on the
// unmodified file is wrong as measured on node v24.14.0 — the `export` line makes the file
// module-detected and unchecked, so --check exits 0 even with a genuine syntax error injected
// into this very workflow. The direction that matters is a silent pass, not a false alarm.
//
// Run: node .claude/workflows/adversarial-review.selftest.mjs
// Exit 0 = all green. Prints PASS/FAIL per case (ADR 0106 selftest convention).

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'adversarial-review.js');

// --- harness ---------------------------------------------------------------

function compile(path) {
  const src = readFileSync(path, 'utf8').replace(/^export\s+const\s+meta/m, 'const meta');
  // eslint-disable-next-line no-new-func
  return new Function(
    'agent', 'parallel', 'log', 'phase', 'budget', 'args',
    `return (async () => {\n${src}\n})()`,
  );
}

// parallel(): mirrors the documented contract — a thunk that throws resolves to null,
// the call itself never rejects.
const parallelStub = (thunks) =>
  Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));

const budgetStub = { total: null, spent: () => 0, remaining: () => Infinity };

// Drives the script with a programmable agent(). `plan.find` maps a lens key to an array of
// per-attempt outcomes: 'die' | 'ok'. Attempt 0 is the initial spawn, attempt 1 the retry.
async function run(plan) {
  const logs = [];
  const attempts = {};
  // agent() returns NULL on a terminal failure — the documented Agent/workflow contract,
  // not an exception. Modelling it as a throw made case 6 pass for the wrong reason
  // (the canary is awaited directly, not through parallel()), so the stub mirrors null.
  const LINE = { 'correctness-pitfalls': 10, 'boundary-ui-tests': 20 };
  const spawns = [];
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || '';
    spawns.push({ label, model: opts.model, effort: opts.effort, prompt });
    if (label === 'canary') return plan.canaryDies ? null : 'ok';
    if (label.startsWith('find:')) {
      const key = label.slice('find:'.length);
      const n = (attempts[key] = (attempts[key] ?? -1) + 1);
      const outcome = (plan.find?.[key] ?? [])[n] ?? 'ok';
      if (outcome === 'die') return null;
      // One finding per lens. The file MUST stay inside args.scope.files or the finding is
      // routed to out_of_scope_confirmed instead of confirmed; only the line varies, which is
      // enough to keep the first-pass `file:line` dedupe from merging the two lenses.
      return { findings: [{ title: `t-${key}`, file: 'f.md', line: LINE[key] ?? 1,
                            severity: 'low', claim: 'c', evidence: 'e' }] };
    }
    if (label.startsWith('verify:')) return { refuted: false, reason: 'r' };
    if (label === 'dedupe:haiku') return { groups: [] };
    throw new Error(`stub: unexpected label ${label}`);
  };
  const fn = compile(SCRIPT);
  const result = await fn(agent, parallelStub, (m) => logs.push(String(m)), () => {},
    plan.budget ?? budgetStub, { tier: 'small', scope: { files: ['f.md'], context: 'c' } });
  return { result, logs, attempts, spawns };
}

let ok = true;
const pass = (name) => console.log(`PASS [${name}]`);
const fail = (name, why) => { console.log(`FAIL [${name}]: ${why}`); ok = false; };

async function expectThrow(name, plan, match) {
  try {
    await run(plan);
    fail(name, 'expected a throw, got a normal return');
  } catch (e) {
    if (match && !String(e.message).includes(match)) fail(name, `wrong error: ${e.message}`);
    else pass(name);
  }
}

// --- cases -----------------------------------------------------------------

// 1. happy path: both finders alive, coverage complete, lens labels correct.
{
  const name = 'all finders alive';
  const { result, logs } = await run({});
  const s = result.stats;
  if (s.lenses !== 2) fail(name, `stats.lenses=${s.lenses}`);
  else if (s.dead_lenses.length !== 0) fail(name, `dead_lenses=${JSON.stringify(s.dead_lenses)}`);
  else if (result.confirmed.length !== 2) fail(name, `confirmed=${result.confirmed.length}`);
  else if (logs.some((l) => l.includes('[경고]'))) fail(name, 'warned with no dead finder');
  else pass(name);
}

// 2. transient failure recovered by the single retry — the wf_ea8a12aa scenario.
{
  const name = 'dead finder recovered by retry';
  const { result, logs, attempts } = await run({ find: { 'correctness-pitfalls': ['die', 'ok'] } });
  const s = result.stats;
  if (s.dead_lenses.length !== 0) fail(name, `dead_lenses=${JSON.stringify(s.dead_lenses)}`);
  else if (attempts['correctness-pitfalls'] !== 1) fail(name, 'retry was not attempted exactly once');
  else if (result.confirmed.length !== 2) fail(name, `confirmed=${result.confirmed.length}`);
  else if (!logs.some((l) => l.includes('1회 재시도'))) fail(name, 'no retry notice logged');
  else pass(name);
}

// 3. permanent single-lens failure: proceed at reduced coverage, but SAY SO in the return
//    value — and do not mis-attribute the survivor's findings to the dead lens.
{
  const name = 'dead lens surfaces in stats + no mis-attribution';
  const { result, logs } = await run({ find: { 'correctness-pitfalls': ['die', 'die'] } });
  const s = result.stats;
  const lenses = result.confirmed.map((f) => f.lens);
  if (JSON.stringify(s.dead_lenses) !== JSON.stringify(['correctness-pitfalls']))
    fail(name, `dead_lenses=${JSON.stringify(s.dead_lenses)}`);
  else if (result.confirmed.length !== 1) fail(name, `confirmed=${result.confirmed.length}`);
  else if (lenses[0] !== 'boundary-ui-tests')
    fail(name, `survivor mislabelled as ${lenses[0]} (index-shift regression)`);
  else if (!logs.some((l) => l.includes('커버리지 축소'))) fail(name, 'no reduced-coverage warning');
  else pass(name);
}

// 4. total failure must ABORT, not return a clean-looking zero-finding pass.
await expectThrow('all finders dead aborts',
  { find: { 'correctness-pitfalls': ['die', 'die'], 'boundary-ui-tests': ['die', 'die'] } },
  '리뷰 무효');

// 5. all dead on the first try but recovered by retry — must NOT abort.
{
  const name = 'all dead then all recovered';
  const { result } = await run({
    find: { 'correctness-pitfalls': ['die', 'ok'], 'boundary-ui-tests': ['die', 'ok'] },
  });
  if (result.stats.dead_lenses.length !== 0) fail(name, 'dead_lenses not cleared after retry');
  else if (result.confirmed.length !== 2) fail(name, `confirmed=${result.confirmed.length}`);
  else pass(name);
}

// 6. canary abort (ADR 0050 §4) — unchanged by this slice, pinned so it stays.
await expectThrow('canary failure aborts', { canaryDies: true }, '카나리아 실패');

// 7. non-vacuous proof: the harness must FAIL a script whose index-shift bug is restored.
//    Guards against the selftest silently passing on a broken file.
{
  const name = 'harness rejects the index-shift bug';
  const src = readFileSync(SCRIPT, 'utf8');
  const buggy = src.replace(
    'const all = found.flatMap((r, i) => (r ? r.findings.map(f => ({ ...f, lens: LENSES[i].key })) : []))',
    'const all = found.filter(Boolean).flatMap((r, i) => r.findings.map(f => ({ ...f, lens: LENSES[i].key })))',
  );
  if (buggy === src) fail(name, 'could not construct the buggy variant — anchor drifted');
  else {
    // OS temp dir, not the tree (2026-07-25, ADR 0124): this selftest is now run by a CI gate,
    // and the ADR 0122 Linux runner bind-mounts the repo READ-ONLY — an in-tree write would
    // report breakage that does not exist, and a mid-run abort would leave a stray .js inside
    // the very directory the parse arm globs.
    const tmp = join(tmpdir(), `adversarial-review-buggy-${process.pid}.js`);
    const { writeFileSync, unlinkSync } = await import('node:fs');
    writeFileSync(tmp, buggy);
    try {
      const saved = SCRIPT;
      // run case 3 against the buggy copy: the survivor should come back mislabelled
      const logs = [];
      const attempts = {};
      const agent = async (prompt, opts = {}) => {
        const label = opts.label || '';
        if (label === 'canary') return 'ok';
        if (label.startsWith('find:')) {
          const key = label.slice(5);
          attempts[key] = (attempts[key] ?? -1) + 1;
          if (key === 'correctness-pitfalls') return null;
          return { findings: [{ title: 't', file: 'f.md', line: 1, severity: 'low', claim: 'c', evidence: 'e' }] };
        }
        if (label.startsWith('verify:')) return { refuted: false, reason: 'r' };
        return { groups: [] };
      };
      const fn = compile(tmp);
      const res = await fn(agent, parallelStub, (m) => logs.push(String(m)), () => {}, budgetStub,
        { tier: 'small', scope: { files: ['f.md'], context: 'c' } });
      const lens = res.confirmed[0]?.lens;
      if (lens === 'correctness-pitfalls') pass(name);   // bug reproduced => harness is sensitive
      else fail(name, `buggy variant did not mis-attribute (got lens=${lens}) — harness may be vacuous`);
      void saved;
    } finally {
      unlinkSync(tmp);
    }
  }
}

// 8. telemetry honesty (ADR 0129). budget.spent() is a pool shared with the main loop, so the
//    per-phase figures are upper bounds; the old key was named `output_tokens`, which reads as
//    exact. The rename is the fix, so the OLD key must be gone — a stats object carrying both
//    would let a reader keep quoting the exact-sounding one. agents_per_phase is the one exact
//    number the workflow owns (it counts its own spawns), so it is asserted against the known
//    fan-out: canary 1 · find 2 (small tier) · verify 2 (two low findings, 1 skeptic each) ·
//    no dedupe key at all, since 2 findings never reach the >12 grouping branch.
{
  const name = 'telemetry reports upper bounds and exact agent counts';
  const { result } = await run({});
  const s = result.stats;
  const a = s.agents_per_phase;
  if (s.output_tokens !== undefined) fail(name, 'the exact-sounding output_tokens key survived the rename');
  else if (!s.output_tokens_upper_bound) fail(name, 'no output_tokens_upper_bound');
  else if (a?.canary !== 1 || a?.find !== 2 || a?.verify !== 2) fail(name, `agents_per_phase=${JSON.stringify(a)}`);
  else if ('dedupe' in a) fail(name, 'counted a dedupe agent that never spawned');
  else if (s.main_loop_bleed_estimate !== 0) fail(name, `bleed=${s.main_loop_bleed_estimate} on a zero-spend stub`);
  else if (!/SubagentStop/.test(s.telemetry_basis || '')) fail(name, 'basis does not say why the ledger cannot replace it');
  else pass(name);
}

// 9. the bleed detector itself. The canary answers with one word, so anything beyond a few
//    tokens in ITS lap was emitted by the main loop, not by this workflow — the audit recorded
//    a 4,077-token canary lap. Without this case the estimator could return a constant 0 and
//    every run would read as uncontaminated, which is the exact failure the field exists to
//    prevent. The stub returns 0 on the first call (_t0) and 4,077 on every later one.
{
  const name = 'an inflated canary lap is reported as main-loop bleed';
  let n = 0;
  const budget = { total: null, remaining: () => Infinity, spent: () => (n++ === 0 ? 0 : 4077) };
  const { result, logs } = await run({ budget });
  const s = result.stats;
  if (s.main_loop_bleed_estimate !== 4069) fail(name, `bleed=${s.main_loop_bleed_estimate} (want 4077-8)`);
  else if (!logs.some((l) => l.includes('의심'))) fail(name, 'contaminated run was not called out in the log');
  else pass(name);
}

// 10. the spawn pins (ADR 0129 · org guide worker discipline). Effort and model are decisions
//     with measurements behind them, and both are one word in a helper call — a silent flip back
//     to `high` would restore ~50% of the review's cost with nothing red, and dropping the
//     explicit model would let workers inherit a deep-work session's Opus. Asserted per phase
//     because they differ on purpose: find medium (0129), canary/verify low, dedupe haiku.
{
  const name = 'model and effort pins hold per phase';
  const { spawns } = await run({});
  const byLabel = (p) => spawns.filter((s) => p.test(s.label));
  const finds = byLabel(/^find:/);
  const bad = (s) => s.model !== 'sonnet' || s.effort !== 'medium';
  if (finds.length !== 2) fail(name, `find spawns=${finds.length}`);
  else if (finds.some(bad)) fail(name, `find pin drifted: ${JSON.stringify(finds.map((s) => [s.model, s.effort]))}`);
  else if (byLabel(/^canary$/)[0]?.effort !== 'low') fail(name, 'canary is not effort low');
  else if (byLabel(/^verify:/).some((s) => s.model !== 'sonnet' || s.effort !== 'low')) fail(name, 'verify pin drifted');
  else pass(name);
}

// 10b. agents_per_phase counts RETRY spawns too — "exact" is the claim, and a retry costs a real
//     agent. Case 2 exercises the retry path but never looks at the count, and case 10 counts
//     only on a no-retry plan, so moving countAgents outside the retry branch would keep every
//     other case green while the reported cost silently understated the spawns (review low).
{
  const name = 'a retried finder is counted, not absorbed';
  const { result } = await run({ find: { 'correctness-pitfalls': ['die', 'ok'] } });
  const find = result.stats.agents_per_phase?.find;
  if (find !== 3) fail(name, `agents_per_phase.find=${find} (want 2 initial + 1 retry)`);
  else pass(name);
}

// 11. the citation clause must carry the ABSENCE rule (ADR 0129). The clause tells finders to
//     verify claims against the original; measured 2026-07-26, that instruction alone produced a
//     false "not on the page" report, because WebFetch returns a silently truncated view of a
//     large page. A finder that keeps the verify-the-original half but loses the raw-fetch half
//     reports absences it cannot support — worse than not checking, since it reads as verified.
{
  const name = 'find prompt demands a raw fetch before an absence claim';
  const { spawns } = await run({});
  const p = spawns.find((s) => s.label.startsWith('find:'))?.prompt ?? '';
  if (!/부재/.test(p)) fail(name, 'no absence rule in the find prompt');
  else if (!/grep/.test(p) || !/curl/.test(p)) fail(name, 'absence rule names no raw-retrieval method');
  else if (!/확인 실패/.test(p)) fail(name, 'no "could not verify" escape — a finder with no method must not claim absence');
  else pass(name);
}

console.log(ok ? 'adversarial-review selftest: all cases green' : 'adversarial-review selftest: FAILURES');
process.exit(ok ? 0 : 1);
