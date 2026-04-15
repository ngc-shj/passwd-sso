#!/usr/bin/env bash
# Manual test script for audit delivery target CRUD
# Usage: bash scripts/manual-tests/test-delivery-targets.sh
set -euo pipefail

BASE="https://localhost:3001/passwd-sso"

# Get session token from DB
TOKEN=$(docker compose -f docker-compose.yml exec -T db \
  psql -U passwd_user -d passwd_sso -tA \
  -c "SELECT session_token FROM sessions WHERE expires > NOW() ORDER BY expires DESC LIMIT 1;" | tr -d '\r\n')
# HTTPS uses __Secure- prefix; plain HTTP uses authjs.session-token
COOKIE="__Secure-authjs.session-token=$TOKEN"

# Derive origin from AUTH_URL (CSRF check compares against APP_URL/AUTH_URL)
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

pass() { printf "\033[32m  ✓ %s\033[0m\n" "$1"; }
fail() { printf "\033[31m  ✗ %s\033[0m\n" "$1"; FAILED=1; }

FAILED=0
echo "=== Audit Delivery Target CRUD Tests ==="

# ── 1. SSRF rejection ────────────────────────────────────
echo ""
echo "▸ SSRF: private IP (192.168.1.1)"
STATUS=$(api POST /api/tenant/audit-delivery-targets \
  -d '{"kind":"WEBHOOK","url":"https://192.168.1.1/hook","secret":"test123"}' \
  -o /dev/null -w "%{http_code}")
[ "$STATUS" = "400" ] && pass "Rejected with 400" || fail "Expected 400, got $STATUS"

echo "▸ SSRF: HTTP (not HTTPS)"
STATUS=$(api POST /api/tenant/audit-delivery-targets \
  -d '{"kind":"WEBHOOK","url":"http://example.com/hook","secret":"test123"}' \
  -o /dev/null -w "%{http_code}")
[ "$STATUS" = "400" ] && pass "Rejected with 400" || fail "Expected 400, got $STATUS"

# ── 2. Deactivate / Reactivate (BEFORE limit test, outbox is quiet) ──
FIRST_ID=$(api GET /api/tenant/audit-delivery-targets | python3 -c "
import sys,json
targets = json.load(sys.stdin).get('targets',[])
active = [t for t in targets if t['isActive']]
print(active[0]['id'] if active else '')
" 2>/dev/null || echo "")

if [ -n "$FIRST_ID" ]; then
  echo ""
  echo "▸ Deactivate target $FIRST_ID"
  BODY=$(api PATCH "/api/tenant/audit-delivery-targets/$FIRST_ID" -d '{"isActive":false}')
  IS_ACTIVE=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('target',{}).get('isActive',''))" 2>/dev/null)
  [ "$IS_ACTIVE" = "False" ] && pass "Deactivated (isActive=false)" || fail "Expected isActive=false, got $IS_ACTIVE"

  # Wait for outbox worker to drain (1s poll interval + processing)
  sleep 5
  DEACT_LOG=$(docker compose -f docker-compose.yml exec -T db \
    psql -U passwd_user -d passwd_sso -tA \
    -c "SELECT count(*) FROM audit_logs WHERE action::text='AUDIT_DELIVERY_TARGET_DEACTIVATE' AND metadata->>'targetId'='$FIRST_ID';" | tr -d '\r\n ')
  [ "$DEACT_LOG" -ge 1 ] && pass "DEACTIVATE audit log recorded" || fail "No DEACTIVATE audit log found"

  echo ""
  echo "▸ Reactivate target $FIRST_ID"
  BODY=$(api PATCH "/api/tenant/audit-delivery-targets/$FIRST_ID" -d '{"isActive":true}')
  IS_ACTIVE=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('target',{}).get('isActive',''))" 2>/dev/null)
  [ "$IS_ACTIVE" = "True" ] && pass "Reactivated (isActive=true)" || fail "Expected isActive=true, got $IS_ACTIVE"

  sleep 5
  REACT_LOG=$(docker compose -f docker-compose.yml exec -T db \
    psql -U passwd_user -d passwd_sso -tA \
    -c "SELECT count(*) FROM audit_logs WHERE action::text='AUDIT_DELIVERY_TARGET_REACTIVATE' AND metadata->>'targetId'='$FIRST_ID';" | tr -d '\r\n ')
  [ "$REACT_LOG" -ge 1 ] && pass "REACTIVATE audit log recorded" || fail "No REACTIVATE audit log found"
else
  fail "No active target found to test deactivate/reactivate"
fi

# ── 3. Limit test (creates many targets → outbox flood, do this last) ──
CURRENT_COUNT=$(api GET /api/tenant/audit-delivery-targets | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('targets',[])))" 2>/dev/null || echo 0)
echo ""
echo "▸ Current target count: $CURRENT_COUNT"

CREATED_IDS=()
NEED=$((10 - CURRENT_COUNT))
if [ "$NEED" -gt 0 ]; then
  echo "▸ Creating $NEED targets to reach limit..."
  for i in $(seq 1 "$NEED"); do
    BODY=$(api POST /api/tenant/audit-delivery-targets \
      -d "{\"kind\":\"WEBHOOK\",\"url\":\"https://limit-test-$i.example.com/hook\",\"secret\":\"secret$i\"}")
    TID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('target',{}).get('id',''))" 2>/dev/null || echo "")
    [ -n "$TID" ] && CREATED_IDS+=("$TID")
  done
fi

echo ""
echo "▸ Limit test: creating 11th target"
STATUS=$(api POST /api/tenant/audit-delivery-targets \
  -d '{"kind":"WEBHOOK","url":"https://overflow.example.com/hook","secret":"overflow"}' \
  -o /dev/null -w "%{http_code}")
[ "$STATUS" = "400" ] && pass "Rejected with 400 (limit reached)" || fail "Expected 400, got $STATUS"

# Cleanup: deactivate test targets we created for limit test
if [ ${#CREATED_IDS[@]} -gt 0 ]; then
  echo ""
  echo "▸ Cleaning up ${#CREATED_IDS[@]} limit-test targets..."
  for TID in "${CREATED_IDS[@]}"; do
    api PATCH "/api/tenant/audit-delivery-targets/$TID" -d '{"isActive":false}' >/dev/null 2>&1
  done
  pass "Cleanup done"
fi

echo ""
echo "=== Results ==="
[ "$FAILED" = "0" ] && echo -e "\033[32m✓ All manual tests passed\033[0m" || echo -e "\033[31m✗ Some tests failed\033[0m"
exit "$FAILED"
