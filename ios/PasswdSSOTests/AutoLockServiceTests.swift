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
    autoLockMinutes: Int = 5,
    clock: Clock = SystemClock()
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
      clock: clock,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      tokenStore: tokenStore,
      uploadTokenStore: makeUploadTokenStore(keychain: keychain),
      cacheURL: cacheURL,
      faviconCacheClearing: {}
    )
    service.autoLockMinutes = autoLockMinutes
    return service
  }

  /// Upload-token store over the SAME mock keychain makeService wires in.
  private func makeUploadTokenStore(keychain: MockKeychain) -> UploadTokenStore {
    UploadTokenStore(service: "com.passwd-sso.test.upload-token", keychain: keychain)
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

  func testLockPreservesBridgeKeyBlob() {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    seedKeychain(keychain)

    let service = makeService(tmpDir: tmpDir, keychain: keychain)
    service.startTimer()
    service.lock()

    XCTAssertNotNil(
      keychain.store["com.passwd-sso.test.bridge-key-v2:blob"],
      "bridge-key-v2 must survive lock() so biometric re-unlock is available"
    )
    XCTAssertNotNil(
      keychain.store["com.passwd-sso.test.bridge-meta-v2:blob"],
      "bridge-meta-v2 must survive lock() so biometric re-unlock is available"
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

  func testLockClearsUploadToken() throws {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    seedKeychain(keychain)
    let uploadStore = makeUploadTokenStore(keychain: keychain)
    try uploadStore.save(token: "up_t", expiresAt: Date().addingTimeInterval(300), dpopNonce: "n")

    let service = makeService(tmpDir: tmpDir, keychain: keychain)
    service.startTimer()
    service.lock()

    XCTAssertNil(
      try uploadStore.load(),
      "a locked vault must not leave a spendable AutoFill upload token behind"
    )
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
    let uploadStore = makeUploadTokenStore(keychain: keychain)
    try uploadStore.save(token: "up_t", expiresAt: Date().addingTimeInterval(300), dpopNonce: nil)
    let service = AutoLockService(
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      tokenStore: tokenStore,
      uploadTokenStore: uploadStore,
      cacheURL: cacheURL
    )
    service.startTimer()
    service.signOut()

    // Ends in .loggedOut (not .locked) so the app routes to sign-in.
    XCTAssertEqual(service.state, .loggedOut(reason: .manual))
    // V2 bridge-key + bridge-meta items should be gone
    XCTAssertNil(keychain.store["com.passwd-sso.test.bridge-key-v2:blob"])
    XCTAssertNil(keychain.store["com.passwd-sso.test.bridge-meta-v2:blob"])
    // Cache file should be gone
    XCTAssertFalse(FileManager.default.fileExists(atPath: cacheURL.path))
    // Wrapped keys should be gone
    XCTAssertNil(try wks.loadVaultKey())
    // AutoFill upload token should be gone
    XCTAssertNil(try uploadStore.load())
  }

  // MARK: - Default timeout

  func testDefaultAutoLockMinutesIsFifteen() {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    // Construct directly (makeService overrides the default), so this asserts
    // the service's own default.
    let service = AutoLockService(
      bridgeKeyStore: BridgeKeyStore(
        accessGroup: "test", service: "com.passwd-sso.test.bridge-key", keychain: keychain
      ),
      wrappedKeyStore: TempDirWrappedKeyStore(baseDir: tmpDir),
      tokenStore: HostTokenStore(service: "com.passwd-sso.test.tokens", keychain: keychain),
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    )

    XCTAssertEqual(service.autoLockMinutes, 15)
  }

  // MARK: - Idle auto-lock (tick)

  func testTickLocksAtBoundary() throws {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    seedKeychain(keychain)
    // A wrapped key that .lock (unlike .logout) must KEEP.
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    try wks.saveVaultKey(
      WrappedVaultKey(
        ciphertext: Data([0x01]),
        iv: Data(repeating: 0x01, count: 12),
        authTag: Data(repeating: 0x01, count: 16),
        issuedAt: Date()
      )
    )
    let clock = TestClock(start: Date(timeIntervalSinceReferenceDate: 1000))
    let service = makeService(tmpDir: tmpDir, keychain: keychain, autoLockMinutes: 15, clock: clock)

    service.startTimer()
    service.stopTimer()  // avoid the live 1s timer racing the manual tick
    clock.advance(by: 15 * 60)
    service.tick()

    XCTAssertEqual(service.state, .locked)
    XCTAssertNotNil(
      keychain.store["com.passwd-sso.test.bridge-key-v2:blob"],
      "bridge-key must survive a .lock idle timeout so biometric re-unlock is available"
    )
    XCTAssertNotNil(
      try wks.loadVaultKey(),
      "wrapped key should survive a .lock timeout (unlike .logout)"
    )
  }

  func testTickDoesNotLockJustBeforeBoundary() {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    seedKeychain(keychain)
    let clock = TestClock(start: Date(timeIntervalSinceReferenceDate: 1000))
    let service = makeService(tmpDir: tmpDir, keychain: keychain, autoLockMinutes: 15, clock: clock)

    service.startTimer()
    service.stopTimer()
    clock.advance(by: 15 * 60 - 1)
    service.tick()

    XCTAssertEqual(service.state, .unlocked)
  }

  func testTickWithLogoutActionSignsOut() throws {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    seedKeychain(keychain)

    // A wrapped key over the same temp dir the service's store uses; signOut
    // clears it, whereas lock would keep it.
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    try wks.saveVaultKey(
      WrappedVaultKey(
        ciphertext: Data([0x01]),
        iv: Data(repeating: 0x01, count: 12),
        authTag: Data(repeating: 0x01, count: 16),
        issuedAt: Date()
      )
    )

    let clock = TestClock(start: Date(timeIntervalSinceReferenceDate: 1000))
    let service = makeService(tmpDir: tmpDir, keychain: keychain, autoLockMinutes: 15, clock: clock)
    service.timeoutAction = .logout

    service.startTimer()
    service.stopTimer()
    clock.advance(by: 15 * 60)
    service.tick()

    XCTAssertEqual(service.state, .loggedOut(reason: .idleTimeout))
    XCTAssertNil(
      keychain.store["com.passwd-sso.test.bridge-key-v2:blob"],
      "bridge_key should be deleted on logout timeout"
    )
    XCTAssertNil(
      try wks.loadVaultKey(),
      "wrapped keys should be cleared by signOut (unlike lock)"
    )
  }

  // MARK: - F2/S13 regression: signOut clears the team-directory blob

  /// Regression for F2/S13: before the fix, AutoLockService.signOut() did NOT call
  /// teamDirectoryStore.clear(), leaving the team-directory blob on disk after sign-out.
  /// This test fails against the old code (clear() never called → spy.didClear == false)
  /// and passes with the fix (signOut calls teamDirectoryStore.clear()).
  func testSignOut_clearsTeamDirectory() throws {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    seedKeychain(keychain)

    // Spy TeamDirectoryStoring that records whether clear() was called.
    final class SpyTeamDirectoryStore: TeamDirectoryStoring, @unchecked Sendable {
      private(set) var didClear = false
      func save(_ entries: [TeamDirectoryEntry], cacheKey: SymmetricKey, userId: String) throws {}
      func load(cacheKey: SymmetricKey, userId: String) -> [TeamDirectoryEntry] { [] }
      func clear() throws { didClear = true }
    }

    let spy = SpyTeamDirectoryStore()
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
      teamDirectoryStore: spy,
      tokenStore: tokenStore,
      cacheURL: cacheURL
    )
    service.startTimer()
    service.signOut()

    XCTAssertTrue(spy.didClear,
      "signOut() must call teamDirectoryStore.clear() to wipe the team-directory blob (F2/S13 regression)")
    XCTAssertEqual(service.state, .loggedOut(reason: .manual))
  }

  // MARK: - autoLockMinutes clamping

  func testAutoLockMinutesClamped() {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    let service = makeService(tmpDir: tmpDir, keychain: keychain)

    service.autoLockMinutes = 0
    XCTAssertEqual(service.autoLockMinutes, 1)  // floor

    // A tenant policy may enforce > 60 (up to the 24h max); the applied value
    // must NOT truncate to the user-picker's 60-cap.
    service.autoLockMinutes = 120
    XCTAssertEqual(service.autoLockMinutes, 120)

    service.autoLockMinutes = 2000
    XCTAssertEqual(service.autoLockMinutes, 1440)  // ceiling = 24h

    service.autoLockMinutes = 5
    XCTAssertEqual(service.autoLockMinutes, 5)
  }

  // MARK: - Favicon cache clearing

  func testSignOut_callsFaviconCacheClearing() {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    var clearCallCount = 0
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
      cacheURL: cacheURL,
      faviconCacheClearing: { clearCallCount += 1 }
    )
    service.startTimer()
    service.signOut()

    XCTAssertEqual(clearCallCount, 1, "signOut() must call faviconCacheClearing exactly once")
  }

  func testLock_doesNotCallFaviconCacheClearing() {
    let tmpDir = makeTmpDir()
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    var clearCallCount = 0
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
      cacheURL: cacheURL,
      faviconCacheClearing: { clearCallCount += 1 }
    )
    service.startTimer()
    service.lock()

    XCTAssertEqual(clearCallCount, 0, "lock() must NOT call faviconCacheClearing")
  }
}
