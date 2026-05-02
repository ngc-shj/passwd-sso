import CryptoKit
import Foundation
import Shared

/// Handles the stale-blob recovery path (plan §"Write ordering"):
/// If the host app crashed between writing the cache file and updating the blob counter,
/// the cache is at counter N+1 while the blob remains at N.
/// On next foreground, if cache decrypts successfully and counter == blob.counter + 1,
/// advance the blob to match.
///
/// TODO (Step 11): wire rollback-flag drain hook here — `RollbackFlagDrain.drainPendingFlags()`
/// will be called before or after recovery to post any pending flags to /api/mobile/cache-rollback-report.
public actor StaleBlobRecoveryService {
  private let bridgeKeyStore: BridgeKeyStore
  private let cacheURL: URL

  public init(bridgeKeyStore: BridgeKeyStore, cacheURL: URL) {
    self.bridgeKeyStore = bridgeKeyStore
    self.cacheURL = cacheURL
  }

  /// On host-app foreground, if cache.counter == blob.counter + 1 AND cache decrypts
  /// successfully under vault_key, advance the blob counter forward.
  ///
  /// Returns true if recovery happened, false if no action was needed.
  public func recoverIfNeeded(vaultKey: SymmetricKey) async throws -> Bool {
    // Read current blob counter (no biometric needed for host-app reads)
    let blob: BridgeKeyStore.Blob
    do {
      blob = try bridgeKeyStore.readDirect()
    } catch BridgeKeyStore.Error.notFound {
      return false
    }

    // Try to read the cache with counter = blob.counter + 1
    let expectedCounter = blob.cacheVersionCounter + 1

    do {
      _ = try readCacheFile(
        path: cacheURL,
        vaultKey: vaultKey,
        expectedHostInstallUUID: blob.hostInstallUUID,
        expectedCounter: expectedCounter
      )
    } catch EntryCacheError.rejection(let kind) {
      // Any rejection means this is not a simple forward-counter stale-blob case.
      // Log rejection kind for observability but don't throw.
      _ = kind
      return false
    } catch {
      return false
    }

    // Cache at N+1 decrypted successfully under vault_key → advance blob
    return try bridgeKeyStore.recoverForwardCounter(observed: expectedCounter)
  }
}
