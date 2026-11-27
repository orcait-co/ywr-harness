// PreToolUse (matcher `Agent`): a warn-only note when an Agent-tool spawn names an opus or fable model
// (ywr-harness ADR 0086), or a per-call effort of xhigh or max (ywr-harness ADR 0127).
//
// Warn, never guard. A per-call `model` overrides a pinned agent's frontmatter, so the pins cannot stop
// it (ywr-harness ADR 0084). A deny or ask would be wrong too: the org guide allows an opus worker that
// needs it, and a hook cannot see the session model or judge the stated reason. The hook never returns
// permissionDecision or updatedInput and never blocks.
//
// Model clause: speaks only when `tool_input.model` is a string naming the opus or fable family, an
// alias or a full id, on every `subagent_type`. No plugin agent pins opus (ywr-harness ADR 0109).
// The prose states the rule of ywr-harness ADR 0109 and the review route of ywr-harness ADR 0215.
//
// Effort clause: speaks when `tool_input.effort`, trimmed and case-insensitive, equals `xhigh` or `max`,
// on every `subagent_type`. A per-call effort overrides the pinned effort (ywr-harness ADR 0127).
// A call that matches on both gets one banner. Haiku 4.5 takes no effort (ywr-harness fact 101).
// low, medium and high are the role levels and stay silent. A per-call effort below the pin is not
// policed, because that needs each repo's agent pins.
//
// Silent on an omitted model: a pinned agent runs its pin and an unpinned type inherits the session
// model, and telling them apart needs a list of pinned types (ywr-harness ADR 0108). The payload's
// top-level session `effort` never suppresses the model warning. Only `tool_input.effort` is read.
// No `.harness.json` key: nothing is blocked, so nothing needs an allowance (ywr-harness ADR 0010/0012).
//
// Payload: tool_name "Agent", tool_input { prompt, description, subagent_type, model, effort }.
// The output is `systemMessage` for the member and `additionalContext` for the model (hookEventName
// PreToolUse). Exit 0 with no decision leaves the call to the normal permission flow. The language
// follows the reader: Korean systemMessage, English additionalContext (ywr-harness ADR 0045).
//
// Fail-open (ywr-harness spec 0006 §3.1): unparseable stdin, a wrong event or another tool exits 0 in
// silence. A payload with no non-empty string `tool_name`, or a `tool_input` that is not an object,
// emits a SCHEMA-DRIFT banner with the keys received. The runtime calls this script only on the
// `Agent` matcher, so a missing field means drift, not another tool.
//
// Payload text (model string, effort string, subagent_type, key list) goes through inline() and a
// length cap, so it cannot forge banner lines. Its class is harness_config.CONTROL's plus the backtick,
// because a model may read U+0085, U+2028 and U+2029 as line breaks. `prerequisites.mjs` repeats the
// class in flatten() (ywr-harness ADR 0142).
// The prose cites no decision numbers: a bare "ADR NNNN" resolves in the repo the reader stands in
// (ywr-harness spec 0006 §3.1). The hook uses no network, no git and no file write.
//
// Event and tool names compare case-insensitively. The hook returns instead of exiting, so stdout
// drains and the exit code stays 0.
import { readStdin, parseJson, isObject, getProp, psString, ieq, netTrim, inline, emit, driftKeys } from './hook-lib.mjs'

// SCHEMA DRIFT names the missing field and the keys received (Korean: the member reads it).
function drift(payload, missing) {
  const keys = driftKeys(payload)
  emit({ systemMessage: `[hook:agent-model] SCHEMA DRIFT — PreToolUse(Agent) 페이로드에 ${missing} 없어, 이 경고 훅이 요청된 모델을 읽을 수 없습니다. 수신된 키: ${keys}. hooks 레퍼런스의 PreToolUse 입력 형식을 다시 확인하세요. 호출은 차단하지 않았습니다.` })
}

function main(payload) {
  const tn = getProp(payload, 'tool_name')
  if (typeof tn !== 'string' || !netTrim(tn)) return drift(payload, "문자열 'tool_name' 필드가")
  if (!ieq(tn, 'Agent')) return

  const ti = getProp(payload, 'tool_input')
  if (!isObject(ti)) return drift(payload, "객체 형태의 'tool_input' 필드가")

  const model = getProp(ti, 'model')              // a non-string (omitted or odd) names no family
  const m = typeof model === 'string' ? netTrim(model) : ''
  const modelHit = !!m && /(^|[-_/.:])(opus|fable)/i.test(m)

  const effort = getProp(ti, 'effort')            // a non-string, empty or absent effort names no level
  const e = typeof effort === 'string' ? netTrim(effort) : ''
  const effortHit = /^(xhigh|max)$/i.test(e)

  if (!modelHit && !effortHit) return

  const mShow = inline(m)
  const eShow = inline(e)
  const type = inline(psString(getProp(ti, 'subagent_type'))) || '(unset)'

  // Each point is one sentence group; the first carries the subagent_type. The trailer is shared.
  const sysParts = []
  const ctxParts = []
  if (modelHit) {
    sysParts.push(`Agent 호출이 모델을 '${mShow}' 로 명시했습니다 (subagent_type: ${type}). ` +
      'ywr-harness 규칙: 구현·조사 워커는 어느 세션이든 sonnet 입니다 — Agent 호출이라면 호출별 model 없이 ywr-harness:worker 를 쓰세요. ' +
      '기계적 작업은 haiku 이고, ywr-harness 의 에이전트 고정값은 어느 것도 opus·fable 을 쓰지 않습니다. slice close 의 리뷰는 세션 모델로 도는 /code-review 이고, 그 fix check 는 ywr-harness:worker 가 맡습니다. 고정값 밖에서 opus·fable 워커를 띄우는 것은 그 모델이 꼭 필요한 작업일 때만이며, 그 이유를 호출의 description 에 적습니다. ' +
      '호출별 model 은 고정(pinned)된 에이전트의 frontmatter 모델보다 우선합니다. ')
    ctxParts.push(`This Agent spawn requested model '${mShow}' (subagent_type '${type}'), an opus/fable-family model. ` +
      "ywr-harness rule: implementation and research workers run on 'sonnet' in every session — for an Agent-tool spawn that route is subagent_type 'ywr-harness:worker' with NO per-call model; mechanical work runs on 'haiku'. " +
      "No ywr-harness agent pin uses opus or fable. The slice-close review is the built-in /code-review on the session model, and its fix-check legs run on ywr-harness:worker. An opus or fable worker outside those pins is only for a task that demonstrably needs that model, with the reason in the spawn's description. " +
      "A per-call model overrides a pinned agent's frontmatter model, so the ywr-harness:worker / ywr-harness:mech pins do not apply to this call. ")
  }
  if (effortHit) {
    sysParts.push(`Agent 호출이 effort 를 '${eShow}' 로 지정했습니다${modelHit ? '' : ` (subagent_type: ${type})`}. ` +
      '호출별 effort 는 고정(pinned)된 에이전트의 frontmatter effort 보다 우선하므로 ywr-harness:worker·verifier·mech 의 고정이 이 호출에는 적용되지 않습니다. ' +
      'ywr-harness 규칙은 워커 effort 를 역할별로 정합니다 — 기계적 작업은 low, 검증 절차는 medium, 구현·조사는 high 입니다. ' +
      '호출별 effort 는 그 역할의 수준이어야 하며 xhigh·max 는 쓰지 않습니다 — 이 둘은 고정이 워커에게서 떼어 놓는 deep-work 세션 수준입니다. ')
    ctxParts.push(`This Agent spawn set effort '${eShow}'${modelHit ? '' : ` (subagent_type '${type}')`}. ` +
      "A per-call effort overrides a pinned agent's frontmatter effort, so the ywr-harness:worker / ywr-harness:verifier / ywr-harness:mech pins do not apply to this call. " +
      'ywr-harness rule: worker effort follows the role — mechanical work low, a verification procedure medium, implementation and research high. ' +
      "A per-call effort should be the role's level, never 'xhigh' or 'max': those are the deep-work session levels the pins keep out of workers. ")
  }

  const sys = '[hook:agent-model] ' + sysParts.join('') +
    'ultracode 가 켜져 있어도 이 고정은 그대로입니다. ' +
    '훅은 세션 모델도 호출 사유도 판단할 수 없어 차단하지 않았습니다 — 안내만 합니다.'
  const ctx = ctxParts.join('') +
    'Ultracode does not lift these pins. ' +
    'Nothing was blocked: a hook cannot see the session model or judge the stated reason, so this note only warns.'
  emit({ systemMessage: sys, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ctx } })
}

try {
  const payload = parseJson(readStdin())
  if (isObject(payload) && ieq(psString(getProp(payload, 'hook_event_name')), 'PreToolUse')) main(payload)
} catch { /* fail-open: a hook defect is never a blocked tool call */ }
