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
$harnessConfigSrc = Join-Path $PSScriptRoot '../../scripts/harness_config.py'

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

# --- H: site title resolution (ADR 0050) — the declaration is the source, env a one-off override
# The revert this pins (issue #43): env-only sourcing meant any caller that did not set
# DOCS_SITE_TITLE — harness-init re-runs, CI — rebuilt committed surfaces back to the default
# title. Cases A–F double as the no-declaration control: their fixture has no .harness.json
# anywhere up the temp tree, and their builds carry the default title.
$repo3 = Join-Path $fx 'repo-title'
$docs3 = Join-Path $repo3 'docs'
New-Item -ItemType Directory -Force -Path (Join-Path $docs3 'adr'), (Join-Path $docs3 'spec') | Out-Null
Copy-Item -LiteralPath $builderTemplate -Destination (Join-Path $docs3 'build_docs.py')
[IO.File]::WriteAllText((Join-Path $docs3 'adr/0001-a.md'), "---`nid: `"0001`"`ntype: adr`ntitle: `"a`"`nstatus: accepted`n---`n# 0001`n")
function Invoke-TitleBuild {
    $out = & $py.Source (Join-Path $docs3 'build_docs.py') 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}

[IO.File]::WriteAllText((Join-Path $repo3 '.harness.json'), '{ "docs": { "site_title": "myrepo - internal docs" } }')
$rH = Invoke-TitleBuild
$h1 = [IO.File]::ReadAllText((Join-Path $docs3 'docs.html'))
$h1a = [IO.File]::ReadAllText((Join-Path $docs3 'docs.artifact.html'))
$ok = (Assert-True 'H a declared docs.site_title lands in BOTH generated <title>s (no env var set)' `
    ($rH.Code -eq 0 -and $h1 -match '<title>myrepo - internal docs</title>' -and $h1a -match '<title>myrepo - internal docs</title>') "exit=$($rH.Code): $($rH.Out)") -and $ok

# H2: the env var still wins when explicitly set — it is an override, not the source.
$env:DOCS_SITE_TITLE = 'one-off override'
try { $rH2 = Invoke-TitleBuild } finally { Remove-Item Env:DOCS_SITE_TITLE -ErrorAction SilentlyContinue }
$h2 = [IO.File]::ReadAllText((Join-Path $docs3 'docs.html'))
$ok = (Assert-True 'H2 DOCS_SITE_TITLE overrides the declaration when set' `
    ($rH2.Code -eq 0 -and $h2 -match '<title>one-off override</title>') "exit=$($rH2.Code): $($rH2.Out)") -and $ok

# H3: a declaration WITHOUT site_title (or empty) falls back to the default title.
[IO.File]::WriteAllText((Join-Path $repo3 '.harness.json'), '{ "docs": { "index": "docs/index.json", "site_title": "" } }')
$rH3 = Invoke-TitleBuild
$h3 = [IO.File]::ReadAllText((Join-Path $docs3 'docs.html'))
$ok = (Assert-True 'H3 an empty site_title falls back to the default' `
    ($rH3.Code -eq 0 -and $h3 -match '<title>Docs · ADR &amp; Spec</title>') "exit=$($rH3.Code): $($rH3.Out)") -and $ok

# H4: an unreadable declaration is a REPORTED fallback, never silent and never fatal — a silent
# revert is the exact defect the resolution order exists to remove.
[IO.File]::WriteAllText((Join-Path $repo3 '.harness.json'), '{ not json')
$rH4 = Invoke-TitleBuild
$h4 = [IO.File]::ReadAllText((Join-Path $docs3 'docs.html'))
$ok = (Assert-True 'H4 a malformed declaration warns, builds, and uses the default title' `
    ($rH4.Code -eq 0 -and $rH4.Out -match 'unreadable' -and $h4 -match '<title>Docs · ADR &amp; Spec</title>') "exit=$($rH4.Code): $($rH4.Out)") -and $ok

# H5: the upward walk stops at a repo boundary (review 2026-08-12, medium): a repo WITHOUT a
# declaration must not silently adopt an unrelated ancestor's .harness.json title — a directory
# carrying .git and no declaration ends the walk at the default.
$outer = Join-Path $fx 'outer-tree'
$inner = Join-Path $outer 'repo\docs'
New-Item -ItemType Directory -Force -Path (Join-Path $inner 'adr'), (Join-Path $inner 'spec'), (Join-Path $outer 'repo\.git') | Out-Null
[IO.File]::WriteAllText((Join-Path $outer '.harness.json'), '{ "docs": { "site_title": "ancestor title MUST NOT leak" } }')
Copy-Item -LiteralPath $builderTemplate -Destination (Join-Path $inner 'build_docs.py')
[IO.File]::WriteAllText((Join-Path $inner 'adr/0001-a.md'), "---`nid: `"0001`"`ntype: adr`ntitle: `"a`"`nstatus: accepted`n---`n# 0001`n")
& $py.Source (Join-Path $inner 'build_docs.py') 2>&1 | Out-Null
$h5 = [IO.File]::ReadAllText((Join-Path $inner 'docs.html'))
$ok = (Assert-True 'H5 a .git boundary without a declaration stops the walk at the default' `
    ($h5 -match '<title>Docs · ADR &amp; Spec</title>' -and $h5 -notmatch 'ancestor title') $h5.Substring(0, 300)) -and $ok
# H5b control: the SAME tree minus the .git marker is a plain nested docs tree, where walking to
# the ancestor declaration is the intended behavior (relocated-corpus class, case G) — this pins
# that H5 measures the boundary, not a broken walk.
Remove-Item -Recurse -Force (Join-Path $outer 'repo\.git')
& $py.Source (Join-Path $inner 'build_docs.py') 2>&1 | Out-Null
$h5b = [IO.File]::ReadAllText((Join-Path $inner 'docs.html'))
$ok = (Assert-True 'H5b without the boundary the ancestor declaration is honored (walk intact)' `
    ($h5b -match 'ancestor title MUST NOT leak') $h5b.Substring(0, 300)) -and $ok

# --- I: the customer-corpus surface (ADR 0060) --------------------------------------------
# Fixture: a repo with the two-program pjems-shaped corpus + a copy of the vendored
# harness_config.py the builder imports. "xgglbsrp" carries a menu (25.x, groups to the
# declared 25.x label) and 3 release entries — two same-date [UAT] (dedupe + tie-break) and
# one older [FUT]; "batchjob" carries NO menu (falls to unkeyed_label) and one [PROD] entry
# (posture 완료, and a recency-group member since it still has release history).
$repoI = Join-Path $fx 'repo-customer'
$docsI = Join-Path $repoI 'docs'
$custI = Join-Path $docsI 'customer'
New-Item -ItemType Directory -Force -Path (Join-Path $docsI 'adr'), (Join-Path $docsI 'spec'), `
    (Join-Path $custI 'xgglbsrp'), (Join-Path $custI 'batchjob'), `
    (Join-Path $repoI 'scripts/harness') | Out-Null
Copy-Item -LiteralPath $builderTemplate -Destination (Join-Path $docsI 'build_docs.py')
Copy-Item -LiteralPath $harnessConfigSrc -Destination (Join-Path $repoI 'scripts/harness/harness_config.py')

function Write-IDoc([string]$Rel, [string]$Body) {
    [IO.File]::WriteAllText((Join-Path $docsI $Rel), ($Body -replace "`r`n", "`n"))
}
function Invoke-IBuild {
    $out = & $py.Source (Join-Path $docsI 'build_docs.py') 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}

Write-IDoc 'adr/0001-a.md' "---`nid: `"0001`"`ntype: adr`ntitle: `"fixture adr`"`nstatus: accepted`n---`n# 0001`nbody`n"
# A single-quoted here-string, not a backtick-escaped double-quoted line: the fence markers
# below are literal ``` sequences, and PowerShell's backtick escape character would otherwise
# collapse them (measured — a double-quoted "```diff" reduced to a single backtick, which
# convert_body then read as an inline code span spanning the whole paragraph instead of a fence).
$spec0001 = @'
---
id: "0001"
type: spec
title: "fixture spec"
status: active
---
# spec 0001
- item one
  continued on a hard-wrapped line
- item two
Plain paragraph right after the list without a blank line

- item three
| c | d |
|---|---|
| 3 | 4 |

- item four
## Heading right after a list

| a | b |
|---|---|
| 1 | 2 |

```diff
+added line
-removed line
```
'@
Write-IDoc 'spec/0001-s.md' $spec0001

Write-IDoc 'customer/xgglbsrp/spec.md' "---`nprogram: xgglbsrp`ntitle: `"xgglbsrp spec`"`nupdated: 2026-08-20`nprogram_file: xgglbsrp`nmenu: `"25.15.1`"`nproject: P1`n---`n# spec`nBody.`n"
Write-IDoc 'customer/xgglbsrp/user-guide.md' "---`nprogram: xgglbsrp`ntitle: `"xgglbsrp guide`"`nupdated: 2026-08-20`n---`n# guide`nBody.`n"
Write-IDoc 'customer/xgglbsrp/release-notes.md' "---`nprogram: xgglbsrp`ntitle: `"xgglbsrp release notes`"`nupdated: 2026-08-20`n---`n## 2026-08-20 — Entry C [UAT]`n`nBody C.`n`n## 2026-08-20 — Entry B [UAT]`n`nBody B.`n`n## 2026-08-15 — Entry A [FUT]`n`nBody A.`n"

Write-IDoc 'customer/batchjob/spec.md' "---`nprogram: batchjob`ntitle: `"batchjob spec`"`nupdated: 2026-08-10`nprogram_file: batchjob`n---`n# spec`nBody.`n"
Write-IDoc 'customer/batchjob/user-guide.md' "---`nprogram: batchjob`ntitle: `"batchjob guide`"`nupdated: 2026-08-10`n---`n# guide`nBody.`n"
Write-IDoc 'customer/batchjob/release-notes.md' "---`nprogram: batchjob`ntitle: `"batchjob release notes`"`nupdated: 2026-08-10`n---`n## 2026-08-10 — Batch fix [PROD]`n`nBody.`n"

$declFull = @'
{
  "docs": {
    "customer": {
      "dir": "docs/customer",
      "title": "Fixture Repo · 고객 문서 — 테스트",
      "eyebrow": "테스트 고객 문서",
      "description": "테스트용 설명",
      "contact": "테스트 문의처",
      "chip_field": "program_file",
      "chip_suffix": ".p",
      "groups": [{ "label": "재무회계 (25.x)", "keys": [25] }],
      "other_label": "기타 메뉴",
      "unkeyed_label": "배치·인터페이스·자동화",
      "projects_md": true
    }
  }
}
'@
[IO.File]::WriteAllText((Join-Path $repoI '.harness.json'), $declFull)

$custHtml = Join-Path $docsI 'customer.artifact.html'
$projMd = Join-Path $docsI 'PROJECTS.md'

# I1: declared -> exit 0, both new surfaces exist, the 4 internal surfaces still written.
if (Test-Path $custHtml) { Remove-Item $custHtml }
if (Test-Path $projMd) { Remove-Item $projMd }
$rI1 = Invoke-IBuild
$ok = (Assert-True 'I1 declared customer surface builds clean' ($rI1.Code -eq 0) $rI1.Out) -and $ok
$ok = (Assert-True 'I1 customer.artifact.html written' (Test-Path $custHtml) $rI1.Out) -and $ok
$ok = (Assert-True 'I1 PROJECTS.md written (projects_md: true)' (Test-Path $projMd) $rI1.Out) -and $ok
$ok = (Assert-True 'I1 the 4 internal surfaces are still written' `
    ((Test-Path (Join-Path $docsI 'index.json')) -and (Test-Path (Join-Path $docsI 'docs.html')) `
     -and (Test-Path (Join-Path $docsI 'docs.artifact.html'))) $rI1.Out) -and $ok

$custText = Get-Content -LiteralPath $custHtml -Raw -Encoding UTF8

# I2: sidebar — recency group first, the declared 25.x group label present, batchjob under
# the unkeyed label (its own pgroup section names it and contains its progitem).
$idxRecent = $custText.IndexOf('최근 업데이트')
$idx25 = $custText.IndexOf('재무회계 (25.x)')
$idxUnkeyed = $custText.IndexOf('배치·인터페이스·자동화')
$ok = (Assert-True 'I2 recency group label present before the declared 25.x group' `
    ($idxRecent -ge 0 -and $idx25 -ge 0 -and $idxRecent -lt $idx25) `
    "recent=$idxRecent 25.x=$idx25") -and $ok
$unkeyedSection = [regex]::Match($custText, '배치·인터페이스·자동화[\s\S]*?</section>').Value
$ok = (Assert-True 'I2 batchjob sits under the unkeyed_label group' `
    ($unkeyedSection -and $unkeyedSection -match 'data-prog="batchjob"') $unkeyedSection) -and $ok

# I3: the HTML chip renders the BARE <chip_field value> — `chip_suffix` belongs to PROJECTS.md's
# file-form listing only (I5). Measured on the pjems corpus 2026-08-27: applying the suffix to the
# HTML chips too changed all 350 chips against the fork's output.
$ok = (Assert-True 'I3 chip renders the bare xgglbsrp (no suffix in HTML)' `
    ($custText -match 'chip mono">xgglbsrp</span>' -and $custText -notmatch 'chip mono">xgglbsrp\.p</span>') $rI1.Out) -and $ok

# I4: badges — the two adjacent same-date [UAT] entries dedupe to ONE badge in the rendered
# article; PROD renders as COMPLETE; postures match (xgglbsrp 진행 중, batchjob 완료).
$xgArticle = [regex]::Match($custText, '(?s)<article class="prog[^"]*" id="prog-xgglbsrp">.*?</article>').Value
$uatBadges = [regex]::Matches($xgArticle, 'class="relstat rs-uat"').Count
$ok = (Assert-True 'I4 adjacent same-state UAT badges dedupe to exactly one in the article' `
    ($uatBadges -eq 1) "count=$uatBadges`n$xgArticle") -and $ok
$ok = (Assert-True 'I4 PROD renders as COMPLETE' ($custText -match 'rs-prod">COMPLETE<') $rI1.Out) -and $ok
$ok = (Assert-True 'I4 xgglbsrp posture is 진행 중 (top entry is UAT, not final)' `
    ($custText -match 'data-prog="xgglbsrp"[\s\S]{0,400}?진행 중') $rI1.Out) -and $ok
$ok = (Assert-True 'I4 batchjob posture is 완료 (top entry is PROD, final)' `
    ($custText -match 'data-prog="batchjob"[\s\S]{0,400}?완료') $rI1.Out) -and $ok

# I5: PROJECTS.md — one project (#P1), one member (xgglbsrp, chip + title), sorted.
$projText = Get-Content -LiteralPath $projMd -Raw -Encoding UTF8
$ok = (Assert-True 'I5 PROJECTS.md names the P1 project' ($projText -match '## #P1') $projText) -and $ok
$ok = (Assert-True 'I5 PROJECTS.md lists xgglbsrp with its chip + title' `
    ($projText -match '- xgglbsrp \(`xgglbsrp\.p`\) — xgglbsrp spec') $projText) -and $ok

# I6: "customer": null -> exit 0, NO customer.artifact.html/PROJECTS.md, 4 surfaces listed.
Remove-Item $custHtml, $projMd -ErrorAction SilentlyContinue
[IO.File]::WriteAllText((Join-Path $repoI '.harness.json'), '{ "docs": { "customer": null } }')
$rI6 = Invoke-IBuild
$ok = (Assert-True 'I6 customer: null exits 0' ($rI6.Code -eq 0) $rI6.Out) -and $ok
$ok = (Assert-True 'I6 no customer.artifact.html is written' (-not (Test-Path $custHtml)) $rI6.Out) -and $ok
$ok = (Assert-True 'I6 no PROJECTS.md is written' (-not (Test-Path $projMd)) $rI6.Out) -and $ok
$ok = (Assert-True 'I6 output lists the 4 internal surfaces, nothing customer-shaped' `
    ($rI6.Out -match 'docs\.artifact\.html' -and $rI6.Out -notmatch 'customer\.artifact\.html') $rI6.Out) -and $ok
[IO.File]::WriteAllText((Join-Path $repoI '.harness.json'), $declFull)

# I7: a missing required file names the exact path, no traceback.
$ugPath = Join-Path $custI 'xgglbsrp/user-guide.md'
$ugBody = Get-Content -LiteralPath $ugPath -Raw -Encoding UTF8
Remove-Item $ugPath
$rI7 = Invoke-IBuild
$ok = (Assert-True 'I7 a missing user-guide.md is a named refusal, not a traceback' `
    ($rI7.Code -ne 0 -and $rI7.Out -match [regex]::Escape('docs/customer/xgglbsrp/user-guide.md') `
     -and $rI7.Out -notmatch 'Traceback') $rI7.Out) -and $ok
[IO.File]::WriteAllText($ugPath, ($ugBody -replace "`r`n", "`n"))

# I8: program != dirname names the file and the key.
$specPath = Join-Path $custI 'xgglbsrp/spec.md'
$specBody = Get-Content -LiteralPath $specPath -Raw -Encoding UTF8
Write-IDoc 'customer/xgglbsrp/spec.md' "---`nprogram: WRONG`ntitle: `"xgglbsrp spec`"`nupdated: 2026-08-20`nprogram_file: xgglbsrp`nmenu: `"25.15.1`"`nproject: P1`n---`n# spec`nBody.`n"
$rI8 = Invoke-IBuild
$ok = (Assert-True 'I8 program != dirname exits 1 naming the file and the key' `
    ($rI8.Code -ne 0 -and $rI8.Out -match [regex]::Escape('docs/customer/xgglbsrp/spec.md') `
     -and $rI8.Out -match 'program') $rI8.Out) -and $ok
[IO.File]::WriteAllText($specPath, ($specBody -replace "`r`n", "`n"))

# I9: a missing chip_field key (program_file) on spec.md exits 1.
Write-IDoc 'customer/xgglbsrp/spec.md' "---`nprogram: xgglbsrp`ntitle: `"xgglbsrp spec`"`nupdated: 2026-08-20`nmenu: `"25.15.1`"`nproject: P1`n---`n# spec`nBody.`n"
$rI9 = Invoke-IBuild
$ok = (Assert-True 'I9 a missing declared chip_field key on spec.md exits 1' ($rI9.Code -ne 0) $rI9.Out) -and $ok
[IO.File]::WriteAllText($specPath, ($specBody -replace "`r`n", "`n"))

# I10: a malformed block (dir escapes the repo) exits 1 and reports it as unusable.
[IO.File]::WriteAllText((Join-Path $repoI '.harness.json'), '{ "docs": { "customer": { "dir": "../x" } } }')
$rI10 = Invoke-IBuild
$ok = (Assert-True 'I10 a malformed docs.customer block exits 1 and says 사용 불가' `
    ($rI10.Code -ne 0 -and $rI10.Out -match '사용 불가') $rI10.Out) -and $ok
[IO.File]::WriteAllText((Join-Path $repoI '.harness.json'), $declFull)

# I11: the reader absent (scripts/harness/ renamed away) exits 1 naming its path — the
# refusal, not a silent 4-surface fallback. The 4 internal surfaces may already be on disk
# from a PRIOR successful build (main() writes them before attempting the customer surface) —
# this case asserts only the refusal shape, not their absence.
$hcDir = Join-Path $repoI 'scripts/harness'
$hcMoved = Join-Path $repoI 'scripts/harness-moved'
Rename-Item -LiteralPath $hcDir -NewName 'harness-moved'
$rI11 = Invoke-IBuild
# reader_path is built with os.path.join, so on Windows it is backslash-separated — match
# either separator rather than the forward-slash form the OTHER exit messages use (those are
# built by plain "%s/%s/%s" string formatting over the DECLARED dir, never os.path.join).
$ok = (Assert-True 'I11 an absent reader exits 1 naming scripts/harness/harness_config.py' `
    ($rI11.Code -ne 0 -and $rI11.Out -match 'scripts[\\/]harness[\\/]harness_config\.py') $rI11.Out) -and $ok
Rename-Item -LiteralPath $hcMoved -NewName 'harness'

# I12: the `declared` contract — an explicit "" stays blank; an absent key gets the builder's
# own UI default.
$declEmptyEyebrow = @'
{
  "docs": {
    "customer": {
      "dir": "docs/customer",
      "title": "Fixture Repo · 고객 문서 — 테스트",
      "eyebrow": "",
      "description": "테스트용 설명",
      "contact": "테스트 문의처",
      "chip_field": "program_file",
      "chip_suffix": ".p",
      "groups": [{ "label": "재무회계 (25.x)", "keys": [25] }],
      "other_label": "기타 메뉴",
      "unkeyed_label": "배치·인터페이스·자동화",
      "projects_md": true
    }
  }
}
'@
[IO.File]::WriteAllText((Join-Path $repoI '.harness.json'), $declEmptyEyebrow)
$rI12a = Invoke-IBuild
$c12a = Get-Content -LiteralPath $custHtml -Raw -Encoding UTF8
$ok = (Assert-True 'I12 eyebrow declared as "" renders an empty eyebrow element' `
    ($rI12a.Code -eq 0 -and $c12a -match '<div class="eyebrow"></div>') $rI12a.Out) -and $ok
[IO.File]::WriteAllText((Join-Path $repoI '.harness.json'), '{
  "docs": { "customer": {
    "dir": "docs/customer", "chip_field": "program_file", "chip_suffix": ".p",
    "groups": [{ "label": "g", "keys": [25] }], "projects_md": true
  } }
}')
$rI12b = Invoke-IBuild
$c12b = Get-Content -LiteralPath $custHtml -Raw -Encoding UTF8
$ok = (Assert-True 'I12 eyebrow ABSENT falls back to the builder default 고객 문서' `
    ($rI12b.Code -eq 0 -and $c12b -match '<div class="eyebrow">고객 문서</div>') $rI12b.Out) -and $ok
[IO.File]::WriteAllText((Join-Path $repoI '.harness.json'), $declFull)
$null = Invoke-IBuild

# I13: _selfcheck_release_helpers() passes standalone via python -c.
$rI13 = & $py.Source -c "import sys; sys.path.insert(0, r'$docsI'); import build_docs; build_docs._selfcheck_release_helpers(); print('SELFCHECK-OK')" 2>&1 | Out-String
$ok = (Assert-True 'I13 _selfcheck_release_helpers() passes standalone' ($rI13 -match 'SELFCHECK-OK') $rI13) -and $ok

# I14: panels — a declared module contributes a top-level tab; a missing module exits 1.
$panelsDir = Join-Path $repoI 'scripts/panels'
New-Item -ItemType Directory -Force -Path $panelsDir | Out-Null
[IO.File]::WriteAllText((Join-Path $panelsDir 'demo.py'), (
    "CSS = `".demo{color:red}`"`n`ndef render_panel(root):`n    return '<p class=`"demo`">PANEL-OK</p>'`n" `
    -replace "`r`n", "`n"))
[IO.File]::WriteAllText((Join-Path $repoI '.harness.json'), '{
  "docs": { "customer": {
    "dir": "docs/customer", "chip_field": "program_file", "chip_suffix": ".p",
    "groups": [{ "label": "g", "keys": [25] }],
    "panels": [{ "module": "scripts/panels/demo.py", "label": "데모" }]
  } }
}')
$rI14 = Invoke-IBuild
$c14 = if (Test-Path $custHtml) { Get-Content -LiteralPath $custHtml -Raw -Encoding UTF8 } else { '' }
$ok = (Assert-True 'I14 a declared panel module renders its fragment + CSS + tab' `
    ($rI14.Code -eq 0 -and $c14 -match 'PANEL-OK' -and $c14 -match '\.demo\{color:red\}' `
     -and $c14 -match '>데모<') $rI14.Out) -and $ok
[IO.File]::WriteAllText((Join-Path $repoI '.harness.json'), '{
  "docs": { "customer": {
    "dir": "docs/customer", "chip_field": "program_file", "chip_suffix": ".p",
    "groups": [{ "label": "g", "keys": [25] }],
    "panels": [{ "module": "scripts/panels/missing.py", "label": "없음" }]
  } }
}')
$rI14b = Invoke-IBuild
$ok = (Assert-True 'I14b a missing panel module exits 1 naming it' `
    ($rI14b.Code -ne 0 -and $rI14b.Out -match [regex]::Escape('scripts/panels/missing.py')) $rI14b.Out) -and $ok
[IO.File]::WriteAllText((Join-Path $repoI '.harness.json'), $declFull)

# I15: generic markdown fixes, asserted on the base fixture's own docs.html — a hard-wrapped
# list item renders as ONE <li>, a ```diff fence colors a + line, a table is tblwrap-ped.
$null = Invoke-IBuild
$docsHtml = Get-Content -LiteralPath (Join-Path $docsI 'docs.html') -Raw -Encoding UTF8
$liMatches = [regex]::Matches($docsHtml, '<li>item one continued on a hard-wrapped line</li>')
$ok = (Assert-True 'I15 a hard-wrapped list item renders as ONE <li>' ($liMatches.Count -eq 1) $docsHtml) -and $ok
$ok = (Assert-True 'I15 a ```diff fence colors the + line' ($docsHtml -match '<span class="d-add">\+added line</span>') $docsHtml) -and $ok
$ok = (Assert-True 'I15 a table is wrapped in tblwrap' ($docsHtml -match '<div class="tblwrap"><table>') $docsHtml) -and $ok
# I15 negatives (review 2026-08-27, low): the continuation rule is CommonMark's lazy continuation
# for INDENTED lines only — a non-indented paragraph, a table, and a heading that directly follow
# a list item must NOT be swallowed into the <li>.
$ok = (Assert-True 'I15n a NON-indented line after a list item stays a separate paragraph' `
    ($docsHtml -match '<li>item two</li>' -and $docsHtml -match '<p>Plain paragraph right after the list without a blank line</p>') $docsHtml) -and $ok
$ok = (Assert-True 'I15n a table directly after a list item is not swallowed' `
    ($docsHtml -match '<li>item three</li>' -and $docsHtml -match '<th>c</th>') $docsHtml) -and $ok
$ok = (Assert-True 'I15n a heading directly after a list item is not swallowed' `
    ($docsHtml -match '<li>item four</li>' -and $docsHtml -match '<h2>Heading right after a list</h2>') $docsHtml) -and $ok

# I16: a STALE vendored reader (present, importable, but predating ADR 0060 — no customer_decl,
# no cfg["customer"]) is the real pjems state when the declaration is filled before harness-init
# re-runs. It must be a named exit, never a KeyError traceback (review 2026-08-27, high —
# reproduced with the pre-0060 reader).
$hcReal = Join-Path $repoI 'scripts/harness'
Rename-Item -LiteralPath $hcReal -NewName 'harness-real'
New-Item -ItemType Directory -Force -Path $hcReal | Out-Null
[IO.File]::WriteAllText((Join-Path $hcReal 'harness_config.py'), "def load(root):`n    return ({'index': 'docs/index.json'}, [])`n")
Remove-Item -LiteralPath (Join-Path $docsI 'index.json') -ErrorAction SilentlyContinue
$rI16 = Invoke-IBuild
$ok = (Assert-True 'I16 a stale reader (no customer support) exits 1 naming it as 구버전, no traceback' `
    ($rI16.Code -ne 0 -and $rI16.Out -match '구버전' -and $rI16.Out -match 'harness_config\.py' -and $rI16.Out -notmatch 'Traceback') $rI16.Out) -and $ok
# I17: write order — a refused customer build must not leave the 4 internal surfaces freshly
# written next to a stale customer page (review 2026-08-27, medium): index.json was deleted above
# and the refusal fired, so it must still be absent.
$ok = (Assert-True 'I17 a refused customer build writes NO surface at all (index.json stays absent)' `
    (-not (Test-Path -LiteralPath (Join-Path $docsI 'index.json'))) 'index.json was written before the customer refusal') -and $ok
Remove-Item -LiteralPath $hcReal -Recurse -Force
Rename-Item -LiteralPath (Join-Path $repoI 'scripts/harness-real') -NewName 'harness'

# I14c: a panel module whose render_panel() RAISES is a named exit, not a traceback (review
# 2026-08-27, medium — the import was guarded, the call was not).
[IO.File]::WriteAllText((Join-Path $panelsDir 'boom.py'), "def render_panel(root):`n    raise RuntimeError('boom')`n")
[IO.File]::WriteAllText((Join-Path $repoI '.harness.json'), '{
  "docs": { "customer": {
    "dir": "docs/customer", "chip_field": "program_file", "chip_suffix": ".p",
    "groups": [{ "label": "g", "keys": [25] }],
    "panels": [{ "module": "scripts/panels/boom.py", "label": "붐" }]
  } }
}')
$rI14c = Invoke-IBuild
$ok = (Assert-True 'I14c a raising render_panel() exits 1 naming the module, no traceback' `
    ($rI14c.Code -ne 0 -and $rI14c.Out -match 'render_panel' -and $rI14c.Out -match [regex]::Escape('scripts') -and $rI14c.Out -match 'boom' -and $rI14c.Out -notmatch 'Traceback') $rI14c.Out) -and $ok
[IO.File]::WriteAllText((Join-Path $repoI '.harness.json'), $declFull)
$rFinal = Invoke-IBuild
$ok = (Assert-True 'I18 the fixture builds clean again after the failure cases (all 6 surfaces)' `
    ($rFinal.Code -eq 0 -and (Test-Path -LiteralPath (Join-Path $docsI 'index.json')) -and (Test-Path -LiteralPath $custHtml)) $rFinal.Out) -and $ok

Remove-FixtureRoot $fx

if (-not $ok) { Write-Host 'build-docs selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'build-docs selftest: all cases green' -ForegroundColor Green
exit 0
