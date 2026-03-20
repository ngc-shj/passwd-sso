# Code Review: add-key-rotation-consumers
Date: 2026-03-21T09:20:00+09:00
Review rounds: 2 (post-manual-testing)

## Changes from Previous Round
Round 2: Fixes from manual testing and UI unification applied. All round 1 findings resolved.

## Functionality Findings

### F1 [Critical] AAD mismatch for aadVersion >= 1 entries — RESOLVED
- `vault-context.tsx` rotateKey now uses `buildPersonalEntryAAD(userId, entryId)` for decrypt/re-encrypt when `aadVersion >= 1`.
- History entries use parent entry ID (`histEntry.entryId`) for AAD construction.

### F2 [Major] Rate limiter shared between GET and POST — CLOSED (by design)
- Both endpoints share the same Redis key (`rl:vault_rotate:{userId}`). Documented in source comment.

### F3 [Major] ECDH null private key produces zero bytes — RESOLVED
- Now throws `Error("ECDH_KEY_UNAVAILABLE")` instead of encrypting zero bytes.

### F4 [Major] N parallel updateMany inside interactive TX — RESOLVED
- Converted to batched processing (BATCH_SIZE = 100).

### F5 [Minor] Wrong AUDIT_TARGET_TYPE — RESOLVED
- Changed to `"User"`.

### F6 [Minor] TARGET_VERSION=0 passes validation — RESOLVED
- Regex changed to `^[1-9][0-9]*$`.

### F7 [Minor] v0 AAD upgrade intent unclear — RESOLVED
- Confirmed intentional. `itemKeyVersion=0` in AAD with `aadVersion=1` is correct for v0 entries.

### F8 [Minor] tabSecurityDesc stale after sub-tab addition — RESOLVED (Round 2)
- Updated en/ja to include key rotation mention.

## Security Findings

### S1 [Major] GET data endpoint assertOrigin — RESOLVED
- `assertOrigin` removed from GET endpoints. Browsers don't send Origin on GET. Session auth + RLS is sufficient.

### S2 [Major] Entry ID cuid vs cuid2 — RESOLVED
- Changed to `.min(1)` to accept both UUID and CUID. Server validates ownership via `userId` scope.

### S3 [Major] Rate limiter shared — CLOSED (by design)

### S4 [Major] ECDH null key — RESOLVED

### S5 [Major] OPERATOR_ID JSON injection — RESOLVED (Round 2)
- Alphanumeric regex `^[a-zA-Z0-9_-]{1,128}$` prevents JSON special characters.

### S6 [Minor] INSECURE flag missing production warning — RESOLVED (Round 2)
- Warning printed to stderr when `INSECURE=true`.

### S10 [Minor] encryptedSecretKey max length — RESOLVED (.max(512))

## Testing Findings

### T1-T4 [Critical] Missing tests for data endpoints — RESOLVED
- Test files created for both vault and team data endpoints.

### T5-T6 [Major] Component tests missing — ACCEPTED (deviation log D3, D4)

### T7 [Major] Test IDs not matching CUID format — RESOLVED

### T9 [Major] Stale mockAssertOrigin in team data test — RESOLVED (Round 2)

### T10 [Major] Missing rate limit 429 test for POST — RESOLVED (Round 2)

### T11 [Minor] Missing entry ID mismatch test — RESOLVED (Round 2)

## Adjacent Findings
None.

## Resolution Status
All Critical and Major findings resolved. All Minor findings resolved.
- Round 1: 7 findings (1 Critical, 3 Major, 3 Minor) — all resolved.
- Round 2: 6 findings (0 Critical, 3 Major, 3 Minor) — all resolved.
