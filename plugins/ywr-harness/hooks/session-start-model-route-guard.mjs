// SessionStart (matcher `startup|resume|fork`): old-model route and effort-pin guard, warn-only
// (ywr-harness ADR 0107, ywr-harness ADR 0130).
//
// An alias must resolve to the newest model (ywr-harness ADR 0106). This hook reads the routes to an older
// model that a member can see in settings or the environment:
//   - an override: `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` (any value), a full id in
//     `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_MODEL` or a settings `model`, `CLAUDE_CODE_SUBAGENT_MODEL`
//     (any value), `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` (any value, it beats an explicit `agent()` model,
//     ywr-harness fact 112, ywr-harness ADR 0132) and a non-empty `modelOverrides`.
//   - a cloud provider: `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,ANTHROPIC_AWS,MANTLE}` resolves some
//     aliases to an older model.
// No hook can read three routes: `--resume` and `--continue` keep the saved model, an old Claude Code
// ships an old alias table, and `--model <full id>` stays unread: the payload's optional `model` field may
// hold the alias or the resolved id, and the docs do not say which (ywr-harness ADR 0107). The same-tier retry after an API
// refusal happens at run time, so no setting shows it (ywr-harness ADR 0130).
//
// The effort pin (ywr-harness ADR 0130). `CLAUDE_CODE_EFFORT_LEVEL` (any non-empty value) beats the
// frontmatter `effort` and an Agent call's `effort` (ywr-harness fact 108). The process environment wins over
// the settings files, and among the files the highest-precedence one is named. It has its own clause and
// `--preflight` never reports it, because the eval wrapper sets it to `low` itself (ywr-harness ADR 0103).
//
// Sources: the process environment (a settings `env` entry arrives there too), the user settings file
// (`$CLAUDE_CONFIG_DIR`, else `~/.claude`) and the project `.claude/settings.json` and
// `.claude/settings.local.json`. Managed settings are not read, because the org payload sets none of these
// keys and its cache is not a documented read surface. A file that does not parse is skipped, because
// validating settings is the host's job.
//
// Only `systemMessage` speaks. Plain stdout on exit 0 would become session context, so every other path
// is byte-silent. The matcher skips `clear` and `compact`, which keep the process environment.
//
// `--preflight` is the eval runner's refusal (ywr-harness spec 0014 §4.3). It reads the environment only,
// because an eval child gets its own config dir. It prints one line per finding and exits 1, or prints one
// "clear" line and exits 0. One key list serves both callers.
//
// Values render through inline() with a length cap, so a crafted value cannot forge a banner line. The
// prose cites no decision numbers, because a member cannot follow a canon ADR (ywr-harness spec 0006 §3.1).
//
// Environment names fold ASCII case. Settings files parse with hook-lib's parseJsonLoose and must be JSON
// objects. Paths join with hook-lib's psJoin(). The hook returns instead of exiting, so stdout drains.
// `--preflight` sets process.exitCode for the same reason (ywr-harness ADR 0116).
import fs from 'node:fs'
import os from 'node:os'
import { readStdin, parseJson, parseJsonLoose, isObject, getProp, psString, ieq, netTrim, inline, emit, psJoin } from './hook-lib.mjs'

const familyKeys = [
  ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'opus'], ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'sonnet'],
  ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'haiku'], ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'fable'],
]
const sessionKeys = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL']
const subagentKey = 'CLAUDE_CODE_SUBAGENT_MODEL'
const workflowKey = 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL'
const effortKey = 'CLAUDE_CODE_EFFORT_LEVEL'
const providerKeys = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE']
// The model-config doc's aliases, optionally with the `[1m]` suffix; anything else is a pinned id.
const aliasRx = /^(opus|sonnet|haiku|fable|opusplan|default|best)(\[1m\])?$/i

const isOn = v => { const t = netTrim(psString(v)); return t !== '' && !/^(0|false|no|off)$/i.test(t) }

/** Variable names compare ASCII case-insensitively. */
const fold = k => k.replace(/[A-Z]/g, c => c.toLowerCase())
const mapGet = (map, k) => map.get(fold(k))

// One finding is { key, text (Korean, for the member), en (English, for --preflight) }.
function getEnvFinding(map, where) {
  const out = []
  for (const [k, fam] of familyKeys) {
    const v = psString(mapGet(map, k))
    if (netTrim(v)) {
      const s = inline(v)
      out.push({ key: k, text: `\`${k}=${s}\` (${where}): \`${fam}\` alias 가 이 모델로 바뀝니다`,
        en: `${k}=${s} (${where}) replaces what the '${fam}' alias resolves to` })
    }
  }
  for (const k of sessionKeys) {
    const v = netTrim(psString(mapGet(map, k)))
    if (v && !aliasRx.test(v)) {
      const s = inline(v)
      out.push({ key: k, text: `\`${k}=${s}\` (${where}): 세션 모델이 full id 로 고정됩니다 — 같은 계열 워커도 그 모델로 돕니다`,
        en: `${k}=${s} (${where}) pins the session model to a full id; same-family workers run on it` })
    }
  }
  const sv = netTrim(psString(mapGet(map, subagentKey)))
  if (sv) {
    const s = inline(sv)
    out.push({ key: subagentKey, text: `\`${subagentKey}=${s}\` (${where}): 모델이 지정되지 않은 서브에이전트·워크플로 에이전트가 모두 이 모델로 바뀝니다`,
      en: `${subagentKey}=${s} (${where}) re-models every subagent and workflow agent without its own model` })
  }
  const wv = netTrim(psString(mapGet(map, workflowKey)))
  if (wv) {
    const s = inline(wv)
    out.push({ key: workflowKey, text: `\`${workflowKey}=${s}\` (${where}): 모든 워크플로 에이전트가 이 모델로 돕니다 — 각 \`agent()\` 호출이 지정한 모델보다 우선합니다`,
      en: `${workflowKey}=${s} (${where}) runs every workflow agent on this model, over each agent() call's own model` })
  }
  for (const k of providerKeys) {
    if (isOn(mapGet(map, k))) {
      out.push({ key: k, text: `\`${k}\` (${where}): 이 provider 에서는 alias 가 최신이 아닌 모델로 해석될 수 있습니다`,
        en: `${k} (${where}) selects a provider on which an alias can resolve to an older model` })
    }
  }
  return out
}

/** The effort-pin finding, or null. Kept out of getEnvFinding so `--preflight` never sees it. */
function getEffortFinding(map, where) {
  const v = netTrim(psString(mapGet(map, effortKey)))
  if (!v) return null
  const s = inline(v)
  return { key: effortKey, text: `\`${effortKey}=${s}\` (${where}): 모든 서브에이전트와 워크플로 에이전트가 이 effort 로 돕니다 — 에이전트 frontmatter 의 effort 와 호출별 \`effort\` 보다 우선합니다` }
}

function processEnvMap() {
  const m = new Map()
  for (const k of [...familyKeys.map(f => f[0]), ...sessionKeys, subagentKey, workflowKey, ...providerKeys]) {
    const v = process.env[k]
    if (v !== undefined) m.set(fold(k), v)
  }
  return m
}

function preflight() {
  const found = getEnvFinding(processEnvMap(), 'this shell')
  const lines = []
  if (found.length) {
    for (const f of found) lines.push(`preflight: REFUSED — ${f.en}`)
    lines.push('preflight: unset the variable(s) above in this shell (the eval runner forwards them to every child), then re-run.')
    process.exitCode = 1
  } else {
    lines.push('preflight: clear — no model-override or provider variable in this shell')
  }
  process.stdout.on('error', () => { })
  process.stdout.write(lines.join('\n') + '\n')
}

function readSettings(file) {
  try {
    if (!fs.statSync(file).isFile()) return null
    let s = fs.readFileSync(file, 'utf8')
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
    return parseJsonLoose(s)
  } catch { return null }
}

function main(payload) {
  const procEnv = processEnvMap()
  const findings = getEnvFinding(procEnv, '환경변수')
  const seen = new Set(findings.map(f => f.key))
  const efforts = []
  const pe = process.env[effortKey]
  const procEffort = getEffortFinding(new Map(pe === undefined ? [] : [[fold(effortKey), pe]]), '환경변수')
  if (procEffort) { efforts.push(procEffort); seen.add(procEffort.key) }
  let fileEffort = null

  let userDir = netTrim(psString(process.env.CLAUDE_CONFIG_DIR))
  if (!userDir) {
    const h = process.env.USERPROFILE || process.env.HOME || os.homedir()
    if (h) userDir = psJoin(h, '.claude')
  }
  const files = []
  if (userDir) files.push(psJoin(userDir, 'settings.json'))
  let proj = netTrim(psString(process.env.CLAUDE_PROJECT_DIR))
  if (!proj) proj = netTrim(psString(getProp(payload, 'cwd')))
  if (proj) files.push(psJoin(proj, '.claude/settings.json'), psJoin(proj, '.claude/settings.local.json'))

  for (const file of files) {
    const j = readSettings(file)
    if (!isObject(j)) continue
    const where = inline(file, 160)
    const m = getProp(j, 'model')
    if (typeof m === 'string' && netTrim(m) && !aliasRx.test(netTrim(m))) {
      findings.push({ key: `model@${file}`, text: `\`model: ${inline(m)}\` (${where}): 세션 모델이 full id 로 고정됩니다 — 같은 계열 워커도 그 모델로 돕니다` })
    }
    const mo = getProp(j, 'modelOverrides')
    if (isObject(mo)) {
      const n = Object.keys(mo).length
      if (n > 0) findings.push({ key: `modelOverrides@${file}`, text: `\`modelOverrides\` ${n}개 항목 (${where}): 고른 모델 대신 이 설정의 문자열이 호출됩니다` })
    }
    const e = getProp(j, 'env')
    if (isObject(e)) {
      const map = new Map()
      for (const [name, value] of Object.entries(e)) if (typeof value === 'string') map.set(fold(name), value)
      for (const f of getEnvFinding(map, `${where} env`)) {
        if (!seen.has(f.key)) { findings.push(f); seen.add(f.key) }
      }
      // The files run user, project, local in rising precedence, so the last one that sets the
      // effort variable holds the value Claude Code applies. That one is named.
      fileEffort = getEffortFinding(map, `${where} env`) || fileEffort
    }
  }
  if (fileEffort && !seen.has(fileEffort.key)) { efforts.push(fileEffort); seen.add(fileEffort.key) }

  if (!findings.length && !efforts.length) return
  const parts = ['[hook:model-route]']
  if (findings.length) {
    parts.push(`모델 alias 가 최신이 아닌 모델로 갈 수 있는 설정이 있습니다: ${findings.map(f => f.text).join('; ')}.`,
      '조직 가이드: 워커 모델은 family alias 로만 부르고 각 alias 는 최신 모델에 둡니다 — 의도한 설정이 아니면 값을 지우세요.')
  }
  if (efforts.length) {
    parts.push(`워커의 effort pin 을 덮어쓰는 설정이 있습니다: ${efforts.map(f => f.text).join('; ')}.`,
      'ywr-harness 규칙: 워커 effort 는 역할별로 정합니다 — 의도한 설정이 아니면 값을 지우세요.')
  }
  parts.push('이 훅은 안내만 하며 아무것도 바꾸거나 막지 않았습니다.')
  emit({ systemMessage: parts.join(' ') })
}

try {
  if (process.argv.slice(2).some(a => a.toLowerCase() === '--preflight')) preflight()
  else {
    const payload = parseJson(readStdin())
    if (isObject(payload) && ieq(psString(getProp(payload, 'hook_event_name')), 'SessionStart')) main(payload)
  }
} catch { /* fail-open: a hook defect is never a blocked session */ }
