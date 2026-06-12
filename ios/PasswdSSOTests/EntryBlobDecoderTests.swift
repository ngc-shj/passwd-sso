import Foundation
import XCTest
@testable import Shared

/// Unit tests for the shared `EntryBlobDecoder` — the single source of truth for
/// decoding server-shaped entry blobs into iOS view models (used by both the
/// host app and the AutoFill extension). Exercises the server's actual blob
/// shapes: null optional fields, absent password (non-LOGIN), tags as
/// {name,color} objects, the hasTOTP overview marker, and malformed input.
final class EntryBlobDecoderTests: XCTestCase {

  private func data(_ json: String) -> Data { Data(json.utf8) }

  // MARK: - summary()

  func testSummaryDecodesMinimalOverviewWithNullOptionals() throws {
    // Server overview blob with null username/urlHost and omitted additionalUrlHosts.
    let json = #"{"title":"Acme","username":null,"urlHost":null,"tags":[]}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e1", teamId: nil)
    )
    XCTAssertEqual(summary.id, "e1")
    XCTAssertEqual(summary.title, "Acme")
    XCTAssertEqual(summary.username, "")
    XCTAssertEqual(summary.urlHost, "")
    XCTAssertEqual(summary.additionalUrlHosts, [])
    XCTAssertEqual(summary.tags, [])
    XCTAssertFalse(summary.hasTOTP)
  }

  func testSummaryMapsTagObjectsToNames() throws {
    let json = #"{"title":"T","tags":[{"name":"work","color":"aaa"},{"name":"personal","color":null}]}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e2", teamId: "team-9")
    )
    XCTAssertEqual(summary.tags, ["work", "personal"])
    XCTAssertEqual(summary.teamId, "team-9")
  }

  func testSummaryReadsAdditionalUrlHostsAndTOTPMarker() throws {
    let json = #"""
    {"title":"Login","username":"u","urlHost":"example.com",
     "additionalUrlHosts":["alt.example.com","login.example.com"],
     "tags":[],"hasTOTP":true}
    """#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e3", teamId: nil)
    )
    XCTAssertEqual(summary.urlHost, "example.com")
    XCTAssertEqual(summary.additionalUrlHosts, ["alt.example.com", "login.example.com"])
    // The overview TOTP marker drives the AutoFill one-time-code picker filter.
    XCTAssertTrue(summary.hasTOTP)
  }

  func testSummaryDecodesRequireRepromptAndTravelSafe() throws {
    // Web-only overview flags must be decoded so an iOS edit can preserve them.
    let json = #"{"title":"T","urlHost":"x.com","tags":[],"requireReprompt":true,"travelSafe":true}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e3b", teamId: nil)
    )
    XCTAssertTrue(summary.requireReprompt)
    XCTAssertEqual(summary.travelSafe, true)
  }

  func testSummaryDecodesExplicitTravelSafeFalseAsFalseNotNil() throws {
    // An explicit travel-unsafe entry must decode to `false`, NOT nil — else an
    // iOS edit would omit the key and the web would read absent as travel-safe.
    let json = #"{"title":"T","urlHost":"x.com","tags":[],"travelSafe":false}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e3d", teamId: nil)
    )
    XCTAssertEqual(summary.travelSafe, false)
  }

  func testSummaryDefaultsRequireRepromptFalseAndTravelSafeNilWhenAbsent() throws {
    let json = #"{"title":"T","urlHost":"x.com","tags":[]}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e3c", teamId: nil)
    )
    XCTAssertFalse(summary.requireReprompt)
    XCTAssertNil(summary.travelSafe)
  }

  func testSummaryDefaultsHasTOTPFalseWhenMarkerAbsent() throws {
    // Entry encrypted before the hasTOTP marker shipped (or a non-LOGIN entry).
    let json = #"{"title":"NoMarker","urlHost":"x.com","tags":[]}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e4", teamId: nil)
    )
    XCTAssertFalse(summary.hasTOTP)
  }

  func testSummaryReturnsNilOnMalformedJSON() {
    XCTAssertNil(
      EntryBlobDecoder.summary(plaintext: data("{not json"), entryId: "e5", teamId: nil)
    )
  }

  // MARK: - detail()

  func testDetailDecodesLoginBlobWithTOTP() throws {
    let json = #"""
    {"title":"Login","username":"alice","password":"s3cret","url":"https://example.com",
     "notes":"hi","tags":[{"name":"work","color":"fff"}],
     "totp":{"secret":"JBSWY3DPEHPK3PXP","digits":6,"period":30}}
    """#
    let detail = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "e6", teamId: nil)
    )
    XCTAssertEqual(detail.password, "s3cret")
    XCTAssertEqual(detail.username, "alice")
    XCTAssertEqual(detail.url, "https://example.com")
    XCTAssertEqual(detail.notes, "hi")
    XCTAssertEqual(detail.tags, ["work"])
    XCTAssertEqual(detail.totpSecret, "JBSWY3DPEHPK3PXP")
  }

  func testDetailDecodesNonLoginBlobWithAbsentPassword() throws {
    // Secure-note / card / identity entries carry no `password` in the full
    // blob. Requiring it previously left the detail view stuck on "decrypting".
    let json = #"{"title":"Secure Note","notes":"body text","tags":[]}"#
    let detail = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "e7", teamId: nil)
    )
    XCTAssertEqual(detail.password, "")
    XCTAssertEqual(detail.notes, "body text")
    XCTAssertNil(detail.totpSecret)
  }

  func testDetailDecodesNullOptionalFields() throws {
    let json = #"{"title":"T","username":null,"password":null,"url":null,"notes":null,"tags":null}"#
    let detail = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "e8", teamId: nil)
    )
    XCTAssertEqual(detail.username, "")
    XCTAssertEqual(detail.password, "")
    XCTAssertEqual(detail.url, "")
    XCTAssertEqual(detail.notes, "")
    XCTAssertEqual(detail.tags, [])
  }

  func testDetailReturnsNilOnMalformedJSON() {
    XCTAssertNil(
      EntryBlobDecoder.detail(plaintext: data("not-json"), entryId: "e9", teamId: nil)
    )
  }

  // MARK: - passkey overview / material (C3)

  func testSummarySurfacesPasskeyOverviewFields() throws {
    let json = #"{"title":"GitHub","username":"alice","relyingPartyId":"github.com","credentialId":"AQIDBA"}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "pk1", teamId: nil)
    )
    XCTAssertEqual(summary.relyingPartyId, "github.com")
    XCTAssertEqual(summary.credentialId, "AQIDBA")
  }

  func testSummaryLoginEntryHasNilPasskeyFields() throws {
    let json = #"{"title":"Acme","username":"u","urlHost":"acme.com","tags":[]}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e1", teamId: nil)
    )
    XCTAssertNil(summary.relyingPartyId, "LOGIN entries are not passkeys")
    XCTAssertNil(summary.credentialId)
  }

  func testPasskeyMaterialDecodesDoubleEncodedJWK() throws {
    // passkeyPrivateKeyJwk is a JSON STRING containing the JWK object (double-encoded),
    // matching the browser extension's JSON.stringify(privateKeyJwk).
    let json = #"""
    {"title":"GitHub","relyingPartyId":"github.com","credentialId":"AQIDBA",\#
    "passkeyPrivateKeyJwk":"{\"kty\":\"EC\",\"crv\":\"P-256\",\"d\":\"abc\",\"x\":\"xx\",\"y\":\"yy\"}",\#
    "passkeyUserHandle":"BQYHCA"}
    """#
    let material = try XCTUnwrap(
      EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "pk1")
    )
    XCTAssertEqual(material.entryId, "pk1")
    XCTAssertEqual(material.relyingPartyId, "github.com")
    XCTAssertEqual(material.credentialId, "AQIDBA")
    XCTAssertEqual(material.userHandle, "BQYHCA")
    // The stored JWK is the inner object string; decodeP256PrivateKeyJWK parses it.
    XCTAssertEqual(String(decoding: material.privateKeyJWK, as: UTF8.self),
                   #"{"kty":"EC","crv":"P-256","d":"abc","x":"xx","y":"yy"}"#)
  }

  func testPasskeyMaterialDecodesSignCount() throws {
    let json = #"{"relyingPartyId":"github.com","credentialId":"AQIDBA","passkeyPrivateKeyJwk":"{}","passkeyUserHandle":"BQYHCA","passkeySignCount":42}"#
    let material = try XCTUnwrap(
      EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "pk1")
    )
    XCTAssertEqual(material.signCount, 42)
  }

  func testPasskeyMaterialSignCountDefaultsToZeroWhenAbsent() throws {
    let json = #"{"relyingPartyId":"github.com","credentialId":"AQIDBA","passkeyPrivateKeyJwk":"{}","passkeyUserHandle":"BQYHCA"}"#
    let material = try XCTUnwrap(
      EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "pk1")
    )
    XCTAssertEqual(material.signCount, 0)
  }

  func testPasskeyMaterialNegativeSignCountClampsToZero() throws {
    let json = #"{"relyingPartyId":"github.com","credentialId":"AQIDBA","passkeyPrivateKeyJwk":"{}","passkeyUserHandle":"BQYHCA","passkeySignCount":-5}"#
    let material = try XCTUnwrap(
      EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "pk1")
    )
    XCTAssertEqual(material.signCount, 0)
  }

  func testPasskeyMaterialReturnsNilWhenNotPasskey() {
    // LOGIN blob: no relyingPartyId / no passkeyPrivateKeyJwk.
    let json = #"{"title":"Acme","username":"u","password":"p","url":"acme.com"}"#
    XCTAssertNil(EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "e1"))
  }

  func testPasskeyMaterialReturnsNilWhenCredentialIdMissing() {
    // rpId + jwk present but credentialId absent → fail fast (F17).
    let json = #"{"relyingPartyId":"github.com","passkeyPrivateKeyJwk":"{}","passkeyUserHandle":"BQYHCA"}"#
    XCTAssertNil(EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "pk1"))
  }

  func testPasskeyMaterialReturnsNilWhenJWKIsBareObject() {
    // passkeyPrivateKeyJwk MUST be a JSON string (double-encoded). A bare JWK
    // object at that field is a type mismatch → decode fails → nil (T5 guard).
    let json = #"""
    {"relyingPartyId":"github.com","credentialId":"AQIDBA",\#
    "passkeyPrivateKeyJwk":{"kty":"EC","crv":"P-256","d":"abc"},\#
    "passkeyUserHandle":"BQYHCA"}
    """#
    XCTAssertNil(EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "pk1"))
  }

  // MARK: - CacheEntry.entryType backward compat (C4)

  func testCacheEntryDecodesNilEntryTypeFromLegacyJSON() throws {
    let json = #"""
    {"id":"e1","aadVersion":0,"keyVersion":0,\#
    "encryptedBlob":{"ciphertext":"00","iv":"00","authTag":"00"},\#
    "encryptedOverview":{"ciphertext":"00","iv":"00","authTag":"00"}}
    """#
    let entry = try JSONDecoder().decode(CacheEntry.self, from: data(json))
    XCTAssertNil(entry.entryType, "legacy cache rows lack entryType → decode to nil")
  }

  func testCacheEntryDecodesPasskeyEntryType() throws {
    let json = #"""
    {"id":"pk1","aadVersion":1,"keyVersion":1,"entryType":"PASSKEY",\#
    "encryptedBlob":{"ciphertext":"00","iv":"00","authTag":"00"},\#
    "encryptedOverview":{"ciphertext":"00","iv":"00","authTag":"00"}}
    """#
    let entry = try JSONDecoder().decode(CacheEntry.self, from: data(json))
    XCTAssertEqual(entry.entryType, "PASSKEY")
  }
}
