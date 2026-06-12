import CryptoKit
import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

// MARK: - Mock VaultUnlockData provider

/// Simulates a vault unlock by providing pre-computed encrypted key material.
/// The test creates real PBKDF2 + AES-GCM material so the full crypto path is exercised.
// NOTE: the default iteration count is the REAL 600k (pbkdf2Iterations) — the
// unlock floor rejects anything lower, and weakening production for test speed
// is prohibited. Cost: ~0.2s PBKDF2 per fixture on Apple Silicon.
private func makeVaultUnlockData(
  passphrase: String,
  iterations: Int = pbkdf2Iterations,
  keyVersion: Int = 1,
  vaultAutoLockMinutes: Int? = nil
) throws -> (data: VaultUnlockData, secretKey: Data) {
  let saltData = Data(repeating: 0xAA, count: 32)
  let wrappingKey = try deriveWrappingKeyPBKDF2(
    passphrase: passphrase,
    salt: saltData,
    iterations: iterations
  )
  let secretKey = Data(repeating: 0x42, count: 32)
  let (cipher, iv, tag) = try encryptAESGCM(plaintext: secretKey, key: wrappingKey)

  // Server stores these fields as hex (matching the web crypto-client), and
  // kdfType as an Int (0 = PBKDF2-SHA256).
  let data = VaultUnlockData(
    accountSalt: hexEncode(saltData),
    encryptedSecretKey: hexEncode(cipher),
    secretKeyIv: hexEncode(iv),
    secretKeyAuthTag: hexEncode(tag),
    keyVersion: keyVersion,
    kdfType: 0,
    kdfIterations: iterations,
    userId: "test-user-42",
    vaultAutoLockMinutes: vaultAutoLockMinutes
  )
  return (data, secretKey)
}

// MARK: - Stub data source that returns VaultUnlockData without network

/// Conforms to the production `VaultUnlockDataSource` protocol so the REAL
/// `VaultUnlocker` actor drives the unlock crypto path (hex decode, PBKDF2,
/// AES-GCM) — a regression in `VaultUnlocker.unlock` now turns these tests red.
private actor StubVaultAPIClient: VaultUnlockDataSource {
  enum Mode { case success(VaultUnlockData); case wrongPassphrase }
  let mode: Mode

  init(mode: Mode) { self.mode = mode }

  func fetchVaultUnlockData() async throws -> VaultUnlockData {
    switch mode {
    case .success(let data): return data
    case .wrongPassphrase: throw MobileAPIError.serverError(status: 401)
    }
  }
}

// MARK: - Helpers for biometric unlock tests

/// Wrap vaultKey under cacheKey and save into a TempDirWrappedKeyStore.
private func wrapAndSaveVaultKeyToStore(
  vaultKey: SymmetricKey,
  cacheKey: SymmetricKey,
  store: TempDirWrappedKeyStore
) throws {
  let vaultKeyBytes = vaultKey.withUnsafeBytes { Data($0) }
  let (cipher, iv, tag) = try encryptAESGCM(plaintext: vaultKeyBytes, key: cacheKey)
  let wrapped = WrappedVaultKey(ciphertext: cipher, iv: iv, authTag: tag, issuedAt: Date())
  try store.saveVaultKey(wrapped)
}

/// Build a minimal personal CacheEntry for biometric unlock tests.
private func makePersonalCacheEntryForBiometricTest(
  vaultKey: SymmetricKey,
  userId: String,
  keyVersion: Int
) throws -> CacheEntry {
  // Minimal blobs — content doesn't matter, only the container structure does.
  let (cipher, iv, tag) = try encryptAESGCM(
    plaintext: "{}".data(using: .utf8)!,
    key: vaultKey
  )
  let encrypted = EncryptedData(ciphertext: hexEncode(cipher), iv: hexEncode(iv), authTag: hexEncode(tag))
  return CacheEntry(
    id: "biometric-entry-1",
    teamId: nil,
    aadVersion: 0,
    keyVersion: keyVersion,
    encryptedBlob: encrypted,
    encryptedOverview: encrypted
  )
}

/// Write an encrypted cache file for biometric unlock tests.
private func buildCacheFileForBiometricTest(
  at url: URL,
  entries: [CacheEntry],
  vaultKey: SymmetricKey,
  hostInstallUUID: Data,
  counter: UInt64,
  userId: String,
  now: Date
) throws {
  let entriesData = try JSONEncoder().encode(entries)
  let header = CacheHeader(
    cacheVersionCounter: counter,
    cacheIssuedAt: now,
    lastSuccessfulRefreshAt: now,
    entryCount: UInt32(entries.count),
    hostInstallUUID: hostInstallUUID,
    userId: userId
  )
  let cacheData = CacheData(header: header, entries: entriesData)
  try writeCacheFile(
    data: cacheData,
    vaultKey: vaultKey,
    hostInstallUUID: hostInstallUUID,
    path: url
  )
}

// MARK: - Tests

final class VaultUnlockerTests: XCTestCase {

  private var tmpDir: URL!

  override func setUp() {
    super.setUp()
    tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "VaultUnlockerTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: tmpDir)
    super.tearDown()
  }

  // MARK: - Happy path

  func testUnlockHappyPathReturnsVaultKey() async throws {
    let passphrase = "correct-passphrase"
    let (unlockData, secretKey) = try makeVaultUnlockData(passphrase: passphrase)

    let keychain = MockKeychain()
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)

    let stubClient = StubVaultAPIClient(mode: .success(unlockData))
    let unlocker = VaultUnlocker(
      apiClient: stubClient,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    )

    let result = try await unlocker.unlock(passphrase: passphrase)
    let vaultKeyBytes = result.vaultKey.withUnsafeBytes { Data($0) }

    // Verify vault_key = HKDF(secretKey, info="passwd-sso-enc-v1")
    let expectedVaultKey = try deriveEncryptionKey(secretKey: secretKey)
    let expectedBytes = expectedVaultKey.withUnsafeBytes { Data($0) }
    XCTAssertEqual(vaultKeyBytes, expectedBytes)
    XCTAssertEqual(result.userId, "test-user-42")
  }

  func testUnlockHappyPathWritesWrappedVaultKey() async throws {
    let passphrase = "correct-passphrase"
    let (unlockData, _) = try makeVaultUnlockData(passphrase: passphrase)

    let keychain = MockKeychain()
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)

    let stubClient = StubVaultAPIClient(mode: .success(unlockData))
    let unlocker = VaultUnlocker(
      apiClient: stubClient,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    )

    let result = try await unlocker.unlock(passphrase: passphrase)
    XCTAssertEqual(result.userId, "test-user-42")

    // Wrapped vault key should be saved
    let wrappedVK = try wks.loadVaultKey()
    XCTAssertNotNil(wrappedVK)
    XCTAssertFalse(wrappedVK!.ciphertext.isEmpty)
  }

  func testUnlockHappyPathCreatesBridgeKeyBlob() async throws {
    let passphrase = "correct-passphrase"
    let (unlockData, _) = try makeVaultUnlockData(passphrase: passphrase)

    let keychain = MockKeychain()
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)

    let stubClient = StubVaultAPIClient(mode: .success(unlockData))
    let unlocker = VaultUnlocker(
      apiClient: stubClient,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    )

    _ = try await unlocker.unlock(passphrase: passphrase)

    // V2 split: two items written — bridge-key-v2 (32 bytes) + bridge-meta-v2 (24 bytes).
    XCTAssertNotNil(
      keychain.store["com.passwd-sso.test.bridge-key-v2:blob"],
      "Bridge-key v2 item must be written to keychain"
    )
    XCTAssertEqual(
      keychain.store["com.passwd-sso.test.bridge-key-v2:blob"]?.count, 32
    )
    XCTAssertNotNil(
      keychain.store["com.passwd-sso.test.bridge-meta-v2:blob"],
      "Bridge-meta v2 item must be written to keychain"
    )
    XCTAssertEqual(
      keychain.store["com.passwd-sso.test.bridge-meta-v2:blob"]?.count, 24
    )
  }

  // MARK: - Wrong passphrase

  func testWrongPassphrasethrowsInvalidPassphrase() async throws {
    let (unlockData, _) = try makeVaultUnlockData(passphrase: "correct-passphrase")

    let keychain = MockKeychain()
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)

    let stubClient = StubVaultAPIClient(mode: .success(unlockData))
    let unlocker = VaultUnlocker(
      apiClient: stubClient,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    )

    // Unlock with wrong passphrase — PBKDF2 will derive a different key, AES-GCM decryption will fail
    do {
      _ = try await unlocker.unlock(passphrase: "wrong-passphrase")
      XCTFail("Expected VaultUnlockError.invalidPassphrase")
    } catch VaultUnlockError.invalidPassphrase {
      // Expected
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  // MARK: - VaultUnlockData JSON decoding (kdfType is an Int, not a String)

  /// The server sends `kdfType` as an integer (0 = PBKDF2-SHA256). Decoding it
  /// as a Swift `Int` is the C8 fix; a JSON integer must decode successfully.
  func testVaultUnlockDataDecodesIntegerKdfType() throws {
    let json = #"""
    {"accountSalt":"aa","encryptedSecretKey":"bb","secretKeyIv":"cc",
     "secretKeyAuthTag":"dd","keyVersion":1,"kdfType":0,"kdfIterations":600000,
     "userId":"u-1"}
    """#
    let decoded = try JSONDecoder().decode(VaultUnlockData.self, from: Data(json.utf8))
    XCTAssertEqual(decoded.kdfType, 0)
    XCTAssertEqual(decoded.kdfIterations, 600000)
    XCTAssertEqual(decoded.userId, "u-1")
  }

  /// A string `kdfType` (the pre-fix server-shape assumption) must NOT decode —
  /// guards against reverting `VaultUnlockData.kdfType` to `String`.
  func testVaultUnlockDataRejectsStringKdfType() {
    let json = #"""
    {"accountSalt":"aa","encryptedSecretKey":"bb","secretKeyIv":"cc",
     "secretKeyAuthTag":"dd","keyVersion":1,"kdfType":"PBKDF2-SHA256",
     "kdfIterations":600000,"userId":"u-1"}
    """#
    XCTAssertThrowsError(
      try JSONDecoder().decode(VaultUnlockData.self, from: Data(json.utf8))
    )
  }

  func testVaultUnlockDataDecodesTenantAutoLockMinutes() throws {
    let base = #"{"accountSalt":"aa","encryptedSecretKey":"bb","secretKeyIv":"cc","secretKeyAuthTag":"dd","keyVersion":1,"kdfType":0,"kdfIterations":600000,"userId":"u-1""#
    // Present
    let present = try JSONDecoder().decode(
      VaultUnlockData.self, from: Data((base + #","vaultAutoLockMinutes":120}"#).utf8))
    XCTAssertEqual(present.vaultAutoLockMinutes, 120)
    // Explicit null → nil
    let null = try JSONDecoder().decode(
      VaultUnlockData.self, from: Data((base + #","vaultAutoLockMinutes":null}"#).utf8))
    XCTAssertNil(null.vaultAutoLockMinutes)
    // Absent (older server) → nil
    let absent = try JSONDecoder().decode(VaultUnlockData.self, from: Data((base + "}").utf8))
    XCTAssertNil(absent.vaultAutoLockMinutes)
  }

  /// Passes a DISTINCT tenant value (120) and asserts it is threaded into the
  /// result, proving the field flows decode → unlock → UnlockResult.
  func testUnlockThreadsTenantAutoLockMinutesFromUnlockData() async throws {
    let (unlockData, _) = try makeVaultUnlockData(passphrase: "test-pass", vaultAutoLockMinutes: 120)
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.tenant.bridge-key",
      keychain: MockKeychain()
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .success(unlockData)),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    )
    let result = try await unlocker.unlock(passphrase: "test-pass")
    XCTAssertEqual(result.tenantAutoLockMinutes, 120, "tenant minutes must thread from unlockData")
  }

  // MARK: - Unsupported KDF (kdfType != 0)

  /// An Argon2id vault (kdfType 1) is not derivable by this PBKDF2-only client;
  /// it must fail with serverResponseInvalid, NOT a misleading invalidPassphrase.
  func testUnlockRejectsUnsupportedKdfType() async throws {
    var (unlockData, _) = try makeVaultUnlockData(passphrase: "p")
    unlockData = VaultUnlockData(
      accountSalt: unlockData.accountSalt,
      encryptedSecretKey: unlockData.encryptedSecretKey,
      secretKeyIv: unlockData.secretKeyIv,
      secretKeyAuthTag: unlockData.secretKeyAuthTag,
      keyVersion: unlockData.keyVersion,
      kdfType: 1, // Argon2id — unsupported on iOS
      kdfIterations: unlockData.kdfIterations,
      userId: unlockData.userId
    )
    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .success(unlockData)),
      bridgeKeyStore: BridgeKeyStore(
        accessGroup: "test", service: "com.passwd-sso.test.bridge-key", keychain: MockKeychain()),
      wrappedKeyStore: TempDirWrappedKeyStore(baseDir: tmpDir),
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    )
    do {
      _ = try await unlocker.unlock(passphrase: "p")
      XCTFail("Expected serverResponseInvalid for unsupported kdfType")
    } catch VaultUnlockError.serverResponseInvalid {
      // Expected
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  // MARK: - kdfIterations floor (S1)

  /// A MITM'd or rogue server sending a tiny iteration count would silently
  /// weaken the wrapping key to a near-single hash, making offline passphrase
  /// brute-force trivial — the client must reject anything below the pinned
  /// 600k floor as an invalid response, before deriving anything.
  func testUnlockRejectsKdfIterationsBelowFloor() async throws {
    let (unlockData, _) = try makeVaultUnlockData(passphrase: "p", iterations: 1)
    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .success(unlockData)),
      bridgeKeyStore: BridgeKeyStore(
        accessGroup: "test", service: "com.passwd-sso.test.bridge-key", keychain: MockKeychain()),
      wrappedKeyStore: TempDirWrappedKeyStore(baseDir: tmpDir),
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    )
    do {
      _ = try await unlocker.unlock(passphrase: "p")
      XCTFail("Expected serverResponseInvalid for kdfIterations below the 600k floor")
    } catch VaultUnlockError.serverResponseInvalid {
      // Expected
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  // MARK: - Cross-platform parity (M6 / C13.3)

  private struct VaultUnlockFixture: Decodable {
    let passphrase: String
    let accountSalt: String
    let encryptedSecretKey: String
    let secretKeyIv: String
    let secretKeyAuthTag: String
    let keyVersion: Int
    let kdfType: Int
    let kdfIterations: Int
    let userId: String
    let expectedSecretKeyHex: String
  }

  /// Feeds a fixture generated by Web Crypto (PBKDF2-SHA256 600k → AES-256-GCM,
  /// the same path as the web crypto-client kdfType=0) to the REAL VaultUnlocker
  /// and asserts the unlock succeeds and derives the expected vault key. This
  /// catches drift between the web hex output format and the iOS hexDecode /
  /// PBKDF2 / AES-GCM path. Regenerate the fixture via
  /// scripts/generate-vault-unlock-fixture.mjs.
  func testUnlockDecodesWebGeneratedFixture() async throws {
    let bundle = Bundle(for: type(of: self))
    let url = try XCTUnwrap(
      bundle.url(forResource: "fixtures/vault-unlock-fixture", withExtension: "json")
        ?? bundle.url(forResource: "vault-unlock-fixture", withExtension: "json")
        ?? bundle.url(forResource: "vault-unlock-fixture", withExtension: "json", subdirectory: "fixtures"),
      "vault-unlock-fixture.json must be bundled in the test target"
    )
    let fixture = try JSONDecoder().decode(VaultUnlockFixture.self, from: Data(contentsOf: url))

    let unlockData = VaultUnlockData(
      accountSalt: fixture.accountSalt,
      encryptedSecretKey: fixture.encryptedSecretKey,
      secretKeyIv: fixture.secretKeyIv,
      secretKeyAuthTag: fixture.secretKeyAuthTag,
      keyVersion: fixture.keyVersion,
      kdfType: fixture.kdfType,
      kdfIterations: fixture.kdfIterations,
      userId: fixture.userId
    )

    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: MockKeychain()
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .success(unlockData)),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    )

    let result = try await unlocker.unlock(passphrase: fixture.passphrase)

    // Web-encrypted secret key must decrypt to the known plaintext, and the
    // derived vault key must match deriveEncryptionKey(secretKey).
    let expectedSecretKey = try hexDecode(fixture.expectedSecretKeyHex)
    let expectedVaultKey = try deriveEncryptionKey(secretKey: expectedSecretKey)
    XCTAssertEqual(
      result.vaultKey.withUnsafeBytes { Data($0) },
      expectedVaultKey.withUnsafeBytes { Data($0) },
      "web-generated unlock material must derive the same vault key on iOS"
    )
    XCTAssertEqual(result.userId, fixture.userId)
  }

  // MARK: - keyVersion threading (C4 / T11)

  /// Passes a DISTINCT keyVersion (7) and asserts result.keyVersion == 7, proving
  /// the field is threaded from unlockData.keyVersion rather than hardcoded.
  func testUnlockThreadsKeyVersionFromUnlockData() async throws {
    let (unlockData, _) = try makeVaultUnlockData(passphrase: "test-pass", keyVersion: 7)

    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.kv.bridge-key",
      keychain: MockKeychain()
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .success(unlockData)),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    )

    let result = try await unlocker.unlock(passphrase: "test-pass")
    XCTAssertEqual(result.keyVersion, 7, "keyVersion must be threaded from unlockData, not hardcoded")
  }

  func testServerReturns401throwsInvalidPassphrase() async {
    let keychain = MockKeychain()
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)

    let stubClient = StubVaultAPIClient(mode: .wrongPassphrase)
    let unlocker = VaultUnlocker(
      apiClient: stubClient,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    )

    do {
      _ = try await unlocker.unlock(passphrase: "any")
      XCTFail("Expected VaultUnlockError.invalidPassphrase")
    } catch VaultUnlockError.invalidPassphrase {
      // Expected
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  // MARK: - unlockWithBiometrics happy path (RT1/RT5 — T2/T4)

  /// Seed a real bridge_key + real wrapped vault key + real encrypted cache file,
  /// then call unlockWithBiometrics and assert vaultKey / userId / keyVersion.
  /// keyVersion=3 is a DISTINCT value so we prove it's read from the cache,
  /// not defaulted to 1.
  func testUnlockWithBiometricsHappyPath() async throws {
    let keychain = MockKeychainAccessor()
    let bks = BridgeKeyStore(
      accessGroup: "test.jp.jpng.passwd-sso.shared",
      keychain: keychain
    )
    let blob = try bks.create()

    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    try wrapAndSaveVaultKeyToStore(vaultKey: vaultKey, cacheKey: cacheKey, store: wks)

    let cacheURL = tmpDir.appending(path: "biometric.cache", directoryHint: .notDirectory)
    let entry = try makePersonalCacheEntryForBiometricTest(
      vaultKey: vaultKey,
      userId: "biometric-user-1",
      keyVersion: 3
    )
    try buildCacheFileForBiometricTest(
      at: cacheURL,
      entries: [entry],
      vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID,
      counter: blob.cacheVersionCounter,
      userId: "biometric-user-1",
      now: Date()
    )

    // Inject a fixed now so the cache isn't stale.
    let testNow = Date()
    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .wrongPassphrase),  // offline — must not be called
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      now: { testNow }
    )

    let result = try await unlocker.unlockWithBiometrics(reason: "test")

    let expectedKeyBytes = vaultKey.withUnsafeBytes { Data($0) }
    let resultKeyBytes = result.vaultKey.withUnsafeBytes { Data($0) }
    XCTAssertEqual(resultKeyBytes, expectedKeyBytes, "vault key must match the seeded key")
    XCTAssertEqual(result.userId, "biometric-user-1", "userId must come from the cache header")
    XCTAssertEqual(result.keyVersion, 3, "keyVersion must be read from personal cache entry, not defaulted")
    XCTAssertNil(result.tenantAutoLockMinutes, "biometric/offline path fetches no fresh policy → nil")
  }

  // MARK: - unlockWithBiometrics error paths

  func testUnlockWithBiometrics_missingWrappedKey_throwsBiometricUnavailable() async throws {
    let keychain = MockKeychainAccessor()
    let bks = BridgeKeyStore(
      accessGroup: "test.jp.jpng.passwd-sso.shared",
      keychain: keychain
    )
    _ = try bks.create()  // bridge_key present, but no wrapped vault key

    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let cacheURL = tmpDir.appending(path: "missing-wk.cache", directoryHint: .notDirectory)
    let testNow = Date()
    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .wrongPassphrase),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      now: { testNow }
    )

    do {
      _ = try await unlocker.unlockWithBiometrics(reason: "test")
      XCTFail("Expected biometricUnavailable")
    } catch VaultUnlockError.biometricUnavailable {
      // Expected
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  func testUnlockWithBiometrics_unreadableCache_throwsCacheUnreadable() async throws {
    let keychain = MockKeychainAccessor()
    let bks = BridgeKeyStore(
      accessGroup: "test.jp.jpng.passwd-sso.shared",
      keychain: keychain
    )
    let blob = try bks.create()
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    try wrapAndSaveVaultKeyToStore(vaultKey: vaultKey, cacheKey: cacheKey, store: wks)

    // Build a cache with an empty userId — triggers .cacheUnreadable guard.
    let cacheURL = tmpDir.appending(path: "empty-userid.cache", directoryHint: .notDirectory)
    try buildCacheFileForBiometricTest(
      at: cacheURL,
      entries: [],
      vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID,
      counter: blob.cacheVersionCounter,
      userId: "",  // empty userId
      now: Date()
    )

    let testNow = Date()
    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .wrongPassphrase),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      now: { testNow }
    )

    do {
      _ = try await unlocker.unlockWithBiometrics(reason: "test")
      XCTFail("Expected cacheUnreadable")
    } catch VaultUnlockError.cacheUnreadable {
      // Expected
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  // MARK: - biometricUnlockAvailable (RT5 — T3/T6)

  func testBiometricUnlockAvailable_trueWhenBothPresent() throws {
    let keychain = MockKeychainAccessor()
    let bks = BridgeKeyStore(
      accessGroup: "test.jp.jpng.passwd-sso.shared",
      keychain: keychain
    )
    let blob = try bks.create()
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    try wrapAndSaveVaultKeyToStore(vaultKey: vaultKey, cacheKey: cacheKey, store: wks)

    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .wrongPassphrase),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "avail.cache", directoryHint: .notDirectory)
    )

    XCTAssertTrue(unlocker.biometricUnlockAvailable())
  }

  func testBiometricUnlockAvailable_falseWhenBridgeKeyAbsent() throws {
    let keychain = MockKeychainAccessor()
    let bks = BridgeKeyStore(
      accessGroup: "test.jp.jpng.passwd-sso.shared",
      keychain: keychain
    )
    // No create() — bridge_key absent

    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    // Seed a wrapped key even though bridge_key is absent — should still be false
    let dummyVaultKey = SymmetricKey(size: .bits256)
    let dummyCacheKey = SymmetricKey(size: .bits256)
    try wrapAndSaveVaultKeyToStore(vaultKey: dummyVaultKey, cacheKey: dummyCacheKey, store: wks)

    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .wrongPassphrase),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "avail2.cache", directoryHint: .notDirectory)
    )

    XCTAssertFalse(unlocker.biometricUnlockAvailable(), "must be false when bridge_key is absent")
  }

  func testBiometricUnlockAvailable_falseWhenWrappedKeyAbsent() throws {
    let keychain = MockKeychainAccessor()
    let bks = BridgeKeyStore(
      accessGroup: "test.jp.jpng.passwd-sso.shared",
      keychain: keychain
    )
    _ = try bks.create()  // bridge_key present

    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    // No wrapped key saved

    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .wrongPassphrase),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "avail3.cache", directoryHint: .notDirectory)
    )

    XCTAssertFalse(unlocker.biometricUnlockAvailable(), "must be false when wrapped key is absent")
  }

  // MARK: - biometricUnlockAvailable only touches bridge-meta-v2 (T3)

  func testBiometricUnlockAvailable_onlyTouchesBridgeMeta() throws {
    let keychain = MockKeychainAccessor()
    let bks = BridgeKeyStore(
      accessGroup: "test.jp.jpng.passwd-sso.shared",
      keychain: keychain
    )
    let blob = try bks.create()
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)
    keychain.accessedServices = []  // reset after create()

    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    try wrapAndSaveVaultKeyToStore(vaultKey: vaultKey, cacheKey: cacheKey, store: wks)

    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .wrongPassphrase),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "meta-only.cache", directoryHint: .notDirectory)
    )

    _ = unlocker.biometricUnlockAvailable()

    // Only the no-ACL meta service should be accessed (readDirect only reads meta)
    XCTAssertFalse(
      keychain.accessedServices.contains("jp.jpng.passwd-sso.shared.bridge-key-v2"),
      "biometricUnlockAvailable must NOT read the biometric-gated bridge-key-v2 item"
    )
    XCTAssertTrue(
      keychain.accessedServices.contains(where: { $0.hasSuffix("bridge-meta-v2") }),
      "biometricUnlockAvailable must read the bridge-meta-v2 item"
    )
  }
}
