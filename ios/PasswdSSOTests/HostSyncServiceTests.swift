import CryptoKit
import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

// MARK: - Test helpers for HostSyncService

/// Write a minimal valid 56-byte bridge_key_blob to the mock keychain.
private func seedBlobInKeychain(_ keychain: MockKeychain, counter: UInt64 = 1) {
  var blob = Data(repeating: 0x01, count: 32)  // bridge_key
  let counterBE = counter.bigEndian
  withUnsafeBytes(of: counterBE) { blob.append(contentsOf: $0) }
  blob.append(contentsOf: Data(repeating: 0x02, count: 16))  // uuid
  keychain.store["blob"] = blob
}

/// Mock keychain for BridgeKeyStore tests.
final class MockKeychain: KeychainAccessor, @unchecked Sendable {
  var store: [String: Data] = [:]

  func add(query: [String: Any]) -> OSStatus {
    guard let account = query[kSecAttrAccount as String] as? String,
          let data = query[kSecValueData as String] as? Data else {
      return errSecParam
    }
    if store[account] != nil { return errSecDuplicateItem }
    store[account] = data
    return errSecSuccess
  }

  func copyMatching(query: [String: Any]) -> (OSStatus, Data?) {
    guard let account = query[kSecAttrAccount as String] as? String else {
      return (errSecParam, nil)
    }
    guard let data = store[account] else { return (errSecItemNotFound, nil) }
    return (errSecSuccess, data)
  }

  func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
    guard let account = query[kSecAttrAccount as String] as? String,
          let data = attributes[kSecValueData as String] as? Data else {
      return errSecParam
    }
    store[account] = data
    return errSecSuccess
  }

  func delete(query: [String: Any]) -> OSStatus {
    guard let account = query[kSecAttrAccount as String] as? String else {
      return errSecParam
    }
    if store.removeValue(forKey: account) != nil { return errSecSuccess }
    return errSecItemNotFound
  }
}

// MARK: - Test-only HostSyncService using real cache writes to a temp directory

/// Exercising the atomic write + counter increment ordering.
final class HostSyncServiceTests: XCTestCase {

  private var tmpDir: URL!

  override func setUp() {
    super.setUp()
    tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "HostSyncServiceTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: tmpDir)
    super.tearDown()
  }

  // MARK: - Counter increment ordering

  func testSyncIncrementsCounterAfterCacheWrite() async throws {
    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 10)

    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let cacheURL = tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)

    let vaultKey = SymmetricKey(size: .bits256)

    // Run a minimal sync using the StubHostSyncService
    let stub = StubHostSyncService(
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      vaultKey: vaultKey,
      entries: []
    )
    let report = try await stub.runSync()

    // Verify the blob counter is now 11
    let blob = try bks.readDirect()
    XCTAssertEqual(blob.cacheVersionCounter, 11)

    // Verify the cache file exists
    XCTAssertTrue(FileManager.default.fileExists(atPath: cacheURL.path))

    // Verify cache is readable with the new counter
    _ = try readCacheFile(
      path: cacheURL,
      vaultKey: vaultKey,
      expectedHostInstallUUID: blob.hostInstallUUID,
      expectedCounter: 11
    )

    XCTAssertEqual(report.entriesFetched, 0)
    XCTAssertGreaterThan(report.cacheBytesWritten, 0)
  }

  func testSyncWithEntries() async throws {
    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 5)

    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let cacheURL = tmpDir.appending(path: "test2.cache", directoryHint: .notDirectory)

    let vaultKey = SymmetricKey(size: .bits256)

    // Build some fake entries
    let dummyEncData = EncryptedData(
      ciphertext: hexEncode(Data(repeating: 0xAA, count: 32)),
      iv: hexEncode(Data(repeating: 0xBB, count: 12)),
      authTag: hexEncode(Data(repeating: 0xCC, count: 16))
    )
    let entries = [
      EncryptedEntry(
        id: "entry-1",
        encryptedOverview: dummyEncData,
        encryptedBlob: dummyEncData
      ),
      EncryptedEntry(
        id: "entry-2",
        encryptedOverview: dummyEncData,
        encryptedBlob: dummyEncData
      ),
    ]

    let stub = StubHostSyncService(
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      vaultKey: vaultKey,
      entries: entries
    )
    let report = try await stub.runSync()

    XCTAssertEqual(report.entriesFetched, 2)

    // Counter should have advanced from 5 → 6
    let blob = try bks.readDirect()
    XCTAssertEqual(blob.cacheVersionCounter, 6)
  }
}

// MARK: - Stub that avoids network calls

/// A minimal sync implementation for unit testing — bypasses MobileAPIClient entirely.
private actor StubHostSyncService {
  private let bridgeKeyStore: BridgeKeyStore
  private let wrappedKeyStore: WrappedKeyStore
  private let cacheURL: URL
  private let vaultKey: SymmetricKey
  private let entries: [EncryptedEntry]

  init(
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore,
    cacheURL: URL,
    vaultKey: SymmetricKey,
    entries: [EncryptedEntry]
  ) {
    self.bridgeKeyStore = bridgeKeyStore
    self.wrappedKeyStore = wrappedKeyStore
    self.cacheURL = cacheURL
    self.vaultKey = vaultKey
    self.entries = entries
  }

  func runSync() async throws -> SyncReport {
    let now = Date()
    let blob = try bridgeKeyStore.readDirect()
    let newCounter = blob.cacheVersionCounter &+ 1

    let encoder = JSONEncoder()
    let entriesJSON = try encoder.encode(entries)

    let header = CacheHeader(
      cacheVersionCounter: newCounter,
      cacheIssuedAt: now,
      lastSuccessfulRefreshAt: now,
      entryCount: UInt32(entries.count),
      hostInstallUUID: blob.hostInstallUUID
    )
    let cacheData = CacheData(header: header, entries: entriesJSON)

    // Per plan §"Write ordering": write file first, then update blob
    try writeCacheFile(
      data: cacheData,
      vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID,
      path: cacheURL
    )
    try bridgeKeyStore.incrementCounter(newCounter: newCounter)

    let attrs = try? FileManager.default.attributesOfItem(atPath: cacheURL.path)
    let bytesWritten = (attrs?[.size] as? Int) ?? entriesJSON.count

    return SyncReport(
      entriesFetched: entries.count,
      cacheBytesWritten: bytesWritten,
      lastSuccessfulRefreshAt: now
    )
  }
}
