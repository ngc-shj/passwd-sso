# Plan Review: error-tracking-kms-integration
Date: 2026-03-18
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major] verifier-pepper missing from Step 11 migration list
- **Problem:** `getVerifierPepper()` in `crypto-server.ts` is not listed in Step 11's migration targets, making the `verifier-pepper` KeyName a dead entry
- **Impact:** KMS provider won't work for verifier pepper — it will still read directly from `process.env`
- **Recommended action:** Add `getVerifierPepper()` → `getKeyProviderSync().getKeySync("verifier-pepper")` to Step 11
- **Resolution:** Fixed in plan — was already intended but omitted from the list

### F2 [Major] Edge Runtime guard missing in instrumentation.ts
- **Problem:** `register()` runs in both Edge and Node.js runtimes. AWS KMS SDK and `node:crypto` are unavailable in Edge Runtime
- **Impact:** Startup crash on Edge Runtime when `KEY_PROVIDER=aws-kms`
- **Recommended action:** Add `if (process.env.NEXT_RUNTIME === 'nodejs')` guard in Step 10
- **Resolution:** Fixed in plan

### F3 [Major] CONFLICT/SERVICE_UNAVAILABLE already exist in api-error-codes.ts
- **Problem:** Plan says "add if missing" but both codes already exist
- **Impact:** Ambiguous instruction could lead to duplicate or incorrect changes
- **Recommended action:** Clarify that no additions needed; just use existing codes in `mapPrismaError()` with `ApiErrorCode` type
- **Resolution:** Fixed in plan

### F4 [Minor] global-error.tsx placement
- **Problem:** Plan places it at `src/app/[locale]/global-error.tsx` but Next.js requires `src/app/global-error.tsx` (root app directory)
- **Impact:** Root layout errors won't be caught
- **Recommended action:** Move to `src/app/global-error.tsx`
- **Resolution:** Fixed in plan

## Security Findings

### S1 [Major] KMS fallback allows indefinite operation with stale keys
- **Problem:** If KMS refresh fails, cached key is used forever with only a log warning
- **Impact:** Key revocation/rotation on KMS side becomes ineffective
- **Recommended action:** Add max fallback duration (e.g., 2× TTL). After expiry, `getKeySync()` throws and requests get 503
- **Resolution:** Fixed in plan — added `maxStaleTtlMs` (default 2× TTL)

### S2 [Major] captureException may leak key material via Error.message
- **Problem:** `scrubSentryEvent` is key-name based; `Error.message` strings containing hex keys pass through
- **Impact:** Key material could be sent to Sentry infrastructure
- **Recommended action:** Add error sanitizer wrapper before `captureException` that scrubs hex64 patterns from `error.message` and `error.cause`
- **Resolution:** Fixed in plan — added `sanitizeErrorForSentry()` wrapper

### S3 [Minor] KMS env var naming reveals key purpose
- **Problem:** `KMS_ENCRYPTED_KEY_{NAME}` names expose key topology
- **Impact:** Low — requires prior SSRF/RCE access
- **Recommended action:** Consider opaque names. Skipped — clarity for operators outweighs marginal attacker advantage
- **Resolution:** Accepted as-is with documented rationale

### S4 [Minor] global-error.tsx captureException beforeSend coverage
- **Problem:** Unclear if `beforeSend` hook applies to direct `captureException` calls
- **Impact:** Low — `@sentry/nextjs` applies `beforeSend` to all events including `captureException`
- **Recommended action:** Add integration test to verify. Covered by T1 (global-error test)
- **Resolution:** Covered by T1 test addition

## Testing Findings

### T1 [Critical] No test for global-error.tsx
- **Problem:** `global-error.tsx` with `Sentry.captureException` in `useEffect` has no test
- **Impact:** Silent regression if Sentry call is removed
- **Recommended action:** Add `global-error.test.tsx` with React Testing Library
- **Resolution:** Fixed in plan — test added to Step 1

### T2 [Major] AwsKmsKeyProvider TTL cache tests not specified
- **Problem:** Cache hit/miss/expiry paths not explicitly tested
- **Impact:** Cache could silently stop working
- **Recommended action:** Add 3 TTL test cases with `vi.setSystemTime`
- **Resolution:** Fixed in plan — added to Step 7

### T3 [Major] Prisma error mapping needs parameterized tests
- **Problem:** Test plan doesn't specify coverage of all error code mappings
- **Impact:** Important error codes could map incorrectly
- **Recommended action:** Use `it.each` for P2002, P2003, P2025, PrismaClientInitializationError, unknown
- **Resolution:** Fixed in plan — added to Step 3

### T4 [Major] instrumentation.test.ts isolation pattern unspecified
- **Problem:** `validateKeys()` test needs module isolation to avoid env.test.ts interference
- **Impact:** Flaky tests from module-level side effects
- **Recommended action:** Separate `instrumentation.test.ts` with `vi.mock` + dynamic import
- **Resolution:** Fixed in plan — added to Step 10

### T5 [Major] withRequestLog fire-and-forget async assertion pattern
- **Problem:** `captureException` via dynamic import may not resolve before assertion
- **Impact:** False-positive test (always passes)
- **Recommended action:** Use `vi.mock("@sentry/nextjs")` for hoisted sync mock
- **Resolution:** Fixed in plan — specified mock pattern in Step 2

### T6 [Minor] coverage.include missing new modules
- **Problem:** key-provider/*, prisma-error.ts not in coverage.include
- **Impact:** Coverage threshold won't catch low coverage
- **Recommended action:** Add to vitest.config.ts
- **Resolution:** Fixed in plan — added to implementation steps

## Adjacent Findings
None — all findings were within expert scope.
