# Selftest for fix_proof.py (ADR 0169). What can regress silently is a key that passes without the
# evidence: a command that passed before the fix, a failing and a passing run at one tree, two
# different argvs, a pass that an edit after it made stale, an earlier HEAD's record, or a command that
# moved the tree itself. Each of those must stay MISSING, and the check must exit 1 on it. A run must
# also record the exit code it saw, and a command that cannot start must leave no record. The keys come
# from the digest's counted high_ids, so the closer cannot drop one, and a waiver never turns the check
# green: it exits 3 for the owner.
#
# One throwaway git repo under the system temp root walks the whole sequence; P19 alone uses a
# directory outside git. Every case reads the script's output and exit code. The test commands check a
# file's content, so the "fix" is an edit.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core

$proof = Join-Path $PSScriptRoot 'fix_proof.py'
$fxBase = New-FixtureRoot 'fix-proof-selftest'
trap { Remove-FixtureRoot $fxBase; break }

$py = @('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if (-not $py) {
    # Reported skip, never silent: CI has python, so absence THERE would mean the gate stopped running.
    if ($env:CI) {
        Write-Host 'FAIL — python absent on CI; a missing interpreter is not a pass' -ForegroundColor Red
        Remove-FixtureRoot $fxBase
        exit 1
    }
    Write-Host 'SKIP [fix_proof] python absent (reported, not silent) — CI runs this gate' -ForegroundColor Yellow
    Remove-FixtureRoot $fxBase
    exit 0
}
$pathBefore = Use-GitWorkerBinary

$repo = Join-Path $fxBase 'repo'
New-Item -ItemType Directory -Force -Path $repo | Out-Null
Push-Location $repo
try {
    & git init -q 2>$null
    & git config user.email 'selftest@example.invalid' 2>$null
    & git config user.name 'selftest' 2>$null
    Set-Content -LiteralPath (Join-Path $repo 'ok.txt') -Value 'bug' -NoNewline
    Set-Content -LiteralPath (Join-Path $repo '.gitignore') -Value 'flag' -NoNewline
    & git add -A 2>$null; & git commit -q -m 'seed' 2>$null
} finally { Pop-Location }
# A fixture outside every repository: the ceiling keeps git from finding one above the temp root.
$plain = Join-Path $fxBase 'plain'
New-Item -ItemType Directory -Force -Path $plain | Out-Null
$env:GIT_CEILING_DIRECTORIES = $fxBase

function Invoke-Proof([string]$Repo, [string[]]$Arguments) {
    $a = @($proof, '--repo', $Repo) + $Arguments
    $out = & $py.Source @a 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}
# The workflow's id shape: prefix, position, '-', an 8-hex fingerprint (spec 0011 s4).
function Get-Digest([string[]]$Ids, [switch]$Last) {
    $field = if ($Ids) { "high_ids $($Ids.Count): $($Ids -join ',')" } else { 'high_ids none' }
    if ($Last) { return "confirmed 3 (h3 m0 l0) · rejected 1 · coverage full · tier small · $field" }
    return "confirmed 3 (h3 m0 l0) · multi_lens 0 · rejected 1 · $field · coverage full · tier small"
}
$F1 = 'F1-0000aa01'; $F2 = 'F2-0000aa02'; $F3 = 'F3-0000aa03'; $R1 = 'R1-0000bb01'
$exe = $py.Source
$fixed = 'import sys, pathlib; sys.exit(0 if pathlib.Path("ok.txt").read_text() == "fixed" else 1)'
$cargo = 'import sys, pathlib; sys.exit(0 if pathlib.Path("ok.txt").read_text() == "fixed" else 101)'
$flag = 'import sys, pathlib; sys.exit(0 if pathlib.Path("flag").exists() else 1)'
# Fails once and writes gen.txt, a non-ignored file, so its own run moves the tree; then it passes.
$gen = 'import sys, pathlib; p = pathlib.Path("gen.txt"); e = p.exists(); p.write_text("x"); sys.exit(0 if e else 1)'
$ok = $true

$r = Invoke-Proof $repo @('check', '--digest', (Get-Digest @($F1)))
$ok = (Assert-True 'P1 a key with no record is MISSING and the check exits 1' ($r.Code -eq 1 -and $r.Out -match "proof ${F1}: MISSING" -and $r.Out -match 'fix proof: FAILED') "exit=$($r.Code) out=$($r.Out)") -and $ok

$r = Invoke-Proof $repo @('run', $F1, '--', $exe, '-c', $cargo)
$ok = (Assert-True 'P2 a failing command is recorded with its exit code (101, as cargo test fails), run itself exits 0, and a non-1 code gets an advisory note, never a refusal' ($r.Code -eq 0 -and $r.Out -match "proof ${F1}: run exit 101 at tree [0-9a-f]{12}" -and $r.Out -match "proof ${F1}: note — exit 101") "exit=$($r.Code) out=$($r.Out)") -and $ok
# F2 fails with one argv, then passes with another before and after the fix: neither pass has its own failing half.
$null = Invoke-Proof $repo @('run', $F2, '--', $exe, '-c', $fixed)
$r = Invoke-Proof $repo @('run', $F2, '--', $exe, '-c', 'pass')
$ok = (Assert-True 'P3 a pass whose argv never failed says the proof still needs a failing run' ($r.Code -eq 0 -and $r.Out -match "proof ${F2}: run exit 0" -and $r.Out -match "proof ${F2}: note — no failing run") "exit=$($r.Code) out=$($r.Out)") -and $ok
$r = Invoke-Proof $repo @('run', 'F9', '--', 'ywr-no-such-exe-169')
$ok = (Assert-True 'P4 a command that cannot start exits 2 and says nothing was recorded' ($r.Code -eq 2 -and $r.Out -match 'proof F9: FAILED' -and $r.Out -match 'Nothing was recorded') "exit=$($r.Code) out=$($r.Out)") -and $ok
$r = Invoke-Proof $repo @('run', 'F12', '--', $exe, '-c', $gen)
$ok = (Assert-True 'P21a a command that writes a non-ignored file is named: its run cannot count' ($r.Code -eq 0 -and $r.Out -match 'proof F12: run exit 1' -and $r.Out -match 'proof F12: note — the command changed the tree') "exit=$($r.Code) out=$($r.Out)") -and $ok
$null = Invoke-Proof $repo @('run', 'F12', '--', $exe, '-c', $gen)

Set-Content -LiteralPath (Join-Path $repo 'ok.txt') -Value 'fixed' -NoNewline
$null = Invoke-Proof $repo @('run', $F1, '--', $exe, '-c', $cargo)
$null = Invoke-Proof $repo @('run', $F2, '--', $exe, '-c', 'pass')
$null = Invoke-Proof $repo @('run', 'F12', '--', $exe, '-c', $gen)
# F3 fails and passes at ONE tree: `flag` is ignored, so creating it changes the exit, not the tree.
$null = Invoke-Proof $repo @('run', $F3, '--', $exe, '-c', $flag)
Set-Content -LiteralPath (Join-Path $repo 'flag') -Value 'x' -NoNewline
$null = Invoke-Proof $repo @('run', $F3, '--', $exe, '-c', $flag)
$r = Invoke-Proof $repo @('waive', 'F7', '--reason', '  ')
$ok = (Assert-True 'P5 a blank waiver reason exits 2' ($r.Code -eq 2 -and $r.Out -match 'proof F7: FAILED') "exit=$($r.Code) out=$($r.Out)") -and $ok
$r = Invoke-Proof $repo @('waive', $R1, '--reason', 'false on reading: the guard at x.py:3 holds')
$ok = (Assert-True 'P6 a waiver with a reason is recorded' ($r.Code -eq 0 -and $r.Out -match "proof ${R1}: waiver recorded") "exit=$($r.Code) out=$($r.Out)") -and $ok
$null = Invoke-Proof $repo @('waive', $F1, '--reason', 'kept beside the proof')
$journal = Join-Path $repo '.git/ywr-harness/fix-proof.jsonl'
Add-Content -LiteralPath $journal -Value '{"torn'

$r = Invoke-Proof $repo @('check', '--digest', (Get-Digest @($F1, $F2, $F3, $R1)), 'F7', 'F9', 'F12', $F2)
$o = $r.Out
$ok = (Assert-True 'P7a the digest names the keys; positional keys only add, and a repeat counts once' ($o -match "fix proof: keys $F1,$F2,$F3,$R1 from the digest's high_ids \+ F7,F9,F12 added") "out=$o") -and $ok
$ok = (Assert-True 'P7 failing before the fix and passing after it at the current tree is PROVEN, even beside a waiver of the same key; the line prints the failing code' ($o -match "proof ${F1}: PROVEN — exit 101 at tree [0-9a-f]{12}, exit 0 at tree [0-9a-f]{12} \(current\)") "out=$o") -and $ok
$ok = (Assert-True 'P8 a pass that passed before the fix too, beside a failing run of another argv, is MISSING' ($o -match "proof ${F2}: MISSING — no earlier failing run") "out=$o") -and $ok
$ok = (Assert-True 'P9 a failing and a passing run at one tree are MISSING' ($o -match "proof ${F3}: MISSING — no earlier failing run") "out=$o") -and $ok
$ok = (Assert-True 'P21b a failing run that moved the tree cannot be the failing half' ($o -match 'proof F12: MISSING — no earlier failing run') "out=$o") -and $ok
$ok = (Assert-True 'P11 a waiver marks its key WAIVED and the check prints the reason' ($o -match "proof ${R1}: WAIVED — false on reading") "out=$o") -and $ok
$ok = (Assert-True 'P12 a refused waiver and a command that never started leave no record' ($o -match 'proof F7: MISSING — no run and no waiver' -and $o -match 'proof F9: MISSING — no run and no waiver') "out=$o") -and $ok
$ok = (Assert-True 'P13 a torn journal line is named on stderr and ignored' ($o -match 'fix-proof\.jsonl:\d+ is not a proof record') "out=$o") -and $ok
$ok = (Assert-True 'P14 any missing key fails the check with exit 1 and names every missing key' ($r.Code -eq 1 -and $o -match "fix proof: FAILED — 5 of 7 key\(s\) without a proof: $F2, $F3, F7, F9, F12") "exit=$($r.Code) out=$o") -and $ok

$r = Invoke-Proof $repo @('check', '--digest', (Get-Digest @($F1)))
$ok = (Assert-True 'P15 every digest key proven: exit 0' ($r.Code -eq 0 -and $r.Out -match 'fix proof: OK — 1 proven') "exit=$($r.Code) out=$($r.Out)") -and $ok
$r = Invoke-Proof $repo @('check', '--digest', (Get-Digest @($F1, $R1) -Last))
$ok = (Assert-True 'P15b an R id as the last digest field parses, and a waiver exits 3 for the owner, never green' ($r.Code -eq 3 -and $r.Out -match "fix proof: OWNER — 1 proven; waived $R1 need the owner" -and $r.Out -notmatch 'fix proof: OK') "exit=$($r.Code) out=$($r.Out)") -and $ok
$r = Invoke-Proof $repo @('check', '--digest', "confirmed 3 (h3 m0 l0) · high_ids 3: $F1,$F2 · coverage full")
$ok = (Assert-True 'P15c a high_ids list shorter than its count exits 2: a cut paste never drops a key' ($r.Code -eq 2 -and $r.Out -match 'high_ids counts 3 but lists 2') "exit=$($r.Code) out=$($r.Out)") -and $ok
$r = Invoke-Proof $repo @('check', '--digest', 'confirmed 1 (h1 m0 l0) · rejected 0 · coverage full', $F1)
$ok = (Assert-True 'P15d a digest without high_ids exits 2 even when keys are passed' ($r.Code -eq 2 -and $r.Out -match 'carries no `high_ids` field') "exit=$($r.Code) out=$($r.Out)") -and $ok

Set-Content -LiteralPath (Join-Path $repo 'later.txt') -Value 'edit after the proof' -NoNewline
$r = Invoke-Proof $repo @('check', '--digest', (Get-Digest @($F1, $F2)))
$ok = (Assert-True 'P16 an edit after the passing run makes a proof stale: the waiver shows, and a key with none is MISSING' ($r.Code -eq 1 -and $r.Out -match "proof ${F1}: WAIVED — kept beside the proof" -and $r.Out -match "proof ${F2}: MISSING — no exit-0 run at the current tree") "exit=$($r.Code) out=$($r.Out)") -and $ok

Push-Location $repo
try { & git add -A 2>$null; & git commit -q -m 'next slice' 2>$null } finally { Pop-Location }
$r = Invoke-Proof $repo @('check', '--digest', (Get-Digest @()), $R1)
$ok = (Assert-True 'P17 records at an earlier HEAD are ignored' ($r.Code -eq 1 -and $r.Out -match "proof ${R1}: MISSING — no run and no waiver at this HEAD") "exit=$($r.Code) out=$($r.Out)") -and $ok
$ok = (Assert-True 'P15e high_ids none adds no key; only the added key is checked' ($r.Out -match "fix proof: keys none from the digest's high_ids \+ $R1 added") "out=$($r.Out)") -and $ok

Remove-Item -LiteralPath $journal -Force
New-Item -ItemType Directory -Force -Path $journal | Out-Null
$r = Invoke-Proof $repo @('waive', 'F8', '--reason', 'journal is a directory')
$ok = (Assert-True 'P20 a journal that cannot be written exits 2 with a FAILED line, not a traceback' ($r.Code -eq 2 -and $r.Out -match 'fix proof: FAILED — journal I/O' -and $r.Out -notmatch 'Traceback') "exit=$($r.Code) out=$($r.Out)") -and $ok

$r = Invoke-Proof $repo @('check', '--digest', (Get-Digest @()), 'not a key')
$ok = (Assert-True 'P18 a malformed key exits 2' ($r.Code -eq 2 -and $r.Out -match 'fix proof: FAILED — not a key') "exit=$($r.Code) out=$($r.Out)") -and $ok
$r = Invoke-Proof $plain @('check', '--digest', (Get-Digest @($F1)))
$ok = (Assert-True 'P19 a directory outside git exits 2 and checks nothing' ($r.Code -eq 2 -and $r.Out -match 'fix proof: FAILED — no git worktree snapshot') "exit=$($r.Code) out=$($r.Out)") -and $ok

Remove-Item Env:GIT_CEILING_DIRECTORIES -ErrorAction SilentlyContinue
if ($null -ne $pathBefore) { $env:PATH = $pathBefore }
Remove-FixtureRoot $fxBase
if (-not $ok) { Write-Host 'fix_proof selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'fix_proof selftest: all cases green' -ForegroundColor Green
exit 0
