// Hooks module (Claude Mods, Claude Code 2.1.287+; ADR 0117, ADR 0118) — the OBSERVE-ONLY per-request
// delegation ledger. `hooks.json` names this file under `modules`; the settings hooks beside it are
// unaffected.
//
// What it records, per finished model loop (the main loop's turn, or one run of a subagent's loop):
// every request the loop made (`turn.step`: the model the engine resolved, the effort it sends, the
// usage the API reported), the loop's end (`turn.complete`: reason, duration, summed usage) and, for
// an Agent-tool spawn, the spawn itself (`agent.spawn`: type, the per-call model as given, the parent
// model, the resolved model). An agent-team teammate raises `agent.spawn` too from Claude Code 2.1.289
// (`e.isTeammate`); its loop keeps the `agent-tool` kind and its spawn row says `teammate: true`, which
// is what the reader splits on (schema 2 unchanged — the field is additive). A Workflow `agent()` worker raises no `agent.spawn` (fact 89), so its
// loop is written with `spawn: null` and `loop: 'unspawned'` — its steps still name the model and
// effort it ran on, which is the one place a silent inherit is visible.
//
// Observe-only, by contract: every hook passes the event on unchanged (`next(e)`, `yield* next(e)`),
// never rewrites `model`/`effort`, never denies, never draws, and swallows its own failures — the
// recording code runs after `next` resolved and inside try/catch, because a hook that fails
// mid-stream is "left where it stood". It never carries a gate: hosts < 2.1.287, `disableAllHooks`,
// `--safe-mode` and a managed `allowManagedModsOnly` all drop it (ADR 0117).
//
// What it never writes: a prompt, a task description, an answer or any other message text (the
// secret-adjacent rule `subagent-telemetry` keeps). Where it writes (ADR 0118): a RING of twenty
// session files, `<project root>/.claude/telemetry/delegations/slot-00.json`..`slot-19.json` —
// gitignored by the scaffold and the canon — and only where the root holds `.harness.json` (a repo
// that adopted the harness), so a session in a home directory or a stranger's checkout leaves nothing
// behind. `$.fs` has no delete, so the bound is by construction: a session claims a missing slot or
// the oldest by `mtimeMs`, and its file keeps its last 500 loops within 360 KiB. `$.fs.write` is not
// atomic and replaces the whole file, so a session's writes are serialized, and a slot another
// session took (its `mtimeMs`/`size` moved since this session's last write) is given up for a new one.
//
// The pure half (`createLedger`, `createSessionLog`, `pickSlot`, `stepRow`, `spawnRow`, `fingerprint`)
// is exported so `delegation-ledger.selftest.ps1` drives it under plain node with a fake engine; the
// engine imports only `register`.

export const SCHEMA = 2
export const LEDGER_DIR = '.claude/telemetry/delegations'
export const RING = 20
// One session file: its last MAX_LOOPS loops within MAX_FILE_BYTES (UTF-8, counted as an upper
// bound). The ring's worst case is RING x MAX_FILE_BYTES, ~7 MiB per adopted repo.
export const MAX_LOOPS = 500
export const MAX_FILE_BYTES = 360 * 1024
// Room left in MAX_FILE_BYTES for the file's own fields around `loops` (a session id is ~40 B).
const HEADER_RESERVE = 1024
// A loop keeps its first MAX_STEPS step rows; the rest are counted. Bounds one row (~67 B a step)
// and the memory of an open loop.
export const MAX_STEPS = 200
// Open loops are held in module memory until their loop ends. A loop that never ends (killed agent,
// crash) would otherwise leak; past this many, the oldest is dropped unwritten.
export const MAX_OPEN = 256
// Spawn rows outlive their loop (a resumed agent runs again under the same id), so they are capped
// separately and higher (a row is ~300 B). An evicted row would make that agent's later run read as
// `unspawned` — the workflow signal ADR 0117 Decision 6 counts — so each record carries
// `spawn_rows_evicted`, the session's running count, and a reader discounts `unspawned` when it is > 0.
export const MAX_SPAWNS = 4096
// Session loop lists held at once (a `/clear` starts a new session in the same module).
export const MAX_SESSIONS = 4

const MAIN = 'main'

export function slotName(i) {
  return `slot-${String(i).padStart(2, '0')}.json`
}

// The slot a new session claims from a `$.fs.list` of the ledger directory: the lowest-numbered slot
// with no entry, else the regular slot file with the oldest `mtimeMs` (ties: the lowest number), else
// null. A slot name that is a directory, a link or anything but a file is never claimed.
export function pickSlot(entries, ring = RING) {
  const byName = new Map()
  for (const en of Array.isArray(entries) ? entries : []) if (en && typeof en.name === 'string') byName.set(en.name, en)
  let oldest = null
  for (let i = 0; i < ring; i++) {
    const en = byName.get(slotName(i))
    if (!en) return i
    if (en.kind !== 'file' || en.isLink || typeof en.mtimeMs !== 'number') continue
    if (oldest === null || en.mtimeMs < oldest.mtimeMs) oldest = { i, mtimeMs: en.mtimeMs }
  }
  return oldest ? oldest.i : null
}

// An upper bound on the UTF-8 length of a string: a code unit above U+007F counts 3 bytes (a
// surrogate pair counts 6 for its 4).
export function utf8Bound(s) {
  let n = s.length
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) n += 2
  return n
}

function usageRow(u) {
  if (!u || typeof u !== 'object') return null
  return {
    model: u.model ?? null,
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  }
}

export function spawnRow(e, r) {
  return {
    tool_use_id: e.tool_use_id ?? null,
    subagent_type: e.subagentType ?? null,
    provider: e.provider ? `${e.provider.plugin}/${e.provider.tier}` : null,
    model_param: e.model ?? null,
    parent_model: e.parentModel ?? null,
    model: r && typeof r === 'object' && !('deny' in r && r.deny) ? (r.model ?? null) : null,
    denied: !!(r && typeof r === 'object' && r.deny),
    fork: !!e.fork,
    background: !!e.background,
    teammate: !!e.isTeammate,
    parent_agent_id: e.parentAgentId ?? null,
  }
}

// A step row is a TUPLE in STEP_FIELDS order (~67 B, against ~236 B as an object): the ledger is
// read by analysis code, never by eye, and the file names the fields once, as `step_fields`. The
// token counts are null when the request reported no usage; `usage_model` (the model the API
// reported) is null when it equals `model` or no usage came back.
export const STEP_FIELDS = ['index', 'model', 'effort', 'message_count', 'stop_reason', 'input_tokens',
  'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'usage_model']

export function stepRow(e, r) {
  const res = r && typeof r === 'object' ? r : null
  const u = usageRow(res ? res.usage : null)
  const model = e.model ?? null
  return [
    e.index ?? null,
    model,
    e.effort ?? null,
    e.messageCount ?? null,
    res ? (res.stopReason ?? null) : null,
    u ? u.input_tokens : null,
    u ? u.output_tokens : null,
    u ? u.cache_read_input_tokens : null,
    u ? u.cache_creation_input_tokens : null,
    u && u.model !== model ? u.model : null,
  ]
}

const present = x => x !== null && x !== undefined

// The ledger's bookkeeping, engine-free. `spawn` / `step` / `complete` take the event and the result
// `next` resolved to; `complete` answers the loop's row (empty steps when nothing was open).
export function createLedger({ maxOpen = MAX_OPEN, maxSpawns = MAX_SPAWNS, maxSteps = MAX_STEPS } = {}) {
  const spawns = new Map()   // agentId -> spawn row (kept across that agent's runs)
  const open = new Map()     // `${agentId|main}\u0000${turnId}` -> { steps, dropped, models, efforts }
  let evicted = 0
  const cap = (map, max, onDrop) => { while (map.size > max) { map.delete(map.keys().next().value); onDrop?.() } }
  const key = (agentId, turnId) => `${agentId ?? MAIN}\u0000${turnId}`
  return {
    spawn(e, r) {
      const agentId = r && typeof r === 'object' ? r.agentId : undefined
      if (!agentId) return
      spawns.set(agentId, spawnRow(e, r))
      cap(spawns, maxSpawns, () => { evicted++ })
    },
    step(e, r) {
      const k = key(e.agentId, e.turnId)
      if (!open.has(k)) { open.set(k, { steps: [], dropped: 0, models: new Set(), efforts: new Set() }); cap(open, maxOpen) }
      const loop = open.get(k)
      if (!loop) return
      const row = stepRow(e, r)
      if (present(row[1])) loop.models.add(row[1])
      if (present(row[2])) loop.efforts.add(row[2])
      if (loop.steps.length < maxSteps) loop.steps.push(row)
      else loop.dropped++
    },
    complete(e, { iso }) {
      const k = key(e.agentId, e.turnId)
      const loop = open.get(k) ?? { steps: [], dropped: 0, models: new Set(), efforts: new Set() }
      open.delete(k)
      const spawn = e.agentId ? (spawns.get(e.agentId) ?? null) : null
      return {
        ts: iso,
        loop: e.agentId ? (spawn ? 'agent-tool' : 'unspawned') : MAIN,
        agent_id: e.agentId ?? null,
        turn_id: e.turnId ?? null,
        spawn,
        spawn_rows_evicted: evicted,
        steps: loop.steps,
        steps_dropped: loop.dropped,
        models: [...loop.models],
        efforts: [...loop.efforts],
        complete: {
          reason: e.reason ?? null,
          aborted: !!e.isAborted,
          duration_ms: e.durationMs ?? null,
          usage: usageRow(e.usage),
        },
      }
    },
    sizes: () => ({ spawns: spawns.size, open: open.size, evicted }),
  }
}

// One session's loop rows, kept serialized and capped; `render` is the whole file's text.
export function createSessionLog({ maxLoops = MAX_LOOPS, maxBytes = MAX_FILE_BYTES } = {}) {
  const loops = []   // { text, bytes }
  let bytes = 0
  let dropped = 0
  return {
    add(row) {
      const text = JSON.stringify(row)
      const b = utf8Bound(text) + 1   // + its comma
      loops.push({ text, bytes: b })
      bytes += b
      while (loops.length > maxLoops || (loops.length > 0 && bytes + HEADER_RESERVE > maxBytes)) {
        bytes -= loops.shift().bytes
        dropped++
      }
    },
    // `header` is the file's own fields; `loops` goes last, spliced in as the rows' kept text.
    render(header) {
      const h = JSON.stringify({ ...header, loops_dropped: dropped, loops: [] })
      return `${h.slice(0, -3)}[${loops.map(l => l.text).join(',')}]}\n`
    },
    sizes: () => ({ loops: loops.length, bytes, dropped }),
  }
}

// --- the engine half ---------------------------------------------------------------------------
// Declared at the top of the file: the engine follows `$` only into such functions.

// The project root to write under, or null where the root holds no `.harness.json`. `adopted`
// caches the answer per root (a `/cd` or worktree move changes the root mid-session).
async function target($, adopted) {
  const root = await $.session.root()
  if (!adopted.has(root)) adopted.set(root, await $.fs.exists(`${root}/.harness.json`))
  return adopted.get(root) ? root : null
}

async function statOf($, path) {
  try {
    const st = await $.fs.stat(path)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch { return null }
}

// The start every file this session renders begins with (`render` puts the header keys first).
const headerOf = id => `{"schema":${SCHEMA},"session_id":${JSON.stringify(id)},`

// A 32-bit FNV-1a over the UTF-16 code units: the mark of the text this session last wrote whole.
export function fingerprint(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return h >>> 0
}

// One rewrite of a session's file. Runs on the session's chain, never two at once for one session.
async function flush($, s, root, iso) {
  const dir = `${root}/${LEDGER_DIR}`
  if (s.root !== root) { s.root = root; s.slot = null; s.seen = null; s.mark = null }
  if (s.slot !== null && s.seen) {
    const now = await statOf($, `${dir}/${slotName(s.slot)}`)
    // moved since this session's last write: another session claimed it. A stat that fails (a missing
    // slot among the causes) proves nothing either way, so the read-back below decides.
    if (!now) s.seen = null
    else if (now.mtimeMs !== s.seen.mtimeMs || now.size !== s.seen.size) s.slot = null
  }
  if (s.slot !== null && !s.seen) {
    // the last write or a stat failed, so there is no stat to compare: the file itself says whose
    // it is. A missing or empty file stays ours; so does the very text this session last wrote whole
    // (its fingerprint, which covers a stat that keeps failing), and a file starting with our own
    // header (a partial write of ours keeps it). A file that exists but cannot be read proves
    // nothing, and neither does a null session id's header (every id-less session writes the same
    // one), so both are given up.
    const path = `${dir}/${slotName(s.slot)}`
    let text = ''
    try { text = await $.fs.read(path) } catch {
      let there = true
      try { there = await $.fs.exists(path) } catch { /* unknown: not provably ours */ }
      if (there) text = null
    }
    const ours = text === '' || (text !== null && ((s.mark !== null && fingerprint(text) === s.mark) ||
      (s.id !== null && text.startsWith(headerOf(s.id)))))
    if (!ours) s.slot = null
  }
  if (s.slot === null) {
    let entries = []
    try { entries = await $.fs.list(dir) } catch { /* no directory yet: every slot is missing */ }
    s.slot = pickSlot(entries)
    if (s.slot === null) return
  }
  const path = `${dir}/${slotName(s.slot)}`
  const text = s.log.render({ schema: SCHEMA, session_id: s.id, slot: s.slot, updated: iso, step_fields: STEP_FIELDS })
  s.seen = null
  s.mark = null
  await $.fs.write(path, text)
  s.mark = fingerprint(text)
  s.seen = await statOf($, path)
}

export function register(on) {
  const ledger = createLedger()
  const adopted = new Map()    // project root -> whether it holds .harness.json
  const sessions = new Map()   // session id -> { id, log, root, slot, seen, mark, chain }
  const sessionOf = id => {
    let s = sessions.get(id)
    if (s) { sessions.delete(id); sessions.set(id, s) }   // most recently used last: eviction takes the idlest
    else {
      s = { id, log: createSessionLog(), root: null, slot: null, seen: null, mark: null, chain: Promise.resolve() }
      sessions.set(id, s)
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
    }
    return s
  }

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try { ledger.spawn(e, r) } catch { /* observe-only: never fail the spawn */ }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try { ledger.step(e, r) } catch { /* observe-only */ }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      // The loop leaves memory first: a failing engine call below costs this one record, never a leak.
      const row = ledger.complete(e, { iso: null })
      const id = (await $.session.id()) ?? null
      row.ts = new Date(await $.clock.now()).toISOString()
      const root = await target($, adopted)
      if (root) {
        const s = sessionOf(id)
        s.log.add(row)
        const run = s.chain.then(() => flush($, s, root, row.ts))
        s.chain = run.catch(() => {})
        await run
      }
    } catch { /* observe-only: a ledger write never reaches the turn */ }
    return r
  })
}
