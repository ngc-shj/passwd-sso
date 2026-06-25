import CryptoKit
import Foundation

// MARK: - DemoVault

/// In-memory demo vault returned by DemoVaultFactory. Carries only the three
/// values needed to hydrate a VaultViewModel — no file, no Keychain, no network.
public struct DemoVault: Sendable {
  public let cacheData: CacheData
  public let vaultKey: SymmetricKey
  public let userId: String
}

// MARK: - DemoVaultFactory

/// Builds a fully-encrypted in-memory vault for Demo Mode.
///
/// Contains 9 fixture entries (8 types; LOGIN appears twice). Every blob is
/// encrypted with a fresh ephemeral SymmetricKey using the same
/// encryptAESGCMEncoded + buildPersonalEntryAAD path the real app uses, so the
/// real VaultViewModel.loadFromCache / loadDetail decrypt path exercises them
/// end-to-end in tests.
///
/// ISOLATION CONTRACT: no shared Keychain, no cache file, no wrapped-key
/// store, no host token store, no favicon loader. All state stays in-memory.
/// See DemoModeStateTests.testForbiddenPatternsAbsent_inDemoVaultFactory for
/// the grep gate that enforces this.
public enum DemoVaultFactory {

  // MARK: - Public API

  public static func makeDemoVault() throws -> DemoVault {
    let userId = "demo-user-fixture-id"
    let vaultKey = SymmetricKey(size: .bits256)

    let cacheEntries = try buildDemoEntries(vaultKey: vaultKey, userId: userId)
    let now = Date()
    let header = CacheHeader(
      cacheVersionCounter: 0,
      cacheIssuedAt: now,
      lastSuccessfulRefreshAt: now,
      entryCount: UInt32(cacheEntries.count),
      hostInstallUUID: Data(repeating: 0, count: 16),
      userId: userId
    )
    let entriesJSON = try JSONEncoder().encode(cacheEntries)
    let cacheData = CacheData(header: header, entries: entriesJSON)
    return DemoVault(cacheData: cacheData, vaultKey: vaultKey, userId: userId)
  }

  // MARK: - Blob payload encodable types

  // Shape mirrors OverviewBlobPayload in EntryBlobDecoder (the server JSON shape).
  private struct OverviewBlob: Encodable {
    let title: String
    let username: String?
    let urlHost: String?
    let tags: [TagBlob]
    let hasTOTP: Bool?
    let relyingPartyId: String?
    let credentialId: String?
  }

  // Shape mirrors FullBlobPayload in EntryBlobDecoder.
  // All type-specific fields are flat at the top level.
  private struct FullBlob: Encodable {
    let title: String
    let username: String?
    let password: String?
    let url: String?
    let notes: String?
    let tags: [TagBlob]
    let totp: TotpBlob?
    // SECURE_NOTE
    let content: String?
    let isMarkdown: Bool?
    // CREDIT_CARD
    let cardholderName: String?
    let cardNumber: String?
    let brand: String?
    let expiryMonth: String?
    let expiryYear: String?
    let cvv: String?
    // IDENTITY
    let fullName: String?
    let givenName: String?
    let familyName: String?
    let email: String?
    let phone: String?
    // BANK_ACCOUNT
    let bankName: String?
    let accountType: String?
    let accountHolderName: String?
    let accountNumber: String?
    let routingNumber: String?
    // SSH_KEY — keySize encoded as Int (web client writes a JSON number)
    let privateKey: String?
    let publicKey: String?
    let keyType: String?
    let fingerprint: String?
    let comment: String?
    let keySize: Int?
    // SOFTWARE_LICENSE
    let softwareName: String?
    let licenseKey: String?
    let version: String?
    let licensee: String?
    // PASSKEY (display fields only)
    let relyingPartyId: String?
    let relyingPartyName: String?
    let credentialId: String?
    let creationDate: String?
    let deviceInfo: String?
  }

  private struct TagBlob: Encodable {
    let name: String
    let color: String?
  }

  private struct TotpBlob: Encodable {
    let secret: String
    let algorithm: String?
    let digits: Int?
    let period: Int?
  }

  // MARK: - Fixture definitions

  private struct FixtureEntry {
    let id: String
    let entryType: String
    let isFavorite: Bool
    let overview: OverviewBlob
    let full: FullBlob
  }

  // swiftlint:disable function_body_length
  private static func fixtures() -> [FixtureEntry] {
    [
      // 1. LOGIN with TOTP — AWS Console
      FixtureEntry(
        id: "a1000000-0000-0000-0000-000000000001",
        entryType: "LOGIN",
        isFavorite: true,
        overview: OverviewBlob(
          title: "AWS Console (IAM)",
          username: "alice@example.com",
          urlHost: "signin.aws.amazon.com",
          tags: [],
          hasTOTP: true,
          relyingPartyId: nil,
          credentialId: nil
        ),
        full: FullBlob(
          title: "AWS Console (IAM)",
          username: "alice@example.com",
          password: "ChangeMe-Example-123!",
          url: "https://signin.aws.amazon.com/console",
          notes: nil,
          tags: [],
          totp: TotpBlob(secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30),
          content: nil, isMarkdown: nil,
          cardholderName: nil, cardNumber: nil, brand: nil,
          expiryMonth: nil, expiryYear: nil, cvv: nil,
          fullName: nil, givenName: nil, familyName: nil,
          email: nil, phone: nil,
          bankName: nil, accountType: nil, accountHolderName: nil,
          accountNumber: nil, routingNumber: nil,
          privateKey: nil, publicKey: nil, keyType: nil,
          fingerprint: nil, comment: nil, keySize: nil,
          softwareName: nil, licenseKey: nil, version: nil, licensee: nil,
          relyingPartyId: nil, relyingPartyName: nil,
          credentialId: nil, creationDate: nil, deviceInfo: nil
        )
      ),
      // 2. LOGIN without TOTP — GitHub
      FixtureEntry(
        id: "a2000000-0000-0000-0000-000000000002",
        entryType: "LOGIN",
        isFavorite: false,
        overview: OverviewBlob(
          title: "GitHub",
          username: "alice@example.com",
          urlHost: "github.com",
          tags: [],
          hasTOTP: nil,
          relyingPartyId: nil,
          credentialId: nil
        ),
        full: FullBlob(
          title: "GitHub",
          username: "alice@example.com",
          password: "Example-Pass-456!",
          url: "https://github.com/login",
          notes: nil,
          tags: [],
          totp: nil,
          content: nil, isMarkdown: nil,
          cardholderName: nil, cardNumber: nil, brand: nil,
          expiryMonth: nil, expiryYear: nil, cvv: nil,
          fullName: nil, givenName: nil, familyName: nil,
          email: nil, phone: nil,
          bankName: nil, accountType: nil, accountHolderName: nil,
          accountNumber: nil, routingNumber: nil,
          privateKey: nil, publicKey: nil, keyType: nil,
          fingerprint: nil, comment: nil, keySize: nil,
          softwareName: nil, licenseKey: nil, version: nil, licensee: nil,
          relyingPartyId: nil, relyingPartyName: nil,
          credentialId: nil, creationDate: nil, deviceInfo: nil
        )
      ),
      // 3. CREDIT_CARD — Corporate VISA
      FixtureEntry(
        id: "a3000000-0000-0000-0000-000000000003",
        entryType: "CREDIT_CARD",
        isFavorite: false,
        overview: OverviewBlob(
          title: "Corporate VISA", username: nil, urlHost: nil, tags: [],
          hasTOTP: nil, relyingPartyId: nil, credentialId: nil
        ),
        full: FullBlob(
          title: "Corporate VISA",
          username: nil, password: nil, url: nil, notes: nil, tags: [], totp: nil,
          content: nil, isMarkdown: nil,
          cardholderName: "Alice Example",
          cardNumber: "4111111111111111",
          brand: "Visa",
          expiryMonth: "12",
          expiryYear: "2030",
          cvv: "123",
          fullName: nil, givenName: nil, familyName: nil,
          email: nil, phone: nil,
          bankName: nil, accountType: nil, accountHolderName: nil,
          accountNumber: nil, routingNumber: nil,
          privateKey: nil, publicKey: nil, keyType: nil,
          fingerprint: nil, comment: nil, keySize: nil,
          softwareName: nil, licenseKey: nil, version: nil, licensee: nil,
          relyingPartyId: nil, relyingPartyName: nil,
          credentialId: nil, creationDate: nil, deviceInfo: nil
        )
      ),
      // 4. IDENTITY — Alice Identity
      FixtureEntry(
        id: "a4000000-0000-0000-0000-000000000004",
        entryType: "IDENTITY",
        isFavorite: false,
        overview: OverviewBlob(
          title: "Alice Identity", username: nil, urlHost: nil, tags: [],
          hasTOTP: nil, relyingPartyId: nil, credentialId: nil
        ),
        full: FullBlob(
          title: "Alice Identity",
          username: nil, password: nil, url: nil, notes: nil, tags: [], totp: nil,
          content: nil, isMarkdown: nil,
          cardholderName: nil, cardNumber: nil, brand: nil,
          expiryMonth: nil, expiryYear: nil, cvv: nil,
          fullName: "Alice Example",
          givenName: "Alice",
          familyName: "Example",
          email: "alice@example.com",
          phone: "+1-555-0100",
          bankName: nil, accountType: nil, accountHolderName: nil,
          accountNumber: nil, routingNumber: nil,
          privateKey: nil, publicKey: nil, keyType: nil,
          fingerprint: nil, comment: nil, keySize: nil,
          softwareName: nil, licenseKey: nil, version: nil, licensee: nil,
          relyingPartyId: nil, relyingPartyName: nil,
          credentialId: nil, creationDate: nil, deviceInfo: nil
        )
      ),
      // 5. PASSKEY — GitHub Passkey
      FixtureEntry(
        id: "a5000000-0000-0000-0000-000000000005",
        entryType: "PASSKEY",
        isFavorite: false,
        overview: OverviewBlob(
          title: "GitHub Passkey",
          username: "alice@example.com",
          urlHost: "github.com",
          tags: [],
          hasTOTP: nil,
          relyingPartyId: "github.com",
          credentialId: "Y3JlZEV4YW1wbGU"
        ),
        full: FullBlob(
          title: "GitHub Passkey",
          username: "alice@example.com",
          password: nil, url: nil, notes: nil, tags: [], totp: nil,
          content: nil, isMarkdown: nil,
          cardholderName: nil, cardNumber: nil, brand: nil,
          expiryMonth: nil, expiryYear: nil, cvv: nil,
          fullName: nil, givenName: nil, familyName: nil,
          email: nil, phone: nil,
          bankName: nil, accountType: nil, accountHolderName: nil,
          accountNumber: nil, routingNumber: nil,
          privateKey: nil, publicKey: nil, keyType: nil,
          fingerprint: nil, comment: nil, keySize: nil,
          softwareName: nil, licenseKey: nil, version: nil, licensee: nil,
          relyingPartyId: "github.com",
          relyingPartyName: "GitHub",
          credentialId: "Y3JlZEV4YW1wbGU",
          creationDate: "2024-01-01",
          deviceInfo: "iPhone"
        )
      ),
      // 6. SECURE_NOTE — VPN Recovery Notes
      FixtureEntry(
        id: "a6000000-0000-0000-0000-000000000006",
        entryType: "SECURE_NOTE",
        isFavorite: false,
        overview: OverviewBlob(
          title: "VPN Recovery Notes", username: nil, urlHost: nil, tags: [],
          hasTOTP: nil, relyingPartyId: nil, credentialId: nil
        ),
        full: FullBlob(
          title: "VPN Recovery Notes",
          username: nil, password: nil, url: nil, notes: nil, tags: [], totp: nil,
          content: "Sample secure note for demo.",
          isMarkdown: false,
          cardholderName: nil, cardNumber: nil, brand: nil,
          expiryMonth: nil, expiryYear: nil, cvv: nil,
          fullName: nil, givenName: nil, familyName: nil,
          email: nil, phone: nil,
          bankName: nil, accountType: nil, accountHolderName: nil,
          accountNumber: nil, routingNumber: nil,
          privateKey: nil, publicKey: nil, keyType: nil,
          fingerprint: nil, comment: nil, keySize: nil,
          softwareName: nil, licenseKey: nil, version: nil, licensee: nil,
          relyingPartyId: nil, relyingPartyName: nil,
          credentialId: nil, creationDate: nil, deviceInfo: nil
        )
      ),
      // 7. BANK_ACCOUNT — Acme Savings
      FixtureEntry(
        id: "a7000000-0000-0000-0000-000000000007",
        entryType: "BANK_ACCOUNT",
        isFavorite: false,
        overview: OverviewBlob(
          title: "Acme Savings", username: nil, urlHost: nil, tags: [],
          hasTOTP: nil, relyingPartyId: nil, credentialId: nil
        ),
        full: FullBlob(
          title: "Acme Savings",
          username: nil, password: nil, url: nil, notes: nil, tags: [], totp: nil,
          content: nil, isMarkdown: nil,
          cardholderName: nil, cardNumber: nil, brand: nil,
          expiryMonth: nil, expiryYear: nil, cvv: nil,
          fullName: nil, givenName: nil, familyName: nil,
          email: nil, phone: nil,
          bankName: "Acme Bank",
          accountType: "Savings",
          accountHolderName: "Alice Example",
          accountNumber: "000123456",
          routingNumber: "110000000",
          privateKey: nil, publicKey: nil, keyType: nil,
          fingerprint: nil, comment: nil, keySize: nil,
          softwareName: nil, licenseKey: nil, version: nil, licensee: nil,
          relyingPartyId: nil, relyingPartyName: nil,
          credentialId: nil, creationDate: nil, deviceInfo: nil
        )
      ),
      // 8. SOFTWARE_LICENSE — Adobe License
      FixtureEntry(
        id: "a8000000-0000-0000-0000-000000000008",
        entryType: "SOFTWARE_LICENSE",
        isFavorite: false,
        overview: OverviewBlob(
          title: "Adobe License", username: nil, urlHost: nil, tags: [],
          hasTOTP: nil, relyingPartyId: nil, credentialId: nil
        ),
        full: FullBlob(
          title: "Adobe License",
          username: nil, password: nil, url: nil, notes: nil, tags: [], totp: nil,
          content: nil, isMarkdown: nil,
          cardholderName: nil, cardNumber: nil, brand: nil,
          expiryMonth: nil, expiryYear: nil, cvv: nil,
          fullName: nil, givenName: nil, familyName: nil,
          email: "alice@example.com", phone: nil,
          bankName: nil, accountType: nil, accountHolderName: nil,
          accountNumber: nil, routingNumber: nil,
          privateKey: nil, publicKey: nil, keyType: nil,
          fingerprint: nil, comment: nil, keySize: nil,
          softwareName: "Adobe CC",
          licenseKey: "EXAMPLE-1234-5678-9ABC",
          version: "2026",
          licensee: "Alice Example",
          relyingPartyId: nil, relyingPartyName: nil,
          credentialId: nil, creationDate: nil, deviceInfo: nil
        )
      ),
      // 9. SSH_KEY — Deploy Key (keySize as a JSON NUMBER to match web client)
      FixtureEntry(
        id: "a9000000-0000-0000-0000-000000000009",
        entryType: "SSH_KEY",
        isFavorite: false,
        overview: OverviewBlob(
          title: "Deploy Key", username: nil, urlHost: nil, tags: [],
          hasTOTP: nil, relyingPartyId: nil, credentialId: nil
        ),
        full: FullBlob(
          title: "Deploy Key",
          username: nil, password: nil, url: nil, notes: nil, tags: [], totp: nil,
          content: nil, isMarkdown: nil,
          cardholderName: nil, cardNumber: nil, brand: nil,
          expiryMonth: nil, expiryYear: nil, cvv: nil,
          fullName: nil, givenName: nil, familyName: nil,
          email: nil, phone: nil,
          bankName: nil, accountType: nil, accountHolderName: nil,
          accountNumber: nil, routingNumber: nil,
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\n(demo only)\n-----END OPENSSH PRIVATE KEY-----",
          publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample",
          keyType: "ed25519",
          fingerprint: "SHA256:exampleexample",
          comment: "alice@example.com",
          keySize: 256,
          softwareName: nil, licenseKey: nil, version: nil, licensee: nil,
          relyingPartyId: nil, relyingPartyName: nil,
          credentialId: nil, creationDate: nil, deviceInfo: nil
        )
      ),
    ]
  }
  // swiftlint:enable function_body_length

  // MARK: - Private helpers

  private static func buildDemoEntries(
    vaultKey: SymmetricKey,
    userId: String
  ) throws -> [CacheEntry] {
    let encoder = JSONEncoder()
    return try fixtures().map { fixture in
      let entryId = fixture.id

      let blobAAD = try buildPersonalEntryAAD(
        userId: userId, entryId: entryId, vaultType: VaultType.blob)
      let overviewAAD = try buildPersonalEntryAAD(
        userId: userId, entryId: entryId, vaultType: VaultType.overview)

      let overviewData = try encoder.encode(fixture.overview)
      let blobData = try encoder.encode(fixture.full)

      let overviewEncrypted = try encryptAESGCMEncoded(
        plaintext: overviewData, key: vaultKey, aad: overviewAAD)
      let blobEncrypted = try encryptAESGCMEncoded(
        plaintext: blobData, key: vaultKey, aad: blobAAD)

      return CacheEntry(
        id: entryId,
        teamId: nil,
        aadVersion: 1,
        keyVersion: 1,
        teamKeyVersion: nil,
        itemKeyVersion: nil,
        encryptedItemKey: nil,
        encryptedBlob: blobEncrypted,
        encryptedOverview: overviewEncrypted,
        entryType: fixture.entryType,
        isFavorite: fixture.isFavorite
      )
    }
  }
}
