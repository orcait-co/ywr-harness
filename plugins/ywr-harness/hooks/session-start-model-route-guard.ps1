# SessionStart (matcher `startup|resume|fork`) — old-model route guard, WARN-ONLY (ADR 0107).
#
# The org guide names worker models by family alias and keeps each alias on the newest model
# (ADR 0106). Three of the routes by which an alias lands on an older model are settings a member
# can read, and nothing in the harness read them at run time:
#   - an override: `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` replaces an alias target
#     (any value counts); `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_MODEL` / a settings `model` holding a
#     full id pins the session model, and a same-family worker runs on the session's exact model
#     (sub-agents doc); `CLAUDE_CODE_SUBAGENT_MODEL` (any value — the org guide sets none, and even an
#     alias moves every subagent and workflow agent that is not assigned a model another way to that
#     family) re-models those agents; a non-empty `modelOverrides` sends its own string for a picked
#     model.
#   - a cloud provider: `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,ANTHROPIC_AWS,MANTLE}` — the
#     model-config doc's "Resolution by provider" table resolves `sonnet` (and on Foundry `opus`)
#     to an older model there.
# Env-var names and meanings: the env-vars doc, read raw 2026-09-29. The two routes a hook cannot
# read stay the guide's: `--resume`/`--continue` keep the saved model, and an old Claude Code ships
# an old alias table. `--model <full id>` on the command line is invisible here too: the payload's
# `model` field is optional and the docs do not say whether it holds the alias or the resolved id.
#
# Sources read: this process's environment — a hook "inherits the parent environment" (hooks doc)
# and Claude Code "writes each `env` entry into the process environment" (env-vars doc), so a
# settings `env` value arrives here too — plus the user settings file (`$CLAUDE_CONFIG_DIR`, else
# `~/.claude`) and the project's `.claude/settings.json` / `.claude/settings.local.json`, whose
# `model`, `modelOverrides` and `env` keys are read directly. Managed settings are not read: the
# org payload sets none of these keys (checked when ADR 0106 was written), and its cache is not a
# documented read surface. A file that does not parse is skipped: validating settings is the
# host's job, and a guard that speaks on a parse error would nag about something else.
#
# Output contract (hooks doc, raw): `systemMessage` is shown to the member; nothing goes to the
# model's context, so an eval child that inherits an override (the runner forwards most
# `ANTHROPIC_*` and `CLAUDE_CODE_*` variables — measured for `ANTHROPIC_DEFAULT_OPUS_MODEL`,
# 2026-09-29) runs the same prompt it always did. Every non-speaking path is byte-silent: plain
# stdout on exit 0 would become session context. Exit 0 always — SessionStart blocks nothing.
# The matcher skips `clear` and `compact`: they run in the same process, whose environment has not
# changed, and repeating the note after each would be noise.
#
# `-Preflight` is the eval runner's refusal (spec 0014 §4.3): the environment half only — an eval
# child gets its own config dir, so no settings file of the operator's reaches it — printed as one
# line per finding, exit 1 when any is found, exit 0 with one "clear" line otherwise. One key list
# serves both callers, so the guard and the preflight cannot drift apart.
#
# Values render through Inline() and a length cap (C0, DEL, NEL, U+2028/U+2029, backtick — the
# agent-model-warn class), so a crafted value cannot forge a banner line. The prose cites no
# decision numbers: a member cannot follow a canon ADR from their own repo (spec 0006 §3.1).
param([switch]$Preflight)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

$familyKeys = [ordered]@{
    ANTHROPIC_DEFAULT_OPUS_MODEL = 'opus'; ANTHROPIC_DEFAULT_SONNET_MODEL = 'sonnet'
    ANTHROPIC_DEFAULT_HAIKU_MODEL = 'haiku'; ANTHROPIC_DEFAULT_FABLE_MODEL = 'fable'
}
$sessionKeys = @('ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL')
$subagentKey = 'CLAUDE_CODE_SUBAGENT_MODEL'
$providerKeys = @('CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE')
# The model-config doc's aliases, optionally with the `[1m]` suffix; anything else is a pinned id.
$aliasRx = '^(?i)(opus|sonnet|haiku|fable|opusplan|default|best)(\[1m\])?$'

function Inline([string]$Text, [int]$Max = 80) {
    $t = (([string]$Text) -replace '[\u0000-\u001F\u007F\u0085\u2028\u2029`]', ' ').Trim()
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max - 1) + '…' }
    return $t
}
function Test-On([string]$v) { $t = ([string]$v).Trim(); return ($t -and $t -notmatch '^(?i)(0|false|no|off)$') }

# One finding = @{ key; text (Korean, for the member); en (English, for -Preflight) }.
function Get-EnvFinding($Map, [string]$Where) {
    $out = @()
    foreach ($k in $familyKeys.Keys) {
        $v = [string]$Map[$k]
        if ($v.Trim()) {
            $s = Inline $v
            $out += @{ key = $k; text = "``$k=$s`` ($Where): ``$($familyKeys[$k])`` alias 가 이 모델로 바뀝니다"
                en = "$k=$s ($Where) replaces what the '$($familyKeys[$k])' alias resolves to" }
        }
    }
    foreach ($k in $sessionKeys) {
        $v = ([string]$Map[$k]).Trim()
        if ($v -and $v -notmatch $aliasRx) {
            $s = Inline $v
            $out += @{ key = $k; text = "``$k=$s`` ($Where): 세션 모델이 full id 로 고정됩니다 — 같은 계열 워커도 그 모델로 돕니다"
                en = "$k=$s ($Where) pins the session model to a full id; same-family workers run on it" }
        }
    }
    $v = ([string]$Map[$subagentKey]).Trim()
    if ($v) {
        $s = Inline $v
        $out += @{ key = $subagentKey; text = "``$subagentKey=$s`` ($Where): 모델이 지정되지 않은 서브에이전트·워크플로 에이전트가 모두 이 모델로 바뀝니다"
            en = "$subagentKey=$s ($Where) re-models every subagent and workflow agent without its own model" }
    }
    foreach ($k in $providerKeys) {
        if (Test-On ([string]$Map[$k])) {
            $out += @{ key = $k; text = "``$k`` ($Where): 이 provider 에서는 alias 가 최신이 아닌 모델로 해석될 수 있습니다"
                en = "$k ($Where) selects a provider on which an alias can resolve to an older model" }
        }
    }
    return $out
}

$procEnv = @{}
foreach ($k in @($familyKeys.Keys) + $sessionKeys + @($subagentKey) + $providerKeys) {
    $v = [Environment]::GetEnvironmentVariable($k)
    if ($null -ne $v) { $procEnv[$k] = $v }
}

if ($Preflight) {
    $found = @(Get-EnvFinding $procEnv 'this shell')
    if ($found.Count) {
        foreach ($f in $found) { "preflight: REFUSED — $($f.en)" }
        'preflight: unset the variable(s) above in this shell (the eval runner forwards them to every child), then re-run.'
        exit 1
    }
    'preflight: clear — no model-override or provider variable in this shell'
    exit 0
}

try { $payload = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { exit 0 }
if ($null -eq $payload -or [string]$payload.hook_event_name -ne 'SessionStart') { exit 0 }

$findings = @(Get-EnvFinding $procEnv '환경변수')
$seen = @{}
foreach ($f in $findings) { $seen[$f.key] = $true }

function Read-Settings([string]$Path) {
    try {
        $ErrorActionPreference = 'Stop'
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        return (Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json)
    }
    catch { return $null }
}

$userDir = ([string]$env:CLAUDE_CONFIG_DIR).Trim()
if (-not $userDir) {
    $h = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { $HOME }
    if ($h) { $userDir = Join-Path $h '.claude' }
}
$files = @()
if ($userDir) { $files += Join-Path $userDir 'settings.json' }
$proj = ([string]$env:CLAUDE_PROJECT_DIR).Trim()
if (-not $proj) { $proj = ([string]$payload.cwd).Trim() }
if ($proj) { $files += (Join-Path $proj '.claude/settings.json'), (Join-Path $proj '.claude/settings.local.json') }

foreach ($file in $files) {
    $j = Read-Settings $file
    if ($null -eq $j -or $j -isnot [System.Management.Automation.PSCustomObject]) { continue }
    $where = Inline $file 160
    $m = $j.model
    if ($m -is [string] -and $m.Trim() -and $m.Trim() -notmatch $aliasRx) {
        $findings += @{ key = "model@$file"; text = "``model: $(Inline $m)`` ($where): 세션 모델이 full id 로 고정됩니다 — 같은 계열 워커도 그 모델로 돕니다" }
    }
    $mo = $j.modelOverrides
    if ($mo -is [System.Management.Automation.PSCustomObject]) {
        $n = @($mo.PSObject.Properties).Count
        if ($n -gt 0) { $findings += @{ key = "modelOverrides@$file"; text = "``modelOverrides`` ${n}개 항목 ($where): 고른 모델 대신 이 설정의 문자열이 호출됩니다" } }
    }
    $e = $j.env
    if ($e -is [System.Management.Automation.PSCustomObject]) {
        $map = @{}
        foreach ($p in $e.PSObject.Properties) { if ($p.Value -is [string]) { $map[$p.Name] = $p.Value } }
        foreach ($f in (Get-EnvFinding $map "$where env")) {
            if (-not $seen[$f.key]) { $findings += $f; $seen[$f.key] = $true }
        }
    }
}

if (-not $findings.Count) { exit 0 }
$list = ($findings | ForEach-Object { $_.text }) -join '; '
$sys = "[hook:model-route] 모델 alias 가 최신이 아닌 모델로 갈 수 있는 설정이 있습니다: $list. " +
       '조직 가이드: 워커 모델은 family alias 로만 부르고 각 alias 는 최신 모델에 둡니다 — 의도한 설정이 아니면 값을 지우세요. ' +
       '이 훅은 안내만 하며 아무것도 바꾸거나 막지 않았습니다.'
@{ systemMessage = $sys } | ConvertTo-Json -Compress
exit 0
