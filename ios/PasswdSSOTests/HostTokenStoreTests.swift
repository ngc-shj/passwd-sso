import Foundation
import XCTest

@testable import Shared

// MARK: - Fake Keychain

/// In-memory Keychain fake for dependency-injected tests.
final class FakeKeychain: KeychainAccessor, @unchecked Sendable {
  private var store: [String: Data] = [:]
  private let lock = NSLock()

  private func key(for query: [String: Any]) -> String {
    let service = query[kSecAttrService as String] as? String ?? ""
    let account = query[kSecAttrAccount as String] as? String ?? ""
    return "\(service):\(account)"
  }

  func add(query: [String: Any]) -> OSStatus {
    lock.lock(); defer { lock.unlock() }
    let k = key(for: query)
    guard store[k] == nil else { return errSecDuplicateItem }
    store[k] = query[kSecValueData as String] as? Data
    return errSecSuccess
  }

  func copyMatching(query: [String: Any]) -> (OSStatus, Data?) {
    lock.lock(); defer { lock.unlock() }
    let k = key(for: query)
    guard let data = store[k] else { return (errSecItemNotFound, nil) }
    return (errSecSuccess, data)
  }

  func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
    lock.lock(); defer { lock.unlock() }
    let k = key(for: query)
    guard store[k] != nil else { return errSecItemNotFound }
    if let newData = attributes[kSecValueData as String] as? Data {
      store[k] = newData
    }
    return errSecSuccess
  }

  func delete(query: [String: Any]) -> OSStatus {
    lock.lock(); defer { lock.unlock() }
    let k = key(for: query)
    guard store[k] != nil else { return errSecItemNotFound }
    store.removeValue(forKey: k)
    return errSecSuccess
  }
}

// MARK: - Tests

final class HostTokenStoreTests: XCTestCase {
  private var keychain: FakeKeychain!
  private var store: HostTokenStore!

  override func setUp() {
    super.setUp()
    keychain = FakeKeychain()
    store = HostTokenStore(service: "com.test.host-tokens", keychain: keychain)
  }

  func testSaveAndLoadTokens() throws {
    let expiry = Date(timeIntervalSince1970: 1_800_000_000)
    try store.saveTokens(access: "acc123", refresh: "ref456", expiresAt: expiry)

    let loaded = try XCTUnwrap(try store.loadAccess())
    XCTAssertEqual(loaded.token, "acc123")
    XCTAssertEqual(loaded.expiresAt.timeIntervalSince1970, expiry.timeIntervalSince1970, accuracy: 1)

    let refresh = try XCTUnwrap(try store.loadRefresh())
    XCTAssertEqual(refresh, "ref456")
  }

  func testOverwriteTokens() throws {
    try store.saveTokens(access: "acc1", refresh: "ref1", expiresAt: Date())
    try store.saveTokens(access: "acc2", refresh: "ref2", expiresAt: Date().addingTimeInterval(3600))

    let loaded = try XCTUnwrap(try store.loadAccess())
    XCTAssertEqual(loaded.token, "acc2")
    let refresh = try XCTUnwrap(try store.loadRefresh())
    XCTAssertEqual(refresh, "ref2")
  }

  func testLoadAccessReturnsNilWhenNotSet() throws {
    let result = try store.loadAccess()
    XCTAssertNil(result)
  }

  func testLoadRefreshReturnsNilWhenNotSet() throws {
    let result = try store.loadRefresh()
    XCTAssertNil(result)
  }

  func testSaveAndLoadNonce() throws {
    try store.saveNonce("nonce-abc")
    let loaded = try XCTUnwrap(try store.loadNonce())
    XCTAssertEqual(loaded, "nonce-abc")
  }

  func testOverwriteNonce() throws {
    try store.saveNonce("first")
    try store.saveNonce("second")
    let loaded = try XCTUnwrap(try store.loadNonce())
    XCTAssertEqual(loaded, "second")
  }

  func testLoadNonceReturnsNilWhenNotSet() throws {
    let result = try store.loadNonce()
    XCTAssertNil(result)
  }

  func testDeleteAllClearsTokensAndNonce() throws {
    let expiry = Date().addingTimeInterval(3600)
    try store.saveTokens(access: "acc", refresh: "ref", expiresAt: expiry)
    try store.saveNonce("nonce")

    try store.deleteAll()

    XCTAssertNil(try store.loadAccess())
    XCTAssertNil(try store.loadRefresh())
    XCTAssertNil(try store.loadNonce())
  }

  func testDeleteAllIsIdempotent() throws {
    try store.deleteAll()
    try store.deleteAll()
    // No error thrown — double delete is safe.
  }

  func testExpiryPreservedAcrossSaveLoad() throws {
    let targetDate = Date(timeIntervalSinceReferenceDate: 800_000_000)
    try store.saveTokens(access: "tok", refresh: "ref", expiresAt: targetDate)
    let loaded = try XCTUnwrap(try store.loadAccess())
    // ISO-8601 round-trip precision is at least 1 second.
    XCTAssertEqual(loaded.expiresAt.timeIntervalSinceReferenceDate,
                   targetDate.timeIntervalSinceReferenceDate,
                   accuracy: 1.0)
  }
}
