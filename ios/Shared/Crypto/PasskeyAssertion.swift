import CryptoKit
import Foundation

// MARK: - Errors

public enum PasskeyCryptoError: Error, Equatable {
  case malformedJWK
  case unsupportedKeyType      // kty != "EC" or crv != "P-256"
  case malformedPrivateScalar  // d absent or not exactly 32 bytes after base64url-decode
  case rpIdMismatch            // stored rpId != request rpId (defense-in-depth)
  case malformedCredentialId
  case emptyUserHandle         // ASPasskeyAssertionCredential requires a non-empty userHandle
}

// MARK: - Assertion material (decrypted from the full blob)

/// Fields needed to produce a WebAuthn assertion. `privateKeyJWK` is the raw
/// UTF-8 bytes of the stringified EC JWK (zeroable). The host never reaches this
/// type — it is built inside the AutoFill extension after the biometric unwrap.
public struct PasskeyAssertionMaterial: Sendable, Equatable {
  public let entryId: String
  public let relyingPartyId: String
  public let credentialId: String   // base64url, as stored
  public let userHandle: String     // base64url, as stored (may be empty)
  public var privateKeyJWK: Data    // raw UTF-8 bytes of the stringified JWK
  /// Last signCount the RP saw (stored in the blob, synced from the extension).
  /// The assertion emits `signCount + 1` to satisfy RP counter monotonicity.
  public let signCount: UInt32

  public init(
    entryId: String,
    relyingPartyId: String,
    credentialId: String,
    userHandle: String,
    privateKeyJWK: Data,
    signCount: UInt32 = 0
  ) {
    self.entryId = entryId
    self.relyingPartyId = relyingPartyId
    self.credentialId = credentialId
    self.userHandle = userHandle
    self.privateKeyJWK = privateKeyJWK
    self.signCount = signCount
  }

  /// Best-effort overwrite of the JWK bytes after the signing key is built.
  /// Note: Swift value semantics make this best-effort (the inner `d` String the
  /// JSON decoder materialises cannot be zeroed); the material is otherwise a
  /// short-lived local whose buffer is released at scope end.
  public mutating func zeroPrivateKey() {
    privateKeyJWK.resetBytes(in: 0..<privateKeyJWK.count)
  }
}

// MARK: - JWK → P-256 key

private struct ECPrivateKeyJWK: Decodable {
  let kty: String
  let crv: String
  let d: String
}

/// Parse a stringified EC JWK into a P-256 signing key. `d` (base64url) MUST
/// decode to exactly 32 bytes. Rejects non-EC / non-P-256 / wrong-length d.
/// Does NOT log the caught decoder error (never echoes key material).
public func decodeP256PrivateKeyJWK(_ jwkJSON: Data) throws -> P256.Signing.PrivateKey {
  guard let jwk = try? JSONDecoder().decode(ECPrivateKeyJWK.self, from: jwkJSON) else {
    throw PasskeyCryptoError.malformedJWK
  }
  guard jwk.kty == "EC", jwk.crv == "P-256" else {
    throw PasskeyCryptoError.unsupportedKeyType
  }
  guard var scalar = try? base64URLDecode(jwk.d), scalar.count == 32 else {
    throw PasskeyCryptoError.malformedPrivateScalar
  }
  // Zero the raw private scalar once the key is constructed (the inner JSON
  // String the decoder materialised cannot be zeroed; this covers the Data).
  defer { scalar.resetBytes(in: 0..<scalar.count) }
  guard let key = try? P256.Signing.PrivateKey(rawRepresentation: scalar) else {
    throw PasskeyCryptoError.malformedPrivateScalar
  }
  return key
}

// MARK: - authenticatorData

private let kFlagUserPresent: UInt8 = 0x01
private let kFlagUserVerified: UInt8 = 0x04
private let kFlagBackupEligible: UInt8 = 0x08
private let kFlagBackupState: UInt8 = 0x10

/// Build assertion authenticatorData: SHA256(rpId)(32) ‖ flags(1) ‖ signCount(4, BE).
/// No attested-credential-data / extensions. `backupEligible`/`backupState`
/// (BE/BS) — iOS AutoFill treats provider passkeys as synced and the completion
/// (`completeAssertionRequest`) appears to require BS; they must also stay
/// consistent with how the credential was registered at the RP.
public func buildAssertionAuthenticatorData(
  rpId: String,
  userPresent: Bool,
  userVerified: Bool,
  backupEligible: Bool = false,
  backupState: Bool = false,
  signCount: UInt32
) -> Data {
  var out = Data()
  let rpIdHash = SHA256.hash(data: Data(rpId.utf8))
  out.append(contentsOf: rpIdHash)
  var flags: UInt8 = 0
  if userPresent { flags |= kFlagUserPresent }
  if userVerified { flags |= kFlagUserVerified }
  if backupEligible { flags |= kFlagBackupEligible }
  if backupState { flags |= kFlagBackupState }
  out.append(flags)
  out.append(UInt8((signCount >> 24) & 0xff))
  out.append(UInt8((signCount >> 16) & 0xff))
  out.append(UInt8((signCount >> 8) & 0xff))
  out.append(UInt8(signCount & 0xff))
  return out
}

/// Sign authenticatorData ‖ clientDataHash with ECDSA-P256-SHA256 and return the
/// DER (ASN.1) signature — `.derRepresentation`, the WebAuthn standard the RP
/// verifies (the browser extension's assertions use DER and the RP accepts them).
public func signPasskeyAssertion(
  privateKey: P256.Signing.PrivateKey,
  authenticatorData: Data,
  clientDataHash: Data
) throws -> Data {
  var signed = authenticatorData
  signed.append(clientDataHash)
  let signature = try privateKey.signature(for: signed)
  return signature.derRepresentation
}

// MARK: - Assertion request / outputs

/// Inputs the OS gives us for a passkey assertion. clientDataHash is provided by
/// iOS (it owns origin/RP binding); we never construct clientDataJSON.
public struct PasskeyAssertionRequest: Sendable {
  public let relyingPartyId: String
  public let clientDataHash: Data
  public let userVerificationRequired: Bool

  public init(relyingPartyId: String, clientDataHash: Data, userVerificationRequired: Bool) {
    self.relyingPartyId = relyingPartyId
    self.clientDataHash = clientDataHash
    self.userVerificationRequired = userVerificationRequired
  }
}

/// The fields needed to construct ASPasskeyAssertionCredential.
public struct PasskeyAssertionOutputs: Sendable, Equatable {
  public let userHandle: Data
  public let relyingParty: String
  public let signature: Data            // DER (.derRepresentation)
  public let authenticatorData: Data
  public let credentialID: Data

  public init(
    userHandle: Data,
    relyingParty: String,
    signature: Data,
    authenticatorData: Data,
    credentialID: Data
  ) {
    self.userHandle = userHandle
    self.relyingParty = relyingParty
    self.signature = signature
    self.authenticatorData = authenticatorData
    self.credentialID = credentialID
  }
}

/// Build the assertion outputs. FIRST asserts material.relyingPartyId ==
/// request.relyingPartyId (defense-in-depth), then uses the OS-provided rpId
/// (authoritative) for authData. Emits signCount = 0; UP=true; UV=true (every
/// fill is biometric-gated). userVerificationRequired is accepted but not used
/// to downgrade (always UV=true).
public func buildPasskeyAssertion(
  material: PasskeyAssertionMaterial,
  request: PasskeyAssertionRequest,
  signCount: UInt32
) throws -> PasskeyAssertionOutputs {
  guard material.relyingPartyId == request.relyingPartyId else {
    throw PasskeyCryptoError.rpIdMismatch
  }
  guard let credentialID = try? base64URLDecode(material.credentialId), !credentialID.isEmpty else {
    throw PasskeyCryptoError.malformedCredentialId
  }
  let privateKey = try decodeP256PrivateKeyJWK(material.privateKeyJWK)
  // The RP enforces counter monotonicity, so `signCount` MUST exceed the last
  // value it saw. The caller computes it from PasskeySignCountStore (persisted
  // per-credential so consecutive offline assertions keep increasing).
  let authData = buildAssertionAuthenticatorData(
    rpId: request.relyingPartyId,
    userPresent: true,
    userVerified: true,
    backupEligible: true,
    backupState: true,
    signCount: signCount
  )
  let signature = try signPasskeyAssertion(
    privateKey: privateKey,
    authenticatorData: authData,
    clientDataHash: request.clientDataHash
  )
  // ASPasskeyAssertionCredential requires a non-empty userHandle. Registration
  // already skips empty-userHandle entries (C5), but guard here too so a
  // residual/pre-migration identity fails cleanly instead of crashing the
  // AuthenticationServices framework on an empty handle.
  guard let userHandle = try? base64URLDecode(material.userHandle), !userHandle.isEmpty else {
    throw PasskeyCryptoError.emptyUserHandle
  }
  return PasskeyAssertionOutputs(
    userHandle: userHandle,
    relyingParty: request.relyingPartyId,
    signature: signature,
    authenticatorData: authData,
    credentialID: credentialID
  )
}

// MARK: - Candidate filtering

/// Filter decrypted summaries to passkeys whose stored rpId EXACTLY equals the
/// requested rpId (no eTLD+1 expansion — the OS already domain-filters before
/// invoking the provider). Pure + Shared so the list-path logic is unit-testable.
public func filterPasskeyCandidates(
  _ summaries: [VaultEntrySummary],
  rpId: String
) -> [VaultEntrySummary] {
  summaries.filter { $0.relyingPartyId == rpId }
}
