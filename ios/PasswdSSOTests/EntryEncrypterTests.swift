import CryptoKit
import Foundation
import XCTest

@testable import Shared

final class EntryEncrypterTests: XCTestCase {

  private let vaultKey = SymmetricKey(size: .bits256)
  private let userId = "user-123"
  private let entryId = "entry-abc"

  private var sampleDetail: EntryPlaintext {
    EntryPlaintext(
      title: "My Login",
      username: "alice",
      password: "s3cr3t",
      url: "https://example.com",
      notes: "test note",
      totpSecret: "JBSWY3DPEHPK3PXP",
      tags: ["work", "web"]
    )
  }

  private var sampleOverview: OverviewPlaintext {
    OverviewPlaintext(
      title: "My Login",
      username: "alice",
      urlHost: "example.com",
      tags: ["work", "web"]
    )
  }

  // MARK: - Round-trip test

  func testEncryptPersonalEntry_roundTrip() throws {
    let (blobEnc, overviewEnc) = try encryptPersonalEntry(
      entryId: entryId,
      userId: userId,
      vaultKey: vaultKey,
      detail: sampleDetail,
      overview: sampleOverview
    )

    // Per-field AADs — must match what encryptPersonalEntry used per field.
    let blobAAD = try buildPersonalEntryAAD(
      userId: userId, entryId: entryId, vaultType: VaultType.blob)
    let overviewAAD = try buildPersonalEntryAAD(
      userId: userId, entryId: entryId, vaultType: VaultType.overview)

    let blobData = try decryptAESGCMEncoded(encrypted: blobEnc, key: vaultKey, aad: blobAAD)
    let overviewData = try decryptAESGCMEncoded(
      encrypted: overviewEnc, key: vaultKey, aad: overviewAAD)

    let decodedDetail = try JSONDecoder().decode(EntryPlaintext.self, from: blobData)
    let decodedOverview = try JSONDecoder().decode(OverviewPlaintext.self, from: overviewData)

    XCTAssertEqual(decodedDetail, sampleDetail)
    XCTAssertEqual(decodedOverview, sampleOverview)
  }

  // MARK: - Web-only overview flags survive encode→decode (T5 / F2 / F3 write-back)

  /// Guards the ENCODE side of the requireReprompt/travelSafe preservation: a
  /// CodingKeys rename or property drift on OverviewPlaintext would silently
  /// drop these on iOS re-encrypt. Uses travelSafe=false (the explicit
  /// travel-unsafe case) to also guard against it collapsing to absent.
  func testEncryptPersonalEntry_preservesRequireRepromptAndTravelSafe() throws {
    // tags intentionally empty: this test targets the requireReprompt/travelSafe
    // write-back. (A separate finding tracks that iOS encodes tags as [String]
    // while the decoder expects [{name,color}] objects — non-empty tags would
    // fail to re-decode; see the review log.)
    let overview = OverviewPlaintext(
      title: "My Login",
      username: "alice",
      urlHost: "example.com",
      hasTOTP: true,
      requireReprompt: true,
      travelSafe: false,
      tags: []
    )
    let (_, overviewEnc) = try encryptPersonalEntry(
      entryId: entryId, userId: userId, vaultKey: vaultKey,
      detail: sampleDetail, overview: overview
    )
    let overviewAAD = try buildPersonalEntryAAD(
      userId: userId, entryId: entryId, vaultType: VaultType.overview)
    let overviewData = try decryptAESGCMEncoded(
      encrypted: overviewEnc, key: vaultKey, aad: overviewAAD)

    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: overviewData, entryId: entryId, teamId: nil)
    )
    XCTAssertTrue(summary.requireReprompt, "requireReprompt must survive iOS re-encrypt")
    XCTAssertEqual(summary.travelSafe, false, "explicit travelSafe=false must survive (not become nil)")
    XCTAssertTrue(summary.hasTOTP)
  }

  // MARK: - Wrong AAD fails

  func testEncryptPersonalEntry_wrongAADFails() throws {
    let (blobEnc, _) = try encryptPersonalEntry(
      entryId: entryId,
      userId: userId,
      vaultKey: vaultKey,
      detail: sampleDetail,
      overview: sampleOverview
    )

    // Different userId → different AAD → should fail authentication
    let wrongAAD = try buildPersonalEntryAAD(
      userId: "other-user", entryId: entryId, vaultType: VaultType.blob)

    XCTAssertThrowsError(
      try decryptAESGCMEncoded(encrypted: blobEnc, key: vaultKey, aad: wrongAAD)
    )
  }

  // MARK: - Cross-field AAD fails (anti-vacuous)

  func testEncryptPersonalEntry_blobCannotDecryptWithOverviewAAD() throws {
    let (blobEnc, _) = try encryptPersonalEntry(
      entryId: entryId,
      userId: userId,
      vaultKey: vaultKey,
      detail: sampleDetail,
      overview: sampleOverview
    )

    // Same user + entry, wrong vaultType → must fail (cross-field replay guard).
    let overviewAAD = try buildPersonalEntryAAD(
      userId: userId, entryId: entryId, vaultType: VaultType.overview)

    XCTAssertThrowsError(
      try decryptAESGCMEncoded(encrypted: blobEnc, key: vaultKey, aad: overviewAAD)
    )
  }

  // MARK: - Independent IVs

  func testEncryptPersonalEntry_blobAndOverviewIndependentIVs() throws {
    let (blobEnc, overviewEnc) = try encryptPersonalEntry(
      entryId: entryId,
      userId: userId,
      vaultKey: vaultKey,
      detail: sampleDetail,
      overview: sampleOverview
    )

    XCTAssertNotEqual(
      blobEnc.iv, overviewEnc.iv,
      "Blob and overview must have independently random IVs"
    )
  }
}
