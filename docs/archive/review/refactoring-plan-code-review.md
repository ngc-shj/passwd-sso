# Code Review: refactoring-plan
Date: 2026-03-14T02:15:00+09:00
Review round: 4 (parseBody batch review round 1)

## Changes from Previous Round
Round 4: Extended parseBody migration to 17 additional routes (Type A/B/C). Security review found schema detail leakage in security-sensitive endpoints — reverted vault/admin-reset and auth/passkey/options/email to inline parsing. Added VALIDATION_ERROR assertions to 4 test files. Documented parseBody ordering in watchtower/alert.

## Functionality Findings

### [F1] Minor — `"use client"` directive on crypto-utils.ts — Resolved (Round 1)
### [F2] Minor — `hexDecode` silently truncates odd-length input — Resolved (Round 1)
### [F3] Minor — Unnecessary `as ZodError` cast in parse-body.ts — Resolved (Round 1)
### [F4] Minor — `parse-body.ts` and `with-request-log.ts` missing from coverage.include — Resolved (Round 1)
### [F5] Minor — Inline hexDecode copy in share-e2e-entry-view.tsx — Resolved (Round 2)
### [F-N1] Minor — Inline `toAB` duplicates `toArrayBuffer` in share-e2e-entry-view.tsx — Resolved (Round 3)
### [F-N2] Minor — Dual export+import in crypto-client.ts lacks comment — Skipped (style-only, valid pattern)
### [F-N3] Minor — `auth-or-token.ts` threshold without coverage.include — Resolved (Round 3)

## Security Findings

### [S1] Major — ESLint violation in test setup mock — Resolved (Round 1)
### [S2] Minor — Import statement in middle of file (crypto-recovery.ts) — Resolved (Round 1)
### [S2b] Minor — Import placement in vault-context.tsx — Resolved (Round 1)
### [S2c] Minor — Duplicate import in crypto-team.ts — Resolved (Round 2)
### [S3] Minor — `hexDecode` odd-length validation — Merged with F2
### [S4] Minor — Regression test `allLogArgs` missing `mockChild` — Resolved (Round 1)
### [S-N1] Minor — `hexDecode` accepts non-hex characters silently — Resolved (Round 3)

## Testing Findings

### [T1] Minor — `hexDecode` odd-length test case missing — Merged with F2
### [T2] Minor — Coverage config gap — Merged with F4
### [T3] Minor — `not.toContain("headers")` assertion too broad — Resolved (Round 1)
### [T-N1] Minor — `auth-or-token.ts` threshold without coverage.include — Merged with F-N3

## Resolution Status

### [S1] Major — ESLint violation in setup.ts
- Action: Changed type constraint from `Function` to `(...args: any[]) => unknown`
- Modified file: `src/__tests__/setup.ts:8`

### [F1] Minor — "use client" on crypto-utils.ts
- Action: Removed directive, updated comment
- Modified file: `src/lib/crypto-utils.ts:1`

### [F2/S3/T1] Minor — hexDecode odd-length validation
- Action: Added length check + throw; added test case
- Modified files: `src/lib/crypto-utils.ts:28`, `src/lib/crypto-utils.test.ts:83`

### [F3] Minor — ZodError cast
- Action: Removed cast and import
- Modified file: `src/lib/parse-body.ts:2,46`

### [F4/T2] Minor — Coverage config gap
- Action: Added parse-body.ts and with-request-log.ts to coverage.include
- Modified file: `vitest.config.ts:30-31`

### [S2] Minor — Import placement in crypto-recovery.ts
- Action: Moved import to top of file
- Modified file: `src/lib/crypto-recovery.ts:16-17`

### [S4] Minor — Regression test spy coverage
- Action: Added mockChild to allLogArgs
- Modified file: `src/__tests__/with-request-log.test.ts:352`

### [T3] Minor — Broad header assertion
- Action: Changed to direct key check
- Modified file: `src/__tests__/with-request-log.test.ts:329`

### [S2b] Minor — Import placement in vault-context.tsx
- Action: Moved import from line 108 to top import block (line 40)
- Modified file: `src/lib/vault-context.tsx:40,108`

### [S2c] Minor — Duplicate import in crypto-team.ts
- Action: Removed duplicate `import { toArrayBuffer, textEncode }` at line 55-56
- Modified file: `src/lib/crypto-team.ts:54-56`

### [F5] Minor — Inline hexDecode copy in share-e2e-entry-view.tsx
- Action: Replaced inline function with `import { hexDecode } from "@/lib/crypto-utils"`
- Modified file: `src/components/share/share-e2e-entry-view.tsx:9,20-26`

### [F-N1] Minor — Inline toAB duplicates toArrayBuffer
- Action: Replaced inline `toAB` with `toArrayBuffer` import from crypto-utils
- Modified file: `src/components/share/share-e2e-entry-view.tsx:9,48-49`

### [F-N3/T-N1] Minor — auth-or-token.ts threshold without coverage.include
- Action: Added `src/lib/auth-or-token.ts` to `coverage.include`
- Modified file: `vitest.config.ts:32`

### [S-N1] Minor — hexDecode non-hex character validation
- Action: Added regex validation `!/^[0-9a-fA-F]*$/.test(hex)` with test case
- Modified files: `src/lib/crypto-utils.ts:30`, `src/lib/crypto-utils.test.ts:88-91`

### [F-N2] Minor — Dual export+import comment (Skipped)
- Reason: Valid TypeScript pattern; adding a comment is marginal value

## Round 4 Findings (parseBody batch)

### [S-R4-1] Major — Schema detail leakage in security-sensitive endpoints
- Action: Reverted vault/admin-reset and auth/passkey/options/email to inline parsing
- Modified files: `src/app/api/vault/admin-reset/route.ts`, `src/app/api/auth/passkey/options/email/route.ts`

### [S-R4-2] Minor — parseBody before rate limit in watchtower/alert
- Action: Documented ordering rationale (rate limit key depends on teamId from body)
- Modified file: `src/app/api/watchtower/alert/route.ts`

### [T-R4-1] Major — Missing error code assertions in Type B route tests
- Action: Added VALIDATION_ERROR assertions to watchtower/alert, audit-logs/import tests
- Modified files: `src/app/api/watchtower/alert/route.test.ts`, `src/app/api/audit-logs/import/route.test.ts`

### [T-R4-2] Minor — Missing error code assertions in emergency-access tests
- Action: Added VALIDATION_ERROR assertions to reject and route tests
- Modified files: `src/app/api/emergency-access/reject/route.test.ts`, `src/app/api/emergency-access/route.test.ts`
