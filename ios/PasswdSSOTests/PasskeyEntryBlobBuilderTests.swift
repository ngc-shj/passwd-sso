import CryptoKit
import Foundation
import XCTest
import Shared

/// C2: a built PASSKEY blob must decode via the SHIPPED assertion decoders, and
/// the stored private-key JWK must recover the original key (a bare-object
/// encoding is a known failure mode — testPasskeyMaterialReturnsNilWhenJWKIsBareObject).
final class PasskeyEntryBlobBuilderTests: XCTestCase {
  private var pinnedKey: P256.Signing.PrivateKey {
    try! P256.Signing.PrivateKey(rawRepresentation: Data((1...32).map { UInt8($0) }))
  }

  private func build() throws -> (blob: Data, overview: Data, credId: Data, userHandle: Data) {
    let credId = Data((100..<132).map { UInt8($0) })
    let userHandle = Data("user-123".utf8)
    let passkey = makePasskey(privateKey: pinnedKey, credentialId: credId)
    let (blob, overview) = try PasskeyEntryBlobBuilder.buildCreate(
      rpId: "webauthn.io", rpName: "WebAuthn.io", userName: "alice",
      userHandle: userHandle, userDisplayName: "Alice",
      passkey: passkey, creationDate: "2026-06-13T00:00:00Z"
    )
    return (blob, overview, credId, userHandle)
  }

  func testFullBlobDecodesToUsableAssertionMaterial() throws {
    let b = try build()
    let material = try XCTUnwrap(EntryBlobDecoder.passkeyMaterial(plaintext: b.blob, entryId: "e1"))
    XCTAssertEqual(material.relyingPartyId, "webauthn.io")
    XCTAssertEqual(material.credentialId, base64URLEncode(b.credId))
    XCTAssertEqual(material.userHandle, base64URLEncode(b.userHandle))
    XCTAssertEqual(material.signCount, 0)
    // The stored JWK string must recover the original public key.
    let key = try decodeP256PrivateKeyJWK(material.privateKeyJWK)
    XCTAssertEqual(key.publicKey.rawRepresentation, pinnedKey.publicKey.rawRepresentation)
  }

  func testOverviewDecodesAsPasskeySummary() throws {
    let b = try build()
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: b.overview, entryId: "e1", teamId: nil, entryType: "PASSKEY")
    )
    XCTAssertEqual(summary.relyingPartyId, "webauthn.io")     // classifies as a passkey
    XCTAssertEqual(summary.credentialId, base64URLEncode(b.credId))
    XCTAssertEqual(summary.title, "WebAuthn.io (alice)")
    XCTAssertEqual(summary.username, "alice")
    XCTAssertEqual(summary.entryType, "PASSKEY")
  }
}
