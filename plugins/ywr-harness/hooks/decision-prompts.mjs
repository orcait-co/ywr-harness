// Hooks module (Claude Mods; ADR 0174, narrowed by ADR 0175) — the AUTO switch and its stage prompts.
// `mods.mjs`, the entry `hooks.json` names under `modules`, registers it beside the ledger and the
// prerequisite check.
//
// While `/ywr-harness:auto on` holds in this checkout AND `.harness.json` declares `decision_prompts`, the
// module adds the repo's own prompt to the model's input at three slice stages, and with `check: true`
// it also asks one side-check model call and adds its answer beside the prompt:
//
// - `review-start`: a main-loop Workflow call that names `ywr-harness:adversarial-review`.
// - `review-digest`: the main-loop `session.append` row of door `delivery`, origin kind
//   `task-notification`, whose text holds the digest's fixed words (`DIGEST_MARKS`, ADR 0175 Decision 2).
//   The user's own prompt can hold the same words, so the door and the origin are part of the check.
// - `ready-report`: a main-loop shell call whose last step is `harness_gates.py --tree` (`isTreeRun` of
//   `slice-status.mjs`, which stays unregistered — ADR 0140; this module imports its pure half only).
//
// `slice-close` is not a stage: its detector needs `skill.prompt`, and the built-in guard
// `cc-plugin-sec-default` skips a user-tier plugin's `skill.prompt` and `classic.*` hooks (ADR 0175).
//
// The hook runs the stage call first, then reads the switch, `.harness.json` and every declared prompt file
// once at each stage (a switch turned off takes effect at once; a changed input withholds the stage until
// the person types `on` again, ADR 0176), then awaits the side check for at most
// `CHECK_WAIT_MS` (ADR 0175 Decisions 5, 7 and 9). The side check is `$.model.complete` on the `sonnet` alias at
// effort low, NOT `$.model.fork`: a fork continued the main task, tried tools and held the stage 8–11 s,
// where the completion answered from the stage data in about 1 s (fact 178). Its prompt is `FRAME`, the
// prompt file and the stage's own data; it reads no conversation. A call or row with an `agentId` (a
// subagent) never starts a stage, and one side check runs at a time.
//
// The edit guard (ADR 0175 Decision 13) covers the main loop and every subagent. While the switch is on,
// an Edit / Write / NotebookEdit of `.harness.json` or a declared prompt file is denied. The switch file
// itself is denied to those tools on or off, so only the typed command turns the switch. Paths compare
// after `.` / `..` resolution, a relative path joined to the session's cwd. A shell write, a symbolic link,
// a hard link and, on Windows, a trailing dot or space, a `::$DATA` stream suffix, an 8.3 short name or a
// drive-relative `C:x` pass; a subagent in another worktree has its relative path joined to the SESSION's
// cwd (a wrong deny, never a wrong pass). Those limits are recorded, not closed (ADR 0175, re-review).
//
// The input baseline (ADR 0176) closes the shell-write gap of the edit guard for the stage prompts. The
// typed `/ywr-harness:auto on` records the SHA-256 of `.harness.json` and of each declared prompt file in
// this module's memory, which no shell call reaches; no file holds it. A stage hashes the texts it read and
// uses those same texts, so the check and the use see one read. A changed input, or a session where nobody
// typed the command (a new session, `--resume`, a plugin reload, a switch file a shell wrote), withholds the
// stage: no static prompt, no side check, one fixed line for the model (`withheldText`) and a toast for the
// person. `/ywr-harness:auto on` again takes a new baseline; `off` drops it.
//
// The switch state is `<git-path>/ywr-harness/auto.json` (ADR 0174 Decision 3), per worktree, never
// tracked. `/ywr-harness:auto on|off|status` is answered here by `command.run`, with no model turn
// (fact 136); the skill body runs only where the host drops the module.
//
// A checkout with the switch off pays one `git rev-parse`, started without a wait at the first main turn,
// and no file read or model call on a call that is not a stage: the stage shapes are pure checks on `e`,
// and the edit guard only compares paths while the cached state is off. The cache is refreshed at each stage and each `/ywr-harness:auto`, so a switch
// turned on from ANOTHER session reaches this session's edit guard only at its next stage.
//
// The pure half is exported so `decision-prompts.selftest.ps1` drives it under plain node with a fake
// engine; the engine imports only `register`.
import { isTreeRun } from './slice-status.mjs'

export const COMMAND = 'ywr-harness:auto'
export const STAGES = ['review-start', 'review-digest', 'ready-report']
export const REVIEW_WORKFLOW = 'ywr-harness:adversarial-review'
export const STATE_REL = 'ywr-harness/auto.json'
export const CHECK_WAIT_MS = 30000
export const CHECK_MODEL = 'sonnet'
export const CHECK_EFFORT = 'low'
export const CHECK_MAX_TOKENS = 400
export const PROMPT_MAX = 16000 // characters of one prompt file the model reads
export const DATA_MAX = 6000    // characters of stage data in the side-check prompt
export const DIGEST_MARKS = ['· multi_lens ', 'full lists follow (confirmed']
export const SHELL_TOOLS = ['Bash', 'PowerShell']
export const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']
export const FRAME =
  'You are a side check that ywr-harness runs at one stage of a coding session. You see only the ' +
  'repository prompt and the stage data below, not the conversation. Read both. Answer in plain text, ' +
  'in at most three sentences, with the one thing the main session should check or do now, judged ' +
  'from the stage data. If nothing needs saying, answer exactly NONE.'

export const INPUT_HARNESS = '.harness.json'

const cut = (s, max) => (s.length > max ? s.slice(0, max) + `\n[... cut at ${max} characters]` : s)

// A declared prompt path: repo-relative, forward slashes, a `.md` file, no `.`/`..`/empty segment, no
// drive or colon, no control character. Answers the path or null.
export function safePromptPath(p) {
  if (typeof p !== 'string' || !p.endsWith('.md') || p.length > 300) return null
  if (/[\\:\x00-\x1f\x7f]/.test(p) || p.startsWith('/')) return null
  if (p.split('/').some(s => s === '' || s === '.' || s === '..')) return null
  return p
}

// `decision_prompts` of a parsed `.harness.json`: `{ stages: { <stage>: { prompt, check } }, problems }`.
// A bad entry is dropped and named; it never turns a stage on.
export function parseDecl(raw) {
  const out = { stages: {}, problems: [] }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const d = raw.decision_prompts
  if (d === undefined || d === null) return out
  if (typeof d !== 'object' || Array.isArray(d)) {
    out.problems.push('decision_prompts: expected an object of stage entries')
    return out
  }
  for (const [name, entry] of Object.entries(d)) {
    if (!STAGES.includes(name)) {
      out.problems.push(name === 'slice-close'
        ? 'decision_prompts.slice-close: not a stage (ADR 0175: the guard skips skill.prompt) — ignored'
        : `decision_prompts.${name}: unknown stage (known: ${STAGES.join(', ')}) — ignored`)
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      out.problems.push(`decision_prompts.${name}: expected an object with prompt and check — ignored`)
      continue
    }
    const prompt = safePromptPath(entry.prompt)
    if (!prompt) {
      out.problems.push(`decision_prompts.${name}.prompt: expected a repo-relative .md path — ignored`)
      continue
    }
    if (entry.check !== undefined && typeof entry.check !== 'boolean') {
      out.problems.push(`decision_prompts.${name}.check: expected true or false — ignored`)
      continue
    }
    const extra = Object.keys(entry).filter(k => k !== 'prompt' && k !== 'check')
    if (extra.length) out.problems.push(`decision_prompts.${name}: unknown key ${extra.join(', ')} ignored (known: prompt, check)`)
    out.stages[name] = { prompt, check: entry.check === true }
  }
  return out
}

// The switch file's text → on only for a JSON object whose `on` is exactly true.
export function parseSwitch(text) {
  try {
    const v = JSON.parse(String(text ?? ''))
    return !!v && typeof v === 'object' && v.on === true
  } catch { return false }
}

export function switchText(on, at) {
  return JSON.stringify({ on, at }) + '\n'
}

// The stage a main-loop tool call starts, or null.
export function stageOfToolCall(e) {
  if (!e || e.agentId !== undefined) return null
  if (e.tool === 'Workflow' && e.name === REVIEW_WORKFLOW) return 'review-start'
  if (SHELL_TOOLS.includes(e.tool) && isTreeRun(e.command)) return 'ready-report'
  return null
}

// A row's text blocks joined (the digest row carries one text block, fact 177).
export function rowText(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  return content.map(b => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
}

export function isDigestRow(e) {
  if (!e || e.agentId !== undefined || e.door !== 'delivery') return false
  if (!e.origin || e.origin.kind !== 'task-notification') return false
  const text = rowText(e.message)
  return DIGEST_MARKS.every(m => text.includes(m))
}

// The row with `extra` after its last text block; the other blocks untouched. Null when it has none.
export function appendToRow(message, extra) {
  const content = message && Array.isArray(message.content) ? message.content : []
  let last = -1
  content.forEach((b, i) => { if (b && b.type === 'text' && typeof b.text === 'string') last = i })
  if (last < 0) return null
  return { ...message, content: content.map((b, i) => (i === last ? { ...b, text: b.text + '\n\n' + extra } : b)) }
}

// The digest line out of a notification's text: the line holding the first mark.
export function digestLine(text) {
  const line = String(text ?? '').split(/\r?\n/).find(l => l.includes(DIGEST_MARKS[0]))
  return line ? line.trim() : ''
}

// What the side check reads about the stage: the review call's arguments, the digest line, or the gate output.
export function stageData(stage, e, r) {
  let data = ''
  if (stage === 'review-start') {
    try { data = JSON.stringify(e && e.args !== undefined ? e.args : null) } catch { data = '' }
  } else if (stage === 'review-digest') data = digestLine(rowText(e && e.message))
  else if (stage === 'ready-report') data = r && typeof r.text === 'string' ? r.text : ''
  return cut(String(data ?? ''), DATA_MAX)
}

export function checkPrompt(stage, promptText, data) {
  return `${FRAME}\n\n## Stage\n${stage}\n\n## Repository prompt\n${cut(promptText, PROMPT_MAX)}\n\n` +
    `## Stage data\n${data || '(none)'}`
}

export function contextText(stage, path, promptText) {
  return `ywr-harness decision prompt for the ${stage} stage (from ${path}, declared in .harness.json):\n` +
    cut(promptText, PROMPT_MAX)
}

// The side check's answer as the model reads it; null for NONE, an empty answer, or no answer.
export function answerText(stage, r) {
  if (!r || r.isAnswered !== true || typeof r.text !== 'string') return null
  const t = r.text.trim()
  if (!t || /^none\.?$/i.test(t)) return null
  return `ywr-harness side check at the ${stage} stage (a separate model call that read the repository ` +
    `prompt and the stage data, not this conversation):\n${cut(t, DATA_MAX)}`
}

export function isAbsolute(p) {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(String(p ?? ''))
}

// A path in one comparable form: forward slashes, empty and `.` segments dropped, each `..` taking the
// segment before it, no trailing slash, lower case (a deny on a case alias errs toward denying). A relative
// path is joined to `cwd` first; without `cwd` it stays relative and matches no absolute path. A symbolic
// or hard link is not resolved.
export function canonPath(p, cwd) {
  let s = String(p ?? '').replace(/\\/g, '/')
  if (!isAbsolute(s) && cwd) s = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '') + '/' + s
  const head = (/^(?:[A-Za-z]:)?\//.exec(s) || [''])[0]
  const out = []
  for (const seg of s.slice(head.length).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return (head + out.join('/')).toLowerCase()
}

// Which of the switch's own files an edit call writes: 'state' for the switch file, 'input' for
// `.harness.json` or a declared prompt file, null for any other file or call. `cwd` resolves a relative
// target.
export function editTarget(e, st, cwd) {
  if (!e || !EDIT_TOOLS.includes(e.tool) || !st || !st.root) return null
  const target = e.file_path ?? e.notebook_path
  if (typeof target !== 'string' || !target) return null
  const t = canonPath(target, cwd)
  if (st.statePath && t === canonPath(st.statePath)) return 'state'
  const base = canonPath(st.root).replace(/\/$/, '') // a drive or filesystem root keeps its slash in canonPath
  const rels = ['.harness.json', ...Object.values((st.decl && st.decl.stages) || {}).map(s => s.prompt)]
  return rels.some(rel => t === `${base}/${canonPath(rel)}`) ? 'input' : null
}

// `changed`: the inputs that differ from the session's baseline, or null when the session has none.
// `baseLine`: the `on` reply's own baseline line, in place of the computed one.
export function statusText(st, changed = null, baseLine = null) {
  const lines = []
  if (!st.root) return '이 폴더는 git 저장소가 아니거나 git 을 찾지 못해 auto 스위치를 쓸 수 없습니다.'
  lines.push(`auto 스위치: ${st.on ? '켜짐' : '꺼짐'} (이 checkout 만, ${st.statePath})`)
  if (st.on && baseLine) lines.push(baseLine)
  else if (st.on) {
    if (!st.baseline) lines.push('이 세션의 입력 기준값: 없음. 이 세션에서 /ywr-harness:auto on 을 입력해야 stage prompt 가 들어갑니다.')
    else if (changed && changed.length) lines.push(`이 세션의 입력 기준값: 바뀜 (${changed.join(', ')}). 확인한 뒤 /ywr-harness:auto on 을 다시 입력하세요.`)
    else lines.push(`이 세션의 입력 기준값: 일치 (입력 ${Object.keys(st.baseline.hashes).length}개)`)
  }
  const names = Object.keys(st.decl.stages)
  if (names.length) {
    for (const n of names) lines.push(`- ${n}: ${st.decl.stages[n].prompt}${st.decl.stages[n].check ? ' · check' : ''}`)
  } else lines.push('.harness.json 에 decision_prompts 선언이 없어 켜져 있어도 아무 일도 하지 않습니다.')
  for (const p of st.decl.problems) lines.push(`! ${p}`)
  return lines.join('\n')
}

// The module's session state: `root` (the checkout's top folder) and `statePath` (the switch file) once
// located, the cached switch and declaration, the in-flight locate, whether a side check runs now, and the
// input baseline the typed command took (`{ hashes, stages }`, or null).
export function newState() {
  return { root: null, statePath: null, on: false, decl: { stages: {}, problems: [] }, located: null, checking: false, baseline: null }
}

export async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
}

// rel -> hash, or null for an input that could not be read.
export async function hashInputs(texts) {
  const out = {}
  for (const [rel, text] of Object.entries(texts)) out[rel] = text === null ? null : await sha256Hex(text)
  return out
}

// The inputs whose hash differs between the baseline and now, an input on one side only included; sorted.
export function changedInputs(base, now) {
  const rels = new Set([...Object.keys(base), ...Object.keys(now)])
  return [...rels].filter(rel => !(rel in base) || !(rel in now) || base[rel] !== now[rel]).sort()
}

// The fixed line the model reads at a withheld stage. `changed` null means the session has no baseline.
export function withheldText(stage, changed) {
  const why = changed === null
    ? 'nobody typed /ywr-harness:auto on in this session, so the session has no baseline of its inputs'
    : `${changed.join(', ')} changed after /ywr-harness:auto on was typed in this session`
  return `ywr-harness withheld the ${stage} decision prompt and its side check: ${why} (ADR 0176). ` +
    'Go on without it, and tell the person in your report.'
}

export function withheldToast(stage, changed) {
  return changed === null
    ? `[ywr-harness] ${stage}: 이 세션에서 /ywr-harness:auto on 을 입력하지 않아 stage prompt 를 넣지 않았습니다.`
    : `[ywr-harness] ${stage}: 입력이 바뀌어 stage prompt 를 넣지 않았습니다 (${changed.join(', ').slice(0, 160)}). 확인한 뒤 /ywr-harness:auto on 을 다시 입력하세요.`
}

async function readJson($, path) {
  try { return JSON.parse(await $.fs.read(path)) } catch { return null }
}

async function refresh($, st) {
  if (!st.root) return
  try { st.on = parseSwitch(await $.fs.read(st.statePath)) } catch { st.on = false }
  st.decl = parseDecl(await readJson($, `${st.root}/.harness.json`))
}

// `.harness.json` and each prompt file its declaration names, each read once: `{ texts: { rel: text or
// null }, decl }`.
async function readInputs($, st) {
  const read = async rel => { try { return String(await $.fs.read(`${st.root}/${rel}`)) } catch { return null } }
  const texts = { [INPUT_HARNESS]: await read(INPUT_HARNESS) }
  let raw = null
  try { raw = JSON.parse(texts[INPUT_HARNESS]) } catch { raw = null }
  const decl = parseDecl(raw)
  for (const s of Object.values(decl.stages)) if (!(s.prompt in texts)) texts[s.prompt] = await read(s.prompt)
  return { texts, decl }
}

// The typed `on` takes the baseline from one read, which is also the declaration its reply shows. The old
// baseline stays until the new one is complete, so a stage that runs meanwhile is judged against it. A failure
// throws to the caller, which drops the baseline.
async function takeBaseline($, st) {
  const { texts, decl } = await readInputs($, st)
  const hashes = await hashInputs(texts)
  st.decl = decl
  st.baseline = { hashes, stages: Object.keys(decl.stages) }
}

// `--path-format=absolute` needs git 2.31; an older git prints the git path relative to the cwd.
async function locate($, st) {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--show-toplevel', '--git-path', STATE_REL], { timeoutMs: 10000 })
    const lines = String(r.stdout ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    if (r.exitCode === 0 && lines.length === 2) {
      st.root = lines[0]
      st.statePath = isAbsolute(lines[1]) ? lines[1] : `${String(await $.session.cwd()).replace(/[\\/]+$/, '')}/${lines[1]}`
    }
  } catch { st.root = null /* no git: the module stays inert */ }
  await refresh($, st)
}

// One `git rev-parse` per session, started without a wait at the main loop's first turn (`prerequisites.mjs`
// owns this plugin's one unmatched `session.start` hook); a later hook that needs the answer awaits it.
function ensure($, st) {
  if (!st.located) st.located = locate($, st).catch(() => {})
  return st.located
}

function withhold($, stage, changed) {
  try { $.ui.toast(withheldToast(stage, changed)) } catch { /* headless */ }
  return [withheldText(stage, changed)]
}

// The stage's texts for the model: the static prompt, then the side-check answer when declared. [] when the
// switch is off, the stage is undeclared now and at the baseline, or its prompt file cannot be read. The
// withheld line alone when the session has no baseline or an input changed (ADR 0176).
async function stageTexts($, st, stage, e, r) {
  try { st.on = parseSwitch(await $.fs.read(st.statePath)) } catch { st.on = false }
  if (!st.on) return []
  const { texts: inputs, decl } = await readInputs($, st)
  st.decl = decl
  const entry = decl.stages[stage]
  if (!st.baseline) return entry ? withhold($, stage, null) : []
  const changed = changedInputs(st.baseline.hashes, await hashInputs(inputs))
  if (changed.length) return entry || st.baseline.stages.includes(stage) ? withhold($, stage, changed) : []
  if (!entry || inputs[entry.prompt] === null) return []
  const promptText = inputs[entry.prompt]
  const texts = [contextText(stage, entry.prompt, promptText)]
  if (entry.check && !st.checking) {
    st.checking = true
    try {
      // the call carries its own timeout; the race bounds a host that ignores it, and its timer is
      // aborted once the call settles, so no 30 s timer outlives the stage
      const stop = new AbortController()
      // started inside a promise, so a call that throws at once lands in the same `.catch` as a rejection
      const call = Promise.resolve().then(() => $.model.complete({
        model: CHECK_MODEL, effort: CHECK_EFFORT, maxTokens: CHECK_MAX_TOKENS, timeoutMs: CHECK_WAIT_MS,
        prompt: checkPrompt(stage, promptText, stageData(stage, e, r)),
      })).catch(() => null)
      const timeout = $.clock.sleep(CHECK_WAIT_MS, { signal: stop.signal }).then(() => null, () => null)
      let answer
      try { answer = answerText(stage, await Promise.race([call, timeout])) } finally { stop.abort() }
      if (answer) {
        texts.push(answer)
        try { $.ui.toast(`[ywr-harness] ${stage}: ${answer.split('\n').slice(1).join(' ').slice(0, 200)}`) } catch { /* headless */ }
      }
    } finally { st.checking = false }
  }
  return texts
}

export const EDIT_DENY = 'ywr-harness: the /ywr-harness:auto switch is on, so .harness.json and the declared ' +
  'decision prompt files are read-only in this checkout (ADR 0175). Ask the person; they turn the switch off to edit them.'
export const STATE_DENY = 'ywr-harness: the /ywr-harness:auto switch file changes only through the /ywr-harness:auto ' +
  'command, which the person types (ADR 0175). Do not write it.'

// The edit guard's verdict for one edit call: a deny text, or null. Any failure lets the call through.
async function guardEdit($, st, e) {
  try {
    await ensure($, st)
    if (!st.root) return null
    if (st.on) await refresh($, st)
    const target = e.file_path ?? e.notebook_path
    const cwd = typeof target === 'string' && !isAbsolute(target) ? await $.session.cwd() : undefined
    const hit = editTarget(e, st, cwd)
    if (hit === 'state') return STATE_DENY
    if (hit === 'input' && st.on) return EDIT_DENY
  } catch { /* fail open */ }
  return null
}

export function register(on) {
  const st = newState()

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) void ensure($, st)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (EDIT_TOOLS.includes(e.tool)) {
      const deny = await guardEdit($, st, e)
      if (deny) return { deny }
    }
    if (e.agentId !== undefined) return next(e)
    const stage = stageOfToolCall(e)
    if (!stage) return next(e)
    await ensure($, st)
    if (!st.root) return next(e)
    const r = await next(e)
    if (!r || r.deny !== undefined) return r
    // the tool has run: a failure past this point keeps its result and adds nothing
    let texts = []
    try { texts = await stageTexts($, st, stage, e, r) } catch { texts = [] }
    return texts.length ? { ...r, context: [...(r.context || []), ...texts] } : r
  })

  on('session.append', { door: 'delivery' }, async ($, e, next) => {
    if (!isDigestRow(e)) return next(e)
    let message = null
    try {
      await ensure($, st)
      const texts = st.root ? await stageTexts($, st, 'review-digest', e, null) : []
      if (texts.length) message = appendToRow(e.message, texts.join('\n\n'))
    } catch { message = null /* the row goes on as it came */ }
    return next(message ? { ...e, message } : e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    await ensure($, st)
    // a typed command retries a locate that failed (a cold git, a session that started outside the repo)
    if (!st.root) { st.located = null; await ensure($, st) }
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (!st.root) return { text: statusText(st), context: ['ywr-harness auto: not a git checkout here; nothing changed.'] }
    if (arg === 'on' || arg === 'off') {
      try {
        await $.fs.write(st.statePath, switchText(arg === 'on', new Date().toISOString()))
      } catch (err) {
        return { text: `auto 스위치를 저장하지 못했습니다: ${String((err && err.message) || err).slice(0, 200)}`, context: ['ywr-harness auto: the switch file write failed; nothing changed.'] }
      }
      await refresh($, st)
      let baseLine = null
      if (arg === 'on') {
        const old = st.baseline
        try {
          await takeBaseline($, st)
          const moved = old ? changedInputs(old.hashes, st.baseline.hashes) : []
          baseLine = `이 세션의 입력 기준값: 기록함 (입력 ${Object.keys(st.baseline.hashes).length}개)` +
            (moved.length ? `. 이전 기준값과 달라진 입력: ${moved.join(', ')}` : '')
        } catch {
          st.baseline = null
          baseLine = '이 세션의 입력 기준값: 기록하지 못함. stage prompt 는 들어가지 않습니다. 원인을 확인한 뒤 다시 입력하세요.'
        }
      } else st.baseline = null
      return { text: statusText(st, st.baseline ? [] : null, baseLine), context: [`ywr-harness auto switch is now ${st.on ? 'ON' : 'OFF'} in this checkout (ADR 0174, ADR 0175, ADR 0176).`] }
    }
    const usage = arg && arg !== 'status'
    await refresh($, st)
    let changed = null
    if (st.baseline) {
      try { changed = changedInputs(st.baseline.hashes, await hashInputs((await readInputs($, st)).texts)) } catch { changed = null }
    }
    if (usage) return { text: '사용법: /ywr-harness:auto on | off | status\n' + statusText(st, changed), context: ['ywr-harness auto: unknown argument; nothing changed.'] }
    return { text: statusText(st, changed), context: [`ywr-harness auto switch is ${st.on ? 'ON' : 'OFF'} in this checkout.`] }
  })
}
