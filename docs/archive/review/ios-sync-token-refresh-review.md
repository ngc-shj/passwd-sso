# Plan Review: ios-sync-token-refresh

Date: 2026-06-12
Review rounds: 2

## Round 1 (full) — 3 experts (functionality / security / testing)

Blocking/Major findings and resolutions (all applied to the plan):

- **F1 / S4 — Critical — RESOLVED.** "actor serialization + reload-from-store" does NOT prevent double-refresh (an actor releases its executor across `await`; `HostSyncService.runSync` launches `fetchPersonal`→`fetchEntries` AND `fetchTeamMemberships` concurrently via `async let`). Two callers would both call `refreshToken()` with the same refresh token → server replay detection revokes the family → forced logout. → C2 rewritten to a **single-flight `ensureRefreshed(staleToken:)`** (in-flight `refreshTask` + re-read "already rotated ⇒ skip" guard).
- **F2 / S2 — High — RESOLVED.** DPoP-Nonce is present on nearly every response (RFC 9449), so "no nonce = token rejected" is not a valid discriminator. → C3 rewritten as an explicit bounded ladder (≤3 HTTP calls): 401+nonce → nonce-retry once → still 401 → single-flight refresh + rebuild `ath` with the NEW token → retry once → else throw.
- **F4 / S8 — High — RESOLVED.** No auth-dead error type; refresh-endpoint 401 surfaces as `dpopInvalid`, not `serverError(401)`. → C0 adds `MobileAPIError.authenticationRequired`; C2's refresh primitive translates refresh failures (no-token / 401 / dpopInvalid) into it; C4 keys off it.
- **F3 — High — RESOLVED.** `fetchTeamMemberships` (extension in HostSyncService.swift) lacked nonce-save and lumped all non-200 into one throw. → folded into C1 (`validAccessToken`) + C3 ladder + nonce save.
- **F5 — Medium — RESOLVED.** `BackgroundSyncTask.swift` is a third `runSync` site. → C4 includes it (no reschedule on `authenticationRequired`).
- **F6 / S3 / R25 — High — RESOLVED.** `HostTokenStore.saveTokens` writes 3 keychain items non-atomically, currently access-first (worst order: a crash leaves new-access + old-refresh → next refresh replays the revoked old token). → C2 mandates write order **refresh → expiry → access** so the refresh token is never older than the access token.
- **S1 — Critical (escalate) — OUT OF SCOPE (server follow-up).** Server rotation replay-grace cache is an in-process `Map`; multi-instance + lost-response-after-commit can revoke the family. iOS-side single-flight + safe persist + graceful `authenticationRequired`→sign-in minimize and make recovery clean, but the server fix (Redis-backed grace) is a separate server task. Documented in Considerations.
- **S5 — Medium — NOTE.** Refresh token travels in `Authorization: DPoP <refresh_token>` (per the route contract; DPoP-bound). No active leak found; add a "never log this header" comment in impl.
- **S6 / F8 — Low — RESOLVED.** C3 explicitly requires rebuilding `ath = SHA256(newAccessToken)` on the reactive retry.
- **T1 — High — RESOLVED.** Mock needs per-URL routing + separate `refreshCallCount`/`resourceCallCount` + `capturedRequests: [URLRequest]` (single shared counter is vacuous). Documented as a test-infra prerequisite.
- **T2 — High — RESOLVED.** `MobileAPIClient` had no clock seam. → C0 adds `now: @Sendable () -> Date` to init; `validAccessToken` uses `now()`.
- **T3/T4/T5/T6/T7 — Medium/Low — RESOLVED.** Testing section: sequential-await single-flight test, capture both DPoP proofs for `ath`, split persistent-401 into no-token vs refresh-401, C4 sign-in routing is manual-only (RootView `@State` not unit-testable — unit-test only that `runSync` propagates `authenticationRequired`), ≥2 s margins around the skew boundary (whole-second ISO-8601 expiry).

## Round 2 (convergence) — consolidated

- All Round-1 blockers verified resolved against the revised contracts and the real code.
- **N1 (Round-2 "Critical") — REJECTED (misread).** Claimed `BackgroundSyncTask.swift:78` calls `setTaskCompleted(success: false)` on the success path. Verified the actual code calls `setTaskCompleted(success: true)` on success (line 78) and `false` only in the `catch`. The agent misread (and self-corrected mid-finding). No change needed.
- **Non-blocking nit — RESOLVED.** Clarified the C1/C3 reads-vs-writes boundary: C1 proactive token replacement applies to all authed methods; the C3 reactive ladder is reads-only (writes keep existing nonce-retry + rely on C1 for expiry).

Result: all contracts `locked`; proceeding to implementation.

## Recurring Issue Check (salient)
- R9 / R5 (async race): the double-refresh race (F1/S4) is the core finding — resolved via single-flight.
- R25 (persist/hydrate symmetry): rotated refresh token must be persisted before the old one becomes the live pair's partner — resolved via write order (C2).
- RS2 (replay protection): server family-revoke-on-replay is the threat the single-flight + persist-order defend against client-side.
- RT1/RT3/RT4 (mock-reality / flaky / vacuous): clock seam + URL-routing mock + separate counters (C0 + test infra).
