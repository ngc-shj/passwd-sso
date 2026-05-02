import CryptoKit
import Foundation
import Shared

// MARK: - Vault unlock data (matches /api/vault/unlock/data response)

public struct VaultUnlockData: Sendable, Codable, Equatable {
  public let accountSalt: String
  public let encryptedSecretKey: String
  public let secretKeyIv: String
  public let secretKeyAuthTag: String
  public let keyVersion: Int
  public let kdfType: String
  public let kdfIterations: Int

  enum CodingKeys: String, CodingKey {
    case accountSalt
    case encryptedSecretKey
    case secretKeyIv
    case secretKeyAuthTag
    case keyVersion
    case kdfType
    case kdfIterations
  }
}

// MARK: - Response types

public struct TokenExchangeResponse: Sendable, Codable, Equatable {
  public let accessToken: String
  public let refreshToken: String
  public let expiresIn: Int
  public let tokenType: String

  enum CodingKeys: String, CodingKey {
    case accessToken = "access_token"
    case refreshToken = "refresh_token"
    case expiresIn = "expires_in"
    case tokenType = "token_type"
  }
}

// MARK: - Errors

public enum MobileAPIError: Error, Equatable {
  case bridgeCodeInvalid
  case pkceMismatch
  /// DPoP proof was rejected; the associated value is the new nonce to echo on retry.
  case dpopInvalid(newNonce: String?)
  case rateLimited(retryAfter: TimeInterval)
  case serverError(status: Int)
  case networkError(URLError)
}

// MARK: - Client

/// Typed wrappers for `/api/mobile/*` endpoints.
///
/// The client owns DPoP proof construction per request and echoes the last
/// `DPoP-Nonce` header the server issued. Concurrent calls are serialized by `actor`.
public actor MobileAPIClient {
  let serverURL: URL
  let signer: DPoPSigner
  let jwk: [String: String]
  let tokenStore: HostTokenStore
  private let urlSession: URLSession

  public init(
    serverURL: URL,
    signer: DPoPSigner,
    jwk: [String: String],
    tokenStore: HostTokenStore,
    urlSession: URLSession = .shared
  ) {
    self.serverURL = serverURL
    self.signer = signer
    self.jwk = jwk
    self.tokenStore = tokenStore
    self.urlSession = urlSession
  }

  // MARK: - Public API

  /// Exchange a bridge code for an access+refresh token pair (step 2 of iOS auth handshake).
  public func exchangeBridgeCode(
    code: String,
    codeVerifier: String,
    devicePubkey: String
  ) async throws -> TokenExchangeResponse {
    let tokenURL = serverURL.appending(path: "/api/mobile/token", directoryHint: .notDirectory)
    let htu = canonicalHTU(url: tokenURL)

    // Capture values before crossing into async context so retry closure doesn't need await.
    let localJWK = jwk
    let localSigner = signer

    let nonce = try? tokenStore.loadNonce()
    let proof = try await buildDPoPProof(
      htm: "POST",
      htu: htu,
      jwk: localJWK,
      nonce: nonce,
      signer: localSigner
    )

    let body: [String: String] = [
      "code": code,
      "code_verifier": codeVerifier,
      "device_pubkey": devicePubkey,
    ]
    let bodyData = try JSONEncoder().encode(body)

    var request = URLRequest(url: tokenURL)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(proof.jws, forHTTPHeaderField: "DPoP")
    request.httpBody = bodyData

    return try await performTokenRequest(request) { newNonce in
      let retryProof = try await buildDPoPProof(
        htm: "POST",
        htu: htu,
        jwk: localJWK,
        nonce: newNonce,
        signer: localSigner
      )
      var retryRequest = request
      retryRequest.setValue(retryProof.jws, forHTTPHeaderField: "DPoP")
      return retryRequest
    }
  }

  /// Rotate the access+refresh token pair using the stored refresh token.
  ///
  /// The refresh route expects `Authorization: DPoP <refresh_token>` and a DPoP proof
  /// with `ath` = SHA-256(refresh_token), as specified in the server route contract.
  public func refreshToken() async throws -> TokenExchangeResponse {
    guard let refreshToken = try tokenStore.loadRefresh() else {
      throw MobileAPIError.serverError(status: 401)
    }

    let refreshURL = serverURL.appending(
      path: "/api/mobile/token/refresh",
      directoryHint: .notDirectory
    )
    let htu = canonicalHTU(url: refreshURL)
    let ath = sha256Base64URL(refreshToken)

    let localJWK = jwk
    let localSigner = signer

    let nonce = try? tokenStore.loadNonce()
    let proof = try await buildDPoPProof(
      htm: "POST",
      htu: htu,
      jwk: localJWK,
      ath: ath,
      nonce: nonce,
      signer: localSigner
    )

    let body: [String: String] = ["refresh_token": refreshToken]
    let bodyData = try JSONEncoder().encode(body)

    var request = URLRequest(url: refreshURL)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("DPoP \(refreshToken)", forHTTPHeaderField: "Authorization")
    request.setValue(proof.jws, forHTTPHeaderField: "DPoP")
    request.httpBody = bodyData

    return try await performTokenRequest(request) { newNonce in
      let retryProof = try await buildDPoPProof(
        htm: "POST",
        htu: htu,
        jwk: localJWK,
        ath: ath,
        nonce: newNonce,
        signer: localSigner
      )
      var retryRequest = request
      retryRequest.setValue(retryProof.jws, forHTTPHeaderField: "DPoP")
      return retryRequest
    }
  }

  // MARK: - Protected resource API

  /// Fetch vault unlock data from GET /api/vault/unlock/data.
  /// Requires a valid access token (DPoP-signed).
  public func fetchVaultUnlockData() async throws -> VaultUnlockData {
    guard let (accessToken, _) = try tokenStore.loadAccess() else {
      throw MobileAPIError.serverError(status: 401)
    }

    let endpoint = serverURL.appending(
      path: "/api/vault/unlock/data",
      directoryHint: .notDirectory
    )
    let htu = canonicalHTU(url: endpoint)
    let ath = sha256Base64URL(accessToken)

    let localJWK = jwk
    let localSigner = signer
    let nonce = try? tokenStore.loadNonce()
    let proof = try await buildDPoPProof(
      htm: "GET",
      htu: htu,
      jwk: localJWK,
      ath: ath,
      nonce: nonce,
      signer: localSigner
    )

    var request = URLRequest(url: endpoint)
    request.httpMethod = "GET"
    request.setValue("DPoP \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue(proof.jws, forHTTPHeaderField: "DPoP")

    let (data, response) = try await performHTTP(request)
    let http = response as! HTTPURLResponse

    if let newNonce = http.value(forHTTPHeaderField: "DPoP-Nonce") {
      try? tokenStore.saveNonce(newNonce)
    }

    switch http.statusCode {
    case 200:
      return try JSONDecoder().decode(VaultUnlockData.self, from: data)
    case 401:
      throw MobileAPIError.serverError(status: 401)
    default:
      throw MobileAPIError.serverError(status: http.statusCode)
    }
  }

  /// Fetch encrypted entries from a GET endpoint (personal or team).
  /// Requires a valid access token (DPoP-signed).
  public func fetchEntries(endpoint endpointPath: String) async throws -> [EncryptedEntry] {
    guard let (accessToken, _) = try tokenStore.loadAccess() else {
      throw MobileAPIError.serverError(status: 401)
    }

    guard let endpointURL = URL(string: endpointPath, relativeTo: serverURL) else {
      throw MobileAPIError.serverError(status: 400)
    }
    let htu = canonicalHTU(url: endpointURL)
    let ath = sha256Base64URL(accessToken)

    let localJWK = jwk
    let localSigner = signer
    let nonce = try? tokenStore.loadNonce()
    let proof = try await buildDPoPProof(
      htm: "GET",
      htu: htu,
      jwk: localJWK,
      ath: ath,
      nonce: nonce,
      signer: localSigner
    )

    var request = URLRequest(url: endpointURL)
    request.httpMethod = "GET"
    request.setValue("DPoP \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue(proof.jws, forHTTPHeaderField: "DPoP")

    let (data, response) = try await performHTTP(request)
    let http = response as! HTTPURLResponse

    if let newNonce = http.value(forHTTPHeaderField: "DPoP-Nonce") {
      try? tokenStore.saveNonce(newNonce)
    }

    switch http.statusCode {
    case 200:
      return try JSONDecoder().decode([EncryptedEntry].self, from: data)
    case 401:
      throw MobileAPIError.serverError(status: 401)
    default:
      throw MobileAPIError.serverError(status: http.statusCode)
    }
  }

  // MARK: - Private helpers

  /// Perform a token request; on 401 + new nonce, invoke `makeRetry` once.
  private func performTokenRequest(
    _ request: URLRequest,
    makeRetry: ((String) async throws -> URLRequest)? = nil
  ) async throws -> TokenExchangeResponse {
    let (data, response) = try await performHTTP(request)
    let http = response as! HTTPURLResponse

    // Persist nonce from any response (RFC 9449 §8).
    if let newNonce = http.value(forHTTPHeaderField: "DPoP-Nonce") {
      try? tokenStore.saveNonce(newNonce)
    }

    // On 401 with a new nonce and a retry closure, retry once.
    if http.statusCode == 401,
       let makeRetry,
       let newNonce = http.value(forHTTPHeaderField: "DPoP-Nonce") {
      let retryRequest = try await makeRetry(newNonce)
      let (retryData, retryResponse) = try await performHTTP(retryRequest)
      let retryHTTP = retryResponse as! HTTPURLResponse
      if let retryNonce = retryHTTP.value(forHTTPHeaderField: "DPoP-Nonce") {
        try? tokenStore.saveNonce(retryNonce)
      }
      return try decodeResponse(retryData, status: retryHTTP.statusCode)
    }

    return try decodeResponse(data, status: http.statusCode)
  }

  func performHTTP(_ request: URLRequest) async throws -> (Data, URLResponse) {
    do {
      return try await urlSession.data(for: request)
    } catch let urlError as URLError {
      throw MobileAPIError.networkError(urlError)
    }
  }

  private func decodeResponse(_ data: Data, status: Int) throws -> TokenExchangeResponse {
    switch status {
    case 200:
      return try JSONDecoder().decode(TokenExchangeResponse.self, from: data)
    case 400:
      throw MobileAPIError.bridgeCodeInvalid
    case 401:
      throw MobileAPIError.dpopInvalid(newNonce: nil)
    case 429:
      throw MobileAPIError.rateLimited(retryAfter: 60)
    default:
      throw MobileAPIError.serverError(status: status)
    }
  }

  /// Strip query/fragment for the canonical htu value per RFC 9449 §4.2.
  func canonicalHTU(url: URL) -> String {
    var components = URLComponents(url: url, resolvingAgainstBaseURL: false) ?? URLComponents()
    components.query = nil
    components.fragment = nil
    return components.url?.absoluteString ?? url.absoluteString
  }

  /// SHA-256(token) → base64url, for the DPoP `ath` claim.
  func sha256Base64URL(_ token: String) -> String {
    let digest = SHA256.hash(data: Data(token.utf8))
    return base64URLEncode(Data(digest))
  }
}
