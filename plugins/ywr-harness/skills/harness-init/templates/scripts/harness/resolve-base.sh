#!/bin/sh
# Single source for CI diff-range base resolution (ywr-harness ADR 0043). One script replaces
# per-step inline range computations, whose failure modes read as "nothing changed".
# harness-init vendors it into a consuming repo as scripts/harness/resolve-base.sh. The ywr-harness
# manifest gate keeps the vendored copy byte-identical to the plugin's copy (ywr-harness ADR 0014).
# The CI step invokes it directly with every input mapped through env. Never template-expand workflow
# expressions into run: text, because that is a shell-injection surface:
#   EVENT_NAME     github.event_name
#   BASE_REF       github.base_ref            (pull_request only)
#   EVENT_BEFORE   github.event.before        (push only; empty otherwise)
#   DISPATCH_BASE  github.event.inputs.base   (workflow_dispatch only, optional)
#   MODE           blocking (default) | advisory
#     blocking: a non-ancestor or unreachable explicit dispatch base hard-fails.
#       An explicit operator range is never silently degraded.
#     advisory: the same bad base degrades with a warning and NEVER exits
#       non-zero (report-only jobs).
# Output: base=<sha> appended to $GITHUB_OUTPUT (the runner sets it).
set -u

MODE="${MODE:-blocking}"
case "$MODE" in
blocking | advisory) ;;
*)
  # An unknown MODE is a config error, loud in every mode. A typo in the workflow's `mode:`
  # would otherwise flip advisory to blocking silently, the divergence between jobs
  # this script exists to prevent.
  echo "::error::MODE must be 'blocking' or 'advisory' (got '$MODE')"
  exit 1
  ;;
esac

degrade() {
  BASE=$(git rev-parse HEAD~1 2>/dev/null || git hash-object -t tree /dev/null)
  echo "::warning::$1"
}

if [ "${EVENT_NAME:-}" = "pull_request" ]; then
  # HEAD is the PR merge commit, so the merge-base with the current base tip is the exact PR delta.
  # A failed merge-base (missing origin ref or unrelated history) must never emit an empty BASE:
  # downstream that reads as ..HEAD (an empty range, so an advisory job passes vacuously)
  # or as a raw git fatal in the blocking jobs.
  if ! BASE=$(git merge-base "origin/${BASE_REF:-}" HEAD 2>/dev/null) || [ -z "$BASE" ]; then
    if [ "$MODE" = "advisory" ]; then
      degrade "PR merge-base against 'origin/${BASE_REF:-}' failed — degraded to the last commit (advisory job, never blocks)"
    else
      echo "::error::cannot resolve PR merge-base against 'origin/${BASE_REF:-}' (missing ref or unrelated history)"
      exit 1
    fi
  fi
elif [ "${EVENT_NAME:-}" = "workflow_dispatch" ] && [ -n "${DISPATCH_BASE:-}" ]; then
  # An explicit operator range is the one branch whose input is free operator text
  # (github.event.inputs.base), so rev-parse canonicalizes it first. With --end-of-options it
  # peels the text to a 40-hex commit id or fails cleanly, so a leading '-' never parses as a
  # git option. The value in $GITHUB_OUTPUT, which downstream steps splice into range strings,
  # is then always an object id. Ancestry is still required: existence alone would accept a
  # wrong-branch SHA and silently mis-scope the range.
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
  BASE="${EVENT_BEFORE:-}" # empty on dispatch without a base, which takes the degrade path
  # Ancestry, not existence, as in the dispatch branch: a force-push's old tip can
  # still exist as an object without being an ancestor of HEAD.
  if ! git merge-base --is-ancestor "$BASE" HEAD 2>/dev/null; then
    # The warning keeps the coverage cut visible. The structural fix is branch protection.
    degrade "range base unavailable (dispatch without base / force push) — degraded to the last commit; earlier commits are NOT gated"
  fi
fi

echo "base=$BASE" >>"$GITHUB_OUTPUT"
