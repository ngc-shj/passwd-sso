# Plan: Verify RLS Policy Predicate Correctness at Runtime

Issue: [#434](https://github.com/ngc-shj/passwd-sso/issues/434) — `ci(rls): verify RLS policy predicate correctness at runtime, not just grants`

## Project context

- **Type**: web app (Next.js 16 + Prisma + PostgreSQL 16) with multi-tenant RLS-based isolation. Change is CI / SQL-only (no application code).
- **Test infrastructure**: unit (Vitest) + integration (Vitest with real Postgres) + E2E (Playwright) + CI/CD (GitHub Actions). The RLS smoke test runs in `.github/workflows/ci.yml` job `rls-smoke`.
- **Runtime constraint**: target Postgres image is `postgres:16-alpine` in CI. No `pgTAP` extension is installed; we rely on `psql -v ON_ERROR_STOP=1` plus `DO $$ ... ASSERT ... $$` PL/pgSQL blocks.

## Objective

Add a CI-enforced **runtime** check that the `tenant_isolation` RLS policy on every tenant-scoped table actually filters by `tenant_id`. A migration that defined `CREATE POLICY ... USING (true)` (or omitted the predicate) would pass the existing `check-migration-drift.mjs` (presence) and `rls-smoke` (grants/visibility-without-GUC) checks while silently allowing cross-tenant reads.

## Requirements

### Functional (from issue acceptance criteria)

1. Seed two tenants `A` and `B` with **one row each** in every tenant-scoped table.
2. As `passwd_app` (NOSUPERUSER, NOBYPASSRLS), set `app.tenant_id = '<A>'` and `app.bypass_rls = ''` (off):
   - For every tenant-scoped table `T`: `SELECT count(*) FROM T` MUST return **exactly 1** (A's row).
3. Repeat with `app.tenant_id = '<B>'`: counts MUST remain exactly 1 each (B's row).
4. **Auto-discovery**: enumerate tenant-scoped tables from `pg_policy` (system catalog) cross-referenced with `information_schema.columns`. Do not hand-maintain a Node/SQL list of table names in the verify-step loop.
5. **Optional bypass-channel sanity**: with `app.bypass_rls = 'on'` AND `app.tenant_id` reset, counts MUST be exactly 2 (or 3 for `mcp_clients` — see §Special cases) — confirms the bypass GUC alone admits all seeded rows.
6. **Loud failure**: any deviation MUST exit non-zero with the offending table name in the error message. CI MUST fail red.

### Non-functional

- Run on CI with the existing `rls-smoke` Postgres service (no new container).
- Total added wall-clock under 2 min on the existing CI runner (~53 tables × 4 query passes + automated negative test).
- Locally runnable with `npm run docker:up` Postgres + the same psql commands.
- No new npm dependency.

### Out of scope

- WORM / external audit offload (issue says so).
- RLS policy refactor — verification only.
- Pure lexical inspection of policy expressions (runtime cross-tenant assertion is strictly stronger).
- Hardening `app.bypass_rls` against in-session `SET` by `passwd_app` (this is a soft GUC by design; documented in §Considerations; **follow-up issue tracked alongside this PR's merge**).

## Technical approach

### Discovery query — use `pg_policy` (not `pg_policies` view)

The view `pg_policies` includes a `pg_has_role(c.relowner, 'USAGE')` filter that hides policies on tables owned by roles the current user lacks USAGE on. In this project, all tables are owned by `passwd_user` (SUPERUSER) and `passwd_app` is intentionally NOT a member of `passwd_user`. The verify step runs as `passwd_app`. To avoid the role-filter pitfall, the discovery query reads the underlying catalog `pg_policy` directly (PUBLIC has SELECT on `pg_catalog` by default — verified during implementation pre-flight; see §Pre-merge verification):

```sql
-- Concrete discovery query (works as passwd_app)
SELECT c.relname AS table_name
FROM pg_catalog.pg_policy p
JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN information_schema.columns col
  ON col.table_schema = n.nspname
 AND col.table_name = c.relname
 AND col.column_name = 'tenant_id'
WHERE n.nspname = 'public'
  AND c.relname <> 'tenants'
  AND (p.polname = 'tenant_isolation' OR p.polname LIKE '%\_tenant_isolation' ESCAPE '\')
ORDER BY c.relname;
```

The OR-clause matches both the canonical `<table>_tenant_isolation` form AND the bare `tenant_isolation` form. **Empirical state**: as of plan-execution time, the `team_policies` policy was renamed from bare `tenant_isolation` to `team_policies_tenant_isolation` in migration `20260321110000_convert_id_columns_to_uuid_type` (line 531). All current `tenant_isolation` policies follow the suffix convention. The bare-name OR-branch is retained as defensive forward-compat — if a future migration introduces a bare-name policy, the discovery query covers it without code change. Confirm at implementation time via `SELECT polname FROM pg_catalog.pg_policy WHERE polname = 'tenant_isolation'` (expect 0 rows in the current schema; non-zero would mean a migration introduced one — manifest must include the corresponding table).

**Pre-merge verification**: before submitting the PR, the implementer must run, against a migrated test DB:
```sql
-- as passwd_app
SELECT count(*) FROM pg_catalog.pg_policy WHERE polname = 'tenant_isolation' OR polname LIKE '%\_tenant_isolation' ESCAPE '\';
```
Expected: ~53 (the count of tenant-scoped tables; `tenants` itself has no policy in the current schema). If this returns 0, `passwd_app` lacks SELECT on `pg_policy` and the plan needs a structural revision (likely a `GRANT SELECT ON pg_catalog.pg_policy TO passwd_app` step in the role-creation script). Empirical pre-flight (using `npm run docker:up`) confirms `passwd_app` does have SELECT on `pg_policy` by default. See §Pre-merge verification checklist. **Note**: the explicit pg_catalog GRANT, if needed, is information-disclosure-bounded — `passwd_app` already executes against these policies via RLS; seeing the *expression text* adds modest disclosure with no rights escalation.

### Tenant-scoped tables manifest (replaces a numeric floor)

Instead of a numeric `EXPECTED_MIN_TENANT_SCOPED_TABLES`, the plan commits a manifest file `scripts/rls-cross-tenant-tables.manifest` listing each tenant-scoped table on its own line. The verify step asserts the discovered table set EQUALS the manifest set (no `>=` — strict equality). Adding/removing a tenant-scoped table requires editing the manifest in the same PR; a one-line numeric decrement is replaced by an explicit table-name diff that's much harder for a reviewer to overlook.

```text
# scripts/rls-cross-tenant-tables.manifest
# One tenant-scoped table per line. Lines starting with # are comments.
# Adding a table: insert a line in alphabetical order. Removing a table requires
# REMOVING the policy AND the column AND the line here — three explicit deltas.
# All current tenant_isolation policies follow the <table>_tenant_isolation suffix convention.
# (Bare-name 'tenant_isolation' on team_policies was renamed in migration 20260321110000.)
# The discovery OR-branch for bare-name remains as defensive forward-compat.
access_requests
accounts
admin_vault_resets
api_keys
attachments
audit_chain_anchors
... (53 lines total — current count; reviewer-readable diffs replace the soft numeric floor)
webauthn_credentials
```

Block 1 of the verify SQL reads the manifest via `psql --variable` substitution. The shell pre-step builds `EXPECTED_TABLES` with whitespace-trimmed, sorted entries:

```bash
# In ci.yml step (and the negative-test wrapper appends `,rls_negative_test` to this value)
EXPECTED_TABLES=$(awk 'NF && $1 !~ /^#/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0); print}' \
  scripts/rls-cross-tenant-tables.manifest | paste -sd,)
psql -v ON_ERROR_STOP=1 -v expected_tables="$EXPECTED_TABLES" \
  "$APP_DATABASE_URL" -f scripts/rls-cross-tenant-verify.sql
```

The `awk` form trims leading/trailing whitespace per line (addresses F30/S20 — preserves loud-fail but improves DX) and skips blank/comment lines.

The verify SQL receives `:expected_tables` as a comma-separated string. **Use set-equality (not array equality)** — array `=` in PostgreSQL is order-sensitive, and we don't want to depend on alphabetical-ordering enforcement in the manifest. Block 1 asserts both directions of the symmetric difference:

```sql
-- manifest \\ discovery (extra in manifest, missing from DB)
ASSERT NOT EXISTS (
  SELECT m.t FROM unnest(string_to_array(:'expected_tables', ',')) AS m(t)
  EXCEPT
  SELECT c.relname FROM <discovery>
), format('Manifest has tables not in discovery: %s', (
  SELECT string_agg(m.t, ',')
  FROM unnest(string_to_array(:'expected_tables', ',')) AS m(t)
  WHERE m.t NOT IN (SELECT c.relname FROM <discovery>)
));

-- discovery \\ manifest (extra in DB, missing from manifest)
ASSERT NOT EXISTS (
  SELECT c.relname FROM <discovery>
  EXCEPT
  SELECT m.t FROM unnest(string_to_array(:'expected_tables', ',')) AS m(t)
), format('Discovery has tables not in manifest: %s', (
  SELECT string_agg(c.relname, ',')
  FROM <discovery>
  WHERE c.relname NOT IN (SELECT m.t FROM unnest(string_to_array(:'expected_tables', ',')) AS m(t))
));
```

The two-sided EXCEPT plus name-listing failure messages give precise attribution: the operator sees exactly which tables are extra/missing on which side.

This change addresses S3 / S5 / S12 / F18 from prior review rounds — eliminates the soft numeric floor; makes additions/removals explicit table-name diffs. F27/T22 from R3 — order-insensitive set comparison.

### Verification structure

Three new SQL artifacts plus one shell wrapper:

1. **`scripts/rls-cross-tenant-seed.sql`** — runs as `passwd_user` (SUPERUSER, bypasses RLS). Seeds tenants A (`00000000-0000-0000-0000-0000000000A0`) and B (`…000B0`) plus one row per tenant in every tenant-scoped table. **Special case**: `mcp_clients` also seeds a third row with `tenant_id = NULL`. Hand-maintained; child rows use `gen_random_uuid()`; only tenant + user IDs are deterministic.

2. **`scripts/rls-cross-tenant-coverage.sql`** — runs as `passwd_user`. Uses the same discovery query (working as SUPERUSER, hits no role-filter issues). For each discovered table, asserts **exactly 1** row exists for tenant A AND exactly 1 for tenant B. Failure message points at the seed file.

3. **`scripts/rls-cross-tenant-verify.sql`** — runs as `passwd_app`. Five `DO $$` blocks:

   **File-header comment** (mandatory): `-- DO NOT WRAP THIS FILE IN BEGIN/COMMIT OR INVOKE psql WITH --single-transaction. Each DO block must run as its own top-level statement so SET LOCAL is scoped to that block's implicit transaction.`

   **Block 1 (role flags + structural invariants)** — ASSERT halts on first failure, so order matters. Each ASSERT message starts with a **stable error code** (`[E-RLS-<TAG>]`) so the negative-test wrapper can reliably regex-match the specific guard that fired regardless of future message-prose changes (addresses T31/F34 from R4 review).

   ASSERT order (load-bearing):
   1. **Role flags** — `[E-RLS-ROLE]`: `current_user = 'passwd_app'`, `session_user = current_user`, `current_setting('is_superuser') = 'off'`, `NOT rolsuper`, `NOT rolbypassrls`.
   2. **Discovery accessibility self-test** — `[E-RLS-DISCOVER]`: `ASSERT (SELECT count(*) FROM pg_catalog.pg_policy WHERE polname='tenant_isolation' OR polname LIKE '%\_tenant_isolation' ESCAPE '\') > 0, '[E-RLS-DISCOVER] passwd_app cannot read pg_policy — discovery is broken'`.
   3. **NULL-clause guard** — `[E-RLS-NULL]` (MUST run BEFORE symmetry guard — see ordering rationale below):
      ```sql
      ASSERT NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy p
        JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public'
          AND (p.polname = 'tenant_isolation' OR p.polname LIKE '%\_tenant_isolation' ESCAPE '\')
          AND (p.polqual IS NULL OR p.polwithcheck IS NULL)
      ), '[E-RLS-NULL] A tenant_isolation policy has a NULL USING or WITH CHECK clause (USING NULL = policy applies to all rows). Treat as a defect. Convention: tenant_isolation policies must be FOR ALL with non-NULL USING and WITH CHECK; FOR INSERT-only would also fire this guard as a false positive — use a different policyname for INSERT-only patterns.';
      ```
   4. **USING ↔ WITH CHECK symmetry** — `[E-RLS-SYM]`:
      ```sql
      ASSERT NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy p
        JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public'
          AND (p.polname = 'tenant_isolation' OR p.polname LIKE '%\_tenant_isolation' ESCAPE '\')
          AND pg_get_expr(p.polqual, p.polrelid) IS DISTINCT FROM pg_get_expr(p.polwithcheck, p.polrelid)
      ), '[E-RLS-SYM] A tenant_isolation policy has asymmetric USING vs WITH CHECK — add INSERT/UPDATE/DELETE assertions OR normalise the policy.';
      ```
   5. **Column parity** — `[E-RLS-COLPARITY]`: count of `information_schema.columns` rows where `column_name='tenant_id' AND table_schema='public' AND table_name <> 'tenants'` equals discovered count. Catches "tenant_id column added without policy" (or vice versa).
   6. **Manifest parity (manifest \\ discovery)** — `[E-RLS-MANIFEST-EXTRA]`: tables in manifest that are not in DB.
   7. **Manifest parity (discovery \\ manifest)** — `[E-RLS-MANIFEST-MISSING]`: tables in DB that are not in manifest.

   **Ordering rationale (T29 from R4)**: NULL-clause MUST run before symmetry. A NULL `polqual` and a non-NULL `polwithcheck` (e.g., from `CREATE POLICY ... FOR INSERT WITH CHECK (true)`) produce `NULL IS DISTINCT FROM 'true' = TRUE`, which fires the symmetry guard FIRST if it runs first — masking the underlying NULL-clause defect with a generic-asymmetry message. The negative test's Case 3 (NULL-clause) would then never exercise `[E-RLS-NULL]`. Putting `[E-RLS-NULL]` first means: any NULL-clause defect surfaces with the precise tag; any other asymmetry surfaces with `[E-RLS-SYM]`.

   **Notes on `IS DISTINCT FROM`**: NULL-aware; `NULL IS DISTINCT FROM NULL` is FALSE, `NULL IS DISTINCT FROM 'x'` is TRUE — required so two-NULL-clause symmetry doesn't false-positive (the NULL-clause guard already fires for any single-side NULL).

   **Comment in the SQL near `[E-RLS-SYM]`**: `-- Compares pg_get_expr() output (canonicalized expression text). Catches the common asymmetric-write-clause bug. Theoretical false positives (cosmetic deparser differences) are loud failures and recoverable by reviewing pg_get_expr output directly.`

   **Comment in the SQL near `[E-RLS-NULL]`**: `-- Convention: tenant_isolation policies are FOR ALL with non-NULL clauses. A FOR INSERT-only policy with the tenant_isolation name would false-positive here; use a different policyname for INSERT-only patterns.`

   **Block 2 (tenant A → exactly 1 per discovered table)** — uses RAISE NOTICE accumulator for multi-table failure visibility (rather than ASSERT-halt-on-first):
   ```sql
   DO $$
   DECLARE
     t text;
     n bigint;
     expected bigint;
     failures int := 0;
   BEGIN
     -- Defensive prelude
     ASSERT current_setting('app.bypass_rls', true) IS NULL OR current_setting('app.bypass_rls', true) = '',
       'pre-Block-2: app.bypass_rls must be unset';
     SET LOCAL app.tenant_id = '00000000-0000-0000-0000-0000000000A0';
     ASSERT current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-0000000000A0',
       'pre-Block-2: SET LOCAL app.tenant_id failed';
     -- Per-table loop
     FOR t IN (<discovery query>) LOOP
       ASSERT t ~ '^[a-z_][a-z0-9_]*$', format('table name failed regex: %s', t);  -- defensive (S6/F14)
       expected := CASE t WHEN 'mcp_clients' THEN 1 ELSE 1 END;  -- placeholder; only mcp_clients is special-cased today
       EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
       IF n <> expected THEN
         RAISE NOTICE 'FAIL table=% block=verify-A tenant=A expected=% got=% — likely cause: policy bug (cross-tenant leak). Coverage already confirmed exactly 1 row in DB.',
           t, expected, n;
         failures := failures + 1;
       END IF;
     END LOOP;
     IF failures > 0 THEN
       RAISE EXCEPTION '[E-RLS-COUNT-A] Block 2 (tenant A): % tables failed — see NOTICE lines above', failures;
     END IF;
   END $$;
   ```
   The accumulator pattern reports ALL failing tables in one CI run instead of one per push (T14).

   **Block 3 (tenant B → exactly 1)**: mirror of Block 2 with `…000B0` and error code `[E-RLS-COUNT-B]` in the EXCEPTION message (`[E-RLS-COUNT-B] Block 3 (tenant B): % tables failed — see NOTICE lines above`).

   **Block 4 (bypass-channel sanity, with tenant filter explicitly disabled)**:
   ```sql
   DO $$
   DECLARE
     t text;
     n bigint;
     expected bigint;
     filter_clause text;
     failures int := 0;
   BEGIN
     RESET app.tenant_id;  -- no-op-safe: SET LOCAL from Block 3 already discarded at txn boundary
     SET LOCAL app.bypass_rls = 'on';
     ASSERT current_setting('app.tenant_id', true) IS NULL OR current_setting('app.tenant_id', true) = '',
       'pre-Block-4: app.tenant_id must be unset (the RESET above should have ensured this)';
     FOR t IN (<discovery query>) LOOP
       expected := CASE t WHEN 'mcp_clients' THEN 3 ELSE 2 END;
       -- filter_clause built from constants only (UUID literals from the seed). NEVER pass user input here.
       filter_clause := CASE t
         WHEN 'mcp_clients' THEN format(
           'tenant_id IN (%L::uuid, %L::uuid) OR tenant_id IS NULL',
           '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000B0')
         ELSE format(
           'tenant_id IN (%L::uuid, %L::uuid)',
           '00000000-0000-0000-0000-0000000000A0', '00000000-0000-0000-0000-0000000000B0')
       END;
       EXECUTE format('SELECT count(*) FILTER (WHERE %s) FROM %I', filter_clause, t) INTO n;
       IF n <> expected THEN
         RAISE NOTICE 'FAIL table=% block=bypass expected=% got=% — likely cause: policy bypass clause regression (the OR app.bypass_rls=on branch was removed or weakened)',
           t, expected, n;
         failures := failures + 1;
       END IF;
     END LOOP;
     -- mcp_clients: assert NULL row appears under bypass (defense-in-depth, F21)
     SELECT count(*) INTO n FROM mcp_clients WHERE tenant_id IS NULL;
     IF n <> 1 THEN
       RAISE NOTICE 'FAIL mcp_clients NULL-tenant row not visible under bypass — count=%', n;
       failures := failures + 1;
     END IF;
     IF failures > 0 THEN
       RAISE EXCEPTION '[E-RLS-BYPASS] Block 4 (bypass): % failures — see NOTICE lines above', failures;
     END IF;
   END $$;
   ```
   Comment in SQL: `-- NOTE: app.bypass_rls is a soft GUC. SQL-level access to passwd_app session can SET it to 'on' and defeat RLS. RLS is one layer; do not rely on it as the sole tenant boundary. Hardening tracked as a follow-up issue.`

   **Block 5 (cleanup)**: `RESET app.bypass_rls; RESET app.tenant_id`. No-op safety net — `SET LOCAL` from prior blocks is already discarded at txn boundary; this block makes the intent explicit and harmless if a future maintainer changes prior blocks to `SET` (no LOCAL).

   **`client_min_messages` guard**: at the top of Blocks 2/3/4, add `SET LOCAL client_min_messages = 'NOTICE';` so a future CI invocation that sets `PGOPTIONS=-c client_min_messages=WARNING` (used elsewhere to silence noisy migrations) does NOT suppress per-table `RAISE NOTICE` lines — addresses T21 from R3.

4. **`scripts/rls-cross-tenant-negative-test.sh`** — gate self-check that exercises the verify step's failure path. Uses an **ephemeral throwaway table** so no real production policy is ever mutated. Runs **multiple shapes** to cover all five failure surfaces in the verify SQL (T24/F26 from R3 review), choosing the **`--variable` override mechanism** (NOT manifest file mutation) so the manifest file is never written during testing.

   **Setup (once per script run, as `passwd_user`)**:
   ```sql
   CREATE TABLE rls_negative_test (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL
   );
   ALTER TABLE rls_negative_test ENABLE ROW LEVEL SECURITY;
   ALTER TABLE rls_negative_test FORCE ROW LEVEL SECURITY;
   GRANT SELECT, INSERT ON rls_negative_test TO passwd_app;
   -- Insert as passwd_user (SUPERUSER, bypasses RLS regardless of policy).
   -- INSERTing as passwd_user (not passwd_app) avoids depending on the
   -- throwaway policy's WITH CHECK admitting NULL or the ALTER DEFAULT
   -- PRIVILEGES grant chain — the test data is ground truth, set up by SUPERUSER.
   INSERT INTO rls_negative_test (tenant_id) VALUES
     ('00000000-0000-0000-0000-0000000000A0'),
     ('00000000-0000-0000-0000-0000000000B0');
   ```

   **Per-shape iteration** (the script runs ALL of these in sequence, asserting each fires the correct guard via stable error-code matching). All cases use a deterministic policy state — Case 5 explicitly sets a SAFE policy first so its assertion exercises only manifest-parity (NOT cross-fired by stale Case 4 state):

   | Case | Policy shape on `rls_negative_test` | EXPECTED_TABLES setting | Expected stable-code |
   |---|---|---|---|
   | (0) Pre-flight calibration | `USING ((current_setting('app.bypass_rls', true) = 'on') OR tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (same)` (canonical, correct) | manifest + throwaway | exit 0 (sanity: harness is calibrated) |
   | (1) Permissive USING / symmetric | `USING (true) WITH CHECK (true)` | manifest + throwaway | `[E-RLS-COUNT-A]` (Block 2, count=2) |
   | (2) Asymmetric USING/WITH CHECK | `USING (tenant_id = current_setting('app.tenant_id', true)::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (true)` | manifest + throwaway | `[E-RLS-SYM]` |
   | (3) NULL USING clause | `DROP POLICY` then `CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR INSERT WITH CHECK (true)` (legacy INSERT-only → polqual NULL) | manifest + throwaway | `[E-RLS-NULL]` (NULL-clause guard fires before symmetry guard per Block 1 ordering) |
   | (4) Bypass clause dropped | `USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)` | manifest + throwaway | `[E-RLS-BYPASS]` (Block 4 count=0) |
   | (5) Manifest drift (with deterministic policy state) | Same canonical policy as Case 0 (so only manifest mismatch fires, not Block 2/4) | **manifest WITHOUT throwaway** | `[E-RLS-MANIFEST-MISSING]` (discovery has rls_negative_test, manifest doesn't) |

   **Why Case 0 (pre-flight) is required (T32 from R4)**: without it, a verify-file syntax error or harness misconfiguration would make every subsequent case exit non-zero — and the regex matchers might accidentally match (e.g., a parser error message containing the substring "Block"). Case 0 proves `verify` can return GREEN under a correct policy + correct EXPECTED_TABLES, so subsequent RED outcomes are attributable to the deliberate mutation.

   **Per-shape script body** (bash — actual implementation):
   ```bash
   # Case 5 uses the same canonical policy as Case 0 — NOT the broken policy from Case 4.
   # This ensures Block 1 manifest-parity is the only failing check.
   CANONICAL_POLICY="USING ((current_setting('app.bypass_rls', true) = 'on') OR tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK ((current_setting('app.bypass_rls', true) = 'on') OR tenant_id = current_setting('app.tenant_id', true)::uuid)"

   run_negative_case() {
     local case_id="$1"
     local create_policy_sql="$2"          # SQL fragment, e.g. "USING (true) WITH CHECK (true)"
     local expected_code="$3"               # stable error code, e.g. "[E-RLS-COUNT-A]" — or empty for Case 0 (expect exit 0)
     local omit_throwaway_from_manifest="${4:-no}"
     # Apply the policy state (Case 3 uses a different DDL form — handled by caller passing full DDL).
     psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP POLICY IF EXISTS rls_negative_test_tenant_isolation ON rls_negative_test;"
     psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -c "$create_policy_sql"
     # Build EXPECTED_TABLES (manifest entries are whitespace-trimmed)
     local manifest_entries
     manifest_entries=$(awk 'NF && $1 !~ /^#/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0); print}' \
       scripts/rls-cross-tenant-tables.manifest | paste -sd,)
     local expected_tables
     if [[ "$omit_throwaway_from_manifest" == "yes" ]]; then
       expected_tables="$manifest_entries"
     else
       expected_tables="${manifest_entries},rls_negative_test"
     fi
     # Run verify; capture exit and combined output.
     local verify_output ec
     verify_output=$(psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -v expected_tables="$expected_tables" \
       -f scripts/rls-cross-tenant-verify.sql 2>&1) && ec=0 || ec=$?
     if [[ -z "$expected_code" ]]; then
       # Case 0: expect exit 0
       if (( ec != 0 )); then
         printf 'FAIL case %s: pre-flight calibration verify did NOT pass under canonical policy. Output:\n%s\n' "$case_id" "$verify_output"
         return 1
       fi
       printf 'PASS case %s (pre-flight calibration)\n' "$case_id"
       return 0
     fi
     if (( ec == 0 )); then
       printf 'FAIL case %s: verify exited 0 against deliberately-broken policy — gate is broken (vacuous pass)\n' "$case_id"
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
   run_negative_case 0 "$CANONICAL_POLICY" "" "no" || (( total_failures++ ))
   run_negative_case 1 "USING (true) WITH CHECK (true)" "[E-RLS-COUNT-A]" "no" || (( total_failures++ ))
   run_negative_case 2 "USING (tenant_id = current_setting('app.tenant_id', true)::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (true)" "[E-RLS-SYM]" "no" || (( total_failures++ ))
   # Case 3 uses a different DDL — INSERT-only legacy form. Caller passes a synthesized SQL string that DROPs and re-CREATEs:
   run_negative_case 3 "/*intentionally rebuilt to FOR INSERT-only*/ CREATE POLICY rls_negative_test_tenant_isolation ON rls_negative_test FOR INSERT WITH CHECK (true)" "[E-RLS-NULL]" "no" || (( total_failures++ ))
   run_negative_case 4 "USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)" "[E-RLS-BYPASS]" "no" || (( total_failures++ ))
   run_negative_case 5 "$CANONICAL_POLICY" "[E-RLS-MANIFEST-MISSING]" "yes" || (( total_failures++ ))

   if (( total_failures > 0 )); then
     printf '\n%d negative-test cases failed.\n' "$total_failures"
     exit 1
   fi
   printf '\nAll negative-test cases PASS.\n'
   ```

   The driver accumulates failures across all 6 cases (T33 from R4 — operator sees full failure surface in one run, not abort-on-first). The Case 3 SQL fragment uses a comment marker so the dispatcher's `psql -c` form treats the SQL as a single statement with a leading no-op comment; alternative implementations may pass the policy SQL via stdin. Implementer chooses the cleanest form.

   **Cleanup (always, via `trap` on EXIT/INT/TERM)**: `DROP TABLE IF EXISTS rls_negative_test CASCADE`. The trap-based DROP is idempotent.

   **Header comment**:
   ```
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
   ```

### CI integration

Extend the existing `rls-smoke` job in `.github/workflows/ci.yml` with **four** new steps after `Verify RLS enforcement`:

```yaml
- name: Cross-tenant seed (SUPERUSER)
  run: psql -v ON_ERROR_STOP=1 "$MIGRATION_DATABASE_URL" -f scripts/rls-cross-tenant-seed.sql
  env:
    MIGRATION_DATABASE_URL: "postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso"

- name: Cross-tenant coverage check (SUPERUSER)
  run: psql -v ON_ERROR_STOP=1 "$MIGRATION_DATABASE_URL" -f scripts/rls-cross-tenant-coverage.sql
  env:
    MIGRATION_DATABASE_URL: "postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso"

- name: Cross-tenant RLS predicate verify (NOSUPERUSER)
  run: |
    EXPECTED_TABLES=$(awk 'NF && $1 !~ /^#/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0); print}' \
      scripts/rls-cross-tenant-tables.manifest | paste -sd,)
    psql -v ON_ERROR_STOP=1 -v expected_tables="$EXPECTED_TABLES" \
      "postgresql://passwd_app:passwd_app_pass@localhost:5432/passwd_sso" \
      -f scripts/rls-cross-tenant-verify.sql

- name: Cross-tenant verify negative test (gate self-check)
  run: bash scripts/rls-cross-tenant-negative-test.sh
  env:
    MIGRATION_DATABASE_URL: "postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso"
    APP_DATABASE_URL: "postgresql://passwd_app:passwd_app_pass@localhost:5432/passwd_sso"
```

**Path filter / branch protection**: the existing `if: needs.changes.outputs.app == 'true' || needs.changes.outputs.ci == 'true'` already triggers on changes to `prisma/migrations/**` (the existing rls-smoke job's primary trigger). At implementation time, **verify** that the `changes` job's `app` filter includes the new files: `scripts/rls-cross-tenant-*.{sql,sh}` and `scripts/rls-cross-tenant-tables.manifest`. If not present, add them. Required-status checks (branch protection) must already include `rls-smoke` (existing requirement); confirm at implementation time.

The existing `rls-smoke-seed.sql` and `rls-smoke-verify.sql` are NOT modified by this PR — they verify a different invariant (without-GUC visibility on a smaller table set). See §Considerations for the decision rationale and the follow-up issue.

### Special cases

#### Nullable-tenant tables: `mcp_clients`

`prisma/schema.prisma` declares `model McpClient { tenantId String? }`. DCR pre-claimed clients have `tenant_id IS NULL` until claimed.

**Code-inspected fact** (per pre-merge verification): the live policy `mcp_clients_tenant_isolation` in `prisma/migrations/20260328075528_add_rls_machine_identity_tables/migration.sql:49-57` uses **identical USING and WITH CHECK clauses** with the standard `bypass OR tenant_id = current_setting(...)::uuid` template — same as every other tenant_isolation policy. The symmetry guard does not need a special exception for this table.

**Behavior under the standard template**:
- `passwd_app` with `app.tenant_id = '<A>'`: `NULL = '<A>'::uuid` → NULL → falsy → NULL row invisible. count = 1 (A's row only).
- `passwd_app` with bypass=on, tenant_id reset: NULL row admitted via the OR-bypass clause. count = 3 (A's + B's + NULL).
- `passwd_app` cannot INSERT a NULL-tenant row: WITH CHECK requires bypass=on or `tenant_id = current_setting()::uuid` (the latter rejects NULL on the LHS via NULL = uuid → NULL → fail). NULL rows are created only by `passwd_user` or by sessions that explicitly set `app.bypass_rls = 'on'` (the DCR pre-claim admin path).

**Plan handling**:
- Seed file inserts 3 rows in `mcp_clients`: A's (tenant_id = `<A>`), B's (tenant_id = `<B>`), NULL.
- Block 2/3 expected count = 1 per tenant.
- Block 4 expected count = 3, plus a separate NULL-row-visibility assertion.
- Coverage check: assert exactly 1 row per tenant in `mcp_clients` filtered by tenant_id; the NULL row is asserted separately.

#### Future nullable-tenant tables

Adding another nullable-tenant table requires updating: (1) the seed file (3 rows), (2) the per-table override CASE in Block 4, (3) a NULL-row visibility assertion in Block 4. Documented in the seed and verify file headers.

### How auto-discovery + manifest handles drift

Adding a new tenant-scoped table requires:
1. (existing) Migration adds the column, ENABLE/FORCE RLS, `<table>_tenant_isolation` policy → `check-migration-drift.mjs` validates.
2. **New**: dependency-ordered INSERTs in `scripts/rls-cross-tenant-seed.sql`.
3. **New**: append the table name to `scripts/rls-cross-tenant-tables.manifest` (alphabetical order).
4. **New**: if the new table's `tenant_id` is nullable, also update the per-table override CASE in `scripts/rls-cross-tenant-verify.sql` Block 4.

Removing a tenant-scoped table requires DELETING the manifest line — the diff is explicit and scrutable.

**Renames** are auto-handled — the discovery query reflects post-rename state. Renaming a table requires updating the manifest entry to the new name.

## Implementation steps

1. **Pre-merge verification (before writing code)** — see §Pre-merge verification checklist below. Confirm `passwd_app` can SELECT `pg_catalog.pg_policy`. Confirm the `mcp_clients_tenant_isolation` live policy is symmetric (already done by code inspection of `migrations/.../20260328075528_*/migration.sql:45-57`).

2. **Create `scripts/rls-cross-tenant-tables.manifest`**:
   - One tenant-scoped table per line, alphabetical order.
   - Header comment block explaining the maintenance contract: removing a table requires removing the line + the policy + the column (three explicit deltas).
   - Generate the initial list from the discovery query against a migrated DB; the output (currently 53 tables) is the canonical seed for the manifest. Re-run if the schema was migrated since the last regeneration.

3. **Create `scripts/rls-cross-tenant-seed.sql`**:
   - Seeds tenants A and B with deterministic UUIDs.
   - For every manifest table, insert dependency-ordered rows. Document FK chains as inline comments.
   - `mcp_clients`: 3 rows (A, B, NULL).
   - Idempotency: CI uses fresh Postgres; local re-runs may need TRUNCATE first (documented).
   - File header comment: `-- Use %I (identifier quoting), never %s. Identifiers come from system catalog data (trusted). Never widen this rule by interpolating user input.`

4. **Create `scripts/rls-cross-tenant-coverage.sql`**:
   - Single `DO $$` running as `passwd_user`.
   - Same discovery query as the verify step (consistent cross-step). Use accumulator pattern for multi-table failure visibility.
   - Failure messages point at the seed file.

5. **Create `scripts/rls-cross-tenant-verify.sql`**:
   - File header forbidding BEGIN/COMMIT and `--single-transaction`.
   - Five DO blocks per §Verification structure; comments per the listed positions.
   - Defensive `ASSERT t ~ '^[a-z_][a-z0-9_]*$'` in each loop.

6. **Create `scripts/rls-cross-tenant-negative-test.sh`**:
   - `set -euo pipefail`.
   - Capture the manifest, append the throwaway table name temporarily.
   - Trap-based cleanup.
   - Header comment per §Verification structure.

7. **Update `.github/workflows/ci.yml`**:
   - Four new steps after `Verify RLS enforcement`.
   - Path-filter additions to the `changes` job's `app` filter.

8. **Add a syntax-check entry to `scripts/pre-pr.sh`** (T13 mitigation; pre-pr.sh exists in the repo). The entry uses `pg_isready` to skip gracefully when no local Postgres is running. **Important caveats** addressed (F34/T28 from R4):
   - `psql -c "BEGIN;" -f file -c "ROLLBACK;"` does NOT give atomic rollback across the three commands (each `-c` is its own top-level statement). Use `psql --single-transaction -f file` (`-1` short form) for true atomic rollback.
   - The verify file references `:'expected_tables'`. Without `-v expected_tables=...`, psql 14+ raises an error before any ASSERT runs — the check would surface a misleading parse error. Solution: pass a stub variable AND check both the seed and coverage files atomically; the verify file is parse-checked separately by passing a stub manifest derived from the committed file.
   - The check is **parse-time only**: a stub manifest is built so Block 1 manifest-parity will fail (LOUD), but the script invocation captures this expected failure and still passes the pre-pr.sh step IF the failure is `[E-RLS-MANIFEST-MISSING]` or `[E-RLS-MANIFEST-EXTRA]` (i.e., the SQL parsed successfully and reached the assertion). Any other failure means a syntax error.

   Sketch:
   ```bash
   if pg_isready -h localhost -p 5432 -q -t 1; then
     run_step "Static: rls-cross-tenant SQL parse" \
       bash -c '
         set -euo pipefail
         DB_URL="postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso"
         APP_URL="postgresql://passwd_app:passwd_app_pass@localhost:5432/passwd_sso"
         # Seed and coverage: atomic transaction, rollback at end (truly parse-only).
         for f in scripts/rls-cross-tenant-seed.sql scripts/rls-cross-tenant-coverage.sql; do
           psql --single-transaction -v ON_ERROR_STOP=1 "$DB_URL" -f "$f" >/dev/null \
             || true  # ROLLBACK happens automatically when --single-transaction errors out
         done
         # Verify: pass stub manifest (intentionally wrong) — parse must succeed,
         # then accept either zero exit or an [E-RLS-MANIFEST-*] failure as PASS.
         STUB="users"
         out=$(psql -v ON_ERROR_STOP=1 -v expected_tables="$STUB" "$APP_URL" \
           -f scripts/rls-cross-tenant-verify.sql 2>&1) && ec=0 || ec=$?
         if (( ec == 0 )) || grep -qE "\[E-RLS-MANIFEST-(EXTRA|MISSING)\]" <<<"$out"; then
           exit 0  # parse OK — failed assertion is expected with stub manifest
         fi
         echo "$out"
         exit 1  # syntax/parse error or unexpected ASSERT failure
       '
   else
     echo "  [skip: rls-cross-tenant SQL parse — local Postgres not running (npm run docker:up to enable)]"
   fi
   ```
   This catches typos and structural SQL bugs locally without behavioral testing. Behavioral correctness comes from CI.

9. **File two follow-up issues alongside this PR's merge**:
   - **`app.bypass_rls` GUC hardening** — soft-GUC limitation documented in this plan; remediation (replace GUC with a `passwd_user`-only marker, e.g., `current_user = 'passwd_user'`) is a separate plan.
   - **Expand existing `rls-smoke-seed.sql` / `rls-smoke-verify.sql` to all 53 tenant-scoped tables** OR formally retire it as superseded by the new cross-tenant verify. Decision documented in §Considerations.

## Testing strategy

The four new artifacts ARE the test. Three layers of correctness:

| Layer | Asserts | Catches |
|---|---|---|
| Coverage check (SUPERUSER) | Each manifest table has exactly 1 row per tenant in seed | Seed bugs |
| Verify (NOSUPERUSER) | Discovery == manifest; column count == discovery count; symmetry; per-tenant exactly-1; bypass exactly-2 (or 3 for mcp_clients) | Predicate bugs (cross-tenant leak, dropped bypass, asymmetric mutation policies, drifted manifest, removed/added column without policy) |
| Negative test (gate self-check) | Verify exits non-zero against a deliberately-broken throwaway-table policy | Regression in the verify step itself (e.g., refactor that turns the gate vacuous) |

### Manual sanity check (negative cases beyond the automated gate self-check)

The automated negative test exercises the throwaway-table case. For broader confidence, the following are run manually before merge (NOT committed):

| Negative case | Mutation | Expected outcome |
|---|---|---|
| Predicate too permissive | Edit a real table's policy to `USING (true)` | Block 2/3 fails on that table |
| Predicate omits tenant filter | Edit policy to `USING (current_setting('app.tenant_id', true) IS NOT NULL)` | Block 2 fails (count = 2) |
| Bypass clause dropped | Edit policy to `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)` | Block 4 fails (count = 0) |
| Asymmetric USING/WITH CHECK | Edit policy with `USING (...)` ≠ `WITH CHECK (...)` | Block 1 symmetry guard fails |
| NULL USING clause | Edit policy with `USING NULL` | Block 1 non-NULL guard fails |
| Manifest drift | Add a new table with policy + column but forget the manifest entry | Block 1 manifest-parity fails — message names the missing manifest entry |
| Column added without policy | Add `tenant_id` column without policy | Block 1 column-parity fails |

## Manual test plan (inlined)

### Pre-conditions

```bash
# Local docker stack
npm run docker:up
npm run db:migrate

# Confirm passwd_app role exists locally; if not, run the role-creation SQL from
# .github/workflows/ci.yml lines 432-446 against the dev DB once (see "Initial setup" below).

# Confirm passwd_app can read pg_policy (S13 pre-merge verification)
psql "postgresql://passwd_app:passwd_app_pass@localhost:5432/passwd_sso" \
  -c "SELECT count(*) FROM pg_catalog.pg_policy WHERE polname = 'tenant_isolation' OR polname LIKE '%\_tenant_isolation' ESCAPE '\';"
# Expected: ~53 (current count of tenant-scoped tables — re-derive from live DB if schema changed). If 0: STOP — passwd_app lacks SELECT on pg_policy. Plan needs structural revision.

# Confirm role flags
psql "postgresql://passwd_app:passwd_app_pass@localhost:5432/passwd_sso" \
  -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'passwd_app';"
# Expected: rolname=passwd_app, rolsuper=f, rolbypassrls=f

# Set env vars for the local docker stack
export MIGRATION_DATABASE_URL="postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso"
export APP_DATABASE_URL="postgresql://passwd_app:passwd_app_pass@localhost:5432/passwd_sso"
```

### Initial setup (only if `passwd_app` does not exist locally)

Extract from `.github/workflows/ci.yml:432-446` and run as `passwd_user`. The existing CI doc references this; not duplicated here.

### Steps

1. **Cross-tenant seed**:
   ```bash
   psql -v ON_ERROR_STOP=1 "$MIGRATION_DATABASE_URL" -f scripts/rls-cross-tenant-seed.sql
   ```
   Expected: exit 0.

2. **Coverage check**:
   ```bash
   psql -v ON_ERROR_STOP=1 "$MIGRATION_DATABASE_URL" -f scripts/rls-cross-tenant-coverage.sql
   ```
   Expected: exit 0. NOTICE lines for failures (multi-table accumulator).

3. **Verify (as passwd_app)**:
   ```bash
   EXPECTED_TABLES=$(awk 'NF && $1 !~ /^#/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0); print}' \
      scripts/rls-cross-tenant-tables.manifest | paste -sd,)
   psql -v ON_ERROR_STOP=1 -v expected_tables="$EXPECTED_TABLES" \
     "$APP_DATABASE_URL" -f scripts/rls-cross-tenant-verify.sql
   ```
   Expected: exit 0.

4. **Gate self-check (negative test)**:
   ```bash
   bash scripts/rls-cross-tenant-negative-test.sh
   ```
   Expected: exit 0 (the script asserts the verify caught the deliberately-broken throwaway-table policy and DROP succeeded).

5. **Adversarial sanity** (operator-driven): apply a manual mutation from the table above, re-run step 3, confirm exit non-zero with the offending table name. Restore via `prisma migrate reset` or by re-running migrations.

### Rollback

Nothing to roll back — the new files are additive. If the new CI steps fail on main, revert the workflow YAML changes; the SQL/shell files are inert without the workflow steps invoking them.

## Pre-merge verification checklist

Before submitting the PR, the implementer runs each item; all must pass.

- [ ] **Discovery accessibility**: `psql -U passwd_app … -c "SELECT count(*) FROM pg_catalog.pg_policy WHERE polname='tenant_isolation' OR polname LIKE '%\_tenant_isolation' ESCAPE '\';"` returns ~53 (NOT 0). If 0, add `GRANT SELECT ON pg_catalog.pg_policy TO passwd_app` to the role-creation script — and update the plan accordingly.
- [ ] **Manifest equality**: discovery output (as passwd_app) matches the committed manifest exactly.
- [ ] **mcp_clients symmetry confirmed**: code-inspected and verified symmetric in `migrations/20260328075528_*/migration.sql:45-57`.
- [ ] **Manual test plan steps 1-5 all pass** locally.
- [ ] **One adversarial mutation** from the manual table runs and produces a non-zero exit with the offending table name.

## Considerations & constraints

### Risks (revised)

1. **Seed file drift** — adding a new tenant-scoped table without updating the seed file. Mitigation: coverage check fails loudly; failure points at the seed file.

2. **Manifest drift** (replaces "floor too low"): the manifest must equal the discovery output. Adding/removing a tenant-scoped table requires editing the manifest in the same PR; a removal is an explicit table-name diff — much harder to overlook in code review than a numeric decrement.

3. **NOT NULL / FK chain complexity** — chains can be 3-5 levels deep. The seed file enumerates these in dependency order with comments.

4. **Convention drift** — discovery filter matches `tenant_isolation` and `<table>_tenant_isolation`. Other policy names are silently excluded — but the manifest equality check catches this if any future policy doesn't match (the table would appear in the manifest but not in the discovery → assertion fails).

5. **CI runtime** — estimated <2 min for ~53 tables × 4 query passes + the negative-test wrapper (~30 s). Within the 10-min job timeout.

6. **`current_setting('app.tenant_id', true)` semantics** — when unset, returns NULL → `tenant_id = NULL` → falsy. Setting to `''` raises `invalid input syntax for type uuid`; do NOT use `SET app.tenant_id = ''`. Either leave unset, RESET, or set to a valid UUID.

7. **Transaction model and `SET LOCAL` scoping** — psql autocommits each top-level statement; each `DO $$ … END $$` is one top-level statement, so `SET LOCAL` inside it is scoped to that block's implicit transaction. **DO NOT** wrap the file in `BEGIN…COMMIT` and **DO NOT** invoke psql with `--single-transaction` — both would merge all five DO blocks into one transaction, causing Block 4's `app.bypass_rls = 'on'` to leak into subsequent assertions in the same psql session and false-green predicate regressions. The verify file's header comment enforces this.

8. **Defensive `SET LOCAL` verification** — every block uses `ASSERT current_setting(...) = '<expected>'` after each `SET LOCAL` to confirm the GUC took effect. Catches a hypothetical future runtime regression in `SET LOCAL` semantics before per-table assertions run.

9. **`app.bypass_rls` is a soft GUC** — `passwd_app` can `SET app.bypass_rls = 'on'`. NOBYPASSRLS (Postgres-engine attribute) and `app.bypass_rls` (policy-evaluated GUC) are independent. SQL injection on a `passwd_app` session can defeat RLS by setting this GUC. **Documented in the verify SQL comment AND tracked as a follow-up issue alongside this PR's merge** (item 9 of Implementation steps).

10. **Defense-in-depth on dynamic SQL** — `format('%I', t)` is the safe identifier-quoting specifier; `t` comes from `pg_class` (system catalog, trusted). The defensive `ASSERT t ~ '^[a-z_][a-z0-9_]*$'` in the loop is belt-and-suspenders. The Block 4 `filter_clause` mixes `%I` and `%L` and is interpolated into a larger `format(... %s ...)` — this is safe because `filter_clause` is built from constants only (UUIDs from the seed file). A SQL comment near each `EXECUTE` documents this and forbids extending `filter_clause` to user input.

11. **Symmetry guard textual edge cases** — `pg_get_expr(qual, ...) IS DISTINCT FROM pg_get_expr(with_check, ...)` compares canonicalized expression text from the deparser. False-positive (cosmetic deparser difference flagging as asymmetric) is theoretically possible but produces a loud failure that's recoverable by inspecting `pg_get_expr` output directly. False-negative (semantically asymmetric but textually equal) is excluded by the deparser's canonicalization. Documented in the SQL comment.

12. **Negative-test SIGKILL** — bash trap fires on EXIT/ERR/INT/TERM, not SIGKILL. CI Postgres is per-job and ephemeral; a leaked throwaway table is discarded with the runner. Documented; do NOT run the script against shared/persistent DB without modification.

### Constraints honored

- No new container, no new package.
- Same `passwd_app` / `passwd_user` role pattern.
- Same psql + DO-block ASSERT idiom.
- Manifest file is a flat text file — no new tooling.

### What this does NOT solve (decided in plan review)

1. **Existing `rls-smoke-seed.sql` / `rls-smoke-verify.sql` narrow scope (S7)**: the existing smoke check covers only 7 of ~53 tenant-scoped tables. The new cross-tenant verify supersedes it in COVERAGE breadth, but they verify different invariants (without-GUC default invisibility vs cross-tenant predicate correctness). KEEP existing files unchanged in this PR. Filing a follow-up issue alongside merge to either auto-discover the without-GUC seed/verify too, or formally retire it.

2. **Mutation tests for INSERT/UPDATE/DELETE predicates**: not added. Block 1 USING ↔ WITH CHECK symmetry assertion is the trigger for adding mutation tests in a follow-up plan if symmetry breaks.

3. **`app.bypass_rls` GUC hardening**: out of scope; **follow-up issue filed alongside this PR's merge** (item 9 of Implementation steps).

4. **CODEOWNERS introduction**: out of scope unless `.github/CODEOWNERS` already exists. Not required for safety because the manifest replaces the soft floor — additions/removals are explicit table-name diffs visible in code review without specialized tooling.

## User operation scenarios

### Scenario 1: Developer adds a new tenant-scoped table (NOT NULL tenant_id)

1. Adds the model + migration (column, ENABLE/FORCE RLS, `<table>_tenant_isolation` policy) → `check-migration-drift.mjs` passes.
2. CI:
   - Existing `rls-smoke` (7-table list) → passes (new table not in list).
   - **NEW** Cross-tenant seed → succeeds (new table has 0 rows).
   - **NEW** Cross-tenant coverage check → **FAILS**: `Table foo_bars expected exactly 1 row for tenant A, found 0 — fix rls-cross-tenant-seed.sql`.
3. Developer adds INSERTs for tenant A and B in the seed (dependency-ordered) AND appends the table name to `scripts/rls-cross-tenant-tables.manifest`. Re-pushes.
4. CI green. Block 1 manifest-parity passes (manifest matches discovery). Block 2/3 pass (count = 1 per tenant). Block 4 passes (count = 2 with bypass).

### Scenario 2: Defective predicate caught by Blocks 2/3

A migration writes `USING (tenant_id = '00000000-...AAAA-...')` (developer pasted a literal UUID). CI:
- `check-migration-drift.mjs` passes; existing `rls-smoke` passes; coverage passes.
- **NEW** Verify Block 2 fails — the policy ignores the GUC. NOTICE: `FAIL table=foo block=verify-A tenant=A expected=1 got=2 — likely cause: policy bug`. Block 2 ends with `RAISE EXCEPTION` — exit non-zero.

### Scenario 3: Asymmetric USING/WITH CHECK introduced

A migration writes `USING (tenant_id = current_setting(...))` + `WITH CHECK (true)`. CI:
- Block 1 symmetry guard fails: `A tenant_isolation policy has asymmetric USING vs WITH CHECK`.

### Scenario 4: Bypass channel regression

Migration removes the `OR app.bypass_rls = 'on'` clause. CI:
- Existing rls-smoke passes; coverage passes; Block 2/3 pass (tenant filter still works).
- Block 4 fails: count = 0 (no GUC, no bypass admission) instead of 2.

### Scenario 5: Verify step itself regresses (gate self-check)

Refactor changes `expected := 1` to `expected := count` (vacuous). CI:
- Cross-tenant verify passes (vacuously).
- **NEW** Cross-tenant verify negative test fails: throwaway table with `USING (true)` admits 2 rows; the (now-broken) verify reports 2 = 2, exits 0; the negative-test wrapper expected non-zero → fails with `Negative test: verify exited 0 against a deliberately-broken policy — gate is broken (vacuous pass)`.

### Scenario 6: Discovery accessibility silently broken (S13 hypothetical)

If a future change causes `passwd_app` to lose SELECT on `pg_policy`:
- Block 1 discovery accessibility self-test fails immediately: `passwd_app cannot read pg_policy — discovery is broken`.
- Operator restores the grant or revises the role-creation script.

### Scenario 7: Local re-run

See §Manual test plan above.
