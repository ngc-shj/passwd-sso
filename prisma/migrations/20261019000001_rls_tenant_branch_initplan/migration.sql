BEGIN;

-- The tenant branch of every policy moves into a scalar sub-SELECT, as the
-- bypass branch did in 20261019000000.
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
