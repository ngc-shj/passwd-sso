import CryptoKit
import Foundation
import XCTest
@testable import Shared

final class RollbackFlagWriterTests: XCTestCase {

  private var tmpDir: URL!
  private var flagWriter: AppGroupRollbackFlagWriter!
  private let vaultKey = SymmetricKey(size: .bits256)

  override func setUp() {
    super.setUp()
    tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "RollbackFlagWriterTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    flagWriter = AppGroupRollbackFlagWriter(directory: tmpDir)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: tmpDir)
    super.tearDown()
  }

  private var flagURL: URL {
    tmpDir.appending(path: "rollback-flag.json", directoryHint: .notDirectory)
  }

  private func makePayload(kind: CacheRejectionKind = .counterMismatch) -> RollbackFlagPayload {
    RollbackFlagPayload(
      expectedCounter: 42,
      observedCounter: 99,
      headerIssuedAt: Date(timeIntervalSince1970: 1_000_000),
      rejectionKind: kind
    )
  }

  // MARK: - HMAC round-trip

  func testWriteFlag_producesValidHMAC() async throws {
    let payload = makePayload()
    try await flagWriter.writeFlag(payload: payload, vaultKey: vaultKey)

    let fileData = try Data(contentsOf: flagURL)
    let verified = try RollbackFlagVerifier.verify(fileData: fileData, vaultKey: vaultKey)

    XCTAssertEqual(verified.payload.expectedCounter, payload.expectedCounter)
    XCTAssertEqual(verified.payload.observedCounter, payload.observedCounter)
    XCTAssertEqual(verified.payload.rejectionKind, payload.rejectionKind)
  }

  // MARK: - Wrong vault key

  func testWriteFlag_differentVaultKey_failsVerification() async throws {
    let payload = makePayload()
    try await flagWriter.writeFlag(payload: payload, vaultKey: vaultKey)

    let fileData = try Data(contentsOf: flagURL)
    let wrongKey = SymmetricKey(size: .bits256)

    XCTAssertThrowsError(
      try RollbackFlagVerifier.verify(fileData: fileData, vaultKey: wrongKey)
    ) { error in
      XCTAssertEqual(error as? RollbackFlagError, .macMismatch)
    }
  }

  // MARK: - Atomic write (no torn .tmp file)

  func testWriteFlag_atomicWrite() async throws {
    let payload = makePayload()
    try await flagWriter.writeFlag(payload: payload, vaultKey: vaultKey)

    let files = try FileManager.default.contentsOfDirectory(atPath: tmpDir.path)
    let tmpFiles = files.filter { $0.hasSuffix(".tmp") }
    XCTAssertTrue(tmpFiles.isEmpty, "No .tmp files should remain after successful write: \(tmpFiles)")
    XCTAssertTrue(files.contains("rollback-flag.json"), "Flag file should exist")
  }

  // MARK: - Overwrite existing flag

  func testWriteFlag_overwritesExistingFlag() async throws {
    let firstPayload = makePayload(kind: .counterMismatch)
    try await flagWriter.writeFlag(payload: firstPayload, vaultKey: vaultKey)

    let secondVaultKey = SymmetricKey(size: .bits256)
    let secondPayload = RollbackFlagPayload(
      expectedCounter: 100,
      observedCounter: 200,
      headerIssuedAt: nil,
      rejectionKind: .headerStale
    )
    try await flagWriter.writeFlag(payload: secondPayload, vaultKey: secondVaultKey)

    // Only one flag file should exist.
    let files = try FileManager.default.contentsOfDirectory(atPath: tmpDir.path)
    let flagFiles = files.filter { !$0.hasSuffix(".tmp") }
    XCTAssertEqual(flagFiles.count, 1, "Only one flag file should remain after overwrite")

    // The file should contain the second payload (verifiable under secondVaultKey).
    let fileData = try Data(contentsOf: flagURL)
    let verified = try RollbackFlagVerifier.verify(fileData: fileData, vaultKey: secondVaultKey)
    XCTAssertEqual(verified.payload.expectedCounter, 100)
    XCTAssertEqual(verified.payload.rejectionKind, .headerStale)
  }

  // MARK: - All rejection kinds survive round-trip

  func testWriteFlag_allRejectionKinds() async throws {
    let kinds: [CacheRejectionKind] = [
      .headerMissing, .aadMismatch, .authtagInvalid,
      .entryCountMismatch, .headerClockSkew, .headerStale,
      .counterMismatch, .headerInvalid,
    ]
    for kind in kinds {
      let payload = makePayload(kind: kind)
      try await flagWriter.writeFlag(payload: payload, vaultKey: vaultKey)
      let fileData = try Data(contentsOf: flagURL)
      let verified = try RollbackFlagVerifier.verify(fileData: fileData, vaultKey: vaultKey)
      XCTAssertEqual(verified.payload.rejectionKind, kind, "Round-trip failed for kind: \(kind)")
    }
  }
}
