import Foundation

/// App marketing-version display for the Settings screen (FR5).
///
/// The testable seam is the injectable `marketing`/`build` STRING parameters,
/// NOT a `Bundle` (T1): `Bundle` has no public initializer accepting an
/// arbitrary `infoDictionary`, so a synthetic `Bundle` with known version keys
/// cannot be built in XCTest. The default arguments read the real
/// `Bundle.main` Info.plist in production; tests pass explicit strings.
public struct AppVersion {
  /// Defaults read the real Bundle.main Info.plist; tests pass explicit values.
  public static func display(
    marketing: String? = infoValue("CFBundleShortVersionString"),
    build: String? = infoValue("CFBundleVersion")
  ) -> String {
    switch (marketing, build) {
    case let (m?, b?): return "\(m) (\(b))"
    case let (m?, nil): return m
    case let (nil, b?): return b
    case (nil, nil): return "—"
    }
  }

  public static func infoValue(_ key: String) -> String? {
    Bundle.main.object(forInfoDictionaryKey: key) as? String
  }
}
