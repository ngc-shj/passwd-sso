# Code Review: extension-passkey-provider
Date: 2026-04-05T00:40:00+09:00
Review round: 7

## Changes from Previous Round (Round 6 → Round 7)
All Round 6 Major/Minor findings were addressed. Round 7 is a verification + follow-up pass.

Fixes applied in Round 7:
- S-7: Removed unreachable `params.senderUrl ?` ternary in `handlePasskeyCreateCredential` (non-null assertion after isSenderAuthorizedForRpId guard)
- F-5: Restored explanatory comment for intentional "sign succeeds even if counter-update PUT fails" design
- T-gap: Added "still returns ok:true with signature when counter-update PUT fails" test; asserts `invalidateCache` NOT called on PUT failure

## Functionality Findings

### [F-1] Major: Sign assertion cache invalidation missing — FIXED (Round 6)
- `deps.invalidateCache()` now called after successful PUT in `doSignAssertion`

### [F-2] Major: `replaceEntryId` delete guard missing userName check — FIXED (Round 6)
- `targetBlob?.username === userName` added to deletion guard

### [F-3] Minor: `excludeCredentialIds` silently ignored — DEFERRED
- Non-trivial spec compliance feature, deferred by user decision.

### [F-4] Minor: WebAuthn type constants duplicated — FIXED (Round 6)
- Moved to `constants.ts`, imported in `passkey-provider.ts`.

### [F-5] Major: Sign assertion PUT failure behavior — ADDRESSED (Round 7)
- Design is intentional: `ok: true` returned even on counter-update PUT failure.
  The RP validates the counter value in `authenticatorData` independently;
  blocking sign-in on a transient server error would be worse UX.
- Explanatory comment restored in `passkey-provider.ts`.
- PUT failure test added to verify: `ok: true`, `invalidateCache` not called.

## Security Findings

### [S-1] Major: `PASSKEY_GET_MATCHES` had no sender-rpId authorization — FIXED (Round 6)
### [S-2] Major: `PASSKEY_CHECK_DUPLICATE` had no sender-rpId authorization — FIXED (Round 6)
### [S-3] Minor: `validateClientDataJSON` did not verify `origin` — FIXED (Round 6)
### [S-4] Minor: `aadVersion=0` server downgrade not explicitly rejected — FIXED (Round 6)
### [S-5] Minor (residual): postMessage origin design acceptable — No fix required
### [S-6] Safe: `p1363ToDer` 1-byte DER length safe for P-256 — No issue

### [S-7] Minor: Unreachable null branch in `handlePasskeyCreateCredential` — FIXED (Round 7)
- `params.senderUrl ? new URL(params.senderUrl).origin : undefined` simplified to
  `new URL(params.senderUrl!).origin` (senderUrl guaranteed truthy by `isSenderAuthorizedForRpId` guard above).

## Testing Findings

### [T-1] Major: `aadVersion:0` / no-AAD decrypt path untested — FIXED (Round 6)
### [T-2] Major: Counter increment value not verified in PUT body — FIXED (Round 6)
### [T-3] Minor: Spurious `type` field in mock responses — FIXED (Round 6)
### [T-4] Major: SW sleep 2000ms timeout fallback untested — FIXED (Round 6)
### [T-5] Minor: Vacuous `not.toBe("CREDENTIAL_EXCLUDED")` assertion — FIXED (Round 6)
### [R2] Minor: EXT_MSG string values hardcoded in bridge test — FIXED (Round 6)

### [T-6] Major: Counter-update PUT failure path untested — FIXED (Round 7)
- Added test: "still returns ok:true with signature when counter-update PUT fails (non-fatal)"
- Asserts `result.ok === true`, `result.response` defined, `invalidateCache` not called.

## Adjacent Findings
- [Adjacent] R1: `base64urlEncode`/`Decode` duplicated in `webauthn-crypto.ts` and `webauthn-interceptor.js`. Architecturally unavoidable (MAIN world cannot import TS modules).

## Resolution Status
All Critical and Major findings resolved. F-3 deferred by user decision.
Round 7: No findings from expert agents (all previous fixes verified correct).
