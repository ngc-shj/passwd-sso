import Foundation
import Shared

// MARK: - Launch restoration outcome

/// Outcome of launch-time session restoration; the consumer (RootView) maps it
/// to the initial AppState. See docs/archive/review/ios-signin-flow-ux-plan.md (C3).
public enum RestoredSession: Sendable {
  /// No persisted server config — first run.
  case needsSetup
  /// No local unlock material (no tokens, or the SE signer is gone) → OAuth required.
  case needsSignIn(ServerConfig)
  /// A pin exists but the server's TLS identity no longer matches it (or the
  /// pinned probe failed while pinned) → route to the server-setup re-verify
  /// affordance, NOT a plain sign-in. Signing in would silently retry the same
  /// pinned session and fail again with no explanation. Fail-closed: the old
  /// pin is retained until the user explicitly re-verifies.
  case serverIdentityChanged(ServerConfig)
  /// Session usable (or offline) → auto-Face-ID unlock screen.
  case needsUnlock(ServerConfig, MobileAPIClient)
  /// Refresh failed but local vault material exists → unlock-or-resign-in screen.
  /// The dead-vs-transient signal is ambiguous at launch, so this routes to a
  /// screen that serves both (local unlock of the cached vault + "Sign in again").
  case needsReauth(ServerConfig, MobileAPIClient)
}

/// Result of probing whether the persisted session can still reach the server.
public enum SessionValidation: Sendable { case ok, offline, dead }

// MARK: - Session restorer

/// Decides the initial app state at launch from the persisted server config,
/// Keychain tokens, and the Secure Enclave signer — WITHOUT ever performing
/// destructive cleanup (tenant policy / QuickType / token wipe stay on the
/// explicit Sign-Out path). The routing is expressed over injected closures so
/// it is unit-testable without a real Secure Enclave or network.
public struct SessionRestorer: Sendable {
  let loadConfig: @Sendable () -> ServerConfig?
  let hasTokens: @Sendable () -> Bool
  let makeSession: @Sendable (ServerConfig) async -> MobileAPIClient?
  let validate: @Sendable (MobileAPIClient) async -> SessionValidation
  /// Whether a TLS pin is stored for this server. Used to disambiguate a
  /// `makeSession` failure: with a pin present, the failure is a pinned-probe /
  /// identity-mismatch (→ `.serverIdentityChanged`); with no pin it is a plain
  /// missing-credential case (→ `.needsSignIn`).
  let pinExists: @Sendable (ServerConfig) async -> Bool

  public init(
    loadConfig: @escaping @Sendable () -> ServerConfig?,
    hasTokens: @escaping @Sendable () -> Bool,
    makeSession: @escaping @Sendable (ServerConfig) async -> MobileAPIClient?,
    validate: @escaping @Sendable (MobileAPIClient) async -> SessionValidation,
    pinExists: @escaping @Sendable (ServerConfig) async -> Bool = { _ in false }
  ) {
    self.loadConfig = loadConfig
    self.hasTokens = hasTokens
    self.makeSession = makeSession
    self.validate = validate
    self.pinExists = pinExists
  }

  public func restore() async -> RestoredSession {
    guard let config = loadConfig() else { return .needsSetup }
    guard hasTokens() else { return .needsSignIn(config) }
    guard let client = await makeSession(config) else {
      // makeSession failed. If a pin is stored, the failure is a pinned-probe /
      // TLS-identity mismatch — route to re-verify, not a plain sign-in that
      // would silently hit the same wall. With no pin, it's a normal
      // missing-credential/first-trust case.
      if await pinExists(config) {
        return .serverIdentityChanged(config)
      }
      return .needsSignIn(config)
    }
    switch await validate(client) {
    case .ok, .offline:
      return .needsUnlock(config, client)
    case .dead:
      return .needsReauth(config, client)
    }
  }
}

// MARK: - Production wiring

extension SessionRestorer {
  /// Production wiring: server config from the App Group defaults, tokens from
  /// the Keychain, the persisted SE DPoP key, and the live refresh probe.
  public static func live(tokenStore: HostTokenStore = HostTokenStore()) -> SessionRestorer {
    SessionRestorer(
      loadConfig: { loadServerConfig() },
      hasTokens: {
        // `try?` (and the `?? nil` flatten) are intentional: a Keychain
        // decode/access error, or simply no stored token, both resolve to
        // `false` → routes to `.needsSignIn` rather than throwing out of this
        // non-throwing closure. Do NOT change to `try`.
        ((try? tokenStore.loadAccess()) ?? nil) != nil
          && ((try? tokenStore.loadRefresh()) ?? nil) != nil
      },
      makeSession: { config in
        let coordinator = AuthCoordinator(serverConfig: config, tokenStore: tokenStore)
        guard await coordinator.loadPersistedSigner() else { return nil }
        guard let signer = try? await coordinator.currentSigner(),
          let jwk = try? await coordinator.currentJWK()
        else { return nil }
        let trustService = ServerTrustService()
        guard let urlSession = try? await trustService.validatedSession(
          for: config.baseURL,
          healthURL: config.baseURL.appending(
            path: APIPath.healthLive,
            directoryHint: .notDirectory
          )
        )
        else { return nil }
        let baseURL = config.baseURL
        return MobileAPIClient(
          serverURL: config.baseURL,
          signer: signer,
          jwk: jwk,
          tokenStore: tokenStore,
          urlSession: urlSession,
          faviconSessionFactory: { cache in
            try await trustService.pinnedSession(for: baseURL, cache: cache)
          }
        )
      },
      pinExists: { config in
        // Only treat a makeSession failure as an identity change when the local
        // credentials ARE present (signer + jwk) — otherwise a plain
        // missing-signer failure would be misrouted to re-verify. Combined with
        // a stored pin, "credentials present + session build failed" is the
        // pinned-probe / TLS-mismatch signature.
        guard await ServerTrustService().currentPinExists(for: config.baseURL) else {
          return false
        }
        let coordinator = AuthCoordinator(serverConfig: config, tokenStore: tokenStore)
        guard await coordinator.loadPersistedSigner(),
          (try? await coordinator.currentSigner()) != nil,
          (try? await coordinator.currentJWK()) != nil
        else { return false }
        return true
      },
      validate: { client in
        do {
          try await client.ensureValidSession()
          return .ok
        } catch MobileAPIError.networkError {
          return .offline
        } catch {
          return .dead
        }
      }
    )
  }
}
