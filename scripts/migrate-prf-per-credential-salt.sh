#!/usr/bin/env bash
# A02-8: read-only diagnostic for the PRF per-credential salt rollout.
#
# Reports the v1 vs v2 split of PRF-enabled WebAuthn credentials so operators
# can track the deprecation of legacy v1 wraps (NULL prf_salt). Does NOT
# modify any data — runs SELECT only and is safe to run repeatedly.
#
# Usage:
#   MIGRATION_DATABASE_URL=postgres://... bash scripts/migrate-prf-per-credential-salt.sh
#
# Exit codes:
#   0 on success
#   non-zero on connection error or missing MIGRATION_DATABASE_URL
set -euo pipefail
: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is required}"

# Use a HEREDOC so the SQL is grep-auditable from this file alone.
# Forbidden verbs (UPDATE/INSERT/DELETE/TRUNCATE) MUST NOT appear here:
# the pre-pr.sh static check enforces this.
psql "$MIGRATION_DATABASE_URL" -At <<'SQL'
SELECT
  'v1_count'           AS metric, COUNT(*) FILTER (WHERE prf_supported AND prf_salt IS NULL)     AS value FROM webauthn_credentials
UNION ALL
SELECT
  'v2_count'           AS metric, COUNT(*) FILTER (WHERE prf_supported AND prf_salt IS NOT NULL) AS value FROM webauthn_credentials
UNION ALL
SELECT
  'prf_enabled_total'  AS metric, COUNT(*) FILTER (WHERE prf_supported)                          AS value FROM webauthn_credentials;
SQL
