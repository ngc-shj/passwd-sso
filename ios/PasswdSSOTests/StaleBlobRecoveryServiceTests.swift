import CryptoKit
import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

final class StaleBlobRecoveryServiceTests: XCTestCase {

  private var tmpDir: URL!
  private var cacheURL: URL!

  override func setUp() {
    super.setUp()
    tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "StaleBlobTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    cacheURL = tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: tmpDir)
    super.tearDown()
  }

  // MARK: - Helpers

  private func makeKeychain(counter: UInt64, uuid: Data = Data(repeating: 0xAB, count: 16)) -> MockKeychain {
    let keychain = MockKeychain()
    var blob = Data(repeating: 0x01, count: 32)  // bridge_key
    let counterBE = counter.bigEndian
    withUnsafeBytes(of: counterBE) { blob.append(contentsOf: $0) }
    blob.append(uuid)
    keychain.store["blob"] = blob
    return keychain
  }

  private func writeCacheAtCounter(
    _ counter: UInt64,
    vaultKey: SymmetricKey,
    uuid: Data = Data(repeating: 0xAB, count: 16)
  ) throws {
    let header = CacheHeader(
      cacheVersionCounter: counter,
      cacheIssuedAt: Date(),
      lastSuccessfulRefreshAt: Date(),
      entryCount: 0,
      hostInstallUUID: uuid
    )
    let data = CacheData(header: header, entries: "[]".data(using: .utf8)!)
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: uuid, path: cacheURL)
  }

  // MARK: - Forward counter recovery

  func testRecoveryHappensWhenCacheIsForwardByOne() async throws {
    let vaultKey = SymmetricKey(size: .bits256)
    let uuid = Data(repeating: 0xAB, count: 16)

    // blob is at counter N=10, cache is at N+1=11 (forward stale-blob scenario)
    let keychain = makeKeychain(counter: 10, uuid: uuid)
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    try writeCacheAtCounter(11, vaultKey: vaultKey, uuid: uuid)

    let service = StaleBlobRecoveryService(bridgeKeyStore: bks, cacheURL: cacheURL)
    let recovered = try await service.recoverIfNeeded(vaultKey: vaultKey)

    XCTAssertTrue(recovered, "Should have recovered the forward counter")

    // Blob counter should now be 11
    let blob = try bks.readDirect()
    XCTAssertEqual(blob.cacheVersionCounter, 11)
  }

  // MARK: - No recovery when cache decrypts with wrong key

  func testNoRecoveryWithWrongVaultKey() async throws {
    let writeKey = SymmetricKey(size: .bits256)
    let wrongReadKey = SymmetricKey(size: .bits256)
    let uuid = Data(repeating: 0xAB, count: 16)

    let keychain = makeKeychain(counter: 10, uuid: uuid)
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    // Write cache with writeKey at counter 11
    try writeCacheAtCounter(11, vaultKey: writeKey, uuid: uuid)

    let service = StaleBlobRecoveryService(bridgeKeyStore: bks, cacheURL: cacheURL)
    // Try to recover with wrong key — decryption will fail
    let recovered = try await service.recoverIfNeeded(vaultKey: wrongReadKey)

    XCTAssertFalse(recovered, "Should not recover with wrong vault key")

    // Blob counter should still be 10
    let blob = try bks.readDirect()
    XCTAssertEqual(blob.cacheVersionCounter, 10)
  }

  // MARK: - No recovery when cache counter equals blob counter

  func testNoRecoveryWhenCountersMatch() async throws {
    let vaultKey = SymmetricKey(size: .bits256)
    let uuid = Data(repeating: 0xAB, count: 16)

    // blob=10, cache=10 — nothing to recover
    let keychain = makeKeychain(counter: 10, uuid: uuid)
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    try writeCacheAtCounter(10, vaultKey: vaultKey, uuid: uuid)

    let service = StaleBlobRecoveryService(bridgeKeyStore: bks, cacheURL: cacheURL)
    // Will try to read cache with expectedCounter=11, which won't match counter=10 in file
    let recovered = try await service.recoverIfNeeded(vaultKey: vaultKey)

    XCTAssertFalse(recovered)
    let blob = try bks.readDirect()
    XCTAssertEqual(blob.cacheVersionCounter, 10)
  }

  // MARK: - No recovery when blob is missing

  func testNoRecoveryWhenBlobMissing() async throws {
    let vaultKey = SymmetricKey(size: .bits256)
    let uuid = Data(repeating: 0xAB, count: 16)

    // Empty keychain — no blob
    let keychain = MockKeychain()
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    try writeCacheAtCounter(11, vaultKey: vaultKey, uuid: uuid)

    let service = StaleBlobRecoveryService(bridgeKeyStore: bks, cacheURL: cacheURL)
    let recovered = try await service.recoverIfNeeded(vaultKey: vaultKey)

    XCTAssertFalse(recovered)
  }
}
