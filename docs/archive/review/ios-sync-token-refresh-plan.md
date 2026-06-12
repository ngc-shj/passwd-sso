# Plan: ios-sync-token-refresh

## Objective

Fix the bug where **web-updated vault data is not reflected on iOS after unlocking** — the user must sign out and sign back in to see updates. Make `runSync` succeed across an access-token expiry by wiring up the (already-implemented but unused) token refresh, and stop silently hiding sync failures.

## Confirmed root cause (evidence)

- The read/sync path uses the stored access token with **no expiry check and no refresh**. `MobileAPIClient.fetchEntries` (and `fetchVaultUnlockData`, `fetchTeamEntries`, `fetchTeamMemberships`) throw on HTTP 401 with no retry: `guard let (accessToken, _) = try tokenStore.loadAccess()` discards `expiresAt`; `case 401: throw`.
- `MobileAPIClient.refreshToken()` is fully implemented (POST `/api/mobile/token/refresh`, `Authorization: DPoP <refresh_token>`, DPoP proof `ath = SHA256(refresh_token)`) but **never called in production** (only a dead `BackgroundSyncCoordinator` stub + a test call it).
- On unlock, `RootView.swift:~255` runs `let syncReport = try? await syncService.runSync(...)` — the **401 is swallowed by `try?`**, falling back to the stale persisted cache.
- Sign-out/sign-in works only because `AuthCoordinator.startSignIn` mints a **fresh** token pair.
- `HostTokenStore` already stores `access_token`, `refresh_token`, `access_token_expiry` (ISO-8601), and `dpop_nonce`. Server `/api/mobile/token/refresh` **rotates** the pair and has **replay detection** (reusing a revoked refresh token revokes the family).

## Project context

- Type: native iOS app (Swift 6 strict concurrency, warnings-as-errors). `MobileAPIClient` is an `actor`.
- Test infra: XCTest. `MobileAPIClientTests` exists (uses a mockable `URLSession`/URLProtocol seam — to confirm in impl).
- Scope: host-app networking only. Does NOT touch passkeys, the AutoFill extension, or 指摘1 (AutoFill lock-misdetection — separate branch).

## Contracts

### C0 — Error taxonomy + clock seam (prerequisites)

- Add `case authenticationRequired` to `MobileAPIError`. Thrown ONLY when a refresh attempt definitively fails (no refresh token, or the refresh endpoint rejects with 401 / `dpopInvalid`) — i.e. the refresh token itself is dead and the only recovery is re-sign-in. A plain `serverError(status: 401)` from a single resource call (after a successful-looking token) stays "transient" for the caller.
  - NOTE (F4/S8): the refresh path currently surfaces a refresh-endpoint 401 as `MobileAPIError.dpopInvalid(newNonce: nil)` via `decodeResponse` (`MobileAPIClient.swift:~604`). The refresh primitive (C2) MUST translate that into `.authenticationRequired` so C4 can detect auth-dead reliably. Do not rely on `serverError(401)` for auth-dead.
- Add an injectable clock to `MobileAPIClient.init`: `now: @Sendable () -> Date = { Date() }`, stored as `private let now`. `validAccessToken()` compares against `now()` (NOT `Date()` directly) so expiry/skew is deterministically testable (T2). Mirrors the existing `now` seam in `DPoPProofBuilder`/`CredentialResolver`.

### C1 — Proactive refresh: `validAccessToken()`

```swift
/// Returns a non-expired access token. If the stored token is missing →
/// throws .authenticationRequired. If within `refreshSkewSeconds` of expiry →
/// refreshes through the single-flight gate (C2) and returns the new token.
private func validAccessToken() async throws -> String
```

- Logic: `loadAccess()` → nil ⇒ throw `.authenticationRequired`. If `expiresAt > now() + refreshSkew` (skew = 60s) ⇒ return token. Else ⇒ `return try await ensureRefreshed(staleToken: token)` (C2 single-flight).
- Replace `guard let (accessToken, _) = try tokenStore.loadAccess() else { throw 401 }` with `let accessToken = try await validAccessToken()` in ALL authenticated methods: `fetchEntries`, `fetchVaultUnlockData`, `fetchTeamEntries`, `fetchTeamMemberships` (the extension in `HostSyncService.swift`), `postCacheRollbackReport`, `createEntry`, `updateEntry`.
- **Reads vs writes (clarifies the C1/C3 boundary)**: the C1 proactive token-load replacement applies to ALL of the above (reads AND writes) — every authed call gets a non-expired token. The C3 *reactive 401 ladder* (nonce→refresh→retry) is added to the READ/sync methods only; writes (`createEntry`/`updateEntry`) keep their existing DPoP-Nonce retry and rely on C1 for expiry (the reactive refresh rung on writes is optional defense-in-depth, not required).
- **Invariant**: the access token is never used past `expiresAt` without a refresh attempt.

### C2 — Single-flight refresh + safe persist (REPLACES the flawed "actor serialization" claim)

**Why single-flight (F1/S4 — blocking):** a Swift `actor` does NOT hold its executor across an `await`. `refreshToken()` awaits the network, so two callers that both see an expired token (e.g. `HostSyncService.runSync` launches `fetchPersonal` → `fetchEntries` AND `fetchTeamMemberships` via `async let` concurrently, `HostSyncService.swift:42-43`) will BOTH reach `refreshToken()` and send the SAME refresh token. The server rotates on the first and **revokes the whole family on the second (replay detection)** → silent forced logout. "Reload-from-store" does not help because both load before either persists.

```swift
/// Single-flight refresh gate. If a refresh is already in flight, joins it.
/// If the stored token already differs from `staleToken` (someone else just
/// rotated), returns the fresh stored token WITHOUT refreshing. Otherwise runs
/// exactly one refresh, persists, and returns the new access token.
private var refreshTask: Task<String, Error>?
private func ensureRefreshed(staleToken: String) async throws -> String
```

- Implementation shape:
  - If `let task = refreshTask` exists ⇒ `return try await task.value` (join the in-flight refresh).
  - Re-read `loadAccess()`; if the stored access token != `staleToken` ⇒ a rotation already happened ⇒ return the stored token (no refresh). This covers the C3 reactive path where several requests 401 on the old token.
  - Else create `let task = Task { try await self.doRefreshAndPersist() }`, assign `refreshTask = task`, `defer { refreshTask = nil }`, `return try await task.value`.
- `doRefreshAndPersist()`: `let r = try await refreshToken(); try persist(r); return r.accessToken`. If `refreshToken()` throws (401/dpopInvalid/no refresh token) ⇒ throw `.authenticationRequired`.
- **`persist(_:)` safe write order (S3/R25 — blocking-ish):** `HostTokenStore.saveTokens` writes 3 keychain items non-atomically; a crash mid-write must NOT leave a new access token paired with an OLD refresh token (→ next refresh reuses the revoked old refresh → family revoke). Change `saveTokens` to write **refresh_token FIRST, expiry SECOND, access_token LAST**, so any partial write leaves (new-or-old refresh) ≥ (access epoch) — the refresh token is never older than the access token. `persist()` uses `now()` for `expiresAt = now() + r.expiresIn` (mirrors `AuthCoordinator.swift:106`).
- **Invariant**: at most ONE refresh network call per rotation epoch, regardless of how many concurrent requests see the stale token.

### C3 — Reactive 401 refresh-retry (read/sync methods) — explicit ladder

For the read methods with no retry today (`fetchEntries`, `fetchVaultUnlockData`, `fetchTeamEntries`, `fetchTeamMemberships`), define an explicit, bounded ladder (≤ 3 HTTP calls per logical request):

1. Initial request with the (proactively-valid) token.
2. On **401**: the server sends `DPoP-Nonce` on nearly every response (RFC 9449), so presence of the header is NOT a reliable "nonce vs token" discriminator (F2/S2). Therefore:
   - If a `DPoP-Nonce` header is present AND we have not yet retried for nonce ⇒ re-sign the SAME token with the new nonce, retry once (nonce challenge).
   - If still 401 (or no nonce header) ⇒ treat as token-rejected ⇒ `let newToken = try await ensureRefreshed(staleToken: usedToken)` (C2 single-flight, dedup-safe), **rebuild the DPoP proof with `ath = sha256Base64URL(newToken)`** and a fresh nonce, retry once.
3. Still 401 ⇒ throw (`.authenticationRequired` if the refresh itself failed; else `.serverError(401)`).

- The reactive refresh MUST go through `ensureRefreshed(staleToken:)` so concurrent 401s do not double-refresh (S4).
- `ath` on the retry MUST bind to the NEW access token, not the captured-at-entry value (F8/S6).
- Writes (`createEntry`/`updateEntry`) keep their existing DPoP-Nonce retry; expiry is covered by C1 proactively. Adding the refresh rung to writes is optional defense-in-depth (note in impl, not required).
- **fetchTeamMemberships fix (F3):** the extension in `HostSyncService.swift` currently (a) does NOT save the response `DPoP-Nonce`, and (b) lumps all non-200 into one `throw`. Bring it in line with the other read methods: save the nonce, use `validAccessToken()`, and apply this ladder.
- **Forbidden pattern**: `pattern: loadAccess\(\)` should appear ONLY inside `validAccessToken()`/`ensureRefreshed` after this change (no authed method reads the token directly).

### C4 — Surface sync failure (stop silent swallow)

- `RootView.swift:~255`, `PasswdSSOAppApp.swift:~56`, AND `BackgroundSyncTask.swift:~77` (F5) currently swallow/ignore `runSync` failure. Replace with explicit handling keyed on the C0 error taxonomy:
  - **`MobileAPIError.authenticationRequired`** (refresh token dead) ⇒ foreground call sites route to re-sign-in (the only recovery — makes today's manual "sign out/in" automatic). `BackgroundSyncTask` ⇒ do NOT reschedule (no UI; a dead refresh token won't recover by retrying); log and complete.
  - **Any other error** (transient network/5xx, single resource 401) ⇒ keep the cached data (existing fallback) + non-blocking signal (log; optional lightweight "showing cached data" indicator). Do NOT force sign-in on a transient error (availability).
- `HostSyncService.runSync` must propagate `authenticationRequired` (today `fetchTeamMemberships` is wrapped in `try?` at `HostSyncService.swift:~46` — a team-membership auth-dead would be swallowed; decide: an auth-dead on ANY authed call should surface as `authenticationRequired` from `runSync`).
- **Acceptance**: after the access token expires, unlocking refreshes and shows up-to-date data with no sign-out; if the refresh token is also dead, the app routes to sign-in rather than silently showing stale data.

## Testing strategy

**Test-infra prerequisites (must land before the tests, T1/T2):**
- **Clock seam (T2)**: `MobileAPIClient.init(now:)` injected (C0). Tests seed `expiresAt` relative to a fixed `now`. Use margins ≥ 2 s around the 60 s skew boundary because `HostTokenStore` stores expiry as whole-second ISO-8601 (T7): "within skew" = `now + 30`, "outside skew" = `now + 120`.
- **URL-routing mock (T1)**: `MockURLProtocol.requestHandler` must branch on `request.url?.path` with SEPARATE counters (`refreshCallCount`, `resourceCallCount`) — a single shared `callCount` cannot prove "refresh hit exactly once" vs "resource retried" (vacuous-pass risk, RT4). Accumulate `capturedRequests: [URLRequest]` (not a single var) so reactive-retry tests can inspect BOTH the initial and retried DPoP proofs (T4).

**`MobileAPIClientTests`:**
- `validAccessToken` returns stored token when not expired ⇒ `refreshCallCount == 0`.
- `validAccessToken` refreshes + persists when expired ⇒ `refreshCallCount == 1`, store now holds the new pair.
- `validAccessToken` throws `.authenticationRequired` when no token (empty store), and when the refresh endpoint returns 401 (T5 case b — distinct from the no-token case T5 case a).
- `fetchEntries`: 200 happy; expired token → one proactive refresh → 200; 401-without-recovery → reactive refresh+retry → 200; refresh endpoint itself 401s → throws `.authenticationRequired` with NO further retry (bounded).
- **Reactive `ath` rebuild (T4)**: decode the DPoP payload of `capturedRequests[0]` (initial) and the retried request; assert `ath` changed from `SHA256(old)` to `SHA256(new)`.
- **Single-flight / replay-safety (T3)**: two SEQUENTIAL `await fetchEntries(...)` with an expired token ⇒ `refreshCallCount == 1`, `resourceCallCount == 2`, both return data (non-vacuous). (Sequential await makes the actor single-flight observable; `async let` parallel is also worth a test but the assertion is the same `refreshCallCount == 1`.)
- DPoP-Nonce-then-token ladder: 401+nonce → nonce-retry → still 401 → refresh-retry → 200 (assert `refreshCallCount == 1` and nonce was re-signed first).
- `HostTokenStore.saveTokens` safe-order test: simulate a partial write (fail after refresh+expiry, before access) via the fake keychain and assert the stored refresh token is the NEW one (never new-access + old-refresh).
- **C4 scope (T6/RT2)**: routing `RootView` → sign-in is NOT unit-testable (SwiftUI `@State`, no ViewInspector). Unit-test only that `HostSyncService.runSync` PROPAGATES `.authenticationRequired` (via `MockKeychain`); the `RootView`/`PasswdSSOAppApp` sign-in routing is a **manual smoke-test** item.
- `HostTokenStore` expiry round-trip already covered; extend only for the new write order.
- Run `xcodebuild ... test` green + device smoke test (manual-test doc): unlock after the access-token TTL elapses → data refreshes without sign-out; with a revoked refresh token → app routes to sign-in (not stale data).

## Considerations / out of scope

- Concurrency/replay is the main risk — mitigated by **single-flight refresh** (C2 `ensureRefreshed`) + safe persist order, NOT by actor serialization alone (an actor releases its executor across `await`, so serialization is insufficient — see C2 rationale).
- BGTask background sync benefits automatically (it calls `runSync` → `fetchEntries` → `validAccessToken`); on `authenticationRequired` it must not reschedule (C4).
- **Known residual (server-side, OUT OF SCOPE for this iOS branch) — S1**: the server's refresh-rotation replay-grace cache (`rotationCache` in `src/lib/.../mobile-token.ts`) is an in-process `Map`, so on a multi-instance deployment a refresh whose response is lost in transit (server committed, client never received) can, on retry against a different instance, be treated as a replay and revoke the family → forced re-login. The iOS-side mitigations here (single-flight + safe persist + graceful `authenticationRequired` → sign-in) minimize client-induced double-refresh and make recovery graceful, but they cannot fix the lost-response-after-commit edge. **File a separate server follow-up** to back the rotation grace with Redis (keyed by old-refresh-token hash, TTL = grace window). Not a blocker for this branch.
- Out of scope: 指摘1 (AutoFill "locked" misdetection), passkeys, any server-side change.
- Clock skew: `refreshSkewSeconds = 60` proactively refreshes slightly early; C3 catches a token rejected despite a not-yet-expired local clock.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C0 | Error taxonomy (`authenticationRequired`) + injectable clock | locked |
| C1 | Proactive `validAccessToken()` on all authed methods | locked |
| C2 | Single-flight refresh (`ensureRefreshed`) + safe persist order | locked |
| C3 | Reactive 401 ladder (nonce→refresh, bounded ≤3, new-`ath`) on read/sync methods incl. fetchTeamMemberships | locked |
| C4 | Surface sync failure (auth-dead → sign-in; transient → cached) across all 3 runSync sites | locked |

Locked after 2 plan-review rounds. Round-1 blockers (F1/S4 single-flight, F2/S2 ladder, F4/S8 error type, F3 fetchTeamMemberships, S3 persist order, T1/T2 test infra) all resolved; Round-2's sole "blocker" (N1, BackgroundSyncTask success path) was a misread — verified the code already calls `setTaskCompleted(success: true)` on success. S1 (server in-process rotationCache, multi-instance) tracked as a separate server follow-up, out of scope.
