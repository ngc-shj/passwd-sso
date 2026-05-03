import CryptoKit
import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

/// Tests for AutoLockService using TestClock for deterministic time control.
@MainActor
final class AutoLockServiceTests: XCTestCase {

  // MARK: - Helpers

  private func makeService(
    tmpDir: URL,
    keychain: MockKeychain,
    autoLockMinutes: Int = 5
  ) -> AutoLockService {
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let tokenStore = HostTokenStore(
      service: "com.passwd-sso.test.tokens",
      keychain: keychain
    )
    let cacheURL = tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    let service = AutoLockService(
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      tokenStore: tokenStore,
      cacheURL: cacheURL
    )
    service.autoLockMinutes = autoLockMinutes
    return service
  }

  private func makeTmpDir() -> URL {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "AutoLockTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private func seedKeychain(_ keychain: MockKeychain, counter: UInt64 = 1) {
    keychain.store["com.passwd-sso.test.bridge-key-v2:blob"] =
      Data(repeating: 0x01, count: 32)
    var meta = Data()
    let counterBE = counter.bigEndian
    withUnsafeBytes(of: counterBE) { meta.append(contentsOf: $0) }
    meta.append(contentsOf: Data(repeating: 0x02, count: 16))
    keychain.store["com.passwd-sso.test.bridge-meta-v2:blob"] = meta
  }

  // MARK: - State after unlock

  func testStartTimerSetsStateToUnlocked() {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    let service = makeService(tmpDir: tmpDir, keychain: keychain)

    service.startTimer()
    XCTAssertEqual(service.state, .unlocked)

    service.stopTimer()
  }

  // MARK: - Manual lock

  func testLockSetsStateToLocked() {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    seedKeychain(keychain)

    let service = makeService(tmpDir: tmpDir, keychain: keychain)
    service.startTimer()
    XCTAssertEqual(service.state, .unlocked)

    service.lock()
    XCTAssertEqual(service.state, .locked)
  }

  func testLockDeletesBridgeKeyBlob() {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    seedKeychain(keychain)

    let service = makeService(tmpDir: tmpDir, keychain: keychain)
    service.startTimer()
    service.lock()

    XCTAssertNil(
      keychain.store["com.passwd-sso.test.bridge-key-v2:blob"],
      "bridge-key-v2 should be deleted after lock"
    )
    XCTAssertNil(
      keychain.store["com.passwd-sso.test.bridge-meta-v2:blob"],
      "bridge-meta-v2 should be deleted after lock"
    )
  }

  func testLockKeepsWrappedKeyFiles() throws {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    seedKeychain(keychain)

    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let wrappedVK = WrappedVaultKey(
      ciphertext: Data([0x01]),
      iv: Data(repeating: 0x01, count: 12),
      authTag: Data(repeating: 0x01, count: 16),
      issuedAt: Date()
    )
    try wks.saveVaultKey(wrappedVK)

    let service = makeService(tmpDir: tmpDir, keychain: keychain)
    service.startTimer()
    service.lock()

    // Wrapped vault key should still exist
    let loaded = try wks.loadVaultKey()
    XCTAssertNotNil(loaded, "wrapped vault key should survive lock()")
  }

  // MARK: - Sign-out

  func testSignOutDeletesEverything() throws {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    seedKeychain(keychain)

    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let wrappedVK = WrappedVaultKey(
      ciphertext: Data([0x01]),
      iv: Data(repeating: 0x01, count: 12),
      authTag: Data(repeating: 0x01, count: 16),
      issuedAt: Date()
    )
    try wks.saveVaultKey(wrappedVK)

    // Create a dummy cache file
    let cacheURL = tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    try Data([0xFF]).write(to: cacheURL)

    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    let tokenStore = HostTokenStore(
      service: "com.passwd-sso.test.tokens",
      keychain: keychain
    )
    let service = AutoLockService(
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      tokenStore: tokenStore,
      cacheURL: cacheURL
    )
    service.startTimer()
    service.signOut()

    // V2 bridge-key + bridge-meta items should be gone
    XCTAssertNil(keychain.store["com.passwd-sso.test.bridge-key-v2:blob"])
    XCTAssertNil(keychain.store["com.passwd-sso.test.bridge-meta-v2:blob"])
    // Cache file should be gone
    XCTAssertFalse(FileManager.default.fileExists(atPath: cacheURL.path))
    // Wrapped keys should be gone
    XCTAssertNil(try wks.loadVaultKey())
  }

  // MARK: - autoLockMinutes clamping

  func testAutoLockMinutesClamped() {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    let service = makeService(tmpDir: tmpDir, keychain: keychain)

    service.autoLockMinutes = 0
    XCTAssertEqual(service.autoLockMinutes, 1)

    service.autoLockMinutes = 100
    XCTAssertEqual(service.autoLockMinutes, 60)

    service.autoLockMinutes = 5
    XCTAssertEqual(service.autoLockMinutes, 5)
  }
}
