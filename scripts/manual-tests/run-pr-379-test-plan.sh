#!/usr/bin/env bash
set -euo pipefail

# PR #379 Test plan execution script
# Verifies:
#  1) Team audit download returns 400 without date params
#  2) SCIM provisioning with deleted token creator writes SYSTEM actor audit
#  3) audit-chain-verify returns truncated=true and ok=false for >10k rows
#  4) rotate-master-key audit uses HUMAN actor + metadata.tokenSubjectUserId / tokenId
#     (post admin-token-redesign: per-operator op_* tokens; ADMIN_API_TOKEN must be op_*)

RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

pass() { printf "${GREEN}  ✓ %s${RESET}\n" "$1"; }
fail() { printf "${RED}  ✗ %s${RESET}\n" "$1"; FAILED=1; }
warn() { printf "${YELLOW}  ! %s${RESET}\n" "$1"; }

FAILED=0
SYSTEM_ACTOR_ID="00000000-0000-4000-8000-000000000001"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command is required" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 command is required" >&2
  exit 1
fi

BASE_CANDIDATES=(
  "https://localhost:3001/passwd-sso"
  "https://localhost:3001"
)
BASE=""
for b in "${BASE_CANDIDATES[@]}"; do
  code="$(curl -sk -o /dev/null -w "%{http_code}" "$b/api/health/ready" || true)"
  if [ "$code" = "200" ]; then
    BASE="$b"
    break
  fi
done
if [ -z "$BASE" ]; then
  echo "Could not detect dev server base URL. Start dev server first." >&2
  exit 1
fi

DB_EXEC=(docker compose -f docker-compose.yml exec -T db psql -U passwd_user -d passwd_sso -tA -v ON_ERROR_STOP=1 -c)

SESSION_TOKEN="$("${DB_EXEC[@]}" "SELECT session_token FROM sessions WHERE expires > NOW() ORDER BY expires DESC LIMIT 1;" | tr -d '\r\n')"
if [ -z "$SESSION_TOKEN" ]; then
  echo "No active session found. Please sign in via UI first." >&2
  exit 1
fi
COOKIE="__Secure-authjs.session-token=$SESSION_TOKEN"

OPERATOR_ID="${OPERATOR_ID:-$("${DB_EXEC[@]}" "SELECT user_id FROM sessions WHERE session_token = '$SESSION_TOKEN' LIMIT 1;" | tr -d '\r\n')}"
if [ -z "$OPERATOR_ID" ]; then
  echo "Could not determine OPERATOR_ID." >&2
  exit 1
fi

if [ -z "${ADMIN_API_TOKEN:-}" ]; then
  echo "ADMIN_API_TOKEN is required (env or .env.local)." >&2
  exit 1
fi

ORIGIN="${ORIGIN:-${AUTH_URL:-https://localhost:3001}}"
DATE_FROM="$(date -d "30 days ago" +%Y-%m-%d 2>/dev/null || date -v-30d +%Y-%m-%d)"
DATE_TO="$(date +%Y-%m-%d)"

api_get_status() {
  local path="$1"
  curl -sk -o /dev/null -w "%{http_code}" \
    -H "Origin: $ORIGIN" \
    -H "X-Forwarded-Proto: https" \
    -H "Content-Type: application/json" \
    -b "$COOKIE" \
    "$BASE$path"
}

admin_get_json() {
  local path="$1"
  curl -sk \
    -H "Authorization: Bearer $ADMIN_API_TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-Forwarded-Proto: https" \
    "$BASE$path"
}

admin_post_json() {
  local path="$1"
  local body="$2"
  curl -sk -X POST \
    -H "Authorization: Bearer $ADMIN_API_TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-Forwarded-Proto: https" \
    -d "$body" \
    "$BASE$path"
}

echo "=== PR #379 Test Plan Execution ==="
echo "Base URL : $BASE"
echo "Operator : $OPERATOR_ID"

# 1) Team audit download (400 without dates)
echo ""
echo "1) Team audit download requires date params"
TEAM_ID="$("${DB_EXEC[@]}" "SELECT team_id FROM team_members WHERE user_id = '$OPERATOR_ID' AND deactivated_at IS NULL LIMIT 1;" | tr -d '\r\n')"
if [ -z "$TEAM_ID" ]; then
  warn "No active team membership for operator; trying any team."
  TEAM_ID="$("${DB_EXEC[@]}" "SELECT id FROM teams LIMIT 1;" | tr -d '\r\n')"
fi
if [ -z "$TEAM_ID" ]; then
  fail "No team available for test."
else
  code_no_date="$(api_get_status "/api/teams/$TEAM_ID/audit-logs/download")"
  [ "$code_no_date" = "400" ] && pass "No-date request returned 400." || fail "Expected 400, got $code_no_date"

  sleep 2
  code_with_date="$(api_get_status "/api/teams/$TEAM_ID/audit-logs/download?from=$DATE_FROM&to=$DATE_TO")"
  [ "$code_with_date" = "200" ] && pass "Date-bounded request returned 200." || fail "Expected 200, got $code_with_date"
fi

# 2) SCIM provisioning with deleted/null token creator
echo ""
echo "2) SCIM provisioning with deleted token creator writes SYSTEM actor audit"
TMP_TENANT_ID="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
TMP_USER_ID="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
TMP_SLUG="tmp-pr379-$(date +%s)-$RANDOM"
TMP_EMAIL="tmp-pr379-scim-$(date +%s)-$RANDOM@example.com"
NOW="$(date -u +'%Y-%m-%d %H:%M:%S+00')"
SCIM_PLAIN="scim_manual_$(openssl rand -hex 16)"
SCIM_HASH="$(printf "%s" "$SCIM_PLAIN" | sha256sum | awk '{print $1}')"

cleanup_tmp() {
  set +e
  "${DB_EXEC[@]}" "UPDATE audit_outbox SET status='FAILED' WHERE tenant_id='$TMP_TENANT_ID' AND status='PENDING';" >/dev/null 2>&1
  "${DB_EXEC[@]}" "DELETE FROM scim_external_mappings WHERE tenant_id='$TMP_TENANT_ID';" >/dev/null 2>&1
  "${DB_EXEC[@]}" "DELETE FROM scim_tokens WHERE tenant_id='$TMP_TENANT_ID';" >/dev/null 2>&1
  "${DB_EXEC[@]}" "DELETE FROM audit_logs WHERE tenant_id='$TMP_TENANT_ID';" >/dev/null 2>&1
  "${DB_EXEC[@]}" "DELETE FROM audit_outbox WHERE tenant_id='$TMP_TENANT_ID';" >/dev/null 2>&1
  "${DB_EXEC[@]}" "DELETE FROM audit_chain_anchors WHERE tenant_id='$TMP_TENANT_ID';" >/dev/null 2>&1
  "${DB_EXEC[@]}" "DELETE FROM tenant_members WHERE tenant_id='$TMP_TENANT_ID';" >/dev/null 2>&1
  "${DB_EXEC[@]}" "DELETE FROM users WHERE tenant_id='$TMP_TENANT_ID';" >/dev/null 2>&1
  "${DB_EXEC[@]}" "DELETE FROM tenants WHERE id='$TMP_TENANT_ID';" >/dev/null 2>&1
  set -e
}
trap cleanup_tmp EXIT

"${DB_EXEC[@]}" "
INSERT INTO tenants (id, name, slug, is_bootstrap, created_at, updated_at)
VALUES ('$TMP_TENANT_ID', 'tmp-pr379', '$TMP_SLUG', false, '$NOW', '$NOW');

INSERT INTO users (id, tenant_id, email, name, created_at, updated_at)
VALUES ('$TMP_USER_ID', '$TMP_TENANT_ID', 'tmp-operator+$TMP_SLUG@example.com', 'tmp-op', '$NOW', '$NOW');

INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
VALUES ('$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)', '$TMP_TENANT_ID', '$TMP_USER_ID', 'OWNER', '$NOW', '$NOW');

INSERT INTO scim_tokens (id, tenant_id, token_hash, description, created_by_id, created_at)
VALUES ('$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)', '$TMP_TENANT_ID', '$SCIM_HASH', 'tmp-null-creator', NULL, '$NOW');
" >/dev/null

SCIM_BODY="$(python3 - <<PY
import json
print(json.dumps({
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "userName": "$TMP_EMAIL",
  "name": {"formatted": "Tmp PR379 SCIM"},
  "active": True
}))
PY
)"

SCIM_STATUS="$(curl -sk -o /tmp/pr379_scim_create.json -w "%{http_code}" \
  -H "Authorization: Bearer $SCIM_PLAIN" \
  -H "Content-Type: application/scim+json" \
  -H "Accept: application/scim+json" \
  -H "X-Forwarded-Proto: https" \
  -d "$SCIM_BODY" \
  "$BASE/api/scim/v2/Users")"

if [ "$SCIM_STATUS" != "201" ]; then
  fail "SCIM create expected 201, got $SCIM_STATUS"
else
  pass "SCIM create returned 201."
fi

SCIM_PAYLOAD="$("${DB_EXEC[@]}" "
SELECT payload::text
FROM audit_outbox
WHERE tenant_id='$TMP_TENANT_ID'
  AND payload->>'action'='SCIM_USER_CREATE'
ORDER BY created_at DESC
LIMIT 1;
")"

SCIM_AUDIT_USER="$(printf "%s" "$SCIM_PAYLOAD" | python3 - <<'PY'
import json, sys
s=sys.stdin.read().strip()
print("" if not s else json.loads(s).get("userId",""))
PY
)"
SCIM_AUDIT_ACTOR="$(printf "%s" "$SCIM_PAYLOAD" | python3 - <<'PY'
import json, sys
s=sys.stdin.read().strip()
print("" if not s else json.loads(s).get("actorType",""))
PY
)"

[ "$SCIM_AUDIT_USER" = "$SYSTEM_ACTOR_ID" ] && pass "SCIM audit userId is SYSTEM_ACTOR_ID." || fail "SCIM audit userId mismatch: $SCIM_AUDIT_USER"
[ "$SCIM_AUDIT_ACTOR" = "SYSTEM" ] && pass "SCIM audit actorType is SYSTEM." || fail "SCIM audit actorType mismatch: $SCIM_AUDIT_ACTOR"

# 3) Chain verify truncation over 10k
echo ""
echo "3) audit-chain-verify returns truncated=true and ok=false for >10k rows"
"${DB_EXEC[@]}" "
INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
VALUES ('$TMP_TENANT_ID', 10050, decode('00','hex'), '$NOW');

INSERT INTO audit_logs (
  id, tenant_id, scope, action, user_id, actor_type, metadata, created_at, chain_seq, event_hash, chain_prev_hash
)
SELECT
  (substr(md5(g::text || random()::text),1,8)||'-'||substr(md5(g::text || random()::text),1,4)||'-4'||substr(md5(g::text || random()::text),1,3)||'-8'||substr(md5(g::text || random()::text),1,3)||'-'||substr(md5(g::text || random()::text),1,12))::uuid,
  '$TMP_TENANT_ID'::uuid,
  'TENANT',
  'AUDIT_CHAIN_VERIFY',
  '$SYSTEM_ACTOR_ID'::uuid,
  'SYSTEM',
  '{}'::jsonb,
  now() + (g || ' seconds')::interval,
  g::bigint,
  decode(repeat('aa',32), 'hex'),
  decode(repeat('bb',32), 'hex')
FROM generate_series(1, 10050) AS g;
" >/dev/null

CHAIN_JSON="$(admin_get_json "/api/maintenance/audit-chain-verify?tenantId=$TMP_TENANT_ID")"
CHAIN_OK="$(printf "%s" "$CHAIN_JSON" | python3 - <<'PY'
import json, sys
print(json.loads(sys.stdin.read()).get("ok"))
PY
)"
CHAIN_TRUNC="$(printf "%s" "$CHAIN_JSON" | python3 - <<'PY'
import json, sys
print(json.loads(sys.stdin.read()).get("truncated"))
PY
)"
CHAIN_REASON="$(printf "%s" "$CHAIN_JSON" | python3 - <<'PY'
import json, sys
print(json.loads(sys.stdin.read()).get("reason",""))
PY
)"

[ "$CHAIN_TRUNC" = "True" ] && pass "Chain verify returned truncated=true." || fail "Expected truncated=true, got $CHAIN_TRUNC"
[ "$CHAIN_OK" = "False" ] && pass "Chain verify returned ok=false." || fail "Expected ok=false, got $CHAIN_OK"
echo "    reason=$CHAIN_REASON"

# 4) rotate-master-key audit fields (post admin-token-redesign)
echo ""
echo "4) rotate-master-key audit uses HUMAN actor + metadata.tokenSubjectUserId / tokenId"
TARGET_VERSION="${SHARE_MASTER_KEY_CURRENT_VERSION:-1}"
ROTATE_STATUS="$(curl -sk -o /tmp/pr379_rotate.json -w "%{http_code}" \
  -X POST "$BASE/api/admin/rotate-master-key" \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Forwarded-Proto: https" \
  -d "{\"targetVersion\":$TARGET_VERSION,\"revokeShares\":false}")"

if [ "$ROTATE_STATUS" != "200" ]; then
  fail "rotate-master-key expected 200, got $ROTATE_STATUS"
else
  pass "rotate-master-key returned 200."
fi

ROTATE_PAYLOAD="$("${DB_EXEC[@]}" "
SELECT payload::text
FROM audit_outbox
WHERE payload->>'action'='MASTER_KEY_ROTATION'
ORDER BY created_at DESC
LIMIT 1;
")"

ROTATE_AUDIT_USER="$(printf "%s" "$ROTATE_PAYLOAD" | python3 - <<'PY'
import json, sys
print(json.loads(sys.stdin.read()).get("userId",""))
PY
)"
ROTATE_AUDIT_ACTOR="$(printf "%s" "$ROTATE_PAYLOAD" | python3 - <<'PY'
import json, sys
print(json.loads(sys.stdin.read()).get("actorType",""))
PY
)"
ROTATE_AUDIT_TOKEN_SUBJECT="$(printf "%s" "$ROTATE_PAYLOAD" | python3 - <<'PY'
import json, sys
d=json.loads(sys.stdin.read())
print((d.get("metadata") or {}).get("tokenSubjectUserId",""))
PY
)"
ROTATE_AUDIT_TOKEN_ID="$(printf "%s" "$ROTATE_PAYLOAD" | python3 - <<'PY'
import json, sys
d=json.loads(sys.stdin.read())
print((d.get("metadata") or {}).get("tokenId",""))
PY
)"

[ -n "$ROTATE_AUDIT_USER" ] && pass "rotate audit userId is set (token-bound subject)." || fail "rotate audit userId is empty"
[ "$ROTATE_AUDIT_ACTOR" = "HUMAN" ] && pass "rotate audit actorType is HUMAN." || fail "rotate audit actorType mismatch: $ROTATE_AUDIT_ACTOR"
[ -n "$ROTATE_AUDIT_TOKEN_SUBJECT" ] && pass "rotate audit metadata.tokenSubjectUserId is set." || fail "rotate metadata.tokenSubjectUserId is empty"
[ -n "$ROTATE_AUDIT_TOKEN_ID" ] && pass "rotate audit metadata.tokenId is set." || fail "rotate metadata.tokenId is empty"

echo ""
echo "=== Result ==="
if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}PASS${RESET} PR #379 Test plan checks passed."
else
  echo -e "${RED}FAIL${RESET} Some checks failed."
fi

exit "$FAILED"
