# Selftest for harness_retro.py — the slice retro gate (ADR 0017).
#
# The gate is advisory and always exits 0, so every case asserts on OUTPUT. Two properties are
# asserted for each of the seven checks: that it fires when it should, and that it stays SILENT
# when it should not. The silence half is the one that matters — an advisory gate that cries wolf
# is an advisory gate people stop reading, and there is no exit code to notice the regression.
#
# The subtlest case in the file is D2: a body-only ADR edit must NOT demand a rebuild, because the
# committed outputs are frontmatter-derived. That distinction was learned the expensive way in
# ywr-platform and is the single most likely thing to be broken by a well-meaning simplification.

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core, ADR 0125

$retro = Join-Path $PSScriptRoot 'harness_retro.py'
$fxBase = New-FixtureRoot 'harness-retro-selftest'
trap { Remove-FixtureRoot $fxBase; break }

$py = @('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if (-not $py) {
    if ($env:CI) { Write-Host 'FAIL — python absent on CI; a missing interpreter is not a pass' -ForegroundColor Red; Remove-FixtureRoot $fxBase; exit 1 }
    Write-Host 'SKIP [harness_retro] python absent (reported, not silent) — CI runs this gate' -ForegroundColor Yellow
    Remove-FixtureRoot $fxBase; exit 0
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'SKIP [harness_retro] git absent (reported, not silent)' -ForegroundColor Yellow
    Remove-FixtureRoot $fxBase; exit 0
}

$ok = $true

$CFG = @'
{
  "retro": {
    "source_scope": ["^src/.*\\.py$"],
    "dep_manifests": ["^pyproject\\.toml$"],
    "migrations": ["^migrations/versions/"],
    "ignore_file": ".githooks/slice-retro-ignore"
  }
}
'@

function Invoke-Retro([string]$Repo, [string[]]$Extra) {
    $a = @($retro, '--repo', $Repo) + $Extra
    $out = & $py.Source @a 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}
function Write-F([string]$Repo, [string]$Rel, [string]$Body) {
    $full = Join-Path $Repo $Rel
    $dir = Split-Path -Parent $full
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [IO.File]::WriteAllText($full, ($Body -replace "`r`n", "`n"))
}
function New-Repo([string]$Name, [string]$Config) {
    $p = Join-Path $fxBase $Name
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    & git -C $p init -q 2>$null
    & git -C $p config user.email 'selftest@example.invalid' 2>$null
    & git -C $p config user.name 'selftest' 2>$null
    if ($Config) { Write-F $p '.harness.json' $Config }
    Write-F $p 'docs/index.json' '{}'
    Write-F $p 'seed.txt' 'seed'
    & git -C $p add -A 2>$null; & git -C $p commit -q -m 'chore: seed' 2>$null
    return $p
}
function Commit([string]$Repo, [string]$Msg) {
    & git -C $Repo add -A 2>$null
    & git -C $Repo commit -q -m $Msg 2>$null
}
# A living spec with an inline implements_in list.
function Spec([string]$Id, [string[]]$Files) {
    $list = ($Files | ForEach-Object { "`"$_`"" }) -join ', '
    return "---`nid: `"$Id`"`ntype: spec`ntitle: `"s$Id`"`nstatus: active`nimplements_in: [$list]`n---`n# $Id. spec`n"
}

# --- A: DEP — manifest changed with no new ADR ---------------------------------------------------
$a = New-Repo 'dep' $CFG
Write-F $a 'pyproject.toml' "[project]`nname='x'`n"
Commit $a 'chore: add dep'
$rA = Invoke-Retro $a @()
$ok = (Assert-True 'A DEP fires on a manifest change with no ADR' ($rA.Out -match 'DEP:') $rA.Out) -and $ok
$ok = (Assert-True 'A the gate stays advisory (exit 0)' ($rA.Code -eq 0) "exit=$($rA.Code)") -and $ok

Write-F $a 'pyproject.toml' "[project]`nname='x'`nversion='2'`n"
Write-F $a 'docs/adr/0001-a.md' "---`nid: `"0001`"`ntype: adr`n---`n# 0001`n"
Commit $a 'chore: dep with adr'
$rA2 = Invoke-Retro $a @()
$ok = (Assert-True 'A2 DEP is SILENT when an ADR is added with it' ($rA2.Out -notmatch 'DEP:') $rA2.Out) -and $ok

# --- B: MIGRATION — migration added with no spec touched ----------------------------------------
$b = New-Repo 'migration' $CFG
Write-F $b 'migrations/versions/001_init.py' "# migration`n"
Commit $b 'feat: schema'
$rB = Invoke-Retro $b @()
$ok = (Assert-True 'B MIGRATION fires' ($rB.Out -match 'MIGRATION:') $rB.Out) -and $ok

$b2 = New-Repo 'migration-ok' $CFG
Write-F $b2 'migrations/versions/002_x.py' "# migration`n"
Write-F $b2 'docs/spec/0001-s.md' (Spec '0001' @())
Commit $b2 'feat: schema with spec'
$rB2 = Invoke-Retro $b2 @()
$ok = (Assert-True 'B2 MIGRATION is SILENT when a spec is touched' ($rB2.Out -notmatch 'MIGRATION:') $rB2.Out) -and $ok

# --- C: SPEC — a mapped file changed, its spec did not ------------------------------------------
$c = New-Repo 'spec' $CFG
Write-F $c 'src/app.py' "x = 1`n"
Write-F $c 'docs/spec/0001-s.md' (Spec '0001' @('src/app.py'))
Commit $c 'chore: map it'
Write-F $c 'src/app.py' "x = 2`n"
Commit $c 'fix: change mapped file only'
$rC = Invoke-Retro $c @()
$ok = (Assert-True 'C SPEC fires when a mapped file changes alone' ($rC.Out -match 'SPEC:.*0001-s\.md') $rC.Out) -and $ok

Write-F $c 'src/app.py' "x = 3`n"
Write-F $c 'docs/spec/0001-s.md' ((Spec '0001' @('src/app.py')) + "updated`n")
Commit $c 'fix: change both'
$rC2 = Invoke-Retro $c @()
$ok = (Assert-True 'C2 SPEC is SILENT when the spec moves with it' ($rC2.Out -notmatch 'SPEC:') $rC2.Out) -and $ok

# --- D: BUILD — keyed to FRONTMATTER, not to file content ---------------------------------------
# D1 fires (frontmatter changed, index untouched). D2 must NOT fire: an append-only body edit is
# the normal way to correct a committed ADR, and it provably yields no index delta because the
# builder drops _-prefixed keys and docs.html is gitignored. Getting D2 wrong makes the gate cry
# wolf on a recurring class whose only answer is "rebuild and confirm nothing changed".
$d = New-Repo 'build' $CFG
Write-F $d 'docs/adr/0001-a.md' "---`nid: `"0001`"`ntype: adr`nstatus: proposed`n---`n# 0001`nbody v1`n"
Commit $d 'docs: add adr'
Write-F $d 'docs/adr/0001-a.md' "---`nid: `"0001`"`ntype: adr`nstatus: accepted`n---`n# 0001`nbody v1`n"
Commit $d 'docs: accept it'
$rD = Invoke-Retro $d @()
$ok = (Assert-True 'D1 BUILD fires when frontmatter changed and the index did not' ($rD.Out -match 'BUILD:') $rD.Out) -and $ok
$ok = (Assert-True 'D1 names the index path from the declaration' ($rD.Out -match 'docs/index\.json') $rD.Out) -and $ok

Write-F $d 'docs/adr/0001-a.md' "---`nid: `"0001`"`ntype: adr`nstatus: accepted`n---`n# 0001`nbody v1`n`n## Addendum`nmore prose`n"
Commit $d 'docs: append an addendum (body only)'
$rD2 = Invoke-Retro $d @()
$ok = (Assert-True 'D2 BUILD is SILENT for a body-only edit — the subtle one' ($rD2.Out -notmatch 'BUILD:') $rD2.Out) -and $ok

# D3: a rename OUT of docs/ drops an index entry, so it must fire even though the final path is
# not a doc. This is why every path field is matched, not just the last.
$d3 = New-Repo 'build-rename' $CFG
Write-F $d3 'docs/adr/0001-a.md' "---`nid: `"0001`"`ntype: adr`n---`n# 0001`n"
Commit $d3 'docs: add'
& git -C $d3 mv 'docs/adr/0001-a.md' 'notes.md' 2>$null
Commit $d3 'chore: move it out'
$rD3 = Invoke-Retro $d3 @()
$ok = (Assert-True 'D3 BUILD fires on a rename OUT of docs/' ($rD3.Out -match 'BUILD:') $rD3.Out) -and $ok

# --- E: FEAT — a feat commit with no docs at all -------------------------------------------------
$e = New-Repo 'feat' $CFG
Write-F $e 'other.txt' "x`n"
Commit $e 'feat: something with no docs'
$rE = Invoke-Retro $e @()
$ok = (Assert-True 'E FEAT fires' ($rE.Out -match 'FEAT:') $rE.Out) -and $ok

$e2 = New-Repo 'feat-ok' $CFG
Write-F $e2 'other.txt' "x`n"
Write-F $e2 'docs/adr/0002-b.md' "---`nid: `"0002`"`ntype: adr`n---`n# 0002`n"
Write-F $e2 'docs/index.json' '{"adr":[]}'
Commit $e2 'feat: something with docs'
$rE2 = Invoke-Retro $e2 @()
$ok = (Assert-True 'E2 FEAT is SILENT when docs moved too' ($rE2.Out -notmatch 'FEAT:') $rE2.Out) -and $ok

# --- F: UNMAPPED — added in-scope file no spec owns ----------------------------------------------
$f = New-Repo 'unmapped' $CFG
Write-F $f 'src/new.py' "y = 1`n"
Commit $f 'chore: add unowned source'
$rF = Invoke-Retro $f @()
$ok = (Assert-True 'F UNMAPPED fires on a new unowned in-scope file' ($rF.Out -match 'UNMAPPED: new file src/new\.py') $rF.Out) -and $ok

# F2: the ignore register exempts it.
Write-F $f '.githooks/slice-retro-ignore' "# plumbing`nsrc/ignored\.py`n"
Write-F $f 'src/ignored.py' "z = 1`n"
Commit $f 'chore: add ignored source'
$rF2 = Invoke-Retro $f @()
$ok = (Assert-True 'F2 an ignored file does not fire UNMAPPED' ($rF2.Out -notmatch 'UNMAPPED: new file src/ignored\.py') $rF2.Out) -and $ok

# F3: MODIFYING an unowned file is not UNMAPPED — added-files-only is the adoption strategy, and
# without this case the check would spam every commit that touches legacy code.
Write-F $f 'src/new.py' "y = 2`n"
Commit $f 'fix: modify the unowned file'
$rF3 = Invoke-Retro $f @()
$ok = (Assert-True 'F3 modifying an unowned file does NOT fire UNMAPPED' ($rF3.Out -notmatch 'UNMAPPED') $rF3.Out) -and $ok

# F4: an owned file does not fire, and the BLOCK form of implements_in parses. A parser that only
# understood the inline form would drop half a real corpus while reporting full coverage.
$f4 = New-Repo 'unmapped-owned' $CFG
Write-F $f4 'docs/spec/0001-s.md' "---`nid: `"0001`"`ntype: spec`nimplements_in:`n  - src/owned.py`n---`n# spec`n"
Write-F $f4 'src/owned.py' "a = 1`n"
Commit $f4 'chore: add owned source'
$rF4 = Invoke-Retro $f4 @()
$ok = (Assert-True 'F4 a block-form implements_in owns the file (no UNMAPPED)' ($rF4.Out -notmatch 'UNMAPPED') $rF4.Out) -and $ok

# --- G: DEADMAP — implements_in points at a missing file -----------------------------------------
$g = New-Repo 'deadmap' $CFG
Write-F $g 'docs/spec/0001-s.md' (Spec '0001' @('src/gone.py'))
Commit $g 'docs: map a file that does not exist'
$rG = Invoke-Retro $g @()
$ok = (Assert-True 'G DEADMAP fires' ($rG.Out -match 'DEADMAP:.*src/gone\.py') $rG.Out) -and $ok

# --- H: a clean commit is completely silent -------------------------------------------------------
# The property that makes an advisory gate readable at all.
$h = New-Repo 'clean' $CFG
Write-F $h 'notes.txt' "just a note`n"
Commit $h 'chore: nothing interesting'
$rH = Invoke-Retro $h @()
$ok = (Assert-True 'H a clean commit prints nothing' ([string]::IsNullOrWhiteSpace($rH.Out)) "got: $($rH.Out)") -and $ok
$ok = (Assert-True 'H exits 0' ($rH.Code -eq 0) "exit=$($rH.Code)") -and $ok

# --- I: SLICE_RETRO=0 skips entirely --------------------------------------------------------------
$prev = $env:SLICE_RETRO
$env:SLICE_RETRO = '0'
try { $rI = Invoke-Retro $g @() }
finally { if ($null -eq $prev) { Remove-Item Env:SLICE_RETRO -ErrorAction SilentlyContinue } else { $env:SLICE_RETRO = $prev } }
$ok = (Assert-True 'I SLICE_RETRO=0 silences a repo that otherwise reports' ([string]::IsNullOrWhiteSpace($rI.Out)) "got: $($rI.Out)") -and $ok

# --- J: range mode absorbs a mid-slice split ------------------------------------------------------
# The docs commit follows the code commit. Per-commit the first one reports; over the range it
# must not — that is the entire reason range mode exists.
$j = New-Repo 'range' $CFG
Write-F $j 'src/app.py' "x = 1`n"
Write-F $j 'docs/spec/0001-s.md' (Spec '0001' @('src/app.py'))
Commit $j 'chore: base'
$base = (& git -C $j rev-parse HEAD 2>$null).Trim()
Write-F $j 'src/app.py' "x = 2`n"
Commit $j 'fix: code only'
$rJ1 = Invoke-Retro $j @()
Write-F $j 'docs/spec/0001-s.md' ((Spec '0001' @('src/app.py')) + "now updated`n")
Write-F $j 'docs/index.json' '{"spec":[]}'
Commit $j 'docs: catch the spec up'
$rJ2 = Invoke-Retro $j @("$base..HEAD")
$ok = (Assert-True 'J per-commit reports the split' ($rJ1.Out -match 'SPEC:') $rJ1.Out) -and $ok
$ok = (Assert-True 'J over the whole range it is silent' ($rJ2.Out -notmatch 'SPEC:') $rJ2.Out) -and $ok

# --- K: --coverage reports DISABLED checks rather than passing quietly --------------------------
# Silence must mean clean, never "not configured".
$k = New-Repo 'nocfg' '{ "retro": {} }'
$rK = Invoke-Retro $k @('--coverage')
$ok = (Assert-True 'K an undeclared scope is reported as DISABLED' ($rK.Out -match 'source_scope not declared.*DISABLED') $rK.Out) -and $ok
$ok = (Assert-True 'K all three undeclared checks are named' ((($rK.Out | Select-String 'DISABLED' -AllMatches).Matches).Count -ge 3) $rK.Out) -and $ok
$rK2 = Invoke-Retro $g @('--coverage')
$ok = (Assert-True 'K2 coverage lists dead mappings' ($rK2.Out -match 'dead mappings.*1') $rK2.Out) -and $ok
$ok = (Assert-True 'K2 coverage names the ignore register' ($rK2.Out -match 'ignore register') $rK2.Out) -and $ok

Remove-FixtureRoot $fxBase

if (-not $ok) { Write-Host 'harness_retro selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'harness_retro selftest: all cases green' -ForegroundColor Green
exit 0
