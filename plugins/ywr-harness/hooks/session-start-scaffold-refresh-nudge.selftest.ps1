# Self-test for session-start-scaffold-refresh-nudge.mjs (ADR 0033).
# Usage: pwsh plugins/ywr-harness/hooks/session-start-scaffold-refresh-nudge.selftest.ps1
#
# Fixture provenance: the scaffolded fixtures are placed by the REAL init.mjs (one run, then
# tree copies) — a hand-copied placement would duplicate the map this hook exists not to
# duplicate, and would test the copy. The fixture-prep assertion below is what fails if
# init.mjs stops placing what the hook reads, which is exactly the coupling ADR 0033 accepts.
#
# The hook's verdict is filesystem-only (unlike the githooks sibling, whose verdict is git
# state), so almost every case runs on a git-less machine too: with git present the fixtures
# are real repos and the root is resolved by rev-parse; with git absent the hook's documented
# cwd-fallback carries the same verdicts. Only the subdirectory-resolution case needs git and
# is a reported SKIP without it (the Linux container), never a silent pass.
#
# Slice-note rule (ADR 0172): a scaffold that holds scripts/harness/slice_note.mjs is no longer silent when it
# has no drift: the hook then states the rule as additionalContext, and only that. The cases that used to assert
# byte-silence on a clean scaffold assert the rule instead (Assert-RuleOnly, the rule text pinned verbatim);
# the drift cases also assert the rule follows the drift text (Assert-RuleTail); the SCHEMA-DRIFT, EXTRACTION-DRIFT,
# foreign-tree and no-scaffold paths assert it is absent.
#
# Every match-based case carries MustNotMatch as well as MustMatch (the empty-MustNotMatch
# class), enforced by the shared assertion core.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core + fixture lifecycle
$hook = Join-Path $PSScriptRoot 'session-start-scaffold-refresh-nudge.mjs'
$hookLib = Join-Path $PSScriptRoot 'hook-lib.mjs'   # the hook imports it: every copied hook needs it beside it
$gitLib = Join-Path $PSScriptRoot '../scripts/harness_git.mjs'   # hook-lib imports it from <plugin>/scripts: a copied tree needs it there
$init = Join-Path $PSScriptRoot '../skills/harness-init/init.mjs'
$placement = Join-Path $PSScriptRoot '../skills/harness-init/placement.mjs'   # the placement map the hook imports
$templates = Join-Path $PSScriptRoot '../skills/harness-init/templates'
# The hook is Node (ADR 0116): absent node is a reported skip locally and a FAIL on CI.
Assert-NodeOrExit 'session-start-scaffold-refresh-nudge'

# Resolved BEFORE any case clears $env:PATH — `& pwsh` / `& node` resolve at call time and would fail.
# node runs init.mjs (the scaffold fixture) and the hook under test.
$pwshExe = (Get-Command pwsh).Source
$nodeExe = (Get-Command node).Source
# ~200 git calls (fixture builds plus the hook's own probes): the worker binary, not the cmd\git.exe
# launcher (lib Use-GitWorkerBinary, ADR 0111, ADR 0149). AFTER pwsh and node are resolved, so the worker
# directory can never shadow either of them (review, slice 126). Left in place — under `pwsh -File` the
# process ends with it. The no-git cases below REPLACE the PATH (cases 20-21: ''), so they never see it,
# and $savedPath, read after this line, restores it.
$null = Use-GitWorkerBinary

function Invoke-Hook([string]$Stdin, [string]$HookPath = $hook) {
    $o = ($Stdin | & $nodeExe $HookPath 2>&1 | Out-String)
    $script:HookExit = $LASTEXITCODE
    return $o
}
# Envelope adapter (file-specific, per the assertion-core contract): the nudge speaks through
# systemMessage + optional additionalContext, so the matched text is both joined — a pattern
# that lives only in the context half (the direction-blindness caveat) still gets asserted.
# When additionalContext is present its hookEventName must be SessionStart, or the runtime
# drops it.
function Assert-Nudge([string]$Name, [string]$Out, [string[]]$MustMatch, [string[]]$MustNotMatch, [string]$NoNegative = '') {
    $pre = @()
    if ($script:HookExit -ne 0) { $pre += "exit $script:HookExit (want 0 — fail-open contract; SessionStart blocks nothing)" }
    $sys = ''; $ctx = ''; $evName = ''
    try {
        $j = ConvertFrom-Json $Out.Trim()
        $sys = [string]$j.systemMessage
        try { $ctx = [string]$j.hookSpecificOutput.additionalContext; $evName = [string]$j.hookSpecificOutput.hookEventName } catch { }
    }
    catch { $pre += 'stdout is not valid JSON' }
    if (-not $sys) { $pre += 'no systemMessage' }
    if ($ctx -and $evName -ne 'SessionStart') { $pre += "hookSpecificOutput.hookEventName is '$evName' (want SessionStart — the runtime drops the context otherwise)" }
    # The slice rules name harness_gates.mjs; a placeholder keeps the file-list patterns about the file list.
    $ctx = $ctx.Replace($sliceRules, '<SLICE_RULES>')
    $script:LastFails = Get-AssertionFailure -Text "$sys`n$ctx" -MustMatch $MustMatch -MustNotMatch $MustNotMatch `
        -NoNegative $NoNegative -PreFail $pre -Label 'output'
    return (Write-CaseVerdict -Name $Name -Fail $script:LastFails -Detail $Out)
}
function Assert-EmptyStdout([string]$Name, [string]$Out) {
    $fails = @()
    if ($script:HookExit -ne 0) { $fails += "exit $script:HookExit (want 0 — fail-open contract)" }
    # Plain stdout on exit 0 becomes session context for this event, so "silent" must mean
    # BYTE-silent — a stray warning line would be injected into every session's context.
    if ($Out.Trim()) { $fails += "expected empty stdout, got: $($Out.Trim())" }
    if ($fails) { Write-Host "FAIL [$Name]: $($fails -join ' · ')" -ForegroundColor Red; return $false }
    Write-Host "PASS [$Name]" -ForegroundColor Green
    return $true
}
# The slice-note rule (ADR 0172), copied VERBATIM as a pin: a reword in the hook must fail here and be a decision.
$noteRule = 'Slice notes (ywr-harness ADR 0172): record each decision of this slice when you make it, with its reason: `node scripts/harness/slice_note.mjs add <kind> "<what and why>"`. Kinds: decision (an option chosen), rejected (an option dropped), owner (the owner''s answer), fact (a figure established at cost), risk (a known limit or an unverified point). A compaction re-injects the notes, and /ywr-harness:slice-close reads them into the close as input, never proof.'
$ruleMark = 'Slice notes \(ywr-harness ADR 0172\)'   # a regex for a MustNotMatch: the rule's own first words
# The slice rules (ADR 0183), copied VERBATIM as a pin: the head line, then one line per rule, joined by LF.
$sliceHead = 'ywr-harness slice rules for this repo (ywr-harness ADR 0183). The org guide states the general rules; this repo''s CLAUDE.md states its own facts.'
$sliceRuleLines = @(
    '- Review: before a slice closes, run `/code-review` through the Skill tool: `medium` for a small tier and for a full tier (ywr-harness ADR 0215, ywr-harness ADR 0218). `/ywr-harness:slice-close` makes the call. Every finding gets a bucket: fixed, valid with no action, or false on reading. The review invariants are in the file that `.harness.json` `review.canon` names: the `## Review canon` section of `CLAUDE.md` in a new scaffold, where this repo''s own invariants replace the harness-init starters (ywr-harness ADR 0217).'
    '- The review runs once per slice. Every finding gets one of three buckets. The severity limits the bucket: an `important`, `pre_existing` or ungraded finding ends fixed or false on reading, only a `nit` whose fix would change a design or a coverage ends valid with no action with an open item, and a fix that rests on an untested host behaviour gets a probe first; when the owner defers that probe, the finding ends valid with no action as an owner decision, with an open item (ywr-harness ADR 0216). A fix closes with re-run gates over its own files, and every fixed finding except a `nit` gets one fix check (ywr-harness ADR 0215). No fix gets a re-review. When a fix needs more review, record an open item: `node scripts/harness/slice_note.mjs add risk "open item: review <files and lines> of the <file:line> fix; <why>"`. A separate rule: a rebase or merge after the review re-arms it only over the overlap: reviewed files that the incoming commits touched, plus each hand-resolved conflict. An empty overlap keeps the review, recorded in the close as `review basis:` (ywr-harness ADR 0028, ywr-harness ADR 0072, ywr-harness ADR 0200).'
    '- The close: `/ywr-harness:slice-close` writes the handoff and the one commit. The person types it, or the main session calls it; a subagent never calls it (ywr-harness ADR 0201). The session prepares the close: it runs every command that `node scripts/harness/harness_gates.mjs` printed, the review with its fix checks, and verify. It writes no handoff and makes no commit itself. Its ready report ends with the line that `node scripts/harness/harness_gates.mjs --tree` printed after the final edit. After the report the session asks each open owner question with AskUserQuestion, then calls the skill. The close reuses the report only while it is verbatim in the same session and that line is unchanged; a new session or a compaction summary runs the full close (ywr-harness ADR 0105).'
    '- Handoff: the `handoff` key in `.harness.json` names the resume file. A value that ends in `/` names a directory with one resume file per work line, named after the work line, never after a person. The close that supersedes a `## Current state` section moves it to `docs/handoff-archive/<same filename>`, newest first (ywr-harness ADR 0040).'
    '- Artifacts: a claude.ai Artifact that this repo publishes has the title `<repo-name> · <purpose>` and is declared under `artifacts` in `.harness.json`; CI then fails when the README lacks its link. A generated Artifact also declares its committed `source` file and a `check` drift gate, and `/ywr-harness:artifact-publish` republishes it with one confirmation, never headless (ywr-harness ADR 0032, ywr-harness ADR 0068).'
)
$sliceRules = (@($sliceHead) + $sliceRuleLines) -join "`n"
# The slice rules without the review rule: what a repo whose CLAUDE.md copies only that rule gets.
$sliceRulesNoReview = (@($sliceHead) + $sliceRuleLines[1..4]) -join "`n"
# The copy note (ADR 0183): the whole text where the repo CLAUDE.md copies every part.
$copyNote = 'This repo''s CLAUDE.md or .claude/CLAUDE.md holds its own copy of part of the ywr-harness slice rules, so the plugin does not repeat that part here. After that copy is deleted, the plugin states the current rules at each session start (ywr-harness ADR 0183).'
# A fresh scaffold holds `.harness.json`, `slice_note.mjs` and a seed CLAUDE.md with no copy: both parts, a blank line between.
$ruleText = $sliceRules + "`n`n" + $noteRule
# A repo with the vendored script and NO drift: the rule is the WHOLE output — additionalContext equal to the
# rule, event SessionStart, and no systemMessage (nothing for a person to act on). Never "silent" any more.
function Assert-RuleOnly([string]$Name, [string]$Out, [string]$Expected = $ruleText) {
    $fails = @()
    if ($script:HookExit -ne 0) { $fails += "exit $script:HookExit (want 0 — fail-open contract)" }
    $sys = ''; $ctx = ''; $evName = ''; $keys = ''
    try {
        $j = ConvertFrom-Json $Out.Trim()
        $sys = [string]$j.systemMessage
        $keys = ($j.PSObject.Properties.Name -join ',')
        $ctx = [string]$j.hookSpecificOutput.additionalContext; $evName = [string]$j.hookSpecificOutput.hookEventName
    }
    catch { $fails += 'stdout is not valid JSON' }
    if ($sys) { $fails += "unexpected systemMessage: $sys" }
    if ($keys -ne 'hookSpecificOutput') { $fails += "top-level keys [$keys] (want only hookSpecificOutput)" }
    if ($evName -ne 'SessionStart') { $fails += "hookEventName '$evName' (want SessionStart)" }
    if ($ctx -cne $Expected) { $fails += "additionalContext is not exactly the rule: [$ctx]" }
    $script:LastFails = [string[]]$fails
    return (Write-CaseVerdict -Name $Name -Fail $fails -Detail $Out)
}
# A drift verdict: additionalContext must END with the rule, set off by ONE blank line, and the drift text
# must come first. Run next to the Assert-Nudge of the same output.
function Assert-RuleTail([string]$Name, [string]$Out) {
    $fails = @()
    $ctx = ''
    try { $ctx = [string](ConvertFrom-Json $Out.Trim()).hookSpecificOutput.additionalContext } catch { $fails += 'stdout is not valid JSON' }
    if (-not $ctx.EndsWith("`n`n$ruleText")) { $fails += 'additionalContext does not end with a blank line and the rule' }
    if ($ctx.Length -le $ruleText.Length + 2) { $fails += 'no drift text precedes the rule' }
    $first = $ctx.IndexOf($ruleText)
    if ($first -ne $ctx.LastIndexOf($ruleText)) { $fails += 'the rule appears more than once' }
    if ($ctx.Length -gt 6000) { $fails += "context is $($ctx.Length) characters (the host caps a hook string at 10,000; this one should stay far below)" }
    return (Write-CaseVerdict -Name $Name -Fail $fails -Detail $Out)
}
function New-Payload([hashtable]$Fields, [string]$Source = 'startup') {
    $o = @{ hook_event_name = 'SessionStart'; session_id = 'selftest'; source = $Source } + $Fields
    return ($o | ConvertTo-Json -Compress)
}

$ok = $true
$savedPath = $env:PATH
$gitOk = [bool](Get-Command git -ErrorAction SilentlyContinue)
$fx = New-FixtureRoot 'ssrn-selftest'
trap { $env:PATH = $savedPath; Remove-FixtureRoot $fx; break }

# --- fixtures --------------------------------------------------------------------------------
# ONE real scaffold run, then tree copies (with .git when present) — each variant then mutates
# exactly the file family its case is about.
$base = Join-Path $fx 'repo-base'
New-Item -ItemType Directory -Force -Path $base | Out-Null
if ($gitOk) { & git -c init.defaultBranch=main init -q $base 2>$null | Out-Null }
& $nodeExe $init --target $base *> $null
$ok = (Assert-True 'fixture: real init.mjs scaffolded the base repo' `
        ((Test-Path -LiteralPath (Join-Path $base 'scripts/harness/harness_gates.mjs')) -and
        (Test-Path -LiteralPath (Join-Path $base '.githooks/post-commit'))) `
        'init.mjs did not place the files this suite mutates — every later verdict would be about a broken fixture') -and $ok

$fresh = Join-Path $fx 'repo-fresh'
$stale = Join-Path $fx 'repo-stale'
$seed = Join-Path $fx 'repo-seededit'
$crlf = Join-Path $fx 'repo-crlf'
$foreignpc = Join-Path $fx 'repo-foreignpc'
$ourspc = Join-Path $fx 'repo-ourspc'
$many = Join-Path $fx 'repo-manydrift'
foreach ($v in @($fresh, $stale, $seed, $crlf, $foreignpc, $ourspc, $many)) {
    Copy-Item -LiteralPath $base -Destination $v -Recurse -Force
}
# stale: one modified vendored script + one deleted CI workflow (differs AND missing in one verdict)
Add-Content -LiteralPath (Join-Path $stale 'scripts/harness/harness_gates.mjs') -Value '# selftest drift'
Remove-Item -LiteralPath (Join-Path $stale '.github/workflows/harness-gates.yml') -Force
New-Item -ItemType Directory -Force -Path (Join-Path $stale 'subA/subB') | Out-Null
# seed edits only: every SEED family touched, no TOOLCHAIN file
Add-Content -LiteralPath (Join-Path $seed 'CLAUDE.md') -Value 'repo decision'
Add-Content -LiteralPath (Join-Path $seed '.harness.json') -Value ' '
Add-Content -LiteralPath (Join-Path $seed '.gitattributes') -Value '*.bin binary'
Add-Content -LiteralPath (Join-Path $seed '.githooks/slice-retro-ignore') -Value '# exempt'
# crlf: same bytes modulo line endings (LF -> CRLF, byte-level so no decode can shift content)
$pcPath = Join-Path $crlf '.githooks/pre-commit'
$bytes = [IO.File]::ReadAllBytes($pcPath)
$ms = [IO.MemoryStream]::new()
foreach ($b in $bytes) { if ($b -eq 10) { $ms.WriteByte(13) }; $ms.WriteByte($b) }
[IO.File]::WriteAllBytes($pcPath, $ms.ToArray())
# foreign post-commit: no marker -> init.mjs refuses it -> the hook must skip it the same way
Set-Content -LiteralPath (Join-Path $foreignpc '.githooks/post-commit') -Value "#!/bin/sh`nexit 0"
# ours post-commit: marker retained, content drifted
Add-Content -LiteralPath (Join-Path $ourspc '.githooks/post-commit') -Value 'echo extra'
# manydrift: seven TOOLCHAIN placements drifted -> the list caps at 5 and STATES the cap
foreach ($rel in @('docs/README.md', 'docs/adr/README.md', 'docs/spec/README.md', 'docs/build.mjs',
        'docs/build.sh', 'docs/build_docs.mjs', 'scripts/harness/harness_config.mjs')) {
    Add-Content -LiteralPath (Join-Path $many $rel) -Value '# drift'
}
# not-ours: a scripts/harness/ directory that is NOT a scaffold (file-level sentinel must gate)
$notours = Join-Path $fx 'repo-notours'
New-Item -ItemType Directory -Force -Path (Join-Path $notours 'scripts/harness') | Out-Null
Set-Content -LiteralPath (Join-Path $notours 'scripts/harness/own_tool.py') -Value 'pass'
# bare: a repo with no scripts/harness at all
$bare = Join-Path $fx 'repo-bare'
New-Item -ItemType Directory -Force -Path $bare | Out-Null
if ($gitOk) {
    foreach ($r in @($notours, $bare)) { & git -c init.defaultBranch=main init -q $r 2>$null | Out-Null }
}
$plain = Join-Path $fx 'plain-dir'
New-Item -ItemType Directory -Force -Path $plain | Out-Null
# non-mutation baseline (asserted at the end): the hook must never write
$freshHash = (Get-FileHash -LiteralPath (Join-Path $fresh 'docs/build_docs.mjs')).Hash
$staleHash = (Get-FileHash -LiteralPath (Join-Path $stale 'scripts/harness/harness_gates.mjs')).Hash

# 1. the drifted repo nudges — the fixture was scaffolded by THIS plugin and then hand-mutated,
#    so its .harness-version stamp EQUALS the running version and the ADR 0042 verdict is the
#    hand-edit reading: count, both file names (differ + missing), version, the
#    REVERT-hand-edits warning, the suggest-only contract.
$out = Invoke-Hook (New-Payload @{ cwd = $stale })
$ok = (Assert-Nudge 'drifted scaffold at the same version reads as a hand-edit' $out `
        @('\[hook:scaffold-refresh-nudge\]', 'repo-stale', '2개의 벤더링된 툴체인 파일', 'v\d+\.\d+\.\d+',
        'harness_gates\.mjs', 'harness-gates\.yml \(missing\)', 'EQUALS', 'hand-edit',
        'REVERT', '제안만 합니다') `
        @('SCHEMA DRIFT', 'EXTRACTION DRIFT', '\+\d+ more', '기준이 STALE', 'direction-blind',
        '리프레시: 이 저장소에서', 'NEWER합니다', 'OLDER합니다', 'ADR 0135', '다른 클론')) -and $ok
$ok = (Assert-RuleTail '1 hand-edit branch: the rule follows the drift text' $out) -and $ok

# 1b. REPO-AHEAD (ADR 0042): stamp newer than the running plugin — the multi-writer everyday
#     state (another writer refreshed this repo with a newer release). The advice must FLIP:
#     update the plugin, do NOT init — and the refresh command must not appear as advice.
$ahead = Join-Path $fx 'repo-ahead'
Copy-Item -LiteralPath $stale -Destination $ahead -Recurse -Force
Set-Content -LiteralPath (Join-Path $ahead '.harness-version') -Value '99.0.0'
$out = Invoke-Hook (New-Payload @{ cwd = $ahead })
$ok = (Assert-Nudge 'repo-ahead stamp flips the advice to update-the-plugin' $out `
        @('v99\.0\.0', 'NEWER합니다', '/ywr-harness:harness-init을 실행하지 마세요',
        '/ywr-harness:update', '리프레시를 REVERT', '제안만 합니다') `
        @('리프레시: 이 저장소에서', '시드는 보존', '기준이 STALE', 'direction-blind', 'SCHEMA DRIFT',
        'EXTRACTION DRIFT')) -and $ok
$ok = (Assert-RuleTail '1b repo-ahead branch: the rule follows the drift text' $out) -and $ok

# 1c. REPO-BEHIND: stamp older than the running plugin — the one state where the refresh advice
#     is measured, not guessed. The pre-0042 uncaveated human banner ('re-run is safe:' without
#     'here') is a deliberate ANTI-anchor: its reappearance fails this case.
$behind = Join-Path $fx 'repo-behind'
Copy-Item -LiteralPath $stale -Destination $behind -Recurse -Force
Set-Content -LiteralPath (Join-Path $behind '.harness-version') -Value '0.0.1'
$out = Invoke-Hook (New-Payload @{ cwd = $behind })
$ok = (Assert-Nudge 'repo-behind stamp keeps the refresh advice, direction measured' $out `
        @('v0\.0\.1', 'OLDER합니다', '측정된 것입니다', '여기서는',
        '리프레시: 이 저장소에서 /ywr-harness:harness-init', '시드는 보존', '제안만 합니다') `
        @('리프레시를 REVERT', 'direction-blind',
        '기준이 STALE', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok
$ok = (Assert-RuleTail '1c repo-behind branch: the rule follows the drift text' $out) -and $ok

# 1d. NO STAMP (every pre-0042 repo): direction-blind — and the caveat must now sit on the
#     HUMAN surface too, not only in additionalContext: the 2026-08-10 audit's asymmetry
#     (an uncaveated 're-run is safe' banner over a caveated context) is what this anchors.
$nostamp = Join-Path $fx 'repo-nostamp'
Copy-Item -LiteralPath $stale -Destination $nostamp -Recurse -Force
Remove-Item -LiteralPath (Join-Path $nostamp '.harness-version') -Force
$out = Invoke-Hook (New-Payload @{ cwd = $nostamp })
$ok = (Assert-Nudge 'stampless repo gets the direction-blind caveat' $out `
        @('direction-blind', '읽을 수 있는 \.harness-version 스탬프 없음', 'REVERT', '실행하기 전에',
        '/ywr-harness:update', '제안만 합니다') `
        @('EQUALS', 'NEWER합니다', 'OLDER합니다',
        '기준이 STALE', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok
$ok = (Assert-RuleTail '1d direction-blind branch: the rule follows the drift text' $out) -and $ok
$sysOnly = ''
try { $sysOnly = [string]((ConvertFrom-Json $out.Trim()).systemMessage) } catch { }
$ok = (Assert-True '1d the caveat is in the HUMAN banner, not only the context half' `
        ($sysOnly -match 'direction-blind' -and $sysOnly -match 'REVERT') `
        "systemMessage='$sysOnly'") -and $ok

# 1e. a stamp with NO newline and megabytes of one-line content must degrade to the
#     direction-blind branch via the BOUNDED read — never a whole-file read on the SessionStart
#     hot path (review 2026-08-10, medium). The device-symlink hang leg is not portably
#     testable; the bounded read retires the class by construction, and this case pins the
#     parse-failure fallback and the clean envelope on the closest committable input.
$hugestamp = Join-Path $fx 'repo-hugestamp'
Copy-Item -LiteralPath $stale -Destination $hugestamp -Recurse -Force
[IO.File]::WriteAllText((Join-Path $hugestamp '.harness-version'), ('1.2.3' + ('x' * 5MB)))
$out = Invoke-Hook (New-Payload @{ cwd = $hugestamp })
$ok = (Assert-Nudge 'huge one-line stamp degrades to direction-blind cleanly' $out `
        @('direction-blind', '읽을 수 있는 \.harness-version 스탬프 없음') `
        @('NEWER합니다', 'OLDER합니다', 'EQUALS', '기준이 STALE',
        'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok

# 1f. component-count normalization (review 2026-08-10, low): a 4-component stamp X.0 names the
#     SAME release as running X, but [version] pads missing components with -1, so without
#     normalization it reads NEWER (revision 0 > -1) and flips the advice to update-the-plugin
#     for a repo that is not ahead. Version-independent fixture: stamp = <manifest>.0.
$mfVer = ((Get-Content -LiteralPath (Join-Path $PSScriptRoot '../.claude-plugin/plugin.json') -Raw | ConvertFrom-Json).version)
$padstamp = Join-Path $fx 'repo-padstamp'
Copy-Item -LiteralPath $stale -Destination $padstamp -Recurse -Force
Set-Content -LiteralPath (Join-Path $padstamp '.harness-version') -Value "$mfVer.0"
$out = Invoke-Hook (New-Payload @{ cwd = $padstamp })
$ok = (Assert-Nudge 'a 4-component stamp naming the same release reads as EQUALS, not ahead' $out `
        @('EQUALS', 'hand-edit') `
        @('NEWER합니다', '/ywr-harness:harness-init을 실행하지 마세요', '기준이 STALE',
        'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok

# 1g. the shapes a hand-edited or tool-written stamp takes (ADR 0042), read through the bounded 64-byte
#     read: BOM + `v` prefix + CRLF + a second line still names the running release; a two-component
#     stamp is padded, not compared against -1; five components, junk and a non-ASCII byte (the .NET
#     ASCII decode turns it into `?`) are unreadable and degrade to direction-blind.
$stampCases = @(
    @{ N = 'BOM, v prefix, CRLF and a second line still read as the running release'; Text = ([string][char]0xFEFF + "v$mfVer`r`nsecond line")
       Want = @('EQUALS', 'hand-edit'); Not = @('NEWER합니다', 'OLDER합니다', 'direction-blind', 'SCHEMA DRIFT') },
    @{ N = 'an upper-case V prefix reads too'; Text = "V$mfVer"
       Want = @('EQUALS'); Not = @('NEWER합니다', 'OLDER합니다', 'direction-blind', 'SCHEMA DRIFT') },
    @{ N = 'a two-component stamp below the running version is OLDER'; Text = '0.1'
       Want = @('v0\.1', 'OLDER합니다'); Not = @('NEWER합니다', 'EQUALS', 'direction-blind', 'SCHEMA DRIFT') },
    @{ N = 'five components is invalid -> direction-blind'; Text = '1.2.3.4.5'
       Want = @('direction-blind'); Not = @('NEWER합니다', 'OLDER합니다', 'EQUALS', 'SCHEMA DRIFT') },
    @{ N = 'a component beyond Int32 is invalid -> direction-blind'; Text = '99999999999.0.0'
       Want = @('direction-blind'); Not = @('NEWER합니다', 'OLDER합니다', 'EQUALS', 'SCHEMA DRIFT') },
    @{ N = 'junk is invalid -> direction-blind'; Text = 'not-a-version'
       Want = @('direction-blind'); Not = @('NEWER합니다', 'OLDER합니다', 'EQUALS', 'SCHEMA DRIFT') },
    @{ N = 'a non-ASCII byte makes the token unreadable -> direction-blind'; Text = "$mfVer$([char]0xE9)"
       Want = @('direction-blind'); Not = @('NEWER합니다', 'OLDER합니다', 'EQUALS', 'SCHEMA DRIFT') },
    @{ N = 'an empty stamp -> direction-blind'; Text = ''
       Want = @('direction-blind'); Not = @('NEWER합니다', 'OLDER합니다', 'EQUALS', 'SCHEMA DRIFT') }
)
$sci = 0
foreach ($sc in $stampCases) {
    $sci++
    $sd = Join-Path $fx "repo-stamp$sci"
    Copy-Item -LiteralPath $stale -Destination $sd -Recurse -Force
    [IO.File]::WriteAllBytes((Join-Path $sd '.harness-version'), [Text.UTF8Encoding]::new($false).GetBytes($sc.Text))
    $out = Invoke-Hook (New-Payload @{ cwd = $sd })
    $ok = (Assert-Nudge "1g $($sc.N)" $out $sc.Want $sc.Not) -and $ok
}
# a stamp that is a DIRECTORY is not a stamp (Leaf only) -> direction-blind, and the hook must not hang or fail
$sdir = Join-Path $fx 'repo-stampdir'
Copy-Item -LiteralPath $stale -Destination $sdir -Recurse -Force
Remove-Item -LiteralPath (Join-Path $sdir '.harness-version') -Force
New-Item -ItemType Directory -Force -Path (Join-Path $sdir '.harness-version') | Out-Null
$out = Invoke-Hook (New-Payload @{ cwd = $sdir })
$ok = (Assert-Nudge '1g a .harness-version directory is no stamp' $out @('direction-blind') @('NEWER합니다', 'OLDER합니다', 'EQUALS', 'SCHEMA DRIFT')) -and $ok

# 2. freshly scaffolded repo -> NO drift, but the scaffold holds slice_note.mjs (the template map places it), so
#    the slice-note rule (ADR 0172) is the whole output: additionalContext only, exactly the rule, no systemMessage.
$out = Invoke-Hook (New-Payload @{ cwd = $fresh })
$ok = (Assert-RuleOnly 'fresh scaffold states only the slice-note rule' $out) -and $ok

# 2a. SAME repo on every other source: the hook is matcher-less, so a compaction (and a start, resume, clear, fork)
#     carries the rule too — it is the one fact a compaction summary loses and this hook re-injects.
foreach ($src in @('compact', 'startup', 'resume', 'clear', 'fork')) {
    $out = Invoke-Hook (New-Payload @{ cwd = $fresh } $src)
    $ok = (Assert-RuleOnly "2a source=$src still states the rule" $out) -and $ok
}

# 2b. the vendored script absent -> the placement map says it is missing -> drift, named `(missing)`, and NO rule:
#     the rule is a fact about a scaffold that holds the script. The file must also be a FILE: a directory of that
#     name is no script (isFile), the same drift and the same absence of the rule.
$noNote = Join-Path $fx 'repo-nonote'
Copy-Item -LiteralPath $base -Destination $noNote -Recurse -Force
Remove-Item -LiteralPath (Join-Path $noNote 'scripts/harness/slice_note.mjs') -Force
$out = Invoke-Hook (New-Payload @{ cwd = $noNote })
$ok = (Assert-Nudge '2b identical placements but slice_note.mjs absent: drift (missing), no rule' $out `
        @('1개의 벤더링된 툴체인 파일', 'slice_note\.mjs \(missing\)', '제안만 합니다') `
        @($ruleMark, 'SCHEMA DRIFT', 'EXTRACTION DRIFT', 'node scripts/harness/slice_note\.mjs add')) -and $ok
$noteDir = Join-Path $fx 'repo-notedir'
Copy-Item -LiteralPath $noNote -Destination $noteDir -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $noteDir 'scripts/harness/slice_note.mjs') | Out-Null
$out = Invoke-Hook (New-Payload @{ cwd = $noteDir })
$ok = (Assert-Nudge '2b a directory named slice_note.mjs is no script: drift (missing), no rule' $out `
        @('slice_note\.mjs \(missing\)') @($ruleMark, 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok

# 2c. a repo that is scaffolded and DRIFTED, with the script present: the drift text first, then the rule
#     (see the Assert-RuleTail calls beside the drift cases 1, 1b, 1c, 1d, 10b-2 and 13b for each branch).
$out = Invoke-Hook (New-Payload @{ cwd = $stale } 'compact')
$ok = (Assert-Nudge '2c drift on a compact start: the nudge is unchanged' $out `
        @('repo-stale', '2개의 벤더링된 툴체인 파일', 'hand-edit', '제안만 합니다', [regex]::Escape("<SLICE_RULES>`n`n$noteRule")) `
        @('SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok
$ok = (Assert-RuleTail '2c drift on a compact start: the rule follows the drift text' $out) -and $ok

# 3. SEED-only edits -> no drift: seeds are the repo's decisions, never compared (ADR 0033). The rule only.
$out = Invoke-Hook (New-Payload @{ cwd = $seed })
$ok = (Assert-RuleOnly 'seed edits state only the rule (no drift)' $out) -and $ok

# 3a. A repo CLAUDE.md that still holds the pre-0.72.0 seed copy (ADR 0183) never gets a rule twice. Each rule has
#     its own markers: phrases only its old seed bullet held, in CLAUDE.md or .claude/CLAUDE.md. A left-out rule is
#     replaced by the copy note. A bare mention of the workflow, the command or an ADR citation is no copy. An
#     unreadable CLAUDE.md is no copy. No .harness.json: the slice-note rule alone.
$oldSeed = @'
- Adversarial code review before closing a slice (`/ywr-harness:slice-close` builds the call):
  Put house-specific review angles in `args.lensExtra` rather than redefining the lens set.
- The review runs once per slice ... recorded in the close as `review basis:` (ywr-harness ADR 0072).
- The close is owner-typed: `/ywr-harness:slice-close` writes the handoff (ywr-harness ADR 0105).
- A claude.ai Artifact this repo publishes is titled **`<repo-name> · <purpose>`** (ywr-harness ADR 0032).
- Record each decision: `node scripts/harness/slice_note.mjs add <decision|rejected|owner|fact|risk> "<what and why>"`.
- the close moves it to `docs/handoff-archive/<same filename>`, newest first (ywr-harness ADR 0040).
'@
# One copy serves every 3a case (a full copy per case cost about 0.3 s each); each case rewrites only the files
# it is about, and the last case removes .harness.json.
$cp = Join-Path $fx 'repo-copy3a'
Copy-Item -LiteralPath $fresh -Destination $cp -Recurse -Force
$cpClaude = Join-Path $cp 'CLAUDE.md'
$seedText = [IO.File]::ReadAllText($cpClaude)
function Set-CopyClaude([string]$Extra) { [IO.File]::WriteAllText($cpClaude, $seedText + "`n" + $Extra + "`n") }

Set-CopyClaude $oldSeed
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
# ADR 0197 retired sessionModel and the ADR 0190 review-call fill: a copy without it gets no fill. The old close bullet
# holds retired text (ADR 0207, `The close is owner-typed`), so that copy is no copy: the close rule is stated, the other
# copied rules stay left out, the copy note follows, the retired-text part comes last, and a person gets one line.
$ok = (Assert-Nudge '3a the old seed copies every rule, its close bullet is retired: the close rule, the copy note, the retired part' $out `
        @([regex]::Escape('CLAUDE.md (`The close is owner-typed`: v0.72.0, ywr-harness ADR 0201)'), 'seed 파일 1개', '직접 고쳐야', 'ADR 0207', '제안만 합니다') `
        @('SCHEMA DRIFT', 'EXTRACTION DRIFT', '템플릿과 다릅니다', 'Put house review angles', 'review basis:', $ruleMark)) -and $ok
$ctx3a = [string](ConvertFrom-Json $out.Trim()).hookSpecificOutput.additionalContext
$ok = (Assert-True '3a the retired close copy: exactly the head and the close rule, the copy note, then the retired part' `
        $ctx3a.StartsWith((@($sliceHead, $sliceRuleLines[2]) -join "`n") + "`n`n" + $copyNote + "`n`nRetired seed text (ywr-harness ADR 0207): ") `
        "additionalContext: [$ctx3a]") -and $ok

# 3b. Retired seed text (ADR 0207), driven by the hook's own table: every phrase goes into every file its row names,
#     so every row must fire once per file. CLAUDE.md gets each phrase wrapped over lines (the match collapses
#     whitespace); .claude/CLAUDE.md gets it on one line, so its copy markers hit and the restated rules prove that a
#     copy holding retired text is no copy. One hook run without drift, one with drift; the same repo copy as 3a.
$tableCode = 'const s=require("fs").readFileSync(process.argv[1],"utf8");const a=s.indexOf("const CLAUDE_FILES");const b=s.indexOf("\n]",s.indexOf("const RETIRED_SEED"))+2;process.stdout.write(JSON.stringify(new Function(s.slice(a,b)+";return RETIRED_SEED")()))'
$retiredRows = @(& $nodeExe -e $tableCode $hook | ConvertFrom-Json)
$ok = (Assert-True '3b the retired table reads from the hook' ($retiredRows.Count -gt 0 -and -not ($retiredRows | Where-Object { -not $_.phrase })) "rows: $($retiredRows.Count)") -and $ok
function Get-Squashed([string]$Text) { return ($Text -replace '\s+', ' ') }
$pinned = Get-Squashed ($sliceRules + ' ' + $noteRule + ' ' + $copyNote)
$tableFails = @()
foreach ($row in $retiredRows) {
    if ($row.version -notmatch '^\d+\.\d+\.\d+$' -or $row.adr -notmatch '^\d{4}$') { $tableFails += "$($row.phrase): version '$($row.version)' or adr '$($row.adr)' is malformed" }
    if ($pinned.Contains($row.phrase)) { $tableFails += "$($row.phrase): the current slice rules hold it" }
    foreach ($f in $row.files) {
        # .claude/CLAUDE.md is no placement; its seed text is CLAUDE.md's.
        $placed = Join-Path $base $(if ($f -eq '.claude/CLAUDE.md') { 'CLAUDE.md' } else { $f })
        # REVIEW.md is the one retired file: no scaffold places it any more, but a repo that older scaffolds seeded keeps it
        # and an import can load it as the review canon, so the hook still scans it for retired text.
        if ($f -eq 'REVIEW.md' -and -not (Test-Path -LiteralPath $placed -PathType Leaf)) { continue }
        if (-not (Test-Path -LiteralPath $placed -PathType Leaf)) { $tableFails += "${f}: the real init.mjs places no such seed"; continue }
        if ((Get-Squashed ([IO.File]::ReadAllText($placed))).Contains($row.phrase)) { $tableFails += "$($row.phrase): the current seed $f holds it" }
    }
}
$ok = (Assert-True '3b each row: a real seed placement, absent from the current seed and from the slice rules, a well-formed version and ADR' `
        (-not $tableFails) ($tableFails -join ' · ')) -and $ok

# The version of each row against history (review F1 of slice 236): the seed at the row's release lacks the phrase,
# and the seed at the release before it holds it. The release tags are `ywr-harness--vX.Y.Z`; a checkout without them
# (the CI checkout is shallow) is a reported SKIP. One node process reads every seed through one `git cat-file --batch`.
$canonRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$tagVers = if ($gitOk) { @(& git -C $canonRoot tag --list 'ywr-harness--v*' 2>$null | ForEach-Object { $_ -replace '^ywr-harness--v', '' } | Where-Object { $_ -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_ }) } else { @() }
if ($tagVers.Count -lt 2) {
    Write-Host 'SKIP [3b each row version against the release tags]: no ywr-harness--v* release tags in this checkout' -ForegroundColor Yellow
} else {
    # A row of the version that plugin.json names, before its tag exists, reads that release's seed from the working tree.
    $curVer = (Get-Content -LiteralPath (Join-Path $canonRoot 'plugins/ywr-harness/.claude-plugin/plugin.json') -Raw | ConvertFrom-Json).version
    $specs = [Collections.Generic.List[object]]::new()
    foreach ($row in $retiredRows) {
        $prev = @($tagVers | Where-Object { [version]$_ -lt [version]$row.version }) | Select-Object -Last 1
        $untagged = ($row.version -eq $curVer) -and ($tagVers -notcontains $row.version)
        foreach ($f in $row.files) {
            $tmpl = 'plugins/ywr-harness/skills/harness-init/templates/' + $(if ($f -eq '.claude/CLAUDE.md') { 'CLAUDE.md' } else { $f })
            $at = if ($untagged) { "WT:$tmpl" } else { "ywr-harness--v$($row.version):$tmpl" }
            $specs.Add(@{ phrase = $row.phrase; file = $f; at = $at; before = $(if ($prev) { "ywr-harness--v${prev}:$tmpl" } else { '' }) })
        }
    }
    $histCode = @'
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const [root, json] = process.argv.slice(1)
const specs = JSON.parse(json)
const text = {}
for (const s of specs) if (s.at.startsWith('WT:')) {
  const p = path.join(root, s.at.slice(3))
  text[s.at] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\s+/g, ' ') : null
}
const names = [...new Set(specs.flatMap(s => [s.at, s.before]).filter(n => n && !n.startsWith('WT:')))]
const out = execFileSync('git', ['-C', root, 'cat-file', '--batch'], { input: names.join('\n') + '\n', maxBuffer: 1 << 26 })
let i = 0
for (const n of names) {
  const nl = out.indexOf(10, i)
  const head = out.subarray(i, nl).toString('utf8')
  i = nl + 1
  if (head.endsWith(' missing')) { text[n] = null; continue }
  const size = Number(head.split(' ')[2])
  text[n] = out.subarray(i, i + size).toString('utf8').replace(/\s+/g, ' ')
  i += size + 1
}
const fails = []
for (const s of specs) {
  // The REVIEW.md seed left the scaffold, so the release that removed it has no seed to lack the phrase; the release
  // before must still hold it.
  if (text[s.at] === undefined || text[s.at] === null) { if (s.file !== 'REVIEW.md') fails.push(`${s.phrase} @ ${s.file}: no seed at ${s.at}`) }
  else if (text[s.at].includes(s.phrase)) fails.push(`${s.phrase} @ ${s.file}: the seed of its release still holds it (${s.at})`)
  if (!s.before) fails.push(`${s.phrase} @ ${s.file}: no release before its version`)
  else if (!text[s.before] || !text[s.before].includes(s.phrase)) fails.push(`${s.phrase} @ ${s.file}: the seed of the release before does not hold it (${s.before})`)
}
process.stdout.write(fails.join('\n'))
'@
    $histFails = (& $nodeExe -e $histCode $canonRoot ($specs | ConvertTo-Json -Compress -AsArray) 2>&1 | Out-String).Trim()
    $ok = (Assert-True '3b each row version against the release tags: its release seed lacks the phrase, the release before holds it' `
            (-not $histFails) $histFails) -and $ok
}

$retFiles = [ordered]@{}
foreach ($row in $retiredRows) { foreach ($f in $row.files) { if (-not $retFiles.Contains($f)) { $retFiles[$f] = @() }; $retFiles[$f] += $row.phrase } }
New-Item -ItemType Directory -Force -Path (Join-Path $cp '.claude') | Out-Null
foreach ($f in $retFiles.Keys) {
    $lines = $retFiles[$f]
    if ($f -eq 'CLAUDE.md') { Set-CopyClaude (($lines | ForEach-Object { '- ' + ($_ -replace ' ', "`n  ") }) -join "`n"); continue }
    Add-Content -LiteralPath (Join-Path $cp $f) -Value (($lines | ForEach-Object { "- $_" }) -join "`n")
}
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$retPatterns = @("seed 파일 $($retFiles.Count)개", '직접 고쳐야', [regex]::Escape((Join-Path 'harness-init' 'templates')))
$ok = (Assert-Nudge '3b every retired phrase in every file it names: one line names each file, no drift' $out $retPatterns `
        @('SCHEMA DRIFT', 'EXTRACTION DRIFT', '템플릿과 다릅니다', '\+\d+ more')) -and $ok
$j3b = ConvertFrom-Json $out.Trim()
$sys3b = [string]$j3b.systemMessage
$ctx3b = [string]$j3b.hookSpecificOutput.additionalContext
$rowFails = @()
foreach ($row in $retiredRows) {
    $item = "``$($row.phrase)``: v$($row.version), ywr-harness ADR $($row.adr)"
    $n = ([regex]::Matches($sys3b, [regex]::Escape($item))).Count
    if ($n -ne @($row.files).Count) { $rowFails += "$($row.phrase): $n hits in the line (want $(@($row.files).Count))" }
}
$lastPart = $ctx3b.Substring($ctx3b.LastIndexOf("`n`n") + 2)
if (-not $lastPart.StartsWith('Retired seed text (ywr-harness ADR 0207): ')) { $rowFails += 'the retired part is not the last part of additionalContext' }
foreach ($i in 1, 2) { if (-not $ctx3b.Contains($sliceRuleLines[$i])) { $rowFails += "slice rule $i is not restated although its copy holds retired text" } }
if ($ctx3b.Length -gt 9000 -or $sys3b.Length -gt 9000) { $rowFails += "a string is long: ctx $($ctx3b.Length), sys $($sys3b.Length) (the host caps each at 10,000)" }
$ok = (Assert-True '3b each row fires once per file, the once and close rules are restated, the retired part is last' (-not $rowFails) ($rowFails -join ' · ')) -and $ok

# The same repo with one toolchain drift: the drift banner first, the retired line after a newline; the context
# keeps the drift text first and the retired part last.
Add-Content -LiteralPath (Join-Path $cp 'docs/build.sh') -Value '# drift'
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$ok = (Assert-Nudge '3b drift and retired text: both lines' $out @('1개의 벤더링된 툴체인 파일', 'docs/build\.sh', "seed 파일 $($retFiles.Count)개") `
        @('SCHEMA DRIFT', 'EXTRACTION DRIFT', '\(missing\)')) -and $ok
$j3c = ConvertFrom-Json $out.Trim()
$sysLines = ([string]$j3c.systemMessage) -split "`n"
$ctx3c = [string]$j3c.hookSpecificOutput.additionalContext
$ok = (Assert-True '3b drift and retired text: two banner lines in that order, the drift context first and the retired part last' `
        ($sysLines.Count -eq 2 -and $sysLines[0].Contains('툴체인 파일') -and $sysLines[1].Contains('seed 파일') -and
        $ctx3c.StartsWith('The repo at ') -and $ctx3c.Substring($ctx3c.LastIndexOf("`n`n") + 2).StartsWith('Retired seed text')) `
        "sys: [$($j3c.systemMessage)]") -and $ok
# Restore the copy for the 3a cases below.
Copy-Item -LiteralPath (Join-Path $fresh 'docs/build.sh') -Destination (Join-Path $cp 'docs/build.sh') -Force
foreach ($f in $retFiles.Keys) {
    if (Test-Path -LiteralPath (Join-Path $fresh $f)) { Copy-Item -LiteralPath (Join-Path $fresh $f) -Destination (Join-Path $cp $f) -Force }
    elseif (Test-Path -LiteralPath (Join-Path $cp $f)) { Remove-Item -LiteralPath (Join-Path $cp $f) -Force }   # a retired file that no scaffold places
}
Remove-Item -LiteralPath (Join-Path $cp '.claude') -Recurse -Force

Set-CopyClaude '- Notes: `node scripts/harness/slice_note.mjs add <decision|rejected|owner|fact|risk> "x"`'
$out = Invoke-Hook (New-Payload @{ cwd = $cp } 'compact')
$ok = (Assert-RuleOnly '3a slice-note copy only: the slice rules and the copy note' $out ($sliceRules + "`n`n" + $copyNote)) -and $ok

# The close rule's second copy marker (ADR 0201): CLAUDE.md holds ONLY the new close wording, 'main session calls it', and
# no 'owner-typed'. This piggybacks on the .claude/CLAUDE.md run (no extra hook run): the review rule is left out by its
# marker in that file, the close rule by the new wording in CLAUDE.md, and the once-per-slice, handoff and artifact rules stay.
Set-CopyClaude '- The close: the person types it, or the main session calls it after the ready report.'
New-Item -ItemType Directory -Force -Path (Join-Path $cp '.claude') | Out-Null
Set-Content -LiteralPath (Join-Path $cp '.claude/CLAUDE.md') -Value 'House review angles go in args.lensExtra.'
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$sliceRulesNoReviewNoClose = (@($sliceHead) + $sliceRuleLines[1], $sliceRuleLines[3], $sliceRuleLines[4]) -join "`n"
$ok = (Assert-RuleOnly '3a review-rule copy in .claude/CLAUDE.md and the new close wording alone (main session calls it, no owner-typed) in CLAUDE.md: the close and review rules are left out, the other rules and the slice-note rule stay, the copy note' $out ($sliceRulesNoReviewNoClose + "`n`n" + $noteRule + "`n`n" + $copyNote)) -and $ok
$ok = (Assert-True '3a the new-wording-only case: CLAUDE.md holds no owner-typed, the close rule text is absent from the output, the once-per-slice rule is present' `
    ((-not ([IO.File]::ReadAllText($cpClaude)).Contains('owner-typed')) -and ($out -notmatch 'The close: `/ywr-harness:slice-close`') -and ($out -match 'The review runs once per slice')) 'the premise of the new-wording case does not hold') -and $ok
Remove-Item -LiteralPath (Join-Path $cp '.claude') -Recurse -Force

Set-CopyClaude 'Run /code-review on PRs. We call slice_note.mjs add by hand.'
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$ok = (Assert-RuleOnly '3a a bare mention of the review command is no copy: the full text' $out) -and $ok

Set-CopyClaude 'Our REVIEW.md follows ywr-harness ADR 0054; see also ywr-harness ADR 0028, 0040, 0072, 0105, 0032, 0068 and ywr-harness ADR 0172.'
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$ok = (Assert-RuleOnly '3a ADR citations alone are no copy: the full text' $out) -and $ok

# 3d. The review canon (ADR 0215, ADR 0217), on the same copy. The seed declares the canon `CLAUDE.md`, a memory file
#     that the session loads at its start, so it needs no import: the rule only, even beside a root REVIEW.md that the
#     declaration does not name. The import cases below run on the legacy shape, a repo that older scaffolds seeded: a
#     root REVIEW.md that `.harness.json` declares as the canon. A CLAUDE.md that is a folder is no copy and imports
#     nothing: the full rule text, then the canon part, and one Korean line that names the canon. The last two cases
#     leave the canon undeclared: a root REVIEW.md then takes the default, and without it the default is CLAUDE.md.
$hjPath = Join-Path $cp '.harness.json'
$hjText = [IO.File]::ReadAllText($hjPath)
function Set-CopyCanon($Canon) {
    $h = $hjText | ConvertFrom-Json -AsHashtable
    if (-not $h.ContainsKey('review')) { $h['review'] = @{} }
    if ($null -eq $Canon) { $h['review'].Remove('canon') } else { $h['review']['canon'] = $Canon }
    [IO.File]::WriteAllText($hjPath, ($h | ConvertTo-Json -Depth 20))
}
Set-Content -LiteralPath (Join-Path $cp 'REVIEW.md') -Value "# Review canon`n`n1. An invariant.`n"
Set-CopyClaude ''
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$ok = (Assert-True '3d fixture: the seed declares canon CLAUDE.md and imports nothing' `
        ($hjText -match '"canon":\s*"CLAUDE\.md"' -and $seedText -notmatch '(^|\s)@\S') 'the seed no longer declares a memory-file canon or holds an @ import') -and $ok
$ok = (Assert-RuleOnly '3d a canon in CLAUDE.md needs no import, a root REVIEW.md the declaration does not name is not checked: the rule only' $out) -and $ok
Set-CopyCanon 'REVIEW.md'
Remove-Item -LiteralPath $cpClaude -Force
New-Item -ItemType Directory -Force -Path $cpClaude | Out-Null
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$canonFails = @()
if ($script:HookExit -ne 0) { $canonFails += "exit $script:HookExit" }
try {
    $j3d = ConvertFrom-Json $out.Trim()
    $sys3d = [string]$j3d.systemMessage; $ctx3d = [string]$j3d.hookSpecificOutput.additionalContext
    if ($sys3d -notmatch '^\[hook:scaffold-refresh-nudge\] .+review canon `REVIEW\.md`.+ywr-harness ADR 0215' -or $sys3d.Contains("`n")) { $canonFails += "systemMessage is not one canon line: [$sys3d]" }
    if (-not $sys3d.Contains('`## Review canon`') -or -not $sys3d.Contains('ywr-harness ADR 0217')) { $canonFails += "systemMessage does not name the `## Review canon` section and ywr-harness ADR 0217: [$sys3d]" }
    if (-not $ctx3d.StartsWith($ruleText + "`n`nReview canon import (ywr-harness ADR 0215, ywr-harness ADR 0217): ")) { $canonFails += "additionalContext is not the full rule, then the canon part: [$ctx3d]" }
    if (-not $ctx3d.Contains('## Review canon') -or -not $ctx3d.Contains('review.canon')) { $canonFails += "additionalContext does not name the section and the review.canon move: [$ctx3d]" }
} catch { $canonFails += 'stdout is not valid JSON' }
$ok = (Write-CaseVerdict -Name '3d a CLAUDE.md that is no file imports nothing: the full rule, the canon part last, one Korean line, exit 0' -Fail $canonFails -Detail $out) -and $ok
# Each trap loaded nothing on host 2.1.331 (fact 250): a span over two lines, a ~~~ line inside a backtick
# fence, an indented block after a blank line. The same canon part follows.
New-Item -ItemType Directory -Force -Path (Join-Path $cp '.claude') | Out-Null
Set-Content -LiteralPath (Join-Path $cp '.claude/CLAUDE.md') -Value ("A span ``starts`n@../REVIEW.md ends`` here.`n`n" + '```md' + "`n~~~`n@../REVIEW.md`n" + '```' + "`n`nCode:`n`n    @../REVIEW.md`n")
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$j3t = $null; try { $j3t = ConvertFrom-Json $out.Trim() } catch { }
$ok = (Assert-True '3d code in .claude/CLAUDE.md imports nothing: the canon line and part' `
        ($null -ne $j3t -and ([string]$j3t.systemMessage) -match 'review canon `REVIEW\.md`' -and ([string]$j3t.hookSpecificOutput.additionalContext).Contains("`n`nReview canon import (ywr-harness ADR 0215, ywr-harness ADR 0217): ")) $out) -and $ok
# A fenced block ends the paragraph before it, so an indented line right after the closing fence is code with no
# blank line between (dist #18). Mutation anchor: a closing fence that leaves the blank state alone keeps the line.
Set-Content -LiteralPath (Join-Path $cp '.claude/CLAUDE.md') -Value ("para text`n" + '```' + "`ncode`n" + '```' + "`n    @../REVIEW.md`n")
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$j3f = $null; try { $j3f = ConvertFrom-Json $out.Trim() } catch { }
$ok = (Assert-True '3d an indented line right after a closing fence imports nothing: the canon line and part' `
        ($null -ne $j3f -and ([string]$j3f.systemMessage) -match 'review canon `REVIEW\.md`' -and ([string]$j3f.hookSpecificOutput.additionalContext).Contains("`n`nReview canon import (ywr-harness ADR 0215, ywr-harness ADR 0217): ")) $out) -and $ok
# An ATX heading, a setext underline and a thematic break at column 0 end the paragraph too (fact 256). Mutation
# anchor: dropping any one of the three keeps its line, and the hook prints the rule only.
Set-Content -LiteralPath (Join-Path $cp '.claude/CLAUDE.md') -Value ("# Head`n    @../REVIEW.md`n`nSetext`n===`n    @../REVIEW.md`n`n***`n    @../REVIEW.md`n")
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$j3h = $null; try { $j3h = ConvertFrom-Json $out.Trim() } catch { }
$ok = (Assert-True '3d an indented line right after a heading, a setext underline or a thematic break imports nothing: the canon line and part' `
        ($null -ne $j3h -and ([string]$j3h.systemMessage) -match 'review canon `REVIEW\.md`' -and ([string]$j3h.hookSpecificOutput.additionalContext).Contains("`n`nReview canon import (ywr-harness ADR 0215, ywr-harness ADR 0217): ")) $out) -and $ok
# Inside a list item the closing fence is indented, and the next indented line is item text that the host loads
# (fact 256). Mutation anchor: a closing fence that ends the paragraph at any indent drops the line.
Set-Content -LiteralPath (Join-Path $cp '.claude/CLAUDE.md') -Value ("- item`n  " + '```' + "`n  x`n  " + '```' + "`n    @../REVIEW.md`n")
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$ok = (Assert-RuleOnly '3d an indented line after a fence inside a list item imports: the rule only' $out) -and $ok
# The next case proves the CLAUDE.local.md import alone, so this file must import nothing again.
Set-Content -LiteralPath (Join-Path $cp '.claude/CLAUDE.md') -Value 'No import here.'
# An import in CLAUDE.local.md counts: the session loads it.
Set-Content -LiteralPath (Join-Path $cp 'CLAUDE.local.md') -Value 'Mine: @REVIEW.md'
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$ok = (Assert-RuleOnly '3d CLAUDE.local.md imports @REVIEW.md: the rule only' $out) -and $ok
Remove-Item -LiteralPath (Join-Path $cp 'CLAUDE.local.md') -Force
# The import resolves against the importing file: `@../REVIEW.md` in .claude/CLAUDE.md is the root canon.
Set-Content -LiteralPath (Join-Path $cp '.claude/CLAUDE.md') -Value 'Invariants: @../REVIEW.md'
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$ok = (Assert-RuleOnly '3d .claude/CLAUDE.md imports @../REVIEW.md: the rule only' $out) -and $ok
Remove-Item -LiteralPath (Join-Path $cp '.claude') -Recurse -Force
# A declared canon that does not exist is not checked: the emitter names it NOT FOUND instead.
Set-CopyCanon 'docs/NO-SUCH-CANON.md'
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$ok = (Assert-RuleOnly '3d a declared canon that does not exist: the rule only' $out) -and $ok
Remove-Item -LiteralPath $cpClaude -Recurse -Force
Set-CopyClaude ''
# No `review.canon` and a root REVIEW.md that nothing imports: the default is that file, so the canon line names it.
Set-CopyCanon $null
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$j3u = $null; try { $j3u = ConvertFrom-Json $out.Trim() } catch { }
$ok = (Assert-True '3d an undeclared canon beside a root REVIEW.md that nothing imports: the canon line and part name REVIEW.md' `
        ($null -ne $j3u -and ([string]$j3u.systemMessage) -match 'review canon `REVIEW\.md`' -and ([string]$j3u.hookSpecificOutput.additionalContext).Contains('the review canon `REVIEW.md` that .harness.json names')) $out) -and $ok
# No `review.canon` and no REVIEW.md: the default is CLAUDE.md, a memory file, so the rule only.
Remove-Item -LiteralPath (Join-Path $cp 'REVIEW.md') -Force
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$ok = (Assert-RuleOnly '3d an undeclared canon and no REVIEW.md: the default is CLAUDE.md, the rule only' $out) -and $ok
[IO.File]::WriteAllText($hjPath, $hjText)

Remove-Item -LiteralPath (Join-Path $cp '.harness.json') -Force
$out = Invoke-Hook (New-Payload @{ cwd = $cp })
$ok = (Assert-RuleOnly '3a no .harness.json: the slice-note rule alone' $out $noteRule) -and $ok

# 4. line-ending-only difference -> silent: the seed .gitattributes makes CRLF/LF checkout
#    variance legitimate, so raw byte identity would nudge every clone forever
$out = Invoke-Hook (New-Payload @{ cwd = $crlf })
$ok = (Assert-RuleOnly 'CRLF-only difference is no drift (the rule only)' $out) -and $ok

# 4b. EXACT bytes modulo CR (ADR 0033): "everything else — content, encoding, BOM — stays exact". The
#     pwsh original compared with `-ne`, which ignores letter case and the culture-ignorable U+00AD and
#     NUL, so those three differences passed as identical; the Node port compares ordinally, and each
#     is drift here. A leading BOM is the encoding case the contract names.
function Add-ByteVariant([string]$Name, [scriptblock]$Mutate) {
    $d = Join-Path $fx $Name
    Copy-Item -LiteralPath $base -Destination $d -Recurse -Force
    $p = Join-Path $d 'docs/build.sh'
    [IO.File]::WriteAllBytes($p, [byte[]](& $Mutate ([IO.File]::ReadAllBytes($p))))
    return $d
}
$byteCases = @(
    @{ N = 'a letter-case-only difference is drift'; Mutate = { param($b) $b = [byte[]]$b.Clone(); for ($i = 0; $i -lt $b.Length; $i++) { if ($b[$i] -ge 97 -and $b[$i] -le 122) { $b[$i] -= 32; break } }; $b } },
    @{ N = 'an appended NUL byte is drift'; Mutate = { param($b) $b + [byte[]]@(0) } },
    @{ N = 'an appended U+00AD (soft hyphen as a Latin1 byte) is drift'; Mutate = { param($b) $b + [byte[]]@(0xAD) } },
    @{ N = 'a leading UTF-8 BOM is drift'; Mutate = { param($b) [byte[]]@(0xEF, 0xBB, 0xBF) + $b } },
    @{ N = 'a lone CR is only a line-ending difference, never drift'; Mutate = { param($b) $b + [byte[]]@(13, 13) }; Silent = $true }
)
$bci = 0
foreach ($bc in $byteCases) {
    $bci++
    $bd = Add-ByteVariant "repo-bytes$bci" $bc.Mutate
    $out = Invoke-Hook (New-Payload @{ cwd = $bd })
    if ($bc.Silent) { $ok = (Assert-RuleOnly "4b $($bc.N)" $out) -and $ok }
    else {
        $ok = (Assert-Nudge "4b $($bc.N)" $out @('1개의 벤더링된 툴체인 파일', 'docs/build\.sh') `
                @('SCHEMA DRIFT', 'EXTRACTION DRIFT', '\(missing\)', '\(unreadable\)')) -and $ok
    }
}

# 5. marker-less post-commit -> no drift (the rule only, no nudge): init.mjs refuses a foreign file, so a re-run would
#    change nothing — a nudge here would nag forever (the 0029 foreign-value shape)
$out = Invoke-Hook (New-Payload @{ cwd = $foreignpc })
$ok = (Assert-RuleOnly 'foreign post-commit is no drift (the rule only)' $out) -and $ok

# 6. marker-carrying post-commit drifted -> counted like any toolchain file
$out = Invoke-Hook (New-Payload @{ cwd = $ourspc })
$ok = (Assert-Nudge 'guarded post-commit with marker counts' $out `
        @('1개의 벤더링된 툴체인 파일', '\.githooks[\\/]post-commit') `
        @('harness_gates\.mjs', 'SCHEMA DRIFT', '\(missing\)')) -and $ok

# 7. seven drifts -> five named, cap STATED (a silent truncation reads as full coverage)
$out = Invoke-Hook (New-Payload @{ cwd = $many })
$ok = (Assert-Nudge 'file list caps at five and says so' $out `
        @('7개의 벤더링된 툴체인 파일', '\+2 more') `
        @('SCHEMA DRIFT', 'harness_config\.mjs')) -and $ok

# 8. scripts/harness/ that is not ours -> silent (file-level sentinel, not the directory gate:
#    counting a stranger's tree as "all missing" would be a false nudge)
$out = Invoke-Hook (New-Payload @{ cwd = $notours })
$ok = (Assert-EmptyStdout 'foreign scripts/harness silent' $out) -and $ok

# 8b. a repo that holds only a Python script an older scaffold placed (no .mjs yet) is still ours: it is the repo
#     this nudge must tell to refresh (ywr-harness ADR 0223)
$oldpy = Join-Path $fx 'repo-oldpy'
New-Item -ItemType Directory -Force -Path (Join-Path $oldpy 'scripts/harness') | Out-Null
Set-Content -LiteralPath (Join-Path $oldpy 'scripts/harness/harness_gates.py') -Value 'pass'
if ($gitOk) { & git -c init.defaultBranch=main init -q $oldpy 2>$null | Out-Null }
$out = Invoke-Hook (New-Payload @{ cwd = $oldpy })
$ok = (Assert-Nudge '8b a repo with only the old .py scaffold script still gets the nudge' $out `
        @('\[hook:scaffold-refresh-nudge\]', 'repo-oldpy', '벤더링된 툴체인 파일', 'docs/README\.md \(missing\)') `
        @('SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok

# A `node -r` preload that wraps spawnSync and logs each git call, so "spawns no git" is observed, not assumed.
$spyLog = Join-Path $fx 'git-spy.log'
$spyPre = Join-Path $fx 'git-spy.cjs'
@"
const cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path')
const real = cp.spawnSync
cp.spawnSync = function (cmd) {
  const base = path.basename(String(cmd)).toLowerCase()
  if (base === 'git' || base === 'git.exe') fs.appendFileSync(process.env.YWR_SPY_LOG, 'git\n')
  return real.apply(this, arguments)
}
"@ | Set-Content -LiteralPath $spyPre -Encoding utf8
function Invoke-SpiedHook([string]$Cwd) {
    $env:YWR_SPY_LOG = $spyLog
    Remove-Item -LiteralPath $spyLog -Force -ErrorAction SilentlyContinue
    try { $o = (New-Payload @{ cwd = $Cwd } | & $nodeExe -r $spyPre $hook 2>&1 | Out-String) }
    finally { Remove-Item Env:YWR_SPY_LOG -ErrorAction SilentlyContinue }
    $script:HookExit = $LASTEXITCODE
    $script:GitCalls = if (Test-Path -LiteralPath $spyLog) { @(Get-Content -LiteralPath $spyLog).Count } else { 0 }
    return $o
}

# 9. repo without scripts/harness -> silent, and the walk up from cwd finds no scripts/harness/, so no git call
$out = Invoke-SpiedHook $bare
$ok = (Assert-EmptyStdout 'unscaffolded repo silent' $out) -and $ok
$ok = (Assert-True 'unscaffolded repo spawns no git' ($script:GitCalls -eq 0) "$script:GitCalls git call(s)") -and $ok

# 10. subdirectory cwd -> the ROOT is resolved and named (needs git; reported SKIP without)
if ($gitOk) {
    $out = Invoke-Hook (New-Payload @{ cwd = (Join-Path $stale 'subA/subB') })
    $ok = (Assert-Nudge 'subdirectory cwd resolves the root' $out `
            @('repo-stale', '2개의 벤더링된 툴체인 파일') `
            @('subA', 'SCHEMA DRIFT')) -and $ok
}
else {
    Write-Host 'SKIP — git not on PATH; subdirectory-resolution case not run (reported, not silent)' -ForegroundColor Yellow
}

# 10b. UPSTREAM-AHEAD (ADR 0135): a teammate refreshed the scaffold and pushed; this clone has not pulled.
#      The probe's path is the stamp ALONE (10b-5: a toolchain-only upstream commit is a hand edit, no hit),
#      its walk is patch-equivalence filtered (10b-6: an amended stamp commit is no hit), and repo-AHEAD keeps
#      precedence over a hit (10b-8).
#      Its own stamp is the OLD one, so without the probe the ADR 0042 branch says "genuinely behind, re-run
#      init" — the wrong remedy, the right one is to pull. ONE bare remote and TWO clones carry every leg:
#      clone A (stamp 0.0.1, one drifted toolchain file) is the session under test, clone B pushes the
#      refresh (the canon's file and the real stamp). The remaining legs only move A's refs and branch.
#      The no-remote leg is every drifted fixture above (no remote, unborn HEAD): their 0033/0042 assertions
#      stay unchanged and case 1 below adds the new text to its MustNotMatch.
if ($gitOk) {
    function Invoke-UaGit([string]$Dir, [string[]]$GitArgs) {
        & git -C $Dir -c user.name=selftest -c user.email=selftest@example.invalid -c commit.gpgsign=false @GitArgs 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "fixture git failed (exit $LASTEXITCODE): git $($GitArgs -join ' ') in $Dir" }
    }
    $uaRemote = Join-Path $fx 'up-remote.git'
    & git -c init.defaultBranch=main init -q --bare $uaRemote 2>$null | Out-Null
    $uaA = Join-Path $fx 'up-a'
    $uaB = Join-Path $fx 'up-b'
    Copy-Item -LiteralPath $base -Destination $uaA -Recurse -Force
    Add-Content -LiteralPath (Join-Path $uaA 'scripts/harness/harness_gates.mjs') -Value '# selftest drift'
    Set-Content -LiteralPath (Join-Path $uaA '.harness-version') -Value '0.0.1'
    Invoke-UaGit $uaA @('config', '--local', '--unset', 'core.hooksPath')   # init.mjs wired the scaffold's hooks; the fixture commits bypass them
    Invoke-UaGit $uaA @('add', '-A')
    Invoke-UaGit $uaA @('commit', '-q', '-m', 'A: scaffold at an old stamp')
    Invoke-UaGit $uaA @('remote', 'add', 'origin', $uaRemote)
    Invoke-UaGit $uaA @('push', '-q', '-u', 'origin', 'main')
    Invoke-UaGit $fx @('clone', '-q', $uaRemote, $uaB)
    Copy-Item -LiteralPath (Join-Path $base 'scripts/harness/harness_gates.mjs') -Destination (Join-Path $uaB 'scripts/harness/harness_gates.mjs') -Force
    Set-Content -LiteralPath (Join-Path $uaB '.harness-version') -Value $mfVer
    Invoke-UaGit $uaB @('add', '-A')
    Invoke-UaGit $uaB @('commit', '-q', '-m', 'B: scaffold refresh')
    Invoke-UaGit $uaB @('push', '-q', 'origin', 'main')

    # 10b-1. NOT fetched: A's refs know nothing of B's push, so today's advice stands — the documented
    #        freshness limit (refs are as of the last fetch), and the proof the probe makes no network call.
    $out = Invoke-Hook (New-Payload @{ cwd = $uaA })
    $ok = (Assert-Nudge '10b-1 unfetched refs: no hit, the stamp-direction advice stands (freshness limit)' $out `
            @('1개의 벤더링된 툴체인 파일', 'OLDER합니다', '리프레시: 이 저장소에서 /ywr-harness:harness-init') `
            @('ADR 0135', 'fetch', '다른 클론', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok

    # 10b-2. fetched: the upstream (origin/main) carries B's commit -> upstream-ahead replaces ALL the direction
    #        branches. The ref, the newest sha and a date are named; init is forbidden in both halves; the OLDER /
    #        "re-run" advice is gone. The model half says not to run or suggest init and to offer pulling.
    Invoke-UaGit $uaA @('fetch', '-q', 'origin')
    $uaSha = (& git -C $uaA log -1 --format=%h origin/main 2>$null | Out-String).Trim()
    $out = Invoke-Hook (New-Payload @{ cwd = $uaA })
    $ok = (Assert-Nudge '10b-2 fetched upstream ahead: pull first, never re-run init (ADR 0135)' $out `
            @('1개의 벤더링된 툴체인 파일', 'harness_gates\.mjs', 'origin/main', [regex]::Escape($uaSha), '\d{4}-\d{2}-\d{2}', '다른 클론이',
            '/ywr-harness:harness-init을 실행하지 마세요', 'pull', '마지막 fetch', 'ADR 0135',
            'Do NOT run or suggest /ywr-harness:harness-init', 'Offer pulling', '제안만 합니다') `
            @('OLDER합니다', '측정된 것입니다', '리프레시: 이 저장소에서', 'genuinely behind', 'NEWER합니다', 'EQUALS',
            'direction-blind', '기준이 STALE', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok
    $ok = (Assert-RuleTail '10b-2 upstream-ahead branch: the rule follows the drift text' $out) -and $ok
    $ok = (Assert-True '10b-2 the sha named is the fetched tip' ($uaSha -match '^[0-9a-f]{4,}$') "sha='$uaSha'") -and $ok

    # 10b-3. a feature branch with NO upstream and no origin/HEAD: no candidate ref -> no hit (today's advice) ...
    Invoke-UaGit $uaA @('checkout', '-q', '-b', 'feature')
    # git 2.48+ creates origin/HEAD on the first fetch (remote.<name>.followRemoteHEAD), so drop it here.
    & git -C $uaA symbolic-ref --quiet --delete refs/remotes/origin/HEAD 2>$null | Out-Null
    & git -C $uaA rev-parse --symbolic-full-name '@{upstream}' 2>$null | Out-Null
    $noUp = ($LASTEXITCODE -ne 0)
    & git -C $uaA symbolic-ref --quiet refs/remotes/origin/HEAD 2>$null | Out-Null
    $ok = (Assert-True '10b-3 fixture: the feature branch has no upstream and no origin/HEAD' ($noUp -and $LASTEXITCODE -ne 0) 'the leg below would test a candidate ref, not the empty list') -and $ok
    $out = Invoke-Hook (New-Payload @{ cwd = $uaA })
    $ok = (Assert-Nudge '10b-3 no upstream and no origin/HEAD: no candidate ref, no hit' $out `
            @('OLDER합니다', '리프레시: 이 저장소에서 /ywr-harness:harness-init') @('ADR 0135', '다른 클론', 'SCHEMA DRIFT')) -and $ok
    # ... and with origin/HEAD set, the remote default branch is the second candidate: the same hit.
    Invoke-UaGit $uaA @('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    $out = Invoke-Hook (New-Payload @{ cwd = $uaA })
    $ok = (Assert-Nudge '10b-4 no upstream, origin/HEAD ahead: the remote default branch hits' $out `
            @('origin/main', [regex]::Escape($uaSha), 'ADR 0135', '/ywr-harness:harness-init을 실행하지 마세요', 'Offer pulling') `
            @('OLDER합니다', '리프레시: 이 저장소에서', 'SCHEMA DRIFT')) -and $ok

    # The legs below put A on B's pushed tip (stamp = the running version, canon files) and re-add the drift as an
    # UNCOMMITTED edit, so the stamp equals the running version (the ADR 0042 EQUALS / hand-edit branch is the no-hit
    # baseline) and only the REMOTE moves between legs. origin/HEAD stays set, so origin/main is the candidate ref.
    Invoke-UaGit $uaA @('reset', '-q', '--hard', 'origin/main')
    Add-Content -LiteralPath (Join-Path $uaA 'scripts/harness/harness_gates.mjs') -Value '# selftest drift'
    $uaStampPath = Join-Path $uaA '.harness-version'
    $uaStampText = Get-Content -LiteralPath $uaStampPath -Raw

    # 10b-5. a toolchain-only upstream commit (a hand edit on main — no stamp change) is NOT a scaffold run: no hit,
    #        the equal-version hand-edit advice stands.
    Add-Content -LiteralPath (Join-Path $uaB 'scripts/harness/harness_gates.mjs') -Value '# upstream hand edit'
    Invoke-UaGit $uaB @('add', '-A')
    Invoke-UaGit $uaB @('commit', '-q', '-m', 'B: hand edit of a toolchain file')
    Invoke-UaGit $uaB @('push', '-q', 'origin', 'main')
    Invoke-UaGit $uaA @('fetch', '-q', 'origin')
    $uaToolOnly = (& git -C $uaA log -1 --format=%h HEAD..origin/main 2>$null | Out-String).Trim()
    $ok = (Assert-True '10b-5 fixture: origin/main is ahead by a commit that leaves the stamp alone' `
            ($uaToolOnly -match '^[0-9a-f]{4,}$' -and -not (& git -C $uaA log -1 --format=%h HEAD..origin/main -- .harness-version 2>$null)) "tool-only='$uaToolOnly'") -and $ok
    $out = Invoke-Hook (New-Payload @{ cwd = $uaA })
    $ok = (Assert-Nudge '10b-5 toolchain-only upstream commit: no hit, the hand-edit advice stands (stamp is the only path)' $out `
            @('1개의 벤더링된 툴체인 파일', 'harness_gates\.mjs', 'EQUALS', 'hand-edit') `
            @('ADR 0135', '다른 클론', '/ywr-harness:harness-init을 실행하지 마세요', 'SCHEMA DRIFT')) -and $ok

    # 10b-6. patch-equivalence: A amends the commit that carries the stamp (a rebase does the same). The pre-rewrite commit is
    #        still on origin/main, but HEAD carries its patch: NOT upstream-ahead. The plain walk is the control.
    Invoke-UaGit $uaA @('commit', '-q', '--amend', '-m', 'A: the stamp commit, amended')
    $ok = (Assert-True '10b-6 fixture: a plain walk still sees the pre-rewrite stamp commit (only --cherry-pick explains the silence)' `
            ([bool](& git -C $uaA log -1 --format=%h HEAD..origin/main -- .harness-version 2>$null)) 'the amend did not diverge from origin/main') -and $ok
    $out = Invoke-Hook (New-Payload @{ cwd = $uaA })
    $ok = (Assert-Nudge '10b-6 an amended stamp commit is patch-equivalent: no hit' $out `
            @('harness_gates\.mjs', 'EQUALS', 'hand-edit') @('ADR 0135', '다른 클론', 'SCHEMA DRIFT')) -and $ok

    # 10b-7. positive control: B pushes a NEW stamp commit the clone lacks -> the hit replaces the equal-version branch.
    Set-Content -LiteralPath (Join-Path $uaB '.harness-version') -Value '0.0.9'
    Invoke-UaGit $uaB @('add', '-A')
    Invoke-UaGit $uaB @('commit', '-q', '-m', 'B: a new stamp commit')
    Invoke-UaGit $uaB @('push', '-q', 'origin', 'main')
    Invoke-UaGit $uaA @('fetch', '-q', 'origin')
    $uaNew = (& git -C $uaA log -1 --format=%h origin/main 2>$null | Out-String).Trim()
    $out = Invoke-Hook (New-Payload @{ cwd = $uaA })
    $ok = (Assert-Nudge '10b-7 a new upstream stamp commit hits and replaces the equal-version branch' $out `
            @('origin/main', [regex]::Escape($uaNew), 'ADR 0135', '/ywr-harness:harness-init을 실행하지 마세요', 'Offer pulling') `
            @('EQUALS', 'hand-edit', 'SCHEMA DRIFT')) -and $ok

    # 10b-8. F2: with that hit standing, a repo-AHEAD stamp (newer than the running plugin) keeps the ADR 0042 AHEAD advice —
    #        "update the plugin, do NOT init" — and the hit does not replace it. Only the working-tree stamp changes.
    Set-Content -LiteralPath $uaStampPath -Value '99.0.0'
    $out = Invoke-Hook (New-Payload @{ cwd = $uaA })
    $ok = (Assert-Nudge '10b-8 repo-AHEAD keeps precedence over an upstream hit (ADR 0042 advice, no pull-first)' $out `
            @('1개의 벤더링된 툴체인 파일', 'v99\.0\.0', 'NEWER합니다', 'AHEAD', 'REVERT', '/ywr-harness:update',
            'Do NOT run or suggest /ywr-harness:harness-init', 'NEWER than this session', 'ADR 0042', '제안만 합니다') `
            @('ADR 0135', '다른 클론', 'Offer pulling', '마지막 fetch', 'OLDER합니다', 'EQUALS', 'direction-blind', 'SCHEMA DRIFT')) -and $ok
    [System.IO.File]::WriteAllText($uaStampPath, $uaStampText)
}
else {
    Write-Host 'SKIP [10b] git not on PATH; upstream-ahead cases not run (reported, not silent)' -ForegroundColor Yellow
}

# 11. BOM-prefixed stdin -> still parses (the config-change-audit 07-23 incident class)
$out = Invoke-Hook ([char]0xFEFF + (New-Payload @{ cwd = $stale }))
$ok = (Assert-Nudge 'BOM-prefixed stdin' $out @('repo-stale') @('SCHEMA DRIFT')) -and $ok

# 11b. PowerShell semantics the Node port keeps (ADR 0116): member access and the event compare are
#      case-insensitive, `[string]` casts the cwd and `.Trim()` strips it.
$out = Invoke-Hook (@{ Hook_Event_Name = 'sessionstart'; CWD = $stale } | ConvertTo-Json -Compress)
$ok = (Assert-Nudge 'case-drifted keys and event name still read' $out @('repo-stale', '2개의 벤더링된 툴체인 파일') @('SCHEMA DRIFT')) -and $ok
$out = Invoke-Hook (New-Payload @{ cwd = "  $stale `t " })
$ok = (Assert-Nudge 'cwd padded with whitespace is trimmed' $out @('repo-stale', '2개의 벤더링된 툴체인 파일') @('SCHEMA DRIFT')) -and $ok

# 11c. a non-ASCII work tree path: git's output is decoded as UTF-8 once with quotepath off (CLAUDE.md,
#      issue #40), and the files under it are read by path — so the verdict and the name are intact.
if ($gitOk) {
    $uni = Join-Path $fx 'repo-유니코드 é'
    Copy-Item -LiteralPath $stale -Destination $uni -Recurse -Force
    $out = Invoke-Hook (New-Payload @{ cwd = $uni })
    $ok = (Assert-Nudge 'non-ASCII work tree path is named intact and compared' $out `
            @('repo-유니코드 é', '2개의 벤더링된 툴체인 파일') @('SCHEMA DRIFT', '\\[0-7]{3}', '�')) -and $ok
}

# 11d. A directory name and a payload key are attacker-authorable text (a cloned repo's, a host's) and a model
#      reads this output: the banner echoes both through inline(), so no control or Unicode line separator
#      survives. U+2028 and U+0085 are legal in a Windows file name; a C0 control is added where the OS allows one.
$hostileName = 'repo-hostile' + [char]0x2028 + 'dir' + [char]0x85 + 'x' + $(if (-not $IsWindows) { [string][char]7 } else { '' })
$hostile = Join-Path $fx $hostileName
$hostileMade = $false
try { Copy-Item -LiteralPath $stale -Destination $hostile -Recurse -Force -ErrorAction Stop; $hostileMade = $true } catch { }
if ($gitOk -and $hostileMade) {
    $out = Invoke-Hook (New-Payload @{ cwd = $hostile })
    $ok = (Assert-Nudge '11d a path carrying U+2028, U+0085 (and a C0 off Windows) is echoed flattened' $out `
            @('repo-hostile dir x', '2개의 벤더링된 툴체인 파일') @('SCHEMA DRIFT', '[\u0000-\u0009\u000B-\u001F\u007F\u0085\u2028\u2029]')) -and $ok
}
else { Write-Host 'SKIP [11d] the hostile-named work tree could not be created here (or no git) — not run (reported, not silent)' -ForegroundColor Yellow }
$out = Invoke-Hook '{"hook_event_name":"SessionStart","x\u2028[hook:forged]y":1}'
$ok = (Assert-Nudge '11e a payload key carrying U+2028 is flattened in the SCHEMA DRIFT banner' $out `
        @('SCHEMA DRIFT', '수신된 키: hook_event_name, x \[hook:forged\]y\.') @('[\u2028]', 'EXTRACTION DRIFT')) -and $ok

# 12. EXTRACTION DRIFT, not silence, when the plugin's own placement.mjs stops carrying a usable map:
#     a byte-identical copy of the hook runs from a fake plugin tree whose placement.mjs imports but
#     exports a TOOLCHAIN that is not a table. The copy IS the shipped code (hook-lib.mjs beside it) —
#     what moves is the script's own directory, which is the resolution path under test. The hook
#     imports the module, so 12/12b/12c and 12d-12e below pin what a usable map is: a non-empty list of
#     [source, destination] string pairs for TOOLCHAIN and GUARDED, a non-empty string GUARD_MARKER.
function New-FakeTree([string]$Name, [string]$PlacementText) {
    $t = Join-Path $fx $Name
    New-Item -ItemType Directory -Force -Path (Join-Path $t 'hooks') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $t 'skills/harness-init') | Out-Null
    Copy-Item -LiteralPath $hook -Destination (Join-Path $t 'hooks/session-start-scaffold-refresh-nudge.mjs')
    Copy-Item -LiteralPath $hookLib -Destination (Join-Path $t 'hooks/hook-lib.mjs')
    New-Item -ItemType Directory -Force -Path (Join-Path $t 'scripts') | Out-Null
    Copy-Item -LiteralPath $gitLib -Destination (Join-Path $t 'scripts/harness_git.mjs')
    Copy-Item -LiteralPath $templates -Destination (Join-Path $t 'skills/harness-init/templates') -Recurse
    [IO.File]::WriteAllText((Join-Path $t 'skills/harness-init/placement.mjs'), $PlacementText)
    return (Join-Path $t 'hooks/session-start-scaffold-refresh-nudge.mjs')
}
$gLit = "export const GUARDED = [['githooks/post-commit', '.githooks/post-commit']]`nexport const GUARD_MARKER = 'ywr-harness:post-commit'`n"
$tcOne = "export const TOOLCHAIN = [['scripts/harness/harness_gates.mjs', 'scripts/harness/harness_gates.mjs']]`n"
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) (New-FakeTree 'fake-broken' ("export const TOOLCHAIN = 'not a table'`n" + $gLit))
$ok = (Assert-Nudge 'unreadable placement map reports EXTRACTION DRIFT, not silence' $out `
        @('EXTRACTION DRIFT', 'UNKNOWN, 확인되지 않았습니다', '배치 맵') `
        @('템플릿과 다릅니다', '제안만 합니다', 'SCHEMA DRIFT', $ruleMark)) -and $ok   # $stale holds slice_note.mjs, yet no rule here

# 12b. a PARTIAL entry — a pair whose destination is not a string — must fail extraction WHOLE, never
#      contribute the fragment to the map (the ADR 0033 lesson: a fragment is a wrong path compared quietly).
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) (New-FakeTree 'fake-partial' ("export const TOOLCHAIN = [['scripts/harness/harness_gates.mjs', 'scripts/harness/' + 5]]`n" + $gLit))
$ok = (Assert-Nudge 'partial entry fails extraction whole, never a fragment' $out `
        @('EXTRACTION DRIFT', 'UNKNOWN, 확인되지 않았습니다', '배치 맵') `
        @('템플릿과 다릅니다', '\(missing\)', 'SCHEMA DRIFT')) -and $ok

# 12c. a fully valid map with NO scripts/harness/*.mjs destination -> the ownership sentinel
#      is gone; an unchecked empty list would silently disable the hook on every repo forever.
#      The banner, not silence, is the contract.
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) (New-FakeTree 'fake-nosentinel' ("export const TOOLCHAIN = [['docs/README.md', 'docs/README.md']]`n" + $gLit))
$ok = (Assert-Nudge 'sentinel-less map reports EXTRACTION DRIFT, not permanent silence' $out `
        @('EXTRACTION DRIFT', 'sentinel', 'UNKNOWN, 확인되지 않았습니다') `
        @('템플릿과 다릅니다', 'SCHEMA DRIFT')) -and $ok

# 13. a template missing from the plugin copy -> the same banner naming the file; freshness is
#     never resolved into a nudge from an incomplete comparison set
$fakeTmpl = Join-Path $fx 'fake-tmpl'
New-Item -ItemType Directory -Force -Path (Join-Path $fakeTmpl 'hooks') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $fakeTmpl 'skills/harness-init') | Out-Null
Copy-Item -LiteralPath $hook -Destination (Join-Path $fakeTmpl 'hooks/session-start-scaffold-refresh-nudge.mjs')
Copy-Item -LiteralPath $hookLib -Destination (Join-Path $fakeTmpl 'hooks/hook-lib.mjs')
New-Item -ItemType Directory -Force -Path (Join-Path $fakeTmpl 'scripts') | Out-Null
Copy-Item -LiteralPath $gitLib -Destination (Join-Path $fakeTmpl 'scripts/harness_git.mjs')
Copy-Item -LiteralPath $placement -Destination (Join-Path $fakeTmpl 'skills/harness-init/placement.mjs')
Copy-Item -LiteralPath $templates -Destination (Join-Path $fakeTmpl 'skills/harness-init/templates') -Recurse
Remove-Item -LiteralPath (Join-Path $fakeTmpl 'skills/harness-init/templates/docs/build_docs.mjs') -Force
$out = Invoke-Hook (New-Payload @{ cwd = $fresh }) (Join-Path $fakeTmpl 'hooks/session-start-scaffold-refresh-nudge.mjs')
$ok = (Assert-Nudge 'missing template reports EXTRACTION DRIFT naming the file' $out `
        @('EXTRACTION DRIFT', '템플릿이 없습니다', 'templates/docs/build_docs\.mjs') `
        @('템플릿과 다릅니다', 'SCHEMA DRIFT')) -and $ok

# 12d-12e. WHAT THE HOOK ACCEPTS. One fake plugin tree (real templates, the hook + hook-lib) per placement.mjs shape.
#     Accepted: a minimal table of two pairs, behind a comment and a computed-but-string-valued entry. Refused
#     (EXTRACTION DRIFT, never a fragment and never silence): an empty table, an entry of the wrong arity, a
#     source repeated in another letter case, a marker that is not a string, a missing GUARDED export, a module
#     that throws at import and a module that does not parse.
$tcDecoys = "// a comment above the table`nconst dir = 'scripts'`nexport const TOOLCHAIN = [`n  [dir + '/harness/harness_gates.mjs', 'scripts/harness/harness_gates.mjs'], // trailing comment`n  ['docs/README.md', 'docs/README.md'],`n]`n"
$ok = (Assert-Nudge '12d a minimal table behind a comment is read, and only its two files are compared' `
        (Invoke-Hook (New-Payload @{ cwd = $stale }) (New-FakeTree 'fake-decoys' ($tcDecoys + $gLit))) `
        @('1개의 벤더링된 툴체인 파일', 'harness_gates\.mjs') @('EXTRACTION DRIFT', 'SCHEMA DRIFT', 'harness-gates\.yml', 'decoy')) -and $ok
$refused = [ordered]@{
    'an empty table'                        = ("export const TOOLCHAIN = []`n" + $gLit)
    'an entry of the wrong arity'           = ("export const TOOLCHAIN = [['scripts/harness/harness_gates.mjs']]`n" + $gLit)
    'a source repeated in another letter case' = ("export const TOOLCHAIN = [['scripts/harness/harness_gates.mjs', 'scripts/harness/harness_gates.mjs'], ['SCRIPTS/harness/harness_gates.mjs', 'scripts/harness/harness_gates.mjs']]`n" + $gLit)
    'a marker that is not a string'         = ($tcOne + "export const GUARDED = [['githooks/post-commit', '.githooks/post-commit']]`nexport const GUARD_MARKER = ['ywr-harness:post-commit']`n")
    'a missing GUARDED export'              = ($tcOne + "export const GUARD_MARKER = 'ywr-harness:post-commit'`n")
    'a module that throws at import'        = ($tcOne + $gLit + "throw new Error('boom')`n")
    'a module that does not parse'          = ($tcOne + $gLit + "export const BROKEN = [`n")
}
$rfi = 0
foreach ($name in $refused.Keys) {
    $rfi++
    $out = Invoke-Hook (New-Payload @{ cwd = $stale }) (New-FakeTree "fake-refused$rfi" $refused[$name])
    $ok = (Assert-Nudge "12e $name -> EXTRACTION DRIFT, never a fragment or silence" $out `
            @('EXTRACTION DRIFT', 'UNKNOWN, 확인되지 않았습니다') @('템플릿과 다릅니다', '\(missing\)', 'SCHEMA DRIFT')) -and $ok
}

# 13b-13f. STALE-BASIS PROBE (ADR 0039): a byte-identical hook copy runs from a fake VERSIONED
#          CACHE layout (<plugins>/cache/<marketplace>/<name>/<version>) with the real placement.mjs
#          and templates beside it, so the drift verdict itself stays the real one (repo-stale's
#          2 files). What varies per case is the sibling installed_plugins.json — the probe's
#          only input. The running copy's plugin.json is pinned to 0.0.1 so assertions can tell
#          RUNNING (v0.0.1) from REGISTERED (v9.9.9) apart. Every one of these cases must still
#          produce a nudge — the probe may switch the advice, never silence the hook.
$fakePlugins = Join-Path $fx 'fake-plugins'
$staleCopy = Join-Path $fakePlugins 'cache/ywrlabs/ywr-harness/0.0.1'
New-Item -ItemType Directory -Force -Path (Join-Path $staleCopy 'hooks') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $staleCopy '.claude-plugin') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $staleCopy 'skills/harness-init') | Out-Null
Copy-Item -LiteralPath $hook -Destination (Join-Path $staleCopy 'hooks/session-start-scaffold-refresh-nudge.mjs')
Copy-Item -LiteralPath $hookLib -Destination (Join-Path $staleCopy 'hooks/hook-lib.mjs')
New-Item -ItemType Directory -Force -Path (Join-Path $staleCopy 'scripts') | Out-Null
Copy-Item -LiteralPath $gitLib -Destination (Join-Path $staleCopy 'scripts/harness_git.mjs')
Copy-Item -LiteralPath $placement -Destination (Join-Path $staleCopy 'skills/harness-init/placement.mjs')
Copy-Item -LiteralPath $templates -Destination (Join-Path $staleCopy 'skills/harness-init/templates') -Recurse
Set-Content -LiteralPath (Join-Path $staleCopy '.claude-plugin/plugin.json') -Value '{"name":"ywr-harness","version":"0.0.1"}'
$staleHook = Join-Path $staleCopy 'hooks/session-start-scaffold-refresh-nudge.mjs'
$fakeRegPath = Join-Path $fakePlugins 'installed_plugins.json'
# ConvertTo-Json owns the backslash escaping — hand-built JSON with Windows paths is how a
# fixture silently tests nothing on one platform.
function Set-FakeRegistry([object]$Entries) {
    (@{ plugins = @{ 'ywr-harness@ywrlabs' = @($Entries) } } | ConvertTo-Json -Depth 6) |
        Set-Content -LiteralPath $fakeRegPath
}

# 13b. registry lists this plugin but NOT this copy -> STALE advice: running vs registered
#      version named, reload instructed, harness-init forbidden — and the file list stays.
#      Two entries prove the pick order (user scope wins over a more-recent project entry).
Set-FakeRegistry @(
    @{ scope = 'project'; installPath = (Join-Path $fakePlugins 'cache/ywrlabs/ywr-harness/8.8.8'); version = '8.8.8'; lastUpdated = '2026-08-07T09:00:00Z' },
    @{ scope = 'user'; installPath = (Join-Path $fakePlugins 'cache/ywrlabs/ywr-harness/9.9.9'); version = '9.9.9'; lastUpdated = '2026-08-07T01:00:00Z' }
)
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) $staleHook
$ok = (Assert-Nudge 'superseded cache copy reports STALE basis, reload not refresh' $out `
        @('비교 기준이 STALE합니다', 'v0\.0\.1', 'v9\.9\.9', '/reload-plugins', '/ywr-harness:harness-init을 실행하지 마세요',
        '2개의 벤더링된 툴체인 파일', 'harness_gates\.mjs', 'REVERT', '제안만 합니다') `
        @('v8\.8\.8', '리프레시: 이 저장소에서', '시드는 보존', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok
$ok = (Assert-RuleTail '13b stale-basis branch: the rule follows the drift text' $out) -and $ok
# Both versions must survive in the HUMAN banner alone, not only in the English context half:
# Assert-Nudge matches sys+ctx JOINED, and a Korean particle glued to a variable name silently
# interpolates an undefined variable as EMPTY (Korean letters are legal in PS variable names —
# the version-announce ${more}건 lesson). Caught live 2026-08-11: "$ver를"/"$staleActive입니다"
# dropped BOTH versions from the banner while this case stayed green through the ctx half.
$sysOnly = ''
try { $sysOnly = [string]((ConvertFrom-Json $out.Trim()).systemMessage) } catch { }
$ok = (Assert-True '13b both versions survive in the HUMAN banner (interpolation, not ctx)' `
        ($sysOnly -match 'v0\.0\.1' -and $sysOnly -match 'v9\.9\.9') `
        "systemMessage='$sysOnly'") -and $ok

# 13c-13i run the NORMAL branch from a fake v0.0.1 cache copy, so pin the fixture's stamp BELOW
# 0.0.1 first — the real-version stamp the scaffold wrote would otherwise flip these
# registry-fallback cases into the ADR 0042 repo-ahead advice and test the wrong branch.
# 0.0.0 < 0.0.1 -> the BEHIND wording ('Refresh: run …') is the expected normal nudge here.
Set-Content -LiteralPath (Join-Path $stale '.harness-version') -Value '0.0.0'

# 13c. registry entry IS this copy -> current install, the normal 0033 nudge unchanged
Set-FakeRegistry @(@{ scope = 'user'; installPath = $staleCopy; version = '0.0.1'; lastUpdated = '2026-08-07T01:00:00Z' })
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) $staleHook
$ok = (Assert-Nudge 'cache copy that IS the registered install nudges normally' $out `
        @('2개의 벤더링된 툴체인 파일', '리프레시: 이 저장소에서 /ywr-harness:harness-init', 'v0\.0\.1', '시드는 보존') `
        @('기준이 STALE', 'reload-plugins', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok

# 13d. no registry file -> probe yields nothing, normal nudge (fail toward 0033's behavior)
Remove-Item -LiteralPath $fakeRegPath -Force
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) $staleHook
$ok = (Assert-Nudge 'absent registry falls back to the normal nudge' $out `
        @('2개의 벤더링된 툴체인 파일', '리프레시: 이 저장소에서 /ywr-harness:harness-init') `
        @('기준이 STALE', 'reload-plugins', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok

# 13e. unparseable registry -> same fallback, and the envelope must still be clean JSON
#      (2>&1 is captured: a non-terminating ConvertFrom-Json error line would corrupt it)
Set-Content -LiteralPath $fakeRegPath -Value 'not json at all {{{'
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) $staleHook
$ok = (Assert-Nudge 'garbage registry falls back cleanly' $out `
        @('2개의 벤더링된 툴체인 파일', '리프레시: 이 저장소에서 /ywr-harness:harness-init') `
        @('기준이 STALE', 'reload-plugins', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok

# 13f. registry carries only OTHER plugins (this one uninstalled mid-session) -> no registered
#      install to reload into; the normal nudge is the conservative fallback
(@{ plugins = @{ 'some-other-plugin@elsewhere' = @(@{ scope = 'user'; installPath = (Join-Path $fakePlugins 'cache/elsewhere/some-other-plugin/1.0.0'); version = '1.0.0' }) } } | ConvertTo-Json -Depth 6) |
    Set-Content -LiteralPath $fakeRegPath
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) $staleHook
$ok = (Assert-Nudge 'unlisted plugin falls back to the normal nudge' $out `
        @('2개의 벤더링된 툴체인 파일', '리프레시: 이 저장소에서 /ywr-harness:harness-init') `
        @('기준이 STALE', 'reload-plugins', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok

# 13g. SAME version registered at a DIFFERENT path -> normal nudge, never a self-contradictory
#      "runs v0.0.1 while the install is v0.0.1" (review 2026-08-07, medium): a same-version
#      re-registration ships the same templates, so the refresh advice is not inverted
Set-FakeRegistry @(@{ scope = 'user'; installPath = (Join-Path $fakePlugins 'cache/ywrlabs/ywr-harness/elsewhere-0.0.1'); version = '0.0.1'; lastUpdated = '2026-08-07T02:00:00Z' })
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) $staleHook
$ok = (Assert-Nudge 'same-version re-registration keeps the normal nudge' $out `
        @('2개의 벤더링된 툴체인 파일', '리프레시: 이 저장소에서 /ywr-harness:harness-init', 'v0\.0\.1') `
        @('기준이 STALE', 'reload-plugins', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok

# 13h. CROSS-MARKETPLACE union (the '@<marketplace>' half is deliberately unpinned — a consuming
#      org may register the marketplace under another name): the original key is emptied
#      (uninstalled there), a DIFFERENT marketplace key carries the registered install at
#      another version -> STALE names THAT version. This is the union path no single-key
#      fixture exercises (review 2026-08-07, low).
(@{ plugins = [ordered]@{
            'ywr-harness@ywrlabs'  = @()
            'ywr-harness@otherorg' = @(@{ scope = 'user'; installPath = (Join-Path $fakePlugins 'cache/otherorg/ywr-harness/7.7.7'); version = '7.7.7'; lastUpdated = '2026-08-07T03:00:00Z' })
        } } | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $fakeRegPath
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) $staleHook
$ok = (Assert-Nudge 'cross-marketplace registration is unioned into the STALE verdict' $out `
        @('비교 기준이 STALE합니다', 'v0\.0\.1', 'v7\.7\.7', '/reload-plugins') `
        @('리프레시: 이 저장소에서', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok

# 13i. corrupted registered-version shapes are skipped, never rendered: an ARRAY version
#      space-joins under [string] into a digit-bearing "1.0.0 2.0.0" that a bare digit test
#      would accept (review 2026-08-07, low), and the literal 'unknown' sentinel fails the
#      digit test — the one usable entry (project scope 6.6.6) must be the version named
Set-FakeRegistry @(
    @{ scope = 'user'; installPath = (Join-Path $fakePlugins 'cache/ywrlabs/ywr-harness/corrupt-a'); version = @('1.0.0', '2.0.0'); lastUpdated = '2026-08-07T09:00:00Z' },
    @{ scope = 'user'; installPath = (Join-Path $fakePlugins 'cache/ywrlabs/ywr-harness/corrupt-b'); version = 'unknown'; lastUpdated = '2026-08-07T08:00:00Z' },
    @{ scope = 'project'; installPath = (Join-Path $fakePlugins 'cache/ywrlabs/ywr-harness/6.6.6'); version = '6.6.6'; lastUpdated = '2026-08-07T01:00:00Z' }
)
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) $staleHook
$ok = (Assert-Nudge 'corrupted version shapes are skipped, the usable entry is named' $out `
        @('비교 기준이 STALE합니다', 'v6\.6\.6', '/reload-plugins') `
        @('1\.0\.0 2\.0\.0', 'version unknown', '리프레시: 이 저장소에서', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok

# 13j-13k. THE TWO JSON FILES THE HOOK READS PARSE AS LENIENTLY AS ConvertFrom-Json DID (PowerShell 7:
#      `//` and `/* */` comments, trailing commas, single-quoted strings, unquoted keys). A strict parse of
#      either would silently turn a hand-edited, commented file into "no manifest" / "no registry" — the
#      wrong version named in the banner, or the stale-basis verdict lost. 13j: the plugin manifest
#      carries comments and a trailing comma; 13k: the registry is single-quoted with unquoted keys,
#      comments and trailing commas. `#` comments stay refused (the registry falls back, 13e's way).
$manifestPath = Join-Path $staleCopy '.claude-plugin/plugin.json'
Set-Content -LiteralPath $manifestPath -Value @'
// manifest, hand-annotated
{ "name": "ywr-harness", /* the running copy */ "version": "0.0.1", }
'@
Set-FakeRegistry @(@{ scope = 'user'; installPath = (Join-Path $fakePlugins 'cache/ywrlabs/ywr-harness/9.9.9'); version = '9.9.9'; lastUpdated = '2026-08-07T01:00:00Z' })
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) $staleHook
$ok = (Assert-Nudge '13j a commented manifest with a trailing comma still names the running version' $out `
        @('비교 기준이 STALE합니다', 'v0\.0\.1', 'v9\.9\.9', '2개의 벤더링된 툴체인 파일') `
        @('version unknown', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok
Set-Content -LiteralPath $manifestPath -Value '{"name":"ywr-harness","version":"0.0.1"}'
Set-Content -LiteralPath $fakeRegPath -Value @"
// hand-edited registry
{ 'plugins': { 'ywr-harness@ywrlabs': [ { scope: 'user', installPath: 'X:/elsewhere/ywr-harness/9.9.9', version: '9.9.9', /* when */ lastUpdated: '2026-08-07T01:00:00Z', }, ], }, }
"@
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) $staleHook
$ok = (Assert-Nudge '13k a commented single-quoted registry with unquoted keys and trailing commas still reads' $out `
        @('비교 기준이 STALE합니다', 'v0\.0\.1', 'v9\.9\.9', '/reload-plugins') `
        @('리프레시: 이 저장소에서', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok
Set-Content -LiteralPath $fakeRegPath -Value "# not a comment in JSON`n{ `"plugins`": { `"ywr-harness@ywrlabs`": [ { `"scope`": `"user`", `"installPath`": `"X:/elsewhere`", `"version`": `"9.9.9`" } ] } }"
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) $staleHook
$ok = (Assert-Nudge '13k2 a #-commented registry is unparseable -> the normal nudge, as before' $out `
        @('2개의 벤더링된 툴체인 파일', '리프레시: 이 저장소에서 /ywr-harness:harness-init') `
        @('기준이 STALE', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok

# 14. plain non-repo directory -> silent on BOTH branches (with git: rev-parse fails; without
#     git: no scripts/harness at cwd), so this case runs unguarded
$out = Invoke-SpiedHook $plain
$ok = (Assert-EmptyStdout 'non-repo dir silent' $out) -and $ok
$ok = (Assert-True 'non-repo dir spawns no git' ($script:GitCalls -eq 0) "$script:GitCalls git call(s)") -and $ok

# 14b. where the folders above cwd cannot prove silence, the git path still runs: a gitfile `.git` is not proof
#      (its git dir is elsewhere), and core.worktree makes git name a work tree outside the folders above cwd.
if ($gitOk) {
    $gitfile = Join-Path $fx 'repo-gitfile'
    New-Item -ItemType Directory -Force -Path $gitfile | Out-Null
    Set-Content -LiteralPath (Join-Path $gitfile '.git') -Value 'gitdir: ./nowhere' -Encoding ascii
    $out = Invoke-SpiedHook $gitfile
    $ok = (Assert-EmptyStdout '14b gitfile .git without a scaffold: silent' $out) -and $ok
    $ok = (Assert-True '14b a gitfile .git is not proof: git is still asked' ($script:GitCalls -ge 1) 'no git call') -and $ok
    $redirect = Join-Path $fx 'repo-redirect'
    & git -c init.defaultBranch=main init -q $redirect 2>$null | Out-Null
    & git -C $redirect config core.worktree $fresh
    $out = Invoke-SpiedHook $redirect
    $ok = (Assert-RuleOnly '14b core.worktree pointing at a scaffold: git names that work tree and the rule is stated' $out) -and $ok
}

# 15. vanished cwd -> silent, and the stdout must be CLEAN (2>&1 is captured, so a stderr wall
#     would fail the emptiness assertion — the 48c264c class)
$out = Invoke-Hook (New-Payload @{ cwd = (Join-Path $fx 'no-such-dir') })
$ok = (Assert-EmptyStdout 'vanished cwd silent and clean' $out) -and $ok

# 16. a cwd whose ROOT does not exist on this platform -> same clean silence
$bogusRoot = if ($IsWindows) {
    $used = @([IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name.Substring(0, 1).ToUpper() })
    $freeLetter = @((69..90 | ForEach-Object { [string][char]$_ }) | Where-Object { $used -notcontains $_ })[0]
    "${freeLetter}:\no-such-root\x"
}
else { 'C:\no-such-root\x' }
$out = Invoke-Hook (New-Payload @{ cwd = $bogusRoot })
$ok = (Assert-EmptyStdout 'unresolvable root silent and clean' $out) -and $ok

# 17. ANTI-VACUITY: no `cwd` in the payload -> the hook says so instead of falling silent
$out = Invoke-Hook (New-Payload @{})
$ok = (Assert-Nudge 'schema drift is reported, not swallowed' $out `
        @('SCHEMA DRIFT', '수신된 키: hook_event_name, session_id, source') `
        @('템플릿과 다릅니다', 'EXTRACTION DRIFT', $ruleMark)) -and $ok

# 17b. the received-key list sorts case-insensitively (the original's Sort-Object); a null or blank cwd is drift too
$out = Invoke-Hook '{"hook_event_name":"SessionStart","Zeta":1,"alpha":2,"Beta":3}'
$ok = (Assert-Nudge 'drift key list sorts case-insensitively' $out @('SCHEMA DRIFT', '수신된 키: alpha, Beta, hook_event_name, Zeta\.') @('EXTRACTION DRIFT')) -and $ok
foreach ($cj in @('null', '""', '"   "')) {
    $out = Invoke-Hook ('{"hook_event_name":"SessionStart","cwd":' + $cj + '}')
    $ok = (Assert-Nudge "cwd $cj reports SCHEMA DRIFT" $out @('SCHEMA DRIFT') @('EXTRACTION DRIFT')) -and $ok
}

# 18. wrong event name -> silent (defensive event guard, symmetric with siblings)
$out = Invoke-Hook '{"hook_event_name":"SessionEnd","cwd":"C:\\x","source":"startup"}'
$ok = (Assert-EmptyStdout 'wrong event silent' $out) -and $ok

# 19. garbage stdin -> silent exit 0 (infra failure is not a finding)
$out = Invoke-Hook 'not json at all {{{'
$ok = (Assert-EmptyStdout 'garbage fail-open' $out) -and $ok

# 20-21. the no-git branch, exercised by clearing PATH for the CHILD only: the verdict is
#        filesystem-only, so a drifted scaffold still nudges with cwd as the root — this is
#        the documented degradation, not an UNKNOWN. A plain dir stays silent. Runs on
#        git-less machines too, where it is simply the ambient truth.
try {
    $env:PATH = ''
    $out = Invoke-Hook (New-Payload @{ cwd = $stale })
    $ok = (Assert-Nudge 'no git: filesystem verdict still nudges' $out `
            @('repo-stale', '2개의 벤더링된 툴체인 파일', '제안만 합니다') `
            @('SCHEMA DRIFT', 'UNKNOWN')) -and $ok
    $out = Invoke-Hook (New-Payload @{ cwd = $plain })
    $ok = (Assert-EmptyStdout 'no git: plain dir stays silent' $out) -and $ok
}
finally { $env:PATH = $savedPath }

# 22. NON-MUTATION, asserted not assumed: after every invocation above, the fixtures read
#     byte-identical to their prepared state — the suggest-only contract (ADR 0033) becomes
#     provable by the suite. Both directions matter: the hook must not "refresh" the drifted
#     file and must not touch the clean one.
$ok = (Assert-True 'non-mutation: clean placement untouched' `
        ((Get-FileHash -LiteralPath (Join-Path $fresh 'docs/build_docs.mjs')).Hash -eq $freshHash) `
        'repo-fresh/docs/build_docs.mjs changed — the hook wrote to the repo') -and $ok
$ok = (Assert-True 'non-mutation: drifted placement not "refreshed"' `
        ((Get-FileHash -LiteralPath (Join-Path $stale 'scripts/harness/harness_gates.mjs')).Hash -eq $staleHash) `
        'repo-stale/scripts/harness/harness_gates.mjs changed — the hook reverted the drift it only reports') -and $ok

Remove-FixtureRoot $fx

# R1. REGISTRATION. Every case above pipes a payload straight into the script, so none of them sees
#     whether the runtime ever calls it. This pins the wiring: SessionStart, no matcher (deliberate —
#     see the hook header), exec-form `node <script>` (ADR 0116) and the 15 s timeout. That it FIRES
#     is still only a live `--plugin-dir` probe's to show.
$regFails = @()
try {
    $hj = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'hooks.json') -Raw | ConvertFrom-Json
    $sites = @()
    foreach ($evName in @($hj.hooks.PSObject.Properties.Name | Where-Object { $_ })) {
        foreach ($grp in @($hj.hooks.$evName | Where-Object { $_ })) {
            foreach ($h in @($grp.hooks | Where-Object { $_ })) {
                $parts = @([string]$h.command) + @($h.args | ForEach-Object { [string]$_ })
                if (($parts -join ' ') -match 'session-start-scaffold-refresh-nudge\.(ps1|mjs)') { $sites += [pscustomobject]@{ Event = $evName; Matcher = [string]$grp.matcher; H = $h } }
            }
        }
    }
    $wantArgs = @('${CLAUDE_PLUGIN_ROOT}/hooks/session-start-scaffold-refresh-nudge.mjs')
    if ($sites.Count -ne 1) { $regFails += "want exactly 1 registration of session-start-scaffold-refresh-nudge (.mjs or the retired .ps1), found $($sites.Count)" }
    else {
        $s = $sites[0]
        $gotArgs = @($s.H.args | ForEach-Object { [string]$_ })
        if ($s.Event -cne 'SessionStart') { $regFails += "event '$($s.Event)' (want SessionStart)" }
        if ($s.Matcher) { $regFails += "matcher '$($s.Matcher)' (want none — registered without one on purpose)" }
        if ([string]$s.H.type -cne 'command' -or [string]$s.H.command -cne 'node') { $regFails += "handler type/command '$($s.H.type)'/'$($s.H.command)' (want command/node)" }
        if (($gotArgs -join "`0") -cne ($wantArgs -join "`0")) { $regFails += "args [$($gotArgs -join ' ')] (want exec form [$($wantArgs -join ' ')])" }
        else {
            $resolved = Join-Path (Split-Path $PSScriptRoot -Parent) ($gotArgs[-1] -replace '^\$\{CLAUDE_PLUGIN_ROOT\}/', '')
            if ([IO.Path]::GetFullPath($resolved) -ne [IO.Path]::GetFullPath($hook)) { $regFails += "args resolve to '$resolved', not this suite's script '$hook'" }
        }
        if ([string]$s.H.timeout -ne '15') { $regFails += "timeout '$($s.H.timeout)' (want 15)" }
    }
} catch { $regFails += "hooks.json unreadable: $($_.Exception.Message)" }
$ok = (Assert-True 'R1 hooks.json registers this script once: SessionStart, no matcher, exec-form node <script>' `
        (-not $regFails.Count) ($regFails -join ' · ')) -and $ok

# META — proves this file's WIRING to the shared empty-MustNotMatch guard: a wrapper that
# dropped the -MustNotMatch passthrough would leave the core intact and every case above unguarded.
$script:HookExit = 0
$metaOut = '{"systemMessage":"meta probe"}'
$accepted = Assert-Nudge 'META probe' $metaOut @('meta probe') 6>$null
if ($accepted -or $script:LastFails.Count -ne 1 -or ($script:LastFails[0] -notmatch 'no MustNotMatch')) {
    Write-Host "FAIL [META]: guard did not fire — accepted=$accepted reason='$($script:LastFails -join '; ')'" -ForegroundColor Red
    $ok = $false
}
else { Write-Host 'PASS [META]: negative-less case rejected, on the guard reason alone' -ForegroundColor Green }
if (Assert-Nudge 'META exemption honored' $metaOut @('meta probe') @() 'META: exercises the visible-exemption path so the escape hatch cannot rot unnoticed') {
    Write-Host 'PASS [META]: -NoNegative exemption honored' -ForegroundColor Green
}
else { Write-Host 'FAIL [META]: -NoNegative exemption rejected' -ForegroundColor Red; $ok = $false }

if (-not $ok) { exit 1 }
Write-Host "session-start-scaffold-refresh-nudge selftest: all cases green$(if (-not $gitOk) { ' (subdirectory case SKIPPED — no git)' })" -ForegroundColor Green
exit 0
