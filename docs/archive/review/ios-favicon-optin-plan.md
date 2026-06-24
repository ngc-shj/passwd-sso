# Plan: iOS Favicon Display (opt-in, server-proxied, SF Symbol default)

> **REVISED after #603 merged** (`feat(web): server-side favicon proxy with
> per-user opt-in (default OFF)`, commit d73ac241). #603 shipped the
> self-hosted favicon proxy that the round-0 plan had deferred as SC1. This
> revision re-bases the whole feature on that proxy: iOS no longer talks to a
> third party — it calls our own server, which fetches the icon server-side via
> the SSRF-safe path. `passwd-sso` is a **monorepo** (`src/` web + `ios/`
> coexist), so the server route and the iOS client ship in ONE PR.

## Project context

- **Type**: `mixed` — iOS app (`ios/`, Swift/SwiftUI) PLUS a small server slice
  (`src/`, Next.js route) in the same monorepo. The server slice REUSES #603's
  `favicon-proxy.ts` helpers and the existing iOS-DPoP auth path; it is additive.
- **Test infrastructure**:
  - iOS: `unit tests only` — XCTest under `ios/PasswdSSOTests/` (526+ tests),
    runnable locally via
    `xcodebuild test -scheme PasswdSSOApp -destination 'id=<sim udid>'`
    (Xcode 26.4.1 available — memory `ios-build-env-available`). SwiftUI view
    rendering and live-network image loading are NOT unit-testable.
  - Web: `unit + integration` — Vitest. `npx vitest run` + `npx next build` are
    the mandatory pre-commit checks (CLAUDE.md). #603's favicon routes already
    have Vitest coverage to mirror.
- **Verification environment constraints**:
  - **VEC-1 (favicon render in a `List` row)**: rendering a fetched favicon in a
    SwiftUI `List` row is a UI path → **blocked-deferred** (manual plan, R35).
    The loader's network *behavior* (401/404/non-image → nil) is
    **verifiable-local** via an injectable `MobileAPIClient` (which takes an
    injectable `urlSession`) + `MockURLProtocol`, with a seeded `HostTokenStore`
    (T6/T12).
  - **VEC-2 (real-device disk cache + lifecycle clear)**: on-disk eviction timing
    differs device vs sim → **blocked-deferred**; the clear *wiring* (C8 spy) is
    **verifiable-local**.
  - **VEC-3 (Settings toggle live re-render)**: SwiftUI reactive path →
    **blocked-deferred** for the visual re-render; the setting read/write +
    `PUT /api/mobile/favicon-pref` round-trip is **verifiable-local**.
  - **VEC-4 (iOS↔server favicon auth round-trip)**: a real DPoP-signed
    `GET /api/mobile/favicon` returning image bytes is a device+server path →
    **blocked-deferred** to the manual plan; the server route's auth/opt-in/host
    logic is **verifiable-local** in Vitest (mirroring #603's route tests).

## Objective

Give vault list rows (and the entry detail header) a leading icon matching the
web app's `entry-icon.tsx` behavior, **without** weakening the product's E2E
privacy guarantee by default and **without** sending stored-service host names to
any third party:

- Every entry shows a **type-appropriate SF Symbol** as the baseline (fixes the
  user's "no icon left of the name" + "pale category icons" complaints).
- **LOGIN** entries *may additionally* show a real **favicon** — but only when the
  user has **opted in**, which is **OFF by default**. When ON, iOS requests the
  icon from **our own server** (`GET /api/mobile/favicon`); the server fetches it
  from the upstream provider server-side (SSRF-safe, cached). The host name never
  goes to a third party from the device. When OFF, LOGIN rows show a `globe`.
- The category-grid icons are restyled from the pale `.tint` to a filled,
  full-contrast badge (the "淡色" complaint).

## Requirements

### Functional

1. **FR-1**: Every entry row (`EntrySummaryRow`) renders a leading icon.
2. **FR-2**: Icon selection mirrors `src/components/passwords/detail/entry-icon.tsx`:
   non-LOGIN types → a fixed type SF Symbol; LOGIN → favicon when (opt-in ON AND a
   usable host exists AND the server returns an image), else `globe`.
3. **FR-3**: Favicon fetching is gated by the **server-side `User.fetchFavicons`
   preference** (#603's column, default false). iOS reads it and the server
   ENFORCES it (`fetchFavicons !== true` → 403). Default OFF, fail-closed.
4. **FR-4**: Toggling the setting takes effect without an app relaunch.
5. **FR-5**: Category grid icons (`CategoryCard`) restyled to a filled badge.
6. **FR-6**: The entry detail view shows the same icon as the row.

### Non-functional

7. **NFR-1 (privacy, load-bearing)**: With the preference OFF (default), the app
   makes **zero** favicon requests. When ON, host names go ONLY to our own server
   over the authenticated DPoP channel — **never to a third party from the
   device** (the server-side proxy is what contacts the upstream provider). This
   is strictly stronger than the round-0 DuckDuckGo-direct design.
8. **NFR-2 (performance)**: List scrolling with hundreds of rows must not stutter
   or leak requests. Use `FaviconLoader`/`FaviconImageView` (dedicated, clearable
   `URLCache` in the vault dir; per-row `.task` auto-cancels on cell reuse;
   off-main decode). Never `AsyncImage`. The server's cache + single-flight (#603)
   means cold-vault first load is bounded server-side too.
9. **NFR-3 (lifecycle / R39)**: The iOS favicon cache (host-derived metadata) is
   cleared on **sign-out**; on **lock** it MAY persist (lock keeps the encrypted
   cache by existing design). The clear-on-sign-out path MUST exist and MUST be
   ordered so a concurrent re-populate cannot resurrect it.

## Technical approach

### Provider decision — REVISED: self-hosted server proxy (via #603), iOS-extended

The round-0 plan weighed (A) self-hosted proxy, (B) DuckDuckGo direct, (C) Google
direct, and chose **B** because A "expands scope into `src/`". **#603 invalidated
that trade-off**: it BUILT A for the web (`GET /api/user/favicon`,
`PUT /api/user/favicon-pref`, `User.fetchFavicons`, SSRF-safe
`validateAndFetchBuffered`, cache + single-flight + rate-limit + MIME allowlist).
The privacy-optimal end state now exists in the same monorepo.

**The gap**: #603's routes authenticate via `auth()` (cookie session) and gate on
`session.user.fetchFavicons`. iOS authenticates with **DPoP-signed Bearer
tokens** (`validateExtensionToken` → `IOS_APP` DPoP path) and has no session
cookie — so it **cannot call `/api/user/favicon` as-is** (it is classified
`api-session-required`, not Bearer-bypass-eligible; route-policy.ts:66-67).

**DECISION (user-confirmed)**: extend the proxy to iOS by adding a thin
**`GET /api/mobile/favicon`** that authenticates with `validateExtensionToken`
(iOS DPoP) and **reuses #603's `favicon-proxy.ts` helpers verbatim** (R1 — no
re-implementation of host normalization, provider URL, cache, single-flight,
SSRF). Opt-in is the **same `User.fetchFavicons` column** (single source of
truth), updated from iOS via a new **`PUT /api/mobile/favicon-pref`**. iOS becomes
a thin client: build the request URL, attach DPoP, render bytes or fall back to
`globe`.

| Option | Host→3rd party from device | Scope | Verdict |
|--------|----------------------------|-------|---------|
| **A. Server proxy (extend #603 to iOS)** | **None** (device→our server→provider) | server route reusing #603 + iOS client; monorepo 1 PR | **CHOSEN** |
| B. DuckDuckGo direct (round-0 choice) | host → DuckDuckGo | iOS-only | **SUPERSEDED** by #603 |
| C. Google direct | host → Google | iOS-only | rejected (web's known weakness) |

**Why A now** (it was "deferred SC1" only because the server work didn't exist):
- #603 already paid the hard cost (SSRF guard, cache, rate-limit, MIME allowlist).
  Our slice is a thin auth adapter + helper reuse — NOT a from-scratch proxy.
- Privacy: the device contacts only our own server over the existing
  authenticated, IP-restricted, tenant-scoped channel. The upstream provider
  (Google `t1.gstatic.com`, server-side per #603) never sees the device's IP tied
  to the request, and the host travels inside our TLS to our server.
- Consistency: web and iOS now share ONE opt-in (`User.fetchFavicons`) and ONE
  proxy behavior. No "iOS uses a different/older provider" drift.

**Note on upstream provider**: #603's server uses Google's non-redirecting
`t1.gstatic.com/faviconV2` (favicon-proxy.ts `buildFaviconProviderUrl`). That is a
**server-side** call; the device→Google direct-leak that the round-0 plan
rejected (option C) does NOT occur here. Swapping the upstream provider is a
one-function change in #603's `favicon-proxy.ts` (its SC3), out of scope here.

### Pieces

**Server (`src/`, additive, reuses #603):**

1. **`GET /api/mobile/favicon`** (new route): `validateExtensionToken(req)`
   (iOS DPoP) → `userId`/`tenantId`; read `User.fetchFavicons` (403 if not true);
   reuse `normalizeFaviconHost` / `getCachedFavicon` / `withSingleFlight` /
   `buildFaviconProviderUrl` / `validateAndFetchBuffered` / `isAllowedFaviconMime`
   / `setCachedFavicon` / `FAVICON_MAX_BODY_BYTES` from
   `src/lib/favicon/favicon-proxy.ts`. Mirror #603's rate-limit-on-miss, 204/403/
   validation semantics. Add tenant IP access restriction
   (`enforceAccessRestriction`, as other `/api/mobile/*` routes do).
2. **`GET`/`PUT /api/mobile/favicon-pref`** (new route): `validateExtensionToken`
   → `userId`/`tenantId`; strict Zod `{ fetchFavicons: boolean }` (PUT); read/write
   `User.fetchFavicons` via `withTenantRls(prisma, tenantId, …)` (F14 — tenantId is
   on `auth.data`, no redundant `withUserTenantRls` lookup). The **GET is required**
   (F16) — `fetchFavicons` is in NO existing iOS payload, so this is iOS's only way
   to bootstrap `fetchFaviconsCached` (C13).
3. **Route registration**: add both paths to the proxy `/api/mobile/*`
   classification (api-default + tenant-IP, matching `/api/mobile/token`) and to
   `API_PATH` constants. (NOT `api-session-required` — these are Bearer/DPoP.)

**iOS (`ios/`):**

4. **`FaviconProvider`** (new, app target): builds the **server** request URL
   `<serverURL>/api/mobile/favicon?host=<h>&size=<s>` (NOT a third-party URL).
   Skips empty hosts. **Host validation is the SERVER's job** (`normalizeFaviconHost`
   rejects IP literals etc.), so iOS only avoids obviously-pointless requests
   (empty/whitespace host) — it does NOT duplicate the server's allowlist.
5. **`FaviconLoader`** (new, app target, `final class`): owns a dedicated
   `URLCache` in `<AppGroup>/vault/favicon-cache/`; performs the request via the
   **authenticated `MobileAPIClient` path** so the DPoP proof + Bearer are
   attached (NOT an anonymous session — the route requires auth). Exposes
   `image(forHost:size:) async -> Image?` and `clearCache()`.
6. **`FaviconImageView`** (new SwiftUI view): `@State`-driven, loads via
   `FaviconLoader`, shows `globe` while loading and on any failure. Not `AsyncImage`.
7. **`EntryTypeCategory.rowSymbol`** (new computed property): LOGIN → `"globe"`;
   other types reuse `sfSymbol`. Computed property, NOT a new case
   (`testAllCasesCountIsEight`, EntryTypeCategoryTests.swift:30-31, stays the guard).
8. **`EntryIconView`** (new SwiftUI view): renders type `rowSymbol`, or for
   LOGIN+opt-in+host embeds `FaviconImageView`. Pure `decision(...)` seam (C4).
9. **`EntrySummaryRow`** (modified): prepend `EntryIconView`; gains
   `let showFavicons: Bool`.
10. **`VaultListView` / `VaultCategoryListView`** (modified): resolve
    `showFavicons` (the cached server pref) into `@State` and pass it down; FR-4
    reactivity (C7).
11. **`CategoryCard`** (modified): filled-badge restyle (FR-5).
12. **`EntryDetailView`** (modified): `EntryIconView` in a top `Section` of the
    detail `List` (not the nav bar) (FR-6).
13. **Favicon cache clear on sign-out** (modified `AutoLockService`): injectable
    `faviconCacheClearing` closure called in `signOut`, not `lock` (NFR-3/C8).
14. **opt-in state on iOS** (C13): iOS holds the server `fetchFavicons` value
    (bootstrapped via `GET /api/mobile/favicon-pref` at first sign-in / foreground
    — NOT carried in the unlock/sync payload, F16 — cached in `AppSettingsStore`),
    and the settings toggle
    writes it via `PUT /api/mobile/favicon-pref`. The cached value gates the
    request locally (avoid a guaranteed-403 round-trip) AND the server enforces it
    authoritatively.
15. **Settings toggle** in `SettingsView` (modified): "Show site icons" Toggle
    that calls the pref PUT; footer discloses that domains go to *our server* to
    fetch icons (materially lighter than the round-0 third-party disclosure).
16. **String Catalog** entries in `PasswdSSOApp/Localizable.xcstrings`.
17. **`PrivacyInfo.xcprivacy`**: re-evaluate — since the host now goes only to our
    own first-party server (not a third party), the
    `NSPrivacyCollectedDataTypeBrowsingHistory` "data sent to a third party"
    framing is weaker. Decision deferred to the security reviewer (C10): keep the
    declaration if the conservative reading applies, drop it if first-party-only
    transmission is exempt.

### iOS caching design (NFR-2 / NFR-3)

Unchanged in spirit from the round-1 resolution, but the request now goes to our
authenticated server:

- `FaviconLoader` owns a dedicated `URLCache` in `<AppGroup>/vault/favicon-cache/`
  (created explicitly in `init`, F10). It performs the GET through the
  `MobileAPIClient` auth path (DPoP + Bearer attached). **Because the request is
  authenticated (not anonymous), the session is the app's authenticated favicon
  session, NOT `.ephemeral` anonymous** — the round-2 S6/S7 "ephemeral, no
  cookies" guidance is re-evaluated by the security reviewer for the
  authenticated-first-party case (C9).
- The server also caches (per #603), so the iOS cache is a latency/offline
  optimization layered on top, not the only cache.
- Image bytes decoded OFF the main actor. `FaviconImageView.task` is cancellable.
- `clearCache()` = `removeAllCachedResponses()` + `removeItem(at: faviconCacheDir)`;
  called from `signOut` via an injectable seam (C8). The dir is inside
  `<AppGroup>/vault/` but — as round 2 established — `signOut`'s existing
  `removeItem(at: cacheURL)` deletes only the `.cache` FILE, so `clearCache()` is
  the SOLE deletion path (C8).

## Contracts

### C1 — `GET /api/mobile/favicon` (server, new)

- **Signature**: `GET /api/mobile/favicon?host=<string>&size=<32|64>` →
  image bytes (200, `Content-Type` an allowed favicon MIME) | 204 (cached-but-
  unservable / upstream miss → client shows globe) | 401 (auth) | 403 (opt-out) |
  400 (bad host/params) | 429 (miss rate-limited).
- **Invariants** (app-enforced):
  - Auth via `validateExtensionToken(req)`; on `!ok` → 401. (Dispatches to the
    iOS `IOS_APP` DPoP path; the proof's `ath`/`cnf.jkt` are checked there.)
  - **`clientKind === "IOS_APP"` guard (S13)**: after DPoP validation, reject
    (403) any token whose `clientKind` is not `IOS_APP` — `IOS_AUTOFILL` (5-min,
    `passwords:write`) and `BROWSER_EXTENSION` tokens must not call favicon routes
    (AutoFill renders no favicons, SC3). Mirrors
    `src/app/api/mobile/autofill-token/route.ts:60`.
  - **Opt-in enforced server-side, with explicit RLS read (F13/S12)**: read
    `User.fetchFavicons` for the authenticated `userId` via
    `withTenantRls(prisma, tenantId, …)` — `tenantId` comes from
    `auth.data.tenantId`; a bare `prisma.user.findUnique` bypasses RLS and would
    return no row under the NOSUPERUSER `passwd_app` role, silently 403-ing
    opted-in users. (`fetchFavicons` is NOT on the token result, so it MUST be a
    fresh DB read — unlike #603's web route which reads it off `session.user`.)
    If `!== true` → 403 BEFORE any host normalization or fetch (mirrors #603
    route.ts:53-57). A rogue/stale client cannot trigger a fetch for an opted-out
    user.
  - Tenant IP access restriction applied (`enforceAccessRestriction`), as on
    other `/api/mobile/*` routes.
  - Host handling, cache, single-flight, MIME allowlist, 256 KB cap, **AND BOTH
    rate limiters** — per-user (`FAVICON_USER_RATE_MAX`) AND global
    (`FAVICON_GLOBAL_RATE_MAX`), miss-only — are the SAME as #603 via the shared
    `favicon-proxy.ts` helpers, NOT re-implemented (R1). The global limiter
    (S11) bounds aggregate outbound load so N authed users cannot turn the server
    into an open SSRF/DoS proxy; do NOT ship per-user-only.
  - Response bytes are the exact upstream bytes (no Buffer-pool leak) via the
    `faviconResponse` helper — which #603 left **private** in its route (S9). This
    PR MOVES `faviconResponse` to `favicon-proxy.ts` as an exported helper and
    updates BOTH the #603 web route and this new route to import it (R1 — one
    source of the pool-safe `Uint8Array.from(body)` copy).
- **Forbidden patterns**:
  - `pattern: new Set(\[\s*"image — reason: do NOT redefine the MIME allowlist; import isAllowedFaviconMime from favicon-proxy (R1)`
  - `pattern: normalizeFaviconHost\s*=\s*function — reason: do NOT re-implement host normalization; import it (R1)`
  - `pattern: new NextResponse(.*\.buffer — reason: S9 Buffer-pool leak; use faviconResponse() from favicon-proxy.ts`
  - `pattern: prisma.user.findUnique — reason: F13 — read fetchFavicons inside withTenantRls(prisma, tenantId, …), never a bare RLS-bypassing read`
- **Acceptance criteria** (Vitest — mirror the MOBILE template
  `src/app/api/mobile/cache-rollback-report/route.test.ts`, NOT the web session
  route: mock `@/lib/auth/tokens/extension-token` + `@/lib/prisma` (for the
  `User.fetchFavicons` read) + `@/lib/auth/policy/access-restriction`, NOT
  `@/auth` — T9):
  - no/invalid token → 401; non-`IOS_APP` clientKind → 403 (S13).
  - valid `IOS_APP` token + `fetchFavicons=false` → 403 (no fetch).
  - valid token + `fetchFavicons=true` + cached image → 200 + bytes.
  - cache miss → single upstream fetch (single-flight: 3 concurrent misses → 1
    upstream call), rate-limit consumed only on miss; global-limiter exhaustion →
    429 (S11).
  - invalid host → 400; oversized upstream → aborted at the cap.
  - **R1 import check (T10)**: a runnable assertion that the route's helpers ARE
    the proxy module's symbols, e.g.
    `import * as proxy from "@/lib/favicon/favicon-proxy"` then
    `expect(routeModule.__usesProxyHelpers).toBe(true)` OR a grep test in CI
    (`grep -c 'function normalizeFaviconHost' route.ts === 0`). Must be a check
    CI can FAIL, not a human-inspection note.
- **Consumer-flow walkthrough**:
  - Consumer iOS `FaviconLoader` (path: `ios/.../FaviconLoader.swift`) issues the
    GET with DPoP+Bearer, reads `{ status, Content-Type, body }`. On 200+image
    MIME → decode; on 204/403/4xx/5xx → `nil` → `globe`. It uses `host` + `size`
    (32/64) — both it controls. No other field needed.

### C2 — `GET`/`PUT /api/mobile/favicon-pref` (server, new)

- **Signature**:
  - `GET /api/mobile/favicon-pref` → `{ fetchFavicons: boolean }` (200) | 401.
    **REQUIRED (F16)**: `fetchFavicons` is NOT carried in the unlock/data,
    status, or any existing iOS response (verified — `VaultUnlockData`,
    MobileAPIClient.swift:7-77, has no such field). This GET is the ONLY way iOS
    bootstraps `fetchFaviconsCached` (C13) on first sign-in / foreground. It is
    not optional.
  - `PUT /api/mobile/favicon-pref` body `{ fetchFavicons: boolean }` (strict) →
    `{ fetchFavicons }` (200) | 401 | 400.
- **Invariants**:
  - Auth via `validateExtensionToken` → `userId`/`tenantId`; `!ok` → 401;
    `clientKind !== "IOS_APP"` → 403 (S13).
  - Strict Zod `.strict()` rejects unknown fields (PUT) (mirrors #603
    favicon-pref/route.ts:10).
  - GET reads / PUT writes `User.fetchFavicons` via
    `withTenantRls(prisma, tenantId, …)` (F14 — `tenantId` is already on
    `auth.data`, so use `withTenantRls` directly, NOT `withUserTenantRls` which
    re-derives `tenantId` via a redundant bypass-RLS lookup; this also keeps the
    RLS pattern identical to C1's read).
  - Tenant IP restriction applied.
- **Route registration (F17)**: add `MOBILE_FAVICON: "/api/mobile/favicon"` and
  `MOBILE_FAVICON_PREF: "/api/mobile/favicon-pref"` to `API_PATH`
  (`src/lib/constants/auth/api-path.ts`). No `route-policy.ts` change needed —
  `/api/mobile/*` already falls through to `api-default` (route self-enforces
  auth + tenant IP), matching `/api/mobile/token`. (Confirmed: the
  `SESSION_REQUIRED_PREFIXES` list does NOT include `/api/mobile`.)
- **Forbidden patterns**:
  - `pattern: withUserTenantRls — reason: F14 — tenantId is on auth.data; use withTenantRls(prisma, tenantId, …) directly`
- **Acceptance criteria** (Vitest — same MOBILE mock template as C1, T9): GET
  no token → 401, returns current pref; PUT no token → 401; `{fetchFavicons:true}`
  → persists + returns true; unknown field → 400; non-boolean → 400;
  non-`IOS_APP` → 403.
- **Consumer-flow walkthrough**: iOS `SettingsView` toggle calls PUT on change and
  writes the returned value into `fetchFaviconsCached` (C13). iOS reads the GET at
  first sign-in / foreground to seed `fetchFaviconsCached`. `EntryIconView` gates
  on the cached value; the server's C1 403 is the authoritative enforcement.

### C3 — `EntryTypeCategory.rowSymbol` (iOS) — UNCHANGED from round 3

- **Signature**: `var rowSymbol: String { get }`.
- **Invariants**: total over 8 cases; LOGIN → `"globe"`; others reuse `sfSymbol`;
  computed property (not a new case — `testAllCasesCountIsEight` is the guard).
- **Acceptance**: `login.rowSymbol == "globe"`; `!= login.sfSymbol`; non-empty
  for every `allCases`.

### C4 — `EntryIconView` + pure `decision(...)` seam (iOS) — UPDATED

- **Signature**:
  ```swift
  struct EntryIconView: View {
    let entryType: String?     // nil → LOGIN via EntryTypeCategory.from
    let urlHost: String        // VaultEntrySummary.urlHost
    let showFavicons: Bool     // resolved server opt-in (cached)
    var size: CGFloat = 32
  }
  enum IconDecision: Equatable { case symbol(String); case favicon(host: String) }
  static func decision(entryType:urlHost:showFavicons:) -> IconDecision
  ```
  NOTE: `.favicon` now carries the **host string** (the server builds the URL);
  iOS no longer carries a third-party `URL`.
- **Invariants**:
  - non-LOGIN → `.symbol(rowSymbol)`, no request, regardless of `showFavicons`.
  - LOGIN: `showFavicons == false` OR empty/whitespace host → `.symbol("globe")`,
    no request. Else → `.favicon(host)` → `FaviconImageView(host:size:)`.
  - Every non-success/non-LOGIN path → a `globe`/type symbol (no blank icon, R26).
  - iOS does NOT pre-reject IP/localhost/.local — the SERVER's `normalizeFaviconHost`
    does (returns 400/204 → globe). iOS only short-circuits empty hosts to avoid a
    pointless request. (Simplification vs round-0: the host allowlist is server-
    side SSoT, not duplicated client-side.)
- **Forbidden patterns**:
  - `pattern: AsyncImage — reason: F3 (round 1)`
  - `pattern: icons.duckduckgo.com — reason: superseded by the server proxy; iOS must not call a third party`
  - `pattern: t1.gstatic.com — reason: the upstream provider is server-side only (#603); iOS must not call it directly`
- **Acceptance criteria** (`EntryIconDecisionTests`, the testable seam):
  - non-LOGIN, ON → `.symbol(glyph)`; non-LOGIN, OFF → `.symbol(glyph)`.
  - LOGIN, OFF → `.symbol("globe")`; LOGIN, ON, empty host → `.symbol("globe")`.
  - LOGIN, ON, non-empty host → `.favicon(host)`.
  - **nil entryType, ON, non-empty host → `.favicon(host)`** (T13 — nil resolves
    to `.login` per `EntryTypeCategory.from(nil)`, EntryTypeCategoryTests.swift:23;
    this is the common real-world case since `VaultEntrySummary.entryType` is
    often nil — name it explicitly so the test covers it).
  - nil entryType, ON, empty host → `.symbol("globe")`.
- **Consumer-flow walkthrough**: `EntrySummaryRow` and `EntryDetailView`
  construct `EntryIconView(entryType: summary.entryType, urlHost: summary.urlHost,
  showFavicons: <resolved>, size:)` — both fields exist on `VaultEntrySummary`
  (VaultEntrySummary.swift:6,8,33).

### C5 — `EntrySummaryRow` (iOS, modified) — UNCHANGED from round 3

- `let summary: VaultEntrySummary` **+ `let showFavicons: Bool`**; leading
  `EntryIconView` in an `HStack`. Row does NOT read the store; the flag is passed
  in. Both call sites (VaultListView.swift:341, VaultCategoryLanding.swift:98)
  pass it.

### C6 — `CategoryCard` restyle (iOS, modified) — UNCHANGED

- White glyph on accent-colored filled rounded-rect badge (replaces
  `.foregroundStyle(.tint)`). Purely visual. Manual (VEC-3).

### C7 — `showFavicons` reactive propagation (iOS) — UPDATED source

- **Subject**: how the resolved opt-in `Bool` reaches rows reactively. The value
  is now the **cached server `fetchFavicons`**, not a local-only setting.
- **Decision**:
  - `VaultListView` holds `@State private var showFavicons: Bool`, resolved by
    `resolveShowFavicons()` which reads the cached server pref
    (`AppSettingsStore().fetchFaviconsCached`, C13). Called `.onAppear`, on
    `scenePhase == .active` (VaultListView.swift:119-123), and on settings-sheet
    dismissal (add explicit `onDismiss:` — VaultListView.swift:96 has none today).
  - `VaultCategoryListView` receives `showFavicons` as a parameter from
    `VaultListView` (it owns no sheet / scenePhase hook — passed like `viewModel`).
  - No `@AppStorage` literal (round-2 T2 eliminated that fiction).
- **Forbidden patterns**:
  - `pattern: @AppStorage\("showFavicons" — reason: round-1 T2; resolve via the cached pref into @State`
- **Acceptance**: live re-render is VEC-3 (manual). The cached-pref read/write is
  covered by C13 unit tests.

### C8 — Favicon cache clear on sign-out (iOS, R39) — UNCHANGED from round 3

- `AutoLockService.init` gains
  `faviconCacheClearing: @escaping () -> Void = { FaviconLoader.shared.clearCache() }`
  (mirrors `teamDirectoryStore` spy DI, AutoLockServiceTests.swift:327-366).
  `signOut` calls it; `lock` does not.
- **`clearCache()` is the SOLE deletion path** — `signOut`'s `removeItem(at:
  cacheURL)` deletes only the `.cache` FILE, not the `vault/favicon-cache/`
  sibling dir (verified round 2, AutoLockService.swift:107-110). `signOut` is the
  only logout route (manual + idle-timeout; `authenticationRequired` surfaces an
  alert, does not force logout — verified round 2).
- Called before `state = .loggedOut`; `@MainActor` serialization closes the
  re-populate race.
- **Build-ordering (T16)**: the default closure `{ FaviconLoader.shared.clearCache() }`
  references `FaviconLoader.shared`, so C9 must exist before C8's default
  compiles. The existing test helper `makeService()`
  (AutoLockServiceTests.swift:13-39) MUST pass `faviconCacheClearing: {}` (no-op)
  explicitly so C8-unrelated tests keep compiling and do not touch the real
  loader. Implement C9 before (or with) C8.
- **Acceptance**: spy on a fresh instance → `signOut` calls once; SEPARATE fresh
  instance → `lock` does NOT (two instances, T7).

### C9 — `FaviconLoader` + `FaviconImageView` (iOS) — UPDATED for authenticated requests

- **Signature** (REVISED for the auth/cache seam — F15/T12):
  ```swift
  // NEW method on the MobileAPIClient actor so DPoP/Bearer + 401-refresh stay
  // inside the actor, but the I/O + caching use a CALLER-PROVIDED session
  // (FaviconLoader's dedicated-cache session) — NOT MobileAPIClient's own
  // urlSession (which is .shared by default; MobileAPIClient.swift:173,611,698).
  // Without this, the favicon response caches in MobileAPIClient's session and
  // FaviconLoader.clearCache() cannot reach it → R39 sign-out clear breaks.
  extension MobileAPIClient {
    func fetchFavicon(url: URL, using session: URLSession) async throws
      -> (status: Int, contentType: String?, body: Data)
  }

  @MainActor
  final class FaviconLoader {
    static let shared: FaviconLoader
    private let urlCache: URLCache          // dedicated, <AppGroup>/vault/favicon-cache/
    private let session: URLSession         // configured with urlCache
    private let apiClient: MobileAPIClient   // injectable for tests
    init(apiClient: MobileAPIClient, session: URLSession = FaviconLoader.makeCachingSession())
    func image(forHost host: String, size: Int) async -> Image?  // nil on any failure → globe
    func clearCache()
    static func faviconCacheDirectory() -> URL
    static func makeCachingSession() -> URLSession  // URLSession(config) with the dedicated urlCache
  }
  struct FaviconImageView: View { let host: String; var size: CGFloat /* loads via shared loader */ }
  ```
- **Invariants**:
  - `FaviconLoader` builds the server URL (C1, via `FaviconProvider`) and calls
    `apiClient.fetchFavicon(url:using: self.session)`. The actor attaches
    DPoP+Bearer and runs the 401-refresh ladder, but performs the actual
    `session.data(for:)` on the **caller's** dedicated-cache session — so the
    favicon response lands in `FaviconLoader`'s `URLCache` that `clearCache()`
    deletes (F15). This resolves the structural conflict: auth stays in the actor,
    cache stays with the loader.
  - `makeCachingSession()` / `init` explicitly creates
    `<AppGroup>/vault/favicon-cache/` before building the `URLCache` (F10), and
    attaches that `URLCache` to the session config.
  - **SECURITY RE-EVALUATION (supersedes round-2 S6/S7)**: the request is now
    first-party + authenticated to OUR server. (a) DPoP/Bearer go only to our
    server (never a third party); (b) no token leaks (same-origin, the actor owns
    header attachment); (c) the dedicated `URLCache` (not `URLCache.shared`) is
    used so the clear works; (d) the cache keys by URL — favicon bytes are public
    and identical per host across users, so URL-keyed caching has no cross-user
    poisoning (S10); the response's `Cache-Control: private` does not stop the
    in-process dedicated cache (intended latency optimization).
  - `image(forHost:size:)` returns `nil` on any non-2xx / non-image / decode
    failure / auth error; never throws to the view.
  - Image bytes decoded OFF the main actor.
  - `.task` cancellable; per-row tasks acceptable (server-cached + dedup).
- **Forbidden patterns**:
  - `pattern: URLCache.shared — reason: S1 — dedicated cache so the clear works`
  - `pattern: performAuthedGET — reason: F15 — uses MobileAPIClient's own session/cache, not FaviconLoader's dedicated cache; use fetchFavicon(url:using:)`
  - `pattern: AsyncImage — reason: F3`
- **Acceptance criteria**:
  - `image()` failure handling unit-tested via an **injectable `MobileAPIClient`
    (which itself takes an injectable `urlSession`) + `MockURLProtocol`** (T12 —
    the seam is the `MobileAPIClient`, not a bare `URLSession`): 401→nil, 403→nil,
    404→nil, non-image→nil, 200+PNG→non-nil. **The test MUST seed the
    `HostTokenStore` with a valid non-expired access token** (the
    `seedAccessToken()` pattern, MobileAPIClientTests.swift:340-344) — otherwise
    `validAccessToken()` throws `authenticationRequired` and `image()` returns
    `nil` for the WRONG reason (the `MockURLProtocol` handler is never reached),
    a false green (RT1/RT5).
  - `faviconCacheDirectory()` sits under the vault dir.
  - SwiftUI body render is VEC-1 (manual).
- **Consumer-flow walkthrough**: `EntryIconView` constructs
  `FaviconImageView(host:size:)` in the LOGIN+ON+non-empty-host branch;
  `AutoLockService.signOut` calls `clearCache()` (C8).

### C10 — `PrivacyInfo.xcprivacy` (iOS) — RE-EVALUATED

- **Subject**: whether the manifest needs an `NSPrivacyCollectedDataType` entry
  now that host names go to a **first-party** server, not a third party.
- **Decision (round-4 security reviewer CONFIRMED — S14)**: **no new
  `NSPrivacyCollectedDataType` entry**, with recorded rationale: (1) the host data
  is already held server-side in the encrypted vault; (2) the favicon request is
  architecturally identical to the existing vault-sync `urlHost` transmission to
  the same first-party server, which the manifest already does not separately
  declare; (3) the round-2 S4 motivation was *third-party* transmission, which no
  longer applies under the proxy; (4) re-confirm against Apple's current App
  Privacy Details guidance at submission time.
- **Acceptance**: the plist parses; the "no new entry" decision + the four-point
  rationale are recorded in the PR / manual-test artifact.

### C11 — `EntryDetailView` icon placement (iOS) — UNCHANGED from round 2

- `EntryIconView` in a top `Section` of the detail `List` (not the nav bar)
  (EntryDetailView.swift:55-69). FR-6.

### C12 — `CategoryCard` / row badge visual consistency (iOS) — folds into C6/C5

- Same filled-badge idiom for category and row (R8). Manual verify (VEC-3).

### C13 — iOS opt-in state: cached server `fetchFavicons` (iOS, new)

- **Signature**: `AppSettingsStore.fetchFaviconsCached: Bool { get nonmutating set }`
  — a CACHE of the server `User.fetchFavicons`, NOT an independent setting. Plus
  `public static let fetchFaviconsCachedKey` (PUBLIC — departs from the private
  `Key` enum precedent so the T5 behavioral key-consistency test can reference it,
  T11).
- **Invariants** (fail-closed):
  - Absent → `false` (opt-in default OFF). Same idiom as `autoCopyTotp`.
  - Populated from the server via `GET /api/mobile/favicon-pref` (C2 — the
    **required** bootstrap; `fetchFavicons` is NOT in any existing iOS response,
    F16) at first sign-in / foreground, AND from the settings PUT round-trip.
  - This is a UX-latency gate ONLY; the server's 403 is the authoritative enforce
    point (C1). A stale `true` cache cannot leak data — the server still 403s if
    the real pref is false. A stale `false` cache merely suppresses icons (safe).
- **Forbidden patterns**:
  - `pattern: fetchFaviconsCached.*default.*true — reason: opt-in default OFF`
- **Acceptance criteria**:
  - fresh store → `false`; persist/hydrate round-trip (R25);
  - behavioral key-consistency test (write via setter → read raw via
    `fetchFaviconsCachedKey`), per round-2 T5 (not a tautological literal check).
- **Consumer-flow walkthrough**: `VaultListView.resolveShowFavicons()` reads it
  (C7); `SettingsView` writes it after a successful `PUT /api/mobile/favicon-pref`;
  `FaviconLoader`/`EntryIconView` gate on the resolved value.

## Go/No-Go Gate

| ID  | Subject                                                              | Status |
|-----|---------------------------------------------------------------------|--------|
| C1  | `GET /api/mobile/favicon` (DPoP+IOS_APP auth, RLS read, both limiters, opt-in) | locked |
| C2  | `GET`/`PUT /api/mobile/favicon-pref` (DPoP auth, withTenantRls, GET bootstrap required) | locked |
| C3  | `EntryTypeCategory.rowSymbol`                                       | locked |
| C4  | `EntryIconView` + `decision(...)` (carries host, not 3rd-party URL)  | locked |
| C5  | `EntrySummaryRow` leading icon (+`showFavicons`)                     | locked |
| C6  | `CategoryCard` filled-badge restyle                                 | locked |
| C7  | `showFavicons` reactive propagation (cached server pref → @State)    | locked |
| C8  | Favicon cache clear on sign-out (sole path, R39)                    | locked |
| C9  | `FaviconLoader` (authenticated request + dedicated cache) + view     | locked |
| C10 | `PrivacyInfo.xcprivacy` re-evaluation (first-party transmission)    | locked |
| C11 | `EntryDetailView` icon placement                                   | locked |
| C13 | `AppSettingsStore.fetchFaviconsCached` (server-pref cache, fail-closed) | locked |

(All `locked` after the #603-driven revision converged: round 4 resolved 16
findings — F13/F15/F16 (server RLS read, the FaviconLoader↔MobileAPIClient cache
seam, the required GET bootstrap) + S9/S11/S13 (faviconResponse reuse, both rate
limiters, IOS_APP guard) + T9/T16 (MOBILE test-mock template, C8 build-ordering)
+ minors — and round 5 confirmed internal consistency. C12 folded into C5/C6.)

## Testing strategy

- **Server (Vitest, `src/`)** — mirror the MOBILE template
  `src/app/api/mobile/cache-rollback-report/route.test.ts`, NOT the #603 web
  session route (T9): mock `@/lib/auth/tokens/extension-token` (validateExtensionToken),
  `@/lib/prisma` (the `User.fetchFavicons` read/write), and
  `@/lib/auth/policy/access-restriction` (enforceAccessRestriction) — NEVER
  `@/auth` (there is no session). The token-result shape is `{ ok, data: { userId,
  tenantId, clientKind, … } }`, not a session object — `fetchFavicons` comes from
  the mocked Prisma read.
  - `api/mobile/favicon/route.test.ts`: 401 (no/invalid token), 403
    (non-`IOS_APP` clientKind), 403 (opt-out), 200 (cached image), single-flight
    (3 misses → 1 upstream), rate-limit-on-miss (per-user AND global), 400 (bad
    host).
  - `api/mobile/favicon-pref/route.test.ts`: GET returns current pref; PUT 401,
    persist+return, strict-reject unknown field, non-boolean → 400, non-`IOS_APP`
    → 403.
  - **R1 import check (T10)**: a RUNNABLE check CI can fail — e.g.
    `import * as proxy from "@/lib/favicon/favicon-proxy"` and
    `expect(routeInternals.normalizeFaviconHost).toBe(proxy.normalizeFaviconHost)`,
    or a CI grep step asserting the route file declares no local
    `function normalizeFaviconHost|isAllowedFaviconMime|faviconResponse`. NOT a
    human-inspection note.
- **iOS (XCTest)**:
  - `FaviconProviderTests`: builds `<serverURL>/api/mobile/favicon?host=&size=`;
    nil/empty host → no URL; correct query encoding. **Assertable "never a
    third-party host" (T14)**: `XCTAssertEqual(url.host, serverURL.host)` (NOT
    `t1.gstatic.com`/`icons.duckduckgo.com`) — gives the C4 forbidden-pattern a
    unit-test, not just code review. Plus a query-encoding test for a host with a
    percent/unicode char.
  - `EntryTypeCategoryTests` (extend): C3 `rowSymbol` (+ `testAllCasesCountIsEight`).
  - `AppSettingsStoreTests` (extend): C13 default-OFF, persist/hydrate,
    behavioral key-consistency via the PUBLIC `fetchFaviconsCachedKey` (T5/T11).
  - `EntryIconDecisionTests`: C4 matrix (host-carrying `.favicon`, incl. the
    nil-entryType+ON+host row, T13).
  - `AutoLockServiceTests` (extend): C8 spy (signOut once / lock not; two
    instances; `makeService()` passes a no-op closure, T16).
  - `FaviconLoaderTests` (new): C9 `image()` failure handling via an injectable
    `MobileAPIClient` (itself taking an injectable `urlSession`) + `MockURLProtocol`,
    with the `HostTokenStore` SEEDED with a valid access token (else `image()`
    fails for the wrong reason — T12); `faviconCacheDirectory()` under vault dir.
- **Manual (R35, `*-manual-test.md`)**: VEC-1 (favicon renders, device, opt-in
  ON), VEC-2 (cache survives lock / cleared on sign-out), VEC-3 (toggle live
  re-render; OFF → zero favicon requests via Charles), VEC-4 (end-to-end DPoP
  round-trip ONLY: a real signed `GET /api/mobile/favicon` returns image bytes on
  device — the opt-out→403 path is covered by Vitest, NOT re-verified manually,
  T15).
- **Mandatory web checks** (CLAUDE.md): `npx vitest run` + `npx next build` must
  pass for the `src/` slice.

## Considerations & constraints

### Scope contract

- **SC1** — ~~Self-hosted favicon proxy (deferred).~~ **DELIVERED**: #603 built it
  for web; this PR extends it to iOS (`/api/mobile/favicon`). No longer deferred.
- **SC2** — Web app's Google-direct favicon call. **OBSOLETE**: #603 replaced the
  web's Google-direct call with the same server proxy. Nothing left to track here.
- **SC3** — AutoFill extension favicons: permanently out of scope.
  `ASPasswordCredentialIdentity` / `ASPasskeyCredentialIdentity` carry no icon
  field (CredentialIdentityRegistrar.swift:243-257); structurally impossible.
- **SC4** — ~~Dedicated iOS `URLCache` (deferred).~~ **DELIVERED** (round 1):
  required for the R39 clear; C8/C9.
- **SC5** (new) — Upstream provider choice (`t1.gstatic.com` vs others) lives in
  #603's `favicon-proxy.ts` `buildFaviconProviderUrl` (its SC3). Changing it is a
  one-function server edit, out of scope for this iOS-client PR.

### Privacy disclosure

- The Settings footer discloses that, when ON, entry **domain names are sent to
  the passwd-sso server** (first-party — the same server holding the encrypted
  vault) **to fetch site icons**; the server contacts the icon provider, the
  device does not. This is materially lighter than the round-0 third-party
  disclosure and must NOT name a third party as the device's correspondent.
- **App Store listing / privacy policy**: a line noting the optional first-party
  favicon fetch. `PrivacyInfo.xcprivacy` per C10 (likely no new entry — first-
  party). Reviewer confirms.

### Known risks

- **Server upstream availability** (`t1.gstatic.com`, server-side): failure →
  204/5xx → iOS `globe` fallback. No correctness risk.
- **Cold-vault first load**: a large opted-in vault triggers many distinct
  `GET /api/mobile/favicon` on first scroll. Bounded by #603's **per-user
  (`FAVICON_USER_RATE_MAX`, 300/min) AND global (`FAVICON_GLOBAL_RATE_MAX`, 5000/min)
  rate limiters** (miss-only, S11) + server cache + iOS per-row task cancellation.
  The global limiter is what stops N concurrent opted-in users from turning the
  server into an open SSRF/DoS proxy. Note the per-user interaction in the manual
  plan (a first-time opt-in with 300+ distinct hosts could see some 429→globe
  until cache warms — acceptable, cosmetic).
- **R8 (UI consistency)**: row badge ↔ category badge share the filled-badge idiom.

## User operation scenarios

1. **Default user (never opts in)**: type SF Symbols + `globe` for LOGIN; filled
   category badges; **zero** favicon requests; server `fetchFavicons=false`.
2. **Opt-in user**: Settings → toggle ON → `PUT /api/mobile/favicon-pref` sets
   `fetchFavicons=true` → return to list → LOGIN rows fetch icons from
   `GET /api/mobile/favicon` (DPoP). Host never leaves to a third party.
3. **Opt-in user, offline / server-upstream down**: `globe` fallback; no stuck
   spinner (`image()` → nil).
4. **Opt-in user signs out**: iOS favicon cache cleared (R39); server pref
   persists (per-user) — re-sign-in re-reads `fetchFavicons=true`, re-fetches.
5. **Opt-in user locks**: re-unlock shows icons from iOS cache (lock keeps cache).
6. **Empty host**: LOGIN entry with empty `urlHost` → `globe`, no request.
7. **Stale-cache safety**: iOS cached `fetchFavicons=true` but server pref was
   turned OFF on web → server 403 → `globe`. The cache cannot leak; the server is
   authoritative (C1/C13).

## Implementation Checklist (Phase 2-1)

### Reusable code confirmed (R1 — reuse, do NOT reimplement)
- `src/lib/favicon/favicon-proxy.ts` exports (verified): `normalizeFaviconHost`,
  `buildFaviconProviderUrl`, `getCachedFavicon`, `setCachedFavicon`,
  `withSingleFlight`, `isAllowedFaviconMime`, `FAVICON_MAX_BODY_BYTES`.
- `faviconResponse` (S9): currently PRIVATE in
  `src/app/api/user/favicon/route.ts:145`. **Move to `favicon-proxy.ts` as an
  exported helper**; update the #603 web route to import it; the new mobile route
  imports it too. (Touches the raw-body-read gate — see below.)
- Rate limiters (S11): `FAVICON_USER_RATE_MAX=300` / `FAVICON_GLOBAL_RATE_MAX=5000`
  are route-local consts in the #603 route (`route.ts:27-28,36-44`). Re-declare
  the same two limiters in the mobile route (keys `rl:favicon:<userId>` +
  `rl:favicon:global`), OR (cleaner) export them from `favicon-proxy.ts`. Either
  way BOTH must fire, miss-only.
- `validateExtensionToken(req)` → `{ ok, data: { userId, tenantId, tokenId,
  clientKind, … } }` (extension-token-types.ts:25-49; `clientKind` present →
  S13 guard feasible). Auth-fail uses `errorResponse(API_ERROR[auth.error], 401)`
  (cache-rollback-report/route.ts:90), NOT `unauthorized()`.
- `enforceAccessRestriction(req, userId, tenantId)` → tenant IP gate
  (cache-rollback-report/route.ts:96).
- `withTenantRls(prisma, tenantId, fn)` (tenant-rls.ts:33; used by
  vault/unlock/data/route.ts:12) — the RLS read/write pattern for `fetchFavicons`.
- `clientKind !== "IOS_APP"` literal guard precedent: autofill-token/route.ts:60.
- iOS DPoP ladder: `MobileAPIClient.performAuthedGET` (MobileAPIClient.swift:611)
  — replicate its ladder in a NEW `fetchFavicon(url:using:)` that (a) takes the
  caller's session (F15) and (b) returns `(status, contentType, body)` not just
  `Data` (favicon needs 204/non-image distinction). Reuse `buildDPoPProof`,
  `validAccessToken`, `ensureRefreshed`, `canonicalHTU`, `jwk`, `signer`.
- iOS test stubs: `MockURLProtocol` + `makeSession()` (MobileAPIClientTests.swift:9-41);
  `seedAccessToken()` (MobileAPIClientTests.swift:340-344, T12).

### Files to create
- `src/app/api/mobile/favicon/route.ts` (C1) + `route.test.ts`
- `src/app/api/mobile/favicon-pref/route.ts` (C2, GET+PUT) + `route.test.ts`
- `ios/PasswdSSOApp/Network/FaviconProvider.swift` (C4-iOS URL builder) + test
- `ios/PasswdSSOApp/Network/FaviconLoader.swift` (C9) + `FaviconLoaderTests.swift`
- `ios/PasswdSSOApp/Views/Vault/EntryIconView.swift` (C4: EntryIconView +
  FaviconImageView + decision seam) + `EntryIconDecisionTests.swift`

### Files to modify
- `src/lib/favicon/favicon-proxy.ts` — export `faviconResponse` (+ optionally the
  two limiters); update `src/app/api/user/favicon/route.ts` to import it (S9).
- `src/lib/constants/auth/api-path.ts` — add `MOBILE_FAVICON`,
  `MOBILE_FAVICON_PREF` (F17).
- `scripts/checks/raw-body-read-allowlist.txt` — add the new route(s) /
  favicon-proxy if the raw-body-read gate flags the body read (verify).
- `ios/.../EntryTypeCategory.swift` — add `rowSymbol` (C3).
- `ios/Shared/Storage/AppSettingsStore.swift` — add `fetchFaviconsCached` +
  public `fetchFaviconsCachedKey` (C13).
- `ios/.../MobileAPIClient.swift` — add `fetchFavicon(url:using:)` + the
  favicon-pref GET/PUT typed calls (C9/C2 client side).
- `ios/.../AutoLockService.swift` — add injectable `faviconCacheClearing` closure;
  call in `signOut` not `lock` (C8). `AutoLockServiceTests.makeService()` passes
  `{}` no-op (T16).
- `ios/.../VaultCategoryLanding.swift` — `EntrySummaryRow` (+showFavicons param,
  leading EntryIconView, C5); `CategoryCard` filled-badge restyle (C6).
- `ios/.../VaultListView.swift` — `@State showFavicons` + `resolveShowFavicons()`
  on appear/scenePhase/sheet-onDismiss; pass to rows + VaultCategoryListView (C7).
- `ios/.../VaultCategoryLanding.swift` (VaultCategoryListView) — accept
  `showFavicons` param, thread to rows (C7).
- `ios/.../EntryDetailView.swift` — EntryIconView in a top List Section (C11).
- `ios/.../SettingsView.swift` — "Show site icons" Toggle → PUT favicon-pref;
  footer disclosure (C15/piece 15).
- `ios/PasswdSSOApp/Localizable.xcstrings` — new setting strings.
- `ios/PasswdSSOApp/PrivacyInfo.xcprivacy` — NO new entry (C10, decision recorded).

### CI gate parity (Step 2-1.7)
- `scripts/pre-pr.sh` reproduces the CI gate set locally — NO parity gap. Relevant
  gates it runs: `check-raw-body-read` (line 133 — the `faviconResponse` move +
  new body read must pass), `check-bypass-rls`, `check-migration-drift`,
  `check-team-auth-rls`, lint, typecheck, vitest, build. Run `bash scripts/pre-pr.sh`
  before Phase 2 completion.
- iOS: `xcodebuild test -scheme PasswdSSOApp` (memory `ios-build-env-available`).
  iOS is not in `pre-pr.sh` (it runs `xcodebuild` on macos CI only — pre-pr.sh:483).

### Patterns to follow consistently
- Server routes: mirror `cache-rollback-report/route.ts` (mobile/DPoP), NOT the
  web session route. Tests mock `@/lib/auth/tokens/extension-token` + `@/lib/prisma`
  + `@/lib/auth/policy/access-restriction`, NOT `@/auth` (T9).
- All forbidden patterns from each contract (no `URLCache.shared`,
  `performAuthedGET`, `AsyncImage`, `withUserTenantRls`, `prisma.user.findUnique`
  bare, third-party hosts from iOS) — grep the diff at Phase 2-4.
