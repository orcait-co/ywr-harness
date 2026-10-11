// `claude plugin test plugins/ywr-harness` — the engine-side half of slice-status's tests (ADR 0138).
// A LOCAL habit, never CI: the runner is the claude CLI, which CI does not have. The node suite
// (slice-status.selftest.ps1) owns the logic. Since ADR 0140 the entry does not register the module,
// so this file proves the ENGINE shows no status line from the plugin: neither a measure, a `--tree`
// run nor a counted change reaches `ui.status`, and the results pass through.
import { test, expect } from 'claude-code/testing'

const ROOT = 'C:/repo'
const fwd = (p: string) => p.split(String.fromCharCode(92)).join('/')
const TREE = 'python scripts/harness/harness_gates.py --tree 2>&1 | tail -1'
const TREE_LINE = `tree: ${'a'.repeat(40)} · HEAD ${'b'.repeat(40)}`

test('ADR 0140: no status line in a .harness.json root; results pass through', async ($, on) => {
  const lines: (string | undefined)[] = []
  on('session.root', async () => ({ value: ROOT }))
  on('fs.exists', async (_$, e) => ({ value: fwd(e.path) === `${ROOT}/.harness.json` }))
  on('ui.status', async (_$, e) => { lines.push(e.text); return { value: undefined } })
  on('session.measure', async () => ({ changed: ['context'] }))
  on('tool.call', async () => ({ result: { stdout: TREE_LINE }, text: TREE_LINE }))

  const m = await $.session.measure({ context: { percent: 40, tokens: 80000, window: 200000 }, rateLimits: [], changed: ['context'] })
  expect(m.changed).toEqual(['context'])
  const t = await $.tool.call({ tool: 'Bash', command: TREE })
  expect('text' in t ? t.text : undefined).toBe(TREE_LINE)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/a.md`, content: 'x' })
  await $.tool.call({ tool: 'PowerShell', command: 'Remove-Item x' })
  expect(lines.length).toBe(0)
})
