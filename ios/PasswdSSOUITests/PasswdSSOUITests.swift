import XCTest

@MainActor
final class PasswdSSOUITests: XCTestCase {
  func testAppLaunches() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.staticTexts["passwd-sso"].waitForExistence(timeout: 5))
  }

  /// The launch-screen primary CTA was enlarged to `.controlSize(.large)` for
  /// HIG tap-target sizing. Geometry (44pt) is not assertable without a
  /// snapshot harness, but this guards the realistic regression: the resize
  /// accidentally removing or breaking hit-testing on the button. Buttons are
  /// matched by accessibility identifier, not localized title, so the test is
  /// locale-independent (the simulator may run in any language).
  /// Launch routes to either ServerURLSetupView or, when a server config is
  /// already persisted, SignInView.
  func testPrimaryButtonIsHittable() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.staticTexts["passwd-sso"].waitForExistence(timeout: 5))

    let serverSetupButton = app.buttons["server-setup-primary-button"]
    let signInButton = app.buttons["sign-in-primary-button"]

    if serverSetupButton.waitForExistence(timeout: 2) {
      // The Continue button is disabled until a URL is entered, so type one to
      // exercise hit-testing on the enabled control.
      let field = app.textFields["server-setup-url-field"]
      XCTAssertTrue(field.waitForExistence(timeout: 5), "Server URL field is missing")
      field.tap()
      field.typeText("https://example.com")
      XCTAssertTrue(serverSetupButton.isHittable, "Server-setup primary button is not hittable")
    } else {
      XCTAssertTrue(signInButton.waitForExistence(timeout: 5), "Launch-screen primary button is missing")
      XCTAssertTrue(signInButton.isHittable, "Sign-in primary button is not hittable")
    }
  }
}
