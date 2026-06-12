# Coding Deviation Log: ios-sync-token-refresh

## D1 — EntryFetcherTests.testFetch401PropagatesError expectation updated
- Changed the assertion from `serverError(401)` to `authenticationRequired`.
- Why: a consequence of C3 — a resource 401 with no recoverable token now exhausts the bounded ladder and surfaces auth-dead (`authenticationRequired`), per the locked plan. Not a deviation from the plan; a required test update.

## D2 — PasswdSSOAppApp foreground-sync auth-dead handling
- The `.active` scenePhase handler is not a UI-routing context (no direct sign-in navigation there), so on `authenticationRequired` it returns without rescheduling/registering; the next foreground/unlock through RootView performs the actual sign-in routing. Consistent with C4 intent (don't show stale data / don't loop), implemented at the layer that owns navigation (RootView).

No other deviations — C0–C4 implemented as specified; build clean, 330 tests pass.

## D3 — POST-PR fix: sign-in bounce loop (device-reported regression)
- Symptom (device): after signing in, the app returned to the sign-in screen (loop).
- Cause: C4 routed `MobileAPIError.authenticationRequired` from the unlock-time `runSync` to sign-in + `HostTokenStore.deleteAll()`. authenticationRequired was being raised too eagerly: the C3 ladder threw it even when the **refresh SUCCEEDED but the resource still returned 401** (a resource/authorization-level rejection, NOT a dead session), and F1 re-threw it from the tolerated team-membership path. mobile access-token TTL is 24h, so this was a reactive-401 path, not expiry.
- Fix:
  1. C3 ladder: a persistent 401 *after a successful refresh* now throws `serverError(401)` (transient), not `authenticationRequired`. Only `ensureRefreshed` failing (dead refresh token) yields `authenticationRequired`.
  2. C4 (RootView unlock path): made NON-DESTRUCTIVE — any `runSync` failure (incl. auth) falls back to the persisted cache; no token wipe, no `appState=.setup`, no bounce. The token-refresh (C1) still makes the sync succeed across a normal expiry. A genuinely dead refresh token now surfaces as stale data (recoverable via manual Sign Out) instead of an abrupt mid-unlock bounce.
  3. Added a non-secret `os_log` of an unlock-time sync failure (Console.app) to pin the underlying cause if data still does not refresh on a device.
- The "auth-dead → automatic re-sign-in" UX from the original C4 is intentionally dropped on the unlock path (it was harmful); can be re-added later as a gentle non-destructive banner if desired.
- 331 tests pass; build clean.
