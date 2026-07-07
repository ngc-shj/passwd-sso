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
  /// Launch first shows a splash while SessionRestorer.restore() runs, then
  /// routes to ServerURLSetupView (no persisted config — the clean UI-test
  /// case) or, when a server config is already persisted, SignInView.
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

  /// Drives Demo Mode → a category screen → confirms the new bottom-bar sort
  /// control is present and hittable. Verifies the search+sort UI wiring
  /// end-to-end (unit tests cover the comparator; this covers the SwiftUI
  /// surface). Captures a screenshot attachment for visual review.
  func testCategoryScreenHasSortControl() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.staticTexts["passwd-sso"].waitForExistence(timeout: 5))

    // Enter Demo Mode (available from either the server-setup or sign-in screen).
    let demoFromSetup = app.buttons["server-setup-demo-button"]
    let demoFromSignIn = app.buttons["sign-in-demo-button"]
    if demoFromSetup.waitForExistence(timeout: 2) {
      demoFromSetup.tap()
    } else if demoFromSignIn.waitForExistence(timeout: 2) {
      demoFromSignIn.tap()
    } else {
      XCTFail("No demo entry point found")
      return
    }

    // The demo landing shows category cards; tap the first tappable card to push
    // the category list (which owns the new sort bottom bar).
    let card = app.buttons.element(boundBy: 1)
    XCTAssertTrue(card.waitForExistence(timeout: 5), "No category card to tap")
    card.tap()

    // The sort control must exist on the category screen. Matched by a stable
    // identifier (the visible label is localized, e.g. "並び替え" in Japanese).
    let sortButton = app.buttons["category-sort-button"]
    XCTAssertTrue(sortButton.waitForExistence(timeout: 5), "Sort control missing on category screen")
    XCTAssertTrue(sortButton.isHittable, "Sort control not hittable")

    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "category-screen-with-sort-bar"
    shot.lifetime = .keepAlways
    add(shot)
  }
}
