import CryptoKit
import Foundation
import XCTest
@testable import Shared

// MARK: - Mock rollback flag writer

final class MockRollbackFlagWriter: RollbackFlagWriter, @unchecked Sendable {
  private(set) var writeCalls: [RollbackFlagPayload] = []

  func writeFlag(payload: RollbackFlagPayload, vaultKey: SymmetricKey) async throws {
    writeCalls.append(payload)
  }
}

// MARK: - Mock wrapped key store

final class MockWrappedKeyStore: WrappedKeyStore, @unchecked Sendable {
  var storedVaultKey: WrappedVaultKey?
  var teamKeys: [WrappedTeamKey] = []

  func saveVaultKey(_ wrapped: WrappedVaultKey) throws {
    storedVaultKey = wrapped
  }

  func loadVaultKey() throws -> WrappedVaultKey? { storedVaultKey }

  func saveTeamKeys(_ keys: [WrappedTeamKey]) throws {
    teamKeys = keys
  }

  func loadTeamKeys() throws -> [WrappedTeamKey] { teamKeys }
  func clearAll() throws {
    storedVaultKey = nil
    teamKeys = []
  }
}

// MARK: - Counting Keychain accessor

/// Counts copyMatching calls for T42 (single Keychain read per fill).
final class CountingKeychainAccessor: KeychainAccessor, @unchecked Sendable {
  private var storage: [String: Data] = [:]
  var copyMatchingCallCount = 0

  func add(query: [String: Any]) -> OSStatus {
    let key = storageKey(query)
    if storage[key] != nil { return errSecDuplicateItem }
    if let data = query[kSecValueData as String] as? Data { storage[key] = data }
    return errSecSuccess
  }

  func copyMatching(query: [String: Any]) -> (OSStatus, Data?) {
    copyMatchingCallCount += 1
    let key = storageKey(query)
    if let data = storage[key] { return (errSecSuccess, data) }
    return (errSecItemNotFound, nil)
  }

  func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
    let key = storageKey(query)
    guard storage[key] != nil else { return errSecItemNotFound }
    if let data = attributes[kSecValueData as String] as? Data { storage[key] = data }
    return errSecSuccess
  }

  func delete(query: [String: Any]) -> OSStatus {
    let key = storageKey(query)
    return storage.removeValue(forKey: key) != nil ? errSecSuccess : errSecItemNotFound
  }

  private func storageKey(_ query: [String: Any]) -> String {
    let service = query[kSecAttrService as String] as? String ?? ""
    let account = query[kSecAttrAccount as String] as? String ?? ""
    return "\(service):\(account)"
  }
}

// MARK: - Test helpers

private func makeBridgeKeyBlob(
  keychain: any KeychainAccessor = MockKeychainAccessor()
) throws -> (BridgeKeyStore, BridgeKeyStore.Blob) {
  let store = BridgeKeyStore(
    accessGroup: "test.com.passwd-sso.shared",
    keychain: keychain
  )
  let blob = try store.create()
  return (store, blob)
}

/// Build a cache file on disk containing entries, encrypted under the given vault key.
private func buildCacheFile(
  at url: URL,
  entries: [CacheEntry],
  vaultKey: SymmetricKey,
  hostInstallUUID: Data,
  counter: UInt64,
  userId: String = "test-user-id",
  now: Date = Date()
) throws {
  let entriesData = try JSONEncoder().encode(entries)
  let header = CacheHeader(
    cacheVersionCounter: counter,
    cacheIssuedAt: now,
    lastSuccessfulRefreshAt: now,
    entryCount: UInt32(entries.count),
    hostInstallUUID: hostInstallUUID,
    userId: userId
  )
  let cacheData = CacheData(header: header, entries: entriesData)
  try writeCacheFile(
    data: cacheData,
    vaultKey: vaultKey,
    hostInstallUUID: hostInstallUUID,
    path: url
  )
}

/// Wrap vaultKey under cacheKey and save into the store.
/// Returns the wrapped key for verification if needed.
@discardableResult
private func wrapAndSaveVaultKey(
  vaultKey: SymmetricKey,
  cacheKey: SymmetricKey,
  store: MockWrappedKeyStore
) throws -> WrappedVaultKey {
  let vaultKeyBytes = vaultKey.withUnsafeBytes { Data($0) }
  let (cipher, iv, tag) = try encryptAESGCM(plaintext: vaultKeyBytes, key: cacheKey)
  let wrapped = WrappedVaultKey(ciphertext: cipher, iv: iv, authTag: tag, issuedAt: Date())
  try store.saveVaultKey(wrapped)
  return wrapped
}

/// Encrypt a summary struct into EncryptedData (hex-encoded), with optional AAD.
private func encryptSummary(
  _ summary: VaultEntrySummary,
  key: SymmetricKey,
  aad: Data? = nil
) throws -> EncryptedData {
  let data = try JSONEncoder().encode(summary)
  return try encryptAESGCMEncoded(plaintext: data, key: key, aad: aad)
}

/// Encrypt a detail struct into EncryptedData (hex-encoded), with optional AAD.
private func encryptDetail(
  _ detail: VaultEntryDetail,
  key: SymmetricKey,
  aad: Data? = nil
) throws -> EncryptedData {
  let data = try JSONEncoder().encode(detail)
  return try encryptAESGCMEncoded(plaintext: data, key: key, aad: aad)
}

/// Build a personal CacheEntry with AAD-bound ciphertext.
/// aadVersion >= 1 → encrypt with buildPersonalEntryAAD(userId, entryId).
private func makePersonalCacheEntry(
  summary: VaultEntrySummary,
  detail: VaultEntryDetail,
  key: SymmetricKey,
  userId: String,
  aadVersion: Int,
  keyVersion: Int = 1
) throws -> CacheEntry {
  let overviewAAD: Data? = aadVersion >= 1
    ? try buildPersonalEntryAAD(userId: userId, entryId: summary.id)
    : nil
  let blobAAD: Data? = aadVersion >= 1
    ? try buildPersonalEntryAAD(userId: userId, entryId: detail.id)
    : nil
  return CacheEntry(
    id: summary.id,
    teamId: nil,
    aadVersion: aadVersion,
    keyVersion: keyVersion,
    encryptedBlob: try encryptDetail(detail, key: key, aad: blobAAD),
    encryptedOverview: try encryptSummary(summary, key: key, aad: overviewAAD)
  )
}

/// Build a team CacheEntry with AAD-bound ciphertext.
/// If itemKeyVersion >= 1, generates a fresh ItemKey, wraps it, and uses it for entry encryption.
private func makeTeamCacheEntry(
  summary: VaultEntrySummary,
  detail: VaultEntryDetail,
  teamKey: SymmetricKey,
  teamId: String,
  teamKeyVersion: Int = 1,
  itemKeyVersion: Int = 0
) throws -> CacheEntry {
  let entryId = summary.id
  let overviewAAD = try buildTeamEntryAAD(
    teamId: teamId, entryId: entryId, vaultType: "overview", itemKeyVersion: itemKeyVersion
  )
  let blobAAD = try buildTeamEntryAAD(
    teamId: teamId, entryId: entryId, vaultType: "blob", itemKeyVersion: itemKeyVersion
  )

  let (entryKey, encryptedItemKey): (SymmetricKey, EncryptedData?)
  if itemKeyVersion >= 1 {
    let rawItemKey = SymmetricKey(size: .bits256)
    let wrapAAD = try buildItemKeyWrapAAD(
      teamId: teamId, entryId: entryId, teamKeyVersion: teamKeyVersion
    )
    let itemKeyBytes = rawItemKey.withUnsafeBytes { Data($0) }
    entryKey = rawItemKey
    encryptedItemKey = try encryptAESGCMEncoded(
      plaintext: itemKeyBytes, key: teamKey, aad: wrapAAD
    )
  } else {
    entryKey = teamKey
    encryptedItemKey = nil
  }

  return CacheEntry(
    id: entryId,
    teamId: teamId,
    aadVersion: 1,
    keyVersion: 0,
    teamKeyVersion: teamKeyVersion,
    itemKeyVersion: itemKeyVersion,
    encryptedItemKey: encryptedItemKey,
    encryptedBlob: try encryptDetail(detail, key: entryKey, aad: blobAAD),
    encryptedOverview: try encryptSummary(summary, key: entryKey, aad: overviewAAD)
  )
}

/// Wrap a team key under cacheKey and build a WrappedTeamKey (no AAD on team key wrapping).
private func wrapTeamKey(
  _ teamKey: SymmetricKey,
  teamId: String,
  teamKeyVersion: Int,
  cacheKey: SymmetricKey,
  issuedAt: Date = Date()
) throws -> WrappedTeamKey {
  let teamKeyData = teamKey.withUnsafeBytes { Data($0) }
  let (cipher, iv, tag) = try encryptAESGCM(plaintext: teamKeyData, key: cacheKey)
  return WrappedTeamKey(
    teamId: teamId,
    ciphertext: cipher,
    iv: iv,
    authTag: tag,
    issuedAt: issuedAt,
    teamKeyVersion: teamKeyVersion
  )
}

// MARK: - Tests

final class CredentialResolverTests: XCTestCase {

  private var tmpDir: URL!

  override func setUp() {
    super.setUp()
    tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "CredentialResolverTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: tmpDir)
    super.tearDown()
  }

  private var cacheURL: URL {
    tmpDir.appending(path: "encryptedEntries.cache", directoryHint: .notDirectory)
  }

  // MARK: - vaultLocked

  func testResolveCandidates_vaultLocked_throws() async throws {
    // BridgeKeyStore with nothing in Keychain → readForFill → .notFound → .vaultLocked
    let emptyKeychain = MockKeychainAccessor()
    let bridgeKeyStore = BridgeKeyStore(
      accessGroup: "test.com.passwd-sso.shared",
      keychain: emptyKeychain
    )
    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: MockWrappedKeyStore(),
      cacheURL: cacheURL
    )

    do {
      _ = try await resolver.resolveCandidates(for: [])
      XCTFail("Expected CredentialResolver.Error.vaultLocked")
    } catch CredentialResolver.Error.vaultLocked {
      // expected
    }
  }

  // MARK: - missing WrappedVaultKey → vaultLocked

  func testResolveCandidates_missingWrappedVaultKey_throwsVaultLocked() async throws {
    // BridgeKeyStore has a valid blob, but WrappedKeyStore has no vault key.
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    // Build cache (needs some valid state to reach the wrappedKeyStore check)
    try buildCacheFile(
      at: cacheURL,
      entries: [],
      vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID,
      counter: blob.cacheVersionCounter
    )
    _ = cacheKey  // suppress unused warning

    // MockWrappedKeyStore has no vault key stored (storedVaultKey == nil)
    let emptyStore = MockWrappedKeyStore()
    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: emptyStore,
      cacheURL: cacheURL
    )

    do {
      _ = try await resolver.resolveCandidates(for: [])
      XCTFail("Expected vaultLocked when WrappedVaultKey is absent")
    } catch CredentialResolver.Error.vaultLocked {
      // expected: vault_key cannot be unwrapped without the stored wrapped key
    }
  }

  // MARK: - URL host filtering

  func testResolveCandidates_filtersByURLHost() async throws {
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    // Three entries: 2 match mail.google.com, 1 matches github.com
    let summaryA = VaultEntrySummary(
      id: "entry-1", title: "Gmail", username: "user@gmail.com",
      urlHost: "mail.google.com"
    )
    let summaryB = VaultEntrySummary(
      id: "entry-2", title: "Gmail Alt", username: "alt@gmail.com",
      urlHost: "google.com"  // subdomain match
    )
    let summaryC = VaultEntrySummary(
      id: "entry-3", title: "GitHub", username: "ghuser",
      urlHost: "github.com"
    )

    let detailA = VaultEntryDetail(
      id: "entry-1", title: "Gmail", username: "user@gmail.com",
      urlHost: "mail.google.com", password: "pw1", url: "https://mail.google.com"
    )
    let detailB = VaultEntryDetail(
      id: "entry-2", title: "Gmail Alt", username: "alt@gmail.com",
      urlHost: "google.com", password: "pw2", url: "https://google.com"
    )
    let detailC = VaultEntryDetail(
      id: "entry-3", title: "GitHub", username: "ghuser",
      urlHost: "github.com", password: "pw3", url: "https://github.com"
    )

    let entries: [CacheEntry] = try [
      CacheEntry(
        id: "entry-1",
        aadVersion: 0,
        encryptedBlob: encryptDetail(detailA, key: vaultKey),
        encryptedOverview: encryptSummary(summaryA, key: vaultKey)
      ),
      CacheEntry(
        id: "entry-2",
        aadVersion: 0,
        encryptedBlob: encryptDetail(detailB, key: vaultKey),
        encryptedOverview: encryptSummary(summaryB, key: vaultKey)
      ),
      CacheEntry(
        id: "entry-3",
        aadVersion: 0,
        encryptedBlob: encryptDetail(detailC, key: vaultKey),
        encryptedOverview: encryptSummary(summaryC, key: vaultKey)
      ),
    ]

    try buildCacheFile(
      at: cacheURL,
      entries: entries,
      vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID,
      counter: blob.cacheVersionCounter,
      userId: "test-user-id"
    )

    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: mockWKS,
      cacheURL: cacheURL
    )

    let ident = ServiceIdentifier(identifier: "https://mail.google.com", isURL: true)
    let candidates = try await resolver.resolveCandidates(for: [ident])

    XCTAssertEqual(candidates.count, 3, "Should return all entries")
    // Matched entries (entry-1, entry-2) should come first
    XCTAssertTrue(
      candidates.prefix(2).map(\.id).contains("entry-1"),
      "entry-1 (mail.google.com exact) should be in first 2"
    )
    XCTAssertTrue(
      candidates.prefix(2).map(\.id).contains("entry-2"),
      "entry-2 (google.com subdomain) should be in first 2"
    )
    XCTAssertEqual(candidates.last?.id, "entry-3", "Non-matching entry should be last")
  }

  // MARK: - Stale team key filtering

  func testResolveCandidates_excludesStaleTeamEntries() async throws {
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    // A team key that is 16 minutes old (stale; max is 15 min).
    // Team keys are wrapped under cacheKey in the corrected architecture.
    let teamKey = SymmetricKey(size: .bits256)
    let staleIssuedAt = Date().addingTimeInterval(-16 * 60)
    let wrappedTeamKey = try wrapTeamKey(
      teamKey, teamId: "team-stale", teamKeyVersion: 1,
      cacheKey: cacheKey, issuedAt: staleIssuedAt
    )

    let teamSummary = VaultEntrySummary(
      id: "team-entry-1", title: "Team Secret", username: "teamuser",
      urlHost: "example.com", teamId: "team-stale"
    )
    let teamDetail = VaultEntryDetail(
      id: "team-entry-1", title: "Team Secret", username: "teamuser",
      urlHost: "example.com", teamId: "team-stale",
      password: "tpw1", url: "https://example.com"
    )

    let entries: [CacheEntry] = try [
      CacheEntry(
        id: "team-entry-1",
        teamId: "team-stale",
        aadVersion: 0,
        encryptedBlob: encryptDetail(teamDetail, key: teamKey),
        encryptedOverview: encryptSummary(teamSummary, key: teamKey)
      ),
    ]

    try buildCacheFile(
      at: cacheURL,
      entries: entries,
      vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID,
      counter: blob.cacheVersionCounter,
      userId: "test-user-id"
    )

    try mockWKS.saveTeamKeys([wrappedTeamKey])

    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: mockWKS,
      cacheURL: cacheURL
    )

    do {
      _ = try await resolver.resolveCandidates(for: [])
      XCTFail("Expected teamKeyStale error when only stale team entries exist")
    } catch CredentialResolver.Error.teamKeyStale(let teamId) {
      XCTAssertEqual(teamId, "team-stale")
    }
  }

  // MARK: - Cache rejection + rollback flag

  func testResolveCandidates_cacheRejection_writesFlag() async throws {
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    // Write a valid cache with counter N, but bridge_key_blob has a different counter.
    // We do this by building a cache at counter=999 while the blob counter is different.
    let mismatchedCounter: UInt64 = 999
    let entries: [CacheEntry] = []
    try buildCacheFile(
      at: cacheURL,
      entries: entries,
      vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID,
      counter: mismatchedCounter  // will fail AAD check since blob has different counter
    )

    let mockFlagWriter = MockRollbackFlagWriter()
    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: mockWKS,
      cacheURL: cacheURL,
      rollbackFlagWriter: mockFlagWriter
    )

    do {
      _ = try await resolver.resolveCandidates(for: [])
      XCTFail("Expected cacheRejected error")
    } catch CredentialResolver.Error.cacheRejected {
      XCTAssertEqual(
        mockFlagWriter.writeCalls.count,
        1,
        "RollbackFlagWriter.writeFlag must be called exactly once on cache rejection"
      )
    }
  }

  // MARK: - Single Keychain read (T42)

  func testResolveCandidates_singleKeychainRead() async throws {
    let counting = CountingKeychainAccessor()
    let bridgeKeyStore = BridgeKeyStore(
      accessGroup: "test.com.passwd-sso.shared",
      keychain: counting
    )
    let blob = try bridgeKeyStore.create()
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)
    counting.copyMatchingCallCount = 0  // reset after create

    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    // Build a minimal valid cache.
    let entries: [CacheEntry] = []
    try buildCacheFile(
      at: cacheURL,
      entries: entries,
      vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID,
      counter: blob.cacheVersionCounter
    )

    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: mockWKS,
      cacheURL: cacheURL
    )

    _ = try? await resolver.resolveCandidates(for: [])

    // After the V2 split: readForFill performs 2 SecItemCopyMatching calls —
    // one for bridge-key-v2 (biometric-gated) and one for bridge-meta-v2
    // (no ACL, no prompt). Only the FIRST is biometric-gated, so the
    // single-prompt invariant is preserved: 2 keychain reads = 1 prompt.
    XCTAssertEqual(
      counting.copyMatchingCallCount,
      2,
      "resolveCandidates must use exactly TWO Keychain reads (one biometric prompt + one no-ACL meta)"
    )
  }

  // MARK: - decryptEntryDetail returns correct fields

  func testDecryptEntryDetail_returnsCorrectFields() async throws {
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    let expectedDetail = VaultEntryDetail(
      id: "detail-1",
      title: "My Site",
      username: "alice",
      urlHost: "mysite.com",
      password: "supersecret",
      url: "https://mysite.com",
      notes: "Some notes",
      totpSecret: "JBSWY3DPEHPK3PXP"
    )
    let summary = VaultEntrySummary(
      id: "detail-1", title: "My Site", username: "alice",
      urlHost: "mysite.com", hasTOTP: true
    )

    let entries: [CacheEntry] = try [
      CacheEntry(
        id: "detail-1",
        aadVersion: 0,
        encryptedBlob: encryptDetail(expectedDetail, key: vaultKey),
        encryptedOverview: encryptSummary(summary, key: vaultKey)
      ),
    ]
    try buildCacheFile(
      at: cacheURL,
      entries: entries,
      vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID,
      counter: blob.cacheVersionCounter,
      userId: "test-user-id"
    )

    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: mockWKS,
      cacheURL: cacheURL
    )

    // First resolve to prime the retained blob.
    let ident = ServiceIdentifier(identifier: "https://mysite.com", isURL: true)
    _ = try await resolver.resolveCandidates(for: [ident])

    let detail = try await resolver.decryptEntryDetail(entryId: "detail-1")
    XCTAssertEqual(detail.id, "detail-1")
    XCTAssertEqual(detail.username, "alice")
    XCTAssertEqual(detail.password, "supersecret")
    XCTAssertEqual(detail.notes, "Some notes")
    XCTAssertEqual(detail.totpSecret, "JBSWY3DPEHPK3PXP")
  }

  // MARK: - Vault key zeroing after return

  func testDecryptEntryDetail_zeroesVaultKeyAfterReturn() async throws {
    // Verifies vault_key is not retained between calls by removing bridge_key and
    // confirming a second decryptEntryDetail fails.
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    let detail = VaultEntryDetail(
      id: "e1", title: "T", username: "u", urlHost: "example.com",
      password: "p", url: "https://example.com"
    )
    let summary = VaultEntrySummary(id: "e1", title: "T", username: "u", urlHost: "example.com")
    let entries: [CacheEntry] = try [
      CacheEntry(
        id: "e1",
        aadVersion: 0,
        encryptedBlob: encryptDetail(detail, key: vaultKey),
        encryptedOverview: encryptSummary(summary, key: vaultKey)
      ),
    ]
    try buildCacheFile(
      at: cacheURL, entries: entries, vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: "test-user-id"
    )

    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: mockWKS,
      cacheURL: cacheURL
    )

    let ident = ServiceIdentifier(identifier: "https://example.com", isURL: true)
    _ = try await resolver.resolveCandidates(for: [ident])
    _ = try await resolver.decryptEntryDetail(entryId: "e1")

    // After decryptEntryDetail returns, the retained blob is consumed (nil).
    // Remove the Keychain item to confirm vault_key is not cached.
    try bridgeKeyStore.delete()

    do {
      _ = try await resolver.decryptEntryDetail(entryId: "e1")
      XCTFail("Expected vaultLocked after bridge_key deleted — confirming vault_key was not retained")
    } catch CredentialResolver.Error.vaultLocked {
      // Confirmed: vault_key is not retained between calls
    }
  }

  // MARK: - AAD propagation tests

  func testResolveCandidates_aadVersion0_personalEntry_decrypts() async throws {
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    let summary = VaultEntrySummary(id: "p-0", title: "T", username: "u", urlHost: "x.com")
    let detail = VaultEntryDetail(
      id: "p-0", title: "T", username: "u", urlHost: "x.com",
      password: "pw", url: "https://x.com"
    )
    // aadVersion=0 → no AAD; entry stored with no-AAD ciphertext
    let entry = CacheEntry(
      id: "p-0",
      aadVersion: 0,
      encryptedBlob: try encryptDetail(detail, key: vaultKey),
      encryptedOverview: try encryptSummary(summary, key: vaultKey)
    )
    try buildCacheFile(
      at: cacheURL, entries: [entry], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: "user-abc"
    )
    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore, wrappedKeyStore: mockWKS, cacheURL: cacheURL
    )
    let candidates = try await resolver.resolveCandidates(for: [])
    XCTAssertEqual(candidates.count, 1, "aadVersion=0 entry must decrypt cleanly")
    XCTAssertEqual(candidates[0].id, "p-0")
  }

  func testResolveCandidates_aadVersion1_personalEntry_wrongUserIdFails() async throws {
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    let summary = VaultEntrySummary(id: "p-1", title: "T", username: "u", urlHost: "x.com")
    let detail = VaultEntryDetail(
      id: "p-1", title: "T", username: "u", urlHost: "x.com",
      password: "pw", url: "https://x.com"
    )
    // Encrypt with userId="user-A"
    let entry = try makePersonalCacheEntry(
      summary: summary, detail: detail, key: vaultKey,
      userId: "user-A", aadVersion: 1
    )
    // Store cache header with userId="user-B" → AAD mismatch → decrypt fails silently
    try buildCacheFile(
      at: cacheURL, entries: [entry], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: "user-B"
    )
    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore, wrappedKeyStore: mockWKS, cacheURL: cacheURL
    )
    let candidates = try? await resolver.resolveCandidates(for: [])
    // The entry is silently filtered (decrypt fails), so candidates is empty or nil
    XCTAssertTrue(
      candidates?.isEmpty != false,
      "Entry encrypted with userId=A must be filtered when header.userId=B"
    )
  }

  func testResolveCandidates_teamEntry_itemKeyVersion0_decrypts() async throws {
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    let teamId = "team-x"
    let teamKey = SymmetricKey(size: .bits256)
    // Team keys are wrapped under cacheKey (not vaultKey) in the corrected architecture.
    let wrappedTeamKey = try wrapTeamKey(teamKey, teamId: teamId, teamKeyVersion: 1, cacheKey: cacheKey)

    let summary = VaultEntrySummary(
      id: "te-0", title: "T", username: "u", urlHost: "y.com", teamId: teamId
    )
    let detail = VaultEntryDetail(
      id: "te-0", title: "T", username: "u", urlHost: "y.com",
      teamId: teamId, password: "tpw", url: "https://y.com"
    )
    let entry = try makeTeamCacheEntry(
      summary: summary, detail: detail, teamKey: teamKey,
      teamId: teamId, teamKeyVersion: 1, itemKeyVersion: 0
    )
    try buildCacheFile(
      at: cacheURL, entries: [entry], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: "u-1"
    )
    try mockWKS.saveTeamKeys([wrappedTeamKey])
    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore, wrappedKeyStore: mockWKS, cacheURL: cacheURL
    )
    let candidates = try await resolver.resolveCandidates(for: [])
    XCTAssertEqual(candidates.count, 1, "Team entry itemKeyVersion=0 must decrypt with teamKey")
    XCTAssertEqual(candidates[0].id, "te-0")
  }

  func testResolveCandidates_teamEntry_itemKeyVersion1_unwrapsItemKey() async throws {
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    let teamId = "team-y"
    let teamKey = SymmetricKey(size: .bits256)
    let wrappedTeamKey = try wrapTeamKey(teamKey, teamId: teamId, teamKeyVersion: 2, cacheKey: cacheKey)

    let summary = VaultEntrySummary(
      id: "te-1", title: "T", username: "u", urlHost: "z.com", teamId: teamId
    )
    let detail = VaultEntryDetail(
      id: "te-1", title: "T", username: "u", urlHost: "z.com",
      teamId: teamId, password: "tpw2", url: "https://z.com"
    )
    let entry = try makeTeamCacheEntry(
      summary: summary, detail: detail, teamKey: teamKey,
      teamId: teamId, teamKeyVersion: 2, itemKeyVersion: 1
    )
    try buildCacheFile(
      at: cacheURL, entries: [entry], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: "u-1"
    )
    try mockWKS.saveTeamKeys([wrappedTeamKey])
    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore, wrappedKeyStore: mockWKS, cacheURL: cacheURL
    )
    let candidates = try await resolver.resolveCandidates(for: [])
    XCTAssertEqual(candidates.count, 1, "Team entry itemKeyVersion=1 must unwrap ItemKey")
    XCTAssertEqual(candidates[0].id, "te-1")
  }

  func testResolveCandidates_teamEntry_itemKeyVersion1_missingItemKey_filtered() async throws {
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    let teamId = "team-z"
    let teamKey = SymmetricKey(size: .bits256)
    let wrappedTeamKey = try wrapTeamKey(teamKey, teamId: teamId, teamKeyVersion: 1, cacheKey: cacheKey)

    let summary = VaultEntrySummary(
      id: "te-missing", title: "T", username: "u", urlHost: "w.com", teamId: teamId
    )
    let detail = VaultEntryDetail(
      id: "te-missing", title: "T", username: "u", urlHost: "w.com",
      teamId: teamId, password: "p", url: "https://w.com"
    )
    // itemKeyVersion=1 but encryptedItemKey=nil → resolver must filter this entry
    let overviewAAD = try buildTeamEntryAAD(
      teamId: teamId, entryId: "te-missing", vaultType: "overview", itemKeyVersion: 1
    )
    let blobAAD = try buildTeamEntryAAD(
      teamId: teamId, entryId: "te-missing", vaultType: "blob", itemKeyVersion: 1
    )
    let brokenEntry = CacheEntry(
      id: "te-missing",
      teamId: teamId,
      aadVersion: 1,
      keyVersion: 0,
      teamKeyVersion: 1,
      itemKeyVersion: 1,
      encryptedItemKey: nil,  // missing — resolver should skip
      encryptedBlob: try encryptDetail(detail, key: teamKey, aad: blobAAD),
      encryptedOverview: try encryptSummary(summary, key: teamKey, aad: overviewAAD)
    )
    try buildCacheFile(
      at: cacheURL, entries: [brokenEntry], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: "u-1"
    )
    try mockWKS.saveTeamKeys([wrappedTeamKey])
    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore, wrappedKeyStore: mockWKS, cacheURL: cacheURL
    )
    // Entry must be silently filtered; noEntries thrown since cache is non-empty but all fail
    do {
      let candidates = try await resolver.resolveCandidates(for: [])
      XCTAssertTrue(candidates.isEmpty, "Missing ItemKey must cause entry to be filtered")
    } catch CredentialResolver.Error.noEntries {
      // Also acceptable: resolver surfaces noEntries when all entries are filtered
    }
  }

  func testResolveCandidates_teamEntry_wrongAAD_filtered() async throws {
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    let teamId = "team-w"
    let teamKey = SymmetricKey(size: .bits256)
    let wrappedTeamKey = try wrapTeamKey(teamKey, teamId: teamId, teamKeyVersion: 1, cacheKey: cacheKey)

    let summary = VaultEntrySummary(
      id: "te-wrong-aad", title: "T", username: "u", urlHost: "v.com", teamId: teamId
    )
    let detail = VaultEntryDetail(
      id: "te-wrong-aad", title: "T", username: "u", urlHost: "v.com",
      teamId: teamId, password: "p", url: "https://v.com"
    )
    // Encrypt overview with vaultType="blob" AAD (wrong — resolver will try "overview")
    let wrongAAD = try buildTeamEntryAAD(
      teamId: teamId, entryId: "te-wrong-aad", vaultType: "blob", itemKeyVersion: 0
    )
    let blobAAD = try buildTeamEntryAAD(
      teamId: teamId, entryId: "te-wrong-aad", vaultType: "blob", itemKeyVersion: 0
    )
    let wrongEntry = CacheEntry(
      id: "te-wrong-aad",
      teamId: teamId,
      aadVersion: 1,
      teamKeyVersion: 1,
      itemKeyVersion: 0,
      // overview encrypted with "blob" AAD — AES-GCM auth will fail when resolver uses "overview" AAD
      encryptedBlob: try encryptDetail(detail, key: teamKey, aad: blobAAD),
      encryptedOverview: try encryptSummary(summary, key: teamKey, aad: wrongAAD)
    )
    try buildCacheFile(
      at: cacheURL, entries: [wrongEntry], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: "u-1"
    )
    try mockWKS.saveTeamKeys([wrappedTeamKey])
    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore, wrappedKeyStore: mockWKS, cacheURL: cacheURL
    )
    do {
      let candidates = try await resolver.resolveCandidates(for: [])
      XCTAssertTrue(candidates.isEmpty, "Wrong AAD must cause entry to be filtered")
    } catch CredentialResolver.Error.noEntries {
      // Also acceptable
    }
  }
}
