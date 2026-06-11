# Code Review: ios-entry-create-edit
Date: 2026-06-11
Review round: 1 (terminal)

## Changes from Previous Round
Initial code review of the implemented feature (diff vs `ios-main`).

## Functionality Findings
- **F1 (Major) — RESOLVED**: `EntryDetailView` showed stale pre-edit data after a successful edit. The F9 plan-fix corrected WHAT `loadDetail()` reads (`viewModel.cacheData ?? cacheData`) but nothing TRIGGERED a re-load after the edit sheet closed (the old `onSaved: { loadDetail() }` was dropped when `EntryForm` removed `onSaved`). Fix: `.sheet(isPresented:onDismiss: { loadDetail() })` — re-decrypts from the VM's now-fresh cache on dismiss (Save or Cancel). `EntryDetailView.swift:70`.

All other contracts (C1–C6) verified correctly implemented (createEntry DPoP/201/id-echo; preserve-unknown round-trip; cacheData ownership + no optimistic-prepend; keyVersion plumbing across all 8 sites; UI modes + toolbar; lossy encoder removed — zero grep hits).

## Security Findings
**No findings.** All plan security items verified clean:
- S2: `serverId == entryId` check present, fail-closed, UUID case-safe (both lowercased).
- AAD/IV: blob vs overview use distinct personal AADs; fresh random IV per `encryptAESGCMEncoded`.
- Version handling: decrypt with stored aadVersion; re-encrypt with aadVersion 1 + live `max(1,keyVersion)`; legacy aadVersion-0 upgrade is fail-closed (`rawPlaintexts` nil → `entryNotDecryptable`, never writes garbage).
- TOTP clearing removes the FULL-blob `totp` key (not just the overview marker) — secret not orphaned.
- DPoP on createEntry mirrors updateEntry (ath, basePath-preserving htu, htm=POST, nonce retry).
- In-memory: VM `cacheData` holds encrypted wire blobs; `rawPlaintexts` decrypts on demand to stack-scoped `Data`; no new plaintext persistence.
- RS4: no real PII in committed docs/tests (`user@github.com` is synthetic fixture).

## Testing Findings
- **T1 (Minor) — RESOLVED**: `testCreateEntry_throwsEntryIdMismatch...` lacked the plan-required `allSummaries unchanged` post-assertion. Added `XCTAssertEqual(vm.allSummaries.count, 0)` after the catch.
- **T2 (Minor) — RESOLVED**: createEntry's DPoP `ath`/`htm` payload was not verified at the `MobileAPIClient` layer (updateEntry had the test, createEntry did not). Added `testCreateEntry_athIsSHA256OfAccessTokenAndHtmIsPost` decoding the DPoP JWS payload and asserting `ath == sha256Base64URL(token)` and `htm == "POST"`.

Verified non-vacuous: C2 case 3 (vanishing-entry regression: `EntryBlobDecoder.detail` non-nil + tags==["work"] + new password + generatorSettings byte-equal), cases 8/9 (NSNull / CFBooleanGetTypeID bool-fidelity re-parse), C3 round-trip (real-crypto decrypt of PUT body → tags+generatorSettings survive), legacy aadVersion-0 upgrade, C4 distinct-value (7) threading, C1 201/200/401-retry/4xx + updateEntry 200/204 regression guard.

## Adjacent Findings
None requiring action. (S7 round-1 TOTP-clipboard concern verified already-secure: `TOTPCodeView.copyToClipboard()` uses `.localOnly + .expirationDate`.)

## Recurring Issue Check
### Functionality expert
R1-R37: all checked. Applicable & clean: R1 (PersonalEntryBlobBuilder is a new SSoT, no reimpl), R3 (DPoP retry pattern consistent), R17/R22 (all save paths funnel through the builder; lossy encoder fully removed), R19 (test mocks decode request bodies), R35 (manual-test artifact present). Rest N/A (iOS client; no DB/event/CI/migration). F1 was the only behavioral gap.

### Security expert
R1-R37 + RS1-RS4: all checked, clean. RS1 (`serverId==entryId` is UUID equality, not a credential compare — no timing-safe requirement), RS2/RS3 (server routes pre-existing, Zod-validated), RS4 (no PII). R37 clean (no internal jargon in user strings).

### Testing expert
R1-R37 + RT1-RT5: clean. RT1 (201 stub echoes request id — matches server contract), RT2-RT5 (fresh VM per test, tearDown resets MockURLProtocol, no sleep, no vacuous passes — CFBoolean guard fires for the bridged production value).

## Resolution Status
### F1 Major — stale detail after edit — RESOLVED
- Action: added `onDismiss: { loadDetail() }` to the edit sheet.
- Modified file: ios/PasswdSSOApp/Views/Vault/EntryDetailView.swift:70
### T1 Minor — entryIdMismatch allSummaries assertion — RESOLVED
- Action: assert `allSummaries.count == 0` after the mismatch throw.
- Modified file: ios/PasswdSSOTests/VaultViewModelTests.swift (testCreateEntry_throwsEntryIdMismatch...)
### T2 Minor — createEntry DPoP ath/htm test — RESOLVED
- Action: added `testCreateEntry_athIsSHA256OfAccessTokenAndHtmIsPost`.
- Modified file: ios/PasswdSSOTests/MobileAPIClientTests.swift

## Verification
- `build-for-testing`: BUILD SUCCEEDED.
- Affected unit test classes (MobileAPIClientTests, VaultViewModelTests, PersonalEntryBlobBuilderTests, VaultUnlockerTests): all PASSED, 0 failures.
- `xcodebuild` returns rc=65 / `TEST EXECUTE FAILED` due to a PRE-EXISTING host-app launch crash (`BridgeKeyStore.swift:100` precondition "service name must end in 'bridge-key'"), reproducible on the unmodified `ios-main` baseline — unrelated to this feature. Unit test suites themselves report `passed` with 0 failures.
- Environment note: the dev Mac's disk is ~full; the result-bundle write also hits `No space left on device`. Neither is a code defect.

## Termination
Round 1 terminal. F1 (Major) + T1/T2 (Minor) resolved; security clean. F1 is a standard SwiftUI `onDismiss` re-load (verified compiling + behavior reasoned + tests pass); no security-boundary touch → no Round 2 required.
