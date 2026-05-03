import Foundation

/// Opaque encrypted entry used by the background sync coordinator stub.
/// The host-app's real wire type is `EncryptedEntry` in EntryFetcher.swift (Codable, full shape).
public struct SyncEncryptedEntry: Sendable, Equatable {
  public let id: String
  public let encryptedBlob: String
  public let encryptedOverview: String

  public init(id: String, encryptedBlob: String, encryptedOverview: String) {
    self.id = id
    self.encryptedBlob = encryptedBlob
    self.encryptedOverview = encryptedOverview
  }
}

public struct SyncReport: Sendable, Equatable {
  public let entriesFetched: Int
  public let cacheBytesWritten: Int
  public let lastSuccessfulRefreshAt: Date

  public init(entriesFetched: Int, cacheBytesWritten: Int, lastSuccessfulRefreshAt: Date) {
    self.entriesFetched = entriesFetched
    self.cacheBytesWritten = cacheBytesWritten
    self.lastSuccessfulRefreshAt = lastSuccessfulRefreshAt
  }
}

/// Network layer abstraction for testability (per T40).
public protocol NetworkClient: Sendable {
  func refreshToken(session: SessionState) async throws -> SessionState
  func fetchEncryptedEntries(session: SessionState) async throws -> [SyncEncryptedEntry]
}

/// Cache write abstraction — real implementation lives in Step 7 (host app).
public protocol CacheWriter: Sendable {
  func write(entries: [SyncEncryptedEntry], refreshedAt: Date) async throws -> Int
}

/// In-memory stub for use in tests and as a placeholder until Step 7.
public actor InMemoryCacheWriter: CacheWriter {
  public var lastWritten: [SyncEncryptedEntry] = []
  public var lastRefreshedAt: Date?

  public init() {}

  public func write(entries: [SyncEncryptedEntry], refreshedAt: Date) async throws -> Int {
    lastWritten = entries
    lastRefreshedAt = refreshedAt
    // Rough estimate: 2 KB per entry
    return entries.count * 2048
  }
}

/// Coordinates background token refresh + encrypted-entries cache rewrite (per T40).
public actor BackgroundSyncCoordinator {
  private let client: NetworkClient
  private let cacheWriter: CacheWriter

  public init(client: NetworkClient, cacheWriter: CacheWriter) {
    self.client = client
    self.cacheWriter = cacheWriter
  }

  /// Refresh token, fetch entries, write cache. Returns a SyncReport on success.
  public func run(session: SessionState) async -> Result<SyncReport, Swift.Error> {
    do {
      let refreshed = try await client.refreshToken(session: session)
      let entries = try await client.fetchEncryptedEntries(session: refreshed)
      let now = Date()
      let bytes = try await cacheWriter.write(entries: entries, refreshedAt: now)
      return .success(SyncReport(
        entriesFetched: entries.count,
        cacheBytesWritten: bytes,
        lastSuccessfulRefreshAt: now
      ))
    } catch {
      return .failure(error)
    }
  }
}
