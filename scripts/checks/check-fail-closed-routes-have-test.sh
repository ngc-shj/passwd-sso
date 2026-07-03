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

# Build allowlist (paths only, no comments, no blanks). bash 3.2 has no
# associative arrays (`declare -A`), so keep a newline-delimited list and
# test membership with `grep -qxF`.
DEBT_LIST=""
if [ -f "$DEBT_FILE" ]; then
  while IFS= read -r line; do
    # Strip CR (Windows line endings) and surrounding whitespace
    line="${line%$'\r'}"
    line="${line## }"; line="${line%% }"
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    DEBT_LIST="${DEBT_LIST}${line}
"
  done < "$DEBT_FILE"
fi

is_debt() {
  # exact whole-line match against the normalized debt list
  printf '%s' "$DEBT_LIST" | grep -qxF "$1"
}

# Enumerate opt-in routes. bash 3.2 has no `mapfile`; read into an indexed
# array with a while-loop.
fail=0
routes=()
while IFS= read -r route_line; do
  [ -n "$route_line" ] && routes+=("$route_line")
done < <(
  grep -rln 'failClosedOnRedisError: true' "$REPO_ROOT/src/app/api" 2>/dev/null \
    | sed "s|^$REPO_ROOT/||" \
    | sort
)

# Guard against an empty array under `set -u` (bash 3.2 errors on "${a[@]}"
# when the array is empty).
for route in ${routes[@]+"${routes[@]}"}; do
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
  if is_debt "$route"; then
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
# 58 incl. 4 from rate-limiter-fail-closed-and-get-purge (OWASP M4/M5/M6):
#   auth callbackRateLimiter + magicLinkIpLimiter, mobile autofill mintLimiter,
#   tenant breakglassRateLimiter. (v1ApiKeyLimiter lives in src/lib, not counted here.)
# 61 incl. 3 mint limiters from owasp-rereview-stepup-and-failclosed (OWASP M3):
#   tenant scim-tokens create, operator-tokens create, service-accounts create.
#   (The SCIM runtime limiter from that PR lives in src/lib/scim, not counted here.)
# 63 incl. the 2 admin-vault-reset trigger limiters (adminResetLimiter +
#   targetResetLimiter, tenant/members/[userId]/reset-vault) — destructive
#   privileged action, found by the rateLimited() audit during that PR.
# 69 incl. 6 maintenance limiters converted from fail-open + global key to
#   fail-closed + per-tenant key (purge-history, purge-audit-logs,
#   audit-outbox-metrics, audit-outbox-purge-failed, dcr-cleanup,
#   audit-chain-verify) — external-review hygiene: a Redis outage must not
#   shed the throttle on destructive/privileged maintenance ops.
EXPECTED_LIMITER_COUNT=69
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
