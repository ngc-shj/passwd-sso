import XCTest
@testable import Shared

// MARK: - Mock NetworkClient

actor MockNetworkClient: NetworkClient {
  enum Behavior: Sendable {
    case success(entries: [SyncEncryptedEntry])
    case networkFailure(error: Error)
    case tokenExpired
  }

  let behavior: Behavior

  init(behavior: Behavior) {
    self.behavior = behavior
  }

  func refreshToken(session: SessionState) async throws -> SessionState {
    switch behavior {
    case .tokenExpired:
      throw NSError(domain: "auth", code: 401, userInfo: [NSLocalizedDescriptionKey: "token expired"])
    case .networkFailure(let error):
      throw error
    case .success:
      return .vaultUnlocked
    }
  }

  func fetchEncryptedEntries(session: SessionState) async throws -> [SyncEncryptedEntry] {
    switch behavior {
    case .networkFailure(let error):
      throw error
    case .tokenExpired:
      throw NSError(domain: "auth", code: 401)
    case .success(let entries):
      return entries
    }
  }
}

final class BackgroundSyncCoordinatorTests: XCTestCase {

  // MARK: - Happy path

  func testHappyPathReturnsSyncReport() async throws {
    let entries = [
      SyncEncryptedEntry(id: "1", encryptedBlob: "blob1", encryptedOverview: "ov1"),
      SyncEncryptedEntry(id: "2", encryptedBlob: "blob2", encryptedOverview: "ov2"),
    ]
    let client = MockNetworkClient(behavior: .success(entries: entries))
    let cache = InMemoryCacheWriter()
    let coordinator = BackgroundSyncCoordinator(client: client, cacheWriter: cache)

    let result = await coordinator.run(session: .vaultUnlocked)

    switch result {
    case .success(let report):
      XCTAssertEqual(report.entriesFetched, 2)
      XCTAssertGreaterThan(report.cacheBytesWritten, 0)
      XCTAssertLessThanOrEqual(
        abs(report.lastSuccessfulRefreshAt.timeIntervalSinceNow),
        5,
        "lastSuccessfulRefreshAt should be close to now"
      )
    case .failure(let error):
      XCTFail("Expected success, got \(error)")
    }
  }

  // MARK: - Network failure propagates

  func testNetworkFailurePropagates() async {
    let networkError = NSError(domain: "network", code: -1009, userInfo: nil)
    let client = MockNetworkClient(behavior: .networkFailure(error: networkError))
    let cache = InMemoryCacheWriter()
    let coordinator = BackgroundSyncCoordinator(client: client, cacheWriter: cache)

    let result = await coordinator.run(session: .vaultUnlocked)

    switch result {
    case .success:
      XCTFail("Expected failure")
    case .failure(let error):
      XCTAssertNotNil(error)
    }
  }

  // MARK: - Token expired propagates

  func testRefreshTokenExpiredReturnsFailure() async {
    let client = MockNetworkClient(behavior: .tokenExpired)
    let cache = InMemoryCacheWriter()
    let coordinator = BackgroundSyncCoordinator(client: client, cacheWriter: cache)

    let result = await coordinator.run(session: .signedIn(userId: "u", tenantId: "t"))

    switch result {
    case .success:
      XCTFail("Expected failure for expired token")
    case .failure(let error):
      let nsError = error as NSError
      XCTAssertEqual(nsError.code, 401)
    }
  }

  // MARK: - Cache receives written data

  func testCacheReceivesEntries() async throws {
    let entries = [
      SyncEncryptedEntry(id: "x", encryptedBlob: "b", encryptedOverview: "o"),
    ]
    let client = MockNetworkClient(behavior: .success(entries: entries))
    let cache = InMemoryCacheWriter()
    let coordinator = BackgroundSyncCoordinator(client: client, cacheWriter: cache)

    _ = await coordinator.run(session: .vaultUnlocked)

    let written = await cache.lastWritten
    XCTAssertEqual(written.count, 1)
    XCTAssertEqual(written.first?.id, "x")
  }
}
