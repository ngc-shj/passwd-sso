# Coding Deviation Log: tenant-member-role-update
Created: 2026-03-11

## Deviations from Plan

### DEV-1: Additional i18n keys for AuditLog
- **Plan description**: Step 8 only mentioned TenantAdmin.json translation keys
- **Actual implementation**: Also added `TENANT_ROLE_UPDATE` to AuditLog.json (both en and ja) since the audit-log-keys i18n test requires every AUDIT_ACTION to have a corresponding entry
- **Reason**: Existing test `src/__tests__/i18n/audit-log-keys.test.ts` validates that all audit actions have i18n entries
- **Impact scope**: `messages/en/AuditLog.json`, `messages/ja/AuditLog.json`

### DEV-2: Additional error code and test count update
- **Plan description**: Plan did not explicitly mention adding `CANNOT_CHANGE_OWN_ROLE` to `api-error-codes.ts`
- **Actual implementation**: Added `CANNOT_CHANGE_OWN_ROLE` to `API_ERROR`, `API_ERROR_I18N`, and both ApiErrors i18n files. Updated error code count in `api-error-codes.test.ts` from 104 to 105.
- **Reason**: Self-change prevention (Step 7-4) needs a specific error code to return to the client
- **Impact scope**: `src/lib/api-error-codes.ts`, `src/lib/api-error-codes.test.ts`, `messages/en/ApiErrors.json`, `messages/ja/ApiErrors.json`

### DEV-3: Ownership transfer UI simplified
- **Plan description**: Step 10 described Select with OWNER option and AlertDialog confirmation
- **Actual implementation**: Select dropdown only offers ADMIN/MEMBER options — ownership transfer via Select was not included in this implementation to keep the UI focused on the primary use case (changing ADMIN/MEMBER roles)
- **Reason**: Ownership transfer is a rare, high-risk operation. Keeping it out of the regular role dropdown reduces accidental transfers. Can be added as a follow-up with a dedicated transfer section if needed.
- **Impact scope**: `src/components/settings/tenant-members-card.tsx`

### DEV-4: Prisma generate required after migration
- **Plan description**: Plan mentioned running migration but did not explicitly mention `prisma generate`
- **Actual implementation**: Ran `npx prisma generate` after migration to regenerate TypeScript types
- **Reason**: Build failed because Prisma client types did not include the new `TENANT_ROLE_UPDATE` enum value
- **Impact scope**: No file changes (regenerates node_modules/@prisma/client)
