#!/usr/bin/env bash
# Set the passwd_outbox_worker role password in an existing cluster.
#
# Usage:
#   PASSWD_OUTBOX_WORKER_PASSWORD=<password> \
#   MIGRATION_DATABASE_URL=<superuser-url> \
#   scripts/set-outbox-worker-password.sh
#
# Environment variables:
#   PASSWD_OUTBOX_WORKER_PASSWORD  (required) New password for the role
#   MIGRATION_DATABASE_URL         (required) Superuser connection URL
#
# Exit codes:
#   0 — success
#   1 — error (missing env vars, psql failure, etc.)

set -euo pipefail

PASSWD_OUTBOX_WORKER_PASSWORD="${PASSWD_OUTBOX_WORKER_PASSWORD:-}"
MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-}"

if [[ -z "$PASSWD_OUTBOX_WORKER_PASSWORD" ]]; then
  echo "[ERROR] PASSWD_OUTBOX_WORKER_PASSWORD is required" >&2
  exit 1
fi

if [[ -z "$MIGRATION_DATABASE_URL" ]]; then
  echo "[ERROR] MIGRATION_DATABASE_URL is required" >&2
  exit 1
fi

psql "$MIGRATION_DATABASE_URL" \
  -v new_password="$PASSWD_OUTBOX_WORKER_PASSWORD" \
  -c "ALTER ROLE passwd_outbox_worker WITH PASSWORD :'new_password';"

echo "[set-outbox-worker-password] OK — password updated for passwd_outbox_worker"
