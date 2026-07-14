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
  /// `nonisolated` so launch-restore can read it to build the pin probe URL
  /// without hopping onto the actor. Immutable + Sendable, so this is safe.
  nonisolated let serverURL: URL
  let signer: DPoPSigner
  let jwk: [String: String]
  let tokenStore: HostTokenStore
  private let urlSession: URLSession
  private let now: @Sendable () -> Date
  /// Process-global refresh gate. Defaults to the shared instance so every client
  /// in the app collapses concurrent refreshes; tests inject a fresh instance to
  /// isolate the success cache per test.
  private let refreshCoordinator: TokenRefreshCoordinator
  /// Builds a pinned session with an isolated cache for favicon fetches. `nil`
  /// in tests (they inject a session directly into FaviconLoader). Favicon
  /// requests carry a live bearer token to the app's own server, so they use
  /// the same TLS pin as every other API call — never an unpinned session.
  private let faviconSessionFactory: (@Sendable (URLCache) async throws -> URLSession)?

  /// `urlSession` has no default: every authenticated call to the app's own
  /// server must run over the pinned session established at sign-in. A `.shared`
  /// default previously let a caller silently fall back to an unpinned session.
  public init(
    serverURL: URL,
    signer: DPoPSigner,
    jwk: [String: String],
    tokenStore: HostTokenStore,
    urlSession: URLSession,
    faviconSessionFactory: (@Sendable (URLCache) async throws -> URLSession)? = nil,
    now: @Sendable @escaping () -> Date = { Date() },
    refreshCoordinator: TokenRefreshCoordinator = .shared
  ) {
    self.serverURL = serverURL
    self.signer = signer
    self.jwk = jwk
    self.tokenStore = tokenStore
    self.urlSession = urlSession
    self.faviconSessionFactory = faviconSessionFactory
    self.now = now
    self.refreshCoordinator = refreshCoordinator
  }

  /// A pinned favicon session with the given isolated cache, or `nil` when this
  /// client was built without a factory (tests). The caller treats `nil` as "no
  /// favicon" and never falls back to an unpinned session.
  public func makeFaviconSession(cache: URLCache) async -> URLSession? {
    guard let faviconSessionFactory else { return nil }
    return try? await faviconSessionFactory(cache)
  }

  // MARK: - Public API

  /// Exchange a bridge code for an access+refresh token pair (step 2 of iOS auth handshake).
  public func exchangeBridgeCode(
    code: String,
    codeVerifier: String,
    deviceJkt: String
  ) async throws -> TokenExchangeResponse {
    let tokenURL = serverURL.appending(path: APIPath.mobileToken, directoryHint: .notDirectory)
    let htu = canonicalHTU(url: tokenURL)

    // Capture values before crossing into async context so retry closure doesn't need await.
    let localJWK = jwk
    let localSigner = signer

    let nonce = try? tokenStore.loadNonce()
    let proof = try await buildDPoPProof(
      htm: HTTPMethod.post,
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
    request.httpMethod = HTTPMethod.post
    request.setValue(HTTPContentType.json, forHTTPHeaderField: HTTPHeader.contentType)
    request.setValue(proof.jws, forHTTPHeaderField: HTTPHeader.dpop)
    request.httpBody = bodyData

    return try await performTokenRequest(request) { newNonce in
      let retryProof = try await buildDPoPProof(
        htm: HTTPMethod.post,
        htu: htu,
        jwk: localJWK,
        nonce: newNonce,
        signer: localSigner
      )
      var retryRequest = request
      retryRequest.setValue(retryProof.jws, forHTTPHeaderField: HTTPHeader.dpop)
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
      path: APIPath.mobileTokenRefresh,
      directoryHint: .notDirectory
    )
    let htu = canonicalHTU(url: refreshURL)
    let ath = sha256Base64URL(refreshToken)

    let localJWK = jwk
    let localSigner = signer

    let nonce = try? tokenStore.loadNonce()
    let proof = try await buildDPoPProof(
      htm: HTTPMethod.post,
      htu: htu,
      jwk: localJWK,
      ath: ath,
      nonce: nonce,
      signer: localSigner
    )

    let body: [String: String] = ["refresh_token": refreshToken]
    let bodyData = try JSONEncoder().encode(body)

    var request = URLRequest(url: refreshURL)
    request.httpMethod = HTTPMethod.post
    request.setValue(HTTPContentType.json, forHTTPHeaderField: HTTPHeader.contentType)
    // SECURITY: never log this request or its headers — Authorization carries the refresh token.
    request.setValue("\(HTTPAuthScheme.dpopPrefix)\(refreshToken)", forHTTPHeaderField: HTTPHeader.authorization)
    request.setValue(proof.jws, forHTTPHeaderField: HTTPHeader.dpop)
    request.httpBody = bodyData

    return try await performTokenRequest(request) { newNonce in
      let retryProof = try await buildDPoPProof(
        htm: HTTPMethod.post,
        htu: htu,
        jwk: localJWK,
        ath: ath,
        nonce: newNonce,
        signer: localSigner
      )
      var retryRequest = request
      retryRequest.setValue(retryProof.jws, forHTTPHeaderField: HTTPHeader.dpop)
      return retryRequest
    }
  }

  // MARK: - Protected resource API

  /// Fetch vault unlock data from GET /api/vault/unlock/data.
  /// Requires a valid access token (DPoP-signed). Applies the full C3 retry ladder.
  public func fetchVaultUnlockData() async throws -> VaultUnlockData {
    let url = serverURL.appending(path: APIPath.vaultUnlockData, directoryHint: .notDirectory)
    let data = try await performAuthedGET(url: url)
    return try JSONDecoder().decode(VaultUnlockData.self, from: data)
  }

  /// Fetch encrypted team entries (flat response format) for a given team.
  /// Requires a valid access token (DPoP-signed). Applies the full C3 retry ladder.
  public func fetchTeamEntries(teamId: String) async throws -> [TeamEncryptedEntry] {
    guard let endpointURL = resourceURL(path: APIPath.teamPasswords(teamId: teamId), query: "include=blob") else {
      throw MobileAPIError.serverError(status: 400)
    }
    let data = try await performAuthedGET(url: endpointURL)
    return try JSONDecoder().decode([TeamEncryptedEntry].self, from: data)
  }

  /// Fetch this user's wrapped team key for a team (GET /api/teams/{id}/member-key).
  /// 403 (KEY_NOT_DISTRIBUTED) / 404 (MEMBER_KEY_NOT_FOUND) → `teamKeyNotDistributed`
  /// so the sync caller skips the team rather than failing the whole sync.
  public func fetchTeamMemberKey(teamId: String) async throws -> TeamMemberKeyResponse {
    let url = serverURL.appending(path: APIPath.teamMemberKey(teamId: teamId), directoryHint: .notDirectory)
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
  /// On 401, applies the full retry ladder (DPoP-nonce retry, then token-refresh retry).
  public func postCacheRollbackReport(_ body: CacheRollbackReportBody) async throws {
    let accessToken = try await validAccessToken()

    let endpoint = serverURL.appending(
      path: APIPath.mobileCacheRollbackReport,
      directoryHint: .notDirectory
    )
    let htu = canonicalHTU(url: endpoint)
    let ath = sha256Base64URL(accessToken)

    let localJWK = jwk
    let localSigner = signer
    let nonce = try? tokenStore.loadNonce()
    let proof = try await buildDPoPProof(
      htm: HTTPMethod.post,
      htu: htu,
      jwk: localJWK,
      ath: ath,
      nonce: nonce,
      signer: localSigner
    )

    let bodyData = try JSONEncoder().encode(body)
    var request = URLRequest(url: endpoint)
    request.httpMethod = HTTPMethod.post
    request.setValue(HTTPContentType.json, forHTTPHeaderField: HTTPHeader.contentType)
    request.setValue("\(HTTPAuthScheme.bearerPrefix)\(accessToken)", forHTTPHeaderField: HTTPHeader.authorization)
    request.setValue(proof.jws, forHTTPHeaderField: HTTPHeader.dpop)
    request.httpBody = bodyData

    try await performVoidHTTP(request, staleToken: accessToken) { nonce, freshToken in
      let token = freshToken ?? accessToken
      let retryProof = try await buildDPoPProof(
        htm: HTTPMethod.post,
        htu: htu,
        jwk: localJWK,
        ath: freshToken != nil ? sha256Base64URL(token) : ath,
        nonce: nonce ?? (try? self.tokenStore.loadNonce()),
        signer: localSigner
      )
      var retryRequest = request
      if freshToken != nil {
        retryRequest.setValue("\(HTTPAuthScheme.bearerPrefix)\(token)", forHTTPHeaderField: HTTPHeader.authorization)
      }
      retryRequest.setValue(retryProof.jws, forHTTPHeaderField: HTTPHeader.dpop)
      return retryRequest
    }
  }

  /// Create a new personal entry via POST /api/passwords.
  /// Requires a valid access token (DPoP-signed with ath).
  /// On 401, applies the full retry ladder (DPoP-nonce retry, then token-refresh retry).
  /// Returns the server-stored entry id (must equal the client-generated id).
  public func createEntry(body: CreateEntryRequest) async throws -> String {
    let accessToken = try await validAccessToken()

    let endpoint = serverURL.appending(
      path: APIPath.passwords,
      directoryHint: .notDirectory
    )
    let htu = canonicalHTU(url: endpoint)
    let ath = sha256Base64URL(accessToken)

    let localJWK = jwk
    let localSigner = signer
    let nonce = try? tokenStore.loadNonce()
    let proof = try await buildDPoPProof(
      htm: HTTPMethod.post,
      htu: htu,
      jwk: localJWK,
      ath: ath,
      nonce: nonce,
      signer: localSigner
    )

    let bodyData = try JSONEncoder().encode(body)
    var request = URLRequest(url: endpoint)
    request.httpMethod = HTTPMethod.post
    request.setValue(HTTPContentType.json, forHTTPHeaderField: HTTPHeader.contentType)
    request.setValue("\(HTTPAuthScheme.bearerPrefix)\(accessToken)", forHTTPHeaderField: HTTPHeader.authorization)
    request.setValue(proof.jws, forHTTPHeaderField: HTTPHeader.dpop)
    request.httpBody = bodyData

    return try await performCreateHTTP(request, staleToken: accessToken) { nonce, freshToken in
      let token = freshToken ?? accessToken
      let retryProof = try await buildDPoPProof(
        htm: HTTPMethod.post,
        htu: htu,
        jwk: localJWK,
        ath: freshToken != nil ? sha256Base64URL(token) : ath,
        nonce: nonce ?? (try? self.tokenStore.loadNonce()),
        signer: localSigner
      )
      var retryRequest = request
      if freshToken != nil {
        retryRequest.setValue("\(HTTPAuthScheme.bearerPrefix)\(token)", forHTTPHeaderField: HTTPHeader.authorization)
      }
      retryRequest.setValue(retryProof.jws, forHTTPHeaderField: HTTPHeader.dpop)
      return retryRequest
    }
  }

  /// Mint a short-lived, DPoP-bound AutoFill upload token via
  /// POST /api/mobile/autofill-token (plan C6). `extensionJWK` is the AutoFill
  /// extension's OWN shared-group SE public key — the server binds the minted
  /// token to its thumbprint, so only the extension can spend it.
  /// On 401, applies the full retry ladder (DPoP-nonce retry, then token-refresh retry).
  public func mintAutofillToken(extensionJWK: [String: String]) async throws -> AutofillTokenResponse {
    let accessToken = try await validAccessToken()

    let endpoint = serverURL.appending(
      path: APIPath.mobileAutofillToken,
      directoryHint: .notDirectory
    )
    let htu = canonicalHTU(url: endpoint)
    let ath = sha256Base64URL(accessToken)

    let localJWK = jwk
    let localSigner = signer
    let nonce = try? tokenStore.loadNonce()
    let proof = try await buildDPoPProof(
      htm: HTTPMethod.post,
      htu: htu,
      jwk: localJWK,
      ath: ath,
      nonce: nonce,
      signer: localSigner
    )

    let bodyData = try JSONEncoder().encode(["jwk": extensionJWK])
    var request = URLRequest(url: endpoint)
    request.httpMethod = HTTPMethod.post
    request.setValue(HTTPContentType.json, forHTTPHeaderField: HTTPHeader.contentType)
    request.setValue("\(HTTPAuthScheme.bearerPrefix)\(accessToken)", forHTTPHeaderField: HTTPHeader.authorization)
    request.setValue(proof.jws, forHTTPHeaderField: HTTPHeader.dpop)
    request.httpBody = bodyData

    let data = try await performBodyHTTP(request, staleToken: accessToken) { nonce, freshToken in
      let token = freshToken ?? accessToken
      let retryProof = try await buildDPoPProof(
        htm: HTTPMethod.post,
        htu: htu,
        jwk: localJWK,
        ath: freshToken != nil ? sha256Base64URL(token) : ath,
        nonce: nonce ?? (try? self.tokenStore.loadNonce()),
        signer: localSigner
      )
      var retryRequest = request
      if freshToken != nil {
        retryRequest.setValue("\(HTTPAuthScheme.bearerPrefix)\(token)", forHTTPHeaderField: HTTPHeader.authorization)
      }
      retryRequest.setValue(retryProof.jws, forHTTPHeaderField: HTTPHeader.dpop)
      return retryRequest
    }
    return try JSONDecoder().decode(AutofillTokenResponse.self, from: data)
  }

  /// Update an existing personal entry via PUT /api/passwords/{entryId}.
  /// Requires a valid access token (DPoP-signed with ath).
  /// On 401, applies the full retry ladder (DPoP-nonce retry, then token-refresh retry).
  public func updateEntry(entryId: String, body: UpdateEntryRequest) async throws {
    let accessToken = try await validAccessToken()

    let endpoint = serverURL.appending(
      path: APIPath.password(id: entryId),
      directoryHint: .notDirectory
    )
    let htu = canonicalHTU(url: endpoint)
    let ath = sha256Base64URL(accessToken)

    let localJWK = jwk
    let localSigner = signer
    let nonce = try? tokenStore.loadNonce()
    let proof = try await buildDPoPProof(
      htm: HTTPMethod.put,
      htu: htu,
      jwk: localJWK,
      ath: ath,
      nonce: nonce,
      signer: localSigner
    )

    let bodyData = try JSONEncoder().encode(body)
    var request = URLRequest(url: endpoint)
    request.httpMethod = HTTPMethod.put
    request.setValue(HTTPContentType.json, forHTTPHeaderField: HTTPHeader.contentType)
    request.setValue("\(HTTPAuthScheme.bearerPrefix)\(accessToken)", forHTTPHeaderField: HTTPHeader.authorization)
    request.setValue(proof.jws, forHTTPHeaderField: HTTPHeader.dpop)
    request.httpBody = bodyData

    try await performVoidHTTP(request, staleToken: accessToken) { nonce, freshToken in
      let token = freshToken ?? accessToken
      let retryProof = try await buildDPoPProof(
        htm: HTTPMethod.put,
        htu: htu,
        jwk: localJWK,
        ath: freshToken != nil ? sha256Base64URL(token) : ath,
        nonce: nonce ?? (try? self.tokenStore.loadNonce()),
        signer: localSigner
      )
      var retryRequest = request
      if freshToken != nil {
        retryRequest.setValue("\(HTTPAuthScheme.bearerPrefix)\(token)", forHTTPHeaderField: HTTPHeader.authorization)
      }
      retryRequest.setValue(retryProof.jws, forHTTPHeaderField: HTTPHeader.dpop)
      return retryRequest
    }
  }

  // MARK: - Favicon (C9)

  /// Fetch a favicon image from `url` using the CALLER'S `session` (for
  /// per-caller URLCache isolation, per F15). Applies the full DPoP retry ladder
  /// (nonce-retry, refresh-retry, ≤ 3 total requests) identical to performAuthedGET
  /// but returns the raw HTTP status, Content-Type header, and body for ALL 2xx/204
  /// responses so the caller can decide whether the body is a usable image (200)
  /// or a "no favicon" signal (204). On non-2xx after the ladder the status is
  /// returned without throwing; only a dead refresh throws .authenticationRequired.
  func fetchFavicon(
    url: URL,
    using session: URLSession
  ) async throws -> (status: Int, contentType: String?, body: Data) {
    let initial = try await validAccessToken()
    let htu = canonicalHTU(url: url)
    let localJWK = jwk
    let localSigner = signer
    var token = initial
    var nonce = try? tokenStore.loadNonce()
    var didNonceRetry = false, didRefreshRetry = false

    while true {
      let proof = try await buildDPoPProof(
        htm: HTTPMethod.get, htu: htu, jwk: localJWK, ath: sha256Base64URL(token),
        nonce: nonce, signer: localSigner
      )
      var request = URLRequest(url: url)
      request.httpMethod = HTTPMethod.get
      request.setValue("\(HTTPAuthScheme.bearerPrefix)\(token)", forHTTPHeaderField: HTTPHeader.authorization)
      request.setValue(proof.jws, forHTTPHeaderField: HTTPHeader.dpop)

      let (data, response): (Data, URLResponse)
      do {
        (data, response) = try await session.data(for: request)
      } catch let urlError as URLError {
        throw MobileAPIError.networkError(urlError)
      }
      let http = response as! HTTPURLResponse

      let freshNonce = http.value(forHTTPHeaderField: HTTPHeader.dpopNonce)
      if let n = freshNonce {
        try? tokenStore.saveNonce(n)
        nonce = n
      }

      switch http.statusCode {
      case 200, 204:
        let contentType = http.value(forHTTPHeaderField: "Content-Type")
        return (http.statusCode, contentType, data)
      case 401:
        if !didNonceRetry, freshNonce != nil {
          didNonceRetry = true
          continue
        }
        if !didRefreshRetry {
          didRefreshRetry = true
          token = try await ensureRefreshed(staleToken: token)
          continue
        }
        // Post-refresh 401 on a favicon is not a dead session — surface status.
        return (http.statusCode, nil, data)
      default:
        // Non-2xx (403, 404, 5xx, etc.): return status without throwing so the
        // caller can map to nil favicon rather than surfacing an error.
        return (http.statusCode, nil, data)
      }
    }
  }

  /// GET /api/mobile/favicon-pref → decoded `{fetchFavicons: Bool}`.
  public func getFaviconPref() async throws -> Bool {
    let url = serverURL.appending(path: APIPath.mobileFaviconPref, directoryHint: .notDirectory)
    let data = try await performAuthedGET(url: url)
    let decoded = try JSONDecoder().decode(FaviconPrefResponse.self, from: data)
    return decoded.fetchFavicons
  }

  /// PUT /api/mobile/favicon-pref with body `{fetchFavicons: Bool}` → echoed value.
  public func setFaviconPref(_ on: Bool) async throws -> Bool {
    let accessToken = try await validAccessToken()

    let endpoint = serverURL.appending(
      path: APIPath.mobileFaviconPref,
      directoryHint: .notDirectory
    )
    let htu = canonicalHTU(url: endpoint)
    let ath = sha256Base64URL(accessToken)

    let localJWK = jwk
    let localSigner = signer
    let nonce = try? tokenStore.loadNonce()
    let proof = try await buildDPoPProof(
      htm: HTTPMethod.put,
      htu: htu,
      jwk: localJWK,
      ath: ath,
      nonce: nonce,
      signer: localSigner
    )

    let bodyData = try JSONEncoder().encode(["fetchFavicons": on])
    var request = URLRequest(url: endpoint)
    request.httpMethod = HTTPMethod.put
    request.setValue(HTTPContentType.json, forHTTPHeaderField: HTTPHeader.contentType)
    request.setValue("\(HTTPAuthScheme.bearerPrefix)\(accessToken)", forHTTPHeaderField: HTTPHeader.authorization)
    request.setValue(proof.jws, forHTTPHeaderField: HTTPHeader.dpop)
    request.httpBody = bodyData

    let data = try await performBodyHTTP(request, staleToken: accessToken) { nonce, freshToken in
      let token = freshToken ?? accessToken
      let retryProof = try await buildDPoPProof(
        htm: HTTPMethod.put,
        htu: htu,
        jwk: localJWK,
        ath: freshToken != nil ? sha256Base64URL(token) : ath,
        nonce: nonce ?? (try? self.tokenStore.loadNonce()),
        signer: localSigner
      )
      var retryRequest = request
      if freshToken != nil {
        retryRequest.setValue("\(HTTPAuthScheme.bearerPrefix)\(token)", forHTTPHeaderField: HTTPHeader.authorization)
      }
      retryRequest.setValue(retryProof.jws, forHTTPHeaderField: HTTPHeader.dpop)
      return retryRequest
    }
    let decoded = try JSONDecoder().decode(FaviconPrefResponse.self, from: data)
    return decoded.fetchFavicons
  }

  // MARK: - Token management (C1/C2)

  /// Proactive refresh skew: refresh the access token when it is within this many seconds of expiry.
  private let refreshSkewSeconds: TimeInterval = 60

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
  ///
  /// The single-flight is enforced PROCESS-GLOBALLY via `TokenRefreshCoordinator`,
  /// keyed by the token store's Keychain identifier — so distinct `MobileAPIClient`
  /// instances backed by the same token store never fire concurrent refreshes with
  /// the same refresh token (which would trip the server's replay detector and
  /// revoke the whole token family). The instance-local `staleToken` fast-path
  /// below still short-circuits when a prior refresh already rotated the token.
  private func ensureRefreshed(staleToken: String) async throws -> String {
    // Already rotated (by this or another instance) — return the current token
    // without a network round-trip.
    if let (current, _) = try? tokenStore.loadAccess(), current != staleToken { return current }
    // Process-global single-flight: collapse concurrent refreshes (across all
    // MobileAPIClient instances backed by the same token store) into ONE network
    // refresh, so we never present an already-rotated (revoked) refresh token to
    // the server and trip its replay detector.
    let key = tokenStore.serviceIdentifier
    return try await refreshCoordinator.run(key: key) { [self] in
      // Re-check inside the gate: a refresh that ran while we queued may have
      // already rotated the token, making our network refresh unnecessary.
      if let (current, _) = try? await self.loadAccessOnActor(), current != staleToken {
        return current
      }
      return try await self.doRefreshAndPersist()
    }
  }

  /// Actor-isolated Keychain read used inside the global refresh gate.
  private func loadAccessOnActor() throws -> (String, Date)? {
    try tokenStore.loadAccess()
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

  /// Launch-time session probe: returns when a usable access token is available
  /// (already valid, or refreshed), throws `.networkError` when offline, and
  /// `.authenticationRequired` when the session is dead (refresh rejected).
  /// Makes NO network request when the stored access token is still within its
  /// validity window — safe to call on an offline launch.
  public func ensureValidSession() async throws {
    _ = try await validAccessToken()
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
        htm: HTTPMethod.get, htu: htu, jwk: localJWK, ath: sha256Base64URL(token),
        nonce: nonce, signer: localSigner
      )
      var request = URLRequest(url: url)
      request.httpMethod = HTTPMethod.get
      request.setValue("\(HTTPAuthScheme.bearerPrefix)\(token)", forHTTPHeaderField: HTTPHeader.authorization)
      request.setValue(proof.jws, forHTTPHeaderField: HTTPHeader.dpop)
      let (data, response) = try await performHTTP(request)
      let http = response as! HTTPURLResponse
      // A nonce in THIS response is the actual challenge signal; a stale stored
      // nonce must NOT trigger a nonce-retry (keeps the ladder bounded at ≤3).
      let freshNonce = http.value(forHTTPHeaderField: HTTPHeader.dpopNonce)
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
    if let newNonce = http.value(forHTTPHeaderField: HTTPHeader.dpopNonce) {
      try? tokenStore.saveNonce(newNonce)
    }

    // On 401 with a new nonce and a retry closure, retry once.
    if http.statusCode == 401,
       let makeRetry,
       let newNonce = http.value(forHTTPHeaderField: HTTPHeader.dpopNonce) {
      let retryRequest = try await makeRetry(newNonce)
      let (retryData, retryResponse) = try await performHTTP(retryRequest)
      let retryHTTP = retryResponse as! HTTPURLResponse
      if let retryNonce = retryHTTP.value(forHTTPHeaderField: HTTPHeader.dpopNonce) {
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

  /// Closure that rebuilds a mutating request for a retry. Both arguments are
  /// nil-unless-relevant so one closure serves both rungs of the ladder:
  ///   - `nonce != nil`  → a DPoP-Nonce challenge: re-sign the proof with it
  ///     (same access token / ath).
  ///   - `freshToken != nil` → the access token was refreshed: rebuild the ath
  ///     from the new token AND swap the Authorization header to it.
  /// Exactly one is non-nil per invocation.
  typealias MutatingRetryBuilder = (_ nonce: String?, _ freshToken: String?) async throws -> URLRequest

  /// Shared retry ladder for mutating (non-GET) requests, mirroring
  /// `performAuthedGET` so mutating calls recover from an expired access token
  /// the same way GETs do:
  ///   1. Initial request.
  ///   2. On 401 with a fresh DPoP-Nonce (once): nonce-retry, same token.
  ///   3. On still-401 (once): refresh via the single-flight gate, retry with the
  ///      new token (rebuilt ath + Authorization).
  ///   4. Still 401 → return status 401 to the decoder (surfaces .serverError(401),
  ///      NOT .authenticationRequired — a failed REFRESH already threw that).
  /// Saves any DPoP-Nonce on every response. `staleToken` is the access token the
  /// caller signed the initial request with — the refresh rung passes it to the
  /// single-flight gate so a token already rotated by a concurrent call is reused
  /// instead of triggering a second refresh.
  private func performMutatingWithLadder(
    _ request: URLRequest,
    staleToken: String,
    makeRetry: MutatingRetryBuilder?
  ) async throws -> (Data, Int) {
    var current = request
    var didNonceRetry = false
    var didRefreshRetry = false
    var token = staleToken

    while true {
      let (data, response) = try await performHTTP(current)
      let http = response as! HTTPURLResponse
      let freshNonce = http.value(forHTTPHeaderField: HTTPHeader.dpopNonce)
      if let freshNonce {
        try? tokenStore.saveNonce(freshNonce)
      }

      if http.statusCode == 401, let makeRetry {
        // Rung 2: a nonce in THIS response is the challenge signal; a stale
        // stored nonce must NOT drive a retry (keeps the ladder bounded at ≤3).
        if !didNonceRetry, freshNonce != nil {
          didNonceRetry = true
          current = try await makeRetry(freshNonce, nil)
          continue
        }
        // Rung 3: token rejected — refresh and retry with the new token. A failed
        // refresh throws .authenticationRequired from ensureRefreshed.
        if !didRefreshRetry {
          didRefreshRetry = true
          token = try await ensureRefreshed(staleToken: token)
          current = try await makeRetry(nil, token)
          continue
        }
      }

      return (data, http.statusCode)
    }
  }

  /// Perform an HTTP request that returns no body; full 401 ladder (nonce +
  /// token refresh). Throws `MobileAPIError.notFound` for 404,
  /// `.serverError(status:)` for other non-2xx.
  private func performVoidHTTP(
    _ request: URLRequest,
    staleToken: String,
    makeRetry: MutatingRetryBuilder? = nil
  ) async throws {
    let (_, status) = try await performMutatingWithLadder(
      request, staleToken: staleToken, makeRetry: makeRetry)
    try decodeVoidResponse(status: status)
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

  /// Perform a request whose success (200/201) response body is returned raw;
  /// full 401 ladder (nonce + token refresh). 404 → .notFound; other non-2xx →
  /// .serverError(status:).
  private func performBodyHTTP(
    _ request: URLRequest,
    staleToken: String,
    makeRetry: MutatingRetryBuilder? = nil
  ) async throws -> Data {
    let (data, status) = try await performMutatingWithLadder(
      request, staleToken: staleToken, makeRetry: makeRetry)
    return try decodeBodyResponse(data, status: status)
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
  /// Accepts 200 or 201 as success; full 401 ladder (nonce + token refresh).
  private func performCreateHTTP(
    _ request: URLRequest,
    staleToken: String,
    makeRetry: MutatingRetryBuilder? = nil
  ) async throws -> String {
    let data = try await performBodyHTTP(request, staleToken: staleToken, makeRetry: makeRetry)
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

/// Response shape for GET/PUT /api/mobile/favicon-pref.
private struct FaviconPrefResponse: Decodable {
  let fetchFavicons: Bool
}
