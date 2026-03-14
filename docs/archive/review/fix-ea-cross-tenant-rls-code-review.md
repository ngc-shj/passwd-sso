# Code Review: fix-ea-cross-tenant-rls
Date: 2026-03-14
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Minor] tokenExpiresAt asymmetry between accept paths
- **Problem**: By-ID accept (`/api/emergency-access/[id]/accept`) no longer checks `tokenExpiresAt`, so PENDING grants can be accepted indefinitely via dashboard. Token-based accept still enforces 7-day expiry.
- **Impact**: Low. Owner can revoke at any time. Dashboard is considered a deliberate trusted interaction.
- **Recommended action**: Add code comment explaining intentional omission.

## Security Findings

### S1 [Minor] Auth check inconsistency in vault routes (pre-existing)
- **Problem**: `vault` and `vault/entries` routes only check `session.user.id`, not `session.user.email`. Other grantee routes check both.
- **Impact**: Negligible. These routes use `granteeId` for authorization, not email.
- **Assessment**: Pre-existing issue, not introduced by this change. Skip for this PR.

### S2 [Minor] canTransition not used in decline route (pre-existing)
- **Problem**: `decline` uses direct status check instead of `canTransition()` state machine.
- **Impact**: Negligible. Current status set makes this equivalent.
- **Assessment**: Pre-existing issue, not introduced by this change. Skip for this PR.

### S3 [Minor] Nested transaction in withBypassRls (pre-existing)
- **Problem**: `[id]/accept` calls `prisma.$transaction` inside `withBypassRls`.
- **Impact**: Low. `set_config(..., true)` with `is_local=true` scopes to transaction correctly.
- **Assessment**: Pre-existing pattern, not introduced by this change. Skip for this PR.

## Testing Findings

### T1 [Minor] No assertion on mockWithBypassRls in approve/revoke tests
- **Problem**: `approve` and `revoke` test files declare `mockWithBypassRls` but never assert it was called.
- **Impact**: Regression from `withBypassRls` back to `withUserTenantRls` would go undetected.
- **Recommended action**: Add `expect(mockWithBypassRls).toHaveBeenCalledTimes(1)` in happy-path tests.

### T2 [Minor] findFirst not configured in route.test.ts
- **Problem**: `mockPrismaUser.findFirst` is not configured in `beforeEach`, so grantee locale lookup always returns `undefined`.
- **Impact**: Negligible. Locale lookup is best-effort; email is sent regardless.
- **Assessment**: Pre-existing gap. Skip for this PR.

### T3 [Minor] Missing comment on tokenExpiresAt fixture removal
- **Problem**: `pendingGrant` fixture in `[id]/accept` test removed `tokenExpiresAt` without explanation.
- **Impact**: Negligible. Merged with F1.
- **Recommended action**: Add brief comment.

## Resolution Status

### F1 [Minor] tokenExpiresAt asymmetry
- **Action**: Added comment in `[id]/accept/route.ts` (line 48-49) explaining intentional omission
- **Status**: Resolved

### S1 [Minor] Auth check inconsistency in vault routes
- **Action**: Skipped — pre-existing, not introduced by this change
- **Status**: Out of scope

### S2 [Minor] canTransition not used in decline
- **Action**: Skipped — pre-existing, not introduced by this change
- **Status**: Out of scope

### S3 [Minor] Nested transaction in withBypassRls
- **Action**: Skipped — pre-existing pattern, `set_config(is_local=true)` scopes correctly
- **Status**: Out of scope

### T1 [Minor] No assertion on mockWithBypassRls
- **Action**: Added `expect(mockWithBypassRls).toHaveBeenCalledTimes(1)` in approve and revoke happy-path tests
- **Status**: Resolved

### T2 [Minor] findFirst not configured
- **Action**: Skipped — pre-existing gap, low value
- **Status**: Out of scope

### T3 [Minor] Missing comment on tokenExpiresAt removal
- **Action**: Merged with F1 — comment added in route file explains the design decision
- **Status**: Resolved
