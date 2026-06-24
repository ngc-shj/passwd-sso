# Code Review: favicon-proxy-optin
Date: 2026-06-24
Review rounds: 2

## Changes from Previous Round
Round 1: Phase 3 code review (3 expert sub-agents) + two external (user-run) review passes. Findings: F1 (Major, toggle hydration), T1/T3 (Minor, test), S-EXT1 + S-EXT2 (High, SVG same-origin re-serve on ingestion then cache-hit paths). All fixed.
Round 2: incremental verification of the Round-1 fixes (security + func/test reviewers). Each fix reverted to confirm its guarding test goes fail-red, then restored. **Result: No findings — all fixes verified correct, complete, and fail-red.** Review loop terminates.

## Functionality Findings
- **F1 [Major]** — `src/app/[locale]/dashboard/settings/account/profile/page.tsx:19-20`. The toggle captured `session.user.fetchFavicons` into `useState` once at mount, but the session resolves AFTER first paint (SessionProvider has no server-seeded session), so an opted-IN user loading/refreshing the settings page saw the toggle stuck OFF (R25 hydrate gap at the UI layer). → FIXED: added `useEffect` re-syncing from the resolved session ([status, session?.user?.fetchFavicons]); destructured `status`.
- **F2 [Minor, →T9]** — no test rendered the profile toggle; the T9 optimistic-update test was unimplemented and would have caught F1. → FIXED: added `profile/page.test.tsx` (F1 regression + opted-out + optimistic-PUT + rollback). F1 regression test verified fail-red.

## Security Findings
- **S-EXT1 [High] — SVG re-served same-origin (XSS vector)** — `src/app/api/user/favicon/route.ts`. Surfaced by an external (user-run) review; the three triangulate experts missed it. The proxy accepted any `image/*` (`ct.startsWith("image/")`) and re-served it under the app's own origin. `image/svg+xml` is active content (can embed `<script>`); API responses carry `nosniff` but deliberately NOT CSP / X-Frame-Options (`security-headers.ts:21-22`), so opening `/api/user/favicon?...` for an SVG directly executes script in the app origin. The repo already classifies SVG as active content in the Sends path (`sends/file/route.ts:122,130`), confirming the model. → FIXED: added `isAllowedFaviconMime()` (inert raster/icon allowlist — png/jpeg/webp/gif/x-icon/vnd.microsoft.icon/bmp/avif; SVG and everything else rejected → 204), applied in the route. Tests: route `image/svg+xml`→204 (verified fail-red against the old `startsWith` check) + charset-param case; direct `favicon-proxy.test.ts` unit tests for the allowlist. escalate: false (single-route fix, clear inert-MIME allowlist, no chained trust boundary).

- **S-EXT2 [High] — SVG fix incomplete: cache-hit path bypassed the MIME guard** — `src/app/api/user/favicon/route.ts:80`. Second external review round: the S-EXT1 fix only guarded the fresh-fetch (ingestion) path; the cache-hit path returned `faviconResponse(cached.body, cached.contentType)` with no MIME check. An SVG already in Redis/memory (seeded by the pre-allowlist `startsWith("image/")` code, or any future cache poisoning) would keep being re-served same-origin. → FIXED: apply `isAllowedFaviconMime(cached.contentType)` on the SERVING boundary too — NG cache entry → 204. Regression test seeds an `image/svg+xml` entry via `setCachedFavicon` and asserts GET → 204 (verified fail-red). escalate: false.

The 10 invariants below were verified clean against the actual code:
SSRF (strict host allowlist + IP-literal reject; outbound host always t1.gstatic.com, user host only a query param); no redirect-follow; 403-when-OFF fires before fetch/cache/log; Buffer pool-aliasing fix (Uint8Array.from); D6 stream cap aborts mid-stream; no host logged (withRequestLog = pathname only); C8 both paths SESSION_REQUIRED + not Bearer-bypass; C4 strict schema; fail-open dual limiters; D6 refactor did not weaken the inbound request cap (readBytesWithCap content-length pre-check + noStream fail-closed preserved).

## Testing Findings
- **T1 [Minor, real safety value]** — `readStreamWithCap` (new export, D6) tested only transitively; its defining mid-stream `reader.cancel()` abort (the reason D6 exists over arrayBuffer-then-check) was asserted nowhere — a buffer-then-reject regression would stay green. → FIXED: added a direct `readStreamWithCap` describe block; the cancel-on-overflow test feeds an unbounded pull source and asserts `cancel()` ran + bounded pulls. Verified fail-red (buffer-then-check mutation hangs/times out).
- **T2 [Minor]** — favicon-pref INVALID_JSON test's `vi.spyOn(req,"json")` is decorative (no Content-Length → fallback branch skipped). Established convention copied from locale test (plan T10 endorsed it); outcome (400 INVALID_JSON) verified regardless. → Accepted (Anti-Deferral: pre-existing convention, worst case = a dead spy line, cost-to-change trivial but project-consistent as-is; same latent issue tracked in locale test).
- **T3 [Minor]** — favicon.test.tsx asserted `referrerPolicy` which the plan (F4) declared inert/optional. → FIXED: dropped the assertion (replaced with an explanatory comment).

## Adjacent Findings
F2 [Adjacent func→test] routed to Testing (T9) — resolved together.

## Recurring Issue Check (incremental — Phase 2 self-R-check was the rote baseline)
- Functionality: R25 newly relevant → F1 (UI-layer hydrate gap), fixed. Implementation Checklist cross-check: all 17 files present in diff. No other R-rule newly violated.
- Security: RS1-RS5 + SSRF/redirect/logging/classification all re-verified clean in code.
- Testing: RT6 → T1 (new export readStreamWithCap untested directly), fixed. RT1 mock shapes match real signatures. RT7 single-flight + pool-aliased + F1-regression all verified fail-red.

## Environment Verification Report
- VEC1 (outbound favicon fetch to real third-party): unit tests mock validateAndFetchBuffered (`verified-local`); real upstream confirmed via an ad-hoc real-network smoke test (github.com favicon → 200 image, no ClientDestroyedError) and is covered by manual-test M3 (`verified-local`, ad-hoc). End-to-end browser path = manual-test M1-M5, user-confirmed.
- VEC2 (SSRF DNS fixture against inner host): N/A for the current fixed-provider shape (the inner host is only a query param to t1.gstatic.com; never the connection target). SC3 records that a future direct-host provider swap must route the inner host through resolveAndValidateIps.

## Resolution Status
### F1 [Major] toggle stuck OFF for opted-in users
- Action: added useEffect re-sync from resolved session; destructured `status`.
- File: src/app/[locale]/dashboard/settings/account/profile/page.tsx:15-29
### F2/T9 [Minor] no profile-toggle test
- Action: added profile/page.test.tsx (4 tests incl. F1 fail-red regression).
### T1 [Minor] readStreamWithCap mid-stream-cancel untested
- Action: added direct readStreamWithCap tests (under-cap + cancel-on-overflow); verified fail-red.
- File: src/lib/http/parse-body.test.ts
### T3 [Minor] referrerPolicy coupling
- Action: dropped the inert-attribute assertion.
- File: src/components/passwords/shared/favicon.test.tsx:64
### T2 [Minor] decorative INVALID_JSON spy — Accepted
- Anti-Deferral check: out-of-scope (different feature / pre-existing convention).
- Justification: copied verbatim from locale/route.test.ts (plan T10 explicitly endorsed); the asserted 400 INVALID_JSON outcome holds regardless of the dead spy. Worst case: one decorative line; Likelihood: n/a (no behavior); Cost-to-fix: trivial but diverges from the established project pattern. Tracked alongside the same latent issue in locale test.
- Orchestrator sign-off: accepted as out-of-scope convention; no behavior impact.
