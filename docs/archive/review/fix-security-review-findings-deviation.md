# Coding Deviation Log: fix-security-review-findings
Created: 2026-04-03

## Deviations from Plan

### DEV-1: userId type changed to `string | null` instead of just `string`
- **Plan description**: Make userId required (`userId: string`) in `SubmitPersonalLoginFormArgs`
- **Actual implementation**: Changed to `userId: string | null` with runtime guard
- **Reason**: The vault context returns `string | null` (from `session?.user?.id ?? null`), not `string`. Making it non-nullable would require the guard at a higher level (component), whereas the current form submission chain already handles null via early return.
- **Impact scope**: `personal-login-submit.ts`, `personal-login-form-submit-args.ts`, `personal-login-form-controller.ts`

### DEV-2: F-6 (rotate-key aadVersion) resolved in-PR after DB inspection
- **Plan description**: Not in original plan (discovered during code review)
- **Initial assessment**: Deferred — feared breaking key rotation for legacy aadVersion:0 entries
- **Actual implementation**: DB inspection confirmed zero legacy entries exist. Changed `min(0).default(0)` to `min(1)` in rotate-key schema, matching team rotate-key which already enforced `min(1)`.
- **Impact scope**: `src/app/api/vault/rotate-key/route.ts` — entries and historyEntries schemas
