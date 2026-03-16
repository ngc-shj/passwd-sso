# Code Review: add-webauthn-credprops
Date: 2026-03-16
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings
No findings.

## Security Findings

### S1 (Minor) — RESOLVED
- **File:** src/app/api/webauthn/register/verify/route.ts:127
- **Problem:** Comment should explicitly state credProps.rk is client-supplied and not authenticator-signed
- **Fix:** Updated comment to include security guidance

## Testing Findings

### T1 (Major) — RESOLVED
- **File:** src/app/api/webauthn/register/verify/route.test.ts
- **Problem:** Response body assertions on `json.discoverable` tested the mock's return value, not extraction logic
- **Fix:** Removed misleading response assertions; kept Prisma call argument assertions as primary validation

### T3 (Minor) — RESOLVED
- **File:** src/app/api/webauthn/register/verify/route.test.ts
- **Problem:** Audit metadata only tested for `discoverable: true`, not null fallback
- **Fix:** Added test for `discoverable: null` in audit metadata

### T4 (Minor) — RESOLVED
- **File:** src/app/api/webauthn/register/verify/route.test.ts
- **Problem:** Redis unavailable (503) path not covered
- **Fix:** Added test case with `getRedis` returning null

## Adjacent Findings
None.

## Resolution Status

### S1 Minor — Comment clarity
- Action: Updated comment to warn against auth/authz usage
- Modified file: src/app/api/webauthn/register/verify/route.ts:127

### T1 Major — Misleading test assertions
- Action: Removed response body discoverable assertions, kept Prisma call assertions
- Modified file: src/app/api/webauthn/register/verify/route.test.ts

### T3 Minor — Missing audit null test
- Action: Added audit metadata test for null case
- Modified file: src/app/api/webauthn/register/verify/route.test.ts

### T4 Minor — Missing 503 test
- Action: Added Redis null test with mockGetRedis
- Modified file: src/app/api/webauthn/register/verify/route.test.ts
