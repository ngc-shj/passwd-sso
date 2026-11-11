# Code Review: share-link-expiry-grace
Date: 2026-11-12
Review round: 1

## Changes from Previous Round
Initial review (incremental on top of the Phase 2 self R-check, which fixed R48 expiry-boundary alignment and RT3 shared time constants). Local LLM pre-screening and seeds unavailable (Ollama down); all experts did full-diff review.

## Functionality Findings
- F1 [Minor] Legacy CLI credentials without `serverUrl` skip old-session revocation at login (`cli/src/commands/login.ts` `revokeExistingSession`, `cli/src/lib/config.ts` `loadCredentials`). — Accepted (see Resolution Status).

Implementation Checklist cross-check: every listed file is in the diff.

## Security Findings
No Critical/Major.
- S-m1 [Minor] `share_links` quota (`src/lib/quota/resource-quotas.ts`) counts expired rows during the grace window. — Accepted (plan C3 decision).
- S-m2 [Minor] Extension token not structurally bound to its issuer URL; `storage.onChanged` can arrive after a settings read that already sees the new URL. — Fixed.
- S-m3 [Minor] ESLint ILIKE selector misses quoted keys. — Merged into T-1, fixed.

## Testing Findings
- T-1 [Major] ESLint insensitive-equals rule has no automated test; quoted keys bypass it. — Fixed.
- T-2 [Minor] Extension server-change negative assertions wait a fixed 50 ms with no positive control. — Fixed.
- T-3 [Minor] Approve expired-reset 409 comes from the mocked `updateMany` count; `gt: expect.any(Date)` is weak. — Fixed.
- T-4 [Minor] Race tests are SQL twins; the route-level pin lives in unit tests. — Fixed (header documents it).

## Adjacent Findings
- (Security) CLI OAuth requests follow redirects by default: a 307/308 would resend the refresh token / code to another host. Pre-existing; same class as C7 (credential reaching a server other than its issuer). — Fixed, with class sweep (CLI, extension; iOS already confines redirects to the pinned host).

## Quality Warnings
None. The Security and Testing experts summarised R-rule ranges instead of one line per rule; their findings carried file/line evidence, so the outputs were accepted.

## Recurring Issue Check
### Functionality expert
R1–R57 one line per rule; findings: R25 → F1. All others Checked or N/A (see expert output: R1–R3, R5, R7, R9, R10, R17–R22, R29, R34, R36–R40, R42, R43, R48–R52 Checked; remainder N/A).

### Security expert
R1–R57, RS1–RS6 checked; findings: S-m1 (quota/read-path), S-m2 (binding/TOCTOU), S-m3 (gate spelling). Others clean.

### Testing expert
R1–R57 no findings except R42 (T-1). RT1–RT6 ok; RT7 T-1, T-3; RT8–RT11 ok.

## Environment Verification Report
- VE1 (real-DB integration tests need the racing workers stopped): verified-local — `docker compose stop audit-outbox-worker retention-gc-worker` then `ANCHOR_TEST_S3_ENDPOINT=http://127.0.0.1:9000 npm run test:integration` (150 files, exit 0); workers restarted.
- iOS: verified-local on the macOS build host (`xcodebuild … test`, TEST SUCCEEDED).

## Resolution Status
### T-1 / S-m3 [Major] ESLint ILIKE rule untested; quoted keys bypass it
- Action: selector matches identifier and quoted keys in both orders; `scripts/__tests__/eslint-insensitive-equals.test.mjs` lints through the real config (both orders, quoted, nested, components block, scripts) plus four negatives.
- Modified files: `eslint.config.mjs`, `scripts/__tests__/eslint-insensitive-equals.test.mjs`

### S-m2 [Minor] Extension token not bound to its issuer
- Action: the token now carries the issuing server (`currentIssuerUrl`, persisted in the session; sessions without it are not restored). Every request carrying it, the refresh, and every revoke go to the issuer; a configured URL that differs ends the connection instead of sending (`tokenServerUrl`).
- Pre-existing defect surfaced by the fix and fixed with it: a token refresh still in flight when the connection ended (logout, CLEAR_TOKEN, server change) re-installed the token from its response; its late 401 could also clear a newer connection. `attemptTokenRefresh` now captures `connectionGeneration` and every mutating callback (`setToken`, `setCnfJkt`, `clearToken`, `scheduleRefreshAlarm`, `createTtlAlarm`) is a no-op once it changed.
- Modified files: `extension/src/background/index.ts`, `extension/src/background/token-handler.ts`, `extension/src/lib/session-storage.ts`
- Tests: `extension/src/__tests__/lib/session-storage.test.ts`, `extension/src/__tests__/background/swFetch-dpop.test.ts`, `extension/src/__tests__/background/start-connect.test.ts`, `extension/src/__tests__/background.test.ts` (issuer binding without an onChanged event, hydration, refresh at issuer, in-flight refresh after disconnect, late 401 vs newer connection). Red-proved: 13 fail against HEAD's three production files; 4 fail with the generation guard neutralised.

### T-2 [Minor] Fixed sleeps before negative assertions
- Action: the 50 ms sleeps are gone; each negative waits for the specific async step (controlled promise release / `vi.waitFor` on the step after it) or a one-macrotask drain where the work is microtask-only, and each has a positive control.
- Modified file: `extension/src/__tests__/background.test.ts`

### Adjacent [—] OAuth/token requests followed redirects
- Action: `redirect: "error"` on CLI DCR/code-exchange/refresh/revoke (`cli/src/lib/oauth.ts`), extension bridge-code/exchange (`extension/src/background/token-handler.ts`) and every DPoP-authenticated request (`extension/src/background/dpop-fetch.ts`, set after the caller's init so it cannot be overridden). iOS: `LeafKeyPinningDelegate` already refuses redirects off the pinned https host — not a member.
- Tests: `cli/src/__tests__/unit/oauth.test.ts`, `extension/src/__tests__/background/start-connect.test.ts`, `extension/src/__tests__/background/swFetch-dpop.test.ts`

### T-3 [Minor] Weak approve expired-reset assertion
- Action: fake `Date` pinned; the CAS `gt` is asserted equal to the request's clock.
- Modified file: `src/app/api/tenant/members/[userId]/reset-vault/[resetId]/approve/route.test.ts`

### T-4 [Minor] Race tests are SQL twins
- Action: file header names the route unit tests that pin lock-before-read.
- Modified file: `src/__tests__/db-integration/concurrent-grant-serialization.integration.test.ts`

### F1 [Minor] Legacy CLI credentials skip revocation at login — Accepted
- **Anti-Deferral check**: acceptable risk
- **Justification**:
  - Worst case: a refresh token minted before this change stays valid server-side until it expires after the user re-logs in (the user's own token; it never leaves their machine because legacy credentials are no longer loaded or sent anywhere).
  - Likelihood: medium — every CLI user upgrading once.
  - Cost to fix: the issuer of a legacy file is unknowable; revoking at the configured `serverUrl` is exactly the leak C7 closes (the configured URL may be a different server). No safe fix exists without the issuer.
- **Orchestrator sign-off**: acceptable-risk exception satisfied; the user can revoke stale CLI sessions from the web app.

### S-m1 [Minor] share_links quota counts expired rows — Accepted
- **Anti-Deferral check**: acceptable risk
- **Justification**:
  - Worst case: a user who creates more than `QUOTA_MAX_SHARE_LINKS_PER_USER` (default 1000) shares within (lifetime + 30 days) is refused new shares until rows age out.
  - Likelihood: low — 1000 shares per ~month per user; the quota exists to stop storage exhaustion (C18 / A04-1).
  - Cost to fix: trivial in code, but it would let expired-but-retained rows (which occupy storage, incl. FILE Send blobs) escape the storage-exhaustion control — the plan (C3) deliberately keeps them counted.
- **Orchestrator sign-off**: acceptable-risk exception satisfied; plan C3 records the decision.
