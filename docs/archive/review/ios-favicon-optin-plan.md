# Plan: iOS Favicon Display (opt-in, SF Symbol default)

## Project context

- **Type**: `mixed` — primarily the iOS app (`ios/`, Swift/SwiftUI). The chosen
  provider (see Technical approach) keeps this PR **iOS-only**; no `src/` change.
- **Test infrastructure**: `unit tests only` for iOS — XCTest under
  `ios/PasswdSSOTests/` (526+ tests), runnable locally via
  `xcodebuild test -scheme PasswdSSOApp -destination 'id=<sim udid>'`
  (Xcode 26.4.1 available in this environment — see memory
  `ios-build-env-available`). No iOS CI-side device farm; SwiftUI view rendering
  and live network image loading are NOT unit-testable.
- **Verification environment constraints**:
  - **VEC-1 (favicon render in a `List` row)**: rendering a fetched favicon in a
    SwiftUI `List` row is a UI path. Classification: **blocked-deferred** for the
    visual render (manual plan, R35). NOTE (revised round 2): the network
    *behavior* of `FaviconLoader.image()` (404/error/non-image → nil) is NOW
    **verifiable-local** via an injectable `URLSession` + `MockURLProtocol`
    (T6) — only the SwiftUI body render itself remains manual.
  - **VEC-2 (real-device disk cache + lifecycle clear)**: `URLCache` on-disk
    eviction timing and App-Group container behavior differ on device vs sim.
    Classification: **verifiable-local** for the *wiring* (the C8 spy-closure
    test asserts `signOut` clears / `lock` does not), **blocked-deferred** for
    real on-disk eviction timing (manual plan).
  - **VEC-3 (Settings toggle live re-render)**: toggling the setting and seeing
    rows swap favicon↔SF Symbol without relaunch is a SwiftUI reactive path.
    Classification: **verifiable-local** for the binding/setter (unit test on
    `AppSettingsStore.showFavicons`), **blocked-deferred** for the visual
    re-render (manual plan).

## Objective

Give vault list rows (and the entry detail header) a leading icon, matching the
web app's `entry-icon.tsx` behavior, **without** weakening the product's E2E
privacy guarantee by default:

- Every entry shows a **type-appropriate SF Symbol** as the baseline (this alone
  fixes the user's "no icon left of the name" complaint and the "pale category
  icons" complaint).
- **LOGIN** entries *may additionally* show a real **favicon** — but only when
  the user has **explicitly opted in** via a new Settings toggle that is
  **OFF by default**. When OFF (the default and the privacy-safe state), LOGIN
  rows show a `globe` SF Symbol.

The category-grid icons are also restyled from the current pale `.tint`
foreground to a filled, full-contrast badge (the "淡色" complaint).

## Requirements

### Functional

1. **FR-1**: Every entry row in `EntrySummaryRow` renders a leading icon.
2. **FR-2**: Icon selection mirrors `src/components/passwords/detail/entry-icon.tsx`:
   non-LOGIN types → a fixed type SF Symbol; LOGIN → favicon when (opt-in ON AND
   a usable host exists AND fetch succeeds), else `globe` SF Symbol.
3. **FR-3**: A Settings toggle "Show site icons" (opt-in) gates ALL favicon
   network fetching. **Default OFF** (fail-closed: absent key → no fetch).
4. **FR-4**: Toggling the setting takes effect on the next render without an app
   relaunch (mirrors the `autoCopyTotp` / language live-apply pattern).
5. **FR-5**: The category landing grid icons (`CategoryCard`) are restyled to a
   filled badge (white glyph on accent-colored rounded square), removing the
   pale `.tint`-on-transparent look.
6. **FR-6**: The entry detail header (`EntryDetailView`) shows the same
   icon as the row (consistency with web, where `EntryIcon` is shared by row and
   detail). LOGIN detail favicon follows the same opt-in gate.

### Non-functional

7. **NFR-1 (privacy, the load-bearing requirement)**: With the setting OFF (the
   default), the app makes **zero** favicon-related network requests and stores
   **zero** host-derived icon bytes. The opt-in is the only thing that can send a
   host name off-device.
8. **NFR-2 (performance)**: List scrolling with hundreds of rows must not stutter
   or leak requests. Use `FaviconLoader`/`FaviconImageView` (dedicated, clearable
   `URLCache` in the vault dir; per-row `.task` auto-cancels on cell reuse;
   off-main decode — see Caching design / C9). Never `AsyncImage`, never
   `URLCache.shared`, never fetch/decode synchronously on the main thread.
9. **NFR-3 (lifecycle / R39)**: Favicon cache (host-derived metadata) is cleared
   on **sign-out** (it is part of the session's host-name footprint). On **lock**
   it MAY persist (lock keeps the encrypted cache per existing design), but the
   clear-on-sign-out path MUST exist and MUST be ordered so a concurrent
   re-populate cannot resurrect it.

## Technical approach

### Provider decision (REQUIRED by the task) — DECIDED: DuckDuckGo direct, OFF-by-default

Three candidates were weighed:

| Option | Host-name exposure | Cost / scope | Verdict |
|--------|--------------------|--------------|---------|
| **A. Self-hosted proxy** (`src/app/api/mobile/favicon`) | None to 3rd party (app→our server→provider); server can cache | HIGH: new server route, SSRF guard, rate limit, cache eviction, auth (DPoP/bearer), `src/` scope expansion, server tests | Best privacy, **deferred** (SC1) |
| **B. DuckDuckGo direct** (`icons.duckduckgo.com/ip3/<host>.ico`) | Host name → DuckDuckGo, **only when opted in** | LOW: iOS-only, no server change | **CHOSEN** |
| **C. Google direct** (web's current impl) | Host name → Google | LOW | **REJECTED** (see below) |

**Why B over C**: The task brief and the project's own RTK privacy posture treat
Google as a higher-concentration data sink. DuckDuckGo's favicon service
(`icons.duckduckgo.com/ip3/{host}.ico`) is the more neutral third party and is a
documented public endpoint. Crucially **C is the web app's known weakness** —
copying it would propagate the weakness to a second client. (Web's Google
direct-call is tracked for separate review as **SC2**, explicitly out of scope
here.)

**Why B over A for *this* PR**: A is the privacy-optimal end state, but it
expands scope into `src/` (server route + SSRF + rate-limit + cache + tests) —
exactly the scope-expansion the task says to avoid unless chosen deliberately.
B ships the visible UX win now, iOS-only, and **the OFF-by-default opt-in bounds
B's privacy cost to users who knowingly accept it**. The provider is encapsulated
behind a single `FaviconProvider` type (C1) so migrating to A later is a
localized change (swap the URL builder + clear the disclosure), not a rewrite.

**Anti-Deferral for A (SC1)** — Worst case: a user who opts in leaks their LOGIN
host names to DuckDuckGo instead of to our own server. Likelihood: low (OFF by
default; only opted-in users). Cost to fix (build A): HIGH (new authenticated
server endpoint + SSRF allowlist + rate limit + disk cache + server unit tests;
multi-hour, `src/` scope). → Deferral justified; tracked as SC1.

### Pieces

1. **`FaviconProvider`** (new, app target): a pure value type that maps a host
   string → favicon `URL?`. Encapsulates the provider choice; rejects
   empty/invalid hosts AND IP literals / `.local` / `localhost` (S2).
   **Pure and unit-testable** (no network).
2. **`FaviconLoader`** (new, app target, `final class`): owns a dedicated
   `URLCache` in `<AppGroup>/vault/favicon-cache/` + a private `URLSession`;
   exposes `image(forHost:) async -> Image?` and `clearCache()`. Backs the
   custom async-image view and the sign-out clear (see Caching design).
3. **`FaviconImageView`** (new SwiftUI view): a small `@State`-driven view that
   loads via `FaviconLoader` (cancel on teardown), shows a `globe` SF-Symbol
   placeholder while loading and on failure. Replaces `AsyncImage` (F3).
4. **`EntryTypeCategory.rowSymbol`** (new computed property): single-entry row
   glyph. LOGIN → `"globe"`; other types reuse their existing `sfSymbol` glyphs.
   (Distinct from `sfSymbol`, the *plural category card* glyph.) NOTE: a computed
   property, NOT a new enum case — `testAllCasesCountIsEight`
   (EntryTypeCategoryTests.swift:30-31) remains the guard against accidental
   case addition (F4).
5. **`AppSettingsStore.showFavicons`** (new Bool property) + **expose
   `Key.showFavicons`** as a shared constant (e.g. an `internal static let
   faviconShowKey = "showFavicons"`) so the propagation read references the
   constant, not a literal (S3). Fail-closed getter, default **false**. Mirrors
   `autoCopyTotp` exactly.
6. **`EntryIconView`** (new SwiftUI view): the shared row/detail icon. Renders the
   type `rowSymbol` SF Symbol; for LOGIN with opt-in ON and a provider URL,
   embeds `FaviconImageView` (globe fallback). Mirrors web `EntryIcon`. Exposes a
   pure `decision(...)` seam for unit tests (C4).
7. **`EntrySummaryRow`** (modified): prepend `EntryIconView`; gains a
   `let showFavicons: Bool` parameter (C5, F2).
8. **`VaultListView` (modified)** and **`VaultCategoryListView` (modified)** (both
   in their respective files, VaultListView.swift / VaultCategoryLanding.swift):
   resolve `showFavicons` at the unlocked-list boundary into a `@State` value,
   re-resolve on `scenePhase == .active` and on settings-sheet dismissal (the app
   already re-syncs on `.active`, VaultListView.swift:119-123), and pass the
   `Bool` to every `EntrySummaryRow(summary:showFavicons:)` call
   (VaultListView.swift:341, VaultCategoryLanding.swift:98). This is the FR-4
   reactivity mechanism (F2/T2) — no `@AppStorage` literal, so no key-drift
   unit-test fiction (T2).
9. **`CategoryCard`** (modified): filled-badge restyle (FR-5).
10. **`EntryDetailView`** (modified): show `EntryIconView` as a centered icon in a
    **top `Section` of the detail `List`** (NOT the nav bar — the header is
    `.navigationTitle` + `.inline` with no leading area, EntryDetailView.swift:55-69;
    a principal ToolbarItem would fight the Edit button). FR-6 (F1).
11. **Favicon cache clear on sign-out** (modified `AutoLockService`): add an
    injectable `faviconCacheClearing` closure (default
    `{ FaviconLoader.shared.clearCache() }`) called in `signOut`, NOT in `lock`
    (NFR-3 / R39 / C8 / T1).
12. **Settings toggle** in `SettingsView` (modified): "Show site icons" Toggle +
    footer disclosing the DuckDuckGo fetch (R37-clean).
13. **String Catalog** entries in `PasswdSSOApp/Localizable.xcstrings`.
14. **`PrivacyInfo.xcprivacy`** (modified, PasswdSSOApp): add an
    `NSPrivacyCollectedDataTypeBrowsingHistory` entry (Linked=false,
    Tracking=false, Purpose=AppFunctionality) for the opt-in domain-name fetch
    (S4).

### Caching design (NFR-2 / NFR-3) — REVISED after round 1 (F3=S1=T1)

Round-1 review (three experts, one root cause) established that
`AsyncImage` + `URLCache.shared` is **architecturally wrong** here:

- `AsyncImage` uses a private internal `URLSession`/cache that is NOT
  `URLSession.shared`/`URLCache.shared` and is not API-clearable (F3).
- `URLCache.shared`'s on-disk backing lives in `~/Library/Caches/<bundle-id>/`,
  which `AutoLockService.signOut()`'s `removeItem(at: cacheURL)` does NOT delete
  (it deletes only `<AppGroup>/vault/`). So host-derived cache keys
  (`…/ip3/<host>.ico`) survive sign-out and are forensic/backup-recoverable (S1).
- A global singleton cache has no injection seam, so the C8 clear-on-sign-out
  test cannot spy on it (T1).

**REVISED decision** — a custom loader with a **dedicated, app-controlled
on-disk `URLCache`** inside the App-Group vault directory:

- `FaviconLoader` (a small `final class`, `@MainActor` for the SwiftUI view side)
  owns a `URLCache(memoryCapacity: 4 MB, diskCapacity: 16 MB, directory:
  <AppGroup>/vault/favicon-cache/)` fed to a private `URLSession`. Because the
  cache directory is INSIDE `<AppGroup>/vault/`, the existing
  `signOut()` `removeItem(at: cacheURL)` physically deletes it; the loader ALSO
  exposes `clearCache()` (`urlCache.removeAllCachedResponses()` +
  `removeItem(at: faviconCacheDir)`) for explicit, ordered clearing.
- The row uses a tiny `@State`-driven async-image view backed by the loader's
  `URLSession.data(for:)` (cancel on `task` teardown / cell reuse), NOT
  `AsyncImage`. This gives us cancellation, a clearable cache, and an injectable
  seam.
- `AutoLockService.init` gains an injectable
  `faviconCacheClearing: @escaping () -> Void = { FaviconLoader.shared.clearCache() }`
  (mirrors the existing `teamDirectoryStore` spy-injection pattern,
  AutoLockServiceTests.swift:327-366) so C8 is unit-testable.

Rationale: favicons are public bytes, but the SET of cached hosts reveals the
user's stored-service list — the very E2E-protected metadata this product
guards. The dedicated cache makes NFR-3/R39 a real, testable guarantee rather
than a best-effort. SC4 is therefore **un-deferred** (it was the root cause).

## Contracts

### C1 — `FaviconProvider.iconURL(forHost:)`

- **Signature**:
  ```swift
  public enum FaviconProvider {
    /// DuckDuckGo public favicon service. Encapsulated so a future self-hosted
    /// proxy (SC1) is a one-site change.
    public static func iconURL(forHost host: String) -> URL?
  }
  ```
- **Invariants** (app-enforced):
  - Returns `nil` for an empty/whitespace-only host (no request is ever made).
  - Returns `nil` if the host contains characters illegal in a host label after
    trimming (defense against building a malformed/abusable URL).
  - Returns `nil` for IPv4 dotted-decimal literals, IPv6 literals (bracketed AND
    bare, i.e. any host containing `:`), `localhost`, and any `.local` (mDNS)
    host — these have no meaningful favicon and their transmission would leak
    internal/LAN topology to the provider (S2). The `localhost`/`.local` check is
    **case-insensitive** (lowercases first — `urlHost` is the raw stored value,
    not `URLMatcher`-normalized; a stored `"LOCALHOST"` must still be rejected,
    S2 round 2). A trailing dot is stripped/rejected (FQDN form `example.com.`).
  - The returned URL's scheme is always `https`.
  - The host is percent-encoded into the path so a crafted host cannot inject
    query/path segments.
- **Forbidden patterns** (grep keys for Phase 2-4 conformance):
  - `pattern: google.com/s2/favicons — reason: web's rejected provider (option C); must not appear in iOS`
  - `pattern: http://icons — reason: favicon URLs must be https`
- **Acceptance criteria**:
  - `iconURL(forHost: "example.com")` == `https://icons.duckduckgo.com/ip3/example.com.ico`
  - `iconURL(forHost: "")` == `nil`
  - `iconURL(forHost: "  ")` == `nil`
  - `iconURL(forHost: "a b/../../x")` == `nil` (illegal host rejected, not encoded-through)
  - `iconURL(forHost: "192.168.1.1")` == `nil` (IPv4 literal)
  - `iconURL(forHost: "2001:db8::1")` == `nil` (bare IPv6, S2 round 2)
  - `iconURL(forHost: "localhost")` == `nil`
  - `iconURL(forHost: "LOCALHOST")` == `nil` (case-insensitive, S2 round 2)
  - `iconURL(forHost: "printer.local")` == `nil`
  - `iconURL(forHost: "printer.LOCAL")` == `nil` (case-insensitive, S2 round 2)
  - `iconURL(forHost: "example.com.")` == `https://icons.duckduckgo.com/ip3/example.com.ico`
    (trailing dot stripped) — OR `nil` if the impl rejects FQDN form; pin whichever
    the implementation chooses, no encoded double-dot.
- **Consumer-flow walkthrough**:
  - Consumer `FaviconImageView` (path: `PasswdSSOApp/Views/Vault/EntryIconView.swift`
    or a sibling) reads the single returned `URL?` and passes it to
    `FaviconLoader`; on `nil` (never reached — `EntryIconView` only constructs it
    for non-nil) it renders the SF-Symbol fallback and issues no request. No other
    field is consumed; the contract's single return value is fully sufficient.

### C2 — `EntryTypeCategory.rowSymbol`

- **Signature**: `var rowSymbol: String { get }` (on the existing
  `EntryTypeCategory` enum, app target).
- **Invariants** (app-enforced):
  - Total over all 8 cases (exhaustive switch; compiler-enforced exhaustiveness).
  - LOGIN → `"globe"` (the favicon stand-in, matching web's `Globe` fallback).
  - All other cases return the SAME glyph as their existing `sfSymbol` (no new
    SF Symbol names introduced for non-LOGIN, so no risk of an invalid symbol).
  - Every returned string is a valid SF Symbol name (verified by the manual
    test plan rendering; `globe` is a known system symbol).
- **Forbidden patterns**: none specific.
- **Acceptance criteria**:
  - `EntryTypeCategory.login.rowSymbol == "globe"`
  - `EntryTypeCategory.login.rowSymbol != EntryTypeCategory.login.sfSymbol`
  - `rowSymbol` is non-empty for every case in `allCases`.

### C3 — `AppSettingsStore.showFavicons`

- **Signature**:
  ```swift
  public var showFavicons: Bool { get nonmutating set }
  ```
  plus a **shared key constant** exposed for the propagation read (S3/T8):
  add `Key.showFavicons` and expose
  `public static let faviconShowKey = Key.showFavicons` (PUBLIC, matching the
  `public var autoCopyTotp` access level — `AppSettingsStore` lives in `Shared`
  and `AppSettingsStoreTests.swift:3` uses non-`@testable` `import Shared`, so
  `internal` would be inaccessible to the test, T8).
- **Invariants** (app-enforced, fail-closed):
  - Absent key → `false` (opt-in; `defaults.bool(forKey:)` returns false for
    absent, which is the desired secure default — same idiom as `autoCopyTotp`).
  - Setter writes the raw Bool to the App-Group suite.
- **Forbidden patterns**:
  - `pattern: showFavicons.*default.*true — reason: opt-in must default OFF`
    (informal guard; the real check is the unit test C3-acceptance).
- **Acceptance criteria**:
  - Fresh store (no key written) → `showFavicons == false`.
  - After `store.showFavicons = true`, a new `AppSettingsStore()` over the same
    suite reads `true` (persist/hydrate symmetry, R25).
  - After `store.showFavicons = false`, reads `false`.
  - **Key consistency (behavioral, T5 — replaces the tautological literal check)**:
    `store.showFavicons = true` then `defaults.bool(forKey: AppSettingsStore.faviconShowKey) == true` —
    proves the setter writes to the key the constant names (and the getter reads
    the same key via the round-trip above). A bare
    `faviconShowKey == "showFavicons"` assertion is tautological (the constant
    aliases `Key.showFavicons`) and cannot catch an internal key drift, so it is
    NOT the guard; this read-raw-via-constant cross-check is.
- **Consumer-flow walkthrough**:
  - Consumer `EntryIconView` receives `showFavicons` as a resolved `Bool` (passed
    from the list container, see C7) and uses it as the gate: when `false`, it
    never computes a `FaviconProvider` URL and never renders `FaviconImageView`.
    Field sufficiency: a single Bool is all the consumer needs.
  - Consumer list container (`VaultListView` / `VaultCategoryListView`) reads
    `AppSettingsStore().showFavicons` at the unlocked-list boundary into `@State`
    (see C7).
  - Consumer `SettingsView` reads/writes via a `Binding<Bool>` (get → store,
    set → store + `autoLockService.recordActivity()`), mirroring
    `autoCopyTotpSelection` (SettingsView.swift:106-114).

### C4 — `EntryIconView`

- **Signature**:
  ```swift
  struct EntryIconView: View {
    let entryType: String?     // raw server type; nil → LOGIN (via EntryTypeCategory.from)
    let urlHost: String        // VaultEntrySummary.urlHost
    let showFavicons: Bool     // resolved opt-in flag
    var size: CGFloat = 32     // row default; detail passes larger
    // body: ...
  }
  ```
- **Invariants** (app-enforced):
  - When `EntryTypeCategory.from(rawType: entryType) != .login` → renders the
    type `rowSymbol` SF Symbol; **no network request** regardless of
    `showFavicons`.
  - When type == `.login`:
    - if `showFavicons == false` OR `FaviconProvider.iconURL(forHost: urlHost) == nil`
      → renders `globe` SF Symbol; **no network request**.
    - else → `FaviconImageView(host:)` (NOT `AsyncImage` — see Caching design);
      loading and failure both render the `globe` fallback; success renders the
      resized image.
  - The fallback SF Symbol path is reached for every non-success/non-LOGIN case
    (no blank icon ever — R26-adjacent: no invisible/empty state).
- **Forbidden patterns**:
  - `pattern: AsyncImage — reason: rejected in round 1 (F3); favicons use FaviconImageView/FaviconLoader so the cache is clearable + testable`
  - `pattern: URLCache.shared — reason: must use FaviconLoader's dedicated cache, not the un-clearable global (S1)`
- **Acceptance criteria** (the network/SwiftUI parts are VEC-1 manual; the
  *decision logic* is unit-tested by extracting it):
  - A pure helper `EntryIconView.decision(entryType:urlHost:showFavicons:)
    -> IconDecision` (enum: `.symbol(String)` / `.favicon(URL)`) is the
    unit-testable seam. Cases (the full matrix — T3):
    - non-LOGIN type, showFavicons true → `.symbol(<type glyph>)`
    - non-LOGIN type, showFavicons false → `.symbol(<type glyph>)` (5th case, T3)
    - LOGIN, showFavicons false → `.symbol("globe")`
    - LOGIN, showFavicons true, empty host → `.symbol("globe")`
    - LOGIN, showFavicons true, IP/localhost/.local host → `.symbol("globe")` (C1 nil)
    - LOGIN, showFavicons true, valid host → `.favicon(<provider URL>)`
    - `nil`/unknown entryType resolves to `.login` (via `EntryTypeCategory.from`)
      and follows the LOGIN cases.
- **Consumer-flow walkthrough**:
  - Consumer `EntrySummaryRow` constructs `EntryIconView(entryType:
    summary.entryType, urlHost: summary.urlHost, showFavicons: <resolved>)`.
    Reads `summary.entryType` and `summary.urlHost` — both present on
    `VaultEntrySummary` (confirmed: VaultEntrySummary.swift:6,8,32).
  - Consumer `EntryDetailView` constructs the same with `size:` larger. Same
    fields; both present on the `summary` it already holds.

### C5 — `EntrySummaryRow` (modified)

- **Signature** (CHANGED, F2): `let summary: VaultEntrySummary` **+
  `let showFavicons: Bool`**; body gains a leading `EntryIconView` inside an
  `HStack`. Both call sites (VaultListView.swift:341,
  VaultCategoryLanding.swift:98) pass the resolved flag.
- **Invariants**:
  - Title + username text content is unchanged (no regression to existing
    layout semantics beyond adding the leading icon).
  - The row does NOT read the store itself — `showFavicons` is passed in as a
    `let` from the list container (resolved once per render, C7).
- **Acceptance criteria**: row renders icon + title + username; verified in the
  manual plan (VEC-1/VEC-3) and by the existing row being used (with the new
  parameter) in both `VaultListView.entryList` and `VaultCategoryListView`.

### C6 — `CategoryCard` restyle (modified)

- **Signature**: unchanged (`symbol`, `label`, `count`).
- **Invariants**:
  - Glyph renders as white on an accent-colored filled rounded-rect badge
    (replaces `.foregroundStyle(.tint)` transparent look).
  - No behavioral/count change; purely visual.
- **Acceptance criteria**: visual, manual plan (VEC-3). No unit assertion.

### C7 — `showFavicons` reactive propagation to rows (REVISED, F2/T2/S3)

- **Subject**: how the resolved Bool reaches `EntryIconView` inside list rows,
  reactively, WITHOUT an introspection-proof `@AppStorage` literal.
- **Decision** (replaces round-1 `@AppStorage`-literal approach, T2; F6/F7):
  - `VaultListView` (the OWNER of the settings sheet) holds
    `@State private var showFavicons: Bool` and a helper
    `private func resolveShowFavicons() { showFavicons = AppSettingsStore().showFavicons }`.
  - `resolveShowFavicons()` is called: `.onAppear`; on `scenePhase == .active`
    (the existing `.onChange(of: scenePhase)`, VaultListView.swift:119-123); and
    on settings-sheet dismissal — **which requires adding an explicit
    `onDismiss:` to the existing sheet** (VaultListView.swift:96 currently has
    NO `onDismiss` — F7): `.sheet(isPresented: $isShowingSettings, onDismiss: { resolveShowFavicons() })`.
  - **`VaultCategoryListView` does NOT own the sheet and has no scenePhase hook**
    (VaultCategoryLanding.swift:56-119) — F6. It must receive the resolved value
    from its parent. `VaultListView` already threads `viewModel` (a `@Bindable`)
    into `VaultCategoryListView`; thread `showFavicons` the same way as a
    parameter so when `VaultListView` re-resolves, the pushed category list
    re-renders with the new value. (A pushed `VaultCategoryListView` stays in the
    nav stack while the parent's `@State` updates, so passing the value — not a
    local re-read — is what makes it reactive.)
  - The `Bool` is passed to every `EntrySummaryRow(summary:showFavicons:)` in
    BOTH views (VaultListView.swift:341, VaultCategoryLanding.swift:98).
  - No `@AppStorage` literal exists, so there is no View-internal key string to
    drift (T2 is structurally eliminated). The single key string lives only in
    `AppSettingsStore` and is referenced via the `faviconShowKey` constant (S3).
- **Forbidden patterns**:
  - `pattern: @AppStorage\("showFavicons" — reason: round-1 T2 rejected the @AppStorage-literal approach; resolve via AppSettingsStore() into @State instead`
- **Acceptance criteria**: the FR-4 live re-render is VEC-3 (manual — SwiftUI
  reactivity is not unit-testable). The key SSoT is covered by C3's behavioral
  key-consistency test (write via setter → read raw via `faviconShowKey`), not a
  bare literal-equality or View-literal test.

### C8 — Favicon cache clear on sign-out (R39) (REVISED, T1/S1)

- **Signature**: `AutoLockService.init` gains
  `faviconCacheClearing: @escaping () -> Void = { FaviconLoader.shared.clearCache() }`
  (mirrors the `teamDirectoryStore` spy-injection pattern,
  AutoLockServiceTests.swift:327-366). `signOut(reason:)` calls it;
  `FaviconLoader.clearCache()` does `urlCache.removeAllCachedResponses()` PLUS
  `FileManager.default.removeItem(at: faviconCacheDir)`.
- **CORRECTION (round 2, S1 escalated Critical)**: the round-1 claim that
  `signOut()`'s existing `removeItem(at: cacheURL)` provides "defense-in-depth"
  deletion of the favicon dir is **FALSE and removed**. Verified at
  AutoLockService.swift:107-110: `cacheURL` is the `encryptedEntries.cache`
  **FILE** (AppGroupContainer.cacheFileURL → `<vault>/encryptedEntries.cache`),
  not the `vault/` directory. The `vault/favicon-cache/` subdir is a SIBLING of
  that file and is NOT removed by it. Therefore **`FaviconLoader.clearCache()` is
  the SOLE deletion path** — it must be treated as mandatory, never optional
  redundancy.
- **Invariants**:
  - On `signOut`, favicon cached bytes AND on-disk cache keys (host-derived) are
    removed by `clearCache()` (R39 — metadata cleared at session end,
    forensic/backup-safe). This is the only deleter; the production
    `AutoLockService.init` in RootView.swift MUST use the default closure (or pass
    an equivalent) — a missing/omitted closure leaves the host list on disk.
  - **Verified (round 2, orchestrator) that `signOut()` is the SOLE logout path**:
    `.loggedOut` is reached only via `signOut()` — manual (VaultListView.swift:141)
    or idle-timeout (AutoLockService.swift:123). The `authenticationRequired`
    sync error path surfaces an alert, it does NOT force logout
    (VaultListView.swift:382-385), so no token-clear path bypasses the favicon
    clear. (`DebugVaultLoader` is debug-build only and not a user logout.) This
    closes S1's "is there a sign-out path that skips the clear?" question.
  - `clearCache()` is called BEFORE `state = .loggedOut` is set, so the spy/test
    can assert ordering and the in-flight-fetch race is closed by `@MainActor`
    serialization (see below).
  - **No re-populate race (F9/S8/T7)**: `AutoLockService` is `@MainActor` and
    SwiftUI `.task` favicon fetches also run on `@MainActor`'s serial executor, so
    `signOut()`'s `clearCache()` cannot interleave with an in-flight
    `FaviconImageView` fetch — the list's `.task`s are cancelled on teardown and
    cannot resume mid-`signOut`. Documented, not merely asserted.
  - On `lock` (not sign-out): no favicon clear (lock keeps the encrypted cache by
    existing design); asserted by the test with a SEPARATE service instance/spy so
    `signOut`'s internal `lock()` call (AutoLockService.swift:102) is not
    miscounted (T7).
- **Forbidden patterns**:
  - `pattern: URLCache.shared — reason: S1 — must be FaviconLoader's dedicated cache in the vault dir, not the un-clearable global`
- **Acceptance criteria**: unit test injects a spy closure into `AutoLockService`,
  asserts on a fresh instance that `signOut()` invokes it exactly once, and on a
  SEPARATE fresh instance that `lock()` does NOT (RT5 — the test's call path is
  the production `signOut`/`lock`; two instances per T7).

### C9 — `FaviconLoader` + `FaviconImageView` (dedicated cache + custom loader)

- **Signature**:
  ```swift
  @MainActor
  final class FaviconLoader {
    static let shared: FaviconLoader
    // init: create <AppGroup>/vault/favicon-cache/ explicitly (createDirectory,
    //   withIntermediateDirectories:true — F10: AppGroupContainer.ensureDirectoryExists
    //   creates only vault/, NOT the subdir), then
    //   URLCache(memoryCapacity:4MB, diskCapacity:16MB, directory: <that dir>);
    //   session = URLSession(configuration: .ephemeral with .urlCache = cache).
    // Injectable session for tests (S6/T6):
    init(session: URLSession = FaviconLoader.makeEphemeralSession())
    func image(forURL url: URL) async -> Image?   // nil on any failure → caller shows globe
    func clearCache()                              // removeAllCachedResponses() + removeItem(at: dir)
    static func faviconCacheDirectory() -> URL     // pure, unit-testable
  }
  struct FaviconImageView: View {
    let url: URL
    var size: CGFloat
    // @State private var image: Image?  — loads via .task { image = await FaviconLoader.shared.image(forURL:) }
    // shows `globe` placeholder while nil (loading or failure)
  }
  ```
- **Invariants** (app-enforced):
  - `FaviconLoader.init` explicitly creates `<AppGroup>/vault/favicon-cache/` via
    `try? FileManager.default.createDirectory(at:withIntermediateDirectories:true)`
    BEFORE constructing the `URLCache` (F10 — the existing
    `AppGroupContainer.ensureDirectoryExists` creates only `vault/`, so the
    subdir would otherwise be absent and the disk cache would silently no-op).
  - The session is built from `URLSessionConfiguration.ephemeral` with only the
    dedicated `.urlCache` attached (S6): `.ephemeral` sets `httpCookieStorage =
    nil`, `urlCredentialStorage = nil`, `httpShouldSetCookies = false` — so no
    cookie/credential/HSTS side-channel survives sign-out, and the only on-disk
    state is the dedicated cache dir (which `clearCache()` deletes).
  - `image(forURL:)` returns `nil` on any non-2xx / decode-failure / network
    error; it never throws to the view (the view always has a `globe` fallback).
  - Image bytes are decoded OFF the main actor (S/F8): decode via
    `UIImage(data:)` inside `await Task.detached { … }.value` (or a nonisolated
    helper), then wrap in SwiftUI `Image` — so ICO/PNG decode never stalls
    scrolling (NFR-2).
  - The session uses the loader's dedicated `URLCache`, NOT `URLCache.shared` and
    NOT `URLSession.shared` (S1/S7).
  - `FaviconImageView`'s `.task` is cancellable; SwiftUI cancels it on cell reuse
    / disappearance (NFR-2 — no leaked requests on fast scroll). Per-row tasks are
    acceptable: URLSession auto-throttles concurrent connections per host and the
    dedicated cache dedups; the live-request window is bounded by screen height.
  - Only `https` URLs reach the loader (C1 guarantees scheme; the loader does not
    construct URLs itself).
- **Forbidden patterns**:
  - `pattern: URLCache.shared — reason: S1`
  - `pattern: URLSession.shared — reason: S7 — favicon requests use the loader's private ephemeral session, not the global (shared cache + shared cookie jar)`
  - `pattern: URLSessionConfiguration.default — reason: S6 — use .ephemeral to suppress cookie/credential/HSTS persistence`
  - `pattern: AsyncImage — reason: F3`
- **Acceptance criteria**:
  - The SwiftUI `FaviconImageView` body render is VEC-1 (manual).
  - `faviconCacheDirectory()` is unit-tested to sit under the vault dir.
  - **`image(forURL:)` failure handling IS unit-testable (T6)** via the injectable
    `session` + the existing `MockURLProtocol` pattern (MobileAPIClientTests.swift:9-41).
    `FaviconLoaderTests` asserts: 404 → `nil`, network error → `nil`,
    non-image body → `nil`, 200 + minimal PNG → non-nil `Image`. This path is
    reclassified from VEC-1/manual to **verifiable-local**.
- **Consumer-flow walkthrough**:
  - Consumer `EntryIconView` constructs `FaviconImageView(url:size:)` only in the
    LOGIN + opt-in + non-nil-URL branch (C4). Reads nothing else.
  - Consumer `AutoLockService.signOut` calls `FaviconLoader.shared.clearCache()`
    via the injected closure (C8).

### C10 — `PrivacyInfo.xcprivacy` browsing-history declaration (S4)

- **Signature**: edit `ios/PasswdSSOApp/PrivacyInfo.xcprivacy` —
  `NSPrivacyCollectedDataTypes` gains one dict:
  `NSPrivacyCollectedDataTypeBrowsingHistory`, `Linked=false`, `Tracking=false`,
  `Purposes=[NSPrivacyCollectedDataTypePurposeAppFunctionality]`.
- **Invariants**: the declaration is accurate for the OFF-by-default behavior
  (data sent only when opted in; not linked to identity; not used for tracking).
- **Forbidden patterns**: none.
- **Acceptance criteria**: the plist parses (xcodebuild succeeds) and contains the
  new entry. Verified at build + App Store submission (manual/release step).
- **Consumer-flow walkthrough**: N/A (declarative manifest; no code consumer).

## Go/No-Go Gate

| ID  | Subject                                                          | Status |
|-----|------------------------------------------------------------------|--------|
| C1  | `FaviconProvider.iconURL(forHost:)` (provider + IP/local guard)  | locked |
| C2  | `EntryTypeCategory.rowSymbol`                                    | locked |
| C3  | `AppSettingsStore.showFavicons` + `faviconShowKey` (opt-in, OFF) | locked |
| C4  | `EntryIconView` + `FaviconImageView` + pure `decision(...)` seam | locked |
| C5  | `EntrySummaryRow` leading icon (+`showFavicons` param)           | locked |
| C6  | `CategoryCard` filled-badge restyle                             | locked |
| C7  | `showFavicons` reactive propagation (AppSettingsStore→@State)    | locked |
| C8  | Favicon cache clear on sign-out (dedicated cache + seam, R39)    | locked |
| C9  | `FaviconLoader` (dedicated `URLCache` in vault dir) + image view | locked |
| C10 | `PrivacyInfo.xcprivacy` browsing-history data-type declaration   | locked |

(All `locked` after 3 review rounds: round 1 resolved 12 findings (incl. the
F3=S1=T1 architectural cluster → un-deferred SC4), round 2 resolved 14 (incl. the
escalated S1 false-claim correction + F6/F7 reactivity), round 3 resolved 2
internal-consistency contradictions (F11/F12). No open Critical/Major.)

## Testing strategy

- **Unit (XCTest, `ios/PasswdSSOTests/`)**:
  - `FaviconProviderTests`: C1 acceptance (URL build, nil cases incl. IP /
    localhost / `.local`, https, host sanitization, forbidden-provider absence).
  - `EntryTypeCategoryTests` (extend existing): C2 `rowSymbol` cases.
    `testAllCasesCountIsEight` remains as the new-case guard (F4).
  - `AppSettingsStoreTests` (extend existing): C3 default-OFF, persist/hydrate
    round-trip (R25), and the behavioral key-consistency test (write
    `showFavicons = true` → `defaults.bool(forKey: AppSettingsStore.faviconShowKey)
    == true`) — replaces the tautological literal check the round-2 T5 rejected.
  - `EntryIconDecisionTests`: C4 pure-decision matrix (the full 6-row matrix
    incl. non-LOGIN+OFF (T3) and IP/local-host nil case).
  - `AutoLockServiceTests` (extend): C8 — inject a spy `faviconCacheClearing`
    closure; assert `signOut` calls it once (fresh instance) and `lock` does NOT
    (SEPARATE fresh instance, T7) (T1, RT5).
  - `FaviconLoaderTests` (new): C9 `image(forURL:)` failure handling via injectable
    `session` + `MockURLProtocol` (MobileAPIClientTests.swift:9-41): 404 → nil,
    network error → nil, non-image body → nil, 200+minimal PNG → non-nil (T6).
    Plus `faviconCacheDirectory()` sits under the vault dir.
  - NOTE: only `FaviconImageView`'s SwiftUI body render is NOT unit-testable
    (VEC-1, manual). `image()` failure handling and `clearCache()` (via the C8
    seam) ARE covered above.
- **Manual (R35 artifact, `*-manual-test.md`)**: VEC-1 (favicon renders on
  device with opt-in ON), VEC-2 (cache survives lock, cleared on sign-out),
  VEC-3 (toggle live re-render; OFF→no network via Charles/Console).
- **Two-filter rule applied**: pure logic → unit tests; only network-render,
  on-device cache timing, and live re-render go in the manual plan.

## Considerations & constraints

### Scope contract

- **SC1** — Self-hosted favicon proxy (`src/app/api/mobile/favicon` + SSRF guard
  + rate limit + server-side cache + auth). Owner: future iOS+server PR. The
  privacy-optimal end state; deferred because it expands scope into `src/`.
  Anti-Deferral cost-justification recorded in Technical approach.
- **SC2** — Web app's Google-direct favicon call
  (`src/components/passwords/shared/favicon.tsx`) privacy review. Owner: separate
  web PR. Explicitly out of scope (task says so). `TODO(ios-favicon-optin): SC2`.
- **SC3** — AutoFill extension favicons. Owner: none (not feasible).
  `ASPasswordCredentialIdentity` / `ASPasskeyCredentialIdentity` carry **no icon
  field** (CredentialIdentityRegistrar.swift:243-257); the system keyboard
  renders its own chrome. Favicons are structurally impossible in AutoFill rows
  → permanently out of scope, not deferred.
- **SC4** — ~~Dedicated `URLCache` instance (vs shared), deferred follow-up.~~
  **UN-DEFERRED in round 1** (F3=S1=T1). A dedicated `URLCache` in
  `<AppGroup>/vault/favicon-cache/` is now a pre-merge requirement (C8/C9): it is
  the only way to make the sign-out clear (R39) real, clearable, and testable.
  `AsyncImage` + `URLCache.shared` was rejected. No longer a scope-out.

### Privacy disclosure (REQUIRED before merge)

- The Settings footer MUST disclose, in user-facing copy, that enabling the
  toggle sends entry domain names to the favicon provider (DuckDuckGo). Copy must
  NOT leak internal jargon (R37) and must name the actual provider.
- **`PrivacyInfo.xcprivacy` (CHANGED after round 1, S4)**: the
  `NSPrivacyAccessedAPITypes` exemption for URLSession still holds, but
  `NSPrivacyCollectedDataTypes` is a separate obligation. Because the opt-in
  fetch sends user-vault domain names (browsing-history-adjacent data) to a third
  party, add an `NSPrivacyCollectedDataTypeBrowsingHistory` entry
  (Linked=false, Tracking=false, Purpose=AppFunctionality) — see C10. The
  round-0 claim "no manifest change required" is overturned.
- **App Store listing / privacy policy**: the iOS listing + privacy policy must
  gain a line stating that, *when the optional "Show site icons" setting is
  enabled*, domain names are sent to DuckDuckGo to retrieve icons. This is a
  **documentation/listing** obligation, tracked as a manual-test/release step.

### Known risks

- **DuckDuckGo availability/format**: the `ip3/<host>.ico` endpoint is a public,
  undocumented-but-stable service. Failure → SF Symbol fallback (FR-2), so an
  outage degrades gracefully to the OFF-state appearance. No correctness risk.
- **R8 (UI consistency)**: the row icon badge and category badge should share a
  consistent visual style (size aside). Plan uses the same filled-badge idiom for
  both; Phase 3 verifies.

## User operation scenarios

1. **Default user (never opts in)**: opens vault → rows show type SF Symbols,
   LOGIN rows show `globe`. Category grid shows filled badges. Zero network
   favicon requests. (The common case; the privacy-safe path.)
2. **Opt-in user**: Settings → toggles "Show site icons" ON → returns to list →
   LOGIN rows with a host now show the site favicon; types still show SF Symbols;
   LOGIN rows without a host still show `globe`.
3. **Opt-in user, offline / provider down**: LOGIN rows fall back to `globe`; no
   spinner-stuck state (`FaviconLoader.image(forURL:)` returns `nil` →
   `FaviconImageView` shows the `globe` placeholder).
4. **Opt-in user signs out**: favicon cache cleared (R39); on next sign-in with
   opt-in still ON, icons re-fetch fresh.
5. **Opt-in user locks (not sign-out)**: re-unlock shows icons from cache (lock
   keeps cache by design).
6. **Edge host**: an entry whose `urlHost` is empty (secure note saved as LOGIN
   with no URL) → `globe`, no request.
