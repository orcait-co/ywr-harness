# SessionStart (registered WITHOUT a matcher, deliberately — the drift condition below is the
# filter, and re-speaking after `compact` re-injects a fact summaries lose) — scaffold-refresh
# nudge, suggest-only (ADR 0033).
#
# The gap this closes is ADR 0014's recorded follow-up: toolchain propagation is pull-based (a
# plugin improvement reaches a scaffolded repo only on the next /ywr-harness:harness-init run),
# and nothing detected the repo that never re-ran. This hook byte-compares the installed plugin's
# templates against the repo's placements and says so when a re-run would actually change
# something — which is the only observable that matters: a version stamp would nag on hook-only
# releases and stay silent on hand-edits, this fires exactly when the files differ.
#
# The placement map ($TOOLCHAIN / $GUARDED / $GUARD_MARKER) is extracted from init.ps1's own AST
# at each firing, NOT duplicated here: the hook and init.ps1 ship in the same plugin at the same
# version, so the map can never skew, and two copies of one rule is how they end up disagreeing
# (init.ps1's own header). Extraction failure is a reported EXTRACTION-DRIFT banner, never
# silence — a guard that cannot report its own drift is indistinguishable from an absent guard —
# bounded to plausible-scaffold repos (a `scripts/harness/` directory) so a broken plugin does
# not banner every unrelated session.
#
# Comparison contract (ADR 0033):
#   - TOOLCHAIN placements: EOL-insensitive byte identity (bytes compared after dropping 0x0D).
#     The seed .gitattributes pins `* eol=lf` and `*.ps1 eol=crlf`, so the SAME file legitimately
#     differs in raw bytes between the repo checkout and the installed plugin copy; a CR-only
#     delta is not a toolchain change. Everything else — content, encoding, BOM — stays exact.
#   - A missing TOOLCHAIN placement counts as drift, named `(missing)`: a file the canon added
#     after this repo's last scaffold run is exactly the stale state.
#   - GUARDED (post-commit) is compared only when it carries the marker; a marker-less file is
#     foreign, init.ps1 refuses to touch it, so a re-run would change nothing — silent, the same
#     shape as the githooks-nudge's foreign-hooksPath silence (ADR 0029).
#   - SEED files are never compared: their content is the consuming repo's decisions.
#
# Direction-blindness is stated, not hidden: byte difference cannot tell "repo behind plugin"
# from "repo ahead of the installed plugin" (the canon mid-slice). The systemMessage says
# *differ*, never *outdated*, and additionalContext warns the model that a re-run would REVERT
# deliberately newer copies.
#
# Stale-basis probe (ADR 0039): a running session keeps the plugin version it loaded — hooks
# resolve to the OLD cache directory until /reload-plugins or a restart, and that directory
# survives ~2 weeks after an update (doc-verified 2026-08-07). In that window this hook's
# verdict basis is stale and its advice inverts: the repo may match the NEWER registered
# install, and the harness-init THIS session would run is the old skill (measured live: a
# v0.23.2 hook told a v0.25.0-refreshed repo to revert). So, only after drift is found, the
# hook checks whether its own copy is still the registered install — self-located from
# $PSScriptRoot (<plugins>/cache/<marketplace>/<name>/<version>, registry sibling at
# <plugins>/installed_plugins.json — an UNDOCUMENTED file, read best-effort like the
# statusline, ADR 0027). Stale -> same file list, but the advice becomes "reload, re-check,
# do NOT run harness-init from this session". A registered version EQUAL to the running one
# falls back to the normal nudge (same release, same templates — nothing to invert; and
# "runs vX while the install is vX" would contradict itself). Any probe failure -> the normal
# nudge: the probe can only improve the advice, never silence the hook.
#
# Direction probe (ADR 0042): after drift, the NORMAL branch reads the repo's `.harness-version`
# stamp (written by init.ps1 on every successful run — generated, never a template, never in the
# placement map, so it can never itself count as drift). stamp > running -> repo AHEAD: the
# advice flips to "update the plugin, do NOT init" (multi-writer: another writer refreshed this
# repo with a newer plugin). stamp < running -> refresh advice with the direction stated as
# measured. equal -> the drift is a hand-edit or partial placement, named as ADR 0010's intended
# signal. missing/unparseable -> direction-blind caveat, now on BOTH output surfaces (the old
# uncaveated "re-run is safe" human banner is retired — the 2026-08-10 audit's asymmetry). The
# 0039 stale-basis banner takes precedence over all of this; probe failures fall through, never
# silence.
#
# Payload and output contract: same as the sibling nudge (verified against the official hooks
# reference 2026-08-05) — cwd per firing; systemMessage AND hookSpecificOutput.additionalContext
# both consumed; plain stdout on exit 0 becomes context, so every non-speaking path exits with
# EMPTY stdout. SessionStart cannot block anything; this hook does not try — exit 0 always,
# fail-open like its siblings. This hook writes nothing, ever.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
try { $payload = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { exit 0 }
if ([string]$payload.hook_event_name -ne 'SessionStart') { exit 0 }

$cwd = ([string]$payload.cwd).Trim()
if (-not $cwd) {
    $keys = '(none)'
    try { $k = @($payload.PSObject.Properties.Name | Sort-Object); if ($k) { $keys = $k -join ', ' } } catch { }
    $drift = "[hook:scaffold-refresh-nudge] SCHEMA DRIFT — a SessionStart payload arrived with no 'cwd' field, so this hook could not check whether this repo's vendored toolchain matches the installed plugin. Keys received: $keys. Re-verify the payload shape and fix hooks/session-start-scaffold-refresh-nudge.ps1 (ADR 0033)."
    @{ systemMessage = $drift } | ConvertTo-Json -Compress
    exit 0
}

# Join-Path/Test-Path raise NON-TERMINATING errors when a path names a root that does not exist
# on this platform (the 48c264c CI failure class), so every probe promotes to Stop and treats
# the catch as "not there".
function Test-Dir([string]$Path) {
    try { $ErrorActionPreference = 'Stop'; return (Test-Path -LiteralPath $Path -PathType Container) } catch { return $false }
}
function Test-File([string]$Path) {
    try { $ErrorActionPreference = 'Stop'; return (Test-Path -LiteralPath $Path -PathType Leaf) } catch { return $false }
}

# Resolve the work tree root from cwd so a subdirectory session still finds the repo. Without
# git the verdict still runs — unlike the sibling, whose verdict IS git state, this verdict is
# filesystem-only — using cwd as the root candidate; a subdirectory session simply stays silent
# in that degraded case. NOT `| Select-Object -First 1` (leaves $LASTEXITCODE empty — measured
# 2026-08-05, pwsh 7.6).
$root = ''
if (Get-Command git -ErrorAction SilentlyContinue) {
    try { $lines = @(& git -C $cwd rev-parse --show-toplevel 2>$null); if ($lines.Count) { $root = ([string]$lines[0]).Trim() } } catch { }
    if ($LASTEXITCODE -ne 0 -or -not $root) { exit 0 }
} else {
    $root = $cwd
}

# Plausible-scaffold gate: init.ps1 places scripts/harness/ unconditionally, so a repo without
# that directory was never scaffolded and there is nothing to verify. This is also the noise
# bound for the extraction banner below — a broken plugin banners only where a scaffold
# plausibly exists, not in every session on the machine.
if (-not (Test-Dir (Join-Path $root 'scripts/harness'))) { exit 0 }

# --- placement map, extracted from init.ps1's own literals (zero second copy — ADR 0033) ------
$pluginRoot = Split-Path $PSScriptRoot -Parent
$initPath = Join-Path $pluginRoot 'skills/harness-init/init.ps1'
$templatesDir = Join-Path $pluginRoot 'skills/harness-init/templates'

function Get-InitAssignment($Ast, [string]$VarName) {
    return $Ast.Find({ param($a)
            $a -is [System.Management.Automation.Language.AssignmentStatementAst] -and
            $a.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
            $a.Left.VariablePath.UserPath -eq $VarName }, $true)
}
# Returns the literal value ONLY when the node IS a bare string constant (possibly wrapped in
# the one-element pipeline every hashtable value and assignment RHS parses to). NOT `.Find()`:
# Find searches the whole subtree and returns the first string constant ANYWHERE inside it, so
# a computed value that merely CONTAINS a literal — `'prefix/' + $suffix`, an expandable
# "$dir/file", a nested table — would contribute a truncated fragment to the map instead of
# failing extraction whole (review 2026-08-06, high; reproduced: Find returned 'prefix/' for
# `'prefix/' + $suffix`). A fragment in the map is a wrong path compared quietly.
function Get-PureStringConstant($Node) {
    if ($Node -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return $Node.Value }
    # The two STATEMENT wrappers a bare expression parses into, and nothing else: an assignment
    # RHS arrives as a CommandExpressionAst directly, a hashtable value as a PipelineAst around
    # one (both MEASURED on the real init.ps1, pwsh 7.6 — the first draft assumed PipelineAst
    # everywhere and banner-failed on the genuine literals). Unwrapping the wrapper keeps the
    # strictness: a concatenation is a BinaryExpressionAst under the same wrapper -> $null.
    if ($Node -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return (Get-PureStringConstant $Node.Expression)
    }
    if ($Node -is [System.Management.Automation.Language.PipelineAst]) {
        $elems = @($Node.PipelineElements)
        if ($elems.Count -eq 1 -and $elems[0] -is [System.Management.Automation.Language.CommandExpressionAst]) {
            return (Get-PureStringConstant $elems[0].Expression)
        }
    }
    return $null
}
# The RHS must BE a (possibly [ordered]-converted) hashtable literal, not merely contain one:
# `.Find()` here would accept `Compute-X @{...}` and read the call's argument as the map.
function Get-LiteralHashtableAst($Right) {
    $e = $null
    if ($Right -is [System.Management.Automation.Language.CommandExpressionAst]) { $e = $Right.Expression }
    elseif ($Right -is [System.Management.Automation.Language.PipelineAst]) {
        $elems = @($Right.PipelineElements)
        if ($elems.Count -ne 1 -or $elems[0] -isnot [System.Management.Automation.Language.CommandExpressionAst]) { return $null }
        $e = $elems[0].Expression
    }
    else { return $null }
    # ConvertExpressionAst ([ordered]@{...}) subclasses AttributedExpressionAst; unwrap to the literal.
    while ($e -is [System.Management.Automation.Language.AttributedExpressionAst]) { $e = $e.Child }
    if ($e -is [System.Management.Automation.Language.HashtableAst]) { return $e }
    return $null
}
# Literal hashtable -> ordered map. Returns $null on ANY non-literal entry: a computed key or
# value means the map is no longer readable without executing init.ps1, and the honest verdict
# is "extraction failed", not a partial map that silently narrows coverage.
function Get-LiteralMap($Ast, [string]$VarName) {
    $asgn = Get-InitAssignment $Ast $VarName
    if (-not $asgn) { return $null }
    $ht = Get-LiteralHashtableAst $asgn.Right
    if (-not $ht) { return $null }
    $map = [ordered]@{}
    foreach ($kv in $ht.KeyValuePairs) {
        $key = Get-PureStringConstant $kv.Item1
        $val = Get-PureStringConstant $kv.Item2
        if ($null -eq $key -or $null -eq $val) { return $null }
        $map[$key] = $val
    }
    if (-not $map.Count) { return $null }
    return $map
}
function Get-LiteralValue($Ast, [string]$VarName) {
    $asgn = Get-InitAssignment $Ast $VarName
    if (-not $asgn) { return $null }
    return (Get-PureStringConstant $asgn.Right)
}
function Write-ExtractionDrift([string]$Detail) {
    $msg = "[hook:scaffold-refresh-nudge] EXTRACTION DRIFT — $Detail — so whether $root's vendored toolchain matches the installed plugin is UNKNOWN, not verified. The installed plugin's own files are inconsistent: update or reinstall ywr-harness, and report it (ADR 0033)."
    @{ systemMessage = $msg } | ConvertTo-Json -Compress
}

$toolchain = $null; $guarded = $null; $marker = $null
if (Test-File $initPath) {
    $tok = $null; $err = $null
    try { $ast = [System.Management.Automation.Language.Parser]::ParseFile($initPath, [ref]$tok, [ref]$err) } catch { $ast = $null }
    if ($ast -and -not ($err -and $err.Count)) {
        $toolchain = Get-LiteralMap $ast 'TOOLCHAIN'
        $guarded = Get-LiteralMap $ast 'GUARDED'
        $marker = Get-LiteralValue $ast 'GUARD_MARKER'
    }
}
if (-not $toolchain -or -not $guarded -or -not $marker) {
    Write-ExtractionDrift 'the placement map could not be read from the installed plugin''s skills/harness-init/init.ps1 ($TOOLCHAIN/$GUARDED/$GUARD_MARKER literals)'
    exit 0
}

# File-level sentinel: the directory gate above is a plausibility bound; ownership is decided
# here. A repo with its OWN scripts/harness/ but none of the mapped vendored scripts was not
# scaffolded by us — counting everything "missing" there would be a false nudge.
$sentinels = @($toolchain.Values | Where-Object { $_ -match '^scripts/harness/.+\.py$' })
if (-not $sentinels.Count) {
    # The regex above assumes the map's CONTENTS, not just its extractability — if the canon
    # ever moves the vendored scripts, an unchecked empty list would silently disable this hook
    # on every repo forever, which is the anti-vacuity failure mode this hook exists to refuse
    # (review 2026-08-06, medium).
    Write-ExtractionDrift 'the extracted placement map contains no scripts/harness/*.py destination, so the ownership sentinel this hook keys on has moved in init.ps1'
    exit 0
}
$ours = $false
foreach ($s in $sentinels) { if (Test-File (Join-Path $root $s)) { $ours = $true; break } }
if (-not $ours) { exit 0 }

# EOL-insensitive comparable text: Latin1 maps bytes 1:1 to chars (byte-faithful both ways), so
# this is a byte comparison modulo 0x0D, not a decode — a real encoding or BOM change still
# differs. Latin1 chosen over a byte loop for speed at session start: the steady state reads
# BOTH sides of all 17 placements, ~35 content reads (review 2026-08-06, low — an earlier
# comment said ~18, counting one side).
function Get-ComparableText([string]$Path) {
    return [System.Text.Encoding]::Latin1.GetString([IO.File]::ReadAllBytes($Path)).Replace("`r", '')
}

$drifted = [System.Collections.Generic.List[string]]::new()
foreach ($k in @($toolchain.Keys)) {
    $src = Join-Path $templatesDir $k
    $dst = Join-Path $root $toolchain[$k]
    if (-not (Test-File $src)) { Write-ExtractionDrift "template missing from the installed plugin: templates/$k"; exit 0 }
    if (-not (Test-File $dst)) { $drifted.Add("$($toolchain[$k]) (missing)"); continue }
    try { if ((Get-ComparableText $src) -ne (Get-ComparableText $dst)) { $drifted.Add($toolchain[$k]) } } catch { $drifted.Add("$($toolchain[$k]) (unreadable)") }
}
foreach ($k in @($guarded.Keys)) {
    $src = Join-Path $templatesDir $k
    $dst = Join-Path $root $guarded[$k]
    if (-not (Test-File $src)) { Write-ExtractionDrift "template missing from the installed plugin: templates/$k"; exit 0 }
    if (-not (Test-File $dst)) { $drifted.Add("$($guarded[$k]) (missing)"); continue }
    try {
        $body = Get-ComparableText $dst
        # Marker-less = foreign = init.ps1 refuses it = a re-run changes nothing: silent.
        if ($body.Contains($marker) -and $body -ne (Get-ComparableText $src)) { $drifted.Add($guarded[$k]) }
    } catch { $drifted.Add("$($guarded[$k]) (unreadable)") }
}

if (-not $drifted.Count) { exit 0 }

$ver = 'version unknown'
try {
    $mf = Get-Content -LiteralPath (Join-Path $pluginRoot '.claude-plugin/plugin.json') -Raw | ConvertFrom-Json
    if ($mf.version) { $ver = "v$($mf.version)" }
} catch { }

# Capped list, cap stated — a silent truncation reads as full coverage.
$shown = @($drifted | Select-Object -First 5)
$fileList = $shown -join ', '
if ($drifted.Count -gt $shown.Count) { $fileList += ", +$($drifted.Count - $shown.Count) more" }

# --- stale-basis probe (ADR 0039) — see the header block ---------------------------------------
# Every step that can fail is terminating-and-caught (-ErrorAction Stop where a cmdlet's default
# is non-terminating): a probe failure must yield $null AND a clean stderr — the selftest
# captures 2>&1, and a stray error line would corrupt the JSON envelope. Path equality is
# case-insensitive: paths here are Windows-first, and on Linux a false case-insensitive MATCH
# merely degrades to the normal nudge (the pre-0039 behavior), which is the safe direction.
$staleActive = $null
try {
    $rr = [IO.Path]::GetFullPath($pluginRoot).TrimEnd('\', '/')
    $nameDir = Split-Path $rr -Parent                    # <plugins>/cache/<marketplace>/<name>
    $mktDir = Split-Path $nameDir -Parent                # <plugins>/cache/<marketplace>
    $cacheDir = Split-Path $mktDir -Parent               # <plugins>/cache
    # Only a versioned cache copy can be stale-by-supersession. A --plugin-dir or repo-source
    # copy has no `cache` great-grandparent and stays on the 0033 contract (direction-blind
    # caveat), which is the correct reading for a deliberately loaded local copy.
    if ($cacheDir -and (Split-Path $cacheDir -Leaf) -eq 'cache') {
        $regPath = Join-Path (Split-Path $cacheDir -Parent) 'installed_plugins.json'
        if (Test-File $regPath) {
            $pluginName = Split-Path $nameDir -Leaf
            $reg = Get-Content -LiteralPath $regPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            # Name from the path, not plugin.json: the path IS what the registry keys index,
            # and it survives an unreadable manifest. The `@<marketplace>` half is not pinned
            # (a consuming org may register the marketplace under another name — ADR 0027).
            $entries = @()
            foreach ($prop in @($reg.plugins.PSObject.Properties)) {
                if ($prop.Name -notlike "$pluginName@*") { continue }
                $entries += @($prop.Value)
            }
            if ($entries.Count) {
                $current = $false
                foreach ($e in $entries) {
                    $ip = ''
                    try { $ip = [IO.Path]::GetFullPath([string]$e.installPath).TrimEnd('\', '/') } catch { }
                    if ($ip -and [string]::Equals($ip, $rr, [StringComparison]::OrdinalIgnoreCase)) { $current = $true; break }
                }
                if (-not $current) {
                    # ≥1 entry, none of them this copy: the session outlived an update (or a
                    # scope re-install). Registered version for the message, the statusline's
                    # pick order as spec 0010 records it: user scope wins, then lastUpdated
                    # recency — never registry order. A usable version is a SCALAR STRING
                    # carrying a digit: ConvertFrom-Json can deliver an array here from a
                    # corrupted write, and [string] would space-join it into a digit-bearing
                    # "1.0.0 2.0.0" that renders malformed (review 2026-08-07, low); the
                    # registry's "unknown" sentinel fails the digit test. Unmeasured is not a
                    # value.
                    $best = $null
                    foreach ($e in $entries) {
                        if ($e.version -isnot [string] -or $e.version -notmatch '\d') { continue }
                        $eu = ([string]$e.scope -eq 'user')
                        $bu = ($null -ne $best -and [string]$best.scope -eq 'user')
                        if ($null -eq $best -or ($eu -and -not $bu) -or (($eu -eq $bu) -and ([string]$e.lastUpdated -gt [string]$best.lastUpdated))) { $best = $e }
                    }
                    $staleActive = if ($best) { 'v' + (([string]$best.version) -replace '^v', '') } else { 'version unknown' }
                    # Same version string as the running copy -> NOT stale-for-advice: a
                    # same-version re-registration (cross-marketplace key, cache re-seed)
                    # ships the same templates, so the refresh advice is not inverted — and
                    # "still runs $ver while the install is $ver" contradicts itself (review
                    # 2026-08-07, medium). Fall back to the normal nudge; -eq is
                    # case-insensitive, and the both-'version unknown' corner falls back too,
                    # which is the honest reading (nothing provable to say).
                    if ($staleActive -eq $ver) { $staleActive = $null }
                }
            }
        }
    }
}
catch { $staleActive = $null }

if ($staleActive) {
    $sys = "[hook:scaffold-refresh-nudge] ${root}: $($drifted.Count) vendored toolchain file(s) differ from this session's ywr-harness ($ver) templates — $fileList — but the comparison basis is STALE: this session still runs $ver while this machine's registered install is $staleActive. The verdict may be inverted (the repo may simply match the newer install). Run /reload-plugins (or restart the session) and let the next session start re-check; do NOT run /ywr-harness:harness-init from this session — it would place the $ver templates (ADR 0039). Nothing was changed; this hook only suggests (ADR 0033)."
    $ctx = "The repo at $root shows scaffold-toolchain drift ($fileList), but the verdict basis is STALE: this session's ywr-harness hooks and skills still run $ver while the machine's registered install is $staleActive — a running session keeps the plugin version it loaded until /reload-plugins or a restart. The drift verdict may therefore be inverted: the repo may already match the newer install's templates. Do NOT run or suggest /ywr-harness:harness-init from this session — the loaded skill would place the $ver templates and could REVERT correctly refreshed files (ADR 0039). The remedy is /reload-plugins or a session restart, after which the next session start re-checks against the updated plugin. This surface is suggest-only (ADR 0033)."
    @{
        systemMessage      = $sys
        hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $ctx }
    } | ConvertTo-Json -Compress
    exit 0
}

# --- direction probe (ADR 0042) — normal branch only ---------------------------------------------
# The stale-basis banner above already forbids init and takes precedence. Here, drift is real and
# the session is current on this machine; what byte comparison cannot say is WHICH SIDE is newer
# — and under multi-writer "another writer refreshed this repo with a newer plugin" is the
# everyday state, not the canon-mid-slice edge 0033 accepted. `.harness-version` (written by
# init.ps1 on every successful run) orients the advice: repo-ahead flips it to "update the
# plugin, do NOT init"; repo-behind states the direction as measured; same-version names a
# hand-edit; unreadable/missing falls back to direction-blind — with the caveat now on the HUMAN
# surface too, not only in additionalContext (the 2026-08-10 audit's asymmetry). Every probe
# failure is terminating-and-caught: stderr must stay clean.
$stampVer = $null; $stampDisp = ''
try {
    $ErrorActionPreference = 'Stop'
    $sp = Join-Path $root '.harness-version'
    if (Test-Path -LiteralPath $sp -PathType Leaf) {
        # BOUNDED read — never Get-Content here: a stamp with no newline before EOF would be read
        # WHOLE as "line 1", and a symlink at a device (git materializes symlinks) would never
        # return — on the hot path of every SessionStart (review 2026-08-10, medium). 64 bytes is
        # generous for a version token; anything longer becomes a clean parse failure. BOM
        # skipped; the first line is cut by hand.
        $fs = [IO.File]::OpenRead($sp)
        try { $buf = [byte[]]::new(64); $n = $fs.Read($buf, 0, 64) } finally { $fs.Dispose() }
        $off = if ($n -ge 3 -and $buf[0] -eq 0xEF -and $buf[1] -eq 0xBB -and $buf[2] -eq 0xBF) { 3 } else { 0 }
        $t = [System.Text.Encoding]::ASCII.GetString($buf, $off, $n - $off)
        $cut = $t.IndexOfAny(@([char]"`r", [char]"`n"))
        if ($cut -ge 0) { $t = $t.Substring(0, $cut) }
        $t = $t.Trim() -replace '^v', ''
        if ($t -match '^\d+(\.\d+)+$') {
            # [version] pads unspecified components with -1, so '0.28' would compare BELOW
            # '0.28.0' and flip the direction verdict (review 2026-08-10, low). Normalize to four
            # components before casting — the same rule as init.ps1's ConvertTo-VersionOrNull,
            # cross-referenced there; more than four stays invalid. Display keeps the raw token.
            $parts = @($t -split '\.')
            if ($parts.Count -le 4) {
                while ($parts.Count -lt 4) { $parts += '0' }
                $stampVer = [version]($parts -join '.')
                $stampDisp = "v$t"
            }
        }
    }
} catch { $stampVer = $null; $stampDisp = '' }
$runVer = $null
if ($ver -match '^v(\d+(\.\d+)+)$') {
    try {
        $parts = @($Matches[1] -split '\.')
        if ($parts.Count -le 4) { while ($parts.Count -lt 4) { $parts += '0' }; $runVer = [version]($parts -join '.') }
    } catch { $runVer = $null }
}

$fileClause = "$($drifted.Count) vendored toolchain file(s) differ from the installed ywr-harness ($ver) templates — $fileList"
if ($stampVer -and $runVer -and $stampVer -gt $runVer) {
    $sys = "[hook:scaffold-refresh-nudge] ${root}: $fileClause — and this repo's .harness-version stamp says it was last scaffolded by ywr-harness $stampDisp, NEWER than this session's $ver. The repo is AHEAD: do NOT run /ywr-harness:harness-init from this session — it would place the older $ver templates and REVERT the newer refresh (ADR 0042). Remedy: /ywr-harness:update (or 'claude plugin update'), then restart or /reload-plugins and re-check. Nothing was changed; this hook only suggests (ADR 0033)."
    $ctx = "The repo at $root shows scaffold-toolchain drift ($fileList), and its .harness-version stamp ($stampDisp) is NEWER than this session's installed ywr-harness ($ver) — another writer refreshed this repo with a newer plugin (ADR 0042). Do NOT run or suggest /ywr-harness:harness-init from this session: the loaded skill would place the $ver templates and REVERT the newer refresh. The remedy is updating the plugin (/ywr-harness:update or 'claude plugin update') and reloading or restarting; the next session start re-checks. This surface is suggest-only (ADR 0033)."
} elseif ($stampVer -and $runVer -and $stampVer -lt $runVer) {
    $sys = "[hook:scaffold-refresh-nudge] ${root}: $fileClause. The repo's .harness-version stamp ($stampDisp) is OLDER than this session's $ver — the refresh direction is measured, not guessed (ADR 0042). Refresh: run /ywr-harness:harness-init once for this repo and commit (re-run is safe here: toolchain refreshed, seeds preserved, nothing deleted — ADR 0010). Nothing was changed; this hook only suggests (ADR 0033)."
    $ctx = "The repo at $root carries a ywr-harness scaffold whose placed toolchain differs from the installed plugin's templates ($ver), and the repo's .harness-version stamp ($stampDisp) is OLDER than the installed plugin — the repo is genuinely behind (ADR 0042). A /ywr-harness:harness-init re-run refreshes the toolchain from the canon and never touches seeds or accumulated ADRs. Offer the re-run when the work touches gates, hooks, or CI; do not run it unasked — this surface is suggest-only (ADR 0033)."
} elseif ($stampVer -and $runVer -and $stampVer -eq $runVer) {
    $sys = "[hook:scaffold-refresh-nudge] ${root}: $fileClause — while the repo's .harness-version stamp EQUALS this session's $ver, so the difference is a hand-edit or an incomplete placement, not a version gap (ADR 0042). A /ywr-harness:harness-init re-run would REVERT hand-edits to the canon templates — ADR 0010's intended signal (harness defects are fixed in the canon, never patched in a consuming repo). Nothing was changed; this hook only suggests (ADR 0033)."
    $ctx = "The repo at $root shows scaffold-toolchain drift ($fileList) at the SAME version as this session's installed plugin (stamp $stampDisp equals $ver): a hand-edit or partial placement, not staleness (ADR 0042). A harness-init re-run reverts hand-edits — the intended ADR 0010 signal, but confirm the edits are not deliberate local work in progress before suggesting it. This surface is suggest-only (ADR 0033)."
} else {
    $sys = "[hook:scaffold-refresh-nudge] ${root}: $fileClause. CAVEAT — this comparison is direction-blind (no readable .harness-version stamp): if another writer refreshed this repo with a NEWER plugin than this machine's, a /ywr-harness:harness-init re-run from here would REVERT their refresh (ADR 0042). Confirm the installed plugin is current (/ywr-harness:update) BEFORE running it; a refresh re-run is otherwise safe (toolchain refreshed, seeds preserved, nothing deleted — ADR 0010). Nothing was changed; this hook only suggests (ADR 0033)."
    $ctx = "The repo at $root carries a ywr-harness scaffold whose placed toolchain differs from the installed plugin's templates ($ver): $fileList. No readable .harness-version stamp, so the comparison is DIRECTION-BLIND: if this working tree deliberately carries NEWER copies than the installed plugin (the canon mid-slice, or a multi-writer repo refreshed by a newer plugin), a re-run would REVERT them to the older installed templates (ADR 0042). Offer the re-run when the work touches gates, hooks, or CI, after confirming the installed plugin is current; do not run it unasked — this surface is suggest-only (ADR 0033)."
}
@{
    systemMessage      = $sys
    hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $ctx }
} | ConvertTo-Json -Compress
exit 0
