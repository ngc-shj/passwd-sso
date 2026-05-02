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
  public func runSync(vaultKey: SymmetricKey) async throws -> SyncReport {
    let now = Date()

    // Read current blob to get counter and UUID
    let blob = try bridgeKeyStore.readDirect()

    // Fetch personal entries and team memberships in parallel
    async let personalEntries = entryFetcher.fetchPersonal()
    async let teamMemberships = apiClient.fetchTeamMemberships()

    let personal = try await personalEntries
    let teams = (try? await teamMemberships) ?? []

    // Fetch team entries sequentially to avoid overwhelming the server
    var allEntries: [EncryptedEntry] = personal
    for team in teams {
      let teamEntries = try await entryFetcher.fetchTeam(teamId: team.id)
      allEntries.append(contentsOf: teamEntries)
    }

    // Encode all entries as JSON
    let encoder = JSONEncoder()
    let entriesJSON = try encoder.encode(allEntries)

    // Build cache header with counter N+1
    let newCounter = blob.cacheVersionCounter &+ 1

    try AppGroupContainer.ensureDirectoryExists()

    let header = CacheHeader(
      cacheVersionCounter: newCounter,
      cacheIssuedAt: now,
      lastSuccessfulRefreshAt: now,
      entryCount: UInt32(allEntries.count),
      hostInstallUUID: blob.hostInstallUUID
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
      entriesFetched: allEntries.count,
      cacheBytesWritten: bytesWritten,
      lastSuccessfulRefreshAt: now
    )
  }
}

// MARK: - MobileAPIClient extension for team memberships

extension MobileAPIClient {
  func fetchTeamMemberships() async throws -> [TeamMembership] {
    guard let (accessToken, _) = try tokenStore.loadAccess() else {
      throw MobileAPIError.serverError(status: 401)
    }

    let endpoint = serverURL.appending(
      path: "/api/teams",
      directoryHint: .notDirectory
    )
    let htu = canonicalHTU(url: endpoint)
    let ath = sha256Base64URL(accessToken)

    let localJWK = jwk
    let localSigner = signer
    let nonce = try? tokenStore.loadNonce()
    let proof = try await buildDPoPProof(
      htm: "GET",
      htu: htu,
      jwk: localJWK,
      ath: ath,
      nonce: nonce,
      signer: localSigner
    )

    var request = URLRequest(url: endpoint)
    request.httpMethod = "GET"
    request.setValue("DPoP \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue(proof.jws, forHTTPHeaderField: "DPoP")

    let (data, response) = try await performHTTP(request)
    let http = response as! HTTPURLResponse

    guard http.statusCode == 200 else {
      throw MobileAPIError.serverError(status: http.statusCode)
    }

    return try JSONDecoder().decode([TeamMembership].self, from: data)
  }

}
