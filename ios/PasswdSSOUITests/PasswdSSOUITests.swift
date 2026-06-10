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
  /// accidentally removing, mislabeling, or breaking hit-testing on the button.
  /// Launch routes to either ServerURLSetupView ("Continue") or, when a server
  /// config is already persisted, SignInView ("Sign in to passwd-sso").
  func testPrimaryButtonIsHittable() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.staticTexts["passwd-sso"].waitForExistence(timeout: 5))

    let continueButton = app.buttons["Continue"]
    let signInButton = app.buttons["Sign in to passwd-sso"]
    let primary = continueButton.waitForExistence(timeout: 2) ? continueButton : signInButton
    XCTAssertTrue(primary.waitForExistence(timeout: 5), "Launch-screen primary button is missing")
    XCTAssertTrue(primary.isHittable, "Launch-screen primary button is not hittable")
  }
}
