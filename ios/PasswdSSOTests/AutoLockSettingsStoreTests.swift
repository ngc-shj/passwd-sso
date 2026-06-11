import Foundation
import XCTest

@testable import PasswdSSOApp

/// Tests for AutoLockSettingsStore persistence: default-when-absent, [5,60]
/// clamping, round-trip, and cross-instance persistence. Each test uses a
/// unique UserDefaults suite, removed in tearDown.
final class AutoLockSettingsStoreTests: XCTestCase {
  private var suiteName: String!
  private var defaults: UserDefaults!

  override func setUp() {
    super.setUp()
    suiteName = "test.autolock.\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suiteName)
  }

  override func tearDown() {
    defaults.removePersistentDomain(forName: suiteName)
    defaults = nil
    suiteName = nil
    super.tearDown()
  }

  func testAbsentKeyReturnsFifteen() {
    let store = AutoLockSettingsStore(defaults: defaults)
    XCTAssertEqual(store.minutes, 15)
  }

  func testRoundTrip() {
    let store = AutoLockSettingsStore(defaults: defaults)
    store.minutes = 30
    XCTAssertEqual(store.minutes, 30)
  }

  func testClampsAboveMax() {
    let store = AutoLockSettingsStore(defaults: defaults)
    store.minutes = 100
    XCTAssertEqual(store.minutes, 60)
  }

  func testClampsBelowMin() {
    let store = AutoLockSettingsStore(defaults: defaults)
    store.minutes = 1
    XCTAssertEqual(store.minutes, 5)
  }

  func testPersistsAcrossInstances() {
    AutoLockSettingsStore(defaults: defaults).minutes = 30
    // A second instance over the same suite reads the persisted value.
    XCTAssertEqual(AutoLockSettingsStore(defaults: defaults).minutes, 30)
  }
}
