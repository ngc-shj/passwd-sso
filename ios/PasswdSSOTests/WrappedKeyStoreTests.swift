import Foundation
import XCTest
@testable import Shared

/// Tests for AppGroupWrappedKeyStore — file-based round-trip, clearAll.
/// Uses a temp directory instead of the real App Group container.
final class WrappedKeyStoreTests: XCTestCase {

  private var tmpDir: URL!
  private var store: TempDirWrappedKeyStore!

  override func setUp() {
    super.setUp()
    tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "WrappedKeyStoreTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    store = TempDirWrappedKeyStore(baseDir: tmpDir)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: tmpDir)
    super.tearDown()
  }

  // MARK: - Vault key round-trip

  func testVaultKeyRoundTrip() throws {
    XCTAssertNil(try store.loadVaultKey(), "Should be nil before save")

    let wrapped = WrappedVaultKey(
      ciphertext: Data([0x01, 0x02]),
      iv: Data(repeating: 0xAA, count: 12),
      authTag: Data(repeating: 0xBB, count: 16),
      issuedAt: Date(timeIntervalSince1970: 1_000_000)
    )
    try store.saveVaultKey(wrapped)

    let loaded = try store.loadVaultKey()
    XCTAssertNotNil(loaded)
    XCTAssertEqual(loaded, wrapped)
  }

  func testVaultKeyOverwrite() throws {
    let first = WrappedVaultKey(
      ciphertext: Data([0x01]),
      iv: Data(repeating: 0x01, count: 12),
      authTag: Data(repeating: 0x01, count: 16),
      issuedAt: Date(timeIntervalSince1970: 1000)
    )
    let second = WrappedVaultKey(
      ciphertext: Data([0x02]),
      iv: Data(repeating: 0x02, count: 12),
      authTag: Data(repeating: 0x02, count: 16),
      issuedAt: Date(timeIntervalSince1970: 2000)
    )
    try store.saveVaultKey(first)
    try store.saveVaultKey(second)

    let loaded = try store.loadVaultKey()
    XCTAssertEqual(loaded, second, "Second write should replace first")
  }

  // MARK: - Team keys round-trip

  func testTeamKeysRoundTrip() throws {
    let keys = [
      WrappedTeamKey(
        teamId: "team-A",
        ciphertext: Data([0xAA]),
        iv: Data(repeating: 0x01, count: 12),
        authTag: Data(repeating: 0x02, count: 16),
        issuedAt: Date(timeIntervalSince1970: 1000),
        teamKeyVersion: 1
      ),
      WrappedTeamKey(
        teamId: "team-B",
        ciphertext: Data([0xBB]),
        iv: Data(repeating: 0x03, count: 12),
        authTag: Data(repeating: 0x04, count: 16),
        issuedAt: Date(timeIntervalSince1970: 2000),
        teamKeyVersion: 2
      ),
    ]
    try store.saveTeamKeys(keys)

    let loaded = try store.loadTeamKeys()
    XCTAssertEqual(loaded, keys)
  }

  func testLoadTeamKeysReturnsEmptyWhenNoFile() throws {
    let loaded = try store.loadTeamKeys()
    XCTAssertTrue(loaded.isEmpty)
  }

  // MARK: - ECDH private key round-trip

  func testECDHPrivateKeyRoundTrip() throws {
    XCTAssertNil(try store.loadECDHPrivateKey(), "Should be nil before save")

    let wrapped = WrappedECDHPrivateKey(
      ciphertext: Data([0xAB, 0xCD]),
      iv: Data(repeating: 0x11, count: 12),
      authTag: Data(repeating: 0x22, count: 16),
      issuedAt: Date(timeIntervalSince1970: 2_000_000)
    )
    try store.saveECDHPrivateKey(wrapped)

    let loaded = try store.loadECDHPrivateKey()
    XCTAssertNotNil(loaded)
    XCTAssertEqual(loaded, wrapped)
  }

  func testECDHPrivateKeyOverwrite() throws {
    let first = WrappedECDHPrivateKey(
      ciphertext: Data([0x01]),
      iv: Data(repeating: 0x10, count: 12),
      authTag: Data(repeating: 0x10, count: 16),
      issuedAt: Date(timeIntervalSince1970: 1000)
    )
    let second = WrappedECDHPrivateKey(
      ciphertext: Data([0x02]),
      iv: Data(repeating: 0x20, count: 12),
      authTag: Data(repeating: 0x20, count: 16),
      issuedAt: Date(timeIntervalSince1970: 2000)
    )
    try store.saveECDHPrivateKey(first)
    try store.saveECDHPrivateKey(second)

    let loaded = try store.loadECDHPrivateKey()
    XCTAssertEqual(loaded, second, "Second write should replace first")
  }

  // MARK: - clearAll

  func testClearAllDeletesBothFiles() throws {
    let vk = WrappedVaultKey(
      ciphertext: Data([0x01]),
      iv: Data(repeating: 0x01, count: 12),
      authTag: Data(repeating: 0x01, count: 16),
      issuedAt: Date()
    )
    let tk = [
      WrappedTeamKey(
        teamId: "t",
        ciphertext: Data([0x02]),
        iv: Data(repeating: 0x02, count: 12),
        authTag: Data(repeating: 0x02, count: 16),
        issuedAt: Date(),
        teamKeyVersion: 1
      )
    ]
    try store.saveVaultKey(vk)
    try store.saveTeamKeys(tk)

    try store.clearAll()

    XCTAssertNil(try store.loadVaultKey())
    XCTAssertTrue((try store.loadTeamKeys()).isEmpty)
  }

  // MARK: - clearAll removes ECDH file too

  func testClearAllDeletesECDHFile() throws {
    let vk = WrappedVaultKey(
      ciphertext: Data([0x01]),
      iv: Data(repeating: 0x01, count: 12),
      authTag: Data(repeating: 0x01, count: 16),
      issuedAt: Date()
    )
    let ecdh = WrappedECDHPrivateKey(
      ciphertext: Data([0xAB]),
      iv: Data(repeating: 0xAB, count: 12),
      authTag: Data(repeating: 0xAB, count: 16),
      issuedAt: Date()
    )
    try store.saveVaultKey(vk)
    try store.saveECDHPrivateKey(ecdh)

    // Confirm files exist before clearing.
    XCTAssertNotNil(try store.loadVaultKey())
    XCTAssertNotNil(try store.loadECDHPrivateKey())

    try store.clearAll()

    XCTAssertNil(try store.loadVaultKey(), "vault key must be deleted by clearAll")
    XCTAssertNil(try store.loadECDHPrivateKey(), "ECDH key must be deleted by clearAll")
  }

  // MARK: - clearTeamKeys leaves vault key intact

  func testClearTeamKeysRemovesTeamKeysButLeavesVaultKey() throws {
    let vk = WrappedVaultKey(
      ciphertext: Data([0x01]),
      iv: Data(repeating: 0x01, count: 12),
      authTag: Data(repeating: 0x01, count: 16),
      issuedAt: Date()
    )
    let keys = [
      WrappedTeamKey(
        teamId: "team-clear",
        ciphertext: Data([0xAA]),
        iv: Data(repeating: 0x05, count: 12),
        authTag: Data(repeating: 0x06, count: 16),
        issuedAt: Date(),
        teamKeyVersion: 1
      )
    ]
    try store.saveVaultKey(vk)
    try store.saveTeamKeys(keys)

    try store.clearTeamKeys()

    // Team keys must be gone.
    XCTAssertTrue((try store.loadTeamKeys()).isEmpty, "clearTeamKeys must remove team keys")
    // Vault key must survive.
    XCTAssertNotNil(try store.loadVaultKey(), "clearTeamKeys must NOT touch the vault key")
    XCTAssertEqual(try store.loadVaultKey(), vk)
  }

  // MARK: - Atomic write (no torn .tmp left behind)

  func testAtomicWriteLeavesNoTmpFile() throws {
    let vk = WrappedVaultKey(
      ciphertext: Data([0x01]),
      iv: Data(repeating: 0x01, count: 12),
      authTag: Data(repeating: 0x01, count: 16),
      issuedAt: Date()
    )
    try store.saveVaultKey(vk)

    // After a successful write, no .tmp file should remain
    let fm = FileManager.default
    let vaultDir = tmpDir.appending(path: "vault", directoryHint: .isDirectory)
    let files = try fm.contentsOfDirectory(atPath: vaultDir.path)
    let tmpFiles = files.filter { $0.hasSuffix(".tmp") }
    XCTAssertTrue(tmpFiles.isEmpty, "No .tmp files should remain after write: \(tmpFiles)")
  }
}

// MARK: - Test-only store backed by a temp directory

/// A WrappedKeyStore backed by a custom temp directory for testing.
/// Mirrors AppGroupWrappedKeyStore but uses an injected base directory.
final class TempDirWrappedKeyStore: WrappedKeyStore, @unchecked Sendable {
  private let baseDir: URL

  init(baseDir: URL) {
    self.baseDir = baseDir
  }

  private var vaultKeyURL: URL {
    baseDir.appending(path: "vault/wrapped-vault-key.json", directoryHint: .notDirectory)
  }

  private var teamKeysURL: URL {
    baseDir.appending(path: "vault/wrapped-team-keys.json", directoryHint: .notDirectory)
  }

  private var ecdhKeyURL: URL {
    baseDir.appending(path: "vault/wrapped-ecdh-private-key.json", directoryHint: .notDirectory)
  }

  func saveVaultKey(_ wrapped: WrappedVaultKey) throws {
    try ensureVaultDir()
    let data = try JSONEncoder().encode(wrapped)
    try atomicWrite(data: data, to: vaultKeyURL)
  }

  func loadVaultKey() throws -> WrappedVaultKey? {
    guard FileManager.default.fileExists(atPath: vaultKeyURL.path) else { return nil }
    let data = try Data(contentsOf: vaultKeyURL)
    return try JSONDecoder().decode(WrappedVaultKey.self, from: data)
  }

  func saveTeamKeys(_ keys: [WrappedTeamKey]) throws {
    try ensureVaultDir()
    let data = try JSONEncoder().encode(keys)
    try atomicWrite(data: data, to: teamKeysURL)
  }

  func loadTeamKeys() throws -> [WrappedTeamKey] {
    guard FileManager.default.fileExists(atPath: teamKeysURL.path) else { return [] }
    let data = try Data(contentsOf: teamKeysURL)
    return try JSONDecoder().decode([WrappedTeamKey].self, from: data)
  }

  func clearTeamKeys() throws {
    let fm = FileManager.default
    if fm.fileExists(atPath: teamKeysURL.path) { try fm.removeItem(at: teamKeysURL) }
  }

  func saveECDHPrivateKey(_ wrapped: WrappedECDHPrivateKey) throws {
    try ensureVaultDir()
    let data = try JSONEncoder().encode(wrapped)
    try atomicWrite(data: data, to: ecdhKeyURL)
  }

  func loadECDHPrivateKey() throws -> WrappedECDHPrivateKey? {
    guard FileManager.default.fileExists(atPath: ecdhKeyURL.path) else { return nil }
    let data = try Data(contentsOf: ecdhKeyURL)
    return try JSONDecoder().decode(WrappedECDHPrivateKey.self, from: data)
  }

  func clearAll() throws {
    let fm = FileManager.default
    if fm.fileExists(atPath: vaultKeyURL.path) { try fm.removeItem(at: vaultKeyURL) }
    if fm.fileExists(atPath: teamKeysURL.path) { try fm.removeItem(at: teamKeysURL) }
    if fm.fileExists(atPath: ecdhKeyURL.path) { try fm.removeItem(at: ecdhKeyURL) }
  }

  private func ensureVaultDir() throws {
    let dir = baseDir.appending(path: "vault", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }

  private func atomicWrite(data: Data, to url: URL) throws {
    let tmpURL = url.deletingLastPathComponent()
      .appending(path: url.lastPathComponent + ".tmp", directoryHint: .notDirectory)
    try data.write(to: tmpURL, options: .atomic)
    _ = try FileManager.default.replaceItemAt(url, withItemAt: tmpURL)
  }
}
