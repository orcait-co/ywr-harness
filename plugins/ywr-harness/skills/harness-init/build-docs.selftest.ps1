# Selftest for templates/docs/build_docs.py — the duplicate-id refusal and the fm_digest
# staleness stamp (ADR 0043), including the PAIRING with scripts/verify_map.py's recomputation.
#
# Runs the TEMPLATE copy (payload this plugin ships; byte identity with the canon's
# docs/build_docs.py is enforced by manifest-gate's dogfood placement sweep), copied into a
# fixture docs tree — the builder resolves its corpus relative to its own file, so it must sit
# at <fixture>/docs/build_docs.py. No git needed anywhere: verify_map is driven with --repo and
# explicit files, which skips scope resolution entirely.
#
# The two subtle cases are D (a BODY-only edit must NOT flip the digest — the same cry-wolf
# class the retro's BUILD check learned expensively; its D2 case is the precedent) and the
# lead-HTML-comment document in the base corpus, which pins that BOTH digest implementations
# skip the comment identically. E is the pairing case proper: build with one implementation,
# check with the other — drift in either side fails it.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot '../../lib/selftest-lib.ps1')

$builderTemplate = Join-Path $PSScriptRoot 'templates/docs/build_docs.py'
$verifyMap = Join-Path $PSScriptRoot '../../scripts/verify_map.py'

$py = @('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if (-not $py) {
    if ($env:CI) { Write-Host 'FAIL — python absent on CI; a missing interpreter is not a pass' -ForegroundColor Red; exit 1 }
    Write-Host 'SKIP [build-docs] python absent (reported, not silent) — CI runs this gate' -ForegroundColor Yellow
    exit 0
}

# The builder deliberately does NOT self-pin its stdout encoding — the build WRAPPERS own that
# (CLAUDE.md: `harness_config.pin_utf8()` and the wrappers own it; no second copy in the
# builder). This selftest bypasses the wrapper and invokes python directly, so it owns the pin
# exactly as build.ps1 does: on a cp1252 runner console the builder's Korean output otherwise
# dies with UnicodeEncodeError AFTER writing index.json — fact-4's shape, caught by this
# suite's FIRST windows-latest CI run (PR #35); a local cp949 console can encode Korean, which
# is why the same suite was green here. Process-scoped only: the runner spawns each selftest
# in its own pwsh process, so nothing needs restoring.
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

$fx = New-FixtureRoot 'build-docs-selftest'
trap { Remove-FixtureRoot $fx; break }

$repo = Join-Path $fx 'repo'
$docs = Join-Path $repo 'docs'
New-Item -ItemType Directory -Force -Path (Join-Path $docs 'adr'), (Join-Path $docs 'spec') | Out-Null
Copy-Item -LiteralPath $builderTemplate -Destination (Join-Path $docs 'build_docs.py')

function Write-Doc([string]$Rel, [string]$Body) {
    [IO.File]::WriteAllText((Join-Path $docs $Rel), ($Body -replace "`r`n", "`n"))
}
function Invoke-Build {
    $out = & $py.Source (Join-Path $docs 'build_docs.py') 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}
function Invoke-Map {
    $out = & $py.Source $verifyMap --repo $repo 'x.py' 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}

# Base corpus. 0001 carries a lead HTML comment BEFORE the frontmatter — the onboarding shape
# split_frontmatter explicitly tolerates, and the edge where the two digest implementations
# could diverge without a pin.
Write-Doc 'adr/0001-first.md' "<!-- template note kept above the frontmatter -->`n---`nid: `"0001`"`ntype: adr`ntitle: `"first`"`nstatus: accepted`n---`n# 0001`nbody v1`n"
Write-Doc 'adr/0002-second.md' "---`nid: `"0002`"`ntype: adr`ntitle: `"second`"`nstatus: proposed`n---`n# 0002`nbody`n"
Write-Doc 'spec/0001-spec.md' "---`nid: `"0001`"`ntype: spec`ntitle: `"s1`"`nstatus: active`nimplements_in: [`"src/app.py`"]`n---`n# spec 0001`n"

$ok = $true

# --- A: a clean corpus builds; the same id across KINDS is legal (adr:/spec: namespaces) ------
$rA = Invoke-Build
$ok = (Assert-True 'A clean build exits 0 (adr 0001 + spec 0001 coexist)' ($rA.Code -eq 0) "exit=$($rA.Code): $($rA.Out)") -and $ok
$idx = Join-Path $docs 'index.json'
$json = $null
try { $json = Get-Content -LiteralPath $idx -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
$ok = (Assert-True 'A index.json parses and counts match' ($json -and $json.counts.adr -eq 2 -and $json.counts.spec -eq 1) $rA.Out) -and $ok
$ok = (Assert-True 'A fm_digest is stamped (64 hex)' ($json -and $json.fm_digest -match '^[0-9a-f]{64}$') "fm_digest='$($json.fm_digest)'") -and $ok

# --- B: a duplicate id WITHIN a kind refuses to build, naming both files (ADR 0043) ----------
Write-Doc 'adr/0002-rival.md' "---`nid: `"0002`"`ntype: adr`ntitle: `"rival from a parallel branch`"`nstatus: proposed`n---`n# 0002 again`n"
$rB = Invoke-Build
$ok = (Assert-True 'B duplicate adr id exits non-zero' ($rB.Code -ne 0) "exit=$($rB.Code): $($rB.Out)") -and $ok
$ok = (Assert-True 'B the refusal names BOTH files' ($rB.Out -match '0002-second\.md' -and $rB.Out -match '0002-rival\.md') $rB.Out) -and $ok
Remove-Item (Join-Path $docs 'adr/0002-rival.md')

# --- B2: an unreadable "document" (a DIRECTORY whose name matches the doc pattern) is a
# deterministic NAMED refusal, not a traceback — same principle as the duplicate-id refusal
# (review 2026-08-10, low). Portable: open() on a directory raises an OSError subclass on both
# Windows (PermissionError) and Linux (IsADirectoryError).
New-Item -ItemType Directory -Force -Path (Join-Path $docs 'adr/0003-actually-a-dir.md') | Out-Null
$rB2 = Invoke-Build
$ok = (Assert-True 'B2 an unreadable doc is a named refusal, not a traceback' `
    ($rB2.Code -ne 0 -and $rB2.Out -match '0003-actually-a-dir\.md' -and $rB2.Out -notmatch 'Traceback') $rB2.Out) -and $ok
Remove-Item (Join-Path $docs 'adr/0003-actually-a-dir.md') -Recurse -Force

# --- C: rebuild clean, then the pairing — verify_map recomputes the SAME digest ---------------
$rC = Invoke-Build
$ok = (Assert-True 'C corpus builds clean again' ($rC.Code -eq 0) $rC.Out) -and $ok
$rMap = Invoke-Map
$ok = (Assert-True 'C verify_map sees a current index (no STALE, no missing-stamp note)' `
    ($rMap.Code -eq 0 -and $rMap.Out -notmatch 'index: STALE' -and $rMap.Out -notmatch 'no staleness stamp') $rMap.Out) -and $ok

# --- D: a BODY-only edit must NOT read as stale — the cry-wolf pin (retro D2's principle) -----
Write-Doc 'adr/0001-first.md' "<!-- template note kept above the frontmatter -->`n---`nid: `"0001`"`ntype: adr`ntitle: `"first`"`nstatus: accepted`n---`n# 0001`nbody v1`n`n## Addendum`nappend-only correction, frontmatter untouched`n"
$rD = Invoke-Map
$ok = (Assert-True 'D a body-only edit does NOT flip the digest' ($rD.Out -notmatch 'index: STALE') $rD.Out) -and $ok

# --- E: a FRONTMATTER edit reads as stale until rebuilt, then clears ---------------------------
Write-Doc 'adr/0002-second.md' "---`nid: `"0002`"`ntype: adr`ntitle: `"second`"`nstatus: accepted`n---`n# 0002`nbody`n"
$rE = Invoke-Map
$ok = (Assert-True 'E a frontmatter edit reads as STALE' ($rE.Out -match 'index: STALE') $rE.Out) -and $ok
$ok = (Assert-True 'E the stale line names the rebuild command' ($rE.Out -match 'docs/build\.ps1') $rE.Out) -and $ok
$null = Invoke-Build
$rE2 = Invoke-Map
$ok = (Assert-True 'E2 rebuilding clears the stale signal' ($rE2.Out -notmatch 'index: STALE') $rE2.Out) -and $ok

# --- F: a stamp-less index (pre-0043 builder) is reported, never silent ------------------------
$raw = Get-Content -LiteralPath $idx -Raw -Encoding UTF8 | ConvertFrom-Json
$raw.PSObject.Properties.Remove('fm_digest')
[IO.File]::WriteAllText($idx, ($raw | ConvertTo-Json -Depth 16))
$rF = Invoke-Map
$ok = (Assert-True 'F a missing stamp is reported (not silent, not STALE)' `
    ($rF.Out -match 'no staleness stamp' -and $rF.Out -notmatch 'index: STALE') $rF.Out) -and $ok

# --- G: a relocated corpus (customized docs.index) — the digest must track the DECLARED index's
# siblings, never a hardcoded docs/ (review 2026-08-10, high: the hardcoding was a permanent
# false-STALE for exactly this supported configuration, and the default-layout cases above can
# never catch it).
$repo2 = Join-Path $fx 'repo-moved'
$docs2 = Join-Path $repo2 'platform-docs'
New-Item -ItemType Directory -Force -Path (Join-Path $docs2 'adr'), (Join-Path $docs2 'spec') | Out-Null
Copy-Item -LiteralPath $builderTemplate -Destination (Join-Path $docs2 'build_docs.py')
[IO.File]::WriteAllText((Join-Path $repo2 '.harness.json'), '{ "docs": { "index": "platform-docs/index.json" } }')
[IO.File]::WriteAllText((Join-Path $docs2 'adr/0001-a.md'), "---`nid: `"0001`"`ntype: adr`ntitle: `"a`"`nstatus: accepted`n---`n# 0001`n")
$rG = & $py.Source (Join-Path $docs2 'build_docs.py') 2>&1 | Out-String
$gOk = $LASTEXITCODE -eq 0
$rGmap = & $py.Source $verifyMap --repo $repo2 'x.py' 2>&1 | Out-String
$ok = (Assert-True 'G a relocated corpus builds and reads as current (no false STALE)' `
    ($gOk -and $rGmap -notmatch 'index: STALE' -and $rGmap -notmatch 'no staleness stamp') "build: $rG`nmap: $rGmap") -and $ok
[IO.File]::WriteAllText((Join-Path $docs2 'adr/0001-a.md'), "---`nid: `"0001`"`ntype: adr`ntitle: `"a`"`nstatus: superseded`n---`n# 0001`n")
$rG2 = & $py.Source $verifyMap --repo $repo2 'x.py' 2>&1 | Out-String
$ok = (Assert-True 'G2 the relocated corpus still yields a real signal on a frontmatter edit' ($rG2 -match 'index: STALE') $rG2) -and $ok

Remove-FixtureRoot $fx

if (-not $ok) { Write-Host 'build-docs selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'build-docs selftest: all cases green' -ForegroundColor Green
exit 0
