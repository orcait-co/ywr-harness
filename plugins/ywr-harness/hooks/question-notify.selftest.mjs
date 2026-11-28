// Self-test for question-notify.mjs (ADR 0202): the Windows toast a hook shows while the model waits for an
// AskUserQuestion answer (PreToolUse) and removes when the answer arrives (PostToolUse).
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout hooks/question-notify.selftest.mjs
//
// The payload carries `hook_event_name`, `tool_name`, `session_id`, `cwd` and `tool_input`. For AskUserQuestion,
// `tool_input.questions` is a list of {question, header, options, multiSelect}. The hook reads `header` and
// `question` of the first object entry and the count of entries. This suite builds those payloads by hand.
//
// THIS SUITE NEVER STARTS POWERSHELL TO SHOW A TOAST, because a started child would show a real toast on the
// machine that runs the suite. Two rules keep that true:
//   - The pure half (`notice`, `tagOf`, `script`, `encoded`, `powershellExe`, `optedOut`, `isMain`) is called
//     in one node process per group, with an explicit `platform` and explicit `env` objects, so every case is
//     the same on Linux CI and nothing spawns. `run` is called there with a fake `spawnFn` that records its
//     call and starts nothing, and with a SystemRoot that holds a plain file at the PowerShell path.
//   - Each end-to-end case runs the hook as a child process with a `--import` preload module. The preload
//     (a) sets `SystemRoot` in `process.env` before the hook file runs as the main module, because a node
//     process cannot start without the real SystemRoot (it aborts in its random-number init, exit 134), so the
//     child starts with the real one, and (b) replaces `child_process.spawnSync` with a stub that appends its
//     call to a log file and starts nothing (`syncBuiltinESMExports` carries the replacement to the hook's
//     named import). The root is an empty temp dir where a case wants "no powershell.exe", and a dir with a
//     plain file at the PowerShell path where a case wants the hook to reach its spawn. A case that proves a
//     silence (an opt-out, a wrong tool, bad stdin) uses the second root, so a deleted check shows as a logged
//     call: against an empty root that case would pass with the check gone. The root and the log path reach
//     the preload through variables set on the child's environment only.
// The one PowerShell child that this suite starts only parses the two child scripts (cases S1p and S2p) and
// shows nothing: `Parser.ParseInput` reads text and runs none of it. The hook's own `powershellExe()` names
// the binary, so the parse runs on the Windows PowerShell 5.1 that the hook starts (ADR 0240). On Windows a
// missing powershell.exe fails S1p and S2p with a stated reason, never passes them. On another host S1p and
// S2p skip, because the toast runs on Windows only. The text checks of S1 and S2 run on every host.
//
// Line-break and control characters are built from char codes here, never spelled in the file, because an
// escape in an editor can land as the literal character. The node program that drives the pure half is a
// temp file, not `node -e`, because argument quoting differs by version and platform.
// The case META is `QN0 META`: a Node test name starts with a case ID.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fixtureRoot, removeFixtureRoot } from '../lib/selftest-lib.mjs'
import { powershellExe } from './question-notify.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hook = path.join(here, 'question-notify.mjs')
const fx = fixtureRoot('question-notify-selftest')
let link = ''
let linkMade = false
function removeHooksLink() {
  // Never recursive: a link that is followed would delete the real hooks directory.
  if (!linkMade) return
  linkMade = false
  try { fs.unlinkSync(link) } catch { try { fs.rmdirSync(link) } catch { /* the fixture removal below reports a leftover */ } }
}
process.on('exit', () => { removeHooksLink(); removeFixtureRoot(fx) })

// One child process of node: stdin text in, stdout/stderr text and the exit code out. `env` entries are set
// on the child only (a null value removes the variable); the parent's environment is never touched.
function invokeNode(nodeArgs, stdin = '', env = {}, cwd = fx) {
  const e = { ...process.env }
  for (const [k, v] of Object.entries(env)) { if (v === null) delete e[k]; else e[k] = String(v) }
  const r = spawnSync(process.execPath, nodeArgs, {
    input: Buffer.from(stdin, 'utf8'), cwd, env: e, timeout: 20000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  const timedOut = r.error?.code === 'ETIMEDOUT'
  return { exit: timedOut ? -1 : r.status, out: r.stdout?.toString('utf8') ?? '', err: r.stderr?.toString('utf8') ?? '', timedOut }
}
const addCase = (name, fn) => test(name, () => {
  const f = fn().filter(Boolean)
  assert.deepEqual(f, [], f.join(' · '))
})
const same = (a, b) => Boolean(a && b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase())
const ch = (...c) => String.fromCharCode(...c)
const b64Utf16 = s => Buffer.from(s, 'base64').toString('utf16le')
const sortCs = a => [...a].sort()

// ---------------------------------------------------------------------------------------------------
// R1. registration. The cases below call the exported functions and run the file by hand, so none of them
//     sees whether the runtime calls the hook. A matcher of `askuserquestion` (the exact-string match
//     is case-sensitive) or a wrong event key would leave it inert with every other case green. The hook
//     needs both events: PreToolUse shows the toast and PostToolUse removes it. This pins the wiring.
//     A live `--plugin-dir` probe shows that it fires.
addCase('R1 hooks.json registers this script under PreToolUse and PostToolUse: matcher exactly AskUserQuestion, exec-form node <script>, timeout 10, async true', () => {
  const regFails = []
  try {
    const hj = JSON.parse(fs.readFileSync(path.join(here, 'hooks.json'), 'utf8'))
    const sites = []
    for (const [evName, groups] of Object.entries(hj.hooks ?? {})) {
      for (const grp of [groups].flat().filter(Boolean)) {
        for (const h of [grp.hooks].flat().filter(Boolean)) {
          const parts = [String(h.command ?? ''), ...[h.args ?? []].flat().map(String)]
          if (/question-notify/i.test(parts.join(' '))) sites.push({ ev: evName, matcher: String(grp.matcher ?? ''), h })
        }
      }
    }
    const wantArgs = ['${CLAUDE_PLUGIN_ROOT}/hooks/question-notify.mjs']
    if (sites.length !== 2) regFails.push(`want exactly 2 registrations of question-notify (PreToolUse and PostToolUse), found ${sites.length}`)
    for (const wantEvent of ['PreToolUse', 'PostToolUse']) {
      const mine = sites.filter(s => s.ev === wantEvent)
      if (mine.length !== 1) { regFails.push(`event ${wantEvent}: ${mine.length} registrations (want 1; the event key is case-sensitive)`); continue }
      const s = mine[0]
      const gotArgs = [s.h.args ?? []].flat().map(String)
      if (s.matcher !== 'AskUserQuestion') regFails.push(`${wantEvent} matcher '${s.matcher}' (want exactly 'AskUserQuestion' — the match is case-sensitive)`)
      if (String(s.h.type) !== 'command' || String(s.h.command) !== 'node') regFails.push(`${wantEvent} handler type/command '${s.h.type}'/'${s.h.command}' (want command/node)`)
      if (gotArgs.join('\0') !== wantArgs.join('\0')) regFails.push(`${wantEvent} args [${gotArgs.join(' ')}] (want exec form [${wantArgs.join(' ')}])`)
      else {
        const resolved = path.join(path.dirname(here), gotArgs.at(-1).replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//u, ''))
        if (!same(resolved, hook)) regFails.push(`${wantEvent} args resolve to '${resolved}', not this suite's script '${hook}'`)
      }
      if (String(s.h.timeout) !== '10') regFails.push(`${wantEvent} timeout '${s.h.timeout}' (want 10)`)
      // async: the hook waits for its child (CHILD_TIMEOUT_MS), so only an async registration keeps the question dialog unblocked
      if (typeof s.h.async !== 'boolean' || s.h.async !== true) regFails.push(`${wantEvent} async '${s.h.async}' (want the boolean true: the hook waits for its child)`)
    }
  } catch (e) { regFails.push(`hooks.json unreadable: ${e.message}`) }
  return regFails
})

// ---------------------------------------------------------------------------------------------------
// The pure half, one node process. Inputs are one JSON file; the output is one JSON line.
const ell = ch(0x2026)
const longA = 'a'.repeat(500)
const flat = 'a' + ch(10) + 'b' + ch(13) + 'c' + ch(0x60) + 'd' + ch(0x2028) + 'e' + ch(0x2029) + 'f' + ch(0x85) + 'g' + ch(9) + 'h' + ch(0) + 'i' + ch(0x7f) + 'j'
const flatWant = 'a b c d e f g h i j'

const newQ = (question, header = '') => {
  const q = { question, options: [{ label: 'x', description: 'y' }, { label: 'z', description: 'w' }], multiSelect: false }
  if (header) q.header = header
  return q
}
const newAsk = (questions, cwd = '/work/demo-repo', extra = {}) => {
  const p = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 'sess-1', tool_input: { questions } }
  if (cwd !== null) p.cwd = cwd
  return Object.assign(p, extra)
}
const one = newAsk([newQ('Which one?', 'Scope')])
const post = newAsk([newQ('Which one?', 'Scope')], '/work/demo-repo', { hook_event_name: 'PostToolUse', tool_response: { answers: { 'Which one?': 'x' } } })
const win = 'win32'

const cases = [
  // silent: not Windows (platform is passed, so Linux CI and Windows read the same), both events
  { id: 'linux', payload: one, platform: 'linux' },
  { id: 'darwin', payload: one, platform: 'darwin' },
  { id: 'linux-post', payload: post, platform: 'linux' },
  // silent: opt-out values, case and edge spaces ignored, both events
  { id: 'opt-0', payload: one, platform: win, env: { '@OPT': '0' } },
  { id: 'opt-false', payload: one, platform: win, env: { '@OPT': 'false' } },
  { id: 'opt-NO', payload: one, platform: win, env: { '@OPT': 'NO' } },
  { id: 'opt-off-spaces', payload: one, platform: win, env: { '@OPT': ' off ' } },
  { id: 'opt-off-post', payload: post, platform: win, env: { '@OPT': 'off' } },
  // silent: not these events / tools / shapes
  { id: 'event-other', payload: newAsk([newQ('q')], '/work/r', { hook_event_name: 'Notification' }), platform: win },
  { id: 'event-failure', payload: newAsk([newQ('q')], '/work/r', { hook_event_name: 'PostToolUseFailure' }), platform: win },
  { id: 'event-missing', payload: { tool_name: 'AskUserQuestion', tool_input: { questions: [newQ('q')] } }, platform: win },
  { id: 'tool-bash', payload: newAsk([newQ('q')], '/work/r', { tool_name: 'Bash' }), platform: win },
  { id: 'tool-bash-post', payload: newAsk([newQ('q')], '/work/r', { tool_name: 'Bash', hook_event_name: 'PostToolUse' }), platform: win },
  { id: 'tool-missing', payload: { hook_event_name: 'PreToolUse', tool_input: { questions: [newQ('q')] } }, platform: win },
  { id: 'payload-string', payload: 'AskUserQuestion', platform: win },
  { id: 'payload-number', payload: 5, platform: win },
  { id: 'payload-array', payload: [1, 2], platform: win },
  { id: 'payload-bool', payload: true, platform: win },
  { id: 'payload-null', payload: null, platform: win },
  // speaks: not opted out by these
  { id: 'opt-1', payload: one, platform: win, env: { '@OPT': '1' } },
  { id: 'opt-yes', payload: one, platform: win, env: { '@OPT': 'yes' } },
  { id: 'opt-empty', payload: one, platform: win, env: { '@OPT': '' } },
  { id: 'opt-unset', payload: one, platform: win, env: {} },
  { id: 'opt-other-var', payload: one, platform: win, env: { SOMETHING_ELSE: '0' } },
  // event names compare case-insensitively
  { id: 'event-lowercase', payload: newAsk([newQ('q')], '/work/r', { hook_event_name: 'pretooluse' }), platform: win },
  { id: 'event-lowercase-post', payload: newAsk([newQ('q')], '/work/r', { hook_event_name: 'posttooluse' }), platform: win },
  // tool names compare case-insensitively
  { id: 'tool-lowercase', payload: newAsk([newQ('q')], '/work/r', { tool_name: 'askuserquestion' }), platform: win },
  { id: 'tool-lowercase-post', payload: newAsk([newQ('q')], '/work/r', { tool_name: 'ASKUSERQUESTION', hook_event_name: 'PostToolUse' }), platform: win },
  // actions and tags
  { id: 'show-s1', payload: one, platform: win },
  { id: 'clear-s1', payload: post, platform: win },
  { id: 'show-s2', payload: newAsk([newQ('q')], '/work/r', { session_id: 'sess-2' }), platform: win },
  { id: 'clear-s2', payload: newAsk([newQ('q')], '/work/r', { session_id: 'sess-2', hook_event_name: 'PostToolUse' }), platform: win },
  { id: 'show-nosession', payload: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [newQ('q')] } }, platform: win },
  { id: 'clear-nosession', payload: { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' }, platform: win },
  { id: 'clear-bare', payload: { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: 'sess-1' }, platform: win },
  // title
  { id: 'title-basename', payload: newAsk([newQ('q')], '/work/demo-repo'), platform: win },
  { id: 'title-no-cwd', payload: newAsk([newQ('q')], null), platform: win },
  { id: 'title-empty-cwd', payload: newAsk([newQ('q')], ''), platform: win },
  { id: 'title-root-cwd', payload: newAsk([newQ('q')], '/'), platform: win },
  { id: 'title-long-cwd', payload: newAsk([newQ('q')], '/work/' + 'x'.repeat(100)), platform: win },
  { id: 'title-flat-cwd', payload: newAsk([newQ('q')], '/work/p' + ch(0x60) + 'q'), platform: win },
  // text
  { id: 'text-header', payload: one, platform: win },
  { id: 'text-no-header', payload: newAsk([newQ('Which one?')]), platform: win },
  { id: 'text-more-2', payload: newAsk([newQ('Which one?', 'Scope'), newQ('second'), newQ('third')]), platform: win },
  { id: 'text-more-1', payload: newAsk([newQ('Which one?', 'Scope'), newQ('second')]), platform: win },
  { id: 'text-empty-question', payload: newAsk([newQ('', 'Scope')]), platform: win },
  { id: 'text-empty-question-no-header', payload: newAsk([newQ('')]), platform: win },
  { id: 'text-no-questions', payload: newAsk([]), platform: win },
  { id: 'text-no-tool-input', payload: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', cwd: '/work/demo-repo' }, platform: win },
  { id: 'text-questions-not-array', payload: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: 'Which one?' } }, platform: win },
  { id: 'text-first-object', payload: newAsk([5, newQ('Q')]), platform: win },
  { id: 'text-long', payload: newAsk([newQ(longA, 'Scope')]), platform: win },
  { id: 'text-long-header', payload: newAsk([newQ('Q', 'H'.repeat(100))]), platform: win },
  { id: 'text-flat', payload: newAsk([newQ(flat)]), platform: win },
  { id: 'text-flat-header', payload: newAsk([newQ('Q', flat)]), platform: win },
]

// powershellExe fixtures. rootA holds a fake powershell.exe at the real relative location.
const psRel = path.join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const rootA = path.join(fx, 'rootA')
const rootEmpty = path.join(fx, 'root-empty')
const rootDir = path.join(fx, 'root-dir')
const rootRel = path.join(fx, 'relroot')
for (const r of [rootA, rootRel]) {
  fs.mkdirSync(path.dirname(path.join(r, psRel)), { recursive: true })
  fs.writeFileSync(path.join(r, psRel), 'x')
}
fs.mkdirSync(rootEmpty, { recursive: true })
fs.mkdirSync(path.join(rootDir, psRel), { recursive: true })   // a DIRECTORY named powershell.exe
const psCases = [
  { id: 'ps-found', env: { SystemRoot: rootA } },
  { id: 'ps-found-upper-key', env: { SYSTEMROOT: rootA } },
  { id: 'ps-found-padded', env: { SystemRoot: `  ${rootA}  ` } },
  { id: 'ps-no-file', env: { SystemRoot: rootEmpty } },
  { id: 'ps-relative', env: { SystemRoot: 'relroot' } },   // relroot/System32/... exists under the child's cwd
  { id: 'ps-missing', env: { SystemRoot: path.join(fx, 'nope') } },
  { id: 'ps-empty', env: { SystemRoot: '' } },
  { id: 'ps-unset', env: {} },
  { id: 'ps-dir-not-file', env: { SystemRoot: rootDir } },
]
const optCases = ['0', 'false', 'NO', ' off ', 'Off', 'no', '1', 'yes', '', 'maybe', '00', 'falsey', null]
const tagIn = ['', null, 'abc', 'abd', 'sess-1']

// run(): the fake spawnFn cases. baseEnv holds a SystemRoot with the plain-file powershell.exe (rootA) and two
// keys of the parent that must reach the child unchanged. The spec is keyed `@OPT` for the opt-out variable name.
const baseEnv = { SystemRoot: rootA, KEEP_ME: 'v1', Other_Key: 'v2' }
const runEnv = (extra = {}) => ({ ...baseEnv, ...extra })
const bashAsk = newAsk([newQ('q')], '/work/r', { tool_name: 'Bash' })
const bashPost = newAsk([newQ('q')], '/work/r', { tool_name: 'Bash', hook_event_name: 'PostToolUse' })
const runCases = [
  // speaks once
  { id: 'show', payload: one, platform: win, env: runEnv() },
  { id: 'clear', payload: post, platform: win, env: runEnv() },
  { id: 'show-s2', payload: newAsk([newQ('q')], '/work/r', { session_id: 'sess-2' }), platform: win, env: runEnv() },
  { id: 'show-nosession', payload: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [newQ('q')] } }, platform: win, env: runEnv() },
  { id: 'clear-nosession', payload: { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' }, platform: win, env: runEnv() },
  { id: 'show-upper-root', payload: one, platform: win, env: { SYSTEMROOT: rootA, KEEP_ME: 'v1', Other_Key: 'v2' } },
  // controls for the opt-out cases: same payload, same root, a value that is not an opt-out
  { id: 'opt-1-show', payload: one, platform: win, env: runEnv({ '@OPT': '1' }) },
  { id: 'opt-yes-post', payload: post, platform: win, env: runEnv({ '@OPT': 'yes' }) },
  { id: 'opt-empty-show', payload: one, platform: win, env: runEnv({ '@OPT': '' }) },
  // silent: opted out, with a powershell.exe present, so the opt-out check is the only reason for the silence
  { id: 'opt-0', payload: one, platform: win, env: runEnv({ '@OPT': '0' }) },
  { id: 'opt-false', payload: one, platform: win, env: runEnv({ '@OPT': 'false' }) },
  { id: 'opt-NO', payload: one, platform: win, env: runEnv({ '@OPT': 'NO' }) },
  { id: 'opt-off-spaces', payload: one, platform: win, env: runEnv({ '@OPT': ' off ' }) },
  { id: 'opt-0-post', payload: post, platform: win, env: runEnv({ '@OPT': '0' }) },
  { id: 'opt-off-spaces-post', payload: post, platform: win, env: runEnv({ '@OPT': ' off ' }) },
  // silent: another platform, tool or event, a non-object payload
  { id: 'linux', payload: one, platform: 'linux', env: runEnv() },
  { id: 'darwin-post', payload: post, platform: 'darwin', env: runEnv() },
  { id: 'tool-bash', payload: bashAsk, platform: win, env: runEnv() },
  { id: 'tool-bash-post', payload: bashPost, platform: win, env: runEnv() },
  { id: 'event-other', payload: newAsk([newQ('q')], '/work/r', { hook_event_name: 'Notification' }), platform: win, env: runEnv() },
  { id: 'event-failure', payload: newAsk([newQ('q')], '/work/r', { hook_event_name: 'PostToolUseFailure' }), platform: win, env: runEnv() },
  { id: 'event-missing', payload: { tool_name: 'AskUserQuestion', tool_input: { questions: [newQ('q')] } }, platform: win, env: runEnv() },
  { id: 'payload-string', payload: 'AskUserQuestion', platform: win, env: runEnv() },
  { id: 'payload-null', payload: null, platform: win, env: runEnv() },
  // silent: no powershell.exe where it is looked for (show and clear)
  { id: 'ps-no-file', payload: one, platform: win, env: { SystemRoot: rootEmpty, KEEP_ME: 'v1' } },
  { id: 'ps-no-file-post', payload: post, platform: win, env: { SystemRoot: rootEmpty, KEEP_ME: 'v1' } },
  { id: 'ps-dir-not-file', payload: one, platform: win, env: { SystemRoot: rootDir, KEEP_ME: 'v1' } },
  { id: 'ps-relative', payload: one, platform: win, env: { SystemRoot: 'relroot', KEEP_ME: 'v1' } },
  { id: 'ps-missing-root', payload: one, platform: win, env: { SystemRoot: path.join(fx, 'nope'), KEEP_ME: 'v1' } },
  { id: 'ps-unset', payload: one, platform: win, env: { KEEP_ME: 'v1' } },
]
// isMain(argv1, url): `url` is the module URL (import.meta.url). The links are made below, before the spec is written.
const linkType = process.platform === 'win32' ? 'Junction' : 'SymbolicLink'
let linkSkip = ''
link = path.join(fx, 'hooks-link')
try { fs.symlinkSync(here, link, process.platform === 'win32' ? 'junction' : 'dir'); linkMade = true } catch (e) {
  linkSkip = `cannot create it here (reported, not silent): ${String(e.message).split('\n')[0]}`
}
const ismCases = [
  { id: 'own', argv1: hook, urlPath: hook },
  { id: 'other-file', argv1: path.join(here, 'hook-lib.mjs'), urlPath: hook },
  { id: 'directory', argv1: here, urlPath: hook },
  { id: 'missing', argv1: path.join(fx, 'nope.mjs'), urlPath: hook },
  { id: 'missing-url', argv1: hook, urlPath: path.join(fx, 'nope.mjs') },
  { id: 'empty', argv1: '', urlPath: hook },
  { id: 'null', argv1: null, urlPath: hook },
  { id: 'default-argv', useDefault: true, urlPath: hook },
  { id: 'bad-url', argv1: hook, urlRaw: 'not a url' },
]
if (linkMade) {
  ismCases.push(
    { id: 'link', argv1: path.join(link, 'question-notify.mjs'), urlPath: hook },
    { id: 'link-url', argv1: hook, urlPath: path.join(link, 'question-notify.mjs') },
    { id: 'link-relative', argv1: 'hooks-link/question-notify.mjs', urlPath: hook },   // the driver's cwd is the fixture root
    { id: 'link-other-file', argv1: path.join(link, 'hook-lib.mjs'), urlPath: hook },
  )
}
const spec = { notices: cases, ps: psCases, opt: optCases, tags: tagIn, runs: runCases, ism: ismCases }
fs.writeFileSync(path.join(fx, 'spec.json'), JSON.stringify(spec), 'utf8')

const prog = String.raw`import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const [modPath, specPath] = process.argv.slice(2)
const m = await import(pathToFileURL(modPath).href)
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
const mkEnv = c => {
  const env = {}
  for (const [k, v] of Object.entries(c.env || {})) env[k === '@OPT' ? m.OPT_OUT : k] = v
  return env
}
const notices = spec.notices.map(c => ({ id: c.id, r: m.notice(c.payload, mkEnv(c), c.platform) }))
const runs = spec.runs.map(c => {
  const env = mkEnv(c)
  const before = JSON.stringify(Object.keys(env).sort())
  const calls = []
  const fake = (exe, args, options) => { calls.push({ exe, args, options }); return { status: 0 } }
  const r = m.run(c.payload, env, c.platform, fake)
  return {
    id: c.id, n: calls.length, r,
    same: r === null ? null : calls.length === 1 && r.exe === calls[0].exe && r.args === calls[0].args && r.options === calls[0].options,
    parentKeysKept: JSON.stringify(Object.keys(env).sort()) === before,
    parentEnv: Object.keys(env),
    childKeys: r === null ? null : Object.keys(r.options.env),   // JSON drops a key whose value is undefined, so the keys are listed here
    want: m.notice(c.payload, env, c.platform),
  }
})
const ism = spec.ism.map(c => {
  const url = c.urlRaw !== undefined ? c.urlRaw : pathToFileURL(c.urlPath).href
  return { id: c.id, r: c.useDefault ? m.isMain(undefined, url) : m.isMain(c.argv1, url) }
})
const show = m.script('show')
const clear = m.script('clear')
const out = {
  consts: { OPT_OUT: m.OPT_OUT, TITLE_VAR: m.TITLE_VAR, TEXT_VAR: m.TEXT_VAR, TAG_VAR: m.TAG_VAR, GROUP: m.GROUP, APP_ID: m.APP_ID, CHILD_TIMEOUT_MS: m.CHILD_TIMEOUT_MS, CLEAR_AGAIN_S: m.CLEAR_AGAIN_S, TITLE_MAX: m.TITLE_MAX, TEXT_MAX: m.TEXT_MAX },
  types: { run: typeof m.run, isMain: typeof m.isMain, script: typeof m.script },
  runs, ism,
  hasRemovedExports: ['HOLD_S', 'storePwsh'].filter(k => k in m),
  opt: spec.opt.map(v => m.optedOut(v)),
  notices,
  tags: spec.tags.map(v => m.tagOf(v)),
  show, clear,
  showAfter: m.script('show'),
  clearAfter: m.script('clear'),
  encodedShow: m.encoded(show),
  encodedClear: m.encoded(clear),
  encodedText: m.encoded('h' + String.fromCharCode(0xe9) + 'llo'),
  ps: spec.ps.map(c => ({ id: c.id, r: m.powershellExe(c.env) })),
}
process.stdout.write(JSON.stringify(out))
`
const progPath = path.join(fx, 'drive.mjs')
fs.writeFileSync(progPath, prog, 'utf8')

const drive = invokeNode([progPath, hook, path.join(fx, 'spec.json')])
let pure = null
try { pure = JSON.parse(drive.out) } catch { /* P0 reports it */ }
addCase('P0 the pure half loads and answers (importing the file runs no hook body)', () => [
  drive.timedOut && 'node timed out: importing the file may have run the hook body and waited on stdin',
  drive.exit !== 0 && `node exit ${drive.exit}: ${drive.err.trim()}`,
  !pure && 'stdout is not JSON',
])
// Without a driver result no case below has anything to read. Each one then fails with this reason, and P0 names the cause.
const need = () => { if (!pure) throw new Error('the pure half did not load (see P0)'); return pure }

const res = {}
for (const x of pure?.notices ?? []) res[x.id] = x.r
const assertSilent = (name, ids) => addCase(name, () => need() && ids.map(i => (i in res && res[i] === null ? '' : `${i} returned ${i in res ? 'a result' : 'nothing at all'}, want null`)))
const assertAction = (name, action, ids) => addCase(name, () => need() && ids.map(i => {
  if (res[i] == null) return `${i} returned null, want action '${action}'`
  return res[i].action !== action ? `${i} action '${res[i].action}', want '${action}'` : ''
}))
// want: id -> { field: exact value, ... }; case-sensitive. The check returns the failures, so META can read them.
const equalFailures = (resMap, want) => Object.keys(want).flatMap(i => {
  const r = resMap[i]
  if (r == null) return [`${i} returned null`]
  return Object.keys(want[i]).filter(f => r[f] !== want[i][f]).map(f => `${i} ${f}: got '${r[f]}', want '${want[i][f]}'`)
})
const assertEqual = (name, want) => addCase(name, () => need() && equalFailures(res, want))

// C1. constants: the names a member's settings and the child's script rely on, and the platform's limits
addCase('C1 constants: opt-out and handoff variable names, child timeout below the hook timeout and above the clear wait, CLEAR_AGAIN_S 3, text limits; run, isMain and script are functions; storePwsh and HOLD_S are gone', () => {
  const c = need().consts
  const f = []
  if (c.OPT_OUT !== 'YWR_HARNESS_QUESTION_NOTIFY') f.push(`OPT_OUT '${c.OPT_OUT}'`)
  if (c.TITLE_VAR !== 'YWR_HARNESS_NOTIFY_TITLE') f.push(`TITLE_VAR '${c.TITLE_VAR}'`)
  if (c.TEXT_VAR !== 'YWR_HARNESS_NOTIFY_TEXT') f.push(`TEXT_VAR '${c.TEXT_VAR}'`)
  if (c.TAG_VAR !== 'YWR_HARNESS_NOTIFY_TAG') f.push(`TAG_VAR '${c.TAG_VAR}'`)
  if (c.CHILD_TIMEOUT_MS == null || Number(c.CHILD_TIMEOUT_MS) < 1000 || Number(c.CHILD_TIMEOUT_MS) >= 10000) f.push(`CHILD_TIMEOUT_MS '${c.CHILD_TIMEOUT_MS}' (want 1000..9999 ms: under the 10 s hook timeout)`)
  if (c.CLEAR_AGAIN_S == null || Number(c.CLEAR_AGAIN_S) !== 3) f.push(`CLEAR_AGAIN_S '${c.CLEAR_AGAIN_S}' (want 3)`)
  else if (c.CHILD_TIMEOUT_MS != null && Number(c.CHILD_TIMEOUT_MS) < Number(c.CLEAR_AGAIN_S) * 1000 + 2000) f.push(`CHILD_TIMEOUT_MS ${c.CHILD_TIMEOUT_MS} leaves under 2 s beyond the ${c.CLEAR_AGAIN_S} s clear wait (the timeout would kill the second removal)`)
  for (const fn of ['run', 'isMain', 'script']) if (need().types[fn] !== 'function') f.push(`export ${fn} is '${need().types[fn]}', want function`)
  if (!c.GROUP) f.push('GROUP is empty')
  if (!c.APP_ID) f.push('APP_ID is empty')
  if (c.TITLE_MAX !== 63) f.push(`TITLE_MAX ${c.TITLE_MAX} (the title is kept at 63)`)
  if (c.TEXT_MAX !== 255) f.push(`TEXT_MAX ${c.TEXT_MAX} (the text is kept at 255)`)
  if (need().hasRemovedExports.length) f.push(`still exports: ${need().hasRemovedExports.join(', ')}`)
  return f
})

// O1. optedOut by value
const optWant = [true, true, true, true, true, true, false, false, false, false, false, false, false]
addCase('O1 optedOut: 0/false/NO/" off "/Off/no yes; 1/yes/empty/maybe/00/falsey/null no', () => optCases.flatMap((v, i) =>
  Boolean(need().opt[i]) !== optWant[i] ? [`optedOut('${v}') = ${need().opt[i]}, want ${optWant[i]}`] : []))

// N. silent, show and clear
assertSilent('N1 notice is null on platform linux and darwin, for PreToolUse and PostToolUse', ['linux', 'darwin', 'linux-post'])
assertSilent('N2 notice is null for opt-out 0, false, NO, " off ", on both events', ['opt-0', 'opt-false', 'opt-NO', 'opt-off-spaces', 'opt-off-post'])
assertSilent('N3 notice is null for another event (Notification, PostToolUseFailure), a missing event, another tool, a missing tool', ['event-other', 'event-failure', 'event-missing', 'tool-bash', 'tool-bash-post', 'tool-missing'])
assertSilent('N4 notice is null for a non-object payload: string, number, array, boolean, null', ['payload-string', 'payload-number', 'payload-array', 'payload-bool', 'payload-null'])
assertAction('N5 PreToolUse gives action show, not opted out by 1, yes, empty, unset, or another variable set to 0', 'show', ['opt-1', 'opt-yes', 'opt-empty', 'opt-unset', 'opt-other-var', 'show-s1'])
assertAction('N6 event names match case-insensitively (pretooluse shows, posttooluse clears)', 'show', ['event-lowercase'])
assertAction('N6b posttooluse clears', 'clear', ['event-lowercase-post'])
assertAction('N6c a tool name matches case-insensitively (askuserquestion shows)', 'show', ['tool-lowercase'])
assertAction('N6d a tool name matches case-insensitively (ASKUSERQUESTION clears)', 'clear', ['tool-lowercase-post'])
assertAction('N7 PostToolUse gives action clear, with or without a response or session', 'clear', ['clear-s1', 'clear-s2', 'clear-nosession', 'clear-bare'])
addCase('N8 a clear result is exactly {action, tag}: no title or text', () => {
  need()
  return ['clear-s1', 'clear-nosession'].flatMap(i => {
    const names = Object.keys(res[i] ?? {}).sort()
    return names.join(',') !== 'action,tag' ? [`${i} properties: ${names.join(',')}`] : []
  })
})

// K. tags
const expectedTag = s => 'q-' + createHash('sha256').update(s, 'utf8').digest('hex').toLowerCase().slice(0, 16)
addCase('K1 tagOf: "q" for empty or null, else "q-" + 16 lowercase hex of SHA-256 of the session id', () => {
  const t = need().tags
  const f = []
  if (t[0] !== 'q') f.push(`tagOf('') = '${t[0]}'`)
  if (t[1] !== 'q') f.push(`tagOf(null) = '${t[1]}'`)
  if (t[2] !== expectedTag('abc')) f.push(`tagOf('abc') = '${t[2]}', want ${expectedTag('abc')}`)
  if (t[4] !== expectedTag('sess-1')) f.push(`tagOf('sess-1') = '${t[4]}'`)
  if (!/^q-[0-9a-f]{16}$/.test(t[2])) f.push(`tag shape '${t[2]}'`)
  if (t[2] === t[3]) f.push(`two session ids share tag '${t[2]}'`)
  return f
})
addCase('K2 notice tags: show and clear of one session share a tag; two sessions differ; no session_id gives "q"', () => {
  need()
  const f = []
  if (res['show-s1'].tag !== res['clear-s1'].tag) f.push('show and clear of sess-1 differ')
  if (res['show-s2'].tag !== res['clear-s2'].tag) f.push('show and clear of sess-2 differ')
  if (res['show-s1'].tag === res['show-s2'].tag) f.push('sess-1 and sess-2 share a tag')
  if (res['show-s1'].tag !== pure.tags[4]) f.push('notice tag is not tagOf(session_id)')
  if (res['show-nosession'].tag !== 'q') f.push(`show without session_id: tag '${res['show-nosession'].tag}'`)
  if (res['clear-nosession'].tag !== 'q') f.push(`clear without session_id: tag '${res['clear-nosession'].tag}'`)
  return f
})

// T. title
const titleBase = 'Claude Code 질문'
assertEqual('T1 title is the fixed prefix plus the cwd basename', { 'title-basename': { title: `${titleBase} · demo-repo` } })
assertEqual('T2 no basename: no separator when cwd is missing, empty or a root', {
  'title-no-cwd': { title: titleBase }, 'title-empty-cwd': { title: titleBase }, 'title-root-cwd': { title: titleBase } })
assertEqual('T3 a 100-char basename is capped at 30 with an ellipsis, so the title stays within the limit', {
  'title-long-cwd': { title: `${titleBase} · ${'x'.repeat(29)}${ell}` } })
assertEqual('T4 a backtick in the basename flattens to a space', { 'title-flat-cwd': { title: `${titleBase} · p q` } })

// X. text
assertEqual('X1 text is "[header] question"; no brackets without a header', {
  'text-header': { text: '[Scope] Which one?' }, 'text-no-header': { text: 'Which one?' } })
assertEqual('X2 text adds (+N) for N more questions', {
  'text-more-1': { text: '[Scope] Which one? (+1)' }, 'text-more-2': { text: '[Scope] Which one? (+2)' } })
const fallback = '답을 기다립니다.'
assertEqual('X3 an empty question, no questions, no tool_input or a non-array list gives the fallback text', {
  'text-empty-question': { text: `[Scope] ${fallback}` }, 'text-empty-question-no-header': { text: fallback },
  'text-no-questions': { text: fallback }, 'text-no-tool-input': { text: fallback }, 'text-questions-not-array': { text: fallback } })
assertEqual('X4 the first object entry is read, and (+N) counts object entries only', { 'text-first-object': { text: 'Q' } })
assertEqual('X5 a 500-char question is capped at 200 (199 + an ellipsis); a 100-char header at 30', {
  'text-long': { text: `[Scope] ${'a'.repeat(199)}${ell}` }, 'text-long-header': { text: `[${'H'.repeat(29)}${ell}] Q` } })
assertEqual('X6 control chars, backtick, U+2028, U+2029, U+0085, NUL and DEL each become one space (question and header)', {
  'text-flat': { text: flatWant }, 'text-flat-header': { text: `[${flatWant}] Q` } })

// G1. every show result: title within TITLE_MAX, text within TEXT_MAX, no flattened-class char
addCase('G1 every show result: title <= TITLE_MAX, text <= TEXT_MAX, no control, line-break or backtick char', () => {
  const c = need().consts
  const f = []
  for (const x of pure.notices) {
    if (x.r == null || x.r.action !== 'show') continue
    if (x.r.title.length > c.TITLE_MAX) f.push(`${x.id} title is ${x.r.title.length} chars`)
    if (x.r.text.length > c.TEXT_MAX) f.push(`${x.id} text is ${x.r.text.length} chars`)
    for (const fld of ['title', 'text']) {
      for (let k = 0; k < x.r[fld].length; k++) {
        const n = x.r[fld].charCodeAt(k)
        if (n <= 0x1f || n === 0x7f || n === 0x85 || n === 0x2028 || n === 0x2029 || n === 0x60) { f.push(`${x.id} ${fld} carries U+${n.toString(16).toUpperCase().padStart(4, '0')}`); break }
      }
    }
  }
  return f
})

// S. the child's scripts and their encoding. The parse check is one Windows PowerShell 5.1 child, started once: it only reads text.
// 5.1 reads a script file without a BOM as the ANSI code page, so the parse script and its input stay ASCII (ADR 0240).
const WINDOWS = process.platform === 'win32'
const PARSE_SKIP = WINDOWS ? false : 'the toast runs on Windows only (ADR 0240)'
const addParseCase = (name, fn) => test(name, { skip: PARSE_SKIP }, () => {
  const f = fn().filter(Boolean)
  assert.deepEqual(f, [], f.join(' · '))
})
let parsedMemo = null
function parseErrors(texts) {
  if (parsedMemo) return parsedMemo
  const inPath = path.join(fx, 'parse-in.json')
  const outPath = path.join(fx, 'parse-out.json')
  const psPath = path.join(fx, 'parse.ps1')
  fs.writeFileSync(inPath, JSON.stringify(texts).replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')), 'utf8')
  fs.writeFileSync(psPath, [
    'param([string]$In, [string]$Out)',
    '$ErrorActionPreference = "Stop"',
    '$texts = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($In, [Text.UTF8Encoding]::new($false)))',
    '$rows = foreach ($t in $texts) {',
    '    $errs = $null',
    '    [void][Management.Automation.Language.Parser]::ParseInput([string]$t, [ref]$null, [ref]$errs)',
    '    [pscustomobject]@{ Count = @($errs | Where-Object { $_ }).Count; Messages = (@($errs | Where-Object { $_ } | ForEach-Object { $_.Message }) -join " | ") }',
    '}',
    '[IO.File]::WriteAllText($Out, (ConvertTo-Json -InputObject @($rows) -Compress), [Text.UTF8Encoding]::new($false))',
  ].join('\n'), 'utf8')
  const exe = powershellExe(process.env)
  const r = exe
    ? spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath, inPath, outPath], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
    : { error: { code: 'ENOENT' } }
  let rows = null
  try { rows = JSON.parse(fs.readFileSync(outPath, 'utf8')) } catch { /* reported below */ }
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    const why = r.error?.code === 'ENOENT' ? 'powershell.exe not found under SystemRoot' : `powershell.exe exit ${r.status}: ${String(r.stderr ?? '').trim().split('\n')[0]}`
    parsedMemo = texts.map(() => [`the PowerShell parse check could not run (${why})`])
  } else parsedMemo = rows.map(x => (x.Count ? x.Messages.split(' | ') : []))
  return parsedMemo
}
const envRefs = text => [...new Set([...text.matchAll(/\$env:[A-Za-z0-9_]+/g)].map(m => m[0]))].sort()
const count = (text, rx) => [...text.matchAll(rx)].length
addCase('S1 script(show): reads title, text and tag from $env: only; XML-escapes them; scenario reminder, system dismiss', () => {
  const c = need().consts
  const showS = String(pure.show)
  const wantShowRefs = sortCs([`$env:${c.TAG_VAR}`, `$env:${c.TEXT_VAR}`, `$env:${c.TITLE_VAR}`])
  const f = []
  if (envRefs(showS).join(',') !== wantShowRefs.join(',')) f.push(`env refs: ${envRefs(showS).join(', ')}`)
  if (!showS.includes('scenario=""reminder""')) f.push('no scenario=""reminder""')
  if (!showS.includes('activationType=""system""')) f.push('no activationType=""system""')
  if (!new RegExp(String.raw`SecurityElement\]::Escape\(\[string\]\$env:` + c.TITLE_VAR).test(showS)) f.push('title is not XML-escaped from the environment')
  if (!new RegExp(String.raw`SecurityElement\]::Escape\(\[string\]\$env:` + c.TEXT_VAR).test(showS)) f.push('text is not XML-escaped from the environment')
  if (!showS.includes(c.APP_ID)) f.push('show does not use APP_ID')
  if (!showS.includes(c.GROUP)) f.push('show does not set the GROUP')
  if (showS.includes('History.Remove')) f.push('show carries History.Remove')
  return f
})
addCase('S2 script(clear): reads the tag from $env: only, calls History.Remove with tag, group and app id; no toast XML', () => {
  const c = need().consts
  const clearS = String(pure.clear)
  const f = []
  if (envRefs(clearS).join(',') !== [`$env:${c.TAG_VAR}`].join(',')) f.push(`env refs: ${envRefs(clearS).join(', ')}`)
  if (!clearS.includes('History.Remove')) f.push('no History.Remove call')
  if (!clearS.includes(c.APP_ID)) f.push('clear does not use APP_ID')
  if (!clearS.includes(c.GROUP)) f.push('clear does not use the GROUP')
  if (/scenario|LoadXml|CreateToastNotifier/i.test(clearS)) f.push('clear carries toast-show code')
  return f
})
addParseCase('S1p script(show) parses under the Windows PowerShell that the hook starts', () => {
  need()
  return parseErrors([String(pure.show), String(pure.clear)])[0].map(e => `show script does not parse: ${e}`)
})
addParseCase('S2p script(clear) parses under the Windows PowerShell that the hook starts', () => {
  need()
  return parseErrors([String(pure.show), String(pure.clear)])[1].map(e => `clear script does not parse: ${e}`)
})
// S2b. a PostToolUse that comes before the show child has shown its toast would leave that toast: the clear child
//      removes the tag, waits CLEAR_AGAIN_S, and removes it again (and the show script waits for nothing)
addCase('S2b script(clear) removes twice with Start-Sleep -Seconds 3 between the removals (CLEAR_AGAIN_S); script(show) never sleeps', () => {
  const c = need().consts
  const showS = String(pure.show)
  const clearS = String(pure.clear)
  const rm1 = clearS.indexOf('History.Remove')
  const rm2 = rm1 >= 0 ? clearS.indexOf('History.Remove', rm1 + 1) : -1
  const slp = clearS.indexOf('Start-Sleep -Seconds 3')
  const f = []
  const nRem = count(clearS, /History\.Remove/g)
  if (nRem !== 2) f.push(`clear holds ${nRem} History.Remove (want 2)`)
  const nSlp = count(clearS, /Start-Sleep/g)
  if (nSlp !== 1) f.push(`clear holds ${nSlp} Start-Sleep (want 1)`)
  if (slp < 0) f.push('clear has no "Start-Sleep -Seconds 3"')
  else if (!(rm1 >= 0 && rm1 < slp && slp < rm2)) f.push(`order is not Remove, Sleep, Remove (remove at ${rm1}, sleep at ${slp}, remove at ${rm2})`)
  if (!new RegExp(`Start-Sleep -Seconds ${c.CLEAR_AGAIN_S}(\\r?\\n|$)`).test(clearS)) f.push('the sleep does not equal CLEAR_AGAIN_S')
  if (/Start-Sleep/i.test(showS)) f.push('show carries Start-Sleep')
  return f
})
addCase('S3 both scripts are ASCII, hold no payload text, and do not depend on a payload (two calls equal)', () => {
  const showS = String(need().show)
  const clearS = String(pure.clear)
  const f = []
  for (const [name, a, b] of [['show', showS, String(pure.showAfter)], ['clear', clearS, String(pure.clearAfter)]]) {
    if (a !== b) f.push(`script(${name}) differs between two calls`)
    if (/[^\x00-\x7f]/.test(a)) f.push(`script(${name}) carries a non-ASCII character`)
    for (const bad of ['Which one', 'Scope', 'demo-repo', 'sess-1']) if (a.includes(bad)) f.push(`script(${name}) contains fixture text '${bad}'`)
  }
  if (showS === clearS) f.push('show and clear scripts are identical')
  return f
})
addCase('S4 encoded(text) is base64 of UTF-16LE: it decodes back to script(show), script(clear) and non-ASCII text; a command line stays short', () => {
  need()
  const f = []
  if (b64Utf16(pure.encodedShow) !== String(pure.show)) f.push('decode of encoded(script(show)) differs')
  if (b64Utf16(pure.encodedClear) !== String(pure.clear)) f.push('decode of encoded(script(clear)) differs')
  const decText = b64Utf16(pure.encodedText)
  if (decText !== 'h' + ch(0xe9) + 'llo') f.push(`encoded('h?llo') decodes to '${decText}'`)
  if (String(pure.encodedShow).length > 8000) f.push(`encoded(show) is ${String(pure.encodedShow).length} chars (a command line holds 32767; keep well under)`)
  return f
})

// W. powershellExe
const pres = {}
for (const x of pure?.ps ?? []) pres[x.id] = String(x.r)
const wantPs = path.join(rootA, psRel)
addCase('W1 powershellExe: System32\\WindowsPowerShell\\v1.0\\powershell.exe under an absolute SystemRoot; SYSTEMROOT works; edge spaces trimmed', () => {
  need()
  return ['ps-found', 'ps-found-upper-key', 'ps-found-padded'].flatMap(i => (same(pres[i], wantPs) ? [] : [`${i}: '${pres[i]}' (want ${wantPs})`]))
})
addCase('W2 powershellExe is empty for a relative SystemRoot (even one holding the file), a missing root, no file, a directory named powershell.exe, empty and unset', () => {
  need()
  return ['ps-relative', 'ps-missing', 'ps-no-file', 'ps-dir-not-file', 'ps-empty', 'ps-unset'].flatMap(i => (pres[i] !== '' ? [`${i}: '${pres[i]}'`] : []))
})

// N. run(payload, env, platform, spawnFn): the wiring from the action to the one spawn call, through a FAKE spawnFn
const rr = {}
for (const x of pure?.runs ?? []) rr[x.id] = x
const wantArgsHead = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand']
function getRunFails(id, action) {
  const c = pure.consts
  const x = rr[id]
  const f = []
  if (x == null) return [`${id} missing from the driver output`]
  if (x.n !== 1) return [`${id} called the fake spawn ${x.n} times (want 1)`]
  if (x.r == null) return [`${id} returned null (want the spawn call)`]
  if (x.same !== true) f.push(`${id} returned something other than what the fake spawn received`)
  if (!x.parentKeysKept) f.push(`${id} changed the caller's env object`)
  const r = x.r
  if (!same(String(r.exe), wantPs)) f.push(`${id} exe '${r.exe}' (want ${wantPs})`)
  const a = (r.args ?? []).map(String)
  if (a.length !== 6) f.push(`${id} args count ${a.length} (want 6)`)
  else if (a.slice(0, 5).join('\0') !== wantArgsHead.join('\0')) f.push(`${id} args [${a.slice(0, 5).join(' ')}] (want [${wantArgsHead.join(' ')}])`)
  else if (b64Utf16(a[5]) !== (action === 'show' ? String(pure.show) : String(pure.clear))) f.push(`${id} -EncodedCommand decodes to something other than script('${action}')`)
  const o = r.options
  if (o.stdio !== 'ignore') f.push(`${id} stdio '${o.stdio}' (want ignore)`)
  if (typeof o.windowsHide !== 'boolean' || o.windowsHide !== true) f.push(`${id} windowsHide '${o.windowsHide}' (want true)`)
  if (Number(o.timeout) !== Number(c.CHILD_TIMEOUT_MS)) f.push(`${id} timeout '${o.timeout}' (want CHILD_TIMEOUT_MS ${c.CHILD_TIMEOUT_MS})`)
  const w = x.want
  if (w == null || w.action !== action) f.push(`${id} notice() action is not '${action}'`)
  else {
    const names = x.childKeys ?? []
    const addedWant = action === 'show' ? [c.TAG_VAR, c.TITLE_VAR, c.TEXT_VAR] : [c.TAG_VAR]
    const wantKeys = sortCs([...x.parentEnv, ...addedWant])
    if (sortCs(names).join(',') !== wantKeys.join(',')) f.push(`${id} child env keys [${sortCs(names).join(',')}] (want [${wantKeys.join(',')}])`)
    if (String(o.env[c.TAG_VAR]) !== String(w.tag)) f.push(`${id} TAG '${o.env[c.TAG_VAR]}' (want '${w.tag}')`)
    if (action === 'show') {
      if (String(o.env[c.TITLE_VAR]) !== String(w.title)) f.push(`${id} TITLE '${o.env[c.TITLE_VAR]}' (want '${w.title}')`)
      if (String(o.env[c.TEXT_VAR]) !== String(w.text)) f.push(`${id} TEXT '${o.env[c.TEXT_VAR]}' (want '${w.text}')`)
    } else if (names.includes(c.TITLE_VAR) || names.includes(c.TEXT_VAR)) f.push(`${id} (clear) carries a TITLE or TEXT key`)
    if (String(o.env.KEEP_ME) !== 'v1') f.push(`${id} parent key KEEP_ME did not reach the child ('${o.env.KEEP_ME}')`)
    if (x.parentEnv.includes('Other_Key') && String(o.env.Other_Key) !== 'v2') f.push(`${id} parent key Other_Key did not reach the child ('${o.env.Other_Key}')`)
  }
  return f
}
addCase('RN1 run(PreToolUse): the fake spawn is called once with powershell.exe under SystemRoot, [-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand <script(show)>], stdio ignore, windowsHide, CHILD_TIMEOUT_MS, and an env of the parent plus TITLE, TEXT and TAG equal to notice()', () => {
  need()
  return ['show', 'show-s2', 'show-nosession', 'show-upper-root', 'opt-1-show', 'opt-empty-show'].flatMap(i => getRunFails(i, 'show'))
})
addCase('RN2 run(PostToolUse): the fake spawn is called once with script(clear), TAG equal to notice() and no TITLE or TEXT key added; the parent keys come through', () => {
  need()
  return ['clear', 'clear-nosession', 'opt-yes-post'].flatMap(i => getRunFails(i, 'clear'))
})
addCase('RN3 run: two sessions get two tags in the child env; show and clear of one session get the same tag', () => {
  const c = need().consts
  const f = []
  if (rr.show.r.options.env[c.TAG_VAR] === rr['show-s2'].r.options.env[c.TAG_VAR]) f.push('sess-1 and sess-2 share a tag in the child env')
  if (rr.show.r.options.env[c.TAG_VAR] !== rr.clear.r.options.env[c.TAG_VAR]) f.push('show and clear of sess-1 differ in the child env')
  if (rr['show-nosession'].r.options.env[c.TAG_VAR] !== 'q') f.push('no session_id: TAG is not q')
  return f
})
const runSilent = ['opt-0', 'opt-false', 'opt-NO', 'opt-off-spaces', 'opt-0-post', 'opt-off-spaces-post', 'linux', 'darwin-post', 'tool-bash', 'tool-bash-post', 'event-other', 'event-failure', 'event-missing', 'payload-string', 'payload-null', 'ps-no-file', 'ps-no-file-post', 'ps-dir-not-file', 'ps-relative', 'ps-missing-root', 'ps-unset']
const assertRunSilent = (name, ids) => addCase(name, () => {
  need()
  return ids.flatMap(i => {
    const x = rr[i]
    if (x == null) return [`${i} missing from the driver output`]
    return [x.n !== 0 && `${i} called the fake spawn ${x.n} times (want 0)`, x.r != null && `${i} returned a spawn call, want null`]
  })
})
assertRunSilent('RN4 run: opt-out 0, false, NO, " off " on both events starts nothing although a powershell.exe is present (the controls opt-1, opt-yes, opt-empty in RN1 and RN2 start it)', ['opt-0', 'opt-false', 'opt-NO', 'opt-off-spaces', 'opt-0-post', 'opt-off-spaces-post'])
assertRunSilent('RN5 run: platform linux and darwin, another tool, another event, a missing event, a non-object payload start nothing although a powershell.exe is present', ['linux', 'darwin-post', 'tool-bash', 'tool-bash-post', 'event-other', 'event-failure', 'event-missing', 'payload-string', 'payload-null'])
assertRunSilent('RN6 run: no powershell.exe under SystemRoot (no file, a directory, a relative root, a missing root, no SystemRoot) starts nothing, for show and clear', ['ps-no-file', 'ps-no-file-post', 'ps-dir-not-file', 'ps-relative', 'ps-missing-root', 'ps-unset'])
addCase('RN7 the RN4 to RN6 case list is the whole silent list of the driver (a case added to the spec without an assertion fails here)', () => {
  need()
  const f = []
  const inSpec = pure.runs.filter(x => x.r == null).map(x => x.id).sort()
  const listed = [...runSilent].sort()
  if (inSpec.join(',') !== listed.join(',')) f.push(`silent in the driver: [${inSpec.join(',')}], asserted: [${listed.join(',')}]`)
  const speaks = pure.runs.filter(x => x.r != null).map(x => x.id).sort()
  const asserted = ['show', 'show-s2', 'show-nosession', 'show-upper-root', 'opt-1-show', 'opt-empty-show', 'clear', 'clear-nosession', 'opt-yes-post'].sort()
  if (speaks.join(',') !== asserted.join(',')) f.push(`speaking in the driver: [${speaks.join(',')}], asserted: [${asserted.join(',')}]`)
  return f
})

// I. isMain: the hook runs only when node runs this file itself, also through a directory link
const ism = {}
for (const x of pure?.ism ?? []) ism[x.id] = x.r
addCase('I1 isMain: true for the module path; false for another file, a directory, a missing path, a missing module URL, an empty or null path, the default argv (the driver script), a malformed URL', () => {
  need()
  const f = []
  if (ism.own !== true) f.push('own path: not true')
  for (const i of ['other-file', 'directory', 'missing', 'missing-url', 'empty', 'null', 'default-argv', 'bad-url']) if (ism[i] !== false) f.push(`${i}: ${ism[i]} (want false)`)
  return f
})
test(`I2 isMain through a ${linkType} to the hooks directory: true by the link path (absolute and relative) and with the link on the URL side; false for another file behind the link`,
  { skip: linkMade ? false : linkSkip }, () => {
    need()
    const f = []
    for (const i of ['link', 'link-url', 'link-relative']) if (ism[i] !== true) f.push(`${i}: ${ism[i]} (want true)`)
    if (ism['link-other-file'] !== false) f.push(`link-other-file: ${ism['link-other-file']} (want false)`)
    assert.deepEqual(f, [], f.join(' · '))
  })

// ---------------------------------------------------------------------------------------------------
// E. The hook as a child process, with the preload (see the header): SystemRoot is set to a temp dir inside every
//    child, and `spawnSync` is a stub that logs. Each case must exit 0 with EMPTY stdout and log the wanted number
//    of spawn calls. `rootEmpty` has no powershell.exe: `powershellExe` returns '' and nothing reaches the stub.
//    `rootA` holds a plain file there: the hook reaches the stub, which starts nothing.
const preload = path.join(fx, 'preload.mjs')
fs.writeFileSync(preload, String.raw`import cp from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
for (const k of ['SystemRoot', 'SYSTEMROOT']) process.env[k] = process.env.YWR_SELFTEST_ROOT
// the hook is silent off Windows, so a Linux or macOS run of these cases states the platform it tests
Object.defineProperty(process, 'platform', { value: 'win32' })
// the stub starts nothing: it appends one JSON line per call to the log and answers like a clean exit
cp.spawnSync = (exe, args, options) => {
  const log = process.env.YWR_SELFTEST_CALL_LOG
  const env = (options && options.env) || {}
  if (log) fs.appendFileSync(log, JSON.stringify({ exe, args, timeout: options && options.timeout, stdio: options && options.stdio, windowsHide: options && options.windowsHide, tag: env.YWR_HARNESS_NOTIFY_TAG }) + '\n')
  return { status: 0 }
}
syncBuiltinESMExports()
`, 'utf8')
const preloadArgs = ['--import', pathToFileURL(preload).href, hook]
const linkArgs = ['--import', pathToFileURL(preload).href, path.join(link, 'question-notify.mjs')]
const askJson = JSON.stringify(one)
const postJson = JSON.stringify(post)
const otherJson = JSON.stringify(bashAsk)
const otherPostJson = JSON.stringify(bashPost)
let callSeq = 0
// One hook child: exit 0, empty stdout, and exactly wantCalls spawn calls in the stub's log. `check` reads the calls.
function hookCase(name, stdin, root, wantCalls, { extraEnv = {}, nodeArgs = preloadArgs, check = null, skip = false } = {}) {
  test(name, { skip }, () => {
    const log = path.join(fx, `calls-${process.pid}-${++callSeq}.log`)
    const r = invokeNode(nodeArgs, stdin, { YWR_SELFTEST_ROOT: root, YWR_SELFTEST_CALL_LOG: log, ...extraEnv })
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)) : []
    const f = [
      r.timedOut && 'hook did not end within 20 s',
      r.exit !== 0 && `exit ${r.exit} (want 0 - fail-open contract): ${r.err.trim()}`,
      r.out && `stdout not empty: '${r.out.trim()}'`,
      calls.length !== wantCalls && `${calls.length} spawn calls logged (want ${wantCalls})`,
      ...(check && calls.length === wantCalls ? check(calls) : []),
    ].filter(Boolean)
    assert.deepEqual(f, [], f.join(' · '))
  })
}
const hookSilent = (name, stdin, extraEnv = {}, root = rootEmpty) => hookCase(name, stdin, root, 0, { extraEnv })
hookSilent('E1 a valid PreToolUse AskUserQuestion payload, no powershell.exe under SystemRoot: exit 0, empty stdout, nothing reaches the spawn', askJson)
hookSilent('E2 a valid PostToolUse AskUserQuestion payload, no powershell.exe under SystemRoot: exit 0, empty stdout, nothing reaches the spawn', postJson)
hookSilent('E3 a non-AskUserQuestion PreToolUse payload, no powershell.exe: exit 0, empty stdout', otherJson)
hookSilent('E3b a non-AskUserQuestion PostToolUse payload, no powershell.exe: exit 0, empty stdout', otherPostJson)
// From here the root holds a powershell.exe, so the only reason for a silence is the check under test.
hookSilent('E3c a non-AskUserQuestion payload (Pre and Post) with a powershell.exe present: exit 0, empty stdout, no spawn call', otherJson, {}, rootA)
hookSilent('E4 an opted-out PreToolUse payload with a powershell.exe present (opt-out in the child only): exit 0, empty stdout, NO spawn call', askJson, { YWR_HARNESS_QUESTION_NOTIFY: 'off' }, rootA)
hookSilent('E4b an opted-out PostToolUse payload with a powershell.exe present: exit 0, empty stdout, NO spawn call', postJson, { YWR_HARNESS_QUESTION_NOTIFY: 'NO' }, rootA)
hookSilent('E5 malformed stdin with a powershell.exe present: exit 0, empty stdout, no spawn call', 'not json at all {{{', {}, rootA)
hookSilent('E6 empty stdin with a powershell.exe present: exit 0, empty stdout, no spawn call', '', {}, rootA)
const wantTagS1 = expectedTag('sess-1')
function spawnFails(call, action) {
  const c = need().consts
  const a = (call.args ?? []).map(String)
  const f = []
  if (!same(String(call.exe), wantPs)) f.push(`exe '${call.exe}' (want ${wantPs})`)
  if (a.length !== 6 || a.slice(0, 5).join('\0') !== wantArgsHead.join('\0')) f.push(`args [${a.join(' ')}]`)
  else if (b64Utf16(a[5]) !== (action === 'show' ? String(pure.show) : String(pure.clear))) f.push(`-EncodedCommand is not script('${action}')`)
  if (Number(call.timeout) !== Number(c.CHILD_TIMEOUT_MS) || call.stdio !== 'ignore' || call.windowsHide !== true) f.push(`options: timeout ${call.timeout}, stdio ${call.stdio}, windowsHide ${call.windowsHide}`)
  if (String(call.tag) !== wantTagS1) f.push(`TAG '${call.tag}' (want ${wantTagS1})`)
  return f
}
hookCase('E8 a PreToolUse payload with a powershell.exe present: exit 0, empty stdout, ONE spawn call, with script(show) and the session tag (the hook entry: stdin, isMain, run)', askJson, rootA, 1, { check: calls => spawnFails(calls[0], 'show') })
hookCase('E8b a PostToolUse payload with a powershell.exe present: exit 0, empty stdout, ONE spawn call, with script(clear) and the session tag', postJson, rootA, 1, { check: calls => spawnFails(calls[0], 'clear') })
hookCase('E8c an opt-out value that is not one (1) with a powershell.exe present: ONE spawn call (the control for E4: the same setup speaks)', askJson, rootA, 1, { extraEnv: { YWR_HARNESS_QUESTION_NOTIFY: '1' }, check: calls => spawnFails(calls[0], 'show') })
hookCase(`E9 the hook launched through a ${linkType} to the hooks directory still runs as the main module: ONE spawn call`, askJson, rootA, 1,
  { nodeArgs: linkArgs, check: calls => spawnFails(calls[0], 'show'), skip: linkMade ? false : linkSkip })
test('E7 the child setup left this process environment alone', () => {
  const sr = process.env.SystemRoot
  const f = [
    sr && (sr.toLowerCase() === rootEmpty.toLowerCase() || sr.toLowerCase() === rootA.toLowerCase()) && 'parent SystemRoot is a temp dir of the suite',
    (process.env.YWR_SELFTEST_ROOT || process.env.YWR_SELFTEST_CALL_LOG) && 'parent carries a preload variable',
    /^(off|NO|1)$/i.test(process.env.YWR_HARNESS_QUESTION_NOTIFY ?? '') && 'parent carries an opt-out value a child received',
  ].filter(Boolean)
  assert.deepEqual(f, [], f.join(' · '))
})

// META: the comparison helper must be able to fail, so a wrong expectation is reported, not absorbed.
test('QN0 META', () => {
  const f = equalFailures({ meta: { title: 'x', text: 'y' } }, { meta: { text: 'z' } })
  assert.ok(f.length === 1 && /text: got 'y', want 'z'/.test(f[0]), `equalFailures accepted a wrong expectation: [${f.join('; ')}]`)
})
