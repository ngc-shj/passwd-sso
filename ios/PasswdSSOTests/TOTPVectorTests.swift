import XCTest
@testable import Shared

/// Loads totp-rfc6238-vectors.json and asserts all 3 RFC 6238 vectors.
final class TOTPVectorTests: XCTestCase {

  private struct Vector: Decodable {
    let algorithm: String
    let secret: String
    let T_seconds: Int  // swiftlint:disable:this identifier_name
    let digits: Int
    let period: Int
    let expected: String
  }

  private func loadVectors() throws -> [Vector] {
    // Fixtures are bundled as a folder: look in "fixtures" subdirectory first, then root.
    let bundle = Bundle(for: type(of: self))
    let url: URL? =
      bundle.url(forResource: "fixtures/totp-rfc6238-vectors", withExtension: "json") ??
      bundle.url(forResource: "totp-rfc6238-vectors", withExtension: "json") ??
      bundle.url(forResource: "totp-rfc6238-vectors", withExtension: "json", subdirectory: "fixtures")
    guard let url else {
      XCTFail("totp-rfc6238-vectors.json not found in test bundle")
      throw NSError(domain: "test", code: 1)
    }
    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode([Vector].self, from: data)
  }

  func testRFC6238Vectors() throws {
    let vectors = try loadVectors()
    XCTAssertFalse(vectors.isEmpty, "No vectors loaded")

    for v in vectors {
      let algo: TOTPAlgorithm
      switch v.algorithm.uppercased() {
      case "SHA1":   algo = .sha1
      case "SHA256": algo = .sha256
      case "SHA512": algo = .sha512
      default:
        XCTFail("Unknown algorithm: \(v.algorithm)")
        continue
      }

      let params = TOTPParams(
        secret: v.secret,
        algorithm: algo,
        digits: v.digits,
        period: v.period
      )
      let time = Date(timeIntervalSince1970: TimeInterval(v.T_seconds))
      let code = try generateTOTPCode(params: params, at: time)

      XCTAssertEqual(
        code,
        v.expected,
        "Vector T=\(v.T_seconds) algo=\(v.algorithm) expected=\(v.expected)"
      )
    }
  }

  // MARK: - Validation

  func testInvalidDigitsThrows() {
    let params = TOTPParams(secret: "GEZDGNBVGY3TQOJQ", digits: 5, period: 30)
    XCTAssertThrowsError(try generateTOTPCode(params: params))
  }

  func testInvalidPeriodThrows() {
    let params = TOTPParams(secret: "GEZDGNBVGY3TQOJQ", digits: 6, period: 10)
    XCTAssertThrowsError(try generateTOTPCode(params: params))
  }

  func testDigits8IsValid() throws {
    let params = TOTPParams(
      secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      algorithm: .sha1,
      digits: 8,
      period: 30
    )
    let code = try generateTOTPCode(params: params, at: Date(timeIntervalSince1970: 59))
    XCTAssertEqual(code.count, 8)
    XCTAssertEqual(code, "94287082")
  }
}
