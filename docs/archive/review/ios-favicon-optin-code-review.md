# Code Review: ios-favicon-optin
Date: 2026-06-24
Review round: 1

## Changes from Previous Round
Initial Phase 3 review (incremental on the Phase 2 self-R-check baseline).

## Functionality Findings
- **F-5 — Major (REJECTED on verification)**: claimed `setFaviconPref` inline DPoP PUT lacks the token-refresh/401 ladder that `updateEntry` has → silent failure on token expiry. **Verified false** (MobileAPIClient.swift): `setFaviconPref` uses `performBodyHTTP(request){newNonce in …}` with a nonce-retry closure, structurally IDENTICAL to `updateEntry`'s `performVoidHTTP(request){newNonce in …}`. Both do nonce-retry on 401, neither does token-refresh-retry; staleness is handled upfront by `validAccessToken()` (proactive refresh within skew). `setFaviconPref` is consistent with the established, tested mutation pattern — no failure path `updateEntry` lacks. Rejected per "do not override tested behavior with a general heuristic."
- **F-1 — Minor**: VaultListView.onAppear calls `resolveShowFavicons()` before `FaviconLoader.configure()`. On unlock, a LOGIN+opt-in row can render while `FaviconLoader.shared` is nil → globe shown until configured. Cosmetic (recovers on next render), but a 2-line reorder fixes it. ACCEPTED.
- **F-3 — Minor**: EntryDetailView reads `AppSettingsStore().fetchFaviconsCached` locally rather than receiving `showFavicons` from the parent (C7). Detail icon won't update if the user toggles the setting while detail is open. ACCEPTED (align to C7).
- F-4 (List cell-reuse): VERIFIED CLEAN — FaviconImageView uses `.task(id: host)`, re-fetches on host change. No reuse bug.
- F-6 (EntrySummaryRow call sites): VERIFIED CLEAN — all call sites pass showFavicons.
- F-7 (checklist cross-check): all checklist files present in the diff.

## Security Findings
**No findings.** All 8 novel checks verified clean in the implementation:
- S-1 RLS opt-in read: userId+tenantId both from the same validated token; withTenantRls scopes correctly; cross-tenant read impossible.
- S-2 favicon-pref PUT: cross-tenant write blocked by RLS (update where:{id} under tenantId GUC).
- S-3 shared rate-limit bucket (web+mobile rl:favicon:<userId>): intentional per route comment; cosmetic 429 at worst, not a vuln.
- S-4 URLCache cross-user: favicon bytes are public (per-host, same for all); signOut clears (disk removeItem); no cross-user window.
- S-5 SVG/MIME: server Set exact-match excludes svg; iOS hasPrefix("image/")&&!contains("svg"); UIImage rejects SVG. Double defense.
- S-6 token/DPoP: Bearer+DPoP to our server only; ath = sha256(accessToken) correct; no third-party token send.
- S-7 enforceAccessRestriction: applied on all 3 handlers, correct order (token→clientKind→IP→business).
- S-8 info-leak: clientKind 403 fires BEFORE opt-in check, so non-IOS_APP can't learn opt-in state.

## Testing Findings
- **T-1 — Minor**: setFaviconPref(false) path untested (only true). ACCEPTED — add symmetric test.
- **T-2 — Minor**: getFaviconPref→false path untested (only true). ACCEPTED — add symmetric test.
- **T-3 — Minor**: FaviconLoaderTests.faviconURL(host:size:) helper ignores its params (always returns the base path; MockURLProtocol matches all URLs so tests pass). Latent/misleading. ACCEPTED — remove unused params or build the real query.
- RT4 single-flight test: VERIFIED genuinely falsifiable (asserts validateAndFetch called exactly once across 3 concurrent misses).
- T10 R1 import-check: VERIFIED non-tautological (spyOn proxy module, asserts called).
- RT7 key-consistency: VERIFIED falsifiable after Phase 2 fix (reads via literal key).
- success path testImage_200_minimalPNG_returnsNonNil: VERIFIED asserts non-nil with a real 1×1 PNG.

## Adjacent Findings
None requiring routing.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R8 (UI consistency): Checked — EntryIconView badge ≡ CategoryCard badge (cornerRadius size*0.22, white glyph on accent).
- R25 (persist/hydrate): Checked — fetchFaviconsCached default false, round-trip tested.
- R26 (no blank icon): Checked — every path returns a symbol or globe.
- R39 (signOut clear): Checked — signOut calls faviconCacheClearing, lock does not; disk removeItem present.
- R1-R7, R9-R24, R27-R38, R40-R41: covered by Phase 2 self-check; no new miss.
### Security expert
- RS2 (no secret logging): Checked — no host/token logging. RS3 (MIME strict): Checked — server Set + iOS double-check.
- R14 (RLS on all DB access): Checked — 2 findUnique + 1 update all withTenantRls-wrapped.
- R39: Checked. RS1/RS4/RS5: N/A (no credential compare / new schema). RS-rest: clean.
### Testing expert
- RT1 (mock-reality): Checked — token mock shape matches (cnfJkt unused → benign). RT4: Checked (falsifiable). RT5 (reset placement): Checked (beforeEach/setUp). RT6 (pref methods tested): Checked (gaps = T-1/T-2). RT7: Checked (falsifiable).

## Environment Verification Report
Phase 1 declared VEC-1..VEC-4. Status this round:
- VEC-1 (favicon render in a List row): blocked-deferred — SwiftUI body render on device; manual plan. (Phase 1 constraint VEC-1.) The image() network *behavior* (401/404/non-image→nil, 200+PNG→non-nil) is verified-local: FaviconLoaderTests pass.
- VEC-2 (on-disk cache eviction timing): blocked-deferred — device timing; the clear *wiring* (signOut spy + disk removeItem) verified-local (AutoLockServiceTests + testClearCacheRemovesDiskDirectory pass).
- VEC-3 (toggle live re-render): blocked-deferred — SwiftUI reactivity; the read/write + GET/PUT bootstrap verified-local (AppSettingsStoreTests + MobileAPIClientTests pass).
- VEC-4 (e2e DPoP favicon round-trip on device): blocked-deferred — needs a real device + server; the server route auth/opt-in/host logic is verified-local (vitest route tests pass; 85 green).
All blocked-deferred paths link to their Phase 1 VEC entry; the deferral is the documented device/server-only limit, not an un-justified skip.

## Resolution Status
### F-5 Major (setFaviconPref missing refresh ladder) — REJECTED
- Verified setFaviconPref uses performBodyHTTP(request){newNonce in …}, structurally identical to the tested updateEntry performVoidHTTP pattern; both nonce-retry on 401, staleness handled by validAccessToken(). No failure path updateEntry lacks. No spec/attack vector given. Rejected per the tested-behavior-override rule.

### F-1 Minor (configure ordering → globe flash) — FIXED
- Reordered VaultListView.onAppear to call FaviconLoader.configure() before resolveShowFavicons(). File: VaultListView.swift:150-158

### F-3 Minor (EntryDetailView local store read, not C7-reactive) — FIXED
- Added `var showFavicons: Bool = false` to EntryDetailView; threaded from both call sites; removed the local AppSettingsStore() read. Files: EntryDetailView.swift:20,117 + VaultListView.swift:348 + VaultCategoryLanding.swift:108

### T-1/T-2 Minor (pref false-path untested) — FIXED
- Added testGetFaviconPref_returnsFalse + testSetFaviconPref_false_putBodyAndEcho. File: MobileAPIClientTests.swift

### T-3 Minor (FaviconLoaderTests.faviconURL ignored params) — FIXED
- Dropped the unused host/size params. File: FaviconLoaderTests.swift:70

### Verification
- iOS: 611 tests pass (xcodebuild TEST SUCCEEDED). Server untouched by these fixes (85 vitest remain green).
