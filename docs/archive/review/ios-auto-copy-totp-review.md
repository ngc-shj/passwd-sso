# Plan Review: ios-auto-copy-totp

Date: 2026-06-13
Review round: 1 (functionality / security / testing, 3 parallel expert sub-agents)

## Changes from Previous Round

Initial review. All findings grounded against post-#552 `origin/main`.

## Functionality Findings

- **F1 [Critical] — second password-fill path bypasses `completePasswordFill`.** `prepareInterfaceToProvideCredential(.password)` (CredentialProviderViewController ~L189-227) decrypts detail and calls `completeRequest` directly; the plan's "single funnel" premise was wrong. **Resolved** → C3 now hooks BOTH sites via `autoCopyTotpIfEnabled`.
- **F2 [Critical] — `AppSettingsStore` not importable from the extension** (lives in `PasswdSSOApp` target; app-extensions can't link the host). **Resolved** → C2 moves it to `Shared`, made public.
- **F3 [Major] — `VaultEntryDetail.totpSecret` drops algorithm/digits/period** (EntryBlobDecoder.detail), so non-default TOTP configs generate wrong codes; pre-existing bug in a changed file. **Resolved** → C4 propagates the params and fixes `completeTOTPFill` too.
- **F4 [Major] — Shared is `APPLICATION_EXTENSION_API_ONLY` with no UIKit imports today;** adding `UIPasteboard` is an unvalidated build risk. **Resolved (accepted)** → `UIPasteboard` is extension-safe; confirmed at build (Considerations notes fallback).
- **F5/F6 [Minor]** — double `AppSettingsStore()` init; pseudocode ordering. **Resolved** → C3 reads settings once.

## Security Findings

- **S1/S7 [Major] — default-ON silently copies a 2FA code; iOS threat model differs from the extension** (calling app foregrounds after `completeRequest` and can read `UIPasteboard`). **Resolved (user decision)** → default **OFF**, opt-in.
- **S2 [Minor] — `SecureClipboard.copy` had no bound on `clearAfter`.** **Resolved** → clamped [1,600] in C1.
- **S4 [Minor] — fail-open `autoCopyTotp` would break the `AppSettingsStore` "fail-closed" class contract.** **Resolved** → default OFF is fail-closed, contract intact.
- S5/S6 confirmed clean (no logging of secret; `.localOnly` closes Universal Clipboard).
- **R17/R22 [Major, Adjacent-F] — existing clipboard sites not migrated.** **Resolved** → C6 migrates both now.
- **R35 [Adjacent-T] — no manual-test plan for the auth-flow change.** **Resolved** → manual-test artifact required (Testing strategy).

## Testing Findings

- **T1 [Critical]** = F2 (extension can't access AppSettingsStore → C3 test won't compile). **Resolved** via C2 move.
- **T2 [Critical/RT2] — `UIPasteboard` write-options are not readable back;** the planned "assert expirationDate" acceptance was unreachable. **Resolved** → injectable `PasteboardWriter` seam (C1).
- **T3 [Major] — `totpToCopy` placed in extension target would be untestable** (PasswdSSOTests doesn't link the extension). **Resolved** → placed in `Shared`.
- **T4 [Major] — no regression test for "fill completes even if TOTP throws".** **Resolved** → matrix case 4.
- **T5 [Major]** = F1 (second fill path). **Resolved**.
- **T6 [Major] — no cross-App-Group-suite round-trip test.** **Resolved** → C2 acceptance.
- **T7/T8 [Minor]** — explicit 5-case matrix; tearDown clipboard clear. **Resolved**.

## Adjacent Findings

- R17/R22 (security→functionality): existing site migration — folded into C6.
- R35 (security→testing): manual-test artifact — folded into Testing strategy.

## Resolution Summary

All Critical/Major findings reflected in the revised plan (`ios-auto-copy-totp-plan.md`). No findings
deferred. The round-1 corrections were structural plan errors (wrong fill-path count, wrong target
membership, unreachable test assertion) rather than design disputes; the revised contracts address each.
Phase-3 review will verify the implemented diff against these resolutions.

## Recurring Issue Check (consolidated)

R1 helper extraction (SecureClipboard, clean) · R3/R17/R22 propagation (existing sites migrated, C6) ·
R19 memberwise-init updates (C4 note) · R25 persist/hydrate (autoCopyTotp getter+setter, default-absent
= false) · R34 pre-existing bug in changed file (F3 totp params, fixed) · R35 manual-test artifact (added).
RS1-RS4: no credential comparison / no new endpoint / no network boundary / no PII in artifacts.
RT1 mock-reality (VaultEntryDetail stub matches) · RT2 testability (PasteboardWriter seam) · RT5 call-path
includes `generateTOTPCode`. Others N/A (no DB/event/migration/CI surface).
