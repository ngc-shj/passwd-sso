# Code Review: ios-entry-detail-type-specific-fields

Date: 2026-06-19
Review round: 1 (terminated — tightening-only)

## Changes from Previous Round
Initial code review of the Phase 2 implementation (`git diff origin/main..HEAD`, iOS-only).

## Functionality Findings
**No findings.** All 8 verification checks passed:
- Blob-key fidelity: every decoded key byte-exact vs the web `fullBlob` literals (`src/components/passwords/personal/personal-*-form.tsx`) for all 7 non-login types — incl. SSH `passphrase`/`comment` + `keySize: String?`, secure-note `content`, identity's 20 keys.
- entryType gating: correct sub-struct per type, siblings nil, LOGIN/nil/unknown builds none; all type strings match server `ENTRY_TYPE`.
- C7 Edit gate: no path lets a non-login entry reach `EntryForm.edit`.
- C8 clear-on-lock: `.onChange(of: autoLockService.state)` clears on `.locked` and `.loggedOut`, not on unlock; no race.
- SecretRow: per-row reveal isolation correct; composes in List/Section; @ViewBuilder optionals correct.
- D1 deviation sensible; switch exhaustive (no `default`); no consumer broken (AutoFill/AutoCopyTOTP/DebugVaultLoader).

## Security Findings
**No findings.** Masked-field set matches the web `SENSITIVE_FIELDS` SSoT (`src/lib/constants/auth/share-permission.ts`) exactly for every type (card number/cvv; identity address/addressLine1/addressLine2/postalCode/idNumber; bank accountNumber/routingNumber/iban; ssh privateKey/passphrase; licenseKey; passkey credentialId; secure-note content `.privacySensitive()`). All copies route through `SecureClipboard` (localOnly + auto-clear); no raw `UIPasteboard`. Reveal/copy call `recordActivity()`. Passkey provider-private material (`passkeyPrivateKeyJwk`/`userHandle`/`signCount`) is NOT decoded into the display struct (isolated to the assertion-only `PasskeyFullBlobPayload`). No value logging. AutoFill keeps `entryType` nil (no new extension secret decode).

## Testing Findings
- **T1 (Low) — RESOLVED**: LOGIN-scalar-empty assertions (`url`/`password == ""`) added to the bank/ssh/software-license/passkey decode tests (previously only on card/identity).
- **T2 (Low) — RESOLVED**: sibling-sub-struct-nil assertions added to the same four tests.
- **T5 (Low) — ACCEPTED**: a dedicated minimal-fixture (absent→nil) test exists for credit card only.
  - **Anti-Deferral check**: acceptable risk.
  - Worst case: a non-card sub-struct field wired to the wrong key but still decoding to nil on a minimal fixture ships undetected. Likelihood: low — all sub-struct fields are uniform `String?` and every full-fixture test uses distinct non-default values per field, which catches cross-key swaps. Cost to fix: ~6 small tests. Accepted: the full per-field tests already guard the realistic regression (cross-key swap); the absent→nil edge is covered representatively by the credit-card minimal test.
  - **Orchestrator sign-off**: accepted as a representative reading of C5's "per-sub-struct minimal fixture".
- **T9 (Info) — ACCEPTED**: the C8 clear-on-lock decision is inlined (`newState != .unlocked`) rather than extracted into a unit-tested predicate.
  - **Anti-Deferral check**: acceptable risk. The decision is a single-token enum comparison; extracting a named `shouldClear(state:)` + test is over-engineering (YAGNI) for a comparison the compiler already type-checks. The `isEditableOnIOS` seam (genuine branching logic) WAS extracted + tested. Clear-on-lock is covered by the manual Debug-fixture checklist (C8 acceptance). Cost-to-fix trivial but value near-zero.
  - **Orchestrator sign-off**: accepted; inlined trivial comparison, manual-checklist covered.

## Adjacent Findings
None.

## Recurring Issue Check
### Functionality expert
- R2/R12 (exhaustive switch, no default): PASS. R3 (key fidelity across boundary): PASS. R19 (optional defaults/back-compat): PASS. R25 (consumer breakage): PASS. R39 (secret residency): PASS (C8). Others N/A.
### Security expert
- R39: addressed (C8). RS1 (clipboard auto-clear): PASS. RS2 (unmasked secret): PASS (SSoT parity). RS3 (passkey private leak): PASS. RS4 (secret logging): PASS. RS5 (AutoFill regression): PASS.
### Testing expert
- RT1 (vacuous assertions): none. RT2 (default expected values): PASS (distinct literals). RT3 (T10 shared-key over-assertion): PASS (username/email not over-asserted). RT4 (coverage gaps): T1/T2 resolved, T5 accepted. RT5 (shared state/async): none. RT6 (regression pins): intact (addition-only). RT7 (cheap pure seam): T9 accepted.

## Environment Verification Report
Per Phase 1 `Verification environment constraints`:
- `verifiable-local` (full test suite): **verified-local** — `xcodebuild test -scheme PasswdSSOApp` on sim 5EC37BD5, 538 unit tests + UI tests pass.
- Per-type visual parity on device (`blocked-deferred` in Phase 1): **blocked-deferred** — requires seeded vault entries of all 8 types on a device; mitigated by the byte-exact decoder unit tests (C5) and the DebugVaultLoader manual checklist. Links to Phase 1 constraint entry (Verification environment constraints, bullet 2). No Anti-Deferral cost beyond the manual-checklist mitigation already planned.

## Resolution Status
- T1, T2: assertions added to `ios/PasswdSSOTests/EntryBlobDecoderTests.swift` (bank/ssh/license/passkey tests); 538 tests pass.
- T5, T9: accepted per Anti-Deferral justifications above.
- No Critical/Major findings in any perspective. Review loop terminated after Round 1 (tightening-only: all new findings test-only, inline-minor, within prior fix scope, no security boundary).
