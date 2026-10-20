// `claude plugin test plugins/ywr-harness` — the engine-side half of the prerequisite check's tests (ADR 0142).
// A LOCAL habit, never CI: the runner is the claude CLI, which CI does not have. The node suite
// (prerequisites.selftest.ps1) owns the logic. This file proves what only the engine can: the band's tree
// validates on every surface's element table, the model note goes through the engine's own
// `session.append`, and a machine with every tool draws no band and appends nothing.
import { test, expect, mock } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const BAND = {
  plugin: 'ywr-harness',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const missing = { exitCode: 9009, stdout: '', stderr: 'not recognized', isStdoutTruncated: false, isStderrTruncated: false }
const VERSIONS: Record<string, string> = { pwsh: 'PowerShell 7.6.6', node: 'v24.14.0', python: 'Python 3.13.13' }

test('a missing node draws the band on every surface and appends one model note', async ($, on) => {
  // The probes run on a `$.clock.after(0, …)` timer (ADR 0164); `clock.settle()` runs it and waits for it.
  const clock = mock.clock(on)
  const appended: string[] = []
  on('process.run', async (_$, e) => ({ value: e.argv[0] === 'node' ? missing : ok(VERSIONS[e.argv[0]] ?? '') }))
  on('session.append', async (_$, e, next) => {
    for (const block of e.message.content as { type: string; text?: string }[]) if (block.type === 'text' && block.text) appended.push(block.text)
    return next(e)
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  expect(appended.length).toBe(0) // the session start returned before the timer ran
  await clock.settle()
  expect(appended.length).toBe(1)
  expect(appended[0]).toContain('ywr-harness prerequisite check')
  expect(appended[0]).toContain('`node` is not on PATH')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    const found = await ui.find({ type: 'Text', text: /\/ywr-harness:setup/ } as never)
    expect(found).toBeDefined()
    await ui.unmount()
  }
})

test('every tool present: no band, no note', async ($, on) => {
  const clock = mock.clock(on)
  const appended: unknown[] = []
  const ran: string[] = []
  on('process.run', async (_$, e) => { ran.push(e.argv[0]); return { value: ok(VERSIONS[e.argv[0]] ?? '') } })
  on('ui.render', async ($, e) => { const { Box, Text } = $.ui.resolve(e as never) as never as Record<string, string>; return h(Box, null, h(Text, null, 'ENGINE')) as never })
  on('session.append', async (_$, e, next) => { appended.push(e); return next(e) })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  expect(ran).toEqual([]) // the session start returned before the timer ran
  await clock.settle()
  expect(ran).toEqual(['node', 'pwsh', 'python'])
  expect(appended.length).toBe(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Text', text: /ywr-harness/ } as never)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /ENGINE/ } as never)).toBeDefined()
  await ui.unmount()
})
