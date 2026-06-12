import XCTest
@testable import PasswdSSOApp

final class EntryTypeCategoryTests: XCTestCase {
  func testFromKnownRawValueAllEightCases() {
    // Pins every raw string against the server ENTRY_TYPE contract.
    XCTAssertEqual(EntryTypeCategory.from(rawType: "LOGIN"), .login)
    XCTAssertEqual(EntryTypeCategory.from(rawType: "SECURE_NOTE"), .secureNote)
    XCTAssertEqual(EntryTypeCategory.from(rawType: "CREDIT_CARD"), .creditCard)
    XCTAssertEqual(EntryTypeCategory.from(rawType: "IDENTITY"), .identity)
    XCTAssertEqual(EntryTypeCategory.from(rawType: "BANK_ACCOUNT"), .bankAccount)
    XCTAssertEqual(EntryTypeCategory.from(rawType: "SSH_KEY"), .sshKey)
    XCTAssertEqual(EntryTypeCategory.from(rawType: "SOFTWARE_LICENSE"), .softwareLicense)
    XCTAssertEqual(EntryTypeCategory.from(rawType: "PASSKEY"), .passkey)
  }

  func testFromIsCaseSensitiveLowercaseFallsBackToLogin() {
    // The server contract is uppercase; a lowercase value is not a known type.
    XCTAssertEqual(EntryTypeCategory.from(rawType: "passkey"), .login)
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
