import Foundation
import SwiftUI

/// App-wide signal that the display language changed. The root view observes it
/// and re-renders its content (via `.id(token)`) so already-rendered
/// `Text("…")` / `String(localized:)` re-resolve against the new `LanguageBundle`
/// override — SwiftUI does not otherwise know the bundle's string table moved.
@MainActor
public final class LanguageRefresh: ObservableObject {
  public static let shared = LanguageRefresh()
  private init() {}

  /// Bumped on each language change; used as a `.id()` on the root content.
  @Published public private(set) var token = 0

  public func bump() { token += 1 }
}

/// Makes `String(localized:)` / `Text("…")` / `NSLocalizedString` resolve against
/// a user-chosen language at runtime, immediately and in both directions —
/// independent of `Bundle.main.preferredLocalizations`, which the OS resolves
/// once at process launch and does not refresh when `AppleLanguages` is written.
///
/// Mechanism: `Bundle.main`'s class is swapped (`object_setClass`) for this
/// subclass, which overrides `localizedString(forKey:value:table:)` to delegate
/// to the selected language's `.lproj` sub-bundle. When no override is active
/// (`.system`), it falls through to the normal `super` lookup, so the device
/// language governs.
///
/// This is the standard "in-app language switch without restart" pattern. It
/// touches only string lookup; it does not alter `Locale.current` (pair it with
/// `.environment(\.locale,)` for date/number formatting — see `AppLanguage`).
public final class LanguageBundle: Bundle, @unchecked Sendable {
  /// The `.lproj` sub-bundle to resolve strings from, or `nil` to fall through to
  /// the system localization. `nonisolated(unsafe)` because it is a process-wide
  /// switch read on the main thread during view rendering; writes happen only at
  /// launch and on an explicit user language change (both main-thread).
  nonisolated(unsafe) private static var overrideBundle: Bundle?

  /// Install the swizzle on `Bundle.main` exactly once, then apply `language`.
  /// Idempotent: safe to call on every launch and on every language change.
  public static func setLanguage(_ code: String?) {
    installIfNeeded()
    if let code,
      let path = Bundle.main.path(forResource: code, ofType: "lproj"),
      let bundle = Bundle(path: path) {
      overrideBundle = bundle
    } else {
      // Unknown code or `.system` → no override → system localization.
      overrideBundle = nil
    }
  }

  nonisolated(unsafe) private static var installed = false
  private static func installIfNeeded() {
    guard !installed else { return }
    object_setClass(Bundle.main, LanguageBundle.self)
    installed = true
  }

  public override func localizedString(
    forKey key: String, value: String?, table tableName: String?
  ) -> String {
    if let bundle = LanguageBundle.overrideBundle {
      return bundle.localizedString(forKey: key, value: value, table: tableName)
    }
    return super.localizedString(forKey: key, value: value, table: tableName)
  }

  /// The bundle to resolve against for the active override, or `Bundle.main`
  /// (system localization) when none. `String(localized:)` does NOT route through
  /// the `localizedString` swizzle (it uses `LocalizedStringResource`'s own cached
  /// resolution), so the `L10n` helpers below pass this bundle explicitly.
  static var current: Bundle { overrideBundle ?? .main }
}

/// Runtime-language-aware replacements for bare `String(localized:)`. `Text("…")`
/// and other `LocalizedStringKey` APIs route through `NSLocalizedString` and are
/// already covered by the `LanguageBundle` swizzle, so they need no change — only
/// the imperative `String(localized:)` call sites use these helpers.
public enum L10n {
  /// Replacement for `String(localized: key)` — resolves against the active
  /// language's `.lproj` bundle so it follows an in-app language switch.
  public static func string(_ key: String.LocalizationValue) -> String {
    String(localized: key, bundle: LanguageBundle.current)
  }
}
