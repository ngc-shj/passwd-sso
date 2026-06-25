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
  func testForbiddenPatternsAbsent_inDemoVaultFactory() throws {
    let fileURL = URL(fileURLWithPath: #file)
      .deletingLastPathComponent()   // PasswdSSOTests/
      .deletingLastPathComponent()   // ios/
      .appendingPathComponent("Shared/Demo/DemoVaultFactory.swift")

    guard let source = try? String(contentsOf: fileURL, encoding: .utf8) else {
      return
    }
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

  /// Prove-red (RT7): temporarily add `MobileAPIClient` to DemoVaultView.swift → test fails.
  func testForbiddenPatternsAbsent_inDemoVaultView() throws {
    let fileURL = URL(fileURLWithPath: #file)
      .deletingLastPathComponent()   // PasswdSSOTests/
      .deletingLastPathComponent()   // ios/
      .appendingPathComponent("PasswdSSOApp/Views/Vault/DemoVaultView.swift")

    guard let source = try? String(contentsOf: fileURL, encoding: .utf8) else {
      return
    }
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
