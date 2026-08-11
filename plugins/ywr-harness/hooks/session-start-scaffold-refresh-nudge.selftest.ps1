# Self-test for session-start-scaffold-refresh-nudge.ps1 (ADR 0033).
# Usage: pwsh plugins/ywr-harness/hooks/session-start-scaffold-refresh-nudge.selftest.ps1
#
# Fixture provenance: the scaffolded fixtures are placed by the REAL init.ps1 (one run, then
# tree copies) — a hand-copied placement would duplicate the map this hook exists not to
# duplicate, and would test the copy. The fixture-prep assertion below is what fails if
# init.ps1 stops placing what the hook reads, which is exactly the coupling ADR 0033 accepts.
#
# The hook's verdict is filesystem-only (unlike the githooks sibling, whose verdict is git
# state), so almost every case runs on a git-less machine too: with git present the fixtures
# are real repos and the root is resolved by rev-parse; with git absent the hook's documented
# cwd-fallback carries the same verdicts. Only the subdirectory-resolution case needs git and
# is a reported SKIP without it (the ADR 0122 container), never a silent pass.
#
# Every match-based case carries MustNotMatch as well as MustMatch (ADR 0116 class), enforced
# by the shared assertion core (ADR 0125).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core + fixture lifecycle
$hook = Join-Path $PSScriptRoot 'session-start-scaffold-refresh-nudge.ps1'
$init = Join-Path $PSScriptRoot '../skills/harness-init/init.ps1'
$templates = Join-Path $PSScriptRoot '../skills/harness-init/templates'

# Resolved BEFORE any case clears $env:PATH — `& pwsh` resolves at call time and would fail.
$pwshExe = (Get-Command pwsh).Source

function Invoke-Hook([string]$Stdin, [string]$HookPath = $hook) {
    $o = ($Stdin | & $pwshExe -NoProfile -File $HookPath 2>&1 | Out-String)
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
function New-Payload([hashtable]$Fields) {
    $o = @{ hook_event_name = 'SessionStart'; session_id = 'selftest'; source = 'startup' } + $Fields
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
& $pwshExe -NoProfile -ExecutionPolicy Bypass -File $init -Target $base *> $null
$ok = (Assert-True 'fixture: real init.ps1 scaffolded the base repo' `
        ((Test-Path -LiteralPath (Join-Path $base 'scripts/harness/harness_gates.py')) -and
        (Test-Path -LiteralPath (Join-Path $base '.githooks/post-commit'))) `
        'init.ps1 did not place the files this suite mutates — every later verdict would be about a broken fixture') -and $ok

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
Add-Content -LiteralPath (Join-Path $stale 'scripts/harness/harness_gates.py') -Value '# selftest drift'
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
# foreign post-commit: no marker -> init.ps1 refuses it -> the hook must skip it the same way
Set-Content -LiteralPath (Join-Path $foreignpc '.githooks/post-commit') -Value "#!/bin/sh`nexit 0"
# ours post-commit: marker retained, content drifted
Add-Content -LiteralPath (Join-Path $ourspc '.githooks/post-commit') -Value 'echo extra'
# manydrift: seven TOOLCHAIN placements drifted -> the list caps at 5 and STATES the cap
foreach ($rel in @('docs/README.md', 'docs/adr/README.md', 'docs/spec/README.md', 'docs/build.ps1',
        'docs/build.sh', 'docs/build_docs.py', 'scripts/harness/harness_config.py')) {
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
$freshHash = (Get-FileHash -LiteralPath (Join-Path $fresh 'docs/build_docs.py')).Hash
$staleHash = (Get-FileHash -LiteralPath (Join-Path $stale 'scripts/harness/harness_gates.py')).Hash

# 1. the drifted repo nudges — the fixture was scaffolded by THIS plugin and then hand-mutated,
#    so its .harness-version stamp EQUALS the running version and the ADR 0042 verdict is the
#    hand-edit reading: count, both file names (differ + missing), version, the
#    REVERT-hand-edits warning, the suggest-only contract.
$out = Invoke-Hook (New-Payload @{ cwd = $stale })
$ok = (Assert-Nudge 'drifted scaffold at the same version reads as a hand-edit' $out `
        @('\[hook:scaffold-refresh-nudge\]', 'repo-stale', '2개의 벤더링된 툴체인 파일', 'v\d+\.\d+\.\d+',
        'harness_gates\.py', 'harness-gates\.yml \(missing\)', 'EQUALS', 'hand-edit',
        'REVERT', '제안만 합니다') `
        @('SCHEMA DRIFT', 'EXTRACTION DRIFT', '\+\d+ more', '기준이 STALE', 'direction-blind',
        '리프레시: 이 저장소에서', 'NEWER합니다', 'OLDER합니다')) -and $ok

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

# 2. freshly scaffolded repo -> byte-silent (the permanent steady state must cost nothing)
$out = Invoke-Hook (New-Payload @{ cwd = $fresh })
$ok = (Assert-EmptyStdout 'fresh scaffold silent' $out) -and $ok

# 3. SEED-only edits -> silent: seeds are the repo's decisions, never compared (ADR 0033)
$out = Invoke-Hook (New-Payload @{ cwd = $seed })
$ok = (Assert-EmptyStdout 'seed edits silent' $out) -and $ok

# 4. line-ending-only difference -> silent: the seed .gitattributes makes CRLF/LF checkout
#    variance legitimate, so raw byte identity would nudge every clone forever
$out = Invoke-Hook (New-Payload @{ cwd = $crlf })
$ok = (Assert-EmptyStdout 'CRLF-only difference silent' $out) -and $ok

# 5. marker-less post-commit -> silent: init.ps1 refuses a foreign file, so a re-run would
#    change nothing — a nudge here would nag forever (the 0029 foreign-value shape)
$out = Invoke-Hook (New-Payload @{ cwd = $foreignpc })
$ok = (Assert-EmptyStdout 'foreign post-commit silent' $out) -and $ok

# 6. marker-carrying post-commit drifted -> counted like any toolchain file
$out = Invoke-Hook (New-Payload @{ cwd = $ourspc })
$ok = (Assert-Nudge 'guarded post-commit with marker counts' $out `
        @('1개의 벤더링된 툴체인 파일', '\.githooks[\\/]post-commit') `
        @('harness_gates\.py', 'SCHEMA DRIFT', '\(missing\)')) -and $ok

# 7. seven drifts -> five named, cap STATED (a silent truncation reads as full coverage)
$out = Invoke-Hook (New-Payload @{ cwd = $many })
$ok = (Assert-Nudge 'file list caps at five and says so' $out `
        @('7개의 벤더링된 툴체인 파일', '\+2 more') `
        @('SCHEMA DRIFT', 'harness_config\.py')) -and $ok

# 8. scripts/harness/ that is not ours -> silent (file-level sentinel, not the directory gate:
#    counting a stranger's tree as "all missing" would be a false nudge)
$out = Invoke-Hook (New-Payload @{ cwd = $notours })
$ok = (Assert-EmptyStdout 'foreign scripts/harness silent' $out) -and $ok

# 9. repo without scripts/harness -> silent
$out = Invoke-Hook (New-Payload @{ cwd = $bare })
$ok = (Assert-EmptyStdout 'unscaffolded repo silent' $out) -and $ok

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

# 11. BOM-prefixed stdin -> still parses (the config-change-audit 07-23 incident class)
$out = Invoke-Hook ([char]0xFEFF + (New-Payload @{ cwd = $stale }))
$ok = (Assert-Nudge 'BOM-prefixed stdin' $out @('repo-stale') @('SCHEMA DRIFT')) -and $ok

# 12. EXTRACTION DRIFT, not silence, when the plugin's own init.ps1 stops carrying literal
#     maps: a byte-identical copy of the hook runs from a fake plugin tree whose init.ps1
#     parses but assigns $TOOLCHAIN non-literally. The copy IS the shipped code — what moves
#     is $PSScriptRoot, which is the resolution path under test.
$fakeBroken = Join-Path $fx 'fake-broken'
New-Item -ItemType Directory -Force -Path (Join-Path $fakeBroken 'hooks') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $fakeBroken 'skills/harness-init/templates') | Out-Null
Copy-Item -LiteralPath $hook -Destination (Join-Path $fakeBroken 'hooks/session-start-scaffold-refresh-nudge.ps1')
Set-Content -LiteralPath (Join-Path $fakeBroken 'skills/harness-init/init.ps1') -Value @'
$TOOLCHAIN = Get-ChildItem
$GUARDED = [ordered]@{ 'githooks/post-commit' = '.githooks/post-commit' }
$GUARD_MARKER = 'ywr-harness:post-commit'
'@
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) (Join-Path $fakeBroken 'hooks/session-start-scaffold-refresh-nudge.ps1')
$ok = (Assert-Nudge 'unreadable placement map reports EXTRACTION DRIFT, not silence' $out `
        @('EXTRACTION DRIFT', 'UNKNOWN, 확인되지 않았습니다', '배치 맵') `
        @('템플릿과 다릅니다', '제안만 합니다', 'SCHEMA DRIFT')) -and $ok

# 12b. a PARTIAL literal — a hashtable whose value is computed but CONTAINS a string constant
#      (`'docs/' + $x`) — must fail extraction WHOLE, never contribute the fragment to the map
#      (review 2026-08-06, high: `.Find()` returned 'prefix/' for `'prefix/' + $suffix`). The
#      exact reported shape is the fixture; a regression to Find()-style extraction turns this
#      case red with a false nudge or false silence instead of the banner.
$fakePartial = Join-Path $fx 'fake-partial'
New-Item -ItemType Directory -Force -Path (Join-Path $fakePartial 'hooks') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $fakePartial 'skills/harness-init/templates') | Out-Null
Copy-Item -LiteralPath $hook -Destination (Join-Path $fakePartial 'hooks/session-start-scaffold-refresh-nudge.ps1')
Set-Content -LiteralPath (Join-Path $fakePartial 'skills/harness-init/init.ps1') -Value @'
$suffix = 'harness_gates.py'
$TOOLCHAIN = [ordered]@{ 'scripts/harness/harness_gates.py' = 'scripts/harness/' + $suffix }
$GUARDED = [ordered]@{ 'githooks/post-commit' = '.githooks/post-commit' }
$GUARD_MARKER = 'ywr-harness:post-commit'
'@
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) (Join-Path $fakePartial 'hooks/session-start-scaffold-refresh-nudge.ps1')
$ok = (Assert-Nudge 'partial literal fails extraction whole, never a fragment' $out `
        @('EXTRACTION DRIFT', 'UNKNOWN, 확인되지 않았습니다', '배치 맵') `
        @('템플릿과 다릅니다', '\(missing\)', 'SCHEMA DRIFT')) -and $ok

# 12c. a fully literal map with NO scripts/harness/*.py destination -> the ownership sentinel
#      is gone; an unchecked empty list would silently disable the hook on every repo forever
#      (review 2026-08-06, medium). The banner, not silence, is the contract.
$fakeNoSent = Join-Path $fx 'fake-nosentinel'
New-Item -ItemType Directory -Force -Path (Join-Path $fakeNoSent 'hooks') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $fakeNoSent 'skills/harness-init/templates') | Out-Null
Copy-Item -LiteralPath $hook -Destination (Join-Path $fakeNoSent 'hooks/session-start-scaffold-refresh-nudge.ps1')
Set-Content -LiteralPath (Join-Path $fakeNoSent 'skills/harness-init/init.ps1') -Value @'
$TOOLCHAIN = [ordered]@{ 'docs/README.md' = 'docs/README.md' }
$GUARDED = [ordered]@{ 'githooks/post-commit' = '.githooks/post-commit' }
$GUARD_MARKER = 'ywr-harness:post-commit'
'@
$out = Invoke-Hook (New-Payload @{ cwd = $stale }) (Join-Path $fakeNoSent 'hooks/session-start-scaffold-refresh-nudge.ps1')
$ok = (Assert-Nudge 'sentinel-less map reports EXTRACTION DRIFT, not permanent silence' $out `
        @('EXTRACTION DRIFT', 'sentinel', 'UNKNOWN, 확인되지 않았습니다') `
        @('템플릿과 다릅니다', 'SCHEMA DRIFT')) -and $ok

# 13. a template missing from the plugin copy -> the same banner naming the file; freshness is
#     never resolved into a nudge from an incomplete comparison set
$fakeTmpl = Join-Path $fx 'fake-tmpl'
New-Item -ItemType Directory -Force -Path (Join-Path $fakeTmpl 'hooks') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $fakeTmpl 'skills/harness-init') | Out-Null
Copy-Item -LiteralPath $hook -Destination (Join-Path $fakeTmpl 'hooks/session-start-scaffold-refresh-nudge.ps1')
Copy-Item -LiteralPath $init -Destination (Join-Path $fakeTmpl 'skills/harness-init/init.ps1')
Copy-Item -LiteralPath $templates -Destination (Join-Path $fakeTmpl 'skills/harness-init/templates') -Recurse
Remove-Item -LiteralPath (Join-Path $fakeTmpl 'skills/harness-init/templates/docs/build_docs.py') -Force
$out = Invoke-Hook (New-Payload @{ cwd = $fresh }) (Join-Path $fakeTmpl 'hooks/session-start-scaffold-refresh-nudge.ps1')
$ok = (Assert-Nudge 'missing template reports EXTRACTION DRIFT naming the file' $out `
        @('EXTRACTION DRIFT', '템플릿이 없습니다', 'templates/docs/build_docs\.py') `
        @('템플릿과 다릅니다', 'SCHEMA DRIFT')) -and $ok

# 13b-13f. STALE-BASIS PROBE (ADR 0039): a byte-identical hook copy runs from a fake VERSIONED
#          CACHE layout (<plugins>/cache/<marketplace>/<name>/<version>) with the real init.ps1
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
Copy-Item -LiteralPath $hook -Destination (Join-Path $staleCopy 'hooks/session-start-scaffold-refresh-nudge.ps1')
Copy-Item -LiteralPath $init -Destination (Join-Path $staleCopy 'skills/harness-init/init.ps1')
Copy-Item -LiteralPath $templates -Destination (Join-Path $staleCopy 'skills/harness-init/templates') -Recurse
Set-Content -LiteralPath (Join-Path $staleCopy '.claude-plugin/plugin.json') -Value '{"name":"ywr-harness","version":"0.0.1"}'
$staleHook = Join-Path $staleCopy 'hooks/session-start-scaffold-refresh-nudge.ps1'
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
        '2개의 벤더링된 툴체인 파일', 'harness_gates\.py', 'REVERT', '제안만 합니다') `
        @('v8\.8\.8', '리프레시: 이 저장소에서', '시드는 보존', 'SCHEMA DRIFT', 'EXTRACTION DRIFT')) -and $ok
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

# 14. plain non-repo directory -> silent on BOTH branches (with git: rev-parse fails; without
#     git: no scripts/harness at cwd), so this case runs unguarded
$out = Invoke-Hook (New-Payload @{ cwd = $plain })
$ok = (Assert-EmptyStdout 'non-repo dir silent' $out) -and $ok

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
        @('템플릿과 다릅니다', 'EXTRACTION DRIFT')) -and $ok

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
        ((Get-FileHash -LiteralPath (Join-Path $fresh 'docs/build_docs.py')).Hash -eq $freshHash) `
        'repo-fresh/docs/build_docs.py changed — the hook wrote to the repo') -and $ok
$ok = (Assert-True 'non-mutation: drifted placement not "refreshed"' `
        ((Get-FileHash -LiteralPath (Join-Path $stale 'scripts/harness/harness_gates.py')).Hash -eq $staleHash) `
        'repo-stale/scripts/harness/harness_gates.py changed — the hook reverted the drift it only reports') -and $ok

Remove-FixtureRoot $fx

# META — proves this file's WIRING to the shared ADR 0116 guard: a wrapper that dropped the
# -MustNotMatch passthrough would leave the core intact and every case above unguarded.
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
