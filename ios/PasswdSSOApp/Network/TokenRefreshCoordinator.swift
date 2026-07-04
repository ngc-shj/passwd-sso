import Foundation

/// Process-global refresh gate that collapses redundant token refreshes into ONE
/// network call.
///
/// Two failure modes trip the server's refresh-token replay detector (which
/// revokes the whole token family → `MOBILE_REFRESH_REUSE_DETECTED` → dead
/// session):
///  1. CONCURRENT refreshes — multiple `MobileAPIClient` instances (SessionRestorer,
///     AuthCoordinator, RootView, background sync) each fire a refresh with the same
///     stale refresh token at the same time. Handled by the in-flight single-flight
///     join below.
///  2. SEQUENTIAL re-tries within one unlock flow — several independent steps
///     (unlock-data fetch, sync, QuickType refresh, drain) each call `ensureRefreshed`
///     back-to-back. The first rotates the token; the next presents the now-revoked
///     old token before the Keychain write is observed. Handled by the short
///     success cache below: within `resultTTL` (< the server's 5s replay grace), a
///     repeat call for the same key replays the FIRST call's rotated token instead
///     of hitting the network again.
///
/// Only successful refreshes are cached. Every failure — including
/// `authenticationRequired` — stays immediately retryable, because a re-sign-in can
/// install a fresh valid token at any moment and a cached failure would keep
/// returning the dead-session error for the whole TTL even after recovery.
public actor TokenRefreshCoordinator {
  public static let shared = TokenRefreshCoordinator()

  /// Window during which a settled refresh result is replayed to repeat callers.
  /// Must be shorter than the server's replay grace (5s) so a legitimately-expired
  /// cache does not mask a real rotation.
  private let resultTTL: TimeInterval
  private let now: @Sendable () -> Date

  /// In-flight refresh per token-store key (single-flight for concurrent callers).
  private var inFlight: [String: Task<String, Error>] = [:]

  /// Last SUCCESSFUL refresh per key, with the time it settled. Only successes are
  /// cached — a failure must never be replayed (a re-sign-in can recover at any time).
  private enum CachedOutcome {
    case success(String)
  }
  private var lastResult: [String: (outcome: CachedOutcome, at: Date)] = [:]

  public init(
    resultTTL: TimeInterval = 3,
    now: @Sendable @escaping () -> Date = { Date() }
  ) {
    self.resultTTL = resultTTL
    self.now = now
  }

  /// Run `refresh` under the global gate for `key`. Order of precedence:
  ///  1. A fresh cached result (< resultTTL old) → replay it, no network call.
  ///  2. An in-flight refresh → join it.
  ///  3. Otherwise start exactly one refresh, cache its outcome, and return it.
  public func run(
    key: String,
    refresh: @Sendable @escaping () async throws -> String
  ) async throws -> String {
    // 1. Replay a recent SUCCESS only. Failures are never cached: a re-sign-in can
    //    install a fresh valid token at any moment, and caching a failure would
    //    keep returning authenticationRequired for `resultTTL` even after recovery.
    if let cached = lastResult[key], now().timeIntervalSince(cached.at) < resultTTL {
      if case .success(let token) = cached.outcome {
        return token
      }
    }

    // 2. Join an in-flight refresh.
    if let existing = inFlight[key] {
      return try await existing.value
    }

    // 3. Start one refresh; cache ONLY a success for repeat callers.
    let task = Task { try await refresh() }
    inFlight[key] = task
    defer { inFlight[key] = nil }
    let token = try await task.value
    lastResult[key] = (.success(token), now())
    return token
  }
}
