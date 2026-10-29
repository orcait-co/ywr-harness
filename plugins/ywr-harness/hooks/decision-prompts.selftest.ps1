# Self-test for decision-prompts.mjs, the plugin's AUTO-switch hooks module (Claude Mods; ADR 0174, ADR 0175).
# Usage: pwsh plugins/ywr-harness/hooks/decision-prompts.selftest.ps1
#
# CI has no claude CLI, so the module is driven here under plain node with a FAKE engine: a fake `on`
# captures the hooks, a fake `$` answers process.run (git rev-parse) / session.cwd / fs.read / fs.write over an
# in-memory map / model.complete / clock.sleep / ui.toast, and each `next` is a stub whose result the hook must
# hand back untouched where the module has nothing to add. What this suite proves is the contract the host
# cannot check for us: the pure half (the prompt-path and declaration parsers, the switch parser, the three
# stage detectors, the digest-row check and its append, the stage data and its cut, the side-check answer's NONE
# rule, the edit-guard path match, the status text) is right; the hook set is exactly turn.start, tool.call,
# session.append on door delivery and command.run on ywr-harness:auto, and no session.start, no classic.* and
# no skill.prompt (the built-in guard skips those for a user-tier plugin, ADR 0175); a switch that is off, a
# stage that is undeclared, a missing prompt file, a deny from `next`, a call with an `agentId` and a checkout
# without git all leave the stage untouched and start no side check and never call $.model.fork; a switch that is on adds the static prompt and
# then the side check's answer to the stage's context (or to the digest row's last text block), one side check at a time,
# and a NONE answer, a timeout, a rejection or a throwing toast never costs the static prompt; an Edit / Write
# / NotebookEdit of `.harness.json` or a declared prompt file is denied while the switch is on and passes
# otherwise; a stage runs only with the input baseline that the typed `on` took in this session (ADR 0176): no
# baseline, or a changed `.harness.json` or prompt file, withholds the stage with one fixed line and a toast, and
# the stage uses the same read it hashed; `/ywr-harness:auto on|off|status` writes the state file or nothing, as
# the argument says; and the
# entry `mods.mjs` registers these hooks beside the others. What it cannot prove - the engine's own event
# shapes (the digest row, the Workflow call, the `--tree` result), that the guard lets the hooks run, that a
# real `$.model.complete` answers the way the fake does and honours its request fields (model, effort, max tokens, timeout), that the toast
# renders, that the host answers a plugin skill command through `command.run` - is `claude plugin validate`'s
# and the live `--plugin-dir` run's (spec 0012 section 3 Mods row); `claude plugin test` stays a local habit.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core
Assert-NodeOrExit 'decision-prompts'
$mod = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'decision-prompts.mjs'))
$entry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'mods.mjs'))

$probe = @'
import { pathToFileURL } from 'node:url'
let unhandled = 0
process.on('unhandledRejection', () => { unhandled++ })
const M = await import(pathToFileURL(process.argv[2]).href)
const ENTRY = await import(pathToFileURL(process.argv[3]).href)
const results = []
const flush = () => { for (const [n, v] of results) console.log(n + '\t' + v) }
// a throw inside one case must not hide the cases before it: report them, then the crash as a FAIL line
process.on('uncaughtException', e => {
  results.push(['CRASH probe stopped after ' + results.length + ' cases', 'FAIL ' + String(e && e.stack).replace(/\s+/g, ' ')])
  flush(); process.exit(1)
})
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  results.push(g === w ? [name, 'OK'] : [name, 'FAIL got ' + g + ' want ' + w])
}
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms))
// Korean text is built from escapes, so this file stays ASCII.
const K_ON = '\ucf1c\uc9d0'     // the on word of the status line
const K_OFF = '\uaebc\uc9d0'    // the off word of the status line
const K_USAGE = '\uc0ac\uc6a9\ubc95: /ywr-harness:auto on | off | status'   // the usage line
const HANGUL = /[\uac00-\ud7a3]/
const ch = c => String.fromCharCode(c)
const CUT = n => `\n[... cut at ${n} characters]`

// ---------------------------------------------------------------------------------------------
// Pure half
// ---------------------------------------------------------------------------------------------

eq('constants: command, stages, review workflow, state file, wait, caps, digest marks, tool sets',
  [M.COMMAND, M.STAGES, M.REVIEW_WORKFLOW, M.STATE_REL, M.CHECK_WAIT_MS, M.PROMPT_MAX, M.DATA_MAX, M.DIGEST_MARKS.length, M.SHELL_TOOLS, M.EDIT_TOOLS],
  ['ywr-harness:auto', ['review-start', 'review-digest', 'ready-report'], 'ywr-harness:adversarial-review', 'ywr-harness/auto.json', 30000, 16000, 6000, 2, ['Bash', 'PowerShell'], ['Edit', 'Write', 'NotebookEdit']])
eq('constants: slice-close is not a stage', M.STAGES.includes('slice-close'), false)
eq('constants: the side check runs on the sonnet alias at effort low with a 400-token cap', [M.CHECK_MODEL, M.CHECK_EFFORT, M.CHECK_MAX_TOKENS], ['sonnet', 'low', 400])

// SP: safePromptPath
eq('SP1 safePromptPath: a repo-relative .md path comes back as is; a single segment is fine',
  [M.safePromptPath('docs/prompts/ready.md'), M.safePromptPath('a.md'), M.safePromptPath('a/b/c.d.md')], ['docs/prompts/ready.md', 'a.md', 'a/b/c.d.md'])
eq('SP2 safePromptPath: a backslash, a colon or a drive letter is refused',
  [M.safePromptPath('docs\\a.md'), M.safePromptPath('C:/a.md'), M.safePromptPath('c:a.md'), M.safePromptPath('a:b.md')], [null, null, null, null])
eq('SP3 safePromptPath: a leading slash, a .. segment, a . segment and an empty segment are refused',
  [M.safePromptPath('/a.md'), M.safePromptPath('../a.md'), M.safePromptPath('a/../b.md'), M.safePromptPath('./a.md'), M.safePromptPath('a/./b.md'), M.safePromptPath('a//b.md'), M.safePromptPath('a/b.md/')],
  [null, null, null, null, null, null, null])
eq('SP4 safePromptPath: a path that does not end in .md, an empty string and an over-long path are refused',
  [M.safePromptPath('a.txt'), M.safePromptPath('a.MD'), M.safePromptPath('a.md.exe'), M.safePromptPath(''), M.safePromptPath('x'.repeat(298) + '.md'), M.safePromptPath('x'.repeat(297) + '.md')],
  [null, null, null, null, null, 'x'.repeat(297) + '.md'])
// the control characters are built from char codes (a literal one in source text can materialize)
eq('SP5 safePromptPath: a control character (NUL, BEL, LF, 0x1f, DEL) anywhere is refused',
  [0, 7, 10, 0x1f, 0x7f].map(c => M.safePromptPath('a' + ch(c) + 'b.md')), [null, null, null, null, null])
eq('SP6 safePromptPath: a non-string is refused', [null, undefined, 5, true, {}, ['a.md']].map(v => M.safePromptPath(v)), [null, null, null, null, null, null])

// PD: parseDecl
const EMPTY = { stages: {}, problems: [] }
eq('PD1 parseDecl: an absent or null key, an empty object, and a non-object input give the empty declaration',
  [M.parseDecl({}), M.parseDecl({ decision_prompts: null }), M.parseDecl({ decision_prompts: undefined }), M.parseDecl(null), M.parseDecl(undefined), M.parseDecl('x'), M.parseDecl([])],
  [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY])
eq('PD2 parseDecl: a decision_prompts that is not an object is one problem and no stage',
  ['x', 5, true, ['review-start']].map(v => M.parseDecl({ decision_prompts: v })),
  [1, 2, 3, 4].map(() => ({ stages: {}, problems: ['decision_prompts: expected an object of stage entries'] })))
{
  const unk = M.parseDecl({ decision_prompts: { 'review-begin': { prompt: 'a.md' } } })
  eq('PD3 parseDecl: an unknown stage is dropped and named with the known list',
    [unk.stages, unk.problems.length, unk.problems[0].includes('review-begin: unknown stage'), unk.problems[0].includes('review-start, review-digest, ready-report')], [{}, 1, true, true])
  const sc = M.parseDecl({ decision_prompts: { 'slice-close': { prompt: 'a.md', check: true } } })
  eq('PD4 parseDecl: slice-close gets its own message (not a stage, the guard), not the unknown-stage one',
    [sc.stages, sc.problems.length, sc.problems[0].includes('slice-close: not a stage'), sc.problems[0].includes('ADR 0175'), sc.problems[0].includes('unknown stage')], [{}, 1, true, true, false])
  const bad = M.parseDecl({ decision_prompts: { 'review-start': 'a.md', 'review-digest': null, 'ready-report': ['a.md'] } })
  eq('PD5 parseDecl: an entry that is not an object (string, null, array) is dropped, one problem each',
    [bad.stages, bad.problems.length, bad.problems.every(p => p.includes('expected an object with prompt and check'))], [{}, 3, true])
  const bp = M.parseDecl({ decision_prompts: { 'review-start': { prompt: '../a.md' }, 'review-digest': { check: true }, 'ready-report': { prompt: 'a.txt' } } })
  eq('PD6 parseDecl: a bad or absent prompt drops the entry, one problem each naming the prompt key',
    [bp.stages, bp.problems.length, bp.problems.every(p => p.includes('.prompt: expected a repo-relative .md path'))], [{}, 3, true])
  const bf = M.parseDecl({ decision_prompts: { 'ready-report': { prompt: 'a.md', check: 'yes' }, 'review-start': { prompt: 'b.md', check: 1 }, 'review-digest': { prompt: 'c.md', check: null } } })
  eq('PD7 parseDecl: a check that is not a boolean drops the entry (a string, a number and null alike)',
    [bf.stages, bf.problems.length, bf.problems.every(p => p.includes('.check: expected true or false'))], [{}, 3, true])
  const ex = M.parseDecl({ decision_prompts: { 'ready-report': { prompt: 'a.md', check: true, note: 1, why: 2 } } })
  eq('PD8 parseDecl: an unknown extra key warns (naming each) but the entry is kept',
    [ex.stages, ex.problems.length, ex.problems[0].includes('unknown key note, why ignored')], [{ 'ready-report': { prompt: 'a.md', check: true } }, 1, true])
  const fd = M.parseDecl({ decision_prompts: { 'review-start': { prompt: 'a.md' }, 'review-digest': { prompt: 'b.md', check: false }, 'ready-report': { prompt: 'c.md', check: true } } })
  eq('PD9 parseDecl: check defaults to false; false stays false; true stays true; no problem',
    [fd.stages, fd.problems], [{ 'review-start': { prompt: 'a.md', check: false }, 'review-digest': { prompt: 'b.md', check: false }, 'ready-report': { prompt: 'c.md', check: true } }, []])
  const mix = M.parseDecl({ decision_prompts: { 'ready-report': { prompt: 'c.md' }, 'bogus': { prompt: 'x.md' } } })
  eq('PD10 parseDecl: a bad entry never turns another stage off or on', [Object.keys(mix.stages), mix.problems.length], [['ready-report'], 1])
}

// PS: parseSwitch / switchText
eq('PS1 parseSwitch: an object whose on is exactly true is on',
  [M.parseSwitch('{"on":true}'), M.parseSwitch('{"on":true,"at":"2026-10-28T00:00:00Z"}'), M.parseSwitch(M.switchText(true, 'now'))], [true, true, true])
eq('PS2 parseSwitch: on false, a string, a number, a missing key, an array, null, garbage, empty, null input and undefined are off',
  ['{"on":false}', '{"on":"true"}', '{"on":1}', '{}', '[true]', 'null', 'garbage', '', null, undefined, '{"on":true'].map(t => M.parseSwitch(t)),
  [false, false, false, false, false, false, false, false, false, false, false])
eq('PS3 switchText: one JSON line with on and at, newline-terminated', [M.switchText(true, 'T'), M.switchText(false, 'T')], ['{"on":true,"at":"T"}\n', '{"on":false,"at":"T"}\n'])

// ST: stageOfToolCall
const GATES = 'python scripts/harness/harness_gates.py --tree'
eq('ST1 stageOfToolCall: the review workflow by name is review-start; another workflow is none',
  [M.stageOfToolCall({ tool: 'Workflow', name: 'ywr-harness:adversarial-review' }), M.stageOfToolCall({ tool: 'Workflow', name: 'ywr-harness:other' }), M.stageOfToolCall({ tool: 'Workflow' }), M.stageOfToolCall({ tool: 'Bash', name: 'ywr-harness:adversarial-review' })],
  ['review-start', null, null, null])
eq('ST2 stageOfToolCall: a Bash or PowerShell call whose last step is harness_gates.py --tree is ready-report',
  [M.stageOfToolCall({ tool: 'Bash', command: GATES }), M.stageOfToolCall({ tool: 'PowerShell', command: GATES }), M.stageOfToolCall({ tool: 'Bash', command: 'cd x && ' + GATES })],
  ['ready-report', 'ready-report', 'ready-report'])
eq('ST3 stageOfToolCall: a non-tree command, a gates run without --tree, a tree run followed by another step, and another tool are none',
  [M.stageOfToolCall({ tool: 'Bash', command: 'ls' }), M.stageOfToolCall({ tool: 'Bash', command: 'python scripts/harness/harness_gates.py a.py' }), M.stageOfToolCall({ tool: 'Bash', command: GATES + ' && git commit -m x' }),
   M.stageOfToolCall({ tool: 'Read', command: GATES }), M.stageOfToolCall({ tool: 'Bash' })], [null, null, null, null, null])
eq('ST4 stageOfToolCall: a call with an agentId never starts a stage (even an empty-string id); a null or missing event is none',
  [M.stageOfToolCall({ tool: 'Workflow', name: M.REVIEW_WORKFLOW, agentId: 'a1' }), M.stageOfToolCall({ tool: 'Bash', command: GATES, agentId: 'a1' }), M.stageOfToolCall({ tool: 'Bash', command: GATES, agentId: '' }), M.stageOfToolCall(null), M.stageOfToolCall(undefined)],
  [null, null, null, null, null])

// DR: rowText / isDigestRow
const DIG_LINE = 'review ' + M.DIGEST_MARKS[0] + '3 lenses, 2 confirmed'
const DIG_TEXT = 'Workflow finished\n' + DIG_LINE + '\n' + M.DIGEST_MARKS[1] + ' finding 1)'
const digRow = (over = {}) => ({ door: 'delivery', origin: { kind: 'task-notification' }, message: { type: 'user', content: [{ type: 'text', text: DIG_TEXT }] }, ...over })
eq('DR1 rowText: the text blocks joined by a newline; other blocks and malformed input add nothing',
  [M.rowText({ content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] }), M.rowText(null), M.rowText({}), M.rowText({ content: 'x' }), M.rowText({ content: [null, { type: 'text', text: 5 }] })],
  ['a\n\nb', '', '', '', '\n'])
eq('DR2 isDigestRow: door delivery + origin task-notification + both marks is a digest row', M.isDigestRow(digRow()), true)
eq('DR3 isDigestRow: the same text on door prompt (the user\'s own prompt) is not one',
  [M.isDigestRow(digRow({ door: 'prompt' })), M.isDigestRow(digRow({ door: undefined })), M.isDigestRow(digRow({ origin: { kind: 'user' } })), M.isDigestRow(digRow({ origin: undefined })), M.isDigestRow(digRow({ origin: null }))],
  [false, false, false, false, false])
eq('DR4 isDigestRow: one mark alone is not enough; no text is not',
  [M.isDigestRow(digRow({ message: { content: [{ type: 'text', text: 'x ' + M.DIGEST_MARKS[0] + 'y' }] } })), M.isDigestRow(digRow({ message: { content: [{ type: 'text', text: M.DIGEST_MARKS[1] }] } })), M.isDigestRow(digRow({ message: { content: [] } })), M.isDigestRow(digRow({ message: undefined }))],
  [false, false, false, false])
eq('DR5 isDigestRow: a row with an agentId is not one; null and a missing event are not', [M.isDigestRow(digRow({ agentId: 'a1' })), M.isDigestRow(null), M.isDigestRow(undefined)], [false, false, false])
eq('DR6 isDigestRow: the marks may sit in different text blocks of one row',
  M.isDigestRow(digRow({ message: { content: [{ type: 'text', text: 'a ' + M.DIGEST_MARKS[0] }, { type: 'text', text: M.DIGEST_MARKS[1] }] } })), true)

// AR: appendToRow
{
  const msg = { type: 'user', content: [{ type: 'tool_result', id: 1 }, { type: 'text', text: 'first' }, { type: 'image', src: 'x' }, { type: 'text', text: 'last' }, { type: 'image', src: 'y' }] }
  const before = JSON.stringify(msg)
  const out = M.appendToRow(msg, 'EXTRA')
  eq('AR1 appendToRow: appends after the LAST text block only; the other blocks and the other keys are untouched',
    [out.type, out.content[0], out.content[1], out.content[2], out.content[3], out.content[4], out.content.length], ['user', msg.content[0], msg.content[1], msg.content[2], { type: 'text', text: 'last\n\nEXTRA' }, msg.content[4], 5])
  eq('AR2 appendToRow: the input message is not mutated', JSON.stringify(msg), before)
  eq('AR3 appendToRow: a single text block gets the extra after a blank line', M.appendToRow({ content: [{ type: 'text', text: 'a' }] }, 'X').content[0].text, 'a\n\nX')
  eq('AR4 appendToRow: null with no text block, an empty content, a non-array content, a null or missing message',
    [M.appendToRow({ content: [{ type: 'image' }] }, 'X'), M.appendToRow({ content: [] }, 'X'), M.appendToRow({ content: 'text' }, 'X'), M.appendToRow(null, 'X'), M.appendToRow(undefined, 'X'), M.appendToRow({ content: [{ type: 'text', text: 5 }] }, 'X')],
    [null, null, null, null, null, null])
}

// DL: digestLine
eq('DL1 digestLine: the trimmed line holding the first mark; the first such line wins; CRLF is fine',
  [M.digestLine(DIG_TEXT), M.digestLine('a\r\n   x ' + M.DIGEST_MARKS[0] + 'y   \r\nz'), M.digestLine('p ' + M.DIGEST_MARKS[0] + '1\nq ' + M.DIGEST_MARKS[0] + '2')],
  [DIG_LINE, 'x ' + M.DIGEST_MARKS[0] + 'y', 'p ' + M.DIGEST_MARKS[0] + '1'])
eq('DL2 digestLine: no line with the mark, empty, null and undefined give the empty string',
  [M.digestLine('nothing here'), M.digestLine(''), M.digestLine(null), M.digestLine(undefined), M.digestLine(M.DIGEST_MARKS[1])], ['', '', '', '', ''])

// SD: stageData
{
  const e = { tool: 'Workflow', name: M.REVIEW_WORKFLOW, args: { scope: { files: ['a.mjs'] }, shards: 'auto' } }
  eq('SD1 stageData review-start: the call\'s arguments as JSON; no args reads as null', [M.stageData('review-start', e, null), M.stageData('review-start', { tool: 'Workflow' }, null), M.stageData('review-start', null, null)],
    ['{"scope":{"files":["a.mjs"]},"shards":"auto"}', 'null', 'null'])
  eq('SD2 stageData review-digest: the digest line of the row\'s message', [M.stageData('review-digest', digRow(), null), M.stageData('review-digest', null, null)], [DIG_LINE, ''])
  eq('SD3 stageData ready-report: the result\'s text; a non-string text, a null result and an unknown stage give empty',
    [M.stageData('ready-report', {}, { text: 'tree: abc' }), M.stageData('ready-report', {}, { text: 5 }), M.stageData('ready-report', {}, null), M.stageData('slice-close', {}, { text: 'x' }), M.stageData('nope', {}, { text: 'x' })], ['tree: abc', '', '', '', ''])
  const exact = 'x'.repeat(M.DATA_MAX), over = 'x'.repeat(M.DATA_MAX + 50)
  eq('SD4 stageData: exactly DATA_MAX characters pass; more are cut at DATA_MAX with the cut marker',
    [M.stageData('ready-report', {}, { text: exact }) === exact, M.stageData('ready-report', {}, { text: over }) === 'x'.repeat(M.DATA_MAX) + CUT(M.DATA_MAX), M.stageData('review-start', { args: { v: over } }, null).endsWith(CUT(M.DATA_MAX)), M.stageData('review-digest', digRow({ message: { content: [{ type: 'text', text: M.DIGEST_MARKS[0] + over + '\n' + M.DIGEST_MARKS[1] }] } }), null).endsWith(CUT(M.DATA_MAX))],
    [true, true, true, true])
  const circ = { tool: 'Workflow' }; circ.args = circ
  eq('SD5 stageData review-start: arguments that cannot be serialized give empty, never a throw', M.stageData('review-start', circ, null), '')
}

// FP / CT: checkPrompt, contextText
{
  const fp = M.checkPrompt('ready-report', 'PROMPT BODY', 'DATA')
  eq('FP1 checkPrompt: the frame, then the stage, the repository prompt and the stage data',
    [fp.startsWith(M.FRAME), fp.includes('## Stage\nready-report'), fp.includes('## Repository prompt\nPROMPT BODY'), fp.endsWith('## Stage data\nDATA')], [true, true, true, true])
  eq('FP2 checkPrompt: empty data reads (none); a prompt past PROMPT_MAX is cut there',
    [M.checkPrompt('review-start', 'p', '').endsWith('## Stage data\n(none)'), M.checkPrompt('review-start', 'y'.repeat(M.PROMPT_MAX + 5), 'd').includes('y'.repeat(M.PROMPT_MAX) + CUT(M.PROMPT_MAX) + '\n\n## Stage data')], [true, true])
  eq('FP3 FRAME: tells the side check it sees only the repository prompt and the stage data, not the conversation, and answers NONE for nothing to say',
    [M.FRAME.includes('not the conversation'), M.FRAME.includes('exactly NONE'), M.FRAME.includes('Do not call any tool')], [true, true, false])
  eq('CT1 contextText: names the stage and the path, then the prompt; a long prompt is cut at PROMPT_MAX',
    [M.contextText('review-start', 'docs/p.md', 'BODY'), M.contextText('review-start', 'docs/p.md', 'z'.repeat(M.PROMPT_MAX + 1)).endsWith('z'.repeat(M.PROMPT_MAX) + CUT(M.PROMPT_MAX))],
    ['ywr-harness decision prompt for the review-start stage (from docs/p.md, declared in .harness.json):\nBODY', true])
}

// AN: answerText
eq('AN1 answerText: NONE in any case, with a period, with spaces, an empty or blank answer, isAnswered false or missing, a non-string text and null are null',
  [{ isAnswered: true, text: 'NONE' }, { isAnswered: true, text: 'none.' }, { isAnswered: true, text: '  None  \n' }, { isAnswered: true, text: '' }, { isAnswered: true, text: ' \n ' }, { isAnswered: false, text: 'Check x' }, { text: 'Check x' }, { isAnswered: true, text: 5 }, { isAnswered: 'true', text: 'Check x' }, null, undefined].map(r => M.answerText('ready-report', r)),
  [null, null, null, null, null, null, null, null, null, null, null])
{
  const a = M.answerText('review-digest', { isAnswered: true, text: '  Check the lens 2 finding.  ' })
  eq('AN2 answerText: a real answer reads as a side-check text that names the stage, says it is a separate model call and holds the trimmed answer',
    [a.includes('at the review-digest stage'), a.includes('a separate model call'), a.endsWith(':\nCheck the lens 2 finding.')], [true, true, true])
  eq('AN3 answerText: an answer that only STARTS with NONE is an answer; one past DATA_MAX is cut',
    [M.answerText('ready-report', { isAnswered: true, text: 'NONE of the gates ran' }) !== null, M.answerText('ready-report', { isAnswered: true, text: 'q'.repeat(M.DATA_MAX + 9) }).endsWith('q'.repeat(M.DATA_MAX) + CUT(M.DATA_MAX))], [true, true])
}

// AB / NP: isAbsolute, normPath
eq('AB1 isAbsolute: a drive path (both slashes), a rooted path and a UNC-style start are absolute; relative, a bare drive, empty, null are not',
  ['C:\\x', 'c:/x', '/x', '\\x', '\\\\srv\\s', 'x/y', '.git/x', 'C:x', '', null, undefined].map(p => M.isAbsolute(p)),
  [true, true, true, true, true, false, false, false, false, false, false])
// CP: canonPath
eq('CP1 canonPath: forward slashes, lower case, no trailing slash; empty and . segments dropped; each .. takes the segment before it',
  [M.canonPath('C:\\Repo\\Docs\\'), M.canonPath('/A/B//'), M.canonPath('C:/repo/./docs//x.md'), M.canonPath('C:/repo/docs/../.harness.json'), M.canonPath('C:/repo/a/b/../../c'), M.canonPath('C:\\Repo\\.\\Docs\\..\\X.MD')],
  ['c:/repo/docs', '/a/b', 'c:/repo/docs/x.md', 'c:/repo/.harness.json', 'c:/repo/c', 'c:/repo/x.md'])
eq('CP2 canonPath: a .. above the drive root or the filesystem root stays clamped there; a relative path with no cwd stays relative and loses a leading ..',
  [M.canonPath('C:/../../x'), M.canonPath('/../x'), M.canonPath('C:\\..\\.harness.json'), M.canonPath('docs/../x.md'), M.canonPath('../.harness.json'), M.canonPath('.harness.json')],
  ['c:/x', '/x', 'c:/.harness.json', 'x.md', '.harness.json', '.harness.json'])
eq('CP3 canonPath: a relative path is joined to cwd first (either slash, trailing slash dropped); an absolute path ignores cwd; null and undefined read as empty',
  [M.canonPath('docs/a.md', 'C:/repo'), M.canonPath('docs\\a.md', 'C:\\Repo\\'), M.canonPath('../a.md', 'C:/repo/sub'), M.canonPath('C:/x/a.md', 'C:/repo'), M.canonPath(null, 'C:/repo'), M.canonPath(undefined)],
  ['c:/repo/docs/a.md', 'c:/repo/docs/a.md', 'c:/repo/a.md', 'c:/x/a.md', 'c:/repo', ''])

// ET: editTarget
{
  const st = { root: 'C:/repo', statePath: 'C:/repo/.git/ywr-harness/auto.json', on: true,
    decl: { stages: { 'ready-report': { prompt: 'docs/prompts/ready.md', check: false }, 'review-start': { prompt: 'Docs/Review.md', check: true } }, problems: [] } }
  const et = (target, tool = 'Edit', over = {}, cwd) => M.editTarget({ tool, file_path: target }, { ...st, ...over }, cwd)
  eq('ET1 editTarget: the absolute .harness.json and each declared prompt under the root are inputs; the switch file is the state',
    [et('C:/repo/.harness.json'), et('C:/repo/docs/prompts/ready.md'), et('C:/repo/Docs/Review.md'), et('C:/repo/.git/ywr-harness/auto.json')], ['input', 'input', 'input', 'state'])
  eq('ET2 editTarget: a path with . or .. segments is resolved first: C:/repo/docs/../.harness.json and C:/repo/./docs/prompts/ready.md are inputs; a .. that climbs out of the root and back in is too',
    [et('C:/repo/docs/../.harness.json'), et('C:/repo/./docs/prompts/ready.md'), et('C:/repo/sub/../../repo/.harness.json'), et('C:/repo/docs/prompts/../../.harness.json')], ['input', 'input', 'input', 'input'])
  eq('ET3 editTarget: backslashes, case variants, Write and a trailing-slash root all match; a .. spelling of the switch file is the state',
    [et('C:\\repo\\.harness.json'), et('c:/REPO/.Harness.JSON'), et('C:\\Repo\\docs\\prompts\\ready.md', 'Write'), et('C:/repo/.harness.json', 'Edit', { root: 'C:\\repo\\' }), et('C:/repo/docs/review.md'), et('C:\\Repo\\.git\\x\\..\\ywr-harness\\AUTO.json'), et('C:/repo/.git/./ywr-harness//auto.json')],
    ['input', 'input', 'input', 'input', 'input', 'state', 'state'])
  eq('ET4 editTarget: a relative .harness.json is an input when the cwd is the root, no match from a subfolder, an input again through ../ from there',
    [et('.harness.json', 'Edit', {}, 'C:/repo'), et('.harness.json', 'Edit', {}, 'C:/repo/sub'), et('../.harness.json', 'Edit', {}, 'C:/repo/sub'), et('docs/prompts/ready.md', 'Edit', {}, 'C:/repo/'), et('prompts/ready.md', 'Edit', {}, 'C:/repo/docs'), et('.\\.harness.json', 'Edit', {}, 'C:\\repo')],
    ['input', null, 'input', 'input', 'input', 'input'])
  eq('ET5 editTarget: a relative path with no cwd is no match, even one spelled like an input (it stays relative)',
    [et('.harness.json'), et('docs/prompts/ready.md'), et('../.harness.json'), et('.git/ywr-harness/auto.json')], [null, null, null, null])
  eq('ET6 editTarget: the switch file is the state even with no declaration and with the switch off; a relative spelling of it resolves through the cwd',
    [et('C:/repo/.git/ywr-harness/auto.json', 'Edit', { decl: { stages: {}, problems: [] } }), et('C:/repo/.git/ywr-harness/auto.json', 'Write', { on: false }), et('.git/ywr-harness/auto.json', 'Edit', { decl: undefined }, 'C:/repo'), et('../.git/ywr-harness/auto.json', 'Edit', {}, 'C:/repo/sub')],
    ['state', 'state', 'state', 'state'])
  eq('ET7 editTarget: a .. above the drive root stays clamped there: C:/../../repo/.harness.json and a path that climbs above the drive and back down both resolve to the input',
    [et('C:/../../repo/.harness.json'), et('C:/../repo/../../repo/.harness.json'), et('/../repo/.harness.json', 'Edit', { root: '/repo' })], ['input', 'input', 'input'])
  eq('ET8 editTarget: another file, a same-named file in a subfolder or another root, and a prefix or suffix of an input are null',
    [et('C:/repo/src/a.mjs'), et('C:/repo/sub/.harness.json'), et('C:/other/.harness.json'), et('C:/repo/.harness.json.bak'), et('C:/repo/docs/prompts/ready.md.old'), et('C:/repo2/.harness.json'), et('C:/repo/.git/ywr-harness/auto.json.tmp'), et('C:/repo/.git/ywr-harness')],
    [null, null, null, null, null, null, null, null])
  eq('ET9 editTarget: NotebookEdit reads notebook_path; a tool outside the edit set is never an edit',
    [M.editTarget({ tool: 'NotebookEdit', notebook_path: 'C:/repo/docs/prompts/ready.md' }, st), M.editTarget({ tool: 'NotebookEdit', file_path: 'C:/repo/.harness.json' }, st), M.editTarget({ tool: 'Read', file_path: 'C:/repo/.harness.json' }, st), M.editTarget({ tool: 'Bash', command: 'x' }, st)],
    ['input', 'input', null, null])
  eq('ET10 editTarget: no root, no state, no path, a non-string path, an empty path, a null event are null',
    [et('C:/repo/.harness.json', 'Edit', { root: null }), et('C:/repo/.harness.json', 'Edit', { root: '' }), M.editTarget({ tool: 'Edit', file_path: 'C:/repo/.harness.json' }, null), M.editTarget({ tool: 'Edit' }, st), M.editTarget({ tool: 'Edit', file_path: 5 }, st), M.editTarget({ tool: 'Edit', file_path: '' }, st), M.editTarget(null, st)],
    [null, null, null, null, null, null, null])
  eq('ET11 editTarget: with no declaration only .harness.json is an input; with no statePath nothing is the state',
    [et('C:/repo/.harness.json', 'Edit', { decl: undefined }), et('C:/repo/docs/prompts/ready.md', 'Edit', { decl: undefined }), et('C:/repo/docs/prompts/ready.md', 'Edit', { decl: { stages: {}, problems: [] } }), et('C:/repo/.git/ywr-harness/auto.json', 'Edit', { statePath: null }), et('C:/repo/.git/ywr-harness/auto.json', 'Edit', { statePath: undefined })],
    ['input', null, null, null, null])
  eq('ET12 editTarget: a checkout whose toplevel is a drive or filesystem root still matches its inputs',
    [et('C:/.harness.json', 'Edit', { root: 'C:/' }), et('C:\\docs\\prompts\\ready.md', 'Write', { root: 'C:\\' }), et('/.harness.json', 'Edit', { root: '/' }), et('C:/other/.harness.json', 'Edit', { root: 'C:/' })],
    ['input', 'input', 'input', null])
}

// SX: statusText
{
  const base = { root: 'C:/repo', statePath: 'C:/repo/.git/ywr-harness/auto.json', on: true, baseline: { hashes: { '.harness.json': 'h' }, stages: [] }, decl: { stages: { 'ready-report': { prompt: 'docs/p.md', check: true }, 'review-start': { prompt: 'docs/q.md', check: false } }, problems: [] } }
  eq('SX1 statusText: no root gives the one Korean not-a-git-checkout line (mentions git)', [M.statusText({ root: null, decl: { stages: {}, problems: [] } }).includes('\n'), HANGUL.test(M.statusText({ root: null, decl: { stages: {}, problems: [] } })), M.statusText({ root: null, decl: { stages: {}, problems: [] } }).includes('git')], [false, true, true])
  const on = M.statusText(base).split('\n'), off = M.statusText({ ...base, on: false }).split('\n')
  eq('SX2 statusText: the first line says on or off (Korean) and names the state file; off differs from on',
    [on[0].includes(K_ON), on[0].includes(K_OFF), on[0].includes(base.statePath), off[0].includes(K_OFF), off[0].includes(K_ON)], [true, false, true, true, false])
  eq('SX3 statusText: on, one baseline line, then one line per declared stage with its prompt; a check stage ends with the check tag; off has no baseline line', [on.slice(2), on.length, off.length], [['- ready-report: docs/p.md \u00b7 check', '- review-start: docs/q.md'], 4, 3])
  const none = M.statusText({ ...base, decl: { stages: {}, problems: [] } }).split('\n')
  eq('SX4 statusText: no declaration gives one line that names decision_prompts', [none.length, none[2].includes('decision_prompts'), HANGUL.test(none[2])], [3, true, true])
  const prob = M.statusText({ ...base, decl: { stages: {}, problems: ['first problem', 'second problem'] } }).split('\n')
  eq('SX5 statusText: each problem is its own line prefixed with "! ", after the declaration lines', [prob.slice(-2), prob.length], [['! first problem', '! second problem'], 5])
  const withBoth = M.statusText({ ...base, decl: { ...base.decl, problems: ['p1'] } }).split('\n')
  eq('SX6 statusText: stage lines come before the problem lines', [withBoth[2].startsWith('- '), withBoth[withBoth.length - 1]], [true, '! p1'])
  const lineOf = (st, changed) => M.statusText(st, changed).split('\n')[1]
  const noBase = lineOf({ ...base, baseline: null }), match = lineOf(base, []), moved = lineOf(base, ['.harness.json', 'docs/p.md'])
  eq('SX7 statusText: with the switch on, the second line states the session baseline: none (names the command), match (counts the inputs), or changed (names each changed input and the command)',
    [noBase.includes('/ywr-harness:auto on'), HANGUL.test(noBase), match.includes('1'), match.includes('/ywr-harness:auto'), moved.includes('.harness.json, docs/p.md'), moved.includes('/ywr-harness:auto on'), new Set([noBase, match, moved]).size],
    [true, true, true, false, true, true, 3])
}
eq('NS1 newState: no root, switch off, empty declaration, nothing located, no check, no baseline', M.newState(), { root: null, statePath: null, on: false, decl: { stages: {}, problems: [] }, located: null, checking: false, baseline: null })

// BH: the input baseline's pure half (ADR 0176)
eq('BH1 sha256Hex: the FIPS 180-2 vector for "abc", and the empty string', [await M.sha256Hex('abc'), await M.sha256Hex('')],
  ['ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'])
eq('BH2 hashInputs: each text hashed under its own name; an unreadable input (null) stays null', await M.hashInputs({ a: 'abc', b: null }),
  { a: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', b: null })
eq('BH3 changedInputs: equal maps give none; a changed hash, an input on one side only, and a null against a hash each count; sorted',
  [M.changedInputs({ a: '1', b: null }, { a: '1', b: null }), M.changedInputs({ z: '1', a: '1', m: '1' }, { z: '2', a: '1', n: '1' }), M.changedInputs({ a: null }, { a: '1' })],
  [[], ['m', 'n', 'z'], ['a']])
eq('BH4 withheldText: names the stage and ADR 0176; no baseline names the command; a change names each input',
  [M.withheldText('ready-report', null).includes('ready-report'), M.withheldText('ready-report', null).includes('ADR 0176'), M.withheldText('ready-report', null).includes('/ywr-harness:auto on'),
   M.withheldText('review-start', ['.harness.json', 'p.md']).includes('.harness.json, p.md changed'), M.withheldText('x', []) === M.withheldText('x', null)],
  [true, true, true, true, false])
eq('BH5 withheldToast: Korean, starts with the plugin tag and the stage; no baseline and a change differ; a change names the input',
  [HANGUL.test(M.withheldToast('ready-report', null)), M.withheldToast('ready-report', null).startsWith('[ywr-harness] ready-report: '), M.withheldToast('ready-report', ['p.md']).includes('p.md'), M.withheldToast('s', null) !== M.withheldToast('s', ['p.md'])],
  [true, true, true, true])

// ---------------------------------------------------------------------------------------------
// register(): the hook set
// ---------------------------------------------------------------------------------------------

// A fake `on`: (ev, hook) or (ev, matcher, hook); returns a thenable-ish with catch like the engine's.
function capture(registerFn) {
  const hooks = []
  const on = (ev, a, b) => { hooks.push({ ev, matcher: b === undefined ? undefined : a, fn: b === undefined ? a : b }); return { catch() {} } }
  registerFn(on, {})
  const byEv = ev => hooks.filter(x => x.ev === ev)
  return { hooks, byEv }
}
{
  const C = capture(M.register)
  eq('H1 register: exactly turn.start, tool.call, session.append, command.run', C.hooks.map(x => x.ev).sort(), ['command.run', 'session.append', 'tool.call', 'turn.start'])
  eq('H2 register: session.append matches door delivery, command.run matches ywr-harness:auto, turn.start and tool.call have no matcher',
    [C.byEv('session.append')[0].matcher, C.byEv('command.run')[0].matcher, C.byEv('turn.start')[0].matcher, C.byEv('tool.call')[0].matcher],
    [{ door: 'delivery' }, { command: 'ywr-harness:auto' }, undefined, undefined])
  eq('H3 register: no session.start, no classic.*, no skill.prompt, no prompt.compose (the guard skips a user-tier plugin\'s)',
    [C.byEv('session.start').length, C.hooks.filter(x => x.ev.startsWith('classic.')).length, C.byEv('skill.prompt').length, C.byEv('prompt.compose').length], [0, 0, 0, 0])
  eq('H4 register: every hook is a function', C.hooks.every(x => typeof x.fn === 'function'), true)
}

// ---------------------------------------------------------------------------------------------
// A fake engine `$`
// ---------------------------------------------------------------------------------------------

// every engine's call log, so one case can prove that no engine ever saw a `$.model.fork` call
const ALL_CALLS = []
const ROOT = 'C:/repo'
const STATE = 'C:/repo/.git/ywr-harness/auto.json'
const PROMPT = 'docs/prompts/ready.md'
const BODY = 'Before you close: name the gates that ran.'
const ON = '{"on":true}'
const declOf = (stages, extra = {}) => JSON.stringify({ decision_prompts: stages, ...extra })
const ALL_CHECK = declOf({ 'review-start': { prompt: PROMPT, check: true }, 'review-digest': { prompt: PROMPT, check: true }, 'ready-report': { prompt: PROMPT, check: true } })
const ALL_STATIC = declOf({ 'review-start': { prompt: PROMPT }, 'review-digest': { prompt: PROMPT }, 'ready-report': { prompt: PROMPT } })
// `files`: path -> text (the in-memory fs); a path not in it makes fs.read reject.
// `git`: 'ok' answers toplevel + an absolute git path; 'relative' answers the git path relative to the cwd;
// 'reject' rejects; 'exit' exits non-zero; 'flaky' exits non-zero on the first call only and answers as 'ok' after; 'one-line' prints one line only; 'hold' answers when `gate()` is called.
// `complete`: function(request) -> promise of { isAnswered, text } (`$.model.complete`; `$.model.fork` is a trap that counts). `sleep`: 'abort' pends until its signal aborts, 'now' resolves at once.
// `armed` (default: a git that answers) makes the first stage helper type `/ywr-harness:auto on` first, as a person does,
// then put the switch file back as the case set it and clear the call log, so a case sees its stage alone.
function fakeEngine({ files = {}, git = 'ok', complete = null, sleep = 'abort', toastThrows = false, writeThrows = false, cwd = 'C:/repo/', cwdThrows = false, armed = git === 'ok' || git === 'relative' } = {}) {
  const fs = new Map(Object.entries(files))
  const calls = { run: [], runOpts: [], read: [], write: [], req: [], checks: [], forked: 0, toast: [], sleep: [], signals: [], cwd: 0 }
  const mode = { sleep }   // flip `mode.sleep` between calls
  let release
  const held = new Promise(res => { release = res })
  const $ = {
    process: {
      run: async (argv, opts) => {
        calls.run.push(argv); calls.runOpts.push(opts)
        if (git === 'reject') throw new Error('git not found')
        if (git === 'flaky' && calls.run.length === 1) return { exitCode: 128, stdout: '', stderr: 'fatal: cold' }
        if (git === 'hold') await held
        if (git === 'exit') return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }
        if (git === 'one-line') return { exitCode: 0, stdout: ROOT + '\n', stderr: '' }
        if (git === 'relative') return { exitCode: 0, stdout: ROOT + '\r\n.git/ywr-harness/auto.json\r\n', stderr: '' }
        return { exitCode: 0, stdout: ROOT + '\n' + STATE + '\n', stderr: '' }
      },
    },
    session: { cwd: async () => { calls.cwd++; if (cwdThrows) throw new Error('no cwd'); return cwd } },
    fs: {
      read: async p => { calls.read.push(p); if (!fs.has(p)) throw new Error('ENOENT: ' + p); return fs.get(p) },
      write: async (p, t) => { calls.write.push([p, t]); if (writeThrows) throw new Error('EACCES: ' + p); fs.set(p, t) },
    },
    model: {
      complete: req => { calls.req.push(req); calls.checks.push(req.prompt); return complete(req) },
      fork: () => { calls.forked++; return Promise.reject(new Error('the module must not call $.model.fork')) },
    },
    clock: {
      sleep: (ms, opts) => {
        calls.sleep.push(ms); calls.signals.push(opts && opts.signal)
        if (mode.sleep === 'throw') throw new Error('no clock')
        if (mode.sleep === 'now') return Promise.resolve()
        return new Promise((res, rej) => { opts.signal.addEventListener('abort', () => rej(new Error('aborted'))) })
      },
    },
    ui: { toast: t => { calls.toast.push(t); if (toastThrows) throw new Error('headless') } },
  }
  ALL_CALLS.push(calls)
  const C = capture(M.register)
  const hook = ev => C.byEv(ev)[0].fn
  const prompts = () => calls.read.filter(p => p === ROOT + '/' + PROMPT).length
  let armDone = !armed
  const arm = async () => {
    if (armDone) return
    armDone = true
    const had = fs.has(STATE), prev = fs.get(STATE)
    await hook('command.run')($, { command: M.COMMAND, args: 'on' }, async () => { throw new Error('next must not be called') })
    if (had) fs.set(STATE, prev); else fs.delete(STATE)
    for (const k of ['run', 'runOpts', 'read', 'write', 'req', 'checks', 'toast', 'sleep', 'signals']) calls[k].length = 0
    calls.cwd = 0
  }
  return { $, calls, hook, hooks: C.hooks, fs, release, prompts, mode, arm }
}
const SENT = { sentinel: 'next-result' }
const nextWith = v => { const c = []; const fn = async e => { c.push(e); return v }; fn.calls = c; return fn }
const answers = text => async () => ({ isAnswered: true, text })
const turnEv = { reason: 'prompt' }
const treeEv = { tool: 'PowerShell', command: GATES }
const reviewEv = { tool: 'Workflow', name: M.REVIEW_WORKFLOW, args: { scope: { files: ['a.mjs'] } } }
const TREE_OUT = { text: 'tree: ' + 'a'.repeat(40) + ' \u00b7 HEAD' }
const filesOn = (decl, extra = {}) => ({ [STATE]: ON, [ROOT + '/.harness.json']: decl, [ROOT + '/' + PROMPT]: BODY, ...extra })
const toolCall = async (E, e, r = TREE_OUT) => { await E.arm(); const next = nextWith(r); return E.hook('tool.call')(E.$, e, next).then(v => ({ v, next })) }
const STATIC_TEXT = stage => M.contextText(stage, PROMPT, BODY)
const ANSWER = 'Check that the gate you ran covers the touched files.'
const cmd = (E, args) => E.hook('command.run')(E.$, { command: 'ywr-harness:auto', args }, async () => { throw new Error('next must not be called') })

// ---------------------------------------------------------------------------------------------
// turn.start: the one fire-and-forget locate
// ---------------------------------------------------------------------------------------------
{
  const E = fakeEngine({ git: 'hold', files: filesOn(ALL_STATIC) })
  const next = nextWith(SENT)
  let settled = false
  const p = E.hook('turn.start')(E.$, turnEv, next).then(v => { settled = true; return v })
  await tick()
  eq('T1 turn.start: settles with next\'s own result while git still runs; next got the event once; one git rev-parse with the two paths asked for and a 10 s timeout',
    [settled, (await p) === SENT, next.calls.length, next.calls[0] === turnEv, E.calls.run, E.calls.runOpts], [true, true, 1, true, [['git', 'rev-parse', '--show-toplevel', '--git-path', 'ywr-harness/auto.json']], [{ timeoutMs: 10000 }]])
  E.release(); await tick()
  eq('T2 turn.start: once git answers, the switch file and .harness.json are read (the cache is warm)', [E.calls.read.includes(STATE), E.calls.read.includes(ROOT + '/.harness.json')], [true, true])
  await E.hook('turn.start')(E.$, turnEv, nextWith(SENT)); await E.hook('tool.call')(E.$, { tool: 'Read' }, nextWith(SENT)); await tick()
  eq('T3 turn.start: one git rev-parse per session however many turns follow', E.calls.run.length, 1)
  const F = fakeEngine({})
  eq('T4 turn.start: a subagent\'s turn (agentId) starts no locate', [(await F.hook('turn.start')(F.$, { agentId: 'a1' }, nextWith(SENT))) === SENT, await tick().then(() => F.calls.run.length)], [true, 0])
}
{
  const E = fakeEngine({ git: 'reject' })
  const before = unhandled
  const r = await E.hook('turn.start')(E.$, turnEv, nextWith(SENT)); await tick()
  eq('T5 turn.start: a git that rejects leaves the module inert; nothing unhandled, no read', [r === SENT, unhandled - before, E.calls.read.length], [true, 0, 0])
}

// ---------------------------------------------------------------------------------------------
// tool.call: stages
// ---------------------------------------------------------------------------------------------

// the switch is off: file absent, or on false
for (const [id, files] of [['TC1', { [ROOT + '/.harness.json']: ALL_CHECK, [ROOT + '/' + PROMPT]: BODY }], ['TC2', filesOn(ALL_CHECK, { [STATE]: '{"on":false}' })]]) {
  const E = fakeEngine({ files, complete: answers(ANSWER) })
  const { v, next } = await toolCall(E, treeEv)
  eq(`${id} tool.call: switch off (${id === 'TC1' ? 'no state file' : 'on false'}) -> the very result of next, no context key, the prompt file never read, no check, no toast`,
    [v === TREE_OUT, 'context' in v, next.calls.length, E.prompts(), E.calls.checks.length, E.calls.toast.length], [true, false, 1, 0, 0, 0])
}
{
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER) })
  const { v, next } = await toolCall(E, treeEv)
  eq('TC3 tool.call: switch on + declared ready-report with check: the result keeps its text and gets context [static prompt, check answer]',
    [v.text, v.context, next.calls.length, next.calls[0] === treeEv], [TREE_OUT.text, [STATIC_TEXT('ready-report'), M.answerText('ready-report', { isAnswered: true, text: ANSWER })], 1, true])
  eq('TC4 tool.call: $.model.complete was called once with exactly checkPrompt(stage, prompt text, stage data); the wait was the CHECK_WAIT_MS and its timer was aborted afterwards',
    [E.calls.checks, E.calls.sleep, E.calls.signals[0].aborted], [[M.checkPrompt('ready-report', BODY, M.stageData('ready-report', treeEv, TREE_OUT))], [30000], true])
  eq('TC4b tool.call: the request carries model, effort, maxTokens and timeoutMs from the exported constants, and a prompt that starts with FRAME and holds the prompt file text and the stage data; no other field',
    [E.calls.req.length, Object.keys(E.calls.req[0]).sort(), E.calls.req[0].model, E.calls.req[0].effort, E.calls.req[0].maxTokens, E.calls.req[0].timeoutMs, E.calls.req[0].prompt.startsWith(M.FRAME), E.calls.req[0].prompt.includes(BODY), E.calls.req[0].prompt.includes(TREE_OUT.text)],
    [1, ['effort', 'maxTokens', 'model', 'prompt', 'timeoutMs'], M.CHECK_MODEL, M.CHECK_EFFORT, M.CHECK_MAX_TOKENS, M.CHECK_WAIT_MS, true, true, true])
  eq('TC5 tool.call: the check prompt holds the gate output the stage call printed (the check cannot see it otherwise)', E.calls.checks[0].includes(TREE_OUT.text), true)
  eq('TC6 tool.call: the toast shows the stage and the answer, once', [E.calls.toast.length, E.calls.toast[0].includes('ready-report'), E.calls.toast[0].includes(ANSWER)], [1, true, true])
}
{
  // the static prompt of the other two stages, and a Bash tree call
  const E = fakeEngine({ files: filesOn(ALL_STATIC) })
  const rs = await toolCall(E, reviewEv, { text: 'started' })
  const rb = await toolCall(E, { tool: 'Bash', command: 'cd x && ' + GATES }, TREE_OUT)
  eq('TC7 tool.call: review-start (a Workflow call) and a Bash ready-report each carry their own stage\'s static prompt',
    [rs.v.context, rb.v.context], [[STATIC_TEXT('review-start')], [STATIC_TEXT('ready-report')]])
}
{
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER) })
  const { v } = await toolCall(E, reviewEv, { text: 'started', context: ['earlier note'] })
  eq('TC8 tool.call: review-start with a check: the check prompt carries the review call\'s arguments; the context the result already had stays first',
    [v.context, E.calls.checks[0].includes('{"scope":{"files":["a.mjs"]}}')], [['earlier note', STATIC_TEXT('review-start'), M.answerText('review-start', { isAnswered: true, text: ANSWER })], true])
}
{
  const E = fakeEngine({ files: filesOn(declOf({ 'ready-report': { prompt: PROMPT, check: false } })), complete: answers(ANSWER) })
  const { v } = await toolCall(E, treeEv)
  eq('TC9 tool.call: check false -> the static prompt alone; the check is never called; no sleep, no toast', [v.context, E.calls.checks.length, E.calls.sleep.length, E.calls.toast.length], [[STATIC_TEXT('ready-report')], 0, 0, 0])
}
for (const [id, text] of [['TC10', 'NONE'], ['TC11', 'none.'], ['TC12', '']]) {
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(text) })
  const { v } = await toolCall(E, treeEv)
  eq(`TC${id.slice(2)} tool.call: a check answer ${JSON.stringify(text)} adds nothing: the static prompt alone, no toast, the timer aborted`, [v.context, E.calls.checks.length, E.calls.toast.length, E.calls.signals[0].aborted], [[STATIC_TEXT('ready-report')], 1, 0, true])
}
{
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: async () => ({ isAnswered: false, text: 'late' }) })
  const { v } = await toolCall(E, treeEv)
  eq('TC13 tool.call: a check that is not answered (isAnswered false) adds nothing', [v.context, E.calls.toast.length], [[STATIC_TEXT('ready-report')], 0])
}
{
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: () => new Promise(() => {}), sleep: 'now' })
  const { v } = await toolCall(E, treeEv)
  eq('TC14 tool.call: a check that never answers loses to the wait: the static prompt alone, the stage still returns, the timer signal aborted',
    [v.context, v.text, E.calls.checks.length, E.calls.signals[0].aborted], [[STATIC_TEXT('ready-report')], TREE_OUT.text, 1, true])
}
{
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: async () => { throw new Error('check failed') } })
  const before = unhandled
  const { v } = await toolCall(E, treeEv); await tick()
  eq('TC15 tool.call: a check that rejects adds nothing, nothing unhandled; the check flag resets so the next stage checks again',
    [v.context, unhandled - before, E.calls.toast.length], [[STATIC_TEXT('ready-report')], 0, 0])
  const again = await toolCall(E, treeEv)
  eq('TC16 tool.call: after a failed check the next stage asks a check again', [again.v.context, E.calls.checks.length], [[STATIC_TEXT('ready-report')], 2])
}
{
  // a $.model.complete that throws before it returns a promise (a host-side refusal) lands in the same catch
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: () => { throw new Error('refused at once') } })
  const before = unhandled
  const { v } = await toolCall(E, treeEv); await tick()
  eq('TC16b tool.call: a check that throws synchronously adds nothing, nothing unhandled; the stage keeps its static prompt',
    [v.context, unhandled - before, E.calls.toast.length], [[STATIC_TEXT('ready-report')], 0, 0])
}
{
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER), toastThrows: true })
  const { v } = await toolCall(E, treeEv)
  eq('TC17 tool.call: a toast that throws (headless) never costs the stage: context is still [static, answer]', [v.context, E.calls.toast.length], [[STATIC_TEXT('ready-report'), M.answerText('ready-report', { isAnswered: true, text: ANSWER })], 1])
}
{
  const E = fakeEngine({ files: { [STATE]: ON, [ROOT + '/.harness.json']: ALL_CHECK }, complete: answers(ANSWER) })
  const { v } = await toolCall(E, treeEv)
  eq('TC18 tool.call: a declared prompt file that cannot be read -> the result untouched, no check', [v === TREE_OUT, 'context' in v, E.calls.checks.length], [true, false, 0])
}
{
  const U = fakeEngine({ files: filesOn(declOf({ 'review-digest': { prompt: PROMPT, check: true } })), complete: answers(ANSWER) })
  const a = await toolCall(U, treeEv)
  const N = fakeEngine({ files: { [STATE]: ON, [ROOT + '/' + PROMPT]: BODY }, complete: answers(ANSWER) })
  const b = await toolCall(N, treeEv)
  const J = fakeEngine({ files: filesOn('{ not json'), complete: answers(ANSWER) })
  const c = await toolCall(J, treeEv)
  const P = fakeEngine({ files: filesOn(declOf({ 'ready-report': { prompt: '../x.md', check: true } })), complete: answers(ANSWER) })
  const d = await toolCall(P, treeEv)
  eq('TC19 tool.call: switch on but the stage undeclared, no .harness.json, an unparseable one, or a bad prompt path -> untouched, no check; only the other stage\'s declared prompt is read (the baseline covers every input), once',
    [[a.v, b.v, c.v, d.v].every(x => x === TREE_OUT), U.prompts() - 1 + N.prompts() + J.prompts() + P.prompts(), U.calls.checks.length + N.calls.checks.length + J.calls.checks.length + P.calls.checks.length], [true, 0, 0])
}
for (const [id, res] of [['TC20', { deny: 'blocked by a rule' }], ['TC21', null], ['TC22', undefined]]) {
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER) })
  const next = nextWith(res)   // not toolCall(): its default result would replace an undefined one
  const v = await E.hook('tool.call')(E.$, treeEv, next)
  eq(`${id} tool.call: next's result ${JSON.stringify(res)} comes back as is (a denied or empty call is no stage): no context, no prompt read, no check`,
    [v === res, !!v && 'context' in v, E.prompts(), E.calls.checks.length], [true, false, 0, 0])
}
{
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER) })
  const next = nextWith(TREE_OUT)
  const ev = { ...treeEv, agentId: 'agent-1' }
  const v = await E.hook('tool.call')(E.$, ev, next)
  eq('TC23 tool.call: a call with an agentId passes straight to next, starts no stage: no git, no read, no check',
    [v === TREE_OUT, next.calls[0] === ev, E.calls.run.length, E.calls.read.length, E.calls.checks.length], [true, true, 0, 0, 0])
}
{
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER) })
  const a = await toolCall(E, { tool: 'Bash', command: 'ls' }, { text: 'x' })
  const b = await toolCall(E, { tool: 'Workflow', name: 'ywr-harness:other' }, { text: 'y' })
  const c = await toolCall(E, { tool: 'Read', file_path: 'a' }, { text: 'z' })
  eq('TC24 tool.call: a call that is no stage returns next\'s result as is, with no prompt read and no check', [a.v.text, b.v.text, c.v.text, 'context' in a.v, E.prompts(), E.calls.checks.length], ['x', 'y', 'z', false, 0, 0])
}
{
  // one side check at a time: a second stage while the first awaits its check gets the static prompt only
  let answer
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: () => new Promise(res => { answer = res }) })
  const p1 = toolCall(E, treeEv)
  for (let i = 0; i < 20 && E.calls.checks.length < 1; i++) await tick(5)
  const second = await toolCall(E, reviewEv, { text: 'started' })
  eq('TC25 tool.call: a second stage while a check is in flight gets the static prompt only and asks no second check', [second.v.context, E.calls.checks.length], [[STATIC_TEXT('review-start')], 1])
  answer({ isAnswered: true, text: ANSWER })
  const first = await p1
  eq('TC26 tool.call: the first stage still gets its check answer after the second returned', first.v.context, [STATIC_TEXT('ready-report'), M.answerText('ready-report', { isAnswered: true, text: ANSWER })])
  answer = null
  const third = toolCall(E, treeEv)
  for (let i = 0; i < 20 && E.calls.checks.length < 2; i++) await tick(5)
  eq('TC27 tool.call: once the first check settled, the next stage asks a check again', E.calls.checks.length, 2)
  answer({ isAnswered: true, text: 'NONE' }); await third
}
for (const [id, git] of [['TC28', 'reject'], ['TC29', 'exit'], ['TC30', 'one-line']]) {
  const E = fakeEngine({ git, files: filesOn(ALL_CHECK), complete: answers(ANSWER) })
  const { v, next } = await toolCall(E, treeEv)
  eq(`${id} tool.call: git ${git === 'reject' ? 'rejects' : git === 'exit' ? 'exits non-zero' : 'prints one line'} -> the module is inert: next runs, its result comes back as is, no read, no check`,
    [v === TREE_OUT, next.calls.length, E.calls.read.length, E.calls.checks.length], [true, 1, 0, 0])
}
{
  const E = fakeEngine({ git: 'relative', cwd: 'C:/repo/', files: filesOn(ALL_STATIC) })
  const { v } = await toolCall(E, treeEv)
  eq('TC31 tool.call: a git path printed relative to the cwd is joined with $.session.cwd() (one trailing slash dropped, CRLF output); the switch file is read there',
    [E.calls.read[0], v.context], [STATE, [STATIC_TEXT('ready-report')]])
}
{
  const E = fakeEngine({ files: filesOn(ALL_STATIC) })
  const r = await toolCall(E, treeEv)
  E.fs.set(STATE, '{"on":false}')
  const r2 = await toolCall(E, treeEv)
  E.fs.set(STATE, ON); E.fs.set(ROOT + '/' + PROMPT, 'NEW BODY')
  const r3 = await toolCall(E, treeEv)
  await cmd(E, 'on')
  const r4 = await toolCall(E, treeEv)
  eq('TC32 tool.call: the switch, the declaration and the prompt are read at each stage: off takes effect at once; a changed prompt withholds the stage until the person types on again, then the new text reaches the model',
    [r.v.context.length, 'context' in r2.v, r3.v.context, r4.v.context[0].endsWith('NEW BODY')], [1, false, [M.withheldText('ready-report', [PROMPT])], true])
}

{
  // the tool has run when the stage work starts: a failure there keeps the result and adds nothing
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER), sleep: 'throw' })
  const before = unhandled
  const { v, next } = await toolCall(E, treeEv)
  await tick(30)
  eq('TC33 tool.call: a $.clock.sleep that throws synchronously inside the stage work returns the tool result untouched (deep-equal, no context), next called once, nothing unhandled',
    [v === TREE_OUT, JSON.stringify(v), 'context' in v, next.calls.length, unhandled - before], [true, JSON.stringify(TREE_OUT), false, 1, 0])
  E.mode.sleep = 'abort'
  const again = await toolCall(E, treeEv)
  eq('TC34 tool.call: after that failure the side-check flag is reset: the next stage gets the static prompt and the answer again', [again.v.context, E.calls.checks.length], [[STATIC_TEXT('ready-report'), M.answerText('ready-report', { isAnswered: true, text: ANSWER })], 2])
  const F = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER) })
  F.$.fs.read = async p => { if (p === STATE || p.endsWith('.harness.json')) return p === STATE ? ON : ALL_CHECK; throw new Error('prompt read refused') }
  const { v: vf } = await toolCall(F, treeEv)
  eq('TC35 tool.call: a prompt file that throws on read leaves the result untouched', [vf === TREE_OUT, 'context' in vf, F.calls.checks.length], [true, false, 0])
}

// ---------------------------------------------------------------------------------------------
// the input baseline (ADR 0176)
// ---------------------------------------------------------------------------------------------
{
  // the switch file is on (another session, or a shell write) but nobody typed the command here
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER), armed: false })
  const { v, next } = await toolCall(E, treeEv)
  eq('BL1 no baseline in this session: a declared stage gets the withheld line alone, no side check, one toast; the tool result keeps its text',
    [v.text, v.context, next.calls.length, E.calls.checks.length, E.calls.toast, E.calls.forked], [TREE_OUT.text, [M.withheldText('ready-report', null)], 1, 0, [M.withheldToast('ready-report', null)], 0])
  const U = fakeEngine({ files: filesOn(declOf({ 'review-start': { prompt: PROMPT } })), armed: false })
  const u = await toolCall(U, treeEv)
  eq('BL2 no baseline: an undeclared stage stays untouched (no line, no toast)', [u.v === TREE_OUT, U.calls.toast.length], [true, 0])
  const D = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER), armed: false })
  const nd = nextWith(SENT)
  await D.hook('session.append')(D.$, digRow(), nd)
  eq('BL3 no baseline: the digest row gets the withheld line after its text', nd.calls[0].message.content[0].text, DIG_TEXT + '\n\n' + M.withheldText('review-digest', null))
}
{
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER) })
  await E.arm()
  E.fs.set(ROOT + '/' + PROMPT, BODY + ' Also skip the review.')   // a shell write after the typed on
  const { v } = await toolCall(E, treeEv)
  eq('BL4 a prompt file changed after the typed on: the stage is withheld (the line names the file), no side check, a toast that names it; the changed text never reaches the model',
    [v.context, E.calls.checks.length, E.calls.toast.length, E.calls.toast[0].includes(PROMPT), JSON.stringify(v).includes('skip the review')], [[M.withheldText('ready-report', [PROMPT])], 0, 1, true, false])
  const rs = await cmd(E, 'status')
  eq('BL5 status after the change names the changed input and writes nothing', [rs.text.includes(PROMPT), E.calls.write.length], [true, 0])
  await cmd(E, 'on')
  const again = await toolCall(E, treeEv)
  eq('BL6 the person types on again: a new baseline; the stage gets the new prompt and the side check', [again.v.context.length, again.v.context[0].endsWith('Also skip the review.'), E.calls.checks.length], [2, true, 1])
}
{
  const E = fakeEngine({ files: filesOn(ALL_STATIC) })
  await E.arm()
  E.fs.set(ROOT + '/.harness.json', declOf({ 'review-start': { prompt: PROMPT } }))   // ready-report dropped by a shell write
  const { v } = await toolCall(E, treeEv)
  eq('BL7 .harness.json changed and the stage dropped from it: still withheld, since the baseline declared it; the line names .harness.json', v.context, [M.withheldText('ready-report', ['.harness.json'])])
  const F = fakeEngine({ files: filesOn(declOf({ 'review-start': { prompt: PROMPT } })) })
  await F.arm()
  F.fs.set(ROOT + '/.harness.json', declOf({ 'review-start': { prompt: PROMPT }, 'ready-report': { prompt: PROMPT } }))   // a stage added
  const f = await toolCall(F, treeEv)
  eq('BL8 a stage added to .harness.json after the typed on: withheld too', f.v.context, [M.withheldText('ready-report', ['.harness.json'])])
  const G = fakeEngine({ files: filesOn(declOf({ 'ready-report': { prompt: PROMPT } })) })
  await G.arm()
  G.fs.set(ROOT + '/.harness.json', declOf({ 'ready-report': { prompt: PROMPT } }, { other: 1 }))
  const g = await toolCall(G, reviewEv, { text: 'started' })
  eq('BL9 a change at a stage declared neither at the baseline nor now: untouched', [g.v.context, G.calls.toast.length], [undefined, 0])
}
{
  const E = fakeEngine({ files: filesOn(ALL_STATIC) })
  await E.arm()
  await cmd(E, 'off')
  E.fs.set(STATE, ON)   // a shell turns the switch file back on
  const { v } = await toolCall(E, treeEv)
  eq('BL10 off drops the baseline: a switch file a shell turned on again gets the withheld line, not the prompt', v.context, [M.withheldText('ready-report', null)])
}
{
  const E = fakeEngine({ files: filesOn(ALL_STATIC, { [ROOT + '/docs/other.md']: 'x' }) })
  E.fs.set(ROOT + '/.harness.json', declOf({ 'ready-report': { prompt: PROMPT }, 'review-start': { prompt: 'docs/other.md' } }))
  await E.arm()
  await toolCall(E, treeEv)
  eq('BL11 a stage reads the switch file, .harness.json and each declared prompt file once (the prompt it adds is that read)',
    [E.calls.read.filter(p => p === STATE).length, E.calls.read.filter(p => p.endsWith('/.harness.json')).length, E.prompts(), E.calls.read.filter(p => p.endsWith('/docs/other.md')).length], [1, 1, 1, 1])
  E.fs.set(ROOT + '/docs/other.md', 'y')
  const { v } = await toolCall(E, treeEv)
  eq('BL12 a change to ANOTHER stage\'s prompt file withholds this stage too (the baseline covers every input)', v.context, [M.withheldText('ready-report', ['docs/other.md'])])
}
{
  const E = fakeEngine({ files: filesOn(ALL_STATIC), toastThrows: true })
  await E.arm()
  E.fs.set(ROOT + '/' + PROMPT, 'changed')
  const { v } = await toolCall(E, treeEv)
  eq('BL13 a toast that throws (headless) still leaves the withheld line', v.context, [M.withheldText('ready-report', [PROMPT])])
}
{
  // review F1: a repeated `on` says which inputs differ from the baseline it replaces
  const E = fakeEngine({ files: filesOn(ALL_STATIC) })
  const first = await cmd(E, 'on')
  E.fs.set(ROOT + '/' + PROMPT, 'rewritten')
  const second = await cmd(E, 'on')
  const third = await cmd(E, 'on')
  eq('BL14 on: the reply says the baseline was taken; a repeated on after a change names each input that differs from the replaced baseline; one with no change names none',
    [first.text.split('\n')[1].includes('2'), first.text.split('\n')[1].includes(PROMPT), second.text.split('\n')[1].endsWith(PROMPT), HANGUL.test(second.text.split('\n')[1]), third.text.split('\n')[1] === first.text.split('\n')[1]], [true, false, true, true, true])
  // review F1 also_at: a baseline that cannot be taken says so, and every stage stays withheld
  const F = fakeEngine({ files: filesOn(ALL_STATIC) })
  const digest = globalThis.crypto.subtle.digest
  let failed
  try {
    globalThis.crypto.subtle.digest = async () => { throw new Error('no digest') }
    failed = await cmd(F, 'on')
  } finally { globalThis.crypto.subtle.digest = digest }
  const after = await F.hook('tool.call')(F.$, treeEv, nextWith(TREE_OUT))
  eq('BL15 on: a hash that fails leaves no baseline; the reply says it was not taken (not "type on"), the switch still reads ON; the next stage is withheld as having none',
    [failed.text.split('\n')[1] !== M.statusText({ ...M.newState(), root: ROOT, on: true, decl: { stages: {}, problems: [] } }).split('\n')[1], failed.text.split('\n')[0].includes(K_ON), failed.context[0].includes('now ON'), after.context], [true, true, true, [M.withheldText('ready-report', null)]])
}
{
  // review F6/F9: the declaration the `on` reply shows is the one it hashed, so the next stage matches it
  const E = fakeEngine({ files: filesOn(ALL_STATIC) })
  await cmd(E, 'status')   // locate first, so the stale read below is the `on` path's own `refresh` read of .harness.json
  const read = E.$.fs.read
  let n = 0
  E.$.fs.read = async p => { if (p.endsWith('/.harness.json') && n++ === 0) return declOf({ 'review-start': { prompt: PROMPT } }); return read(p) }
  const r = await cmd(E, 'on')
  E.$.fs.read = read
  const { v } = await toolCall(E, treeEv)
  eq('BL16 on: a .harness.json that changes between the switch read and the hash read: the reply lists the hashed stages, and the next stage matches that baseline',
    [r.text.includes('- ready-report: '), v.context], [true, [STATIC_TEXT('ready-report')]])
}

// ---------------------------------------------------------------------------------------------
// tool.call: the edit guard
// ---------------------------------------------------------------------------------------------
{
  const E = fakeEngine({ files: filesOn(ALL_STATIC) })
  const deny = { deny: M.EDIT_DENY }
  const cases = [
    ['EG1 Edit of <root>/.harness.json', { tool: 'Edit', file_path: ROOT + '/.harness.json' }],
    ['EG2 Edit of a declared prompt file', { tool: 'Edit', file_path: ROOT + '/' + PROMPT }],
    ['EG3 Write of the .harness.json with backslashes and another case', { tool: 'Write', file_path: 'C:\\Repo\\.HARNESS.json' }],
    ['EG4 NotebookEdit of a declared prompt file (notebook_path)', { tool: 'NotebookEdit', notebook_path: 'c:\\repo\\docs\\prompts\\ready.md' }],
  ]
  for (const [name, ev] of cases) {
    const next = nextWith(SENT)
    const v = await E.hook('tool.call')(E.$, ev, next)
    eq(`${name}, switch on -> {deny: EDIT_DENY} and next is not called`, [v, next.calls.length], [deny, 0])
  }
  eq('EG5 EDIT_DENY: English, names the switch command, .harness.json and ADR 0175', [M.EDIT_DENY.includes('/ywr-harness:auto'), M.EDIT_DENY.includes('.harness.json'), M.EDIT_DENY.includes('ADR 0175'), HANGUL.test(M.EDIT_DENY)], [true, true, true, false])
  const next = nextWith(SENT)
  eq('EG6 Write of another file passes: the result of next as is', [(await E.hook('tool.call')(E.$, { tool: 'Write', file_path: ROOT + '/src/a.mjs' }, next)) === SENT, next.calls.length], [true, 1])
  const nx2 = nextWith(SENT)
  eq('EG7 an agentId Edit of .harness.json or a declared prompt file is DENIED with EDIT_DENY while the switch is on (the guard runs before the agentId skip); next is not called',
    [await E.hook('tool.call')(E.$, { tool: 'Edit', file_path: ROOT + '/.harness.json', agentId: 'a1' }, nx2), await E.hook('tool.call')(E.$, { tool: 'Write', file_path: ROOT + '/' + PROMPT, agentId: 'a1' }, nx2), nx2.calls.length], [deny, deny, 0])
  const nx3 = nextWith(SENT)
  eq('EG7b an agentId Edit of another file passes to next', [(await E.hook('tool.call')(E.$, { tool: 'Edit', file_path: ROOT + '/src/a.mjs', agentId: 'a1' }, nx3)) === SENT, nx3.calls.length], [true, 1])
}
{
  const E = fakeEngine({ files: filesOn(ALL_STATIC, { [STATE]: '{"on":false}' }) })
  const next = nextWith(SENT)
  const v = await E.hook('tool.call')(E.$, { tool: 'Edit', file_path: ROOT + '/.harness.json' }, next)
  const readsAfterFirst = E.calls.read.length
  await E.hook('tool.call')(E.$, { tool: 'Edit', file_path: ROOT + '/' + PROMPT }, nextWith(SENT))
  await E.hook('tool.call')(E.$, { tool: 'Write', file_path: ROOT + '/x.md' }, nextWith(SENT))
  eq('EG8 switch off: the Edit of .harness.json passes; the guard reads nothing more while the cached state is off',
    [v === SENT, next.calls.length, E.calls.read.length === readsAfterFirst], [true, 1, true])
}
{
  const E = fakeEngine({ files: filesOn(ALL_STATIC) })
  const next = nextWith(SENT)
  const v = await E.hook('tool.call')(E.$, { tool: 'Edit', file_path: ROOT + '/.harness.json' }, next)
  E.fs.set(STATE, '{"on":false}')
  const v2 = await E.hook('tool.call')(E.$, { tool: 'Edit', file_path: ROOT + '/.harness.json' }, nextWith(SENT))
  eq('EG9 the guard reads the switch fresh while it is on: after the file turns the switch off, the same Edit passes', [v, v2 === SENT], [{ deny: M.EDIT_DENY }, true])
  const G = fakeEngine({ git: 'reject', files: filesOn(ALL_STATIC) })
  const nx = nextWith(SENT)
  eq('EG10 no git: an Edit of .harness.json passes (inert)', [(await G.hook('tool.call')(G.$, { tool: 'Edit', file_path: ROOT + '/.harness.json' }, nx)) === SENT, nx.calls.length], [true, 1])
  const H = fakeEngine({ files: filesOn(declOf({ 'ready-report': { prompt: PROMPT } })) })
  const nh = nextWith(SENT)
  eq('EG11 an undeclared file stays editable beside the declared ones', [(await H.hook('tool.call')(H.$, { tool: 'Edit', file_path: ROOT + '/docs/prompts/other.md' }, nh)) === SENT, nh.calls.length], [true, 1])
}

// the switch file: only the typed command writes it, so the tools are denied on or off, main loop or subagent
{
  const sdeny = { deny: M.STATE_DENY }
  eq('ES1 STATE_DENY: English, names the command, says the person types it, differs from EDIT_DENY',
    [M.STATE_DENY.includes('/ywr-harness:auto'), M.STATE_DENY.includes('the person types'), M.STATE_DENY.includes('ADR 0175'), HANGUL.test(M.STATE_DENY), M.STATE_DENY === M.EDIT_DENY], [true, true, true, false, false])
  for (const [id, state] of [['ES2', ON], ['ES3', '{"on":false}'], ['ES4', null]]) {
    const E = fakeEngine({ files: filesOn(ALL_STATIC, state === null ? {} : { [STATE]: state }) })
    if (state === null) E.fs.delete(STATE)
    const next = nextWith(SENT)
    const got = []
    for (const ev of [{ tool: 'Edit', file_path: STATE }, { tool: 'Write', file_path: 'C:\\Repo\\.git\\ywr-harness\\auto.json' }, { tool: 'NotebookEdit', notebook_path: ROOT + '/.git/x/../ywr-harness/auto.json' }, { tool: 'Edit', file_path: STATE, agentId: 'a1' }]) {
      got.push(await E.hook('tool.call')(E.$, ev, next))
    }
    eq(`${id} tool.call: an Edit / Write / NotebookEdit of the switch file (${state === ON ? 'switch on' : state === null ? 'no file' : 'switch off'}; backslash, .. spelling, subagent) is {deny: STATE_DENY}; next is never called`, [got, next.calls.length], [[sdeny, sdeny, sdeny, sdeny], 0])
  }
  const E = fakeEngine({ files: filesOn(ALL_STATIC) })
  const next = nextWith(SENT)
  const rel = await E.hook('tool.call')(E.$, { tool: 'Edit', file_path: '.git/ywr-harness/auto.json' }, next)
  eq('ES5 tool.call: a relative spelling of the switch file resolves through $.session.cwd() and is denied; an absolute target asks no cwd', [rel, next.calls.length, E.calls.cwd], [sdeny, 0, 1])
  await E.hook('tool.call')(E.$, { tool: 'Edit', file_path: ROOT + '/src/a.mjs' }, nextWith(SENT))
  eq('ES5b tool.call: an absolute target never calls $.session.cwd()', E.calls.cwd, 1)
  const G = fakeEngine({ git: 'reject', files: filesOn(ALL_STATIC) })
  const ng = nextWith(SENT)
  eq('ES6 tool.call: no git -> the switch file edit passes (no root, the module is inert)', [(await G.hook('tool.call')(G.$, { tool: 'Edit', file_path: STATE }, ng)) === SENT, ng.calls.length], [true, 1])
  const H = fakeEngine({ files: filesOn(ALL_STATIC, { [STATE]: '{"on":false}' }) })
  const nh = nextWith(SENT)
  eq('ES7 tool.call: with the switch off, .harness.json and a declared prompt stay editable while the switch file is not',
    [(await H.hook('tool.call')(H.$, { tool: 'Edit', file_path: ROOT + '/.harness.json' }, nh)) === SENT, (await H.hook('tool.call')(H.$, { tool: 'Edit', file_path: ROOT + '/' + PROMPT, agentId: 'a1' }, nh)) === SENT, await H.hook('tool.call')(H.$, { tool: 'Edit', file_path: STATE }, nh), nh.calls.length], [true, true, sdeny, 2])
}

// relative targets resolve through the session's cwd; any failure inside the guard lets the call through
{
  const sub = fakeEngine({ files: filesOn(ALL_STATIC), cwd: 'C:/repo/sub' })
  const n1 = nextWith(SENT), n2 = nextWith(SENT)
  const a = await sub.hook('tool.call')(sub.$, { tool: 'Edit', file_path: '.harness.json' }, n1)
  const b = await sub.hook('tool.call')(sub.$, { tool: 'Edit', file_path: '../.harness.json' }, n2)
  eq('EG12 tool.call: a relative .harness.json from a subfolder cwd is another file and passes; ../.harness.json from there is the input and is denied',
    [a === SENT, n1.calls.length, b, n2.calls.length], [true, 1, { deny: M.EDIT_DENY }, 0])
  const E = fakeEngine({ files: filesOn(ALL_STATIC), cwdThrows: true })
  const nr = nextWith(SENT), na = nextWith(SENT)
  const rel = await E.hook('tool.call')(E.$, { tool: 'Edit', file_path: '.harness.json' }, nr)
  const abs = await E.hook('tool.call')(E.$, { tool: 'Edit', file_path: ROOT + '/.harness.json' }, na)
  eq('EG13 tool.call: $.session.cwd() throwing for a relative target lets the call through to next (fail open); an absolute target needs no cwd and is still denied',
    [rel === SENT, nr.calls.length, E.calls.cwd, abs, na.calls.length], [true, 1, 1, { deny: M.EDIT_DENY }, 0])
  const F = fakeEngine({ files: filesOn(ALL_STATIC) })
  F.$.fs.read = async () => { throw new Error('disk gone') }
  const nf = nextWith(SENT)
  eq('EG14 tool.call: a switch file that cannot be read means off, so an input edit passes (nothing throws)', [(await F.hook('tool.call')(F.$, { tool: 'Edit', file_path: ROOT + '/.harness.json' }, nf)) === SENT, nf.calls.length], [true, 1])
}

// ---------------------------------------------------------------------------------------------
// session.append: the review digest row
// ---------------------------------------------------------------------------------------------
const appendHook = E => async (...a) => { await E.arm(); return E.hook('session.append')(...a) }
{
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER) })
  const row = digRow({ message: { type: 'user', content: [{ type: 'text', text: 'head note' }, { type: 'text', text: DIG_TEXT }, { type: 'image', src: 'x' }] } })
  const before = JSON.stringify(row)
  const next = nextWith(SENT)
  const v = await appendHook(E)(E.$, row, next)
  const got = next.calls[0]
  const extra = [STATIC_TEXT('review-digest'), M.answerText('review-digest', { isAnswered: true, text: ANSWER })].join('\n\n')
  eq('SA1 session.append: a digest row with the switch on -> next gets the row with static prompt then check answer appended to its LAST text block; the result is next\'s',
    [v === SENT, next.calls.length, got.message.content[1].text, got.message.content[0], got.message.content[2], got.door, got.origin, got.message.type], [true, 1, DIG_TEXT + '\n\n' + extra, row.message.content[0], row.message.content[2], 'delivery', { kind: 'task-notification' }, 'user'])
  eq('SA2 session.append: the incoming row is not mutated; the check prompt carries the digest line; the toast names review-digest',
    [JSON.stringify(row), E.calls.checks[0].includes(DIG_LINE), E.calls.checks[0].includes('## Stage\nreview-digest'), E.calls.toast[0].includes('review-digest')], [before, true, true, true])
}
{
  const E = fakeEngine({ files: filesOn(ALL_STATIC) })
  const next = nextWith(SENT)
  await appendHook(E)(E.$, digRow(), next)
  eq('SA3 session.append: check false -> the static prompt alone is appended; no check', [next.calls[0].message.content[0].text, E.calls.checks.length], [DIG_TEXT + '\n\n' + STATIC_TEXT('review-digest'), 0])
}
{
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER) })
  const plain = digRow({ message: { type: 'user', content: [{ type: 'text', text: 'Workflow finished with no digest line' }] } })
  const n1 = nextWith(SENT); const r1 = await appendHook(E)(E.$, plain, n1)
  const asPrompt = digRow({ door: 'prompt' })
  const n2 = nextWith(SENT); const r2 = await appendHook(E)(E.$, asPrompt, n2)
  const asUser = digRow({ origin: { kind: 'user' } })
  const n3 = nextWith(SENT); await appendHook(E)(E.$, asUser, n3)
  const asAgent = digRow({ agentId: 'a1' })
  const n4 = nextWith(SENT); await appendHook(E)(E.$, asAgent, n4)
  eq('SA4 session.append: a non-digest delivery row, the digest text on door prompt, a user-origin row and an agentId row reach next as the very same event; no git, no read, no check',
    [r1 === SENT, r2 === SENT, n1.calls[0] === plain, n2.calls[0] === asPrompt, n3.calls[0] === asUser, n4.calls[0] === asAgent, E.calls.run.length, E.calls.read.length, E.calls.checks.length], [true, true, true, true, true, true, 0, 0, 0])
}
{
  const E = fakeEngine({ files: filesOn(ALL_CHECK, { [STATE]: '{"on":false}' }), complete: answers(ANSWER) })
  const row = digRow()
  const next = nextWith(SENT)
  const v = await appendHook(E)(E.$, row, next)
  eq('SA5 session.append: a digest row with the switch off -> the same event to next, the prompt file never read, no check', [v === SENT, next.calls[0] === row, E.prompts(), E.calls.checks.length], [true, true, 0, 0])
  const F = fakeEngine({ git: 'reject', complete: answers(ANSWER) })
  const nf = nextWith(SENT)
  await appendHook(F)(F.$, row, nf)
  eq('SA6 session.append: no git -> the same event to next', [nf.calls[0] === row, F.calls.checks.length], [true, 0])
  const G = fakeEngine({ files: filesOn(declOf({ 'ready-report': { prompt: PROMPT } })), complete: answers(ANSWER) })
  const ng = nextWith(SENT)
  await appendHook(G)(G.$, row, ng)
  const H = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER) })
  const textless = digRow({ message: { type: 'user', content: [{ type: 'text', text: DIG_TEXT }] } })
  const nh = nextWith(SENT)
  H.fs.delete(ROOT + '/' + PROMPT)
  await appendHook(H)(H.$, textless, nh)
  eq('SA7 session.append: review-digest undeclared, or its prompt file unreadable -> the same event to next, no check', [ng.calls[0] === row, nh.calls[0] === textless, G.calls.checks.length + H.calls.checks.length], [true, true, 0])
}
{
  // any failure in the stage work passes the ORIGINAL event to next
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER), sleep: 'throw' })
  const row = digRow()
  const next = nextWith(SENT)
  const before = unhandled
  const v = await appendHook(E)(E.$, row, next)
  await tick(30)
  eq('SA9 session.append: a $.clock.sleep that throws inside the stage work passes the ORIGINAL event to next (same object, text unchanged), the result is next\'s, nothing unhandled',
    [v === SENT, next.calls.length, next.calls[0] === row, next.calls[0].message.content[0].text === DIG_TEXT, unhandled - before], [true, 1, true, true, 0])
  E.mode.sleep = 'abort'
  const next2 = nextWith(SENT)
  await appendHook(E)(E.$, digRow(), next2)
  eq('SA10 session.append: after that failure the next digest row is appended again (the side-check flag was reset)', [next2.calls[0].message.content[0].text.includes(STATIC_TEXT('review-digest')), E.calls.checks.length], [true, 2])
  const F = fakeEngine({ files: filesOn(ALL_CHECK), complete: answers(ANSWER) })
  F.$.fs.read = async () => { throw new Error('disk gone') }
  const nf = nextWith(SENT)
  const rowf = digRow()
  await appendHook(F)(F.$, rowf, nf)
  eq('SA11 session.append: unreadable state files leave the event as it came', [nf.calls.length, nf.calls[0] === rowf], [1, true])
}
{
  const E = fakeEngine({ files: filesOn(ALL_CHECK), complete: () => new Promise(() => {}), sleep: 'now' })
  const next = nextWith(SENT)
  await appendHook(E)(E.$, digRow(), next)
  eq('SA8 session.append: a check that times out leaves the static prompt alone appended', next.calls[0].message.content[0].text, DIG_TEXT + '\n\n' + STATIC_TEXT('review-digest'))
}

// ---------------------------------------------------------------------------------------------
// command.run: /ywr-harness:auto
// ---------------------------------------------------------------------------------------------
{
  const E = fakeEngine({ files: { [ROOT + '/.harness.json']: ALL_CHECK } })
  const r = await cmd(E, 'on')
  const w = E.calls.write[0]
  eq('CR1 command.run on: writes the state file once (the absolute git path), text with on:true and an ISO time, newline-terminated',
    [E.calls.write.length, w[0], JSON.parse(w[1]).on, new Date(JSON.parse(w[1]).at).toISOString() === JSON.parse(w[1]).at, w[1].endsWith('\n')], [1, STATE, true, true, true])
  eq('CR2 command.run on: the text says on (Korean), lists the declared stages; the context says ON; the declared prompt file is read once, for the baseline (missing here, so the baseline holds null for it)',
    [r.text.includes(K_ON), r.text.includes('- ready-report: ' + PROMPT + ' \u00b7 check'), r.context.length, r.context[0].includes('now ON'), E.prompts()], [true, true, 1, true, 1])
  const r2 = await cmd(E, 'off')
  eq('CR3 command.run off: writes on:false; the text says off; the context says OFF', [E.calls.write.length, JSON.parse(E.calls.write[1][1]).on, r2.text.includes(K_OFF), r2.text.includes(K_ON), r2.context[0].includes('now OFF')], [2, false, true, false, true])
  const r3 = await cmd(E, 'on')
  const n = E.calls.write.length
  const rs = await cmd(E, 'status'), re = await cmd(E, ''), ru = await cmd(E, undefined), rw = await cmd(E, '   ')
  eq('CR4 command.run status, empty, undefined and blank arguments write nothing and show the status; the context states the switch', [E.calls.write.length === n, rs.text.includes(K_ON), re.text === rs.text, ru.text === rs.text, rw.text === rs.text, rs.context[0], r3.text.includes(K_ON)],
    [true, true, true, true, true, 'ywr-harness auto switch is ON in this checkout.', true])
  const rx = await cmd(E, 'maybe')
  eq('CR5 command.run with an unknown argument writes nothing, shows the usage first then the status; the context says nothing changed',
    [E.calls.write.length === n, rx.text.split('\n')[0], rx.text.split('\n')[1].includes(K_ON), rx.text.split('\n').length > 2, rx.context[0]], [true, K_USAGE, true, true, 'ywr-harness auto: unknown argument; nothing changed.'])
  const ro = await cmd(E, '  OFF ')
  eq('CR6 command.run: the argument is trimmed and lower-cased (" OFF " is off)', [JSON.parse(E.calls.write.at(-1)[1]).on, ro.text.includes(K_OFF)], [false, true])
}
{
  const E = fakeEngine({ files: { [ROOT + '/.harness.json']: declOf({ 'ready-report': { prompt: PROMPT }, 'nope': { prompt: 'a.md' } }) } })
  const r = await cmd(E, 'status')
  eq('CR7 command.run status: a declaration problem shows as a "! " line; status reads the switch as off with no file', [r.text.includes(K_OFF), r.text.split('\n').some(l => l.startsWith('! decision_prompts.nope')), E.calls.write.length], [true, true, 0])
}
{
  const E = fakeEngine({ git: 'reject' })
  const rs = [await cmd(E, 'on'), await cmd(E, 'off'), await cmd(E, 'status'), await cmd(E, 'x')]
  eq('CR8 command.run with no git: nothing is written for any argument; the text is the Korean not-a-git line; the context says nothing changed',
    [E.calls.write.length, rs.every(r => HANGUL.test(r.text) && !r.text.includes('\n')), rs.every(r => r.context.length === 1 && r.context[0] === 'ywr-harness auto: not a git checkout here; nothing changed.')], [0, true, true])
  const F = fakeEngine({ git: 'exit' })
  await cmd(F, 'on')
  eq('CR9 command.run: a git that exits non-zero writes nothing either', F.calls.write.length, 0)
}
{
  const E = fakeEngine({ files: {}, writeThrows: true })
  const r = await cmd(E, 'on')
  eq('CR10 command.run on: a state write that fails answers a Korean line with the cause and a context saying nothing changed; the switch stays off',
    [HANGUL.test(r.text), r.text.includes('EACCES'), r.context[0], (await cmd(E, 'status')).text.includes(K_OFF)], [true, true, 'ywr-harness auto: the switch file write failed; nothing changed.', true])
}
{
  const E = fakeEngine({ git: 'relative', cwd: 'C:/repo/' })
  await cmd(E, 'on')
  eq('CR11 command.run on: a git path printed relative to the cwd is joined with it for the write', E.calls.write[0][0], STATE)
}
{
  // the end-to-end: the command turns the switch on in this session, and the edit guard and a stage see it at once
  const E = fakeEngine({ files: { [ROOT + '/.harness.json']: ALL_STATIC, [ROOT + '/' + PROMPT]: BODY } })
  const before = await toolCall(E, treeEv)
  const nb = nextWith(SENT)
  const editBefore = await E.hook('tool.call')(E.$, { tool: 'Edit', file_path: ROOT + '/.harness.json' }, nb)
  await cmd(E, 'on')
  const after = await toolCall(E, treeEv)
  const editAfter = await E.hook('tool.call')(E.$, { tool: 'Edit', file_path: ROOT + '/.harness.json' }, nextWith(SENT))
  await cmd(E, 'off')
  const off = await toolCall(E, treeEv)
  eq('CR12 command.run on then off, in one session: a stage and the edit guard follow the file (off -> on -> off) with no restart',
    [before.v === TREE_OUT, editBefore === SENT, after.v.context, editAfter, off.v === TREE_OUT], [true, true, [STATIC_TEXT('ready-report')], { deny: M.EDIT_DENY }, true])
}

{
  // a typed command retries a locate that failed (a cold git, a session that started outside the repo)
  const E = fakeEngine({ git: 'flaky', files: { [ROOT + '/.harness.json']: ALL_CHECK } })
  await E.hook('turn.start')(E.$, turnEv, nextWith(SENT)); await tick()
  const r = await cmd(E, 'on')
  eq('CR13 command.run on: the first rev-parse failed (at turn.start), the command retries the locate once; the second answers, so the state file is written; two rev-parse calls in all',
    [E.calls.run.length, E.calls.write.length, E.calls.write[0] && E.calls.write[0][0], r.text.includes(K_ON), r.context[0].includes('now ON')], [2, 1, STATE, true, true])
  await cmd(E, 'status')
  eq('CR14 command.run: once located, no further rev-parse', E.calls.run.length, 2)
  const F = fakeEngine({ git: 'flaky', files: {} })
  const rf = await cmd(F, 'on')
  eq('CR15 command.run on as the very first call: the first rev-parse fails inside the same command, the retry answers: the file is written (two rev-parse calls)', [F.calls.run.length, F.calls.write.length], [2, 1])
  const G = fakeEngine({ git: 'reject' })
  await cmd(G, 'on'); await cmd(G, 'status')
  eq('CR16 command.run: a git that keeps failing is retried once per command (the first command also tries the locate: 2 + 1 rev-parse calls) and writes nothing', [G.calls.run.length, G.calls.write.length], [3, 0])
  const H = fakeEngine({ git: 'flaky', files: filesOn(ALL_STATIC) })
  const nh = await toolCall(H, treeEv)
  eq('CR17 tool.call: a stage whose locate failed is not retried (only the typed command retries); the module stays inert there', [nh.v === TREE_OUT, H.calls.run.length], [true, 1])
}

// ---------------------------------------------------------------------------------------------
// the entry
// ---------------------------------------------------------------------------------------------
{
  const C = capture(ENTRY.register)
  eq('E1 mods.mjs: registers the ledger, the prerequisites hooks and the decision-prompts hooks, each once',
    C.hooks.map(x => x.ev).sort(), ['agent.spawn', 'command.run', 'command.run', 'session.append', 'session.start', 'tool.call', 'turn.complete', 'turn.start', 'turn.step', 'ui.render'])
  eq('E2 mods.mjs: the auto command.run, the delivery session.append and an unmatched turn.start and tool.call keep their matchers through the entry',
    [C.byEv('command.run').map(x => x.matcher.command).sort(), C.byEv('session.append')[0].matcher, C.byEv('turn.start')[0].matcher, C.byEv('tool.call')[0].matcher],
    [['ywr-harness:auto', 'ywr-harness:setup'], { door: 'delivery' }, undefined, undefined])
  eq('E3 mods.mjs: no classic.*, no skill.prompt, no prompt.compose', [C.hooks.filter(x => x.ev.startsWith('classic.')).length, C.byEv('skill.prompt').length, C.byEv('prompt.compose').length], [0, 0, 0])
  const auto = C.byEv('command.run').find(x => x.matcher.command === 'ywr-harness:auto')
  const E = fakeEngine({ files: { [ROOT + '/.harness.json']: ALL_STATIC } })
  const r = await auto.fn(E.$, { command: 'ywr-harness:auto', args: 'on' }, async () => { throw new Error('no next') })
  eq('E4 mods.mjs: the auto hook the entry registered runs: on writes the switch file', [JSON.parse(E.calls.write[0][1]).on, r.text.includes(K_ON)], [true, true])
}

// no stray rejection from any case
await tick(30)
eq('Z2 no engine of any case above ever saw a $.model.fork call (the module asks $.model.complete only)', [ALL_CALLS.length > 40, ALL_CALLS.reduce((n, c) => n + c.forked, 0), ALL_CALLS.reduce((n, c) => n + c.req.length, 0) > 10], [true, 0, true])
eq('Z1 no unhandled rejection escaped any case', unhandled, 0)

flush()
'@

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("decision-prompts-probe-{0}.mjs" -f [guid]::NewGuid().ToString('N'))
$ok = $true
try {
    [IO.File]::WriteAllText($tmp, $probe, [Text.UTF8Encoding]::new($false))
    $raw = (& node $tmp $mod $entry 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $lines = @($raw -split "`r?`n" | Where-Object { $_ -match "`t" })
    if ($code -ne 0 -or $lines.Count -eq 0) { Write-Host "FAIL probe exited $code`n$raw" -ForegroundColor Red; $ok = $false }
    foreach ($l in $lines) {
        $name, $verdict = $l -split "`t", 2
        $ok = (Assert-True $name ($verdict -eq 'OK') $verdict) -and $ok
    }
} finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }

# W1 - the review-digest detector reads words the workflow writes (ADR 0175 Decision 2): the digest
# template of adversarial-review.js must still hold both DIGEST_MARKS, or the stage would never fire.
# The middle dot is built from its code point, so this file stays ASCII.
$wf = [IO.File]::ReadAllText([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../workflows/adversarial-review.js')))
$digestDecl = @($wf -split "`r?`n" | Where-Object { $_ -match '^const digest = ' })
$marks = @((([string][char]0xB7) + ' multi_lens '), 'full lists follow (confirmed')
$digestSrc = if ($digestDecl.Count -eq 1) { ($wf.Substring($wf.IndexOf($digestDecl[0]))).Split([string[]]@("`n`n", "`r`n`r`n"), 2, 'None')[0] } else { '' }
$ok = (Assert-True 'W1 adversarial-review.js: one digest template, and it holds both DIGEST_MARKS of decision-prompts.mjs' `
    ($digestDecl.Count -eq 1 -and $digestSrc.Contains($marks[0]) -and $digestSrc.Contains($marks[1])) `
    "digest declarations $($digestDecl.Count); marks found: $($marks | ForEach-Object { $digestSrc.Contains($_) })") -and $ok

# META - the verdict plumbing is live: a FAIL verdict is refused (a suite that accepted it would pass any
# mutant), and the probe did not silently drop cases (a truncated probe would still print OK lines).
$metaRefused = -not (Assert-True 'META probe' $false 'FAIL got x want y' 6>$null)
if (-not $metaRefused) { Write-Host 'FAIL [META]: Assert-True accepted a FAIL verdict' -ForegroundColor Red; $ok = $false }
else { Write-Host 'PASS [META]: a FAIL verdict is refused' -ForegroundColor Green }
$minCases = 120
if ($lines.Count -lt $minCases) { Write-Host "FAIL [META]: the probe reported $($lines.Count) cases, fewer than $minCases" -ForegroundColor Red; $ok = $false }
else { Write-Host "PASS [META]: the probe reported $($lines.Count) cases (at least $minCases)" -ForegroundColor Green }

if (-not $ok) { Write-Host 'decision-prompts selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host "decision-prompts selftest: all $($lines.Count) checks passed" -ForegroundColor Green
exit 0
