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
  // Optional → omitted from the encoded blob when nil, matching the web
  // client's overview shape (`...(hosts.length && {additionalUrlHosts})`,
  // `...(totp && {hasTOTP:true})`). Preserving these on an iOS re-encrypt is
  // required so editing an entry on iPhone does not silently drop the
  // additional URL hosts (AutoFill domain match) or the TOTP picker marker.
  public let additionalUrlHosts: [String]?
  public let hasTOTP: Bool?
  public let requireReprompt: Bool?
  public let travelSafe: Bool?
  public let tags: [String]

  public init(
    title: String,
    username: String,
    urlHost: String? = nil,
    additionalUrlHosts: [String]? = nil,
    hasTOTP: Bool? = nil,
    requireReprompt: Bool? = nil,
    travelSafe: Bool? = nil,
    tags: [String] = []
  ) {
    self.title = title
    self.username = username
    self.urlHost = urlHost
    self.additionalUrlHosts = additionalUrlHosts
    self.hasTOTP = hasTOTP
    self.requireReprompt = requireReprompt
    self.travelSafe = travelSafe
    self.tags = tags
  }
}

// MARK: - Errors

public enum EntryEncrypterError: Error, Equatable {
  case encryptionFailed
}

// MARK: - Encrypt helper

/// Encrypts the full entry plaintext (blob) and the overview-summary plaintext,
/// each with its own personal-vault AAD (BLOB vs OVERVIEW) — they must never
/// share an AAD (cross-field replay protection).
public func encryptPersonalEntry(
  entryId: String,
  userId: String,
  vaultKey: SymmetricKey,
  detail: EntryPlaintext,
  overview: OverviewPlaintext
) throws -> (blob: EncryptedData, overview: EncryptedData) {
  let blobAAD = try buildPersonalEntryAAD(
    userId: userId, entryId: entryId, vaultType: VaultType.blob)
  let overviewAAD = try buildPersonalEntryAAD(
    userId: userId, entryId: entryId, vaultType: VaultType.overview)
  let encoder = JSONEncoder()

  let detailData = try encoder.encode(detail)
  let overviewData = try encoder.encode(overview)

  do {
    let blobEncrypted = try encryptAESGCMEncoded(plaintext: detailData, key: vaultKey, aad: blobAAD)
    let overviewEncrypted = try encryptAESGCMEncoded(
      plaintext: overviewData, key: vaultKey, aad: overviewAAD)
    return (blob: blobEncrypted, overview: overviewEncrypted)
  } catch {
    throw EntryEncrypterError.encryptionFailed
  }
}
