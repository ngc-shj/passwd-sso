# Code Review: add-delegation-session-migration

Date: 2026-03-30
Review rounds: 2

## Round 1: Initial Review

### Functionality Findings

#### F-Func-1 [Critical]: AuditAction enum values missing from migration — RESOLVED

- Evidence: `prisma/schema.prisma` L844-848 defines 5 DELEGATION_* values. No `ALTER TYPE` in any migration.
- Fix: Added `ALTER TYPE "AuditAction" ADD VALUE` for all 5 values.

#### F-Func-2 [Major]: Tenant delegation TTL columns missing from migration — RESOLVED

- Evidence: `prisma/schema.prisma` L454-455 defines `delegationDefaultTtlSec`/`delegationMaxTtlSec`. No `ALTER TABLE` in any migration.
- Fix: Added `ALTER TABLE "tenants" ADD COLUMN` for both columns.

#### F-Func-3 [Minor]: Dead code in 20260329100000 migration — ACCEPTED

- Dead `DO $$...$$` block referencing `delegation_sessions` before it exists. No functional impact.

### Security Findings

#### F-Sec-1 [Minor]: CASCADE DELETE bypasses audit log — ACCEPTED

- `ON DELETE CASCADE` on `mcp_token_id` silently removes delegation sessions without audit entries. Design trade-off.

#### F-Sec-2 [Minor]: Plain text metadata in DB — ACCEPTED

- `entry_ids` and `note` stored as plain text. Acceptable risk for current threat model.

### Testing Findings

#### F-Test-1 [Major]: Missing test for DELETE /api/vault/delegation/[id] — RESOLVED

- Created `src/app/api/vault/delegation/[id]/route.test.ts` with 7 tests.

#### F-Test-2 [Major]: rls-smoke CI job missing delegation_sessions — RESOLVED

- Added seed data and assertions for `delegation_sessions`, `tenant_webhooks`, `mcp_refresh_tokens`.

#### F-Test-3 [Minor]: app-ci lacks migration deployment verification — ACCEPTED

- Future improvement.

### Adjacent Findings

#### F-Adjacent-1 [Major]: tenant_webhooks and mcp_refresh_tokens missing RLS — RESOLVED

- Added `ENABLE/FORCE ROW LEVEL SECURITY` for `tenant_webhooks`.
- Added full RLS setup for `mcp_refresh_tokens` (ENABLE/FORCE/CREATE POLICY).

## Round 2: Incremental Review

All Round 1 Critical/Major fixes verified correct and complete.

### New Findings (all Minor, accepted)

#### F-Func-4 [Minor]: DELEGATION_EXPIRE logAudit emit not implemented — ACCEPTED

- Enum value reserved for future cleanup job. No current caller.

#### F-Func-5 [Minor]: Tenant TTL write API not implemented — ACCEPTED

- Read path works correctly. Admin UI/API will be added in separate PR.

#### F-Sec-4 [Minor]: DCR nullable tenant_id and RLS policy interaction — ACCEPTED

- Intentional design: DCR operations use `withBypassRls()`.

#### F-Sec-5 [Minor]: rls-smoke lacks positive test — ACCEPTED

- Only verifies block without tenant_id. Positive test (correct tenant_id returns rows) would be a future improvement.

#### F-Test-5 [Major→Deferred]: revokeDelegationSession audit log not tested — DEFERRED

- Requires `src/lib/delegation.test.ts` creation. Out of scope for this migration fix. TODO: add delegation.ts unit tests.

#### F-Test-6 [Minor]: CSRF test body assertion missing — RESOLVED

- Added `expect(json.error).toBeDefined()` to CSRF test.

#### F-Test-7 [Minor]: delegation.ts unit tests missing — DEFERRED

- TODO: create `src/lib/delegation.test.ts` covering core functions.

## Final Resolution Status

| Finding | Severity | Status |
|---------|----------|--------|
| F-Func-1 | Critical | Resolved |
| F-Func-2 | Major | Resolved |
| F-Func-3 | Minor | Accepted |
| F-Sec-1 | Minor | Accepted |
| F-Sec-2 | Minor | Accepted |
| F-Test-1 | Major | Resolved |
| F-Test-2 | Major | Resolved |
| F-Test-3 | Minor | Accepted |
| F-Adjacent-1 | Major | Resolved |
| F-Func-4 | Minor | Accepted |
| F-Func-5 | Minor | Accepted |
| F-Sec-4 | Minor | Accepted |
| F-Sec-5 | Minor | Accepted |
| F-Test-5 | Major | Deferred (delegation.ts unit tests) |
| F-Test-6 | Minor | Resolved |
| F-Test-7 | Minor | Deferred (delegation.ts unit tests) |
