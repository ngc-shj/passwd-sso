import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

/// C1: entryType / isFavorite propagate wire → CacheEntry → summary.
final class CacheEntryPropagationTests: XCTestCase {
  private func enc() -> EncryptedData {
    EncryptedData(ciphertext: "aa", iv: "aabbccddeeff001122334455", authTag: "00112233445566778899aabbccddeeff")
  }

  func testToPersonalCacheEntryPropagatesEntryTypeAndFavorite() {
    let wire = EncryptedEntry(
      id: "e1", encryptedOverview: enc(), encryptedBlob: enc(),
      entryType: "PASSKEY", isFavorite: true
    )
    let cache = wire.toPersonalCacheEntry()
    XCTAssertEqual(cache.entryType, "PASSKEY")
    XCTAssertEqual(cache.isFavorite, true)
  }

  func testToPersonalCacheEntryFavoriteFalse() {
    let cache = EncryptedEntry(id: "e2", encryptedOverview: enc(), encryptedBlob: enc(), isFavorite: false)
      .toPersonalCacheEntry()
    XCTAssertEqual(cache.isFavorite, false)
  }

  /// Legacy cache rows written before isFavorite existed decode to nil.
  func testCacheEntryDecodesNilIsFavoriteFromLegacyJSON() throws {
    let json = #"""
    {"id":"e3","aadVersion":1,"keyVersion":1,
     "encryptedBlob":{"ciphertext":"aa","iv":"bb","authTag":"cc"},
     "encryptedOverview":{"ciphertext":"aa","iv":"bb","authTag":"cc"}}
    """#
    let entry = try JSONDecoder().decode(CacheEntry.self, from: Data(json.utf8))
    XCTAssertNil(entry.isFavorite)
    XCTAssertNil(entry.entryType)
  }

  /// EntryBlobDecoder.summary carries the caller-supplied metadata through.
  func testSummaryCarriesEntryTypeAndFavorite() throws {
    let overview = Data(#"{"title":"T","tags":[]}"#.utf8)
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(
        plaintext: overview, entryId: "e4", teamId: nil,
        entryType: "CREDIT_CARD", isFavorite: true
      )
    )
    XCTAssertEqual(summary.entryType, "CREDIT_CARD")
    XCTAssertTrue(summary.isFavorite)
  }

  func testSummaryDefaultsEntryTypeNilAndFavoriteFalse() throws {
    let overview = Data(#"{"title":"T","tags":[]}"#.utf8)
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: overview, entryId: "e5", teamId: nil)
    )
    XCTAssertNil(summary.entryType)
    XCTAssertFalse(summary.isFavorite)
  }
}
