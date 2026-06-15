import CryptoKit
import Foundation
import Shared

public enum VaultUnlockError: Error, Equatable {
  case invalidPassphrase
  case serverResponseInvalid
  case bridgeKeyCreationFailed
  case cryptoFailed
  /// Biometric re-unlock requested but no wrapped vault key or bridge_key found.
  case biometricUnavailable
  /// LAContext / keychain biometry error during re-unlock.
  case biometricFailed
  /// Vault key recovered via biometrics but cache header userId is missing/empty.
  case cacheUnreadable
}

/// Result of a successful vault unlock; carries the in-memory vault key, the
/// userId needed for AAD construction on personal entries (aadVersion >= 1),
/// and the live keyVersion from the server unlock data.
public struct UnlockResult: Sendable, Equatable {
  public let vaultKey: SymmetricKey
  public let userId: String
  public let keyVersion: Int
  /// Tenant-enforced auto-lock minutes from the passphrase unlock's fresh policy
  /// fetch; nil from the biometric/offline path (which reuses the persisted value).
  /// NOT defaulted — both construction sites must state it explicitly.
  public let tenantAutoLockMinutes: Int?
  /// The REAL cacheKey (HKDF of the actual bridge_key), captured at unlock when the
  /// bridge_key is in hand. Required for team-key wrap/unwrap + in-app team decrypt —
  /// `readDirect()` returns an EMPTY bridge_key, so cacheKey CANNOT be re-derived
  /// later without a biometric `readForFill`. Thread this from unlock instead.
  public let cacheKey: SymmetricKey
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
  private let cacheURL: URL
  private let now: @Sendable () -> Date

  public init(
    apiClient: any VaultUnlockDataSource,
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore,
    cacheURL: URL,
    now: @Sendable @escaping () -> Date = { Date() }
  ) {
    self.apiClient = apiClient
    self.bridgeKeyStore = bridgeKeyStore
    self.wrappedKeyStore = wrappedKeyStore
    self.cacheURL = cacheURL
    self.now = now
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

    // The server pins PBKDF2 at 600k iterations (crypto-client.ts). Enforce
    // that as a floor: a MITM'd or rogue server sending e.g. `1` would
    // silently reduce the wrapping key to a single hash, making offline
    // brute-force of the passphrase trivial against captured key material.
    guard unlockData.kdfIterations >= pbkdf2Iterations else {
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

    // Step 6b: if the account has an ECDH keypair (team E2E), unwrap it with the
    // secretKey and re-persist it wrapped under cacheKey (bound to userId), so
    // sync (incl. background / post-biometric) can derive team keys without the
    // secretKey. Best-effort: a failure here must never block unlocking the vault.
    if let encPriv = unlockData.encryptedEcdhPrivateKey,
       let ivHex = unlockData.ecdhPrivateKeyIv,
       let tagHex = unlockData.ecdhPrivateKeyAuthTag {
      do {
        let wrappingKey = TeamKeyCrypto.deriveEcdhWrappingKey(
          secretKey: SymmetricKey(data: secretKey))
        let ecdhKey = try TeamKeyCrypto.unwrapEcdhPrivateKey(
          encrypted: EncryptedData(ciphertext: encPriv, iv: ivHex, authTag: tagHex),
          wrappingKey: wrappingKey)
        var pkcs8 = ecdhKey.derRepresentation
        defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }
        let wrappedEcdh = try TeamEntryDecryptor.wrapEcdhPrivateKey(
          pkcs8: pkcs8, cacheKey: cacheKey, userId: unlockData.userId, issuedAt: Date())
        try wrappedKeyStore.saveECDHPrivateKey(wrappedEcdh)
      } catch {
        // Non-fatal: team entries simply won't be available until a later unlock.
      }
    }

    // Step 7: return in-memory vault_key + userId + live keyVersion
    return UnlockResult(
      vaultKey: vaultKey,
      userId: unlockData.userId,
      keyVersion: unlockData.keyVersion,
      tenantAutoLockMinutes: unlockData.vaultAutoLockMinutes,
      cacheKey: cacheKey
    )
  }

  /// Re-unlock the vault biometrically without a network round-trip.
  ///
  /// Sequence: biometric bridge_key read → derive cache vault key → decrypt wrapped vault key
  /// → read encrypted cache to recover userId + keyVersion → return UnlockResult.
  /// Throws `.biometricFailed` on LAContext/keychain errors, `.biometricUnavailable` when
  /// the wrapped key is absent, `.cacheUnreadable` when the cache header userId is empty.
  public func unlockWithBiometrics(reason: String) async throws -> UnlockResult {
    // Step 1: biometric read of bridge_key
    let blob: BridgeKeyStore.Blob
    do {
      blob = try bridgeKeyStore.readForFill(reason: reason)
    } catch BridgeKeyStore.Error.biometryFailed {
      throw VaultUnlockError.biometricFailed
    } catch BridgeKeyStore.Error.notFound {
      throw VaultUnlockError.biometricUnavailable
    }

    // Step 2: derive the cache vault key from bridge_key
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)

    // Step 3: load the wrapped vault key
    guard let wrappedKey = try wrappedKeyStore.loadVaultKey() else {
      throw VaultUnlockError.biometricUnavailable
    }

    // Step 4: decrypt wrapped vault key to recover vault_key bytes
    var vaultKeyData = try decryptAESGCM(
      ciphertext: wrappedKey.ciphertext,
      iv: wrappedKey.iv,
      tag: wrappedKey.authTag,
      key: cacheKey
    )
    defer { zeroData(&vaultKeyData) }

    let vaultKey = SymmetricKey(data: vaultKeyData)

    // Step 5: read encrypted cache to recover userId and keyVersion
    let cache = try readCacheFile(
      path: cacheURL,
      vaultKey: vaultKey,
      expectedHostInstallUUID: blob.hostInstallUUID,
      expectedCounter: blob.cacheVersionCounter,
      now: now()
    )

    // Guard against empty userId — would silently corrupt personal-entry AAD
    guard !cache.header.userId.isEmpty else {
      throw VaultUnlockError.cacheUnreadable
    }

    // Step 6: recover keyVersion from the first personal entry in the cache
    let entries = (try? JSONDecoder().decode([CacheEntry].self, from: cache.entries)) ?? []
    let keyVersion = max(1, entries.first(where: { $0.teamId == nil })?.keyVersion ?? 1)

    // Biometric/offline path: no fresh policy fetch — pass nil so the persisted
    // tenant value is reused (RootView applies it non-authoritatively).
    return UnlockResult(
      vaultKey: vaultKey,
      userId: cache.header.userId,
      keyVersion: keyVersion,
      tenantAutoLockMinutes: nil,
      cacheKey: cacheKey
    )
  }

  /// Returns true when biometric re-unlock is likely available:
  /// bridge_key meta is present (non-zero counter) AND wrapped vault key is stored.
  /// Uses only the no-ACL meta read — no biometric prompt is triggered.
  public nonisolated func biometricUnlockAvailable() -> Bool {
    let counterNonZero = ((try? bridgeKeyStore.readDirect())?.cacheVersionCounter ?? 0) != 0
    guard counterNonZero else { return false }
    return (try? wrappedKeyStore.loadVaultKey()) != nil
  }

  // MARK: - Private helpers

  private func zeroData(_ data: inout Data) {
    _ = data.withUnsafeMutableBytes { ptr in
      ptr.initializeMemory(as: UInt8.self, repeating: 0)
    }
  }
}
