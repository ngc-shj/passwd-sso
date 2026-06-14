import Foundation
import Security

// Per plan C5: the short-lived AutoFill upload token (passkey registration)
// crosses the host→extension boundary, so it lives in the DEFAULT keychain
// access group (the single `$(AppIdentifierPrefix)…shared` entitlement on both
// targets — an explicit literal group fails with errSecMissingEntitlement on
// device, see BridgeKeyStore.baseQuery).
//
// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly (S6, deliberately NOT
// WhenUnlocked): the extension may be invoked while the device transitions
// lock states mid-ceremony; the token is already short-lived (~5 min server
// TTL), write-only scoped, and DPoP-bound, so the wider accessibility window
// adds no replay value without the Secure Enclave key. NO biometric ACL — the
// no-lockout path must distinguish "no token" (cancel, fall through to iCloud
// Keychain) from "biometry refused" without a second prompt.

/// Stores the host-minted, DPoP-bound AutoFill upload token plus the staged
/// DPoP nonce (S5 — non-secret per RFC 9449; staging it avoids a guaranteed
/// 401-retry on the extension's first create).
public final class UploadTokenStore: Sendable {

  public enum Error: Swift.Error, Equatable {
    case keychainError(OSStatus)
    case decodeFailed
  }

  public struct StoredToken: Sendable, Equatable {
    public let token: String
    public let expiresAt: Date
    public let dpopNonce: String?

    public init(token: String, expiresAt: Date, dpopNonce: String?) {
      self.token = token
      self.expiresAt = expiresAt
      self.dpopNonce = dpopNonce
    }
  }

  private let service: String
  private let keychain: KeychainAccessor

  private enum Account: String {
    case token = "upload_token"
    case expiry = "upload_token_expiry"
    case dpopNonce = "upload_dpop_nonce"
  }

  public init(
    service: String = "com.passwd-sso.upload-token",
    keychain: KeychainAccessor = SystemKeychainAccessor()
  ) {
    self.service = service
    self.keychain = keychain
  }

  // MARK: - Save / load

  public func save(token: String, expiresAt: Date, dpopNonce: String?) throws {
    let expiryString = ISO8601DateFormatter().string(from: expiresAt)
    // Write order: expiry first, token last — a partial write must never leave
    // a fresh token paired with a stale (longer) expiry.
    try save(string: expiryString, account: .expiry)
    if let dpopNonce {
      try save(string: dpopNonce, account: .dpopNonce)
    } else {
      // Drop any nonce staged for a PREVIOUS token — a stale value would be
      // paired with the fresh token and only ever cost a 401-retry, but the
      // store must not present old state as current.
      let status = keychain.delete(query: baseQuery(account: .dpopNonce))
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw Error.keychainError(status)
      }
    }
    try save(string: token, account: .token)
  }

  /// The stored token, or nil when absent. Expiry is NOT checked here — use
  /// `loadValid(now:)` for the consumer path.
  public func load() throws -> StoredToken? {
    guard let token = try loadString(account: .token) else { return nil }
    guard let expiryString = try loadString(account: .expiry),
          let expiresAt = ISO8601DateFormatter().date(from: expiryString) else {
      throw Error.decodeFailed
    }
    let nonce = try loadString(account: .dpopNonce)
    return StoredToken(token: token, expiresAt: expiresAt, dpopNonce: nonce)
  }

  /// The stored token only while it is still valid at `now`; nil when absent
  /// or expired (the registration flow maps nil to a no-token cancel).
  public func loadValid(now: Date = Date()) throws -> StoredToken? {
    guard let stored = try load() else { return nil }
    guard stored.expiresAt > now else { return nil }
    return stored
  }

  // MARK: - Nonce

  /// Persist a fresh DPoP-Nonce the server issued during an upload, so the
  /// next proof (same ceremony or a later one) starts from the latest value.
  public func saveNonce(_ nonce: String) throws {
    try save(string: nonce, account: .dpopNonce)
  }

  // MARK: - Clear

  public func clear() throws {
    for account in [Account.token, .expiry, .dpopNonce] {
      let status = keychain.delete(query: baseQuery(account: account))
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw Error.keychainError(status)
      }
    }
  }

  // MARK: - Private helpers

  private func baseQuery(account: Account) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account.rawValue,
      // Default keychain access group == the app↔extension shared group.
      kSecAttrSynchronizable as String: false,
    ]
  }

  private func save(string: String, account: Account) throws {
    guard let data = string.data(using: .utf8) else { throw Error.decodeFailed }
    var query = baseQuery(account: account)
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = keychain.add(query: query)
    if status == errSecDuplicateItem {
      let updateStatus = keychain.update(
        query: baseQuery(account: account),
        attributes: [kSecValueData as String: data]
      )
      guard updateStatus == errSecSuccess else { throw Error.keychainError(updateStatus) }
    } else if status != errSecSuccess {
      throw Error.keychainError(status)
    }
  }

  private func loadString(account: Account) throws -> String? {
    var query = baseQuery(account: account)
    query[kSecReturnData as String] = true

    let (status, data) = keychain.copyMatching(query: query)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data else { throw Error.keychainError(status) }
    guard let string = String(data: data, encoding: .utf8) else { throw Error.decodeFailed }
    return string
  }
}
