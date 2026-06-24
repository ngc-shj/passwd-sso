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

  // MARK: - rowSymbol (C3)

  func testLoginRowSymbolIsGlobe() {
    XCTAssertEqual(EntryTypeCategory.login.rowSymbol, "globe")
  }

  func testLoginRowSymbolDiffersFromSfSymbol() {
    XCTAssertNotEqual(EntryTypeCategory.login.rowSymbol, EntryTypeCategory.login.sfSymbol)
  }

  func testRowSymbolNonEmptyForAllCases() {
    for category in EntryTypeCategory.allCases {
      XCTAssertFalse(category.rowSymbol.isEmpty, "\(category).rowSymbol must not be empty")
    }
  }

  func testNonLoginRowSymbolEqualssfSymbol() {
    let nonLoginCases = EntryTypeCategory.allCases.filter { $0 != .login }
    for category in nonLoginCases {
      XCTAssertEqual(
        category.rowSymbol, category.sfSymbol,
        "\(category).rowSymbol should equal sfSymbol")
    }
  }

  // MARK: - isEditableOnIOS (C7 data-corruption guard)

  func testIsEditableOnIOSTrueForLoginNilAndUnknown() {
    // LOGIN, plus nil/unknown which fall back to LOGIN, are the only editable cases.
    XCTAssertTrue(EntryTypeCategory.isEditableOnIOS(rawType: "LOGIN"))
    XCTAssertTrue(EntryTypeCategory.isEditableOnIOS(rawType: nil))
    XCTAssertTrue(EntryTypeCategory.isEditableOnIOS(rawType: "FUTURE_TYPE"))
  }

  func testIsEditableOnIOSFalseForAllNonLoginTypes() {
    for raw in [
      "SECURE_NOTE", "CREDIT_CARD", "IDENTITY", "BANK_ACCOUNT",
      "SSH_KEY", "SOFTWARE_LICENSE", "PASSKEY",
    ] {
      XCTAssertFalse(
        EntryTypeCategory.isEditableOnIOS(rawType: raw),
        "\(raw) must not be editable on iOS")
    }
  }
}
