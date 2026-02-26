# Tenant/Team Migration Phase 5 (RLS Optional)

## Goal

Add DB-enforced tenant isolation using PostgreSQL RLS after Phase 4 tenant constraints are stable.

## Scope

1. Enable RLS on tenant-scoped tables:
- `organizations`
- `tenant_members`
- `scim_tokens`
- `scim_external_mappings`
2. Apply tenant policies based on DB session settings
3. Add trusted-job bypass for operational tasks

## SQL Asset

- `scripts/tenant-team-phase5-rls.sql`

## Session Contract

Application/session layer must set either:

1. normal request:
- `SET app.tenant_id = '<tenant-id>'`

2. trusted service job:
- `SET app.bypass_rls = 'on'`

Without one of these, access is denied by policy.

## Rollout Plan

1. Stage
- apply RLS script without `FORCE ROW LEVEL SECURITY`
- run smoke tests and SCIM checks

2. Prod canary
- monitor 4xx/5xx and DB errors

3. Prod full
- optionally enable `FORCE ROW LEVEL SECURITY`

## Rollback

Disable on affected tables:

```sql
ALTER TABLE "organizations" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_members" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "scim_tokens" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "scim_external_mappings" DISABLE ROW LEVEL SECURITY;
```
