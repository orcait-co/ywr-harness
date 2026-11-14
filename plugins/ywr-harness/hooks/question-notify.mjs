// PreToolUse and PostToolUse (matcher `AskUserQuestion`) — a Windows notification while the model waits
// for the person's answer (ywr-harness ADR 0202). The person may be in another window while a slice runs;
// the question waits in the terminal until someone sees it.
//
// PreToolUse shows a Windows toast with `scenario="reminder"` and one system dismiss button. Such a toast
// takes no focus and stays on screen until the person dismisses it; a toast without the scenario leaves
// after the system's display time, about 5 seconds (measured 2026-11-13: a tray balloon left that fast).
// PostToolUse removes the toast of the same session from the screen and from the notification list, so
// an answered question leaves nothing behind. Each session's toast carries its own tag, a hash of
// `session_id`, so one session never removes another session's toast. A question that ends without a
// PostToolUse event, such as one the person cancels, leaves its toast until the person dismisses it.
//
// The toast API is WinRT, which Windows PowerShell 5.1 reaches directly and PowerShell 7 does not, so the
// child is `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` by absolute path, never a PATH
// lookup. The toast names Windows PowerShell as its app, because it uses that app's registered id. The
// child shows or removes the toast and exits; the toast was on screen 0.64 s after the hook started.
// `hooks.json` registers both events with `async: true`, so the host does not wait for the hook: it
// writes nothing on stdout, never decides, and the question dialog is not delayed. The hook itself waits
// for the child, at most `CHILD_TIMEOUT_MS`.
//
// The question text and the tag reach the child through environment variables, never through the
// command line, so no question text is parsed as PowerShell; the child escapes them for the toast XML.
// The script itself travels as `-EncodedCommand`, which is UTF-16 and so keeps any non-ASCII text intact.
// The wait is required. libuv puts a child that is not `detached` into a job that closes with node, so a
// child the hook did not wait for died with it; a `detached` child, which has no console, never ran
// (both measured 2026-11-13). A PostToolUse that comes before the PreToolUse child shows its toast leaves
// that toast on screen until the person dismisses it, unless the toast shows within `CLEAR_AGAIN_S`
// seconds: the clear child removes the tag a second time after that wait.
//
// Silent, with no child, when any of these holds: the platform is not Windows; the payload is not a
// PreToolUse or PostToolUse payload of `AskUserQuestion`; `YWR_HARNESS_QUESTION_NOTIFY` is `0`, `false`,
// `no` or `off` (case ignored, trimmed); `powershell.exe` does not exist under `SystemRoot`; the spawn
// fails. Fail-open: nothing here can block the question (ywr-harness spec 0006 §3.1).
//
// The pure half and `run` are exported for `question-notify.selftest.ps1`. The hook runs only when node
// runs this file itself (`isMain`).
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readStdin, parseJson, isObject, psString, getProp, ieq, inline } from './hook-lib.mjs'

export const OPT_OUT = 'YWR_HARNESS_QUESTION_NOTIFY'
export const TITLE_VAR = 'YWR_HARNESS_NOTIFY_TITLE'
export const TEXT_VAR = 'YWR_HARNESS_NOTIFY_TEXT'
export const TAG_VAR = 'YWR_HARNESS_NOTIFY_TAG'
export const GROUP = 'ywr-harness'
// The registered app id of Windows PowerShell; an unregistered id shows no toast.
export const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
export const CHILD_TIMEOUT_MS = 8000
export const CLEAR_AGAIN_S = 3
export const TITLE_MAX = 63
export const TEXT_MAX = 255

export function optedOut(value) {
  return /^(0|false|no|off)$/i.test(String(value ?? '').trim())
}

// The toast tag of one session: `q-` and 16 hex characters of SHA-256 of `session_id`, or `q` without one.
export function tagOf(sessionId) {
  const s = String(sessionId ?? '')
  return s ? `q-${createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)}` : 'q'
}

// The action for one payload: `{ action: 'show', title, text, tag }` at PreToolUse, `{ action: 'clear',
// tag }` at PostToolUse, or null when the hook stays silent.
export function notice(payload, env = process.env, platform = process.platform) {
  if (platform !== 'win32' || optedOut(env[OPT_OUT]) || !isObject(payload)) return null
  if (psString(getProp(payload, 'tool_name')) !== 'AskUserQuestion') return null
  const event = psString(getProp(payload, 'hook_event_name'))
  const tag = tagOf(psString(getProp(payload, 'session_id')))
  if (ieq(event, 'PostToolUse')) return { action: 'clear', tag }
  if (!ieq(event, 'PreToolUse')) return null
  const ti = getProp(payload, 'tool_input')
  const qs = isObject(ti) && Array.isArray(getProp(ti, 'questions')) ? getProp(ti, 'questions') : []
  const objs = qs.filter(q => isObject(q))
  const first = objs[0] || {}
  const repo = inline(path.basename(psString(getProp(payload, 'cwd')) || ''), 30)
  const title = inline(`Claude Code 질문${repo ? ` · ${repo}` : ''}`, TITLE_MAX)
  const head = inline(psString(getProp(first, 'header')), 30)
  const q = inline(psString(getProp(first, 'question')), 200)
  const more = objs.length > 1 ? ` (+${objs.length - 1})` : ''
  const text = inline(`${head ? `[${head}] ` : ''}${q || '답을 기다립니다.'}${more}`, TEXT_MAX)
  return { action: 'show', title, text, tag }
}

const LOAD = [
  "$ErrorActionPreference = 'Stop'",
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
]

// The child's script for one action. It reads the title, the text and the tag from the environment only.
// The dismiss button has no content, so Windows shows its own localized label.
export function script(action) {
  if (action === 'clear') {
    // A second removal after `CLEAR_AGAIN_S` catches a show child that started first but showed late.
    const remove = `[Windows.UI.Notifications.ToastNotificationManager]::History.Remove($env:${TAG_VAR}, '${GROUP}', '${APP_ID}')`
    return [...LOAD, remove, `Start-Sleep -Seconds ${CLEAR_AGAIN_S}`, remove].join('\n')
  }
  return [...LOAD,
    '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    `$title = [Security.SecurityElement]::Escape([string]$env:${TITLE_VAR})`,
    `$text = [Security.SecurityElement]::Escape([string]$env:${TEXT_VAR})`,
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml("<toast scenario=""reminder""><visual><binding template=""ToastGeneric""><text>$title</text><text>$text</text></binding></visual><actions><action content="""" arguments=""dismiss"" activationType=""system""/></actions></toast>")',
    '$t = New-Object Windows.UI.Notifications.ToastNotification $doc',
    `$t.Tag = $env:${TAG_VAR}`,
    `$t.Group = '${GROUP}'`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($t)`,
  ].join('\n')
}

// `-EncodedCommand` takes base64 of UTF-16LE.
export function encoded(text) {
  return Buffer.from(String(text), 'utf16le').toString('base64')
}

// Windows PowerShell by absolute path under `SystemRoot`, or '' when it is not there.
export function powershellExe(env = process.env) {
  const root = String(env.SystemRoot ?? env.SYSTEMROOT ?? '').trim()
  if (!root || !path.isAbsolute(root)) return ''
  const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try { return fs.statSync(p).isFile() ? p : '' } catch { return '' }
}

// One payload end to end: the action, then one child through `spawnFn`. Returns the spawn call as
// `{ exe, args, options }`, or null when nothing starts. `spawnFn` is a parameter, so the selftest checks
// the wiring without starting PowerShell.
export function run(payload, env = process.env, platform = process.platform, spawnFn = spawnSync) {
  const n = notice(payload, env, platform)
  if (!n) return null
  const exe = powershellExe(env)
  if (!exe) return null
  const childEnv = { ...env, [TAG_VAR]: n.tag }
  if (n.action === 'show') { childEnv[TITLE_VAR] = n.title; childEnv[TEXT_VAR] = n.text }
  const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded(script(n.action))]
  const options = { stdio: 'ignore', windowsHide: true, timeout: CHILD_TIMEOUT_MS, env: childEnv }
  spawnFn(exe, args, options)
  return { exe, args, options }
}

// True when node runs this file itself. Both sides are real paths: Node resolves the main module's
// `import.meta.url` through junctions and links, and `process.argv[1]` keeps the path as launched.
export function isMain(argv1 = process.argv[1], url = import.meta.url) {
  try { return !!argv1 && fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(fileURLToPath(url)) } catch { return false }
}

if (isMain()) {
  try { run(parseJson(readStdin())) } catch { /* fail-open: a hook defect never blocks the question */ }
}
