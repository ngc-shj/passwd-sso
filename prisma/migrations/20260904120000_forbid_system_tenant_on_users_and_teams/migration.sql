-- No `users` or `teams` row may name the sentinel tenant.
--
-- `20260901090000_forbid_system_tenant_membership` closed the membership table;
-- these two are the other side of the same invariant, and they are the pair that
-- IdP-influenced claim resolution can reach. `src/auth.ts` and
-- `src/lib/auth/session/auth-adapter.ts` write `users.tenant_id` from a tenant
-- the asserted claim resolved to, so a `tenant_claims` row pointing at
-- `__system__` — writable only out of band, since `tenant-domain add` refuses a
-- sentinel target — would file a real account under "no owning tenant". Every
-- tenant resolver keys on `tenant_members`, so such a user would then be a
-- member of nothing while owning rows the sentinel is the FK target for.
--
-- A CHECK rather than an application guard, for the same reason the membership
-- one is: it is decided regardless of caller, it is not deferrable (SET
-- CONSTRAINTS applies only to deferrable FK/UNIQUE constraints), COPY cannot
-- skip it, and it survives the out-of-band write that is the only way to reach
-- this state at all. The application-level half is the refusal in
-- `withTenantRls` (src/lib/tenant-rls.ts), which covers the ~10 tenant-scoped
-- columns these two do not; the CHECKs are here because these two are reachable
-- from a claim rather than from an administrator's action.
--
-- `teams` is included even though no sign-in path writes a `teams` row: the
-- constraint is cheap, the column has the same provenance once a team is created
-- inside a tenant, and an out-of-band write is exactly what the CHECK is for.
--
-- Pre-flight, dev, 2026-09-04: users 0, teams 0 rows naming the sentinel. A
-- non-zero count is a data incident and must be resolved before this applies —
-- see docs/operations/sentinel-tenant-membership.md.
--
-- The literal is SYSTEM_TENANT_ID in src/lib/constants/app.ts. Applied
-- migrations are checksummed, so this file is the immutable side of that pair:
-- if the two ever diverge, the constant is what moves.
-- scripts/checks/check-sentinel-tenant-literal-parity.mjs enforces the tie and
-- counts BOTH occurrences below.
--
-- Rollback (one transaction):
--   BEGIN;
--   ALTER TABLE "teams" DROP CONSTRAINT "teams_not_system_tenant";
--   ALTER TABLE "users" DROP CONSTRAINT "users_not_system_tenant";
--   COMMIT;
BEGIN;

ALTER TABLE "teams"
  ADD CONSTRAINT "teams_not_system_tenant"
  CHECK ("tenant_id" <> '00000000-0000-4000-8000-000000000002'::uuid);

ALTER TABLE "users"
  ADD CONSTRAINT "users_not_system_tenant"
  CHECK ("tenant_id" <> '00000000-0000-4000-8000-000000000002'::uuid);

COMMIT;
