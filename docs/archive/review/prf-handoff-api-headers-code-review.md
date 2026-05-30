# Code Review: prf-handoff-and-api-headers (PR #502)

Date: 2026-05-30
Review round: 1
Branch: security/prf-handoff-and-api-headers

## Changes from Previous Round

Initial review (Phase 3 standalone, no plan). Triangulate three-expert review of the
two pre-v1.0 security follow-ups: ① PRF login+unlock hand-off moved from sessionStorage
to an in-memory module channel; ② baseline security headers applied to API routes.

## Summary

All three experts independently converged on the same Critical defect: the PRF migration
(①) was **incomplete**. Only one of the two passkey sign-in writers was migrated to the
in-memory channel, and the consumer gate that decides whether to auto-unlock was left
reading the now-never-written sessionStorage keys. The API-header change (②) is correct
and complete.

## Functionality Findings

### F1/S2 [Critical] — Consumer gate still reads sessionStorage → discoverable-passkey auto-unlock dead + in-memory PRF lingers uncleared
- File: src/components/vault/vault-lock-screen.tsx:162-167
- Evidence: `hasStoredPrf = !!(sessionStorage.getItem("psso:prf-output") && sessionStorage.getItem("psso:prf-data"))`; passkey-signin-button.tsx:82 now writes via `stashPrf`, never to those keys.
- Problem: For the discoverable-passkey flow (migrated to `stashPrf`), nothing writes those sessionStorage keys → `hasStoredPrf` is always false → `unlockWithStoredPrf()` (which calls `takePrf()`) is never invoked. Auto-unlock is silently dead, and the in-memory `pending` is never consumed → cleared-on-read invariant defeated, PRF material held for the whole session.
- Fix: Gate on a non-consuming `hasPrf()` peek into the in-memory channel instead of sessionStorage.

### F2/S1 [Critical] — Security-key (email) sign-in still writes PRF to sessionStorage → XSS exposure NOT removed + spurious unlock error
- File: src/components/auth/security-key-signin-form.tsx:20-21,94-96
- Evidence: `SS_PRF_OUTPUT`/`SS_PRF_DATA` constants + `sessionStorage.setItem(SS_PRF_OUTPUT, hexEncode(prfOutput))` / `setItem(SS_PRF_DATA, JSON.stringify(verifyData.prf))` unchanged on this branch.
- Problem: The email/security-key flow still persists PRF output + PRF-wrapped key to sessionStorage — the exact XSS exposure prior finding ① set out to remove. Combined with F1's gate, this path triggers `hasStoredPrf=true` → `unlockWithStoredPrf` → `takePrf()` empty → returns false → lock screen shows `unlockError`. And nothing now removes those keys → stale secret material accrues.
- Fix: Migrate to `stashPrf({ prfOutputHex: hexEncode(prfOutput), prfData: verifyData.prf })`, drop the two constants and setItem calls (mirror passkey-signin-button.tsx).

### F4 [Minor] — Stale "sessionStorage" wording in unlockWithStoredPrf docstring
- File: src/lib/vault/vault-context.tsx:654-657
- Fix: Update docstring to "handed off in-memory during sign-in".

## Security Findings

(S1, S2 merged into F2/F1 above — same root cause, security severity confirmed Critical.)
- S1 escalate: true (multi-step WebAuthn auth flow, security-state boundary, R3 propagation gap)
- S2 escalate: true (chained with S1; wrong fix re-introduces sessionStorage or leaves in-memory secret uncleared)

### S3 [Info] — docs claim sessionStorage PRF keys gone while code still uses them
- Resolved once F1+F2 fixed; then remove all `psso:prf-output`/`psso:prf-data` references.

Security expert confirmed (no finding): server-side module-state leak NOT possible
(prf-handoff.ts imported only by "use client" components; stashPrf only in event handlers);
takePrf nulls on read; prfOutput.fill(0) preserved; no PRF logging; HSTS derives from
AUTH_URL env (not spoofable); Referrer-Policy strict-origin-when-cross-origin not too loose;
all API response paths in handleApiAuth receive baseline headers (no bypass).

## Testing Findings

### T1 [Major] — unlockWithStoredPrf / takePrf consumer path has zero coverage
- File: src/lib/vault/vault-context.tsx:659-774; vault-context.test.tsx (none)
- Fix: Add renderHook tests: success (stash → unlock true → 2nd call false) + null-fallback (no stash → false, status unchanged).

### T2 [Major] — passkey-signin-button test asserts fictional prfData shape (RT1 mock-reality divergence)
- File: src/components/auth/passkey-signin-button.test.tsx:106-119
- Evidence: test uses `prf: { wrappedKey, iv }`; real shape is `{ prfEncryptedSecretKey, prfSecretKeyIv, prfSecretKeyAuthTag }` (verify route + PrfHandoff + unlockWithStoredPrf).
- Fix: Use real field names in the mocked verify response and the stashPrf assertion.

### T3 [Major] — proxy.ts applying baseline headers to API responses not tested at orchestrator level
- File: src/proxy.ts:20-23; src/__tests__/proxy.test.ts (untouched)
- Fix: Add a proxy() API-route test asserting `X-Content-Type-Options: nosniff` + Referrer-Policy on the response.

### T4 [Minor] — baseline-suite HSTS branch coverage gap
- File: src/lib/proxy/security-headers.test.ts
- Fix: Add a baseline-suite assertion that HSTS is null in the default (HTTP) test env. True-side (isHttps) is import-time constant; do not force a brittle module mock.

## Recurring Issue Check

### Functionality expert
- R1: PASS (applyBaselineSecurityHeaders single source; stashPrf is the intended shared util)
- R3: FAIL → F1, F2 (incomplete propagation of sessionStorage→stashPrf migration)
- R25: FAIL → old persist keys still written/read after boundary moved in-memory

### Security expert
- RS1: PASS / RS2: FAIL (S1/S2) / RS3: N/A / RS4: PASS (headers)
- R3: FAIL (S1/S2) / R25: FAIL / R36: PASS

### Testing expert
- RT1: FAIL → T2 / RT2: OK (surface testable) / RT3: Minor (folded into T2) / RT4: FAIL (producer↔consumer untested) / RT5: OK
- R7: FAIL (no E2E passkey/PRF auto-unlock test exists) / R19: OK

## Resolution Status

### F1/S2 [Critical] Consumer gate read sessionStorage → auto-unlock dead + uncleared in-memory PRF
- Action: Added non-consuming `hasPrf()` peek to prf-handoff.ts; vault-lock-screen.tsx gate now `if (hasPrf())` instead of sessionStorage probe. Preserves "PRF present but unlock fails → error" vs "no PRF → silent manual fallback".
- Modified: src/lib/auth/prf-handoff.ts:34-36, src/components/vault/vault-lock-screen.tsx:11,162-165

### F2/S1 [Critical] Security-key sign-in still wrote PRF to sessionStorage
- Action: Migrated security-key-signin-form.tsx to `stashPrf(...)`; removed SS_PRF_OUTPUT/SS_PRF_DATA constants and both setItem calls; kept prfOutput.fill(0) + webauthn-signin flag. Migrated its test to assert stashPrf.
- Modified: src/components/auth/security-key-signin-form.tsx:18,92-97; security-key-signin-form.test.tsx

### F4 [Minor] Stale "sessionStorage" docstring
- Action: Updated unlockWithStoredPrf docstring to "handed off in-memory during sign-in".
- Modified: src/lib/vault/vault-context.tsx:655

### T1 [Major] unlockWithStoredPrf/takePrf path untested
- Action: Added 2 tests (real-crypto unlock round-trip + single-use consume; null-fallback) using wrapSecretKeyWithPrf — no mock-policy violation.
- Modified: src/lib/vault/vault-context.test.tsx

### T2 [Major] passkey test fictional PRF shape (RT1)
- Action: Replaced `{wrappedKey, iv}` with real `{prfEncryptedSecretKey, prfSecretKeyIv, prfSecretKeyAuthTag}` in mock + assertion.
- Modified: src/components/auth/passkey-signin-button.test.tsx

### T3 [Major] proxy-level baseline-header wiring untested
- Action: Added proxy() test asserting nosniff + Referrer-Policy present, CSP/X-Frame-Options absent on API response.
- Modified: src/__tests__/proxy.test.ts

### T4 [Minor] baseline HSTS branch coverage
- Action: Added baseline-suite assertion (HSTS null on default HTTP env).
- Modified: src/lib/proxy/security-headers.test.ts

### S3/F3 [Info] docs claimed PRF keys gone while code used them
- Action: Resolved transitively — after F1+F2, no PRF material touches sessionStorage; existing docs now accurate.

## Round 2 — verification (inline; sub-agent API transiently 529)
- F1/S2 gate fix: hasPrf() confirmed non-mutating peek; error semantics preserved; no TOCTOU (single effect tick). VERIFIED.
- F2/S1 migration: zero `psso:prf-*`/`SS_PRF` in non-test code; both sign-in producers use stashPrf. VERIFIED.
- Server-side leak: all 4 consumers are "use client". VERIFIED.
- R3 propagation: only 2 sign-in→handoff producers exist (both migrated); other startPasskeyAuthentication callers consume PRF in-place (unlock/reauth/settings), need no hand-off. VERIFIED.
- Regression: hasPrfPasskeys (state) ≠ hasPrf (import); webauthn-signin one-shot consumption intact. VERIFIED.
- Verification: 124 targeted tests + 29/29 pre-pr gates pass.

**Verdict: Round 2 all Round-1 fixes verified, no new findings. Review complete.**
