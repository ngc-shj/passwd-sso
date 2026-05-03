import CryptoKit
import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

// MARK: - Test helpers for HostSyncService

/// Pre-seed the mock keychain with v2-split items (bridge-key-v2 + bridge-meta-v2)
/// equivalent to a freshly-created BridgeKeyStore at the given counter.
func seedBlobInKeychain(
  _ keychain: MockKeychain,
  counter: UInt64 = 1,
  service: String = "com.passwd-sso.test.bridge-key"
) {
  let bridgeKey = Data(repeating: 0x01, count: 32)
  var meta = Data()
  let counterBE = counter.bigEndian
  withUnsafeBytes(of: counterBE) { meta.append(contentsOf: $0) }
  meta.append(contentsOf: Data(repeating: 0x02, count: 16))  // uuid
  keychain.store["\(service)-v2:blob"] = bridgeKey
  let metaService = service.hasSuffix("bridge-key")
    ? service.replacingOccurrences(of: "bridge-key", with: "bridge-meta") + "-v2"
    : service + "-meta-v2"
  keychain.store["\(metaService):blob"] = meta
}

/// Mock keychain for BridgeKeyStore tests. Keys by `service:account` so the
/// V2 split layout (two services sharing account="blob") is modeled correctly.
final class MockKeychain: KeychainAccessor, @unchecked Sendable {
  var store: [String: Data] = [:]

  private func key(_ query: [String: Any]) -> String {
    let service = query[kSecAttrService as String] as? String ?? ""
    let account = query[kSecAttrAccount as String] as? String ?? ""
    return "\(service):\(account)"
  }

  func add(query: [String: Any]) -> OSStatus {
    guard let data = query[kSecValueData as String] as? Data else {
      return errSecParam
    }
    let k = key(query)
    if store[k] != nil { return errSecDuplicateItem }
    store[k] = data
    return errSecSuccess
  }

  func copyMatching(query: [String: Any]) -> (OSStatus, Data?) {
    let k = key(query)
    guard let data = store[k] else { return (errSecItemNotFound, nil) }
    return (errSecSuccess, data)
  }

  func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
    guard let data = attributes[kSecValueData as String] as? Data else {
      return errSecParam
    }
    let k = key(query)
    store[k] = data
    return errSecSuccess
  }

  func delete(query: [String: Any]) -> OSStatus {
    let k = key(query)
    if store.removeValue(forKey: k) != nil { return errSecSuccess }
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
  private let userId: String

  init(
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore,
    cacheURL: URL,
    vaultKey: SymmetricKey,
    entries: [EncryptedEntry],
    userId: String = "stub-user-id"
  ) {
    self.bridgeKeyStore = bridgeKeyStore
    self.wrappedKeyStore = wrappedKeyStore
    self.cacheURL = cacheURL
    self.vaultKey = vaultKey
    self.entries = entries
    self.userId = userId
  }

  func runSync() async throws -> SyncReport {
    let now = Date()
    let blob = try bridgeKeyStore.readDirect()
    let newCounter = blob.cacheVersionCounter &+ 1

    // Convert EncryptedEntry → CacheEntry (personal, aadVersion from entry)
    let cacheEntries: [CacheEntry] = entries.map { entry in
      CacheEntry(
        id: entry.id,
        teamId: nil,
        aadVersion: entry.aadVersion,
        keyVersion: entry.keyVersion,
        encryptedBlob: entry.encryptedBlob,
        encryptedOverview: entry.encryptedOverview
      )
    }

    let encoder = JSONEncoder()
    let entriesJSON = try encoder.encode(cacheEntries)

    let header = CacheHeader(
      cacheVersionCounter: newCounter,
      cacheIssuedAt: now,
      lastSuccessfulRefreshAt: now,
      entryCount: UInt32(cacheEntries.count),
      hostInstallUUID: blob.hostInstallUUID,
      userId: userId
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
      entriesFetched: cacheEntries.count,
      cacheBytesWritten: bytesWritten,
      lastSuccessfulRefreshAt: now
    )
  }
}
