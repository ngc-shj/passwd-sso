import CryptoKit
import Foundation
import XCTest

@testable import PasswdSSOApp
@testable import Shared

// MARK: - VaultViewModelTests

final class VaultViewModelTests: XCTestCase {

  private let serverURL = URL(string: "https://test.passwd-sso.example")!
  private let userId = "user-vm-1"
  private let entryId = "entry-vm-1"
  private let vaultKey = SymmetricKey(size: .bits256)
  private let liveKeyVersion = 3
  private let knownJWK: [String: String] = [
    "kty": "EC", "crv": "P-256",
    "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ]

  private var keychain: FakeKeychain!
  private var tokenStore: HostTokenStore!
  private var session: URLSession!
  private var tmpDir: URL!

  override func setUp() {
    super.setUp()
    keychain = FakeKeychain()
    tokenStore = HostTokenStore(service: "com.test.vm", keychain: keychain)
    session = makeSession()
    MockURLProtocol.requestHandler = nil

    try? tokenStore.saveTokens(
      access: "acc_vm_test",
      refresh: "ref_vm_test",
      expiresAt: Date().addingTimeInterval(3600)
    )

    tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "VaultViewModelTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: tmpDir)
    MockURLProtocol.requestHandler = nil
    super.tearDown()
  }

  // MARK: - saveEntry round-trip (tags + generatorSettings survive)

  func testSaveEntry_roundTrip_preservesTagsAndGeneratorSettings() async throws {
    // Seed the VM's cache with an entry whose blob has tags + generatorSettings.
    let blobJSON = """
    {"title":"Old","username":"old@example.com","password":"oldpass","url":"https://example.com",
     "tags":[{"name":"work","color":"#f00"}],
     "generatorSettings":{"length":20,"useSymbols":true}}
    """
    let overviewJSON = """
    {"title":"Old","username":"old@example.com","urlHost":"example.com"}
    """

    let vm = await VaultViewModel()
    let localVaultKey = vaultKey
    let localUserId = userId
    let seedData = try makeCacheData(
      entryId: entryId, userId: userId, vaultKey: vaultKey,
      blobJSON: blobJSON, overviewJSON: overviewJSON, aadVersion: 1)
    await MainActor.run { vm.loadFromCache(cacheData: seedData, vaultKey: localVaultKey, userId: localUserId) }

    var capturedPutBody: Data?
    let putURL = serverURL.appending(path: "/api/passwords/\(entryId)", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { request in
      if request.httpMethod == "PUT" {
        capturedPutBody = request.httpBody ?? readStream(request.httpBodyStream)
        return (Data(), httpResponse(status: 200, url: putURL))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let (apiClient, syncService) = makeClientAndSyncService()
    let fields = EditableEntryFields(
      title: "Old",
      username: "old@example.com",
      password: "newpassword",
      url: "https://example.com"
    )

    try await vm.saveEntry(
      entryId: entryId,
      userId: userId,
      fields: fields,
      vaultKey: vaultKey,
      keyVersion: liveKeyVersion,
      apiClient: apiClient,
      hostSyncService: syncService
    )

    // Decode the PUT body and decrypt the blob.
    let bodyData = try XCTUnwrap(capturedPutBody)
    let updateReq = try JSONDecoder().decode(UpdateEntryRequest.self, from: bodyData)

    XCTAssertEqual(updateReq.keyVersion, liveKeyVersion, "PUT must send live keyVersion")
    XCTAssertEqual(updateReq.aadVersion, 1, "PUT must send aadVersion 1")

    // Decrypt the blob with aadVersion-1 AAD.
    let blobAAD = try buildPersonalEntryAAD(userId: userId, entryId: entryId, vaultType: VaultType.blob)
    let blobPlaintext = try decryptAESGCMEncoded(
      encrypted: updateReq.encryptedBlob, key: vaultKey, aad: blobAAD)

    // Verify tags and generatorSettings survived.
    let obj = try XCTUnwrap(
      JSONSerialization.jsonObject(with: blobPlaintext) as? [String: Any])
    let tags = try XCTUnwrap(obj["tags"] as? [[String: Any]])
    XCTAssertEqual(tags.count, 1)
    XCTAssertEqual(tags[0]["name"] as? String, "work")

    let genSettings = try XCTUnwrap(obj["generatorSettings"] as? [String: Any])
    XCTAssertEqual(genSettings["length"] as? Int, 20)

    XCTAssertEqual(obj["password"] as? String, "newpassword")
  }

  // MARK: - saveEntry legacy aadVersion-0 upgrade

  func testSaveEntry_legacyAadVersion0_upgradesTo1() async throws {
    let blobJSON = """
    {"title":"Legacy","username":"legacy@example.com","password":"legacypass","url":null,"notes":null}
    """
    let overviewJSON = """
    {"title":"Legacy","username":"legacy@example.com","urlHost":null}
    """

    let vm = await VaultViewModel()
    let localVaultKey2 = vaultKey
    let localUserId2 = userId
    // Seed with aadVersion: 0 (no AAD).
    let seedData = try makeCacheData(
      entryId: entryId, userId: userId, vaultKey: vaultKey,
      blobJSON: blobJSON, overviewJSON: overviewJSON, aadVersion: 0)
    await MainActor.run { vm.loadFromCache(cacheData: seedData, vaultKey: localVaultKey2, userId: localUserId2) }

    var capturedPutBody: Data?
    let putURL = serverURL.appending(path: "/api/passwords/\(entryId)", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { request in
      if request.httpMethod == "PUT" {
        capturedPutBody = request.httpBody ?? readStream(request.httpBodyStream)
        return (Data(), httpResponse(status: 200, url: putURL))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let (apiClient, syncService) = makeClientAndSyncService()
    let fields = EditableEntryFields(
      title: "Legacy",
      username: "legacy@example.com",
      password: "newpass",
      url: ""
    )

    try await vm.saveEntry(
      entryId: entryId,
      userId: userId,
      fields: fields,
      vaultKey: vaultKey,
      keyVersion: liveKeyVersion,
      apiClient: apiClient,
      hostSyncService: syncService
    )

    let bodyData = try XCTUnwrap(capturedPutBody)
    let updateReq = try JSONDecoder().decode(UpdateEntryRequest.self, from: bodyData)

    // Re-encrypt uses aadVersion 1.
    XCTAssertEqual(updateReq.aadVersion, 1, "Legacy entry must be upgraded to aadVersion 1 on save")
    XCTAssertEqual(updateReq.keyVersion, liveKeyVersion)

    // Verify the blob can be decrypted with aadVersion-1 AAD (upgrade proof).
    let blobAAD = try buildPersonalEntryAAD(userId: userId, entryId: entryId, vaultType: VaultType.blob)
    let plaintext = try decryptAESGCMEncoded(
      encrypted: updateReq.encryptedBlob, key: vaultKey, aad: blobAAD)
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: plaintext) as? [String: Any])
    XCTAssertEqual(obj["password"] as? String, "newpass")
  }

  // MARK: - saveEntry throws teamEditNotSupported

  func testSaveEntry_throwsForTeamEntry() async throws {
    let teamSummary = VaultEntrySummary(
      id: entryId,
      title: "Team Entry",
      username: "user",
      urlHost: "example.com",
      teamId: "team-xyz"
    )

    let (apiClient, syncService) = makeClientAndSyncService()
    let vm = await VaultViewModel()
    await MainActor.run { vm.injectSummaries([teamSummary]) }

    do {
      try await vm.saveEntry(
        entryId: entryId,
        userId: userId,
        fields: EditableEntryFields(title: "T", username: "u", password: "p"),
        vaultKey: vaultKey,
        keyVersion: liveKeyVersion,
        apiClient: apiClient,
        hostSyncService: syncService
      )
      XCTFail("Expected teamEditNotSupported")
    } catch VaultViewModelError.teamEditNotSupported {
      // Expected.
    }
  }

  // MARK: - saveEntry throws cacheUnavailable when no cache loaded

  func testSaveEntry_throwsCacheUnavailable_whenNoCacheLoaded() async throws {
    let (apiClient, syncService) = makeClientAndSyncService()
    let vm = await VaultViewModel()
    // No cache loaded — cacheData is nil.
    let summary = VaultEntrySummary(id: entryId, title: "T", username: "u", urlHost: "e.com")
    await MainActor.run { vm.injectSummaries([summary]) }

    do {
      try await vm.saveEntry(
        entryId: entryId,
        userId: userId,
        fields: EditableEntryFields(title: "T", username: "u", password: "p"),
        vaultKey: vaultKey,
        keyVersion: liveKeyVersion,
        apiClient: apiClient,
        hostSyncService: syncService
      )
      XCTFail("Expected cacheUnavailable")
    } catch VaultViewModelError.cacheUnavailable {
      // Expected.
    }
  }

  // MARK: - saveEntry calls runSync after server success

  func testSaveEntry_callsRunSyncAfterServerSuccess() async throws {
    let blobJSON = """
    {"title":"T","username":"u","password":"p","url":null,"notes":null}
    """
    let overviewJSON = """
    {"title":"T","username":"u","urlHost":null}
    """

    let vm = await VaultViewModel()
    let localVaultKey3 = vaultKey
    let localUserId3 = userId
    let seedData2 = try makeCacheData(
      entryId: entryId, userId: userId, vaultKey: vaultKey,
      blobJSON: blobJSON, overviewJSON: overviewJSON, aadVersion: 1)
    await MainActor.run { vm.loadFromCache(cacheData: seedData2, vaultKey: localVaultKey3, userId: localUserId3) }

    let putURL = serverURL.appending(path: "/api/passwords/\(entryId)", directoryHint: .notDirectory)
    var syncFetchCalled = false
    MockURLProtocol.requestHandler = { request in
      if request.httpMethod == "PUT" {
        return (Data(), httpResponse(status: 200, url: putURL))
      }
      syncFetchCalled = true
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let (apiClient, syncService) = makeClientAndSyncService()
    try await vm.saveEntry(
      entryId: entryId,
      userId: userId,
      fields: EditableEntryFields(title: "T", username: "u", password: "newp"),
      vaultKey: vaultKey,
      keyVersion: liveKeyVersion,
      apiClient: apiClient,
      hostSyncService: syncService
    )

    XCTAssertTrue(syncFetchCalled, "HostSyncService.runSync must be called after PUT 200")
  }

  // MARK: - updateEntry 200/204 regression guard

  func testUpdateEntry_succeedsOn200And204() async throws {
    let (apiClient, _) = makeClientAndSyncService()
    let enc = EncryptedData(
      ciphertext: "aabbcc",
      iv: "112233445566778899aabbcc",
      authTag: "deadbeefdeadbeefdeadbeefdeadbeef"
    )
    let req = UpdateEntryRequest(encryptedBlob: enc, encryptedOverview: enc, keyVersion: 1, aadVersion: 1)
    let putURL = serverURL.appending(path: "/api/passwords/e1", directoryHint: .notDirectory)

    // 200
    MockURLProtocol.requestHandler = { _ in (Data(), httpResponse(status: 200, url: putURL)) }
    try await apiClient.updateEntry(entryId: "e1", body: req)  // must not throw

    // 204
    MockURLProtocol.requestHandler = { _ in (Data(), httpResponse(status: 204, url: putURL)) }
    try await apiClient.updateEntry(entryId: "e1", body: req)  // must not throw
  }

  // MARK: - createEntry POST body shape

  func testCreateEntry_postBodyShape() async throws {
    var capturedRequest: URLRequest?
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { request in
      if request.httpMethod == "POST" {
        capturedRequest = request
        // Return 201 with the same id echoed back.
        let bodyData = request.httpBody ?? readStream(request.httpBodyStream) ?? Data()
        if let bodyObj = try? JSONDecoder().decode(CreateEntryRequest.self, from: bodyData) {
          let resp = #"{"id":"\#(bodyObj.id)"}"#
          return (Data(resp.utf8), httpResponse(status: 201, url: createURL))
        }
        return (Data(), httpResponse(status: 400, url: createURL))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let (apiClient, syncService) = makeClientAndSyncService()
    let vm = await VaultViewModel()

    let fields = EditableEntryFields(
      title: "GitHub",
      username: "user@github.com",
      password: "gh-pass",
      url: "https://github.com"
    )

    try await vm.createEntry(
      userId: userId,
      fields: fields,
      vaultKey: vaultKey,
      keyVersion: liveKeyVersion,
      apiClient: apiClient,
      hostSyncService: syncService
    )

    let req = try XCTUnwrap(capturedRequest)
    XCTAssertEqual(req.httpMethod, "POST")
    XCTAssertTrue(req.url?.path.hasSuffix("/api/passwords") ?? false)
    XCTAssertNotNil(req.value(forHTTPHeaderField: "DPoP"))
    let auth = try XCTUnwrap(req.value(forHTTPHeaderField: "Authorization"))
    XCTAssertTrue(auth.hasPrefix("Bearer "))

    let bodyData = try XCTUnwrap(req.httpBody ?? readStream(req.httpBodyStream))
    let body = try JSONDecoder().decode(CreateEntryRequest.self, from: bodyData)
    XCTAssertFalse(body.id.isEmpty)
    XCTAssertEqual(body.entryType, "LOGIN")
    XCTAssertEqual(body.aadVersion, 1)
    XCTAssertEqual(body.keyVersion, liveKeyVersion)
    XCTAssertFalse(body.encryptedBlob.ciphertext.isEmpty)
    XCTAssertFalse(body.encryptedOverview.ciphertext.isEmpty)
  }

  // MARK: - createEntry 201 and 200 both succeed

  func testCreateEntry_201And200BothSucceed() async throws {
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    let (apiClient, syncService) = makeClientAndSyncService()

    // 201
    MockURLProtocol.requestHandler = { request in
      if request.httpMethod == "POST" {
        let bodyData = request.httpBody ?? readStream(request.httpBodyStream) ?? Data()
        if let bodyObj = try? JSONDecoder().decode(CreateEntryRequest.self, from: bodyData) {
          let resp = #"{"id":"\#(bodyObj.id)"}"#
          return (Data(resp.utf8), httpResponse(status: 201, url: createURL))
        }
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }
    let vm201 = await VaultViewModel()
    try await vm201.createEntry(
      userId: userId,
      fields: EditableEntryFields(title: "T", username: "", password: "p"),
      vaultKey: vaultKey, keyVersion: liveKeyVersion,
      apiClient: apiClient, hostSyncService: syncService
    )

    // 200
    MockURLProtocol.requestHandler = { request in
      if request.httpMethod == "POST" {
        let bodyData = request.httpBody ?? readStream(request.httpBodyStream) ?? Data()
        if let bodyObj = try? JSONDecoder().decode(CreateEntryRequest.self, from: bodyData) {
          let resp = #"{"id":"\#(bodyObj.id)"}"#
          return (Data(resp.utf8), httpResponse(status: 200, url: createURL))
        }
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }
    let vm200 = await VaultViewModel()
    try await vm200.createEntry(
      userId: userId,
      fields: EditableEntryFields(title: "T", username: "", password: "p"),
      vaultKey: vaultKey, keyVersion: liveKeyVersion,
      apiClient: apiClient, hostSyncService: syncService
    )
  }

  // MARK: - createEntry throws entryIdMismatch when server returns different id

  func testCreateEntry_throwsEntryIdMismatch_whenServerReturnsDifferentId() async throws {
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { request in
      if request.httpMethod == "POST" {
        let resp = #"{"id":"server-generated-different-id"}"#
        return (Data(resp.utf8), httpResponse(status: 201, url: createURL))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let (apiClient, syncService) = makeClientAndSyncService()
    let vm = await VaultViewModel()

    do {
      try await vm.createEntry(
        userId: userId,
        fields: EditableEntryFields(title: "T", username: "", password: "p"),
        vaultKey: vaultKey, keyVersion: liveKeyVersion,
        apiClient: apiClient, hostSyncService: syncService
      )
      XCTFail("Expected entryIdMismatch")
    } catch VaultViewModelError.entryIdMismatch {
      // Expected.
    }

    // Plan C3: on entryIdMismatch the entry must NOT appear in allSummaries
    // (no optimistic insert before the id check is verified).
    let count = await MainActor.run { vm.allSummaries.count }
    XCTAssertEqual(count, 0, "allSummaries must not change on entryIdMismatch")
  }

  // MARK: - createEntry propagates quotaExceeded

  func testCreateEntry_quotaExceededPropagates() async throws {
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { _ in
      // 403 returned immediately — createEntry throws before any sync runs.
      (Data(#"{"error":"QUOTA_EXCEEDED","resource":"passwords","current":10000,"max":10000}"#.utf8),
       httpResponse(status: 403, url: createURL))
    }

    let (apiClient, syncService) = makeClientAndSyncService()
    let vm = await VaultViewModel()

    do {
      try await vm.createEntry(
        userId: userId,
        fields: EditableEntryFields(title: "T", username: "", password: "p"),
        vaultKey: vaultKey, keyVersion: liveKeyVersion,
        apiClient: apiClient, hostSyncService: syncService
      )
      XCTFail("Expected quotaExceeded")
    } catch {
      XCTAssertEqual(error as? MobileAPIError, .quotaExceeded)
    }
  }

  // MARK: - createEntry no-optimistic-prepend proof (T10)

  func testCreateEntry_noOptimisticPrepend_whenSyncReturnsEmptyCache() async throws {
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)

    MockURLProtocol.requestHandler = { request in
      if request.httpMethod == "POST" {
        let bodyData = request.httpBody ?? readStream(request.httpBodyStream) ?? Data()
        if let bodyObj = try? JSONDecoder().decode(CreateEntryRequest.self, from: bodyData) {
          let resp = #"{"id":"\#(bodyObj.id)"}"#
          return (Data(resp.utf8), httpResponse(status: 201, url: createURL))
        }
      }
      // Sync returns empty — no entries in the server list.
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let (apiClient, syncService) = makeClientAndSyncService()
    let vm = await VaultViewModel()

    try await vm.createEntry(
      userId: userId,
      fields: EditableEntryFields(title: "GitHub", username: "", password: "p"),
      vaultKey: vaultKey, keyVersion: liveKeyVersion,
      apiClient: apiClient, hostSyncService: syncService
    )

    // If the code wrongly prepended an optimistic summary, allSummaries would be non-empty.
    let summaryCount = await MainActor.run { vm.allSummaries.count }
    XCTAssertEqual(summaryCount, 0, "allSummaries must come from sync, not an optimistic prepend")
  }

  // MARK: - loadFromCache with team entries (C9 wiring)

  /// loadFromCache with cacheKey + seeded team key → team entries appear in allSummaries.
  func testLoadFromCache_withTeamKeyAndCacheKey_decryptsTeamEntries() async throws {
    let localVaultKey = vaultKey
    let localUserId = userId

    let cacheKey = SymmetricKey(size: .bits256)
    let teamId = "team-vm-1"
    let teamEncKey = SymmetricKey(size: .bits256)

    // Wrap the team key and seed into a MockWrappedKeyStore.
    let wrappedTeamKey = try TeamEntryDecryptor.wrapTeamKey(
      teamEncKey: teamEncKey, cacheKey: cacheKey, userId: localUserId,
      teamId: teamId, teamKeyVersion: 1, issuedAt: Date()
    )
    let wks = MockWrappedKeyStore()
    try wks.saveTeamKeys([wrappedTeamKey])

    // Build a team cache entry.
    let teamOverviewAAD = try buildTeamEntryAAD(
      teamId: teamId, entryId: "te-vm-1", vaultType: VaultType.overview, itemKeyVersion: 0
    )
    struct OverviewBlob: Encodable { let title: String; let username: String; let urlHost: String }
    let overviewData = try JSONEncoder().encode(
      OverviewBlob(title: "Team Login", username: "teamuser", urlHost: "team.example.com")
    )
    let teamOverviewEnc = try encryptAESGCMEncoded(
      plaintext: overviewData, key: teamEncKey, aad: teamOverviewAAD
    )
    let dummyBlob = try encryptAESGCMEncoded(plaintext: Data("{}".utf8), key: localVaultKey, aad: nil)
    let teamEntry = CacheEntry(
      id: "te-vm-1", teamId: teamId, aadVersion: 1, keyVersion: 0,
      teamKeyVersion: 1, itemKeyVersion: 0,
      encryptedItemKey: nil,
      encryptedBlob: dummyBlob,
      encryptedOverview: teamOverviewEnc
    )

    // Also add a personal entry.
    let personalEntry = CacheEntry(
      id: "pe-vm-1", teamId: nil, aadVersion: 0,
      encryptedBlob: try encryptAESGCMEncoded(plaintext: Data(#"{"title":"P","username":"alice","password":"pw","url":"","notes":"","tags":[]}"#.utf8), key: localVaultKey, aad: nil),
      encryptedOverview: try encryptAESGCMEncoded(plaintext: Data(#"{"title":"P","username":"alice","urlHost":"personal.com"}"#.utf8), key: localVaultKey, aad: nil)
    )

    let header = CacheHeader(
      cacheVersionCounter: 1, cacheIssuedAt: Date(), lastSuccessfulRefreshAt: Date(),
      entryCount: 2, hostInstallUUID: Data(repeating: 0, count: 16), userId: localUserId
    )
    let cacheData = CacheData(
      header: header, entries: try JSONEncoder().encode([personalEntry, teamEntry])
    )

    let vm = await VaultViewModel()
    await MainActor.run {
      vm.loadFromCache(
        cacheData: cacheData, vaultKey: localVaultKey, userId: localUserId,
        cacheKey: cacheKey, wrappedKeyStore: wks
      )
    }

    let all = await MainActor.run { vm.allSummaries }
    XCTAssertEqual(all.count, 2, "Both personal and team entries must appear in allSummaries")
    XCTAssertNotNil(all.first(where: { $0.id == "te-vm-1" }),
      "Team entry must appear in allSummaries when cacheKey + team key are provided")
    XCTAssertNotNil(all.first(where: { $0.id == "pe-vm-1" }),
      "Personal entry must still appear in allSummaries")
  }

  // MARK: - T-DATE-E2E: decryptOverview threads CacheEntry dates into the summary

  /// Proves `decryptOverview` actually passes `entry.createdAt`/`updatedAt` to
  /// `EntryBlobDecoder.summary` (not merely that the two seams work in
  /// isolation) — runs the real loadFromCache path over a seeded CacheEntry.
  func testLoadFromCache_threadsCreatedAtAndUpdatedAtIntoSummary() async throws {
    let blobJSON = #"{"title":"T","username":"u","password":"p","url":"","notes":"","tags":[]}"#
    let overviewJSON = #"{"title":"T","username":"u","urlHost":"example.com"}"#
    let expectedCreated = Date(timeIntervalSince1970: 1_700_000_000)
    let expectedUpdated = Date(timeIntervalSince1970: 1_800_000_000)

    let vm = await VaultViewModel()
    let localVaultKey = vaultKey
    let localUserId = userId
    let seedData = try makeCacheData(
      entryId: entryId, userId: userId, vaultKey: vaultKey,
      blobJSON: blobJSON, overviewJSON: overviewJSON, aadVersion: 1,
      createdAt: expectedCreated, updatedAt: expectedUpdated
    )
    await MainActor.run {
      vm.loadFromCache(cacheData: seedData, vaultKey: localVaultKey, userId: localUserId)
    }

    let first = await MainActor.run { vm.allSummaries.first }
    let summary = try XCTUnwrap(first)
    XCTAssertEqual(summary.createdAt, expectedCreated)
    XCTAssertEqual(summary.updatedAt, expectedUpdated)
  }

  // MARK: - VaultScope filtering

  func testLoadFromCache_personalScopeFiltersToTeamIdNil() async throws {
    let localVaultKey = vaultKey
    let localUserId = userId

    let cacheKey = SymmetricKey(size: .bits256)
    let teamId = "team-scope"
    let teamEncKey = SymmetricKey(size: .bits256)
    let wrappedTeamKey = try TeamEntryDecryptor.wrapTeamKey(
      teamEncKey: teamEncKey, cacheKey: cacheKey, userId: localUserId,
      teamId: teamId, teamKeyVersion: 1, issuedAt: Date()
    )
    let wks = MockWrappedKeyStore()
    try wks.saveTeamKeys([wrappedTeamKey])

    struct OverviewBlob: Encodable { let title: String; let username: String; let urlHost: String }
    let teamAAD = try buildTeamEntryAAD(
      teamId: teamId, entryId: "te-scope-1", vaultType: VaultType.overview, itemKeyVersion: 0
    )
    let teamOverviewEnc = try encryptAESGCMEncoded(
      plaintext: try JSONEncoder().encode(OverviewBlob(title: "T", username: "u", urlHost: "scope.example.com")),
      key: teamEncKey, aad: teamAAD
    )
    let dummyBlob = try encryptAESGCMEncoded(plaintext: Data("{}".utf8), key: localVaultKey, aad: nil)
    let teamEntry = CacheEntry(
      id: "te-scope-1", teamId: teamId, aadVersion: 1, keyVersion: 0,
      teamKeyVersion: 1, itemKeyVersion: 0,
      encryptedItemKey: nil, encryptedBlob: dummyBlob, encryptedOverview: teamOverviewEnc
    )
    let personalEntry = CacheEntry(
      id: "pe-scope-1", teamId: nil, aadVersion: 0,
      encryptedBlob: try encryptAESGCMEncoded(plaintext: Data(#"{"title":"P","username":"p","password":"pw","url":"","notes":"","tags":[]}"#.utf8), key: localVaultKey, aad: nil),
      encryptedOverview: try encryptAESGCMEncoded(plaintext: Data(#"{"title":"P","username":"p","urlHost":"personal.example.com"}"#.utf8), key: localVaultKey, aad: nil)
    )
    let header = CacheHeader(
      cacheVersionCounter: 1, cacheIssuedAt: Date(), lastSuccessfulRefreshAt: Date(),
      entryCount: 2, hostInstallUUID: Data(repeating: 0, count: 16), userId: localUserId
    )
    let cacheData = CacheData(header: header, entries: try JSONEncoder().encode([personalEntry, teamEntry]))

    let vm = await VaultViewModel()
    await MainActor.run {
      vm.loadFromCache(cacheData: cacheData, vaultKey: localVaultKey, userId: localUserId,
                       cacheKey: cacheKey, wrappedKeyStore: wks)
      vm.scope = .personal
    }

    let filtered = await MainActor.run { vm.filteredSummaries }
    XCTAssertEqual(filtered.count, 1, ".personal scope must show only personal entries")
    XCTAssertEqual(filtered.first?.id, "pe-scope-1")
    XCTAssertEqual(filtered.first?.teamId, nil)
  }

  func testLoadFromCache_teamScopeFiltersToOneTeam() async throws {
    let localVaultKey = vaultKey
    let localUserId = userId

    let cacheKey = SymmetricKey(size: .bits256)
    let teamId = "team-scope-filter"
    let teamEncKey = SymmetricKey(size: .bits256)
    let wrappedTeamKey = try TeamEntryDecryptor.wrapTeamKey(
      teamEncKey: teamEncKey, cacheKey: cacheKey, userId: localUserId,
      teamId: teamId, teamKeyVersion: 1, issuedAt: Date()
    )
    let wks = MockWrappedKeyStore()
    try wks.saveTeamKeys([wrappedTeamKey])

    struct OverviewBlob: Encodable { let title: String; let username: String; let urlHost: String }
    let teamAAD = try buildTeamEntryAAD(
      teamId: teamId, entryId: "te-filter-1", vaultType: VaultType.overview, itemKeyVersion: 0
    )
    let teamOverviewEnc = try encryptAESGCMEncoded(
      plaintext: try JSONEncoder().encode(OverviewBlob(title: "T", username: "u", urlHost: "filter.example.com")),
      key: teamEncKey, aad: teamAAD
    )
    let dummyBlob = try encryptAESGCMEncoded(plaintext: Data("{}".utf8), key: localVaultKey, aad: nil)
    let teamEntry = CacheEntry(
      id: "te-filter-1", teamId: teamId, aadVersion: 1, keyVersion: 0,
      teamKeyVersion: 1, itemKeyVersion: 0,
      encryptedItemKey: nil, encryptedBlob: dummyBlob, encryptedOverview: teamOverviewEnc
    )
    let personalEntry = CacheEntry(
      id: "pe-filter-1", teamId: nil, aadVersion: 0,
      encryptedBlob: try encryptAESGCMEncoded(plaintext: Data(#"{"title":"P","username":"p","password":"pw","url":"","notes":"","tags":[]}"#.utf8), key: localVaultKey, aad: nil),
      encryptedOverview: try encryptAESGCMEncoded(plaintext: Data(#"{"title":"P","username":"p","urlHost":"personal.filter.com"}"#.utf8), key: localVaultKey, aad: nil)
    )
    let header = CacheHeader(
      cacheVersionCounter: 1, cacheIssuedAt: Date(), lastSuccessfulRefreshAt: Date(),
      entryCount: 2, hostInstallUUID: Data(repeating: 0, count: 16), userId: localUserId
    )
    let cacheData = CacheData(header: header, entries: try JSONEncoder().encode([personalEntry, teamEntry]))

    let vm = await VaultViewModel()
    await MainActor.run {
      vm.loadFromCache(cacheData: cacheData, vaultKey: localVaultKey, userId: localUserId,
                       cacheKey: cacheKey, wrappedKeyStore: wks)
      vm.scope = .team(teamId)
    }

    let filtered = await MainActor.run { vm.filteredSummaries }
    XCTAssertEqual(filtered.count, 1, ".team scope must show only that team's entries")
    XCTAssertEqual(filtered.first?.id, "te-filter-1")
    XCTAssertEqual(filtered.first?.teamId, teamId)
  }

  /// teamDirectory labels are loaded from cacheKey-decrypted directory.
  func testLoadFromCache_teamDirectoryLabels() async throws {
    let localVaultKey = vaultKey
    let localUserId = userId
    let localEntryId = entryId

    let directory = [
      TeamDirectoryEntry(id: "team-dir-1", name: "Alpha Team"),
      TeamDirectoryEntry(id: "team-dir-2", name: "Beta Team"),
    ]
    let cacheData = try makeCacheData(
      entryId: localEntryId, userId: localUserId, vaultKey: localVaultKey,
      blobJSON: #"{"title":"T","username":"u","password":"pw","url":null,"notes":null}"#,
      overviewJSON: #"{"title":"T","username":"u","urlHost":null}"#,
      aadVersion: 0
    )

    let vm = await VaultViewModel()
    await MainActor.run {
      vm.loadFromCache(
        cacheData: cacheData, vaultKey: localVaultKey, userId: localUserId,
        teamDirectory: directory
      )
    }

    let labels = await MainActor.run { vm.teamDirectory }
    XCTAssertEqual(labels.count, 2)
    XCTAssertEqual(labels.first(where: { $0.id == "team-dir-1" })?.name, "Alpha Team")
    XCTAssertEqual(labels.first(where: { $0.id == "team-dir-2" })?.name, "Beta Team")
  }

  /// No cacheKey → personal-only, team entries skipped, no crash.
  func testLoadFromCache_noCacheKey_personalOnly() async throws {
    let localVaultKey = vaultKey
    let localUserId = userId

    let dummyEnc = try encryptAESGCMEncoded(plaintext: Data("{}".utf8), key: localVaultKey, aad: nil)
    let teamEntry = CacheEntry(
      id: "te-nocache", teamId: "some-team", aadVersion: 0,
      encryptedBlob: dummyEnc, encryptedOverview: dummyEnc
    )
    let personalEntry = CacheEntry(
      id: "pe-nocache", teamId: nil, aadVersion: 0,
      encryptedBlob: try encryptAESGCMEncoded(plaintext: Data(#"{"title":"P","username":"p","password":"pw","url":"","notes":"","tags":[]}"#.utf8), key: localVaultKey, aad: nil),
      encryptedOverview: try encryptAESGCMEncoded(plaintext: Data(#"{"title":"P","username":"p","urlHost":"only.personal.com"}"#.utf8), key: localVaultKey, aad: nil)
    )
    let header = CacheHeader(
      cacheVersionCounter: 1, cacheIssuedAt: Date(), lastSuccessfulRefreshAt: Date(),
      entryCount: 2, hostInstallUUID: Data(repeating: 0, count: 16), userId: localUserId
    )
    let cacheData = CacheData(header: header, entries: try JSONEncoder().encode([personalEntry, teamEntry]))

    let vm = await VaultViewModel()
    await MainActor.run {
      // No cacheKey → personal-only (no team key store access).
      vm.loadFromCache(cacheData: cacheData, vaultKey: localVaultKey, userId: localUserId)
    }

    let all = await MainActor.run { vm.allSummaries }
    XCTAssertEqual(all.count, 1, "Without cacheKey only personal entries must be in allSummaries")
    XCTAssertEqual(all.first?.id, "pe-nocache")
  }

  // MARK: - createEntry 401 + nonce retry

  func testCreateEntry_retriesOnceWith401AndNewNonce() async throws {
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    var callCount = 0

    MockURLProtocol.requestHandler = { request in
      if request.httpMethod == "POST" {
        callCount += 1
        if callCount == 1 {
          return (Data(), httpResponse(status: 401, url: createURL, headers: ["DPoP-Nonce": "new-nonce"]))
        }
        let bodyData = request.httpBody ?? readStream(request.httpBodyStream) ?? Data()
        if let bodyObj = try? JSONDecoder().decode(CreateEntryRequest.self, from: bodyData) {
          let resp = #"{"id":"\#(bodyObj.id)"}"#
          return (Data(resp.utf8), httpResponse(status: 201, url: createURL))
        }
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let (apiClient, syncService) = makeClientAndSyncService()
    let vm = await VaultViewModel()

    try await vm.createEntry(
      userId: userId,
      fields: EditableEntryFields(title: "T", username: "", password: "p"),
      vaultKey: vaultKey, keyVersion: liveKeyVersion,
      apiClient: apiClient, hostSyncService: syncService
    )
    XCTAssertEqual(callCount, 2, "Should retry exactly once after 401+nonce")
  }

  // MARK: - createEntry 4xx throws serverError

  func testCreateEntry_4xxThrowsServerError() async throws {
    let createURL = serverURL.appending(path: "/api/passwords", directoryHint: .notDirectory)
    MockURLProtocol.requestHandler = { _ in
      return (Data(), httpResponse(status: 422, url: createURL))
    }

    let (apiClient, _) = makeClientAndSyncService()
    do {
      _ = try await apiClient.createEntry(
        body: CreateEntryRequest(
          id: "test-id",
          encryptedBlob: EncryptedData(ciphertext: "aa", iv: "112233445566778899aabbcc", authTag: "deadbeefdeadbeefdeadbeefdeadbeef"),
          encryptedOverview: EncryptedData(ciphertext: "bb", iv: "112233445566778899aabbcc", authTag: "deadbeefdeadbeefdeadbeefdeadbeef"),
          keyVersion: 1,
          aadVersion: 1,
          entryType: "LOGIN"
        )
      )
      XCTFail("Expected serverError")
    } catch MobileAPIError.serverError(let status) {
      XCTAssertEqual(status, 422)
    }
  }

  // MARK: - Helpers

  private func makeClientAndSyncService() -> (MobileAPIClient, HostSyncService) {
    let apiClient = MobileAPIClient(
      serverURL: serverURL,
      signer: FakeSigner(),
      jwk: knownJWK,
      tokenStore: tokenStore,
      urlSession: session
    )

    let bks = makeBridgeKeyStore()
    let wks = TempDirWrappedKeyStore(baseDir: tmpDir)
    let cacheURL = tmpDir.appending(path: "vm-test.cache", directoryHint: .notDirectory)
    let fetcher = EntryFetcher(apiClient: apiClient)

    let syncService = HostSyncService(
      apiClient: apiClient,
      entryFetcher: fetcher,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL
    )
    return (apiClient, syncService)
  }

  private func makeBridgeKeyStore() -> BridgeKeyStore {
    let kc = MockKeychain()
    seedBlobInKeychain(kc, counter: 1, service: "com.test.vm.bridge-key")
    return BridgeKeyStore(
      accessGroup: "test",
      service: "com.test.vm.bridge-key",
      keychain: kc
    )
  }
}

// MARK: - VaultViewModel test helpers

extension VaultViewModel {
  /// Inject summaries for testing — bypasses the cache decrypt path.
  @MainActor
  func injectSummaries(_ summaries: [VaultEntrySummary]) {
    allSummaries = summaries
  }
}

// MARK: - seedCache helper

/// Builds a `CacheData` from encrypted plaintext JSON blobs.
/// Encrypts real plaintext with `encryptAESGCMEncoded`+`buildPersonalEntryAAD`.
/// Caller must call `vm.loadFromCache(...)` on the main actor.
func makeCacheData(
  entryId: String,
  userId: String,
  vaultKey: SymmetricKey,
  blobJSON: String,
  overviewJSON: String,
  aadVersion: Int,
  createdAt: Date? = nil,
  updatedAt: Date? = nil
) throws -> CacheData {
  let blobData = Data(blobJSON.utf8)
  let overviewData = Data(overviewJSON.utf8)

  // Build AAD using the stored aadVersion (mimics how the server wrote it).
  let blobAAD: Data?
  let overviewAAD: Data?
  if aadVersion >= 1 {
    blobAAD = try buildPersonalEntryAAD(userId: userId, entryId: entryId, vaultType: VaultType.blob)
    overviewAAD = try buildPersonalEntryAAD(userId: userId, entryId: entryId, vaultType: VaultType.overview)
  } else {
    blobAAD = nil
    overviewAAD = nil
  }

  let encBlob = try encryptAESGCMEncoded(plaintext: blobData, key: vaultKey, aad: blobAAD)
  let encOverview = try encryptAESGCMEncoded(plaintext: overviewData, key: vaultKey, aad: overviewAAD)

  let entry = CacheEntry(
    id: entryId,
    teamId: nil,
    aadVersion: aadVersion,
    keyVersion: 1,
    encryptedBlob: encBlob,
    encryptedOverview: encOverview,
    createdAt: createdAt,
    updatedAt: updatedAt
  )

  let entriesData = try JSONEncoder().encode([entry])
  let header = CacheHeader(
    cacheVersionCounter: 1,
    cacheIssuedAt: Date(),
    lastSuccessfulRefreshAt: Date(),
    entryCount: 1,
    hostInstallUUID: Data(repeating: 0x00, count: 16),
    userId: userId
  )
  return CacheData(header: header, entries: entriesData)
}

/// Convenience: build and load a seeded cache onto `vm`.
@MainActor
func seedCache(
  on vm: VaultViewModel,
  entryId: String,
  userId: String,
  vaultKey: SymmetricKey,
  blobJSON: String,
  overviewJSON: String,
  aadVersion: Int
) throws {
  let cacheData = try makeCacheData(
    entryId: entryId, userId: userId, vaultKey: vaultKey,
    blobJSON: blobJSON, overviewJSON: overviewJSON, aadVersion: aadVersion)
  vm.loadFromCache(cacheData: cacheData, vaultKey: vaultKey, userId: userId)
}
