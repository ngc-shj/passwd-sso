# Plan: iOS host-app credential create + edit (parity substitute for the extension Save/Update prompt)

## Project context
- Type: `mixed` — native iOS app (SwiftUI host app + AutoFill extension) talking to the Next.js E2E-encrypted server. Security-sensitive: this path encrypts a new/edited personal vault entry client-side and POST/PUTs it; the server never sees plaintext.
- Test infrastructure: `unit tests only` (XCTest under `ios/PasswdSSOTests`, ~261 tests). The crypto-on-write mapping + the preserve-unknown JSON round-trip are pure and unit-testable; SwiftUI views and `ASCredentialIdentityStore`/network calls are verified manually on device.

## Problem
The browser extension offers Save (new credential) and Update (changed password) prompts on form submit (`showSavePrompt`/`showUpdatePrompt`). **iOS has no API equivalent**: `ASCredentialProviderViewController` is never called back on form submit, and there is no `prepareInterfaceToSaveCredential`. This is an Apple platform limitation, already documented in `ios/README.md` ("no callback into a third-party AutoFill extension after a successful sign-in … Manual edit inside `PasswdSSOApp` replaces it"). The iOS-appropriate parity substitute is **host-app manual create + edit**.

Today the host app is effectively read-only for entries:
- **Create**: there is NO create UI and NO `createEntry` (POST) method on `MobileAPIClient`.
- **Edit**: `EntryEditForm` exists and is fully built, but the Edit button is disabled — it shows a "not supported yet" alert (`EntryDetailView.swift:65-72`). The reason is a **data-loss bug** in the re-encrypt path (`VaultViewModel.saveEntry` → `encryptPersonalEntry`), documented at `VaultViewModel.swift:152-158`.

### Root cause of the edit data-loss bug (confirmed by reading the server blob shape)
The server/web full blob stores (`src/lib/vault/personal-entry-payload.ts`):
- `tags` as an array of **objects** `[{name, color}]` (NOT `[String]`)
- `totp` as a **nested object** `{secret, algorithm?, digits?, period?}` (NOT a flat `totpSecret` string)
- plus `generatorSettings`, `passwordHistory`, `customFields`.

`encryptPersonalEntry(detail: EntryPlaintext, overview: OverviewPlaintext)` re-encodes from typed Swift structs whose `tags: [String]` and flat `totpSecret: String?` shapes do not match the server blob, and which omit `generatorSettings`/`passwordHistory`/`customFields`. Result on a round-trip edit:
1. `tags:["work"]` (string array) replaces `tags:[{name,color}]` → on next decrypt, `EntryBlobDecoder`'s `[TagPayload]` decode throws → `summary()`/`detail()` return nil → **the entry silently vanishes from the list** (Critical).
2. `totp` object is replaced by a flat `totpSecret` key → the OTP is dropped/mis-shaped.
3. `generatorSettings`/`passwordHistory`/`customFields` are dropped.

### The fix
Stop re-encoding from a lossy typed struct. Use a **preserve-unknown JSON round-trip** for edit (decrypt → mutate only the edited keys in the parsed JSON object → re-encrypt), exactly mirroring the browser extension's update path (`extension/src/background/login-save.ts` `handleUpdateLogin`: decrypt → parse → set one field → re-encrypt). For create, build a fresh minimal LOGIN blob whose shape the web app reads back without issue (proven-compatible with the extension's `handleSaveLogin`).

## Objective
Let a user, in the host app:
1. Create a new personal LOGIN entry (title, username, password, url, notes, optional TOTP secret) → encrypted client-side → `POST /api/passwords` → appears in the list after sync.
2. Edit an existing personal entry's editable fields **without losing tags, TOTP, generatorSettings, customFields, passwordHistory, additionalUrlHosts, requireReprompt, or travelSafe** → `PUT /api/passwords/{id}` → list reflects the change.

Team entries remain read-only (existing `VaultViewModelError.teamEditNotSupported`).

## Requirements
Functional:
- Create produces a server-accepted blob (201) and the entry survives a decrypt round-trip (does not vanish). The server-returned `id` MUST equal the client-generated `entryId` (the AAD is bound to it).
- Edit preserves every field the iOS form does not edit (the round-trip invariant). Editing only the password leaves tags/totp/generatorSettings/customFields byte-equivalent in meaning after decrypt.
- TOTP: editable as a secret string; preserves an existing `totp` object's `algorithm`/`digits`/`period` when only the secret changes; clearing the secret removes both `totp` (full blob) and `hasTOTP` (overview).
- `urlHost` in the overview is re-derived from the edited `url` on every save.
- Tags are NOT editable on iOS (the Tags free-text field is removed); existing tags are preserved (blob `tags` untouched + `tagIds` omitted from the PUT so the server keeps the relation — verified: `src/app/api/passwords/[id]/route.ts:175` only mutates tags `if (tagIds !== undefined)`).

Non-functional / security:
- All encryption is client-side with the per-vault-type personal AAD (`buildPersonalEntryAAD(userId, entryId, vaultType)`), `blob` and `overview` AADs never shared (cross-field replay protection — already enforced by `encryptAESGCMEncoded`).
- A fresh random IV per encryption (provided by `encryptAESGCMEncoded`).
- The vault must be unlocked (vaultKey in memory) for both create and edit; both run only from `.vaultUnlocked` UI state.
- **Key/AAD versioning** (corrected from F6/T9): create AND edit RE-ENCRYPT with the **live in-memory vault key**, so both send the **live `keyVersion`** (from unlock data, `>= 1`) and `aadVersion: 1`. Editing a legacy `aadVersion: 0` entry DECRYPTS the existing blob using the entry's STORED `aadVersion` (0 → no AAD), then RE-ENCRYPTS with `aadVersion: 1` (a security upgrade; the PUT route accepts the version change because `encryptedBlob` is present — `src/app/api/passwords/[id]/route.ts:159-165`). We never label a blob with a key/aad version that differs from the key actually used to encrypt it.

## Technical approach
- Encoding seam: a new pure Shared helper `PersonalEntryBlobBuilder` produces the blob+overview **plaintext JSON** (`Data`) for both create (from scratch) and edit (preserve-unknown round-trip via `JSONSerialization` → `[String: Any]` → mutate → serialize). Encryption stays in `encryptAESGCMEncoded` with personal AAD; the lossy `encryptPersonalEntry(EntryPlaintext, OverviewPlaintext)` is removed from all save paths (C6).
- The edited-field set is captured in one value type `EditableEntryFields { title, username, password, url, notes, totpSecret }` shared by create and edit and by the UI form.
- `MobileAPIClient.createEntry` mirrors `updateEntry` (DPoP-signed, single nonce-retry), differing in method (POST), path (`/api/passwords`), body, and accepted success status (**201**), and it DECODES the response to return the server `id`.
- `VaultViewModel` OWNS the current decrypted-cache context: it stores `cacheData` internally (set by `loadFromCache`, refreshed after each write+sync) so `saveEntry` needs no new parameter and the list never double-counts an optimistically-added row.
- One SwiftUI form (`EntryForm`) handles both create and edit modes (DRY).
- **Execution order is a hard constraint**: C2 (builder) and C3 (view-model rewrite) MUST land before C5 (UI enablement). Enabling the edit sheet while `EntryEditForm.save()` still calls the lossy encoder would ship the corruption. C6 removes the lossy path in the same PR.

## Contracts

### C1 — `MobileAPIClient.createEntry` (POST /api/passwords, returns server id) (locked)
- New request type (beside `UpdateEntryRequest`):
  ```swift
  public struct CreateEntryRequest: Sendable, Codable {
    public let id: String                 // client-generated UUIDv4 (REQUIRED for aadVersion >= 1)
    public let encryptedBlob: EncryptedData
    public let encryptedOverview: EncryptedData
    public let keyVersion: Int
    public let aadVersion: Int             // 1
    public let entryType: String           // "LOGIN"
    public init(...)                       // memberwise
  }
  ```
  Field set matches `createE2EPasswordSchema` (`src/lib/validations/entry.ts:40-55`). `tagIds`/`folderId`/`isFavorite`/`requireReprompt`/`expiresAt` are optional on the server and intentionally omitted.
- New minimal response type for the create id check:
  ```swift
  private struct CreateEntryResponse: Decodable { let id: String }
  ```
- New method: `public func createEntry(body: CreateEntryRequest) async throws -> String` — returns the server-stored `id`. Identical DPoP/nonce/retry structure to `updateEntry` but `httpMethod = "POST"`, path `/api/passwords`, `htm = "POST"`. It uses a **body-decoding** variant (NOT `performVoidHTTP`): on success it decodes `CreateEntryResponse` and returns `.id`.
- **Success status (S1/T1)**: POST returns **201**. The decoder accepts `200, 201` (creation) → decode+return id; the shared `decodeVoidResponse` (used by `updateEntry`/`postCacheRollbackReport`) is left at `200, 204` (a create-only 201 path lives in the new decoder, so existing void callers are untouched). 401+nonce → retry once; 4xx/5xx → throw `MobileAPIError.serverError(status:)`.
- Forbidden patterns:
  - `pattern: func createEntry[\s\S]*?httpMethod = "PUT" — reason: create must POST, not PUT.`
  - `pattern: func createEntry[\s\S]*?performVoidHTTP — reason: create must decode the response id (S2 id-equality check), not discard the body.`
- Acceptance (unit, via the existing `MockURLProtocol`/stub-session harness used by `MobileAPIClientTests`):
  - method == POST, path ends `/api/passwords`, body decodes to `CreateEntryRequest` with the supplied `id`/`keyVersion`/`aadVersion == 1`/`entryType == "LOGIN"`, DPoP + `Authorization` headers present, `ath == sha256Base64URL(accessToken)`.
  - **201** with `{"id":"<same uuid>"}` → returns that id (no throw).
  - **200** with an id body → returns id (forward-compat).
  - **401 + DPoP-Nonce** → retries once with the new nonce.
  - **4xx/5xx** → throws `MobileAPIError.serverError`.
  - **Regression guard**: a separate test asserts `updateEntry` still succeeds on **200 and 204** (the void path was not narrowed).

### C2 — `PersonalEntryBlobBuilder` (Shared, pure) (locked)
New file `ios/Shared/Vault/PersonalEntryBlobBuilder.swift`. Pure, no crypto, no I/O — operates on plaintext JSON `Data`.

```swift
public struct EditableEntryFields: Sendable, Equatable {
  public let title: String
  public let username: String
  public let password: String
  public let url: String         // "" = none
  public let notes: String       // "" = none
  public let totpSecret: String  // "" = none
  public init(...)
}

public enum PersonalEntryBlobBuilderError: Error, Equatable { case malformedJSON }

public enum PersonalEntryBlobBuilder {
  /// CREATE: fresh minimal LOGIN blob + overview plaintext.
  public static func buildCreate(fields: EditableEntryFields) throws -> (blob: Data, overview: Data)

  /// EDIT: preserve-unknown round-trip. Parse the existing decrypted plaintexts
  /// as JSON objects, mutate ONLY the edited keys, re-serialize. Unknown keys
  /// (tags, generatorSettings, passwordHistory, customFields, additionalUrlHosts,
  /// requireReprompt, travelSafe) pass through verbatim.
  public static func applyEdits(
    blob existingBlob: Data,
    overview existingOverview: Data,
    fields: EditableEntryFields
  ) throws -> (blob: Data, overview: Data)
}
```

Mutation rules (apply to both create-from-`[:]` and edit-from-parsed-object via a shared private mutator):

Full blob object:
- `title` = fields.title (string)
- `username` = fields.username.isEmpty ? NSNull() : fields.username
- `password` = fields.password (string)
- `url` = fields.url.isEmpty ? NSNull() : fields.url
- `notes` = fields.notes.isEmpty ? NSNull() : fields.notes
- TOTP:
  - if `fields.totpSecret.isEmpty` → remove key `"totp"`
  - else if existing `"totp"` is a `[String: Any]` → set `totp["secret"] = fields.totpSecret` (preserve algorithm/digits/period), write back
  - else → set `"totp" = ["secret": fields.totpSecret]`
- All other keys (tags, generatorSettings, passwordHistory, customFields, …) untouched. (Create starts from `[:]`, so the output is exactly `{title, username, password, url, notes}` — empties as JSON `null`.)

Overview object:
- `title` = fields.title
- `username` = fields.username.isEmpty ? NSNull() : fields.username
- `urlHost` = (URL(string: fields.url)?.host).flatMap { $0.isEmpty ? nil : $0 } ?? NSNull()
- TOTP marker: if `fields.totpSecret.isEmpty` → remove `"hasTOTP"`; else → set `"hasTOTP" = true`
- All other keys (additionalUrlHosts, tags, requireReprompt, travelSafe, …) untouched.

`malformedJSON` thrown if an existing plaintext does not parse as a top-level JSON object. (Key order is irrelevant — the AAD binds userId/entryId/vaultType, not byte order; the ciphertext is fresh per save.)

- Note (F7): the create blob uses JSON `null` for empty username/url/notes (matching the web `buildPersonalEntryPayload` `|| null` convention). This differs cosmetically from the extension's `notes: ""`; both are accepted by the server and decode to `""` via `EntryBlobDecoder`. The plan does NOT claim byte-identical equivalence to the extension — only server/decoder compatibility.
- Forbidden patterns:
  - `pattern: EntryPlaintext\(|OverviewPlaintext\( inside PersonalEntryBlobBuilder.swift — reason: the builder must NOT route through the lossy typed structs; it operates on JSON objects.`
- Acceptance (unit, pure — the case table that locks the round-trip). Tests that distinguish `null`/bool fidelity MUST re-parse the output via `JSONSerialization` and assert on the raw value type (`as? Bool`, `is NSNull`), NOT only via `JSONDecoder` (which coerces JSON `1`→`true` and `null`/absent→`""`):
  1. CREATE all-fields → blob keys are EXACTLY `{title, username, password, url, notes}` (empties → JSON null), overview keys EXACTLY `{title, username, urlHost}`; no `tags`/`generatorSettings`/`hasTOTP`/`totp`.
  2. CREATE with totpSecret set → blob has `totp` as an object `{secret:…}`, overview has `hasTOTP == true` (assert `out["totp"] is [String:Any]` and `(out["hasTOTP"] as? Bool) == true`).
  3. **EDIT preserving tags (the vanishing-entry regression lock)**: input blob `{title,…,tags:[{name:"work",color:"#f00"}],generatorSettings:{…}}`, edit password only → assert (a) `EntryBlobDecoder.detail(out.blob, …)` is NON-nil, (b) `detail.tags == ["work"]` (the TagPayload decode succeeded — non-empty), (c) `detail.password == "<new password>"`, (d) generatorSettings preserved by VALUE: `JSONSerialization.data(withJSONObject: out["generatorSettings"]!, options: .sortedKeys)` byte-equals the same of the INPUT blob's `generatorSettings` (presence-only is insufficient — guards a regression that keeps the key but clears the sub-object).
  4. EDIT preserving totp metadata: input `totp:{secret:"A",algorithm:"SHA256",digits:8,period:60}`, change only secret → re-parsed output `totp` has `secret=="B"`, `algorithm=="SHA256"`, `(totp["digits"] as? Int)==8`, `(totp["period"] as? Int)==60` (numbers stay numbers, not strings).
  5. EDIT clearing totp: totpSecret "" → re-parsed blob has no `"totp"` key; overview has no `"hasTOTP"` key.
  6. EDIT adding totp to an entry that had none → blob gains `totp` object with `secret`; overview gains `hasTOTP == true`.
  7. EDIT preserves overview `additionalUrlHosts`, `requireReprompt`, and `travelSafe` (including an explicit `travelSafe == false`) verbatim while `urlHost` updates from the new url (re-parse + `as? Bool` for travelSafe to prove `false` survived, not dropped).
  8. EDIT empties username/url/notes → re-parsed output values are `NSNull` (assert `out["username"] is NSNull`), AND `EntryBlobDecoder` re-decodes them to `""`.
  9. Bool fidelity: after a round-trip that touches `hasTOTP`, re-parse the overview via `JSONSerialization` and assert `(out["hasTOTP"] as? Bool) == true` and `(out["hasTOTP"] as? Int) == nil` (guards the NSNumber-bool pitfall — JSON `1` would fail the Bool cast).
  10. `applyEdits` on a non-object plaintext (`"[]"` / `"42"`) throws `.malformedJSON`.

### C3 — `VaultViewModel.createEntry` + rewritten `saveEntry` (VM owns cacheData) (locked)
- `VaultViewModel` gains internal cache ownership: `private(set) var cacheData: CacheData?`, set inside `loadFromCache(...)` and refreshed after each write (below). This resolves F1 (no `saveEntry` signature churn for `cacheData`) and F8 (single source of summaries).
- New `createEntry`:
  ```swift
  public func createEntry(
    userId: String,
    fields: EditableEntryFields,
    vaultKey: SymmetricKey,
    keyVersion: Int,          // LIVE vault keyVersion (>= 1), from unlock (C4)
    apiClient: MobileAPIClient,
    hostSyncService: HostSyncService
  ) async throws
  ```
  Body: `entryId = UUID().uuidString.lowercased()`; `(blob, overview) = try PersonalEntryBlobBuilder.buildCreate(fields:)`; encrypt each with `encryptAESGCMEncoded(plaintext:key:aad:)` + `buildPersonalEntryAAD(userId, entryId, .blob/.overview)`; `let serverId = try apiClient.createEntry(body: CreateEntryRequest(id: entryId, …, keyVersion: keyVersion, aadVersion: 1, entryType: "LOGIN"))`; **assert `serverId == entryId`** (S2) — on mismatch throw a new `VaultViewModelError.entryIdMismatch` (do NOT add an optimistic summary; the AAD would be unrecoverable); `let report = try await hostSyncService.runSync(vaultKey:userId:)`; refresh from the sync's fresh cache: `loadFromCache(cacheData: report.cacheData, vaultKey:, userId:)` (rebuilds `allSummaries`, no manual prepend, no duplicate).
- Rewritten `saveEntry` (signature: drop `detail`/`overview`/`aadVersion`/`keyVersion`, add `fields` + live `keyVersion`):
  ```swift
  public func saveEntry(
    entryId: String,
    userId: String,
    fields: EditableEntryFields,
    vaultKey: SymmetricKey,
    keyVersion: Int,          // LIVE vault keyVersion (C4/F6)
    apiClient: MobileAPIClient,
    hostSyncService: HostSyncService
  ) async throws
  ```
  Body:
  - Keep team-entry rejection (`teamEditNotSupported`) via `allSummaries`.
  - `guard let cacheData else { throw VaultViewModelError.cacheUnavailable }`.
  - `guard let raw = rawPlaintexts(for: entryId, cacheData: cacheData, vaultKey:, userId:) else { throw VaultViewModelError.entryNotDecryptable }` — `raw` carries `(blob: Data, overview: Data)` decrypted USING the entry's STORED aadVersion (so legacy `aadVersion: 0` decrypts cleanly).
  - `(newBlob, newOverview) = try PersonalEntryBlobBuilder.applyEdits(blob: raw.blob, overview: raw.overview, fields: fields)`.
  - Encrypt with `buildPersonalEntryAAD(userId, entryId, .blob/.overview)` (aadVersion 1 AAD).
  - `PUT` via `UpdateEntryRequest(encryptedBlob:newBlob, encryptedOverview:newOverview, keyVersion: keyVersion, aadVersion: 1)` — LIVE keyVersion, aadVersion 1, NO `tagIds` (preserves the tag relation). Re-encrypt with aadVersion 1 upgrades a legacy entry (accepted because blob is present).
  - `let report = try await hostSyncService.runSync(...)`; `loadFromCache(cacheData: report.cacheData, vaultKey:, userId:)` (refresh).
- New private helper `rawPlaintexts(for entryId:, cacheData:, vaultKey:, userId:) -> (blob: Data, overview: Data)?` — decodes `[CacheEntry]`, finds the row, decrypts both blobs via the existing `buildEntryAAD` (which keys off the row's `aadVersion`/`teamId`) + `decryptAESGCMEncoded`, returning the raw `Data` (before `EntryBlobDecoder`). Wraps all crypto calls in `do { … } catch { return nil }` (consistent with the existing `decryptBlob`/`decryptOverview` in the same file) so a missing row or decrypt failure returns nil — never propagates a throw or crashes (F10).
- New errors: `VaultViewModelError.cacheUnavailable`, `.entryNotDecryptable`, `.entryIdMismatch` (extend the existing `Equatable` enum).
- **Consumer-flow walkthrough** (the request body shapes are consumed by the server):
  - Server `POST /api/passwords` (`createE2EPasswordSchema`) reads `{ id, encryptedBlob, encryptedOverview, keyVersion, aadVersion, entryType }`; `id` required because `aadVersion >= 1`; all sent fields present; the 201 response `{id}` is read back by `createEntry` for the S2 equality check. ✓
  - Server `PUT /api/passwords/[id]` (`updateE2EPasswordSchema`) reads `{ encryptedBlob, encryptedOverview, keyVersion, aadVersion }`; `tagIds` omitted → tag relation preserved (route line 175); sending live keyVersion + aadVersion 1 WITH `encryptedBlob` avoids the 403 "version change without re-encrypt" branch (route 159-165). ✓
  - `EntryBlobDecoder.summary`/`detail` (the next read, after `runSync` rewrites the cache) reads the decrypted blob/overview; the round-trip keeps `tags` as `[{name,color}]` so the decode does not throw and the entry does not vanish. ✓
- Acceptance (unit):
  - `createEntry`: with a stubbed API returning `{id: <sent id>}` and the existing real `HostSyncService` over `MockURLProtocol` stubbed to return an EMPTY entry list, assert the POST body decodes to `CreateEntryRequest` with `entryType == "LOGIN"`, `aadVersion == 1`, `keyVersion == <passed live version>`, and `id == <generated entryId>`; assert no throw. **No-optimistic-prepend proof (T10)**: after the create whose stubbed sync returns an empty cache, assert `allSummaries.isEmpty` — if the code wrongly prepended an optimistic summary it would be non-empty; the real entry surfaces only via a real sync (covered by the manual test). With a stub returning a DIFFERENT id → throws `.entryIdMismatch` and `allSummaries` unchanged. (The "appears exactly once" end-to-end assertion is covered by manual-test Scenario 1, not unit, because the real `HostSyncService` returns whatever the stubbed network serves — injecting a synthetic post-sync cache containing the new entry is out of proportion for this seam.)
  - `saveEntry` round-trip: seed the VM's cache (see Testing strategy — `seedCache` helper encrypts a real blob with tags+generatorSettings via `encryptAESGCMEncoded` and sets `cacheData` through `loadFromCache`); edit password only; intercept the PUT body; decrypt its `encryptedBlob` with the personal AAD; assert the decrypted JSON still contains the original `tags` (`[{name,color}]`) and `generatorSettings`, and the new password; assert PUT `keyVersion == <live>` and `aadVersion == 1`.
  - Legacy upgrade (T9): seed a cache row with `aadVersion: 0` (decrypt with no AAD); edit → assert the PUT sends `aadVersion: 1` and the re-encrypted blob decrypts under the aadVersion-1 AAD.
  - Team entry → `teamEditNotSupported`. Missing/locked cache → `cacheUnavailable`.

### C4 — `keyVersion` plumbing (full chain) (locked)
Create AND edit need the LIVE vault keyVersion. Enumerate EVERY site (F2/F3/F6/T4):
1. `UnlockResult` (`VaultUnlocker.swift:14`): add `public let keyVersion: Int`.
2. `VaultUnlocker.swift:146`: construct `UnlockResult(vaultKey:, userId:, keyVersion: unlockData.keyVersion)`.
3. `AppState.vaultUnlocked` (`RootView.swift:11-18`): add associated value `keyVersion: Int`.
4. Both constructions of `.vaultUnlocked`: the real path (`RootView.swift:232`, from `unlockResult.keyVersion`) and the DEBUG path (`RootView.swift:333`). For DEBUG, source from `DebugVaultLoader.LoadedState` — add `keyVersion: Int` to that struct with a value `>= 1` (default `1`), so a debug session never sends `keyVersion: 0` (F3; the server requires `>= 1`).
5. The `.vaultUnlocked` match (`RootView.swift:52`): destructure `keyVersion` and pass to `VaultListView`.
6. `VaultListView`: add `let keyVersion: Int`; pass to `EntryForm(mode: .create, …)` and into `EntryDetailView` → `EntryForm(mode: .edit, …)` (both create and edit submit with the live version).
7. `createEntry`/`saveEntry` receive `keyVersion` as the live value (C3).
8. Defensive floor: `createEntry`/`saveEntry` use `max(1, keyVersion)` so a stray 0 (e.g. an unforeseen debug path) cannot 422 the server.
- Acceptance: `VaultUnlockerTests` — update the `makeVaultUnlockData` fixture helper to accept a `keyVersion` parameter (default `1`, so existing happy-path tests are source-compatible). Add a new test `testUnlockThreadsKeyVersionFromUnlockData` passing `keyVersion: 7` and asserting `result.keyVersion == 7` (proves the field is threaded from `unlockData.keyVersion`, not hardcoded — a default-1 fixture would pass vacuously). Existing tests retain the default `1`. Build passes with the new associated value threaded through all sites in 1-7 (compiler enforces exhaustiveness at the match site). (T11)

### C5 — UI: enable edit, add create, single shared form (locked; MUST land after C2+C3)
- `EntryForm` (generalize `EntryEditForm.swift` → both modes):
  ```swift
  enum Mode { case create; case edit(summary: VaultEntrySummary, initial: VaultEntryDetail) }
  ```
  - Fields: Title, Username, Password, URL, Notes, TOTP Secret. **Remove the Tags free-text field** (tags are not iOS-editable and are preserved server-side; leaving it would re-introduce the string-tag corruption). Add a footnote "Tags are managed in the web app."
  - Save builds `EditableEntryFields`; `.create` → `viewModel.createEntry(userId:, fields:, vaultKey:, keyVersion:, apiClient:, hostSyncService:)`; `.edit` → `viewModel.saveEntry(entryId: summary.id, userId:, fields:, vaultKey:, keyVersion:, apiClient:, hostSyncService:)`.
  - Create mode: Save enabled when title or password is non-empty. Edit mode: keep the `hasChanges` gate, recomputed against the initial detail's fields (tags excluded).
- `EntryDetailView` (F9): delete the `showEditNotSupportedAlert` state + `.alert`; the Edit button sets `isShowingEditForm = true` and presents `EntryForm(mode: .edit(summary, detail), …)`. **`loadDetail()` must read `viewModel.cacheData ?? cacheData`** (VM-owned fresh cache first, falling back to the passed-in prop only before any write). The passed-in `let cacheData` prop is captured at navigation time and goes STALE after a create/edit refreshes the VM's cache — reading it would (a) show pre-edit values after an edit and, worse, (b) FAIL to load a just-created entry's detail (the entry is absent from the old cache → `loadFailed`). Since `cacheData` is `private(set)` on the VM, `EntryDetailView` reads `viewModel.cacheData` directly.
- `VaultListView`: add a `+` toolbar button (`.topBarTrailing`) presenting `EntryForm(mode: .create, …)` as a sheet; the create button is hidden/disabled when `filterTeamId != nil` (team create unsupported). After save, the list reflects the new entry from the VM's refreshed `allSummaries`.
- Acceptance (manual, device — see the manual-test artifact): create a LOGIN → appears in list + AutoFill QuickType after sync; edit an entry with tags + TOTP, change only the password → entry stays in the list, tags + OTP intact (the regression this plan fixes); clear TOTP → one-time-code picker drops it. Unit tests cover the view-model + builder; SwiftUI views are manual.

### C6 — No regression; remove the lossy encoder (locked)
- After C3, no app code calls the lossy `encryptPersonalEntry(EntryPlaintext, OverviewPlaintext)`. Grep `encryptPersonalEntry`, `EntryPlaintext`, `OverviewPlaintext` across BOTH `ios/` source AND tests. Disposition:
  - Source: if no non-test consumer remains (AutoFill `CredentialResolver` only DECRYPTS — verified, it does not use these types), DELETE the function + `EntryPlaintext` + `OverviewPlaintext` from `EntryEncrypter.swift`.
  - Tests: migrate `VaultViewModelTests` `saveEntry` callers (currently 3, using `EntryPlaintext`/`OverviewPlaintext`) to the new `fields: EditableEntryFields` signature + `seedCache` setup; DELETE `EntryEncrypterTests` (it only tests the removed function). The build must compile with ZERO references to the deleted symbols.
  - If any consumer unexpectedly remains, document it explicitly and keep the types — but the forbidden-pattern below still bans the lossy encoder from any SAVE path.
- Forbidden pattern (post-change): `pattern: encryptPersonalEntry\( — reason: no save path may use the lossy encoder (expected: zero matches after deletion).`
- `build-for-testing` + `test-without-building` pass; existing ~261 tests green (minus deleted `EntryEncrypterTests`, plus new `PersonalEntryBlobBuilderTests`, `createEntry`/`saveEntry` tests, updated `VaultUnlockerTests` + migrated `VaultViewModelTests`). No new warnings.

## Testing strategy
- Unit (pure, the core safety net): `PersonalEntryBlobBuilderTests` locking the 10-case table in C2 — especially case 3 (vanishing-entry regression: edit-then-`EntryBlobDecoder.detail` succeeds with non-empty tags) and cases 4/8/9 (totp metadata, null fidelity, bool fidelity — all re-parsed via `JSONSerialization`, not only `JSONDecoder`).
- Unit (seams): `MobileAPIClient.createEntry` via the existing stub-session harness (method/path/body/201/200/401-retry/4xx + the `updateEntry` 200/204 regression guard); `VaultViewModel.createEntry`/`saveEntry` via mock API + sync. Add a test helper `seedCache(on:vm, entryId:, userId:, vaultKey:, blobJSON:, overviewJSON:, aadVersion:)` that encrypts real plaintext with `encryptAESGCMEncoded`+`buildPersonalEntryAAD`, builds a `CacheEntry`/`CacheData`, and calls `vm.loadFromCache(...)` so `saveEntry` can read it via `rawPlaintexts` (required for T2's round-trip assertion).
- Manual (device): documented in `docs/archive/review/ios-entry-create-edit-plan-manual-test.md` (R35) — create, edit-preserves-tags+totp, clear-totp, team-entry-blocked, and AutoFill-fills-a-freshly-created-entry.

## Considerations & constraints
- **Team entries**: read-only (existing rejection kept). Create button hidden in team filter.
- **Non-LOGIN entry types** (secure note, card, identity): out of scope — create is LOGIN-only; editing one still goes through the preserve-unknown round-trip, so a "blind" edit of its title will not corrupt its card/note-specific fields. The form only surfaces login fields.
- **generatorSettings on create**: intentionally absent (the extension's minimal POST omits it and the web reads it back fine). Not a regression.
- **keyVersion under rotation**: both create and edit encrypt with the live in-memory key and label it with the live keyVersion — consistent with the key actually used (F6). In practice all decryptable personal entries already share the live keyVersion (rotation re-encrypts the whole vault).
- **JSONSerialization Bool/null fidelity**: locked by C2 cases 8 & 9 (re-parse + typed cast).
- **TOTP clipboard hygiene (S7, [Adjacent])**: `TODO(ios-entry-create-edit): verify `TOTPCodeView` tap-to-copy routes through `copySecurely` (localOnly + expiry)` — pre-existing in an unchanged file; verify during impl, fix if not.
- **Quota-exceeded surfacing (S10-A, [Adjacent], Minor)**: the server POST enforces a per-user quota (`src/app/api/passwords/route.ts`, structured `QUOTA_EXCEEDED` error). `createEntry` maps it to a generic `MobileAPIError.serverError(status:)`, so the UI shows a generic save error (fail-closed — no entry created). `TODO(ios-entry-create-edit): optionally add `MobileAPIError.quotaExceeded` + a friendlier message`. Not blocking — the generic error is safe; nice-to-have.
- **Out of scope**: tag editing, folder assignment, favorite toggle, custom-field editing, attachment upload — web-only for now (tracked in the iOS↔extension parity roadmap, not this PR).

## User operation scenarios
- New site: tap `+`, fill title="GitHub", username, password, url="https://github.com" → Save → after sync, "GitHub" is in the list and offered by AutoFill on github.com.
- Password rotation: open an entry with 2 tags and a TOTP, Edit, change only the password → Save → the entry remains with both tags and a working OTP (pre-fix: it vanished).
- Clearing OTP: edit, blank the TOTP Secret → Save → the one-time-code picker no longer offers it; the rest is intact.
- Legacy entry: edit an `aadVersion: 0` entry → it is upgraded to `aadVersion: 1` on save (security upgrade), decrypts cleanly afterward.
- Team entry: Edit on a team entry → `teamEditNotSupported` surfaced as a save error; `+` is hidden while a team filter is active.

## Round 1 Review Resolutions (triangulate — functionality/security/testing)
All Critical + Major findings from `ios-entry-create-edit-review.md` (round 1) are folded into the contracts above:
- **S1/T1** (Critical/Major — 201 rejected) → C1 success set `200/201` in the new decoder + `updateEntry` 200/204 regression guard.
- **S2** (Critical — AAD/id desync) → C1 returns the server id; C3 asserts `serverId == entryId`, else `.entryIdMismatch`.
- **F1** (Major — saveEntry/cacheData contradiction) → C3: VM owns `cacheData` internally; no signature churn for it.
- **F2/S3/T4** (Major — keyVersion plumbing) → C4 enumerates all 8 sites incl. DEBUG + the match site.
- **F3** (Major — keyVersion 0 → 422) → C4 DEBUG supplies `>= 1`; `max(1, keyVersion)` floor.
- **F5/T7** (Major/Minor — tests break on signature change) → C6 migrates `VaultViewModelTests`, deletes `EntryEncrypterTests`.
- **F6/T9** (Major/Minor — keyVersion/aadVersion semantics) → C3: re-encrypt with LIVE keyVersion + aadVersion 1; decrypt-existing with stored aadVersion (legacy upgrade).
- **F8** (Major — optimistic duplicate) → C3: refresh `allSummaries` from the sync's fresh cache, no manual prepend.
- **S4/S5** (Major — ordering + lossy path) → Technical approach hard-orders C2→C3→C5; C6 removes the encoder; C2 forbidden-pattern bars it from the builder.
- **T2** (Major — round-trip test infra) → Testing strategy adds the `seedCache` helper.
- **T3/T5/T8** (Major/Minor — assertion precision) → C2 cases 3/8/9 specify typed re-parse assertions.
- **T6** (Minor — create test assertions) → C3 asserts `entryType`/`aadVersion`/`keyVersion` in the POST body.
- **F4** (Minor — UnlockResult test) → C4 uses a distinct fixture value (7).
- **F7** (Minor — doc) → C2 note clarifies null-vs-"" cosmetic difference.
- **S6** (Minor — UUID case) → covered by S2's id-equality check.
- **S7** (Minor, [Adjacent]) → TODO marker in Considerations.
- **S9** (Minor — R35) → manual-test artifact created.

## Round 2 Review Resolutions
Round 2 (incremental) confirmed F1-F8/S1-S9/T1-T9 resolved. New round-2 findings folded in:
- **F9** (Major — stale `cacheData` in `EntryDetailView`) → C5: `loadDetail()` reads `viewModel.cacheData ?? cacheData`.
- **T10** (Major — `createEntry` `allSummaries`-after-sync unit assertion unimplementable) → C3: narrowed to the empty-cache no-optimistic-prepend proof; end-to-end "appears once" moved to manual-test Scenario 1.
- **F10** (Minor — `rawPlaintexts` error plumbing) → C3: `do { … } catch { return nil }` specified.
- **T11** (Minor — `makeVaultUnlockData` fixture) → C4: add `keyVersion` param (default 1) + a distinct-value (7) test.
- **T12** (Minor — case 3 `generatorSettings` comparison) → C2: serialize both with `.sortedKeys` + byte-compare.
- **S10-A** (Minor, [Adjacent]) → quota-exceeded surfacing TODO in Considerations (non-blocking, fail-closed).

Security review approved with no Critical/Major. All contracts remain `locked`.

## Go/No-Go Gate
| ID  | Subject                                                        | Status |
|-----|----------------------------------------------------------------|--------|
| C1  | MobileAPIClient.createEntry (POST, 201, returns id)            | locked |
| C2  | PersonalEntryBlobBuilder (pure create + preserve-unknown edit) | locked |
| C3  | VaultViewModel.createEntry + rewritten saveEntry (owns cache)  | locked |
| C4  | keyVersion plumbing (full chain, live version, DEBUG ≥1)       | locked |
| C5  | UI: enable edit, add create, single EntryForm (after C2+C3)    | locked |
| C6  | No regression; remove the lossy encoder + migrate tests        | locked |
