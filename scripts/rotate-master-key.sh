#!/usr/bin/env bash
# Rotate the server-side ShareLink master key.
#
# Usage:
#   ADMIN_API_TOKEN=<hex64> OPERATOR_ID=<user-uuid> TARGET_VERSION=<int> scripts/rotate-master-key.sh
#
# Environment variables:
#   ADMIN_API_TOKEN  (required) Admin bearer token (64-char hex)
#   OPERATOR_ID      (required) User ID of the admin performing the rotation
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
OPERATOR_ID="${OPERATOR_ID:-}"
TARGET_VERSION="${TARGET_VERSION:-}"
REVOKE_SHARES="${REVOKE_SHARES:-false}"

if [[ -z "$ADMIN_API_TOKEN" ]]; then
  echo "[ERROR] ADMIN_API_TOKEN is required" >&2
  exit 1
fi

if [[ -z "$OPERATOR_ID" ]]; then
  echo "[ERROR] OPERATOR_ID is required" >&2
  exit 1
fi

if ! [[ "$OPERATOR_ID" =~ ^[a-zA-Z0-9_-]{1,128}$ ]]; then
  echo "[ERROR] OPERATOR_ID must be alphanumeric (CUID or UUID format)" >&2
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
{"targetVersion":${TARGET_VERSION},"operatorId":"${OPERATOR_ID}","revokeShares":${REVOKE_SHARES}}
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
