# SessionStart (registered WITHOUT a matcher — the state file is the filter: re-fires on
# resume/clear/compact/fork at the same version are byte-silent) — version-change announcement,
# announce-once-per-version (ADR 0030).
#
# ADR 0026 made updates land silently; ADR 0027's statusline segment shows THAT the version
# moved but not WHAT changed. This hook completes the pair: at the first session that actually
# RUNS a new version, it says so once — old → new, up to three bullets from the member
# release-notes canon (../CHANGELOG.md), and the onboarding artifact's release-notes tab — then
# records the version in a one-line user-scope state file and never speaks again for it.
#
# The version compared is the LOADED one (this script's own ../.claude-plugin/plugin.json), not
# the possibly-ahead on-disk install — disk-ahead-of-session is ADR 0027's statusline story, and
# announcing notes for code that is not running yet would be false.
#
# State: <home>/.claude/ywr-harness/announced-version. <home> is USERPROFILE then HOME — the
# os.homedir() semantics the statusline script uses, and env-derived deliberately so a child
# process with a redirected home is a hermetic selftest fixture (the statusline suite documents
# the same reason). This is the plugin's FIRST user-scope write; it is bounded to this one file
# and the selftest asserts the confinement. Announce-once is impossible without state, and a
# stateless per-session notice is the nag class ADR 0029 already rejected.
#
# systemMessage is KOREAN — since ADR 0045 this is the plugin-wide rule, not a per-hook
# divergence: every hook's systemMessage is Korean (the member reader), every additionalContext
# stays English (the model reader). This hook was simply first (ADR 0030); the sibling hooks now
# carry the same split.
#
# Decision table (ADR 0030, absent-state row amended by ADR 0031): own manifest unreadable ->
# reported (a plugin that cannot read its own manifest is broken — visible, never silent). No
# resolvable home -> silent (announce-once needs state; a per-session fallback is the rejected
# nag; the statusline still shows the version). State path truly ABSENT -> first run: seed, and
# when the seed actually recorded, a LINK-ONLY welcome (no bullets, no version arrow, never
# "업데이트됨" — the message must be true for a fresh install AND the mechanism's first arrival,
# which is the whole 0031 point); a failed seed stays byte-silent — a welcome that cannot be
# recorded would repeat every session (the 0029 nag class) while carrying no news the dist
# README lacks. State exists-but-unreadable / newer-than-current -> (re)seed silently ("first
# run" would be a guess; a downgrade is the member's own act). State == current -> silent.
# State < current -> announce, then write; a failed write announces anyway with a visible
# may-repeat note. Non-speaking paths are BYTE-silent because plain stdout on exit 0 becomes
# session context. Exit 0 always — SessionStart cannot block anything and this hook does not try.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
try { $payload = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { exit 0 }
if ([string]$payload.hook_event_name -ne 'SessionStart') { exit 0 }

# One link, two shipped surfaces: this constant and the CHANGELOG header. manifest-gate.ps1
# asserts the two agree, so neither can drift alone.
$rnUrl = 'https://claude.ai/code/artifact/fec5c994-af2f-4e71-9e33-b03acc8cc1f7#rn'

# --- own version (the loaded one) -------------------------------------------------------------
$manifestPath = Join-Path $PSScriptRoot '../.claude-plugin/plugin.json'
$currentRaw = ''
try { $currentRaw = ([string](Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json).version).Trim() } catch { }
# The numeric triple is what gets compared; the raw string is what gets displayed and stored.
# manifest-gate anchors only the FRONT of the version shape, so a suffix must not break this.
$current = $null
if ($currentRaw -match '^(\d+)\.(\d+)\.(\d+)') { $current = [version]$Matches[0] }
if (-not $current) {
    @{ systemMessage = "[hook:version-announce] 이 플러그인 자체의 .claude-plugin/plugin.json을 버전으로 읽을 수 없습니다 (받은 값: '$currentRaw') — $(Split-Path $PSScriptRoot -Parent) 의 설치가 손상되었습니다; 버전 안내는 OFF이며 확인되지 않았습니다." } | ConvertTo-Json -Compress
    exit 0
}

# --- state ------------------------------------------------------------------------------------
$homeDir = [string]$env:USERPROFILE
if (-not $homeDir) { $homeDir = [string]$env:HOME }
if (-not $homeDir) { exit 0 }
$stateDir = Join-Path (Join-Path $homeDir '.claude') 'ywr-harness'
$stateFile = Join-Path $stateDir 'announced-version'

function Write-State([string]$Value) {
    try {
        $ErrorActionPreference = 'Stop'
        if (-not (Test-Path -LiteralPath $stateDir -PathType Container)) {
            New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
        }
        Set-Content -LiteralPath $stateFile -Value $Value -NoNewline -Encoding utf8
        return $true
    }
    catch { return $false }
}

# ABSENT is a first run; anything else keeps its ADR 0030 behavior (0031 amends only that row).
# Test-Path without -PathType on purpose: a DIRECTORY squatting on the path counts as "exists" —
# welcoming a squatted path would guess "first run" about a machine that already ran. A probe
# error also counts as "exists": when in doubt, do not welcome. Per-call -ErrorAction, NOT a
# $ErrorActionPreference assignment: at script scope try/catch does not confine a preference
# variable, so the first draft silently promoted the REST of the hook to Stop semantics —
# any later unguarded non-terminating error would have aborted past "exit 0 always"
# (review 2026-08-05, medium; Write-State survives the same pattern only because a function
# body scopes it).
$stateExists = $true
try { $stateExists = [bool](Test-Path -LiteralPath $stateFile -ErrorAction Stop) } catch { $stateExists = $true }
$storedRaw = ''
try { $storedRaw = ([string](Get-Content -LiteralPath $stateFile -Raw -ErrorAction Stop)).Trim() } catch { }
$stored = $null
if ($storedRaw -match '^v?(\d+)\.(\d+)\.(\d+)') { $stored = [version]($Matches[0] -replace '^v', '') }

if (-not $stored -and -not $stateExists) {
    # First run on this machine — fresh install, or the first version carrying this mechanism;
    # indistinguishable, and the message below is TRUE in both states (ADR 0031). Write-then-
    # speak, inverted from the update path on purpose: the update announcement protects news,
    # this protects nothing the dist README does not already carry, so a failed seed is silent.
    if (Write-State $currentRaw) {
        $sys = "[hook:version-announce] ywr-harness v$currentRaw 적용 중 — 이 머신의 첫 버전 안내입니다(설치 직후이거나, 안내 기능이 이번 버전에서 처음 도착했습니다). 전체 변경 이력: $rnUrl (claude.ai Team 좌석 로그인 필요)"
        $ctx = "The ywr-harness plugin v$currentRaw is active, and this is its first recorded run on this machine — fresh install, or the first version carrying the announce mechanism (ADR 0031). Release notes: the plugin's CHANGELOG.md (Korean, newest-first) and the artifact release-notes tab at $rnUrl. This welcome appears once per machine; do not repeat it unprompted."
        @{
            systemMessage      = $sys
            hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $ctx }
        } | ConvertTo-Json -Compress
    }
    exit 0
}
if (-not $stored -or $stored -gt $current) {
    # Exists-but-unreadable state, or a downgrade: (re)seed and say nothing (ADR 0030 rows,
    # unchanged) — the next session simply retries.
    Write-State $currentRaw | Out-Null
    exit 0
}
if ($stored -eq $current) { exit 0 }

# --- stored < current: the announcement -------------------------------------------------------
# Bullets for the CURRENT version from the member canon. Continuation lines are joined so a
# wrapped bullet reads whole; the cap is VISIBLE (외 N건) — a silent truncation would read as
# "that was everything" (the no-silent-caps house rule).
$bullets = @()
try {
    $lines = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../CHANGELOG.md') -Encoding utf8 -ErrorAction Stop
    $inSection = $false
    foreach ($line in $lines) {
        if ($line -match '^##\s') {
            if ($inSection) { break }
            # Token EQUALITY against the raw manifest version first — the same comparison the
            # gate enforces — with the numeric triple as fallback. The first draft matched
            # '^## v<triple>\b', and \b needs a word/non-word transition: a non-hyphenated
            # suffix ('0.18.0rc1') passed the gate yet failed the lookup, degrading the
            # announcement to bullet-less for an entry that exists (review 2026-08-05, low).
            if ($line -match '^##\s+v(\S+)') {
                $tok = $Matches[1]
                $inSection = ($tok -eq $currentRaw) -or ($tok -eq $current.ToString())
            }
            continue
        }
        if (-not $inSection) { continue }
        if ($line -match '^- (.+)$') { $bullets += ,($Matches[1].Trim()) }
        elseif ($line -match '^\s+(\S.*)$' -and $bullets.Count) { $bullets[-1] += ' ' + $Matches[1].Trim() }
    }
}
catch { }

# systemMessage is a plain-text surface, not a Markdown renderer: the two inline forms the
# canon actually uses — `code` and **bold** — are stripped for display, or the member reads
# literal backticks and asterisks (review 2026-08-05, medium). The CHANGELOG itself stays
# Markdown; only this rendering flattens it.
$shown = @($bullets | Select-Object -First 3 | ForEach-Object {
        ($_ -replace '\*\*(.+?)\*\*', '$1') -replace '`([^`]*)`', '$1'
    })
$more = $bullets.Count - $shown.Count
$body = "[hook:version-announce] ywr-harness v$storedRaw → v$currentRaw 업데이트됨 (자동 업데이트)."
if ($shown.Count) {
    $body += " 주요 변경:`n" + (($shown | ForEach-Object { "  • $_" }) -join "`n")
    # ${more} braced on purpose: Korean letters are legal in a variable name, so "$more건"
    # would interpolate an undefined variable named more건 as empty (caught by the selftest).
    if ($more -gt 0) { $body += "`n  • …외 ${more}건 — 전체는 릴리스 노트 탭에서." }
    $body += "`n"
}
else { $body += ' ' }
$body += "전체 릴리스 노트: $rnUrl (claude.ai Team 좌석 로그인 필요)"

if (-not (Write-State $currentRaw)) {
    $body += "`n(안내 기록 실패: $stateFile 에 쓸 수 없어 이 안내가 반복될 수 있습니다 — ~/.claude 권한을 확인하세요.)"
}

$ctx = "The ywr-harness plugin loaded in this session is v$currentRaw; the last version announced on this machine was v$storedRaw (marketplace auto-update, ADR 0026 — updates land at session start, never mid-session). Member release notes: the plugin's CHANGELOG.md (Korean, newest-first) and the onboarding artifact's release-notes tab at $rnUrl. If the user asks what changed, read the CHANGELOG entry for v$currentRaw rather than answering from memory. This announcement is once-per-version (ADR 0030); do not repeat it unprompted."
@{
    systemMessage      = $body
    hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $ctx }
} | ConvertTo-Json -Compress
exit 0
