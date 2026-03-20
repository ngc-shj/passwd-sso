# Coding Deviation Log: unify-entry-id-to-uuid
Created: 2026-03-21

## Deviations from Plan

### DEV-1: Migration file created manually instead of via `prisma migrate dev`
- **Plan description**: Step 2 — Run `npm run db:migrate -- --name change-id-defaults-to-uuid`
- **Actual implementation**: Manually created `prisma/migrations/20260321090000_change_id_defaults_to_uuid/migration.sql` with the correct `ALTER TABLE ... SET DEFAULT gen_random_uuid()` statements
- **Reason**: Dev DB had migration drift from `20260315010418_add_breakglass_personal_log_access` being modified after application. `prisma migrate dev` refused to generate migration without first resetting the DB
- **Impact scope**: No functional impact. The SQL is identical to what Prisma would generate. Migration can be applied via `prisma migrate deploy` in production

### DEV-2: Additional test fixture fixes beyond Step 7 scope
- **Plan description**: Step 7 listed 5 specific test files to update
- **Actual implementation**: Also fixed `teams/route.test.ts` and `teams/[teamId]/passwords/route.test.ts` — these tests lacked the `id` field in their `validE2EBody` and failed after Step 3 made `id` required
- **Reason**: Plan's Step 7 did not fully account for all test files that construct `createTeamE2ESchema` / `createTeamE2EPasswordSchema` payloads
- **Impact scope**: Test-only changes. No production code impact
