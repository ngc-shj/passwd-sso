import Foundation

/// Decides the TOTP code (if any) to auto-copy after a login fill. Pure and
/// best-effort: returns nil when disabled, when the entry has no TOTP, or when
/// code generation fails (a bad secret must never block the password fill).
public func totpToCopy(detail: VaultEntryDetail, autoCopy: Bool, now: Date = Date()) -> String? {
  guard autoCopy, let secret = detail.totpSecret else { return nil }
  return try? generateTOTPCode(
    params: TOTPParams(
      secret: secret,
      algorithm: detail.totpAlgorithm,
      digits: detail.totpDigits,
      period: detail.totpPeriod
    ),
    at: now
  )
}
