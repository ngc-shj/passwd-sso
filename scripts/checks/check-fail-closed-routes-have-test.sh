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
#                  test must still reference `redisErrored` in CODE.
#                  Migration to helper mode removes the entry (atomic).
#   debt mode    — route listed in fail-closed-test-debt.txt: no adequate
#                  test yet; tracked for a future tranche.
#
# Test classification is AST-BASED (scripts/checks/classify-fail-closed-test.mjs,
# ts-morph): comments, describe labels, and string literals never satisfy any
# criterion. History: the original pass criterion was a bare
# `grep -q "redisErrored"`; the PR #680 external review demonstrated it was
# false-green-able (comment / label / mapping-stubbed test — extension/
# bridge-code was already misclassified), and the first fix's tightened greps
# were still text-based. Text matching remains ONLY where its failure mode is
# fail-LOUD, not fail-green: route enumeration and the AC4.4/AC4.5 literal
# counts (a stray literal there breaks the count and fails CI visibly).
#
# Anti-drift rules (each is a distinct failure token, self-tested):
#   MAPPING_MOCKED_CONTRACT_TEST — helper call present but the test stubs
#     @/lib/security/rate-limit-audit / checkRateLimitOrFail (RT5 violation).
#   STALE_DEBT_ENTRY   — helper-mode test exists but the debt entry remains.
#   STALE_LEGACY_ENTRY — helper-mode test exists but the legacy entry remains.
#   LEGACY_DEBT_CONFLICT — route listed in BOTH legacy and debt files.
#   LEGACY_TEST_MISSING — legacy entry whose sibling test lost the
#     code-level redisErrored reference.
#   DANGLING_ENTRY — debt/legacy entry whose route no longer opts in
#     (flag removal must be a visible manifest diff, parent-plan M2).
#   CLASSIFIER_FAILURE — the AST classifier itself failed; the gate fails
#     closed rather than falling back to any text match.
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
CLASSIFIER="$REPO_ROOT/scripts/checks/classify-fail-closed-test.mjs"

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

# NOTE: membership/lookup helpers use herestrings, NOT `printf | grep -q`
# pipelines — `grep -q` closes the pipe on first match, and under load
# (parallel vitest workers) printf then dies with SIGPIPE (141), which
# `set -o pipefail` turns into a spurious gate failure. No pipe, no race.
is_debt()   { grep -qxF "$1" <<<"$DEBT_LIST"; }
is_legacy() { grep -qxF "$1" <<<"$LEGACY_LIST"; }

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
candidate_tests=()
for route in ${routes[@]+"${routes[@]}"}; do
  ROUTE_LIST="${ROUTE_LIST}${route}
"
  dir="$(dirname "$route")"
  rel_path="${route#src/app/api/}"
  rel_no_route="${rel_path%/route.ts}"
  candidate_tests+=("$FIXTURE_ROOT/$dir/route.test.ts")
  candidate_tests+=("$FIXTURE_ROOT/src/__tests__/api/${rel_no_route}.test.ts")
done

# Batch-classify every candidate sibling test with the AST classifier.
# A classifier failure fails the gate (never fall back to text matching).
CLASSIFY_OUT=""
if [ "${#candidate_tests[@]}" -gt 0 ]; then
  if ! CLASSIFY_OUT="$(node "$CLASSIFIER" ${candidate_tests[@]+"${candidate_tests[@]}"})"; then
    echo "CLASSIFIER_FAILURE: scripts/checks/classify-fail-closed-test.mjs failed — gate fails closed (no text fallback)."
    exit 1
  fi
fi

# lookup <abs-path> → record string ("exists=1 import=1 calls=2 mock=0 redis=1")
lookup() {
  awk -F'\t' -v p="$1" '$1 == p { print $2; exit }' <<<"$CLASSIFY_OUT"
}
# field <record> <key> → value (empty when record/key absent)
field() {
  awk -v k="$2" '{ for (i = 1; i <= NF; i++) { split($i, a, "="); if (a[1] == k) { print a[2]; exit } } }' <<<"$1"
}

for route in ${routes[@]+"${routes[@]}"}; do
  dir="$(dirname "$route")"
  adjacent_test="$FIXTURE_ROOT/$dir/route.test.ts"
  rel_path="${route#src/app/api/}"        # X/route.ts
  rel_no_route="${rel_path%/route.ts}"    # X
  alt_test="$FIXTURE_ROOT/src/__tests__/api/${rel_no_route}.test.ts"

  rec_adj="$(lookup "$adjacent_test")"
  rec_alt="$(lookup "$alt_test")"

  # Pick the sibling test that carries real helper calls, if any.
  contract_test=""
  contract_rec=""
  if [ "$(field "$rec_adj" calls)" != "" ] && [ "$(field "$rec_adj" calls)" -gt 0 ] 2>/dev/null; then
    contract_test="$adjacent_test"; contract_rec="$rec_adj"
  elif [ "$(field "$rec_alt" calls)" != "" ] && [ "$(field "$rec_alt" calls)" -gt 0 ] 2>/dev/null; then
    contract_test="$alt_test"; contract_rec="$rec_alt"
  fi

  if [ -n "$contract_test" ]; then
    # helper mode candidate — reject the RT5 stub anti-pattern outright.
    if [ "$(field "$contract_rec" mock)" = "1" ]; then
      echo "MAPPING_MOCKED_CONTRACT_TEST: $route (${contract_test#$FIXTURE_ROOT/} calls assertRedisFailClosed but stubs the production checkRateLimitOrFail mapping)"
      fail=1
      continue
    fi
    if [ "$(field "$contract_rec" import)" != "1" ]; then
      echo "MISSING_FAIL_CLOSED_TEST: $route (assertRedisFailClosed is called in ${contract_test#$FIXTURE_ROOT/} without importing it from @/__tests__/helpers/fail-closed — a local re-implementation does not count)"
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
    if [ "$(field "$rec_adj" redis)" = "1" ] || [ "$(field "$rec_alt" redis)" = "1" ]; then
      continue # documented legacy-direct coverage (code-level reference)
    fi
    echo "LEGACY_TEST_MISSING: $route (listed in fail-closed-legacy-direct.txt but no sibling test references redisErrored in code)"
    fail=1
    continue
  fi

  if is_debt "$route"; then
    continue # documented debt — a redisErrored reference alone does NOT flip
             # a debt route to "tested" (that requires the shared-helper
             # contract; see extension/bridge-code false-green, PR #680 review).
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
    if ! grep -qxF "$entry" <<<"$ROUTE_LIST"; then
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
