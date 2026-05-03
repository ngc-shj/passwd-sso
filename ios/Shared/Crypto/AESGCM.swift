import Foundation
import CryptoKit

/// Wire format for encrypted data (hex-encoded fields), matching parent crypto-client.ts shape.
public struct EncryptedData: Codable, Sendable, Equatable {
  public let ciphertext: String  // hex
  public let iv: String          // hex, 12 bytes
  public let authTag: String     // hex, 16 bytes

  public init(ciphertext: String, iv: String, authTag: String) {
    self.ciphertext = ciphertext
    self.iv = iv
    self.authTag = authTag
  }
}

/// Encrypt plaintext with AES-256-GCM, optional AAD.
/// Returns raw (ciphertext, iv, tag) byte-level output.
public func encryptAESGCM(
  plaintext: Data,
  key: SymmetricKey,
  aad: Data? = nil
) throws -> (ciphertext: Data, iv: Data, tag: Data) {
  let nonce = AES.GCM.Nonce()
  let nonceData = Data(nonce)
  guard nonceData.count == 12 else {
    throw AESGCMError.unexpectedNonceLength
  }

  let sealedBox: AES.GCM.SealedBox
  if let aad {
    sealedBox = try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: aad)
  } else {
    sealedBox = try AES.GCM.seal(plaintext, using: key, nonce: nonce)
  }

  // CryptoKit's SealedBox properties may return Data slices with non-zero startIndex
  // on iOS 18+. Normalize via Data(...) so callers can use [Int] subscripts safely.
  return (
    ciphertext: Data(sealedBox.ciphertext),
    iv: nonceData,
    tag: Data(sealedBox.tag)
  )
}

/// Decrypt AES-256-GCM ciphertext; throws on auth failure or AAD mismatch.
public func decryptAESGCM(
  ciphertext: Data,
  iv: Data,
  tag: Data,
  key: SymmetricKey,
  aad: Data? = nil
) throws -> Data {
  guard iv.count == 12 else { throw AESGCMError.invalidIVLength }
  guard tag.count == 16 else { throw AESGCMError.invalidTagLength }

  let nonce = try AES.GCM.Nonce(data: iv)
  let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)

  if let aad {
    return try AES.GCM.open(sealedBox, using: key, authenticating: aad)
  } else {
    return try AES.GCM.open(sealedBox, using: key)
  }
}

/// Hex-encoded variant matching the parent's EncryptedData wire format.
public func encryptAESGCMEncoded(
  plaintext: Data,
  key: SymmetricKey,
  aad: Data? = nil
) throws -> EncryptedData {
  let (ciphertext, iv, tag) = try encryptAESGCM(plaintext: plaintext, key: key, aad: aad)
  return EncryptedData(
    ciphertext: hexEncode(ciphertext),
    iv: hexEncode(iv),
    authTag: hexEncode(tag)
  )
}

/// Hex-decoded variant: decode EncryptedData then decrypt.
public func decryptAESGCMEncoded(
  encrypted: EncryptedData,
  key: SymmetricKey,
  aad: Data? = nil
) throws -> Data {
  let ciphertext = try hexDecode(encrypted.ciphertext)
  let iv = try hexDecode(encrypted.iv)
  let tag = try hexDecode(encrypted.authTag)
  return try decryptAESGCM(ciphertext: ciphertext, iv: iv, tag: tag, key: key, aad: aad)
}

public enum AESGCMError: Error, Equatable {
  case unexpectedNonceLength
  case invalidIVLength
  case invalidTagLength
  case decryptionFailed
}
