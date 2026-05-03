import Foundation

/// Stable per-install device identifier, stored in the App Group UserDefaults.
///
/// Generated once on first call and reused across app launches. Using the App
/// Group UserDefaults (rather than the per-app UserDefaults) means the same ID
/// is visible to the host app regardless of how it is launched. The server uses
/// this value for rate-limiting rollback reports; it MUST NOT change between
/// launches to prevent bypassing the rate limit.
public enum DeviceIdentifier {
  private static let key = "com.passwd-sso.deviceId"
  private static let suiteName = "group.com.passwd-sso.shared"

  /// Returns the stable device identifier, creating one if absent.
  public static func stable() -> String {
    let defaults = UserDefaults(suiteName: suiteName) ?? .standard
    if let existing = defaults.string(forKey: key), !existing.isEmpty {
      return existing
    }
    let newId = UUID().uuidString
    defaults.set(newId, forKey: key)
    return newId
  }
}
