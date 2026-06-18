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
        onActivity: { autoLockService.recordActivity() }
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
}
