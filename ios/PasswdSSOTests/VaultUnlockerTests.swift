import CryptoKit
import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

// MARK: - ECDH VaultUnlockData builder

/// Build VaultUnlockData with ECDH fields populated. Generates a real P-256
/// keypair, exports PKCS#8, encrypts it under deriveEcdhWrappingKey(secretKey),
/// and injects the 4 ECDH fields. Returns the data, the plain secretKey bytes,
/// and the generated member key so callers can verify the stored blob.
private func makeVaultUnlockDataWithECDH(
  passphrase: String,
  userId: String = "ecdh-user-1"
) throws -> (data: VaultUnlockData, secretKey: Data, memberKey: P256.KeyAgreement.PrivateKey) {
  let saltData = Data(repeating: 0xBB, count: 32)
  let wrappingKey = try deriveWrappingKeyPBKDF2(
    passphrase: passphrase,
    salt: saltData,
    iterations: pbkdf2Iterations
  )
  let secretKey = Data(repeating: 0x55, count: 32)
  let (cipher, iv, tag) = try encryptAESGCM(plaintext: secretKey, key: wrappingKey)

  // Generate a fresh P-256 keypair.
  let memberKey = P256.KeyAgreement.PrivateKey()
  var pkcs8 = memberKey.derRepresentation
  defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }

  // Encrypt PKCS#8 under the ECDH wrapping key (HKDF of secretKey).
  let ecdhWrappingKey = TeamKeyCrypto.deriveEcdhWrappingKey(
    secretKey: SymmetricKey(data: secretKey)
  )
  let (ecdhCipher, ecdhIV, ecdhTag) = try encryptAESGCM(plaintext: pkcs8, key: ecdhWrappingKey)

  let data = VaultUnlockData(
    accountSalt: hexEncode(saltData),
    encryptedSecretKey: hexEncode(cipher),
    secretKeyIv: hexEncode(iv),
    secretKeyAuthTag: hexEncode(tag),
    keyVersion: 1,
    kdfType: 0,
    kdfIterations: pbkdf2Iterations,
    userId: userId,
    encryptedEcdhPrivateKey: hexEncode(ecdhCipher),
    ecdhPrivateKeyIv: hexEncode(ecdhIV),
    ecdhPrivateKeyAuthTag: hexEncode(ecdhTag)
  )
  return (data, secretKey, memberKey)
}

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
  enum Mode { case success(VaultUnlockData); case wrongPassphrase; case sessionDead }
  let mode: Mode

  init(mode: Mode) { self.mode = mode }

  func fetchVaultUnlockData() async throws -> VaultUnlockData {
    switch mode {
    case .success(let data): return data
    case .wrongPassphrase: throw MobileAPIError.serverError(status: 401)
    // A dead refresh token surfaces from the API client as authenticationRequired
    // (see MobileAPIClient.doRefreshAndPersist). VaultUnlocker must map it to
    // sessionExpired so the UI routes to "sign in again", not a passphrase retry.
    case .sessionDead: throw MobileAPIError.authenticationRequired
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

  /// A dead refresh token (authenticationRequired from the API client) must map
  /// to sessionExpired — NOT invalidPassphrase or serverResponseInvalid — so the
  /// UI can route to "sign in again" instead of looping on a passphrase prompt.
  func testDeadSessionThrowsSessionExpired() async throws {
    let keychain = MockKeychain()
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)

    let stubClient = StubVaultAPIClient(mode: .sessionDead)
    let unlocker = VaultUnlocker(
      apiClient: stubClient,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    )

    do {
      _ = try await unlocker.unlock(passphrase: "any-passphrase")
      XCTFail("Expected VaultUnlockError.sessionExpired")
    } catch VaultUnlockError.sessionExpired {
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

  // MARK: - unlockWithBiometrics graceful stale-cache degradation (C1)

  /// AC-C1.1: a STALE cache (issued 25h before `now`) must NOT throw — the unlock
  /// returns the recovered vault key with cacheRecovered=false + userId from the
  /// persisted wrapped-key metadata.
  func testUnlockWithBiometrics_staleCache_returnsCacheRecoveredFalse() async throws {
    let issuedAt = Date(timeIntervalSince1970: 1_000_000)
    let now = issuedAt.addingTimeInterval(25 * 3600)  // 25h later → stale (AND-gate met)
    let keychain = MockKeychainAccessor()
    let bks = BridgeKeyStore(accessGroup: "test.jp.jpng.passwd-sso.shared.stale", keychain: keychain)
    let blob = try bks.create()
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let vkBytes = vaultKey.withUnsafeBytes { Data($0) }
    let (c, i, t) = try encryptAESGCM(plaintext: vkBytes, key: cacheKey)
    try wks.saveVaultKey(
      WrappedVaultKey(ciphertext: c, iv: i, authTag: t, issuedAt: Date(), userId: "persisted-user"))
    let cacheURL = tmpDir.appending(path: "stale.cache", directoryHint: .notDirectory)
    let entry = try makePersonalCacheEntryForBiometricTest(
      vaultKey: vaultKey, userId: "cache-user", keyVersion: 3)
    try buildCacheFileForBiometricTest(
      at: cacheURL, entries: [entry], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: "cache-user", now: issuedAt)

    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .wrongPassphrase),
      bridgeKeyStore: bks, wrappedKeyStore: wks, cacheURL: cacheURL, now: { now })

    let result = try await unlocker.unlockWithBiometrics(reason: "test")
    XCTAssertFalse(result.cacheRecovered, "stale cache must degrade to cacheRecovered=false")
    XCTAssertEqual(result.userId, "persisted-user", "userId must come from persisted wrapped key")
    XCTAssertEqual(
      result.vaultKey.withUnsafeBytes { Data($0) }, vkBytes, "vault key still recovered")
  }

  /// AC-C1.2: a FRESH cache returns cacheRecovered=true with userId/keyVersion from
  /// the cache header (unchanged fast path).
  func testUnlockWithBiometrics_freshCache_returnsCacheRecoveredTrue() async throws {
    let now = Date()
    let keychain = MockKeychainAccessor()
    let bks = BridgeKeyStore(accessGroup: "test.jp.jpng.passwd-sso.shared.fresh", keychain: keychain)
    let blob = try bks.create()
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let vkBytes = vaultKey.withUnsafeBytes { Data($0) }
    let (c, i, t) = try encryptAESGCM(plaintext: vkBytes, key: cacheKey)
    try wks.saveVaultKey(
      WrappedVaultKey(ciphertext: c, iv: i, authTag: t, issuedAt: Date(), userId: "persisted-user"))
    let cacheURL = tmpDir.appending(path: "fresh.cache", directoryHint: .notDirectory)
    let entry = try makePersonalCacheEntryForBiometricTest(
      vaultKey: vaultKey, userId: "cache-user", keyVersion: 5)
    try buildCacheFileForBiometricTest(
      at: cacheURL, entries: [entry], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: "cache-user", now: now)

    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .wrongPassphrase),
      bridgeKeyStore: bks, wrappedKeyStore: wks, cacheURL: cacheURL, now: { now })

    let result = try await unlocker.unlockWithBiometrics(reason: "test")
    XCTAssertTrue(result.cacheRecovered, "fresh cache → cacheRecovered=true")
    XCTAssertEqual(result.userId, "cache-user", "userId from cache header on the fresh path")
    XCTAssertEqual(result.keyVersion, 5, "keyVersion from cache entry on the fresh path")
  }

  /// AC-C1.1 (counter-mismatch variant, T3): a cache whose counter no longer matches
  /// the (bumped) bridge-meta counter is rejected by readCacheFile with
  /// .counterMismatch → must ALSO degrade gracefully to cacheRecovered=false, NOT throw.
  func testUnlockWithBiometrics_counterMismatch_returnsCacheRecoveredFalse() async throws {
    let now = Date()
    let keychain = MockKeychainAccessor()
    let bks = BridgeKeyStore(accessGroup: "test.jp.jpng.passwd-sso.shared.counter", keychain: keychain)
    let blob = try bks.create()
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let vkBytes = vaultKey.withUnsafeBytes { Data($0) }
    let (c, i, t) = try encryptAESGCM(plaintext: vkBytes, key: cacheKey)
    try wks.saveVaultKey(
      WrappedVaultKey(ciphertext: c, iv: i, authTag: t, issuedAt: Date(), userId: "persisted-user"))
    let cacheURL = tmpDir.appending(path: "counter.cache", directoryHint: .notDirectory)
    let entry = try makePersonalCacheEntryForBiometricTest(
      vaultKey: vaultKey, userId: "cache-user", keyVersion: 1)
    // Seed the cache at the CURRENT counter, then bump the bridge-meta counter so the
    // biometric read's expectedCounter no longer matches the file.
    try buildCacheFileForBiometricTest(
      at: cacheURL, entries: [entry], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: "cache-user", now: now)
    try bks.incrementCounter(newCounter: blob.cacheVersionCounter + 1)

    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .wrongPassphrase),
      bridgeKeyStore: bks, wrappedKeyStore: wks, cacheURL: cacheURL, now: { now })

    let result = try await unlocker.unlockWithBiometrics(reason: "test")
    XCTAssertFalse(result.cacheRecovered, "counter mismatch must degrade gracefully, not throw")
    XCTAssertEqual(result.userId, "persisted-user")
  }

  /// AC-C1.3 / AC-C1.4: a legacy vault (persisted userId nil) with a STALE cache has
  /// no cacheless-sync source → throws .cacheUnreadable. After a userId is persisted
  /// (simulating one passphrase unlock), the same stale cache now degrades gracefully.
  func testUnlockWithBiometrics_legacyVaultStaleCache_throwsThenHeals() async throws {
    let issuedAt = Date(timeIntervalSince1970: 2_000_000)
    let now = issuedAt.addingTimeInterval(25 * 3600)
    let keychain = MockKeychainAccessor()
    let bks = BridgeKeyStore(accessGroup: "test.jp.jpng.passwd-sso.shared.legacy", keychain: keychain)
    let blob = try bks.create()
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let vkBytes = vaultKey.withUnsafeBytes { Data($0) }
    let (c, i, t) = try encryptAESGCM(plaintext: vkBytes, key: cacheKey)
    // Legacy: no userId on the wrapped key.
    try wks.saveVaultKey(
      WrappedVaultKey(ciphertext: c, iv: i, authTag: t, issuedAt: Date(), userId: nil))
    let cacheURL = tmpDir.appending(path: "legacy.cache", directoryHint: .notDirectory)
    let entry = try makePersonalCacheEntryForBiometricTest(
      vaultKey: vaultKey, userId: "cache-user", keyVersion: 1)
    try buildCacheFileForBiometricTest(
      at: cacheURL, entries: [entry], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: "cache-user", now: issuedAt)

    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .wrongPassphrase),
      bridgeKeyStore: bks, wrappedKeyStore: wks, cacheURL: cacheURL, now: { now })

    do {
      _ = try await unlocker.unlockWithBiometrics(reason: "test")
      XCTFail("legacy vault + stale cache must throw .cacheUnreadable")
    } catch VaultUnlockError.cacheUnreadable {
      // expected
    }

    // Heal: persist a userId (simulating one passphrase unlock), keep the stale cache.
    try wks.saveVaultKey(
      WrappedVaultKey(ciphertext: c, iv: i, authTag: t, issuedAt: Date(), userId: "backfilled-user"))
    let healed = try await unlocker.unlockWithBiometrics(reason: "test")
    XCTAssertFalse(healed.cacheRecovered)
    XCTAssertEqual(healed.userId, "backfilled-user", "post-backfill unlock recovers gracefully")
  }

  /// AC-C4.1: after a passphrase unlock, the persisted wrapped vault key carries the
  /// unlockData userId (C4 producer).
  func testUnlock_persistsUserIdOnWrappedVaultKey() async throws {
    let (unlockData, _) = try makeVaultUnlockData(passphrase: "p")
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .success(unlockData)),
      bridgeKeyStore: BridgeKeyStore(
        accessGroup: "test", service: "com.passwd-sso.test.c4.bridge-key", keychain: MockKeychain()),
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "c4.cache", directoryHint: .notDirectory))
    _ = try await unlocker.unlock(passphrase: "p")
    let persisted = try XCTUnwrap(try wks.loadVaultKey())
    XCTAssertEqual(persisted.userId, "test-user-42", "unlock must persist unlockData.userId")
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

  // MARK: - ECDH key persistence on passphrase unlock

  /// Passphrase unlock WITH ECDH fields → wrappedKeyStore.loadECDHPrivateKey() is
  /// non-nil and the blob unwraps back to the original PKCS#8 bytes.
  func testUnlock_withECDHFields_persistsECDHBlob() async throws {
    let passphrase = "ecdh-test-pass"
    let userId = "ecdh-user-persist"
    let (unlockData, _, memberKey) = try makeVaultUnlockDataWithECDH(
      passphrase: passphrase, userId: userId
    )

    let keychain = MockKeychain()
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.ecdh.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)

    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .success(unlockData)),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "ecdh.cache", directoryHint: .notDirectory)
    )

    let result = try await unlocker.unlock(passphrase: passphrase)

    // ECDH blob must be saved.
    let wrappedEcdh = try XCTUnwrap(try wks.loadECDHPrivateKey(),
      "ECDH key must be persisted after passphrase unlock when ECDH fields are present")

    // Unwrap it under the cacheKey with the correct userId AAD and verify bytes.
    let cacheKey = result.cacheKey
    let unwrapped = try XCTUnwrap(
      TeamEntryDecryptor.unwrapEcdhPrivateKey(wrappedEcdh, cacheKey: cacheKey, userId: userId),
      "Stored ECDH blob must unwrap under the cacheKey + userId AAD"
    )

    // The unwrapped PKCS#8 must re-import to the same key.
    let reimported = try P256.KeyAgreement.PrivateKey(derRepresentation: unwrapped)
    XCTAssertEqual(
      reimported.rawRepresentation,
      memberKey.rawRepresentation,
      "Unwrapped PKCS#8 must round-trip to the original member key"
    )
  }

  /// Passphrase unlock WITHOUT ECDH fields → no ECDH blob saved, but unlock succeeds.
  func testUnlock_withoutECDHFields_noECDHBlob() async throws {
    let passphrase = "no-ecdh-pass"
    let (unlockData, _) = try makeVaultUnlockData(passphrase: passphrase)
    // unlockData has no ECDH fields (ecdhPrivateKey* == nil by default).

    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.noecdh.bridge-key",
      keychain: MockKeychain()
    )

    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .success(unlockData)),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "noecdh.cache", directoryHint: .notDirectory)
    )

    let result = try await unlocker.unlock(passphrase: passphrase)

    XCTAssertNotNil(result.vaultKey, "unlock must succeed even without ECDH fields")
    XCTAssertNil(try wks.loadECDHPrivateKey(),
      "No ECDH blob must be saved when the server returns no ECDH fields")
  }

  /// Biometric path: ECDH blob is a no-op — existing blob untouched, unlock succeeds.
  func testUnlockWithBiometrics_ECDHIsNoOp() async throws {
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

    // Pre-seed an ECDH blob to verify it is left untouched by biometric unlock.
    let ecdhSentinel = WrappedECDHPrivateKey(
      ciphertext: Data([0xDE, 0xAD]),
      iv: Data(repeating: 0x11, count: 12),
      authTag: Data(repeating: 0x22, count: 16),
      issuedAt: Date()
    )
    try wks.saveECDHPrivateKey(ecdhSentinel)

    let cacheURL = tmpDir.appending(path: "biometric-ecdh.cache", directoryHint: .notDirectory)
    let entry = try makePersonalCacheEntryForBiometricTest(
      vaultKey: vaultKey, userId: "ecdh-bio-user", keyVersion: 1
    )
    try buildCacheFileForBiometricTest(
      at: cacheURL, entries: [entry], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: "ecdh-bio-user", now: Date()
    )

    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .wrongPassphrase),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      now: { Date() }
    )

    _ = try await unlocker.unlockWithBiometrics(reason: "test")

    // The ECDH blob must be unchanged — biometric path is a no-op for ECDH.
    let stored = try XCTUnwrap(try wks.loadECDHPrivateKey(),
      "Pre-seeded ECDH blob must still be present after biometric unlock")
    XCTAssertEqual(stored, ecdhSentinel,
      "Biometric unlock must not modify the existing ECDH blob")
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
