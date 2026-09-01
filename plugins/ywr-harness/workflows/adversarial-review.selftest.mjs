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
    spawns.push({ label, model: opts.model, effort: opts.effort, agentType: opts.agentType, prompt });
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

// 10a. the worker identity (ywr-harness ADR 0069). Canary, finders and skeptics run as the plugin's
//     tool-restricted reviewer agent — the allowlist is what removes ~half of the prefix every
//     worker request re-reads, and it only takes effect through agentType. The name must be the
//     NAMESPACED form (fact 1: a bare name does not resolve, and manifest-gate does not scan
//     agentType strings — this assertion is the only gate on it). The dedupe grouping deliberately
//     stays on the default subagent (haiku; a model override on top of agentType is unmeasured).
{
  const name = 'canary/find/verify spawns run as the namespaced reviewer agent';
  const { spawns } = await run({});
  const workers = spawns.filter((s) => /^(canary$|find:|verify:)/.test(s.label));
  const wrong = workers.filter((s) => s.agentType !== 'ywr-harness:reviewer');
  const dedupe = spawns.filter((s) => s.label === 'dedupe:haiku');
  if (!workers.length) fail(name, 'no worker spawns captured');
  else if (wrong.length) fail(name, `agentType drifted: ${JSON.stringify(wrong.map((s) => [s.label, s.agentType]))}`);
  else if (dedupe.some((s) => s.agentType)) fail(name, 'dedupe should stay on the default subagent');
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

console.log(ok ? 'adversarial-review selftest: all cases green' : 'adversarial-review selftest: FAILURES');
process.exit(ok ? 0 : 1);
