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

  func testHealthResponseAccepts200JSONWithStatusAlive() throws {
    let url = URL(string: "https://passwd-sso.example/api/health/live")!
    let response = try XCTUnwrap(HTTPURLResponse(
      url: url,
      statusCode: 200,
      httpVersion: nil,
      headerFields: ["Content-Type": "application/json; charset=utf-8"]
    ))
    XCTAssertTrue(isValidPasswdSSOHealthResponse(
      data: Data(#"{"status":"alive"}"#.utf8),
      response: response
    ))
  }

  /// Adding fields to /api/health/live must NOT lock out an older client, so an
  /// extra key alongside `status: alive` is still accepted (cross-repo drift).
  func testHealthResponseAcceptsExtraFieldsAlongsideStatus() throws {
    let url = URL(string: "https://passwd-sso.example/api/health/live")!
    let response = try XCTUnwrap(HTTPURLResponse(
      url: url, statusCode: 200, httpVersion: nil,
      headerFields: ["Content-Type": "application/json"]
    ))
    XCTAssertTrue(isValidPasswdSSOHealthResponse(
      data: Data(#"{"status":"alive","version":"1.2.3"}"#.utf8), response: response))
  }

  func testHealthResponseRejects404HTMLAndMissingStatus() throws {
    let url = URL(string: "https://passwd-sso.example/api/health/live")!
    let notFound = try XCTUnwrap(HTTPURLResponse(
      url: url, statusCode: 404, httpVersion: nil,
      headerFields: ["Content-Type": "application/json"]
    ))
    let html = try XCTUnwrap(HTTPURLResponse(
      url: url, statusCode: 200, httpVersion: nil,
      headerFields: ["Content-Type": "text/html"]
    ))
    let json = try XCTUnwrap(HTTPURLResponse(
      url: url, statusCode: 200, httpVersion: nil,
      headerFields: ["Content-Type": "application/json"]
    ))

    XCTAssertFalse(isValidPasswdSSOHealthResponse(
      data: Data(#"{"status":"alive"}"#.utf8), response: notFound))
    XCTAssertFalse(isValidPasswdSSOHealthResponse(
      data: Data("<html>login</html>".utf8), response: html))
    // status marker absent → reject (generic 2xx JSON page).
    XCTAssertFalse(isValidPasswdSSOHealthResponse(
      data: Data(#"{"ok":true}"#.utf8), response: json))
    // wrong status value → reject.
    XCTAssertFalse(isValidPasswdSSOHealthResponse(
      data: Data(#"{"status":"degraded"}"#.utf8), response: json))
  }

  // MARK: - pinnedSession / clearPin fail-closed paths

  func testPinnedSessionThrowsPinMissingWhenUnpinned() async {
    do {
      _ = try await service.pinnedSession(for: serverURL)
      XCTFail("pinnedSession must throw when no pin is stored")
    } catch let error as ServerTrustError {
      XCTAssertEqual(error, .pinMissing)
    } catch {
      XCTFail("unexpected error: \(error)")
    }
  }

  func testPinnedSessionSucceedsWhenPinned() async throws {
    let pinSet = PinSet(
      aasaSHA256: Data(),
      tlsLeafKeySHA256: Data(repeating: 0xBB, count: 32)
    )
    try await service.pin(for: serverURL, pinSet)
    _ = try await service.pinnedSession(for: serverURL)
  }

  func testClearPinRemovesStoredPin() async throws {
    let pinSet = PinSet(
      aasaSHA256: Data(),
      tlsLeafKeySHA256: Data(repeating: 0xCD, count: 32)
    )
    try await service.pin(for: serverURL, pinSet)
    XCTAssertTrue(await service.currentPinExists(for: serverURL))

    try service.clearPin(for: serverURL)

    XCTAssertFalse(await service.currentPinExists(for: serverURL))
    // After clearing, pinnedSession must fail closed again.
    do {
      _ = try await service.pinnedSession(for: serverURL)
      XCTFail("pinnedSession must throw after clearPin")
    } catch let error as ServerTrustError {
      XCTAssertEqual(error, .pinMissing)
    }
  }

  func testClearPinOnAbsentPinIsNoOp() throws {
    // errSecItemNotFound must not surface as an error.
    XCTAssertNoThrow(try service.clearPin(for: serverURL))
  }

  // MARK: - reestablishTrust atomicity (re-verify must not drop the old pin on failure)

  func testReestablishTrustKeepsOldPinWhenProbeFails() async throws {
    let original = PinSet(
      aasaSHA256: Data(),
      tlsLeafKeySHA256: Data(repeating: 0x7A, count: 32)
    )
    // Pin against a routable-but-dead address so the health probe fails fast.
    let deadURL = URL(string: "https://127.0.0.1:1")!
    try await service.pin(for: deadURL, original)

    do {
      try await service.reestablishTrust(
        serverURL: deadURL,
        healthURL: deadURL.appending(path: "api/health/live", directoryHint: .notDirectory)
      )
      XCTFail("reestablishTrust must throw when the probe cannot reach the server")
    } catch {
      // expected — connection refused / TLS failure
    }

    // The OLD pin must still be intact — a failed re-verification is NOT a clear.
    let stored = try await service.currentPin(for: deadURL)
    XCTAssertEqual(stored, original,
                   "a failed reestablishTrust must leave the existing pin unchanged (no lockout, no unpinned window)")
  }

  func testCurrentPinExistsReflectsStoredState() async throws {
    XCTAssertFalse(await service.currentPinExists(for: serverURL))
    try await service.pin(
      for: serverURL,
      PinSet(aasaSHA256: Data(), tlsLeafKeySHA256: Data(repeating: 0x01, count: 32))
    )
    XCTAssertTrue(await service.currentPinExists(for: serverURL))
  }

  // MARK: - LeafKeyPinningDelegate redirect guard (F2 — plain-value, no SecTrust)

  private func makeRedirectResponse() throws -> HTTPURLResponse {
    try XCTUnwrap(HTTPURLResponse(
      url: URL(string: "https://passwd-sso.example/api/health/live")!,
      statusCode: 302, httpVersion: nil, headerFields: nil
    ))
  }

  func testRedirectAllowsSameHostHTTPS() async throws {
    let delegate = LeafKeyPinningDelegate(expectedHost: "passwd-sso.example")
    let response = try makeRedirectResponse()
    let newRequest = URLRequest(url: URL(string: "https://passwd-sso.example/other")!)

    let forwarded = await withCheckedContinuation { continuation in
      delegate.urlSession(
        URLSession.shared, task: URLSession.shared.dataTask(with: URL(string: "https://x")!),
        willPerformHTTPRedirection: response, newRequest: newRequest
      ) { continuation.resume(returning: $0) }
    }
    XCTAssertNotNil(forwarded, "same-host HTTPS redirect must be forwarded")
  }

  func testRedirectRejectsHTTPDowngrade() async throws {
    let delegate = LeafKeyPinningDelegate(expectedHost: "passwd-sso.example")
    let response = try makeRedirectResponse()
    let newRequest = URLRequest(url: URL(string: "http://passwd-sso.example/other")!)

    let forwarded = await withCheckedContinuation { continuation in
      delegate.urlSession(
        URLSession.shared, task: URLSession.shared.dataTask(with: URL(string: "https://x")!),
        willPerformHTTPRedirection: response, newRequest: newRequest
      ) { continuation.resume(returning: $0) }
    }
    XCTAssertNil(forwarded, "http:// downgrade redirect must be blocked")
  }

  func testRedirectRejectsCrossHost() async throws {
    let delegate = LeafKeyPinningDelegate(expectedHost: "passwd-sso.example")
    let response = try makeRedirectResponse()
    let newRequest = URLRequest(url: URL(string: "https://evil.example/other")!)

    let forwarded = await withCheckedContinuation { continuation in
      delegate.urlSession(
        URLSession.shared, task: URLSession.shared.dataTask(with: URL(string: "https://x")!),
        willPerformHTTPRedirection: response, newRequest: newRequest
      ) { continuation.resume(returning: $0) }
    }
    XCTAssertNil(forwarded, "cross-host redirect must be blocked")
  }
}
