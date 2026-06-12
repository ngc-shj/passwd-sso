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
  /// Web-only overview flags, carried so an iOS edit can preserve them on
  /// re-encrypt (see EntryBlobDecoder / PersonalEntryBlobBuilder). Dropping
  /// requireReprompt would silently remove a master-passphrase re-prompt.
  /// `requireReprompt` is always present in the web overview blob, so a plain
  /// Bool (absent → false) suffices. `travelSafe` is THREE-state — the web
  /// writes it only when set and reads absent as travel-safe, so it must stay
  /// optional: collapsing an explicit `false` to absent would flip a
  /// travel-unsafe entry back to travel-safe on the next web load.
  public let requireReprompt: Bool
  public let travelSafe: Bool?
  /// Passkey overview fields (PASSKEY entries only; nil otherwise). A summary is
  /// a passkey iff `relyingPartyId != nil`. credentialId/relyingPartyId come from
  /// the overview blob; the user handle lives only in the full blob (see
  /// buildPasskeyIdentitySpecs).
  public let relyingPartyId: String?
  public let credentialId: String?

  public init(
    id: String,
    title: String,
    username: String,
    urlHost: String,
    additionalUrlHosts: [String] = [],
    tags: [String] = [],
    teamId: String? = nil,
    lastAccessedAt: Date? = nil,
    hasTOTP: Bool = false,
    requireReprompt: Bool = false,
    travelSafe: Bool? = nil,
    relyingPartyId: String? = nil,
    credentialId: String? = nil
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
    self.requireReprompt = requireReprompt
    self.travelSafe = travelSafe
    self.relyingPartyId = relyingPartyId
    self.credentialId = credentialId
  }
}
