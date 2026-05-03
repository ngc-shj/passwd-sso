import Foundation

// MARK: - Wrapped key models

public struct WrappedVaultKey: Sendable, Codable, Equatable {
  public let ciphertext: Data
  public let iv: Data
  public let authTag: Data
  public let issuedAt: Date

  public init(ciphertext: Data, iv: Data, authTag: Data, issuedAt: Date) {
    self.ciphertext = ciphertext
    self.iv = iv
    self.authTag = authTag
    self.issuedAt = issuedAt
  }
}

public struct WrappedTeamKey: Sendable, Codable, Equatable {
  public let teamId: String
  public let ciphertext: Data
  public let iv: Data
  public let authTag: Data
  public let issuedAt: Date
  public let teamKeyVersion: Int

  public init(
    teamId: String,
    ciphertext: Data,
    iv: Data,
    authTag: Data,
    issuedAt: Date,
    teamKeyVersion: Int
  ) {
    self.teamId = teamId
    self.ciphertext = ciphertext
    self.iv = iv
    self.authTag = authTag
    self.issuedAt = issuedAt
    self.teamKeyVersion = teamKeyVersion
  }
}

// MARK: - Protocol

public protocol WrappedKeyStore: Sendable {
  func saveVaultKey(_ wrapped: WrappedVaultKey) throws
  func loadVaultKey() throws -> WrappedVaultKey?
  func saveTeamKeys(_ keys: [WrappedTeamKey]) throws
  func loadTeamKeys() throws -> [WrappedTeamKey]
  func clearAll() throws
}

// MARK: - App Group implementation

/// Persists wrapped keys as JSON files in the App Group container.
/// All writes are atomic: `.tmp` → fsync → rename.
public struct AppGroupWrappedKeyStore: WrappedKeyStore, Sendable {

  public init() {}

  // MARK: - Vault key

  public func saveVaultKey(_ wrapped: WrappedVaultKey) throws {
    let data = try JSONEncoder().encode(wrapped)
    try atomicWrite(data: data, to: vaultKeyURL())
  }

  public func loadVaultKey() throws -> WrappedVaultKey? {
    let url = try vaultKeyURL()
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode(WrappedVaultKey.self, from: data)
  }

  // MARK: - Team keys

  public func saveTeamKeys(_ keys: [WrappedTeamKey]) throws {
    let data = try JSONEncoder().encode(keys)
    try atomicWrite(data: data, to: teamKeysURL())
  }

  public func loadTeamKeys() throws -> [WrappedTeamKey] {
    let url = try teamKeysURL()
    guard FileManager.default.fileExists(atPath: url.path) else { return [] }
    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode([WrappedTeamKey].self, from: data)
  }

  // MARK: - Clear

  public func clearAll() throws {
    let fm = FileManager.default
    let vaultKeyPath = try vaultKeyURL().path
    let teamKeysPath = try teamKeysURL().path
    if fm.fileExists(atPath: vaultKeyPath) {
      try fm.removeItem(atPath: vaultKeyPath)
    }
    if fm.fileExists(atPath: teamKeysPath) {
      try fm.removeItem(atPath: teamKeysPath)
    }
  }

  // MARK: - Private helpers

  private func vaultKeyURL() throws -> URL {
    try AppGroupContainer.url()
      .appending(path: "vault", directoryHint: .isDirectory)
      .appending(path: "wrapped-vault-key.json", directoryHint: .notDirectory)
  }

  private func teamKeysURL() throws -> URL {
    try AppGroupContainer.url()
      .appending(path: "vault", directoryHint: .isDirectory)
      .appending(path: "wrapped-team-keys.json", directoryHint: .notDirectory)
  }

  private func atomicWrite(data: Data, to url: URL) throws {
    try AppGroupContainer.ensureDirectoryExists()
    let tmpURL = url.deletingLastPathComponent()
      .appending(path: url.lastPathComponent + ".tmp", directoryHint: .notDirectory)
    try data.write(to: tmpURL, options: .atomic)
    _ = try FileManager.default.replaceItemAt(url, withItemAt: tmpURL)
  }
}
