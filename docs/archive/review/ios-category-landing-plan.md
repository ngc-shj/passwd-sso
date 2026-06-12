# Plan: ios-category-landing

## Project context

- **Type**: web-app-adjacent native client — SwiftUI iOS host app under `ios/PasswdSSOApp`. UI redesign of the post-unlock landing surface.
- **Test infrastructure**: unit tests only (XCTest via `xcodebuild test`). No snapshot/UI-assertion harness beyond launch smoke tests — so view *logic* (counts, filtering, category model) is unit-tested; pixel layout is not.
- Base branch: `feat/ios-category-landing` from `ios-main` (tracks `origin/main`). Local `main` ref is STALE.

## Objective

Replace the flat post-unlock password list with an Apple-Passwords-style **category landing grid**: cards
for All / entry types / Codes / Favorites / Tags, each showing a count, drilling into a filtered list
(the existing `VaultListView` rendering). Closes parity roadmap item 6.

## Requirements

### Functional
- After unlock, show a grid of category cards (count + icon + localized label) instead of the flat list.
- Tapping a card pushes a filtered entry list (reusing the current list row + `EntryDetailView` nav).
- Categories (in-scope this branch):
  - **All** — every active personal entry (always shown).
  - **By entry type** — Login, Secure Note, Credit Card, Identity, Bank Account, SSH Key, Software License, Passkey. A type card is shown ONLY when its count > 0 (Apple-Passwords behavior).
  - **Codes** — entries with `hasTOTP == true`.
  - **Favorites** — entries with `isFavorite == true`.
  - **Tags** — one entry per distinct tag, with per-tag count.
- Search remains available (within All, or globally from the landing — see C6).

### Deferred (explicit, with rationale — see Considerations)
- **Trash (削除済み)** — the offline cache does not currently store trashed/archived entries; supporting this needs a sync/fetch change (server already exposes `isArchived`, but trashed rows aren't synced to the device). Architecture leaves a slot for it.
- **Watchtower-Security** — no iOS security-audit backend or client exists; web-only today. Out of scope until a security-scan API client lands.

### Non-functional
- Counts computed from already-decrypted summaries in memory — no extra network or decrypt.
- Legacy cache rows (no `entryType`) MUST still appear (treated as Login) — no entry silently disappears.
- Backward compatible: a device with an old cache (missing the new fields) degrades gracefully (no crash, entries default to Login / not-favorite) until the next sync repopulates.

## Technical approach

### Data gap and propagation
`VaultEntrySummary` (`ios/Shared/Models/VaultEntrySummary.swift`) currently lacks `entryType` and
`isFavorite`; both are non-secret metadata already present on the wire model `EncryptedEntry`
(`ios/PasswdSSOApp/Vault/EntryFetcher.swift:7-13`: `entryType: String`, `isFavorite: Bool`,
`isArchived: Bool`). They are dropped in `EncryptedEntry.toPersonalCacheEntry()` and never reach the
summary. The fix is a straight propagation: wire → `CacheEntry` → `VaultEntrySummary`.

- `CacheEntry` (`ios/Shared/AutoFill/CredentialResolver.swift:199-216`) already carries
  `entryType: String?` (added for passkeys). Add `isFavorite: Bool?` (optional → legacy rows decode as nil → false).
- `EncryptedEntry.toPersonalCacheEntry()` copies `isFavorite` alongside the existing `entryType`.
- `EntryBlobDecoder.summary(_:)` (`ios/Shared/Models/EntryBlobDecoder.swift:80-103`) copies `entryType`
  and `isFavorite` from the `CacheEntry` into the produced `VaultEntrySummary`.

`entryType` stays a raw `String?` end-to-end (the wire contract is a string); a presentation enum
(`EntryTypeCategory`) maps known raw values to labels/icons, with unknown/nil → Login.

### View architecture
- New `VaultCategoryLandingView` becomes the content rendered by `RootView` for `.vaultUnlocked`
  (replacing the direct `VaultListView`). It owns the `NavigationStack`.
- Each card is a `NavigationLink { VaultListView(category: …) } label: { CategoryCard(…) }`.
- `VaultListView` gains an optional `category:` input; when set, it filters to that category and is a
  pushed detail screen (no longer the root `NavigationStack` owner — the landing owns it). When the
  category is `.all`, behavior == today's full list.
- `VaultViewModel` is shared (single source of decrypted summaries). Category filtering is a pure
  computed function (C3); the landing reads counts from the same view model.

## Contracts

### C1 — Summary/cache field propagation
- **Files**: `ios/Shared/Models/VaultEntrySummary.swift`, `ios/Shared/AutoFill/CredentialResolver.swift` (CacheEntry), `ios/PasswdSSOApp/Vault/EntryFetcher.swift` (`toPersonalCacheEntry`), `ios/Shared/Models/EntryBlobDecoder.swift` (`summary`).
- **Signatures**:
  - `VaultEntrySummary` gains `public let entryType: String?` and `public let isFavorite: Bool` (non-optional; default false at decode).
  - `CacheEntry` gains `public let isFavorite: Bool?` (optional for legacy rows; already has `entryType: String?`).
  - `toPersonalCacheEntry()` sets `isFavorite: self.isFavorite` (from `EncryptedEntry`).
  - `EntryBlobDecoder.summary(_ entry: CacheEntry) -> VaultEntrySummary` sets `entryType: entry.entryType`, `isFavorite: entry.isFavorite ?? false`.
- **Invariants**:
  - `VaultEntrySummary` remains `Codable`; adding fields must not break decode of any persisted summary cache. **Decode-compat check**: if summaries are persisted as JSON anywhere, the new non-optional `isFavorite` needs a default — make the decoder tolerate absence (custom `init(from:)` or optional-with-default). Verify whether summaries are persisted or always rebuilt from `CacheEntry` each launch (if always rebuilt, no migration needed).
  - Legacy `CacheEntry` (no `entryType`, no `isFavorite`) → summary with `entryType == nil`, `isFavorite == false`. No crash, no dropped entry.
- **Consumer-flow walkthrough**:
  - Consumer A (`VaultCategoryLandingView` / C3 count function) reads `{ entryType, hasTOTP, isFavorite, tags }` from each summary and uses them to bucket+count. All four must be present on the summary → C1 adds the two missing ones. ✓
  - Consumer B (`VaultListView` row, existing) reads `{ title, username, urlHost, hasTOTP, relyingPartyId }` — unaffected by additions. ✓
  - Consumer C (AutoFill extension, existing `CredentialResolver` consumers of `CacheEntry`) — adding an optional `isFavorite` to `CacheEntry` is additive; existing reads unaffected. ✓
- **Acceptance**: decode tests — legacy cache row → `entryType nil`/`isFavorite false`; populated row → values propagate to summary.

### C2 — `EntryTypeCategory` presentation enum
- **New file**: `ios/Shared/Models/EntryTypeCategory.swift` (or host target if presentation-only).
- **Signature**:
  ```swift
  public enum EntryTypeCategory: String, CaseIterable {
    case login = "LOGIN", secureNote = "SECURE_NOTE", creditCard = "CREDIT_CARD",
         identity = "IDENTITY", bankAccount = "BANK_ACCOUNT", sshKey = "SSH_KEY",
         softwareLicense = "SOFTWARE_LICENSE", passkey = "PASSKEY"
    public static func from(rawType: String?) -> EntryTypeCategory  // nil/unknown → .login
    public var sfSymbol: String { get }
    // display label provided at the view layer via String(localized:) keyed on the case
  }
  ```
- **Invariant**: `from(rawType:)` is total — every `String?` maps to a case; unknown raw strings and `nil` map to `.login` (so no entry is uncategorizable). This mirrors the wire default.
- **Forbidden patterns**:
  - `pattern: entryType == "` — reason: raw-string comparisons of entryType outside `EntryTypeCategory.from` invite typos; route all type logic through the enum.
- **Acceptance**: `from("PASSKEY") == .passkey`; `from(nil) == .login`; `from("FUTURE_TYPE") == .login`; `allCases.count == 8`.

### C3 — Category model + pure count/filter function
- **New file**: `ios/PasswdSSOApp/Views/Vault/VaultCategory.swift`
- **Signatures**:
  ```swift
  enum VaultCategory: Hashable {
    case all
    case type(EntryTypeCategory)
    case codes
    case favorites
    case tag(String)
  }
  // pure, side-effect free, testable
  func matches(_ summary: VaultEntrySummary, _ category: VaultCategory) -> Bool
  func categoryCounts(_ summaries: [VaultEntrySummary]) -> [VaultCategory: Int]
  ```
- **Semantics**:
  - `.all` → every summary.
  - `.type(t)` → `EntryTypeCategory.from(summary.entryType) == t`.
  - `.codes` → `summary.hasTOTP`.
  - `.favorites` → `summary.isFavorite`.
  - `.tag(name)` → `summary.tags.contains(name)`.
- **Invariants**:
  - Pure: no I/O, no `UIPasteboard`, no `Date()`-dependent branching. Deterministic for the same input.
  - An entry may appear under multiple categories (Login + Codes + Favorite + Tag) — categories are filters, not a partition. `.all` count == `summaries.count`.
- **Acceptance**: unit tests over a fixture array covering each case, multi-membership, empty tags, legacy `entryType nil` counted under Login, zero-count types absent from a "non-empty types" helper.

### C4 — `VaultListView(category:)` filtered mode
- **File**: `ios/PasswdSSOApp/Views/Vault/VaultListView.swift`, `ios/PasswdSSOApp/Views/Vault/VaultViewModel.swift`
- **Change**: `VaultListView` gains `let category: VaultCategory` (default `.all` to preserve existing call sites during transition). The rendered list = `viewModel.filteredSummaries` further filtered by `matches(_, category)`. `VaultViewModel.filteredSummaries` is extended OR the view applies `matches` on top of the existing search filter. Navigation title reflects the category (localized).
- **Invariants**:
  - When `category == .all`, output is identical to the current flat list (search behavior preserved).
  - Search composes with category (search within the selected category).
  - The favorites filter that today is a no-op placeholder (`VaultViewModel.swift:` `filterFavoritesOnly` does nothing because the summary lacked `isFavorite`) is now backed by real data via C1 — reconcile or remove the placeholder so there is ONE favorites path, not two divergent ones.
- **Acceptance**: filtering tests at the view-model level (category × search matrix); `.all` parity with pre-change output.

### C5 — `VaultCategoryLandingView` + `CategoryCard`
- **New files**: `ios/PasswdSSOApp/Views/Vault/VaultCategoryLandingView.swift`, `CategoryCard.swift`.
- **Signature**: `VaultCategoryLandingView` owns the `NavigationStack`, reads the shared `VaultViewModel`, computes `categoryCounts`, renders a `LazyVGrid` of `CategoryCard` for: All, then non-empty entry types, Codes (if >0), Favorites (if >0), then a Tags section (one card per distinct tag). Each card is a `NavigationLink` to `VaultListView(category:)`. Toolbar (Settings / Lock / Sign Out) and the create button migrate from `VaultListView`'s root toolbar to the landing (since the landing is now the root). 
- **Invariants**:
  - Empty type/Codes/Favorites cards are hidden (count 0). All is always present.
  - The existing top toolbar actions (Settings, Lock, Sign Out, Create) remain reachable from the new root.
  - `RootView` renders `VaultCategoryLandingView` for `.vaultUnlocked` (replacing direct `VaultListView`).
- **Acceptance**: no automated view assertion (no harness) — covered by C3 count logic tests + a manual-test checklist. Build must succeed; `RootView` wiring compiles.

### C6 — i18n for category labels
- **Files**: `ios/PasswdSSOApp/Localizable.xcstrings` (+ Swift `String(localized:)` sites).
- **Change**: localized en/ja strings for: All, Logins, Secure Notes, Credit Cards, Identities, Bank Accounts, SSH Keys, Software Licenses, Passkeys, Codes, Favorites, Tags. Follow the established String Catalog workflow ([[ios-string-catalog-notes]]) — author entries by hand (xcodebuild does not write back extraction).
- **Acceptance**: `LocalizationCatalogTests` (existing) stays green; each new `String(localized:)` key has en+ja entries.

## Testing strategy

- **C1**: decode/propagation unit tests (legacy vs populated cache row → summary fields). If summaries are persisted as JSON, add a missing-field decode test; if always rebuilt from `CacheEntry`, document that (no migration test needed).
- **C2**: enum totality tests (`from` mapping, `allCases.count == 8`).
- **C3**: the core logic — exhaustive `matches`/`categoryCounts` tests over a fixture covering every case, multi-membership, legacy nil type, empty tags.
- **C4**: view-model filtering tests (category × search; `.all` parity).
- **C6**: existing `LocalizationCatalogTests` coverage.
- Manual-test checklist (no UI harness): landing renders, counts correct, each card drills into the right filtered list, empty types hidden, search works within a category, legacy-cache device shows all entries under Login, toolbar actions reachable.
- Full `xcodebuild test` before completion.

## Considerations & constraints

- **Scope cut surfaced for sign-off**: Trash and Watchtower are deferred because the data doesn't exist on-device (trashed entries aren't synced; no security-audit client). The grid is built to accept new `VaultCategory` cases without refactor. If the user wants Trash now, that's a sync-layer change (separate, larger) — recommend a follow-up branch.
- **Favorites double-path**: C4 must collapse the existing dead `filterFavoritesOnly` placeholder into the real `isFavorite` data so there isn't one working path (landing) and one broken path (old toggle).
- **Decode/migration risk** (C1): the single highest-risk item — adding a non-optional field to a `Codable` that may be persisted. The plan mandates verifying the persistence model and adding a default-tolerant decode if needed. Reviewer must confirm.
- **Team entries**: personal-only, consistent with the rest of iOS AutoFill parity (#537). Team category counts out of scope.
- **Navigation ownership move**: relocating the root `NavigationStack` + toolbar from `VaultListView` to the landing is the main regression surface (lost toolbar action, double nav bar, broken back). Manual checklist covers it.

## User operation scenarios

1. Unlock → landing grid shows All (42), Logins (30), Codes (8), Credit Cards (3), Favorites (5), and a tag card per tag. Secure Notes count 0 → no card. Tap Logins → filtered list of 30 logins → tap one → detail.
2. Tap Codes → only TOTP entries; each row still shows its TOTP indicator.
3. Search from All → same behavior as today. Search inside Logins → filters within logins only.
4. Legacy-cache device (pre-sync, entries have no `entryType`) → all entries appear under Logins; no crash; after next sync, types populate.
5. User taps Favorites with zero favorites → card hidden (no dead-end empty screen).
6. From the landing, user opens Settings / Locks / Signs Out / taps Create — all still reachable.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Summary/cache field propagation (entryType, isFavorite) | locked |
| C2 | `EntryTypeCategory` presentation enum (total mapping) | locked |
| C3 | `VaultCategory` model + pure count/filter | locked |
| C4 | `VaultListView(category:)` filtered mode + favorites reconcile | locked |
| C5 | `VaultCategoryLandingView` + `CategoryCard` + RootView wiring | locked |
| C6 | i18n category labels (en/ja) | locked |
