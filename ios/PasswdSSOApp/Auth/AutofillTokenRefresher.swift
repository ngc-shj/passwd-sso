import Foundation
import OSLog
import Shared

/// Mints the short-lived, jkt-bound AutoFill upload token and stages it (plus
/// the host's current DPoP nonce, S5) in the shared-Keychain UploadTokenStore
/// for the extension's passkey-registration upload (plan C6).
///
/// Best-effort by design: minting runs after unlock and on each foreground
/// sync; a failure must never break unlock/sync — the extension treats a
/// missing/expired token as a clean cancel (fall-through to iCloud Keychain),
/// not a lockout.
public struct AutofillTokenRefresher: Sendable {
  private static let log = Logger(subsystem: "jp.jpng.passwd-sso", category: "autofill-token")

  private let apiClient: MobileAPIClient
  private let uploadTokenStore: UploadTokenStore
  private let hostTokenStore: HostTokenStore
  /// Injectable for tests (production = the shared-group SE key).
  private let extensionJWKProvider: @Sendable () throws -> [String: String]

  public init(
    apiClient: MobileAPIClient,
    uploadTokenStore: UploadTokenStore = UploadTokenStore(),
    hostTokenStore: HostTokenStore = HostTokenStore(),
    extensionJWKProvider: @escaping @Sendable () throws -> [String: String] = {
      try exportPublicKeyJWK(key: getOrCreateAutofillDPoPKey())
    }
  ) {
    self.apiClient = apiClient
    self.uploadTokenStore = uploadTokenStore
    self.hostTokenStore = hostTokenStore
    self.extensionJWKProvider = extensionJWKProvider
  }

  /// Mint + stage. Never throws — see type comment.
  public func refresh() async {
    do {
      let jwk = try extensionJWKProvider()
      let response = try await apiClient.mintAutofillToken(extensionJWK: jwk)
      guard let expiresAt = Self.parseISO8601(response.expiresAt) else {
        Self.log.error("autofill-token refresh: unparseable expiresAt")
        return
      }
      // Stage the host's freshest DPoP nonce next to the token so the
      // extension's first proof doesn't force a 401-retry (S5; non-secret).
      let nonce = try? hostTokenStore.loadNonce()
      try uploadTokenStore.save(token: response.token, expiresAt: expiresAt, dpopNonce: nonce)
    } catch {
      // No token data in MobileAPIError cases — safe to log the case name.
      Self.log.error("autofill-token refresh failed: \(String(describing: error), privacy: .public)")
    }
  }

  /// Server emits `Date.toISOString()` (fractional seconds); a plain
  /// ISO8601DateFormatter does NOT parse those, so try both variants.
  static func parseISO8601(_ string: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: string) { return date }
    return ISO8601DateFormatter().date(from: string)
  }
}
