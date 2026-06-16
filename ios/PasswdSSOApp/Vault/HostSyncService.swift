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
  private let teamDirectoryStore: TeamDirectoryStoring
  private let cacheURL: URL

  public init(
    apiClient: MobileAPIClient,
    entryFetcher: EntryFetcher,
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore,
    cacheURL: URL,
    teamDirectoryStore: any TeamDirectoryStoring = TeamDirectoryStore()
  ) {
    self.apiClient = apiClient
    self.entryFetcher = entryFetcher
    self.bridgeKeyStore = bridgeKeyStore
    self.wrappedKeyStore = wrappedKeyStore
    self.teamDirectoryStore = teamDirectoryStore
    self.cacheURL = cacheURL
  }

  /// In-flight sync task, so concurrent callers coalesce onto ONE network
  /// round-trip + cache write + counter increment. Both the app shell and the
  /// vault list refresh on `.active`; without this they would each fire a full
  /// sync (and bump the bridge counter twice).
  private var inFlight: Task<SyncReport, Error>?

  /// Full host sync. Concurrent calls join the in-flight sync and share its
  /// result. Reentrant-safe: while a caller awaits the task value the actor is
  /// free, so a second caller sees `inFlight` and joins the same task.
  /// - Parameter cacheKey: the REAL cacheKey captured at unlock (UnlockResult.cacheKey).
  ///   Required to wrap/persist team keys + the team directory for the AutoFill
  ///   extension + in-app team display. nil → personal-only sync (team keys skipped);
  ///   never derive it from `readDirect()` (that bridge_key is empty).
  public func runSync(
    vaultKey: SymmetricKey, userId: String, cacheKey: SymmetricKey? = nil
  ) async throws -> SyncReport {
    if let inFlight { return try await inFlight.value }
    let task = Task { try await self.performSync(vaultKey: vaultKey, userId: userId, cacheKey: cacheKey) }
    inFlight = task
    defer { inFlight = nil }
    return try await task.value
  }

  /// Performs the full host sync.
  /// Per plan §"Write ordering": cache file is written first; blob counter updated after.
  /// - Parameters:
  ///   - vaultKey: Vault encryption key (never persisted).
  ///   - userId: User ID from the unlock response; stored in the cache header for AAD construction.
  private func performSync(
    vaultKey: SymmetricKey, userId: String, cacheKey: SymmetricKey?
  ) async throws -> SyncReport {
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
    // Whether `teams` is an authoritative list from the server (vs. an empty
    // fallback after a transient fetch failure). A transient failure must NOT be
    // treated as "user is on zero teams" — that would full-rewrite the team-key
    // set to empty and wipe still-valid keys (see refreshTeamKeys).
    let teamsAuthoritative: Bool
    do {
      teams = try await teamMemberships
      teamsAuthoritative = true
    } catch MobileAPIError.authenticationRequired {
      throw MobileAPIError.authenticationRequired
    } catch {
      teams = []
      teamsAuthoritative = false
    }

    // Convert personal entries to CacheEntry (aadVersion/keyVersion/entryType
    // propagated via the single-source-of-truth mapping on EncryptedEntry).
    var allCacheEntries: [CacheEntry] = personal.map { $0.toPersonalCacheEntry() }

    // Fetch team entries sequentially to avoid overwhelming the server
    for team in teams {
      let teamCacheEntries = try await entryFetcher.fetchTeamAsCacheEntries(teamId: team.id)
      allCacheEntries.append(contentsOf: teamCacheEntries)
    }

    // Populate per-team keys (best-effort; never fails the personal sync).
    // Requires the REAL cacheKey from unlock — skip when absent.
    if let cacheKey {
      try await refreshTeamKeys(
        teams: teams, teamsAuthoritative: teamsAuthoritative,
        cacheKey: cacheKey, userId: userId, now: now)
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

  /// Fetch each team's member key, ECDH-unwrap the team key, derive the team
  /// encryption key, and persist it wrapped under cacheKey (bound to userId+teamId).
  /// The AutoFill extension + host registrar read these to decrypt team entries.
  ///
  /// Resilience: when the persisted ECDH key is unavailable (e.g. background sync
  /// before any passphrase unlock), do NOT wipe a possibly still-valid set — clear
  /// it only if every blob is already past the 15-min staleness window. Auth-dead
  /// surfaces; all other failures are best-effort (team fill simply degrades).
  private func refreshTeamKeys(
    teams: [TeamMembership], teamsAuthoritative: Bool,
    cacheKey: SymmetricKey, userId: String, now: Date
  ) async throws {
    // A non-authoritative (transient-failure) empty list must not touch persisted
    // state: overwriting the directory/team-key set with empty would wipe valid
    // labels + keys until the next successful sync. Leave everything untouched.
    guard teamsAuthoritative else { return }

    // Persist the team directory (id → name) for the in-app vault switcher labels,
    // regardless of whether team keys can be derived this round.
    let directory = teams.map { TeamDirectoryEntry(id: $0.id, name: $0.name) }
    try? teamDirectoryStore.save(directory, cacheKey: cacheKey, userId: userId)

    guard let wrappedEcdh = try? wrappedKeyStore.loadECDHPrivateKey(),
          var pkcs8 = TeamEntryDecryptor.unwrapEcdhPrivateKey(
            wrappedEcdh, cacheKey: cacheKey, userId: userId)
    else {
      // No usable ECDH key: clear only if the whole set is already stale.
      clearTeamKeysIfAllStale(now: now)
      return
    }
    defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }

    let memberKey: P256.KeyAgreement.PrivateKey
    do {
      memberKey = try TeamKeyCrypto.importEcdhPrivateKey(pkcs8: pkcs8)
    } catch {
      // Malformed ECDH key (e.g. storage corruption): same posture as "no ECDH" —
      // cannot refresh, so clear only if the whole set is already stale.
      clearTeamKeysIfAllStale(now: now)
      return
    }

    var blobs: [WrappedTeamKey] = []
    for team in teams {
      do {
        let resp = try await apiClient.fetchTeamMemberKey(teamId: team.id)
        let rawTeamKey = try TeamKeyCrypto.unwrapTeamKey(
          encrypted: EncryptedData(
            ciphertext: resp.encryptedTeamKey, iv: resp.teamKeyIv, authTag: resp.teamKeyAuthTag),
          ephemeralPublicKeyJWK: resp.ephemeralPublicKey,
          memberPrivateKey: memberKey,
          hkdfSalt: resp.hkdfSalt,
          teamId: team.id, toUserId: userId,
          keyVersion: resp.keyVersion, wrapVersion: resp.wrapVersion)
        let teamEncKey = TeamKeyCrypto.deriveTeamEncryptionKey(rawTeamKey: rawTeamKey)
        blobs.append(try TeamEntryDecryptor.wrapTeamKey(
          teamEncKey: teamEncKey, cacheKey: cacheKey, userId: userId,
          teamId: team.id, teamKeyVersion: resp.keyVersion, issuedAt: now))
      } catch MobileAPIError.authenticationRequired {
        throw MobileAPIError.authenticationRequired
      } catch {
        continue  // skip this team (not distributed, network blip, decode error)
      }
    }
    // Full rewrite — revoked / no-longer-distributed teams drop out of the set.
    try? wrappedKeyStore.saveTeamKeys(blobs)
  }

  /// Clear the persisted team-key set only when every blob is already past the
  /// staleness window. Used when team keys cannot be refreshed this round (no /
  /// malformed ECDH key) so revoked keys still expire, but a possibly-valid set
  /// is never wiped.
  private func clearTeamKeysIfAllStale(now: Date) {
    let existing = (try? wrappedKeyStore.loadTeamKeys()) ?? []
    if !existing.isEmpty,
       existing.allSatisfy({ now.timeIntervalSince($0.issuedAt) > TeamEntryDecryptor.teamKeyMaxAge }) {
      try? wrappedKeyStore.clearTeamKeys()
    }
  }
}

// MARK: - MobileAPIClient extension for team memberships

extension MobileAPIClient {
  /// Fetch team memberships from GET /api/teams.
  /// Uses performAuthedGET for the full C3 retry ladder (nonce→refresh, fixes F3).
  func fetchTeamMemberships() async throws -> [TeamMembership] {
    let endpoint = serverURL.appending(path: APIPath.teams, directoryHint: .notDirectory)
    let data = try await performAuthedGET(url: endpoint)
    return try JSONDecoder().decode([TeamMembership].self, from: data)
  }
}
