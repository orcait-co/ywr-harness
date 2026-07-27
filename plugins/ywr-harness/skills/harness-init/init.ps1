# Scaffold the docs-as-code shape into a repo. Deterministic placement, no model judgment —
# that is why this is a script and not prose in SKILL.md: a scaffold that cannot be tested is a
# scaffold nobody can trust to re-run.
#
# Re-runnable by design, with a hard split that is the whole point of the file:
#
#   TOOLCHAIN — overwritten on every run. The builder and the rule/template documents are the
#               canon's copies; re-running is how a plugin-side improvement reaches this repo.
#               A consuming repo must not hand-edit these (ywr-harness ADR 0010): edit them here
#               and they are silently reverted on the next run, which is the intended signal.
#   SEED      — created once, NEVER overwritten. A repo's CLAUDE.md and .gitattributes carry
#               decisions this script cannot know. Clobbering them would destroy work, so an
#               existing file is reported as preserved and left byte-identical.
#
# Nothing is ever deleted. There is no path through this script that removes a file.
#
# Exit 0 = placement completed (with or without preserved seeds). Exit 1 = target unusable, a
# template is missing from the plugin, or a write failed.

[CmdletBinding()]
param(
    # Repo root to scaffold. Defaults to the current directory.
    [string]$Target = '.',
    # Report what would change and write nothing.
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# pwsh 7.4+ turns a non-zero NATIVE exit code into a terminating error while ErrorActionPreference
# is 'Stop'. Every native call below reads $LASTEXITCODE deliberately — `git config --get` exits 1
# for "key not set", which is the normal case in the wiring block, and the docs build reports its
# own exit code rather than throwing. Pinned off so the branches stay reachable.
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$templates = Join-Path $PSScriptRoot 'templates'
if (-not (Test-Path -LiteralPath $templates)) {
    Write-Host "FAIL — templates/ not found next to init.ps1 (looked in $templates)" -ForegroundColor Red
    exit 1
}

try { $root = (Resolve-Path -LiteralPath $Target -ErrorAction Stop).Path }
catch { Write-Host "FAIL — target not found: $Target" -ForegroundColor Red; exit 1 }
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    Write-Host "FAIL — target is not a directory: $root" -ForegroundColor Red
    exit 1
}

# relative source under templates/  ->  relative destination under the target
$TOOLCHAIN = [ordered]@{
    'docs/README.md'             = 'docs/README.md'
    'docs/adr/README.md'         = 'docs/adr/README.md'
    'docs/adr/0000-template.md'  = 'docs/adr/0000-template.md'
    'docs/spec/README.md'        = 'docs/spec/README.md'
    'docs/spec/0000-template.md' = 'docs/spec/0000-template.md'
    'docs/build.ps1'             = 'docs/build.ps1'
    'docs/build.sh'              = 'docs/build.sh'
    'docs/build_docs.py'         = 'docs/build_docs.py'
    # Vendored so CI needs no access to the canon repo. `${CLAUDE_PLUGIN_ROOT}` is substituted when
    # Claude Code spawns a hook and does not exist in a CI step, and the canon is private with
    # cross-repo Actions access closed — a reusable workflow would require widening that. Byte
    # identity with the plugin's own copies is enforced by manifest-gate.ps1 (ADR 0014).
    'scripts/harness/harness_config.py'      = 'scripts/harness/harness_config.py'
    'scripts/harness/harness_gates.py'       = 'scripts/harness/harness_gates.py'
    'scripts/harness/harness_retro.py'       = 'scripts/harness/harness_retro.py'
    'scripts/harness/verify_map.py'          = 'scripts/harness/verify_map.py'
    '.github/workflows/harness-gates.yml'    = '.github/workflows/harness-gates.yml'
    'scripts/harness/gitignore'              = 'scripts/harness/.gitignore'
    # The local execution layer (ADR 0015). TOOLCHAIN, not SEED: a hook a repo may edit freely is a
    # hook that stops being the same gate everywhere, which is the divergence ADR 0010 forbids.
    'githooks/pre-commit'                    = '.githooks/pre-commit'
    'githooks/pre-push'                      = '.githooks/pre-push'
}
# GUARDED — the third mode, and it exists for exactly one file. `post-commit` is a filename repos
# commonly already use (this canon's own repo uses it to republish the docs artifact), so blind
# TOOLCHAIN overwrite would destroy working automation. But making it a SEED means a repo that
# already has one never receives the retro at all, silently.
#
# So: place when absent, REFRESH when the existing file carries our marker, REFUSE and report
# otherwise. Same rule as ADR 0015's `core.hooksPath`, applied to a file instead of a config key.
$GUARD_MARKER = 'ywr-harness:post-commit'
$GUARDED = [ordered]@{
    'githooks/post-commit' = '.githooks/post-commit'
}
$SEED = [ordered]@{
    'CLAUDE.md'     = 'CLAUDE.md'
    'gitattributes' = '.gitattributes'
    # The UNMAPPED exemption list, which doubles as the repo's visible spec-debt register. A SEED
    # for the same reason .harness.json is one: its whole content is decisions only this repo has.
    'githooks/slice-retro-ignore' = '.githooks/slice-retro-ignore'
    # The declaration the plugin's scripts read for this repo's paths and runner. A SEED, not
    # TOOLCHAIN: its whole purpose is to hold values only this repo knows, so overwriting it on a
    # re-run would erase exactly the configuration it exists to carry.
    'harness.json'  = '.harness.json'
}
# Placed ONLY when docs/adr/ holds no record yet. Two reasons, both load-bearing:
#   1. The builder refuses an empty corpus ("found no .md with frontmatter") — correct behavior,
#      but it means a scaffold that places only templates produces a repo that cannot build, so
#      no tooling can query its decisions. Measured on the first end-to-end run.
#   2. Unconditional placement would collide: a repo that already has its own 0001 would end up
#      with two records claiming id 0001.
# So: seed the corpus when it is empty, and stay out of the way when it is not.
$SEED_CORPUS = [ordered]@{
    'docs/adr/0001-adopt-docs-as-code.md' = 'docs/adr/0001-adopt-docs-as-code.md'
}

$created = @(); $refreshed = @(); $preserved = @(); $failed = @(); $skippedSeed = @(); $refused = @()

function Place([string]$Rel, [string]$Dest, [bool]$Overwrite) {
    $src = Join-Path $templates $Rel
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
        $script:failed += "template missing in plugin: $Rel"
        return
    }
    $dst = Join-Path $root $Dest
    $exists = Test-Path -LiteralPath $dst -PathType Leaf

    if ($exists -and -not $Overwrite) { $script:preserved += $Dest; return }

    if ($exists) {
        # Identical content is not a refresh — saying "refreshed" for a no-op inflates the report
        # and hides which files the canon actually changed.
        $a = [IO.File]::ReadAllBytes($src); $b = [IO.File]::ReadAllBytes($dst)
        if ($a.Length -eq $b.Length -and -not (Compare-Object $a $b)) { return }
    }

    if ($DryRun) {
        if ($exists) { $script:refreshed += $Dest } else { $script:created += $Dest }
        return
    }
    try {
        $parent = Split-Path -Parent $dst
        if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Copy-Item -LiteralPath $src -Destination $dst -Force
        if ($exists) { $script:refreshed += $Dest } else { $script:created += $Dest }
    } catch { $script:failed += "$Dest — $($_.Exception.Message)" }
}

function Place-Guarded([string]$Rel, [string]$Dest) {
    $src = Join-Path $templates $Rel
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
        $script:failed += "template missing in plugin: $Rel"
        return
    }
    $dst = Join-Path $root $Dest
    if (Test-Path -LiteralPath $dst -PathType Leaf) {
        $body = Get-Content -LiteralPath $dst -Raw -ErrorAction SilentlyContinue
        if ($body -notmatch [regex]::Escape($GUARD_MARKER)) {
            # Not ours. Refusing is the only safe reading: the file may be doing real work whose
            # reasons this scaffold cannot see.
            $script:refused += $Dest
            return
        }
    }
    Place $Rel $Dest $true
}

$considered = 0
foreach ($k in $TOOLCHAIN.Keys) { Place $k $TOOLCHAIN[$k] $true; $considered++ }
foreach ($k in $GUARDED.Keys) { Place-Guarded $k $GUARDED[$k]; $considered++ }
foreach ($k in $SEED.Keys) { Place $k $SEED[$k] $false; $considered++ }

# `0000-template.md` is not a record — its frontmatter sits behind an HTML comment so the builder
# does not index it. That is why a templates-only corpus still counts as empty here.
$adrDir = Join-Path $root 'docs/adr'
$existingRecords = @()
if (Test-Path -LiteralPath $adrDir -PathType Container) {
    $existingRecords = @(Get-ChildItem -LiteralPath $adrDir -File -Filter '*.md' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d{4}-' -and $_.Name -ne '0000-template.md' })
}
if ($existingRecords.Count -eq 0) {
    foreach ($k in $SEED_CORPUS.Keys) { Place $k $SEED_CORPUS[$k] $false; $considered++ }
} else {
    $skippedSeed += "corpus seed not placed — docs/adr/ already holds $($existingRecords.Count) record(s)"
}

$mode = if ($DryRun) { ' (dry run — nothing written)' } else { '' }
Write-Host "harness-init -> $root$mode"
Write-Host "  created=$($created.Count) refreshed=$($refreshed.Count) preserved=$($preserved.Count) refused=$($refused.Count) unchanged=$($considered - $created.Count - $refreshed.Count - $preserved.Count - $refused.Count)"
foreach ($f in $created) { Write-Host "  + $f" -ForegroundColor Green }
foreach ($f in $refreshed) { Write-Host "  ~ $f (toolchain refreshed from canon)" -ForegroundColor Cyan }
foreach ($f in $preserved) { Write-Host "  = $f (existing seed preserved — not overwritten)" -ForegroundColor Yellow }
foreach ($f in $refused) {
    Write-Host "  ! $f REFUSED — an existing file without the '$GUARD_MARKER' marker" -ForegroundColor Yellow
    Write-Host "      It is doing something this scaffold did not write, so it was left alone." -ForegroundColor Yellow
    Write-Host "      To get the retro too, add this line to it (the retro never blocks a commit):" -ForegroundColor Yellow
    Write-Host '        [ "$SLICE_RETRO" = "0" ] || python scripts/harness/harness_retro.py || true' -ForegroundColor Yellow
}
foreach ($f in $skippedSeed) { Write-Host "  - $f" -ForegroundColor Yellow }

if ($failed.Count) {
    foreach ($f in $failed) { Write-Host "  FAIL $f" -ForegroundColor Red }
    exit 1
}

# --- git hooks: executable bit, then CONDITIONAL wiring (ADR 0015) ------------------------------
# This is the only thing init.ps1 does that is not a file write, so it is bounded hard:
#   unset       -> set it
#   .githooks   -> leave it
#   anything else -> REFUSE and report the existing value
# `core.hooksPath` lives in .git/config, which is per-clone and never committed, so this wires the
# machine that ran the scaffold and nothing else. The clone that never ran it is caught by the
# `hooks:` line harness_gates.py prints — that report, not this block, is what closes the gap.
$HOOKS_DIR = '.githooks'
$hookFiles = @('.githooks/pre-commit', '.githooks/pre-push', '.githooks/post-commit')

if (-not $DryRun -and -not $IsWindows) {
    # Copy-Item does not carry the executable bit, and git will not run a non-executable hook on a
    # POSIX checkout. No-op on Windows, where git invokes hooks through sh regardless of the bit.
    if (Get-Command chmod -ErrorAction SilentlyContinue) {
        foreach ($h in $hookFiles) {
            $hp = Join-Path $root $h
            if (Test-Path -LiteralPath $hp -PathType Leaf) { & chmod +x $hp 2>$null | Out-Null }
        }
    }
}

function Compare-RepoPath([string]$A, [string]$B) {
    try {
        $x = [IO.Path]::GetFullPath($A).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
        $y = [IO.Path]::GetFullPath($B).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    } catch { return $false }
    $cmp = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    return $x.Equals($y, $cmp)
}

$wire = ''
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    $wire = 'git not on PATH — core.hooksPath NOT set; the hooks are placed but will not run'
} else {
    $top = & git -C $root rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$top)) {
        $wire = 'not a git repository — core.hooksPath NOT set; the hooks are placed but will not run'
    } elseif (-not (Compare-RepoPath $root ([string]$top).Trim())) {
        # Setting hooksPath from a subdirectory would reconfigure the WHOLE repository from a scaffold
        # run that was scoped to one subtree. Refused, and the real root is named so the reader can
        # re-run there if that is what they meant.
        $wire = "target is not the repository root ($(([string]$top).Trim())) — core.hooksPath NOT set, because setting it here would reconfigure the entire repository"
    } else {
        $cur = & git -C $root config --local --get core.hooksPath 2>$null
        if ($LASTEXITCODE -ne 0) { $cur = '' }
        $cur = ([string]$cur).Trim()
        if ($cur -eq $HOOKS_DIR) {
            $wire = "core.hooksPath already '$HOOKS_DIR' — already wired"
        } elseif ($cur -ne '') {
            $wire = "core.hooksPath is '$cur' — REFUSED to change it; this repo points its hooks elsewhere deliberately. The placed hooks stay inert until you merge them into '$cur' or set the value yourself"
        } elseif ($DryRun) {
            $wire = "core.hooksPath unset — would set it to '$HOOKS_DIR'"
        } else {
            & git -C $root config --local core.hooksPath $HOOKS_DIR 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { $wire = "core.hooksPath set to '$HOOKS_DIR' — wired" }
            else { $wire = "git config failed (exit $LASTEXITCODE) — core.hooksPath NOT set; run: git config core.hooksPath $HOOKS_DIR" }
        }
    }
}
$wireColor = if ($wire -match 'wired$') { 'Green' } else { 'Yellow' }
Write-Host "  hooks: $wire" -ForegroundColor $wireColor

if (-not $DryRun) {
    # Generating the three surfaces needs python. Absent python is a REPORTED skip, never silent:
    # a repo with no index.json cannot be queried by tooling, and the reader must know why.
    # Invoke the WRAPPER, not build_docs.py directly: docs/build.ps1 owns the Python encoding pin.
    # The builder prints non-ASCII and Python on Windows encodes stdout with the console codepage,
    # so on a cp1252 console `print()` raises UnicodeEncodeError and the process exits 1 AFTER
    # index.json is written — a half-built corpus reported as a failure. Measured on GitHub's
    # windows-latest runner. Calling the builder from here as well would need a second copy of that
    # pin, and two copies of one rule is how they end up disagreeing.
    $py = @('python', 'python3', 'py') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
    $wrapper = Join-Path $root 'docs/build.ps1'
    if ($py -and (Test-Path -LiteralPath $wrapper)) {
        Push-Location $root
        try {
            & pwsh -NoProfile -ExecutionPolicy Bypass -File $wrapper *> $null
            if ($LASTEXITCODE -eq 0) { Write-Host '  built: index.json · INDEX.md · docs.html' -ForegroundColor Green }
            else { Write-Host "  SKIP build — docs/build.ps1 exited $LASTEXITCODE; run it directly and read the error" -ForegroundColor Yellow }
        } finally { Pop-Location }
    } else {
        Write-Host '  SKIP build — python not on PATH (reported, not silent); run: pwsh docs/build.ps1' -ForegroundColor Yellow
    }
}

if ($preserved.Count) {
    Write-Host ''
    Write-Host 'Preserved seeds were NOT updated. If you scaffolded this repo before, compare them' -ForegroundColor Yellow
    Write-Host 'against skills/harness-init/templates/ by hand — this script will never clobber them.' -ForegroundColor Yellow
}
exit 0
