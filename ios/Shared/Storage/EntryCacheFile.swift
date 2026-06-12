import CryptoKit
import Foundation

// MARK: - Public types

public struct CacheHeader: Codable, Sendable, Equatable {
  public let cacheVersionCounter: UInt64
  public let cacheIssuedAt: Date
  public let lastSuccessfulRefreshAt: Date
  public let entryCount: UInt32
  public let hostInstallUUID: Data  // 16 bytes
  /// userId from the vault unlock response — used as AAD input for personal entries.
  public let userId: String

  public init(
    cacheVersionCounter: UInt64,
    cacheIssuedAt: Date,
    lastSuccessfulRefreshAt: Date,
    entryCount: UInt32,
    hostInstallUUID: Data,
    userId: String
  ) {
    self.cacheVersionCounter = cacheVersionCounter
    self.cacheIssuedAt = cacheIssuedAt
    self.lastSuccessfulRefreshAt = lastSuccessfulRefreshAt
    self.entryCount = entryCount
    self.hostInstallUUID = hostInstallUUID
    self.userId = userId
  }
}

public enum CacheRejectionKind: String, Sendable, Codable {
  case headerMissing = "header_missing"
  case aadMismatch = "aad_mismatch"
  case authtagInvalid = "authtag_invalid"
  case entryCountMismatch = "entry_count_mismatch"
  case headerClockSkew = "header_clock_skew"
  case headerStale = "header_stale"
  case counterMismatch = "counter_mismatch"
  case headerInvalid = "header_invalid"
}

public struct CacheData: Sendable, Equatable {
  public let header: CacheHeader
  public let entries: Data  // raw JSON bytes; caller decodes

  public init(header: CacheHeader, entries: Data) {
    self.header = header
    self.entries = entries
  }
}

/// Header-derived diagnostics attached to a cache rejection, threaded into the
/// rollback-flag payload so the server report carries the actually-observed
/// values. Fields are nil when the failure happened before the header could be
/// decrypted — a rolled-back file fails header AAD, so its on-disk counter is
/// cryptographically unknowable.
public struct CacheRejectionContext: Sendable, Equatable {
  public let observedCounter: UInt64?
  public let headerIssuedAt: Date?
  public let lastSuccessfulRefreshAt: Date?

  public init(
    observedCounter: UInt64? = nil,
    headerIssuedAt: Date? = nil,
    lastSuccessfulRefreshAt: Date? = nil
  ) {
    self.observedCounter = observedCounter
    self.headerIssuedAt = headerIssuedAt
    self.lastSuccessfulRefreshAt = lastSuccessfulRefreshAt
  }

  public static let unavailable = CacheRejectionContext()
}

public enum EntryCacheError: Error, Equatable {
  case rejection(CacheRejectionKind, CacheRejectionContext)
  case ioError(String)
}

// MARK: - File format constants

// Magic: "PSSV" (4 bytes ASCII), FormatVersion: 0x01 (1 byte), Reserved: 0x00 0x00 0x00 (3 bytes)
private let fileMagic: [UInt8] = [0x50, 0x53, 0x53, 0x56]  // "PSSV"
private let fileFormatVersion: UInt8 = 0x01
private let fileHeaderSize = 8  // magic(4) + version(1) + reserved(3)

// MARK: - Writer

/// Encrypt + serialize, atomically write to `path` (.tmp → fsync → rename).
public func writeCacheFile(
  data: CacheData,
  vaultKey: SymmetricKey,
  hostInstallUUID: Data,
  path: URL
) throws {
  // Encode header as JSON
  let encoder = makeDateEncoder()
  let headerJSON = try encodeCacheHeaderJSON(data.header)
  let headerAAD = try buildCacheHeaderAAD(
    counter: data.header.cacheVersionCounter,
    hostInstallUUID: hostInstallUUID
  )

  // Encrypt header
  let (hdrCipher, hdrIV, hdrTag) = try encryptAESGCM(
    plaintext: headerJSON,
    key: vaultKey,
    aad: headerAAD
  )
  // Encrypted header blob = IV(12) || ciphertext || tag(16)
  var encryptedHeader = Data(capacity: 12 + hdrCipher.count + 16)
  encryptedHeader.append(hdrIV)
  encryptedHeader.append(hdrCipher)
  encryptedHeader.append(hdrTag)

  // Encrypt entries with AAD bound to (counter, uuid, userId).
  // Without this binding, an attacker with App Group write access could
  // splice old `entries` bytes onto a fresh header — both ciphertexts
  // would decrypt cleanly under the same vault key and `entryCount` is
  // attacker-controlled. AAD over identity fields blocks the splice.
  let entriesAAD = try buildCacheEntriesAAD(
    counter: data.header.cacheVersionCounter,
    hostInstallUUID: hostInstallUUID,
    userId: data.header.userId
  )
  let (entCipher, entIV, entTag) = try encryptAESGCM(
    plaintext: data.entries,
    key: vaultKey,
    aad: entriesAAD
  )
  var encryptedEntries = Data(capacity: 12 + entCipher.count + 16)
  encryptedEntries.append(entIV)
  encryptedEntries.append(entCipher)
  encryptedEntries.append(entTag)

  // Serialize file
  var fileData = Data()
  fileData.append(contentsOf: fileMagic)
  fileData.append(fileFormatVersion)
  fileData.append(contentsOf: [0x00, 0x00, 0x00])  // reserved
  appendBEUInt32(&fileData, UInt32(encryptedHeader.count))
  fileData.append(encryptedHeader)
  appendBEUInt32(&fileData, UInt32(encryptedEntries.count))
  fileData.append(encryptedEntries)

  // Atomic write: write to .tmp → (options: .atomic already fsyncs) → rename
  let tmpURL = path.deletingLastPathComponent()
    .appending(path: path.lastPathComponent + ".tmp", directoryHint: .notDirectory)
  do {
    try fileData.write(to: tmpURL, options: .atomic)
    _ = try FileManager.default.replaceItemAt(path, withItemAt: tmpURL)
  } catch {
    throw EntryCacheError.ioError(error.localizedDescription)
  }

  _ = encoder  // suppress unused warning
}

// MARK: - Reader

/// Read + decrypt + verify. Throws `.rejection(.<kind>)` on any integrity failure.
public func readCacheFile(
  path: URL,
  vaultKey: SymmetricKey,
  expectedHostInstallUUID: Data,
  expectedCounter: UInt64,
  now: Date = Date()
) throws -> CacheData {
  let fileData: Data
  do {
    fileData = try Data(contentsOf: path)
  } catch {
    throw EntryCacheError.rejection(.headerMissing, .unavailable)
  }

  // Minimum viable file: magic(4) + version(1) + reserved(3) + hdrLen(4) = 12 bytes
  guard fileData.count >= 12 else {
    throw EntryCacheError.rejection(.headerMissing, .unavailable)
  }

  // Validate magic + version
  guard
    fileData[0] == fileMagic[0],
    fileData[1] == fileMagic[1],
    fileData[2] == fileMagic[2],
    fileData[3] == fileMagic[3],
    fileData[4] == fileFormatVersion
  else {
    throw EntryCacheError.rejection(.headerInvalid, .unavailable)
  }

  var offset = fileHeaderSize

  // Parse encrypted header length
  guard fileData.count >= offset + 4 else {
    throw EntryCacheError.rejection(.headerInvalid, .unavailable)
  }
  let headerLen = Int(readBEUInt32(fileData, at: offset))
  offset += 4

  guard fileData.count >= offset + headerLen else {
    throw EntryCacheError.rejection(.headerInvalid, .unavailable)
  }
  let encryptedHeaderBlob = fileData[offset..<(offset + headerLen)]
  offset += headerLen

  // Parse encrypted entries length
  guard fileData.count >= offset + 4 else {
    throw EntryCacheError.rejection(.headerInvalid, .unavailable)
  }
  let entriesLen = Int(readBEUInt32(fileData, at: offset))
  offset += 4

  guard fileData.count >= offset + entriesLen else {
    throw EntryCacheError.rejection(.headerInvalid, .unavailable)
  }
  let encryptedEntriesBlob = fileData[offset..<(offset + entriesLen)]

  // Decrypt header — need the counter from AAD, but we don't know it yet.
  // Try decrypting with expectedCounter first to get the header.
  // If AAD fails, check if different counter (for recovery path detection).
  let header = try decryptAndParseHeader(
    blob: Data(encryptedHeaderBlob),
    vaultKey: vaultKey,
    expectedHostInstallUUID: expectedHostInstallUUID,
    expectedCounter: expectedCounter
  )

  // Header decrypted — rejections from here on can report its actual values.
  let headerContext = CacheRejectionContext(
    observedCounter: header.cacheVersionCounter,
    headerIssuedAt: header.cacheIssuedAt,
    lastSuccessfulRefreshAt: header.lastSuccessfulRefreshAt
  )

  // Validate counter
  guard header.cacheVersionCounter == expectedCounter else {
    throw EntryCacheError.rejection(.counterMismatch, headerContext)
  }

  // Validate clock skew: cacheIssuedAt > now + 30s
  if header.cacheIssuedAt > now.addingTimeInterval(30) {
    throw EntryCacheError.rejection(.headerClockSkew, headerContext)
  }

  // Validate staleness: issuedAt > 1h old AND lastSuccessfulRefreshAt > 24h old
  let oneHourAgo = now.addingTimeInterval(-3600)
  let twentyFourHoursAgo = now.addingTimeInterval(-86400)
  if header.cacheIssuedAt < oneHourAgo && header.lastSuccessfulRefreshAt < twentyFourHoursAgo {
    throw EntryCacheError.rejection(.headerStale, headerContext)
  }

  // Decrypt entries with AAD reconstructed from the (now-trusted) header.
  // The helpers throw with .unavailable (they cannot see the header); re-attach
  // headerContext here so an entries-blob rejection still reports the observed
  // header values in the rollback flag.
  let entriesData: Data
  let entryCount: Int
  do {
    let entriesAAD = try buildCacheEntriesAAD(
      counter: header.cacheVersionCounter,
      hostInstallUUID: header.hostInstallUUID,
      userId: header.userId
    )
    entriesData = try decryptEntriesBlob(
      Data(encryptedEntriesBlob),
      vaultKey: vaultKey,
      aad: entriesAAD
    )
    entryCount = try countJSONArrayElements(entriesData)
  } catch EntryCacheError.rejection(let kind, _) {
    throw EntryCacheError.rejection(kind, headerContext)
  }

  // Validate entry count
  guard entryCount == Int(header.entryCount) else {
    throw EntryCacheError.rejection(.entryCountMismatch, headerContext)
  }

  return CacheData(header: header, entries: entriesData)
}

// MARK: - Private helpers

private func buildCacheHeaderAAD(counter: UInt64, hostInstallUUID: Data) throws -> Data {
  // Header AAD layout (byte-identical to host-app and AutoFill ext):
  //   "CACHEHDR" (8 ASCII) || counter (BE 8) || hostInstallUUID (16 raw)
  var aad = Data(capacity: 32)
  aad.append(contentsOf: Array("CACHEHDR".utf8))
  let counterBE = counter.bigEndian
  withUnsafeBytes(of: counterBE) { aad.append(contentsOf: $0) }
  aad.append(hostInstallUUID)
  return aad
}

/// Entries-blob AAD = "CACHEENT" || counter(BE 8) || uuid(16)
///                  || userIdLen(BE 2) || userId(UTF-8)
///
/// Internal (not private) so test targets can call it via
/// `@testable import Shared` to construct splice-test fixtures.
internal func buildCacheEntriesAAD(
  counter: UInt64,
  hostInstallUUID: Data,
  userId: String
) throws -> Data {
  let userIdBytes = Array(userId.utf8)
  guard userIdBytes.count <= 0xFFFF else {
    throw EntryCacheError.rejection(.headerInvalid, .unavailable)
  }
  var aad = Data(capacity: 8 + 8 + 16 + 2 + userIdBytes.count)
  aad.append(contentsOf: Array("CACHEENT".utf8))
  let counterBE = counter.bigEndian
  withUnsafeBytes(of: counterBE) { aad.append(contentsOf: $0) }
  aad.append(hostInstallUUID)
  let userIdLen = UInt16(userIdBytes.count).bigEndian
  withUnsafeBytes(of: userIdLen) { aad.append(contentsOf: $0) }
  aad.append(contentsOf: userIdBytes)
  return aad
}

private func encodeCacheHeaderJSON(_ header: CacheHeader) throws -> Data {
  // JSON-encode using unix epoch seconds for dates
  let dict: [String: Any] = [
    "cacheVersionCounter": header.cacheVersionCounter,
    "cacheIssuedAt": Int(header.cacheIssuedAt.timeIntervalSince1970),
    "lastSuccessfulRefreshAt": Int(header.lastSuccessfulRefreshAt.timeIntervalSince1970),
    "entryCount": header.entryCount,
    "hostInstallUUID": hexEncode(header.hostInstallUUID),
    "userId": header.userId,
  ]
  return try JSONSerialization.data(withJSONObject: dict)
}

private func decryptAndParseHeader(
  blob: Data,
  vaultKey: SymmetricKey,
  expectedHostInstallUUID: Data,
  expectedCounter: UInt64
) throws -> CacheHeader {
  // Blob = IV(12) || ciphertext || tag(16)
  guard blob.count >= 12 + 16 else {
    throw EntryCacheError.rejection(.headerInvalid, .unavailable)
  }
  let iv = Data(blob[0..<12])
  let tag = Data(blob[(blob.count - 16)...])
  let ciphertext = Data(blob[12..<(blob.count - 16)])

  // Build AAD with expectedCounter to attempt decryption
  let aad = try buildCacheHeaderAAD(counter: expectedCounter, hostInstallUUID: expectedHostInstallUUID)

  let plaintext: Data
  do {
    plaintext = try decryptAESGCM(
      ciphertext: ciphertext,
      iv: iv,
      tag: tag,
      key: vaultKey,
      aad: aad
    )
  } catch {
    // Auth failure — could be AAD mismatch or tag invalid.
    // Try with a different UUID to distinguish.
    throw EntryCacheError.rejection(.authtagInvalid, .unavailable)
  }

  return try parseHeaderJSON(plaintext)
}

private func parseHeaderJSON(_ data: Data) throws -> CacheHeader {
  guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw EntryCacheError.rejection(.headerInvalid, .unavailable)
  }
  guard
    let counter = obj["cacheVersionCounter"] as? UInt64 ??
      (obj["cacheVersionCounter"] as? Int).map({ UInt64($0) }),
    let issuedAtInt = obj["cacheIssuedAt"] as? Int,
    let refreshAtInt = obj["lastSuccessfulRefreshAt"] as? Int,
    let entryCountAny = obj["entryCount"],
    let uuidHex = obj["hostInstallUUID"] as? String,
    let userId = obj["userId"] as? String
  else {
    throw EntryCacheError.rejection(.headerInvalid, .unavailable)
  }

  let entryCount: UInt32
  if let ec = entryCountAny as? UInt32 {
    entryCount = ec
  } else if let ec = entryCountAny as? Int {
    entryCount = UInt32(ec)
  } else {
    throw EntryCacheError.rejection(.headerInvalid, .unavailable)
  }

  let uuidData: Data
  do {
    uuidData = try hexDecode(uuidHex)
  } catch {
    throw EntryCacheError.rejection(.headerInvalid, .unavailable)
  }

  return CacheHeader(
    cacheVersionCounter: counter,
    cacheIssuedAt: Date(timeIntervalSince1970: TimeInterval(issuedAtInt)),
    lastSuccessfulRefreshAt: Date(timeIntervalSince1970: TimeInterval(refreshAtInt)),
    entryCount: entryCount,
    hostInstallUUID: uuidData,
    userId: userId
  )
}

private func decryptEntriesBlob(_ blob: Data, vaultKey: SymmetricKey, aad: Data) throws -> Data {
  // Blob = IV(12) || ciphertext || tag(16)
  guard blob.count >= 12 + 16 else {
    throw EntryCacheError.rejection(.headerInvalid, .unavailable)
  }
  let iv = Data(blob[0..<12])
  let tag = Data(blob[(blob.count - 16)...])
  let ciphertext = Data(blob[12..<(blob.count - 16)])

  do {
    return try decryptAESGCM(ciphertext: ciphertext, iv: iv, tag: tag, key: vaultKey, aad: aad)
  } catch {
    throw EntryCacheError.rejection(.authtagInvalid, .unavailable)
  }
}

private func countJSONArrayElements(_ data: Data) throws -> Int {
  guard let array = try? JSONSerialization.jsonObject(with: data) as? [Any] else {
    throw EntryCacheError.rejection(.entryCountMismatch, .unavailable)
  }
  return array.count
}

private func appendBEUInt32(_ data: inout Data, _ value: UInt32) {
  let be = value.bigEndian
  withUnsafeBytes(of: be) { data.append(contentsOf: $0) }
}

private func readBEUInt32(_ data: Data, at offset: Int) -> UInt32 {
  let slice = data[offset..<(offset + 4)]
  // Use loadUnaligned to avoid SIGBUS on non-4-byte-aligned Data slices.
  return slice.withUnsafeBytes { UInt32(bigEndian: $0.loadUnaligned(as: UInt32.self)) }
}

private func makeDateEncoder() -> JSONEncoder {
  let enc = JSONEncoder()
  enc.dateEncodingStrategy = .secondsSince1970
  return enc
}
