import CryptoKit
import Foundation

// MARK: - Public types

public struct CacheHeader: Codable, Sendable, Equatable {
  public let cacheVersionCounter: UInt64
  public let cacheIssuedAt: Date
  public let lastSuccessfulRefreshAt: Date
  public let entryCount: UInt32
  public let hostInstallUUID: Data  // 16 bytes

  public init(
    cacheVersionCounter: UInt64,
    cacheIssuedAt: Date,
    lastSuccessfulRefreshAt: Date,
    entryCount: UInt32,
    hostInstallUUID: Data
  ) {
    self.cacheVersionCounter = cacheVersionCounter
    self.cacheIssuedAt = cacheIssuedAt
    self.lastSuccessfulRefreshAt = lastSuccessfulRefreshAt
    self.entryCount = entryCount
    self.hostInstallUUID = hostInstallUUID
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

public enum EntryCacheError: Error, Equatable {
  case rejection(CacheRejectionKind)
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

  // Encrypt entries
  let (entCipher, entIV, entTag) = try encryptAESGCM(
    plaintext: data.entries,
    key: vaultKey
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
    throw EntryCacheError.rejection(.headerMissing)
  }

  // Minimum viable file: magic(4) + version(1) + reserved(3) + hdrLen(4) = 12 bytes
  guard fileData.count >= 12 else {
    throw EntryCacheError.rejection(.headerMissing)
  }

  // Validate magic + version
  guard
    fileData[0] == fileMagic[0],
    fileData[1] == fileMagic[1],
    fileData[2] == fileMagic[2],
    fileData[3] == fileMagic[3],
    fileData[4] == fileFormatVersion
  else {
    throw EntryCacheError.rejection(.headerInvalid)
  }

  var offset = fileHeaderSize

  // Parse encrypted header length
  guard fileData.count >= offset + 4 else {
    throw EntryCacheError.rejection(.headerInvalid)
  }
  let headerLen = Int(readBEUInt32(fileData, at: offset))
  offset += 4

  guard fileData.count >= offset + headerLen else {
    throw EntryCacheError.rejection(.headerInvalid)
  }
  let encryptedHeaderBlob = fileData[offset..<(offset + headerLen)]
  offset += headerLen

  // Parse encrypted entries length
  guard fileData.count >= offset + 4 else {
    throw EntryCacheError.rejection(.headerInvalid)
  }
  let entriesLen = Int(readBEUInt32(fileData, at: offset))
  offset += 4

  guard fileData.count >= offset + entriesLen else {
    throw EntryCacheError.rejection(.headerInvalid)
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

  // Validate counter
  guard header.cacheVersionCounter == expectedCounter else {
    throw EntryCacheError.rejection(.counterMismatch)
  }

  // Validate clock skew: cacheIssuedAt > now + 30s
  if header.cacheIssuedAt > now.addingTimeInterval(30) {
    throw EntryCacheError.rejection(.headerClockSkew)
  }

  // Validate staleness: issuedAt > 1h old AND lastSuccessfulRefreshAt > 24h old
  let oneHourAgo = now.addingTimeInterval(-3600)
  let twentyFourHoursAgo = now.addingTimeInterval(-86400)
  if header.cacheIssuedAt < oneHourAgo && header.lastSuccessfulRefreshAt < twentyFourHoursAgo {
    throw EntryCacheError.rejection(.headerStale)
  }

  // Decrypt entries (no AAD on entries blob)
  let entriesData = try decryptEntriesBlob(Data(encryptedEntriesBlob), vaultKey: vaultKey)

  // Validate entry count
  let entryCount = try countJSONArrayElements(entriesData)
  guard entryCount == Int(header.entryCount) else {
    throw EntryCacheError.rejection(.entryCountMismatch)
  }

  return CacheData(header: header, entries: entriesData)
}

// MARK: - Private helpers

private func buildCacheHeaderAAD(counter: UInt64, hostInstallUUID: Data) throws -> Data {
  // Per plan §"Encrypted-entries cache integrity":
  // AAD = "CACHEHDR" (8 ASCII bytes) || counter (BE 8 bytes) || hostInstallUUID (16 raw bytes)
  var aad = Data(capacity: 32)
  aad.append(contentsOf: Array("CACHEHDR".utf8))
  let counterBE = counter.bigEndian
  withUnsafeBytes(of: counterBE) { aad.append(contentsOf: $0) }
  aad.append(hostInstallUUID)
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
    throw EntryCacheError.rejection(.headerInvalid)
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
    throw EntryCacheError.rejection(.authtagInvalid)
  }

  return try parseHeaderJSON(plaintext)
}

private func parseHeaderJSON(_ data: Data) throws -> CacheHeader {
  guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw EntryCacheError.rejection(.headerInvalid)
  }
  guard
    let counter = obj["cacheVersionCounter"] as? UInt64 ??
      (obj["cacheVersionCounter"] as? Int).map({ UInt64($0) }),
    let issuedAtInt = obj["cacheIssuedAt"] as? Int,
    let refreshAtInt = obj["lastSuccessfulRefreshAt"] as? Int,
    let entryCountAny = obj["entryCount"],
    let uuidHex = obj["hostInstallUUID"] as? String
  else {
    throw EntryCacheError.rejection(.headerInvalid)
  }

  let entryCount: UInt32
  if let ec = entryCountAny as? UInt32 {
    entryCount = ec
  } else if let ec = entryCountAny as? Int {
    entryCount = UInt32(ec)
  } else {
    throw EntryCacheError.rejection(.headerInvalid)
  }

  let uuidData: Data
  do {
    uuidData = try hexDecode(uuidHex)
  } catch {
    throw EntryCacheError.rejection(.headerInvalid)
  }

  return CacheHeader(
    cacheVersionCounter: counter,
    cacheIssuedAt: Date(timeIntervalSince1970: TimeInterval(issuedAtInt)),
    lastSuccessfulRefreshAt: Date(timeIntervalSince1970: TimeInterval(refreshAtInt)),
    entryCount: entryCount,
    hostInstallUUID: uuidData
  )
}

private func decryptEntriesBlob(_ blob: Data, vaultKey: SymmetricKey) throws -> Data {
  // Blob = IV(12) || ciphertext || tag(16)
  guard blob.count >= 12 + 16 else {
    throw EntryCacheError.rejection(.headerInvalid)
  }
  let iv = Data(blob[0..<12])
  let tag = Data(blob[(blob.count - 16)...])
  let ciphertext = Data(blob[12..<(blob.count - 16)])

  do {
    return try decryptAESGCM(ciphertext: ciphertext, iv: iv, tag: tag, key: vaultKey)
  } catch {
    throw EntryCacheError.rejection(.authtagInvalid)
  }
}

private func countJSONArrayElements(_ data: Data) throws -> Int {
  guard let array = try? JSONSerialization.jsonObject(with: data) as? [Any] else {
    throw EntryCacheError.rejection(.entryCountMismatch)
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
