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
  aadVersion: Int
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
    encryptedOverview: encOverview
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
