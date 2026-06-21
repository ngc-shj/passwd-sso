import Foundation

/// What happens when the idle vault timeout fires (mirrors the extension's
/// `vaultTimeoutAction`).
public enum VaultTimeoutAction: String, CaseIterable {
  case lock    // drop keys, keep tokens/cache — re-unlock with passphrase
  case logout  // full sign-out — clear tokens, cache, wrapped keys
}

/// App UI theme override (mirrors the extension's `theme`).
public enum AppTheme: String, CaseIterable {
  case system
  case light
  case dark
}

/// User-selected display language. `system` follows the device language;
/// `ja`/`en` force a specific localization. rawValues `"ja"`/`"en"` match the
/// catalog localization codes (and `AppleLanguages` array elements).
public enum AppLanguage: String, CaseIterable {
  case system
  case ja
  case en

  /// The BCP-47 code this choice resolves to. `.system` resolves to the bundle's
  /// current localization (the device language) — read from
  /// `Bundle.main.preferredLocalizations`, NOT `Locale.current`, so it reflects
  /// the localizations the app actually ships. Used to decide whether a host
  /// language change needs a restart (it differs from the launch-time code).
  public var effectiveCode: String {
    switch self {
    case .ja: "ja"
    case .en: "en"
    case .system: Bundle.main.preferredLocalizations.first ?? "en"
    }
  }

  /// A forced locale for `.environment(\.locale,)` injection (AutoFill extension,
  /// which renders all strings via `Text(LocalizedStringKey)`). `nil` for
  /// `.system` means "do not override" — the view inherits the device locale.
  /// Constructed from the closed enum, never `Locale.current`.
  public var localeOverride: Locale? {
    switch self {
    case .ja: Locale(identifier: "ja")
    case .en: Locale(identifier: "en")
    case .system: nil
    }
  }
}

extension UserDefaults {
  /// Shared App Group suite used for all persisted app settings.
  /// UserDefaults is thread-safe but not `Sendable`; the unsafe annotation
  /// vouches for that across the concurrency checker.
  nonisolated(unsafe) public static let appGroup =
    UserDefaults(suiteName: AppGroupContainer.identifier) ?? .standard
}

/// Persists app settings in the App Group suite. Mirrors the browser
/// extension's settings (auto-lock minutes, vault timeout action, clipboard
/// auto-clear). Theme is handled separately via `@AppStorage("appTheme")` so it
/// applies app-wide reactively.
///
/// Lives in `Shared` so the AutoFill extension (which cannot link the host app)
/// can read the same settings — see `autoCopyTotp` / `clipboardClearSeconds`.
///
/// All getters fail-closed: missing/garbage values return secure defaults.
public struct AppSettingsStore {
  public static let defaultMinutes = 15
  public static let minMinutes = 5
  public static let maxMinutes = 60
  public static let clipboardOptions = [10, 20, 30, 60, 120, 300]
  public static let defaultClipboardSeconds = 30

  private enum Key {
    static let autoLockMinutes = "autoLockMinutes"
    static let vaultTimeoutAction = "vaultTimeoutAction"
    static let clipboardClearSeconds = "clipboardClearSeconds"
    static let tenantAutoLockMinutes = "tenantAutoLockMinutes"
    static let autoCopyTotp = "autoCopyTotp"
    static let appLanguage = "appLanguage"
    /// The OS-owned key honored ONLY in the standard domain. Never written to
    /// the App Group suite (the bundle-localization machinery ignores it there).
    static let appleLanguages = "AppleLanguages"
  }

  private let defaults: UserDefaults
  private let systemDefaults: UserDefaults

  /// - Parameters:
  ///   - defaults: App Group suite holding all persisted settings.
  ///   - systemDefaults: the standard domain, where `AppleLanguages` must be
  ///     written for the OS to honor a language override on next launch. Injected
  ///     so tests can use a throwaway suite instead of polluting the real
  ///     `.standard` domain.
  public init(defaults: UserDefaults = .appGroup, systemDefaults: UserDefaults = .standard) {
    self.defaults = defaults
    self.systemDefaults = systemDefaults
  }

  /// Auto-lock idle timeout in minutes. Range [5, 60]; absent → 15. There is
  /// intentionally no "never" (a permanently-unlocked local vault would outlive
  /// the session).
  public var minutes: Int {
    get {
      guard defaults.object(forKey: Key.autoLockMinutes) != nil else { return Self.defaultMinutes }
      return max(Self.minMinutes, min(Self.maxMinutes, defaults.integer(forKey: Key.autoLockMinutes)))
    }
    nonmutating set {
      defaults.set(max(Self.minMinutes, min(Self.maxMinutes, newValue)), forKey: Key.autoLockMinutes)
    }
  }

  /// Action taken when the idle timeout fires. Absent/garbage → `.lock`.
  public var vaultTimeoutAction: VaultTimeoutAction {
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

  /// Tenant-enforced auto-lock interval (minutes), from the server policy
  /// (`/api/vault/unlock/data` → `vaultAutoLockMinutes`). When present it
  /// OVERRIDES the user's `minutes` (it is not a cap). Fail-closed: a stored
  /// value outside `[tenantMinMinutes, maxMinutes]`, or absent, → `nil` (no
  /// override → the user setting applies). It is a non-secret policy integer, so
  /// App Group UserDefaults (not Keychain) is the right store; client-side
  /// auto-lock is defense-in-depth, the enforced boundary is the server-side
  /// token idle timeout.
  public var tenantAutoLockMinutes: Int? {
    get {
      guard defaults.object(forKey: Key.tenantAutoLockMinutes) != nil else { return nil }
      let raw = defaults.integer(forKey: Key.tenantAutoLockMinutes)
      return (raw >= AutoLockLimits.tenantMinMinutes && raw <= AutoLockLimits.maxMinutes) ? raw : nil
    }
    nonmutating set {
      if let value = newValue {
        defaults.set(value, forKey: Key.tenantAutoLockMinutes)
      } else {
        defaults.removeObject(forKey: Key.tenantAutoLockMinutes)
      }
    }
  }

  /// The auto-lock interval actually applied: tenant override when present,
  /// else the user's setting. Single precedence point (the getter already
  /// guarantees `[tenantMin, max]`-or-nil, so no second clamp here).
  public var effectiveAutoLockMinutes: Int { tenantAutoLockMinutes ?? minutes }

  /// Apply a tenant policy received at unlock. `policyAuthoritative` is true only
  /// for the passphrase unlock (which freshly fetched the policy); the biometric
  /// offline path passes false so it never wipes a previously-persisted value.
  /// - authoritative + value → write; authoritative + nil → clear (server removed
  ///   the policy); non-authoritative → no-op (regardless of value).
  public nonmutating func applyTenantPolicy(_ value: Int?, policyAuthoritative: Bool) {
    guard policyAuthoritative else { return }
    tenantAutoLockMinutes = value
  }

  /// Remove the tenant policy (sign-out / logout). Mirrors the extension clearing
  /// `tenantAutoLockMinutes` on disconnect.
  public nonmutating func clearTenantPolicy() {
    tenantAutoLockMinutes = nil
  }

  /// Clipboard auto-clear delay in seconds, from the fixed option set. Absent or
  /// any value outside the options → 30.
  public var clipboardClearSeconds: Int {
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

  /// Whether to auto-copy an entry's current TOTP code to the clipboard after a
  /// successful login AutoFill (mirrors the extension's `autoCopyTotp`). Absent
  /// key → `false` (opt-in): on iOS the calling app foregrounds right after the
  /// fill and can read the system clipboard, so the secure default is off.
  public var autoCopyTotp: Bool {
    get { defaults.bool(forKey: Key.autoCopyTotp) }
    nonmutating set { defaults.set(newValue, forKey: Key.autoCopyTotp) }
  }

  /// User-selected display language. The picker reads/writes this App-Group key;
  /// the setter ALSO mutates the standard-domain `AppleLanguages` so the host app
  /// resolves the chosen localization on next launch (the host uses
  /// `String(localized:)`, which is not affected by the SwiftUI `\.locale`
  /// environment — hence restart-to-apply). The AutoFill extension reads only the
  /// App-Group value and applies it live via `.environment(\.locale,)`.
  ///
  /// Fail-closed: absent or unrecognized stored value → `.system`. We read the
  /// preference from THIS key (not by parsing `AppleLanguages`, which the OS may
  /// normalize to region-qualified forms like `ja-JP`).
  public var appLanguage: AppLanguage {
    get {
      guard let raw = defaults.string(forKey: Key.appLanguage),
        let language = AppLanguage(rawValue: raw)
      else { return .system }
      return language
    }
    nonmutating set {
      defaults.set(newValue.rawValue, forKey: Key.appLanguage)
      switch newValue {
      case .system:
        // Remove the override so the device language governs again. Writing
        // ["system"] would be an invalid localization and break the bundle.
        systemDefaults.removeObject(forKey: Key.appleLanguages)
      case .ja, .en:
        systemDefaults.set([newValue.rawValue], forKey: Key.appleLanguages)
      }
    }
  }
}
