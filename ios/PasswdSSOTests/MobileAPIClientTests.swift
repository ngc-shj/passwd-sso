import Foundation
import XCTest

@testable import PasswdSSOApp
@testable import Shared

// MARK: - MockURLProtocol

final class MockURLProtocol: URLProtocol, @unchecked Sendable {
  // Set this before each test to control mock behavior.
  // nonisolated(unsafe): test-only mutable global; tests run serially.
  nonisolated(unsafe) static var requestHandler: ((URLRequest) throws -> (Data, HTTPURLResponse))?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let handler = MockURLProtocol.requestHandler else {
      client?.urlProtocol(self, didFailWithError: URLError(.unknown))
      return
    }
    do {
      let (data, response) = try handler(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

// MARK: - Helpers

func makeSession() -> URLSession {
  let config = URLSessionConfiguration.ephemeral
  config.protocolClasses = [MockURLProtocol.self]
  return URLSession(configuration: config)
}

func tokenResponseJSON(
  accessToken: String = "acc_test",
  refreshToken: String = "ref_test",
  expiresIn: Int = 86400
) -> Data {
  """
  {"access_token":"\(accessToken)","refresh_token":"\(refreshToken)","expires_in":\(expiresIn),"token_type":"DPoP"}
  """.data(using: .utf8)!
}

func httpResponse(status: Int, url: URL, headers: [String: String] = [:]) -> HTTPURLResponse {
  HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
}

/// Read all bytes from an InputStream (URLProtocol replaces httpBody with httpBodyStream).
func readStream(_ stream: InputStream?) -> Data? {
  guard let stream else { return nil }
  stream.open()
  defer { stream.close() }
  var result = Data()
  let bufferSize = 1024
  let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
  defer { buffer.deallocate() }
  while stream.hasBytesAvailable {
    let read = stream.read(buffer, maxLength: bufferSize)
    if read <= 0 { break }
    result.append(buffer, count: read)
  }
  return result.isEmpty ? nil : result
}

// MARK: - Tests

final class MobileAPIClientTests: XCTestCase {
  private var keychain: FakeKeychain!
  private var tokenStore: HostTokenStore!
  private var session: URLSession!

  private let serverURL = URL(string: "https://test.passwd-sso.example")!
  private let knownJWK: [String: String] = [
    "kty": "EC", "crv": "P-256",
    "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ]

  override func setUp() {
    super.setUp()
    keychain = FakeKeychain()
    tokenStore = HostTokenStore(service: "com.test.mobile-api", keychain: keychain)
    session = makeSession()
    MockURLProtocol.requestHandler = nil
  }

  // MARK: - exchangeBridgeCode

  func testExchangeBridgeCode_requestBodyShape() async throws {
    var capturedRequest: URLRequest?
    let tokenURL = serverURL.appending(path: "/api/mobile/token", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { request in
      capturedRequest = request
      return (tokenResponseJSON(), httpResponse(status: 200, url: tokenURL))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    _ = try await client.exchangeBridgeCode(
      code: "aabbcc",
      codeVerifier: "verifier123",
      deviceJkt: "spkiBase64"
    )

    let req = try XCTUnwrap(capturedRequest)
    // URLProtocol may replace httpBody with httpBodyStream — read from either.
    let bodyData = try XCTUnwrap(req.httpBody ?? readStream(req.httpBodyStream))
    let body = try JSONDecoder().decode([String: String].self, from: bodyData)

    XCTAssertEqual(body["code"], "aabbcc")
    XCTAssertEqual(body["code_verifier"], "verifier123")
    XCTAssertEqual(body["device_jkt"], "spkiBase64")
  }

  func testExchangeBridgeCode_dpopHeaderIsSet() async throws {
    var capturedRequest: URLRequest?
    let tokenURL = serverURL.appending(path: "/api/mobile/token", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { request in
      capturedRequest = request
      return (tokenResponseJSON(), httpResponse(status: 200, url: tokenURL))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    _ = try await client.exchangeBridgeCode(
      code: "code",
      codeVerifier: "verifier",
      deviceJkt: "pubkey"
    )

    let req = try XCTUnwrap(capturedRequest)
    XCTAssertNotNil(req.value(forHTTPHeaderField: "DPoP"),
                    "DPoP header must be set on token request")
  }

  func testExchangeBridgeCode_persistsTokensOnSuccess() async throws {
    let tokenURL = serverURL.appending(path: "/api/mobile/token", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { _ in
      return (tokenResponseJSON(accessToken: "acc_stored", refreshToken: "ref_stored"),
              httpResponse(status: 200, url: tokenURL))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    let response = try await client.exchangeBridgeCode(
      code: "code", codeVerifier: "verifier", deviceJkt: "pubkey")

    XCTAssertEqual(response.accessToken, "acc_stored")
    XCTAssertEqual(response.refreshToken, "ref_stored")
  }

  func testExchangeBridgeCode_nonceStoredFromResponseHeader() async throws {
    let tokenURL = serverURL.appending(path: "/api/mobile/token", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { _ in
      return (tokenResponseJSON(),
              httpResponse(status: 200, url: tokenURL, headers: ["DPoP-Nonce": "server-nonce-1"]))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    _ = try await client.exchangeBridgeCode(code: "code", codeVerifier: "verifier", deviceJkt: "pub")

    let nonce = try XCTUnwrap(try tokenStore.loadNonce())
    XCTAssertEqual(nonce, "server-nonce-1")
  }

  func testExchangeBridgeCode_retriesOnceWith401AndNewNonce() async throws {
    let tokenURL = serverURL.appending(path: "/api/mobile/token", directoryHint: .notDirectory)
    var callCount = 0

    MockURLProtocol.requestHandler = { request in
      callCount += 1
      if callCount == 1 {
        // First call: 401 + new nonce
        return (Data(),
                httpResponse(status: 401, url: tokenURL, headers: ["DPoP-Nonce": "nonce-for-retry"]))
      } else {
        // Retry with new nonce: 200
        return (tokenResponseJSON(), httpResponse(status: 200, url: tokenURL))
      }
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    _ = try await client.exchangeBridgeCode(code: "code", codeVerifier: "verifier", deviceJkt: "pub")
    XCTAssertEqual(callCount, 2, "Client should retry exactly once after 401+nonce")
  }

  func testExchangeBridgeCode_throws429AsRateLimited() async throws {
    let tokenURL = serverURL.appending(path: "/api/mobile/token", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { _ in
      return (Data(), httpResponse(status: 429, url: tokenURL))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    do {
      _ = try await client.exchangeBridgeCode(code: "code", codeVerifier: "verifier", deviceJkt: "pub")
      XCTFail("Expected rateLimited error")
    } catch MobileAPIError.rateLimited {
      // Expected.
    }
  }

  func testExchangeBridgeCode_throws400AsBridgeCodeInvalid() async throws {
    let tokenURL = serverURL.appending(path: "/api/mobile/token", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { _ in
      return (Data(), httpResponse(status: 400, url: tokenURL))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    do {
      _ = try await client.exchangeBridgeCode(code: "bad", codeVerifier: "ver", deviceJkt: "pub")
      XCTFail("Expected bridgeCodeInvalid error")
    } catch MobileAPIError.bridgeCodeInvalid {
      // Expected.
    }
  }

  // MARK: - refreshToken DPoP scheme (C13.2 / T11 / RT4)

  /// Verifies that refreshToken() sends Authorization: DPoP <refreshToken>
  /// (not Bearer). The refresh route extracts via /^DPoP\s+/ (extractDpopBearer).
  func testRefreshToken_usesDPoPScheme() async throws {
    let refreshToken = "ref_dpop_test"
    try? tokenStore.saveTokens(
      access: "acc_dpop_test",
      refresh: refreshToken,
      expiresAt: Date().addingTimeInterval(3600)
    )

    var capturedRequest: URLRequest?
    let refreshURL = serverURL.appending(
      path: "/api/mobile/token/refresh",
      directoryHint: .notDirectory
    )

    MockURLProtocol.requestHandler = { request in
      capturedRequest = request
      return (tokenResponseJSON(), httpResponse(status: 200, url: refreshURL))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    _ = try await client.refreshToken()

    let req = try XCTUnwrap(capturedRequest)

    // The refresh request must use DPoP scheme (not Bearer).
    let auth = try XCTUnwrap(req.value(forHTTPHeaderField: "Authorization"))
    XCTAssertTrue(
      auth.hasPrefix("DPoP "),
      "refreshToken must use Authorization: DPoP <refreshToken>, not Bearer"
    )
    XCTAssertFalse(
      auth.hasPrefix("Bearer "),
      "refreshToken must NOT use Bearer scheme"
    )

    // DPoP proof must also be present.
    XCTAssertNotNil(req.value(forHTTPHeaderField: "DPoP"), "DPoP proof header must be set")
  }

  // MARK: - updateEntry

  private func makeUpdateRequest() -> UpdateEntryRequest {
    let enc = EncryptedData(
      ciphertext: "aabbcc",
      iv: "112233445566778899aabbcc",
      authTag: "deadbeefdeadbeefdeadbeefdeadbeef"
    )
    return UpdateEntryRequest(
      encryptedBlob: enc,
      encryptedOverview: enc,
      keyVersion: 1,
      aadVersion: 1
    )
  }

  private func seedAccessToken() {
    try? tokenStore.saveTokens(
      access: "acc_update_test",
      refresh: "ref_update_test",
      expiresAt: Date().addingTimeInterval(3600)
    )
  }

  func testUpdateEntry_requestShape() async throws {
    seedAccessToken()

    var capturedRequest: URLRequest?
    let entryId = "entry-test-1"
    let putURL = serverURL.appending(
      path: "/api/passwords/\(entryId)", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { request in
      capturedRequest = request
      return (Data(), httpResponse(status: 200, url: putURL))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    try await client.updateEntry(entryId: entryId, body: makeUpdateRequest())

    let req = try XCTUnwrap(capturedRequest)
    XCTAssertEqual(req.httpMethod, "PUT")
    XCTAssertTrue(req.url?.path.hasSuffix("/\(entryId)") ?? false)

    // DPoP header must be present.
    XCTAssertNotNil(req.value(forHTTPHeaderField: "DPoP"))

    // Authorization header must start with "Bearer " for resource calls (C9/I1).
    let auth = try XCTUnwrap(req.value(forHTTPHeaderField: "Authorization"))
    XCTAssertTrue(auth.hasPrefix("Bearer "), "Authorization must use Bearer scheme for resource calls")

    // Body must contain all required fields.
    let bodyData = try XCTUnwrap(req.httpBody ?? readStream(req.httpBodyStream))
    let body = try JSONDecoder().decode(UpdateEntryRequest.self, from: bodyData)
    XCTAssertEqual(body.keyVersion, 1)
    XCTAssertEqual(body.aadVersion, 1)
    XCTAssertFalse(body.encryptedBlob.ciphertext.isEmpty)
    XCTAssertFalse(body.encryptedOverview.ciphertext.isEmpty)
  }

  // MARK: - resourceURL basePath preservation (m7 / C13.4)

  func testResourceURL_preservesDeploymentBasePath() async throws {
    let client = MobileAPIClient(
      serverURL: URL(string: "https://host.example/passwd-sso")!,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )
    let url = await client.resourceURL(path: "/api/passwords")
    XCTAssertEqual(
      url?.absoluteString, "https://host.example/passwd-sso/api/passwords",
      "resourceURL must keep the deployment basePath (serverURL.appending), not drop it"
    )

    let withQuery = await client.resourceURL(
      path: "/api/teams/t1/passwords", query: "include=blob")
    XCTAssertEqual(
      withQuery?.absoluteString,
      "https://host.example/passwd-sso/api/teams/t1/passwords?include=blob"
    )
    // canonicalHTU (DPoP htu) strips the query but keeps the basePath.
    let htu = await client.canonicalHTU(url: try XCTUnwrap(withQuery))
    XCTAssertEqual(htu, "https://host.example/passwd-sso/api/teams/t1/passwords")
  }

  // MARK: - fetchVaultUnlockData Bearer scheme (m5 / C13.2)

  func testFetchVaultUnlockData_usesBearerScheme() async throws {
    seedAccessToken()
    var capturedRequest: URLRequest?
    let url = serverURL.appending(path: "/api/vault/unlock/data", directoryHint: .notDirectory)
    let json = #"""
    {"accountSalt":"aa","encryptedSecretKey":"bb","secretKeyIv":"cc",
     "secretKeyAuthTag":"dd","keyVersion":1,"kdfType":0,"kdfIterations":600000,
     "userId":"u-1"}
    """#
    MockURLProtocol.requestHandler = { request in
      capturedRequest = request
      return (Data(json.utf8), httpResponse(status: 200, url: url))
    }
    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    _ = try await client.fetchVaultUnlockData()

    let req = try XCTUnwrap(capturedRequest)
    let auth = try XCTUnwrap(req.value(forHTTPHeaderField: "Authorization"))
    XCTAssertTrue(auth.hasPrefix("Bearer "), "vault-unlock-data must use Bearer (not DPoP) scheme")
    XCTAssertFalse(auth.hasPrefix("DPoP "))
    XCTAssertNotNil(req.value(forHTTPHeaderField: "DPoP"), "DPoP proof header must still be set")
  }

  func testUpdateEntry_athIsSHA256OfAccessToken() async throws {
    let accessToken = "acc_ath_test"
    try? tokenStore.saveTokens(access: accessToken, refresh: "ref_ath", expiresAt: Date().addingTimeInterval(3600))

    var capturedRequest: URLRequest?
    let entryId = "entry-ath"
    let putURL = serverURL.appending(
      path: "/api/passwords/\(entryId)", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { request in
      capturedRequest = request
      return (Data(), httpResponse(status: 200, url: putURL))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    try await client.updateEntry(entryId: entryId, body: makeUpdateRequest())

    let req = try XCTUnwrap(capturedRequest)
    // DPoP proof is a JWS — decode payload to verify ath claim.
    let dpop = try XCTUnwrap(req.value(forHTTPHeaderField: "DPoP"))
    let parts = dpop.split(separator: ".")
    XCTAssertEqual(parts.count, 3, "DPoP must be a 3-part JWS")

    // Decode payload (base64url, no padding).
    var b64 = String(parts[1])
    let rem = b64.count % 4
    if rem != 0 { b64 += String(repeating: "=", count: 4 - rem) }
    let payloadData = try XCTUnwrap(Data(base64Encoded: b64.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")))
    let payload = try JSONDecoder().decode([String: AnyDecodable].self, from: payloadData)

    let expectedAth = await client.sha256Base64URL(accessToken)
    XCTAssertEqual(payload["ath"]?.value as? String, expectedAth)
  }

  func testCreateEntry_athIsSHA256OfAccessTokenAndHtmIsPost() async throws {
    let accessToken = "acc_create_ath"
    try? tokenStore.saveTokens(access: accessToken, refresh: "ref_create_ath", expiresAt: Date().addingTimeInterval(3600))

    var capturedRequest: URLRequest?
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { request in
      capturedRequest = request
      return (Data(#"{"id":"e1"}"#.utf8), httpResponse(status: 201, url: createURL))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    let enc = EncryptedData(
      ciphertext: "aabbcc",
      iv: "112233445566778899aabbcc",
      authTag: "deadbeefdeadbeefdeadbeefdeadbeef"
    )
    let body = CreateEntryRequest(
      id: "e1", encryptedBlob: enc, encryptedOverview: enc,
      keyVersion: 1, aadVersion: 1, entryType: "LOGIN"
    )
    let returnedId = try await client.createEntry(body: body)
    XCTAssertEqual(returnedId, "e1")

    let req = try XCTUnwrap(capturedRequest)
    XCTAssertEqual(req.httpMethod, "POST")
    // DPoP proof JWS payload must carry ath = SHA-256(access_token) and htm = POST.
    let dpop = try XCTUnwrap(req.value(forHTTPHeaderField: "DPoP"))
    let parts = dpop.split(separator: ".")
    XCTAssertEqual(parts.count, 3, "DPoP must be a 3-part JWS")
    var b64 = String(parts[1])
    let rem = b64.count % 4
    if rem != 0 { b64 += String(repeating: "=", count: 4 - rem) }
    let payloadData = try XCTUnwrap(Data(base64Encoded: b64.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")))
    let payload = try JSONDecoder().decode([String: AnyDecodable].self, from: payloadData)
    let expectedAth = await client.sha256Base64URL(accessToken)
    XCTAssertEqual(payload["ath"]?.value as? String, expectedAth)
    XCTAssertEqual(payload["htm"]?.value as? String, "POST")
  }

  func testUpdateEntry_persistsNonceFromResponse() async throws {
    seedAccessToken()

    let entryId = "entry-nonce"
    let putURL = serverURL.appending(
      path: "/api/passwords/\(entryId)", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { _ in
      return (Data(), httpResponse(status: 200, url: putURL, headers: ["DPoP-Nonce": "nonce-upd-1"]))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    try await client.updateEntry(entryId: entryId, body: makeUpdateRequest())

    let nonce = try XCTUnwrap(try tokenStore.loadNonce())
    XCTAssertEqual(nonce, "nonce-upd-1")
  }

  func testUpdateEntry_404ThrowsNotFound() async throws {
    seedAccessToken()

    let entryId = "entry-missing"
    let putURL = serverURL.appending(
      path: "/api/passwords/\(entryId)", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { _ in
      return (Data(), httpResponse(status: 404, url: putURL))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    do {
      try await client.updateEntry(entryId: entryId, body: makeUpdateRequest())
      XCTFail("Expected notFound")
    } catch MobileAPIError.notFound {
      // Expected.
    }
  }

  func testUpdateEntry_retriesOnceWith401AndNewNonce() async throws {
    seedAccessToken()

    let entryId = "entry-retry"
    let putURL = serverURL.appending(
      path: "/api/passwords/\(entryId)", directoryHint: .notDirectory)
    var callCount = 0

    MockURLProtocol.requestHandler = { _ in
      callCount += 1
      if callCount == 1 {
        return (Data(), httpResponse(status: 401, url: putURL, headers: ["DPoP-Nonce": "retry-nonce"]))
      }
      return (Data(), httpResponse(status: 200, url: putURL))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    try await client.updateEntry(entryId: entryId, body: makeUpdateRequest())
    XCTAssertEqual(callCount, 2, "Client should retry exactly once after 401+nonce")
  }

  // MARK: - postCacheRollbackReport

  func testPostCacheRollbackReport_requestShape() async throws {
    seedAccessToken()

    var capturedRequest: URLRequest?
    let reportURL = serverURL.appending(
      path: "/api/mobile/cache-rollback-report",
      directoryHint: .notDirectory
    )

    MockURLProtocol.requestHandler = { request in
      capturedRequest = request
      return (Data(), httpResponse(status: 200, url: reportURL))
    }

    let client = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    let body = CacheRollbackReportBody(
      deviceId: "device-test-001",
      expectedCounter: 42,
      observedCounter: 99,
      headerIssuedAt: "2026-05-02T00:00:00.000Z",
      lastSuccessfulRefreshAt: nil,
      rejectionKind: "counter_mismatch"
    )
    try await client.postCacheRollbackReport(body)

    let req = try XCTUnwrap(capturedRequest)
    XCTAssertEqual(req.httpMethod, "POST")
    XCTAssertTrue(req.url?.path.hasSuffix("/cache-rollback-report") ?? false)

    // DPoP header must be present with ath.
    XCTAssertNotNil(req.value(forHTTPHeaderField: "DPoP"), "DPoP header must be set")

    // Authorization must use Bearer scheme for resource calls (C9/I1).
    let auth = try XCTUnwrap(req.value(forHTTPHeaderField: "Authorization"))
    XCTAssertTrue(auth.hasPrefix("Bearer "), "Authorization must use Bearer scheme for resource calls")

    // Body must contain all required fields.
    let bodyData = try XCTUnwrap(req.httpBody ?? readStream(req.httpBodyStream))
    let decoded = try JSONDecoder().decode(CacheRollbackReportBody.self, from: bodyData)
    XCTAssertEqual(decoded.deviceId, "device-test-001")
    XCTAssertEqual(decoded.expectedCounter, 42)
    XCTAssertEqual(decoded.observedCounter, 99)
    XCTAssertEqual(decoded.headerIssuedAt, "2026-05-02T00:00:00.000Z")
    XCTAssertNil(decoded.lastSuccessfulRefreshAt)
    XCTAssertEqual(decoded.rejectionKind, "counter_mismatch")

    // DPoP proof must contain ath claim.
    let dpop = try XCTUnwrap(req.value(forHTTPHeaderField: "DPoP"))
    let parts = dpop.split(separator: ".")
    XCTAssertEqual(parts.count, 3, "DPoP must be a 3-part JWS")

    var b64 = String(parts[1])
    let rem = b64.count % 4
    if rem != 0 { b64 += String(repeating: "=", count: 4 - rem) }
    let payloadData = try XCTUnwrap(Data(base64Encoded: b64.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")))
    let payload = try JSONDecoder().decode([String: AnyDecodable].self, from: payloadData)

    let expectedAth = await client.sha256Base64URL("acc_update_test")
    XCTAssertEqual(payload["ath"]?.value as? String, expectedAth,
                   "DPoP proof must contain ath = SHA-256(access_token)")
    XCTAssertEqual(payload["htm"]?.value as? String, "POST")
  }
}

// MARK: - Token refresh + validAccessToken tests (C0/C1/C2/C3)

final class TokenRefreshTests: XCTestCase {
  private var keychain: FakeKeychain!
  private var tokenStore: HostTokenStore!
  private var session: URLSession!

  private let serverURL = URL(string: "https://test.passwd-sso.example")!
  private let knownJWK: [String: String] = [
    "kty": "EC", "crv": "P-256",
    "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ]

  // Fixed epoch used for clock seam.
  private let fixedNow = Date(timeIntervalSince1970: 1_700_000_000)

  private var refreshCallCount = 0
  private var resourceCallCount = 0
  private var capturedRequests: [URLRequest] = []

  // Sample entries JSON for fetchEntries responses.
  private let entriesJSON = Data("""
    [{"id":"e1","encryptedOverview":{"ciphertext":"aa","iv":"112233445566778899aabbcc","authTag":"deadbeefdeadbeefdeadbeefdeadbeef"},"encryptedBlob":{"ciphertext":"bb","iv":"112233445566778899aabbcc","authTag":"deadbeefdeadbeefdeadbeefdeadbeef"},"keyVersion":1,"aadVersion":1,"entryType":"LOGIN","isFavorite":false,"isArchived":false}]
    """.utf8)

  override func setUp() {
    super.setUp()
    keychain = FakeKeychain()
    tokenStore = HostTokenStore(service: "com.test.token-refresh", keychain: keychain)
    session = makeSession()
    MockURLProtocol.requestHandler = nil
    refreshCallCount = 0
    resourceCallCount = 0
    capturedRequests = []
  }

  // Helper: make a client with the fixed clock.
  private func makeClient(fixedDate: Date? = nil) -> MobileAPIClient {
    let t = fixedDate ?? fixedNow
    return MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session,
      now: { t }
    )
  }

  // MARK: - validAccessToken: returns stored token when not expired

  func testValidAccessToken_returnsStoredTokenWhenNotExpired() async throws {
    // expiresAt = now + 3600 (well outside 60s skew).
    let expiresAt = fixedNow.addingTimeInterval(3600)
    try tokenStore.saveTokens(access: "acc_fresh", refresh: "ref_fresh", expiresAt: expiresAt)

    let refreshURL = serverURL.appending(path: "/api/mobile/token/refresh", directoryHint: .notDirectory)
    let resourceURL = serverURL.appending(path: "/api/vault/unlock/data", directoryHint: .notDirectory)
    let vaultJSON = Data("""
      {"accountSalt":"aa","encryptedSecretKey":"bb","secretKeyIv":"cc","secretKeyAuthTag":"dd","keyVersion":1,"kdfType":0,"kdfIterations":600000,"userId":"u-1"}
      """.utf8)

    MockURLProtocol.requestHandler = { [weak self] request in
      if request.url?.path == "/api/mobile/token/refresh" {
        self?.refreshCallCount += 1
        return (tokenResponseJSON(), httpResponse(status: 200, url: refreshURL))
      }
      return (vaultJSON, httpResponse(status: 200, url: resourceURL))
    }

    let client = makeClient()
    _ = try await client.fetchVaultUnlockData()

    XCTAssertEqual(refreshCallCount, 0, "Should NOT refresh when token is not expired")
  }

  // MARK: - validAccessToken: expired token triggers exactly one refresh

  func testValidAccessToken_expiredTokenTriggersOneRefresh() async throws {
    // expiresAt = now + 30 (within 60s skew → triggers refresh).
    let expiresAt = fixedNow.addingTimeInterval(30)
    try tokenStore.saveTokens(access: "acc_stale", refresh: "ref_stale", expiresAt: expiresAt)

    let refreshURL = serverURL.appending(path: "/api/mobile/token/refresh", directoryHint: .notDirectory)
    let vaultURL = serverURL.appending(path: "/api/vault/unlock/data", directoryHint: .notDirectory)
    let vaultJSON = Data("""
      {"accountSalt":"aa","encryptedSecretKey":"bb","secretKeyIv":"cc","secretKeyAuthTag":"dd","keyVersion":1,"kdfType":0,"kdfIterations":600000,"userId":"u-1"}
      """.utf8)

    MockURLProtocol.requestHandler = { [weak self] request in
      if request.url?.path == "/api/mobile/token/refresh" {
        self?.refreshCallCount += 1
        return (tokenResponseJSON(accessToken: "acc_new", refreshToken: "ref_new", expiresIn: 3600),
                httpResponse(status: 200, url: refreshURL))
      }
      self?.resourceCallCount += 1
      return (vaultJSON, httpResponse(status: 200, url: vaultURL))
    }

    let client = makeClient()
    _ = try await client.fetchVaultUnlockData()

    XCTAssertEqual(refreshCallCount, 1, "Should refresh exactly once when token is within skew")
    XCTAssertEqual(resourceCallCount, 1, "Resource endpoint must be hit exactly once after refresh")

    // Store must hold the new pair.
    let loaded = try XCTUnwrap(try tokenStore.loadAccess())
    XCTAssertEqual(loaded.token, "acc_new")
    let loadedRefresh = try XCTUnwrap(try tokenStore.loadRefresh())
    XCTAssertEqual(loadedRefresh, "ref_new")
  }

  // MARK: - validAccessToken: no token throws authenticationRequired

  func testValidAccessToken_noToken_throwsAuthenticationRequired() async throws {
    // Empty store — no token saved.
    let client = makeClient()

    MockURLProtocol.requestHandler = { [weak self] request in
      if request.url?.path == "/api/mobile/token/refresh" {
        self?.refreshCallCount += 1
        return (Data(), httpResponse(status: 401, url: request.url!))
      }
      return (Data(), httpResponse(status: 200, url: request.url!))
    }

    do {
      _ = try await client.fetchVaultUnlockData()
      XCTFail("Expected authenticationRequired")
    } catch MobileAPIError.authenticationRequired {
      // Expected.
    }
    XCTAssertEqual(refreshCallCount, 0, "No refresh should be attempted when there is no token")
  }

  // MARK: - validAccessToken: refresh endpoint 401 throws authenticationRequired

  func testValidAccessToken_refreshEndpoint401_throwsAuthenticationRequired() async throws {
    // expiresAt = now - 10 (already expired → triggers refresh).
    let expiresAt = fixedNow.addingTimeInterval(-10)
    try tokenStore.saveTokens(access: "acc_dead", refresh: "ref_dead", expiresAt: expiresAt)

    let refreshURL = serverURL.appending(path: "/api/mobile/token/refresh", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { [weak self] request in
      if request.url?.path == "/api/mobile/token/refresh" {
        self?.refreshCallCount += 1
        return (Data(), httpResponse(status: 401, url: refreshURL))
      }
      return (Data(), httpResponse(status: 200, url: request.url!))
    }

    let client = makeClient()
    do {
      _ = try await client.fetchVaultUnlockData()
      XCTFail("Expected authenticationRequired")
    } catch MobileAPIError.authenticationRequired {
      // Expected.
    }
    XCTAssertEqual(refreshCallCount, 1, "Refresh should be attempted exactly once")
  }

  // MARK: - fetchEntries: 200 happy path

  func testFetchEntries_happyPath() async throws {
    let expiresAt = fixedNow.addingTimeInterval(3600)
    try tokenStore.saveTokens(access: "acc_ok", refresh: "ref_ok", expiresAt: expiresAt)

    let resourceURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { [weak self] request in
      if request.url?.path == "/api/mobile/token/refresh" {
        self?.refreshCallCount += 1
        return (tokenResponseJSON(), httpResponse(status: 200, url: request.url!))
      }
      self?.resourceCallCount += 1
      return (self!.entriesJSON, httpResponse(status: 200, url: resourceURL))
    }

    let client = makeClient()
    let entries = try await client.fetchEntries(endpoint: "/api/passwords")

    XCTAssertEqual(entries.count, 1)
    XCTAssertEqual(entries[0].id, "e1")
    XCTAssertEqual(refreshCallCount, 0)
    XCTAssertEqual(resourceCallCount, 1)
  }

  // MARK: - fetchEntries: expired token → one refresh → 200

  func testFetchEntries_expiredToken_refreshThen200() async throws {
    let expiresAt = fixedNow.addingTimeInterval(30) // within skew
    try tokenStore.saveTokens(access: "acc_stale2", refresh: "ref_stale2", expiresAt: expiresAt)

    let refreshURL = serverURL.appending(path: "/api/mobile/token/refresh", directoryHint: .notDirectory)
    let resourceURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { [weak self] request in
      if request.url?.path == "/api/mobile/token/refresh" {
        self?.refreshCallCount += 1
        return (tokenResponseJSON(accessToken: "acc_new2", refreshToken: "ref_new2", expiresIn: 3600),
                httpResponse(status: 200, url: refreshURL))
      }
      self?.resourceCallCount += 1
      return (self!.entriesJSON, httpResponse(status: 200, url: resourceURL))
    }

    let client = makeClient()
    let entries = try await client.fetchEntries(endpoint: "/api/passwords")

    XCTAssertEqual(entries.count, 1)
    XCTAssertEqual(refreshCallCount, 1)
    XCTAssertEqual(resourceCallCount, 1)
  }

  // MARK: - fetchEntries: 401 no recovery → refresh → 200 (reactive ladder)

  func testFetchEntries_401_reactiveRefreshThen200() async throws {
    let expiresAt = fixedNow.addingTimeInterval(3600)
    try tokenStore.saveTokens(access: "acc_r", refresh: "ref_r", expiresAt: expiresAt)

    let refreshURL = serverURL.appending(path: "/api/mobile/token/refresh", directoryHint: .notDirectory)
    let resourceURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { [weak self] request in
      if request.url?.path == "/api/mobile/token/refresh" {
        self?.refreshCallCount += 1
        return (tokenResponseJSON(accessToken: "acc_r_new", refreshToken: "ref_r_new", expiresIn: 3600),
                httpResponse(status: 200, url: refreshURL))
      }
      self?.resourceCallCount += 1
      self?.capturedRequests.append(request)
      // First resource call: 401 (no nonce header → freshNonce is nil → skip nonce retry,
      // go straight to refresh). Bounded at exactly 2 resource calls + 1 refresh.
      if (self?.resourceCallCount ?? 0) == 1 {
        return (Data(), httpResponse(status: 401, url: resourceURL))
      }
      return (self!.entriesJSON, httpResponse(status: 200, url: resourceURL))
    }

    let client = makeClient()
    let entries = try await client.fetchEntries(endpoint: "/api/passwords")

    XCTAssertEqual(entries.count, 1)
    XCTAssertEqual(resourceCallCount, 2, "Resource must be hit exactly twice (initial 401 + refresh-retry)")
    XCTAssertEqual(refreshCallCount, 1, "Refresh must be called exactly once")
  }

  // MARK: - fetchEntries: refresh endpoint 401 → throws authenticationRequired (bounded)

  func testFetchEntries_refreshFails_throwsAuthenticationRequired() async throws {
    let expiresAt = fixedNow.addingTimeInterval(3600)
    try tokenStore.saveTokens(access: "acc_dead2", refresh: "ref_dead2", expiresAt: expiresAt)

    let refreshURL = serverURL.appending(path: "/api/mobile/token/refresh", directoryHint: .notDirectory)
    let resourceURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { [weak self] request in
      if request.url?.path == "/api/mobile/token/refresh" {
        self?.refreshCallCount += 1
        return (Data(), httpResponse(status: 401, url: refreshURL))
      }
      self?.resourceCallCount += 1
      // 401 with no nonce header → freshNonce is nil → nonce retry skipped → refresh attempted.
      // Refresh also returns 401 → throws authenticationRequired. Exactly 1 resource + 1 refresh.
      return (Data(), httpResponse(status: 401, url: resourceURL))
    }

    let client = makeClient()
    do {
      _ = try await client.fetchEntries(endpoint: "/api/passwords")
      XCTFail("Expected authenticationRequired")
    } catch MobileAPIError.authenticationRequired {
      // Expected.
    }
    XCTAssertEqual(resourceCallCount, 1, "Resource must be hit exactly once before refresh fails")
    XCTAssertEqual(refreshCallCount, 1, "Refresh must be attempted exactly once")
  }

  // MARK: - Reactive ath rebuild: ath changes from old to new token after refresh

  func testFetchEntries_reactiveRefresh_rebuildsAth() async throws {
    let oldToken = "acc_ath_old"
    let newToken = "acc_ath_new"
    let expiresAt = fixedNow.addingTimeInterval(3600)
    try tokenStore.saveTokens(access: oldToken, refresh: "ref_ath", expiresAt: expiresAt)

    let refreshURL = serverURL.appending(path: "/api/mobile/token/refresh", directoryHint: .notDirectory)
    let resourceURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { [weak self] request in
      if request.url?.path == "/api/mobile/token/refresh" {
        self?.refreshCallCount += 1
        return (tokenResponseJSON(accessToken: newToken, refreshToken: "ref_ath_new", expiresIn: 3600),
                httpResponse(status: 200, url: refreshURL))
      }
      self?.capturedRequests.append(request)
      self?.resourceCallCount += 1
      if (self?.resourceCallCount ?? 0) == 1 {
        return (Data(), httpResponse(status: 401, url: resourceURL))
      }
      return (self!.entriesJSON, httpResponse(status: 200, url: resourceURL))
    }

    let client = makeClient()
    _ = try await client.fetchEntries(endpoint: "/api/passwords")

    XCTAssertEqual(capturedRequests.count, 2, "Expected initial + retry request")
    let initialDPoP = try XCTUnwrap(capturedRequests[0].value(forHTTPHeaderField: "DPoP"))
    let retryDPoP = try XCTUnwrap(capturedRequests[1].value(forHTTPHeaderField: "DPoP"))

    let initialAth = try decodeDPoPAth(initialDPoP)
    let retryAth = try decodeDPoPAth(retryDPoP)

    let expectedOldAth = await client.sha256Base64URL(oldToken)
    let expectedNewAth = await client.sha256Base64URL(newToken)
    XCTAssertEqual(initialAth, expectedOldAth, "Initial ath should be SHA-256(oldToken)")
    XCTAssertEqual(retryAth, expectedNewAth, "Retry ath should be SHA-256(newToken)")
    XCTAssertNotEqual(initialAth, retryAth, "ath must change after token refresh")
  }

  // MARK: - Single-flight: two sequential fetches with expired token → refreshCallCount == 1

  func testFetchEntries_sequential_expiredToken_refreshOnce() async throws {
    let expiresAt = fixedNow.addingTimeInterval(30) // within skew
    try tokenStore.saveTokens(access: "acc_seq", refresh: "ref_seq", expiresAt: expiresAt)

    let refreshURL = serverURL.appending(path: "/api/mobile/token/refresh", directoryHint: .notDirectory)
    let resourceURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { [weak self] request in
      if request.url?.path == "/api/mobile/token/refresh" {
        self?.refreshCallCount += 1
        // expiresIn: 3600 is explicit; now is fixed, so after refresh the new token
        // expires at now+3600 (outside the 60s skew), so the second call returns without refreshing.
        return (tokenResponseJSON(accessToken: "acc_seq_new", refreshToken: "ref_seq_new", expiresIn: 3600),
                httpResponse(status: 200, url: refreshURL))
      }
      self?.resourceCallCount += 1
      return (self!.entriesJSON, httpResponse(status: 200, url: resourceURL))
    }

    let client = makeClient()
    let entries1 = try await client.fetchEntries(endpoint: "/api/passwords")
    let entries2 = try await client.fetchEntries(endpoint: "/api/passwords")

    XCTAssertEqual(entries1.count, 1)
    XCTAssertEqual(entries2.count, 1)
    XCTAssertEqual(refreshCallCount, 1, "Refresh must happen exactly once for two sequential calls")
    XCTAssertEqual(resourceCallCount, 2, "Both fetches must reach the resource endpoint")
  }

  // MARK: - Nonce-then-refresh ladder: 401+nonce → nonce-retry → still 401 → refresh → 200

  func testFetchEntries_nonceRetryThenRefreshLadder() async throws {
    let expiresAt = fixedNow.addingTimeInterval(3600)
    try tokenStore.saveTokens(access: "acc_ladder", refresh: "ref_ladder", expiresAt: expiresAt)

    let refreshURL = serverURL.appending(path: "/api/mobile/token/refresh", directoryHint: .notDirectory)
    let resourceURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)

    // Per F2: nonce-retry fires only when the CURRENT response carries a fresh DPoP-Nonce
    // (`freshNonce != nil`). Call 2 must carry a fresh nonce to trigger the nonce-retry path;
    // if call 2 carries no nonce, `didNonceRetry` stays false but `didRefreshRetry` gates
    // the refresh. The ladder is bounded at ≤3 HTTP resource calls + ≤1 refresh.
    MockURLProtocol.requestHandler = { [weak self] request in
      if request.url?.path == "/api/mobile/token/refresh" {
        self?.refreshCallCount += 1
        return (tokenResponseJSON(accessToken: "acc_ladder_new", refreshToken: "ref_ladder_new", expiresIn: 3600),
                httpResponse(status: 200, url: refreshURL))
      }
      self?.resourceCallCount += 1
      self?.capturedRequests.append(request)
      switch self?.resourceCallCount {
      case 1:
        // First call: 401 + fresh DPoP-Nonce → `freshNonce != nil` → triggers nonce retry.
        return (Data(), httpResponse(status: 401, url: resourceURL, headers: ["DPoP-Nonce": "srv-nonce-1"]))
      case 2:
        // Nonce retry: still 401 (no nonce in THIS response) → `freshNonce` is nil →
        // nonce branch skipped (`didNonceRetry` is already true anyway) → triggers refresh.
        return (Data(), httpResponse(status: 401, url: resourceURL))
      default:
        // After refresh: 200.
        return (self!.entriesJSON, httpResponse(status: 200, url: resourceURL))
      }
    }

    let client = makeClient()
    let entries = try await client.fetchEntries(endpoint: "/api/passwords")

    XCTAssertEqual(entries.count, 1)
    XCTAssertEqual(refreshCallCount, 1, "Refresh should be called exactly once")
    XCTAssertEqual(resourceCallCount, 3, "Expected: initial → nonce-retry → refresh-retry")

    // Assert the retried request (call 2) echoed the server nonce from call 1's response.
    XCTAssertEqual(capturedRequests.count, 3, "Must have captured all 3 resource requests")
    let nonceOnCall2 = try decodeDPoPNonce(
      try XCTUnwrap(capturedRequests[1].value(forHTTPHeaderField: "DPoP")))
    XCTAssertEqual(nonceOnCall2, "srv-nonce-1",
                   "Nonce-retry (call 2) must echo the server nonce returned on call 1")
  }

  // MARK: - HostTokenStore safe write order

  func testSaveTokens_safeWriteOrder_refreshBeforeAccess() throws {
    // The safe write order writes refresh first, then expiry, then access last.
    // A partial write (crash mid-sequence) must never leave a new access token paired
    // with an old refresh token (replay detection → family revoke → forced sign-out).
    // We verify the ORDER by inspecting FakeKeychain.writeLog for each write operation.
    let expiresAt = fixedNow.addingTimeInterval(3600)
    try tokenStore.saveTokens(access: "acc_safe", refresh: "ref_safe", expiresAt: expiresAt)

    // After a successful full write, both tokens should be present.
    let access = try XCTUnwrap(try tokenStore.loadAccess())
    let refresh = try XCTUnwrap(try tokenStore.loadRefresh())
    XCTAssertEqual(access.token, "acc_safe")
    XCTAssertEqual(refresh, "ref_safe")

    // Assert write ORDER: refresh_token must be written BEFORE access_token.
    let log = keychain.writeLog
    let refreshIdx = try XCTUnwrap(log.firstIndex(of: "refresh_token"),
                                   "refresh_token must appear in write log")
    let accessIdx = try XCTUnwrap(log.firstIndex(of: "access_token"),
                                  "access_token must appear in write log")
    XCTAssertLessThan(refreshIdx, accessIdx,
                      "refresh_token must be written before access_token (safe write order)")

    // Overwrite with a second pair to verify update path also maintains order.
    let expiresAt2 = fixedNow.addingTimeInterval(7200)
    try tokenStore.saveTokens(access: "acc_safe2", refresh: "ref_safe2", expiresAt: expiresAt2)
    let access2 = try XCTUnwrap(try tokenStore.loadAccess())
    let refresh2 = try XCTUnwrap(try tokenStore.loadRefresh())
    XCTAssertEqual(access2.token, "acc_safe2")
    XCTAssertEqual(refresh2, "ref_safe2")

    // Assert write ORDER also holds on update path.
    let log2 = keychain.writeLog
    let writes = log2.suffix(from: log.count) // only the second saveTokens writes
    let refreshIdx2 = try XCTUnwrap(writes.firstIndex(of: "refresh_token"),
                                    "refresh_token must appear in update log")
    let accessIdx2 = try XCTUnwrap(writes.firstIndex(of: "access_token"),
                                   "access_token must appear in update log")
    XCTAssertLessThan(refreshIdx2, accessIdx2,
                      "refresh_token must be written before access_token on update path")
  }

  // MARK: - G1: URLError on refresh endpoint surfaces as networkError (not authenticationRequired)

  func testFetchEntries_refreshNetworkError_surfacesAsNetworkError() async throws {
    // Token is expired (within skew) so a proactive refresh will be attempted.
    let expiresAt = fixedNow.addingTimeInterval(30)
    try tokenStore.saveTokens(access: "acc_netfail", refresh: "ref_netfail", expiresAt: expiresAt)

    let resourceURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { [weak self] request in
      if request.url?.path == "/api/mobile/token/refresh" {
        self?.refreshCallCount += 1
        // Simulate a network-level failure (not an HTTP error) on the refresh endpoint.
        throw URLError(.notConnectedToInternet)
      }
      self?.resourceCallCount += 1
      return (self!.entriesJSON, httpResponse(status: 200, url: resourceURL))
    }

    let client = makeClient()
    do {
      _ = try await client.fetchEntries(endpoint: "/api/passwords")
      XCTFail("Expected networkError to be thrown")
    } catch MobileAPIError.networkError(let urlError) {
      XCTAssertEqual(urlError.code, .notConnectedToInternet,
                     "URLError code must be preserved in the networkError wrapper")
    } catch MobileAPIError.authenticationRequired {
      XCTFail("URLError on refresh must NOT be reclassified as authenticationRequired")
    }
    XCTAssertEqual(refreshCallCount, 1, "Refresh must be attempted exactly once")
    XCTAssertEqual(resourceCallCount, 0,
                   "Resource endpoint must not be reached when refresh fails with network error")
  }

  // MARK: - Helpers: decode DPoP JWS payload claims

  private func decodeDPoPPayload(_ jws: String) throws -> [String: AnyDecodable] {
    let parts = jws.split(separator: ".")
    XCTAssertEqual(parts.count, 3, "DPoP must be a 3-part JWS")
    var b64 = String(parts[1])
    let rem = b64.count % 4
    if rem != 0 { b64 += String(repeating: "=", count: 4 - rem) }
    let payloadData = try XCTUnwrap(Data(base64Encoded: b64
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")))
    return try JSONDecoder().decode([String: AnyDecodable].self, from: payloadData)
  }

  private func decodeDPoPAth(_ jws: String) throws -> String {
    let payload = try decodeDPoPPayload(jws)
    return try XCTUnwrap(payload["ath"]?.value as? String)
  }

  private func decodeDPoPNonce(_ jws: String) throws -> String {
    let payload = try decodeDPoPPayload(jws)
    return try XCTUnwrap(payload["nonce"]?.value as? String,
                         "DPoP payload must contain a 'nonce' claim")
  }
}

// MARK: - AnyDecodable helper for payload inspection

private struct AnyDecodable: Decodable {
  let value: Any

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let s = try? container.decode(String.self) { value = s }
    else if let i = try? container.decode(Int.self) { value = i }
    else if let d = try? container.decode(Double.self) { value = d }
    else if let b = try? container.decode(Bool.self) { value = b }
    else { value = NSNull() }
  }
}
