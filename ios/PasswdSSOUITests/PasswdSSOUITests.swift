import XCTest

@MainActor
final class PasswdSSOUITests: XCTestCase {
  func testAppLaunches() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.staticTexts["passwd-sso"].waitForExistence(timeout: 5))
  }
}
