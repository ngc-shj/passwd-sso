import CryptoKit
import Foundation
import Shared

/// Observable view-model for the vault list and detail screens.
/// Holds decrypted summaries in memory. The vault_key must be held by the caller;
/// this view-model receives it at unlock time only.
@Observable @MainActor public final class VaultViewModel {
  public private(set) var summaries: [VaultEntrySummary] = []
  public var searchQuery: String = ""
  public var filterFavoritesOnly: Bool = false
  public var filterTeamId: String? = nil  // nil = all, non-nil = specific team

  private var allSummaries: [VaultEntrySummary] = []

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
