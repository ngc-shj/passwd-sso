import Foundation

// Per plan §"Encrypted-entries cache integrity": AAD binds ciphertext to context.
// Binary format (byte-identical to crypto-aad.ts server-side):
//   [scope: 2 ASCII bytes][aadVersion: 1 u8][nFields: 1 u8]
//   ([field_len: 2 BE u16][field: N UTF-8 bytes])...

private let aadVersion: UInt8 = 1

/// 2-ASCII-byte scope identifiers, mirroring crypto-aad.ts constants.
public enum AADScope: String {
  case personal = "PV"
  case team = "OV"
  case attachment = "AT"
  case itemKey = "IK"
  /// TeamMemberKey wrapping (server-compat, mirrors extension crypto-team.ts).
  case teamKey = "OK"
  /// iOS-local cacheKey wraps (ECDH key + team enc keys) — NOT shared with server.
  case localWrap = "LW"
}

/// Vault-field discriminators used in the AAD `vaultType` field, mirroring
/// crypto-aad.ts `VAULT_TYPE`. Used by both personal and team entry AADs.
public enum VaultType {
  public static let blob = "blob"
  public static let overview = "overview"
}

/// Build the length-prefixed binary AAD from scope + fields.
/// All multi-byte integers are big-endian per plan §"Encrypted-entries cache integrity".
public func buildAADBytes(scope: AADScope, fields: [String]) throws -> Data {
  let scopeBytes = Array(scope.rawValue.utf8)
  guard scopeBytes.count == 2 else {
    throw AADError.invalidScope
  }

  let encodedFields = fields.map { Array($0.utf8) }
  for field in encodedFields {
    guard field.count <= 0xFFFF else {
      throw AADError.fieldTooLong
    }
  }

  // Header: scope(2) + aadVersion(1) + nFields(1) = 4 bytes
  let headerSize = 4
  let fieldsSize = encodedFields.reduce(0) { $0 + 2 + $1.count }
  var data = Data(capacity: headerSize + fieldsSize)

  data.append(scopeBytes[0])
  data.append(scopeBytes[1])
  data.append(aadVersion)
  data.append(UInt8(fields.count))

  for field in encodedFields {
    // Per plan: big-endian u16 field length
    let len = UInt16(field.count).bigEndian
    withUnsafeBytes(of: len) { data.append(contentsOf: $0) }
    data.append(contentsOf: field)
  }

  return data
}

/// Build AAD for a personal vault entry (userId, entryId, vaultType).
/// vaultType ("blob" vs "overview") prevents cross-field ciphertext replay and
/// is REQUIRED — it must match the field being encrypted/decrypted (3-field
/// shape, byte-identical to crypto-aad.ts since server PR #482). String-typed
/// to match buildTeamEntryAAD and the vaultType already threaded by
/// CredentialResolver / VaultViewModel.
public func buildPersonalEntryAAD(
  userId: String,
  entryId: String,
  vaultType: String
) throws -> Data {
  try buildAADBytes(scope: .personal, fields: [userId, entryId, vaultType])
}

/// Build AAD for a team vault entry (teamId, entryId, vaultType, itemKeyVersion).
/// vaultType defaults to "blob"; itemKeyVersion defaults to 0.
public func buildTeamEntryAAD(
  teamId: String,
  entryId: String,
  vaultType: String = VaultType.blob,
  itemKeyVersion: Int = 0
) throws -> Data {
  try buildAADBytes(scope: .team, fields: [teamId, entryId, vaultType, String(itemKeyVersion)])
}

/// Build AAD for item-key wrapping (teamId, entryId, teamKeyVersion).
public func buildItemKeyWrapAAD(
  teamId: String,
  entryId: String,
  teamKeyVersion: Int
) throws -> Data {
  try buildAADBytes(scope: .itemKey, fields: [teamId, entryId, String(teamKeyVersion)])
}

/// Build AAD for an attachment (entryId, attachmentId).
public func buildAttachmentAAD(entryId: String, attachmentId: String) throws -> Data {
  try buildAADBytes(scope: .attachment, fields: [entryId, attachmentId])
}

/// Build AAD for the server-side TeamMemberKey wrap (teamId, toUserId, keyVersion,
/// wrapVersion). Byte-identical to the extension's buildTeamKeyWrapAAD (scope "OK").
public func buildTeamKeyWrapAAD(
  teamId: String,
  toUserId: String,
  keyVersion: Int,
  wrapVersion: Int
) throws -> Data {
  try buildAADBytes(
    scope: .teamKey,
    fields: [teamId, toUserId, String(keyVersion), String(wrapVersion)]
  )
}

/// Build AAD for an on-device cacheKey wrap (scope "LW"). Binds the wrapped blob
/// to the user (and team) it was derived for so a transplanted blob fails AEAD.
/// `kind` is "ecdh" or "team"; `teamId` is "" for the ECDH key.
public func buildLocalWrapAAD(
  kind: String,
  userId: String,
  teamId: String = ""
) throws -> Data {
  try buildAADBytes(scope: .localWrap, fields: [kind, userId, teamId])
}

public enum AADError: Error, Equatable {
  case invalidScope
  case fieldTooLong
}
