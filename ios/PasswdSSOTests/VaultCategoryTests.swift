import XCTest
import Shared
@testable import PasswdSSOApp

final class VaultCategoryTests: XCTestCase {
  private func summary(
    id: String,
    entryType: String? = nil,
    hasTOTP: Bool = false,
    isFavorite: Bool = false,
    tags: [String] = []
  ) -> VaultEntrySummary {
    VaultEntrySummary(
      id: id, title: id, username: "u", urlHost: "x.com",
      tags: tags, hasTOTP: hasTOTP, entryType: entryType, isFavorite: isFavorite
    )
  }

  func testMatchesPerCategory() {
    let login = summary(id: "a", entryType: EntryTypeCategory.login.rawValue)
    let passkey = summary(id: "b", entryType: EntryTypeCategory.passkey.rawValue)
    XCTAssertTrue(matches(login, .all))
    XCTAssertTrue(matches(login, .type(.login)))
    XCTAssertFalse(matches(login, .type(.passkey)))
    XCTAssertTrue(matches(passkey, .type(.passkey)))
    XCTAssertTrue(matches(summary(id: "c", hasTOTP: true), .codes))
    XCTAssertTrue(matches(summary(id: "d", isFavorite: true), .favorites))
    XCTAssertTrue(matches(summary(id: "e", tags: ["work"]), .tag("work")))
    XCTAssertFalse(matches(summary(id: "f", tags: ["home"]), .tag("work")))
  }

  func testLegacyNilEntryTypeCountsAsLogin() {
    XCTAssertTrue(matches(summary(id: "a", entryType: nil), .type(.login)))
  }

  func testMultiMembership() {
    let s = summary(id: "a", entryType: EntryTypeCategory.login.rawValue,
                    hasTOTP: true, isFavorite: true, tags: ["work"])
    XCTAssertTrue(matches(s, .type(.login)))
    XCTAssertTrue(matches(s, .codes))
    XCTAssertTrue(matches(s, .favorites))
    XCTAssertTrue(matches(s, .tag("work")))
  }

  func testCategoryCountsAllEqualsTotalAndPerCategory() {
    let summaries = [
      summary(id: "a", entryType: "LOGIN", hasTOTP: true, isFavorite: true, tags: ["work"]),
      summary(id: "b", entryType: "LOGIN"),
      summary(id: "c", entryType: "PASSKEY", tags: ["work", "social"]),
      summary(id: "d", entryType: nil),  // legacy → login
    ]
    let counts = categoryCounts(summaries)
    XCTAssertEqual(counts[.all], 4)
    XCTAssertEqual(counts[.type(.login)], 3)  // a, b, d(legacy)
    XCTAssertEqual(counts[.type(.passkey)], 1)
    XCTAssertEqual(counts[.codes], 1)
    XCTAssertEqual(counts[.favorites], 1)
    XCTAssertEqual(counts[.tag("work")], 2)
    XCTAssertEqual(counts[.tag("social")], 1)
  }

  func testZeroCountTypeIsAbsent() {
    let counts = categoryCounts([summary(id: "a", entryType: "LOGIN")])
    XCTAssertNil(counts[.type(.creditCard)], "empty type must not appear")
    XCTAssertNil(counts[.type(.passkey)])
  }

  func testDistinctTagsSortedUnique() {
    let summaries = [
      summary(id: "a", tags: ["work", "social"]),
      summary(id: "b", tags: ["work"]),
      summary(id: "c", tags: []),
    ]
    XCTAssertEqual(distinctTags(summaries), ["social", "work"])
  }
}
