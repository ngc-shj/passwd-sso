#!/usr/bin/env bash
# rls-cross-tenant-negative-test.sh — gate self-check
#
# Runs a Case 0 pre-flight calibration (canonical policy → exit 0) plus
# 16 distinct failure shapes to verify the cross-tenant verify SQL correctly
# detects each: cases 1-14 mutate an ephemeral throwaway table's own policy;
# cases 15-16 ALTER the REAL tenants_tenant_isolation policy itself (there is
# no throwaway stand-in for `tenants`) and run only with
# RLS_NEGATIVE_MUTATE_REAL_POLICY=1, which only the CI rls job sets — locally
# they SKIP rather than mutate a shared/persistent dev DB's tenants policy.
#   0. canonical policy + correct manifest (sanity: harness calibrated)
#   1. permissive symmetric → [E-RLS-COUNT-A]
#   2. asymmetric USING/WITH CHECK → [E-RLS-SYM]
#   3. NULL USING clause (FOR INSERT-only) → [E-RLS-NULL]
#   4. bypass branch neutered (AND false) → [E-RLS-BYPASS]
#   5. manifest drift (canonical policy + manifest missing throwaway) → [E-RLS-MANIFEST-MISSING]
#   6. manifest contains a name not in DB → [E-RLS-MANIFEST-EXTRA]
#   7. column-parity probe (tenant_id column without policy) → [E-RLS-COLPARITY]
#   8. FORCE ROW LEVEL SECURITY dropped on a tenant_isolation table → [E-RLS-FORCE]
#   9. SECURITY DEFINER function created in public schema → [E-RLS-SECDEF]
#   10. bypass branch names the wrong table → [E-RLS-BYPASS-TABLE]
#   11. pre-#911 admit-everything COALESCE branch → [E-RLS-BYPASS-TABLE]
#   12. bare call, no scalar sub-SELECT wrapper → [E-RLS-BYPASS-TABLE]
#   13. tenant branch casts app.tenant_id outside a sub-SELECT → [E-RLS-TENANT-INITPLAN]
#   14. the same cast commuted to the left of `=` → [E-RLS-TENANT-INITPLAN]
#   15. tenants_tenant_isolation's tenant branch dropped (#923) → [E-RLS-TENANTS-SEED]
#   16. tenants_tenant_isolation admits every row (#923) → [E-RLS-TENANTS]
#
# Codes NOT exercised here (acceptable coverage gaps):
#   - [E-RLS-COUNT-B]: structurally identical to [E-RLS-COUNT-A] (Block 3 mirrors Block 2).
#   - [E-RLS-DISCOVER]: requires REVOKE on system catalog which is fragile and rarely portable.
#   - [E-RLS-ROLE]: requires running the verify as a different role; covered by R21 verification not by this self-check.
#   - A WITH-CHECK-only widening of the tenants policy (USING left canonical,
#     WITH CHECK loosened) is not exercised: an asymmetric USING/WITH CHECK
#     trips [E-RLS-SYM] in Block 1 before the tenants-specific blocks ever
#     run, AND Block 1c's (c2) UPDATE re-points seeded A0 — whose cascading
#     children (FK-dependent rows seeded against A0) would then fail with an
#     uncoded, uninformative error under such a mutation rather than a
#     tenants-specific [E-RLS-*] code.
#
# Each case matches a stable error code (e.g., [E-RLS-NULL]), not freeform
# prose, so future EXCEPTION message wording changes do not silently break
# gate self-check coverage.
#
# Prerequisite: scripts/rls-cross-tenant-seed.sql must be applied (as
# passwd_user) before this script runs. Cases 0 and 4 invoke the full verify
# SQL which expects exactly 1 row per tenant in all 53 manifest tables — if
# the seed has not been applied, Block 2 fires [E-RLS-COUNT-A] before Cases
# 0/4 reach their target assertions. CI runs them in order (seed → coverage
# → verify → negative-test); local debugging must do the same.
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
# shellcheck source=lib/psql-safe.sh
source "$SCRIPT_DIR/lib/psql-safe.sh"
# shellcheck source=rls-verify-run.sh
# Sourced (not executed) for its rls_verify_check function — see that file's
# header for why this script applies it to output it already captured
# through psql_safe rather than calling rls-verify-run.sh as a subprocess.
source "$SCRIPT_DIR/rls-verify-run.sh"

# Trap-based cleanup: idempotent DROP. Fires on EXIT/ERR/INT/TERM (not SIGKILL).
# Drops BOTH the negative-test policy target AND the colparity probe table
# created by Case 7. Both DROPs are IF EXISTS so the trap is safe to fire
# before/after either table has been created.
cleanup() {
  # Unset when a URL was refused before the first connection; nothing to drop.
  if [[ -n "${MIG_URL:-}" ]]; then
    psql_safe "$MIG_URL" -v ON_ERROR_STOP=0 -q \
      -c "DROP TABLE IF EXISTS rls_negative_test CASCADE; DROP TABLE IF EXISTS rls_colparity_probe CASCADE; DROP FUNCTION IF EXISTS rls_negative_secdef_probe();" >/dev/null 2>&1 || true
  fi
  # Cases 15/16 fallback: unlike every other case, these ALTER the REAL
  # tenants_tenant_isolation policy (there is no throwaway table for
  # `tenants`). If the script exited between that ALTER and its own restore
  # (SIGINT, a failed assertion before the restore runs), reapply the
  # pre-ALTER snapshot here so a crashed run never leaves the real tenants
  # table running with a mutated policy. No-op (same text back) if the case
  # already restored successfully.
  if [[ -n "${MIG_URL:-}" && -n "${TENANTS_POLICY_QUAL_SNAPSHOT:-}" && -n "${TENANTS_POLICY_CHECK_SNAPSHOT:-}" ]]; then
    psql_safe "$MIG_URL" -v ON_ERROR_STOP=0 -q -c "
      ALTER POLICY tenants_tenant_isolation ON tenants
        USING ($TENANTS_POLICY_QUAL_SNAPSHOT)
        WITH CHECK ($TENANTS_POLICY_CHECK_SNAPSHOT);
    " >/dev/null 2>&1 || true
  fi
  # Last: the DROP above authenticates through the passfile.
  psql_safe_cleanup
}
trap cleanup EXIT INT TERM
psql_safe_url MIG_URL "$MIGRATION_DATABASE_URL"
psql_safe_url APP_URL "$APP_DATABASE_URL"

# Setup: create the ephemeral throwaway table and seed two tenant rows
# as passwd_user (SUPERUSER, bypasses RLS regardless of policy state).
# Inserting as SUPERUSER is ground truth — the test data exists no matter
# what the throwaway policy's WITH CHECK clause is.
psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
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

# Canonical policy: exactly the shape every real tenant_isolation policy uses
# post-#911 (migration 20261019000000) — the bypass branch is a scalar
# sub-SELECT naming the throwaway table itself.
# Case 0 (pre-flight) asserts a verify run under this policy + the
# manifest-with-throwaway exits 0. Case 5 reuses this so only manifest-parity
# fires (NOT cross-fired by stale Case 4 state).
CANONICAL_POLICY_SQL="CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR ALL USING ((SELECT public.rls_bypass_admits('rls_negative_test')) OR tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid)) WITH CHECK ((SELECT public.rls_bypass_admits('rls_negative_test')) OR tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid))"

# Build the manifest entries (whitespace-trimmed, comments stripped).
manifest_entries=$(awk 'NF && $1 !~ /^#/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0); print}' \
  "$MANIFEST_FILE" | paste -sd,)

# assert_only_expected_code <verify_output> <expected_code> <case_id>
#   Refuses a case whose output names any [E-RLS-*] code besides the one it
#   targets — an earlier block's defect masking the target block would
#   otherwise pass unnoticed as long as ITS code happened to also appear.
assert_only_expected_code() {
  local output="$1" expected="$2" case_id="$3"
  local other
  other=$(grep -oE '\[E-RLS-[A-Z0-9-]+\]' <<<"$output" | sort -u | grep -vxF -- "$expected" || true)
  if [[ -n "$other" ]]; then
    printf 'FAIL case %s: verify output names code(s) other than the expected %s: %s\n' \
      "$case_id" "$expected" "$(tr '\n' ' ' <<<"$other")"
    return 1
  fi
  return 0
}

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

  # Reset to a clean policy slate, then apply the case's policy (single -c
  # call so both run in one connection / transaction).
  psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q \
    -c "DROP POLICY IF EXISTS rls_negative_test_tenant_isolation ON rls_negative_test; $create_policy_sql;"

  local expected_tables
  if [[ "$omit_throwaway_from_manifest" == "yes" ]]; then
    expected_tables="$manifest_entries"
  else
    expected_tables="${manifest_entries},rls_negative_test"
  fi

  # Run verify; capture exit and combined output.
  local verify_output ec
  verify_output=$(psql_safe "$APP_URL" -v ON_ERROR_STOP=1 \
    -v expected_tables="$expected_tables" \
    -f "$VERIFY_SQL" 2>&1) && ec=0 || ec=$?

  # Through the wrapper (scripts/rls-verify-run.sh): asserts the WARNING set
  # each RLS-MARKER-delimited region of verify.sql promises. A no-op when no
  # marker appears in $verify_output, which is every case except Case 0 —
  # ON_ERROR_STOP=1 means a broken-policy case fails well before Block 4/4b.
  local marker_mismatch
  marker_mismatch=$(rls_verify_check "$verify_output")
  if [[ -n "$marker_mismatch" ]]; then
    printf 'FAIL case %s: WARNING-set mismatch:%s\n' "$case_id" "$marker_mismatch"
    return 1
  fi

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
# (the OR true admits both A and B rows under SET LOCAL app.tenant_id=A).
# Keeps the sub-SELECT form so BYPASS-TABLE passes and the mutation reaches
# Block 2 as intended (R5-M1).
run_negative_case 1 \
  "CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR ALL USING ((SELECT public.rls_bypass_admits('rls_negative_test')) OR true) WITH CHECK ((SELECT public.rls_bypass_admits('rls_negative_test')) OR true)" \
  "[E-RLS-COUNT-A]" \
  "no" || total_failures=$((total_failures + 1))

# Case 2: asymmetric USING vs WITH CHECK → Block 1 [E-RLS-SYM]. [E-RLS-SYM]
# runs before [E-RLS-BYPASS-TABLE] in Block 1, so WITH CHECK (true) (which
# would also fail BYPASS-TABLE) never gets that far.
run_negative_case 2 \
  "CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR ALL USING (tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid) OR (SELECT public.rls_bypass_admits('rls_negative_test'))) WITH CHECK (true)" \
  "[E-RLS-SYM]" \
  "no" || total_failures=$((total_failures + 1))

# Case 3: NULL USING clause via FOR INSERT-only legacy form (polqual NULL,
# polwithcheck non-NULL) → Block 1 [E-RLS-NULL] (fires BEFORE [E-RLS-SYM]
# per the documented ordering).
run_negative_case 3 \
  "CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR INSERT WITH CHECK (true)" \
  "[E-RLS-NULL]" \
  "no" || total_failures=$((total_failures + 1))

# Case 4: bypass clause neutered → Block 4 count fails (count=0 with
# bypass=on, tenant_id=nil-sentinel). Keeps the sub-SELECT call (so
# BYPASS-TABLE passes) but ANDs it with false, so the bypass branch
# structurally exists yet never actually admits; the OR tenant-filter tail
# is kept so Block 2/3 (which use a real tenant_id, not bypass) still pass
# and the mutation reaches Block 4 as intended (R5-M1).
run_negative_case 4 \
  "CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR ALL USING (((SELECT public.rls_bypass_admits('rls_negative_test')) AND false) OR tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid)) WITH CHECK (((SELECT public.rls_bypass_admits('rls_negative_test')) AND false) OR tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid))" \
  "[E-RLS-BYPASS]" \
  "no" || total_failures=$((total_failures + 1))

# Case 5: manifest drift — canonical policy (so Block 2/3/4 all pass), but
# manifest is missing the throwaway → Block 1 [E-RLS-MANIFEST-MISSING].
run_negative_case 5 \
  "$CANONICAL_POLICY_SQL" \
  "[E-RLS-MANIFEST-MISSING]" \
  "yes" || total_failures=$((total_failures + 1))

# Case 6: manifest contains a name not in DB → Block 1 [E-RLS-MANIFEST-EXTRA].
# Reuses canonical policy (so Block 2/3/4 don't pre-empt) and passes a manifest
# that includes a phantom table name. Custom helper rather than run_negative_case
# because we need to inject the phantom into expected_tables, not just toggle
# the throwaway in/out.
run_case_6_manifest_extra() {
  psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q \
    -c "DROP POLICY IF EXISTS rls_negative_test_tenant_isolation ON rls_negative_test; $CANONICAL_POLICY_SQL;"
  local expected_tables="${manifest_entries},rls_negative_test,rls_phantom_not_in_db"
  local out ec
  out=$(psql_safe "$APP_URL" -v ON_ERROR_STOP=1 \
    -v expected_tables="$expected_tables" \
    -f "$VERIFY_SQL" 2>&1) && ec=0 || ec=$?
  if (( ec == 0 )); then
    printf 'FAIL case 6: verify exited 0 against manifest with phantom table — gate is broken\n'
    return 1
  fi
  if ! grep -qF -- "[E-RLS-MANIFEST-EXTRA]" <<<"$out"; then
    printf 'FAIL case 6: verify failed but expected code [E-RLS-MANIFEST-EXTRA] not found in output:\n%s\n' "$out"
    return 1
  fi
  printf 'PASS case 6 (matched [E-RLS-MANIFEST-EXTRA])\n'
}
run_case_6_manifest_extra || total_failures=$((total_failures + 1))

# Case 7: column-parity mismatch — a separate probe table has tenant_id column
# but NO tenant_isolation policy → Block 1 [E-RLS-COLPARITY] fires before the
# manifest assertions because COLPARITY runs earlier in Block 1's load-bearing
# order. Probe is created in this case body and dropped after; the trap also
# drops it as a safety net.
run_case_7_colparity() {
  # Reset to canonical policy so SYM/NULL pass.
  psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q \
    -c "DROP POLICY IF EXISTS rls_negative_test_tenant_isolation ON rls_negative_test; $CANONICAL_POLICY_SQL;"
  # Create the column-only probe.
  psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q -c "
    DROP TABLE IF EXISTS rls_colparity_probe CASCADE;
    CREATE TABLE rls_colparity_probe (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL);
  "
  # Manifest includes rls_negative_test but NOT the probe — discovery returns
  # 53 + 1 = 54 (matches manifest), columns return 53 + 1 (negative_test) +
  # 1 (probe) = 55. So COLPARITY: column count 55 != discovery count 54.
  local expected_tables="${manifest_entries},rls_negative_test"
  local out ec
  out=$(psql_safe "$APP_URL" -v ON_ERROR_STOP=1 \
    -v expected_tables="$expected_tables" \
    -f "$VERIFY_SQL" 2>&1) && ec=0 || ec=$?
  # Drop probe regardless (trap also covers).
  psql_safe "$MIG_URL" -v ON_ERROR_STOP=0 -q \
    -c "DROP TABLE IF EXISTS rls_colparity_probe CASCADE;" >/dev/null 2>&1 || true
  if (( ec == 0 )); then
    printf 'FAIL case 7: verify exited 0 with extra column-without-policy — gate is broken\n'
    return 1
  fi
  if ! grep -qF -- "[E-RLS-COLPARITY]" <<<"$out"; then
    printf 'FAIL case 7: verify failed but expected code [E-RLS-COLPARITY] not found in output:\n%s\n' "$out"
    return 1
  fi
  printf 'PASS case 7 (matched [E-RLS-COLPARITY])\n'
}
run_case_7_colparity || total_failures=$((total_failures + 1))

# Case 8: FORCE ROW LEVEL SECURITY dropped on rls_negative_test → Block 1
# [E-RLS-FORCE] fires before manifest assertions because FORCE check runs in
# Block 1 after column parity. Restores FORCE after the case so subsequent
# runs (or trap-clean re-creates) start from a known-good state.
run_case_8_force_rls() {
  # Reset to canonical policy + drop FORCE.
  psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q \
    -c "DROP POLICY IF EXISTS rls_negative_test_tenant_isolation ON rls_negative_test; $CANONICAL_POLICY_SQL;
        ALTER TABLE rls_negative_test NO FORCE ROW LEVEL SECURITY;"
  local expected_tables="${manifest_entries},rls_negative_test"
  local out ec
  out=$(psql_safe "$APP_URL" -v ON_ERROR_STOP=1 \
    -v expected_tables="$expected_tables" \
    -f "$VERIFY_SQL" 2>&1) && ec=0 || ec=$?
  # Restore FORCE before returning regardless of result.
  psql_safe "$MIG_URL" -v ON_ERROR_STOP=0 -q \
    -c "ALTER TABLE rls_negative_test FORCE ROW LEVEL SECURITY;" >/dev/null 2>&1 || true
  if (( ec == 0 )); then
    printf 'FAIL case 8: verify exited 0 with FORCE RLS dropped — gate is broken\n'
    return 1
  fi
  if ! grep -qF -- "[E-RLS-FORCE]" <<<"$out"; then
    printf 'FAIL case 8: verify failed but expected code [E-RLS-FORCE] not found in output:\n%s\n' "$out"
    return 1
  fi
  printf 'PASS case 8 (matched [E-RLS-FORCE])\n'
}
run_case_8_force_rls || total_failures=$((total_failures + 1))

# Case 9: SECURITY DEFINER function created in public schema → Block 1
# [E-RLS-SECDEF]. Function is owned by passwd_user (created via SUPERUSER
# connection) and immediately becomes an RLS-bypass surface. Trap also
# drops the function as a safety net.
run_case_9_secdef() {
  # Reset to canonical policy so SYM/NULL/COUNT/COLPARITY all pass.
  psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q \
    -c "DROP POLICY IF EXISTS rls_negative_test_tenant_isolation ON rls_negative_test; $CANONICAL_POLICY_SQL;"
  # Create a minimal SECURITY DEFINER function in public.
  psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q -c "
    CREATE OR REPLACE FUNCTION rls_negative_secdef_probe() RETURNS int AS \$\$
      SELECT 1;
    \$\$ LANGUAGE sql SECURITY DEFINER;
  "
  local expected_tables="${manifest_entries},rls_negative_test"
  local out ec
  out=$(psql_safe "$APP_URL" -v ON_ERROR_STOP=1 \
    -v expected_tables="$expected_tables" \
    -f "$VERIFY_SQL" 2>&1) && ec=0 || ec=$?
  # Drop the probe function regardless (trap also covers).
  psql_safe "$MIG_URL" -v ON_ERROR_STOP=0 -q \
    -c "DROP FUNCTION IF EXISTS rls_negative_secdef_probe();" >/dev/null 2>&1 || true
  if (( ec == 0 )); then
    printf 'FAIL case 9: verify exited 0 with SECURITY DEFINER function present — gate is broken\n'
    return 1
  fi
  if ! grep -qF -- "[E-RLS-SECDEF]" <<<"$out"; then
    printf 'FAIL case 9: verify failed but expected code [E-RLS-SECDEF] not found in output:\n%s\n' "$out"
    return 1
  fi
  printf 'PASS case 9 (matched [E-RLS-SECDEF])\n'
}
run_case_9_secdef || total_failures=$((total_failures + 1))

# Case 10: bypass branch names the wrong table → Block 1 [E-RLS-BYPASS-TABLE].
# Mutates only rls_negative_test's own policy; never public.rls_bypass_admits.
run_negative_case 10 \
  "CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR ALL USING ((SELECT public.rls_bypass_admits('wrong_table')) OR tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid)) WITH CHECK ((SELECT public.rls_bypass_admits('wrong_table')) OR tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid))" \
  "[E-RLS-BYPASS-TABLE]" \
  "no" || total_failures=$((total_failures + 1))

# Case 11: pre-#911 admit-everything COALESCE branch (never rewritten by the
# migration, or reverted by a later hand-edit) → Block 1 [E-RLS-BYPASS-TABLE].
run_negative_case 11 \
  "CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR ALL USING ((COALESCE(current_setting('app.bypass_rls', true), '') = 'on') OR tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid)) WITH CHECK ((COALESCE(current_setting('app.bypass_rls', true), '') = 'on') OR tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid))" \
  "[E-RLS-BYPASS-TABLE]" \
  "no" || total_failures=$((total_failures + 1))

# Case 12: bare call, no scalar sub-SELECT wrapper (loses the InitPlan
# materialization #911 relies on) → Block 1 [E-RLS-BYPASS-TABLE].
run_negative_case 12 \
  "CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR ALL USING (public.rls_bypass_admits('rls_negative_test') OR tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid)) WITH CHECK (public.rls_bypass_admits('rls_negative_test') OR tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid))" \
  "[E-RLS-BYPASS-TABLE]" \
  "no" || total_failures=$((total_failures + 1))

# Case 13: tenant branch casts app.tenant_id outside a sub-SELECT. Planning a
# bypassed statement then evaluates ''::uuid on a used connection → Block 1
# [E-RLS-TENANT-INITPLAN].
run_negative_case 13 \
  "CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR ALL USING ((SELECT public.rls_bypass_admits('rls_negative_test')) OR tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK ((SELECT public.rls_bypass_admits('rls_negative_test')) OR tenant_id = current_setting('app.tenant_id', true)::uuid)" \
  "[E-RLS-TENANT-INITPLAN]" \
  "no" || total_failures=$((total_failures + 1))

# Case 14: the same bare cast on the left of `=` → Block 1 [E-RLS-TENANT-INITPLAN].
run_negative_case 14 \
  "CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR ALL USING ((SELECT public.rls_bypass_admits('rls_negative_test')) OR current_setting('app.tenant_id', true)::uuid = tenant_id) WITH CHECK ((SELECT public.rls_bypass_admits('rls_negative_test')) OR current_setting('app.tenant_id', true)::uuid = tenant_id)" \
  "[E-RLS-TENANT-INITPLAN]" \
  "no" || total_failures=$((total_failures + 1))

# Cases 15 and 16 ALTER the REAL tenants_tenant_isolation policy (#923) — there
# is no throwaway stand-in for `tenants`. Each keeps USING and WITH CHECK
# identical and keeps the bypass sub-SELECT, so Block 1's [E-RLS-SYM] /
# [E-RLS-BYPASS-TABLE] pass and the mutation reaches the tenants blocks.
#
# The policy text is snapshotted via pg_get_expr ONCE, before case 15 (not
# per case) — case 16 must restore to the SAME known-good baseline case 15
# started from, never to whatever a prior case's restore left behind — and
# restored from that one snapshot immediately after each case, with the
# restored text asserted equal to it (same immediate-restore shape as
# run_case_8_force_rls for FORCE).
#
#   $1  case number
#   $2  expression used for both USING and WITH CHECK
#   $3  expected error code
#
# Sets TENANTS_RESTORE_OK=0 when either restore assertion (text equality, or
# the post-restore re-verify) fails, so the caller can refuse to run a
# further mutation against a tenants policy that may not have round-tripped.
run_tenants_policy_case() {
  local n="$1" expr="$2" expected="$3"

  psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q -c "
    ALTER POLICY tenants_tenant_isolation ON tenants
      USING ($expr)
      WITH CHECK ($expr);
  "

  local expected_tables="${manifest_entries},rls_negative_test"
  local out ec
  out=$(psql_safe "$APP_URL" -v ON_ERROR_STOP=1 \
    -v expected_tables="$expected_tables" \
    -f "$VERIFY_SQL" 2>&1) && ec=0 || ec=$?

  # Restore IMMEDIATELY — before any assertion below can return early and
  # leave the real tenants table running with the mutated policy.
  psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q -c "
    ALTER POLICY tenants_tenant_isolation ON tenants
      USING ($TENANTS_POLICY_QUAL_SNAPSHOT)
      WITH CHECK ($TENANTS_POLICY_CHECK_SNAPSHOT);
  "

  local restored_qual restored_check
  restored_qual=$(psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q -t -A -c "
    SELECT pg_get_expr(polqual, polrelid) FROM pg_catalog.pg_policy
    WHERE polname = 'tenants_tenant_isolation';
  ")
  restored_check=$(psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q -t -A -c "
    SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_catalog.pg_policy
    WHERE polname = 'tenants_tenant_isolation';
  ")
  if [[ "$restored_qual" != "$TENANTS_POLICY_QUAL_SNAPSHOT" || "$restored_check" != "$TENANTS_POLICY_CHECK_SNAPSHOT" ]]; then
    printf 'FAIL case %s: restored tenants_tenant_isolation text does not match the pre-ALTER snapshot\n' "$n"
    TENANTS_RESTORE_OK=0
    return 1
  fi

  # Text equality proves the ALTER round-tripped; it does not prove the
  # restored policy still PASSES verify. Re-run it once more against the
  # now-unmodified policy and require exit 0.
  local restore_verify_out restore_verify_ec
  restore_verify_out=$(psql_safe "$APP_URL" -v ON_ERROR_STOP=1 \
    -v expected_tables="$expected_tables" \
    -f "$VERIFY_SQL" 2>&1) && restore_verify_ec=0 || restore_verify_ec=$?
  if (( restore_verify_ec != 0 )); then
    printf 'FAIL case %s: verify did NOT pass after restoring the tenants policy. Output:\n%s\n' \
      "$n" "$restore_verify_out"
    TENANTS_RESTORE_OK=0
    return 1
  fi

  if (( ec == 0 )); then
    printf 'FAIL case %s: verify exited 0 with the tenants policy mutated — gate is broken\n' "$n"
    return 1
  fi
  if ! grep -qF -- "$expected" <<<"$out"; then
    printf 'FAIL case %s: verify failed but expected code %s not found in output:\n%s\n' "$n" "$expected" "$out"
    return 1
  fi
  # An earlier block's defect could mask whichever block this case targets —
  # refuse if any code OTHER than the expected one also appears.
  assert_only_expected_code "$out" "$expected" "$n" || return 1

  printf 'PASS case %s (matched %s)\n' "$n" "$expected"
}

# Cases 15/16 mutate the REAL tenants policy (case 16 opens every tenant row to
# a no-context session), so they need an explicit opt-in that only the CI rls
# job sets: a crashed run between an ALTER and its restore on a shared or
# persistent dev DB would leave the live tenants table running a broken
# policy, and CI=true alone is commonly exported locally. The trap's fallback
# restore (cleanup(), above) is a safety net, not a substitute for running this
# only against CI's ephemeral Postgres. Under GitHub Actions without the
# opt-in the run FAILS rather than skipping, so a CI job that loses the
# variable cannot report "examined nothing" as green.
if [[ "${RLS_NEGATIVE_MUTATE_REAL_POLICY:-}" != "1" ]]; then
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf 'FAIL cases 15/16: RLS_NEGATIVE_MUTATE_REAL_POLICY=1 is not set in CI\n'
    total_failures=$((total_failures + 1))
  else
    printf 'SKIP cases 15/16: tenants-policy mutation cases need RLS_NEGATIVE_MUTATE_REAL_POLICY=1 (CI only)\n'
  fi
else
  # Snapshot the canonical tenants policy text ONCE, before either case.
  TENANTS_POLICY_QUAL_SNAPSHOT=$(psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q -t -A -c "
    SELECT pg_get_expr(polqual, polrelid) FROM pg_catalog.pg_policy
    WHERE polname = 'tenants_tenant_isolation';
  ")
  TENANTS_POLICY_CHECK_SNAPSHOT=$(psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q -t -A -c "
    SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_catalog.pg_policy
    WHERE polname = 'tenants_tenant_isolation';
  ")
  if [[ -z "$TENANTS_POLICY_QUAL_SNAPSHOT" || -z "$TENANTS_POLICY_CHECK_SNAPSHOT" ]]; then
    printf 'FAIL tenants-policy cases: could not snapshot tenants_tenant_isolation (policy missing?)\n'
    total_failures=$((total_failures + 1))
  elif [[ "$TENANTS_POLICY_QUAL_SNAPSHOT" != "$TENANTS_POLICY_CHECK_SNAPSHOT" ]]; then
    printf 'FAIL tenants-policy cases: canonical USING and WITH CHECK text differ — not the symmetric shape #923 expects:\nUSING: %s\nWITH CHECK: %s\n' \
      "$TENANTS_POLICY_QUAL_SNAPSHOT" "$TENANTS_POLICY_CHECK_SNAPSHOT"
    total_failures=$((total_failures + 1))
  elif [[ "$TENANTS_POLICY_QUAL_SNAPSHOT" != *"rls_bypass_admits('tenants'::text)"* ]] \
    || [[ "$TENANTS_POLICY_QUAL_SNAPSHOT" != *"SELECT (current_setting('app.tenant_id'::text, true))"* ]]; then
    printf 'FAIL tenants-policy cases: canonical text is not the migration shape (bypass call / tenant-id cast missing a sub-SELECT):\n%s\n' \
      "$TENANTS_POLICY_QUAL_SNAPSHOT"
    total_failures=$((total_failures + 1))
  else
    # Tenants-policy calibration (T1): case 14 leaves rls_negative_test's OWN
    # policy INITPLAN-violating — reset it to canonical (the exact DROP+CREATE
    # run_negative_case uses) so Block 1 cannot fail on rls_negative_test
    # before the tenants-targeted mutations below ever run. Then verify once
    # against the UNMODIFIED tenants policy and require exit 0: this proves
    # the harness reaches the end cleanly BEFORE any tenants mutation, so a
    # fatal failure in case 15/16 is attributable to that case's own ALTER,
    # not to leftover state from an earlier case.
    psql_safe "$MIG_URL" -v ON_ERROR_STOP=1 -q \
      -c "DROP POLICY IF EXISTS rls_negative_test_tenant_isolation ON rls_negative_test; $CANONICAL_POLICY_SQL;"

    calibration_tables="${manifest_entries},rls_negative_test"
    calibration_out=$(psql_safe "$APP_URL" -v ON_ERROR_STOP=1 \
      -v expected_tables="$calibration_tables" \
      -f "$VERIFY_SQL" 2>&1) && calibration_ec=0 || calibration_ec=$?
    if (( calibration_ec != 0 )); then
      printf 'FAIL tenants-policy calibration: verify did NOT pass with the canonical tenants policy still in place. Output:\n%s\n' \
        "$calibration_out"
      total_failures=$((total_failures + 1))
    else
      printf 'PASS tenants-policy calibration (verify exits 0 before any tenants mutation)\n'

      # Case 15: tenant branch dropped. A no-context read still sees nothing,
      # so the fatal Block 1b passes and the seed-dependent Block 1c fails:
      # scope A0 no longer sees its own row (CI seeds A0/B0).
      TENANTS_RESTORE_OK=1
      run_tenants_policy_case 15 \
        "(SELECT public.rls_bypass_admits('tenants'))" \
        "[E-RLS-TENANTS-SEED]" || total_failures=$((total_failures + 1))

      if [[ "$TENANTS_RESTORE_OK" == "1" ]]; then
        # Case 16: policy admits every row. A no-context read now sees
        # tenants, so the fatal Block 1b fails before Block 1c runs.
        run_tenants_policy_case 16 \
          "(SELECT public.rls_bypass_admits('tenants')) OR true" \
          "[E-RLS-TENANTS]" || total_failures=$((total_failures + 1))
      else
        printf 'SKIP case 16: case 15 left the tenants policy restore unverified — refusing a further mutation on top of it\n'
      fi
    fi
  fi
fi

if (( total_failures > 0 )); then
  printf '\n%d negative-test cases failed.\n' "$total_failures"
  exit 1
fi

printf '\nAll negative-test cases PASS.\n'
