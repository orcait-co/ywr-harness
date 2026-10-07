# Self-test for delegation-ledger.mjs, the plugin's observe-only hooks module (Claude Mods; ADR 0117,
# ADR 0118). Usage: pwsh plugins/ywr-harness/hooks/delegation-ledger.selftest.ps1
#
# CI has no claude CLI, so the module is driven here under plain node with a FAKE engine: a fake
# `on` captures the three hooks, a fake `$` answers session.root/id, clock.now and fs.exists/list/
# stat/read/write over an in-memory disk (one disk can be shared by two engines: two sessions in one repo),
# and each `next` is a stub whose result the hook must hand back untouched. What this suite proves is
# the contract the host cannot check for us: every hook is pass-through (the result `next` resolved to
# is returned as is, `turn.step` re-yields every chunk in order, the frozen event is never rewritten),
# the record is right for each loop kind (Agent-tool spawn / workflow `agent()` with no spawn / main),
# the ring of slot files is bounded (claim order, takeover, caps, serialized writes), nothing is
# written outside a `.harness.json` root, a failing write or engine call never reaches the turn, no
# message text is persisted, and memory is capped. What it cannot prove — the engine's own event
# shapes, its `mtimeMs` and that the host loads the module — is `claude plugin validate`'s and the
# live `--plugin-dir` run's (spec 0012 §3 Mods row); `claude plugin test` stays a local habit.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core
Assert-NodeOrExit 'delegation-ledger'
$mod = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'delegation-ledger.mjs'))

$probe = @'
import { pathToFileURL } from 'node:url'
const M = await import(pathToFileURL(process.argv[2]).href)
const results = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  results.push(g === w ? [name, 'OK'] : [name, 'FAIL got ' + g + ' want ' + w])
}
const deepFreeze = o => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o) } return o }
const ROOT = 'C:/repo', BARE = 'C:/bare'
const DIR = `${ROOT}/.claude/telemetry/delegations`
const slot = i => `${DIR}/slot-${String(i).padStart(2, '0')}.json`
const NOW = Date.UTC(2026, 9, 2, 1, 2, 3, 456)

// An in-memory disk: path -> { text, mtimeMs, size }; every write advances the shared tick.
const newDisk = () => ({ files: new Map(), tick: 1000 })
const put = (disk, p, text, mtimeMs = ++disk.tick) => disk.files.set(p, { text, mtimeMs, size: Buffer.byteLength(text) })
function listing(disk, dir) {
  const out = new Map()
  for (const [p, f] of disk.files) {
    if (!p.startsWith(dir + '/')) continue
    const rest = p.slice(dir.length + 1), cut = rest.indexOf('/')
    if (cut < 0) out.set(rest, { name: rest, kind: 'file', size: f.size, mtimeMs: f.mtimeMs, isLink: false })
    else out.set(rest.slice(0, cut), { name: rest.slice(0, cut), kind: 'directory', size: 0, mtimeMs: 0, isLink: false })
  }
  if (out.size === 0) { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err }
  return [...out.values()]
}

function engine({ root = ROOT, adopted = true, failWrite = 0, failId = 0, id = 'sess-1', disk = newDisk(), slowWrite = null } = {}) {
  const hooks = {}
  const on = (ev, a, b) => { hooks[ev] = b ?? a; return { catch() {} } }
  M.register(on, {})
  const writes = []
  const io = { active: 0, peak: 0 }
  const $ = {
    session: {
      root: async () => root,
      id: async () => { if (failId > 0) { failId--; throw new Error('no id') } return id },   // fails `failId` times
    },
    fs: {
      exists: async p => (adopted && p === `${root}/.harness.json`) || disk.files.has(p),
      list: async d => listing(disk, d),
      read: async p => { const f = disk.files.get(p); if (!f) throw new Error('ENOENT'); return f.text },
      stat: async p => { const f = disk.files.get(p); if (!f) throw new Error('ENOENT'); return { kind: 'file', size: f.size, mtimeMs: f.mtimeMs, isLink: false } },
      write: async (p, t) => {
        io.active++; io.peak = Math.max(io.peak, io.active)
        try {
          if (slowWrite) await slowWrite()
          if (failWrite > 0) { failWrite--; throw new Error('EACCES') }   // fails `failWrite` times
          put(disk, p, t); writes.push([p, JSON.parse(t)])
        } finally { io.active-- }
      },
    },
    clock: { now: async () => NOW },
  }
  return { hooks, $, writes, disk, io }
}
const last = E => E.writes[E.writes.length - 1]

// turn.step: the hook is an async generator over `next(e)`'s stream; drive it to the end and
// collect what it yields and what it returns.
// Every stub `next` records what it was handed: an observe-only hook passes the SAME frozen event on.
const handed = []
async function step(E, e, chunks, result) {
  const next = async function* (arg) { handed.push([e, arg]); for (const c of chunks) yield c; return result }
  const it = E.hooks['turn.step'](E.$, deepFreeze(e), next)
  const out = []
  for (;;) { const { value, done } = await it.next(); if (done) return { out, ret: value }; out.push(value) }
}
const spawn = (E, e, r) => E.hooks['agent.spawn'](E.$, deepFreeze(e), async arg => { handed.push([e, arg]); return r })
const complete = (E, e, r) => E.hooks['turn.complete'](E.$, deepFreeze(e), async arg => { handed.push([e, arg]); return r })
const loopEnd = (E, turnId, extra = {}) => complete(E, { durationMs: 1, turnId, reason: 'answer', ...extra }, {})
const throwing = (field, base = {}) => Object.defineProperty({ ...base }, field, { get() { throw new Error('boom') }, enumerable: true })

const SECRET = 'SECRET-TEXT-MUST-NOT-PERSIST'
const usage = (model, o) => ({ model, input_tokens: 10, output_tokens: o, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 })
const stepResult = (model, o) => ({ turnId: 't', index: 0, answer: SECRET, toolUses: [], stopReason: 'end_turn', usage: usage(model, o) })

eq('three hooks registered, no more', Object.keys(engine().hooks).sort(), ['agent.spawn', 'turn.complete', 'turn.step'])

// 1. Agent-tool path: spawn + two steps + complete -> one loop row in the session's slot file
{
  const E = engine()
  const sr = { model: 'claude-haiku-4-5', agentId: 'a1' }
  const got = await spawn(E, { tool_use_id: 'tu1', prompt: SECRET, description: SECRET, subagentType: 'ywr-harness:mech',
    provider: { plugin: 'ywr-harness', tier: 'user' }, parentModel: 'claude-opus-5-5', background: false, fork: false }, sr)
  eq('spawn: the result next resolved to is returned as is', got === sr, true)
  const chunks = [{ kind: 'text', index: 0, text: 'a' }, { kind: 'engine', ref: 7 }, { kind: 'stop', stopReason: 'end_turn', usage: null }]
  const r1 = stepResult('claude-haiku-4-5', 3)
  const s1 = await step(E, { turnId: 't1', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'a1' }, chunks, r1)
  eq('step: every chunk re-yielded, in order, same objects', s1.out.length === 3 && s1.out.every((c, i) => c === chunks[i]), true)
  eq('step: the stream result returned as is', s1.ret === r1, true)
  await step(E, { turnId: 't1', index: 1, model: 'claude-haiku-4-5', messageCount: 3, agentId: 'a1' }, [], stepResult('claude-haiku-4-5', 4))
  const cr = { text: SECRET, usage: usage('claude-haiku-4-5', 7) }
  const c = await complete(E, { answer: SECRET, durationMs: 1234, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer', usage: usage('claude-haiku-4-5', 7) }, cr)
  eq('complete: the result returned as is', c === cr, true)
  eq('agent-tool: one write, to <root>/<dir>/slot-00.json', E.writes.map(w => w[0]), [slot(0)])
  const f = E.writes[0][1]
  eq('file: schema 2, session, slot, updated, nothing dropped, one loop', [f.schema, f.session_id, f.slot, f.updated, f.loops_dropped, f.loops.length],
    [2, 'sess-1', 0, '2026-10-02T01:02:03.456Z', 0, 1])
  eq('file: loops is the last key (rendered by splicing)', Object.keys(f).at(-1), 'loops')
  const d = f.loops[0]
  eq('agent-tool: loop kind, ids, ts; no per-row schema or session', [d.loop, d.agent_id, d.turn_id, d.ts, 'schema' in d, 'session_id' in d],
    ['agent-tool', 'a1', 't1', '2026-10-02T01:02:03.456Z', false, false])
  eq('agent-tool: spawn row', d.spawn, { tool_use_id: 'tu1', subagent_type: 'ywr-harness:mech', provider: 'ywr-harness/user', model_param: null,
    parent_model: 'claude-opus-5-5', model: 'claude-haiku-4-5', denied: false, fork: false, background: false, teammate: false, workflow: null, parent_agent_id: null })
  eq('file: step_fields names the tuple order once', f.step_fields, ['index', 'model', 'effort', 'message_count', 'stop_reason', 'input_tokens',
    'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'usage_model'])
  eq('agent-tool: both steps as tuples, in order, with their usage; usage_model null when it equals model', d.steps,
    [[0, 'claude-haiku-4-5', null, 1, 'end_turn', 10, 3, 100, 5, null], [1, 'claude-haiku-4-5', null, 3, 'end_turn', 10, 4, 100, 5, null]])
  eq('agent-tool: models distinct, efforts empty on an effort-less model, no steps dropped', [d.models, d.efforts, d.steps_dropped], [['claude-haiku-4-5'], [], 0])
  eq('agent-tool: completion row', d.complete, { reason: 'answer', aborted: false, duration_ms: 1234,
    usage: { model: 'claude-haiku-4-5', input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } })
  eq('no message text persisted (prompt, description, answers)', [...E.disk.files.values()].some(x => x.text.includes(SECRET)), false)
}

// 2. a workflow agent() worker on a host before 2.1.292: steps with an agentId no spawn named -> 'unspawned'
{
  const E = engine()
  await step(E, { turnId: 'w', index: 0, model: 'claude-sonnet-5-5', effort: 'low', messageCount: 1, agentId: 'wf9' }, [], stepResult('claude-sonnet-5-5', 2))
  await complete(E, { answer: '', durationMs: 5, isAborted: false, turnId: 'w', agentId: 'wf9', reason: 'answer' }, { text: '' })
  const d = E.writes[0][1].loops[0]
  eq('unspawned: loop kind, spawn null, the inherited model and effort visible', [d.loop, d.spawn, d.models, d.efforts, d.complete.usage],
    ['unspawned', null, ['claude-sonnet-5-5'], ['low'], null])
}

// 2b. a workflow agent() worker on 2.1.292+: `agent.spawn` carries `workflow` -> kind 'workflow' (ADR 0126)
{
  const E = engine()
  const ev = { tool_use_id: 'tuW', subagentType: 'workflow-subagent', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5',
    background: false, fork: false, workflow: { runId: 'wf_f4acc9ea-92d', agentIndex: 1 } }
  await spawn(E, { ...ev, model: 'haiku' }, { model: 'claude-haiku-4-5', agentId: 'W1' })
  await spawn(E, { ...ev, workflow: { runId: 'wf_f4acc9ea-92d', agentIndex: 2 } }, { model: 'claude-opus-5-5', agentId: 'W2' })
  for (const [id, t, m] of [['W1', 'tW1', 'claude-haiku-4-5'], ['W2', 'tW2', 'claude-opus-5-5']]) {
    await step(E, { turnId: t, index: 0, model: m, messageCount: 1, agentId: id }, [], null)
    await complete(E, { durationMs: 2, turnId: t, agentId: id, reason: 'answer' }, {})
  }
  const [a, b] = last(E)[1].loops
  eq('workflow: kind workflow, workflow field mapped', [a.loop, a.spawn.workflow, a.spawn.subagent_type, a.spawn.model_param],
    ['workflow', { run_id: 'wf_f4acc9ea-92d', agent_index: 1 }, 'workflow-subagent', 'haiku'])
  eq('workflow without a model given: model_param null, resolved model kept', [b.loop, b.spawn.model_param, b.spawn.model, b.spawn.workflow.agent_index],
    ['workflow', null, 'claude-opus-5-5', 2])
  const E2 = engine()
  await spawn(E2, { ...ev, workflow: 'garbage' }, { model: 'm', agentId: 'W3' })
  await spawn(E2, { ...ev, workflow: {} }, { model: 'm', agentId: 'W4' })
  for (const [id, t] of [['W3', 'tW3'], ['W4', 'tW4']]) await complete(E2, { durationMs: 1, turnId: t, agentId: id, reason: 'answer' }, {})
  const [c, d] = last(E2)[1].loops
  eq('workflow: a non-object is no workflow; an empty object maps to nulls', [c.loop, c.spawn.workflow, d.loop, d.spawn.workflow],
    ['agent-tool', null, 'workflow', { run_id: null, agent_index: null }])
}

// 3. the main loop
{
  const E = engine()
  await step(E, { turnId: 'm1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 9 }, [], stepResult('claude-opus-5-5', 1))
  await complete(E, { answer: SECRET, durationMs: 9, isAborted: true, turnId: 'm1', reason: 'aborted' }, { text: '' })
  const d = E.writes[0][1].loops[0]
  eq('main: loop main, agent null, aborted', [d.loop, d.agent_id, d.turn_id, d.complete.aborted, d.complete.reason], ['main', null, 'm1', true, 'aborted'])
}

// 4. interleaved loops stay apart; a spawn row survives its agent's first run (a resumed agent);
//    each write carries every loop the session holds, in completion order
{
  const E = engine()
  await spawn(E, { tool_use_id: 'x', subagentType: 'Explore', model: 'haiku', parentModel: 'p', background: true, fork: false }, { model: 'claude-haiku-4-5', agentId: 'A' })
  await step(E, { turnId: 'tA', index: 0, model: 'mA', messageCount: 1, agentId: 'A' }, [], null)
  await step(E, { turnId: 'tB', index: 0, model: 'mB', messageCount: 1, agentId: 'B' }, [], null)
  await step(E, { turnId: 'tA', index: 1, model: 'mA', messageCount: 2, agentId: 'A' }, [], null)
  await complete(E, { durationMs: 1, turnId: 'tA', agentId: 'A', reason: 'answer' }, {})
  await complete(E, { durationMs: 1, turnId: 'tB', agentId: 'B', reason: 'error' }, {})
  await step(E, { turnId: 'tA2', index: 0, model: 'mA', messageCount: 5, agentId: 'A' }, [], null)
  await complete(E, { durationMs: 1, turnId: 'tA2', agentId: 'A', reason: 'answer' }, {})
  eq('every write rewrites the one slot, with every loop so far', [E.writes.map(w => w[0]), E.writes.map(w => w[1].loops.length)], [[slot(0), slot(0), slot(0)], [1, 2, 3]])
  const docs = last(E)[1].loops
  eq('interleaved: steps per loop', docs.map(d => [d.agent_id, d.steps.length]), [['A', 2], ['B', 1], ['A', 1]])
  eq('a null step result records null stop, tokens and usage_model, not a throw', docs[0].steps[0].slice(4), [null, null, null, null, null, null])
  eq('resumed agent: its second run still carries the spawn row', [docs[2].loop, docs[2].spawn?.model_param, docs[2].spawn?.background], ['agent-tool', 'haiku', true])
  eq('an errored loop is written with its reason', [docs[1].complete.reason, docs[1].steps.length], ['error', 1])
}

// 4b. an agent-team teammate (2.1.289+: `agent.spawn` with `isTeammate`): kind stays agent-tool, the row flags it
{
  const E = engine()
  await spawn(E, { tool_use_id: null, subagentType: 'researcher', parentModel: 'claude-opus-5-5', isTeammate: true }, { model: 'claude-sonnet-5-5', agentId: 'T1' })
  await step(E, { turnId: 'tT', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'T1' }, [], null)
  await complete(E, { durationMs: 2, turnId: 'tT', agentId: 'T1', reason: 'answer' }, {})
  const d = E.writes[0][1].loops[0]
  eq('teammate: agent-tool kind, schema 2', [d.loop, d.agent_id, E.writes[0][1].schema], ['agent-tool', 'T1', 2])
  eq('teammate: the whole spawn row (null tool_use_id joins by agentId)', d.spawn, { tool_use_id: null, subagent_type: 'researcher', provider: null,
    model_param: null, parent_model: 'claude-opus-5-5', model: 'claude-sonnet-5-5', denied: false, fork: false, background: false, teammate: true,
    workflow: null, parent_agent_id: null })
}

// 5. not adopted: a root without .harness.json gets nothing, the turn still gets its result
{
  const E = engine({ root: BARE, adopted: false })
  await step(E, { turnId: 'n', index: 0, model: 'm', messageCount: 1 }, [], null)
  const r = { text: 'x' }
  const got = await complete(E, { durationMs: 1, turnId: 'n', reason: 'answer' }, r)
  eq('outside a .harness.json root: no write, result returned', [E.writes.length, E.disk.files.size, got === r], [0, 0, true])
}

// 6. failures never reach the turn
{
  const E = engine({ failWrite: 1 })
  const r = { text: 'x' }
  eq('a throwing fs.write: complete still returns its result', (await complete(E, { durationMs: 1, turnId: 'f', reason: 'answer' }, r)) === r, true)
  await loopEnd(E, 'f2')
  eq('after a failed write the chain still runs: the next write carries both loops, same slot', [E.writes.length, last(E)[0], last(E)[1].loops.map(l => l.turn_id)], [1, slot(0), ['f', 'f2']])
  const F = engine({ failId: 1 })
  await step(F, { turnId: 'g', index: 0, model: 'm', messageCount: 1 }, [], null)
  eq('a throwing session.id: complete still returns its result', (await complete(F, { durationMs: 1, turnId: 'g', reason: 'answer' }, r)) === r, true)
  // the failed record still released its loop: the same key completing again (id now answers) has no steps
  await complete(F, { durationMs: 1, turnId: 'g', reason: 'answer' }, r)
  eq('a throwing session.id releases the loop (no leak): a re-complete finds no steps', [F.writes.length, last(F)[1].loops.length, last(F)[1].loops[0].steps.length], [1, 1, 0])
  const deny = { deny: 'no' }
  eq('a denied spawn: returned as is', (await spawn(F, { subagentType: 'x' }, deny)) === deny, true)
  const D = M.createLedger()
  D.spawn({ subagentType: 'x' }, deny)
  eq('a denied spawn keeps no row', D.sizes().spawns, 0)
  eq('a malformed step event does not throw out of the stream', (await step(F, {}, [], 5)).ret, 5)
}

// 6b. a throw inside the recording code itself (a result whose field throws) never escapes a hook
{
  const E = engine()
  const sr = throwing('agentId')
  eq('agent.spawn: a throwing result field is swallowed, result returned', (await spawn(E, { subagentType: 'x' }, sr)) === sr, true)
  const st = throwing('stopReason')
  eq('turn.step: a throwing result field is swallowed, result returned', (await step(E, { turnId: 'z', index: 0, model: 'm' }, [], st)).ret === st, true)
  const ce = { durationMs: 1, turnId: 'z', reason: 'answer' }
  Object.defineProperty(ce, 'usage', { get() { throw new Error('boom') }, enumerable: false })
  const r = { text: '' }
  eq('turn.complete: a throwing event field is swallowed, result returned', (await complete(E, ce, r)) === r, true)
}

// 7. the ring (ADR 0118): claim order, takeover, a missing slot, foreign entries
{
  const docAt = (d, i) => { const f = d.files.get(slot(i)); return f ? JSON.parse(f.text) : null }
  const disk = newDisk()
  const A = engine({ disk, id: 'sess-A' }), B = engine({ disk, id: 'sess-B' })
  await loopEnd(A, 'a1'); await loopEnd(B, 'b1'); await loopEnd(A, 'a2')
  eq('two sessions in one repo: the lowest missing slots, each its own', [A.writes.map(w => w[0]), B.writes.map(w => w[0])], [[slot(0), slot(0)], [slot(1)]])
  // another writer rewrites A's slot (a session that claimed it as the oldest): A moves on and takes its loops along
  put(disk, slot(0), '{"schema":2,"session_id":"intruder","loops":[]}\n')
  await loopEnd(A, 'a3')
  eq('a slot whose mtime/size moved is given up: A claims anew and writes all its loops there', [last(A)[0], last(A)[1].slot, last(A)[1].loops.map(l => l.turn_id)], [slot(2), 2, ['a1', 'a2', 'a3']])
  eq('the taker keeps the slot it took', JSON.parse(disk.files.get(slot(0)).text).session_id, 'intruder')
  disk.files.delete(slot(2))
  await loopEnd(A, 'a4')
  eq('a slot gone missing is rewritten in place', [last(A)[0], last(A)[1].loops.length], [slot(2), 4])
  // two sessions that claimed the same slot at once separate at the next write after the other's
  const disk2 = newDisk()
  const P = engine({ disk: disk2, id: 'sess-P' }), Q = engine({ disk: disk2, id: 'sess-Q' })
  await Promise.all([loopEnd(P, 'p1'), loopEnd(Q, 'q1')])
  eq('a simultaneous claim: both took slot-00', [P.writes[0][0], Q.writes[0][0]], [slot(0), slot(0)])
  await loopEnd(P, 'p2'); await loopEnd(Q, 'q2')
  eq('... and part at the next writes: each slot holds one whole session',
    [[last(P)[0], last(P)[1].loops.map(l => l.turn_id)], [last(Q)[0], last(Q)[1].loops.map(l => l.turn_id)]],
    [[slot(0), ['p1', 'p2']], [slot(1), ['q1', 'q2']]])
  // a failed write leaves no stat to compare: the file's own header decides, so a taker is never overwritten
  const disk3 = newDisk()
  const R = engine({ disk: disk3, id: 'sess-R' })
  await loopEnd(R, 'r1')
  R.$.fs.write = (w => async (p, t) => { R.$.fs.write = w; throw new Error('EIO') })(R.$.fs.write)   // the next write fails once
  await loopEnd(R, 'r2')
  put(disk3, slot(0), '{"schema":2,"session_id":"sess-T","slot":0,"loops":[]}')
  await loopEnd(R, 'r3')
  eq('after a failed write, a slot whose header names another session is given up', [last(R)[0], last(R)[1].loops.map(l => l.turn_id), JSON.parse(disk3.files.get(slot(0)).text).session_id],
    [slot(1), ['r1', 'r2', 'r3'], 'sess-T'])
  R.$.fs.stat = async () => { throw new Error('EIO') }   // every stat fails from here: the header is the only proof
  await loopEnd(R, 'r4'); await loopEnd(R, 'r5')
  eq('with stat failing, a slot whose header is our own is kept', [last(R)[0], last(R)[1].loops.length], [slot(1), 5])
  // with stat failing, a read that fails decides by existence: an unreadable file is never provably ours
  const readFails = (E, err) => { E.$.fs.read = async () => { throw new Error(err) } }
  disk3.files.set(slot(1), { ...disk3.files.get(slot(1)), text: '{"schema":2,"session_id":"sess-U","loops":[]}' })   // a foreign header, unreadable below
  readFails(R, 'EACCES')
  await loopEnd(R, 'r6')
  eq('a slot that exists but cannot be read (EACCES) is given up, never overwritten', [last(R)[0], last(R)[1].loops.length, docAt(disk3, 1)?.session_id],
    [slot(2), 6, 'sess-U'])
  disk3.files.delete(slot(2))
  await loopEnd(R, 'r7')
  eq('a read that fails on a missing slot keeps it: rewritten in place', [last(R)[0], last(R)[1].loops.length], [slot(2), 7])
  R.$.fs.exists = async p => { if (p.endsWith('.harness.json')) return true; throw new Error('EIO') }
  await loopEnd(R, 'r8')
  eq('a failed read whose existence check also fails is given up', [last(R)[0], last(R)[1].loops.length, docAt(disk3, 2)?.loops.length],
    [slot(3), 8, 7])
  // a null session id: written as null, but its header proves nothing (every id-less session writes it)
  const disk4 = newDisk()
  const Z = engine({ disk: disk4, id: null }), Y = engine({ disk: disk4 })
  Y.$.session.id = async () => undefined
  await loopEnd(Z, 'z1')
  eq('a null session id still records, as session_id null', [last(Z)[0], last(Z)[1].session_id], [slot(0), null])
  await loopEnd(Y, 'y1')
  eq('an undefined session id reads as null and claims its own slot', [last(Y)[0], last(Y)[1].session_id], [slot(1), null])
  Z.$.fs.stat = async () => { throw new Error('EIO') }
  for (const t of ['z2', 'z3', 'z4']) await loopEnd(Z, t)
  eq('with stat failing, a null id keeps its own slot by the fingerprint of its last write (no churn round the ring)',
    [Z.writes.map(w => w[0]), last(Z)[1].loops.length, disk4.files.size], [[slot(0), slot(0), slot(0), slot(0)], 4, 2])
  put(disk4, slot(0), '{"schema":2,"session_id":null,"slot":0,"loops":[{"turn_id":"other"}]}')
  await loopEnd(Z, 'z5')
  eq('... but never keeps one by its header alone: another id-less file at its slot survives',
    [last(Z)[0], last(Z)[1].loops.map(l => l.turn_id), docAt(disk4, 0)?.loops[0]?.turn_id], [slot(2), ['z1', 'z2', 'z3', 'z4', 'z5'], 'other'])
  Z.$.fs.write = (w => async (p, t) => { Z.$.fs.write = w; await w(p, t.slice(0, 40)); throw new Error('EIO') })(Z.$.fs.write)   // a partial write, then a throw
  await loopEnd(Z, 'z6')
  await loopEnd(Z, 'z7')
  eq('after a failed write the fingerprint is void: a null id gives up its partial file (unprovable) and claims anew',
    [last(Z)[0], last(Z)[1].loops.length], [slot(3), 7])
  eq('fingerprint: same text same mark, a one-char change differs, empty is the FNV basis',
    [M.fingerprint('{"a":1}') === M.fingerprint('{"a":1}'), M.fingerprint('{"a":1}') === M.fingerprint('{"a":2}'), M.fingerprint('')], [true, false, 0x811c9dc5])
  // a stat that fails right after a good write proves nothing: a taker in that window is never overwritten
  const disk5 = newDisk()
  const V = engine({ disk: disk5, id: 'sess-V' })
  await loopEnd(V, 'v1')
  V.$.fs.stat = async () => { throw new Error('EIO') }
  put(disk5, slot(0), '{"schema":2,"session_id":"sess-W","slot":0,"loops":[]}')
  await loopEnd(V, 'v2')
  eq('a failing pre-write stat falls to the read-back: a slot taken meanwhile is given up', [last(V)[0], last(V)[1].loops.length, docAt(disk5, 0)?.session_id],
    [slot(1), 2, 'sess-W'])
  // a full ring: a new session takes the oldest slot; per-loop files of the 0.62.0 dev tree are left alone
  const full = newDisk()
  for (let i = 0; i < 20; i++) put(full, slot(i), '{}', 5000 + (i === 7 ? -100 : i))
  put(full, `${DIR}/sess-old/20261002T000000000Z-main-t.json`, '{"schema":1}', 1)
  const N = engine({ disk: full, id: 'sess-N' })
  await loopEnd(N, 'n1')
  eq('a full ring: the oldest slot by mtime is taken; the dev-tree directory untouched', [last(N)[0], full.files.get(`${DIR}/sess-old/20261002T000000000Z-main-t.json`).text], [slot(7), '{"schema":1}'])
}

// 7b. pickSlot, the pure claim rule
{
  const f = (name, mtimeMs, kind = 'file', isLink = false) => ({ name, kind, size: 1, mtimeMs, isLink })
  const all = Array.from({ length: 20 }, (_, i) => f(`slot-${String(i).padStart(2, '0')}.json`, 100 + i))
  eq('pickSlot: no entries -> slot 0; an unreadable listing -> slot 0', [M.pickSlot([]), M.pickSlot(undefined)], [0, 0])
  eq('pickSlot: the lowest missing slot wins over any oldest', M.pickSlot([f('slot-00.json', 1), f('slot-02.json', 9)]), 1)
  eq('pickSlot: all present -> the oldest mtime', M.pickSlot(all.map((e, i) => i === 13 ? { ...e, mtimeMs: 5 } : e)), 13)
  eq('pickSlot: equal mtimes -> the lowest number', M.pickSlot(all.map(e => ({ ...e, mtimeMs: 7 }))), 0)
  eq('pickSlot: a directory or a link at a slot name is never claimed', M.pickSlot(all.map((e, i) => i === 0 ? f(e.name, 0, 'directory') : i === 1 ? f(e.name, 0, 'other', true) : e)), 2)
  eq('pickSlot: nothing claimable -> null', M.pickSlot(all.map(e => f(e.name, 0, 'directory'))), null)
  eq('pickSlot: names outside the ring are ignored', M.pickSlot([...all, f('slot-20.json', 0), f('slot-0.json', 0)]), 0)
}

// 7c. the session map evicts the least recently used: an active session keeps its slot and its loops
{
  const E = engine()
  let id = 's0'
  E.$.session.id = async () => id
  await loopEnd(E, 'first')
  for (const n of ['s1', 's2', 's3', 's4', 's5']) { id = n; await loopEnd(E, n); id = 's0'; await loopEnd(E, 'again-' + n) }
  const s0 = E.writes.filter(w => w[1].session_id === 's0').at(-1)
  eq('LRU: a session touched between newcomers is never evicted (one slot, every loop)', [s0[0], s0[1].loops.length], [slot(0), 6])
}

// 8. serialized writes per session
{
  const E = engine({ slowWrite: () => new Promise(r => setTimeout(r, 5)) })
  await Promise.all([loopEnd(E, 's1'), loopEnd(E, 's2'), loopEnd(E, 's3')])
  eq('three loops ending together: their rewrites never overlap', E.io.peak, 1)
  eq('... and the last write holds all three, in completion order', last(E)[1].loops.map(l => l.turn_id), ['s1', 's2', 's3'])
}

eq('pass-through: every next() was handed the very event the hook received (' + handed.length + ' calls)',
  handed.length > 0 && handed.every(([e, arg]) => arg === e), true)

// 9. bookkeeping bounds
{
  const L = M.createLedger({ maxOpen: 2 })
  for (const t of ['a', 'b', 'c']) L.step({ turnId: t, index: 0, model: 'm' }, null)
  eq('open loops capped at maxOpen (oldest dropped)', L.sizes().open, 2)
  eq('the dropped loop completes with no steps', L.complete({ turnId: 'a' }, { iso: 'x' }).steps.length, 0)
  for (const a of ['1', '2', '3']) L.spawn({ subagentType: 't' }, { model: 'm', agentId: a })
  eq('spawn rows are NOT capped by maxOpen (they outlive their loop)', L.sizes().spawns, 3)
  const S = M.createLedger({ maxSpawns: 2 })
  for (const a of ['1', '2', '3']) S.spawn({ subagentType: 't' }, { model: 'm', agentId: a })
  eq('spawn rows capped at maxSpawns, each eviction counted', [S.sizes().spawns, S.sizes().evicted], [2, 1])
  const ev = S.complete({ turnId: 'x', agentId: '1' }, { iso: 'i' })
  eq('an evicted agent reads unspawned AND the record says rows were evicted', [ev.loop, ev.spawn_rows_evicted], ['unspawned', 1])
  const T = M.createLedger({ maxSteps: 2 })
  T.step({ turnId: 'k', index: 0, model: 'm1', effort: 'low' }, null)
  T.step({ turnId: 'k', index: 1, model: 'm1', effort: 'low' }, null)
  T.step({ turnId: 'k', index: 2, model: 'm2', effort: 'high' }, null)
  const tk = T.complete({ turnId: 'k' }, { iso: 'i' })
  eq('steps capped at maxSteps (first kept, rest counted); models/efforts cover every step',
    [tk.steps.map(s => s[0]), tk.steps_dropped, tk.models, tk.efforts], [[0, 1], 1, ['m1', 'm2'], ['low', 'high']])
  eq('stepRow: the API-reported model is kept when it differs from the resolved one',
    M.stepRow({ index: 3, model: 'claude-opus-5-5', effort: 'low', messageCount: 2 }, { stopReason: 'tool_use', usage: usage('claude-opus-5-5-20261001', 9) }),
    [3, 'claude-opus-5-5', 'low', 2, 'tool_use', 10, 9, 100, 5, 'claude-opus-5-5-20261001'])
  eq('stepRow: a usage with missing counts reads 0, not null', M.stepRow({ index: 0, model: 'm' }, { usage: { model: 'm' } }).slice(5), [0, 0, 0, 0, null])
  const G = M.createSessionLog({ maxLoops: 3 })
  for (const t of ['1', '2', '3', '4', '5']) G.add({ turn_id: t })
  const gf = JSON.parse(G.render({ schema: 2 }))
  eq('session log: past maxLoops the oldest leave, counted', [gf.loops.map(l => l.turn_id), gf.loops_dropped], [['3', '4', '5'], 2])
  const H = M.createSessionLog({ maxBytes: 1024 + 80 })
  for (const t of ['1', '2', '3']) H.add({ turn_id: t, pad: 'x'.repeat(10) })
  eq('session log: past maxBytes the oldest leave', [H.sizes().loops, H.sizes().dropped], [2, 1])
  const O = M.createSessionLog({ maxBytes: 1024 + 10 })
  O.add({ pad: 'x'.repeat(50) })
  eq('session log: a row alone over the budget is dropped, the file stays valid', [JSON.parse(O.render({})).loops.length, O.sizes().dropped], [0, 1])
  eq('defaults: ring 20, 500 loops, 360 KiB, 200 steps, 4 sessions, 256 open, 4096 spawns',
    [M.RING, M.MAX_LOOPS, M.MAX_FILE_BYTES, M.MAX_STEPS, M.MAX_SESSIONS, M.MAX_OPEN, M.MAX_SPAWNS], [20, 500, 368640, 200, 4, 256, 4096])
  eq('utf8Bound is an upper bound on the UTF-8 length', ['abc', 'é한', '😀x', 'a\u0085b'].every(s => M.utf8Bound(s) >= Buffer.byteLength(s)), true)
  // the worst case under the default caps: 600 loops of 300 non-ASCII-heavy steps stay within one file's budget
  const W = M.createSessionLog()
  const LW = M.createLedger()
  for (let n = 0; n < 600; n++) {
    for (let i = 0; i < 300; i++) LW.step({ turnId: `t${n}`, index: i, model: 'claude-모델-' + 'é'.repeat(20), effort: 'xhigh', messageCount: i, agentId: 'agent-' + n },
      { stopReason: 'tool_use', usage: usage('claude-모델', 123456) })
    W.add(LW.complete({ turnId: `t${n}`, agentId: 'agent-' + n, durationMs: 1e9, reason: 'answer', usage: usage('m', 1) }, { iso: '2026-10-02T01:02:03.456Z' }))
  }
  const text = W.render({ schema: 2, session_id: 'x'.repeat(80), slot: 19, updated: '2026-10-02T01:02:03.456Z' })
  const bytes = Buffer.byteLength(text)
  eq(`worst case: one file stays within MAX_FILE_BYTES and parses (${bytes} B, ${W.sizes().loops} loops kept)`,
    [bytes <= M.MAX_FILE_BYTES, JSON.parse(text).loops.length === W.sizes().loops, W.sizes().loops > 0], [true, true, true])
  eq('slotName pads to two digits', [M.slotName(0), M.slotName(19)], ['slot-00.json', 'slot-19.json'])
}

for (const [n, v] of results) console.log(n + '\t' + v)
'@

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("delegation-ledger-probe-{0}.mjs" -f [guid]::NewGuid().ToString('N'))
$ok = $true
try {
    [IO.File]::WriteAllText($tmp, $probe, [Text.UTF8Encoding]::new($false))
    $raw = (& node $tmp $mod 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $lines = @($raw -split "`r?`n" | Where-Object { $_ -match "`t" })
    if ($code -ne 0 -or $lines.Count -eq 0) { Write-Host "FAIL probe exited $code`n$raw" -ForegroundColor Red; $ok = $false }
    foreach ($l in $lines) {
        $name, $verdict = $l -split "`t", 2
        $ok = (Assert-True $name ($verdict -eq 'OK') $verdict) -and $ok
    }
} finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }

if (-not $ok) { Write-Host 'delegation-ledger selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host "delegation-ledger selftest: all $($lines.Count) checks passed" -ForegroundColor Green
exit 0
