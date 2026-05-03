import CryptoKit
import Foundation

// MARK: - DPoP Proof

public struct DPoPProof: Sendable {
  /// The full compact-serialized JWS to place in the `DPoP` request header (RFC 9449 §4).
  public let jws: String
  /// The jti claim value, recorded for diagnostics.
  public let jti: String
}

// MARK: - Protocols

/// Produces a raw 64-byte r||s ECDSA-P256 signature for a JWS signing input.
public protocol DPoPSigner: Sendable {
  func sign(input: Data) async throws -> Data
}

/// Provides cryptographically random bytes.
public protocol RandomSource: Sendable {
  func bytes(_ count: Int) throws -> Data
}

// MARK: - Proof builder

/// Build a DPoP proof JWS per RFC 9449 §4.
///
/// - Parameters:
///   - htm: HTTP method (e.g. "POST").
///   - htu: Canonical URL of the endpoint; no query/fragment (server computes its canonical URL).
///   - jwk: Public key as `{ "kty", "crv", "x", "y" }` dictionary.
///   - ath: SHA-256(access_token) base64url — required for protected-resource calls; omit at token exchange.
///   - nonce: DPoP-Nonce echo from the last server response.
///   - signer: Signs the JWS header.payload bytes.
///   - random: Source of jti random bytes.
///   - now: Current timestamp (injectable for tests).
public func buildDPoPProof(
  htm: String,
  htu: String,
  jwk: [String: String],
  ath: String? = nil,
  nonce: String? = nil,
  signer: DPoPSigner,
  random: RandomSource = SecRandom(),
  now: Date = Date()
) async throws -> DPoPProof {
  let jtiBytes = try random.bytes(16)
  let jti = base64URLEncode(jtiBytes)

  // Header: sorted keys per RFC 7638 canonicalization convention.
  // Order: alg, jwk, typ — alphabetical.
  let jwkJSON = try canonicalJWKJSON(jwk)
  let headerJSON = #"{"alg":"ES256","jwk":\#(jwkJSON),"typ":"dpop+jwt"}"#

  // Payload: sorted keys — htm, htu, iat, jti (+ optional ath, nonce).
  let iat = Int(now.timeIntervalSince1970)
  let payloadJSON = buildPayloadJSON(htm: htm, htu: htu, iat: iat, jti: jti, ath: ath, nonce: nonce)

  let headerB64 = base64URLEncode(Data(headerJSON.utf8))
  let payloadB64 = base64URLEncode(Data(payloadJSON.utf8))
  let signingInput = "\(headerB64).\(payloadB64)"

  let rawSignature = try await signer.sign(input: Data(signingInput.utf8))
  let sigB64 = base64URLEncode(rawSignature)

  return DPoPProof(jws: "\(signingInput).\(sigB64)", jti: jti)
}

// MARK: - JSON helpers

/// Canonical JWK JSON: sorted keys (crv, kty, x, y) per RFC 7638.
private func canonicalJWKJSON(_ jwk: [String: String]) throws -> String {
  guard
    let crv = jwk["crv"],
    let kty = jwk["kty"],
    let x = jwk["x"],
    let y = jwk["y"]
  else {
    throw DPoPProofError.missingJWKField
  }
  return #"{"crv":"\#(crv)","kty":"\#(kty)","x":"\#(x)","y":"\#(y)"}"#
}

/// Build payload JSON with sorted keys; optional ath and nonce appended last.
/// Fixed key order: htm, htu, iat, jti [, ath] [, nonce].
private func buildPayloadJSON(
  htm: String,
  htu: String,
  iat: Int,
  jti: String,
  ath: String?,
  nonce: String?
) -> String {
  var json = #"{"htm":"\#(htm)","htu":"\#(htu)","iat":\#(iat),"jti":"\#(jti)""#
  if let ath { json += #","ath":"\#(ath)""# }
  if let nonce { json += #","nonce":"\#(nonce)""# }
  json += "}"
  return json
}

// MARK: - Errors

public enum DPoPProofError: Error, Equatable {
  case missingJWKField
  case signingFailed
}

// MARK: - Default RandomSource

/// Uses `SecRandomCopyBytes` for CSPRNG output.
public struct SecRandom: RandomSource, Sendable {
  public init() {}

  public func bytes(_ count: Int) throws -> Data {
    var data = Data(repeating: 0, count: count)
    let status = data.withUnsafeMutableBytes {
      SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!)
    }
    guard status == errSecSuccess else { throw DPoPProofError.signingFailed }
    return data
  }
}
