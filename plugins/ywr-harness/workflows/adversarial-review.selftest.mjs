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
// ywr-harness ADR 0089 knobs: `plan.canaryReply` (the canary's text, default 'ok'),
// `plan.findings(key)` (a finder's findings array — undefined falls back to the defaults),
// `plan.groups` (the dedupe stage's groups) and `plan.verdict(prompt, label)` (a skeptic's vote).
// `plan.omitted(key)` sets a finder's cap-overflow count (default 0, as the schema requires); a finder
// whose key is in `plan.noOmitted` returns no `omitted` field at all.
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
    spawns.push({ label, phase: opts.phase, model: opts.model, effort: opts.effort, agentType: opts.agentType, schema: opts.schema, prompt });
    if (label === 'canary') return plan.canaryDies ? null : (plan.canaryReply ?? 'ok');
    if (label.startsWith('find:')) {
      const key = label.slice('find:'.length);
      const n = (attempts[key] = (attempts[key] ?? -1) + 1);
      const outcome = (plan.find?.[key] ?? [])[n] ?? 'ok';
      if (outcome === 'die') return null;
      const om = plan.noOmitted?.includes(key) ? {} : { omitted: plan.omitted?.(key) ?? 0 };
      const custom = plan.findings?.(key);
      if (custom) return { findings: custom, ...om };
      // One finding per lens. The file MUST stay inside args.scope.files or the finding is
      // routed to out_of_scope_confirmed instead of confirmed; only the line varies, which is
      // enough to keep the first-pass `file:line` dedupe from merging the two lenses.
      // plan.many = n: n findings per finder on distinct lines — enough to cross the >12 grouping
      // branch, which the one-finding default never reaches.
      if (plan.many) return { findings: Array.from({ length: plan.many }, (_, i) => ({ title: `t-${key}-${i}`,
        file: 'f.md', line: (LINE[key] ?? 1) * 100 + i, severity: 'low', claim: 'c', evidence: 'e' })), ...om };
      return { findings: [{ title: `t-${key}`, file: 'f.md', line: LINE[key] ?? 1,
                            severity: 'low', claim: 'c', evidence: 'e' }], ...om };
    }
    if (label.startsWith('verify:')) return plan.verdict ? plan.verdict(prompt, label) : { refuted: false, reason: 'r' };
    if (label === 'dedupe:haiku' || label === 'dedupe') return { groups: plan.groups ?? [] };
    throw new Error(`stub: unexpected label ${label}`);
  };
  const fn = compile(SCRIPT);
  const result = await fn(agent, parallelStub, (m) => logs.push(String(m)), () => {},
    plan.budget ?? budgetStub, plan.args ?? { tier: 'small', scope: { files: ['f.md'], context: 'c' } });
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
    'const all = found.flatMap((r, i) => (r ? r.findings.map(f => ({ ...f, lens: unitKey(UNITS[i]) })) : []))',
    'const all = found.filter(Boolean).flatMap((r, i) => r.findings.map(f => ({ ...f, lens: unitKey(UNITS[i]) })))',
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
  const line = logs.find((l) => l.includes('카나리아 랩 초과분')) ?? '';
  if (s.main_loop_bleed_estimate !== 4069) fail(name, `bleed=${s.main_loop_bleed_estimate} (want 4077-8)`);
  else if (!line.includes('의심')) fail(name, 'contaminated run was not called out in the log');
  // review slice 26: the excess also holds the canary's own thinking, so it is no floor — no '≥'.
  else if (!line.includes('카나리아 자신의 사고 토큰') || line.includes('≥')) fail(name, `bleed log claims a floor or omits the canary's thinking: ${line}`);
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

// 10u. the ultracode mode (ywr-harness ADR 0084). args.ultracode:true lifts BOTH sonnet-tier pins:
//     every reviewer stage runs on the session model ('inherit' — measured to resolve on top of the
//     reviewer agentType at 2.1.280) at ONE explicit effort, default 'xhigh' (an 'inherit' effort is
//     silently dropped for the frontmatter's medium — measured, so the script never sends it). The
//     haiku dedupe lifts too (owner follow-up, same day): no model (the default subagent inherits the
//     session model — measured) and the same explicit effort. The agentType stays (the allowlist is
//     the no-edit guarantee, not a cost lever only). The stats name the mode so a close can record it.
{
  const name = 'ultracode lifts the sonnet and effort pins, keeps agentType';
  const { result, spawns, logs } = await run({ args: { tier: 'small', ultracode: true, scope: { files: ['f.md'], context: 'c' } } });
  const workers = spawns.filter((s) => /^(canary$|find:|verify:)/.test(s.label));
  const off = workers.filter((s) => s.model !== 'inherit' || s.effort !== 'xhigh' || s.agentType !== 'ywr-harness:reviewer');
  if (!workers.length) fail(name, 'no worker spawns captured');
  else if (off.length) fail(name, `pins not lifted: ${JSON.stringify(off.map((s) => [s.label, s.model, s.effort, s.agentType]))}`);
  else if (result.stats.worker_pins?.mode !== 'ultracode' || result.stats.worker_pins?.effort !== 'xhigh') fail(name, `stats.worker_pins=${JSON.stringify(result.stats.worker_pins)}`);
  else if (!logs.some((l) => l.startsWith('[ultracode]'))) fail(name, 'mode not logged');
  else pass(name);
}
{
  const name = 'ultracode honours an explicit args.effort';
  const { spawns } = await run({ args: { tier: 'small', ultracode: true, effort: 'max', scope: { files: ['f.md'], context: 'c' } } });
  const workers = spawns.filter((s) => /^(canary$|find:|verify:)/.test(s.label));
  if (workers.some((s) => s.effort !== 'max' || s.model !== 'inherit')) fail(name, JSON.stringify(workers.map((s) => [s.label, s.model, s.effort])));
  else pass(name);
}
{
  const name = 'dedupe grouping: haiku · low when pinned, session model at the ultracode effort otherwise';
  const pinned = (await run({ many: 7 })).spawns.filter((s) => s.phase === 'Dedupe' || /^dedupe/.test(s.label));
  const ultra = (await run({ many: 7, args: { tier: 'small', ultracode: true, scope: { files: ['f.md'], context: 'c' } } }))
    .spawns.filter((s) => s.phase === 'Dedupe' || /^dedupe/.test(s.label));
  if (pinned.length !== 1 || ultra.length !== 1) fail(name, `dedupe spawns pinned=${pinned.length} ultra=${ultra.length} (14 findings must cross >12)`);
  else if (pinned[0].model !== 'haiku' || pinned[0].effort !== 'low' || pinned[0].agentType !== undefined) fail(name, `pinned dedupe=${JSON.stringify([pinned[0].model, pinned[0].effort, pinned[0].agentType])}`);
  else if (ultra[0].model !== undefined || ultra[0].effort !== 'xhigh' || ultra[0].agentType) fail(name, `ultra dedupe=${JSON.stringify([ultra[0].model, ultra[0].effort, ultra[0].agentType])}`);
  else pass(name);
}
{
  const name = 'default mode reports the pinned worker_pins';
  const { result } = await run({});
  if (result.stats.worker_pins?.mode !== 'pinned' || !String(result.stats.worker_pins?.model).startsWith('sonnet')) fail(name, JSON.stringify(result.stats.worker_pins));
  else pass(name);
}
await expectThrow('non-boolean args.ultracode is refused',
  { args: { ultracode: 'true', scope: { files: ['f.md'], context: 'c' } } }, 'args.ultracode');
await expectThrow('args.effort without ultracode is refused',
  { args: { effort: 'xhigh', scope: { files: ['f.md'], context: 'c' } } }, 'args.effort');
await expectThrow('an unknown ultracode effort is refused',
  { args: { ultracode: true, effort: 'ultracode', scope: { files: ['f.md'], context: 'c' } } }, 'args.effort');

// 10a. the worker identity (ywr-harness ADR 0069). Canary, finders and skeptics run as the plugin's
//     tool-restricted reviewer agent — the allowlist is what removes ~half of the prefix every
//     worker request re-reads, and it only takes effect through agentType. The name must be the
//     NAMESPACED form (fact 1: a bare name does not resolve, and manifest-gate does not scan
//     agentType strings — this assertion is the only gate on it). The dedupe grouping deliberately
//     stays on the default subagent (haiku; a model override on top of agentType is unmeasured —
//     ywr-harness ADR 0089 candidate I). The dedupe half runs on plan.many (14 findings): run({}) has
//     2, never crosses >12, and an agentType check over zero dedupe spawns is vacuous (review slice 26).
{
  const name = 'canary/find/verify spawns run as the namespaced reviewer agent';
  const { spawns } = await run({});
  const workers = spawns.filter((s) => /^(canary$|find:|verify:)/.test(s.label));
  const wrong = workers.filter((s) => s.agentType !== 'ywr-harness:reviewer');
  const dedupe = (await run({ many: 7 })).spawns.filter((s) => s.phase === 'Dedupe');
  if (!workers.length) fail(name, 'no worker spawns captured');
  else if (wrong.length) fail(name, `agentType drifted: ${JSON.stringify(wrong.map((s) => [s.label, s.agentType]))}`);
  else if (dedupe.length !== 1) fail(name, `dedupe spawns=${dedupe.length} — the default-subagent check needs the >12 branch`);
  else if (dedupe[0].agentType !== undefined) fail(name, `dedupe should stay on the default subagent (agentType=${dedupe[0].agentType})`);
  else pass(name);
}

// 11. dynamic finder sharding (ywr-harness ADR 0070). The unit is lens × shard; without args.shards
//     nothing changes (labels stay `find:<key>` — every earlier case is that regression check).
{
  const name = '11a shards=2 over 4 files → 4 finders, contiguous halves, counted exactly';
  const files = ['a.md', 'b.md', 'c.md', 'd.md'];
  const { result, spawns } = await run({ args: { tier: 'small', shards: 2, scope: { files, context: 'c' } } });
  const finds = spawns.filter((s) => s.label.startsWith('find:'));
  const labels = finds.map((s) => s.label).sort();
  const first = finds.find((s) => s.label === 'find:correctness-pitfalls#1')?.prompt || '';
  const second = finds.find((s) => s.label === 'find:correctness-pitfalls#2')?.prompt || '';
  if (finds.length !== 4) fail(name, `find spawns=${finds.length}`);
  else if (labels.join(',') !== 'find:boundary-ui-tests#1,find:boundary-ui-tests#2,find:correctness-pitfalls#1,find:correctness-pitfalls#2') fail(name, `labels=${labels.join(',')}`);
  else if (!/샤드 1\/2\): a\.md, b\.md/.test(first) || !/샤드 2\/2\): c\.md, d\.md/.test(second)) fail(name, 'shard file lists not in the prompts');
  else if (/c\.md/.test(first.split('담당 파일')[1]?.split('\n')[0] || '')) fail(name, 'shard 1 lists a shard-2 file');
  else if (result.stats.agents_per_phase.find !== 4 || result.stats.shards !== 2 || result.stats.finders !== 4) fail(name, `stats ${JSON.stringify(result.stats)}`);
  else pass(name);
}
{
  const name = '11b shards=auto with 3 files stays a single finder per lens (ceil(3/4)=1), labels unchanged';
  const { result, spawns } = await run({ args: { tier: 'small', shards: 'auto', scope: { files: ['a.md', 'b.md', 'c.md'], context: 'c' } } });
  const finds = spawns.filter((s) => s.label.startsWith('find:'));
  if (finds.length !== 2 || finds.some((s) => s.label.includes('#'))) fail(name, `labels=${finds.map((s) => s.label)}`);
  else if (result.stats.shards !== 1 || result.stats.finders !== 2) fail(name, `stats ${JSON.stringify(result.stats)}`);
  else pass(name);
}
{
  const name = '11c shards=auto with 9 files → 3 EVEN shards of 3/3/3 (count from ceil(9/4), sizes rebalanced), split logged';
  const files = Array.from({ length: 9 }, (_, i) => `f${i}.md`);
  const { result, logs } = await run({ args: { tier: 'small', shards: 'auto', scope: { files, context: 'c' } } });
  if (result.stats.shards !== 3 || result.stats.finders !== 6) fail(name, `stats ${JSON.stringify(result.stats)}`);
  else if (!logs.some((l) => /파인더 분할: 렌즈 2 × 샤드 3 = 6 \(샤드 크기 3\/3\/3\)/.test(l))) fail(name, `no split log: ${logs.join(' | ')}`);
  else pass(name);
}
await expectThrow('11d shards on a STRING scope throws (cannot split, must not silently run unsplit)',
  { args: { tier: 'small', shards: 2, scope: 'free text scope' } }, 'scope.files');
{
  const name = '11e explicit groups are used verbatim (coupled files stay together)';
  const { spawns } = await run({ args: { tier: 'small', shards: [['a.md'], ['b.md', 'c.md']], scope: { files: ['a.md', 'b.md', 'c.md'], context: 'c' } } });
  const p1 = spawns.find((s) => s.label === 'find:boundary-ui-tests#1')?.prompt || '';
  const p2 = spawns.find((s) => s.label === 'find:boundary-ui-tests#2')?.prompt || '';
  if (!/샤드 1\/2\): a\.md\n/.test(p1) || !/샤드 2\/2\): b\.md, c\.md\n/.test(p2)) fail(name, 'group contents drifted');
  else pass(name);
}
{
  const name = '11f find prompt carries the batching clause and the local-first citation rule (ADR 0070)';
  const { spawns } = await run({});
  const p = spawns.find((s) => s.label.startsWith('find:'))?.prompt || '';
  if (!p.includes('한 턴에 병렬 도구 호출로')) fail(name, 'batching clause missing');
  else if (!p.includes('로컬 경로') || !p.includes('원격 조회는 로컬 원본이 없을 때만')) fail(name, 'local-first citation rule missing');
  else if (!p.includes('스코프 파일 전부는 첫 턴에 한 번에 읽어라')) fail(name, 'first-turn read-all missing');
  else pass(name);
}

{
  const name = '11g shards=auto caps at MAX_SHARDS=4 (20 files → 4 shards of 5)';
  const files = Array.from({ length: 20 }, (_, i) => `f${i}.md`);
  const { result, logs } = await run({ args: { tier: 'small', shards: 'auto', scope: { files, context: 'c' } } });
  if (result.stats.shards !== 4 || result.stats.finders !== 8) fail(name, `stats ${JSON.stringify(result.stats)}`);
  else if (!logs.some((l) => /샤드 크기 5\/5\/5\/5/.test(l))) fail(name, `sizes: ${logs.join(' | ')}`);
  else pass(name);
}
{
  const name = '11h integer n=3 over 4 files honours 3 shards (2/1/1), never a silent 2 (review 2026-09-02 medium)';
  const { result, logs } = await run({ args: { tier: 'small', shards: 3, scope: { files: ['a.md', 'b.md', 'c.md', 'd.md'], context: 'c' } } });
  if (result.stats.shards !== 3) fail(name, `shards=${result.stats.shards}`);
  else if (!logs.some((l) => /샤드 크기 2\/1\/1/.test(l))) fail(name, `sizes: ${logs.join(' | ')}`);
  else pass(name);
}
{
  const name = '11i n larger than the file count is clamped AND logged (2 files, shards=5 → 2, note in the split log)';
  const { result, logs } = await run({ args: { tier: 'small', shards: 5, scope: { files: ['a.md', 'b.md'], context: 'c' } } });
  if (result.stats.shards !== 2) fail(name, `shards=${result.stats.shards}`);
  else if (!logs.some((l) => /샤드 5 요청 → 파일 2개라 2개/.test(l))) fail(name, `no clamp note: ${logs.join(' | ')}`);
  else pass(name);
}
await expectThrow('11j explicit groups that omit a scope file throw naming it (silent coverage loss is the review-found HIGH)',
  { args: { tier: 'small', shards: [['a.md'], ['b.md']], scope: { files: ['a.md', 'b.md', 'c.md'], context: 'c' } } }, '미배정: [c.md]');
await expectThrow('11k explicit groups naming a file outside scope.files throw naming it',
  { args: { tier: 'small', shards: [['a.md'], ['x.md']], scope: { files: ['a.md', 'b.md'], context: 'c' } } }, '스코프 밖: [x.md]');
await expectThrow('11l explicit groups assigning one file twice throw naming it',
  { args: { tier: 'small', shards: [['a.md', 'b.md'], ['b.md']], scope: { files: ['a.md', 'b.md'], context: 'c' } } }, '중복: [b.md]');
{
  const name = '11m a sharded finder that dies once is retried and attributed to ITS unit; dead_finders/dead_lenses stay exact';
  // plan.find is keyed by the label suffix after 'find:' — with shards the key carries '#<i>'.
  const files = ['a.md', 'b.md', 'c.md', 'd.md'];
  const { result, spawns } = await run({ args: { tier: 'small', shards: 2, scope: { files, context: 'c' } }, find: { 'correctness-pitfalls#2': ['die', 'ok'] } });
  const retried = spawns.filter((s) => s.label === 'find:correctness-pitfalls#2');
  if (retried.length !== 2) fail(name, `retry spawns for the dead unit=${retried.length}`);
  else if (result.stats.agents_per_phase.find !== 5) fail(name, `find count=${result.stats.agents_per_phase.find} (4 + 1 retry expected)`);
  else if (result.stats.dead_finders.length || result.stats.dead_lenses.length) fail(name, `dead after recovery: ${JSON.stringify([result.stats.dead_finders, result.stats.dead_lenses])}`);
  else pass(name);
}
{
  const name = '11n a lens is dead only when EVERY shard of it died; one dead shard reports in dead_finders alone';
  const files = ['a.md', 'b.md', 'c.md', 'd.md'];
  const { result } = await run({ args: { tier: 'small', shards: 2, scope: { files, context: 'c' } }, find: { 'correctness-pitfalls#2': ['die', 'die'] } });
  if (JSON.stringify(result.stats.dead_finders) !== JSON.stringify(['correctness-pitfalls#2'])) fail(name, `dead_finders=${JSON.stringify(result.stats.dead_finders)}`);
  else if (result.stats.dead_lenses.length !== 0) fail(name, `dead_lenses=${JSON.stringify(result.stats.dead_lenses)} (sibling shard survived)`);
  else pass(name);
}
{
  const name = '11o the sharded prompt says "담당 파일 전부", the unsharded one "스코프 파일 전부" (no self-contradiction)';
  const { spawns } = await run({ args: { tier: 'small', shards: 2, scope: { files: ['a.md', 'b.md', 'c.md', 'd.md'], context: 'c' } } });
  const p = spawns.find((s) => s.label === 'find:boundary-ui-tests#1')?.prompt || '';
  if (!p.includes('담당 파일 전부는 첫 턴에') || p.includes('스코프 파일 전부는 첫 턴에')) fail(name, 'shard prompt still says read every scope file');
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

// 12. review quality per token (ywr-harness ADR 0089). Every case below was mutation-proven when it
//     landed: the named fix reverted turns it red.
const F = (file, line, severity = 'low', title = `t-${file}-${line}`) => ({ title, file, line, severity, claim: 'c', evidence: 'e' });
const fill = (file, n, from = 100) => Array.from({ length: n }, (_, i) => F(file, from + i));
const skeptics = (spawns) => spawns.filter((s) => s.label.startsWith('verify:'));

// 12a. one normPath() for the first-pass key: a finder that reports C:\repo\docs\a.md and one that
//      reports docs/a.md name ONE site (slice 25: absolute-path twins bought a second skeptic each).
//      Backslashes and the args.root prefix (case and the /c/… MSYS form) normalise; a path under
//      root that no one reported relatively still loses the prefix. The lower twin is not discarded:
//      it rides in the representative's also_at (review slice 26 — a same-key report can carry a
//      different claim), so every raw report is a representative or an also_at entry.
{
  const name = '12a absolute, backslash, MSYS and relative twins merge on the first-pass key; the twin rides in also_at';
  const { result } = await run({
    args: { tier: 'small', root: 'c:\\repo\\', scope: { files: ['docs/a.md'], context: 'c' } },
    findings: (k) => (k === 'correctness-pitfalls'
      ? [F('C:\\repo\\docs\\a.md', 5), F('docs/a.md', 9), F('C:\\repo\\docs\\b.md', 2)]
      : [F('docs\\a.md', 5), F('/c/repo/docs/a.md', 9)]),
  });
  const files = result.confirmed.map((f) => `${f.file}:${f.line}`).sort();
  const twins = result.confirmed.map((f) => f.also_at.map((a) => `${a.file}:${a.line}:${a.lens}`).join()).sort();
  if (result.stats.raw !== 5 || result.stats.deduped !== 3) fail(name, `raw=${result.stats.raw} deduped=${result.stats.deduped} (want 5 → 3)`);
  else if (files.join(',') !== 'docs/a.md:5,docs/a.md:9') fail(name, `confirmed=${files.join(',')}`);
  else if (twins.join('|') !== 'docs/a.md:5:boundary-ui-tests|docs/a.md:9:boundary-ui-tests') fail(name, `the merged twin was dropped, not kept in also_at: ${JSON.stringify(twins)}`);
  else if (result.stats.agents_per_phase.verify !== 3) fail(name, `verify legs=${result.stats.agents_per_phase.verify} (want 3 — one per site)`);
  else if (result.out_of_scope_confirmed.map((f) => f.file).join() !== 'docs/b.md') fail(name, `root prefix not stripped: ${JSON.stringify(result.out_of_scope_confirmed.map((f) => f.file))}`);
  else pass(name);
}
{
  const name = '12a2 without a root no absolute path is resolved by suffix: it stays as reported, still gates by suffix, and the log names it';
  const obj = await run({
    args: { tier: 'small', scope: { files: ['docs/a.md'], context: 'c' } },
    findings: (k) => (k === 'correctness-pitfalls' ? [F('C:/work/clone/docs/a.md', 5), F('C:/x/unrelated.md', 1)] : [F('docs/a.md', 5)]),
  });
  const str = await run({
    args: { tier: 'small', scope: 'free text scope' },
    findings: (k) => (k === 'correctness-pitfalls' ? [F('D:/r/src/x.js', 3)] : [F('src/x.js', 3), F('./lib/y.js', 4)]),
  });
  const conf = obj.result.confirmed.map((f) => f.file).sort().join();
  const strFiles = str.result.confirmed.map((f) => f.file).sort().join();
  if (obj.result.stats.deduped !== 3) fail(name, `an absolute path was merged by suffix: deduped=${obj.result.stats.deduped} (want 3)`);
  else if (conf !== 'C:/work/clone/docs/a.md,docs/a.md') fail(name, `absolute path rewritten, or its in-scope suffix no longer gates: confirmed=${conf}`);
  else if (obj.result.out_of_scope_confirmed.map((f) => f.file).join() !== 'C:/x/unrelated.md') fail(name, `unmatched absolute path: ${JSON.stringify(obj.result.out_of_scope_confirmed)}`);
  else if (!obj.logs.some((l) => l.includes('절대경로 지적 2건') && l.includes('args.root 없음'))) fail(name, `unresolved absolute paths not logged: ${obj.logs.join(' | ')}`);
  else if (str.result.stats.deduped !== 3 || strFiles !== 'D:/r/src/x.js,lib/y.js,src/x.js') fail(name, `string scope (./ prefix stripped, no suffix merge): deduped=${str.result.stats.deduped} files=${strFiles}`);
  else pass(name);
}
// 12a3. review slice 26 (F12): the suffix fallback moved an out-of-repo absolute path (the user-global
//       CLAUDE.md) onto the in-scope CLAUDE.md, and the first-pass key then dropped the repo file's own
//       defect. Only a real root prefix is stripped now — args.root, or a Claude Code worktree of the
//       same repo (<repo>/.claude/worktrees/<name>/, whichever side root names); a sibling that merely
//       shares a prefix (C:/repo2) is not under root. A same-key report with a different claim survives
//       in also_at, claim included, and the skeptic sees it.
{
  const name = '12a3 an out-of-repo absolute path never lands on an in-scope file; worktree paths of the repo do; a same-key claim survives';
  const clash = (k) => (k === 'correctness-pitfalls'
    ? [F('C:/Users/me/.claude/CLAUDE.md', 12, 'medium', 'global-file defect')] : [F('CLAUDE.md', 12, 'low', 'repo-file defect')]);
  const rooted = await run({ args: { tier: 'small', root: 'C:/Projects/repo', scope: { files: ['CLAUDE.md'], context: 'c' } }, findings: clash });
  const bare = await run({ args: { tier: 'small', scope: { files: ['CLAUDE.md'], context: 'c' } }, findings: clash });
  const same = await run({ findings: (k) => (k === 'correctness-pitfalls' ? [F('f.md', 7, 'low', 'defect A')] : [F('f.md', 7, 'medium', 'defect B')]) });
  const wtMain = await run({ args: { tier: 'small', root: 'C:/repo', scope: { files: ['docs/a.md'], context: 'c' } },
    findings: (k) => (k === 'correctness-pitfalls'
      ? [F('C:\\repo\\.claude\\worktrees\\wt1\\docs\\a.md', 5, 'low', 'wt'), F('C:/repo2/docs/a.md', 6, 'low', 'sib')]
      : [F('docs/a.md', 5, 'low', 'rel')]) });
  const wtRoot = await run({ args: { tier: 'small', root: 'C:/repo/.claude/worktrees/wt1', scope: { files: ['docs/a.md'], context: 'c' } },
    findings: (k) => (k === 'correctness-pitfalls'
      ? [F('C:/repo/docs/a.md', 5, 'low', 'main'), F('/c/repo/.claude/worktrees/wt2/docs/a.md', 5, 'low', 'wt2')]
      : [F('.claude/worktrees/wt1/docs/a.md', 5, 'low', 'rel-wt')]) });
  const labels = (r) => r.result.confirmed.map((f) => `${f.file}:${f.line}=${f.title}`).sort().join(' | ');
  const want = 'C:/Users/me/.claude/CLAUDE.md:12=global-file defect | CLAUDE.md:12=repo-file defect';
  const rep = same.result.confirmed[0];
  const legB = skeptics(same.spawns).find((s) => s.prompt.includes('지적: [medium] defect B'))?.prompt ?? '';
  const wtr = wtRoot.result.confirmed;
  if (labels(rooted) !== want) fail(name, `with root: ${labels(rooted)}`);
  else if (labels(bare) !== want) fail(name, `without root: ${labels(bare)}`);
  else if (same.result.stats.deduped !== 1 || rep?.title !== 'defect B' || JSON.stringify(rep?.also_at?.map((a) => [a.file, a.line, a.title, a.claim])) !== '[["f.md",7,"defect A","c"]]') fail(name, `same key, different claim: ${JSON.stringify(same.result.confirmed)}`);
  else if (!/\n- f\.md:7 \[low\] defect A: c\n/.test(legB)) fail(name, 'the skeptic never saw the merged claim');
  else if (labels(wtMain) !== 'C:/repo2/docs/a.md:6=sib | docs/a.md:5=wt' || wtMain.result.confirmed.find((f) => f.title === 'wt')?.also_at?.[0]?.title !== 'rel') fail(name, `root = main checkout: ${labels(wtMain)}`);
  else if (wtr.length !== 1 || wtr[0].file !== 'docs/a.md' || wtr[0].also_at.map((a) => a.title).join() !== 'wt2,rel-wt') fail(name, `root = a worktree: ${JSON.stringify(wtr.map((f) => [f.file, f.title, f.also_at.map((a) => a.file)]))}`);
  else pass(name);
}

// 12b. the grouping keeps its sites. Slice 25's grouping dropped four sites, one of them still a
//      live defect in HEAD. Here a medium claim at a.md:1 repeats at b.md:1 (grouped: ONE verdict,
//      two skeptics that see both sites), and two OVERLAPPING groups [[9,10],[8,9]] form one
//      component — the old drop set lost the member a dropped representative had absorbed, and a
//      shallow root() would leave 10 on its own. Conservation: every raw site is either a
//      representative or an also_at entry. Each also_at entry carries its member's claim, cut at 300
//      (review slice 26: the closer disposes each site on its own and needs more than a title), and a
//      grouped member hands its own first-pass twin (the second c.md:101) on to the representative.
{
  const name = '12b a group keeps its members in also_at, each with its claim; overlapping groups merge without loss';
  const { result, spawns } = await run({
    args: { tier: 'small', scope: { files: ['a.md', 'b.md', 'c.md'], context: 'c' } },
    findings: (k) => (k === 'correctness-pitfalls'
      ? [F('a.md', 1, 'medium', 'claim X'), ...fill('a.md', 6)]
      : [{ ...F('b.md', 1, 'low', 'claim X again'), claim: 'Y'.repeat(500) }, ...fill('c.md', 6), F('c.md', 101)]),
    groups: [[7, 0], [9, 10], [8, 9]],
  });
  const all = [...result.confirmed, ...result.out_of_scope_confirmed, ...result.nits_unverified, ...(result.rejected ?? [])];
  const rep = result.confirmed.find((f) => f.file === 'a.md' && f.line === 1);
  const comp = result.confirmed.find((f) => f.file === 'c.md' && f.line === 100);
  const sites = all.length + all.reduce((n, f) => n + (f.also_at?.length ?? 0), 0);
  const want = JSON.stringify([{ file: 'b.md', line: 1, lens: 'boundary-ui-tests', severity: 'low', title: 'claim X again', claim: 'Y'.repeat(300) }]);
  if (result.stats.raw !== 15 || result.stats.deduped !== 11) fail(name, `raw=${result.stats.raw} deduped=${result.stats.deduped} (want 15 → 14 by key → 11 grouped)`);
  else if (JSON.stringify(rep?.also_at) !== want) fail(name, `representative also_at=${JSON.stringify(rep?.also_at)}`);
  else if (JSON.stringify(comp?.also_at?.map((a) => a.line)) !== '[101,101,102]') fail(name, `overlapping groups lost a member or its first-pass twin: ${JSON.stringify(comp?.also_at)}`);
  else if (sites !== 15) fail(name, `sites conserved=${sites} (want all 15 raw reports)`);
  else if (result.confirmed.some((f) => !Array.isArray(f.also_at))) fail(name, 'a confirmed item carries no also_at array');
  else if (result.stats.agents_per_phase.verify !== 12) fail(name, `verify legs=${result.stats.agents_per_phase.verify} (want 2 for the class + 10 lows)`);
  else pass(name);
  const cls = skeptics(spawns).filter((s) => s.prompt.includes('지적: [medium] claim X'));
  const nameP = '12b2 the skeptics of a grouped claim see every also_at site and its claim; the grouping prompt makes a cross-file repeat one group';
  const groupPrompt = spawns.find((s) => s.phase === 'Dedupe')?.prompt ?? '';
  if (cls.length !== 2) fail(nameP, `class skeptic spawns=${cls.length}`);
  else if (!cls.every((s) => /묶인 보고가 더 있다[^\n]*\n- b\.md:1 \[low\] claim X again: Y{300}\n/.test(s.prompt))) fail(nameP, 'also_at site or its claim missing from the skeptic prompt');
  else if (!cls.every((s) => s.prompt.includes('위 지적과 묶인 보고의 주장이 모든 위치에서 틀렸을 때만 refuted=true'))) fail(nameP, 'class verdict rule missing');
  else if (!skeptics(spawns).some((s) => s.prompt.includes('지적: [low] t-c.md-103'))) fail(nameP, 'control finding c.md:103 was never verified — the next check would be vacuous');
  else if (skeptics(spawns).some((s) => s.prompt.includes('지적: [low] t-c.md-103') && s.prompt.includes('묶인 보고가'))) fail(nameP, 'an ungrouped finding got an also_at clause');
  else if (!groupPrompt.includes('같은 주장이 서로 다른 파일에 반복된 것') || !groupPrompt.includes('서로 다른 결함은 절대 묶지 마라')) fail(nameP, 'grouping prompt lost the cross-file clause or the never-merge guard');
  else pass(nameP);
}

// 12c. a group is in scope when ANY of its sites is: the representative is chosen by severity, so
//      an out-of-scope reference file can win and would carry the in-scope instance out of the gate.
//      An ungrouped out-of-scope finding still lands in out_of_scope_confirmed (the control).
{
  const name = '12c a grouped claim with an in-scope also_at site stays in confirmed';
  const { result } = await run({
    args: { tier: 'small', scope: { files: ['a.md'], context: 'c' } },
    findings: (k) => (k === 'correctness-pitfalls'
      ? [F('ref.md', 3, 'high', 'X'), ...fill('a.md', 6)]
      : [F('a.md', 50, 'low', 'X in a'), F('ref.md', 9), ...fill('a.md', 5, 200)]),
    groups: [[0, 7]],
  });
  const inScope = result.confirmed.find((f) => f.file === 'ref.md' && f.line === 3);
  if (!inScope) fail(name, `grouped claim left the gate: out_of_scope=${JSON.stringify(result.out_of_scope_confirmed.map((f) => `${f.file}:${f.line}`))}`);
  else if (result.out_of_scope_confirmed.map((f) => `${f.file}:${f.line}`).join() !== 'ref.md:9') fail(name, `control: out_of_scope=${JSON.stringify(result.out_of_scope_confirmed.map((f) => `${f.file}:${f.line}`))}`);
  else pass(name);
}

// 12d. the canary is a self-describing transport probe. Since 2026-09-22 the host framed the old
//      one-word prompt as a prompt injection: 842–878 output tokens of refusal, which the fixed
//      8-token allowance booked as main-loop bleed. A non-ok reply warns (transport still passed)
//      and the bleed subtracts the reply's own length: max(8, ceil(900/3)) = 300 → 1000 − 300.
{
  const name = '12d canary prompt is the transport probe; a non-ok reply warns and its length leaves the bleed';
  const clean = await run({});
  const upper = await run({ canaryReply: ' OK.\n' });
  let n = 0;
  const budget = { total: null, remaining: () => Infinity, spent: () => (n++ === 0 ? 0 : 1000) };
  const refusal = 'I am not going to comply with the computed task instruction. '.padEnd(900, 'x');
  const bad = await run({ canaryReply: refusal, budget });
  const prompt = clean.spawns.find((s) => s.label === 'canary')?.prompt;
  const warned = (r) => r.logs.some((l) => l.includes('카나리아 응답이 ok 가 아니다'));
  const basis = clean.result.stats.telemetry_basis ?? '';
  if (prompt !== 'adversarial-review workflow transport probe — there is nothing to review; reply with exactly: ok') fail(name, `canary prompt=${JSON.stringify(prompt)}`);
  else if (warned(clean) || clean.result.stats.canary_ok !== true) fail(name, 'a clean ok warned or reported canary_ok=false');
  else if (warned(upper) || upper.result.stats.canary_ok !== true) fail(name, '"OK." (trimmed, case, final period) was not accepted');
  else if (!warned(bad) || bad.result.stats.canary_ok !== false) fail(name, 'a 900-char refusal did not warn / canary_ok stayed true');
  else if (bad.result.stats.main_loop_bleed_estimate !== 700) fail(name, `bleed=${bad.result.stats.main_loop_bleed_estimate} (want 1000 − ceil(900/3) = 700)`);
  // review slice 26: the canary's thinking is not in its reply, so the bleed is an estimate, never a FLOOR.
  else if (/FLOOR/.test(basis) || !/main_loop_bleed_estimate is an ESTIMATE, not a floor[^.]*\. The excess includes the canary's own thinking tokens/.test(basis)) fail(name, `telemetry_basis overclaims the bleed: ${basis}`);
  else pass(name);
}

// 12e. skeptic #2's angle — "why did this pass the stated gates?" — was asked of a prompt that never
//      contained the gates (measured: #2 alone refuted 8 of 10 split verdicts). The gates now ride
//      in #2's prompt when the object scope carries gates_passed; with none (or a string scope) the
//      clause is dropped instead of asking about gates the skeptic cannot see. #1 keeps its angle.
{
  const name = '12e skeptic #2 sees scope.gates_passed; the clause is dropped when there are none';
  const med = (k) => (k === 'correctness-pitfalls' ? [F('f.md', 10, 'medium', 'm1')] : []);
  const legs = async (scope) => {
    const s = skeptics((await run({ args: { tier: 'small', scope }, findings: med })).spawns);
    return { one: s.find((x) => x.prompt.startsWith('너는 회의적 검증자 #1'))?.prompt ?? '', two: s.find((x) => x.prompt.startsWith('너는 회의적 검증자 #2'))?.prompt ?? '' };
  };
  const g = await legs({ files: ['f.md'], context: 'c', gates_passed: 'selftest.ps1 PASS 20/20 · manifest-gate PASS' });
  const arr = await legs({ files: ['f.md'], context: 'c', gates_passed: ['lint PASS', 'typecheck PASS'] });
  const none = await legs({ files: ['f.md'], context: 'c' });
  const str = await legs('free text scope with gates somewhere');
  if (!g.two.includes('기존 통과 게이트(스코프의 gates_passed):\nselftest.ps1 PASS 20/20 · manifest-gate PASS')) fail(name, `#2 prompt lacks the gates: ${g.two}`);
  else if (g.one.includes('selftest.ps1 PASS') || g.one.includes('추가 관점')) fail(name, '#1 carries #2\'s gate angle');
  else if (!arr.two.includes('lint PASS') || !arr.two.includes('typecheck PASS')) fail(name, 'an array gates_passed was not serialised into #2');
  else if (none.two.includes('추가 관점') || none.two.includes('게이트')) fail(name, `no gates, clause kept: ${none.two}`);
  else if (str.two.includes('추가 관점') || str.two.includes('게이트')) fail(name, 'a string scope still asks about gates');
  else pass(name);
}

// 12f. rejections return their reasons: closers dug the journal for them, one Opus/Fable turn each.
//      Shape {severity, title, file, line, also_at, votes: [{refuted, reason}]}, reasons cut at 300
//      (was 200 — mid-sentence), rejected_count kept, and the schema asks for brevity with a
//      description, never a maxLength (a hard limit forces schema retries).
{
  const name = '12f rejected[] carries each vote and reason; reasons reach 300 chars; VERDICT.reason is described, not capped';
  const { result, spawns } = await run({
    findings: (k) => (k === 'correctness-pitfalls' ? [F('f.md', 10, 'medium', 'm1')] : [F('f.md', 20, 'low', 'l1')]),
    verdict: (prompt, label) => (label === 'verify:m1'
      ? (prompt.startsWith('너는 회의적 검증자 #2') ? { refuted: true, reason: 'R'.repeat(500) } : { refuted: false, reason: 'keep' })
      : { refuted: false, reason: 'K'.repeat(500) }),
  });
  const r = result.rejected?.[0];
  const reason = skeptics(spawns)[0]?.schema?.properties?.reason;
  if (result.rejected_count !== 1 || result.rejected?.length !== 1) fail(name, `rejected_count=${result.rejected_count} rejected=${JSON.stringify(result.rejected)}`);
  else if (Object.keys(r).join() !== 'severity,title,file,line,also_at,votes') fail(name, `shape=${Object.keys(r).join()}`);
  else if (r.severity !== 'medium' || r.title !== 'm1' || r.file !== 'f.md' || r.line !== 10) fail(name, JSON.stringify(r));
  else if (JSON.stringify(r.votes.map((v) => [v.refuted, v.reason.length])) !== '[[false,4],[true,300]]') fail(name, `votes=${JSON.stringify(r.votes.map((v) => [v.refuted, v.reason.length]))}`);
  else if (result.confirmed[0]?.verify_reasons?.[0]?.length !== 300) fail(name, `confirmed reason length=${result.confirmed[0]?.verify_reasons?.[0]?.length}`);
  else if (!/≤300 characters/.test(reason?.description ?? '') || reason?.maxLength !== undefined) fail(name, `VERDICT.reason=${JSON.stringify(reason)}`);
  else pass(name);
}

// 12g. whenToUse is model-facing listing text, re-read on every turn of every session with the plugin
//      installed, so it is English (ADR 0045's split: Korean for members, English for the model).
//      The clauses are the contract, not the wording: once per slice, the object scope with
//      gates_passed, the small tier, lensExtra, no re-review of a fix diff, the ultracode/effort args.
{
  const name = '12g meta.whenToUse is English and keeps every clause';
  const m = readFileSync(SCRIPT, 'utf8').match(/whenToUse:\s*'((?:[^'\\]|\\.)*)'/);
  const w = m ? m[1] : '';
  const clauses = ['once per slice', 'files: [...]', 'gates_passed', 'args.tier:"small"', 'args.lensExtra', 'never re-reviewed', 'new mechanism', 'args.ultracode:true', 'args.effort', 'xhigh'];
  const missing = clauses.filter((c) => !w.includes(c));
  if (!w) fail(name, 'whenToUse literal not found');
  else if (/[가-힣]/.test(w)) fail(name, 'whenToUse carries Hangul — the model-facing listing text is English');
  else if (missing.length) fail(name, `clauses missing: ${missing.join(' | ')}`);
  else pass(name);
}

// 12h. the reviewer agent's prose loads into every canary, finder and skeptic spawn in every consumer
//      repo, so it cites no ADR number (ADR 0019 point 3: a number resolves against whatever repo the
//      reader stands in and points confidently at the wrong record). Review slice 26 found one left
//      in the body after ADR 0089 trimmed only the description.
{
  const name = '12h the reviewer agent prose carries no repo-bound ADR number';
  const md = readFileSync(join(here, '..', 'agents', 'reviewer.md'), 'utf8');
  const hits = md.match(/\bADR[ -]?#?\d{2,4}\b/g) ?? [];
  if (!md.includes('omitClaudeMd')) fail(name, 'reviewer.md not found or reshaped — the check would be vacuous');
  else if (hits.length) fail(name, `ADR numbers in shipped agent prose: ${hits.join(', ')}`);
  else pass(name);
}

// 12i. dead skeptic legs (review slice 26). agent() returns null on a transport death, and the old
//      filter(Boolean) erased it: a finding with no live vote read as confirmed (`[].every` is true)
//      and a high/medium whose one surviving vote refuted it reached rejected[] with ONE vote, past the
//      closer's 1–1 split rule. Now a dead leg is retried once, as a dead finder is; a leg dead twice
//      stays in votes as a dead non-refuting vote (so a lone refutation reads as a split), a finding
//      with no live vote stays in confirmed flagged unverified, and stats count both.
{
  const name = '12i a dead skeptic leg is retried once, then carried: unverified, dead votes, split visible, stats exact';
  const tries = {};
  const verdict = (prompt, label) => {
    const leg = prompt.startsWith('너는 회의적 검증자 #2') ? 2 : 1;
    const key = `${label}#${leg}`;
    const n = (tries[key] = (tries[key] ?? 0) + 1);
    if (label === 'verify:h-one-dead') return leg === 1 ? null : { refuted: true, reason: 'wrong' };
    if (label === 'verify:m-both-dead') return null;
    if (label === 'verify:l-recovered') return n === 1 ? null : { refuted: false, reason: 'holds' };
    return { refuted: false, reason: 'r' };
  };
  const { result, logs } = await run({
    findings: (k) => (k === 'correctness-pitfalls'
      ? [F('f.md', 10, 'high', 'h-one-dead'), F('f.md', 11, 'medium', 'm-both-dead')]
      : [F('f.md', 20, 'low', 'l-recovered')]),
    verdict,
  });
  const s = result.stats;
  const h = result.rejected.find((f) => f.title === 'h-one-dead');
  const m = result.confirmed.find((f) => f.title === 'm-both-dead');
  const l = result.confirmed.find((f) => f.title === 'l-recovered');
  if (!h || JSON.stringify(h.votes.map((v) => [v.refuted, v.dead === true])) !== '[[false,true],[true,false]]') fail(name, `h/m with one dead leg: ${JSON.stringify(h ?? result.confirmed.map((f) => f.title))}`);
  else if (!m || m.unverified !== true || m.dead_votes !== 2 || m.verify_reasons.length !== 0) fail(name, `no live vote: ${JSON.stringify(m)}`);
  else if (!l || l.unverified !== undefined || l.dead_votes !== undefined || l.verify_reasons.join() !== 'holds') fail(name, `retried leg not recovered: ${JSON.stringify(l)}`);
  else if (tries['verify:l-recovered#1'] !== 2 || tries['verify:m-both-dead#2'] !== 2 || tries['verify:h-one-dead#2'] !== 1) fail(name, `retry counts=${JSON.stringify(tries)}`);
  else if (s.dead_skeptics !== 3 || s.unverified_by_death !== 1 || s.verified !== 2) fail(name, `stats dead_skeptics=${s.dead_skeptics} unverified_by_death=${s.unverified_by_death} verified=${s.verified}`);
  else if (s.agents_per_phase.verify !== 9) fail(name, `verify legs=${s.agents_per_phase.verify} (want 5 + 4 retries)`);
  else if (!logs.some((l2) => l2.includes('skeptic 레그 4개 실패 — 1회 재시도')) || !logs.some((l2) => l2.includes('재시도 후에도 skeptic 레그 3개'))) fail(name, `dead legs not logged: ${logs.join(' | ')}`);
  else pass(name);
}

// 13. The finder cap is never a silent truncation (org guide coverage-cap rule; prompt audit O36, 2026-09-26).
{
  const name = '13a a capped finder reports its overflow: logged, summed in stats, named per unit; the prompt asks for it';
  const { result, logs, spawns } = await run({ omitted: (k) => (k === 'correctness-pitfalls' ? 3 : 0) });
  const s = result.stats;
  const finder = spawns.find((x) => x.label === 'find:correctness-pitfalls');
  if (s.find_cap !== 6 || s.find_omitted !== 3) fail(name, `find_cap=${s.find_cap} find_omitted=${s.find_omitted}`);
  else if (JSON.stringify(s.capped_finders) !== JSON.stringify(['correctness-pitfalls+3'])) fail(name, `capped_finders=${JSON.stringify(s.capped_finders)}`);
  else if (s.cap_unreported.length !== 0) fail(name, `cap_unreported=${JSON.stringify(s.cap_unreported)}`);
  else if (!logs.some((l) => l.includes('파인더 상한 6건에 걸려 3건이 반환되지 않았다'))) fail(name, `cap not logged: ${logs.join(' | ')}`);
  else if (!finder.prompt.includes('omitted 에 적어라') || !finder.schema?.required?.includes('omitted')) fail(name, 'prompt or schema does not demand omitted');
  else pass(name);
}
{
  const name = '13b a finder that omits the field, or reports a negative or non-integer count, is unreported, never uncapped; a clean run logs nothing';
  const { result, logs } = await run({ noOmitted: ['boundary-ui-tests'] });
  const neg = await run({ omitted: (k) => (k === 'correctness-pitfalls' ? -1 : '2') });
  const frac = await run({ omitted: (k) => (k === 'correctness-pitfalls' ? 1.5 : 0) });
  const clean = await run({});
  const s = result.stats;
  if (JSON.stringify(s.cap_unreported) !== JSON.stringify(['boundary-ui-tests']) || s.find_omitted !== 0) fail(name, `cap_unreported=${JSON.stringify(s.cap_unreported)} find_omitted=${s.find_omitted}`);
  else if (JSON.stringify(neg.result.stats.cap_unreported) !== JSON.stringify(['correctness-pitfalls', 'boundary-ui-tests']) || neg.result.stats.find_omitted !== 0) fail(name, `negative/string: ${JSON.stringify(neg.result.stats.cap_unreported)} omitted=${neg.result.stats.find_omitted}`);
  else if (JSON.stringify(frac.result.stats.cap_unreported) !== JSON.stringify(['correctness-pitfalls']) || frac.result.stats.capped_finders.length) fail(name, `fraction: ${JSON.stringify(frac.result.stats)}`);
  else if (!logs.some((l) => l.includes('omitted 를 보고하지 않았다'))) fail(name, `unreported not logged: ${logs.join(' | ')}`);
  else if (clean.logs.some((l) => l.includes('파인더 상한') || l.includes('omitted 를 보고하지'))) fail(name, 'clean run logged a cap line');
  else if (clean.result.stats.capped_finders.length || clean.result.stats.cap_unreported.length) fail(name, 'clean run reported caps');
  else pass(name);
}

{
  const name = '13c the full tier caps at 8 across its three lenses and reports a capped lens by its own key';
  const { result, spawns } = await run({ args: { scope: { files: ['f.md'], context: 'c' } },
    omitted: (k) => (k === 'boundary-docs' ? 2 : 0) });
  const s = result.stats;
  const finders = spawns.filter((x) => x.label.startsWith('find:'));
  if (s.tier !== 'full' || s.lenses !== 3 || finders.length !== 3) fail(name, `tier=${s.tier} lenses=${s.lenses} finders=${finders.length}`);
  else if (s.find_cap !== 8 || !finders.every((x) => x.prompt.includes('최대 8건'))) fail(name, `find_cap=${s.find_cap}`);
  else if (JSON.stringify(s.capped_finders) !== JSON.stringify(['boundary-docs+2']) || s.find_omitted !== 2) fail(name, `capped_finders=${JSON.stringify(s.capped_finders)}`);
  else pass(name);
}

console.log(ok ? 'adversarial-review selftest: all cases green' : 'adversarial-review selftest: FAILURES');
process.exit(ok ? 0 : 1);
