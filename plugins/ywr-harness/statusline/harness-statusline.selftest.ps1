# Selftest for harness-statusline.js.
#
# The rendering rule that actually matters is the NEGATIVE one: a key the payload does not carry
# must make its segment vanish, never render as `0%`. Unmeasured and zero are different states, and
# the status line is the one surface where a confident wrong number is read hundreds of times a day
# without anyone re-checking it. Every absence case below exists for that.
#
# Payload fixtures are shaped from a live 2.1.220 payload captured 2026-07-27, not from the docs.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core, ADR 0125

$mod = Join-Path $PSScriptRoot 'harness-statusline.js'
if (-not (Test-Path -LiteralPath $mod -PathType Leaf)) {
    Write-Host "FAIL — harness-statusline.js missing at $mod" -ForegroundColor Red
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if ($env:CI) {
        Write-Host 'FAIL — node absent on CI; the statusline would ship unexercised' -ForegroundColor Red
        exit 1
    }
    Write-Host 'SKIP [statusline] node absent (reported, not silent) — CI runs this gate' -ForegroundColor Yellow
    exit 0
}

$fxBase = New-FixtureRoot 'statusline-selftest'
trap { Remove-FixtureRoot $fxBase; break }
$ok = $true

# A HOME with no plugin install registry, so the plugin-version segment cannot appear. Without
# this the suite reads the developer's real ~/.claude and every exact-line assertion passes or
# fails depending on what that machine happens to have installed — the org-guide era of this
# suite hit exactly that, and this hermetic HOME is how it was found.
$hermeticHome = Join-Path $fxBase 'hermetic-home'
New-Item -ItemType Directory -Force -Path (Join-Path $hermeticHome '.claude') | Out-Null

function Invoke-Node([string[]]$NodeArgs, [string]$StdInFile) {
    $ph = $env:USERPROFILE; $hh = $env:HOME
    try {
        # os.homedir() reads USERPROFILE on Windows and HOME elsewhere — both are pinned so the
        # same fixture works on either platform.
        $env:USERPROFILE = $hermeticHome; $env:HOME = $hermeticHome
        if ($StdInFile) { return (Get-Content -LiteralPath $StdInFile -Raw | & node @NodeArgs 2>&1) | Out-String }
        return (& node @NodeArgs 2>&1) | Out-String
    } finally { $env:USERPROFILE = $ph; $env:HOME = $hh }
}

# Drive the module through stdin, exactly as Claude Code does. Output is stripped of ANSI so the
# assertions read as the text a person sees.
function Invoke-Line([string]$Json) {
    $f = Join-Path $fxBase ('p-' + [Guid]::NewGuid().ToString('N') + '.json')
    [IO.File]::WriteAllText($f, $Json)
    $out = Invoke-Node @($mod) $f
    return ($out -replace "`e\[[0-9;]*m", '').Trim()
}

$FULL = @'
{"model":{"display_name":"Opus 5 (1M context)","id":"claude-opus-5[1m]"},
 "effort":{"level":"xhigh"},
 "workspace":{"current_dir":"C:/Projects/ywrlabs/ywr-harness"},
 "context_window":{"used_percentage":24,"context_window_size":1000000},
 "rate_limits":{"five_hour":{"used_percentage":5},"seven_day":{"used_percentage":1}}}
'@

# --- A: the whole line, and the model label losing its context parenthetical --------------------
$a = Invoke-Line $FULL
$ok = (Assert-True 'A renders every segment' ($a -eq 'ywrlabs/ywr-harness · Opus 5 · xhigh · ctx 24%/1M · 5h 5% · 7d 1%') "got: $a") -and $ok
$ok = (Assert-True 'A the "(1M context)" suffix is gone' ($a -notmatch '\(1M context\)') $a) -and $ok
$ok = (Assert-True 'A the window size survives next to the percentage' ($a -match 'ctx 24%/1M') $a) -and $ok

# --- B: absent keys REMOVE their segment — never 0% --------------------------------------------
# The core honesty rule. Each of these is a payload state that genuinely occurs: rate_limits is
# missing on the first render of a session, before any API response.
$b = Invoke-Line '{"model":{"display_name":"Opus 5 (1M context)"},"effort":{"level":"xhigh"},"workspace":{"current_dir":"C:/a/b"}}'
$ok = (Assert-True 'B no context_window -> no ctx segment' ($b -notmatch 'ctx') $b) -and $ok
$ok = (Assert-True 'B no rate_limits -> no 5h/7d segments' (($b -notmatch '5h') -and ($b -notmatch '7d')) $b) -and $ok
$ok = (Assert-True 'B nothing is rendered as 0%' ($b -notmatch '0%') $b) -and $ok
$ok = (Assert-True 'B what IS known still renders' ($b -eq 'a/b · Opus 5 · xhigh') "got: $b") -and $ok

# --- C: a real 0 is NOT the same as absent, and must still print --------------------------------
# The control for B. If the absence rule were implemented as a falsiness check, a genuine 0% would
# disappear too — and the suite above would still be green.
$c = Invoke-Line '{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"C:/a/b"},"context_window":{"used_percentage":0,"context_window_size":200000},"rate_limits":{"five_hour":{"used_percentage":0},"seven_day":{"used_percentage":0}}}'
$ok = (Assert-True 'C a measured 0 renders as 0%' ($c -match 'ctx 0%/200k') $c) -and $ok
$ok = (Assert-True 'C measured 0 quota renders too' (($c -match '5h 0%') -and ($c -match '7d 0%')) $c) -and $ok

# --- D: size without a percentage must not leave a dangling "/1M" -------------------------------
$d = Invoke-Line '{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"C:/a/b"},"context_window":{"context_window_size":1000000}}'
$ok = (Assert-True 'D no percentage -> no dangling size' ($d -notmatch '/1M') $d) -and $ok

# --- E: only a CONTEXT parenthetical is stripped ------------------------------------------------
$e = Invoke-Line '{"model":{"display_name":"Fable 5 (preview)"},"workspace":{"current_dir":"C:/a/b"},"context_window":{"used_percentage":40,"context_window_size":200000}}'
$ok = (Assert-True 'E a non-context parenthetical is preserved' ($e -match 'Fable 5 \(preview\)') $e) -and $ok

# --- F: thresholds colour by band ----------------------------------------------------------------
# Asserted on the raw ANSI, because the colour IS the signal here — a wrong band is invisible in
# stripped text and this is the only place the two differ.
function Invoke-Raw([string]$Json) {
    $f = Join-Path $fxBase ('r-' + [Guid]::NewGuid().ToString('N') + '.json')
    [IO.File]::WriteAllText($f, $Json)
    return Invoke-Node @($mod) $f
}
$lowCtx = Invoke-Raw '{"model":{"display_name":"m"},"workspace":{"current_dir":"a"},"context_window":{"used_percentage":50}}'
$hiCtx = Invoke-Raw '{"model":{"display_name":"m"},"workspace":{"current_dir":"a"},"context_window":{"used_percentage":95}}'
$ok = (Assert-True 'F context 50% is still green (ordinary working state)' ($lowCtx -match "`e\[32m50%") 'expected green at 50%') -and $ok
$ok = (Assert-True 'F context 95% is red' ($hiCtx -match "`e\[31m95%") 'expected red at 95%') -and $ok
# Quota uses the tighter band — 50% there is already "watch". Proves the two curves are distinct
# rather than one shared threshold.
$q = Invoke-Raw '{"model":{"display_name":"m"},"workspace":{"current_dir":"a"},"rate_limits":{"five_hour":{"used_percentage":50}}}'
$ok = (Assert-True 'F quota 50% is yellow — a different curve from context' ($q -match "`e\[33m50%") 'expected yellow at 50% quota') -and $ok

# --- G: garbage in must not throw ----------------------------------------------------------------
# A status line that crashes takes the status line away on every render.
$g = Invoke-Line 'not json at all'
$ok = (Assert-True 'G unparseable stdin still renders something' ($g -match '\?') "got: $g") -and $ok
$gEmpty = Invoke-Line ''
$ok = (Assert-True 'G empty stdin does not crash' ($null -ne $gEmpty) 'no output') -and $ok

# --- H: the installed-plugin-version segment ------------------------------------------------------
# Read from Claude Code's install registry — the ON-DISK value. With marketplace auto-update on,
# disk moves ahead of a live session; that mismatch is the "restart to apply" signal, so the
# segment must show what this machine HAS, never what a repo or the marketplace published.
function Invoke-Ver([string]$HomeDir) {
    $js = @"
const m = require($(($mod -replace '\\','/') | ConvertTo-Json));
process.stdout.write(m.pluginVersion($($HomeDir | ConvertTo-Json)) || '<empty>');
"@
    $f = Join-Path $fxBase ('g-' + [Guid]::NewGuid().ToString('N') + '.js')
    [IO.File]::WriteAllText($f, $js)
    return ((& node $f 2>&1) | Out-String).Trim()
}
function New-Home([string]$Name, [string]$Json) {
    $h = Join-Path $fxBase $Name
    New-Item -ItemType Directory -Force -Path (Join-Path $h '.claude/plugins') | Out-Null
    if ($null -ne $Json) { [IO.File]::WriteAllText((Join-Path $h '.claude/plugins/installed_plugins.json'), $Json) }
    return $h
}

$h1 = New-Home 'installed' '{"version":2,"plugins":{"ywr-harness@ywrlabs":[{"scope":"user","version":"0.14.0"}]}}'
$ok = (Assert-True 'H the installed version is extracted, v-prefixed' ((Invoke-Ver $h1) -eq 'v0.14.0') "got: $(Invoke-Ver $h1)") -and $ok

$h2 = New-Home 'no-registry' $null
$ok = (Assert-True 'H no registry -> empty, segment disappears' ((Invoke-Ver $h2) -eq '<empty>') "got: $(Invoke-Ver $h2)") -and $ok

$h3 = New-Home 'garbage' '{ not json'
$ok = (Assert-True 'H an unparseable registry does not crash the line' ((Invoke-Ver $h3) -eq '<empty>') "got: $(Invoke-Ver $h3)") -and $ok

$h4 = New-Home 'not-installed' '{"version":2,"plugins":{"other-plugin@somewhere":[{"version":"1.0.0"}]}}'
$ok = (Assert-True 'H a machine without the plugin yields nothing' ((Invoke-Ver $h4) -eq '<empty>') "got: $(Invoke-Ver $h4)") -and $ok

# "unknown" is a real registry state (observed live on an official-marketplace plugin): it is not
# a version and must not render as one.
$h5 = New-Home 'unknown-version' '{"version":2,"plugins":{"ywr-harness@ywrlabs":[{"version":"unknown"}]}}'
$ok = (Assert-True 'H an "unknown" version renders no segment' ((Invoke-Ver $h5) -eq '<empty>') "got: $(Invoke-Ver $h5)") -and $ok

# Only the plugin name is pinned. A consuming org may register the marketplace under another
# name, and the segment must survive that.
$h6 = New-Home 'other-marketplace' '{"version":2,"plugins":{"ywr-harness@client-mkt":[{"version":"0.15.0"}]}}'
$ok = (Assert-True 'H the marketplace half of the key is not hardcoded' ((Invoke-Ver $h6) -eq 'v0.15.0') "got: $(Invoke-Ver $h6)") -and $ok

# Entries are not guaranteed array-wrapped. The [].concat defense must be pinned, or a future
# refactor to a plain array assumption passes green today and crashes live on a bare object.
$h7 = New-Home 'bare-object-entry' '{"version":2,"plugins":{"ywr-harness@ywrlabs":{"scope":"user","version":"0.9.9"}}}'
$ok = (Assert-True 'H a bare-object (non-array) entry still works' ((Invoke-Ver $h7) -eq 'v0.9.9') "got: $(Invoke-Ver $h7)") -and $ok

# Scope shadow: a stale project-scope entry listed FIRST must not shadow the user-scope install.
# The statusline is placed machine-wide, so user scope wins, then recency — never registry order.
$h8 = New-Home 'scope-shadow' '{"version":2,"plugins":{"ywr-harness@ywrlabs":[{"scope":"project","version":"0.10.0","lastUpdated":"2026-07-01T00:00:00.000Z"},{"scope":"user","version":"0.14.0","lastUpdated":"2026-07-29T00:00:00.000Z"}]}}'
$ok = (Assert-True 'H user scope wins over an earlier project-scope entry' ((Invoke-Ver $h8) -eq 'v0.14.0') "got: $(Invoke-Ver $h8)") -and $ok

# A "version" with no digit — "v", whitespace: corrupted-write shapes — must not render as one.
$h9 = New-Home 'digitless-version' '{"version":2,"plugins":{"ywr-harness@ywrlabs":[{"version":"v"}]}}'
$ok = (Assert-True 'H a digit-less version renders no segment' ((Invoke-Ver $h9) -eq '<empty>') "got: $(Invoke-Ver $h9)") -and $ok

# Placement, asserted by INJECTING the value rather than reading the machine's real cache. The
# first version of this case asserted the segment was absent and failed on any machine that has a
# guide delivered — a suite whose verdict depends on the developer's ~/.claude is not a suite.
function Invoke-Render([string]$Json, [string]$Guide) {
    $js = @"
const m = require($(($mod -replace '\\','/') | ConvertTo-Json));
const r = m.render($Json, $($Guide | ConvertTo-Json));
process.stdout.write(r.line.replace(/\x1b\[[0-9;]*m/g, ''));
"@
    $f = Join-Path $fxBase ('r2-' + [Guid]::NewGuid().ToString('N') + '.js')
    [IO.File]::WriteAllText($f, $js)
    return ((& node $f 2>&1) | Out-String).Trim()
}
$withVer = Invoke-Render $FULL 'v0.14.0'
$ok = (Assert-True 'H the segment renders last, after the quota segments' ($withVer -match '7d 1% · ywr-harness v0\.14\.0$') "got: $withVer") -and $ok
# The location segment of $FULL also contains the string "ywr-harness", so the absence assertion
# targets the label-plus-version form, not the bare name.
$noVer = Invoke-Render $FULL ''
$ok = (Assert-True 'H an empty version renders no segment at all' ($noVer -notmatch 'ywr-harness v') "got: $noVer") -and $ok

Remove-FixtureRoot $fxBase

if (-not $ok) { Write-Host 'statusline selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'statusline selftest: all cases green' -ForegroundColor Green
exit 0
