import XCTest

@testable import Shared

/// Unit tests for the pure AutoFill candidate helpers (no crypto/Keychain):
/// `partitionCandidates` (matched/all split) and `summaryMatchesSearch`.
final class AutoFillCandidateTests: XCTestCase {

  private func summary(_ id: String, urlHost: String, title: String = "", username: String = "")
    -> VaultEntrySummary
  {
    VaultEntrySummary(id: id, title: title, username: username, urlHost: urlHost)
  }

  // MARK: - partitionCandidates

  func testPartition_matchedFirstWhenSomeMatch() {
    let summaries = [
      summary("a", urlHost: "amazon.co.jp"),
      summary("b", urlHost: "github.com"),
      summary("c", urlHost: "www.amazon.co.jp"),
    ]
    let result = partitionCandidates(summaries, tabHosts: ["amazon.co.jp"])

    XCTAssertEqual(result.matched.map(\.id), ["a", "c"])
    XCTAssertEqual(result.all.map(\.id), ["a", "c", "b"], "all is matched-first, unmatched after")
  }

  func testPartition_noMatchReturnsEmptyMatchedAndFullAll() {
    let summaries = [summary("a", urlHost: "github.com"), summary("b", urlHost: "gitlab.com")]
    let result = partitionCandidates(summaries, tabHosts: ["amazon.co.jp"])

    XCTAssertTrue(result.matched.isEmpty)
    XCTAssertEqual(result.all.map(\.id), ["a", "b"], "all preserves the full input set")
  }

  func testPartition_preservesRelativeOrderWithinMatchedAndUnmatched() {
    let summaries = [
      summary("m1", urlHost: "amazon.co.jp"),
      summary("u1", urlHost: "github.com"),
      summary("m2", urlHost: "amazon.co.jp"),
      summary("u2", urlHost: "gitlab.com"),
    ]
    let result = partitionCandidates(summaries, tabHosts: ["amazon.co.jp"])

    XCTAssertEqual(result.all.map(\.id), ["m1", "m2", "u1", "u2"])
  }

  func testPartition_emptyUrlHostNeverMatchesButStaysInAll() {
    let summaries = [summary("empty", urlHost: ""), summary("amz", urlHost: "amazon.co.jp")]
    let result = partitionCandidates(summaries, tabHosts: ["amazon.co.jp"])

    XCTAssertEqual(result.matched.map(\.id), ["amz"], "empty urlHost is not a wildcard match")
    XCTAssertTrue(result.all.contains { $0.id == "empty" }, "empty-host entry remains searchable")
  }

  func testPartition_emptyTabHostsMatchesNothing() {
    let summaries = [summary("a", urlHost: "amazon.co.jp"), summary("b", urlHost: "github.com")]
    let result = partitionCandidates(summaries, tabHosts: [])

    XCTAssertTrue(result.matched.isEmpty)
    XCTAssertEqual(result.all.map(\.id), ["a", "b"])
  }

  // MARK: - summaryMatchesSearch

  func testSearch_matchesTitle() {
    let s = summary("a", urlHost: "x.com", title: "Amazon", username: "u")
    XCTAssertTrue(summaryMatchesSearch(s, query: "amaz"))
  }

  func testSearch_matchesUsername() {
    let s = summary("a", urlHost: "x.com", title: "T", username: "alice@example.com")
    XCTAssertTrue(summaryMatchesSearch(s, query: "alice"))
  }

  func testSearch_matchesUrlHost() {
    let s = summary("a", urlHost: "amazon.co.jp", title: "T", username: "u")
    XCTAssertTrue(summaryMatchesSearch(s, query: "amazon.co"))
  }

  func testSearch_isCaseInsensitive() {
    let s = summary("a", urlHost: "amazon.co.jp", title: "T", username: "u")
    XCTAssertTrue(summaryMatchesSearch(s, query: "AMAZON"))
  }

  func testSearch_emptyQueryReturnsFalse() {
    let s = summary("a", urlHost: "amazon.co.jp", title: "Amazon", username: "u")
    XCTAssertFalse(summaryMatchesSearch(s, query: "   "), "blank query → caller shows matched")
  }
}
