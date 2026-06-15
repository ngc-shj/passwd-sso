# Plan Review: ios-signin-flow-ux

Date: 2026-06-14
Review rounds: 2 full (functionality / security / testing) + 1 security confirmation
Outcome: **converged — all Critical/Major findings resolved; remaining items accepted with quantified justification.**

## Scope reviewed
Plan: [ios-signin-flow-ux-plan.md](./ios-signin-flow-ux-plan.md) — launch-time session restoration to skip the URL + Sign-in screens for returning users, remove the DEBUG "Load Test Vault" path, and remove the post-unlock passphrase-screen flicker.

## Round 1 findings & resolution

### Functionality
- **F1 (Minor)** — C3 `makeSession` must `await` the actor-isolated `currentSigner()/currentJWK()`. → Fixed in C3 wiring text.
- **F4 (Major)** — Scenario 6 (tokens, no bridge key) is NOT offline-recoverable; plan's acceptance over-claimed "list reachable". → Scenario 6 reworded: offline shows a network error (pre-existing).
- **F5 (Minor)** — Use `guard case .launching = appState else { return }`, not `if case`. → Fixed in C5.
- **F11 (Minor)** — `try?` on `loadAccess()` in `hasTokens` is intentional. → Documented in C3.
- **F12 (Minor)** — The single `switch appState` (RootView:42) must gain `.launching`/`.unlocking` arms (compile-enforced). → Listed explicitly in C4 invariant.
- F6–F10 — verified correct (Task survives view teardown; no `.task`/autoprompt race; `validAccessToken` makes no network call when valid; `handleVaultUnlocked` does not bounce to sign-in on sync failure; `BackgroundSyncCoordinatorTests.signedIn` is a different enum).

### Security
- **S1 (Major)** — Dead-session routing to `.signIn` skipped the tenant-policy + QuickType cleanup that the `.loggedOut` path performs. → Round 1 added an eager-cleanup design; **superseded by the S7 resolution in round 2** (see below). Final disposition: launch does NOT wipe; residual accepted (quantified in Considerations).
- **S2 (Minor)** — SE host DPoP key has no biometric gate; launch-time silent refresh signs without user presence. By design, not a regression; required for offline launch; vault key separately gated. → Documented as accepted trade-off.
- **S5 (Major, pre-existing)** — `ServerConfig.pinnedAASAHash/pinnedTLSSPKIHash` are always nil; TOFU pinning is modeled but never implemented, so skipping the setup probe bypasses no enforced control. → `TODO(ios-signin-flow-ux)` follow-up; out of scope.
- **S3, S4 (Minor)** — Leaving a server-revoked refresh token in Keychain, and offline self-vault read by a revoked user, both analyzed acceptable (server-side family-revoke + per-app Keychain + short access-token TTL; offline reads only the user's own cached data). → Accepted.

### Testing
- **T1f (Critical)** — `loadDPoPKey` filters on `kSecAttrTokenIDSecureEnclave`; simulator software keys are invisible, so `loadPersistedSigner()`'s found-branch was untestable. → C1 now injects a `keyLoader` seam; T3 injects a software-key loader.
- **T2f (Major)** — The offline `.networkError` test must throw a concrete `URLError`, not an `NSError` (else it silently validates the dead-session path). → Mandated in C2 acceptance + T2.
- **T4 (Major)** — Deleting `DebugVaultLoaderTests` would remove the only end-to-end `CredentialResolver` decrypt round-trip coverage. → C6 now KEEPS `DebugVaultLoader` + its test; removes only the button/wiring.
- **T1f2/T1f3 (Major/Minor)** — Add a distinct `makeSession`-nil fixture; the call-count spy must be a reference type (`@Sendable` capture). → Added to T1.

## Round 2 findings & resolution

- **S7 (Critical)** — `doRefreshAndPersist` collapses 5xx, 429, and genuine 401 all into `.authenticationRequired` (verified MobileAPIClient.swift:512-523), so the round-1 `validate` could not distinguish a transient server blip from a dead session — and the eager `.deadSession` cleanup would then **irreversibly wipe tenant policy + QuickType for a still-valid session** on a single 500/503/429 at launch. The agent's "catch `.serverError` in validate" fix was itself incorrect (validate never sees `.serverError` — already remapped upstream). → **Resolution: drop the eager cleanup entirely.** Launch routes `.dead` → `.needsSignIn` non-destructively (matching the existing `.vaultLocked` "Sign in again" precedent, which also doesn't wipe). Cleanup stays on the explicit Sign-Out path; tenant policy + QuickType refresh on the next unlock. This also moots round-2 **T5/T6** (no untested security-relevant cleanup branch remains).
- **S8 (Minor)** — 429 same bug class as S7. → Subsumed by the S7 resolution.
- **S9 (Info)** — `dpopInvalid`→re-auth at launch is conservative but acceptable. → Documented.
- **F13 (Minor)** — Move the non-empty-label `precondition` to `init` (not per-call in `loadPersistedSigner`). → Fixed in C1.
- **F14 (Minor)** — `SecKey` is not `Sendable`; the `keyLoader` closure may trip strict concurrency. → C1 notes the Phase-2 check + the existing `SendableSecKey`/`@unchecked Sendable` precedent.
- **F15 (Minor)** — After C6 the `VaultViewModel:56` comment implies two production cache writers. → C6 now adjusts the comment to mark `DebugVaultLoader` as a test fixture.
- Round-1 fixes all re-verified correct (await idiom matches existing `buildRealAPIClient`; `guard case`; exhaustive-switch; keyLoader seam; offline `.dead` cannot be produced when offline — traced).

## Round 3 (security confirmation of S7 resolution)
- **S7 resolved, no new findings.** Removing the eager cleanup fully eliminates the irreversible-state-loss path. Critically verified that **no new credential-delivery hole** is introduced by leaving stale QuickType identities: the `ASCredentialIdentityStore` holds only metadata (host/username/record-UUID, no secrets), `provideCredentialWithoutUserInteraction` always returns `userInteractionRequired`, and the fill path gates on a fresh Face ID/Touch ID challenge (`BridgeKeyStore.readForFillAuthenticated`) before any blob is decrypted. A stale identity cannot deliver a credential without the device owner's biometric auth.

## Post-review user decisions (folded into the plan, not left as TODOs)
- **Launch routing for refresh-failure** — the dead-vs-transient signal is irreducibly ambiguous at launch (refresh ladder collapses 5xx/429/401 → `.authenticationRequired`). Decision (user-chosen): `.dead` routes to **`.needsReauth` → `.vaultLocked`** (the existing unlock-or-resign-in screen), NOT to the OAuth sign-in screen. This serves both cases — a transient `5xx` recovers via local biometric unlock + next-sync retry; a genuine revoke uses the screen's "Sign in again" button. A new `RestoredSession.needsReauth` case distinguishes "has local unlock material" (tokens+signer → `.vaultLocked`) from "no local material" (`.needsSignIn` → OAuth). The `.vaultLocked` "Sign in again" button is re-pointed from `.setup` to `.signIn` (skip URL). No destructive cleanup in any arm (S7). The earlier "transient bounces to OAuth" wart is eliminated — no launch-routing TODO remains.
- **TOFU pinning (S5)** — carved out into its own plan (`ios-tofu-pinning`, to be created); orthogonal security feature, pre-existing, not regressed by this change.

## Accepted (anti-deferral record)
- **S1 residual** — stale QuickType suggestions + stale tenant policy persist for a genuinely-revoked session until next sign-out/unlock. Worst case: the user's *own* credential metadata shows as inline suggestions on their own device; no secret delivered without biometric auth (`BridgeKeyStore.readForFillAuthenticated` gate); tenant policy + QuickType refresh on next unlock; explicit Sign Out clears both. Likelihood: only between server-revoke and next user event. Cost to fix properly: high (de-conflate 5xx from 401 deep in the shared refresh ladder, rippling through all `performAuthedGET` callers). → Accepted; matches existing `.vaultLocked` precedent.

## Go/No-Go
All 6 contracts (C1–C6) **locked**. C3's `RestoredSession` final shape adds `.needsReauth(ServerConfig, MobileAPIClient)` (the user-chosen launch-routing fork) alongside `.needsSetup` / `.needsSignIn(ServerConfig)` / `.needsUnlock(ServerConfig, MobileAPIClient)`. Plan is ready for Phase 2 implementation.
