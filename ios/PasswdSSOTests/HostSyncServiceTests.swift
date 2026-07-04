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
    [{"id":"\(goodTeamId)","name":"Good Team"},{"id":"\(badTeamId)","name":"Bad Team"}]
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
    let syncService2 = HostSyncService(
      apiClient: apiClient2,
      entryFetcher: fetcher2,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL2,
      teamDirectoryStore: NullTeamDirectoryStore()
    )

    _ = try await syncService2.runSync(vaultKey: vaultKey, userId: userId, cacheKey: cacheKey)

    let stored = try wks.loadTeamKeys()
    // Good team must be present.
    XCTAssertNotNil(stored.first(where: { $0.teamId == goodTeamId }),
      "Good team with distributed key must appear in stored team keys")
    // Bad team must be absent.
    XCTAssertNil(stored.first(where: { $0.teamId == badTeamId }),
      "Team with KEY_NOT_DISTRIBUTED must be absent from stored team keys")
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
  /// non-auth error), teamsAuthoritative=false and refreshTeamKeys returns early.
  /// Previously the code called saveTeamKeys([]) wiping valid persisted keys.
  /// This test fails against the old behaviour (saveTeamKeys([]) path) because
  /// storedKeys.count would be 0 instead of 1.
  func testRefreshTeamKeys_transientTeamsError_doesNotWipeExistingKeys() async throws {
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
    try wks.saveTeamKeys([existingWrapped])

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

    _ = try await syncService.runSync(vaultKey: vaultKey, userId: userId, cacheKey: cacheKey)

    // The existing fresh team key must still be present, NOT wiped.
    let remaining = try wks.loadTeamKeys()
    XCTAssertEqual(remaining.count, 1,
      "Transient /api/teams failure must NOT wipe valid persisted team keys (F1 regression)")
    XCTAssertEqual(remaining.first?.teamId, f.teamId,
      "The surviving key must be the originally seeded team's key")
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
