import Foundation
import XCTest

@testable import PasswdSSOApp
@testable import Shared

// Uses FakeKeychain (HostTokenStoreTests.swift), MockURLProtocol/makeSession/
// httpResponse (MobileAPIClientTests.swift), FakeSigner (DPoPProofBuilderTests).

final class AutofillTokenRefresherTests: XCTestCase {
  private let serverURL = URL(string: "https://test.passwd-sso.example")!
  private let knownJWK: [String: String] = [
    "kty": "EC", "crv": "P-256",
    "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ]
  private let extensionJWK: [String: String] = [
    "kty": "EC", "crv": "P-256", "x": "xExt", "y": "yExt",
  ]

  private var keychain: FakeKeychain!
  private var hostTokenStore: HostTokenStore!
  private var uploadTokenStore: UploadTokenStore!
  private var session: URLSession!

  override func setUp() {
    super.setUp()
    keychain = FakeKeychain()
    hostTokenStore = HostTokenStore(service: "com.test.refresher-host", keychain: keychain)
    uploadTokenStore = UploadTokenStore(service: "com.test.refresher-upload", keychain: keychain)
    session = makeSession()
    MockURLProtocol.requestHandler = nil
  }

  private func makeRefresher() -> AutofillTokenRefresher {
    let apiClient = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: hostTokenStore,
      urlSession: session
    )
    let jwk = extensionJWK
    return AutofillTokenRefresher(
      apiClient: apiClient,
      uploadTokenStore: uploadTokenStore,
      hostTokenStore: hostTokenStore,
      extensionJWKProvider: { jwk }
    )
  }

  private func seedHostAccessToken() {
    try? hostTokenStore.saveTokens(
      access: "host_acc", refresh: "host_ref", expiresAt: Date().addingTimeInterval(3600)
    )
  }

  func testRefreshMintsAndStagesTokenWithHostNonce() async throws {
    seedHostAccessToken()
    try hostTokenStore.saveNonce("host-nonce-1")

    var capturedRequest: URLRequest?
    var capturedBody: Data?
    let mintURL = serverURL.appending(path: "/api/mobile/autofill-token", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { request in
      capturedRequest = request
      capturedBody = readStream(request.httpBodyStream)
      let json = #"{"token":"up_tok_1","expiresAt":"2026-06-13T01:23:45.678Z","scope":["passwords:write"],"cnfJkt":"jkt1"}"#
      return (Data(json.utf8), httpResponse(status: 201, url: mintURL))
    }

    await makeRefresher().refresh()

    let req = try XCTUnwrap(capturedRequest)
    XCTAssertEqual(req.url?.path, "/api/mobile/autofill-token")
    XCTAssertEqual(req.httpMethod, "POST")
    XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer host_acc")
    // The request body carries the EXTENSION's JWK (not the host's).
    let body = try XCTUnwrap(capturedBody)
    let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: [String: String]])
    XCTAssertEqual(obj["jwk"], extensionJWK)

    let stored = try XCTUnwrap(try uploadTokenStore.load())
    XCTAssertEqual(stored.token, "up_tok_1")
    XCTAssertEqual(stored.dpopNonce, "host-nonce-1", "host nonce must be staged alongside the token (S5)")
    let expected = try XCTUnwrap(AutofillTokenRefresher.parseISO8601("2026-06-13T01:23:45.678Z"))
    XCTAssertEqual(stored.expiresAt.timeIntervalSince1970, expected.timeIntervalSince1970, accuracy: 1)
  }

  func testRefreshFailureLeavesStoreEmptyAndDoesNotThrow() async throws {
    seedHostAccessToken()
    let mintURL = serverURL.appending(path: "/api/mobile/autofill-token", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { _ in
      (Data(), httpResponse(status: 500, url: mintURL))
    }

    await makeRefresher().refresh()

    XCTAssertNil(try uploadTokenStore.load())
  }

  func testRefreshWithoutHostTokenIsNoOp() async throws {
    MockURLProtocol.requestHandler = { _ in
      XCTFail("no request expected without a host access token")
      throw URLError(.unknown)
    }

    await makeRefresher().refresh()

    XCTAssertNil(try uploadTokenStore.load())
  }

  func testParseISO8601AcceptsFractionalAndWholeSeconds() {
    XCTAssertNotNil(AutofillTokenRefresher.parseISO8601("2026-06-13T01:23:45.678Z"))
    XCTAssertNotNil(AutofillTokenRefresher.parseISO8601("2026-06-13T01:23:45Z"))
    XCTAssertNil(AutofillTokenRefresher.parseISO8601("not-a-date"))
  }

  // MARK: - diagnosticSummary (secret-free, case-distinguishing log labels)

  func testDiagnosticSummaryNamesTheFailureMode() {
    XCTAssertEqual(
      AutofillTokenRefresher.diagnosticSummary(for: MobileAPIError.authenticationRequired),
      "authenticationRequired")
    XCTAssertEqual(
      AutofillTokenRefresher.diagnosticSummary(for: MobileAPIError.serverError(status: 503)),
      "serverError(503)")
    XCTAssertEqual(
      AutofillTokenRefresher.diagnosticSummary(for: MobileAPIError.dpopInvalid(newNonce: "n")),
      "dpopInvalid")
  }

  /// The DPoP nonce (though non-secret) and any error value beyond the plain
  /// status/code must never appear in the label — the whole point of the summary
  /// is a fixed vocabulary that cannot leak state.
  func testDiagnosticSummaryOmitsDPoPNonceValue() {
    let summary = AutofillTokenRefresher.diagnosticSummary(
      for: MobileAPIError.dpopInvalid(newNonce: "super-secret-nonce"))
    XCTAssertFalse(summary.contains("super-secret-nonce"))
  }

  /// A non-MobileAPIError falls back to its TYPE name only, never its value.
  func testDiagnosticSummaryFallsBackToTypeForOtherErrors() {
    let summary = AutofillTokenRefresher.diagnosticSummary(
      for: URLError(.notConnectedToInternet))
    XCTAssertTrue(summary.hasPrefix("other("))
  }
}
