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
  }

  private let defaults: UserDefaults

  public init(defaults: UserDefaults = .appGroup) {
    self.defaults = defaults
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
}
