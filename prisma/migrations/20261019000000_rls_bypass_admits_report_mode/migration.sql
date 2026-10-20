BEGIN;

-- #911 (report mode). Under bypass, a statement that examines a row of an RLS
-- table outside the bypass's grant is reported (RAISE WARNING) and admitted.
-- `public.rls_bypass_enforced()` turns the report into a refusal; it ships
-- `false`, and only a later migration (the enforce flip) replaces it.
--
-- The grant is `app.bypass_tables`, set by setBypassGucs (src/lib/tenant-rls-grants.ts)
-- with the bypass. This is a detection control against code that does not
-- write the bypass GUCs itself, not a boundary against code that can issue SQL.

CREATE OR REPLACE FUNCTION public.rls_bypass_enforced() RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT false $$;

CREATE OR REPLACE FUNCTION public.rls_bypass_admits(table_name text) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  purpose text;
BEGIN
  IF COALESCE(current_setting('app.bypass_rls', true), '') <> 'on' THEN
    RETURN false;
  END IF;
  -- Exact element membership, untrimmed: `delegation_sessions` does not admit `sessions`.
  IF table_name = ANY (string_to_array(current_setting('app.bypass_tables', true), ',')) THEN
    RETURN true;
  END IF;
  -- The purpose is a constant on honest paths; anything else must not shape the line.
  purpose := current_setting('app.bypass_purpose', true);
  IF purpose IS NULL OR purpose !~ '^[a-z0-9_-]+$' THEN
    purpose := '<invalid>';
  ELSE
    purpose := left(purpose, 64);
  END IF;
  RAISE WARNING 'rls_bypass_not_granted table=% purpose=%', table_name, purpose;
  IF public.rls_bypass_enforced() THEN
    RAISE EXCEPTION 'RLS_BYPASS_NOT_GRANTED: %', table_name
      USING ERRCODE = '42501', HINT = format('bypass purpose %s', purpose);
  END IF;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.rls_bypass_enforced() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_bypass_admits(text) FROM PUBLIC;

-- Roles created before this migration get EXECUTE here; role-creation paths
-- that run after it (ci-integration bootstrap, bootstrap-rds-roles.mjs) grant it
-- themselves.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['passwd_app', 'passwd_outbox_worker', 'passwd_retention_gc_worker',
                           'passwd_anchor_publisher', 'passwd_dcr_cleanup_worker']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.rls_bypass_enforced() TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.rls_bypass_admits(text) TO %I', r);
    END IF;
  END LOOP;
END
$$;

-- Every policy's bypass branch becomes a call naming its own table, in the
-- scalar-subquery form so the planner evaluates it once per statement (an
-- InitPlan) and keeps parallel scans.
DO $$
DECLARE
  p record;
  old_branch constant text := $b$(COALESCE(current_setting('app.bypass_rls'::text, true), ''::text) = 'on'::text)$b$;
  new_branch text;
  new_qual text;
  new_check text;
BEGIN
  FOR p IN SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public' LOOP
    new_branch := format('(SELECT public.rls_bypass_admits(%L))', p.tablename);
    new_qual := replace(p.qual, old_branch, new_branch);
    new_check := replace(p.with_check, old_branch, new_branch);
    IF new_qual IS NOT DISTINCT FROM p.qual OR new_check IS NOT DISTINCT FROM p.with_check THEN
      RAISE EXCEPTION 'policy % on % has no bypass branch to rewrite', p.policyname, p.tablename;
    END IF;
    EXECUTE format('ALTER POLICY %I ON public.%I USING (%s) WITH CHECK (%s)',
                   p.policyname, p.tablename, new_qual, new_check);
  END LOOP;
END
$$;

-- Every policy now names its own table in both expressions, and none keeps the
-- admit-everything branch.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO bad
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (qual NOT LIKE '%rls_bypass_admits(''' || tablename || '''::text)%'
      OR with_check NOT LIKE '%rls_bypass_admits(''' || tablename || '''::text)%'
      OR qual LIKE '%app.bypass_rls%'
      OR with_check LIKE '%app.bypass_rls%');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'policies not rewritten to rls_bypass_admits(<own table>): %', bad;
  END IF;
END
$$;

-- The tenant branch of every policy moves into a scalar sub-SELECT as well, in
-- the same transaction: the state with only the bypass branch rewritten breaks
-- pre-change bypass code (below), so it must never be committed on its own.
--
-- Why: with the old bypass branch, `COALESCE(current_setting('app.bypass_rls'),
-- '') = 'on'`, the planner folded the whole OR to true while estimating a
-- bypassed statement, so the tenant branch was never evaluated. The new bypass
-- branch is an InitPlan and cannot be folded, so planning now evaluates
-- `current_setting('app.tenant_id', true)::uuid`. On a pooled connection where
-- an earlier transaction set app.tenant_id, the custom GUC reverts to '' (not
-- NULL), and ''::uuid raises 22P02. That broke a bypass that sets app.bypass_rls
-- without app.tenant_id — code older than this change (the retention sweep) and
-- direct SQL alike.
--
-- As an InitPlan, the tenant value is evaluated lazily, only when the bypass
-- branch is false. Every case keeps its previous outcome:
--   bypass on,  tenant ''      -> admitted (bypass branch)
--   bypass off, tenant ''      -> 22P02, the loud missing-context failure
--   bypass off, tenant set     -> that tenant's rows
--   bypass off, tenant NIL     -> no rows
DO $$
DECLARE
  p record;
  old_branch constant text := $b$(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)$b$;
  new_branch constant text := $b$(tenant_id = (SELECT (current_setting('app.tenant_id', true))::uuid))$b$;
  new_qual text;
  new_check text;
BEGIN
  FOR p IN SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public' LOOP
    new_qual := replace(p.qual, old_branch, new_branch);
    new_check := replace(p.with_check, old_branch, new_branch);
    IF new_qual IS NOT DISTINCT FROM p.qual AND new_check IS NOT DISTINCT FROM p.with_check THEN
      -- A policy with no tenant branch (a bypass-only table) is left as is.
      CONTINUE;
    END IF;
    IF new_qual IS NOT DISTINCT FROM p.qual OR new_check IS NOT DISTINCT FROM p.with_check THEN
      RAISE EXCEPTION 'policy % on % has a tenant branch in only one expression', p.policyname, p.tablename;
    END IF;
    EXECUTE format('ALTER POLICY %I ON public.%I USING (%s) WITH CHECK (%s)',
                   p.policyname, p.tablename, new_qual, new_check);
  END LOOP;
END
$$;

-- No policy keeps a tenant cast that planning evaluates.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO bad
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (qual LIKE '%(current_setting(''app.tenant_id''::text, true))::uuid)%'
      OR with_check LIKE '%(current_setting(''app.tenant_id''::text, true))::uuid)%');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'policies still cast app.tenant_id outside a sub-SELECT: %', bad;
  END IF;
END
$$;

COMMIT;
