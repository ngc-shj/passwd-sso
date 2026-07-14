import Foundation
import XCTest

@testable import PasswdSSOApp

final class EntryFormTests: XCTestCase {

  func testSaveErrorMessage_quotaExceededIsDedicated() {
    let quota = EntryForm.saveErrorMessage(for: MobileAPIError.quotaExceeded)
    let generic = EntryForm.saveErrorMessage(for: MobileAPIError.notFound)

    // Compute the expected localized string via the same resolution path so the
    // assertion is non-vacuous and locale-robust.
    let expectedQuota = String(
      localized: "You've reached your vault's item limit. Remove unused items and try again."
    )
    let expectedGeneric = String(localized: "Could not save. Please try again.")

    // The helper picks the correct key per case (locale-robust: both sides
    // resolve through the same bundle). Catalog presence + ja translation is
    // guaranteed separately by LocalizationCatalogTests.
    XCTAssertEqual(quota, expectedQuota)
    XCTAssertEqual(generic, expectedGeneric)
    XCTAssertNotEqual(quota, generic, "quota message must differ from the generic save-failure message")
  }

  /// A dead session (server 401 → authenticationRequired) must NOT get the
  /// generic "try again" message — retrying never recovers a dead session; the
  /// user has to sign in again. The message must point them there.
  func testSaveErrorMessage_deadSessionTellsUserToSignIn() {
    let sessionExpired = EntryForm.saveErrorMessage(for: MobileAPIError.authenticationRequired)
    let generic = EntryForm.saveErrorMessage(for: MobileAPIError.notFound)

    let expectedSessionExpired = String(
      localized: "Your session has expired. Sign in again to save your changes."
    )

    XCTAssertEqual(sessionExpired, expectedSessionExpired)
    XCTAssertNotEqual(
      sessionExpired, generic,
      "a dead session must not show the generic retry message — retrying cannot recover it")
  }
}
