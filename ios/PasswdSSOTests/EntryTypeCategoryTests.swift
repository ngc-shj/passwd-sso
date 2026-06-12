import XCTest
@testable import PasswdSSOApp

final class EntryTypeCategoryTests: XCTestCase {
  func testFromKnownRawValue() {
    XCTAssertEqual(EntryTypeCategory.from(rawType: "PASSKEY"), .passkey)
    XCTAssertEqual(EntryTypeCategory.from(rawType: "SECURE_NOTE"), .secureNote)
    XCTAssertEqual(EntryTypeCategory.from(rawType: "BANK_ACCOUNT"), .bankAccount)
  }

  func testFromNilDefaultsToLogin() {
    XCTAssertEqual(EntryTypeCategory.from(rawType: nil), .login)
  }

  func testFromUnknownDefaultsToLogin() {
    XCTAssertEqual(EntryTypeCategory.from(rawType: "FUTURE_TYPE"), .login)
  }

  func testAllCasesCountIsEight() {
    XCTAssertEqual(EntryTypeCategory.allCases.count, 8)
  }
}
