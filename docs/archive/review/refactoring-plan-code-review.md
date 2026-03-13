# Code Review: refactoring-plan
Date: 2026-03-14T01:48:00+09:00
Review round: 2

## Changes from Previous Round
Round 2: Fixed duplicate import in crypto-team.ts (S2c), replaced inline hexDecode in share-e2e-entry-view.tsx with import from crypto-utils (F5)

## Functionality Findings

### [F1] Minor — `"use client"` directive on crypto-utils.ts
- **File:** `src/lib/crypto-utils.ts:1`
- **Problem:** Module is imported by server-side code (crypto-emergency.ts, crypto-recovery.ts) but had `"use client"` directive
- **Impact:** Semantic mismatch; future Next.js versions may enforce this boundary
- **Resolution:** Removed `"use client"` directive

### [F2] Minor — `hexDecode` silently truncates odd-length input
- **File:** `src/lib/crypto-utils.ts:28-34`
- **Problem:** Odd-length hex strings have their last character silently dropped
- **Impact:** Silent data corruption risk for future callers
- **Resolution:** Added `hex.length % 2 !== 0` check that throws; added test case

### [F3] Minor — Unnecessary `as ZodError` cast in parse-body.ts
- **File:** `src/lib/parse-body.ts:46`
- **Problem:** Zod 4 properly types `parsed.error` — cast is redundant
- **Resolution:** Removed cast and unused `ZodError` type import

### [F4] Minor — `parse-body.ts` and `with-request-log.ts` missing from coverage.include
- **File:** `vitest.config.ts`
- **Problem:** Key shared utilities not tracked in coverage reports
- **Resolution:** Added both to `coverage.include`

## Security Findings

### [S1] Major — ESLint violation in test setup mock
- **File:** `src/__tests__/setup.ts:8`
- **Problem:** `<H extends Function>` violates `@typescript-eslint/no-unsafe-function-type`
- **Impact:** `npm run lint` would fail
- **Resolution:** Changed to `<H extends (...args: any[]) => unknown>` with eslint-disable comment

### [S2] Minor — Import statement in middle of file (crypto-recovery.ts)
- **File:** `src/lib/crypto-recovery.ts:27`
- **Problem:** `import { toArrayBuffer, textEncode }` placed after constant declarations
- **Resolution:** Moved import to top import block

### [S3] Minor — `hexDecode` odd-length validation (same as F2)
- Merged with F2

### [S4] Minor — Regression test `allLogArgs` missing `mockChild`
- **File:** `src/__tests__/with-request-log.test.ts:352`
- **Problem:** Inconsistent spy coverage vs negative tests in same describe block
- **Resolution:** Added `mockChild` to `allLogArgs` call

## Testing Findings

### [T1] Minor — `hexDecode` odd-length test case missing (same as F2)
- Merged with F2

### [T2] Minor — Coverage config gap (same as F4)
- Merged with F4

### [T3] Minor — `not.toContain("headers")` assertion too broad
- **File:** `src/__tests__/with-request-log.test.ts:329`
- **Problem:** String match on serialized JSON is fragile
- **Resolution:** Changed to direct key check on `mockChild.mock.calls[0][0]`

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
- Modified file: `vitest.config.ts:31-32`

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
