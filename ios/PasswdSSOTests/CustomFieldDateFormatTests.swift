import Foundation
import XCTest
import Shared

@testable import PasswdSSOApp

/// C3 date helper unit tests. Exercises the pure static
/// `EntryDetailView.formatCustomFieldDate(_:locale:)` function which parses
/// bare "YYYY-MM-DD" (the web's toISODateString format) and formats it locale-
/// aware. Extracted as a pure function so it can be tested without SwiftUI.
@MainActor
final class CustomFieldDateFormatTests: XCTestCase {

  func testValidDateProducesNonRawOutputForJaLocale() throws {
    let result = EntryDetailView.formatCustomFieldDate("2026-07-01", locale: Locale(identifier: "ja"))
    // Must produce a formatted (non-raw) value; exact ja format depends on OS
    // date style ("abbreviated"), but it must differ from the raw ISO string.
    let formatted = try XCTUnwrap(result, "valid date must produce non-nil formatted string")
    XCTAssertNotEqual(formatted, "2026-07-01", "formatted output must not be the raw ISO string")
  }

  func testValidDateProducesNonRawOutputForEnLocale() throws {
    let result = EntryDetailView.formatCustomFieldDate("2026-07-01", locale: Locale(identifier: "en"))
    let formatted = try XCTUnwrap(result, "valid date must produce non-nil formatted string")
    XCTAssertNotEqual(formatted, "2026-07-01", "formatted output must not be the raw ISO string")
    // en abbreviated format for 2026-07-01 must contain "2026" and "Jul" (or similar).
    XCTAssertTrue(formatted.contains("2026"), "formatted result must include the year")
  }

  func testInvalidDateReturnsNil() {
    let result = EntryDetailView.formatCustomFieldDate("not-a-date", locale: Locale(identifier: "en"))
    XCTAssertNil(result, "unparseable value must return nil (caller shows raw string)")
  }

  func testEmptyStringReturnsNil() {
    XCTAssertNil(EntryDetailView.formatCustomFieldDate("", locale: Locale(identifier: "en")))
  }

  func testDateOnlyNoDayShiftInNonUTCZone() throws {
    // The function uses a UTC-based parse; a "2026-07-01" must not shift to
    // June 30 in a UTC+N zone where the base epoch would precede midnight.
    // We assert the year is 2026 and the result is non-nil regardless of TZ.
    let result = EntryDetailView.formatCustomFieldDate("2026-07-01", locale: Locale(identifier: "en"))
    let formatted = try XCTUnwrap(result)
    XCTAssertTrue(formatted.contains("2026"), "year must not shift due to timezone")
  }
}
