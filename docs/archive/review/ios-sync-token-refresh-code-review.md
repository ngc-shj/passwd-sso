# Code Review: ios-sync-token-refresh

Date: 2026-06-12
Review round: 1

## Changes from Previous Round
Initial code review of the implementation (commit fd1e2385) by 3 experts. All findings Minor/Low/Medium — no Critical. Build clean (warnings-as-errors); 330→331 tests pass after fixes.

## Functionality Findings (F#)
- **F1 (Medium) — RESOLVED.** `HostSyncService.runSync` line 46 `(try? await teamMemberships) ?? []` swallowed `authenticationRequired` → C4 gap (auth-dead on the team path never surfaced). Fixed: typed `do/catch` re-throws `authenticationRequired`, tolerates other (transient) errors as `[]`.
- **F2 (Low) — RESOLVED.** `performAuthedGET` nonce-retry could over-trigger on a *stale stored* nonce when the 401 carried no new nonce (bound → ≤4). Fixed: gate the nonce-retry on `freshNonce` (a nonce present in THIS 401 response), restoring the documented ≤3 bound and matching C3 intent.
- **F3 (Low) — RESOLVED.** `refreshToken()` no-token path threw `serverError(401)`; now throws `authenticationRequired` (correct taxonomy for direct callers; the indirect path already mapped it).
- F4–F10 — informational confirmations (single-flight defer timing correct, ladder bound ≤3, ath rebuild correct, error mapping correct, loadAccess partial-state safe). No action.

## Security Findings (S#)
- **S1 (Medium) — RESOLVED** (= F1). Team-membership `try?` swallowed auth-dead.
- **S2 (Low) — RESOLVED.** Added `// SECURITY: never log this request or its headers` above the `Authorization: DPoP <refresh_token>` line. No active leak existed; this guards future drift.
- **S3 (Low) — RESOLVED.** RootView `authenticationRequired` path now `try? HostTokenStore().deleteAll()` before routing to sign-in (parity with the explicit sign-out path; no stale dead token lingers).
- Confirmed clean: replay/double-refresh (single-flight correct — Task created synchronously before `refreshTask=` assignment, joiners see it at the await suspension), ath binding, persist atomicity (refresh→expiry→access prevents new-access+old-refresh), no secret logging, transient(networkError) NOT mapped to auth-dead, bounded ladder, BackgroundSyncTask reschedule branches.

## Testing Findings (T#)
- **T1 (Medium) — RESOLVED.** Reactive-refresh + refresh-fails tests used `≤` (vacuous-pass risk on zero-refresh); changed to exact `==` (reactive: resource==2/refresh==1; refresh-fails: resource==1/refresh==1).
- **T2 (Low-Med) — RESOLVED.** Sequential single-flight test: explicit `expiresIn: 3600` + corrected comment (fixed clock; new token outside skew → 2nd call skips refresh).
- **T3 (Medium) — RESOLVED.** Write-order test only checked final state; `FakeKeychain` now records a `writeLog` and the test asserts `index(refresh_token) < index(access_token)` on both add and update paths.
- **T4 (Low) — RESOLVED.** Nonce-ladder test now asserts the call-2 DPoP nonce echoes the server nonce from call 1, asserts `resourceCallCount == 3` (≤3 bound), comment corrected for `freshNonce` gating.
- **T5 (Low) — RESOLVED.** Proactive-refresh tests now assert `resourceCallCount == 1`.
- **G1 (gap) — RESOLVED.** New test: a `URLError` from the refresh endpoint surfaces as `MobileAPIError.networkError` (transient), NOT `authenticationRequired` — guards the transient-vs-auth-dead distinction.
- EntryFetcherTests `testFetch401PropagatesError` → `authenticationRequired`: verified correct (reflects the new C3 ladder, not a masked regression).

## Anti-Deferral — accepted with justification
- **G2 (persist-failure during rotation)** — Accepted/skipped. Worst case: a keychain-write failure mid-rotation throws `authenticationRequired` → re-sign-in (safe, fail-closed). Likelihood: very low (keychain writes rarely fail when device unlocked). Cost-to-fix: a fault-injecting FakeKeychain test, ~30 min, low value vs. the fail-closed behavior already covered by the catch. TODO(ios-sync-token-refresh): add fault-injection test if keychain-write failures are ever observed.
- **G3 (fetchTeamEntries C3 ladder test)** — Accepted/skipped. The ladder is shared via `performAuthedGET` and fully covered through `fetchEntries`/`fetchVaultUnlockData`; a per-method test adds little. Functionally covered.

## Recurring Issue Check
### Functionality
R5/R9 (async race): single-flight verified correct. R25 (persist order): refresh→expiry→access. Forbidden pattern: `loadAccess()` only in validAccessToken/ensureRefreshed (grep-confirmed).
### Security
RS1 (token storage accessibility unchanged), RS2 (rotation replay — single-flight + persist-order; server multi-instance grace tracked as out-of-scope follow-up), RS3 (no new logging; comment added), RS4 (auth-dead propagation now complete incl. team path).
### Testing
RT1 (URL-routing mock, separate counters, realistic TokenExchangeResponse), RT2 (no untestable suggestions adopted; C4 sign-in routing left to manual), RT3 (clock seam + ≥2s margins), RT4 (exact `==` counts), RT5 (per-test reset).

## Resolution Status — all Round-1 findings resolved; build clean, 331 tests pass.
