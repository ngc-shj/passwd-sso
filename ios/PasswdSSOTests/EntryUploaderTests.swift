import Foundation
import XCTest

@testable import Shared

// Uses MockURLProtocol/makeSession/httpResponse from MobileAPIClientTests.swift
// and FakeSigner from DPoPProofBuilderTests.swift (same target).

final class EntryUploaderTests: XCTestCase {
  private let serverURL = URL(string: "https://test.passwd-sso.example")!
  private let knownJWK: [String: String] = [
    "kty": "EC", "crv": "P-256",
    "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ]
  private var session: URLSession!

  override func setUp() {
    super.setUp()
    session = makeSession()
    MockURLProtocol.requestHandler = nil
  }

  private func makeUploader(
    accessToken: String = "up_tok",
    initialNonce: String? = nil,
    onNonceUpdate: (@Sendable (String) -> Void)? = nil
  ) -> EntryUploader {
    EntryUploader(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      accessToken: accessToken,
      initialNonce: initialNonce,
      onNonceUpdate: onNonceUpdate,
      urlSession: session
    )
  }

  private func makeBody(id: String = "e1") -> CreateEntryRequest {
    let enc = EncryptedData(
      ciphertext: "aabbcc",
      iv: "112233445566778899aabbcc",
      authTag: "deadbeefdeadbeefdeadbeefdeadbeef"
    )
    return CreateEntryRequest(
      id: id, encryptedBlob: enc, encryptedOverview: enc,
      keyVersion: 1, aadVersion: 1, entryType: "PASSKEY"
    )
  }

  private func decodeDPoPPayload(_ request: URLRequest) throws -> [String: Any] {
    let dpop = try XCTUnwrap(request.value(forHTTPHeaderField: "DPoP"))
    let parts = dpop.split(separator: ".")
    XCTAssertEqual(parts.count, 3, "DPoP must be a 3-part JWS")
    var b64 = String(parts[1])
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    let rem = b64.count % 4
    if rem != 0 { b64 += String(repeating: "=", count: 4 - rem) }
    let data = try XCTUnwrap(Data(base64Encoded: b64))
    return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  // MARK: - T5 regression (ported from MobileAPIClientTests)

  func testCreateEntry_athIsSHA256OfAccessTokenAndHtmIsPost() async throws {
    let accessToken = "acc_create_ath"
    var capturedRequest: URLRequest?
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { request in
      capturedRequest = request
      return (Data(#"{"id":"e1"}"#.utf8), httpResponse(status: 201, url: createURL))
    }

    let returnedId = try await makeUploader(accessToken: accessToken)
      .createEntry(body: makeBody(id: "e1"))

    XCTAssertEqual(returnedId, "e1")
    let req = try XCTUnwrap(capturedRequest)
    XCTAssertEqual(req.httpMethod, "POST")
    XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer \(accessToken)")
    let payload = try decodeDPoPPayload(req)
    XCTAssertEqual(payload["ath"] as? String, sha256Base64URL(accessToken))
    XCTAssertEqual(payload["htm"] as? String, "POST")
    XCTAssertEqual(
      payload["htu"] as? String,
      "https://test.passwd-sso.example/api/passwords"
    )
  }

  func testCreateEntry_initialNonceIsIncludedInProof() async throws {
    var capturedRequest: URLRequest?
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { request in
      capturedRequest = request
      return (Data(#"{"id":"e1"}"#.utf8), httpResponse(status: 201, url: createURL))
    }

    _ = try await makeUploader(initialNonce: "staged-nonce").createEntry(body: makeBody())

    let payload = try decodeDPoPPayload(try XCTUnwrap(capturedRequest))
    XCTAssertEqual(payload["nonce"] as? String, "staged-nonce")
  }

  func testCreateEntry_retriesOnceOn401WithFreshNonce() async throws {
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    nonisolated(unsafe) var requestCount = 0
    nonisolated(unsafe) var secondRequest: URLRequest?
    MockURLProtocol.requestHandler = { request in
      requestCount += 1
      if requestCount == 1 {
        return (
          Data(),
          httpResponse(status: 401, url: createURL, headers: ["DPoP-Nonce": "fresh-1"])
        )
      }
      secondRequest = request
      return (Data(#"{"id":"e1"}"#.utf8), httpResponse(status: 201, url: createURL))
    }

    let id = try await makeUploader().createEntry(body: makeBody())

    XCTAssertEqual(id, "e1")
    XCTAssertEqual(requestCount, 2)
    let payload = try decodeDPoPPayload(try XCTUnwrap(secondRequest))
    XCTAssertEqual(payload["nonce"] as? String, "fresh-1")
  }

  func testCreateEntry_persistentlyUnauthorizedThrowsAfterSingleRetry() async {
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    nonisolated(unsafe) var requestCount = 0
    MockURLProtocol.requestHandler = { _ in
      requestCount += 1
      return (
        Data(),
        httpResponse(status: 401, url: createURL, headers: ["DPoP-Nonce": "n\(requestCount)"])
      )
    }

    do {
      _ = try await makeUploader().createEntry(body: makeBody())
      XCTFail("expected unauthorized")
    } catch {
      XCTAssertEqual(error as? EntryUploadError, .unauthorized)
    }
    XCTAssertEqual(requestCount, 2, "exactly one nonce-retry, never a loop")
  }

  func testCreateEntry_401WithoutNonceThrowsImmediately() async {
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    nonisolated(unsafe) var requestCount = 0
    MockURLProtocol.requestHandler = { _ in
      requestCount += 1
      return (Data(), httpResponse(status: 401, url: createURL))
    }

    do {
      _ = try await makeUploader().createEntry(body: makeBody())
      XCTFail("expected unauthorized")
    } catch {
      XCTAssertEqual(error as? EntryUploadError, .unauthorized)
    }
    XCTAssertEqual(requestCount, 1)
  }

  func testCreateEntry_nonceUpdateCallbackReceivesEveryFreshNonce() async throws {
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    nonisolated(unsafe) var requestCount = 0
    MockURLProtocol.requestHandler = { _ in
      requestCount += 1
      if requestCount == 1 {
        return (
          Data(),
          httpResponse(status: 401, url: createURL, headers: ["DPoP-Nonce": "n1"])
        )
      }
      return (
        Data(#"{"id":"e1"}"#.utf8),
        httpResponse(status: 201, url: createURL, headers: ["DPoP-Nonce": "n2"])
      )
    }
    nonisolated(unsafe) var seen: [String] = []
    let lock = NSLock()

    _ = try await makeUploader(onNonceUpdate: { nonce in
      lock.lock(); seen.append(nonce); lock.unlock()
    }).createEntry(body: makeBody())

    XCTAssertEqual(seen, ["n1", "n2"])
  }

  func testCreateEntry_networkErrorMapsToNetwork() async {
    MockURLProtocol.requestHandler = { _ in throw URLError(.notConnectedToInternet) }

    do {
      _ = try await makeUploader().createEntry(body: makeBody())
      XCTFail("expected network error")
    } catch {
      XCTAssertEqual(error as? EntryUploadError, .network)
    }
  }

  func testCreateEntry_serverErrorMapsToStatus() async {
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { _ in
      (Data(), httpResponse(status: 500, url: createURL))
    }

    do {
      _ = try await makeUploader().createEntry(body: makeBody())
      XCTFail("expected serverError")
    } catch {
      XCTAssertEqual(error as? EntryUploadError, .serverError(status: 500))
    }
  }

  func testCreateEntry_2xxWithoutIdBodyIsInvalidResponse() async {
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { _ in
      (Data("{}".utf8), httpResponse(status: 201, url: createURL))
    }

    do {
      _ = try await makeUploader().createEntry(body: makeBody())
      XCTFail("expected invalidResponse")
    } catch {
      XCTAssertEqual(error as? EntryUploadError, .invalidResponse)
    }
  }
}
