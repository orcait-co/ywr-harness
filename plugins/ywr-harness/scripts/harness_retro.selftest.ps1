# Selftest for harness_retro.py — the slice retro gate (ADR 0017).
#
# The gate is advisory and exits 0 (except a git failure, case N), so every case asserts on OUTPUT. Two properties are
# asserted for each of the seven checks: that it fires when it should, and that it stays SILENT
# when it should not. The silence half is the one that matters — an advisory gate that cries wolf
# is an advisory gate people stop reading, and there is no exit code to notice the regression.
#
# The subtlest case in the file is D2: a body-only ADR edit must NOT demand a rebuild, because the
# committed outputs are frontmatter-derived. That distinction was learned the expensive way in
# ywr-platform and is the single most likely thing to be broken by a well-meaning simplification.

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core

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
# ~450 git calls (fixture builds plus the retro's own): the worker binary, not the cmd\git.exe launcher
# (lib Use-GitWorkerBinary, ADR 0111). Left in place — under `pwsh -File` the process ends with it.
$null = Use-GitWorkerBinary

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

# A3: a rename can TRIGGER a check but never SATISFY one (ADR 0081 arm, B low). Renaming the
# existing ADR is not a new decision — `added` counted R, so the rename used to silence DEP.
Write-F $a 'pyproject.toml' "[project]`nname='x'`nversion='3'`n"
& git -C $a mv 'docs/adr/0001-a.md' 'docs/adr/0001-renamed.md' 2>$null
Commit $a 'chore: dep with a renamed adr'
$rA3 = Invoke-Retro $a @()
$ok = (Assert-True 'A3 DEP still fires when the only ADR in scope is a RENAME of an old one' ($rA3.Out -match 'DEP:') $rA3.Out) -and $ok

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

# B3: a spec moved WITHOUT an edit (R100) updated nothing, so it cannot satisfy MIGRATION; the
# migration itself still triggers as added.
Write-F $b2 'migrations/versions/003_y.py' "# migration`n"
& git -C $b2 mv 'docs/spec/0001-s.md' 'docs/spec/0001-moved.md' 2>$null
Commit $b2 'feat: schema with a moved spec'
$rB3 = Invoke-Retro $b2 @()
$ok = (Assert-True 'B3 MIGRATION still fires when the only spec in scope is a pure rename' ($rB3.Out -match 'MIGRATION:') $rB3.Out) -and $ok

# B4: a DELETED spec updated nothing either (review 2026-09-26: the D line's path sat in the
# suppressor set).
Write-F $b2 'migrations/versions/004_z.py' "# migration`n"
& git -C $b2 rm -q 'docs/spec/0001-moved.md' 2>$null
Commit $b2 'feat: schema with a deleted spec'
$rB4 = Invoke-Retro $b2 @()
$ok = (Assert-True 'B4 MIGRATION still fires when the only spec in scope was deleted' ($rB4.Out -match 'MIGRATION:') $rB4.Out) -and $ok

# B5: a rename INTO scope still TRIGGERS — the other half of the rule (UNMAPPED keeps R).
Write-F $b2 'tools/helper.py' "x = 1`n"
Commit $b2 'chore: helper outside scope'
New-Item -ItemType Directory -Force -Path (Join-Path $b2 'src') | Out-Null
& git -C $b2 mv 'tools/helper.py' 'src/helper.py' 2>$null
Commit $b2 'chore: move helper into src'
$rB5 = Invoke-Retro $b2 @()
$ok = (Assert-True 'B5 a file renamed INTO source_scope fires UNMAPPED (a rename triggers)' ($rB5.Out -match 'UNMAPPED: new file src/helper\.py') $rB5.Out) -and $ok

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

# F5: the MULTI-LINE flow form owns its files too (dist issue #6). Before 0.54.0 this parser read
# nothing from it — `\[(.*?)\]` needs the `]` on the key's own line — so both files fired UNMAPPED
# while the builder (after the same fix) indexed them as owned: the two parsers disagreed on one field.
$f5 = New-Repo 'unmapped-owned-flow' $CFG
Write-F $f5 'docs/spec/0001-s.md' "---`nid: `"0001`"`ntype: spec`nimplements_in: [`n  `"src/flow_a.py`",`n  src/flow_b.py,   # trailing comma`n]`ntags: [x]`n---`n# spec`n"
Write-F $f5 'src/flow_a.py' "a = 1`n"
Write-F $f5 'src/flow_b.py' "b = 1`n"
Commit $f5 'chore: add flow-owned sources'
$rF5 = Invoke-Retro $f5 @()
$ok = (Assert-True 'F5 a multi-line flow implements_in owns both files (no UNMAPPED)' ($rF5.Out -notmatch 'UNMAPPED') $rF5.Out) -and $ok
$ok = (Assert-True 'F5 and maps no junk path (no DEADMAP)' ($rF5.Out -notmatch 'DEADMAP') $rF5.Out) -and $ok

# F6: a block list with a comment HEAD, a comment line between items and an inline comment on an
# item — the builder's comment rule, applied item by item.
$f6 = New-Repo 'unmapped-owned-block-comments' $CFG
Write-F $f6 'docs/spec/0001-s.md' "---`nid: `"0001`"`ntype: spec`nimplements_in:   # owned files`n  - src/blk_a.py   # why`n`n  # between`n  - `"src/blk_b.py`"`n---`n# spec`n"
Write-F $f6 'src/blk_a.py' "a = 1`n"
Write-F $f6 'src/blk_b.py' "b = 1`n"
Commit $f6 'chore: add block-owned sources'
$rF6 = Invoke-Retro $f6 @()
$ok = (Assert-True 'F6 a commented block list owns both files, comments cut (no UNMAPPED, no DEADMAP)' ($rF6.Out -notmatch 'UNMAPPED' -and $rF6.Out -notmatch 'DEADMAP') $rF6.Out) -and $ok

# --- G: DEADMAP — implements_in points at a missing file -----------------------------------------
$g = New-Repo 'deadmap' $CFG
Write-F $g 'docs/spec/0001-s.md' (Spec '0001' @('src/gone.py'))
Commit $g 'docs: map a file that does not exist'
$rG = Invoke-Retro $g @()
$ok = (Assert-True 'G DEADMAP fires' ($rG.Out -match 'DEADMAP:.*src/gone\.py') $rG.Out) -and $ok

# G2: an item carrying ']' (the Next.js catch-all route) in a one-line list (dist issue #6). The
# lazy `\[(.*?)\]` stopped at the FIRST ']': it mapped `app/api/auth/[...nextauth` — a false
# DEADMAP on every commit — and dropped every later item, so src/c.py fired UNMAPPED as well.
# Created with IO calls: '[' and ']' are wildcards to PowerShell's -Path parameters.
$g2 = New-Repo 'deadmap-bracket-item' $CFG
$g2route = Join-Path $g2 'app/api/auth/[...nextauth]'
[IO.Directory]::CreateDirectory($g2route) | Out-Null
[IO.File]::WriteAllText((Join-Path $g2route 'route.ts'), "export {}`n")
Write-F $g2 'src/c.py' "c = 1`n"
Write-F $g2 'docs/spec/0001-s.md' (Spec '0001' @('app/api/auth/[...nextauth]/route.ts', 'src/c.py'))
Commit $g2 'chore: map a catch-all route'
$rG2 = Invoke-Retro $g2 @()
$ok = (Assert-True 'G2 an item containing ] is read whole — no false DEADMAP' ($rG2.Out -notmatch 'DEADMAP') $rG2.Out) -and $ok
$ok = (Assert-True 'G2 the item AFTER it is still owned (no UNMAPPED for src/c.py)' ($rG2.Out -notmatch 'UNMAPPED') $rG2.Out) -and $ok

# G3: the SHIPPED spec template, verbatim. Its `implements_in: [ ]` line carries an inline comment
# whose example is itself a bracketed list (`예: ["docs/build_docs.py"]`), and `[0-9]*.md` DOES scan
# 0000-template.md. A greedy `\[(.*)\]` — the obvious fix for G2 — reaches into that comment and
# maps junk to the template: a DEADMAP on every repo carrying the template. The inline-comment cut
# (whitespace + '#', the builder's rule) is what keeps both G2 and G3 green.
$g3 = New-Repo 'deadmap-template-comment' $CFG
$tmplSrc = Join-Path $PSScriptRoot '../skills/harness-init/templates/docs/spec/0000-template.md'
Write-F $g3 'docs/spec/0000-template.md' ([IO.File]::ReadAllText($tmplSrc))
Commit $g3 'docs: place the spec template'
$rG3 = Invoke-Retro $g3 @()
$ok = (Assert-True 'G3 the shipped template maps nothing out of its own comment (no DEADMAP)' ($rG3.Out -notmatch 'DEADMAP') $rG3.Out) -and $ok
$rG3c = Invoke-Retro $g3 @('--coverage')
$ok = (Assert-True 'G3 --coverage agrees: no dead mappings' ($rG3c.Out -match 'dead mappings: none') $rG3c.Out) -and $ok

# G4: PAIRING — this parser against the docs builder's, shape by shape. They are two parsers of one
# field by necessity (the retro reads committed sources, not an index that may not be rebuilt), and
# until 0.54.0 they disagreed on three shapes (dist issue #6). The builder is the TEMPLATE copy the
# plugin ships (byte-identical to the canon's docs/build_docs.py — manifest-gate's dogfood sweep).
# Each shape carries the EXPECTED builder value, compared TYPED (type name + value, so an int 7 is
# not a string '7'): the retro must equal it as a list, or [] where the builder indexes a non-list,
# and the builder must equal it exactly — so a rule dropped from BOTH parsers (the column-0 key
# guard, the bracket balance, the comment-only cut) still fails, which a bare pairing cannot see.
# "flow unclosed before a key" is the guard's pin: without the guard both parsers swallow `next: 3`
# into the list and close it at the stray `]`. The "ends in ]" shapes are the balance rule's pin: the
# old rule (first line ending in `]` closes) truncated `app/[slug]` to `app/[slug` in both parsers.
$g4Script = Join-Path $fxBase 'pairing.py'
Set-Content -LiteralPath $g4Script -NoNewline -Value @'
import importlib.util, sys
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
import harness_retro as retro
spec = importlib.util.spec_from_file_location("build_docs", sys.argv[2])
bd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bd)
AB = ["src/a.py", "src/b.py"]
shapes = {
    "one-line": ('implements_in: ["src/a.py", "src/b.py"]', AB),
    "one-line bracket item": ('implements_in: [app/api/auth/[...nextauth]/route.ts, src/c.py]',
                              ["app/api/auth/[...nextauth]/route.ts", "src/c.py"]),
    "one-line empty": ('implements_in: []', []),
    "template comment": ('implements_in: [ ]         # x (예: ["docs/build_docs.py"]), y', []),
    "block": ('implements_in:\n  - src/a.py\n  - "src/b.py"', AB),
    "block compact": ('implements_in:\n- src/a.py\n- src/b.py', AB),
    "block commented": ('implements_in:   # files\n  - src/a.py   # why\n\n  # between\n  - "src/b.py"  # quoted\n  -\n  - # empty\nnext: 1', AB),
    "flow multi-line": ('implements_in: [\n  "src/a.py",\n  src/b.py,   # c\n]\nnext: 2', AB),
    "flow first item inline": ('implements_in: ["src/a.py",\n  "src/b.py"]', AB),
    "flow last item ends in ]": ('implements_in: [\n  src/a.py,\n  app/[slug]\n]\nnext: 5', ["src/a.py", "app/[slug]"]),
    "flow head line ends in ]": ('implements_in: [src/a.py, app/[slug]\n]\nnext: 6', ["src/a.py", "app/[slug]"]),
    "flow bracketed dir mid-path": ('implements_in: [\n  app/[slug]/page.tsx\n]', ["app/[slug]/page.tsx"]),
    "flow quoted item carrying ]": ('implements_in: [\n  "src/x]y.py",\n  src/a.py\n]', ["src/x]y.py", "src/a.py"]),
    "flow unterminated": ('implements_in: [\n  "src/a.py",\nnext: 3', "["),
    "flow unclosed before a key": ('implements_in: [\n  "src/a.py",\nnext: 3\n]', "["),
    "flow closed with trailing text": ('implements_in: [\n  src/a.py,\n] x\nnext: 7', "["),
    "comment-only value": ('implements_in:   # TBD\nnext: 8', None),
    "empty then key": ('implements_in:\nnext: 4', None),
    "numeric items": ('implements_in: [7, "0001", 0002, src/a.py]', [7, "0001", 2, "src/a.py"]),
    "block numeric items": ('implements_in:\n  - 7\n  - "8"', [7, "8"]),
    "quoted empty item": ('implements_in: ["", src/a.py]', ["", "src/a.py"]),
    "duplicate key, last wins": ('implements_in: [src/a.py]\nimplements_in:\n  - src/z.py', ["src/z.py"]),
    "absent": ('title: x', None),
}
def typed(v):
    return [(type(x).__name__, x) for x in v] if isinstance(v, list) else (type(v).__name__, v)
fails = []
for name, (block, want) in shapes.items():
    meta, _ = bd.parse_frontmatter("---\n" + block + "\n---\n")
    got = meta.get("implements_in")
    if typed(got) != typed(want):
        fails.append(f"{name}: builder {got!r} != expected {want!r}")
    mine = retro.implements_in(block.split("\n"))
    if typed(mine) != typed(want if isinstance(want, list) else []):
        fails.append(f"{name}: retro {mine!r} != builder-as-list {want!r}")
print("G4-OK" if not fails else "G4-FAIL: " + " | ".join(fails))
'@
$builderTmpl = Join-Path $PSScriptRoot '../skills/harness-init/templates/docs/build_docs.py'
$rG4 = (& $py.Source $g4Script $PSScriptRoot $builderTmpl 2>&1 | Out-String)
$ok = (Assert-True 'G4 the retro parser and the docs builder agree, typed, with the expected value of every implements_in shape' ($rG4 -match 'G4-OK') $rG4) -and $ok

# G5: the multi-line form of G2's class, end to end — a last item ending in `]` (a Next.js dynamic
# route DIRECTORY) with the closing `]` on its own line. The old close rule (first line ending in
# `]`) cut it to `app/[slug` in both parsers alike, so the pairing passed while the retro fired a
# false DEADMAP on every commit; the bracket balance reads the item whole.
$g5 = New-Repo 'deadmap-bracket-dir-multiline' $CFG
$g5dir = Join-Path $g5 'app/[slug]'
[IO.Directory]::CreateDirectory($g5dir) | Out-Null
[IO.File]::WriteAllText((Join-Path $g5dir 'page.tsx'), "export {}`n")
Write-F $g5 'src/a.py' "a = 1`n"
Write-F $g5 'docs/spec/0001-s.md' "---`nid: `"0001`"`ntype: spec`nimplements_in: [`n  src/a.py,`n  app/[slug]`n]`ntags: [x]`n---`n# spec`n"
Commit $g5 'chore: map a dynamic-route directory in a multi-line list'
$rG5 = Invoke-Retro $g5 @()
$ok = (Assert-True 'G5 a multi-line list whose last item ends in ] maps it whole (no DEADMAP, no UNMAPPED)' ($rG5.Out -notmatch 'DEADMAP' -and $rG5.Out -notmatch 'UNMAPPED') $rG5.Out) -and $ok
$rG5c = Invoke-Retro $g5 @('--coverage')
$ok = (Assert-True 'G5 --coverage agrees: no dead mappings' ($rG5c.Out -match 'dead mappings: none') $rG5c.Out) -and $ok

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

# --- L: a merge commit is a range in disguise (ADR 0043) -----------------------------------------
# diff-tree without -m prints NOTHING for a merge commit, so before the fix the retro ran all
# seven checks over an empty change set — a conflicted `git pull` concluded with `git commit`
# fired post-commit and passed silently having checked nothing. L1 is the mutation anchor: it
# fails when the HEAD^2 probe is removed. L2 pins the silence half — first-parent scope must not
# over-report a merge that landed nothing interesting.
$l = New-Repo 'merge' $CFG
Write-F $l 'src/app.py' "x = 1`n"
Write-F $l 'docs/spec/0001-s.md' (Spec '0001' @('src/app.py'))
Commit $l 'chore: base'
$mainBranch = (& git -C $l symbolic-ref --short HEAD 2>$null).Trim()
& git -C $l checkout -q -b side 2>$null
Write-F $l 'src/app.py' "x = 2`n"
Commit $l 'fix: change the mapped file on a branch, spec untouched'
& git -C $l checkout -q $mainBranch 2>$null
& git -C $l merge -q --no-ff --no-edit side 2>$null
$rL = Invoke-Retro $l @()
$ok = (Assert-True 'L1 a merge commit fires the checks over its first-parent diff' ($rL.Out -match 'SPEC:.*0001-s\.md') $rL.Out) -and $ok
$ok = (Assert-True 'L1 stays advisory on a merge (exit 0)' ($rL.Code -eq 0) "exit=$($rL.Code)") -and $ok

& git -C $l checkout -q -b side2 2>$null
Write-F $l 'notes.txt' "nothing interesting`n"
Commit $l 'chore: an innocuous branch change'
& git -C $l checkout -q $mainBranch 2>$null
& git -C $l merge -q --no-ff --no-edit side2 2>$null
$rL2 = Invoke-Retro $l @()
$ok = (Assert-True 'L2 a clean merge is completely silent' ([string]::IsNullOrWhiteSpace($rL2.Out)) "got: $($rL2.Out)") -and $ok

# --- L3: an octopus merge is covered by the same range -------------------------------------------
# The review's octopus concern (2026-08-10, low) claimed non-first legs escape the diff. They do
# not — HEAD^1..HEAD is a tree diff plus a reachability log, both of which include every leg —
# and this case MEASURES that: the SPEC-firing change lives on the SECOND merged branch.
$l3 = New-Repo 'merge-octopus' $CFG
Write-F $l3 'src/app.py' "x = 1`n"
Write-F $l3 'docs/spec/0001-s.md' (Spec '0001' @('src/app.py'))
Commit $l3 'chore: base'
$mainBranch3 = (& git -C $l3 symbolic-ref --short HEAD 2>$null).Trim()
& git -C $l3 checkout -q -b legA 2>$null
Write-F $l3 'notes-a.txt' "leg a`n"
Commit $l3 'chore: innocuous leg A'
& git -C $l3 checkout -q $mainBranch3 2>$null
& git -C $l3 checkout -q -b legB 2>$null
Write-F $l3 'src/app.py' "x = 2`n"
Commit $l3 'fix: mapped-file change on leg B, spec untouched'
& git -C $l3 checkout -q $mainBranch3 2>$null
& git -C $l3 merge -q --no-edit legA legB 2>$null
$rL3 = Invoke-Retro $l3 @()
$ok = (Assert-True 'L3 an octopus merge fires on a non-first leg''s change' ($rL3.Out -match 'SPEC:.*0001-s\.md') $rL3.Out) -and $ok

# --- K: --coverage reports DISABLED checks rather than passing quietly --------------------------
# Silence must mean clean, never "not configured".
$k = New-Repo 'nocfg' '{ "retro": {} }'
$rK = Invoke-Retro $k @('--coverage')
$ok = (Assert-True 'K an undeclared scope is reported as DISABLED' ($rK.Out -match 'source_scope not declared.*DISABLED') $rK.Out) -and $ok
$ok = (Assert-True 'K all three undeclared checks are named' ((($rK.Out | Select-String 'DISABLED' -AllMatches).Matches).Count -ge 3) $rK.Out) -and $ok
$rK2 = Invoke-Retro $g @('--coverage')
$ok = (Assert-True 'K2 coverage lists dead mappings' ($rK2.Out -match 'dead mappings.*1') $rK2.Out) -and $ok
$ok = (Assert-True 'K2 coverage names the ignore register' ($rK2.Out -match 'ignore register') $rK2.Out) -and $ok

# K3: the report survives a console that cannot encode it (dist issue #6 claimed a cp949 crash;
# not reproduced — `hc.pin_utf8()` has run at import since v0.9.0). This is the regression guard for
# that pin: ascii:strict is the harshest stdout a member's console can hand Python, and the
# DISABLED lines carry '—'. Removing the pin raises UnicodeEncodeError here and exits 1.
$prevIoK = $env:PYTHONIOENCODING
$env:PYTHONIOENCODING = 'ascii:strict'
try { $rK3 = Invoke-Retro $k @('--coverage') }
finally {
    if ($null -eq $prevIoK) { Remove-Item Env:PYTHONIOENCODING -ErrorAction SilentlyContinue } else { $env:PYTHONIOENCODING = $prevIoK }
}
$ok = (Assert-True 'K3 --coverage on an ascii:strict console exits 0 with no UnicodeEncodeError' ($rK3.Code -eq 0 -and $rK3.Out -notmatch 'UnicodeEncodeError') "exit=$($rK3.Code): $($rK3.Out)") -and $ok
$ok = (Assert-True 'K3 and the em dash arrives intact (UTF-8, not a replacement)' ($rK3.Out -match 'not declared — the checks it drives are DISABLED') $rK3.Out) -and $ok

# --- N: a git failure is LOUD, never a false clean retro (O41(c), ADR 0041's principle) ---------
# git() swallowed every failure as empty output, so an unresolvable range read as "nothing
# changed" — silent, exit 0, indistinguishable from case H. Now: a stdout FAILED marker, exit 1
# (the post-commit hook's `|| true` keeps the commit untouched). N2 is the silence half: the
# semantic exits (rev-parse -q --verify on a root commit's HEAD^) still read as absent.
$n = New-Repo 'git-failure' $CFG
$rN = Invoke-Retro $n @('no-such-rev..HEAD')
$ok = (Assert-True 'N1 an unresolvable range prints a FAILED marker on stdout' ($rN.Out -match '\[slice-retro\] FAILED — git diff' -and $rN.Out -match 'NO retro check ran') $rN.Out) -and $ok
$ok = (Assert-True 'N1 and exits non-zero, no traceback' ($rN.Code -eq 1 -and $rN.Out -notmatch 'Traceback') "exit=$($rN.Code): $($rN.Out)") -and $ok
$rN2 = Invoke-Retro $n @()
$ok = (Assert-True 'N2 a root commit (HEAD^ absent, exit 1) is still a clean silent run' ($rN2.Code -eq 0 -and [string]::IsNullOrWhiteSpace($rN2.Out)) "exit=$($rN2.Code): $($rN2.Out)") -and $ok

# --- O: a path carrying U+2028 stays ONE path (O41(c), ADR 0077) ---------------------------------
# `.splitlines()` over `diff-tree --name-status` broke `src/a<U+2028>b.py` into `src/a` (no .py —
# out of scope) + `b.py` (no tab — dropped), so UNMAPPED stayed SILENT on a new unowned file.
# The separator is built from its code point at runtime, never a literal in this file.
$lsO = [string][char]0x2028
$o = New-Repo 'line-sep-path' $CFG
Write-F $o "src/a${lsO}b.py" "x = 1`n"
Commit $o 'chore: add a file whose name carries U+2028'
$rO = Invoke-Retro $o @()
$ok = (Assert-True 'O1 per-commit: UNMAPPED names the U+2028 path as ONE file' ($rO.Out -match ('UNMAPPED: new file ' + [regex]::Escape("src/a${lsO}b.py") + ' is owned')) $rO.Out) -and $ok
$rO2 = Invoke-Retro $o @('--coverage')
$ok = (Assert-True 'O2 --coverage: the U+2028 path is ONE unowned file (ls-files -z)' ($rO2.Out -match 'unowned files \(in scope, no spec, not ignored\): 1 of 1' -and $rO2.Out.Contains("src/a${lsO}b.py")) $rO2.Out) -and $ok

# --- P: frontmatter_at — absence is asked structurally, every other git fatal is LOUD ------------
# `git show pre:path` exited 128 both for "absent at pre" and for any fatal, so a missing blob
# read as "absent" (a silent difference). P1 deletes the loose object of the pre-side ADR blob:
# ls-tree still lists the path, `git show` must fail → FAILED marker, exit 1. P2 is the silence
# half: an ADR ADDED in the commit (absent at pre) still reads as a difference, not a failure.
$p1 = New-Repo 'fm-missing-blob' $CFG
Write-F $p1 'docs/adr/0001-a.md' "---`nid: `"0001`"`ntype: adr`nstatus: proposed`n---`n# 0001`n"
Commit $p1 'docs: add adr'
$p1Blob = (& git -C $p1 rev-parse 'HEAD:docs/adr/0001-a.md').Trim()
Write-F $p1 'docs/adr/0001-a.md' "---`nid: `"0001`"`ntype: adr`nstatus: accepted`n---`n# 0001`n"
Commit $p1 'docs: accept it'
$p1Obj = Join-Path $p1 ".git/objects/$($p1Blob.Substring(0,2))/$($p1Blob.Substring(2))"
$p1Had = Test-Path -LiteralPath $p1Obj
if ($p1Had) { Set-ItemProperty -LiteralPath $p1Obj -Name IsReadOnly -Value $false; Remove-Item -LiteralPath $p1Obj -Force }
$rP1 = Invoke-Retro $p1 @()
$ok = (Assert-True 'P1 fixture: the pre-side blob was a loose object and is now gone' $p1Had $p1Obj) -and $ok
$ok = (Assert-True 'P1 a missing pre-side blob is a FAILED marker, not "absent at pre"' ($rP1.Out -match '\[slice-retro\] FAILED — git show' -and $rP1.Out -match 'NO retro check ran') $rP1.Out) -and $ok
$ok = (Assert-True 'P1 and exits 1, no traceback' ($rP1.Code -eq 1 -and $rP1.Out -notmatch 'Traceback') "exit=$($rP1.Code): $($rP1.Out)") -and $ok

$p2 = New-Repo 'fm-added' $CFG
Write-F $p2 'docs/adr/0001-a.md' "---`nid: `"0001`"`ntype: adr`n---`n# 0001`n"
Commit $p2 'docs: add adr, no index'
$rP2 = Invoke-Retro $p2 @()
$ok = (Assert-True 'P2 an ADR absent at pre (added) is a difference: BUILD fires, exit 0' ($rP2.Code -eq 0 -and $rP2.Out -match 'BUILD:' -and $rP2.Out -notmatch 'FAILED') "exit=$($rP2.Code): $($rP2.Out)") -and $ok

# --- Q: git absent from PATH is the FAILED marker, never a traceback -----------------------------
# PATH is one empty directory: python is invoked by absolute path, and python's own directory is no
# narrowing — stock Ubuntu puts git beside it in /usr/bin (fact 42). The absence is still asserted.
$qBin = Join-Path $fxBase 'q-empty-path'
$null = New-Item -ItemType Directory -Path $qBin -Force
$qSavedPath = $env:PATH
try {
    $env:PATH = $qBin
    $qGitGone = -not (Get-Command git -ErrorAction SilentlyContinue)
    $rQ = Invoke-Retro $p2 @()
} finally { $env:PATH = $qSavedPath }
$ok = (Assert-True 'Q fixture: git is not resolvable on the narrowed PATH' $qGitGone "PATH=$qBin") -and $ok
$ok = (Assert-True 'Q a missing git binary prints the FAILED marker and exits 1, no traceback' ($rQ.Code -eq 1 -and $rQ.Out -match '\[slice-retro\] FAILED — git could not be run' -and $rQ.Out -notmatch 'Traceback') "exit=$($rQ.Code): $($rQ.Out)") -and $ok

# --- R: a directory implements_in entry owns every file below it (ADR 0104, dist issue #7) -------
# Exact-string ownership read every file added under a directory entry as UNMAPPED, and a change
# there never fired SPEC. The prefix is `entry + "/"`: `src/notice` must not own `src/notice_old.py`.
$r = New-Repo 'dir-entry' $CFG
Write-F $r 'docs/spec/0001-s.md' (Spec '0001' @('src/notice', 'src/board/'))
Commit $r 'docs: spec maps directories'
Write-F $r 'src/notice/service.py' "x = 1`n"
Write-F $r 'src/notice/sub/deep.py' "x = 1`n"
Write-F $r 'src/board/x.py' "x = 1`n"
Write-F $r 'src/notice_old.py' "x = 1`n"
Commit $r 'chore: add files under the mapped directories'
$rR = Invoke-Retro $r @()
$ok = (Assert-True 'R1 files added under a directory entry are owned, nested and trailing-slash too (no UNMAPPED)' ($rR.Out -notmatch 'UNMAPPED: new file src/(notice/|board/)') $rR.Out) -and $ok
$ok = (Assert-True 'R1 a sibling sharing the name prefix is still UNMAPPED' ($rR.Out -match 'UNMAPPED: new file src/notice_old\.py') $rR.Out) -and $ok
$ok = (Assert-True 'R1 a change under a directory entry fires SPEC for its spec' ($rR.Out -match 'SPEC:.*0001-s\.md') $rR.Out) -and $ok
$ok = (Assert-True 'R1 an existing directory entry is not a DEADMAP' ($rR.Out -notmatch 'DEADMAP') $rR.Out) -and $ok
$rRc = Invoke-Retro $r @('--coverage')
$ok = (Assert-True 'R2 --coverage agrees: only the sibling is unowned' ($rRc.Out -match 'unowned files \(in scope, no spec, not ignored\): 1 of 4' -and $rRc.Out -match 'src/notice_old\.py') $rRc.Out) -and $ok
# R3: a DELETION under a directory entry still belongs to its spec — why owns() does no disk lookup.
Remove-Item -LiteralPath (Join-Path $r 'src/notice/sub/deep.py')
Commit $r 'chore: delete a file under the mapped directory'
$rR3 = Invoke-Retro $r @()
$ok = (Assert-True 'R3 a deletion under a directory entry fires SPEC for its spec' ($rR3.Out -match 'SPEC:.*0001-s\.md') $rR3.Out) -and $ok

# --- S: a docs source that opens with an HTML comment is read like the builder reads it (canon #59) -
# spec_map and frontmatter_at kept their own looser parse until 0.60.1 and required line 1 to be `---`;
# the index (build_docs.split_frontmatter, via hc.fm_block) skips a leading HTML comment. So a spec
# written `<!-- note -->` + frontmatter was INDEXED as owning its files while the retro read it as
# owning nothing (a false UNMAPPED), and a frontmatter edit under such a header read as
# `<no-frontmatter>` on both sides (a silently missed BUILD).
$s1 = New-Repo 'comment-led-spec' $CFG
Write-F $s1 'docs/spec/0001-s.md' "<!-- note -->`n---`nid: `"0001`"`ntype: spec`nimplements_in: [`"src/a.py`"]`n---`n# spec`n"
Write-F $s1 'src/a.py' "a = 1`n"
Write-F $s1 'src/b.py' "b = 1`n"
Commit $s1 'chore: add owned and unowned sources'
$rS1 = Invoke-Retro $s1 @()
$ok = (Assert-True 'S1 a spec led by an HTML comment owns its file (no UNMAPPED for src/a.py)' ($rS1.Out -notmatch 'UNMAPPED: new file src/a\.py' -and $rS1.Out -notmatch 'DEADMAP') $rS1.Out) -and $ok
$ok = (Assert-True 'S1 control: the unowned sibling in the same commit still fires UNMAPPED' ($rS1.Out -match 'UNMAPPED: new file src/b\.py') $rS1.Out) -and $ok

$s2 = New-Repo 'comment-led-frontmatter' $CFG
Write-F $s2 'docs/adr/0001-a.md' "<!-- note -->`n---`nid: `"0001`"`ntype: adr`nstatus: proposed`n---`n# 0001`nbody v1`n"
Write-F $s2 'docs/index.json' '{"adr":[]}'
Commit $s2 'docs: add adr under a comment header'
Write-F $s2 'docs/adr/0001-a.md' "<!-- note -->`n---`nid: `"0001`"`ntype: adr`nstatus: accepted`n---`n# 0001`nbody v1`n"
Commit $s2 'docs: accept it'
$rS2 = Invoke-Retro $s2 @()
$ok = (Assert-True 'S2 BUILD fires for a frontmatter change under a leading HTML comment' ($rS2.Out -match 'BUILD:') $rS2.Out) -and $ok
Write-F $s2 'docs/adr/0001-a.md' "<!-- note -->`n---`nid: `"0001`"`ntype: adr`nstatus: accepted`n---`n# 0001`nbody v1`n`n## Addendum`nmore prose`n"
Commit $s2 'docs: append an addendum (body only)'
$rS3 = Invoke-Retro $s2 @()
$ok = (Assert-True 'S3 BUILD is SILENT for a body-only edit under a leading HTML comment' ($rS3.Out -notmatch 'BUILD:') $rS3.Out) -and $ok

# --- DL: --delegations reads the delegation ledger's slot files (ADR 0120) -----------------------
# No git needed: the report reads files only. DL2 is the D6 counter's control and its exclusions in
# one session split over two slots (ADR 0118's LRU residual), one of them with step_fields REORDERED
# and no complete.usage, so a positional step read sums the wrong column.
$dl = Join-Path $fxBase 'delegations'
New-Item -ItemType Directory -Force -Path $dl | Out-Null
Write-F $dl '.harness.json' '{}'
$rDL1 = Invoke-Retro $dl @('--delegations')
$ok = (Assert-True 'DL1 no ledger directory: one line naming where the module writes, exit 0' ($rDL1.Code -eq 0 -and $rDL1.Out -match 'no ledger at \.claude/telemetry/delegations') "exit=$($rDL1.Code): $($rDL1.Out)") -and $ok

$fieldsStd = '["index","model","effort","message_count","stop_reason","input_tokens","output_tokens","cache_read_input_tokens","cache_creation_input_tokens","usage_model"]'
$fieldsRev = '["usage_model","cache_creation_input_tokens","cache_read_input_tokens","output_tokens","input_tokens","stop_reason","message_count","effort","model","index"]'
function DlLoop([string]$Kind, [string]$Models, [string]$Efforts, [int]$Evicted, [string]$Usage, [string]$Steps, [string]$Spawn = 'null', [int]$StepsDropped = 0) {
    $c = if ($Usage) { "{`"reason`":`"answer`",`"aborted`":false,`"duration_ms`":1500,`"usage`":$Usage}" } else { '{"reason":"answer","aborted":false,"duration_ms":1500,"usage":null}' }
    return "{`"ts`":`"t`",`"loop`":`"$Kind`",`"agent_id`":null,`"turn_id`":`"u`",`"spawn`":$Spawn,`"spawn_rows_evicted`":$Evicted,`"steps`":$Steps,`"steps_dropped`":$StepsDropped,`"models`":$Models,`"efforts`":$Efforts,`"complete`":$c}"
}
$u = '{"model":"m","input_tokens":5,"output_tokens":7,"cache_read_input_tokens":100,"cache_creation_input_tokens":3}'
$mech = '{"subagent_type":"ywr-harness:mech","model_param":null,"model":"claude-haiku-4-5"}'
$loopsA = @(
    (DlLoop 'main' '["claude-opus-5-5"]' '["xhigh"]' 0 $u '[]'),
    (DlLoop 'unspawned' '["claude-opus-5-5"]' '["xhigh"]' 0 $u '[]'),      # inherit signature
    (DlLoop 'unspawned' '["claude-opus-5-5"]' '["low"]' 0 $u '[]'),        # opus · low pin: on main, other effort
    (DlLoop 'unspawned' '["claude-haiku-4-5"]' '[]' 0 $u '[]'),            # pinned elsewhere: not counted
    (DlLoop 'agent-tool' '["claude-haiku-4-5"]' '[]' 0 $u '[]' $mech)
) -join ','
Write-F $dl '.claude/telemetry/delegations/slot-00.json' "{`"schema`":2,`"session_id`":`"sess-A`",`"slot`":0,`"updated`":`"2026-10-02T01:00:00Z`",`"step_fields`":$fieldsStd,`"loops_dropped`":2,`"loops`":[$loopsA]}"
# Second file of the same session: an evicted-spawn unspawned on the main model (not attributed) and a
# loop whose tokens come from its steps, read by NAME under a reversed step_fields.
$stepsRev = '[[null,40,30,20,10,"end_turn",3,"xhigh","claude-opus-5-5",0],[null,1,1,1,1,"end_turn",4,"xhigh","claude-opus-5-5",1]]'
$loopsB = @(
    (DlLoop 'unspawned' '["claude-opus-5-5"]' '["xhigh"]' 3 $u '[]'),
    (DlLoop 'main' '["claude-opus-5-5"]' '["xhigh"]' 0 '' $stepsRev 'null' 5)
) -join ','
Write-F $dl '.claude/telemetry/delegations/slot-07.json' "{`"schema`":2,`"session_id`":`"sess-A`",`"slot`":7,`"updated`":`"2026-10-02T02:00:00Z`",`"step_fields`":$fieldsRev,`"loops_dropped`":0,`"loops`":[$loopsB]}"
# Skips, each named: a partial write, a schema-1 file; ignored without a word: a non-slot name.
Write-F $dl '.claude/telemetry/delegations/slot-03.json' '{"schema":2,"session_id":"sess-B","loo'
Write-F $dl '.claude/telemetry/delegations/slot-04.json' '{"schema":1,"session_id":"sess-C"}'
Write-F $dl '.claude/telemetry/delegations/notes.json' 'not a slot'
$rDL2 = Invoke-Retro $dl @('--delegations')
$o = $rDL2.Out
$ok = (Assert-True 'DL2 exit 0; two readable files, ONE session (merged by session_id), seven loops' ($rDL2.Code -eq 0 -and $o -match '2 slot file\(s\), 1 session\(s\), 7 loop\(s\)' -and $o -match 'session sess-A · slot-00\.json, slot-07\.json') "exit=$($rDL2.Code): $o") -and $ok
$ok = (Assert-True 'DL2 D6 counts the two unspawned loops on the main model, one at its effort' ($o -match 'ADR 0117 D6: 2 unspawned loop\(s\) on their session''s main model in 1 session\(s\); 1 also at the main loop''s effort') $o) -and $ok
$ok = (Assert-True 'DL2 the evicted-spawn loop is reported apart, never counted' ($o -match 'not attributed: 1 with spawn rows evicted') $o) -and $ok
$ok = (Assert-True 'DL2 steps are read by step_fields NAME (reversed fields: in 11 · out 21 · read 31 · write 41)' ($o -match 'main · claude-opus-5-5 · xhigh — 2 loop\(s\), 3\.0 s, tokens in 16 · out 28 · cache read 131 · cache write 44 \(1 loop\(s\) without complete\.usage') $o) -and $ok
$ok = (Assert-True 'DL2 an agent-tool row names its type and model_param' ($o -match 'agent-tool ywr-harness:mech \(model_param none\) · claude-haiku-4-5') $o) -and $ok
$ok = (Assert-True 'DL2 caps are surfaced (2 loops, 5 steps dropped)' ($o -match 'caps: 2 loop\(s\) dropped by the file caps, 5 step row\(s\)') $o) -and $ok
$ok = (Assert-True 'DL2 the partial and the schema-1 file are each named as skipped; notes.json is not read' ($o -match 'skipped: slot-03\.json \(not JSON' -and $o -match 'skipped: slot-04\.json \(not a schema 2 slot\)' -and $o -notmatch 'notes\.json') $o) -and $ok

# DL3: a null session id groups per FILE (every id-less session writes the same header).
Write-F $dl '.claude/telemetry/delegations/slot-03.json' "{`"schema`":2,`"session_id`":null,`"slot`":3,`"updated`":`"x`",`"step_fields`":$fieldsStd,`"loops_dropped`":0,`"loops`":[$(DlLoop 'main' '["m"]' '[]' 0 $u '[]')]}"
Write-F $dl '.claude/telemetry/delegations/slot-04.json' "{`"schema`":2,`"session_id`":null,`"slot`":4,`"updated`":`"y`",`"step_fields`":$fieldsStd,`"loops_dropped`":0,`"loops`":[$(DlLoop 'main' '["m"]' '[]' 0 $u '[]')]}"
$rDL3 = Invoke-Retro $dl @('--delegations')
$ok = (Assert-True 'DL3 two null-id files stay two sessions' ($rDL3.Out -match '4 slot file\(s\), 3 session\(s\)' -and $rDL3.Out -match 'session \(no session id\) slot-03\.json' -and $rDL3.Out -match 'session \(no session id\) slot-04\.json') $rDL3.Out) -and $ok

# DL4: usage errors — the report takes no range and does not combine with --coverage.
$rDL4 = Invoke-Retro $dl @('--delegations', 'HEAD~1..HEAD')
$rDL4b = Invoke-Retro $dl @('--delegations', '--coverage')
$ok = (Assert-True 'DL4 --delegations with a range or --coverage is a usage error (exit 2)' ($rDL4.Code -eq 2 -and $rDL4b.Code -eq 2 -and $rDL4.Out -match 'takes no range') "range exit=$($rDL4.Code), coverage exit=$($rDL4b.Code): $($rDL4.Out)") -and $ok

# DL5: unknown effort on both sides is no inherit signature (a Haiku main loop sends none); a session
# with no main loop is counted apart; a directory at a slot name is named as skipped.
$dl5 = Join-Path $fxBase 'delegations-5'
New-Item -ItemType Directory -Force -Path $dl5 | Out-Null
Write-F $dl5 '.harness.json' '{}'
# A teammate (2.1.289+) is written as an agent-tool loop whose spawn row says teammate: true.
$mate = '{"subagent_type":"researcher","model_param":null,"model":"claude-sonnet-5-5","teammate":true}'
# Controls: `teammate: false` (every non-teammate spawn the 0.62.1 writer emits) and a non-boolean "true"
# stay agent-tool — the reader re-kinds on the boolean true only.
$notMate = '{"subagent_type":"Explore","model_param":null,"model":"claude-haiku-4-5","teammate":false}'
$strMate = '{"subagent_type":"Plan","model_param":null,"model":"claude-haiku-4-5","teammate":"true"}'
$loops5 = @((DlLoop 'main' '["claude-haiku-4-5"]' '[]' 0 $u '[]'), (DlLoop 'unspawned' '["claude-haiku-4-5"]' '[]' 0 $u '[]'),
    (DlLoop 'agent-tool' '["claude-sonnet-5-5"]' '["high"]' 0 $u '[]' $mate),
    (DlLoop 'agent-tool' '["claude-haiku-4-5"]' '[]' 0 $u '[]' $notMate),
    (DlLoop 'agent-tool' '["claude-haiku-4-5"]' '[]' 0 $u '[]' $strMate)) -join ','
Write-F $dl5 '.claude/telemetry/delegations/slot-00.json' "{`"schema`":2,`"session_id`":`"haiku-main`",`"slot`":0,`"updated`":`"a`",`"step_fields`":$fieldsStd,`"loops_dropped`":0,`"loops`":[$loops5]}"
Write-F $dl5 '.claude/telemetry/delegations/slot-01.json' "{`"schema`":2,`"session_id`":`"no-main`",`"slot`":1,`"updated`":`"b`",`"step_fields`":$fieldsStd,`"loops_dropped`":0,`"loops`":[$(DlLoop 'unspawned' '["m"]' '["low"]' 0 $u '[]')]}"
New-Item -ItemType Directory -Force -Path (Join-Path $dl5 '.claude/telemetry/delegations/slot-02.json') | Out-Null
$rDL5 = Invoke-Retro $dl5 @('--delegations')
$o5 = $rDL5.Out
$ok = (Assert-True 'DL5 an effort-less main and worker on one model: on the main model, NOT at its effort' ($o5 -match 'ADR 0117 D6: 1 unspawned loop\(s\) on their session''s main model in 1 session\(s\); 0 also at') $o5) -and $ok
$ok = (Assert-True 'DL5 the no-main session''s worker is counted apart' ($o5 -match 'not attributed: 0 with spawn rows evicted .*1 in a session with no main loop recorded' -and $o5 -match 'session no-main .* main: no main loop recorded') $o5) -and $ok
$ok = (Assert-True 'DL5 a directory at a slot name is skipped and named' ($o5 -match 'skipped: slot-02\.json \(not a regular file\)') $o5) -and $ok
$ok = (Assert-True 'DL5 a teammate spawn row reads as its own teammate row, never agent-tool' ($o5 -match 'teammate researcher \(model_param none\) · claude-sonnet-5-5 · high' -and $o5 -notmatch 'agent-tool researcher') $o5) -and $ok
$ok = (Assert-True 'DL5 teammate false and a non-boolean "true" stay agent-tool rows' ($o5 -match 'agent-tool Explore \(model_param none\)' -and $o5 -match 'agent-tool Plan \(model_param none\)' -and $o5 -notmatch 'teammate (Explore|Plan)') $o5) -and $ok

# DL7: workflow loops (2.1.292+, ADR 0126). Only the unnamed-type worker with no model given counts, and
# the count must not follow the resolved model: the counted one runs on sonnet (not main's opus), while a
# worker given `opus` runs on main's model and a named type with no model given (it may pin) is not
# counted either. Two counted loops against one on main's model: a model-equality rule reads 1, not 2.
# The unspawned control keeps its old line.
$dl7 = Join-Path $fxBase 'delegations-7'
New-Item -ItemType Directory -Force -Path $dl7 | Out-Null
Write-F $dl7 '.harness.json' '{}'
$wfGiven = '{"subagent_type":"workflow-subagent","model_param":"haiku","model":"claude-haiku-4-5","teammate":false,"workflow":{"run_id":"wf_a","agent_index":1}}'
$wfNone = '{"subagent_type":"workflow-subagent","model_param":null,"model":"claude-sonnet-5-5","teammate":false,"workflow":{"run_id":"wf_a","agent_index":2}}'
$wfNone2 = '{"subagent_type":"workflow-subagent","model_param":null,"model":"claude-sonnet-5-5","teammate":false,"workflow":{"run_id":"wf_b","agent_index":1}}'
$wfOnMain = '{"subagent_type":"workflow-subagent","model_param":"opus","model":"claude-opus-5-5","teammate":false,"workflow":{"run_id":"wf_a","agent_index":3}}'
$wfNamed = '{"subagent_type":"ywr-harness:mech","model_param":null,"model":"claude-haiku-4-5","teammate":false,"workflow":{"run_id":"wf_a","agent_index":4}}'
$loops7 = @((DlLoop 'main' '["claude-opus-5-5"]' '["xhigh"]' 0 $u '[]'),
    (DlLoop 'workflow' '["claude-haiku-4-5"]' '[]' 0 $u '[]' $wfGiven),
    (DlLoop 'workflow' '["claude-sonnet-5-5"]' '["low"]' 0 $u '[]' $wfNone),
    (DlLoop 'workflow' '["claude-sonnet-5-5"]' '["low"]' 0 $u '[]' $wfNone2),
    (DlLoop 'workflow' '["claude-opus-5-5"]' '["low"]' 0 $u '[]' $wfOnMain),
    (DlLoop 'workflow' '["claude-haiku-4-5"]' '[]' 0 $u '[]' $wfNamed),
    (DlLoop 'unspawned' '["claude-opus-5-5"]' '["xhigh"]' 0 $u '[]')) -join ','
Write-F $dl7 '.claude/telemetry/delegations/slot-00.json' "{`"schema`":2,`"session_id`":`"wf-sess`",`"slot`":0,`"updated`":`"a`",`"step_fields`":$fieldsStd,`"loops_dropped`":0,`"loops`":[$loops7]}"
$rDL7 = Invoke-Retro $dl7 @('--delegations')
$o7 = $rDL7.Out
$ok = (Assert-True 'DL7 workflow rows name their type and model_param, ordered before unspawned' ($o7 -match 'workflow workflow-subagent \(model_param haiku\) · claude-haiku-4-5' -and $o7 -match 'workflow workflow-subagent \(model_param none\) · claude-sonnet-5-5 · low' -and $o7 -match 'workflow ywr-harness:mech \(model_param none\) · claude-haiku-4-5') $o7) -and $ok
$ok = (Assert-True 'DL7 D6 counts the workflow loops with no model given and no type named, per session and in the summary' ($o7 -match 'workflow with no model given: 2 of 5' -and $o7 -match 'ADR 0126 D6: 2 of 5 workflow loop\(s\) with no model given in 1 session\(s\)') $o7) -and $ok
$ok = (Assert-True 'DL7 the unspawned heuristic is unchanged and workflow loops stay out of it' ($o7 -match 'ADR 0117 D6: 1 unspawned loop\(s\) on their session''s main model in 1 session\(s\); 1 also at the main loop''s effort') $o7) -and $ok
$ok = (Assert-True 'DL7 workflow sorts after main and before unspawned' ($o7.IndexOf('workflow workflow-subagent') -lt $o7.IndexOf('   unspawned ·') -and $o7.IndexOf('   main ·') -lt $o7.IndexOf('workflow workflow-subagent')) $o7) -and $ok

# DL6: SLICE_RETRO=0 skips the per-commit run, never an explicit --delegations request (ADR 0120).
$prevSR = $env:SLICE_RETRO
$env:SLICE_RETRO = '0'
try { $rDL6 = Invoke-Retro $dl5 @('--delegations'); $rDL6a = Invoke-Retro $dl5 @('--deleg'); $rDL6b = Invoke-Retro $dl5 @('--delegations', 'HEAD~1..HEAD'); $rDL6c = Invoke-Retro $dl5 @('--coverage') }
finally { if ($null -eq $prevSR) { Remove-Item Env:SLICE_RETRO -ErrorAction SilentlyContinue } else { $env:SLICE_RETRO = $prevSR } }
$ok = (Assert-True 'DL6 under SLICE_RETRO=0 the report still prints and the usage error still fires' ($rDL6.Out -match 'ADR 0117 D6:' -and $rDL6b.Code -eq 2) "exit=$($rDL6b.Code): $($rDL6.Out)") -and $ok
$ok = (Assert-True 'DL6 an abbreviated flag (--deleg, argparse prefix) is the same request' ($rDL6a.Out -match 'ADR 0117 D6:') $rDL6a.Out) -and $ok
$ok = (Assert-True 'DL6 control: SLICE_RETRO=0 still silences --coverage' ($rDL6c.Code -eq 0 -and -not $rDL6c.Out.Trim()) $rDL6c.Out) -and $ok
Remove-FixtureRoot $fxBase

if (-not $ok) { Write-Host 'harness_retro selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'harness_retro selftest: all cases green' -ForegroundColor Green
exit 0
