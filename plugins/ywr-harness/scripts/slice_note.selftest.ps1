# Selftest for slice_note.py (ADR 0172). What can regress silently: a note that moves the work tree
# (the --tree snapshot of a ready report), a refused character that reaches the journal, a closed
# slice's notes that leak into the next slice's `show`, a range that drops the base's notes, a torn
# line that hides the rest, and a failure that reads as "no notes". Every case reads the script's
# output and exit code; the journal is read only through `show`, except where a case breaks it.
#
# One throwaway repo walks the sequence from an unborn branch; N11 uses a directory outside git and
# N14 a linked worktree. Non-ASCII and control characters are built from [char] codes, never typed as
# escape text in this file.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core

$note = Join-Path $PSScriptRoot 'slice_note.py'
$fxBase = New-FixtureRoot 'slice-note-selftest'
trap { Remove-FixtureRoot $fxBase; break }

$py = @('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if (-not $py) {
    # Reported skip, never silent: CI has python, so absence THERE would mean the suite stopped running.
    if ($env:CI) {
        Write-Host 'FAIL — python absent on CI; a missing interpreter is not a pass' -ForegroundColor Red
        Remove-FixtureRoot $fxBase
        exit 1
    }
    Write-Host 'SKIP [slice_note] python absent (reported, not silent) — CI runs this suite' -ForegroundColor Yellow
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
} finally { Pop-Location }
$plain = Join-Path $fxBase 'plain'
New-Item -ItemType Directory -Force -Path $plain | Out-Null
$env:GIT_CEILING_DIRECTORIES = $fxBase

function Invoke-Note([string]$Repo, [string[]]$Arguments) {
    $a = @($note, '--repo', $Repo) + $Arguments
    $out = & $py.Source @a 2>&1 | Out-String
    return @{ Out = $out; Code = $LASTEXITCODE }
}
function Invoke-Git([string]$Repo, [string[]]$Arguments) {
    Push-Location $Repo
    try { return (& git @Arguments 2>$null | Out-String) } finally { Pop-Location }
}
$ok = $true

$r = Invoke-Note $repo @('add', 'decision', 'unborn', 'note')
$ok = (Assert-True 'N1 an unborn branch records HEAD none, and the text arguments join with one space' ($r.Code -eq 0 -and $r.Out -match 'slice note 1 recorded \(decision\) at HEAD none') "exit=$($r.Code) out=$($r.Out)") -and $ok
$r = Invoke-Note $repo @('show')
$ok = (Assert-True 'N1b show lists the unborn note with its kind and joined text' ($r.Code -eq 0 -and $r.Out -match 'slice notes: 1 at HEAD none' -and $r.Out -match '1\. \S+Z decision: unborn note') "exit=$($r.Code) out=$($r.Out)") -and $ok

Push-Location $repo
try { & git commit -q --allow-empty -m 'seed' 2>$null } finally { Pop-Location }
$base = (Invoke-Git $repo @('rev-parse', 'HEAD')).Trim()
$r = Invoke-Note $repo @('show')
$ok = (Assert-True 'N2 a commit retires the earlier notes: none at the new HEAD, one counted elsewhere' ($r.Code -eq 0 -and $r.Out -match 'slice notes: none at HEAD [0-9a-f]{12}' -and $r.Out -match 'slice notes: 1 more at other HEADs') "exit=$($r.Code) out=$($r.Out)") -and $ok

foreach ($k in @('decision', 'rejected', 'owner', 'fact', 'risk')) { $null = Invoke-Note $repo @('add', $k, "a $k note") }
$hangul = -join @([char]0xAC00, [char]0xB098, [char]0xB2E4)
$r = Invoke-Note $repo @('add', 'owner', "accepted $hangul")
$ok = (Assert-True 'N3 each kind is accepted, and the count runs per HEAD' ($r.Code -eq 0 -and $r.Out -match 'slice note 6 recorded \(owner\)') "exit=$($r.Code) out=$($r.Out)") -and $ok
$status = Invoke-Git $repo @('status', '--porcelain', '--untracked-files=all')
$ok = (Assert-True 'N12 notes live outside the work tree: git status stays empty' ([string]::IsNullOrWhiteSpace($status)) "status=$status") -and $ok

$refusals = @(
    @{ Name = 'empty'; Args = @('add', 'fact', '   '); Want = 'the text is empty' },
    @{ Name = '501 characters'; Args = @('add', 'fact', ('x' * 501)); Want = 'more than 500' },
    @{ Name = 'U+202E'; Args = @('add', 'risk', "bad$([char]0x202E)x"); Want = 'U\+202E' },
    @{ Name = 'LF'; Args = @('add', 'risk', "two$([char]10)lines"); Want = 'U\+000A' },
    @{ Name = 'U+2028'; Args = @('add', 'risk', "two$([char]0x2028)lines"); Want = 'U\+2028' }
)
foreach ($c in $refusals) {
    $r = Invoke-Note $repo $c.Args
    $ok = (Assert-True "N4 a note with $($c.Name) text exits 2 and writes nothing" ($r.Code -eq 2 -and $r.Out -match 'slice note: REFUSED' -and $r.Out -match $c.Want) "exit=$($r.Code) out=$($r.Out)") -and $ok
}
# The bound is in UTF-16 units, as the hook's host counts a string: an astral character is two.
$astral = [char]::ConvertFromUtf32(0x1F600)
$r = Invoke-Note $repo @('add', 'fact', ($astral * 251))
$ok = (Assert-True 'N4d 251 astral characters are 502 UTF-16 units and are refused' ($r.Code -eq 2 -and $r.Out -match '502 UTF-16 units, more than 500') "exit=$($r.Code) out=$($r.Out)") -and $ok
$r = Invoke-Note $repo @('add', 'idea', 'not a kind')
$ok = (Assert-True 'N4b a kind outside the closed set exits 2' ($r.Code -eq 2 -and $r.Out -match 'invalid choice') "exit=$($r.Code) out=$($r.Out)") -and $ok
$r = Invoke-Note $repo @('show', '--max', '0')
$ok = (Assert-True 'N4c --max 0 exits 2' ($r.Code -eq 2 -and $r.Out -match 'slice notes: FAILED — --max') "exit=$($r.Code) out=$($r.Out)") -and $ok

$r = Invoke-Note $repo @('show')
$ok = (Assert-True 'N5 show keeps the order and the Hangul text, and no refused note reached the journal' ($r.Code -eq 0 -and $r.Out -match 'slice notes: 6 at HEAD' -and $r.Out -match '1\. \S+Z decision: a decision note' -and $r.Out -match '5\. \S+Z risk: a risk note' -and $r.Out.Contains("6. ") -and $r.Out.Contains("owner: accepted $hangul") -and $r.Out -notmatch '7\. ') "exit=$($r.Code) out=$($r.Out)") -and $ok

Push-Location $repo
try { & git commit -q --allow-empty -m 'slice commit' 2>$null } finally { Pop-Location }
$null = Invoke-Note $repo @('add', 'rejected', 'after the commit')
$r = Invoke-Note $repo @('show')
$ok = (Assert-True 'N6 the next HEAD shows only its own note and counts the other seven' ($r.Code -eq 0 -and $r.Out -match 'slice notes: 1 at HEAD' -and $r.Out -match 'rejected: after the commit' -and $r.Out -match 'slice notes: 7 more at other HEADs') "exit=$($r.Code) out=$($r.Out)") -and $ok
$r = Invoke-Note $repo @('show', '--range', "$base..HEAD")
$ok = (Assert-True 'N7 a range adds the notes at its base and its commits, not the unborn one' ($r.Code -eq 0 -and $r.Out -match 'slice notes: 7 at HEAD [0-9a-f]{12} and the range' -and $r.Out -match 'decision: a decision note' -and $r.Out -notmatch 'unborn note' -and $r.Out -match 'slice notes: 1 more at other HEADs') "exit=$($r.Code) out=$($r.Out)") -and $ok
$r = Invoke-Note $repo @('show', '--all', '--max', '2')
$ok = (Assert-True 'N8 --all --max 2 prints the newest two with their HEADs and counts the rest' ($r.Code -eq 0 -and $r.Out -match 'slice notes: 8 in the journal' -and $r.Out -match '7\. \S+Z [0-9a-f]{12} owner: accepted' -and $r.Out -match '8\. \S+Z [0-9a-f]{12} rejected: after the commit' -and $r.Out -notmatch '6\. ' -and $r.Out -match 'slice notes: 6 older not shown \(--max 2\)') "exit=$($r.Code) out=$($r.Out)") -and $ok

$r = Invoke-Note $repo @('show', '--range', 'a...b')
$ok = (Assert-True 'N9 a range without exactly one .. exits 2' ($r.Code -eq 2 -and $r.Out -match 'slice notes: FAILED — not a <a>..<b> range') "exit=$($r.Code) out=$($r.Out)") -and $ok
$r = Invoke-Note $repo @('show', '--range', 'no-such-ref..HEAD')
$ok = (Assert-True 'N9b a range git cannot resolve exits 2, never an empty list' ($r.Code -eq 2 -and $r.Out -match 'slice notes: FAILED — git could not resolve') "exit=$($r.Code) out=$($r.Out)") -and $ok

$journal = Join-Path $repo ((Invoke-Git $repo @('rev-parse', '--git-path', 'ywr-harness/slice-notes.jsonl')).Trim())
[System.IO.File]::AppendAllText($journal, "{`"ts`": `"torn`n")
# A hand-written record with a well-formed text but an oversized time would grow a show line past the
# hook's bound; every field is held to the shape `add` writes.
[System.IO.File]::AppendAllText($journal, ('{"ts": "' + ('X' * 20000) + '", "head": "' + (Invoke-Git $repo @('rev-parse', 'HEAD')).Trim() + '", "kind": "fact", "text": "long ts"}' + "`n"))
$r = Invoke-Note $repo @('show')
$ok = (Assert-True 'N10 a torn line is named on stderr and the other notes still show' ($r.Code -eq 0 -and $r.Out -match 'slice-notes\.jsonl:\d+ is not a slice note' -and $r.Out -match 'slice notes: 1 at HEAD') "exit=$($r.Code) out=$($r.Out)") -and $ok
$ok = (Assert-True 'N10b a record whose ts is not the shape add writes is ignored, never printed' (([regex]::Matches($r.Out, 'is not a slice note')).Count -eq 2 -and $r.Out -notmatch 'long ts' -and $r.Out.Length -lt 4000) "exit=$($r.Code) len=$($r.Out.Length)") -and $ok

$r = Invoke-Note $plain @('show')
$ok = (Assert-True 'N11 a directory outside git exits 2 with a FAILED line' ($r.Code -eq 2 -and $r.Out -match 'slice notes: FAILED — git could not resolve') "exit=$($r.Code) out=$($r.Out)") -and $ok

$wt = Join-Path $fxBase 'wt'
$null = Invoke-Git $repo @('worktree', 'add', '-q', '--detach', $wt)
$r = Invoke-Note $wt @('show')
$ok = (Assert-True 'N14 a linked worktree has its own journal' ($r.Code -eq 0 -and $r.Out -match 'slice notes: none at HEAD' -and $r.Out -notmatch 'more at other HEADs') "exit=$($r.Code) out=$($r.Out)") -and $ok

# A repo that declares a handoff: the slice runs from the last commit that touched it, so a commit
# inside the slice keeps the earlier notes, and the next close retires them.
$sliced = Join-Path $fxBase 'sliced'
New-Item -ItemType Directory -Force -Path $sliced | Out-Null
Set-Content -LiteralPath (Join-Path $sliced '.harness.json') -Value '{"handoff": "HANDOFF.md"}' -NoNewline
Set-Content -LiteralPath (Join-Path $sliced 'HANDOFF.md') -Value 'slice 1 closed' -NoNewline
$null = Invoke-Git $sliced @('init', '-q')
$null = Invoke-Git $sliced @('config', 'user.email', 'selftest@example.invalid')
$null = Invoke-Git $sliced @('config', 'user.name', 'selftest')
$null = Invoke-Git $sliced @('add', '-A')
$null = Invoke-Git $sliced @('commit', '-q', '-m', 'close slice 1')
$closeSha = (Invoke-Git $sliced @('rev-parse', 'HEAD')).Trim()
$null = Invoke-Note $sliced @('add', 'decision', 'before the mid-slice commit')
Set-Content -LiteralPath (Join-Path $sliced 'work.txt') -Value 'part one' -NoNewline
$null = Invoke-Git $sliced @('add', '-A')
$null = Invoke-Git $sliced @('commit', '-q', '-m', 'mid-slice commit')
$null = Invoke-Note $sliced @('add', 'risk', 'after the mid-slice commit')
$r = Invoke-Note $sliced @('show')
$ok = (Assert-True 'N15 a commit inside the slice keeps the earlier notes: show runs from the last handoff commit' ($r.Code -eq 0 -and $r.Out -match "slice notes: 2 at HEAD [0-9a-f]{12} since the handoff commit $($closeSha.Substring(0, 12))" -and $r.Out -match 'decision: before the mid-slice commit' -and $r.Out -match 'risk: after the mid-slice commit') "exit=$($r.Code) out=$($r.Out)") -and $ok
# An amend and a rebase rewrite the slice's own commits; the base stays, so the notes stay.
$null = Invoke-Git $sliced @('commit', '-q', '--amend', '--allow-empty', '-m', 'mid-slice commit, amended')
$r = Invoke-Note $sliced @('show')
$ok = (Assert-True 'N15b an amended commit keeps its notes through the base they were written under' ($r.Code -eq 0 -and $r.Out -match 'slice notes: 2 at HEAD' -and $r.Out -match 'risk: after the mid-slice commit' -and $r.Out -notmatch 'more at other HEADs') "exit=$($r.Code) out=$($r.Out)") -and $ok
$env:GIT_COMMITTER_DATE = '2001-01-01T00:00:00Z'
try { $null = Invoke-Git $sliced @('rebase', '-q', '--force-rebase', $closeSha) } finally { Remove-Item Env:GIT_COMMITTER_DATE -ErrorAction SilentlyContinue }
$r = Invoke-Note $sliced @('show')
$ok = (Assert-True 'N15c a rebase keeps the notes too' ($r.Code -eq 0 -and $r.Out -match 'slice notes: 2 at HEAD' -and $r.Out -match 'decision: before the mid-slice commit' -and $r.Out -match 'risk: after the mid-slice commit') "exit=$($r.Code) out=$($r.Out)") -and $ok
Set-Content -LiteralPath (Join-Path $sliced 'HANDOFF.md') -Value 'slice 2 closed' -NoNewline
$null = Invoke-Git $sliced @('add', '-A')
$null = Invoke-Git $sliced @('commit', '-q', '-m', 'close slice 2')
$r = Invoke-Note $sliced @('show')
$ok = (Assert-True 'N16 the next close commit retires the whole slice' ($r.Code -eq 0 -and $r.Out -match 'slice notes: none at HEAD [0-9a-f]{12} ·' -and $r.Out -notmatch 'since the handoff' -and $r.Out -match 'slice notes: 2 more at other HEADs') "exit=$($r.Code) out=$($r.Out)") -and $ok
# A declared handoff is a literal path. As pathspec magic, `:(glob)**` would match the last commit that
# touched any file, and the empty HEAD below would then show a base.
$null = Invoke-Git $sliced @('commit', '-q', '--allow-empty', '-m', 'empty head')
Set-Content -LiteralPath (Join-Path $sliced '.harness.json') -Value '{"handoff": ":(glob)**"}' -NoNewline
$r = Invoke-Note $sliced @('show')
$ok = (Assert-True 'N17 a handoff value never acts as pathspec magic' ($r.Code -eq 0 -and $r.Out -match 'slice notes: none at HEAD' -and $r.Out -notmatch 'since the handoff') "exit=$($r.Code) out=$($r.Out)") -and $ok
Set-Content -LiteralPath (Join-Path $sliced '.harness.json') -Value '{"handoff": "../outside.md"}' -NoNewline
$r = Invoke-Note $sliced @('show')
$ok = (Assert-True 'N18 a refused handoff is named first on stdout with its effect, so the compact hook passes it on' ($r.Code -eq 0 -and $r.Out -match '^slice notes: warning — handoff: rejected' -and $r.Out -match 'the slice is then HEAD only') "exit=$($r.Code) out=$($r.Out)") -and $ok

Remove-Item -LiteralPath $journal -Force
New-Item -ItemType Directory -Force -Path $journal | Out-Null
$r = Invoke-Note $repo @('add', 'fact', 'cannot land')
$ok = (Assert-True 'N13 a journal that cannot be written exits 2 with a FAILED line, not a traceback' ($r.Code -eq 2 -and $r.Out -match 'slice notes: FAILED — journal I/O' -and $r.Out -notmatch 'Traceback') "exit=$($r.Code) out=$($r.Out)") -and $ok

Remove-Item Env:GIT_CEILING_DIRECTORIES -ErrorAction SilentlyContinue
if ($null -ne $pathBefore) { $env:PATH = $pathBefore }
Remove-FixtureRoot $fxBase
if (-not $ok) { Write-Host 'slice_note selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'slice_note selftest: all cases green' -ForegroundColor Green
exit 0
