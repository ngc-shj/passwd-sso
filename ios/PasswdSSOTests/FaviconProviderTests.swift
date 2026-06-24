import XCTest

@testable import PasswdSSOApp

final class FaviconProviderTests: XCTestCase {
  private let serverURL = URL(string: "https://passwd-sso.example.com")!

  // MARK: - Basic URL construction

  func testBuildsCorrectURL() throws {
    let url = try XCTUnwrap(FaviconProvider.iconURL(serverURL: serverURL, host: "example.com", size: 32))
    XCTAssertEqual(url.scheme, "https")
    XCTAssertEqual(url.host, "passwd-sso.example.com")
    XCTAssertTrue(url.path.hasSuffix("/api/mobile/favicon"), "Path must end with /api/mobile/favicon")

    let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
    let items = try XCTUnwrap(components.queryItems)
    let hostItem = try XCTUnwrap(items.first(where: { $0.name == "host" }))
    let sizeItem = try XCTUnwrap(items.first(where: { $0.name == "size" }))
    XCTAssertEqual(hostItem.value, "example.com")
    XCTAssertEqual(sizeItem.value, "32")
  }

  // MARK: - Empty / whitespace host → nil

  func testEmptyHostReturnsNil() {
    XCTAssertNil(FaviconProvider.iconURL(serverURL: serverURL, host: "", size: 32))
  }

  func testWhitespaceOnlyHostReturnsNil() {
    XCTAssertNil(FaviconProvider.iconURL(serverURL: serverURL, host: "   ", size: 32))
    XCTAssertNil(FaviconProvider.iconURL(serverURL: serverURL, host: "\t", size: 32))
    XCTAssertNil(FaviconProvider.iconURL(serverURL: serverURL, host: "\n", size: 32))
  }

  // MARK: - T14: URL must use the server host, not a third-party host

  func testURLUsesServerHostNotThirdParty() throws {
    let url = try XCTUnwrap(FaviconProvider.iconURL(serverURL: serverURL, host: "login.example.com", size: 64))
    XCTAssertEqual(
      url.host, serverURL.host,
      "Favicon URL must use the server host (never t1.gstatic.com, icons.duckduckgo.com, etc.)"
    )
    XCTAssertNotEqual(url.host, "t1.gstatic.com")
    XCTAssertNotEqual(url.host, "icons.duckduckgo.com")
  }

  // MARK: - Query encoding for hosts with special characters

  func testQueryEncodesSpecialCharacters() throws {
    // A host containing a plus sign should be percent-encoded in the query.
    let url = try XCTUnwrap(FaviconProvider.iconURL(serverURL: serverURL, host: "my+host.example.com", size: 32))
    // Use percentEncodedQuery (not url.query which decodes %2B back to +).
    let rawQuery = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery)
    // The + must NOT appear as a literal '+' in the percent-encoded query.
    XCTAssertFalse(rawQuery.contains("my+host"), "'+' in host must be percent-encoded in the query")
  }

  func testQueryEncodesAmpersand() throws {
    let url = try XCTUnwrap(FaviconProvider.iconURL(serverURL: serverURL, host: "a&b.example.com", size: 32))
    let rawQuery = try XCTUnwrap(url.query)
    XCTAssertFalse(rawQuery.contains("a&b"), "'&' in host must be percent-encoded")
  }

  // MARK: - Deployment basePath preservation

  func testPreservesDeploymentBasePath() throws {
    let baseWithPath = URL(string: "https://host.example/passwd-sso")!
    let url = try XCTUnwrap(FaviconProvider.iconURL(serverURL: baseWithPath, host: "example.com", size: 32))
    XCTAssertTrue(
      url.absoluteString.contains("/passwd-sso/api/mobile/favicon"),
      "Deployment basePath must be preserved"
    )
  }

  // MARK: - Size parameter

  func testSizeParameterIsWritten() throws {
    let url = try XCTUnwrap(FaviconProvider.iconURL(serverURL: serverURL, host: "example.com", size: 128))
    let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
    let sizeItem = try XCTUnwrap(components.queryItems?.first(where: { $0.name == "size" }))
    XCTAssertEqual(sizeItem.value, "128")
  }
}
