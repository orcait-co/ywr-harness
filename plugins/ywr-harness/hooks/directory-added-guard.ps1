# DirectoryAdded (NO matcher — the matcher for this event filters on `source`, and a
# guard must not be bypassable by a future third source value) — mid-session
# working-directory registration guard (ADR #120).
#
# Visibility ONLY, by construction: DirectoryAdded carries no decision control and
# fires AFTER the sandbox/permission refresh, so the directory is already live when
# this runs. Blocking would need a permissions deny rule instead (deliberately not
# taken — ADR #120 Options).
#
# Payload, verified against the shipped 2.1.220 binary's zod schema (this event is
# absent from the official hooks reference's 30 documented events as of 2026-07-25;
# it is a v2.1.219 changelog entry):
#   directory : absolute path of the directory that was added
#   source    : "slash_command" (/add-dir) | "register_repo_root" (SDK control request)
# The runtime consumes ONLY `systemMessage` for this event (it maps hook results to
# .systemMessage and surfaces them as "DirectoryAdded hook: <text>"); `additionalContext`
# is not in this event's list, and a non-zero exit sends the message to the debug log.
# So: always exit 0 and speak through systemMessage.
#
# Anti-vacuity: a DirectoryAdded payload with no `directory` emits a SCHEMA-DRIFT
# banner listing the keys actually received, rather than failing open into silence.
# The sibling config-change-audit hook read an invented field name and was silently
# inert while its selftest stayed green (ADR #120) — a guard that cannot report its
# own drift is indistinguishable from an absent guard.
#
# Existence is not selection (ADR #120 review, medium): the two settings keys an added
# directory can contribute are PARSED for, not inferred from the settings file merely
# existing — a `.claude/settings.json` holding only hooks or permissions contributes
# nothing, and claiming otherwise would be the same existence-vs-selection confusion
# this slice exists to retire. An unparseable settings file is reported as unknown,
# never as absent (REVIEW.md #4).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
try { $payload = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { exit 0 }
if ([string]$payload.hook_event_name -ne 'DirectoryAdded') { exit 0 }

$dir = ([string]$payload.directory).Trim()
$src = ([string]$payload.source).Trim()
if (-not $src) { $src = '(source absent)' }

if (-not $dir) {
    $keys = '(none)'
    try { $k = @($payload.PSObject.Properties.Name | Sort-Object); if ($k) { $keys = $k -join ', ' } } catch { }
    $drift = "[hook:dir-added] SCHEMA DRIFT — DirectoryAdded 페이로드에 'directory' 필드가 없어, 이 가드가 작업 공간에 무엇이 추가되었는지 보고할 수 없습니다. 수신된 키: $keys. 페이로드 형식을 다시 확인하고 .claude/hooks/directory-added-guard.ps1을 수정하세요 (ADR #120)."
    @{ systemMessage = $drift } | ConvertTo-Json -Compress
    exit 0
}

# What the addition actually pulls in, per the official permissions reference table
# "Additional directories grant file access, not configuration" (4 rows, read 2026-07-25).
# Note the table's own caveat: these exceptions apply to --add-dir / /add-dir only,
# NOT to permissions.additionalDirectories, which grants file access and nothing else.
$loads = @()
$unparsed = @()
$instr = @()
$instrLocal = @()
try {
    # Join-Path/Test-Path raise NON-TERMINATING errors when $dir names a root that does
    # not exist on this platform (a Windows drive letter under Linux CI, a bogus drive
    # under Windows), so a bare try/catch never sees them and the wall of stderr lands
    # in the captured output — the CI failure on 48c264c. Promote them so the catch below
    # is the single exit for an unusable path. Same non-terminating class as the
    # Add-Content trap in ADR #111/#112.
    $ErrorActionPreference = 'Stop'
    if (Test-Path -LiteralPath (Join-Path $dir '.claude/skills')) {
        $loads += '.claude/skills의 스킬 (라이브 리로드 포함)'
    }
    if (Test-Path -LiteralPath (Join-Path $dir '.claude/agents')) {
        $loads += '.claude/agents의 서브에이전트 정의 — ADR #111/#112가 의존하는 model/effort 고정을 가릴 수 있음'
    }
    $keysFound = @()
    foreach ($s in @('.claude/settings.json', '.claude/settings.local.json')) {
        $sp = Join-Path $dir $s
        if (-not (Test-Path -LiteralPath $sp)) { continue }
        try {
            $cfg = Get-Content -LiteralPath $sp -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            $present = @($cfg.PSObject.Properties.Name)
            foreach ($k in @('enabledPlugins', 'extraKnownMarketplaces')) {
                if (($present -contains $k) -and ($keysFound -notcontains $k)) { $keysFound += $k }
            }
        }
        catch { $unparsed += $s }
    }
    if ($keysFound) { $loads += "$($keysFound -join ' + ') — 설정 파일에서 로드됨 (추가된 디렉터리가 기여할 수 있는 유일한 설정 키)" }

    # CLAUDE.local.md is listed apart because the reference gives it a SECOND
    # precondition the others do not have (ADR #120 review, low).
    foreach ($p in @('CLAUDE.md', '.claude/CLAUDE.md', '.claude/rules')) {
        if (Test-Path -LiteralPath (Join-Path $dir $p)) { $instr += $p }
    }
    if (Test-Path -LiteralPath (Join-Path $dir 'CLAUDE.local.md')) { $instrLocal += 'CLAUDE.local.md' }
}
catch { }

$mdEnvSet = [bool][string]$env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
$parts = @("[hook:dir-added] $dir 디렉터리가 이 세션의 작업 디렉터리로 추가되었습니다 (source: $src).")
$parts += "CLAUDE.md의 컨텍스트 격리 주장은 관례일 뿐 강제 사항이 아닙니다: 이 트리 하위의 파일은 이제부터 도구가 읽고 편집할 수 있으므로, 비즈니스·법률·재무 관련 맥락이 이 세션에 유입될 수 있습니다."
$parts += '이 저장소는 이를 전혀 게이트하지 않습니다 — 모든 훅과 git 훅은 경로를 CLAUDE_PROJECT_DIR 기준으로 해석하므로, ruff-on-edit, ADR append-only 가드, handoff 계약, pre-commit lint, pre-push secret scan 모두 추가된 트리에서의 수정을 건너뜁니다.'
if ($loads) { $parts += "여기서 로드된 설정: $($loads -join ' · ')." }
if ($unparsed) { $parts += "$($unparsed -join ', ')을(를) 파싱할 수 없어, enabledPlugins 또는 extraKnownMarketplaces 기여 여부는 UNKNOWN이며 부재로 단정할 수 없습니다." }
if ($instr) {
    $found = $instr -join ', '
    if ($mdEnvSet) { $parts += "지침 파일 존재 ($found), CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD도 설정됨 — 이 세션의 프롬프트에 MERGE됩니다." }
    else { $parts += "지침 파일 존재 ($found), 그러나 CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD가 설정되지 않아 파일로만 읽히고 프롬프트에는 합류하지 않습니다." }
}
if ($instrLocal) {
    if ($mdEnvSet) { $parts += 'CLAUDE.local.md가 존재하고 해당 환경 변수도 설정되어 있지만, `local` 설정 소스도 함께 활성화되어 있을 때만 병합됩니다 (기본값) — 다른 지침 파일보다 조건이 하나 더 있습니다.' }
    else { $parts += 'CLAUDE.local.md가 존재하지만 같은 이유(환경 변수 미설정)로 프롬프트에 합류하지 않습니다.' }
}
$parts += '의도한 것이 아니라면 /permissions로 되돌리세요.'
@{ systemMessage = ($parts -join ' ') } | ConvertTo-Json -Compress
exit 0
