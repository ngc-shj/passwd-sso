#!/usr/bin/env bash
# Manual test for codebase-review-fixes PR (#379)
#
# Tests:
#   1. Team audit download returns 400 when no date params
#   2. Team audit download returns 200 with date params
#   3. Admin rotate-master-key audit shows SYSTEM_ACTOR_ID + metadata.operatorId
#   4. Chain-verify returns truncated field in response
#   5. Audit download CSV includes actorType column
#
# Prerequisites:
#   - Dev server running at https://localhost:3001/passwd-sso (npm run dev)
#   - Docker DB running (docker compose up -d db)
#   - At least one active session in the DB (log in via UI first)
#   - ADMIN_API_TOKEN and OPERATOR_ID set (for admin endpoint tests)
#
# Usage:
#   ADMIN_API_TOKEN=<hex64> OPERATOR_ID=<uuid> bash scripts/manual-tests/test-codebase-review-fixes.sh

set -euo pipefail

BASE="https://localhost:3001/passwd-sso"
ADMIN_API_TOKEN="${ADMIN_API_TOKEN:-}"
OPERATOR_ID="${OPERATOR_ID:-}"

# Get session token from DB
TOKEN=$(docker compose -f docker-compose.yml exec -T db \
  psql -U passwd_user -d passwd_sso -tA \
  -c "SELECT session_token FROM sessions WHERE expires > NOW() ORDER BY expires DESC LIMIT 1;" | tr -d '\r\n')
COOKIE="__Secure-authjs.session-token=$TOKEN"

ORIGIN=$(grep -m1 "^AUTH_URL=" .env.local | cut -d= -f2- | tr -d '\r\n')
: "${ORIGIN:=https://localhost:3001}"

api() {
  local method=$1 path=$2; shift 2
  curl -sk -X "$method" "$BASE$path" \
    -H "Content-Type: application/json" \
    -H "Origin: $ORIGIN" \
    -H "X-Forwarded-Proto: https" \
    -b "$COOKIE" "$@"
}

admin_api() {
  local method=$1 path=$2; shift 2
  curl -sk -X "$method" "$BASE$path" \
    -H "Authorization: Bearer $ADMIN_API_TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-Forwarded-Proto: https" \
    "$@"
}

pass() { printf "\033[32m  ✓ %s\033[0m\n" "$1"; }
fail() { printf "\033[31m  ✗ %s\033[0m\n" "$1"; FAILED=1; }

FAILED=0

# Get a team ID from DB
TEAM_ID=$(docker compose -f docker-compose.yml exec -T db \
  psql -U passwd_user -d passwd_sso -tA \
  -c "SELECT id FROM teams LIMIT 1;" | tr -d '\r\n')

echo "=== Codebase Review Fixes Manual Tests ==="
echo "  Team ID: ${TEAM_ID:-<none>}"
echo "  Operator: ${OPERATOR_ID:-<not set>}"

# ── 1. Team audit download: 400 when no date params ──────────
echo ""
echo "▸ Finding 1: Team download — no date params → 400"
if [ -n "$TEAM_ID" ]; then
  STATUS=$(api GET "/api/teams/$TEAM_ID/audit-logs/download" \
    -o /dev/null -w "%{http_code}")
  [ "$STATUS" = "400" ] && pass "Rejected with 400 (no date params)" || fail "Expected 400, got $STATUS"
else
  fail "No team found in DB — skipped"
fi

# ── 2. Team audit download: 200 with date params ─────────────
echo ""
echo "▸ Finding 1: Team download — with date params → 200"
if [ -n "$TEAM_ID" ]; then
  STATUS=$(api GET "/api/teams/$TEAM_ID/audit-logs/download?from=2025-01-01&to=2025-12-31" \
    -o /dev/null -w "%{http_code}")
  [ "$STATUS" = "200" ] && pass "Returned 200 with date params" || fail "Expected 200, got $STATUS"
else
  fail "No team found in DB — skipped"
fi

# ── 3. Audit download CSV includes actorType column ──────────
echo ""
echo "▸ Finding 4: Audit download CSV — actorType in header"
BODY=$(api GET "/api/audit-logs/download?format=csv&from=2025-01-01&to=2025-12-31" 2>/dev/null || echo "")
HEADER=$(echo "$BODY" | head -1)
if echo "$HEADER" | grep -q "actorType"; then
  pass "CSV header includes actorType"
else
  fail "CSV header missing actorType: $HEADER"
fi

# ── 4. Admin endpoint audit tests (requires ADMIN_API_TOKEN) ─
if [ -n "$ADMIN_API_TOKEN" ] && [ -n "$OPERATOR_ID" ]; then
  # Get tenant ID for the operator
  TENANT_ID=$(docker compose -f docker-compose.yml exec -T db \
    psql -U passwd_user -d passwd_sso -tA \
    -c "SELECT tenant_id FROM tenant_members WHERE user_id = '$OPERATOR_ID' AND deactivated_at IS NULL LIMIT 1;" | tr -d '\r\n')

  # ── 4a. Chain-verify: truncated field always in response ──
  echo ""
  echo "▸ Finding 6: Chain-verify — truncated field present"
  if [ -n "$TENANT_ID" ]; then
    BODY=$(admin_api GET "/api/maintenance/audit-chain-verify?tenantId=$TENANT_ID&operatorId=$OPERATOR_ID" 2>/dev/null || echo "")
    if echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'truncated' in d" 2>/dev/null; then
      pass "Response includes truncated field"
    else
      fail "Response missing truncated field: $BODY"
    fi

    # Check ok value and truncated
    OK=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null)
    TRUNC=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('truncated',''))" 2>/dev/null)
    echo "    ok=$OK truncated=$TRUNC"
  else
    fail "No tenant found for operator $OPERATOR_ID"
  fi

  # ── 4b. Check audit log for chain-verify ─────────────────
  echo ""
  echo "▸ Finding 7: Chain-verify audit — SYSTEM_ACTOR_ID + metadata.operatorId"
  sleep 3  # wait for outbox worker
  AUDIT_ROW=$(docker compose -f docker-compose.yml exec -T db \
    psql -U passwd_user -d passwd_sso -tA \
    -c "SELECT user_id, actor_type, metadata FROM audit_logs WHERE action::text='AUDIT_CHAIN_VERIFY' ORDER BY created_at DESC LIMIT 1;" | tr -d '\r\n')
  if [ -n "$AUDIT_ROW" ]; then
    USER_ID=$(echo "$AUDIT_ROW" | cut -d'|' -f1)
    ACTOR_TYPE=$(echo "$AUDIT_ROW" | cut -d'|' -f2)
    METADATA=$(echo "$AUDIT_ROW" | cut -d'|' -f3)

    # Check userId is SYSTEM_ACTOR_ID (00000000-0000-4000-8000-000000000001)
    if [ "$USER_ID" = "00000000-0000-4000-8000-000000000001" ]; then
      pass "userId = SYSTEM_ACTOR_ID"
    else
      fail "userId = $USER_ID (expected SYSTEM_ACTOR_ID)"
    fi

    # Check actorType is SYSTEM
    if [ "$ACTOR_TYPE" = "SYSTEM" ]; then
      pass "actorType = SYSTEM"
    else
      fail "actorType = $ACTOR_TYPE (expected SYSTEM)"
    fi

    # Check metadata.operatorId exists
    if echo "$METADATA" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('operatorId')" 2>/dev/null; then
      OP_ID=$(echo "$METADATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['operatorId'])" 2>/dev/null)
      pass "metadata.operatorId = $OP_ID"
    else
      fail "metadata.operatorId missing"
    fi
  else
    fail "No AUDIT_CHAIN_VERIFY audit log found (outbox worker may not have processed yet)"
  fi
else
  echo ""
  echo "▸ Skipping admin endpoint tests (ADMIN_API_TOKEN / OPERATOR_ID not set)"
fi

echo ""
echo "=== Results ==="
[ "$FAILED" = "0" ] && echo -e "\033[32m✓ All manual tests passed\033[0m" || echo -e "\033[31m✗ Some tests failed\033[0m"
exit "$FAILED"
