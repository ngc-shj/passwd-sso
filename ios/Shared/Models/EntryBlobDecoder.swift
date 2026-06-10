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
  /// `teamId` come from the cache row, not the blob. `hasTOTP` is `false`: the
  /// overview blob carries no TOTP marker and the cache row has none, so the
  /// TOTP-only AutoFill picker filter is degraded; the full blob still yields
  /// the TOTP secret in `detail(...)`.
  public static func summary(
    plaintext: Data,
    entryId: String,
    teamId: String?
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
      hasTOTP: false
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
      generatorSettings: nil
    )
  }
}
