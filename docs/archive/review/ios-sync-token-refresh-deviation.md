# Coding Deviation Log: ios-sync-token-refresh

## D1 — EntryFetcherTests.testFetch401PropagatesError expectation updated
- Changed the assertion from `serverError(401)` to `authenticationRequired`.
- Why: a consequence of C3 — a resource 401 with no recoverable token now exhausts the bounded ladder and surfaces auth-dead (`authenticationRequired`), per the locked plan. Not a deviation from the plan; a required test update.

## D2 — PasswdSSOAppApp foreground-sync auth-dead handling
- The `.active` scenePhase handler is not a UI-routing context (no direct sign-in navigation there), so on `authenticationRequired` it returns without rescheduling/registering; the next foreground/unlock through RootView performs the actual sign-in routing. Consistent with C4 intent (don't show stale data / don't loop), implemented at the layer that owns navigation (RootView).

No other deviations — C0–C4 implemented as specified; build clean, 330 tests pass.
