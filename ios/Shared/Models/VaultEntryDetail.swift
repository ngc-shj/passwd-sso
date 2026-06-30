import Foundation

/// Decoded from encryptedBlob — full entry including secrets.
public struct VaultEntryDetail: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let title: String
  public let username: String
  public let urlHost: String
  public let additionalUrlHosts: [String]
  public let tags: [String]
  public let teamId: String?
  public let lastAccessedAt: Date?
  public let password: String
  public let url: String
  public let notes: String
  public let totpSecret: String?
  public let totpAlgorithm: String?
  public let totpDigits: Int?
  public let totpPeriod: Int?
  public let generatorSettings: GeneratorSettings?

  /// Server entry-type string ("LOGIN", "CREDIT_CARD", …); nil ⇒ treat as LOGIN.
  /// Sourced from the cache row (CacheEntry.entryType), never the blob — personal
  /// blobs omit it. Drives which sub-struct the detail view renders.
  public let entryType: String?
  /// Exactly one of these is non-nil for a non-login entry; all nil for LOGIN.
  /// Every field is optional so a missing blob key never fails the sub-struct decode.
  public let secureNote: SecureNoteDetail?
  public let creditCard: CreditCardDetail?
  public let identity: IdentityDetail?
  public let bankAccount: BankAccountDetail?
  public let sshKey: SshKeyDetail?
  public let softwareLicense: SoftwareLicenseDetail?
  public let passkey: PasskeyDetail?
  public let customFields: [CustomField]

  public struct SecureNoteDetail: Codable, Sendable, Equatable {
    public let content: String?
    public let isMarkdown: Bool?
    public init(content: String? = nil, isMarkdown: Bool? = nil) {
      self.content = content
      self.isMarkdown = isMarkdown
    }
  }

  public struct CreditCardDetail: Codable, Sendable, Equatable {
    public let cardholderName: String?
    public let cardNumber: String?
    public let brand: String?
    public let expiryMonth: String?
    public let expiryYear: String?
    public let cvv: String?
    public init(
      cardholderName: String? = nil, cardNumber: String? = nil, brand: String? = nil,
      expiryMonth: String? = nil, expiryYear: String? = nil, cvv: String? = nil
    ) {
      self.cardholderName = cardholderName
      self.cardNumber = cardNumber
      self.brand = brand
      self.expiryMonth = expiryMonth
      self.expiryYear = expiryYear
      self.cvv = cvv
    }
  }

  public struct IdentityDetail: Codable, Sendable, Equatable {
    public let fullName: String?
    public let address: String?
    public let givenName: String?
    public let familyName: String?
    public let middleName: String?
    public let familyNameKana: String?
    public let givenNameKana: String?
    public let addressLine1: String?
    public let addressLine2: String?
    public let city: String?
    public let state: String?
    public let postalCode: String?
    public let country: String?
    public let phone: String?
    public let email: String?
    public let dateOfBirth: String?
    public let nationality: String?
    public let idNumber: String?
    public let issueDate: String?
    public let expiryDate: String?
    public init(
      fullName: String? = nil, address: String? = nil, givenName: String? = nil,
      familyName: String? = nil, middleName: String? = nil, familyNameKana: String? = nil,
      givenNameKana: String? = nil, addressLine1: String? = nil, addressLine2: String? = nil,
      city: String? = nil, state: String? = nil, postalCode: String? = nil,
      country: String? = nil, phone: String? = nil, email: String? = nil,
      dateOfBirth: String? = nil, nationality: String? = nil, idNumber: String? = nil,
      issueDate: String? = nil, expiryDate: String? = nil
    ) {
      self.fullName = fullName
      self.address = address
      self.givenName = givenName
      self.familyName = familyName
      self.middleName = middleName
      self.familyNameKana = familyNameKana
      self.givenNameKana = givenNameKana
      self.addressLine1 = addressLine1
      self.addressLine2 = addressLine2
      self.city = city
      self.state = state
      self.postalCode = postalCode
      self.country = country
      self.phone = phone
      self.email = email
      self.dateOfBirth = dateOfBirth
      self.nationality = nationality
      self.idNumber = idNumber
      self.issueDate = issueDate
      self.expiryDate = expiryDate
    }
  }

  public struct BankAccountDetail: Codable, Sendable, Equatable {
    public let bankName: String?
    public let accountType: String?
    public let accountHolderName: String?
    public let accountNumber: String?
    public let routingNumber: String?
    public let swiftBic: String?
    public let iban: String?
    public let branchName: String?
    public init(
      bankName: String? = nil, accountType: String? = nil, accountHolderName: String? = nil,
      accountNumber: String? = nil, routingNumber: String? = nil, swiftBic: String? = nil,
      iban: String? = nil, branchName: String? = nil
    ) {
      self.bankName = bankName
      self.accountType = accountType
      self.accountHolderName = accountHolderName
      self.accountNumber = accountNumber
      self.routingNumber = routingNumber
      self.swiftBic = swiftBic
      self.iban = iban
      self.branchName = branchName
    }
  }

  public struct SshKeyDetail: Codable, Sendable, Equatable {
    public let privateKey: String?
    public let publicKey: String?
    public let keyType: String?
    public let fingerprint: String?
    public let passphrase: String?
    public let comment: String?
    // Auto-detected bit length. The web client writes it as a JSON number;
    // EntryBlobDecoder tolerantly decodes number-or-string and normalizes to a
    // display string here (see FlexibleString in EntryBlobDecoder).
    public let keySize: String?
    public init(
      privateKey: String? = nil, publicKey: String? = nil, keyType: String? = nil,
      fingerprint: String? = nil, passphrase: String? = nil, comment: String? = nil,
      keySize: String? = nil
    ) {
      self.privateKey = privateKey
      self.publicKey = publicKey
      self.keyType = keyType
      self.fingerprint = fingerprint
      self.passphrase = passphrase
      self.comment = comment
      self.keySize = keySize
    }
  }

  public struct SoftwareLicenseDetail: Codable, Sendable, Equatable {
    public let softwareName: String?
    public let licenseKey: String?
    public let version: String?
    public let licensee: String?
    public let email: String?
    public let purchaseDate: String?
    public let expirationDate: String?
    public init(
      softwareName: String? = nil, licenseKey: String? = nil, version: String? = nil,
      licensee: String? = nil, email: String? = nil, purchaseDate: String? = nil,
      expirationDate: String? = nil
    ) {
      self.softwareName = softwareName
      self.licenseKey = licenseKey
      self.version = version
      self.licensee = licensee
      self.email = email
      self.purchaseDate = purchaseDate
      self.expirationDate = expirationDate
    }
  }

  public struct PasskeyDetail: Codable, Sendable, Equatable {
    public let relyingPartyId: String?
    public let relyingPartyName: String?
    public let username: String?
    public let credentialId: String?
    public let creationDate: String?
    public let deviceInfo: String?
    public init(
      relyingPartyId: String? = nil, relyingPartyName: String? = nil, username: String? = nil,
      credentialId: String? = nil, creationDate: String? = nil, deviceInfo: String? = nil
    ) {
      self.relyingPartyId = relyingPartyId
      self.relyingPartyName = relyingPartyName
      self.username = username
      self.credentialId = credentialId
      self.creationDate = creationDate
      self.deviceInfo = deviceInfo
    }
  }

  public struct CustomField: Codable, Sendable, Equatable, Identifiable {
    public let id: Int            // positional index, for ForEach stability
    public let label: String
    public let value: String
    public let type: String       // raw web type string
    public var kind: CustomFieldKind { CustomFieldKind(rawValue: type) ?? .text }
  }

  public enum CustomFieldKind: String, Sendable {
    case text, hidden, url, boolean, date, monthYear

    public var rowKind: CustomFieldRowKind {
      switch self {
      case .hidden: .masked
      case .url: .url
      case .boolean: .boolean
      case .text, .date, .monthYear: .plain
      }
    }
  }

  public enum CustomFieldRowKind: Sendable, Equatable {
    case plain, masked, url, boolean
  }

  public struct GeneratorSettings: Codable, Sendable, Equatable {
    public let length: Int
    public let useUppercase: Bool
    public let useLowercase: Bool
    public let useNumbers: Bool
    public let symbols: String

    public init(
      length: Int = 16,
      useUppercase: Bool = true,
      useLowercase: Bool = true,
      useNumbers: Bool = true,
      symbols: String = ""
    ) {
      self.length = length
      self.useUppercase = useUppercase
      self.useLowercase = useLowercase
      self.useNumbers = useNumbers
      self.symbols = symbols
    }
  }

  public init(
    id: String,
    title: String,
    username: String,
    urlHost: String,
    additionalUrlHosts: [String] = [],
    tags: [String] = [],
    teamId: String? = nil,
    lastAccessedAt: Date? = nil,
    password: String,
    url: String,
    notes: String = "",
    totpSecret: String? = nil,
    totpAlgorithm: String? = nil,
    totpDigits: Int? = nil,
    totpPeriod: Int? = nil,
    generatorSettings: GeneratorSettings? = nil,
    entryType: String? = nil,
    secureNote: SecureNoteDetail? = nil,
    creditCard: CreditCardDetail? = nil,
    identity: IdentityDetail? = nil,
    bankAccount: BankAccountDetail? = nil,
    sshKey: SshKeyDetail? = nil,
    softwareLicense: SoftwareLicenseDetail? = nil,
    passkey: PasskeyDetail? = nil,
    customFields: [CustomField] = []
  ) {
    self.id = id
    self.title = title
    self.username = username
    self.urlHost = urlHost
    self.additionalUrlHosts = additionalUrlHosts
    self.tags = tags
    self.teamId = teamId
    self.lastAccessedAt = lastAccessedAt
    self.password = password
    self.url = url
    self.notes = notes
    self.totpSecret = totpSecret
    self.totpAlgorithm = totpAlgorithm
    self.totpDigits = totpDigits
    self.totpPeriod = totpPeriod
    self.generatorSettings = generatorSettings
    self.entryType = entryType
    self.secureNote = secureNote
    self.creditCard = creditCard
    self.identity = identity
    self.bankAccount = bankAccount
    self.sshKey = sshKey
    self.softwareLicense = softwareLicense
    self.passkey = passkey
    self.customFields = customFields
  }
}
