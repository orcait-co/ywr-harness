# DirectoryAdded (NO matcher — the matcher for this event filters on `source`, and a
# guard must not be bypassable by a future third source value) — mid-session
# working-directory registration guard.
#
# Visibility ONLY, by construction: DirectoryAdded carries no decision control and
# fires AFTER the sandbox/permission refresh, so the directory is already live when
# this runs. Blocking would need a permissions deny rule instead (deliberately not
# taken).
#
# Payload (hooks reference "DirectoryAdded input", re-read raw 2026-09-27 on 2.1.283; first
# read out of the 2.1.220 binary's zod schema before the event was documented):
#   directory : absolute path of the directory that was added
#   source    : "slash_command" (/add-dir) | "register_repo_root" (SDK control request)
#
# THE READER IS CLAUDE, NOT THE PERSON (ADR 0097). Per the reference, a `slash_command`
# systemMessage is delivered "to Claude as context on the next conversation turn, rather than
# showing it to you", and a `register_repo_root` one goes to the debug log only. So the banner
# is English (ADR 0045's reader rule, narrowed by ADR 0097), states what the model should do,
# and asks it to relay one sentence to the user. The hook runs in the background after the add
# has completed; a failed hook shows only as a failure COUNT in the transcript (/add-dir) or not at
# all (register_repo_root), its output going to the debug log — so always exit 0.
#
# Anti-vacuity: a DirectoryAdded payload with no `directory` emits a SCHEMA-DRIFT
# banner listing the keys actually received, rather than failing open into silence.
# The sibling config-change-audit hook read an invented field name and was silently
# inert while its selftest stayed green — a guard that cannot report its
# own drift is indistinguishable from an absent guard.
#
# Existence is not selection (review finding, medium): the two settings keys an added
# directory can contribute are PARSED for, not inferred from the settings file merely
# existing — a `.claude/settings.json` holding only hooks or permissions contributes
# nothing, and claiming otherwise would be the same existence-vs-selection confusion
# this slice exists to retire. An unparseable settings file is reported as unknown,
# never as absent (REVIEW.md #4).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
try { $payload = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { exit 0 }
if ([string]$payload.hook_event_name -ne 'DirectoryAdded') { exit 0 }

# Payload-authored text is echoed through Inline() — the class agent-model-warn.ps1 uses (C0, DEL,
# U+0085 NEL, U+2028/U+2029 and the backtick become a space, then a hard cap) — so a hostile value
# cannot forge a second `[hook:*]` line in the banner the model reads.
function Inline([string]$Text, [int]$Max = 80) {
    $t = (([string]$Text) -replace '[\u0000-\u001F\u007F\u0085\u2028\u2029`]', ' ').Trim()
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max - 1) + '…' }
    return $t
}

# The raw directory drives the filesystem checks; drift is judged on what the banner would echo
# (a value of only control bytes or backticks survives Trim() but echoes as nothing), and a
# non-string `directory` is a shape change — both are drift.
$dir = if ($payload.directory -is [string]) { $payload.directory.Trim() } else { '' }
# A `source` that is present but not a string is named as such, never folded into 'absent'.
$src = if ($payload.source -is [string]) { Inline $payload.source } else { '' }
if (-not $src) { $src = if ($null -ne $payload.source) { '(source not a string)' } else { '(source absent)' } }

if (-not (Inline $dir)) {
    $keys = '(none)'
    try { $k = @($payload.PSObject.Properties.Name | Sort-Object); if ($k) { $keys = Inline ($k -join ', ') 300 } } catch { }
    $drift = "[hook:dir-added] SCHEMA DRIFT — the DirectoryAdded payload's 'directory' field is missing, empty or not a string, so this guard cannot report which directory was added to the session. Keys received: $keys. The hooks reference's DirectoryAdded input may have changed. In your next reply, tell the user in one sentence, in their language, that this is a ywr-harness plugin defect to report with /ywr-harness:feedback."
    @{ systemMessage = $drift } | ConvertTo-Json -Compress
    exit 0
}

# What the addition actually pulls in, per the official permissions reference table
# "Additional directories grant file access, not configuration" (5 rows, re-read 2026-09-27;
# the `.claude/commands` row was absent from the 2026-07-25 read). Note the table's own caveat:
# these exceptions apply to --add-dir / /add-dir only, NOT to permissions.additionalDirectories,
# which grants file access and nothing else.
$loads = @()
$unparsed = @()
$instr = @()
$instrLocal = @()
$eapSaved = $ErrorActionPreference
try {
    # Join-Path/Test-Path raise NON-TERMINATING errors when $dir names a root that does
    # not exist on this platform (a Windows drive letter under Linux CI, a bogus drive
    # under Windows), so a bare try/catch never sees them and the wall of stderr lands
    # in the captured output — the CI failure on 48c264c. Promote them so the catch below
    # is the single exit for an unusable path. Same non-terminating class as a failed
    # Add-Content write.
    $ErrorActionPreference = 'Stop'
    if (Test-Path -LiteralPath (Join-Path $dir '.claude/skills')) {
        $loads += 'skills from .claude/skills (live reload)'
    }
    if (Test-Path -LiteralPath (Join-Path $dir '.claude/commands')) {
        $loads += 'command files from .claude/commands (no live reload; a same-named command of this project wins)'
    }
    if (Test-Path -LiteralPath (Join-Path $dir '.claude/agents')) {
        $loads += 'subagent definitions from .claude/agents — they answer bare names, so a spawn naming worker instead of ywr-harness:worker gets that tree''s model/effort, not the harness pin'
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
    if ($keysFound) { $loads += "$($keysFound -join ' + ') from its settings (the only settings keys an added directory contributes)" }

    # CLAUDE.local.md is listed apart because the reference gives it a SECOND
    # precondition the others do not have (review finding, low).
    foreach ($p in @('CLAUDE.md', '.claude/CLAUDE.md', '.claude/rules')) {
        if (Test-Path -LiteralPath (Join-Path $dir $p)) { $instr += $p }
    }
    if (Test-Path -LiteralPath (Join-Path $dir 'CLAUDE.local.md')) { $instrLocal += 'CLAUDE.local.md' }
}
catch { }
# Stop is for the probes above only; the banner assembly below must not inherit it.
finally { $ErrorActionPreference = $eapSaved }

# The permissions reference gates the merge on `=1`. Any other value reads as unset: telling the model
# files are NOT in context when they are costs one extra read; the reverse leaves it without them.
$mdEnvSet = ([string]$env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).Trim() -eq '1'
$parts = @("[hook:dir-added] $(Inline $dir 300) was added as a working directory of this session (source: $src).")
$parts += 'Files under it are now readable and editable by your tools; a context-isolation rule stated in any CLAUDE.md is convention, not enforcement, so do not carry content from that tree into this project unless the user asks.'
$parts += 'Do not assume this project''s gates cover it: its git hooks never run for a commit in the added tree (that repository''s own hooks do), and its Claude Code hooks still fire on your tool calls there but may skip or misjudge paths outside CLAUDE_PROJECT_DIR — run that tree''s own checks when you change files there.'
if ($loads) { $parts += "Loaded from it: $($loads -join ' · ')." }
if ($unparsed) { $parts += "$($unparsed -join ', ') could not be parsed, so whether it contributes enabledPlugins or extraKnownMarketplaces is UNKNOWN, not absent." }
if ($instr) {
    $found = $instr -join ', '
    if ($mdEnvSet) { $parts += "Instruction files present ($found) and CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 — they MERGE into this session's prompt." }
    else { $parts += "Instruction files present ($found), but CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD is not 1, so they are NOT in your context — read them before working in that tree." }
}
if ($instrLocal) {
    if ($mdEnvSet) { $parts += 'CLAUDE.local.md is present and the env var is 1, but it merges only while the ''local'' setting source is also enabled (the default) — one precondition more than the other instruction files.' }
    else { $parts += 'CLAUDE.local.md is present and, for the same reason (env var not 1), NOT in your context.' }
}
$parts += 'In your next reply, tell the user in one sentence, in their language, that this directory was added and that this project''s checks may not cover edits there; if they did not mean to add it, /permissions removes it.'
@{ systemMessage = ($parts -join ' ') } | ConvertTo-Json -Compress
exit 0
