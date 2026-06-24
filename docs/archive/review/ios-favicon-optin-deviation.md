# Coding Deviation Log: ios-favicon-optin

## D1 — FaviconLoader.shared lazy wiring via configure()
- **Plan**: C9 sketched `static let shared: FaviconLoader`.
- **Actual**: `FaviconLoader.shared` is `Optional`, nil until
  `FaviconLoader.configure(apiClient:serverURL:)` is called post-unlock from
  `VaultListView.onAppear`. `AutoLockService`'s default closure uses optional
  chaining `FaviconLoader.shared?.clearCache()`.
- **Reason**: `MobileAPIClient` + `serverURL` only exist after unlock; a static
  `let` constructed at launch can't get them. Lazy configure is the correct
  lifecycle. No contract weakened — `image()`/`clearCache()` are no-ops when
  unconfigured (pre-unlock there is nothing to fetch or clear anyway).

## D2 — setFaviconPref builds its own DPoP PUT (not a shared mutation helper)
- **Plan**: C2 client said "use the existing authed-PUT pattern".
- **Actual**: `setFaviconPref` builds the DPoP proof + PUT request inline
  (mirroring createEntry/updateEntry's pattern) since there was no single generic
  authed-PUT helper to reuse for a tiny JSON body.
- **Reason**: matches the existing per-endpoint mutation style in MobileAPIClient;
  extracting a generic helper was out of scope. R1-acceptable (follows the
  established local pattern rather than inventing a new abstraction).

## D3 — No Prisma migration (fetchFavicons already exists)
- **Plan**: implied a server `User.fetchFavicons` read/write.
- **Actual**: the column was already added by #603 (schema.prisma:124); this PR
  only consumes it. `check-migration-drift` passes (57 tables consistent). The
  iOS plan correctly treated it as a shared, pre-existing column.

## D4 — FaviconLoader.init gained an optional serverURL/session for tests
- `FaviconLoader.init(apiClient:serverURL:session:)` exposes injectable
  serverURL + session so FaviconLoaderTests can drive it with a MockURLProtocol
  session + seeded HostTokenStore (T12). Production path uses the configured
  defaults. Test-enabling seam, no production behavior change.

## Self-R-check findings (Phase 2-5) and disposition
- **RT6-A (Medium)**: getFaviconPref/setFaviconPref untested → FIXED (added MobileAPIClientTests).
- **RT7-A (Low)**: fetchFaviconsCached key-consistency test read via the aliased constant (tautological) → FIXED (read via literal "fetchFaviconsCached" so a setter-vs-constant drift fails).
- **RS3 #1 (Low, security)**: FaviconLoader MIME check `contains("image")` accepts svg substring → FIXED (hasPrefix("image/") && !contains("svg"), mirroring server isAllowedFaviconMime).
- **R39 (Low, func)**: clearCache() disk-removal path untested → FIXED (added a unit test that creates a file in faviconCacheDirectory, calls clearCache, asserts the dir is gone).
- **RS3 #2 (Low, security) — ACCEPTED, not fixed**: SettingsView optimistic toggle swallows PUT failure. Worst case: toggle shows ON but no icons appear when offline (no error feedback). Likelihood: low (only on network failure during toggle). Cost to fix: a non-trivial error-surfacing UI change. Plan C13 explicitly documents stale-true as SAFE (server 403s authoritatively — no data leak). Deferred as a UX-only follow-up, NOT a security gap.
