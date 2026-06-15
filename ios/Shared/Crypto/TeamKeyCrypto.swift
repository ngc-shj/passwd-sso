import CryptoKit
import Foundation

/// Team-key crypto, mirroring the browser extension's `crypto-team.ts` so iOS can
/// decrypt team entries. Verified byte-for-byte by golden vectors (TeamKeyCryptoTests).
///
/// Derivation chain (read/decrypt side only):
///   secretKey → HKDF("passwd-sso-ecdh-v1", salt=zero32) → ecdhWrappingKey → AES-GCM → ECDH private key
///   ECDH(member, ephemeral) → HKDF("passwd-sso-team-v1", salt=memberKey.hkdfSalt) → AES-GCM(AAD "OK") → rawTeamKey
///   rawTeamKey → HKDF("passwd-sso-team-enc-v1", salt=zero32) → teamEncKey (entry decryption key)
public enum TeamKeyCrypto {
  private static let zeroSalt = Data(repeating: 0, count: 32)
  private static let ecdhWrapInfo = "passwd-sso-ecdh-v1"
  private static let teamWrapInfo = "passwd-sso-team-v1"
  private static let teamEncInfo = "passwd-sso-team-enc-v1"
  private static let itemEncInfo = "passwd-sso-item-enc-v1"

  public enum TeamKeyCryptoError: Error, Equatable {
    case unsupportedKeyType
    case malformedPublicKey
  }

  /// HKDF(secretKey, salt=zero32, info="passwd-sso-ecdh-v1") → 32-byte AES key
  /// that wraps the account ECDH private key.
  public static func deriveEcdhWrappingKey(secretKey: SymmetricKey) -> SymmetricKey {
    HKDF<SHA256>.deriveKey(
      inputKeyMaterial: secretKey,
      salt: zeroSalt,
      info: Data(ecdhWrapInfo.utf8),
      outputByteCount: 32
    )
  }

  /// Decrypt the wrapped account ECDH private key (PKCS#8, no AAD) and import it.
  /// Returns the imported key directly; the intermediate PKCS#8 bytes are zeroized.
  public static func unwrapEcdhPrivateKey(
    encrypted: EncryptedData,
    wrappingKey: SymmetricKey
  ) throws -> P256.KeyAgreement.PrivateKey {
    var pkcs8 = try decryptAESGCM(
      ciphertext: try hexDecode(encrypted.ciphertext),
      iv: try hexDecode(encrypted.iv),
      tag: try hexDecode(encrypted.authTag),
      key: wrappingKey
    )
    defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }
    return try importEcdhPrivateKey(pkcs8: pkcs8)
  }

  /// Import a PKCS#8 DER ECDH private key. CryptoKit's `derRepresentation`
  /// accepts PKCS#8 PrivateKeyInfo (what WebCrypto exports via "pkcs8").
  public static func importEcdhPrivateKey(pkcs8: Data) throws -> P256.KeyAgreement.PrivateKey {
    try P256.KeyAgreement.PrivateKey(derRepresentation: pkcs8)
  }

  /// Import an ephemeral P-256 public key from a JWK string `{kty,crv,x,y}`.
  static func importEphemeralPublicKey(jwk: String) throws -> P256.KeyAgreement.PublicKey {
    struct JWK: Decodable { let kty: String; let crv: String; let x: String; let y: String }
    guard let data = jwk.data(using: .utf8),
          let key = try? JSONDecoder().decode(JWK.self, from: data)
    else { throw TeamKeyCryptoError.malformedPublicKey }
    guard key.kty == "EC", key.crv == "P-256" else {
      throw TeamKeyCryptoError.unsupportedKeyType
    }
    guard let x = base64URLDecode(key.x), x.count == 32,
          let y = base64URLDecode(key.y), y.count == 32
    else { throw TeamKeyCryptoError.malformedPublicKey }
    var x963 = Data([0x04])
    x963.append(x)
    x963.append(y)
    return try P256.KeyAgreement.PublicKey(x963Representation: x963)
  }

  /// ECDH(member, ephemeral) → HKDF("passwd-sso-team-v1", salt) → AES-GCM decrypt
  /// (AAD = team-key-wrap "OK") → raw team symmetric key.
  public static func unwrapTeamKey(
    encrypted: EncryptedData,
    ephemeralPublicKeyJWK: String,
    memberPrivateKey: P256.KeyAgreement.PrivateKey,
    hkdfSalt: String,
    teamId: String,
    toUserId: String,
    keyVersion: Int,
    wrapVersion: Int
  ) throws -> SymmetricKey {
    let ephemeral = try importEphemeralPublicKey(jwk: ephemeralPublicKeyJWK)
    let shared = try memberPrivateKey.sharedSecretFromKeyAgreement(with: ephemeral)
    // Raw ECDH Z (x-coordinate, 32 bytes) — matches WebCrypto deriveBits(256).
    // The shared secret is the most sensitive intermediate; zeroize the heap copy.
    var sharedBytes = shared.withUnsafeBytes { Data($0) }
    defer { sharedBytes.resetBytes(in: 0..<sharedBytes.count) }
    let wrappingKey = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: SymmetricKey(data: sharedBytes),
      salt: try hexDecode(hkdfSalt),
      info: Data(teamWrapInfo.utf8),
      outputByteCount: 32
    )
    let aad = try buildTeamKeyWrapAAD(
      teamId: teamId, toUserId: toUserId, keyVersion: keyVersion, wrapVersion: wrapVersion
    )
    let raw = try decryptAESGCM(
      ciphertext: try hexDecode(encrypted.ciphertext),
      iv: try hexDecode(encrypted.iv),
      tag: try hexDecode(encrypted.authTag),
      key: wrappingKey,
      aad: aad
    )
    return SymmetricKey(data: raw)
  }

  /// HKDF(rawTeamKey, salt=zero32, info="passwd-sso-team-enc-v1") → the key team
  /// entries are actually encrypted under (and the value persisted in WrappedTeamKey).
  public static func deriveTeamEncryptionKey(rawTeamKey: SymmetricKey) -> SymmetricKey {
    HKDF<SHA256>.deriveKey(
      inputKeyMaterial: rawTeamKey,
      salt: zeroSalt,
      info: Data(teamEncInfo.utf8),
      outputByteCount: 32
    )
  }

  /// HKDF(itemKey, salt=zero32, info="passwd-sso-item-enc-v1") → the per-entry
  /// encryption key for team entries with itemKeyVersion >= 1. The unwrapped raw
  /// ItemKey is NOT used directly — this HKDF step is required (mirrors the
  /// extension's deriveItemEncryptionKey).
  public static func deriveItemEncryptionKey(itemKey: SymmetricKey) -> SymmetricKey {
    HKDF<SHA256>.deriveKey(
      inputKeyMaterial: itemKey,
      salt: zeroSalt,
      info: Data(itemEncInfo.utf8),
      outputByteCount: 32
    )
  }

  private static func base64URLDecode(_ s: String) -> Data? {
    var b64 = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let rem = b64.count % 4
    if rem != 0 { b64 += String(repeating: "=", count: 4 - rem) }
    return Data(base64Encoded: b64)
  }
}
