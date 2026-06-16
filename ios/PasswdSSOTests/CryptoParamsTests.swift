import XCTest
@testable import Shared

final class CryptoParamsTests: XCTestCase {

  /// Value-pin the crypto parameters not already covered by the byte-level
  /// vector suites (KDFTests, TeamKeyCryptoTests, etc.). A wrong value here
  /// silently breaks encryption / key derivation, so the literals are frozen.
  func testCryptoParamConstantsArePinnedToExpectedValues() {
    XCTAssertEqual(P256Params.keySizeBits, 256)
    XCTAssertEqual(P256Params.uncompressedPointByteCount, 65)
    XCTAssertEqual(P256Params.uncompressedPointPrefix, 0x04)
    XCTAssertEqual(P256Params.coordinateByteCount, 32)

    XCTAssertEqual(CryptoParams.aesGCMNonceByteCount, 12)
    XCTAssertEqual(CryptoParams.aesGCMTagByteCount, 16)
    XCTAssertEqual(CryptoParams.symmetricKeyByteCount, 32)
  }
}
