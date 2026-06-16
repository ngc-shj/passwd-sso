import Foundation

/// AES-256-GCM wire and key parameters. Values match crypto-client.ts /
/// AESGCM.swift wire format and MUST stay byte-identical with the parent server.
public enum CryptoParams {
  // AES-256-GCM wire parameters (match crypto-client.ts / AESGCM.swift wire format)
  public static let aesGCMNonceByteCount = 12   // IV length
  public static let aesGCMTagByteCount = 16     // auth tag length
  // 256-bit symmetric key material expressed in bytes (AES-256 key, HKDF/PBKDF2 output)
  public static let symmetricKeyByteCount = 32
}

/// P-256 (secp256r1) point and key parameters.
public enum P256Params {
  public static let coordinateByteCount = 32                 // JWK x / y length, scalar length
  public static let keySizeBits = 256                        // SecKey kSecAttrKeySizeInBits
  // uncompressed EC point: 0x04 ‖ x(32) ‖ y(32)
  public static let uncompressedPointPrefix: UInt8 = 0x04
  public static let uncompressedPointByteCount = 1 + coordinateByteCount + coordinateByteCount  // 65
}
