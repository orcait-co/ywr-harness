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
    # Root ignore seed (ADR 0053) + starter review canon seed (ADR 0054).
    '.gitignore', 'REVIEW.md',
    'docs/adr/0001-adopt-docs-as-code.md',  # corpus seed — without it the builder has nothing to index
    # Vendored so a consuming repo's CI needs no access to the private canon (ADR 0014).
    'scripts/harness/harness_config.py', 'scripts/harness/harness_gates.py',
    'scripts/harness/verify_map.py', '.github/workflows/harness-gates.yml',
    'scripts/harness/.gitignore',
    # CI PR-base resolver (ADR 0043) — the vendored workflow invokes it via sh.
    'scripts/harness/resolve-base.sh',
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
# ADR 0042: every successful run stamps which plugin version scaffolded the repo. Compared
# against plugin.json directly — a stamp that drifted from the manifest would misdirect the
# refresh nudge's direction verdict on every machine.
$manifestVer = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../.claude-plugin/plugin.json') -Raw | ConvertFrom-Json).version
$ok = (Assert-True 'A stamp written with the plugin version' `
        ((Test-Path -LiteralPath (Join-Path $a '.harness-version') -PathType Leaf) -and
        (((Get-Content -LiteralPath (Join-Path $a '.harness-version') -Raw).Trim()) -eq $manifestVer)) `
        "stamp missing or wrong; manifest=$manifestVer out=$($rA.Out)") -and $ok
$ok = (Assert-True 'A stamp is reported' ($rA.Out -match 'stamp: \.harness-version') $rA.Out) -and $ok
# Issue #52: the stamp is claimed BUILT-IN since ADR 0044 — the old "claim it in .harness.json
# groups" instruction sent members declaring an entry the emitter already owns.
$ok = (Assert-True 'A stamp line says claimed built-in, not claim-it-yourself' `
        ($rA.Out -match 'claimed built-in by the emitter' -and $rA.Out -notmatch 'claim it in \.harness\.json groups') $rA.Out) -and $ok
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
$mineReview = "# my own REVIEW.md`nhouse invariants`n"
Set-Content -LiteralPath (Join-Path $d 'REVIEW.md') -Value $mineReview -NoNewline
$rD = Invoke-Init @('-Target', $d)
$after = Get-Content -LiteralPath (Join-Path $d 'CLAUDE.md') -Raw
$ok = (Assert-True 'D existing seeds reported preserved' ($rD.Out -match 'preserved=2') $rD.Out) -and $ok
$ok = (Assert-True 'D existing seed is byte-identical afterwards' ($after -eq $mine) 'CLAUDE.md was modified') -and $ok
$ok = (Assert-True 'D existing REVIEW.md is byte-identical afterwards (ADR 0054 — SEED)' `
        ((Get-Content -LiteralPath (Join-Path $d 'REVIEW.md') -Raw) -eq $mineReview) 'REVIEW.md was modified') -and $ok
$ok = (Assert-True 'D preserved seed still warns the reader' ($rD.Out -match 'never clobber') $rD.Out) -and $ok
# CLAUDE.md and REVIEW.md are deliberately OUTSIDE the drift probe (ADR 0051/0054): both are
# placeholder prose a repo rewrites wholesale, so a note would be permanent noise. These seeds
# share zero lines with their templates — a note here means the exclusion regressed.
$ok = (Assert-True 'D rewritten CLAUDE.md/REVIEW.md never carry a drift note' ($rD.Out -notmatch 'this seed lacks') $rD.Out) -and $ok

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
$ok = (Assert-True 'F dry run reports the stamp it would write' ($rF.Out -match 'stamp: would write \.harness-version') $rF.Out) -and $ok

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

# --- R: a CRLF-materialized plugin cache still places LF ---------------------------------------
# The shipped v0.23.0 defect: the installed plugin is checked out by the CONSUMER's git, where
# core.autocrlf stamps CRLF onto every template (measured: 162 CRLF pairs in the cached
# githooks/pre-commit). Copy-Item placed those bytes verbatim, so an eol=lf repo saw ten spurious
# modifications after every re-run, and a POSIX clone got sh hooks that die with
# "/bin/sh^M: bad interpreter". Placement owns the line discipline now: LF out, whatever came in.
# Runs a COPY of the skill with CRLF stamped onto every template; the real plugin is never modified.
$crlfSkill = Join-Path $fxBase 'crlf-skill'
Copy-Item -LiteralPath $PSScriptRoot -Destination $crlfSkill -Recurse -Force
$latin1 = [System.Text.Encoding]::Latin1
foreach ($t in Get-ChildItem -LiteralPath (Join-Path $crlfSkill 'templates') -Recurse -File) {
    $stamped = $latin1.GetString([IO.File]::ReadAllBytes($t.FullName)).Replace("`r`n", "`n").Replace("`n", "`r`n")
    [IO.File]::WriteAllBytes($t.FullName, $latin1.GetBytes($stamped))
}
$r = New-Target 'crlf-cache'
$outR = & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $crlfSkill 'init.ps1') -Target $r 2>&1 | Out-String
$codeR = $LASTEXITCODE
$ok = (Assert-True 'R run against a CRLF cache exits 0' ($codeR -eq 0) "exit=$codeR out=$outR") -and $ok
$withCr = @($EXPECT | Where-Object {
    (Test-Path -LiteralPath (Join-Path $r $_) -PathType Leaf) -and
    ($latin1.GetString([IO.File]::ReadAllBytes((Join-Path $r $_))).Contains("`r"))
})
$ok = (Assert-True 'R no placed file carries a CR' ($withCr.Count -eq 0) "CR found in: $($withCr -join ', ')") -and $ok
# Re-run against the same CRLF cache. What each assertion pins (review 2026-08-06, low — an
# earlier comment implied this one covered the verbatim revert): the CR-absence assertion above
# kills a revert to verbatim Copy-Item placement; THIS assertion kills the normalize-write-but-
# raw-compare regression (ADR 0036's rejected Option C — LF on disk vs a CRLF template differs
# raw, so every re-run would re-report every placement as refreshed). A full revert passes this
# assertion alone: verbatim run 1 makes run 2's raw compare byte-identical.
$outR2 = & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $crlfSkill 'init.ps1') -Target $r 2>&1 | Out-String
$ok = (Assert-True 'R re-run refreshes nothing (CR-only delta is not a change)' ($outR2 -match 'refreshed=0' -and $outR2 -match 'created=0') $outR2) -and $ok
# A LONE CR (0x0D with no LF after it) is also not a change: the compare is ADR 0033's fold
# verbatim — drop every 0x0D — NOT a CRLF-pair fold, so the scaffold and the refresh nudge agree
# on lone-CR deltas too (review 2026-08-06, medium: a CRLF-pair fold counted this as a refresh
# the nudge stays silent on). The byte itself is left as placed: the compare only decides whether
# a re-run would change anything, and line endings belong to git's attributes.
$loneTarget = Join-Path $r 'docs/build.ps1'
[IO.File]::WriteAllBytes($loneTarget, [byte[]]([IO.File]::ReadAllBytes($loneTarget) + [byte]13))
$outR3 = & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $crlfSkill 'init.ps1') -Target $r 2>&1 | Out-String
$ok = (Assert-True 'R lone-CR delta is not a change (0033 fold, not a CRLF-pair fold)' ($outR3 -match 'refreshed=0' -and $outR3 -match 'created=0') $outR3) -and $ok
$ok = (Assert-True 'R the lone CR is left as placed, not rewritten' ($latin1.GetString([IO.File]::ReadAllBytes($loneTarget)).EndsWith("`r")) 'lone CR was rewritten away') -and $ok

# --- S: downgrade guard + stamp lifecycle (ADR 0042) --------------------------------------------
# The multi-writer destructive path this section pins: writer A refreshes a repo at vN+1 and
# merges; writer B (plugin vN) re-runs the scaffold — pre-0042 it silently placed the older
# templates over A's refresh. Now it must REFUSE before writing anything, and -Force must remain
# the deliberate-rollback path.
$s = New-Target 'stamp-newer'
$rS0 = Invoke-Init @('-Target', $s)
$ok = (Assert-True 'S setup run exits 0' ($rS0.Code -eq 0) "exit=$($rS0.Code)") -and $ok
# Drift one toolchain file AND raise the stamp: the refusal must leave the drift in place.
$sBuilder = Join-Path $s 'docs/build_docs.py'
Set-Content -LiteralPath $sBuilder -Value '# writer A newer copy' -NoNewline
Set-Content -LiteralPath (Join-Path $s '.harness-version') -Value '99.0.0'
$rS1 = Invoke-Init @('-Target', $s)
$ok = (Assert-True 'S1 newer stamp refuses with exit 1' ($rS1.Code -eq 1) "exit=$($rS1.Code) out=$($rS1.Out)") -and $ok
$ok = (Assert-True 'S1 both versions are named' ($rS1.Out -match 'v99\.0\.0' -and $rS1.Out -match 'NEWER') $rS1.Out) -and $ok
$ok = (Assert-True 'S1 the update remedy is named' ($rS1.Out -match '/ywr-harness:update') $rS1.Out) -and $ok
$ok = (Assert-True 'S1 nothing was placed over the newer copy' ((Get-Content -LiteralPath $sBuilder -Raw) -eq '# writer A newer copy') 'the refused run still overwrote a file') -and $ok
$ok = (Assert-True 'S1 the stamp itself is untouched by a refusal' (((Get-Content -LiteralPath (Join-Path $s '.harness-version') -Raw).Trim()) -eq '99.0.0') 'refusal rewrote the stamp') -and $ok
# S2: -Force is the deliberate-rollback path — proceeds, says so, reverts the file, re-stamps.
$rS2 = Invoke-Init @('-Target', $s, '-Force')
$ok = (Assert-True 'S2 -Force proceeds with exit 0' ($rS2.Code -eq 0) "exit=$($rS2.Code) out=$($rS2.Out)") -and $ok
$ok = (Assert-True 'S2 the forced downgrade is announced' ($rS2.Out -match 'DOWNGRADE FORCED') $rS2.Out) -and $ok
$ok = (Assert-True 'S2 the toolchain file is placed from canon' ((Get-Content -LiteralPath $sBuilder -Raw) -eq (Get-Content -LiteralPath (Join-Path $templates 'docs/build_docs.py') -Raw)) 'forced run did not place') -and $ok
$ok = (Assert-True 'S2 the stamp is rewritten to this plugin version' (((Get-Content -LiteralPath (Join-Path $s '.harness-version') -Raw).Trim()) -eq $manifestVer) "stamp=$((Get-Content -LiteralPath (Join-Path $s '.harness-version') -Raw).Trim())") -and $ok
# S3: an unparseable stamp must not strand the repo — proceed (fail-open direction: refusing on
# garbage could never destroy newer work, but it would dead-end every corrupted stamp forever),
# and the run rewrites it to a valid value.
$s3 = New-Target 'stamp-garbage'
$rS3a = Invoke-Init @('-Target', $s3)
Set-Content -LiteralPath (Join-Path $s3 '.harness-version') -Value 'not a version'
$rS3 = Invoke-Init @('-Target', $s3)
$ok = (Assert-True 'S3 garbage stamp proceeds' ($rS3.Code -eq 0) "exit=$($rS3.Code) out=$($rS3.Out)") -and $ok
$ok = (Assert-True 'S3 garbage stamp is rewritten to the plugin version' (((Get-Content -LiteralPath (Join-Path $s3 '.harness-version') -Raw).Trim()) -eq $manifestVer) 'stamp not repaired') -and $ok

# --- T: preserved-seed drift note (ADR 0051) — report only, never a merge ----------------------
# The measured blind spot this section pins (issue #44): a repo scaffolded at vN re-runs at vN+k
# and its preserved .harness.json / .gitattributes silently lack template-side additions
# (review.derived; the load-bearing `.githooks/* text eol=lf` line) that only a hand diff found.
$t = New-Target 'seed-drift'
$declT = Get-Content -LiteralPath (Join-Path $templates 'harness.json') -Raw | ConvertFrom-Json
$declT.review.PSObject.Properties.Remove('derived')
[IO.File]::WriteAllText((Join-Path $t '.harness.json'), ($declT | ConvertTo-Json -Depth 16))
[IO.File]::WriteAllText((Join-Path $t '.gitattributes'), "* text=auto eol=lf`n*.sh text eol=lf`n*.ps1 text eol=crlf`n")
# -DryRun first: the probe is read-only, so it must report identically with nothing written.
$rT = Invoke-Init @('-Target', $t, '-DryRun')
$ok = (Assert-True 'T1 missing declaration key is named (dry run — probe is read-only)' `
    ($rT.Out -match 'template has 1 key\(s\) this seed lacks: review\.derived') $rT.Out) -and $ok
$ok = (Assert-True 'T2 missing line is counted and exampled' `
    ($rT.Out -match "template has 1 line\(s\) this seed lacks, e\.g\. '\.githooks/\* text eol=lf'") $rT.Out) -and $ok
$rTr = Invoke-Init @('-Target', $t)
$ok = (Assert-True 'T3 the note rides the real run too, which still exits 0' `
    ($rTr.Code -eq 0 -and $rTr.Out -match 'review\.derived') "exit=$($rTr.Code) out=$($rTr.Out)") -and $ok
$ok = (Assert-True 'T3 the seeds themselves are untouched (report only)' `
    ((Get-Content -LiteralPath (Join-Path $t '.gitattributes') -Raw) -notmatch [regex]::Escape('.githooks/*')) 'the probe wrote into a seed') -and $ok

# T4: a template-complete seed carries NO note — including one with repo-only additions, which
# are normal (the declaration exists to accumulate repo-specific content, ADR 0051's scope is
# template-side additions only).
$t4 = New-Target 'seed-no-drift'
$declC = Get-Content -LiteralPath (Join-Path $templates 'harness.json') -Raw | ConvertFrom-Json
$declC | Add-Member -NotePropertyName 'repo_only_extra' -NotePropertyValue 'kept'
[IO.File]::WriteAllText((Join-Path $t4 '.harness.json'), ($declC | ConvertTo-Json -Depth 16))
Copy-Item -LiteralPath (Join-Path $templates 'gitattributes') -Destination (Join-Path $t4 '.gitattributes')
$rT4 = Invoke-Init @('-Target', $t4)
$ok = (Assert-True 'T4 complete seeds (with repo-only additions) carry no note' `
    ($rT4.Code -eq 0 -and $rT4.Out -notmatch 'this seed lacks') "exit=$($rT4.Code) out=$($rT4.Out)") -and $ok

# T5: an unparseable seed is a REPORTED probe skip — never fatal, never silent.
$t5 = New-Target 'seed-bad-json'
[IO.File]::WriteAllText((Join-Path $t5 '.harness.json'), '{ not json')
$rT5 = Invoke-Init @('-Target', $t5)
$ok = (Assert-True 'T5 unparseable seed: probe skip is reported, run exits 0' `
    ($rT5.Code -eq 0 -and $rT5.Out -match 'drift probe skipped') "exit=$($rT5.Code) out=$($rT5.Out)") -and $ok

# T6: an UNREADABLE line-based seed must not abort the run (review 2026-08-12, high): the probe's
# ReadAllBytes on a locked seed used to throw uncaught under the script-global EAP=Stop, turning a
# fully successful placement into a non-zero exit. Windows-gated: the exclusive-share lock that
# forces the read failure is mandatory there and advisory on POSIX (CI's windows-latest runs it).
if ($IsWindows) {
    $t6 = New-Target 'seed-locked'
    $t6ga = Join-Path $t6 '.gitattributes'
    [IO.File]::WriteAllText($t6ga, "* text=auto eol=lf`n")
    $lock = [IO.File]::Open($t6ga, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { $rT6 = Invoke-Init @('-Target', $t6) } finally { $lock.Dispose() }
    $ok = (Assert-True 'T6 a locked line-based seed is a reported probe skip, run exits 0' `
        ($rT6.Code -eq 0 -and $rT6.Out -match 'drift probe skipped: seed or template could not be read') "exit=$($rT6.Code) out=$($rT6.Out)") -and $ok
    $ok = (Assert-True 'T6 the run still completes its tail reports (stamp line present)' `
        ($rT6.Out -match 'stamp: ') $rT6.Out) -and $ok
} else {
    Write-Host 'SKIP [T6 locked seed] POSIX — FileShare.None is advisory there; windows-latest CI runs this case' -ForegroundColor Yellow
}

# T7: the root .gitignore joins the line-based drift probe (ADR 0053) — an existing ignore
# missing template lines gets the count + first example, and is never merged into.
$t7 = New-Target 'seed-gitignore-drift'
$t7gi = "docs/docs.html`n"
[IO.File]::WriteAllText((Join-Path $t7 '.gitignore'), $t7gi)
$rT7 = Invoke-Init @('-Target', $t7)
$ok = (Assert-True 'T7 gitignore drift note names count + first missing line' `
    ($rT7.Out -match "= \.gitignore \(existing seed preserved — template has \d+ line\(s\) this seed lacks, e\.g\. 'docs/docs\.artifact\.html'") $rT7.Out) -and $ok
$ok = (Assert-True 'T7 the seed itself is untouched (report only)' `
    ((Get-Content -LiteralPath (Join-Path $t7 '.gitignore') -Raw) -eq $t7gi) 'the probe wrote into .gitignore') -and $ok

# --- U: first-run TOOLCHAIN collision refuses (ADR 0055, issue #50) ----------------------------
# The measured brownfield loss: a repo's own docs/README.md silently replaced and labeled
# "toolchain refreshed from canon" on the FIRST run. No stamp file = first run; a differing file
# at a toolchain path is then refused, the stamp is withheld (else the next run re-runs with
# overwrite semantics and the guard defeats itself), and -Force is the deliberate replacement.
$u = New-Target 'first-run-collision'
New-Item -ItemType Directory -Force -Path (Join-Path $u 'docs') | Out-Null
$ownDocs = "# my own docs index — not the canon's`n"
Set-Content -LiteralPath (Join-Path $u 'docs/README.md') -Value $ownDocs -NoNewline
$rU1 = Invoke-Init @('-Target', $u)
$ok = (Assert-True 'U1 first-run collision refuses, run exits 0' `
    ($rU1.Code -eq 0 -and $rU1.Out -match 'docs/README\.md REFUSED — first run found an existing file at this TOOLCHAIN path') "exit=$($rU1.Code) out=$($rU1.Out)") -and $ok
$ok = (Assert-True 'U1 the colliding file survives byte-identical' `
    ((Get-Content -LiteralPath (Join-Path $u 'docs/README.md') -Raw) -eq $ownDocs) 'first run overwrote a pre-existing file') -and $ok
$ok = (Assert-True 'U1 refusal is counted' ($rU1.Out -match 'refused=1') $rU1.Out) -and $ok
$ok = (Assert-True 'U1 the stamp is withheld while refusals stand' `
    ((-not (Test-Path -LiteralPath (Join-Path $u '.harness-version') -PathType Leaf)) -and $rU1.Out -match 'stamp: NOT written') $rU1.Out) -and $ok
$ok = (Assert-True 'U1 never labeled as a canon refresh' ($rU1.Out -notmatch 'docs/README\.md \(toolchain refreshed') $rU1.Out) -and $ok
# "First run" is inferred from the stamp's absence, and a scaffolded repo can lose its stamp —
# the refusal must state the inference and the stamp-lost remedy, never assert the file's origin
# as fact (review 2026-08-17, medium).
$ok = (Assert-True 'U1 the refusal states the inference and the stamp-lost remedy' `
    ($rU1.Out -match 'Nothing marks it as this scaffold' -and $rU1.Out -match 'only the stamp is missing') $rU1.Out) -and $ok
# U2: the protection is not one-shot — with the stamp withheld, a re-run is STILL a first run.
$rU2 = Invoke-Init @('-Target', $u)
$ok = (Assert-True 'U2 re-run still refuses (stamp was withheld, so still a first run)' `
    ($rU2.Out -match 'REFUSED — first run' -and -not (Test-Path -LiteralPath (Join-Path $u '.harness-version') -PathType Leaf)) $rU2.Out) -and $ok
# U3: -DryRun shows the same refusal (the SKILL.md brownfield advice depends on this).
$rU3 = Invoke-Init @('-Target', $u, '-DryRun')
$ok = (Assert-True 'U3 dry run shows the refusal too' ($rU3.Out -match 'REFUSED — first run') $rU3.Out) -and $ok
# U4: -Force replaces, labeled truthfully (never "refreshed"), and the run then stamps.
$rU4 = Invoke-Init @('-Target', $u, '-Force')
$ok = (Assert-True 'U4 -Force replaces with the truthful label' `
    ($rU4.Code -eq 0 -and $rU4.Out -match 'docs/README\.md \(REPLACED a pre-existing non-canon file under -Force' -and $rU4.Out -match 'replaced=1') "exit=$($rU4.Code) out=$($rU4.Out)") -and $ok
$ok = (Assert-True 'U4 the canon copy is placed' `
    ((Get-Content -LiteralPath (Join-Path $u 'docs/README.md') -Raw) -eq (Get-Content -LiteralPath (Join-Path $templates 'docs/README.md') -Raw)) 'forced run did not place the canon copy') -and $ok
$ok = (Assert-True 'U4 the stamp is written once resolved' `
    ((Test-Path -LiteralPath (Join-Path $u '.harness-version') -PathType Leaf) -and (((Get-Content -LiteralPath (Join-Path $u '.harness-version') -Raw).Trim()) -eq $manifestVer)) $rU4.Out) -and $ok
# U5: identical content at a toolchain path is a silent no-op, never a refusal — a repo that
# hand-copied a canon file must not be told to merge with itself.
$u5 = New-Target 'first-run-identical'
New-Item -ItemType Directory -Force -Path (Join-Path $u5 'docs') | Out-Null
Copy-Item -LiteralPath (Join-Path $templates 'docs/README.md') -Destination (Join-Path $u5 'docs/README.md')
$rU5 = Invoke-Init @('-Target', $u5)
$ok = (Assert-True 'U5 identical-content collision is a no-op, not a refusal; run stamps' `
    ($rU5.Code -eq 0 -and $rU5.Out -notmatch 'REFUSED — first run' -and (Test-Path -LiteralPath (Join-Path $u5 '.harness-version') -PathType Leaf)) "exit=$($rU5.Code) out=$($rU5.Out)") -and $ok
# U6: a REFUSED hook keeps its mode — "left byte-identical" includes the executable bit. The
# chmod block must never grant +x to a first-run-refused hook (or a marker-less post-commit):
# that would turn a preserved foreign script into a live hook once wired (review 2026-08-17,
# high). POSIX-gated: the mode bit does not exist on Windows; CI ubuntu measures this.
if ($IsWindows) {
    Write-Host 'SKIP [U6 refused-hook mode] Windows — no POSIX mode bit; CI ubuntu runs this case' -ForegroundColor Yellow
} else {
    $u6 = New-Target 'first-run-foreign-hook-mode'
    New-Item -ItemType Directory -Force -Path (Join-Path $u6 '.githooks') | Out-Null
    Set-Content -LiteralPath (Join-Path $u6 '.githooks/pre-commit') -Value "#!/bin/sh`n# my experiment, deliberately not executable`n" -NoNewline
    Set-Content -LiteralPath (Join-Path $u6 '.githooks/post-commit') -Value "#!/bin/sh`n# my own post-commit, no marker`n" -NoNewline
    $rU6 = Invoke-Init @('-Target', $u6)
    $execRefused = @('.githooks/pre-commit', '.githooks/post-commit') | Where-Object {
        ([IO.File]::GetUnixFileMode((Join-Path $u6 $_)) -band [IO.UnixFileMode]::UserExecute) -ne 0
    }
    $ok = (Assert-True 'U6 refused hooks stay non-executable' ($execRefused.Count -eq 0) "chmod +x landed on: $($execRefused -join ', ') out=$($rU6.Out)") -and $ok
    $ok = (Assert-True 'U6 a hook this run PLACED is still made executable' `
        (([IO.File]::GetUnixFileMode((Join-Path $u6 '.githooks/pre-push')) -band [IO.UnixFileMode]::UserExecute) -ne 0) $rU6.Out) -and $ok
}

# --- V: the install→init E2E the #47/#48 issues measured — a fresh scaffold must pass its OWN
# full-tree audit (ADR 0041) after the first commit, html surfaces and ledger ignored (ADR 0052/
# 0053), review canon present (ADR 0054), and the growth loop (a new ADR) must stay claimed.
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'SKIP [V audit] git absent (reported, not silent) — CI has git' -ForegroundColor Yellow
} elseif (-not $pyAvail) {
    Write-Host 'SKIP [V audit] python absent (reported, not silent) — CI has python' -ForegroundColor Yellow
} else {
    $v = New-GitTarget 'audit-clean'
    Set-Content -LiteralPath (Join-Path $v 'README.md') -Value "# fixture repo`n" -NoNewline
    $rV0 = Invoke-Init @('-Target', $v)
    $ok = (Assert-True 'V scaffold run exits 0' ($rV0.Code -eq 0) "exit=$($rV0.Code) out=$($rV0.Out)") -and $ok
    # The first commit exactly as SKILL.md instructs (`git add -A` + commit). The placed hooks
    # are bypassed via a nonexistent hooksPath: their behavior is githooks.selftest.ps1's job,
    # and this case must measure the audit, not the hooks.
    & git -C $v add -A 2>$null | Out-Null
    & git -C $v -c core.hooksPath=.git/no-hooks commit -q -m 'scaffold' 2>$null | Out-Null
    $tracked = @(& git -C $v ls-files 2>$null)
    $ok = (Assert-True 'V regenerable html surfaces stayed out of the first commit (ADR 0053)' `
        (-not ($tracked -match 'docs/docs\.html|docs/docs\.artifact\.html')) "tracked: $($tracked -join ', ')") -and $ok
    $ok = (Assert-True 'V committed outputs ARE tracked (index.json + INDEX.md)' `
        (($tracked -contains 'docs/index.json') -and ($tracked -contains 'docs/INDEX.md')) "tracked: $($tracked -join ', ')") -and $ok
    & git -C $v check-ignore -q .claude/telemetry/subagent-stops.jsonl 2>$null
    $ok = (Assert-True 'V telemetry ledger path is ignored before it exists (audit M3)' ($LASTEXITCODE -eq 0) 'check-ignore says not ignored') -and $ok
    $pyCmd = @('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
    $rV1 = & $pyCmd.Source (Join-Path $v 'scripts/harness/harness_gates.py') --all --repo $v 2>&1 | Out-String
    $ok = (Assert-True 'V full-tree audit reports ZERO ungrouped (the #47 red first push)' ($rV1 -notmatch 'ungrouped \(') $rV1) -and $ok
    $ok = (Assert-True 'V review canon is FOUND (the #49 first-close hard stop)' ($rV1 -notmatch 'NOT FOUND') $rV1) -and $ok
    # The growth loop: After-running step 3 writes an ADR — the measured "each decision makes
    # the audit redder" half of #47.
    Set-Content -LiteralPath (Join-Path $v 'docs/adr/0002-first-decision.md') -Value "---`nid: `"0002`"`n---`n# 0002. first`n" -NoNewline
    $rV2 = & $pyCmd.Source (Join-Path $v 'scripts/harness/harness_gates.py') --all --repo $v 2>&1 | Out-String
    $ok = (Assert-True 'V a newly written ADR stays claimed (docs-corpus group)' ($rV2 -notmatch 'ungrouped \(') $rV2) -and $ok
}

# --- W: CI push-trigger warning (ADR 0062, issue #55) -------------------------------------------
# The vendored workflow enumerates `branches: [main, master]`; a repo whose default branch is
# outside that list never gets a push run and GitHub never registers the workflow. The scaffold is
# the only step that knows the repo, so it warns — and stays quiet when the branch is in the list
# or origin/HEAD is unset (the current branch is a guess, not a default-branch signal).
if (Get-Command git -ErrorAction SilentlyContinue) {
    $w1 = New-GitTarget 'ci-trigger-develop'
    & git -C $w1 symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop 2>$null
    $rW1 = Invoke-Init @('-Target', $w1)
    $ok = (Assert-True "W1 a default branch outside [main, master] is warned about" ($rW1.Out -match "ci trigger: default branch 'develop' is NOT in") $rW1.Out) -and $ok
    $ok = (Assert-True 'W1 the warning does not fail the run' ($rW1.Code -eq 0) "exit=$($rW1.Code)") -and $ok
    $w2 = New-GitTarget 'ci-trigger-master'
    & git -C $w2 symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master 2>$null
    $rW2 = Invoke-Init @('-Target', $w2)
    $ok = (Assert-True 'W2 a default branch IN the list prints no ci trigger line' ($rW2.Out -notmatch 'ci trigger:') $rW2.Out) -and $ok
    # K's fixture is a remote-less repo: origin/HEAD unset -> quiet, never a guess from HEAD.
    $ok = (Assert-True 'W3 unset origin/HEAD prints no ci trigger line' ($rK.Out -notmatch 'ci trigger:') $rK.Out) -and $ok
}

# --- P: a non-git target places the hooks and says they will not run ---------------------------
# The fixture targets in A-J are plain directories, so this is the branch they all exercised
# implicitly. Asserted explicitly so "placed but inert" can never become silent.
$ok = (Assert-True 'P non-git target reports the hooks are not wired' ($rA.Out -match 'hooks: .*(not a git repository|NOT set)') $rA.Out) -and $ok

Remove-FixtureRoot $fxBase

if (-not $ok) { Write-Host 'harness-init selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'harness-init selftest: all cases green' -ForegroundColor Green
exit 0
