import AuthenticationServices
import CryptoKit
import Foundation

// MARK: - Sendable service identifier

/// Sendable mirror of ASCredentialServiceIdentifier for crossing actor boundaries.
public struct ServiceIdentifier: Sendable {
  public let identifier: String
  public let isURL: Bool

  public init(identifier: String, isURL: Bool) {
    self.identifier = identifier
    self.isURL = isURL
  }

  public init(from source: ASCredentialServiceIdentifier) {
    self.identifier = source.identifier
    self.isURL = source.type == .URL
  }
}

/// The AutoFill extension's entry point for resolving cached vault entries.
///
/// Per plan §"Token shape": the extension has NO bearer credential and makes NO network calls.
/// Per plan §"Per-fill biometric": exactly ONE Keychain read (one biometric prompt) per call.
/// Per plan §"Vault key zeroing": vault_key is zeroed before this actor method returns.
public actor CredentialResolver {

  // MARK: - Error

  public enum Error: Swift.Error, Equatable {
    case vaultLocked           // bridge_key not in Keychain
    case cacheUnavailable      // App Group cache file absent
    case cacheRejected(CacheRejectionKind)  // forwarded from EntryCacheFile.readCacheFile
    case noEntries
    case entryNotFound
    case teamKeyStale(teamId: String)  // wrapped team key blob older than 15 minutes
  }

  // MARK: - Private state

  private let bridgeKeyStore: BridgeKeyStore
  private let wrappedKeyStore: any WrappedKeyStore
  private let cacheURL: URL
  private let teamKeyMaxAge: TimeInterval
  private let rollbackFlagWriter: (any RollbackFlagWriter)?
  private let now: () -> Date

  // Retain bridge-key blob for the duration of a fill (resolveCandidates → decryptEntryDetail).
  // Cleared on each new call to resolveCandidates.
  private var currentBlob: BridgeKeyStore.Blob?

  // MARK: - Initialiser

  public init(
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore,
    cacheURL: URL,
    teamKeyMaxAge: TimeInterval = 15 * 60,
    rollbackFlagWriter: (any RollbackFlagWriter)? = nil,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.bridgeKeyStore = bridgeKeyStore
    self.wrappedKeyStore = wrappedKeyStore
    self.cacheURL = cacheURL
    self.teamKeyMaxAge = teamKeyMaxAge
    self.rollbackFlagWriter = rollbackFlagWriter
    self.now = now
  }

  // MARK: - Public API

  /// Returns matching entry summaries (decrypted overviews) for a given set of service identifiers.
  /// Performs a SINGLE bridge_key Keychain read (one biometric prompt) per call.
  /// Vault_key derived from bridge_key is zeroed before this method returns.
  public func resolveCandidates(
    for serviceIdentifiers: [ServiceIdentifier]
  ) async throws -> [VaultEntrySummary] {
    currentBlob = nil

    // Single biometric Keychain read.
    let blob: BridgeKeyStore.Blob
    do {
      blob = try bridgeKeyStore.readForFill(reason: "Fill credential from passwd-sso vault")
    } catch BridgeKeyStore.Error.notFound, BridgeKeyStore.Error.biometryFailed {
      throw Error.vaultLocked
    } catch {
      throw Error.vaultLocked
    }

    // Derive vault key in memory — must be zeroed before return.
    var vaultKeyData = blob.bridgeKey.withUnsafeBytes { Data($0) }
    defer { zeroData(&vaultKeyData) }

    let vaultKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)

    // Read and integrity-check the cache file.
    let cacheData: CacheData
    do {
      cacheData = try readCacheFile(
        path: cacheURL,
        vaultKey: vaultKey,
        expectedHostInstallUUID: blob.hostInstallUUID,
        expectedCounter: blob.cacheVersionCounter,
        now: now()
      )
    } catch EntryCacheError.rejection(let kind) {
      // Write a MAC-protected rollback flag for the host-app drain (Step 11 posts it).
      await writeRollbackFlag(kind: kind, blob: blob, vaultKey: vaultKey)
      throw Error.cacheRejected(kind)
    } catch {
      throw Error.cacheUnavailable
    }

    // Decode entries from JSON.
    let allEntries: [CacheEntry]
    do {
      allEntries = try JSONDecoder().decode([CacheEntry].self, from: cacheData.entries)
    } catch {
      throw Error.cacheUnavailable
    }

    // Decrypt summaries (overview blobs only).
    let userId = cacheData.header.userId
    let teamKeys = (try? wrappedKeyStore.loadTeamKeys()) ?? []
    var summaries: [VaultEntrySummary] = []
    var encounteredStaleTeamIds: Set<String> = []
    var allStale = false

    for entry in allEntries {
      if let teamId = entry.teamId {
        // Look up the wrapped team key.
        guard let wrappedTeamKey = teamKeys.first(where: { $0.teamId == teamId }) else {
          continue  // no key for this team — skip silently
        }
        // Per plan §"Team-key cache invalidation": refuse blobs older than 15 min.
        if now().timeIntervalSince(wrappedTeamKey.issuedAt) > teamKeyMaxAge {
          encounteredStaleTeamIds.insert(teamId)
          continue
        }
        // Decrypt team key using vault_key.
        guard let teamKey = decryptTeamKey(wrappedTeamKey, vaultKey: vaultKey) else {
          continue
        }
        // Unwrap ItemKey if itemKeyVersion >= 1.
        guard let entryKey = resolveTeamEntryKey(entry: entry, teamKey: teamKey) else {
          continue
        }
        if let summary = decryptSummary(entry: entry, key: entryKey, userId: userId) {
          summaries.append(summary)
        }
      } else {
        // Personal entry — decrypt with vault_key.
        if let summary = decryptSummary(entry: entry, key: vaultKey, userId: userId) {
          summaries.append(summary)
        }
      }
    }

    // If we have stale team entries but NO other entries, throw teamKeyStale for the first stale team.
    if summaries.isEmpty && !encounteredStaleTeamIds.isEmpty {
      allStale = true
    }

    if allStale, let staleTeamId = encounteredStaleTeamIds.sorted().first {
      throw Error.teamKeyStale(teamId: staleTeamId)
    }

    if summaries.isEmpty && allEntries.isEmpty {
      throw Error.noEntries
    }

    // Filter and sort by URL host match.
    let tabHosts = serviceIdentifiers.compactMap { ident -> String? in
      if ident.isURL {
        return extractHost(ident.identifier)
      } else {
        return ident.identifier  // bundle ID — use as-is for app-side matching
      }
    }

    var matched: [VaultEntrySummary] = []
    var unmatched: [VaultEntrySummary] = []

    for summary in summaries {
      let isMatch = tabHosts.contains { host in
        isHostMatch(stored: summary.urlHost, current: host)
        || summary.additionalUrlHosts.contains { isHostMatch(stored: $0, current: host) }
      }
      if isMatch {
        matched.append(summary)
      } else {
        unmatched.append(summary)
      }
    }

    // Store blob so decryptEntryDetail can reuse it within the same fill without re-prompting.
    currentBlob = blob

    return matched + unmatched
  }

  /// Decrypts one entry's full blob (used after the user picks from the list).
  /// Uses the bridge_key retained from the preceding `resolveCandidates` call.
  /// Vault_key is zeroed before this method returns.
  public func decryptEntryDetail(entryId: String) async throws -> VaultEntryDetail {
    // Re-read the Keychain if we don't have a retained blob.
    let blob: BridgeKeyStore.Blob
    if let retained = currentBlob {
      blob = retained
    } else {
      do {
        blob = try bridgeKeyStore.readForFill(reason: "Fill credential from passwd-sso vault")
      } catch {
        throw Error.vaultLocked
      }
    }
    currentBlob = nil  // consume after one use

    let vaultKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)

    // Re-read and integrity-check the cache.
    let cacheData: CacheData
    do {
      cacheData = try readCacheFile(
        path: cacheURL,
        vaultKey: vaultKey,
        expectedHostInstallUUID: blob.hostInstallUUID,
        expectedCounter: blob.cacheVersionCounter,
        now: now()
      )
    } catch EntryCacheError.rejection(let kind) {
      await writeRollbackFlag(kind: kind, blob: blob, vaultKey: vaultKey)
      throw Error.cacheRejected(kind)
    } catch {
      throw Error.cacheUnavailable
    }

    let allEntries: [CacheEntry]
    do {
      allEntries = try JSONDecoder().decode([CacheEntry].self, from: cacheData.entries)
    } catch {
      throw Error.cacheUnavailable
    }

    guard let entry = allEntries.first(where: { $0.id == entryId }) else {
      throw Error.entryNotFound
    }

    let userId = cacheData.header.userId
    let teamKeys = (try? wrappedKeyStore.loadTeamKeys()) ?? []
    let decryptKey: SymmetricKey
    if let teamId = entry.teamId {
      guard let wrappedTeamKey = teamKeys.first(where: { $0.teamId == teamId }) else {
        throw Error.entryNotFound
      }
      guard let teamKey = decryptTeamKey(wrappedTeamKey, vaultKey: vaultKey) else {
        throw Error.entryNotFound
      }
      guard let entryKey = resolveTeamEntryKey(entry: entry, teamKey: teamKey) else {
        throw Error.entryNotFound
      }
      decryptKey = entryKey
    } else {
      decryptKey = vaultKey
    }

    guard let detail = decryptDetail(entry: entry, key: decryptKey, userId: userId) else {
      throw Error.entryNotFound
    }

    return detail
  }

  // MARK: - Private helpers

  private func decryptSummary(
    entry: CacheEntry,
    key: SymmetricKey,
    userId: String
  ) -> VaultEntrySummary? {
    let aad = buildEntryAAD(entry: entry, vaultType: "overview", userId: userId)
    guard
      let ivData = try? hexDecode(entry.encryptedOverview.iv),
      let cipherData = try? hexDecode(entry.encryptedOverview.ciphertext),
      let tagData = try? hexDecode(entry.encryptedOverview.authTag),
      let plaintext = try? decryptAESGCM(
        ciphertext: cipherData,
        iv: ivData,
        tag: tagData,
        key: key,
        aad: aad
      ),
      let decoded = try? JSONDecoder().decode(VaultEntrySummary.self, from: plaintext)
    else {
      return nil
    }
    return decoded
  }

  private func decryptDetail(
    entry: CacheEntry,
    key: SymmetricKey,
    userId: String
  ) -> VaultEntryDetail? {
    let aad = buildEntryAAD(entry: entry, vaultType: "blob", userId: userId)
    guard
      let ivData = try? hexDecode(entry.encryptedBlob.iv),
      let cipherData = try? hexDecode(entry.encryptedBlob.ciphertext),
      let tagData = try? hexDecode(entry.encryptedBlob.authTag),
      let plaintext = try? decryptAESGCM(
        ciphertext: cipherData,
        iv: ivData,
        tag: tagData,
        key: key,
        aad: aad
      ),
      let decoded = try? JSONDecoder().decode(VaultEntryDetail.self, from: plaintext)
    else {
      return nil
    }
    return decoded
  }

  /// Build the AAD for a cache entry at decrypt time.
  /// - Personal: AAD only when aadVersion >= 1.
  /// - Team: AAD always (no aadVersion gate; vaultType distinguishes blob/overview).
  private func buildEntryAAD(
    entry: CacheEntry,
    vaultType: String,
    userId: String
  ) -> Data? {
    if let teamId = entry.teamId {
      return try? buildTeamEntryAAD(
        teamId: teamId,
        entryId: entry.id,
        vaultType: vaultType,
        itemKeyVersion: entry.itemKeyVersion ?? 0
      )
    } else {
      guard entry.aadVersion >= 1 else { return nil }
      return try? buildPersonalEntryAAD(userId: userId, entryId: entry.id)
    }
  }

  /// Resolve the entry-level key:
  /// - itemKeyVersion == 0 → use teamKey directly.
  /// - itemKeyVersion >= 1 → decrypt encryptedItemKey with teamKey + wrap AAD.
  private func resolveTeamEntryKey(
    entry: CacheEntry,
    teamKey: SymmetricKey
  ) -> SymmetricKey? {
    let itemKeyVersion = entry.itemKeyVersion ?? 0
    if itemKeyVersion == 0 {
      return teamKey
    }
    guard
      let teamId = entry.teamId,
      let teamKeyVersion = entry.teamKeyVersion,
      let wrapped = entry.encryptedItemKey,
      let aad = try? buildItemKeyWrapAAD(
        teamId: teamId,
        entryId: entry.id,
        teamKeyVersion: teamKeyVersion
      ),
      let cipher = try? hexDecode(wrapped.ciphertext),
      let iv = try? hexDecode(wrapped.iv),
      let tag = try? hexDecode(wrapped.authTag),
      let itemKeyData = try? decryptAESGCM(
        ciphertext: cipher,
        iv: iv,
        tag: tag,
        key: teamKey,
        aad: aad
      )
    else {
      return nil
    }
    return SymmetricKey(data: itemKeyData)
  }

  private func decryptTeamKey(
    _ wrapped: WrappedTeamKey,
    vaultKey: SymmetricKey
  ) -> SymmetricKey? {
    guard
      let plaintext = try? decryptAESGCM(
        ciphertext: wrapped.ciphertext,
        iv: wrapped.iv,
        tag: wrapped.authTag,
        key: vaultKey
      )
    else {
      return nil
    }
    return SymmetricKey(data: plaintext)
  }

  private func writeRollbackFlag(
    kind: CacheRejectionKind,
    blob: BridgeKeyStore.Blob,
    vaultKey: SymmetricKey
  ) async {
    guard let writer = rollbackFlagWriter else { return }
    let payload = RollbackFlagPayload(
      expectedCounter: blob.cacheVersionCounter,
      observedCounter: blob.cacheVersionCounter,
      headerIssuedAt: nil,
      rejectionKind: kind
    )
    try? await writer.writeFlag(payload: payload, vaultKey: vaultKey)
  }

  private func zeroData(_ data: inout Data) {
    _ = data.withUnsafeMutableBytes { ptr in
      ptr.initializeMemory(as: UInt8.self, repeating: 0)
    }
  }
}

// MARK: - Wire model for encrypted cache entries

/// Wire model for entries stored in the App Group cache by HostSyncService.
/// Each entry carries two hex-encoded AES-256-GCM blobs (overview + full),
/// plus the AAD input fields needed to reconstruct the AAD at decrypt time.
public struct CacheEntry: Codable, Sendable {
  public let id: String
  /// nil for personal entries; non-nil for team entries.
  public let teamId: String?
  /// 0 = no AAD; >= 1 = AAD-bound (personal entries only).
  public let aadVersion: Int
  /// Personal entry key version (forward-compat).
  public let keyVersion: Int
  /// Team entries only: teamKey version used when encrypting.
  public let teamKeyVersion: Int?
  /// Team entries only: 0 = teamKey direct, >= 1 = ItemKey wrapped under teamKey.
  public let itemKeyVersion: Int?
  /// Team entries with itemKeyVersion >= 1: wrapped per-entry ItemKey.
  public let encryptedItemKey: EncryptedData?
  public let encryptedBlob: EncryptedData
  public let encryptedOverview: EncryptedData

  public init(
    id: String,
    teamId: String? = nil,
    aadVersion: Int = 0,
    keyVersion: Int = 0,
    teamKeyVersion: Int? = nil,
    itemKeyVersion: Int? = nil,
    encryptedItemKey: EncryptedData? = nil,
    encryptedBlob: EncryptedData,
    encryptedOverview: EncryptedData
  ) {
    self.id = id
    self.teamId = teamId
    self.aadVersion = aadVersion
    self.keyVersion = keyVersion
    self.teamKeyVersion = teamKeyVersion
    self.itemKeyVersion = itemKeyVersion
    self.encryptedItemKey = encryptedItemKey
    self.encryptedBlob = encryptedBlob
    self.encryptedOverview = encryptedOverview
  }
}
