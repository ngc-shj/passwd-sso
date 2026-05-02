import XCTest
@testable import Shared

/// Loads url-match-cases.json from the test bundle and runs every case.
final class URLMatchingTests: XCTestCase {

  // MARK: - JSON fixture types

  private struct ExtractHostCase: Decodable {
    let name: String
    let url: String
    let expected: String?
  }

  private struct IsHostMatchCase: Decodable {
    let name: String
    let stored: String
    let current: String
    let expected: Bool
  }

  private struct Fixture: Decodable {
    let extractHost: [ExtractHostCase]
    let isHostMatch: [IsHostMatchCase]
  }

  private func loadFixture() throws -> Fixture {
    // Fixtures are bundled as a folder: look in "fixtures" subdirectory first, then root.
    let bundle = Bundle(for: type(of: self))
    let url: URL? =
      bundle.url(forResource: "fixtures/url-match-cases", withExtension: "json") ??
      bundle.url(forResource: "url-match-cases", withExtension: "json") ??
      bundle.url(forResource: "url-match-cases", withExtension: "json", subdirectory: "fixtures")
    guard let url else {
      XCTFail("url-match-cases.json not found in test bundle")
      throw NSError(domain: "test", code: 1)
    }
    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode(Fixture.self, from: data)
  }

  // MARK: - extractHost

  func testExtractHostCasesFromFixture() throws {
    let fixture = try loadFixture()

    for c in fixture.extractHost {
      let result = extractHost(c.url)
      XCTAssertEqual(result, c.expected, "extractHost: \(c.name)")
    }
  }

  // MARK: - isHostMatch

  func testIsHostMatchCasesFromFixture() throws {
    let fixture = try loadFixture()

    for c in fixture.isHostMatch {
      let result = isHostMatch(stored: c.stored, current: c.current)
      XCTAssertEqual(result, c.expected, "isHostMatch: \(c.name)")
    }
  }

  // MARK: - Additional inline cases for coverage

  func testExtractHostStripsWWW() {
    XCTAssertEqual(extractHost("https://www.example.com/path"), "example.com")
  }

  func testExtractHostCaseInsensitive() {
    XCTAssertEqual(extractHost("HTTPS://Example.COM/"), "example.com")
  }

  func testIsHostMatchWWWNormalization() {
    XCTAssertTrue(isHostMatch(stored: "example.com", current: "www.example.com"))
    XCTAssertTrue(isHostMatch(stored: "www.example.com", current: "example.com"))
  }

  func testIsHostMatchSubdomain() {
    XCTAssertTrue(isHostMatch(stored: "google.com", current: "mail.google.com"))
  }

  func testIsHostMatchDoesNotOverMatch() {
    XCTAssertFalse(isHostMatch(stored: "example.com", current: "notexample.com"))
  }
}
