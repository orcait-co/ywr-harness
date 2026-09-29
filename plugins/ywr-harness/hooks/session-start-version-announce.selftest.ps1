# Self-test for session-start-version-announce.ps1 (ADR 0030).
# Usage: pwsh plugins/ywr-harness/hooks/session-start-version-announce.selftest.ps1
#
# The hook's whole verdict comes from three files it resolves itself — its own plugin.json and
# CHANGELOG.md relative to $PSScriptRoot, and the state file under the env-derived home — so the
# suite runs a COPY of the hook inside fixture plugin trees (controlled versions and notes) with
# USERPROFILE/HOME redirected to a fixture home (the harness-statusline suite's hermetic-home
# technique; the hook reads the env vars directly for exactly this reason). Every match-based
# case carries MustNotMatch as well as MustMatch (the empty-MustNotMatch class), enforced by
# the shared assertion core.
#
# The announce-once contract is asserted from BOTH observables: the output (speaks exactly when
# stored < current) and the state file (seeded/updated on every path the table says, byte-equal
# to the version). Mutation CONFINEMENT is asserted at the end: after the full run the fixture
# home contains exactly one file — the state file. ADR 0030's user-scope write is bounded, and
# this is where that claim is proved rather than assumed.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core + fixture lifecycle

$pwshExe = (Get-Command pwsh).Source
$hookSrc = Join-Path $PSScriptRoot 'session-start-version-announce.ps1'

function Invoke-Hook([string]$Stdin, [string]$HookPath) {
    $o = ($Stdin | & $pwshExe -NoProfile -File $HookPath 2>&1 | Out-String)
    $script:HookExit = $LASTEXITCODE
    return $o
}
# Envelope adapter (file-specific, per the assertion-core contract): announcement speech spans
# systemMessage + additionalContext, so both are matched joined. When additionalContext is
# present its hookEventName must be SessionStart, or the runtime drops it.
function Assert-Announce([string]$Name, [string]$Out, [string[]]$MustMatch, [string[]]$MustNotMatch, [string]$NoNegative = '') {
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
function New-Payload([hashtable]$Fields = @{}) {
    $o = @{ hook_event_name = 'SessionStart'; session_id = 'selftest'; source = 'startup'; cwd = 'C:\anywhere' } + $Fields
    return ($o | ConvertTo-Json -Compress)
}

$ok = $true
$savedProfile = $env:USERPROFILE
$savedHome = $env:HOME
$fx = New-FixtureRoot 'ssva-selftest'
trap { $env:USERPROFILE = $savedProfile; $env:HOME = $savedHome; Remove-FixtureRoot $fx; break }

# --- fixtures --------------------------------------------------------------------------------
# Synthetic versions (2.4.0 -> 2.5.0), NOT the real plugin's: the suite must not need editing
# on every release. The 2.5.0 entry carries FOUR bullets — one wrapped across lines — so the
# visible cap (3 shown + "외 1건") and continuation-joining are both observable.
$fxHome = Join-Path $fx 'home'
New-Item -ItemType Directory -Force -Path $fxHome | Out-Null
$stateFile = Join-Path $fxHome '.claude/ywr-harness/announced-version'
function Set-State([string]$v) {
    New-Item -ItemType Directory -Force -Path (Split-Path $stateFile -Parent) | Out-Null
    Set-Content -LiteralPath $stateFile -Value $v -NoNewline -Encoding utf8
}
function Get-State { if (Test-Path -LiteralPath $stateFile) { (Get-Content -LiteralPath $stateFile -Raw).Trim() } else { $null } }

function New-FixturePlugin([string]$Name, [string]$ManifestJson, [string]$Changelog) {
    $p = Join-Path $fx $Name
    New-Item -ItemType Directory -Force -Path (Join-Path $p '.claude-plugin'), (Join-Path $p 'hooks') | Out-Null
    Set-Content -LiteralPath (Join-Path $p '.claude-plugin/plugin.json') -Value $ManifestJson -Encoding utf8
    if ($null -ne $Changelog) { Set-Content -LiteralPath (Join-Path $p 'CHANGELOG.md') -Value $Changelog -Encoding utf8 }
    Copy-Item $hookSrc (Join-Path $p 'hooks/hook.ps1')
    return (Join-Path $p 'hooks/hook.ps1')
}

$notes = @'
# fixture 릴리스 노트

## v2.5.0 — 2026-08-05

- 첫 번째 변경: `백틱 조각`과 **강조 표시**가 섞여 있습니다.
- 두 번째 변경이 여러 줄로
  이어집니다.
- 세 번째 변경.
- 네 번째 변경은 목록에서 잘립니다.

## v2.4.0 — 2026-08-01

- 이전 버전 항목입니다.
'@
$hook = New-FixturePlugin 'plug' '{"name":"ywr-harness","version":"2.5.0"}' $notes
$hookNoNotes = New-FixturePlugin 'plug-nonotes' '{"name":"ywr-harness","version":"2.5.0"}' $null
$hookBroken = New-FixturePlugin 'plug-broken' 'not json {{{' $notes
# A NON-hyphenated suffix passes the gate's front-anchored version-shape check, and the first
# draft's \b-based section lookup missed exactly this heading (review 2026-08-05, low) — the
# lookup is token equality against the raw manifest string now, and this fixture pins it.
$notesRc = @'
# fixture 릴리스 노트

## v2.5.0rc1 — 2026-08-05

- 접미사 버전 항목이 조회됩니다.
'@
$hookRc = New-FixturePlugin 'plug-rc' '{"name":"ywr-harness","version":"2.5.0rc1"}' $notesRc

$env:USERPROFILE = $fxHome
$env:HOME = $fxHome
try {
    # 0. first run whose SEED CANNOT RECORD (a file squats on the state DIRECTORY path) ->
    #    byte-silent: a welcome that cannot be recorded would repeat every session — the 0029
    #    nag class — and it protects no news (ADR 0031's write-then-speak order, asserted).
    New-Item -ItemType Directory -Force -Path (Join-Path $fxHome '.claude') | Out-Null
    Set-Content -LiteralPath (Split-Path $stateFile -Parent) -Value 'squatter' -NoNewline -Encoding utf8
    $out = Invoke-Hook (New-Payload) $hook
    $ok = (Assert-EmptyStdout 'unseedable first run: silent' $out) -and $ok
    Remove-Item -LiteralPath (Split-Path $stateFile -Parent) -Force

    # 1. no state file (fresh install / feature first run) -> the LINK-ONLY WELCOME (ADR 0031):
    #    true in both indistinguishable states, so no version arrow, no "업데이트됨", no bullets
    #    — and the state seeds, so the machine hears it exactly once.
    $out = Invoke-Hook (New-Payload) $hook
    $ok = (Assert-Announce 'fresh: link-only welcome' $out `
            @('\[hook:version-announce\]', 'v2\.5\.0 적용 중', '첫 버전 안내',
            'artifact/a4387fdf-63d1-4a3d-9c8e-c362c9215a54#rn', 'Team 좌석 로그인',
            'once per machine') `
            @('업데이트됨', '→', '첫 번째 변경', '외 \d+건', '주요 변경')) -and $ok
    $ok = (Assert-True 'fresh: state seeded to current' ((Get-State) -eq '2.5.0') `
            "state reads [$(Get-State)] (want 2.5.0)") -and $ok

    # 1b. the first-run seed is an EXCLUSIVE create (ADR 0081 arm, B low: two sessions starting
    #     together both saw the path absent and both welcomed). A timing race between two child
    #     processes could pass without the fix, so the REAL function is lifted from the hook's
    #     AST and run against a state file that already exists — the loser's exact position:
    #     it must refuse ($false) and leave the winner's bytes alone. Its success path is case 1.
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($hookSrc, [ref]$null, [ref]$null)
    $fnAst = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'New-StateExclusive' }, $true)
    $ok = (Assert-True 'exclusive seed: New-StateExclusive exists in the hook' ($null -ne $fnAst) `
            'function not found — the first-run seed is no longer an exclusive create') -and $ok
    if ($fnAst) {
        $seedResult = & {
            $stateDir = Split-Path $stateFile -Parent
            . ([scriptblock]::Create($fnAst.Extent.Text))
            New-StateExclusive '9.9.9'
        }
        $ok = (Assert-True 'exclusive seed: an existing state file refuses the seed' ($seedResult -eq $false) `
                "returned [$seedResult] (want False — a concurrent first run must not seed twice)") -and $ok
        $ok = (Assert-True 'exclusive seed: the winner''s state is untouched' ((Get-State) -eq '2.5.0') `
                "state reads [$(Get-State)] (want 2.5.0)") -and $ok
    }

    # 2. state == current -> the permanent steady state costs nothing
    $out = Invoke-Hook (New-Payload) $hook
    $ok = (Assert-EmptyStdout 'same version: silent' $out) -and $ok

    # 3. state < current -> THE announcement: version pair, first three bullets (the wrapped one
    #    joined whole, the markdown one FLATTENED — systemMessage is plain text, so `code` and
    #    **bold** markers must not reach the member; review 2026-08-05, medium), the visible
    #    "외 1건" cap, the RN-tab link with its login qualifier — and the state file moves to
    #    current so the re-fire goes silent.
    Set-State '2.4.0'
    $out = Invoke-Hook (New-Payload) $hook
    $ok = (Assert-Announce 'older state announces' $out `
            @('\[hook:version-announce\]', 'v2\.4\.0 → v2\.5\.0', '업데이트됨',
            '첫 번째 변경: 백틱 조각과 강조 표시가 섞여',
            '두 번째 변경이 여러 줄로 이어집니다', '세 번째 변경',
            '외 1건', 'artifact/a4387fdf-63d1-4a3d-9c8e-c362c9215a54#rn', 'Team 좌석 로그인',
            'once-per-version', 'CHANGELOG') `
            @('네 번째', '\*\*', '`', '기록 실패', 'could not be read',
            '첫 버전 안내', '적용 중', 'once per machine')) -and $ok
    $ok = (Assert-True 'older state: state advanced' ((Get-State) -eq '2.5.0') `
            "state reads [$(Get-State)] (want 2.5.0)") -and $ok

    # 3b. a NON-hyphenated version suffix ('2.5.0rc1') — the gate-passing shape the first
    #     draft's \b lookup missed: the entry must be FOUND, bullets shown, raw version echoed
    Set-State '2.4.0'
    $out = Invoke-Hook (New-Payload) $hookRc
    $ok = (Assert-Announce 'suffixed version finds its entry' $out `
            @('v2\.4\.0 → v2\.5\.0rc1', '접미사 버전 항목이 조회됩니다') `
            @('외 \d+건', '기록 실패', '첫 버전 안내', '적용 중')) -and $ok

    # 4. BOM-prefixed stdin -> still parses (the config-change-audit 07-23 incident class)
    Set-State '2.4.0'
    $out = Invoke-Hook ([char]0xFEFF + (New-Payload)) $hook
    $ok = (Assert-Announce 'BOM-prefixed stdin' $out @('v2\.4\.0 → v2\.5\.0') @('기록 실패')) -and $ok

    # 5. state > current (downgrade) -> silent re-seed: a downgrade is the member's own act, and
    #    "업데이트됨" would be false (ADR 0030 decision table)
    Set-State '9.9.9'
    $out = Invoke-Hook (New-Payload) $hook
    $ok = (Assert-EmptyStdout 'downgrade: silent' $out) -and $ok
    $ok = (Assert-True 'downgrade: state re-seeded' ((Get-State) -eq '2.5.0') `
            "state reads [$(Get-State)] (want 2.5.0)") -and $ok

    # 6. garbage state -> not a version to announce from; silent re-seed
    Set-State 'not-a-version'
    $out = Invoke-Hook (New-Payload) $hook
    $ok = (Assert-EmptyStdout 'garbage state: silent' $out) -and $ok
    $ok = (Assert-True 'garbage state: re-seeded' ((Get-State) -eq '2.5.0') `
            "state reads [$(Get-State)] (want 2.5.0)") -and $ok

    # 7. CHANGELOG missing entirely -> announce DEGRADED: link only, no bullets, no cap line.
    #    The gate that enforces the entry runs in the canon, not on the member machine. This is
    #    the update message whose SHAPE is closest to the welcome (both link-only), so the
    #    distinguishability pin matters most here: it must still read as an UPDATE, never as a
    #    first-run welcome (review 2026-08-05, medium — the pin was one-directional).
    Set-State '2.4.0'
    $out = Invoke-Hook (New-Payload) $hookNoNotes
    $ok = (Assert-Announce 'missing CHANGELOG: link-only announcement' $out `
            @('v2\.4\.0 → v2\.5\.0', '업데이트됨', 'artifact/a4387fdf-63d1-4a3d-9c8e-c362c9215a54#rn') `
            @('주요 변경', '외 \d+건', '첫 번째 변경', '첫 버전 안내', '적용 중', 'once per machine')) -and $ok

    # 8. state write blocked -> announce ANYWAY with the visible may-repeat note (never a lost
    #    announcement, never a silent repeat). Since O49 the write is a rename, and a POSIX rename
    #    ignores the target file's mode — so off Windows the block is the state DIRECTORY
    #    (chmod 555: neither the temp file nor the rename can land); on Windows the read-only
    #    file makes File.Move throw. Root ignores permissions, so root SKIPs (reported).
    $isRoot = (-not $IsWindows) -and ((& id -u 2>$null) -eq '0')
    if ($isRoot) {
        Write-Host 'SKIP — running as root; a read-only state file does not block root writes (1 case)' -ForegroundColor Yellow
    }
    else {
        Set-State '2.4.0'
        $stateParent = Split-Path $stateFile -Parent
        if ($IsWindows) { (Get-Item -LiteralPath $stateFile).IsReadOnly = $true }
        else { & chmod 555 $stateParent }
        try {
            $out = Invoke-Hook (New-Payload) $hook
            $ok = (Assert-Announce 'blocked state write: announce with may-repeat note' $out `
                    @('v2\.4\.0 → v2\.5\.0', '기록 실패', '반복될 수 있습니다') `
                    @('버전으로 읽을 수 없습니다')) -and $ok
            $ok = (Assert-True 'blocked write: state untouched' ((Get-State) -eq '2.4.0') `
                    "state reads [$(Get-State)] (want 2.4.0)") -and $ok
            # O49: the write is temp-file-then-rename; a failed rename must remove its temp file.
            # Windows only: there the temp file lands and the Move onto the read-only target
            # fails. Off Windows the 555 directory stops the temp write itself, so no temp file
            # ever exists and the assert could not fail — case 8b covers the POSIX path.
            if ($IsWindows) {
                $tmpLeft = @(Get-ChildItem -LiteralPath (Split-Path $stateFile -Parent) -Filter '*.tmp' -Force)
                $ok = (Assert-True 'blocked write: no temp file left behind' ($tmpLeft.Count -eq 0) `
                        "left: $($tmpLeft.Name -join ', ')") -and $ok
            }
        }
        finally {
            if ($IsWindows) { (Get-Item -LiteralPath $stateFile).IsReadOnly = $false }
            else { & chmod 755 $stateParent }
        }
    }

    # 8b. state PATH occupied by a directory -> byte-silent by the decision table's own
    #     arithmetic (unreadable state -> re-seed; the re-seed write fails; a seed failure
    #     protects no announcement) — asserted rather than assumed (review 2026-08-05, low),
    #     and the directory must survive untouched.
    Remove-Item -LiteralPath $stateFile -Force
    New-Item -ItemType Directory -Force -Path $stateFile | Out-Null
    $out = Invoke-Hook (New-Payload) $hook
    $ok = (Assert-EmptyStdout 'state path is a directory: silent' $out) -and $ok
    $ok = (Assert-True 'state path directory untouched' (Test-Path -LiteralPath $stateFile -PathType Container) `
            'the state path is no longer a directory — the hook replaced it') -and $ok
    # O49 on EVERY platform: the temp file lands, the rename onto a directory fails, and the
    # catch must remove the temp file (case 8's POSIX branch never reaches a failed rename).
    $tmpLeft8b = @(Get-ChildItem -LiteralPath (Split-Path $stateFile -Parent) -Filter '*.tmp' -Force)
    $ok = (Assert-True 'state path is a directory: failed rename leaves no temp file' ($tmpLeft8b.Count -eq 0) `
            "left: $($tmpLeft8b.Name -join ', ')") -and $ok
    Remove-Item -LiteralPath $stateFile -Force
    Set-State '2.5.0'   # restore a file at the state path for the confinement sweep below
    # 8c. O49: a corrupt interleaved state (`0.59.00.59.0`, two in-place writers) must NOT parse as
    #     its leading triple. The old front-anchored regex read it as 0.59.0 (< current) and
    #     announced a bogus update; the boundary lookahead makes it exists-but-unreadable, so it is
    #     re-seeded silently. The current version here is the fixture plugin's (2.5.0).
    Set-State '0.59.00.59.0'
    $out = Invoke-Hook (New-Payload) $hook
    $ok = (Assert-EmptyStdout 'corrupt interleaved state: byte-silent' $out) -and $ok
    $ok = (Assert-True 'corrupt interleaved state: re-seeded to exactly the current version' ((Get-State) -eq '2.5.0') `
            "state reads [$(Get-State)] (want 2.5.0)") -and $ok

    # 8d. O49: after an announce the state dir holds ONLY the state file (the write-then-rename
    #     temp file is gone) and its bytes are exactly the version — no BOM, no trailing newline.
    Set-State '2.4.0'
    $out = Invoke-Hook (New-Payload) $hook
    $ok = (Assert-Announce 'announce before the write-shape check' $out @('v2\.4\.0 → v2\.5\.0') @('기록 실패')) -and $ok
    $stateDirPath = Split-Path $stateFile -Parent
    $names = @(Get-ChildItem -LiteralPath $stateDirPath -Force | ForEach-Object { $_.Name })
    $ok = (Assert-True 'state dir holds only announced-version after a write (no *.tmp)' `
        ($names.Count -eq 1 -and $names[0] -eq 'announced-version') "dir contains: $($names -join ', ')") -and $ok
    $stateBytes = [System.IO.File]::ReadAllBytes($stateFile)
    $wantBytes = [System.Text.Encoding]::UTF8.GetBytes('2.5.0')
    $ok = (Assert-True 'state bytes are exactly the version: no BOM, no trailing newline' `
        (($stateBytes -join ',') -eq ($wantBytes -join ',')) "bytes: $($stateBytes -join ',') (want $($wantBytes -join ','))") -and $ok

    # 8f. a temp file orphaned by a writer killed between write and rename is swept at the next
    #     successful write once it is over an hour old; a fresh one (a live writer's) is kept.
    Set-State '2.4.0'
    $staleTmp = Join-Path $stateDirPath 'announced-version.stale.tmp'
    $freshTmp = Join-Path $stateDirPath 'announced-version.fresh.tmp'
    Set-Content -LiteralPath $staleTmp -Value 'x' -NoNewline
    Set-Content -LiteralPath $freshTmp -Value 'x' -NoNewline
    (Get-Item -LiteralPath $staleTmp).LastWriteTimeUtc = [datetime]::UtcNow.AddHours(-2)
    $out = Invoke-Hook (New-Payload) $hook
    $ok = (Assert-True 'stale temp sweep: an over-an-hour-old temp file is removed' (-not (Test-Path -LiteralPath $staleTmp)) `
            'announced-version.stale.tmp survived a successful write') -and $ok
    $ok = (Assert-True 'stale temp sweep: a fresh temp file is kept' (Test-Path -LiteralPath $freshTmp) `
            'a live writer''s temp file was deleted') -and $ok
    Remove-Item -LiteralPath $freshTmp -Force -ErrorAction SilentlyContinue

    # 8e. SMOKE check, NOT a mutation-proven guard: 8 hook processes race one stored older version
    #     against the same fixture home. Afterwards the state must be exactly the current version
    #     with no temp file left. Reverting Write-State to the old in-place Set-Content did not turn
    #     this red on the owner's box (2026-09-29 probe) — the O49 interleave needs a timing this
    #     cannot force — so it is kept for the cheap end-to-end run, not as proof of the fix.
    Set-State '2.4.0'
    $racers = 1..8 | ForEach-Object {
        $psi = [System.Diagnostics.ProcessStartInfo]::new($pwshExe)
        foreach ($a in @('-NoProfile', '-File', $hook)) { $psi.ArgumentList.Add($a) }
        $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $p = [System.Diagnostics.Process]::Start($psi)
        [pscustomobject]@{ P = $p; Out = $p.StandardOutput.ReadToEndAsync(); Err = $p.StandardError.ReadToEndAsync() }
    }
    $payloadRace = New-Payload
    foreach ($r in $racers) { $r.P.StandardInput.Write($payloadRace); $r.P.StandardInput.Close() }
    foreach ($r in $racers) { [void]$r.P.WaitForExit(60000) }
    $raceCodes = @($racers | ForEach-Object { if ($_.P.HasExited) { $_.P.ExitCode } else { -1 } })
    # A hung racer is killed here, or it keeps writing into the fixture home under later cases.
    foreach ($r in $racers) { if (-not $r.P.HasExited) { try { $r.P.Kill($true); [void]$r.P.WaitForExit(5000) } catch { } } }
    $ok = (Assert-True 'race: all 8 hook processes exit 0' (@($raceCodes | Where-Object { $_ -ne 0 }).Count -eq 0) "exit codes: $($raceCodes -join ',')") -and $ok
    $raceErr = @($racers | ForEach-Object { if ($_.P.HasExited) { $_.Err.Result } } | Where-Object { $_ -and $_.Trim() })
    $ok = (Assert-True 'race: no hook process wrote to stderr' ($raceErr.Count -eq 0) "stderr: $($raceErr -join ' | ')") -and $ok
    $ok = (Assert-True 'race: state is exactly the current version afterwards' ((Get-State) -eq '2.5.0' -and ([System.IO.File]::ReadAllBytes($stateFile)).Length -eq 5) `
            "state reads [$(Get-State)] (want 2.5.0)") -and $ok
    $raceTmp = @(Get-ChildItem -LiteralPath $stateDirPath -Filter '*.tmp' -Force)
    $ok = (Assert-True 'race: no temp file left behind' ($raceTmp.Count -eq 0) "left: $($raceTmp.Name -join ', ')") -and $ok

    # 9. the hook's own plugin.json unreadable -> reported, never silent (a plugin that cannot
    #    read its own manifest is broken; anti-vacuity posture), and announcements declared OFF
    $out = Invoke-Hook (New-Payload) $hookBroken
    $ok = (Assert-Announce 'broken own manifest is reported' $out `
            @('버전으로 읽을 수 없습니다', '버전 안내는 OFF') `
            @('업데이트됨', '주요 변경')) -and $ok

    # 10. wrong event name -> silent (defensive event guard, symmetric with siblings)
    $out = Invoke-Hook '{"hook_event_name":"SessionEnd","source":"startup"}' $hook
    $ok = (Assert-EmptyStdout 'wrong event silent' $out) -and $ok

    # 11. garbage stdin -> silent exit 0 (infra failure is not a finding)
    $out = Invoke-Hook 'not json at all {{{' $hook
    $ok = (Assert-EmptyStdout 'garbage stdin fail-open' $out) -and $ok

    # 12. no resolvable home -> silent: announce-once is impossible without state, and a
    #     per-session fallback is the nag class ADR 0029 rejected. The statusline still shows
    #     the version, so the state is not invisible.
    try {
        $env:USERPROFILE = ''; $env:HOME = ''
        $out = Invoke-Hook (New-Payload) $hook
        $ok = (Assert-EmptyStdout 'no home: silent' $out) -and $ok
    }
    finally { $env:USERPROFILE = $fxHome; $env:HOME = $fxHome }

    # 13. MUTATION CONFINEMENT, asserted not assumed: after every case above, the hook's entire
    #     write surface — every path it constructs derives from <home>/.claude — contains EXACTLY
    #     one file: the state file. ADR 0030's "bounded to this one file" claim is proved here;
    #     any stray hook write turns this red. Scoped to .claude deliberately: the child pwsh
    #     RUNTIME writes its own startup cache under a redirected profile
    #     (AppData/.../StartupProfileData-NonInteractive — measured 2026-08-05), which is
    #     ambient host noise, not a hook write.
    $claudeDir = Join-Path $fxHome '.claude'
    $written = @(Get-ChildItem -LiteralPath $claudeDir -Recurse -File | ForEach-Object { $_.FullName })
    $ok = (Assert-True 'confinement: exactly the state file under <home>/.claude' `
        ($written.Count -eq 1 -and $written[0] -eq (Get-Item -LiteralPath $stateFile).FullName) `
            "<home>/.claude contains: $($written -join ', ')") -and $ok
}
finally {
    $env:USERPROFILE = $savedProfile
    $env:HOME = $savedHome
}

Remove-FixtureRoot $fx

# META — proves this file's WIRING to the shared empty-MustNotMatch guard: a wrapper that
# dropped the -MustNotMatch passthrough would leave the core intact and every case above unguarded.
$script:HookExit = 0
$metaOut = '{"systemMessage":"meta probe"}'
$accepted = Assert-Announce 'META probe' $metaOut @('meta probe') 6>$null
if ($accepted -or $script:LastFails.Count -ne 1 -or ($script:LastFails[0] -notmatch 'no MustNotMatch')) {
    Write-Host "FAIL [META]: guard did not fire — accepted=$accepted reason='$($script:LastFails -join '; ')'" -ForegroundColor Red
    $ok = $false
}
else { Write-Host 'PASS [META]: negative-less case rejected, on the guard reason alone' -ForegroundColor Green }
if (Assert-Announce 'META exemption honored' $metaOut @('meta probe') @() 'META: exercises the visible-exemption path so the escape hatch cannot rot unnoticed') {
    Write-Host 'PASS [META]: -NoNegative exemption honored' -ForegroundColor Green
}
else { Write-Host 'FAIL [META]: -NoNegative exemption rejected' -ForegroundColor Red; $ok = $false }

if (-not $ok) { exit 1 }
Write-Host 'session-start-version-announce selftest: all cases green' -ForegroundColor Green
exit 0
