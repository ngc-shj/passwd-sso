# Coding Deviation Log: fix-import-rate-limit
Created: 2026-03-28

## Deviations from Plan

### D-1: Removed `passwordsPath` parameter from import interface
- **Plan description**: Plan did not explicitly mention removing `passwordsPath` from `RunImportParams` and callers
- **Actual implementation**: Removed `passwordsPath` from `RunImportParams`, `UseImportExecutionParams`, `useImportExecution`, `password-import.tsx`, and all test files since the bulk API path is now computed internally via `apiPath.passwordsBulkImport()` / `apiPath.teamPasswordsBulkImport(teamId!)`
- **Reason**: `passwordsPath` was used to construct the URL for single-entry POST. With bulk API, the URL is determined by `isTeamImport` + `teamId` internally. Keeping it would be dead code and trigger lint warnings.
- **Impact scope**: `password-import-importer.ts`, `use-import-execution.ts`, `password-import.tsx`, and their test files

### D-2: Added i18n translation keys for `ENTRY_BULK_IMPORT`
- **Plan description**: Step 0 mentioned adding `ENTRY_BULK_IMPORT` to Prisma schema and audit constants but did not mention i18n
- **Actual implementation**: Added `ENTRY_BULK_IMPORT` keys to `messages/en/AuditLog.json` and `messages/ja/AuditLog.json`
- **Reason**: Existing i18n test (`audit-log-keys.test.ts`) requires every `AUDIT_ACTION` to have a corresponding i18n entry in both locales
- **Impact scope**: `messages/en/AuditLog.json`, `messages/ja/AuditLog.json`

### D-3: Migration created manually instead of `prisma migrate dev`
- **Plan description**: Step 0 specified `npm run db:migrate`
- **Actual implementation**: Migration SQL file created manually (`prisma/migrations/20260329000000_add_entry_bulk_import_audit_action/migration.sql`) since no DB is available in the worktree environment
- **Reason**: `prisma migrate dev` requires a running PostgreSQL database. The migration SQL is a simple `ALTER TYPE "AuditAction" ADD VALUE 'ENTRY_BULK_IMPORT'`
- **Impact scope**: `prisma/migrations/` directory

---
