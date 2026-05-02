import CryptoKit
import Foundation
import Shared

// MARK: - Wire models (matches /api/passwords GET response shape)

public struct EncryptedEntry: Sendable, Codable, Equatable {
  public let id: String
  public let encryptedOverview: EncryptedData
  public let encryptedBlob: EncryptedData
  public let keyVersion: Int
  public let aadVersion: Int
  public let entryType: String
  public let isFavorite: Bool
  public let isArchived: Bool
  public let teamId: String?
  public let tagIds: [String]?
  public let folderId: String?
  public let requireReprompt: Bool?

  public init(
    id: String,
    encryptedOverview: EncryptedData,
    encryptedBlob: EncryptedData,
    keyVersion: Int = 1,
    aadVersion: Int = 1,
    entryType: String = "LOGIN",
    isFavorite: Bool = false,
    isArchived: Bool = false,
    teamId: String? = nil,
    tagIds: [String]? = nil,
    folderId: String? = nil,
    requireReprompt: Bool? = nil
  ) {
    self.id = id
    self.encryptedOverview = encryptedOverview
    self.encryptedBlob = encryptedBlob
    self.keyVersion = keyVersion
    self.aadVersion = aadVersion
    self.entryType = entryType
    self.isFavorite = isFavorite
    self.isArchived = isArchived
    self.teamId = teamId
    self.tagIds = tagIds
    self.folderId = folderId
    self.requireReprompt = requireReprompt
  }

  enum CodingKeys: String, CodingKey {
    case id
    case encryptedOverview
    case encryptedBlob
    case keyVersion
    case aadVersion
    case entryType
    case isFavorite
    case isArchived
    case teamId
    case tagIds
    case folderId
    case requireReprompt
  }
}

// MARK: - Team wire model (matches /api/teams/[teamId]/passwords flat response shape)

/// Team entry response uses flat (non-nested) fields for ciphertext, iv, authTag.
public struct TeamEncryptedEntry: Sendable, Codable, Equatable {
  public let id: String
  // Overview: flat fields
  public let encryptedOverview: String
  public let overviewIv: String
  public let overviewAuthTag: String
  // Blob: flat fields
  public let encryptedBlob: String
  public let blobIv: String
  public let blobAuthTag: String
  public let aadVersion: Int
  public let teamKeyVersion: Int
  public let itemKeyVersion: Int
  // ItemKey: present when itemKeyVersion >= 1
  public let encryptedItemKey: String?
  public let itemKeyIv: String?
  public let itemKeyAuthTag: String?
  public let isFavorite: Bool
  public let isArchived: Bool
  public let requireReprompt: Bool?

  /// Convert to a CacheEntry for storage in the App Group cache.
  public func toCacheEntry(teamId: String) -> CacheEntry {
    let overviewData = EncryptedData(
      ciphertext: encryptedOverview,
      iv: overviewIv,
      authTag: overviewAuthTag
    )
    let blobData = EncryptedData(
      ciphertext: encryptedBlob,
      iv: blobIv,
      authTag: blobAuthTag
    )
    let itemKeyData: EncryptedData?
    if itemKeyVersion >= 1,
       let cipher = encryptedItemKey,
       let iv = itemKeyIv,
       let tag = itemKeyAuthTag {
      itemKeyData = EncryptedData(ciphertext: cipher, iv: iv, authTag: tag)
    } else {
      itemKeyData = nil
    }
    return CacheEntry(
      id: id,
      teamId: teamId,
      aadVersion: aadVersion,
      keyVersion: 0,  // teamKeyVersion serves the same role for team entries
      teamKeyVersion: teamKeyVersion,
      itemKeyVersion: itemKeyVersion,
      encryptedItemKey: itemKeyData,
      encryptedBlob: blobData,
      encryptedOverview: overviewData
    )
  }
}

// MARK: - EntryFetcher

public actor EntryFetcher {
  private let apiClient: MobileAPIClient

  public init(apiClient: MobileAPIClient) {
    self.apiClient = apiClient
  }

  /// Fetch personal vault entries with `?include=blob`.
  /// Returns entries as `CacheEntry` (with AAD input fields populated).
  public func fetchPersonal() async throws -> [EncryptedEntry] {
    try await apiClient.fetchEntries(endpoint: "/api/passwords?include=blob")
  }

  /// Fetch team-vault entries for a single team.
  /// Returns entries as `CacheEntry` (with team-specific AAD input fields populated).
  public func fetchTeamAsCacheEntries(teamId: String) async throws -> [CacheEntry] {
    let teamEntries: [TeamEncryptedEntry] = try await apiClient.fetchTeamEntries(
      teamId: teamId
    )
    return teamEntries.map { $0.toCacheEntry(teamId: teamId) }
  }
}

// MARK: - Team membership model

struct TeamMembership: Sendable, Codable {
  let id: String
  let name: String
}
