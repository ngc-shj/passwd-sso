import Foundation

/// Decoded from encryptedBlob — full entry including secrets.
public struct VaultEntryDetail: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let title: String
  public let username: String
  public let urlHost: String
  public let additionalUrlHosts: [String]
  public let tags: [String]
  public let teamId: String?
  public let lastAccessedAt: Date?
  public let password: String
  public let url: String
  public let notes: String
  public let totpSecret: String?
  public let generatorSettings: GeneratorSettings?

  public struct GeneratorSettings: Codable, Sendable, Equatable {
    public let length: Int
    public let useUppercase: Bool
    public let useLowercase: Bool
    public let useNumbers: Bool
    public let symbols: String

    public init(
      length: Int = 16,
      useUppercase: Bool = true,
      useLowercase: Bool = true,
      useNumbers: Bool = true,
      symbols: String = ""
    ) {
      self.length = length
      self.useUppercase = useUppercase
      self.useLowercase = useLowercase
      self.useNumbers = useNumbers
      self.symbols = symbols
    }
  }

  public init(
    id: String,
    title: String,
    username: String,
    urlHost: String,
    additionalUrlHosts: [String] = [],
    tags: [String] = [],
    teamId: String? = nil,
    lastAccessedAt: Date? = nil,
    password: String,
    url: String,
    notes: String = "",
    totpSecret: String? = nil,
    generatorSettings: GeneratorSettings? = nil
  ) {
    self.id = id
    self.title = title
    self.username = username
    self.urlHost = urlHost
    self.additionalUrlHosts = additionalUrlHosts
    self.tags = tags
    self.teamId = teamId
    self.lastAccessedAt = lastAccessedAt
    self.password = password
    self.url = url
    self.notes = notes
    self.totpSecret = totpSecret
    self.generatorSettings = generatorSettings
  }
}
