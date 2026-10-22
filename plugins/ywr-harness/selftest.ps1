# pwsh 7 required — the suites this runner spawns use PS7-only surfaces (Latin1, $IsWindows),
# and a 5.1 run would fail per-suite with unrelated-looking errors instead of one clear
# refusal (issue #51).
#Requires -Version 7.0

# Plugin selftest runner — the single entry point for everything this plugin can verify about
# itself: the manifest/wiring gate, the JS-side workflow corpus gate, then every shipped
# PowerShell selftest. The two gates run first, in that order, with their output streamed; the
# suites then run CONCURRENTLY (ADR 0088, `-Jobs`), each still its own `pwsh -NoProfile -File`
# child with stdout+stderr captured.
#
# Exit contract:
#   exit 0 = every gate that RAN passed, and at least one selftest was discovered
#   exit 1 = anything failed, OR nothing was discovered
#
# Zero discovered is a FAILURE, not a pass. A runner that reports green on an empty set is
# a gate judged from the wrong observable. Counts are always printed so a shrinking suite is
# visible rather than silent, and skips are printed as skips rather than folded into the pass
# count (a SKIP counted as a pass was the original defect).
#
# Suite output contract (ADR 0088): one live `done <rel> PASS|FAIL (<s> s, <n> PASS lines)` line
# per suite as it finishes (completion order), then the results in ordinal DISCOVERY order — a
# failed suite with its full captured output, a passing suite as ONE line plus every captured
# SIGNAL line — one that starts with SKIP, WARN, FAIL or KEEP, or with the host's Write-Warning
# label (see Get-SignalRx) — so condensing never folds a skip, a warning or a stray FAIL into the
# pass. `-Full` prints every suite's full output instead (the pre-0088 view, for debugging). The final
# `selftests: discovered= passed= failed=` line, the `all gates green` line and the exit codes
# are unchanged — CI keys on the exit code, humans on those two lines.
#
# No gate short-circuits: one run should surface every defect, not just the cheapest one.
#
# The child-output decoding pin is set here because this runner CAPTURES child
# output: without it a non-UTF-8 console codepage destroys non-ASCII in the captured text
# rather than merely garbling the display. It must stay AHEAD of the first line this script
# prints — measured 2026-09-23 in a fresh console (cp949): a pwsh whose stdout is redirected
# keeps the encoding its output writer had at its first write, so a pin set after any output
# decodes children correctly but re-emits their text in cp949. Being process-wide, it also
# covers the `-Parallel` threads, and the console code page it sets is what each suite child
# starts with, so the children write UTF-8 too.
[CmdletBinding()]
param(
    # `i/N` (1-based): run only the i-th of N deterministic slices of the discovered suites — the
    # CI matrix lever (ADR 0071). Suites are sorted by plugin-relative path (ordinal, `/`
    # separators, so the deal is identical on Windows and Linux) and dealt round-robin, so the N
    # slices PARTITION the discovery by construction: no suite list lives in the CI yaml, and a
    # new suite lands in a slice without anyone naming it. The two gates ahead of the suites
    # (manifest, workflow corpus) run in EVERY slice — they cost seconds, and a slice that skipped
    # them would not be "every gate that ran passed". A slice that selects nothing is exit 1
    # (N larger than the discovery is a matrix misconfiguration, not a pass).
    [string]$Shard = '',
    # Print the discovery and the selection, run nothing, exit 0 — the observable the runner's own
    # selftest (selftest.selftest.ps1) asserts the partition on. The last line says LIST ONLY so
    # the output can never be read as a green run. Discovery and -Shard validation still apply:
    # an empty discovery or a malformed shard is exit 1 here too.
    [switch]$List,
    # How many suites run at once (ADR 0088). Default min(logical CPUs, 8): the suites are
    # process-spawn-bound, and past 8 the slowest suite is the floor anyway. `-Jobs 1` runs them
    # one at a time in discovery order — the fallback if a suite ever proves unsafe to run beside
    # another. Composes with -Shard (the shard selects, -Jobs runs the selection). Below 1 is exit 1.
    [int]$Jobs = [Math]::Min([Environment]::ProcessorCount, 8),
    # Seconds one suite may run before it is killed with its process tree and counted FAILED
    # (ADR 0098). Without it a hung suite showed only as a missing `done` line, and on CI it held
    # the job until GitHub's 360-minute default. 900 is ~3x the slowest suite measured anywhere
    # (manifest-gate.selftest, 268–292 s at jobs=8 on the owner's box). Outside 1..86400 is exit 1.
    # It bounds the SUITES only: the two gates ahead of them and the warning-label probe run under
    # the caller's own limit (on CI, the job's timeout-minutes).
    [int]$SuiteTimeout = 900,
    # Print every suite's full captured output, in discovery order, instead of the condensed
    # one-line-per-passing-suite view. Debugging aid; the verdict and exit code do not change.
    [switch]$Full,
    # Run only the suites whose declared read set (selftest-reads.json) a changed plugin file
    # matches — the canon's local slice-close run (ADR 0157). The change is the working tree
    # against HEAD, or against -Base. The runner widens it to the full run, and prints why, when a
    # shared input changed, when no green full run is recorded in this clone, when a tool version
    # changed since that run, or when that run is older than the window cap. CI never passes it.
    [switch]$Changed,
    # With -Changed only: the commit the change is measured from (default HEAD). The working tree
    # is always part of the change.
    [string]$Base = ''
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$failed = @()
$skipped = @()

if ($Jobs -lt 1) {
    Write-Host "FAIL — -Jobs must be a whole number >= 1 (got $Jobs)" -ForegroundColor Red
    exit 1
}
# The upper bound keeps $SuiteTimeout * 1000 inside WaitForExit's Int32 milliseconds.
if ($SuiteTimeout -lt 1 -or $SuiteTimeout -gt 86400) {
    Write-Host "FAIL — -SuiteTimeout must be a whole number of seconds from 1 to 86400 (got $SuiteTimeout)" -ForegroundColor Red
    exit 1
}

# --- shard argument (ADR 0071)---------------------------------------------------------------
$shardIndex = 0
$shardCount = 0
if ($Shard) {
    # TryParse, not a cast: a digit run beyond Int32 would otherwise throw a raw .NET overflow
    # instead of this named refusal (review 2026-09-02, low).
    $m = [regex]::Match($Shard, '^([1-9][0-9]*)/([1-9][0-9]*)$')
    $i = 0; $n = 0
    $parsed = $m.Success -and [int]::TryParse($m.Groups[1].Value, [ref]$i) -and [int]::TryParse($m.Groups[2].Value, [ref]$n)
    if (-not $parsed -or $i -gt $n) {
        Write-Host "FAIL — -Shard must be i/N with 1 <= i <= N (got '$Shard')" -ForegroundColor Red
        exit 1
    }
    $shardIndex = $i
    $shardCount = $n
}
if ($Changed -and $shardCount) {
    Write-Host 'FAIL — -Changed and -Shard do not combine: a shard is a CI slice of the full run (ADR 0157)' -ForegroundColor Red
    exit 1
}
if ($Base -and -not $Changed) {
    Write-Host 'FAIL — -Base needs -Changed' -ForegroundColor Red
    exit 1
}

# --- discovery ------------------------------------------------------------------------------
# Recursive: a selftest sitting anywhere in the plugin is discovered, so adding a directory
# later cannot silently drop its coverage. `.mjs` selftests are driven by the corpus gate below,
# not here — pwsh would not run them.
# Discovery runs BEFORE the gates so the two loud refusals (empty set, empty slice) and -List
# cost no gate time; the gates still run before the suites in a real run.
# ONE declared exclusion, the same one manifest-gate's coverage report makes: files under a
# `templates/` directory are payload this plugin COPIES into a consuming repo, not code it runs —
# a selftest placed there belongs to the repo it lands in. Counted and printed, never silent.
$templateRx = '[\\/]templates[\\/]'
# Plugin-relative, `/`-separated — the one spelling of a suite in the listing, the live lines and
# the results, so a CI log reads the same on Windows and Linux.
function Get-SuiteRel([IO.FileInfo]$File) { $File.FullName.Substring($PSScriptRoot.Length).TrimStart('\', '/').Replace('\', '/') }
$found = @(Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -File -Filter '*.selftest.ps1' -ErrorAction SilentlyContinue)
$templateExcluded = @($found | Where-Object { $_.FullName -match $templateRx }).Count
# Ordinal-keyed on purpose: a plain @{} compares keys case-insensitively and would fold two paths
# that differ only by case into one entry on a case-sensitive filesystem (review 2026-09-02, medium).
$byRel = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
foreach ($f in $found) {
    if ($f.FullName -match $templateRx) { continue }
    $byRel[(Get-SuiteRel $f)] = $f
}
$rels = [string[]]$byRel.Keys
[Array]::Sort($rels, [System.StringComparer]::Ordinal)
$all = @($rels | ForEach-Object { $byRel[$_] })

if ($all.Count -eq 0) {
    Write-Host "FAIL — no *.selftest.ps1 discovered (empty set is not a pass; template payload excluded: $templateExcluded)" -ForegroundColor Red
    exit 1
}

# --- read-set map (ADR 0157) ----------------------------------------------------------------
# selftest-reads.json declares, per suite, the files whose content can change its verdict. The
# runner checks the map on EVERY run, so CI fails a map that went stale: each discovered suite has
# an entry and no entry names a missing suite, every glob matches a file, and every plugin file is
# claimed by a suite, by `full` (a change re-runs everything) or by `none` (no suite reads it; the
# two gates ahead of the suites do). A suite always reads itself. Keys starting `//` are comments.
# Globs are ordinal and `/`-separated: `*` stays inside one path segment, `**` crosses segments. A
# glob starting `/` is repo-root-relative, for the few suites that read outside the plugin; it is
# checked and matched only when the plugin sits below its repo's root (the canon shape).
function ConvertTo-GlobPattern([string]$Glob) {
    # Escape first, then turn the escaped stars back into the glob meanings, longest first.
    return [regex]::Escape($Glob).Replace('\*\*/', '(?:[^\n]*/)?').Replace('\*\*', '[^\n]*').Replace('\*', '[^/\n]*')
}
# NUL-separated git output (ADR 0077); quotepath off so a non-ASCII name arrives as itself.
# Loops, not pipelines: this runs on every run, and a Where-Object per file and glob cost ~0.5 s.
function Split-Nul($Out) {
    $list = [System.Collections.Generic.List[string]]::new()
    foreach ($p in ((@($Out) -join "`n").Split([char]0))) { $p = $p.Trim("`n"); if ($p) { $list.Add($p) } }
    return $list.ToArray()
}
function Test-AnyMatch($Globs, [string]$Path) { foreach ($g in $Globs) { if ($g.Rx.IsMatch($Path)) { return $true } }; return $false }
# Files: plugin-relative, tracked plus untracked-not-ignored inside git, the filesystem outside it.
# Repo files outside the plugin are listed root-relative with a leading `/`.
$script:inGit = $false
$script:gitTop = ''
$script:gitPrefix = ''
$pluginFiles = @()
$rootFiles = @()
# The work tree's top is the nearest ancestor holding a `.git` entry (a directory, or a worktree's
# file): found by a walk, not a rev-parse, because a process start is most of this check's cost.
# A walk that finds a `.git` git does not accept fails at ls-files below and falls back.
$top = $PSScriptRoot
while ($top -and -not (Test-Path -LiteralPath (Join-Path $top '.git'))) { $top = Split-Path -Parent $top }
if ($top) {
    $script:inGit = $true
    $script:gitTop = $top
    $script:gitPrefix = if ($PSScriptRoot.Length -gt $top.Length) { $PSScriptRoot.Substring($top.Length).TrimStart('\', '/').Replace('\', '/') + '/' } else { '' }
    $listed = & git -C $script:gitTop -c core.quotepath=false ls-files -z --cached --others --exclude-standard 2>$null
    if ($LASTEXITCODE -ne 0) { $script:inGit = $false }
    foreach ($p in (Split-Nul $listed)) {
        if ($script:gitPrefix -and $p.StartsWith($script:gitPrefix, [StringComparison]::Ordinal)) { $pluginFiles += $p.Substring($script:gitPrefix.Length) }
        elseif ($script:gitPrefix) { $rootFiles += "/$p" }
        else { $pluginFiles += $p }
    }
}
if (-not $script:inGit) {
    # -Force: Linux pwsh hides a dotfile without it, so `.claude-plugin/` would match no glob (O118).
    $pluginFiles = @(Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -File -Force | ForEach-Object { Get-SuiteRel $_ })
    $rootFiles = @()
}
$script:nested = [bool]$script:gitPrefix
$script:pluginText = $pluginFiles -join "`n"
$script:rootText = $rootFiles -join "`n"
$mapProblems = [System.Collections.Generic.List[string]]::new()
$mapPath = Join-Path $PSScriptRoot 'selftest-reads.json'
$map = $null
if (-not (Test-Path -LiteralPath $mapPath -PathType Leaf)) {
    $mapProblems.Add('selftest-reads.json is missing')
} else {
    try { $map = Get-Content -LiteralPath $mapPath -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable } catch { $mapProblems.Add("selftest-reads.json does not parse: $($_.Exception.Message)") }
    if ($null -ne $map -and $map -isnot [System.Collections.IDictionary]) { $mapProblems.Add('selftest-reads.json is not an object'); $map = $null }
}
$suiteRx = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
$fullRx = @(); $noneRx = @(); $versionRx = @()
function ConvertTo-Globs($Value, [string]$Where) {
    if ($Value -isnot [System.Collections.IList] -or @($Value | Where-Object { $_ -isnot [string] -or -not $_ }).Count) {
        $mapProblems.Add("$Where is not a list of non-empty strings"); return @()
    }
    return @(foreach ($g in $Value) {
            $pat = ConvertTo-GlobPattern $g
            # One multiline match over the joined list, not one match per file.
            $pool = if ($g.StartsWith('/')) { $script:rootText } else { $script:pluginText }
            $checked = $script:nested -or -not $g.StartsWith('/')
            if ($checked -and -not [regex]::IsMatch($pool, "(?m)^$pat$", [Text.RegularExpressions.RegexOptions]::CultureInvariant)) { $mapProblems.Add("$Where glob '$g' matches no file") }
            [pscustomobject]@{ Glob = $g; Rx = [regex]::new("^$pat$", [Text.RegularExpressions.RegexOptions]::CultureInvariant) }
        })
}
if ($map) {
    $fullRx = ConvertTo-Globs $map['full'] 'full'
    $noneRx = ConvertTo-Globs $map['none'] 'none'
    $versionRx = if ($map.Contains('version_only')) { ConvertTo-Globs $map['version_only'] 'version_only' } else { @() }
    $suitesMap = $map['suites']
    if ($suitesMap -isnot [System.Collections.IDictionary]) {
        $mapProblems.Add('suites is not an object')
    } else {
        # Ordinal on purpose: the hashtable compares keys case-insensitively, a suite path does not.
        foreach ($k in @($suitesMap.Keys | ForEach-Object { [string]$_ } | Sort-Object)) {
            if ($k.StartsWith('//')) { continue }
            if (-not $byRel.ContainsKey($k)) { $mapProblems.Add("suites names '$k', which is not a discovered suite"); continue }
            $suiteRx[$k] = ConvertTo-Globs $suitesMap[$k] "suites['$k']"
        }
        foreach ($r in $rels) { if (-not $suiteRx.ContainsKey($r)) { $mapProblems.Add("suite '$r' has no read set") } }
    }
    # Every glob as one alternation: one match per file instead of one per file and glob.
    $allGlobs = @($fullRx) + @($noneRx) + @($suiteRx.Values | ForEach-Object { $_ })
    $claimRx = [regex]::new((@($allGlobs | ForEach-Object { "(?:$($_.Rx))" }) -join '|'), [Text.RegularExpressions.RegexOptions]::CultureInvariant)
    foreach ($f in $pluginFiles) {
        if ($byRel.ContainsKey($f) -or ($allGlobs.Count -and $claimRx.IsMatch($f))) { continue }
        $mapProblems.Add("'$f' is claimed by no suite, no full glob and no none glob")
    }
}
if ($mapProblems.Count) {
    foreach ($m in $mapProblems) { Write-Host "FAIL — read-set map: $m" -ForegroundColor Red }
    $failed += 'selftest-reads.json'
}

# --- changed-file selection (-Changed, ADR 0157) ---------------------------------------------
# The full-run record lives in the clone's git dir, never in the tree: the last green unsharded
# full run's UTC time, HEAD and tool series. Worktrees of one clone share it.
$script:windowDays = 7
$script:windowCommits = 5
function Get-ToolSeries {
    $v = [ordered]@{ os = [Runtime.InteropServices.RuntimeInformation]::OSDescription.Trim(); pwsh = "$($PSVersionTable.PSVersion)" }
    foreach ($t in @(@('git', 'git'), @('node', 'node'), @('python', 'python', 'python3', 'py'))) {
        $v[$t[0]] = 'n/a'
        foreach ($n in $t[1..($t.Count - 1)]) {
            $cmd = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $cmd) { continue }
            $o = (& $cmd.Source --version 2>&1 | ForEach-Object { "$_" }) -join ' '
            if ($LASTEXITCODE -eq 0 -and $o -match '\d+\.\d+(?:\.\d+)?[^\s]*') { $v[$t[0]] = $Matches[0]; break }
        }
    }
    return $v
}
function Get-StatePath {
    if (-not $script:inGit) { return $null }
    $d = & git -C $PSScriptRoot rev-parse --path-format=absolute --git-common-dir 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $d) { return $null }
    return Join-Path (Join-Path "$d".Trim() 'ywr-harness') 'selftest-full-run.json'
}
# Repo-relative paths that differ between a commit and the working tree, untracked-not-ignored
# files included. $null when git cannot list them.
function Get-ChangeSince([string]$Rev) {
    $d = & git -C $script:gitTop -c core.quotepath=false diff --name-only --no-renames -z $Rev 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    $u = & git -C $script:gitTop -c core.quotepath=false ls-files -z --others --exclude-standard 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return , @(@(Split-Nul $d) + @(Split-Nul $u) | Sort-Object -Unique -CaseSensitive)
}
# Content hashes of repo-relative paths: the blob hash `git add` would store, or 'deleted'. The paths
# go as arguments, never through stdin, where a piped list gains `\r` on Windows. $null on failure.
function Get-ContentHashes([string[]]$Paths) {
    $h = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
    $live = [System.Collections.Generic.List[string]]::new()
    foreach ($p in $Paths) {
        if (Test-Path -LiteralPath (Join-Path $script:gitTop $p) -PathType Leaf) { $live.Add($p) } else { $h[$p] = 'deleted' }
    }
    for ($i = 0; $i -lt $live.Count; $i += 200) {
        $chunk = $live.GetRange($i, [Math]::Min(200, $live.Count - $i)).ToArray()
        $out = @(& git -C $script:gitTop hash-object -- @chunk 2>$null)
        if ($LASTEXITCODE -ne 0 -or $out.Count -ne $chunk.Count) { return $null }
        for ($k = 0; $k -lt $chunk.Count; $k++) { $h[$chunk[$k]] = "$($out[$k])".Trim() }
    }
    return , $h
}
$fullReason = ''
$tests = $all
if ($Changed) {
    $statePath = Get-StatePath
    if (-not $statePath) {
        $fullReason = 'the plugin is not in a git work tree, so no change can be read'
    } else {
        $ref = if ($Base) { $Base } else { 'HEAD' }
        $null = & git -C $script:gitTop rev-parse --verify --quiet "$ref^{commit}" 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "FAIL — -Base does not name a commit: $ref" -ForegroundColor Red
            exit 1
        }
        $state = $null
        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            try { $state = Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable } catch { $state = $null }
        }
        $stateOk = $state -is [System.Collections.IDictionary] -and $state['head'] -and $state['utc'] -and
            $state['series'] -is [System.Collections.IDictionary] -and $state['dirty'] -is [System.Collections.IDictionary]
        $stateReason = ''
        $age = $null
        $since = -1
        if ($stateOk) {
            $now = Get-ToolSeries
            $moved = @(foreach ($k in $now.Keys) { if ("$($state['series'][$k])" -cne "$($now[$k])") { "$k $($state['series'][$k]) -> $($now[$k])" } })
            try { $age = ([DateTime]::UtcNow - [DateTime]::Parse("$($state['utc'])", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)).TotalDays } catch { }
            $null = & git -C $script:gitTop merge-base --is-ancestor "$($state['head'])" HEAD 2>$null
            if ($LASTEXITCODE -eq 0) {
                $c = & git -C $PSScriptRoot rev-list --count "$($state['head'])..HEAD" -- . 2>$null
                if ($LASTEXITCODE -eq 0) { $since = [int]"$c".Trim() }
            }
            if ($moved.Count) { $stateReason = "a tool changed since the last full run: $($moved -join '; ')" }
            elseif ($null -eq $age -or $age -lt -0.01) { $stateReason = "the recorded full run has an unreadable or future time ($($state['utc']))" }
            elseif ($age -gt $script:windowDays) { $stateReason = "the last full run is $([Math]::Round($age, 1)) days old (window $($script:windowDays) days)" }
            elseif ($since -lt 0) { $stateReason = "the last full run's HEAD $($state['head']) is not an ancestor of HEAD" }
            elseif ($since -ge $script:windowCommits) { $stateReason = "$since plugin commits since the last full run (window $($script:windowCommits))" }
        }
        # With a usable record, the change runs from the last green full run, not from HEAD: a commit
        # made since that run is part of it (review 2026-10-18). The paths that run saw dirty count
        # too, since a revert is a change; one that still holds the content it tested drops out.
        # -Base adds its own change on top. Without a usable record the change runs from -Base or HEAD.
        $fromRecord = $stateOk -and -not $stateReason
        $from = if ($fromRecord) { "$($state['head'])" } else { $ref }
        $paths = Get-ChangeSince $from
        if ($null -ne $paths -and $fromRecord) {
            $recDirty = $state['dirty']
            $extra = @($recDirty.Keys | ForEach-Object { [string]$_ })
            if ($Base) { $more = Get-ChangeSince $ref; if ($null -eq $more) { $paths = $null } else { $extra += $more } }
            if ($null -ne $paths) {
                $paths = @(@($paths) + $extra | Sort-Object -Unique -CaseSensitive)
                $seen = @($paths | Where-Object { $recDirty.Contains($_) })
                $nowHash = Get-ContentHashes $seen
                if ($null -eq $nowHash) { $paths = $null }
                else { $paths = @($paths | Where-Object { -not ($recDirty.Contains($_) -and "$($recDirty[$_])" -ceq $nowHash[$_]) }) }
            }
        }
        if ($null -eq $paths) {
            $fullReason = 'git could not list the change'
        } else {
            # Plugin files plugin-relative; repo files outside the plugin count only when a `/` glob names them.
            $rootGlobs = @($suiteRx.Values | ForEach-Object { $_ } | Where-Object { $_.Glob.StartsWith('/') })
            $changedFiles = @(foreach ($p in $paths) {
                    if (-not $script:gitPrefix) { $p }
                    elseif ($p.StartsWith($script:gitPrefix, [StringComparison]::Ordinal)) { $p.Substring($script:gitPrefix.Length) }
                    elseif (Test-AnyMatch $rootGlobs "/$p") { "/$p" }
                })
            # A version_only file whose diff changes only `"version": "…"` lines selects no suite: its
            # readers read the value at run time. A file new since $from shows every line, so it selects.
            $versionLine = '^[+-]\s*"version"\s*:\s*"[^"]*"\s*,?\s*$'
            $bumped = @(foreach ($f in $changedFiles) {
                    if (-not (Test-AnyMatch $versionRx $f)) { continue }
                    $repoPath = if ($f.StartsWith('/')) { $f.Substring(1) } else { "$($script:gitPrefix)$f" }
                    # A path the full run saw dirty was tested as dirty content, not as $from: a diff
                    # against $from cannot tell what changed since, so it gets no exemption.
                    if ($fromRecord -and $recDirty.Contains($repoPath)) { continue }
                    $hunk = @(& git -C $script:gitTop -c core.quotepath=false diff -U0 --no-color --no-ext-diff $from -- $repoPath 2>$null |
                            ForEach-Object { "$_" } | Where-Object { $_ -match '^[+-]' -and $_ -notmatch '^(\+\+\+|---) ' })
                    if ($LASTEXITCODE -eq 0 -and $hunk.Count -and -not @($hunk | Where-Object { $_ -notmatch $versionLine }).Count) { $f }
                })
            $fromText = if ($fromRecord) { "the last full run ($($from.Substring(0, [Math]::Min(7, $from.Length))))$(if ($Base) { " and $ref" })" } else { $ref }
            Write-Host "changed: $($changedFiles.Count) file(s) since $fromText, working tree included"
            foreach ($f in $changedFiles) { Write-Host "  * $f$(if ($bumped -ccontains $f) { ' (version line only: selects no suite)' })" }
            $rawCount = $changedFiles.Count
            $changedFiles = @($changedFiles | Where-Object { $bumped -cnotcontains $_ })
            $shared = @($changedFiles | Where-Object { Test-AnyMatch $fullRx $_ })
            if ($rawCount -eq 0) {
                $fullReason = 'the change is empty, so the selection would be empty'
            } elseif ($mapProblems.Count) {
                $fullReason = 'the read-set map failed its check'
            } elseif ($shared.Count) {
                $fullReason = "a shared input changed: $($shared -join ', ')"
            } elseif (-not $stateOk) {
                $fullReason = "no green full run is recorded in this clone ($statePath)"
            } elseif ($stateReason) {
                $fullReason = $stateReason
            } else {
                $picked = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
                $unclaimed = @()
                foreach ($f in $changedFiles) {
                    $hit = $f.StartsWith('/') -or $byRel.ContainsKey($f) -or (Test-AnyMatch $noneRx $f)
                    if ($byRel.ContainsKey($f)) { [void]$picked.Add($f) }
                    foreach ($k in $suiteRx.Keys) { if (Test-AnyMatch $suiteRx[$k] $f) { [void]$picked.Add($k); $hit = $true } }
                    if (-not $hit) { $unclaimed += $f }
                }
                if ($unclaimed.Count) {
                    $fullReason = "a changed file matches no read set: $($unclaimed -join ', ')"
                } else {
                    $tests = @($all | Where-Object { $picked.Contains((Get-SuiteRel $_)) })
                    Write-Host "selection: $($tests.Count) of $($all.Count) suites by read set (last full run $([Math]::Round($age, 1)) days and $since plugin commit(s) ago, same tools)" -ForegroundColor Cyan
                }
            }
        }
    }
    if ($fullReason) { Write-Host "selection: FULL RUN — $fullReason" -ForegroundColor Yellow }
}
if ($shardCount) {
    $tests = @(for ($k = 0; $k -lt $all.Count; $k++) { if ((($k % $shardCount) + 1) -eq $shardIndex) { $all[$k] } })
    Write-Host "suites: discovered=$($all.Count) shard=$shardIndex/$shardCount selected=$($tests.Count) template-excluded=$templateExcluded"
    if ($tests.Count -eq 0) {
        Write-Host "FAIL — shard $Shard selects 0 of $($all.Count) suites (N exceeds the discovery) — an empty slice is not a pass" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "suites: discovered=$($all.Count)$(if ($tests.Count -ne $all.Count) { " selected=$($tests.Count)" }) template-excluded=$templateExcluded"
}
foreach ($t in $tests) { Write-Host "  - $(Get-SuiteRel $t)" }

# --- start order (ADR 0161) -------------------------------------------------------------------
# The wall of a concurrent run is the last suite to finish, and -Parallel hands suites to its slots
# in input order. Discovery order put the slowest suites last (2026-10-19: 178 s measured, 140 s
# simulated longest first). So at -Jobs 2 and above the suites that took longest in their last run
# start first; a suite with no recorded time starts before every timed one, since a new suite may be
# the slowest. -Jobs 1 keeps discovery order. The times sit beside the full-run record, in the clone's
# git dir, and change no verdict.
$work = @(for ($k = 0; $k -lt $tests.Count; $k++) {
        [pscustomobject]@{ Index = $k; Rel = (Get-SuiteRel $tests[$k]); Name = $tests[$k].Name; Path = $tests[$k].FullName }
    })
# The common dir is read from files, not from `git rev-parse` (~64 ms a process; -List runs this on
# every call). `.git` is the git dir itself, or a worktree's or submodule's file naming its gitdir, and
# a gitdir that holds a `commondir` file names the common dir relative to itself. A git environment
# override, or anything this cannot read, falls back to Get-StatePath's rev-parse.
function Get-CommonDirFromFiles {
    if (-not $script:inGit -or $env:GIT_DIR -or $env:GIT_COMMON_DIR) { return $null }
    try {
        $dotGit = Join-Path $script:gitTop '.git'
        if ([IO.Directory]::Exists($dotGit)) { $gitDir = $dotGit }
        else {
            if (([IO.File]::ReadAllText($dotGit)).Trim() -notmatch '^gitdir:\s*(.+)$') { return $null }
            $gitDir = [IO.Path]::GetFullPath($Matches[1].Trim(), $script:gitTop)
        }
        $cd = Join-Path $gitDir 'commondir'
        $common = if ([IO.File]::Exists($cd)) { [IO.Path]::GetFullPath(([IO.File]::ReadAllText($cd)).Trim(), $gitDir) } else { [IO.Path]::GetFullPath($gitDir) }
        if (-not [IO.Directory]::Exists($common)) { return $null }
        return $common
    } catch { return $null }
}
$commonForTimes = Get-CommonDirFromFiles
$timesPath = if ($commonForTimes) { Join-Path (Join-Path $commonForTimes 'ywr-harness') 'selftest-times.json' } else {
    $statePathForTimes = Get-StatePath
    if ($statePathForTimes) { Join-Path (Split-Path -Parent $statePathForTimes) 'selftest-times.json' } else { $null }
}
$times = @{}
$timesProblem = ''
if ($timesPath -and (Test-Path -LiteralPath $timesPath -PathType Leaf)) {
    try {
        $doc = [IO.File]::ReadAllText($timesPath) | ConvertFrom-Json -AsHashtable
        if ($doc -isnot [Collections.IDictionary] -or $doc['seconds'] -isnot [Collections.IDictionary]) { throw 'it holds no "seconds" object' }
        foreach ($k in $doc['seconds'].Keys) {
            $v = $doc['seconds'][$k]
            if ($v -is [bool] -or $v -isnot [ValueType]) { continue }
            $d = [double]$v
            if ([double]::IsFinite($d) -and $d -ge 0) { $times[[string]$k] = $d }
        }
    } catch { $times = @{}; $timesProblem = "the times file does not parse ($($_.Exception.Message))" }
}
$timed = @($work | Where-Object { $times.ContainsKey($_.Rel) }).Count
if ($Jobs -lt 2) { $orderNote = 'discovery order (-Jobs 1)' }
elseif (-not $timesPath) { $orderNote = 'discovery order (not a git clone, so no suite times are kept)' }
elseif ($timesProblem) { $orderNote = "discovery order ($timesProblem)" }
elseif (-not $timed) { $orderNote = 'discovery order (no suite time is recorded in this clone)' }
else {
    $work = @($work | Sort-Object -Stable @{ Expression = { [int]$times.ContainsKey($_.Rel) } },
        @{ Expression = { if ($times.ContainsKey($_.Rel)) { $times[$_.Rel] } else { 0 } }; Descending = $true }, Index)
    $orderNote = "longest first by recorded time ($timed of $($work.Count) suites timed)"
}

if ($List) {
    Write-Host "start order: $orderNote — $(($work | ForEach-Object { $_.Rel }) -join ', ')"
    Write-Host 'LIST ONLY — nothing ran' -ForegroundColor Yellow
    exit $(if ($failed.Count) { 1 } else { 0 })
}

# --- full-run snapshot (ADR 0157) -----------------------------------------------------------
# A run of every suite may write the full-run record. Its HEAD and the content of each dirty path
# are read HERE, before any gate or suite starts: an edit or a commit made while the suites run is
# then a change against the record, never content the record calls tested (review 2026-10-18).
$snapshot = $null
if (-not $shardCount -and $tests.Count -eq $all.Count -and (Get-StatePath)) {
    $snapHead = "$(& git -C $PSScriptRoot rev-parse HEAD 2>$null)".Trim()
    if ($LASTEXITCODE -eq 0 -and $snapHead) {
        $dirtyPaths = Get-ChangeSince 'HEAD'
        $snapDirty = if ($null -ne $dirtyPaths) { Get-ContentHashes $dirtyPaths } else { $null }
        if ($null -ne $snapDirty) { $snapshot = @{ Head = $snapHead; Dirty = $snapDirty } }
    }
}

# --- manifest + wiring gate ----------------------------------------------------------------
# Node since ADR 0141. A missing `node` FAILS here, as a missing gate file does: the wiring gate is
# not optional, so it never becomes the workflow corpus gate's reported SKIP below.
$gate = Join-Path $PSScriptRoot 'manifest-gate.mjs'
if (-not (Test-Path -LiteralPath $gate)) {
    Write-Host 'FAIL — manifest-gate.mjs missing (the wiring gate is not optional)' -ForegroundColor Red
    $failed += 'manifest-gate.mjs (missing)'
} elseif (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
    Write-Host 'FAIL — node not on PATH, so manifest-gate.mjs cannot run (the wiring gate is not optional; ADR 0141)' -ForegroundColor Red
    $failed += 'manifest-gate.mjs (no node)'
} else {
    Write-Host '--- manifest-gate.mjs' -ForegroundColor Cyan
    & node $gate
    if ($LASTEXITCODE -ne 0) { $failed += 'manifest-gate.mjs' }
}

# --- workflow corpus gate (JS side) --------------------------------------------------------
# Two arms: every workflows/*.js compiles, and every workflows/*.selftest.mjs exits 0.
# `node --check` is not a substitute for the parse arm — a file carrying `export` is
# module-detected and NOT syntax-checked, so --check exits 0 on any content after it.
$wfGate = Join-Path $PSScriptRoot 'scripts/workflow-gates.mjs'
$wfDir = Join-Path $PSScriptRoot 'workflows'
if ((Test-Path -LiteralPath $wfGate) -and (Test-Path -LiteralPath $wfDir)) {
    if (Get-Command node -CommandType Application -ErrorAction SilentlyContinue) {
        Write-Host '--- workflow-gates.mjs (corpus: workflows/)' -ForegroundColor Cyan
        & node $wfGate --root $PSScriptRoot --dir 'workflows'
        if ($LASTEXITCODE -ne 0) { $failed += 'workflow-gates.mjs' }
    } else {
        Write-Host 'SKIP — node not on PATH; workflow corpus gate NOT run (reported, not silent)' -ForegroundColor Yellow
        $skipped += 'workflow-gates.mjs (no node)'
    }
} elseif (Test-Path -LiteralPath $wfDir) {
    Write-Host 'FAIL — workflows/ exists but scripts/workflow-gates.mjs is missing: the corpus would be gated by nothing' -ForegroundColor Red
    $failed += 'workflow-gates.mjs (missing, corpus present)'
}

# --- shipped PowerShell selftests (concurrent, ADR 0088) ------------------------------------
# Safe side by side because every suite is its own process: fixture roots are $PID- or GUID-named
# under the temp root (New-FixtureRoot in lib/selftest-lib.ps1), env redirection (HOME,
# CLAUDE_CONFIG_DIR, PATH, GIT_CONFIG_GLOBAL) dies with the suite, and no suite writes global git
# config or the plugin tree, or asserts on timing (audited 2026-09-23). A suite that ever breaks
# that is fixed in the suite, not by serialising the runner; -Jobs 1 is the interim fallback.
# $work is built, in start order, ahead of -List (ADR 0161).
function Format-Seconds([double]$Seconds) { $Seconds.ToString('0.0', [Globalization.CultureInfo]::InvariantCulture) }
function Get-PassCount([string[]]$Lines) { @($Lines | Where-Object { $_ -match '^PASS' }).Count }
# The signal-line rule (Write-SuiteLine, ConvertTo-Plain, Get-SignalRx) and the suite process
# (Clear-StdHandleInherit, Invoke-SuiteProcess) live in lib/runner-signal.ps1, which scripts/canon-selftest.ps1
# dot-sources too (ADR 0162, ADR 0166). Here, after the -List exit, so a -List run never opens it.
. (Join-Path $PSScriptRoot 'lib/runner-signal.ps1')
# The runner's own stdout and stderr stop being inheritable before the first suite starts (ADR 0165, fact
# 169), so no suite descendant can hold the caller's pipe. The step comes HERE, after the two gates: they
# stream through this process's stdout, so their output never depends on the step. Every native call after
# this point captures both of its streams.
$noInheritMiss = Clear-StdHandleInherit
$suiteFn = Get-SuiteProcessFn
Write-Host "--- suites: $($work.Count) selected, jobs=$Jobs, start order: $orderNote — one 'done' line per suite as it finishes (completion order)" -ForegroundColor Cyan
$results = [System.Collections.Generic.List[object]]::new()
$clock = [Diagnostics.Stopwatch]::StartNew()
$work | ForEach-Object -ThrottleLimit $Jobs -Parallel {
    # No per-thread decoding pin, on purpose: [Console]::OutputEncoding is process-wide, so the pin
    # at the top of this file is what decodes here (Start-Job would be a separate cp949 process —
    # not used). Measured 2026-09-23 by mutation: a guarded re-pin in this block changed nothing,
    # and with the top pin removed it still let the Korean case fail, because this script's own
    # stdout writer had already been fixed at its first write.
    #
    # The child is the runner's own pwsh ([Environment]::ProcessPath), started by Invoke-SuiteProcess from
    # lib/runner-signal.ps1: a Process object whose every wait has a bound (ADR 0098, ADR 0165). This thread
    # does not see the runner's functions, so it dot-sources the definition from $suiteFn. The children
    # inherit the console code page the pin above set.
    $s = $_
    . ([scriptblock]::Create($using:suiteFn))
    $r = Invoke-SuiteProcess -Exe ([Environment]::ProcessPath) -ArgList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $s.Path) -Limit $using:SuiteTimeout
    [pscustomobject]@{ Index = $s.Index; Code = $r.Code; Seconds = $r.Seconds; Lines = $r.Lines; Rel = $s.Rel }
} | ForEach-Object {
    $results.Add($_)
    $v = if ($_.Code -eq 0) { 'PASS' } else { 'FAIL' }
    Write-Host "done $($_.Rel) $v ($(Format-Seconds $_.Seconds) s, $(Get-PassCount $_.Lines) PASS lines)" -ForegroundColor $(if ($v -eq 'PASS') { 'Green' } else { 'Red' })
}
$clock.Stop()

# Results in DISCOVERY order, whatever order the suites finished in, so two runs' logs line up.
$byIndex = @{}
foreach ($r in $results) { $byIndex[$r.Index] = $r }
$testFails = 0
$how = if ($Full) { 'every suite in full (-Full)' } else { 'a failed suite in full, a passing suite as one line plus its SKIP/WARN/FAIL/KEEP lines (-Full prints all)' }
Write-Host "--- results in discovery order: $how" -ForegroundColor Cyan
foreach ($w in $work) {
    $r = $byIndex[$w.Index]
    if ($null -eq $r) {
        # A parallel iteration that yielded nothing must not vanish from the count.
        Write-Host "FAIL $($w.Rel) — no result came back from the concurrent run" -ForegroundColor Red
        $failed += "$($w.Name) (no result)"; $testFails++
        continue
    }
    $pass = $r.Code -eq 0
    if (-not $pass) { $failed += $w.Name; $testFails++ }
    $stats = "$(Get-PassCount $r.Lines) PASS lines, $(Format-Seconds $r.Seconds) s"
    if ($Full -or -not $pass) {
        Write-Host "--- $($w.Rel) $(if ($pass) { 'PASS' } else { 'FAIL' }) (exit $($r.Code), $stats) — captured output:" -ForegroundColor $(if ($pass) { 'Cyan' } else { 'Red' })
        foreach ($l in $r.Lines) { Write-SuiteLine $l }
    } else {
        Write-Host "ok   $($w.Rel) ($stats)" -ForegroundColor Green
        $signal = Get-SignalRx
        foreach ($l in $r.Lines) { $p = ConvertTo-Plain $l; if ($p -match $signal) { Write-SuiteLine $p } }
    }
}
if ($script:signalProbeMiss) {
    Write-Host "WARN [runner] the Write-Warning label probe failed ($($script:signalProbeMiss)): a passing suite's localized warning line may be missing above; -Full prints every line" -ForegroundColor Yellow
}
if ($noInheritMiss) {
    Write-Host "WARN [runner] the runner's stdout and stderr stay inheritable ($noInheritMiss): a stuck suite descendant can hold this run's output pipe" -ForegroundColor Yellow
}
$sum = [double]($results | Measure-Object -Property Seconds -Sum).Sum
$slowest = $results | Sort-Object Seconds -Descending | Select-Object -First 1
Write-Host "timing: suites wall-clock $(Format-Seconds $clock.Elapsed.TotalSeconds) s at jobs=$Jobs · sum of suite times $(Format-Seconds $sum) s$(if ($slowest) { " · slowest $($slowest.Rel) $(Format-Seconds $slowest.Seconds) s" })"
# The times the next run orders by (ADR 0161): this run's suites merged over the times read at start,
# failed and timed-out suites included, undiscovered names dropped. Two runs that overlap in one clone
# are last-writer-wins, and a file that did not parse is replaced: either costs only order, never a
# verdict. A write that fails changes no exit code.
if ($timesPath -and $results.Count) {
    try {
        $known = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        foreach ($t in $all) { [void]$known.Add((Get-SuiteRel $t)) }
        $merged = @{}
        foreach ($k in $times.Keys) { if ($known.Contains($k)) { $merged[$k] = $times[$k] } }
        foreach ($r in $results) { $merged[$r.Rel] = [Math]::Round($r.Seconds, 1) }
        $sorted = [ordered]@{}
        foreach ($k in @($merged.Keys | Sort-Object -CaseSensitive)) { $sorted[$k] = $merged[$k] }
        $doc = [ordered]@{ '//' = 'ADR 0161: the seconds of each suite''s newest run; selftest.ps1 starts the longest first at -Jobs 2 and above'
            utc = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture); seconds = $sorted }
        # -ErrorAction Stop: a cmdlet's non-terminating error would pass the catch and print a raw record.
        $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $timesPath) -ErrorAction Stop
        $tmp = "$timesPath.$PID.tmp"
        [IO.File]::WriteAllText($tmp, ($doc | ConvertTo-Json -Depth 3), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tmp -Destination $timesPath -Force -ErrorAction Stop
    } catch {
        Write-Host "WARN [runner] the suite times were not written ($($_.Exception.Message)); the next run starts in the order it can read" -ForegroundColor Yellow
    }
}

Write-Host ''
$isFullRun = -not $shardCount -and $tests.Count -eq $all.Count
$shardNote = if ($shardCount) { " shard=$shardIndex/$shardCount selected=$($tests.Count)" } elseif (-not $isFullRun) { " selected=$($tests.Count)" } else { '' }
Write-Host "selftests: discovered=$($all.Count)$shardNote passed=$($tests.Count - $testFails) failed=$testFails"
if ($skipped.Count) { Write-Host "skipped gates: $($skipped -join ', ')" -ForegroundColor Yellow }
if ($failed.Count) {
    Write-Host "FAIL — $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
# A green unsharded run of every suite is the full-run record -Changed reads (ADR 0157). A record
# that cannot be written (a read-only mount, no git dir) only costs the next -Changed run a full run.
if ($isFullRun) {
    $statePath = Get-StatePath
    if ($statePath) {
        try {
            if ($null -eq $snapshot) { throw 'git could not read HEAD or hash the working tree before the run' }
            $record = [ordered]@{ utc = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture); head = $snapshot.Head; series = Get-ToolSeries; dirty = $snapshot.Dirty }
            $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $statePath)
            $tmp = "$statePath.$PID.tmp"
            [IO.File]::WriteAllText($tmp, ($record | ConvertTo-Json -Depth 3), [Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $tmp -Destination $statePath -Force
            Write-Host "full-run record: $statePath"
        } catch {
            Write-Host "WARN [runner] the full-run record was not written ($($_.Exception.Message)); the next -Changed run is a full run" -ForegroundColor Yellow
        }
    }
}
if (-not $isFullRun -and -not $shardCount) {
    Write-Host "ywr-harness plugin: selected gates green — $($tests.Count) of $($all.Count) suites by read set, NOT a full run$(if ($skipped.Count) { " ($($skipped.Count) skipped — see above)" })" -ForegroundColor Green
    exit 0
}
Write-Host "ywr-harness plugin: all gates green$(if ($shardCount) { " (shard $shardIndex/$shardCount)" })$(if ($skipped.Count) { " ($($skipped.Count) skipped — see above)" })" -ForegroundColor Green
exit 0
