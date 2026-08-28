# Self-test for feedback.ps1 (ADR 0064, spec 0013).
# Usage: pwsh plugins/ywr-harness/skills/feedback/feedback.selftest.ps1
#
# The network boundary is `gh`, and every case that would cross it runs against a FAKE gh: a
# `gh.ps1` written into a fixture directory and put FIRST on a PATH that holds only that directory,
# pwsh's, and git's (so the real gh, python and claude are unreachable for the child — the
# "claude: not on PATH" line is deterministic here). Where gh shares a directory with pwsh or git
# (GitHub's ubuntu runner: /usr/bin), the gh-absent PATH is a private directory of links to just
# those two — see the $noGhOk block. PowerShell resolves `gh` to the .ps1 on both
# Windows and Linux, and `& <script>.ps1` sets $LASTEXITCODE from the script's `exit`, which is
# the contract feedback.ps1 reads. The fake logs every argv it receives (one line per call,
# fields joined by U+001F) so the assertions read what gh WAS ASKED, not what a mock returned.
#
# The scaffolded fixture is built by the REAL init.ps1 (spec 0009) and then hand-patched, because
# the script's drift section is the refresh nudge's and the dry run's own output — asserting
# against a faked drift would test the fake. Content-leak assertions use a marker string planted
# in the patch: it must be in the repo and NEVER in the body.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot '../../lib/selftest-lib.ps1')
$script = Join-Path $PSScriptRoot 'feedback.ps1'
$skillMd = Join-Path $PSScriptRoot 'SKILL.md'
$pluginRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$initPs1 = Join-Path $pluginRoot 'skills/harness-init/init.ps1'
$manifestVer = (Get-Content -LiteralPath (Join-Path $pluginRoot '.claude-plugin/plugin.json') -Raw | ConvertFrom-Json).version

# Resolved BEFORE PATH is narrowed — `& pwsh` resolves at call time and would fail.
$pwshExe = (Get-Command pwsh).Source
$gitOk = [bool](Get-Command git -ErrorAction SilentlyContinue)
if (-not $gitOk) {
    Write-Host 'SKIP — git not on PATH; feedback.selftest needs real repos for its fixtures (reported, not silent)' -ForegroundColor Yellow
    exit 0
}
$gitDir = Split-Path (Get-Command git).Source -Parent
$sep = [IO.Path]::PathSeparator

$ok = $true
$savedPath = $env:PATH
$savedMode = $env:YWR_FAKE_GH_MODE; $savedLog = $env:YWR_FAKE_GH_LOG
$fx = New-FixtureRoot 'feedback-selftest'
trap { $env:PATH = $savedPath; $env:YWR_FAKE_GH_MODE = $savedMode; $env:YWR_FAKE_GH_LOG = $savedLog; Remove-FixtureRoot $fx; break }

# --- fake gh -----------------------------------------------------------------------------------
$fakeDir = Join-Path $fx 'fake-gh'
New-Item -ItemType Directory -Force -Path $fakeDir | Out-Null
$ghLog = Join-Path $fx 'gh-calls.log'
$env:YWR_FAKE_GH_LOG = $ghLog
@'
# No param block ON PURPOSE: with declared parameters PowerShell's binder parses gh's own flags
# (--json, --limit, --state) as parameter names and throws "positional parameter cannot be found"
# — measured on the first run of this suite. Bare $args keeps every token verbatim.
$Rest = @($args | ForEach-Object { [string]$_ })
$mode = $env:YWR_FAKE_GH_MODE
if ($env:YWR_FAKE_GH_LOG) { Add-Content -LiteralPath $env:YWR_FAKE_GH_LOG -Value ($Rest -join [char]0x1F) -Encoding utf8 }
$sub = "$($Rest[0]) $($Rest[1])"
switch ($sub) {
    'auth status'  { if ($mode -eq 'unauth') { [Console]::Error.WriteLine('You are not logged into any GitHub hosts. To log in, run: gh auth login'); exit 1 }; Write-Output 'github.com: Logged in'; exit 0 }
    'label list'   { if ($mode -eq 'nolabel') { Write-Output '[{"name":"bug"}]' } else { Write-Output '[{"name":"bug"},{"name":"upstream-report"}]' }; exit 0 }
    'issue list'   {
        if ($mode -eq 'similar') { Write-Output '[{"number":12,"title":"[upstream-report] acme/widget: same drift"}]' }
        elseif ($mode -eq 'many') { Write-Output ('[' + ((1..20 | ForEach-Object { "{`"number`":$_,`"title`":`"dup $_`"}" }) -join ',') + ']') }
        else { Write-Output '[]' }
        exit 0
    }
    'issue create' { if ($mode -eq 'createfail') { [Console]::Error.WriteLine('GraphQL: Resource not accessible by integration (createIssue)'); exit 1 }; Write-Output 'https://github.com/orcait-co/ywr-harness/issues/999'; exit 0 }
    default        { [Console]::Error.WriteLine("fake gh: unexpected subcommand '$sub'"); exit 64 }
}
'@ | Set-Content -LiteralPath (Join-Path $fakeDir 'gh.ps1') -Encoding utf8

$pathWithGh = "$fakeDir$sep$(Split-Path $pwshExe -Parent)$sep$gitDir"
$pathNoGh = "$(Split-Path $pwshExe -Parent)$sep$gitDir"
# "gh absent" must be TRUE, not assumed: on GitHub's ubuntu runner pwsh, git AND gh all live in
# /usr/bin, so a PATH of "pwsh dir + git dir" still resolves the real (unauthenticated) gh — the
# first CI run of this suite failed F1 on exactly that ("not authenticated" where "not on PATH" was
# asserted; the pwsh docker image passed only because it has no gh at all). When gh still resolves
# on the narrowed PATH, a private bin directory holding links to ONLY pwsh and git becomes the
# gh-absent PATH; if even that leaves gh resolvable, the gh-absent cases are a reported SKIP.
$env:PATH = $pathNoGh; $ghLeak = Get-Command gh -ErrorAction SilentlyContinue; $env:PATH = $savedPath
$noGhOk = $true
if ($ghLeak) {
    $binNoGh = Join-Path $fx 'bin-nogh'
    New-Item -ItemType Directory -Force -Path $binNoGh | Out-Null
    try {
        foreach ($t in @($pwshExe, (Get-Command git).Source)) {
            New-Item -ItemType SymbolicLink -Path (Join-Path $binNoGh (Split-Path $t -Leaf)) -Target $t -ErrorAction Stop | Out-Null
        }
        $pathNoGh = $binNoGh
        $env:PATH = $pathNoGh; $ghLeak = Get-Command gh -ErrorAction SilentlyContinue; $env:PATH = $savedPath
    } catch { $ghLeak = $_ }
    if ($ghLeak) {
        Write-Host "SKIP [gh-absent premise] gh shares a directory with pwsh/git and a private link dir could not isolate them ($ghLeak) — F1 and B3 are NOT run (reported, not silent)" -ForegroundColor Yellow
        $noGhOk = $false
    } else {
        Write-Host "note: gh shares a directory with pwsh/git here; gh-absent cases use a private link dir ($binNoGh)" -ForegroundColor DarkGray
    }
}

# NOT `$Args`: that name is PowerShell's automatic unbound-arguments variable, and a parameter
# declared under it reads as EMPTY inside the function — every child ran without arguments on the
# first run of this suite (all cases red on "a report needs a description").
function Invoke-Feedback([string[]]$ScriptArgs, [string]$Path) {
    $env:PATH = $Path
    try { $o = (& $pwshExe -NoProfile -File $script @ScriptArgs 2>&1 | Out-String); $script:Exit = $LASTEXITCODE }
    finally { $env:PATH = $savedPath }
    return $o
}
function Get-BodyPath([string]$Out) {
    $m = [regex]::Match($Out, '(?m)^\s*body:\s*(.+?)\s*$')
    if ($m.Success) { return $m.Groups[1].Value.Trim() }
    return ''
}
function Read-Body([string]$Path) { if ($Path -and (Test-Path -LiteralPath $Path)) { return [IO.File]::ReadAllText($Path) } return '' }
function Assert-Text([string]$Name, [string]$Text, [string[]]$MustMatch, [string[]]$MustNotMatch, [string[]]$PreFail = @()) {
    # Callers build PreFail from `$(if (...) { 'reason' })` expressions, which yield $null when the
    # condition is false — and the assertion core counts an EMPTY entry as a failure (first run of
    # this suite: four cases red with " · " reasons). Only non-empty reasons are failures.
    $pre = @($PreFail | Where-Object { $_ })
    $script:LastFails = Get-AssertionFailure -Text $Text -MustMatch $MustMatch -MustNotMatch $MustNotMatch -PreFail $pre -Label 'text'
    return (Write-CaseVerdict -Name $Name -Fail $script:LastFails -Detail $Text)
}
function Get-GhCalls() { if (Test-Path -LiteralPath $ghLog) { return @(Get-Content -LiteralPath $ghLog -Encoding utf8) } return @() }
function Reset-GhLog() { if (Test-Path -LiteralPath $ghLog) { Remove-Item -LiteralPath $ghLog -Force } }
function Invoke-GitQ([string]$Repo, [string[]]$GitArgs) { & git -C $Repo @GitArgs 2>&1 | Out-Null }

# --- fixtures ------------------------------------------------------------------------------------
$plain = Join-Path $fx 'plain'                 # a repo with no scaffold
New-Item -ItemType Directory -Force -Path $plain | Out-Null
Invoke-GitQ $plain @('-c', 'init.defaultBranch=main', 'init', '-q')
Invoke-GitQ $plain @('config', 'user.email', 'selftest@example.invalid'); Invoke-GitQ $plain @('config', 'user.name', 'selftest')
Set-Content -LiteralPath (Join-Path $plain 'README.md') -Value 'plain'
Invoke-GitQ $plain @('add', '-A'); Invoke-GitQ $plain @('commit', '-q', '-m', 'init')

$outDir = Join-Path $fx 'out'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# =================================================================================================
# A. DRAFT mode — plain repo
# =================================================================================================
$env:YWR_FAKE_GH_MODE = 'ok'; Reset-GhLog
$out = Invoke-Feedback @('-Description', "the gate emitter prints nothing`nsecond line", '-Target', $plain, '-OutDir', $outDir) $pathWithGh
$bodyA = Get-BodyPath $out
$textA = Read-Body $bodyA
$ok = (Assert-Text 'A1 draft on a plain repo: exit 0, body written, sections present, no scaffold readers run' ("$out`n=====`n$textA") `
        @('(?m)^\s*body:\s', '(?m)^\s*title:\s*\[upstream-report\] \(no origin remote\) plain: the gate emitter prints nothing',
          '(?m)^<!-- title: \[upstream-report\] ', '## Report', 'the gate emitter prints nothing\s+second line', '## Environment',
          ('running \(this copy\): \*\*v' + [regex]::Escape($manifestVer) + '\*\*'), 'claude: not on PATH', 'not a scaffolded repo',
          'fingerprint: `fb[0-9a-f]{10}`', 'similar open reports: not searched', 'No file contents or diffs') `
        @('@@', '\+\+\+ ', 'Traceback', '\[hook:scaffold-refresh-nudge\]', 'harness-init ->') `
        @($(if ($script:Exit -ne 0) { "exit $script:Exit (want 0)" }), $(if (-not $bodyA) { 'no body: line' }))) -and $ok
$ok = (Assert-True 'A1b no gh call is made when there is no drift (fingerprint search skipped)' ((Get-GhCalls).Count -eq 0) "calls: $((Get-GhCalls) -join ' | ')") -and $ok

# A2: origin with embedded credentials -> owner/repo only, the URL never appears
Invoke-GitQ $plain @('remote', 'add', 'origin', 'https://someuser:ghp_SECRETTOKEN123@github.com/acme/widget.git')
$out = Invoke-Feedback @('-Description', 'remote test', '-Target', $plain, '-OutDir', $outDir) $pathWithGh
$textA2 = Read-Body (Get-BodyPath $out)
$ok = (Assert-Text 'A2 origin is reduced to owner/repo; credentials in the remote URL never reach the body' ("$out`n$textA2") `
        @('repo: `acme/widget`', '\[upstream-report\] acme/widget: remote test') `
        @('ghp_SECRETTOKEN123', 'someuser', 'https://someuser', 'github\.com/acme') `
        @($(if ($script:Exit -ne 0) { "exit $script:Exit (want 0)" }))) -and $ok

# A3: no description -> exit 1, nothing drafted
$before = @(Get-ChildItem -LiteralPath $outDir -File).Count
$out = Invoke-Feedback @('-Target', $plain, '-OutDir', $outDir) $pathWithGh
$after = @(Get-ChildItem -LiteralPath $outDir -File).Count
$ok = (Assert-Text 'A3 no description -> exit 1 with a FAIL line and no body file' $out `
        @('FAIL — a report needs a description') @('(?m)^\s*body:') `
        @($(if ($script:Exit -ne 1) { "exit $script:Exit (want 1)" }), $(if ($after -ne $before) { 'a body file was written' }))) -and $ok

# A4: -Title override
$out = Invoke-Feedback @('-Description', 'x', '-Title', 'custom title here', '-Target', $plain, '-OutDir', $outDir) $pathWithGh
$textA4 = Read-Body (Get-BodyPath $out)
$ok = (Assert-Text 'A4 -Title is used verbatim as the body title line' $textA4 @('(?m)^<!-- title: custom title here -->') @('\[upstream-report\]')) -and $ok

# A5: a long first line is truncated in the default title, with an ellipsis
$long = ('w' * 100)
$out = Invoke-Feedback @('-Description', $long, '-Target', $plain, '-OutDir', $outDir) $pathWithGh
$ok = (Assert-Text 'A5 default title truncates a long first line' $out @('(?m)^\s*title:\s*\[upstream-report\] acme/widget: w{67}…\s*$') @('w{70}')) -and $ok

# =================================================================================================
# B. DRAFT mode — a scaffolded repo with a hand-patched toolchain file (the #55 shape)
# =================================================================================================
$scaff = Join-Path $fx 'scaff'
New-Item -ItemType Directory -Force -Path $scaff | Out-Null
Invoke-GitQ $scaff @('-c', 'init.defaultBranch=main', 'init', '-q')
Invoke-GitQ $scaff @('config', 'user.email', 'selftest@example.invalid'); Invoke-GitQ $scaff @('config', 'user.name', 'selftest')
Invoke-GitQ $scaff @('remote', 'add', 'origin', 'git@github.com:acme/scaffolded.git')
# Real scaffold run, python OFF the PATH so the docs build is a reported skip rather than a dependency.
$env:PATH = $pathNoGh
try { & $pwshExe -NoProfile -File $initPs1 -Target $scaff 2>&1 | Out-Null; $initExit = $LASTEXITCODE } finally { $env:PATH = $savedPath }
$gatesPy = Join-Path $scaff 'scripts/harness/harness_gates.py'
$scaffReady = ($initExit -eq 0) -and (Test-Path -LiteralPath $gatesPy) -and (Test-Path -LiteralPath (Join-Path $scaff '.harness-version'))
$ok = (Assert-True 'B0 fixture: init.ps1 scaffolded the repo (stamp + vendored gate script present)' $scaffReady "init exit=$initExit") -and $ok
if ($scaffReady) {
    Invoke-GitQ $scaff @('add', '-A'); Invoke-GitQ $scaff @('commit', '-q', '-m', 'scaffold via harness-init')
    $marker = 'LOCAL-PATCH-MARKER-7f3e9a'
    Add-Content -LiteralPath $gatesPy -Value "# REPO-LOCAL: $marker — report upstream" -Encoding utf8
    Invoke-GitQ $scaff @('add', '-A'); Invoke-GitQ $scaff @('commit', '-q', '-m', 'local patch: fix gate emitter (REPO-LOCAL, report upstream)')
    # a second, UNCOMMITTED toolchain edit
    Add-Content -LiteralPath (Join-Path $scaff '.githooks/pre-commit') -Value '# uncommitted local tweak' -Encoding utf8

    $env:YWR_FAKE_GH_MODE = 'ok'; Reset-GhLog
    $out = Invoke-Feedback @('-Description', 'the emitter mislabels ungrouped files', '-Target', $scaff, '-OutDir', $outDir) $pathWithGh
    $bodyB = Get-BodyPath $out
    $textB = Read-Body $bodyB
    $ok = (Assert-Text 'B1 scaffolded + patched: nudge verdict quoted, dry run names both files, history names the local commit, marker never leaks' ("$out`n=====`n$textB") `
            @('\[hook:scaffold-refresh-nudge\]', 'scripts/harness/harness_gates\.py', '\.githooks/pre-commit',
              'harness-init -> .*\(dry run — nothing written\)', '~ scripts/harness/harness_gates\.py \(toolchain refreshed from canon\)',
              '## Local history', '(?m)^scripts/harness/harness_gates\.py$', 'local patch: fix gate emitter',
              '(?m)^\.githooks/pre-commit · uncommitted changes present$', '2 toolchain file\(s\) a re-run would change: `\.githooks/pre-commit`, `scripts/harness/harness_gates\.py`',
              ('stamp: ' + [regex]::Escape($manifestVer)), 'repo: `acme/scaffolded`', 'similar open reports: none') `
            @('LOCAL-PATCH-MARKER', '@@', '\+\+\+ ', 'Traceback', 'uncommitted local tweak', 'not a scaffolded repo') `
            @($(if ($script:Exit -ne 0) { "exit $script:Exit (want 0)" }), $(if (-not $bodyB) { 'no body: line' }))) -and $ok
    $calls = Get-GhCalls
    $listCall = @($calls | Where-Object { $_ -match "^issue$([char]0x1F)list" })
    $ok = (Assert-True 'B1b the fingerprint search asked gh for open upstream-report issues on the dist repo' `
            ($listCall.Count -eq 1 -and $listCall[0] -match 'orcait-co/ywr-harness' -and $listCall[0] -match 'upstream-report' -and $listCall[0] -match '"fb[0-9a-f]{10}"' -and $listCall[0] -match "--state$([char]0x1F)open") "calls: $($calls -join ' | ')") -and $ok

    # B2: a similar report exists -> named on the summary line (informational, exit still 0)
    $env:YWR_FAKE_GH_MODE = 'similar'; Reset-GhLog
    $out = Invoke-Feedback @('-Description', 'again', '-Target', $scaff, '-OutDir', $outDir) $pathWithGh
    $ok = (Assert-Text 'B2 a matching open report is named, drafting still succeeds' $out `
            @('similar open reports: #12 \[upstream-report\] acme/widget: same drift', '(?m)^\s*body:') @('NOT CHECKED') `
            @($(if ($script:Exit -ne 0) { "exit $script:Exit (want 0)" }))) -and $ok

    # B3: gh absent -> the search is reported NOT CHECKED, never silently 'none'
    if ($noGhOk) {
        $out = Invoke-Feedback @('-Description', 'again', '-Target', $scaff, '-OutDir', $outDir) $pathNoGh
        $ok = (Assert-Text 'B3 without gh the similarity search says NOT CHECKED' $out `
                @('similar open reports: NOT CHECKED \(gh absent or not authenticated\)') @('similar open reports: none') `
                @($(if ($script:Exit -ne 0) { "exit $script:Exit (want 0)" }))) -and $ok
    }

    # B4: the dry run's guarded marker-less refusal is FOREIGN, not drift (the canon's own post-commit shape)
    $pc = Join-Path $scaff '.githooks/post-commit'
    Set-Content -LiteralPath $pc -Value "#!/bin/sh`necho foreign hook" -Encoding utf8
    $out = Invoke-Feedback @('-Description', 'foreign', '-Target', $scaff, '-OutDir', $outDir) $pathWithGh
    $textB4 = Read-Body (Get-BodyPath $out)
    $ok = (Assert-Text 'B4 a marker-less post-commit is listed as foreign, not counted as a file a re-run would change' $textB4 `
            @('refused as foreign and left alone \(not drift\): `\.githooks/post-commit`', '2 toolchain file\(s\) a re-run would change') `
            @('3 toolchain file')) -and $ok

    # B5: a full search page -> the search cap is STATED (review 2026-08-28, low)
    $env:YWR_FAKE_GH_MODE = 'many'; Reset-GhLog
    $out = Invoke-Feedback @('-Description', 'many', '-Target', $scaff, '-OutDir', $outDir) $pathWithGh
    $ok = (Assert-Text 'B5 a full page of similar reports states the search cap' $out `
            @('similar open reports: #1 dup 1 · .*#20 dup 20 \(search capped at 20 — more may exist\)') @('NOT CHECKED') `
            @($(if ($script:Exit -ne 0) { "exit $script:Exit (want 0)" }))) -and $ok

    # B6: markdown-hostile repo text never becomes live markdown (review 2026-08-28, medium x2) — a commit
    # subject carrying a triple-backtick run and an image link, a branch name carrying a backtick: the
    # history block's fence grows to 4 backticks, the subject is quoted verbatim INSIDE it, the branch
    # loses its backtick inside the inline code span.
    $env:YWR_FAKE_GH_MODE = 'ok'; Reset-GhLog
    $tick3 = '`' * 3
    Invoke-GitQ $scaff @('checkout', '-q', '-b', 'fix/a`b')
    Add-Content -LiteralPath $gatesPy -Value '# second local edit' -Encoding utf8
    Invoke-GitQ $scaff @('add', '-A'); Invoke-GitQ $scaff @('commit', '-q', '-m', "close ${tick3} early ![x](http://evil.invalid/track) ## forged heading")
    $out = Invoke-Feedback @('-Description', 'hostile', '-Target', $scaff, '-OutDir', $outDir) $pathWithGh
    $textB6 = Read-Body (Get-BodyPath $out)
    $fenceLine = '`' * 4
    $ok = (Assert-Text 'B6 hostile commit subject and branch: 4-backtick fence, subject verbatim inside it, branch backtick neutralised' $textB6 `
            @(('(?m)^' + [regex]::Escape($fenceLine) + '$'), 'close ' + [regex]::Escape($tick3) + ' early !\[x\]\(http://evil\.invalid/track\) ## forged heading', 'branch `fix/a b`') `
            @('branch `fix/a`b`', '(?m)^## forged heading') `
            @($(if ($script:Exit -ne 0) { "exit $script:Exit (want 0)" }))) -and $ok
    # the 4-backtick fence must OPEN and CLOSE around the history (two lines), so the subject's own
    # triple-backtick run cannot terminate the block early
    $fenceCount = ([regex]::Matches($textB6, '(?m)^' + [regex]::Escape($fenceLine) + '$')).Count
    $ok = (Assert-True 'B6b exactly two 4-backtick fence lines (open + close) around the history block' ($fenceCount -eq 2) "count=$fenceCount") -and $ok

    # B7: init.ps1 refuses a DOWNGRADE (stamp newer than this copy, ADR 0042) -> the dry run exits 1
    # before comparing -> drift is UNKNOWN, never "none" (review 2026-08-28, high)
    Set-Content -LiteralPath (Join-Path $scaff '.harness-version') -Value '99.0.0' -Encoding ascii
    Reset-GhLog
    $out = Invoke-Feedback @('-Description', 'downgrade', '-Target', $scaff, '-OutDir', $outDir) $pathWithGh
    $textB7 = Read-Body (Get-BodyPath $out)
    $ok = (Assert-Text 'B7 downgrade-refused dry run -> drift UNKNOWN, search not run, REFUSED text quoted' ("$out`n=====`n$textB7") `
            @('toolchain drift: UNKNOWN — init\.ps1 -DryRun exited 1 before comparing', 'similar open reports: not searched \(drift UNKNOWN', 'REFUSED — this repo.s toolchain was last scaffolded by ywr-harness v99\.0\.0', 'stamp: 99\.0\.0') `
            @('none — a re-run would change nothing', 'toolchain file\(s\) a re-run would change') `
            @($(if ($script:Exit -ne 0) { "exit $script:Exit (want 0)" }))) -and $ok
    $ok = (Assert-True 'B7b no gh search was attempted while drift is UNKNOWN' (@((Get-GhCalls) | Where-Object { $_ -match "^issue$([char]0x1F)list" }).Count -eq 0) "calls: $((Get-GhCalls) -join ' | ')") -and $ok
} else {
    Write-Host 'SKIP — B1–B7 not run: the scaffold fixture did not build' -ForegroundColor Yellow
}

# =================================================================================================
# F. FILE mode — every gh outcome
# =================================================================================================
$fileBody = Join-Path $fx 'reviewed.md'
Set-Content -LiteralPath $fileBody -Value "<!-- title: [upstream-report] acme/widget: reviewed title -->`n## Report`n`nreviewed body text`n" -Encoding utf8

# F1: gh absent -> NOT FILED, exit 2, by-hand URL, body kept
if ($noGhOk) {
    $out = Invoke-Feedback @('-File', '-BodyPath', $fileBody) $pathNoGh
    $ok = (Assert-Text 'F1 gh absent -> exit 2, NOT FILED, by-hand URL, body kept' $out `
            @('NOT FILED — gh is not on PATH', 'https://github\.com/orcait-co/ywr-harness/issues/new', 'title: \[upstream-report\] acme/widget: reviewed title', 'label: upstream-report') `
            @('filed: https') `
            @($(if ($script:Exit -ne 2) { "exit $script:Exit (want 2)" }), $(if (-not (Test-Path -LiteralPath $fileBody)) { 'body file was removed' }))) -and $ok
}

# F2: gh ok -> filed with label; the create call carries repo, title, body file and label
$env:YWR_FAKE_GH_MODE = 'ok'; Reset-GhLog
$out = Invoke-Feedback @('-File', '-BodyPath', $fileBody) $pathWithGh
$calls = Get-GhCalls
$create = @($calls | Where-Object { $_ -match "^issue$([char]0x1F)create" })
$filedCopy = "$fileBody.filed.md"
$filedText = if (Test-Path -LiteralPath $filedCopy) { [IO.File]::ReadAllText($filedCopy) } else { '' }
$ok = (Assert-Text 'F2 gh ok -> filed: URL, exit 0' $out @('filed: https://github\.com/orcait-co/ywr-harness/issues/999') @('NOT FILED', 'label: .* is absent') `
        @($(if ($script:Exit -ne 0) { "exit $script:Exit (want 0)" }))) -and $ok
$ok = (Assert-True 'F2b the create call: -R orcait-co/ywr-harness, -t <title>, -F <reviewed>.filed.md, -l upstream-report; auth + label preflight ran first' `
        ($create.Count -eq 1 -and $create[0] -match "-R$([char]0x1F)orcait-co/ywr-harness" -and $create[0] -match "-t$([char]0x1F)\[upstream-report\] acme/widget: reviewed title" `
         -and $create[0] -match "-F$([char]0x1F)[^$([char]0x1F)]*reviewed\.md\.filed\.md" -and $create[0] -match "-l$([char]0x1F)upstream-report" `
         -and ($calls[0] -match '^auth') -and (@($calls | Where-Object { $_ -match '^label' }).Count -eq 1)) "calls: $($calls -join ' | ')") -and $ok
$ok = (Assert-Text 'F2c the filed body is the reviewed file minus the title line' $filedText @('^## Report', 'reviewed body text') @('<!-- title')) -and $ok

# F3: label absent on the target -> filed WITHOUT -l, and said
$env:YWR_FAKE_GH_MODE = 'nolabel'; Reset-GhLog
$out = Invoke-Feedback @('-File', '-BodyPath', $fileBody) $pathWithGh
$create = @((Get-GhCalls) | Where-Object { $_ -match "^issue$([char]0x1F)create" })
$ok = (Assert-Text 'F3 label absent -> still filed, the absence is printed' $out @("label: 'upstream-report' is absent on orcait-co/ywr-harness", 'filed: https') @('NOT FILED') `
        @($(if ($script:Exit -ne 0) { "exit $script:Exit (want 0)" }))) -and $ok
$ok = (Assert-True 'F3b the create call carries no -l when the label is absent' ($create.Count -eq 1 -and $create[0] -notmatch "-l$([char]0x1F)") "create: $($create -join ' | ')") -and $ok

# F4: gh unauthenticated -> NOT FILED, exit 2, no create attempted
$env:YWR_FAKE_GH_MODE = 'unauth'; Reset-GhLog
$out = Invoke-Feedback @('-File', '-BodyPath', $fileBody) $pathWithGh
$ok = (Assert-Text 'F4 gh unauthenticated -> exit 2, NOT FILED names the auth failure' $out @('NOT FILED — gh is not authenticated', 'issues/new') @('filed: https') `
        @($(if ($script:Exit -ne 2) { "exit $script:Exit (want 2)" }))) -and $ok
$ok = (Assert-True 'F4b no create call was attempted while unauthenticated' (@((Get-GhCalls) | Where-Object { $_ -match "^issue$([char]0x1F)create" }).Count -eq 0) "calls: $((Get-GhCalls) -join ' | ')") -and $ok

# F5: create fails -> exit 2, gh's own text quoted, no retry
$env:YWR_FAKE_GH_MODE = 'createfail'; Reset-GhLog
$out = Invoke-Feedback @('-File', '-BodyPath', $fileBody) $pathWithGh
$ok = (Assert-Text 'F5 create failure -> exit 2, NOT FILED quotes gh, by-hand URL' $out @('NOT FILED — gh issue create exited 1', 'Resource not accessible', 'issues/new') @('filed: https') `
        @($(if ($script:Exit -ne 2) { "exit $script:Exit (want 2)" }))) -and $ok
$ok = (Assert-True 'F5b exactly one create attempt — no blind retry' (@((Get-GhCalls) | Where-Object { $_ -match "^issue$([char]0x1F)create" }).Count -eq 1) "calls: $((Get-GhCalls) -join ' | ')") -and $ok

# F6: -File without -BodyPath -> exit 1 (usage), nothing called
Reset-GhLog
$out = Invoke-Feedback @('-File') $pathWithGh
$ok = (Assert-Text 'F6 -File without -BodyPath is a usage error' $out @('FAIL — -File needs -BodyPath') @('filed:', 'NOT FILED') `
        @($(if ($script:Exit -ne 1) { "exit $script:Exit (want 1)" }), $(if ((Get-GhCalls).Count) { 'gh was called' }))) -and $ok

# F7: -Repo override reaches the create call (the test seam the ADR names)
$env:YWR_FAKE_GH_MODE = 'ok'; Reset-GhLog
$out = Invoke-Feedback @('-File', '-BodyPath', $fileBody, '-Repo', 'acme/other') $pathWithGh
$create = @((Get-GhCalls) | Where-Object { $_ -match "^issue$([char]0x1F)create" })
$ok = (Assert-True 'F7 -Repo override is what gh is asked to file on' ($create.Count -eq 1 -and $create[0] -match "-R$([char]0x1F)acme/other") "create: $($create -join ' | ')") -and $ok

# F8: a body with no title line and no -Title -> exit 1
$noTitle = Join-Path $fx 'notitle.md'
Set-Content -LiteralPath $noTitle -Value "## Report`nbody only`n" -Encoding utf8
$out = Invoke-Feedback @('-File', '-BodyPath', $noTitle) $pathWithGh
$ok = (Assert-Text 'F8 no title anywhere -> exit 1' $out @('FAIL — no title') @('filed:') @($(if ($script:Exit -ne 1) { "exit $script:Exit (want 1)" }))) -and $ok

# =================================================================================================
# S. SKILL.md contract lines
# =================================================================================================
$skill = Get-Content -LiteralPath $skillMd -Raw
$ok = (Assert-Text 'S1 SKILL.md: user-invoked only, namespaced references, both script modes named, the never-list' $skill `
        @('(?m)^disable-model-invocation: true', '/ywr-harness:feedback', 'feedback\.ps1" -Description', 'feedback\.ps1" -File -BodyPath', 'Never files without step 3', 'Never includes file contents or diffs', 'Never runs `/ywr-harness:harness-init`') `
        @('`/feedback`', '`/harness-init`')) -and $ok

# --- META: the harness itself must be able to fail ------------------------------------------------
$meta = (Assert-Text 'META probe' 'abc' @('zzz') @() 6>$null)
$ok = (Assert-True 'META a MustMatch miss is reported as a failure' (-not $meta) 'Assert-Text passed on a non-matching text') -and $ok

$env:PATH = $savedPath; $env:YWR_FAKE_GH_MODE = $savedMode; $env:YWR_FAKE_GH_LOG = $savedLog
Remove-FixtureRoot $fx
if ($ok) { Write-Host 'feedback.selftest: all cases passed' -ForegroundColor Green; exit 0 }
Write-Host 'feedback.selftest: FAILED' -ForegroundColor Red; exit 1
