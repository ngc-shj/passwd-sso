import Foundation

/// Auto-lock configuration and timestamp.
/// autoLockMinutes is clamped to [1, 60]; default is 5.
public struct LockState: Sendable, Equatable {
  public let lockedAt: Date?
  public let autoLockMinutes: Int

  public init(lockedAt: Date? = nil, autoLockMinutes: Int = 5) {
    self.lockedAt = lockedAt
    self.autoLockMinutes = max(1, min(60, autoLockMinutes))
  }
}
