import Foundation
import XCTest
import Shared

@testable import PasswdSSOApp

/// Tests for AppSettingsStore persistence: defaults-when-absent, clamping/
/// validation, and round-trip for auto-lock minutes, vault timeout action,
/// clipboard auto-clear, auto-copy TOTP, tenant policy, and app language. Each
/// test uses a unique UserDefaults suite.
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
    // Reset the process-global LanguageBundle override unconditionally — any
    // language test mutates it, and a leaked override would make sibling tests'
    // L10n.string(…) / Bundle.localizedString(…) lookups locale-dependent.
    LanguageBundle.setLanguage(nil)
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

  func testAppLanguageAbsentReturnsSystem() {
    XCTAssertEqual(AppSettingsStore(defaults: defaults).appLanguage, .system)
  }

  func testAppLanguageInvalidRawValueReturnsSystem() {
    defaults.set("de", forKey: "appLanguage")
    XCTAssertEqual(AppSettingsStore(defaults: defaults).appLanguage, .system)
    defaults.set("", forKey: "appLanguage")
    XCTAssertEqual(AppSettingsStore(defaults: defaults).appLanguage, .system)
  }

  func testAppLanguageRoundTrip() {
    let store = AppSettingsStore(defaults: defaults)
    store.appLanguage = .ja
    XCTAssertEqual(store.appLanguage, .ja)
    store.appLanguage = .en
    XCTAssertEqual(store.appLanguage, .en)
    store.appLanguage = .system
    XCTAssertEqual(store.appLanguage, .system)
  }

  func testAppLanguagePersistsAcrossInstances() {
    AppSettingsStore(defaults: defaults).appLanguage = .ja
    XCTAssertEqual(AppSettingsStore(defaults: defaults).appLanguage, .ja)
  }

  /// Host writes the preference; the AutoFill extension reads it from a separate
  /// store over the same App-Group suite (the shared hand-off the extension relies
  /// on to apply the language).
  func testAppLanguageReadsAcrossSeparateStoresOnSameSuite() {
    let appSide = AppSettingsStore(defaults: defaults)
    let extensionSide = AppSettingsStore(defaults: UserDefaults(suiteName: suiteName)!)
    appSide.appLanguage = .ja
    XCTAssertEqual(extensionSide.appLanguage, .ja)
  }

  func testAppLanguageAllCasesOrdering() {
    XCTAssertEqual(AppLanguage.allCases, [.system, .ja, .en])
    for language in AppLanguage.allCases {
      XCTAssertEqual(AppLanguage(rawValue: language.rawValue), language)
    }
  }

  func testAppLanguageLocaleOverride() {
    // Assert the stable identifier, NOT Locale value-equality (ICU
    // canonicalization can differ across OS images).
    XCTAssertEqual(AppLanguage.ja.localeOverride?.identifier, "ja")
    XCTAssertEqual(AppLanguage.en.localeOverride?.identifier, "en")
    XCTAssertNil(AppLanguage.system.localeOverride)
  }

  /// Pins the picker labels (C5/F1): endonyms render literally, and `.system`
  /// REUSES the existing "System" key (same value the theme picker shows) rather
  /// than introducing a duplicate. Guards against a regression that swaps an
  /// endonym or routes `.system` through a different/untranslated key.
  func testAppLanguageLabels() {
    XCTAssertEqual(AppLanguage.ja.label, "日本語")
    XCTAssertEqual(AppLanguage.en.label, "English")
    // `.system` reuses the existing "System" key (the C5/F1 contract: no duplicate
    // key). Compare against the SAME resolution path the label uses (`L10n.string`,
    // bundle-aware) rather than bare `String(localized:)`, so the assertion stays
    // self-consistent under any active override; the distinctness checks below
    // catch a regression that accidentally routes `.system` to an endonym key.
    XCTAssertEqual(AppLanguage.system.label, L10n.string("System"))
    XCTAssertNotEqual(AppLanguage.system.label, AppLanguage.ja.label)
    XCTAssertNotEqual(AppLanguage.system.label, AppLanguage.en.label)
  }

  /// Core of the fix: applying a language re-points the `Text("…")` /
  /// NSLocalizedString path (`Bundle.main.localizedString`) immediately and in
  /// BOTH directions — the on-device `AppleLanguages` approach only worked
  /// en→system, not en→ja. `tearDown()` resets the global override.
  @MainActor
  func testApplyAppLanguageRePointsTextLookupBothDirections() {
    let store = AppSettingsStore(defaults: defaults)
    func lookup() -> String {
      Bundle.main.localizedString(forKey: "Language", value: nil, table: nil)
    }

    store.appLanguage = .ja
    store.applyAppLanguage()
    XCTAssertEqual(lookup(), "言語")

    // The previously-failing direction: switch straight to English and back to ja.
    store.appLanguage = .en
    store.applyAppLanguage()
    XCTAssertEqual(lookup(), "Language")

    store.appLanguage = .ja
    store.applyAppLanguage()
    XCTAssertEqual(lookup(), "言語")  // en → ja now works
  }

  /// The imperative `String(localized:)` call sites were swept to `L10n.string`,
  /// which resolves via a DIFFERENT path than the swizzle (`String(localized:
  /// bundle: LanguageBundle.current)`). This proves THAT path also follows a
  /// language switch in both directions — the swizzle test above does not cover it.
  @MainActor
  func testApplyAppLanguageRePointsL10nStringBothDirections() {
    let store = AppSettingsStore(defaults: defaults)

    store.appLanguage = .ja
    store.applyAppLanguage()
    XCTAssertEqual(L10n.string("Language"), "言語")

    store.appLanguage = .en
    store.applyAppLanguage()
    XCTAssertEqual(L10n.string("Language"), "Language")

    store.appLanguage = .ja
    store.applyAppLanguage()
    XCTAssertEqual(L10n.string("Language"), "言語")  // en → ja
  }

  @MainActor
  func testLanguageRefreshBumpIncrementsToken() {
    let before = LanguageRefresh.shared.token
    LanguageRefresh.shared.bump()
    XCTAssertEqual(LanguageRefresh.shared.token, before + 1)
  }
}
