# ConfigChange(user_settings|project_settings|local_settings|policy_settings) — mid-session
# config-edit audit. Visibility ONLY: never blocks (no decision emitted) — the
# point is that a permission/hook self-modification cannot happen silently mid-session
# (house rule: such changes need explicit user approval). The `skills` matcher is
# deliberately NOT subscribed (fires on every skill load — noise).
#
# Payload field name FIXED 2026-07-25: this hook shipped reading
# `config_source`, a field no hook payload has ever carried — the only two occurrences of
# that name in the shipped binary are an unrelated OpenTelemetry attribute. Every real
# ConfigChange therefore left $src empty and the hook exited 0 in silence from its first
# day, while its 6-case selftest stayed green on the invented name. The event carries
# `source` (which tier changed) and an optional `file_path`. Both names are from the
# 2.1.220 binary's zod schema AND the official hooks reference — its ConfigChange input
# section and JSON example, read from the raw `.md` (a WebFetch summary of that page drops
# the field names, which is how a review finding on that fix wrongly called this citation
# false; check the raw file, not a summary). Line numbers are not cited: the page moves.
#
# Output is JSON `systemMessage` (user-facing banner), NOT plain stdout: ConfigChange
# exit-0 stdout is transcript-view only and never reaches the model; `additionalContext`
# is not honored for this event either (doc-verified 2026-07-23, re-verified 2026-07-25,
# https://code.claude.com/docs/en/hooks.md). Fail-open on infra: an unparseable payload
# emits nothing and exits 0. A PARSEABLE payload missing `source` is different — that is
# schema drift, and it is reported rather than swallowed, so this hook can never again be
# silently inert.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
try { $payload = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { exit 0 }
if ([string]$payload.hook_event_name -ne 'ConfigChange') { exit 0 }

# Payload-authored text is echoed through Inline() — the class agent-model-warn.ps1 uses (C0, DEL,
# U+0085 NEL, U+2028/U+2029 and the backtick become a space, then a hard cap) — so a hostile value
# cannot forge a second `[hook:*]` line in the banner a person or a model reads.
function Inline([string]$Text, [int]$Max = 80) {
    $t = (([string]$Text) -replace '[\u0000-\u001F\u007F\u0085\u2028\u2029`]', ' ').Trim()
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max - 1) + '…' }
    return $t
}

# Judged AFTER Inline(): a value of only control bytes or backticks survives Trim() but echoes as
# nothing, and a non-string `source` is a shape change — both are drift, never a tier-less banner.
$src = if ($payload.source -is [string]) { Inline $payload.source } else { '' }
if (-not $src) {
    $keys = '(none)'
    try { $k = @($payload.PSObject.Properties.Name | Sort-Object); if ($k) { $keys = Inline ($k -join ', ') 300 } } catch { }
    $drift = "[hook:config-audit] SCHEMA DRIFT — ConfigChange 페이로드의 'source' 필드가 없거나 비어 있거나 문자열이 아니어서, 어떤 설정 계층이 변경되었는지 확인할 수 없습니다. 수신된 키: $keys. hooks 레퍼런스의 ConfigChange 입력 형식이 바뀌었을 수 있습니다 — 플러그인 쪽 문제이니 /ywr-harness:feedback 으로 알려 주세요."
    @{ systemMessage = $drift } | ConvertTo-Json -Compress
    exit 0
}

$where = Inline $payload.file_path 300
$msg = "[hook:config-audit] $src 세션 중 변경됨"
if ($where) { $msg += " ($where)" }
$msg += ' (대부분의 키는 즉시 반영되며, model/outputStyle은 다음 세션 시작 시 적용됩니다). 하우스 규칙: 권한/훅 자기 수정은 명시적인 사용자 승인이 필요합니다 — 직접 지시한 변경이 아니라면 지금 검토하세요 (git diff로 설정 파일 확인).'
@{ systemMessage = $msg } | ConvertTo-Json -Compress
exit 0
