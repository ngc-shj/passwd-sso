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
}
