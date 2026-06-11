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
