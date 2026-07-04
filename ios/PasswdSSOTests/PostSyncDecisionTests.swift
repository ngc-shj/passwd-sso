import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

final class PostSyncDecisionTests: XCTestCase {

  private func makeCacheData() -> CacheData {
    CacheData(
      header: CacheHeader(
        cacheVersionCounter: 1,
        cacheIssuedAt: Date(timeIntervalSince1970: 1_000_000),
        lastSuccessfulRefreshAt: Date(timeIntervalSince1970: 1_000_000),
        entryCount: 0,
        hostInstallUUID: Data(repeating: 0, count: 16),
        userId: "u"
      ),
      entries: "[]".data(using: .utf8)!
    )
  }

  private func makeSyncReport() -> SyncReport {
    SyncReport(
      entriesFetched: 0, cacheBytesWritten: 0,
      lastSuccessfulRefreshAt: Date(timeIntervalSince1970: 1_000_000),
      cacheData: makeCacheData())
  }

  // MARK: - decidePostSync (C5)

  /// AC-C5.5: a successful sync always yields .useFreshCache regardless of the rest.
  func testDecidePostSync_syncSucceeded_useFreshCache() {
    XCTAssertEqual(
      decidePostSync(syncReport: makeSyncReport(), cacheRecovered: false, persistedCache: nil),
      .useFreshCache)
    XCTAssertEqual(
      decidePostSync(syncReport: makeSyncReport(), cacheRecovered: true, persistedCache: makeCacheData()),
      .useFreshCache)
  }

  /// AC-C5.1 (S2 core): a failed sync with cacheRecovered=false NEVER trusts a
  /// readable persisted cache — it fails closed.
  func testDecidePostSync_failedSync_cacheless_failsLockedEvenWithReadableCache() {
    XCTAssertEqual(
      decidePostSync(syncReport: nil, cacheRecovered: false, persistedCache: makeCacheData()),
      .failLocked,
      "a readable persisted cache must NOT rescue a cacheless failed sync (S2)")
  }

  /// AC-C5.2: failed sync + cacheRecovered=false + no persisted cache → failLocked.
  func testDecidePostSync_failedSync_cacheless_noCache_failsLocked() {
    XCTAssertEqual(
      decidePostSync(syncReport: nil, cacheRecovered: false, persistedCache: nil),
      .failLocked)
  }

  /// AC-C5.3: failed sync + cacheRecovered=true + persisted cache → useLocalCache.
  func testDecidePostSync_failedSync_recovered_withCache_useLocalCache() {
    XCTAssertEqual(
      decidePostSync(syncReport: nil, cacheRecovered: true, persistedCache: makeCacheData()),
      .useLocalCache)
  }

  /// AC-C5.4 (revised — Phase 3 F-passphrase): failed sync + cacheRecovered=true + no
  /// persisted cache → .useEmptyCache, NOT .failLocked. A valid unlock (passphrase, or
  /// biometric-fresh) with a brand-new / first-offline vault must present the empty
  /// vault as success — bouncing to the locked screen would be a regression for the
  /// passphrase path (correct passphrase → locked screen with no data).
  func testDecidePostSync_failedSync_recovered_noCache_useEmptyCache() {
    XCTAssertEqual(
      decidePostSync(syncReport: nil, cacheRecovered: true, persistedCache: nil),
      .useEmptyCache)
  }

  /// The fail-closed direction is preserved for the biometric untrusted-cache case:
  /// cacheRecovered=false + no cache still fails closed.
  func testDecidePostSync_failedSync_cacheless_stillFailsClosed() {
    XCTAssertEqual(
      decidePostSync(syncReport: nil, cacheRecovered: false, persistedCache: nil),
      .failLocked)
  }

  // MARK: - biometricUnlockError (C2)

  /// AC-C2.1: a biometric cancel/mismatch shows no banner.
  func testBiometricUnlockError_biometricFailed_returnsNil() {
    XCTAssertNil(
      biometricUnlockError(
        from: VaultUnlockError.biometricFailed, syncFailedCacheless: false, message: "msg"))
  }

  /// AC-C2.1: a non-cancel error surfaces the explicit message.
  func testBiometricUnlockError_otherError_returnsMessage() {
    XCTAssertEqual(
      biometricUnlockError(
        from: VaultUnlockError.cacheUnreadable, syncFailedCacheless: false, message: "msg"),
      "msg")
  }

  /// AC-C2.1: a cacheless resync failure (no throw, but reached=false) surfaces the message.
  func testBiometricUnlockError_syncFailedCacheless_returnsMessage() {
    XCTAssertEqual(
      biometricUnlockError(from: nil, syncFailedCacheless: true, message: "msg"),
      "msg")
  }

  /// A clean success (no error, sync did not fail cacheless) shows no banner.
  func testBiometricUnlockError_success_returnsNil() {
    XCTAssertNil(biometricUnlockError(from: nil, syncFailedCacheless: false, message: "msg"))
  }

  // MARK: - resolveDisplayError (C3)

  /// AC-C3.1: external error wins; internal shows when external is nil.
  func testResolveDisplayError_precedence() {
    XCTAssertEqual(resolveDisplayError(external: "x", internalError: nil), "x")
    XCTAssertEqual(resolveDisplayError(external: "x", internalError: "y"), "x")
    XCTAssertEqual(resolveDisplayError(external: nil, internalError: "y"), "y")
    XCTAssertNil(resolveDisplayError(external: nil, internalError: nil))
  }
}
