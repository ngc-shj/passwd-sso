# Code Review: audit-delivery-target-crud
Date: 2026-04-14
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 — Critical: AAD mismatch (encrypt without AAD, worker decrypts with AAD)
- File: route.ts:143-146 / audit-outbox-worker.ts:538-549
- **Resolved**: Pre-generate UUID, build AAD, pass to encryptServerData

### F2 — Major: PATCH no-op guard missing
- File: [id]/route.ts:61-78
- **Resolved**: Added early return when `target.isActive === data.isActive`

### F3 — Minor: secretPlaceholder says "auto-generate" but no auto-generation
- **Resolved**: Changed placeholder wording to "HMAC secret for request signing"

### F4 — Minor: kind redundancy in encrypted blob
- **Resolved**: Stripped `kind` from config blob before encryption

## Security Findings

### S1 — Critical: AAD mismatch (same as F1)
- **Resolved**: See F1

### S2 — Critical: S3 config schema mismatch (bucket vs endpoint)
- File: route.ts:58-65 / audit-delivery.ts:38-43
- **Resolved**: Changed to `endpoint` URL field matching worker schema. SSRF guard applied.

### S3 — Major: WEBHOOK secret optional vs required mismatch
- File: route.ts:49 / audit-delivery.ts:30
- **Resolved**: Made secret required (`z.string().min(1)`)

### S4 — Major: SSRF DNS rebinding
- **Skipped**: Worker-side `validateAndFetch()` blocks actual SSRF. Input-time check matches existing webhook pattern. Improvement deferred.
- Anti-Deferral check: acceptable risk
  - Worst case: nip.io URL stored → worker rejects at delivery time → failCount increases
  - Likelihood: Low (requires admin credentials + deliberate action)
  - Cost to fix: Medium (DNS resolution at input time, ~2h implementation)

### S5-S7 — Minor findings
- S5 (Cache-Control on GET): Skipped — matches webhook pattern
- S6 (max length on credentials): Skipped — matches webhook pattern
- S7 (TOCTOU in PATCH): Skipped — benign, matches webhook pattern

## Testing Findings

### T1-T9 — Minor findings
- T8 (encryptServerData assertion): **Resolved** — changed to parse JSON and compare object + verify AAD buffer argument
- T1-T7, T9: Skipped — minor test improvements that match existing webhook test quality level

## Resolution Status
### F1/S1 Critical: AAD mismatch — Fixed
- Action: Pre-generate UUID, build AAD buffer, pass as 3rd arg to encryptServerData
- Modified: src/app/api/tenant/audit-delivery-targets/route.ts

### S2 Critical: S3 schema mismatch — Fixed
- Action: Changed S3_OBJECT schema from bucket/prefix to endpoint URL
- Modified: route.ts, audit-delivery-target-card.tsx, i18n files, tests

### S3 Major: WEBHOOK secret — Fixed
- Action: Made secret required in Zod schema
- Modified: route.ts, tests

### F2 Major: PATCH no-op guard — Fixed
- Action: Added early return when isActive unchanged
- Modified: [id]/route.ts, [id]/route.test.ts

### F3 Minor: Placeholder wording — Fixed
- Action: Changed to accurate description
- Modified: messages/en/AuditDeliveryTarget.json, messages/ja/AuditDeliveryTarget.json

### F4 Minor: Kind in blob — Fixed
- Action: Strip kind before JSON.stringify
- Modified: route.ts, route.test.ts
