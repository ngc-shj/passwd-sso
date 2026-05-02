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

private func makeSession() -> URLSession {
  let config = URLSessionConfiguration.ephemeral
  config.protocolClasses = [MockURLProtocol.self]
  return URLSession(configuration: config)
}

private func tokenResponseJSON(
  accessToken: String = "acc_test",
  refreshToken: String = "ref_test",
  expiresIn: Int = 86400
) -> Data {
  """
  {"access_token":"\(accessToken)","refresh_token":"\(refreshToken)","expires_in":\(expiresIn),"token_type":"DPoP"}
  """.data(using: .utf8)!
}

private func httpResponse(status: Int, url: URL, headers: [String: String] = [:]) -> HTTPURLResponse {
  HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
}

/// Read all bytes from an InputStream (URLProtocol replaces httpBody with httpBodyStream).
private func readStream(_ stream: InputStream?) -> Data? {
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
      devicePubkey: "spkiBase64"
    )

    let req = try XCTUnwrap(capturedRequest)
    // URLProtocol may replace httpBody with httpBodyStream — read from either.
    let bodyData = try XCTUnwrap(req.httpBody ?? readStream(req.httpBodyStream))
    let body = try JSONDecoder().decode([String: String].self, from: bodyData)

    XCTAssertEqual(body["code"], "aabbcc")
    XCTAssertEqual(body["code_verifier"], "verifier123")
    XCTAssertEqual(body["device_pubkey"], "spkiBase64")
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
      devicePubkey: "pubkey"
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
      code: "code", codeVerifier: "verifier", devicePubkey: "pubkey")

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

    _ = try await client.exchangeBridgeCode(code: "code", codeVerifier: "verifier", devicePubkey: "pub")

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

    _ = try await client.exchangeBridgeCode(code: "code", codeVerifier: "verifier", devicePubkey: "pub")
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
      _ = try await client.exchangeBridgeCode(code: "code", codeVerifier: "verifier", devicePubkey: "pub")
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
      _ = try await client.exchangeBridgeCode(code: "bad", codeVerifier: "ver", devicePubkey: "pub")
      XCTFail("Expected bridgeCodeInvalid error")
    } catch MobileAPIError.bridgeCodeInvalid {
      // Expected.
    }
  }
}
