# Code Review: extension-sw-hydration-timeout

Date: 2026-06-12
Review rounds: 2 (Round 2 clean — only non-blocking LOW observations)
Branch: fix/extension-sw-hydration-timeout

## Summary

The MV3 service worker's `handleMessage` did `await hydrationPromise` (unbounded).
If `hydrateFromSession()` wedges (IndexedDB/crypto), GET_STATUS hangs forever and
the popup spins. The fix bounds the message-handler wait (`awaitHydrationBounded`,
5s); the alarm path stays unbounded (a delayed token refresh is harmless, and
proceeding early there could clear a token mid-hydration).

## Changed files
- `extension/src/background/index.ts`
- `extension/src/__tests__/background.test.ts`

## Round 1 findings & resolution

Functionality: No blocking findings. Security PR-A side: No findings.

### S1 [Major] Late-completing hydration resurrects state a message just mutated — RESOLVED
- Bounding the message wait let a message (LOCK_VAULT, CLEAR_TOKEN) run before
  hydration finished; the late-completing `hydrateFromSession()` then
  unconditionally overwrote the mutation — e.g. re-deriving `encryptionKey` after
  an explicit LOCK_VAULT (vault silently unlocked again), or restoring a token
  after CLEAR_TOKEN. Fail-open relative to the user's security action.
- Fix: a module-level `hydrationSuperseded` flag set by the authoritative mutators
  (`applyToken`, `clearVault` — reached by clearToken and all lock/logout paths,
  and the UNLOCK_VAULT success path). `hydrateFromSession()` checks it at every
  resume-after-await point (after loadSession, getDpopThumbprint,
  deriveEncryptionKey, unwrapEcdhPrivateKey) and bails rather than overwrite.
  The flag is read only inside the single startup hydration, so the never-reset
  design cannot block a later operation.
- Regression test: LOCK_VAULT during a slow (parked-at-deriveEncryptionKey)
  hydration → GET_STATUS reports vaultUnlocked:false. **Verified load-bearing**
  (the test fails — vault key resurrected — when the encryptionKey guard is
  disabled).

### F2 [Minor] Bounded-wait safety rested on an undocumented invariant — RESOLVED
- Addressed by the S1 fix plus the `hydrationSuperseded` doc comment that makes
  the bounded/unbounded asymmetry and the "no-resurrect" invariant explicit.

### T2 [Minor] Hydration-hang test used a loose matcher — RESOLVED
- Added `expiresAt: null` to the GET_STATUS assertion to pin the not-hydrated
  contract.

## Round 2 (incremental verification of the S1 fix) — clean

Security/functionality/testing review of the guard: all interleavings of an
authoritative mutator vs the slow hydration confirmed to leave the mutator's
state intact (no resurrection); no remaining un-guarded await-resume write; flag
read only in the one-shot hydration; happy path unchanged; the regression test is
correct, non-flaky, load-bearing, with clean teardown. Full suite 79/0.

Non-blocking LOW observations (not fixed — out of scope / optional):
- **F-b**: UNLOCK arriving during a >5s-slow hydration leaves the token without a
  TTL/refresh alarm until the next SW restart (self-healing; lazy `Date.now() >=
  tokenExpiresAt` expiry still applies). Not introduced by S1; follow-up candidate.
- **T-c**: No dedicated CLEAR_TOKEN-resurrection test; the structurally identical
  guard path is covered by the LOCK_VAULT test.

## Verification
- `npx vitest run` (extension) — 750 passed
- `npm run build` (extension) — success
