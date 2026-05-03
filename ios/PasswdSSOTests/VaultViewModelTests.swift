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

  // MARK: - testSaveEntry_callsAPIWithEncryptedFields

  func testSaveEntry_callsAPIWithEncryptedFields() async throws {
    var capturedRequest: URLRequest?
    var capturedBody: [String: Any]?

    let putURL = serverURL.appending(
      path: "/api/passwords/\(entryId)", directoryHint: .notDirectory)

    // PUT succeeds; all other requests (sync fetches) return empty arrays.
    MockURLProtocol.requestHandler = { request in
      if request.httpMethod == "PUT" {
        capturedRequest = request
        if let data = request.httpBody ?? readStream(request.httpBodyStream),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
          capturedBody = json
        }
        return (Data(), httpResponse(status: 200, url: putURL))
      }
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let (apiClient, syncService) = makeClientAndSyncService()
    let vm = await VaultViewModel()

    let summary = VaultEntrySummary(
      id: entryId, title: "Old", username: "old@example.com", urlHost: "example.com")
    await MainActor.run { vm.injectSummaries([summary]) }

    let detail = EntryPlaintext(
      title: "New Title",
      username: "new@example.com",
      password: "newpass",
      url: "https://new.example.com",
      tags: ["updated"]
    )
    let overview = OverviewPlaintext(
      title: "New Title",
      username: "new@example.com",
      urlHost: "new.example.com",
      tags: ["updated"]
    )

    try await vm.saveEntry(
      entryId: entryId,
      userId: userId,
      detail: detail,
      overview: overview,
      vaultKey: vaultKey,
      apiClient: apiClient,
      hostSyncService: syncService
    )

    // Assert PUT was sent to the correct path.
    let req = try XCTUnwrap(capturedRequest)
    XCTAssertEqual(req.httpMethod, "PUT")
    XCTAssertTrue(req.url?.path.hasSuffix("/\(entryId)") ?? false)

    // Assert DPoP header is present.
    XCTAssertNotNil(req.value(forHTTPHeaderField: "DPoP"))

    // Assert Authorization uses DPoP scheme.
    let auth = try XCTUnwrap(req.value(forHTTPHeaderField: "Authorization"))
    XCTAssertTrue(auth.hasPrefix("DPoP "))

    // Assert body contains non-empty ciphertext fields.
    let body = try XCTUnwrap(capturedBody)
    let blob = try XCTUnwrap(body["encryptedBlob"] as? [String: Any])
    XCTAssertFalse((blob["ciphertext"] as? String ?? "").isEmpty)

    let overviewBody = try XCTUnwrap(body["encryptedOverview"] as? [String: Any])
    XCTAssertFalse((overviewBody["ciphertext"] as? String ?? "").isEmpty)
  }

  // MARK: - testSaveEntry_throwsForTeamEntry

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
        detail: EntryPlaintext(title: "T", username: "u", password: "p"),
        overview: OverviewPlaintext(title: "T", username: "u"),
        vaultKey: vaultKey,
        apiClient: apiClient,
        hostSyncService: syncService
      )
      XCTFail("Expected teamEditNotSupported")
    } catch VaultViewModelError.teamEditNotSupported {
      // Expected.
    }
  }

  // MARK: - testSaveEntry_callsRunSyncAfterServerSuccess

  func testSaveEntry_callsRunSyncAfterServerSuccess() async throws {
    let putURL = serverURL.appending(
      path: "/api/passwords/\(entryId)", directoryHint: .notDirectory)

    var syncFetchCalled = false
    MockURLProtocol.requestHandler = { request in
      if request.httpMethod == "PUT" {
        return (Data(), httpResponse(status: 200, url: putURL))
      }
      // Sync fetches — return empty list.
      syncFetchCalled = true
      return (Data("[]".utf8), httpResponse(status: 200, url: request.url!))
    }

    let (apiClient, syncService) = makeClientAndSyncService()
    let vm = await VaultViewModel()
    let summary = VaultEntrySummary(
      id: entryId, title: "Title", username: "user", urlHost: "example.com")
    await MainActor.run { vm.injectSummaries([summary]) }

    try await vm.saveEntry(
      entryId: entryId,
      userId: userId,
      detail: EntryPlaintext(title: "New", username: "new", password: "pass"),
      overview: OverviewPlaintext(title: "New", username: "new"),
      vaultKey: vaultKey,
      apiClient: apiClient,
      hostSyncService: syncService
    )

    // runSync triggers HTTP fetch calls — this confirms it ran after the server returned 2xx.
    XCTAssertTrue(syncFetchCalled, "HostSyncService.runSync should have been called after PUT 200")
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
    seedBlobInKeychain(kc, counter: 1)
    return BridgeKeyStore(
      accessGroup: "test",
      service: "com.test.vm.bridge-key",
      keychain: kc
    )
  }
}

// MARK: - VaultViewModel test helper

extension VaultViewModel {
  /// Inject summaries for testing — bypasses the cache decrypt path.
  @MainActor
  func injectSummaries(_ summaries: [VaultEntrySummary]) {
    allSummaries = summaries
  }
}
