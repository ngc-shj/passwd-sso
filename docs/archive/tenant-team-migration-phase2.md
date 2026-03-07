# Tenant/Team Migration Phase 2 (Backfill + Validation)

## Goal

Backfill tenant ownership data after Phase 1 additive schema so tenant-aware logic can be enabled safely.

This phase is data-migration only:
- no API behavior switch yet
- no constraint tightening yet

## Scope

1. Create missing tenant rows from existing teams
2. Backfill `tenant_id` on:
- `teams`
- `scim_tokens`
- `scim_external_mappings`
3. Seed `tenant_members` from active `team_members`
4. Run validation SQL pack

## Initial Mapping Policy

Current rollout policy is deterministic `1 team = 1 tenant`:
- `tenant.id = team.id`
- tenant slug = `tenant-{team.slug}`

This allows idempotent backfill and a clean rollback path.

## SQL Assets

- Migration SQL:
  - `prisma/migrations/20260226182000_tenant_team_phase2_backfill/migration.sql`
- Validation SQL:
  - `scripts/tenant-team-phase2-validate.sql`

## Validation Criteria

All checks should return `0`:
- null `tenant_id` counts for target tables
- orphan tenant FK checks
- duplicate candidate checks for future tenant-scoped uniqueness

## Rollback Guidance

If rollback is required before Phase 3 cutover:

1. Stop rollout traffic
2. Restore DB snapshot taken before Phase 2
3. Keep Phase 1 additive schema in place (safe no-op)

Avoid partial manual rollback unless strictly necessary.
