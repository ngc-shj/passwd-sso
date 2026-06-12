# Plan: ios-category-landing

> Revised after Phase-1 round-1 review. Corrections: `EntryBlobDecoder.summary`
> real signature (`plaintext/entryId/teamId`, 4 call sites); `VaultEntrySummary`
> is never persisted (no Codable migration — the real concern is `CacheEntry`
> `Bool?`); `EntryTypeCategory` lives in the APP target (localized labels resolve
> against the app catalog); landing is built **in-place** in `VaultListView` (no
> NavigationStack/toolbar ownership move — the main regression surface in round-1);
> new views get the screen-recording overlay; `EntryTypeCategory` has a
> compiler-enforced `localizedLabel`.

## Project context
- **Type**: SwiftUI iOS app (`ios/PasswdSSOApp`). UI feature on the post-unlock surface.
- **Tests**: XCTest unit only; no snapshot/UI-assertion harness (view logic is unit-tested, layout is manual).
- Base: `feat/ios-category-landing` from `ios-main` (== `origin/main`).

## Objective
Replace the flat post-unlock list with an Apple-Passwords-style **category grid** (cards with counts),
each drilling into a filtered list (reusing the existing row + `EntryDetailView`). Closes parity item 6.

## Requirements
### Functional
- After unlock, when not searching, show a grid of category cards (count + SF Symbol + localized label).
- Tapping a card pushes a filtered entry list.
- Categories (in scope): **All**; by entry type (Login, Secure Note, Credit Card, Identity, Bank Account,
  SSH Key, Software License, Passkey) — a type card shows only when its count > 0; **Codes** (`hasTOTP`);
  **Favorites** (`isFavorite`); **Tags** (one card per distinct tag).
- **Search** still works: a non-empty query shows the flat search results at the root (across all
  categories), bypassing the grid (Apple-Passwords behavior). Within a pushed category, search composes.

### Deferred (confirmed correct in round-1)
- **Trash** — `/api/passwords?include=blob` returns only `deletedAt: null, isArchived: false`; trashed
  entries are never synced to the device. Needs a sync change → separate branch.
- **Watchtower** — no iOS security-audit client exists. Out of scope.

### Non-functional
- Counts from in-memory summaries; no extra network/decrypt.
- Legacy cache rows (no `entryType`/`isFavorite`) still appear (treated as Login / not-favorite); no crash.

## Technical approach
### Field propagation (round-1 F1/F2/F3 corrected)
`VaultEntrySummary` lacks `entryType`/`isFavorite`. They are server metadata on the wire model
`EncryptedEntry` (`isFavorite: Bool`, `entryType: String`), dropped in `toPersonalCacheEntry()`. Chain:
1. `CacheEntry` gains `isFavorite: Bool?` (already has `entryType: String?`).
2. `EncryptedEntry.toPersonalCacheEntry()` passes `isFavorite: self.isFavorite`.
3. `EntryBlobDecoder.summary(plaintext:entryId:teamId:)` gains `entryType: String? = nil, isFavorite: Bool = false`
   params (defaulted → the 3 other call sites — `CredentialIdentityRegistrar` ×2, `CredentialResolver`
   — compile unchanged and don't need the fields). `VaultViewModel.decryptOverview` passes
   `entryType: entry.entryType, isFavorite: entry.isFavorite ?? false`.
4. `VaultEntrySummary` gains `entryType: String?` and `isFavorite: Bool` (defaulted in init).

`VaultEntrySummary` is **never persisted** (rebuilt from `CacheEntry` each load) → no Codable migration.
`CacheEntry.isFavorite: Bool?` is JSON-backward-compatible (absent → nil → false).

### View architecture (in-place, no ownership move)
`VaultListView` keeps the `NavigationStack`, `.toolbar`, `bottomBar` (search + create), screen-recording
overlay, and sheets — UNCHANGED. Only its body content switches:
- `searchQuery` non-empty → existing flat `entryList` (search across all).
- else → `categoryGrid` (LazyVGrid of `CategoryCard`, each a `NavigationLink` to `VaultCategoryListView(category:)`).
`VaultCategoryListView` renders `viewModel.filteredSummaries.filter { matches($0, category) }` with the
existing row + `EntryDetailView` link, AND its own screen-recording overlay (parity with `EntryDetailView`).

## Contracts

### C1 — Field propagation
- `CacheEntry` (+`isFavorite: Bool? = nil` in struct + init), `EncryptedEntry.toPersonalCacheEntry()` (+`isFavorite:`),
  `EntryBlobDecoder.summary(...)` (+`entryType`/`isFavorite` defaulted params), `VaultViewModel.decryptOverview`
  (pass the two), `VaultEntrySummary` (+`entryType: String?`, `isFavorite: Bool`, defaulted in init).
- **Invariants**: legacy row → `entryType nil`/`isFavorite false`; no entry dropped; `CacheEntry` JSON decode tolerant of absent `isFavorite`.
- **Consumer walkthrough**: `VaultCategory.matches`/`categoryCounts` (C3) read `{ entryType, hasTOTP, isFavorite, tags }` — all present after C1 ✓. AutoFill `CacheEntry` consumers unaffected (additive optional) ✓.
- **Acceptance**: decode test — legacy → nil/false; populated → propagates to summary.

### C2 — `EntryTypeCategory` (APP target, localized)
- **New file**: `ios/PasswdSSOApp/Views/Vault/EntryTypeCategory.swift` (NOT Shared — `String(localized:)` resolves against the app catalog).
  ```swift
  enum EntryTypeCategory: String, CaseIterable {
    case login="LOGIN", secureNote="SECURE_NOTE", creditCard="CREDIT_CARD", identity="IDENTITY",
         bankAccount="BANK_ACCOUNT", sshKey="SSH_KEY", softwareLicense="SOFTWARE_LICENSE", passkey="PASSKEY"
    static func from(rawType: String?) -> EntryTypeCategory   // nil/unknown → .login
    var sfSymbol: String { get }
    var localizedLabel: String { get }   // String(localized:) — compiler-enforced, no raw-string leak (S3)
  }
  ```
- **Invariant**: `from` is total (unknown/nil → `.login`); the 8 raw values match the server `ENTRY_TYPE` set (round-1 confirmed all 8 exist).
- **Forbidden**: `pattern: entryType == "` — route all type logic through `from`.
- **Acceptance**: `from("PASSKEY")==.passkey`, `from(nil)==.login`, `from("X")==.login`, `allCases.count==8`.

### C3 — `VaultCategory` + pure count/filter (APP, testable)
- **New file**: `ios/PasswdSSOApp/Views/Vault/VaultCategory.swift`.
  ```swift
  enum VaultCategory: Hashable { case all, type(EntryTypeCategory), codes, favorites, tag(String) }
  func matches(_ s: VaultEntrySummary, _ c: VaultCategory) -> Bool
  func categoryCounts(_ summaries: [VaultEntrySummary]) -> [VaultCategory: Int]
  func distinctTags(_ summaries: [VaultEntrySummary]) -> [String]   // sorted
  ```
- **Semantics**: all→every; type(t)→`from(s.entryType)==t`; codes→`s.hasTOTP`; favorites→`s.isFavorite`; tag(n)→`s.tags.contains(n)`.
- **Invariants**: pure/deterministic; multi-membership (an entry counts under Login+Codes+Favorite+Tag); `all` count == `summaries.count`.
- **Acceptance**: matrix tests — each case, multi-membership, legacy nil→Login, empty tags, all==count.

### C4 — `VaultListView` grid + `VaultCategoryListView` + favorites reconcile
- `VaultListView`: content = grid (searchQuery empty) | flat list (searching). Toolbar/bottomBar/overlay/sheets unchanged.
- **New** `VaultCategoryListView(category:…)`: filtered list + its own screen-recording overlay (S2) + empty state; reuses the row + `EntryDetailView` navigation.
- **New** `CategoryCard`: count + symbol + label; hidden when count 0 (except All).
- Remove the dead `filterFavoritesOnly` placeholder in `VaultViewModel.filteredSummaries` (round-1: zero external callers) — favorites is now a `VaultCategory`. Single favorites path.
- **Invariants**: `.all` list == today's flat list; search composes within a category; toolbar actions reachable (unchanged — no ownership move).
- **Acceptance**: VM filter tests (`.all` parity, search compose); build; manual checklist.

### C5 — i18n labels (en/ja)
- Add `String(localized:)` keys: All, Logins, Secure Notes, Credit Cards, Identities, Bank Accounts, SSH Keys, Software Licenses, Passkeys, Codes, Favorites, Tags (+ any card subtitle). Hand-author en+ja in `PasswdSSOApp/Localizable.xcstrings` ([[ios-string-catalog-notes]]).
- **Acceptance**: `LocalizationCatalogTests` green.

## Testing strategy
- **C1**: decode/propagation (legacy vs populated `CacheEntry` → summary fields).
- **C2**: `EntryTypeCategory.from` totality; `allCases.count==8`.
- **C3**: the core — exhaustive `matches`/`categoryCounts`/`distinctTags` over a fixture (every case, multi-membership, legacy nil, empty tags, zero-count hidden, all==count).
- **C4**: VM filter (`.all` parity, search compose). Test fixtures that build `VaultEntrySummary`/`CacheEntry` updated for the new fields (RT1/R19).
- **Manual checklist** (no UI harness): grid renders; counts correct; each card → right filtered list; empty types hidden; search at root + within category; legacy-cache device shows all under Login; screen-recording hides the grid AND pushed category lists; toolbar/create/search reachable.
- Full `xcodebuild test`.

## Considerations & constraints
- **In-place landing** keeps the NavigationStack/toolbar in `VaultListView` → eliminates the round-1 nav-ownership-move regression surface.
- **isFavorite exposure** (round-1 S1): server-visible metadata, same posture as the already-shipped `entryType`; encrypted at rest in the cache. No new exposure.
- **Favorites single path**: the dead `filterFavoritesOnly` is removed, not left divergent.
- Team entries: personal-only (consistent with #537); `filterTeamId` stays nil in the personal flow.

## User operation scenarios
1. Unlock → grid: All(42), Logins(30), Codes(8), Credit Cards(3), Favorites(5), tag cards. Secure Notes 0 → hidden. Tap Logins → 30 logins → tap → detail.
2. Tap Codes → only TOTP entries.
3. Search at root → flat results across all; clear → grid returns. Search inside Logins → within logins.
4. Legacy cache (no entryType) → all under Logins; no crash; types populate after next sync.
5. Zero favorites → Favorites card hidden.
6. Screen recording → grid AND any pushed category list show the hidden overlay.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | Field propagation (entryType, isFavorite) via summary signature + 4 call sites | locked |
| C2 | `EntryTypeCategory` (app target, localizedLabel) | locked |
| C3 | `VaultCategory` + pure count/filter/distinctTags | locked |
| C4 | `VaultListView` grid + `VaultCategoryListView` (own overlay) + favorites reconcile | locked |
| C5 | i18n labels (en/ja) | locked |
