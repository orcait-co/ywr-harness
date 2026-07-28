# Selftest for init.ps1 — the scaffold writes into somebody's repo, so every terminal branch is
# enumerated here rather than trusted. The two that matter most are the ones a "it worked on my
# empty directory" check would never reach: a locally-edited TOOLCHAIN file must be reverted, and
# an existing SEED file must survive byte-identical. Getting those backwards either silently
# discards a repo's own CLAUDE.md or silently pins it to a stale builder.
#
# Fixtures live under the system temp root with exception-safe teardown (ADR 0126).

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../lib/selftest-lib.ps1')   # assertion core, ADR 0125

$init = Join-Path $PSScriptRoot 'init.ps1'
$templates = Join-Path $PSScriptRoot 'templates'
$fxBase = New-FixtureRoot 'harness-init-selftest'
trap { Remove-FixtureRoot $fxBase; break }

$ok = $true
function Invoke-Init([string[]]$Arguments) {
    $out = & pwsh -NoProfile -ExecutionPolicy Bypass -File $init @Arguments 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}
function New-Target([string]$Name) {
    $p = Join-Path $fxBase $Name
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    return $p
}
# Every file init.ps1 places. Hardcoded on purpose: deriving it from init.ps1's own tables would
# make the test agree with a typo in the thing it is testing.
$EXPECT = @(
    'docs/README.md', 'docs/adr/README.md', 'docs/adr/0000-template.md',
    'docs/spec/README.md', 'docs/spec/0000-template.md',
    'docs/build.ps1', 'docs/build.sh', 'docs/build_docs.py',
    'CLAUDE.md', '.gitattributes', '.harness.json',
    'docs/adr/0001-adopt-docs-as-code.md',  # corpus seed — without it the builder has nothing to index
    # Vendored so a consuming repo's CI needs no access to the private canon (ADR 0014).
    'scripts/harness/harness_config.py', 'scripts/harness/harness_gates.py',
    'scripts/harness/verify_map.py', '.github/workflows/harness-gates.yml',
    'scripts/harness/.gitignore',
    # Local execution layer (ADR 0015). Placement is asserted here; the WIRING branches are cases
    # K-O, and the hooks' own behaviour is githooks.selftest.ps1.
    '.githooks/pre-commit', '.githooks/pre-push',
    # Slice retro gate (ADR 0017). post-commit is GUARDED rather than TOOLCHAIN — cases Q1/Q2.
    'scripts/harness/harness_retro.py', '.githooks/post-commit', '.githooks/slice-retro-ignore'
)
$EXPECT_N = $EXPECT.Count

# --- A: empty directory gets the whole shape --------------------------------------------------
$a = New-Target 'empty'
$rA = Invoke-Init @('-Target', $a)
$missing = @($EXPECT | Where-Object { -not (Test-Path -LiteralPath (Join-Path $a $_) -PathType Leaf) })
$ok = (Assert-True 'A exit 0 on an empty directory' ($rA.Code -eq 0) "exit=$($rA.Code) out=$($rA.Out)") -and $ok
$ok = (Assert-True "A all $EXPECT_N files placed" ($missing.Count -eq 0) "missing: $($missing -join ', ')") -and $ok
$ok = (Assert-True "A reports created=$EXPECT_N" ($rA.Out -match "created=$EXPECT_N\b") $rA.Out) -and $ok
$ok = (Assert-True 'A reports the hook wiring outcome' ($rA.Out -match 'hooks: ') $rA.Out) -and $ok
# The point of the corpus seed: a scaffolded repo must BUILD. Without a record the builder exits 1
# ("found no .md with frontmatter") and no tooling can query the repo's decisions — the defect the
# first end-to-end run surfaced, which this case pins.
$pyAvail = [bool](@('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1)
if ($pyAvail) {
    $ok = (Assert-True 'A build produced index.json' (Test-Path -LiteralPath (Join-Path $a 'docs/index.json') -PathType Leaf) "out=$($rA.Out)") -and $ok
    $ok = (Assert-True 'A build reported, not skipped' ($rA.Out -match 'built: index\.json') $rA.Out) -and $ok
} else {
    Write-Host 'SKIP [A build] python absent (reported, not silent) — CI has python' -ForegroundColor Yellow
}

# --- B: re-run is a no-op (idempotence) -------------------------------------------------------
# The report must say unchanged, not "refreshed": a no-op counted as a refresh hides which files
# the canon actually changed on a real update.
$rB = Invoke-Init @('-Target', $a)
$ok = (Assert-True 'B re-run exits 0' ($rB.Code -eq 0) "exit=$($rB.Code)") -and $ok
$ok = (Assert-True 'B re-run creates nothing' ($rB.Out -match 'created=0') $rB.Out) -and $ok
$ok = (Assert-True 'B re-run refreshes nothing (identical content is not a refresh)' ($rB.Out -match 'refreshed=0') $rB.Out) -and $ok

# --- C: an edited TOOLCHAIN file is reverted --------------------------------------------------
$builder = Join-Path $a 'docs/build_docs.py'
Set-Content -LiteralPath $builder -Value '# locally hacked' -NoNewline
$rC = Invoke-Init @('-Target', $a)
$builderNow = Get-Content -LiteralPath $builder -Raw
$builderCanon = Get-Content -LiteralPath (Join-Path $templates 'docs/build_docs.py') -Raw
$ok = (Assert-True 'C edited toolchain file is refreshed' ($rC.Out -match 'refreshed=1') $rC.Out) -and $ok
$ok = (Assert-True 'C toolchain content matches canon after refresh' ($builderNow -eq $builderCanon) 'builder still holds local edit') -and $ok

# --- D: an existing SEED file survives byte-identical -----------------------------------------
$d = New-Target 'seeded'
$mine = "# my own CLAUDE.md`nkeep me`n"
Set-Content -LiteralPath (Join-Path $d 'CLAUDE.md') -Value $mine -NoNewline
$rD = Invoke-Init @('-Target', $d)
$after = Get-Content -LiteralPath (Join-Path $d 'CLAUDE.md') -Raw
$ok = (Assert-True 'D existing seed reported preserved' ($rD.Out -match 'preserved=1') $rD.Out) -and $ok
$ok = (Assert-True 'D existing seed is byte-identical afterwards' ($after -eq $mine) 'CLAUDE.md was modified') -and $ok
$ok = (Assert-True 'D preserved seed still warns the reader' ($rD.Out -match 'never clobber') $rD.Out) -and $ok

# --- E: content files are never touched -------------------------------------------------------
# A repo's accumulated decisions are the one thing a re-runnable scaffold must not endanger.
$adr = Join-Path $a 'docs/adr/0001-a-real-decision.md'
$adrBody = "---`nid: `"0001`"`n---`n# 0001. a real decision`n"
Set-Content -LiteralPath $adr -Value $adrBody -NoNewline
$rE = Invoke-Init @('-Target', $a)
$ok = (Assert-True 'E existing ADR still present' (Test-Path -LiteralPath $adr -PathType Leaf) 'ADR vanished') -and $ok
$ok = (Assert-True 'E existing ADR unmodified' ((Get-Content -LiteralPath $adr -Raw) -eq $adrBody) 'ADR content changed') -and $ok
$ok = (Assert-True 'E run exits 0' ($rE.Code -eq 0) "exit=$($rE.Code)") -and $ok

# --- F: dry run writes nothing ----------------------------------------------------------------
$f = New-Target 'dry'
$rF = Invoke-Init @('-Target', $f, '-DryRun')
$leftBehind = @(Get-ChildItem -LiteralPath $f -Recurse -File -ErrorAction SilentlyContinue)
$ok = (Assert-True 'F dry run exits 0' ($rF.Code -eq 0) "exit=$($rF.Code)") -and $ok
$ok = (Assert-True 'F dry run says so' ($rF.Out -match 'dry run') $rF.Out) -and $ok
$ok = (Assert-True "F dry run reports what it would create" ($rF.Out -match "created=$EXPECT_N\b") $rF.Out) -and $ok
$ok = (Assert-True 'F dry run wrote no file' ($leftBehind.Count -eq 0) "wrote $($leftBehind.Count) file(s)") -and $ok

# --- G: unusable targets fail loudly ----------------------------------------------------------
$rG1 = Invoke-Init @('-Target', (Join-Path $fxBase 'does-not-exist'))
$ok = (Assert-True 'G1 missing target exits 1' ($rG1.Code -eq 1) "exit=$($rG1.Code)") -and $ok

$fileTarget = Join-Path $fxBase 'i-am-a-file.txt'
Set-Content -LiteralPath $fileTarget -Value 'x' -NoNewline
$rG2 = Invoke-Init @('-Target', $fileTarget)
$ok = (Assert-True 'G2 file-as-target exits 1' ($rG2.Code -eq 1) "exit=$($rG2.Code)") -and $ok

# --- H: a template missing from the plugin fails, and does not half-scaffold silently ----------
# Runs a COPY of the skill with one template deleted; the real plugin is never modified.
$brokenSkill = Join-Path $fxBase 'broken-skill'
Copy-Item -LiteralPath $PSScriptRoot -Destination $brokenSkill -Recurse -Force
Remove-Item -LiteralPath (Join-Path $brokenSkill 'templates/docs/build.sh') -Force
# lib/ is resolved as ../../lib from the skill dir — give the copy that shape
New-Item -ItemType Directory -Force -Path (Join-Path $fxBase 'lib') | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../lib/selftest-lib.ps1') -Destination (Join-Path $fxBase 'lib/selftest-lib.ps1') -Force
$h = New-Target 'broken'
$outH = & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $brokenSkill 'init.ps1') -Target $h 2>&1 | Out-String
$codeH = $LASTEXITCODE
$ok = (Assert-True 'H missing template exits 1' ($codeH -eq 1) "exit=$codeH out=$outH") -and $ok
$ok = (Assert-True 'H missing template is named' ($outH -match 'template missing in plugin') $outH) -and $ok

# --- I: an existing corpus suppresses the seed (no duplicate id 0001) -------------------------
# The other half of the conditional seed. Placing it unconditionally would give a repo that already
# numbered its own 0001 two records claiming the same id.
$i = New-Target 'has-records'
New-Item -ItemType Directory -Force -Path (Join-Path $i 'docs/adr') | Out-Null
$mine0001 = Join-Path $i 'docs/adr/0001-my-own-first-decision.md'
Set-Content -LiteralPath $mine0001 -Value "---`nid: `"0001`"`n---`n# 0001. mine`n" -NoNewline
$rI = Invoke-Init @('-Target', $i)
$seedLanded = Test-Path -LiteralPath (Join-Path $i 'docs/adr/0001-adopt-docs-as-code.md') -PathType Leaf
$ok = (Assert-True 'I seed suppressed when a record exists' (-not $seedLanded) 'corpus seed placed over an existing 0001') -and $ok
$ok = (Assert-True 'I suppression is reported' ($rI.Out -match 'corpus seed not placed') $rI.Out) -and $ok
$ok = (Assert-True 'I existing record untouched' ((Get-Content -LiteralPath $mine0001 -Raw) -match 'mine') 'existing 0001 changed') -and $ok
$ok = (Assert-True 'I run exits 0' ($rI.Code -eq 0) "exit=$($rI.Code)") -and $ok

# --- I2: records that do not match ^\d{4}- still suppress the seed ----------------------------
# The shipped v0.12.1 defect: detection matched only `^\d{4}-` names, so a repo whose log used
# another convention (ADR-001-*, 001-*, dated names) was seeded with a second decision log.
$i2 = New-Target 'has-records-other-naming'
New-Item -ItemType Directory -Force -Path (Join-Path $i2 'docs/adr') | Out-Null
Set-Content -LiteralPath (Join-Path $i2 'docs/adr/ADR-007-choose-database.md') -Value "# ADR-007`n" -NoNewline
$rI2 = Invoke-Init @('-Target', $i2)
$seedLanded2 = Test-Path -LiteralPath (Join-Path $i2 'docs/adr/0001-adopt-docs-as-code.md') -PathType Leaf
$ok = (Assert-True 'I2 non-standard-named record suppresses the seed' (-not $seedLanded2) 'seed placed next to ADR-007-*') -and $ok
$ok = (Assert-True 'I2 suppression is reported' ($rI2.Out -match 'corpus seed not placed') $rI2.Out) -and $ok
# ADR-007-* is invisible to the builder (FILE_RE wants NNNN-*.md), so this repo's corpus is
# unbuildable after suppression — the report must carry that cause, not just the suppression.
$ok = (Assert-True 'I2 unbuildable corpus is explained with the rename path' ($rI2.Out -match 'docs build will refuse' -and $rI2.Out -match 'rename') $rI2.Out) -and $ok
$ok = (Assert-True 'I2 run exits 0' ($rI2.Code -eq 0) "exit=$($rI2.Code)") -and $ok

# --- I3: records in a conventional home OUTSIDE docs/adr/ suppress the seed and name it -------
# Seeding 0001 next to a foreign log (doc/adr, docs/decisions, ...) forks the repo's decision
# history; the operator must migrate, and the report must say where the records are and what to do.
$i3 = New-Target 'has-records-elsewhere'
New-Item -ItemType Directory -Force -Path (Join-Path $i3 'doc/adr') | Out-Null
Set-Content -LiteralPath (Join-Path $i3 'doc/adr/0001-use-postgres.md') -Value "# 0001`n" -NoNewline
$rI3 = Invoke-Init @('-Target', $i3)
$seedLanded3 = Test-Path -LiteralPath (Join-Path $i3 'docs/adr/0001-adopt-docs-as-code.md') -PathType Leaf
$ok = (Assert-True 'I3 foreign-location record suppresses the seed' (-not $seedLanded3) 'seed placed while doc/adr/ holds records') -and $ok
$ok = (Assert-True 'I3 the location is named' ($rI3.Out -match 'doc/adr') $rI3.Out) -and $ok
$ok = (Assert-True 'I3 the migration path is stated' ($rI3.Out -match 'migrate them into docs/adr/') $rI3.Out) -and $ok
$ok = (Assert-True 'I3 run exits 0' ($rI3.Code -eq 0) "exit=$($rI3.Code)") -and $ok

# --- I4: README/template files are NOT records — no over-suppression --------------------------
# The negative half of I2/I3: a doc/adr/ holding only a README must still count as empty, or the
# broadened detection would deny the seed (and with it a buildable corpus) to repos it should serve.
$i4 = New-Target 'readme-only-elsewhere'
New-Item -ItemType Directory -Force -Path (Join-Path $i4 'doc/adr') | Out-Null
Set-Content -LiteralPath (Join-Path $i4 'doc/adr/README.md') -Value "# about ADRs`n" -NoNewline
Set-Content -LiteralPath (Join-Path $i4 'doc/adr/decision-template.md') -Value "# template`n" -NoNewline
$rI4 = Invoke-Init @('-Target', $i4)
$seedLanded4 = Test-Path -LiteralPath (Join-Path $i4 'docs/adr/0001-adopt-docs-as-code.md') -PathType Leaf
$ok = (Assert-True 'I4 README/template alone do not suppress' $seedLanded4 "seed not placed; out=$($rI4.Out)") -and $ok
$ok = (Assert-True 'I4 run exits 0' ($rI4.Code -eq 0) "exit=$($rI4.Code)") -and $ok

# --- I5: 'template' inside a record's TITLE does not exclude it (anchored suffix match) --------
# The review-caught regression: an unanchored -notmatch 'template' excluded a real record about
# templating, reproducing the seeded-second-log bug via filename content instead of convention.
$i5 = New-Target 'record-about-templating'
New-Item -ItemType Directory -Force -Path (Join-Path $i5 'doc/adr') | Out-Null
Set-Content -LiteralPath (Join-Path $i5 'doc/adr/0007-template-engine-selection.md') -Value "# 0007`n" -NoNewline
$rI5 = Invoke-Init @('-Target', $i5)
$seedLanded5 = Test-Path -LiteralPath (Join-Path $i5 'docs/adr/0001-adopt-docs-as-code.md') -PathType Leaf
$ok = (Assert-True 'I5 a record about templating still suppresses the seed' (-not $seedLanded5) "seed placed despite 0007-template-engine-selection.md; out=$($rI5.Out)") -and $ok
$ok = (Assert-True 'I5 run exits 0' ($rI5.Code -eq 0) "exit=$($rI5.Code)") -and $ok

# --- I6: records in BOTH docs/adr/ and a foreign home -> both reported ------------------------
# A transitional repo (standard log started, old log not yet migrated) must hear about the
# foreign location too; an if/elseif that stops at the docs/adr/ count hides it.
$i6 = New-Target 'records-both-places'
New-Item -ItemType Directory -Force -Path (Join-Path $i6 'docs/adr') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $i6 'doc/adr') | Out-Null
Set-Content -LiteralPath (Join-Path $i6 'docs/adr/0001-first.md') -Value "# 0001`n" -NoNewline
Set-Content -LiteralPath (Join-Path $i6 'doc/adr/0009-legacy.md') -Value "# 0009`n" -NoNewline
$rI6 = Invoke-Init @('-Target', $i6)
$ok = (Assert-True 'I6 docs/adr records reported' ($rI6.Out -match 'docs/adr/ already holds 1 record') $rI6.Out) -and $ok
$ok = (Assert-True 'I6 foreign location reported in the same run' ($rI6.Out -match 'outside docs/adr/.*doc/adr') $rI6.Out) -and $ok
$ok = (Assert-True 'I6 run exits 0' ($rI6.Code -eq 0) "exit=$($rI6.Code)") -and $ok

# --- J: a hostile console encoding must not break the build ------------------------------------
# The windows-latest failure this case pins: Python encodes stdout with the console codepage, so a
# non-UTF-8 codepage makes the builder's OWN output raise UnicodeEncodeError and exit 1 — after
# index.json has already been written, which is why "index.json exists" alone would still pass.
# docs/build.ps1 sets the pin explicitly, so an inherited cp1252 must be overridden.
$j = New-Target 'cp1252'
$prevIo = $env:PYTHONIOENCODING
$env:PYTHONIOENCODING = 'cp1252'
try { $rJ = Invoke-Init @('-Target', $j) }
finally {
    if ($null -eq $prevIo) { Remove-Item Env:PYTHONIOENCODING -ErrorAction SilentlyContinue } else { $env:PYTHONIOENCODING = $prevIo }
}
if ($pyAvail) {
    $ok = (Assert-True 'J build survives an inherited cp1252 stdout encoding' ($rJ.Out -match 'built: index\.json') $rJ.Out) -and $ok
    $ok = (Assert-True 'J index.json exists under cp1252' (Test-Path -LiteralPath (Join-Path $j 'docs/index.json') -PathType Leaf) 'index.json missing') -and $ok
} else {
    Write-Host 'SKIP [J encoding] python absent (reported, not silent) — CI has python' -ForegroundColor Yellow
}

# --- K-O: core.hooksPath wiring (ADR 0015) -----------------------------------------------------
# This is the ONLY thing init.ps1 does that is not a file write, so every branch is enumerated. The
# case that matters most is M: a repo pointing hooksPath somewhere of its own must come out of a
# scaffold run with that value intact, because init.ps1's whole credibility is "never clobbers what
# it did not write".
function New-GitTarget([string]$Name) {
    $p = New-Target $Name
    Push-Location $p
    try {
        & git init -q 2>$null
        & git config user.email 'selftest@example.invalid' 2>$null
        & git config user.name 'selftest' 2>$null
    } finally { Pop-Location }
    return $p
}
function Get-HooksPath([string]$Repo) {
    $v = & git -C $Repo config --local --get core.hooksPath 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    return ([string]$v).Trim()
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'SKIP [K-O wiring] git absent (reported, not silent) — CI has git' -ForegroundColor Yellow
} else {
    # K: unset -> wired
    $k = New-GitTarget 'wire-unset'
    $rK = Invoke-Init @('-Target', $k)
    $ok = (Assert-True 'K unset hooksPath gets wired' ((Get-HooksPath $k) -eq '.githooks') "value='$(Get-HooksPath $k)' out=$($rK.Out)") -and $ok
    $ok = (Assert-True 'K wiring is reported' ($rK.Out -match 'hooks: .*wired') $rK.Out) -and $ok
    $ok = (Assert-True 'K hooks are actually on disk' ((Test-Path -LiteralPath (Join-Path $k '.githooks/pre-commit') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $k '.githooks/pre-push') -PathType Leaf)) 'a hook file is missing') -and $ok

    # The executable bit is not cosmetic on POSIX: git skips a non-executable hook WITHOUT SAYING SO,
    # which is the same silent-inert failure the wiring branches above exist to prevent. Windows is
    # exempt because git there invokes hooks through sh regardless of the mode.
    if ($IsWindows) {
        Write-Host 'SKIP [K exec bit] Windows — git invokes hooks through sh regardless of the mode bit' -ForegroundColor Yellow
    } else {
        try {
            $noExec = @('.githooks/pre-commit', '.githooks/pre-push') | Where-Object {
                ([IO.File]::GetUnixFileMode((Join-Path $k $_)) -band [IO.UnixFileMode]::UserExecute) -eq 0
            }
            $ok = (Assert-True 'K placed hooks are executable' ($noExec.Count -eq 0) "not executable: $($noExec -join ', ')") -and $ok
        } catch {
            Write-Host "SKIP [K exec bit] GetUnixFileMode unavailable: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    # L: already .githooks -> no-op, still reported
    $rL = Invoke-Init @('-Target', $k)
    $ok = (Assert-True 'L re-run leaves the wired value alone' ((Get-HooksPath $k) -eq '.githooks') "value='$(Get-HooksPath $k)'") -and $ok
    $ok = (Assert-True 'L re-run says already wired' ($rL.Out -match 'already wired') $rL.Out) -and $ok

    # M: a foreign value is REFUSED, not overwritten
    $m = New-GitTarget 'wire-foreign'
    & git -C $m config --local core.hooksPath '.myhooks' 2>$null
    $rM = Invoke-Init @('-Target', $m)
    $ok = (Assert-True 'M foreign hooksPath survives byte-identical' ((Get-HooksPath $m) -eq '.myhooks') "value='$(Get-HooksPath $m)'") -and $ok
    $ok = (Assert-True 'M refusal is reported' ($rM.Out -match 'REFUSED') $rM.Out) -and $ok
    $ok = (Assert-True 'M the existing value is named in the report' ($rM.Out -match '\.myhooks') $rM.Out) -and $ok
    $ok = (Assert-True 'M run still exits 0' ($rM.Code -eq 0) "exit=$($rM.Code)") -and $ok

    # N: dry run touches no git config
    $n = New-GitTarget 'wire-dry'
    $rN = Invoke-Init @('-Target', $n, '-DryRun')
    $ok = (Assert-True 'N dry run sets nothing' ((Get-HooksPath $n) -eq '') "value='$(Get-HooksPath $n)'") -and $ok
    $ok = (Assert-True 'N dry run says what it would do' ($rN.Out -match 'would set it') $rN.Out) -and $ok

    # O: a subdirectory of a repo is refused — setting hooksPath there reconfigures the whole repo
    $o = Join-Path $k 'sub/tree'
    New-Item -ItemType Directory -Force -Path $o | Out-Null
    $rO = Invoke-Init @('-Target', $o)
    $ok = (Assert-True 'O subdirectory target refuses to wire' ($rO.Out -match 'not the repository root') $rO.Out) -and $ok
    $ok = (Assert-True 'O parent repo hooksPath is untouched' ((Get-HooksPath $k) -eq '.githooks') "parent value='$(Get-HooksPath $k)'") -and $ok
}

# --- Q: GUARDED placement — post-commit is the one filename repos already use -------------------
# TOOLCHAIN would destroy working automation (this canon's own repo uses post-commit to republish
# the docs artifact); SEED would silently deny the retro to any repo that has one. So: refresh ours,
# refuse theirs.
$q = New-Target 'guarded-foreign'
$mine = "#!/bin/sh`n# my own post-commit`necho hello`n"
Set-Content -LiteralPath (Join-Path $q '.githooks/post-commit') -Value $mine -NoNewline -Force -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath (Join-Path $q '.githooks'))) { New-Item -ItemType Directory -Force -Path (Join-Path $q '.githooks') | Out-Null }
Set-Content -LiteralPath (Join-Path $q '.githooks/post-commit') -Value $mine -NoNewline
$rQ = Invoke-Init @('-Target', $q)
$afterQ = Get-Content -LiteralPath (Join-Path $q '.githooks/post-commit') -Raw
$ok = (Assert-True 'Q1 a foreign post-commit survives byte-identical' ($afterQ -eq $mine) 'post-commit was overwritten') -and $ok
$ok = (Assert-True 'Q1 the refusal is reported' ($rQ.Out -match 'REFUSED') $rQ.Out) -and $ok
$ok = (Assert-True 'Q1 refused is counted separately' ($rQ.Out -match 'refused=1') $rQ.Out) -and $ok
$ok = (Assert-True 'Q1 the one-line workaround is printed' ($rQ.Out -match 'harness_retro\.py') $rQ.Out) -and $ok
$ok = (Assert-True 'Q1 run still exits 0' ($rQ.Code -eq 0) "exit=$($rQ.Code)") -and $ok

# Q2: a post-commit carrying the marker is OURS, so it refreshes like any toolchain file.
$q2 = New-Target 'guarded-ours'
New-Item -ItemType Directory -Force -Path (Join-Path $q2 '.githooks') | Out-Null
Set-Content -LiteralPath (Join-Path $q2 '.githooks/post-commit') -Value "#!/bin/sh`n# ywr-harness:post-commit`n# stale copy`n" -NoNewline
$rQ2 = Invoke-Init @('-Target', $q2)
$canonPC = Get-Content -LiteralPath (Join-Path $templates 'githooks/post-commit') -Raw
$afterQ2 = Get-Content -LiteralPath (Join-Path $q2 '.githooks/post-commit') -Raw
$ok = (Assert-True 'Q2 a marked post-commit is refreshed from canon' ($afterQ2 -eq $canonPC) 'marked copy was not refreshed') -and $ok
$ok = (Assert-True 'Q2 nothing is refused' ($rQ2.Out -match 'refused=0') $rQ2.Out) -and $ok

# --- P: a non-git target places the hooks and says they will not run ---------------------------
# The fixture targets in A-J are plain directories, so this is the branch they all exercised
# implicitly. Asserted explicitly so "placed but inert" can never become silent.
$ok = (Assert-True 'P non-git target reports the hooks are not wired' ($rA.Out -match 'hooks: .*(not a git repository|NOT set)') $rA.Out) -and $ok

Remove-FixtureRoot $fxBase

if (-not $ok) { Write-Host 'harness-init selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'harness-init selftest: all cases green' -ForegroundColor Green
exit 0
