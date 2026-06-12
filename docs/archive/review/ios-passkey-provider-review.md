# Plan Review: ios-passkey-provider

Date: 2026-06-12
Review round: 1 (full) — resolutions applied

## Changes from Previous Round

Initial review by three expert sub-agents (functionality, security, testing) on the
assertion-only passkey-provider plan. All Critical/Major/actionable-Minor findings
resolved in the plan; rejections recorded with evidence below.

## Functionality Findings (F#)

- **F1 — Critical — REJECTED (verified false).** Claimed `ASPasskeyAssertionCredential.signature`
  needs raw r‖s, not DER. VERIFIED the opposite via Apple Developer Forums thread 710457
  (developer debugged passkey-provider verification → `sigdecode_der`) and the repo's own
  browser extension (`webauthn-crypto.ts` `p1363ToDer` converts to DER for the RP). `.derRepresentation`
  is correct. Plan §Technical approach / C2 annotated with the verification.
  - **Anti-Deferral check**: not a deferral — finding refuted with primary-source evidence.
  - **Orchestrator sign-off**: confirmed; agent's "evidence" was self-admittedly speculative.
- F2 — Major — RESOLVED. `completeAssertionRequest(using:)` is async → C6 now mandates `await` (mirrors TOTP `await completeOneTimeCodeRequest`).
- F3 — Major — RESOLVED. Mixed `[ASCredentialIdentity]` cannot use deprecated `replaceCredentialIdentities`; C5 migrated to iOS 17 `replaceCredentialIdentityEntries(_:)` (heterogeneous array, one atomic call). Verified via dotnet/macios binding + Microsoft Learn deprecation note.
- F4 — Major — RESOLVED. `recordIdentifier` is `String?`; C6 adds nil/empty guard → descriptive cancel.
- F5 — Major — RESOLVED. `entryType` dropped by HostSyncService though present on `EncryptedEntry`; C4 populates it + documents team-rows-always-nil.
- F6 — Major — RESOLVED. C3 now explicitly lists the full-blob fields to decode (`PasskeyFullBlobPayload`).
- F7 — Minor — CONFIRMED (no action). Cache MAC covers ciphertext, not JSON keys → optional field is backward compatible. Noted in C4.
- F8 — Minor — RESOLVED. C6 specifies clientDataHash/UV source from `requestParameters` and exact rpId match (no eTLD+1).
- F9 — Minor — RESOLVED. C6/C8 use `any ASCredentialRequest` (Swift 6 strict existential).
- F10 — Minor — RESOLVED. C5 specifies full-blob decrypt happens inline in `runSync` using the in-scope `vaultKey`.
- F11, F12 — Minor — CONFIRMED correct (authData layout; CryptoKit JWK feasibility). No action.

## Security Findings (S#)

- **S1 — High — RESOLVED (design change).** Emitting stored signCount N is rejected by strict RPs
  (browser increments+persists N+1; received ≤ stored fails). C7 changed to emit **0 unconditionally**
  (spec-standard non-tracking-authenticator signal) with an HONEST documented limitation (browser-used
  passkeys may be rejected by strictly-monotonic RPs until the deferred write-back branch). signCount
  removed from `PasskeyAssertionMaterial` (eliminates T4 overflow surface).
- S2 — Medium — RESOLVED. `buildPasskeyAssertion` asserts `material.relyingPartyId == request.relyingPartyId` (`rpIdMismatch`) and uses the OS-provided rpId for authData (defense-in-depth).
- S3 — Medium — RESOLVED. C8 now REQUIRES an explicit registration override that cancels cleanly; "omit the override" removed.
- S4 — Low/Med — RESOLVED. `privateKeyJWK` changed `String` → `Data`; zeroed via existing `zeroData` pattern (I3).
- S5 — Low — RESOLVED. Protocol keeps a back-compat default-arg `replace(with:)` extension wrapper; one atomic replace clears both kinds.
- S6 — Low — RESOLVED. C4 adds a HostSyncService entryType-propagation test.
- S7, S9 — Informational — CONFIRMED correct (HostTokenStore per-app isolation; OS owns origin binding). No action.
- S8 — Informational — RESOLVED. C6 mandates `decryptPasskeyMaterial` applies the same `defer { zeroData }` guard.
- S10 — Low — RESOLVED. C2/§Non-functional document UV=true always (deliberate, no downgrade risk).

## Testing Findings (T#)

- T1 — High — RESOLVED. Pinned P-256 vector + byte-exact authData assertion (not generate-then-verify only).
- T2 — High — RESOLVED. Testing strategy calls out `FakeIdentityStore` MIGRATION to the new signature + passkey-spec capture.
- T3 — Medium — RESOLVED. Two-call same-material assertion that authData[33..36]==BE(0).
- T4 — Medium — OBVIATED. signCount removed from material (always 0) → no overflow path.
- T5 — Medium — RESOLVED. C3 + tests pin the double-encoded `passkeyPrivateKeyJwk` string shape.
- T6 — High — RESOLVED. Extracted `filterPasskeyCandidates` pure Shared function (testable); list-path logic thinned.
- T7 — Low — RESOLVED. Old-cache decode test uses a JSON literal lacking the key.
- T8 — Medium — RESOLVED. `decryptPasskeyMaterial` on LOGIN/team id → `entryNotFound` test.
- T9 — Medium — RESOLVED. Empty-userHandle passkey spec skipped + tested.
- T10 — Medium — RESOLVED. Manual-test doc gains 5 adversarial scenarios.
- T11 — Medium — RESOLVED. Flag-byte 0x05 / 0x00 pinned assertions.

## Adjacent Findings

- F-R13/R16 (functionality, security-adjacent): `d` must be validated as exactly 32 bytes; routed to C2 (`malformedPrivateScalar`). RESOLVED.

## Quality Warnings

None flagged (no merge-findings quality gate run; manual dedup — Ollama not invoked this round).

## Recurring Issue Check

### Functionality expert
R1–R37 returned by the sub-agent; salient: R20 (backward compat — additive, OK), R23/R36 (Swift 6 strict-concurrency/warnings-as-errors → F2/F9 would be build failures, now fixed), R24 (WebAuthn byte layout verified). Test-recommendation rules deferred to testing expert.

### Security expert
R1–R37 + RS1–RS4. Salient: RS3 (no network from extension — enforced by forbidden grep + HostTokenStore isolation), RS4 (biometric per fill — `touchIDAuthenticationAllowableReuseDuration=0`), R20/R21/R22/R23 mapped to S1/S2/S3/S4. No Critical.

### Testing expert
R1–R37 + RT1–RT5. Salient: RT1 (mock-reality — double-encoded JWK fixture, T5), RT2 (pinned vectors, T1/T11), RT3 (protocol-change propagation to FakeIdentityStore, T2), RT4 (single-Keychain-read mirror test), RT5 (per-test isolation).

---

# Round 2 (incremental) — resolutions applied

## Changes from Previous Round
Verified round-1 resolutions and surfaced threading/precision gaps. The one architecture-level
finding (F14/F15) is resolved with a concrete pattern-matching design (a Shared
`buildPasskeyIdentitySpecs` helper mirroring `decryptPersonalOverviews`, threaded through the
registrar's `replace(with:passkeys:)` and both call sites — NO `SyncReport` change).

## Functionality (F#)
- F13 — Minor — RESOLVED. Swift name is `replaceCredentialIdentities(_:)` (NS_SWIFT_NAME of `replaceCredentialIdentityEntries:`); passing `[any ASCredentialIdentity]` selects the heterogeneous overload. C5 corrected.
- F14 — Major — RESOLVED. Registrar's higher-level `replace(with summaries:)` + both call sites (`PasswdSSOAppApp.swift` ~59-62, `RootView.swift` ~328-329) updated to thread passkey specs; otherwise atomic `passkeys:[]` replace would wipe passkey identities every foreground sync.
- F15 — Major — RESOLVED. Adopted `buildPasskeyIdentitySpecs(from:vaultKey:userId:)` Shared helper called at the same sites as `decryptPersonalOverviews` (no `SyncReport` change). Supersedes round-1 F10 "build inside runSync" guidance.
- F16 — Minor — RESOLVED. C6 captures the `Sendable` `requestParameters` in the picker `onSelect` closure.
- F17 — Minor — RESOLVED. C3 nil-gate now also requires `credentialId`.

## Security (S#)
- S11 — Low — RESOLVED. C6 zeroes `material.privateKeyJWK` (Data) on success and in `catch` before re-throw (rpIdMismatch).
- S12 — Low — RESOLVED. Forbidden-logging grep broadened to `os_log|Logger\.|print\(|NSLog` in the passkey crypto/decode files; catch blocks re-throw without logging the decoder error.
- S1 citation caveat — noted: WebAuthn "Signature Counter Considerations" section number marked unverified in-plan; MUST be confirmed before quoting in the PR body (R29).

## Testing (T#)
- T12 — High — RESOLVED. FakeIdentityStore migration mandated as a same-commit change with capture-property guidance.
- T13 — Low — RESOLVED. JWK fixture note allows/encourages `key_ops`/`ext`; JSONDecoder ignores unknown keys.
- T14 — Medium — RESOLVED. Explicit `buildPasskeyAssertion` rpIdMismatch + OS-rpId-in-authData tests added.
- T15 — Medium — RESOLVED. Explicit back-compat `replace(with:[pwd])` → empty passkeys test added.
- T16 — Low — RESOLVED. Forbidden-pattern greps declared as a Phase 2/3 conformance gate; registration-cancel via manual test.
- T17 — Low — RESOLVED. Corrected the keychain-read invariant wording to `copyMatchingCallCount == 2` (one biometric + one no-ACL meta).

## Anti-Deferral
No findings deferred. All round-2 items applied in-plan. No "acceptable risk" / "pre-existing" skips taken.

## Recurring Issue Check (round 2 delta)
- R3 (propagation): F14/F15 — the additive identity-spec output is now threaded through ALL consumers (registrar method + 2 call sites). Confirmed.
- RT3 (protocol-change propagation): T12 — FakeIdentityStore conformance update enforced same-commit.
- R25 (persist/hydrate symmetry): N/A — QuickType identities are ephemeral (registered on unlock, cleared on lock/background/launch); not persisted across restart.
