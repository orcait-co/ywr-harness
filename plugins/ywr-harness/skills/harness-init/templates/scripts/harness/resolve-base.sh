#!/bin/sh
# Single source for CI diff-range base resolution (ywr-harness ADR 0043). One script replaces
# per-step inline range computations, whose failure modes read as "nothing changed".
# Vendored into consuming repos as scripts/harness/resolve-base.sh; the canon's manifest-gate.mjs
# enforces byte identity with the plugin's copy (ywr-harness ADR 0014).
# The CI step invokes it directly with everything env-mapped — never template-expand workflow
# expressions into run: text (shell-injection surface):
#   EVENT_NAME     github.event_name
#   BASE_REF       github.base_ref            (pull_request only)
#   EVENT_BEFORE   github.event.before        (push only; empty otherwise)
#   DISPATCH_BASE  github.event.inputs.base   (workflow_dispatch only, optional)
#   MODE           blocking (default) | advisory
#     blocking: a non-ancestor/unreachable explicit dispatch base hard-fails —
#       an explicit operator range is never silently degraded.
#     advisory: the same bad base degrades with a warning and NEVER exits
#       non-zero (report-only jobs).
# Output: base=<sha> appended to $GITHUB_OUTPUT (set by the runner; the
# selftest provides a temp file). Selftest: resolve-base.selftest.ps1.
set -u

MODE="${MODE:-blocking}"
case "$MODE" in
blocking | advisory) ;;
*)
  # unknown MODE = config error, loud in EVERY mode — a typo'd `mode:` in the workflow
  # would otherwise silently flip advisory back to blocking, the divergence between jobs
  # this script exists to prevent
  echo "::error::MODE must be 'blocking' or 'advisory' (got '$MODE')"
  exit 1
  ;;
esac

degrade() {
  BASE=$(git rev-parse HEAD~1 2>/dev/null || git hash-object -t tree /dev/null)
  echo "::warning::$1"
}

if [ "${EVENT_NAME:-}" = "pull_request" ]; then
  # HEAD = PR merge commit -> merge-base with current base tip = exact PR delta.
  # Validated like every other branch: a failed merge-base (missing origin ref / unrelated
  # history) must never emit an empty BASE silently — downstream that reads as ..HEAD (empty
  # range, advisory job passes vacuously) or a raw git fatal in the blocking jobs.
  if ! BASE=$(git merge-base "origin/${BASE_REF:-}" HEAD 2>/dev/null) || [ -z "$BASE" ]; then
    if [ "$MODE" = "advisory" ]; then
      degrade "PR merge-base against 'origin/${BASE_REF:-}' failed — degraded to the last commit (advisory job, never blocks)"
    else
      echo "::error::cannot resolve PR merge-base against 'origin/${BASE_REF:-}' (missing ref or unrelated history)"
      exit 1
    fi
  fi
elif [ "${EVENT_NAME:-}" = "workflow_dispatch" ] && [ -n "${DISPATCH_BASE:-}" ]; then
  # explicit operator range — the ONE branch whose input is free operator text
  # (github.event.inputs.base), so it is CANONICALIZED before anything else consumes it:
  # rev-parse with --end-of-options peels it to a 40-hex commit
  # id or fails cleanly, so a leading '-' can never be parsed as a git option here, and the
  # value written to $GITHUB_OUTPUT — which downstream steps splice into range strings — is
  # provably an object id, never operator-supplied text. Ancestry is still required on top:
  # existence alone would accept a wrong-branch SHA and silently mis-scope the range.
  if BASE=$(git rev-parse --verify --quiet --end-of-options "${DISPATCH_BASE}^{commit}" 2>/dev/null) \
    && [ -n "$BASE" ] && git merge-base --is-ancestor "$BASE" HEAD 2>/dev/null; then
    : # BASE is a canonical 40-hex ancestor commit id
  elif [ "$MODE" = "advisory" ]; then
    degrade "dispatch base non-ancestor/unreachable — degraded to the last commit (advisory job, never blocks)"
  else
    echo "::error::dispatch base is not an ancestor of HEAD (or unreachable / not a commit) — pass the last green main commit SHA"
    exit 1
  fi
else
  BASE="${EVENT_BEFORE:-}" # empty on dispatch-without-base — falls to the degrade path
  # ancestry, not existence (same rule as the dispatch branch): a force-push's old tip can
  # still exist as an object while not being an ancestor of HEAD — existence alone would
  # silently mis-scope the range.
  if ! git merge-base --is-ancestor "$BASE" HEAD 2>/dev/null; then
    # never truncate coverage silently — structural fix = branch protection
    degrade "range base unavailable (dispatch without base / force push) — degraded to the last commit; earlier commits are NOT gated"
  fi
fi

echo "base=$BASE" >>"$GITHUB_OUTPUT"
