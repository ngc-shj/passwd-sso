import AuthenticationServices
import CryptoKit
import Foundation
import OSLog

// MARK: - Candidate result

/// Result of resolving AutoFill candidates for a set of service identifiers.
/// `matched` is host-matched entries only (the default picker view); `all` is
/// every decrypted summary with matched ones first (for the picker's search).
public struct CandidateResult: Sendable {
  public let matched: [VaultEntrySummary]
  public let all: [VaultEntrySummary]

  public init(matched: [VaultEntrySummary], all: [VaultEntrySummary]) {
    self.matched = matched
    self.all = all
  }
}

/// Partition decrypted summaries into host-matched vs. the full matched-first set.
/// Pure (no crypto/Keychain) so it is unit-testable in isolation.
public func partitionCandidates(
  _ summaries: [VaultEntrySummary],
  tabHosts: [String]
) -> CandidateResult {
  var matched: [VaultEntrySummary] = []
  var unmatched: [VaultEntrySummary] = []
  for summary in summaries {
    let isMatch = tabHosts.contains { host in
      (!summary.urlHost.isEmpty && isHostMatch(stored: summary.urlHost, current: host))
        || summary.additionalUrlHosts.contains { isHostMatch(stored: $0, current: host) }
    }
    if isMatch {
      matched.append(summary)
    } else {
      unmatched.append(summary)
    }
  }
  return CandidateResult(matched: matched, all: matched + unmatched)
}

/// Case-insensitive search predicate for the picker search field: matches when
/// the trimmed query is a substring of the entry's title, username, or urlHost.
/// An empty/whitespace query returns false (the caller shows `matched` instead).
public func summaryMatchesSearch(_ summary: VaultEntrySummary, query: String) -> Bool {
  let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  guard !q.isEmpty else { return false }
  return summary.title.lowercased().contains(q)
    || summary.username.lowercased().contains(q)
    || summary.urlHost.lowercased().contains(q)
}

// MARK: - Sendable service identifier

/// Sendable mirror of ASCredentialServiceIdentifier for crossing actor boundaries.
public struct ServiceIdentifier: Sendable {
  public let identifier: String
  public let isURL: Bool

  public init(identifier: String, isURL: Bool) {
    self.identifier = identifier
    self.isURL = isURL
  }

  public init(from source: ASCredentialServiceIdentifier) {
    self.identifier = source.identifier
    self.isURL = source.type == .URL
  }
}

/// The AutoFill extension's entry point for resolving cached vault entries.
///
/// Per plan §"Token shape": the extension has NO bearer credential and makes NO network calls.
/// Per plan §"Per-fill biometric": exactly ONE Keychain read (one biometric prompt) per call.
/// Per plan §"Vault key zeroing": vault_key is zeroed before this actor method returns.
public actor CredentialResolver {

  // Diagnostic only — records WHICH of the three vault-locked sub-causes fired
  // (bridge_key read, wrapped-key absent, or unwrap failure) so the AutoFill
  // "vault locked" symptom is traceable in Console.app. No key material logged.
  private static let log = Logger(subsystem: AppGroupContainer.loggerSubsystem, category: "autofill")

  // MARK: - Error

  public enum Error: Swift.Error, Equatable {
    case vaultLocked           // bridge_key not in Keychain
    case cacheUnavailable      // App Group cache file absent
    case cacheRejected(CacheRejectionKind)  // forwarded from EntryCacheFile.readCacheFile
    case noEntries
    case entryNotFound
    case teamKeyStale(teamId: String)  // wrapped team key blob older than 15 minutes
  }

  // MARK: - Private state

  private let bridgeKeyStore: BridgeKeyStore
  private let wrappedKeyStore: any WrappedKeyStore
  private let cacheURL: URL
  private let teamKeyMaxAge: TimeInterval
  private let rollbackFlagWriter: (any RollbackFlagWriter)?
  private let now: () -> Date

  // Retain bridge-key blob for the duration of a fill (resolveCandidates → decryptEntryDetail).
  // Cleared on each new call to resolveCandidates.
  private var currentBlob: BridgeKeyStore.Blob?

  // MARK: - Initialiser

  public init(
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore,
    cacheURL: URL,
    teamKeyMaxAge: TimeInterval = 15 * 60,
    rollbackFlagWriter: (any RollbackFlagWriter)? = nil,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.bridgeKeyStore = bridgeKeyStore
    self.wrappedKeyStore = wrappedKeyStore
    self.cacheURL = cacheURL
    self.teamKeyMaxAge = teamKeyMaxAge
    self.rollbackFlagWriter = rollbackFlagWriter
    self.now = now
  }

  // MARK: - Public API

  /// Returns matched + full entry summaries (decrypted overviews) for a given set of service
  /// identifiers. Performs a SINGLE bridge_key Keychain read (one biometric prompt) per call.
  /// Vault_key derived from bridge_key is zeroed before this method returns.
  public func resolveCandidates(
    for serviceIdentifiers: [ServiceIdentifier]
  ) async throws -> CandidateResult {
    currentBlob = nil

    // Single biometric Keychain read.
    let blob: BridgeKeyStore.Blob
    do {
      blob = try await bridgeKeyStore.readForFillAuthenticated(reason: "Fill credential from passwd-sso vault")
    } catch {
      // BridgeKeyStore.readForFill already logged the raw OSStatus; record the
      // mapped cause here so the resolver-level branch is unambiguous.
      Self.log.error("resolveCandidates: vaultLocked at bridge_key read: \(String(describing: error), privacy: .public)")
      throw Error.vaultLocked
    }

    // Derive cacheKey from bridge_key — used only to unwrap the stored vault_key.
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)

    // Load the wrapped vault_key written by VaultUnlocker at unlock time.
    guard let wrapped = try? wrappedKeyStore.loadVaultKey() else {
      Self.log.error("resolveCandidates: vaultLocked — wrapped vault key absent (loadVaultKey nil)")
      throw Error.vaultLocked
    }

    // Unwrap: AES-GCM(ciphertext: wrapped.ciphertext, key: cacheKey) → user's vault_key.
    guard
      let vaultKeyData = try? decryptAESGCM(
        ciphertext: wrapped.ciphertext,
        iv: wrapped.iv,
        tag: wrapped.authTag,
        key: cacheKey
      )
    else {
      Self.log.error("resolveCandidates: vaultLocked — vault key unwrap failed (AES-GCM decrypt nil)")
      throw Error.vaultLocked
    }
    var mutableVaultKeyData = vaultKeyData
    defer { zeroData(&mutableVaultKeyData) }
    let vaultKey = SymmetricKey(data: vaultKeyData)

    // Read and integrity-check the cache file using the user's actual vault_key.
    let cacheData: CacheData
    do {
      cacheData = try readCacheFile(
        path: cacheURL,
        vaultKey: vaultKey,
        expectedHostInstallUUID: blob.hostInstallUUID,
        expectedCounter: blob.cacheVersionCounter,
        now: now()
      )
    } catch EntryCacheError.rejection(let kind, let context) {
      // Write a MAC-protected rollback flag for the host-app drain (Step 11 posts it).
      await writeRollbackFlag(kind: kind, context: context, blob: blob, vaultKey: vaultKey)
      throw Error.cacheRejected(kind)
    } catch {
      throw Error.cacheUnavailable
    }

    // Decode entries from JSON.
    let allEntries: [CacheEntry]
    do {
      allEntries = try JSONDecoder().decode([CacheEntry].self, from: cacheData.entries)
    } catch {
      throw Error.cacheUnavailable
    }

    // Decrypt summaries (overview blobs only).
    let userId = cacheData.header.userId
    let teamKeys = (try? wrappedKeyStore.loadTeamKeys()) ?? []
    var summaries: [VaultEntrySummary] = []
    var encounteredStaleTeamIds: Set<String> = []
    var allStale = false

    for entry in allEntries {
      if let teamId = entry.teamId {
        // Look up the wrapped team key.
        guard let wrappedTeamKey = teamKeys.first(where: { $0.teamId == teamId }) else {
          continue  // no key for this team — skip silently
        }
        // Per plan §"Team-key cache invalidation": refuse blobs older than 15 min.
        if now().timeIntervalSince(wrappedTeamKey.issuedAt) > teamKeyMaxAge {
          encounteredStaleTeamIds.insert(teamId)
          continue
        }
        // Unwrap team key using cacheKey (team keys are wrapped under cacheKey, not vault_key).
        guard let teamKey = TeamEntryDecryptor.unwrapTeamKey(wrappedTeamKey, cacheKey: cacheKey, userId: userId) else {
          continue
        }
        // Unwrap ItemKey if itemKeyVersion >= 1.
        guard let entryKey = TeamEntryDecryptor.resolveTeamEntryKey(entry: entry, teamKey: teamKey) else {
          continue
        }
        if let summary = decryptSummary(entry: entry, key: entryKey, userId: userId) {
          summaries.append(summary)
        }
      } else {
        // Personal entry — decrypt with vault_key.
        if let summary = decryptSummary(entry: entry, key: vaultKey, userId: userId) {
          summaries.append(summary)
        }
      }
    }

    // If we have stale team entries but NO other entries, throw teamKeyStale for the first stale team.
    if summaries.isEmpty && !encounteredStaleTeamIds.isEmpty {
      allStale = true
    }

    if allStale, let staleTeamId = encounteredStaleTeamIds.sorted().first {
      throw Error.teamKeyStale(teamId: staleTeamId)
    }

    if summaries.isEmpty && allEntries.isEmpty {
      throw Error.noEntries
    }

    // Extract hosts (URL identifiers → normalized host; bundle IDs → as-is).
    let tabHosts = serviceIdentifiers.compactMap { ident -> String? in
      if ident.isURL {
        return extractHost(ident.identifier)
      } else {
        return ident.identifier  // bundle ID — use as-is for app-side matching
      }
    }

    // Store blob so decryptEntryDetail can reuse it within the same fill without re-prompting.
    currentBlob = blob

    return partitionCandidates(summaries, tabHosts: tabHosts)
  }

  /// Decrypts one entry's full blob (used after the user picks from the list).
  /// Uses the bridge_key retained from the preceding `resolveCandidates` call.
  /// Vault_key is zeroed before this method returns.
  public func decryptEntryDetail(entryId: String) async throws -> VaultEntryDetail {
    // Re-read the Keychain if we don't have a retained blob.
    let blob: BridgeKeyStore.Blob
    if let retained = currentBlob {
      blob = retained
    } else {
      do {
        blob = try await bridgeKeyStore.readForFillAuthenticated(reason: "Fill credential from passwd-sso vault")
      } catch {
        throw Error.vaultLocked
      }
    }
    currentBlob = nil  // consume after one use

    // Derive cacheKey from bridge_key; unwrap user's vault_key from WrappedKeyStore.
    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    guard let wrapped = try? wrappedKeyStore.loadVaultKey() else {
      throw Error.vaultLocked
    }
    guard
      let vaultKeyData = try? decryptAESGCM(
        ciphertext: wrapped.ciphertext,
        iv: wrapped.iv,
        tag: wrapped.authTag,
        key: cacheKey
      )
    else {
      throw Error.vaultLocked
    }
    var mutableVaultKeyData = vaultKeyData
    defer { zeroData(&mutableVaultKeyData) }
    let vaultKey = SymmetricKey(data: vaultKeyData)

    // Re-read and integrity-check the cache using the user's actual vault_key.
    let cacheData: CacheData
    do {
      cacheData = try readCacheFile(
        path: cacheURL,
        vaultKey: vaultKey,
        expectedHostInstallUUID: blob.hostInstallUUID,
        expectedCounter: blob.cacheVersionCounter,
        now: now()
      )
    } catch EntryCacheError.rejection(let kind, let context) {
      await writeRollbackFlag(kind: kind, context: context, blob: blob, vaultKey: vaultKey)
      throw Error.cacheRejected(kind)
    } catch {
      throw Error.cacheUnavailable
    }

    let allEntries: [CacheEntry]
    do {
      allEntries = try JSONDecoder().decode([CacheEntry].self, from: cacheData.entries)
    } catch {
      throw Error.cacheUnavailable
    }

    guard let entry = allEntries.first(where: { $0.id == entryId }) else {
      throw Error.entryNotFound
    }

    let userId = cacheData.header.userId
    let teamKeys = (try? wrappedKeyStore.loadTeamKeys()) ?? []
    let decryptKey: SymmetricKey
    if let teamId = entry.teamId {
      guard let wrappedTeamKey = teamKeys.first(where: { $0.teamId == teamId }) else {
        throw Error.entryNotFound
      }
      // Enforce the same 15-min staleness bound as resolveCandidates: a revoked
      // membership must stop FILLING (not just stop appearing in the list) within
      // the revocation window, even if the stale key still decrypts.
      guard now().timeIntervalSince(wrappedTeamKey.issuedAt) <= teamKeyMaxAge else {
        throw Error.entryNotFound
      }
      // Team keys are wrapped under cacheKey (same as vault_key wrapping).
      guard let teamKey = TeamEntryDecryptor.unwrapTeamKey(wrappedTeamKey, cacheKey: cacheKey, userId: userId) else {
        throw Error.entryNotFound
      }
      guard let entryKey = TeamEntryDecryptor.resolveTeamEntryKey(entry: entry, teamKey: teamKey) else {
        throw Error.entryNotFound
      }
      decryptKey = entryKey
    } else {
      decryptKey = vaultKey
    }

    guard let detail = decryptDetail(entry: entry, key: decryptKey, userId: userId) else {
      throw Error.entryNotFound
    }

    return detail
  }

  /// Decrypts one PERSONAL passkey entry's full blob into assertion material.
  /// Parallels `decryptEntryDetail`: reuses the bridge_key retained from the
  /// preceding `resolveCandidates` (single biometric read), zeroes vault_key
  /// before returning. Throws `entryNotFound` for team entries OR non-passkey
  /// entries (no rpId / no private key in the blob).
  public func decryptPasskeyMaterial(entryId: String) async throws -> PasskeyAssertionMaterial {
    let blob: BridgeKeyStore.Blob
    if let retained = currentBlob {
      blob = retained
    } else {
      do {
        blob = try await bridgeKeyStore.readForFillAuthenticated(reason: "Fill credential from passwd-sso vault")
      } catch {
        throw Error.vaultLocked
      }
    }
    currentBlob = nil  // consume after one use

    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    guard let wrapped = try? wrappedKeyStore.loadVaultKey() else {
      throw Error.vaultLocked
    }
    guard
      let vaultKeyData = try? decryptAESGCM(
        ciphertext: wrapped.ciphertext,
        iv: wrapped.iv,
        tag: wrapped.authTag,
        key: cacheKey
      )
    else {
      throw Error.vaultLocked
    }
    var mutableVaultKeyData = vaultKeyData
    defer { zeroData(&mutableVaultKeyData) }
    let vaultKey = SymmetricKey(data: vaultKeyData)

    let cacheData: CacheData
    do {
      cacheData = try readCacheFile(
        path: cacheURL,
        vaultKey: vaultKey,
        expectedHostInstallUUID: blob.hostInstallUUID,
        expectedCounter: blob.cacheVersionCounter,
        now: now()
      )
    } catch EntryCacheError.rejection(let kind, let context) {
      await writeRollbackFlag(kind: kind, context: context, blob: blob, vaultKey: vaultKey)
      throw Error.cacheRejected(kind)
    } catch {
      throw Error.cacheUnavailable
    }

    let allEntries: [CacheEntry]
    do {
      allEntries = try JSONDecoder().decode([CacheEntry].self, from: cacheData.entries)
    } catch {
      throw Error.cacheUnavailable
    }

    guard let entry = allEntries.first(where: { $0.id == entryId }) else {
      throw Error.entryNotFound
    }
    // Personal entries only (team passkeys out of scope).
    guard entry.teamId == nil else { throw Error.entryNotFound }

    let userId = cacheData.header.userId
    let aad = buildEntryAAD(entry: entry, vaultType: VaultType.blob, userId: userId)
    guard
      let ivData = try? hexDecode(entry.encryptedBlob.iv),
      let cipherData = try? hexDecode(entry.encryptedBlob.ciphertext),
      let tagData = try? hexDecode(entry.encryptedBlob.authTag),
      let plaintext = try? decryptAESGCM(
        ciphertext: cipherData,
        iv: ivData,
        tag: tagData,
        key: vaultKey,
        aad: aad
      ),
      let material = EntryBlobDecoder.passkeyMaterial(plaintext: plaintext, entryId: entry.id)
    else {
      throw Error.entryNotFound
    }
    return material
  }

  // Blob → model decode is shared with the host app via EntryBlobDecoder
  // (ios/Shared/Models/EntryBlobDecoder.swift) — do NOT reintroduce a local copy.

  // MARK: - Passkey registration support (plan C7)

  /// Result of encrypting a freshly-generated PASSKEY entry for upload.
  public struct RegistrationEncryption: Sendable, Equatable {
    public let encryptedBlob: EncryptedData
    public let encryptedOverview: EncryptedData
    public let keyVersion: Int
    public let userId: String

    public init(
      encryptedBlob: EncryptedData,
      encryptedOverview: EncryptedData,
      keyVersion: Int,
      userId: String
    ) {
      self.encryptedBlob = encryptedBlob
      self.encryptedOverview = encryptedOverview
      self.keyVersion = keyVersion
      self.userId = userId
    }
  }

  /// Registration step 1: single biometric bridge_key read, then encrypt the
  /// new PASSKEY full blob + overview under the vault key with personal AAD
  /// (aadVersion 1). keyVersion is recovered from the cache the same way the
  /// host's biometric unlock does (first personal entry, floor 1). Retains the
  /// bridge blob so the post-upload `appendEntryToCache` does not re-prompt.
  /// Vault_key is zeroed before returning.
  public func encryptPasskeyEntry(
    entryId: String,
    blobPlaintext: Data,
    overviewPlaintext: Data
  ) async throws -> RegistrationEncryption {
    currentBlob = nil

    let blob: BridgeKeyStore.Blob
    do {
      blob = try await bridgeKeyStore.readForFillAuthenticated(
        reason: "Save passkey to passwd-sso vault"
      )
    } catch {
      Self.log.error("encryptPasskeyEntry: vaultLocked at bridge_key read: \(String(describing: error), privacy: .public)")
      throw Error.vaultLocked
    }

    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    guard let wrapped = try? wrappedKeyStore.loadVaultKey() else {
      throw Error.vaultLocked
    }
    guard
      let vaultKeyData = try? decryptAESGCM(
        ciphertext: wrapped.ciphertext,
        iv: wrapped.iv,
        tag: wrapped.authTag,
        key: cacheKey
      )
    else {
      throw Error.vaultLocked
    }
    var mutableVaultKeyData = vaultKeyData
    defer { zeroData(&mutableVaultKeyData) }
    let vaultKey = SymmetricKey(data: vaultKeyData)

    // Read the cache for userId + live keyVersion (and to fail early on a
    // rejected/unavailable cache — a vault we cannot append to later).
    let cacheData: CacheData
    do {
      cacheData = try readCacheFile(
        path: cacheURL,
        vaultKey: vaultKey,
        expectedHostInstallUUID: blob.hostInstallUUID,
        expectedCounter: blob.cacheVersionCounter,
        now: now()
      )
    } catch EntryCacheError.rejection(let kind, let context) {
      await writeRollbackFlag(kind: kind, context: context, blob: blob, vaultKey: vaultKey)
      throw Error.cacheRejected(kind)
    } catch {
      throw Error.cacheUnavailable
    }
    let userId = cacheData.header.userId
    guard !userId.isEmpty else { throw Error.cacheUnavailable }

    // Same keyVersion recovery as VaultUnlocker.unlockWithBiometrics.
    let entries = (try? JSONDecoder().decode([CacheEntry].self, from: cacheData.entries)) ?? []
    let keyVersion = max(1, entries.first(where: { $0.teamId == nil })?.keyVersion ?? 1)

    let blobAAD = try buildPersonalEntryAAD(
      userId: userId, entryId: entryId, vaultType: VaultType.blob
    )
    let overviewAAD = try buildPersonalEntryAAD(
      userId: userId, entryId: entryId, vaultType: VaultType.overview
    )
    let encryptedBlob = try encryptAESGCMEncoded(
      plaintext: blobPlaintext, key: vaultKey, aad: blobAAD
    )
    let encryptedOverview = try encryptAESGCMEncoded(
      plaintext: overviewPlaintext, key: vaultKey, aad: overviewAAD
    )

    // Retain for appendEntryToCache (same single-biometric pattern as
    // resolveCandidates → decryptEntryDetail).
    currentBlob = blob

    return RegistrationEncryption(
      encryptedBlob: encryptedBlob,
      encryptedOverview: encryptedOverview,
      keyVersion: keyVersion,
      userId: userId
    )
  }

  /// Registration step 2, AFTER the server confirmed the upload: append the
  /// entry to the local cache at counter N+1 and bump the bridge meta counter
  /// (same write protocol as HostSyncService — file first, counter after).
  /// Best-effort from the ceremony's point of view: the caller must NOT gate
  /// `completeRegistrationRequest` on this (the server copy is durable; a
  /// stale local cache self-heals on the next host sync).
  public func appendEntryToCache(_ entry: CacheEntry) async throws {
    let blob: BridgeKeyStore.Blob
    if let retained = currentBlob {
      blob = retained
    } else {
      do {
        blob = try await bridgeKeyStore.readForFillAuthenticated(
          reason: "Save passkey to passwd-sso vault"
        )
      } catch {
        throw Error.vaultLocked
      }
    }
    currentBlob = nil  // consume after one use

    // Re-read counter/uuid fresh — a concurrent host sync may have advanced
    // them since the retained read.
    let meta = try bridgeKeyStore.readDirect()

    let cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)
    guard let wrapped = try? wrappedKeyStore.loadVaultKey() else {
      throw Error.vaultLocked
    }
    guard
      let vaultKeyData = try? decryptAESGCM(
        ciphertext: wrapped.ciphertext,
        iv: wrapped.iv,
        tag: wrapped.authTag,
        key: cacheKey
      )
    else {
      throw Error.vaultLocked
    }
    var mutableVaultKeyData = vaultKeyData
    defer { zeroData(&mutableVaultKeyData) }
    let vaultKey = SymmetricKey(data: vaultKeyData)

    let cacheData: CacheData
    do {
      cacheData = try readCacheFile(
        path: cacheURL,
        vaultKey: vaultKey,
        expectedHostInstallUUID: meta.hostInstallUUID,
        expectedCounter: meta.cacheVersionCounter,
        now: now()
      )
    } catch EntryCacheError.rejection(let kind, let context) {
      await writeRollbackFlag(kind: kind, context: context, blob: blob, vaultKey: vaultKey)
      throw Error.cacheRejected(kind)
    } catch {
      throw Error.cacheUnavailable
    }

    var entries: [CacheEntry]
    do {
      entries = try JSONDecoder().decode([CacheEntry].self, from: cacheData.entries)
    } catch {
      throw Error.cacheUnavailable
    }
    entries.append(entry)
    let entriesJSON: Data
    do {
      entriesJSON = try JSONEncoder().encode(entries)
    } catch {
      throw Error.cacheUnavailable
    }

    let newCounter = meta.cacheVersionCounter &+ 1
    let header = CacheHeader(
      cacheVersionCounter: newCounter,
      cacheIssuedAt: now(),
      // Not a server refresh — preserve the last successful sync timestamp.
      lastSuccessfulRefreshAt: cacheData.header.lastSuccessfulRefreshAt,
      entryCount: UInt32(entries.count),
      hostInstallUUID: meta.hostInstallUUID,
      userId: cacheData.header.userId
    )
    do {
      try writeCacheFile(
        data: CacheData(header: header, entries: entriesJSON),
        vaultKey: vaultKey,
        hostInstallUUID: meta.hostInstallUUID,
        path: cacheURL
      )
    } catch {
      throw Error.cacheUnavailable
    }
    try bridgeKeyStore.incrementCounter(newCounter: newCounter)
  }

  // MARK: - Private helpers

  private func decryptSummary(
    entry: CacheEntry,
    key: SymmetricKey,
    userId: String
  ) -> VaultEntrySummary? {
    let aad = buildEntryAAD(entry: entry, vaultType: VaultType.overview, userId: userId)
    guard
      let ivData = try? hexDecode(entry.encryptedOverview.iv),
      let cipherData = try? hexDecode(entry.encryptedOverview.ciphertext),
      let tagData = try? hexDecode(entry.encryptedOverview.authTag),
      let plaintext = try? decryptAESGCM(
        ciphertext: cipherData,
        iv: ivData,
        tag: tagData,
        key: key,
        aad: aad
      )
    else {
      return nil
    }
    return EntryBlobDecoder.summary(
      plaintext: plaintext, entryId: entry.id, teamId: entry.teamId, entryType: entry.entryType)
  }

  private func decryptDetail(
    entry: CacheEntry,
    key: SymmetricKey,
    userId: String
  ) -> VaultEntryDetail? {
    let aad = buildEntryAAD(entry: entry, vaultType: VaultType.blob, userId: userId)
    guard
      let ivData = try? hexDecode(entry.encryptedBlob.iv),
      let cipherData = try? hexDecode(entry.encryptedBlob.ciphertext),
      let tagData = try? hexDecode(entry.encryptedBlob.authTag),
      let plaintext = try? decryptAESGCM(
        ciphertext: cipherData,
        iv: ivData,
        tag: tagData,
        key: key,
        aad: aad
      )
    else {
      return nil
    }
    return EntryBlobDecoder.detail(
      plaintext: plaintext, entryId: entry.id, teamId: entry.teamId, entryType: entry.entryType)
  }

  /// Build the AAD for a cache entry at decrypt time.
  /// - Personal: AAD only when aadVersion >= 1.
  /// - Team: AAD always (no aadVersion gate; vaultType distinguishes blob/overview).
  private func buildEntryAAD(
    entry: CacheEntry,
    vaultType: String,
    userId: String
  ) -> Data? {
    if let teamId = entry.teamId {
      return try? buildTeamEntryAAD(
        teamId: teamId,
        entryId: entry.id,
        vaultType: vaultType,
        itemKeyVersion: entry.itemKeyVersion ?? 0
      )
    } else {
      guard entry.aadVersion >= 1 else { return nil }
      return try? buildPersonalEntryAAD(userId: userId, entryId: entry.id, vaultType: vaultType)
    }
  }

  // Team-key unwrap + entry-key resolution moved to the shared `TeamEntryDecryptor`
  // (single source of truth; also used by CredentialIdentityRegistrar + HostSyncService).

  private func writeRollbackFlag(
    kind: CacheRejectionKind,
    context: CacheRejectionContext,
    blob: BridgeKeyStore.Blob,
    vaultKey: SymmetricKey
  ) async {
    guard let writer = rollbackFlagWriter else { return }
    let payload = RollbackFlagPayload(
      expectedCounter: blob.cacheVersionCounter,
      observedCounter: context.observedCounter,
      headerIssuedAt: context.headerIssuedAt,
      lastSuccessfulRefreshAt: context.lastSuccessfulRefreshAt,
      rejectionKind: kind
    )
    try? await writer.writeFlag(payload: payload, vaultKey: vaultKey)
  }

  private func zeroData(_ data: inout Data) {
    _ = data.withUnsafeMutableBytes { ptr in
      ptr.initializeMemory(as: UInt8.self, repeating: 0)
    }
  }
}

// MARK: - Wire model for encrypted cache entries

/// Wire model for entries stored in the App Group cache by HostSyncService.
/// Each entry carries two hex-encoded AES-256-GCM blobs (overview + full),
/// plus the AAD input fields needed to reconstruct the AAD at decrypt time.
public struct CacheEntry: Codable, Sendable {
  public let id: String
  /// nil for personal entries; non-nil for team entries.
  public let teamId: String?
  /// 0 = no AAD; >= 1 = AAD-bound (personal entries only).
  public let aadVersion: Int
  /// Personal entry key version (forward-compat).
  public let keyVersion: Int
  /// Team entries only: teamKey version used when encrypting.
  public let teamKeyVersion: Int?
  /// Team entries only: 0 = teamKey direct, >= 1 = ItemKey wrapped under teamKey.
  public let itemKeyVersion: Int?
  /// Team entries with itemKeyVersion >= 1: wrapped per-entry ItemKey.
  public let encryptedItemKey: EncryptedData?
  public let encryptedBlob: EncryptedData
  public let encryptedOverview: EncryptedData
  /// Server entry type (e.g. "LOGIN", "PASSKEY"). Optional/nil-tolerant: caches
  /// written before this field existed, and all team rows, decode to nil. Used
  /// only as a fast pre-classifier — passkey detection falls back to the
  /// decrypted overview's relyingPartyId, so nil never causes a miss.
  public let entryType: String?
  /// Server favorite flag (non-secret metadata, like `entryType`). Optional/
  /// nil-tolerant: caches written before this field existed, and team rows,
  /// decode to nil → treated as not-favorite.
  public let isFavorite: Bool?

  public init(
    id: String,
    teamId: String? = nil,
    aadVersion: Int = 0,
    keyVersion: Int = 0,
    teamKeyVersion: Int? = nil,
    itemKeyVersion: Int? = nil,
    encryptedItemKey: EncryptedData? = nil,
    encryptedBlob: EncryptedData,
    encryptedOverview: EncryptedData,
    entryType: String? = nil,
    isFavorite: Bool? = nil
  ) {
    self.id = id
    self.teamId = teamId
    self.aadVersion = aadVersion
    self.keyVersion = keyVersion
    self.teamKeyVersion = teamKeyVersion
    self.itemKeyVersion = itemKeyVersion
    self.encryptedItemKey = encryptedItemKey
    self.encryptedBlob = encryptedBlob
    self.encryptedOverview = encryptedOverview
    self.entryType = entryType
    self.isFavorite = isFavorite
  }
}
