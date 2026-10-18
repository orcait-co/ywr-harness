# Negative test for manifest-gate.mjs — every mutation MUST make the gate exit 1.
#
# Why this exists: a gate that has only ever been observed passing is not known to work. The
# gate's own comments name the failure class it guards against (green selftests over a payload
# field name nothing carried), and the gate would be an instance of that class if nothing ever
# proved it can fail.
#
# Each case resets a temp copy of the plugin to pristine (asserted), mutates one thing, and runs the gate there.
# The real plugin is never modified.

$ErrorActionPreference = 'Stop'
# The lib pins [Console]::OutputEncoding (UTF-8, no BOM) and sets StrictMode off; this
# file set the BOM-bearing UTF8 itself before it dot-sourced the lib — one owner now.
. (Join-Path $PSScriptRoot 'lib/selftest-lib.ps1')
# The gate is Node since ADR 0141: a missing `node` is a reported SKIP locally and a FAIL on CI (ADR 0116 Decision 3).
Assert-NodeOrExit 'manifest-gate.selftest'
$nodeExe = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

$src = $PSScriptRoot
$base = Join-Path ([IO.Path]::GetTempPath()) ("ywrh-gate-neg-" + [guid]::NewGuid().ToString('N'))
$results = @()
# The git worker binary ahead of the cmd\git.exe launcher (lib Use-GitWorkerBinary, ADR 0111): the
# fixtures' own git calls run here, and each gate child inherits this PATH, so the gate's lockstep and
# ADR-reference calls resolve the worker too. Left in place — under `pwsh -File` the process ends with it.
$null = Use-GitWorkerBinary

# Teardown is exception-safe and refuses anything outside the temp root.
trap {
    if ($base -and $base.StartsWith([IO.Path]::GetTempPath()) -and (Test-Path -LiteralPath $base)) {
        Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
    }
    break
}

# One `node` child per gate run (ADR 0141 Decision 3): ~0.06 s to start where the pwsh gate's runspace
# cost ~0.41 s per case. This suite is a NEGATIVE suite — its PASS is "the gate exited 1" — so the abort
# shape matters more here than anywhere: Node itself exits 1 on an uncaught exception, a failed import
# and a syntax error, the very code a caught mutation gives. A gate run therefore counts only when it
# ends in the gate's own summary line for its code (`manifest-gate: FAILED (N)` for 1, `manifest-gate:
# all checks passed` for 0); any other ending, any other code (the gate's own catch exits 2) and a
# missing gate file come back -1/Aborted, which no case accepts. Both pipes are read as UTF-8, whatever
# the console's code page. The contracts are pinned as cases at the end.
function Invoke-Gate([string]$GatePath) {
    if (-not (Test-Path -LiteralPath $GatePath -PathType Leaf)) { return @{ Out = "script not found: $GatePath"; Code = -1; Aborted = $true } }
    $psi = [Diagnostics.ProcessStartInfo]::new($nodeExe)
    $psi.ArgumentList.Add($GatePath)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $psi.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $p = [Diagnostics.Process]::Start($psi)
    $so = $p.StandardOutput.ReadToEndAsync()
    $se = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()
    $code = $p.ExitCode
    $p.Dispose()
    $out = $so.Result + $se.Result
    $last = @($so.Result -split "`r?`n" | Where-Object { $_ })[-1]
    $summed = (($code -eq 1) -and ($last -match '^manifest-gate: FAILED \(\d+\)$')) -or (($code -eq 0) -and ($last -eq 'manifest-gate: all checks passed'))
    if (-not $summed) { return @{ Out = "exit $code without the gate's summary line`n$out"; Code = -1; Aborted = $true } }
    return @{ Out = $out; Code = $code; Aborted = $false }
}

# --- copy once, reset per case (handoff O31) -----------------------------------------------------
# A per-case Copy-Item of the whole plugin tree was part of the suite's floor. Each fixture family
# now copies ONCE into a pristine snapshot plus one working tree; before every case the working tree
# is reset to the snapshot and the reset is ASSERTED: the full state (every file's relative path and
# SHA-256, every directory, and the Unix mode off Windows) must equal the snapshot's, or the suite
# throws. A case therefore never sees a previous case's mutation — an added file or directory, a
# `.git` from `git init`, a deleted file, an edited byte — and a reset that missed one is a loud
# abort, not a leaked fixture. Copy a directory ITSELF to a not-yet-existing destination:
# pre-creating it would nest the copy one level down, and a wildcard source is not an option
# (-LiteralPath takes `*` literally — what the first wired run caught).
$sha = [System.Security.Cryptography.SHA256]::Create()
function Get-TreeState([string]$root) {
    $state = [System.Collections.Generic.SortedDictionary[string, string]]::new([StringComparer]::Ordinal)
    $rootFull = [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    foreach ($e in [IO.Directory]::EnumerateFileSystemEntries($rootFull, '*', [IO.SearchOption]::AllDirectories)) {
        $rel = $e.Substring($rootFull.Length).Replace('\', '/')
        $mode = if ($IsWindows) { '' } else { ' ' + [IO.File]::GetUnixFileMode($e) }
        if ([IO.Directory]::Exists($e)) { $state[$rel + '/'] = 'dir' + $mode }
        else { $state[$rel] = [Convert]::ToHexString($sha.ComputeHash([IO.File]::ReadAllBytes($e))) + $mode }
    }
    return $state
}
# The PRE-reset scan is cheap: (length, mtime) per entry, no read. It only decides what to RESTORE — a
# signature that equals the last known-pristine one means "leave it", so a mutation that keeps both
# length and mtime would be missed here, and Assert-FixturePristine (the full SHA-256 state, unchanged
# and run AFTER every reset) then throws: a miss is a loud abort, never a leaked fixture. Hashing the
# whole tree BEFORE the reset too was 128 x ~250 files = 19.6 s of a 118 s suite (2026-09-29 profile,
# ADR 0111). The signature is re-taken after each asserted reset, so it never depends on whether
# Copy-Item preserves mtimes on the OS.
function Get-TreeSig([string]$root) {
    $sig = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
    $rootFull = [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    foreach ($e in [IO.Directory]::EnumerateFileSystemEntries($rootFull, '*', [IO.SearchOption]::AllDirectories)) {
        $rel = $e.Substring($rootFull.Length).Replace('\', '/')
        $mode = if ($IsWindows) { '' } else { ' ' + [IO.File]::GetUnixFileMode($e) }
        if ([IO.Directory]::Exists($e)) { $sig[$rel + '/'] = 'dir' + $mode }
        else { $fi = [IO.FileInfo]::new($e); $sig[$rel] = "$($fi.Length)|$($fi.LastWriteTimeUtc.Ticks)$mode" }
    }
    return $sig
}
function New-Fixture([string]$name, [scriptblock]$build) {
    # $build lays the pristine tree at the path it is given; the working tree is one copy of it.
    $pristine = Join-Path $base "$name.pristine"
    & $build $pristine
    $work = Join-Path $base $name
    Copy-Item -LiteralPath $pristine -Destination $work -Recurse -Force
    return @{ name = $name; pristine = $pristine; work = $work; state = (Get-TreeState $pristine); sig = (Get-TreeSig $work) }
}
function Assert-FixturePristine($fx) {
    $have = Get-TreeState $fx.work
    $diff = @($fx.state.Keys | Where-Object { -not $have.ContainsKey($_) -or $have[$_] -ne $fx.state[$_] }) +
            @($have.Keys | Where-Object { -not $fx.state.ContainsKey($_) })
    if ($diff.Count) { throw "fixture '$($fx.name)' reset NOT pristine — a case would see a previous case's mutation: $(($diff | Select-Object -First 5) -join ', ')" }
}
function Reset-Fixture($fx) {
    $want = $fx.sig
    $have = Get-TreeSig $fx.work
    # Remove what the snapshot does not have, then restore what differs or is gone. Shallowest first
    # (an ancestor's path is always the shorter): one recursive remove takes a whole added `.git`, and
    # its ~400 entries are then already gone — removing each one deepest-first was ~2.5 s of a 2.7 s
    # reset in every git case (measured 2026-09-28). The assert below still proves nothing survived.
    foreach ($rel in @($have.Keys | Where-Object { -not $want.ContainsKey($_) } | Sort-Object Length)) {
        $p = Join-Path $fx.work $rel.TrimEnd('/')
        if ([IO.File]::Exists($p) -or [IO.Directory]::Exists($p)) { Remove-Item -LiteralPath $p -Recurse -Force }
    }
    foreach ($rel in $want.Keys) {
        if ($have.ContainsKey($rel) -and $have[$rel] -eq $want[$rel]) { continue }
        $p = Join-Path $fx.work $rel.TrimEnd('/')
        if ($rel.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $p | Out-Null; continue }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
        Copy-Item -LiteralPath (Join-Path $fx.pristine $rel) -Destination $p -Force
    }
    Assert-FixturePristine $fx
    $fx.sig = Get-TreeSig $fx.work
    return $fx.work
}
# The plugin tree a fixture copies is the WORK TREE MINUS ITS GITIGNORED FILES: `git ls-files --cached
# --others --exclude-standard`, so an unadded new file is in and the owner's eval results, the mod
# build's types, __pycache__ and tsconfig.json are out — half the tree's bytes, never shipped, and
# copied and SHA-256-hashed into every fixture family before (O80, measured 2026-10-11: suite 110 →
# 74 s, all mutations still caught). CI's checkout has none of them, so the fixture now matches the
# tree CI gates. Outside a git work tree (the Linux parity image mounts the plugin alone) or on any
# git failure it falls back to the whole-directory copy. A tracked file deleted in the work tree is
# skipped. $To must not exist yet, as with the Copy-Item it replaces.
function Copy-PluginTree([string]$From, [string]$To) {
    $list = @()
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $raw = (& git -C $From -c core.quotepath=false ls-files -z --cached --others --exclude-standard 2>$null) -join "`n"
        if ($LASTEXITCODE -eq 0) { $list = @($raw -split "`0" | Where-Object { $_ }) }
    }
    if (-not $list.Count) { Copy-Item -LiteralPath $From -Destination $To -Recurse -Force; return }
    foreach ($rel in $list) {
        $srcFile = Join-Path $From $rel
        if (-not [IO.File]::Exists($srcFile)) { continue }
        $dst = Join-Path $To $rel
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dst))
        [IO.File]::Copy($srcFile, $dst, $true)
        if (-not $IsWindows) { [IO.File]::SetUnixFileMode($dst, [IO.File]::GetUnixFileMode($srcFile)) }
    }
}
$pluginFx = New-Fixture 'plugin' { param($p) Copy-PluginTree $src $p }

# -Expect: the case's own Bad line must be in the output, so an exit 1 from some OTHER check the
# mutation happens to trip cannot stand in for the check under test (review 2026-10-02, C9).
function Try-Case([string]$tag, [scriptblock]$mutate, [string]$Expect = '') {
    $dir = Reset-Fixture $pluginFx
    & $mutate $dir
    $g = Invoke-Gate (Join-Path $dir 'manifest-gate.mjs')
    $rc = $g.Code
    if ($rc -eq 1 -and $Expect -and $g.Out -notmatch $Expect) {
        Write-Host "FAIL [$tag] gate exited 1 but not on the check under test (no line matching '$Expect')" -ForegroundColor Red
        $rc = 'other-check'
    }
    elseif ($rc -eq 1) { Write-Host "PASS [$tag] gate exited 1 as required" -ForegroundColor Green }
    elseif ($g.Aborted) { Write-Host "FAIL [$tag] gate ABORTED — not an exit code, nothing was proven: $(($g.Out -split "`n")[0])" -ForegroundColor Red }
    else { Write-Host "FAIL [$tag] gate exited $rc — mutation NOT caught" -ForegroundColor Red }
    $script:results += [pscustomobject]@{ case = $tag; exit = $rc }
}

Try-Case 'version-removed' {
    param($d)
    $p = Join-Path $d '.claude-plugin/plugin.json'
    $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
    $j.PSObject.Properties.Remove('version')
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $p -NoNewline
}

Try-Case 'version-not-semantic' {
    param($d)
    $p = Join-Path $d '.claude-plugin/plugin.json'
    $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
    $j.version = 'v1'
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $p -NoNewline
}

Try-Case 'name-not-kebab' {
    param($d)
    $p = Join-Path $d '.claude-plugin/plugin.json'
    $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
    $j.name = 'YWR Harness'
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $p -NoNewline
}

Try-Case 'displayName-removed' {
    param($d)
    $p = Join-Path $d '.claude-plugin/plugin.json'
    $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
    $j.PSObject.Properties.Remove('displayName')
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $p -NoNewline
}

Try-Case 'hook-path-broken' {
    param($d)
    $p = Join-Path $d 'hooks/hooks.json'
    (Get-Content -LiteralPath $p -Raw).Replace('subagent-telemetry.mjs', 'subagent-telemetry-MOVED.mjs') |
        Set-Content -LiteralPath $p -NoNewline
}

Try-Case 'exec-form-regressed' {
    param($d)
    $p = Join-Path $d 'hooks/hooks.json'
    $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
    $h = $j.hooks.SubagentStop[0].hooks[0]
    $h.command = '"${CLAUDE_PLUGIN_ROOT}/hooks/subagent-telemetry.mjs"'
    $h.PSObject.Properties.Remove('args')
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $p -NoNewline
}

# `modules` (ADR 0117; the entry is mods.mjs since ADR 0138): a moved module file, a second entry, and a suffix the host does not load.
Try-Case 'module-path-broken' {
    param($d)
    $p = Join-Path $d 'hooks/hooks.json'
    (Get-Content -LiteralPath $p -Raw).Replace('"./mods.mjs"', '"./delegation-ledger-MOVED.mjs"') |
        Set-Content -LiteralPath $p -NoNewline
} -Expect 'module path does not exist'

Try-Case 'module-two-entries' {
    param($d)
    $p = Join-Path $d 'hooks/hooks.json'
    (Get-Content -LiteralPath $p -Raw).Replace('"./mods.mjs"', '"./mods.mjs", "./hook-lib.mjs"') |
        Set-Content -LiteralPath $p -NoNewline
} -Expect "'modules' must hold exactly one path"

Try-Case 'module-bad-suffix' {
    param($d)
    $p = Join-Path $d 'hooks/hooks.json'
    Copy-Item -LiteralPath (Join-Path $d 'hooks/mods.mjs') -Destination (Join-Path $d 'hooks/delegation-ledger.txt')
    (Get-Content -LiteralPath $p -Raw).Replace('"./mods.mjs"', '"./delegation-ledger.txt"') |
        Set-Content -LiteralPath $p -NoNewline
} -Expect 'has a suffix the host does not load'

# An upper-case suffix: the reference names lower-case suffixes, so `-notin`'s case folding is wrong.
Try-Case 'module-suffix-case' {
    param($d)
    $p = Join-Path $d 'hooks/hooks.json'
    Copy-Item -LiteralPath (Join-Path $d 'hooks/mods.mjs') -Destination (Join-Path $d 'hooks/delegation-ledger2.MJS')
    (Get-Content -LiteralPath $p -Raw).Replace('"./mods.mjs"', '"./delegation-ledger2.MJS"') |
        Set-Content -LiteralPath $p -NoNewline
} -Expect 'has a suffix the host does not load'

# A module that exists in this checkout but outside the plugin root never ships.
Try-Case 'module-outside-root' {
    param($d)
    $p = Join-Path $d 'hooks/hooks.json'
    $outside = Join-Path (Split-Path -Parent $d) 'outside-module.mjs'
    Copy-Item -LiteralPath (Join-Path $d 'hooks/mods.mjs') -Destination $outside -Force
    (Get-Content -LiteralPath $p -Raw).Replace('"./mods.mjs"', '"../../outside-module.mjs"') |
        Set-Content -LiteralPath $p -NoNewline
} -Expect 'resolves outside the plugin root'

Try-Case 'no-events' {
    param($d)
    $p = Join-Path $d 'hooks/hooks.json'
    '{"hooks":{}}' | Set-Content -LiteralPath $p -NoNewline
}

# Same class as no-events, one level down: the event exists but its handler array is empty, so
# the hook is registered and never runs. Enumerated because the no-events defect was an instance
# of "@($null).Count is 1", not a one-off.
Try-Case 'event-with-no-handlers' {
    param($d)
    $p = Join-Path $d 'hooks/hooks.json'
    '{"hooks":{"SubagentStop":[{"hooks":[]}]}}' | Set-Content -LiteralPath $p -NoNewline
}

# The defect a live session found and the whole suite had missed: every selftest calls the scripts
# directly, so nothing went through the host's component registry, where a bare name does not
# resolve. Both forms are pinned — the runtime-fatal one and the copy-paste one.
Try-Case 'bare-workflow-call' {
    param($d)
    $p = Join-Path $d 'README.md'
    Add-Content -LiteralPath $p -Value "`nRun it: Workflow({name: 'adversarial-review', args: {}})`n"
}

Try-Case 'bare-skill-slash' {
    param($d)
    $p = Join-Path $d 'README.md'
    Add-Content -LiteralPath $p -Value "`nThen invoke ``/verify`` to check it.`n"
}

# Two copies of one script are only safe while something proves they are the same file. Without
# this case, a fix applied to scripts/ would silently never reach a scaffolded repo, and the symptom
# would read as "the consumer is behind" instead of "the canon ships two different files".
Try-Case 'vendored-copy-diverged' {
    param($d)
    $p = Join-Path $d 'skills/harness-init/templates/scripts/harness/harness_config.py'
    Add-Content -LiteralPath $p -Value "`n# local drift`n"
}

# Same length, same byte multiset, two lines swapped — the copy a set compare (Compare-Object over
# byte arrays, the gate's first cut) read as identical (2026-09-28). The swap is done on the BYTES,
# so length and multiset hold by construction (a text round trip could drop a BOM and fall back to
# what the old length check caught), and the verdict needs the DIVERGED line naming this file — an
# exit 1 from any other check would otherwise keep the case green over a reverted compare (review
# 2026-09-28, both low). The two lines must differ or the swap proves nothing; that throws.
$dir = Reset-Fixture $pluginFx
$p = Join-Path $dir 'skills/harness-init/templates/scripts/harness/harness_config.py'
$b = [IO.File]::ReadAllBytes($p)
$e0 = [Array]::IndexOf($b, [byte]10)
$e1 = if ($e0 -ge 0) { [Array]::IndexOf($b, [byte]10, $e0 + 1) } else { -1 }
if ($e1 -lt 0 -or [Linq.Enumerable]::SequenceEqual([byte[]]$b[0..$e0], [byte[]]$b[($e0 + 1)..$e1])) { throw 'vendored-copy-reordered: harness_config.py has no two distinct leading lines to swap' }
$tail = if ($e1 + 1 -lt $b.Length) { $b[($e1 + 1)..($b.Length - 1)] } else { @() }
[IO.File]::WriteAllBytes($p, [byte[]]($b[($e0 + 1)..$e1] + $b[0..$e0] + $tail))
$g = Invoke-Gate (Join-Path $dir 'manifest-gate.mjs')
$caught = ($g.Code -eq 1) -and ($g.Out -match 'vendored copy DIVERGED: harness_config\.py')
if ($caught) { Write-Host 'PASS [vendored-copy-reordered] gate exited 1 and named harness_config.py DIVERGED' -ForegroundColor Green }
else { Write-Host "FAIL [vendored-copy-reordered] exit=$($g.Code) aborted=$($g.Aborted) diverged-named=$([bool]($g.Out -match 'vendored copy DIVERGED: harness_config\.py'))" -ForegroundColor Red }
$results += [pscustomobject]@{ case = 'vendored-copy-reordered'; exit = $(if ($caught) { 1 } else { 0 }) }

Try-Case 'vendored-copy-orphaned' {
    param($d)
    Remove-Item -LiteralPath (Join-Path $d 'scripts/harness_config.py') -Force
}

Try-Case 'unparseable-manifest' {
    param($d)
    $p = Join-Path $d '.claude-plugin/plugin.json'
    '{ this is not json' | Set-Content -LiteralPath $p -NoNewline
}

# The release-notes canon (ADR 0030): a release shipping without notes, with stale notes, or
# with a link that no longer matches the hook's would each surface only on member machines —
# as a bullet-less or wrong-tab announcement — which is why the gate owns them canon-side.
Try-Case 'changelog-missing' {
    param($d)
    Remove-Item -LiteralPath (Join-Path $d 'CHANGELOG.md') -Force
}

Try-Case 'changelog-version-stale' {
    param($d)
    $p = Join-Path $d 'CHANGELOG.md'
    $j = Get-Content -LiteralPath (Join-Path $d '.claude-plugin/plugin.json') -Raw | ConvertFrom-Json
    (Get-Content -LiteralPath $p -Raw).Replace("## v$($j.version)", '## v0.0.1') |
        Set-Content -LiteralPath $p -NoNewline
}

Try-Case 'rn-url-diverged' {
    param($d)
    $p = Join-Path $d 'CHANGELOG.md'
    (Get-Content -LiteralPath $p -Raw) -replace 'artifact/[0-9a-f-]+#rn', 'artifact/00000000-0000-0000-0000-000000000000#rn' |
        Set-Content -LiteralPath $p -NoNewline
}

# The same divergence from the OTHER side: the hook is Node now (ADR 0116), and the gate must read
# the `.mjs` constant — a gate still pointed at the retired `.ps1` would read an empty URL for the
# hook and fail as "link missing" for the wrong reason, or pass vacuously if it skipped the check.
Try-Case 'rn-url-hook-diverged' {
    param($d)
    $p = Join-Path $d 'hooks/session-start-version-announce.mjs'
    (Get-Content -LiteralPath $p -Raw) -replace 'artifact/[0-9a-f-]+#rn', 'artifact/00000000-0000-0000-0000-000000000000#rn' |
        Set-Content -LiteralPath $p -NoNewline
}

# The interpolation trap ADR 0045 makes reachable in every hook: Korean letters are legal in a
# PS variable name, so "$ver를" interpolates an undefined variable named ver를 as EMPTY — the
# value silently vanishes from the member banner (measured live 2026-08-11; the hook suites'
# joined sys+ctx match stayed green through the English context half). The gate must refuse the
# CLASS on a non-comment line; the comment-skip is what keeps hooks free to DOCUMENT the trap.
Try-Case 'hangul-glued-variable' {
    param($d)
    # A new pwsh hook (ADR 0116: the gate scans hooks/*.ps1 only — the trap cannot exist in .mjs).
    # None ships since ADR 0142, so the case creates one.
    $p = Join-Path $d 'hooks/session-start-probe.ps1'
    Add-Content -LiteralPath $p -Value "`n`$probe = `"지금 `$ver를 실행`"`n"
}

# Class-4 honesty, asserted on the MESSAGE not the exit code: with plugin.json corrupt and the
# CHANGELOG intact, the gate already exits 1 from the manifest Bad — so an exit-code-only case
# can never catch the defect this pins, which was the CHANGELOG check printing a false
# "(matches plugin.json)" PASS for a comparison it never ran (review 2026-08-05, medium). The
# skipped comparison must say NOT CHECKED.
$dir = Reset-Fixture $pluginFx
'{ this is not json' | Set-Content -LiteralPath (Join-Path $dir '.claude-plugin/plugin.json') -NoNewline
$g = Invoke-Gate (Join-Path $dir 'manifest-gate.mjs')
$out = $g.Out
$rc = $g.Code
$honest = ($rc -eq 1) -and ($out -notmatch '\(matches plugin\.json\)') -and ($out -match 'NOT CHECKED')
if ($honest) { Write-Host 'PASS [changelog-check-broken-manifest] no false "(matches plugin.json)"; NOT CHECKED reported' -ForegroundColor Green }
else { Write-Host "FAIL [changelog-check-broken-manifest] exit=$rc falseMatchClaim=$([bool]($out -match '\(matches plugin\.json\)')) notCheckedReported=$([bool]($out -match 'NOT CHECKED'))" -ForegroundColor Red }
$results += [pscustomobject]@{ case = 'changelog-check-broken-manifest'; exit = $(if ($honest) { 1 } else { 0 }) }

# --- dogfood placement sweep (ADR 0037 follow-up) ----------------------------------------------
# Canon-shape fixtures: repo/.harness.json + repo/plugins/ywr-harness/<plugin copy>. Placements
# are laid per case — an absent destination is "not placed", never a failure, so a minimal
# fixture exercises exactly the branch under test without running the scaffold (which would drag
# python/git into a suite that needs neither). Positive cases assert the MESSAGE as well as the
# exit code, the changelog-check-broken-manifest precedent.
# One canon-shape fixture serves every canon case below, reset and asserted per case — the git
# cases included: their `.git` is an entry the snapshot lacks, so the reset removes it.
$canonFx = New-Fixture 'canon' {
    param($repo)
    New-Item -ItemType Directory -Force -Path (Join-Path $repo 'plugins') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $repo '.claude-plugin') | Out-Null
    Copy-PluginTree $src (Join-Path $repo 'plugins/ywr-harness')
    Set-Content -LiteralPath (Join-Path $repo '.harness.json') -Value '{}' -NoNewline
    Set-Content -LiteralPath (Join-Path $repo '.claude-plugin/marketplace.json') -Value '{}' -NoNewline
}
function New-CanonShape([string]$tag) {
    return Reset-Fixture $canonFx
}
function Run-GateAt([string]$repo) {
    $g = Invoke-Gate (Join-Path $repo 'plugins/ywr-harness/manifest-gate.mjs')
    return @{ out = $g.Out; rc = $g.Code }
}
function Record([string]$tag, [bool]$asRequired, [string]$detail) {
    if ($asRequired) { Write-Host "PASS [$tag] $detail" -ForegroundColor Green }
    else { Write-Host "FAIL [$tag] $detail" -ForegroundColor Red }
    $script:results += [pscustomobject]@{ case = $tag; exit = $(if ($asRequired) { 1 } else { 0 }) }
}

# A drifted TOOLCHAIN placement must fail — this is the exact class ADR 0037 recorded as ungated.
$r = New-CanonShape 'placement-drifted'
New-Item -ItemType Directory -Force -Path (Join-Path $r '.githooks') | Out-Null
Set-Content -LiteralPath (Join-Path $r '.githooks/pre-commit') -Value '#!/bin/sh
echo drifted' -NoNewline
$g = Run-GateAt $r
Record 'placement-drifted' ($g.rc -eq 1 -and $g.out -match 'dogfood placement DIVERGED: \.githooks/pre-commit') "exit=$($g.rc) diverged-named=$([bool]($g.out -match 'DIVERGED'))"

# A CR-only difference is NOT drift — ADR 0033's fold contract, shared with the scaffold report
# and the refresh nudge (the seed .gitattributes pins *.ps1 eol=crlf, so raw bytes MUST not decide).
$r = New-CanonShape 'placement-cr-only'
$tpl = [IO.File]::ReadAllBytes((Join-Path $r 'plugins/ywr-harness/skills/harness-init/templates/scripts/harness/harness_config.py'))
$crlf = [System.Text.Encoding]::Latin1.GetString($tpl).Replace("`r`n", "`n").Replace("`n", "`r`n")
New-Item -ItemType Directory -Force -Path (Join-Path $r 'scripts/harness') | Out-Null
[IO.File]::WriteAllBytes((Join-Path $r 'scripts/harness/harness_config.py'), [System.Text.Encoding]::Latin1.GetBytes($crlf))
$g = Run-GateAt $r
Record 'placement-cr-only-not-drift' ($g.rc -eq 0 -and $g.out -match 'dogfood placements identical .*1 checked') "exit=$($g.rc) identical-1-checked=$([bool]($g.out -match '1 checked'))"

# A GUARDED destination without the marker is a foreign file: skipped and NAMED, exactly as the
# scaffold refuses it — never compared, never failed.
$r = New-CanonShape 'placement-foreign-guarded'
New-Item -ItemType Directory -Force -Path (Join-Path $r '.githooks') | Out-Null
Set-Content -LiteralPath (Join-Path $r '.githooks/post-commit') -Value '#!/bin/sh
# my own automation, not the scaffold''s' -NoNewline
$g = Run-GateAt $r
Record 'placement-foreign-guarded-skipped' ($g.rc -eq 0 -and $g.out -match 'foreign \(no scaffold marker\), skipped .*post-commit') "exit=$($g.rc) foreign-named=$([bool]($g.out -match 'foreign'))"

# A GUARDED file that DOES carry the marker is ours — drift in it must fail like any placement.
$r = New-CanonShape 'placement-guarded-marked-drift'
New-Item -ItemType Directory -Force -Path (Join-Path $r '.githooks') | Out-Null
Set-Content -LiteralPath (Join-Path $r '.githooks/post-commit') -Value '#!/bin/sh
# ywr-harness:post-commit
echo drifted' -NoNewline
$g = Run-GateAt $r
Record 'placement-guarded-marked-drift' ($g.rc -eq 1 -and $g.out -match 'dogfood placement DIVERGED: \.githooks/post-commit') "exit=$($g.rc)"

# The pair list is parsed from init.ps1 — a parse that yields nothing must FAIL, not sweep zero
# pairs and read as coverage.
$r = New-CanonShape 'placement-map-unparseable'
$ip = Join-Path $r 'plugins/ywr-harness/skills/harness-init/init.ps1'
(Get-Content -LiteralPath $ip -Raw).Replace('$TOOLCHAIN = [ordered]@{', '$RENAMED_MAP = [ordered]@{') | Set-Content -LiteralPath $ip -NoNewline
$g = Run-GateAt $r
Record 'placement-map-unparseable' ($g.rc -eq 1 -and $g.out -match 'an empty sweep is not a pass') "exit=$($g.rc)"

# A PARTIALLY unparseable map is the silent-narrowing variant: one entry rewritten in a form the
# parser does not read must FAIL loudly, not drop that one pair while the sweep still counts >0.
$r = New-CanonShape 'placement-map-partial-parse'
$ip = Join-Path $r 'plugins/ywr-harness/skills/harness-init/init.ps1'
(Get-Content -LiteralPath $ip -Raw).Replace("'githooks/pre-commit'                    = '.githooks/pre-commit'", '"githooks/pre-commit"                    = ".githooks/pre-commit"') | Set-Content -LiteralPath $ip -NoNewline
$g = Run-GateAt $r
Record 'placement-map-partial-parse' ($g.rc -eq 1 -and $g.out -match 'unparsed entry line') "exit=$($g.rc) unparsed-named=$([bool]($g.out -match 'unparsed entry line'))"

# Same class, non-quote-prefixed: a bareword key does not LOOK like a quoted entry, and the
# first cut's quote-prefixed guard let exactly that vanish (review 2026-08-07, medium).
$r = New-CanonShape 'placement-map-bareword-key'
$ip = Join-Path $r 'plugins/ywr-harness/skills/harness-init/init.ps1'
(Get-Content -LiteralPath $ip -Raw).Replace("'githooks/pre-commit'                    = '.githooks/pre-commit'", "githooks_precommit                    = '.githooks/pre-commit'") | Set-Content -LiteralPath $ip -NoNewline
$g = Run-GateAt $r
Record 'placement-map-bareword-key' ($g.rc -eq 1 -and $g.out -match 'unparsed entry line') "exit=$($g.rc)"

# GUARDED emptiness must fail SYMMETRICALLY with TOOLCHAIN: Get-PlacementMap returns a real
# empty dictionary when the wrapper matches but nothing inside parses, so a null-check alone
# lets one family's coverage vanish while the sweep still reports green (review 2026-08-07,
# high). Commenting out the single entry is exactly the merge-accident shape.
$r = New-CanonShape 'placement-map-guarded-emptied'
$ip = Join-Path $r 'plugins/ywr-harness/skills/harness-init/init.ps1'
(Get-Content -LiteralPath $ip -Raw).Replace("    'githooks/post-commit' = '.githooks/post-commit'", "    # 'githooks/post-commit' = '.githooks/post-commit'") | Set-Content -LiteralPath $ip -NoNewline
$g = Run-GateAt $r
Record 'placement-map-guarded-emptied' ($g.rc -eq 1 -and $g.out -match 'an empty sweep is not a pass' -and $g.out -match 'guarded=0') "exit=$($g.rc) guarded0-named=$([bool]($g.out -match 'guarded=0'))"

# A consuming repo that hand-vendors the plugin tree has a declaration but NOT the publisher's
# root marketplace manifest — sweeping its placements against a vendored plugin version would
# fail on version skew, not drift, so the shape must skip and say so (review 2026-08-07, low).
$r = Join-Path $base 'placement-skip-vendored-consumer/repo'
New-Item -ItemType Directory -Force -Path (Join-Path $r 'plugins') | Out-Null
Copy-PluginTree $src (Join-Path $r 'plugins/ywr-harness')
Set-Content -LiteralPath (Join-Path $r '.harness.json') -Value '{}' -NoNewline
$g = Invoke-Gate (Join-Path $r 'plugins/ywr-harness/manifest-gate.mjs')
$out = $g.Out
Record 'placement-skip-vendored-consumer' ($g.Code -eq 0 -and $out -match 'dogfood placements: skipped' -and $out -match 'release lockstep: skipped — not the canon dogfood shape') "exit=$($g.Code) skip-said=$([bool]($out -match 'dogfood placements: skipped')) lockstep-skip-said=$([bool]($out -match 'release lockstep: skipped'))"

# The plugins/ parent WITHOUT a .harness.json above (the dist/marketplace-cache shape) is not a
# scaffolded repo: the sweep must say it skipped, not pass silently and not fail.
$r = Join-Path $base 'placement-skip-cache-shape/plugins'
New-Item -ItemType Directory -Force -Path $r | Out-Null
Copy-PluginTree $src (Join-Path $r 'ywr-harness')
$g = Invoke-Gate (Join-Path $r 'ywr-harness/manifest-gate.mjs')
$out = $g.Out
Record 'placement-skip-cache-shape' ($g.Code -eq 0 -and $out -match 'dogfood placements: skipped' -and $out -match 'release lockstep: skipped — not the canon dogfood shape') "exit=$($g.Code) skip-said=$([bool]($out -match 'dogfood placements: skipped')) lockstep-skip-said=$([bool]($out -match 'release lockstep: skipped'))"

# Copy-PluginTree's two branches (O80 review): every fixture above takes the git-listed branch from
# this checkout, so the whole-directory fallback — the Linux parity image's path — needs its own case.
# A GIT_DIR that does not exist makes `ls-files` fail wherever the temp root sits. The fallback must
# carry every file (an ignored-looking one included) and an empty directory, un-nested under $To.
$fbSrc = Join-Path $base 'copy-fallback-src'
foreach ($f in 'a.txt', 'sub/b.txt', 'evals/results/r.json') {
    $fp = Join-Path $fbSrc $f
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $fp) | Out-Null
    [IO.File]::WriteAllText($fp, $f)
}
New-Item -ItemType Directory -Force -Path (Join-Path $fbSrc 'empty') | Out-Null
$fbDst = Join-Path $base 'copy-fallback-dst'
$prevGitDir = $env:GIT_DIR
try { $env:GIT_DIR = Join-Path $base 'no-such-git-dir'; Copy-PluginTree $fbSrc $fbDst }
finally { $env:GIT_DIR = $prevGitDir }
$fbMissing = @(@('a.txt', 'sub/b.txt', 'evals/results/r.json') | Where-Object { -not [IO.File]::Exists((Join-Path $fbDst $_)) }) +
             @(@('empty') | Where-Object { -not [IO.Directory]::Exists((Join-Path $fbDst $_)) })
$fbNested = [IO.Directory]::Exists((Join-Path $fbDst 'copy-fallback-src'))
Record 'fixture-copy-fallback-whole-dir' (-not $fbMissing.Count -and -not $fbNested) "missing=$($fbMissing -join ',') nested=$fbNested"
# The git-listed branch: a path this checkout ignores must be absent from the plugin fixture. A clean
# checkout (CI) ignores nothing, which leaves nothing to assert, and the line says so.
$ignored = @()
if (Get-Command git -ErrorAction SilentlyContinue) {
    $raw = (& git -C $src -c core.quotepath=false ls-files -z --others --ignored --exclude-standard 2>$null) -join "`n"
    if ($LASTEXITCODE -eq 0) { $ignored = @($raw -split "`0" | Where-Object { $_ }) }
}
if ($ignored.Count) {
    $leaked = @($ignored | Where-Object { [IO.File]::Exists((Join-Path $pluginFx.pristine $_)) })
    Record 'fixture-copy-git-skips-ignored' (-not $leaked.Count) "ignored=$($ignored.Count) leaked=$($leaked.Count)$(if ($leaked.Count) { ' first=' + $leaked[0] })"
} else {
    Record 'fixture-copy-git-skips-ignored' $true 'no gitignored file in this checkout — nothing to assert (reported, not silent)'
}

# --- release lockstep (ADR 0073) ----------------------------------------------------------------
# Canon-shape fixtures that ARE git repos — the check needs a tag to compare against. ONE such repo is
# built per suite run (handoff O31, ADR 0111): the canon shape at version 9.9.9 with README.md as LF and
# a non-ASCII-named file, then init · config · add · commit · tag once (measured 2026-09-03 on this box
# under review-agent load: 183 + 60 + 692 + 411 + 64 ms, ≈1.4 s) and packed, so `.git` holds a handful
# of files instead of ~400 (Assert-FixturePristine hashes every file of it after every reset). Each case
# then resets that tree — zero fixture spawns per case; the ten cases paid the ≈1.4 s ten times —
# and applies ONLY its working-tree mutation. A case that corrupts `.git` (lockstep-git-fails-after-tag
# writes `.git/index`) is undone by the reset like any other mutation, and so is any index refresh the
# gate's own `git diff` writes; the asserted reset proves it. The gate's own three or four git calls
# (≈0.5 s on top of a gate run) stay per case. The plain canon-shape fixtures above are not git
# repos and must report the check SKIPPED, never pass it silently. Identity rides on the commit as `-c`
# flags so no fixture depends on a repo-local or global identity (the harness_gates.selftest precedent).
$gitHere = [bool](Get-Command git -ErrorAction SilentlyContinue)
$lockFx = $null   # built inside the $gitHere branch below; every case resets it
function New-LockstepRepo([string]$tag) {
    return Reset-Fixture $lockFx
}
# The release-notes canon (ADR 0030) must stay green in these fixtures or the exit code stops
# isolating the lockstep check: the top CHANGELOG entry follows the fixture's version.
function Set-LockstepChangelogTop([string]$repo, [string]$version) {
    $clp = Join-Path $repo 'plugins/ywr-harness/CHANGELOG.md'
    $cl = Get-Content -LiteralPath $clp -Raw
    $cl = [regex]::new('(?m)^## v\d+\.\d+\.\d+').Replace($cl, "## v$version", 1)
    Set-Content -LiteralPath $clp -Value $cl -NoNewline
}
function Set-LockstepVersion([string]$repo, [string]$version) {
    $mfp = Join-Path $repo 'plugins/ywr-harness/.claude-plugin/plugin.json'
    $j = Get-Content -LiteralPath $mfp -Raw | ConvertFrom-Json
    $j.version = $version
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $mfp -NoNewline
    Set-LockstepChangelogTop $repo $version
}

if (-not $gitHere) {
    Write-Host 'SKIP [lockstep-*] git not on PATH — the ten release-lockstep fixture cases did not run (reported, not silent)' -ForegroundColor Yellow
} else {
    # The one lockstep repo (see the section comment): version 9.9.9 in plugin.json and the CHANGELOG top,
    # README.md committed as LF (the CR-only case rewrites it), and a NON-ASCII-named file committed
    # (ADR 0102 re-ask, review F6). The name is part of the shared base: no other case touches it, so it
    # equals the tag there and moves no other case's expected count.
    $latin1 = [System.Text.Encoding]::Latin1
    $koName = [string]::new([char[]]@(0xD55C, 0xAE00)) + '-notes.md'
    $koBody = "ko line one`nko line two`n"
    $lockFx = New-Fixture 'lockstep' {
        param($repo)
        Copy-Item -LiteralPath $canonFx.pristine -Destination $repo -Recurse -Force
        Set-LockstepVersion $repo '9.9.9'
        $p = Join-Path $repo 'plugins/ywr-harness/README.md'
        $lf = $latin1.GetString([IO.File]::ReadAllBytes($p)).Replace("`r`n", "`n")
        [IO.File]::WriteAllBytes($p, $latin1.GetBytes($lf))
        [IO.File]::WriteAllBytes((Join-Path $repo "plugins/ywr-harness/$koName"), [Text.Encoding]::ASCII.GetBytes($koBody))
        # --template= : no sample hooks in `.git`, so the asserted reset hashes fewer files.
        & git -C $repo init -q --template= 2>$null | Out-Null
        & git -C $repo config core.autocrlf false 2>$null | Out-Null
        & git -C $repo add -A 2>$null | Out-Null
        & git -C $repo -c user.name=selftest -c user.email=selftest@example.invalid commit -q -m fixture 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "lockstep fixture: git commit failed (exit $LASTEXITCODE)" }
        & git -C $repo tag 'ywr-harness--v9.9.9' 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "lockstep fixture: git tag failed (exit $LASTEXITCODE)" }
        # One pack instead of a loose object per file (repack -d also removes the packed loose ones).
        & git -C $repo repack -a -d -q 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "lockstep fixture: git repack failed (exit $LASTEXITCODE)" }
    }

    # The tag names plugin.json's version and the tree equals the tag: the lockstep holds.
    $r = New-LockstepRepo 'lockstep-identical'
    $g = Run-GateAt $r
    Record 'lockstep-identical' ($g.rc -eq 0 -and $g.out -match 'release lockstep: plugins/ywr-harness identical to tag ywr-harness--v9\.9\.9') "exit=$($g.rc) identical-said=$([bool]($g.out -match 'identical to tag'))"

    # The #3 shape: a shipped file moves after the tag, plugin.json still names the released version.
    $r = New-LockstepRepo 'lockstep-moved-unbumped'
    Add-Content -LiteralPath (Join-Path $r 'plugins/ywr-harness/README.md') -Value "`nmoved after the tag" -NoNewline
    $g = Run-GateAt $r
    Record 'lockstep-moved-unbumped' ($g.rc -eq 1 -and $g.out -match 'release lockstep BROKEN: 1 file\(s\).*plugins/ywr-harness/README\.md') "exit=$($g.rc) broken-named=$([bool]($g.out -match 'lockstep BROKEN'))"

    # An untracked NEW file under the shipped tree is the same defect — `git diff` alone misses it.
    $r = New-LockstepRepo 'lockstep-untracked-new-file'
    Set-Content -LiteralPath (Join-Path $r 'plugins/ywr-harness/NEW-SHIPPED-FILE.md') -Value 'new after the tag' -NoNewline
    $g = Run-GateAt $r
    Record 'lockstep-untracked-new-file' ($g.rc -eq 1 -and $g.out -match 'release lockstep BROKEN: 1 file\(s\).*NEW-SHIPPED-FILE\.md') "exit=$($g.rc) broken-named=$([bool]($g.out -match 'lockstep BROKEN'))"

    # The remedy: the same move WITH the bump in the same tree — no tag names the new version, so
    # there is nothing to compare and the check says exactly that.
    $r = New-LockstepRepo 'lockstep-bumped-unreleased'
    Add-Content -LiteralPath (Join-Path $r 'plugins/ywr-harness/README.md') -Value "`nmoved after the tag" -NoNewline
    Set-LockstepVersion $r '9.9.10'
    $g = Run-GateAt $r
    Record 'lockstep-bumped-unreleased' ($g.rc -eq 0 -and $g.out -match 'release lockstep: no local tag ywr-harness--v9\.9\.10' -and $g.out -notmatch 'lockstep BROKEN') "exit=$($g.rc) no-tag-said=$([bool]($g.out -match 'no local tag'))"

    # CR-only divergence is NOT drift — ADR 0033's fold, the contract the dogfood sweep and the
    # refresh nudge already use (review 2026-09-03, medium): a .gitattributes renormalization
    # between the tag and now must not fail a release whose content did not move. The tag holds
    # README.md as LF; the working tree then carries it as CRLF, and only that.
    $r = New-LockstepRepo 'lockstep-cr-only-not-drift'
    $p = Join-Path $r 'plugins/ywr-harness/README.md'
    $crlf = $latin1.GetString([IO.File]::ReadAllBytes($p)).Replace("`n", "`r`n")
    [IO.File]::WriteAllBytes($p, $latin1.GetBytes($crlf))
    $g = Run-GateAt $r
    Record 'lockstep-cr-only-not-drift' ($g.rc -eq 0 -and $g.out -match 'release lockstep: plugins/ywr-harness identical to tag ywr-harness--v9\.9\.9') "exit=$($g.rc) identical-said=$([bool]($g.out -match 'identical to tag')) broken-said=$([bool]($g.out -match 'lockstep BROKEN'))"

    # The two "never a false pass" branches (review 2026-09-03, medium — the changelog-check-
    # broken-manifest precedent): a tag that WOULD be checked, and the check cannot run.
    # (1) plugin.json unreadable while the tag exists: the lockstep line must say NOT CHECKED,
    # never "identical" and never "no local tag".
    $r = New-LockstepRepo 'lockstep-unreadable-manifest-with-tag'
    Set-Content -LiteralPath (Join-Path $r 'plugins/ywr-harness/.claude-plugin/plugin.json') -Value '{ not json' -NoNewline
    $g = Run-GateAt $r
    Record 'lockstep-unreadable-manifest-with-tag' ($g.rc -eq 1 -and $g.out -match 'release lockstep: plugin.json version unreadable .*NOT CHECKED' -and $g.out -notmatch 'identical to tag' -and $g.out -notmatch 'no local tag') "exit=$($g.rc) not-checked-said=$([bool]($g.out -match 'NOT CHECKED'))"
    # (2) git itself fails AFTER the tag is confirmed: a corrupt index kills `diff` and `ls-files`
    # (both read it) while `rev-parse` of a tag ref does not — the check must fail as NOT
    # CHECKED, not report BROKEN over an empty list and not report identical.
    $r = New-LockstepRepo 'lockstep-git-fails-after-tag'
    [IO.File]::WriteAllBytes((Join-Path $r '.git/index'), [byte[]](1..24))
    $g = Run-GateAt $r
    Record 'lockstep-git-fails-after-tag' ($g.rc -eq 1 -and $g.out -match 'release lockstep: git diff / ls-files against ywr-harness--v9\.9\.9 failed .*NOT CHECKED' -and $g.out -notmatch 'lockstep BROKEN' -and $g.out -notmatch 'identical to tag') "exit=$($g.rc) not-checked-said=$([bool]($g.out -match 'NOT CHECKED'))"

    # A version the tag name cannot be derived from must not route to the no-tag PASS (review
    # 2026-09-03, low): the manifest check accepts a suffix, a ref name does not.
    $r = New-LockstepRepo 'lockstep-version-suffix-not-checked'
    $mfp = Join-Path $r 'plugins/ywr-harness/.claude-plugin/plugin.json'
    $j = Get-Content -LiteralPath $mfp -Raw | ConvertFrom-Json
    $j.version = '9.9.9 rc'
    $j | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $mfp -NoNewline
    $g = Run-GateAt $r
    Record 'lockstep-version-suffix-not-checked' ($g.rc -eq 1 -and $g.out -match "release lockstep: plugin.json version '9\.9\.9 rc' is not a plain major\.minor\.patch.*NOT CHECKED" -and $g.out -notmatch 'no local tag') "exit=$($g.rc) not-checked-said=$([bool]($g.out -match 'not a plain major'))"

    # The NON-ASCII tracked name of the base (ADR 0102 re-ask, review F6): the -z list and the per-file re-ask
    # must see the name as itself — a misdecoded name matches no path, --quiet exits 0, and the moved
    # file would read identical. The gate decodes git's bytes once as UTF-8 (hook-lib gitRun), so no
    # console code page reaches it; this case pins the decode and the literal pathspec.
    $r = New-LockstepRepo 'lockstep-non-ascii-moved'
    [IO.File]::WriteAllBytes((Join-Path $r "plugins/ywr-harness/$koName"), [Text.Encoding]::ASCII.GetBytes($koBody + "moved after the tag`n"))
    $g = Run-GateAt $r
    Record 'lockstep-non-ascii-moved' ($g.rc -eq 1 -and $g.out -match "release lockstep BROKEN: 1 file\(s\).*plugins/ywr-harness/$([regex]::Escape($koName))") "exit=$($g.rc) broken-named=$([bool]($g.out -match 'lockstep BROKEN')) identical-said=$([bool]($g.out -match 'identical to tag'))"

    # The same name with a CR-only change is identical (git 2.34 lists it in --name-only; the
    # re-ask must drop it — the non-ASCII pathspec has to reach git intact for that).
    $r = New-LockstepRepo 'lockstep-non-ascii-cr-only'
    [IO.File]::WriteAllBytes((Join-Path $r "plugins/ywr-harness/$koName"), [Text.Encoding]::ASCII.GetBytes($koBody.Replace("`n", "`r`n")))
    $g = Run-GateAt $r
    Record 'lockstep-non-ascii-cr-only' ($g.rc -eq 0 -and $g.out -match 'release lockstep: plugins/ywr-harness identical to tag ywr-harness--v9\.9\.9') "exit=$($g.rc) identical-said=$([bool]($g.out -match 'identical to tag')) broken-said=$([bool]($g.out -match 'lockstep BROKEN'))"
}

# A canon shape that is NOT a git repo (every fixture above this section) must report the check
# skipped — with git absent the skip names that instead; either way it is said, never silent.
$r = New-CanonShape 'lockstep-not-a-repo-skips'
$g = Run-GateAt $r
Record 'lockstep-not-a-repo-skips' ($g.rc -eq 0 -and $g.out -match 'release lockstep: skipped — ') "exit=$($g.rc) skip-said=$([bool]($g.out -match 'release lockstep: skipped'))"

# --- canon ADR references (ADR 0095) ---------------------------------------------------------------
# Git fixtures (the check reads `git ls-files`, never a directory walk): the canon shape plus a
# docs/adr/ holding an empty file for every REAL canon ADR, so the copied plugin's own citations
# resolve exactly as in the canon and each case isolates the one reference it adds. The unresolved
# number is assembled at runtime — this file is itself scanned by the gate it tests.
# A plugin tree mounted at a filesystem root (the Linux parity container's /repo) has no grandparent:
# Split-Path returns '' and Join-Path refused it, killing the suite before the SKIP guard below.
$canonGuess = Split-Path -Parent $src
if ($canonGuess) { $canonGuess = Split-Path -Parent $canonGuess }
$realAdrDir = if ($canonGuess) { Join-Path $canonGuess 'docs/adr' } else { '' }
$badNum = '09' + '99'
# ONE such repo per suite run (handoff O31, ADR 0111), built lazily in the branch below: the canon
# shape minus the owner's gitignored eval results, the docs/adr/ stubs, then init · config · add -A once.
# Each case resets it (asserted) and pays ONE spawn — `git add` of only the paths the case wrote — in
# place of init · config · add -A over ~250 files (≈0.7 s for the add alone, measured 2026-09-30); the
# stub ADR files are already in the snapshot's index, and the case's $Untracked files are written after
# that add so they stay untracked. The snapshot holds one commit, for packing only — the check reads
# the index (`git ls-files`), and a case's `git add` stays uncommitted.
$adrFx = $null
function New-AdrRefRepo([string]$tag, [hashtable]$Files, [hashtable]$Untracked = @{}) {
    $repo = Reset-Fixture $adrFx
    $put = {
        param($set)
        foreach ($k in $set.Keys) {
            $fp = Join-Path $repo $k
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $fp) | Out-Null
            [IO.File]::WriteAllText($fp, $set[$k])
        }
    }
    & $put $Files
    if ($Files.Count) {
        & git -C $repo add -- @($Files.Keys) 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "adr-ref fixture '$tag': git add failed (exit $LASTEXITCODE)" }
    }
    & $put $Untracked
    return $repo
}
if (-not $gitHere -or -not $realAdrDir -or -not (Test-Path -LiteralPath $realAdrDir -PathType Container)) {
    Write-Host 'SKIP [adr-ref] needs git and the canon''s docs/adr/ (a dist or consumer copy has none) — reported, not silent' -ForegroundColor Yellow
} else {
    $adrFx = New-Fixture 'adr-ref' {
        param($repo)
        Copy-Item -LiteralPath $canonFx.pristine -Destination $repo -Recurse -Force
        # Copy-PluginTree's whole-directory fallback carries the owner's gitignored eval results (the
        # git-listed copy has none); tracked in the fixture, a model answer
        # quoting a foreign number would fail the control on one machine only.
        Remove-Item -LiteralPath (Join-Path $repo 'plugins/ywr-harness/evals/results') -Recurse -Force -ErrorAction SilentlyContinue
        $ad = Join-Path $repo 'docs/adr'
        New-Item -ItemType Directory -Force -Path $ad | Out-Null
        # 0000-template.md is left out: it is a scaffold placement, and an empty copy reads as drift.
        foreach ($a in @(Get-ChildItem -LiteralPath $realAdrDir -File -Filter '*.md' | Where-Object { $_.Name -match '^\d{4}-' -and $_.Name -notmatch '^0000-' })) {
            [IO.File]::WriteAllText((Join-Path $ad $a.Name), '')
        }
        & git -C $repo init -q --template= 2>$null | Out-Null
        & git -C $repo config core.autocrlf false 2>$null | Out-Null
        & git -C $repo add -A 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "adr-ref fixture: git add failed (exit $LASTEXITCODE)" }
        # Commit + pack only so `.git` is a few files, not a loose object per tracked file (the asserted
        # reset hashes every one after every case); the check reads the index, never HEAD.
        & git -C $repo -c user.name=selftest -c user.email=selftest@example.invalid commit -q -m fixture 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "adr-ref fixture: git commit failed (exit $LASTEXITCODE)" }
        & git -C $repo repack -a -d -q 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "adr-ref fixture: git repack failed (exit $LASTEXITCODE)" }
    }
    # Control: nothing added. The copied plugin's own references all resolve, so the unresolved
    # cases below fail for their one added line and nothing else.
    $r = New-AdrRefRepo 'adr-ref-control' @{}
    $g = Run-GateAt $r
    Record 'adr-ref-control-resolves' ($g.rc -eq 0 -and $g.out -match 'adr references: [1-9]\d* reference\(s\) in \d+ of \d+ tracked text file\(s\) resolve') "exit=$($g.rc) resolved-line=$([bool]($g.out -match 'adr references: \d+ reference'))"
    # The same control run carries the stack and git-boundary checks over the copied canon tree (ADR 0158).
    Record 'stack-control-passes' ($g.rc -eq 0 -and $g.out -match 'PASS  zero-install stack: [1-9]\d* python import\(s\) in \d+ file\(s\) and [1-9]\d* js specifier' -and $g.out -match 'PASS  git boundary: [1-9]\d* direct git call\(s\) in listed \.py files, each marked') "exit=$($g.rc)"

    $r = New-AdrRefRepo 'adr-ref-unresolved' @{ 'scripts/note.md' = "see ADR $badNum for why`n" }
    $g = Run-GateAt $r
    Record 'adr-ref-unresolved' ($g.rc -eq 1 -and $g.out -match "scripts/note\.md:1 cites ADR $badNum") "exit=$($g.rc) named=$([bool]($g.out -match "cites ADR $badNum"))"

    # A list member is checked on its own: the first number resolves, the second does not.
    $r = New-AdrRefRepo 'adr-ref-list-member' @{ 'scripts/list.md' = "a line`nper ADRs 0001/$badNum and more`n" }
    $g = Run-GateAt $r
    Record 'adr-ref-list-member' ($g.rc -eq 1 -and $g.out -match "scripts/list\.md:2 cites ADR $badNum" -and $g.out -notmatch 'cites ADR 0001') "exit=$($g.rc)"

    # An ASCII-hyphen range is a list too (`ADRs 0010-0017` is how the retro ignore file writes one).
    $r = New-AdrRefRepo 'adr-ref-hyphen-range' @{ 'scripts/range.md' = "ADRs 0001-$badNum`n" }
    $g = Run-GateAt $r
    Record 'adr-ref-hyphen-range' ($g.rc -eq 1 -and $g.out -match "scripts/range\.md:1 cites ADR $badNum") "exit=$($g.rc)"

    # The older hash form resolves zero-padded: `ADR #3` names 0003 (this canon's early specs), a
    # hash number with no record fails like any other.
    $hashRef = 'ADR #' + [string][int]$badNum
    $r = New-AdrRefRepo 'adr-ref-hash-form' @{ 'scripts/hash.md' = "ok ADR #3`nbad $hashRef here`n" }
    $g = Run-GateAt $r
    Record 'adr-ref-hash-form' ($g.rc -eq 1 -and $g.out -match "scripts/hash\.md:2 cites ADR $badNum" -and $g.out -notmatch 'hash\.md:1 ') "exit=$($g.rc)"

    # History and generated surfaces are excluded: an ADR body (append-only), the handoff archive,
    # and the generated index. The same line elsewhere fails (adr-ref-unresolved).
    $r = New-AdrRefRepo 'adr-ref-excluded' @{
        'docs/adr/0001-fixture-history.md' = "cites ADR $badNum`n"
        'docs/handoff-archive/SESSION_HANDOFF.md' = "cites ADR $badNum`n"
        'docs/INDEX.md' = "cites ADR $badNum`n"
    }
    $g = Run-GateAt $r
    Record 'adr-ref-excluded-history-and-generated' ($g.rc -eq 0 -and $g.out -notmatch "cites ADR $badNum" -and $g.out -match 'adr references: \d+ reference') "exit=$($g.rc)"

    # An UNTRACKED file is not read — the reason the check lists with git instead of walking the tree
    # (gitignored eval results and local settings would fail one machine only).
    $r = New-AdrRefRepo 'adr-ref-untracked' @{} @{ 'scripts/local-only.md' = "cites ADR $badNum`n" }
    $g = Run-GateAt $r
    Record 'adr-ref-untracked-not-read' ($g.rc -eq 0 -and $g.out -notmatch "cites ADR $badNum") "exit=$($g.rc)"

    # Outside a git work tree the check is a REPORTED skip, never a pass line.
    $r = New-CanonShape 'adr-ref-not-git'
    New-Item -ItemType Directory -Force -Path (Join-Path $r 'docs/adr') | Out-Null
    $g = Run-GateAt $r
    Record 'adr-ref-skip-not-git' ($g.rc -eq 0 -and $g.out -match 'adr references: skipped — the canon shape is not inside a git work tree' -and $g.out -notmatch 'adr references: \d+ reference') "exit=$($g.rc)"
    Record 'stack-skip-not-git' ($g.out -match 'stack and git boundary: skipped — the canon shape is not inside a git work tree' -and $g.out -notmatch 'zero-install stack: \d+') "exit=$($g.rc)"

    # --- canon zero-install stack and git boundary (REVIEW.md invariants 1 and 9, ADR 0158) ----------
    # The same git fixture. The adr-ref control run above passed both checks; each batch below adds
    # files that the check must name line by line, beside lines it must leave alone, so one gate run
    # proves every branch of its batch. The fixture text is assembled here: this suite is a .ps1
    # file, which neither check reads.
    $lf = { param([string[]]$l) ($l -join "`n") + "`n" }
    $tq = '"' * 3
    $stackFiles = @{
        'scripts/s1.py'      = & $lf @('from __future__ import annotations', 'import os, json as j', 'import localmod', 'from yaml import safe_load', 'import requests.adapters',
            'import os; import yamlsemi', 'try: import tryimp')
        'scripts/localmod.py' = "x = 1`n"
        'tools/deep/yaml.py' = "x = 1`n"
        'scripts/s2.py'      = & $lf @("${tq}Doc.", 'import notreal', $tq, "x = ${tq}one line${tq}", '# import alsonotreal', 'import tomllib',
            "# a comment that holds $tq", 'import afterhash', "SEP = '$tq'", 'import aftersep', "${tq}See ## heading.${tq}", 'import afterdoc',
            "x = 1  # a trailing comment that holds $tq", 'import aftertrail')
        'scripts/s7.py'      = & $lf @('x = 1', "${tq}never closed", 'import hidden')
        'scripts/s3.mjs'     = & $lf @("import fs from 'node:fs'", "import { a } from './s4.mjs'", "import x from 'lodash'", "// import y from 'leftpad'", "const p = require('path')", "const q = await import('chalk')", 'import {', '  b,', "} from 'dayjs'")
        'scripts/s4.mjs'     = & $lf @("export { c } from 'node:path'", "import t from 'claude-code/testing'")
        'hooks/s5.test.ts'   = & $lf @("import { test } from 'claude-code/testing'")
        'tools/package.json' = "{}`n"
    }
    $r = New-AdrRefRepo 'stack-batch' $stackFiles @{ 'scripts/s6.py' = & $lf @('import untrackedpkg') }
    $g = Run-GateAt $r
    $want = @(
        "scripts/s1\.py:4 imports 'yaml'", "scripts/s1\.py:5 imports 'requests\.adapters'",
        "scripts/s1\.py:6 imports 'yamlsemi'", "scripts/s1\.py:7 imports 'tryimp'",
        "scripts/s2\.py:6 imports 'tomllib'", "scripts/s2\.py:8 imports 'afterhash'", "scripts/s2\.py:10 imports 'aftersep'", "scripts/s2\.py:12 imports 'afterdoc'",
        "scripts/s2\.py:14 imports 'aftertrail'",
        'scripts/s7\.py:2 opens a triple-quoted string that never closes . lines 3-3 NOT CHECKED',
        "scripts/s3\.mjs:3 imports 'lodash'", "scripts/s3\.mjs:6 imports 'chalk'", "scripts/s3\.mjs:9 imports 'dayjs'",
        "scripts/s4\.mjs:2 imports 'claude-code/testing'",
        'zero-install stack: tools/package\.json is a dependency manifest',
        "scripts/s6\.py:1 \(untracked\) imports 'untrackedpkg'")
    # s1:3 imports a sibling module, which reaches; a yaml.py far away does not whitelist yaml (s1:4).
    $spare = @('s1\.py:[123] ', 's2\.py:([2-579]|11|13) ', 's3\.mjs:[1245] ', 's4\.mjs:1 ', 's5\.test\.ts', 's7\.py:3 ', 'scripts/s1\.py:[0-9]+ \(untracked\)', 'PASS  zero-install stack')
    $missing = @($want | Where-Object { $g.out -notmatch $_ })
    $wrong = @($spare | Where-Object { $g.out -match $_ })
    Record 'stack-batch-names-each-violation' ($g.rc -eq 1 -and $missing.Count -eq 0 -and $wrong.Count -eq 0) "exit=$($g.rc) missing=[$($missing -join ' | ')] wrongly-named=[$($wrong -join ' | ')]"

    $gitFiles = @{
        'scripts/g1.py' = & $lf @('import subprocess', 'subprocess.run(["git", "status"])', 'subprocess.run(["git", "log"])  # harness:git-boundary a test reason',
            '# harness:git-boundary the line below', 'subprocess.run(["git", "diff"])', 'subprocess.run(["git", "show"])  # harness:git-boundary',
            'subprocess.check_output("git rev-parse HEAD", shell=True)', 'subprocess.run(["gitk"])', 'x = ["git"]',
            'subprocess.run(("git", "diff"), text=True)', 'print("git")',
            'subprocess.run(', '    ("git", "log"),', ')', 'def h():', '    return ("git", "status")')
    }
    $r = New-AdrRefRepo 'git-batch' $gitFiles
    $g = Run-GateAt $r
    $want = @('git boundary: scripts/g1\.py:2 starts git directly', 'git boundary: scripts/g1\.py:6 carries harness:git-boundary with no reason',
        'git boundary: scripts/g1\.py:7 starts git directly', 'git boundary: scripts/g1\.py:9 starts git directly',
        'git boundary: scripts/g1\.py:10 starts git directly', 'git boundary: scripts/g1\.py:13 starts git directly',
        'git boundary: scripts/g1\.py:16 starts git directly')
    $spare = @('g1\.py:([1358]|11|12|14|15) ', 'PASS  git boundary')
    $missing = @($want | Where-Object { $g.out -notmatch $_ })
    $wrong = @($spare | Where-Object { $g.out -match $_ })
    Record 'git-boundary-batch-names-each-site' ($g.rc -eq 1 -and $missing.Count -eq 0 -and $wrong.Count -eq 0) "exit=$($g.rc) missing=[$($missing -join ' | ')] wrongly-named=[$($wrong -join ' | ')]"
}

# --- eval suite structure (ADR 0076 / spec 0014) -------------------------------------------------
# Four refusals the runner would otherwise deliver only after a PAID run (unknown prompt.md key ·
# unknown grader type · grader-less case) or never (an unpinned or non-worker model — the host has
# no such rule). Each mutation edits ONE case of the shipped suite; the control below proves the
# unmutated suite passes the same section.
$evalCase = Join-Path $src 'evals/hook-version-announce-reaches-context'
if (-not (Test-Path -LiteralPath (Join-Path $evalCase 'prompt.md') -PathType Leaf)) {
    Write-Host 'FAIL [eval-suite] fixture case evals/hook-version-announce-reaches-context/prompt.md missing — the eval mutations have nothing to mutate' -ForegroundColor Red
    $results += [pscustomobject]@{ case = 'eval-suite-fixture-missing'; exit = 0 }
} else {
    Try-Case 'eval-unknown-prompt-key' {
        param($d)
        $p = Join-Path $d 'evals/hook-version-announce-reaches-context/prompt.md'
        (Get-Content -LiteralPath $p -Raw) -replace '(?m)^model:', "max_turn: 5`nmodel:" | Set-Content -LiteralPath $p -NoNewline
    }
    # A key the parser cannot read (dashed) must be refused as UNPARSED, not silently skipped past
    # the unknown-key loop — the review's high finding: the first cut printed PASS over it while
    # the runner still rejects the file (a validator that only sees what it parsed).
    Try-Case 'eval-unparsed-frontmatter-line' {
        param($d)
        $p = Join-Path $d 'evals/hook-version-announce-reaches-context/prompt.md'
        (Get-Content -LiteralPath $p -Raw) -replace '(?m)^model:', "max-turns: 5`nmodel:" | Set-Content -LiteralPath $p -NoNewline
    }
    # haiku IS a worker model, so only the one-suite-one-model rule can catch this — the mutation
    # proves that branch and nothing else.
    Try-Case 'eval-model-mixed-across-cases' {
        param($d)
        $p = Join-Path $d 'evals/hook-version-announce-reaches-context/prompt.md'
        (Get-Content -LiteralPath $p -Raw) -replace '(?m)^model:.*$', 'model: haiku' | Set-Content -LiteralPath $p -NoNewline
    }
    Try-Case 'eval-model-unpinned' {
        param($d)
        $p = Join-Path $d 'evals/hook-version-announce-reaches-context/prompt.md'
        (Get-Content -LiteralPath $p -Raw) -replace '(?m)^model:.*\r?\n', '' | Set-Content -LiteralPath $p -NoNewline
    }
    # ADR 0107: a bare worker alias only. EVERY case is mutated, because a one-case change would also
    # trip the mixed-models rule and prove nothing about the alias check.
    foreach ($bad in @(
            @{ tag = 'eval-model-not-a-worker'; model = 'fable' },
            @{ tag = 'eval-model-full-id'; model = 'claude-opus-5-5' },
            @{ tag = 'eval-model-suffixed-alias'; model = 'opus[1m]' },
            @{ tag = 'eval-model-alias-wrong-case'; model = 'Opus' })) {
        $m = $bad.model
        Try-Case $bad.tag {
            param($d)
            foreach ($p in Get-ChildItem -LiteralPath (Join-Path $d 'evals') -Recurse -Filter 'prompt.md') {
                (Get-Content -LiteralPath $p.FullName -Raw) -replace '(?m)^model:.*$', "model: $m" | Set-Content -LiteralPath $p.FullName -NoNewline
            }
        }.GetNewClosure()
    }
    Try-Case 'eval-unknown-grader-type' {
        param($d)
        $p = Join-Path $d 'evals/hook-version-announce-reaches-context/graders/says-first-recorded-run.md'
        (Get-Content -LiteralPath $p -Raw) -replace '(?m)^type:.*$', 'type: custom_script' | Set-Content -LiteralPath $p -NoNewline
    }
    Try-Case 'eval-case-without-graders' {
        param($d)
        Remove-Item -LiteralPath (Join-Path $d 'evals/hook-version-announce-reaches-context/graders') -Recurse -Force
    }
    # The disabled-skills guard's scope (spec 0014 §4.2): unscoped (the run #9 shape), a disabled
    # skill the pattern does not name, and a pattern wide enough to match a model-invocable skill.
    $guard = 'evals/disabled-skills-stay-user-invoked/graders/no-skill-invoked.md'
    Try-Case 'eval-guard-unscoped' {
        param($d)
        $p = Join-Path $d $guard
        (Get-Content -LiteralPath $p -Raw) -replace '(?m)^input_match:.*\r?\n', '' | Set-Content -LiteralPath $p -NoNewline
    }
    Try-Case 'eval-guard-misses-a-disabled-skill' {
        param($d)
        $p = Join-Path $d 'skills/verify/SKILL.md'
        (Get-Content -LiteralPath $p -Raw) -replace '(?m)^name:', "disable-model-invocation: true`nname:" | Set-Content -LiteralPath $p -NoNewline
    }
    Try-Case 'eval-guard-matches-an-invocable-skill' {
        param($d)
        $p = Join-Path $d $guard
        (Get-Content -LiteralPath $p -Raw) -replace '(?m)^input_match:.*$', "input_match: '`"skill`"'" | Set-Content -LiteralPath $p -NoNewline
    }
    Try-Case 'eval-guard-pattern-does-not-compile' {
        param($d)
        $p = Join-Path $d $guard
        (Get-Content -LiteralPath $p -Raw) -replace '(?m)^input_match:.*$', "input_match: '(`"skill`"'" | Set-Content -LiteralPath $p -NoNewline
    }
    Try-Case 'eval-guard-pattern-engine-specific' {
        param($d)
        $p = Join-Path $d $guard
        (Get-Content -LiteralPath $p -Raw) -replace "(?m)^input_match: '", "input_match: '(?i)" | Set-Content -LiteralPath $p -NoNewline
    }
    Try-Case 'eval-guard-flag-unreadable' {
        param($d)
        $p = Join-Path $d 'skills/update/SKILL.md'
        (Get-Content -LiteralPath $p -Raw) -replace '(?m)^disable-model-invocation:.*$', 'disable-model-invocation: yes' | Set-Content -LiteralPath $p -NoNewline
    }
}

# A POSITIVE control: the unmutated copy must still pass. Without it a gate that fails on
# everything (a broken gate) would score a perfect negative suite. The copy sits with no repo
# above it, so the placement sweep must also SAY it skipped (never a silent no-op). The eval
# section must SAY it ran over the shipped suite (a PASS line with a case count): a section that
# silently did nothing would let every eval mutation above be caught by some other check and
# still read as covered.
# It runs on the RESET working tree, so it also proves a reset tree is one the gate passes (the
# reset assertion proves the bytes; this proves the verdict).
$ok = Reset-Fixture $pluginFx
$gc = Invoke-Gate (Join-Path $ok 'manifest-gate.mjs')
$ctlOut = $gc.Out
$ctl = $gc.Code
if ($ctl -eq 0 -and $ctlOut -match 'dogfood placements: skipped' -and $ctlOut -match 'release lockstep: skipped — not the canon dogfood shape' -and $ctlOut -match 'PASS  eval suite: [1-9]\d* case\(s\).*disabled-skills guard scoped to [1-9]\d* skill\(s\)') { Write-Host 'PASS [unmutated-control] gate exited 0, placement sweep and release lockstep both reported their skip, eval suite checked with a case count and the guard scope' -ForegroundColor Green }
else { Write-Host "FAIL [unmutated-control] exit=$ctl skip-said=$([bool]($ctlOut -match 'dogfood placements: skipped')) lockstep-skip-said=$([bool]($ctlOut -match 'release lockstep: skipped')) eval-suite-counted=$([bool]($ctlOut -match 'PASS  eval suite: [1-9]\d* case\(s\)')) guard-scope-said=$([bool]($ctlOut -match 'disabled-skills guard scoped to [1-9]'))" -ForegroundColor Red; $ctl = 1 }

# --- the contracts Invoke-Gate rests on (review 2026-09-02: a negative suite must never score an
# --- abort as a catch; ADR 0141 Decision 3 carried it to the Node gate) -----------------------------
# The gate sets process.exitCode and returns, so stdout drains and its summary line is the last line;
# a process.exit() could cut the output short of it. Pin that it never calls one.
$procExit = @(Select-String -LiteralPath (Join-Path $src 'manifest-gate.mjs') -Pattern 'process\.exit\s*\(' | Where-Object { $_.Line -notmatch '^\s*//' })
Record 'node-gate-never-calls-process-exit' ($procExit.Count -eq 0) "the summary line must be the last; offending lines: $(($procExit | ForEach-Object { $_.LineNumber }) -join ', ')"
# Node exits 1 on its own for a thrown error and for a syntax error — the code every mutation case
# accepts. Neither prints the summary line, so both must come back -1/Aborted.
$thrower = Join-Path $base 'thrower.mjs'
Set-Content -LiteralPath $thrower -Value "throw new Error('boom from the fixture')" -NoNewline
$gt = Invoke-Gate $thrower
Record 'node-uncaught-throw-is-an-abort-not-exit-1' ($gt.Code -eq -1 -and $gt.Aborted -and $gt.Out -match 'exit 1 without' -and $gt.Out -match 'boom from the fixture') "code=$($gt.Code) aborted=$($gt.Aborted) message-kept=$([bool]($gt.Out -match 'boom from the fixture'))"
$syntax = Join-Path $base 'syntax.mjs'
Set-Content -LiteralPath $syntax -Value "this is not ( javascript" -NoNewline
$gs = Invoke-Gate $syntax
Record 'node-syntax-error-is-an-abort-not-exit-1' ($gs.Code -eq -1 -and $gs.Aborted -and $gs.Out -match 'SyntaxError') "code=$($gs.Code) aborted=$($gs.Aborted)"
# A FAIL line and exit 1 without the summary is not a catch either, and exit 0 without the green
# summary is not a pass: only the gate's own ending counts.
$failOnly = Join-Path $base 'fail-only.mjs'
Set-Content -LiteralPath $failOnly -Value "console.log('FAIL  looks like a gate line'); process.exitCode = 1" -NoNewline
$gf = Invoke-Gate $failOnly
Record 'node-exit-1-without-the-summary-is-an-abort' ($gf.Code -eq -1 -and $gf.Aborted) "code=$($gf.Code) aborted=$($gf.Aborted)"
$silent = Join-Path $base 'silent.mjs'
Set-Content -LiteralPath $silent -Value "console.log('PASS  looks like a gate line')" -NoNewline
$g0 = Invoke-Gate $silent
Record 'node-exit-0-without-the-summary-is-an-abort' ($g0.Code -eq -1 -and $g0.Aborted) "code=$($g0.Code) aborted=$($g0.Aborted)"
# A gate file that is not there (a copy race would have read as "PASS gate exited 1" under an adapter
# that mapped every error to 1 — the 2026-09-02 review's medium finding).
$gm = Invoke-Gate (Join-Path $base 'no-such-dir/manifest-gate.mjs')
Record 'node-missing-gate-is-an-abort-not-exit-1' ($gm.Code -eq -1 -and $gm.Aborted -and $gm.Out -match 'script not found') "code=$($gm.Code) aborted=$($gm.Aborted)"
# The REAL gate's own catch: with hooks/hook-lib.mjs gone its import throws inside the try, and the gate
# must say ABORTED and exit 2, never the 1 of a caught mutation.
$dir = Reset-Fixture $pluginFx
Remove-Item -LiteralPath (Join-Path $dir 'hooks/hook-lib.mjs') -Force
$gi = Invoke-Gate (Join-Path $dir 'manifest-gate.mjs')
Record 'node-gate-own-throw-exits-2-not-1' ($gi.Code -eq -1 -and $gi.Aborted -and $gi.Out -match '^exit 2 without' -and $gi.Out -match 'manifest-gate: ABORTED') "code=$($gi.Code) aborted=$($gi.Aborted) head=$(($gi.Out -split "`n")[0])"

Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue

$missed = @($results | Where-Object { $_.exit -ne 1 })
Write-Host ''
Write-Host "mutations=$($results.Count) caught=$($results.Count - $missed.Count) missed=$($missed.Count) control=$ctl"
if ($missed.Count -or $ctl -ne 0) {
    Write-Host 'manifest-gate.selftest: FAILED' -ForegroundColor Red
    exit 1
}
Write-Host 'manifest-gate selftest: all mutations caught, control green' -ForegroundColor Green
exit 0
