# Self-test for prerequisites.mjs, the plugin's prerequisite-check hooks module (Claude Mods; ADR 0142).
# Usage: pwsh plugins/ywr-harness/hooks/prerequisites.selftest.ps1
#
# CI has no claude CLI, so the module is driven here under plain node with a FAKE engine: a fake `on`
# captures the hooks, a fake `$` answers process.run / process.spawn / env.get / session.append /
# ui.invalidate / ui.resolve / ui.status / clock.after, and each `next` is a stub whose result the hook must hand back
# untouched. The module draws with a GLOBAL `h` (the engine's JSX factory), so the probe defines one before
# it imports the module. What this suite proves is the contract the host cannot check for us: the pure half
# (version parsing, the missing / old / ok / unknown verdict, the Korean band and the English model note,
# the exact winget argv, the exit-code lines, the inline-class flattening of child output) is right; the
# hook set is exactly session.start, ui.render on AbovePrompt and command.run on ywr-harness:setup, and no
# prompt.compose; session.start returns what `next` resolved to BEFORE the probes settle, starts them on a
# `$.clock.after(0, ...)` timer and runs them directly when that call throws (ADR 0164), and a probe that
# misses, is old, is unknown, or whose append or invalidate fails never reaches the session; the band and
# the note speak only for a missing or old tool; `/ywr-harness:setup` installs nothing off Windows, without
# winget or when no tool can be probed, runs the winget installs one at a time in TOOLS order, streams only
# a flattened, de-duplicated last line to the status line, and always clears that line; and the entry
# `mods.mjs` registers these hooks beside the ledger's. What it cannot prove — the engine's own event
# shapes, that `$.process.spawn` streams the way the fake does, that the band renders, that the host
# answers a plugin skill command through `command.run` and loads the module at all — is `claude plugin
# validate`'s and the live `--plugin-dir` run's (spec 0012 §3 Mods row); `claude plugin test` stays a local
# habit. Nobody has measured a real winget install yet (ADR 0142 follow-ups).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core
Assert-NodeOrExit 'prerequisites'
$mod = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'prerequisites.mjs'))
$entry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'mods.mjs'))

$probe = @'
import { pathToFileURL } from 'node:url'
globalThis.h = (type, props, ...children) => ({ type, props, children })
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
const T = Object.fromEntries(M.TOOLS.map(t => [t.name, t]))
// Korean text is built from escapes, so this file stays ASCII.
const K_ESC = 'Esc 를 누르면 설치가 끊길 수 있습니다'   // Esc 를 누르면 설치가 끊길 수 있습니다
const TAIL = ' · ' + K_ESC                                    // the install head's warning suffix
const K_INSTALLING ='설치 중'                         // 설치 중
const K_NEED = '이상 필요'                         // 이상 필요
const K_NONE = '없음'                                      // 없음
const K_ALL = '모두'                                       // 모두
const HANGUL = /[가-힣]/
const ASCII = /^[\x00-\x7f]*$/
const ch = c => String.fromCharCode(c)
// the flattened class, built from char codes (a literal U+2028 / U+0085 in source text can materialize)
const BAD = new RegExp('[' + ch(0) + '-' + ch(0x1f) + ch(0x7f) + ch(0x85) + ch(0x2028) + ch(0x2029) + '`]')

// ---------------------------------------------------------------------------------------------
// Pure half
// ---------------------------------------------------------------------------------------------

eq('TOOLS: node, pwsh, python in that order; min null / 7.0 / 3.9; the three winget ids',
  [M.TOOLS.map(t => t.name), M.TOOLS.map(t => t.min), M.TOOLS.map(t => t.winget)],
  [['node', 'pwsh', 'python'], [null, [7, 0], [3, 9]], ['OpenJS.NodeJS.LTS', 'Microsoft.PowerShell', 'Python.Python.3.13']])
eq('constants: COMMAND, probe timeout, winget up-to-date code 0x8A15002B',
  [M.COMMAND, M.PROBE_TIMEOUT_MS, M.WINGET_UP_TO_DATE], ['ywr-harness:setup', 15000, 2316632107])

// P: parseVersion
eq('P1 parseVersion: PowerShell line with CRLF', M.parseVersion('PowerShell 7.6.6\r\n'), [7, 6])
eq('P2 parseVersion: v24.14.0', M.parseVersion('v24.14.0'), [24, 14])
eq('P3 parseVersion: Python 3.13.13', M.parseVersion('Python 3.13.13'), [3, 13])
eq('P4 parseVersion: garbage, a bare number, empty, null, undefined all null',
  [M.parseVersion('garbage'), M.parseVersion('7'), M.parseVersion(''), M.parseVersion(null), M.parseVersion(undefined)], [null, null, null, null, null])

// V: verdictOf
const run = (exitCode, stdout = '', stderr = '') => ({ result: { exitCode, stdout, stderr } })
eq('V1 verdictOf: exit 0 + pwsh 7.6.6 -> ok 7.6', M.verdictOf(T.pwsh, run(0, 'PowerShell 7.6.6\r\n')), { state: 'ok', version: '7.6' })
eq('V2 verdictOf: exit 9009 (Windows "not recognized") -> missing', M.verdictOf(T.node, run(9009)), { state: 'missing' })
eq('V3 verdictOf: any non-zero exit is missing (the Store python alias)', [1, 127, 49].map(c => M.verdictOf(T.python, run(c, '', 'Python was not found')).state), ['missing', 'missing', 'missing'])
eq('V4 verdictOf: a rejection whose message holds ENOENT: Command not found -> missing',
  [M.verdictOf(T.node, { error: new Error("ENOENT: Command 'x' not found") }).state,
   M.verdictOf(T.node, { error: { message: "ENOENT: Command 'x' not found" } }).state,
   M.verdictOf(T.node, { error: "Command 'x' not found" }).state], ['missing', 'missing', 'missing'])
eq('V5 verdictOf: a timed-out rejection -> unknown', [M.verdictOf(T.node, { error: new Error('timed out') }), M.verdictOf(T.node, { error: 'timed out' })],
  [{ state: 'unknown' }, { state: 'unknown' }])
eq('V6 verdictOf: pwsh 6.2 -> old, version 6.2', M.verdictOf(T.pwsh, run(0, 'PowerShell 6.2.7')), { state: 'old', version: '6.2' })
eq('V7 verdictOf: python 3.8 -> old; 3.9 -> ok; 3.13 -> ok; 2.7 on stderr -> old; 4.0 -> ok',
  [M.verdictOf(T.python, run(0, 'Python 3.8.10')), M.verdictOf(T.python, run(0, 'Python 3.9.0')), M.verdictOf(T.python, run(0, 'Python 3.13.13')),
   M.verdictOf(T.python, run(0, '', 'Python 2.7.18')), M.verdictOf(T.python, run(0, 'Python 4.0.0'))],
  [{ state: 'old', version: '3.8' }, { state: 'ok', version: '3.9' }, { state: 'ok', version: '3.13' }, { state: 'old', version: '2.7' }, { state: 'ok', version: '4.0' }])
eq('V8 verdictOf: pwsh boundary 7.0 ok, 6.9 old', [M.verdictOf(T.pwsh, run(0, '7.0.0')).state, M.verdictOf(T.pwsh, run(0, '6.9.9')).state], ['ok', 'old'])
eq('V9 verdictOf: node has no minimum, any version is ok', [M.verdictOf(T.node, run(0, 'v0.10.48')), M.verdictOf(T.node, run(0, 'v24.14.0'))],
  [{ state: 'ok', version: '0.10' }, { state: 'ok', version: '24.14' }])
eq('V10 verdictOf: exit 0 with an unparseable version -> ok, version null (even for a tool with a minimum)',
  [M.verdictOf(T.pwsh, run(0, 'weird output')), M.verdictOf(T.python, run(0, '', ''))], [{ state: 'ok', version: null }, { state: 'ok', version: null }])
eq('V11 verdictOf: a malformed outcome is unknown',
  [undefined, null, 'x', 7, {}, { result: null }, { result: {} }, { result: { exitCode: '0' } }, { result: { exitCode: null } }].map(o => M.verdictOf(T.node, o).state),
  ['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown'])

// N: needsOf
{
  const n = M.needsOf([{ state: 'old', version: '1.0' }, { state: 'ok', version: '7.6' }, { state: 'missing' }])
  eq('N1 needsOf: keeps TOOLS order, only missing / old, version null when absent',
    n.map(x => [x.tool.name, x.state, x.version]), [['node', 'old', '1.0'], ['python', 'missing', null]])
  eq('N2 needsOf: unknown and ok are dropped; short, empty, null input gives []',
    [M.needsOf([{ state: 'unknown' }, { state: 'ok' }, { state: 'unknown' }]), M.needsOf([]), M.needsOf(null), M.needsOf(undefined)], [[], [], [], []])
  eq('N3 needsOf: a sparse array (missing slots) does not throw and keeps the index', M.needsOf([undefined, { state: 'missing' }]).map(x => x.tool.name), ['pwsh'])
}

// B: bandText / noteText / manualText
{
  const needs = M.needsOf([{ state: 'missing' }, { state: 'old', version: '6.2' }, { state: 'old', version: '3.8' }])
  const band = M.bandText(needs)
  eq('B1 bandText: names every tool and /ywr-harness:setup, and is Korean',
    [band.includes('node'), band.includes('pwsh'), band.includes('python'), band.includes('/ywr-harness:setup'), HANGUL.test(band), band.startsWith('[ywr-harness]')], [true, true, true, true, true, true])
  eq('B2 bandText: an old tool renders `pwsh 6.2 (7.0 <Korean needs>)`, a missing one is the bare name',
    [band.includes('pwsh 6.2 (7.0 ' + K_NEED + ')'), band.includes('python 3.8 (3.9 ' + K_NEED + ')'), band.includes('node 0'), band.includes('node ·')], [true, true, false, true])
  eq('B3 bandText: a single missing tool names only it', M.bandText(M.needsOf([{ state: 'missing' }])).includes('pwsh'), false)

  const note = M.noteText(needs)
  eq('B4 noteText: English (ASCII only), names each tool and the command',
    [ASCII.test(note), note.includes('`node`'), note.includes('`pwsh`'), note.includes('`python`'), note.includes('/ywr-harness:setup')], [true, true, true, true, true])
  eq('B5 noteText: says the plugin installs nothing until the user types the command',
    [note.includes('the plugin installs nothing until the user types it'), note.includes('winget')], [true, true])
  eq('B6 noteText: missing and old are told apart; the old line names both versions',
    [M.noteText(M.needsOf([{ state: 'missing' }])).includes('`node` is not on PATH'), note.includes('`pwsh` 6.2 is older than the 7.0'), note.includes('`python` 3.8 is older than the 3.9')], [true, true, true])
  eq('B7 noteText: states facts only, no imperative aimed at the model',
    [/\b(?:you (?:should|must|need|can)|please|must|should|do not|don't|never|always|ignore|install (?:it|them|the))\b/i.test(note), /\n[A-Z][a-z]+ (?:the|a|an|it|them) /.test('\n' + note.split('\n').slice(1, -1).join('\n'))],
    [false, false])
  eq('B8 noteText: first line identifies the source, then one line per tool, then the closing facts',
    [note.split('\n').length, note.split('\n')[0].startsWith('ywr-harness prerequisite check')], [1 + 3 + 1, true])

  eq('B9 manualText: Windows gives one backticked winget line per tool, in order',
    M.manualText(M.needsOf([{ state: 'missing' }, { state: 'ok' }, { state: 'missing' }]), true).split('\n'),
    ['- node: `' + M.wingetArgv(T.node).join(' ') + '`', '- python: `' + M.wingetArgv(T.python).join(' ') + '`'])
  eq('B10 manualText: off Windows gives each tool\'s `other` line',
    M.manualText(M.needsOf([{ state: 'missing' }, { state: 'missing' }, { state: 'missing' }]), false).split('\n'),
    ['- node: ' + T.node.other, '- pwsh: ' + T.pwsh.other, '- python: ' + T.python.other])
}

// W: wingetArgv
{
  const FLAGS = ['--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity', '--silent']
  eq('W1 wingetArgv: node', M.wingetArgv(T.node), ['winget', 'install', '--id', 'OpenJS.NodeJS.LTS', ...FLAGS])
  eq('W2 wingetArgv: pwsh', M.wingetArgv(T.pwsh), ['winget', 'install', '--id', 'Microsoft.PowerShell', ...FLAGS])
  eq('W3 wingetArgv: python', M.wingetArgv(T.python), ['winget', 'install', '--id', 'Python.Python.3.13', ...FLAGS])
}

// R: resultLine
{
  const ok = M.resultLine(T.node, 0), upd = M.resultLine(T.node, 2316632107), upd2 = M.resultLine(T.node, -1978335189)
  const bad = M.resultLine(T.python, 1603), nul = M.resultLine(T.python, null)
  // the PATH hint carries the word PATH; the python-only Windows app-execution-alias hint carries python.exe
  const hint = s => [s.includes('PATH'), s.includes('python.exe')]
  eq('R1 resultLine: 0 is a non-failure line with the PATH hint, and no python alias hint for node',
    [ok.startsWith('- node: '), ok.includes('winget exit'), hint(ok)], [true, false, [true, false]])
  eq('R2 resultLine: 0x8A15002B as unsigned and as signed give the same non-failure line, different from exit 0, PATH hint only',
    [upd === upd2, upd.includes('winget exit'), upd === ok, upd.startsWith('- node: '), hint(upd)], [true, false, false, true, [true, false]])
  const py0 = M.resultLine(T.python, 0), pyUpd = M.resultLine(T.python, 2316632107), pyUpd2 = M.resultLine(T.python, -1978335189)
  eq('R6 resultLine: the python alias hint shows for python on exit 0 and on up-to-date (both encodings), on top of the PATH hint, and is not a failure',
    [hint(py0), hint(pyUpd), pyUpd === pyUpd2, py0.startsWith('- python: '), py0.includes('winget exit'), pyUpd.includes('winget exit')], [[true, true], [true, true], true, true, false, false])
  eq('R7 resultLine: pwsh gets the PATH hint without the python alias hint; failure lines carry neither hint',
    [hint(M.resultLine(T.pwsh, 0)), hint(M.resultLine(T.pwsh, 2316632107)), hint(bad), hint(nul)], [[true, false], [true, false], [false, false], [false, false]])
  eq('R3 resultLine: 1603 is a failure naming the exit and the manual command',
    [bad.startsWith('- python: '), bad.includes('winget exit 1603'), bad.includes('`' + M.wingetArgv(T.python).join(' ') + '`')], [true, true, true])
  eq('R4 resultLine: null is a failure with the no-exit word', [nul.includes('winget exit ' + K_NONE), nul.includes('null')], [true, false])
  eq('R5 resultLine: a near-miss of the up-to-date code and a non-number are failures',
    [M.resultLine(T.node, 2316632108).includes('winget exit 2316632108'), M.resultLine(T.node, '0').includes('winget exit'), M.resultLine(T.node, undefined).includes('winget exit')], [true, true, true])
}

// RN: resultNote (the English note for the model)
{
  const n0 = M.resultNote(T.node, 0), nu = M.resultNote(T.node, 2316632107), nu2 = M.resultNote(T.node, -1978335189)
  const nb = M.resultNote(T.python, 1603), nn = M.resultNote(T.python, null)
  const all = [n0, nu, nu2, nb, nn, M.resultNote(T.pwsh, 0), M.resultNote(T.node, 2316632108), M.resultNote(T.node, '0')]
  eq('RN1 resultNote: every note is English, ASCII only, no Hangul, no newline, and starts with the tool name',
    [all.every(s => ASCII.test(s)), all.some(s => HANGUL.test(s)), all.some(s => s.includes('\n')), n0.startsWith('node: '), nb.startsWith('python: ')], [true, false, false, true, true])
  eq('RN2 resultNote: exit 0 says winget exited 0 and that PATH is known only after a restart; it is no failure',
    [n0.includes('winget exited 0'), n0.includes('PATH'), n0.includes('restart'), n0.includes('failed')], [true, true, true, false])
  eq('RN3 resultNote: 0x8A15002B as unsigned and as signed give the same note: already installed, not found on PATH, no failure',
    [nu === nu2, nu.includes('already installed'), nu.includes('PATH'), nu.includes('failed'), nu === n0], [true, true, true, false, false])
  eq('RN4 resultNote: 1603 is a failure naming the exit, and reports no success', [nb, nb.includes('winget failed (exit 1603)'), nb.includes('exited 0'), nb.includes('already installed')],
    ['python: winget failed (exit 1603).', true, false, false])
  eq('RN5 resultNote: null is a failure with "none"; a near-miss code and a non-number are failures',
    [nn, M.resultNote(T.node, 2316632108).includes('winget failed (exit 2316632108)'), M.resultNote(T.node, '0').includes('winget failed'), M.resultNote(T.node, undefined).includes('winget failed')],
    ['python: winget failed (exit none).', true, true, true])
  eq('RN6 resultNote: the python alias hint is a member-facing Korean line, never in the model note', [nb.includes('python.exe'), M.resultNote(T.python, 0).includes('python.exe')], [false, false])
}

// F: flatten
{
  const cls = []
  for (let c = 0; c <= 0x1f; c++) cls.push(c)
  cls.push(0x7f, 0x85, 0x2028, 0x2029, 0x60)
  const leaked = cls.filter(c => M.flatten('a' + ch(c) + 'b') !== 'a b')
  eq('F1 flatten: every member of the class (C0, DEL, NEL, LS, PS, backtick) becomes a space (' + cls.length + ' members)', leaked, [])
  const kept = [0x20, 0x21, 0x7e, 0x80, 0x84, 0x86, 0x9f, 0xa0, 0x2027, 0x202a, 0xad, 0x3000].filter(c => c === 0x20 || M.flatten('a' + ch(c) + 'b') === 'a' + ch(c) + 'b')
  eq('F2 flatten: neighbours of the class pass through (U+0080-0084, 0086, 009F, 00A0, 2027, 202A, ...)', kept.length, 12)
  eq('F3 flatten: runs of spaces collapse, edges trim', [M.flatten('a   b'), M.flatten('a' + ch(13) + ch(10) + ch(9) + ' b'), M.flatten(ch(10) + ' a ' + ch(10)), M.flatten('   ')], ['a b', 'a b', 'a', ''])
  const long = 'x'.repeat(200)
  eq('F4 flatten: cap 160 with an ellipsis as the 160th character',
    [M.flatten(long).length, M.flatten(long).endsWith('…'), M.flatten(long).slice(0, 159) === 'x'.repeat(159)], [160, true, true])
  eq('F5 flatten: exactly 160 unchanged, 161 cut; a custom max', [M.flatten('x'.repeat(160)).length, M.flatten('x'.repeat(160)).includes('…'), M.flatten('x'.repeat(161)).endsWith('…'), M.flatten('abcdef', 4)],
    [160, false, true, 'abc…'])
  eq('F6 flatten: null and undefined give the empty string', [M.flatten(null), M.flatten(undefined)], ['', ''])
}

// L: lastLine
{
  const CR = ch(13), LF = ch(10)
  eq('L1 lastLine: CR-separated progress gives the last frame', M.lastLine('Downloading 10%' + CR + 'Downloading 50%'), 'Downloading 50%')
  eq('L2 lastLine: a trailing single spinner glyph is skipped', [M.lastLine('Installing' + CR + LF + '|'), M.lastLine('Installing' + CR + '\\' + CR + '-' + CR), M.lastLine('Installing' + LF + '/' + LF)],
    ['Installing', 'Installing', 'Installing'])
  eq('L3 lastLine: only single-glyph lines, or empty, or null gives the empty string', [M.lastLine('-'), M.lastLine('|' + CR + '/' + LF + 'a'), M.lastLine(''), M.lastLine(null), M.lastLine(CR + LF + CR + LF)], ['', '', '', '', ''])
  eq('L4 lastLine: the last of several lines, trailing newline ignored', M.lastLine('one' + LF + 'two' + LF), 'two')
  eq('L5 lastLine: the line is flattened (control chars and a backtick become spaces, runs collapse)', M.lastLine('ab' + ch(7) + ch(7) + 'cd `ef`'), 'ab cd ef')
  eq('L6 lastLine: capped at 160 with an ellipsis', M.lastLine('y'.repeat(300)).length, 160)
}

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
  eq('H1 register: exactly session.start, ui.render, command.run — and no prompt.compose',
    [C.hooks.map(x => x.ev).sort(), C.byEv('prompt.compose').length], [['command.run', 'session.start', 'ui.render'], 0])
  eq('H2 register: ui.render matches AbovePrompt, command.run matches ywr-harness:setup, session.start has no matcher',
    [C.byEv('ui.render')[0].matcher, C.byEv('command.run')[0].matcher, C.byEv('session.start')[0].matcher],
    [{ component: 'AbovePrompt' }, { command: 'ywr-harness:setup' }, undefined])
  eq('H3 register: every hook is a function', C.hooks.every(x => typeof x.fn === 'function'), true)
}

// ---------------------------------------------------------------------------------------------
// A fake engine `$`
// ---------------------------------------------------------------------------------------------

const SENT = { sentinel: 'next-result' }
const NEXT_BAND = { sentinel: 'next-band' }
const OKS = {
  node: { exitCode: 0, stdout: 'v24.14.0\n', stderr: '' },
  pwsh: { exitCode: 0, stdout: 'PowerShell 7.6.6\r\n', stderr: '' },
  python: { exitCode: 0, stdout: 'Python 3.13.13\n', stderr: '' },
  winget: { exitCode: 0, stdout: 'v1.12.0\n', stderr: '' },
}
const enoent = n => Object.assign(new Error(`ENOENT: Command '${n}' not found`), { code: 'ENOENT' })
// `by`: argv[0] -> result object | Error to reject with | function(argv) | promise factory. Unlisted -> OKS.
// `clock`: 'timer' runs each $.clock.after callback on a real setTimeout, 'manual' holds it in `timers`,
// 'throws' throws from the call, 'late-throw' schedules the callback and then throws, 'none' leaves $.clock out.
function fakeEngine({ by = {}, os = 'Windows_NT', localAppData, envThrowsFor = [], noProcess = false, appendImpl = null, invalidateImpl = null, envThrows = false, statusImpl = null, spawnImpl = null, clock = 'timer' } = {}) {
  const calls = { run: [], runOpts: [], append: [], invalidate: [], spawn: [], status: [], env: [], after: [] }
  const timers = []
  const io = { active: 0, peak: 0 }
  const $ = {
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text' }),
      invalidate: ev => { calls.invalidate.push(ev); if (invalidateImpl) return invalidateImpl(ev) },
      status: t => { calls.status.push(t); if (statusImpl) statusImpl(t) },
    },
    session: { append: async m => { calls.append.push(m); if (appendImpl) return appendImpl(m) } },
    env: { get: async k => { calls.env.push(k); if (envThrows || envThrowsFor.includes(k)) throw new Error('no env'); return k === 'OS' ? os : k === 'LOCALAPPDATA' ? localAppData : undefined } },
  }
  if (!noProcess) {
    $.process = {
      run: (argv, opts) => {
        calls.run.push(argv); calls.runOpts.push(opts)
        const v = by[argv[0]] ?? OKS[argv[0]]
        if (typeof v === 'function') return v(argv)
        if (v instanceof Error) return Promise.reject(v)
        return Promise.resolve(v)
      },
      spawn: arg => {
        calls.spawn.push(arg)
        io.active++; io.peak = Math.max(io.peak, io.active)
        return spawnImpl(arg, () => { io.active-- })
      },
    }
  }
  if (clock !== 'none') {
    $.clock = {
      after: (ms, fn) => {
        calls.after.push(ms)
        if (clock === 'throws') throw new Error('no clock')
        if (clock === 'manual') timers.push(fn); else setTimeout(fn, ms)
        if (clock === 'late-throw') throw new Error('timer built, then failed')
        return { cancel() {} }
      },
    }
  }
  const C = capture(M.register)
  const hook = ev => C.byEv(ev)[0].fn
  return { $, calls, io, hook, hooks: C.hooks, timers }
}
const startEv = { reason: 'startup' }
const bandEv = (hasSurvey = false) => ({ props: { hasSurvey } })
const nextWith = v => { const c = []; const fn = async e => { c.push(e); return v }; fn.calls = c; return fn }
const bandText = n => n.children[0].children[0]

// ---------------------------------------------------------------------------------------------
// session.start + ui.render
// ---------------------------------------------------------------------------------------------

// S1: returns what next resolved to BEFORE the probes settle (each probe hangs on its own promise)
{
  const gates = {}
  const by = Object.fromEntries(['node', 'pwsh', 'python'].map(n => [n, () => new Promise(res => { gates[n] = res })]))
  const E = fakeEngine({ by })
  const next = nextWith(SENT)
  let settled = false
  const p = E.hook('session.start')(E.$, startEv, next).then(v => { settled = true; return v })
  await tick()
  eq('S1 session.start: settles with probes still pending; next was called once with the event; the probes started after it',
    [settled, next.calls.length, next.calls[0] === startEv, E.calls.run.map(a => a[0]), E.calls.runOpts.every(o => o && o.timeoutMs === M.PROBE_TIMEOUT_MS)],
    [true, 1, true, ['node', 'pwsh', 'python'], true])
  const bandNow = await E.hook('ui.render')(E.$, bandEv(), nextWith(NEXT_BAND))
  eq('S2 ui.render: before the probes finish the band hook passes next(e) through', bandNow, NEXT_BAND)
  gates.node({ exitCode: 0, stdout: 'v24.14.0', stderr: '' }); gates.pwsh({ exitCode: 0, stdout: 'PowerShell 7.6.6', stderr: '' }); gates.python({ exitCode: 0, stdout: 'Python 3.13.13', stderr: '' })
  eq('S3 session.start: the hook returns the very object next resolved to', (await p) === SENT, true)
  await tick()
  eq('S4 session.start: all three ok -> no append, no invalidate', [E.calls.append.length, E.calls.invalidate.length], [0, 0])
  const nx = nextWith(NEXT_BAND)
  eq('S5 ui.render: all ok -> next(e) and its value', [(await E.hook('ui.render')(E.$, bandEv(), nx)) === NEXT_BAND, nx.calls.length], [true, 1])
}

// S6..: node missing (ENOENT), pwsh ok, python old -> one note, one invalidate, one band
{
  const E = fakeEngine({ by: { node: enoent('node'), python: { exitCode: 0, stdout: 'Python 3.8.10', stderr: '' } } })
  const next = nextWith(SENT)
  const r = await E.hook('session.start')(E.$, startEv, next)
  await tick()
  const needs = M.needsOf([{ state: 'missing' }, { state: 'ok', version: '7.6' }, { state: 'old', version: '3.8' }])
  eq('S6 session.start: returns next\'s object even when the probes find a miss', r === SENT, true)
  eq('S7 session.start: exactly one session.append, a user row with one text block equal to noteText(needs)',
    [E.calls.append.length, E.calls.append[0]], [1, { message: { type: 'user', content: [{ type: 'text', text: M.noteText(needs) }] } }])
  eq('S8 session.start: exactly one ui.invalidate of ui.render', E.calls.invalidate, ['ui.render'])
  eq('S9 session.start: the three probes ran once each, argv from TOOLS, no other command', E.calls.run, [['node', '--version'], ['pwsh', '--version'], ['python', '--version']])
  const nx = nextWith(NEXT_BAND)
  const band = await E.hook('ui.render')(E.$, bandEv(false), nx)
  eq('S10 ui.render: the band is a Box holding one Text whose text is bandText(needs); next not called',
    [band && band.type, band && band.children.length, band && band.children[0].type, bandText(band), nx.calls.length], ['Box', 1, 'Text', M.bandText(needs), 0])
  eq('S11 ui.render: the band text names node and python 3.8 (3.9 needed), not pwsh',
    [bandText(band).includes('node'), bandText(band).includes('python 3.8 (3.9 ' + K_NEED + ')'), bandText(band).includes('pwsh')], [true, true, false])
  const nxs = nextWith(NEXT_BAND)
  eq('S12 ui.render: with a survey up the band yields to next(e)', [(await E.hook('ui.render')(E.$, bandEv(true), nxs)) === NEXT_BAND, nxs.calls.length], [true, 1])
}

// S13: a command that exits non-zero (the Store python alias) and an old pwsh
{
  const E = fakeEngine({ by: { python: { exitCode: 9009, stdout: '', stderr: '' }, pwsh: { exitCode: 0, stdout: 'PowerShell 5.1.19041', stderr: '' } } })
  await E.hook('session.start')(E.$, startEv, nextWith(SENT)); await tick()
  eq('S13 session.start: exit 9009 is missing and pwsh 5.1 is old; the note names both, not node',
    [E.calls.append.length, E.calls.append[0].message.content[0].text.includes('`python` is not on PATH'), E.calls.append[0].message.content[0].text.includes('`pwsh` 5.1 is older than the 7.0'),
     E.calls.append[0].message.content[0].text.includes('`node`')], [1, true, true, false])
}

// S14: every probe unknown (a non-ENOENT rejection) stays silent
{
  const E = fakeEngine({ by: { node: new Error('timed out'), pwsh: new Error('timed out'), python: new Error('spawn EPERM') } })
  const r = await E.hook('session.start')(E.$, startEv, nextWith(SENT)); await tick()
  const nx = nextWith(NEXT_BAND)
  eq('S14 session.start: all unknown -> no append, no invalidate, no band; next is returned',
    [r === SENT, E.calls.append.length, E.calls.invalidate.length, (await E.hook('ui.render')(E.$, bandEv(), nx)) === NEXT_BAND], [true, 0, 0, true])
  const F = fakeEngine({ noProcess: true })
  const r2 = await F.hook('session.start')(F.$, startEv, nextWith(SENT)); await tick()
  eq('S15 session.start: a surface without $.process is unknown, never speaks, never throws',
    [r2 === SENT, F.calls.append.length, F.calls.invalidate.length], [true, 0, 0])
  const G = fakeEngine({ by: { node: new Error('timed out') } })
  await G.hook('session.start')(G.$, startEv, nextWith(SENT)); await tick()
  eq('S16 session.start: one unknown tool beside two ok ones is silent', [G.calls.append.length, G.calls.invalidate.length], [0, 0])
  const H = fakeEngine({ by: { node: new Error('timed out'), python: enoent('python') } })
  await H.hook('session.start')(H.$, startEv, nextWith(SENT)); await tick()
  eq('S17 session.start: unknown beside a miss speaks only for the miss',
    [H.calls.append.length, H.calls.append[0].message.content[0].text.includes('`python`'), H.calls.append[0].message.content[0].text.includes('`node`')], [1, true, false])
}

// S18: an append that rejects is swallowed; the band still shows
{
  const E = fakeEngine({ by: { node: enoent('node') }, appendImpl: async () => { throw new Error('append refused') } })
  const before = unhandled
  const r = await E.hook('session.start')(E.$, startEv, nextWith(SENT)); await tick(40)
  const band = await E.hook('ui.render')(E.$, bandEv(), nextWith(NEXT_BAND))
  eq('S18 session.start: a rejecting session.append is swallowed (no unhandled rejection), the result returned, the band still shows',
    [r === SENT, unhandled - before, E.calls.append.length, band && band.type, band && bandText(band).includes('node')], [true, 0, 1, 'Box', true])
  const F = fakeEngine({ by: { node: enoent('node') }, invalidateImpl: () => { throw new Error('invalidate refused') } })
  const before2 = unhandled
  const r2 = await F.hook('session.start')(F.$, startEv, nextWith(SENT)); await tick(40)
  eq('S19 session.start: a throwing ui.invalidate is swallowed, the band is still set, and the note is still appended (once, equal to noteText)',
    [r2 === SENT, unhandled - before2, (await F.hook('ui.render')(F.$, bandEv(), nextWith(NEXT_BAND))).type, F.calls.invalidate.length, F.calls.append.length, F.calls.append[0]?.message.content[0].text === M.noteText(M.needsOf([{ state: 'missing' }]))],
    [true, 0, 'Box', 1, 1, true])
  const G = fakeEngine({ by: { node: enoent('node') } })
  const rej = async () => { throw new Error('next failed') }
  let thrown = null
  try { await G.hook('session.start')(G.$, startEv, rej) } catch (e) { thrown = e.message }
  eq('S20 session.start: a rejection of next(e) itself reaches the host (the module never swallows the host\'s own result)', [thrown, G.calls.run.length], ['next failed', 0])
}

// K: the probes run on a $.clock.after timer (ADR 0164)
{
  const E = fakeEngine({ by: { node: enoent('node') }, clock: 'manual' })
  const r = await E.hook('session.start')(E.$, startEv, nextWith(SENT)); await tick()
  eq('K1 session.start: one $.clock.after with delay 0; no probe runs before the timer fires',
    [r === SENT, E.calls.after, E.timers.length, E.calls.run.length, E.calls.append.length], [true, [0], 1, 0, 0])
  await E.timers[0](); await tick()
  eq('K2 session.start: the timer runs the three probes and appends one note',
    [E.calls.run.map(a => a[0]), E.calls.append.length], [['node', 'pwsh', 'python'], 1])
  for (const [id, clock] of [['K3', 'throws'], ['K4', 'none']]) {
    const F = fakeEngine({ by: { node: enoent('node') }, clock })
    const before = unhandled
    const r2 = await F.hook('session.start')(F.$, startEv, nextWith(SENT)); await tick()
    eq(`${id} session.start: with clock '${clock}' the probes run directly; one note, the result returned, nothing unhandled`,
      [r2 === SENT, F.calls.run.length, F.calls.append.length, unhandled - before], [true, 3, 1, 0])
  }
  const L = fakeEngine({ by: { node: enoent('node') }, clock: 'late-throw' })
  await L.hook('session.start')(L.$, startEv, nextWith(SENT)); await tick(40)
  eq('K5 session.start: a clock call that scheduled the timer and then threw still runs the probes once; one note',
    [L.calls.run.length, L.calls.append.length], [3, 1])
}

// ---------------------------------------------------------------------------------------------
// The app execution alias path (ADR 0150, fact 147): a bare alias name refused at a home-folder cwd
// ---------------------------------------------------------------------------------------------

const LA = 'C:\\Users\\u\\AppData\\Local'
const WA = n => LA + '\\Microsoft\\WindowsApps\\' + n + '.exe'
eq('A1 aliasPath: the WindowsApps alias of the name under LOCALAPPDATA; one trailing separator is dropped',
  [M.aliasPath(LA, 'pwsh'), M.aliasPath(LA + '\\', 'winget'), M.aliasPath('d:\\x', 'node')],
  [WA('pwsh'), WA('winget'), 'd:\\x\\Microsoft\\WindowsApps\\node.exe'])
eq('A2 aliasPath: no drive-rooted base gives null (unset, empty, relative, POSIX, UNC, a bare drive letter)',
  [undefined, null, '', 'AppData\\Local', '/home/u', '\\\\srv\\share', 'C:'].map(b => M.aliasPath(b, 'pwsh')), [null, null, null, null, null, null, null])
{
  const E = fakeEngine({ localAppData: LA, by: { pwsh: enoent('pwsh'), [WA('pwsh')]: { exitCode: 0, stdout: 'PowerShell 7.6.7\r\n', stderr: '' } } })
  await E.hook('session.start')(E.$, startEv, nextWith(SENT)); await tick()
  eq('A3 session.start: a refused bare pwsh that answers by its alias path is ok -> no note, no band; the alias run is the one extra probe',
    [E.calls.append.length, E.calls.invalidate.length, E.calls.run], [0, 0, [['node', '--version'], ['pwsh', '--version'], ['python', '--version'], [WA('pwsh'), '--version']]])
}
{
  const E = fakeEngine({ localAppData: LA, by: { pwsh: enoent('pwsh'), [WA('pwsh')]: enoent(WA('pwsh')) } })
  await E.hook('session.start')(E.$, startEv, nextWith(SENT)); await tick()
  const F = fakeEngine({ localAppData: LA, by: { pwsh: enoent('pwsh'), [WA('pwsh')]: { exitCode: 1, stdout: '', stderr: 'not recognized' } } })
  await F.hook('session.start')(F.$, startEv, nextWith(SENT)); await tick()
  eq('A4 session.start: an alias path that is refused too, or exits non-zero, leaves pwsh missing (the note names it)',
    [E.calls.append.length, E.calls.append[0]?.message.content[0].text.includes('`pwsh` is not on PATH'), F.calls.append.length, F.calls.append[0]?.message.content[0].text.includes('`pwsh` is not on PATH')], [1, true, 1, true])
}
{
  const E = fakeEngine({ localAppData: LA, by: { pwsh: enoent('pwsh'), [WA('pwsh')]: new Error('timed out') } })
  await E.hook('session.start')(E.$, startEv, nextWith(SENT)); await tick()
  const F = fakeEngine({ localAppData: LA, by: { pwsh: enoent('pwsh'), [WA('pwsh')]: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) } })
  await F.hook('session.start')(F.$, startEv, nextWith(SENT)); await tick()
  eq('A5 session.start: an alias probe that times out or rejects otherwise ("unknown") does not hide the first missing: the note names pwsh',
    [E.calls.append.length, E.calls.append[0]?.message.content[0].text.includes('`pwsh` is not on PATH'), F.calls.append.length, F.calls.append[0]?.message.content[0].text.includes('`pwsh` is not on PATH')], [1, true, 1, true])
  const G = fakeEngine({ localAppData: LA, by: { pwsh: enoent('pwsh'), [WA('pwsh')]: { exitCode: 0, stdout: 'PowerShell 6.2.7', stderr: '' } } })
  await G.hook('session.start')(G.$, startEv, nextWith(SENT)); await tick()
  eq('A5b session.start: an "old" answer by the alias path stands: the note names pwsh 6.2 as older than 7.0, not as missing',
    [G.calls.append.length, G.calls.append[0]?.message.content[0].text.includes('`pwsh` 6.2 is older than the 7.0'), G.calls.append[0]?.message.content[0].text.includes('not on PATH')], [1, true, false])
  const H = fakeEngine({ localAppData: LA, envThrowsFor: ['LOCALAPPDATA'], by: { pwsh: enoent('pwsh') } })
  const before = unhandled
  const r = await H.hook('session.start')(H.$, startEv, nextWith(SENT)); await tick()
  eq('A5c session.start: a LOCALAPPDATA read that throws after OS reads Windows gives no retry and leaves pwsh missing, with no unhandled rejection',
    [r === SENT, unhandled - before, H.calls.env.includes('LOCALAPPDATA'), H.calls.run.length, H.calls.append.length, H.calls.append[0]?.message.content[0].text.includes('`pwsh` is not on PATH')], [true, 0, true, 3, 1, true])
}
{
  const E = fakeEngine({ os: 'Linux', localAppData: LA, by: { pwsh: enoent('pwsh') } })
  await E.hook('session.start')(E.$, startEv, nextWith(SENT)); await tick()
  const F = fakeEngine({ localAppData: LA, by: { python: { exitCode: 9009, stdout: '', stderr: '' } } })
  await F.hook('session.start')(F.$, startEv, nextWith(SENT)); await tick()
  const G = fakeEngine({ localAppData: LA, by: { pwsh: new Error('timed out') } })
  await G.hook('session.start')(G.$, startEv, nextWith(SENT)); await tick()
  const H = fakeEngine({ by: { pwsh: enoent('pwsh') } })
  await H.hook('session.start')(H.$, startEv, nextWith(SENT)); await tick()
  eq('A6 session.start: no alias try off Windows, after a non-zero exit (the Store python alias), after a non-ENOENT rejection, or without LOCALAPPDATA',
    [E.calls.run.length, F.calls.run.length, G.calls.run.length, H.calls.run.length, E.calls.append.length, F.calls.append.length, H.calls.append.length], [3, 3, 3, 3, 1, 1, 1])
}

// ---------------------------------------------------------------------------------------------
// command.run: /ywr-harness:setup
// ---------------------------------------------------------------------------------------------

const runCmd = E => E.hook('command.run')(E.$, { command: 'ywr-harness:setup' }, async () => { throw new Error('next must not be called') })
const spawned = E => E.calls.spawn.map(a => a && a.argv)
const noSpawn = () => { throw new Error('spawn must not be called') }

// (a) all ok
{
  const E = fakeEngine({ spawnImpl: noSpawn })
  const r = await runCmd(E)
  eq('C1 setup: all three ok -> names the three installed tools in TOOLS order, no unknown line, no spawn, one ASCII English context row naming them',
    [r.text.startsWith('node · pwsh · python '), r.text.includes('--version'), spawned(E), Array.isArray(r.context) && r.context.length === 1 && ASCII.test(r.context[0]),
     r.context[0], E.calls.status],
    [true, false, [], true, 'ywr-harness setup found node, pwsh, python on PATH; it installed nothing.', []])
}
// (b) not Windows
{
  const E = fakeEngine({ os: 'Linux', by: { node: enoent('node') }, spawnImpl: noSpawn })
  const r = await runCmd(E)
  const need = M.needsOf([{ state: 'missing' }])
  eq('C2 setup: not Windows, node missing -> manualText(needs,false), no spawn, no winget probe',
    [r.text.includes(M.manualText(need, false)), spawned(E), E.calls.run.some(a => a[0] === 'winget'), r.text.includes('winget install'), E.calls.status],
    [true, [], false, false, []])
  eq('C3 setup: not Windows -> a one-element English context naming node and installing nothing',
    [Array.isArray(r.context) && r.context.length, ASCII.test(r.context[0]), r.context[0].includes('node'), r.context[0].includes('installed nothing')], [1, true, true, true])
  const F = fakeEngine({ envThrows: true, by: { node: enoent('node') }, spawnImpl: noSpawn })
  const r2 = await runCmd(F)
  eq('C4 setup: an env.get that throws reads as not Windows (manual commands, no spawn)', [r2.text.includes(M.manualText(need, false)), spawned(F)], [true, []])
  const G = fakeEngine({ os: null, by: { node: enoent('node') }, spawnImpl: noSpawn })
  eq('C5 setup: OS unset is not Windows', [(await runCmd(G)).text.includes(M.manualText(need, false)), spawned(G)], [true, []])
  const need3 = M.needsOf([{ state: 'old', version: '1.0' }, { state: 'missing' }, { state: 'old', version: '3.8' }])
  const H = fakeEngine({ os: 'Darwin', by: { node: { exitCode: 0, stdout: 'v0.1.0', stderr: '' }, pwsh: enoent('pwsh'), python: { exitCode: 0, stdout: 'Python 3.8.1', stderr: '' } }, spawnImpl: noSpawn })
  const r3 = await runCmd(H)
  eq('C6 setup: not Windows lists the manual line of each missing / old tool only (pwsh and python, not node)',
    [r3.text.includes('- pwsh: ' + T.pwsh.other), r3.text.includes('- python: ' + T.python.other), r3.text.includes('- node:')], [true, true, false])
}
// (c) Windows, no winget
{
  const E = fakeEngine({ by: { node: enoent('node'), winget: enoent('winget') }, spawnImpl: noSpawn })
  const r = await runCmd(E)
  eq('C7 setup: Windows without winget -> App Installer text with the winget id, no spawn, no status',
    [r.text.includes('App Installer'), r.text.includes('- node: OpenJS.NodeJS.LTS'), spawned(E), E.calls.status, E.calls.run.some(a => a[0] === 'winget' && a[1] === '--version')], [true, true, [], [], true])
  eq('C8 setup: no winget -> a one-element English context saying nothing was installed', [r.context.length, ASCII.test(r.context[0]), r.context[0].includes('installed nothing')], [1, true, true])
  const F = fakeEngine({ by: { node: enoent('node'), winget: { exitCode: 1, stdout: '', stderr: '' } }, spawnImpl: noSpawn })
  eq('C9 setup: a winget that exits non-zero is no winget either', [(await runCmd(F)).text.includes('App Installer'), spawned(F)], [true, []])
  const G = fakeEngine({ by: { node: enoent('node'), winget: new Error('timed out') }, spawnImpl: noSpawn })
  eq('C10 setup: a winget probe that times out installs nothing', [(await runCmd(G)).text.includes('App Installer'), spawned(G)], [true, []])
}
// (d) Windows + winget, node and python missing: two installs in TOOLS order, streamed
const child = (pieces, code, { throwFirst = false } = {}) => (arg, done) => {
  const g = (async function* () {
    try {
      if (throwFirst) throw new Error('spawn boom')
      for (const p of pieces) { await tick(1); yield { text: p } }
    } finally { done() }
  })()
  g.result = Promise.resolve({ code, signal: null })
  return g
}
// The alias path for winget (ADR 0150): the install runs the winget the probe reached
{
  const E = fakeEngine({ localAppData: LA, by: { node: enoent('node'), [WA('node')]: enoent(WA('node')), winget: enoent('winget'), [WA('winget')]: { exitCode: 0, stdout: 'v1.29.380\n', stderr: '' } }, spawnImpl: child(['Successfully installed'], 0) })
  const r = await runCmd(E)
  eq('A7 setup: a refused bare winget that answers by its alias path installs, and the spawn runs that path',
    [spawned(E), r.text.includes('App Installer'), r.text.split('\n')[1] === M.resultLine(T.node, 0)], [[M.wingetArgv(T.node, WA('winget'))], false, true])
  eq('A8 wingetArgv: the default is the bare winget; a given exe replaces argv[0] only',
    [M.wingetArgv(T.node)[0], M.wingetArgv(T.node, WA('winget'))[0], M.wingetArgv(T.node, WA('winget')).slice(1)], ['winget', WA('winget'), M.wingetArgv(T.node).slice(1)])
  const F = fakeEngine({ localAppData: LA, by: { node: enoent('node'), [WA('node')]: enoent(WA('node')), winget: enoent('winget'), [WA('winget')]: enoent(WA('winget')) }, spawnImpl: noSpawn })
  eq('A9 setup: a winget refused by name and by alias path is no winget (App Installer text, no spawn)', [(await runCmd(F)).text.includes('App Installer'), spawned(F)], [true, []])
  const G = fakeEngine({ localAppData: LA, by: { node: enoent('node'), [WA('node')]: enoent(WA('node')) }, spawnImpl: child([], 1603) })
  const r3 = await runCmd(G)
  eq('A10 setup: a bare winget spawns as winget; the failure line names the bare winget, never the alias path',
    [spawned(G), r3.text.split('\n')[1] === M.resultLine(T.node, 1603), r3.text.includes(WA('winget'))], [[M.wingetArgv(T.node)], true, false])
}
{
  const CR = ch(13), LF = ch(10)
  const L1 = 'Found OpenJS Node.js LTS [OpenJS.NodeJS.LTS] Version 24.14.0'
  const nodePieces = [L1 + CR + LF, CR + '|', 'Downloading  50%' + CR, 'Downloading 50%' + LF, 'Installing' + ch(7) + 'now']
  const pyPieces = ['Found Python 3.13' + LF, 'Successfully installed' + LF]
  const plan = { 'OpenJS.NodeJS.LTS': child(nodePieces, 0), 'Python.Python.3.13': child(pyPieces, 1603) }
  const E = fakeEngine({ by: { node: enoent('node'), python: { exitCode: 9009, stdout: '', stderr: '' } }, spawnImpl: (arg, done) => plan[arg.argv[3]](arg, done) })
  const r = await runCmd(E)
  eq('C11 setup: winget probed once, then two spawns in TOOLS order (node, python) with exactly wingetArgv(tool)',
    [E.calls.run.filter(a => a[0] === 'winget').length, spawned(E)], [1, [M.wingetArgv(T.node), M.wingetArgv(T.python)]])
  eq('C12 setup: the installs run one at a time', E.io.peak, 1)
  const head1 = 'node ' + K_INSTALLING + ' (1/2)' + TAIL, head2 = 'python ' + K_INSTALLING + ' (2/2)' + TAIL
  eq('C13 setup: status = head, then head + " — " + the last visible line of each piece (flattened, duplicates skipped), then cleared',
    E.calls.status,
    [head1, head1 + ' — ' + L1, head1 + ' — Downloading 50%', head1 + ' — Installing now',
     head2, head2 + ' — Found Python 3.13', head2 + ' — Successfully installed', undefined])
  eq('C14 setup: the status line never shows the same text twice in a row', E.calls.status.every((s, i) => i === 0 || s !== E.calls.status[i - 1]), true)
  const shownTexts = E.calls.status.filter(s => s !== undefined)
  eq('C14b setup: every status text set during an install (all but the final clear) contains ESC_WARN, and the head carries it right after the counter',
    [shownTexts.length, shownTexts.every(s => typeof s === 'string' && s.includes(M.ESC_WARN)), shownTexts.every(s => s.includes(K_ESC)), E.calls.status.at(-1), head1.endsWith(' (1/2) · ' + M.ESC_WARN)],
    [7, true, true, undefined, true])
  eq('C14c setup: ESC_WARN is Korean, names Esc, is one line with no control char or backtick, and the module value equals the independent copy',
    [HANGUL.test(M.ESC_WARN), M.ESC_WARN.includes('Esc'), M.flatten(M.ESC_WARN) === M.ESC_WARN, M.ESC_WARN === K_ESC], [true, true, true, true])
  const lines = r.text.split('\n')
  eq('C15 setup: the text lists resultLine for node (exit 0) and python (exit 1603), then the restart sentence',
    [lines.length, lines.slice(1, 3), (lines[3] ?? '').includes('Claude Code')], [4, [M.resultLine(T.node, 0), M.resultLine(T.python, 1603)], true])
  eq('C16 setup: context is a one-element array, one ASCII English sentence naming both tools, joining resultNote for each and ending on the old-PATH fact',
    [Array.isArray(r.context), r.context.length, typeof r.context[0], ASCII.test(r.context[0]), HANGUL.test(r.context[0]),
     r.context[0] === 'ywr-harness setup ran winget for node, python. Results: ' + M.resultNote(T.node, 0) + ' ' + M.resultNote(T.python, 1603) + ' The running session keeps its old PATH until Claude Code restarts.'],
    [true, 1, 'string', true, false, true])
  eq('C17 setup: no status text carries a control char, a backtick or a doubled space',
    E.calls.status.filter(s => typeof s === 'string').some(s => BAD.test(s) || /  /.test(s)), false)
}
// the up-to-date winget code, and a spawn whose result has no numeric code
{
  const E = fakeEngine({ by: { pwsh: enoent('pwsh') }, spawnImpl: (arg, done) => { const g = child(['x'], 0)(arg, done); g.result = Promise.resolve({ code: -1978335189, signal: null }); return g } })
  const r = await runCmd(E)
  eq('C18 setup: winget "no applicable upgrade" (signed -1978335189) reads as already installed, not a failure',
    [r.text.split('\n')[1] === M.resultLine(T.pwsh, 2316632107), r.text.includes('winget exit')], [true, false])
  const F = fakeEngine({ by: { pwsh: enoent('pwsh') }, spawnImpl: (arg, done) => { const g = child([], 0)(arg, done); g.result = Promise.resolve({ code: null, signal: 'SIGTERM' }); return g } })
  const r2 = await runCmd(F)
  eq('C19 setup: a signalled child (code null) is a failure line with the no-exit word', r2.text.split('\n')[1] === M.resultLine(T.pwsh, null), true)
}
// a spawn that throws on its first pull: reported as a failure, the next tool still runs, status cleared
{
  const plan = { 'OpenJS.NodeJS.LTS': child([], 0, { throwFirst: true }), 'Python.Python.3.13': child(['Found Python' + ch(10)], 0) }
  const E = fakeEngine({ by: { node: enoent('node'), python: enoent('python') }, spawnImpl: (arg, done) => plan[arg.argv[3]](arg, done) })
  const r = await runCmd(E)
  const head1 = 'node ' + K_INSTALLING + ' (1/2)' + TAIL, head2 = 'python ' + K_INSTALLING + ' (2/2)' + TAIL
  eq('C20 setup: a spawn that throws on its first pull is a failure line (no exit), the next install still runs, status ends cleared',
    [r.text.split('\n').slice(1, 3), spawned(E).length, E.calls.status], [[M.resultLine(T.node, null), M.resultLine(T.python, 0)], 2, [head1, head2, head2 + ' — Found Python', undefined]])
  const F = fakeEngine({ by: { node: enoent('node') }, spawnImpl: () => { throw new Error('spawn threw synchronously') } })
  const r2 = await runCmd(F)
  eq('C21 setup: a synchronous throw from spawn is a failure line too, and the status is cleared',
    [r2.text.split('\n')[1] === M.resultLine(T.node, null), F.calls.status.at(-1), F.calls.status.length], [true, undefined, 2])
  // a ui.status that throws on a non-clear call escapes the loop: the finally still clears the line
  const G = fakeEngine({ by: { node: enoent('node') }, spawnImpl: child(['x'], 0), statusImpl: t => { if (t !== undefined) throw new Error('status broke') } })
  let thrown = null
  try { await runCmd(G) } catch (e) { thrown = e.message }
  eq('C22 setup: when the loop is escaped by a throw, the finally still clears the status line', [thrown, G.calls.status.at(-1), G.calls.status.length], ['status broke', undefined, 2])
}
// three installs: the (i/n) counters and the order across the whole TOOLS list
{
  const E = fakeEngine({ by: { node: enoent('node'), pwsh: { exitCode: 0, stdout: 'PowerShell 6.2.7', stderr: '' }, python: { exitCode: 0, stdout: 'Python 3.8.10', stderr: '' } },
    spawnImpl: (arg, done) => child([], 0)(arg, done) })
  const r = await runCmd(E)
  eq('C23 setup: node missing, pwsh and python old -> three spawns in TOOLS order, heads 1/3 2/3 3/3',
    [spawned(E).map(a => a[3]), E.calls.status.filter(s => typeof s === 'string')],
    [['OpenJS.NodeJS.LTS', 'Microsoft.PowerShell', 'Python.Python.3.13'], ['node ' + K_INSTALLING + ' (1/3)' + TAIL, 'pwsh ' + K_INSTALLING + ' (2/3)' + TAIL, 'python ' + K_INSTALLING + ' (3/3)' + TAIL]])
  eq('C24 setup: the final status call is the clear', E.calls.status.at(-1), undefined)
}
// an old tool is installed over the old one the same way as a missing one
{
  const E = fakeEngine({ by: { pwsh: { exitCode: 0, stdout: 'PowerShell 6.2.7', stderr: '' } }, spawnImpl: (arg, done) => child([], 0)(arg, done) })
  await runCmd(E)
  eq('C25 setup: a single old tool is installed with wingetArgv(tool), head (1/1) with the Esc warning', [spawned(E), E.calls.status[0]], [[M.wingetArgv(T.pwsh)], 'pwsh ' + K_INSTALLING + ' (1/1)' + TAIL])
}
// (e) every probe unknown
{
  const E = fakeEngine({ by: { node: new Error('timed out'), pwsh: new Error('timed out'), python: new Error('timed out') }, spawnImpl: noSpawn })
  const r = await runCmd(E)
  const all = M.needsOf([{ state: 'missing' }, { state: 'missing' }, { state: 'missing' }])
  eq('C26 setup: every probe unknown -> the manual winget commands for all three, no spawn, no winget probe, one English context',
    [r.text.includes(M.manualText(all, true)), spawned(E), E.calls.run.some(a => a[0] === 'winget'), r.context.length, ASCII.test(r.context[0]), r.context[0].includes('installed nothing')], [true, [], false, 1, true, true])
  const F = fakeEngine({ noProcess: true, os: 'Linux' })
  const r2 = await runCmd(F)
  eq('C27 setup: a surface without $.process prints the manual commands for the platform and does not throw', [r2.text.includes(M.manualText(all, false)), F.calls.spawn.length], [true, 0])
  eq('U6 setup: the all-unknown answer is unchanged (manual commands last, no "not verified" context line, no unknown-list line)',
    [r.text.endsWith(M.manualText(all, true)), r.context[0].includes('Not verified'), r.text.includes('--version')], [true, false, false])
}

// F1: a partial unknown is never reported as installed, never installed blind, and is listed as not verified
{
  const UNK = new Error('timed out')
  const NV = ' Not verified (probe timed out or failed): '
  const st = s => ({ state: s })
  const ut = M.unknownText([st('ok'), st('unknown'), st('ok')])
  eq('U1 unknownText: starts on a new line, names only the unknown tool with its --version command',
    [ut.startsWith('\n'), ut.includes('pwsh'), ut.includes('`pwsh --version`'), ut.includes('node'), ut.includes('python')], [true, true, true, false, false])
  const ut2 = M.unknownText([st('unknown'), st('ok'), st('unknown')])
  eq('U1b unknownText: two unknown tools are named in TOOLS order, each with its command; none unknown, missing, old, empty and sparse input give the empty string',
    [ut2.includes('node · python'), ut2.includes('`node --version`, `python --version`'), ut2.includes('pwsh'),
     M.unknownText([st('ok'), st('ok'), st('ok')]), M.unknownText([st('missing'), { state: 'old', version: '1.0' }, st('ok')]), M.unknownText([]), M.unknownText([undefined, st('unknown')]).includes('pwsh')],
    [true, true, false, '', '', '', true])
  // ok + unknown on Windows: neither "all installed" nor an install
  const E = fakeEngine({ by: { pwsh: UNK }, spawnImpl: noSpawn })
  const r = await runCmd(E)
  eq('U2 setup: node and python ok, pwsh unknown -> names only node and python as installed, lists pwsh as not verified, installs nothing',
    [r.text.startsWith('node · python '), r.text.endsWith(M.unknownText([st('ok'), st('unknown'), st('ok')])), r.text.includes('pwsh ·'), r.text.includes(K_ALL), r.text.includes('`pwsh --version`'), spawned(E)],
    [true, true, false, false, true, []])
  eq('U2b setup: the context is ASCII and says pwsh was not verified, not that it is on PATH',
    [r.context.length, ASCII.test(r.context[0]), r.context[0]], [1, true, 'ywr-harness setup found node, python on PATH; it installed nothing.' + NV + 'pwsh.'])
  const E2 = fakeEngine({ by: { pwsh: UNK, python: UNK }, spawnImpl: noSpawn })
  const r2 = await runCmd(E2)
  eq('U2c setup: two unknown tools beside one ok -> only the ok tool is named installed, both listed, nothing spawned',
    [r2.text.startsWith('node '), r2.text.includes('pwsh · python'), spawned(E2), r2.context[0]],
    [true, true, [], 'ywr-harness setup found node on PATH; it installed nothing.' + NV + 'pwsh, python.'])
  // missing + unknown on Windows: only the missing tool is installed, the unknown one is listed
  const E3 = fakeEngine({ by: { node: enoent('node'), pwsh: UNK }, spawnImpl: (arg, done) => child([], 0)(arg, done) })
  const r3 = await runCmd(E3)
  const v3 = [st('missing'), st('unknown'), st('ok')]
  eq('U3 setup: node missing, pwsh unknown, python ok on Windows -> one spawn (node only); the result text holds the node line then the unknown line; the unknown tool is never installed',
    [spawned(E3), r3.text.includes(M.resultLine(T.node, 0) + M.unknownText(v3)), r3.text.includes('`pwsh --version`'), E3.calls.status[0]],
    [[M.wingetArgv(T.node)], true, true, 'node ' + K_INSTALLING + ' (1/1)' + TAIL])
  eq('U3b setup: the install context ends with the not-verified sentence, is one ASCII row, and names only node as installed',
    [r3.context.length, ASCII.test(r3.context[0]), r3.context[0].startsWith('ywr-harness setup ran winget for node. '), r3.context[0].endsWith('until Claude Code restarts.' + NV + 'pwsh.')], [1, true, true, true])
  // missing + unknown off Windows
  const E4 = fakeEngine({ os: 'Linux', by: { node: enoent('node'), python: UNK }, spawnImpl: noSpawn })
  const r4 = await runCmd(E4)
  eq('U4 setup: not Windows, node missing, python unknown -> manual line for node only, the unknown line, a not-verified context, nothing spawned, no winget probe',
    [r4.text.includes(M.manualText(M.needsOf([st('missing')]), false)), r4.text.endsWith(M.unknownText([st('missing'), st('ok'), st('unknown')])), r4.text.includes('- python:'),
     r4.context.length, ASCII.test(r4.context[0]), r4.context[0].endsWith(NV + 'python.'), spawned(E4), E4.calls.run.some(a => a[0] === 'winget')],
    [true, true, false, 1, true, true, [], false])
  // missing + unknown on Windows without winget
  const E5 = fakeEngine({ by: { node: enoent('node'), pwsh: UNK, winget: enoent('winget') }, spawnImpl: noSpawn })
  const r5 = await runCmd(E5)
  eq('U5 setup: no winget, node missing, pwsh unknown -> the App Installer text, the unknown line, a not-verified context, nothing spawned',
    [r5.text.includes('App Installer'), r5.text.endsWith(M.unknownText(v3)), r5.context[0], spawned(E5)],
    [true, true, 'ywr-harness setup found no winget; it installed nothing.' + NV + 'pwsh.', []])
  // an OLD tool beside an unknown one: the old one installs, the unknown one is listed
  const E6 = fakeEngine({ by: { node: UNK, pwsh: { exitCode: 0, stdout: 'PowerShell 5.1.19041', stderr: '' } }, spawnImpl: (arg, done) => child([], 0)(arg, done) })
  const r6 = await runCmd(E6)
  eq('U7 setup: pwsh old, node unknown -> pwsh is installed (with the old-version line), node is listed as not verified and is not installed',
    [spawned(E6), r6.text.includes(M.resultLine(T.pwsh, 0, '5.1') + M.unknownText([st('unknown'), st('old'), st('ok')])), r6.context[0].endsWith(NV + 'node.'), ASCII.test(r6.context[0])],
    [[M.wingetArgv(T.pwsh)], true, true, true])
}

// F2: an OLD tool's result lines say the old version is first on PATH, not that the new one is missing from it
{
  const UP_U = 2316632107, UP_S = -1978335189
  const hint = s => [s.includes('PATH'), s.includes('python.exe')]
  const p0 = M.resultLine(T.pwsh, 0, '5.1'), pu = M.resultLine(T.pwsh, UP_U, '5.1'), pu2 = M.resultLine(T.pwsh, UP_S, '5.1')
  eq('O1 resultLine(old): exit 0 for an old pwsh names the old version first on PATH, differs from the no-old line, is no failure, has no python hint',
    [p0.startsWith('- pwsh: '), p0.includes('5.1'), p0.includes('winget exit'), hint(p0), p0 === M.resultLine(T.pwsh, 0), M.resultLine(T.pwsh, 0) === M.resultLine(T.pwsh, 0, null)], [true, true, false, [true, false], false, true])
  eq('O2 resultLine(old): up-to-date (unsigned and signed) names the old version too, differs from exit 0 and from the no-old line',
    [pu === pu2, pu.includes('5.1'), pu.includes('winget exit'), hint(pu), pu === p0, pu === M.resultLine(T.pwsh, UP_U)], [true, true, false, [true, false], false, false])
  const y0 = M.resultLine(T.python, 0, '3.8'), yu = M.resultLine(T.python, UP_S, '3.8')
  eq('O3 resultLine(old): an old python gets the old-version hint WITHOUT the python alias hint (on 0 and on up-to-date); a missing python still gets it',
    [y0.includes('3.8'), hint(y0), yu.includes('3.8'), hint(yu), M.resultLine(T.python, 0).includes('python.exe'), y0 === M.resultLine(T.python, 0)], [true, [true, false], true, [true, false], true, false])
  eq('O4 resultLine(old): a failure line is the same with or without the old version',
    [M.resultLine(T.python, 1603, '3.8') === M.resultLine(T.python, 1603), M.resultLine(T.node, null, '1.0') === M.resultLine(T.node, null)], [true, true])
  const nu = M.resultNote(T.pwsh, UP_U, '5.1'), nu2 = M.resultNote(T.pwsh, UP_S, '5.1'), nn = M.resultNote(T.pwsh, UP_U)
  eq('RN7 resultNote(old): up-to-date with an old version says it found 5.1 first on PATH, not that it did not find it; ASCII; unsigned = signed',
    [nu.includes('found 5.1 first on PATH'), nu.includes('did not find it on PATH'), nu === nu2, ASCII.test(nu), nu.includes('failed')], [true, false, true, true, false])
  eq('RN8 resultNote: up-to-date without an old version keeps "did not find it on PATH"; exit 0 and failures ignore the old version',
    [nn.includes('did not find it on PATH'), nn.includes('first on PATH'), M.resultNote(T.pwsh, 0, '5.1') === M.resultNote(T.pwsh, 0), M.resultNote(T.pwsh, 1603, '5.1') === M.resultNote(T.pwsh, 1603), M.resultNote(T.pwsh, null, '5.1') === M.resultNote(T.pwsh, null)],
    [true, false, true, true, true])
  // end to end: node missing (no old), pwsh old 5.1, both up-to-date
  const upChild = (arg, done) => { const g = child([], 0)(arg, done); g.result = Promise.resolve({ code: UP_S, signal: null }); return g }
  const E = fakeEngine({ by: { node: enoent('node'), pwsh: { exitCode: 0, stdout: 'PowerShell 5.1.19041', stderr: '' } }, spawnImpl: upChild })
  const r = await runCmd(E)
  const lines = r.text.split('\n')
  eq('O5 setup: a missing node and an old pwsh 5.1, both reported up-to-date -> node\'s line has no old version, pwsh\'s line names 5.1',
    [lines[1] === M.resultLine(T.node, UP_S), lines[2] === M.resultLine(T.pwsh, UP_S, '5.1'), lines[2].includes('5.1'), lines[1].includes('5.1')], [true, true, true, false])
  eq('O5b setup: the context joins resultNote(node) and resultNote(pwsh, old 5.1) and is ASCII',
    [r.context[0].includes(M.resultNote(T.node, UP_S)), r.context[0].includes(M.resultNote(T.pwsh, UP_S, '5.1')), r.context[0].includes('found 5.1 first on PATH'), ASCII.test(r.context[0])], [true, true, true, true])
  const F = fakeEngine({ by: { python: { exitCode: 0, stdout: 'Python 3.8.10', stderr: '' } }, spawnImpl: (arg, done) => child([], 0)(arg, done) })
  const r2 = await runCmd(F)
  eq('O6 setup: an old python 3.8 installed with exit 0 -> its line is resultLine(python, 0, 3.8) with no alias hint; the context uses resultNote(python, 0)',
    [r2.text.split('\n')[1] === M.resultLine(T.python, 0, '3.8'), r2.text.split('\n')[1].includes('python.exe'), r2.context[0].includes(M.resultNote(T.python, 0, '3.8')), ASCII.test(r2.context[0])], [true, false, true, true])
}

// F3: one setup at a time
{
  const K_BUSY = '이미 진행 중'   // 이미 진행 중
  let gate
  const held = new Promise(res => { gate = res })
  let first = true
  const E = fakeEngine({
    by: { node: enoent('node') },
    spawnImpl: (arg, done) => {
      if (!first) return child([], 0)(arg, done)
      first = false
      const g = (async function* () { try { await held } finally { done() } })()
      g.result = Promise.resolve({ code: 0, signal: null })
      return g
    },
  })
  const p1 = runCmd(E)
  await tick()
  const runsBefore = E.calls.run.length, statusBefore = E.calls.status.length
  const r2 = await runCmd(E)
  eq('G1 setup: a second command.run while the first runs answers "already in progress" with a one-row ASCII English context, and spawns, probes and shows nothing',
    [r2.text.includes(K_BUSY), E.calls.spawn.length, E.calls.run.length === runsBefore, E.calls.status.length === statusBefore, r2.context.length, ASCII.test(r2.context[0]), r2.context[0].includes('already running')],
    [true, 1, true, true, 1, true, true])
  gate()
  const r1 = await p1
  eq('G2 setup: the first run is unaffected by the refused second one (its node line, status cleared)',
    [r1.text.includes(K_BUSY), r1.text.split('\n')[1] === M.resultLine(T.node, 0), E.calls.status.at(-1)], [false, true, undefined])
  const r3 = await runCmd(E)
  eq('G3 setup: after the first run finished a new run works again (it spawns, it is not refused)',
    [r3.text.includes(K_BUSY), E.calls.spawn.length, r3.text.split('\n')[1] === M.resultLine(T.node, 0)], [false, 2, true])
  // the guard resets when the run throws
  let broke = false
  const F = fakeEngine({ by: { node: enoent('node') }, spawnImpl: (arg, done) => child([], 0)(arg, done), statusImpl: t => { if (t !== undefined && !broke) { broke = true; throw new Error('status broke') } } })
  let thrown = null
  try { await runCmd(F) } catch (e) { thrown = e.message }
  const r4 = await runCmd(F)
  eq('G4 setup: a run that throws still resets the guard: the next run is not refused and installs',
    [thrown, r4.text.includes(K_BUSY), F.calls.spawn.length, r4.text.split('\n')[1] === M.resultLine(T.node, 0)], ['status broke', false, 1, true])
}

// ---------------------------------------------------------------------------------------------
// the entry
// ---------------------------------------------------------------------------------------------
{
  const C = capture(ENTRY.register)
  const evs = C.hooks.map(x => x.ev).sort()
  eq('E1 mods.mjs: registers the ledger (agent.spawn, turn.step, turn.complete), the prerequisites hooks (session.start, ui.render, command.run) and the decision-prompts hooks (turn.start, tool.call, session.append, command.run), each once',
    evs, ['agent.spawn', 'command.run', 'command.run', 'session.append', 'session.start', 'tool.call', 'turn.complete', 'turn.start', 'turn.step', 'ui.render'])
  eq('E2 mods.mjs: the prerequisites hooks keep their matchers through the entry',
    [C.byEv('command.run').find(x => x.matcher && x.matcher.command === 'ywr-harness:setup')?.matcher ?? 'absent', C.byEv('ui.render')[0]?.matcher ?? 'absent', C.byEv('session.start')[0]?.matcher ?? 'absent'], [{ command: 'ywr-harness:setup' }, { component: 'AbovePrompt' }, 'absent'])
  eq('E3 mods.mjs: no prompt.compose', C.byEv('prompt.compose').length, 0)
}

// no stray rejection from any case
await tick(30)
eq('Z1 no unhandled rejection escaped any case', unhandled, 0)

flush()
'@

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("prerequisites-probe-{0}.mjs" -f [guid]::NewGuid().ToString('N'))
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

# META — the verdict plumbing is live: a FAIL verdict is refused (a suite that accepted it would pass any
# mutant), and the probe did not silently drop cases (a truncated probe would still print OK lines).
$metaRefused = -not (Assert-True 'META probe' $false 'FAIL got x want y' 6>$null)
if (-not $metaRefused) { Write-Host 'FAIL [META]: Assert-True accepted a FAIL verdict' -ForegroundColor Red; $ok = $false }
else { Write-Host 'PASS [META]: a FAIL verdict is refused' -ForegroundColor Green }
$minCases = 100
if ($lines.Count -lt $minCases) { Write-Host "FAIL [META]: the probe reported $($lines.Count) cases, fewer than $minCases" -ForegroundColor Red; $ok = $false }
else { Write-Host "PASS [META]: the probe reported $($lines.Count) cases (at least $minCases)" -ForegroundColor Green }

if (-not $ok) { Write-Host 'prerequisites selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host "prerequisites selftest: all $($lines.Count) checks passed" -ForegroundColor Green
exit 0
