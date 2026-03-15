# Coding Deviation Log: tenant-webhook
Created: 2026-03-15

## Deviations from Plan

### D-1: Dispatch call sites count is 18, not ~20
- **Plan description**: ~20 dispatch call sites
- **Actual implementation**: 18 `dispatchTenantWebhook` calls across 15 files
- **Reason**: Plan counted some multi-action files as separate entries, but actual unique `logAudit` sites with tenant scope were 18
- **Impact scope**: No missing coverage — all planned audit actions are dispatched

### D-2: `sanitizeWebhookData` implemented instead of reusing `sanitizeMetadata`
- **Plan description**: Apply `sanitizeMetadata()` from `src/lib/audit.ts` with extended blocklist
- **Actual implementation**: Created standalone `sanitizeWebhookData()` in `webhook-dispatcher.ts` using `WEBHOOK_METADATA_BLOCKLIST` (superset of `METADATA_BLOCKLIST`)
- **Reason**: `sanitizeMetadata` is tightly coupled to audit-logger's blocklist. Webhook needs additional PII keys (email, reason, incidentRef, displayName). A separate function avoids modifying the shared audit sanitizer
- **Impact scope**: `src/lib/webhook-dispatcher.ts` only; same recursive sanitization logic

### D-3: Migration not created (db:push used instead)
- **Plan description**: Run `npm run db:migrate` to create migration file
- **Actual implementation**: Used `npm run db:push` for schema sync; migration will be created at merge time
- **Reason**: Feature branch development — migration naming and ordering should be finalized when merging to main
- **Impact scope**: No migration file in `prisma/migrations/`; schema is correct

### D-4: WebhookEvent type alias kept for backward compatibility
- **Plan description**: Replace `WebhookEvent` with `TeamWebhookEvent`
- **Actual implementation**: Added `TeamWebhookEvent` and kept `WebhookEvent` as deprecated alias
- **Reason**: Existing call sites import `WebhookEvent`; deprecated alias avoids breaking changes
- **Impact scope**: `src/lib/webhook-dispatcher.ts` — no functional change
