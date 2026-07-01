# Plan: iOS — surface login-entry custom fields (detail view + AutoFill copy)

Plan name: `ios-custom-fields-detail-and-autocopy`
Branch: `fix/ios-custom-fields-detail-and-autocopy` (cut from `ios-main` = `origin/main`)
Date: 2026-07-01

## Project context

- **Type**: mixed (this PR touches the iOS native app + AutoFill extension only; the
  web `src/` is reference for shape parity, not modified).
- **Test infrastructure**: unit + integration (XCTest via `xcodebuild test`, runnable
  locally — `xcodebuild` Xcode 26.4.1 is available in this environment; ~526 existing
  tests). No iOS E2E for the credential-provider extension UI.
- **Verification environment constraints**:
  - **VC1 — AutoFill form-fill into a third-party app**: iOS provides NO API to fill
    arbitrary custom fields into another app's form. `ASPasswordCredential` carries
    only `user`+`password`; `ASOneTimeCodeCredential` (iOS 18+) carries a single code;
    there is no multi-field credential type. This is an OS/framework limit, not a
    project gap. Classification: **blocked-permanently** (not deferrable — impossible).
    The chosen design works *around* it (clipboard copy), it does not "fix" it.
  - **VC2 — AutoFill extension UI under test**: the credential-provider picker and the
    `completeRequest(...)` host handshake cannot be exercised in XCTest; only the pure
    decode/decision helpers are unit-testable. Custom-field *decode* and the
    *copy-decision* helper are testable (`verifiable-local`); the actual clipboard
    write + host dismissal are `blocked-deferred` to manual device test (recorded in the
    manual-test artifact).

## Objective

Make a login entry's **custom/additional fields** (`customFields` in the encrypted
blob — `{label, value, type}` where `type ∈ {text, hidden, url, boolean, date,
monthYear}`) visible and usable on iOS. Today iOS silently drops them at decode time, so
they appear nowhere: not in the host-app detail view, not in AutoFill. The user
perceives this as "additional fields are not autofilled."

Two deliverables, matching the user's chosen scope ("詳細表示 + AutoFill選択時にコピー"):
1. **Primary (complete fix)**: decode custom fields and render them, read-only + copyable,
   in the host-app `EntryDetailView` LOGIN section — reusing the existing
   `optionalFieldRow` / `optionalSecretRow` / URL-row patterns so display parity with the
   web detail view holds.
2. **Secondary (best-effort)**: after a login AutoFill selection, when the entry has
   **exactly one** custom field, copy that field's value to the clipboard (opt-in,
   fail-closed), mirroring the established `autoCopyTotp` pattern. Multiple custom fields
   have no coherent single-clipboard semantics, so copy is skipped then (the detail view
   is the path for those).

## Requirements

### Functional
- F-R1: iOS must decode `customFields` from the full blob without breaking the existing
  tolerant decode (a malformed/variant `customFields` entry must never fail the whole
  blob decode — same guarantee the current `// Decodable ignores unknown keys` comment
  relies on).
- F-R2: `VaultEntryDetail` carries the decoded custom fields, available to both the host
  app and the AutoFill extension via the single `EntryBlobDecoder.detail` source of truth.
- F-R3: The LOGIN detail section renders each custom field with display semantics matching
  the web `login-section.tsx`:
  - `url` → tappable link when `SafeURL.launchable`, else plain text; with copy.
  - `hidden` → masked reveal+copy (`SecretRow`).
  - `boolean` → "Yes"/"No" text, **no copy button**.
  - `date` / `monthYear` / `text` → plain text + copy.
- F-R4: Custom fields render only when the entry is LOGIN and the list is non-empty (no
  empty "Custom Fields" header for entries without them). Non-login types are unaffected.
- F-R5: AutoFill login fill copies the single custom field's value to the clipboard iff
  (a) the user opted in, and (b) the entry has exactly one custom field. Never throws;
  a copy failure must not affect the password fill (mirror `autoCopyTotpIfEnabled`).

### Non-functional
- F-R6: Edit round-trip preservation must remain intact — `PersonalEntryBlobBuilder`
  already preserves `customFields` via preserve-unknown round-trip; this PR must not
  regress it (no change expected there; verified by an edit-preservation test).
- F-R7: Secrets hygiene — decoded custom-field values live inside `VaultEntryDetail`,
  which `EntryDetailView` already nils out on lock/sign-out and on `.onDisappear`
  (lines 119–131). Adding a field to the struct inherits that clear; no new retained
  secret holder is introduced (R39).

## Technical approach

- **Decode (Shared)**: add a `customFields: [CustomFieldPayload]?` to
  `EntryBlobDecoder.FullBlobPayload`, decoded tolerantly. Each element is
  `{label: String, value: FlexibleString?, type: String?}` — `value` uses the existing
  `FlexibleString` so a number/bool-typed value can't throw; elements that fail to
  decode are dropped, not fatal. Map to a public model on `VaultEntryDetail`.
- **Model (Shared)**: add `public let customFields: [CustomField]` to `VaultEntryDetail`
  (non-optional, defaults to `[]` in `init` so all existing call sites compile
  unchanged). `CustomField` is a nested `public struct {label, value, type}` with `type`
  as a `String` (raw web value) plus a computed kind, OR a Swift enum mirroring
  `CUSTOM_FIELD_TYPE`. The decode payload models `label` as `String?` (an element missing a
  usable label is dropped at the mapping step). **Decision: store raw `type: String` + a
  `CustomFieldKind` enum with an `unknown` fallback case** — fail-open on display (an
  unrecognized future type renders as plain text) rather than dropping the field.
- **Display (host app)**: add a `customFieldRows(_ fields:)` `@ViewBuilder` in
  `EntryDetailTypeSections.swift` (the existing per-type-section file), called from
  `loginSections` in `EntryDetailView.swift`. The dynamic, user-supplied `field.label`
  must be the `Section` header, so the rows are built **inline** with
  `Section(field.label) { … }` (the `String`/`StringProtocol` overload, NOT
  `LocalizedStringKey`) — they CANNOT call the existing `optionalFieldRow` /
  `optionalSecretRow` helpers, which hardcode a `LocalizedStringKey` header (per F1-func
  Round-1 finding). The row *bodies* still reuse the established masked/plain/url idioms.
  Boolean → plain `Yes`/`No` (exact `value == "true"` match, mirroring web
  `login-section.tsx`), no copy button. `date` → locale-formatted via `Date.FormatStyle`
  to match the web `formatDate(value, locale)` parity (per F2-func finding); `monthYear`
  / `text` → raw string + copy.
- **AutoFill copy (extension + Shared)**: the **decision** is a pure free function
  `customFieldToCopy(detail:autoCopy:totpWillCopy:)` placed in **`ios/Shared/AutoFill/`**
  (NOT the extension target) so `PasswdSSOTests` — which links `Shared` but not the
  extension — can unit-test it, exactly as `totpToCopy` lives in `ios/Shared/TOTP/`
  (per T1-test finding, R42 cross-target visibility). `CredentialProviderViewController`
  calls it like it calls `totpToCopy`. Reuse `AppSettingsStore.autoCopyCustomField` (new
  opt-in flag, mirroring `autoCopyTotp`). **Clipboard arbitration (resolved)**: TOTP and
  custom-field copy both target the one clipboard. `totpWillCopy` is derived from the
  *actual* TOTP-copy outcome (`totpToCopy(...) != nil`, which is false when disabled,
  no secret, OR code-generation fails — per F3/S2 findings), and TOTP wins. **`hidden`-type
  custom fields are EXCLUDED from auto-copy** (fail-closed): a `hidden` value is a durable
  static secret, a strictly worse clipboard-residue exposure than a 30 s TOTP, so it is
  never auto-copied — the user copies it explicitly from the masked detail-view row
  instead (per S1-sec finding).
- **No blob-builder change**: `PersonalEntryBlobBuilder` already round-trips unknown keys;
  `customFields` is in its documented preserve list. Confirmed by reading the file.

## Contracts

### C1 — `EntryBlobDecoder` decodes custom fields (tolerant, ELEMENT-level lossy)
- **File**: `ios/Shared/Models/EntryBlobDecoder.swift`
- **Signature**: add to `private struct FullBlobPayload`:
  `let customFields: LossyCustomFields?`
  where `LossyCustomFields` is a wrapper with a **custom `init(from:)`** that decodes the
  array **element-by-element, skipping any element that throws**:
  ```swift
  private struct CustomFieldPayload: Decodable {
    let label: String?; let value: FlexibleString?; let type: String?
  }
  private struct LossyCustomFields: Decodable {
    let fields: [CustomFieldPayload]
    init(from decoder: Decoder) throws {
      var container = try decoder.unkeyedContainer()
      var acc: [CustomFieldPayload] = []
      while !container.isAtEnd {
        // Decode-or-skip each element. A non-object element (string/null/number)
        // must NOT throw the whole array — advance the cursor with a throwaway
        // decode so a single junk element can't fail the whole blob.
        if let f = try? container.decode(CustomFieldPayload.self) {
          acc.append(f)
        } else {
          _ = try? container.decode(AnyDecodableSkip.self)  // advance past the bad element
        }
      }
      fields = acc
    }
  }
  ```
  (`AnyDecodableSkip` is a permissive `Decodable` that consumes any single JSON value to
  advance the unkeyed cursor — required because a failed `try?` on `CustomFieldPayload`
  does NOT advance the container; without the skip-decode the loop can stall or mis-pair.
  Implement it as `struct AnyDecodableSkip: Decodable { init(from d: Decoder) throws { _ = try? d.singleValueContainer() } }` and verify the cursor advances in a unit test — see C1 acceptance "junk element" case.)
  `EntryBlobDecoder.detail(...)` maps `p.customFields?.fields` →
  `[VaultEntryDetail.CustomField]`, dropping elements whose `label` is nil/empty (a field
  with no usable label is dropped, not fatal).
- **Invariants** (app-enforced):
  - **Element-level tolerance**: a `customFields` array containing a non-object element
    (`"junk"`, `null`, `42`) must NOT throw the whole-blob decode — the bad element is
    skipped and the remaining valid fields + the LOGIN scalars survive. (Plain Swift
    synthesized `[CustomFieldPayload]?` does NOT do this — one bad element throws the whole
    array → whole blob → entry shows "Couldn't decrypt." This is the F1-Critical fix and
    is the R40 cross-boundary-strict-decoder trap.)
  - **Value-level tolerance**: an element whose `value` is a JSON number/bool/object/array
    must NOT throw — guaranteed by `FlexibleString` (existing SSH-`keySize` defense).
    `object`/`array`/missing value → `nil` → the field's value is `""`.
  - Entries with no `customFields` key decode to `[]` (key omitted by web when empty per
    `personal-entry-payload.ts` spread `...(validCustomFields.length > 0 && {...})`).
  - LOGIN decode path stays unconditional (AutoFill passes `entryType: nil`), so custom
    fields are populated regardless of `entryType` (web attaches them to LOGIN only).
- **Forbidden patterns**:
  - `pattern: customFields: \[CustomFieldPayload\] — reason: a synthesized array decode fails the whole blob on one bad element; must use the element-lossy LossyCustomFields wrapper`
    (the plain-array spelling is forbidden).
- **Acceptance** (all in `EntryBlobGoldenPayloadTests.swift`, raw-JSON fixtures matching the
  real producer `personal-entry-payload.ts`, NOT `CredentialResolverTests.TestFullBlob`
  which is synthetic — per T3):
  - Golden-payload: a LOGIN full blob with `"customFields":[{"label":"Recovery","value":"x","type":"text"}, …]`
    decodes to the expected `[CustomField]`.
  - **Value-drift (red-capable, RT7)**: a LOGIN blob with `"password":"s3cr3t"` and a custom
    field whose `value` is a JSON **number**, and a second whose `value` is an **object** →
    assert `XCTAssertNotNil(detail)` AND `detail.password == "s3cr3t"` AND the drifted
    field's `.value == ""`. Goes RED if `FlexibleString` is reverted to `String?`. Mirror
    `EntryBlobDecoderTests.testDetailToleratesNonScalarKeySizeWithoutFailingWholeBlob`.
  - **Element-drift (red-capable, RT7 — the F1 guard)**: a LOGIN blob with
    `"password":"s3cr3t"` and `"customFields":["junk", null, {"label":"PIN","value":"1234","type":"text"}]`
    → assert `detail` non-nil, `detail.password == "s3cr3t"`, AND
    `detail.customFields == [CustomField(label:"PIN", value:"1234", …)]` (the one valid
    field survives, the junk elements are skipped). Goes RED if the plain synthesized
    array is used instead of `LossyCustomFields`.
  - **Element-ordering / cursor-advance (red-capable, per T8)**: a blob with
    `"customFields":["junk", {"label":"A","value":"1","type":"text"}, 42, {"label":"B","value":"2","type":"text"}]`
    → assert `detail.customFields.map(\.label) == ["A","B"]` (both junk elements consumed,
    order preserved, no off-by-one pairing). This makes a cursor mis-advance fail as a
    deterministic assertion on the array contents rather than only as a test hang.
    (The `AnyDecodableSkip` advance was empirically confirmed correct in Swift 6.3.1 per
    F1-Round-2; this test pins it so a future refactor can't silently regress it.)
  - Empty/absent: blob that **omits** the `customFields` key (not `[]`) → `detail.customFields == []`.

### C2 — `VaultEntryDetail.CustomField` model + property
- **File**: `ios/Shared/Models/VaultEntryDetail.swift`
- **Signature**:
  ```swift
  public struct CustomField: Codable, Sendable, Equatable, Identifiable {
    public let id: Int            // positional index, for ForEach stability
    public let label: String
    public let value: String
    public let type: String       // raw web type string
    public var kind: CustomFieldKind { CustomFieldKind(rawValue: type) ?? .text }
  }
  public enum CustomFieldKind: String, Sendable {
    case text, hidden, url, boolean, date, monthYear
  }
  // Pure display-decision the view consumes (per T6: the hidden→masked branch is the one
  // security-relevant primitive and MUST be unit-testable without SwiftUI). Maps the
  // 6 kinds + the .text fail-open onto the 4 row renderers.
  public enum CustomFieldRowKind: Sendable, Equatable { case plain, masked, url, boolean }
  // on CustomFieldKind:
  //   var rowKind: CustomFieldRowKind {
  //     switch self { case .hidden: .masked; case .url: .url; case .boolean: .boolean;
  //                   case .text, .date, .monthYear: .plain }
  //   }
  ```
  Add `public let customFields: [CustomField]` to `VaultEntryDetail`, with
  `customFields: [CustomField] = []` defaulted in `init` (so AutoFill/test call sites
  that don't pass it compile unchanged — verified: all existing `VaultEntryDetail(...)`
  call sites use labeled args, per func Round-1).
- **Invariants** (app-enforced):
  - `kind` fail-open: unrecognized `type` → `.text` → `rowKind == .plain` (renders as plain
    copyable text), never drops the field (R41: a declared field always has a render path).
  - `id` positional and stable within a single decode (web has no per-field id); used only
    for SwiftUI `ForEach` identity, never persisted or sent to the server.
  - `date`/`monthYear` map to `.plain` for the ROW KIND (masked-vs-plain decision), but the
    `date` plain row formats its string locale-aware in C3 (the `rowKind` enum decides
    mask/plain/url/boolean only; the value-formatting is a separate C3 concern).
- **Forbidden patterns**:
  - `pattern: \.customFields! — reason: non-optional; force-unwrap signals a wrong type assumption`
- **Acceptance**: `VaultEntryDetail(...)` without `customFields` arg compiles and yields
  `[]`; `CustomFieldKind(rawValue: "totp-unknown-future") == nil` → `kind == .text`.
  **`rowKind` mapping test (T6, security-relevant — red-capable)**: assert all six raw
  types + one unknown: `hidden→.masked`, `url→.url`, `boolean→.boolean`,
  `text/date/monthYear→.plain`, `"future-x"→.plain`. Goes RED if `hidden` is ever remapped
  to `.plain` (the secret-shown-unmasked regression).
- **Consumer-flow walkthrough**:
  - Consumer A — host app `EntryDetailView.loginSections` (path:
    `ios/PasswdSSOApp/Views/Vault/EntryDetailView.swift`) reads `{label, value, kind}` of
    each `customFields` element and uses `kind` to pick the row renderer (plain / masked /
    url / boolean) and `value` as the displayed/copied string. All three fields present in
    the locked shape. ✅
  - Consumer B — AutoFill extension `completePasswordFill` (path:
    `ios/PasswdSSOAutofillExtension/CredentialProviderViewController.swift`) reads
    `customFields` (count + the single element's `value`) to decide the clipboard copy.
    Needs only `.count` and `[0].value` — present. ✅
  - Consumer C — `PersonalEntryBlobBuilder.applyEdits` (path:
    `ios/Shared/Vault/PersonalEntryBlobBuilder.swift`) does NOT read the typed
    `customFields`; it round-trips the raw JSON. So adding the typed property does not
    create a new write path — confirmed no consumer needs the typed model on the edit
    side. ✅ (prevents the "must now re-serialize customFields from the model" trap.)

### C3 — Host-app LOGIN detail renders custom fields
- **File**: `ios/PasswdSSOApp/Views/Vault/EntryDetailTypeSections.swift` (new
  `customFieldRows`), called from `ios/PasswdSSOApp/Views/Vault/EntryDetailView.swift`
  `loginSections`.
- **Signature**: `@ViewBuilder func customFieldRows(_ fields: [VaultEntryDetail.CustomField]) -> some View`
- **Invariants** (app-enforced):
  - Renders nothing when `fields.isEmpty` (no empty header).
  - Rows are built **inline** with `Section(field.label) { … }` — they do NOT call
    `optionalFieldRow`/`optionalSecretRow`, because those hardcode a `LocalizedStringKey`
    header and `field.label` is dynamic user data (func Round-1 finding). The row *bodies*
    reuse the masked/plain/url idioms.
  - Per-`rowKind` rendering (driven by `CustomFieldKind.rowKind`, C2):
    - `.masked` (`hidden`) → masked secret row (mirrors `SecretRow`: per-row `@State`
      reveal isolation so revealing one hidden field doesn't reveal siblings;
      `.privacySensitive()` on the revealed text). **`hidden` is routed unconditionally to
      the masked body — it must NEVER fall through to a plain text row, even when the value
      decoded to `""` (object-typed drift)** (per S3-sec).
    - `.url` → tappable when `SafeURL.launchable(value)`, else plain text; with copy.
    - `.boolean` → `value == "true" ? "Yes" : "No"` (exact-string match, mirroring web
      `login-section.tsx:163`; do NOT use `Bool(value)`/`!isEmpty`), localized, **no copy**.
    - `.plain` for `text`/`monthYear` → raw `value` + copy; for `date` → **locale-formatted**
      + copy, to match web `formatDate(value, locale)` parity (per F2-func). The web stores
      a bare `"YYYY-MM-DD"` (`toISODateString`). **Parse with the date-only strategy**
      `Date.ISO8601FormatStyle().year().month().day().dateSeparator(.dash)` — NOT the default
      `.iso8601`/`Date.FormatStyle` (a *formatter*, which rejects a bare date and would make
      this silently fall back to raw — per F6-func, empirically verified Swift 6.3.1). Then
      format via `Date.FormatStyle(date: .abbreviated).locale(locale)`. **On parse failure,
      show the raw `value`** (never crash). Use a UTC-fixed calendar so a bare date doesn't
      shift a day in non-UTC zones. This parse+format is a pure function → unit-test it with
      a `ja`/`en` parity case asserting non-raw output (per F6).
  - The `Section(_:)` header binds the `String`/`StringProtocol` overload (NOT
    `LocalizedStringKey`) so the user label is never looked up as an i18n key or interpolated
    (S4-sec confirm). The copy toast stays the literal `"Copied!"`; no accessibility label
    embeds a `hidden` value (S4-sec).
- **Forbidden patterns**:
  - `pattern: Section\(field\.label\) where field.label is LocalizedStringKey — reason: user label must not be looked up as an i18n key`
    (enforced by passing `String`, not `LocalizedStringKey`).
  - `pattern: hidden .* fieldRow — reason: a hidden custom field must use the masked row, never a plain fieldRow`
- **i18n**: add `"Yes"`/`"No"` to `ios/PasswdSSOApp/Localizable.xcstrings` if not already
  present (per F5-func; check the catalog first to avoid duplicate keys).
- **Acceptance**: the pure `rowKind` mapping is unit-tested (C2/T6). The actual SwiftUI
  rendering — masked-vs-plain visual, tappable URL, Yes/No, date formatting, empty-section
  suppression — is device/manual-verified per VC2 and recorded in the manual-test artifact.

### C4 — `AppSettingsStore.autoCopyCustomField` opt-in flag
- **File**: `ios/Shared/Storage/AppSettingsStore.swift`
- **Signature**: `public var autoCopyCustomField: Bool { get; nonmutating set }` backed by
  a new `Key.autoCopyCustomField = "autoCopyCustomField"`; absent key → `false`.
- **Invariants** (app-enforced): fail-closed default `false` (opt-in), identical rationale
  to `autoCopyTotp` (the calling app foregrounds post-fill and can read the clipboard).
  Stored in the App-Group suite so host + extension share it.
- **Forbidden patterns**: none beyond R2 (key string defined once in `Key`).
- **Acceptance**: unit test mirrors `AppSettingsStoreTests` for `autoCopyTotp` — absent →
  false; set true → true; cross-store-same-suite read (host writes, extension reads — mirror
  `testAutoCopyTotpReadsAcrossSeparateStoresOnSameSuite`); **literal-key pin** asserting
  `defaults.bool(forKey: "autoCopyCustomField")` after set (mirror
  `testFetchFaviconsCachedKeyConsistency`, per T7 — falsifies a drift between the public
  property and the raw key).

### C5 — AutoFill copies the single NON-SECRET custom field after login fill
- **File**: decision helper in **`ios/Shared/AutoFill/CustomFieldAutoCopy.swift`** (Shared
  framework, NOT the extension target — so `PasswdSSOTests` can unit-test it, per T1/R42,
  mirroring `ios/Shared/TOTP/AutoCopyTOTP.swift`). Call site:
  `ios/PasswdSSOAutofillExtension/CredentialProviderViewController.swift`.
- **Signature**: pure free function
  `public func customFieldToCopy(detail: VaultEntryDetail, autoCopy: Bool, totpWillCopy: Bool) -> String?`
  returning the value to copy, or `nil`. Wired into `completePasswordFill`.
- **Invariants** (app-enforced):
  - Returns `nil` unless ALL of: `autoCopy == true` AND `detail.customFields.count == 1`
    AND `totpWillCopy == false` AND **the single field's `kind != .hidden`**.
  - **`hidden` exclusion (fail-closed, per S1-sec)**: a `hidden` custom field is a durable
    static secret; placing it on the system clipboard (readable by the foregrounding host
    app before `clearAfter` fires) is a strictly worse exposure than a 30 s TOTP. A single
    `hidden` field → `nil` (NOT copied). The user copies it explicitly from the masked
    detail-view row. This is the corrected behavior vs. the over-stated
    "same-exposure-as-TOTP" claim.
  - **`totpWillCopy` semantics (per F3/S2)**: `totpWillCopy` MUST be the *actual* TOTP-copy
    outcome — the call site computes `let totpCode = totpToCopy(detail:autoCopy:now:)` ONCE,
    copies it iff non-nil, and passes `totpWillCopy: (totpCode != nil)`. It is NOT "entry has
    a TOTP secret": `totpToCopy` returns `nil` when disabled, no secret, OR code generation
    fails — a TOTP whose secret can't generate must NOT suppress the custom-field copy.
    TOTP wins only when it actually copied. The call site performs at most ONE
    `SecureClipboard.copy` from this single arbitrated decision (no two independent copies).
  - Never throws; a copy failure must not affect the password fill (best-effort, after the
    credential is built, before `completeRequest`).
- **Forbidden patterns**:
  - `pattern: detail.customFields\[0\] without a count == 1 guard — reason: indexing an empty/multi list; the guard is the contract`
    (human-review: confirm the index access is dominated by the `count == 1` check).
  - `pattern: \.hidden .* SecureClipboard\.copy — reason: a hidden custom field must never be auto-copied to the clipboard (S1)`
- **Acceptance** (pure helper unit-testable; in `PasswdSSOTests`, `@testable import Shared`):
  - `autoCopy=false` → nil regardless of fields.
  - `autoCopy=true`, 0 fields → nil; 2 fields → nil.
  - `autoCopy=true`, 1 `text` field, `totpWillCopy=false` → that value.
  - **Arbitration pair (red-capable, per T2)** — hold `detail` fixed (1 `text` field,
    `autoCopy=true`), vary only `totpWillCopy`: `true → nil`, `false → value`. Removing the
    `totpWillCopy` guard flips exactly the first case → red.
  - **hidden exclusion (red-capable, per S1)**: `autoCopy=true`, 1 `hidden` field,
    `totpWillCopy=false` → **nil**. Removing the `kind != .hidden` guard flips this → red.
- **Consumer-flow walkthrough**: the only consumer of this helper's return is the single
  `SecureClipboard.copy(value, clearAfter:)` call in `completePasswordFill`; it needs just
  the `String` value — satisfied. ✅

## Forbidden patterns (diff-wide grep keys)
- `customFields: \[CustomFieldPayload\]` (plain synthesized array — must be `LossyCustomFields`) — C1
- `\.customFields!` (force-unwrap) — C2
- `customFields\[0\]` not preceded by a `count == 1` guard in the same function — C5
- `\.hidden` adjacent to `SecureClipboard\.copy` (hidden auto-copy) — C5/S1
- `hidden` adjacent to a plain `fieldRow` (hidden shown unmasked) — C3/S3

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | EntryBlobDecoder tolerant customFields decode | locked |
| C2 | VaultEntryDetail.CustomField model + property | locked |
| C3 | Host-app LOGIN detail renders custom fields | locked |
| C4 | AppSettingsStore.autoCopyCustomField opt-in flag | locked |
| C5 | AutoFill single-custom-field clipboard copy | locked |

## Testing strategy
- **Decode (C1)**: add to `EntryBlobDecoderTests.swift` / `EntryBlobGoldenPayloadTests.swift`
  (raw-JSON fixtures matching the real producer `personal-entry-payload.ts`, NOT
  `CredentialResolverTests.TestFullBlob` which is synthetic and cannot emit a numeric/junk
  value — per T3). Two red-capable cases (RT7): (a) **value-drift** — numeric + object
  `value` in a LOGIN blob with `password:"s3cr3t"`, assert `detail` non-nil AND
  `password == "s3cr3t"` AND drifted `.value == ""` (red if `FlexibleString` → `String?`);
  (b) **element-drift** — `["junk", null, {valid}]`, assert the one valid field survives
  AND `password == "s3cr3t"` (red if the plain synthesized array is used instead of
  `LossyCustomFields`). Plus happy-path golden and absent-key→`[]` (key omitted, not `[]`).
- **Model rowKind (C2 / T6, security-relevant)**: pure unit test of
  `CustomFieldKind.rowKind` over all 6 types + 1 unknown — `hidden→.masked` is the
  red-capable security primitive (a remap to `.plain` = secret shown unmasked → red).
- **Settings (C4)**: mirror `AppSettingsStoreTests.autoCopyTotp` — absent→false, round-trip,
  cross-store-same-suite, AND the literal-key pin `forKey: "autoCopyCustomField"` (T7).
- **AutoFill decision (C5)**: pure-function tests for `customFieldToCopy` (in `PasswdSSOTests`
  via `@testable import Shared`, now reachable per T1) covering the C5 truth table —
  including the **arbitration pair** (fixed detail, vary `totpWillCopy`) and the **hidden
  exclusion** row, both red-capable (T2/S1).
- **Edit preservation (F-R6)**: a thin **pin** (NOT a fresh harness) reusing the
  `PersonalEntryBlobBuilderTests` Case-3 pattern — seed an input blob with a `customFields`
  array, assert it appears byte-equal in `applyEdits` output. Per T5 this duplicates the
  existing preserve-unknown mechanism and is documentation, not an independent regression
  guard; keep it cheap, don't oversell it.
- **Display rendering (C3)**: the SwiftUI masked/plain/url/boolean/date-format visuals and
  empty-section suppression are device/manual-verified per VC2 (the pure decision is already
  covered by the `rowKind` test above) — recorded in the manual-test artifact.
- **Manual-test artifact (R35 Tier-1, per S7)**: create
  `./docs/archive/review/ios-custom-fields-detail-and-autocopy-manual-test.md` with the
  display checks AND three **adversarial clipboard** rows that exercise the call-site wiring
  the unit tests structurally cannot reach (VC2): (a) opt-in ON, single `hidden` field →
  AutoFill → clipboard is EMPTY of the field value (S1 end-to-end); (b) opt-in ON, single
  `text` field + TOTP present → clipboard holds the TOTP, not the custom field (arbitration
  end-to-end); (c) opt-in ON, single `text` field, no TOTP → clipboard holds the field AND
  self-clears after `clipboardClearSeconds`. Sections: Pre-conditions, Steps, Expected,
  Rollback.

## Considerations & constraints
- **SC1 — form-fill into third-party apps**: out of scope permanently (VC1, OS limit). The
  clipboard copy is the sanctioned workaround, consistent with TOTP.
- **SC2 — Safari Web Extension** (DOM-level field fill, Safari-only): out of scope; owns a
  separate future initiative (new target, large). Not tracked by this PR.
- **SC3 — team entries**: this PR covers personal LOGIN entries (the common case and the
  reported bug). Team entries decrypt through the same `EntryBlobDecoder.detail`, so they
  inherit C1/C2/C3 automatically; no team-specific work is added here. If team blobs carry
  customFields they will display too — confirm in review there's no team-only decode path
  that bypasses `EntryBlobDecoder.detail`.
- **Secrets hygiene (R39)**: covered by F-R7 — no new long-lived secret holder; the detail
  struct already clears on lock/disappear.
- **Clipboard exposure**: distinguish two paths (per S1/S6).
  - **AutoFill auto-copy (C5)**: EXCLUDES `hidden` — only a single NON-secret custom field
    is auto-copied, opt-in default off, with `clipboardClearSeconds` auto-clear. A durable
    static secret is never placed on the clipboard automatically.
  - **Explicit detail-view copy (C3)**: a user tapping the copy button on a `hidden` row IS
    a user-initiated clipboard write (same profile as the existing password copy), with the
    same auto-clear — acceptable because it is an explicit action, not a silent post-fill copy.

## User operation scenarios
1. User opens a LOGIN entry on iOS that has "Recovery code" (text), "Backup PIN" (hidden),
   "Portal" (url) custom fields → detail view shows all three, PIN masked with reveal, URL
   tappable, each with copy (except boolean). Previously: none shown.
2. User triggers AutoFill on a login form for an entry with exactly one custom field, with
   the opt-in on and no TOTP → user+password filled, the single custom field on the
   clipboard ready to paste.
3. Same as #2 but the entry has a TOTP → TOTP code is copied (wins), custom field skipped;
   user reads the custom field from the app if needed.
4. Entry with 3 custom fields + AutoFill → user+password filled, nothing custom copied
   (ambiguous); detail view is the path. (Possible Minor: a future "pick which field to
   copy" sheet — out of scope, note only.)
5. Entry with a future/unknown custom-field type → renders as plain copyable text (fail-open).
