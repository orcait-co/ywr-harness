// `claude plugin test plugins/ywr-harness` — the engine-side half of slice-status's tests (ADR 0138).
// A LOCAL habit, never CI: the runner is the claude CLI, which CI does not have. The node suite
// (slice-status.selftest.ps1) owns the logic; this file proves the ENGINE runs the module as the node
// fake assumes: `session.measure` and `tool.call` results come back untouched, and the line reaches
// `ui.status` with the zone and the `--tree` count.
import { test, expect } from 'claude-code/testing'

const ROOT = 'C:/repo'
const fwd = (p: string) => p.split(String.fromCharCode(92)).join('/')
const TREE = 'python scripts/harness/harness_gates.py --tree 2>&1 | tail -1'
const TREE_LINE = `tree: ${'a'.repeat(40)} · HEAD ${'b'.repeat(40)}`

test('the zone and the --tree count reach the status line; results pass through', async ($, on) => {
  const lines: (string | undefined)[] = []
  on('session.root', async () => ({ value: ROOT }))
  on('fs.exists', async (_$, e) => ({ value: fwd(e.path) === `${ROOT}/.harness.json` }))
  on('ui.status', async (_$, e) => { lines.push(e.text); return { value: undefined } })
  on('session.measure', async () => ({ changed: ['context'] }))
  on('tool.call', async () => ({ result: { stdout: TREE_LINE }, text: TREE_LINE }))

  const m = await $.session.measure({ context: { percent: 40, tokens: 80000, window: 200000 }, rateLimits: [], changed: ['context'] })
  expect(m.changed).toEqual(['context'])
  expect(lines.at(-1)).toBe('ctx 40%: 범위 정한 슬라이스만 시작')

  const t = await $.tool.call({ tool: 'Bash', command: TREE })
  expect('text' in t ? t.text : undefined).toBe(TREE_LINE)
  expect(lines.at(-1)).toBe('ctx 40%: 범위 정한 슬라이스만 시작 · --tree 이후 변경 없음')

  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/a.md`, content: 'x' })
  expect(lines.at(-1)).toBe('ctx 40%: 범위 정한 슬라이스만 시작 · --tree 이후 파일 1개 수정 — 다시 실행')
})

test('a root without .harness.json shows nothing', async ($, on) => {
  const lines: (string | undefined)[] = []
  on('session.root', async () => ({ value: 'C:/elsewhere' }))
  on('fs.exists', async () => ({ value: false }))
  on('ui.status', async (_$, e) => { lines.push(e.text); return { value: undefined } })
  on('session.measure', async () => ({ changed: ['context'] }))
  await $.session.measure({ context: { percent: 70, tokens: 140000, window: 200000 }, rateLimits: [], changed: ['context'] })
  expect(lines.length).toBe(0)
})
