import Foundation

// SubjectPublicKeyInfo DER for P-256 (secp256r1), total 91 bytes:
// 30 59         SEQUENCE (89 bytes)
//   30 13       SEQUENCE (19 bytes) — AlgorithmIdentifier
//     06 07 2A 86 48 CE 3D 02 01   OID id-ecPublicKey (7 bytes)
//     06 08 2A 86 48 CE 3D 03 01 07 OID secp256r1 (8 bytes)
//   03 42 00    BIT STRING (66 bytes, 0 unused bits)
//     04 <X:32> <Y:32>             uncompressed EC point (65 bytes)
//
// The trailing 0x04 is the first byte of the BIT STRING content (uncompressed point marker).
// The full uncompressed point (0x04 || X || Y) from SecKeyCopyExternalRepresentation is
// appended directly after this 26-byte prefix, giving 26 + 65 = 91 bytes total.
private let p256SPKIPrefix: [UInt8] = [
  0x30, 0x59,
  0x30, 0x13,
  0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
  0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07,
  0x03, 0x42, 0x00,
  // 0x04 is NOT here — it is the first byte of the uncompressed point argument.
]

/// Encode an uncompressed P-256 public key point (0x04 || X:32 || Y:32) as SPKI DER.
///
/// The server's `/api/mobile/authorize` and `/api/mobile/token` routes expect
/// the device_pubkey as base64url(SPKI-DER). This function produces the 91-byte DER
/// from the raw 65-byte uncompressed point exported by `SecKeyCopyExternalRepresentation`.
public func encodeP256SPKI(uncompressedPoint: Data) throws -> Data {
  // Expect 0x04 || X(32) || Y(32) = 65 bytes.
  let startIdx = uncompressedPoint.startIndex
  guard uncompressedPoint.count == 65,
        uncompressedPoint[startIdx] == 0x04
  else {
    throw SPKIEncoderError.invalidPoint
  }
  var der = Data(p256SPKIPrefix)
  der.append(uncompressedPoint)
  return der
}

public enum SPKIEncoderError: Error, Equatable {
  case invalidPoint
}
