import Foundation

/// Drains MAC-protected rollback flags written by the AutoFill extension.
///
/// TODO (Step 11): implement real flag drain — read flag from App Group, verify HMAC-SHA256
/// under HKDF(vault_key, info="rollback-flag-mac"), POST to /api/mobile/cache-rollback-report.
/// Forged flags (MAC mismatch) emit MOBILE_CACHE_FLAG_FORGED audit event instead of posting.
///
/// The schema for the flag JSON:
///   { "expectedCounter": UInt64, "observedCounter": UInt64,
///     "headerIssuedAt": Int, "rejectionKind": String, "mac": String (hex) }
public actor RollbackFlagDrain {
  public init() {}

  /// No-op stub — real implementation arrives in Step 11.
  public func drainPendingFlags() async {
    // Step 11 will fill in: read flag file, verify HMAC, POST to server.
  }
}
