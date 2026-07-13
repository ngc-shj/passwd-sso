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

  public init(
    loadConfig: @escaping @Sendable () -> ServerConfig?,
    hasTokens: @escaping @Sendable () -> Bool,
    makeSession: @escaping @Sendable (ServerConfig) async -> MobileAPIClient?,
    validate: @escaping @Sendable (MobileAPIClient) async -> SessionValidation
  ) {
    self.loadConfig = loadConfig
    self.hasTokens = hasTokens
    self.makeSession = makeSession
    self.validate = validate
  }

  public func restore() async -> RestoredSession {
    guard let config = loadConfig() else { return .needsSetup }
    guard hasTokens() else { return .needsSignIn(config) }
    guard let client = await makeSession(config) else { return .needsSignIn(config) }
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
        guard let urlSession = try? await ServerTrustService().validatedSession(
          for: config.baseURL,
          healthURL: config.baseURL.appending(
            path: APIPath.healthLive,
            directoryHint: .notDirectory
          )
        )
        else { return nil }
        return MobileAPIClient(
          serverURL: config.baseURL,
          signer: signer,
          jwk: jwk,
          tokenStore: tokenStore,
          urlSession: urlSession
        )
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
