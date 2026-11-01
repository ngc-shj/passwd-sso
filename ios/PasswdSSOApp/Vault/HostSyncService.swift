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

    // A failed sync leaves the persisted team keys as they were; keys past the
    // staleness window no longer decrypt anything, so they are not kept at rest.
    defer { pruneExpiredTeamKeys(now: now) }

    // Fetch personal entries and team memberships in parallel
    async let personalEntries = entryFetcher.fetchPersonal()
    async let teamMemberships = apiClient.fetchTeamMemberships()

    let personal = try await personalEntries
    // The cache is rewritten whole: a team list that could not be fetched fails
    // the sync (the previous cache, team keys and directory stay as they were)
    // rather than writing a cache without the user's teams.
    let teams = try await teamMemberships

    // Convert personal entries to CacheEntry (aadVersion/keyVersion/entryType
    // propagated via the single-source-of-truth mapping on EncryptedEntry).
    var allCacheEntries: [CacheEntry] = personal.map { $0.toPersonalCacheEntry() }

    // Fetch team entries sequentially to avoid overwhelming the server.
    // A failure scoped to one team leaves that team out of this cache and must
    // not fail the personal vault or the other teams — e.g. a 404 when the
    // membership ended between the team list and this fetch, as a tenant
    // departure does. A 404 also drops the team from the directory, and from the
    // key set when the keys are refreshed below; the team comes back on the next
    // sync if it is a membership again.
    var departedTeamIds: Set<String> = []
    for team in teams {
      do {
        let teamCacheEntries = try await entryFetcher.fetchTeamAsCacheEntries(teamId: team.id)
        allCacheEntries.append(contentsOf: teamCacheEntries)
      } catch {
        guard Self.isTeamScopedFailure(error) else { throw error }
        if Self.isMembershipGone(error) { departedTeamIds.insert(team.id) }
      }
    }
    let memberTeams = teams.filter { !departedTeamIds.contains($0.id) }

    // Populate per-team keys. A team whose key cannot be derived is skipped;
    // a failure that is not one team's (session, passkey, transport, server)
    // fails the sync like the entry fetch above.
    // Requires the REAL cacheKey from unlock — skip when absent.
    if let cacheKey {
      try await refreshTeamKeys(teams: memberTeams, cacheKey: cacheKey, userId: userId, now: now)
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

    // The team directory (id → name) for the in-app vault switcher labels moves
    // with the cache it labels: only once the cache is written, so a failed sync
    // leaves both as they were. Saved whether or not team keys could be derived.
    if let cacheKey {
      let directory = memberTeams.map { TeamDirectoryEntry(id: $0.id, name: $0.name) }
      try? teamDirectoryStore.save(directory, cacheKey: cacheKey, userId: userId)
    }

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
  /// before any passphrase unlock), do NOT wipe a possibly still-valid set — leave
  /// it to `performSync`'s prune of keys past the 15-min staleness window. A failure
  /// scoped to one team skips that team; any other failure throws (see
  /// `isTeamScopedFailure`).
  private func refreshTeamKeys(
    teams: [TeamMembership], cacheKey: SymmetricKey, userId: String, now: Date
  ) async throws {
    guard let wrappedEcdh = try? wrappedKeyStore.loadECDHPrivateKey(),
          var pkcs8 = TeamEntryDecryptor.unwrapEcdhPrivateKey(
            wrappedEcdh, cacheKey: cacheKey, userId: userId)
    else {
      // No usable ECDH key: keep the set; `performSync` prunes expired keys.
      return
    }
    defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }

    let memberKey: P256.KeyAgreement.PrivateKey
    do {
      memberKey = try TeamKeyCrypto.importEcdhPrivateKey(pkcs8: pkcs8)
    } catch {
      // Malformed ECDH key (e.g. storage corruption): same posture as "no ECDH" —
      // cannot refresh, so keep the set for the prune to age out.
      return
    }

    var blobs: [WrappedTeamKey] = []
    for team in teams {
      let resp: TeamMemberKeyResponse
      do {
        resp = try await apiClient.fetchTeamMemberKey(teamId: team.id)
      } catch {
        // Not distributed / not a member: skip this team. Anything that would
        // refuse every team the same way fails the sync instead — the full
        // rewrite below would otherwise drop still-valid keys.
        guard Self.isTeamScopedFailure(error) else { throw error }
        continue
      }
      do {
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
      } catch {
        continue  // this team's key material does not unwrap: skip the team
      }
    }
    // Full rewrite — revoked / no-longer-distributed teams drop out of the set.
    try? wrappedKeyStore.saveTeamKeys(blobs)
  }

  /// Whether a failed team fetch (entries or member key) concerns that team
  /// alone, so the sync may go on without it. Only answers the server gives
  /// about one team qualify: not a member (404), refused by that team's policy
  /// or the member's permission (403), key not distributed, or a response that
  /// does not decode. Everything else — a dead session, a passkey refusal, rate
  /// limiting, the transport, a server or gateway error, the keychain or DPoP
  /// signer (device locked), cancellation — would refuse the remaining teams
  /// too: it fails the sync, so the previous cache stays whole instead of being
  /// rewritten without the teams.
  static func isTeamScopedFailure(_ error: Error) -> Bool {
    if error is DecodingError { return true }
    guard let apiError = error as? MobileAPIError else { return false }
    // Exhaustive on purpose: a new case must be classified, not defaulted.
    switch apiError {
    case .serverError(let status):
      return status == 403 || status == 404
    case .notFound, .teamKeyNotDistributed:
      return true
    case .authenticationRequired, .passkeyRequired, .rateLimited, .networkError,
         .dpopInvalid, .bridgeCodeInvalid, .pkceMismatch, .quotaExceeded:
      return false
    }
  }

  /// The team-scoped failure that means the user is no longer a member.
  static func isMembershipGone(_ error: Error) -> Bool {
    switch error as? MobileAPIError {
    case .serverError(status: 404)?, .notFound?: return true
    default: return false
    }
  }

  /// Remove the persisted team keys past the staleness window, keeping fresh ones.
  private func pruneExpiredTeamKeys(now: Date) {
    guard let existing = try? wrappedKeyStore.loadTeamKeys(), !existing.isEmpty else { return }
    let fresh = existing.filter { now.timeIntervalSince($0.issuedAt) <= TeamEntryDecryptor.teamKeyMaxAge }
    if fresh.count != existing.count { try? wrappedKeyStore.saveTeamKeys(fresh) }
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
