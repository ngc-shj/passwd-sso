# Code Review: extension-passkey-provider
Date: 2026-04-05T00:00:00+09:00
Review round: 6 (post-merge, new multi-agent round)

## Changes from Previous Round
Round 5 (pre-merge) returned "No findings". This round reviews the merged code (#323)
with three new findings from a manual v9 diff review, plus a fresh multi-agent pass.

## Functionality Findings

### [F-1] Major: Sign assertion mutates server state but never invalidates local cache
- File: `passkey-provider.ts:253-267`
- Evidence: After the PUT that persists the updated `passkeySignCount`, there is no `deps.invalidateCache()` call. In contrast, `handlePasskeyCreateCredential` calls `deps.invalidateCache()` at line 425. All other mutation handlers (`login-save.ts:173, 243`) call `invalidateCache`.
- Problem: Cache content becomes stale after sign assertion. The overview does not include `passkeySignCount`, so display data is not immediately stale, but a future code path reading `passkeySignCount` from cached data would get a stale value. Breaks cache contract established by every other mutating operation.
- Impact: Inconsistency; low for sign count specifically but breaks pattern contract.
- Fix: Call `deps.invalidateCache()` after successful sign assertion PUT.

### [F-2] Major: `replaceEntryId` delete does not verify `userName` match
- File: `passkey-provider.ts:413-416`
- Evidence: Guard condition is `targetBlob?.entryType === PASSKEY && targetBlob?.relyingPartyId === rpId`. Does not check `targetBlob?.username === params.userName`.
- Problem: A user with two passkeys for the same RP but different usernames could have the wrong credential deleted if `replaceEntryId` points to a different-username entry. The content script (untrusted) supplies `replaceEntryId`.
- Impact: Wrong passkey entry deleted, data loss without recovery.
- Fix: Add `targetBlob?.username === params.userName` to the deletion guard.

### [F-3] Minor: `excludeCredentialIds` accepted in `CreateCredentialParams` but silently ignored
- File: `passkey-provider.ts:298, 319-322`
- Evidence: `excludeCredentialIds` is declared and passed through the pipeline but never referenced in `handlePasskeyCreateCredential`.
- Problem: WebAuthn spec requires authenticator to reject requests if existing credential matches `excludeCredentials`. Extension creates duplicate entries ignoring this.
- Impact: Non-compliant with spec; can create duplicate passkey entries.
- Fix: Before generating keypair, check if `excludeCredentialIds` intersects vault entries and return `CREDENTIAL_EXCLUDED` error.
- Status: **Deferred** — non-trivial feature addition, consulted user.

### [F-4] Minor: WebAuthn type constants duplicated outside shared module
- File: `passkey-provider.ts:40-41`, `webauthn-interceptor.js:121,206`
- Evidence: `WEBAUTHN_TYPE_GET = "webauthn.get"` and `WEBAUTHN_TYPE_CREATE = "webauthn.create"` not in `constants.ts`.
- Problem: Future refactor risk — no single source of truth.
- Fix: Add to `constants.ts`, import in `passkey-provider.ts`. Document in interceptor comment.

## Security Findings

### [S-1] Major: `PASSKEY_GET_MATCHES` has no sender-rpId authorization
- File: `passkey-provider.ts:88-123`, `index.ts:2346-2350`
- Evidence: `handlePasskeyGetMatches(rpId)` receives `rpId` from message payload but SW handler does not pass `_sender.tab?.url`. No `isSenderAuthorizedForRpId()` call in this function. In contrast, sign/create both validate sender.
- Problem: Any content script can send `PASSKEY_GET_MATCHES` with arbitrary `rpId` (e.g., `"google.com"`) from any page. SW returns `PasskeyMatchEntry` list including `credentialId`, `username`, `relyingPartyId` for that rpId regardless of sender hostname.
- Impact: Cross-origin credential enumeration. Attacker page learns which accounts user has passkeys for at any domain.
- Fix: Pass `_sender.tab?.url` to `handlePasskeyGetMatches` and call `isSenderAuthorizedForRpId` as first check.

### [S-2] Major: `PASSKEY_CHECK_DUPLICATE` has no sender-rpId authorization
- File: `passkey-provider.ts:127-157`, `index.ts:2352-2355`
- Evidence: `handlePasskeyCheckDuplicate(rpId, userName)` has no `isSenderAuthorizedForRpId` call. SW handler does not pass `_sender.tab?.url`.
- Problem: Targeted credential existence oracle. Attacker can confirm whether user has passkey for specific account at target domain.
- Impact: Credential enumeration, privacy violation.
- Fix: Same as S-1 — thread `_sender.tab?.url` and call `isSenderAuthorizedForRpId`.

### [S-3] Minor: `validateClientDataJSON` does not verify `origin` field
- File: `passkey-provider.ts:43-55`
- Evidence: Only checks `type` and `challenge`. Does not verify `parsed.origin` against sender origin.
- Problem: Compromised page can craft `clientDataJSON` with `origin: "legitimate-site.com"` while at `attacker.com`. `isSenderAuthorizedForRpId` still gates sign/create, so not a full bypass, but signed assertion carries misleading origin.
- Impact: Minor — rpId auth check still gates operation. Signed `clientDataJSON` may have mismatched origin.
- Fix: Optionally verify `parsed.origin === new URL(senderUrl).origin` in `validateClientDataJSON`.

### [S-4] Minor: `aadVersion=0` server downgrade forces GCM auth failure on PASSKEY entries
- File: `passkey-provider.ts:219-222`
- Evidence: `(data.aadVersion ?? 0) >= 1` check is reachable by server response with `aadVersion:0`. AES-GCM tag mismatch causes decryption failure.
- Problem: Malicious server can block passkey use by returning `aadVersion:0`. Not exploitable for data read.
- Impact: Minor DoS. No plaintext exposure.
- Fix: Assert `data.aadVersion >= 1` for PASSKEY entries; return `INVALID_ENTRY` if not.

### [S-5] Minor (residual): postMessage origin design acceptable
- Assessment: ISOLATED world `event.origin` check correct. Assertion payload is same as what WebAuthn API would return to page anyway. UUID randomness (122 bits) sufficient.
- Fix: No fix required.

### [S-6] Safe: `p1363ToDer` 1-byte DER length confirmed safe for P-256
- Assessment: Max SEQUENCE length for P-256 is 70 bytes (≤ 127). `sig.length !== 64` guard locks to P-256. No issue.

## Testing Findings

### [T-1] Major: `aadVersion:0` / no-AAD decrypt path untested
- File: `background-passkey-provider.test.ts` (no such test)
- Evidence: All mocks use `aadVersion:1`. Production code has backward compat at lines 220-222 and 407.
- Problem: Backward compat path where blob encrypted without AAD is untested.
- Impact: Regression gap for legacy entries.
- Fix: Add test with blob encrypted via `encryptData(blob, testKey, undefined)` and mock omitting `aadVersion`.

### [T-2] Major: Counter increment value not verified in PUT body
- File: `background-passkey-provider.test.ts:379-382`
- Evidence: `expect(putCalls).toHaveLength(1)` — only call count checked, body not inspected.
- Problem: Regression that re-persists count=0 instead of count=1 would pass test.
- Impact: Counter is security-critical (replay prevention).
- Fix: Parse PUT body, decrypt `encryptedBlob` with `testKey`+AAD, assert `passkeySignCount === 1`.

### [T-3] Minor: Spurious `type` field in `PASSKEY_CHECK_DUPLICATE` mock responses
- File: `webauthn-bridge-lib.test.ts:258, 314, 353`
- Evidence: `cb({ type: "PASSKEY_CHECK_DUPLICATE", entries: [], ... })` — production response has no `type` field.
- Fix: Remove `type` field from mock cb calls.

### [T-4] Major: SW sleep / 2000ms timeout fallback path untested
- File: `webauthn-bridge-lib.test.ts` (no such test)
- Evidence: `webauthn-bridge-lib.ts:139` sets `setTimeout(fallthrough, 2000)`. No fake timers test exists.
- Problem: Fallback for MV3 SW termination entirely untested.
- Fix: Add test with `vi.useFakeTimers()`, advance 2000ms without sendMessage callback firing.

### [T-5] Minor: Vacuous assertion `not.toBe("CREDENTIAL_EXCLUDED")`
- File: `background-passkey-provider.test.ts:632`
- Evidence: Error code `CREDENTIAL_EXCLUDED` is never emitted by production code.
- Fix: Replace with `expect(result.ok).toBe(true)`.

### [R2] Minor: `EXT_MSG` string values hardcoded in bridge test assertions
- File: `webauthn-bridge-lib.test.ts:135, 210, 243`
- Evidence: `"PASSKEY_GET_MATCHES"`, `"PASSKEY_SIGN_ASSERTION"`, `"PASSKEY_CREATE_CREDENTIAL"` hardcoded.
- Fix: Import `EXT_MSG` and use `EXT_MSG.PASSKEY_GET_MATCHES` etc.

## Adjacent Findings
- [Adjacent] R1: `base64urlEncode`/`Decode` duplicated in `webauthn-crypto.ts` and `webauthn-interceptor.js`. Architecturally unavoidable (MAIN world cannot import TS modules).

## Quality Warnings
No findings triggered quality-gate warnings.

## Resolution Status
(to be filled after fixes)
