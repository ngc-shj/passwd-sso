import Foundation
import XCTest
import Shared

/// `totpToCopy` decision matrix (autoCopy × secret presence × generation) and
/// TOTP-parameter fidelity. RFC 6238 SHA1 test vector: secret = base32 of
/// "12345678901234567890", at T=59s → 8-digit "94287082".
final class AutoCopyTOTPTests: XCTestCase {
  private let rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  private let t59 = Date(timeIntervalSince1970: 59)

  private func detail(
    totpSecret: String?,
    algorithm: String? = nil,
    digits: Int? = nil,
    period: Int? = nil
  ) -> VaultEntryDetail {
    VaultEntryDetail(
      id: "e1", title: "T", username: "u", urlHost: "example.com",
      password: "pw", url: "", totpSecret: totpSecret,
      totpAlgorithm: algorithm, totpDigits: digits, totpPeriod: period
    )
  }

  func testDisabledReturnsNil() {
    XCTAssertNil(totpToCopy(detail: detail(totpSecret: rfcSecret), autoCopy: false, now: t59))
  }

  func testNoSecretReturnsNil() {
    XCTAssertNil(totpToCopy(detail: detail(totpSecret: nil), autoCopy: true, now: t59))
  }

  func testMalformedSecretReturnsNilNotThrows() {
    XCTAssertNil(totpToCopy(detail: detail(totpSecret: "!!!not-base32!!!"), autoCopy: true, now: t59))
  }

  func testValidSecretSixDigitDefault() {
    // 6-digit truncation of the 94287082 vector.
    XCTAssertEqual(totpToCopy(detail: detail(totpSecret: rfcSecret), autoCopy: true, now: t59), "287082")
  }

  func testHonorsDigitsAndAlgorithm() {
    let code = totpToCopy(
      detail: detail(totpSecret: rfcSecret, algorithm: "SHA1", digits: 8, period: 30),
      autoCopy: true, now: t59
    )
    XCTAssertEqual(code, "94287082")
  }
}
