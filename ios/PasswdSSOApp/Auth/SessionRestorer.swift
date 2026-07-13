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
  /// Whether a TLS pin is stored for this server. Distinguishes a
  /// credentials-missing launch (no pin → sign-in) from a rotated-identity
  /// launch with no local tokens (pin present → re-verify).
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
    guard hasTokens() else {
      // No local tokens. If a pin is stored the server may have rotated its
      // identity — offer re-verify so the user isn't stuck at a sign-in that
      // silently fails the pinned TLS handshake. With no pin, plain sign-in.
      return await pinExists(config) ? .serverIdentityChanged(config) : .needsSignIn(config)
    }
    guard let client = await makeSession(config) else {
      // No client despite tokens → signer/pin missing. A stored pin means the
      // pin is intact but the signer is gone (sign-in re-derives it); no pin
      // means first-trust. Either way, sign-in — NOT identity-changed, which is
      // reserved for a validate() TLS rejection.
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
        do {
          try await client.ensureValidSession()
          return .ok
        } catch let MobileAPIError.networkError(urlError) {
          // A pinned-TLS rejection surfaces as a URLError. Treat the
          // certificate/handshake-failure codes as an identity change; genuine
          // connectivity codes stay offline (cached vault remains usable).
          return isTLSTrustFailure(urlError) ? .identityMismatch : .offline
        } catch {
          return .dead
        }
      },
      pinExists: { config in
        await ServerTrustService().currentPinExists(for: config.baseURL)
      }
    )
  }
}

/// URLError codes that indicate the server's TLS identity was rejected (pin
/// mismatch / untrusted cert), as opposed to plain connectivity failures.
///
/// Deliberately EXCLUDES `.cancelled`: although `LeafKeyPinningDelegate` cancels
/// the challenge on a pin mismatch (which surfaces as `.cancelled`), that code
/// is also produced by ordinary task cancellation. Misclassifying a benign
/// cancel as an identity change is the dangerous direction (it trains reflexive
/// re-verify and blocks offline unlock), so a mismatch that arrives ONLY as
/// `.cancelled` falls through to `.offline` here and is caught again by the pin
/// enforcement on the next real API call — fail-safe.
private func isTLSTrustFailure(_ error: URLError) -> Bool {
  switch error.code {
  case .serverCertificateUntrusted,
    .serverCertificateHasBadDate,
    .serverCertificateHasUnknownRoot,
    .serverCertificateNotYetValid,
    .secureConnectionFailed,
    .clientCertificateRejected:
    return true
  default:
    return false
  }
}
