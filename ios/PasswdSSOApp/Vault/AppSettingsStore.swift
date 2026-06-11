import Foundation

/// What happens when the idle vault timeout fires (mirrors the extension's
/// `vaultTimeoutAction`).
enum VaultTimeoutAction: String, CaseIterable {
  case lock    // drop keys, keep tokens/cache — re-unlock with passphrase
  case logout  // full sign-out — clear tokens, cache, wrapped keys
}

/// App UI theme override (mirrors the extension's `theme`).
enum AppTheme: String, CaseIterable {
  case system
  case light
  case dark
}

extension UserDefaults {
  /// Shared App Group suite used for all persisted app settings.
  /// UserDefaults is thread-safe but not `Sendable`; the unsafe annotation
  /// vouches for that across the concurrency checker.
  nonisolated(unsafe) static let appGroup =
    UserDefaults(suiteName: "group.jp.jpng.passwd-sso.shared") ?? .standard
}

/// Persists app settings in the App Group suite. Mirrors the browser
/// extension's settings (auto-lock minutes, vault timeout action, clipboard
/// auto-clear). Theme is handled separately via `@AppStorage("appTheme")` so it
/// applies app-wide reactively.
///
/// All getters fail-closed: missing/garbage values return secure defaults.
struct AppSettingsStore {
  static let defaultMinutes = 15
  static let minMinutes = 5
  static let maxMinutes = 60
  static let clipboardOptions = [10, 20, 30, 60, 120, 300]
  static let defaultClipboardSeconds = 30

  private enum Key {
    static let autoLockMinutes = "autoLockMinutes"
    static let vaultTimeoutAction = "vaultTimeoutAction"
    static let clipboardClearSeconds = "clipboardClearSeconds"
  }

  private let defaults: UserDefaults

  init(defaults: UserDefaults = .appGroup) {
    self.defaults = defaults
  }

  /// Auto-lock idle timeout in minutes. Range [5, 60]; absent → 15. There is
  /// intentionally no "never" (a permanently-unlocked local vault would outlive
  /// the session).
  var minutes: Int {
    get {
      guard defaults.object(forKey: Key.autoLockMinutes) != nil else { return Self.defaultMinutes }
      return max(Self.minMinutes, min(Self.maxMinutes, defaults.integer(forKey: Key.autoLockMinutes)))
    }
    nonmutating set {
      defaults.set(max(Self.minMinutes, min(Self.maxMinutes, newValue)), forKey: Key.autoLockMinutes)
    }
  }

  /// Action taken when the idle timeout fires. Absent/garbage → `.lock`.
  var vaultTimeoutAction: VaultTimeoutAction {
    get {
      guard let raw = defaults.string(forKey: Key.vaultTimeoutAction),
        let action = VaultTimeoutAction(rawValue: raw)
      else { return .lock }
      return action
    }
    nonmutating set {
      defaults.set(newValue.rawValue, forKey: Key.vaultTimeoutAction)
    }
  }

  /// Clipboard auto-clear delay in seconds, from the fixed option set. Absent or
  /// any value outside the options → 30.
  var clipboardClearSeconds: Int {
    get {
      guard defaults.object(forKey: Key.clipboardClearSeconds) != nil else {
        return Self.defaultClipboardSeconds
      }
      let raw = defaults.integer(forKey: Key.clipboardClearSeconds)
      return Self.clipboardOptions.contains(raw) ? raw : Self.defaultClipboardSeconds
    }
    nonmutating set {
      let value = Self.clipboardOptions.contains(newValue) ? newValue : Self.defaultClipboardSeconds
      defaults.set(value, forKey: Key.clipboardClearSeconds)
    }
  }
}
