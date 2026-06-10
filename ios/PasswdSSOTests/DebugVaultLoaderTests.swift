#if DEBUG
import CryptoKit
import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

// MARK: - DebugVaultLoaderTests

final class DebugVaultLoaderTests: XCTestCase {

  private var tmpDir: URL!
  private var cacheURL: URL!
  private var keychain: MockKeychainAccessor!
  private var bridgeKeyStore: BridgeKeyStore!
  private var wrappedKeyStore: TempDirWrappedKeyStore!

  override func setUp() {
    super.setUp()
    tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "DebugVaultLoaderTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    cacheURL = tmpDir.appending(path: "encryptedEntries.cache", directoryHint: .notDirectory)
    keychain = MockKeychainAccessor()
    bridgeKeyStore = BridgeKeyStore(
      accessGroup: "test.jp.jpng.passwd-sso.shared",
      keychain: keychain
    )
    wrappedKeyStore = TempDirWrappedKeyStore(baseDir: tmpDir)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: tmpDir)
    super.tearDown()
  }

  // MARK: - Helpers

  private func makeResolver() -> CredentialResolver {
    CredentialResolver(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: wrappedKeyStore,
      cacheURL: cacheURL
    )
  }

  private func loadFixture() async throws -> DebugVaultLoader.LoadedState {
    try await DebugVaultLoader.loadFixtureVault(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: wrappedKeyStore,
      cacheURL: cacheURL
    )
  }

  // MARK: - End-to-end: loadFixtureVault writes all fixtures

  func testLoadFixtureVault_writesAllFixturesEndToEnd() async throws {
    _ = try await loadFixture()

    let resolver = makeResolver()
    let ident = ServiceIdentifier(
      identifier: "https://github.com/login",
      isURL: true
    )
    let candidates = try await resolver.resolveCandidates(for: [ident])

    let githubEntry = candidates.first { $0.urlHost == "github.com" }
    XCTAssertNotNil(githubEntry, "Expected at least one entry with urlHost == 'github.com'")
  }

  // MARK: - End-to-end: resolver decrypts correct passwords

  func testLoadFixtureVault_resolverDecryptsCorrectPasswords() async throws {
    _ = try await loadFixture()

    let resolver = makeResolver()
    let ident = ServiceIdentifier(identifier: "https://github.com/login", isURL: true)
    let candidates = try await resolver.resolveCandidates(for: [ident])

    guard let githubSummary = candidates.first(where: { $0.urlHost == "github.com" }) else {
      XCTFail("No github.com candidate found")
      return
    }

    let detail = try await resolver.decryptEntryDetail(entryId: githubSummary.id)
    XCTAssertEqual(detail.password, "DebugPassword123!")
    XCTAssertEqual(detail.username, "testuser@example.com")
  }

  // MARK: - reset clears state

  func testLoadFixtureVault_reset_clearsState() async throws {
    _ = try await loadFixture()

    // Verify fixture is loaded (bridge key exists)
    let blobBeforeReset = try? bridgeKeyStore.readDirect()
    XCTAssertNotNil(blobBeforeReset, "Bridge key should exist after load")

    // Reset clears all state
    try DebugVaultLoader.reset(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: wrappedKeyStore,
      cacheURL: cacheURL
    )

    // Bridge key should be gone
    do {
      _ = try bridgeKeyStore.readDirect()
      XCTFail("Expected notFound after reset")
    } catch BridgeKeyStore.Error.notFound {
      // expected
    }

    // Wrapped vault key should be gone
    let wrappedVK = try wrappedKeyStore.loadVaultKey()
    XCTAssertNil(wrappedVK, "Wrapped vault key should be nil after reset")

    // Cache file should be gone
    let cacheExists = FileManager.default.fileExists(atPath: cacheURL.path)
    XCTAssertFalse(cacheExists, "Cache file should be absent after reset")
  }

  // MARK: - All three fixture entries are loadable

  func testLoadFixtureVault_allThreeEntriesResolve() async throws {
    _ = try await loadFixture()

    let resolver = makeResolver()
    // Resolve all with no filter
    let all = try await resolver.resolveCandidates(for: [])
    XCTAssertEqual(all.count, 3, "Expected exactly 3 fixture entries")

    let hosts = Set(all.map(\.urlHost))
    XCTAssertTrue(hosts.contains("github.com"), "Missing github.com")
    XCTAssertTrue(hosts.contains("example.com"), "Missing example.com")
    XCTAssertTrue(hosts.contains("appleid.apple.com"), "Missing appleid.apple.com")
  }

  // MARK: - TOTP entry is decodable (hasTOTP always false from overview blob)

  func testLoadFixtureVault_totpEntryDecodable() async throws {
    _ = try await loadFixture()

    let resolver = makeResolver()
    let all = try await resolver.resolveCandidates(for: [])

    // The overview blob does not carry TOTP info, so hasTOTP is always false in the summary.
    // TOTP secret is only available after decryptEntryDetail (from the full blob).
    // This is a known limitation: the TOTP-only AutoFill picker filter is degraded,
    // but entry list and detail decrypt correctly (see CredentialResolver hasTOTP comment).
    let exampleEntry = all.first { $0.urlHost == "example.com" }
    XCTAssertNotNil(exampleEntry, "Expected example.com entry")
    XCTAssertFalse(
      exampleEntry?.hasTOTP == true,
      "hasTOTP is always false from overview blob (TOTP only available in full blob)"
    )

    // Verify the TOTP secret is accessible via detail decrypt.
    if let entry = exampleEntry {
      let detail = try await resolver.decryptEntryDetail(entryId: entry.id)
      XCTAssertEqual(
        detail.totpSecret, "JBSWY3DPEHPK3PXP",
        "TOTP secret must be decryptable from full blob"
      )
    }
  }
}

#endif
