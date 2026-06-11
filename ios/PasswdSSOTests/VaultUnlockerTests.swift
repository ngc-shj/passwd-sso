import CryptoKit
import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

// MARK: - Mock VaultUnlockData provider

/// Simulates a vault unlock by providing pre-computed encrypted key material.
/// The test creates real PBKDF2 + AES-GCM material so the full crypto path is exercised.
private func makeVaultUnlockData(
  passphrase: String,
  iterations: Int = 1,
  keyVersion: Int = 1
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
    userId: "test-user-42"
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
      wrappedKeyStore: wks
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
      wrappedKeyStore: wks
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
      wrappedKeyStore: wks
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
      wrappedKeyStore: wks
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
      wrappedKeyStore: TempDirWrappedKeyStore(baseDir: tmpDir)
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
      wrappedKeyStore: wks
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
      service: "com.passwd-sso.test.bridge-key-kv",
      keychain: MockKeychain()
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let unlocker = VaultUnlocker(
      apiClient: StubVaultAPIClient(mode: .success(unlockData)),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks
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
      wrappedKeyStore: wks
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
}
