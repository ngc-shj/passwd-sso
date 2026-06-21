import Foundation
import XCTest
import Shared

@testable import PasswdSSOApp

/// Tests for AppSettingsStore persistence: defaults-when-absent, clamping/
/// validation, and round-trip for auto-lock minutes, vault timeout action, and
/// clipboard auto-clear. Each test uses a unique UserDefaults suite.
final class AppSettingsStoreTests: XCTestCase {
  private var suiteName: String!
  private var defaults: UserDefaults!
  /// A throwaway stand-in for `UserDefaults.standard`, used to test the
  /// `AppleLanguages` side effect of `appLanguage` WITHOUT writing into the test
  /// host process's real standard domain (which would pollute locale-sensitive
  /// tests like LocalizationCatalogTests).
  private var systemSuiteName: String!
  private var systemDefaults: UserDefaults!
  /// Baseline of the REAL standard domain's AppleLanguages, captured before each
  /// test, so a leak guard can confirm no test mutated it.
  private var realAppleLanguagesBaseline: [String]?

  override func setUp() {
    super.setUp()
    suiteName = "test.appsettings.\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suiteName)
    systemSuiteName = "test.appsettings.system.\(UUID().uuidString)"
    systemDefaults = UserDefaults(suiteName: systemSuiteName)
    realAppleLanguagesBaseline = UserDefaults.standard.stringArray(forKey: "AppleLanguages")
  }

  override func tearDown() {
    defaults.removePersistentDomain(forName: suiteName)
    systemDefaults.removePersistentDomain(forName: systemSuiteName)
    defaults = nil
    suiteName = nil
    systemDefaults = nil
    systemSuiteName = nil
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

  // MARK: - Auto-copy TOTP (default OFF / opt-in)

  func testAutoCopyTotpAbsentReturnsFalse() {
    XCTAssertFalse(AppSettingsStore(defaults: defaults).autoCopyTotp)
  }

  func testAutoCopyTotpRoundTrip() {
    let store = AppSettingsStore(defaults: defaults)
    store.autoCopyTotp = true
    XCTAssertTrue(store.autoCopyTotp)
    store.autoCopyTotp = false
    XCTAssertFalse(store.autoCopyTotp)
  }

  /// The host app and the AutoFill extension instantiate separate stores over the
  /// same App Group suite; what one writes the other must read.
  func testAutoCopyTotpReadsAcrossSeparateStoresOnSameSuite() {
    let appSide = AppSettingsStore(defaults: defaults)
    let extensionSide = AppSettingsStore(defaults: UserDefaults(suiteName: suiteName)!)
    appSide.autoCopyTotp = true
    XCTAssertTrue(extensionSide.autoCopyTotp)
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

  // MARK: - App language

  /// All language tests inject BOTH suites; the `systemDefaults` injection is what
  /// keeps the `AppleLanguages` write off the real `.standard` domain.
  private func languageStore() -> AppSettingsStore {
    AppSettingsStore(defaults: defaults, systemDefaults: systemDefaults)
  }

  func testAppLanguageAbsentReturnsSystem() {
    XCTAssertEqual(languageStore().appLanguage, .system)
  }

  func testAppLanguageInvalidRawValueReturnsSystem() {
    defaults.set("de", forKey: "appLanguage")
    XCTAssertEqual(languageStore().appLanguage, .system)
    defaults.set("", forKey: "appLanguage")
    XCTAssertEqual(languageStore().appLanguage, .system)
  }

  func testAppLanguageJaSetsAppleLanguages() {
    let store = languageStore()
    store.appLanguage = .ja
    XCTAssertEqual(store.appLanguage, .ja)
    XCTAssertEqual(systemDefaults.stringArray(forKey: "AppleLanguages"), ["ja"])
  }

  func testAppLanguageEnSetsAppleLanguages() {
    let store = languageStore()
    store.appLanguage = .en
    XCTAssertEqual(store.appLanguage, .en)
    XCTAssertEqual(systemDefaults.stringArray(forKey: "AppleLanguages"), ["en"])
  }

  /// Provable-red: write `.ja` FIRST so the override key exists, then assert
  /// `.system` removes it. On a fresh suite the key is already absent, so a no-op
  /// `.system` setter would pass spuriously without this precondition.
  ///
  /// Note: a suite-backed `UserDefaults` falls through to `NSGlobalDomain` for
  /// keys it does not itself hold, so after removal `object(forKey:)` returns the
  /// device's global `AppleLanguages` (e.g. ["ja-JP", "en-JP"]), NOT nil. We
  /// therefore assert the override was removed by confirming the value reverts to
  /// the suite's pre-write baseline (the global fall-through), not to our `["ja"]`.
  func testAppLanguageSystemRemovesAppleLanguages() {
    let store = languageStore()
    let baseline = systemDefaults.stringArray(forKey: "AppleLanguages")
    store.appLanguage = .ja
    XCTAssertEqual(systemDefaults.stringArray(forKey: "AppleLanguages"), ["ja"])  // precondition: override present
    store.appLanguage = .system
    XCTAssertEqual(store.appLanguage, .system)
    // Override gone: the suite no longer reports our forced ["ja"]; it reverts to
    // whatever the global domain provides (the baseline).
    XCTAssertNotEqual(systemDefaults.stringArray(forKey: "AppleLanguages"), ["ja"])
    XCTAssertEqual(systemDefaults.stringArray(forKey: "AppleLanguages"), baseline)
  }

  /// The setter must NOT touch the real `.standard` domain — only the injected
  /// `systemDefaults`. Compares the real domain against the setUp baseline.
  func testAppLanguageDoesNotMutateRealStandardDomain() {
    languageStore().appLanguage = .ja
    XCTAssertEqual(UserDefaults.standard.stringArray(forKey: "AppleLanguages"), realAppleLanguagesBaseline)
  }

  /// Host writes the preference; the AutoFill extension reads it from a separate
  /// store over the same App-Group suite (the cross-process hand-off C7 depends on).
  func testAppLanguageReadsAcrossSeparateStoresOnSameSuite() {
    let appSide = languageStore()
    let extensionSide = AppSettingsStore(
      defaults: UserDefaults(suiteName: suiteName)!,
      systemDefaults: UserDefaults(suiteName: systemSuiteName)!)
    appSide.appLanguage = .ja
    XCTAssertEqual(extensionSide.appLanguage, .ja)
  }

  func testAppLanguageAllCasesOrdering() {
    XCTAssertEqual(AppLanguage.allCases, [.system, .ja, .en])
    for language in AppLanguage.allCases {
      XCTAssertEqual(AppLanguage(rawValue: language.rawValue), language)
    }
  }

  func testAppLanguageEffectiveCode() {
    XCTAssertEqual(AppLanguage.ja.effectiveCode, "ja")
    XCTAssertEqual(AppLanguage.en.effectiveCode, "en")
    // `.system` resolves to the bundle's current localization (device language);
    // assert it is one of the shipped codes rather than pinning a specific one.
    XCTAssertTrue(["ja", "en"].contains(AppLanguage.system.effectiveCode))
  }

  func testAppLanguageLocaleOverride() {
    // Assert the stable identifier, NOT Locale value-equality (ICU
    // canonicalization can differ across OS images).
    XCTAssertEqual(AppLanguage.ja.localeOverride?.identifier, "ja")
    XCTAssertEqual(AppLanguage.en.localeOverride?.identifier, "en")
    XCTAssertNil(AppLanguage.system.localeOverride)
  }
}
