# Code Review: webauthn-l3-minpin-largeblob (Final)
Date: 2026-03-16
Review rounds: 2

## Round 1 Findings

### Functionality
- F1 (Minor) RESOLVED: largeBlob badge displayed with line-through for null (unknown) — hid when null
- F2 (Minor) RESOLVED: fetchPolicy silently swallowed errors — added catch + toast

### Security
- S1 (Minor) RESOLVED: transports stored without allowlist — added VALID_TRANSPORTS filter

### Testing
- T1 (Major) RESOLVED: minPinLength boundary test used 2 instead of 3/4
- T2 (Major) SKIPPED: parseBody mock bypasses schema — documented limitation
- T3 (Major) RESOLVED: mockWithBypassRls lost after clearAllMocks — moved to beforeEach
- T4 (Major) RESOLVED: self-lockout tests missing — added 409/confirmLockout tests
- T5 (Minor) RESOLVED: credentialId length boundary — added 256/257 tests

## Round 2 — No new findings

## Resolution Status
All Critical/Major findings resolved. Total tests: 4806 (all pass).
