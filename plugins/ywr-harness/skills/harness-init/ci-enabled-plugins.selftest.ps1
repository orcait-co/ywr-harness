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

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'SKIP [ci-enabled-plugins] git absent (reported, not silent) — CI has git' -ForegroundColor Yellow
    exit 0
}
$py = @('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if (-not $py) {
    if ($env:CI) {
        Write-Host 'FAIL — python absent on CI; a missing interpreter is not a pass' -ForegroundColor Red
        exit 1
    }
    Write-Host 'SKIP [ci-enabled-plugins] python absent (reported, not silent) — CI runs this gate' -ForegroundColor Yellow
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
$ok = $true

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
