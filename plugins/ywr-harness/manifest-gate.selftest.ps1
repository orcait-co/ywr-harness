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

# A POSITIVE control: the unmutated copy must still pass. Without it a gate that fails on
# everything (a broken gate) would score a perfect negative suite.
$ok = Join-Path $base 'unmutated-control'
Copy-Item -LiteralPath $src -Destination $ok -Recurse -Force
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ok 'manifest-gate.ps1') *> $null
$ctl = $LASTEXITCODE
if ($ctl -eq 0) { Write-Host 'PASS [unmutated-control] gate exited 0' -ForegroundColor Green }
else { Write-Host "FAIL [unmutated-control] gate exited $ctl on an unmodified copy" -ForegroundColor Red }

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
