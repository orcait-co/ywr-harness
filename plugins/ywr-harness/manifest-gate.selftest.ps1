# Negative test for manifest-gate.ps1 — every mutation MUST make the gate exit 1.
#
# Why this exists: a gate that has only ever been observed passing is not known to work. The
# gate's own comments name the failure class it guards against (ADR 0120: green selftests over
# a payload field name nothing carried), and the gate would be an instance of that class if
# nothing ever proved it can fail.
#
# Each case copies the plugin into a temp directory, mutates one thing, and runs the gate there.
# The real plugin is never modified.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$src = $PSScriptRoot
$base = Join-Path ([IO.Path]::GetTempPath()) ("ywrh-gate-neg-" + [guid]::NewGuid().ToString('N'))
$results = @()

# Teardown is exception-safe (ADR 0126) and refuses anything outside the temp root.
trap {
    if ($base -and $base.StartsWith([IO.Path]::GetTempPath()) -and (Test-Path -LiteralPath $base)) {
        Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
    }
    break
}

function Try-Case([string]$tag, [scriptblock]$mutate) {
    # Copy the directory ITSELF to a not-yet-existing destination. Pre-creating $dir would nest
    # the copy one level down, and switching to a `$src/*` wildcard is not an option: -LiteralPath
    # takes `*` literally (this exact substitution is what the first wired run caught).
    $dir = Join-Path $base $tag
    Copy-Item -LiteralPath $src -Destination $dir -Recurse -Force
    & $mutate $dir
    & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'manifest-gate.ps1') *> $null
    $rc = $LASTEXITCODE
    if ($rc -eq 1) { Write-Host "PASS [$tag] gate exited 1 as required" -ForegroundColor Green }
    else { Write-Host "FAIL [$tag] gate exited $rc — mutation NOT caught" -ForegroundColor Red }
    $script:results += [pscustomobject]@{ case = $tag; exit = $rc }
}

Try-Case 'version-removed' {
    param($d)
    $p = Join-Path $d '.claude-plugin/plugin.json'
    $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
    $j.PSObject.Properties.Remove('version')
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $p -NoNewline
}

Try-Case 'version-not-semantic' {
    param($d)
    $p = Join-Path $d '.claude-plugin/plugin.json'
    $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
    $j.version = 'v1'
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $p -NoNewline
}

Try-Case 'name-not-kebab' {
    param($d)
    $p = Join-Path $d '.claude-plugin/plugin.json'
    $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
    $j.name = 'YWR Harness'
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $p -NoNewline
}

Try-Case 'displayName-removed' {
    param($d)
    $p = Join-Path $d '.claude-plugin/plugin.json'
    $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
    $j.PSObject.Properties.Remove('displayName')
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $p -NoNewline
}

Try-Case 'hook-path-broken' {
    param($d)
    $p = Join-Path $d 'hooks/hooks.json'
    (Get-Content -LiteralPath $p -Raw).Replace('subagent-telemetry.ps1', 'subagent-telemetry-MOVED.ps1') |
        Set-Content -LiteralPath $p -NoNewline
}

Try-Case 'exec-form-regressed' {
    param($d)
    $p = Join-Path $d 'hooks/hooks.json'
    $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
    $h = $j.hooks.SubagentStop[0].hooks[0]
    $h.command = '"${CLAUDE_PLUGIN_ROOT}/hooks/subagent-telemetry.ps1"'
    $h.PSObject.Properties.Remove('args')
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $p -NoNewline
}

Try-Case 'no-events' {
    param($d)
    $p = Join-Path $d 'hooks/hooks.json'
    '{"hooks":{}}' | Set-Content -LiteralPath $p -NoNewline
}

# Same class as no-events, one level down: the event exists but its handler array is empty, so
# the hook is registered and never runs. Enumerated because the no-events defect was an instance
# of "@($null).Count is 1", not a one-off.
Try-Case 'event-with-no-handlers' {
    param($d)
    $p = Join-Path $d 'hooks/hooks.json'
    '{"hooks":{"SubagentStop":[{"hooks":[]}]}}' | Set-Content -LiteralPath $p -NoNewline
}

# The defect a live session found and the whole suite had missed: every selftest calls the scripts
# directly, so nothing went through the host's component registry, where a bare name does not
# resolve. Both forms are pinned — the runtime-fatal one and the copy-paste one.
Try-Case 'bare-workflow-call' {
    param($d)
    $p = Join-Path $d 'README.md'
    Add-Content -LiteralPath $p -Value "`nRun it: Workflow({name: 'adversarial-review', args: {}})`n"
}

Try-Case 'bare-skill-slash' {
    param($d)
    $p = Join-Path $d 'README.md'
    Add-Content -LiteralPath $p -Value "`nThen invoke ``/verify`` to check it.`n"
}

# Two copies of one script are only safe while something proves they are the same file. Without
# this case, a fix applied to scripts/ would silently never reach a scaffolded repo, and the symptom
# would read as "the consumer is behind" instead of "the canon ships two different files".
Try-Case 'vendored-copy-diverged' {
    param($d)
    $p = Join-Path $d 'skills/harness-init/templates/scripts/harness/harness_config.py'
    Add-Content -LiteralPath $p -Value "`n# local drift`n"
}

Try-Case 'vendored-copy-orphaned' {
    param($d)
    Remove-Item -LiteralPath (Join-Path $d 'scripts/harness_config.py') -Force
}

Try-Case 'unparseable-manifest' {
    param($d)
    $p = Join-Path $d '.claude-plugin/plugin.json'
    '{ this is not json' | Set-Content -LiteralPath $p -NoNewline
}

# The release-notes canon (ADR 0030): a release shipping without notes, with stale notes, or
# with a link that no longer matches the hook's would each surface only on member machines —
# as a bullet-less or wrong-tab announcement — which is why the gate owns them canon-side.
Try-Case 'changelog-missing' {
    param($d)
    Remove-Item -LiteralPath (Join-Path $d 'CHANGELOG.md') -Force
}

Try-Case 'changelog-version-stale' {
    param($d)
    $p = Join-Path $d 'CHANGELOG.md'
    $j = Get-Content -LiteralPath (Join-Path $d '.claude-plugin/plugin.json') -Raw | ConvertFrom-Json
    (Get-Content -LiteralPath $p -Raw).Replace("## v$($j.version)", '## v0.0.1') |
        Set-Content -LiteralPath $p -NoNewline
}

Try-Case 'rn-url-diverged' {
    param($d)
    $p = Join-Path $d 'CHANGELOG.md'
    (Get-Content -LiteralPath $p -Raw) -replace 'artifact/[0-9a-f-]+#rn', 'artifact/00000000-0000-0000-0000-000000000000#rn' |
        Set-Content -LiteralPath $p -NoNewline
}

# The interpolation trap ADR 0045 makes reachable in every hook: Korean letters are legal in a
# PS variable name, so "$ver를" interpolates an undefined variable named ver를 as EMPTY — the
# value silently vanishes from the member banner (measured live 2026-08-11; the hook suites'
# joined sys+ctx match stayed green through the English context half). The gate must refuse the
# CLASS on a non-comment line; the comment-skip is what keeps hooks free to DOCUMENT the trap.
Try-Case 'hangul-glued-variable' {
    param($d)
    $p = Join-Path $d 'hooks/session-start-githooks-nudge.ps1'
    Add-Content -LiteralPath $p -Value "`n`$probe = `"지금 `$ver를 실행`"`n"
}

# Class-4 honesty, asserted on the MESSAGE not the exit code: with plugin.json corrupt and the
# CHANGELOG intact, the gate already exits 1 from the manifest Bad — so an exit-code-only case
# can never catch the defect this pins, which was the CHANGELOG check printing a false
# "(matches plugin.json)" PASS for a comparison it never ran (review 2026-08-05, medium). The
# skipped comparison must say NOT CHECKED.
$dir = Join-Path $base 'changelog-check-broken-manifest'
Copy-Item -LiteralPath $src -Destination $dir -Recurse -Force
'{ this is not json' | Set-Content -LiteralPath (Join-Path $dir '.claude-plugin/plugin.json') -NoNewline
$out = & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'manifest-gate.ps1') 2>&1 | Out-String
$rc = $LASTEXITCODE
$honest = ($rc -eq 1) -and ($out -notmatch '\(matches plugin\.json\)') -and ($out -match 'NOT CHECKED')
if ($honest) { Write-Host 'PASS [changelog-check-broken-manifest] no false "(matches plugin.json)"; NOT CHECKED reported' -ForegroundColor Green }
else { Write-Host "FAIL [changelog-check-broken-manifest] exit=$rc falseMatchClaim=$([bool]($out -match '\(matches plugin\.json\)')) notCheckedReported=$([bool]($out -match 'NOT CHECKED'))" -ForegroundColor Red }
$results += [pscustomobject]@{ case = 'changelog-check-broken-manifest'; exit = $(if ($honest) { 1 } else { 0 }) }

# --- dogfood placement sweep (ADR 0037 follow-up) ----------------------------------------------
# Canon-shape fixtures: repo/.harness.json + repo/plugins/ywr-harness/<plugin copy>. Placements
# are laid per case — an absent destination is "not placed", never a failure, so a minimal
# fixture exercises exactly the branch under test without running the scaffold (which would drag
# python/git into a suite that needs neither). Positive cases assert the MESSAGE as well as the
# exit code, the changelog-check-broken-manifest precedent.
function New-CanonShape([string]$tag) {
    $repo = Join-Path $base "$tag/repo"
    New-Item -ItemType Directory -Force -Path (Join-Path $repo 'plugins') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $repo '.claude-plugin') | Out-Null
    Copy-Item -LiteralPath $src -Destination (Join-Path $repo 'plugins/ywr-harness') -Recurse -Force
    Set-Content -LiteralPath (Join-Path $repo '.harness.json') -Value '{}' -NoNewline
    Set-Content -LiteralPath (Join-Path $repo '.claude-plugin/marketplace.json') -Value '{}' -NoNewline
    return $repo
}
function Run-GateAt([string]$repo) {
    $out = & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'plugins/ywr-harness/manifest-gate.ps1') 2>&1 | Out-String
    return @{ out = $out; rc = $LASTEXITCODE }
}
function Record([string]$tag, [bool]$asRequired, [string]$detail) {
    if ($asRequired) { Write-Host "PASS [$tag] $detail" -ForegroundColor Green }
    else { Write-Host "FAIL [$tag] $detail" -ForegroundColor Red }
    $script:results += [pscustomobject]@{ case = $tag; exit = $(if ($asRequired) { 1 } else { 0 }) }
}

# A drifted TOOLCHAIN placement must fail — this is the exact class ADR 0037 recorded as ungated.
$r = New-CanonShape 'placement-drifted'
New-Item -ItemType Directory -Force -Path (Join-Path $r '.githooks') | Out-Null
Set-Content -LiteralPath (Join-Path $r '.githooks/pre-commit') -Value '#!/bin/sh
echo drifted' -NoNewline
$g = Run-GateAt $r
Record 'placement-drifted' ($g.rc -eq 1 -and $g.out -match 'dogfood placement DIVERGED: \.githooks/pre-commit') "exit=$($g.rc) diverged-named=$([bool]($g.out -match 'DIVERGED'))"

# A CR-only difference is NOT drift — ADR 0033's fold contract, shared with the scaffold report
# and the refresh nudge (the seed .gitattributes pins *.ps1 eol=crlf, so raw bytes MUST not decide).
$r = New-CanonShape 'placement-cr-only'
$tpl = [IO.File]::ReadAllBytes((Join-Path $r 'plugins/ywr-harness/skills/harness-init/templates/scripts/harness/harness_config.py'))
$crlf = [System.Text.Encoding]::Latin1.GetString($tpl).Replace("`r`n", "`n").Replace("`n", "`r`n")
New-Item -ItemType Directory -Force -Path (Join-Path $r 'scripts/harness') | Out-Null
[IO.File]::WriteAllBytes((Join-Path $r 'scripts/harness/harness_config.py'), [System.Text.Encoding]::Latin1.GetBytes($crlf))
$g = Run-GateAt $r
Record 'placement-cr-only-not-drift' ($g.rc -eq 0 -and $g.out -match 'dogfood placements identical .*1 checked') "exit=$($g.rc) identical-1-checked=$([bool]($g.out -match '1 checked'))"

# A GUARDED destination without the marker is a foreign file: skipped and NAMED, exactly as the
# scaffold refuses it — never compared, never failed.
$r = New-CanonShape 'placement-foreign-guarded'
New-Item -ItemType Directory -Force -Path (Join-Path $r '.githooks') | Out-Null
Set-Content -LiteralPath (Join-Path $r '.githooks/post-commit') -Value '#!/bin/sh
# my own automation, not the scaffold''s' -NoNewline
$g = Run-GateAt $r
Record 'placement-foreign-guarded-skipped' ($g.rc -eq 0 -and $g.out -match 'foreign \(no scaffold marker\), skipped .*post-commit') "exit=$($g.rc) foreign-named=$([bool]($g.out -match 'foreign'))"

# A GUARDED file that DOES carry the marker is ours — drift in it must fail like any placement.
$r = New-CanonShape 'placement-guarded-marked-drift'
New-Item -ItemType Directory -Force -Path (Join-Path $r '.githooks') | Out-Null
Set-Content -LiteralPath (Join-Path $r '.githooks/post-commit') -Value '#!/bin/sh
# ywr-harness:post-commit
echo drifted' -NoNewline
$g = Run-GateAt $r
Record 'placement-guarded-marked-drift' ($g.rc -eq 1 -and $g.out -match 'dogfood placement DIVERGED: \.githooks/post-commit') "exit=$($g.rc)"

# The pair list is parsed from init.ps1 — a parse that yields nothing must FAIL, not sweep zero
# pairs and read as coverage.
$r = New-CanonShape 'placement-map-unparseable'
$ip = Join-Path $r 'plugins/ywr-harness/skills/harness-init/init.ps1'
(Get-Content -LiteralPath $ip -Raw).Replace('$TOOLCHAIN = [ordered]@{', '$RENAMED_MAP = [ordered]@{') | Set-Content -LiteralPath $ip -NoNewline
$g = Run-GateAt $r
Record 'placement-map-unparseable' ($g.rc -eq 1 -and $g.out -match 'an empty sweep is not a pass') "exit=$($g.rc)"

# A PARTIALLY unparseable map is the silent-narrowing variant: one entry rewritten in a form the
# parser does not read must FAIL loudly, not drop that one pair while the sweep still counts >0.
$r = New-CanonShape 'placement-map-partial-parse'
$ip = Join-Path $r 'plugins/ywr-harness/skills/harness-init/init.ps1'
(Get-Content -LiteralPath $ip -Raw).Replace("'githooks/pre-commit'                    = '.githooks/pre-commit'", '"githooks/pre-commit"                    = ".githooks/pre-commit"') | Set-Content -LiteralPath $ip -NoNewline
$g = Run-GateAt $r
Record 'placement-map-partial-parse' ($g.rc -eq 1 -and $g.out -match 'unparsed entry line') "exit=$($g.rc) unparsed-named=$([bool]($g.out -match 'unparsed entry line'))"

# Same class, non-quote-prefixed: a bareword key does not LOOK like a quoted entry, and the
# first cut's quote-prefixed guard let exactly that vanish (review 2026-08-07, medium).
$r = New-CanonShape 'placement-map-bareword-key'
$ip = Join-Path $r 'plugins/ywr-harness/skills/harness-init/init.ps1'
(Get-Content -LiteralPath $ip -Raw).Replace("'githooks/pre-commit'                    = '.githooks/pre-commit'", "githooks_precommit                    = '.githooks/pre-commit'") | Set-Content -LiteralPath $ip -NoNewline
$g = Run-GateAt $r
Record 'placement-map-bareword-key' ($g.rc -eq 1 -and $g.out -match 'unparsed entry line') "exit=$($g.rc)"

# GUARDED emptiness must fail SYMMETRICALLY with TOOLCHAIN: Get-PlacementMap returns a real
# empty dictionary when the wrapper matches but nothing inside parses, so a null-check alone
# lets one family's coverage vanish while the sweep still reports green (review 2026-08-07,
# high). Commenting out the single entry is exactly the merge-accident shape.
$r = New-CanonShape 'placement-map-guarded-emptied'
$ip = Join-Path $r 'plugins/ywr-harness/skills/harness-init/init.ps1'
(Get-Content -LiteralPath $ip -Raw).Replace("    'githooks/post-commit' = '.githooks/post-commit'", "    # 'githooks/post-commit' = '.githooks/post-commit'") | Set-Content -LiteralPath $ip -NoNewline
$g = Run-GateAt $r
Record 'placement-map-guarded-emptied' ($g.rc -eq 1 -and $g.out -match 'an empty sweep is not a pass' -and $g.out -match 'guarded=0') "exit=$($g.rc) guarded0-named=$([bool]($g.out -match 'guarded=0'))"

# A consuming repo that hand-vendors the plugin tree has a declaration but NOT the publisher's
# root marketplace manifest — sweeping its placements against a vendored plugin version would
# fail on version skew, not drift, so the shape must skip and say so (review 2026-08-07, low).
$r = Join-Path $base 'placement-skip-vendored-consumer/repo'
New-Item -ItemType Directory -Force -Path (Join-Path $r 'plugins') | Out-Null
Copy-Item -LiteralPath $src -Destination (Join-Path $r 'plugins/ywr-harness') -Recurse -Force
Set-Content -LiteralPath (Join-Path $r '.harness.json') -Value '{}' -NoNewline
$out = & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $r 'plugins/ywr-harness/manifest-gate.ps1') 2>&1 | Out-String
Record 'placement-skip-vendored-consumer' ($LASTEXITCODE -eq 0 -and $out -match 'dogfood placements: skipped') "exit=$LASTEXITCODE skip-said=$([bool]($out -match 'skipped'))"

# The plugins/ parent WITHOUT a .harness.json above (the dist/marketplace-cache shape) is not a
# scaffolded repo: the sweep must say it skipped, not pass silently and not fail.
$r = Join-Path $base 'placement-skip-cache-shape/plugins'
New-Item -ItemType Directory -Force -Path $r | Out-Null
Copy-Item -LiteralPath $src -Destination (Join-Path $r 'ywr-harness') -Recurse -Force
$out = & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $r 'ywr-harness/manifest-gate.ps1') 2>&1 | Out-String
Record 'placement-skip-cache-shape' ($LASTEXITCODE -eq 0 -and $out -match 'dogfood placements: skipped') "exit=$LASTEXITCODE skip-said=$([bool]($out -match 'skipped'))"

# A POSITIVE control: the unmutated copy must still pass. Without it a gate that fails on
# everything (a broken gate) would score a perfect negative suite. The copy sits with no repo
# above it, so the placement sweep must also SAY it skipped (never a silent no-op).
$ok = Join-Path $base 'unmutated-control'
Copy-Item -LiteralPath $src -Destination $ok -Recurse -Force
$ctlOut = & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ok 'manifest-gate.ps1') 2>&1 | Out-String
$ctl = $LASTEXITCODE
if ($ctl -eq 0 -and $ctlOut -match 'dogfood placements: skipped') { Write-Host 'PASS [unmutated-control] gate exited 0, placement sweep reported its skip' -ForegroundColor Green }
else { Write-Host "FAIL [unmutated-control] exit=$ctl skip-said=$([bool]($ctlOut -match 'dogfood placements: skipped'))" -ForegroundColor Red; $ctl = 1 }

Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue

$missed = @($results | Where-Object { $_.exit -ne 1 })
Write-Host ''
Write-Host "mutations=$($results.Count) caught=$($results.Count - $missed.Count) missed=$($missed.Count) control=$ctl"
if ($missed.Count -or $ctl -ne 0) {
    Write-Host 'manifest-gate.selftest: FAILED' -ForegroundColor Red
    exit 1
}
Write-Host 'manifest-gate selftest: all mutations caught, control green' -ForegroundColor Green
exit 0
