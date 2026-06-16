import AuthenticationServices
import CryptoKit
import Foundation
import Security
import Shared

// MARK: - Types

public struct TokenPair: Sendable, Equatable {
  public let accessToken: String
  public let refreshToken: String
  public let expiresAt: Date
}

public enum AuthError: Error, Equatable {
  case keyGenerationFailed
  case randomGenerationFailed
  case stateMismatch
  case webAuthCancelled
  case webAuthFailed(String)
  case tokenExchangeFailed(MobileAPIError)
  case storeFailed
}

// MARK: - Coordinator

/// Orchestrates the iOS host-app authentication flow:
///   1. Generate/reuse the Secure Enclave DPoP key.
///   2. Build PKCE state, challenge, and device_jkt (RFC 7638 JWK thumbprint).
///   3. Open ASWebAuthenticationSession → receive redirect with bridge code.
///   4. POST /api/mobile/token with DPoP proof → store token pair.
///
/// The actor serializes concurrent sign-in attempts; a second call while one is
/// in-flight waits for the first to complete or fail.
public actor AuthCoordinator {
  private let serverConfig: ServerConfig
  let tokenStore: HostTokenStore
  /// PKCE verifier/state entropy length
  private let pkceRandomByteCount = 32
  private let dpopKeyLabel: String
  /// Seam for loading the persisted SE key. Defaults to `loadDPoPKey`, which
  /// filters on `kSecAttrTokenIDSecureEnclave` — invisible to the simulator
  /// software keys used in tests, so tests inject a software-key loader here.
  private let keyLoader: @Sendable (String) throws -> SecKey
  /// Custom URL scheme the server redirects the ASWebAuthenticationSession to
  /// on successful sign-in (`passwd-sso://auth/callback?code&state`). Captured
  /// by scheme, so it works against any self-hosted server host — no Universal
  /// Link / associated-domains entitlement required. Must match the
  /// CFBundleURLSchemes entry in Info.plist.
  static let callbackScheme = "passwd-sso"
  /// Set after the first successful call to getOrCreateDPoPKey.
  private var loadedKey: SecKey?

  public init(
    serverConfig: ServerConfig,
    tokenStore: HostTokenStore = HostTokenStore(),
    dpopKeyLabel: String = "com.passwd-sso.dpop.host",
    keyLoader: (@Sendable (String) throws -> SecKey)? = nil
  ) {
    precondition(!dpopKeyLabel.isEmpty, "dpopKeyLabel must not be empty")
    self.serverConfig = serverConfig
    self.tokenStore = tokenStore
    self.dpopKeyLabel = dpopKeyLabel
    self.keyLoader = keyLoader ?? { label in try loadDPoPKey(label: label) }
  }

  /// Load the persisted Secure Enclave DPoP key into `loadedKey` WITHOUT
  /// generating a new one. Returns true if an existing key was found. Used at
  /// launch to rebuild a signing-capable API client without a full OAuth
  /// sign-in; absence ⇒ no prior session ⇒ caller routes to sign-in.
  public func loadPersistedSigner() -> Bool {
    if let existing = try? keyLoader(dpopKeyLabel) {
      loadedKey = existing
      return true
    }
    return false
  }

  // MARK: - Public

  /// Full sign-in flow: PKCE + ASWebAuthSession + token exchange.
  ///
  /// The presentation context is consumed only on `@MainActor` (inside
  /// `launchWebAuthSession`). This function must be called from a context
  /// that can hop to the main actor for the session setup step.
  public func startSignIn(
    presentationContext: ASWebAuthenticationPresentationContextProviding & Sendable
  ) async throws -> TokenPair {
    let privateKey = try getOrCreateDPoPKey()
    let jwk = try exportPublicKeyJWK(key: privateKey)
    // C6 protocol switch: send the RFC 7638 JWK thumbprint (43 chars
    // base64url) instead of the legacy base64url(SPKI-DER) `device_pubkey`.
    // The server's DPoP verifier computes the same thumbprint from
    // proof.header.jwk, so cnf-binding works end-to-end.
    let deviceJkt = try computeJWKThumbprint(jwk: jwk)

    let (codeVerifier, codeChallenge, state) = try generatePKCEAndState()

    let authorizeURL = try buildAuthorizeURL(
      codeChallenge: codeChallenge,
      state: state,
      deviceJkt: deviceJkt
    )

    let callbackURL = try await AuthCoordinator.launchWebAuthSession(
      url: authorizeURL,
      presentationContext: presentationContext
    )

    let (code, receivedState) = try parseCallback(url: callbackURL)
    guard receivedState == state else { throw AuthError.stateMismatch }

    let signer = SecureEnclaveDPoPSigner(key: privateKey)
    let apiClient = MobileAPIClient(
      serverURL: serverConfig.baseURL,
      signer: signer,
      jwk: jwk,
      tokenStore: tokenStore
    )

    let tokenResponse: TokenExchangeResponse
    do {
      tokenResponse = try await apiClient.exchangeBridgeCode(
        code: code,
        codeVerifier: codeVerifier,
        deviceJkt: deviceJkt
      )
    } catch let apiError as MobileAPIError {
      throw AuthError.tokenExchangeFailed(apiError)
    }

    let expiresAt = Date().addingTimeInterval(TimeInterval(tokenResponse.expiresIn))
    do {
      try tokenStore.saveTokens(
        access: tokenResponse.accessToken,
        refresh: tokenResponse.refreshToken,
        expiresAt: expiresAt
      )
    } catch {
      throw AuthError.storeFailed
    }

    return TokenPair(
      accessToken: tokenResponse.accessToken,
      refreshToken: tokenResponse.refreshToken,
      expiresAt: expiresAt
    )
  }

  /// Returns a `SecureEnclaveDPoPSigner` wrapping the currently loaded SE key.
  /// Throws `AuthError.keyGenerationFailed` if no key has been loaded yet.
  public func currentSigner() throws -> SecureEnclaveDPoPSigner {
    guard let key = loadedKey else { throw AuthError.keyGenerationFailed }
    return SecureEnclaveDPoPSigner(key: key)
  }

  /// Returns the JWK dictionary for the currently loaded SE key.
  /// Throws `AuthError.keyGenerationFailed` if no key has been loaded yet.
  public func currentJWK() throws -> [String: String] {
    guard let key = loadedKey else { throw AuthError.keyGenerationFailed }
    return try exportPublicKeyJWK(key: key)
  }

  // MARK: - Static session launcher (@MainActor-isolated)

  /// Creates and starts the `ASWebAuthenticationSession` on the main actor.
  ///
  /// Uses a custom URL scheme callback (`passwd-sso://`) so sign-in works
  /// against any self-hosted server host. The session captures the redirect by
  /// scheme — no Universal Link / associated-domains entitlement, and no
  /// per-host configuration baked into the app at sign time.
  ///
  /// This is a static method so it can be called from the actor without
  /// violating Swift 6 Sendable rules — all inputs are `Sendable`; the
  /// presentation context is consumed only inside `@MainActor`.
  @MainActor
  private static func launchWebAuthSession(
    url: URL,
    presentationContext: ASWebAuthenticationPresentationContextProviding
  ) async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      let session = ASWebAuthenticationSession(
        url: url,
        callbackURLScheme: callbackScheme
      ) { callbackURL, error in
        if let error {
          let nsError = error as NSError
          if nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
            continuation.resume(throwing: AuthError.webAuthCancelled)
          } else {
            continuation.resume(throwing: AuthError.webAuthFailed(error.localizedDescription))
          }
          return
        }
        guard let callbackURL else {
          continuation.resume(throwing: AuthError.webAuthFailed("nil callback URL"))
          return
        }
        continuation.resume(returning: callbackURL)
      }

      session.prefersEphemeralWebBrowserSession = true
      session.presentationContextProvider = presentationContext
      session.start()
    }
  }

  // MARK: - Private helpers

  private func getOrCreateDPoPKey() throws -> SecKey {
    if let existing = try? loadDPoPKey(label: dpopKeyLabel) {
      loadedKey = existing
      return existing
    }
    do {
      let key = try generateDPoPKey(label: dpopKeyLabel)
      loadedKey = key
      return key
    } catch {
      throw AuthError.keyGenerationFailed
    }
  }

  /// Generate PKCE code_verifier (43-char base64url), code_challenge (S256), and state.
  private func generatePKCEAndState() throws -> (verifier: String, challenge: String, state: String) {
    let verifierBytes = try secureRandom(count: pkceRandomByteCount)
    let stateBytes = try secureRandom(count: pkceRandomByteCount)

    let verifier = base64URLEncode(verifierBytes)
    let state = base64URLEncode(stateBytes)

    let challengeData = Data(SHA256.hash(data: Data(verifier.utf8)))
    let challenge = base64URLEncode(challengeData)

    return (verifier, challenge, state)
  }

  private func buildAuthorizeURL(
    codeChallenge: String,
    state: String,
    deviceJkt: String
  ) throws -> URL {
    var components = URLComponents(
      url: serverConfig.baseURL.appending(
        path: APIPath.mobileAuthorize,
        directoryHint: .notDirectory
      ),
      resolvingAgainstBaseURL: false
    ) ?? URLComponents()
    components.queryItems = [
      URLQueryItem(name: "client_kind", value: "ios"),
      URLQueryItem(name: "state", value: state),
      URLQueryItem(name: "code_challenge", value: codeChallenge),
      URLQueryItem(name: "device_jkt", value: deviceJkt),
    ]
    guard let url = components.url else { throw AuthError.webAuthFailed("invalid authorize URL") }
    return url
  }

  /// Parse `code` and `state` from the Universal Link redirect URL.
  private func parseCallback(url: URL) throws -> (code: String, state: String) {
    guard
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
      let state = components.queryItems?.first(where: { $0.name == "state" })?.value,
      !code.isEmpty, !state.isEmpty
    else {
      throw AuthError.webAuthFailed("callback URL missing code or state")
    }
    return (code, state)
  }

  private func secureRandom(count: Int) throws -> Data {
    var data = Data(repeating: 0, count: count)
    let status = data.withUnsafeMutableBytes {
      SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!)
    }
    guard status == errSecSuccess else { throw AuthError.randomGenerationFailed }
    return data
  }
}
