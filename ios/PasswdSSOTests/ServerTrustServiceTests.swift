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
    let existsBeforeClear = await service.currentPinExists(for: serverURL)
    XCTAssertTrue(existsBeforeClear)

    try service.clearPin(for: serverURL)

    let existsAfterClear = await service.currentPinExists(for: serverURL)
    XCTAssertFalse(existsAfterClear)
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
    let existsBeforePin = await service.currentPinExists(for: serverURL)
    XCTAssertFalse(existsBeforePin)
    try await service.pin(
      for: serverURL,
      PinSet(aasaSHA256: Data(), tlsLeafKeySHA256: Data(repeating: 0x01, count: 32))
    )
    let existsAfterPin = await service.currentPinExists(for: serverURL)
    XCTAssertTrue(existsAfterPin)
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

  // MARK: - Typed pin-mismatch boundary (probe seam → outcome routing)
  //
  // The delegate's authoritative mismatch flag can only be set by a real TLS
  // handshake (MockURLProtocol never drives the server-trust challenge), so
  // these tests inject the probe outcome the delegate would produce and assert
  // that `probePinnedIdentity` / `establishTrust` / `reestablishTrust` route it
  // into the correct typed result — the security boundary added by this branch.

  private let healthURL = URL(string: "https://passwd-sso.example/api/health/live")!
  private let capturedHash = Data(repeating: 0xAB, count: 32)

  /// Build a service whose probe returns a fixed outcome, pre-seeded with a pin.
  private func serviceWithProbe(
    seededPin: PinSet?,
    probe: @escaping @Sendable (URLSession, LeafKeyPinningDelegate, URL) async throws -> Data
  ) async throws -> ServerTrustService {
    let svc = ServerTrustService(keychain: keychain, leafKeyProbe: probe)
    if let seededPin {
      try await svc.pin(for: serverURL, seededPin)
    }
    return svc
  }

  private func pinSet(_ byte: UInt8) -> PinSet {
    PinSet(aasaSHA256: Data(), tlsLeafKeySHA256: Data(repeating: byte, count: 32))
  }

  // --- probePinnedIdentity: match / mismatch / unreachable / pinMissing ---

  func testProbePinnedIdentityReturnsMatchWhenProbeSucceeds() async throws {
    let hash = capturedHash
    let svc = try await serviceWithProbe(seededPin: pinSet(0x11)) { _, _, _ in
      hash
    }
    let result = await svc.probePinnedIdentity(for: serverURL, healthURL: healthURL)
    XCTAssertEqual(result, .match)
  }

  func testProbePinnedIdentityReturnsMismatchOnPinMismatch() async throws {
    // The delegate would set pinMismatchDetected → networkLeafKeyProbe throws
    // .pinMismatch. probePinnedIdentity must translate that to .mismatch.
    let svc = try await serviceWithProbe(seededPin: pinSet(0x22)) { _, _, _ in
      throw ServerTrustError.pinMismatch
    }
    let result = await svc.probePinnedIdentity(for: serverURL, healthURL: healthURL)
    XCTAssertEqual(result, .mismatch, "a delegate-detected key rejection must route to .mismatch")
  }

  func testProbePinnedIdentityReturnsUnreachableOnConnectivityError() async throws {
    // A genuine offline/timeout failure surfaces as URLError, NOT pinMismatch:
    // the pin is presumed intact so the cached vault stays usable.
    let svc = try await serviceWithProbe(seededPin: pinSet(0x33)) { _, _, _ in
      throw URLError(.notConnectedToInternet)
    }
    let result = await svc.probePinnedIdentity(for: serverURL, healthURL: healthURL)
    XCTAssertEqual(result, .unreachable, "a connectivity failure must NOT be treated as an identity change")
  }

  func testProbePinnedIdentityReturnsUnreachableOnNonMismatchTrustError() async throws {
    // e.g. tlsKeyUnavailable / invalidHealthResponse — not an identity change.
    let svc = try await serviceWithProbe(seededPin: pinSet(0x34)) { _, _, _ in
      throw ServerTrustError.invalidHealthResponse
    }
    let result = await svc.probePinnedIdentity(for: serverURL, healthURL: healthURL)
    XCTAssertEqual(result, .unreachable)
  }

  func testProbePinnedIdentityReturnsPinMissingWhenUnpinned() async throws {
    let svc = try await serviceWithProbe(seededPin: nil) { _, _, _ in
      XCTFail("probe must not run when no pin is stored")
      return Data()
    }
    let result = await svc.probePinnedIdentity(for: serverURL, healthURL: healthURL)
    XCTAssertEqual(result, .pinMissing)
  }

  // --- establishTrust: pinMismatch propagates; existing pin never replaced ---

  func testEstablishTrustPropagatesPinMismatch() async throws {
    let existing = pinSet(0x44)
    let svc = try await serviceWithProbe(seededPin: existing) { _, _, _ in
      throw ServerTrustError.pinMismatch
    }
    do {
      try await svc.establishTrust(serverURL: serverURL, healthURL: healthURL)
      XCTFail("establishTrust must rethrow the delegate's pinMismatch")
    } catch let error as ServerTrustError {
      XCTAssertEqual(error, .pinMismatch)
    }
    let stored = try await svc.currentPin(for: serverURL)
    XCTAssertEqual(stored, existing, "a mismatched probe must leave the existing pin untouched")
  }

  func testEstablishTrustPinsOnFirstUse() async throws {
    let hash = capturedHash
    let svc = try await serviceWithProbe(seededPin: nil) { _, _, _ in hash }
    try await svc.establishTrust(serverURL: serverURL, healthURL: healthURL)
    let stored = try await svc.currentPin(for: serverURL)
    XCTAssertEqual(stored?.tlsLeafKeySHA256, capturedHash, "first-use trust must persist the captured leaf key")
  }

  func testEstablishTrustKeepsExistingPinOnSuccess() async throws {
    // With a pin already stored, a successful probe must NOT overwrite it.
    let existing = pinSet(0x55)
    let svc = try await serviceWithProbe(seededPin: existing) { _, _, _ in
      Data(repeating: 0x99, count: 32)  // a different observed key
    }
    try await svc.establishTrust(serverURL: serverURL, healthURL: healthURL)
    let stored = try await svc.currentPin(for: serverURL)
    XCTAssertEqual(stored, existing, "establishTrust must never silently replace an existing pin")
  }

  // --- reestablishTrust: overwrites only after the probe succeeds ---

  func testReestablishTrustOverwritesPinOnSuccess() async throws {
    let old = pinSet(0x66)
    let newHash = Data(repeating: 0x77, count: 32)
    let svc = try await serviceWithProbe(seededPin: old) { _, _, _ in newHash }
    try await svc.reestablishTrust(serverURL: serverURL, healthURL: healthURL)
    let stored = try await svc.currentPin(for: serverURL)
    XCTAssertEqual(stored?.tlsLeafKeySHA256, newHash, "a user-approved rotation must persist the new key")
  }

  func testReestablishTrustKeepsOldPinWhenProbeThrows() async throws {
    let old = pinSet(0x88)
    let svc = try await serviceWithProbe(seededPin: old) { _, _, _ in
      throw URLError(.cannotConnectToHost)
    }
    do {
      try await svc.reestablishTrust(serverURL: serverURL, healthURL: healthURL)
      XCTFail("reestablishTrust must throw when the probe fails")
    } catch {
      // expected
    }
    let stored = try await svc.currentPin(for: serverURL)
    XCTAssertEqual(stored, old, "a failed re-verification must leave the old pin intact (no unpinned window)")
  }

  // MARK: - mapProbeFailure (the on-path translation the network probe runs)
  //
  // The seam tests above inject the probe outcome, so they bypass the real
  // pinMismatchDetected -> .pinMismatch translation inside networkLeafKeyProbe.
  // These lock that exact translation, which the production probe calls
  // directly -- so deleting the delegate's flagMismatch(), or inverting the
  // pinMismatchDetected check, now breaks a test instead of passing silently.

  func testMapProbeFailureReturnsPinMismatchWhenFlagged() {
    let underlying = URLError(.cancelled)  // what a cancelled TLS challenge looks like
    let mapped = ServerTrustService.mapProbeFailure(underlying, pinMismatchDetected: true)
    XCTAssertEqual(mapped as? ServerTrustError, .pinMismatch,
                   "a delegate-flagged rejection must translate to .pinMismatch")
  }

  func testMapProbeFailurePassesThroughWhenNotFlagged() {
    let underlying = URLError(.notConnectedToInternet)
    let mapped = ServerTrustService.mapProbeFailure(underlying, pinMismatchDetected: false)
    XCTAssertEqual(mapped as? URLError, underlying,
                   "a genuine connectivity failure must pass through unchanged, NOT become .pinMismatch")
  }
}
