# Plan Review: ios-passkey-registration

Date: 2026-06-13
Review round: 1 (functionality / security / testing). Security flagged 2 Criticals with escalate:true.

## Headline: the chosen auth design is infeasible as written

All three experts converge on **F1/S1 [Critical]**: the Secure-Enclave DPoP signing key
(`SecureEnclaveKey.swift`) is created without a shared `kSecAttrAccessGroup`, so it lives in the host
app's private Keychain group. SE keys are **immutable after creation** — the existing key cannot be
moved to the shared group, and the extension cannot sign a DPoP proof with it. Therefore the planned
"extension reuses the host's DPoP-bound access token" upload path **cannot authenticate**.

**Consequence**: synchronous upload (the correct no-lockout design) requires SERVER-SIDE work:
a short-lived, create-scoped token endpoint (+ an extension-owned DPoP key registered with the server,
or a non-DPoP scoped token). This expands scope beyond iOS into the Next.js backend. **Decision required
from the user before re-planning** (see plan Go/No-Go — C4 stays `pending`).

## Functionality Findings
- **F1 [Critical]** DPoP key unshareable to the extension (above). Fixes: extension-owned DPoP key in the shared group registered server-side, OR a scoped non-DPoP token endpoint.
- **F2 [Critical]** `MobileAPIClient` is `PasswdSSOApp`-only and can't move to `Shared` (`APPLICATION_EXTENSION_API_ONLY`). C4 must be a NEW `EntryUploader` in `Shared`, not a move.
- **F3 [Major]** Registration authData flags (extension uses `0x45` UP|UV|AT) vs the shipped assertion flags (`UP|UV|BE|BS`). Must set BE|BS in registration too, else strict RPs reject later assertions. Update C1.
- **F4 [Critical]** `project.yml` lacks `ProvidesPasskeyRegistration` capability → iOS never calls `prepareInterface(forPasskeyRegistration:)`. Add it.
- **F5 [Major]** `foregroundWorkStarted` single-fire guard can silently drop the registration's deferred work (ceremony hangs, no cancel) — reset it per entry point.
- **F6 [Minor]** iOS-built JWK omits x/y/key_ops/ext vs extension blobs (decoder tolerates; document).

## Security Findings
- **S1 [Critical, escalate]** = F1; the C4 gate must be a hard test/compile blocker, not documentation. If DPoP unshareable, a scoped-token endpoint must be formally designed first.
- **S2 [Critical, escalate]** Caching the host's FULL-scope access token in the shared Keychain over-privileges the extension. Prefer a server-issued create-only short-lived token. Quantify/accept or design scoped.
- **S3 [Major]** Upload-succeeds-then-completeRegistration-crashes → orphaned server entry (not a lockout; user re-registers). Document + add manual-test case + a "delete unused passkeys" follow-up.
- **S4 [Major]** Private-key zeroing is best-effort (CryptoKit `P256.Signing.PrivateKey` can't be zeroed; the JWK `Data` can). Add `zeroJWK()`; accept SE-less software key residue explicitly.
- **S5 [Major]** DPoP nonce is in the host-only `HostTokenStore`; the extension has none → first create 401s. Stage the nonce alongside the token (nonce is non-secret, RFC 9449).
- **S6 [Minor]** Use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (BridgeKeyStore nearby uses `WhenUnlocked` — copy-paste drift risk).
- **S7 [Minor]** `CreateEntryRequest.entryType` comment says `"LOGIN"` — must send `"PASSKEY"`.
- **S8 [Minor]** = F3 (authData BE/BS consistency).

## Testing Findings
- **T1 [Critical]** CBOR/COSE/attestationObject correctness is unverifiable without golden byte vectors (captured from the extension's TS encoder for a pinned key) OR a minimal CBOR decoder in the test target. "Byte-for-byte identical" must be checkable. Specify the approach.
- **T2 [Critical]** Specify `registrationOutcome(...)` as a pure function with an exact signature; the matrix must include `crypto-fail` and `vault-locked` cancel branches (the no-lockout invariant).
- **T3 [Major]** Drop the "device-only" Keychain fallback for `UploadTokenStore`; use the existing `KeychainAccessor`/`MockKeychainAccessor` pattern (BridgeKeyStore).
- **T4 [Major]** C2 round-trip must end by passing the stored JWK through `decodeP256PrivateKeyJWK` with a real pinned key (a bare-object encoding is a known failure mode).
- **T5 [Major]** Name `MobileAPIClientTests.testCreateEntry_athIsSHA256OfAccessTokenAndHtmIsPost` as a required regression guard for the C4 extraction (DPoP `ath` binding).
- **T6 [Major]** Mandate extracting the testable `registrationOutcome` (RT2 — VC context is sealed).
- T7/T8 [Minor] cite existing signCount test; specify reproducible adversarial manual steps.

## Resolution status
Round 1 surfaced a **design-changing feasibility blocker (F1/S1)** that requires a user decision on
scope (add a server-side scoped-token endpoint vs pause). Plan NOT advanced to Phase 2. Security Opus
escalation (S1/S2 escalate:true) is warranted once the auth approach is settled. Remaining Majors
(F3/F5, S3-S5, T1-T6) are clear plan/contract fixes to apply after the auth decision.

## Recurring Issue Check (consolidated)
R8/RS2 biometric gate (preserved), R17/R19 (EntryUploader new type + createEntry regression test),
R28/RS1 (Keychain access groups — the crux), R35 Tier-2 manual test (auth flow), R37 (no orphaned RP
credential — F5 hang path + S3 orphan). RT1 (mock Keychain), RT2 (sealed VC context → pure decision fn),
RT4 (DPoP ath regression). Others N/A.
