import Foundation
import XCTest
@testable import Shared

// MARK: - C2 CustomFieldKind.rowKind mapping

/// Security-relevant unit test for CustomFieldKind.rowKind. The hidden→.masked
/// branch is the critical primitive: a remap to .plain would show a secret
/// unmasked (S3-sec regression). Red-capable for hidden (removing the .masked
/// case makes the test fail immediately).
final class CustomFieldKindRowKindTests: XCTestCase {

  func testAllSixTypesAndOneUnknown() {
    // hidden → .masked (security-critical: must never be .plain)
    XCTAssertEqual(VaultEntryDetail.CustomFieldKind.hidden.rowKind, .masked)
    // url → .url
    XCTAssertEqual(VaultEntryDetail.CustomFieldKind.url.rowKind, .url)
    // boolean → .boolean
    XCTAssertEqual(VaultEntryDetail.CustomFieldKind.boolean.rowKind, .boolean)
    // text → .plain
    XCTAssertEqual(VaultEntryDetail.CustomFieldKind.text.rowKind, .plain)
    // date → .plain (formatting is a C3 concern; rowKind only decides mask/plain/url/boolean)
    XCTAssertEqual(VaultEntryDetail.CustomFieldKind.date.rowKind, .plain)
    // monthYear → .plain
    XCTAssertEqual(VaultEntryDetail.CustomFieldKind.monthYear.rowKind, .plain)
    // unknown future type → falls through to .text (rawValue init fails) → kind == .text → .plain
    let unknownKind = VaultEntryDetail.CustomFieldKind(rawValue: "totp-unknown-future")
    XCTAssertNil(unknownKind, "unrecognized rawValue must return nil so consumers use fail-open .text")
  }

  func testKindFailOpenOnUnknownType() {
    // A CustomField with an unknown type string → kind == .text (fail-open)
    let field = VaultEntryDetail.CustomField(id: 0, label: "X", value: "v", type: "future-x")
    XCTAssertEqual(field.kind, .text)
    XCTAssertEqual(field.kind.rowKind, .plain)
  }
}

// MARK: - C5 customFieldToCopy truth table

/// Pure unit tests for customFieldToCopy(detail:autoCopy:totpWillCopy:).
/// Uses @testable import Shared so it can access the free function declared
/// in CustomFieldAutoCopy.swift (a Shared module file).
final class CustomFieldAutoCopyTests: XCTestCase {

  // Helper: build a VaultEntryDetail with optional custom fields. entryType nil
  // (the default) means LOGIN per the app-wide convention.
  private func detail(
    customFields: [VaultEntryDetail.CustomField] = [],
    entryType: String? = nil
  ) -> VaultEntryDetail {
    VaultEntryDetail(
      id: "e1", title: "T", username: "u", urlHost: "example.com",
      password: "pw", url: "", entryType: entryType, customFields: customFields
    )
  }

  private func field(_ label: String, _ value: String, _ type: String, id: Int = 0) -> VaultEntryDetail.CustomField {
    VaultEntryDetail.CustomField(id: id, label: label, value: value, type: type)
  }

  func testAutoCopyFalseReturnsNilRegardlessOfFields() {
    let d = detail(customFields: [field("PIN", "1234", "text")])
    XCTAssertNil(customFieldToCopy(detail: d, autoCopy: false, totpWillCopy: false))
  }

  func testZeroFieldsReturnsNil() {
    XCTAssertNil(customFieldToCopy(detail: detail(), autoCopy: true, totpWillCopy: false))
  }

  func testTwoFieldsReturnsNil() {
    let d = detail(customFields: [
      field("A", "1", "text", id: 0),
      field("B", "2", "text", id: 1),
    ])
    XCTAssertNil(customFieldToCopy(detail: d, autoCopy: true, totpWillCopy: false))
  }

  func testSingleTextField_totpWillCopyFalse_returnsValue() {
    let d = detail(customFields: [field("Recovery", "abc123", "text")])
    XCTAssertEqual(customFieldToCopy(detail: d, autoCopy: true, totpWillCopy: false), "abc123")
  }

  // Arbitration (red-capable, T2): hold detail fixed (1 text field, autoCopy=true)
  // and assert the totpWillCopy=true half returns nil. The contrasting
  // false→value half is already covered by testSingleTextField_totpWillCopyFalse_returnsValue
  // above (same fixture), so the pair is: that test + this one. Removing the
  // `!totpWillCopy` guard flips this case → red.
  func testArbitration_totpWillCopyTrue_returnsNil() {
    let d = detail(customFields: [field("Recovery", "abc123", "text")])
    XCTAssertNil(customFieldToCopy(detail: d, autoCopy: true, totpWillCopy: true))
  }

  // Hidden exclusion (red-capable, S1): a single hidden field must NEVER be auto-copied.
  // Removing the `kind != .hidden` guard makes this fail (→ red).
  func testHiddenField_returnsNil() {
    let d = detail(customFields: [field("API Secret", "tok_abc", "hidden")])
    XCTAssertNil(customFieldToCopy(detail: d, autoCopy: true, totpWillCopy: false))
  }

  // Boolean exclusion (red-capable, F3): a single boolean field must NOT be
  // auto-copied — the detail view treats booleans as non-copyable, so a bare
  // "true"/"false" on the clipboard would be inconsistent. Removing the
  // `kind != .boolean` guard makes this fail (→ red).
  func testBooleanField_returnsNil() {
    let d = detail(customFields: [field("Active", "true", "boolean")])
    XCTAssertNil(customFieldToCopy(detail: d, autoCopy: true, totpWillCopy: false))
  }

  func testUrlFieldIsNotHidden_returnsValue() {
    // url type is not hidden → should be returned
    let d = detail(customFields: [field("Portal", "https://portal.example", "url")])
    XCTAssertEqual(
      customFieldToCopy(detail: d, autoCopy: true, totpWillCopy: false),
      "https://portal.example"
    )
  }

  // LOGIN-type boundary (red-capable): a non-LOGIN entry reachable via the
  // password fill path must NOT auto-copy a custom field to the foreground app's
  // clipboard. Removing the `entryType == nil || == "LOGIN"` guard flips this → red.
  func testNonLoginEntry_returnsNil() {
    let d = detail(
      customFields: [field("Recovery", "abc123", "text")], entryType: "SECURE_NOTE")
    XCTAssertNil(customFieldToCopy(detail: d, autoCopy: true, totpWillCopy: false))
  }

  func testExplicitLoginType_returnsValue() {
    let d = detail(
      customFields: [field("Recovery", "abc123", "text")], entryType: "LOGIN")
    XCTAssertEqual(customFieldToCopy(detail: d, autoCopy: true, totpWillCopy: false), "abc123")
  }

  func testNilEntryTypeTreatedAsLogin_returnsValue() {
    // entryType nil ⇒ LOGIN (personal blobs omit the type).
    let d = detail(customFields: [field("Recovery", "abc123", "text")], entryType: nil)
    XCTAssertEqual(customFieldToCopy(detail: d, autoCopy: true, totpWillCopy: false), "abc123")
  }
}
