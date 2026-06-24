import XCTest
@testable import PasswdSSOApp

@MainActor
final class EntryIconDecisionTests: XCTestCase {

  // MARK: - Non-LOGIN types

  func testNonLoginTypeFaviconOnReturnsSymbol() {
    let result = EntryIconView.decision(entryType: "SECURE_NOTE", urlHost: "example.com", showFavicons: true)
    XCTAssertEqual(result, .symbol(EntryTypeCategory.secureNote.rowSymbol))
  }

  func testNonLoginTypeFaviconOffReturnsSymbol() {
    let result = EntryIconView.decision(entryType: "CREDIT_CARD", urlHost: "example.com", showFavicons: false)
    XCTAssertEqual(result, .symbol(EntryTypeCategory.creditCard.rowSymbol))
  }

  func testNonLoginTypeEmptyHostReturnsSymbol() {
    let result = EntryIconView.decision(entryType: "SSH_KEY", urlHost: "", showFavicons: true)
    XCTAssertEqual(result, .symbol(EntryTypeCategory.sshKey.rowSymbol))
  }

  // MARK: - LOGIN type, opt-out

  func testLoginFaviconOffReturnsGlobe() {
    let result = EntryIconView.decision(entryType: "LOGIN", urlHost: "example.com", showFavicons: false)
    XCTAssertEqual(result, .symbol("globe"))
  }

  // MARK: - LOGIN type, opt-in, empty/whitespace host

  func testLoginFaviconOnEmptyHostReturnsGlobe() {
    let result = EntryIconView.decision(entryType: "LOGIN", urlHost: "", showFavicons: true)
    XCTAssertEqual(result, .symbol("globe"))
  }

  func testLoginFaviconOnWhitespaceOnlyHostReturnsGlobe() {
    let result = EntryIconView.decision(entryType: "LOGIN", urlHost: "   ", showFavicons: true)
    XCTAssertEqual(result, .symbol("globe"))
  }

  // MARK: - LOGIN type, opt-in, non-empty host

  func testLoginFaviconOnNonEmptyHostReturnsFavicon() {
    let result = EntryIconView.decision(entryType: "LOGIN", urlHost: "example.com", showFavicons: true)
    XCTAssertEqual(result, .favicon(host: "example.com"))
  }

  // MARK: - T13: nil entryType resolves to LOGIN

  func testNilEntryTypeWithFaviconOnAndNonEmptyHostReturnsFavicon() {
    // nil entryType → EntryTypeCategory.from(nil) == .login (T13)
    let result = EntryIconView.decision(entryType: nil, urlHost: "github.com", showFavicons: true)
    XCTAssertEqual(result, .favicon(host: "github.com"))
  }

  func testNilEntryTypeWithFaviconOnAndEmptyHostReturnsGlobe() {
    let result = EntryIconView.decision(entryType: nil, urlHost: "", showFavicons: true)
    XCTAssertEqual(result, .symbol("globe"))
  }

  func testNilEntryTypeWithFaviconOffReturnsGlobe() {
    let result = EntryIconView.decision(entryType: nil, urlHost: "example.com", showFavicons: false)
    XCTAssertEqual(result, .symbol("globe"))
  }

  // MARK: - All non-LOGIN types are never favicon

  func testAllNonLoginTypesReturnSymbolRegardlessOfShowFavicons() {
    let nonLoginTypes: [String] = [
      "SECURE_NOTE", "CREDIT_CARD", "IDENTITY", "BANK_ACCOUNT",
      "SSH_KEY", "SOFTWARE_LICENSE", "PASSKEY"
    ]
    for rawType in nonLoginTypes {
      let category = EntryTypeCategory.from(rawType: rawType)
      let onResult = EntryIconView.decision(entryType: rawType, urlHost: "example.com", showFavicons: true)
      let offResult = EntryIconView.decision(entryType: rawType, urlHost: "example.com", showFavicons: false)
      XCTAssertEqual(onResult, .symbol(category.rowSymbol), "Type \(rawType) with ON should return symbol")
      XCTAssertEqual(offResult, .symbol(category.rowSymbol), "Type \(rawType) with OFF should return symbol")
    }
  }
}
