# Shared selftest core. Four things live here, added in the order the duplication justified
# them: the ADR 0116 empty-MustNotMatch guard with the match loops it protects (ADR 0125), the
# fixture lifecycle (ADR 0126), and — on their third copy / first measured failure — the boolean
# `Assert-True` verdict and the child-output decoding pin (ADR 0128).
#
# The guard half (ADR 0125) is the single owner of the ADR 0116 empty-MustNotMatch rule.
#
# Before this file the guard was copy-pasted into standalone helpers, and the copies
# were miscounted while being counted: ADR 0116 Addendum said four (a claim scoped to
# .claude/hooks/ without saying so), ADR 0122 said five, ADR 0124 said six. The real
# number was SEVEN — the ADR 0122 slice added two copies (harness-scope and
# harness-selftest-linux) and only one of them was counted, so every later count was
# off by one. An eighth helper (scripts/watch-cd.selftest.ps1) had the MustNotMatch
# parameter and no guard at all.
#
# Dot-source it; do not run it:
#     . (Join-Path $PSScriptRoot '../../scripts/ci/selftest-lib.ps1')   # from .claude/hooks/
#     . (Join-Path $PSScriptRoot 'selftest-lib.ps1')                    # from scripts/ci/
# Dot-sourcing executes in the CALLER's scope, so a wrapper defined in the caller keeps
# writing $script:LastFails into the caller's own script scope — verified with a probe,
# not assumed, because the META cases in every caller read that variable back.
#
# Each MATCH-BASED selftest keeps its own thin Assert-* wrapper. Those call sites are positional
# and the adapters genuinely differ (JSON-envelope extraction, which variable holds the exit
# code, which extra facts a given gate asserts), so what is shared for them is the INVARIANT and
# not the call shape. `Assert-True` is the exception and is shared whole: its three copies were
# identical apart from a contract divergence that failed open (ADR 0128).
#
# The MustMatch/MustNotMatch DISCIPLINE is still not in scope for helpers with no such pair —
# .claude/hooks/subagent-telemetry.selftest.ps1 (Pass/Fail calls), scripts/ci-local and
# scripts/ci/resolve-base (Assert-True over booleans), and
# scripts/ci/harness-pins.selftest.ps1, which is MustMatch-only ON PURPOSE and says so
# in its own comment. Folding those in would mean inventing negatives for assertions
# that do not have any. They dot-source this file regardless — subagent-telemetry and
# harness-pins since ADR 0126 for the FIXTURE half, ci-local and resolve-base since ADR 0128
# for Assert-True and the decoding pin. Sharing a helper is not the same as adopting the
# discipline, and the two are deliberately independent.
#
# scripts/ci/selftest-lib.selftest.ps1 keeps its OWN boolean assert (Assert-Bootstrap) rather
# than calling the shared one: it is testing this file, and an assertion helper that asserts
# itself passes vacuously when it breaks. Same reason its cases compare exact failure arrays
# instead of using the guard they exercise.

Set-StrictMode -Off

# --- child-output decoding pin (ADR 0128) ------------------------------------
# Every selftest here captures a child process's stdout, and PowerShell decodes native output
# with [Console]::OutputEncoding — which is the LAUNCHING console's code page, not the child's.
# From a Git-Bash-launched pwsh on this Korean Windows box that is cp949, and a child's UTF-8
# em-dash (E2 80 94) decodes to a literal '?' (0x3F), irreversibly: session-context's
# `fanout depth unset` case went red for that and nothing else, and the recorded workaround was
# "run the selftests from PowerShell". Probe 2026-07-26, same child and same file both ways:
# cp949 -> "A ? B" (41 20 3f 20 42) · pinned UTF-8 -> "A — B" (41 20 e2 80 94 20 42).
# Set in the core because it is what every capturing selftest already dot-sources. It is
# process-global and dies with the process; the console still RENDERS non-ASCII per its own code
# page, which is a display concern and not what an assertion reads.
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }

function Get-AssertionFailure {
    # Returns the failure reasons for one case as [string[]] — empty array when clean.
    # Prints nothing: the caller decides the verdict line (Write-CaseVerdict) and owns
    # $script:LastFails, which its META case inspects.
    [OutputType([string[]])]
    param(
        [string]$Text = '',
        [string[]]$MustMatch = @(),
        [string[]]$MustNotMatch = @(),
        [string]$NoNegative = '',
        # caller-computed failures (exit codes, JSON parse, envelope shape) — anything
        # this core cannot know. Ordered after the guard, before the match failures.
        [string[]]$PreFail = @(),
        # prefixes the match messages when $Text is an extracted field rather than raw
        # stdout, e.g. 'systemMessage' -> "systemMessage missing /x/".
        [string]$Label = ''
    )
    $fails = @()
    # ADR 0116's empty-MustNotMatch CLASS: a case that disallows nothing asserts presence
    # only, so it stays green against any defect that ADDS output. -NoNegative '<reason>'
    # is the visible exemption; an empty list is not one, and neither is whitespace —
    # IsNullOrWhiteSpace rather than -not, so ' ' cannot buy an exemption (the seven
    # standalone copies all used -not and would have accepted it).
    # FIRST in the list on purpose: every caller's META case asserts $LastFails[0] is the
    # guard, which is how it proves the case failed for the guard reason and not for an
    # unrelated mismatch.
    # The `-not $MustNotMatch` disjunct is REDUNDANT and kept only because all seven copies
    # carried it: measured on pwsh 7.6.4, `$null.Count` is 0, so `.Count -eq 0` alone already
    # covers both $null (what callers forward) and @(). Do not read it as the null guard.
    if (((-not $MustNotMatch) -or $MustNotMatch.Count -eq 0) -and [string]::IsNullOrWhiteSpace($NoNegative)) {
        $fails += 'no MustNotMatch and no -NoNegative reason (ADR #116 class)'
    }
    $fails += $PreFail
    $pfx = if ($Label) { "$Label " } else { '' }
    foreach ($p in $MustMatch) { if ($Text -notmatch $p) { $fails += "${pfx}missing /$p/" } }
    foreach ($p in $MustNotMatch) { if ($Text -match $p) { $fails += "${pfx}unexpected /$p/" } }
    # unary comma: without it PowerShell unrolls an empty array to $null and the caller's
    # $LastFails.Count blows up on the clean path.
    return , [string[]]$fails
}

function Write-CaseVerdict {
    # Prints the PASS/FAIL line and RETURNS the boolean the caller folds into $ok.
    # Write-Host goes to the information stream, which is why callers can silence a META
    # probe with `6>$null` while still reading the returned verdict.
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][string]$Name,
        [string[]]$Fail = @(),
        # raw output echoed under a FAIL so the reason is diagnosable from CI logs alone
        [string]$Detail = ''
    )
    if ($Fail -and $Fail.Count) {
        Write-Host "FAIL [$Name]: $($Fail -join ' · ')" -ForegroundColor Red
        if ($Detail) { Write-Host $Detail }
        return $false
    }
    Write-Host "PASS [$Name]" -ForegroundColor Green
    return $true
}

function Assert-True {
    # Case verdict for a selftest whose assertion is a computed predicate rather than a text
    # match. Folded in by ADR 0128 on its third copy — and the copies had DIVERGED under one
    # name: two wrote $script:ok as a side effect and returned nothing, the third returned the
    # verdict and touched nothing. Both mixups fail OPEN (a failing case leaves $ok true), which
    # is why this is not cosmetic de-duplication.
    # The contract is the RETURNING one, matching Write-CaseVerdict: `$ok = (Assert-True ...) -and $ok`.
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][string]$Name,
        [bool]$Condition,
        # shown after the FAIL; substituted when empty, because Write-CaseVerdict reads @('')
        # as no-failure (PowerShell unrolls a single-element array to its element, and '' is
        # falsy) and would print PASS for a failed assertion.
        [string]$Detail = ''
    )
    $fail = @()
    if (-not $Condition) { $fail = @($(if ($Detail) { $Detail } else { 'condition was false' })) }
    return (Write-CaseVerdict -Name $Name -Fail $fail)
}

# --- fixture lifecycle (ADR 0126) --------------------------------------------
# The second thing this core owns. Every selftest needing a scratch tree built the path by
# hand (GetTempPath + "<name>-$PID") and then placed its `Remove-Item -Recurse` as the LAST
# UNCONDITIONAL statement, so with $ErrorActionPreference = 'Stop' a terminating error
# mid-run leaked a PID-suffixed %TEMP% tree permanently. TEN selftests carried a temp fixture
# before this slice (`git grep -l GetTempPath HEAD -- '*.selftest.ps1'`, uncapped) and EIGHT had
# that shape — not the six the backlog recorded, because harness-pins and subagent-telemetry do
# not use the assertion core and so went unread when the leaking files were counted. Same
# off-by-N as the guard count ADR 0125 corrected, one surface over. The other two were already
# exception-safe: directory-added-guard (try/finally) and resolve-base (per-call temp file).
#
# The caller-side shape is a script-scope trap, MEASURED on pwsh 7.6.4 rather than assumed
# (probe 2026-07-26: fires on `throw`, on a cmdlet terminating error raised inside a called
# function, and on an error inside a loop; the error still reaches stderr and the script
# still exits 1; the clean path and non-terminating errors are untouched):
#
#     $fx = New-FixtureRoot 'my-selftest'
#     trap { Remove-FixtureRoot $fx; break }     # AFTER the assignment, or it cleans $null
#     ...
#     Remove-FixtureRoot $fx
#
# The body binds when it FIRES, not when it is written, so a caller with a second temp path
# assigned further down (session-context's scratch git-config file) can name it in the trap
# immediately: it resolves to the real path for any later error, and to $null — skipped — for
# an earlier one. That is strictly better than waiting to declare the trap.
#
# `break` in a trap is what rethrows and stops the script; `continue` would swallow the
# error and carry on through the remaining cases. try/finally is the textbook shape and was
# rejected on diff size alone: it would reindent 100-350 line bodies in eight working files,
# burying the change under transcription risk. .claude/hooks/directory-added-guard.selftest.ps1
# keeps its own try/finally and per-case GUID dirs — already exception-safe, so converting it
# would be churn.

function Test-FixtureRootPath {
    # $true only for a path strictly INSIDE the system temp root. PURE — no filesystem
    # access, so the selftest can enumerate every refusal case without risking a deletion.
    # Remove-FixtureRoot deletes recursively with -Force, so the inputs that must never be
    # accepted are the ones that are not a fixture: a repo path passed by mistake, and the
    # temp root ITSELF (equal is not inside — accepting it would wipe every other process's
    # fixtures, including a parallel container run's).
    [OutputType([bool])]
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    $tmp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $tmp.EndsWith([IO.Path]::DirectorySeparatorChar)) { $tmp += [IO.Path]::DirectorySeparatorChar }
    # GetFullPath normalizes separators and resolves ../ FIRST, which is why this is a
    # prefix test on the resolved path and not a string search on the argument.
    try { $full = [IO.Path]::GetFullPath($Path) } catch { return $false }
    $cmp = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    return ($full.Length -gt $tmp.Length) -and $full.StartsWith($tmp, $cmp)
}

function Test-KeepFixture {
    # Reads the keep switch. Pure and separate so its cases cost nothing, and because
    # `if ($env:X)` is the wrong test for a flag: PowerShell calls every non-empty string
    # truthy, so YWR_SELFTEST_KEEP_FIXTURE=0 would KEEP. Off values are spelled out; anything
    # else non-empty is on, which is what a debugging flag should do with `=yes` or `=please`.
    [OutputType([bool])]
    param([string]$Value = $env:YWR_SELFTEST_KEEP_FIXTURE)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    return ($Value.Trim() -notin @('0', 'false', 'no', 'off'))
}

function New-FixtureRoot {
    # Creates and returns "<Name>-$PID" under the system temp root. The PID suffix is what
    # keeps concurrent runs (CI matrix, or a local run while the ADR 0122 container runs the
    # same file) from sharing one tree and deleting each other's fixtures.
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$Name)
    $p = Join-Path ([IO.Path]::GetTempPath()) "$Name-$PID"
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    return $p
}

function Remove-FixtureRoot {
    # Deletes fixture paths, tolerating absence: the trap can fire before the tree exists,
    # and a teardown that threw would mask the real error with a second one. Takes several
    # paths so a caller with a fixture root AND a scratch file cleans both in one statement.
    #
    # YWR_SELFTEST_KEEP_FIXTURE=1 keeps the tree and says where it is (ADR 0126's follow-up,
    # opened because the trap deletes exactly the evidence a failing selftest would be debugged
    # from). It keeps on BOTH paths, pass and fail, stated plainly rather than named
    # "keep-on-failure": teardown has no verdict to consult — the common failure path is a case
    # that set $ok = $false and reached the unconditional call, not the trap — so a
    # failure-only switch would have to be threaded through every caller's exit path.
    # Off by default; the report line is deliberately not SKIP-prefixed, since the ADR 0127
    # router classifies on that word.
    param([string[]]$Path)
    foreach ($p in $Path) {
        if ([string]::IsNullOrWhiteSpace($p)) { continue }
        if (-not (Test-FixtureRootPath $p)) {
            # LOUD, not a silent skip: a refusal means that caller's fixture leaks on every
            # run, which is the defect this pair exists to remove. Checked BEFORE the keep
            # switch on purpose — a refusal reports a caller BUG, and a debugging flag must not
            # be able to turn that warning into a reassuring "kept" line.
            Write-Warning "Remove-FixtureRoot refused '$p': not inside $([IO.Path]::GetTempPath())"
            continue
        }
        if (Test-KeepFixture) {
            Write-Host "KEEP [fixture]: $p (YWR_SELFTEST_KEEP_FIXTURE set — remove it yourself)" -ForegroundColor Yellow
            continue
        }
        Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
    }
}
