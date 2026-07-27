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
    $drift = "[hook:config-audit] SCHEMA DRIFT — a ConfigChange payload arrived with no 'source' field, so this audit could not report which config tier changed. Keys received: $keys. Re-verify the payload shape and fix .claude/hooks/config-change-audit.ps1 (ADR #120)."
    @{ systemMessage = $drift } | ConvertTo-Json -Compress
    exit 0
}

$where = ([string]$payload.file_path).Trim()
$msg = "[hook:config-audit] $src modified mid-session"
if ($where) { $msg += " ($where)" }
$msg += ' (most keys live-reload; model/outputStyle apply at next session start). House rule: permission/hook self-modification requires explicit user approval — if you did not direct this change, review it now (git diff the settings file).'
@{ systemMessage = $msg } | ConvertTo-Json -Compress
exit 0
