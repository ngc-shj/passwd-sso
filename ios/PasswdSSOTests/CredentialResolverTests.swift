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
  var storedECDHPrivateKey: WrappedECDHPrivateKey?

  func saveVaultKey(_ wrapped: WrappedVaultKey) throws {
    storedVaultKey = wrapped
  }

  func loadVaultKey() throws -> WrappedVaultKey? { storedVaultKey }

  func saveTeamKeys(_ keys: [WrappedTeamKey]) throws {
    teamKeys = keys
  }

  func loadTeamKeys() throws -> [WrappedTeamKey] { teamKeys }
  func clearTeamKeys() throws { teamKeys = [] }

  func saveECDHPrivateKey(_ wrapped: WrappedECDHPrivateKey) throws {
    storedECDHPrivateKey = wrapped
  }

  func loadECDHPrivateKey() throws -> WrappedECDHPrivateKey? { storedECDHPrivateKey }

  func clearAll() throws {
    storedVaultKey = nil
    teamKeys = []
    storedECDHPrivateKey = nil
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

// MARK: - Server-shaped blob payload structs for tests

// These mirror the server blob shapes (OverviewBlobPayload/FullBlobPayload in CredentialResolver)
// so that test fixtures exercise the same decode path as real server data.

private struct TestOverviewBlob: Encodable {
  let title: String
  let username: String?
  let urlHost: String?
  let additionalUrlHosts: [String]?
  let tags: [TestTagBlob]
}

private struct TestFullBlob: Encodable {
  let title: String
  let username: String?
  let password: String
  let url: String?
  let notes: String?
  let tags: [TestTagBlob]
  let totp: TestTotpBlob?
}

private struct TestTagBlob: Encodable {
  let name: String
  let color: String?
}

private struct TestTotpBlob: Encodable {
  let secret: String
}

private struct PasskeyTestOverviewBlob: Encodable {
  let title: String
  let username: String?
  let relyingPartyId: String
  let credentialId: String
}

private struct PasskeyTestFullBlob: Encodable {
  let title: String
  let username: String?
  let relyingPartyId: String
  let credentialId: String
  let passkeyPrivateKeyJwk: String
  let passkeyUserHandle: String
  let passkeySignCount: Int?
}

/// Build a personal PASSKEY CacheEntry (overview + full blob) with AAD binding.
private func makePasskeyCacheEntry(
  id: String, rpId: String, credentialID: Data, userHandle: Data,
  key: SymmetricKey, userId: String, signCount: Int? = nil
) throws -> CacheEntry {
  let credIdB64 = base64URLEncode(credentialID)
  let userHandleB64 = base64URLEncode(userHandle)
  let overviewData = try JSONEncoder().encode(
    PasskeyTestOverviewBlob(title: "T", username: "alice", relyingPartyId: rpId, credentialId: credIdB64)
  )
  let fullData = try JSONEncoder().encode(
    PasskeyTestFullBlob(
      title: "T", username: "alice", relyingPartyId: rpId, credentialId: credIdB64,
      passkeyPrivateKeyJwk: "{\"kty\":\"EC\",\"crv\":\"P-256\",\"d\":\"abc\"}",
      passkeyUserHandle: userHandleB64,
      passkeySignCount: signCount
    )
  )
  let overviewAAD = try buildPersonalEntryAAD(userId: userId, entryId: id, vaultType: VaultType.overview)
  let blobAAD = try buildPersonalEntryAAD(userId: userId, entryId: id, vaultType: VaultType.blob)
  return CacheEntry(
    id: id, teamId: nil, aadVersion: 1, keyVersion: 1,
    encryptedBlob: try encryptAESGCMEncoded(plaintext: fullData, key: key, aad: blobAAD),
    encryptedOverview: try encryptAESGCMEncoded(plaintext: overviewData, key: key, aad: overviewAAD),
    entryType: "PASSKEY"
  )
}

// MARK: - Test helpers

private func makeBridgeKeyBlob(
  keychain: any KeychainAccessor = MockKeychainAccessor()
) throws -> (BridgeKeyStore, BridgeKeyStore.Blob) {
  let store = BridgeKeyStore(
    accessGroup: "test.jp.jpng.passwd-sso.shared",
    keychain: keychain,
    evaluatesBiometricExplicitly: false
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

/// Encrypt a VaultEntrySummary as a server-shaped overview blob (OverviewBlobPayload format)
/// into EncryptedData (hex-encoded), with optional AAD.
/// id and hasTOTP are NOT encoded (not in the server blob shape).
private func encryptSummary(
  _ summary: VaultEntrySummary,
  key: SymmetricKey,
  aad: Data? = nil
) throws -> EncryptedData {
  let blob = TestOverviewBlob(
    title: summary.title,
    username: summary.username.isEmpty ? nil : summary.username,
    urlHost: summary.urlHost.isEmpty ? nil : summary.urlHost,
    additionalUrlHosts: summary.additionalUrlHosts.isEmpty ? nil : summary.additionalUrlHosts,
    tags: []
  )
  let data = try JSONEncoder().encode(blob)
  return try encryptAESGCMEncoded(plaintext: data, key: key, aad: aad)
}

/// Encrypt a VaultEntryDetail as a server-shaped full blob (FullBlobPayload format)
/// into EncryptedData (hex-encoded), with optional AAD.
/// id and urlHost are NOT encoded (not in the server full blob shape).
/// totpSecret is encoded as totp:{secret:...} object.
private func encryptDetail(
  _ detail: VaultEntryDetail,
  key: SymmetricKey,
  aad: Data? = nil
) throws -> EncryptedData {
  let totpBlob: TestTotpBlob? = detail.totpSecret.map { TestTotpBlob(secret: $0) }
  let blob = TestFullBlob(
    title: detail.title,
    username: detail.username.isEmpty ? nil : detail.username,
    password: detail.password,
    url: detail.url.isEmpty ? nil : detail.url,
    notes: detail.notes.isEmpty ? nil : detail.notes,
    tags: [],
    totp: totpBlob
  )
  let data = try JSONEncoder().encode(blob)
  return try encryptAESGCMEncoded(plaintext: data, key: key, aad: aad)
}

/// Build a personal CacheEntry with AAD-bound ciphertext.
/// aadVersion >= 1 → encrypt each field with buildPersonalEntryAAD(userId, entryId, vaultType).
private func makePersonalCacheEntry(
  summary: VaultEntrySummary,
  detail: VaultEntryDetail,
  key: SymmetricKey,
  userId: String,
  aadVersion: Int,
  keyVersion: Int = 1
) throws -> CacheEntry {
  // Both fields belong to the same entry — bind to one canonical entryId.
  let entryId = summary.id
  let overviewAAD: Data? = aadVersion >= 1
    ? try buildPersonalEntryAAD(userId: userId, entryId: entryId, vaultType: VaultType.overview)
    : nil
  let blobAAD: Data? = aadVersion >= 1
    ? try buildPersonalEntryAAD(userId: userId, entryId: entryId, vaultType: VaultType.blob)
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
    teamId: teamId, entryId: entryId, vaultType: VaultType.overview, itemKeyVersion: itemKeyVersion
  )
  let blobAAD = try buildTeamEntryAAD(
    teamId: teamId, entryId: entryId, vaultType: VaultType.blob, itemKeyVersion: itemKeyVersion
  )

  let (entryKey, encryptedItemKey): (SymmetricKey, EncryptedData?)
  if itemKeyVersion >= 1 {
    let rawItemKey = SymmetricKey(size: .bits256)
    let wrapAAD = try buildItemKeyWrapAAD(
      teamId: teamId, entryId: entryId, teamKeyVersion: teamKeyVersion
    )
    let itemKeyBytes = rawItemKey.withUnsafeBytes { Data($0) }
    // Production decrypts the entry under deriveItemEncryptionKey(itemKey), NOT the
    // raw ItemKey — mirror that so the fixture matches the resolver.
    entryKey = TeamKeyCrypto.deriveItemEncryptionKey(itemKey: rawItemKey)
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

/// Wrap a team key under cacheKey with the localWrap AAD (kind:"team", userId, teamId),
/// matching the host-side TeamEntryDecryptor.wrapTeamKey. userId defaults to the
/// buildCacheFile default ("test-user-id") so the resolver's AAD reconstruction matches.
private func wrapTeamKey(
  _ teamKey: SymmetricKey,
  teamId: String,
  teamKeyVersion: Int,
  cacheKey: SymmetricKey,
  userId: String = "test-user-id",
  issuedAt: Date = Date()
) throws -> WrappedTeamKey {
  try TeamEntryDecryptor.wrapTeamKey(
    teamEncKey: teamKey, cacheKey: cacheKey, userId: userId,
    teamId: teamId, teamKeyVersion: teamKeyVersion, issuedAt: issuedAt)
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
      accessGroup: "test.jp.jpng.passwd-sso.shared",
      keychain: emptyKeychain,
      evaluatesBiometricExplicitly: false
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
    let result = try await resolver.resolveCandidates(for: [ident])

    // matched = host matches only (entry-1 exact, entry-2 subdomain); entry-3 excluded.
    XCTAssertEqual(
      Set(result.matched.map(\.id)), ["entry-1", "entry-2"],
      "matched should be exactly the host-matching entries"
    )
    // all = full set, matched first then unmatched.
    XCTAssertEqual(result.all.count, 3, "all should contain every entry")
    XCTAssertEqual(result.all.last?.id, "entry-3", "Non-matching entry should be last in all")
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
      accessGroup: "test.jp.jpng.passwd-sso.shared",
      keychain: counting,
      evaluatesBiometricExplicitly: false
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

  // MARK: - decryptPasskeyMaterial (C6)

  /// Build a resolver over a cache containing the given entries, with the bridge
  /// blob + wrapped vault key wired up. Returns the resolver and the counting
  /// keychain so the caller can assert read counts.
  private func makePasskeyResolver(
    entries: [CacheEntry], vaultKey: SymmetricKey, userId: String
  ) throws -> (CredentialResolver, CountingKeychainAccessor) {
    let counting = CountingKeychainAccessor()
    let bridgeKeyStore = BridgeKeyStore(
      accessGroup: "test.jp.jpng.passwd-sso.shared", keychain: counting,
      evaluatesBiometricExplicitly: false
    )
    let blob = try bridgeKeyStore.create()
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)
    try buildCacheFile(
      at: cacheURL, entries: entries, vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter, userId: userId
    )
    counting.copyMatchingCallCount = 0  // reset after create
    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore, wrappedKeyStore: mockWKS, cacheURL: cacheURL
    )
    return (resolver, counting)
  }

  func testDecryptPasskeyMaterial_returnsMaterial() async throws {
    let vaultKey = SymmetricKey(size: .bits256)
    let userId = "test-user-id"
    let credentialID = Data([1, 2, 3, 4])
    let userHandle = Data([9, 8, 7, 6])
    let entry = try makePasskeyCacheEntry(
      id: "pk1", rpId: "github.com", credentialID: credentialID, userHandle: userHandle,
      key: vaultKey, userId: userId
    )
    let (resolver, _) = try makePasskeyResolver(entries: [entry], vaultKey: vaultKey, userId: userId)

    // No prior resolveCandidates — exercises the standalone readForFill path.
    let material = try await resolver.decryptPasskeyMaterial(entryId: "pk1")

    XCTAssertEqual(material.relyingPartyId, "github.com")
    XCTAssertEqual(material.credentialId, base64URLEncode(credentialID))
    XCTAssertEqual(material.userHandle, base64URLEncode(userHandle))
    XCTAssertEqual(material.signCount, 0, "absent passkeySignCount must decode as floor 0")
  }

  /// The server-synced sign count must survive the full path
  /// blob JSON -> decryptPasskeyMaterial -> material.signCount, because the
  /// extension feeds it into PasskeySignCountStore.next(credentialId:floor:).
  func testDecryptPasskeyMaterial_decodesSignCountFromBlob() async throws {
    let vaultKey = SymmetricKey(size: .bits256)
    let userId = "test-user-id"
    let entry = try makePasskeyCacheEntry(
      id: "pk1", rpId: "github.com", credentialID: Data([1, 2, 3, 4]),
      userHandle: Data([9, 8, 7, 6]), key: vaultKey, userId: userId, signCount: 50
    )
    let (resolver, _) = try makePasskeyResolver(entries: [entry], vaultKey: vaultKey, userId: userId)

    let material = try await resolver.decryptPasskeyMaterial(entryId: "pk1")

    XCTAssertEqual(material.signCount, 50)
  }

  func testDecryptPasskeyMaterial_loginEntry_throwsEntryNotFound() async throws {
    let vaultKey = SymmetricKey(size: .bits256)
    let userId = "test-user-id"
    let login = try makePersonalCacheEntry(
      summary: VaultEntrySummary(id: "p0", title: "T", username: "u", urlHost: "a.com"),
      detail: VaultEntryDetail(id: "p0", title: "T", username: "u", urlHost: "", password: "pw", url: "a.com"),
      key: vaultKey, userId: userId, aadVersion: 1
    )
    let (resolver, _) = try makePasskeyResolver(entries: [login], vaultKey: vaultKey, userId: userId)

    do {
      _ = try await resolver.decryptPasskeyMaterial(entryId: "p0")
      XCTFail("Expected entryNotFound for a non-passkey entry")
    } catch CredentialResolver.Error.entryNotFound {
      // expected
    }
  }

  func testDecryptPasskeyMaterial_teamEntry_throwsEntryNotFound() async throws {
    // Team passkeys are out of scope (I5): the teamId guard fires before any
    // team-key decryption, so a team entry id is rejected as entryNotFound.
    let vaultKey = SymmetricKey(size: .bits256)
    let userId = "test-user-id"
    let dummy = try encryptAESGCMEncoded(plaintext: Data("{}".utf8), key: vaultKey, aad: nil)
    let team = CacheEntry(
      id: "t0", teamId: "team-1", aadVersion: 0,
      encryptedBlob: dummy, encryptedOverview: dummy
    )
    let (resolver, _) = try makePasskeyResolver(entries: [team], vaultKey: vaultKey, userId: userId)

    do {
      _ = try await resolver.decryptPasskeyMaterial(entryId: "t0")
      XCTFail("Expected entryNotFound for a team entry")
    } catch CredentialResolver.Error.entryNotFound {
      // expected
    }
  }

  func testDecryptPasskeyMaterial_singleBiometricRead() async throws {
    // resolveCandidates retains the bridge blob; decryptPasskeyMaterial reuses it,
    // so the two-call (one biometric + one meta) invariant holds across both.
    let vaultKey = SymmetricKey(size: .bits256)
    let userId = "test-user-id"
    let entry = try makePasskeyCacheEntry(
      id: "pk1", rpId: "github.com", credentialID: Data([1, 2, 3, 4]),
      userHandle: Data([9, 8, 7, 6]), key: vaultKey, userId: userId
    )
    let (resolver, counting) = try makePasskeyResolver(
      entries: [entry], vaultKey: vaultKey, userId: userId
    )

    _ = try await resolver.resolveCandidates(for: [])
    _ = try await resolver.decryptPasskeyMaterial(entryId: "pk1")

    XCTAssertEqual(
      counting.copyMatchingCallCount, 2,
      "resolveCandidates + decryptPasskeyMaterial must share one biometric read (2 keychain reads total)"
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
    let candidates = try await resolver.resolveCandidates(for: []).all
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
    let candidates = (try? await resolver.resolveCandidates(for: []))?.all
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
    let wrappedTeamKey = try wrapTeamKey(teamKey, teamId: teamId, teamKeyVersion: 1, cacheKey: cacheKey, userId: "u-1")

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
    let candidates = try await resolver.resolveCandidates(for: []).all
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
    let wrappedTeamKey = try wrapTeamKey(teamKey, teamId: teamId, teamKeyVersion: 2, cacheKey: cacheKey, userId: "u-1")

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
    let candidates = try await resolver.resolveCandidates(for: []).all
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
    let wrappedTeamKey = try wrapTeamKey(teamKey, teamId: teamId, teamKeyVersion: 1, cacheKey: cacheKey, userId: "u-1")

    let summary = VaultEntrySummary(
      id: "te-missing", title: "T", username: "u", urlHost: "w.com", teamId: teamId
    )
    let detail = VaultEntryDetail(
      id: "te-missing", title: "T", username: "u", urlHost: "w.com",
      teamId: teamId, password: "p", url: "https://w.com"
    )
    // itemKeyVersion=1 but encryptedItemKey=nil → resolver must filter this entry
    let overviewAAD = try buildTeamEntryAAD(
      teamId: teamId, entryId: "te-missing", vaultType: VaultType.overview, itemKeyVersion: 1
    )
    let blobAAD = try buildTeamEntryAAD(
      teamId: teamId, entryId: "te-missing", vaultType: VaultType.blob, itemKeyVersion: 1
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
      let candidates = try await resolver.resolveCandidates(for: []).all
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
    let wrappedTeamKey = try wrapTeamKey(teamKey, teamId: teamId, teamKeyVersion: 1, cacheKey: cacheKey, userId: "u-1")

    let summary = VaultEntrySummary(
      id: "te-wrong-aad", title: "T", username: "u", urlHost: "v.com", teamId: teamId
    )
    let detail = VaultEntryDetail(
      id: "te-wrong-aad", title: "T", username: "u", urlHost: "v.com",
      teamId: teamId, password: "p", url: "https://v.com"
    )
    // Encrypt overview with vaultType="blob" AAD (wrong — resolver will try "overview")
    let wrongAAD = try buildTeamEntryAAD(
      teamId: teamId, entryId: "te-wrong-aad", vaultType: VaultType.blob, itemKeyVersion: 0
    )
    let blobAAD = try buildTeamEntryAAD(
      teamId: teamId, entryId: "te-wrong-aad", vaultType: VaultType.blob, itemKeyVersion: 0
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
      let candidates = try await resolver.resolveCandidates(for: []).all
      XCTAssertTrue(candidates.isEmpty, "Wrong AAD must cause entry to be filtered")
    } catch CredentialResolver.Error.noEntries {
      // Also acceptable
    }
  }

  // MARK: - Passkey registration (C7): encryptPasskeyEntry / appendEntryToCache

  /// Common fixture: bridge blob + wrapped vault key + cache with one personal
  /// LOGIN entry at keyVersion 3 (so keyVersion recovery is observable).
  private func makeRegistrationFixture() throws -> (
    resolver: CredentialResolver, vaultKey: SymmetricKey, blob: BridgeKeyStore.Blob,
    bridgeKeyStore: BridgeKeyStore
  ) {
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)
    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    let userId = "user-reg"
    let summary = VaultEntrySummary(
      id: "login-1", title: "L", username: "u", urlHost: "l.com"
    )
    let detail = VaultEntryDetail(
      id: "login-1", title: "L", username: "u", urlHost: "l.com",
      password: "p", url: "https://l.com"
    )
    let existing = try makePersonalCacheEntry(
      summary: summary, detail: detail, key: vaultKey,
      userId: userId, aadVersion: 1, keyVersion: 3
    )
    try buildCacheFile(
      at: cacheURL, entries: [existing], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: userId
    )
    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore, wrappedKeyStore: mockWKS, cacheURL: cacheURL
    )
    return (resolver, vaultKey, blob, bridgeKeyStore)
  }

  func testEncryptPasskeyEntry_recoversKeyVersionAndUserIdAndBindsAAD() async throws {
    let fixture = try makeRegistrationFixture()
    let entryId = "pk-new-1"
    let blobPlain = Data(#"{"entryType":"PASSKEY"}"#.utf8)
    let overviewPlain = Data(#"{"title":"T"}"#.utf8)

    let enc = try await fixture.resolver.encryptPasskeyEntry(
      entryId: entryId, blobPlaintext: blobPlain, overviewPlaintext: overviewPlain
    )

    XCTAssertEqual(enc.userId, "user-reg")
    XCTAssertEqual(enc.keyVersion, 3, "keyVersion must be recovered from the cached personal entry")
    // Decryptable ONLY with the correct personal AAD (blob/overview separated).
    let blobAAD = try buildPersonalEntryAAD(
      userId: "user-reg", entryId: entryId, vaultType: VaultType.blob
    )
    let overviewAAD = try buildPersonalEntryAAD(
      userId: "user-reg", entryId: entryId, vaultType: VaultType.overview
    )
    XCTAssertEqual(
      try decryptAESGCMEncoded(encrypted: enc.encryptedBlob, key: fixture.vaultKey, aad: blobAAD),
      blobPlain
    )
    XCTAssertEqual(
      try decryptAESGCMEncoded(encrypted: enc.encryptedOverview, key: fixture.vaultKey, aad: overviewAAD),
      overviewPlain
    )
    XCTAssertThrowsError(
      try decryptAESGCMEncoded(encrypted: enc.encryptedBlob, key: fixture.vaultKey, aad: overviewAAD),
      "blob ciphertext must not validate under the overview AAD"
    )
  }

  func testEncryptPasskeyEntry_missingWrappedVaultKey_throwsVaultLocked() async throws {
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let vaultKey = SymmetricKey(size: .bits256)
    try buildCacheFile(
      at: cacheURL, entries: [], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter
    )
    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore, wrappedKeyStore: MockWrappedKeyStore(), cacheURL: cacheURL
    )

    do {
      _ = try await resolver.encryptPasskeyEntry(
        entryId: "x", blobPlaintext: Data([1]), overviewPlaintext: Data([2])
      )
      XCTFail("Expected vaultLocked")
    } catch CredentialResolver.Error.vaultLocked {
      // expected
    }
  }

  func testAppendEntryToCache_appendsAtCounterPlusOneAndBumpsMeta() async throws {
    let fixture = try makeRegistrationFixture()
    let entryId = "pk-new-2"
    let enc = try await fixture.resolver.encryptPasskeyEntry(
      entryId: entryId,
      blobPlaintext: Data(#"{"entryType":"PASSKEY"}"#.utf8),
      overviewPlaintext: Data(#"{"title":"T"}"#.utf8)
    )
    let newEntry = CacheEntry(
      id: entryId, teamId: nil, aadVersion: 1, keyVersion: enc.keyVersion,
      encryptedBlob: enc.encryptedBlob, encryptedOverview: enc.encryptedOverview,
      entryType: "PASSKEY"
    )

    try await fixture.resolver.appendEntryToCache(newEntry)

    // Bridge meta counter advanced by exactly one…
    let meta = try fixture.bridgeKeyStore.readDirect()
    XCTAssertEqual(meta.cacheVersionCounter, fixture.blob.cacheVersionCounter + 1)
    // …and the on-disk cache at the new counter contains BOTH entries.
    let cache = try readCacheFile(
      path: cacheURL,
      vaultKey: fixture.vaultKey,
      expectedHostInstallUUID: fixture.blob.hostInstallUUID,
      expectedCounter: meta.cacheVersionCounter
    )
    let entries = try JSONDecoder().decode([CacheEntry].self, from: cache.entries)
    XCTAssertEqual(entries.map(\.id).sorted(), ["login-1", entryId].sorted())
    XCTAssertEqual(entries.first(where: { $0.id == entryId })?.entryType, "PASSKEY")
  }

  // MARK: - F3 regression: decryptEntryDetail enforces 15-min staleness on team keys

  /// Regression for F3: previously decryptEntryDetail had NO staleness check on the
  /// team key, so a revoked-and-stale team key could still fill credentials. The fix
  /// adds the same staleness guard as resolveCandidates. This test will FAIL against
  /// the old code (no guard → detail decrypts → no throw), and PASS with the fix.
  func testDecryptEntryDetail_staleTeamKey_throwsEntryNotFound() async throws {
    let keychain = MockKeychainAccessor()
    let (bridgeKeyStore, blob) = try makeBridgeKeyBlob(keychain: keychain)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    let vaultKey = SymmetricKey(size: .bits256)

    let mockWKS = MockWrappedKeyStore()
    try wrapAndSaveVaultKey(vaultKey: vaultKey, cacheKey: cacheKey, store: mockWKS)

    // A stale team key: issuedAt is 16 minutes ago (past the 15-min window).
    let teamId = "team-stale-fill"
    let teamKey = SymmetricKey(size: .bits256)
    let staleIssuedAt = Date().addingTimeInterval(-16 * 60)
    let wrappedStale = try wrapTeamKey(
      teamKey, teamId: teamId, teamKeyVersion: 1,
      cacheKey: cacheKey, userId: "test-user-id", issuedAt: staleIssuedAt
    )

    let entryId = "team-entry-stale-fill"
    let summary = VaultEntrySummary(
      id: entryId, title: "Team Fill", username: "alice",
      urlHost: "fill.example.com", teamId: teamId
    )
    let detail = VaultEntryDetail(
      id: entryId, title: "Team Fill", username: "alice",
      urlHost: "fill.example.com", teamId: teamId,
      password: "secret123", url: "https://fill.example.com"
    )
    let entry = try makeTeamCacheEntry(
      summary: summary, detail: detail, teamKey: teamKey,
      teamId: teamId, teamKeyVersion: 1, itemKeyVersion: 0
    )
    try buildCacheFile(
      at: cacheURL, entries: [entry], vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID, counter: blob.cacheVersionCounter,
      userId: "test-user-id"
    )
    try mockWKS.saveTeamKeys([wrappedStale])

    // Use injectable `now` set to a fixed time so the staleness check is deterministic.
    // The fixed now is after the stale window (issuedAt was 16 min ago from real Date()).
    let fixedNow = Date()
    let resolver = CredentialResolver(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: mockWKS,
      cacheURL: cacheURL,
      now: { fixedNow }
    )

    // First prime the retained blob via resolveCandidates (expected to throw teamKeyStale).
    do {
      _ = try await resolver.resolveCandidates(for: [])
    } catch CredentialResolver.Error.teamKeyStale {
      // expected — primes the retained blob in the process
    }

    // decryptEntryDetail must also refuse the stale team key and throw entryNotFound.
    do {
      _ = try await resolver.decryptEntryDetail(entryId: entryId)
      XCTFail("Expected entryNotFound for a stale team key in decryptEntryDetail (F3 regression)")
    } catch CredentialResolver.Error.entryNotFound {
      // expected: the staleness guard fires
    }
  }

  /// Full round-trip (T4 spirit): real generated passkey → blob builder →
  /// encryptPasskeyEntry → appendEntryToCache → decryptPasskeyMaterial →
  /// decodeP256PrivateKeyJWK recovers the SAME public key.
  func testRegisteredPasskey_isImmediatelyAssertableFromCache() async throws {
    let fixture = try makeRegistrationFixture()
    let entryId = "pk-roundtrip"
    let passkey = generatePasskey()
    let userHandle = Data([9, 8, 7])
    let (blobPlain, overviewPlain) = try PasskeyEntryBlobBuilder.buildCreate(
      rpId: "webauthn.io",
      rpName: "webauthn.io",
      userName: "alice",
      userHandle: userHandle,
      userDisplayName: "alice",
      passkey: passkey,
      creationDate: "2026-06-13T00:00:00.000Z"
    )
    let enc = try await fixture.resolver.encryptPasskeyEntry(
      entryId: entryId, blobPlaintext: blobPlain, overviewPlaintext: overviewPlain
    )
    try await fixture.resolver.appendEntryToCache(
      CacheEntry(
        id: entryId, teamId: nil, aadVersion: 1, keyVersion: enc.keyVersion,
        encryptedBlob: enc.encryptedBlob, encryptedOverview: enc.encryptedOverview,
        entryType: "PASSKEY"
      )
    )

    let material = try await fixture.resolver.decryptPasskeyMaterial(entryId: entryId)

    XCTAssertEqual(material.relyingPartyId, "webauthn.io")
    XCTAssertEqual(material.userHandle, base64URLEncode(userHandle))
    XCTAssertEqual(material.signCount, 0)
    let recovered = try decodeP256PrivateKeyJWK(material.privateKeyJWK)
    XCTAssertEqual(
      recovered.publicKey.rawRepresentation,
      passkey.privateKey.publicKey.rawRepresentation,
      "stored JWK must round-trip to the original key (bare-object encoding is a known failure mode)"
    )
  }
}
