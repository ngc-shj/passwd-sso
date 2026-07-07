# Plan: iOS Search Enablement, Sort Keys, and Settings Version Row

## Project context

- **Type**: mixed — this PR is iOS-only (SwiftUI app in `ios/`), but plumbs two new fields through a wire model that mirrors a server response shape in `src/`.
- **Test infrastructure**: unit tests (`ios/PasswdSSOTests`, XCTest) + UI tests (`ios/PasswdSSOUITests`) + CI (xcodegen → xcodebuild). Build env is available locally (`xcodebuild`, Xcode 26.4.1); `xcodegen generate` regenerates the pbxproj.
- **Verification environment constraints**:
  - **VC1** — `xcodebuild test` on the iOS simulator is available locally (see memory `ios-build-env-available`). All new unit tests are `verifiable-local`. The three feature behaviors (search on category screens, sort menu, version row) are `verifiable-local` via unit tests over `VaultViewModel`/`AppSettingsStore` plus a manual simulator run.
  - **VC2** — Real end-to-end date-sort correctness (createdAt/updatedAt values actually arriving from a live server through sync) requires a running passwd-sso server with real entries. This is `verifiable-local` only if a dev server is reachable; otherwise the date-plumbing is `verifiable-CI`/unit via a fixture `CacheEntry` carrying known dates. We do NOT require a live server: the golden-fixture test (T-DATE) exercises decode→summary→sort with fixed dates and is the authoritative check.
  - **VC3** — Bundle version string (`CFBundleShortVersionString`) resolves to the xcodegen-substituted `MARKETING_VERSION` only in a real build, not in unit-test host bundles reliably. The version-row logic is tested against an **injected** provider (not `Bundle.main` directly) so the test is `verifiable-local`; the real substituted value is confirmed by the manual simulator run.

## Objective

Three user-requested iOS improvements, mirroring existing web behavior where one exists:

1. **Search on every category screen.** Today the search field lives only on the top-level `VaultListView` bottom bar; category screens (`VaultCategoryListView` — Logins, Passkeys, tag screens, etc.) inherit the query but offer no way to *enter* or *edit* a search while inside them. Add a search affordance to the category screens, scoped to the current category.
2. **Sort key selection.** Add a sort menu with four keys — Title, Created date, Updated date, Website — selectable on the list screens, with the selected key persisted across launches. iOS currently has no sort at all. **Parity note (F1):** the web app's `EntrySortOption` (`src/lib/vault/entry-sort.ts:1`) has only THREE keys — `title`/`createdAt`/`updatedAt`; there is **no `website` key on web**. This plan mirrors web semantics for those three keys (direction, favorites-first) and adds `website` as an **iOS-only** key sorting on `urlHost` ascending. `website` therefore has no web reference implementation and its semantics are defined fully in C1 below. Created/Updated dates are not yet carried to iOS; this plan plumbs them through the sync pipeline.
3. **App version in Settings.** Display the app marketing version (and build number) in the Settings screen. Not shown anywhere today.

## Requirements

### Functional

- **FR1** Search is enterable/editable on category screens and filters within the current category only (confirmed with user: "現在のカテゴリ内のみ"). The top-level global search behavior is unchanged.
- **FR2** A sort menu offers exactly four keys: Title, Created date, Updated date, Website. Direction is fixed per key: title & website ascending (case-insensitive via `localizedCaseInsensitiveCompare`), created & updated descending (newest first) — the three shared keys match web `entry-sort.ts`. Favorites-first ordering is **preserved** as the primary sort (matching web `compareEntriesWithFavorite`). Nil/empty sort values (nil dates on team/legacy entries; empty `urlHost`) sort AFTER all populated values on that key (see C1). The overall sort is **stable** (equal-key ties preserve prior/input order) — enforced via an index tie-break, because Swift's `sorted(by:)` is not guaranteed stable (F/T finding T4).
- **FR3** The selected sort key persists across app launches (confirmed with user: "永続化する") via `AppSettingsStore` (App Group UserDefaults), fail-closed to `.title`. **Default is deliberately `.title`, NOT web's `.updatedAt`** (F3): date keys are `nil` for team/legacy entries and for ALL personal entries until the first post-upgrade sync backfills them, so a date default would present an apparently-unsorted list on first launch; `.title` is the one key with a value on every entry. This divergence from web is intentional, not an oversight.
- **FR4** Created/Updated timestamps flow from the server `/api/passwords` GET response (which already returns `createdAt`/`updatedAt` as ISO-8601 strings — `src/app/api/passwords/route.ts:95-96`) through `EncryptedEntry` → `CacheEntry` → `VaultEntrySummary`. Team entries have no created/updated in their wire model; they decode to `nil` and sort last on date keys (documented, not a bug).
- **FR5** Settings shows the app version. Format: marketing version and build number, e.g. `0.4.65 (0.4.65)`.

### Non-functional

- **NFR1** No change to the E2E encryption contract. `createdAt`/`updatedAt` are **non-secret server metadata** carried on the cache row alongside the existing `entryType`/`isFavorite` — NOT inside the encrypted blob. This exactly mirrors how `entryType`/`isFavorite` are already threaded (`EntryBlobDecoder.summary` sets `lastAccessedAt: nil` and takes metadata as separate params).
- **NFR2** Backward/forward-compatible cache: `CacheEntry` is a `Codable` persisted to disk. New date fields MUST be `Optional` so an older cache (written before this change) still decodes (nil dates). This mirrors the `entryType`/`isFavorite` optionality rationale documented on `CacheEntry`.
- **NFR3** All new UI strings go through the localization catalog (`.xcstrings`) — both `en` and `ja`. See memory `ios-string-catalog-notes` for the extraction pitfalls.

## Technical approach

### Data flow for dates (FR4)

Server GET `/api/passwords` already returns `createdAt`/`updatedAt`. The iOS `EncryptedEntry` wire model (`ios/PasswdSSOApp/Vault/EntryFetcher.swift`) has an **explicit `CodingKeys`** whitelist that currently drops them. The plumbing:

```
/api/passwords GET (createdAt, updatedAt: ISO strings)
  └─> EncryptedEntry (add optional Date fields + CodingKeys entries)
        └─> EncryptedEntry.toPersonalCacheEntry() (pass dates through)
              └─> CacheEntry (add optional Date fields; persisted to App Group cache)
                    └─> VaultViewModel.decryptOverview (pass dates into decoder)
                          └─> EntryBlobDecoder.summary(...createdAt:updatedAt:) (set on summary)
                                └─> VaultEntrySummary (add optional Date fields)
                                      └─> sort comparator reads them
```

Decoding ISO-8601 strings → `Date`: **Decision**: decode as optional `String` on the wire model and convert with the EXISTING dual-variant parser, because the existing `fetchEntries` decoder (`MobileAPIClient.fetchEntries`, a bare `JSONDecoder()` with no `dateDecodingStrategy`) is shared and changing its global strategy could affect other fields. Keeping the raw string local and converting at the `toPersonalCacheEntry()` boundary avoids a global decoder-strategy change. `CacheEntry`/`VaultEntrySummary` store `Date?`.

**REUSE, do not reimplement (F6/S5/T5)**: `AutofillTokenRefresher.parseISO8601(_:)` (`ios/PasswdSSOApp/Auth/AutofillTokenRefresher.swift:57-64`) ALREADY implements the required tolerant parse — it tries a fractional-seconds `ISO8601DateFormatter` first, then falls back to the plain one. A single formatter with `.withFractionalSeconds` FAILS on non-fractional strings (and vice versa); the dual attempt is mandatory. Because `EncryptedEntry`/`EntryFetcher` (host-app target) and any Shared consumer need it, **relocate the parse logic into `Shared`** (e.g. a `Shared/ISO8601.swift` free function `parseISO8601(_:) -> Date?`) — do NOT copy it (DRY) and do NOT move the whole `AutofillTokenRefresher` type into Shared (R10: it pulls app-target deps; Shared has no deps, app→Shared is the correct direction, so a free function is safe).

**Preserve existing call sites (R2-T1)**: `AutofillTokenRefresher.parseISO8601` is called directly as a static method by production code (`AutofillTokenRefresher.swift:41` via `Self.parseISO8601`) AND by existing tests (`AutofillTokenRefresherTests.swift:86/114/115/116`). To avoid breaking those, keep a thin **forwarding shim** `static func parseISO8601(_ s: String) -> Date? { Shared.parseISO8601(s) }` on `AutofillTokenRefresher` — DRY at the implementation, zero call-site churn. Do NOT delete the static method outright.

Team entries (`TeamEncryptedEntry.toCacheEntry`) have no createdAt/updatedAt on their wire model → pass `nil` (documented in FR4).

### Sort (FR2/FR3)

- New shared enum `EntrySortOption` in `Shared` (mirrors web `entry-sort.ts` type). Cases: `.title`, `.createdAt`, `.updatedAt`, `.website`. `String`-backed rawValues for persistence.
- New pure comparator `EntrySortOption.compare(_:_:) -> Bool` (or a `sorted(_:)` helper) applying favorites-first then the key, matching `compareEntriesWithFavorite`.
- `VaultViewModel.filteredSummaries` applies the sort as the final step (after scope + search filter). Sort key read from a new `sortOption` property, initialized from `AppSettingsStore`.
- Persistence: new `AppSettingsStore.entrySortOption: EntrySortOption` fail-closed getter/setter (default `.title` — chosen because it is the one key with data guaranteed present on every entry, personal and team; date keys are nil for team/legacy entries).

### Search on category screens (FR1)

- `VaultCategoryListView` gains a `.searchable(text: $viewModel.searchQuery, ...)` modifier (or a bottom search field consistent with `VaultListView`). Since `viewModel.searchQuery` is shared state and `entries` already composes `filteredSummaries.filter { matches($0, category) }`, wiring a search binding into the category screen filters within the category automatically.
- **Decision**: use `.searchable()` on the category screen (the pushed nav view) rather than replicating the custom bottom bar, because a pushed view with a nav bar is the idiomatic place for `.searchable()` and `DemoVaultView` already uses this exact pattern (`DemoVaultView.swift:45`). The top-level `VaultListView` keeps its bottom-bar field unchanged.
- **Screen-recording invariant (S1)**: `.searchable()` attaches to the outer container (`Group`/nav chrome — the search *bar* itself shows no secrets, only the query the user typed). Entry-row rendering MUST stay inside the existing `else` (`!isScreenRecording`) branch of `VaultCategoryListView.body` (`VaultCategoryLanding.swift:92-135`) — exactly as `DemoVaultView.swift:45` does. Never render filtered result rows outside the `if isScreenRecording` gate, or entry titles/usernames leak into a screen recording / AirPlay mirror.
- **Cross-screen query UX (F5)**: the category `.searchable` and the top-level bottom-bar field both write the SAME shared `viewModel.searchQuery`. Consequences to verify in the manual sim run: (a) a query typed at top level carries into the category `.searchable` pre-populated; (b) `.searchable`'s system Cancel clears the shared query, emptying the top-level field too; (c) on returning from a category with a non-empty query, the top-level view is in `entryList` mode (not the category grid), because `VaultListView` switches on `searchQuery.isEmpty` (`VaultListView.swift:43-47`). These are consistent with "search is global state" and are acceptable, but MUST be confirmed on-device/sim (VC1), not assumed.
- **Search query lifecycle**: `VaultListView` clears `searchQuery` on scope change (`VaultListView.swift:186`). Entering a category does NOT clear it — a query typed at top level carries in. Verify this is acceptable UX (it is: the category screen shows the same filtered set the count promised). On leaving the category, the query persists back to the top-level field (shared state) — this matches "search is global state" and is not a regression.

### Version row (FR5)

- Add a `LabeledContent("Version")` row to `SettingsView` (new bottom section or in the existing Server section footer area).
- **Testable seam is a closure/protocol, NOT `Bundle` injection (T1)**: `Bundle` has no public initializer accepting an arbitrary `infoDictionary`, so a synthetic `Bundle` with known version keys cannot be built in XCTest — a `Bundle(for:)` test bundle carries the xcodegen-substituted `MARKETING_VERSION`, not a fixed test value, making a `Bundle`-injected version test either uncompilable or vacuous. Instead inject the raw lookups:
  ```swift
  public struct AppVersion {
    public static func display(
      marketing: String? = Self.infoValue("CFBundleShortVersionString"),
      build: String? = Self.infoValue("CFBundleVersion")
    ) -> String
    private static func infoValue(_ key: String) -> String? {
      Bundle.main.object(forInfoDictionaryKey: key) as? String
    }
  }
  ```
  The default arguments read the real `Bundle.main` Info.plist in production; tests call `AppVersion.display(marketing: "0.4.65", build: "42")` → `"0.4.65 (42)"` and `AppVersion.display(marketing: nil, build: nil)` → fallback (e.g. `"—"`). `Bundle.main` is class-swizzled by `LanguageBundle` but only `localizedString(forKey:)` is overridden, so `object(forInfoDictionaryKey:)` returns the real Info.plist values (confirmed in exploration). The real substituted `MARKETING_VERSION` display is confirmed by the manual sim run (VC3), not a unit test.

## Contracts

### C1 — `EntrySortOption` shared enum + comparator

- **Signature**:
  ```swift
  // ios/Shared/Models/EntrySortOption.swift (new)
  public enum EntrySortOption: String, CaseIterable, Sendable {
    case title
    case createdAt
    case updatedAt
    case website
  }
  extension EntrySortOption {
    /// Favorites-first, then the selected key. Mirrors web compareEntriesWithFavorite.
    public func sorted(_ summaries: [VaultEntrySummary]) -> [VaultEntrySummary]
  }
  ```
- **Invariants**:
  - **app-enforced**: `sorted` is favorites-first — favorites always precede non-favorites **regardless of key** (matches `compareEntriesWithFavorite`: `if a.isFavorite !== b.isFavorite return a.isFavorite ? -1 : 1`). The favorite split is applied BEFORE the per-key comparison, never inside a single key's branch (the porting mistake T3 guards against).
  - **app-enforced**: date keys sort descending (newest first); `title`/`website` ascending, case-insensitive, using `localizedCaseInsensitiveCompare` (the Swift analogue of JS `localeCompare`).
  - **app-enforced (nil/empty sort-last)**: a `nil` date on a date key sorts AFTER all non-nil entries on that key; an empty (`""`) `urlHost` on the `website` key sorts AFTER all non-empty hosts. `urlHost` is a non-optional `String` that is `""` (never `nil`) for non-web entry types (secure notes, identities, …) — so `""` is treated as the "empty" sort-last sentinel for `website`, exactly as `nil` is for date keys (F2). Team/legacy entries and non-web entries therefore never jump to the top.
  - **app-enforced (stability, T4)**: the sort is **stable** — equal-key ties (including nil-vs-nil and `""`-vs-`""`) preserve input order. Swift's `sorted(by:)` is NOT guaranteed stable, so `sorted` MUST enforce stability explicitly, e.g. sort `summaries.enumerated()` with the original index as the final tie-breaker. Do NOT rely on `sorted(by:)` being stable.
  - **app-enforced**: `website` key sorts on `urlHost` (the summary field), ascending, non-empty-first.
- **Forbidden patterns**:
  - `pattern: dateDecodingStrategy\s*=\s*\.iso8601` in the shared `fetchEntries` decoder path — reason: a global strategy change risks other fields; dates are converted locally (see C4).
  - `pattern: Locale\.current` in EntrySortOption — reason: sorting must not depend on ambient locale for test determinism; use `localizedCaseInsensitiveCompare` on the String directly.
- **Acceptance criteria**:
  - `EntrySortOption.title.sorted([b:"Beta", a:"Alpha"])` → `[a, b]`.
  - **Favorites-first holds for EVERY key** (T3): a favorite entry that would sort last on the key precedes an alphabetically/chronologically-first non-favorite, tested under `.title`, `.createdAt`, `.updatedAt`, AND `.website`.
  - Under `.createdAt` AND `.updatedAt` (both keys, T4): an entry with a later timestamp precedes an earlier one; a `nil`-date entry sorts last on that key.
  - Under `.website`: an entry with `urlHost=""` sorts after entries with a non-empty host.
  - **Stability (T4)**: two entries with equal keys (e.g. same title, or both nil createdAt) preserve their input relative order.
  - `.allCases.count == 4`.

### C2 — `VaultEntrySummary` gains `createdAt`/`updatedAt`

- **Signature**: add to `ios/Shared/Models/VaultEntrySummary.swift`:
  ```swift
  public let createdAt: Date?
  public let updatedAt: Date?
  ```
  plus init params `createdAt: Date? = nil, updatedAt: Date? = nil` (defaulted so all existing call sites — AutoFill, decoders, tests — compile unchanged).
- **Invariants**:
  - **app-enforced**: both fields default to `nil`; a summary constructed without them is valid (all AutoFill/test call sites rely on this).
  - **schema-enforced (Codable)**: `Codable` conformance still round-trips; both being `Optional` means an older encoded summary (if any is persisted) still decodes.
- **Forbidden patterns**:
  - `pattern: createdAt: Date\b` (non-optional) in VaultEntrySummary — reason: must be `Date?` for backward-compat (NFR2).
- **Acceptance criteria**: existing `VaultEntrySummary(...)` calls with no date args still compile; new fields default `nil`.
- **Consumer-flow walkthrough** (VaultEntrySummary is a consumed shape):
  - **Consumer: sort comparator** (path: `EntrySortOption.sorted`) reads `{ createdAt, updatedAt, urlHost, title, isFavorite }` and uses `createdAt`/`updatedAt` for date-key ordering, `urlHost` for website key, `title` for title key, `isFavorite` for the primary favorites-first split. All fields present on the summary. ✓
  - **Consumer: `EntrySummaryRow`** (path: `VaultCategoryLanding.swift:40`) reads `{ title, username, entryType, urlHost }` — unchanged; does not read the new date fields. ✓
  - **Consumer: AutoFill call sites** (path: `CredentialResolver`, `CredentialPickerView`) construct summaries via decoders that will pass `nil` for the new fields (defaulted). They do not read the date fields. ✓
  - No consumer needs a field absent from the extended shape.

### C3 — `CacheEntry` gains optional `createdAt`/`updatedAt`

- **Signature**: add to `CacheEntry` (`ios/Shared/AutoFill/CredentialResolver.swift:758`):
  ```swift
  public let createdAt: Date?
  public let updatedAt: Date?
  ```
  plus defaulted init params (`= nil`).
- **Invariants**:
  - **schema-enforced (Codable, NFR2)**: both `Optional` → an on-disk cache written before this change decodes with `nil` dates (no crash, no re-sync forced). This is the same optionality contract already documented for `entryType`/`isFavorite` on `CacheEntry`.
- **Forbidden patterns**:
  - `pattern: let createdAt: Date\b` (non-optional) in CacheEntry — reason: NFR2 backward-compat.
- **Acceptance criteria**: decoding a JSON `CacheEntry` fixture that omits `createdAt`/`updatedAt` succeeds with `nil` (regression test in `CacheEntryPropagationTests`).
- **Consumer-flow walkthrough** (CacheEntry is a consumed persisted shape):
  - **Consumer: `VaultViewModel.decryptOverview`** (path: `VaultViewModel.swift:169`) reads the whole `CacheEntry` and now additionally passes `entry.createdAt`/`entry.updatedAt` into `EntryBlobDecoder.summary`. Fields present. ✓
  - **Consumer: `VaultViewModel.loadDetail`/`decryptBlob`/`rawPlaintexts`** read the entry for decryption; they do NOT need the dates (detail view does not sort). Unchanged. ✓
  - **Consumer: AutoFill `CredentialResolver`** decodes `[CacheEntry]` for QuickType; does not read dates. Optional fields decode to nil harmlessly. ✓
  - **Consumer: `HostSyncService`/`DebugVaultLoader`/tests** construct `CacheEntry` via `toPersonalCacheEntry()` / `toCacheEntry()` / literals — all use defaulted params so unchanged sites compile. ✓

### C4 — `EncryptedEntry` decodes dates + `toPersonalCacheEntry` passes them through

- **Signature**: add to `EncryptedEntry` (`EntryFetcher.swift`):
  ```swift
  public let createdAt: Date?   // decoded from ISO-8601 string on the wire
  public let updatedAt: Date?
  ```
  add `createdAt`/`updatedAt` to `CodingKeys`. `toPersonalCacheEntry()` passes them into `CacheEntry`.
- **Invariants**:
  - **app-enforced**: ISO-8601 string → `Date` conversion uses the RELOCATED `parseISO8601` (moved to `Shared` per the Technical-approach note — F6), which tries a fractional-seconds formatter then falls back to the plain one; a missing/unparseable value → `nil` (never throws; a date parse failure must not fail the whole sync). A single formatter with only `.withFractionalSeconds` would silently drop non-fractional dates — hence the reused dual-attempt.
  - **app-enforced**: the conversion is local to `EncryptedEntry` decoding; the shared `fetchEntries` `JSONDecoder` global `dateDecodingStrategy` is NOT changed (forbidden pattern in C1).
- **Forbidden patterns**:
  - `pattern: try container.decode\(Date.self, forKey: .createdAt\)` (non-optional, throwing) — reason: must be `decodeIfPresent` + tolerant parse so a bad/absent date never breaks sync.
- **Acceptance criteria**:
  - Decoding a `/api/passwords`-shaped JSON with `"createdAt":"2024-01-02T03:04:05.000Z"` yields a non-nil `Date`; `toPersonalCacheEntry()` carries it to `CacheEntry.createdAt`.
  - Decoding JSON omitting the dates yields `nil` (no throw).
- **Consumer-flow walkthrough**:
  - **Consumer: `HostSyncService`** (path: `ios/PasswdSSOApp/Vault/HostSyncService.swift`) maps fetched `EncryptedEntry` → `CacheEntry` via `toPersonalCacheEntry()`. It reads no date field directly; the mapping helper carries them. Verify HostSyncService uses `toPersonalCacheEntry()` (not a hand-rolled `CacheEntry(...)` that would drop the dates) — if it constructs `CacheEntry` inline, that site must be updated. **[Phase-2 must confirm the actual mapping site.]** ✓ pending confirmation

### C5 — `EntryBlobDecoder.summary` accepts and sets dates

- **Signature**: extend `EntryBlobDecoder.summary` (`EntryBlobDecoder.swift:248`):
  ```swift
  public static func summary(
    plaintext: Data, entryId: String, teamId: String?,
    entryType: String? = nil, isFavorite: Bool = false,
    createdAt: Date? = nil, updatedAt: Date? = nil   // new, defaulted
  ) -> VaultEntrySummary?
  ```
  Sets `createdAt`/`updatedAt` on the returned `VaultEntrySummary` (dates are cache-row metadata, NOT from the blob — same pattern as `entryType`/`isFavorite`; `lastAccessedAt` stays `nil`).
- **Invariants**:
  - **app-enforced**: defaulted params → AutoFill call sites (`CredentialResolver`) that don't pass dates compile unchanged and get `nil`.
- **Forbidden patterns**:
  - `pattern: createdAt = p\.` / decoding createdAt from the OverviewBlobPayload — reason: dates are server metadata, NOT in the encrypted overview blob; reading them from the blob is wrong (they aren't there).
- **Acceptance criteria**: `EntryBlobDecoder.summary(plaintext:…, createdAt: d1, updatedAt: d2)` returns a summary with those exact dates; called without them → `nil` dates.
- **Consumer-flow walkthrough**: sole producer is `VaultViewModel.decryptOverview`, which now passes `entry.createdAt`/`entry.updatedAt`. Team decryptor (`TeamEntryDecryptor.decryptTeamSummary`) does not pass dates → team summaries get `nil` (FR4). ✓

### C6 — `VaultViewModel` applies sort + threads dates

- **Signature**: on `VaultViewModel` (`VaultViewModel.swift`):
  ```swift
  // Injected store so tests use a clean per-test suite, not the shared App Group (T2).
  public init(settings: AppSettingsStore = AppSettingsStore())
  public var sortOption: EntrySortOption   // initialized from `settings` at init; writes back to `settings` on set
  ```
  `filteredSummaries` gains a final `sortOption.sorted(...)` step. `decryptOverview` passes `entry.createdAt`/`entry.updatedAt` into `EntryBlobDecoder.summary`.
- **Sort menu UI location (F4)**: the Sort menu is presented in the **top-level `VaultListView` toolbar** (alongside the existing "⋯" menu, or as a second toolbar item). It sets `viewModel.sortOption`. Because the sort is applied inside `filteredSummaries` (shared VM state), the pushed `VaultCategoryListView` screens automatically reflect the globally-chosen key with no additional UI. Changing sort from within a category screen is OUT of scope for this PR (SC5) — the menu lives at top level only.
- **Invariants**:
  - **app-enforced**: sort is the LAST transform in `filteredSummaries` (after scope filter + search filter) so search results are also sorted.
  - **app-enforced**: setting `sortOption` persists to the injected `settings.entrySortOption`; the initial value is read from it at VM init (fail-closed default `.title`).
- **Forbidden patterns**:
  - `pattern: allSummaries\.sorted` outside `filteredSummaries` — reason: single sort point.
- **Acceptance criteria**:
  - `filteredSummaries` returns entries in the order dictated by `sortOption` (unit test via `injectSummaries` with explicit dates on the injected summaries).
  - A VM built with `VaultViewModel(settings: AppSettingsStore(defaults: <per-test suite>))` reads its initial `sortOption` from that suite; setting `sortOption` writes it back to that suite (no shared-App-Group pollution — T2).
  - Default sort when nothing persisted is `.title`.
  - **End-to-end date threading (T7)**: a `CacheEntry` seeded with known createdAt/updatedAt, run through the real `loadFromCache`/`decryptOverview` path (using `makeCacheData` infra in `VaultViewModelTests`), yields `vm.allSummaries.first?.createdAt == expected` — proving `decryptOverview` actually passes the dates to `summary` (not merely that the two seams work in isolation).

### C7 — `AppSettingsStore.entrySortOption` persistence

- **Signature**: add to `AppSettingsStore` (`ios/Shared/Storage/AppSettingsStore.swift`):
  ```swift
  public var entrySortOption: EntrySortOption { get; nonmutating set }
  public static let entrySortOptionKey: String   // exposed for tests (mirrors fetchFaviconsCachedKey)
  ```
  Default `.title` (documented rationale: only key with data present on every entry). Fail-closed: absent/garbage rawValue → `.title`.
- **Invariants**:
  - **app-enforced**: getter fail-closed to `.title` on absent/unrecognized value (mirrors `appLanguage`/`vaultTimeoutAction` pattern).
- **Forbidden patterns**: none specific.
- **Acceptance criteria**: set `.updatedAt`, re-read via a fresh `AppSettingsStore(defaults:)` → `.updatedAt`; writing garbage to the key then reading → `.title`.

### C8 — Category-screen search wiring

- **Signature**: `VaultCategoryListView.body` gains `.searchable(text: $viewModel.searchQuery, prompt: Text("Search"))` (bound to shared VM state).
- **Invariants**:
  - **app-enforced**: `entries` remains `filteredSummaries.filter { matches($0, category) }` — search filters WITHIN the category (FR1), because `filteredSummaries` already applies the query and category membership is applied after.
  - **app-enforced**: typing in the category search updates the same `viewModel.searchQuery` the top-level bar uses (shared state) — no divergent second query.
  - **app-enforced (screen-recording, S1)**: `.searchable()` attaches to the outer container (nav chrome); the filtered entry `List` MUST remain inside the existing `else` (`!isScreenRecording`) branch of `VaultCategoryListView.body`. Entry rows never render while `isScreenRecording` is true. Mirror `DemoVaultView.swift:45`.
- **Forbidden patterns**:
  - `pattern: @State.*searchText` inside `VaultCategoryListView` — reason: must bind shared `viewModel.searchQuery`, not a local state (a local state would filter globally-then-category but not sync back, causing a stale top-level bar).
  - `pattern: List\(entries` OUTSIDE the `else`/`!isScreenRecording` branch in `VaultCategoryListView` — reason: S1 — result rows must stay gated behind the screen-recording overlay.
- **Acceptance criteria**: with a non-empty query, a category screen shows only entries that both match the query AND belong to the category (unit-level: assert `filteredSummaries.filter{matches}` semantics; UI-level: manual simulator check).
- **Consumer-flow walkthrough**: n/a (UI wiring, not a data shape). The consumed state is `viewModel.searchQuery`, already contract-tested by `VaultFilterTests`.

### C9 — `AppVersion` provider + Settings row

- **Signature** (string-lookup seam, NOT `Bundle` injection — T1):
  ```swift
  // ios/Shared/AppVersion.swift (new)
  public struct AppVersion {
    /// Defaults read the real Bundle.main Info.plist; tests pass explicit values.
    public static func display(
      marketing: String? = infoValue("CFBundleShortVersionString"),
      build: String? = infoValue("CFBundleVersion")
    ) -> String   // "0.4.65 (42)"; fallback "—" when both nil
    public static func infoValue(_ key: String) -> String? {
      Bundle.main.object(forInfoDictionaryKey: key) as? String
    }
  }
  ```
  `SettingsView` renders `LabeledContent("Version") { Text(AppVersion.display()) }`.
- **Invariants**:
  - **app-enforced**: reads `CFBundleShortVersionString` / `CFBundleVersion`; when a value is missing → a stable fallback string (`"—"`), never a crash.
  - **app-enforced (testability, T1)**: the seam is the injectable `marketing`/`build` STRING parameters, not a `Bundle` — because `Bundle` has no public `infoDictionary` initializer and a `Bundle(for:)` test bundle carries the xcodegen-substituted version, not a fixed test value. Tests inject strings directly.
- **Forbidden patterns**:
  - `pattern: Shared\.frameworkVersion` in SettingsView — reason: `frameworkVersion` is a hardcoded `"0.1.0"` unrelated to the marketing version; do not display it.
  - `pattern: display\(bundle:` — reason: T1 — a `Bundle`-injection signature yields an uncompilable/vacuous test; the seam must be the string parameters.
- **Acceptance criteria**:
  - `AppVersion.display(marketing: "0.4.65", build: "42")` → `"0.4.65 (42)"`.
  - `AppVersion.display(marketing: nil, build: nil)` → `"—"` (fallback), no crash.
  - `AppVersion.display(marketing: "0.4.65", build: nil)` → a sensible partial (e.g. `"0.4.65"`), no crash.

### C10 — Localization strings

- **Signature**: new catalog keys in `Localizable.xcstrings` (both `en`/`ja`): `"Sort"`, sort key labels (`"Title"`, `"Created date"`, `"Updated date"`, `"Website"`), `"Version"`. (`"Search"`/`"No matches"`/`"No entries"` already exist.)
- **Invariants**:
  - **schema-enforced (catalog)**: every new user-facing string has both `en` and `ja` translations (NFR3). `LocalizationCatalogTests` (existing) enforces catalog completeness — verify new keys are covered.
- **Forbidden patterns**:
  - `pattern: Text\("Sort"\)` without a corresponding catalog entry — reason: NFR3; but note per memory `ios-string-catalog-notes`, xcodebuild does not write back extraction, so keys are added manually.
- **Acceptance criteria**: `LocalizationCatalogTests` passes; both locales resolve every new key. See memory `ios-string-catalog-notes` for the `String` variable vs `LocalizedStringKey` binding pitfall (use string literals in `Text(...)`/`.searchable(prompt:)`, not `String` variables, so keys extract).

## Considerations & constraints

### Scope contract

- **SC1** — Sort direction toggle (ascending/descending per key) is out of scope. Web has fixed direction per key; iOS mirrors that. Owner: future enhancement if requested. (The screenshot's iOS-native passwords menu shows a 降順/昇順 toggle, but the web app — our parity target — does not; we mirror web semantics, not the OS Passwords app.)
- **SC2** — Sorting the AutoFill extension pickers (`CredentialPickerView`, `OneTimeCodePickerView`) is out of scope; those have their own local search and ranking (`URLMatcher.sortByURLMatch`). This PR touches only the host-app list.
- **SC3** — Adding `createdAt`/`updatedAt` to the **team** entry wire model (`TeamEncryptedEntry`) is out of scope; team date-sort keys resolve to `nil` (sort-last). Owner: future team-parity work (see memory `ios-extension-parity-roadmap`).
- **SC4** — Sorting/searching the trash view (if any) is out of scope; this PR targets the active vault list.
- **SC5** — Changing the sort key from within a pushed category screen is out of scope; the Sort menu lives only on the top-level `VaultListView` toolbar (C6). Category screens reflect the globally-chosen key automatically. Owner: future enhancement if requested.

### Known risks

- **R-A** Changing `EncryptedEntry`/`CacheEntry` shape risks breaking existing decode of on-disk caches. Mitigated by NFR2 (all new fields optional) + a regression test decoding a date-less fixture (T-DATE-COMPAT).
- **R-B** `HostSyncService` might construct `CacheEntry` inline rather than via `toPersonalCacheEntry()`, silently dropping the dates. Phase 2 MUST grep for `CacheEntry(` construction sites and confirm the personal-sync path routes through `toPersonalCacheEntry()` (C4 walkthrough). Member-set below.
- **R-C** `.searchable()` on a pushed category view plus the top-level bottom-bar field both writing `viewModel.searchQuery` could produce surprising cross-screen query persistence. Documented as intended (shared state); verified in manual run.

### Member-set derivation (R42) — `CacheEntry(` construction sites

Universally-quantified concern: "**every** personal-sync path that builds a `CacheEntry` from a fetched entry MUST carry the new dates." Defining primitive: literal `CacheEntry(` construction + the `toPersonalCacheEntry()`/`toCacheEntry()` mappers.

```
grep -rn "CacheEntry(" ios/ | grep -v Tests
```
Code-derived member list (from exploration):
- `ios/PasswdSSOApp/Vault/EntryFetcher.swift` — `toPersonalCacheEntry()` (personal; MUST carry dates — C4) and `toCacheEntry(teamId:)` (team; dates `nil` — SC3).
- `ios/PasswdSSOAutofillExtension/CredentialProviderViewController.swift` — Phase 2 confirm whether it builds cache entries on a sync path (if it re-syncs, must route through the mapper; if it only reads, no change).
- `ios/PasswdSSOApp/Debug/DebugVaultLoader.swift` — debug fixture writer; may set dates for realistic debug data (optional).
- `ios/Shared/Demo/DemoVaultFactory.swift` — demo data; dates optional.
- Test files (excluded from the control; they may set dates as fixtures).

Phase 2 obligation: re-run the grep, diff against this list, and for each **personal production sync** member confirm it routes through `toPersonalCacheEntry()` (carrying dates) — any inline personal `CacheEntry(` on a sync path that omits dates is a finding.

## User operation scenarios

1. **Search inside a category**: user taps "ログイン" (Logins) → sees the login list → pulls down / taps the search bar → types "git" → sees only login entries whose title/username/urlHost contains "git". Back out → top-level search bar shows "git" (shared state); clearing it there clears everywhere.
2. **Sort by updated date**: user opens the sort menu → picks "Updated date" → list reorders newest-first, favorites still on top → force-quits and relaunches → sort is still "Updated date". A team vault entry (no updatedAt) sorts below all personal entries under this key.
3. **Sort by title on a fresh install**: no persisted preference → defaults to Title, ascending, case-insensitive, favorites first.
4. **Check version**: user opens Settings → scrolls to the Version row → sees `0.4.65 (0.4.65)`.
5. **Legacy cache**: user upgrades the app; the on-disk cache predates the date fields → entries decode with nil dates → date sorts put them last, title/website sorts unaffected → next sync backfills real dates.

## Testing strategy

- **T-SORT** (`EntrySortOptionTests.swift`, new): title ascending case-insensitive; date descending; `website` ascending non-empty-first; `.allCases.count == 4`. **Favorites-first asserted for ALL FOUR keys** (T3), not just `.title`. **nil-date-last asserted for BOTH `.createdAt` and `.updatedAt`** (T4). **`""`-urlHost-last asserted for `.website`** (F2). **Stability asserted** (T4): equal-key ties (same title; both-nil dates) preserve input order — this test FAILS if `sorted` relies on Swift's non-stable `sorted(by:)` without an index tie-break.
- **T-VM-SORT** (extend `VaultFilterTests.swift`): `filteredSummaries` applies `sortOption` after scope+search; changing key reorders; default `.title`. Uses a VM built with an injected per-test `UserDefaults` suite (T2).
- **T-PERSIST** (extend `AppSettingsStoreTests.swift`): `entrySortOption` round-trips through an injected `UserDefaults(suiteName: UUID)` + `removePersistentDomain` teardown (T2 isolation); garbage rawValue → `.title`; absent → `.title`.
- **T-DATE** (extend `CacheEntryPropagationTests.swift`): `EncryptedEntry` decodes ISO dates in THREE forms — fractional (`.000Z`), non-fractional (`05Z`), and garbage/absent → `nil` with no throw (T5); `toPersonalCacheEntry()` carries them into `CacheEntry`.
- **T-DATE-E2E** (extend `VaultViewModelTests.swift`, new — T7): seed a `CacheEntry` with known dates, run the real `loadFromCache`/`decryptOverview` via `makeCacheData`, assert `vm.allSummaries.first?.createdAt/updatedAt` equal the seeded values — proves the threading step inside `decryptOverview`, which the isolated seam tests do not cover.
- **T-DATE-COMPAT** (extend `CacheEntryPropagationTests.swift`): a `CacheEntry` JSON fixture OMITTING the date fields decodes with `nil` (NFR2 regression) — clone of the existing `testCacheEntryDecodesNilIsFavoriteFromLegacyJSON`.
- **T-BLOB** (extend `EntryBlobDecoder` tests): `summary(...createdAt:updatedAt:)` sets the dates; called without → `nil`; dates are NOT read from the blob payload.
- **T-VERSION** (`AppVersionTests.swift`, new): `display(marketing:"0.4.65", build:"42")` → `"0.4.65 (42)"`; `display(marketing:nil, build:nil)` → `"—"`; partial (build nil) → sensible fallback, no crash (T1 — string seam, no `Bundle`).
- **T-SEARCH-CAT**: the genuinely-new C8 binding is verified by asserting the category-scoped `entries` computed property reflects `viewModel.searchQuery` (not a re-test of `filteredSummaries` — T6). The `.searchable` field's visual presence and the screen-recording gate (S1) are verified manually in the simulator (VC1). Do NOT add a `#file`-based source-grep gate for `.searchable` presence (vacuous — memory `ios-swift6-file-vacuous-gate`); if a grep gate is used at all, use `#filePath` + non-swallowing `try` and prove-red.
- **T-L10N** (existing `LocalizationCatalogTests`): passes with the new keys in both locales (`ja`/`en`). Uses string literals in `Text(...)`/`.searchable(prompt:)`, never `String` variables (memory `ios-string-catalog-notes`).
- **Mandatory checks** (memory): `xcodegen generate` (commit pbxproj), then `xcodebuild test -scheme PasswdSSOApp -destination 'id=<sim udid>'` — all tests pass. Build must succeed.

## Go/No-Go Gate

| ID  | Subject                                                        | Status |
|-----|---------------------------------------------------------------|--------|
| C1  | `EntrySortOption` shared enum + comparator (4 keys, stable, nil/empty-last) | locked |
| C2  | `VaultEntrySummary` gains createdAt/updatedAt                  | locked |
| C3  | `CacheEntry` gains optional createdAt/updatedAt (compat)       | locked |
| C4  | `EncryptedEntry` decodes dates + toPersonalCacheEntry passthru (reuse parseISO8601) | locked |
| C5  | `EntryBlobDecoder.summary` accepts/sets dates                 | locked |
| C6  | `VaultViewModel` applies sort + threads dates (injected store, top-level menu) | locked |
| C7  | `AppSettingsStore.entrySortOption` persistence                | locked |
| C8  | Category-screen search wiring (screen-recording gated)        | locked |
| C9  | `AppVersion` string-seam provider + Settings row              | locked |
| C10 | Localization strings (en/ja)                                  | locked |

All contracts are `locked` after Round-1 plan review: the Round-1 findings (F1/F2 web-parity + nil/empty semantics, F6/S5/T5 ISO parser reuse, T1 version seam, T2 injected store, T3 per-key favorites, T4 stability + both-key nil-last, T7 e2e date test, S1 screen-recording gate, F4 sort-menu location) were all reflected into the contracts above.
