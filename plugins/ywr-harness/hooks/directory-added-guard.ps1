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
    $drift = "[hook:dir-added] SCHEMA DRIFT — a DirectoryAdded payload arrived with no 'directory' field, so this guard could not report what was added to the workspace. Keys received: $keys. Re-verify the payload shape and fix .claude/hooks/directory-added-guard.ps1 (ADR #120)."
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
        $loads += 'skills from .claude/skills (with live reload)'
    }
    if (Test-Path -LiteralPath (Join-Path $dir '.claude/agents')) {
        $loads += 'subagent definitions from .claude/agents — these can shadow the model/effort pins ADR #111/#112 rely on'
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
    if ($keysFound) { $loads += "$($keysFound -join ' + ') from its settings files (the only settings keys an added directory contributes)" }

    # CLAUDE.local.md is listed apart because the reference gives it a SECOND
    # precondition the others do not have (ADR #120 review, low).
    foreach ($p in @('CLAUDE.md', '.claude/CLAUDE.md', '.claude/rules')) {
        if (Test-Path -LiteralPath (Join-Path $dir $p)) { $instr += $p }
    }
    if (Test-Path -LiteralPath (Join-Path $dir 'CLAUDE.local.md')) { $instrLocal += 'CLAUDE.local.md' }
}
catch { }

$mdEnvSet = [bool][string]$env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
$parts = @("[hook:dir-added] $dir is now a working directory of this session (source: $src).")
$parts += "CLAUDE.md's context-isolation claim is a convention, not an enforcement: files under this tree are readable and editable by tools from here on, so business, legal and finance context can enter this session."
$parts += 'This repo gates none of it — every hook and githook resolves its paths from CLAUDE_PROJECT_DIR, so ruff-on-edit, the ADR append-only guard, the handoff contract, pre-commit lint and the pre-push secret scan all skip edits made in the added tree.'
if ($loads) { $parts += "Configuration loaded from it: $($loads -join ' · ')." }
if ($unparsed) { $parts += "Could not parse $($unparsed -join ', '), so whether it contributes enabledPlugins or extraKnownMarketplaces is UNKNOWN, not absent." }
if ($instr) {
    $found = $instr -join ', '
    if ($mdEnvSet) { $parts += "Instruction files present ($found) and CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD is set — they MERGE into this session's prompt." }
    else { $parts += "Instruction files present ($found), but CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD is unset, so they stay readable as files only and do not join the prompt." }
}
if ($instrLocal) {
    if ($mdEnvSet) { $parts += 'CLAUDE.local.md is present and that env var is set, but it merges only while the `local` settings source is also enabled (the default) — one condition more than the other instruction files.' }
    else { $parts += 'CLAUDE.local.md is present and does not join the prompt either, for the same unset env var.' }
}
$parts += 'Undo with /permissions if this was not intended.'
@{ systemMessage = ($parts -join ' ') } | ConvertTo-Json -Compress
exit 0
