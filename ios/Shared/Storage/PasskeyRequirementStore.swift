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
  /// Posted locally when ANY process (the host app or the AutoFill extension)
  /// changed the value — relayed from the Darwin notification below, so a
  /// listener in one process hears the other's write. Requires
  /// `observeOtherProcesses()` to have run in the listening process.
  public static let didChangeInAnyProcess = Notification.Name("PasskeyRequirementStore.didChangeInAnyProcess")
  /// Darwin (cross-process) notification name. Carries no payload; listeners
  /// re-read the shared suite.
  static let darwinName = "jp.jpng.passwd-sso.passkey-requirement-changed"

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
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(Self.darwinName as CFString), nil, nil, true)
  }

  /// Relay the cross-process Darwin notification to a local
  /// `didChangeInAnyProcess` post. Call once per process that listens (the
  /// host app's monitor). The C callback captures nothing.
  public static func observeOtherProcesses(observer: UnsafeRawPointer) {
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      observer,
      { _, _, _, _, _ in
        NotificationCenter.default.post(
          name: PasskeyRequirementStore.didChangeInAnyProcess, object: nil)
      },
      darwinName as CFString,
      nil,
      .deliverImmediately)
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
