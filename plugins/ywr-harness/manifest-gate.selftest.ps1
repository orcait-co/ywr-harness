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
# The lib pins [Console]::OutputEncoding (UTF-8, no BOM — ADR 0128) and sets StrictMode off; this
# file set the BOM-bearing UTF8 itself before it dot-sourced the lib — one owner now.
. (Join-Path $PSScriptRoot 'lib/selftest-lib.ps1')   # Invoke-ScriptInRunspace (ADR 0071 option E)

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

# In-process invocation (ADR 0071 option E, second suite, 2026-09-02): each gate copy runs in a NEW
# RUNSPACE of this pwsh through the lib's Invoke-ScriptInRunspace — one gate run 1.63 s as a child,
# ~0.85 s here (the difference is pwsh cold start, paid 29 times in this suite before the contract cases). This suite is a
# NEGATIVE suite — its PASS is "the gate exited 1" — so the runner's abort shape matters more here
# than anywhere: a gate that could not run, or threw, comes back -1/Aborted, which no `exit`
# produces and no case accepts. The gate also keeps a child's preferences (this file's 'Stop' does
# not leak in) so a non-terminating error mid-scan still lets it finish and fail for the RIGHT
# reason. The contracts are pinned as cases at the end.
function Invoke-Gate([string]$GatePath) {
    return Invoke-ScriptInRunspace -Path $GatePath
}

function Try-Case([string]$tag, [scriptblock]$mutate) {
    # Copy the directory ITSELF to a not-yet-existing destination. Pre-creating $dir would nest
    # the copy one level down, and switching to a `$src/*` wildcard is not an option: -LiteralPath
    # takes `*` literally (this exact substitution is what the first wired run caught).
    $dir = Join-Path $base $tag
    Copy-Item -LiteralPath $src -Destination $dir -Recurse -Force
    & $mutate $dir
    $g = Invoke-Gate (Join-Path $dir 'manifest-gate.ps1')
    $rc = $g.Code
    if ($rc -eq 1) { Write-Host "PASS [$tag] gate exited 1 as required" -ForegroundColor Green }
    elseif ($g.Aborted) { Write-Host "FAIL [$tag] gate ABORTED — not an exit code, nothing was proven: $(($g.Out -split "`n")[0])" -ForegroundColor Red }
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
$g = Invoke-Gate (Join-Path $dir 'manifest-gate.ps1')
$out = $g.Out
$rc = $g.Code
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
    $g = Invoke-Gate (Join-Path $repo 'plugins/ywr-harness/manifest-gate.ps1')
    return @{ out = $g.Out; rc = $g.Code }
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
$g = Invoke-Gate (Join-Path $r 'plugins/ywr-harness/manifest-gate.ps1')
$out = $g.Out
Record 'placement-skip-vendored-consumer' ($g.Code -eq 0 -and $out -match 'dogfood placements: skipped' -and $out -match 'release lockstep: skipped — not the canon dogfood shape') "exit=$($g.Code) skip-said=$([bool]($out -match 'dogfood placements: skipped')) lockstep-skip-said=$([bool]($out -match 'release lockstep: skipped'))"

# The plugins/ parent WITHOUT a .harness.json above (the dist/marketplace-cache shape) is not a
# scaffolded repo: the sweep must say it skipped, not pass silently and not fail.
$r = Join-Path $base 'placement-skip-cache-shape/plugins'
New-Item -ItemType Directory -Force -Path $r | Out-Null
Copy-Item -LiteralPath $src -Destination (Join-Path $r 'ywr-harness') -Recurse -Force
$g = Invoke-Gate (Join-Path $r 'ywr-harness/manifest-gate.ps1')
$out = $g.Out
Record 'placement-skip-cache-shape' ($g.Code -eq 0 -and $out -match 'dogfood placements: skipped' -and $out -match 'release lockstep: skipped — not the canon dogfood shape') "exit=$($g.Code) skip-said=$([bool]($out -match 'dogfood placements: skipped')) lockstep-skip-said=$([bool]($out -match 'release lockstep: skipped'))"

# --- release lockstep (ADR 0073) ----------------------------------------------------------------
# Canon-shape fixtures that ARE git repos — the check needs a tag to compare against, so these are
# the only fixtures in this suite that spawn anything since option E: git, five spawns per fixture
# (init · config · add · commit · tag — measured 2026-09-03 on this box under review-agent load:
# 183 + 60 + 692 + 411 + 64 ms, ≈1.4 s) plus the gate's own three or four (≈0.5 s on top of a
# gate run); the eight fixtures below cost the suite roughly 25–35 s (whole-suite figure in
# SESSION_HANDOFF slice 9). The plain canon-shape fixtures above are not git repos and must
# report the check SKIPPED, never pass it silently. Identity rides on the commit as `-c` flags so
# no fixture depends on a repo-local or global identity (the harness_gates.selftest precedent).
$gitHere = [bool](Get-Command git -ErrorAction SilentlyContinue)
function New-LockstepRepo([string]$tag, [string]$version, [scriptblock]$BeforeCommit = $null) {
    $repo = New-CanonShape $tag
    $mfp = Join-Path $repo 'plugins/ywr-harness/.claude-plugin/plugin.json'
    $j = Get-Content -LiteralPath $mfp -Raw | ConvertFrom-Json
    $j.version = $version
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $mfp -NoNewline
    Set-LockstepChangelogTop $repo $version
    if ($BeforeCommit) { & $BeforeCommit $repo }
    & git -C $repo init -q 2>$null | Out-Null
    & git -C $repo config core.autocrlf false 2>$null | Out-Null
    & git -C $repo add -A 2>$null | Out-Null
    & git -C $repo -c user.name=selftest -c user.email=selftest@example.invalid commit -q -m fixture 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "lockstep fixture '$tag': git commit failed (exit $LASTEXITCODE)" }
    & git -C $repo tag "ywr-harness--v$version" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "lockstep fixture '$tag': git tag failed (exit $LASTEXITCODE)" }
    return $repo
}
# The release-notes canon (ADR 0030) must stay green in these fixtures or the exit code stops
# isolating the lockstep check: the top CHANGELOG entry follows the fixture's version.
function Set-LockstepChangelogTop([string]$repo, [string]$version) {
    $clp = Join-Path $repo 'plugins/ywr-harness/CHANGELOG.md'
    $cl = Get-Content -LiteralPath $clp -Raw
    $cl = [regex]::new('(?m)^## v\d+\.\d+\.\d+').Replace($cl, "## v$version", 1)
    Set-Content -LiteralPath $clp -Value $cl -NoNewline
}
function Set-LockstepVersion([string]$repo, [string]$version) {
    $mfp = Join-Path $repo 'plugins/ywr-harness/.claude-plugin/plugin.json'
    $j = Get-Content -LiteralPath $mfp -Raw | ConvertFrom-Json
    $j.version = $version
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $mfp -NoNewline
    Set-LockstepChangelogTop $repo $version
}

if (-not $gitHere) {
    Write-Host 'SKIP [lockstep-*] git not on PATH — the four release-lockstep fixture cases did not run (reported, not silent)' -ForegroundColor Yellow
} else {
    # The tag names plugin.json's version and the tree equals the tag: the lockstep holds.
    $r = New-LockstepRepo 'lockstep-identical' '9.9.9'
    $g = Run-GateAt $r
    Record 'lockstep-identical' ($g.rc -eq 0 -and $g.out -match 'release lockstep: plugins/ywr-harness identical to tag ywr-harness--v9\.9\.9') "exit=$($g.rc) identical-said=$([bool]($g.out -match 'identical to tag'))"

    # The #3 shape: a shipped file moves after the tag, plugin.json still names the released version.
    $r = New-LockstepRepo 'lockstep-moved-unbumped' '9.9.9'
    Add-Content -LiteralPath (Join-Path $r 'plugins/ywr-harness/README.md') -Value "`nmoved after the tag" -NoNewline
    $g = Run-GateAt $r
    Record 'lockstep-moved-unbumped' ($g.rc -eq 1 -and $g.out -match 'release lockstep BROKEN: 1 file\(s\).*plugins/ywr-harness/README\.md') "exit=$($g.rc) broken-named=$([bool]($g.out -match 'lockstep BROKEN'))"

    # An untracked NEW file under the shipped tree is the same defect — `git diff` alone misses it.
    $r = New-LockstepRepo 'lockstep-untracked-new-file' '9.9.9'
    Set-Content -LiteralPath (Join-Path $r 'plugins/ywr-harness/NEW-SHIPPED-FILE.md') -Value 'new after the tag' -NoNewline
    $g = Run-GateAt $r
    Record 'lockstep-untracked-new-file' ($g.rc -eq 1 -and $g.out -match 'release lockstep BROKEN: 1 file\(s\).*NEW-SHIPPED-FILE\.md') "exit=$($g.rc) broken-named=$([bool]($g.out -match 'lockstep BROKEN'))"

    # The remedy: the same move WITH the bump in the same tree — no tag names the new version, so
    # there is nothing to compare and the check says exactly that.
    $r = New-LockstepRepo 'lockstep-bumped-unreleased' '9.9.9'
    Add-Content -LiteralPath (Join-Path $r 'plugins/ywr-harness/README.md') -Value "`nmoved after the tag" -NoNewline
    Set-LockstepVersion $r '9.9.10'
    $g = Run-GateAt $r
    Record 'lockstep-bumped-unreleased' ($g.rc -eq 0 -and $g.out -match 'release lockstep: no local tag ywr-harness--v9\.9\.10' -and $g.out -notmatch 'lockstep BROKEN') "exit=$($g.rc) no-tag-said=$([bool]($g.out -match 'no local tag'))"

    # CR-only divergence is NOT drift — ADR 0033's fold, the contract the dogfood sweep and the
    # refresh nudge already use (review 2026-09-03, medium): a .gitattributes renormalization
    # between the tag and now must not fail a release whose content did not move. The tag holds
    # README.md as LF; the working tree then carries it as CRLF, and only that.
    $latin1 = [System.Text.Encoding]::Latin1
    $r = New-LockstepRepo 'lockstep-cr-only-not-drift' '9.9.9' {
        param($repo)
        $p = Join-Path $repo 'plugins/ywr-harness/README.md'
        $lf = $latin1.GetString([IO.File]::ReadAllBytes($p)).Replace("`r`n", "`n")
        [IO.File]::WriteAllBytes($p, $latin1.GetBytes($lf))
    }
    $p = Join-Path $r 'plugins/ywr-harness/README.md'
    $crlf = $latin1.GetString([IO.File]::ReadAllBytes($p)).Replace("`n", "`r`n")
    [IO.File]::WriteAllBytes($p, $latin1.GetBytes($crlf))
    $g = Run-GateAt $r
    Record 'lockstep-cr-only-not-drift' ($g.rc -eq 0 -and $g.out -match 'release lockstep: plugins/ywr-harness identical to tag ywr-harness--v9\.9\.9') "exit=$($g.rc) identical-said=$([bool]($g.out -match 'identical to tag')) broken-said=$([bool]($g.out -match 'lockstep BROKEN'))"

    # The two "never a false pass" branches (review 2026-09-03, medium — the changelog-check-
    # broken-manifest precedent): a tag that WOULD be checked, and the check cannot run.
    # (1) plugin.json unreadable while the tag exists: the lockstep line must say NOT CHECKED,
    # never "identical" and never "no local tag".
    $r = New-LockstepRepo 'lockstep-unreadable-manifest-with-tag' '9.9.9'
    Set-Content -LiteralPath (Join-Path $r 'plugins/ywr-harness/.claude-plugin/plugin.json') -Value '{ not json' -NoNewline
    $g = Run-GateAt $r
    Record 'lockstep-unreadable-manifest-with-tag' ($g.rc -eq 1 -and $g.out -match 'release lockstep: plugin.json version unreadable .*NOT CHECKED' -and $g.out -notmatch 'identical to tag' -and $g.out -notmatch 'no local tag') "exit=$($g.rc) not-checked-said=$([bool]($g.out -match 'NOT CHECKED'))"
    # (2) git itself fails AFTER the tag is confirmed: a corrupt index kills `diff` and `ls-files`
    # (both read it) while `rev-parse` of a tag ref does not — the check must fail as NOT
    # CHECKED, not report BROKEN over an empty list and not report identical.
    $r = New-LockstepRepo 'lockstep-git-fails-after-tag' '9.9.9'
    [IO.File]::WriteAllBytes((Join-Path $r '.git/index'), [byte[]](1..24))
    $g = Run-GateAt $r
    Record 'lockstep-git-fails-after-tag' ($g.rc -eq 1 -and $g.out -match 'release lockstep: git diff / ls-files against ywr-harness--v9\.9\.9 failed .*NOT CHECKED' -and $g.out -notmatch 'lockstep BROKEN' -and $g.out -notmatch 'identical to tag') "exit=$($g.rc) not-checked-said=$([bool]($g.out -match 'NOT CHECKED'))"

    # A version the tag name cannot be derived from must not route to the no-tag PASS (review
    # 2026-09-03, low): the manifest check accepts a suffix, a ref name does not.
    $r = New-LockstepRepo 'lockstep-version-suffix-not-checked' '9.9.9'
    $mfp = Join-Path $r 'plugins/ywr-harness/.claude-plugin/plugin.json'
    $j = Get-Content -LiteralPath $mfp -Raw | ConvertFrom-Json
    $j.version = '9.9.9 rc'
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $mfp -NoNewline
    $g = Run-GateAt $r
    Record 'lockstep-version-suffix-not-checked' ($g.rc -eq 1 -and $g.out -match "release lockstep: plugin.json version '9\.9\.9 rc' is not a plain major\.minor\.patch.*NOT CHECKED" -and $g.out -notmatch 'no local tag') "exit=$($g.rc) not-checked-said=$([bool]($g.out -match 'not a plain major'))"
}

# A canon shape that is NOT a git repo (every fixture above this section) must report the check
# skipped — with git absent the skip names that instead; either way it is said, never silent.
$r = New-CanonShape 'lockstep-not-a-repo-skips'
$g = Run-GateAt $r
Record 'lockstep-not-a-repo-skips' ($g.rc -eq 0 -and $g.out -match 'release lockstep: skipped — ') "exit=$($g.rc) skip-said=$([bool]($g.out -match 'release lockstep: skipped'))"

# A POSITIVE control: the unmutated copy must still pass. Without it a gate that fails on
# everything (a broken gate) would score a perfect negative suite. The copy sits with no repo
# above it, so the placement sweep must also SAY it skipped (never a silent no-op).
$ok = Join-Path $base 'unmutated-control'
Copy-Item -LiteralPath $src -Destination $ok -Recurse -Force
$gc = Invoke-Gate (Join-Path $ok 'manifest-gate.ps1')
$ctlOut = $gc.Out
$ctl = $gc.Code
if ($ctl -eq 0 -and $ctlOut -match 'dogfood placements: skipped' -and $ctlOut -match 'release lockstep: skipped — not the canon dogfood shape') { Write-Host 'PASS [unmutated-control] gate exited 0, placement sweep and release lockstep both reported their skip' -ForegroundColor Green }
else { Write-Host "FAIL [unmutated-control] exit=$ctl skip-said=$([bool]($ctlOut -match 'dogfood placements: skipped')) lockstep-skip-said=$([bool]($ctlOut -match 'release lockstep: skipped'))" -ForegroundColor Red; $ctl = 1 }

# --- the contracts the in-process runner rests on (review 2026-09-02: a negative suite must never
# --- score an abort as a catch) --------------------------------------------------------------------
# The runner captures SIX streams where a child's console capture saw two: a Write-Warning / Verbose
# / Debug / Information added to the gate would surface in $out for the first time and could flip a
# `-notmatch` (the changelog-check case) or let a loose `-match` pass. The gate reports through
# Write-Host only; pin it so the failure names the reason the day it changes.
$widened = @(Select-String -LiteralPath (Join-Path $src 'manifest-gate.ps1') -Pattern '\bWrite-(Warning|Verbose|Debug|Information)\b' | Where-Object { $_.Line -notmatch '^\s*#' })
Record 'inproc-gate-reports-via-write-host-only' ($widened.Count -eq 0) "the stream-capture contract; offending lines: $(($widened | ForEach-Object { $_.LineNumber }) -join ', ')"
# A runspace shares the process: a process-exit API in the gate would end the whole suite where a
# child confined it. The gate exits through `exit` only — pin it.
$procExit = @(Select-String -LiteralPath (Join-Path $src 'manifest-gate.ps1') -Pattern 'Environment\]::Exit|SetShouldExit' | Where-Object { $_.Line -notmatch '^\s*#' })
Record 'inproc-gate-never-calls-a-process-exit-api' ($procExit.Count -eq 0) "runspace, not child; offending lines: $(($procExit | ForEach-Object { $_.LineNumber }) -join ', ')"
# An abort is -1/Aborted, never the 1 every mutation case accepts. Two abort shapes: a script that
# throws (the gate never does on its own — every failure is a Bad + `exit 1`), and a gate file that
# is not there (a Copy-Item race would have read as "PASS gate exited 1" under a catch that mapped
# every error to 1 — the review's medium finding).
$thrower = Join-Path $base 'thrower.ps1'
Set-Content -LiteralPath $thrower -Value "throw 'boom from the fixture'" -NoNewline
$gt = Invoke-Gate $thrower
Record 'inproc-terminating-error-is-an-abort-not-exit-1' ($gt.Code -eq -1 -and $gt.Aborted -and $gt.Out -match 'boom from the fixture') "code=$($gt.Code) aborted=$($gt.Aborted) message-kept=$([bool]($gt.Out -match 'boom from the fixture'))"
$gm = Invoke-Gate (Join-Path $base 'no-such-dir/manifest-gate.ps1')
Record 'inproc-missing-gate-is-an-abort-not-exit-1' ($gm.Code -eq -1 -and $gm.Aborted -and $gm.Out -match 'script not found') "code=$($gm.Code) aborted=$($gm.Aborted)"
# This file runs under 'Stop'. The gate must not inherit it: a non-terminating error mid-scan (a
# locked file) has to print and let the gate finish, as it did in a child — otherwise an unrelated
# hiccup aborts the gate and, under an adapter that maps aborts to 1, passes as a catch. A fixture
# that hits one such error and then reaches its own `exit 0` proves the preference did not leak.
$nonterm = Join-Path $base 'nonterm.ps1'
Set-Content -LiteralPath $nonterm -Value "Get-Item -LiteralPath (Join-Path '$base' 'no-such-file')`nWrite-Host 'REACHED after a non-terminating error'`nexit 0" -NoNewline
$gn = Invoke-Gate $nonterm
Record 'inproc-callee-keeps-default-preferences' ($gn.Code -eq 0 -and -not $gn.Aborted -and $gn.Out -match 'REACHED after a non-terminating error') "code=$($gn.Code) aborted=$($gn.Aborted) reached=$([bool]($gn.Out -match 'REACHED'))"
# A script that completes without `exit` is a child's 0 — and cannot inherit the PRECEDING case's
# code, because every call gets a fresh runspace (the cases above all just produced 1 or -1).
$noexit = Join-Path $base 'noexit.ps1'
Set-Content -LiteralPath $noexit -Value "Write-Host 'no exit statement'" -NoNewline
$gx = Invoke-Gate $noexit
Record 'inproc-no-exit-is-0-never-the-previous-code' ($gx.Code -eq 0 -and -not $gx.Aborted) "code=$($gx.Code) aborted=$($gx.Aborted)"
# A child returned 0 for a script that ran a FAILING native command and then ended without `exit`;
# the runspace's $LASTEXITCODE would have said 128 (re-review 2026-09-02, high). `$?` right after the
# invocation is the observable that keeps the child's shape — pin it with that exact script. (Where
# git is absent the first line is a CommandNotFound that also continues; the verdict is the same 0.)
$lastNative = Join-Path $base 'lastnative.ps1'
Set-Content -LiteralPath $lastNative -Value "git rev-parse --verify no-such-ref-xyz 2>`$null`nWrite-Host 'after a failing native command, no exit'" -NoNewline
$gl = Invoke-Gate $lastNative
Record 'inproc-failing-last-native-without-exit-is-0-like-a-child' ($gl.Code -eq 0 -and -not $gl.Aborted -and $gl.Out -match 'after a failing native command') "code=$($gl.Code) aborted=$($gl.Aborted)"
# ...and `exit N` after a failing native command is N, as in a child.
$exitN = Join-Path $base 'exitn.ps1'
Set-Content -LiteralPath $exitN -Value "git rev-parse --verify no-such-ref-xyz 2>`$null`nexit 3" -NoNewline
$ge = Invoke-Gate $exitN
Record 'inproc-exit-n-is-n' ($ge.Code -eq 3 -and -not $ge.Aborted) "code=$($ge.Code) aborted=$($ge.Aborted)"
# The gate ends in an explicit `exit` on every path — pin its last statement so a trailing edit that
# drops it fails here by name rather than as a silent verdict change.
$lastStmt = @(Get-Content -LiteralPath (Join-Path $src 'manifest-gate.ps1') | Where-Object { $_.Trim() -and $_.Trim() -notmatch '^#' })[-1]
Record 'inproc-gate-ends-in-an-explicit-exit' ($lastStmt -match '^\s*exit\s+\d+\s*$') "last statement: $lastStmt"

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
