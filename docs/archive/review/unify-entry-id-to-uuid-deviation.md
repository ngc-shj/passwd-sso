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

### DEV-3: Expanded scope from 4 models to all 39 models
- **Plan description**: Plan targeted only 4 AAD-bound models; 35 server-generated models kept `@default(cuid())`
- **Actual implementation**: Changed ALL 39 models to `@default(uuid(4))`, replaced ALL `.cuid()` validations with `.uuid()`, and changed `.min(1)` ID validations to `.uuid()`
- **Reason**: User decision to adopt Policy A ("all IDs are UUID v4, no exceptions") since dev DB had no production CUID data to preserve, and CUID v1 is deprecated
- **Impact scope**: All models, all validations, all test fixtures with CUID-format IDs

### DEV-4: CUID-to-UUID data conversion migration added
- **Plan description**: Plan explicitly stated "no data migration"
- **Actual implementation**: Added `20260321100000_unify_all_ids_to_uuid` migration that converts existing CUID IDs to UUID v4 using temp mapping tables, updating all FK references
- **Reason**: Policy A requires all existing data to be UUID format. Migration uses mapping tables to maintain FK consistency
- **Impact scope**: All tables with CUID data. AAD-bound encrypted data becomes undecryptable if userId/teamId changed (addressed by deleting encrypted data in dev)

### DEV-5: Native PostgreSQL uuid type conversion
- **Plan description**: Not in plan (plan only changed defaults)
- **Actual implementation**: Added `20260321110000_convert_id_columns_to_uuid_type` migration that converts 136 TEXT columns to native PostgreSQL `uuid` type, with `@db.Uuid` annotations in schema. Migration dynamically saves/restores FK constraints, RLS policies, CHECK constraints, and triggers. Trigger functions updated for uuid compatibility
- **Reason**: User requested native uuid type for storage efficiency (16 bytes vs 36 bytes per value) and type safety
- **Impact scope**: All ID/FK columns, all RLS policies, all triggers, bootstrap tenant ID generation changed from CONCAT to md5()::uuid
