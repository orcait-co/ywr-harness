// ConfigChange(user_settings|project_settings|local_settings|policy_settings): mid-session config-edit audit.
// Visibility only: it never blocks and emits no decision (ywr-harness spec 0006 §3.2).
// The `skills` matcher stays unsubscribed because it fires on every skill load.
//
// The payload carries `source` (the changed tier) and an optional `file_path`. No payload has a
// `config_source` field. A parseable payload without `source` is schema drift and is reported, never swallowed.
//
// Output is JSON `systemMessage`. ConfigChange stdout never reaches the model, and `additionalContext`
// is not honored for this event (https://code.claude.com/docs/en/hooks.md). An unparseable payload
// emits nothing and exits 0.
//
// Payload-authored text goes through inline() (hook-lib.mjs), so a hostile value cannot forge a second
// `[hook:*]` line in the banner (ywr-harness spec 0006 §3.1). The event name and payload keys compare
// case-insensitively. The hook returns instead of exiting the process, so stdout drains and the exit
// code stays 0 (ywr-harness ADR 0116).
import { readStdin, parseJson, isObject, getProp, psString, ieq, inline, emit, driftKeys } from './hook-lib.mjs'

// A non-string `source`, or one that flattens to nothing, is drift, never a tier-less banner.
function drift(payload) {
  const keys = driftKeys(payload)
  emit({ systemMessage: `[hook:config-audit] SCHEMA DRIFT — ConfigChange 페이로드의 'source' 필드가 없거나 비어 있거나 문자열이 아니어서, 어떤 설정 계층이 변경되었는지 확인할 수 없습니다. 수신된 키: ${keys}. hooks 레퍼런스의 ConfigChange 입력 형식이 바뀌었을 수 있습니다 — 플러그인 쪽 문제이니 /ywr-harness:report-issue 로 알려 주세요.` })
}

function main(payload) {
  const rawSrc = getProp(payload, 'source')
  const src = typeof rawSrc === 'string' ? inline(rawSrc) : ''
  if (!src) return drift(payload)

  const where = inline(psString(getProp(payload, 'file_path')), 300)
  let msg = `[hook:config-audit] ${src} 세션 중 변경됨`
  if (where) msg += ` (${where})`
  msg += ' (대부분의 키는 즉시 반영되며, model/outputStyle은 다음 세션 시작 시 적용됩니다). 하우스 규칙: 권한/훅 자기 수정은 명시적인 사용자 승인이 필요합니다 — 직접 지시한 변경이 아니라면 지금 검토하세요 (git diff로 설정 파일 확인).'
  emit({ systemMessage: msg })
}

try {
  const payload = parseJson(readStdin())
  if (isObject(payload) && ieq(psString(getProp(payload, 'hook_event_name')), 'ConfigChange')) main(payload)
} catch { /* fail-open: a hook defect is never a blocked config change */ }
