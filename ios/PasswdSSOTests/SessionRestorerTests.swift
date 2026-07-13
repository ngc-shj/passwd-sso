import XCTest

@testable import PasswdSSOApp
@testable import Shared

/// Routing-matrix tests for SessionRestorer (plan C3 / T1). The four seams are
/// injected as closures so the routing is exercised without a real Secure
/// Enclave or network.
final class SessionRestorerTests: XCTestCase {
  private let config = ServerConfig(baseURL: URL(string: "https://srv.example")!)

  /// Counts validate() invocations across an async restore.
  private actor CallCounter {
    private(set) var count = 0
    func bump() { count += 1 }
  }

  private func dummyClient() -> MobileAPIClient {
    MobileAPIClient(
      serverURL: URL(string: "https://dummy.example")!,
      signer: FakeSigner(),
      jwk: [:],
      tokenStore: HostTokenStore(service: "com.test.session-restorer", keychain: FakeKeychain()),
      urlSession: .shared
    )
  }

  private func makeRestorer(
    loadConfig: @escaping @Sendable () -> ServerConfig?,
    hasTokens: @escaping @Sendable () -> Bool = { true },
    makeSession: (@Sendable (ServerConfig) async -> MobileAPIClient?)? = nil,
    validate: @escaping @Sendable (MobileAPIClient) async -> SessionValidation = { _ in .ok },
    pinExists: @escaping @Sendable (ServerConfig) async -> Bool = { _ in false }
  ) -> SessionRestorer {
    let client = dummyClient()
    return SessionRestorer(
      loadConfig: loadConfig,
      hasTokens: hasTokens,
      makeSession: makeSession ?? { _ in client },
      validate: validate,
      pinExists: pinExists
    )
  }

  // MARK: - Routing matrix

  func testRestore_noConfig_needsSetup() async {
    let result = await makeRestorer(loadConfig: { nil }).restore()
    guard case .needsSetup = result else { return XCTFail("expected .needsSetup, got \(result)") }
  }

  func testRestore_noTokens_needsSignIn() async {
    let result = await makeRestorer(loadConfig: { [config] in config }, hasTokens: { false }).restore()
    guard case .needsSignIn = result else { return XCTFail("expected .needsSignIn, got \(result)") }
  }

  func testRestore_makeSessionNil_keyGone_needsSignIn() async {
    let result = await makeRestorer(
      loadConfig: { [config] in config },
      hasTokens: { true },
      makeSession: { _ in nil }
    ).restore()
    guard case .needsSignIn = result else { return XCTFail("expected .needsSignIn, got \(result)") }
  }

  // Distinct fixture from the key-gone case (T1f2): a makeSession that returns
  // nil for a different reason (e.g. signer/JWK export failure) routes the same.
  func testRestore_makeSessionNil_signerExportFailed_needsSignIn() async {
    let signerExportFailed: @Sendable (ServerConfig) async -> MobileAPIClient? = { _ in nil }
    let result = await makeRestorer(
      loadConfig: { [config] in config },
      hasTokens: { true },
      makeSession: signerExportFailed
    ).restore()
    guard case .needsSignIn = result else { return XCTFail("expected .needsSignIn, got \(result)") }
  }

  // makeSession fails with tokens present → sign-in (signer re-derived there).
  // A stored pin does NOT reroute this to re-verify — identity-changed is
  // reserved for a validate() TLS rejection, not a build failure.
  func testRestore_makeSessionNil_pinExists_stillNeedsSignIn() async {
    let result = await makeRestorer(
      loadConfig: { [config] in config },
      hasTokens: { true },
      makeSession: { _ in nil },
      pinExists: { _ in true }
    ).restore()
    guard case .needsSignIn = result else { return XCTFail("expected .needsSignIn, got \(result)") }
  }

  // No tokens + a stored pin → the server may have rotated its identity; route
  // to re-verify so sign-in doesn't silently hit the same pinned wall.
  func testRestore_noTokens_pinExists_serverIdentityChanged() async {
    let result = await makeRestorer(
      loadConfig: { [config] in config },
      hasTokens: { false },
      pinExists: { _ in true }
    ).restore()
    guard case .serverIdentityChanged = result else {
      return XCTFail("expected .serverIdentityChanged, got \(result)")
    }
  }

  // No tokens + no pin → plain sign-in.
  func testRestore_noTokens_noPin_needsSignIn() async {
    let result = await makeRestorer(
      loadConfig: { [config] in config },
      hasTokens: { false },
      pinExists: { _ in false }
    ).restore()
    guard case .needsSignIn = result else { return XCTFail("expected .needsSignIn, got \(result)") }
  }

  func testRestore_validateOk_needsUnlock() async {
    let result = await makeRestorer(loadConfig: { [config] in config }, validate: { _ in .ok }).restore()
    guard case .needsUnlock = result else { return XCTFail("expected .needsUnlock, got \(result)") }
  }

  // Offline (transient) with a valid pin → cached vault stays unlockable; NOT a
  // server-identity warning.
  func testRestore_validateOffline_needsUnlock() async {
    let result = await makeRestorer(loadConfig: { [config] in config }, validate: { _ in .offline }).restore()
    guard case .needsUnlock = result else { return XCTFail("expected .needsUnlock, got \(result)") }
  }

  func testRestore_validateDead_needsReauth() async {
    let result = await makeRestorer(loadConfig: { [config] in config }, validate: { _ in .dead }).restore()
    guard case .needsReauth = result else { return XCTFail("expected .needsReauth, got \(result)") }
  }

  // validate() reports a pinned-TLS rejection → re-verify affordance.
  func testRestore_validateIdentityMismatch_serverIdentityChanged() async {
    let result = await makeRestorer(
      loadConfig: { [config] in config },
      validate: { _ in .identityMismatch }
    ).restore()
    guard case .serverIdentityChanged = result else {
      return XCTFail("expected .serverIdentityChanged, got \(result)")
    }
  }

  // MARK: - validate is not invoked when a precondition fails

  func testRestore_validateNotCalledWhenPreconditionsFail() async {
    let spy = CallCounter()
    let validate: @Sendable (MobileAPIClient) async -> SessionValidation = { _ in
      await spy.bump()
      return .ok
    }

    _ = await makeRestorer(loadConfig: { nil }, validate: validate).restore()
    _ = await makeRestorer(
      loadConfig: { [config] in config }, hasTokens: { false }, validate: validate
    ).restore()
    _ = await makeRestorer(
      loadConfig: { [config] in config }, hasTokens: { true },
      makeSession: { _ in nil }, validate: validate
    ).restore()

    let count = await spy.count
    XCTAssertEqual(count, 0, "validate must not run when config/tokens/session preconditions fail")
  }
}
