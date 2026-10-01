// PreToolUse (matcher `Agent`) — WARN-ONLY note when an Agent-tool spawn names an opus- or
// fable-family model explicitly (ADR 0086; dist #5 request 1).
//
// Why a warning and not a guard: a per-call `model` overrides a pinned agent's frontmatter
// (sub-agents docs, resolution order 1 before 2 — ADR 0084 measured `ywr-harness:worker` with
// `model: opus` running on Opus 5.5), so the plugin's sonnet/haiku pins cannot stop it. A DENY or
// ASK would still be wrong: the org guide allows an opus worker that demonstrably needs it (the
// reason goes in the description), and a hook cannot see the session model or judge that reason.
// (Until ADR 0108 ultracode was a second reason: it lifted every pin and a hook could not detect
// it. Ultracode no longer lifts a pin, so it no longer bears on this hook.) This hook therefore NEVER returns
// permissionDecision / updatedInput and NEVER blocks: the call proceeds through the normal
// permission flow whatever it prints.
//
// Speaks ONLY when `tool_input.model` is a string naming the opus or fable family (an alias —
// `opus`, `fable` — or a full id such as `claude-opus-5-5`), on every `subagent_type`: since ADR
// 0109 no plugin agent pins opus, so an opus-family per-call model always overrides a pin or
// picks the model of an unpinned type. The prose states the org guide's rule, which no longer
// depends on the session model: implementation and research workers run sonnet in every session
// (the Agent-tool route is `ywr-harness:worker` with no per-call model), mechanical work haiku,
// opus · low only for review fan-out on an Opus session, and any other opus/fable worker names its
// reason in the description.
// NEVER on an omitted model: this hook names per-call OVERRIDES only. With no model a pinned agent
// runs its frontmatter pin and Explore/Plan choose their own, while an unpinned type such as
// `general-purpose` inherits the session model — a leak the org guide's "pass an explicit model"
// rule governs. Telling those apart would need a list of pinned types kept in step with every
// repo's agents, so the hook stays silent on all of them (ADR 0108's residual). No suppression on effort xhigh/max either: that is this seat's normal level and the
// fan-out the pins exist to stop. No `.harness.json` key: nothing is blocked, so nothing needs an
// allowance (ADR 0010/0012 surface stays closed).
//
// Payload and output contract, verified against the RAW hooks reference 2026-09-23
// (code.claude.com/docs/en/hooks.md + tools-reference.md):
//   tool_name  : "Agent" — tools-reference: "The tool names are the exact strings you use in ...
//                hook matchers"; the matcher `Agent` is an exact-string match (letters only).
//   tool_input : { prompt, description, subagent_type, model } — `model` is "Optional model alias
//                to override the default".
//   output     : `systemMessage` is the universal "Warning message shown to the user" (the member
//                sees it at spawn time — what dist #5 asked for); `hookSpecificOutput.
//                additionalContext` (hookEventName PreToolUse) is "String added to Claude's
//                context alongside the tool result". Exit 0 with no decision leaves the call to
//                the normal permission flow.
// Language is reader-keyed (ADR 0045): Korean systemMessage, English additionalContext.
//
// Fail-open (spec 0006 §3.1): unparseable stdin, a wrong event or a tool other than Agent -> silent
// exit 0. Anti-vacuity: a PreToolUse payload with no non-empty string `tool_name`, or one whose
// `tool_input` is not an object, emits a SCHEMA-DRIFT banner listing the keys received — a warn
// hook that cannot read its fields must say so, not fall silent. A missing name is drift, not
// "another tool": the runtime calls this script only on the `Agent` matcher, so a renamed or
// dropped field would otherwise leave the hook inert on every spawn.
// Payload text (the model string and subagent_type are model-authored, the key list host-authored)
// renders through inline() and a length cap so it cannot forge banner lines. inline()'s class is
// harness_config.CONTROL's — C0, DEL, U+0085 NEL, U+2028/U+2029 — plus the backtick: a model reads
// this output, and it may take any of the three Unicode breaks as a line break. The class lives in
// hook-lib.mjs; the three pwsh hooks that still carry their own Inline() are held to it by
// Assert-InlineParity (lib/selftest-lib.ps1).
// The prose states its rules and cites no decision numbers: a bare "ADR NNNN" resolves against the
// repo the reader stands in, and this canon is private, so a member can never follow one (spec 0006
// §3.1). No network, no git, no file writes — one node spawn per Agent call is the whole cost.
//
// Comparisons of the event and tool names are case-insensitive, as the pwsh original's `-ne` was.
// The hook never exits the process: it returns, so stdout drains and the exit code stays 0.
import { readStdin, parseJson, isObject, getProp, psString, ieq, netTrim, inline, emit } from './hook-lib.mjs'

// Drift-key order: case-insensitive, locale-aware (the original's Sort-Object was culture-aware), with
// an ordinal tiebreak so the order is deterministic. Exact parity with Sort-Object across cultures is
// not possible; the received keys of a real payload are lowercase ASCII and sort identically.
const collator = new Intl.Collator(undefined, { sensitivity: 'accent' })

// SCHEMA DRIFT names the missing field and the keys received (Korean: the member reads it).
function drift(payload, missing) {
  let keys = '(none)'
  const k = Object.keys(payload).sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0))
  if (k.length) keys = inline(k.join(', '), 300)
  emit({ systemMessage: `[hook:agent-model] SCHEMA DRIFT — PreToolUse(Agent) 페이로드에 ${missing} 없어, 이 경고 훅이 요청된 모델을 읽을 수 없습니다. 수신된 키: ${keys}. hooks 레퍼런스의 PreToolUse 입력 형식을 다시 확인하세요. 호출은 차단하지 않았습니다.` })
}

function main(payload) {
  const tn = getProp(payload, 'tool_name')
  if (typeof tn !== 'string' || !netTrim(tn)) return drift(payload, "문자열 'tool_name' 필드가")
  if (!ieq(tn, 'Agent')) return

  const ti = getProp(payload, 'tool_input')
  if (!isObject(ti)) return drift(payload, "객체 형태의 'tool_input' 필드가")

  const model = getProp(ti, 'model')
  if (typeof model !== 'string') return          // omitted (no per-call override to name) or not a string
  const m = netTrim(model)
  if (!m || !/(^|[-_/.:])(opus|fable)/i.test(m)) return

  const mShow = inline(m)
  const type = inline(psString(getProp(ti, 'subagent_type'))) || '(unset)'

  const sys = `[hook:agent-model] Agent 호출이 모델을 '${mShow}' 로 명시했습니다 (subagent_type: ${type}). ` +
    '조직 가이드: 구현·조사 워커는 어느 세션이든 sonnet 입니다 — Agent 호출이라면 호출별 model 없이 ywr-harness:worker 를 쓰세요. ' +
    '기계적 작업은 haiku 이고, opus · effort low 는 Opus 세션의 리뷰형 fan-out(finder·skeptic)에만 씁니다. 그 밖의 opus·fable 모델은 꼭 필요한 워커에만 쓰며 그 이유를 호출의 description 에 적습니다. ' +
    '호출별 model 은 고정(pinned)된 에이전트의 frontmatter 모델보다 우선합니다. ' +
    'ultracode 가 켜져 있어도 이 고정은 그대로입니다. ' +
    '훅은 세션 모델도 호출 사유도 판단할 수 없어 차단하지 않았습니다 — 안내만 합니다.'
  const ctx = `This Agent spawn requested model '${mShow}' (subagent_type '${type}'), an opus/fable-family model. ` +
    "Org guide: implementation and research workers run on 'sonnet' in every session — for an Agent-tool spawn that route is subagent_type 'ywr-harness:worker' with NO per-call model; mechanical work runs on 'haiku'. " +
    "Opus at effort low is for review fan-out (finders, skeptics) on an Opus session; any other opus or fable model is only for a worker that demonstrably needs it, with the reason in the spawn's description. " +
    "A per-call model overrides a pinned agent's frontmatter model, so the ywr-harness:worker / ywr-harness:mech pins do not apply to this call. " +
    'Ultracode does not lift these pins. ' +
    'Nothing was blocked: a hook cannot see the session model or judge the stated reason, so this note only warns.'
  emit({ systemMessage: sys, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ctx } })
}

try {
  const payload = parseJson(readStdin())
  if (isObject(payload) && ieq(psString(getProp(payload, 'hook_event_name')), 'PreToolUse')) main(payload)
} catch { /* fail-open: a hook defect is never a blocked tool call */ }
