import CryptoKit
import Foundation
import Shared

public enum VaultUnlockError: Error, Equatable {
  case invalidPassphrase
  case serverResponseInvalid
  case bridgeKeyCreationFailed
  case cryptoFailed
}

/// Result of a successful vault unlock; carries the in-memory vault key and the
/// userId needed for AAD construction on personal entries (aadVersion >= 1).
public struct UnlockResult: Sendable, Equatable {
  public let vaultKey: SymmetricKey
  public let userId: String
}

/// Source of the encrypted vault-unlock material. `MobileAPIClient` is the
/// production conformer (`GET /api/vault/unlock/data`); tests inject a stub so
/// the REAL `VaultUnlocker` crypto path (hex decode, PBKDF2, AES-GCM) is
/// exercised without a network call.
public protocol VaultUnlockDataSource: Sendable {
  func fetchVaultUnlockData() async throws -> VaultUnlockData
}

/// Orchestrates the vault unlock flow:
///   1. Fetch /api/vault/unlock/data with the host's access token.
///   2. Derive wrapping key from passphrase + accountSalt + kdfIterations.
///   3. Decrypt encryptedSecretKey → secretKey (32 bytes).
///   4. Derive vault_key = HKDF(secretKey, info="passwd-sso-enc-v1").
///   5. Generate fresh bridge_key + non-zero counter + host_install_uuid; persist via BridgeKeyStore.
///   6. Encrypt vault_key under bridge_key via deriveCacheVaultKey. Store as WrappedVaultKey.
///   7. Returns the in-memory vault_key (never persisted plain).
public actor VaultUnlocker {
  private let apiClient: any VaultUnlockDataSource
  private let bridgeKeyStore: BridgeKeyStore
  private let wrappedKeyStore: WrappedKeyStore

  public init(
    apiClient: any VaultUnlockDataSource,
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore
  ) {
    self.apiClient = apiClient
    self.bridgeKeyStore = bridgeKeyStore
    self.wrappedKeyStore = wrappedKeyStore
  }

  /// Perform the unlock flow. Returns vault_key + userId on success.
  /// The vault_key is never persisted; caller must zero it after use.
  public func unlock(passphrase: String) async throws -> UnlockResult {
    // Step 1: fetch vault unlock data
    let unlockData: VaultUnlockData
    do {
      unlockData = try await apiClient.fetchVaultUnlockData()
    } catch MobileAPIError.serverError(let status) where status == 401 {
      throw VaultUnlockError.invalidPassphrase
    } catch {
      throw VaultUnlockError.serverResponseInvalid
    }

    // Step 1b: this client only derives the PBKDF2 (kdfType 0) wrapping key.
    // An Argon2id vault (kdfType 1) would silently derive a wrong key and
    // surface as a misleading "invalid passphrase"; fail with a clear error
    // instead so the caller can distinguish "unsupported vault KDF" from a
    // genuine passphrase mistake.
    guard unlockData.kdfType == 0 else {
      throw VaultUnlockError.serverResponseInvalid
    }

    // Step 2: decode salt and derive wrapping key. The server stores these
    // fields as hex (matching the web crypto-client), NOT base64.
    let saltData: Data
    do {
      saltData = try hexDecode(unlockData.accountSalt)
    } catch {
      throw VaultUnlockError.serverResponseInvalid
    }

    let wrappingKey: SymmetricKey
    do {
      wrappingKey = try deriveWrappingKeyPBKDF2(
        passphrase: passphrase,
        salt: saltData,
        iterations: unlockData.kdfIterations
      )
    } catch {
      throw VaultUnlockError.cryptoFailed
    }

    // Step 3: decrypt encryptedSecretKey (hex-encoded fields, see Step 2).
    let encKeyCipher: Data
    let encKeyIV: Data
    let encKeyTag: Data
    do {
      encKeyCipher = try hexDecode(unlockData.encryptedSecretKey)
      encKeyIV = try hexDecode(unlockData.secretKeyIv)
      encKeyTag = try hexDecode(unlockData.secretKeyAuthTag)
    } catch {
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

    // Step 4: derive vault_key from secretKey
    let vaultKey: SymmetricKey
    do {
      vaultKey = try deriveEncryptionKey(secretKey: secretKey)
    } catch {
      throw VaultUnlockError.cryptoFailed
    }

    // Step 5: generate fresh bridge_key blob and persist
    let blob: BridgeKeyStore.Blob
    do {
      blob = try bridgeKeyStore.create()
    } catch {
      throw VaultUnlockError.bridgeKeyCreationFailed
    }

    // Step 6: encrypt vault_key under bridge_key (using cache vault key derivation)
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

    // Step 7: return in-memory vault_key + userId
    return UnlockResult(vaultKey: vaultKey, userId: unlockData.userId)
  }
}
