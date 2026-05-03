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
