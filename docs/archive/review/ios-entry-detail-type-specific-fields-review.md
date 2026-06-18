# Plan Review: ios-entry-detail-type-specific-fields

Date: 2026-06-19
Review rounds: 2 (triangulate: Functionality / Security / Testing)

## Root cause (investigation)

The iOS entry detail view does not branch on entry type at all. `EntryDetailView.detailContent` unconditionally renders LOGIN fields (username/password/url/notes/TOTP); `VaultEntryDetail` carries only login fields and no `entryType`; `EntryBlobDecoder.detail` decodes only the login blob shape. Type-specific fields (card number, IBAN, SSH key, identity, etc.) are dropped at decode time. Web (`password-detail-inline.tsx`) branches per type with dedicated sections — iOS never did.

Scope (user-confirmed): all 7 non-login types; read-only detail rendering only (edit form stays login-only).

## Round 1 — findings & resolutions

### Functionality
- **F1 (Major)** Edit button unguarded → non-login save corrupts entry → **C7** (gate Edit to login-only).
- **F2 (Major)** `isMarkdown: Bool` non-optional fails decode on absent key → **C1** all sub-struct fields optional.
- **F3 (Minor)** DebugVaultLoader does not construct `VaultEntryDetail` → C1 acceptance corrected.
- **F4 (Minor)** `entryType` not in personal blob → **C2** sources it from `CacheEntry.entryType`.
- **F6 (Minor)** `keySize` may be a string in blob → **C1** `keySize: String?`; dates verbatim strings.
- **F7 (Minor)** shared reveal state leaks all secrets → **C3** `SecretRow` standalone subview, own `@State`.
- **F8 (Minor)** free functions can't reach view state → **C3** `extension EntryDetailView`.

### Security
- **S1 (High)** identity address/addressLine1/addressLine2/postalCode rendered plain (web masks them) → **C3** routed through SecretRow.
- **S2 (Med)** secure-note `content` not privacy-sensitive → **C3** `.privacySensitive()`.
- **S3 (Low)** copy must use `copySecurely`/`SecureClipboard` → **C3** invariant + `UIPasteboard` forbidden-pattern.
- **S4 (Low)** reveal/copy must call `recordActivity()` → **C3** invariant.
- **S5 (Low)** broadened secret surface held at lock → testing-strategy item (promoted in round 2 → **C8**).
- **S6/S7** passkey provider-private excluded; no secret logging → confirmed clean, forbidden-pattern grep added.

### Testing
- **T1 (Med)** assert LOGIN scalars empty for non-login + content/notes both directions → **C5**.
- **T2 (Low)** per-sub-struct absent→nil test → **C5**.
- **T3 (Med)** DebugVaultLoader non-trivial → testing-strategy scoped.
- **T6 (Med)** keep `passwordRow` untouched for LOGIN regression → **C3** structural invariant.
- **T7 (Low)** non-default expected values are the committed guard → **C5** acceptance.
- **T8 (Med)** team non-login decoder test → **C5**.
- **T9 (Low)** SSH fixture uses `passphrase`/`comment` → **C5** + grep.

## Round 2 — findings & resolutions

### Functionality
- **F9 (Compile blocker)** `private` helpers are file-scoped; cross-file `extension` cannot see them → **C3** relax `fieldRow`/`notSetText`/`copySecurely` to `internal`.
- **F10 (Minor)** C7 nil-state (`detail` async-optional) → **C7** nil → `.login`, button shows during load then hides (acceptable).
- **F11 (Minor)** login-edit footer caption misleading for non-login → **C7** scope footer to `.login`.
- **F12 (prose)** edit path `applyEdits` preserves unknown keys — the "silently drops every field" rationale was wrong; real corruption is empty-login-scalar + login-shaped overview pollution → **C7** rationale corrected (fix unchanged).

### Security
- **S8 (Low/doc)** `customFields` not decoded/rendered on iOS → **C3** note (future custom-field display must use SecretRow).
- **S9 (Med)** promote S5 lock-clear from prose to binding contract (`lock()` does leave view mounted; surface expanded) → **C8**.

### Testing
- **T10 (Minor)** LOGIN-scalar-isolation must be per-type precise — `username`/`email` are shared keys → **C5** precision note.
- **T11 (Med, high value)** extract C7 gate as pure `EntryTypeCategory.isEditableOnIOS(rawType:)` predicate + unit test (only automated coverage of the data-corruption guard) → **C7** + **C5**.
- **T12 (Low)** SecretRow per-row reveal isolation → manual Debug-fixture checklist.
- **T13 (Low)** lock-clear decision → testable function / manual checklist.

## Status

All round-1 and round-2 findings resolved in the plan (8 contracts C1–C8, Go/No-Go all `pending` → to be locked at implementation start). The one compile blocker (F9) and the factually-wrong rationale (F12) are corrected. No unresolved Critical/Major.

## Recurring Issue Check (consolidated)
- R2/R12 (enum/switch exhaustiveness): OK — `EntryTypeCategory` 8 cases, no-`default` switch, web parity verified byte-for-byte.
- R3 (propagation): all 3 `.detail` call sites accounted for; AutoFill deliberately nil (SC4).
- R19/R5 (test/constructor alignment): additive defaulted params keep all constructors/tests compiling.
- R25 (persist/hydrate): N/A — read-only consumer; `VaultEntryDetail` Codable never used over wire.
- R39 (lifecycle zeroization): addressed by C8 (clear on lock); Swift String non-zeroization accepted limitation.
