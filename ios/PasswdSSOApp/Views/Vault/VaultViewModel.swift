import CryptoKit
import Foundation
import Shared

// MARK: - VaultViewModel errors

public enum VaultViewModelError: Error, Equatable {
  /// Editing team entries from the iOS app is not supported in MVP.
  case teamEditNotSupported
  /// The VM cache is not yet loaded (vault not unlocked or sync not run).
  case cacheUnavailable
  /// The entry's encrypted blobs could not be decrypted (wrong key or corrupted entry).
  case entryNotDecryptable
  /// The server returned an id that does not match the client-generated entryId (AAD desync).
  case entryIdMismatch
}

/// Observable view-model for the vault list and detail screens.
/// Holds decrypted summaries in memory. The vault_key must be held by the caller;
/// this view-model receives it at unlock time only.
/// Which vault the in-app list is currently showing. `.personal` shows entries
/// with no teamId; `.team(id)` shows only that team's entries. Drives the top
/// vault switcher so the team vault is clearly separated from the personal one.
public enum VaultScope: Hashable, Sendable {
  case personal
  case team(String)
}

@Observable @MainActor public final class VaultViewModel {
  public private(set) var summaries: [VaultEntrySummary] = []
  public var searchQuery: String = ""
  /// Selected vault (personal by default — team entries are NOT mixed into the
  /// personal list; the user switches vaults explicitly).
  public var scope: VaultScope = .personal
  /// Teams the user belongs to, for the switcher labels (populated from the
  /// cacheKey-decrypted team directory at load time).
  public var teamDirectory: [TeamDirectoryEntry] = []

  var allSummaries: [VaultEntrySummary] = []

  /// Injected so tests use a clean per-test suite, not the shared App Group.
  private let settings: AppSettingsStore

  /// Selected sort key (FR2/FR3), read from `settings` at init and written
  /// back to it on every change. Presented via the top-level toolbar only
  /// (SC5); category screens inherit it through `filteredSummaries`.
  public var sortOption: EntrySortOption {
    didSet { settings.entrySortOption = sortOption }
  }

  public init(settings: AppSettingsStore = AppSettingsStore()) {
    self.settings = settings
    self.sortOption = settings.entrySortOption
  }

  /// A view-model whose settings are backed by a throwaway in-memory suite,
  /// touching NO shared App Group state. Demo Mode uses this so browsing the
  /// demo vault never reads or writes the real persisted sort preference —
  /// preserving the demo isolation contract without `DemoVaultView` naming
  /// `AppSettingsStore` (see DemoModeStateTests grep gate).
  public static func makeEphemeral() -> VaultViewModel {
    let suite = UserDefaults(suiteName: "demo.ephemeral") ?? .standard
    suite.removePersistentDomain(forName: "demo.ephemeral")
    return VaultViewModel(settings: AppSettingsStore(defaults: suite))
  }

  /// cacheKey from the last `loadFromCache`, retained so `loadDetail` can decrypt
  /// team entries without re-threading it from every call site.
  private var loadedCacheKey: SymmetricKey?

  /// The most recently loaded cache. Set by `loadFromCache` and refreshed after
  /// every successful write+sync so `saveEntry`/`loadDetail` always read fresh data.
  public private(set) var cacheData: CacheData?

  // MARK: - Filtered results

  public var filteredSummaries: [VaultEntrySummary] {
    var result: [VaultEntrySummary]
    switch scope {
    case .personal:
      result = allSummaries.filter { $0.teamId == nil }
    case .team(let teamId):
      result = allSummaries.filter { $0.teamId == teamId }
    }
    if !searchQuery.isEmpty {
      let q = searchQuery.lowercased()
      result = result.filter {
        $0.title.lowercased().contains(q) ||
        $0.username.lowercased().contains(q) ||
        $0.urlHost.lowercased().contains(q)
      }
    }
    // Sort is the LAST transform (after scope + search) so search results are
    // also sorted, and every screen (top-level + category) reflects the same
    // globally-chosen key (single sort point — C6 forbidden pattern).
    return sortOption.sorted(result)
  }

  /// True when the currently selected scope is a team vault (create is disabled).
  public var isTeamScope: Bool {
    if case .team = scope { return true }
    return false
  }

  // MARK: - Load from cache

  /// Decrypt cached entries using vault_key and populate the view-model.
  ///
  /// The cache stores `[CacheEntry]` (the on-disk wire model carrying
  /// aadVersion/keyVersion/teamKeyVersion/itemKeyVersion needed for AAD
  /// construction). HostSyncService writes this shape in production;
  /// DebugVaultLoader writes it as a test fixture. The previous
  /// `[EncryptedEntry]` decode path was a dead Step-7 type that never matched
  /// the on-disk format.
  /// - Parameters:
  ///   - cacheKey: when provided (with team keys present), team entries are decrypted
  ///     too and shown under their team vault. nil → personal-only (no regression).
  ///   - teamDirectory: team id→name list for the switcher labels.
  public func loadFromCache(
    cacheData: CacheData,
    vaultKey: SymmetricKey,
    userId: String,
    cacheKey: SymmetricKey? = nil,
    wrappedKeyStore: WrappedKeyStore = AppGroupWrappedKeyStore(),
    teamDirectory: [TeamDirectoryEntry] = []
  ) {
    self.cacheData = cacheData
    self.teamDirectory = teamDirectory
    self.loadedCacheKey = cacheKey
    guard let entries = try? JSONDecoder().decode([CacheEntry].self, from: cacheData.entries) else {
      return
    }
    let teamKeys: [WrappedTeamKey] = cacheKey != nil ? ((try? wrappedKeyStore.loadTeamKeys()) ?? []) : []

    var decoded: [VaultEntrySummary] = []
    for entry in entries {
      if entry.teamId != nil {
        if let cacheKey,
           let summary = TeamEntryDecryptor.decryptTeamSummary(
             entry: entry, teamKeys: teamKeys, cacheKey: cacheKey, userId: userId, now: { Date() }) {
          decoded.append(summary)
        }
      } else if let summary = decryptOverview(entry: entry, vaultKey: vaultKey, userId: userId) {
        decoded.append(summary)
      }
    }
    allSummaries = decoded
  }

  // MARK: - Entry detail (lazy)

  /// Decrypt the encryptedBlob for a specific entry by id, given the vault_key.
  public func loadDetail(
    for entryId: String,
    cacheData: CacheData,
    vaultKey: SymmetricKey,
    userId: String,
    cacheKey: SymmetricKey? = nil,
    wrappedKeyStore: WrappedKeyStore = AppGroupWrappedKeyStore()
  ) -> VaultEntryDetail? {
    guard let entries = try? JSONDecoder().decode([CacheEntry].self, from: cacheData.entries),
          let entry = entries.first(where: { $0.id == entryId }) else {
      return nil
    }
    if entry.teamId != nil {
      guard let key = cacheKey ?? loadedCacheKey else { return nil }
      let teamKeys = (try? wrappedKeyStore.loadTeamKeys()) ?? []
      return TeamEntryDecryptor.decryptTeamDetail(
        entry: entry, teamKeys: teamKeys, cacheKey: key, userId: userId, now: { Date() })
    }
    return decryptBlob(entry: entry, vaultKey: vaultKey, userId: userId)
  }

  // MARK: - Private

  /// Construct AAD per scope, matching CredentialResolver's logic.
  /// Personal `aadVersion >= 1` → buildPersonalEntryAAD;
  /// team always → buildTeamEntryAAD.
  private func buildEntryAAD(
    entry: CacheEntry,
    userId: String,
    vaultType: String
  ) throws -> Data? {
    if let teamId = entry.teamId {
      return try buildTeamEntryAAD(
        teamId: teamId,
        entryId: entry.id,
        vaultType: vaultType,
        itemKeyVersion: entry.itemKeyVersion ?? 0
      )
    }
    if entry.aadVersion >= 1 {
      return try buildPersonalEntryAAD(userId: userId, entryId: entry.id, vaultType: vaultType)
    }
    return nil  // legacy aadVersion == 0 entries have no AAD binding
  }

  private func decryptOverview(
    entry: CacheEntry,
    vaultKey: SymmetricKey,
    userId: String
  ) -> VaultEntrySummary? {
    do {
      let aad = try buildEntryAAD(entry: entry, userId: userId, vaultType: VaultType.overview)
      let plaintext = try decryptAESGCMEncoded(
        encrypted: entry.encryptedOverview,
        key: vaultKey,
        aad: aad
      )
      // Shared decode: the server blob lacks `id` (injected from the cache row)
      // and uses null/omitted fields — direct decode into VaultEntrySummary fails.
      return EntryBlobDecoder.summary(
        plaintext: plaintext,
        entryId: entry.id,
        teamId: entry.teamId,
        entryType: entry.entryType,
        isFavorite: entry.isFavorite ?? false,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
      )
    } catch {
      return nil
    }
  }

  private func decryptBlob(
    entry: CacheEntry,
    vaultKey: SymmetricKey,
    userId: String
  ) -> VaultEntryDetail? {
    do {
      let aad = try buildEntryAAD(entry: entry, userId: userId, vaultType: VaultType.blob)
      let plaintext = try decryptAESGCMEncoded(
        encrypted: entry.encryptedBlob,
        key: vaultKey,
        aad: aad
      )
      return EntryBlobDecoder.detail(
        plaintext: plaintext, entryId: entry.id, teamId: entry.teamId,
        entryType: entry.entryType)
    } catch {
      return nil
    }
  }

  /// Decrypt both blobs for an entry using its STORED aadVersion (handles legacy
  /// aadVersion 0). Returns raw plaintext Data (not decoded) so the caller can
  /// pass it to PersonalEntryBlobBuilder.applyEdits. Returns nil on any error —
  /// never throws or crashes (caller converts nil to entryNotDecryptable).
  private func rawPlaintexts(
    for entryId: String,
    cacheData: CacheData,
    vaultKey: SymmetricKey,
    userId: String
  ) -> (blob: Data, overview: Data)? {
    guard let entries = try? JSONDecoder().decode([CacheEntry].self, from: cacheData.entries),
          let entry = entries.first(where: { $0.id == entryId }) else {
      return nil
    }
    do {
      let blobAAD = try buildEntryAAD(entry: entry, userId: userId, vaultType: VaultType.blob)
      let overviewAAD = try buildEntryAAD(entry: entry, userId: userId, vaultType: VaultType.overview)
      let blobData = try decryptAESGCMEncoded(encrypted: entry.encryptedBlob, key: vaultKey, aad: blobAAD)
      let overviewData = try decryptAESGCMEncoded(encrypted: entry.encryptedOverview, key: vaultKey, aad: overviewAAD)
      return (blob: blobData, overview: overviewData)
    } catch {
      return nil
    }
  }
}

// MARK: - Create + save entry

extension VaultViewModel {
  /// Create a new personal LOGIN entry: encrypt, POST, assert server id == entryId,
  /// sync, and refresh allSummaries from the sync's fresh cache.
  public func createEntry(
    userId: String,
    fields: EditableEntryFields,
    vaultKey: SymmetricKey,
    keyVersion: Int,
    apiClient: MobileAPIClient,
    hostSyncService: HostSyncService,
    cacheKey: SymmetricKey? = nil
  ) async throws {
    let entryId = UUID().uuidString.lowercased()
    let (blobData, overviewData) = try PersonalEntryBlobBuilder.buildCreate(fields: fields)

    let blobAAD = try buildPersonalEntryAAD(userId: userId, entryId: entryId, vaultType: VaultType.blob)
    let overviewAAD = try buildPersonalEntryAAD(userId: userId, entryId: entryId, vaultType: VaultType.overview)
    let blobEnc = try encryptAESGCMEncoded(plaintext: blobData, key: vaultKey, aad: blobAAD)
    let overviewEnc = try encryptAESGCMEncoded(plaintext: overviewData, key: vaultKey, aad: overviewAAD)

    let liveKeyVersion = max(1, keyVersion)
    let createReq = CreateEntryRequest(
      id: entryId,
      encryptedBlob: blobEnc,
      encryptedOverview: overviewEnc,
      keyVersion: liveKeyVersion,
      aadVersion: 1,
      entryType: "LOGIN"
    )
    let serverId = try await apiClient.createEntry(body: createReq)

    // S2: server id must equal client-generated entryId (AAD is bound to it).
    guard serverId == entryId else {
      throw VaultViewModelError.entryIdMismatch
    }

    // Refresh from sync — no optimistic prepend; allSummaries rebuilt from the cache.
    let report = try await hostSyncService.runSync(
      vaultKey: vaultKey, userId: userId, cacheKey: cacheKey)
    if let freshCache = report.cacheData {
      // Preserve team visibility (pass cacheKey + current directory) so team
      // entries don't vanish from the in-app list after a personal create.
      loadFromCache(
        cacheData: freshCache, vaultKey: vaultKey, userId: userId,
        cacheKey: cacheKey, teamDirectory: teamDirectory)
      // Keep QuickType identities in step with the mutation — without this the
      // new/edited entry is missing from AutoFill until the next foreground sync.
      await refreshCredentialIdentities(
        from: freshCache, vaultKey: vaultKey, userId: userId,
        cacheKey: cacheKey, wrappedKeyStore: AppGroupWrappedKeyStore())
    }
  }

  /// Save an edited personal entry: decrypt existing blobs using stored aadVersion,
  /// apply edits (preserve-unknown round-trip), re-encrypt with live keyVersion +
  /// aadVersion 1, PUT, sync, and refresh allSummaries.
  public func saveEntry(
    entryId: String,
    userId: String,
    fields: EditableEntryFields,
    vaultKey: SymmetricKey,
    keyVersion: Int,
    apiClient: MobileAPIClient,
    hostSyncService: HostSyncService,
    cacheKey: SymmetricKey? = nil
  ) async throws {
    // Reject team entries — out of scope for MVP.
    if let summary = allSummaries.first(where: { $0.id == entryId }),
       summary.teamId != nil {
      throw VaultViewModelError.teamEditNotSupported
    }

    guard let cache = cacheData else {
      throw VaultViewModelError.cacheUnavailable
    }

    guard let raw = rawPlaintexts(for: entryId, cacheData: cache, vaultKey: vaultKey, userId: userId) else {
      throw VaultViewModelError.entryNotDecryptable
    }

    let (newBlobData, newOverviewData) = try PersonalEntryBlobBuilder.applyEdits(
      blob: raw.blob,
      overview: raw.overview,
      fields: fields
    )

    // Re-encrypt with personal AAD (aadVersion 1) and the live vault key.
    let blobAAD = try buildPersonalEntryAAD(userId: userId, entryId: entryId, vaultType: VaultType.blob)
    let overviewAAD = try buildPersonalEntryAAD(userId: userId, entryId: entryId, vaultType: VaultType.overview)
    let blobEnc = try encryptAESGCMEncoded(plaintext: newBlobData, key: vaultKey, aad: blobAAD)
    let overviewEnc = try encryptAESGCMEncoded(plaintext: newOverviewData, key: vaultKey, aad: overviewAAD)

    let liveKeyVersion = max(1, keyVersion)
    let updateReq = UpdateEntryRequest(
      encryptedBlob: blobEnc,
      encryptedOverview: overviewEnc,
      keyVersion: liveKeyVersion,
      aadVersion: 1
      // tagIds omitted → server keeps the existing tag relation (route:175)
    )
    try await apiClient.updateEntry(entryId: entryId, body: updateReq)

    // Refresh cache after server confirms success.
    let report = try await hostSyncService.runSync(
      vaultKey: vaultKey, userId: userId, cacheKey: cacheKey)
    if let freshCache = report.cacheData {
      loadFromCache(
        cacheData: freshCache, vaultKey: vaultKey, userId: userId,
        cacheKey: cacheKey, teamDirectory: teamDirectory)
      // Keep QuickType identities in step with the mutation — without this the
      // new/edited entry is missing from AutoFill until the next foreground sync.
      await refreshCredentialIdentities(
        from: freshCache, vaultKey: vaultKey, userId: userId,
        cacheKey: cacheKey, wrappedKeyStore: AppGroupWrappedKeyStore())
    }
  }
}
