# Code Review: ios-passkey-provider

Date: 2026-06-12
Review round: 1

## Changes from Previous Round

Initial code review of the committed implementation (`git diff ios-main...HEAD`,
commit 378419e4) by three expert sub-agents. All findings Minor/Low — no
Critical/Major. Build clean (warnings-as-errors); 335→351 unit tests pass after fixes.

## Functionality Findings

- **F1 (Minor)** — Missing T5 test: bare-JWK-object at `passkeyPrivateKeyJwk` → nil. Behavior correct but unproven.
- **F2 (Minor)** — `buildPasskeyAssertion` did not guard an empty decoded `userHandle` before constructing `ASPasskeyAssertionCredential` (framework-crash risk for a residual/pre-migration identity).
- **F3 (Minor, UX)** — `CredentialPickerView` showed "No passwords for this site" when reused for the passkey ceremony empty state.
- **F4 (Minor)** — `presentPasskeyList` passes `all: matches` (intentional for passkey ceremony); wanted a clarifying comment.

## Security Findings

- **S1 (Low)** — `decodeP256PrivateKeyJWK` did not zero the intermediate raw 32-byte private `scalar: Data` after constructing the key (plan committed to zeroing). escalate: false.
- All other security checks PASS: I1 (no network/writes from extension, structurally enforced by `APPLICATION_EXTENSION_API_ONLY`), S2 (rpId guard before crypto, OS rpId authoritative), I3 (JWK Data zeroed on success+catch; no secret logging; bare error enums), RS4 (single biometric read; vault_key zeroed), C8 (registration cancelled; no `ASPasskeyRegistrationCredential` except a doc comment), confused-deputy (team + non-passkey guards), signCount 0, entitlement scope (no webcredentials).

## Testing Findings

- **T1 (Low)** — No test for key_ops/ext extra-field tolerance in JWK decode (plan T13).
- **T2 (Low)** — = F1 (bare-JWK-object → nil).
- **T3 (Low)** — No test for empty-credentialID skip in `buildPasskeyIdentitySpecs` (symmetric to the empty-userHandle test).
- **T4 (Info)** — Comment requested documenting the standalone (no-resolveCandidates) path.
- All required coverage criteria otherwise PASS (rpIdMismatch, OS-rpId authData, signCount-0 two-call, empty credentialId, empty-userHandle skip, non-passkey/team → entryNotFound, filterPasskeyCandidates exact-match, back-compat replace, FakeIdentityStore migrated, single-biometric count==2). RT5: HostSyncService test asserts the production `toPersonalCacheEntry` mapping (D1), not the stub copy.

## Adjacent Findings

- (Functionality) UI-test pre-existing failures — already documented in deviation D2; not re-flagged.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert
R1 (reuse) clean — `toPersonalCacheEntry` SSOT removed duplication; all helpers reused. R3/R5 (actor/Sendable) correct. No `URLSession`/`signCount+1`/`ASPasskeyRegistrationCredential` in real code. R35 manual-test doc present.

### Security expert
RS1 (scalar zeroing gap → S1, now fixed), RS2 (no bypass; guards before crypto), RS3 (no network — grep + extension-API-only), RS4 (biometric per fill). R20 backward-compat (nil-default fields). R16 input validation (32-byte d).

### Testing expert
RT1 (mock-reality: pinned-d + byte-exact authData + double-encoded JWK fixture) PASS with T1/T2 pin-test gaps (now added). RT5 (production mapping) PASS via D1. No vacuous-pass / async-drop patterns.

## Resolution Status

### S1 [Low] Raw private scalar not zeroed
- Action: `var scalar` + `defer { scalar.resetBytes(in:) }` after key construction.
- Modified: ios/Shared/Crypto/PasskeyAssertion.swift (decodeP256PrivateKeyJWK)

### F2 [Minor] Empty userHandle not guarded in assertion
- Action: `buildPasskeyAssertion` now throws `PasskeyCryptoError.emptyUserHandle` when the decoded userHandle is empty; added `.emptyUserHandle` error case + test `testBuildPasskeyAssertion_emptyUserHandleThrows`.
- Modified: ios/Shared/Crypto/PasskeyAssertion.swift, ios/PasswdSSOTests/PasskeyAssertionTests.swift

### F3 [Minor] Passkey empty-state copy
- Action: `CredentialPickerView.emptyStateText` param (default password copy); passkey list passes "No passkeys for this site"; added en+ja catalog entry.
- Modified: ios/PasswdSSOAutofillExtension/Views/CredentialPickerView.swift, CredentialProviderViewController.swift, PasswdSSOAutofillExtension/Localizable.xcstrings

### F4 [Minor] Clarify all==matches in passkey list
- Action: added explanatory comment.
- Modified: ios/PasswdSSOAutofillExtension/CredentialProviderViewController.swift

### F1/T2 [Minor/Low] bare-JWK-object → nil test
- Action: added `testPasskeyMaterialReturnsNilWhenJWKIsBareObject`.
- Modified: ios/PasswdSSOTests/EntryBlobDecoderTests.swift

### T1 [Low] key_ops/ext tolerance test
- Action: added `testDecodeJWK_toleratesExtraWebCryptoFields`.
- Modified: ios/PasswdSSOTests/PasskeyAssertionTests.swift

### T3 [Low] empty-credentialID skip test
- Action: added `testBuildPasskeyIdentitySpecs_skipsEmptyCredentialId`.
- Modified: ios/PasswdSSOTests/CredentialIdentityRegistrarTests.swift

### T4 [Info] standalone-path comment
- Action: added comment in `testDecryptPasskeyMaterial_returnsMaterial`.
- Modified: ios/PasswdSSOTests/CredentialResolverTests.swift
