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
- VE1 (real-DB integration tests need the racing workers stopped): verified-local — `docker compose stop audit-outbox-worker retention-gc-worker` then `npm run test:integration` with `ANCHOR_TEST_S3_ENDPOINT` set to the local MinIO (150 files, exit 0); workers restarted.
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

---

# Round 2
Date: 2026-11-12

## Changes from Previous Round
Incremental review of the Round 1 fixes (commit 2a3e0ba98): extension issuer binding, in-flight refresh generation guard, OAuth/DPoP `redirect: "error"`.

## Functionality Findings
- F2 [Major] The options page's "reset connection" sent the token and a DPoP proof to the configured URL, not to the token's issuer (`extension/src/options/App.tsx` `handleResetConnection`). — Fixed (same finding as S2-m2).
- F3 [Minor] CLI bearer requests outside `oauth.ts` followed redirects (`cli/src/lib/api-client.ts` `apiRequest`, `cli/src/commands/env.ts`, `cli/src/commands/run.ts`). — Fixed (same finding as T6).

## Security Findings
- S2-m1 [Minor] A token with no recorded issuer fell back to the configured URL for requests, refresh and revoke (`tokenServerUrl`, `getValidServerUrl`). — Fixed.
- S2-m2 [Major] = F2. — Fixed.
- S2-m3 [Minor] `swFetchWithExpiryRetry` resolved the issuer before its awaits (host permission, proof signing); a disconnect and reconnect meanwhile paired the new token with the old issuer. — Fixed.

## Testing Findings
- T5 [Major] `background.test.ts` failed under shuffle seeds 1794419690957 / 1794419775221. — Not reproduced: serial runs with both seeds and 424242 exit 0, full suite exit 0. The reviewer ran against a tree mid-way through the S2-m1 change (481 tests then failed on fixtures without an issuer); no leaking state was found.
- T6 [Minor] = F3. — Fixed.
- T7 [Minor] The control cases of "a refresh in flight when the connection ends" used a one-macrotask settle. — Fixed.

## Quality Warnings
None.

## Resolution Status
### F2 / S2-m2 [Major] Reset connection sent the token to the configured URL
- Action: GET_TOKEN returns the token's `issuerUrl`; the options page validates it and sends the proof and request only when it equals the configured server, with `redirect: "error"`; otherwise nothing is sent and the status shows an error.
- Modified files: `extension/src/background/index.ts`, `extension/src/types/messages.ts`, `extension/src/options/App.tsx`
- Tests: `extension/src/__tests__/options/App.test.tsx` (issuer matches → request to issuer with redirect error; null / different issuer → no fetch, no proof, IDB key kept). Red-proved against 2a3e0ba98.

### S2-m1 [Minor] Token without an issuer fell back to the configured URL
- Action: `applyToken` requires the issuer; `tokenServerUrl` and `tokenIssuerServerUrl` (refresh, revoke) refuse a null issuer; the server-change revoke no longer falls back to the previous configured URL (a token whose issuer is unknown is revoked nowhere — the F1 decision for the CLI, applied to the extension). `getConfiguredServerUrl` is left only for bridge-code/exchange, which run before a token exists.
- Modified files: `extension/src/background/index.ts`, `extension/src/background/token-handler.ts`
- Tests: `extension/src/__tests__/background.test.ts` ("never sends a restored token that has no recorded issuer"; "on a server change, a restored token revokes it at its issuer / nowhere when it has no recorded issuer"), `extension/src/__tests__/background/swFetch-dpop.test.ts` (refresh and revoke with a null issuer send nothing). Each red-proved against the previous implementation on a throwaway copy.

### S2-m3 [Minor] Issuer resolved before the pre-send awaits
- Action: `swFetchWithExpiryRetry` captures `connectionGeneration` before resolving the issuer and re-checks it (and the issuer) immediately before sending.
- Modified file: `extension/src/background/index.ts`
- Test: `extension/src/__tests__/background.test.ts` ("a reconnect while the request waits for the host permission", with a no-reconnect control). Red-proved.

### F3 / T6 [Minor] CLI bearer requests followed redirects
- Action: `redirect: "error"` on `apiRequest`, `env` and `run` fetches.
- Modified files: `cli/src/lib/api-client.ts`, `cli/src/commands/env.ts`, `cli/src/commands/run.ts`

### T7 [Minor] One-macrotask settle in control cases
- Action: the controls wait with `vi.waitFor` on their observable outcome (TTL alarm created; `hasToken` false).
- Modified file: `extension/src/__tests__/background.test.ts`

### R42 class C7 closure (credential reaching a non-issuer or following a redirect)
- The member set expanded three times (Round 1 adjacent finding, F2, F3). Closed by the mutation-verified CI guard `scripts/checks/check-client-credential-fetch.mjs` (AST, ts-morph): every `fetch` in `cli/src` and `extension/src` must pin `redirect` to `"error"` or `"manual"` after any spread, an unclassified fetch reference fails, and an `Authorization` header in `extension/src` is allowed only in `dpop-fetch.ts` and `options/App.tsx`. Self-test `scripts/__tests__/check-client-credential-fetch.test.mjs`. Red-proven: removing `redirect: "error"` from the refresh fetch in `cli/src/lib/oauth.ts` → exit 1. Wired in `scripts/pre-pr.sh` ("Static: client-credential-fetch"), which the ci.yml static-checks job runs.
