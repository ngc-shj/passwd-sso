import Foundation
import Security

// Per plan §"Shared Storage Contract":
// access_token, refresh_token, dpop_nonce → per-app Keychain ONLY.
// NO shared access group, NO biometric ACL (host app reads on every foreground).
// kSecAttrAccessibleWhenUnlockedThisDeviceOnly, Synchronizable=false.

/// Stores iOS access/refresh tokens and the last DPoP-Nonce in the per-app Keychain.
public final class HostTokenStore: Sendable {

  public enum Error: Swift.Error, Equatable {
    case keychainError(OSStatus)
    case decodeFailed
  }

  private let service: String
  private let keychain: KeychainAccessor

  private enum Account: String {
    case accessToken = "access_token"
    case refreshToken = "refresh_token"
    case dpopNonce = "dpop_nonce"
    // Stores access-token expiry as ISO-8601 string alongside the token.
    case accessTokenExpiry = "access_token_expiry"
  }

  public init(
    service: String = "com.passwd-sso.host-tokens",
    keychain: KeychainAccessor = SystemKeychainAccessor()
  ) {
    self.service = service
    self.keychain = keychain
  }

  // MARK: - Token lifecycle

  public func saveTokens(access: String, refresh: String, expiresAt: Date) throws {
    let expiryString = ISO8601DateFormatter().string(from: expiresAt)
    try save(string: access, account: .accessToken)
    try save(string: refresh, account: .refreshToken)
    try save(string: expiryString, account: .accessTokenExpiry)
  }

  public func loadAccess() throws -> (token: String, expiresAt: Date)? {
    guard let token = try loadString(account: .accessToken) else { return nil }
    guard let expiryString = try loadString(account: .accessTokenExpiry) else { return nil }
    guard let expiresAt = ISO8601DateFormatter().date(from: expiryString) else {
      throw Error.decodeFailed
    }
    return (token, expiresAt)
  }

  public func loadRefresh() throws -> String? {
    try loadString(account: .refreshToken)
  }

  // MARK: - Nonce

  public func saveNonce(_ nonce: String) throws {
    try save(string: nonce, account: .dpopNonce)
  }

  public func loadNonce() throws -> String? {
    try loadString(account: .dpopNonce)
  }

  // MARK: - Delete

  public func deleteAll() throws {
    for account in [Account.accessToken, .refreshToken, .dpopNonce, .accessTokenExpiry] {
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
      // Per-app Keychain: no kSecAttrAccessGroup — host app only.
      kSecAttrSynchronizable as String: false,
    ]
  }

  private func save(string: String, account: Account) throws {
    guard let data = string.data(using: .utf8) else { throw Error.decodeFailed }
    var query = baseQuery(account: account)
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly

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
