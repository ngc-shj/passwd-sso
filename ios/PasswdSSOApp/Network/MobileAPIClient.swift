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
  // Server (Prisma) stores kdfType as an Int (0 = PBKDF2-SHA256, 1 = Argon2id),
  // serialized as a JSON number — decoding it as String fails the whole struct.
  public let kdfType: Int
  public let kdfIterations: Int
  /// User ID bound to the vault; used as AAD input for personal entries (aadVersion >= 1).
  public let userId: String
  /// Tenant-enforced auto-lock interval (minutes), or nil when the tenant sets no
  /// policy. Optional → the synthesized decoder treats null/absent as nil.
  public let vaultAutoLockMinutes: Int?
  /// Account ECDH keypair material (team E2E). All nil for accounts without an
  /// ECDH keypair / no team membership. Used to unwrap team keys.
  public let ecdhPublicKey: String?
  public let encryptedEcdhPrivateKey: String?
  public let ecdhPrivateKeyIv: String?
  public let ecdhPrivateKeyAuthTag: String?

  enum CodingKeys: String, CodingKey {
    case accountSalt
    case encryptedSecretKey
    case secretKeyIv
    case secretKeyAuthTag
    case keyVersion
    case kdfType
    case kdfIterations
    case userId
    case vaultAutoLockMinutes
    case ecdhPublicKey
    case encryptedEcdhPrivateKey
    case ecdhPrivateKeyIv
    case ecdhPrivateKeyAuthTag
  }

  // Explicit memberwise init with vaultAutoLockMinutes defaulted LAST so existing
  // call sites (tests) compile unchanged. The synthesized Decodable init(from:)
  // is unaffected (we do not hand-write it).
  public init(
    accountSalt: String,
    encryptedSecretKey: String,
    secretKeyIv: String,
    secretKeyAuthTag: String,
    keyVersion: Int,
    kdfType: Int,
    kdfIterations: Int,
    userId: String,
    vaultAutoLockMinutes: Int? = nil,
    ecdhPublicKey: String? = nil,
    encryptedEcdhPrivateKey: String? = nil,
    ecdhPrivateKeyIv: String? = nil,
    ecdhPrivateKeyAuthTag: String? = nil
  ) {
    self.accountSalt = accountSalt
    self.encryptedSecretKey = encryptedSecretKey
    self.secretKeyIv = secretKeyIv
    self.secretKeyAuthTag = secretKeyAuthTag
    self.keyVersion = keyVersion
    self.kdfType = kdfType
    self.kdfIterations = kdfIterations
    self.userId = userId
    self.vaultAutoLockMinutes = vaultAutoLockMinutes
    self.ecdhPublicKey = ecdhPublicKey
    self.encryptedEcdhPrivateKey = encryptedEcdhPrivateKey
    self.ecdhPrivateKeyIv = ecdhPrivateKeyIv
    self.ecdhPrivateKeyAuthTag = ecdhPrivateKeyAuthTag
  }
}

// MARK: - Response types

/// GET /api/teams/{teamId}/member-key response (team E2E key material).
public struct TeamMemberKeyResponse: Sendable, Codable, Equatable {
  public let encryptedTeamKey: String
  public let teamKeyIv: String
  public let teamKeyAuthTag: String
  public let ephemeralPublicKey: String
  public let hkdfSalt: String
  public let keyVersion: Int
  public let wrapVersion: Int
}

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

// MARK: - AutoFill upload token (matches POST /api/mobile/autofill-token response)

public struct AutofillTokenResponse: Sendable, Codable, Equatable {
  public let token: String
  /// ISO 8601 with fractional seconds (server `Date.toISOString()`).
  public let expiresAt: String
  public let scope: [String]
  public let cnfJkt: String
}

// MARK: - Errors

public enum MobileAPIError: Error, Equatable {
  case bridgeCodeInvalid
  case pkceMismatch
  /// DPoP proof was rejected; the associated value is the new nonce to echo on retry.
  case dpopInvalid(newNonce: String?)
  case rateLimited(retryAfter: TimeInterval)
  case notFound
  /// Server rejected a create because a per-resource quota is exhausted
  /// (HTTP 403 carrying the server's quota-exhaustion error code).
  case quotaExceeded
  /// The team member key has not been distributed to this user (or no longer
  /// exists). Treated as "skip this team" during sync, not a hard failure.
  case teamKeyNotDistributed
  case serverError(status: Int)
  case networkError(URLError)
  /// The refresh token is dead (no refresh token, or refresh endpoint returned 401/dpopInvalid).
  /// The only recovery is re-sign-in.
  case authenticationRequired
}

// CreateEntryRequest moved to Shared (ios/Shared/Network/EntryUploader.swift)
// so the AutoFill extension's EntryUploader shares the wire shape.

// MARK: - Entry update request

public struct UpdateEntryRequest: Sendable, Codable {
  public let encryptedBlob: EncryptedData
  public let encryptedOverview: EncryptedData
  public let keyVersion: Int
  public let aadVersion: Int

  public init(
    encryptedBlob: EncryptedData,
    encryptedOverview: EncryptedData,
    keyVersion: Int,
    aadVersion: Int
  ) {
    self.encryptedBlob = encryptedBlob
    self.encryptedOverview = encryptedOverview
    self.keyVersion = keyVersion
    self.aadVersion = aadVersion
  }
}

// MARK: - Client

/// Typed wrappers for `/api/mobile/*` endpoints.
///
/// The client owns DPoP proof construction per request and echoes the last
/// `DPoP-Nonce` header the server issued. Concurrent calls are serialized by `actor`.
public actor MobileAPIClient: VaultUnlockDataSource {
  let serverURL: URL
  let signer: DPoPSigner
  let jwk: [String: String]
  let tokenStore: HostTokenStore
  private let urlSession: URLSession
  private let now: @Sendable () -> Date

  public init(
    serverURL: URL,
    signer: DPoPSigner,
    jwk: [String: String],
    tokenStore: HostTokenStore,
    urlSession: URLSession = .shared,
    now: @Sendable @escaping () -> Date = { Date() }
  ) {
    self.serverURL = serverURL
    self.signer = signer
    self.jwk = jwk
    self.tokenStore = tokenStore
    self.urlSession = urlSession
    self.now = now
  }

  // MARK: - Public API

  /// Exchange a bridge code for an access+refresh token pair (step 2 of iOS auth handshake).
  public func exchangeBridgeCode(
    code: String,
    codeVerifier: String,
    deviceJkt: String
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
      "device_jkt": deviceJkt,
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
      // No refresh token = auth-dead; surface the right taxonomy even to direct callers.
      throw MobileAPIError.authenticationRequired
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
    // SECURITY: never log this request or its headers — Authorization carries the refresh token.
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
  /// Requires a valid access token (DPoP-signed). Applies the full C3 retry ladder.
  public func fetchVaultUnlockData() async throws -> VaultUnlockData {
    let url = serverURL.appending(path: "/api/vault/unlock/data", directoryHint: .notDirectory)
    let data = try await performAuthedGET(url: url)
    return try JSONDecoder().decode(VaultUnlockData.self, from: data)
  }

  /// Fetch encrypted team entries (flat response format) for a given team.
  /// Requires a valid access token (DPoP-signed). Applies the full C3 retry ladder.
  public func fetchTeamEntries(teamId: String) async throws -> [TeamEncryptedEntry] {
    guard let endpointURL = resourceURL(path: "/api/teams/\(teamId)/passwords", query: "include=blob") else {
      throw MobileAPIError.serverError(status: 400)
    }
    let data = try await performAuthedGET(url: endpointURL)
    return try JSONDecoder().decode([TeamEncryptedEntry].self, from: data)
  }

  /// Fetch this user's wrapped team key for a team (GET /api/teams/{id}/member-key).
  /// 403 (KEY_NOT_DISTRIBUTED) / 404 (MEMBER_KEY_NOT_FOUND) → `teamKeyNotDistributed`
  /// so the sync caller skips the team rather than failing the whole sync.
  public func fetchTeamMemberKey(teamId: String) async throws -> TeamMemberKeyResponse {
    let url = serverURL.appending(path: "/api/teams/\(teamId)/member-key", directoryHint: .notDirectory)
    do {
      let data = try await performAuthedGET(url: url)
      return try JSONDecoder().decode(TeamMemberKeyResponse.self, from: data)
    } catch MobileAPIError.serverError(let status) where status == 403 || status == 404 {
      throw MobileAPIError.teamKeyNotDistributed
    }
  }

  /// Fetch encrypted entries from a GET endpoint (personal or team).
  /// Requires a valid access token (DPoP-signed). Applies the full C3 retry ladder.
  public func fetchEntries(endpoint endpointPath: String) async throws -> [EncryptedEntry] {
    guard let parsed = URLComponents(string: endpointPath),
          let endpointURL = resourceURL(path: parsed.path, query: parsed.percentEncodedQuery) else {
      throw MobileAPIError.serverError(status: 400)
    }
    let data = try await performAuthedGET(url: endpointURL)
    return try JSONDecoder().decode([EncryptedEntry].self, from: data)
  }

  /// POST /api/mobile/cache-rollback-report with DPoP-signed access token.
  /// On 401 + new DPoP-Nonce, retries once.
  public func postCacheRollbackReport(_ body: CacheRollbackReportBody) async throws {
    let accessToken = try await validAccessToken()

    let endpoint = serverURL.appending(
      path: "/api/mobile/cache-rollback-report",
      directoryHint: .notDirectory
    )
    let htu = canonicalHTU(url: endpoint)
    let ath = sha256Base64URL(accessToken)

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

    let bodyData = try JSONEncoder().encode(body)
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue(proof.jws, forHTTPHeaderField: "DPoP")
    request.httpBody = bodyData

    try await performVoidHTTP(request) { newNonce in
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

  /// Create a new personal entry via POST /api/passwords.
  /// Requires a valid access token (DPoP-signed with ath).
  /// On 401 + new DPoP-Nonce, retries once with the fresh nonce.
  /// Returns the server-stored entry id (must equal the client-generated id).
  public func createEntry(body: CreateEntryRequest) async throws -> String {
    let accessToken = try await validAccessToken()

    let endpoint = serverURL.appending(
      path: "/api/passwords",
      directoryHint: .notDirectory
    )
    let htu = canonicalHTU(url: endpoint)
    let ath = sha256Base64URL(accessToken)

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

    let bodyData = try JSONEncoder().encode(body)
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue(proof.jws, forHTTPHeaderField: "DPoP")
    request.httpBody = bodyData

    return try await performCreateHTTP(request) { newNonce in
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

  /// Mint a short-lived, DPoP-bound AutoFill upload token via
  /// POST /api/mobile/autofill-token (plan C6). `extensionJWK` is the AutoFill
  /// extension's OWN shared-group SE public key — the server binds the minted
  /// token to its thumbprint, so only the extension can spend it.
  /// On 401 + new DPoP-Nonce, retries once with the fresh nonce.
  public func mintAutofillToken(extensionJWK: [String: String]) async throws -> AutofillTokenResponse {
    let accessToken = try await validAccessToken()

    let endpoint = serverURL.appending(
      path: "/api/mobile/autofill-token",
      directoryHint: .notDirectory
    )
    let htu = canonicalHTU(url: endpoint)
    let ath = sha256Base64URL(accessToken)

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

    let bodyData = try JSONEncoder().encode(["jwk": extensionJWK])
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue(proof.jws, forHTTPHeaderField: "DPoP")
    request.httpBody = bodyData

    let data = try await performBodyHTTP(request) { newNonce in
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
    return try JSONDecoder().decode(AutofillTokenResponse.self, from: data)
  }

  /// Update an existing personal entry via PUT /api/passwords/{entryId}.
  /// Requires a valid access token (DPoP-signed with ath).
  /// On 401 + new DPoP-Nonce, retries once with the fresh nonce.
  public func updateEntry(entryId: String, body: UpdateEntryRequest) async throws {
    let accessToken = try await validAccessToken()

    let endpoint = serverURL.appending(
      path: "/api/passwords/\(entryId)",
      directoryHint: .notDirectory
    )
    let htu = canonicalHTU(url: endpoint)
    let ath = sha256Base64URL(accessToken)

    let localJWK = jwk
    let localSigner = signer
    let nonce = try? tokenStore.loadNonce()
    let proof = try await buildDPoPProof(
      htm: "PUT",
      htu: htu,
      jwk: localJWK,
      ath: ath,
      nonce: nonce,
      signer: localSigner
    )

    let bodyData = try JSONEncoder().encode(body)
    var request = URLRequest(url: endpoint)
    request.httpMethod = "PUT"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue(proof.jws, forHTTPHeaderField: "DPoP")
    request.httpBody = bodyData

    try await performVoidHTTP(request) { newNonce in
      let retryProof = try await buildDPoPProof(
        htm: "PUT",
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

  // MARK: - Token management (C1/C2)

  /// Proactive refresh skew: refresh the access token when it is within this many seconds of expiry.
  private let refreshSkewSeconds: TimeInterval = 60

  /// In-flight single-flight refresh task. Nil when no refresh is in progress.
  private var refreshTask: Task<String, Error>?

  /// Atomically persist a rotated token pair; uses now() for expiresAt.
  private func persist(_ r: TokenExchangeResponse) throws {
    try tokenStore.saveTokens(
      access: r.accessToken,
      refresh: r.refreshToken,
      expiresAt: now().addingTimeInterval(TimeInterval(r.expiresIn))
    )
  }

  /// Calls refreshToken(), persists the result, and returns the new access token.
  /// Any refresh endpoint error is translated to .authenticationRequired.
  private func doRefreshAndPersist() async throws -> String {
    do {
      let r = try await refreshToken()
      try persist(r)
      return r.accessToken
    } catch let e as MobileAPIError {
      if case .networkError = e { throw e }
      throw MobileAPIError.authenticationRequired
    } catch {
      throw MobileAPIError.authenticationRequired
    }
  }

  /// Single-flight refresh gate. Joins an in-flight refresh if one is running,
  /// returns the already-rotated token if someone else just refreshed, or
  /// starts exactly one refresh and returns the new access token.
  private func ensureRefreshed(staleToken: String) async throws -> String {
    // Join in-flight refresh (actors are reentrant at await — this is reachable).
    if let task = refreshTask { return try await task.value }
    // Already rotated by a prior concurrent call — return the current token.
    if let (current, _) = try? tokenStore.loadAccess(), current != staleToken { return current }
    let task = Task { try await self.doRefreshAndPersist() }
    refreshTask = task
    defer { refreshTask = nil }
    return try await task.value
  }

  /// Returns a non-expired access token.
  /// Throws .authenticationRequired when no token is stored or the refresh fails.
  private func validAccessToken() async throws -> String {
    guard let (token, expiresAt) = try tokenStore.loadAccess() else {
      throw MobileAPIError.authenticationRequired
    }
    if expiresAt > now().addingTimeInterval(refreshSkewSeconds) { return token }
    return try await ensureRefreshed(staleToken: token)
  }

  // MARK: - Shared authenticated GET (C1 + C3)

  /// Performs an authenticated GET request with the full C3 retry ladder:
  ///   1. Initial request with a proactively-valid access token.
  ///   2. On 401: nonce-retry (once, if a new nonce arrived).
  ///   3. On still 401: token-refresh via single-flight gate, rebuild ath, retry once.
  ///   4. Still 401 → throws .authenticationRequired.
  /// Saves any DPoP-Nonce the server sends on every response.
  func performAuthedGET(url: URL) async throws -> Data {
    let initial = try await validAccessToken()
    let htu = canonicalHTU(url: url)
    let localJWK = jwk
    let localSigner = signer
    var token = initial
    var nonce = try? tokenStore.loadNonce()
    var didNonceRetry = false, didRefreshRetry = false
    while true {
      let proof = try await buildDPoPProof(
        htm: "GET", htu: htu, jwk: localJWK, ath: sha256Base64URL(token),
        nonce: nonce, signer: localSigner
      )
      var request = URLRequest(url: url)
      request.httpMethod = "GET"
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      request.setValue(proof.jws, forHTTPHeaderField: "DPoP")
      let (data, response) = try await performHTTP(request)
      let http = response as! HTTPURLResponse
      // A nonce in THIS response is the actual challenge signal; a stale stored
      // nonce must NOT trigger a nonce-retry (keeps the ladder bounded at ≤3).
      let freshNonce = http.value(forHTTPHeaderField: "DPoP-Nonce")
      if let n = freshNonce {
        try? tokenStore.saveNonce(n)
        nonce = n
      }
      switch http.statusCode {
      case 200:
        return data
      case 401:
        if !didNonceRetry, freshNonce != nil {
          // Nonce challenge: re-sign the same token with the new nonce, retry once.
          didNonceRetry = true
          continue
        }
        if !didRefreshRetry {
          // Token rejected: refresh via single-flight gate, rebuild ath with the new token.
          didRefreshRetry = true
          token = try await ensureRefreshed(staleToken: token)
          continue
        }
        // Refresh SUCCEEDED (ensureRefreshed would have thrown otherwise) yet the
        // resource still 401s — this is NOT a dead session (the token is valid),
        // it's a resource/authorization-level rejection. Surface it as a transient
        // serverError so callers fall back to cached data, NOT authenticationRequired
        // (which would route to re-sign-in / wipe tokens). Only a failed refresh
        // (ensureRefreshed → authenticationRequired) means the session is dead.
        throw MobileAPIError.serverError(status: 401)
      default:
        throw MobileAPIError.serverError(status: http.statusCode)
      }
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

  /// Build a basePath-preserving URL for a resource `path` (+ optional
  /// percent-encoded `query`). `serverURL.appending(path:)` keeps the
  /// deployment basePath (e.g. `/passwd-sso`); `URL(string:relativeTo:)` with
  /// an absolute (leading-`/`) path DROPS it, which 404s and breaks the DPoP
  /// htu. All resource calls must build URLs through this helper.
  func resourceURL(path: String, query: String? = nil) -> URL? {
    let base = serverURL.appending(path: path, directoryHint: .notDirectory)
    guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
      return nil
    }
    components.percentEncodedQuery = query
    return components.url
  }

  // canonicalHTU / sha256Base64URL moved to Shared (EntryUploader.swift) so
  // the extension-side uploader and this client share one implementation.
  // Unqualified calls in this file resolve to those free functions.

  /// Perform an HTTP request that returns no body; on 401 + new nonce, retry once.
  /// Throws `MobileAPIError.notFound` for 404, `.serverError(status:)` for other non-2xx.
  private func performVoidHTTP(
    _ request: URLRequest,
    makeRetry: ((String) async throws -> URLRequest)? = nil
  ) async throws {
    let (_, response) = try await performHTTP(request)
    let http = response as! HTTPURLResponse

    if let newNonce = http.value(forHTTPHeaderField: "DPoP-Nonce") {
      try? tokenStore.saveNonce(newNonce)
    }

    if http.statusCode == 401,
       let makeRetry,
       let newNonce = http.value(forHTTPHeaderField: "DPoP-Nonce") {
      let retryRequest = try await makeRetry(newNonce)
      let (_, retryResponse) = try await performHTTP(retryRequest)
      let retryHTTP = retryResponse as! HTTPURLResponse
      if let retryNonce = retryHTTP.value(forHTTPHeaderField: "DPoP-Nonce") {
        try? tokenStore.saveNonce(retryNonce)
      }
      try decodeVoidResponse(status: retryHTTP.statusCode)
      return
    }

    try decodeVoidResponse(status: http.statusCode)
  }

  private func decodeVoidResponse(status: Int) throws {
    switch status {
    case 200, 204:
      return
    case 404:
      throw MobileAPIError.notFound
    default:
      throw MobileAPIError.serverError(status: status)
    }
  }

  /// Perform a request whose success (200/201) response body is returned raw.
  /// On 401 + new nonce, retries once. 404 → .notFound; other non-2xx →
  /// .serverError(status:).
  private func performBodyHTTP(
    _ request: URLRequest,
    makeRetry: ((String) async throws -> URLRequest)? = nil
  ) async throws -> Data {
    let (data, response) = try await performHTTP(request)
    let http = response as! HTTPURLResponse

    if let newNonce = http.value(forHTTPHeaderField: "DPoP-Nonce") {
      try? tokenStore.saveNonce(newNonce)
    }

    if http.statusCode == 401,
       let makeRetry,
       let newNonce = http.value(forHTTPHeaderField: "DPoP-Nonce") {
      let retryRequest = try await makeRetry(newNonce)
      let (retryData, retryResponse) = try await performHTTP(retryRequest)
      let retryHTTP = retryResponse as! HTTPURLResponse
      if let retryNonce = retryHTTP.value(forHTTPHeaderField: "DPoP-Nonce") {
        try? tokenStore.saveNonce(retryNonce)
      }
      return try decodeBodyResponse(retryData, status: retryHTTP.statusCode)
    }

    return try decodeBodyResponse(data, status: http.statusCode)
  }

  private func decodeBodyResponse(_ data: Data, status: Int) throws -> Data {
    switch status {
    case 200, 201:
      return data
    case 404:
      throw MobileAPIError.notFound
    default:
      // Map the server's quota-exhaustion envelope to a dedicated case so the UI
      // can show an actionable message. Keyed off the body `error` code (not the
      // HTTP status) so unrelated 403s still surface as .serverError.
      if let envelope = try? JSONDecoder().decode(APIErrorEnvelope.self, from: data),
         envelope.error == "QUOTA_EXCEEDED" {
        throw MobileAPIError.quotaExceeded
      }
      throw MobileAPIError.serverError(status: status)
    }
  }

  /// Perform a create (POST) request that returns a body with an `id` field.
  /// Accepts 200 or 201 as success. On 401 + new nonce, retries once.
  private func performCreateHTTP(
    _ request: URLRequest,
    makeRetry: ((String) async throws -> URLRequest)? = nil
  ) async throws -> String {
    let data = try await performBodyHTTP(request, makeRetry: makeRetry)
    let resp = try JSONDecoder().decode(CreateEntryResponse.self, from: data)
    return resp.id
  }
}

// MARK: - Private response types

private struct CreateEntryResponse: Decodable {
  let id: String
}

/// Minimal error envelope used to detect server error codes on non-2xx
/// responses. Extra fields (resource/current/max) are ignored by JSONDecoder.
private struct APIErrorEnvelope: Decodable {
  let error: String
}
