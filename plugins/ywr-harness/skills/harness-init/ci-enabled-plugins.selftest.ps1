# Selftest for the vendored CI's "Fail on a committed enabledPlugins" step (ADR 0022) — the CI half
# of the gate whose hook half is githooks.selftest.ps1 B2–B6. The step is inline python inside
# templates/.github/workflows/harness-gates.yml (TOOLCHAIN payload; the placed copy is byte-identical
# to it, ADR 0014 / manifest-gate). Until this suite its only run was a fixture harness in a session
# scratchpad (2026-07-27), so the properties ADR 0022 decided — BOTH settings files · the KEY
# regardless of value · a \uXXXX-escaped spelling · "cannot parse" is "cannot verify", never a pass ·
# tracked files only — had no test that ran again. B6 over there asserts the hook does NOT catch the
# escaped key "because CI does"; C5 here is the half that makes that sentence true.
#
# The step's text is EXTRACTED from the template and executed in throwaway git repos, so what runs
# is what ships: a renamed step or a moved heredoc fails this suite loudly instead of testing nothing.

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot '../../lib/selftest-lib.ps1')   # assertion core, ADR 0125

$yml = Join-Path $PSScriptRoot 'templates/.github/workflows/harness-gates.yml'
if (-not (Test-Path -LiteralPath $yml -PathType Leaf)) {
    Write-Host "FAIL — workflow template missing: $yml" -ForegroundColor Red
    exit 1
}
$ok = $true

# --- WS: static classes over the workflow TEXT (dist issue #6, ADR 0087) --------------------------
# Two finding classes earlier reviews had to find by hand, made deterministic so they cost no review
# tokens: (1) a `${{ }}` expression spliced into `run:` text — the shell-injection surface this
# file's own rule (values reach a script through `env:` only) exists to close, and which the
# secret-scan step carried until dist issue #6; (2) a `uses:` that is not a full 40-hex commit SHA
# with its `# vX.Y.Z` comment (ADR 0087). They need neither git nor python, so they run ahead of
# the SKIP exits below, and those exits carry their verdict instead of dropping it.
# Scope: the shipped template, plus the canon's own .github/workflows when this plugin sits in the
# canon dogfood shape (the manifest gate's test: plugins/ywr-harness under a root holding both
# .harness.json and .claude-plugin/marketplace.json) — a marketplace cache, the dist, and the Linux
# parity container have no canon workflows, and that is reported, not silent.
# What is guaranteed, exactly: WS1/WS2 are LINE readers of `run:` / `uses:` written as plain block
# keys, and WS3 refuses every other YAML spelling of a key or value (below) — so the guarantee is
# "for a workflow in the shape WS3 enforces", not "for any YAML GitHub accepts". No YAML parser runs.
function Get-RunExpressionHits([string[]]$Lines) {
    # A `run:` value is its key line plus every following line indented deeper than the key (blank
    # lines included) — whatever the scalar style: a `|`/`>` block, a plain scalar continued on the
    # next lines (`run:` + `  echo …`, or `run: echo a` + `  …`), or a quoted scalar spanning lines.
    # YAML puts every continuation line of a block-mapping value deeper than its key, so one rule
    # reads them all; reading only `|`/`>` bodies missed the plain and quoted multi-line forms
    # (review 2026-09-23, low). A DOUBLE-quoted value holding a backslash is a hit on its own: its
    # escapes (`\x24`, a 4-hex `\u` escape of `$`, an escaped line break joining `$` to `{{`) spell
    # `${{` without the literal text a line reader looks for. `env:`/`if:`/`with:` values are the
    # sanctioned place for an expression and are never scanned.
    $hits = New-Object System.Collections.Generic.List[string]
    $blocks = 0
    $keyCol = -1
    $dq = $false
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $l = $Lines[$i]
        if ($keyCol -ge 0) {
            if ($l.Trim().Length -eq 0) { continue }
            if (($l.Length - $l.TrimStart().Length) -gt $keyCol) {
                if ($l.Contains('${{') -or ($dq -and $l.Contains('\'))) { $hits.Add("line $($i + 1): $($l.Trim())") }
                continue
            }
            $keyCol = -1
        }
        if ($l -match '^(\s*)(-\s+)?run:(\s+(.*))?$') {
            $col = $Matches[1].Length + $(if ($Matches[2]) { $Matches[2].Length } else { 0 })
            $val = "$($Matches[4])"
            $blocks++
            $keyCol = $col
            $dq = $val.StartsWith('"')
            if ($val -notmatch '^[|>][-+0-9]*\s*(#.*)?$' -and ($val.Contains('${{') -or ($dq -and $val.Contains('\')))) {
                $hits.Add("line $($i + 1): $($l.Trim())")
            }
        }
    }
    return @{ Hits = @($hits); Blocks = $blocks }
}
function Get-ShapeHits([string[]]$Lines) {
    # The shape rule WS1/WS2's guarantee rests on. Outside a scalar's own text (a block body or a
    # multi-line scalar's continuation — deeper than its key, the rule Get-RunExpressionHits reads)
    # and comment lines, every line must be a plain `key:` line or a `- item` line, and no value may
    # open a flow mapping, an anchor, an alias, a tag or an explicit key. Each refused construct is
    # a spelling GitHub accepts and the line readers cannot see: `- { uses: a/b@v1 }`, `steps:
    # [ {run: …} ]`, a quoted, tagged or spaced key (`"run":`, `!!str run:`, `uses :`), `? run`,
    # `run: *script` with `&script` under another key, `<<: *defaults`. The flow forms allowed hold
    # no key: an empty flow mapping (`permissions: {}`) and a flow sequence of plain scalars closed
    # on its line (`branches: [main, master]`).
    $hits = New-Object System.Collections.Generic.List[string]
    $bodyCol = -1
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $l = $Lines[$i]
        $ind = $l.Length - $l.TrimStart().Length
        if ($bodyCol -ge 0) {
            if ($l.Trim().Length -eq 0 -or $ind -gt $bodyCol) { continue }
            $bodyCol = -1
        }
        $t = $l.Trim()
        if ($t.Length -eq 0 -or $t.StartsWith('#') -or $t -eq '-') { continue }
        $why = $null
        if ($l -match '^(\s*)(-\s+)?([A-Za-z_][A-Za-z0-9_-]*):(\s+(.*))?$') {
            $key = $Matches[3]
            $col = $Matches[1].Length + $(if ($Matches[2]) { $Matches[2].Length } else { 0 })
            $v = "$($Matches[5])".Trim()
            if ($v.StartsWith('#')) { $v = '' }
            $isItem = $false
        } elseif ($l -match '^(\s*)-\s+(.*)$') {
            $key = $null; $col = $Matches[1].Length; $v = $Matches[2].Trim(); $isItem = $true
        } else {
            $hits.Add("line $($i + 1): not a plain key or item line: $t"); continue
        }
        if ($v.Length -eq 0) {
            # A nested block follows — except under run:, whose value is always a string, so the
            # deeper lines are its plain multi-line text.
            if ($key -eq 'run') { $bodyCol = $col }
            continue
        }
        $c0 = $v[0]
        if ($v -match '^\{\s*\}\s*(#.*)?$') { }   # `permissions: {}` — an EMPTY flow mapping holds no key
        elseif ('{&*!?@`%'.IndexOf($c0) -ge 0) { $why = "value opens a flow mapping, anchor, alias, tag or reserved indicator ('$c0')" }
        elseif ($c0 -eq '[') {
            if ($v -notmatch '^\[([^\[\]{}:]*)\]\s*(#.*)?$' -or $Matches[1] -match '(^|,)\s*[&*!]') {
                $why = 'a flow sequence that is not plain scalars closed on this line'
            }
        }
        elseif ($isItem -and $v -match '^-(\s|$)') { $why = 'a nested sequence in compact form' }
        elseif ($isItem -and $v -match '^("(?:[^"\\]|\\.)*"|''(?:[^'']|'''')*'')\s*:(\s|$)') { $why = 'a quoted key' }
        elseif ($isItem -and $c0 -ne '"' -and $c0 -ne "'" -and ($v -replace '\s+#.*$', '') -match ':(\s|$)') { $why = 'a key that is not a plain `name:`' }
        if ($why) { $hits.Add("line $($i + 1): ${why}: $t"); continue }
        # A scalar value: any deeper line that follows is its own continuation (text, not structure).
        $bodyCol = $col
    }
    return @{ Hits = @($hits) }
}
function Get-WorkflowVerdict([string[]]$Lines, [bool]$IsTemplate) {
    # The vacuity halves bind the TEMPLATE only: its run: blocks and uses: steps are the point, so a
    # reader that finds none there is broken. A canon workflow made only of uses: steps (a labeler,
    # an upload job) has no run: text to inject into, and one with no uses: has nothing to pin —
    # each passes on the property itself. WS1 once demanded a run: block of every file, so such a
    # workflow failed under the injection rule it cannot violate (review 2026-09-23, nit).
    $rx = Get-RunExpressionHits $Lines
    $ux = Get-UsesPinHits $Lines
    $sx = Get-ShapeHits $Lines
    return @{
        Run = $rx; Uses = $ux; Shape = $sx
        WS1 = ($rx.Hits.Count -eq 0 -and (-not $IsTemplate -or $rx.Blocks -gt 0))
        WS2 = ($ux.Hits.Count -eq 0 -and (-not $IsTemplate -or $ux.Count -gt 0))
        WS3 = ($sx.Hits.Count -eq 0)
    }
}
function Get-UsesPinHits([string[]]$Lines) {
    # Case-SENSITIVE (-cnotmatch): a SHA is lowercase hex, and PowerShell's default -match would
    # accept an uppercase spelling git never prints.
    $hits = New-Object System.Collections.Generic.List[string]
    $count = 0
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -notmatch '^\s*(-\s+)?uses:') { continue }
        $count++
        if ($Lines[$i] -cnotmatch '^\s*(- )?uses: [\w.-]+/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$') {
            $hits.Add("line $($i + 1): $($Lines[$i].Trim())")
        }
    }
    return @{ Hits = @($hits); Count = $count }
}

# WS0: the detectors themselves, on synthetic text — so a detector that finds nothing cannot make
# the per-file cases below pass vacuously. Hits are asserted by LINE, not only by count.
$synthRun = @(
    'jobs:',
    '  j:',
    '    steps:',
    '      - name: a',
    '        env:',
    '          X: ${{ github.base_ref }}',
    '        run: |',
    '          echo "$X"',
    '          echo "${{ github.base_ref }}"',
    '      - run: echo ${{ github.event.before }}',
    '      - name: b',
    '        if: ${{ github.event_name == ''push'' }}',
    '        run: >-',
    '          echo ok',
    '',
    '          echo ${{ x }}',
    '      - name: c',
    '        with:',
    '          k: ${{ y }}'
)
$sr = Get-RunExpressionHits $synthRun
$srLines = @($sr.Hits | ForEach-Object { ($_ -split ':')[0] }) -join ','
$ok = (Assert-True 'WS0 the run: detector flags a block line, an inline run and a folded block — and no env:/if:/with: value' ($sr.Blocks -eq 3 -and $srLines -eq 'line 9,line 10,line 16') "blocks=$($sr.Blocks) hits=$($sr.Hits -join ' | ')") -and $ok
$synthUses = @(
    '        uses: actions/checkout@v5',
    '        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0',
    '      - uses: a/b@FBC6F3992D24B796D5A048FF273F7FCC4A7B6C09 # v5.1.0',
    '        uses: a/b@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
    '        uses: a/b/sub@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v1.2.3',
    '        # uses: a/b@v1'
)
$su = Get-UsesPinHits $synthUses
$suLines = @($su.Hits | ForEach-Object { ($_ -split ':')[0] }) -join ','
$ok = (Assert-True 'WS0 the uses: detector flags a tag, an uppercase SHA and a missing comment — not a pin, a sub-path pin or a comment' ($su.Count -eq 5 -and $suLines -eq 'line 1,line 3,line 4') "count=$($su.Count) hits=$($su.Hits -join ' | ')") -and $ok
# WS0b: every multi-line scalar style under run: is read — plain after an empty value, a quoted
# scalar spanning lines, a plain value continued — and a double-quoted escape that spells `${{`.
# A single-quoted value (no escapes in YAML) and an env: value stay clean.
$synthRunMulti = @(
    'jobs:',
    '  j:',
    '    steps:',
    '      - name: d',
    '        run:',
    '          echo ${{ github.head_ref }}',
    '      - name: e',
    '        run: "echo ok',
    '          ${{ github.head_ref }}"',
    '      - name: f',
    '        run: echo a',
    '          ${{ x }}',
    '      - name: g',
    '        run: "echo \x24{{ github.head_ref }}"',
    '      - name: h',
    '        run: ''echo it''''s fine''',
    '        env:',
    '          Y: ${{ z }}'
)
$srm = Get-RunExpressionHits $synthRunMulti
$srmLines = @($srm.Hits | ForEach-Object { ($_ -split ':')[0] }) -join ','
$ok = (Assert-True 'WS0b the run: detector reads plain, quoted and continued multi-line values and a double-quoted escape — not a single-quoted value or env:' ($srm.Blocks -eq 5 -and $srmLines -eq 'line 6,line 9,line 12,line 14') "blocks=$($srm.Blocks) hits=$($srm.Hits -join ' | ')") -and $ok
# WS0c: the shape rule. Every accepted form the canon files use passes; each spelling the line
# readers cannot see is refused BY LINE — lines 4 and 5 are the flow-mapping steps the uses: reader
# does not even count (review 2026-09-23, low).
$synthShapeOk = @(
    'name: ok',
    'on:',
    '  push:',
    '    branches: [main, master]',
    '    paths:',
    '      - "docs/**"',
    '      - ''plugins/**''',
    'permissions: {}',
    'jobs:',
    '  j:',
    '    runs-on: ubuntu-latest',
    '    strategy:',
    '      matrix:',
    '        shard: ["1/4", "2/4"]',
    '    steps:',
    '      # a comment { with * & ! }',
    '      - name: Checkout',
    '        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0',
    '      - name: a',
    '        if: github.event_name == ''push''',
    '        run: |',
    '          { echo "x: y"; } && echo *',
    '          - not an item',
    '      - run:',
    '          echo plain multi-line',
    '      -',
    '        name: bare dash',
    '        run: echo "k: v" # trailing'
)
$ssOk = Get-ShapeHits $synthShapeOk
$ok = (Assert-True 'WS0c the shape rule accepts every form the canon workflows use (flow scalar lists, quoted items, block and multi-line run: text)' ($ssOk.Hits.Count -eq 0) "hits=$($ssOk.Hits -join ' | ')") -and $ok
$synthShapeBad = @(
    'jobs:',
    '  j:',
    '    steps:',
    '      - { uses: actions/checkout@v5 }',
    '      - {name: x, uses: a/b@main}',
    '      - name: q',
    '        "run": echo ${{ x }}',
    '      - "uses": a/b@v1',
    '      - name: s',
    '        uses : a/b@v1',
    '        run: *script',
    '        x-script: &script echo ${{ x }}',
    '        <<: *defaults',
    '        ? run',
    '        : echo ${{ x }}',
    '        !!str run: echo',
    '    other: [ {run: echo x} ]',
    '    more: [uses: a/b@v1]'
)
$ssBad = Get-ShapeHits $synthShapeBad
$ssBadLines = @($ssBad.Hits | ForEach-Object { ($_ -split ':')[0] }) -join ','
$ok = (Assert-True 'WS0c the shape rule refuses flow-mapping steps, quoted/spaced/tagged/explicit keys, anchors, aliases, merge keys and flow pairs — by line' ($ssBadLines -eq 'line 4,line 5,line 7,line 8,line 10,line 11,line 12,line 13,line 14,line 15,line 16,line 17,line 18') "hits=$($ssBad.Hits -join ' | ')") -and $ok
$suFlow = Get-UsesPinHits $synthShapeBad
$ok = (Assert-True 'WS0c control: the uses: line reader alone counts none of those four uses: spellings (why the shape rule exists)' ($suFlow.Count -eq 0) "count=$($suFlow.Count) hits=$($suFlow.Hits -join ' | ')") -and $ok
# WS0d: the vacuity halves bind the template only (review 2026-09-23, nit). A uses-only canon
# workflow passes WS1 and a run-only one passes WS2; the same texts as the TEMPLATE fail them.
$usesOnly = @(
    'name: labeler',
    'on: [pull_request]',
    'jobs:',
    '  l:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0'
)
$runOnly = @('jobs:', '  r:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo ok')
$vU = Get-WorkflowVerdict $usesOnly $false; $vUt = Get-WorkflowVerdict $usesOnly $true
$vR = Get-WorkflowVerdict $runOnly $false; $vRt = Get-WorkflowVerdict $runOnly $true
$ok = (Assert-True 'WS0d a uses-only canon workflow passes WS1, a run-only one passes WS2 — nothing to inject into or to pin is not a defect' ($vU.WS1 -and $vU.WS2 -and $vU.WS3 -and $vR.WS1 -and $vR.WS2 -and $vR.WS3) "usesOnly WS1=$($vU.WS1) WS2=$($vU.WS2) WS3=$($vU.WS3); runOnly WS1=$($vR.WS1) WS2=$($vR.WS2) WS3=$($vR.WS3)") -and $ok
$ok = (Assert-True 'WS0d control: as the TEMPLATE, the same texts fail the vacuity halves (a reader that finds nothing there is broken)' (-not $vUt.WS1 -and $vUt.WS2 -and $vRt.WS1 -and -not $vRt.WS2) "usesOnly-as-template WS1=$($vUt.WS1) WS2=$($vUt.WS2); runOnly-as-template WS1=$($vRt.WS1) WS2=$($vRt.WS2)") -and $ok

$wfFiles = @($yml)
# Each step only after the previous one held: in the Linux parity container the plugin root IS the
# mount (`/repo`), whose grandparent does not exist — an eager Split-Path chain threw there
# (measured on the first parity run of this case).
$pluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$pluginsDir = Split-Path -Parent $pluginRoot
$canonRoot = if ($pluginsDir) { Split-Path -Parent $pluginsDir } else { '' }
$isCanon = ((Split-Path $pluginRoot -Leaf) -eq 'ywr-harness') -and
           $pluginsDir -and ((Split-Path $pluginsDir -Leaf) -eq 'plugins') -and $canonRoot -and
           (Test-Path -LiteralPath (Join-Path $canonRoot '.harness.json') -PathType Leaf) -and
           (Test-Path -LiteralPath (Join-Path $canonRoot '.claude-plugin/marketplace.json') -PathType Leaf)
if ($isCanon) {
    $canonWf = Join-Path $canonRoot '.github/workflows'
    $canonFiles = @(Get-ChildItem -LiteralPath $canonWf -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in '.yml', '.yaml' } | Sort-Object Name | ForEach-Object { $_.FullName })
    $ok = (Assert-True 'WS canon shape: .github/workflows holds workflows to scan (an empty scan is not a pass)' ($canonFiles.Count -gt 0) "no *.yml under $canonWf") -and $ok
    $wfFiles += $canonFiles
} else {
    Write-Host "SKIP [WS canon workflows] not the canon dogfood shape — template only (reported, not silent)" -ForegroundColor Yellow
}
foreach ($wf in $wfFiles) {
    $wfLines = [IO.File]::ReadAllLines($wf)
    $label = if ($wf -eq $yml) { 'template harness-gates.yml' } else { ".github/workflows/$(Split-Path $wf -Leaf)" }
    $v = Get-WorkflowVerdict $wfLines ($wf -eq $yml)
    $ok = (Assert-True "WS1 no `${{ }} expression inside a run: value — $label ($($v.Run.Blocks) run: key(s))" $v.WS1 "blocks=$($v.Run.Blocks); pass values through env: — $($v.Run.Hits -join ' | ')") -and $ok
    $ok = (Assert-True "WS2 every uses: is a 40-hex SHA pin with a # vX.Y.Z comment — $label ($($v.Uses.Count) uses:)" $v.WS2 "count=$($v.Uses.Count); ADR 0087 — $($v.Uses.Hits -join ' | ')") -and $ok
    $ok = (Assert-True "WS3 the workflow is in the shape WS1/WS2 read (plain block keys; no flow mapping, anchor, alias, tag or non-plain key) — $label" $v.WS3 "rewrite in plain block form — $($v.Shape.Hits -join ' | ')") -and $ok
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'SKIP [ci-enabled-plugins] git absent (reported, not silent) — CI has git' -ForegroundColor Yellow
    if (-not $ok) { Write-Host 'ci-enabled-plugins selftest: FAILED (static WS cases)' -ForegroundColor Red; exit 1 }
    exit 0
}
$py = @('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if (-not $py) {
    if ($env:CI) {
        Write-Host 'FAIL — python absent on CI; a missing interpreter is not a pass' -ForegroundColor Red
        exit 1
    }
    Write-Host 'SKIP [ci-enabled-plugins] python absent (reported, not silent) — CI runs this gate' -ForegroundColor Yellow
    if (-not $ok) { Write-Host 'ci-enabled-plugins selftest: FAILED (static WS cases)' -ForegroundColor Red; exit 1 }
    exit 0
}

# --- extract the step's python from the template ------------------------------------------------
# Anchored on the step NAME, then on the heredoc opener inside that step, then on the closing `PY`.
# The heredoc body shares the opener's indent; that indent is stripped so the text runs as a file.
# Every anchor is asserted: an empty or missing extraction is a FAIL, not a vacuous green.
$STEP_NAME = 'Fail on a committed enabledPlugins'
$lines = [IO.File]::ReadAllLines($yml)
$iName = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*-\s+name:\s+$([regex]::Escape($STEP_NAME))\s*$") { $iName = $i; break }
}
if ($iName -lt 0) {
    Write-Host "FAIL — step '$STEP_NAME' not found in $yml (renamed? this suite tests it by name)" -ForegroundColor Red
    exit 1
}
$iOpen = -1
for ($i = $iName + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*-\s+name:') { break }                      # next step — no heredoc in ours
    if ($lines[$i] -match "^(\s*)python\s+-\s+<<'PY'\s*$") { $iOpen = $i; $indent = $Matches[1].Length; break }
}
if ($iOpen -lt 0) {
    Write-Host "FAIL — no python - <<'PY' heredoc inside step '$STEP_NAME'" -ForegroundColor Red
    exit 1
}
$body = New-Object System.Collections.Generic.List[string]
$closed = $false
for ($i = $iOpen + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq 'PY') { $closed = $true; break }
    $l = $lines[$i]
    if ($l.Trim().Length -eq 0) { $body.Add(''); continue }
    if ($l.Length -lt $indent -or $l.Substring(0, $indent).Trim().Length -ne 0) {
        # A non-blank body line indented LESS than the opener is not a heredoc body line YAML would
        # hand to python as written — the extraction window is corrupt. Named here, not left to
        # surface as an IndentationError from the child (review 2026-09-07, nit).
        Write-Host "FAIL — line $($i + 1) of the heredoc is indented less than its opener; extraction window corrupt: $l" -ForegroundColor Red
        exit 1
    }
    $body.Add($l.Substring($indent))
}
if (-not $closed -or $body.Count -eq 0) {
    Write-Host "FAIL — heredoc in step '$STEP_NAME' has no closing PY or an empty body" -ForegroundColor Red
    exit 1
}
$stepText = ($body -join "`n") + "`n"
foreach ($must in @('json.loads', 'git', 'ls-files', 'enabledPlugins')) {
    if ($stepText -notmatch [regex]::Escape($must)) {
        Write-Host "FAIL — extracted step text lacks '$must'; the extraction window is wrong, not the step" -ForegroundColor Red
        exit 1
    }
}

$fxBase = New-FixtureRoot 'ci-enabled-plugins-selftest'
trap { Remove-FixtureRoot $fxBase; break }

$stepFile = Join-Path $fxBase 'enabled_plugins_step.py'
[IO.File]::WriteAllText($stepFile, $stepText, [Text.UTF8Encoding]::new($false))

# --- fixtures ------------------------------------------------------------------------------------
function New-Repo([string]$Name) {
    $p = Join-Path $fxBase $Name
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    & git -C $p init -q 2>$null
    & git -C $p config user.email 'selftest@example.invalid' 2>$null
    & git -C $p config user.name 'selftest' 2>$null
    & git -C $p commit -q --allow-empty -m seed 2>$null
    return $p
}
function Write-Tracked([string]$Repo, [string]$Rel, [string]$Body) {
    $full = Join-Path $Repo $Rel
    $dir = Split-Path -Parent $full
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [IO.File]::WriteAllText($full, ($Body -replace "`r`n", "`n"), [Text.UTF8Encoding]::new($false))
    # -f: the author's GLOBAL gitignore excludes .claude/settings.local.json (the very fact that hid
    # the file from ADR 0021) — without -f, `add` would stage nothing there and C3 would pass
    # vacuously on this machine while failing on any other. Same discipline as githooks B4.
    & git -C $Repo add -f -- $Rel 2>$null
    & git -C $Repo commit -q -m "add $Rel" 2>$null
}
function Write-Untracked([string]$Repo, [string]$Rel, [string]$Body) {
    $full = Join-Path $Repo $Rel
    $dir = Split-Path -Parent $full
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [IO.File]::WriteAllText($full, ($Body -replace "`r`n", "`n"), [Text.UTF8Encoding]::new($false))
}
function Invoke-Step([string]$Repo) {
    # The step prints Korean. A Windows console codepage is not UTF-8, and an unpinned python would
    # die with UnicodeEncodeError — exit 1 for the WRONG reason, which an "exits 1" assertion cannot
    # tell from the refusal under test — so PYTHONUTF8 is pinned for the child on WINDOWS ONLY and
    # restored. On POSIX nothing is pinned: the ubuntu script gate then runs the step in the same
    # environment the vendored workflow gives it, which is the environment this suite is meant to
    # prove (review 2026-09-07, low — an always-on pin proved the text, never the runner).
    $prev = $env:PYTHONUTF8
    Push-Location $Repo
    try {
        if ($IsWindows) { $env:PYTHONUTF8 = '1' }
        $out = (& $py.Source $stepFile 2>&1) | Out-String
        return @{ Out = $out; Code = $LASTEXITCODE }
    } finally {
        Pop-Location
        if ($IsWindows) { if ($null -eq $prev) { Remove-Item Env:PYTHONUTF8 -ErrorAction SilentlyContinue } else { $env:PYTHONUTF8 = $prev } }
    }
}

# --- CX: the shipped text keeps the git boundary encoding-pinned (CLAUDE.md, issue #40) -----------
# The step's own `git ls-files -z` read parses paths. TARGETS is a closed ASCII set today, so the
# pin is dormant — this case exists so widening the list can never drop it silently.
$ok = (Assert-True 'CX the step''s git read is encoding-pinned (utf-8 + backslashreplace)' ($stepText -match '(?s)subprocess\.run\(\s*\["git",\s*"ls-files"[^)]*encoding="utf-8"[^)]*errors="backslashreplace"') 'no encoding pin on the git ls-files read') -and $ok

$SETTINGS = '.claude/settings.json'
$LOCAL = '.claude/settings.local.json'
$CLEAN_BODY = '{ "permissions": { "allow": ["Bash(git *)"] }, "hooks": {} }'

# --- C0: no target file at all -> pass, and the count says zero were checked ---------------------
$c0 = New-Repo 'c0-none'
$r0 = Invoke-Step $c0
$ok = (Assert-True 'C0 a repo without either settings file passes' ($r0.Code -eq 0) "exit=$($r0.Code) out=$($r0.Out)") -and $ok
$ok = (Assert-True 'C0 the pass line counts zero targets (never a silent pass)' ($r0.Out -match 'OK' -and $r0.Out -match '0개') $r0.Out) -and $ok

# --- C1: the control — a tracked settings.json WITHOUT the key passes -----------------------------
# Without this, a step that refused .claude/settings.json unconditionally would pass C2/C4/C5.
$c1 = New-Repo 'c1-clean'
Write-Tracked $c1 $SETTINGS $CLEAN_BODY
$r1 = Invoke-Step $c1
$ok = (Assert-True 'C1 a shared settings file without the key passes' ($r1.Code -eq 0) "exit=$($r1.Code) out=$($r1.Out)") -and $ok
$ok = (Assert-True 'C1 the file was counted (1 target checked)' ($r1.Out -match '1개') $r1.Out) -and $ok
$ok = (Assert-True 'C1 nothing is reported as an error' ($r1.Out -notmatch '::error::') $r1.Out) -and $ok

# --- C2: --scope project's write target is refused, with the forcing consequence and the ADRs ----
$c2 = New-Repo 'c2-project'
Write-Tracked $c2 $SETTINGS '{ "enabledPlugins": { "ywr-harness@ywrlabs": true } }'
$r2 = Invoke-Step $c2
$ok = (Assert-True 'C2 a committed enabledPlugins in settings.json FAILS the step' ($r2.Code -eq 1) "exit=$($r2.Code) out=$($r2.Out)") -and $ok
$ok = (Assert-True 'C2 the error is a GitHub annotation naming the file' ($r2.Out -match '::error::\.claude/settings\.json') $r2.Out) -and $ok
$ok = (Assert-True 'C2 the governing ADRs are named' ($r2.Out -match 'ADR 0010/0022') $r2.Out) -and $ok
$ok = (Assert-True 'C2 the remedy says rescoping is NOT a fix (ADR 0021 routed members into the unchecked file)' ($r2.Out -match '--scope local' -and $r2.Out -match '해결이 아닙니다') $r2.Out) -and $ok

# --- C3: --scope local's write target is gated too (the file ADR 0021 missed) --------------------
$c3 = New-Repo 'c3-local'
Write-Tracked $c3 $LOCAL '{ "enabledPlugins": { "ywr-harness@ywrlabs": true } }'
$r3 = Invoke-Step $c3
$ok = (Assert-True 'C3 a committed settings.local.json with the key FAILS the step' ($r3.Code -eq 1) "exit=$($r3.Code) out=$($r3.Out)") -and $ok
$ok = (Assert-True 'C3 the annotation names the LOCAL file' ($r3.Out -match '::error::\.claude/settings\.local\.json') $r3.Out) -and $ok

# --- C4: the KEY is refused regardless of value — an uninstall's `{}` residue included -----------
$c4 = New-Repo 'c4-inert'
Write-Tracked $c4 $SETTINGS '{ "enabledPlugins": {} }'
$r4 = Invoke-Step $c4
$ok = (Assert-True 'C4 an inert empty enabledPlugins is refused too (key, not value)' ($r4.Code -eq 1) "exit=$($r4.Code) out=$($r4.Out)") -and $ok
$c4b = New-Repo 'c4b-false'
Write-Tracked $c4b $SETTINGS '{ "enabledPlugins": { "ywr-harness@ywrlabs": false } }'
$r4b = Invoke-Step $c4b
$ok = (Assert-True 'C4b an all-false map is refused too' ($r4b.Code -eq 1) "exit=$($r4b.Code) out=$($r4b.Out)") -and $ok

# --- C5: a \uXXXX-escaped key is the SAME key to a JSON parser — CI catches what the hook cannot --
# The fixture is built without the escape sequence appearing literally in this source (a text
# pass that "helpfully" decodes it would turn the case into a plain-key duplicate of C2 and it would
# still go green), and the raw bytes are asserted NOT to contain the plain spelling before the step
# runs — so the case cannot pass vacuously.
$c5 = New-Repo 'c5-escaped'
$escapedKey = '"' + [char]92 + 'u0065nabledPlugins"'
Write-Tracked $c5 $SETTINGS ('{ ' + $escapedKey + ': { "ywr-harness@ywrlabs": true } }')
$rawC5 = [IO.File]::ReadAllText((Join-Path $c5 $SETTINGS))
$ok = (Assert-True 'C5 fixture holds the ESCAPED spelling, not the plain key (case is not vacuous)' ($rawC5 -notmatch '"enabledPlugins"' -and $rawC5 -match 'u0065nabledPlugins') $rawC5) -and $ok
$r5 = Invoke-Step $c5
$ok = (Assert-True 'C5 the escaped key is refused (the hook''s known limit, B6, is closed here)' ($r5.Code -eq 1) "exit=$($r5.Code) out=$($r5.Out)") -and $ok
$ok = (Assert-True 'C5 the annotation names the file' ($r5.Out -match '::error::\.claude/settings\.json') $r5.Out) -and $ok

# --- C6: a file that does not parse is "cannot verify", never a pass ----------------------------
$c6 = New-Repo 'c6-unparseable'
Write-Tracked $c6 $SETTINGS '{ "enabledPlugins": '
$r6 = Invoke-Step $c6
$ok = (Assert-True 'C6 an unparseable target FAILS the step' ($r6.Code -eq 1) "exit=$($r6.Code) out=$($r6.Out)") -and $ok
$ok = (Assert-True 'C6 the failure says it could not verify, not that it found the key' ($r6.Out -match '파싱할 수 없어' -and $r6.Out -notmatch '선언합니다') $r6.Out) -and $ok
# The same shape with NO key in the truncated text — parse failure alone must fail, or the "cannot
# verify" rule is really "found it by substring".
$c6b = New-Repo 'c6b-unparseable-nokey'
Write-Tracked $c6b $SETTINGS '{ "permissions": '
$r6b = Invoke-Step $c6b
$ok = (Assert-True 'C6b an unparseable target without the key still FAILS (verify, not grep)' ($r6b.Code -eq 1 -and $r6b.Out -match '파싱할 수 없어') "exit=$($r6b.Code) out=$($r6b.Out)") -and $ok
# C6c: bytes that are not UTF-8 at all — a decode error is the same "cannot verify" class as a
# parse error, and must be a named refusal, not a traceback.
$c6c = New-Repo 'c6c-not-utf8'
$c6cPath = Join-Path $c6c $SETTINGS
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $c6cPath) | Out-Null
[IO.File]::WriteAllBytes($c6cPath, [byte[]](0xFF, 0xFE, 0x7B, 0x7D))
& git -C $c6c add -f -- $SETTINGS 2>$null
& git -C $c6c commit -q -m 'add not-utf8' 2>$null
$r6c = Invoke-Step $c6c
$ok = (Assert-True 'C6c a non-UTF-8 target is "cannot verify" (exit 1, named), not a traceback' ($r6c.Code -eq 1 -and $r6c.Out -match '파싱할 수 없어' -and $r6c.Out -notmatch 'Traceback') "exit=$($r6c.Code) out=$($r6c.Out)") -and $ok

# --- C7: TRACKED files only — an untracked local install is the allowed state ------------------
# `claude plugin install --scope local` writes the key into the work tree; the rule is that it
# never reaches git, not that it never exists. A step reading the work tree would fail every
# member who installed the plugin the sanctioned way.
$c7 = New-Repo 'c7-untracked'
Write-Tracked $c7 $SETTINGS $CLEAN_BODY
Write-Untracked $c7 $LOCAL '{ "enabledPlugins": { "ywr-harness@ywrlabs": true } }'
$r7 = Invoke-Step $c7
$ok = (Assert-True 'C7 an UNTRACKED settings.local.json with the key does not fail the step' ($r7.Code -eq 0) "exit=$($r7.Code) out=$($r7.Out)") -and $ok
$ok = (Assert-True 'C7 only the tracked file was counted' ($r7.Out -match '1개') $r7.Out) -and $ok

# --- C8: odd-but-valid JSON shapes are handled, not crashed on --------------------------------
# A top-level list has no keys (isinstance guard); a NESTED enabledPlugins is inert data — the host
# reads the key at the top level only, and a substring check would have refused it.
$c8 = New-Repo 'c8-list'
Write-Tracked $c8 $SETTINGS '[ "not", "an", "object" ]'
$r8 = Invoke-Step $c8
$ok = (Assert-True 'C8 a top-level JSON list passes without a traceback' ($r8.Code -eq 0 -and $r8.Out -notmatch 'Traceback') "exit=$($r8.Code) out=$($r8.Out)") -and $ok
$c8b = New-Repo 'c8b-nested'
Write-Tracked $c8b $SETTINGS '{ "note": { "enabledPlugins": { "x@y": true } } }'
$r8b = Invoke-Step $c8b
$ok = (Assert-True 'C8b a nested enabledPlugins is not the host key — passes (top-level rule, not a substring)' ($r8b.Code -eq 0) "exit=$($r8b.Code) out=$($r8b.Out)") -and $ok

# --- C9–C11: every offending file is named in ONE run, across violation classes -----------------
# C9 both declare the key. C10 one declares the key and the OTHER fails to parse — the first cut of
# the step exited on the first parse failure and never printed the violation it had already found
# (review 2026-09-07, medium); C11 both fail to parse. `git ls-files` lists settings.json before
# settings.local.json, so C10's parse failure is the LATER file — the order that lost the report.
$c9 = New-Repo 'c9-both'
Write-Tracked $c9 $SETTINGS '{ "enabledPlugins": {} }'
Write-Tracked $c9 $LOCAL '{ "enabledPlugins": {} }'
$r9 = Invoke-Step $c9
$ok = (Assert-True 'C9 both offending files are named in one run' ($r9.Code -eq 1 -and $r9.Out -match '::error::\.claude/settings\.json' -and $r9.Out -match '::error::\.claude/settings\.local\.json') "exit=$($r9.Code) out=$($r9.Out)") -and $ok
$c10 = New-Repo 'c10-key-then-unparseable'
Write-Tracked $c10 $SETTINGS '{ "enabledPlugins": {} }'
Write-Tracked $c10 $LOCAL '{ "enabledPlugins": '
$r10 = Invoke-Step $c10
$ok = (Assert-True 'C10 a key violation is still reported when a LATER file fails to parse' ($r10.Code -eq 1 -and $r10.Out -match '::error::\.claude/settings\.json 이 enabledPlugins' -and $r10.Out -match '::error::\.claude/settings\.local\.json 를 파싱할 수 없어') "exit=$($r10.Code) out=$($r10.Out)") -and $ok
$ok = (Assert-True 'C10 the remedy lines accompany the key violation' ($r10.Out -match '해결이 아닙니다') $r10.Out) -and $ok
$c11 = New-Repo 'c11-both-unparseable'
Write-Tracked $c11 $SETTINGS '{ "a": '
Write-Tracked $c11 $LOCAL '[ 1, '
$r11 = Invoke-Step $c11
$ok = (Assert-True 'C11 both unparseable files are named, not only the first' ($r11.Code -eq 1 -and $r11.Out -match '::error::\.claude/settings\.json 를 파싱할 수 없어' -and $r11.Out -match '::error::\.claude/settings\.local\.json 를 파싱할 수 없어') "exit=$($r11.Code) out=$($r11.Out)") -and $ok

Remove-FixtureRoot $fxBase

if (-not $ok) { Write-Host 'ci-enabled-plugins selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'ci-enabled-plugins selftest: all cases green' -ForegroundColor Green
exit 0
