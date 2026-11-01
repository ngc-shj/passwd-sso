import CryptoKit
import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

// MARK: - Null TeamDirectoryStore for tests

/// A no-op store that avoids App Group container access in tests.
private struct NullTeamDirectoryStore: TeamDirectoryStoring {
  func save(_ entries: [TeamDirectoryEntry], cacheKey: SymmetricKey, userId: String) throws {}
  func load(cacheKey: SymmetricKey, userId: String) -> [TeamDirectoryEntry] { [] }
  func clear() throws {}
}

/// Records the team ids of the last saved directory.
private final class RecordingTeamDirectoryStore: TeamDirectoryStoring, @unchecked Sendable {
  private let lock = NSLock()
  private var saved: [String] = []
  private var saves = 0
  var savedTeamIds: [String] { lock.withLock { saved } }
  var saveCount: Int { lock.withLock { saves } }
  func save(_ entries: [TeamDirectoryEntry], cacheKey: SymmetricKey, userId: String) throws {
    lock.withLock { saved = entries.map(\.id); saves += 1 }
  }
  func load(cacheKey: SymmetricKey, userId: String) -> [TeamDirectoryEntry] { [] }
  func clear() throws {}
}

// MARK: - Test helpers for HostSyncService

/// Pre-seed the mock keychain with v2-split items (bridge-key-v2 + bridge-meta-v2)
/// equivalent to a freshly-created BridgeKeyStore at the given counter.
func seedBlobInKeychain(
  _ keychain: MockKeychain,
  counter: UInt64 = 1,
  service: String = "com.passwd-sso.test.bridge-key"
) {
  let bridgeKey = Data(repeating: 0x01, count: 32)
  var meta = Data()
  let counterBE = counter.bigEndian
  withUnsafeBytes(of: counterBE) { meta.append(contentsOf: $0) }
  meta.append(contentsOf: Data(repeating: 0x02, count: 16))  // uuid
  keychain.store["\(service)-v2:blob"] = bridgeKey
  let metaService = service.hasSuffix("bridge-key")
    ? service.replacingOccurrences(of: "bridge-key", with: "bridge-meta") + "-v2"
    : service + "-meta-v2"
  keychain.store["\(metaService):blob"] = meta
}

/// Mock keychain for BridgeKeyStore tests. Keys by `service:account` so the
/// V2 split layout (two services sharing account="blob") is modeled correctly.
final class MockKeychain: KeychainAccessor, @unchecked Sendable {
  var store: [String: Data] = [:]

  private func key(_ query: [String: Any]) -> String {
    let service = query[kSecAttrService as String] as? String ?? ""
    let account = query[kSecAttrAccount as String] as? String ?? ""
    return "\(service):\(account)"
  }

  func add(query: [String: Any]) -> OSStatus {
    guard let data = query[kSecValueData as String] as? Data else {
      return errSecParam
    }
    let k = key(query)
    if store[k] != nil { return errSecDuplicateItem }
    store[k] = data
    return errSecSuccess
  }

  func copyMatching(query: [String: Any]) -> (OSStatus, Data?) {
    let k = key(query)
    guard let data = store[k] else { return (errSecItemNotFound, nil) }
    return (errSecSuccess, data)
  }

  func update(query: [String: Any], attributes: [String: Any]) -> OSStatus {
    guard let data = attributes[kSecValueData as String] as? Data else {
      return errSecParam
    }
    let k = key(query)
    store[k] = data
    return errSecSuccess
  }

  func delete(query: [String: Any]) -> OSStatus {
    let k = key(query)
    if store.removeValue(forKey: k) != nil { return errSecSuccess }
    return errSecItemNotFound
  }
}

// MARK: - Test-only HostSyncService using real cache writes to a temp directory

/// Exercising the atomic write + counter increment ordering.
final class HostSyncServiceTests: XCTestCase {

  private var tmpDir: URL!

  override func setUp() {
    super.setUp()
    tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "HostSyncServiceTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: tmpDir)
    super.tearDown()
  }

  // MARK: - Counter increment ordering

  func testSyncIncrementsCounterAfterCacheWrite() async throws {
    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 10)

    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let cacheURL = tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)

    let vaultKey = SymmetricKey(size: .bits256)

    // Run a minimal sync using the StubHostSyncService
    let stub = StubHostSyncService(
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      vaultKey: vaultKey,
      entries: []
    )
    let report = try await stub.runSync()

    // Verify the blob counter is now 11
    let blob = try bks.readDirect()
    XCTAssertEqual(blob.cacheVersionCounter, 11)

    // Verify the cache file exists
    XCTAssertTrue(FileManager.default.fileExists(atPath: cacheURL.path))

    // Verify cache is readable with the new counter
    _ = try readCacheFile(
      path: cacheURL,
      vaultKey: vaultKey,
      expectedHostInstallUUID: blob.hostInstallUUID,
      expectedCounter: 11
    )

    XCTAssertEqual(report.entriesFetched, 0)
    XCTAssertGreaterThan(report.cacheBytesWritten, 0)
  }

  func testSyncWithEntries() async throws {
    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 5)

    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let cacheURL = tmpDir.appending(path: "test2.cache", directoryHint: .notDirectory)

    let vaultKey = SymmetricKey(size: .bits256)

    // Build some fake entries
    let dummyEncData = EncryptedData(
      ciphertext: hexEncode(Data(repeating: 0xAA, count: 32)),
      iv: hexEncode(Data(repeating: 0xBB, count: 12)),
      authTag: hexEncode(Data(repeating: 0xCC, count: 16))
    )
    let entries = [
      EncryptedEntry(
        id: "entry-1",
        encryptedOverview: dummyEncData,
        encryptedBlob: dummyEncData
      ),
      EncryptedEntry(
        id: "entry-2",
        encryptedOverview: dummyEncData,
        encryptedBlob: dummyEncData
      ),
    ]

    let stub = StubHostSyncService(
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      vaultKey: vaultKey,
      entries: entries
    )
    let report = try await stub.runSync()

    XCTAssertEqual(report.entriesFetched, 2)

    // Counter should have advanced from 5 → 6
    let blob = try bks.readDirect()
    XCTAssertEqual(blob.cacheVersionCounter, 6)
  }

  /// T1 (FR1 end-to-end healing): starting from NO cache file at all (the worst case
  /// the biometric cacheRecovered=false path lands in), runSync must rebuild a cache
  /// that is readable at the new counter with the fetched entries — proving the
  /// resync heals a missing/stale cache rather than leaving the vault empty.
  func testSyncHealsAbsentCache() async throws {
    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 42)
    let bks = BridgeKeyStore(
      accessGroup: "test", service: "com.passwd-sso.test.bridge-key", keychain: keychain)
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let cacheURL = tmpDir.appending(path: "heal.cache", directoryHint: .notDirectory)
    // Precondition: no cache file exists.
    XCTAssertFalse(FileManager.default.fileExists(atPath: cacheURL.path))

    let vaultKey = SymmetricKey(size: .bits256)
    let dummyEncData = EncryptedData(
      ciphertext: hexEncode(Data(repeating: 0xAA, count: 32)),
      iv: hexEncode(Data(repeating: 0xBB, count: 12)),
      authTag: hexEncode(Data(repeating: 0xCC, count: 16)))
    let entries = [EncryptedEntry(id: "e1", encryptedOverview: dummyEncData, encryptedBlob: dummyEncData)]

    let stub = StubHostSyncService(
      bridgeKeyStore: bks, wrappedKeyStore: wks, cacheURL: cacheURL,
      vaultKey: vaultKey, entries: entries)
    let report = try await stub.runSync()

    XCTAssertEqual(report.entriesFetched, 1)
    let blob = try bks.readDirect()
    XCTAssertEqual(blob.cacheVersionCounter, 43, "counter advanced 42 → 43")
    // The rebuilt cache must be readable at the new counter (heals the absent cache).
    let rebuilt = try readCacheFile(
      path: cacheURL, vaultKey: vaultKey,
      expectedHostInstallUUID: blob.hostInstallUUID, expectedCounter: 43)
    XCTAssertEqual(rebuilt.header.entryCount, 1, "rebuilt cache carries the fetched entry")
  }

  // MARK: - Team key refresh: happy path using fixture

  /// performSync with the fixture ECDH blob + team member-key endpoint → the stored
  /// WrappedTeamKey decrypts to the fixture's teamEncKeyHex.
  func testRefreshTeamKeys_writesTeamKeyUnwrappedToFixtureEncKey() async throws {
    // Load the fixture.
    let bundle = Bundle(for: type(of: self))
    let fixtureURL = try XCTUnwrap(
      bundle.url(forResource: "team-key-fixture", withExtension: "json")
        ?? bundle.url(forResource: "team-key-fixture", withExtension: "json", subdirectory: "fixtures"),
      "team-key-fixture.json must be bundled in the test target"
    )
    struct Fixture: Decodable {
      struct EncData: Decodable { let ciphertext: String; let iv: String; let authTag: String }
      let secretKeyHex: String
      let encryptedEcdhPrivateKey: EncData
      let teamId: String; let toUserId: String
      let keyVersion: Int; let wrapVersion: Int
      let hkdfSaltHex: String
      let encryptedTeamKey: EncData
      let ephemeralPublicKeyJwk: String
      let teamEncKeyHex: String
    }
    let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))

    // Derive a real cacheKey and wrap the ECDH key under it.
    let cacheKey = SymmetricKey(size: .bits256)
    let userId = f.toUserId

    let secretKeyBytes = try hexDecode(f.secretKeyHex)
    let ecdhWrappingKey = TeamKeyCrypto.deriveEcdhWrappingKey(
      secretKey: SymmetricKey(data: secretKeyBytes))
    let memberKey = try TeamKeyCrypto.unwrapEcdhPrivateKey(
      encrypted: EncryptedData(
        ciphertext: f.encryptedEcdhPrivateKey.ciphertext,
        iv: f.encryptedEcdhPrivateKey.iv,
        authTag: f.encryptedEcdhPrivateKey.authTag),
      wrappingKey: ecdhWrappingKey)
    var pkcs8 = memberKey.derRepresentation
    defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }
    let wrappedEcdh = try TeamEntryDecryptor.wrapEcdhPrivateKey(
      pkcs8: pkcs8, cacheKey: cacheKey, userId: userId, issuedAt: Date())

    // Set up the real infrastructure.
    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 1, service: "com.passwd-sso.test.team-sync.bridge-key")
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.team-sync.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    try wks.saveECDHPrivateKey(wrappedEcdh)
    let cacheURL = tmpDir.appending(path: "team-sync.cache", directoryHint: .notDirectory)

    // Build the vault key.
    let vaultKey = SymmetricKey(size: .bits256)

    // Wire MockURLProtocol stubs.
    let fakeKeychain = FakeKeychain()
    let tokenStore = HostTokenStore(service: "com.test.team-sync.tokens", keychain: fakeKeychain)
    try? tokenStore.saveTokens(
      access: "acc_team_sync",
      refresh: "ref_team_sync",
      expiresAt: Date().addingTimeInterval(3600)
    )
    let session = makeSession()

    let teamId = f.teamId

    // Pre-encode the member-key response so the closure captures Data (not throwing).
    // ephemeralPublicKey is a String field — use Codable to avoid manual JSON escaping.
    struct MemberKeyBody: Encodable {
      let encryptedTeamKey: String; let teamKeyIv: String; let teamKeyAuthTag: String
      let ephemeralPublicKey: String; let hkdfSalt: String
      let keyVersion: Int; let wrapVersion: Int
    }
    let memberKeyBody = MemberKeyBody(
      encryptedTeamKey: f.encryptedTeamKey.ciphertext,
      teamKeyIv: f.encryptedTeamKey.iv,
      teamKeyAuthTag: f.encryptedTeamKey.authTag,
      ephemeralPublicKey: f.ephemeralPublicKeyJwk,
      hkdfSalt: f.hkdfSaltHex,
      keyVersion: f.keyVersion,
      wrapVersion: f.wrapVersion
    )
    let memberKeyData = try JSONEncoder().encode(memberKeyBody)
    let teamsListData = Data(#"[{"id":"\#(teamId)","name":"Fixture Team"}]"#.utf8)

    MockURLProtocol.requestHandler = { request in
      let path = request.url?.path ?? ""
      let baseURL = URL(string: "https://test.team-sync.example")!
      if path.hasSuffix("/api/passwords") {
        return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
      }
      if path.hasSuffix("/api/teams") {
        return (teamsListData, httpResponse(status: 200, url: request.url!))
      }
      if path.contains("/passwords") && path.contains(teamId) {
        return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
      }
      if path.hasSuffix("/member-key") && path.contains(teamId) {
        return (memberKeyData, httpResponse(status: 200, url: request.url!))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: baseURL))
    }

    let apiClient = MobileAPIClient(
      serverURL: URL(string: "https://test.team-sync.example")!,
      signer: FakeSigner(),
      jwk: ["kty": "EC", "crv": "P-256",
            "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
      tokenStore: tokenStore,
      urlSession: session
    )
    let fetcher = EntryFetcher(apiClient: apiClient)
    let syncService = HostSyncService(
      apiClient: apiClient,
      entryFetcher: fetcher,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      teamDirectoryStore: NullTeamDirectoryStore()
    )

    let now = Date()
    _ = try await syncService.runSync(vaultKey: vaultKey, userId: userId, cacheKey: cacheKey)

    // The stored team key must unwrap to the fixture's teamEncKeyHex.
    let storedKeys = try wks.loadTeamKeys()
    let storedKey = try XCTUnwrap(storedKeys.first(where: { $0.teamId == teamId }),
      "A WrappedTeamKey must be stored for the fixture team after sync")

    let unwrapped = try XCTUnwrap(
      TeamEntryDecryptor.unwrapTeamKey(storedKey, cacheKey: cacheKey, userId: userId),
      "Stored WrappedTeamKey must unwrap under the test cacheKey"
    )
    let unwrappedHex = unwrapped.withUnsafeBytes { hexEncode(Data($0)) }
    XCTAssertEqual(unwrappedHex, f.teamEncKeyHex,
      "Unwrapped team enc key must match the fixture's teamEncKeyHex")

    // Issued-at must be recent (within 5 seconds of now).
    XCTAssertLessThanOrEqual(abs(storedKey.issuedAt.timeIntervalSince(now)), 5)
  }

  // MARK: - No ECDH key: non-empty non-stale set → unchanged

  /// When the ECDH key is absent but the existing team-key set is non-empty and
  /// NOT all stale, performSync must leave the set unchanged (not wipe it).
  func testRefreshTeamKeys_noECDH_nonStaleSet_unchanged() async throws {
    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 1, service: "com.passwd-sso.test.noecdh-fresh.bridge-key")
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.noecdh-fresh.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    // No ECDH key — wks has no ECDHPrivateKey.

    // Seed a fresh (non-stale) team key.
    let cacheKey = SymmetricKey(size: .bits256)
    let teamKey = SymmetricKey(size: .bits256)
    let wrappedTeamKey = try TeamEntryDecryptor.wrapTeamKey(
      teamEncKey: teamKey, cacheKey: cacheKey, userId: "no-ecdh-user",
      teamId: "team-noecdh-fresh", teamKeyVersion: 1, issuedAt: Date()
    )
    try wks.saveTeamKeys([wrappedTeamKey])

    let fakeKeychain = FakeKeychain()
    let tokenStore = HostTokenStore(service: "com.test.noecdh-fresh.tokens", keychain: fakeKeychain)
    try? tokenStore.saveTokens(
      access: "acc_noecdh_fresh", refresh: "ref_noecdh_fresh",
      expiresAt: Date().addingTimeInterval(3600)
    )
    let session = makeSession()

    MockURLProtocol.requestHandler = { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/api/passwords") {
        return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
      }
      if path.hasSuffix("/api/teams") {
        return (Data(#"[{"id":"team-noecdh-fresh","name":"No ECDH Fresh"}]"#.utf8),
                httpResponse(status: 200, url: request.url!))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let vaultKey = SymmetricKey(size: .bits256)
    let apiClient = MobileAPIClient(
      serverURL: URL(string: "https://test.noecdh-fresh.example")!,
      signer: FakeSigner(),
      jwk: ["kty": "EC", "crv": "P-256",
            "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
      tokenStore: tokenStore,
      urlSession: session
    )
    let fetcher = EntryFetcher(apiClient: apiClient)
    let cacheURL = tmpDir.appending(path: "noecdh-fresh.cache", directoryHint: .notDirectory)
    let syncService = HostSyncService(
      apiClient: apiClient,
      entryFetcher: fetcher,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      teamDirectoryStore: NullTeamDirectoryStore()
    )

    _ = try await syncService.runSync(vaultKey: vaultKey, userId: "no-ecdh-user", cacheKey: cacheKey)

    // The existing non-stale team key must still be present.
    let remaining = try wks.loadTeamKeys()
    XCTAssertEqual(remaining.count, 1,
      "Non-stale team key set must be left unchanged when ECDH key is absent")
    XCTAssertEqual(remaining.first?.teamId, "team-noecdh-fresh")
  }

  // MARK: - No ECDH key: all-stale set → cleared

  func testRefreshTeamKeys_noECDH_allStaleSet_cleared() async throws {
    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 1, service: "com.passwd-sso.test.noecdh-stale.bridge-key")
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.noecdh-stale.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)

    // Seed an all-stale team key (issued 20 min ago → past the 15-min window).
    let cacheKey = SymmetricKey(size: .bits256)
    let teamKey = SymmetricKey(size: .bits256)
    let staleIssuedAt = Date().addingTimeInterval(-20 * 60)
    let staleTeamKey = try TeamEntryDecryptor.wrapTeamKey(
      teamEncKey: teamKey, cacheKey: cacheKey, userId: "stale-user",
      teamId: "team-stale", teamKeyVersion: 1, issuedAt: staleIssuedAt
    )
    try wks.saveTeamKeys([staleTeamKey])

    let fakeKeychain = FakeKeychain()
    let tokenStore = HostTokenStore(service: "com.test.noecdh-stale.tokens", keychain: fakeKeychain)
    try? tokenStore.saveTokens(
      access: "acc_stale", refresh: "ref_stale",
      expiresAt: Date().addingTimeInterval(3600)
    )
    let session = makeSession()

    MockURLProtocol.requestHandler = { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/api/passwords") {
        return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
      }
      if path.hasSuffix("/api/teams") {
        return (Data(#"[{"id":"team-stale","name":"Stale Team"}]"#.utf8),
                httpResponse(status: 200, url: request.url!))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let vaultKey = SymmetricKey(size: .bits256)
    let apiClient = MobileAPIClient(
      serverURL: URL(string: "https://test.noecdh-stale.example")!,
      signer: FakeSigner(),
      jwk: ["kty": "EC", "crv": "P-256",
            "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
      tokenStore: tokenStore,
      urlSession: session
    )
    let fetcher = EntryFetcher(apiClient: apiClient)
    let cacheURL = tmpDir.appending(path: "noecdh-stale.cache", directoryHint: .notDirectory)
    let syncService = HostSyncService(
      apiClient: apiClient,
      entryFetcher: fetcher,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      teamDirectoryStore: NullTeamDirectoryStore()
    )

    _ = try await syncService.runSync(vaultKey: vaultKey, userId: "stale-user", cacheKey: cacheKey)

    let remaining = try wks.loadTeamKeys()
    XCTAssertTrue(remaining.isEmpty,
      "All-stale team key set must be cleared when ECDH key is absent")
  }

  // MARK: - Per-team teamKeyNotDistributed → team absent, others written

  func testRefreshTeamKeys_oneTeamNotDistributed_otherTeamWritten() async throws {
    let bundle = Bundle(for: type(of: self))
    let fixtureURL = try XCTUnwrap(
      bundle.url(forResource: "team-key-fixture", withExtension: "json")
        ?? bundle.url(forResource: "team-key-fixture", withExtension: "json", subdirectory: "fixtures")
    )
    struct FixtureMin: Decodable {
      struct EncData: Decodable { let ciphertext: String; let iv: String; let authTag: String }
      let secretKeyHex: String
      let encryptedEcdhPrivateKey: EncData
      let teamId: String; let toUserId: String
      let keyVersion: Int; let wrapVersion: Int
      let hkdfSaltHex: String
      let encryptedTeamKey: EncData
      let ephemeralPublicKeyJwk: String
      let teamEncKeyHex: String
    }
    let f = try JSONDecoder().decode(FixtureMin.self, from: Data(contentsOf: fixtureURL))

    let cacheKey = SymmetricKey(size: .bits256)
    let userId = f.toUserId

    let secretKeyBytes = try hexDecode(f.secretKeyHex)
    let ecdhWrappingKey = TeamKeyCrypto.deriveEcdhWrappingKey(
      secretKey: SymmetricKey(data: secretKeyBytes))
    let memberKey = try TeamKeyCrypto.unwrapEcdhPrivateKey(
      encrypted: EncryptedData(
        ciphertext: f.encryptedEcdhPrivateKey.ciphertext,
        iv: f.encryptedEcdhPrivateKey.iv,
        authTag: f.encryptedEcdhPrivateKey.authTag),
      wrappingKey: ecdhWrappingKey)
    var pkcs8 = memberKey.derRepresentation
    defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }
    let wrappedEcdh = try TeamEntryDecryptor.wrapEcdhPrivateKey(
      pkcs8: pkcs8, cacheKey: cacheKey, userId: userId, issuedAt: Date())

    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 1, service: "com.passwd-sso.test.two-teams.bridge-key")
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.two-teams.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    try wks.saveECDHPrivateKey(wrappedEcdh)

    let goodTeamId = f.teamId
    let badTeamId = "team-not-distributed"
    // Answered with the good team's key material, which is bound to the good
    // team's id and so does not unwrap for this one: skipped, not fatal.
    let badKeyTeamId = "team-bad-key-material"

    let fakeKeychain2 = FakeKeychain()
    let tokenStore2 = HostTokenStore(service: "com.test.two-teams.tokens", keychain: fakeKeychain2)
    try? tokenStore2.saveTokens(
      access: "acc_two_teams", refresh: "ref_two_teams",
      expiresAt: Date().addingTimeInterval(3600)
    )
    let session2 = makeSession()

    // Pre-encode the good-team member-key response.
    struct MemberKeyBody2: Encodable {
      let encryptedTeamKey: String; let teamKeyIv: String; let teamKeyAuthTag: String
      let ephemeralPublicKey: String; let hkdfSalt: String
      let keyVersion: Int; let wrapVersion: Int
    }
    let goodMemberKeyData = try JSONEncoder().encode(MemberKeyBody2(
      encryptedTeamKey: f.encryptedTeamKey.ciphertext,
      teamKeyIv: f.encryptedTeamKey.iv,
      teamKeyAuthTag: f.encryptedTeamKey.authTag,
      ephemeralPublicKey: f.ephemeralPublicKeyJwk,
      hkdfSalt: f.hkdfSaltHex,
      keyVersion: f.keyVersion,
      wrapVersion: f.wrapVersion
    ))
    let twoTeamsListData = Data("""
    [{"id":"\(goodTeamId)","name":"Good Team"},{"id":"\(badTeamId)","name":"Bad Team"},
     {"id":"\(badKeyTeamId)","name":"Bad Key Team"}]
    """.utf8)

    MockURLProtocol.requestHandler = { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/api/passwords") {
        return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
      }
      if path.hasSuffix("/api/teams") {
        return (twoTeamsListData, httpResponse(status: 200, url: request.url!))
      }
      // Team entries endpoint for both teams.
      if path.contains("/passwords") {
        return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
      }
      // member-key: good team → real fixture data; bad team → 403.
      if path.hasSuffix("/member-key") {
        if path.contains(badKeyTeamId) {
          return (goodMemberKeyData, httpResponse(status: 200, url: request.url!))
        }
        if path.contains(goodTeamId) {
          return (goodMemberKeyData, httpResponse(status: 200, url: request.url!))
        } else {
          // 403 KEY_NOT_DISTRIBUTED for badTeamId.
          return (Data(#"{"error":"KEY_NOT_DISTRIBUTED"}"#.utf8),
                  httpResponse(status: 403, url: request.url!))
        }
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let vaultKey = SymmetricKey(size: .bits256)
    let apiClient2 = MobileAPIClient(
      serverURL: URL(string: "https://test.two-teams.example")!,
      signer: FakeSigner(),
      jwk: ["kty": "EC", "crv": "P-256",
            "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
      tokenStore: tokenStore2,
      urlSession: session2
    )
    let fetcher2 = EntryFetcher(apiClient: apiClient2)
    let cacheURL2 = tmpDir.appending(path: "two-teams.cache", directoryHint: .notDirectory)
    let directory = RecordingTeamDirectoryStore()
    let syncService2 = HostSyncService(
      apiClient: apiClient2,
      entryFetcher: fetcher2,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL2,
      teamDirectoryStore: directory
    )

    _ = try await syncService2.runSync(vaultKey: vaultKey, userId: userId, cacheKey: cacheKey)

    let stored = try wks.loadTeamKeys()
    // Good team must be present.
    XCTAssertNotNil(stored.first(where: { $0.teamId == goodTeamId }),
      "Good team with distributed key must appear in stored team keys")
    // Bad team must be absent.
    XCTAssertNil(stored.first(where: { $0.teamId == badTeamId }),
      "Team with KEY_NOT_DISTRIBUTED must be absent from stored team keys")
    XCTAssertNil(stored.first(where: { $0.teamId == badKeyTeamId }),
      "Team whose key material does not unwrap must be skipped, not fail the sync")
    // Every membership is labelled, keys or not — saved once, with the cache.
    XCTAssertEqual(directory.savedTeamIds, [goodTeamId, badTeamId, badKeyTeamId])
    XCTAssertEqual(directory.saveCount, 1)
  }

  func testPersonalCacheEntryPropagatesEntryType() {
    let enc = EncryptedData(ciphertext: "00", iv: "00", authTag: "00")
    let passkey = EncryptedEntry(
      id: "pk1", encryptedOverview: enc, encryptedBlob: enc, entryType: "PASSKEY"
    )
    XCTAssertEqual(passkey.toPersonalCacheEntry().entryType, "PASSKEY")

    let login = EncryptedEntry(id: "e1", encryptedOverview: enc, encryptedBlob: enc)
    XCTAssertEqual(login.toPersonalCacheEntry().entryType, "LOGIN")
  }

  // MARK: - F1 regression: transient /api/teams error must NOT wipe valid team keys

  /// Regression for F1: when fetchTeamMemberships() receives an HTTP 500 (transient,
  /// non-auth error), the sync fails and keeps the fresh team keys (expired ones
  /// are pruned).
  /// Originally the code called saveTeamKeys([]) wiping valid persisted keys; later
  /// it went on personal-only and wrote a cache without the user's teams (#989).
  func testRunSync_teamListError_failsSyncAndKeepsKeys() async throws {
    let bundle = Bundle(for: type(of: self))
    let fixtureURL = try XCTUnwrap(
      bundle.url(forResource: "team-key-fixture", withExtension: "json")
        ?? bundle.url(forResource: "team-key-fixture", withExtension: "json", subdirectory: "fixtures")
    )
    struct FixtureMin: Decodable {
      struct EncData: Decodable { let ciphertext: String; let iv: String; let authTag: String }
      let secretKeyHex: String
      let encryptedEcdhPrivateKey: EncData
      let teamId: String; let toUserId: String
      let keyVersion: Int; let wrapVersion: Int
    }
    let f = try JSONDecoder().decode(FixtureMin.self, from: Data(contentsOf: fixtureURL))

    let cacheKey = SymmetricKey(size: .bits256)
    let userId = f.toUserId

    // Wrap the ECDH private key so it IS available (not the no-ECDH branch).
    let secretKeyBytes = try hexDecode(f.secretKeyHex)
    let ecdhWrappingKey = TeamKeyCrypto.deriveEcdhWrappingKey(
      secretKey: SymmetricKey(data: secretKeyBytes))
    let memberKey = try TeamKeyCrypto.unwrapEcdhPrivateKey(
      encrypted: EncryptedData(
        ciphertext: f.encryptedEcdhPrivateKey.ciphertext,
        iv: f.encryptedEcdhPrivateKey.iv,
        authTag: f.encryptedEcdhPrivateKey.authTag),
      wrappingKey: ecdhWrappingKey)
    var pkcs8 = memberKey.derRepresentation
    defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }
    let wrappedEcdh = try TeamEntryDecryptor.wrapEcdhPrivateKey(
      pkcs8: pkcs8, cacheKey: cacheKey, userId: userId, issuedAt: Date())

    // Seed infrastructure.
    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 1,
                       service: "com.passwd-sso.test.transient-teams.bridge-key")
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.transient-teams.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    try wks.saveECDHPrivateKey(wrappedEcdh)

    // Seed a fresh (non-stale) team key in the wrapped key store.
    let existingTeamKey = SymmetricKey(size: .bits256)
    let existingWrapped = try TeamEntryDecryptor.wrapTeamKey(
      teamEncKey: existingTeamKey, cacheKey: cacheKey, userId: userId,
      teamId: f.teamId, teamKeyVersion: 1, issuedAt: Date()
    )
    // A key past the staleness window decrypts nothing: a failed sync drops it.
    let expiredWrapped = try TeamEntryDecryptor.wrapTeamKey(
      teamEncKey: SymmetricKey(size: .bits256), cacheKey: cacheKey, userId: userId,
      teamId: "team-expired", teamKeyVersion: 1, issuedAt: Date().addingTimeInterval(-20 * 60)
    )
    try wks.saveTeamKeys([existingWrapped, expiredWrapped])

    let fakeKeychain = FakeKeychain()
    let tokenStore = HostTokenStore(
      service: "com.test.transient-teams.tokens", keychain: fakeKeychain)
    try? tokenStore.saveTokens(
      access: "acc_transient", refresh: "ref_transient",
      expiresAt: Date().addingTimeInterval(3600)
    )
    let session = makeSession()

    // Stub: /api/passwords → 200 [], /api/teams → HTTP 500 (transient, non-auth error).
    MockURLProtocol.requestHandler = { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/api/passwords") {
        return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
      }
      if path.hasSuffix("/api/teams") {
        // HTTP 500 is a transient server error — not authenticationRequired.
        return (Data(#"{"error":"internal"}"#.utf8),
                httpResponse(status: 500, url: request.url!))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let vaultKey = SymmetricKey(size: .bits256)
    let apiClient = MobileAPIClient(
      serverURL: URL(string: "https://test.transient-teams.example")!,
      signer: FakeSigner(),
      jwk: ["kty": "EC", "crv": "P-256",
            "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
      tokenStore: tokenStore,
      urlSession: session
    )
    let fetcher = EntryFetcher(apiClient: apiClient)
    let cacheURL = tmpDir.appending(path: "transient-teams.cache", directoryHint: .notDirectory)
    let syncService = HostSyncService(
      apiClient: apiClient,
      entryFetcher: fetcher,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      teamDirectoryStore: NullTeamDirectoryStore()
    )

    do {
      _ = try await syncService.runSync(vaultKey: vaultKey, userId: userId, cacheKey: cacheKey)
      XCTFail("expected the sync to fail on a transient team-list error")
    } catch MobileAPIError.serverError(status: 500) {
      XCTAssertFalse(FileManager.default.fileExists(atPath: cacheURL.path),
        "no cache is written without the user's teams")
    }

    // The fresh team key must still be present, NOT wiped (F1 regression);
    // only the expired one is gone.
    XCTAssertEqual(try wks.loadTeamKeys().map(\.teamId), [f.teamId])
  }

  // MARK: - PASSKEY_REQUIRED is not "no teams" / "key not distributed"

  private func makePasskeyIsolatedStore() -> (PasskeyRequirementStore, () -> Void) {
    let name = "com.test.host-sync.passkey.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    return (PasskeyRequirementStore(defaults: defaults), { defaults.removePersistentDomain(forName: name) })
  }

  /// A passkey refusal of /api/teams used to read as a transient failure
  /// (proceed with no teams) and the sync "succeeded" personal-only.
  func testRunSync_teamsRefusedForPasskey_throwsPasskeyRequired() async throws {
    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 1, service: "com.passwd-sso.test.passkey-teams.bridge-key")
    let bks = BridgeKeyStore(
      accessGroup: "test", service: "com.passwd-sso.test.passkey-teams.bridge-key", keychain: keychain)
    let tokenStore = HostTokenStore(service: "com.test.passkey-teams.tokens", keychain: FakeKeychain())
    try? tokenStore.saveTokens(
      access: "acc_pk", refresh: "ref_pk", expiresAt: Date().addingTimeInterval(3600))
    let (store, cleanup) = makePasskeyIsolatedStore()
    defer { cleanup() }

    MockURLProtocol.requestHandler = { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/api/teams") {
        return (Data(#"{"error":"PASSKEY_REQUIRED"}"#.utf8), httpResponse(status: 403, url: request.url!))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let apiClient = MobileAPIClient(
      serverURL: URL(string: "https://test.passkey-teams.example")!,
      signer: FakeSigner(),
      jwk: ["kty": "EC", "crv": "P-256",
            "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
      tokenStore: tokenStore,
      urlSession: makeSession(),
      passkeyRequirement: store
    )
    let syncService = HostSyncService(
      apiClient: apiClient,
      entryFetcher: EntryFetcher(apiClient: apiClient),
      bridgeKeyStore: bks,
      wrappedKeyStore: TempDirWrappedKeyStore(baseDir: tmpDir),
      cacheURL: tmpDir.appending(path: "passkey-teams.cache", directoryHint: .notDirectory),
      teamDirectoryStore: NullTeamDirectoryStore()
    )

    do {
      _ = try await syncService.runSync(vaultKey: SymmetricKey(size: .bits256), userId: "u-1")
      XCTFail("expected passkeyRequired")
    } catch {
      XCTAssertEqual(error as? MobileAPIError, .passkeyRequired)
    }
  }

  // MARK: - One team's entry fetch failing (#989)

  private func makeTeamFetchSync(
    _ name: String, bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: (any WrappedKeyStore)? = nil,
    teamDirectoryStore: any TeamDirectoryStoring = NullTeamDirectoryStore()
  ) -> (HostSyncService, URL) {
    let tokenStore = HostTokenStore(service: "com.test.\(name).tokens", keychain: FakeKeychain())
    try? tokenStore.saveTokens(
      access: "acc_\(name)", refresh: "ref_\(name)", expiresAt: Date().addingTimeInterval(3600))
    let apiClient = MobileAPIClient(
      serverURL: URL(string: "https://test.\(name).example")!,
      signer: FakeSigner(),
      jwk: ["kty": "EC", "crv": "P-256",
            "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
      tokenStore: tokenStore,
      urlSession: makeSession()
    )
    let cacheURL = tmpDir.appending(path: "\(name).cache", directoryHint: .notDirectory)
    let service = HostSyncService(
      apiClient: apiClient,
      entryFetcher: EntryFetcher(apiClient: apiClient),
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: wrappedKeyStore ?? TempDirWrappedKeyStore(baseDir: tmpDir),
      cacheURL: cacheURL,
      teamDirectoryStore: teamDirectoryStore
    )
    return (service, cacheURL)
  }

  private func makeBridgeKeyStore(_ name: String) -> BridgeKeyStore {
    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 1, service: "com.passwd-sso.test.\(name).bridge-key")
    return BridgeKeyStore(
      accessGroup: "test", service: "com.passwd-sso.test.\(name).bridge-key", keychain: keychain)
  }

  private static let twoTeams =
    Data(#"[{"id":"team-a","name":"Team A"},{"id":"team-b","name":"Team B"}]"#.utf8)
  private static let onePersonalEntry = Data(#"""
    [{"id":"entry-personal","encryptedOverview":{"ciphertext":"aa","iv":"bb","authTag":"cc"},
      "encryptedBlob":{"ciphertext":"dd","iv":"ee","authTag":"ff"},"keyVersion":1,
      "aadVersion":1,"entryType":"LOGIN","isFavorite":false,"isArchived":false}]
    """#.utf8)
  private static let teamBEntry = Data(#"""
    [{"id":"entry-team-b","encryptedOverview":"aa","overviewIv":"bb","overviewAuthTag":"cc",
      "encryptedBlob":"dd","blobIv":"ee","blobAuthTag":"ff","aadVersion":1,
      "teamKeyVersion":1,"itemKeyVersion":0,"isFavorite":false,"isArchived":false}]
    """#.utf8)
  private static let notFoundBody = Data(#"{"error":"NOT_FOUND"}"#.utf8)

  private func cachedEntries(_ report: SyncReport) throws -> [String] {
    let cacheData = try XCTUnwrap(report.cacheData)
    return try JSONDecoder().decode([CacheEntry].self, from: cacheData.entries)
      .map { "\($0.teamId ?? "personal")/\($0.id)" }
      .sorted()
  }

  /// A membership ended between the team list and that team's fetch (a tenant
  /// departure answers 404): the personal vault and the other teams still sync,
  /// and the departed team leaves the team directory.
  func testRunSync_oneTeamFetchNotFound_personalAndOtherTeamsStillSync() async throws {
    let bks = makeBridgeKeyStore("team-gone")
    let directory = RecordingTeamDirectoryStore()
    let threeTeams = Data(
      #"[{"id":"team-a","name":"A"},{"id":"team-b","name":"B"},{"id":"team-c","name":"C"}]"#.utf8)
    MockURLProtocol.requestHandler = { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/api/passwords") {
        return (Self.onePersonalEntry, httpResponse(status: 200, url: request.url!))
      }
      if path.hasSuffix("/api/teams") {
        return (threeTeams, httpResponse(status: 200, url: request.url!))
      }
      // team-c: refused by that team's IP policy — still a membership.
      if path.contains("/team-c/") {
        return (Data(#"{"error":"FORBIDDEN"}"#.utf8), httpResponse(status: 403, url: request.url!))
      }
      if path.contains("/team-a/") {
        return (Self.notFoundBody, httpResponse(status: 404, url: request.url!))
      }
      if path.contains("/team-b/passwords") {
        return (Self.teamBEntry, httpResponse(status: 200, url: request.url!))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let (sync, cacheURL) = makeTeamFetchSync(
      "team-gone", bridgeKeyStore: bks, teamDirectoryStore: directory)
    let report = try await sync.runSync(
      vaultKey: SymmetricKey(size: .bits256), userId: "u-1", cacheKey: SymmetricKey(size: .bits256))

    XCTAssertEqual(try cachedEntries(report), ["personal/entry-personal", "team-b/entry-team-b"])
    XCTAssertEqual(directory.savedTeamIds, ["team-b", "team-c"],
      "the departed team (404) leaves the directory; the refused one (403) stays")
    XCTAssertTrue(FileManager.default.fileExists(atPath: cacheURL.path))
    XCTAssertEqual(try bks.readDirect().cacheVersionCounter, 2)
  }

  /// Every team answering 404 (all memberships ended mid-sync): the cache is
  /// rewritten with the personal vault only, not left holding the teams.
  func testRunSync_everyTeamFetchNotFound_cachesPersonalOnly() async throws {
    let bks = makeBridgeKeyStore("teams-gone")
    MockURLProtocol.requestHandler = { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/api/passwords") {
        return (Self.onePersonalEntry, httpResponse(status: 200, url: request.url!))
      }
      if path.hasSuffix("/api/teams") {
        return (Self.twoTeams, httpResponse(status: 200, url: request.url!))
      }
      return (Self.notFoundBody, httpResponse(status: 404, url: request.url!))
    }

    let (sync, _) = makeTeamFetchSync("teams-gone", bridgeKeyStore: bks)
    let report = try await sync.runSync(vaultKey: SymmetricKey(size: .bits256), userId: "u-1")

    XCTAssertEqual(try cachedEntries(report), ["personal/entry-personal"])
    XCTAssertEqual(try bks.readDirect().cacheVersionCounter, 2)
  }

  /// Failures that are not one team's fail the sync: no cache is written and the
  /// counter stays, so the previous cache is left whole.
  func testRunSync_teamFetchFailureNotScopedToTeam_failsSyncWithoutWriting() async throws {
    // The expected error, matched by case and code (a URLError carries the
    // session's userInfo, so it is not Equatable to a fresh one).
    let cases: [(String, @Sendable (Error) -> Bool, @Sendable (URLRequest) throws -> (Data, HTTPURLResponse))] = [
      ("offline", { error in
        guard case .networkError(let urlError)? = error as? MobileAPIError else { return false }
        return urlError.code == .notConnectedToInternet
      }, { _ in
        throw URLError(.notConnectedToInternet)
      }),
      ("gateway", { ($0 as? MobileAPIError) == .serverError(status: 503) }, { request in
        (Data(#"{"error":"SERVICE_UNAVAILABLE"}"#.utf8), httpResponse(status: 503, url: request.url!))
      }),
    ]
    for (name, expected, teamBResponse) in cases {
      let bks = makeBridgeKeyStore("team-\(name)")
      MockURLProtocol.requestHandler = { request in
        let path = request.url?.path ?? ""
        if path.hasSuffix("/api/teams") {
          return (Self.twoTeams, httpResponse(status: 200, url: request.url!))
        }
        if path.contains("/team-b/") { return try teamBResponse(request) }
        return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
      }

      let (sync, cacheURL) = makeTeamFetchSync("team-\(name)", bridgeKeyStore: bks)
      do {
        _ = try await sync.runSync(vaultKey: SymmetricKey(size: .bits256), userId: "u-1")
        XCTFail("\(name): expected the sync to fail")
      } catch {
        XCTAssertTrue(expected(error), "\(name): \(error)")
      }
      XCTAssertFalse(FileManager.default.fileExists(atPath: cacheURL.path), "\(name): no cache written")
      XCTAssertEqual(try bks.readDirect().cacheVersionCounter, 1, name)
    }
  }

  func testIsTeamScopedFailure_classifiesEveryError() {
    let teamScoped: [Error] = [
      MobileAPIError.serverError(status: 404),
      MobileAPIError.serverError(status: 403),
      MobileAPIError.notFound,
      MobileAPIError.teamKeyNotDistributed,
      DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "bad")),
    ]
    let syncWide: [Error] = [
      MobileAPIError.serverError(status: 401),
      MobileAPIError.serverError(status: 429),
      MobileAPIError.serverError(status: 500),
      MobileAPIError.serverError(status: 502),
      MobileAPIError.serverError(status: 503),
      MobileAPIError.serverError(status: 504),
      MobileAPIError.rateLimited(retryAfter: 60),
      MobileAPIError.authenticationRequired,
      MobileAPIError.passkeyRequired,
      MobileAPIError.networkError(URLError(.timedOut)),
      MobileAPIError.dpopInvalid(newNonce: nil),
      MobileAPIError.bridgeCodeInvalid,
      MobileAPIError.pkceMismatch,
      MobileAPIError.quotaExceeded,
      CancellationError(),
      // A keychain / Secure Enclave failure once the device locks mid-sync.
      NSError(domain: NSOSStatusErrorDomain, code: Int(errSecInteractionNotAllowed)),
    ]
    for error in teamScoped {
      XCTAssertTrue(HostSyncService.isTeamScopedFailure(error), "\(error)")
    }
    for error in syncWide {
      XCTAssertFalse(HostSyncService.isTeamScopedFailure(error), "\(error)")
    }
  }

  /// The directory labels the cache: when writing the cache fails after every
  /// fetch succeeded, the directory is not saved either.
  func testRunSync_cacheWriteFails_directoryNotSaved() async throws {
    let bks = makeBridgeKeyStore("cache-unwritable")
    let directory = RecordingTeamDirectoryStore()
    MockURLProtocol.requestHandler = { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/api/teams") {
        return (Self.twoTeams, httpResponse(status: 200, url: request.url!))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }
    let (sync, cacheURL) = makeTeamFetchSync(
      "cache-unwritable", bridgeKeyStore: bks, teamDirectoryStore: directory)
    // A non-empty directory where the cache's temp file goes: the write fails.
    let blocker = cacheURL.deletingLastPathComponent()
      .appending(path: cacheURL.lastPathComponent + ".tmp", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: blocker, withIntermediateDirectories: true)
    try Data("x".utf8).write(to: blocker.appending(path: "keep", directoryHint: .notDirectory))

    do {
      _ = try await sync.runSync(
        vaultKey: SymmetricKey(size: .bits256), userId: "u-1", cacheKey: SymmetricKey(size: .bits256))
      XCTFail("expected the cache write to fail")
    } catch is EntryCacheError {}

    XCTAssertEqual(directory.saveCount, 0)
    XCTAssertEqual(try bks.readDirect().cacheVersionCounter, 1)
  }

  /// A successful sync (personal-only here: no cacheKey) also drops team keys
  /// past the staleness window and keeps the fresh ones.
  func testRunSync_success_prunesOnlyExpiredTeamKeys() async throws {
    let bks = makeBridgeKeyStore("prune-success")
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let cacheKey = SymmetricKey(size: .bits256)
    func key(_ teamId: String, age: TimeInterval) throws -> WrappedTeamKey {
      try TeamEntryDecryptor.wrapTeamKey(
        teamEncKey: SymmetricKey(size: .bits256), cacheKey: cacheKey, userId: "u-1",
        teamId: teamId, teamKeyVersion: 1, issuedAt: Date().addingTimeInterval(-age))
    }
    try wks.saveTeamKeys([try key("team-fresh", age: 60), try key("team-expired", age: 20 * 60)])
    MockURLProtocol.requestHandler = { request in
      (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let (sync, _) = makeTeamFetchSync("prune-success", bridgeKeyStore: bks, wrappedKeyStore: wks)
    _ = try await sync.runSync(vaultKey: SymmetricKey(size: .bits256), userId: "u-1")

    XCTAssertEqual(try wks.loadTeamKeys().map(\.teamId), ["team-fresh"])
  }

  func testIsMembershipGone_onlyWhenNotAMember() {
    XCTAssertTrue(HostSyncService.isMembershipGone(MobileAPIError.serverError(status: 404)))
    XCTAssertTrue(HostSyncService.isMembershipGone(MobileAPIError.notFound))
    XCTAssertFalse(HostSyncService.isMembershipGone(MobileAPIError.serverError(status: 403)))
    XCTAssertFalse(HostSyncService.isMembershipGone(MobileAPIError.teamKeyNotDistributed))
    XCTAssertFalse(HostSyncService.isMembershipGone(MobileAPIError.serverError(status: 503)))
    XCTAssertFalse(HostSyncService.isMembershipGone(
      DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "bad"))))
  }

  /// A transport failure on a member-key fetch fails the sync rather than being
  /// skipped: the team-key set is rewritten whole, so a skip would drop the key.
  func testRefreshTeamKeys_memberKeyNetworkError_failsSyncAndKeepsKeys() async throws {
    let bundle = Bundle(for: type(of: self))
    let fixtureURL = try XCTUnwrap(
      bundle.url(forResource: "team-key-fixture", withExtension: "json")
        ?? bundle.url(forResource: "team-key-fixture", withExtension: "json", subdirectory: "fixtures")
    )
    struct FixtureMin: Decodable {
      struct EncData: Decodable { let ciphertext: String; let iv: String; let authTag: String }
      let secretKeyHex: String
      let encryptedEcdhPrivateKey: EncData
      let teamId: String; let toUserId: String
    }
    let f = try JSONDecoder().decode(FixtureMin.self, from: Data(contentsOf: fixtureURL))
    let cacheKey = SymmetricKey(size: .bits256)
    let ecdhWrappingKey = TeamKeyCrypto.deriveEcdhWrappingKey(
      secretKey: SymmetricKey(data: try hexDecode(f.secretKeyHex)))
    let memberKey = try TeamKeyCrypto.unwrapEcdhPrivateKey(
      encrypted: EncryptedData(
        ciphertext: f.encryptedEcdhPrivateKey.ciphertext,
        iv: f.encryptedEcdhPrivateKey.iv,
        authTag: f.encryptedEcdhPrivateKey.authTag),
      wrappingKey: ecdhWrappingKey)
    var pkcs8 = memberKey.derRepresentation
    defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    try wks.saveECDHPrivateKey(try TeamEntryDecryptor.wrapEcdhPrivateKey(
      pkcs8: pkcs8, cacheKey: cacheKey, userId: f.toUserId, issuedAt: Date()))
    try wks.saveTeamKeys([try TeamEntryDecryptor.wrapTeamKey(
      teamEncKey: SymmetricKey(size: .bits256), cacheKey: cacheKey, userId: f.toUserId,
      teamId: f.teamId, teamKeyVersion: 1, issuedAt: Date())])

    let bks = makeBridgeKeyStore("member-key-offline")
    let teamId = f.teamId
    let teamsList = Data(#"[{"id":"\#(teamId)","name":"Fixture Team"}]"#.utf8)
    MockURLProtocol.requestHandler = { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/api/teams") {
        return (teamsList, httpResponse(status: 200, url: request.url!))
      }
      if path.hasSuffix("/member-key") { throw URLError(.networkConnectionLost) }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let directory = RecordingTeamDirectoryStore()
    let (sync, _) = makeTeamFetchSync(
      "member-key-offline", bridgeKeyStore: bks, wrappedKeyStore: wks, teamDirectoryStore: directory)
    do {
      _ = try await sync.runSync(vaultKey: SymmetricKey(size: .bits256), userId: f.toUserId, cacheKey: cacheKey)
      XCTFail("expected networkError")
    } catch MobileAPIError.networkError {}

    XCTAssertEqual(try wks.loadTeamKeys().map(\.teamId), [teamId], "the team key is not dropped")
    XCTAssertEqual(directory.saveCount, 0, "the directory stays with the unwritten cache")
    XCTAssertEqual(try bks.readDirect().cacheVersionCounter, 1)
  }

  /// A passkey refusal of a member-key fetch used to be skipped as "key not
  /// distributed", and the full rewrite then dropped the team's still-valid key.
  func testRefreshTeamKeys_memberKeyRefusedForPasskey_throwsAndKeepsKeys() async throws {
    let bundle = Bundle(for: type(of: self))
    let fixtureURL = try XCTUnwrap(
      bundle.url(forResource: "team-key-fixture", withExtension: "json")
        ?? bundle.url(forResource: "team-key-fixture", withExtension: "json", subdirectory: "fixtures")
    )
    struct FixtureMin: Decodable {
      struct EncData: Decodable { let ciphertext: String; let iv: String; let authTag: String }
      let secretKeyHex: String
      let encryptedEcdhPrivateKey: EncData
      let teamId: String; let toUserId: String
    }
    let f = try JSONDecoder().decode(FixtureMin.self, from: Data(contentsOf: fixtureURL))
    let cacheKey = SymmetricKey(size: .bits256)
    let userId = f.toUserId

    let ecdhWrappingKey = TeamKeyCrypto.deriveEcdhWrappingKey(
      secretKey: SymmetricKey(data: try hexDecode(f.secretKeyHex)))
    let memberKey = try TeamKeyCrypto.unwrapEcdhPrivateKey(
      encrypted: EncryptedData(
        ciphertext: f.encryptedEcdhPrivateKey.ciphertext,
        iv: f.encryptedEcdhPrivateKey.iv,
        authTag: f.encryptedEcdhPrivateKey.authTag),
      wrappingKey: ecdhWrappingKey)
    var pkcs8 = memberKey.derRepresentation
    defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }

    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 1, service: "com.passwd-sso.test.passkey-member-key.bridge-key")
    let bks = BridgeKeyStore(
      accessGroup: "test", service: "com.passwd-sso.test.passkey-member-key.bridge-key",
      keychain: keychain)
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    try wks.saveECDHPrivateKey(try TeamEntryDecryptor.wrapEcdhPrivateKey(
      pkcs8: pkcs8, cacheKey: cacheKey, userId: userId, issuedAt: Date()))
    try wks.saveTeamKeys([try TeamEntryDecryptor.wrapTeamKey(
      teamEncKey: SymmetricKey(size: .bits256), cacheKey: cacheKey, userId: userId,
      teamId: f.teamId, teamKeyVersion: 1, issuedAt: Date())])

    let tokenStore = HostTokenStore(service: "com.test.passkey-member-key.tokens", keychain: FakeKeychain())
    try? tokenStore.saveTokens(
      access: "acc_pk_mk", refresh: "ref_pk_mk", expiresAt: Date().addingTimeInterval(3600))
    let (store, cleanup) = makePasskeyIsolatedStore()
    defer { cleanup() }
    let teamsList = Data(#"[{"id":"\#(f.teamId)","name":"Team"}]"#.utf8)

    MockURLProtocol.requestHandler = { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/api/teams") {
        return (teamsList, httpResponse(status: 200, url: request.url!))
      }
      if path.hasSuffix("/member-key") {
        return (Data(#"{"error":"PASSKEY_REQUIRED"}"#.utf8), httpResponse(status: 403, url: request.url!))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let apiClient = MobileAPIClient(
      serverURL: URL(string: "https://test.passkey-member-key.example")!,
      signer: FakeSigner(),
      jwk: ["kty": "EC", "crv": "P-256",
            "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
      tokenStore: tokenStore,
      urlSession: makeSession(),
      passkeyRequirement: store
    )
    let syncService = HostSyncService(
      apiClient: apiClient,
      entryFetcher: EntryFetcher(apiClient: apiClient),
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: tmpDir.appending(path: "passkey-member-key.cache", directoryHint: .notDirectory),
      teamDirectoryStore: NullTeamDirectoryStore()
    )

    do {
      _ = try await syncService.runSync(
        vaultKey: SymmetricKey(size: .bits256), userId: userId, cacheKey: cacheKey)
      XCTFail("expected passkeyRequired")
    } catch {
      XCTAssertEqual(error as? MobileAPIError, .passkeyRequired)
    }
    XCTAssertEqual(try wks.loadTeamKeys().map(\.teamId), [f.teamId],
      "a passkey refusal must not wipe the persisted team keys")
  }

  // MARK: - F1 bonus: malformed ECDH + all-stale set → cleared

  /// Mirrors testRefreshTeamKeys_noECDH_allStaleSet_cleared but via the malformed-ECDH
  /// branch (importEcdhPrivateKey fails). Both code paths now route to clearTeamKeysIfAllStale.
  func testRefreshTeamKeys_malformedECDH_allStaleSet_cleared() async throws {
    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 1,
                       service: "com.passwd-sso.test.malformed-ecdh.bridge-key")
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.malformed-ecdh.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)

    // Store a WrappedECDHPrivateKey whose payload decrypts to garbage (not a valid P-256
    // PKCS#8 key). TeamEntryDecryptor.unwrapEcdhPrivateKey succeeds (returns the bytes),
    // but TeamKeyCrypto.importEcdhPrivateKey rejects them → same posture as "no ECDH".
    let cacheKey = SymmetricKey(size: .bits256)
    let userId = "malformed-user"
    // 32 bytes of garbage — decrypts fine, but not a valid PKCS#8 DER key.
    let garbagePKCS8 = Data(repeating: 0xDE, count: 32)
    let wrappedGarbageEcdh = try TeamEntryDecryptor.wrapEcdhPrivateKey(
      pkcs8: garbagePKCS8, cacheKey: cacheKey, userId: userId, issuedAt: Date()
    )
    try wks.saveECDHPrivateKey(wrappedGarbageEcdh)

    // Seed an all-stale team key (issued 20 min ago).
    let teamKey = SymmetricKey(size: .bits256)
    let staleIssuedAt = Date().addingTimeInterval(-20 * 60)
    let staleTeamKey = try TeamEntryDecryptor.wrapTeamKey(
      teamEncKey: teamKey, cacheKey: cacheKey, userId: userId,
      teamId: "team-malformed-stale", teamKeyVersion: 1, issuedAt: staleIssuedAt
    )
    try wks.saveTeamKeys([staleTeamKey])

    let fakeKeychain = FakeKeychain()
    let tokenStore = HostTokenStore(
      service: "com.test.malformed-ecdh.tokens", keychain: fakeKeychain)
    try? tokenStore.saveTokens(
      access: "acc_malformed", refresh: "ref_malformed",
      expiresAt: Date().addingTimeInterval(3600)
    )
    let session = makeSession()

    MockURLProtocol.requestHandler = { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/api/passwords") {
        return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
      }
      if path.hasSuffix("/api/teams") {
        return (Data(#"[{"id":"team-malformed-stale","name":"Malformed ECDH Team"}]"#.utf8),
                httpResponse(status: 200, url: request.url!))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let vaultKey = SymmetricKey(size: .bits256)
    let apiClient = MobileAPIClient(
      serverURL: URL(string: "https://test.malformed-ecdh.example")!,
      signer: FakeSigner(),
      jwk: ["kty": "EC", "crv": "P-256",
            "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
      tokenStore: tokenStore,
      urlSession: session
    )
    let fetcher = EntryFetcher(apiClient: apiClient)
    let cacheURL = tmpDir.appending(path: "malformed-ecdh.cache", directoryHint: .notDirectory)
    let syncService = HostSyncService(
      apiClient: apiClient,
      entryFetcher: fetcher,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      teamDirectoryStore: NullTeamDirectoryStore()
    )

    _ = try await syncService.runSync(vaultKey: vaultKey, userId: userId, cacheKey: cacheKey)

    let remaining = try wks.loadTeamKeys()
    XCTAssertTrue(remaining.isEmpty,
      "All-stale team key set must be cleared when ECDH key is malformed (F1 bonus regression)")
  }

  // MARK: - T8: happy-path fixture sync stores correct teamKeyVersion

  /// Extends testRefreshTeamKeys_writesTeamKeyUnwrappedToFixtureEncKey with a
  /// teamKeyVersion assertion. Fails if the stored blob's version is wrong/zero.
  func testRefreshTeamKeys_fixtureSync_storesCorrectTeamKeyVersion() async throws {
    let bundle = Bundle(for: type(of: self))
    let fixtureURL = try XCTUnwrap(
      bundle.url(forResource: "team-key-fixture", withExtension: "json")
        ?? bundle.url(forResource: "team-key-fixture", withExtension: "json", subdirectory: "fixtures")
    )
    struct Fixture: Decodable {
      struct EncData: Decodable { let ciphertext: String; let iv: String; let authTag: String }
      let secretKeyHex: String
      let encryptedEcdhPrivateKey: EncData
      let teamId: String; let toUserId: String
      let keyVersion: Int; let wrapVersion: Int
      let hkdfSaltHex: String
      let encryptedTeamKey: EncData
      let ephemeralPublicKeyJwk: String
    }
    let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))

    let cacheKey = SymmetricKey(size: .bits256)
    let userId = f.toUserId

    let secretKeyBytes = try hexDecode(f.secretKeyHex)
    let ecdhWrappingKey = TeamKeyCrypto.deriveEcdhWrappingKey(
      secretKey: SymmetricKey(data: secretKeyBytes))
    let memberKey = try TeamKeyCrypto.unwrapEcdhPrivateKey(
      encrypted: EncryptedData(
        ciphertext: f.encryptedEcdhPrivateKey.ciphertext,
        iv: f.encryptedEcdhPrivateKey.iv,
        authTag: f.encryptedEcdhPrivateKey.authTag),
      wrappingKey: ecdhWrappingKey)
    var pkcs8 = memberKey.derRepresentation
    defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }
    let wrappedEcdh = try TeamEntryDecryptor.wrapEcdhPrivateKey(
      pkcs8: pkcs8, cacheKey: cacheKey, userId: userId, issuedAt: Date())

    let keychain = MockKeychain()
    seedBlobInKeychain(keychain, counter: 1, service: "com.passwd-sso.test.t8.bridge-key")
    let bks = BridgeKeyStore(
      accessGroup: "test",
      service: "com.passwd-sso.test.t8.bridge-key",
      keychain: keychain
    )
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    try wks.saveECDHPrivateKey(wrappedEcdh)

    let fakeKeychain = FakeKeychain()
    let tokenStore = HostTokenStore(service: "com.test.t8.tokens", keychain: fakeKeychain)
    try? tokenStore.saveTokens(
      access: "acc_t8", refresh: "ref_t8",
      expiresAt: Date().addingTimeInterval(3600)
    )
    let session = makeSession()

    struct MemberKeyBody: Encodable {
      let encryptedTeamKey: String; let teamKeyIv: String; let teamKeyAuthTag: String
      let ephemeralPublicKey: String; let hkdfSalt: String
      let keyVersion: Int; let wrapVersion: Int
    }
    let memberKeyData = try JSONEncoder().encode(MemberKeyBody(
      encryptedTeamKey: f.encryptedTeamKey.ciphertext,
      teamKeyIv: f.encryptedTeamKey.iv,
      teamKeyAuthTag: f.encryptedTeamKey.authTag,
      ephemeralPublicKey: f.ephemeralPublicKeyJwk,
      hkdfSalt: f.hkdfSaltHex,
      keyVersion: f.keyVersion,
      wrapVersion: f.wrapVersion
    ))
    let teamsListData = Data(#"[{"id":"\#(f.teamId)","name":"Fixture Team"}]"#.utf8)

    MockURLProtocol.requestHandler = { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/api/passwords") {
        return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
      }
      if path.hasSuffix("/api/teams") {
        return (teamsListData, httpResponse(status: 200, url: request.url!))
      }
      if path.contains("/passwords") {
        return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
      }
      if path.hasSuffix("/member-key") && path.contains(f.teamId) {
        return (memberKeyData, httpResponse(status: 200, url: request.url!))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let vaultKey = SymmetricKey(size: .bits256)
    let apiClient = MobileAPIClient(
      serverURL: URL(string: "https://test.t8.example")!,
      signer: FakeSigner(),
      jwk: ["kty": "EC", "crv": "P-256",
            "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
      tokenStore: tokenStore,
      urlSession: session
    )
    let fetcher = EntryFetcher(apiClient: apiClient)
    let cacheURL = tmpDir.appending(path: "t8.cache", directoryHint: .notDirectory)
    let syncService = HostSyncService(
      apiClient: apiClient,
      entryFetcher: fetcher,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL,
      teamDirectoryStore: NullTeamDirectoryStore()
    )

    _ = try await syncService.runSync(vaultKey: vaultKey, userId: userId, cacheKey: cacheKey)

    let storedKeys = try wks.loadTeamKeys()
    let storedKey = try XCTUnwrap(
      storedKeys.first(where: { $0.teamId == f.teamId }),
      "WrappedTeamKey must be stored for the fixture team after sync (T8)"
    )
    // T8: the stored key's teamKeyVersion must equal the fixture's keyVersion.
    XCTAssertEqual(storedKey.teamKeyVersion, f.keyVersion,
      "Stored WrappedTeamKey.teamKeyVersion must match the server's keyVersion (T8)")
  }
}

// MARK: - Stub that avoids network calls

/// A minimal sync implementation for unit testing — bypasses MobileAPIClient entirely.
private actor StubHostSyncService {
  private let bridgeKeyStore: BridgeKeyStore
  private let wrappedKeyStore: WrappedKeyStore
  private let cacheURL: URL
  private let vaultKey: SymmetricKey
  private let entries: [EncryptedEntry]
  private let userId: String

  init(
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore,
    cacheURL: URL,
    vaultKey: SymmetricKey,
    entries: [EncryptedEntry],
    userId: String = "stub-user-id"
  ) {
    self.bridgeKeyStore = bridgeKeyStore
    self.wrappedKeyStore = wrappedKeyStore
    self.cacheURL = cacheURL
    self.vaultKey = vaultKey
    self.entries = entries
    self.userId = userId
  }

  func runSync() async throws -> SyncReport {
    let now = Date()
    let blob = try bridgeKeyStore.readDirect()
    let newCounter = blob.cacheVersionCounter &+ 1

    // Convert EncryptedEntry → CacheEntry via the production mapping (same call
    // HostSyncService.runSync uses).
    let cacheEntries: [CacheEntry] = entries.map { $0.toPersonalCacheEntry() }

    let encoder = JSONEncoder()
    let entriesJSON = try encoder.encode(cacheEntries)

    let header = CacheHeader(
      cacheVersionCounter: newCounter,
      cacheIssuedAt: now,
      lastSuccessfulRefreshAt: now,
      entryCount: UInt32(cacheEntries.count),
      hostInstallUUID: blob.hostInstallUUID,
      userId: userId
    )
    let cacheData = CacheData(header: header, entries: entriesJSON)

    // Per plan §"Write ordering": write file first, then update blob
    try writeCacheFile(
      data: cacheData,
      vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID,
      path: cacheURL
    )
    try bridgeKeyStore.incrementCounter(newCounter: newCounter)

    let attrs = try? FileManager.default.attributesOfItem(atPath: cacheURL.path)
    let bytesWritten = (attrs?[.size] as? Int) ?? entriesJSON.count

    return SyncReport(
      entriesFetched: cacheEntries.count,
      cacheBytesWritten: bytesWritten,
      lastSuccessfulRefreshAt: now
    )
  }
}
