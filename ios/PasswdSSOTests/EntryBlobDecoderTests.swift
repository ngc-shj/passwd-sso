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
}
