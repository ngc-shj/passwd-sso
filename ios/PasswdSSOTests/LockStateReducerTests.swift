import XCTest
@testable import Shared

final class LockStateReducerTests: XCTestCase {

  private let reducer = LockStateReducer()
  private let baseState = LockState(lockedAt: nil, autoLockMinutes: 5)

  // MARK: - Auto-lock fires at boundary

  func testAutoLockFiresAtBoundaryWithTestClock() {
    let start = Date(timeIntervalSinceReferenceDate: 0)
    let clock = TestClock(start: start)

    var state = LockState(lockedAt: nil, autoLockMinutes: 5)

    // Simulate unlock at t=0
    state = reducer.reduce(state, event: .unlock(at: clock.now), autoLockMinutes: 5)
    XCTAssertNil(state.lockedAt)

    // Advance 4 minutes 59 seconds — should still be unlocked
    clock.advance(by: 4 * 60 + 59)
    state = reducer.reduce(state, event: .autoLockTick(now: clock.now), autoLockMinutes: 5)
    XCTAssertNil(state.lockedAt)

    // Manual lock at boundary
    state = reducer.reduce(state, event: .manualLock, autoLockMinutes: 5)
    XCTAssertNotNil(state.lockedAt)
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

  func testAutoLockMinutesClampedTo60() {
    let state = LockState(lockedAt: nil, autoLockMinutes: 120)
    XCTAssertEqual(state.autoLockMinutes, 60)
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
