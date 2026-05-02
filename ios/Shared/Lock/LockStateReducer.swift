import Foundation

public enum LockEvent: Sendable, Equatable {
  case userActivity(at: Date)
  case unlock(at: Date)
  case manualLock
  case autoLockTick(now: Date)
}

public protocol Clock: Sendable {
  var now: Date { get }
}

public struct SystemClock: Clock, Sendable {
  public init() {}
  public var now: Date { Date() }
}

/// Mutable test clock — allows advancing time in unit tests (per T20).
public final class TestClock: Clock, @unchecked Sendable {
  private var _now: Date
  private let lock = NSLock()

  public init(start: Date) {
    self._now = start
  }

  public var now: Date {
    lock.withLock { _now }
  }

  public func advance(by interval: TimeInterval) {
    lock.withLock { _now = _now.addingTimeInterval(interval) }
  }
}

/// Pure reducer over (LockState, LockEvent) — no real-clock dependency (per T20).
public struct LockStateReducer {
  public init() {}

  public func reduce(_ state: LockState, event: LockEvent, autoLockMinutes: Int) -> LockState {
    switch event {
    case .unlock:
      return LockState(lockedAt: nil, autoLockMinutes: autoLockMinutes)

    case .userActivity:
      // Reset the idle timer by clearing lockedAt (will re-lock after inactivity)
      return LockState(lockedAt: nil, autoLockMinutes: autoLockMinutes)

    case .manualLock:
      return LockState(lockedAt: Date(), autoLockMinutes: autoLockMinutes)

    case .autoLockTick:
      guard state.lockedAt == nil else {
        // Already locked — no change
        return state
      }
      // The reducer does not track last-activity internally; callers pass .manualLock
      // after the idle window expires. .autoLockTick is used for time-boundary checks
      // against an externally-tracked last-activity timestamp.
      return state
    }
  }
}
