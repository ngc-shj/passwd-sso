# Plan Review: lockout-admin-alert
Date: 2026-03-17
Review round: 2

## Changes from Previous Round

### Round 1 → Round 2 resolutions
- F1 [Resolved] Added `thresholdCrossed` flag using `prevAttempts < matchedThreshold.attempts`
- F2 [Resolved] Explicit `String()` conversion specified for `notificationBody` args
- F3 [Resolved] Documented as existing behavior (out of scope for this PR)
- S1 [Resolved] Merged two `withBypassRls` into single transaction
- S2 [Resolved] Explicit `escapeHtml()` requirement added to plan
- S3 [Recorded] Accepted risk — Prisma 5s default tx timeout, lockout is low-frequency
- T1 [Resolved] 3 threshold test cases (5/10/15) with `lockMinutes` verification
- T2 [Resolved] Tests `await` function directly; `account-lockout.test.ts` uses mock
- T3 [Resolved] Separate tests for `withBypassRls` throws and `sendEmail` throws
- T4 [Dismissed] Template doesn't use `appUrl`

### Round 2 new findings
- F4 [Resolved] Simplified `thresholdCrossed` to `prevAttempts < matchedThreshold.attempts`
- F5 [Resolved] Audit log stays on `lockMinutes !== null`, notification gated by `thresholdCrossed` — explicitly documented
- F6 [Resolved] Pass `tenantId` to `createNotification` to avoid double lookup

## Functionality Findings

### F1 [Major] — Resolved (Round 1)
Notification flood prevented by `thresholdCrossed` flag.

### F2 [Major] — Resolved (Round 1)
`String(lockMinutes)` conversion explicitly specified.

### F3 [Minor] — Resolved (Round 1)
Documented as existing behavior.

### F4 [Major] — Resolved (Round 2)
`thresholdCrossed` formula simplified from indirect `lockMinutes` comparison to direct `prevAttempts < matchedThreshold.attempts`.

### F5 [Major] — Resolved (Round 2)
Audit log and notification intentionally have different firing conditions. Documented in plan.

### F6 [Minor] — Resolved (Round 2)
`tenantId` passed to `createNotification` from the single transaction result.

## Security Findings

### S1 [Major] — Resolved (Round 1)
Single `withBypassRls` transaction eliminates TOCTOU.

### S2 [Minor] — Resolved (Round 1)
`escapeHtml()` explicitly required for all template params.

### S3 [Minor] — Recorded (Round 1)
Accepted risk. Prisma 5s default tx timeout + lockout is low-frequency.

### Round 2: No new security findings
All previous items verified as correctly resolved.

## Testing Findings

### T1-T3 [Major] — Resolved (Round 1)
All test gaps addressed in plan.

### T4 [Minor] — Dismissed (Round 1)
Template doesn't use `appUrl`.

### T5-T9 — Dismissed (Round 2)
Testing agent checked for implementation code that doesn't exist yet. This is expected in Phase 1 (Plan Review) — the plan describes what will be created in Phase 2.

## Adjacent Findings
None
