import XCTest
@testable import Shared

final class LockStateReducerTests: XCTestCase {

  private let reducer = LockStateReducer()

  // MARK: - autoLockTick is a no-op in the reducer

  /// The reducer does not track last-activity internally — `.autoLockTick` must
  /// pass the state through verbatim. The actual time-boundary locking is
  /// driven by AutoLockService.tick() (covered in AutoLockServiceTests).
  func testAutoLockTickIsNoOpInReducer_lockingDrivenByAutoLockService() {
    let start = Date(timeIntervalSinceReferenceDate: 0)
    let clock = TestClock(start: start)

    var state = LockState(lockedAt: nil, autoLockMinutes: 5)
    state = reducer.reduce(state, event: .unlock(at: clock.now), autoLockMinutes: 5)

    // Tick far past the 5-minute boundary — the reducer must NOT lock.
    clock.advance(by: 60 * 60)
    let ticked = reducer.reduce(state, event: .autoLockTick(now: clock.now), autoLockMinutes: 5)

    XCTAssertEqual(ticked, state, ".autoLockTick must return the state unchanged")
  }

  // MARK: - User activity resets idle timer

  func testUserActivityResetsIdleTimer() {
    var state = LockState(lockedAt: nil, autoLockMinutes: 5)

    // Simulate some activity
    let activityTime = Date(timeIntervalSinceReferenceDate: 100)
    state = reducer.reduce(state, event: .userActivity(at: activityTime), autoLockMinutes: 5)

    XCTAssertNil(state.lockedAt, "After user activity, vault should remain unlocked")
  }

  // MARK: - Manual lock is immediate

  func testManualLockIsImmediate() {
    var state = LockState(lockedAt: nil, autoLockMinutes: 5)

    state = reducer.reduce(state, event: .manualLock, autoLockMinutes: 5)

    XCTAssertNotNil(state.lockedAt, "Manual lock should immediately set lockedAt")
  }

  // MARK: - Unlock clears lockedAt

  func testUnlockClearsLockedAt() {
    var state = LockState(lockedAt: Date(), autoLockMinutes: 5)

    state = reducer.reduce(state, event: .unlock(at: Date()), autoLockMinutes: 5)

    XCTAssertNil(state.lockedAt)
  }

  // MARK: - autoLockMinutes clamping

  func testAutoLockMinutesClampedTo1() {
    let state = LockState(lockedAt: nil, autoLockMinutes: 0)
    XCTAssertEqual(state.autoLockMinutes, 1)
  }

  func testAutoLockMinutesNotTruncatedTo60() {
    // A tenant policy may enforce > 60 (up to 24h); LockState must not truncate.
    let state = LockState(lockedAt: nil, autoLockMinutes: 120)
    XCTAssertEqual(state.autoLockMinutes, 120)
  }

  func testAutoLockMinutesClampedToMax() {
    let state = LockState(lockedAt: nil, autoLockMinutes: 2000)
    XCTAssertEqual(state.autoLockMinutes, 1440)
  }

  // MARK: - TestClock advances correctly

  func testTestClockAdvances() {
    let start = Date(timeIntervalSinceReferenceDate: 1000)
    let clock = TestClock(start: start)

    XCTAssertEqual(clock.now.timeIntervalSinceReferenceDate, 1000, accuracy: 0.001)

    clock.advance(by: 300)
    XCTAssertEqual(clock.now.timeIntervalSinceReferenceDate, 1300, accuracy: 0.001)
  }
}
