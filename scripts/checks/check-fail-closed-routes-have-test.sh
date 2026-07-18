#!/usr/bin/env bash
# AC4.3 — CI gate: every route file containing `failClosedOnRedisError: true`
# MUST be covered by exactly one of three modes:
#
#   helper mode  — sibling test imports the shared contract helper
#                  (@/__tests__/helpers/fail-closed) AND calls
#                  `assertRedisFailClosed(` AND does NOT stub the production
#                  `checkRateLimitOrFail` mapping. This is the target state.
#   legacy mode  — route listed in fail-closed-legacy-direct.txt: a direct
#                  (pre-helper) test asserts the 503 behavior; the sibling
#                  test must still contain the literal `redisErrored`.
#                  Migration to helper mode removes the entry (atomic).
#   debt mode    — route listed in fail-closed-test-debt.txt: no adequate
#                  test yet; tracked for a future tranche.
#
# History: the original pass criterion was a bare `grep -q "redisErrored"`
# over the sibling test. External review of PR #680 demonstrated this is
# false-green-able (a comment, a describe label, or a mapping-stubbed test
# all satisfied it — extension/bridge-code was already misclassified as
# tested). The mode model above replaces it; the self-test pins the
# false-green shapes as red fixtures.
#
# Anti-drift rules (each is a distinct failure token, self-tested):
#   MAPPING_MOCKED_CONTRACT_TEST — helper call present but the test stubs
#     @/lib/security/rate-limit-audit / checkRateLimitOrFail (RT5 violation).
#   STALE_DEBT_ENTRY   — helper-mode test exists but the debt entry remains.
#   STALE_LEGACY_ENTRY — helper-mode test exists but the legacy entry remains.
#   LEGACY_DEBT_CONFLICT — route listed in BOTH legacy and debt files.
#   LEGACY_TEST_MISSING — legacy entry whose sibling test lost `redisErrored`.
#   DANGLING_ENTRY — debt/legacy entry whose route no longer opts in
#     (flag removal must be a visible manifest diff, parent-plan M2).
#   MISSING_FAIL_CLOSED_TEST — no mode covers the route.
#
# Path-derivation rule (adjacent route.test.ts):
#   route_path: src/app/api/<X>/route.ts
#   test_path:  src/app/api/<X>/route.test.ts
# Alternative test path (legacy / __tests__ tree):
#   src/__tests__/api/<X>.test.ts

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# FIXTURE_ROOT is a SINGLE override covering ALL inputs (route-scan root,
# debt file, legacy file) so the self-test can never mix fixture routes with
# the real repo's manifests or vice versa (test-F10, multi-input gate).
FIXTURE_ROOT="${FAIL_CLOSED_TEST_ROOT:-$REPO_ROOT}"
DEBT_FILE="${FAIL_CLOSED_TEST_DEBT_FILE:-$FIXTURE_ROOT/scripts/checks/fail-closed-test-debt.txt}"
LEGACY_FILE="${FAIL_CLOSED_TEST_LEGACY_FILE:-$FIXTURE_ROOT/scripts/checks/fail-closed-legacy-direct.txt}"

# CI-auditable: print effective scan paths on one line.
echo "check-fail-closed-routes-have-test: FIXTURE_ROOT=$FIXTURE_ROOT DEBT_FILE=$DEBT_FILE LEGACY_FILE=$LEGACY_FILE"

# sec-F6: env-pollution guard. Any override + CI=true requires an explicit
# fixture-mode acknowledgement, so a stray `export` leaking into a real CI
# run cannot silently point the gate at an empty fixture dir and green it.
if [ "${CI:-}" = "true" ]; then
  if [ -n "${FAIL_CLOSED_TEST_ROOT:-}" ] || [ -n "${FAIL_CLOSED_TEST_DEBT_FILE:-}" ] || [ -n "${FAIL_CLOSED_TEST_LEGACY_FILE:-}" ]; then
    if [ "${FAIL_CLOSED_TEST_FIXTURE_MODE:-}" != "1" ]; then
      echo "ENV_POLLUTION_GUARD: FAIL_CLOSED_TEST_* override set under CI=true without FAIL_CLOSED_TEST_FIXTURE_MODE=1 — refusing to run against a possibly-unintended path."
      exit 1
    fi
  fi
fi

# Read a manifest file into a newline-delimited list (paths only, no
# comments, no blanks). bash 3.2 has no associative arrays; membership is
# tested with `grep -qxF`.
read_manifest() {
  local file="$1" out="" line
  if [ -f "$file" ]; then
    while IFS= read -r line; do
      line="${line%$'\r'}"
      line="${line## }"; line="${line%% }"
      [ -z "$line" ] && continue
      case "$line" in \#*) continue ;; esac
      out="${out}${line}
"
    done < "$file"
  fi
  printf '%s' "$out"
}

DEBT_LIST="$(read_manifest "$DEBT_FILE")"
LEGACY_LIST="$(read_manifest "$LEGACY_FILE")"

is_debt()   { printf '%s' "$DEBT_LIST"   | grep -qxF "$1"; }
is_legacy() { printf '%s' "$LEGACY_LIST" | grep -qxF "$1"; }

# Production-mapping stub patterns (RT5 anti-pattern; roadmap R2-6/R3-1).
MAPPING_MOCK_RE='vi\.mock\("@/lib/security/rate-limit-audit"|checkRateLimitOrFail:[[:space:]]*vi\.fn|mockCheckRateLimitOrFail'

has_helper_call() { [ -f "$1" ] && grep -q 'assertRedisFailClosed(' "$1"; }
has_helper_import() { [ -f "$1" ] && grep -q '@/__tests__/helpers/fail-closed' "$1"; }
has_mapping_mock() { [ -f "$1" ] && grep -qE "$MAPPING_MOCK_RE" "$1"; }
has_redis_errored() { [ -f "$1" ] && grep -q 'redisErrored' "$1"; }

# Enumerate opt-in routes. bash 3.2 has no `mapfile`.
fail=0
routes=()
while IFS= read -r route_line; do
  [ -n "$route_line" ] && routes+=("$route_line")
done < <(
  grep -rln 'failClosedOnRedisError: true' "$FIXTURE_ROOT/src/app/api" 2>/dev/null \
    | sed "s|^$FIXTURE_ROOT/||" \
    | sort
)

ROUTE_LIST=""
for route in ${routes[@]+"${routes[@]}"}; do
  ROUTE_LIST="${ROUTE_LIST}${route}
"
done

for route in ${routes[@]+"${routes[@]}"}; do
  dir="$(dirname "$route")"
  adjacent_test="$FIXTURE_ROOT/$dir/route.test.ts"
  rel_path="${route#src/app/api/}"        # X/route.ts
  rel_no_route="${rel_path%/route.ts}"    # X
  alt_test="$FIXTURE_ROOT/src/__tests__/api/${rel_no_route}.test.ts"

  # Pick the sibling test that carries the helper call, if any.
  contract_test=""
  if has_helper_call "$adjacent_test"; then
    contract_test="$adjacent_test"
  elif has_helper_call "$alt_test"; then
    contract_test="$alt_test"
  fi

  if [ -n "$contract_test" ]; then
    # helper mode candidate — reject the RT5 stub anti-pattern outright.
    if has_mapping_mock "$contract_test"; then
      echo "MAPPING_MOCKED_CONTRACT_TEST: $route (${contract_test#$FIXTURE_ROOT/} calls assertRedisFailClosed but stubs the production checkRateLimitOrFail mapping)"
      fail=1
      continue
    fi
    if ! has_helper_import "$contract_test"; then
      echo "MISSING_FAIL_CLOSED_TEST: $route (assertRedisFailClosed( appears in ${contract_test#$FIXTURE_ROOT/} without importing @/__tests__/helpers/fail-closed — a comment or a local re-implementation does not count)"
      fail=1
      continue
    fi
    # Genuine helper-mode contract test: manifests must not linger.
    if is_debt "$route"; then
      echo "STALE_DEBT_ENTRY: $route (has a shared-helper contract test — remove its fail-closed-test-debt.txt entry in the same PR)"
      fail=1
      continue
    fi
    if is_legacy "$route"; then
      echo "STALE_LEGACY_ENTRY: $route (migrated to the shared-helper contract — remove its fail-closed-legacy-direct.txt entry in the same PR)"
      fail=1
      continue
    fi
    continue
  fi

  if is_legacy "$route"; then
    if is_debt "$route"; then
      echo "LEGACY_DEBT_CONFLICT: $route (listed in BOTH fail-closed-legacy-direct.txt and fail-closed-test-debt.txt — pick one)"
      fail=1
      continue
    fi
    if has_redis_errored "$adjacent_test" || has_redis_errored "$alt_test"; then
      continue # documented legacy-direct coverage
    fi
    echo "LEGACY_TEST_MISSING: $route (listed in fail-closed-legacy-direct.txt but no sibling test contains redisErrored)"
    fail=1
    continue
  fi

  if is_debt "$route"; then
    continue # documented debt — a bare redisErrored string in the sibling
             # test does NOT flip a debt route to "tested" (that requires the
             # shared-helper contract; see extension/bridge-code false-green
             # in the PR #680 external review).
  fi

  echo "MISSING_FAIL_CLOSED_TEST: $route (expected: assertRedisFailClosed contract in ${adjacent_test#$FIXTURE_ROOT/} or ${alt_test#$FIXTURE_ROOT/}, OR a fail-closed-legacy-direct.txt / fail-closed-test-debt.txt entry)"
  fail=1
done

# DANGLING_ENTRY — manifest entries whose route no longer opts into
# fail-closed (or no longer exists). Forces flag removal to be a visible,
# reviewable manifest diff (parent-plan M2 blind spot).
check_dangling() {
  local list="$1" name="$2" entry
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    if ! printf '%s' "$ROUTE_LIST" | grep -qxF "$entry"; then
      echo "DANGLING_ENTRY: $entry ($name lists it but the route no longer contains failClosedOnRedisError: true — remove the entry, or restore the opt-in)"
      fail=1
    fi
  done <<EOF
$list
EOF
}
check_dangling "$DEBT_LIST" "fail-closed-test-debt.txt"
check_dangling "$LEGACY_LIST" "fail-closed-legacy-direct.txt"

if [ "$fail" -ne 0 ]; then
  echo
  echo "Fix the reported routes: author an assertRedisFailClosed contract test,"
  echo "or register the route in fail-closed-test-debt.txt (untested) /"
  echo "fail-closed-legacy-direct.txt (pre-helper direct test), and keep the"
  echo "manifests in sync with the tests (stale/dangling entries fail)."
  echo "See docs/archive/review/fail-closed-tranche1-plan.md and AC4.3."
  exit 1
fi

# AC4.4/AC4.5 are a whole-repo invariant (an exact expected limiter/callsite
# count for THIS codebase) — meaningless against an isolated fixture tree, so
# they are skipped whenever FIXTURE_ROOT is overridden (self-test scope is
# the mode/anti-drift criteria above, not these repo-wide counts; the
# "real repo, no overrides" self-test case still exercises them).
if [ -n "${FAIL_CLOSED_TEST_ROOT:-}" ] || [ -n "${FAIL_CLOSED_TEST_DEBT_FILE:-}" ] || [ -n "${FAIL_CLOSED_TEST_LEGACY_FILE:-}" ]; then
  exit 0
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
