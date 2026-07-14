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

  // MARK: - Fail-closed banner selection (dead session vs offline)

  /// A dead session (authenticationRequired) is the ONLY error that routes to the
  /// "sign in again" banner — the whole point of the UnlockedResult split.
  func testSyncFailedSessionExpired_authenticationRequired_isTrue() {
    XCTAssertTrue(syncFailedSessionExpired(from: MobileAPIError.authenticationRequired))
  }

  /// An offline/transient failure must NOT be treated as a dead session — it routes
  /// to the "try again with your passphrase" banner instead.
  func testSyncFailedSessionExpired_offlineError_isFalse() {
    let offline = MobileAPIError.networkError(URLError(.notConnectedToInternet))
    XCTAssertFalse(syncFailedSessionExpired(from: offline))
    // A non-MobileAPIError also falls through to the offline banner.
    struct Other: Error {}
    XCTAssertFalse(syncFailedSessionExpired(from: Other()))
    // Another MobileAPIError case must not be mistaken for a dead session.
    XCTAssertFalse(syncFailedSessionExpired(from: MobileAPIError.serverError(status: 500)))
  }

  func testFailClosedResult_sessionExpired_routesToSignIn() {
    XCTAssertEqual(failClosedResult(sessionExpired: true), .failedSessionExpired)
  }

  func testFailClosedResult_offline_routesToPassphraseRetry() {
    XCTAssertEqual(failClosedResult(sessionExpired: false), .failedOffline)
  }

  // MARK: - sessionBannerTransition (offline read-only banner set/clear)

  func testSessionBannerTransition_syncSucceeded_clears() {
    XCTAssertEqual(sessionBannerTransition(syncError: nil), .clear)
  }

  func testSessionBannerTransition_deadSession_shows() {
    XCTAssertEqual(
      sessionBannerTransition(syncError: MobileAPIError.authenticationRequired), .show)
  }

  /// The load-bearing invariant: a transient/offline failure must LEAVE the
  /// banner as-is — it must neither raise a false "signed out" banner nor clear
  /// a real one (the session state is unknown when merely offline).
  func testSessionBannerTransition_offlineError_leavesUnchanged() {
    let offline = MobileAPIError.networkError(URLError(.notConnectedToInternet))
    XCTAssertEqual(sessionBannerTransition(syncError: offline), .unchanged)
  }

  func testSessionBannerTransition_otherServerError_leavesUnchanged() {
    XCTAssertEqual(
      sessionBannerTransition(syncError: MobileAPIError.serverError(status: 500)), .unchanged)
  }

  func testSessionBannerTransition_nonMobileError_leavesUnchanged() {
    struct Other: Error {}
    XCTAssertEqual(sessionBannerTransition(syncError: Other()), .unchanged)
  }

  // MARK: - Read-only affordance (#664: suppress create/edit UI when signed out)

  /// Fully editable (signed-in): Edit is a normal enabled control.
  func testEditAffordance_signedIn_enabled() {
    XCTAssertEqual(editAffordance(readOnlyReason: nil), .enabled)
  }

  /// Dead session: Edit stays visible but disabled, with a sign-in hint — the
  /// list-screen offline banner isn't visible on a pushed detail view, so the
  /// affordance itself must carry the "why".
  func testEditAffordance_sessionExpired_disabledWithHint() {
    XCTAssertEqual(editAffordance(readOnlyReason: .sessionExpired), .disabledWithHint)
  }

  /// Demo Mode: Edit is hidden — the "Demo Mode" chip already frames the browse-
  /// only state, so a disabled control would be noise.
  func testEditAffordance_demo_hidden() {
    XCTAssertEqual(editAffordance(readOnlyReason: .demo), .hidden)
  }

  /// Create is allowed ONLY in the fully-editable state; any read-only reason
  /// forbids it (defence-in-depth on top of the server's fail-closed 401).
  func testCanCreate_onlyWhenFullyEditable() {
    XCTAssertTrue(canCreate(readOnlyReason: nil))
    XCTAssertFalse(canCreate(readOnlyReason: .sessionExpired))
    XCTAssertFalse(canCreate(readOnlyReason: .demo))
  }

  /// A dead session maps the list to the `.sessionExpired` read-only reason; a
  /// live session maps to `nil` (fully editable). This is the load-bearing
  /// projection the create/edit suppression reads.
  func testListReadOnlyReason_sessionExpired_mapsToReason() {
    XCTAssertEqual(listReadOnlyReason(sessionExpired: true), .sessionExpired)
  }

  func testListReadOnlyReason_liveSession_mapsToNil() {
    XCTAssertNil(listReadOnlyReason(sessionExpired: false))
  }
}
