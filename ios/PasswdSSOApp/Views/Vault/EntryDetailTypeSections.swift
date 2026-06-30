import Shared
import SwiftUI

/// A masked field row with a per-row reveal toggle and a secure copy button.
/// Standalone (not a generalization of EntryDetailView.passwordRow, which stays
/// untouched) so each secret owns its OWN reveal state — revealing one secret in
/// a multi-secret entry (card number + CVV, account + routing + IBAN, private
/// key + passphrase) does not reveal its siblings.
struct SecretRow: View {
  let label: LocalizedStringKey
  let value: String
  let onCopy: (String) -> Void
  let onActivity: () -> Void

  @State private var isRevealed = false

  var body: some View {
    Section(label) {
      HStack {
        if isRevealed {
          Text(value)
            .font(.body.monospaced())
            .privacySensitive()
        } else {
          SecureField("", text: .constant(value))
            .disabled(true)
        }
        Spacer()
        Button {
          isRevealed.toggle()
          onActivity()
        } label: {
          Image(systemName: isRevealed ? "eye.slash" : "eye")
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        Button {
          onCopy(value)
          onActivity()
        } label: {
          Image(systemName: "doc.on.doc")
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .tint(.accentColor)
      }
    }
  }
}

// MARK: - Per-type detail sections
//
// Non-login types render only the fields that carry a value (cleaner than the
// LOGIN show-all-with-"Not set" idiom, and matches the web app's conditional
// rendering). Secrets are masked per the web SENSITIVE_FIELDS classification.
extension EntryDetailView {
  // Plain copyable row, rendered only when the value is present.
  @ViewBuilder
  func optionalFieldRow(_ label: LocalizedStringKey, _ value: String?) -> some View {
    if let value, !value.isEmpty {
      fieldRow(label: label, value: value)
    }
  }

  // Masked reveal+copy row, rendered only when the value is present.
  @ViewBuilder
  func optionalSecretRow(_ label: LocalizedStringKey, _ value: String?) -> some View {
    if let value, !value.isEmpty {
      SecretRow(
        label: label,
        value: value,
        onCopy: { copySecurely(value: $0) },
        onActivity: { autoLockService?.recordActivity() }
      )
    }
  }

  @ViewBuilder
  func notesSection(_ notes: String) -> some View {
    if !notes.isEmpty {
      Section("Notes") {
        Text(notes)
          .font(.caption)
          .privacySensitive()
      }
    }
  }

  @ViewBuilder
  func secureNoteSection(_ note: VaultEntryDetail.SecureNoteDetail?) -> some View {
    Section("Note") {
      let content = note?.content ?? ""
      if content.isEmpty {
        notSetText
      } else {
        Text(content)
          .font(.body)
          .privacySensitive()
      }
    }
  }

  @ViewBuilder
  func creditCardSection(_ card: VaultEntryDetail.CreditCardDetail?, notes: String) -> some View {
    optionalFieldRow("Cardholder Name", card?.cardholderName)
    optionalFieldRow("Brand", card?.brand)
    optionalSecretRow("Card Number", card?.cardNumber)
    optionalFieldRow("Expiry Month", card?.expiryMonth)
    optionalFieldRow("Expiry Year", card?.expiryYear)
    optionalSecretRow("CVV", card?.cvv)
    notesSection(notes)
  }

  @ViewBuilder
  func identitySection(_ id: VaultEntryDetail.IdentityDetail?, notes: String) -> some View {
    optionalFieldRow("Full Name", id?.fullName)
    optionalFieldRow("Given Name", id?.givenName)
    optionalFieldRow("Family Name", id?.familyName)
    optionalFieldRow("Middle Name", id?.middleName)
    optionalFieldRow("Given Name (Kana)", id?.givenNameKana)
    optionalFieldRow("Family Name (Kana)", id?.familyNameKana)
    // Address PII is masked per the web SENSITIVE_FIELDS classification.
    optionalSecretRow("Address", id?.address)
    optionalSecretRow("Address Line 1", id?.addressLine1)
    optionalSecretRow("Address Line 2", id?.addressLine2)
    optionalFieldRow("City", id?.city)
    optionalFieldRow("State", id?.state)
    optionalSecretRow("Postal Code", id?.postalCode)
    optionalFieldRow("Country", id?.country)
    optionalFieldRow("Phone", id?.phone)
    optionalFieldRow("Email", id?.email)
    optionalFieldRow("Date of Birth", id?.dateOfBirth)
    optionalFieldRow("Nationality", id?.nationality)
    optionalSecretRow("ID Number", id?.idNumber)
    optionalFieldRow("Issue Date", id?.issueDate)
    optionalFieldRow("Expiry Date", id?.expiryDate)
    notesSection(notes)
  }

  @ViewBuilder
  func bankAccountSection(_ bank: VaultEntryDetail.BankAccountDetail?, notes: String) -> some View {
    optionalFieldRow("Bank Name", bank?.bankName)
    optionalFieldRow("Account Type", bank?.accountType)
    optionalFieldRow("Account Holder Name", bank?.accountHolderName)
    optionalSecretRow("Account Number", bank?.accountNumber)
    optionalSecretRow("Routing Number", bank?.routingNumber)
    optionalFieldRow("SWIFT / BIC", bank?.swiftBic)
    optionalSecretRow("IBAN", bank?.iban)
    optionalFieldRow("Branch Name", bank?.branchName)
    notesSection(notes)
  }

  @ViewBuilder
  func sshKeySection(_ key: VaultEntryDetail.SshKeyDetail?, notes: String) -> some View {
    optionalFieldRow("Key Type", key?.keyType)
    optionalFieldRow("Key Size", key?.keySize)
    optionalFieldRow("Fingerprint", key?.fingerprint)
    optionalFieldRow("Public Key", key?.publicKey)
    optionalSecretRow("Private Key", key?.privateKey)
    optionalSecretRow("Passphrase", key?.passphrase)
    optionalFieldRow("Comment", key?.comment)
    notesSection(notes)
  }

  @ViewBuilder
  func softwareLicenseSection(
    _ lic: VaultEntryDetail.SoftwareLicenseDetail?, notes: String
  ) -> some View {
    optionalFieldRow("Software Name", lic?.softwareName)
    optionalSecretRow("License Key", lic?.licenseKey)
    optionalFieldRow("Version", lic?.version)
    optionalFieldRow("Licensee", lic?.licensee)
    optionalFieldRow("Email", lic?.email)
    optionalFieldRow("Purchase Date", lic?.purchaseDate)
    optionalFieldRow("Expiration Date", lic?.expirationDate)
    notesSection(notes)
  }

  @ViewBuilder
  func passkeySection(_ pk: VaultEntryDetail.PasskeyDetail?, notes: String) -> some View {
    optionalFieldRow("Relying Party ID", pk?.relyingPartyId)
    optionalFieldRow("Relying Party Name", pk?.relyingPartyName)
    optionalFieldRow("Username", pk?.username)
    optionalSecretRow("Credential ID", pk?.credentialId)
    optionalFieldRow("Creation Date", pk?.creationDate)
    optionalFieldRow("Device Info", pk?.deviceInfo)
    notesSection(notes)
  }

  // MARK: - Custom fields

  /// Parses an ISO 8601 date-only string ("YYYY-MM-DD") and formats it for display
  /// using the given locale. Returns nil on parse failure (caller shows raw value).
  /// Uses a UTC calendar so a bare date does not shift a day in non-UTC time zones.
  static func formatCustomFieldDate(_ raw: String, locale: Locale) -> String? {
    // The web stores bare "YYYY-MM-DD" (toISODateString). The default .iso8601
    // strategy rejects bare dates — use the date-only strategy explicitly.
    let strategy = Date.ISO8601FormatStyle()
      .year().month().day().dateSeparator(.dash)
    guard let date = try? Date(raw, strategy: strategy) else { return nil }
    // Format in UTC too: the value is a date-only "YYYY-MM-DD" parsed as UTC
    // midnight; formatting in the device time zone would shift it to the
    // previous day in negative-UTC offsets. Pin display to UTC (via the
    // initializer's timeZone: parameter — the fluent `.timeZone(_:)` setter
    // takes a display-style Symbol, not a TimeZone) so the rendered day matches
    // the stored day everywhere.
    let style = Date.FormatStyle(
      date: .abbreviated,
      locale: locale,
      timeZone: TimeZone(identifier: "UTC") ?? .gmt
    )
    return date.formatted(style)
  }

  @ViewBuilder
  func customFieldRows(_ fields: [VaultEntryDetail.CustomField]) -> some View {
    if !fields.isEmpty {
      ForEach(fields) { field in
        customFieldSection(field)
      }
    }
  }

  @ViewBuilder
  private func customFieldSection(_ field: VaultEntryDetail.CustomField) -> some View {
    switch field.kind.rowKind {
    case .masked:
      CustomFieldMaskedSection(
        label: field.label,
        value: field.value,
        onCopy: { copySecurely(value: $0) },
        onActivity: { autoLockService?.recordActivity() }
      )
    case .url:
      Section(field.label) {
        if let launchable = SafeURL.launchable(field.value) {
          HStack {
            Button {
              autoLockService?.recordActivity()
              openURL(launchable)
            } label: {
              Text(field.value)
                .font(.body)
                .foregroundStyle(.tint)
                .multilineTextAlignment(.leading)
            }
            .buttonStyle(.plain)
            Spacer()
            Button {
              copySecurely(value: field.value)
              autoLockService?.recordActivity()
            } label: {
              Image(systemName: "doc.on.doc")
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .tint(.accentColor)
          }
        } else {
          HStack {
            Text(field.value)
              .font(.body)
            Spacer()
            Button {
              copySecurely(value: field.value)
              autoLockService?.recordActivity()
            } label: {
              Image(systemName: "doc.on.doc")
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .tint(.accentColor)
          }
        }
      }
    case .boolean:
      Section(field.label) {
        Text(field.value == "true" ? "Yes" : "No")
          .font(.body)
      }
    case .plain:
      Section(field.label) {
        HStack {
          if field.kind == .date,
             let formatted = Self.formatCustomFieldDate(
               field.value, locale: Locale.current) {
            Text(formatted)
              .font(.body)
          } else {
            Text(field.value)
              .font(.body)
          }
          Spacer()
          Button {
            copySecurely(value: field.value)
            autoLockService?.recordActivity()
          } label: {
            Image(systemName: "doc.on.doc")
              .frame(minWidth: 44, minHeight: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .tint(.accentColor)
        }
      }
    }
  }
}

// A masked custom field section with per-field reveal state (so revealing one
// hidden field does not reveal siblings). Cannot be merged into SecretRow because
// SecretRow takes a LocalizedStringKey header; custom-field labels are dynamic
// user data and must bind the String/StringProtocol Section overload.
private struct CustomFieldMaskedSection: View {
  let label: String
  let value: String
  let onCopy: (String) -> Void
  let onActivity: () -> Void

  @State private var isRevealed = false

  var body: some View {
    Section(label) {
      HStack {
        if isRevealed {
          Text(value)
            .font(.body.monospaced())
            .privacySensitive()
        } else {
          SecureField("", text: .constant(value))
            .disabled(true)
        }
        Spacer()
        Button {
          isRevealed.toggle()
          onActivity()
        } label: {
          Image(systemName: isRevealed ? "eye.slash" : "eye")
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        Button {
          onCopy(value)
          onActivity()
        } label: {
          Image(systemName: "doc.on.doc")
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .tint(.accentColor)
      }
    }
  }
}
