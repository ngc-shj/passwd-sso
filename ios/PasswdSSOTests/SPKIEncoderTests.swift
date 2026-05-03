import Foundation
import XCTest

@testable import Shared

final class SPKIEncoderTests: XCTestCase {

  func testEncodeP256SPKI_producesCorrectLength() throws {
    // 65-byte uncompressed point (0x04 || X:32 || Y:32)
    var point = Data(repeating: 0x00, count: 65)
    point[0] = 0x04
    for i in 1..<65 { point[i] = UInt8(i & 0xFF) }

    let spki = try encodeP256SPKI(uncompressedPoint: point)
    // 26-byte prefix + 65-byte point = 91 bytes
    XCTAssertEqual(spki.count, 91)
  }

  func testEncodeP256SPKI_startsWithCorrectSequenceTag() throws {
    var point = Data(repeating: 0xAB, count: 65)
    point[0] = 0x04

    let spki = try encodeP256SPKI(uncompressedPoint: point)
    // SEQUENCE tag
    XCTAssertEqual(spki[0], 0x30)
    // SEQUENCE length = 89 = 0x59
    XCTAssertEqual(spki[1], 0x59)
  }

  func testEncodeP256SPKI_rejectsMissingPrefix() {
    // A point NOT starting with 0x04
    let badPoint = Data(repeating: 0x03, count: 65)
    XCTAssertThrowsError(try encodeP256SPKI(uncompressedPoint: badPoint)) { error in
      XCTAssertEqual(error as? SPKIEncoderError, .invalidPoint)
    }
  }

  func testEncodeP256SPKI_rejectsWrongLength() {
    // 33 bytes — wrong length
    var shortPoint = Data(repeating: 0x00, count: 33)
    shortPoint[0] = 0x04
    XCTAssertThrowsError(try encodeP256SPKI(uncompressedPoint: shortPoint)) { error in
      XCTAssertEqual(error as? SPKIEncoderError, .invalidPoint)
    }
  }

  func testEncodeP256SPKI_embeddedPointBytesArePreserved() throws {
    var point = Data(repeating: 0x00, count: 65)
    point[0] = 0x04
    for i in 1..<65 { point[i] = UInt8(i) }

    let spki = try encodeP256SPKI(uncompressedPoint: point)

    // The 65-byte uncompressed point starts after the 26-byte prefix.
    let embedded = Data(spki[26...])
    XCTAssertEqual(embedded, point, "Embedded point bytes must equal the input")
  }

  func testEncodeP256SPKI_prefixMatchesDERSpec() throws {
    var point = Data(repeating: 0x00, count: 65)
    point[0] = 0x04

    let spki = try encodeP256SPKI(uncompressedPoint: point)

    // Expected 26-byte DER prefix for P-256 SPKI (without the 0x04 uncompressed marker,
    // since the full point — including its 0x04 first byte — is appended separately):
    let expectedPrefix: [UInt8] = [
      0x30, 0x59,
      0x30, 0x13,
      0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
      0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07,
      0x03, 0x42, 0x00,
    ]
    XCTAssertEqual(Array(spki.prefix(26)), expectedPrefix)
    // Byte 26 must be 0x04 — the start of the uncompressed point.
    XCTAssertEqual(spki[26], 0x04)
  }
}
