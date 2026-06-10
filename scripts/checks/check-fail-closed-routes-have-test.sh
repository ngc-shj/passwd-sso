#!/usr/bin/env bash
# AC4.3 — CI gate: every route file containing `failClosedOnRedisError: true`
# MUST have either a sibling test referencing `redisErrored` OR an entry in
# the debt allowlist at scripts/checks/fail-closed-test-debt.txt.
#
# Background (plan rate-limit-fail-closed-on-redis, AC4.3):
# 46 routes / 50 limiters were opted into `failClosedOnRedisError: true` in
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

# AC4.4 / AC4.5 — limiter / branch count parity. Plan locks 50 limiter
# instantiations (46 from rate-limit-fail-closed-on-redis-plan + 4 new for
# A04-4 master-key rotation dual-approval: initiate/approve/execute/revoke,
# each with its own per-actor limiter).
# A future PR that silently drops a limiter from one of the multi-limiter
# files would leave the file-count gate above passing but break the
# per-limiter coverage. Per-line grep guards against this.
# 53 incl. the SSH agent sign-authorize limiter (vault/ssh/sign-authorize).
# 54 incl. the iOS bridge-code limiter (mobile/authorize, per-user fail-closed).
EXPECTED_LIMITER_COUNT=54
limiter_count=$(grep -rh 'failClosedOnRedisError: true' "$REPO_ROOT/src/app/api" | wc -l)
if [ "$limiter_count" -ne "$EXPECTED_LIMITER_COUNT" ]; then
  echo "AC4.4 FAIL: expected $EXPECTED_LIMITER_COUNT 'failClosedOnRedisError: true' instantiations; found $limiter_count"
  echo "If you intentionally added/removed an opt-in limiter, update EXPECTED_LIMITER_COUNT in this script AND the plan's C4 table."
  exit 1
fi

# AC4.5 — at least one `checkRateLimitOrFail` callsite per limiter. The two
# routes with the same limiter checked at multiple sites (tenant/access-requests,
# mcp/token) push the callsite count above the limiter count; that's the
# documented deviation. After the helper migration the raw `.redisErrored`
# branches no longer appear in route handlers — the inline check is hidden
# behind `checkRateLimitOrFail()` so we gate on the helper callsite count.
EXPECTED_MIN_CALLSITE_COUNT=50
callsite_count=$(grep -rh 'checkRateLimitOrFail(' "$REPO_ROOT/src/app/api" | wc -l)
if [ "$callsite_count" -lt "$EXPECTED_MIN_CALLSITE_COUNT" ]; then
  echo "AC4.5 FAIL: expected at least $EXPECTED_MIN_CALLSITE_COUNT 'checkRateLimitOrFail(' callsites; found $callsite_count"
  exit 1
fi

exit 0
