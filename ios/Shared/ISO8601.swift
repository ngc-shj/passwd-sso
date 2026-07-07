import Foundation

/// Server emits `Date.toISOString()` (fractional seconds); a plain
/// ISO8601DateFormatter does NOT parse those, so try both variants. Never
/// throws — an unparseable string returns nil so a bad date can never break a
/// decode/sync pipeline.
public func parseISO8601(_ string: String) -> Date? {
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let date = fractional.date(from: string) { return date }
  return ISO8601DateFormatter().date(from: string)
}
