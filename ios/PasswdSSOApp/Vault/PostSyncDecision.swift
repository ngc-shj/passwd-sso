import Foundation
import Shared

/// Pure decision helpers for the post-unlock flow. Extracted from `RootView`
/// (which is not unit-testable without a SwiftUI host) so the load-bearing
/// fatal-vs-recoverable logic, the biometric error mapping, and the error
/// precedence are covered by plain XCTest — mirrors the `LockStateReducer`
/// split used by `AutoLockService`.

/// Outcome of the post-`runSync` decision in `handleVaultUnlocked`.
public enum PostSyncOutcome: Equatable {
  /// Sync succeeded — use the freshly-built cache it returned.
  case useFreshCache
  /// Sync failed but a valid persisted cache exists AND the unlock recovered a valid
  /// local cache — fall back to the persisted cache (offline).
  case useLocalCache
  /// Sync failed, no persisted cache, but the unlock DID recover a valid local cache
  /// (cacheRecovered == true) — this is a benign empty/new-vault or first-offline
  /// state (e.g. a brand-new account with zero entries). Present an empty vault; the
  /// passphrase was valid, so this is success, not a failure.
  case useEmptyCache
  /// Route back to the locked screen and surface an explicit error. Reached ONLY when
  /// the sync failed AND the unlock could NOT recover a trustworthy local cache
  /// (cacheRecovered == false — the biometric stale/rolled-back case).
  case failLocked
}

/// Decide what `handleVaultUnlocked` does after `runSync`.
///
/// - Parameters:
///   - syncReport: the sync result, or `nil` if the sync threw.
///   - cacheRecovered: whether the unlock recovered a valid local cache. `false`
///     means the on-disk cache was stale / counter-mismatched / unreadable, so it
///     MUST NOT be trusted as a fallback — a failed sync then fails closed. `true`
///     for every passphrase unlock (its passphrase was valid) and for a biometric
///     unlock that read a fresh cache.
///   - persistedCache: the already-read persisted cache (read ONCE by the caller),
///     or `nil` if absent/unreadable.
///
/// Security note (S2): when `cacheRecovered == false`, a readable `persistedCache`
/// does NOT rescue a failed sync — the result is `.failLocked` regardless. This is
/// what forbids the caller from re-reading (and re-trusting) a possibly rolled-back
/// cache on the failure path.
public func decidePostSync(
  syncReport: SyncReport?,
  cacheRecovered: Bool,
  persistedCache: CacheData?
) -> PostSyncOutcome {
  if syncReport != nil {
    return .useFreshCache
  }
  // Sync failed from here on.
  guard cacheRecovered else {
    // Untrustworthy local cache (biometric stale/rolled-back) — fail closed, never
    // fall back, even if a readable file exists (S2).
    return .failLocked
  }
  // A valid unlock (passphrase, or biometric with a fresh cache): a failed sync falls
  // back to the persisted cache, or to an empty vault when none exists (a brand-new /
  // first-offline vault is a legitimate success state — NOT a fail-closed condition).
  return persistedCache != nil ? .useLocalCache : .useEmptyCache
}

/// Map a biometric-unlock outcome to a user-facing error string, or `nil` when no
/// banner should be shown.
///
/// - `VaultUnlockError.biometricFailed` (an intentional cancel OR a biometric
///   mismatch — the two are indistinguishable at the keychain layer) → `nil`: stay
///   on the passphrase screen with no scary banner.
/// - `syncFailedCacheless == true` (biometric auth SUCCEEDED but the cacheless
///   resync could not complete) → the explicit "session is out of date" message.
/// - any other thrown error → the same explicit message.
public func biometricUnlockError(
  from error: Error?,
  syncFailedCacheless: Bool,
  message: @autoclosure () -> String
) -> String? {
  if let error {
    if case VaultUnlockError.biometricFailed = error {
      return nil
    }
    return message()
  }
  return syncFailedCacheless ? message() : nil
}

/// Precedence for the unlock screen's error caption: an externally-supplied error
/// (from the biometric closure) wins over the view's own passphrase-attempt error.
public func resolveDisplayError(external: String?, internalError: String?) -> String? {
  external ?? internalError
}

/// Outcome of `handleVaultUnlocked`, so the biometric call site can pick the right
/// banner: reached the vault, failed closed on a dead session (→ "sign in again"),
/// or failed closed offline (→ "enter passphrase / try again").
public enum UnlockedResult: Equatable {
  case reachedVault
  case failedSessionExpired
  case failedOffline
}

/// Classify an unlock-time `runSync` error: `true` only when the session is dead
/// (the refresh token expired or a replay revoked the family), which surfaces from
/// the API client as `MobileAPIError.authenticationRequired`. Every other error
/// (offline, transient server, decode) is `false` — a recoverable/offline failure.
public func syncFailedSessionExpired(from error: Error) -> Bool {
  if case MobileAPIError.authenticationRequired = error { return true }
  return false
}

/// Map a fail-closed unlock (sync failed with no trustworthy local cache) to the
/// banner outcome: a dead session routes to "sign in again", a mere offline failure
/// to "try again with your passphrase".
public func failClosedResult(sessionExpired: Bool) -> UnlockedResult {
  sessionExpired ? .failedSessionExpired : .failedOffline
}
