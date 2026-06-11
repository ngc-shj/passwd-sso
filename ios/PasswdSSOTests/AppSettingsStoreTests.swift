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

  func testMinutesRawStoredZeroClampsToMin() {
    // A present (not absent) raw 0 must clamp to the [5,60] floor, NOT fall
    // through to the absent-default 15 — proves stored-0 ≠ absent.
    defaults.set(0, forKey: "autoLockMinutes")
    XCTAssertEqual(AppSettingsStore(defaults: defaults).minutes, 5)
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

  func testTimeoutActionInvalidRawValueReturnsLock() {
    defaults.set("garbage", forKey: "vaultTimeoutAction")
    XCTAssertEqual(AppSettingsStore(defaults: defaults).vaultTimeoutAction, .lock)
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

  func testClipboardAcceptsBoundaryOptions() {
    let store = AppSettingsStore(defaults: defaults)
    store.clipboardClearSeconds = 10
    XCTAssertEqual(store.clipboardClearSeconds, 10)
    store.clipboardClearSeconds = 300
    XCTAssertEqual(store.clipboardClearSeconds, 300)
  }

  func testClipboardJustOutsideOptionsReturnsThirty() {
    let store = AppSettingsStore(defaults: defaults)
    store.clipboardClearSeconds = 9
    XCTAssertEqual(store.clipboardClearSeconds, 30)
    store.clipboardClearSeconds = 301
    XCTAssertEqual(store.clipboardClearSeconds, 30)
  }

  // MARK: - Tenant auto-lock policy

  func testTenantAbsentReturnsNil() {
    XCTAssertNil(AppSettingsStore(defaults: defaults).tenantAutoLockMinutes)
  }

  func testTenantRoundTrip() {
    let store = AppSettingsStore(defaults: defaults)
    store.tenantAutoLockMinutes = 120
    XCTAssertEqual(store.tenantAutoLockMinutes, 120)
  }

  func testTenantBelowMinReturnsNil() {
    let store = AppSettingsStore(defaults: defaults)
    store.tenantAutoLockMinutes = 4  // < 5 → fail-closed to nil
    XCTAssertNil(store.tenantAutoLockMinutes)
  }

  func testTenantAboveMaxReturnsNil() {
    let store = AppSettingsStore(defaults: defaults)
    store.tenantAutoLockMinutes = 2000  // > 1440 → fail-closed to nil
    XCTAssertNil(store.tenantAutoLockMinutes)
  }

  func testTenantZeroReturnsNil() {
    defaults.set(0, forKey: "tenantAutoLockMinutes")
    XCTAssertNil(AppSettingsStore(defaults: defaults).tenantAutoLockMinutes)
  }

  func testEffectiveUsesTenantWhenPresent() {
    let store = AppSettingsStore(defaults: defaults)
    store.minutes = 30
    store.tenantAutoLockMinutes = 120
    XCTAssertEqual(store.effectiveAutoLockMinutes, 120)
  }

  func testEffectiveUsesMinutesWhenNoTenant() {
    let store = AppSettingsStore(defaults: defaults)
    store.minutes = 30
    XCTAssertEqual(store.effectiveAutoLockMinutes, 30)
  }

  func testApplyTenantPolicyAuthoritativeWritesValue() {
    let store = AppSettingsStore(defaults: defaults)
    store.applyTenantPolicy(120, policyAuthoritative: true)
    XCTAssertEqual(store.tenantAutoLockMinutes, 120)
  }

  func testApplyTenantPolicyAuthoritativeNilClears() {
    let store = AppSettingsStore(defaults: defaults)
    store.tenantAutoLockMinutes = 120
    store.applyTenantPolicy(nil, policyAuthoritative: true)  // server removed policy
    XCTAssertNil(store.tenantAutoLockMinutes)
  }

  func testApplyTenantPolicyNonAuthoritativeNilRetainsPersisted() {
    let store = AppSettingsStore(defaults: defaults)
    store.tenantAutoLockMinutes = 120
    store.applyTenantPolicy(nil, policyAuthoritative: false)  // biometric/offline path
    XCTAssertEqual(store.tenantAutoLockMinutes, 120)
  }

  func testApplyTenantPolicyNonAuthoritativeIgnoresValue() {
    let store = AppSettingsStore(defaults: defaults)
    store.applyTenantPolicy(99, policyAuthoritative: false)  // no-op regardless of value
    XCTAssertNil(store.tenantAutoLockMinutes)
  }

  func testClearTenantPolicyRemovesKey() {
    let store = AppSettingsStore(defaults: defaults)
    store.tenantAutoLockMinutes = 120
    store.clearTenantPolicy()
    XCTAssertNil(store.tenantAutoLockMinutes)
  }

  func testTenantDoesNotMutateUserMinutes() {
    let store = AppSettingsStore(defaults: defaults)
    store.minutes = 30
    store.applyTenantPolicy(120, policyAuthoritative: true)
    XCTAssertEqual(store.minutes, 30)  // user setting untouched
    XCTAssertEqual(store.effectiveAutoLockMinutes, 120)
    store.clearTenantPolicy()
    XCTAssertEqual(store.effectiveAutoLockMinutes, 30)  // restored after policy removed
  }
}
