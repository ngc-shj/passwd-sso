#!/usr/bin/env bash
# Rotate the server-side ShareLink master key.
#
# Usage:
#   ADMIN_API_TOKEN=<op_token> TARGET_VERSION=<int> scripts/rotate-master-key.sh
#
# Mint an operator token at /dashboard/tenant/operator-tokens. The token's
# subject (the user it authenticates as) is bound at issuance time; no
# separate operatorId env var is needed.
#
# Environment variables:
#   ADMIN_API_TOKEN  (required) Per-operator op_* bearer token (op_<43-base64url>)
#   TARGET_VERSION   (required) Target key version (must match SHARE_MASTER_KEY_CURRENT_VERSION)
#   APP_URL          (optional) Application URL (default: http://localhost:3000)
#   REVOKE_SHARES    (optional) Revoke shares encrypted with older versions (default: false)
#   INSECURE         (optional) Skip TLS certificate verification (default: false)
#
# Exit codes:
#   0 — success
#   1 — error (missing env vars, HTTP error, etc.)

set -euo pipefail

APP_URL="${APP_URL:-http://localhost:3000}"
ADMIN_API_TOKEN="${ADMIN_API_TOKEN:-}"
TARGET_VERSION="${TARGET_VERSION:-}"
REVOKE_SHARES="${REVOKE_SHARES:-false}"

if ! [[ "$ADMIN_API_TOKEN" =~ ^op_[A-Za-z0-9_-]{43}$ ]]; then
  echo "[ERROR] ADMIN_API_TOKEN must be op_<43-base64url> (mint via /dashboard/tenant/operator-tokens)" >&2
  exit 1
fi

if [[ -z "$TARGET_VERSION" ]]; then
  echo "[ERROR] TARGET_VERSION is required" >&2
  exit 1
fi

if ! [[ "$TARGET_VERSION" =~ ^[1-9][0-9]*$ ]]; then
  echo "[ERROR] TARGET_VERSION must be a positive integer" >&2
  exit 1
fi

if [[ "$REVOKE_SHARES" != "true" && "$REVOKE_SHARES" != "false" ]]; then
  echo "[ERROR] REVOKE_SHARES must be 'true' or 'false'" >&2
  exit 1
fi

BODY=$(cat <<EOJSON
{"targetVersion":${TARGET_VERSION},"revokeShares":${REVOKE_SHARES}}
EOJSON
)

CURL_OPTS=(-sS -w "\n%{http_code}" -X POST \
  -H "Authorization: Bearer ${ADMIN_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "${BODY}")
if [[ "${INSECURE:-false}" == "true" ]]; then
  echo "[WARNING] TLS certificate verification is disabled. Do not use in production." >&2
  CURL_OPTS+=(--insecure)
fi

RESPONSE=$(curl "${CURL_OPTS[@]}" "${APP_URL}/api/admin/rotate-master-key")

HTTP_STATUS=$(printf '%s' "$RESPONSE" | tail -n1)
BODY_RESPONSE=$(printf '%s' "$RESPONSE" | sed '$d')

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "[ERROR] rotate-master-key returned HTTP ${HTTP_STATUS}: ${BODY_RESPONSE}" >&2
  exit 1
fi

REVOKED=$(printf '%s' "$BODY_RESPONSE" | grep -o '"revokedShares":[0-9]*' | cut -d: -f2)
echo "[rotate-master-key] OK — targetVersion=${TARGET_VERSION}, revokedShares=${REVOKED:-0}"
