# Code Review: security-review-hardening

Date: 2026-07-14
Review round: 1
Branch: fix/security-review-hardening (commits e7026703, 638760e3)

## Changes from Previous Round

Initial review. No plan/deviation artifacts exist for this branch; reviewed as a
standalone Phase-3 branch review. Ollama seed generation timed out — all three
experts fell back to full-diff review.

## Scope reviewed

Security-remediation branch touching:
- Extension WebAuthn RP ID canonicalization (webauthn-rp-id.ts NEW, webauthn-interceptor.js, passkey-provider.ts)
- DPoP htu canonicalization idempotency (src/lib/auth/dpop/htu-canonical.ts)
- MCP OAuth server credential length caps (oauth-server.ts, mcp/{token,revoke,authorize,authorize/consent}/route.ts, constants/auth/mcp.ts NEW)
- iOS TLS leaf-key pinning (ServerTrustService.swift, AuthCoordinator.swift, SessionRestorer.swift, RootView.swift, ServerURLSetupView.swift)

## Convergent finding (3-perspective — severity floor raised)

**C1 — Major→ (convergent): the "all authenticated server egress is TLS-pinned" invariant is incomplete; two live token-bearing paths remain unpinned, and the pin-enforcement code has no fail-closed test.**

This is the same class flagged independently by all three experts and by the
orchestrator's own primitive-derived enumeration. Per "Perspective Convergence as
a Severity Signal", the convergence stamps the class as the branch's central
regression risk. The class = every iOS URLSession that egresses authenticated
traffic to the app's OWN server:

| Site | Egress | Credentials on wire | Pin state |
|------|--------|---------------------|-----------|
| ServerTrustService.swift:150,187 | health / pinned probe | — | ✅ delegate-pinned |
| MobileAPIClient.swift:577,846 | all API calls | Bearer + DPoP | ⚠️ injection-dependent (default `.shared`) |
| EntryUploader.swift:126 | POST /api/passwords | Bearer + DPoP + encrypted passkey entry | ❌ UNPINNED (caller omits injection) |
| FaviconLoader.swift:64 | GET /api/mobile/favicon | Bearer + DPoP | ❌ UNPINNED |

- **Security F1 (FaviconLoader):** unpinned session sends `Bearer <access token>` + DPoP to the app's own `/api/mobile/favicon`. MITM defeating TLS captures a live access token in cleartext + host-enumeration of vault entries. DPoP mitigates replay, not the token leak or host enumeration. Orchestrator confirmed via `FaviconProvider.swift:4` ("All requests go through the app's own server — no third-party hosts") that this is same-server authenticated egress, NOT third-party favicons.
- **Functionality F1 (EntryUploader / autofill):** autofill extension constructs `EntryUploader` with no `urlSession` → default `.shared` (unpinned); POSTs a newly-created passkey entry + Bearer upload token to `/api/passwords`. Fix is non-trivial: `ServerTrustService.baseQuery` sets no `kSecAttrAccessGroup`, so the pin lives in the main app's private keychain and is unreadable by the autofill extension. Proper fix stores the pin in the shared access group (as `BridgeKeyStore` already does) and wires `EntryUploader` to a pinned session.
- **Testing F1/F2:** the pin-ENFORCEMENT code (`LeafKeyPinningDelegate.didReceive challenge` fail-closed branches; `willPerformHTTPRedirection` downgrade/cross-host reject) has no test. A regression flipping `hash != expectedLeafKeyHash` to `==` or dropping a `cancelAuthenticationChallenge` would silently accept any cert with no red test. `willPerformHTTPRedirection` is plain-value and directly testable yet uncovered.
- **Orchestrator root cause (R3 / R42):** the invariant was fixed at 3 explicit MobileAPIClient call sites, not derived from the primitive (= every authenticated same-server URLSession). `MobileAPIClient`/`EntryUploader` retain `urlSession: URLSession = .shared` fail-open defaults, so the class re-opens on the next caller that forgets to inject.

## Functionality Findings

See F1 above (folded into C1). Plus:

- **F2 — Major: No pin-clear/recovery path — legitimate TLS key rotation permanently locks out iOS users.** ServerTrustService.swift:139. Enforced TOFU with no `keychain.delete` path anywhere; `ValidateResult.mismatch` is now dead code (only tests reference `validate()`). A server cert/key rotation fails every sign-in and session restore permanently; re-entering the same URL re-hits the pin. Fix: pin-reset gated behind explicit user action ("server identity changed — re-verify" → clear + re-pin), staying fail-closed against silent MITM.
- **F3 — Minor:** iOS health-contract `json.count == 1` (ServerTrustService.swift:212) is a fragile cross-repo lock on `/api/health/live`; adding any field server-side breaks TLS establishment for older binaries. Fix: relax to `json["status"] == "alive"` or comment the server route as a locked iOS contract.
- **F4 — Minor:** revoke route (src/app/api/mcp/revoke/route.ts:94,97-99) — unsafe `token_type_hint` cast to narrow union without validating value + empty no-op `if` block. Functionally harmless (revokeToken uses `!== "access_token"`). Fix: `z.enum(["access_token","refresh_token"]).optional()` in schema; drop cast + empty block.
- **F5 — Minor:** `canonicalHtuClient` parity comment (htu-canonical.ts:67) overstates idempotency guarantee; asymmetry unreachable (all client callers pass basePath-free routes). Fix: tighten comment.

## Security Findings

See Security F1 above (folded into C1). No other findings. R43 clean on every path checked — no boundary widening. MCP length caps reject only non-issuable shapes before the hash lookup; pre-mint-gate-suppression class intact; PKCE + whole-family revocation preserved; revoke Zod schema fixes the prior unsafe cast.

## Testing Findings

- **F1/F2 (folded into C1):** iOS pin-enforcement fail-closed handshake + redirect reject paths untested (both Major).
- **F3 — Minor:** establishTrust/pinnedSession pin-missing + first-use-persist branches untested; `FakeKeychain` fixture makes them trivial.
- **F4 — Minor / note:** htu segment-boundary test (htu-canonical.test.ts:106) is a regression guard, not fail-before-fix (sibling idempotence test at 98 does fail before fix). No change required.

## Adjacent Findings

- Security F1 (FaviconLoader) and Functionality F1 (EntryUploader) are both `[Adjacent]` — pre-existing code outside the diff, but the exact control class the branch set out to remediate. Rated Major on that basis.

## Rejected

- Ollama seed (functionality): webauthn-rp-id.ts:11 `new URL()` strips ports → REJECTED. `canonicalDomain` rejects `:` via regex before `new URL()`; test asserts `example.com:443` → false and passes.

## Recurring Issue Check (orchestrator-consolidated)

- R3 (incomplete pattern propagation): HIT — TLS-pinning invariant propagated to 3 sites, missed EntryUploader + FaviconLoader. Critical-security-relevant → drives C1.
- R42 (class-membership derivation): HIT — class anchored on the 3 MobileAPIClient sites, not derived from the "authenticated same-server URLSession" primitive. Member-set as enumerated above.
- RT7 (guard/test proven able to fail): HIT — pin-enforcement branches have no test that can go red (Testing F1/F2).
- R43 (fix-induced boundary widening): CLEAN.
- RS1 (timing-safe comparison): CLEAN (no secret comparison weakened).
- R38 (async state machine fail-open): considered — MobileAPIClient/EntryUploader `.shared` default is a fail-open default (C1 root cause).
- Others: no additional hits beyond findings above.

## Resolution Status

User chose full remediation in this branch. Applied:

### C1 [Major, convergent] — unpinned authenticated egress class
- **Action:** Moved `ServerTrustService.swift` → `ios/Shared/Network/` so both the main app and the AutoFill extension can use it. Added `pinnedSession(for:cache:)`, `clearPin`, `currentPinExists`.
  - FaviconLoader now builds its favicon session lazily from `apiClient.makeFaviconSession(cache:)` (pinned + isolated cache); returns nil (no favicon) when no pin — never falls back to an unpinned session.
  - MobileAPIClient gained `faviconSessionFactory`; `urlSession` lost its `.shared` default (now required). AuthCoordinator/SessionRestorer/RootView supply a pinned factory from `ServerTrustService.pinnedSession`.
  - autofill `EntryUploader` now requires `urlSession`; CredentialProviderViewController passes `ServerTrustService().pinnedSession(for:)` and fails closed (skips upload) on `.pinMissing`. The extension only VERIFIES an existing pin (never runs `establishTrust`).
- **Modified:** ios/Shared/Network/ServerTrustService.swift, ios/Shared/Network/EntryUploader.swift, ios/PasswdSSOApp/Network/MobileAPIClient.swift, ios/PasswdSSOApp/Vault/FaviconLoader.swift, ios/PasswdSSOApp/Auth/{AuthCoordinator,SessionRestorer}.swift, ios/PasswdSSOApp/Views/RootView.swift, ios/PasswdSSOAutofillExtension/CredentialProviderViewController.swift

### F2 [Major] — pin recovery on legitimate TLS-key rotation
- **Action:** Added `.trustMismatch(URL)` state to `ServerURLSetupView`. On a probe failure against an already-pinned server, an explicit destructive "Re-verify server identity" button calls `clearPin` then re-probes. Fail-closed: never auto-clears; requires explicit user tap through a MITM warning.
- **Modified:** ios/PasswdSSOApp/Views/ServerURLSetupView.swift:9-14,56-91,155-179; ios/Shared/Network/ServerTrustService.swift (clearPin, currentPinExists)

### F3/F4/F5 [Minor]
- F3: relaxed `isValidPasswdSSOHealthResponse` (dropped `json.count == 1`; kept `status == "alive"`) to avoid cross-repo lockout when the server adds fields. Tests updated (extra-field accepted, missing/wrong status rejected).
- F4: revoke route maps unsupported `token_type_hint` → `undefined` (RFC 7009 §2.1) instead of the unsafe `as` cast; removed the dead no-op `if` block. Regression test added.
- F5: tightened the `canonicalHtuClient` parity comment (comment-only).

## Round 2 (incremental verification of the fixes)

### Security Round 2
- **M1 [Major] — FIXED:** pin keychain accessibility was `WhenUnlockedThisDeviceOnly` while the paired upload token uses `AfterFirstUnlockThisDeviceOnly`; the autofill read would silently fail mid-ceremony while locked. Aligned the pin to `AfterFirstUnlockThisDeviceOnly` (a pin is a public-key hash, not a secret, so the wider window has no confidentiality cost). Modified: ServerTrustService.swift:111.
- **Mi1 [Minor] — no action:** health-contract relaxation (F3) is a documented, justified forward-compat change; pinning trust anchor is the TLS leaf key, not the health body.
- **Mi2 [Minor] — accepted:** `.trustMismatch` is shown on any probe failure against a pinned server, not only a genuine mismatch (over-warns on transient outages). Accepted as-is: distinguishing a true TLS/pin error from a connectivity error is fragile, and misclassifying toward "just unreachable" is the DANGEROUS direction. The current copy warns "only re-verify if you expected this", and the recovery still requires an explicit tap — fail-closed is preserved. Anti-Deferral: Worst case = a user re-verifies after a transient outage when the pin didn't actually change → re-pins the SAME key (no-op, no security loss). Likelihood = low. Cost-to-fix = medium (fragile error classification). Net: not worth the misclassification risk.

### Functionality Round 2
- **F1 [Critical] — FIXED:** `clearPin` was an actor-isolated synchronous method called without `await` at 3 sites (compile error; one caller is a non-async test that cannot add `await`). Marked `clearPin` and its `baseQuery` helper `nonisolated` — both touch only immutable `let`s (`keychain` (Sendable protocol), `pinService`), no isolated mutable state, so all synchronous call sites compile unchanged. Modified: ServerTrustService.swift:146,239.
- #1-#8 (init ambiguity, `.shared` removal sweep, Shared-move visibility, actor-isolation of faviconSessionFactory, FaviconLoader @MainActor, F2 state machine, clearCache regression, revoke TS) — all verified clean.

## Round 3 (verification of the F1 nonisolated fix)

Focused re-review of the `nonisolated clearPin`/`baseQuery` change — **CLEAN (no findings)**:
- Correctness: `ServerTrustService` has NO `var` stored properties (only `keychain` + `pinService`, both `let`); `KeychainAccessor` is Sendable → `nonisolated` access compiles and is sound.
- No new data race: production `SecItem*` calls are OS-atomic; `FakeKeychain` guards every method (incl. delete) with a single `NSLock`.
- Security invariant intact: `nonisolated` changes only the calling convention (no `await`), not who may call; the 3 call sites are unchanged and explicit (1 user tap + 2 tests). Establish/clear are main-actor-serialized in practice; worst case under any hypothetical concurrency is strictly fail-closed (`pinMissing`), never silent acceptance of a mismatched identity (the handshake delegate independently enforces the leaf-key match).

## Termination

All three review rounds converged: no unresolved Critical or Major findings. Round 3 (verification-only) returned clean. Loop terminated at Round 3.

## Environment Verification Report

Verification environment constraints (recorded here since Phase 1 was skipped — standalone branch review):
- **TypeScript** (`verified-local`): `npx vitest run` (MCP+DPoP suites, 328 passed; revoke 22 passed incl. new F4 case), `npx tsc --noEmit` (0 errors), `npx eslint` on changed files (0 errors).
- **Swift / iOS** (`blocked-deferred`): this reviewer's environment is Linux with no Swift/Xcode toolchain — iOS code cannot be compiled or its XCTest suite run here. Mitigation: all iOS changes were statically cross-checked (import-Shared presence, exhaustive `MobileAPIClient(`/`EntryUploader(` construction sweep confirming every site passes `urlSession:`, actor-isolation reasoning, init-overload resolution) by two independent Round-2 sub-agents plus the orchestrator; the one compile error they surfaced (F1) was fixed. **iOS build + XCTest must be run in Xcode CI before merge** to confirm compilation and the new fail-closed tests (pin-missing, clearPin, redirect-guard accept/reject, health accept/reject).
- **iOS handshake pin-mismatch test** (`blocked-deferred`): `LeafKeyPinningDelegate.didReceive challenge` pin-mismatch branch requires fabricating a `SecTrust`, which is infeasible in XCTest without a live TLS peer (Testing expert Round-1 F1 acknowledged this tradeoff). Covered instead: the plain-value `willPerformHTTPRedirection` guard (accept + both reject paths) and the `pinnedSession`/`clearPin`/`currentPinExists` custody paths.
- **iOS new UI strings** (`blocked-deferred`): the F2 strings ("Re-verify server identity", the trust-mismatch warning) auto-extract into `Localizable.xcstrings` on Xcode build; ja translations must be added after extraction (cannot be hand-edited reliably without the build re-sorting the file).
