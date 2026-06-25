import Foundation

/// Website-URL analog of the web `isSafeHref` A03-1 self-XSS guard, scoped to
/// http/https. Returns a launchable URL only when the string parses, is within a
/// sane length bound, and its scheme (lowercased, like `extractHost`) is http or
/// https. No scheme is prepended, so "example.com" returns nil and is rendered as
/// plain text — matching the web view's reject-and-show-as-text behavior.
///
/// Deliberately narrower than web `safe-href.ts` (which also allows `mailto:` for
/// generic href contexts): a login entry's URL field is a website address, never an
/// email, and excluding `mailto:`/`tel:`/custom schemes shrinks the iOS launch
/// surface. Parity vectors live in `PasswdSSOTests/SafeURLTests.swift`; the SSoT for
/// the rejection set is web `src/lib/security/safe-href.test.ts` (note the no-mailto
/// divergence — do NOT "fix" the iOS tests to accept mailto).
public enum SafeURL {
  /// Upper bound on the raw string length before parsing. Real website URLs with
  /// query params stay well under this; an over-long value falls back to plain text.
  static let maxLength = 2048

  public static func launchable(_ raw: String) -> URL? {
    guard raw.count <= maxLength,
          let url = URL(string: raw),
          let scheme = url.scheme?.lowercased(),
          scheme == "http" || scheme == "https"
    else {
      return nil
    }
    return url
  }
}
