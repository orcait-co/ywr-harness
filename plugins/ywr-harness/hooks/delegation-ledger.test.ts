// `claude plugin test plugins/ywr-harness` — the engine-side half of delegation-ledger's tests (ADR 0117).
// A LOCAL habit, never CI: the runner is the claude CLI, which CI does not have. The node suite
// (delegation-ledger.selftest.ps1) owns the logic; this file proves the ENGINE runs the module as the
// node fake assumes: the hooks load, `turn.step`'s generator form passes the stream through, results
// come back untouched, and the session's slot file (ADR 0118) lands where `$.fs.write` was asked to put it.
import { test, expect } from 'claude-code/testing'

const ROOT = 'C:/repo'
// The engine hands `fs.*` hooks a platform-normalized path (on Windows `C:\repo\.harness.json` for the
// module's `C:/repo/.harness.json`), so the test compares in one spelling.
const fwd = (p: string) => p.split(String.fromCharCode(92)).join('/')

test('observe-only: a subagent loop passes through and writes its session slot', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  let mtimeMs = 1000
  on('session.root', async () => ({ value: ROOT }))
  on('session.id', async () => ({ value: 'sess-1' }))
  on('clock.now', async () => ({ value: Date.UTC(2026, 9, 2, 1, 2, 3, 456) }))
  on('fs.exists', async (_$, e) => ({ value: fwd(e.path) === `${ROOT}/.harness.json` }))
  on('fs.write', async (_$, e) => { writes.push({ path: fwd(e.path), text: e.text }); mtimeMs++; return { value: undefined } })
  // an empty ring: the listing finds no directory yet, a stat answers the last write
  on('fs.list', async () => { throw new Error('ENOENT') })
  on('fs.stat', async () => ({ value: { kind: 'file', size: writes.at(-1)?.text.length ?? 0, mtimeMs, isLink: false } }))
  // the test's own hooks stand for the engine beneath the plugin: the model's stream and the turn's end
  const usage = { model: 'claude-sonnet-5-5', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'hi' }
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('turn.complete', async () => ({ text: 'beneath' }))

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'low', messageCount: 1, agentId: 'wf1' })
  const chunks: unknown[] = []
  let result: { stopReason?: unknown } | undefined
  for (;;) { const r = await stream.next(); if (r.done) { result = r.value; break } chunks.push(r.value) }
  expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'hi' }])
  expect(result?.stopReason).toBe('end_turn')
  const done = await $.turn.complete({ answer: 'never persisted', durationMs: 42, isAborted: false, turnId: 't1', agentId: 'wf1', reason: 'answer' })
  expect(done.text).toBe('beneath')

  expect(writes.length).toBe(1)
  expect(writes[0].path).toBe(`${ROOT}/.claude/telemetry/delegations/slot-00.json`)
  const file = JSON.parse(writes[0].text)
  expect([file.schema, file.session_id, file.slot]).toEqual([2, 'sess-1', 0])
  const doc = file.loops[0]
  expect(doc.loop).toBe('unspawned')
  expect(doc.models).toEqual(['claude-sonnet-5-5'])
  expect(doc.efforts).toEqual(['low'])
  expect(doc.steps[0][file.step_fields.indexOf('output_tokens')]).toBe(2)
  expect(writes[0].text.includes('never persisted')).toBe(false)
})

test('a root without .harness.json gets no file', async ($, on) => {
  let wrote = 0
  on('session.root', async () => ({ value: 'C:/elsewhere' }))
  on('session.id', async () => ({ value: 'sess-2' }))
  on('fs.exists', async () => ({ value: false }))
  on('fs.write', async () => { wrote++; return { value: undefined } })
  on('turn.complete', async () => ({ text: 'from beneath' }))
  const done = await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'm', reason: 'answer' })
  expect(done.text).toBe('from beneath')
  expect(wrote).toBe(0)
})
