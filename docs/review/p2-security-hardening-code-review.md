# Code Review: p2-security-hardening
Date: 2026-03-08
Review rounds: 3

## Round 1 — Initial Review

### Changes from Previous Round
Initial review

### Functionality Findings
- **F1 (Major)**: `scrubSentryEvent` doesn't handle `request.data` as string — Sentry can serialize request body as JSON string
- **F2 (Major)**: `encryptionMode` in attachment upload lacks 0|1 validation — arbitrary integers stored in DB
- (Minor): `scrubSentryEvent` mutates input — acceptable for Sentry `beforeSend` pattern
- (Minor): `aadVersion` NaN check missing — low risk, falls back to default

### Security Findings
- **F3 (Major)**: `updateTeamE2EPasswordSchema` missing `itemKeyVersion`/`encryptedItemKey` consistency refine
- **F4 (Major)**: Argon2id `deriveWrappingKeyArgon2id` has no minimum parameter checks
- **F5 (Major)**: Sentry `exception.values` stacktrace not scrubbed
- S1 (Minor): crypto-domain-ledger OV scope fields missing `itemKeyVersion`
- S2 (Minor): CSP `connect-src` missing Sentry domain — Sentry SDK handles this
- S3 (Minor): `block-all-mixed-content` deprecated — pre-existing
- S7 (Minor): rotation schema `z.union` vs `z.discriminatedUnion` — working as-is

### Testing Findings
- (Major): Argon2id parameter boundary tests missing — duplicate of F4
- (Minor): Deep nest test incomplete
- S5 (Minor): IK/OV cross-scope collision test missing
- S6 (Minor): Argon2id unlock test missing
- (Minor): `request.headers` scrub missing — low risk

## Round 1 → Round 2 Fixes

Commit `c30fd17`: `review(1): fix round 1 code review findings`
- F1: Handle `request.data` as JSON string (parse → scrub → stringify, fallback to redact)
- F2: Validate `encryptionMode` is 0 or 1 with 400 response
- F3: Added `.refine()` for `itemKeyVersion`/`encryptedItemKey` consistency
- F4: Added Argon2id min checks (memory ≥ 16384, parallelism ≥ 1, iterations ≥ 1)
- F5: Added `exception.values` stacktrace scrubbing
- S1: Fixed OV scope fields in crypto-domain-ledger
- S5: Added IK vs OV cross-scope collision test
- S6: Added 3 Argon2id parameter boundary tests

## Round 2 — Incremental Review

### Changes from Previous Round
All 5 Major + 3 Minor findings from Round 1 resolved

### Functionality Findings
No findings — all Round 1 fixes verified correct

### Security Findings
- R2-F1 (Minor/New): `exception.values[].value` field itself not scrubbed — low risk, no sensitive data in error messages confirmed
- S2, S3, S7 (Minor/Continuing): unchanged

### Testing Findings
- Finding 2 (Major/New): `updateTeamE2EPasswordSchema` refine has no unit tests
- Finding 3 (Major/New): `encryptionMode` validation has no test
- Finding 1 (Minor/New): exception `Array.isArray` branch unreachable — defensive code, no test needed
- Finding 4 (Minor/Continuing): `aadVersion` parseInt NaN — Minor

## Round 2 → Round 3 Fixes

Commit `a7cc910`: `review(2): add missing tests for round 1 fixes`
- Added 6 tests for `updateTeamE2EPasswordSchema` itemKeyVersion/encryptedItemKey refine
- Added 1 test for encryptionMode invalid value rejection

## Round 3 — Final Review

### Changes from Previous Round
2 Major test findings from Round 2 resolved (test-only changes)

### Functionality Findings
No findings

### Security Findings
No findings

### Testing Findings
No findings

## Resolution Status

### F1 (Major) scrubSentryEvent request.data string handling
- Action: Added string type handling with JSON.parse fallback
- Modified file: src/lib/sentry-scrub.ts:89-99

### F2 (Major) encryptionMode validation
- Action: Added 0|1 check with 400 response
- Modified file: src/app/api/teams/[teamId]/passwords/[id]/attachments/route.ts:213-219

### F3 (Major) updateTeamE2EPasswordSchema refine
- Action: Added .refine() for itemKeyVersion/encryptedItemKey consistency
- Modified file: src/lib/validations.ts:196-202

### F4 (Major) Argon2id parameter minimums
- Action: Added memory/parallelism/iterations minimum checks
- Modified file: src/lib/crypto-client.ts:189-191

### F5 (Major) exception.values scrubbing
- Action: Added exception.values stacktrace scrubbing
- Modified file: src/lib/sentry-scrub.ts:102-124

### S1 (Minor) Ledger OV fields
- Action: Added itemKeyVersion to OV scope fields
- Modified file: docs/security/crypto-domain-ledger.md:32

### S5 (Minor) IK/OV cross-scope test
- Action: Added collision resistance test
- Modified file: src/lib/crypto-aad.test.ts:222-231

### S6 (Minor) Argon2id boundary tests
- Action: Added 3 parameter boundary tests
- Modified file: src/lib/crypto-client.test.ts:212-234

### Round 2 test coverage additions
- Action: Added 6 refine validation tests + 1 encryptionMode test
- Modified files: src/lib/validations.test.ts:355-419, src/__tests__/api/teams/team-attachments.test.ts:353-364

### Unresolved Minor findings (accepted)
- R2-F1: exception.values[].value scrubbing — low risk, no sensitive data in error messages
- S2: CSP connect-src Sentry — SDK handles automatically
- S3: block-all-mixed-content deprecated — pre-existing, not in PR scope
- S7: union vs discriminatedUnion — working correctly
- Finding 4: aadVersion parseInt NaN — low risk
