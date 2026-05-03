import Foundation
import XCTest

@testable import PasswdSSOApp
@testable import Shared

// Re-use FakeKeychain from HostTokenStoreTests.swift

final class ServerTrustServiceTests: XCTestCase {
  private var keychain: FakeKeychain!
  private var service: ServerTrustService!
  private let serverURL = URL(string: "https://passwd-sso.example")!

  override func setUp() {
    super.setUp()
    keychain = FakeKeychain()
    service = ServerTrustService(keychain: keychain)
  }

  func testCurrentPinReturnsNilWhenUnpinned() async throws {
    let pin = try await service.currentPin(for: serverURL)
    XCTAssertNil(pin)
  }

  func testPinAndRetrieve() async throws {
    let pinSet = PinSet(
      aasaSHA256: Data(repeating: 0xAA, count: 32),
      tlsLeafKeySHA256: Data(repeating: 0xBB, count: 32)
    )
    try await service.pin(for: serverURL, pinSet)

    let current = try await service.currentPin(for: serverURL)
    let retrieved = try XCTUnwrap(current)
    XCTAssertEqual(retrieved, pinSet)
  }

  func testValidateReturnsUnpinnedOnFirstUse() async {
    let observed = PinSet(
      aasaSHA256: Data(repeating: 0x01, count: 32),
      tlsLeafKeySHA256: Data(repeating: 0x02, count: 32)
    )
    let result = await service.validate(serverURL: serverURL, observed: observed)
    XCTAssertEqual(result, .unpinned)
  }

  func testValidateReturnsMatchWhenEqual() async throws {
    let pinSet = PinSet(
      aasaSHA256: Data(repeating: 0xCC, count: 32),
      tlsLeafKeySHA256: Data(repeating: 0xDD, count: 32)
    )
    try await service.pin(for: serverURL, pinSet)

    let result = await service.validate(serverURL: serverURL, observed: pinSet)
    XCTAssertEqual(result, .match)
  }

  func testValidateReturnsMismatchWhenDifferent() async throws {
    let stored = PinSet(
      aasaSHA256: Data(repeating: 0xEE, count: 32),
      tlsLeafKeySHA256: Data(repeating: 0xFF, count: 32)
    )
    try await service.pin(for: serverURL, stored)

    let observed = PinSet(
      aasaSHA256: Data(repeating: 0x11, count: 32),
      tlsLeafKeySHA256: Data(repeating: 0x22, count: 32)
    )
    let result = await service.validate(serverURL: serverURL, observed: observed)
    XCTAssertEqual(result, .mismatch(stored: stored, observed: observed))
  }

  func testPinOverwrite() async throws {
    let original = PinSet(
      aasaSHA256: Data(repeating: 0x01, count: 32),
      tlsLeafKeySHA256: Data(repeating: 0x02, count: 32)
    )
    let updated = PinSet(
      aasaSHA256: Data(repeating: 0x03, count: 32),
      tlsLeafKeySHA256: Data(repeating: 0x04, count: 32)
    )
    try await service.pin(for: serverURL, original)
    try await service.pin(for: serverURL, updated)

    let result = await service.validate(serverURL: serverURL, observed: updated)
    XCTAssertEqual(result, .match)
  }

  // MARK: - Codable backward compatibility

  /// Legacy Keychain blobs encoded the field as `tlsSPKISHA256`.
  /// Decoder must accept this alias so an upgrade does not lose the pin.
  func testPinSetDecodesLegacyTLSSPKIKey() throws {
    // JSONEncoder serializes Data as base64 strings, so the legacy blob
    // must use base64 too — not hex.
    let aasaBase64 = Data(repeating: 0xAA, count: 32).base64EncodedString()
    let tlsBase64 = Data(repeating: 0xBB, count: 32).base64EncodedString()
    let legacyJSON = """
      {"aasaSHA256":"\(aasaBase64)","tlsSPKISHA256":"\(tlsBase64)"}
      """.data(using: .utf8)!

    let decoded = try JSONDecoder().decode(PinSet.self, from: legacyJSON)
    XCTAssertEqual(decoded.aasaSHA256, Data(repeating: 0xAA, count: 32))
    XCTAssertEqual(decoded.tlsLeafKeySHA256, Data(repeating: 0xBB, count: 32))
  }

  /// Encoder must write only the new key — no legacy alias on output.
  func testPinSetEncodesOnlyNewKey() throws {
    let pinSet = PinSet(
      aasaSHA256: Data(repeating: 0xAA, count: 32),
      tlsLeafKeySHA256: Data(repeating: 0xBB, count: 32)
    )
    let encoded = try JSONEncoder().encode(pinSet)
    let json = String(data: encoded, encoding: .utf8) ?? ""
    XCTAssertTrue(json.contains("tlsLeafKeySHA256"))
    XCTAssertFalse(json.contains("tlsSPKISHA256"))
  }

  /// First read with a legacy blob in the Keychain triggers
  /// migration-on-read: the on-disk JSON is rewritten with the new key.
  func testCurrentPinUpgradesLegacyOnRead() async throws {
    let aasaBase64 = Data(repeating: 0x11, count: 32).base64EncodedString()
    let tlsBase64 = Data(repeating: 0x22, count: 32).base64EncodedString()
    let legacyJSON = """
      {"aasaSHA256":"\(aasaBase64)","tlsSPKISHA256":"\(tlsBase64)"}
      """.data(using: .utf8)!

    // Seed the keychain with the legacy JSON for our serverURL.
    let account = serverURL.absoluteString
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.passwd-sso.server-trust",
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: false,
      kSecValueData as String: legacyJSON,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    XCTAssertEqual(keychain.add(query: query), errSecSuccess)

    let first = try await service.currentPin(for: serverURL)
    XCTAssertEqual(first?.tlsLeafKeySHA256, Data(repeating: 0x22, count: 32))

    // After read, the on-disk JSON should be re-encoded with the new key.
    let readQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.passwd-sso.server-trust",
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: false,
      kSecReturnData as String: true,
    ]
    let (status, data) = keychain.copyMatching(query: readQuery)
    XCTAssertEqual(status, errSecSuccess)
    let stored = String(data: data ?? Data(), encoding: .utf8) ?? ""
    XCTAssertTrue(stored.contains("tlsLeafKeySHA256"),
                  "after currentPin(), JSON must be upgraded to the new key")
    XCTAssertFalse(stored.contains("tlsSPKISHA256"),
                   "after migration, legacy alias must be gone")
  }

  func testDifferentServerURLsStoredSeparately() async throws {
    let url1 = URL(string: "https://server1.example")!
    let url2 = URL(string: "https://server2.example")!
    let pin1 = PinSet(
      aasaSHA256: Data(repeating: 0xAA, count: 32),
      tlsLeafKeySHA256: Data(repeating: 0xAB, count: 32)
    )
    let pin2 = PinSet(
      aasaSHA256: Data(repeating: 0xCC, count: 32),
      tlsLeafKeySHA256: Data(repeating: 0xCD, count: 32)
    )

    try await service.pin(for: url1, pin1)
    try await service.pin(for: url2, pin2)

    let p1 = try await service.currentPin(for: url1)
    let p2 = try await service.currentPin(for: url2)
    XCTAssertEqual(p1, pin1)
    XCTAssertEqual(p2, pin2)
  }
}
