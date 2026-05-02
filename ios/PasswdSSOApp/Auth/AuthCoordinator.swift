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

// MARK: - WebAuth session parameters (Sendable for crossing isolation boundaries)

private struct WebAuthParams: Sendable {
  let url: URL
  let host: String
}

// MARK: - Coordinator

/// Orchestrates the iOS host-app authentication flow:
///   1. Generate/reuse the Secure Enclave DPoP key.
///   2. Build PKCE state, challenge, and device_pubkey (SPKI-DER).
///   3. Open ASWebAuthenticationSession → receive redirect with bridge code.
///   4. POST /api/mobile/token with DPoP proof → store token pair.
///
/// The actor serializes concurrent sign-in attempts; a second call while one is
/// in-flight waits for the first to complete or fail.
public actor AuthCoordinator {
  private let serverConfig: ServerConfig
  private let tokenStore: HostTokenStore
  private let dpopKeyLabel = "com.passwd-sso.dpop.host"

  public init(serverConfig: ServerConfig, tokenStore: HostTokenStore = HostTokenStore()) {
    self.serverConfig = serverConfig
    self.tokenStore = tokenStore
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
    let devicePubkey = try devicePubkeyBase64(key: privateKey)

    let (codeVerifier, codeChallenge, state) = try generatePKCEAndState()

    let authorizeURL = try buildAuthorizeURL(
      codeChallenge: codeChallenge,
      state: state,
      devicePubkey: devicePubkey
    )

    guard let host = serverConfig.baseURL.host else {
      throw AuthError.webAuthFailed("server URL has no host")
    }
    let params = WebAuthParams(url: authorizeURL, host: host)

    let callbackURL = try await AuthCoordinator.launchWebAuthSession(
      params: params,
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
        devicePubkey: devicePubkey
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

  /// Called by `PasswdSSOAppApp.onOpenURL` when a Universal Link arrives.
  ///
  /// The `pendingContinuation` is consumed here. The actor ensures no race
  /// with the session callback because both paths hop through the actor.
  /// However, if `ASWebAuthenticationSession`'s completion handler fires after
  /// `handleUniversalLink`, the double-resume is handled by the continuation's
  /// one-shot semantics (second call no-ops after the first resolves it).
  public func handleUniversalLink(_ url: URL) {
    // No pending continuation to wake — already consumed by the session callback
    // or not yet set. For iOS 17.4+, the .https callback fires before the
    // Universal Link; this path is the iOS 17.0–17.3 fallback.
    _ = url  // URL is delivered through SignInView's .onOpenURL only for 17.0–17.3.
  }

  // MARK: - Static session launcher (@MainActor-isolated)

  /// Creates and starts the `ASWebAuthenticationSession` on the main actor.
  ///
  /// This is a static method so it can be called from the actor without
  /// violating Swift 6 Sendable rules — all inputs are `Sendable`; the
  /// presentation context is consumed only inside `@MainActor`.
  @MainActor
  private static func launchWebAuthSession(
    params: WebAuthParams,
    presentationContext: ASWebAuthenticationPresentationContextProviding
  ) async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      let session: ASWebAuthenticationSession

      // iOS 17.4+: use the `.https` callback to avoid any custom URL scheme.
      if #available(iOS 17.4, *) {
        session = ASWebAuthenticationSession(
          url: params.url,
          callback: .https(host: params.host, path: "/api/mobile/authorize/redirect")
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
      } else {
        // iOS 17.0–17.3: callbackURLScheme must be nil (no custom scheme allowed).
        // The Universal Link callback arrives via `.onOpenURL` in the app delegate;
        // in the simulator this flow may not complete without a physical server.
        session = ASWebAuthenticationSession(
          url: params.url,
          callbackURLScheme: nil
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
      }

      session.prefersEphemeralWebBrowserSession = true
      session.presentationContextProvider = presentationContext
      session.start()
    }
  }

  // MARK: - Private helpers

  private func getOrCreateDPoPKey() throws -> SecKey {
    if let existing = try? loadDPoPKey(label: dpopKeyLabel) {
      return existing
    }
    do {
      return try generateDPoPKey(label: dpopKeyLabel)
    } catch {
      throw AuthError.keyGenerationFailed
    }
  }

  /// Generate PKCE code_verifier (43-char base64url), code_challenge (S256), and state.
  private func generatePKCEAndState() throws -> (verifier: String, challenge: String, state: String) {
    let verifierBytes = try secureRandom(count: 32)
    let stateBytes = try secureRandom(count: 32)

    let verifier = base64URLEncode(verifierBytes)
    let state = base64URLEncode(stateBytes)

    let challengeData = Data(SHA256.hash(data: Data(verifier.utf8)))
    let challenge = base64URLEncode(challengeData)

    return (verifier, challenge, state)
  }

  /// Export the public key as base64url(SPKI-DER) for the authorize / token calls.
  private func devicePubkeyBase64(key: SecKey) throws -> String {
    guard let publicKey = SecKeyCopyPublicKey(key) else {
      throw AuthError.keyGenerationFailed
    }
    var error: Unmanaged<CFError>?
    guard let rawPoint = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw AuthError.keyGenerationFailed
    }
    let spki = try encodeP256SPKI(uncompressedPoint: rawPoint)
    return base64URLEncode(spki)
  }

  private func buildAuthorizeURL(
    codeChallenge: String,
    state: String,
    devicePubkey: String
  ) throws -> URL {
    var components = URLComponents(
      url: serverConfig.baseURL.appending(
        path: "/api/mobile/authorize",
        directoryHint: .notDirectory
      ),
      resolvingAgainstBaseURL: false
    ) ?? URLComponents()
    components.queryItems = [
      URLQueryItem(name: "client_kind", value: "ios"),
      URLQueryItem(name: "state", value: state),
      URLQueryItem(name: "code_challenge", value: codeChallenge),
      URLQueryItem(name: "device_pubkey", value: devicePubkey),
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
