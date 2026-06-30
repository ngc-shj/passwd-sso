import CryptoKit
import Foundation
import XCTest

@testable import Shared

// MARK: - PersonalEntryBlobBuilderTests

/// Locks the 10-case round-trip acceptance table from plan §C2.
/// Tests that distinguish null/bool fidelity MUST re-parse output via
/// JSONSerialization and assert on the raw value type — JSONDecoder coerces
/// JSON `1` → `true` and `null`/absent → `""`, masking NSNumber-bool pitfalls.
final class PersonalEntryBlobBuilderTests: XCTestCase {

  // MARK: - Case 1: CREATE all-fields → minimal blob (no tags/generatorSettings/hasTOTP/totp)

  func testBuildCreate_allFields_minimalBlob() throws {
    let fields = EditableEntryFields(
      title: "GitHub",
      username: "user@github.com",
      password: "gh-pass",
      url: "https://github.com",
      notes: "some notes",
      totpSecret: ""
    )
    let (blobData, overviewData) = try PersonalEntryBlobBuilder.buildCreate(fields: fields)

    let blobObj = try XCTUnwrap(JSONSerialization.jsonObject(with: blobData) as? [String: Any])
    let overviewObj = try XCTUnwrap(JSONSerialization.jsonObject(with: overviewData) as? [String: Any])

    // Blob keys: EXACTLY {title, username, password, url, notes}
    XCTAssertEqual(blobObj["title"] as? String, "GitHub")
    XCTAssertEqual(blobObj["username"] as? String, "user@github.com")
    XCTAssertEqual(blobObj["password"] as? String, "gh-pass")
    XCTAssertEqual(blobObj["url"] as? String, "https://github.com")
    XCTAssertEqual(blobObj["notes"] as? String, "some notes")
    XCTAssertNil(blobObj["tags"], "CREATE must not include tags key")
    XCTAssertNil(blobObj["generatorSettings"], "CREATE must not include generatorSettings key")
    XCTAssertNil(blobObj["totp"], "CREATE with no totpSecret must not include totp key")
    XCTAssertNil(blobObj["hasTOTP"], "CREATE with no totpSecret must not include hasTOTP key")

    // Overview keys: EXACTLY {title, username, urlHost}
    XCTAssertEqual(overviewObj["title"] as? String, "GitHub")
    XCTAssertEqual(overviewObj["username"] as? String, "user@github.com")
    XCTAssertEqual(overviewObj["urlHost"] as? String, "github.com")
    XCTAssertNil(overviewObj["tags"])
    XCTAssertNil(overviewObj["hasTOTP"])
  }

  // MARK: - Case 2: CREATE with totpSecret set → blob has totp object, overview has hasTOTP==true

  func testBuildCreate_withTotpSecret_blobHasTotpObject_overviewHasHasTOTP() throws {
    let fields = EditableEntryFields(
      title: "Example",
      username: "u",
      password: "p",
      url: "https://example.com",
      notes: "",
      totpSecret: "JBSWY3DPEHPK3PXP"
    )
    let (blobData, overviewData) = try PersonalEntryBlobBuilder.buildCreate(fields: fields)

    let blobObj = try XCTUnwrap(JSONSerialization.jsonObject(with: blobData) as? [String: Any])
    let overviewObj = try XCTUnwrap(JSONSerialization.jsonObject(with: overviewData) as? [String: Any])

    // totp must be an object (not a string).
    XCTAssertTrue(blobObj["totp"] is [String: Any], "totp must be a JSON object")
    let totp = blobObj["totp"] as! [String: Any]
    XCTAssertEqual(totp["secret"] as? String, "JBSWY3DPEHPK3PXP")

    // hasTOTP must be a proper JSON boolean true (not integer 1).
    XCTAssertEqual(overviewObj["hasTOTP"] as? Bool, true,
                   "hasTOTP must be JSON boolean true")
    // Guard NSNumber-bool pitfall: JSON `true` has CFBooleanGetTypeID(), JSON `1` does not.
    if let nsNum = overviewObj["hasTOTP"] as? NSNumber {
      XCTAssertTrue(CFGetTypeID(nsNum) == CFBooleanGetTypeID(),
                    "hasTOTP must NOT be integer (guards NSNumber-bool pitfall in case 9)")
    }
  }

  // MARK: - Case 3: EDIT preserving tags (vanishing-entry regression lock)

  func testApplyEdits_preservesTags_andGeneratorSettings_blobDecodesNonNil() throws {
    let generatorSettings: [String: Any] = ["length": 20, "useSymbols": true]
    let inputBlobObj: [String: Any] = [
      "title": "Old",
      "username": "old@example.com",
      "password": "oldpass",
      "url": "https://example.com",
      "tags": [["name": "work", "color": "#f00"]],
      "generatorSettings": generatorSettings,
    ]
    let inputOverviewObj: [String: Any] = [
      "title": "Old",
      "username": "old@example.com",
      "urlHost": "example.com",
    ]

    let blobData = try JSONSerialization.data(withJSONObject: inputBlobObj)
    let overviewData = try JSONSerialization.data(withJSONObject: inputOverviewObj)

    let fields = EditableEntryFields(
      title: "Old",
      username: "old@example.com",
      password: "newpassword",
      url: "https://example.com"
    )
    let (outBlobData, _) = try PersonalEntryBlobBuilder.applyEdits(
      blob: blobData, overview: overviewData, fields: fields)

    // (a) EntryBlobDecoder.detail must be non-nil (entry must not vanish).
    let vaultKey = SymmetricKey(size: .bits256)
    let blobAAD = try buildPersonalEntryAAD(userId: "u1", entryId: "e1", vaultType: VaultType.blob)
    let enc = try encryptAESGCMEncoded(plaintext: outBlobData, key: vaultKey, aad: blobAAD)
    let dec = try decryptAESGCMEncoded(encrypted: enc, key: vaultKey, aad: blobAAD)
    let detail = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: dec, entryId: "e1", teamId: nil),
      "EntryBlobDecoder.detail must be non-nil after edit (entry must not vanish)"
    )

    // (b) tags == ["work"] (TagPayload decode succeeded — the vanishing-entry regression).
    XCTAssertEqual(detail.tags, ["work"], "tags must survive the round-trip as [{name,color}] objects")

    // (c) password updated.
    XCTAssertEqual(detail.password, "newpassword")

    // (d) generatorSettings preserved: byte-equal via .sortedKeys.
    let outObj = try XCTUnwrap(JSONSerialization.jsonObject(with: outBlobData) as? [String: Any])
    let outGenSettings = try XCTUnwrap(outObj["generatorSettings"])
    let outGenData = try JSONSerialization.data(withJSONObject: outGenSettings, options: .sortedKeys)
    let inGenData = try JSONSerialization.data(withJSONObject: generatorSettings, options: .sortedKeys)
    XCTAssertEqual(outGenData, inGenData, "generatorSettings must be byte-equal (not just present)")
  }

  // MARK: - Case 4: EDIT preserving totp metadata (algorithm/digits/period)

  func testApplyEdits_preservesTotpMetadata_onSecretChange() throws {
    let inputBlobObj: [String: Any] = [
      "title": "Entry",
      "username": "u",
      "password": "p",
      "totp": ["secret": "A", "algorithm": "SHA256", "digits": 8, "period": 60],
    ]
    let inputOverviewObj: [String: Any] = ["title": "Entry", "username": "u", "urlHost": NSNull()]

    let blobData = try JSONSerialization.data(withJSONObject: inputBlobObj)
    let overviewData = try JSONSerialization.data(withJSONObject: inputOverviewObj)

    let fields = EditableEntryFields(
      title: "Entry", username: "u", password: "p", totpSecret: "B")
    let (outBlobData, _) = try PersonalEntryBlobBuilder.applyEdits(
      blob: blobData, overview: overviewData, fields: fields)

    let outObj = try XCTUnwrap(JSONSerialization.jsonObject(with: outBlobData) as? [String: Any])
    let totp = try XCTUnwrap(outObj["totp"] as? [String: Any])

    XCTAssertEqual(totp["secret"] as? String, "B")
    XCTAssertEqual(totp["algorithm"] as? String, "SHA256")
    // Numbers must stay numbers (not strings).
    XCTAssertEqual(totp["digits"] as? Int, 8, "digits must stay as Int")
    XCTAssertEqual(totp["period"] as? Int, 60, "period must stay as Int")
  }

  // MARK: - Case 5: EDIT clearing totp → no "totp" key in blob, no "hasTOTP" in overview

  func testApplyEdits_clearTotp_removesKeys() throws {
    let inputBlobObj: [String: Any] = [
      "title": "Entry", "username": "u", "password": "p",
      "totp": ["secret": "MYSECRET"],
    ]
    let inputOverviewObj: [String: Any] = [
      "title": "Entry", "username": "u", "urlHost": NSNull(), "hasTOTP": true,
    ]

    let blobData = try JSONSerialization.data(withJSONObject: inputBlobObj)
    let overviewData = try JSONSerialization.data(withJSONObject: inputOverviewObj)

    let fields = EditableEntryFields(
      title: "Entry", username: "u", password: "p", totpSecret: "")
    let (outBlobData, outOverviewData) = try PersonalEntryBlobBuilder.applyEdits(
      blob: blobData, overview: overviewData, fields: fields)

    let outBlob = try XCTUnwrap(JSONSerialization.jsonObject(with: outBlobData) as? [String: Any])
    let outOverview = try XCTUnwrap(JSONSerialization.jsonObject(with: outOverviewData) as? [String: Any])

    XCTAssertNil(outBlob["totp"], "totp key must be removed when secret is cleared")
    XCTAssertNil(outOverview["hasTOTP"], "hasTOTP key must be removed when secret is cleared")
  }

  // MARK: - Case 6: EDIT adding totp to an entry that had none

  func testApplyEdits_addTotp_toEntryWithNone() throws {
    let inputBlobObj: [String: Any] = [
      "title": "Entry", "username": "u", "password": "p",
    ]
    let inputOverviewObj: [String: Any] = [
      "title": "Entry", "username": "u", "urlHost": NSNull(),
    ]

    let blobData = try JSONSerialization.data(withJSONObject: inputBlobObj)
    let overviewData = try JSONSerialization.data(withJSONObject: inputOverviewObj)

    let fields = EditableEntryFields(
      title: "Entry", username: "u", password: "p", totpSecret: "NEWSECRET")
    let (outBlobData, outOverviewData) = try PersonalEntryBlobBuilder.applyEdits(
      blob: blobData, overview: overviewData, fields: fields)

    let outBlob = try XCTUnwrap(JSONSerialization.jsonObject(with: outBlobData) as? [String: Any])
    let outOverview = try XCTUnwrap(JSONSerialization.jsonObject(with: outOverviewData) as? [String: Any])

    XCTAssertTrue(outBlob["totp"] is [String: Any], "totp must be an object when added")
    let totp = outBlob["totp"] as! [String: Any]
    XCTAssertEqual(totp["secret"] as? String, "NEWSECRET")
    XCTAssertEqual(outOverview["hasTOTP"] as? Bool, true)
  }

  // MARK: - Case 7: EDIT preserves overview additionalUrlHosts, requireReprompt, travelSafe==false

  func testApplyEdits_preservesOverviewExtras_includingFalseTravelSafe() throws {
    let inputBlobObj: [String: Any] = [
      "title": "Entry", "username": "u", "password": "p", "url": "https://old.example.com",
    ]
    let inputOverviewObj: [String: Any] = [
      "title": "Entry",
      "username": "u",
      "urlHost": "old.example.com",
      "additionalUrlHosts": ["extra.example.com"],
      "requireReprompt": true,
      "travelSafe": false,
    ]

    let blobData = try JSONSerialization.data(withJSONObject: inputBlobObj)
    let overviewData = try JSONSerialization.data(withJSONObject: inputOverviewObj)

    let fields = EditableEntryFields(
      title: "Entry", username: "u", password: "p", url: "https://new.example.com")
    let (_, outOverviewData) = try PersonalEntryBlobBuilder.applyEdits(
      blob: blobData, overview: overviewData, fields: fields)

    let outOverview = try XCTUnwrap(
      JSONSerialization.jsonObject(with: outOverviewData) as? [String: Any])

    // urlHost must be updated from the new url.
    XCTAssertEqual(outOverview["urlHost"] as? String, "new.example.com")

    // Preserved keys.
    let extraHosts = try XCTUnwrap(outOverview["additionalUrlHosts"] as? [String])
    XCTAssertEqual(extraHosts, ["extra.example.com"])
    XCTAssertEqual(outOverview["requireReprompt"] as? Bool, true)

    // travelSafe must survive as explicit false (not dropped).
    XCTAssertEqual(outOverview["travelSafe"] as? Bool, false,
                   "explicit travelSafe==false must survive round-trip")
  }

  // MARK: - Case 8: EDIT empties username/url/notes → NSNull in blob

  func testApplyEdits_emptiesUsername_urlHost_notes_becomeNSNull() throws {
    let inputBlobObj: [String: Any] = [
      "title": "Entry",
      "username": "user",
      "password": "pass",
      "url": "https://example.com",
      "notes": "some notes",
    ]
    let inputOverviewObj: [String: Any] = [
      "title": "Entry", "username": "user", "urlHost": "example.com",
    ]

    let blobData = try JSONSerialization.data(withJSONObject: inputBlobObj)
    let overviewData = try JSONSerialization.data(withJSONObject: inputOverviewObj)

    let fields = EditableEntryFields(
      title: "Entry", username: "", password: "pass", url: "", notes: "")
    let (outBlobData, _) = try PersonalEntryBlobBuilder.applyEdits(
      blob: blobData, overview: overviewData, fields: fields)

    let outBlob = try XCTUnwrap(JSONSerialization.jsonObject(with: outBlobData) as? [String: Any])

    // Must be NSNull (JSON null), not absent or empty string.
    XCTAssertTrue(outBlob["username"] is NSNull, "empty username must become JSON null")
    XCTAssertTrue(outBlob["url"] is NSNull, "empty url must become JSON null")
    XCTAssertTrue(outBlob["notes"] is NSNull, "empty notes must become JSON null")

    // EntryBlobDecoder must decode null back to "" (not crash).
    let vaultKey = SymmetricKey(size: .bits256)
    let blobAAD = try buildPersonalEntryAAD(userId: "u1", entryId: "e1", vaultType: VaultType.blob)
    let enc = try encryptAESGCMEncoded(plaintext: outBlobData, key: vaultKey, aad: blobAAD)
    let dec = try decryptAESGCMEncoded(encrypted: enc, key: vaultKey, aad: blobAAD)
    let detail = try XCTUnwrap(EntryBlobDecoder.detail(plaintext: dec, entryId: "e1", teamId: nil))
    XCTAssertEqual(detail.username, "")
    XCTAssertEqual(detail.url, "")
    XCTAssertEqual(detail.notes, "")
  }

  // MARK: - Case 9: Bool fidelity — hasTOTP round-trips as Bool, not Int

  func testApplyEdits_hasTOTP_roundTripsAsBool_notInt() throws {
    let inputBlobObj: [String: Any] = [
      "title": "Entry", "username": "u", "password": "p",
    ]
    let inputOverviewObj: [String: Any] = [
      "title": "Entry", "username": "u", "urlHost": NSNull(),
    ]

    let blobData = try JSONSerialization.data(withJSONObject: inputBlobObj)
    let overviewData = try JSONSerialization.data(withJSONObject: inputOverviewObj)

    let fields = EditableEntryFields(
      title: "Entry", username: "u", password: "p", totpSecret: "MYSECRET")
    let (_, outOverviewData) = try PersonalEntryBlobBuilder.applyEdits(
      blob: blobData, overview: overviewData, fields: fields)

    // Re-parse via JSONSerialization (not JSONDecoder) to catch NSNumber-bool.
    let outOverview = try XCTUnwrap(
      JSONSerialization.jsonObject(with: outOverviewData) as? [String: Any])

    // Must decode as Bool true.
    XCTAssertEqual(outOverview["hasTOTP"] as? Bool, true,
                   "hasTOTP must be JSON boolean true")
    // Guard NSNumber-bool pitfall: JSON `true` has CFBooleanGetTypeID(), JSON `1` does not.
    if let nsNum = outOverview["hasTOTP"] as? NSNumber {
      XCTAssertTrue(CFGetTypeID(nsNum) == CFBooleanGetTypeID(),
                    "hasTOTP must NOT be integer — guards NSNumber-bool pitfall")
    }
  }

  // MARK: - Case 10: applyEdits on non-object input throws malformedJSON

  // MARK: - F-R6 pin: customFields round-trip preservation (thin pin, no new harness)

  func testApplyEdits_preservesCustomFields_byteEqual() throws {
    // Mirrors Case-3 pattern (preserve-unknown round-trip). PersonalEntryBlobBuilder
    // already round-trips unknown keys; this pin verifies customFields is included.
    let customFields: [[String: Any]] = [
      ["label": "Recovery Code", "value": "abc123", "type": "text"],
      ["label": "PIN", "value": "9999", "type": "hidden"],
    ]
    let inputBlobObj: [String: Any] = [
      "title": "Entry",
      "username": "alice",
      "password": "oldpass",
      "url": "https://example.com",
      "customFields": customFields,
    ]
    let inputOverviewObj: [String: Any] = [
      "title": "Entry", "username": "alice", "urlHost": "example.com",
    ]

    let blobData = try JSONSerialization.data(withJSONObject: inputBlobObj)
    let overviewData = try JSONSerialization.data(withJSONObject: inputOverviewObj)

    let fields = EditableEntryFields(
      title: "Entry", username: "alice", password: "newpass", url: "https://example.com")
    let (outBlobData, _) = try PersonalEntryBlobBuilder.applyEdits(
      blob: blobData, overview: overviewData, fields: fields)

    // customFields must survive byte-equal via .sortedKeys.
    let outObj = try XCTUnwrap(JSONSerialization.jsonObject(with: outBlobData) as? [String: Any])
    let outCF = try XCTUnwrap(outObj["customFields"])
    let outCFData = try JSONSerialization.data(withJSONObject: outCF, options: .sortedKeys)
    let inCFData = try JSONSerialization.data(withJSONObject: customFields, options: .sortedKeys)
    XCTAssertEqual(outCFData, inCFData, "customFields must be byte-equal after edit (preserve-unknown)")
  }

  func testApplyEdits_nonObjectInput_throwsMalformedJSON() throws {
    let arrayInput = Data("[]".utf8)
    let validObj = try JSONSerialization.data(withJSONObject: ["title": "T"])
    let fields = EditableEntryFields(title: "T", username: "u", password: "p")

    // Array blob → malformedJSON
    XCTAssertThrowsError(
      try PersonalEntryBlobBuilder.applyEdits(blob: arrayInput, overview: validObj, fields: fields)
    ) { error in
      XCTAssertEqual(error as? PersonalEntryBlobBuilderError, .malformedJSON)
    }

    // Number overview → malformedJSON
    let numberInput = Data("42".utf8)
    XCTAssertThrowsError(
      try PersonalEntryBlobBuilder.applyEdits(blob: validObj, overview: numberInput, fields: fields)
    ) { error in
      XCTAssertEqual(error as? PersonalEntryBlobBuilderError, .malformedJSON)
    }
  }
}
