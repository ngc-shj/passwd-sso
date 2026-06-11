import AuthenticationServices
import CryptoKit
import Foundation

// MARK: - Personal overview decryption (for registration)

/// Decrypt the overview summaries of PERSONAL entries from a cache, using the
/// user's vault_key. Mirrors the host VaultViewModel's personal-overview decrypt
/// (same AAD rules + EntryBlobDecoder). Team entries (which need team keys) are
/// skipped — QuickType registration covers the personal set the host decrypts.
/// Used to feed `CredentialIdentityRegistrar.replace` after each sync.
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

// MARK: - Store seam (DI for tests)

/// Thin seam over `ASCredentialIdentityStore` so the registration/clear wiring
/// is unit-testable with a fake (matching the BridgeKeyStore/Clock DI pattern).
public protocol CredentialIdentityStoring: Sendable {
  func isEnabled() async -> Bool
  func replace(with specs: [CredentialIdentitySpec]) async
  func removeAll() async
}

/// Production store: forwards to `ASCredentialIdentityStore.shared`. Builds the
/// `ASPasswordCredentialIdentity` objects from the Sendable specs internally so
/// no non-Sendable AuthenticationServices type crosses an actor boundary.
public struct SystemCredentialIdentityStore: CredentialIdentityStoring {
  public init() {}

  public func isEnabled() async -> Bool {
    await withCheckedContinuation { continuation in
      ASCredentialIdentityStore.shared.getState { state in
        continuation.resume(returning: state.isEnabled)
      }
    }
  }

  public func replace(with specs: [CredentialIdentitySpec]) async {
    let identities = specs.map { spec in
      ASPasswordCredentialIdentity(
        serviceIdentifier: ASCredentialServiceIdentifier(identifier: spec.host, type: .domain),
        user: spec.user,
        recordIdentifier: spec.recordIdentifier
      )
    }
    try? await ASCredentialIdentityStore.shared.replaceCredentialIdentities(identities)
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

  /// Replace the registered identity set with the given summaries' specs.
  /// No-op when the AutoFill provider is disabled in Settings.
  public func replace(with summaries: [VaultEntrySummary]) async {
    guard await store.isEnabled() else { return }
    await store.replace(with: Self.specs(from: summaries))
  }

  /// Remove all registered identities (always runs; removeAll is a no-op when
  /// the provider is disabled).
  public func clear() async {
    await store.removeAll()
  }
}
