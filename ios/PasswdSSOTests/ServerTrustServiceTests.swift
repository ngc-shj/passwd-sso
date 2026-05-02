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
      tlsSPKISHA256: Data(repeating: 0xBB, count: 32)
    )
    try await service.pin(for: serverURL, pinSet)

    let current = try await service.currentPin(for: serverURL)
    let retrieved = try XCTUnwrap(current)
    XCTAssertEqual(retrieved, pinSet)
  }

  func testValidateReturnsUnpinnedOnFirstUse() async {
    let observed = PinSet(
      aasaSHA256: Data(repeating: 0x01, count: 32),
      tlsSPKISHA256: Data(repeating: 0x02, count: 32)
    )
    let result = await service.validate(serverURL: serverURL, observed: observed)
    XCTAssertEqual(result, .unpinned)
  }

  func testValidateReturnsMatchWhenEqual() async throws {
    let pinSet = PinSet(
      aasaSHA256: Data(repeating: 0xCC, count: 32),
      tlsSPKISHA256: Data(repeating: 0xDD, count: 32)
    )
    try await service.pin(for: serverURL, pinSet)

    let result = await service.validate(serverURL: serverURL, observed: pinSet)
    XCTAssertEqual(result, .match)
  }

  func testValidateReturnsMismatchWhenDifferent() async throws {
    let stored = PinSet(
      aasaSHA256: Data(repeating: 0xEE, count: 32),
      tlsSPKISHA256: Data(repeating: 0xFF, count: 32)
    )
    try await service.pin(for: serverURL, stored)

    let observed = PinSet(
      aasaSHA256: Data(repeating: 0x11, count: 32),
      tlsSPKISHA256: Data(repeating: 0x22, count: 32)
    )
    let result = await service.validate(serverURL: serverURL, observed: observed)
    XCTAssertEqual(result, .mismatch(stored: stored, observed: observed))
  }

  func testPinOverwrite() async throws {
    let original = PinSet(
      aasaSHA256: Data(repeating: 0x01, count: 32),
      tlsSPKISHA256: Data(repeating: 0x02, count: 32)
    )
    let updated = PinSet(
      aasaSHA256: Data(repeating: 0x03, count: 32),
      tlsSPKISHA256: Data(repeating: 0x04, count: 32)
    )
    try await service.pin(for: serverURL, original)
    try await service.pin(for: serverURL, updated)

    let result = await service.validate(serverURL: serverURL, observed: updated)
    XCTAssertEqual(result, .match)
  }

  func testDifferentServerURLsStoredSeparately() async throws {
    let url1 = URL(string: "https://server1.example")!
    let url2 = URL(string: "https://server2.example")!
    let pin1 = PinSet(
      aasaSHA256: Data(repeating: 0xAA, count: 32),
      tlsSPKISHA256: Data(repeating: 0xAB, count: 32)
    )
    let pin2 = PinSet(
      aasaSHA256: Data(repeating: 0xCC, count: 32),
      tlsSPKISHA256: Data(repeating: 0xCD, count: 32)
    )

    try await service.pin(for: url1, pin1)
    try await service.pin(for: url2, pin2)

    let p1 = try await service.currentPin(for: url1)
    let p2 = try await service.currentPin(for: url2)
    XCTAssertEqual(p1, pin1)
    XCTAssertEqual(p2, pin2)
  }
}
