import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

// MARK: - Helpers for EntryFetcherTests

/// Personal entry response — nested EncryptedData objects.
private func makePersonalEntryJSON(id: String) -> String {
  return """
  {
    "id": "\(id)",
    "encryptedOverview": {
      "ciphertext": "aabbcc",
      "iv": "aabbccddeeff00112233445566778899",
      "authTag": "00112233445566778899aabbccddeeff"
    },
    "encryptedBlob": {
      "ciphertext": "ddeeff",
      "iv": "aabbccddeeff001122334455667788aa",
      "authTag": "00112233445566778899aabbccddeeff"
    },
    "keyVersion": 1,
    "aadVersion": 1,
    "entryType": "LOGIN",
    "isFavorite": false,
    "isArchived": false
  }
  """
}

/// Team entry response — flat ciphertext/iv/authTag fields.
private func makeTeamEntryJSON(id: String) -> String {
  return """
  {
    "id": "\(id)",
    "encryptedOverview": "aabbcc",
    "overviewIv": "aabbccddeeff00112233445566778899",
    "overviewAuthTag": "00112233445566778899aabbccddeeff",
    "encryptedBlob": "ddeeff",
    "blobIv": "aabbccddeeff001122334455667788aa",
    "blobAuthTag": "00112233445566778899aabbccddeeff",
    "aadVersion": 1,
    "teamKeyVersion": 1,
    "itemKeyVersion": 0,
    "isFavorite": false,
    "isArchived": false
  }
  """
}

private func makePersonalEntriesResponseData(ids: [String]) -> Data {
  let items = ids.map { makePersonalEntryJSON(id: $0) }
  return "[\(items.joined(separator: ","))]".data(using: .utf8)!
}

private func makeTeamEntriesResponseData(ids: [String]) -> Data {
  let items = ids.map { makeTeamEntryJSON(id: $0) }
  return "[\(items.joined(separator: ","))]".data(using: .utf8)!
}

// Keep backward-compat alias used by fetchPersonal tests
private func makeEntriesResponseData(ids: [String]) -> Data {
  makePersonalEntriesResponseData(ids: ids)
}

private func makeServerURL() -> URL {
  URL(string: "https://test.passwd-sso.example")!
}

private func makeMockSession() -> URLSession {
  let config = URLSessionConfiguration.ephemeral
  config.protocolClasses = [MockURLProtocol.self]
  return URLSession(configuration: config)
}

private func makeTokenKeychain(token: String) -> MockKeychain {
  let keychain = MockKeychain()
  let service = "com.passwd-sso.test.tokens"
  // access_token
  if let data = token.data(using: .utf8) {
    keychain.store["\(service):access_token"] = data
  }
  // access_token_expiry (1 hour from now)
  let expiry = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
  if let data = expiry.data(using: .utf8) {
    keychain.store["\(service):access_token_expiry"] = data
  }
  return keychain
}

// MARK: - Tests

final class EntryFetcherTests: XCTestCase {

  private let serverURL = makeServerURL()

  // MARK: - Personal entries: 200 returns decoded entries

  func testFetchPersonalReturns200DecodesEntries() async throws {
    let tokenKeychain = makeTokenKeychain(token: "test-access-token")
    let tokenStore = HostTokenStore(
      service: "com.passwd-sso.test.tokens",
      keychain: tokenKeychain
    )

    let responseData = makePersonalEntriesResponseData(ids: ["e1", "e2", "e3"])

    MockURLProtocol.requestHandler = { request in
      // Verify Authorization header
      let auth = request.value(forHTTPHeaderField: "Authorization")
      XCTAssertTrue(auth?.hasPrefix("DPoP ") ?? false, "Should have DPoP Authorization")

      // Verify DPoP header present
      let dpop = request.value(forHTTPHeaderField: "DPoP")
      XCTAssertNotNil(dpop, "Should have DPoP proof header")

      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: nil
      )!
      return (responseData, response)
    }

    let signer = DummyDPoPSigner()
    let apiClient = MobileAPIClient(
      serverURL: serverURL,
      signer: signer,
      jwk: ["kty": "EC", "crv": "P-256", "x": "dGVzdA", "y": "dGVzdA"],
      tokenStore: tokenStore,
      urlSession: makeMockSession()
    )
    let fetcher = EntryFetcher(apiClient: apiClient)
    let entries = try await fetcher.fetchPersonal()

    XCTAssertEqual(entries.count, 3)
    XCTAssertEqual(entries[0].id, "e1")
    XCTAssertEqual(entries[1].id, "e2")
    XCTAssertEqual(entries[2].id, "e3")
  }

  // MARK: - Team entries: teamId propagated

  func testFetchTeamPassesTeamIdInPath() async throws {
    let tokenKeychain = makeTokenKeychain(token: "test-access-token")
    let tokenStore = HostTokenStore(
      service: "com.passwd-sso.test.tokens",
      keychain: tokenKeychain
    )

    let expectedTeamId = "team-abc"
    let responseData = makeTeamEntriesResponseData(ids: ["te1"])

    MockURLProtocol.requestHandler = { request in
      // Verify the URL contains the team ID
      XCTAssertTrue(
        request.url?.path.contains(expectedTeamId) ?? false,
        "URL should contain team ID"
      )

      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: nil
      )!
      return (responseData, response)
    }

    let signer = DummyDPoPSigner()
    let apiClient = MobileAPIClient(
      serverURL: serverURL,
      signer: signer,
      jwk: ["kty": "EC", "crv": "P-256", "x": "dGVzdA", "y": "dGVzdA"],
      tokenStore: tokenStore,
      urlSession: makeMockSession()
    )
    let fetcher = EntryFetcher(apiClient: apiClient)
    let entries = try await fetcher.fetchTeamAsCacheEntries(teamId: expectedTeamId)

    XCTAssertEqual(entries.count, 1)
    XCTAssertEqual(entries[0].id, "te1")
    XCTAssertEqual(entries[0].teamId, expectedTeamId)
    XCTAssertEqual(entries[0].itemKeyVersion, 0)
    XCTAssertEqual(entries[0].teamKeyVersion, 1)
  }

  // MARK: - 401 propagates as error

  func testFetch401PropagatesError() async {
    let tokenKeychain = makeTokenKeychain(token: "test-access-token")
    let tokenStore = HostTokenStore(
      service: "com.passwd-sso.test.tokens",
      keychain: tokenKeychain
    )

    MockURLProtocol.requestHandler = { request in
      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: 401,
        httpVersion: nil,
        headerFields: nil
      )!
      return (Data(), response)
    }

    let signer = DummyDPoPSigner()
    let apiClient = MobileAPIClient(
      serverURL: serverURL,
      signer: signer,
      jwk: ["kty": "EC", "crv": "P-256", "x": "dGVzdA", "y": "dGVzdA"],
      tokenStore: tokenStore,
      urlSession: makeMockSession()
    )
    let fetcher = EntryFetcher(apiClient: apiClient)

    do {
      _ = try await fetcher.fetchPersonal()
      XCTFail("Expected error on 401")
    } catch MobileAPIError.serverError(let status) {
      XCTAssertEqual(status, 401)
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  // MARK: - ath claim: SHA-256(access_token) present in DPoP proof

  func testFetchPersonalIncludesAthInDPoPProof() async throws {
    let accessToken = "my-access-token-123"
    let tokenKeychain = makeTokenKeychain(token: accessToken)
    let tokenStore = HostTokenStore(
      service: "com.passwd-sso.test.tokens",
      keychain: tokenKeychain
    )

    let responseData = makeEntriesResponseData(ids: ["e1"])
    var capturedDPoPProof: String?

    MockURLProtocol.requestHandler = { request in
      capturedDPoPProof = request.value(forHTTPHeaderField: "DPoP")
      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: nil
      )!
      return (responseData, response)
    }

    let signer = DummyDPoPSigner()
    let apiClient = MobileAPIClient(
      serverURL: serverURL,
      signer: signer,
      jwk: ["kty": "EC", "crv": "P-256", "x": "dGVzdA", "y": "dGVzdA"],
      tokenStore: tokenStore,
      urlSession: makeMockSession()
    )
    let fetcher = EntryFetcher(apiClient: apiClient)
    _ = try await fetcher.fetchPersonal()

    // DPoP proof should be present
    XCTAssertNotNil(capturedDPoPProof, "DPoP proof should be sent")
    // The proof is a JWS — it contains at least 2 dots (header.payload.sig)
    let parts = capturedDPoPProof?.components(separatedBy: ".")
    XCTAssertEqual(parts?.count, 3, "DPoP proof should be a 3-part JWS")
  }
}

// MARK: - Dummy signer for tests

private struct DummyDPoPSigner: DPoPSigner, @unchecked Sendable {
  func sign(input: Data) async throws -> Data {
    // Return a dummy 64-byte signature
    Data(repeating: 0x01, count: 64)
  }
}
