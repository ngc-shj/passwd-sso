# Code Review: error-tracking-kms-integration
Date: 2026-03-18
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Critical] env var name mismatch between validateKeys and env.ts
- validateKeys used `KMS_ENCRYPTED_KEY_SHARE_MASTER_V1` but env.ts validated `KMS_ENCRYPTED_KEY_SHARE_MASTER`
- **Resolution:** Fixed — validateKeys now uses unversioned key name

### F2 [Major] kmsModulePromise null reset causes thundering herd
- **Resolution:** Fixed — rejected promise is now cached (no reset)

### F3 [Major] NaN version from invalid SHARE_MASTER_KEY_CURRENT_VERSION
- **Resolution:** Fixed — added isFinite + min(1) validation in validateKeys

### F4 [Major] Object.defineProperty for Prisma meta was unnecessary
- **Resolution:** Fixed — removed entire meta block (new Error() already excludes it)

### F5 [Major] KMSClient instantiated per decryptDataKey call
- **Resolution:** Fixed — client cached as instance property, reused across calls

### F6 [Minor] SENTRY_DSN vs NEXT_PUBLIC_SENTRY_DSN documentation
- **Resolution:** Accepted — correct behavior (server vs client), documented in ops guide

### F7 [Minor] EnvKeyProvider.validateKeys only checks share-master
- **Resolution:** Accepted — other keys validated at call time with clear error messages

## Security Findings

### S1 [Minor] Stack trace not scrubbed by sanitizeErrorForSentry
- **Resolution:** Fixed — stack trace now passed through scrubSensitivePatterns

### S2 [Minor] onRequestError not sanitized
- **Resolution:** Fixed — sanitizeErrorForSentry applied before captureRequestError

### S3 [Minor] global-error.tsx captureException not sanitized
- **Resolution:** Fixed — sanitizeErrorForSentry applied before captureException

### S4 [Minor] Stale cache fallback log missing
- **Resolution:** Fixed — console.warn added with elapsed time and error details

## Testing Findings

### T1 [Minor] setTimeout-based negative assertion
- **Resolution:** Accepted — pragmatic for fire-and-forget pattern

### T2 [Major] Missing Plaintext-absent test
- **Resolution:** Fixed — added test for KMS returning no Plaintext

### T3 [Major] directory-sync key type not tested
- **Resolution:** Fixed — added test and extended validateKeys test to 4 key types

### T4-T7 [Minor] Various test improvements
- **Resolution:** Fixed where straightforward (base64 test, stack trace test, coverage include)

## Resolution Status

All Critical and Major findings resolved. Minor findings either fixed or accepted with rationale.
