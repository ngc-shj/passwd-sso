import AuthenticationServices
import CryptoKit
import Foundation
import OSLog

// Diagnostic only — traces the QuickType passkey registration lifecycle
// (detection counts + register/clear timing) so a "passkey not offered in the
// system sheet" symptom is debuggable in Console.app. No secrets logged.
private let identityLog = Logger(subsystem: "jp.jpng.passwd-sso", category: "autofill")

// MARK: - Personal overview decryption (for registration)

/// Decrypt the overview summaries of PERSONAL entries from a cache, using the
/// user's vault_key. Team entries (which need team keys) are skipped — QuickType
/// registration covers the personal set the host decrypts. Used to feed
/// `CredentialIdentityRegistrar.replace` after each sync.
///
/// NOTE: the AAD rules here (aadVersion >= 1 → buildPersonalEntryAAD, else nil)
/// MUST stay in sync with `VaultViewModel.decryptOverview` — if the server bumps
/// the AAD shape, update BOTH or QuickType silently stops decrypting (empty
/// suggestion set).
public func decryptPersonalOverviews(
  from cacheData: CacheData,
  vaultKey: SymmetricKey,
  userId: String
) -> [VaultEntrySummary] {
  guard let entries = try? JSONDecoder().decode([CacheEntry].self, from: cacheData.entries) else {
    return []
  }
  var result: [VaultEntrySummary] = []
  for entry in entries where entry.teamId == nil {
    let aad: Data? = entry.aadVersion >= 1
      ? (try? buildPersonalEntryAAD(userId: userId, entryId: entry.id, vaultType: VaultType.overview))
      : nil
    guard
      let plaintext = try? decryptAESGCMEncoded(
        encrypted: entry.encryptedOverview, key: vaultKey, aad: aad
      ),
      let summary = EntryBlobDecoder.summary(plaintext: plaintext, entryId: entry.id, teamId: nil)
    else { continue }
    result.append(summary)
  }
  return result
}

/// Build QuickType passkey identity specs from PERSONAL passkey entries. Mirrors
/// `decryptPersonalOverviews`' signature/timing so the two call sites can invoke
/// both from the same place (post-sync, vaultKey in scope). For each personal
/// passkey (overview `relyingPartyId != nil`), additionally decrypt the FULL blob
/// to recover the userHandle (which lives only in the full blob). Entries whose
/// credentialId fails to decode OR whose userHandle is empty are skipped —
/// `ASPasskeyCredentialIdentity` requires a non-empty userHandle.
public func buildPasskeyIdentitySpecs(
  from cacheData: CacheData,
  vaultKey: SymmetricKey,
  userId: String
) -> [PasskeyIdentitySpec] {
  guard let entries = try? JSONDecoder().decode([CacheEntry].self, from: cacheData.entries) else {
    return []
  }
  var result: [PasskeyIdentitySpec] = []
  for entry in entries where entry.teamId == nil {
    let overviewAAD: Data? = entry.aadVersion >= 1
      ? (try? buildPersonalEntryAAD(userId: userId, entryId: entry.id, vaultType: VaultType.overview))
      : nil
    guard
      let overviewPlain = try? decryptAESGCMEncoded(
        encrypted: entry.encryptedOverview, key: vaultKey, aad: overviewAAD
      ),
      let summary = EntryBlobDecoder.summary(plaintext: overviewPlain, entryId: entry.id, teamId: nil),
      let rpId = summary.relyingPartyId,
      let credentialIdStr = summary.credentialId
    else { continue }
    let blobAAD: Data? = entry.aadVersion >= 1
      ? (try? buildPersonalEntryAAD(userId: userId, entryId: entry.id, vaultType: VaultType.blob))
      : nil
    guard
      let blobPlain = try? decryptAESGCMEncoded(
        encrypted: entry.encryptedBlob, key: vaultKey, aad: blobAAD
      ),
      let material = EntryBlobDecoder.passkeyMaterial(plaintext: blobPlain, entryId: entry.id),
      let credentialID = try? base64URLDecode(credentialIdStr), !credentialID.isEmpty,
      let userHandle = try? base64URLDecode(material.userHandle), !userHandle.isEmpty
    else {
      identityLog.error("buildPasskeyIdentitySpecs: passkey candidate (rpId=\(rpId, privacy: .public)) dropped — blob material/credentialID/userHandle decode failed")
      continue
    }
    result.append(
      PasskeyIdentitySpec(
        relyingPartyIdentifier: rpId,
        userName: summary.username,
        credentialID: credentialID,
        userHandle: userHandle,
        recordIdentifier: entry.id
      )
    )
  }
  return result
}

// MARK: - One-step refresh

/// Decrypt personal summaries + passkey specs from a fresh cache and replace
/// the OS credential-identity store in one step. Single entry point for every
/// refresh site (foreground sync, vault unlock, entry create/save) so the
/// summaries/passkeys/replace sequence cannot drift between call sites.
public func refreshCredentialIdentities(
  from cacheData: CacheData,
  vaultKey: SymmetricKey,
  userId: String,
  registrar: CredentialIdentityRegistrar = CredentialIdentityRegistrar()
) async {
  let summaries = decryptPersonalOverviews(from: cacheData, vaultKey: vaultKey, userId: userId)
  let passkeys = buildPasskeyIdentitySpecs(from: cacheData, vaultKey: vaultKey, userId: userId)
  await registrar.replace(with: summaries, passkeys: passkeys)
}

// MARK: - Sendable identity spec

/// Sendable description of one QuickType credential identity: the site host,
/// the username, and the vault entry id (recordIdentifier). Contains NO
/// password or secret — only metadata the OS needs to render an inline
/// suggestion. The actual fill (after the user taps a suggestion) still goes
/// through the AutoFill extension's biometric-gated decrypt by recordIdentifier.
public struct CredentialIdentitySpec: Sendable, Equatable {
  public let host: String
  public let user: String
  public let recordIdentifier: String

  public init(host: String, user: String, recordIdentifier: String) {
    self.host = host
    self.user = user
    self.recordIdentifier = recordIdentifier
  }
}

/// Sendable description of one QuickType PASSKEY identity. Carries the raw
/// (base64url-decoded) credentialID + userHandle bytes the OS needs to render
/// the passkey in the system passkey sheet. No private key here — the actual
/// assertion (after the user picks) goes through the extension's biometric-gated
/// decrypt by recordIdentifier.
public struct PasskeyIdentitySpec: Sendable, Equatable {
  public let relyingPartyIdentifier: String
  public let userName: String
  public let credentialID: Data
  public let userHandle: Data
  public let recordIdentifier: String

  public init(
    relyingPartyIdentifier: String,
    userName: String,
    credentialID: Data,
    userHandle: Data,
    recordIdentifier: String
  ) {
    self.relyingPartyIdentifier = relyingPartyIdentifier
    self.userName = userName
    self.credentialID = credentialID
    self.userHandle = userHandle
    self.recordIdentifier = recordIdentifier
  }
}

// MARK: - Store seam (DI for tests)

/// Thin seam over `ASCredentialIdentityStore` so the registration/clear wiring
/// is unit-testable with a fake (matching the BridgeKeyStore/Clock DI pattern).
public protocol CredentialIdentityStoring: Sendable {
  func isEnabled() async -> Bool
  /// Atomically replace the WHOLE identity set (passwords + passkeys) in one
  /// call, so a password-only refresh with `passkeys: []` also clears stale
  /// passkey identities (lifecycle parity).
  func replace(passwords: [CredentialIdentitySpec], passkeys: [PasskeyIdentitySpec]) async
  /// APPEND passkey identities without touching the existing set — used by the
  /// extension right after a passkey registration (it has no full entry set to
  /// replace with).
  func add(passkeys: [PasskeyIdentitySpec]) async
  func removeAll() async
}

extension CredentialIdentityStoring {
  /// Back-compat password-only wrapper for callers/tests that don't deal in passkeys.
  public func replace(with passwords: [CredentialIdentitySpec]) async {
    await replace(passwords: passwords, passkeys: [])
  }
}

/// Production store: forwards to `ASCredentialIdentityStore.shared`. Builds the
/// `ASPasswordCredentialIdentity` / `ASPasskeyCredentialIdentity` objects from
/// the Sendable specs internally so no non-Sendable AuthenticationServices type
/// crosses an actor boundary.
public struct SystemCredentialIdentityStore: CredentialIdentityStoring {
  public init() {}

  public func isEnabled() async -> Bool {
    await withCheckedContinuation { continuation in
      ASCredentialIdentityStore.shared.getState { state in
        continuation.resume(returning: state.isEnabled)
      }
    }
  }

  public func replace(
    passwords: [CredentialIdentitySpec],
    passkeys: [PasskeyIdentitySpec]
  ) async {
    var identities: [any ASCredentialIdentity] = passwords.map { spec in
      ASPasswordCredentialIdentity(
        serviceIdentifier: ASCredentialServiceIdentifier(identifier: spec.host, type: .domain),
        user: spec.user,
        recordIdentifier: spec.recordIdentifier
      )
    }
    for spec in passkeys {
      identities.append(
        ASPasskeyCredentialIdentity(
          relyingPartyIdentifier: spec.relyingPartyIdentifier,
          userName: spec.userName,
          credentialID: spec.credentialID,
          userHandle: spec.userHandle,
          recordIdentifier: spec.recordIdentifier
        )
      )
    }
    // iOS 17+ heterogeneous-array API (ObjC `replaceCredentialIdentityEntries:`,
    // Swift name `replaceCredentialIdentities(_:)`) — one atomic replace of both kinds.
    try? await ASCredentialIdentityStore.shared.replaceCredentialIdentities(identities)
  }

  public func add(passkeys: [PasskeyIdentitySpec]) async {
    let identities: [any ASCredentialIdentity] = passkeys.map { spec in
      ASPasskeyCredentialIdentity(
        relyingPartyIdentifier: spec.relyingPartyIdentifier,
        userName: spec.userName,
        credentialID: spec.credentialID,
        userHandle: spec.userHandle,
        recordIdentifier: spec.recordIdentifier
      )
    }
    // saveCredentialIdentities APPENDS to the store (replace* is the
    // wipe-and-set variant).
    try? await ASCredentialIdentityStore.shared.saveCredentialIdentities(identities)
  }

  public func removeAll() async {
    try? await ASCredentialIdentityStore.shared.removeAllCredentialIdentities()
  }
}

// MARK: - Registrar

/// Registers vault entry summaries as QuickType credential identities so they
/// appear inline in the keyboard suggestion bar. Identities exist ONLY while
/// the vault is unlocked: registered after each sync, cleared on lock / logout /
/// background / app launch.
public struct CredentialIdentityRegistrar: Sendable {
  private let store: any CredentialIdentityStoring

  public init(store: any CredentialIdentityStoring = SystemCredentialIdentityStore()) {
    self.store = store
  }

  /// Pure mapping: host-bearing summaries → deduped identity specs. A summary is
  /// skipped only when its `urlHost` AND every `additionalUrlHosts` entry are
  /// empty; each non-empty host yields one spec (deduped on host+user) pointing
  /// at the same entry id. No password ever appears here.
  public static func specs(from summaries: [VaultEntrySummary]) -> [CredentialIdentitySpec] {
    var result: [CredentialIdentitySpec] = []
    var seen: Set<String> = []
    for summary in summaries {
      let hosts = ([summary.urlHost] + summary.additionalUrlHosts)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
      for host in hosts {
        let key = "\(host)\u{01}\(summary.username)"
        if seen.insert(key).inserted {
          result.append(
            CredentialIdentitySpec(
              host: host,
              user: summary.username,
              recordIdentifier: summary.id
            )
          )
        }
      }
    }
    return result
  }

  /// Replace the registered identity set with the given summaries' password specs
  /// plus the supplied passkey specs (one atomic replace covering both kinds).
  /// No-op when the AutoFill provider is disabled in Settings.
  public func replace(
    with summaries: [VaultEntrySummary],
    passkeys: [PasskeyIdentitySpec] = []
  ) async {
    guard await store.isEnabled() else {
      identityLog.error("replace: AutoFill provider DISABLED in Settings — nothing registered")
      return
    }
    await store.replace(passwords: Self.specs(from: summaries), passkeys: passkeys)
  }

  /// Append passkey identities to the registered set (post-registration).
  /// No-op when the AutoFill provider is disabled in Settings.
  public func add(passkeys: [PasskeyIdentitySpec]) async {
    guard await store.isEnabled() else {
      identityLog.error("add: AutoFill provider DISABLED in Settings — nothing registered")
      return
    }
    await store.add(passkeys: passkeys)
  }

  /// Remove all registered identities (always runs; removeAll is a no-op when
  /// the provider is disabled).
  public func clear() async {
    await store.removeAll()
  }
}
