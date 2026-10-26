# Self-test for session-start-slice-notes.mjs (ADR 0172; spec 0006 §3.2).
# Usage: pwsh plugins/ywr-harness/hooks/session-start-slice-notes.selftest.ps1
#
# Fixture provenance: the payload is the SessionStart contract of the official hooks reference (cwd +
# source; `additionalContext` joins the model's context, `systemMessage` is shown to the member; each such
# string is capped at 10,000 characters) — the same shape session-start-githooks-nudge's suite pins. The
# hook is registered with the matcher `compact`, so these cases pass `source = compact`.
#
# The cases build REAL throwaway repos under the temp root and write notes with the REAL slice_note.py:
# the hook's verdict is read from `git rev-parse` and from `slice_note.py show`, and a faked journal would
# test the fake. The one exception is the worst-case size case, which writes journal lines directly so it
# does not pay 24 `python` starts; it then checks that `show` accepted every one of them.
#
# "Python not started" is PROVEN, not assumed: a `node -r` preload wraps child_process.spawnSync and logs
# every `python` spawn to a file before forwarding it. The no-journal cases assert the log stays absent; the
# journal cases assert it exists, so a spy that never fires cannot make the first assertion vacuous. The same
# preload fakes a non-zero exit, a timeout and a spawn error, which no real python produces on demand.
# Every match-based case carries MustNotMatch as well as MustMatch (the empty-MustNotMatch class).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core + fixture lifecycle
$hook = Join-Path $PSScriptRoot 'session-start-slice-notes.mjs'
$noteScript = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/slice_note.py'
# The hook is Node (ADR 0116): absent node is a reported skip locally and a FAIL on CI.
Assert-NodeOrExit 'session-start-slice-notes'

# Resolved BEFORE any case changes $env:PATH — `& node` resolves at call time and would fail.
$nodeExe = (Get-Command node).Source
$gitCmd = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$pyCmd = Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$gitOk = [bool]$gitCmd
$pyOk = [bool]$pyCmd
if ((-not $gitOk -or -not $pyOk) -and $env:CI) {
    Write-Host "FAIL [tools]: git on PATH: $gitOk · python on PATH: $pyOk — a missing tool on CI is not a pass" -ForegroundColor Red
    exit 1
}

$script:SpyLog = ''
function Invoke-Hook([string]$Stdin, [string[]]$NodeArgs = @(), [string]$SpyMode = '') {
    $env:SLICE_SPY_MODE = $SpyMode
    try {
        $o = ($Stdin | & $nodeExe @NodeArgs $hook 2>&1 | Out-String)
        $script:HookExit = $LASTEXITCODE
    }
    finally { $env:SLICE_SPY_MODE = $null }
    return $o
}
# Envelope adapter (file-specific, per the assertion-core contract): additionalContext and systemMessage are
# parsed apart, because the contract differs per path — a note path speaks only through additionalContext, a
# failure path only through systemMessage.
function Assert-Speaks([string]$Name, [string]$Out, [bool]$WantSys, [bool]$WantCtx, [string[]]$MustMatch, [string[]]$MustNotMatch, [string]$NoNegative = '') {
    $pre = @()
    if ($script:HookExit -ne 0) { $pre += "exit $script:HookExit (want 0 — fail-open contract; SessionStart blocks nothing)" }
    $sys = ''; $ctx = ''; $evName = ''
    try {
        $j = ConvertFrom-Json $Out.Trim()
        $sys = [string]$j.systemMessage
        try { $ctx = [string]$j.hookSpecificOutput.additionalContext; $evName = [string]$j.hookSpecificOutput.hookEventName } catch { }
    }
    catch { $pre += 'stdout is not valid JSON' }
    if ($WantSys -and -not $sys) { $pre += 'no systemMessage' }
    if (-not $WantSys -and $sys) { $pre += "unexpected systemMessage: $sys" }
    if ($WantCtx -and -not $ctx) { $pre += 'no additionalContext' }
    if (-not $WantCtx -and $ctx) { $pre += 'unexpected additionalContext' }
    if ($ctx -and $evName -ne 'SessionStart') { $pre += "hookSpecificOutput.hookEventName is '$evName' (want SessionStart — the runtime drops the context otherwise)" }
    $script:LastCtx = $ctx
    $script:LastFails = Get-AssertionFailure -Text "$sys`n$ctx" -MustMatch $MustMatch -MustNotMatch $MustNotMatch `
        -NoNegative $NoNegative -PreFail $pre -Label 'output'
    return (Write-CaseVerdict -Name $Name -Fail $script:LastFails -Detail $Out)
}
function Assert-EmptyStdout([string]$Name, [string]$Out) {
    $fails = @()
    if ($script:HookExit -ne 0) { $fails += "exit $script:HookExit (want 0 — fail-open contract)" }
    # Plain stdout on exit 0 becomes session context for this event, so "silent" must mean BYTE-silent.
    if ($Out.Trim()) { $fails += "expected empty stdout, got: $($Out.Trim())" }
    if ($fails) { Write-Host "FAIL [$Name]: $($fails -join ' · ')" -ForegroundColor Red; return $false }
    Write-Host "PASS [$Name]" -ForegroundColor Green
    return $true
}
function New-Payload([hashtable]$Fields) {
    $o = @{ hook_event_name = 'SessionStart'; session_id = 'selftest'; source = 'compact' } + $Fields
    return ($o | ConvertTo-Json -Compress)
}
function Get-SpyLines { if ($script:SpyLog -and (Test-Path -LiteralPath $script:SpyLog)) { @(Get-Content -LiteralPath $script:SpyLog) } else { @() } }
function Reset-Spy { if ($script:SpyLog -and (Test-Path -LiteralPath $script:SpyLog)) { Remove-Item -LiteralPath $script:SpyLog -Force } }
function Invoke-Git([string]$Repo, [string[]]$GitArgs) {
    & git -C $Repo -c user.name=selftest -c user.email=selftest@example.invalid -c commit.gpgsign=false @GitArgs 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed in $Repo (exit $LASTEXITCODE)" }
}
function New-Repo([string]$Path) {
    & git -c init.defaultBranch=main init -q $Path 2>&1 | Out-Null
    Invoke-Git $Path @('commit', '--allow-empty', '-q', '-m', 'one')
}
function Add-Note([string]$Repo, [string]$Kind, [string]$Text) {
    $r = (& $pyCmd.Source $noteScript --repo $Repo add $Kind $Text 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "slice_note.py add failed: $r" }
}

$ok = $true
$savedPath = $env:PATH
$fx = New-FixtureRoot 'ssslicenotes-selftest'
trap { $env:PATH = $savedPath; $env:SLICE_SPY_LOG = $null; $env:SLICE_SPY_MODE = $null; Remove-FixtureRoot $fx; break }

# --- the spy preload -------------------------------------------------------------------------
# Wraps child_process.spawnSync before the hook imports it. Every `python` spawn is logged as one JSON line
# (command, args, the options the contract pins) and, in a fault mode, answered with a canned result instead
# of the real process. Anything else — the hook's git calls — goes to the real spawnSync.
$spy = Join-Path $fx 'spy.cjs'
@'
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const real = cp.spawnSync
function canned(extra) {
  return Object.assign({ status: null, signal: null, pid: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: [null, Buffer.alloc(0), Buffer.alloc(0)] }, extra)
}
cp.spawnSync = function (cmd, args, opts) {
  const base = path.basename(String(cmd)).toLowerCase()
  if (/^python[0-9.]*(\.exe)?$/.test(base)) {
    try {
      const o = opts || {}
      fs.appendFileSync(process.env.SLICE_SPY_LOG, JSON.stringify({ cmd: String(cmd), args, shell: o.shell || false, stdio: o.stdio, timeout: o.timeout, windowsHide: o.windowsHide }) + '\n')
    } catch { }
    const mode = process.env.SLICE_SPY_MODE
    if (mode === 'exit3') return canned({ status: 3 })
    if (mode === 'timeout') { const e = new Error('spawnSync python ETIMEDOUT'); e.code = 'ETIMEDOUT'; return canned({ signal: 'SIGTERM', error: e }) }
    if (mode === 'enoent') { const e = new Error('spawnSync python ENOENT'); e.code = 'ENOENT'; return canned({ error: e }) }
  }
  return real.apply(this, arguments)
}
'@ | Set-Content -LiteralPath $spy -Encoding utf8
$spyArgs = @('-r', $spy)
$script:SpyLog = Join-Path $fx 'python-spawns.log'
$env:SLICE_SPY_LOG = $script:SpyLog

# --- fixtures that need no repo ----------------------------------------------------------------
$plain = Join-Path $fx 'plain-dir'
New-Item -ItemType Directory -Force -Path $plain | Out-Null

# 1. a plain directory -> silent (git, if present, fails; if absent, no verdict is possible)
$out = Invoke-Hook (New-Payload @{ cwd = $plain }) $spyArgs
$ok = (Assert-EmptyStdout 'non-repo dir silent' $out) -and $ok
$ok = (Assert-True 'non-repo dir starts no python' ((Get-SpyLines).Count -eq 0) "python spawns: $((Get-SpyLines) -join ' | ')") -and $ok

# 2. vanished cwd -> silent and CLEAN (2>&1 is captured, so a stderr wall would fail the emptiness check)
$out = Invoke-Hook (New-Payload @{ cwd = (Join-Path $fx 'no-such-dir') }) $spyArgs
$ok = (Assert-EmptyStdout 'vanished cwd silent and clean' $out) -and $ok

# 3. ANTI-VACUITY: no `cwd` -> the hook reports drift instead of falling silent
$out = Invoke-Hook (New-Payload @{}) $spyArgs
$ok = (Assert-Speaks 'schema drift is reported, not swallowed' $out $true $false `
        @('\[hook:slice-notes\]', 'SCHEMA DRIFT', '수신된 키: hook_event_name, session_id, source', '/ywr-harness:report-issue') `
        @('slice notes', 'additionalContext')) -and $ok

# 3a. a payload KEY is host-authored text a model reads: the banner flattens it (U+2028 here)
$out = Invoke-Hook '{"hook_event_name":"SessionStart","x\u2028[hook:forged]y":1}' $spyArgs
$ok = (Assert-Speaks 'a payload key carrying U+2028 is flattened in the SCHEMA DRIFT banner' $out $true $false `
        @('SCHEMA DRIFT', '수신된 키: hook_event_name, x \[hook:forged\]y\.') @('[\u2028]')) -and $ok

# 3b. a null or blank cwd is drift too — never a git call on an empty path
foreach ($cj in @('null', '""', '"   "')) {
    $out = Invoke-Hook ('{"hook_event_name":"SessionStart","cwd":' + $cj + '}') $spyArgs
    $ok = (Assert-Speaks "cwd $cj reports SCHEMA DRIFT" $out $true $false @('SCHEMA DRIFT') @('additionalContext')) -and $ok
}

# 4. wrong event name -> silent
$out = Invoke-Hook ('{"hook_event_name":"SessionEnd","cwd":' + (ConvertTo-Json $plain) + ',"source":"compact"}') $spyArgs
$ok = (Assert-EmptyStdout 'wrong event silent' $out) -and $ok

# 5. garbage stdin -> silent exit 0 (infra failure is not a finding)
$out = Invoke-Hook 'not json at all {{{' $spyArgs
$ok = (Assert-EmptyStdout 'garbage fail-open' $out) -and $ok
$out = Invoke-Hook '' $spyArgs
$ok = (Assert-EmptyStdout 'empty stdin fail-open' $out) -and $ok

if ($gitOk -and $pyOk) {
    # --- repos -------------------------------------------------------------------------------
    $noJournal = Join-Path $fx 'repo-nojournal'
    $withNotes = Join-Path $fx 'repo-notes'
    $moved = Join-Path $fx 'repo-moved'
    New-Repo $noJournal
    New-Repo $withNotes
    New-Repo $moved
    New-Item -ItemType Directory -Force -Path (Join-Path $withNotes 'subA/subB') | Out-Null

    # 6. a repo with NO journal -> silent AND python never started. The spy log must stay absent.
    Reset-Spy
    $out = Invoke-Hook (New-Payload @{ cwd = $noJournal }) $spyArgs
    $ok = (Assert-EmptyStdout 'repo without journal silent' $out) -and $ok
    $ok = (Assert-True 'repo without journal starts no python' ((Get-SpyLines).Count -eq 0) "python spawns: $((Get-SpyLines) -join ' | ')") -and $ok

    # 7. a journal with notes at HEAD -> additionalContext carries the framing and the notes; no systemMessage.
    $hangul = [string][char]0xACB0 + [char]0xC815 + ' ' + [char]0xD55C + [char]0xAE00   # a non-ASCII note, built from code points
    Add-Note $withNotes 'decision' 'chose option D over C because the snapshot must not move'
    Add-Note $withNotes 'rejected' "dropped the tracked file ($hangul)"
    Reset-Spy
    $out = Invoke-Hook (New-Payload @{ cwd = $withNotes }) $spyArgs
    $ok = (Assert-Speaks 'journal with notes at HEAD re-injects them' $out $false $true `
            @('(?m)^These are this session''s own slice notes', 'before the context compaction', 'input never proof',
            'check each one against the tree', 'ADR 0172', 'slice notes: 2 at HEAD',
            '1\. \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ decision: chose option D over C because the snapshot must not move',
            '2\. \S+ rejected: dropped the tracked file \(' + [regex]::Escape($hangul) + '\)') `
            @('slice notes: none', 'SCHEMA DRIFT', 'FAILED', 'hook:slice-notes', "`r")) -and $ok
    $ok = (Assert-True 'the framing is the FIRST line of the context, the show output follows' ($script:LastCtx.StartsWith('These are this session') -and ($script:LastCtx -split "`n")[1].StartsWith('slice notes: 2 at HEAD')) "context starts: $($script:LastCtx.Substring(0, [Math]::Min(120, $script:LastCtx.Length)))") -and $ok
    $spyRows = @(Get-SpyLines | ForEach-Object { $_ | ConvertFrom-Json })
    $ok = (Assert-True 'the note path really ran python (the no-journal assertions above are not vacuous)' ($spyRows.Count -eq 1) "python spawns: $($spyRows.Count)") -and $ok
    if ($spyRows.Count -eq 1) {
        $p = $spyRows[0]
        $a = @($p.args | ForEach-Object { [string]$_ })
        $ok = (Assert-True 'python is spawned by absolute path, no shell, stdin ignored, windowsHide, 10 s timeout' `
                ([IO.Path]::IsPathRooted($p.cmd) -and -not $p.shell -and $p.stdio[0] -eq 'ignore' -and $p.stdio[1] -eq 'pipe' -and $p.windowsHide -eq $true -and $p.timeout -eq 10000) `
                "cmd=$($p.cmd) shell=$($p.shell) stdio=$($p.stdio -join ',') windowsHide=$($p.windowsHide) timeout=$($p.timeout)") -and $ok
        $ok = (Assert-True 'argv is <plugin>/scripts/slice_note.py --repo <top> show --max 17' `
                ($a.Count -eq 6 -and [IO.Path]::GetFullPath($a[0]) -eq [IO.Path]::GetFullPath($noteScript) -and $a[1] -eq '--repo' -and
                [IO.Path]::GetFullPath($a[2]).TrimEnd('\', '/') -eq [IO.Path]::GetFullPath($withNotes).TrimEnd('\', '/') -and
                ($a[3..5] -join ' ') -eq 'show --max 17') "argv: $($a -join ' | ')") -and $ok
    }

    # 8. a subdirectory cwd resolves the work tree root (the journal sits under the repo, not under the subdir)
    $out = Invoke-Hook (New-Payload @{ cwd = (Join-Path $withNotes 'subA/subB') }) $spyArgs
    $ok = (Assert-Speaks 'subdirectory cwd resolves the root and finds the journal' $out $false $true `
            @('slice notes: 2 at HEAD', 'chose option D') @('SCHEMA DRIFT', 'FAILED')) -and $ok

    # 9. case-drifted keys and a padded cwd read like the PowerShell original did (ADR 0116)
    $out = Invoke-Hook (@{ Hook_Event_Name = 'sessionstart'; CWD = "  $withNotes `t " } | ConvertTo-Json -Compress) $spyArgs
    $ok = (Assert-Speaks 'case-drifted keys and a padded cwd still read' $out $false $true @('slice notes: 2 at HEAD') @('SCHEMA DRIFT')) -and $ok

    # 10. BOM-prefixed stdin -> still parses
    $out = Invoke-Hook ([char]0xFEFF + (New-Payload @{ cwd = $withNotes })) $spyArgs
    $ok = (Assert-Speaks 'BOM-prefixed stdin' $out $false $true @('slice notes: 2 at HEAD') @('SCHEMA DRIFT')) -and $ok

    # 11. notes written at ANOTHER head -> `show` prints `slice notes: none`; the hook stays silent. Python DID run.
    Add-Note $moved 'decision' 'a note from the slice before the close'
    Invoke-Git $moved @('commit', '--allow-empty', '-q', '-m', 'two')
    Reset-Spy
    $out = Invoke-Hook (New-Payload @{ cwd = $moved }) $spyArgs
    $ok = (Assert-EmptyStdout 'notes all at another HEAD are silent' $out) -and $ok
    $ok = (Assert-True 'the other-HEAD case ran python (silence came from show, not from a skipped spawn)' ((Get-SpyLines).Count -eq 1) "python spawns: $((Get-SpyLines).Count)") -and $ok

    # 12. WORST CASE vs the 10,000-character cap on one hook string (hooks reference). 24 notes at HEAD, each of the
    #     longest kind and 500 characters (the maximum), plus two at another HEAD so every trailer line prints. The hook
    #     asks for the newest 17: the context must hold exactly 17 numbered lines, name the 7 left out, and stay under the cap.
    $worst = Join-Path $fx 'repo-worst'
    New-Repo $worst
    $head = (& git -C $worst rev-parse HEAD).Trim()
    $jp = Join-Path $worst '.git/ywr-harness/slice-notes.jsonl'
    New-Item -ItemType Directory -Force -Path (Split-Path $jp) | Out-Null
    $lines = @()
    foreach ($i in 1..24) {
        $lines += (@{ ts = '2026-10-26T12:00:00Z'; head = $head; kind = 'rejected'; text = ('w' * 499) + [string]($i % 10) } | ConvertTo-Json -Compress)
    }
    foreach ($i in 1..2) { $lines += (@{ ts = '2026-10-26T12:00:00Z'; head = ('0' * 40); kind = 'rejected'; text = 'elsewhere' } | ConvertTo-Json -Compress) }
    [IO.File]::WriteAllText($jp, (($lines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
    $out = Invoke-Hook (New-Payload @{ cwd = $worst }) $spyArgs
    $ok = (Assert-Speaks 'worst case: 24 maximum-length notes are capped to the newest 17' $out $false $true `
            @('slice notes: 24 at HEAD', 'slice notes: 7 older not shown \(--max 17\)', 'slice notes: 2 more at other HEADs') `
            @('slice notes: none', 'FAILED', 'not a slice note', 'elsewhere')) -and $ok
    $ctxLen = $script:LastCtx.Length
    $numbered = @([regex]::Matches($script:LastCtx, '(?m)^  \d+\. ')).Count
    $ok = (Assert-True 'worst case: the context is under the 10,000-character cap with margin and holds 17 numbered notes' `
            ($ctxLen -lt 9900 -and $numbered -eq 17) "context length $ctxLen (want < 9900; the cap is 10000) · numbered lines $numbered (want 17)") -and $ok

    # 13. fault modes the spy fakes — the real python cannot be told to time out or fail on demand. Each speaks ONE
    #     Korean systemMessage that names the failure and the `show` command, and never an additionalContext.
    foreach ($fault in @(
            @{ Mode = 'exit3'; Want = @('exit 3 로 끝났습니다') },
            @{ Mode = 'timeout'; Want = @('10초 안에 끝나지 않았습니다') },
            @{ Mode = 'enoent'; Want = @('python 실행 오류 ENOENT') })) {
        $out = Invoke-Hook (New-Payload @{ cwd = $withNotes }) $spyArgs $fault.Mode
        $ok = (Assert-Speaks "fault $($fault.Mode): one Korean systemMessage, no context" $out $true $false `
                (@('\[hook:slice-notes\]', 'repo-notes', 'python scripts/harness/slice_note\.py show', 'ADR 0172') + $fault.Want) `
                @('SCHEMA DRIFT', 'These are this session', 'chose option D')) -and $ok
    }

    # 14. python ABSENT from PATH with a journal present -> one Korean systemMessage. PATH holds git's directory
    #     only (git is needed to find the work tree); when that directory also holds a python (a Linux /usr/bin),
    #     the case cannot be built and is a reported SKIP.
    $gitDir = Split-Path $gitCmd.Source -Parent
    $pyInGitDir = [bool](Get-ChildItem -LiteralPath $gitDir -File -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -ieq 'python' })
    if ($pyInGitDir) {
        Write-Host "SKIP [14] python lives in git's directory ($gitDir), so a PATH without python cannot be built here — not run (reported, not silent)" -ForegroundColor Yellow
    }
    else {
        try {
            $env:PATH = $gitDir
            $out = Invoke-Hook (New-Payload @{ cwd = $withNotes }) @()
        }
        finally { $env:PATH = $savedPath }
        $ok = (Assert-Speaks 'python absent from PATH reports one Korean systemMessage' $out $true $false `
                @('\[hook:slice-notes\]', 'PATH에서 python을 찾을 수 없습니다', 'repo-notes', 'python scripts/harness/slice_note\.py show', 'ADR 0172') `
                @('SCHEMA DRIFT', 'These are this session', 'chose option D')) -and $ok
        # the same PATH with NO journal stays silent: the missing python is only reported when a journal asked for it
        try {
            $env:PATH = $gitDir
            $out = Invoke-Hook (New-Payload @{ cwd = $noJournal }) @()
        }
        finally { $env:PATH = $savedPath }
        $ok = (Assert-EmptyStdout 'python absent and no journal stays silent' $out) -and $ok
    }

    # 15. NON-MUTATION: the hook only reads. The journal bytes and the work tree must be unchanged by every run above.
    $status = (& git -C $withNotes status --porcelain 2>&1 | Out-String).Trim()
    $ok = (Assert-True 'non-mutation: the work tree stays clean (the journal is under .git)' (-not $status) "git status: $status") -and $ok
}
else {
    Write-Host "SKIP — git on PATH: $gitOk · python on PATH: $pyOk; the repo-dependent cases were not run (reported, not silent)" -ForegroundColor Yellow
}

# 16. the no-git branch: PATH empty for the CHILD only ($nodeExe was resolved above). A repo exists, git cannot run,
#     so the hook has no verdict and is silent. Runs on git-less machines too, where it is the ambient truth.
try {
    $env:PATH = ''
    $out = Invoke-Hook (New-Payload @{ cwd = $plain }) @()
    $ok = (Assert-EmptyStdout 'no git on PATH is silent' $out) -and $ok
}
finally { $env:PATH = $savedPath }

$env:SLICE_SPY_LOG = $null
Remove-FixtureRoot $fx

# I1. every echo goes through hook-lib: the hook imports inline(), gitRun and whichOnPath from it and carries no
#     copy of its own, and it never exits the process (hook-lib header: exiting before stdout drains truncates it).
$hookText = [IO.File]::ReadAllText($hook)
$importsLib = { param($name) $hookText -match "(?m)^import\s*\{[^}]*\b$name\b[^}]*\}\s*from\s*'\./hook-lib\.mjs'\s*$" }
$ownCopy = $hookText -match '(?m)^\s*(export\s+)?(function\s+(inline|gitRun|whichOnPath)\b|(const|let|var)\s+(inline|gitRun|whichOnPath)\s*=)'
$missing = @('inline', 'gitRun', 'whichOnPath', 'emit', 'driftKeys') | Where-Object { -not (& $importsLib $_) }
$ok = (Assert-True 'I1 the hook imports its helpers from hook-lib.mjs and defines no copy of its own' (-not $missing -and -not $ownCopy) `
        "not imported: $($missing -join ', ') · own copy present: $ownCopy") -and $ok
$ok = (Assert-True 'I2 the hook never exits the process explicitly' ($hookText -notmatch '(?m)process\.exit\s*\(' ) 'process.exit( found') -and $ok
$ok = (Assert-True 'I3 the hook spawns python without a shell and never by the bare name' `
        ($hookText -notmatch '(?m)shell\s*:\s*true' -and $hookText -notmatch "spawnSync\(\s*'python'") 'a shell option or a bare-name spawn is present') -and $ok

# R1. REGISTRATION. Every case above pipes a payload straight into the script, so none of them sees whether the
#     runtime ever calls it. This pins the wiring: SessionStart, a matcher of exactly `compact` (the matcher is
#     case-sensitive, and a wider one would spawn python on every session start — ADR 0172 option H), exec-form
#     `node <script>` (ADR 0116) and the 15 s timeout. That it FIRES is still only a live probe's to show.
$regFails = @()
try {
    $hj = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'hooks.json') -Raw | ConvertFrom-Json
    $sites = @()
    foreach ($evName in @($hj.hooks.PSObject.Properties.Name | Where-Object { $_ })) {
        foreach ($grp in @($hj.hooks.$evName | Where-Object { $_ })) {
            foreach ($h in @($grp.hooks | Where-Object { $_ })) {
                $parts = @([string]$h.command) + @($h.args | ForEach-Object { [string]$_ })
                if (($parts -join ' ') -match 'session-start-slice-notes\.mjs') { $sites += [pscustomobject]@{ Event = $evName; Matcher = [string]$grp.matcher; Group = $grp; H = $h } }
            }
        }
    }
    $wantArgs = @('${CLAUDE_PLUGIN_ROOT}/hooks/session-start-slice-notes.mjs')
    if ($sites.Count -ne 1) { $regFails += "want exactly 1 registration of session-start-slice-notes, found $($sites.Count)" }
    else {
        $s = $sites[0]
        $gotArgs = @($s.H.args | ForEach-Object { [string]$_ })
        if ($s.Event -cne 'SessionStart') { $regFails += "event '$($s.Event)' (want SessionStart)" }
        if ($s.Matcher -cne 'compact') { $regFails += "matcher '$($s.Matcher)' (want exactly 'compact' — the match is case-sensitive)" }
        if (@($s.Group.hooks).Count -ne 1) { $regFails += "the compact group holds $(@($s.Group.hooks).Count) hooks (want only this one, so no other hook rides the matcher)" }
        if ([string]$s.H.type -cne 'command' -or [string]$s.H.command -cne 'node') { $regFails += "handler type/command '$($s.H.type)'/'$($s.H.command)' (want command/node)" }
        if (($gotArgs -join "`0") -cne ($wantArgs -join "`0")) { $regFails += "args [$($gotArgs -join ' ')] (want exec form [$($wantArgs -join ' ')])" }
        else {
            $resolved = Join-Path (Split-Path $PSScriptRoot -Parent) ($gotArgs[-1] -replace '^\$\{CLAUDE_PLUGIN_ROOT\}/', '')
            if ([IO.Path]::GetFullPath($resolved) -ne [IO.Path]::GetFullPath($hook)) { $regFails += "args resolve to '$resolved', not this suite's script '$hook'" }
        }
        if ([string]$s.H.timeout -ne '15') { $regFails += "timeout '$($s.H.timeout)' (want 15)" }
    }
} catch { $regFails += "hooks.json unreadable: $($_.Exception.Message)" }
$ok = (Assert-True 'R1 hooks.json registers this script once: SessionStart, matcher exactly compact, exec-form node <script>, timeout 15' `
        (-not $regFails.Count) ($regFails -join ' · ')) -and $ok

# META — proves this file's WIRING to the shared empty-MustNotMatch guard: a wrapper that dropped the
# -MustNotMatch passthrough would leave the core intact and every case above unguarded.
$script:HookExit = 0
$metaOut = '{"systemMessage":"meta probe"}'
$accepted = Assert-Speaks 'META probe' $metaOut $true $false @('meta probe') 6>$null
if ($accepted -or $script:LastFails.Count -ne 1 -or ($script:LastFails[0] -notmatch 'no MustNotMatch')) {
    Write-Host "FAIL [META]: guard did not fire — accepted=$accepted reason='$($script:LastFails -join '; ')'" -ForegroundColor Red
    $ok = $false
}
else { Write-Host 'PASS [META]: negative-less case rejected, on the guard reason alone' -ForegroundColor Green }
if (Assert-Speaks 'META exemption honored' $metaOut $true $false @('meta probe') @() 'META: exercises the visible-exemption path so the escape hatch cannot rot unnoticed') {
    Write-Host 'PASS [META]: -NoNegative exemption honored' -ForegroundColor Green
}
else { Write-Host 'FAIL [META]: -NoNegative exemption rejected' -ForegroundColor Red; $ok = $false }

if (-not $ok) { exit 1 }
Write-Host "session-start-slice-notes selftest: all cases green$(if (-not ($gitOk -and $pyOk)) { ' (repo-dependent cases SKIPPED — no git or python)' })" -ForegroundColor Green
exit 0
