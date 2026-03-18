# Code Review: lockout-admin-alert
Date: 2026-03-17
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Critical] — Dismissed
`withBypassRls` inner `prisma` calls routed to `tx` via Proxy + AsyncLocalStorage. Verified in `src/lib/prisma.ts:136-165` and `src/lib/tenant-rls.ts:27-35`. This is the project-wide pattern.

### F2 [Major] — Resolved
`sendEmail` failure skipped remaining admins. Added per-admin try/catch in `lockout-admin-notify.ts` loop to isolate failures.

### F3 [Major] — Dismissed
`failedUnlockAttempts` has `@default(0)` in schema. Existing code, not introduced by this PR.

### F4 [Minor] — Dismissed
Text body uses raw params (no HTML escaping needed). Same pattern as `new-device-login.ts`.

### F5 [Minor] — Dismissed
`notification-messages.ts` locale check is existing code. Out of scope for this PR.

## Security Findings

### S1 [Critical] — Dismissed
`notificationBody` output rendered as JSX text node (`{resolveNotificationBody(n, t)}`) — React auto-escapes. No `dangerouslySetInnerHTML`. No XSS risk.

### S2 [Major] — Dismissed
`userId` (UUID) logging is existing pattern throughout codebase. Out of scope.

### S3 [Minor] — Dismissed
`createNotification` returns `void` (not Promise). Internal `void (async () => {...})().catch(() => {})` pattern. No promise leakage.

### S4 [Minor] — Dismissed
Timestamp offset is negligible for fire-and-forget that runs synchronously after `void` call.

## Testing Findings

### T1 [Major] — Resolved
Added `createNotification` assertion and 2-admin failover test for `sendEmail` error scenario.

### T2 [Major] — Resolved
Changed `mockNotifyAdminsOfLockout` to `.mockResolvedValue(undefined)` to match async signature.

### T3 [Minor] — Resolved
Replaced dynamic `import()` with hoisted `mockVaultLockoutEmail` mock.

### T4 [Minor] — Resolved
Added XSS escaping tests for `ipAddress` and `timestamp` params.

### T5 [Minor] — Dismissed
`vi.useRealTimers()` in test body is existing code pattern. Out of scope.

## Adjacent Findings
None

## Resolution Status

### F2 [Major] sendEmail failure isolation
- Action: Added per-admin try/catch with `lockout.adminNotify.perAdmin.error` log
- Modified file: src/lib/lockout-admin-notify.ts:68-112

### T1 [Major] sendEmail error test assertion
- Action: Expanded test to verify 2-admin scenario with first failure + second success
- Modified file: src/lib/lockout-admin-notify.test.ts:229-258

### T2 [Major] Mock async signature
- Action: Changed to `.mockResolvedValue(undefined)`
- Modified file: src/lib/account-lockout.test.ts:24

### T3 [Minor] Dynamic import consistency
- Action: Added `mockVaultLockoutEmail` to hoisted block, removed dynamic import
- Modified file: src/lib/lockout-admin-notify.test.ts:12,30,48,280

### T4 [Minor] Additional XSS tests
- Action: Added `ipAddress` and `timestamp` escaping tests
- Modified file: src/lib/email/templates/vault-lockout.test.ts:84-98
