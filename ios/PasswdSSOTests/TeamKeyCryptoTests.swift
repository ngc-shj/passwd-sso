import CryptoKit
import XCTest

@testable import Shared

/// Golden vectors for TeamKeyCrypto, captured from the browser extension's actual
/// crypto-team.ts via scripts/generate-team-key-fixture.ts. These assert iOS
/// reproduces the EXTENSION's outputs (cross-platform parity), not iOS-vs-iOS.
final class TeamKeyCryptoTests: XCTestCase {

  private struct Fixture: Decodable {
    let secretKeyHex: String
    let encryptedEcdhPrivateKey: EncryptedData
    let pkcs8PrivKeyHex: String
    let ephemeralPublicKeyJwk: String
    let hkdfSaltHex: String
    let encryptedTeamKey: EncryptedData
    let teamId: String
    let toUserId: String
    let keyVersion: Int
    let wrapVersion: Int
    let rawTeamKeyHex: String
    let teamEncKeyHex: String
    let entryId: String
    let encryptedOverview: EncryptedData
    let overviewPlaintext: String
    let teamKeyWrapAADHex: String
    let overviewAADHex: String
    // itemKeyVersion >= 1
    let teamKeyVersion: Int
    let entryIdV1: String
    let encryptedItemKey: EncryptedData
    let itemEncKeyHex: String
    let encryptedOverviewV1: EncryptedData
    let overviewPlaintextV1: String
  }

  private func loadFixture() throws -> Fixture {
    let bundle = Bundle(for: type(of: self))
    let url = try XCTUnwrap(
      bundle.url(forResource: "team-key-fixture", withExtension: "json")
        ?? bundle.url(forResource: "team-key-fixture", withExtension: "json", subdirectory: "fixtures"),
      "team-key-fixture.json must be bundled in the test target"
    )
    return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
  }

  private func hex(_ key: SymmetricKey) -> String { key.withUnsafeBytes { hexEncode(Data($0)) } }

  // Convenience: run the full decrypt chain and return the member private key + raw team key.
  private func recover(_ f: Fixture) throws -> (P256.KeyAgreement.PrivateKey, SymmetricKey) {
    let secretKey = SymmetricKey(data: try hexDecode(f.secretKeyHex))
    let wrappingKey = TeamKeyCrypto.deriveEcdhWrappingKey(secretKey: secretKey)
    let memberKey = try TeamKeyCrypto.unwrapEcdhPrivateKey(
      encrypted: f.encryptedEcdhPrivateKey, wrappingKey: wrappingKey)
    let rawTeamKey = try TeamKeyCrypto.unwrapTeamKey(
      encrypted: f.encryptedTeamKey,
      ephemeralPublicKeyJWK: f.ephemeralPublicKeyJwk,
      memberPrivateKey: memberKey,
      hkdfSalt: f.hkdfSaltHex,
      teamId: f.teamId, toUserId: f.toUserId,
      keyVersion: f.keyVersion, wrapVersion: f.wrapVersion)
    return (memberKey, rawTeamKey)
  }

  // (a) ECDH private key imports from the extension's PKCS#8 and is self-consistent.
  func testUnwrapEcdhPrivateKey_importsAndRoundTrips() throws {
    let f = try loadFixture()
    let (memberKey, _) = try recover(f)
    // derRepresentation may not be byte-identical to WebCrypto's pkcs8, but must
    // re-import to the same key (self-consistency); cross-platform correctness is
    // proven by the team-key round-trip (test b).
    let reimported = try P256.KeyAgreement.PrivateKey(derRepresentation: memberKey.derRepresentation)
    XCTAssertEqual(reimported.rawRepresentation, memberKey.rawRepresentation)
  }

  // (b) Cross-platform: iOS unwraps the team key to the SAME bytes the extension produced.
  func testUnwrapTeamKey_matchesExtension() throws {
    let f = try loadFixture()
    let (_, rawTeamKey) = try recover(f)
    XCTAssertEqual(hex(rawTeamKey), f.rawTeamKeyHex)
  }

  // (c) iOS derives the same team ENCRYPTION key as the extension.
  func testDeriveTeamEncryptionKey_matchesExtension() throws {
    let f = try loadFixture()
    let (_, rawTeamKey) = try recover(f)
    let enc = TeamKeyCrypto.deriveTeamEncryptionKey(rawTeamKey: rawTeamKey)
    XCTAssertEqual(hex(enc), f.teamEncKeyHex)
  }

  // (d) Full round-trip: the derived key decrypts a real team entry overview.
  func testDecryptsTeamOverview() throws {
    let f = try loadFixture()
    let (_, rawTeamKey) = try recover(f)
    let enc = TeamKeyCrypto.deriveTeamEncryptionKey(rawTeamKey: rawTeamKey)
    let aad = try buildTeamEntryAAD(teamId: f.teamId, entryId: f.entryId, vaultType: "overview", itemKeyVersion: 0)
    let plain = try decryptAESGCM(
      ciphertext: try hexDecode(f.encryptedOverview.ciphertext),
      iv: try hexDecode(f.encryptedOverview.iv),
      tag: try hexDecode(f.encryptedOverview.authTag),
      key: enc, aad: aad)
    XCTAssertEqual(String(data: plain, encoding: .utf8), f.overviewPlaintext)
  }

  // (e) itemKeyVersion >= 1: resolveTeamEntryKey applies the item-enc HKDF, and
  // the full decryptTeamSummary round-trip decodes a per-entry-keyed team entry.
  // Regression guard for the missing deriveItemEncryptionKey step.
  func testTeamEntry_itemKeyVersion1_decrypts() throws {
    let f = try loadFixture()
    let (_, rawTeamKey) = try recover(f)
    let teamEncKey = TeamKeyCrypto.deriveTeamEncryptionKey(rawTeamKey: rawTeamKey)

    let entry = CacheEntry(
      id: f.entryIdV1, teamId: f.teamId, aadVersion: 1, keyVersion: 0,
      teamKeyVersion: f.teamKeyVersion, itemKeyVersion: 1,
      encryptedItemKey: f.encryptedItemKey,
      encryptedBlob: f.encryptedOverviewV1,
      encryptedOverview: f.encryptedOverviewV1)

    let entryKey = try XCTUnwrap(TeamEntryDecryptor.resolveTeamEntryKey(entry: entry, teamKey: teamEncKey))
    XCTAssertEqual(hex(entryKey), f.itemEncKeyHex)

    let cacheKey = SymmetricKey(size: .bits256)
    let wrapped = try TeamEntryDecryptor.wrapTeamKey(
      teamEncKey: teamEncKey, cacheKey: cacheKey, userId: f.toUserId,
      teamId: f.teamId, teamKeyVersion: f.teamKeyVersion, issuedAt: Date())
    let summary = try XCTUnwrap(TeamEntryDecryptor.decryptTeamSummary(
      entry: entry, teamKeys: [wrapped], cacheKey: cacheKey, userId: f.toUserId, now: { Date() }))
    XCTAssertEqual(summary.title, "Team Login v1")
  }

  // AAD byte-parity with the extension.
  func testTeamKeyWrapAAD_byteIdentical() throws {
    let f = try loadFixture()
    let aad = try buildTeamKeyWrapAAD(
      teamId: f.teamId, toUserId: f.toUserId, keyVersion: f.keyVersion, wrapVersion: f.wrapVersion)
    XCTAssertEqual(hexEncode(aad), f.teamKeyWrapAADHex)
  }

  func testTeamEntryAAD_byteIdentical() throws {
    let f = try loadFixture()
    let aad = try buildTeamEntryAAD(teamId: f.teamId, entryId: f.entryId, vaultType: "overview", itemKeyVersion: 0)
    XCTAssertEqual(hexEncode(aad), f.overviewAADHex)
  }

  // Local-wrap AAD: hand-computed known-good bytes.
  // "LW"(2) + aadVersion=1 + nFields=3 + [len2+"team"][len2+"u1"][len2+"t1"]
  func testLocalWrapAAD_handComputed() throws {
    let aad = try buildLocalWrapAAD(kind: "team", userId: "u1", teamId: "t1")
    let expected = "4c5701030004" + "7465616d" + "000275"+"31" + "000274"+"31"
    XCTAssertEqual(hexEncode(aad), expected)
  }

  // Negative: tampered team-key ciphertext fails AEAD.
  func testUnwrapTeamKey_tamperedCiphertext_throws() throws {
    let f = try loadFixture()
    let secretKey = SymmetricKey(data: try hexDecode(f.secretKeyHex))
    let memberKey = try TeamKeyCrypto.unwrapEcdhPrivateKey(
      encrypted: f.encryptedEcdhPrivateKey,
      wrappingKey: TeamKeyCrypto.deriveEcdhWrappingKey(secretKey: secretKey))
    var ct = Array(try hexDecode(f.encryptedTeamKey.ciphertext))
    ct[0] ^= 0xFF
    let tampered = EncryptedData(ciphertext: hexEncode(Data(ct)), iv: f.encryptedTeamKey.iv, authTag: f.encryptedTeamKey.authTag)
    XCTAssertThrowsError(try TeamKeyCrypto.unwrapTeamKey(
      encrypted: tampered, ephemeralPublicKeyJWK: f.ephemeralPublicKeyJwk, memberPrivateKey: memberKey,
      hkdfSalt: f.hkdfSaltHex, teamId: f.teamId, toUserId: f.toUserId, keyVersion: f.keyVersion, wrapVersion: f.wrapVersion))
  }

  // Negative: wrong AAD (different teamId) fails AEAD.
  func testUnwrapTeamKey_wrongAAD_throws() throws {
    let f = try loadFixture()
    let secretKey = SymmetricKey(data: try hexDecode(f.secretKeyHex))
    let memberKey = try TeamKeyCrypto.unwrapEcdhPrivateKey(
      encrypted: f.encryptedEcdhPrivateKey,
      wrappingKey: TeamKeyCrypto.deriveEcdhWrappingKey(secretKey: secretKey))
    XCTAssertThrowsError(try TeamKeyCrypto.unwrapTeamKey(
      encrypted: f.encryptedTeamKey, ephemeralPublicKeyJWK: f.ephemeralPublicKeyJwk, memberPrivateKey: memberKey,
      hkdfSalt: f.hkdfSaltHex, teamId: "wrong-team", toUserId: f.toUserId, keyVersion: f.keyVersion, wrapVersion: f.wrapVersion))
  }

  // Negative: non-P-256 JWK rejected.
  func testImportEphemeralPublicKey_wrongCurve_throws() {
    let jwk = #"{"kty":"EC","crv":"P-384","x":"AAAA","y":"BBBB"}"#
    XCTAssertThrowsError(try TeamKeyCrypto.importEphemeralPublicKey(jwk: jwk)) { error in
      XCTAssertEqual(error as? TeamKeyCrypto.TeamKeyCryptoError, .unsupportedKeyType)
    }
  }

  // T4: tampered ECDH ciphertext must fail AES-GCM authentication.
  func testUnwrapEcdhPrivateKey_tamperedCiphertext_throws() throws {
    let f = try loadFixture()
    let secretKey = SymmetricKey(data: try hexDecode(f.secretKeyHex))
    let wrappingKey = TeamKeyCrypto.deriveEcdhWrappingKey(secretKey: secretKey)
    var ct = Array(try hexDecode(f.encryptedEcdhPrivateKey.ciphertext))
    ct[0] ^= 0xFF
    let tampered = EncryptedData(
      ciphertext: hexEncode(Data(ct)),
      iv: f.encryptedEcdhPrivateKey.iv,
      authTag: f.encryptedEcdhPrivateKey.authTag
    )
    XCTAssertThrowsError(
      try TeamKeyCrypto.unwrapEcdhPrivateKey(encrypted: tampered, wrappingKey: wrappingKey),
      "Tampered ECDH ciphertext must fail AES-GCM authentication (T4)"
    )
  }

  // T1 stronger assertion: check whether CryptoKit derRepresentation is byte-identical
  // to the WebCrypto pkcs8 export from the fixture. If it passes, we keep the stronger
  // cross-platform anchor. If it fails (format mismatch), the self-check version is
  // correct and we rely on tests (b)/(c)/(d) for cross-platform parity.
  func testUnwrapEcdhPrivateKey_derRepresentationMatchesPkcs8() throws {
    let f = try loadFixture()
    let secretKey = SymmetricKey(data: try hexDecode(f.secretKeyHex))
    let wrappingKey = TeamKeyCrypto.deriveEcdhWrappingKey(secretKey: secretKey)
    let memberKey = try TeamKeyCrypto.unwrapEcdhPrivateKey(
      encrypted: f.encryptedEcdhPrivateKey, wrappingKey: wrappingKey)
    let actual = hexEncode(memberKey.derRepresentation)
    // If derRepresentation is byte-identical to the WebCrypto pkcs8 export, this
    // passes and provides a strong cross-platform anchor. If it fails, CryptoKit's
    // DER serialisation differs from WebCrypto's pkcs8 format; cross-platform
    // correctness is then anchored by testUnwrapTeamKey_matchesExtension (b),
    // testDeriveTeamEncryptionKey_matchesExtension (c), testDecryptsTeamOverview (d).
    XCTAssertEqual(actual, f.pkcs8PrivKeyHex,
      "CryptoKit derRepresentation must be byte-identical to WebCrypto pkcs8 export (T1 cross-platform anchor)")
  }
}
