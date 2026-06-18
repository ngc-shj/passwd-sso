import Foundation

/// Presentation mapping for the server entry-type strings. Lives in the app
/// target (not Shared) so `localizedLabel` resolves against the app's String
/// Catalog. `from` is total — unknown/nil maps to `.login`, mirroring the wire
/// default, so no entry is uncategorizable.
enum EntryTypeCategory: String, CaseIterable {
  case login = "LOGIN"
  case secureNote = "SECURE_NOTE"
  case creditCard = "CREDIT_CARD"
  case identity = "IDENTITY"
  case bankAccount = "BANK_ACCOUNT"
  case sshKey = "SSH_KEY"
  case softwareLicense = "SOFTWARE_LICENSE"
  case passkey = "PASSKEY"

  static func from(rawType: String?) -> EntryTypeCategory {
    guard let rawType, let category = EntryTypeCategory(rawValue: rawType) else { return .login }
    return category
  }

  /// The iOS edit form is LOGIN-shaped only. Editing a non-login entry through it
  /// re-encrypts a login blob and pollutes the entry with empty login scalars +
  /// a login-shaped overview. Only LOGIN (and unknown/nil, which falls back to
  /// LOGIN) is editable on iOS; everything else is edited in the web app.
  static func isEditableOnIOS(rawType: String?) -> Bool {
    from(rawType: rawType) == .login
  }

  var sfSymbol: String {
    switch self {
    case .login: "person.text.rectangle"
    case .secureNote: "note.text"
    case .creditCard: "creditcard"
    case .identity: "person.crop.square"
    case .bankAccount: "building.columns"
    case .sshKey: "terminal"
    case .softwareLicense: "checkmark.seal"
    case .passkey: "key.horizontal"
    }
  }

  /// Plural, user-facing label. Compiler-routed through `String(localized:)` so
  /// raw type identifiers never leak into the UI.
  var localizedLabel: String {
    switch self {
    case .login: String(localized: "Logins")
    case .secureNote: String(localized: "Secure Notes")
    case .creditCard: String(localized: "Credit Cards")
    case .identity: String(localized: "Identities")
    case .bankAccount: String(localized: "Bank Accounts")
    case .sshKey: String(localized: "SSH Keys")
    case .softwareLicense: String(localized: "Software Licenses")
    case .passkey: String(localized: "Passkeys")
    }
  }
}
