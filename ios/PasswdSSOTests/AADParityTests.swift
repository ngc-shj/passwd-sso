import XCTest
@testable import Shared

/// Parity tests against crypto-aad.ts — byte-identical output required.
final class AADParityTests: XCTestCase {

  // MARK: - Personal entry

  func testPersonalEntryAADByteIdentical() throws {
    // 3-field shape (byte-identical to crypto-aad.ts since server PR #482):
    // scope="PV"(2) + version=1(1) + nFields=3(1)
    //   + len="u"(2)+"u"(1) + len="e"(2)+"e"(1) + len="blob"(2)+"blob"(4)
    let blobResult = try buildPersonalEntryAAD(userId: "u", entryId: "e", vaultType: VaultType.blob)
    XCTAssertEqual([UInt8](blobResult), [
      0x50, 0x56,             // "PV"
      0x01,                   // aadVersion = 1
      0x03,                   // nFields = 3
      0x00, 0x01, 0x75,       // len("u")=1, "u"
      0x00, 0x01, 0x65,       // len("e")=1, "e"
      0x00, 0x04, 0x62, 0x6c, 0x6f, 0x62,  // len("blob")=4, "blob"
    ])

    // overview differs only in the trailing vaultType field — proves the
    // per-field discriminator is present (cross-field replay protection).
    let overviewResult = try buildPersonalEntryAAD(
      userId: "u", entryId: "e", vaultType: VaultType.overview)
    XCTAssertEqual([UInt8](overviewResult), [
      0x50, 0x56,
      0x01,
      0x03,
      0x00, 0x01, 0x75,
      0x00, 0x01, 0x65,
      0x00, 0x08, 0x6f, 0x76, 0x65, 0x72, 0x76, 0x69, 0x65, 0x77,  // len("overview")=8, "overview"
    ])
    XCTAssertNotEqual([UInt8](blobResult), [UInt8](overviewResult))
  }

  func testPersonalEntryAADMultiByteFields() throws {
    let result = try buildPersonalEntryAAD(
      userId: "user123", entryId: "entry456", vaultType: VaultType.blob)

    XCTAssertEqual(result[0], UInt8(ascii: "P"))
    XCTAssertEqual(result[1], UInt8(ascii: "V"))
    XCTAssertEqual(result[2], 0x01)
    XCTAssertEqual(result[3], 0x03)  // nFields = 3
    // field 1 length: big-endian 7
    XCTAssertEqual(result[4], 0x00)
    XCTAssertEqual(result[5], 0x07)
    // field 1 data: "user123"
    XCTAssertEqual([UInt8](result[6..<13]), Array("user123".utf8))
    // field 2 length: big-endian 8
    XCTAssertEqual(result[13], 0x00)
    XCTAssertEqual(result[14], 0x08)
    XCTAssertEqual([UInt8](result[15..<23]), Array("entry456".utf8))
    // field 3 (vaultType): len("blob")=4, "blob"
    XCTAssertEqual(result[23], 0x00)
    XCTAssertEqual(result[24], 0x04)
    XCTAssertEqual([UInt8](result[25..<29]), Array("blob".utf8))
  }

  // MARK: - Team entry

  func testTeamEntryAADByteIdentical() throws {
    // Full-byte golden vector (byte-identical to crypto-aad.ts):
    // scope="OV"(2) + version=1(1) + nFields=4(1)
    //   + len="t"(2)+"t"(1) + len="e"(2)+"e"(1)
    //   + len="blob"(2)+"blob"(4) + len="0"(2)+"0"(1)
    let result = try buildTeamEntryAAD(teamId: "t", entryId: "e", vaultType: VaultType.blob, itemKeyVersion: 0)
    XCTAssertEqual([UInt8](result), [
      0x4f, 0x56,             // "OV"
      0x01,                   // aadVersion = 1
      0x04,                   // nFields = 4
      0x00, 0x01, 0x74,       // len("t")=1, "t"
      0x00, 0x01, 0x65,       // len("e")=1, "e"
      0x00, 0x04, 0x62, 0x6c, 0x6f, 0x62,  // len("blob")=4, "blob"
      0x00, 0x01, 0x30,       // len("0")=1, "0"
    ])
  }

  func testTeamEntryAADDefaults() throws {
    let result = try buildTeamEntryAAD(teamId: "t", entryId: "e")
    // Should have vaultType="blob", itemKeyVersion=0 — 4 fields
    XCTAssertEqual(result[3], 0x04)  // nFields = 4
    // Verify it's bigger than just the header
    XCTAssertGreaterThan(result.count, 4)
  }

  // MARK: - Attachment

  func testAttachmentAADByteIdentical() throws {
    // Full-byte golden vector (byte-identical to crypto-aad.ts):
    // scope="AT"(2) + version=1(1) + nFields=2(1)
    //   + len="e"(2)+"e"(1) + len="a"(2)+"a"(1)
    let result = try buildAttachmentAAD(entryId: "e", attachmentId: "a")
    XCTAssertEqual([UInt8](result), [
      0x41, 0x54,             // "AT"
      0x01,                   // aadVersion = 1
      0x02,                   // nFields = 2
      0x00, 0x01, 0x65,       // len("e")=1, "e"
      0x00, 0x01, 0x61,       // len("a")=1, "a"
    ])
  }

  // MARK: - ItemKey wrap

  func testItemKeyWrapAADByteIdentical() throws {
    // Full-byte golden vector (byte-identical to crypto-aad.ts):
    // scope="IK"(2) + version=1(1) + nFields=3(1)
    //   + len="t"(2)+"t"(1) + len="e"(2)+"e"(1) + len("3")(2)+"3"(1)
    let result = try buildItemKeyWrapAAD(teamId: "t", entryId: "e", teamKeyVersion: 3)
    XCTAssertEqual([UInt8](result), [
      0x49, 0x4b,             // "IK"
      0x01,                   // aadVersion = 1
      0x03,                   // nFields = 3
      0x00, 0x01, 0x74,       // len("t")=1, "t"
      0x00, 0x01, 0x65,       // len("e")=1, "e"
      0x00, 0x01, 0x33,       // len("3")=1, "3"
    ])
  }

  // MARK: - Big-endian field lengths

  func testFieldLengthIsBigEndian() throws {
    // A field of length 256 should serialize as [0x01, 0x00], not [0x00, 0x01]
    let longField = String(repeating: "a", count: 256)
    let result = try buildPersonalEntryAAD(userId: longField, entryId: "x", vaultType: VaultType.blob)

    // After header (4 bytes), first field length at offset 4-5
    XCTAssertEqual(result[4], 0x01)  // high byte
    XCTAssertEqual(result[5], 0x00)  // low byte
  }

  // MARK: - Version and nFields in header

  func testHeaderVersionIsOne() throws {
    let result = try buildPersonalEntryAAD(userId: "a", entryId: "b", vaultType: VaultType.blob)
    XCTAssertEqual(result[2], 0x01)
  }
}
