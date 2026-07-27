#!/bin/sh
# Single source for CI diff-range base resolution (ADR 0109) — replaces the five
# copy-pasted per-job blocks whose divergence broke the ADR 0072 advisory
# contract (2026-07-21 review med). Invoked by .github/actions/resolve-base
# (zero-logic adapter); everything arrives env-mapped — never template-expand
# workflow expressions into run: text (shell-injection surface, ADR 0108):
#   EVENT_NAME     github.event_name
#   BASE_REF       github.base_ref            (pull_request only)
#   EVENT_BEFORE   github.event.before        (push only; empty otherwise)
#   DISPATCH_BASE  github.event.inputs.base   (workflow_dispatch only, optional)
#   MODE           blocking (default) | advisory
#     blocking: a non-ancestor/unreachable explicit dispatch base hard-fails —
#       an explicit operator range is never silently degraded (ADR 0108).
#     advisory: the same bad base degrades with a warning and NEVER exits
#       non-zero (ADR 0072 contract — slice-retro only).
# Output: base=<sha> appended to $GITHUB_OUTPUT (set by the runner; the
# selftest provides a temp file). Selftest: resolve-base.selftest.ps1.
set -u

MODE="${MODE:-blocking}"
case "$MODE" in
blocking | advisory) ;;
*)
  # unknown MODE = config error, loud in EVERY mode — a typo'd `mode:` in ci.yml
  # would otherwise silently flip advisory back to blocking, the exact ADR 0072
  # regression this script exists to prevent (2026-07-21 review med)
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
  # Validated like every other branch (2026-07-21 review med): a failed
  # merge-base (missing origin ref / unrelated history) must never emit an
  # empty BASE silently — downstream that reads as ..HEAD (empty range,
  # advisory job passes vacuously) or a raw git fatal in the blocking jobs.
  if ! BASE=$(git merge-base "origin/${BASE_REF:-}" HEAD 2>/dev/null) || [ -z "$BASE" ]; then
    if [ "$MODE" = "advisory" ]; then
      degrade "PR merge-base against 'origin/${BASE_REF:-}' failed — degraded to the last commit (advisory job, never blocks; ADR 0072)"
    else
      echo "::error::cannot resolve PR merge-base against 'origin/${BASE_REF:-}' (missing ref or unrelated history)"
      exit 1
    fi
  fi
elif [ "${EVENT_NAME:-}" = "workflow_dispatch" ] && [ -n "${DISPATCH_BASE:-}" ]; then
  # explicit operator range (ADR 0108 re-fire). Ancestry required: existence
  # alone would accept a wrong-branch SHA and silently mis-scope the range.
  BASE="$DISPATCH_BASE"
  if ! git merge-base --is-ancestor "$BASE" HEAD 2>/dev/null; then
    if [ "$MODE" = "advisory" ]; then
      degrade "dispatch base non-ancestor/unreachable — degraded to the last commit (advisory job, never blocks; ADR 0072)"
    else
      echo "::error::dispatch base '$BASE' is not an ancestor of HEAD (or unreachable) — pass the last green main commit SHA"
      exit 1
    fi
  fi
else
  BASE="${EVENT_BEFORE:-}" # empty on dispatch-without-base — falls to the degrade path
  # ancestry, not existence (2026-07-21 review low; same rule as the dispatch
  # branch): a force-push's old tip can still exist as an object while not being
  # an ancestor of HEAD — existence alone would silently mis-scope the range.
  if ! git merge-base --is-ancestor "$BASE" HEAD 2>/dev/null; then
    # never truncate coverage silently (ADR 0074) — structural fix = branch protection
    degrade "range base unavailable (dispatch without base / force push) — degraded to the last commit; earlier commits are NOT gated"
  fi
fi

echo "base=$BASE" >>"$GITHUB_OUTPUT"
