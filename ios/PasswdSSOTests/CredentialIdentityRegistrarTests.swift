import CryptoKit
import Foundation
import XCTest

@testable import Shared

/// Tests for the pure `CredentialIdentityRegistrar.specs(from:)` mapper and the
/// store-seam wiring (replace-when-enabled / no-op-when-disabled / clear).
final class CredentialIdentityRegistrarTests: XCTestCase {

  private func summary(
    _ id: String,
    urlHost: String,
    additional: [String] = [],
    username: String = "user"
  ) -> VaultEntrySummary {
    VaultEntrySummary(
      id: id, title: "T", username: username, urlHost: urlHost, additionalUrlHosts: additional
    )
  }

  // MARK: - Pure mapper (8 cases)

  func testSpecs_hostOnlyProducesOneSpecWithCorrectFields() {
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "amazon.co.jp", username: "alice")
    ])
    XCTAssertEqual(specs, [
      CredentialIdentitySpec(host: "amazon.co.jp", user: "alice", recordIdentifier: "e1")
    ])
  }

  func testSpecs_bothEmptyExcluded() {
    let specs = CredentialIdentityRegistrar.specs(from: [summary("e1", urlHost: "", additional: [])])
    XCTAssertTrue(specs.isEmpty)
  }

  func testSpecs_emptyUrlHostButAdditionalHostIncluded() {
    // Skip rule is "both empty", NOT "urlHost empty".
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "", additional: ["a.com"])
    ])
    XCTAssertEqual(specs.map(\.host), ["a.com"])
    XCTAssertEqual(specs.map(\.recordIdentifier), ["e1"])
  }

  func testSpecs_additionalHostsFanOutSameRecordIdentifier() {
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "a.com", additional: ["b.com", "c.com"], username: "u")
    ])
    XCTAssertEqual(specs.map(\.host), ["a.com", "b.com", "c.com"])
    XCTAssertEqual(Set(specs.map(\.recordIdentifier)), ["e1"])
    XCTAssertEqual(Set(specs.map(\.user)), ["u"])
  }

  func testSpecs_emptyStringInsideAdditionalDropped() {
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "a.com", additional: ["b.com", "", "  "])
    ])
    XCTAssertEqual(specs.map(\.host), ["a.com", "b.com"])
    XCTAssertFalse(specs.contains { $0.host.isEmpty })
  }

  func testSpecs_emptyUsernameStillProducesSpec() {
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "a.com", username: "")
    ])
    XCTAssertEqual(specs, [CredentialIdentitySpec(host: "a.com", user: "", recordIdentifier: "e1")])
  }

  func testSpecs_multipleSummariesFlatMapWithCorrectIds() {
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "a.com"),
      summary("e2", urlHost: "b.com"),
    ])
    XCTAssertEqual(specs.count, 2)
    XCTAssertEqual(specs.first { $0.host == "a.com" }?.recordIdentifier, "e1")
    XCTAssertEqual(specs.first { $0.host == "b.com" }?.recordIdentifier, "e2")
  }

  func testSpecs_emptyInputReturnsEmpty() {
    XCTAssertTrue(CredentialIdentityRegistrar.specs(from: []).isEmpty)
  }

  func testSpecs_dedupesIdenticalHostUserPairs() {
    // urlHost also present in additionalUrlHosts → only one spec.
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "a.com", additional: ["a.com"], username: "u")
    ])
    XCTAssertEqual(specs, [CredentialIdentitySpec(host: "a.com", user: "u", recordIdentifier: "e1")])
  }

  // MARK: - Registrar wiring (fake store)

  func testReplace_whenEnabled_storesMappedSpecs() async {
    let store = FakeIdentityStore(enabled: true)
    let registrar = CredentialIdentityRegistrar(store: store)
    await registrar.replace(with: [summary("e1", urlHost: "a.com", username: "u")])

    let replaced = await store.replacedPasswordSpecs
    XCTAssertEqual(replaced, [CredentialIdentitySpec(host: "a.com", user: "u", recordIdentifier: "e1")])
  }

  func testReplace_passwordOnly_leavesNoStalePasskeyIdentities() async {
    // Back-compat wrapper must pass an EMPTY passkeys array (one atomic replace
    // clears any previously-registered passkey identities).
    let store = FakeIdentityStore(enabled: true)
    let registrar = CredentialIdentityRegistrar(store: store)
    await registrar.replace(with: [summary("e1", urlHost: "a.com", username: "u")])

    let passwords = await store.replacedPasswordSpecs
    let passkeys = await store.replacedPasskeySpecs
    XCTAssertEqual(passwords?.count, 1)
    XCTAssertEqual(passkeys, [], "password-only replace must clear passkey identities")
  }

  func testReplace_withPasskeys_registersBothKinds() async {
    let store = FakeIdentityStore(enabled: true)
    let registrar = CredentialIdentityRegistrar(store: store)
    let spec = PasskeyIdentitySpec(
      relyingPartyIdentifier: "webauthn.io", userName: "alice",
      credentialID: Data([1, 2, 3, 4]), userHandle: Data([5, 6, 7, 8]),
      recordIdentifier: "pk1"
    )
    await registrar.replace(
      with: [summary("e1", urlHost: "a.com", username: "u")], passkeys: [spec]
    )

    let passwords = await store.replacedPasswordSpecs
    let passkeys = await store.replacedPasskeySpecs
    XCTAssertEqual(passwords?.count, 1)
    XCTAssertEqual(passkeys, [spec])
  }

  func testReplace_whenDisabled_isNoOp() async {
    let store = FakeIdentityStore(enabled: false)
    let registrar = CredentialIdentityRegistrar(store: store)
    await registrar.replace(with: [summary("e1", urlHost: "a.com")])

    let count = await store.replaceCount
    XCTAssertEqual(count, 0, "replace must not be called when the provider is disabled")
  }

  func testClear_callsRemoveAll() async {
    let store = FakeIdentityStore(enabled: true)
    let registrar = CredentialIdentityRegistrar(store: store)
    await registrar.clear()

    let count = await store.removeAllCount
    XCTAssertEqual(count, 1)
  }

  // MARK: - decryptPersonalOverviews

  func testDecryptPersonalOverviews_returnsPersonalSummaries() throws {
    let vaultKey = SymmetricKey(size: .bits256)
    let userId = "user-1"
    let entries = [
      try personalEntry(id: "p0", urlHost: "amazon.co.jp", username: "a", userId: userId,
                        aadVersion: 0, vaultKey: vaultKey),
      try personalEntry(id: "p1", urlHost: "github.com", username: "g", userId: userId,
                        aadVersion: 1, vaultKey: vaultKey),
    ]
    let cache = try makeCache(entries, userId: userId)

    let summaries = decryptPersonalOverviews(from: cache, vaultKey: vaultKey, userId: userId)

    XCTAssertEqual(Set(summaries.map(\.id)), ["p0", "p1"])
    XCTAssertEqual(summaries.first { $0.id == "p1" }?.urlHost, "github.com")
    XCTAssertEqual(summaries.first { $0.id == "p1" }?.username, "g")
  }

  func testDecryptPersonalOverviews_excludesTeamEntries() throws {
    let vaultKey = SymmetricKey(size: .bits256)
    let userId = "user-1"
    let personal = try personalEntry(id: "p0", urlHost: "amazon.co.jp", username: "a",
                                     userId: userId, aadVersion: 1, vaultKey: vaultKey)
    // A team entry is skipped before decrypt (teamId != nil); its blobs are dummy.
    let dummy = try encryptAESGCMEncoded(plaintext: Data("{}".utf8), key: vaultKey, aad: nil)
    let team = CacheEntry(id: "t0", teamId: "team-1", aadVersion: 0,
                          encryptedBlob: dummy, encryptedOverview: dummy)
    let cache = try makeCache([personal, team], userId: userId)

    let summaries = decryptPersonalOverviews(from: cache, vaultKey: vaultKey, userId: userId)

    XCTAssertEqual(summaries.map(\.id), ["p0"], "team entries must be excluded")
  }

  func testDecryptPersonalOverviews_wrongUserIdExcluded() throws {
    let vaultKey = SymmetricKey(size: .bits256)
    // aadVersion>=1 entry bound to userId "A"; decrypting with "B" → AAD mismatch → skipped.
    let entry = try personalEntry(id: "p0", urlHost: "a.com", username: "u", userId: "A",
                                  aadVersion: 1, vaultKey: vaultKey)
    let cache = try makeCache([entry], userId: "B")

    let summaries = decryptPersonalOverviews(from: cache, vaultKey: vaultKey, userId: "B")

    XCTAssertTrue(summaries.isEmpty, "AAD-bound entry must not decrypt under the wrong userId")
  }

  // MARK: - buildPasskeyIdentitySpecs

  func testBuildPasskeyIdentitySpecs_buildsSpecFromPasskeyEntry() throws {
    let vaultKey = SymmetricKey(size: .bits256)
    let userId = "user-1"
    let credentialID = Data([1, 2, 3, 4])
    let userHandle = Data([9, 8, 7, 6])
    let entry = try passkeyEntry(
      id: "pk1", rpId: "webauthn.io", username: "alice",
      credentialID: credentialID, userHandle: userHandle,
      userId: userId, vaultKey: vaultKey
    )
    let cache = try makeCache([entry], userId: userId)

    let specs = buildPasskeyIdentitySpecs(from: cache, vaultKey: vaultKey, userId: userId)

    XCTAssertEqual(specs, [
      PasskeyIdentitySpec(
        relyingPartyIdentifier: "webauthn.io", userName: "alice",
        credentialID: credentialID, userHandle: userHandle, recordIdentifier: "pk1"
      )
    ])
  }

  func testBuildPasskeyIdentitySpecs_skipsEmptyUserHandle() throws {
    let vaultKey = SymmetricKey(size: .bits256)
    let userId = "user-1"
    let entry = try passkeyEntry(
      id: "pk1", rpId: "webauthn.io", username: "alice",
      credentialID: Data([1, 2, 3, 4]), userHandle: Data(),  // empty → skip
      userId: userId, vaultKey: vaultKey
    )
    let cache = try makeCache([entry], userId: userId)

    let specs = buildPasskeyIdentitySpecs(from: cache, vaultKey: vaultKey, userId: userId)

    XCTAssertTrue(specs.isEmpty, "empty userHandle must be skipped (ASPasskeyCredentialIdentity requires it)")
  }

  func testBuildPasskeyIdentitySpecs_skipsEmptyCredentialId() throws {
    let vaultKey = SymmetricKey(size: .bits256)
    let userId = "user-1"
    let entry = try passkeyEntry(
      id: "pk1", rpId: "webauthn.io", username: "alice",
      credentialID: Data(), userHandle: Data([5, 6, 7, 8]),  // empty credentialID → skip
      userId: userId, vaultKey: vaultKey
    )
    let cache = try makeCache([entry], userId: userId)

    let specs = buildPasskeyIdentitySpecs(from: cache, vaultKey: vaultKey, userId: userId)

    XCTAssertTrue(specs.isEmpty, "empty credentialID must be skipped")
  }

  func testBuildPasskeyIdentitySpecs_ignoresLoginEntries() throws {
    let vaultKey = SymmetricKey(size: .bits256)
    let userId = "user-1"
    let login = try personalEntry(id: "p0", urlHost: "a.com", username: "u",
                                  userId: userId, aadVersion: 1, vaultKey: vaultKey)
    let cache = try makeCache([login], userId: userId)

    let specs = buildPasskeyIdentitySpecs(from: cache, vaultKey: vaultKey, userId: userId)

    XCTAssertTrue(specs.isEmpty, "LOGIN entries (no relyingPartyId) are not passkeys")
  }

  // MARK: - Cache fixtures

  private struct TestOverviewBlob: Encodable {
    let title: String
    let username: String?
    let urlHost: String?
  }

  private struct TestPasskeyOverviewBlob: Encodable {
    let title: String
    let username: String?
    let relyingPartyId: String
    let credentialId: String
  }

  private struct TestPasskeyFullBlob: Encodable {
    let title: String
    let username: String?
    let relyingPartyId: String
    let credentialId: String
    let passkeyPrivateKeyJwk: String  // double-encoded JWK string (content irrelevant here)
    let passkeyUserHandle: String
  }

  // MARK: - refreshCredentialIdentities (shared one-step helper)

  /// End-to-end through the shared helper: cache -> overview/passkey decrypt ->
  /// registrar.replace, with the store injected so the call is observable.
  func testRefreshCredentialIdentities_replacesPasswordsAndPasskeysFromCache() async throws {
    let vaultKey = SymmetricKey(size: .bits256)
    let userId = "u-refresh"
    let login = try personalEntry(
      id: "e1", urlHost: "acme.com", username: "alice", userId: userId,
      aadVersion: 1, vaultKey: vaultKey
    )
    let passkey = try passkeyEntry(
      id: "pk1", rpId: "github.com", username: "bob",
      credentialID: Data([1, 2]), userHandle: Data([3, 4]),
      userId: userId, vaultKey: vaultKey
    )
    let cache = try makeCache([login, passkey], userId: userId)
    let store = FakeIdentityStore(enabled: true)
    let registrar = CredentialIdentityRegistrar(store: store)

    await refreshCredentialIdentities(
      from: cache, vaultKey: vaultKey, userId: userId, registrar: registrar
    )

    let passwords = await store.replacedPasswordSpecs
    let passkeys = await store.replacedPasskeySpecs
    XCTAssertEqual(passwords?.map(\.host), ["acme.com"])
    XCTAssertEqual(passwords?.first?.user, "alice")
    XCTAssertEqual(passkeys?.map(\.relyingPartyIdentifier), ["github.com"])
    XCTAssertEqual(passkeys?.first?.recordIdentifier, "pk1")
  }

  func testAddPasskeysAppendsWhenEnabled() async {
    let store = FakeIdentityStore(enabled: true)
    let registrar = CredentialIdentityRegistrar(store: store)
    let spec = PasskeyIdentitySpec(
      relyingPartyIdentifier: "webauthn.io", userName: "alice",
      credentialID: Data([1]), userHandle: Data([2]), recordIdentifier: "e1"
    )

    await registrar.add(passkeys: [spec])

    let added = await store.addedPasskeySpecs
    XCTAssertEqual(added, [spec])
    let replaceCount = await store.replaceCount
    XCTAssertEqual(replaceCount, 0, "add must append, never wipe the existing set")
  }

  func testAddPasskeysIsNoOpWhenProviderDisabled() async {
    let store = FakeIdentityStore(enabled: false)
    let registrar = CredentialIdentityRegistrar(store: store)
    let spec = PasskeyIdentitySpec(
      relyingPartyIdentifier: "webauthn.io", userName: "alice",
      credentialID: Data([1]), userHandle: Data([2]), recordIdentifier: "e1"
    )

    await registrar.add(passkeys: [spec])

    let added = await store.addedPasskeySpecs
    XCTAssertTrue(added.isEmpty)
  }

  private func passkeyEntry(
    id: String, rpId: String, username: String,
    credentialID: Data, userHandle: Data,
    userId: String, vaultKey: SymmetricKey
  ) throws -> CacheEntry {
    let credIdB64 = base64URLEncode(credentialID)
    let userHandleB64 = base64URLEncode(userHandle)
    let overviewData = try JSONEncoder().encode(
      TestPasskeyOverviewBlob(
        title: "T", username: username, relyingPartyId: rpId, credentialId: credIdB64
      )
    )
    let fullData = try JSONEncoder().encode(
      TestPasskeyFullBlob(
        title: "T", username: username, relyingPartyId: rpId, credentialId: credIdB64,
        passkeyPrivateKeyJwk: "{\"kty\":\"EC\",\"crv\":\"P-256\",\"d\":\"x\"}",
        passkeyUserHandle: userHandleB64
      )
    )
    let overviewAAD = try buildPersonalEntryAAD(userId: userId, entryId: id, vaultType: VaultType.overview)
    let blobAAD = try buildPersonalEntryAAD(userId: userId, entryId: id, vaultType: VaultType.blob)
    let overview = try encryptAESGCMEncoded(plaintext: overviewData, key: vaultKey, aad: overviewAAD)
    let blob = try encryptAESGCMEncoded(plaintext: fullData, key: vaultKey, aad: blobAAD)
    return CacheEntry(
      id: id, teamId: nil, aadVersion: 1,
      encryptedBlob: blob, encryptedOverview: overview, entryType: "PASSKEY"
    )
  }

  private func personalEntry(
    id: String, urlHost: String, username: String, userId: String,
    aadVersion: Int, vaultKey: SymmetricKey
  ) throws -> CacheEntry {
    let plaintext = try JSONEncoder().encode(
      TestOverviewBlob(title: "T", username: username, urlHost: urlHost)
    )
    let aad: Data? = aadVersion >= 1
      ? try buildPersonalEntryAAD(userId: userId, entryId: id, vaultType: VaultType.overview)
      : nil
    let overview = try encryptAESGCMEncoded(plaintext: plaintext, key: vaultKey, aad: aad)
    let dummyBlob = try encryptAESGCMEncoded(plaintext: Data("{}".utf8), key: vaultKey, aad: nil)
    return CacheEntry(
      id: id, teamId: nil, aadVersion: aadVersion,
      encryptedBlob: dummyBlob, encryptedOverview: overview
    )
  }

  private func makeCache(_ entries: [CacheEntry], userId: String) throws -> CacheData {
    let header = CacheHeader(
      cacheVersionCounter: 1, cacheIssuedAt: Date(), lastSuccessfulRefreshAt: Date(),
      entryCount: UInt32(entries.count), hostInstallUUID: Data(repeating: 0, count: 16),
      userId: userId
    )
    return CacheData(header: header, entries: try JSONEncoder().encode(entries))
  }
}

/// In-memory fake for CredentialIdentityStoring (actor → Sendable, no real
/// ASCredentialIdentityStore which is entitlement/device-dependent).
private actor FakeIdentityStore: CredentialIdentityStoring {
  private let enabled: Bool
  private(set) var replacedPasswordSpecs: [CredentialIdentitySpec]?
  private(set) var replacedPasskeySpecs: [PasskeyIdentitySpec]?
  private(set) var addedPasskeySpecs: [PasskeyIdentitySpec] = []
  private(set) var replaceCount = 0
  private(set) var removeAllCount = 0

  init(enabled: Bool) { self.enabled = enabled }

  func isEnabled() async -> Bool { enabled }
  func replace(passwords: [CredentialIdentitySpec], passkeys: [PasskeyIdentitySpec]) async {
    replacedPasswordSpecs = passwords
    replacedPasskeySpecs = passkeys
    replaceCount += 1
  }
  func add(passkeys: [PasskeyIdentitySpec]) async {
    addedPasskeySpecs.append(contentsOf: passkeys)
  }
  func removeAll() async { removeAllCount += 1 }
}
