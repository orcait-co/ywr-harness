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

Remove-FixtureRoot $fxBase

if (-not $ok) { Write-Host 'harness_retro selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'harness_retro selftest: all cases green' -ForegroundColor Green
exit 0
