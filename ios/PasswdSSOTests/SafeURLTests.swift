import XCTest

@testable import Shared

/// Parity vectors for `SafeURL.launchable`. The SSoT for the rejection set is the
/// web test `src/lib/security/safe-href.test.ts`. iOS deliberately DIVERGES from web
/// by rejecting `mailto:` (web accepts it for generic href contexts; the iOS login
/// URL field is a website address) — do NOT change the iOS vectors to accept mailto.
final class SafeURLTests: XCTestCase {
  func testAcceptsHttpAndHttps() {
    XCTAssertNotNil(SafeURL.launchable("http://example.com"))
    XCTAssertNotNil(SafeURL.launchable("https://example.com/path?q=1"))
  }

  func testAcceptsUppercaseScheme() {
    // Swift URL(string:) does NOT lowercase the scheme; the predicate must.
    XCTAssertNotNil(SafeURL.launchable("HTTPS://EXAMPLE.COM"))
  }

  func testRejectsDangerousAndNonWebSchemes() {
    XCTAssertNil(SafeURL.launchable("javascript:alert(1)"))
    XCTAssertNil(SafeURL.launchable("JavaScript:alert(1)"))
    XCTAssertNil(SafeURL.launchable("data:text/html,<script>alert(1)</script>"))
    XCTAssertNil(SafeURL.launchable("file:///etc/passwd"))
    XCTAssertNil(SafeURL.launchable("chrome://settings"))
    XCTAssertNil(SafeURL.launchable("about:blank"))
    XCTAssertNil(SafeURL.launchable("ftp://example.com"))
    XCTAssertNil(SafeURL.launchable("mailto:user@example.com"))
    XCTAssertNil(SafeURL.launchable("tel:+15551234"))
    XCTAssertNil(SafeURL.launchable("sms:+15551234"))
    XCTAssertNil(SafeURL.launchable("myapp://open"))
  }

  func testRejectsUnparseableAndSchemeless() {
    XCTAssertNil(SafeURL.launchable("example.com"))
    XCTAssertNil(SafeURL.launchable("not a url"))
    XCTAssertNil(SafeURL.launchable("/relative/path"))
    XCTAssertNil(SafeURL.launchable(""))
  }

  func testRejectsOverlongURL() {
    let longURL = "https://example.com/" + String(repeating: "a", count: 2048)
    XCTAssertNil(SafeURL.launchable(longURL))
  }
}
