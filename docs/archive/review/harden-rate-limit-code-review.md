# Code Review: harden-rate-limit
Date: 2026-03-26T01:20:00+09:00
Review rounds: 2

## Round 1

### Functionality Findings
- F1 (Minor): Import interleaving in 3 files → Fixed
- F2 (Minor): userId variable inconsistency in admin-reset → Skipped (pre-existing)
- F3 (Minor): Body parse before rate limit in recover route → No action (design constraint)
- F4 (Minor): Admin scripts error format change → No action (improvement)
- F5 (Minor): Semantic mismatch rateLimited() for pending resets → No action (pre-existing)

### Security Findings
- SEC-1 (Minor): CSP XFF spoofing rate-limit bypass → No action (pre-existing, not introduced by this PR)
- SEC-2 (Minor): Semantic mismatch rateLimited() for pending resets → No action (pre-existing)
- SEC-3 (Adjacent/Minor): Import ordering → Fixed

### Testing Findings
- F1 (Major): No 429 test cases for 8 new endpoints → Fixed (429 + Retry-After tests added)
- F2 (Major): 3 __tests__/api/ files missing rate-limit mock → Fixed
- F3 (Major): No Retry-After assertions in existing 429 tests → Fixed (4 files updated)
- F4 (Major): Recovery key limiter independence untested → Fixed (3 test cases added)
- F5 (Major): instrumentation.ts no test → Deferred (low priority)
- F6 (Minor): Eviction test → Deferred
- F7 (Minor): Coverage thresholds → Deferred
- F8 (Minor): Negative retryAfterMs boundary → Deferred
- F9 (Adjacent/Minor): mockReturnValueOnce fragility → No action

## Round 2

### Functionality Findings
No findings.

### Security Findings
No findings.

### Testing Findings
- T-R2-1 (Minor): Recovery key independence test missing mockResetCheck deny state → Fixed

## Resolution Status

### Round 1 Fixes
- Import interleaving (3 files): Reordered imports in api-keys, scim-tokens, team-rotate-key routes
- 429 tests (8 files): Added 429 + Retry-After test cases for all new rate-limited endpoints
- __tests__/api/ mocks (3 files): Added rate-limit mocks to scim-tokens, attachments, team-attachments
- Retry-After assertions (4 files): Updated vault/unlock, verify-access, recover, webauthn/register tests
- Recovery key tests (1 file): Added 3 independence tests (block reset, verify independence, clear on success)

### Round 2 Fixes
- Recovery key independence test: Added mockResetCheck deny state to properly test limiter isolation

### Deferred Items
- instrumentation.ts unit test (plan 8b)
- rate-limit-eviction.test.ts (plan 8d)
- vitest coverage thresholds for rate-limit.ts (plan 8e)
