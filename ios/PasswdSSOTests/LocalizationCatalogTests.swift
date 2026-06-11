import XCTest

/// Guards against shipping an untranslated UI string — the realistic i18n
/// regression. Parses each source `Localizable.xcstrings` and asserts every
/// non-`shouldTranslate:false` key has a complete, `translated` Japanese unit.
final class LocalizationCatalogTests: XCTestCase {
  // Resolve the repo `ios/` directory from this test file's own source path,
  // then read the SOURCE catalogs directly. A raw `.xcstrings` added to the
  // test bundle's resources is COMPILED (not copied verbatim), so
  // `url(forResource:withExtension:"xcstrings")` would return nil — reading the
  // committed source is the deterministic path. Caveat: relies on the simulator
  // sharing the host filesystem (true for this project's CI, which runs
  // `xcodebuild test` on a simulator; would need a verbatim resource copy for a
  // physical-device runner).
  private func iosDirectory() -> URL {
    URL(filePath: #filePath)        // …/ios/PasswdSSOTests/LocalizationCatalogTests.swift
      .deletingLastPathComponent()  // …/ios/PasswdSSOTests
      .deletingLastPathComponent()  // …/ios
  }

  func testHostCatalogHasJapaneseForEveryKey() throws {
    try assertFullJapaneseCoverage(in: "PasswdSSOApp/Localizable.xcstrings")
  }

  func testExtensionCatalogHasJapaneseForEveryKey() throws {
    try assertFullJapaneseCoverage(in: "PasswdSSOAutofillExtension/Localizable.xcstrings")
  }

  /// The build actually compiled a `ja` localization into the host bundle.
  /// Guards the xcodegen region-derivation risk (C1): a regression that drops
  /// `ja` from `knownRegions` fails here instead of shipping silently. Covers
  /// the host bundle only — the extension `.appex` is a separate bundle not
  /// reachable via `Bundle.main`; its source completeness is covered above.
  func testHostBundleCompiledJapanese() {
    XCTAssertTrue(
      Bundle.main.localizations.contains("ja"),
      "Host app bundle did not compile a `ja` localization — xcodegen region "
        + "derivation may have dropped it from knownRegions"
    )
  }

  // MARK: - Coverage assertion

  private func assertFullJapaneseCoverage(in relativePath: String) throws {
    let url = iosDirectory().appending(path: relativePath)
    let data = try Data(contentsOf: url)
    let catalog = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: data) as? [String: Any],
      "\(relativePath) is not a JSON object"
    )
    let strings = try XCTUnwrap(
      catalog["strings"] as? [String: Any], "\(relativePath) missing `strings`"
    )

    var problems: [String] = []
    for (key, raw) in strings {
      guard let entry = raw as? [String: Any] else {
        problems.append("\(key) (malformed entry)")
        continue
      }
      // Brand / Apple product / example-URL / DEBUG keys are intentionally
      // not translated — skip them (and tolerate a future IDE auto-extraction
      // re-adding them with shouldTranslate:false).
      if entry["shouldTranslate"] as? Bool == false { continue }

      let localizations = entry["localizations"] as? [String: Any] ?? [:]

      // Source `en`: presence only — auto-extracted source units often omit `state`.
      if let problem = sourceProblem(in: localizations) {
        problems.append("\(key) [en: \(problem)]")
      }
      // Target `ja`: present, non-empty, state == "translated".
      if let problem = targetProblem(in: localizations, language: "ja") {
        problems.append("\(key) [ja: \(problem)]")
      }
    }

    XCTAssertTrue(
      problems.isEmpty,
      "\(relativePath): \(problems.count) key(s) with incomplete translation:\n - "
        + problems.sorted().joined(separator: "\n - ")
    )
  }

  // MARK: - Per-entry shape branching

  private func sourceProblem(in localizations: [String: Any]) -> String? {
    guard let en = localizations["en"] as? [String: Any] else { return "missing" }
    if let unit = en["stringUnit"] as? [String: Any] {
      return (unit["value"] as? String).map { $0.isEmpty ? "empty value" : nil } ?? "empty value"
    }
    if let plural = pluralVariation(of: en) {
      // English count distinction: require both `one` and `other`.
      for category in ["one", "other"] where pluralValue(plural, category) == nil {
        return "plural missing `\(category)`"
      }
      return nil
    }
    return "no stringUnit or plural variation"
  }

  private func targetProblem(in localizations: [String: Any], language: String) -> String? {
    guard let loc = localizations[language] as? [String: Any] else { return "missing" }
    if let unit = loc["stringUnit"] as? [String: Any] {
      return translatedUnitProblem(unit)
    }
    if let plural = pluralVariation(of: loc) {
      // Japanese has no count distinction — only `other` is required.
      guard let other = plural["other"] as? [String: Any],
            let unit = other["stringUnit"] as? [String: Any] else {
        return "plural missing `other`"
      }
      return translatedUnitProblem(unit)
    }
    return "no stringUnit or plural variation"
  }

  // MARK: - Primitives

  private func pluralVariation(of localization: [String: Any]) -> [String: Any]? {
    (localization["variations"] as? [String: Any])?["plural"] as? [String: Any]
  }

  private func pluralValue(_ plural: [String: Any], _ category: String) -> String? {
    guard let unit = (plural[category] as? [String: Any])?["stringUnit"] as? [String: Any],
          let value = unit["value"] as? String, !value.isEmpty else { return nil }
    return value
  }

  private func translatedUnitProblem(_ unit: [String: Any]) -> String? {
    let value = unit["value"] as? String ?? ""
    if value.isEmpty { return "empty value" }
    let state = unit["state"] as? String
    if state != "translated" { return "state == \(state ?? "nil")" }
    return nil
  }
}
