#!/usr/bin/env bash
# Set the passwd_outbox_worker role password in an existing cluster.
#
# Usage:
#   MIGRATION_DATABASE_URL=<superuser-url> \
#   scripts/set-outbox-worker-password.sh < <(printf '%s' "$PASSWORD")
#
#   # k8s example (stdin from secret):
#   MIGRATION_DATABASE_URL=<superuser-url> \
#   kubectl exec --stdin ... -- bash scripts/set-outbox-worker-password.sh \
#     < <(kubectl get secret ... -o jsonpath='{.data.password}' | base64 -d)
#
#   Not `<<< "$PASSWORD"`: bash before 5.1 backs a here-string with a temp file.
#
# The server receives a SCRAM-SHA-256 verifier, never the password (see
# scripts/lib/set-role-password.sh). On a superuser connection statement logging
# and pg_stat_statements are off for the session; on a non-superuser one (a
# managed-database admin) the verifier can still be logged under
# `log_statement = ddl|all` or on a refused statement, and kept by
# pg_stat_statements. The password must be ASCII with no line break.
#
# Environment variables:
#   MIGRATION_DATABASE_URL  (required) Superuser connection URL (an admin role
#                           that may ALTER the role works, with the residual above)
#   DRY_RUN                 (optional) When set to "1", print the would-be psql
#                           command (verifier redacted) and exit 0 without
#                           connecting. For testing only.
#
# Flags:
#   --print-args-file <path>  (only honoured when DRY_RUN=1) Write the generated
#                             stdin SQL to a NEW file at <path> (mode 0600; an
#                             existing path is refused). Test-only.
#
# Requires psql and node.
#
# Exit codes:
#   0 — success (or DRY_RUN=1 with valid input)
#   1 — error (missing env vars, refused password, psql failure, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/psql-safe.sh
source "$SCRIPT_DIR/lib/psql-safe.sh"
# shellcheck source=lib/set-role-password.sh
source "$SCRIPT_DIR/lib/set-role-password.sh"

set_role_password passwd_outbox_worker set-outbox-worker-password "$@"
