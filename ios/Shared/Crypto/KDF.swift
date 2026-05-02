import Foundation
import CryptoKit
import CommonCrypto

// HKDF info strings — must match crypto-client.ts constants exactly.
private let hkdfEncInfo = "passwd-sso-enc-v1"
private let hkdfAuthInfo = "passwd-sso-auth-v1"
// Cache vault key — used only on iOS device (no server-side equivalent).
private let hkdfCacheInfo = "passwd-sso-cache-v1"
private let hkdfZeroSalt = Data(repeating: 0, count: 32)

/// Derive a 256-bit wrapping key from passphrase + salt using PBKDF2-SHA256.
/// iterations defaults to 600,000 to match the parent server-side value.
public func deriveWrappingKeyPBKDF2(
  passphrase: String,
  salt: Data,
  iterations: Int = 600_000
) throws -> SymmetricKey {
  guard let passphraseData = passphrase.data(using: .utf8) else {
    throw KDFError.invalidPassphrase
  }

  var derivedKey = Data(repeating: 0, count: 32)
  let status = derivedKey.withUnsafeMutableBytes { derivedKeyPtr in
    passphraseData.withUnsafeBytes { passphrasePtr in
      salt.withUnsafeBytes { saltPtr in
        CCKeyDerivationPBKDF(
          CCPBKDFAlgorithm(kCCPBKDF2),
          passphrasePtr.baseAddress, passphraseData.count,
          saltPtr.baseAddress, salt.count,
          CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
          UInt32(iterations),
          derivedKeyPtr.baseAddress, 32
        )
      }
    }
  }
  guard status == kCCSuccess else {
    throw KDFError.pbkdf2Failed(status: status)
  }
  return SymmetricKey(data: derivedKey)
}

/// Derive AES-256-GCM encryption key from secret key via HKDF-SHA256.
/// info = "passwd-sso-enc-v1", salt = zero 32 bytes (per crypto-client.ts).
public func deriveEncryptionKey(secretKey: Data) throws -> SymmetricKey {
  let inputKey = SymmetricKey(data: secretKey)
  let info = hkdfEncInfo.data(using: .utf8)!
  return HKDF<SHA256>.deriveKey(
    inputKeyMaterial: inputKey,
    salt: hkdfZeroSalt,
    info: info,
    outputByteCount: 32
  )
}

/// Derive auth key from secret key via HKDF-SHA256.
/// info = "passwd-sso-auth-v1", salt = zero 32 bytes (per crypto-client.ts).
/// Returns 32 bytes of raw key material.
public func deriveAuthKey(secretKey: Data) throws -> Data {
  let inputKey = SymmetricKey(data: secretKey)
  let info = hkdfAuthInfo.data(using: .utf8)!
  let derived = HKDF<SHA256>.deriveKey(
    inputKeyMaterial: inputKey,
    salt: hkdfZeroSalt,
    info: info,
    outputByteCount: 32
  )
  return derived.withUnsafeBytes { Data($0) }
}

/// Derive the cache-encryption key from the bridge_key.
/// HKDF-SHA256(IKM=bridge_key, salt=zero32, info="passwd-sso-cache-v1") → 32 bytes → AES-256 key.
public func deriveCacheVaultKey(bridgeKey: Data) throws -> SymmetricKey {
  let inputKey = SymmetricKey(data: bridgeKey)
  let info = hkdfCacheInfo.data(using: .utf8)!
  return HKDF<SHA256>.deriveKey(
    inputKeyMaterial: inputKey,
    salt: hkdfZeroSalt,
    info: info,
    outputByteCount: 32
  )
}

public enum KDFError: Error, Equatable {
  case invalidPassphrase
  case pbkdf2Failed(status: Int32)
}
