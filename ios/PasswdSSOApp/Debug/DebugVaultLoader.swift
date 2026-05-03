#if DEBUG
import CryptoKit
import Foundation
import Shared

// MARK: - DebugVaultLoader

/// Loads a known-good fixture vault state for Simulator AutoFill testing.
/// Mirrors what VaultUnlocker + HostSyncService would produce for a real
/// signed-in user, but uses synthetic data so OAuth is bypassed.
///
/// All fixture entries are encrypted with VaultEntrySummary / VaultEntryDetail
/// JSON models and proper personal-entry AAD so CredentialResolver can decrypt
/// them without modification.
///
/// Usage: call `loadFixtureVault()` from the DEBUG button in SignInView.
/// The loaded state can be passed directly to RootView's state machine
/// as `.vaultUnlocked(...)` without running the OAuth flow.
public enum DebugVaultLoader {

  // MARK: - Result type

  public struct LoadedState: Sendable {
    public let vaultKey: SymmetricKey
    public let userId: String
    public let cacheData: CacheData
  }

  // MARK: - Fixture constants

  static let fixtureUserId = "debug-user-fixture-id"

  private static let fixtureEntries: [(
    id: String, title: String, urlString: String, host: String,
    username: String, password: String, totpSecret: String?
  )] = [
    (
      id: "00000000-0000-0000-0000-000000000001",
      title: "GitHub",
      urlString: "https://github.com/login",
      host: "github.com",
      username: "testuser@example.com",
      password: "DebugPassword123!",
      totpSecret: nil
    ),
    (
      id: "00000000-0000-0000-0000-000000000002",
      title: "Example",
      urlString: "https://example.com",
      host: "example.com",
      username: "demo@example.com",
      password: "demo-pass-2026",
      totpSecret: "JBSWY3DPEHPK3PXP"
    ),
    (
      id: "00000000-0000-0000-0000-000000000003",
      title: "Apple ID",
      urlString: "https://appleid.apple.com",
      host: "appleid.apple.com",
      username: "apple-test@example.com",
      password: "apple-test-pass",
      totpSecret: nil
    ),
  ]

  // MARK: - Public API

  /// Atomically:
  ///   - generates a fresh bridge_key blob (shared Keychain)
  ///   - generates a synthetic user vault_key
  ///   - wraps vault_key under cacheKey → writes WrappedVaultKey
  ///   - builds 3 fixture entries with proper AAD (VaultEntrySummary/VaultEntryDetail)
  ///   - writes the encrypted cache file
  ///
  /// Returns the in-memory vault_key + userId + cacheData so the caller can
  /// transition AppState to .vaultUnlocked without an OAuth roundtrip.
  public static func loadFixtureVault(
    bridgeKeyStore: BridgeKeyStore = BridgeKeyStore(
      accessGroup: AppGroupContainer.identifier
    ),
    wrappedKeyStore: any WrappedKeyStore = AppGroupWrappedKeyStore(),
    cacheURL: URL = (try? AppGroupContainer.cacheFileURL())
      ?? URL(fileURLWithPath: "/dev/null")
  ) async throws -> LoadedState {
    // Step 1: generate fresh bridge_key blob
    let blob = try bridgeKeyStore.create()

    // Step 2: derive cacheKey from bridge_key (used only for key wrapping)
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)

    // Step 3: generate a fresh synthetic vault_key (user's actual vault_key)
    let vaultKey = SymmetricKey(size: .bits256)

    // Step 4: wrap vault_key under cacheKey → persist as WrappedVaultKey
    let vaultKeyBytes = vaultKey.withUnsafeBytes { Data($0) }
    let (cipher, iv, tag) = try encryptAESGCM(plaintext: vaultKeyBytes, key: cacheKey)
    let wrappedVaultKey = WrappedVaultKey(
      ciphertext: cipher,
      iv: iv,
      authTag: tag,
      issuedAt: Date()
    )
    try wrappedKeyStore.saveVaultKey(wrappedVaultKey)

    // Step 5: build fixture cache entries encrypted with vault_key + personal AAD
    let cacheEntries = try buildFixtureCacheEntries(
      vaultKey: vaultKey,
      userId: fixtureUserId
    )

    // Step 6: build and write cache file encrypted with vault_key
    let now = Date()
    let header = CacheHeader(
      cacheVersionCounter: blob.cacheVersionCounter,
      cacheIssuedAt: now,
      lastSuccessfulRefreshAt: now,
      entryCount: UInt32(cacheEntries.count),
      hostInstallUUID: blob.hostInstallUUID,
      userId: fixtureUserId
    )
    let entriesJSON = try JSONEncoder().encode(cacheEntries)
    let cacheData = CacheData(header: header, entries: entriesJSON)

    try AppGroupContainer.ensureDirectoryExists()
    try writeCacheFile(
      data: cacheData,
      vaultKey: vaultKey,
      hostInstallUUID: blob.hostInstallUUID,
      path: cacheURL
    )

    return LoadedState(
      vaultKey: vaultKey,
      userId: fixtureUserId,
      cacheData: cacheData
    )
  }

  /// Wipes any prior fixture state so a fresh load runs cleanly.
  public static func reset(
    bridgeKeyStore: BridgeKeyStore = BridgeKeyStore(
      accessGroup: AppGroupContainer.identifier
    ),
    wrappedKeyStore: any WrappedKeyStore = AppGroupWrappedKeyStore(),
    cacheURL: URL = (try? AppGroupContainer.cacheFileURL())
      ?? URL(fileURLWithPath: "/dev/null")
  ) throws {
    try? bridgeKeyStore.delete()
    try? wrappedKeyStore.clearAll()
    try? FileManager.default.removeItem(at: cacheURL)
  }

  // MARK: - Private helpers

  /// Build fixture CacheEntries with VaultEntrySummary/VaultEntryDetail JSON,
  /// encrypted with vault_key + buildPersonalEntryAAD(userId, entryId).
  /// Uses the same encryption format as CredentialResolver expects at decrypt time.
  private static func buildFixtureCacheEntries(
    vaultKey: SymmetricKey,
    userId: String
  ) throws -> [CacheEntry] {
    try fixtureEntries.map { fixture in
      let aad = try buildPersonalEntryAAD(userId: userId, entryId: fixture.id)

      let summary = VaultEntrySummary(
        id: fixture.id,
        title: fixture.title,
        username: fixture.username,
        urlHost: fixture.host,
        hasTOTP: fixture.totpSecret != nil
      )
      let detail = VaultEntryDetail(
        id: fixture.id,
        title: fixture.title,
        username: fixture.username,
        urlHost: fixture.host,
        password: fixture.password,
        url: fixture.urlString,
        notes: "",
        totpSecret: fixture.totpSecret
      )

      let encoder = JSONEncoder()
      let overviewData = try encoder.encode(summary)
      let detailData = try encoder.encode(detail)

      let overviewEncrypted = try encryptAESGCMEncoded(
        plaintext: overviewData, key: vaultKey, aad: aad
      )
      let blobEncrypted = try encryptAESGCMEncoded(
        plaintext: detailData, key: vaultKey, aad: aad
      )

      return CacheEntry(
        id: fixture.id,
        teamId: nil,
        aadVersion: 1,
        keyVersion: 1,
        teamKeyVersion: nil,
        itemKeyVersion: nil,
        encryptedItemKey: nil,
        encryptedBlob: blobEncrypted,
        encryptedOverview: overviewEncrypted
      )
    }
  }
}

#endif
