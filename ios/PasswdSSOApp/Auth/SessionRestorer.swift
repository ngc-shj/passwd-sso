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
/// `identityMismatch` is distinct from `dead`/`offline`: only a rejected TLS pin
/// (genuine key rotation or MITM) routes to the re-verify affordance; a
/// reachability failure keeps the cached vault usable offline.
public enum SessionValidation: Sendable { case ok, offline, dead, identityMismatch }

// MARK: - Session restorer

/// Decides the initial app state at launch from the persisted server config,
/// Keychain tokens, and the Secure Enclave signer — WITHOUT ever performing
/// destructive cleanup (tenant policy / QuickType / token wipe stay on the
/// explicit Sign-Out path). The routing is expressed over injected closures so
/// it is unit-testable without a real Secure Enclave or network.
///
/// `makeSession` builds the client WITHOUT a network round-trip (it uses the
/// stored pin to construct a pinned session, or reports the pin missing). All
/// reachability / identity probing happens in `validate`, so an offline launch
/// still yields a client and the cached vault stays unlockable.
public struct SessionRestorer: Sendable {
  let loadConfig: @Sendable () -> ServerConfig?
  let hasTokens: @Sendable () -> Bool
  /// Returns the client on success, or `nil` when credentials/signer/pin are
  /// missing (→ sign-in). Must NOT hit the network — identity/reachability is
  /// `validate`'s job.
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
    // No local tokens → plain sign-in. A genuine identity change is NOT detected
    // here (that would require a network probe on every tokenless launch, e.g.
    // right after server setup, mis-warning when nothing changed); it surfaces
    // during the sign-in TLS handshake and is routed to re-verify via
    // AuthError.serverTrustFailed → onServerTrustFailed.
    guard hasTokens() else { return .needsSignIn(config) }
    guard let client = await makeSession(config) else {
      // No client despite tokens → signer/pin missing. Sign-in re-derives the
      // signer (or re-pins); NOT identity-changed, which is reserved for a
      // validate() TLS rejection.
      return .needsSignIn(config)
    }
    switch await validate(client) {
    case .ok, .offline:
      // Offline keeps the cached vault unlockable — the pin is presumed valid.
      return .needsUnlock(config, client)
    case .dead:
      return .needsReauth(config, client)
    case .identityMismatch:
      return .serverIdentityChanged(config)
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
        let baseURL = config.baseURL
        // pinnedSession does NO network round-trip: it builds a session from the
        // stored pin (or throws .pinMissing). Reachability + identity are probed
        // by validate(), so an offline launch still yields a client and the
        // cached vault stays unlockable. `.pinMissing` → nil → sign-in.
        guard let urlSession = try? await trustService.pinnedSession(for: baseURL) else {
          return nil
        }
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
      validate: { client in
        // First, an explicit non-mutating pin probe. This reads the delegate's
        // authoritative mismatch flag (via ServerTrustError.pinMismatch) rather
        // than guessing from an unspecified URLError.Code.
        let serverURL = client.serverURL
        let probe = await ServerTrustService().probePinnedIdentity(
          for: serverURL,
          healthURL: serverURL.appending(path: APIPath.healthLive, directoryHint: .notDirectory)
        )
        switch probe {
        case .mismatch:
          return .identityMismatch
        case .unreachable, .pinMissing:
          // Presumed transient / not-yet-pinned: keep the cached vault usable.
          return .offline
        case .match:
          break  // identity is good — fall through to token validity
        }
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
