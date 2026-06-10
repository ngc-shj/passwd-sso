#!/usr/bin/env bash
# Set the passwd_outbox_worker role password in an existing cluster.
#
# Usage:
#   MIGRATION_DATABASE_URL=<superuser-url> \
#   scripts/set-outbox-worker-password.sh <<< "$PASSWORD"
#
#   # k8s example (stdin from secret):
#   MIGRATION_DATABASE_URL=<superuser-url> \
#   kubectl exec --stdin ... -- bash scripts/set-outbox-worker-password.sh \
#     < <(kubectl get secret ... -o jsonpath='{.data.password}' | base64 -d)
#
# Environment variables:
#   MIGRATION_DATABASE_URL  (required) Superuser connection URL
#   DRY_RUN                 (optional) When set to "1", print the would-be psql
#                           command (password redacted) and exit 0 without
#                           invoking psql. For testing only.
#
# Flags:
#   --print-args-file <path>  (only honoured when DRY_RUN=1) Write the resolved
#                             psql args as a JSON array to <path> (mode 0600).
#                             Used by tests to assert the password reaches psql.
#
# Password input:
#   The password must be provided on stdin. If stdin is a tty or empty, the
#   script exits 1 with a structured error. This avoids password exposure via
#   shell history, kubectl audit logs, or `ps` output.
#
# Exit codes:
#   0 — success (or DRY_RUN=1 with valid input)
#   1 — error (missing env vars, missing stdin password, psql failure, etc.)

set -euo pipefail

MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-}"
DRY_RUN="${DRY_RUN:-}"
PRINT_ARGS_FILE=""

# Parse --print-args-file flag.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --print-args-file)
      shift
      PRINT_ARGS_FILE="${1:-}"
      shift
      ;;
    *)
      echo '{"level":"error","msg":"unknown flag","flag":"'"$1"'"}' >&2
      exit 1
      ;;
  esac
done

if [[ -z "$MIGRATION_DATABASE_URL" ]]; then
  echo '{"level":"error","msg":"MIGRATION_DATABASE_URL is required"}' >&2
  exit 1
fi

# Read password from stdin. Reject tty (interactive) or empty input.
if [[ -t 0 ]]; then
  echo '{"level":"error","msg":"password expected on stdin (use < <(...) or pipe)"}' >&2
  exit 1
fi

new_password="$(cat)"

if [[ -z "$new_password" ]]; then
  echo '{"level":"error","msg":"password expected on stdin (use < <(...) or pipe)"}' >&2
  exit 1
fi

# SQL-safe quoting: double every single quote in the password.
escaped="${new_password//\'/\'\'}"

if [[ "$DRY_RUN" == "1" ]]; then
  # Print sanitised representation (password redacted).
  echo "[DRY_RUN] would invoke: psql \"${MIGRATION_DATABASE_URL}\" -f - (stdin: ALTER ROLE passwd_outbox_worker WITH PASSWORD '<REDACTED>';)" >&2

  if [[ -n "$PRINT_ARGS_FILE" ]]; then
    # Write the generated stdin SQL (with quote-doubled password) to file for
    # test assertion only. umask 077 ensures mode 0600.
    (
      umask 077
      printf "ALTER ROLE passwd_outbox_worker WITH PASSWORD '%s';\n" "$escaped" > "$PRINT_ARGS_FILE"
    )
  fi
  exit 0
fi

psql "$MIGRATION_DATABASE_URL" -f - <<EOF
ALTER ROLE passwd_outbox_worker WITH PASSWORD '$escaped';
EOF

echo "[set-outbox-worker-password] OK — password updated for passwd_outbox_worker"
