#!/usr/bin/env bash
# rls-cross-tenant-negative-test.sh — gate self-check
#
# Runs a Case 0 pre-flight calibration (canonical policy → exit 0) plus
# 5 distinct failure shapes against an ephemeral throwaway table to verify
# the cross-tenant verify SQL correctly detects each:
#   0. canonical policy + correct manifest (sanity: harness calibrated)
#   1. permissive symmetric → [E-RLS-COUNT-A]
#   2. asymmetric USING/WITH CHECK → [E-RLS-SYM]
#   3. NULL USING clause (FOR INSERT-only) → [E-RLS-NULL]
#   4. dropped bypass clause → [E-RLS-BYPASS]
#   5. manifest drift (canonical policy + manifest missing throwaway) → [E-RLS-MANIFEST-MISSING]
#
# Each case matches a stable error code (e.g., [E-RLS-NULL]), not freeform
# prose, so future EXCEPTION message wording changes do not silently break
# gate self-check coverage.
#
# Mechanism: --variable override (no manifest file mutation). The script
# builds EXPECTED_TABLES in-process, appending the throwaway table name
# to the manifest contents (or omitting it for case 5) and passes via
# `psql -v expected_tables=...`. The manifest file on disk is never modified.
#
# CI safety:
# - This script MUST run sequentially in rls-smoke. Do NOT parallelize
#   with other DB-touching steps — the throwaway policy is committed
#   global state for the duration of each case.
# - Trap fires on EXIT/ERR/INT/TERM but NOT SIGKILL. CI Postgres is
#   ephemeral so a leaked throwaway table is discarded with the runner.
#   Do NOT run against a shared/persistent DB without modification.
#
# Required env vars:
#   MIGRATION_DATABASE_URL — passwd_user (SUPERUSER) connection string
#   APP_DATABASE_URL       — passwd_app  (NOSUPERUSER) connection string

set -euo pipefail

: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL must be set (passwd_user URL)}"
: "${APP_DATABASE_URL:?APP_DATABASE_URL must be set (passwd_app URL)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_FILE="$SCRIPT_DIR/rls-cross-tenant-tables.manifest"
VERIFY_SQL="$SCRIPT_DIR/rls-cross-tenant-verify.sql"

# Trap-based cleanup: idempotent DROP. Fires on EXIT/ERR/INT/TERM (not SIGKILL).
cleanup() {
  psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=0 -q \
    -c "DROP TABLE IF EXISTS rls_negative_test CASCADE;" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Setup: create the ephemeral throwaway table and seed two tenant rows
# as passwd_user (SUPERUSER, bypasses RLS regardless of policy state).
# Inserting as SUPERUSER is ground truth — the test data exists no matter
# what the throwaway policy's WITH CHECK clause is.
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DROP TABLE IF EXISTS rls_negative_test CASCADE;
CREATE TABLE rls_negative_test (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL
);
ALTER TABLE rls_negative_test ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_negative_test FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON rls_negative_test TO passwd_app;
INSERT INTO rls_negative_test (tenant_id) VALUES
  ('00000000-0000-0000-0000-0000000000A0'),
  ('00000000-0000-0000-0000-0000000000B0');
SQL

# Canonical policy: exactly the shape every real tenant_isolation policy uses.
# Case 0 (pre-flight) asserts a verify run under this policy + the
# manifest-with-throwaway exits 0. Case 5 reuses this so only manifest-parity
# fires (NOT cross-fired by stale Case 4 state).
CANONICAL_POLICY_SQL="CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR ALL USING ((current_setting('app.bypass_rls', true) = 'on') OR tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK ((current_setting('app.bypass_rls', true) = 'on') OR tenant_id = current_setting('app.tenant_id', true)::uuid)"

# Build the manifest entries (whitespace-trimmed, comments stripped).
manifest_entries=$(awk 'NF && $1 !~ /^#/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0); print}' \
  "$MANIFEST_FILE" | paste -sd,)

# run_negative_case <case_id> <create_policy_sql> <expected_code> <omit_throwaway_from_manifest>
#   case_id                 : human label for log lines
#   create_policy_sql       : full CREATE POLICY DDL fragment (already includes the policy name + table)
#   expected_code           : stable [E-RLS-*] code; empty string means "expect exit 0" (Case 0)
#   omit_throwaway_from_manifest: "yes" to omit, anything else (default "no") to include
run_negative_case() {
  local case_id="$1"
  local create_policy_sql="$2"
  local expected_code="$3"
  local omit_throwaway_from_manifest="${4:-no}"

  # Reset to a clean policy slate, then apply the case's policy.
  psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -q \
    -c "DROP POLICY IF EXISTS rls_negative_test_tenant_isolation ON rls_negative_test;"
  psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -q \
    -c "$create_policy_sql"

  local expected_tables
  if [[ "$omit_throwaway_from_manifest" == "yes" ]]; then
    expected_tables="$manifest_entries"
  else
    expected_tables="${manifest_entries},rls_negative_test"
  fi

  # Run verify; capture exit and combined output.
  local verify_output ec
  verify_output=$(psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 \
    -v expected_tables="$expected_tables" \
    -f "$VERIFY_SQL" 2>&1) && ec=0 || ec=$?

  if [[ -z "$expected_code" ]]; then
    # Case 0: expect exit 0 (calibration).
    if (( ec != 0 )); then
      printf 'FAIL case %s: pre-flight calibration verify did NOT pass under canonical policy. Output:\n%s\n' \
        "$case_id" "$verify_output"
      return 1
    fi
    printf 'PASS case %s (pre-flight calibration)\n' "$case_id"
    return 0
  fi

  if (( ec == 0 )); then
    printf 'FAIL case %s: verify exited 0 against deliberately-broken policy — gate is broken (vacuous pass)\n' \
      "$case_id"
    return 1
  fi

  # Match against stable error code, not freeform prose.
  if ! grep -qF -- "$expected_code" <<<"$verify_output"; then
    printf 'FAIL case %s: verify failed but expected code %s not found in output:\n%s\n' \
      "$case_id" "$expected_code" "$verify_output"
    return 1
  fi

  printf 'PASS case %s (matched %s)\n' "$case_id" "$expected_code"
}

# Driver: accumulate failures, run all cases, exit with count.
total_failures=0

# Case 0: canonical policy + correct manifest → exit 0 (sanity).
run_negative_case 0 \
  "$CANONICAL_POLICY_SQL" \
  "" \
  "no" || total_failures=$((total_failures + 1))

# Case 1: permissive symmetric → Block 2 count fails for tenant A
# (USING (true) admits both A and B rows under SET LOCAL app.tenant_id=A).
run_negative_case 1 \
  "CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR ALL USING (true) WITH CHECK (true)" \
  "[E-RLS-COUNT-A]" \
  "no" || total_failures=$((total_failures + 1))

# Case 2: asymmetric USING vs WITH CHECK → Block 1 [E-RLS-SYM].
run_negative_case 2 \
  "CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (true)" \
  "[E-RLS-SYM]" \
  "no" || total_failures=$((total_failures + 1))

# Case 3: NULL USING clause via FOR INSERT-only legacy form (polqual NULL,
# polwithcheck non-NULL) → Block 1 [E-RLS-NULL] (fires BEFORE [E-RLS-SYM]
# per the documented ordering).
run_negative_case 3 \
  "CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR INSERT WITH CHECK (true)" \
  "[E-RLS-NULL]" \
  "no" || total_failures=$((total_failures + 1))

# Case 4: bypass clause dropped → Block 4 count fails (count=0 with bypass=on).
run_negative_case 4 \
  "CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)" \
  "[E-RLS-BYPASS]" \
  "no" || total_failures=$((total_failures + 1))

# Case 5: manifest drift — canonical policy (so Block 2/3/4 all pass), but
# manifest is missing the throwaway → Block 1 [E-RLS-MANIFEST-MISSING].
run_negative_case 5 \
  "$CANONICAL_POLICY_SQL" \
  "[E-RLS-MANIFEST-MISSING]" \
  "yes" || total_failures=$((total_failures + 1))

if (( total_failures > 0 )); then
  printf '\n%d negative-test cases failed.\n' "$total_failures"
  exit 1
fi

printf '\nAll negative-test cases PASS.\n'
