import Foundation

/// Decides the single non-hidden custom field value (if any) to auto-copy after
/// a login fill. Pure and best-effort: returns nil when disabled, when the entry
/// has zero or more-than-one custom fields, when TOTP already claimed the
/// clipboard, or when the single field is hidden (a durable static secret must
/// never be auto-copied — the user copies it explicitly from the masked row).
public func customFieldToCopy(
  detail: VaultEntryDetail,
  autoCopy: Bool,
  totpWillCopy: Bool
) -> String? {
  guard autoCopy else { return nil }
  guard detail.customFields.count == 1 else { return nil }
  guard !totpWillCopy else { return nil }
  let field = detail.customFields[0]
  guard field.kind != .hidden else { return nil }
  return field.value
}
