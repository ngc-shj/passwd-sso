import XCTest
@testable import Shared

/// Mock Keychain for unit tests (per T42 — no real Keychain, no biometric prompts).
final class MockKeychainAccessor: KeychainAccessor, @unchecked Sendable {
  private var storage: [String: Data] = [:]
  var copyMatchingCallCount = 0

  func add(query: [String: Any]) -> OSStatus {
    let key = storageKey(query)
    if storage[key] != nil { return errSecDuplicateItem }
    if let data = query[kSecValueData as String] as? Data {
      storage[key] = data
    }
    return errSecSuccess
  }

  func copyMatching(query: [String: Any]) -> (OSStatus, Data?) {
    copyMatchingCallCount += 1
    let key = storageKey(query)
    if let data = storage[key] {
      return (errSecSuccess, data)
    }
    return (errSecItemNotFound, nil)
  }

  func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
    let key = storageKey(query)
    guard storage[key] != nil else { return errSecItemNotFound }
    if let data = attributes[kSecValueData as String] as? Data {
      storage[key] = data
    }
    return errSecSuccess
  }

  func delete(query: [String: Any]) -> OSStatus {
    let key = storageKey(query)
    if storage.removeValue(forKey: key) != nil {
      return errSecSuccess
    }
    return errSecItemNotFound
  }

  private func storageKey(_ query: [String: Any]) -> String {
    let service = query[kSecAttrService as String] as? String ?? ""
    let account = query[kSecAttrAccount as String] as? String ?? ""
    return "\(service):\(account)"
  }
}

final class BridgeKeyStoreTests: XCTestCase {

  private func makeStore() -> (BridgeKeyStore, MockKeychainAccessor) {
    let mock = MockKeychainAccessor()
    let store = BridgeKeyStore(
      accessGroup: "test.com.passwd-sso.shared",
      keychain: mock
    )
    return (store, mock)
  }

  // MARK: - Blob serialization size

  func testBlobSizeIs56Bytes() throws {
    let (store, _) = makeStore()

    let blob = try store.create()

    XCTAssertEqual(blob.bridgeKey.count, 32)
    XCTAssertEqual(blob.hostInstallUUID.count, 16)
    // Total serialized: 32 + 8 + 16 = 56 bytes
    XCTAssertEqual(bridgeKeyBlobSize, 56)
  }

  // MARK: - Create → read round-trip

  func testCreateThenRead() throws {
    let (store, _) = makeStore()

    let created = try store.create()
    let read = try store.readForFill(reason: "test")

    XCTAssertEqual(created, read)
  }

  // MARK: - Counter increment

  func testIncrementCounter() throws {
    let (store, _) = makeStore()

    _ = try store.create()
    let initial = try store.readForFill(reason: "test")

    try store.incrementCounter(newCounter: initial.cacheVersionCounter + 1)
    let updated = try store.readForFill(reason: "test")

    XCTAssertEqual(updated.cacheVersionCounter, initial.cacheVersionCounter + 1)
    XCTAssertEqual(updated.bridgeKey, initial.bridgeKey)
    XCTAssertEqual(updated.hostInstallUUID, initial.hostInstallUUID)
  }

  // MARK: - Delete

  func testDeleteRemovesItem() throws {
    let (store, _) = makeStore()

    _ = try store.create()
    try store.delete()

    XCTAssertThrowsError(try store.readForFill(reason: "test")) { error in
      XCTAssertEqual(error as? BridgeKeyStore.Error, .notFound)
    }
  }

  // MARK: - T42: readForFill uses exactly ONE Keychain read

  func testReadForFillUsesOneKeychainRead() throws {
    let (store, mock) = makeStore()

    _ = try store.create()
    mock.copyMatchingCallCount = 0  // reset after create (which may read)

    _ = try store.readForFill(reason: "test")

    XCTAssertEqual(mock.copyMatchingCallCount, 1, "readForFill must use exactly one Keychain read")
  }

  // MARK: - Counter is non-zero after create

  func testCounterIsNonZeroAfterCreate() throws {
    let (store, _) = makeStore()

    let blob = try store.create()

    XCTAssertNotEqual(blob.cacheVersionCounter, 0)
  }

  // MARK: - Double delete does not throw

  func testDoubleDeleteIsIdempotent() throws {
    let (store, _) = makeStore()

    _ = try store.create()
    try store.delete()
    XCTAssertNoThrow(try store.delete())
  }

  // MARK: - readForFill without create throws notFound

  func testReadWithoutCreateThrows() {
    let (store, _) = makeStore()

    XCTAssertThrowsError(try store.readForFill(reason: "test")) { error in
      XCTAssertEqual(error as? BridgeKeyStore.Error, .notFound)
    }
  }
}
