import Foundation

/// Remembers that the server refused this member's bearer calls with
/// `PASSKEY_REQUIRED`, shared by the host app and the AutoFill extension via
/// the App Group suite.
///
/// - The host sets it on any `PASSKEY_REQUIRED` refusal and clears it on any
///   later successful authenticated call; while it is set, automatic server
///   traffic (background task, foreground re-sync, AutoFill token re-mint,
///   favicons) is skipped until the user acts.
/// - The extension reads it to explain why it has no upload token, and sets or
///   clears it from its own upload result.
///
/// Non-secret state, so UserDefaults (not Keychain) is the right store.
public struct PasskeyRequirementStore: @unchecked Sendable {
  public static let defaultsKey = "passkeyRequired"
  /// Posted (on the writing thread) when the stored value changes.
  public static let didChange = Notification.Name("PasskeyRequirementStore.didChange")

  // UserDefaults is thread-safe but not Sendable.
  private let defaults: UserDefaults

  public init(defaults: UserDefaults = .appGroup) {
    self.defaults = defaults
  }

  public var isRequired: Bool {
    defaults.bool(forKey: Self.defaultsKey)
  }

  public func markRequired() {
    set(true)
  }

  public func clear() {
    set(false)
  }

  /// Writes only on a change, so the 2xx path of every API call does not post
  /// a notification each time.
  private func set(_ value: Bool) {
    guard isRequired != value else { return }
    if value {
      defaults.set(true, forKey: Self.defaultsKey)
    } else {
      defaults.removeObject(forKey: Self.defaultsKey)
    }
    NotificationCenter.default.post(name: Self.didChange, object: nil)
  }
}

/// The web app's passkey settings page, where a member registers the passkey
/// their tenant requires: `<server>/<locale>/dashboard/settings/auth/passkey`.
/// `serverURL.appending(path:)` keeps a deployment basePath. The web app
/// serves `ja` and `en` only; the app's language override wins, otherwise the
/// device's first preferred language picks between them.
public func passkeySettingsURL(
  serverURL: URL,
  language: AppLanguage,
  preferredLanguages: [String] = Locale.preferredLanguages
) -> URL {
  let locale: String
  switch language {
  case .ja: locale = "ja"
  case .en: locale = "en"
  case .system:
    locale = (preferredLanguages.first ?? "").hasPrefix("ja") ? "ja" : "en"
  }
  return serverURL.appending(
    path: "\(locale)/dashboard/settings/auth/passkey",
    directoryHint: .notDirectory
  )
}
