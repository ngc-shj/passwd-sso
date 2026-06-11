import Foundation
import XCTest

@testable import PasswdSSOApp

/// Tests for AppSettingsStore persistence: defaults-when-absent, clamping/
/// validation, and round-trip for auto-lock minutes, vault timeout action, and
/// clipboard auto-clear. Each test uses a unique UserDefaults suite.
final class AppSettingsStoreTests: XCTestCase {
  private var suiteName: String!
  private var defaults: UserDefaults!

  override func setUp() {
    super.setUp()
    suiteName = "test.appsettings.\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suiteName)
  }

  override func tearDown() {
    defaults.removePersistentDomain(forName: suiteName)
    defaults = nil
    suiteName = nil
    super.tearDown()
  }

  // MARK: - Auto-lock minutes

  func testMinutesAbsentReturnsFifteen() {
    XCTAssertEqual(AppSettingsStore(defaults: defaults).minutes, 15)
  }

  func testMinutesRoundTrip() {
    let store = AppSettingsStore(defaults: defaults)
    store.minutes = 30
    XCTAssertEqual(store.minutes, 30)
  }

  func testMinutesClampsAboveMax() {
    let store = AppSettingsStore(defaults: defaults)
    store.minutes = 100
    XCTAssertEqual(store.minutes, 60)
  }

  func testMinutesClampsBelowMin() {
    let store = AppSettingsStore(defaults: defaults)
    store.minutes = 1
    XCTAssertEqual(store.minutes, 5)
  }

  func testMinutesPersistsAcrossInstances() {
    AppSettingsStore(defaults: defaults).minutes = 30
    XCTAssertEqual(AppSettingsStore(defaults: defaults).minutes, 30)
  }

  // MARK: - Vault timeout action

  func testTimeoutActionAbsentReturnsLock() {
    XCTAssertEqual(AppSettingsStore(defaults: defaults).vaultTimeoutAction, .lock)
  }

  func testTimeoutActionRoundTrip() {
    let store = AppSettingsStore(defaults: defaults)
    store.vaultTimeoutAction = .logout
    XCTAssertEqual(store.vaultTimeoutAction, .logout)
  }

  // MARK: - Clipboard auto-clear

  func testClipboardAbsentReturnsThirty() {
    XCTAssertEqual(AppSettingsStore(defaults: defaults).clipboardClearSeconds, 30)
  }

  func testClipboardRoundTrip() {
    let store = AppSettingsStore(defaults: defaults)
    store.clipboardClearSeconds = 60
    XCTAssertEqual(store.clipboardClearSeconds, 60)
  }

  func testClipboardInvalidValueReturnsThirty() {
    let store = AppSettingsStore(defaults: defaults)
    store.clipboardClearSeconds = 999  // not in the fixed option set
    XCTAssertEqual(store.clipboardClearSeconds, 30)
  }
}
