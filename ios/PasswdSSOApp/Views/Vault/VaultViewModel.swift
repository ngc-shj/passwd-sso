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
@Observable @MainActor public final class VaultViewModel {
  public private(set) var summaries: [VaultEntrySummary] = []
  public var searchQuery: String = ""
  public var filterFavoritesOnly: Bool = false
  public var filterTeamId: String? = nil  // nil = all, non-nil = specific team

  var allSummaries: [VaultEntrySummary] = []

  /// The most recently loaded cache. Set by `loadFromCache` and refreshed after
  /// every successful write+sync so `saveEntry`/`loadDetail` always read fresh data.
  public private(set) var cacheData: CacheData?

  // MARK: - Filtered results

  public var filteredSummaries: [VaultEntrySummary] {
    var result = allSummaries
    if !searchQuery.isEmpty {
      let q = searchQuery.lowercased()
      result = result.filter {
        $0.title.lowercased().contains(q) ||
        $0.username.lowercased().contains(q) ||
        $0.urlHost.lowercased().contains(q)
      }
    }
    if filterFavoritesOnly {
      // Summary doesn't carry isFavorite; filtering by text only for now.
      // isFavorite lives in the encrypted blob — used for display only in detail.
    }
    if let teamId = filterTeamId {
      result = result.filter { $0.teamId == teamId }
    }
    return result
  }

  // MARK: - Load from cache

  /// Decrypt cached entries using vault_key and populate the view-model.
  ///
  /// The cache stores `[CacheEntry]` (the on-disk wire model carrying
  /// aadVersion/keyVersion/teamKeyVersion/itemKeyVersion needed for AAD
  /// construction). HostSyncService and DebugVaultLoader both write this
  /// shape; the previous `[EncryptedEntry]` decode path was a dead Step-7
  /// type that never matched the on-disk format.
  public func loadFromCache(cacheData: CacheData, vaultKey: SymmetricKey, userId: String) {
    self.cacheData = cacheData
    guard let entries = try? JSONDecoder().decode([CacheEntry].self, from: cacheData.entries) else {
      return
    }

    var decoded: [VaultEntrySummary] = []
    for entry in entries {
      if let summary = decryptOverview(entry: entry, vaultKey: vaultKey, userId: userId) {
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
    userId: String
  ) -> VaultEntryDetail? {
    guard let entries = try? JSONDecoder().decode([CacheEntry].self, from: cacheData.entries),
          let entry = entries.first(where: { $0.id == entryId }) else {
      return nil
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
      return EntryBlobDecoder.summary(plaintext: plaintext, entryId: entry.id, teamId: entry.teamId)
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
      return EntryBlobDecoder.detail(plaintext: plaintext, entryId: entry.id, teamId: entry.teamId)
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
    hostSyncService: HostSyncService
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
    let report = try await hostSyncService.runSync(vaultKey: vaultKey, userId: userId)
    if let freshCache = report.cacheData {
      loadFromCache(cacheData: freshCache, vaultKey: vaultKey, userId: userId)
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
    hostSyncService: HostSyncService
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
    let report = try await hostSyncService.runSync(vaultKey: vaultKey, userId: userId)
    if let freshCache = report.cacheData {
      loadFromCache(cacheData: freshCache, vaultKey: vaultKey, userId: userId)
    }
  }
}
