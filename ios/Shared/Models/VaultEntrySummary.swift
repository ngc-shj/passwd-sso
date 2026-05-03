import Foundation

/// Decoded from encryptedOverview — enough for list view and URL matching.
public struct VaultEntrySummary: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let title: String
  public let username: String
  public let urlHost: String
  public let additionalUrlHosts: [String]
  public let tags: [String]
  public let teamId: String?
  public let lastAccessedAt: Date?
  /// True when the entry has a TOTP secret (used to filter the TOTP AutoFill picker).
  public let hasTOTP: Bool

  public init(
    id: String,
    title: String,
    username: String,
    urlHost: String,
    additionalUrlHosts: [String] = [],
    tags: [String] = [],
    teamId: String? = nil,
    lastAccessedAt: Date? = nil,
    hasTOTP: Bool = false
  ) {
    self.id = id
    self.title = title
    self.username = username
    self.urlHost = urlHost
    self.additionalUrlHosts = additionalUrlHosts
    self.tags = tags
    self.teamId = teamId
    self.lastAccessedAt = lastAccessedAt
    self.hasTOTP = hasTOTP
  }
}
