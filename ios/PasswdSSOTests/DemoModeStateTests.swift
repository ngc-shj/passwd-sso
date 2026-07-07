import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

/// Tests for Demo Mode state machine (C2) and presentation flags (C3).
///
/// Structural isolation proof: the grep gate below verifies that the Forbidden
/// patterns from the plan do NOT appear in DemoVaultFactory.swift or
/// DemoVaultView.swift. Each test has a documented prove-red step (RT7) in its
/// comment.
@MainActor
final class DemoModeStateTests: XCTestCase {

  // MARK: - C3: DemoVaultPresentation flags

  /// Prove-red (RT7): flip showsMutationAffordances default to true → test fails.
  func testDemoPresentationFlags_allFalse() {
    let p = DemoVaultPresentation()
    XCTAssertFalse(p.showsMutationAffordances, "Demo must never show mutation affordances")
    XCTAssertFalse(p.showsSyncControls, "Demo must never show sync controls")
    XCTAssertFalse(p.showsFavicons, "Demo must never fetch/show favicons")
  }

  func testDemoPresentation_exitLabel() {
    let p = DemoVaultPresentation()
    XCTAssertEqual(p.exitLabel, "Exit Demo")
  }

  // MARK: - C2: AppState.demo pattern-match

  /// Verifies .demo is a valid AppState case and carries DemoVault.
  func testAppStateDemo_patternMatchable() throws {
    let demo = try DemoVaultFactory.makeDemoVault()
    let state = AppState.demo(demo)
    if case .demo(let d) = state {
      XCTAssertFalse(d.userId.isEmpty)
      XCTAssertEqual(d.cacheData.header.entryCount, 9)
    } else {
      XCTFail("AppState.demo did not pattern-match")
    }
  }

  /// State machine: .setup → .demo → .setup is representable (structural).
  func testAppStateTransition_setupToDemoToSetup() throws {
    let demo = try DemoVaultFactory.makeDemoVault()
    var state = AppState.setup
    state = .demo(demo)
    guard case .demo = state else { XCTFail("Expected .demo"); return }
    state = .setup
    guard case .setup = state else { XCTFail("Expected .setup after exit"); return }
  }

  // MARK: - Grep gate: forbidden patterns in DemoVaultFactory.swift

  /// Prove-red (RT7): temporarily add `BridgeKeyStore` to DemoVaultFactory.swift → test fails.
  // Uses #filePath (absolute) not #file: under Swift 6 language mode #file is the
  // concise <module>/<basename> form, which would make the URL relative and the
  // read fail — silently greenwashing the gate. A non-swallowing `try` makes an
  // unreadable file fail the test loudly. Mirrors LocalizationCatalogTests.
  func testForbiddenPatternsAbsent_inDemoVaultFactory() throws {
    let fileURL = URL(filePath: #filePath)
      .deletingLastPathComponent()   // PasswdSSOTests/
      .deletingLastPathComponent()   // ios/
      .appendingPathComponent("Shared/Demo/DemoVaultFactory.swift")

    let source = try String(contentsOf: fileURL, encoding: .utf8)
    let forbidden = [
      "BridgeKeyStore", "AppGroupWrappedKeyStore", "saveVaultKey",
      "cacheFileURL", "writeCacheFile", "HostTokenStore", "FaviconLoader",
    ]
    for pattern in forbidden {
      XCTAssertFalse(
        source.contains(pattern),
        "DemoVaultFactory.swift must not reference '\(pattern)' (isolation contract)"
      )
    }
  }

  // MARK: - Demo settings isolation (behavioral, complements the grep gate)

  /// The grep gate forbids the `AppSettingsStore` token in DemoVaultView.swift,
  /// but `VaultViewModel()`'s default arg would bind the real App Group suite
  /// transitively. `makeEphemeral()` is the isolation seam; this test proves it
  /// neither reads nor writes the shared persisted sort preference.
  ///
  /// Prove-red (RT7): change `makeEphemeral()` to `VaultViewModel()` → this fails
  /// (the ephemeral VM would then reflect and pollute the shared suite).
  func testDemoViewModelDoesNotTouchSharedSortPreference() {
    let shared = AppSettingsStore()
    let original = shared.entrySortOption
    defer { shared.entrySortOption = original }

    // A value the ephemeral VM must NOT observe.
    shared.entrySortOption = .website

    let demoVM = VaultViewModel.makeEphemeral()
    // Ephemeral VM starts at the fail-closed default, not the shared .website.
    XCTAssertEqual(demoVM.sortOption, .title)

    // Mutating the demo VM must not leak into the shared suite.
    demoVM.sortOption = .createdAt
    XCTAssertEqual(shared.entrySortOption, .website)
  }

  /// Prove-red (RT7): temporarily add `MobileAPIClient` to DemoVaultView.swift → test fails.
  // See the #filePath rationale on testForbiddenPatternsAbsent_inDemoVaultFactory.
  func testForbiddenPatternsAbsent_inDemoVaultView() throws {
    let fileURL = URL(filePath: #filePath)
      .deletingLastPathComponent()   // PasswdSSOTests/
      .deletingLastPathComponent()   // ios/
      .appendingPathComponent("PasswdSSOApp/Views/Vault/DemoVaultView.swift")

    let source = try String(contentsOf: fileURL, encoding: .utf8)
    let forbidden = [
      "MobileAPIClient", "HostSyncService", "runSync", "FaviconLoader",
      "CredentialIdentityRegistrar", "refreshCredentialIdentities",
      "onVaultReady", "AppSettingsStore",
    ]
    for pattern in forbidden {
      XCTAssertFalse(
        source.contains(pattern),
        "DemoVaultView.swift must not reference '\(pattern)' (isolation contract)"
      )
    }
  }
}
