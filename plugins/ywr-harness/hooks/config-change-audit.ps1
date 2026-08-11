# ConfigChange(user_settings|project_settings|local_settings|policy_settings) — mid-session
# config-edit audit (ADR #112). Visibility ONLY: never blocks (no decision emitted) — the
# point is that a permission/hook self-modification cannot happen silently mid-session
# (house rule: such changes need explicit user approval). The `skills` matcher is
# deliberately NOT subscribed (fires on every skill load — noise).
#
# Payload field name FIXED 2026-07-25 (ADR #120): this hook shipped reading
# `config_source`, a field no hook payload has ever carried — the only two occurrences of
# that name in the shipped binary are an unrelated OpenTelemetry attribute. Every real
# ConfigChange therefore left $src empty and the hook exited 0 in silence from its first
# day, while its 6-case selftest stayed green on the invented name. The event carries
# `source` (which tier changed) and an optional `file_path`. Both names are from the
# 2.1.220 binary's zod schema AND the official hooks reference — `hooks.md` lines 2341,
# 2375 and the ConfigChange JSON example at 2384, read from the raw `.md` (a WebFetch
# summary of that page drops all three, which is how an ADR #120 review finding wrongly
# called this citation false; check the raw file, not a summary).
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

$src = ([string]$payload.source).Trim()
if (-not $src) {
    $keys = '(none)'
    try { $k = @($payload.PSObject.Properties.Name | Sort-Object); if ($k) { $keys = $k -join ', ' } } catch { }
    $drift = "[hook:config-audit] SCHEMA DRIFT — ConfigChange 페이로드에 'source' 필드가 없어, 어떤 설정 계층이 변경되었는지 확인할 수 없습니다. 수신된 키: $keys. 페이로드 형식을 다시 확인하고 .claude/hooks/config-change-audit.ps1을 수정하세요 (ADR #120)."
    @{ systemMessage = $drift } | ConvertTo-Json -Compress
    exit 0
}

$where = ([string]$payload.file_path).Trim()
$msg = "[hook:config-audit] $src 세션 중 변경됨"
if ($where) { $msg += " ($where)" }
$msg += ' (대부분의 키는 즉시 반영되며, model/outputStyle은 다음 세션 시작 시 적용됩니다). 하우스 규칙: 권한/훅 자기 수정은 명시적인 사용자 승인이 필요합니다 — 직접 지시한 변경이 아니라면 지금 검토하세요 (git diff로 설정 파일 확인).'
@{ systemMessage = $msg } | ConvertTo-Json -Compress
exit 0
