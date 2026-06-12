import CryptoKit
import Foundation
import Shared

/// Orchestrates the full host-side sync:
///   1. Fetch personal + team entries in parallel.
///   2. Encode entries JSON → encrypt → write cache file atomically.
///   3. Increment bridge_key_blob counter AFTER rename succeeds.
public actor HostSyncService {
  private let apiClient: MobileAPIClient
  private let entryFetcher: EntryFetcher
  private let bridgeKeyStore: BridgeKeyStore
  private let wrappedKeyStore: WrappedKeyStore
  private let cacheURL: URL

  public init(
    apiClient: MobileAPIClient,
    entryFetcher: EntryFetcher,
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore,
    cacheURL: URL
  ) {
    self.apiClient = apiClient
    self.entryFetcher = entryFetcher
    self.bridgeKeyStore = bridgeKeyStore
    self.wrappedKeyStore = wrappedKeyStore
    self.cacheURL = cacheURL
  }

  /// Performs the full host sync.
  /// Per plan §"Write ordering": cache file is written first; blob counter updated after.
  /// - Parameters:
  ///   - vaultKey: Vault encryption key (never persisted).
  ///   - userId: User ID from the unlock response; stored in the cache header for AAD construction.
  public func runSync(vaultKey: SymmetricKey, userId: String) async throws -> SyncReport {
    let now = Date()

    // Read current blob to get counter and UUID
    let blob = try bridgeKeyStore.readDirect()

    // Fetch personal entries and team memberships in parallel
    async let personalEntries = entryFetcher.fetchPersonal()
    async let teamMemberships = apiClient.fetchTeamMemberships()

    let personal = try await personalEntries
    // A transient team-membership failure is tolerable (proceed with no teams),
    // but a dead refresh token (authenticationRequired) MUST surface so the caller
    // routes to re-sign-in (C4) rather than silently syncing personal-only.
    let teams: [TeamMembership]
    do {
      teams = try await teamMemberships
    } catch MobileAPIError.authenticationRequired {
      throw MobileAPIError.authenticationRequired
    } catch {
      teams = []
    }

    // Convert personal entries to CacheEntry (with aadVersion/keyVersion propagated)
    var allCacheEntries: [CacheEntry] = personal.map { entry in
      CacheEntry(
        id: entry.id,
        teamId: nil,
        aadVersion: entry.aadVersion,
        keyVersion: entry.keyVersion,
        teamKeyVersion: nil,
        itemKeyVersion: nil,
        encryptedItemKey: nil,
        encryptedBlob: entry.encryptedBlob,
        encryptedOverview: entry.encryptedOverview
      )
    }

    // Fetch team entries sequentially to avoid overwhelming the server
    for team in teams {
      let teamCacheEntries = try await entryFetcher.fetchTeamAsCacheEntries(teamId: team.id)
      allCacheEntries.append(contentsOf: teamCacheEntries)
    }

    // Encode all entries as JSON
    let encoder = JSONEncoder()
    let entriesJSON = try encoder.encode(allCacheEntries)

    // Build cache header with counter N+1
    let newCounter = blob.cacheVersionCounter &+ 1

    try AppGroupContainer.ensureDirectoryExists()

    let header = CacheHeader(
      cacheVersionCounter: newCounter,
      cacheIssuedAt: now,
      lastSuccessfulRefreshAt: now,
      entryCount: UInt32(allCacheEntries.count),
      hostInstallUUID: blob.hostInstallUUID,
      userId: userId
    )
    let cacheData = CacheData(header: header, entries: entriesJSON)

    // Step 1: atomic write of cache file (counter N+1 in header)
    try writeCacheFile(
      data: cacheData,
      vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID,
      path: cacheURL
    )

    // Step 2: ONLY after rename, update blob counter to N+1
    try bridgeKeyStore.incrementCounter(newCounter: newCounter)

    // Compute written bytes (approximate)
    let cacheAttributes = try? FileManager.default.attributesOfItem(atPath: cacheURL.path)
    let bytesWritten = (cacheAttributes?[.size] as? Int) ?? entriesJSON.count

    return SyncReport(
      entriesFetched: allCacheEntries.count,
      cacheBytesWritten: bytesWritten,
      lastSuccessfulRefreshAt: now,
      cacheData: cacheData
    )
  }
}

// MARK: - MobileAPIClient extension for team memberships

extension MobileAPIClient {
  /// Fetch team memberships from GET /api/teams.
  /// Uses performAuthedGET for the full C3 retry ladder (nonce→refresh, fixes F3).
  func fetchTeamMemberships() async throws -> [TeamMembership] {
    let endpoint = serverURL.appending(path: "/api/teams", directoryHint: .notDirectory)
    let data = try await performAuthedGET(url: endpoint)
    return try JSONDecoder().decode([TeamMembership].self, from: data)
  }
}
