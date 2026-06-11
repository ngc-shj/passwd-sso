import Foundation

/// Persists the auto-lock idle timeout (minutes) in the App Group suite.
///
/// Allowed range [5, 60], matching the browser extension and the server-side
/// `VAULT_AUTO_LOCK_MIN`. There is intentionally NO "never" option: a
/// permanently-unlocked local vault would outlive the session and leave a
/// "logged out but locally decryptable" state. Absent → 15 (the default).
///
/// The getter fail-closes: a missing key returns the default, and any stored
/// out-of-range value clamps into [5, 60] rather than weakening locking.
struct AutoLockSettingsStore {
  static let defaultMinutes = 15
  static let minMinutes = 5
  static let maxMinutes = 60

  private static let key = "autoLockMinutes"
  private let defaults: UserDefaults

  init(
    defaults: UserDefaults = UserDefaults(suiteName: "group.jp.jpng.passwd-sso.shared") ?? .standard
  ) {
    self.defaults = defaults
  }

  var minutes: Int {
    get {
      // Distinguish "absent" (→ default) from a stored value; integer(forKey:)
      // alone returns 0 for both, which would mask a missing key.
      guard defaults.object(forKey: Self.key) != nil else { return Self.defaultMinutes }
      return clamp(defaults.integer(forKey: Self.key))
    }
    nonmutating set {
      defaults.set(clamp(newValue), forKey: Self.key)
    }
  }

  private func clamp(_ value: Int) -> Int {
    max(Self.minMinutes, min(Self.maxMinutes, value))
  }
}
