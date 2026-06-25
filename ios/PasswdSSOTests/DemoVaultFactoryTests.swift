import CryptoKit
import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

/// Tests for DemoVaultFactory (C1). Drives the real decrypt path via
/// VaultViewModel.loadFromCache / loadDetail — not a bare plaintext decoder —
/// to catch any AAD mismatch or blob-shape drift before ship.
///
/// Mirrors the DebugVaultLoaderTests idiom (no real App Group container,
/// no Keychain — pure in-memory ephemeral key).
@MainActor
final class DemoVaultFactoryTests: XCTestCase {

  // MARK: - Helpers

  private func makeDemoAndVM() throws -> (DemoVault, VaultViewModel) {
    let demo = try DemoVaultFactory.makeDemoVault()
    let vm = VaultViewModel()
    vm.loadFromCache(
      cacheData: demo.cacheData,
      vaultKey: demo.vaultKey,
      userId: demo.userId,
      cacheKey: nil,
      teamDirectory: []
    )
    return (demo, vm)
  }

  // MARK: - C1: real decrypt path yields 9 summaries

  func testMakeDemoVault_yields9SummariesViaRealDecryptPath() throws {
    let (demo, vm) = try makeDemoAndVM()
    XCTAssertEqual(demo.cacheData.header.entryCount, 9, "header.entryCount must be 9")
    XCTAssertEqual(vm.filteredSummaries.count, 9, "filteredSummaries must have 9 entries")
  }

  // MARK: - C1: header.userId matches

  func testDemoVault_headerUserIdMatchesDemoUserId() throws {
    let demo = try DemoVaultFactory.makeDemoVault()
    XCTAssertEqual(demo.cacheData.header.userId, demo.userId)
  }

  // MARK: - C1: each non-login type has a type-specific sub-struct

  func testCreditCard_decodesWithBrandField() throws {
    let (demo, vm) = try makeDemoAndVM()
    let summary = try XCTUnwrap(
      vm.filteredSummaries.first { $0.entryType == "CREDIT_CARD" },
      "No CREDIT_CARD summary"
    )
    let detail = try XCTUnwrap(
      vm.loadDetail(
        for: summary.id, cacheData: demo.cacheData,
        vaultKey: demo.vaultKey, userId: demo.userId),
      "CREDIT_CARD loadDetail returned nil"
    )
    XCTAssertNotNil(detail.creditCard, "creditCard sub-struct must be present")
    XCTAssertEqual(detail.creditCard?.brand, "Visa")
  }

  func testIdentity_decodesWithFullName() throws {
    let (demo, vm) = try makeDemoAndVM()
    let summary = try XCTUnwrap(
      vm.filteredSummaries.first { $0.entryType == "IDENTITY" },
      "No IDENTITY summary"
    )
    let detail = try XCTUnwrap(
      vm.loadDetail(
        for: summary.id, cacheData: demo.cacheData,
        vaultKey: demo.vaultKey, userId: demo.userId),
      "IDENTITY loadDetail returned nil"
    )
    XCTAssertNotNil(detail.identity)
    XCTAssertEqual(detail.identity?.fullName, "Alice Example")
  }

  func testBankAccount_decodesWithBankName() throws {
    let (demo, vm) = try makeDemoAndVM()
    let summary = try XCTUnwrap(
      vm.filteredSummaries.first { $0.entryType == "BANK_ACCOUNT" },
      "No BANK_ACCOUNT summary"
    )
    let detail = try XCTUnwrap(
      vm.loadDetail(
        for: summary.id, cacheData: demo.cacheData,
        vaultKey: demo.vaultKey, userId: demo.userId),
      "BANK_ACCOUNT loadDetail returned nil"
    )
    XCTAssertNotNil(detail.bankAccount)
    XCTAssertEqual(detail.bankAccount?.bankName, "Acme Bank")
  }

  func testSshKey_decodesWithPublicKeyAndNumericKeySize() throws {
    let (demo, vm) = try makeDemoAndVM()
    let summary = try XCTUnwrap(
      vm.filteredSummaries.first { $0.entryType == "SSH_KEY" },
      "No SSH_KEY summary"
    )
    let detail = try XCTUnwrap(
      vm.loadDetail(
        for: summary.id, cacheData: demo.cacheData,
        vaultKey: demo.vaultKey, userId: demo.userId),
      "SSH_KEY loadDetail returned nil"
    )
    XCTAssertNotNil(detail.sshKey)
    XCTAssertNotNil(detail.sshKey?.publicKey)
    // keySize is written as a JSON number; FlexibleString must decode it to "256"
    XCTAssertEqual(detail.sshKey?.keySize, "256", "keySize must decode JSON number 256 to String '256'")
  }

  func testSoftwareLicense_decodesWithLicenseKey() throws {
    let (demo, vm) = try makeDemoAndVM()
    let summary = try XCTUnwrap(
      vm.filteredSummaries.first { $0.entryType == "SOFTWARE_LICENSE" },
      "No SOFTWARE_LICENSE summary"
    )
    let detail = try XCTUnwrap(
      vm.loadDetail(
        for: summary.id, cacheData: demo.cacheData,
        vaultKey: demo.vaultKey, userId: demo.userId),
      "SOFTWARE_LICENSE loadDetail returned nil"
    )
    XCTAssertNotNil(detail.softwareLicense)
    XCTAssertEqual(detail.softwareLicense?.licenseKey, "EXAMPLE-1234-5678-9ABC")
  }

  func testPasskey_decodesWithRelyingPartyId() throws {
    let (demo, vm) = try makeDemoAndVM()
    let summary = try XCTUnwrap(
      vm.filteredSummaries.first { $0.entryType == "PASSKEY" },
      "No PASSKEY summary"
    )
    let detail = try XCTUnwrap(
      vm.loadDetail(
        for: summary.id, cacheData: demo.cacheData,
        vaultKey: demo.vaultKey, userId: demo.userId),
      "PASSKEY loadDetail returned nil"
    )
    XCTAssertNotNil(detail.passkey)
    XCTAssertEqual(detail.passkey?.relyingPartyId, "github.com")
  }

  func testSecureNote_decodesWithContent() throws {
    let (demo, vm) = try makeDemoAndVM()
    let summary = try XCTUnwrap(
      vm.filteredSummaries.first { $0.entryType == "SECURE_NOTE" },
      "No SECURE_NOTE summary"
    )
    let detail = try XCTUnwrap(
      vm.loadDetail(
        for: summary.id, cacheData: demo.cacheData,
        vaultKey: demo.vaultKey, userId: demo.userId),
      "SECURE_NOTE loadDetail returned nil"
    )
    XCTAssertNotNil(detail.secureNote)
    XCTAssertEqual(detail.secureNote?.content, "Sample secure note for demo.")
  }

  // MARK: - C1: TOTP login decodes correct secret (T7)

  func testTotpLogin_decodesSecret() throws {
    let (demo, vm) = try makeDemoAndVM()
    // The AWS Console entry carries the TOTP seed and isFavorite=true
    let summary = try XCTUnwrap(
      vm.filteredSummaries.first { $0.isFavorite && $0.entryType == "LOGIN" },
      "No favorite LOGIN (AWS Console) summary"
    )
    let detail = try XCTUnwrap(
      vm.loadDetail(
        for: summary.id, cacheData: demo.cacheData,
        vaultKey: demo.vaultKey, userId: demo.userId),
      "AWS login loadDetail returned nil"
    )
    XCTAssertEqual(detail.totpSecret, "JBSWY3DPEHPK3PXP")
  }

  // MARK: - NFR3: sample data uses only reserved/example domains

  func testSampleDataUsesReservedDomainsOnly() throws {
    let factoryURL = URL(fileURLWithPath: #file)
      .deletingLastPathComponent()   // PasswdSSOTests/
      .deletingLastPathComponent()   // ios/
      .appendingPathComponent("Shared/Demo/DemoVaultFactory.swift")

    guard let source = try? String(contentsOf: factoryURL, encoding: .utf8) else {
      return
    }

    let emailPattern = try NSRegularExpression(pattern: #"[A-Za-z0-9._%+\-]+@([A-Za-z0-9.\-]+)"#)
    let range = NSRange(source.startIndex..., in: source)
    let matches = emailPattern.matches(in: source, range: range)
    for match in matches {
      guard let domainRange = Range(match.range(at: 1), in: source) else { continue }
      let domain = String(source[domainRange])
      let ok = domain.hasSuffix("example.com") || domain.hasSuffix("example.org")
        || domain.hasSuffix("example.net")
      XCTAssertTrue(ok, "Non-reserved email domain in DemoVaultFactory: \(domain)")
    }
  }

  // MARK: - Vaults from successive calls have different keys (ephemeral)

  func testSuccessiveCalls_produceDifferentVaultKeys() throws {
    let d1 = try DemoVaultFactory.makeDemoVault()
    let d2 = try DemoVaultFactory.makeDemoVault()
    let k1 = d1.vaultKey.withUnsafeBytes { Data($0) }
    let k2 = d2.vaultKey.withUnsafeBytes { Data($0) }
    XCTAssertNotEqual(k1, k2, "Each call must produce a fresh ephemeral key")
  }
}
