# Shared selftest core. Six things live here, added in the order the duplication justified
# them: the empty-MustNotMatch guard with the match loops it protects, the
# fixture lifecycle, — on their third copy / first measured failure — the boolean
# `Assert-True` verdict and the child-output decoding pin, the in-process script
# runner that replaced the per-case child pwsh in the spawn-bound suites (ADR 0071 option E),
# and the git worker-binary bypass (ADR 0111).
#
# The guard half is the single owner of the empty-MustNotMatch rule.
#
# Before this file the guard was copy-pasted into standalone helpers, and the copies
# were miscounted while being counted: an early count said four (a claim scoped to
# .claude/hooks/ without saying so), a later one said five, then six. The real
# number was SEVEN — one slice added two copies (harness-scope and
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
# identical apart from a contract divergence that failed open.
#
# The MustMatch/MustNotMatch DISCIPLINE is still not in scope for helpers with no such pair —
# hooks/subagent-telemetry.selftest.ps1 (Pass/Fail calls), scripts/ci-local and
# scripts/ci/resolve-base (Assert-True over booleans), and
# scripts/ci/harness-pins.selftest.ps1, which is MustMatch-only ON PURPOSE and says so
# in its own comment. Folding those in would mean inventing negatives for assertions
# that do not have any. They dot-source this file regardless — subagent-telemetry and
# harness-pins for the FIXTURE half, ci-local and resolve-base for Assert-True and the
# decoding pin. Sharing a helper is not the same as adopting the
# discipline, and the two are deliberately independent.
#
# scripts/ci/selftest-lib.selftest.ps1 keeps its OWN boolean assert (Assert-Bootstrap) rather
# than calling the shared one: it is testing this file, and an assertion helper that asserts
# itself passes vacuously when it breaks. Same reason its cases compare exact failure arrays
# instead of using the guard they exercise.

Set-StrictMode -Off

# --- child-output decoding pin ------------------------------------
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

# --- git worker binary (ADR 0111) -----------------------------------------------------------------
# On Windows the PATH `git` is Git for Windows' cmd\git.exe LAUNCHER: it spawns mingw64\bin\git.exe and
# waits, so every git call costs two processes. harness_gates.selftest measured it first (2026-09-02,
# `status` x10: 68 ms via the launcher, 49 ms direct; the 2026-09-29 profile re-measured rev-parse
# 97 vs 56 ms and status 115 vs 62 ms), and the copy of its guard had spread to release.selftest
# by the time three more git-bound suites (retro, init, manifest-gate) were worth adopting it. The
# worker binary is what the launcher would have run: both print the same `--exec-path` and read the
# same `--system` gitconfig (checked 2026-09-02) — only the hop is gone.
#   Get-GitWorkerDir     PURE (no PATH change): the directory holding the worker, or '' — non-Windows,
#                        a `git` that is not <root>\cmd\git.exe, or a root without mingw64\bin\git.exe.
#                        Guarded on the exact layout; any other shape leaves PATH alone.
#   Use-GitWorkerBinary  prepends that directory to $env:PATH and returns the PATH it replaced, or
#                        $null when nothing changed. A suite that must not leak the change past its own
#                        end restores with `if ($null -ne $before) { $env:PATH = $before }`; under
#                        `pwsh -File` (every runner's shape) the process ends and the PATH dies with it.
# NOT for a suite whose subject is a narrowed PATH (feedback.selftest builds its own on purpose) or
# whose subject is the launcher itself.
function Get-GitWorkerDir {
    [OutputType([string])]
    param([string]$GitPath)
    if (-not $IsWindows -or [string]::IsNullOrWhiteSpace($GitPath)) { return '' }
    if ((Split-Path -Leaf (Split-Path -Parent $GitPath)) -ne 'cmd') { return '' }
    $dir = Join-Path (Split-Path -Parent (Split-Path -Parent $GitPath)) 'mingw64\bin'
    if (Test-Path -LiteralPath (Join-Path $dir 'git.exe') -PathType Leaf) { return $dir }
    return ''
}
function Use-GitWorkerBinary {
    param()
    $dir = Get-GitWorkerDir ((Get-Command git -ErrorAction SilentlyContinue).Source)
    if (-not $dir) { return $null }
    $before = $env:PATH
    $env:PATH = $dir + [IO.Path]::PathSeparator + $before
    return $before
}

# --- in-process script runner (ADR 0071 option E, 2026-09-02) ------------------------------------
# Runs a .ps1 by path in a NEW RUNSPACE of this process: no pwsh cold start (~0.8 s on Windows, paid
# once per case by the spawn-bound suites), and the isolation a child process had — default
# preference variables (a caller's `$ErrorActionPreference = 'Stop'` never leaks in), a fresh
# $LASTEXITCODE, no dynamic-scope resolution into the caller's variables.
#
# `& <path>` in the CALLER's runspace was the first shape and was measured and rejected the same
# day (review of the manifest-gate suite): any try/catch or trap around it turns the callee's
# STATEMENT-terminating errors — CommandNotFound, parameter binding — into an abort of the whole
# callee, where a child prints the error and runs on; without a handler a `throw` in the callee
# tears down the suite; and the callee inherits the caller's preferences. A runspace has none of
# these and costs ~50–120 ms per call on the owner's box.
#
# Contract:
#   Code    — what `pwsh -File <script>` would have returned, measured row by row against a real
#             child (2026-09-02): `exit N` → N; completing without `exit` → 0, INCLUDING when the
#             script's last native command failed (a child says 0 there; the runspace's
#             $LASTEXITCODE would say 128) and when its last statement wrote a non-terminating error.
#             The observable that tells these apart is `$?` right after the invocation: $true means
#             the script completed (0), $false with a $LASTEXITCODE means it exited non-zero (N).
#   Aborted — $true with Code -1 when the script never ran or did not finish: file missing, the
#             invocation itself refused (a parameter-binding failure against a [CmdletBinding()]
#             script — `$?` $false, no $LASTEXITCODE, the error in the runspace's own stream), or a
#             script-terminating error (`throw`, or a non-terminating error under the script's OWN
#             'Stop'). A child said 1 for all of these; -1 is a value no `exit` produces, so a
#             negative suite whose PASS is "exit 1" can never record an abort as a catch.
#   Out     — every stream the script wrote, in order (SIX streams, where a child's console capture
#             saw stdout+stderr — pin a callee to Write-Host when a `-notmatch` depends on it), then
#             the runspace's own error records (raised outside the callee's redirect: binding).
# Caution, not reproduced: a script whose LAST statement fails non-terminatingly after an earlier
# failing native command, with no `exit`, was expected to report that command's code where a child
# says 0 — in measurement `$?` came back $true across the script boundary for every non-terminating
# failure and Code was 0, matching the child. The scripts run here end in an explicit `exit` anyway;
# their suites pin that, so the verdict never depends on this edge.
# NOT a child in one respect: `[Environment]::Exit()` / `$host.SetShouldExit()` inside the script
# ends THIS process — a child confined them. The suites pin that their scripts call neither.
# Arguments splat as a HASHTABLE — an array splat binds positionally ('-Target' would become the
# target). Long lines are not wrapped (measured: 300-char Write-Host and Write-Output survive).
function Invoke-ScriptInRunspace([string]$Path, [hashtable]$Arguments = @{}) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @{ Out = "script not found: $Path"; Code = -1; Aborted = $true }
    }
    $ps = $null
    try {
        $ps = [PowerShell]::Create()
        # `$?` is read on the very next statement — a pipeline stage after `&` (Out-String) would
        # report ITS success, so the string is built afterwards.
        [void]$ps.AddScript('param($p, $a) $o = & $p @a *>&1; $q = $?; [pscustomobject]@{ Out = ($o | Out-String); Ok = $q; Code = $LASTEXITCODE }').AddArgument($Path).AddArgument($Arguments)
        $res = @($ps.Invoke())
        $err = ($ps.Streams.Error | Out-String)
        $r = $res[-1]
        if ($null -eq $r -or $null -eq $r.PSObject.Properties['Ok']) {
            return @{ Out = "runner produced no result`n$err"; Code = -1; Aborted = $true }
        }
        $out = [string]$r.Out + $err
        if ($r.Ok) { return @{ Out = $out; Code = 0; Aborted = $false } }
        if ($null -ne $r.Code) { return @{ Out = $out; Code = [int]$r.Code; Aborted = $false } }
        if ($ps.Streams.Error.Count) { return @{ Out = $out; Code = -1; Aborted = $true } }
        return @{ Out = $out; Code = 0; Aborted = $false }   # ended on a non-terminating error record, no `exit`
    } catch {
        $err = if ($ps) { ($ps.Streams.Error | Out-String) } else { '' }
        return @{ Out = (($_ | Out-String) + $err); Code = -1; Aborted = $true }
    } finally { if ($ps) { $ps.Dispose() } }
}

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
    # The empty-MustNotMatch CLASS: a case that disallows nothing asserts presence
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
        $fails += 'no MustNotMatch and no -NoNegative reason (empty-MustNotMatch class)'
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
    # match. Folded in on its third copy — and the copies had DIVERGED under one
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

# --- node dependency and Inline() parity (ADR 0116) ---------------------------------------------
# The Node hooks (hooks/*.mjs) and the suites that exercise them need `node`. The pwsh Linux image
# ships WITHOUT node, so a hard failure there would report Linux breakage that does not exist; CI's
# ubuntu runner has node, so absence THERE means the gate stopped running and must be loud. Local
# absence is a reported skip, never a silent one. `$env:CI`, like every sibling suite: GitHub Actions
# sets it and so does any other runner a consumer's CI uses.
function Resolve-NodeVerdict([bool]$NodePresent, [bool]$OnCi) {
    if ($NodePresent) { return @{ Verdict = 'run'; Message = '' } }
    if ($OnCi) { return @{ Verdict = 'fail'; Message = 'node absent on CI — a missing interpreter is not a pass' } }
    return @{ Verdict = 'skip'; Message = 'node absent (reported, not silent) — CI ubuntu runs this suite; the pwsh Linux image has no node' }
}

# The node-dependent suite's opening move: returns $true when the suite may run. A skip prints its
# reason and exits 0 (the runner counts a SKIP line); a CI absence is a FAIL and exits 1.
function Assert-NodeOrExit([string]$Suite) {
    $v = Resolve-NodeVerdict ([bool](Get-Command node -ErrorAction SilentlyContinue)) ([bool]$env:CI)
    if ($v.Verdict -eq 'fail') { Write-Host "FAIL [node]: $($v.Message)" -ForegroundColor Red; exit 1 }
    if ($v.Verdict -eq 'skip') { Write-Host "SKIP [$Suite]: $($v.Message)" -ForegroundColor Yellow; exit 0 }
}

# Inline() is ONE character class in two implementations: hooks/hook-lib.mjs's inline() (every Node
# hook imports it) and the `function Inline` the one remaining pwsh hook, session-start-node-check.ps1,
# carries. Before the Node port the pwsh suites compared their text byte-for-byte with
# agent-model-warn.ps1's; that reference is now
# JavaScript, so the guarantee is BEHAVIOURAL: the pwsh function, extracted from the hook's own
# source and run in-process, and the Node function must return the same code units for every probe
# — each member of the class (C0, DEL, NEL, LS, PS, backtick) and its neighbours (U+0080-0084,
# U+0086-00A0, U+2027, U+202A-202F, ...) alone, between letters and at either edge, the .NET-vs-JS
# whitespace differences (U+FEFF, U+180E, U+3000), and the cap's boundary (79/80/81 chars, a
# surrogate pair straddling the cut, a second Max). A divergence in either implementation turns the
# caller's suite red, because it compares its own copy against the one Node module; hook-lib.selftest
# pins inline() on its own, and each Node hook's suite asserts it imports inline() and defines none.
function Assert-InlineParity {
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$HookPath
    )
    $v = Resolve-NodeVerdict ([bool](Get-Command node -ErrorAction SilentlyContinue)) ([bool]$env:CI)
    if ($v.Verdict -eq 'fail') { return (Assert-True -Name $Name -Condition $false -Detail $v.Message) }
    if ($v.Verdict -eq 'skip') { Write-Host "SKIP [$Name]: $($v.Message)" -ForegroundColor Yellow; return $true }

    $hookLib = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../hooks/hook-lib.mjs'))
    $src = [IO.File]::ReadAllText($HookPath) -replace "`r`n", "`n"
    $fn = [regex]::Match($src, '(?ms)^function Inline\(.*?^\}').Value
    if (-not $fn) { return (Assert-True -Name $Name -Condition $false -Detail "no 'function Inline' in $HookPath") }

    $A = 0x41; $B = 0x42
    $units = @(0..0xA0) + @(0x1680, 0x180E) + @(0x2000..0x200F) + @(0x2027..0x202F) + @(0x205F, 0x2060, 0x3000, 0xFEFF, 0xFFFE)
    $probes = [Collections.Generic.List[object]]::new()
    foreach ($u in $units) {
        foreach ($c in @(@($A, $u, $B), @($u, $A), @($A, $u), @($u), @($u, $u, $A, $u, $u))) {
            $probes.Add(@{ c = [int[]]$c; m = $null })
        }
    }
    foreach ($len in 78..82) { $probes.Add(@{ c = [int[]](@($A) * $len); m = 80 }) }
    foreach ($k in 0..3) {
        # a flattened char, then a surrogate pair, whose first unit lands before / on / after the cut
        $probes.Add(@{ c = [int[]](@($A) * (77 + $k) + @(0x2028) + @($A) * 5); m = 80 })
        $probes.Add(@{ c = [int[]](@($A) * (77 + $k) + @(0xD83D, 0xDE00) + @($A) * 5); m = 80 })
    }
    $probes.Add(@{ c = [int[]](@(0x20) * 5 + @($A) * 400); m = 300 })
    $probes.Add(@{ c = [int[]](@($A) * 299 + @(0x20, 0x20, $B)); m = 300 })
    $probes.Add(@{ c = [int[]](@($A) * 400); m = $null })
    $probes.Add(@{ c = [int[]]@(); m = $null })

    $runner = [scriptblock]::Create($fn + @'

foreach ($p in $args[0]) {
    $s = -join ($p.c | ForEach-Object { [char]$_ })
    $r = if ($null -eq $p.m) { Inline $s } else { Inline $s $p.m }
    [string]::Join(',', [int[]][char[]]$r)
}
'@)
    $got = @(& $runner $probes)

    $js = @'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const lib = await import(pathToFileURL(process.argv[2]).href)
const probes = JSON.parse(fs.readFileSync(0, 'utf8'))
const out = probes.map(p => {
  const s = String.fromCharCode(...p.c)
  const r = p.m === null ? lib.inline(s) : lib.inline(s, p.m)
  return Array.from({ length: r.length }, (_, i) => r.charCodeAt(i)).join(',')
})
process.stdout.write(JSON.stringify(out))
'@
    $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), "inline-parity-$PID-$([guid]::NewGuid().ToString('N')).mjs")
    $errTmp = "$tmp.err"
    try {
        [IO.File]::WriteAllText($tmp, $js, [Text.UTF8Encoding]::new($false))
        $json = ($probes | ForEach-Object { @{ c = @($_.c); m = $_.m } } | ConvertTo-Json -Compress -Depth 5)
        if ($probes.Count -eq 1) { $json = "[$json]" }
        # stdout alone is parsed as JSON; stderr goes to its own file, so a node warning cannot corrupt it
        $raw = ($json | & node $tmp $hookLib 2>$errTmp | Out-String)
        $nodeExit = $LASTEXITCODE
        $nodeErr = if (Test-Path -LiteralPath $errTmp) { [IO.File]::ReadAllText($errTmp) } else { '' }
    }
    finally { Remove-Item -LiteralPath $tmp, $errTmp -Force -ErrorAction SilentlyContinue }
    if ($nodeExit -ne 0) { return (Assert-True -Name $Name -Condition $false -Detail "node exit ${nodeExit}: $raw $nodeErr") }
    try { $want = @($raw | ConvertFrom-Json) } catch { return (Assert-True -Name $Name -Condition $false -Detail "node stdout is not JSON: $raw $nodeErr") }

    $fails = @()
    if ($got.Count -ne $probes.Count -or $want.Count -ne $probes.Count) {
        $fails += "probe count: $($probes.Count) sent, $($got.Count) from pwsh Inline, $($want.Count) from hook-lib inline"
    }
    else {
        for ($i = 0; $i -lt $probes.Count -and $fails.Count -lt 3; $i++) {
            if ($got[$i] -cne $want[$i]) {
                $fails += "probe [$(($probes[$i].c | ForEach-Object { '{0:X4}' -f $_ }) -join ' ')] max=$($probes[$i].m): pwsh Inline -> [$($got[$i])], hook-lib inline -> [$($want[$i])]"
            }
        }
    }
    if ($fails.Count -and $nodeErr) { $fails += "node stderr: $nodeErr" }   # shown on failure only: a warning alone is not a divergence
    return (Assert-True -Name $Name -Condition (-not $fails.Count) -Detail ($fails -join ' | '))
}

# --- fixture lifecycle --------------------------------------------------------
# The second thing this core owns. Every selftest needing a scratch tree built the path by
# hand (GetTempPath + "<name>-$PID") and then placed its `Remove-Item -Recurse` as the LAST
# UNCONDITIONAL statement, so with $ErrorActionPreference = 'Stop' a terminating error
# mid-run leaked a PID-suffixed %TEMP% tree permanently. TEN selftests carried a temp fixture
# before this slice (`git grep -l GetTempPath HEAD -- '*.selftest.ps1'`, uncapped) and EIGHT had
# that shape — not the six the backlog recorded, because harness-pins and subagent-telemetry do
# not use the assertion core and so went unread when the leaking files were counted. Same
# off-by-N as the guard-count correction, one surface over. The other two were already
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
    # keeps concurrent runs (CI matrix, or a local run while the Linux container runs the
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
    # YWR_SELFTEST_KEEP_FIXTURE=1 keeps the tree and says where it is (a follow-up,
    # opened because the trap deletes exactly the evidence a failing selftest would be debugged
    # from). It keeps on BOTH paths, pass and fail, stated plainly rather than named
    # "keep-on-failure": teardown has no verdict to consult — the common failure path is a case
    # that set $ok = $false and reached the unconditional call, not the trap — so a
    # failure-only switch would have to be threaded through every caller's exit path.
    # Off by default; the report line is deliberately not SKIP-prefixed, since the runner
    # classifies on that word.
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
