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
