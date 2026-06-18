# Plan: iOS Entry Detail — Type-Specific Field Rendering

## Project context

- **Type**: iOS app (SwiftUI) within a mixed monorepo. This change is iOS-only (`ios/` tree). No web/server/CLI changes.
- **Test infrastructure**: unit tests (XCTest) via `xcodebuild test -scheme PasswdSSOApp`. No iOS E2E. SwiftUI view rendering is not unit-testable in this repo; decoder logic is.
- **Verification environment constraints**:
  - `xcodebuild` (Xcode 26.4.1) is runnable in this environment (see memory `ios-build-env-available`). Full suite (~526 tests) runs against a simulator destination. → `verifiable-local`.
  - Manual visual confirmation of each type's detail layout on a device/simulator with real encrypted entries of every type is **not** fully reproducible here (requires seeded vault entries of all 8 types). The Debug fixture loader (`DebugVaultLoader.swift`) can stand in for visual checks. → per-type visual parity = `blocked-deferred` for device verification, mitigated by decoder unit tests + Debug fixtures (see Testing strategy).

## Objective

Make the iOS read-only entry **detail** view render the correct field set for each of the 8 entry types (LOGIN, SECURE_NOTE, CREDIT_CARD, IDENTITY, BANK_ACCOUNT, SSH_KEY, SOFTWARE_LICENSE, PASSKEY), matching the web app's per-type sections. Today the detail view is hard-wired to a single LOGIN template (username / password / url / notes / TOTP) and ignores `entryType` entirely; type-specific fields (card number, IBAN, SSH private key, …) are dropped at decode time.

## Requirements

### Functional
- The detail view displays, per type, the same fields the web app shows (field lists locked in Contracts below — sourced byte-for-byte from the web `fullBlob` assembly).
- LOGIN behavior is unchanged (regression-free): username, password (reveal+copy), url, notes, TOTP.
- SECURE_NOTE shows its note `content` (the note body lives under the `content` key, NOT `notes`).
- Sensitive fields (card number, CVV, account/routing/IBAN, SSH private key & passphrase, license key, identity ID number, passkey credential id) are masked by default with a reveal+copy affordance, mirroring the password row.
- Empty/absent fields render the existing muted "Not set" placeholder (consistent with current LOGIN behavior).
- AutoFill extension behavior is unchanged.

### Non-functional
- No change to the on-the-wire / on-disk encrypted blob format (read-only consumer).
- New source files auto-included by xcodegen directory globbing; `xcodegen generate` run and regenerated `project.pbxproj` committed.
- All new user-facing labels localized in the String Catalog (EN + JA), per memory `ios-string-catalog-notes` (xcodebuild does not write back extraction — entries added by hand).
- Per global rules: files < 300 lines, functions < 40 lines. The per-type sections go in a NEW file to keep `EntryDetailView.swift` under budget.

## Technical approach

### Decode strategy: flat blob, type-gated sub-structs
The web stores a **single flat JSON object** per entry (no per-type nesting). Field names are disjoint across types except for shared keys (`title`, `notes`, `tags`, `username`, `email`). Therefore:

- `EntryBlobDecoder.detail(...)` gains an `entryType: String? = nil` parameter. LOGIN fields are decoded **unconditionally** (back-compat: AutoFill passes nil → treated as LOGIN, identical to today). When `entryType` matches a non-login type, the decoder additionally constructs that type's sub-struct from the same flat payload.
- `VaultEntryDetail` gains `entryType: String?` plus **optional per-type sub-structs** (`creditCard`, `identity`, `bankAccount`, `sshKey`, `softwareLicense`, `passkey`, `secureNote`). Grouping into sub-structs (vs ~45 flat optionals) keeps the model readable and the view's dispatch clean. Exactly one sub-struct is non-nil for a non-login entry; all are nil for LOGIN.

Rationale for `entryType`-gating (vs decode-everything-always): avoids populating a `CreditCardDetail` with all-nil fields for a LOGIN entry, and gives the view a single authoritative `category` without consulting the summary. The decoder already receives the cache row at every call site, so `entry.entryType` is in scope.

### View dispatch
`EntryDetailView.detailContent` switches on `EntryTypeCategory.from(rawType: detail.entryType)` and delegates to a per-type section builder. Reuses existing row helpers (`fieldRow`, `passwordRow`, `notSetText`, `copySecurely`, `TOTPCodeView`) plus one new standalone `SecretRow` subview (reveal+copy with its OWN per-row `@State`; `passwordRow` is left untouched — see C3). Per-type sections live in a new file `EntryDetailTypeSections.swift`.

### Call-site threading of `entryType`
Three decoder `.detail(...)` call sites pass `entryType`:
- `VaultViewModel.decryptBlob` → `entry.entryType`
- `TeamEntryDecryptor.decryptTeamDetail` → `entry.entryType`
- `CredentialResolver.decryptEntryDetail` (AutoFill) → **leave defaulted (nil)**; AutoFill only needs username/password/totp, and nil keeps its behavior byte-identical. (Recorded as deliberate, not an omission.)

## Contracts

### C1 — `VaultEntryDetail` gains `entryType` + per-type sub-structs
**File**: `ios/Shared/Models/VaultEntryDetail.swift`

Signature (additive; existing fields and `init` parameters preserved, new params appended with defaults so existing constructors compile):
```
public struct VaultEntryDetail {
  // ... all existing fields unchanged ...
  public let entryType: String?                 // new; nil ⇒ treat as LOGIN
  public let secureNote: SecureNoteDetail?      // new
  public let creditCard: CreditCardDetail?      // new
  public let identity: IdentityDetail?          // new
  public let bankAccount: BankAccountDetail?    // new
  public let sshKey: SshKeyDetail?              // new
  public let softwareLicense: SoftwareLicenseDetail? // new
  public let passkey: PasskeyDetail?            // new
}
```
Sub-struct field names (Codable, Sendable, Equatable) — **must match these blob keys verbatim**. **Every field is optional** (decode-defensive: a missing key must never fail the sub-struct decode — mirrors the existing `FullBlobPayload` contract that all variant-shape fields are optional):
- `SecureNoteDetail { content: String?; isMarkdown: Bool? }` (F2: `isMarkdown` MUST be optional — legacy notes omit it; a non-optional `Bool` makes the whole sub-struct fail to decode. `content` optional too, rendered `?? ""`.)
- `CreditCardDetail { cardholderName, cardNumber, brand, expiryMonth, expiryYear, cvv: String? }`
- `IdentityDetail { fullName, address, givenName, familyName, middleName, familyNameKana, givenNameKana, addressLine1, addressLine2, city, state, postalCode, country, phone, email, dateOfBirth, nationality, idNumber, issueDate, expiryDate: String? }`
- `BankAccountDetail { bankName, accountType, accountHolderName, accountNumber, routingNumber, swiftBic, iban, branchName: String? }`
- `SshKeyDetail { privateKey, publicKey, keyType, fingerprint, passphrase, comment, keySize: String? }` (blob keys are `passphrase`/`comment`, NOT `sshPassphrase`/`sshComment`. F6: `keySize` is typed `String?` not `Int?` — the web ssh form's `keySize` is a free text `<Input>` written as `keySize || null`, so the JSON value may be a string like `"2048"`; an `Int?` decode would fail on string-valued blobs.)
- `SoftwareLicenseDetail { softwareName, licenseKey, version, licensee, email, purchaseDate, expirationDate: String? }`
- `PasskeyDetail { relyingPartyId, relyingPartyName, username, credentialId, creationDate, deviceInfo: String? }` (provider-private fields `passkeyPrivateKeyJwk`, `passkeyUserHandle`, `passkeySignCount` etc. are NOT displayed and NOT decoded here)

All date-ish fields (`dateOfBirth`, `issueDate`, `expiryDate`, `purchaseDate`, `expirationDate`, `creationDate`) are ISO date **strings** rendered **verbatim** — no `Date` parsing (the blob stores raw text-input strings; a `Date` decode would nil-out non-ISO values).

**Invariants** (app-enforced):
- For non-login entries exactly one of the 7 sub-structs is non-nil; for LOGIN all 7 are nil.
- `notes` (top-level) continues to hold the note for all types EXCEPT SECURE_NOTE, whose body is `secureNote.content` (top-level `notes` is absent/empty for secure notes).

**Acceptance**: struct compiles; the appended init params are defaulted so the actual existing constructors still build. (Correction per F3/T5: `VaultEntryDetail(...)` is constructed only in `EntryBlobDecoder.detail` and ~15 test sites in `CredentialResolverTests.swift`/`AutoCopyTOTPTests.swift` — all use labeled args. `DebugVaultLoader.swift` does NOT construct `VaultEntryDetail`; it JSON-encodes a private LOGIN-shaped `FullBlob` struct — see C5 DebugVaultLoader scope.)

**Consumer-flow walkthrough**:
- Consumer `EntryDetailView.detailContent` (path: `ios/PasswdSSOApp/Views/Vault/EntryDetailView.swift`) reads `{ entryType, username, password, url, notes, totp*, secureNote, creditCard, identity, bankAccount, sshKey, softwareLicense, passkey }` and uses `entryType` to pick which sub-struct's fields to render.
- Consumer `AutoCopyTOTP.totpToCopy` (path: `ios/Shared/TOTP/AutoCopyTOTP.swift`) reads `{ totpSecret, totpAlgorithm, totpDigits, totpPeriod }` only — unaffected by new fields.
- Consumer `CredentialProviderViewController.autoCopyTotpIfEnabled` (path: AutoFill ext) reads `{ totpSecret, ... }` only — unaffected.

### C2 — `EntryBlobDecoder.detail` decodes type-specific fields
**File**: `ios/Shared/Models/EntryBlobDecoder.swift`

Signature:
```
public static func detail(plaintext: Data, entryId: String, teamId: String?,
                          entryType: String? = nil) -> VaultEntryDetail?
```
- `FullBlobPayload` extended with all optional type fields above (all `Decodable` optionals; absent → nil).
- LOGIN fields decoded as today regardless of `entryType` (back-compat).
- When `entryType` resolves (via `EntryTypeCategory.from`) to a non-login type, construct the matching sub-struct from the decoded payload and pass it to `VaultEntryDetail`; other sub-structs nil. `entryType` stored on the result.
- A non-login blob with absent `password` still decodes (existing behavior preserved — `password ?? ""`).
- **`entryType` source (F4)**: `entryType` comes from `CacheEntry.entryType` (the param threaded by the caller), **never** from the blob. Personal forms omit `entryType` from `fullBlob`; team writes it but we ignore the blob copy. Do NOT add an `entryType` decode key to `FullBlobPayload` (it would be nil for every personal entry and misclassify).

**Invariants**:
- Decode never throws on a well-formed blob of any type; returns nil only on JSON parse failure (unchanged contract).
- Unknown/legacy `entryType` (or nil) ⇒ LOGIN sub-struct selection (all sub-structs nil), login fields populated.

**Forbidden patterns** (grep keys for Phase 2/3 conformance):
- `pattern: sshPassphrase|sshComment` in `EntryBlobDecoder.swift` decode keys — reason: blob keys are `passphrase`/`comment`; using the web display-aliases would silently decode nil.
- `pattern: "content"` must appear in the secure-note decode path — reason: note body key is `content`, not `notes`.

**Acceptance**: new XCTest cases (C5) decode one fixture per type and assert every locked field.

### C3 — Detail view renders per-type sections
**Files**: `ios/PasswdSSOApp/Views/Vault/EntryDetailView.swift` (dispatch only; `passwordRow`/`fieldRow`/`notSetText`/`copySecurely` left untouched), new `ios/PasswdSSOApp/Views/Vault/EntryDetailTypeSections.swift` (per-type section builders as `extension EntryDetailView` + a standalone `SecretRow` subview).

- `detailContent(_ d:)` computes `let category = EntryTypeCategory.from(rawType: d.entryType)` and switches:
  - `.login` → existing rows (username, password, url, notes, TOTP) — **unchanged output** (calls the same `passwordRow`/`fieldRow` as today; T6).
  - `.secureNote` → note content section; render `secureNote.content` as `Text(...).privacySensitive()` (S2: web classifies `content` as sensitive; existing LOGIN `notes` already uses `.privacySensitive()`), "Not set" when empty (accept divergence from web's empty-area per F5).
  - `.creditCard` → cardholderName, brand, **cardNumber (SecretRow)**, expiryMonth/expiryYear, **cvv (SecretRow)**, notes.
  - `.identity` → name group, **address / addressLine1 / addressLine2 / postalCode (SecretRow)** (S1: web SSoT `SENSITIVE_FIELDS` masks these PII fields), city/state/country/phone/email/nationality/dateOfBirth/issueDate/expiryDate (plain), **idNumber (SecretRow)**, notes.
  - `.bankAccount` → bankName, accountType, accountHolderName, **accountNumber/routingNumber/iban (SecretRow)**, swiftBic (plain — public institution id), branchName, notes.
  - `.sshKey` → keyType, keySize, fingerprint (plain — public), publicKey (plain — public), **privateKey/passphrase (SecretRow)**, comment, notes.
  - `.softwareLicense` → softwareName, **licenseKey (SecretRow)**, version, licensee, email, purchaseDate, expirationDate, notes.
  - `.passkey` → relyingPartyId, relyingPartyName, username, **credentialId (SecretRow)**, creationDate, deviceInfo (plain), notes.
- **`SecretRow` subview (F7, F8, S3, S4)**: a standalone SwiftUI `View` struct (NOT a generalization of `passwordRow`, which stays as-is per T6) owning its OWN `@State private var isRevealed = false`, so revealing one secret does NOT reveal sibling secrets in multi-secret types (credit card = cardNumber + cvv; bank = accountNumber + routingNumber + iban; ssh = privateKey + passphrase). It takes `label`, `value`, and an `onCopy: (String) -> Void` closure (wired to the view's `copySecurely`) plus an `onActivity: () -> Void` (wired to `autoLockService.recordActivity()`). Both reveal-toggle and copy buttons call `onActivity`. Masked value uses the same `SecureField`/monospaced pattern as `passwordRow` and is `.privacySensitive()` when revealed.
- Per-type section builders live in `extension EntryDetailView { }` (F8) so they reach `fieldRow`, `notSetText`, `copySecurely`, `autoLockService`. Section ordering and labels mirror the web sections for parity.
- **Access-control prerequisite (F9 — compile blocker)**: `fieldRow`, `notSetText`, `copySecurely` (and any helper the new extension calls) are currently `private` in `EntryDetailView.swift`. Swift `private` is file-scoped — a same-type `extension` in a SEPARATE file cannot see them and will NOT compile. Relax these helpers from `private` to `internal` (drop the modifier) as part of C3. `autoLockService` is already an internal `let` (fine). `passwordRow`/`isPasswordVisible` stay `private` (only the `.login` branch in the same file uses them; T6).
- **`customFields` deliberately not decoded/rendered (S8)**: iOS does not surface custom fields (consistent with the existing footer "custom fields … edit those in the web app"). A future contributor adding custom-field display MUST route any password-type custom value through `SecretRow`.

**Invariants**:
- LOGIN rendering is structurally unchanged — `detailContent`'s `.login` branch calls the existing helpers with no row added/removed/reordered, and `passwordRow` is not refactored (T6).
- Every copy affordance (SecretRow AND fieldRow) routes through `copySecurely` → `SecureClipboard.copy(clearAfter:)`; NO direct `UIPasteboard` write anywhere in the new file (S3).
- Every reveal/copy on a SecretRow calls `autoLockService.recordActivity()` (S4 — parity with `passwordRow`; no new biometric gate, no weaker gate).
- Sensitive-field masking matches the web `SENSITIVE_FIELDS` SSoT (S1/S2): masked = cardNumber, cvv, accountNumber, routingNumber, iban, privateKey, passphrase, licenseKey, idNumber, credentialId, identity address/addressLine1/addressLine2/postalCode, secure-note content (`.privacySensitive()` at minimum).
- Every label string is a `LocalizedStringKey` backed by a String Catalog entry (C4).

**Forbidden patterns**:
- `pattern: UIPasteboard` — reason: must not appear in `EntryDetailTypeSections.swift`; all copy goes through `copySecurely`/`SecureClipboard` (S3).
- `pattern: passkeyPrivateKeyJwk|passkeyUserHandle|passkeySignCount` — reason: must not appear in `EntryDetailTypeSections.swift` or the `PasskeyDetail` decode path; passkey provider-private material is never surfaced (S6).
- `pattern: sshPassphrase|sshComment` — reason: blob keys are `passphrase`/`comment` (see C2).
- `detailContent` switch over `EntryTypeCategory` must be exhaustive with NO `default` clause (compiler-checked coverage; R2/R12).

**Acceptance**: build succeeds; manual/Debug-fixture check shows each type's field set with the masked fields above behind reveal. `EntryDetailView.swift` stays < 300 lines (sections extracted to the new file).

### C7 — Gate Edit button to LOGIN-only (prevent type-specific data corruption)
**File**: `ios/PasswdSSOApp/Views/Vault/EntryDetailView.swift` (toolbar Edit button + footer caption); `ios/PasswdSSOApp/Views/Vault/EntryTypeCategory.swift` (testable predicate).

**Problem (F1, corrected per F12)**: the toolbar shows an unconditional Edit button opening `EntryForm(mode: .edit(...))`, which is LOGIN-shaped (`title/username/password/url/notes/totpSecret` only). The iOS save path (`PersonalEntryBlobBuilder.applyEdits`) is a documented preserve-unknown round-trip, so it does NOT literally drop every type-specific key. The real corruption (verified): the LOGIN form pre-populates from a `VaultEntryDetail` that now has `password==""`/`url==""` for a non-login entry, and on save `applyMutation` unconditionally writes `password`, sets `url`/`username`/`notes` to NSNull, and injects a login-shaped `urlHost`/`hasTOTP` overview — polluting a card/SSH entry with empty login scalars and a login-shaped overview. Today the detail view looks login-shaped so the hazard is latent; this change makes non-login entries look first-class and editable, surfacing it. In-scope.

**Fix**:
- Add a pure, testable predicate on `EntryTypeCategory` (T11): `static func isEditableOnIOS(rawType: String?) -> Bool { from(rawType: rawType) == .login }`. The toolbar consults it.
- Gate the Edit button: render it only when `EntryTypeCategory.isEditableOnIOS(rawType: detail?.entryType)`. Nil-state (F10): `detail` is async-optional; `from(nil) == .login` so the button shows during load then hides once a non-login entry resolves — acceptable (the edit sheet body is itself `if let detail`-guarded; button-only gating suffices). Prefer hiding over disabling.
- Footer caption (F11): the existing footer "Tags, custom fields, generator settings, and password history are kept when you save an edit here — edit those in the web app" is LOGIN-edit-specific and misleading for non-login types. Scope it to the `.login` branch; for non-login show no edit-preservation caption (optionally a neutral "Edit this entry in the web app").

**Invariants**: no non-login entry can reach `EntryForm.edit` from iOS.

**Acceptance**: `isEditableOnIOS` unit-tested (C5) — true for LOGIN/nil/unknown, false for the 7 non-login types; opening a non-login entry shows no Edit affordance; LOGIN entry still shows Edit and its footer caption.

### C8 — Clear `detail` on auto-lock (broadened secret surface)
**File**: `ios/PasswdSSOApp/Views/Vault/EntryDetailView.swift`.

**Problem (S5/S9, R39)**: `detail` (`@State VaultEntryDetail?`) is cleared only on `.onDisappear`. `lock()` does NOT unmount the view, so an idle-timeout lock while an `EntryDetailView` is foregrounded leaves decrypted secrets resident — now a materially larger surface (SSH private key, passphrase, card number, CVV, IBAN, license key) than today's password+TOTP. Promoted from a testing-strategy note to a binding contract because the expanded surface makes clear-on-lock a correctness requirement.

**Fix**: observe `autoLockService.state`; on transition to a locked/logged-out state set `detail = nil`. Factor the "should clear" decision into a testable function where practical (T13). Swift `String` non-zeroization remains an accepted limitation (now covering more secret types) — out of scope to fully wipe backing bytes.

**Acceptance**: with an `EntryDetailView` (non-login) foregrounded, triggering lock clears `detail` (no decrypted secret retained in `@State`); verified via the extracted decision function unit test and/or a manual lock-while-foregrounded check.

### C4 — Localization (String Catalog)
**File**: `ios/PasswdSSOApp/.../Localizable.xcstrings` (the catalog already backing the view; confirm path during Phase 2).
- Add EN + JA entries for every new field label (cardholderName, cardNumber, brand, expiry, cvv, IBAN, routing number, SWIFT/BIC, private key, fingerprint, passphrase, license key, software name, version, licensee, purchase/expiration date, relying party, credential ID, identity name/address/contact/date fields, etc.).
- Reuse existing keys where present (Username, URL, Notes already exist).
- Follow memory `ios-string-catalog-notes`: add entries by hand (xcodebuild won't extract); `String` interpolation pitfalls N/A (static labels).

**Acceptance**: no missing-key fallbacks; JA strings present for all new labels.

### C5 — Decoder tests (one per type)
**File**: `ios/PasswdSSOTests/EntryBlobDecoderTests.swift`
- Add `testDetailDecodes<Type>Blob` for each of: secureNote, creditCard, identity, bankAccount, sshKey, softwareLicense, passkey. Each builds a plaintext JSON fixture using the **exact locked blob keys** (SSH fixture MUST use `passphrase`/`comment`, not the web display-aliases — T9) and asserts:
  - every field on the resulting sub-struct (non-default expected values so a dropped/mis-keyed mapping flips the assertion — T7);
  - sibling sub-structs are nil;
  - **unconsumed LOGIN scalars are empty for non-login types** (T1), with per-type precision (T10): `url` and `password` are non-login-absent for ALL 7 types → assert `== ""`. But `username`/`email` are SHARED keys decoded unconditionally and legitimately populate for some types (PASSKEY has `username`; IDENTITY/BANK_ACCOUNT/SOFTWARE_LICENSE/PASSKEY have `email`). Do NOT blanket-assert `username == ""`/`email == ""`; assert empty only for types whose locked blob omits that key. This catches a stray "URL/Password" row regression without producing a false assertion for identity/passkey.
- Add a **per-sub-struct minimal fixture** test (only a couple of keys present) asserting the omitted fields decode to `nil` (T2) — catches a field silently mapped to the wrong key.
- Add a regression test: LOGIN blob with `entryType: "LOGIN"` and with `entryType: nil` both yield identical login fields and all-nil sub-structs.
- Add: SECURE_NOTE asserts body comes from `content`, AND that it did NOT leak into `detail.notes` — pin the content-vs-notes split in both directions (T1).
- Add a **team-path** test (T8): `EntryBlobDecoder.detail(plaintext:, entryId:, teamId: "t1", entryType: "CREDIT_CARD")` populates `creditCard` and carries `teamId` — pins that the `TeamEntryDecryptor.decryptTeamDetail` call site's `entryType` argument is honored.
- Add an **`isEditableOnIOS` test** (T11, in `EntryTypeCategoryTests.swift`): true for `"LOGIN"`, nil, and unknown raw types (fallback-to-login); false for all 7 non-login raw types. This is the committed regression guard for the C7 data-corruption gate — the only automated coverage of that guard.

**Acceptance**: `xcodebuild test -scheme PasswdSSOApp` green. The durable guard is the per-field `XCTAssertEqual` on non-default values (T7); "temporarily breaking a key" is a one-time sanity check, not the committed safety net.

**Manual checklist additions** (Debug fixtures, T12/T13): on a credit-card / bank / SSH fixture, reveal one secret and confirm sibling secrets stay masked (SecretRow per-row `@State` isolation); with a non-login entry foregrounded, trigger lock and confirm the detail clears (C8).

### C6 — Build config / xcodegen
- Run `xcodegen generate` after adding `EntryDetailTypeSections.swift`; commit regenerated `ios/PasswdSSOApp.xcodeproj/project.pbxproj`. (Directory globbing auto-includes the file; the committed pbxproj must reflect it — see memory `ios-xcodegen-build-settings`.)

## Testing strategy
- **Unit (primary)**: C5 decoder tests — the type-gated decode is the logic surface and is fully unit-testable with plaintext fixtures (existing pattern in `EntryBlobDecoderTests.swift`).
- **Build**: `xcodegen generate` then `xcodebuild build`/`test` for `PasswdSSOApp` on a simulator destination (env supports it).
- **Manual/visual (mitigated)**: extend `DebugVaultLoader.swift` fixtures with one entry per non-login type so the detail layout can be eyeballed in the Debug build. **Non-trivial (T3)**: `DebugVaultLoader`'s `FullBlob`/`OverviewBlob` structs are LOGIN-shaped and its `CacheEntry` rows are built with `entryType` defaulted nil — realizing per-type fixtures requires adding type-specific Encodable blob shapes AND threading `entryType:` onto the debug `CacheEntry`. Scope this as a real checklist item, not a one-liner. Full device verification across all types recorded as `blocked-deferred` (see Verification environment constraints); the per-type field set + order is enumerated in C3 so the manual pass is a checklist, not a vibe check (T4).
- **Lock-state verification (S5/R39)**: confirm the navigation stack collapses (or `detail` is cleared) on auto-lock while an `EntryDetailView` is foregrounded — `detail` now holds more secret material (private key, CVV, IBAN…). Today `detail` is cleared only on `.onDisappear`. If `lock()` can leave the detail view mounted, add a lock-state observer that sets `detail = nil`. Record R39's Swift-`String` non-zeroization as a known, accepted limitation now covering a broader secret surface.

## Considerations & constraints
- **SC1** — Create/Edit form remains LOGIN-only (user-confirmed scope). Non-login entries are read-only on iOS; editing happens in the web app. Owned by a future feature if iOS edit parity is ever pursued. (Matches existing `EntryEditForm.swift` design comment.)
- **SC2** — Team entries: `TeamEntryDecryptor.decryptTeamDetail` is threaded with `entry.entryType` so team non-login entries render correctly too; no team key-pipeline change (orthogonal to memory's team QuickType gap).
- **SC3** — Markdown rendering of SECURE_NOTE `content` is out of scope; render as plain `Text`. `isMarkdown` is decoded but not acted upon (parity deferred).
- **SC4** — AutoFill `CredentialResolver.decryptEntryDetail` intentionally keeps `entryType` defaulted nil (no behavior change). Tracked here, not an omission.
- Risk: mis-spelled blob key ⇒ silent nil field. Mitigated by C5 byte-exact fixtures + forbidden-pattern greps (C2).
- Risk: `VaultEntryDetail` is `Codable` but never used over the wire (confirmed) — adding fields cannot break a decode contract.

## User operation scenarios
1. User taps a **credit card** entry in the category grid → detail shows cardholder, brand, masked card number (tap eye to reveal, copy), expiry, masked CVV, notes — not a blank password row.
2. User taps an **SSH key** entry → public key + fingerprint visible, private key & passphrase masked with reveal; no spurious "Username/Password/URL" rows.
3. User taps a **secure note** → note body shown (from `content`), no password/url rows.
4. User taps a **login** entry → identical to today (regression check).
5. User taps a **team** non-login entry → same per-type rendering as personal.
6. AutoFill fills a login → unchanged.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | `VaultEntryDetail` + per-type sub-structs | pending |
| C2 | `EntryBlobDecoder.detail` type-specific decode + `entryType` param | pending |
| C3 | Detail view per-type section dispatch + `SecretRow` (+ `private`→`internal` helper relax) | pending |
| C4 | String Catalog labels (EN+JA) | pending |
| C5 | Decoder tests per type (+ team path, content/notes split, LOGIN-scalar isolation, `isEditableOnIOS`) | pending |
| C6 | xcodegen regenerate + pbxproj commit | pending |
| C7 | Gate Edit button to LOGIN-only via `isEditableOnIOS` predicate (data-corruption guard) | pending |
| C8 | Clear `detail` on auto-lock (broadened secret surface) | pending |
