import Foundation

/// Server error codes (`{"error":"<CODE>"}`) the iOS clients act on. The HTTP
/// status alone is ambiguous — a 403 can mean a missing passkey, an exhausted
/// quota, an undistributed team key, or a plain authorization refusal — so
/// every 4xx mapping keys off the body code.
public enum APIErrorCode {
  /// The tenant requires a passkey and this member has none (after the grace
  /// period). Bearer calls are refused until one is registered on the web.
  public static let passkeyRequired = "PASSKEY_REQUIRED"
  public static let quotaExceeded = "QUOTA_EXCEEDED"
}

/// Minimal error envelope. Extra fields (resource/current/max, details) are
/// ignored by JSONDecoder.
private struct APIErrorEnvelope: Decodable {
  let error: String
}

/// The `error` code of a server error body, or nil when the body is empty,
/// malformed, or not the canonical envelope.
public func apiErrorCode(from body: Data) -> String? {
  (try? JSONDecoder().decode(APIErrorEnvelope.self, from: body))?.error
}

/// True for the server's passkey-requirement refusal: 403 carrying
/// `PASSKEY_REQUIRED`. Any other 403 keeps its own meaning.
public func isPasskeyRequiredResponse(status: Int, body: Data) -> Bool {
  status == 403 && apiErrorCode(from: body) == APIErrorCode.passkeyRequired
}
