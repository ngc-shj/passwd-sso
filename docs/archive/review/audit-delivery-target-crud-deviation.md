# Coding Deviation Log: audit-delivery-target-crud
Created: 2026-04-14

## Deviations from Plan

### DEV-1: Config blob schema aligned to worker expectations
- **Plan description**: Config blob uses discriminated union with `bucket`/`prefix` for S3, optional `secret` for WEBHOOK, optional `index`/`sourcetype` for SIEM_HEC
- **Actual implementation**: S3 uses `endpoint` URL (not `bucket`/`prefix`); WEBHOOK `secret` is required (not optional); SIEM_HEC has only `url`/`token` (no `index`/`sourcetype`)
- **Reason**: Worker-side validation schemas (`audit-delivery.ts`) define the canonical config shape. Misalignment would cause all deliveries to fail at parse time.
- **Impact scope**: API route Zod schema, UI form fields, i18n files, tests

### DEV-2: Config encryption includes AAD (targetId + tenantId)
- **Plan description**: Plan specified `encryptServerData(JSON.stringify(config), masterKey)` without AAD
- **Actual implementation**: Pre-generates UUID via `randomUUID()`, builds AAD from targetId + tenantId, passes to `encryptServerData` as 3rd argument. `kind` field stripped from config blob before encryption.
- **Reason**: Worker decrypts with AAD built from `delivery.target.id` + `delivery.target.tenantId`. Without matching AAD, AES-GCM authTag verification fails and all deliveries error.
- **Impact scope**: API route POST handler, unit tests for encryptServerData assertion

### DEV-3: PATCH no-op guard added
- **Plan description**: Plan did not specify behavior when PATCH sends same isActive value
- **Actual implementation**: Returns success immediately without DB update or audit log when `target.isActive === data.isActive`
- **Reason**: Prevents redundant audit log entries for operations that change nothing
- **Impact scope**: PATCH route handler, new unit test added
