# Plan: iOS quota-exceeded dedicated error message (S10-A)

## Project context

- **Type**: mixed repo (Next.js web app + iOS app). This change is **iOS-only** (Swift); no server change.
- **Test infrastructure**: unit tests (XCTest, ~351 iOS tests) + CI. Tests are expected for new logic.
- **CI constraint**: CI runs `macos-latest` Xcode 16.4 / iOS 18 SDK. **No iOS 26-only APIs.** Local is Xcode 26;
  verify against CI assumptions. (See memory `ios-extension-parity-roadmap`.)
- **BridgeKeyStore test note**: any `BridgeKeyStore(service:)` in tests must end with `"bridge-key"` (precondition
  aborts the process otherwise). Not touched by this change, but holds for any new test file.

## Objective

When creating a new entry hits the server's per-resource quota limit, iOS currently surfaces a generic
`serverError(status: 403)` → the user sees "Save failed: <generic HTTP 403 text>". Replace this with a
dedicated `MobileAPIError.quotaExceeded` case and a clear, localized user-facing message.

## Background (verified facts)

- **Server (no change needed)**: `POST /api/passwords` returns **HTTP 403** with body
  `{ "error": "QUOTA_EXCEEDED", "resource": "passwords", "current": <int>, "max": <int> }` when the password
  quota is exceeded (`src/app/api/passwords/route.ts:146-157`; code `API_ERROR.QUOTA_EXCEEDED`,
  status map `src/lib/http/api-error-codes.ts`). 403 is **also** used for non-quota authz failures, so the
  client MUST key off the body `error` string, not the HTTP status.
- **Client today**: `createEntry` → `performCreateHTTP` → `performBodyHTTP` → `decodeBodyResponse(data, status:)`
  (`ios/PasswdSSOApp/Network/MobileAPIClient.swift:749-758`). `decodeBodyResponse` already receives the response
  `data` but **discards it** for non-2xx, mapping everything except 404 to `serverError(status:)`.
- **Error enum**: `MobileAPIError` (`MobileAPIClient.swift:89-101`) is `Error, Equatable`; no `quotaExceeded`.
- **UI**: `VaultViewModel.createEntry` (`VaultViewModel.swift:189`) rethrows without mapping. The only consumer
  is the SwiftUI view `EntryForm.save()` (the type is named **`EntryForm`**, declared in the file
  `ios/PasswdSSOApp/Views/Vault/EntryEditForm.swift:12`, annotated `@MainActor struct EntryForm: View`),
  whose `catch` sets `saveError = String(localized: "Save failed: \(error.localizedDescription)")` (line 210).
  **Naming note**: the file is `EntryEditForm.swift` but the Swift type is `EntryForm` — all contracts/tests
  reference the type `EntryForm`.
- **Shared chokepoint**: `decodeBodyResponse` is shared by ALL body-returning requests via `performBodyHTTP`.
  Besides `createEntry`, `mintAutofillToken` (`MobileAPIClient.swift:~426`, `POST /api/mobile/autofill-token`)
  also routes through it; its caller `AutofillTokenRefresher` swallows all errors. So mapping QUOTA_EXCEEDED at
  this chokepoint changes `mintAutofillToken`'s thrown error *type* only in the (non-occurring) case that
  endpoint returns a QUOTA_EXCEEDED body — no user-visible path. Detection is **body-code-keyed** (not status),
  which keeps it forward-compatible and prevents false positives on unrelated 403s on any endpoint.
- **MobileAPIError.localizedDescription leak (S1)**: `MobileAPIError` does NOT conform to `LocalizedError`, so
  `error.localizedDescription` falls back to the `NSError` bridge — on DEBUG/TestFlight builds this can render
  the case label *and associated values* (e.g. `dpopInvalid(newNonce: Optional("…"))`) into the visible
  `saveError` string. The fix scopes the `else` branch to a controlled generic message (C3).
- **i18n**: host catalog `ios/PasswdSSOApp/Localizable.xcstrings` uses the **English text as the key**
  (e.g. key `"Save failed: %@"` → en/ja values). Hand-editing is the reliable path (xcodebuild does not write
  back extraction — memory `ios-string-catalog-notes`). The create flow is host-only; the AutoFill extension
  catalog is NOT involved.

## Requirements

- Functional: a 403 + `{error:"QUOTA_EXCEEDED"}` create response maps to `MobileAPIError.quotaExceeded`; the
  user sees a dedicated localized message (en + ja) instead of the generic "Save failed: …".
- Non-functional / no-regression: every non-quota error keeps its current message and mapping
  (403-without-quota-code still → `serverError(403)`; 404 still → `notFound`; etc.).
- No internal jargon in the UI string (R37): no "quota", "QUOTA_EXCEEDED", "resource"; use plain wording
  ("item limit" / 「上限」). "Vault"→「保管庫」 per prior directive.

## Technical approach

- Detect quota at the single existing chokepoint `decodeBodyResponse` (shared by all body-returning requests;
  create is the only path that can realistically return it — harmless for the others). Decode a minimal error
  envelope `{ error: String }` from the body on non-success and branch on the code string.
- Add `case quotaExceeded` (no associated values — KISS; the create flow's resource is always `passwords` and a
  single generic-but-clear message covers it. Richer messaging with `max` is explicitly out of scope unless a
  reviewer shows a concrete need).
- Extract the save-error → message mapping into a **testable `nonisolated static` helper** on `EntryForm` so it
  can be unit-tested without driving SwiftUI or MainActor dispatch, then special-case `.quotaExceeded` there.
- Add the localized strings to the host String Catalog (en + ja), hand-authored.

## Contracts

### C1 — `MobileAPIError.quotaExceeded` case
- **Location**: `ios/PasswdSSOApp/Network/MobileAPIClient.swift`, enum `MobileAPIError` (lines 89-101).
- **Signature**: add `case quotaExceeded` (enum remains `Error, Equatable`; no associated values).
- **Invariant**: no associated values — keeps `Equatable` synthesis trivial and matches the single create resource.
- **Acceptance**: `MobileAPIError.quotaExceeded == MobileAPIError.quotaExceeded` is `true`; distinct from every
  other case. **No exhaustive `switch` over `MobileAPIError` exists in the iOS tree** (verified round 1, F3) —
  adding a case breaks nothing; re-verify with grep at implementation time (R19).

### C2 — quota detection in `decodeBodyResponse`
- **Location**: `MobileAPIClient.swift:749-758`.
- **Signature (unchanged)**: `private func decodeBodyResponse(_ data: Data, status: Int) throws -> Data`.
- **New private type**: `private struct APIErrorEnvelope: Decodable { let error: String }`.
- **Behavior**: `case 200, 201` unchanged (return data); `case 404` unchanged (`throw .notFound`); **default**:
  if `try? JSONDecoder().decode(APIErrorEnvelope.self, from: data)` succeeds AND `error == "QUOTA_EXCEEDED"` →
  `throw .quotaExceeded`; otherwise `throw .serverError(status: status)`. (`try?` makes empty/malformed bodies
  fall through safely — no crash; extra body fields `resource`/`current`/`max` are ignored by JSONDecoder.)
- **Invariant**: quota detection keys off the **body `error` string** (exact `==`, not prefix/substring), never
  off the HTTP status alone. This is the single detection point; the literal `"QUOTA_EXCEEDED"` appears exactly
  once in `MobileAPIClient.swift`.
- **Shared-chokepoint note (F2/S2)**: `decodeBodyResponse` is shared (also serves `mintAutofillToken`). Mapping
  here is intentional and forward-compatible. The only UI-surfaced consumer is `createEntry`→`EntryForm`; all
  other body-returning callers either propagate (no quota body in practice) or swallow (`AutofillTokenRefresher`).
  No regression. The behavior is body-code-keyed so unrelated 403s on any endpoint still map to `.serverError`.
- **Forbidden patterns**:
  - `pattern: status == 403` (as the quota branch condition) — reason: must not branch quota on status; detection
    is body-code based and forward-compatible.
  - `pattern: "QUOTA_EXCEEDED"` appearing more than once in `MobileAPIClient.swift` — reason: single detection
    point; no scattered string checks.
- **Acceptance**:
  - 403 body `{"error":"QUOTA_EXCEEDED",...}` → throws `.quotaExceeded`.
  - 403 body `{"error":"FORBIDDEN"}` → throws `.serverError(status: 403)` (over-broad-detection guard).
  - 403 **empty** body (`Data()`) → throws `.serverError(status: 403)` (no crash).
  - 403 **malformed** body (`{invalid`) → throws `.serverError(status: 403)` (no crash).
  - 200/201 → returns data unchanged; 404 → `.notFound`.
- **Consumer-flow walkthrough**:
  - `performBodyHTTP` non-retry path (`MobileAPIClient.swift:746`) and **401-nonce-retry path (line 743)** BOTH
    route through `decodeBodyResponse` — quota detection is preserved on a post-retry 403. ✔
  - `performCreateHTTP` (`MobileAPIClient.swift:762-769`) reads `Data` only on success; on throw it propagates the
    error unchanged. Uses no error fields — pass-through. ✔
  - `VaultViewModel.createEntry` (`VaultViewModel.swift:189-229`) does not catch; propagates the thrown
    `MobileAPIError` unchanged. ✔
  - `EntryForm.save()` (`EntryEditForm.swift:186-211`) catches and routes through C3, which pattern-matches the
    `.quotaExceeded` case identity (the only field it needs; locked shape provides it). ✔

### C3 — testable save-error message mapping in `EntryForm`
- **Location**: `ios/PasswdSSOApp/Views/Vault/EntryEditForm.swift` (type `EntryForm`).
- **Signature**: `nonisolated static func saveErrorMessage(for error: Error) -> String`.
  - `nonisolated` so XCTest can call it without `@MainActor`/`await MainActor.run` (T2/T7).
  - `internal` (the Swift default) — **must NOT be `private`/`fileprivate`** (F5); `PasswdSSOTests` is a hosted
    test target (`BUNDLE_LOADER`/`TEST_HOST`), so internal symbols are reachable.
- **Behavior**:
  - if `(error as? MobileAPIError) == .quotaExceeded` → return `String(localized: "<C4 quota key>")`.
  - else → return `String(localized: "<C4 generic key>")` — a controlled generic message. **Does NOT interpolate
    `error.localizedDescription`** (fixes S1: prevents leaking `MobileAPIError` case labels / associated values
    such as a DPoP nonce into the UI on debug builds).
- **Call site change**: `save()` catch becomes `saveError = EntryForm.saveErrorMessage(for: error)` (replaces the
  inline `String(localized: "Save failed: \(error.localizedDescription)")`). The same `catch` handles create and
  edit; `.quotaExceeded` is only reachable on the create path (edit → `decodeVoidResponse`, never quota) — the
  helper handling it for edit is harmless dead-branch coverage (F8).
- **Invariant**: the helper is a pure function (no view state, no actor isolation); identical input → identical
  output. Behavior change vs. today is intentional and limited to non-quota errors now showing a controlled
  generic message instead of an interpolated `localizedDescription` (S1 hardening).
- **Acceptance**: `saveErrorMessage(for: MobileAPIError.quotaExceeded)` `==` `String(localized: "<C4 quota key>")`
  AND `!=` `saveErrorMessage(for: MobileAPIError.notFound)`.

### C4 — localized strings (host catalog)
- **Location**: `ios/PasswdSSOApp/Localizable.xcstrings` (host only; AutoFill extension catalog not involved).
- **Keys (literal-English-as-key, matching project convention)**:
  - quota key: `"You've reached your vault's item limit. Remove unused items and try again."`
  - generic key: `"Could not save. Please try again."`
- **Localizations** — each key gets `en` + `ja` `stringUnit`s; **the `ja` `stringUnit` MUST be**
  `"state": "translated"` (NOT `"needs_review"`) or `LocalizationCatalogTests` fails (T4). Set the entry's
  `extractionState: "manual"` (hand-authored). Exact JSON shape to mirror the existing `"Save failed: %@"` entry:
  ```json
  "You've reached your vault's item limit. Remove unused items and try again." : {
    "extractionState" : "manual",
    "localizations" : {
      "en" : { "stringUnit" : { "state" : "translated", "value" : "You've reached your vault's item limit. Remove unused items and try again." } },
      "ja" : { "stringUnit" : { "state" : "translated", "value" : "保管庫の項目数が上限に達しました。不要な項目を削除してから、もう一度お試しください。" } }
    }
  }
  ```
  generic key ja value: 「保存できませんでした。もう一度お試しください。」
- **Cleanup**: the old `"Save failed: %@"` key becomes unused once C3 stops interpolating — remove it from the
  catalog (avoids a stale `extractionState:"stale"` entry; verify no other references with grep).
- **Invariant (R37)**: no implementation jargon ("quota"/"QUOTA_EXCEEDED"/"resource"/"403") in any value;
  "Vault"→「保管庫」 per prior directive.
- **Acceptance**: both keys present with `en`+`ja` translated units; `LocalizationCatalogTests` green.

### C5 — tests
All stubbed HTTP responses use **real JSON body bytes**, never `Data()` where the body must be decoded (T1, RT1).
- **MobileAPIClientTests** (`ios/PasswdSSOTests/MobileAPIClientTests.swift`): each test below MUST first seed a
  valid access token (`seedAccessToken()`, or inline `tokenStore.saveTokens(...)`) — `createEntry` calls
  `validAccessToken()` first and throws `.authenticationRequired` before the mock is reached otherwise (T8).
  - `testCreateEntry_quotaExceededBodyMapsToQuotaExceeded`: stub `(Data(#"{"error":"QUOTA_EXCEEDED","resource":"passwords","current":10000,"max":10000}"#.utf8), httpResponse(status: 403, ...))` → `createEntry` throws `MobileAPIError.quotaExceeded`.
  - `testCreateEntry_403WithoutQuotaCodeMapsToServerError`: stub `(Data(#"{"error":"FORBIDDEN"}"#.utf8), 403)` → throws `.serverError(status: 403)`.
  - `testCreateEntry_403WithEmptyBodyMapsToServerError`: stub `(Data(), 403)` → `.serverError(status: 403)` (no crash) (T5).
  - `testCreateEntry_403WithMalformedBodyMapsToServerError`: stub `(Data("{invalid".utf8), 403)` → `.serverError(status: 403)` (no crash) (T5).
- **VaultViewModelTests** (`ios/PasswdSSOTests/VaultViewModelTests.swift`):
  - `testCreateEntry_quotaExceededPropagates`: stub the 403+QUOTA_EXCEEDED body via `MockURLProtocol.requestHandler` (the existing HTTP-layer mock pattern — there is NO protocol mock over the concrete `MobileAPIClient` actor; T3/F7), the handler returns 403 immediately (no preceding 201 — T6) → `viewModel.createEntry(...)` throws `MobileAPIError.quotaExceeded`.
- **EntryForm mapping** (new file `ios/PasswdSSOTests/EntryFormTests.swift`):
  - `testSaveErrorMessage_quotaExceededIsDedicated`: assert `EntryForm.saveErrorMessage(for: MobileAPIError.quotaExceeded)` `==` `String(localized: "<C4 quota key>")` (compute expected via the same `String(localized:)` call so resolution is identical — avoids vacuous/locale-fragile compare; T2) AND `!=` `EntryForm.saveErrorMessage(for: MobileAPIError.notFound)`. Helper is `nonisolated` → no MainActor wrapping needed.
- **Invariant (RT1)**: stubbed HTTP responses match the real server wire shape (403 + the documented JSON body).

## Testing strategy

- Unit tests per C5. Run on simulator (iOS 26.1 local OK) via `xcodegen generate` → `build-for-testing` +
  `test-without-building`; full suite green, no crashes.
- Manual smoke (optional, documented in considerations): trigger a real create against a quota-exhausted vault
  and confirm the dedicated message renders in both locales. Not blocking (requires a seeded over-quota account).

## Considerations & constraints

- **Out of scope**: carrying `resource`/`current`/`max` into the message; team-entry quota; attachment/file-send
  quota; any server change; `decodeVoidResponse` (no create-quota path flows through it; edit/PUT uses it).
- **No new endpoint / no new network call** — pure client-side mapping of an already-returned response.
- **R37**: UI strings must avoid internal tokens (enforced by C4 invariant + reviewer grep).
- **R19**: `MobileAPIError` is `Equatable`; adding a no-payload case cannot break exact-shape decoders; round 1
  confirmed no exhaustive `switch` over `MobileAPIError` — re-grep at implementation time.
- **S1 follow-up (not in this PR)**: a full `MobileAPIError: LocalizedError` conformance with per-case localized
  messages would give richer non-quota messages, but expands scope (≈8 new strings). Deferred as a tracked TODO;
  this PR's controlled generic fallback already closes the info-leak. `TODO(ios-quota-exceeded-message): consider
  MobileAPIError: LocalizedError for richer per-case save messages.`

## User operation scenarios

1. Free/limited vault at the password cap → user taps "+", fills a login, taps Save → server 403
   QUOTA_EXCEEDED → form shows the dedicated localized "item limit reached" message; the form stays open so the
   user can cancel or free space. (Today: confusing generic "Save failed: …403".)
2. Save fails for an unrelated reason (network, 404, other 403) → unchanged generic message (no regression).
3. Japanese-locale device → quota message renders in Japanese.

## Go/No-Go Gate

| ID  | Subject                                                   | Status |
|-----|----------------------------------------------------------|--------|
| C1  | `MobileAPIError.quotaExceeded` case                      | locked |
| C2  | quota detection in `decodeBodyResponse` (body-code keyed)| locked |
| C3  | testable `EntryForm.saveErrorMessage(for:)` mapping      | locked |
| C4  | localized quota string (en + ja, host catalog)           | locked |
| C5  | unit tests (client mapping, VM propagation, UI message)  | locked |
