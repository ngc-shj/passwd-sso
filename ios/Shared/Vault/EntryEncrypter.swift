import CryptoKit
import Foundation

// MARK: - Plaintext models

/// Full entry data to encrypt into the blob.
public struct EntryPlaintext: Sendable, Codable, Equatable {
  public let title: String
  public let username: String
  public let password: String
  public let url: String?
  public let notes: String?
  public let totpSecret: String?
  public let tags: [String]

  public init(
    title: String,
    username: String,
    password: String,
    url: String? = nil,
    notes: String? = nil,
    totpSecret: String? = nil,
    tags: [String] = []
  ) {
    self.title = title
    self.username = username
    self.password = password
    self.url = url
    self.notes = notes
    self.totpSecret = totpSecret
    self.tags = tags
  }
}

/// Summary data to encrypt into the overview blob.
public struct OverviewPlaintext: Sendable, Codable, Equatable {
  public let title: String
  public let username: String
  public let urlHost: String?
  public let tags: [String]

  public init(
    title: String,
    username: String,
    urlHost: String? = nil,
    tags: [String] = []
  ) {
    self.title = title
    self.username = username
    self.urlHost = urlHost
    self.tags = tags
  }
}

// MARK: - Errors

public enum EntryEncrypterError: Error, Equatable {
  case encryptionFailed
}

// MARK: - Encrypt helper

/// Encrypts both the full entry plaintext (blob) and the overview-summary plaintext
/// with the personal-vault AAD `buildPersonalEntryAAD(userId, entryId)`.
public func encryptPersonalEntry(
  entryId: String,
  userId: String,
  vaultKey: SymmetricKey,
  detail: EntryPlaintext,
  overview: OverviewPlaintext
) throws -> (blob: EncryptedData, overview: EncryptedData) {
  let aad = try buildPersonalEntryAAD(userId: userId, entryId: entryId)
  let encoder = JSONEncoder()

  let detailData = try encoder.encode(detail)
  let overviewData = try encoder.encode(overview)

  do {
    let blobEncrypted = try encryptAESGCMEncoded(plaintext: detailData, key: vaultKey, aad: aad)
    let overviewEncrypted = try encryptAESGCMEncoded(
      plaintext: overviewData, key: vaultKey, aad: aad)
    return (blob: blobEncrypted, overview: overviewEncrypted)
  } catch {
    throw EntryEncrypterError.encryptionFailed
  }
}
