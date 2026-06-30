import Foundation

/// Decides the single custom field value (if any) to auto-copy after a login
/// fill. Pure and best-effort: returns nil when disabled, when the entry is not
/// a LOGIN entry, when it has zero or more-than-one custom fields, when TOTP
/// already claimed the clipboard, when the single field is hidden (a durable
/// static secret must never be auto-copied — the user copies it explicitly from
/// the masked row), or when it is a boolean (the detail view treats booleans as
/// non-copyable, so a bare "true"/"false" on the clipboard would be useless).
///
/// The LOGIN gate is the type boundary for this clipboard write: only a password
/// fill of a LOGIN entry should ever auto-copy a custom field. AutoFill decodes
/// every entry through the same LOGIN-shaped path (username/password), so a
/// non-login entry reachable via the password fill path must NOT have its custom
/// field placed on the foreground app's clipboard. `entryType == nil` is treated
/// as LOGIN per the app-wide convention (personal blobs omit the type).
public func customFieldToCopy(
  detail: VaultEntryDetail,
  autoCopy: Bool,
  totpWillCopy: Bool
) -> String? {
  guard autoCopy else { return nil }
  guard detail.entryType == nil || detail.entryType == "LOGIN" else { return nil }
  guard detail.customFields.count == 1 else { return nil }
  guard !totpWillCopy else { return nil }
  let field = detail.customFields[0]
  guard field.kind != .hidden, field.kind != .boolean else { return nil }
  return field.value
}
