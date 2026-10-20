// Hooks module (Claude Mods; ADR 0142) — the PREREQUISITE check and its install command. `mods.mjs`, the
// entry `hooks.json` names under `modules`, registers it beside the delegation ledger.
//
// The plugin needs three tools on PATH: `node` runs the eight settings hooks (ADR 0116), `pwsh` 7+ runs
// the skills' scripts and every selftest, `python` 3.9+ runs the gate scripts. A settings hook cannot
// report its own runtime's absence, so this check is a mod: the host runs a mod in an engine
// environment of its own, with no Node (fact 135), and `$.process.run` reaches the host's commands.
//
// What it does:
// - `session.start`: after `next(e)` resolves it starts the three `--version` probes on a
//   `$.clock.after(0, …)` timer and does not wait for them, so the probes never delay the session start
//   (ADR 0164; a host without the call runs them directly). A probe that rejects with ENOENT / "not
//   found", or a command that exits non-zero (the Windows Store `python` alias does), is MISSING; a
//   `pwsh` below 7 or a `python` below 3.9 is OLD; anything else (a timeout, a surface without
//   `$.process`) is UNKNOWN and never speaks. On Windows a not-found refusal is tried once more by the
//   app execution alias path (`aliasPath`, ADR 0150): the runner refuses a bare alias name when the cwd
//   is an ancestor of the alias folder, as the home folder is (fact 147).
// - `ui.render` on `AbovePrompt`: while a tool is missing or old, one Korean band (ADR 0045) names the
//   tools and `/ywr-harness:setup`. The engine's own `[-]` collapses it. Nothing missing: `next(e)`.
// - The model note: when the probes find a missing or old tool, `$.session.append` adds ONE English
//   meta user row, which the person does not see. It tells Claude the cause of the hook errors and
//   failing scripts it will see, the command, and to install nothing unasked. The module adds no
//   `prompt.compose` section: on 2.1.296 the engine skips that hook for a user-tier plugin (fact 136).
//   The row belongs to the conversation, so a `/clear` drops it, and a resume or a fork adds it again.
// - `command.run` on `ywr-harness:setup` (the command `skills/setup/SKILL.md` declares; a
//   `$.command.register` name carries no plugin prefix — fact 136): the member typed it, which is the
//   consent. On Windows with `winget` it probes again and runs `winget install` for each missing or old
//   tool, one at a time, each output piece's last line in the plugin status line, then reports each
//   result and asks for a restart (a running session keeps its PATH). Off Windows, or without `winget`,
//   it prints the commands and runs nothing. The hook answers the command itself, so no model turn
//   runs; on a host that drops mods the skill body runs instead.
//
// It never installs unasked, never denies, and passes every other event on unchanged. Text from a
// child's output reaches the status line only through `flatten()` (the `hook-lib.mjs` `inline()`
// class; the module cannot import hook-lib, which needs Node).
//
// The pure half (`TOOLS`, `parseVersion`, `verdictOf`, `needsOf`, `bandText`, `noteText`, `manualText`,
// `lastLine`, `flatten`, `aliasPath`, `wingetArgv`, `resultLine`, `resultNote`, `unknownText`) is exported so `prerequisites.selftest.ps1` drives it
// under plain node with a fake engine; the engine imports only `register`.

export const COMMAND = 'ywr-harness:setup'
// An interrupt aborts the command's dispatch, and an aborted dispatch kills the spawned winget (the
// `$.process.spawn` contract). Whether Esc aborts it, and what a killed winget leaves of an installer
// it started, is unmeasured (ADR 0142), so the status line says so while an install runs. The next
// session's probe shows the band again for anything left half-installed.
export const ESC_WARN = 'Esc 를 누르면 설치가 끊길 수 있습니다'
export const PROBE_TIMEOUT_MS = 15000
// winget's "no applicable upgrade" (APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE): the package is
// installed, so a probe that missed it reads a PATH older than the install.
export const WINGET_UP_TO_DATE = 0x8A15002B

export const TOOLS = [
  {
    name: 'node', argv: ['node', '--version'], min: null, winget: 'OpenJS.NodeJS.LTS',
    other: 'macOS: `brew install node` · Linux: the distribution package or nodejs.org',
    uses: 'the eight ywr-harness settings hooks (session start, config change, added directory, every Agent call, every subagent stop) report a hook error',
  },
  {
    name: 'pwsh', argv: ['pwsh', '--version'], min: [7, 0], winget: 'Microsoft.PowerShell',
    other: 'macOS: `brew install --cask powershell` · Linux: learn.microsoft.com/powershell',
    uses: 'the harness-init and report-issue skill scripts and every plugin selftest fail',
  },
  {
    name: 'python', argv: ['python', '--version'], min: [3, 9], winget: 'Python.Python.3.13',
    other: 'macOS: `brew install python` · Linux: the distribution package (the command must be `python`)',
    uses: 'the gate scripts fail (harness_gates.py in pre-commit, harness_retro.py in post-commit, verify_map.py in /ywr-harness:verify)',
  },
]

const minText = t => (t.min ? `${t.min[0]}.${t.min[1]}` : '')

// The first `major.minor` in a `--version` line: `PowerShell 7.6.6`, `v24.14.0`, `Python 3.13.13`.
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)/.exec(String(text ?? ''))
  return m ? [Number(m[1]), Number(m[2])] : null
}

const isNotFound = err => /ENOENT|not found/i.test(String((err && err.message) ?? err ?? ''))

// One probe's verdict from its outcome: `{ result }` (what `$.process.run` resolved) or `{ error }`.
export function verdictOf(tool, outcome) {
  if (!outcome || typeof outcome !== 'object') return { state: 'unknown' }
  if ('error' in outcome) return { state: isNotFound(outcome.error) ? 'missing' : 'unknown' }
  const r = outcome.result
  if (!r || typeof r.exitCode !== 'number') return { state: 'unknown' }
  if (r.exitCode !== 0) return { state: 'missing' }
  const v = parseVersion(`${r.stdout ?? ''} ${r.stderr ?? ''}`)
  const version = v ? `${v[0]}.${v[1]}` : null
  if (tool.min && v && (v[0] < tool.min[0] || (v[0] === tool.min[0] && v[1] < tool.min[1]))) return { state: 'old', version }
  return { state: 'ok', version }
}

// The tools that need an install, in TOOLS order: `[{ tool, state, version }]`.
export function needsOf(verdicts) {
  const out = []
  TOOLS.forEach((tool, i) => {
    const v = verdicts && verdicts[i]
    if (v && (v.state === 'missing' || v.state === 'old')) out.push({ tool, state: v.state, version: v.version ?? null })
  })
  return out
}

// The per-user folder of Windows app execution aliases. The Store `pwsh` and `winget` are aliases there
// (0-byte reparse points). `$.process.run` refuses a bare alias name with the not-found error when the
// session's cwd is an ancestor of that folder, the home folder included, and runs the same alias by its
// absolute path (fact 147, ADR 0150). The Desktop session that showed it ran in the home folder.
const BS = '\\'
export function aliasPath(localAppData, name) {
  const base = String(localAppData ?? '')
  if (!/^[A-Za-z]:\\/.test(base)) return null
  return base.replace(/\\+$/, '') + BS + 'Microsoft' + BS + 'WindowsApps' + BS + name + '.exe'
}

async function runVerdict($, tool, argv) {
  try { return { verdict: verdictOf(tool, { result: await $.process.run(argv, { timeoutMs: PROBE_TIMEOUT_MS }) }), refused: false } }
  catch (error) { return { verdict: verdictOf(tool, { error }), refused: true } }
}

// One probe. On Windows a not-found refusal of the bare name tries the alias path once. Only an answer
// ("ok" or "old") replaces the first "missing": an "unknown" retry (a timeout, another rejection) is no
// evidence that the alias exists, and an "unknown" never speaks, so it would hide a missing tool. The
// verdict carries `exe`, the command that answered, so the install runs `winget` the way the probe reached it.
async function probeOne($, tool, win) {
  const first = await runVerdict($, tool, tool.argv)
  if (win && first.refused && first.verdict.state === 'missing') {
    let path = null
    try { path = aliasPath(await $.env.get('LOCALAPPDATA'), tool.argv[0]) } catch { /* no alias path */ }
    if (path) {
      const second = (await runVerdict($, tool, [path, ...tool.argv.slice(1)])).verdict
      if (second.state === 'ok' || second.state === 'old') return { ...second, exe: path }
    }
  }
  return { ...first.verdict, exe: tool.argv[0] }
}

async function probeAll($, win) {
  return Promise.all(TOOLS.map(tool => probeOne($, tool, win)))
}

const needText = n => (n.state === 'old' ? `${n.tool.name} ${n.version} (${minText(n.tool)} 이상 필요)` : n.tool.name)

export function bandText(needs) {
  return `[ywr-harness] ${needs.map(needText).join(' · ')} 이(가) 없어 일부 기능이 동작하지 않습니다. ` +
    `/ywr-harness:setup 을 입력하면 설치합니다.`
}

export function noteText(needs) {
  const lines = needs.map(n => n.state === 'old'
    ? `- \`${n.tool.name}\` ${n.version} is older than the ${minText(n.tool)} the harness needs: ${n.tool.uses}.`
    : `- \`${n.tool.name}\` is not on PATH: ${n.tool.uses}.`)
  return [
    'ywr-harness prerequisite check (from the plugin, at session start):',
    ...lines,
    'Those failures come from the missing tools, not from a defect in the repository. The user sees a band that names ' +
    'the command `/ywr-harness:setup`. That command runs winget on Windows, and the plugin installs nothing until the ' +
    'user types it. A new tool is visible only after Claude Code restarts.',
  ].join('\n')
}

// The install commands for a manual install: winget lines on Windows, the other line elsewhere.
export function manualText(needs, isWindows) {
  return needs.map(n => (isWindows ? `- ${n.tool.name}: \`${wingetArgv(n.tool).join(' ')}\`` : `- ${n.tool.name}: ${n.tool.other}`)).join('\n')
}

// `exe` is the `winget` the probe reached: the bare name, or the alias path (fact 147). A line shown to the
// member keeps the bare name, which a terminal resolves.
export function wingetArgv(tool, exe = 'winget') {
  return [exe, 'install', '--id', tool.winget, '--exact', '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity', '--silent']
}

// A winget exit 0 does not prove the command resolves on PATH: whether the python installer puts
// `python` on PATH, and whether the Windows Store alias of `python` shadows it, is unmeasured (ADR 0142).
// The next session's probe is the check, so the report says what a returning band means.
const PATH_HINT = '재시작한 뒤에도 안내 줄에 다시 나오면, 설치는 됐지만 PATH 에서 찾지 못하는 것입니다.'
const ALIAS_HINT = ' python 이면 Windows 설정 > 앱 > 고급 앱 설정 > 앱 실행 별칭에서 python.exe 별칭을 끄고, PATH 에 Python 폴더가 있는지 확인하세요.'
// For a tool the probe found OLD, a band after the restart means the old binary still comes first on
// PATH (winget installs the new one beside it), not that the new one is missing from PATH.
const OLD_HINT = old => `재시작한 뒤에도 안내 줄에 다시 나오면, 이전 버전(${old})이 PATH 에서 먼저 잡히는 것입니다. 이전 버전을 지우거나 PATH 순서를 바꾸세요.`
const hintFor = (tool, old) => (old ? OLD_HINT(old) : PATH_HINT + (tool.name === 'python' ? ALIAS_HINT : ''))
const isUpToDate = code => typeof code === 'number' && (code >>> 0) === WINGET_UP_TO_DATE

// One install's report line (Korean, for the member) from the exit code `$.process.spawn` returned
// (null: a signal, or no start). `old` is the version the probe found when the tool was OLD, else null.
export function resultLine(tool, code, old = null) {
  if (code === 0) return `- ${tool.name}: 설치 명령이 끝났습니다. ${hintFor(tool, old)}`
  if (isUpToDate(code)) return `- ${tool.name}: winget 은 이미 설치돼 있다고 합니다. ${hintFor(tool, old)}`
  return `- ${tool.name}: 설치하지 못했습니다 (winget exit ${code === null ? '없음' : code}). 직접 실행: \`${wingetArgv(tool).join(' ')}\``
}

// The same result for the model (English).
export function resultNote(tool, code, old = null) {
  if (code === 0) return `${tool.name}: winget exited 0; whether the new \`${tool.name}\` resolves first on PATH is known only after a restart.`
  if (isUpToDate(code)) return old
    ? `${tool.name}: winget reports a current version installed, but this session found ${old} first on PATH.`
    : `${tool.name}: winget reports it already installed, but this session did not find it on PATH.`
  return `${tool.name}: winget failed (exit ${code === null ? 'none' : code}).`
}

// The tools whose probe was neither found nor missing (a timeout, an unexpected rejection): never
// reported as present (ADR 0142 Decision 10), never installed blind.
export function unknownText(verdicts) {
  const names = TOOLS.filter((t, i) => verdicts[i] && verdicts[i].state === 'unknown').map(t => t.name)
  return names.length ? `\n${names.join(' · ')} 은(는) 확인하지 못했습니다 (시간 초과 등). 직접 확인: ${names.map(n => `\`${n} --version\``).join(', ')}` : ''
}

// The flattened class of hook-lib.mjs's inline(): C0, DEL, NEL, LS, PS and the backtick become a space.
function isFlattened(c) {
  return c <= 0x1f || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029 || c === 0x60
}

export function flatten(text, max = 160) {
  const s = String(text ?? '')
  let out = ''
  for (let i = 0; i < s.length; i++) out += isFlattened(s.charCodeAt(i)) ? ' ' : s[i]
  out = out.replace(/ {2,}/g, ' ').trim()
  return out.length > max ? out.slice(0, max - 1) + '…' : out
}

// The last line of a child's output piece with two or more visible characters (a progress spinner's
// single glyph is skipped), flattened; '' when there is none.
export function lastLine(text) {
  const parts = String(text ?? '').split(/[\r\n]+/)
  for (let i = parts.length - 1; i >= 0; i--) {
    const t = flatten(parts[i])
    if (t.replace(/\s/g, '').length >= 2) return t
  }
  return ''
}

async function isWindows($) {
  try { return (await $.env.get('OS')) === 'Windows_NT' } catch { return false }
}

async function runSetup($) {
  const win = await isWindows($)
  const verdicts = await probeAll($, win)
  if (verdicts.every(v => v.state === 'unknown')) {
    return {
      text: '이 환경에서는 도구를 확인할 수 없습니다. 아래 명령으로 직접 설치하세요.\n' + manualText(needsOf(TOOLS.map(() => ({ state: 'missing' }))), win),
      context: ['ywr-harness setup could not run host commands on this surface; it printed the manual install commands and installed nothing.'],
    }
  }
  const needs = needsOf(verdicts)
  const unknown = unknownText(verdicts)
  const unknownNames = TOOLS.filter((t, i) => verdicts[i].state === 'unknown').map(t => t.name)
  const unknownNote = unknownNames.length ? ` Not verified (probe timed out or failed): ${unknownNames.join(', ')}.` : ''
  if (needs.length === 0) {
    const found = TOOLS.filter((t, i) => verdicts[i].state === 'ok').map(t => t.name)
    return {
      text: `${found.join(' · ')} 이(가) 설치돼 있습니다.` + unknown,
      context: [`ywr-harness setup found ${found.join(', ')} on PATH; it installed nothing.` + unknownNote],
    }
  }
  if (!win) {
    return {
      text: 'Windows 가 아니라 자동 설치는 하지 않습니다. 아래 명령으로 설치한 뒤 Claude Code 를 다시 시작하세요.\n' + manualText(needs, false) + unknown,
      context: [`ywr-harness setup is not on Windows; it printed the install commands for ${needs.map(n => n.tool.name).join(', ')} and installed nothing.` + unknownNote],
    }
  }
  const winget = await probeOne($, { name: 'winget', argv: ['winget', '--version'], min: null }, win)
  if (winget.state !== 'ok') {
    return {
      text: '`winget` 을 찾지 못했습니다. Microsoft Store 에서 "앱 설치 관리자"(App Installer)를 설치하거나, 아래 도구를 직접 설치하세요.\n' +
        needs.map(n => `- ${n.tool.name}: ${n.tool.winget}`).join('\n') + unknown,
      context: ['ywr-harness setup found no winget; it installed nothing.' + unknownNote],
    }
  }
  const lines = []
  const notes = []
  try {
    for (let i = 0; i < needs.length; i++) {
      const tool = needs[i].tool
      const old = needs[i].state === 'old' ? needs[i].version : null
      const head = `${tool.name} 설치 중 (${i + 1}/${needs.length}) · ${ESC_WARN}`
      $.ui.status(head)
      let code = null
      let shown = ''
      try {
        const child = $.process.spawn({ argv: wingetArgv(tool, winget.exe) })
        for await (const piece of child) {
          const line = lastLine(piece && piece.text)
          if (line && line !== shown) { shown = line; $.ui.status(`${head} — ${line}`) }
        }
        const end = await child.result
        code = end && typeof end.code === 'number' ? end.code : null
      } catch { code = null }
      lines.push(resultLine(tool, code, old))
      notes.push(resultNote(tool, code, old))
    }
  } finally {
    $.ui.status(undefined)
  }
  return {
    text: 'setup 결과:\n' + lines.join('\n') + unknown + '\nClaude Code 를 완전히 종료한 뒤 다시 시작해야 새로 설치한 도구가 보입니다.',
    context: ['ywr-harness setup ran winget for ' + needs.map(n => n.tool.name).join(', ') + '. Results: ' +
      notes.join(' ') + ' The running session keeps its old PATH until Claude Code restarts.' + unknownNote],
  }
}

export function register(on) {
  let needs = null   // null: not probed yet, or nothing to say; else the tools to install
  let running = false // one setup at a time: a second run would race winget on the same packages

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    let started = false // one run: a clock call that scheduled the timer and then threw must not start a second
    const probe = async () => {
      if (started) return
      started = true
      try {
        const found = needsOf(await probeAll($, await isWindows($)))
        needs = found.length ? found : null
        if (!needs) return
        try { $.ui.invalidate('ui.render') } catch { /* the band draws at the next render instead */ }
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: noteText(needs) }] } })
      } catch { /* a failed probe or append says nothing */ }
    }
    try { $.clock.after(0, probe) } catch { void probe() }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!needs || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return h(Box, null, h(Text, { color: 'yellow', wrap: 'wrap' }, bandText(needs)))
  })

  on('command.run', { command: COMMAND }, async $ => {
    if (running) return { text: '설치가 이미 진행 중입니다. 끝날 때까지 기다리세요.', context: ['ywr-harness setup is already running; this second run did nothing.'] }
    running = true
    try { return await runSetup($) } finally { running = false }
  })
}
