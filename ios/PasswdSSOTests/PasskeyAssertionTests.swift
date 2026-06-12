import CryptoKit
import Foundation
import XCTest

@testable import Shared

/// Tests for the passkey assertion crypto (C2) and the buildPasskeyAssertion
/// builder (C6). Uses a PINNED P-256 private scalar so the JWK is deterministic,
/// then verifies the DER signature with the derived public key AND asserts the
/// authenticatorData bytes exactly (a generate-then-verify loop alone would pass
/// even with a wrong shared layout).
final class PasskeyAssertionTests: XCTestCase {

  /// Deterministic, pinned 32-byte scalar (bytes 1...32; well below curve order).
  private static let pinnedScalar = Data((1...32).map { UInt8($0) })

  private func pinnedKey() -> P256.Signing.PrivateKey {
    try! P256.Signing.PrivateKey(rawRepresentation: Self.pinnedScalar)
  }

  /// Build the double-encoded JWK string the extension stores, from a P-256 key.
  private func jwkString(for key: P256.Signing.PrivateKey) -> String {
    let d = base64URLEncode(key.rawRepresentation)
    let pub = key.publicKey.x963Representation  // 0x04 ‖ x(32) ‖ y(32)
    let x = base64URLEncode(pub.subdata(in: 1..<33))
    let y = base64URLEncode(pub.subdata(in: 33..<65))
    return "{\"kty\":\"EC\",\"crv\":\"P-256\",\"d\":\"\(d)\",\"x\":\"\(x)\",\"y\":\"\(y)\"}"
  }

  // MARK: - authenticatorData layout (T1/T11)

  func testAuthenticatorData_layoutFlagsAndSignCount() {
    let rpId = "webauthn.io"
    let authData = buildAssertionAuthenticatorData(
      rpId: rpId, userPresent: true, userVerified: true, signCount: 0
    )
    XCTAssertEqual(authData.count, 37)
    let expectedHash = Data(SHA256.hash(data: Data(rpId.utf8)))
    XCTAssertEqual(authData.subdata(in: 0..<32), expectedHash)
    XCTAssertEqual(authData[32], 0x05, "UP|UV = 0x05")
    XCTAssertEqual(Array(authData.subdata(in: 33..<37)), [0, 0, 0, 0])
  }

  func testAuthenticatorData_allFlagsFalseAndSignCountBigEndian() {
    let authData = buildAssertionAuthenticatorData(
      rpId: "example.com", userPresent: false, userVerified: false, signCount: 0x01020304
    )
    XCTAssertEqual(authData[32], 0x00)
    XCTAssertEqual(Array(authData.subdata(in: 33..<37)), [0x01, 0x02, 0x03, 0x04])
  }

  // MARK: - JWK decode

  func testDecodeJWK_validPinnedKey() throws {
    let key = pinnedKey()
    let decoded = try decodeP256PrivateKeyJWK(Data(jwkString(for: key).utf8))
    XCTAssertEqual(decoded.rawRepresentation, key.rawRepresentation)
  }

  func testDecodeJWK_rejectsNonP256() {
    let jwk = "{\"kty\":\"EC\",\"crv\":\"P-384\",\"d\":\"AQ\"}"
    XCTAssertThrowsError(try decodeP256PrivateKeyJWK(Data(jwk.utf8))) { error in
      XCTAssertEqual(error as? PasskeyCryptoError, .unsupportedKeyType)
    }
  }

  func testDecodeJWK_rejectsWrongLengthScalar() {
    // d decodes to 4 bytes, not 32.
    let jwk = "{\"kty\":\"EC\",\"crv\":\"P-256\",\"d\":\"AQIDBA\"}"
    XCTAssertThrowsError(try decodeP256PrivateKeyJWK(Data(jwk.utf8))) { error in
      XCTAssertEqual(error as? PasskeyCryptoError, .malformedPrivateScalar)
    }
  }

  func testDecodeJWK_rejectsMalformedJSON() {
    XCTAssertThrowsError(try decodeP256PrivateKeyJWK(Data("not json".utf8))) { error in
      XCTAssertEqual(error as? PasskeyCryptoError, .malformedJWK)
    }
  }

  func testDecodeJWK_toleratesExtraWebCryptoFields() throws {
    // Web Crypto exportKey("jwk") emits key_ops/ext; JSONDecoder must ignore them.
    let key = pinnedKey()
    let pub = key.publicKey.x963Representation
    let jwk = """
      {"kty":"EC","crv":"P-256","d":"\(base64URLEncode(key.rawRepresentation))",\
      "x":"\(base64URLEncode(pub.subdata(in: 1..<33)))",\
      "y":"\(base64URLEncode(pub.subdata(in: 33..<65)))",\
      "key_ops":["sign"],"ext":true}
      """
    let decoded = try decodeP256PrivateKeyJWK(Data(jwk.utf8))
    XCTAssertEqual(decoded.rawRepresentation, key.rawRepresentation)
  }

  // MARK: - sign / verify round trip + DER

  func testSignPasskeyAssertion_producesVerifiableDERSignature() throws {
    let key = pinnedKey()
    let authData = buildAssertionAuthenticatorData(
      rpId: "webauthn.io", userPresent: true, userVerified: true, signCount: 0
    )
    let clientDataHash = Data(SHA256.hash(data: Data("client-data".utf8)))
    let der = try signPasskeyAssertion(
      privateKey: key, authenticatorData: authData, clientDataHash: clientDataHash
    )
    // The signature is DER (ASN.1) — parse via derRepresentation and verify.
    let signature = try P256.Signing.ECDSASignature(derRepresentation: der)
    var signed = authData
    signed.append(clientDataHash)
    XCTAssertTrue(key.publicKey.isValidSignature(signature, for: signed))
  }

  // MARK: - buildPasskeyAssertion (C6)

  private func material(rpId: String, key: P256.Signing.PrivateKey,
                        credentialId: String = "AQIDBA", userHandle: String = "BQYHCA")
    -> PasskeyAssertionMaterial {
    PasskeyAssertionMaterial(
      entryId: "e1", relyingPartyId: rpId, credentialId: credentialId,
      userHandle: userHandle, privateKeyJWK: Data(jwkString(for: key).utf8)
    )
  }

  func testBuildPasskeyAssertion_rpIdMismatchThrows() {
    let key = pinnedKey()
    let mat = material(rpId: "stored.example", key: key)
    let request = PasskeyAssertionRequest(
      relyingPartyId: "attacker.example",
      clientDataHash: Data(repeating: 0xAB, count: 32),
      userVerificationRequired: true
    )
    XCTAssertThrowsError(try buildPasskeyAssertion(material: mat, request: request)) { error in
      XCTAssertEqual(error as? PasskeyCryptoError, .rpIdMismatch)
    }
  }

  func testBuildPasskeyAssertion_usesRequestRpIdForAuthDataAndVerifies() throws {
    let key = pinnedKey()
    let rpId = "webauthn.io"
    let mat = material(rpId: rpId, key: key)
    let clientDataHash = Data(repeating: 0x11, count: 32)
    let request = PasskeyAssertionRequest(
      relyingPartyId: rpId, clientDataHash: clientDataHash, userVerificationRequired: true
    )
    let outputs = try buildPasskeyAssertion(material: mat, request: request)

    XCTAssertEqual(outputs.relyingParty, rpId)
    // authData rpIdHash is from the OS-provided rpId.
    XCTAssertEqual(outputs.authenticatorData.subdata(in: 0..<32),
                   Data(SHA256.hash(data: Data(rpId.utf8))))
    XCTAssertEqual(outputs.credentialID, try base64URLDecode("AQIDBA"))
    XCTAssertEqual(outputs.userHandle, try base64URLDecode("BQYHCA"))
    // Signature verifies under the stored key.
    let signature = try P256.Signing.ECDSASignature(derRepresentation: outputs.signature)
    var signed = outputs.authenticatorData
    signed.append(clientDataHash)
    XCTAssertTrue(key.publicKey.isValidSignature(signature, for: signed))
  }

  func testBuildPasskeyAssertion_signCountAlwaysZero() throws {
    let key = pinnedKey()
    let rpId = "webauthn.io"
    let mat = material(rpId: rpId, key: key)
    let out1 = try buildPasskeyAssertion(
      material: mat,
      request: PasskeyAssertionRequest(
        relyingPartyId: rpId, clientDataHash: Data(repeating: 0x01, count: 32),
        userVerificationRequired: true)
    )
    let out2 = try buildPasskeyAssertion(
      material: mat,
      request: PasskeyAssertionRequest(
        relyingPartyId: rpId, clientDataHash: Data(repeating: 0x02, count: 32),
        userVerificationRequired: true)
    )
    XCTAssertEqual(Array(out1.authenticatorData.subdata(in: 33..<37)), [0, 0, 0, 0])
    XCTAssertEqual(out1.authenticatorData.subdata(in: 33..<37),
                   out2.authenticatorData.subdata(in: 33..<37))
  }

  func testBuildPasskeyAssertion_emptyCredentialIdThrows() {
    let key = pinnedKey()
    let mat = material(rpId: "webauthn.io", key: key, credentialId: "")
    let request = PasskeyAssertionRequest(
      relyingPartyId: "webauthn.io", clientDataHash: Data(repeating: 0x11, count: 32),
      userVerificationRequired: true
    )
    XCTAssertThrowsError(try buildPasskeyAssertion(material: mat, request: request)) { error in
      XCTAssertEqual(error as? PasskeyCryptoError, .malformedCredentialId)
    }
  }

  func testBuildPasskeyAssertion_emptyUserHandleThrows() {
    // A residual/pre-migration entry with empty userHandle must fail cleanly,
    // not crash AuthenticationServices on an empty handle.
    let key = pinnedKey()
    let mat = material(rpId: "webauthn.io", key: key, userHandle: "")
    let request = PasskeyAssertionRequest(
      relyingPartyId: "webauthn.io", clientDataHash: Data(repeating: 0x11, count: 32),
      userVerificationRequired: true
    )
    XCTAssertThrowsError(try buildPasskeyAssertion(material: mat, request: request)) { error in
      XCTAssertEqual(error as? PasskeyCryptoError, .emptyUserHandle)
    }
  }

  // MARK: - filterPasskeyCandidates (T6)

  func testFilterPasskeyCandidates_exactMatchOnly() {
    let summaries = [
      VaultEntrySummary(id: "a", title: "A", username: "u", urlHost: "",
                        relyingPartyId: "webauthn.io", credentialId: "c1"),
      VaultEntrySummary(id: "b", title: "B", username: "u", urlHost: "",
                        relyingPartyId: "sub.webauthn.io", credentialId: "c2"),
      VaultEntrySummary(id: "c", title: "C", username: "u", urlHost: "login.com"),  // login, rpId nil
    ]
    let matches = filterPasskeyCandidates(summaries, rpId: "webauthn.io")
    XCTAssertEqual(matches.map(\.id), ["a"], "exact rpId match only; no eTLD+1 expansion")
  }
}
