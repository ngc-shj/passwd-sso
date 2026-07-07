import XCTest
@testable import Shared

/// T-VERSION: AppVersion.display uses the injectable string seam (T1), not
/// Bundle — Bundle has no public infoDictionary initializer, so a synthetic
/// test bundle can't carry a fixed test version.
final class AppVersionTests: XCTestCase {
  func testDisplayWithMarketingAndBuild() {
    XCTAssertEqual(AppVersion.display(marketing: "0.4.65", build: "42"), "0.4.65 (42)")
  }

  func testDisplayWithBothNilReturnsFallback() {
    XCTAssertEqual(AppVersion.display(marketing: nil, build: nil), "—")
  }

  func testDisplayWithBuildNilReturnsMarketingOnly() {
    XCTAssertEqual(AppVersion.display(marketing: "0.4.65", build: nil), "0.4.65")
  }

  func testDisplayWithMarketingNilReturnsBuildOnly() {
    XCTAssertEqual(AppVersion.display(marketing: nil, build: "42"), "42")
  }
}
