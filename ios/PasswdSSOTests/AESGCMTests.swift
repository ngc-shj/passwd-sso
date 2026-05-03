import XCTest
import CryptoKit
@testable import Shared

final class AESGCMTests: XCTestCase {

  private let testKey = SymmetricKey(size: .bits256)
  private let plaintext = "hello vault".data(using: .utf8)!

  // MARK: - Round-trip without AAD

  func testRoundTripNoAAD() throws {
    let (ciphertext, iv, tag) = try encryptAESGCM(plaintext: plaintext, key: testKey)

    let decrypted = try decryptAESGCM(ciphertext: ciphertext, iv: iv, tag: tag, key: testKey)

    XCTAssertEqual(decrypted, plaintext)
  }

  // MARK: - Round-trip with AAD

  func testRoundTripWithAAD() throws {
    let aad = "context".data(using: .utf8)!
    let (ciphertext, iv, tag) = try encryptAESGCM(plaintext: plaintext, key: testKey, aad: aad)

    let decrypted = try decryptAESGCM(ciphertext: ciphertext, iv: iv, tag: tag, key: testKey, aad: aad)

    XCTAssertEqual(decrypted, plaintext)
  }

  // MARK: - AAD mismatch throws

  func testAADMismatchThrows() throws {
    let aad = "correct".data(using: .utf8)!
    let (ciphertext, iv, tag) = try encryptAESGCM(plaintext: plaintext, key: testKey, aad: aad)

    let wrongAAD = "wrong".data(using: .utf8)!
    XCTAssertThrowsError(
      try decryptAESGCM(ciphertext: ciphertext, iv: iv, tag: tag, key: testKey, aad: wrongAAD)
    )
  }

  // MARK: - Tampered tag throws

  func testTamperedTagThrows() throws {
    let (ciphertext, iv, originalTag) = try encryptAESGCM(plaintext: plaintext, key: testKey)
    var tag = originalTag
    tag[0] ^= 0xFF  // flip a bit

    XCTAssertThrowsError(
      try decryptAESGCM(ciphertext: ciphertext, iv: iv, tag: tag, key: testKey)
    )
  }

  // MARK: - IV is 12 bytes

  func testIVIs12Bytes() throws {
    let (_, iv, _) = try encryptAESGCM(plaintext: plaintext, key: testKey)
    XCTAssertEqual(iv.count, 12)
  }

  // MARK: - Tag is 16 bytes

  func testTagIs16Bytes() throws {
    let (_, _, tag) = try encryptAESGCM(plaintext: plaintext, key: testKey)
    XCTAssertEqual(tag.count, 16)
  }

  // MARK: - Hex-encoded variants

  func testEncryptedDataHexRoundTrip() throws {
    let encoded = try encryptAESGCMEncoded(plaintext: plaintext, key: testKey)
    let decrypted = try decryptAESGCMEncoded(encrypted: encoded, key: testKey)

    XCTAssertEqual(decrypted, plaintext)
  }

  func testEncryptedDataHexFormat() throws {
    let encoded = try encryptAESGCMEncoded(plaintext: plaintext, key: testKey)

    XCTAssertEqual(encoded.iv.count, 24)     // 12 bytes → 24 hex chars
    XCTAssertEqual(encoded.authTag.count, 32) // 16 bytes → 32 hex chars
    XCTAssertTrue(encoded.ciphertext.allSatisfy { $0.isHexDigit })
  }
}

private extension Character {
  var isHexDigit: Bool {
    "0123456789abcdefABCDEF".contains(self)
  }
}
