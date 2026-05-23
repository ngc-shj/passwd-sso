#!/usr/bin/env bash
# A04-4: master-key rotation dual-approval — operator CLI.
#
# Drives the 4-phase rotation flow via HTTPS. Each phase requires a separate
# op_* token (initiate + approve must be DIFFERENT operators; execute and
# revoke can be either party).
#
# Usage:
#   PHASE=initiate ADMIN_API_TOKEN=op_alice... TARGET_VERSION=<int>           \
#     [REASON="..."] [REVOKE_SHARES=false]                                    \
#     scripts/rotate-master-key.sh
#
#   PHASE=approve  ADMIN_API_TOKEN=op_bob...   ROTATION_ID=<uuid>             \
#     scripts/rotate-master-key.sh
#
#   PHASE=execute  ADMIN_API_TOKEN=op_alice... ROTATION_ID=<uuid>             \
#     scripts/rotate-master-key.sh
#
#   PHASE=revoke   ADMIN_API_TOKEN=op_*...     ROTATION_ID=<uuid>             \
#     [REASON="..."] scripts/rotate-master-key.sh
#
# Tokens are minted at /dashboard/tenant/operator-tokens. The token's bound
# tenant must match the rotation row's tenant (CAS-enforced at every phase).
#
# On initiate, stdout includes `rotationId=<uuid>` in key=value format so the
# operator can `eval "$(... initiate)"` and chain into approve/execute.
#
# Environment variables:
#   PHASE              (required) one of initiate|approve|execute|revoke
#   ADMIN_API_TOKEN    (required) op_<43-base64url> bearer token
#   APP_URL            (optional) default http://localhost:3000
#   INSECURE           (optional) skip TLS verification (default false)
# Phase-specific:
#   TARGET_VERSION     (required for initiate) integer, must match SHARE_MASTER_KEY_CURRENT_VERSION
#   REVOKE_SHARES      (optional, initiate)    "true"|"false", default true
#   REASON             (optional, initiate|revoke) free-text, max 500 chars
#   ROTATION_ID        (required for approve/execute/revoke) uuid

set -euo pipefail

APP_URL="${APP_URL:-http://localhost:3000}"
ADMIN_API_TOKEN="${ADMIN_API_TOKEN:-}"
PHASE="${PHASE:-}"

if ! [[ "$ADMIN_API_TOKEN" =~ ^op_[A-Za-z0-9_-]{43}$ ]]; then
  echo "[ERROR] ADMIN_API_TOKEN must be op_<43-base64url> (mint via /dashboard/tenant/operator-tokens)" >&2
  exit 1
fi

case "$PHASE" in
  initiate|approve|execute|revoke) ;;
  *)
    echo "[ERROR] PHASE must be one of: initiate, approve, execute, revoke (got: '$PHASE')" >&2
    exit 1
    ;;
esac

# Build phase-specific URL + body.
case "$PHASE" in
  initiate)
    TARGET_VERSION="${TARGET_VERSION:-}"
    if ! [[ "$TARGET_VERSION" =~ ^[1-9][0-9]*$ ]]; then
      echo "[ERROR] TARGET_VERSION must be a positive integer (got: '$TARGET_VERSION')" >&2
      exit 1
    fi
    REVOKE_SHARES="${REVOKE_SHARES:-true}"
    if [[ "$REVOKE_SHARES" != "true" && "$REVOKE_SHARES" != "false" ]]; then
      echo "[ERROR] REVOKE_SHARES must be 'true' or 'false'" >&2
      exit 1
    fi
    REASON_JSON=""
    if [[ -n "${REASON:-}" ]]; then
      if command -v python3 >/dev/null 2>&1; then
        ESCAPED=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$REASON")
      else
        ESCAPED="\"${REASON//\"/\\\"}\""
      fi
      REASON_JSON=",\"reason\":${ESCAPED}"
    fi
    URL="${APP_URL}/api/admin/rotate-master-key/initiate"
    BODY="{\"targetVersion\":${TARGET_VERSION},\"revokeShares\":${REVOKE_SHARES}${REASON_JSON}}"
    ;;

  approve|execute)
    ROTATION_ID="${ROTATION_ID:-}"
    if ! [[ "$ROTATION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
      echo "[ERROR] ROTATION_ID must be a UUID (got: '$ROTATION_ID')" >&2
      exit 1
    fi
    URL="${APP_URL}/api/admin/rotate-master-key/${ROTATION_ID}/${PHASE}"
    BODY="{}"
    ;;

  revoke)
    ROTATION_ID="${ROTATION_ID:-}"
    if ! [[ "$ROTATION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
      echo "[ERROR] ROTATION_ID must be a UUID (got: '$ROTATION_ID')" >&2
      exit 1
    fi
    REASON_JSON=""
    if [[ -n "${REASON:-}" ]]; then
      if command -v python3 >/dev/null 2>&1; then
        ESCAPED=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$REASON")
      else
        ESCAPED="\"${REASON//\"/\\\"}\""
      fi
      REASON_JSON="\"reason\":${ESCAPED}"
    fi
    URL="${APP_URL}/api/admin/rotate-master-key/${ROTATION_ID}/revoke"
    BODY="{${REASON_JSON}}"
    ;;
esac

CURL_OPTS=(-sS -w "\n%{http_code}" -X POST \
  -H "Authorization: Bearer ${ADMIN_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "${BODY}")
if [[ "${INSECURE:-false}" == "true" ]]; then
  echo "[WARNING] TLS certificate verification is disabled. Do not use in production." >&2
  CURL_OPTS+=(--insecure)
fi

RESPONSE=$(curl "${CURL_OPTS[@]}" "${URL}")
HTTP_STATUS=$(printf '%s' "$RESPONSE" | tail -n1)
BODY_RESPONSE=$(printf '%s' "$RESPONSE" | sed '$d')

if [[ "$PHASE" == "initiate" ]]; then
  EXPECTED_STATUS=201
else
  EXPECTED_STATUS=200
fi

if [[ "$HTTP_STATUS" != "$EXPECTED_STATUS" ]]; then
  echo "[ERROR] ${PHASE} returned HTTP ${HTTP_STATUS}: ${BODY_RESPONSE}" >&2
  exit 1
fi

if [[ "$PHASE" == "initiate" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    ROTATION_ID=$(printf '%s' "$BODY_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["rotationId"])')
    EXPIRES_AT=$(printf '%s' "$BODY_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["expiresAt"])')
  else
    ROTATION_ID=$(printf '%s' "$BODY_RESPONSE" | grep -o '"rotationId":"[^"]*"' | cut -d'"' -f4)
    EXPIRES_AT=$(printf '%s' "$BODY_RESPONSE" | grep -o '"expiresAt":"[^"]*"' | cut -d'"' -f4)
  fi
  echo "rotationId=${ROTATION_ID}"
  echo "expiresAt=${EXPIRES_AT}"
  echo "[rotate-master-key initiate] OK — rotationId=${ROTATION_ID}, expiresAt=${EXPIRES_AT}" >&2
else
  echo "[rotate-master-key ${PHASE}] OK"
  echo "${BODY_RESPONSE}"
fi
