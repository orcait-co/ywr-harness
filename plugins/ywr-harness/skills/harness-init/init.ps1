# pwsh 7 is a documented prerequisite (plugin README); under Windows PowerShell 5.1 this script
# used to die on a null-method error ([Text.Encoding]::Latin1 is .NET 5+) — the #Requires line
# turns the wrong-interpreter path into an explicit refusal 5.1 itself prints (issue #51).
#Requires -Version 7.0

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
# TOOLCHAIN overwrite applies to RE-runs only: on a FIRST run (no .harness-version stamp) an
# existing, differing file at a toolchain path is refused rather than replaced — it is not the
# canon's output, and overwriting it is data loss, not an update (ADR 0055). -Force replaces
# deliberately; the stamp is withheld while such refusals stand.
#
# Exit 0 = placement completed (with or without preserved seeds and refusals). Exit 1 = target
# unusable, a template is missing from the plugin, or a write failed.

[CmdletBinding()]
param(
    # Repo root to scaffold. Defaults to the current directory.
    [string]$Target = '.',
    # Report what would change and write nothing.
    [switch]$DryRun,
    # Proceed even when this repo's .harness-version stamp is NEWER than this plugin copy — the
    # deliberate-rollback path (ADR 0042). Without it, a blind downgrade is refused.
    [switch]$Force
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

# --- downgrade guard (ADR 0042) ------------------------------------------------------------------
# `.harness-version` records which plugin version last scaffolded this repo — written below on
# every successful non-dry run, GENERATED and never a template (a templated stamp would change
# every release and nag every repo, 0033's recorded reason for rejecting a stamp in the trigger
# role). When the repo's stamp is NEWER than this copy, another writer refreshed the repo with a
# newer plugin (the multi-writer everyday state), and proceeding would place older templates over
# their refresh. Refused BEFORE anything is written; -Force is the deliberate-rollback path. A
# missing or unparseable stamp proceeds: refusing on absence could never destroy newer work, but
# it would strand every pre-0042 repo.
$STAMP_FILE = '.harness-version'
$stampPath = Join-Path $root $STAMP_FILE
function ConvertTo-VersionOrNull([string]$s) {
    if (-not $s) { return $null }
    $t = $s.Trim() -replace '^v', ''
    # [version] needs >=2 dotted components; anything else is not a stamp this scaffold wrote.
    if ($t -notmatch '^\d+(\.\d+)+$') { return $null }
    # [version] pads unspecified components with -1, so '0.28' would compare BELOW '0.28.0' and
    # flip the downgrade verdict (review 2026-08-10, low). Normalize to four components before
    # casting — the same rule as the refresh nudge's direction probe, cross-referenced there;
    # more than four stays invalid.
    $parts = @($t -split '\.')
    if ($parts.Count -gt 4) { return $null }
    while ($parts.Count -lt 4) { $parts += '0' }
    try { return [version]($parts -join '.') } catch { return $null }
}
$ownVersionRaw = $null
try {
    $mfPath = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) '.claude-plugin/plugin.json'
    $mf = Get-Content -LiteralPath $mfPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($mf.version -is [string] -and $mf.version -match '\d') { $ownVersionRaw = ([string]$mf.version).Trim() }
} catch { $ownVersionRaw = $null }
$ownVersion = ConvertTo-VersionOrNull $ownVersionRaw
# First run = no stamp FILE, whatever its content (only this scaffold plausibly writes that
# name). On a first run an existing file at a TOOLCHAIN path is by definition not a canon
# artifact, so overwriting it is data loss, not an update — those collisions are refused below
# (ADR 0055). A present-but-garbage stamp still counts as "has run": refusing there could only
# protect files a previous run already placed.
$isFirstRun = -not (Test-Path -LiteralPath $stampPath -PathType Leaf)
$repoStamp = $null; $repoStampRaw = ''
if (Test-Path -LiteralPath $stampPath -PathType Leaf) {
    try {
        # BOUNDED read — never Get-Content: a stamp with no newline before EOF is read WHOLE as
        # "line 1", and a symlink at a device never returns (review 2026-08-10, medium — same
        # fix as the refresh nudge's probe). 64 bytes is generous for a version token.
        $fs = [IO.File]::OpenRead($stampPath)
        try { $buf = [byte[]]::new(64); $n = $fs.Read($buf, 0, 64) } finally { $fs.Dispose() }
        $off = if ($n -ge 3 -and $buf[0] -eq 0xEF -and $buf[1] -eq 0xBB -and $buf[2] -eq 0xBF) { 3 } else { 0 }
        $line = [System.Text.Encoding]::ASCII.GetString($buf, $off, $n - $off)
        $cut = $line.IndexOfAny(@([char]"`r", [char]"`n"))
        if ($cut -ge 0) { $line = $line.Substring(0, $cut) }
        $repoStampRaw = $line.Trim()
        $repoStamp = ConvertTo-VersionOrNull $repoStampRaw
    } catch { $repoStamp = $null; $repoStampRaw = '' }
}
if ($repoStamp -and $ownVersion -and $repoStamp -gt $ownVersion) {
    if ($Force) {
        Write-Host "DOWNGRADE FORCED — repo stamp v$repoStampRaw > this plugin v$ownVersionRaw; proceeding because -Force was given (ADR 0042)." -ForegroundColor Yellow
    } else {
        Write-Host "REFUSED — this repo's toolchain was last scaffolded by ywr-harness v$repoStampRaw, NEWER than this copy (v$ownVersionRaw)." -ForegroundColor Red
        Write-Host "  Placing these templates would DOWNGRADE files another writer refreshed (ADR 0042). Nothing was written." -ForegroundColor Red
        Write-Host "  Remedy: update the plugin first — /ywr-harness:update (or 'claude plugin update'), then restart or /reload-plugins." -ForegroundColor Red
        Write-Host "  A deliberate rollback re-runs with -Force." -ForegroundColor Red
        exit 1
    }
}

# --- same-version conflict signal (ADR 0067) ------------------------------------------------------
# stamp == this plugin's version means the canon cannot have changed a placed file since the last
# scaffold — a refresh-path delta on this run is a LOCAL hand edit (or a modified plugin copy),
# the #55 shape ADR 0010 wants surfaced upstream. Collected during placement, reported after it.
# First runs can never qualify (no stamp), so this never overlaps ADR 0055's collision buckets.
# When this script itself runs FROM the target tree (the canon dogfood, ADR 0018), templates newer
# than the stamp's release are the intended source->placement propagation, not a hand edit — the
# verdict is replaced by a visible one-line note, never silently dropped.
$sameVersionRun = [bool]($repoStamp -and $ownVersion -and $repoStamp -eq $ownVersion)
$inTreeRun = $false
try {
    $selfDir = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/')
    $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\', '/')
    $cmpMode = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $inTreeRun = $selfDir.Equals($rootFull, $cmpMode) -or
        $selfDir.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, $cmpMode) -or
        $selfDir.StartsWith($rootFull + [IO.Path]::AltDirectorySeparatorChar, $cmpMode)
} catch { $inTreeRun = $false }
$sameVersionDrift = @()
$revertDir = ''
$revertSaved = @()
$revertFailed = @()

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
    # CI 의 PR base 해석 단일 소스(ADR 0043) — 벤더링된 워크플로가 직접 sh 로 부른다.
    'scripts/harness/resolve-base.sh'        = 'scripts/harness/resolve-base.sh'
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
    # Root ignore (ADR 0053): makes the shipped claims true at placement — the html surfaces
    # stay out of the first commit, the telemetry ledger's "(gitignored)" header holds, and
    # CLAUDE.md's ".env is gitignored" line is true. What a repo ignores is its decision → SEED.
    'gitignore'     = '.gitignore'
    # Starter review canon (ADR 0054): the emitter's default review.canon points at the repo
    # root, and the first slice close hard-stops on NOT FOUND — house invariants are repo-owned
    # decisions, so the container+format is seeded once and the content is theirs.
    'REVIEW.md'     = 'REVIEW.md'
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
# ADR 0055's two buckets: first-run TOOLCHAIN collisions refused (differing content, no stamp,
# no -Force), and the -Force replacements — labeled truthfully, never as "refreshed".
$firstRunRefused = @(); $replaced = @()

function Place([string]$Rel, [string]$Dest, [bool]$Overwrite, [bool]$OwnershipKnown = $false) {
    $src = Join-Path $templates $Rel
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
        $script:failed += "template missing in plugin: $Rel"
        return
    }
    $dst = Join-Path $root $Dest
    $exists = Test-Path -LiteralPath $dst -PathType Leaf

    if ($exists -and -not $Overwrite) { $script:preserved += $Dest; return }

    # Placement owns the line discipline: whatever it writes is LF. The installed plugin is
    # materialized by the CONSUMER's git, where core.autocrlf stamps CRLF onto every template
    # (measured: the v0.23.0 cache carried 162 CRLF pairs in githooks/pre-commit) — copying those
    # bytes verbatim broke sh hooks on POSIX checkouts ("/bin/sh^M: bad interpreter") and showed
    # as spurious modifications in an eol=lf repo. Latin1 maps bytes 1:1 to chars (byte-faithful
    # both ways), so this is a byte transform, not a decode: the WRITE folds only CRLF -> LF
    # (a lone 0x0D is content and stays); everything else — encoding, BOM — is exact.
    $latin1 = [System.Text.Encoding]::Latin1
    $text = $latin1.GetString([IO.File]::ReadAllBytes($src)).Replace("`r`n", "`n")

    if ($exists) {
        # Identical content is not a refresh — saying "refreshed" for a no-op inflates the report
        # and hides which files the canon actually changed. The COMPARE is ADR 0033's fold
        # VERBATIM — drop every 0x0D, paired or not — so this surface and the refresh nudge can
        # never disagree on what counts as a change (review 2026-08-06, medium: a CRLF-pair fold
        # here counted a lone-CR delta as a refresh the nudge stays silent on). The seed
        # .gitattributes pins `*.ps1 eol=crlf`, so a CRLF checkout of a byte-identical template
        # is not a change — a raw compare would say "refreshed" on every run forever.
        $existing = $latin1.GetString([IO.File]::ReadAllBytes($dst)).Replace("`r", '')
        if ($existing -eq $text.Replace("`r", '')) { return }
    }

    # First-run TOOLCHAIN collision (ADR 0055): the file exists, its content DIFFERS (the
    # identical case returned above), and no stamp says this scaffold has run here — so it is
    # not the canon's output and overwriting it is data loss, not an update. Refused unless
    # -Force; a GUARDED caller that already proved ownership by marker passes $OwnershipKnown.
    # Applies under -DryRun too: the dry run must show the same refusals the real run makes.
    $isReplacement = $false
    if ($exists -and $Overwrite -and $script:isFirstRun -and -not $OwnershipKnown) {
        if ($Force) { $isReplacement = $true }
        else { $script:firstRunRefused += $Dest; return }
    }

    # Same-version drift (ADR 0067): reaching here with an existing overwrite-mode file on a
    # RE-run means the content differs from the template while the stamp already equals this
    # plugin's version — a local hand edit this overwrite is about to revert (first runs never
    # set $sameVersionRun, so $isReplacement can't reach here with it). Recorded for the
    # upstream: block; on a real run the local content is copied aside FIRST, so the revert
    # never destroys the only copy of an uncommitted patch. A failed copy is reported per file
    # and never blocks the refresh — a temp-dir hiccup must not break the update path.
    if ($exists -and $Overwrite -and $script:sameVersionRun) {
        $script:sameVersionDrift += $Dest
        # In-tree (dogfood) runs skip the copy: the "local" content is the canon's own tree,
        # nothing uncommitted is being lost, and a silent temp write per propagation run is waste.
        if (-not $DryRun -and -not $script:inTreeRun) {
            try {
                if (-not $script:revertDir) {
                    # $PID in the name: the timestamp alone is second-resolution, so two runs in
                    # the same second (a quick retry, or two same-leaf worktrees on one machine)
                    # would share the dir and -Force would silently overwrite each other's
                    # backups — the one thing this mechanism exists to keep (review 2026-08-31,
                    # medium).
                    $script:revertDir = Join-Path ([IO.Path]::GetTempPath()) `
                        ('ywr-harness-reverted/' + (Split-Path $root -Leaf) + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $PID)
                }
                $bak = Join-Path $script:revertDir $Dest
                $bakParent = Split-Path -Parent $bak
                if ($bakParent -and -not (Test-Path -LiteralPath $bakParent)) { New-Item -ItemType Directory -Force -Path $bakParent | Out-Null }
                Copy-Item -LiteralPath $dst -Destination $bak -Force
                # Success is tracked separately from $revertDir being set: the dir name is
                # assigned BEFORE the copy that can fail, so the report must key the
                # "pre-revert copies:" line on at least one LANDED copy, or an all-failed run
                # would name a dir that holds nothing (review 2026-08-31, medium).
                $script:revertSaved += $Dest
            } catch { $script:revertFailed += $Dest }
        }
    }

    if ($DryRun) {
        if ($isReplacement) { $script:replaced += $Dest }
        elseif ($exists) { $script:refreshed += $Dest } else { $script:created += $Dest }
        return
    }
    try {
        $parent = Split-Path -Parent $dst
        if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        [IO.File]::WriteAllBytes($dst, $latin1.GetBytes($text))
        if ($isReplacement) { $script:replaced += $Dest }
        elseif ($exists) { $script:refreshed += $Dest } else { $script:created += $Dest }
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
    # Ownership is settled here (absent, or the marker proved it ours), so the first-run
    # collision guard inside Place() must not re-judge it (ADR 0055).
    Place $Rel $Dest $true $true
}

$considered = 0
foreach ($k in $TOOLCHAIN.Keys) { Place $k $TOOLCHAIN[$k] $true; $considered++ }
foreach ($k in $GUARDED.Keys) { Place-Guarded $k $GUARDED[$k]; $considered++ }
foreach ($k in $SEED.Keys) { Place $k $SEED[$k] $false; $considered++ }

# "Empty" means NO existing decision records, whatever they are named and wherever they live.
# The first shipped version matched only `^\d{4}-` names inside docs/adr/ — so a repo whose log
# used another convention (ADR-001-*, 001-*, dated names) or another conventional home (doc/adr,
# docs/decisions, ...) was seeded with a second 0001, forking its decision history. Two scopes,
# ONE record predicate:
#   - docs/adr/: any .md record counts. The scaffold's own placements (0000-template.md,
#     README.md) are non-records under the predicate, so the check reads the same whether this
#     run placed them, a previous run did, or — under -DryRun, where nothing is written — nobody
#     has yet: exclusion is by name, never by provenance.
#   - conventional homes elsewhere: named locations, not a tree-wide glob — a heuristic sweep
#     would false-positive on unrelated notes.
# A readme or a template is not a record, wherever it lives and whatever its case (deliberately
# case-insensitive — checkout filesystems differ, and a lowercase readme.md is still a readme).
# The template exclusion is anchored to the FILENAME SUFFIX: a real record about templating
# ('0007-template-engine-selection.md') counts; 'decision-template.md' / '0000-template.md' do
# not. The residual edge ('...-html-template.md') errs toward suppressing the seed, which is
# loud, over placing it, which forks a repo's history.
function Test-IsDecisionRecord([string]$Name) {
    return -not ($Name -match '^readme\.md$' -or $Name -match 'template\.md$')
}
$adrDir = Join-Path $root 'docs/adr'
$existingRecords = @()
if (Test-Path -LiteralPath $adrDir -PathType Container) {
    $existingRecords = @(Get-ChildItem -LiteralPath $adrDir -File -Filter '*.md' -ErrorAction SilentlyContinue |
        Where-Object { Test-IsDecisionRecord $_.Name })
}
$FOREIGN_ADR_DIRS = @('doc/adr', 'adr', 'docs/decisions', 'doc/architecture/decisions', 'docs/architecture/decisions')
$foreignRecords = @()
foreach ($rel in $FOREIGN_ADR_DIRS) {
    $p = Join-Path $root $rel
    if (Test-Path -LiteralPath $p -PathType Container) {
        $found = @(Get-ChildItem -LiteralPath $p -File -Filter '*.md' -ErrorAction SilentlyContinue |
            Where-Object { Test-IsDecisionRecord $_.Name })
        if ($found.Count -gt 0) { $foreignRecords += "$rel ($($found.Count))" }
    }
}
if ($existingRecords.Count -eq 0 -and $foreignRecords.Count -eq 0) {
    foreach ($k in $SEED_CORPUS.Keys) { Place $k $SEED_CORPUS[$k] $false; $considered++ }
} else {
    # Independent reports: a transitional repo can hold records in BOTH places, and the operator
    # needs to hear about the foreign ones even when docs/adr/ is populated.
    if ($existingRecords.Count -gt 0) {
        $msg = "corpus seed not placed — docs/adr/ already holds $($existingRecords.Count) record(s)"
        # The builder indexes only `NNNN-*.md` (build_docs.py FILE_RE). Suppressing the seed over
        # records the builder cannot see leaves the corpus unbuildable — the report must carry
        # the cause, or the later 'SKIP build' line states a failure with no explanation.
        $indexable = @($existingRecords | Where-Object { $_.Name -match '^\d{4}-' })
        if ($indexable.Count -eq 0) {
            $msg += (". NONE match the builder's NNNN-<slug>.md pattern, so the docs build will " +
                "refuse the corpus as empty — rename the records to NNNN-<slug>.md and give each " +
                "frontmatter (see docs/adr/0000-template.md)")
        }
        $skippedSeed += $msg
    }
    if ($foreignRecords.Count -gt 0) {
        $skippedSeed += ("corpus seed not placed — existing decision records found outside docs/adr/: " +
            "$($foreignRecords -join '; '). The builder indexes docs/ only: migrate them into docs/adr/ " +
            "(keep numbering, add frontmatter per docs/adr/0000-template.md), or the docs build will " +
            "refuse the empty corpus.")
    }
}

# --- preserved-seed drift note (ADR 0051) ---------------------------------------------------------
# A preserved seed is the one placement mode with no update path, so this probe REPORTS — never
# merges — what the current template carries that the seed lacks. It closes the measured blind
# spot between the toolchain stamp (ADR 0042) and the refresh nudge (ADR 0033): seed drift was
# found only by hand (issue #44 — a repo missing `review.derived` and the load-bearing
# `.githooks/* text eol=lf` line through five releases). Per-seed comparator, a closed set:
#   harness.json  -> STRUCTURAL: template key paths absent here. `//` comment keys are skipped
#                    and arrays are leaves — their content (groups, items) is repo-specific by
#                    design and must not be compared.
#   line-based    -> template lines (trimmed, non-empty, non-#) absent here; count + first one.
# CLAUDE.md and REVIEW.md are deliberately absent: both are placeholder prose a repo rewrites
# wholesale (ADR 0054 for the latter), so every template line would read as "missing" forever —
# a permanent-noise note is worse than none.
# Read-only by construction; an unparseable seed is a reported probe skip, never fatal.
$DRIFT_SEEDS = @('harness.json', 'gitattributes', 'gitignore', 'githooks/slice-retro-ignore')
$seedRelByDest = @{}
foreach ($k in $SEED.Keys) { $seedRelByDest[$SEED[$k]] = $k }

function Get-JsonKeyPaths([object]$Node, [string]$Prefix = '') {
    $out = @()
    if ($Node -isnot [System.Management.Automation.PSCustomObject]) { return $out }
    foreach ($p in $Node.PSObject.Properties) {
        if ($p.Name.StartsWith('//')) { continue }
        $full = if ($Prefix) { "$Prefix.$($p.Name)" } else { $p.Name }
        $out += $full
        if ($p.Value -is [System.Management.Automation.PSCustomObject]) {
            $out += Get-JsonKeyPaths $p.Value $full
        }
    }
    return $out
}

function Get-SeedDriftNote([string]$Rel, [string]$Dest) {
    $src = Join-Path $templates $Rel
    $dst = Join-Path $root $Dest
    if (-not (Test-Path -LiteralPath $src -PathType Leaf) -or -not (Test-Path -LiteralPath $dst -PathType Leaf)) { return '' }
    if ($Rel -eq 'harness.json') {
        try {
            $t = Get-Content -LiteralPath $src -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            $r = Get-Content -LiteralPath $dst -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        } catch {
            # One message for read AND parse failures — naming only JSON here sent an operator
            # hunting a syntax error in a merely-locked file (review 2026-08-12, low).
            return 'drift probe skipped: seed could not be read or parsed as JSON'
        }
        $have = @(Get-JsonKeyPaths $r)
        $missing = @(Get-JsonKeyPaths $t | Where-Object { $have -notcontains $_ })
        if (-not $missing.Count) { return '' }
        # A hand-written minimal declaration can lack dozens of keys — cap the display so the
        # note stays one line; the count is always exact.
        $shown = $missing; $more = ''
        if ($missing.Count -gt 6) { $shown = $missing[0..5]; $more = ", +$($missing.Count - 6) more" }
        return "template has $($missing.Count) key(s) this seed lacks: $($shown -join ', ')$more"
    }
    # Line-based seeds. Latin1 is the same byte-faithful read as Place() — both sides go through
    # the identical transform, so the comparison can never be skewed by a decode.
    $latin1 = [System.Text.Encoding]::Latin1
    $readLines = {
        param($p)
        @($latin1.GetString([IO.File]::ReadAllBytes($p)).Replace("`r", '') -split "`n" |
            ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
    }
    # Guarded like the JSON branch: under the script-global EAP=Stop an unguarded ReadAllBytes on
    # a locked/ACL-denied seed would abort the WHOLE run non-zero after every placement already
    # succeeded — the exact exit-contract violation ADR 0051 forbids (review 2026-08-12, high;
    # Test-Path above proves existence, never readability).
    try {
        $have = & $readLines $dst
        $missing = @((& $readLines $src) | Where-Object { $have -notcontains $_ })
    } catch { return 'drift probe skipped: seed or template could not be read' }
    if (-not $missing.Count) { return '' }
    return "template has $($missing.Count) line(s) this seed lacks, e.g. '$($missing[0])'"
}

$mode = if ($DryRun) { ' (dry run — nothing written)' } else { '' }
Write-Host "harness-init -> $root$mode"
$refusedTotal = $refused.Count + $firstRunRefused.Count
Write-Host "  created=$($created.Count) refreshed=$($refreshed.Count) replaced=$($replaced.Count) preserved=$($preserved.Count) refused=$refusedTotal unchanged=$($considered - $created.Count - $refreshed.Count - $replaced.Count - $preserved.Count - $refusedTotal)"
foreach ($f in $created) { Write-Host "  + $f" -ForegroundColor Green }
foreach ($f in $refreshed) { Write-Host "  ~ $f (toolchain refreshed from canon)" -ForegroundColor Cyan }
# -Force over a first-run collision is never labeled "refreshed": the previous content was not
# the canon's, and the label must say what actually happened to it (ADR 0055).
foreach ($f in $replaced) { Write-Host "  ~ $f (REPLACED a pre-existing non-canon file under -Force — previous content survives only in git history; ADR 0055)" -ForegroundColor Yellow }
foreach ($f in $firstRunRefused) {
    Write-Host "  ! $f REFUSED — first run found an existing file at this TOOLCHAIN path (ADR 0055)" -ForegroundColor Yellow
    Write-Host "      Nothing marks it as this scaffold's output, so it was left byte-identical. Merge or move it," -ForegroundColor Yellow
    Write-Host "      then re-run; a deliberate replacement re-runs with -Force (the previous content then survives" -ForegroundColor Yellow
    Write-Host "      only in git history)." -ForegroundColor Yellow
}
if ($firstRunRefused.Count) {
    # "First run" is INFERRED from the stamp's absence, and a scaffolded repo can lose its stamp
    # (never committed, or cleaned) — in that state the refusals above land on legitimate
    # toolchain drift, so the inference and its remedy must be stated, not implied (review
    # 2026-08-17, medium: the message read as a fact about the file's origin).
    Write-Host "      (No $STAMP_FILE stamp was found, so this run treated the repo as never scaffolded. If it WAS" -ForegroundColor Yellow
    Write-Host "      scaffolded and only the stamp is missing, -Force IS the normal re-run: toolchain files return" -ForegroundColor Yellow
    Write-Host "      to canon, and seeds are never touched either way.)" -ForegroundColor Yellow
}
foreach ($f in $preserved) {
    $note = ''
    $rel = $seedRelByDest[$f]
    if ($rel -and $DRIFT_SEEDS -contains $rel) { $note = Get-SeedDriftNote $rel $f }
    if ($note) { Write-Host "  = $f (existing seed preserved — $note)" -ForegroundColor Yellow }
    else { Write-Host "  = $f (existing seed preserved — not overwritten)" -ForegroundColor Yellow }
}
foreach ($f in $refused) {
    Write-Host "  ! $f REFUSED — an existing file without the '$GUARD_MARKER' marker" -ForegroundColor Yellow
    Write-Host "      It is doing something this scaffold did not write, so it was left alone." -ForegroundColor Yellow
    Write-Host "      To get the retro too, add this line to it (the retro never blocks a commit):" -ForegroundColor Yellow
    Write-Host '        [ "$SLICE_RETRO" = "0" ] || python scripts/harness/harness_retro.py || true' -ForegroundColor Yellow
}
foreach ($f in $skippedSeed) { Write-Host "  - $f" -ForegroundColor Yellow }

# --- same-version drift report (ADR 0067) ---------------------------------------------------------
# The prefix `upstream: SAME-VERSION drift` is a stable contract: the harness-init SKILL keys on
# it to start the draft->confirm->file flow, and feedback.ps1's dry-run parser must keep ignoring
# these lines (they match none of its `~`/`!` shapes).
if ($sameVersionDrift.Count) {
    if ($inTreeRun) {
        Write-Host "  upstream: same-version drift on $($sameVersionDrift.Count) file(s), but this plugin copy runs FROM the target tree (canon dogfood, ADR 0018) — source->placement propagation, not a hand edit; no report (ADR 0067)." -ForegroundColor Cyan
    } else {
        Write-Host "  upstream: SAME-VERSION drift — $($sameVersionDrift.Count) file(s) marked ~ above differed from this plugin's templates while the stamp already reads v$repoStampRaw." -ForegroundColor Yellow
        if ($DryRun) {
            Write-Host "      At the same version that is a LOCAL hand edit (or a modified plugin copy), never a canon update — the #55 shape (ADR 0010/0067). A real run will REVERT them; nothing was changed yet." -ForegroundColor Yellow
            Write-Host "      Report it upstream BEFORE the real run (the draft reads the drift still in the working tree): /ywr-harness:feedback — one confirmation before anything is filed." -ForegroundColor Yellow
        } else {
            Write-Host "      At the same version that is a LOCAL hand edit (or a modified plugin copy), never a canon update — the #55 shape (ADR 0010/0067). This run REVERTED them." -ForegroundColor Yellow
            if ($revertSaved.Count) { Write-Host "      pre-revert copies: $revertDir" -ForegroundColor Yellow }
            if ($revertFailed.Count) { Write-Host "      pre-revert copy FAILED for: $($revertFailed -join ', ') — that content now survives only in git history." -ForegroundColor Yellow }
            Write-Host "      Report it upstream so the canon fixes it for every repo: /ywr-harness:feedback — one confirmation before anything is filed." -ForegroundColor Yellow
        }
    }
}

if ($failed.Count) {
    foreach ($f in $failed) { Write-Host "  FAIL $f" -ForegroundColor Red }
    exit 1
}

# --- toolchain stamp (ADR 0042) ------------------------------------------------------------------
# Stamped only on a run that placed successfully (the failed-exit above never reaches here). The
# refresh nudge reads this AFTER byte drift is found, to orient its advice; it is never the
# trigger. In no placement map on purpose: manifest-gate's map-driven sweep and the nudge's
# template comparison must never see it, so it can never itself count as drift.
if ($firstRunRefused.Count) {
    # A stamp means "scaffolded": writing it now would make the very next run a re-run that
    # silently overwrites exactly the files the refusals above just protected (ADR 0055).
    Write-Host "  stamp: NOT written — $($firstRunRefused.Count) first-run toolchain collision(s) above are unresolved; a stamped repo re-runs with overwrite semantics (ADR 0055)" -ForegroundColor Yellow
} elseif ($ownVersionRaw) {
    if ($DryRun) {
        Write-Host "  stamp: would write $STAMP_FILE = $ownVersionRaw (dry run)" -ForegroundColor Cyan
    } else {
        try {
            [IO.File]::WriteAllBytes($stampPath, [System.Text.Encoding]::ASCII.GetBytes("$ownVersionRaw`n"))
            Write-Host "  stamp: $STAMP_FILE = $ownVersionRaw (which plugin version last scaffolded this repo — ADR 0042; claimed built-in by the emitter, ADR 0044)" -ForegroundColor Green
        } catch {
            Write-Host "  stamp: FAILED to write $STAMP_FILE — $($_.Exception.Message) (reported, not silent)" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "  stamp: SKIPPED — this plugin copy's own version is unreadable from .claude-plugin/plugin.json (reported, not silent)" -ForegroundColor Yellow
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
    # The placement write does not carry an executable bit, and git will not run a non-executable
    # hook on a POSIX checkout. No-op on Windows, where git invokes hooks through sh regardless of
    # the bit. NEVER on a hook this run REFUSED (a first-run collision or a marker-less
    # post-commit): "left byte-identical" must include the mode — granting +x would turn a
    # preserved foreign script into a live hook the moment the wiring below lands (review
    # 2026-08-17, high). The emitter's hooks: line reports the resulting bit gap (ADR 0056), so
    # the member makes that call, not this block.
    if (Get-Command chmod -ErrorAction SilentlyContinue) {
        $notOurs = @($firstRunRefused) + @($refused)
        foreach ($h in $hookFiles) {
            if ($notOurs -contains $h) { continue }
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

# ADR 0062 (issue #55). The vendored workflow's push trigger ENUMERATES `branches: [main, master]`
# — `on:` takes no expressions, `$default-branch` exists only in GitHub's starter templates, and
# the placed copy must stay byte-identical to the template (ADR 0014), so per-repo substitution is
# out. A repo whose default branch is outside the list never gets a push run, and GitHub does not
# even register a workflow no event has matched — nothing in CI can report a run that never
# happens. The scaffold is the one step that knows the repo, so it says it here. origin/HEAD is the
# only default-branch signal available offline; when it is unset (a `git init` + `remote add`
# clone never sets it) nothing is printed — the current branch would be a guess, and a wrong
# warning on every feature branch teaches readers to ignore the line.
$CI_PUSH_BRANCHES = @('main', 'master')
if ((Get-Command git -ErrorAction SilentlyContinue) -and $wire -notmatch '^(git not on PATH|not a git repository)') {
    $head = & git -C $root symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$head)) {
        $defaultBranch = ([string]$head).Trim() -replace '^origin/', ''
        if ($CI_PUSH_BRANCHES -notcontains $defaultBranch) {
            Write-Host "  ci trigger: default branch '$defaultBranch' is NOT in the vendored workflow's push list [$($CI_PUSH_BRANCHES -join ', ')] — harness-gates never runs on push here (PR and workflow_dispatch runs still do). A default branch outside the list needs a canon change, not a local edit (ADR 0062)." -ForegroundColor Yellow
        }
    }
}

if (-not $DryRun) {
    # Generating the four surfaces needs python. Absent python is a REPORTED skip, never silent:
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
            # All FOUR surfaces — docs.artifact.html is the artifact-publish path's input (ADR
            # 0032/0048) and omitting it here taught readers a three-surface pipeline (issue #45).
            if ($LASTEXITCODE -eq 0) { Write-Host '  built: index.json · INDEX.md · docs.html · docs.artifact.html' -ForegroundColor Green }
            else { Write-Host "  SKIP build — docs/build.ps1 exited $LASTEXITCODE; run it directly and read the error" -ForegroundColor Yellow }
        } finally { Pop-Location }
    } else {
        Write-Host '  SKIP build — python not on PATH (reported, not silent); run: pwsh docs/build.ps1' -ForegroundColor Yellow
    }
}

if ($preserved.Count) {
    Write-Host ''
    Write-Host 'Preserved seeds were NOT updated. Notes above name template-side keys/lines a seed' -ForegroundColor Yellow
    Write-Host 'lacks (report only — ADR 0051); anything beyond additions still needs a hand compare' -ForegroundColor Yellow
    Write-Host 'against skills/harness-init/templates/. This script will never clobber them.' -ForegroundColor Yellow
}
exit 0
