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

// MARK: - EntryFetcher

public actor EntryFetcher {
  private let apiClient: MobileAPIClient

  public init(apiClient: MobileAPIClient) {
    self.apiClient = apiClient
  }

  /// Fetch personal vault entries with `?include=blob`.
  public func fetchPersonal() async throws -> [EncryptedEntry] {
    try await apiClient.fetchEntries(endpoint: "/api/passwords?include=blob")
  }

  /// Fetch team-vault entries for a single team.
  public func fetchTeam(teamId: String) async throws -> [EncryptedEntry] {
    try await apiClient.fetchEntries(
      endpoint: "/api/teams/\(teamId)/passwords?include=blob"
    )
  }
}

// MARK: - Team membership model

struct TeamMembership: Sendable, Codable {
  let id: String
  let name: String
}
