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
  private static let log = Logger(subsystem: AppGroupContainer.loggerSubsystem, category: "autofill-token")

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
      // Diagnostic only: emit a FIXED, non-secret label per known failure mode so
      // the "refresh failed" symptom can be triaged from Console.app —
      // authenticationRequired (expected: session lapsed while backgrounded) vs.
      // dpopInvalid (nonce desync) vs. serverError(5xx) (a real server fault).
      // The label set is hardcoded; associated values are NEVER interpolated
      // except the plain HTTP status / rate-limit bucket, which carry no secret.
      Self.log.error("autofill-token refresh failed: \(Self.diagnosticSummary(for: error), privacy: .public)")
    }
  }

  /// Maps an error to a stable, secret-free label for logging. For a
  /// `MobileAPIError` it names the case (plus the HTTP status for `serverError`);
  /// any other error falls back to its type name only — never its value, which
  /// could carry a URL / response body / internal state.
  static func diagnosticSummary(for error: Error) -> String {
    guard let apiError = error as? MobileAPIError else {
      return "other(\(type(of: error)))"
    }
    switch apiError {
    case .bridgeCodeInvalid: return "bridgeCodeInvalid"
    case .pkceMismatch: return "pkceMismatch"
    case .dpopInvalid: return "dpopInvalid"  // nonce intentionally omitted
    case .rateLimited: return "rateLimited"
    case .notFound: return "notFound"
    case .quotaExceeded: return "quotaExceeded"
    case .teamKeyNotDistributed: return "teamKeyNotDistributed"
    case .serverError(let status): return "serverError(\(status))"
    case .networkError(let urlError): return "networkError(\(urlError.code.rawValue))"
    case .authenticationRequired: return "authenticationRequired"
    }
  }

  /// Forwards to the relocated `parseISO8601(_:)` free function in `Shared`
  /// (dual fractional/plain ISO-8601 parse). Kept as a static method so
  /// existing call sites (`Self.parseISO8601` above, and tests) don't need to
  /// change; delegates to the file-scope `callSharedParseISO8601` shim below
  /// because a same-named static method shadows the free function for
  /// unqualified lookup within its own body, and `Shared` also declares a
  /// type named `Shared` that shadows the module name for qualified lookup.
  static func parseISO8601(_ string: String) -> Date? {
    callSharedParseISO8601(string)
  }
}

/// File-scope shim resolving the `Shared` module's free function unambiguously
/// (see comment on `AutofillTokenRefresher.parseISO8601` above).
private func callSharedParseISO8601(_ string: String) -> Date? {
  parseISO8601(string)
}
