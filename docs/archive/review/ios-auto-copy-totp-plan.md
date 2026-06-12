# Plan: ios-auto-copy-totp

> Revised after Phase-1 round-1 review (functionality / security / testing). See
> `ios-auto-copy-totp-review.md`. Key corrections: two password-fill paths (not one);
> `AppSettingsStore` must move to `Shared`; default is **OFF** (opt-in); TOTP params
> (algorithm/digits/period) must propagate; clipboard writer is an injectable seam.

## Project context

- **Type**: mixed (SwiftUI iOS host app + ASCredentialProvider AutoFill extension, under `ios/`).
- **Test infrastructure**: XCTest unit tests (via `xcodebuild test`); no E2E. Launch-screen UI smoke tests only.
- Base branch: `feat/ios-auto-copy-totp` from `ios-main` (== `origin/main`, post-#552/#554). Local `main` is STALE.

## Objective

After a successful AutoFill **login (password) fill**, optionally copy the entry's current TOTP code to
the clipboard — matching the browser extension's `autoCopyTotp` — gated by a user setting (**default
OFF**) and respecting `clipboardClearSeconds` auto-clear. Closes parity item 4 (`autoCopyTotp`).

## Requirements

### Functional
- When the user fills a **login** credential via AutoFill and that entry has a TOTP secret, AND
  `autoCopyTotp` is enabled, copy the freshly-generated TOTP code to the clipboard.
- Both interactive password-fill paths are covered (see C3): the picker path AND the
  single-credential `prepareInterfaceToProvideCredential` path.
- The clipboard entry auto-clears after `clipboardClearSeconds` and must NOT sync to other devices
  (Universal Clipboard off).
- A new Settings toggle "Auto-copy TOTP after fill" (localized en/ja), **default OFF**.

### Non-functional
- Entirely offline inside the extension; TOTP secret + params come from the already-decrypted detail blob.
- Copy completes BEFORE `extensionContext.completeRequest(...)` dismisses the extension.
- No behavior change to the standalone OS one-time-code fill (`completeTOTPFill` / `ASOneTimeCodeCredential`).
- TOTP generation failure MUST NOT block the password fill (best-effort).

## Technical approach

### Two fill paths (round-1 F1/T5 correction)
The extension completes interactive login fills via **two** sites, both confirmed on post-#552 main
(`ios/PasswdSSOAutofillExtension/CredentialProviderViewController.swift`):
1. `completePasswordFill(for:)` (~L401) — the picker `onSelect` path.
2. `prepareInterfaceToProvideCredential(for:)` `.password` case (~L189-227) — iOS supplies a single
   already-chosen credential (QuickType direct tap); decrypts detail and calls `completeRequest` directly,
   NOT via `completePasswordFill`.

Both decrypt `VaultEntryDetail` (which carries `totpSecret`) before completing. The auto-copy must fire
at BOTH. To avoid divergence, the copy decision+side-effect is a single helper called from both sites.

The non-interactive `provideCredentialWithoutUserInteraction` path cancels/escalates (cannot decrypt
offline without the biometric bridge_key read) — OUT of scope, documented.

### Settings access from the extension (round-1 F2/T1 correction)
`AppSettingsStore` currently lives in the `PasswdSSOApp` app target; an app-extension cannot link the
host binary, so it cannot import the type. **Fix: move `AppSettingsStore` (and the `UserDefaults.appGroup`
extension + the `VaultTimeoutAction`/`AppTheme` enums it defines) into the `Shared` framework**, made
`public`, so both the app and the extension `import Shared` and read the same App Group suite. The
underlying `UserDefaults` data was always shared; only the *type* needs relocating. `AutoLockLimits` is
already in `Shared`.

### TOTP parameter fidelity (round-1 F3 — pre-existing bug, changed file → fix now)
`EntryBlobDecoder.detail()` currently maps only `totpSecret`, dropping `TotpPayload.algorithm/digits/period`;
`completeTOTPFill` then calls `TOTPParams(secret:)` with SHA1/6/30 defaults → wrong codes for non-default
TOTP configs. Since `CredentialProviderViewController` and `EntryBlobDecoder` are both changed by this PR,
fix it here: thread `totpAlgorithm/totpDigits/totpPeriod` onto `VaultEntryDetail`, populate them in
`detail()`, and construct full `TOTPParams` in BOTH the new copy path and the existing `completeTOTPFill`.

### Clipboard helper + testable seam (round-1 T2/S2 corrections)
`UIPasteboard` write options are not readable back, so the helper takes an injectable writer. `UIPasteboard`
is extension-safe, so `import UIKit` compiles under the Shared framework's `APPLICATION_EXTENSION_API_ONLY`
(verified at build). The three existing inline clipboard sites adopt the new helper (R17/R22 — done now, not deferred).

## Contracts

### C1 — `SecureClipboard` + injectable `PasteboardWriter` (Shared)
- **New file**: `ios/Shared/Clipboard/SecureClipboard.swift` (target: Shared).
- **Signatures**:
  ```swift
  import UIKit
  public protocol PasteboardWriter { func write(_ value: String, options: [UIPasteboard.OptionsKey: Any]) }
  public struct SystemPasteboardWriter: PasteboardWriter {
    public init() {}
    public func write(_ value: String, options: [UIPasteboard.OptionsKey: Any]) {
      UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: value]], options: options)
    }
  }
  public enum SecureClipboard {
    static let minClearSeconds = 1, maxClearSeconds = 600
    /// Local-only (no Universal Clipboard), auto-expiring copy. `seconds` is clamped to [1,600].
    public static func copy(_ value: String, clearAfter seconds: Int,
                            writer: PasteboardWriter = SystemPasteboardWriter())
  }
  ```
- **Body**: `let bounded = max(minClearSeconds, min(maxClearSeconds, seconds)); writer.write(value, options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(Double(bounded))])`.
- **Invariants**: `.localOnly: true` and a finite future `.expirationDate` ALWAYS set; `seconds` clamped (S2).
- **Acceptance**: a `MockPasteboardWriter` captures `options`; tests assert `.localOnly == true`, `.expirationDate` is in the future, and clamping at both bounds.

### C2 — `AppSettingsStore.autoCopyTotp` + relocation to Shared
- **Move**: `AppSettingsStore.swift` → `ios/Shared/Storage/AppSettingsStore.swift`; make `AppSettingsStore`, `VaultTimeoutAction`, `AppTheme`, `UserDefaults.appGroup` `public`. Update `project.yml` source membership (file moves from app-only path into Shared's path) and the test target import.
- **New property**: `public var autoCopyTotp: Bool { get nonmutating set }`, `Key.autoCopyTotp = "autoCopyTotp"`.
- **Semantics — default OFF (fail-closed, consistent with the class's documented contract)**:
  ```swift
  var autoCopyTotp: Bool {
    get { defaults.bool(forKey: Key.autoCopyTotp) }   // absent → false
    nonmutating set { defaults.set(newValue, forKey: Key.autoCopyTotp) }
  }
  ```
- **Invariant**: absent key → `false`. No fail-open exception to the class contract (resolves S1/S4/S7).
- **Consumer-flow walkthrough**:
  - Consumer A (extension, C3) `import Shared` → `AppSettingsStore()` reads `{ autoCopyTotp, clipboardClearSeconds }` from the App Group suite. Type now visible to the extension (post-move). ✓
  - Consumer B (host `SettingsView`) reads/writes `autoCopyTotp` via a `Toggle`. ✓
- **Acceptance**: absent→false; set true→true; set false→false; cross-suite round-trip (app writes, extension-side instance reads same suite).

### C3 — `totpToCopy` decision seam + hook at BOTH fill paths
- **New pure function** (target: Shared, so `PasswdSSOTests` can test it):
  ```swift
  /// Returns the TOTP code to copy, or nil. Pure; swallows generation errors.
  public func totpToCopy(detail: VaultEntryDetail, autoCopy: Bool, now: Date) -> String?
  ```
  Body: `guard autoCopy, let secret = detail.totpSecret else { return nil }; return try? generateTOTPCode(params: TOTPParams(secret: secret, algorithm: detail.totpAlgorithm, digits: detail.totpDigits, period: detail.totpPeriod), at: now)` (using the C-F3 params).
- **Hook** — in `CredentialProviderViewController`, a private helper called from BOTH sites, BEFORE each `completeRequest(withSelectedCredential:)`:
  ```swift
  private func autoCopyTotpIfEnabled(_ detail: VaultEntryDetail) {
    let s = AppSettingsStore()
    if let code = totpToCopy(detail: detail, autoCopy: s.autoCopyTotp, now: Date()) {
      SecureClipboard.copy(code, clearAfter: s.clipboardClearSeconds)
    }
  }
  ```
  Called in `completePasswordFill` and in `prepareInterfaceToProvideCredential`'s `.password` case, each immediately before its existing `completeRequest`.
- **Invariants**: best-effort (nil → no copy, fill always completes); copy strictly before `completeRequest`; `completeTOTPFill` (OS one-time-code path) UNCHANGED.
- **Forbidden patterns**:
  - `pattern: completeTOTPFill[\s\S]{0,200}SecureClipboard` — reason: must NOT touch the OS one-time-code path.
  - `pattern: completeRequest\(withSelectedCredential[\s\S]{0,80}(SecureClipboard|autoCopyTotpIfEnabled)` — reason: copy must precede completeRequest.
- **Acceptance**: `totpToCopy` matrix (below); both fill sites invoke `autoCopyTotpIfEnabled` before completion (code-review + grep).

### C4 — TOTP param fidelity (F3)
- `VaultEntryDetail` gains `totpAlgorithm: String?`, `totpDigits: Int?`, `totpPeriod: Int?`.
- `EntryBlobDecoder.detail()` populates them from `p.totp`.
- `completeTOTPFill` and `totpToCopy` build `TOTPParams(secret:algorithm:digits:period:)`.
- **R19 note**: `VaultEntryDetail` gains fields → update its memberwise-init call sites in tests (CredentialResolverTests stub) with defaults.
- **Acceptance**: detail decode test asserts algorithm/digits/period propagate; a SHA256/8-digit vector generates the correct code.

### C5 — Settings toggle (localized, default OFF)
- Add a `Toggle("Auto-copy TOTP after fill", isOn:)` bound to `AppSettingsStore().autoCopyTotp` in `SettingsView`'s clipboard/security section, with an explanatory footnote. en + 「入力後にTOTPを自動コピー」(ja).
- **Acceptance**: toggling persists under `autoCopyTotp` (C2 tests).

### C6 — Adopt `SecureClipboard` at existing sites (R17/R22, done now)
- Migrate `EntryDetailView.copySecurely` (~L234) and `TOTPCodeView` (~L80) to call `SecureClipboard.copy(value, clearAfter: AppSettingsStore().clipboardClearSeconds)`. No behavior change (same options).
- **Acceptance**: build + existing tests green; the raw `UIPasteboard.general.setItems(...)` literal no longer appears at those two sites.

## Testing strategy

- **C1**: `MockPasteboardWriter` asserts options (`.localOnly`, future `.expirationDate`) + clamp at 1 and 600.
- **C2**: `AppSettingsStoreTests` — absent→false, true/false round-trip, cross-suite (app writes / extension-side reads same `suiteName`). (T6)
- **C3 `totpToCopy` matrix** (5 cases, T7): (1) autoCopy=false→nil; (2) autoCopy=true,secret=nil→nil; (3) true,valid→code; (4) true,malformed secret→nil (throw swallowed, T4); (5) true,valid,fixed `now`→exact RFC-6238 vector.
- **C4**: detail decode propagates algorithm/digits/period; non-default-param code vector.
- **C6**: existing EntryDetail/TOTP tests stay green.
- **Manual-test artifact** (R35, security-sensitive auth flow): `docs/archive/review/ios-auto-copy-totp-manual-test.md` — Pre-conditions, Steps, Expected, Rollback, + Adversarial (foreground app reads clipboard after fill; setting tamper via App Group; non-default TOTP config).
- Full `xcodebuild test` before completion.

## Considerations & constraints

- **Default OFF** (decided): the iOS threat model differs from the browser extension — after `completeRequest`, the calling (possibly hostile) app foregrounds and can read `UIPasteboard.general`. Opt-in avoids silently weakening 2FA. `.localOnly` + finite `.expirationDate` further bound exposure once enabled.
- **Out of scope**: non-interactive QuickType fill (can't decrypt offline); team-entry fills (personal-only, per #537).
- **Build risk** (F4): `import UIKit` in Shared under `APPLICATION_EXTENSION_API_ONLY` — `UIPasteboard` is extension-safe; confirmed at build. If it unexpectedly fails, fall back to placing `SecureClipboard` in a tiny extension-API-only-clean spot, but the expectation is it compiles.

## User operation scenarios

1. Setting ON, login WITH TOTP, picker fill → password fills, TOTP on clipboard, clears after N s.
2. Setting ON, same entry, QuickType direct tap (`prepareInterfaceToProvideCredential`) → TOTP also copied (both paths).
3. Setting OFF (default) → nothing copied.
4. Non-default TOTP (SHA256/8-digit) → correct code copied (C4).
5. Malformed secret → password still fills, no copy, no crash.
6. Another device → TOTP not propagated (`.localOnly`).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `SecureClipboard` + injectable `PasteboardWriter` (Shared, clamped) | locked |
| C2 | `AppSettingsStore` → Shared + `autoCopyTotp` (default OFF) | locked |
| C3 | `totpToCopy` seam + hook at BOTH fill paths | locked |
| C4 | TOTP param fidelity (algorithm/digits/period) | locked |
| C5 | Settings toggle (localized, default OFF) | locked |
| C6 | Adopt `SecureClipboard` at existing 2 sites | locked |
