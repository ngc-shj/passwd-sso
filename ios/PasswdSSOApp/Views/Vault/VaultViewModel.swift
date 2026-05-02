import CryptoKit
import Foundation
import Shared

// MARK: - VaultViewModel errors

public enum VaultViewModelError: Error, Equatable {
  /// Editing team entries from the iOS app is not supported in MVP.
  case teamEditNotSupported
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
  public func loadFromCache(cacheData: CacheData, vaultKey: SymmetricKey, userId: String) {
    guard let entries = try? JSONDecoder().decode([EncryptedEntry].self, from: cacheData.entries) else {
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
    guard let entries = try? JSONDecoder().decode([EncryptedEntry].self, from: cacheData.entries),
          let entry = entries.first(where: { $0.id == entryId }) else {
      return nil
    }
    return decryptBlob(entry: entry, vaultKey: vaultKey, userId: userId)
  }

  // MARK: - Private

  private func decryptOverview(
    entry: EncryptedEntry,
    vaultKey: SymmetricKey,
    userId: String
  ) -> VaultEntrySummary? {
    do {
      let aad: Data
      if let teamId = entry.teamId {
        aad = try buildTeamEntryAAD(teamId: teamId, entryId: entry.id)
      } else {
        aad = try buildPersonalEntryAAD(userId: userId, entryId: entry.id)
      }
      let plaintext = try decryptAESGCMEncoded(
        encrypted: entry.encryptedOverview,
        key: vaultKey,
        aad: aad
      )
      return try JSONDecoder().decode(VaultEntrySummary.self, from: plaintext)
    } catch {
      return nil
    }
  }

  private func decryptBlob(
    entry: EncryptedEntry,
    vaultKey: SymmetricKey,
    userId: String
  ) -> VaultEntryDetail? {
    do {
      let aad: Data
      if let teamId = entry.teamId {
        aad = try buildTeamEntryAAD(teamId: teamId, entryId: entry.id)
      } else {
        aad = try buildPersonalEntryAAD(userId: userId, entryId: entry.id)
      }
      let plaintext = try decryptAESGCMEncoded(
        encrypted: entry.encryptedBlob,
        key: vaultKey,
        aad: aad
      )
      return try JSONDecoder().decode(VaultEntryDetail.self, from: plaintext)
    } catch {
      return nil
    }
  }
}

// MARK: - Save entry

extension VaultViewModel {
  /// Save edited entry. Re-encrypts with vault_key + personal AAD; calls API; triggers sync.
  /// Throws `VaultViewModelError.teamEditNotSupported` for team entries.
  public func saveEntry(
    entryId: String,
    userId: String,
    detail: EntryPlaintext,
    overview: OverviewPlaintext,
    vaultKey: SymmetricKey,
    apiClient: MobileAPIClient,
    hostSyncService: HostSyncService,
    aadVersion: Int = 1,
    keyVersion: Int = 1
  ) async throws {
    // Reject team entries — out of scope for MVP.
    if let summary = allSummaries.first(where: { $0.id == entryId }),
       summary.teamId != nil {
      throw VaultViewModelError.teamEditNotSupported
    }

    // Re-encrypt with personal AAD.
    let (blobEnc, overviewEnc) = try encryptPersonalEntry(
      entryId: entryId,
      userId: userId,
      vaultKey: vaultKey,
      detail: detail,
      overview: overview
    )

    // Commit to server.
    let updateReq = UpdateEntryRequest(
      encryptedBlob: blobEnc,
      encryptedOverview: overviewEnc,
      keyVersion: keyVersion,
      aadVersion: aadVersion
    )
    try await apiClient.updateEntry(entryId: entryId, body: updateReq)

    // Refresh cache after server confirms success.
    _ = try await hostSyncService.runSync(vaultKey: vaultKey, userId: userId)

    // Update in-memory summaries optimistically.
    let updatedSummary = VaultEntrySummary(
      id: entryId,
      title: overview.title,
      username: overview.username,
      urlHost: overview.urlHost ?? "",
      tags: overview.tags,
      hasTOTP: detail.totpSecret != nil
    )
    if let idx = allSummaries.firstIndex(where: { $0.id == entryId }) {
      allSummaries[idx] = updatedSummary
    }
  }
}
