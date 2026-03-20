#!/usr/bin/env bash
# System-wide password entry history purge.
#
# Usage:
#   ADMIN_API_TOKEN=<hex64> OPERATOR_ID=<user-uuid> scripts/purge-history.sh
#
# Environment variables:
#   ADMIN_API_TOKEN  (required) Admin bearer token (64-char hex)
#   OPERATOR_ID      (required) User ID of the admin performing the purge
#   APP_URL          (optional) Application URL (default: http://localhost:3000)
#   RETENTION_DAYS   (optional) Days of history to retain (default: 90)
#   DRY_RUN          (optional) Set to "true" for a dry run (default: false)
#   INSECURE         (optional) Skip TLS certificate verification (default: false)
#
# Exit codes:
#   0 — success
#   1 — error (missing env vars, HTTP error, etc.)

set -euo pipefail

APP_URL="${APP_URL:-http://localhost:3000}"
ADMIN_API_TOKEN="${ADMIN_API_TOKEN:-}"
OPERATOR_ID="${OPERATOR_ID:-}"
RETENTION_DAYS="${RETENTION_DAYS:-90}"
DRY_RUN="${DRY_RUN:-false}"

if [[ -z "$ADMIN_API_TOKEN" ]]; then
  echo "[ERROR] ADMIN_API_TOKEN is required" >&2
  exit 1
fi

if ! [[ "$OPERATOR_ID" =~ ^[a-zA-Z0-9_-]{1,128}$ ]]; then
  echo "[ERROR] OPERATOR_ID must be alphanumeric (CUID or UUID format)" >&2
  exit 1
fi

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "[ERROR] RETENTION_DAYS must be a non-negative integer" >&2
  exit 1
fi

if [[ "$DRY_RUN" != "true" && "$DRY_RUN" != "false" ]]; then
  echo "[ERROR] DRY_RUN must be 'true' or 'false'" >&2
  exit 1
fi

BODY=$(cat <<EOJSON
{"operatorId":"${OPERATOR_ID}","retentionDays":${RETENTION_DAYS},"dryRun":${DRY_RUN}}
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

RESPONSE=$(curl "${CURL_OPTS[@]}" "${APP_URL}/api/maintenance/purge-history")

HTTP_STATUS=$(printf '%s' "$RESPONSE" | tail -n1)
BODY_RESPONSE=$(printf '%s' "$RESPONSE" | sed '$d')

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "[ERROR] purge-history returned HTTP ${HTTP_STATUS}: ${BODY_RESPONSE}" >&2
  exit 1
fi

if [[ "$DRY_RUN" == "true" ]]; then
  MATCHED=$(printf '%s' "$BODY_RESPONSE" | grep -o '"matched":[0-9]*' | cut -d: -f2)
  echo "[purge-history] DRY RUN — ${MATCHED:-unknown} records would be purged (retentionDays=${RETENTION_DAYS})"
else
  PURGED=$(printf '%s' "$BODY_RESPONSE" | grep -o '"purged":[0-9]*' | cut -d: -f2)
  echo "[purge-history] OK — purged ${PURGED:-unknown} records (retentionDays=${RETENTION_DAYS})"
fi
