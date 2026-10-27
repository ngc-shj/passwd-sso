import Foundation
import XCTest

@testable import PasswdSSOApp
@testable import Shared

// Uses MockURLProtocol/makeSession/httpResponse/tokenResponseJSON
// (MobileAPIClientTests.swift), FakeKeychain (HostTokenStoreTests.swift) and
// FakeSigner (DPoPProofBuilderTests.swift).

private let passkeyRequiredBody = Data(#"{"error":"PASSKEY_REQUIRED"}"#.utf8)

/// An isolated App-Group stand-in, so a PASSKEY_REQUIRED stub never leaks the
/// flag into the real suite other tests (favicons) and the test host read.
private func makeIsolatedDefaults() -> (UserDefaults, String) {
  let name = "com.test.passkey-requirement.\(UUID().uuidString)"
  return (UserDefaults(suiteName: name)!, name)
}

// MARK: - Error-body decoder

final class APIErrorBodyTests: XCTestCase {
  func testDecodesPasskeyRequiredCode() {
    XCTAssertEqual(apiErrorCode(from: passkeyRequiredBody), "PASSKEY_REQUIRED")
  }

  func testDecodesCodeAlongsideExtraFields() {
    let body = Data(#"{"error":"QUOTA_EXCEEDED","resource":"passwords","max":10}"#.utf8)
    XCTAssertEqual(apiErrorCode(from: body), "QUOTA_EXCEEDED")
  }

  func testEmptyOrMalformedBodyHasNoCode() {
    XCTAssertNil(apiErrorCode(from: Data()))
    XCTAssertNil(apiErrorCode(from: Data("{invalid".utf8)))
    XCTAssertNil(apiErrorCode(from: Data(#"{"message":"x"}"#.utf8)))
  }

  func test403WithPasskeyRequiredCodeIsPasskeyRefusal() {
    XCTAssertTrue(isPasskeyRequiredResponse(status: 403, body: passkeyRequiredBody))
  }

  func test403WithOtherCodeIsNotPasskeyRefusal() {
    XCTAssertFalse(isPasskeyRequiredResponse(
      status: 403, body: Data(#"{"error":"KEY_NOT_DISTRIBUTED"}"#.utf8)))
    XCTAssertFalse(isPasskeyRequiredResponse(status: 403, body: Data()))
  }

  func testPasskeyCodeOnOtherStatusIsNotPasskeyRefusal() {
    XCTAssertFalse(isPasskeyRequiredResponse(status: 401, body: passkeyRequiredBody))
  }
}

// MARK: - Shared flag + passkey page URL

final class PasskeyRequirementStoreTests: XCTestCase {
  private var defaults: UserDefaults!
  private var suiteName: String!

  override func setUp() {
    super.setUp()
    (defaults, suiteName) = makeIsolatedDefaults()
  }

  override func tearDown() {
    defaults.removePersistentDomain(forName: suiteName)
    super.tearDown()
  }

  func testMarkThenClearRoundTrips() {
    let store = PasskeyRequirementStore(defaults: defaults)
    XCTAssertFalse(store.isRequired)
    store.markRequired()
    XCTAssertTrue(store.isRequired)
    store.clear()
    XCTAssertFalse(store.isRequired)
  }

  func testPostsChangeNotificationOnlyOnChange() {
    let store = PasskeyRequirementStore(defaults: defaults)
    let posted = expectation(forNotification: PasskeyRequirementStore.didChange, object: nil)
    posted.expectedFulfillmentCount = 2
    posted.assertForOverFulfill = true
    store.clear()          // already clear → no post
    store.markRequired()   // post 1
    store.markRequired()   // unchanged → no post
    store.clear()          // post 2
    wait(for: [posted], timeout: 1)
  }

  func testPasskeySettingsURLUsesForcedLanguage() {
    let server = URL(string: "https://pw.example.com")!
    XCTAssertEqual(
      passkeySettingsURL(serverURL: server, language: .ja, preferredLanguages: ["en-US"]).absoluteString,
      "https://pw.example.com/ja/dashboard/settings/auth/passkey")
    XCTAssertEqual(
      passkeySettingsURL(serverURL: server, language: .en, preferredLanguages: ["ja-JP"]).absoluteString,
      "https://pw.example.com/en/dashboard/settings/auth/passkey")
  }

  func testPasskeySettingsURLFollowsDeviceLanguageAndFallsBackToEnglish() {
    let server = URL(string: "https://pw.example.com")!
    XCTAssertEqual(
      passkeySettingsURL(serverURL: server, language: .system, preferredLanguages: ["ja-JP"]).path,
      "/ja/dashboard/settings/auth/passkey")
    XCTAssertEqual(
      passkeySettingsURL(serverURL: server, language: .system, preferredLanguages: ["fr-FR"]).path,
      "/en/dashboard/settings/auth/passkey")
  }

  func testPasskeySettingsURLKeepsDeploymentBasePath() {
    let server = URL(string: "https://host.example/passwd-sso")!
    XCTAssertEqual(
      passkeySettingsURL(serverURL: server, language: .en).absoluteString,
      "https://host.example/passwd-sso/en/dashboard/settings/auth/passkey")
  }
}

// MARK: - API client call-site mapping

final class MobileAPIClientPasskeyRequiredTests: XCTestCase {
  private let serverURL = URL(string: "https://test.passwd-sso.example")!
  private let knownJWK: [String: String] = [
    "kty": "EC", "crv": "P-256",
    "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ]
  private var tokenStore: HostTokenStore!
  private var defaults: UserDefaults!
  private var suiteName: String!
  private var store: PasskeyRequirementStore!

  override func setUp() {
    super.setUp()
    tokenStore = HostTokenStore(service: "com.test.passkey-required", keychain: FakeKeychain())
    (defaults, suiteName) = makeIsolatedDefaults()
    store = PasskeyRequirementStore(defaults: defaults)
    MockURLProtocol.requestHandler = nil
  }

  override func tearDown() {
    defaults.removePersistentDomain(forName: suiteName)
    super.tearDown()
  }

  private func makeClient() -> MobileAPIClient {
    MobileAPIClient(
      serverURL: serverURL, signer: FakeSigner(), jwk: knownJWK,
      tokenStore: tokenStore, urlSession: makeSession(),
      refreshCoordinator: TokenRefreshCoordinator(),
      passkeyRequirement: store
    )
  }

  private func seedValidAccessToken() {
    try? tokenStore.saveTokens(
      access: "acc", refresh: "ref", expiresAt: Date().addingTimeInterval(3600))
  }

  private func stubAll(status: Int, body: Data) {
    MockURLProtocol.requestHandler = { request in
      (body, httpResponse(status: status, url: request.url!))
    }
  }

  // fetchTeamMemberKey used to read every 403 as "not distributed" and skip the team.

  func testFetchTeamMemberKey_passkeyRequired_isNotTeamKeyNotDistributed() async throws {
    seedValidAccessToken()
    stubAll(status: 403, body: passkeyRequiredBody)
    do {
      _ = try await makeClient().fetchTeamMemberKey(teamId: "team-1")
      XCTFail("expected passkeyRequired")
    } catch {
      XCTAssertEqual(error as? MobileAPIError, .passkeyRequired)
    }
    XCTAssertTrue(store.isRequired, "the refusal must be recorded for the app-level notice")
  }

  func testFetchTeamMemberKey_keyNotDistributed_staysTeamKeyNotDistributed() async throws {
    seedValidAccessToken()
    stubAll(status: 403, body: Data(#"{"error":"KEY_NOT_DISTRIBUTED"}"#.utf8))
    do {
      _ = try await makeClient().fetchTeamMemberKey(teamId: "team-1")
      XCTFail("expected teamKeyNotDistributed")
    } catch {
      XCTAssertEqual(error as? MobileAPIError, .teamKeyNotDistributed)
    }
    XCTAssertFalse(store.isRequired)
  }

  func testCreateEntry_passkeyRequired_isNotQuotaOrServerError() async throws {
    seedValidAccessToken()
    stubAll(status: 403, body: passkeyRequiredBody)
    let enc = EncryptedData(
      ciphertext: "aabbcc", iv: "112233445566778899aabbcc",
      authTag: "deadbeefdeadbeefdeadbeefdeadbeef")
    let body = CreateEntryRequest(
      id: "e1", encryptedBlob: enc, encryptedOverview: enc,
      keyVersion: 1, aadVersion: 1, entryType: "LOGIN")
    do {
      _ = try await makeClient().createEntry(body: body)
      XCTFail("expected passkeyRequired")
    } catch {
      XCTAssertEqual(error as? MobileAPIError, .passkeyRequired)
    }
  }

  func testUpdateEntry_passkeyRequired() async throws {
    seedValidAccessToken()
    stubAll(status: 403, body: passkeyRequiredBody)
    do {
      try await makeClient().updateEntry(entryId: "e1", body: makeUpdateEntryRequestFixture())
      XCTFail("expected passkeyRequired")
    } catch {
      XCTAssertEqual(error as? MobileAPIError, .passkeyRequired)
    }
  }

  func testFetchFavicon_passkeyRequired_throwsInsteadOfReturningStatus() async throws {
    seedValidAccessToken()
    stubAll(status: 403, body: passkeyRequiredBody)
    let url = serverURL.appending(path: "/api/mobile/favicon", directoryHint: .notDirectory)
    do {
      _ = try await makeClient().fetchFavicon(url: url, using: makeSession())
      XCTFail("expected passkeyRequired")
    } catch {
      XCTAssertEqual(error as? MobileAPIError, .passkeyRequired)
    }
    XCTAssertTrue(store.isRequired)
  }

  /// The refresh gate refuses without revoking the token family, so a passkey
  /// refusal must not read as a dead session (which routes to re-sign-in).
  func testRefreshRefusedForPasskey_isNotAuthenticationRequired() async throws {
    try tokenStore.saveTokens(
      access: "acc_old", refresh: "ref_old", expiresAt: Date().addingTimeInterval(-10))
    stubAll(status: 403, body: passkeyRequiredBody)
    do {
      _ = try await makeClient().fetchVaultUnlockData()
      XCTFail("expected passkeyRequired")
    } catch {
      XCTAssertEqual(error as? MobileAPIError, .passkeyRequired)
    }
    XCTAssertEqual(try tokenStore.loadRefresh(), "ref_old", "tokens must survive the refusal")
  }

  func testLaterSuccessClearsRecordedRefusal() async throws {
    seedValidAccessToken()
    store.markRequired()
    MockURLProtocol.requestHandler = { request in
      (Data(#"{"fetchFavicons":true}"#.utf8), httpResponse(status: 200, url: request.url!))
    }
    _ = try await makeClient().getFaviconPref()
    XCTAssertFalse(store.isRequired)
  }

  /// The tamper report is exempt from the passkey gate, so its 2xx proves
  /// nothing about the requirement.
  func testGateExemptRollbackReportSuccessLeavesRecordedRefusal() async throws {
    seedValidAccessToken()
    store.markRequired()
    stubAll(status: 200, body: Data("{}".utf8))
    try await makeClient().postCacheRollbackReport(makeRollbackReport())
    XCTAssertTrue(store.isRequired)
  }

  /// A favicon 200 may come from the URLCache without reaching the server.
  func testFavicon200LeavesRecordedRefusal() async throws {
    seedValidAccessToken()
    store.markRequired()
    MockURLProtocol.requestHandler = { request in
      (Data([0x89, 0x50]), httpResponse(status: 200, url: request.url!, headers: ["Content-Type": "image/png"]))
    }
    let url = serverURL.appending(path: "/api/mobile/favicon", directoryHint: .notDirectory)
    _ = try await makeClient().fetchFavicon(url: url, using: makeSession())
    XCTAssertTrue(store.isRequired)
  }

  func testUnrelatedFailureLeavesRecordedRefusal() async throws {
    seedValidAccessToken()
    store.markRequired()
    stubAll(status: 500, body: Data())
    _ = try? await makeClient().getFaviconPref()
    XCTAssertTrue(store.isRequired, "only a success proves the requirement is met")
  }

  func testVaultUnlockerMapsPasskeyRequired() async throws {
    seedValidAccessToken()
    stubAll(status: 403, body: passkeyRequiredBody)
    let tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "PasskeyRequired-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let unlocker = VaultUnlocker(
      apiClient: makeClient(),
      bridgeKeyStore: BridgeKeyStore(
        accessGroup: "test", service: "com.passwd-sso.test.passkey.bridge-key",
        keychain: MockKeychain()),
      wrappedKeyStore: TempDirWrappedKeyStore(baseDir: tmpDir),
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory)
    )
    do {
      _ = try await unlocker.unlock(passphrase: "correct horse")
      XCTFail("expected passkeyRequired")
    } catch {
      XCTAssertEqual(error as? VaultUnlockError, .passkeyRequired)
    }
  }
}

func makeRollbackReport() -> CacheRollbackReportBody {
  CacheRollbackReportBody(
    deviceId: "device-test-001", expectedCounter: "42", observedCounter: "18",
    headerIssuedAt: 1_746_144_000, lastSuccessfulRefreshAt: 0, rejectionKind: "counter_mismatch")
}

// MARK: - Retry stop (foreground refresh)

final class ForegroundRefreshTests: XCTestCase {
  private var defaults: UserDefaults!
  private var suiteName: String!
  private var store: PasskeyRequirementStore!

  override func setUp() {
    super.setUp()
    (defaults, suiteName) = makeIsolatedDefaults()
    store = PasskeyRequirementStore(defaults: defaults)
    MockURLProtocol.requestHandler = nil
  }

  override func tearDown() {
    defaults.removePersistentDomain(forName: suiteName)
    super.tearDown()
  }

  func testRecordedRefusal_drainsButSkipsRemintAndSync() async {
    store.markRequired()
    var steps: [String] = []
    await ForegroundRefresh.run(
      passkeyRequirement: store,
      drain: { steps.append("drain") },
      remint: { steps.append("remint") },
      sync: { steps.append("sync") }
    )
    XCTAssertEqual(steps, ["drain"], "the gate-exempt tamper report still goes out; nothing else")
  }

  func testNoRefusal_runsDrainRemintSyncInOrder() async {
    var steps: [String] = []
    await ForegroundRefresh.run(
      passkeyRequirement: store,
      drain: { steps.append("drain") },
      remint: { steps.append("remint") },
      sync: { steps.append("sync") }
    )
    XCTAssertEqual(steps, ["drain", "remint", "sync"])
  }

  /// End to end through the real client: the drain's report is sent while the
  /// refusal stands, and its 2xx does not lift the gate for the steps after it.
  func testRecordedRefusal_realDrainRequestDoesNotLiftGate() async throws {
    store.markRequired()
    let tokenStore = HostTokenStore(service: "com.test.foreground-refresh", keychain: FakeKeychain())
    try tokenStore.saveTokens(access: "acc", refresh: "ref", expiresAt: Date().addingTimeInterval(3600))
    var requestedPaths: [String] = []
    MockURLProtocol.requestHandler = { request in
      requestedPaths.append(request.url?.path ?? "")
      return (Data("{}".utf8), httpResponse(status: 200, url: request.url!))
    }
    let client = MobileAPIClient(
      serverURL: URL(string: "https://test.passwd-sso.example")!, signer: FakeSigner(),
      jwk: ["kty": "EC", "crv": "P-256", "x": "x", "y": "y"],
      tokenStore: tokenStore, urlSession: makeSession(),
      refreshCoordinator: TokenRefreshCoordinator(), passkeyRequirement: store)
    var reminted = false
    await ForegroundRefresh.run(
      passkeyRequirement: store,
      drain: { try? await client.postCacheRollbackReport(makeRollbackReport()) },
      remint: { reminted = true },
      sync: {}
    )
    XCTAssertEqual(requestedPaths, ["/api/mobile/cache-rollback-report"])
    XCTAssertTrue(store.isRequired)
    XCTAssertFalse(reminted)
  }
}

// MARK: - Cross-process refresh + sign-out/server change

@MainActor
final class PasskeyRequirementMonitorTests: XCTestCase {
  func testRefreshPicksUpWriteFromAnotherProcess() {
    let (defaults, name) = makeIsolatedDefaults()
    defer { defaults.removePersistentDomain(forName: name) }
    let monitor = PasskeyRequirementMonitor(store: PasskeyRequirementStore(defaults: defaults))
    XCTAssertFalse(monitor.isRequired)
    // What the AutoFill extension's write looks like here: the suite changes,
    // no in-process notification.
    defaults.set(true, forKey: PasskeyRequirementStore.defaultsKey)
    monitor.refresh()
    XCTAssertTrue(monitor.isRequired)
  }
}

final class PasskeyRequirementLifecycleTests: XCTestCase {
  @MainActor
  func testSignOutClearsRecordedRefusal() {
    let (defaults, name) = makeIsolatedDefaults()
    defer { defaults.removePersistentDomain(forName: name) }
    let store = PasskeyRequirementStore(defaults: defaults)
    store.markRequired()
    let tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "PasskeySignOut-\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    let keychain = MockKeychain()
    let service = AutoLockService(
      bridgeKeyStore: BridgeKeyStore(
        accessGroup: "test", service: "com.passwd-sso.test.passkey-signout.bridge-key", keychain: keychain),
      wrappedKeyStore: TempDirWrappedKeyStore(baseDir: tmpDir),
      tokenStore: HostTokenStore(service: "com.passwd-sso.test.passkey-signout.tokens", keychain: keychain),
      cacheURL: tmpDir.appending(path: "test.cache", directoryHint: .notDirectory),
      faviconCacheClearing: {},
      passkeyRequirement: store
    )
    service.signOut()
    XCTAssertFalse(store.isRequired)
  }

  func testServerChangeClearsRecordedRefusalButReverifyKeepsIt() {
    let (defaults, name) = makeIsolatedDefaults()
    defer { defaults.removePersistentDomain(forName: name) }
    let store = PasskeyRequirementStore(defaults: defaults)
    saveServerConfig(ServerConfig(baseURL: URL(string: "https://a.example")!), defaults: defaults)
    store.markRequired()
    saveServerConfig(ServerConfig(baseURL: URL(string: "https://a.example")!), defaults: defaults)
    XCTAssertTrue(store.isRequired, "re-verifying the same server keeps its verdict")
    saveServerConfig(ServerConfig(baseURL: URL(string: "https://b.example")!), defaults: defaults)
    XCTAssertFalse(store.isRequired)
  }
}

// MARK: - Retry stop (background sync)

final class BackgroundSyncAttemptTests: XCTestCase {
  private var defaults: UserDefaults!
  private var suiteName: String!
  private var store: PasskeyRequirementStore!

  override func setUp() {
    super.setUp()
    (defaults, suiteName) = makeIsolatedDefaults()
    store = PasskeyRequirementStore(defaults: defaults)
  }

  override func tearDown() {
    defaults.removePersistentDomain(forName: suiteName)
    super.tearDown()
  }

  func testRecordedRefusal_skipsSyncAndDoesNotReschedule() async {
    store.markRequired()
    var syncCalls = 0
    let attempt = await BackgroundSyncRunner.attempt(passkeyRequirement: store) {
      syncCalls += 1
    }
    XCTAssertEqual(syncCalls, 0, "no request while the refusal stands")
    XCTAssertEqual(attempt, .init(success: false, reschedule: false))
  }

  func testPasskeyRefusalDuringSync_doesNotReschedule() async {
    let attempt = await BackgroundSyncRunner.attempt(passkeyRequirement: store) {
      throw MobileAPIError.passkeyRequired
    }
    XCTAssertEqual(attempt, .init(success: false, reschedule: false))
  }

  func testTransientFailure_stillReschedules() async {
    let attempt = await BackgroundSyncRunner.attempt(passkeyRequirement: store) {
      throw MobileAPIError.serverError(status: 503)
    }
    XCTAssertEqual(attempt, .init(success: false, reschedule: true))
  }

  func testSuccess_reschedules() async {
    var syncCalls = 0
    let attempt = await BackgroundSyncRunner.attempt(passkeyRequirement: store) {
      syncCalls += 1
    }
    XCTAssertEqual(syncCalls, 1)
    XCTAssertEqual(attempt, .init(success: true, reschedule: true))
  }

  func testAutomaticCallsResumeOnceCleared() {
    store.markRequired()
    XCTAssertFalse(automaticServerCallsAllowed(store: store))
    store.clear()
    XCTAssertTrue(automaticServerCallsAllowed(store: store))
  }
}

// MARK: - Sign-in refusal + user-facing mapping

final class PasskeyRequiredPresentationTests: XCTestCase {
  func testSignInCallbackWithPasskeyRequiredErrorIsItsOwnError() {
    let url = URL(string: "passwd-sso://auth/callback?error=passkey_required&state=xyz")!
    XCTAssertThrowsError(try AuthCoordinator.parseCallback(url: url, expectedState: "xyz")) { error in
      XCTAssertEqual(error as? AuthError, .passkeyRequired)
    }
  }

  /// A refusal this sign-in did not start (wrong or no state) must not plant
  /// the passkey notice.
  func testSignInPasskeyRefusalWithForeignStateIsRejected() {
    let foreign = URL(string: "passwd-sso://auth/callback?error=passkey_required&state=other")!
    XCTAssertThrowsError(try AuthCoordinator.parseCallback(url: foreign, expectedState: "xyz")) { error in
      XCTAssertEqual(error as? AuthError, .stateMismatch)
    }
    let stateless = URL(string: "passwd-sso://auth/callback?error=passkey_required")!
    XCTAssertThrowsError(try AuthCoordinator.parseCallback(url: stateless, expectedState: "xyz")) { error in
      XCTAssertNotEqual(error as? AuthError, .passkeyRequired)
    }
  }

  func testSignInCallbackWithCodeStillParses() throws {
    let url = URL(string: "passwd-sso://auth/callback?code=abc&state=xyz")!
    XCTAssertEqual(try AuthCoordinator.parseCallback(url: url, expectedState: "xyz"), "abc")
    XCTAssertThrowsError(try AuthCoordinator.parseCallback(url: url, expectedState: "nope")) { error in
      XCTAssertEqual(error as? AuthError, .stateMismatch)
    }
  }

  // MARK: Manual sync alert

  func testManualSyncAlert_newPasskeyRefusalDefersToAppAlert() {
    XCTAssertNil(manualSyncErrorMessage(error: MobileAPIError.passkeyRequired, passkeyWasRequired: false))
  }

  func testManualSyncAlert_repeatedPasskeyRefusalIsAnswered() {
    XCTAssertEqual(
      manualSyncErrorMessage(error: MobileAPIError.passkeyRequired, passkeyWasRequired: true),
      L10n.string("Your organization requires a passkey. Register one in your browser, then try again."))
  }

  func testManualSyncAlert_otherFailuresKeepTheirMessages() {
    XCTAssertEqual(
      manualSyncErrorMessage(error: MobileAPIError.authenticationRequired, passkeyWasRequired: true),
      L10n.string("Your session expired. Lock and unlock to sign in again."))
    XCTAssertEqual(
      manualSyncErrorMessage(error: MobileAPIError.serverError(status: 503), passkeyWasRequired: false),
      L10n.string("Couldn't sync. Check your connection and try again."))
  }

  func testFailClosedUnlockNamesPasskeyRequirement() {
    XCTAssertEqual(
      failClosedResult(sessionExpired: false, passkeyRequired: true), .failedPasskeyRequired)
    XCTAssertTrue(syncFailedPasskeyRequired(from: MobileAPIError.passkeyRequired))
    XCTAssertFalse(syncFailedSessionExpired(from: MobileAPIError.passkeyRequired),
      "a passkey refusal must not raise the signed-out banner")
  }

  func testSaveErrorMessageForPasskeyRefusalIsNotGeneric() {
    let message = EntryForm.saveErrorMessage(for: MobileAPIError.passkeyRequired)
    XCTAssertNotEqual(message, EntryForm.saveErrorMessage(for: MobileAPIError.serverError(status: 500)))
    XCTAssertEqual(
      message,
      L10n.string("Your organization requires a passkey. Register one in your browser to save changes."))
  }
}
