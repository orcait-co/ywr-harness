# PreToolUse (matcher `Agent`) — WARN-ONLY note when an Agent-tool spawn names an opus- or
# fable-family model explicitly (ADR 0086; dist #5 request 1).
#
# Why a warning and not a guard: a per-call `model` overrides a pinned agent's frontmatter
# (sub-agents docs, resolution order 1 before 2 — ADR 0084 measured `ywr-harness:worker` with
# `model: opus` running on Opus 5.5), so the plugin's sonnet/haiku pins cannot stop it. A DENY or
# ASK cannot be made ultracode-safe: the hooks reference says ultracode "is not a distinct level
# and reports as `xhigh`", and a keyword opt-in leaves the effort level unchanged (ADR 0084), so a
# hook cannot tell a sanctioned spawn from a leak. This hook therefore NEVER returns
# permissionDecision / updatedInput and NEVER blocks: the call proceeds through the normal
# permission flow whatever it prints.
#
# Speaks ONLY when `tool_input.model` is a string naming the opus or fable family (an alias —
# `opus`, `fable` — or a full id such as `claude-opus-5-5`). NEVER on an omitted model: under
# ultracode ADR 0084's sanctioned spawn is an unpinned Agent type with no model, and the built-in
# Explore/Plan agents inherit too — a warning there would fire on exactly the spawn the rule
# prescribes. No suppression on effort xhigh/max either: that is this seat's normal level and the
# fan-out the pins exist to stop. No `.harness.json` key: nothing is blocked, so nothing needs an
# allowance (ADR 0010/0012 surface stays closed).
#
# Payload and output contract, verified against the RAW hooks reference 2026-09-23
# (code.claude.com/docs/en/hooks.md + tools-reference.md):
#   tool_name  : "Agent" — tools-reference: "The tool names are the exact strings you use in ...
#                hook matchers"; the matcher `Agent` is an exact-string match (letters only).
#   tool_input : { prompt, description, subagent_type, model } — `model` is "Optional model alias
#                to override the default".
#   output     : `systemMessage` is the universal "Warning message shown to the user" (the member
#                sees it at spawn time — what dist #5 asked for); `hookSpecificOutput.
#                additionalContext` (hookEventName PreToolUse) is "String added to Claude's
#                context alongside the tool result". Exit 0 with no decision leaves the call to
#                the normal permission flow.
# Language is reader-keyed (ADR 0045): Korean systemMessage, English additionalContext.
#
# Fail-open (spec 0006 §3.1): unparseable stdin, a wrong event or a tool other than Agent -> silent
# exit 0. Anti-vacuity: a PreToolUse payload with no non-empty string `tool_name`, or one whose
# `tool_input` is not an object, emits a SCHEMA-DRIFT banner listing the keys received — a warn
# hook that cannot read its fields must say so, not fall silent. A missing name is drift, not
# "another tool": the runtime calls this script only on the `Agent` matcher, so a renamed or
# dropped field would otherwise leave the hook inert on every spawn.
# Payload text (the model string and subagent_type are model-authored, the key list host-authored)
# renders through Inline() and a length cap so it cannot forge banner lines. Inline()'s class is
# harness_config.CONTROL's — C0, DEL, U+0085 NEL, U+2028/U+2029 — plus the backtick: a model reads
# this output, and it may take any of the three Unicode breaks as a line break.
# The prose states its rules and cites no decision numbers: a bare "ADR NNNN" resolves against the
# repo the reader stands in, and this canon is private, so a member can never follow one (spec 0006
# §3.1). No network, no git, no file writes — one pwsh spawn per Agent call is the whole cost.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
try { $payload = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { exit 0 }
if ($null -eq $payload -or [string]$payload.hook_event_name -ne 'PreToolUse') { exit 0 }

# Line breaks under every reader's notion of one, control bytes and backticks -> space, then a hard
# cap: the value is payload-authored input.
function Inline([string]$Text, [int]$Max = 80) {
    $t = (([string]$Text) -replace '[\u0000-\u001F\u007F\u0085\u2028\u2029`]', ' ').Trim()
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max - 1) + '…' }
    return $t
}
# SCHEMA DRIFT names the missing field and the keys received, then exits (Korean: the member reads it).
function Write-Drift([string]$Missing) {
    $keys = '(none)'
    try { $k = @($payload.PSObject.Properties.Name | Sort-Object); if ($k) { $keys = Inline ($k -join ', ') 300 } } catch { }
    $drift = "[hook:agent-model] SCHEMA DRIFT — PreToolUse(Agent) 페이로드에 ${Missing} 없어, 이 경고 훅이 요청된 모델을 읽을 수 없습니다. 수신된 키: ${keys}. hooks 레퍼런스의 PreToolUse 입력 형식을 다시 확인하세요. 호출은 차단하지 않았습니다."
    @{ systemMessage = $drift } | ConvertTo-Json -Compress
    exit 0
}

$tn = $payload.tool_name
if ($tn -isnot [string] -or -not $tn.Trim()) { Write-Drift "문자열 'tool_name' 필드가" }
if ($tn -ne 'Agent') { exit 0 }

$ti = $payload.tool_input
if ($ti -isnot [System.Management.Automation.PSCustomObject]) { Write-Drift "객체 형태의 'tool_input' 필드가" }

$model = $ti.model
if ($model -isnot [string]) { exit 0 }          # omitted (ultracode's sanctioned spawn, ADR 0084) or not a string
$m = $model.Trim()
if (-not $m -or $m -notmatch '(?i)(^|[-_/.:])(opus|fable)') { exit 0 }

$mShow = Inline $m
$type = Inline ([string]$ti.subagent_type)
if (-not $type) { $type = '(unset)' }

$sys = "[hook:agent-model] Agent 호출이 모델을 '${mShow}' 로 명시했습니다 (subagent_type: ${type}). " +
       '조직 가이드: 워커 기본값은 sonnet(기계적 작업은 haiku)이고, opus·fable 계열은 꼭 필요한 워커에만 씁니다 — 그렇다면 이유를 호출의 description 에 적으세요. ' +
       '호출별 model 은 고정(pinned)된 에이전트의 frontmatter 모델보다 우선합니다. ' +
       '이 작업에 ultracode 가 켜져 있다면(세션 설정 또는 호스트가 확인한 키워드 옵트인) 워커의 모델·effort 고정이 모두 풀리므로 이 안내는 무시해도 됩니다. ' +
       '훅은 ultracode 여부를 알 수 없어 차단하지 않았습니다 — 안내만 합니다.'
$ctx = "This Agent spawn requested model '${mShow}' (subagent_type '${type}'), an opus/fable-family model. " +
       "Org guide: workers default to 'sonnet' ('haiku' for mechanical work); use 'opus' only for a worker that demonstrably needs it, and when this one does, say why in the spawn's description. " +
       'A per-call model overrides a pinned agent''s frontmatter model, so the ywr-harness:worker / ywr-harness:mech pins do not apply to this call. ' +
       'If ultracode is on for this task (the session setting or the host-confirmed keyword opt-in), every worker model and effort pin is lifted and this note can be ignored. ' +
       'Nothing was blocked: a hook cannot tell an ultracode spawn from an unsanctioned one, so this note only warns.'
@{ systemMessage = $sys; hookSpecificOutput = @{ hookEventName = 'PreToolUse'; additionalContext = $ctx } } | ConvertTo-Json -Compress
exit 0
