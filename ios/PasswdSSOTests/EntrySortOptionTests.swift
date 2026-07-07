import Foundation
import XCTest
@testable import Shared

/// T-SORT: EntrySortOption's 4-key comparator — favorites-first (all keys),
/// per-key direction, nil/empty sort-last, and stability (index tie-break).
final class EntrySortOptionTests: XCTestCase {
  private func s(
    _ id: String,
    title: String = "T",
    urlHost: String = "x.com",
    isFavorite: Bool = false,
    createdAt: Date? = nil,
    updatedAt: Date? = nil
  ) -> VaultEntrySummary {
    VaultEntrySummary(
      id: id, title: title, username: "u", urlHost: urlHost,
      isFavorite: isFavorite, createdAt: createdAt, updatedAt: updatedAt
    )
  }

  // MARK: - allCases

  func testAllCasesCountIsFour() {
    XCTAssertEqual(EntrySortOption.allCases.count, 4)
  }

  // MARK: - title (ascending, case-insensitive)

  func testTitleSortsAscendingCaseInsensitive() {
    let a = s("a", title: "alpha")
    let b = s("b", title: "Beta")
    let result = EntrySortOption.title.sorted([b, a])
    XCTAssertEqual(result.map(\.id), ["a", "b"])
  }

  // MARK: - website (ascending, empty-last)

  func testWebsiteSortsAscendingAndEmptyHostLast() {
    let empty = s("empty", urlHost: "")
    let z = s("z", urlHost: "zeta.com")
    let a = s("a", urlHost: "alpha.com")
    let result = EntrySortOption.website.sorted([empty, z, a])
    XCTAssertEqual(result.map(\.id), ["a", "z", "empty"])
  }

  // MARK: - createdAt / updatedAt (descending, nil-last)

  func testCreatedAtSortsDescendingNewestFirstAndNilLast() {
    let older = s("older", createdAt: Date(timeIntervalSince1970: 1000))
    let newer = s("newer", createdAt: Date(timeIntervalSince1970: 2000))
    let noDate = s("noDate", createdAt: nil)
    let result = EntrySortOption.createdAt.sorted([older, noDate, newer])
    XCTAssertEqual(result.map(\.id), ["newer", "older", "noDate"])
  }

  func testUpdatedAtSortsDescendingNewestFirstAndNilLast() {
    let older = s("older", updatedAt: Date(timeIntervalSince1970: 1000))
    let newer = s("newer", updatedAt: Date(timeIntervalSince1970: 2000))
    let noDate = s("noDate", updatedAt: nil)
    let result = EntrySortOption.updatedAt.sorted([older, noDate, newer])
    XCTAssertEqual(result.map(\.id), ["newer", "older", "noDate"])
  }

  // MARK: - favorites-first for ALL FOUR keys (T3)

  func testFavoritesFirstUnderTitle() {
    // "zzz" would sort last alphabetically, but it's a favorite.
    let favorite = s("fav", title: "zzz", isFavorite: true)
    let nonFavorite = s("nonfav", title: "aaa", isFavorite: false)
    let result = EntrySortOption.title.sorted([nonFavorite, favorite])
    XCTAssertEqual(result.map(\.id), ["fav", "nonfav"])
  }

  func testFavoritesFirstUnderWebsite() {
    let favorite = s("fav", urlHost: "", isFavorite: true)  // empty host would sort last
    let nonFavorite = s("nonfav", urlHost: "alpha.com", isFavorite: false)
    let result = EntrySortOption.website.sorted([nonFavorite, favorite])
    XCTAssertEqual(result.map(\.id), ["fav", "nonfav"])
  }

  func testFavoritesFirstUnderCreatedAt() {
    // Favorite has the OLDER date (would sort last on this key), but favorites-first wins.
    let favorite = s("fav", isFavorite: true, createdAt: Date(timeIntervalSince1970: 100))
    let nonFavorite = s("nonfav", isFavorite: false, createdAt: Date(timeIntervalSince1970: 9999))
    let result = EntrySortOption.createdAt.sorted([nonFavorite, favorite])
    XCTAssertEqual(result.map(\.id), ["fav", "nonfav"])
  }

  func testFavoritesFirstUnderUpdatedAt() {
    let favorite = s("fav", isFavorite: true, updatedAt: nil)  // nil would sort last
    let nonFavorite = s("nonfav", isFavorite: false, updatedAt: Date(timeIntervalSince1970: 100))
    let result = EntrySortOption.updatedAt.sorted([nonFavorite, favorite])
    XCTAssertEqual(result.map(\.id), ["fav", "nonfav"])
  }

  // MARK: - stability (T4)

  func testStabilityPreservesInputOrderForEqualTitles() {
    let first = s("first", title: "Same")
    let second = s("second", title: "Same")
    let third = s("third", title: "Same")
    let result = EntrySortOption.title.sorted([first, second, third])
    XCTAssertEqual(result.map(\.id), ["first", "second", "third"])
  }

  func testStabilityPreservesInputOrderForBothNilDates() {
    let first = s("first", createdAt: nil)
    let second = s("second", createdAt: nil)
    let third = s("third", createdAt: nil)
    let result = EntrySortOption.createdAt.sorted([first, second, third])
    XCTAssertEqual(result.map(\.id), ["first", "second", "third"])
  }

  func testStabilityPreservesInputOrderForBothEmptyHosts() {
    let first = s("first", urlHost: "")
    let second = s("second", urlHost: "")
    let result = EntrySortOption.website.sorted([first, second])
    XCTAssertEqual(result.map(\.id), ["first", "second"])
  }
}
