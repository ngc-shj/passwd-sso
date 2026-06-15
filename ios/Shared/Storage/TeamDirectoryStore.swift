import CryptoKit
import Foundation

/// A team the user belongs to, for in-app vault-switcher labels. Persisted
/// encrypted under cacheKey (team names are not E2E secrets but are kept off
/// plaintext disk for consistency with the rest of the vault material).
public struct TeamDirectoryEntry: Sendable, Codable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public init(id: String, name: String) {
    self.id = id
    self.name = name
  }
}

/// Persists the team directory (teamId → name) as a cacheKey-encrypted JSON file
/// in the App Group, so the vault switcher has labels on cold load.
public protocol TeamDirectoryStoring: Sendable {
  func save(_ entries: [TeamDirectoryEntry], cacheKey: SymmetricKey, userId: String) throws
  func load(cacheKey: SymmetricKey, userId: String) -> [TeamDirectoryEntry]
  func clear() throws
}

public struct TeamDirectoryStore: TeamDirectoryStoring, Sendable {
  public init() {}

  public func save(_ entries: [TeamDirectoryEntry], cacheKey: SymmetricKey, userId: String) throws {
    let json = try JSONEncoder().encode(entries)
    let aad = try buildLocalWrapAAD(kind: "teamdir", userId: userId)
    let encrypted = try encryptAESGCMEncoded(plaintext: json, key: cacheKey, aad: aad)
    let data = try JSONEncoder().encode(encrypted)
    try AppGroupContainer.ensureDirectoryExists()
    let url = try directoryURL()
    let tmp = url.deletingLastPathComponent()
      .appending(path: url.lastPathComponent + ".tmp", directoryHint: .notDirectory)
    try data.write(to: tmp, options: .atomic)
    _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
  }

  public func load(cacheKey: SymmetricKey, userId: String) -> [TeamDirectoryEntry] {
    guard let url = try? directoryURL(),
          FileManager.default.fileExists(atPath: url.path),
          let data = try? Data(contentsOf: url),
          let encrypted = try? JSONDecoder().decode(EncryptedData.self, from: data),
          let aad = try? buildLocalWrapAAD(kind: "teamdir", userId: userId),
          let json = try? decryptAESGCMEncoded(encrypted: encrypted, key: cacheKey, aad: aad),
          let entries = try? JSONDecoder().decode([TeamDirectoryEntry].self, from: json)
    else { return [] }
    return entries
  }

  public func clear() throws {
    let url = try directoryURL()
    if FileManager.default.fileExists(atPath: url.path) {
      try FileManager.default.removeItem(at: url)
    }
  }

  private func directoryURL() throws -> URL {
    try AppGroupContainer.url()
      .appending(path: "vault", directoryHint: .isDirectory)
      .appending(path: "team-directory.json", directoryHint: .notDirectory)
  }
}
