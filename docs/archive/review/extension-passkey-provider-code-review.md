# Code Review: extension-passkey-provider
Date: 2026-04-04T03:30:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F-C1 [Critical]: Team passkey signing uses wrong key/AAD/API format
- File: `extension/src/background/passkey-provider.ts:105-161`
- Problem: `handlePasskeySignAssertion` always uses personal AAD/key, fails for team entries (wrong EncryptedData shape, wrong AAD, wrong encryption key)
- Fix: Add guard `if (teamId) return { ok: false, error: "TEAM_PASSKEY_NOT_SUPPORTED" }` until team path is properly implemented

### F-C2 [Critical]: Team passkey overview missing rpId/credentialId extraction
- File: `extension/src/background/index.ts:decryptTeamOverviews`
- Problem: Team overviews don't extract `relyingPartyId`/`credentialId`, so team passkeys never match
- Fix: Add extraction to `decryptTeamOverviews` (same as personal overviews)

### F-M1 [Major]: Team passkey form doesn't preserve provider fields
- File: `src/components/team/team-passkey-form.tsx`, `team-entry-form-types.ts`
- Problem: Editing a team PASSKEY entry drops all provider fields (private key destroyed)
- Fix: Add 7 provider fields to team form types and preservation logic

### F-M2 [Major]: Missing `chrome.runtime.lastError` check in bridge callbacks
- File: `extension/src/content/webauthn-bridge-lib.ts:55-153`
- Problem: Callbacks don't check `lastError`, causing Chrome warnings when SW is unavailable
- Fix: Add `if (chrome.runtime.lastError) { respond(requestId, null); return; }` in each callback

### F-m1 [Minor]: Unused import `base64urlDecode`
- File: `extension/src/background/passkey-provider.ts:28`

### F-m2 [Minor]: Unused `challenge` parameter in CREATE message
- File: `messages.ts`, `webauthn-bridge-lib.ts`, `passkey-provider.ts`

### F-m3 [Minor]: Passkey dropdown UI strings not i18n'd
- File: `extension/src/content/ui/passkey-dropdown.ts`

## Security Findings

### S-F2 [Major]: `allowCredentials` filter not honoured
- File: `extension/src/content/webauthn-interceptor.js:66-80`
- Problem: All rpId-matching passkeys shown regardless of RP's `allowCredentials` list
- Fix: Filter entries by `allowCredentials` credential IDs before showing selection UI

### S-F3 [Major]: rpId not validated against page's effective domain
- File: `extension/src/content/webauthn-interceptor.js:67`
- Problem: RP confusion attack — malicious page can set arbitrary rpId
- Fix: Validate rpId is a registrable domain suffix of `window.location.hostname`

### S-F4 [Major]: Sign counter race condition (no per-credential mutex)
- File: `extension/src/background/passkey-provider.ts:130-165`
- Problem: Concurrent sign operations can produce same counter value, triggering RP clone detection
- Fix: Add per-credential signing queue (Map<credentialId, Promise>)

### S-F5 [Major]: clientDataJSON from untrusted MAIN world not validated
- File: `extension/src/content/webauthn-interceptor.js:100-115`
- Problem: Background signs without verifying clientDataJSON structural integrity
- Fix: Parse and validate type/challenge fields in background before signing

### S-F6 [Minor]: localhost HTTP exposes credential metadata
- File: `extension/src/background/index.ts:585-592`
- Consistent with existing patterns, no change needed

### S-F7 [Minor]: No client-side entryId ownership check
- File: `extension/src/background/passkey-provider.ts:104-109`
- Server-side auth is the guard, no change required

## Testing Findings

### T-F1 [Critical]: No tests for CBOR encoder
- File: `extension/src/lib/cbor.ts`
- Fix: Create `extension/src/__tests__/cbor.test.ts`

### T-F2 [Critical]: No tests for WebAuthn crypto (p1363ToDer, signAssertion, etc.)
- File: `extension/src/lib/webauthn-crypto.ts`
- Fix: Create `extension/src/__tests__/webauthn-crypto.test.ts`

### T-F3 [Major]: No tests for passkey provider handlers
- File: `extension/src/background/passkey-provider.ts`
- Fix: Create `extension/src/__tests__/background-passkey-provider.test.ts`

### T-F4 [Major]: background.test.ts missing PASSKEY failsafe coverage
- File: `extension/src/__tests__/background.test.ts`

### T-F5 [Major]: No tests for webauthn-bridge-lib.ts
- File: `extension/src/content/webauthn-bridge-lib.ts`
- Needs jsdom environment or DI refactor

### T-F6 [Minor]: Bridge constant duplication untestable
- File: `extension/src/content/webauthn-interceptor.js`

## Adjacent Findings
- [Adjacent from Functionality] R12: No server-side audit actions for passkey sign/create — may overlap with Security scope
- [Adjacent from Security] S-F1 (same as F-C1): Wrong AAD for team entry — overlaps with Functionality scope (already captured as F-C1)

## Quality Warnings
None

## Resolution Status

### F-C1 [Critical] Team signing wrong key/AAD
- Action: Added `if (teamId) return { ok: false, error: "TEAM_PASSKEY_NOT_SUPPORTED" }` guard
- Modified file: extension/src/background/passkey-provider.ts

### F-C2 [Critical] Team overview missing rpId/credentialId
- Action: Deferred — team passkey support restricted to personal entries only (guard in F-C1)

### F-M1 [Major] Team form round-trip
- Action: Deferred — same scope restriction as F-C1. Team passkey forms will be addressed in separate PR

### F-M2 [Major] Missing lastError check
- Action: Added `chrome.runtime.lastError` checks to all 3 sendMessage callbacks in webauthn-bridge-lib.ts

### F-m1 [Minor] Unused import
- Action: Removed `base64urlDecode` import from passkey-provider.ts

### F-m2 [Minor] Unused challenge parameter
- Action: Removed `challenge` from PASSKEY_CREATE_CREDENTIAL message, bridge, and provider

### F-m3 [Minor] Dropdown i18n
- Action: Added i18n keys (en/ja) and replaced hardcoded strings with `t()` calls in passkey-dropdown.ts

### S-F2 [Major] allowCredentials not filtered
- Action: Added `allowCredentials` filtering in webauthn-interceptor.js get() flow

### S-F3 [Major] rpId not validated
- Action: Added `isValidRpId(rpId, hostname)` validation in both get() and create() flows

### S-F4 [Major] Counter race condition
- Action: Added `withSigningLock` per-credential mutex using Map<string, Promise> in passkey-provider.ts

### S-F5 [Major] clientDataJSON unvalidated
- Action: Added JSON.parse + type/challenge field validation in both sign and create handlers

### S-F6 [Minor] localhost HTTP
- Action: No change — consistent with existing token-bridge pattern

### S-F7 [Minor] No client-side entryId check
- Action: No change — server-side auth is the guard

### T-F1 [Critical] No CBOR tests
- Action: Created extension/src/__tests__/cbor.test.ts (30 tests)

### T-F2 [Critical] No WebAuthn crypto tests
- Action: Created extension/src/__tests__/webauthn-crypto.test.ts (41 tests)

### T-F3 [Major] No passkey provider tests
- Action: Created extension/src/__tests__/background-passkey-provider.test.ts

### T-F4 [Major] No PASSKEY failsafe tests
- Action: Added 6 PASSKEY failsafe tests to extension/src/__tests__/background.test.ts

### T-F5 [Major] No bridge-lib tests
- Action: Created extension/src/__tests__/webauthn-bridge-lib.test.ts (12 tests, jsdom environment)
