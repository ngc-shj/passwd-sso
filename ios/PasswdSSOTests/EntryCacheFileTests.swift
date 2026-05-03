import CryptoKit
import Foundation
import XCTest
@testable import Shared

final class EntryCacheFileTests: XCTestCase {

  // MARK: - Fixtures

  private let vaultKey = SymmetricKey(size: .bits256)
  private let hostInstallUUID = Data(repeating: 0xAB, count: 16)
  private let counter: UInt64 = 12345

  private func makeHeader(
    counter: UInt64? = nil,
    issuedAt: Date? = nil,
    refreshAt: Date? = nil,
    entryCount: UInt32 = 0,
    uuid: Data? = nil,
    userId: String = "test-user-id"
  ) -> CacheHeader {
    CacheHeader(
      cacheVersionCounter: counter ?? self.counter,
      cacheIssuedAt: issuedAt ?? Date(),
      lastSuccessfulRefreshAt: refreshAt ?? Date(),
      entryCount: entryCount,
      hostInstallUUID: uuid ?? hostInstallUUID,
      userId: userId
    )
  }

  private func tmpURL(suffix: String = "") -> URL {
    URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(
        path: "test-cache-\(UUID().uuidString)\(suffix).bin",
        directoryHint: .notDirectory
      )
  }

  private func makeEntriesJSON(count: Int) -> Data {
    let arr = (0..<count).map { i in #"{"id":"\#(i)"}"# }
    return "[\(arr.joined(separator: ","))]".data(using: .utf8)!
  }

  // MARK: - Round-trip tests

  func testRoundTripZeroEntries() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    let header = makeHeader(entryCount: 0)
    let data = CacheData(header: header, entries: makeEntriesJSON(count: 0))
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    let read = try readCacheFile(
      path: url,
      vaultKey: vaultKey,
      expectedHostInstallUUID: hostInstallUUID,
      expectedCounter: counter
    )
    XCTAssertEqual(read.header.cacheVersionCounter, counter)
    XCTAssertEqual(read.header.entryCount, 0)
    XCTAssertEqual(read.entries, makeEntriesJSON(count: 0))
  }

  func testRoundTripOneEntry() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    let header = makeHeader(entryCount: 1)
    let entriesJSON = makeEntriesJSON(count: 1)
    let data = CacheData(header: header, entries: entriesJSON)
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    let read = try readCacheFile(
      path: url,
      vaultKey: vaultKey,
      expectedHostInstallUUID: hostInstallUUID,
      expectedCounter: counter
    )
    XCTAssertEqual(read.header.entryCount, 1)
  }

  func testRoundTrip100Entries() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    let header = makeHeader(entryCount: 100)
    let entriesJSON = makeEntriesJSON(count: 100)
    let data = CacheData(header: header, entries: entriesJSON)
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    let read = try readCacheFile(
      path: url,
      vaultKey: vaultKey,
      expectedHostInstallUUID: hostInstallUUID,
      expectedCounter: counter
    )
    XCTAssertEqual(read.header.entryCount, 100)
  }

  // MARK: - Rejection tests

  func testRejectsTamperedAuthTag() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    let header = makeHeader(entryCount: 0)
    let data = CacheData(header: header, entries: makeEntriesJSON(count: 0))
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    // Flip a byte in the middle of the file (inside ciphertext / tag area)
    var fileBytes = try Data(contentsOf: url)
    let midpoint = fileBytes.count / 2
    fileBytes[midpoint] ^= 0xFF
    try fileBytes.write(to: url)

    XCTAssertThrowsError(
      try readCacheFile(
        path: url,
        vaultKey: vaultKey,
        expectedHostInstallUUID: hostInstallUUID,
        expectedCounter: counter
      )
    ) { error in
      guard case EntryCacheError.rejection(let kind) = error else {
        XCTFail("Expected rejection, got \(error)")
        return
      }
      // Either authtagInvalid or headerInvalid depending on which byte was flipped
      XCTAssertTrue(
        kind == .authtagInvalid || kind == .headerInvalid,
        "Expected authtagInvalid or headerInvalid, got \(kind)"
      )
    }
  }

  func testRejectsWrongHostInstallUUID() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    let header = makeHeader(entryCount: 0)
    let data = CacheData(header: header, entries: makeEntriesJSON(count: 0))
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    let wrongUUID = Data(repeating: 0xCC, count: 16)
    XCTAssertThrowsError(
      try readCacheFile(
        path: url,
        vaultKey: vaultKey,
        expectedHostInstallUUID: wrongUUID,
        expectedCounter: counter
      )
    ) { error in
      if case EntryCacheError.rejection(let kind) = error {
        XCTAssertEqual(kind, .authtagInvalid)
      } else {
        XCTFail("Expected rejection(aadMismatch or authtagInvalid), got \(error)")
      }
    }
  }

  func testRejectsCounterMismatch() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    let header = makeHeader(counter: 100, entryCount: 0)
    let data = CacheData(header: header, entries: makeEntriesJSON(count: 0))
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    // Read with wrong expectedCounter
    XCTAssertThrowsError(
      try readCacheFile(
        path: url,
        vaultKey: vaultKey,
        expectedHostInstallUUID: hostInstallUUID,
        expectedCounter: 99  // wrong
      )
    ) { error in
      if case EntryCacheError.rejection(let kind) = error {
        // authtagInvalid because AAD includes counter
        XCTAssertEqual(kind, .authtagInvalid)
      } else {
        XCTFail("Expected rejection, got \(error)")
      }
    }
  }

  func testRejectsHeaderClockSkew() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    // issuedAt is in the future (> now + 30s)
    let futureDate = Date().addingTimeInterval(120)
    let header = makeHeader(issuedAt: futureDate, entryCount: 0)
    let data = CacheData(header: header, entries: makeEntriesJSON(count: 0))
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    XCTAssertThrowsError(
      try readCacheFile(
        path: url,
        vaultKey: vaultKey,
        expectedHostInstallUUID: hostInstallUUID,
        expectedCounter: counter,
        now: Date()
      )
    ) { error in
      if case EntryCacheError.rejection(let kind) = error {
        XCTAssertEqual(kind, .headerClockSkew)
      } else {
        XCTFail("Expected .headerClockSkew, got \(error)")
      }
    }
  }

  func testRejectsHeaderStale() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    // Both issuedAt and lastSuccessfulRefreshAt are very old
    let veryOld = Date(timeIntervalSince1970: 0)
    let header = makeHeader(issuedAt: veryOld, refreshAt: veryOld, entryCount: 0)
    let data = CacheData(header: header, entries: makeEntriesJSON(count: 0))
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    XCTAssertThrowsError(
      try readCacheFile(
        path: url,
        vaultKey: vaultKey,
        expectedHostInstallUUID: hostInstallUUID,
        expectedCounter: counter,
        now: Date()
      )
    ) { error in
      if case EntryCacheError.rejection(let kind) = error {
        XCTAssertEqual(kind, .headerStale)
      } else {
        XCTFail("Expected .headerStale, got \(error)")
      }
    }
  }

  func testRejectsEntryCountMismatch() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    // Header says 5 entries but we only put 3 in the JSON
    let header = makeHeader(entryCount: 5)
    let data = CacheData(header: header, entries: makeEntriesJSON(count: 3))
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    XCTAssertThrowsError(
      try readCacheFile(
        path: url,
        vaultKey: vaultKey,
        expectedHostInstallUUID: hostInstallUUID,
        expectedCounter: counter
      )
    ) { error in
      if case EntryCacheError.rejection(let kind) = error {
        XCTAssertEqual(kind, .entryCountMismatch)
      } else {
        XCTFail("Expected .entryCountMismatch, got \(error)")
      }
    }
  }

  func testRejectsMagicBytesWrong() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    // Write a valid file then corrupt the magic bytes
    let header = makeHeader(entryCount: 0)
    let data = CacheData(header: header, entries: makeEntriesJSON(count: 0))
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    var fileBytes = try Data(contentsOf: url)
    // Corrupt first 4 bytes (magic)
    fileBytes[0] = 0xFF
    fileBytes[1] = 0xFF
    fileBytes[2] = 0xFF
    fileBytes[3] = 0xFF
    try fileBytes.write(to: url)

    XCTAssertThrowsError(
      try readCacheFile(
        path: url,
        vaultKey: vaultKey,
        expectedHostInstallUUID: hostInstallUUID,
        expectedCounter: counter
      )
    ) { error in
      if case EntryCacheError.rejection(let kind) = error {
        XCTAssertEqual(kind, .headerInvalid)
      } else {
        XCTFail("Expected .headerInvalid, got \(error)")
      }
    }
  }

  func testRejectsFileTooShort() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    // Write 8 bytes (less than minimum 12)
    let shortData = Data(repeating: 0x50, count: 8)
    try shortData.write(to: url)

    XCTAssertThrowsError(
      try readCacheFile(
        path: url,
        vaultKey: vaultKey,
        expectedHostInstallUUID: hostInstallUUID,
        expectedCounter: counter
      )
    ) { error in
      if case EntryCacheError.rejection(let kind) = error {
        XCTAssertTrue(
          kind == .headerMissing || kind == .headerInvalid,
          "Expected headerMissing or headerInvalid, got \(kind)"
        )
      } else {
        XCTFail("Expected rejection, got \(error)")
      }
    }
  }

  func testRejectsNonExistentFile() throws {
    let url = URL(fileURLWithPath: "/tmp/nonexistent-\(UUID().uuidString).cache")

    XCTAssertThrowsError(
      try readCacheFile(
        path: url,
        vaultKey: vaultKey,
        expectedHostInstallUUID: hostInstallUUID,
        expectedCounter: counter
      )
    ) { error in
      if case EntryCacheError.rejection(let kind) = error {
        XCTAssertEqual(kind, .headerMissing)
      } else {
        XCTFail("Expected .headerMissing, got \(error)")
      }
    }
  }

  // MARK: - Atomic write: .tmp file should not be read as fallback

  func testTmpFileNotReadAsFallback() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    let tmpURL = url.deletingLastPathComponent()
      .appending(path: url.lastPathComponent + ".tmp", directoryHint: .notDirectory)
    defer { try? FileManager.default.removeItem(at: tmpURL) }

    // Simulate a partial write to .tmp — the real path does not exist
    try "partial".data(using: .utf8)!.write(to: tmpURL)

    // Reader should see headerMissing, not use .tmp
    XCTAssertThrowsError(
      try readCacheFile(
        path: url,
        vaultKey: vaultKey,
        expectedHostInstallUUID: hostInstallUUID,
        expectedCounter: counter
      )
    ) { error in
      if case EntryCacheError.rejection(let kind) = error {
        XCTAssertEqual(kind, .headerMissing)
      } else {
        XCTFail("Expected .headerMissing (not using .tmp), got \(error)")
      }
    }
  }

  // MARK: - userId round-trip

  func testHeaderUserIdRoundTrip() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    let header = makeHeader(entryCount: 0, userId: "user-42")
    let data = CacheData(header: header, entries: makeEntriesJSON(count: 0))
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    let read = try readCacheFile(
      path: url,
      vaultKey: vaultKey,
      expectedHostInstallUUID: hostInstallUUID,
      expectedCounter: counter
    )
    XCTAssertEqual(read.header.userId, "user-42")
  }

  func testHeaderMissingUserIdRejectsAsHeaderInvalid() throws {
    // NOTE: this test passes because parseHeaderJSON throws .headerInvalid
    // BEFORE the entries-decrypt step is reached. The entries blob below
    // is intentionally encrypted WITHOUT entries-AAD (legacy format). If
    // the read-order in readCacheFile is ever reordered (entries before
    // header), this test must be rewritten to encrypt the entries blob
    // with a real entries-AAD; otherwise the rejection would come from
    // entries-AAD mismatch, not header-JSON validation.
    // Build a header JSON that omits "userId" and inject it into an encrypted blob,
    // then verify the reader rejects with .headerInvalid.
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    // Build a valid file first, then patch the encrypted header bytes to remove userId.
    // Easier: build the JSON manually, encrypt, and assemble a file from scratch.
    let headerJSON = """
      {
        "cacheVersionCounter": \(counter),
        "cacheIssuedAt": \(Int(Date().timeIntervalSince1970)),
        "lastSuccessfulRefreshAt": \(Int(Date().timeIntervalSince1970)),
        "entryCount": 0,
        "hostInstallUUID": "\(hexEncode(hostInstallUUID))"
      }
      """.data(using: .utf8)!

    // Build header AAD matching what writeCacheFile uses
    var aad = Data(capacity: 32)
    aad.append(contentsOf: Array("CACHEHDR".utf8))
    let counterBE = counter.bigEndian
    withUnsafeBytes(of: counterBE) { aad.append(contentsOf: $0) }
    aad.append(hostInstallUUID)

    let (hdrCipher, hdrIV, hdrTag) = try encryptAESGCM(
      plaintext: headerJSON, key: vaultKey, aad: aad
    )
    var encryptedHeader = Data()
    encryptedHeader.append(hdrIV)
    encryptedHeader.append(hdrCipher)
    encryptedHeader.append(hdrTag)

    // Entries blob (empty array)
    let entriesJSON = makeEntriesJSON(count: 0)
    let (entCipher, entIV, entTag) = try encryptAESGCM(plaintext: entriesJSON, key: vaultKey)
    var encryptedEntries = Data()
    encryptedEntries.append(entIV)
    encryptedEntries.append(entCipher)
    encryptedEntries.append(entTag)

    // Assemble file
    var fileData = Data()
    fileData.append(contentsOf: [0x50, 0x53, 0x53, 0x56])  // "PSSV"
    fileData.append(0x01)  // version
    fileData.append(contentsOf: [0x00, 0x00, 0x00])  // reserved

    func appendBE32(_ d: inout Data, _ v: UInt32) {
      let be = v.bigEndian; withUnsafeBytes(of: be) { d.append(contentsOf: $0) }
    }
    appendBE32(&fileData, UInt32(encryptedHeader.count))
    fileData.append(encryptedHeader)
    appendBE32(&fileData, UInt32(encryptedEntries.count))
    fileData.append(encryptedEntries)

    try fileData.write(to: url)

    XCTAssertThrowsError(
      try readCacheFile(
        path: url,
        vaultKey: vaultKey,
        expectedHostInstallUUID: hostInstallUUID,
        expectedCounter: counter
      )
    ) { error in
      if case EntryCacheError.rejection(let kind) = error {
        XCTAssertEqual(kind, .headerInvalid, "Missing userId should produce headerInvalid")
      } else {
        XCTFail("Expected rejection(.headerInvalid), got \(error)")
      }
    }
  }

  // MARK: - Entries-blob AAD binding

  /// Helper: parse a written cache file into (encryptedHeaderBlob, encryptedEntriesBlob).
  /// Mirrors the reader's framing parse to enable splice-style negative tests.
  private func parseFile(_ data: Data) -> (header: Data, entries: Data)? {
    guard data.count >= 12 else { return nil }
    var off = 8
    let headerLen = Int(UInt32(bigEndian: data[off..<(off + 4)]
      .withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }))
    off += 4
    let header = data[off..<(off + headerLen)]
    off += headerLen
    let entriesLen = Int(UInt32(bigEndian: data[off..<(off + 4)]
      .withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }))
    off += 4
    let entries = data[off..<(off + entriesLen)]
    return (Data(header), Data(entries))
  }

  /// Reassemble a file from (encryptedHeaderBlob, encryptedEntriesBlob).
  private func assembleFile(header: Data, entries: Data) -> Data {
    var out = Data()
    out.append(contentsOf: [0x50, 0x53, 0x53, 0x56])  // "PSSV"
    out.append(0x01)
    out.append(contentsOf: [0x00, 0x00, 0x00])

    func appendBE32(_ d: inout Data, _ v: UInt32) {
      let be = v.bigEndian
      withUnsafeBytes(of: be) { d.append(contentsOf: $0) }
    }
    appendBE32(&out, UInt32(header.count))
    out.append(header)
    appendBE32(&out, UInt32(entries.count))
    out.append(entries)
    return out
  }

  /// Splicing entries from a different counter must fail entries-AAD verification.
  func testEntriesBlobBindToCounterRejectsCrossFileSwap() throws {
    let urlA = tmpURL()
    let urlB = tmpURL()
    defer {
      try? FileManager.default.removeItem(at: urlA)
      try? FileManager.default.removeItem(at: urlB)
    }

    let headerA = makeHeader(counter: 10, entryCount: 1)
    try writeCacheFile(
      data: CacheData(header: headerA, entries: makeEntriesJSON(count: 1)),
      vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: urlA
    )

    let headerB = makeHeader(counter: 11, entryCount: 1)
    try writeCacheFile(
      data: CacheData(header: headerB, entries: makeEntriesJSON(count: 1)),
      vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: urlB
    )

    let aBytes = try Data(contentsOf: urlA)
    let bBytes = try Data(contentsOf: urlB)
    let aParts = parseFile(aBytes)!
    let bParts = parseFile(bBytes)!

    // Frankenstein: B's header (counter=11) + A's entries (encrypted with counter=10 AAD)
    let frankenstein = assembleFile(header: bParts.header, entries: aParts.entries)
    let urlC = tmpURL()
    defer { try? FileManager.default.removeItem(at: urlC) }
    try frankenstein.write(to: urlC)

    XCTAssertThrowsError(
      try readCacheFile(
        path: urlC,
        vaultKey: vaultKey,
        expectedHostInstallUUID: hostInstallUUID,
        expectedCounter: 11
      )
    ) { error in
      guard case EntryCacheError.rejection(let kind) = error else {
        XCTFail("Expected rejection, got \(error)")
        return
      }
      XCTAssertEqual(kind, .authtagInvalid,
                     "Cross-counter splice should fail entries AAD with .authtagInvalid")
    }
  }

  /// Splicing entries from a different userId must fail entries-AAD verification.
  func testEntriesBlobBindToUserIdRejectsCrossUserSwap() throws {
    let urlA = tmpURL()
    let urlB = tmpURL()
    defer {
      try? FileManager.default.removeItem(at: urlA)
      try? FileManager.default.removeItem(at: urlB)
    }

    let headerA = makeHeader(entryCount: 1, userId: "user-A")
    try writeCacheFile(
      data: CacheData(header: headerA, entries: makeEntriesJSON(count: 1)),
      vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: urlA
    )

    let headerB = makeHeader(entryCount: 1, userId: "user-B")
    try writeCacheFile(
      data: CacheData(header: headerB, entries: makeEntriesJSON(count: 1)),
      vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: urlB
    )

    let aBytes = try Data(contentsOf: urlA)
    let bBytes = try Data(contentsOf: urlB)
    let aParts = parseFile(aBytes)!
    let bParts = parseFile(bBytes)!

    // Frankenstein: B's header (userId=user-B) + A's entries (encrypted with userId=user-A AAD)
    let frankenstein = assembleFile(header: bParts.header, entries: aParts.entries)
    let urlC = tmpURL()
    defer { try? FileManager.default.removeItem(at: urlC) }
    try frankenstein.write(to: urlC)

    XCTAssertThrowsError(
      try readCacheFile(
        path: urlC,
        vaultKey: vaultKey,
        expectedHostInstallUUID: hostInstallUUID,
        expectedCounter: counter
      )
    ) { error in
      guard case EntryCacheError.rejection(let kind) = error else {
        XCTFail("Expected rejection, got \(error)")
        return
      }
      XCTAssertEqual(kind, .authtagInvalid,
                     "Cross-userId splice should fail entries AAD with .authtagInvalid")
    }
  }

  /// Negative control — confirms the splice tests above detect AAD mismatch
  /// (not some other corruption). Two writes with IDENTICAL (counter, uuid, userId)
  /// produce entries blobs that share the same AAD; splicing succeeds.
  func testEntriesBlobAADNegativeControl() throws {
    let urlA = tmpURL()
    let urlB = tmpURL()
    defer {
      try? FileManager.default.removeItem(at: urlA)
      try? FileManager.default.removeItem(at: urlB)
    }

    // Identical context — only entries content differs.
    let header = makeHeader(entryCount: 1)
    try writeCacheFile(
      data: CacheData(header: header, entries: makeEntriesJSON(count: 1)),
      vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: urlA
    )
    try writeCacheFile(
      data: CacheData(header: header, entries: makeEntriesJSON(count: 1)),
      vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: urlB
    )

    let aBytes = try Data(contentsOf: urlA)
    let bBytes = try Data(contentsOf: urlB)
    let aParts = parseFile(aBytes)!
    let bParts = parseFile(bBytes)!

    // Splice B-header + A-entries; both share AAD context, so this MUST succeed.
    let spliced = assembleFile(header: bParts.header, entries: aParts.entries)
    let urlC = tmpURL()
    defer { try? FileManager.default.removeItem(at: urlC) }
    try spliced.write(to: urlC)

    let read = try readCacheFile(
      path: urlC,
      vaultKey: vaultKey,
      expectedHostInstallUUID: hostInstallUUID,
      expectedCounter: counter
    )
    XCTAssertEqual(read.header.entryCount, 1)
  }

  /// Verify the AAD builder produces deterministic, format-stable bytes.
  func testCacheEntriesAADFormat() throws {
    let aad = try buildCacheEntriesAAD(
      counter: 0x0102_0304_0506_0708,
      hostInstallUUID: Data(repeating: 0xAA, count: 16),
      userId: "u"
    )
    // Layout: "CACHEENT"(8) || counter(BE 8) || uuid(16) || userIdLen(BE 2) || userId
    XCTAssertEqual(aad.count, 8 + 8 + 16 + 2 + 1)
    XCTAssertEqual(Array(aad[0..<8]), Array("CACHEENT".utf8))
    XCTAssertEqual(Array(aad[8..<16]), [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
    XCTAssertEqual(Array(aad[16..<32]), Array(repeating: UInt8(0xAA), count: 16))
    XCTAssertEqual(Array(aad[32..<34]), [0x00, 0x01])  // BE 1
    XCTAssertEqual(aad[34], UInt8(ascii: "u"))
  }

  /// userIdLen crosses the byte boundary at 256 — verify BE 2-byte encoding
  /// is `[0x01, 0x00]`, not truncated to `[0x00]` or reversed.
  func testCacheEntriesAADFormatLongUserId() throws {
    let userId = String(repeating: "a", count: 256)
    let aad = try buildCacheEntriesAAD(
      counter: 0,
      hostInstallUUID: Data(repeating: 0, count: 16),
      userId: userId
    )
    XCTAssertEqual(aad.count, 8 + 8 + 16 + 2 + 256)
    XCTAssertEqual(Array(aad[32..<34]), [0x01, 0x00],
                   "userIdLen=256 must encode as BE [0x01, 0x00]")
  }

  /// Maximum userId length (UInt16 max) must be accepted.
  func testCacheEntriesAADFormatMaxUserId() throws {
    let userId = String(repeating: "a", count: 0xFFFF)
    let aad = try buildCacheEntriesAAD(
      counter: 0,
      hostInstallUUID: Data(repeating: 0, count: 16),
      userId: userId
    )
    XCTAssertEqual(aad.count, 8 + 8 + 16 + 2 + 0xFFFF)
    XCTAssertEqual(Array(aad[32..<34]), [0xFF, 0xFF])
  }

  /// Multibyte UTF-8 userId (Japanese, emoji): userIdLen in the AAD is the
  /// BYTE count, not the character count. A regression that swaps `count`
  /// for `unicodeScalars.count` would mismatch encode-vs-decode AAD and
  /// surface as authtagInvalid, but only on non-ASCII userIds.
  func testRoundTripWithMultibyteUTF8UserId() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    let userId = "ユーザー🔑42"  // 4 chars, 16 bytes (12 for kana + 4 for emoji)
    let header = makeHeader(entryCount: 0, userId: userId)
    let data = CacheData(header: header, entries: makeEntriesJSON(count: 0))
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    let read = try readCacheFile(
      path: url,
      vaultKey: vaultKey,
      expectedHostInstallUUID: hostInstallUUID,
      expectedCounter: counter
    )
    XCTAssertEqual(read.header.userId, userId)
  }

  /// Encrypt-then-decrypt round-trip with a 256-byte userId — proves the
  /// AAD-on-encrypt and AAD-on-decrypt paths are byte-identical at the
  /// 1-byte → 2-byte UInt16 boundary, not just at the build level.
  func testRoundTripWithUserIdAtByteBoundary() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    let longUserId = String(repeating: "a", count: 256)
    let header = makeHeader(entryCount: 0, userId: longUserId)
    let data = CacheData(header: header, entries: makeEntriesJSON(count: 0))
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    let read = try readCacheFile(
      path: url,
      vaultKey: vaultKey,
      expectedHostInstallUUID: hostInstallUUID,
      expectedCounter: counter
    )
    XCTAssertEqual(read.header.userId.count, 256)
    XCTAssertEqual(read.header.userId, longUserId)
  }

  /// userId one byte over UInt16 max must be rejected with .headerInvalid.
  func testCacheEntriesAADFormatOversizeUserIdRejected() throws {
    let userId = String(repeating: "a", count: 0x10000)
    XCTAssertThrowsError(try buildCacheEntriesAAD(
      counter: 0,
      hostInstallUUID: Data(repeating: 0, count: 16),
      userId: userId
    )) { error in
      guard case EntryCacheError.rejection(let kind) = error else {
        XCTFail("Expected rejection, got \(error)")
        return
      }
      XCTAssertEqual(kind, .headerInvalid)
    }
  }

  // MARK: - Header date round-trip fidelity

  func testHeaderDatesRoundTrip() throws {
    let url = tmpURL()
    defer { try? FileManager.default.removeItem(at: url) }

    // Use epoch seconds precision (Int truncation)
    let now = Date(timeIntervalSince1970: Double(Int(Date().timeIntervalSince1970)))
    let header = makeHeader(issuedAt: now, refreshAt: now, entryCount: 0)
    let data = CacheData(header: header, entries: makeEntriesJSON(count: 0))
    try writeCacheFile(data: data, vaultKey: vaultKey, hostInstallUUID: hostInstallUUID, path: url)

    let read = try readCacheFile(
      path: url,
      vaultKey: vaultKey,
      expectedHostInstallUUID: hostInstallUUID,
      expectedCounter: counter
    )
    XCTAssertEqual(read.header.cacheIssuedAt, now)
    XCTAssertEqual(read.header.lastSuccessfulRefreshAt, now)
  }
}
