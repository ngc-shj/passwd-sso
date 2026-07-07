import Foundation
import XCTest
@testable import Shared

/// T-SORT: EntrySortOption's 4-key comparator — favorites-first (all keys),
/// per-key direction toggle, nil/empty sort-last (regardless of direction),
/// and stability (index tie-break).
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

  func testDirectionAllCasesCountIsTwo() {
    XCTAssertEqual(EntrySortDirection.allCases.count, 2)
  }

  // MARK: - default direction per key

  func testDefaultDirectionIsAscendingForTitleAndWebsite() {
    XCTAssertEqual(EntrySortOption.title.defaultDirection, .ascending)
    XCTAssertEqual(EntrySortOption.website.defaultDirection, .ascending)
  }

  func testDefaultDirectionIsDescendingForDates() {
    XCTAssertEqual(EntrySortOption.createdAt.defaultDirection, .descending)
    XCTAssertEqual(EntrySortOption.updatedAt.defaultDirection, .descending)
  }

  // MARK: - title (ascending / descending)

  func testTitleSortsAscendingCaseInsensitive() {
    let a = s("a", title: "alpha")
    let b = s("b", title: "Beta")
    let result = EntrySortOption.title.sorted([b, a], direction: .ascending)
    XCTAssertEqual(result.map(\.id), ["a", "b"])
  }

  func testTitleSortsDescendingWhenRequested() {
    let a = s("a", title: "alpha")
    let b = s("b", title: "Beta")
    let result = EntrySortOption.title.sorted([a, b], direction: .descending)
    XCTAssertEqual(result.map(\.id), ["b", "a"])
  }

  // MARK: - website (ascending / descending, empty-last both ways)

  func testWebsiteSortsAscendingAndEmptyHostLast() {
    let empty = s("empty", urlHost: "")
    let z = s("z", urlHost: "zeta.com")
    let a = s("a", urlHost: "alpha.com")
    let result = EntrySortOption.website.sorted([empty, z, a], direction: .ascending)
    XCTAssertEqual(result.map(\.id), ["a", "z", "empty"])
  }

  func testWebsiteDescendingStillSortsEmptyHostLast() {
    let empty = s("empty", urlHost: "")
    let z = s("z", urlHost: "zeta.com")
    let a = s("a", urlHost: "alpha.com")
    let result = EntrySortOption.website.sorted([empty, z, a], direction: .descending)
    // Populated hosts reverse (z before a); empty STILL sorts last, not first.
    XCTAssertEqual(result.map(\.id), ["z", "a", "empty"])
  }

  // MARK: - createdAt / updatedAt (descending / ascending, nil-last both ways)

  func testCreatedAtSortsDescendingNewestFirstAndNilLast() {
    let older = s("older", createdAt: Date(timeIntervalSince1970: 1000))
    let newer = s("newer", createdAt: Date(timeIntervalSince1970: 2000))
    let noDate = s("noDate", createdAt: nil)
    let result = EntrySortOption.createdAt.sorted([older, noDate, newer], direction: .descending)
    XCTAssertEqual(result.map(\.id), ["newer", "older", "noDate"])
  }

  func testCreatedAtAscendingOldestFirstButNilStillLast() {
    let older = s("older", createdAt: Date(timeIntervalSince1970: 1000))
    let newer = s("newer", createdAt: Date(timeIntervalSince1970: 2000))
    let noDate = s("noDate", createdAt: nil)
    let result = EntrySortOption.createdAt.sorted([newer, noDate, older], direction: .ascending)
    // Oldest first when ascending, but nil NEVER bubbles to the top.
    XCTAssertEqual(result.map(\.id), ["older", "newer", "noDate"])
  }

  func testUpdatedAtSortsDescendingNewestFirstAndNilLast() {
    let older = s("older", updatedAt: Date(timeIntervalSince1970: 1000))
    let newer = s("newer", updatedAt: Date(timeIntervalSince1970: 2000))
    let noDate = s("noDate", updatedAt: nil)
    let result = EntrySortOption.updatedAt.sorted([older, noDate, newer], direction: .descending)
    XCTAssertEqual(result.map(\.id), ["newer", "older", "noDate"])
  }

  func testUpdatedAtAscendingOldestFirstButNilStillLast() {
    let older = s("older", updatedAt: Date(timeIntervalSince1970: 1000))
    let newer = s("newer", updatedAt: Date(timeIntervalSince1970: 2000))
    let noDate = s("noDate", updatedAt: nil)
    let result = EntrySortOption.updatedAt.sorted([newer, noDate, older], direction: .ascending)
    XCTAssertEqual(result.map(\.id), ["older", "newer", "noDate"])
  }

  // MARK: - favorites-first for ALL FOUR keys, BOTH directions (T3)

  func testFavoritesFirstUnderTitleBothDirections() {
    let favorite = s("fav", title: "zzz", isFavorite: true)
    let nonFavorite = s("nonfav", title: "aaa", isFavorite: false)
    for direction in EntrySortDirection.allCases {
      let result = EntrySortOption.title.sorted([nonFavorite, favorite], direction: direction)
      XCTAssertEqual(result.map(\.id), ["fav", "nonfav"], "direction \(direction)")
    }
  }

  func testFavoritesFirstUnderWebsiteBothDirections() {
    let favorite = s("fav", urlHost: "", isFavorite: true)  // empty host would sort last
    let nonFavorite = s("nonfav", urlHost: "alpha.com", isFavorite: false)
    for direction in EntrySortDirection.allCases {
      let result = EntrySortOption.website.sorted([nonFavorite, favorite], direction: direction)
      XCTAssertEqual(result.map(\.id), ["fav", "nonfav"], "direction \(direction)")
    }
  }

  func testFavoritesFirstUnderCreatedAtBothDirections() {
    let favorite = s("fav", isFavorite: true, createdAt: Date(timeIntervalSince1970: 100))
    let nonFavorite = s("nonfav", isFavorite: false, createdAt: Date(timeIntervalSince1970: 9999))
    for direction in EntrySortDirection.allCases {
      let result = EntrySortOption.createdAt.sorted([nonFavorite, favorite], direction: direction)
      XCTAssertEqual(result.map(\.id), ["fav", "nonfav"], "direction \(direction)")
    }
  }

  func testFavoritesFirstUnderUpdatedAtBothDirections() {
    let favorite = s("fav", isFavorite: true, updatedAt: nil)  // nil would sort last
    let nonFavorite = s("nonfav", isFavorite: false, updatedAt: Date(timeIntervalSince1970: 100))
    for direction in EntrySortDirection.allCases {
      let result = EntrySortOption.updatedAt.sorted([nonFavorite, favorite], direction: direction)
      XCTAssertEqual(result.map(\.id), ["fav", "nonfav"], "direction \(direction)")
    }
  }

  // MARK: - stability (T4)

  func testStabilityPreservesInputOrderForEqualTitles() {
    let first = s("first", title: "Same")
    let second = s("second", title: "Same")
    let third = s("third", title: "Same")
    let result = EntrySortOption.title.sorted([first, second, third], direction: .ascending)
    XCTAssertEqual(result.map(\.id), ["first", "second", "third"])
  }

  func testStabilityPreservesInputOrderForBothNilDates() {
    let first = s("first", createdAt: nil)
    let second = s("second", createdAt: nil)
    let third = s("third", createdAt: nil)
    let result = EntrySortOption.createdAt.sorted([first, second, third], direction: .descending)
    XCTAssertEqual(result.map(\.id), ["first", "second", "third"])
  }

  func testStabilityPreservesInputOrderForBothEmptyHosts() {
    let first = s("first", urlHost: "")
    let second = s("second", urlHost: "")
    let result = EntrySortOption.website.sorted([first, second], direction: .ascending)
    XCTAssertEqual(result.map(\.id), ["first", "second"])
  }
}
