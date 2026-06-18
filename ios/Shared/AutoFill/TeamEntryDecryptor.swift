import CryptoKit
import Foundation

/// Shared team-entry decrypt logic used by BOTH `CredentialResolver` (AutoFill
/// fill path) and `CredentialIdentityRegistrar` (QuickType registration), and the
/// host-side wrap path in `HostSyncService`. Single source of truth for the
/// on-device cacheKey wrap/unwrap of team keys and the ECDH private key, so the
/// `buildLocalWrapAAD` binding is constructed identically on write and read.
public enum TeamEntryDecryptor {
  /// Reject wrapped team keys older than this (revocation bound). Matches the
  /// `CredentialResolver` default.
  public static let teamKeyMaxAge: TimeInterval = 15 * 60

  // MARK: - ECDH private key wrap/unwrap (cacheKey, AAD kind:"ecdh")

  public static func wrapEcdhPrivateKey(
    pkcs8: Data, cacheKey: SymmetricKey, userId: String, issuedAt: Date
  ) throws -> WrappedECDHPrivateKey {
    let aad = try buildLocalWrapAAD(kind: "ecdh", userId: userId)
    let (ct, iv, tag) = try encryptAESGCM(plaintext: pkcs8, key: cacheKey, aad: aad)
    return WrappedECDHPrivateKey(ciphertext: ct, iv: iv, authTag: tag, issuedAt: issuedAt)
  }

  /// Returns the PKCS#8 bytes; caller is responsible for zeroizing them.
  public static func unwrapEcdhPrivateKey(
    _ wrapped: WrappedECDHPrivateKey, cacheKey: SymmetricKey, userId: String
  ) -> Data? {
    guard let aad = try? buildLocalWrapAAD(kind: "ecdh", userId: userId) else { return nil }
    return try? decryptAESGCM(
      ciphertext: wrapped.ciphertext, iv: wrapped.iv, tag: wrapped.authTag, key: cacheKey, aad: aad)
  }

  // MARK: - Team key wrap/unwrap (cacheKey, AAD kind:"team")

  /// Host (sync) side: wrap the DERIVED team encryption key under cacheKey.
  public static func wrapTeamKey(
    teamEncKey: SymmetricKey, cacheKey: SymmetricKey, userId: String,
    teamId: String, teamKeyVersion: Int, issuedAt: Date
  ) throws -> WrappedTeamKey {
    let aad = try buildLocalWrapAAD(kind: "team", userId: userId, teamId: teamId)
    var keyBytes = teamEncKey.withUnsafeBytes { Data($0) }
    defer { keyBytes.resetBytes(in: 0..<keyBytes.count) }
    let (ct, iv, tag) = try encryptAESGCM(plaintext: keyBytes, key: cacheKey, aad: aad)
    return WrappedTeamKey(
      teamId: teamId, ciphertext: ct, iv: iv, authTag: tag,
      issuedAt: issuedAt, teamKeyVersion: teamKeyVersion)
  }

  /// Read side: unwrap the stored team encryption key, verifying the localWrap AAD.
  public static func unwrapTeamKey(
    _ wrapped: WrappedTeamKey, cacheKey: SymmetricKey, userId: String
  ) -> SymmetricKey? {
    guard let aad = try? buildLocalWrapAAD(kind: "team", userId: userId, teamId: wrapped.teamId),
          let plain = try? decryptAESGCM(
            ciphertext: wrapped.ciphertext, iv: wrapped.iv, tag: wrapped.authTag,
            key: cacheKey, aad: aad)
    else { return nil }
    return SymmetricKey(data: plain)
  }

  // MARK: - Entry-level key + summary decrypt

  /// Resolve the entry-level key:
  /// - itemKeyVersion==0 → the team encryption key directly.
  /// - itemKeyVersion>=1 → unwrap the per-entry ItemKey with the team enc key +
  ///   item-key-wrap AAD, THEN derive the item encryption key (HKDF
  ///   "passwd-sso-item-enc-v1"). The raw unwrapped ItemKey is NOT the entry key.
  public static func resolveTeamEntryKey(entry: CacheEntry, teamKey: SymmetricKey) -> SymmetricKey? {
    let itemKeyVersion = entry.itemKeyVersion ?? 0
    if itemKeyVersion == 0 { return teamKey }
    guard
      let teamId = entry.teamId,
      let teamKeyVersion = entry.teamKeyVersion,
      let wrapped = entry.encryptedItemKey,
      let aad = try? buildItemKeyWrapAAD(teamId: teamId, entryId: entry.id, teamKeyVersion: teamKeyVersion),
      let cipher = try? hexDecode(wrapped.ciphertext),
      let iv = try? hexDecode(wrapped.iv),
      let tag = try? hexDecode(wrapped.authTag),
      var itemKeyData = try? decryptAESGCM(ciphertext: cipher, iv: iv, tag: tag, key: teamKey, aad: aad)
    else { return nil }
    defer { itemKeyData.resetBytes(in: 0..<itemKeyData.count) }
    return TeamKeyCrypto.deriveItemEncryptionKey(itemKey: SymmetricKey(data: itemKeyData))
  }

  /// Resolve the per-entry decryption key for a team entry: lookup by teamId,
  /// 15-min staleness, cacheKey unwrap, item-key resolve. Returns nil to skip.
  public static func teamEntryKey(
    entry: CacheEntry, teamKeys: [WrappedTeamKey], cacheKey: SymmetricKey,
    userId: String, now: () -> Date
  ) -> SymmetricKey? {
    guard
      let teamId = entry.teamId,
      let wrapped = teamKeys.first(where: { $0.teamId == teamId }),
      now().timeIntervalSince(wrapped.issuedAt) <= teamKeyMaxAge,
      let teamKey = unwrapTeamKey(wrapped, cacheKey: cacheKey, userId: userId)
    else { return nil }
    // Defensive: the AAD binding uses wrapped.teamId; if a future refactor decouples
    // lookup from unwrap, this surfaces a key-mismatch bug directly (S12) instead of
    // as an opaque AEAD failure. Today the lookup guarantees equality.
    assert(wrapped.teamId == teamId, "teamEntryKey: wrapped.teamId \(wrapped.teamId) != \(teamId)")
    return resolveTeamEntryKey(entry: entry, teamKey: teamKey)
  }

  /// Full team-entry overview decrypt for QuickType registration + in-app list.
  /// Returns nil (skip) on any failure — callers offer only what decrypts.
  public static func decryptTeamSummary(
    entry: CacheEntry, teamKeys: [WrappedTeamKey], cacheKey: SymmetricKey,
    userId: String, now: () -> Date
  ) -> VaultEntrySummary? {
    guard
      let teamId = entry.teamId,
      let entryKey = teamEntryKey(
        entry: entry, teamKeys: teamKeys, cacheKey: cacheKey, userId: userId, now: now),
      let aad = try? buildTeamEntryAAD(
        teamId: teamId, entryId: entry.id, vaultType: VaultType.overview,
        itemKeyVersion: entry.itemKeyVersion ?? 0),
      let iv = try? hexDecode(entry.encryptedOverview.iv),
      let cipher = try? hexDecode(entry.encryptedOverview.ciphertext),
      let tag = try? hexDecode(entry.encryptedOverview.authTag),
      let plaintext = try? decryptAESGCM(ciphertext: cipher, iv: iv, tag: tag, key: entryKey, aad: aad)
    else { return nil }
    return EntryBlobDecoder.summary(
      plaintext: plaintext, entryId: entry.id, teamId: teamId,
      entryType: entry.entryType, isFavorite: entry.isFavorite ?? false)
  }

  /// Full team-entry detail (blob) decrypt for the in-app detail screen.
  public static func decryptTeamDetail(
    entry: CacheEntry, teamKeys: [WrappedTeamKey], cacheKey: SymmetricKey,
    userId: String, now: () -> Date
  ) -> VaultEntryDetail? {
    guard
      let teamId = entry.teamId,
      let entryKey = teamEntryKey(
        entry: entry, teamKeys: teamKeys, cacheKey: cacheKey, userId: userId, now: now),
      let aad = try? buildTeamEntryAAD(
        teamId: teamId, entryId: entry.id, vaultType: VaultType.blob,
        itemKeyVersion: entry.itemKeyVersion ?? 0),
      let iv = try? hexDecode(entry.encryptedBlob.iv),
      let cipher = try? hexDecode(entry.encryptedBlob.ciphertext),
      let tag = try? hexDecode(entry.encryptedBlob.authTag),
      let plaintext = try? decryptAESGCM(ciphertext: cipher, iv: iv, tag: tag, key: entryKey, aad: aad)
    else { return nil }
    return EntryBlobDecoder.detail(
      plaintext: plaintext, entryId: entry.id, teamId: teamId, entryType: entry.entryType)
  }
}
