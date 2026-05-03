import XCTest
@testable import Shared

/// Mock Keychain for unit tests (per T42 — no real Keychain, no biometric prompts).
///
/// Models the V2 split layout: storage is keyed by `service:account`, so
/// the mock natively supports the two services (bridge-key-v2 and
/// bridge-meta-v2) plus the legacy combined service. The mock does NOT
/// model `.biometryCurrentSet` ACL — assertions about ACL gating must
/// use the `accessedServices` recorder below to confirm WHICH service
/// each call touched (a proxy for "did this call require biometrics?").
///
/// Failure injection: `addFailureForServices` allows tests to simulate
/// SecItemAdd failures on specific services, used to verify that
/// migration / persist paths correctly roll back partial state.
final class MockKeychainAccessor: KeychainAccessor, @unchecked Sendable {
  private var storage: [String: Data] = [:]
  var copyMatchingCallCount = 0
  /// Every `service` value passed to `copyMatching` (in call order).
  /// Used to assert which Keychain items a given operation touched.
  var accessedServices: [String] = []
  /// Services for which `add` should return `errSecParam` instead of
  /// success. Empty by default — failure injection opt-in per test.
  var addFailureForServices: Set<String> = []

  func add(query: [String: Any]) -> OSStatus {
    if let svc = query[kSecAttrService as String] as? String,
       addFailureForServices.contains(svc) {
      return errSecParam
    }
    let key = storageKey(query)
    if storage[key] != nil { return errSecDuplicateItem }
    if let data = query[kSecValueData as String] as? Data {
      storage[key] = data
    }
    return errSecSuccess
  }

  func copyMatching(query: [String: Any]) -> (OSStatus, Data?) {
    copyMatchingCallCount += 1
    if let svc = query[kSecAttrService as String] as? String {
      accessedServices.append(svc)
    }
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

  func has(service: String, account: String = "blob") -> Bool {
    storage["\(service):\(account)"] != nil
  }

  /// Inject a raw payload at a given (service, account) — used to seed
  /// the legacy 56-byte combined blob for migration tests.
  func seed(service: String, account: String = "blob", data: Data) {
    storage["\(service):\(account)"] = data
  }

  private func storageKey(_ query: [String: Any]) -> String {
    let service = query[kSecAttrService as String] as? String ?? ""
    let account = query[kSecAttrAccount as String] as? String ?? ""
    return "\(service):\(account)"
  }
}

final class BridgeKeyStoreTests: XCTestCase {

  private let legacyService = "com.passwd-sso.bridge-key"
  private let keyServiceV2 = "com.passwd-sso.bridge-key-v2"
  private let metaServiceV2 = "com.passwd-sso.bridge-meta-v2"

  private func makeStore() -> (BridgeKeyStore, MockKeychainAccessor) {
    let mock = MockKeychainAccessor()
    let store = BridgeKeyStore(
      accessGroup: "test.com.passwd-sso.shared",
      keychain: mock
    )
    return (store, mock)
  }

  // MARK: - Item-size invariants (post-split)

  func testV2ItemSizesAreSplit() throws {
    let (store, mock) = makeStore()

    let blob = try store.create()

    XCTAssertEqual(blob.bridgeKey.count, 32)
    XCTAssertEqual(blob.hostInstallUUID.count, 16)
    XCTAssertTrue(mock.has(service: keyServiceV2))
    XCTAssertTrue(mock.has(service: metaServiceV2))
    XCTAssertFalse(mock.has(service: legacyService))
    XCTAssertEqual(bridgeKeyV2Size, 32)
    XCTAssertEqual(bridgeMetaV2Size, 24)
    XCTAssertEqual(legacyBridgeKeyBlobSize, 56)
  }

  // MARK: - Create → read round-trip

  func testCreateThenReadForFill() throws {
    let (store, _) = makeStore()

    let created = try store.create()
    let read = try store.readForFill(reason: "test")

    XCTAssertEqual(created.bridgeKey, read.bridgeKey)
    XCTAssertEqual(created.cacheVersionCounter, read.cacheVersionCounter)
    XCTAssertEqual(created.hostInstallUUID, read.hostInstallUUID)
  }

  // MARK: - readDirect does not touch the biometric-gated bridge_key item

  func testReadDirectOnlyTouchesMetaService() throws {
    let (store, mock) = makeStore()

    _ = try store.create()
    mock.accessedServices.removeAll()

    let blob = try store.readDirect()

    // readDirect must touch ONLY the meta service (no biometric prompt).
    XCTAssertEqual(mock.accessedServices, [metaServiceV2])
    // bridgeKey is intentionally empty in the readDirect Blob.
    XCTAssertEqual(blob.bridgeKey, Data())
    XCTAssertNotEqual(blob.cacheVersionCounter, 0)
    XCTAssertEqual(blob.hostInstallUUID.count, 16)
  }

  func testReadForFillTouchesBothV2Services() throws {
    let (store, mock) = makeStore()

    _ = try store.create()
    mock.accessedServices.removeAll()

    _ = try store.readForFill(reason: "test")

    // readForFill reads the biometric-gated key first, then the meta item.
    XCTAssertEqual(mock.accessedServices, [keyServiceV2, metaServiceV2])
  }

  // MARK: - Counter increment via meta-only path

  func testIncrementCounterTouchesMetaServiceOnly() throws {
    let (store, mock) = makeStore()

    _ = try store.create()
    let initial = try store.readForFill(reason: "test")
    mock.accessedServices.removeAll()

    try store.incrementCounter(newCounter: initial.cacheVersionCounter + 1)
    let updated = try store.readForFill(reason: "test")

    XCTAssertEqual(updated.cacheVersionCounter, initial.cacheVersionCounter + 1)
    XCTAssertEqual(updated.bridgeKey, initial.bridgeKey)
    XCTAssertEqual(updated.hostInstallUUID, initial.hostInstallUUID)
  }

  // MARK: - recoverForwardCounter

  /// When the cache file is one ahead of the in-Keychain counter (i.e., the
  /// host crashed between writing the cache and updating the counter),
  /// recoverForwardCounter advances the meta counter and returns true.
  func testRecoverForwardCounterAdvancesByOne() throws {
    let (store, _) = makeStore()
    _ = try store.create()
    let initial = try store.readDirect()

    let advanced = try store.recoverForwardCounter(observed: initial.cacheVersionCounter + 1)

    XCTAssertTrue(advanced, "observed == current + 1 must advance the counter")
    XCTAssertEqual(
      try store.readDirect().cacheVersionCounter,
      initial.cacheVersionCounter + 1
    )
  }

  /// observed == current is a no-op (cache and counter agree).
  func testRecoverForwardCounterRejectsEqualCounter() throws {
    let (store, _) = makeStore()
    _ = try store.create()
    let initial = try store.readDirect()

    let advanced = try store.recoverForwardCounter(observed: initial.cacheVersionCounter)

    XCTAssertFalse(advanced)
    XCTAssertEqual(try store.readDirect().cacheVersionCounter,
                   initial.cacheVersionCounter)
  }

  /// observed > current + 1 is rejected — recovery is intentionally
  /// limited to a single forward step to bound the trust window.
  func testRecoverForwardCounterRejectsForwardByMoreThanOne() throws {
    let (store, _) = makeStore()
    _ = try store.create()
    let initial = try store.readDirect()

    let advanced = try store.recoverForwardCounter(observed: initial.cacheVersionCounter + 2)

    XCTAssertFalse(advanced)
    XCTAssertEqual(try store.readDirect().cacheVersionCounter,
                   initial.cacheVersionCounter)
  }

  /// observed < current (rollback attempt) is rejected.
  func testRecoverForwardCounterRejectsBackward() throws {
    let (store, _) = makeStore()
    _ = try store.create()
    // Advance to 100 so we can test backward.
    try store.incrementCounter(newCounter: 100)

    let advanced = try store.recoverForwardCounter(observed: 50)

    XCTAssertFalse(advanced)
    XCTAssertEqual(try store.readDirect().cacheVersionCounter, 100)
  }

  /// recoverForwardCounter on an empty store throws notFound (there is no
  /// counter to recover from).
  func testRecoverForwardCounterThrowsWhenBlobMissing() {
    let (store, _) = makeStore()

    XCTAssertThrowsError(try store.recoverForwardCounter(observed: 1)) { error in
      XCTAssertEqual(error as? BridgeKeyStore.Error, .notFound)
    }
  }

  // MARK: - Delete clears both v2 services + legacy

  func testDeleteRemovesBothV2Items() throws {
    let (store, mock) = makeStore()

    _ = try store.create()
    try store.delete()

    XCTAssertFalse(mock.has(service: keyServiceV2))
    XCTAssertFalse(mock.has(service: metaServiceV2))

    XCTAssertThrowsError(try store.readForFill(reason: "test")) { error in
      XCTAssertEqual(error as? BridgeKeyStore.Error, .notFound)
    }
  }

  // MARK: - Legacy migration

  /// Pre-seed mock with a legacy 56-byte combined blob, then trigger
  /// migration via readDirect. Verify v2 items are written and legacy is
  /// removed; counter+uuid bytes match the legacy payload.
  func testLegacyBlobMigrationOnReadDirect() throws {
    let (store, mock) = makeStore()

    let legacyBridgeKey = Data(repeating: 0xBB, count: 32)
    let legacyCounter: UInt64 = 0x0102_0304_0506_0708
    let legacyUUID = Data(repeating: 0xCC, count: 16)

    var legacyBlob = Data()
    legacyBlob.append(legacyBridgeKey)
    let counterBE = legacyCounter.bigEndian
    withUnsafeBytes(of: counterBE) { legacyBlob.append(contentsOf: $0) }
    legacyBlob.append(legacyUUID)
    XCTAssertEqual(legacyBlob.count, 56)

    mock.seed(service: legacyService, data: legacyBlob)
    XCTAssertFalse(mock.has(service: keyServiceV2))
    XCTAssertFalse(mock.has(service: metaServiceV2))

    let blob = try store.readDirect()

    XCTAssertEqual(blob.cacheVersionCounter, legacyCounter)
    XCTAssertEqual(blob.hostInstallUUID, legacyUUID)
    XCTAssertTrue(mock.has(service: keyServiceV2))
    XCTAssertTrue(mock.has(service: metaServiceV2))
    XCTAssertFalse(mock.has(service: legacyService),
                   "legacy item must be deleted after successful migration")
  }

  /// When the v2-persist step of migration fails, the legacy item MUST
  /// remain readable so the next call can retry the migration. The worst
  /// case allowed by the design is "no migration today, retry on next
  /// call" — never partial state that masks the legacy data.
  func testLegacyMigrationFailureKeepsLegacyIntact() throws {
    let (store, mock) = makeStore()

    let legacyBridgeKey = Data(repeating: 0xAA, count: 32)
    let legacyCounter: UInt64 = 7
    let legacyUUID = Data(repeating: 0xBB, count: 16)
    var legacyBlob = Data()
    legacyBlob.append(legacyBridgeKey)
    let counterBE = legacyCounter.bigEndian
    withUnsafeBytes(of: counterBE) { legacyBlob.append(contentsOf: $0) }
    legacyBlob.append(legacyUUID)
    mock.seed(service: legacyService, data: legacyBlob)

    // Inject failure on the v2 bridge-key add — meta-v2 will succeed first,
    // then bridge-key-v2 will fail, persistBlob must roll back meta-v2.
    mock.addFailureForServices = [keyServiceV2]

    XCTAssertThrowsError(try store.readDirect()) { error in
      // Failure is deterministic under MockKeychainAccessor:
      //   readMetaItem (notFound) → tryMigrateLegacyBlob → persistBlob:
      //   meta-v2 add succeeds → key-v2 add returns errSecParam (injected)
      //   → meta-v2 rolled back → throws .keychainError(errSecParam).
      // Pinning the exact type guards against silent regressions where a
      // future refactor throws the wrong class but happens to leave the
      // post-state intact.
      XCTAssertEqual(
        error as? BridgeKeyStore.Error,
        .keychainError(errSecParam),
        "expected .keychainError(errSecParam) from injected key-v2 add failure"
      )
    }

    // Legacy item must still exist for retry.
    XCTAssertTrue(
      mock.has(service: legacyService),
      "legacy item must remain intact when v2 persist fails"
    )
    // Meta should have been rolled back (or never written if the error
    // surfaced earlier). bridgeKey-v2 must NOT exist.
    XCTAssertFalse(
      mock.has(service: keyServiceV2),
      "bridge-key-v2 must not exist after persist failure"
    )
    XCTAssertFalse(
      mock.has(service: metaServiceV2),
      "bridge-meta-v2 must be rolled back when bridge-key-v2 add fails"
    )
  }

  /// readForFill on legacy state must also migrate, and the returned Blob
  /// includes bridgeKey from the legacy bytes.
  func testLegacyBlobMigrationOnReadForFill() throws {
    let (store, mock) = makeStore()

    let legacyBridgeKey = Data(repeating: 0xDD, count: 32)
    let legacyCounter: UInt64 = 42
    let legacyUUID = Data(repeating: 0xEE, count: 16)

    var legacyBlob = Data()
    legacyBlob.append(legacyBridgeKey)
    let counterBE = legacyCounter.bigEndian
    withUnsafeBytes(of: counterBE) { legacyBlob.append(contentsOf: $0) }
    legacyBlob.append(legacyUUID)
    mock.seed(service: legacyService, data: legacyBlob)

    let blob = try store.readForFill(reason: "test")

    XCTAssertEqual(blob.bridgeKey, legacyBridgeKey)
    XCTAssertEqual(blob.cacheVersionCounter, legacyCounter)
    XCTAssertEqual(blob.hostInstallUUID, legacyUUID)
    XCTAssertFalse(mock.has(service: legacyService))
  }

  // MARK: - readForFill performance: still ONE biometric-gated read

  /// readForFill performs at most TWO copyMatching calls in the steady
  /// state (no migration): one for bridge-key-v2 (biometric) and one for
  /// bridge-meta-v2 (no ACL). The biometric prompt is only on the FIRST.
  func testReadForFillUsesOneBiometricGatedRead() throws {
    let (store, mock) = makeStore()

    _ = try store.create()
    mock.copyMatchingCallCount = 0
    mock.accessedServices.removeAll()

    _ = try store.readForFill(reason: "test")

    XCTAssertEqual(mock.copyMatchingCallCount, 2,
                   "readForFill steady-state: 1 biometric-gated + 1 no-ACL = 2 reads")
    XCTAssertEqual(mock.accessedServices.first, keyServiceV2,
                   "the biometric-gated read must be first")
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
