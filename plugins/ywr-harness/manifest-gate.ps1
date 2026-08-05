# Manifest + wiring gate. Deterministic, no Claude CLI dependency, runs identically on
# Windows and Linux pwsh.
#
# `claude plugin validate --strict` is the richer check but needs the CLI installed and is a
# LOCAL pre-commit habit, not a CI step: installing Claude Code on a runner to read one JSON
# file is a dependency this gate does not need. What CI must catch is the class that actually
# breaks a shipped plugin, and all of it is deterministic:
#
#   1. `version` missing — omitted `version` makes Claude Code fall back to the git commit SHA,
#      so EVERY commit becomes a new version and propagates to every consumer. This is the one
#      manifest defect with org-wide blast radius, so it is a hard failure here.
#   2. A hook path that does not resolve — the regression a file move or rename produces. The
#      plugin loads, the hook silently never runs (the ADR 0120 `config_source` class: green
#      selftests over a name nothing carries).
#   3. Shell form where a path placeholder is used — exec form (`args` present) is the shipped
#      decision because a marketplace install path contains a version string. A regression to
#      shell form reintroduces the quoting surface without any visible symptom.
#   4. A release-notes canon that lies (ADR 0030) — the top CHANGELOG entry disagreeing with
#      plugin.json, or the artifact link diverging between the CHANGELOG and the announce hook.
#      The hook degrades gracefully on member machines, so only this gate makes the defect loud.
#
# Exit 0 = all checks passed. Exit 1 = at least one failed.

$root = $PSScriptRoot
$fail = @()
function Bad($m) { $script:fail += $m; Write-Host "FAIL  $m" -ForegroundColor Red }
function Good($m) { Write-Host "PASS  $m" -ForegroundColor Green }

# --- plugin.json ---------------------------------------------------------------------------
$mfPath = Join-Path $root '.claude-plugin/plugin.json'
if (-not (Test-Path -LiteralPath $mfPath)) {
    Bad "plugin.json not found at .claude-plugin/plugin.json"
} else {
    try { $mf = Get-Content -LiteralPath $mfPath -Raw | ConvertFrom-Json } catch { $mf = $null; Bad "plugin.json does not parse: $($_.Exception.Message)" }
    if ($mf) {
        if ([string]::IsNullOrWhiteSpace([string]$mf.name)) { Bad 'plugin.json: name missing' }
        elseif ([string]$mf.name -notmatch '^[a-z0-9]+(-[a-z0-9]+)*$') { Bad "plugin.json: name '$($mf.name)' is not kebab-case (used for lookup and namespacing)" }
        else { Good "name = $($mf.name)" }

        if ([string]::IsNullOrWhiteSpace([string]$mf.version)) { Bad 'plugin.json: version MISSING — omitted version falls back to the git commit SHA, so every commit ships as a new version to every consumer' }
        elseif ([string]$mf.version -notmatch '^\d+\.\d+\.\d+') { Bad "plugin.json: version '$($mf.version)' is not semantic (major.minor.patch)" }
        else { Good "version = $($mf.version)" }

        if ([string]::IsNullOrWhiteSpace([string]$mf.displayName)) { Bad 'plugin.json: displayName missing — the /plugin picker would fall back to the kebab-case name' }
        else { Good "displayName = $($mf.displayName)" }
    }
}

# --- hooks.json ---------------------------------------------------------------------------
$hkPath = Join-Path $root 'hooks/hooks.json'
$referenced = @()
if (-not (Test-Path -LiteralPath $hkPath)) {
    Bad 'hooks/hooks.json not found'
} else {
    try { $hk = Get-Content -LiteralPath $hkPath -Raw | ConvertFrom-Json } catch { $hk = $null; Bad "hooks.json does not parse: $($_.Exception.Message)" }
    if ($hk) {
        # `| Where-Object { $_ }` is load-bearing, not defensive noise: for an EMPTY PSCustomObject
        # `.PSObject.Properties` is empty, so `.Name` yields $null and `@($null).Count` is 1 — the
        # unfiltered form made this check unable to fire at all. Caught by the first wired run of
        # manifest-gate.selftest.ps1 (`no-events`), which is the whole reason that suite exists.
        $events = @($hk.hooks.PSObject.Properties.Name | Where-Object { $_ })
        if ($events.Count -eq 0) { Bad 'hooks.json: no events registered (an empty hook set is not a pass)' }
        else { Good "events = $($events -join ', ')" }

        foreach ($ev in $events) {
            foreach ($matcherGroup in @($hk.hooks.$ev | Where-Object { $_ })) {
                $handlers = @($matcherGroup.hooks | Where-Object { $_ })
                if ($handlers.Count -eq 0) { Bad "$ev : registered with no handlers (an event whose hooks array is empty never runs)" }
                foreach ($h in $handlers) {
                    $hasArgs = $null -ne $h.args
                    $allParts = @([string]$h.command) + @($h.args | ForEach-Object { [string]$_ })
                    $usesPlaceholder = ($allParts -join ' ') -match '\$\{CLAUDE_(PLUGIN_ROOT|PROJECT_DIR)\}'

                    if ($usesPlaceholder -and -not $hasArgs) {
                        Bad "$ev : path placeholder used in shell form — set 'args' (exec form) so a marketplace install path with a version string needs no quoting"
                    }
                    foreach ($part in $allParts) {
                        if ($part -match '\$\{CLAUDE_PLUGIN_ROOT\}') {
                            $resolved = $part -replace '\$\{CLAUDE_PLUGIN_ROOT\}', $root
                            $referenced += $resolved
                            if (Test-Path -LiteralPath $resolved) { Good "$ev -> $(Split-Path $resolved -Leaf)" }
                            else { Bad "$ev : referenced path does not exist -> $part" }
                        }
                    }
                }
            }
        }
    }
}

# --- release-notes canon (ADR 0030) ----------------------------------------------------------
# The version-announce hook renders CHANGELOG.md at session start on member machines; these are
# the two agreements that make that rendering true. Both are canon-side checks on purpose — the
# hook itself degrades gracefully when the canon is wrong, so a defect here would otherwise ship
# silently and surface only as a bullet-less announcement on every member machine.
#   1. The top CHANGELOG entry's version must equal plugin.json's — a release cannot ship
#      without its notes, and stale notes must not masquerade as current ones.
#   2. The artifact release-notes-tab URL appears in BOTH the hook and the CHANGELOG header;
#      they must agree — one link, two shipped surfaces, zero drift.
$clPath = Join-Path $root 'CHANGELOG.md'
$vaPath = Join-Path $root 'hooks/session-start-version-announce.ps1'
if (-not (Test-Path -LiteralPath $clPath)) {
    Bad 'CHANGELOG.md missing — the version-announce hook would ship without its release-notes canon (ADR 0030)'
} else {
    $clTopVer = ''
    foreach ($ln in (Get-Content -LiteralPath $clPath)) {
        if ($ln -match '^##\s+v(\d+\.\d+\.\d+\S*)') { $clTopVer = $Matches[1]; break }
    }
    # `-not $mf` gets its own branch, BEFORE the comparison: with plugin.json unreadable the
    # comparison never ran, and the first draft's `elseif ($mf -and ...) else Good` printed
    # "(matches plugin.json)" for a check it never performed — a skipped check reading as a pass
    # (review 2026-08-05, medium; the exit code was already 1 from the manifest Bad, so only the
    # MESSAGE lied, which is exactly why the selftest pins the message, not the exit code).
    if (-not $clTopVer) { Bad 'CHANGELOG.md has no "## vX.Y.Z" entry — nothing for the announce hook to render' }
    elseif (-not $mf) { Bad "CHANGELOG top entry = v$clTopVer, but plugin.json is unreadable (see the manifest failure above) — version agreement NOT CHECKED, not passed" }
    elseif ($clTopVer -ne [string]$mf.version) { Bad "CHANGELOG top entry is v$clTopVer but plugin.json says $($mf.version) — a release cannot ship without its notes (ADR 0030)" }
    else { Good "CHANGELOG top entry = v$clTopVer (matches plugin.json)" }

    # Case-insensitive hex on purpose: an uppercase artifact id would otherwise make BOTH sides
    # read empty and fail as "link missing" even when byte-identical (review 2026-08-05, low —
    # an over-strict gate blocking a legitimate release, not a leak).
    $urlRx = 'https://claude\.ai/code/artifact/[0-9A-Fa-f-]+#rn'
    $clUrl = ([regex]::Match((Get-Content -LiteralPath $clPath -Raw), $urlRx)).Value
    $hkUrl = if (Test-Path -LiteralPath $vaPath) { ([regex]::Match((Get-Content -LiteralPath $vaPath -Raw), $urlRx)).Value } else { '' }
    if (-not $clUrl -or -not $hkUrl) { Bad "release-notes link missing (want the artifact #rn URL in both surfaces): CHANGELOG='$clUrl' hook='$hkUrl'" }
    elseif ($clUrl -ne $hkUrl) { Bad "release-notes link DIVERGED: CHANGELOG '$clUrl' vs hook '$hkUrl' — one link, two surfaces (ADR 0030)" }
    else { Good 'release-notes link agrees across CHANGELOG.md and the announce hook' }
}

# --- component namespacing ------------------------------------------------------------------
# Plugin components are addressed as `<plugin>:<name>`, so an instruction that names one bare
# fails at the point of use. Measured 2026-07-26 in a live sideloaded session:
#   Workflow "adversarial-review" not found. Available: ..., ywr-harness:adversarial-review
# The workflow had loaded correctly; the shipped instruction was simply wrong. Nothing in the
# suite caught it, because every selftest calls the scripts directly and never goes through the
# host's component registry. This gate is that missing check.
#
# Two forms are refused:
#   Workflow({name: '<shipped workflow>'   — runtime-fatal, the call cannot resolve
#   `/<shipped skill>`                     — copy-paste invocation; the reader types a dead command
# Headings are exempt: a skill's own H1 states its identity, and the namespace is a host-side
# prefix rather than part of the name. Anything a reader would COPY must carry it.
$pluginName = if ($mf) { [string]$mf.name } else { '' }
if ($pluginName) {
    $shippedWf = @(Get-ChildItem -LiteralPath (Join-Path $root 'workflows') -File -Filter '*.js' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '\.selftest\.' } | ForEach-Object { $_.BaseName })
    $shippedSkills = @(Get-ChildItem -LiteralPath (Join-Path $root 'skills') -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { $_.Name })
    $scanned = @(Get-ChildItem -LiteralPath $root -Recurse -File -Include '*.md', '*.js', '*.mjs')
    $nsBad = 0
    foreach ($f in $scanned) {
        $lineNo = 0
        foreach ($line in (Get-Content -LiteralPath $f.FullName)) {
            $lineNo++
            if ($line -match '^\s*#') { continue }   # heading: identity, not an invocation
            foreach ($w in $shippedWf) {
                if ($line -match ("Workflow\(\{\s*name:\s*['""]" + [regex]::Escape($w) + "['""]")) {
                    Bad "$($f.Name):$lineNo — Workflow call names '$w' bare; plugin components resolve as '${pluginName}:$w'"
                    $nsBad++
                }
            }
            foreach ($s in $shippedSkills) {
                if ($line -match ('`/' + [regex]::Escape($s) + '`')) {
                    Bad "$($f.Name):$lineNo — slash invocation ``/$s`` is bare; it resolves as ``/${pluginName}:$s``"
                    $nsBad++
                }
            }
        }
    }
    if ($nsBad -eq 0) {
        Good "namespacing: $($shippedWf.Count) workflow(s) + $($shippedSkills.Count) skill(s) referenced with the '${pluginName}:' prefix"
    }
}

# --- vendored-copy identity -------------------------------------------------------------------
# The scaffold vendors the harness scripts into a consuming repo so its CI needs no access to this
# private canon. That means two copies of each script exist, which is the divergence this whole
# plugin argues against — EXCEPT that one is generated from the other and this gate proves it.
# Without the gate, a fix applied to `scripts/` would silently not reach any scaffolded repo, and
# the failure would look like "the consumer is on an old version" rather than "the canon shipped
# two different files under one name".
$vendorDir = Join-Path $root 'skills/harness-init/templates/scripts/harness'
#
# Scoped to `*.py`, and the scope is DECLARED rather than assumed: that directory also carries pure
# template payload (a nested `.gitignore`) which has no plugin-side origin by design. The first run
# after adding that file failed the unmutated control — the arm that exists so a gate which fails on
# everything cannot score a perfect negative suite. It worked.
if (Test-Path -LiteralPath $vendorDir -PathType Container) {
    $drift = 0
    $vendorAll = @(Get-ChildItem -LiteralPath $vendorDir -File)
    $vendorPayload = @($vendorAll | Where-Object { $_.Extension -ne '.py' })
    foreach ($v in @($vendorAll | Where-Object { $_.Extension -eq '.py' })) {
        $origin = Join-Path $root "scripts/$($v.Name)"
        if (-not (Test-Path -LiteralPath $origin -PathType Leaf)) {
            Bad "vendored templates/scripts/harness/$($v.Name) has no origin at scripts/$($v.Name)"
            $drift++
            continue
        }
        $a = [IO.File]::ReadAllBytes($origin)
        $b = [IO.File]::ReadAllBytes($v.FullName)
        if ($a.Length -ne $b.Length -or (Compare-Object $a $b)) {
            Bad "vendored copy DIVERGED: $($v.Name) — re-copy scripts/$($v.Name) into skills/harness-init/templates/scripts/harness/"
            $drift++
        }
    }
    if ($drift -eq 0) {
        $checked = @($vendorAll | Where-Object { $_.Extension -eq '.py' }).Count
        $skipNote = if ($vendorPayload.Count) { " · $($vendorPayload.Count) template payload file(s) have no origin by design: $(($vendorPayload | ForEach-Object { $_.Name }) -join ', ')" } else { '' }
        Good "vendored copies byte-identical to scripts/ ($checked script(s))$skipNote"
    }
}

# --- coverage report (visible every run, never a silent cap) --------------------------------
# Nothing is excluded but the selftests themselves. Excluding the runner, the gate, or the
# shared lib would be the ADR 0125 miscount: a coverage number narrowed by an undeclared
# filter reads as full coverage. A count is only as wide as the population it enumerates.
#
# A selftest may be `.ps1` or `.mjs` (the workflow corpus is JS-side), and shipped artifacts now
# include `.js` workflows. Both lists derive from ONE enumeration so a new extension cannot land
# in `shipped` while being invisible to `tested` — that skew would report real coverage as debt,
# or worse, debt as coverage.
# ONE declared exclusion beyond the selftests: skill template payload. Files under a
# `templates/` directory are content this plugin COPIES into a consuming repo, not code it runs —
# `templates/docs/build.ps1` belongs to whatever repo it lands in and cannot have a selftest here.
# Declared and counted separately rather than filtered in silence, because an undeclared narrowing
# is exactly how a partial count comes to read as full coverage (ADR 0125).
$selftestRx = '\.selftest\.(ps1|mjs|js)$'
$templateRx = '[\\/]templates[\\/]'
$found = @(Get-ChildItem -LiteralPath $root -Recurse -File -Include '*.ps1', '*.mjs', '*.js', '*.sh', '*.py')
$templatePayload = @($found | Where-Object { $_.FullName -match $templateRx })
$all = @($found | Where-Object { $_.FullName -notmatch $templateRx })
$shipped = @($all | Where-Object { $_.Name -notmatch $selftestRx })
$tested = @($all | Where-Object { $_.Name -match $selftestRx } | ForEach-Object { $_.Name -replace $selftestRx, '' })
$uncovered = @($shipped | Where-Object { $tested -notcontains ($_.Name -replace '\.(ps1|mjs|js|sh|py)$', '') } | ForEach-Object { $_.Name })

Write-Host ''
Write-Host "coverage: shipped=$($shipped.Count) with-selftest=$($shipped.Count - $uncovered.Count) uncovered=$($uncovered.Count) template-payload-excluded=$($templatePayload.Count)"
if ($uncovered.Count) {
    Write-Host "  UNCOVERED (ships without a selftest in this plugin): $($uncovered -join ', ')" -ForegroundColor Yellow
    Write-Host '  Not a failure — declared so it stays visible rather than reading as full coverage.' -ForegroundColor Yellow
}

Write-Host ''
if ($fail.Count) { Write-Host "manifest-gate: FAILED ($($fail.Count))" -ForegroundColor Red; exit 1 }
Write-Host 'manifest-gate: all checks passed' -ForegroundColor Green
exit 0
