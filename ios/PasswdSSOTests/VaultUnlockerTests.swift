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

  let data = VaultUnlockData(
    accountSalt: saltData.base64EncodedString(),
    encryptedSecretKey: cipher.base64EncodedString(),
    secretKeyIv: iv.base64EncodedString(),
    secretKeyAuthTag: tag.base64EncodedString(),
    keyVersion: 1,
    kdfType: "PBKDF2-SHA256",
    kdfIterations: iterations,
    userId: "test-user-42"
  )
  return (data, secretKey)
}

// MARK: - Stub API client that returns VaultUnlockData without network

private actor StubVaultAPIClient {
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

// MARK: - VaultUnlocker that injects a stub API client

/// A testable VaultUnlocker that bypasses MobileAPIClient.
private actor StubVaultUnlocker {
  private let stubClient: StubVaultAPIClient
  private let bridgeKeyStore: BridgeKeyStore
  private let wrappedKeyStore: WrappedKeyStore

  init(
    stubClient: StubVaultAPIClient,
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore
  ) {
    self.stubClient = stubClient
    self.bridgeKeyStore = bridgeKeyStore
    self.wrappedKeyStore = wrappedKeyStore
  }

  func unlock(passphrase: String) async throws -> UnlockResult {
    let unlockData: VaultUnlockData
    do {
      unlockData = try await stubClient.fetchVaultUnlockData()
    } catch MobileAPIError.serverError(let status) where status == 401 {
      throw VaultUnlockError.invalidPassphrase
    } catch {
      throw VaultUnlockError.serverResponseInvalid
    }

    guard let saltData = Data(base64Encoded: unlockData.accountSalt) else {
      throw VaultUnlockError.serverResponseInvalid
    }

    let wrappingKey = try deriveWrappingKeyPBKDF2(
      passphrase: passphrase,
      salt: saltData,
      iterations: unlockData.kdfIterations
    )

    guard
      let encKeyCipher = Data(base64Encoded: unlockData.encryptedSecretKey),
      let encKeyIV = Data(base64Encoded: unlockData.secretKeyIv),
      let encKeyTag = Data(base64Encoded: unlockData.secretKeyAuthTag)
    else {
      throw VaultUnlockError.serverResponseInvalid
    }

    let secretKey: Data
    do {
      secretKey = try decryptAESGCM(
        ciphertext: encKeyCipher,
        iv: encKeyIV,
        tag: encKeyTag,
        key: wrappingKey
      )
    } catch {
      throw VaultUnlockError.invalidPassphrase
    }

    let vaultKey = try deriveEncryptionKey(secretKey: secretKey)
    let blob = try bridgeKeyStore.create()
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKeyBytes = vaultKey.withUnsafeBytes { Data($0) }
    let (cipher, iv, tag) = try encryptAESGCM(plaintext: vaultKeyBytes, key: cacheKey)

    let wrapped = WrappedVaultKey(
      ciphertext: cipher,
      iv: iv,
      authTag: tag,
      issuedAt: Date()
    )
    try wrappedKeyStore.saveVaultKey(wrapped)
    return UnlockResult(vaultKey: vaultKey, userId: unlockData.userId)
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
    let unlocker = StubVaultUnlocker(
      stubClient: stubClient,
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
    let unlocker = StubVaultUnlocker(
      stubClient: stubClient,
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
    let unlocker = StubVaultUnlocker(
      stubClient: stubClient,
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
    let unlocker = StubVaultUnlocker(
      stubClient: stubClient,
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

  func testServerReturns401throwsInvalidPassphrase() async {
    let keychain = MockKeychain()
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)

    let stubClient = StubVaultAPIClient(mode: .wrongPassphrase)
    let unlocker = StubVaultUnlocker(
      stubClient: stubClient,
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
