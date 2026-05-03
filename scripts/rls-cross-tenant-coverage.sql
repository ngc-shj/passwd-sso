-- RLS Cross-Tenant Verify: Coverage check
--
-- Runs as passwd_user (SUPERUSER, BYPASSRLS).
--
-- Asserts that for every tenant-scoped table discovered via pg_policy,
-- the seed file (rls-cross-tenant-seed.sql) inserted exactly 1 row for
-- tenant A AND exactly 1 row for tenant B. For mcp_clients, also asserts
-- exactly 1 row with tenant_id IS NULL (DCR pre-claimed clients).
--
-- This catches seed-file drift: a new tenant-scoped table added to the
-- manifest + migration but NOT seeded would surface here as "expected=1
-- got=0 — fix rls-cross-tenant-seed.sql" before the (passwd_app) verify
-- step runs.
--
-- Uses the SAME discovery query as scripts/rls-cross-tenant-verify.sql
-- (consistent across files; no role-filter pitfall here because we run
-- as SUPERUSER but the query doesn't depend on it).
--
-- Use %I (identifier quoting) for table names in dynamic SQL — never %s.
-- Identifiers come from system catalog data (trusted).
--
-- Local usage:
--   cat scripts/rls-cross-tenant-coverage.sql | docker exec -i passwd-sso-db-1 \
--     psql -U passwd_user -d passwd_sso -v ON_ERROR_STOP=1

DO $$
DECLARE
  t text;
  n bigint;
  failures int := 0;
  tenant_a constant uuid := '00000000-0000-0000-0000-0000000000A0';
  tenant_b constant uuid := '00000000-0000-0000-0000-0000000000B0';
BEGIN
  FOR t IN (
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
    ORDER BY c.relname
  ) LOOP
    -- Defensive identifier-shape guard (system catalog is trusted, but
    -- belt-and-suspenders for the dynamic SQL).
    ASSERT t ~ '^[a-z_][a-z0-9_]*$', format('table name failed regex: %L', t);

    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id = $1', t)
      INTO n USING tenant_a;
    IF n <> 1 THEN
      RAISE NOTICE 'FAIL coverage table=% tenant=A expected=1 got=% — fix rls-cross-tenant-seed.sql', t, n;
      failures := failures + 1;
    END IF;

    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id = $1', t)
      INTO n USING tenant_b;
    IF n <> 1 THEN
      RAISE NOTICE 'FAIL coverage table=% tenant=B expected=1 got=% — fix rls-cross-tenant-seed.sql', t, n;
      failures := failures + 1;
    END IF;
  END LOOP;

  -- Special case: mcp_clients also has a NULL-tenant row (DCR pre-claimed).
  SELECT count(*) INTO n FROM mcp_clients WHERE tenant_id IS NULL;
  IF n <> 1 THEN
    RAISE NOTICE 'FAIL coverage mcp_clients NULL-tenant expected=1 got=% — fix rls-cross-tenant-seed.sql', n;
    failures := failures + 1;
  END IF;

  IF failures > 0 THEN
    RAISE EXCEPTION '[E-RLS-COVERAGE] Coverage check: % failures — see NOTICE lines above. Fix scripts/rls-cross-tenant-seed.sql.', failures;
  END IF;
END $$;
