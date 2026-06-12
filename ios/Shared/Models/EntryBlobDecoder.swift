import Foundation

/// Decodes decrypted entry-blob plaintext (the JSON produced by the server's
/// `buildPersonalEntryPayload`) into the iOS view models.
///
/// SINGLE source of truth for blob → model mapping. The host app
/// (`VaultViewModel`) and the AutoFill extension (`CredentialResolver`) MUST
/// both go through here — duplicating this decode is what let the
/// server-shape mismatch (no `id`, `null` fields, tags as `{name,color}`
/// objects) ship undetected.
///
/// The server blob does NOT carry `id` (it lives on the cache row) or, for the
/// full blob, `urlHost`; `username`/`url`/`notes` may be `null`;
/// `additionalUrlHosts` is omitted when empty. Decode only the fields we read
/// (Decodable ignores unknown keys) so variant nested shapes
/// (generatorSettings/customFields/passwordHistory) can't break the decode.
public enum EntryBlobDecoder {
  private struct OverviewBlobPayload: Decodable {
    let title: String
    let username: String?
    let urlHost: String?
    let additionalUrlHosts: [String]?
    let tags: [TagPayload]?
    // TOTP presence marker written by the web client's overview blob. Absent
    // (→ nil → false) for non-LOGIN entries and for entries encrypted before
    // the marker shipped.
    let hasTOTP: Bool?
    // Web-only overview fields the iOS form does not edit. Decoded so an iOS
    // re-encrypt can preserve them — dropping requireReprompt would silently
    // remove a master-passphrase re-prompt requirement (security downgrade);
    // dropping travelSafe would lose the entry's travel-mode visibility.
    let requireReprompt: Bool?
    let travelSafe: Bool?
    // PASSKEY overview fields (present only for entryType==PASSKEY). Their
    // presence classifies an entry as a passkey on iOS (rpId != nil).
    let relyingPartyId: String?
    let credentialId: String?
  }

  private struct FullBlobPayload: Decodable {
    let title: String
    let username: String?
    // Optional: non-LOGIN entry types (secure note, card, identity) have no
    // `password` in the full blob; requiring it failed their detail decode and
    // left the detail view stuck on "decrypting".
    let password: String?
    let url: String?
    let notes: String?
    let tags: [TagPayload]?
    let totp: TotpPayload?
  }

  /// Full-blob fields needed to build a passkey assertion. Decoded separately
  /// so the LOGIN detail path stays untouched. `passkeyPrivateKeyJwk` is itself
  /// a JSON string (double-encoded) holding the EC JWK.
  private struct PasskeyFullBlobPayload: Decodable {
    let relyingPartyId: String?
    let credentialId: String?
    let passkeyPrivateKeyJwk: String?
    let passkeyUserHandle: String?
    // Monotonic signature counter the extension increments + persists per
    // assertion. The RP enforces monotonicity; the assertion emits this + 1.
    let passkeySignCount: Int?
  }

  private struct TagPayload: Decodable {
    let name: String
    let color: String?
  }

  private struct TotpPayload: Decodable {
    let secret: String
    let algorithm: String?
    let digits: Int?
    let period: Int?
  }

  /// Reconstruct a list-view summary from an overview-blob plaintext. `id` and
  /// `teamId` come from the cache row, not the blob. `hasTOTP` comes from the
  /// overview blob's TOTP presence marker (written by the web client); it
  /// drives the one-time-code AutoFill picker filter. Entries encrypted before
  /// the marker shipped decode to `false` until their next save.
  /// `entryType`/`isFavorite` are non-secret server metadata that live on the
  /// cache row (not in the encrypted overview blob), so the caller supplies them
  /// from the `CacheEntry`. They default so the AutoFill call sites — which don't
  /// need them — stay unchanged.
  public static func summary(
    plaintext: Data,
    entryId: String,
    teamId: String?,
    entryType: String? = nil,
    isFavorite: Bool = false
  ) -> VaultEntrySummary? {
    guard let p = try? JSONDecoder().decode(OverviewBlobPayload.self, from: plaintext) else {
      return nil
    }
    return VaultEntrySummary(
      id: entryId,
      title: p.title,
      username: p.username ?? "",
      urlHost: p.urlHost ?? "",
      additionalUrlHosts: p.additionalUrlHosts ?? [],
      tags: p.tags?.map { $0.name } ?? [],
      teamId: teamId,
      lastAccessedAt: nil,
      hasTOTP: p.hasTOTP ?? false,
      requireReprompt: p.requireReprompt ?? false,
      // Keep travelSafe three-state (nil = absent): preserved verbatim on edit.
      travelSafe: p.travelSafe,
      relyingPartyId: p.relyingPartyId,
      credentialId: p.credentialId,
      entryType: entryType,
      isFavorite: isFavorite
    )
  }

  /// Decode a passkey's FULL blob into assertion material. Returns nil unless
  /// relyingPartyId, credentialId AND passkeyPrivateKeyJwk are all present (i.e.
  /// the blob is a usable passkey). The inner JWK may carry extra Web-Crypto
  /// fields (`key_ops`/`ext`) — JSONDecoder ignores unknown keys.
  public static func passkeyMaterial(
    plaintext: Data,
    entryId: String
  ) -> PasskeyAssertionMaterial? {
    guard let p = try? JSONDecoder().decode(PasskeyFullBlobPayload.self, from: plaintext) else {
      return nil
    }
    guard
      let rpId = p.relyingPartyId,
      let credentialId = p.credentialId,
      let jwk = p.passkeyPrivateKeyJwk,
      let jwkData = jwk.data(using: .utf8)
    else {
      return nil
    }
    return PasskeyAssertionMaterial(
      entryId: entryId,
      relyingPartyId: rpId,
      credentialId: credentialId,
      userHandle: p.passkeyUserHandle ?? "",
      privateKeyJWK: jwkData,
      signCount: UInt32(clamping: max(0, p.passkeySignCount ?? 0))
    )
  }

  /// Reconstruct a detail view from a full-blob plaintext. `id`/`teamId` come
  /// from the cache row; `totpSecret` is derived from the `totp` object.
  public static func detail(
    plaintext: Data,
    entryId: String,
    teamId: String?
  ) -> VaultEntryDetail? {
    guard let p = try? JSONDecoder().decode(FullBlobPayload.self, from: plaintext) else {
      return nil
    }
    return VaultEntryDetail(
      id: entryId,
      title: p.title,
      username: p.username ?? "",
      urlHost: "",
      additionalUrlHosts: [],
      tags: p.tags?.map { $0.name } ?? [],
      teamId: teamId,
      lastAccessedAt: nil,
      password: p.password ?? "",
      url: p.url ?? "",
      notes: p.notes ?? "",
      totpSecret: p.totp?.secret,
      totpAlgorithm: p.totp?.algorithm,
      totpDigits: p.totp?.digits,
      totpPeriod: p.totp?.period,
      generatorSettings: nil
    )
  }
}
