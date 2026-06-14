import CryptoKit
import Foundation

// WebAuthn passkey REGISTRATION crypto — the create-side companion to
// PasskeyAssertion.swift. Ported from extension/src/lib/{webauthn-crypto,cbor}.ts
// so a passkey created here is byte-compatible with the browser extension's.

// MARK: - Minimal CBOR encoder (RFC 8949 subset: uint, neg int, bstr, tstr, map)
// Mirrors extension/src/lib/cbor.ts exactly so the encoded bytes match.

enum CBOR {
  static func writeHead(_ major: UInt8, _ value: Int, into out: inout Data) {
    let mt = major << 5
    if value < 24 {
      out.append(mt | UInt8(value))
    } else if value < 0x100 {
      out.append(mt | 24)
      out.append(UInt8(value))
    } else if value < 0x10000 {
      out.append(mt | 25)
      out.append(UInt8((value >> 8) & 0xff))
      out.append(UInt8(value & 0xff))
    } else {
      out.append(mt | 26)
      out.append(UInt8((value >> 24) & 0xff))
      out.append(UInt8((value >> 16) & 0xff))
      out.append(UInt8((value >> 8) & 0xff))
      out.append(UInt8(value & 0xff))
    }
  }

  static func int(_ n: Int, into out: inout Data) {
    if n >= 0 { writeHead(0, n, into: &out) } else { writeHead(1, -1 - n, into: &out) }
  }

  static func bytes(_ d: Data, into out: inout Data) {
    writeHead(2, d.count, into: &out)
    out.append(d)
  }

  static func text(_ s: String, into out: inout Data) {
    let u = Data(s.utf8)
    writeHead(3, u.count, into: &out)
    out.append(u)
  }
}

// MARK: - COSE EC2 public key (RFC 8152)

/// Encode a P-256 public key as a COSE_Key map: {1:2(EC2), 3:-7(ES256),
/// -1:1(P-256), -2:x(32), -3:y(32)} in canonical key order.
public func coseEC2PublicKey(_ pub: P256.Signing.PublicKey) -> Data {
  let raw = pub.rawRepresentation  // 64 bytes: x ‖ y (no 0x04 prefix)
  let x = raw.prefix(32)
  let y = raw.suffix(32)
  var out = Data()
  CBOR.writeHead(5, 5, into: &out)  // map, 5 entries
  CBOR.int(1, into: &out); CBOR.int(2, into: &out)    // kty: EC2
  CBOR.int(3, into: &out); CBOR.int(-7, into: &out)   // alg: ES256
  CBOR.int(-1, into: &out); CBOR.int(1, into: &out)   // crv: P-256
  CBOR.int(-2, into: &out); CBOR.bytes(Data(x), into: &out)
  CBOR.int(-3, into: &out); CBOR.bytes(Data(y), into: &out)
  return out
}

// MARK: - Attestation authenticatorData

private let kRegFlagUserPresent: UInt8 = 0x01
private let kRegFlagUserVerified: UInt8 = 0x04
private let kRegFlagAttested: UInt8 = 0x40

/// Build attestation authenticatorData: SHA256(rpId)(32) ‖ flags(1) ‖ signCount(4 BE)
/// ‖ AAGUID(16 zero) ‖ credIdLen(2 BE) ‖ credId ‖ COSE public key.
/// Flags = UP|UV|AT (0x45) — byte-identical to the browser extension's
/// buildAttestationAuthData (webauthn-crypto.ts). Do NOT set BE/BS: an iOS
/// credential-provider credential is device-bound and NOT OS-backed-up, so
/// claiming BS=1 makes Safari's getAuthenticatorData() return null for the
/// provider's attestationObject, which crashes the RP's WebAuthn client before
/// the registration is ever recorded ("Unrecognized credential ID" on later
/// assertion). The earlier 0x5D ("match the assertion path") was the bug.
public func buildRegistrationAuthData(
  rpId: String,
  signCount: UInt32,
  credentialId: Data,
  coseKey: Data
) -> Data {
  var out = Data()
  out.append(contentsOf: SHA256.hash(data: Data(rpId.utf8)))
  let flags = kRegFlagUserPresent | kRegFlagUserVerified | kRegFlagAttested  // 0x45
  out.append(flags)
  out.append(UInt8((signCount >> 24) & 0xff))
  out.append(UInt8((signCount >> 16) & 0xff))
  out.append(UInt8((signCount >> 8) & 0xff))
  out.append(UInt8(signCount & 0xff))
  out.append(Data(count: 16))  // AAGUID — all zero (software/provider authenticator)
  out.append(UInt8((credentialId.count >> 8) & 0xff))
  out.append(UInt8(credentialId.count & 0xff))
  out.append(credentialId)
  out.append(coseKey)
  return out
}

/// Build a "none" attestation object: CBOR map {"attStmt":{}, "authData":…, "fmt":"none"}
/// (string keys in sorted order — matches the extension's cborEncode).
public func buildNoneAttestationObject(authData: Data) -> Data {
  var out = Data()
  CBOR.writeHead(5, 3, into: &out)  // map, 3 entries
  CBOR.text("attStmt", into: &out); CBOR.writeHead(5, 0, into: &out)  // empty map {}
  CBOR.text("authData", into: &out); CBOR.bytes(authData, into: &out)
  CBOR.text("fmt", into: &out); CBOR.text("none", into: &out)
  return out
}

// MARK: - JWK serialization

/// Serialize a P-256 private key as a stringified EC JWK ({kty,crv,x,y,d}) — the
/// double-encoded form stored in the passkey blob (decodeP256PrivateKeyJWK reads
/// kty/crv/d; x/y are included for completeness / extension parity).
public func ecPrivateKeyJWKString(_ key: P256.Signing.PrivateKey) -> String {
  let d = key.rawRepresentation                 // 32 bytes (private scalar)
  let pub = key.publicKey.rawRepresentation     // 64 bytes: x ‖ y
  let x = base64URLEncode(Data(pub.prefix(32)))
  let y = base64URLEncode(Data(pub.suffix(32)))
  let dStr = base64URLEncode(d)
  return "{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"\(x)\",\"y\":\"\(y)\",\"d\":\"\(dStr)\"}"
}

// MARK: - Generated passkey

/// The product of a registration ceremony. `privateKeyJWKString` is zeroable via
/// the surrounding scope; the raw `P256.Signing.PrivateKey` cannot be zeroed
/// (CryptoKit owns its buffer) — same posture as the assertion path.
public struct GeneratedPasskey {
  public let credentialId: Data
  public let privateKey: P256.Signing.PrivateKey
  public let privateKeyJWKString: String
  public let publicKeyCOSE: Data

  public init(credentialId: Data, privateKey: P256.Signing.PrivateKey) {
    self.credentialId = credentialId
    self.privateKey = privateKey
    self.privateKeyJWKString = ecPrivateKeyJWKString(privateKey)
    self.publicKeyCOSE = coseEC2PublicKey(privateKey.publicKey)
  }
}

/// Deterministic core (inject key + credentialId for tests).
public func makePasskey(privateKey: P256.Signing.PrivateKey, credentialId: Data) -> GeneratedPasskey {
  GeneratedPasskey(credentialId: credentialId, privateKey: privateKey)
}

/// Generate a fresh P-256 credential with a random 32-byte credentialId.
/// `SystemRandomNumberGenerator` is cryptographically secure on Apple platforms.
public func generatePasskey() -> GeneratedPasskey {
  var rng = SystemRandomNumberGenerator()
  let credentialId = Data((0..<32).map { _ in UInt8.random(in: 0...255, using: &rng) })
  return GeneratedPasskey(credentialId: credentialId, privateKey: P256.Signing.PrivateKey())
}
