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
  iterations: Int = 1
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
    keyVersion: 1,
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
