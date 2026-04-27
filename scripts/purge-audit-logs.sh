#!/usr/bin/env bash
# System-wide audit log purge.
#
# Usage:
#   ADMIN_API_TOKEN=<op_token> scripts/purge-audit-logs.sh
#
# Mint an operator token at /dashboard/tenant/operator-tokens. The token's
# subject (the user it authenticates as) is bound at issuance time; no
# separate operatorId env var is needed.
#
# Environment variables:
#   ADMIN_API_TOKEN  (required) Per-operator op_* bearer token (op_<43-base64url>)
#   APP_URL          (optional) Application URL (default: http://localhost:3000)
#   RETENTION_DAYS   (optional) Days of audit logs to retain (default: 365)
#   DRY_RUN          (optional) Set to "true" for a dry run (default: false)
#   INSECURE         (optional) Skip TLS certificate verification (default: false)
#
# Exit codes:
#   0 — success
#   1 — error (missing env vars, HTTP error, etc.)

set -euo pipefail

APP_URL="${APP_URL:-http://localhost:3000}"
ADMIN_API_TOKEN="${ADMIN_API_TOKEN:-}"
RETENTION_DAYS="${RETENTION_DAYS:-365}"
DRY_RUN="${DRY_RUN:-false}"

if ! [[ "$ADMIN_API_TOKEN" =~ ^op_[A-Za-z0-9_-]{43}$ ]]; then
  echo "[ERROR] ADMIN_API_TOKEN must be op_<43-base64url> (mint via /dashboard/tenant/operator-tokens)" >&2
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
{"retentionDays":${RETENTION_DAYS},"dryRun":${DRY_RUN}}
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

RESPONSE=$(curl "${CURL_OPTS[@]}" "${APP_URL}/api/maintenance/purge-audit-logs")

HTTP_STATUS=$(printf '%s' "$RESPONSE" | tail -n1)
BODY_RESPONSE=$(printf '%s' "$RESPONSE" | sed '$d')

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "[ERROR] purge-audit-logs returned HTTP ${HTTP_STATUS}: ${BODY_RESPONSE}" >&2
  exit 1
fi

if [[ "$DRY_RUN" == "true" ]]; then
  MATCHED=$(printf '%s' "$BODY_RESPONSE" | grep -o '"matched":[0-9]*' | cut -d: -f2)
  echo "[purge-audit-logs] DRY RUN — ${MATCHED:-unknown} records would be purged (retentionDays=${RETENTION_DAYS})"
else
  PURGED=$(printf '%s' "$BODY_RESPONSE" | grep -o '"purged":[0-9]*' | cut -d: -f2)
  echo "[purge-audit-logs] OK — purged ${PURGED:-unknown} records (retentionDays=${RETENTION_DAYS})"
fi
