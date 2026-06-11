import Foundation

/// Shared auto-lock bounds. The user-facing picker offers only [5,15,30,60],
/// but a tenant policy may enforce up to 24h, so the APPLIED interval clamps to
/// `[floorMinutes, maxMinutes]` — mirrors the server's VAULT_AUTO_LOCK_MIN/MAX.
public enum AutoLockLimits {
  /// Tenant-policy floor (server VAULT_AUTO_LOCK_MIN).
  public static let tenantMinMinutes = 5
  /// Applied ceiling for any interval, incl. a tenant override (server VAULT_AUTO_LOCK_MAX = 24h).
  public static let maxMinutes = 1440
  /// Absolute floor for the applied interval.
  public static let floorMinutes = 1
}

/// Auto-lock configuration and timestamp.
/// autoLockMinutes is clamped to [1, 1440]; default is 5.
public struct LockState: Sendable, Equatable {
  public let lockedAt: Date?
  public let autoLockMinutes: Int

  public init(lockedAt: Date? = nil, autoLockMinutes: Int = 5) {
    self.lockedAt = lockedAt
    self.autoLockMinutes = max(AutoLockLimits.floorMinutes, min(AutoLockLimits.maxMinutes, autoLockMinutes))
  }
}
