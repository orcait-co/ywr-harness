# pwsh 7 is the plugin's documented prerequisite (README §Prerequisites); refuse 5.1 explicitly
# rather than failing on a .NET 5+ surface halfway through (issue #51's class).
#Requires -Version 7.0

# ywr-harness:feedback — the member-side half of the upstream feedback loop (ADR 0064, spec 0013).
#
# Two modes, and the split IS the contract:
#
#   DRAFT (default)        gather the report, write it to ONE scratch file, print where it is and
#                          the exact command that files it. Nothing leaves the machine.
#   FILE  (-File -BodyPath) file THAT file — the one the member has read — as an issue on the
#                          public dist repo with the triage label. The body is never regenerated
#                          here: what was shown is what is filed.
#
# What the body carries is decided in ADR 0064: the member's description verbatim; the running
# and registered plugin versions; `claude --version`; OS + pwsh; the repo as owner/repo (parsed
# from origin — NEVER the URL, which can carry credentials); the refresh-nudge hook's verdict
# VERBATIM (the hook is invoked with a synthetic SessionStart payload — it writes nothing and
# exits 0 by contract, ADR 0033); `init.ps1 -DryRun` output VERBATIM (writes nothing, spec 0009);
# the local git history of every file the dry run would change; a fingerprint for dedupe. Both
# readers are called as black boxes on purpose — the placement map lives in init.ps1 and the
# hook's header forbids a second copy, so this script owns none of that logic.
#
# What it never does: include diff text (the tracker is PUBLIC — ADR 0064 option E), run
# harness-init, file without -File, retry a failed filing, or fall silent: `gh` absent or
# unauthenticated is a printed NOT FILED with the body kept and the by-hand URL (ADR 0012's
# shape — the script prints, the member acts).
#
# Exit codes: 0 = drafted / filed · 1 = usage or fatal (nothing useful produced) ·
#             2 = NOT FILED (body kept; gh absent, unauthenticated, or the create failed)

[CmdletBinding()]
param(
    # The member's description of the defect or request. Required in DRAFT mode.
    [string]$Description = '',
    # Issue title. Default: "[upstream-report] <owner/repo>: <first line of the description>".
    [string]$Title = '',
    # Repo to report ABOUT (any path inside it). Defaults to the current directory.
    [string]$Target = '.',
    # FILE mode: file the body at -BodyPath. Without this switch nothing leaves the machine.
    [switch]$File,
    # FILE mode: the body file DRAFT wrote (first line `<!-- title: … -->`). Required with -File.
    [string]$BodyPath = '',
    # Where reports go. A plugin constant — the plugin has one upstream — overridable for tests.
    [string]$Repo = 'orcait-co/ywr-harness',
    # Triage label the canon inbox lists. Preflighted; dropped with a note when the repo lacks it.
    [string]$Label = 'upstream-report',
    # DRAFT mode: directory for the body file. Default: the system temp directory.
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
# pwsh 7.4+ turns a non-zero NATIVE exit code into a terminating error under Stop; every native
# call below reads $LASTEXITCODE deliberately (git with no remote, gh unauthenticated, init.ps1
# refusing). Handoff fact 11.
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$pluginRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$pwshExe = (Get-Command pwsh).Source
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
$ghCmd = Get-Command gh -ErrorAction SilentlyContinue

function Say([string]$m, [string]$Color = 'Gray') { Write-Host $m -ForegroundColor $Color }
function Invoke-GitLines([string[]]$GitArgs) {
    # Parsed git output goes through one boundary with quotepath off (CLAUDE.md's git rule).
    # Callers wrap the call in @(): `return @(one item)` unrolls to a scalar, and [0] on a
    # string is a CHAR (measured on the first smoke run — 'Char does not contain Trim').
    if (-not $gitCmd) { return @() }
    try {
        $out = @(& $gitCmd.Source -c core.quotepath=false @GitArgs 2>$null)
        if ($LASTEXITCODE -ne 0) { return @() }
        return @($out | ForEach-Object { [string]$_ })
    } catch { return @() }
}
function Test-GhUsable() {
    # `gh` on PATH AND authenticated. `gh auth status` exits non-zero when no account is logged
    # in; its text is not parsed — only the code.
    if (-not $ghCmd) { return $false }
    try { & $ghCmd.Source auth status 2>&1 | Out-Null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}
function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
}
# Repo-derived text is NEVER live markdown on the public tracker (review 2026-08-28, medium x2): every
# quoted block goes inside a code fence one backtick longer than the longest backtick run it contains
# (a subject line carrying a triple-backtick run cannot close the fence early), and every inline value
# has backticks and line breaks replaced so it cannot leave its code span or forge a line.
function Fence([string]$Text) {
    $n = 3
    foreach ($m in [regex]::Matches($Text, '`+')) { if ($m.Length -ge $n) { $n = $m.Length + 1 } }
    $f = '`' * $n
    return "$f`n$Text`n$f"
}
function Inline([string]$Text) { return ((([string]$Text) -replace '[`\r\n]', ' ').Trim()) }

# =================================================================================================
# FILE mode
# =================================================================================================
if ($File) {
    if (-not $BodyPath) { Say 'FAIL — -File needs -BodyPath <the body DRAFT wrote>; the reviewed file is what gets filed, never a regenerated one (ADR 0064).' Red; exit 1 }
    if (-not (Test-Path -LiteralPath $BodyPath -PathType Leaf)) { Say "FAIL — body file not found: $BodyPath" Red; exit 1 }
    $raw = [IO.File]::ReadAllText($BodyPath, [Text.UTF8Encoding]::new($false))
    $lines = $raw -split "`r?`n"
    $fileTitle = $Title
    $bodyStart = 0
    if ($lines.Count -and $lines[0] -match '^<!--\s*title:\s*(.+?)\s*-->\s*$') {
        if (-not $fileTitle) { $fileTitle = $Matches[1] }
        $bodyStart = 1
    }
    if (-not $fileTitle) { Say 'FAIL — no title: the body has no `<!-- title: … -->` first line and -Title was not given.' Red; exit 1 }
    $body = (($lines | Select-Object -Skip $bodyStart) -join "`n").TrimStart("`n")
    if (-not $body.Trim()) { Say "FAIL — body is empty after the title line: $BodyPath" Red; exit 1 }
    $issuesNew = "https://github.com/$Repo/issues/new"

    if (-not (Test-GhUsable)) {
        $why = if ($ghCmd) { 'gh is not authenticated (gh auth status failed)' } else { 'gh is not on PATH' }
        Say "  NOT FILED — $why. Body kept at: $BodyPath" Yellow
        Say "  File it by hand: $issuesNew  (title: $fileTitle · label: $Label)" Yellow
        exit 2
    }

    # Label preflight — a missing label must never block a report; it is dropped and SAID.
    $useLabel = $false
    try {
        $lj = & $ghCmd.Source label list -R $Repo --json name --limit 200 2>&1
        if ($LASTEXITCODE -eq 0) {
            $names = @(($lj | Out-String | ConvertFrom-Json) | ForEach-Object { [string]$_.name })
            $useLabel = ($names -contains $Label)
        }
    } catch { $useLabel = $false }
    if (-not $useLabel) { Say "  label: '$Label' is absent on $Repo (or the label list failed) — filing without it, said here so the inbox knows to look" Yellow }

    # The body handed to gh is the reviewed file minus its title line — written beside it so the
    # reviewed file itself stays untouched as the member's record.
    $filedPath = "$BodyPath.filed.md"
    Write-Utf8NoBom $filedPath ($body + "`n")
    $ghArgs = @('issue', 'create', '-R', $Repo, '-t', $fileTitle, '-F', $filedPath)
    if ($useLabel) { $ghArgs += @('-l', $Label) }
    $out = @(& $ghCmd.Source @ghArgs 2>&1 | ForEach-Object { [string]$_ })
    $code = $LASTEXITCODE
    $url = @($out | Where-Object { $_ -match '^https://\S+/issues/\d+' } | Select-Object -Last 1)
    if ($code -eq 0 -and $url.Count) {
        Say "  filed: $($url[0])" Green
        exit 0
    }
    Say "  NOT FILED — gh issue create exited $code$(if ($out.Count) { ': ' + (($out | Select-Object -First 3) -join ' | ') })" Yellow
    Say "  Body kept at: $BodyPath — file it by hand: $issuesNew  (title: $fileTitle · label: $Label)" Yellow
    exit 2
}

# =================================================================================================
# DRAFT mode
# =================================================================================================
if (-not $Description.Trim()) {
    Say 'FAIL — a report needs a description: -Description "<what is wrong or missing, and what you expected>"' Red
    exit 1
}
try { $target = (Resolve-Path -LiteralPath $Target -ErrorAction Stop).Path } catch { Say "FAIL — target not found: $Target" Red; exit 1 }
if (-not (Test-Path -LiteralPath $target -PathType Container)) { Say "FAIL — target is not a directory: $target" Red; exit 1 }
$root = $target
$top = @(Invoke-GitLines @('-C', $target, 'rev-parse', '--show-toplevel'))
if ($top.Count -and $top[0].Trim()) { $root = $top[0].Trim() }

# --- environment -----------------------------------------------------------------------------------
$runVer = 'unreadable'
try {
    $mf = Get-Content -LiteralPath (Join-Path $pluginRoot '.claude-plugin/plugin.json') -Raw | ConvertFrom-Json
    if ($mf.version -is [string] -and $mf.version -match '\d') { $runVer = "v$($mf.version)" }
} catch { }

# Registered installs — the registry is self-located from this copy's path when it is a cache
# install (<plugins>/cache/<marketplace>/<name>/<version>, registry at <plugins>/installed_plugins.json
# — the refresh nudge's probe, ADR 0039), else the config dir's. UNDOCUMENTED file, read best-effort.
$registered = @()
$regPaths = [System.Collections.Generic.List[string]]::new()
try {
    $rr = [IO.Path]::GetFullPath($pluginRoot).TrimEnd('\', '/')
    $cacheDir = Split-Path (Split-Path (Split-Path $rr -Parent) -Parent) -Parent
    if ($cacheDir -and (Split-Path $cacheDir -Leaf) -eq 'cache') { $regPaths.Add((Join-Path (Split-Path $cacheDir -Parent) 'installed_plugins.json')) }
} catch { }
if ($env:CLAUDE_CONFIG_DIR) { $regPaths.Add((Join-Path $env:CLAUDE_CONFIG_DIR 'plugins/installed_plugins.json')) }
$regPaths.Add((Join-Path $HOME '.claude/plugins/installed_plugins.json'))
$regRead = ''
foreach ($rp in $regPaths) {
    if (-not (Test-Path -LiteralPath $rp -PathType Leaf)) { continue }
    try {
        $reg = Get-Content -LiteralPath $rp -Raw | ConvertFrom-Json
        foreach ($prop in @($reg.plugins.PSObject.Properties)) {
            if ($prop.Name -notlike 'ywr-harness@*') { continue }
            foreach ($e in @($prop.Value)) {
                $v = if ($e.version -is [string] -and $e.version -match '\d') { 'v' + (([string]$e.version) -replace '^v', '') } else { 'version unknown' }
                $registered += "$v ($($prop.Name), scope $([string]$e.scope))"
            }
        }
        $regRead = $rp
        break
    } catch { }
}
$registeredLine = if ($registered.Count) { $registered -join ' · ' } elseif ($regRead) { 'none (registry read, no ywr-harness entry — a --plugin-dir or in-tree copy is running)' } else { 'registry not found (a --plugin-dir or in-tree copy is running)' }

$claudeVer = 'not on PATH (a wrapper account may run it under another name — say which in the description)'
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($claudeCmd) {
    try { $cv = @(& $claudeCmd.Source --version 2>&1 | Select-Object -First 1); if ($cv.Count) { $claudeVer = ([string]$cv[0]).Trim() } } catch { $claudeVer = 'on PATH, --version failed' }
}
$osLine = "$([System.Environment]::OSVersion.VersionString) · pwsh $($PSVersionTable.PSVersion)"

# Repo identity — owner/repo ONLY. A remote URL can embed a token (https://user:token@host/…);
# the URL itself is never written into the body.
$repoId = '(no origin remote) ' + (Inline (Split-Path $root -Leaf))
$origin = @(Invoke-GitLines @('-C', $root, 'remote', 'get-url', 'origin'))
if ($origin.Count -and $origin[0]) {
    # Two gates: the path shape, then GitHub's name alphabet — anything else (a backtick, a bracket,
    # a space) is not a repo id and must not reach the body as one (review 2026-08-28).
    # (Captured into $cand first: a second -match REPLACES $Matches — the first cut read empty groups.)
    $cand = ''
    if ($origin[0] -match '[:/]([^/:\s]+)/([^/\s]+?)(\.git)?/?$') { $cand = "$($Matches[1])/$($Matches[2])" }
    if ($cand -and $cand -match '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { $repoId = $cand }
    else { $repoId = '(unrecognized remote shape) ' + (Inline (Split-Path $root -Leaf)) }
}
$branch = '(no git)'
$br = @(Invoke-GitLines @('-C', $root, 'rev-parse', '--abbrev-ref', 'HEAD'))
if ($br.Count -and $br[0]) { $branch = $br[0].Trim() }

$stampDisp = '(none)'
$stampPath = Join-Path $root '.harness-version'
$hasStamp = Test-Path -LiteralPath $stampPath -PathType Leaf
if ($hasStamp) {
    try {
        # Bounded read, same reason as the nudge's probe: a stamp is one short token.
        $fs = [IO.File]::OpenRead($stampPath)
        try { $buf = [byte[]]::new(64); $n = $fs.Read($buf, 0, 64) } finally { $fs.Dispose() }
        $off = if ($n -ge 3 -and $buf[0] -eq 0xEF -and $buf[1] -eq 0xBB -and $buf[2] -eq 0xBF) { 3 } else { 0 }
        $t = [System.Text.Encoding]::ASCII.GetString($buf, $off, $n - $off)
        $cut = $t.IndexOfAny(@([char]"`r", [char]"`n")); if ($cut -ge 0) { $t = $t.Substring(0, $cut) }
        $stampDisp = if ($t.Trim()) { $t.Trim() } else { '(empty file)' }
    } catch { $stampDisp = '(unreadable)' }
}

# --- scaffold drift — two existing readers, quoted verbatim, never re-implemented ------------------
$scaffolded = $hasStamp -or (Test-Path -LiteralPath (Join-Path $root 'scripts/harness') -PathType Container)
$nudgeText = '(not a scaffolded repo — no `scripts/harness/` and no `.harness-version`; the nudge and the dry run were not run)'
$dryRunText = $nudgeText
$dryRunCapNote = ''
$drifted = [System.Collections.Generic.List[string]]::new()
$foreign = [System.Collections.Generic.List[string]]::new()
# The dry run can stop BEFORE comparing anything — init.ps1 refuses a downgrade (repo stamp newer than
# this copy, ADR 0042) with four lines and exit 1, so an empty drifted set means UNKNOWN, not "none"
# (review 2026-08-28, high). Known only when init exited 0 AND printed its per-file summary line.
$driftKnown = $false
$drCode = -1
if ($scaffolded) {
    $hook = Join-Path $pluginRoot 'hooks/session-start-scaffold-refresh-nudge.ps1'
    if (Test-Path -LiteralPath $hook -PathType Leaf) {
        $payload = @{ hook_event_name = 'SessionStart'; session_id = 'ywr-harness-feedback'; source = 'startup'; cwd = $root } | ConvertTo-Json -Compress
        try {
            $ho = ($payload | & $pwshExe -NoProfile -ExecutionPolicy Bypass -File $hook 2>&1 | Out-String).Trim()
            if (-not $ho) { $nudgeText = '(silent — the refresh nudge reported no toolchain drift for this repo against the running plugin copy)' }
            else {
                try { $hj = $ho | ConvertFrom-Json; $nudgeText = [string]$hj.systemMessage; if (-not $nudgeText) { $nudgeText = "(hook spoke without a systemMessage: $ho)" } }
                catch { $nudgeText = "(hook output was not JSON — quoted as-is) $ho" }
            }
        } catch { $nudgeText = "(hook invocation failed: $($_.Exception.Message))" }
    } else { $nudgeText = '(this plugin copy has no hooks/session-start-scaffold-refresh-nudge.ps1 — installed copy inconsistent)' }

    $init = Join-Path $pluginRoot 'skills/harness-init/init.ps1'
    if (Test-Path -LiteralPath $init -PathType Leaf) {
        try {
            Push-Location -LiteralPath $root
            try { $dr = @(& $pwshExe -NoProfile -ExecutionPolicy Bypass -File $init -Target $root -DryRun 2>&1 | ForEach-Object { [string]$_ }); $drCode = $LASTEXITCODE }
            finally { Pop-Location }
            # Two of init.ps1's line shapes name a file that DIFFERS from its template: `~ <f> (…)`
            # (would be refreshed / replaced) and the first-run collision refusal (ADR 0055). The
            # GUARDED marker-less refusal is different — a foreign file the scaffold leaves alone and
            # the nudge is silent on by design (ADR 0033) — so it is listed as foreign, not as drift
            # (the first smoke run counted the canon's own post-commit as "would change").
            foreach ($ln in $dr) {
                if ($ln -match '^\s*~\s+(\S+)\s+\(') { $drifted.Add($Matches[1]) }
                elseif ($ln -match '^\s*!\s+(\S+)\s+REFUSED — first run') { $drifted.Add($Matches[1]) }
                elseif ($ln -match '^\s*!\s+(\S+)\s+REFUSED') { $foreign.Add($Matches[1]) }
            }
            $driftKnown = ($drCode -eq 0) -and [bool]@($dr | Where-Object { $_ -match '^\s*created=\d+ refreshed=\d+' }).Count
            $shown = @($dr | Select-Object -First 80)
            if ($dr.Count -gt $shown.Count) { $dryRunCapNote = "`n(… $($dr.Count - $shown.Count) more lines not shown — capped at 80)" }
            $dryRunText = ($shown -join "`n") + $dryRunCapNote
            if ($drCode -ne 0) { $dryRunText = "(init.ps1 -DryRun exited $drCode — output quoted as-is)`n" + $dryRunText }
        } catch { $dryRunText = "(init.ps1 -DryRun invocation failed: $($_.Exception.Message))" }
    } else { $dryRunText = '(this plugin copy has no skills/harness-init/init.ps1 — installed copy inconsistent)' }
}

$historyLines = [System.Collections.Generic.List[string]]::new()
foreach ($f in ($drifted | Sort-Object -Unique)) {
    $lg = @(Invoke-GitLines @('-C', $root, 'log', '--oneline', '-3', '--', $f))
    $st = @(Invoke-GitLines @('-C', $root, 'status', '--porcelain', '--', $f))
    $note = if ($st.Count) { ' · uncommitted changes present' } else { '' }
    # Concatenated, not interpolated: inside "…" a backtick before $ ESCAPES the dollar, so
    # "`$f`" renders the literal text $f (measured on the first smoke run).
    # Plain text — the whole block is rendered inside a fence (Fence), so subjects and paths stay verbatim
    # and inert. (A `$f` in a "…" string would ESCAPE the dollar — measured on the first smoke run.)
    if ($lg.Count) { $historyLines.Add($f + $note); foreach ($l in $lg) { $historyLines.Add("    $l") } }
    else { $historyLines.Add($f + ' — no commit touches this path (untracked or no git)' + $note) }
}

# Fingerprint — repo + running version + the drifted set. A dedupe HINT (ADR 0064), never a block.
$fpInput = "$repoId|$runVer|" + (($drifted | Sort-Object -Unique) -join ',')
$sha = [System.Security.Cryptography.SHA256]::Create()
try { $hex = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($fpInput)) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
$fingerprint = 'fb' + $hex.Substring(0, 10)

# --- title + body ---------------------------------------------------------------------------------
if (-not $Title) {
    $first = (($Description -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1)
    $first = ([string]$first).Trim()
    if ($first.Length -gt 70) { $first = $first.Substring(0, 67).TrimEnd() + '…' }
    $Title = "[upstream-report] ${repoId}: $first"
}

$driftedList = @($drifted | Sort-Object -Unique | ForEach-Object { '`' + (Inline $_) + '`' })
$foreignList = @($foreign | Sort-Object -Unique | ForEach-Object { '`' + (Inline $_) + '`' })
$driftSummary = if (-not $scaffolded) { 'not a scaffolded repo' }
    elseif (-not $driftKnown) { "UNKNOWN — init.ps1 -DryRun exited $drCode before comparing (its output is quoted below); nothing here can say whether a re-run would change files" }
    elseif ($drifted.Count) { "$($drifted.Count) toolchain file(s) a re-run would change: " + ($driftedList -join ', ') }
    else { 'none — a re-run would change nothing' }
if ($foreign.Count) { $driftSummary += " · refused as foreign and left alone (not drift): " + ($foreignList -join ', ') }
$b = [System.Text.StringBuilder]::new()
[void]$b.AppendLine("<!-- title: $Title -->")
[void]$b.AppendLine('## Report')
[void]$b.AppendLine()
[void]$b.AppendLine($Description.Trim())
[void]$b.AppendLine()
[void]$b.AppendLine('## Environment')
[void]$b.AppendLine()
[void]$b.AppendLine("- ywr-harness running (this copy): **$(Inline $runVer)** · registered install(s): $(Inline $registeredLine)")
[void]$b.AppendLine("- claude: $(Inline $claudeVer)")
[void]$b.AppendLine("- host: $(Inline $osLine)")
[void]$b.AppendLine("- repo: ``$repoId`` · branch ``$(Inline $branch)`` · ``.harness-version`` stamp: $(Inline $stampDisp)")
[void]$b.AppendLine("- toolchain drift: $driftSummary")
[void]$b.AppendLine("- fingerprint: ``$fingerprint`` (repo · running version · drifted set — search open reports for it before filing a duplicate)")
[void]$b.AppendLine()
[void]$b.AppendLine('## Scaffold drift — refresh-nudge verdict (ADR 0033/0042, quoted verbatim)')
[void]$b.AppendLine()
[void]$b.AppendLine((Fence $nudgeText))
[void]$b.AppendLine()
[void]$b.AppendLine('## What a `harness-init` re-run would change (`init.ps1 -DryRun`, quoted verbatim)')
[void]$b.AppendLine()
[void]$b.AppendLine((Fence $dryRunText))
[void]$b.AppendLine()
if ($drifted.Count) {
    [void]$b.AppendLine('## Local history of the files a re-run would change (`git log --oneline -3`)')
    [void]$b.AppendLine()
    [void]$b.AppendLine((Fence ($historyLines -join "`n")))
    [void]$b.AppendLine()
}
[void]$b.AppendLine('---')
[void]$b.AppendLine("Drafted by ``/ywr-harness:feedback`` (ADR 0064). No file contents or diffs are included — only names, versions and commit subjects; the canon asks for a diff in this thread when it needs one.")

$outDir = if ($OutDir) { $OutDir } else { [IO.Path]::GetTempPath() }
if (-not (Test-Path -LiteralPath $outDir -PathType Container)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
$bodyFile = Join-Path $outDir ("ywr-harness-feedback-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".md")
Write-Utf8NoBom $bodyFile $b.ToString()

# --- similar open reports (informational) ----------------------------------------------------------
$similar = if ($scaffolded -and -not $driftKnown) { 'not searched (drift UNKNOWN — the dry run did not compare)' } else { 'not searched (no toolchain drift — the fingerprint would only name the repo and version)' }
$searchCap = 20
if ($drifted.Count) {
    if (Test-GhUsable) {
        try {
            $sj = & $ghCmd.Source issue list -R $Repo -l $Label --state open -S "`"$fingerprint`"" --json number,title --limit $searchCap 2>&1
            if ($LASTEXITCODE -eq 0) {
                $hits = @(($sj | Out-String | ConvertFrom-Json) | ForEach-Object { "#$($_.number) $(Inline $_.title)" })
                # The search itself is capped; a full page says so (review 2026-08-28, low — never a silent cap).
                $similar = if (-not $hits.Count) { 'none' } elseif ($hits.Count -ge $searchCap) { ($hits -join ' · ') + " (search capped at $searchCap — more may exist)" } else { $hits -join ' · ' }
            } else { $similar = "NOT CHECKED (gh issue list exited $LASTEXITCODE)" }
        } catch { $similar = "NOT CHECKED ($($_.Exception.Message))" }
    } else { $similar = 'NOT CHECKED (gh absent or not authenticated)' }
}

Say "feedback -> $root" Cyan
Say "  body: $bodyFile"
Say "  title: $Title"
Say "  drift: $driftSummary"
Say "  similar open reports: $similar"
Say "  next: read the body, then file exactly that file with:" Yellow
$repoArg = if ($Repo -ne 'orcait-co/ywr-harness') { " -Repo `"$Repo`"" } else { '' }
Say "    pwsh -NoProfile -File `"$PSCommandPath`" -File -BodyPath `"$bodyFile`"$repoArg" Yellow
exit 0
