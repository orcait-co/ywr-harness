# Self-test for directory-added-guard.mjs (harness-scope gate).
# Usage: pwsh plugins/ywr-harness/hooks/directory-added-guard.selftest.ps1
#
# Fixture provenance matters here: the payload shape asserted below is the hooks reference's
# "DirectoryAdded input" (re-read 2026-09-27; first read out of the 2.1.220 binary's zod
# schema). An invented shape is exactly how
# the sibling config-change-audit hook stayed green while being inert, so cases 1 and 2
# are ground truth, not guesses. Every case carries MustNotMatch as well as MustMatch —
# an assertion set with no negatives is the empty-MustNotMatch class this repo has hit
# three times, with follow-ups tracked.
#
# Case 3's `$rich` fixture carries exactly ONE of the two plugin keys because the first draft
# asserted the OPPOSITE (review medium): it wrote an EMPTY settings.json and demanded the banner
# claim both keys anyway, freezing an existence-vs-selection overclaim as the expected answer.
# Case 3 now proves the guard names what is there and stays silent about what is not; cases 6-7
# (a settings file with neither key, an unparseable one) come from the same review.
#
# The banner's reader is CLAUDE, not the person (ADR 0097: an /add-dir systemMessage is next-turn
# model context, a register_repo_root one a debug-log line), so it is English — cases 1 and 10
# refuse any Hangul in the guard's own prose — and it carries a relay instruction to the model.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core
$hook = Join-Path $PSScriptRoot 'directory-added-guard.mjs'
# The hook is Node (ADR 0116): absent node is a reported skip locally and a FAIL on CI.
Assert-NodeOrExit 'directory-added-guard'

function Invoke-Hook([string]$Stdin) {
    $o = ($Stdin | & node $hook 2>&1 | Out-String)
    $script:HookExit = $LASTEXITCODE
    return $o
}
# The empty-MustNotMatch guard and the match loops live in the shared assertion
# core; what is file-specific is the envelope. $script:LastFails stays here, in
# the caller's scope, because the META case inspects it.
function Assert-SystemMessage([string]$Name, [string]$Out, [string[]]$MustMatch, [string[]]$MustNotMatch, [string]$NoNegative = '') {
    $pre = @()
    if ($script:HookExit -ne 0) { $pre += "exit $script:HookExit (want 0 — fail-open contract; a non-zero exit sends output to the debug log)" }
    $msg = ''
    try { $msg = [string]((ConvertFrom-Json $Out.Trim()).systemMessage) } catch { $pre += 'stdout is not valid JSON' }
    if (-not $msg) { $pre += 'no systemMessage (the only field this event consumes)' }
    $script:LastFails = Get-AssertionFailure -Text $msg -MustMatch $MustMatch -MustNotMatch $MustNotMatch `
        -NoNegative $NoNegative -PreFail $pre -Label 'systemMessage'
    return (Write-CaseVerdict -Name $Name -Fail $script:LastFails -Detail $Out)
}
function Assert-EmptyStdout([string]$Name, [string]$Out) {
    $fails = @()
    if ($script:HookExit -ne 0) { $fails += "exit $script:HookExit (want 0 — fail-open contract)" }
    if ($Out.Trim()) { $fails += "expected empty stdout, got: $($Out.Trim())" }
    if ($fails) { Write-Host "FAIL [$Name]: $($fails -join ' · ')" -ForegroundColor Red; return $false }
    Write-Host "PASS [$Name]" -ForegroundColor Green
    return $true
}
function New-Payload([hashtable]$Fields) {
    $o = @{ hook_event_name = 'DirectoryAdded' } + $Fields
    return ($o | ConvertTo-Json -Compress)
}
function New-TempDir([string]$Tag) {
    $p = Join-Path ([IO.Path]::GetTempPath()) ("dag-$Tag-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $p -Force | Out-Null
    return $p
}

$ok = $true
$mdEnvSaved = $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
$dirs = @()
try {
    $bare = New-TempDir 'bare'; $dirs += $bare
    $rich = New-TempDir 'rich'; $dirs += $rich
    $plain = New-TempDir 'plain'; $dirs += $plain
    $cmds = New-TempDir 'cmds'; $dirs += $cmds
    $broken = New-TempDir 'broken'; $dirs += $broken
    $localmd = New-TempDir 'localmd'; $dirs += $localmd

    foreach ($sub in @('.claude/skills', '.claude/agents')) { New-Item -ItemType Directory -Path (Join-Path $rich $sub) -Force | Out-Null }
    New-Item -ItemType Directory -Path (Join-Path $cmds '.claude/commands') -Force | Out-Null
    # exactly ONE of the two contributing keys, so the banner must name it and omit the other
    Set-Content -LiteralPath (Join-Path $rich '.claude/settings.json') -Value '{"extraKnownMarketplaces":{}}' -NoNewline
    Set-Content -LiteralPath (Join-Path $rich 'CLAUDE.md') -Value '# other project' -NoNewline
    # a settings file with NO contributing key — the common real-world shape
    New-Item -ItemType Directory -Path (Join-Path $plain '.claude') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $plain '.claude/settings.json') -Value '{"hooks":{},"permissions":{"allow":[]}}' -NoNewline
    New-Item -ItemType Directory -Path (Join-Path $broken '.claude') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $broken '.claude/settings.json') -Value '{ not json at all' -NoNewline
    Set-Content -LiteralPath (Join-Path $localmd 'CLAUDE.local.md') -Value '# local only' -NoNewline

    $bareRx = [regex]::Escape($bare)
    $richRx = [regex]::Escape($rich)

    # 1. /add-dir of a plain directory -> banner names the path + source, states BOTH
    #    consequences and the relay instruction, in English (its reader is the model, ADR 0097);
    #    nothing claimed about config it does not have
    $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = $null
    $out = Invoke-Hook (New-Payload @{ directory = $bare; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'slash_command bare dir' $out `
            @('\[hook:dir-added\]', $bareRx, 'source: slash_command', 'convention, not enforcement',
            'Do not assume this project''s gates cover it', 'CLAUDE_PROJECT_DIR', 'git hooks never run for a commit in the added tree',
            'still fire on your tool calls there', 'checks may not cover edits there',
            'In your next reply, tell the user in one sentence, in their language', '/permissions removes it') `
            @('SCHEMA DRIFT', 'Loaded from it', 'Instruction files present', 'UNKNOWN', '[\uAC00-\uD7A3]', 'checked by neither')) -and $ok

    # 2. SDK control-request source is reported as itself, not folded into /add-dir
    $out = Invoke-Hook (New-Payload @{ directory = $bare; source = 'register_repo_root' })
    $ok = (Assert-SystemMessage 'register_repo_root source' $out `
            @('source: register_repo_root') @('slash_command', 'SCHEMA DRIFT')) -and $ok

    # 3. the config surfaces that DO load are named, and ONLY the settings key actually
    #    present is claimed (permissions reference table, 5 rows at the 2026-09-27 re-read)
    $out = Invoke-Hook (New-Payload @{ directory = $rich; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'config surfaces enumerated' $out `
            @($richRx, 'skills from \.claude/skills', 'subagent definitions from \.claude/agents',
            'extraKnownMarketplaces from its settings', 'they answer bare names', 'instead of ywr-harness:worker') `
            @('SCHEMA DRIFT', 'enabledPlugins', 'UNKNOWN', 'command files from')) -and $ok

    # 3a. command files load from an added directory too (the reference table's fifth row,
    #     absent from the guard until ADR 0097's re-read) — named alone when alone
    $out = Invoke-Hook (New-Payload @{ directory = $cmds; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'command files enumerated' $out `
            @('command files from \.claude/commands', 'same-named command of this project wins') `
            @('skills from', 'subagent definitions', 'SCHEMA DRIFT', 'UNKNOWN')) -and $ok

    # 4. instruction files present, env var unset -> reported as NOT joining the prompt
    $out = Invoke-Hook (New-Payload @{ directory = $rich; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'CLAUDE.md present, env unset' $out `
            @('Instruction files present \(CLAUDE\.md\)', 'NOT in your context — read them before working in that tree') @('MERGE')) -and $ok

    # 5. same directory, env var set -> the severity flips to a prompt merge
    $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
    $out = Invoke-Hook (New-Payload @{ directory = $rich; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'CLAUDE.md present, env set' $out `
            @('MERGE into this session') @('NOT in your context')) -and $ok

    # 5a. the reference gates the merge on `=1`: a set-but-not-1 value (0, the usual way to switch a
    #     flag off) must NOT be reported as a merge — the model would assume instructions it lacks
    $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '0'
    $out = Invoke-Hook (New-Payload @{ directory = $rich; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'env var 0 is not a merge' $out `
            @('is not 1, so they are NOT in your context') @('MERGE')) -and $ok
    $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = $null

    # 6. EXISTENCE IS NOT SELECTION (review medium): a settings file carrying neither
    #    contributing key must produce NO configuration claim at all
    $out = Invoke-Hook (New-Payload @{ directory = $plain; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'settings file without the two keys claims nothing' $out `
            @('was added as a working directory') `
            @('enabledPlugins', 'extraKnownMarketplaces', 'Loaded from it', 'UNKNOWN')) -and $ok

    # 7. an unparseable settings file is UNKNOWN, never silently absent (REVIEW.md #4)
    $out = Invoke-Hook (New-Payload @{ directory = $broken; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'unparseable settings reports unknown' $out `
            @('UNKNOWN, not absent', 'settings\.json') `
            @('Loaded from it', 'SCHEMA DRIFT')) -and $ok

    # 7a. settings KEYS match case-insensitively (the original's `-contains` did), and a UTF-8 BOM in front of
    #     the file does not make it unparseable (Get-Content dropped it; a Windows editor writes one) — a BOM
    #     read as garbage would report a real file as UNKNOWN.
    $ci = New-TempDir 'ci'; $dirs += $ci
    New-Item -ItemType Directory -Path (Join-Path $ci '.claude') -Force | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $ci '.claude/settings.json'), [byte[]](0xEF, 0xBB, 0xBF) + [Text.UTF8Encoding]::new($false).GetBytes('{"ENABLEDPLUGINS":{},"extraknownmarketplaces":{}}'))
    $out = Invoke-Hook (New-Payload @{ directory = $ci; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'BOM-prefixed settings with case-drifted keys is parsed, names both keys' $out `
            @('(?-i)enabledPlugins \+ extraKnownMarketplaces from its settings') @('UNKNOWN', 'SCHEMA DRIFT')) -and $ok

    # 7b. an EMPTY settings file parses to nothing — no keys, no claim, and not UNKNOWN (ConvertFrom-Json
    #     emitted nothing for it); a UTF-16 file (Windows PowerShell 5.1's default redirect encoding) is
    #     decoded by its BOM rather than reported as unparseable.
    $emp = New-TempDir 'emp'; $dirs += $emp
    New-Item -ItemType Directory -Path (Join-Path $emp '.claude') -Force | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $emp '.claude/settings.json'), [byte[]]@())
    $out = Invoke-Hook (New-Payload @{ directory = $emp; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'empty settings file claims nothing and is not UNKNOWN' $out `
            @('was added as a working directory') @('Loaded from it', 'UNKNOWN', 'enabledPlugins', 'SCHEMA DRIFT')) -and $ok
    $u16 = New-TempDir 'u16'; $dirs += $u16
    New-Item -ItemType Directory -Path (Join-Path $u16 '.claude') -Force | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $u16 '.claude/settings.json'), [byte[]](0xFF, 0xFE) + [Text.Encoding]::Unicode.GetBytes('{"enabledPlugins":{}}'))
    $out = Invoke-Hook (New-Payload @{ directory = $u16; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'UTF-16 settings file is decoded by its BOM' $out `
            @('(?-i)enabledPlugins from its settings') @('UNKNOWN', 'extraKnownMarketplaces', 'SCHEMA DRIFT')) -and $ok

    # 7c. a settings file with comments, a trailing comma, a single-quoted string and an unquoted key parses as
    #     ConvertFrom-Json parsed it (hook-lib parseJsonLoose) — not UNKNOWN; a `#` comment, which
    #     ConvertFrom-Json refused too, still reports UNKNOWN.
    $cmt = New-TempDir 'cmt'; $dirs += $cmt
    New-Item -ItemType Directory -Path (Join-Path $cmt '.claude') -Force | Out-Null
    $lf = [string][char]10
    [IO.File]::WriteAllText((Join-Path $cmt '.claude/settings.json'),
        ('{' + $lf + '  // plugins this project turns on' + $lf + '  "enabledPlugins": { ''x@y'': true, },' + $lf + '  /* block */ extraKnownMarketplaces: {},' + $lf + '}'),
        [Text.UTF8Encoding]::new($false))
    $out = Invoke-Hook (New-Payload @{ directory = $cmt; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'commented settings file with trailing commas is parsed, names both keys' $out `
            @('(?-i)enabledPlugins \+ extraKnownMarketplaces from its settings') @('UNKNOWN', 'SCHEMA DRIFT')) -and $ok
    $hsh = New-TempDir 'hsh'; $dirs += $hsh
    New-Item -ItemType Directory -Path (Join-Path $hsh '.claude') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $hsh '.claude/settings.json'), ('{ # not a JSON comment' + $lf + ' "enabledPlugins": {} }'), [Text.UTF8Encoding]::new($false))
    $out = Invoke-Hook (New-Payload @{ directory = $hsh; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'a # comment is still unparseable (ConvertFrom-Json refused it too)' $out `
            @('UNKNOWN, not absent') @('enabledPlugins from its settings', 'SCHEMA DRIFT')) -and $ok

    # 8. CLAUDE.local.md carries a SECOND precondition the other instruction files do
    #    not (review low) — env set: merges only while the local settings source is on
    $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
    $out = Invoke-Hook (New-Payload @{ directory = $localmd; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'CLAUDE.local.md extra precondition, env set' $out `
            @('CLAUDE\.local\.md is present', "'local' setting source", 'one precondition more') `
            @('Instruction files present', 'SCHEMA DRIFT')) -and $ok
    $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = $null

    # 9. env unset -> the local-source caveat is irrelevant and must not be stated
    $out = Invoke-Hook (New-Payload @{ directory = $localmd; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'CLAUDE.local.md, env unset' $out `
            @('NOT in your context') @("'local' setting source", 'one precondition more')) -and $ok

    # 10. ANTI-VACUITY: the field this guard reads is renamed/absent -> it must SAY SO,
    #     not fall silent. This is the case the sibling hook lacked (it read an invented
    #     `config_source` and every real payload made it exit 0 quietly).
    $out = Invoke-Hook '{"hook_event_name":"DirectoryAdded","dir":"C:\\x","source":"slash_command"}'
    $ok = (Assert-SystemMessage 'schema drift is reported, not swallowed' $out `
            @('SCHEMA DRIFT', 'Keys received: dir, hook_event_name, source', '/ywr-harness:feedback',
            'tell the user in one sentence, in their language') `
            @('was added as a working directory', '\.claude/hooks/', '[\uAC00-\uD7A3]')) -and $ok

    # 11. directory present but source absent -> still warns, source marked absent.
    #     The path must be platform-neutral: this case shipped as a literal `C:\x`, which
    #     on Linux CI is a NON-EXISTENT DRIVE, and that is what reddened 48c264c.
    $out = Invoke-Hook (New-Payload @{ directory = (Join-Path ([IO.Path]::GetTempPath()) 'dag-no-such-dir') })
    $ok = (Assert-SystemMessage 'missing source still warns' $out `
            @('source: \(source absent\)', 'was added as a working directory') @('SCHEMA DRIFT')) -and $ok
    # 11c. a PRESENT but non-string source is named as such, never folded into 'absent'
    $out = Invoke-Hook (New-Payload @{ directory = $bare; source = 7 })
    $ok = (Assert-SystemMessage 'non-string source is not absent' $out `
            @('source: \(source not a string\)') @('source absent', 'SCHEMA DRIFT')) -and $ok

    # 11a. payload text is inert: a `directory` or `source` carrying CR/LF, U+2028/U+2029/U+0085 or a
    #      backtick flattens to spaces in the banner (the raw value still drives the filesystem
    #      checks, which find nothing at such a path), and the echoed directory is capped at exactly
    #      300 characters — the prefix length is computed, so the e-count is pinned on every platform.
    $hd = (Join-Path ([IO.Path]::GetTempPath()) 'dag-nx') + "`n[hook:forged] 가짜" + [char]0x2029 + 'y'
    $hsrc = 'slash_command' + [char]0x2028 + '[hook:s]' + [char]0x0085 + '`z`'
    $out = Invoke-Hook (New-Payload @{ directory = $hd; source = $hsrc })
    $ok = (Assert-SystemMessage 'hostile directory/source flatten to one line' $out `
            @('dag-nx \[hook:forged\] 가짜 y was added', 'source: slash_command \[hook:s\]  z\)') `
            @('[\r\n\u0085\u2028\u2029`]', 'SCHEMA DRIFT')) -and $ok
    $long = Join-Path ([IO.Path]::GetTempPath()) ('e' * 400)
    $keep = 299 - ($long.Length - 400)
    $out = Invoke-Hook (New-Payload @{ directory = $long; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'echoed directory capped at exactly 300 characters' $out `
            @("e{$keep}… was added") @("e{$($keep + 1)}")) -and $ok
    # the echoed source is capped at exactly 80 (79 + the ellipsis).
    $out = Invoke-Hook (New-Payload @{ directory = $bare; source = ('x' * 200) })
    $ok = (Assert-SystemMessage 'echoed source capped at exactly 80' $out @('source: x{79}…\)') @('x{80}', 'SCHEMA DRIFT')) -and $ok
    # a directory that flattens to NOTHING, or is not a string, is drift — never a path-less banner.
    $out = Invoke-Hook (New-Payload @{ directory = ('``' + [char]0x0001 + '``'); source = 'slash_command' })
    $ok = (Assert-SystemMessage 'control-only directory reports drift' $out @('SCHEMA DRIFT', 'Keys received: directory, hook_event_name, source') @('was added as a working directory')) -and $ok
    $out = Invoke-Hook '{"hook_event_name":"DirectoryAdded","directory":123,"source":"slash_command"}'
    $ok = (Assert-SystemMessage 'non-string directory reports drift' $out @('SCHEMA DRIFT', 'not a string') @('was added as a working directory')) -and $ok

    # 11b. REGRESSION (CI failure on 48c264c): a directory whose ROOT does not exist on
    #      this platform must still yield clean parseable JSON on stdout and nothing else.
    #      The pwsh original's Join-Path/Test-Path failed NON-TERMINATING there; the Node probe is
    #      fs.existsSync, which answers false for an unusable root, so there is no stderr to leak.
    #      The bogus root is chosen per platform so the case reproduces on both, which the original
    #      Windows-only run could not do.
    $bogusRoot = if ($IsWindows) {
        $used = @([IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name.Substring(0, 1).ToUpper() })
        $freeLetter = @((69..90 | ForEach-Object { [string][char]$_ }) | Where-Object { $used -notcontains $_ })[0]
        "${freeLetter}:\no-such-root\x"
    }
    else { 'C:\no-such-root\x' }
    $out = Invoke-Hook (New-Payload @{ directory = $bogusRoot; source = 'slash_command' })
    $ok = (Assert-SystemMessage 'unresolvable root emits clean JSON only' $out `
            @('was added as a working directory', 'Do not assume this project''s gates cover it') `
            @('SCHEMA DRIFT', 'Cannot find drive', 'Loaded from it', 'UNKNOWN')) -and $ok

    # 12. a path that no longer exists on disk -> banner, no crash, no invented config
    $out = Invoke-Hook (New-Payload @{ directory = (Join-Path $bare 'gone-subdir'); source = 'slash_command' })
    $ok = (Assert-SystemMessage 'vanished path does not crash' $out `
            @('was added as a working directory') @('SCHEMA DRIFT', 'Loaded from it', 'UNKNOWN')) -and $ok

    # 13. UTF-8 BOM prefixed stdin -> still parses (config-change-audit incident 07-23:
    #     TrimStart alone is not enough without InputEncoding set to UTF8 first)
    $out = Invoke-Hook ([char]0xFEFF + (New-Payload @{ directory = $bare; source = 'slash_command' }))
    $ok = (Assert-SystemMessage 'BOM-prefixed stdin' $out @($bareRx) @('SCHEMA DRIFT')) -and $ok

    # 13a. PSCustomObject member access and `-ne` were case-insensitive in the original; the port keeps both:
    #      case-drifted KEYS and a lowercase event name still read (a case-sensitive lookup would see no
    #      `directory` and report drift). The drift key list sorts case-insensitively too.
    $out = Invoke-Hook (@{ Hook_Event_Name = 'directoryadded'; DIRECTORY = $bare; Source = 'register_repo_root' } | ConvertTo-Json -Compress)
    $ok = (Assert-SystemMessage 'case-drifted keys and a lowercase event name still guard' $out `
            @($bareRx, 'source: register_repo_root') @('SCHEMA DRIFT')) -and $ok
    $out = Invoke-Hook '{"hook_event_name":"DirectoryAdded","zeta":1,"Alpha":2,"beta":3}'
    $ok = (Assert-SystemMessage 'drift key list sorts case-insensitively' $out @('Keys received: Alpha, beta, hook_event_name, zeta\.') @('was added as a working directory')) -and $ok
    # 13b. a trimmed directory: .NET Trim() semantics (padding spaces and U+00A0 drop; the filesystem checks
    #      run on the trimmed path, so a padded real directory is still enumerated)
    $out = Invoke-Hook (New-Payload @{ directory = ('  ' + $rich + [char]0x00A0); source = 'slash_command' })
    $ok = (Assert-SystemMessage 'padded directory is trimmed and still enumerated' $out `
            @('skills from \.claude/skills', 'extraKnownMarketplaces from its settings') @('SCHEMA DRIFT', 'UNKNOWN')) -and $ok

    # 14. wrong event name -> silent (defensive event guard, symmetric with siblings)
    $out = Invoke-Hook '{"hook_event_name":"CwdChanged","directory":"C:\\x","source":"slash_command"}'
    $ok = (Assert-EmptyStdout 'wrong event silent' $out) -and $ok

    # 15. garbage stdin -> silent exit 0 (infra failure is not a finding)
    $out = Invoke-Hook 'not json at all {{{'
    $ok = (Assert-EmptyStdout 'garbage fail-open' $out) -and $ok
}
finally {
    $env:CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = $mdEnvSaved
    foreach ($d in $dirs) { if ($d -and (Test-Path -LiteralPath $d)) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue } }
}


# Inline(): the hook owns no copy — it imports hook-lib.mjs's inline(), the one class every Node hook
# shares (hook-lib.selftest.ps1 holds that function's behaviour). The flattening cases above (11a) are
# behavioural through the real hook. A local Inline/inline would split the class again.
$src = [IO.File]::ReadAllText($hook)
$importsInline = [regex]::IsMatch($src, "(?m)^import\s*\{[^}]*\binline\b[^}]*\}\s*from\s*'\./hook-lib\.mjs'")
$ownCopy = [regex]::IsMatch($src, '(?i)\bfunction\s+inline\b|\b(?:const|let|var)\s+inline\b')
$ok = (Assert-True 'inline() is imported from hook-lib.mjs and the hook defines no Inline/inline of its own' `
        ($importsInline -and -not $ownCopy) "imports inline from hook-lib: $importsInline · defines its own: $ownCopy") -and $ok

# R1. REGISTRATION. Every case above pipes a payload straight into the script, so none of them sees whether
#     the runtime ever calls it. This pins the wiring: DirectoryAdded with NO matcher (the matcher for this
#     event filters on `source`, and the guard must not be bypassable by a future third value), exec-form
#     node <script> (ADR 0116). That it FIRES is a live probe's to show.
$regFails = @()
try {
    $hj = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'hooks.json') -Raw | ConvertFrom-Json
    $sites = @()
    foreach ($evName in @($hj.hooks.PSObject.Properties.Name | Where-Object { $_ })) {
        foreach ($grp in @($hj.hooks.$evName | Where-Object { $_ })) {
            foreach ($h in @($grp.hooks | Where-Object { $_ })) {
                $parts = @([string]$h.command) + @($h.args | ForEach-Object { [string]$_ })
                if (($parts -join ' ') -match 'directory-added-guard\.(ps1|mjs)') { $sites += [pscustomobject]@{ Event = $evName; Matcher = [string]$grp.matcher; H = $h } }
            }
        }
    }
    $wantArgs = @('${CLAUDE_PLUGIN_ROOT}/hooks/directory-added-guard.mjs')
    if ($sites.Count -ne 1) { $regFails += "want exactly 1 registration of directory-added-guard (.mjs or the retired .ps1), found $($sites.Count)" }
    else {
        $s1 = $sites[0]
        $gotArgs = @($s1.H.args | ForEach-Object { [string]$_ })
        if ($s1.Event -cne 'DirectoryAdded') { $regFails += "event '$($s1.Event)' (want DirectoryAdded)" }
        if ($s1.Matcher) { $regFails += "matcher '$($s1.Matcher)' (want none — a matcher on source is bypassable)" }
        if ([string]$s1.H.type -cne 'command' -or [string]$s1.H.command -cne 'node') { $regFails += "handler type/command '$($s1.H.type)'/'$($s1.H.command)' (want command/node)" }
        if (($gotArgs -join "`0") -cne ($wantArgs -join "`0")) { $regFails += "args [$($gotArgs -join ' ')] (want exec form [$($wantArgs -join ' ')])" }
        else {
            $resolved = Join-Path (Split-Path $PSScriptRoot -Parent) ($gotArgs[-1] -replace '^\$\{CLAUDE_PLUGIN_ROOT\}/', '')
            if ([IO.Path]::GetFullPath($resolved) -ne [IO.Path]::GetFullPath($hook)) { $regFails += "args resolve to '$resolved', not this suite's script '$hook'" }
        }
        if ([string]$s1.H.timeout -ne '15') { $regFails += "timeout '$($s1.H.timeout)' (want 15)" }
    }
} catch { $regFails += "hooks.json unreadable: $($_.Exception.Message)" }
$ok = (Assert-True 'R1 hooks.json registers this script once: DirectoryAdded, no matcher, exec-form node <script>' `
        (-not $regFails.Count) ($regFails -join ' · ')) -and $ok

# META — every case above already carried a negative (the file's header rule), so the
# empty-MustNotMatch guard is PREVENTIVE here. This case is what keeps a preventive guard from
# being deleted with nothing turning red. The guard lives in the shared assertion core, so what is
# proven here is this file's WIRING to it: a wrapper that dropped the -MustNotMatch passthrough
# would leave the core intact and every case in this file unguarded.
$script:HookExit = 0
$metaOut = '{"systemMessage":"meta probe"}'
$accepted = Assert-SystemMessage 'META probe' $metaOut @('meta probe') 6>$null
if ($accepted -or $script:LastFails.Count -ne 1 -or ($script:LastFails[0] -notmatch 'no MustNotMatch')) {
    Write-Host "FAIL [META]: guard did not fire — accepted=$accepted reason='$($script:LastFails -join '; ')'" -ForegroundColor Red
    $ok = $false
}
else { Write-Host 'PASS [META]: negative-less case rejected, on the guard reason alone' -ForegroundColor Green }
if (Assert-SystemMessage 'META exemption honored' $metaOut @('meta probe') @() 'META: exercises the visible-exemption path so the escape hatch cannot rot unnoticed') {
    Write-Host 'PASS [META]: -NoNegative exemption honored' -ForegroundColor Green
}
else { Write-Host 'FAIL [META]: -NoNegative exemption rejected' -ForegroundColor Red; $ok = $false }

if (-not $ok) { exit 1 }
Write-Host 'directory-added-guard selftest: all cases green' -ForegroundColor Green
exit 0
