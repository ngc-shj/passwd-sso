import Foundation

/// Builds the plaintext full-blob + overview JSON for a new PASSKEY entry,
/// matching the browser extension's shape (extension/src/background/passkey-provider.ts)
/// so a passkey created on iOS is read by the web app, the extension, and the
/// shipped iOS assertion decoders (EntryBlobDecoder.passkeyMaterial / .summary).
public enum PasskeyEntryBlobBuilder {
  private struct FullBlob: Encodable {
    let entryType = "PASSKEY"
    let title: String
    let username: String
    let relyingPartyId: String
    let relyingPartyName: String
    let credentialId: String
    let creationDate: String
    let passkeyPrivateKeyJwk: String  // double-encoded JSON string
    let passkeyPublicKeyCose: String  // base64url
    let passkeyUserHandle: String     // base64url
    let passkeyUserDisplayName: String
    let passkeySignCount = 0
    let passkeyAlgorithm = -7
    let passkeyTransports = ["internal", "hybrid"]
    let tags: [String] = []
  }

  private struct Overview: Encodable {
    let title: String
    let relyingPartyId: String
    let credentialId: String
    let username: String
    let creationDate: String
    let tags: [String] = []
  }

  /// `creationDate` is injected (ISO 8601) so the output is deterministic for tests.
  public static func buildCreate(
    rpId: String,
    rpName: String,
    userName: String,
    userHandle: Data,
    userDisplayName: String,
    passkey: GeneratedPasskey,
    creationDate: String
  ) throws -> (blob: Data, overview: Data) {
    let title = "\(rpName) (\(userName))"
    let credentialIdB64 = base64URLEncode(passkey.credentialId)

    let full = FullBlob(
      title: title,
      username: userName,
      relyingPartyId: rpId,
      relyingPartyName: rpName,
      credentialId: credentialIdB64,
      creationDate: creationDate,
      passkeyPrivateKeyJwk: passkey.privateKeyJWKString,
      passkeyPublicKeyCose: base64URLEncode(passkey.publicKeyCOSE),
      passkeyUserHandle: base64URLEncode(userHandle),
      passkeyUserDisplayName: userDisplayName
    )
    let overview = Overview(
      title: title,
      relyingPartyId: rpId,
      credentialId: credentialIdB64,
      username: userName,
      creationDate: creationDate
    )

    let encoder = JSONEncoder()
    return (try encoder.encode(full), try encoder.encode(overview))
  }
}
