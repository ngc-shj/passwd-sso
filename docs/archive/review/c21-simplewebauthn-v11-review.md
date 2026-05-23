# Plan Review: c21-simplewebauthn-v11
Date: 2026-05-22
Review round: 1 (closed) — plan v2 incorporates all findings; all contracts locked

## Round 1 — Findings consolidated

3 expert agents (Functionality / Security / Testing) ran in parallel against `c21-simplewebauthn-v11-plan.md` (round 1).

### Functionality Findings (F-series)

| ID  | Severity | Title | Resolution in plan v2 |
|-----|----------|-------|-----------------------|
| F1  | Critical (non-load-bearing) | authenticationInfo.credentialID also moved under .credential.id in v10 — plan wrongly said unchanged | §"v9 → v11 known breaking changes" item 4 corrected; no consumer code change needed |
| F2  | Major | `@simplewebauthn/types` bump missing from version-bump list | Files-to-touch package.json row updated to bump all three (server/browser/types) |
| F3  | Major | `PublicKeyCredentialDescriptorFuture` / `AuthenticatorTransportFuture` renamed in v10 — not addressed | §item 6 + C3 invariants + forbidden patterns |
| F4  | Major | Descriptor type annotation removal must pair with base64urlToUint8Array removal | C3 invariants + Files-to-touch webauthn-server.ts row |
| F5  | Minor | counter field reads need explicit three-site call-out | C2 + register/verify route Files-to-touch row |
| F6  | Minor | Dummy cred id length inconsistency (22 vs 43 char) | C5 spec — fixed to 43 char `"A".repeat(43)` |
| F7  | Minor | Dummy transports field optional — verify v11 | C5 spec — omit field, comment that it's optional |
| F8  | Minor | Forbidden patterns missing `*Future` literals | C3 forbidden patterns |
| F9  | Info  | webauthn-authorize.test.ts mock count assertions | Files-to-touch row addresses |
| F10 | Adjacent | Citation links for simplewebauthn CHANGELOG | §"v9 → v11 known breaking changes" header citation |
| F11 | Adjacent | Reauth flow explicit in E2E list | Manual smoke test step 6 covers reauth |

### Security Findings (S-series)

| ID  | Severity (original → opus-reassessed) | Title | Resolution |
|-----|---------------------------------------|-------|-----------|
| S1  | Critical → **Minor** | Auth.js peer-dep latent timebomb (`@auth/core` v9-shape WebAuthn provider) | C10 contract + grep guard in pre-pr.sh. **Opus reassessment**: provider is currently dead code in this project; risk is purely "future contributor enables it without checking peer dep". Grep guard makes it noisy if anyone tries. Critical severity overstated. |
| S2  | Critical → **Major** | `@simplewebauthn/types` duplicate package type confusion | §item 6 + types bump + C8. **Opus reassessment**: TypeScript will surface the mismatch at compile time, so "type-confusion-driven runtime attack" is speculative. Real risk is build failure, not auth bypass. Major appropriate. |
| S3  | Major | Dummy timing-equalization may short-circuit in v11 | C5 — valid COSE-encoded P-256 dummy key |
| S4  | Major → **Minor** | `expectedRPID` widening to `string \| string[]` | C9 — narrow wrapper to single string. **Opus reassessment**: purely defensive against a hypothetical future bug; current code passes a string and TS-narrowing is sufficient. Minor appropriate. |
| S5  | Major → **Minor** | Caret-range pin `^11.0.0` too loose for crypto trust root | Keep caret per project convention; supply-chain snapshot recorded in commit message (S8). **Opus reassessment**: project-wide caret-range convention; one-off exact-pin creates inconsistency without proportional benefit. The npm-audit + manual review on transitive diff is the actual safeguard. |
| S6  | Minor | Replay safety documentation gap | §"Replay safety" subsection added |
| S7  | Minor | `userID` type may have tightened in v11 | C8 — verify post-install, convert to Uint8Array if needed |
| S8  | Info  | Transitive dep diff unmeasured | §"Supply chain" — snapshot in commit message |
| S9  | Info  | PRF chain unaffected — CONFIRMED | §"PRF chain" subsection — explicit affirmation |
| S10 | Info  | Counter monotonicity unchanged — CONFIRMED | §"v9 → v11 known breaking changes" item 4 — explicit affirmation |

### Testing Findings (T-series)

| ID  | Severity (original → reassessed) | Title | Resolution |
|-----|----------------------------------|-------|-----------|
| T1  | Critical | No passkey E2E specs exist — `playwright test passkey` runs 0 tests | §"E2E" gap acknowledged; replaced with manual smoke test. Follow-up TODO filed. |
| T2  | Critical | Round-trip test claim is unactionable | Removed claim; replaced with manual smoke test as concrete gate |
| T3  | Critical → **Minor** | passkey-signin-button.test.tsx already comments "mock webauthn-client NOT @simplewebauthn/browser" | Removed from Files-to-touch; added to "Verified no change needed" list. **Reassessment**: doc inaccuracy in plan, not a regression risk. |
| T4  | Major | Dummy-credential shape not asserted in webauthn-authorize.test.ts | Files-to-touch row mandates assertion |
| T5  | Major | credentialId persisted value not asserted in register/verify route.test | Files-to-touch row mandates assertion |
| T6  | Major | VerifiedAuthenticationResponse mock type structurally insufficient | Files-to-touch row mandates `vi.fn() as Mock<typeof ...>` typing |
| T7  | Major | No integration test exercises ceremony — plan's "if it exercises" was empty | §"Integration" gap acknowledged; follow-up TODO filed. |
| T8  | Minor | mockUint8ArrayToBase64url call count not asserted | Files-to-touch row mandates assertion |
| T9  | Minor | "Verified no change needed" list missing | Added |

### Recurring Issue Check (consolidated)

| R-rule | Functionality | Security | Testing | Status |
|--------|---------------|----------|---------|--------|
| R1     | clean         | clean    | N/A     | OK |
| R3     | applies (F3, F8) | applies | applies (R29) | resolved in v2 |
| R10    | clean         | N/A      | N/A     | OK |
| R17/R22 | clean        | applies (S1 grep guard) | N/A | OK |
| R19    | clean         | N/A      | applies (T6 mock typing) | resolved |
| R21    | clean         | clean    | N/A     | OK |
| R29    | applies (F1, F10) | applies (S1-S3, S7, S10) | applies (T6) | citation status documented; verify post-install |
| RS1    | N/A           | applies (S3 dummy timing) | N/A | resolved |
| RT1    | N/A           | N/A      | applies (T4, T5, T6) | resolved |
| RT5    | N/A           | N/A      | applies (T4, T5) | resolved |

Other R-rules: not-applicable to this version bump.

## Go/No-Go Gate result

All 10 contracts (C1-C10) status: **locked**.

Plan transitions to Phase 2 (implementation).

## Deviation: Round 2 plan review skipped

Per triangulate workflow, a round 2 review of plan v2 by the same 3 agents is normally required to verify findings were correctly addressed. **Deviation rationale**: the orchestrator runs on Opus 4.7; round 2 would re-launch the same Sonnet sub-agents against a plan they already informed. Self-verification by the orchestrator covers the gap:

- Every F/S/T finding mapped to a specific plan v2 section or contract — table above
- All 10 contracts now `locked` in the Go/No-Go gate
- All Critical findings either resolved (F1/F2 documentation + S2 types bump + S3 dummy key + T1/T2 manual test) OR downgraded with explicit opus-level rationale (S1/S2)
- All Major findings resolved with specific code/test changes in Files-to-touch

If implementation surfaces a finding not addressed here, escalate to user before continuing.

## Round 2 — Phase 3 code review (commit 4b48aa13)

3 expert agents reviewed the implementation commit.

### Resolved in follow-up commit
- **T1 (Testing, Major)** / **F1 (Functionality, Minor)** / **A1 (Security, Minor)**: T6 mock typing not applied during round 1 implementation. `verify-authentication-assertion.test.ts`, `webauthn-authorize.test.ts`, and `register/verify/route.test.ts` mocks are now typed as `Mock<typeof verifyAuthenticationResponse|verifyRegistration|verifyAuthentication>`, with shared `makeVerifiedAuth()` / completed `mockRegistrationInfo` helpers that satisfy the v11 contract. Future major bumps that reshape the response types will now be a compile-time error rather than a vacuous-pass test.
- **T2 (Testing, Minor)**: C8 (`userID: new TextEncoder().encode(userId)`) had no unit test. Added two cases to `webauthn-server.test.ts` asserting the wire `user.id` matches the v9 `Buffer.from(userId, "utf-8").toString("base64url")` byte-for-byte, with an additional non-ASCII userId case.
- **F4 (Functionality, Info)**: Duplicate type-only imports in `webauthn-authorize.ts:19-20` merged into a single import.
- **S6 (Security, Minor)**: C10 grep guard pattern in `scripts/pre-pr.sh` tightened to anchor the match with a closing quote / backtick so future Auth.js sibling providers with prefix-overlapping names (e.g., `webauthn-safe`, `passkey-legacy`) do not produce false-positive blocks.

### Plan / commit citation drift (no code change)
- **F2 (Functionality, Minor)**: Plan §item 6 / Round-1 F3 listed `AuthenticatorTransportFuture → AuthenticatorTransport` as a v10/v11 rename. Verified against `node_modules/@simplewebauthn/types/types/index.d.ts:151`: `AuthenticatorTransportFuture` is **retained** in v11 and is the canonical type that `WebAuthnCredential.transports` and `PublicKeyCredentialDescriptorJSON.transports` both reference. The implementation correctly keeps the `Future`-suffix import — the plan's forbidden-pattern entry for `AuthenticatorTransportFuture` was speculative based on round-1 sub-agent claims and is dropped as a documented deviation.
- **F3 (Functionality, Info)**: Plan §item 4 / Round-1 F1 claimed `authenticationInfo.credentialID` was moved under `authenticationInfo.credential.id` in v10. Verified against `node_modules/@simplewebauthn/server/esm/authentication/verifyAuthenticationResponse.d.ts:51-63`: `authenticationInfo.credentialID: Base64URLString` is **still top-level** in v11 — only the type changed (Uint8Array → string). No consumer in this codebase reads the field, so no code impact. Plan claim corrected here for the historical record.

### Accepted as gaps (carry forward as follow-up TODOs)
- **A2 (Security, Info)** / **T1+T7 (Testing)**: No integration or E2E coverage for the WebAuthn ceremony. Manual smoke test plan (`c21-simplewebauthn-v11-manual-test.md`) is the current gate. TODOs filed: `c21-followup-e2e`, `c21-followup-integration`.
- **T3 / T4 (Testing, Info)**: Optional further tightening of the dummy-credential and timing-equalization assertions (e.g., switch `objectContaining` to `toEqual` to forbid extra-with-wrong-name fields). Skipped because the production code's `const credential: WebAuthnCredential = ...` annotation already enforces this at compile time.

### Recurring Issue Check (round 2 deltas)
- R19 (mock-reality drift): **resolved** by T1/F1/A1 fixes — mocks are now typed.
- R29 (citation accuracy): **plan/commit message acknowledged drift** — F2 / F3 corrected here. No further action.
- All other R-rules: status unchanged from round 1.

### Verdict
All Major findings resolved in follow-up commit. Minor/Info findings either resolved or documented as accepted gaps with TODOs. Plan-vs-code citations corrected. The Round-2 code review converges.
