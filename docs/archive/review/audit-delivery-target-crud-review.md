# Plan Review: audit-delivery-target-crud
Date: 2026-04-14
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 — Major: Missing AUDIT_DELIVERY_TARGET_REACTIVATE audit action
- **Problem**: FR-3 allows toggling isActive in both directions (deactivate + reactivate), but FR-5 only defines AUDIT_DELIVERY_TARGET_CREATE and _DEACTIVATE. Reactivation has no audit action.
- **Impact**: Audit trail incomplete — no record of who re-enabled a delivery target. Compliance gap.
- **Recommended action**: Add `AUDIT_DELIVERY_TARGET_REACTIVATE` to Prisma enum, AUDIT_ACTION, AUDIT_ACTION_VALUES. PATCH handler branches on isActive direction.

### F2 — Major: New audit actions need explicit scope group placement
- **Problem**: `audit.test.ts` enforces that every action in AUDIT_ACTION_VALUES belongs to at least one scope group. Plan says "add to AUDIT_ACTION_GROUPS_TENANT" but doesn't specify which group (new AUDIT_DELIVERY_TARGET group or existing MAINTENANCE group).
- **Impact**: Tests fail if group placement is ambiguous or missing.
- **Recommended action**: Create new `AUDIT_DELIVERY_TARGET` group in AUDIT_ACTION_GROUP, add to AUDIT_ACTION_GROUPS_TENANT. Decide whether to include in TENANT_WEBHOOK_EVENT_GROUPS (for external webhook dispatch of these events — likely no, since they're in WEBHOOK_DISPATCH_SUPPRESS).

### F3 — Major: ROLE_PERMISSIONS update missing from plan steps
- **Problem**: Adding AUDIT_DELIVERY_MANAGE to TENANT_PERMISSION is insufficient — must also add to ROLE_PERMISSIONS OWNER and ADMIN sets in `src/lib/tenant-auth.ts`. Without this, requireTenantPermission() always returns 403.
- **Impact**: Feature completely non-functional (always 403).
- **Recommended action**: Add substep to Step 1 to update ROLE_PERMISSIONS in tenant-auth.ts.

### F4 — Major: admin-sidebar.test.tsx link count will break
- **Problem**: admin-sidebar.test.tsx hardcodes total link count (20) and expectedHrefs array. Adding delivery child increases count to 22.
- **Impact**: vitest run fails on admin-sidebar.test.tsx.
- **Recommended action**: Add admin-sidebar.test.tsx update to Step 5.1.

### F5 — Minor: Terminology inconsistency ("soft-delete" vs "deactivate")
- **Problem**: FR-3 uses "soft-delete" but the operation is actually toggle-deactivate (reversible).
- **Recommended action**: Unify terminology to "deactivate/reactivate" throughout.

### F6 — Minor: Count limit scope unclear (active vs all targets)
- **Problem**: FR-2 says "Max 10" but doesn't specify whether inactive targets count toward the limit.
- **Recommended action**: Explicitly state that count includes all targets (active + inactive), matching existing webhook pattern.

## Security Findings

### S1 — Major: SSRF guard missing on config URL fields
- **Problem**: Webhook route has SSRF .refine() on URL (HTTPS only, no localhost/private IPs). Plan's config blob schema for WEBHOOK and SIEM_HEC kinds includes URL fields without specifying equivalent SSRF validation.
- **Impact**: Although worker-side validateAndFetch() blocks actual SSRF at delivery time, input-time validation is needed for fail-fast and consistency with NFR-1 (follow webhooks pattern).
- **Recommended action**: Add SSRF refine to WEBHOOK.url and SIEM_HEC.url in the Zod schema. Consider extracting shared SSRF URL validator from existing webhook code.

### S2 — Minor: TOCTOU on count limit check
- **Problem**: count + create are separate DB operations (no transaction). Same pattern as existing webhooks.
- **Recommended action**: Accept as existing design tradeoff (admin-only operation, low concurrency risk).

### S3 — Minor: Permission role assignment not specified
- **Problem**: Plan doesn't state which roles get AUDIT_DELIVERY_MANAGE.
- **Recommended action**: Explicitly state OWNER + ADMIN (same as WEBHOOK_MANAGE).

### S4 — Minor: OUTBOX_BYPASS_AUDIT_ACTIONS addition is semantically incorrect
- **Problem**: OUTBOX_BYPASS_AUDIT_ACTIONS contains worker-originated SYSTEM events. AUDIT_DELIVERY_TARGET_CREATE/DEACTIVATE are user-originated CRUD actions — they don't belong in this set. WEBHOOK_DISPATCH_SUPPRESS alone suffices.
- **Impact**: Tests checking OUTBOX_BYPASS_AUDIT_ACTIONS.size break. Semantic confusion for future developers.
- **Recommended action**: Remove from OUTBOX_BYPASS_AUDIT_ACTIONS, keep only in WEBHOOK_DISPATCH_SUPPRESS.

## Testing Findings

### T1 — Major: Count limit test needs soft-delete scenario
- **Problem**: Since only soft-delete is available, tests must verify whether inactive targets count toward the limit.
- **Impact**: Mock-reality divergence if count query WHERE clause doesn't match expectations.
- **Recommended action**: Add test case with inactive targets in count, assert mock called with correct WHERE.

### T2 — Major: PATCH reactivate test case missing
- **Problem**: Plan only mentions DEACTIVATE audit action for PATCH. Reactivate direction needs its own test.
- **Impact**: Reactivate path completely untested.
- **Recommended action**: Add reactivate test (isActive: true PATCH) with audit action assertion.

### T3 — Minor: Tests should use AUDIT_ACTION constants, not string literals
- **Problem**: If tests use hardcoded strings for audit actions, typos won't be caught.
- **Recommended action**: Import and use AUDIT_ACTION.AUDIT_DELIVERY_TARGET_CREATE etc.

### T4 — Minor: Integration test coverage claim inaccurate
- **Problem**: Existing integration tests cover RLS/worker-role grants, not app-role CRUD operations.
- **Recommended action**: Correct the "existing coverage" statement in the testing strategy section.

## Adjacent Findings

### F2-A [Adjacent] — Testing: audit.test.ts group coverage test
F2 notes that `audit.test.ts` enforces all actions belong to a group. This overlaps with T3 (test infrastructure awareness).

### S4-A [Adjacent] — Testing: OUTBOX_BYPASS_AUDIT_ACTIONS size assertion
S4 notes that `audit-bypass-coverage.test.ts` has a hardcoded size assertion that would break. This is a test update requirement.

## Quality Warnings
None

## Recurring Issue Check

### Functionality expert
- R1 (Shared utility reimplementation): Checked — no issue (encryptServerData reused)
- R2 (Constants hardcoded): Checked — MAX_AUDIT_DELIVERY_TARGETS extracted to constant
- R3 (Pattern propagation): Checked — Finding F3 (ROLE_PERMISSIONS update)
- R4 (Event dispatch gaps): N/A — no mutation dispatch
- R5 (Missing transactions): Checked — count+create TOCTOU noted but accepted per existing pattern
- R6 (Cascade delete orphans): N/A — no physical delete
- R7 (E2E selector breakage): N/A — no E2E tests
- R8 (UI pattern inconsistency): Checked — standalone card, not reusing BaseWebhookCard
- R9 (Transaction boundary for fire-and-forget): N/A — logAudit is fire-and-forget outside tx
- R10 (Circular module dependency): Checked — no circular imports
- R11 (Display group ≠ subscription group): Checked — new group separate from event groups
- R12 (Enum/action group coverage gap): Finding F2
- R13 (Re-entrant dispatch loop): Checked — WEBHOOK_DISPATCH_SUPPRESS covers it
- R14 (DB role grant completeness): N/A — no new DB roles
- R15 (Hardcoded env values in migrations): Checked — migration uses only ALTER TYPE

### Security expert
- R1-R15: See above
- RS1 (Timing-safe comparison): Checked — no credential comparison
- RS2 (Rate limiter): Noted — same pattern as webhooks (no per-route limiter)
- RS3 (Input validation): Finding S1 (SSRF guard on URL fields)

### Testing expert
- R1-R15: See above
- RT1 (Mock-reality divergence): Finding T1 (count WHERE clause)
- RT2 (Testability verification): Checked — all endpoints are testable
- RT3 (Shared constant in tests): Finding T3 (use AUDIT_ACTION constants)
