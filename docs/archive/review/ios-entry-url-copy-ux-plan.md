# Plan: iOS Entry Detail — Tappable URL + Copy Feedback

## Project context

- **Type**: mixed (iOS SwiftUI app inside the passwd-sso monorepo; `ios/` coexists with web `src/`)
- **Test infrastructure**: unit tests (XCTest, `ios/PasswdSSOTests/`) + xcodebuild on simulator. No E2E for iOS.
- **Verification environment constraints**:
  - `VC1` — Opening a real browser via `openURL` cannot be asserted in XCTest; the simulator's Safari launch is an OS-side effect. **verifiable-local (manual)** via simulator tap; unit tests cover only the pure URL-safety predicate, not the OS launch.
  - `VC2` — Haptic feedback (`UINotificationFeedbackGenerator`) produces no observable signal in the simulator or in unit tests (no Taptic Engine). **blocked-deferred** for automated verification; the haptic call is fire-and-forget and cannot regress functionality. Anti-Deferral justification recorded under Considerations (SC-cost).
  - `VC3` — Toast auto-dismiss timing is a wall-clock `Task.sleep`; asserting it requires real-time waits. The toast *state transition* is testable by extracting the trigger into a pure helper; the timed reset is **blocked-deferred** for unit assertion (mirrors the existing `TOTPCodeView.copyConfirmed` pattern, which is itself untested for timing).

## Objective

Fix two reported iOS bugs in `EntryDetailView`:
1. Tapping a login entry's **URL does not open the browser** — the URL renders as plain `Text` with only a copy button.
2. **Copy feedback is too weak** — `copySecurely` writes to the pasteboard silently; the user cannot tell whether the copy succeeded.

## Requirements

### Functional
- FR1: In a LOGIN entry detail, a **safe** (http/https) URL value is tappable and opens the URL
  via the system handler (normally the browser; may route to a matching app via Universal Links — see SC-univlink/S1).
- FR2: A non-safe / unparseable URL value (e.g. `example.com` with no scheme, `javascript:…`) renders as plain selectable text — NOT a link — matching the web app's `isSafeHref` rejection behavior (adapted to http/https-only, see C1).
- FR3: Every copy action in the detail view (username, URL, password, and the per-type field rows that reuse `fieldRow`) gives the user clear, immediate feedback: a transient "Copied!" toast plus a success haptic.
- FR4: The toast auto-dismisses after a short delay and does not block interaction.

### Non-functional
- NFR1: Security parity with web's A03-1 self-XSS guard — no scheme auto-prepend; only `http`/`https` are link-eligible on iOS (a narrowing of web `safe-href.ts`, which also allows `mailto` for generic href contexts; the iOS login URL field is a website address, see C1).
- NFR2: Read-only / demo mode and auto-lock behavior unchanged. Copy + open are read-only actions already permitted in demo mode (the existing copy buttons render regardless of `isReadOnly`).
- NFR3: Localized strings (`en` + `ja`) added to `PasswdSSOApp/Localizable.xcstrings`. Reuse the existing `"Copied!"` key (already present, ja = `コピーしました！`).
- NFR4: No change to `fieldRow`'s signature used by `EntryDetailTypeSections.swift` callers — URL-link behavior is added in `loginSections`, not in the shared `fieldRow`.

## Technical approach

### C1 — Safe-URL predicate (Shared)
Add a small pure helper in `Shared/` mirroring web `isSafeHref`, but scoped to a
website-URL field. **Allowlist = http/https only** — NOT mailto. Rationale (S3/F4):
a login entry's URL field is a website address, never an email; `mailto:` opens
Mail.app rather than the browser (FR1 says "browser"), and excluding it shrinks the
iOS launch surface with zero legitimate-use loss. This deliberately diverges from web
`isSafeHref` (which also allows mailto for generic href contexts) and instead matches
the existing iOS `URLMatcher.swift:10` convention (`scheme == "http" || "https"`).

```swift
// Shared/URLMatching/SafeURL.swift
public enum SafeURL {
  /// Returns a launchable URL only when the string parses, is within a sane
  /// length bound, AND its scheme (lowercased) is http or https. No scheme is
  /// prepended, so "example.com" returns nil (rendered as plain text). This is
  /// the website-URL analog of web `isSafeHref` (A03-1 self-XSS guard), scoped
  /// to http/https per the iOS URLMatcher convention.
  public static func launchable(_ raw: String) -> URL?
}
```

- **Signature**: `static func launchable(_ raw: String) -> URL?`
- **Implementation note** (S2): Swift `URL(string:).scheme` does **NOT** lowercase the
  scheme — `URL(string: "HTTPS://x")?.scheme == "HTTPS"`. The codebase already knows
  this: `URLMatcher.swift:9` and `ServerURLSetupView.swift:54` both call
  `url.scheme?.lowercased()`. The predicate MUST do the same:
  `guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https"`.
- **Invariants** (app-enforced):
  - I1: returns non-nil ⟹ `url.scheme?.lowercased()` ∈ {`http`,`https`}. Case-insensitive.
  - I2: never prepends a scheme; `launchable("example.com") == nil`.
  - I3: `launchable("")  == nil`; whitespace-only ⟹ nil; unparseable ⟹ nil.
  - I4 (S4): reject `raw.count > 2048` ⟹ nil (length cap before parse — RS3 boundary).
- **Forbidden patterns**:
  - `pattern: https?://\\(` in EntryDetailView.swift — reason: no string-interpolated scheme prepend (NFR1).
  - `pattern: "https://" +` — reason: same, no manual scheme concatenation.
- **Acceptance** (parity vector set — mirrors web `safe-href.test.ts`, adapted to http/https-only):
  - Accept: `launchable("http://x")`, `launchable("https://example.com/path?q=1")` → non-nil.
  - Case (S2/T2): `launchable("HTTPS://EXAMPLE.COM")` → non-nil; `launchable("JavaScript:alert(1)")` → nil.
  - Reject schemes (T1): `javascript:`, `data:text/html,<script>…`, `file:///etc/passwd`,
    `chrome://settings`, `about:blank`, `ftp://x`, `mailto:a@b.com`, `tel:+1`, `sms:`,
    `myapp://x` → all nil.
  - Reject unparseable / no-scheme (T3, I2): `example.com`, `not a url`, `/relative/path`, `""` → nil.
  - Length (S4/I4): a `> 2048`-char `https://…` string → nil.

### C2 — Tappable URL row in `loginSections`
Replace the URL `fieldRow(label: "URL", value: d.url)` call with a dedicated row:

- When `SafeURL.launchable(d.url)` is non-nil: render the value as a **`Button`** (NOT
  `Link` — see F2) that opens the browser via `@Environment(\.openURL)`, keeping the
  existing copy button alongside.
- When nil (including empty): fall back to the existing `fieldRow(label: "URL", value: d.url)`
  (plain text + copy when non-empty, or `notSetText` "Not set" with no copy button when empty).

- **Signature**: `private func urlRow(_ url: String) -> some View`
- **F2 — must use Button, not Link**: SwiftUI `Link(destination:)` has no action closure,
  so I5 (record auto-lock activity on tap) is impossible with it. Use:
  ```swift
  @Environment(\.openURL) private var openURL   // on EntryDetailView
  // in urlRow's safe branch:
  Button { autoLockService?.recordActivity(); openURL(launchable) } label: { Text(url) … }
  ```
- **Invariants** (app-enforced):
  - I5a: link-styled Button rendered ⟺ `SafeURL.launchable(url) != nil`.
  - I5b: tapping it calls `openURL(launchable)` AND `autoLockService?.recordActivity()`
    first (parity with copy/eye buttons at EntryDetailView.swift:228,255).
  - I6: copy button preserved in BOTH **non-empty** branches (safe-link and plain-text);
    the empty case falls through to existing `notSetText` (no copy button), per scenario 3 (F3).
- **S1 — iOS launch-vector note (accepted risk)**: an `https://` value can be intercepted by
  **Universal Links** into another installed app rather than Safari, so FR1 "opens the browser"
  is best-effort. Custom schemes (`tel:`/`sms:`/`myapp://`) and `javascript:`/`data:`/`file:`
  are excluded by C1's allowlist (the OS would not execute `javascript:` in an app context
  regardless). We accept default Universal-Link routing (do NOT force `SFSafariViewController`)
  — it matches user expectation when they have the site's app installed, and the destination
  host is the user's own vault data. Recorded under Considerations (SC-univlink).
- **Forbidden patterns**: see C1 forbidden patterns (scheme prepend).
- **Acceptance**:
  - Manual (VC1): LOGIN entry with `url = "https://example.com"` → URL row is tappable, opens browser.
  - Manual: `url = "example.com"` → plain text, copy still works, NOT tappable.
  - Manual: `url = "javascript:alert(1)"` → plain text, NOT tappable (NFR1).
  - The per-type field rows (EntryDetailTypeSections) are unaffected — they keep using `fieldRow`.

### C3 — Copy feedback (toast + haptic)
Add a transient confirmation surfaced for ALL copy actions in the detail view.

- Add `@State private var showCopyToast: Bool = false` to `EntryDetailView`.
- `copySecurely(value:)` (the single funnel all copy buttons already call) additionally:
  1. fires a success haptic — `UINotificationFeedbackGenerator().notificationOccurred(.success)`;
  2. sets `showCopyToast = true` and schedules a reset after ~1.5 s (mirrors `TOTPCodeView` 2 s pattern; fire-and-forget `Task`).
- **Toast placement (F1/S6)**: attach `.overlay(alignment: .bottom) { copyToast }` to the
  **outer `Group`** in `body` (EntryDetailView.swift:34–59) so it survives the inner
  `detail`/`loadFailed`/`ProgressView` branch switches. The overlay is a *sibling* of the
  `isScreenRecording` content swap (EntryDetailView.swift:36), not nested inside it, so it
  would otherwise render on top of `ScreenRecordingOverlay` during a capture. Therefore gate the
  overlay content explicitly: `if showCopyToast && !isScreenRecording { … }` — this keeps the
  toast off-screen during recording and preserves the redaction posture.
- The toast shows the constant localized `"Copied!"` string — **never** the copied value (S5).
- Non-interactive: `.allowsHitTesting(false)` (I8) so it never intercepts taps on rows beneath it.
- **Clear on lock (F6)**: in the existing `onChange(of: autoLockService?.state)` handler
  (EntryDetailView.swift:108), also set `showCopyToast = false` when `newState != .unlocked`,
  so a stale toast does not float over a locked/cleared view.

- **Signature**: `copySecurely(value:)` stays `func copySecurely(value: String)`; gains the haptic + toast side effects. Extract the testable seam:
  `static func shouldShowToastAfterCopy() -> Bool` is overkill — instead keep the toast state mutation inline; the **pure** part already lives in `SafeURL`/`SecureClipboard`. No new pure helper required for C3 beyond what tests can reach.
- **Invariants** (app-enforced):
  - I7: every code path that copies vault material in this view routes through `copySecurely` (it already does — username/url via `fieldRow`, password via `passwordRow`, type rows via `fieldRow`). New copy sites MUST call `copySecurely`.
  - I8: toast is non-interactive (`allowsHitTesting(false)`) so it never intercepts taps on rows beneath it.
- **Forbidden patterns**:
  - `pattern: UIPasteboard.general.setItems` outside `SecureClipboard` in EntryDetailView.swift — reason: all copies go through the secure funnel (existing invariant).
  - `pattern: Copied \\(` (interpolated toast text) in EntryDetailView.swift — reason (S5): the toast must render the constant `"Copied!"`, never the copied secret value.
- **Acceptance**:
  - Manual: tapping any copy button shows "Copied!" toast + haptic; toast disappears after ~1.5 s.
  - Unit: `SecureClipboardTests` already proves the copy options; no behavioral change to the clipboard write. Toast timing is VC3 blocked-deferred.

### C4 — Localization
- `PasswdSSOApp/Localizable.xcstrings`: ensure `"Copied!"` is `translated` (not `stale`) — it already exists (en `Copied!`, ja `コピーしました！`). Flip `extractionState` only if the build's extraction marks it stale; otherwise leave the catalog to the compiler. No new keys required unless the toast copy diverges from `"Copied!"`.

## Contracts (Go/No-Go)

| ID | Subject | Status |
|----|---------|--------|
| C1 | `SafeURL.launchable` pure predicate (Shared, http/https only) | locked |
| C2 | Tappable `urlRow` (Button + openURL) in `loginSections` | locked |
| C3 | Copy toast + success haptic via `copySecurely` | locked |
| C4 | Localizable.xcstrings `"Copied!"` reuse | locked |
| C5 | Manual-test doc covering FR1/FR2/FR3/FR4/I5b (T6) | locked |

### Consumer-flow walkthrough
- C1 consumer — **C2 `urlRow`** (path: `EntryDetailView.swift`) reads the single `URL?` return and uses it to decide Button-link-vs-text AND as the `openURL` destination. Needs only the parsed `URL` — satisfied by C1's return type. No other field required.
- C1 consumer — **`SafeURLTests`** (path: `PasswdSSOTests/SafeURLTests.swift`, new) reads the `URL?` and asserts scheme/nil per C1's full parity vector set.
- C3 has no cross-process consumer (UI-local state).

## Testing strategy
- Unit (XCTest): new `SafeURLTests` covering C1's FULL parity vector set — the regression test for the security-relevant parity (FR2/NFR1). Vectors (mirror web `safe-href.test.ts`, adapted to http/https-only):
  - Accept: `http://x`, `https://example.com/path?q=1`.
  - Case (T2): `HTTPS://EXAMPLE.COM` → non-nil; `JavaScript:alert(1)` → nil.
  - Reject schemes (T1): `javascript:`, `data:text/html,…`, `file:///etc/passwd`, `chrome://settings`, `about:blank`, `ftp://x`, `mailto:a@b.com`, `tel:+1`, `sms:`, `myapp://x` → nil.
  - Reject unparseable/no-scheme (T3): `example.com`, `not a url`, `/relative/path`, `""` → nil.
  - Length (S4): `> 2048`-char URL → nil.
  - Split accept-cases and reject-cases into separate test methods (one concept per test).
- Anti-drift (T4): add a comment in `SafeURLTests.swift` naming `src/lib/security/safe-href.test.ts` as the parity SSoT, and a reciprocal comment in `safe-href.test.ts` noting the iOS http/https-only divergence (no mailto).
- RT7: prove-red — confirm a vector goes red if the allowlist or lowercasing regresses (e.g. temporarily drop `.lowercased()` → `HTTPS://` vector fails).
- Existing `SecureClipboardTests` unchanged — copy semantics unchanged.
- Manual test doc (R35 Tier-1 — UI surface, gated as C5): `docs/archive/review/ios-entry-url-copy-ux-manual-test.md` with simulator/device steps for: FR1 (https → browser opens), FR2 (no-scheme/`javascript:` → plain text, copy works), FR3 (any copy → "Copied!" toast + haptic), FR4 (toast auto-dismiss ~1.5 s), and I5b/T7 (open a URL just before the auto-lock interval → confirm the timer reset / vault stays unlocked). Haptic verified on a real device (VC2).
- Mandatory: `xcodebuild test -scheme PasswdSSOApp -destination 'id=<sim udid>'` green before commit.

## Considerations & constraints

- **SC-univlink (S1, accepted risk)**: An `https://` vault URL handed to `openURL` may be
  intercepted by iOS Universal Links into another installed app rather than Safari. Worst case —
  a tap opens the site's own app (or, if a malicious app claimed the host's AASA, that app's
  deep-link handler) instead of the browser. Likelihood — low (requires the user to have a
  matching app installed; the destination host is the user's own vault data, not attacker-chosen).
  Cost to fix (force Safari via `SFSafariViewController`) — moderate and degrades UX (breaks the
  user's preferred app routing). Decision: accept default Universal-Link routing; FR1 reworded to
  "opens the URL via the system handler". Custom/dangerous schemes remain excluded by C1.
- **SC-cost (VC2 haptic deferral)**: Worst case — haptic silently no-ops on a device without Taptic Engine (older iPad); user still gets the toast. Likelihood — low (visual toast is the primary cue). Cost to fix/test — automated haptic assertion is not possible in the simulator (no Taptic hardware); deferral of *automated* verification is justified, manual VC verifies on device. The feature itself ships now.
- **Scope contract**:
  - SC1 — Making URLs tappable in **non-login** type sections (e.g. an identity's website field, software-license URL) is OUT of scope; only the LOGIN `urlRow` is addressed. Owned by a future parity pass. The shared `fieldRow` is intentionally left text-only to avoid changing every type section in this PR.
  - SC2 — A user-facing setting to toggle haptics/toast is OUT of scope.
- **Auto-lock**: `urlRow` tap records activity (I5) so opening a URL counts as user activity, consistent with copy buttons.
- **Demo/read-only**: copy + open are read-only; no gating change. Verified against the existing pattern where copy buttons render regardless of `isReadOnly`.

## User operation scenarios
1. LOGIN entry, `url = "https://github.com"` → tap URL row → Safari opens github.com. Tap copy → "Copied!" toast + haptic.
2. LOGIN entry, `url = "github.com"` (no scheme) → URL row is plain text, not tappable; copy still works with feedback.
3. LOGIN entry, `url = ""` → "Not set" muted text, no link, no copy button (existing empty-field behavior).
4. LOGIN entry, malicious `url = "javascript:alert(document.cookie)"` → plain text, NOT tappable (NFR1 self-XSS guard).
5. Credit-card / SSH / identity entry → field rows unchanged (SC1); copy feedback still applies because they route through `copySecurely`.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | SafeURL.launchable (http/https only, lowercased, length-capped) | locked |
| C2 | Tappable urlRow (Button + openURL, records auto-lock activity) | locked |
| C3 | Copy toast (constant text, cleared on lock, inside redaction gate) + haptic | locked |
| C4 | Localizable reuse | locked |
| C5 | Manual-test doc (FR1/FR2/FR3/FR4/I5b) | locked |
