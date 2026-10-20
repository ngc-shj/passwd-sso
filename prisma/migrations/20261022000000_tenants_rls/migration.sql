BEGIN;

-- #923. `tenants` joins the RLS model every tenant-scoped table already has:
-- a statement sees a tenant row under a bypass (reported when the bypass's
-- grant does not name `tenants`, refused once #921 flips enforce mode), or the
-- one row of the tenant whose scope it set. A query that set neither sees
-- nothing. Like every other policy here, this binds application code that sets
-- its scope through the tenant-rls helpers; it is not a boundary against code
-- that can issue SQL as these roles, since the GUCs are settable by any role.
--
-- The tenant branch is a scalar sub-SELECT, as every policy's is since
-- 20261019000000: evaluated lazily as an InitPlan, so a bypassed statement on a
-- connection whose app.tenant_id reverted to '' never casts it.

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_tenant_isolation ON "tenants"
  USING ((SELECT public.rls_bypass_admits('tenants')) OR id = (SELECT (current_setting('app.tenant_id', true))::uuid))
  WITH CHECK ((SELECT public.rls_bypass_admits('tenants')) OR id = (SELECT (current_setting('app.tenant_id', true))::uuid));

-- The same post-conditions 20261019000000 asserts for every policy: the bypass
-- branch names its own table in both expressions, and no tenant cast sits
-- outside a sub-SELECT.
DO $$
DECLARE
  p record;
BEGIN
  SELECT qual, with_check INTO p FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'tenants' AND policyname = 'tenants_tenant_isolation';
  IF p IS NULL THEN
    RAISE EXCEPTION 'tenants_tenant_isolation was not created';
  END IF;
  IF p.qual NOT LIKE '%rls_bypass_admits(''tenants''::text)%'
     OR p.with_check NOT LIKE '%rls_bypass_admits(''tenants''::text)%' THEN
    RAISE EXCEPTION 'tenants_tenant_isolation does not name its own table in the bypass branch';
  END IF;
  IF p.qual ~ '(?<!SELECT )\(current_setting\(''app\.tenant_id''::text, true\)\)::uuid'
     OR p.with_check ~ '(?<!SELECT )\(current_setting\(''app\.tenant_id''::text, true\)\)::uuid' THEN
    RAISE EXCEPTION 'tenants_tenant_isolation casts app.tenant_id outside a sub-SELECT';
  END IF;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.tenants'::regclass) THEN
    RAISE EXCEPTION 'tenants does not have ENABLE and FORCE row level security';
  END IF;
END
$$;

COMMIT;
