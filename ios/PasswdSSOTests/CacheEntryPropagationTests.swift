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
    {"id":"e3","aadVersion":0,"keyVersion":0,
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

  // MARK: - T-DATE: EncryptedEntry decodes ISO dates, toPersonalCacheEntry carries them

  private func decodeEncryptedEntry(createdAt: String?, updatedAt: String?) throws -> EncryptedEntry {
    func field(_ name: String, _ value: String?) -> String {
      guard let value else { return "" }
      return #","\#(name)":"\#(value)""#
    }
    let json = """
    {"id":"e10","encryptedOverview":{"ciphertext":"aa","iv":"aabbccddeeff001122334455","authTag":"00112233445566778899aabbccddeeff"},
     "encryptedBlob":{"ciphertext":"aa","iv":"aabbccddeeff001122334455","authTag":"00112233445566778899aabbccddeeff"},
     "keyVersion":1,"aadVersion":1,"entryType":"LOGIN","isFavorite":false,"isArchived":false\
    \(field("createdAt", createdAt))\(field("updatedAt", updatedAt))}
    """
    return try JSONDecoder().decode(EncryptedEntry.self, from: Data(json.utf8))
  }

  func testEncryptedEntryDecodesFractionalISODate() throws {
    let entry = try decodeEncryptedEntry(createdAt: "2024-01-02T03:04:05.000Z", updatedAt: nil)
    let cache = entry.toPersonalCacheEntry()
    XCTAssertNotNil(cache.createdAt)
  }

  func testEncryptedEntryDecodesNonFractionalISODate() throws {
    let entry = try decodeEncryptedEntry(createdAt: "2024-01-02T03:04:05Z", updatedAt: nil)
    let cache = entry.toPersonalCacheEntry()
    XCTAssertNotNil(cache.createdAt)
  }

  func testEncryptedEntryGarbageOrAbsentDateYieldsNilWithoutThrow() throws {
    let garbage = try decodeEncryptedEntry(createdAt: "not-a-date", updatedAt: nil)
    XCTAssertNil(garbage.toPersonalCacheEntry().createdAt)

    let absent = try decodeEncryptedEntry(createdAt: nil, updatedAt: nil)
    XCTAssertNil(absent.toPersonalCacheEntry().createdAt)
    XCTAssertNil(absent.toPersonalCacheEntry().updatedAt)
  }

  func testToPersonalCacheEntryCarriesBothDates() throws {
    let entry = try decodeEncryptedEntry(
      createdAt: "2024-01-02T03:04:05.000Z", updatedAt: "2024-06-07T08:09:10.000Z")
    let cache = entry.toPersonalCacheEntry()
    XCTAssertNotNil(cache.createdAt)
    XCTAssertNotNil(cache.updatedAt)
    XCTAssertNotEqual(cache.createdAt, cache.updatedAt)
  }

  // MARK: - T-DATE-COMPAT: CacheEntry JSON omitting dates decodes with nil

  func testCacheEntryDecodesNilDatesFromLegacyJSON() throws {
    let json = #"""
    {"id":"e11","aadVersion":0,"keyVersion":0,
     "encryptedBlob":{"ciphertext":"aa","iv":"bb","authTag":"cc"},
     "encryptedOverview":{"ciphertext":"aa","iv":"bb","authTag":"cc"}}
    """#
    let entry = try JSONDecoder().decode(CacheEntry.self, from: Data(json.utf8))
    XCTAssertNil(entry.createdAt)
    XCTAssertNil(entry.updatedAt)
  }
}
