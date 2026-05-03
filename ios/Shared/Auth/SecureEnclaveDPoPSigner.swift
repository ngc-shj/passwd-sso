import Foundation
@preconcurrency import Security

/// `DPoPSigner` adapter that wraps a Secure Enclave `SecKey`.
///
/// The key MUST be a P-256 key generated with `kSecAttrTokenIDSecureEnclave`.
/// `SecKeyCreateSignature` produces X9.62 DER; we convert it to raw r||s (64 bytes)
/// as required by JWS (RFC 7518 §3.4).
///
/// `@unchecked Sendable` is safe: SecKey is an immutable CF object; all concurrent
/// reads are thread-safe.
public struct SecureEnclaveDPoPSigner: DPoPSigner, @unchecked Sendable {
  private let key: SecKey

  public init(key: SecKey) {
    self.key = key
  }

  public func sign(input: Data) async throws -> Data {
    try signDPoP(key: key, jwsHeaderPayloadInput: input)
  }
}
