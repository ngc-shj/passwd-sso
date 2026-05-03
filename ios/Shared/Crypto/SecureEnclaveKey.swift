import Foundation
import CryptoKit
import Security

public enum SecureEnclaveKeyError: Error, Equatable {
  case keyGenerationFailed(OSStatus)
  case keyNotFound
  case keyDeletionFailed(OSStatus)
  case signingFailed(OSStatus)
  case publicKeyExportFailed
  case derConversionFailed
  case jwkThumbprintFailed
}

// Sign-only — Secure Enclave does not support ECDH (per plan S22).
// Reusing this key for ECDH is a forbidden future-misuse path.

/// Generate a P-256 DPoP signing key in the Secure Enclave.
public func generateDPoPKey(label: String) throws -> SecKey {
  var error: Unmanaged<CFError>?
  guard let accessControl = SecAccessControlCreateWithFlags(
    kCFAllocatorDefault,
    kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    .privateKeyUsage,
    &error
  ) else {
    throw SecureEnclaveKeyError.keyGenerationFailed(-1)
  }

  let attributes: [String: Any] = [
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrKeySizeInBits as String: 256,
    kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    kSecPrivateKeyAttrs as String: [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationLabel as String: label,
      kSecAttrLabel as String: label,
      kSecAttrAccessControl as String: accessControl,
    ] as [String: Any],
  ]

  guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
    throw SecureEnclaveKeyError.keyGenerationFailed(-1)
  }
  return key
}

/// Load an existing DPoP key from the Secure Enclave by label.
public func loadDPoPKey(label: String) throws -> SecKey {
  let query: [String: Any] = [
    kSecClass as String: kSecClassKey,
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrLabel as String: label,
    kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    kSecReturnRef as String: true,
  ]
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  guard status == errSecSuccess, let key = result else {
    throw SecureEnclaveKeyError.keyNotFound
  }
  // swiftlint:disable:next force_cast
  return (key as! SecKey)
}

/// Delete the DPoP key from the Secure Enclave.
public func deleteDPoPKey(label: String) throws {
  let query: [String: Any] = [
    kSecClass as String: kSecClassKey,
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrLabel as String: label,
    kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
  ]
  let status = SecItemDelete(query as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else {
    throw SecureEnclaveKeyError.keyDeletionFailed(status)
  }
}

/// Sign the JWS header+payload input using ECDSA-P256-SHA256.
/// Returns raw 64-byte r||s (JWS format), converting from DER.
public func signDPoP(key: SecKey, jwsHeaderPayloadInput: Data) throws -> Data {
  var error: Unmanaged<CFError>?
  guard let signature = SecKeyCreateSignature(
    key,
    .ecdsaSignatureMessageX962SHA256,
    jwsHeaderPayloadInput as CFData,
    &error
  ) as Data? else {
    throw SecureEnclaveKeyError.signingFailed(-1)
  }
  return try derToRawECDSA(signature)
}

/// Export the public key as a JWK dictionary with kty, crv, x, y fields.
public func exportPublicKeyJWK(key: SecKey) throws -> [String: String] {
  guard let publicKey = SecKeyCopyPublicKey(key) else {
    throw SecureEnclaveKeyError.publicKeyExportFailed
  }
  var error: Unmanaged<CFError>?
  guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
    throw SecureEnclaveKeyError.publicKeyExportFailed
  }
  // Uncompressed EC point: 0x04 || x(32) || y(32)
  guard data.count == 65, data[0] == 0x04 else {
    throw SecureEnclaveKeyError.publicKeyExportFailed
  }
  let x = data[1..<33]
  let y = data[33..<65]
  return [
    "kty": "EC",
    "crv": "P-256",
    "x": base64URLEncode(x),
    "y": base64URLEncode(y),
  ]
}

/// RFC 7638 JWK thumbprint: SHA-256 of canonical JSON (alphabetical keys), base64url no padding.
public func computeJWKThumbprint(jwk: [String: String]) throws -> String {
  guard let crv = jwk["crv"], let kty = jwk["kty"], let x = jwk["x"], let y = jwk["y"] else {
    throw SecureEnclaveKeyError.jwkThumbprintFailed
  }
  // Canonical JSON — alphabetical key order per RFC 7638
  let canonical = """
  {"crv":"\(crv)","kty":"\(kty)","x":"\(x)","y":"\(y)"}
  """
  guard let data = canonical.data(using: .utf8) else {
    throw SecureEnclaveKeyError.jwkThumbprintFailed
  }
  let digest = SHA256.hash(data: data)
  return base64URLEncode(Data(digest))
}

// MARK: - DER → raw r||s conversion

/// Convert X9.62 DER-encoded ECDSA signature to raw 64-byte r||s for JWS.
private func derToRawECDSA(_ der: Data) throws -> Data {
  var idx = 0
  let bytes = [UInt8](der)

  func readByte() throws -> UInt8 {
    guard idx < bytes.count else { throw SecureEnclaveKeyError.derConversionFailed }
    defer { idx += 1 }
    return bytes[idx]
  }

  func readLength() throws -> Int {
    let first = Int(try readByte())
    if first < 0x80 { return first }
    let lenBytes = first & 0x7F
    var len = 0
    for _ in 0..<lenBytes { len = (len << 8) | Int(try readByte()) }
    return len
  }

  func readBigInt() throws -> Data {
    guard try readByte() == 0x02 else { throw SecureEnclaveKeyError.derConversionFailed }
    let len = try readLength()
    guard idx + len <= bytes.count else { throw SecureEnclaveKeyError.derConversionFailed }
    defer { idx += len }
    var intBytes = Data(bytes[idx..<(idx + len)])
    // Strip leading zero padding for sign-extension
    while intBytes.count > 32, intBytes.first == 0x00 { intBytes = intBytes.dropFirst() }
    // Left-pad to 32 bytes
    while intBytes.count < 32 { intBytes.insert(0x00, at: intBytes.startIndex) }
    guard intBytes.count == 32 else { throw SecureEnclaveKeyError.derConversionFailed }
    return intBytes
  }

  // SEQUENCE
  guard try readByte() == 0x30 else { throw SecureEnclaveKeyError.derConversionFailed }
  _ = try readLength()
  let r = try readBigInt()
  let s = try readBigInt()
  return r + s
}
