#!/usr/bin/env bash
# AC4.3 — CI gate: every route file containing `failClosedOnRedisError: true`
# MUST have either a sibling test referencing `redisErrored` OR an entry in
# the debt allowlist at scripts/checks/fail-closed-test-debt.txt.
#
# Background (plan rate-limit-fail-closed-on-redis, AC4.3):
# 42 routes / 46 limiters were opted into `failClosedOnRedisError: true` in
# the initial PR. Per-route fail-closed tests are tracked as test debt;
# this gate prevents NEW opt-in routes from landing without a test.
#
# Path-derivation rule (matches this codebase's convention — adjacent
# route.test.ts):
#   route_path: src/app/api/<X>/route.ts
#   test_path:  src/app/api/<X>/route.test.ts
#
# Alternative test path (legacy / __tests__ tree):
#   src/__tests__/api/<X>.test.ts
#
# Pass criteria:
#   (a) sibling test exists AND contains literal token `redisErrored`, OR
#   (b) route file path appears in fail-closed-test-debt.txt (one path
#       per line, leading `#` lines are comments).
#
# Fail: exits 1 with one MISSING_FAIL_CLOSED_TEST line per offending route.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
DEBT_FILE="$REPO_ROOT/scripts/checks/fail-closed-test-debt.txt"

# Build allowlist set (paths only, no comments, no blanks)
declare -A DEBT
if [ -f "$DEBT_FILE" ]; then
  while IFS= read -r line; do
    # Strip CR (Windows line endings) and surrounding whitespace
    line="${line%$'\r'}"
    line="${line## }"; line="${line%% }"
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    DEBT["$line"]=1
  done < "$DEBT_FILE"
fi

# Enumerate opt-in routes
fail=0
mapfile -t routes < <(
  grep -rln 'failClosedOnRedisError: true' "$REPO_ROOT/src/app/api" 2>/dev/null \
    | sed "s|^$REPO_ROOT/||" \
    | sort
)

for route in "${routes[@]}"; do
  # Adjacent test path
  dir="$(dirname "$route")"
  adjacent_test="$dir/route.test.ts"

  # Alternative test path (__tests__ tree)
  rel_path="${route#src/app/api/}"   # X/route.ts
  rel_no_route="${rel_path%/route.ts}" # X
  alt_test="src/__tests__/api/${rel_no_route}.test.ts"

  if grep -q "redisErrored" "$REPO_ROOT/$adjacent_test" 2>/dev/null; then
    continue # has fail-closed test
  fi
  if grep -q "redisErrored" "$REPO_ROOT/$alt_test" 2>/dev/null; then
    continue
  fi
  if [ -n "${DEBT[$route]:-}" ]; then
    continue # documented debt
  fi

  echo "MISSING_FAIL_CLOSED_TEST: $route (expected: $adjacent_test OR $alt_test OR $DEBT_FILE entry)"
  fail=1
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "Add a fail-closed test case OR add the route to scripts/checks/fail-closed-test-debt.txt."
  echo "See docs/archive/review/rate-limit-fail-closed-on-redis-plan.md AC4.3."
  exit 1
fi

exit 0
