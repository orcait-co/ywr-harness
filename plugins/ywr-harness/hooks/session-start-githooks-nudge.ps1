# SessionStart (registered WITHOUT a matcher, deliberately — the event DOES support one, on
# `source`; the unwired condition below is the filter) — git-hooks wiring nudge, suggest-only
# (ADR 0029).
#
# The gap this closes is temporal, not informational: ADR 0015's `hooks:` drift line prints at
# slice close and in CI, i.e. AFTER the work. This hook moves the same fact to the start of the
# session on the unwired machine — before the first commit that would have skipped the gates.
#
# Suggest-only is the contract, not a phase (ADR 0029): 0015 rejected a SessionStart hook that
# SETS core.hooksPath because of the mutation, and that objection does not reach a hook that only
# speaks. This hook writes nothing, ever — not git config, not files.
#
# Payload and output contract, verified against the official hooks reference 2026-08-05
# (code.claude.com/docs/en/hooks.md — read RAW; a summarized read of the same page reported the
# matcher as absent and the slice review's raw grep showed the opposite, the exact class
# REVIEW.md's raw-source rule exists for):
#   cwd    : working directory of this firing (one per firing; the event fires at startup and
#            AGAIN on resume/clear/compact/fork — not once per session)
#   source : startup | resume | clear | compact | fork — the event supports a matcher on this
#            field; this hook registers WITHOUT one on purpose: a wired clone is silent on
#            every source, and re-speaking after `compact` deliberately re-injects a fact
#            summaries lose. Filtering a source out later is a one-line hooks.json matcher,
#            not a script change.
# The runtime consumes BOTH `hookSpecificOutput.additionalContext` (joins the model's context)
# and `systemMessage` (shown to the user) for this event; plain stdout on exit 0 also becomes
# context, which is why every non-speaking path exits with EMPTY stdout. SessionStart cannot
# block anything; this hook does not try — exit 0 always, fail-open like its siblings.
#
# Decision table (ADR 0029): speak ONLY when the resolved work tree root carries `.githooks/`
# AND `core.hooksPath` is unset in this clone. A foreign value is silent BY DESIGN — that state
# is a decision (0015 refuses to clobber it for the same reason), and an unsilenceable
# per-session nag was judged worse than the residual drift, which the emitter still reports.
#
# Anti-vacuity (the directory-added-guard rule): a SessionStart payload with no `cwd` emits a
# SCHEMA-DRIFT banner listing the keys actually received, rather than failing open into silence —
# a guard that cannot report its own drift is indistinguishable from an absent guard.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
try { $payload = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { exit 0 }
if ([string]$payload.hook_event_name -ne 'SessionStart') { exit 0 }

$cwd = ([string]$payload.cwd).Trim()
if (-not $cwd) {
    $keys = '(none)'
    try { $k = @($payload.PSObject.Properties.Name | Sort-Object); if ($k) { $keys = $k -join ', ' } } catch { }
    $drift = "[hook:githooks-nudge] SCHEMA DRIFT — a SessionStart payload arrived with no 'cwd' field, so this hook could not check whether this clone's git hooks are wired. Keys received: $keys. Re-verify the payload shape and fix hooks/session-start-githooks-nudge.ps1 (ADR 0029)."
    @{ systemMessage = $drift } | ConvertTo-Json -Compress
    exit 0
}

# Join-Path/Test-Path raise NON-TERMINATING errors when a path names a root that does not exist
# on this platform (the 48c264c CI failure class), so every probe promotes to Stop and treats
# the catch as "not there".
function Test-Dir([string]$Path) {
    try {
        $ErrorActionPreference = 'Stop'
        return (Test-Path -LiteralPath $Path -PathType Container)
    }
    catch { return $false }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    # No git, no verdict — but `.githooks/` sitting at the cwd is a repo that EXPECTS hooks, so
    # unknown is reported rather than silently passed (the emitter's hooks_status posture).
    if (Test-Dir (Join-Path $cwd '.githooks')) {
        @{ systemMessage = '[hook:githooks-nudge] .githooks/ is present but git is not runnable here, so whether this clone has core.hooksPath wired is UNKNOWN, not verified.' } | ConvertTo-Json -Compress
    }
    exit 0
}

# Resolve the work tree root from cwd so a subdirectory session still finds the repo. A failed
# resolution (not a work tree, vanished cwd) is silent: no repo, no hooks story.
# NOT `| Select-Object -First 1`: -First stops the pipeline early, which leaves $LASTEXITCODE
# EMPTY (measured 2026-08-05, pwsh 7.6) — and $null -ne 0 made this guard eat every nudge.
$root = ''
try { $lines = @(& git -C $cwd rev-parse --show-toplevel 2>$null); if ($lines.Count) { $root = ([string]$lines[0]).Trim() } } catch { }
if ($LASTEXITCODE -ne 0 -or -not $root) { exit 0 }

if (-not (Test-Dir (Join-Path $root '.githooks'))) { exit 0 }

# `--local` on purpose: the per-clone value is the one that decides whether hooks run HERE, and
# it is the value ADR 0015's wiring table reasons about. Any non-empty value — wired or foreign —
# is silent (decision table above). Only a CLEAN unset verdict nudges: exit 1 is git's
# documented not-found code; any other outcome — a non-0/non-1 exit (unreadable config) or an
# empty value at exit 0 — is UNKNOWN, reported as such and never resolved into an actionable
# nudge (the no-git branch's posture; review 2026-08-05, low).
$cur = ''
$cfgExit = -1
try { $lines = @(& git -C $root config --local --get core.hooksPath 2>$null); $cfgExit = $LASTEXITCODE; if ($lines.Count) { $cur = ([string]$lines[0]).Trim() } } catch { }
if ($cur) { exit 0 }
if ($cfgExit -ne 1) {
    @{ systemMessage = "[hook:githooks-nudge] $root carries .githooks/ but this clone's core.hooksPath could not be read cleanly (git config exit $cfgExit, empty value) — wiring UNKNOWN, not verified." } | ConvertTo-Json -Compress
    exit 0
}

$cmd = 'git config core.hooksPath .githooks'
$sys = "[hook:githooks-nudge] $root carries .githooks/ but this clone's core.hooksPath is UNSET — no git hook runs here (pre-commit gates, pre-push secret scan). Wire it: $cmd — or re-run /ywr-harness:harness-init, which wires conditionally (ADR 0015). Nothing was changed; this hook only suggests (ADR 0029)."
$ctx = "The repo at $root ships .githooks/ (pre-commit gates, pre-push secret scan) but this clone's core.hooksPath is unset, so none of it runs locally; CI still gates the content, so the cost is feedback latency (ADR 0015). When the work turns commit-shaped, offer the user the wiring one-liner: $cmd. Do not run it unasked — this surface is suggest-only (ADR 0029)."
@{
    systemMessage      = $sys
    hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $ctx }
} | ConvertTo-Json -Compress
exit 0
