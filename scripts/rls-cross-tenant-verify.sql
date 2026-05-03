-- RLS Cross-Tenant Predicate Verify
--
-- Runs as passwd_app (NOSUPERUSER, NOBYPASSRLS).
-- Asserts that every `tenant_isolation` policy actually filters by tenant_id at
-- runtime — catches "USING (true)", dropped bypass clauses, asymmetric
-- USING/WITH CHECK, NULL clauses, and manifest drift.
--
-- DO NOT WRAP THIS FILE IN BEGIN/COMMIT OR INVOKE psql WITH --single-transaction.
-- Each DO block must run as its own top-level statement so SET LOCAL is scoped
-- to that block's implicit transaction. Wrapping in a single transaction would
-- merge all DO blocks into one transaction, causing Block 4's app.bypass_rls=on
-- to leak into subsequent assertions in the same psql session and false-green
-- predicate regressions.
--
-- Stable error codes (`[E-RLS-*]`) are part of the public contract — the
-- gate self-check (rls-cross-tenant-negative-test.sh) regex-matches these
-- codes, so message prose can change but the bracketed code must not.
--
-- Required psql variable:
--   -v expected_tables=<comma-separated manifest> (no spaces)
--
-- See docs/archive/review/verify-rls-predicate-plan.md for the design.

-- Bridge the psql variable into a session GUC so the DO blocks (whose
-- dollar-quoted bodies are not re-scanned for psql variable substitution)
-- can read it via `current_setting('app.expected_tables', true)`.
SET app.expected_tables TO :'expected_tables';

-- =====================================================================
-- Block 1: Role flags + structural invariants.
-- ASSERT halts on first failure, so order is LOAD-BEARING:
--   1. [E-RLS-ROLE]               role flags
--   2. [E-RLS-DISCOVER]           discovery accessibility self-test
--   3. [E-RLS-NULL]               NULL USING/WITH CHECK clause guard
--                                 (MUST run BEFORE symmetry — a NULL polqual
--                                 vs non-NULL polwithcheck would otherwise
--                                 fire [E-RLS-SYM] first and mask the defect)
--   4. [E-RLS-SYM]                USING ↔ WITH CHECK symmetry
--   5. [E-RLS-COLPARITY]          column count vs discovery count parity
--   6. [E-RLS-MANIFEST-EXTRA]     manifest \ discovery
--   7. [E-RLS-MANIFEST-MISSING]   discovery \ manifest
-- =====================================================================
DO $$
DECLARE
  discovered_count int;
  column_count int;
BEGIN
  -- 1. Role flags. Belt-and-suspenders: defends against the verify step
  --    being accidentally invoked as passwd_user (SUPERUSER bypasses RLS,
  --    yielding a false-green run).
  ASSERT current_user = 'passwd_app',
    format('[E-RLS-ROLE] verify must run as passwd_app, got %L', current_user);
  ASSERT session_user = current_user,
    '[E-RLS-ROLE] session_user must equal current_user (no SET ROLE in this script)';
  ASSERT current_setting('is_superuser') = 'off',
    '[E-RLS-ROLE] is_superuser must be off';
  ASSERT (SELECT NOT rolsuper FROM pg_roles WHERE rolname = current_user),
    '[E-RLS-ROLE] passwd_app must not be SUPERUSER';
  ASSERT (SELECT NOT rolbypassrls FROM pg_roles WHERE rolname = current_user),
    '[E-RLS-ROLE] passwd_app must not have BYPASSRLS';

  -- 2. Discovery accessibility self-test. If passwd_app cannot SELECT from
  --    pg_catalog.pg_policy, the entire verify step is silently vacuous.
  ASSERT (
    SELECT count(*) FROM pg_catalog.pg_policy
    WHERE polname = 'tenant_isolation'
       OR polname LIKE '%\_tenant_isolation' ESCAPE '\'
  ) > 0,
    '[E-RLS-DISCOVER] passwd_app cannot read pg_policy — discovery is broken';

  -- 3. NULL USING / WITH CHECK clause guard.
  --    Convention: tenant_isolation policies are FOR ALL with non-NULL clauses.
  --    A FOR INSERT-only policy (polqual NULL, polwithcheck non-NULL) named
  --    `<table>_tenant_isolation` would false-positive here — use a different
  --    policyname for INSERT-only patterns.
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND (p.polname = 'tenant_isolation' OR p.polname LIKE '%\_tenant_isolation' ESCAPE '\')
      AND (p.polqual IS NULL OR p.polwithcheck IS NULL)
  ),
    '[E-RLS-NULL] A tenant_isolation policy has a NULL USING or WITH CHECK clause (USING NULL = policy applies to all rows). Treat as a defect. Convention: tenant_isolation policies must be FOR ALL with non-NULL USING and WITH CHECK; FOR INSERT-only would also fire this guard as a false positive — use a different policyname for INSERT-only patterns.';

  -- 4. USING ↔ WITH CHECK symmetry guard.
  --    Compares pg_get_expr() output (canonicalized expression text). Catches
  --    the common asymmetric-write-clause bug (e.g., USING (tenant filter)
  --    + WITH CHECK (true) admits cross-tenant INSERTs). Theoretical false
  --    positives (cosmetic deparser differences) are loud failures and
  --    recoverable by reviewing pg_get_expr output directly.
  --    `IS DISTINCT FROM` is NULL-aware: NULL IS DISTINCT FROM NULL = FALSE,
  --    so the prior NULL-clause guard is the right place for that case.
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND (p.polname = 'tenant_isolation' OR p.polname LIKE '%\_tenant_isolation' ESCAPE '\')
      AND pg_get_expr(p.polqual, p.polrelid)
          IS DISTINCT FROM pg_get_expr(p.polwithcheck, p.polrelid)
  ),
    '[E-RLS-SYM] A tenant_isolation policy has asymmetric USING vs WITH CHECK — add INSERT/UPDATE/DELETE assertions OR normalise the policy.';

  -- 5. Column parity: every discovered policy table has a tenant_id column,
  --    and every public.tenant_id column (other than `tenants`) has a policy.
  SELECT count(*) INTO discovered_count
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN information_schema.columns col
    ON col.table_schema = n.nspname
   AND col.table_name = c.relname
   AND col.column_name = 'tenant_id'
  WHERE n.nspname = 'public'
    AND c.relname <> 'tenants'
    AND (p.polname = 'tenant_isolation' OR p.polname LIKE '%\_tenant_isolation' ESCAPE '\');

  SELECT count(*) INTO column_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND column_name = 'tenant_id'
    AND table_name <> 'tenants';

  ASSERT discovered_count = column_count,
    format('[E-RLS-COLPARITY] tenant_id column count (%s) does not equal discovered tenant_isolation policy count (%s) — a column was added without a policy, or a policy without its column.',
      column_count, discovered_count);

  -- 6. Manifest \ discovery (extra in manifest, missing from DB).
  ASSERT NOT EXISTS (
    SELECT m.t FROM unnest(string_to_array(current_setting('app.expected_tables', true), ',')) AS m(t)
    EXCEPT
    SELECT c.relname
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
  ),
    format('[E-RLS-MANIFEST-EXTRA] Manifest has tables not in discovery: %s', (
      SELECT string_agg(m.t, ',')
      FROM unnest(string_to_array(current_setting('app.expected_tables', true), ',')) AS m(t)
      WHERE m.t NOT IN (
        SELECT c.relname
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
      )
    ));

  -- 7. Discovery \ manifest (extra in DB, missing from manifest).
  ASSERT NOT EXISTS (
    SELECT c.relname
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
    EXCEPT
    SELECT m.t FROM unnest(string_to_array(current_setting('app.expected_tables', true), ',')) AS m(t)
  ),
    format('[E-RLS-MANIFEST-MISSING] Discovery has tables not in manifest: %s', (
      SELECT string_agg(c.relname, ',')
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
        AND c.relname NOT IN (
          SELECT m.t FROM unnest(string_to_array(current_setting('app.expected_tables', true), ',')) AS m(t)
        )
    ));
END $$;

-- =====================================================================
-- Block 2: Tenant A → exactly 1 row visible per discovered table.
-- Accumulator pattern (RAISE NOTICE per failing table, RAISE EXCEPTION at end)
-- so a multi-table predicate regression surfaces ALL offending tables in one
-- CI run instead of one per push.
-- =====================================================================
DO $$
DECLARE
  t text;
  n bigint;
  expected bigint;
  failures int := 0;
BEGIN
  -- Ensure NOTICE lines are not suppressed by a future PGOPTIONS=-c
  -- client_min_messages=WARNING invocation.
  SET LOCAL client_min_messages = 'NOTICE';

  -- Defensive prelude: bypass must NOT be on entering Block 2.
  ASSERT current_setting('app.bypass_rls', true) IS NULL
      OR current_setting('app.bypass_rls', true) = '',
    'pre-Block-2: app.bypass_rls must be unset';

  SET LOCAL app.tenant_id = '00000000-0000-0000-0000-0000000000A0';

  -- Defensive ASSERT confirming the GUC took effect — catches a hypothetical
  -- runtime regression in SET LOCAL semantics before per-table assertions run.
  ASSERT current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-0000000000A0',
    'pre-Block-2: SET LOCAL app.tenant_id failed';

  FOR t IN
    SELECT c.relname
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
  LOOP
    -- Defensive identifier regex (belt-and-suspenders for SQL injection — `t`
    -- comes from pg_class which is trusted, but %I + this regex make the
    -- safety property local and obvious).
    ASSERT t ~ '^[a-z_][a-z0-9_]*$',
      format('table name failed regex: %L', t);

    -- Per-table expected count for tenant A. Currently every tenant-scoped
    -- table has exactly 1 A-row in the seed; the CASE keeps the shape
    -- identical to Block 4 so future special-cases plug in mechanically.
    expected := CASE t WHEN 'mcp_clients' THEN 1 ELSE 1 END;

    -- %I quotes the identifier safely; never widen to %s for table names.
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

-- =====================================================================
-- Block 3: Tenant B → exactly 1 row visible per discovered table.
-- Mirror of Block 2 with tenant B's UUID and error code [E-RLS-COUNT-B].
-- =====================================================================
DO $$
DECLARE
  t text;
  n bigint;
  expected bigint;
  failures int := 0;
BEGIN
  SET LOCAL client_min_messages = 'NOTICE';

  ASSERT current_setting('app.bypass_rls', true) IS NULL
      OR current_setting('app.bypass_rls', true) = '',
    'pre-Block-3: app.bypass_rls must be unset';

  SET LOCAL app.tenant_id = '00000000-0000-0000-0000-0000000000B0';

  ASSERT current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-0000000000B0',
    'pre-Block-3: SET LOCAL app.tenant_id failed';

  FOR t IN
    SELECT c.relname
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
  LOOP
    ASSERT t ~ '^[a-z_][a-z0-9_]*$',
      format('table name failed regex: %L', t);

    expected := CASE t WHEN 'mcp_clients' THEN 1 ELSE 1 END;

    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;

    IF n <> expected THEN
      RAISE NOTICE 'FAIL table=% block=verify-B tenant=B expected=% got=% — likely cause: policy bug (cross-tenant leak). Coverage already confirmed exactly 1 row in DB.',
        t, expected, n;
      failures := failures + 1;
    END IF;
  END LOOP;

  IF failures > 0 THEN
    RAISE EXCEPTION '[E-RLS-COUNT-B] Block 3 (tenant B): % tables failed — see NOTICE lines above', failures;
  END IF;
END $$;

-- =====================================================================
-- Block 4: Bypass-channel sanity. With app.bypass_rls=on AND app.tenant_id
-- reset, the OR-bypass clause in each policy must admit BOTH seeded rows
-- (3 for mcp_clients: A + B + NULL).
--
-- NOTE: app.bypass_rls is a soft GUC. SQL-level access to a passwd_app session
-- can SET it to 'on' and defeat RLS. RLS is one layer; do not rely on it as
-- the sole tenant boundary. Hardening tracked as a follow-up issue.
-- =====================================================================
DO $$
DECLARE
  t text;
  n bigint;
  expected bigint;
  filter_clause text;
  failures int := 0;
BEGIN
  SET LOCAL client_min_messages = 'NOTICE';

  -- IMPORTANT: cannot use `RESET app.tenant_id` here. Postgres quirk: once a
  -- custom GUC has been SET (or SET LOCAL'd) in a session, subsequent calls
  -- to `current_setting('app.tenant_id', true)` return the empty string ''
  -- — NOT NULL — even after RESET / DISCARD ALL. The policy's USING clause
  -- then evaluates `tenant_id = ''::uuid`, which raises
  -- `invalid input syntax for type uuid: ""` BEFORE the OR-bypass branch
  -- can short-circuit. (Confirmed empirically against postgres:16-alpine.)
  --
  -- The fix: set app.tenant_id to a valid sentinel UUID that cannot match
  -- any real tenant_id. The all-zeros nil-UUID is the canonical choice —
  -- it parses cleanly, matches no seeded row (tenants A/B use ...000A0/B0),
  -- and lets the OR-bypass clause exclusively drive the visibility result.
  -- Net effect: same semantic intent as "tenant filter disabled, bypass-only".
  SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000';
  SET LOCAL app.bypass_rls = 'on';

  ASSERT current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000',
    'pre-Block-4: SET LOCAL app.tenant_id (nil sentinel) failed';
  ASSERT current_setting('app.bypass_rls', true) = 'on',
    'pre-Block-4: SET LOCAL app.bypass_rls failed';

  FOR t IN
    SELECT c.relname
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
  LOOP
    ASSERT t ~ '^[a-z_][a-z0-9_]*$',
      format('table name failed regex: %L', t);

    expected := CASE t WHEN 'mcp_clients' THEN 3 ELSE 2 END;

    -- filter_clause is built from CONSTANTS only (UUID literals from the
    -- seed). %L quotes them as SQL literals; the cast to ::uuid is added
    -- explicitly. NEVER widen this to interpolate user input — it is
    -- inlined into a larger format() via %s and that is only safe because
    -- the only input shape here is a constant UUID literal.
    filter_clause := CASE t
      WHEN 'mcp_clients' THEN format(
        'tenant_id IN (%L::uuid, %L::uuid) OR tenant_id IS NULL',
        '00000000-0000-0000-0000-0000000000A0',
        '00000000-0000-0000-0000-0000000000B0')
      ELSE format(
        'tenant_id IN (%L::uuid, %L::uuid)',
        '00000000-0000-0000-0000-0000000000A0',
        '00000000-0000-0000-0000-0000000000B0')
    END;

    EXECUTE format('SELECT count(*) FILTER (WHERE %s) FROM %I', filter_clause, t) INTO n;

    IF n <> expected THEN
      RAISE NOTICE 'FAIL table=% block=bypass expected=% got=% — likely cause: policy bypass clause regression (the OR app.bypass_rls=on branch was removed or weakened)',
        t, expected, n;
      failures := failures + 1;
    END IF;
  END LOOP;

  -- Defense-in-depth: assert the mcp_clients NULL-tenant row is visible
  -- under bypass. The filtered count above already requires it (3 = 2 named +
  -- 1 NULL), but an explicit NULL-only assertion catches a regression where
  -- the policy admits exactly 2 named rows + 1 spurious row from elsewhere.
  SELECT count(*) INTO n FROM mcp_clients WHERE tenant_id IS NULL;
  IF n <> 1 THEN
    RAISE NOTICE 'FAIL mcp_clients NULL-tenant row not visible under bypass — count=%', n;
    failures := failures + 1;
  END IF;

  IF failures > 0 THEN
    RAISE EXCEPTION '[E-RLS-BYPASS] Block 4 (bypass): % failures — see NOTICE lines above', failures;
  END IF;
END $$;

-- =====================================================================
-- Block 5: Cleanup. Defensive no-op safety net — SET LOCAL from prior blocks
-- is already discarded at the transaction boundary; this block makes the
-- intent explicit and harmless if a future maintainer changes prior blocks
-- to non-LOCAL SET.
-- =====================================================================
DO $$
BEGIN
  RESET app.bypass_rls;
  RESET app.tenant_id;
END $$;
