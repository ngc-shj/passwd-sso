import Foundation
import XCTest
@testable import Shared

/// Golden-payload regression tests guarding against the bug class behind the SSH
/// `keySize` failure: a single blob field whose iOS decode type disagrees with
/// the web client's write-side type throws a `typeMismatch` that fails the WHOLE
/// blob decode, leaving the entry stuck on "decrypting".
///
/// Each fixture below MIRRORS the JSON the web client's per-type form actually
/// writes (see `src/components/passwords/personal/personal-*-form.tsx` in the
/// server repo) — including the field VALUE TYPES (numbers as numbers, bools as
/// bools, nulls as nulls). If the web write-side type drifts and iOS does not
/// follow, the matching test here turns a silent runtime "stuck on decrypting"
/// into a build-time test failure.
///
/// When adding a new entry type, add its golden payload here in lockstep with
/// the new web form — that is the whole point of this file.
final class EntryBlobGoldenPayloadTests: XCTestCase {

  private func data(_ json: String) -> Data { Data(json.utf8) }

  private func decode(_ json: String, _ entryType: String) throws -> VaultEntryDetail {
    try XCTUnwrap(
      EntryBlobDecoder.detail(
        plaintext: data(json), entryId: "golden", teamId: nil, entryType: entryType),
      "\(entryType) golden payload failed to decode — likely an iOS↔web blob type drift"
    )
  }

  // MARK: - One golden payload per entry type (value types mirror the web forms)

  func testGoldenSshKey() throws {
    // personal-ssh-key-form.tsx: keySize is a NUMBER.
    let json = #"""
    {"title":"deploy","privateKey":"-----BEGIN-----","publicKey":"ssh-ed25519 AAA",
     "keyType":"ed25519","keySize":256,"fingerprint":"SHA256:abc",
     "passphrase":"hunter2","comment":"a@b","notes":null,"tags":[],"travelSafe":true}
    """#
    let key = try XCTUnwrap(try decode(json, "SSH_KEY").sshKey)
    XCTAssertEqual(key.keySize, "256")
    XCTAssertEqual(key.privateKey, "-----BEGIN-----")
  }

  func testGoldenCreditCard() throws {
    // personal-credit-card-form.tsx: all fields are strings (expiryMonth/Year too).
    let json = #"""
    {"title":"Visa","cardholderName":"Alice","cardNumber":"4111111111111111",
     "brand":"visa","expiryMonth":"12","expiryYear":"2030","cvv":"123",
     "notes":null,"tags":[],"travelSafe":true}
    """#
    let card = try XCTUnwrap(try decode(json, "CREDIT_CARD").creditCard)
    XCTAssertEqual(card.expiryMonth, "12")
    XCTAssertEqual(card.cardNumber, "4111111111111111")
  }

  func testGoldenIdentity() throws {
    let json = #"""
    {"title":"Me","fullName":"Alice A","givenName":"Alice","familyName":"A",
     "email":"a@b.example","phone":"+81-3-0000-0000","dateOfBirth":"1990-01-01",
     "notes":null,"tags":[],"travelSafe":true}
    """#
    let id = try XCTUnwrap(try decode(json, "IDENTITY").identity)
    XCTAssertEqual(id.fullName, "Alice A")
  }

  func testGoldenBankAccount() throws {
    let json = #"""
    {"title":"Main","bankName":"Bank","accountType":"checking",
     "accountHolderName":"Alice","accountNumber":"12345678","routingNumber":"021",
     "swiftBic":"BOFAUS3N","iban":"DE00","branchName":"HQ","notes":null,
     "tags":[],"travelSafe":true}
    """#
    let bank = try XCTUnwrap(try decode(json, "BANK_ACCOUNT").bankAccount)
    XCTAssertEqual(bank.accountNumber, "12345678")
  }

  func testGoldenSecureNote() throws {
    // personal-secure-note-form.tsx: isMarkdown is a BOOL.
    let json = #"""
    {"title":"Note","content":"hello","tags":[],"isMarkdown":true,"travelSafe":true}
    """#
    let note = try XCTUnwrap(try decode(json, "SECURE_NOTE").secureNote)
    XCTAssertEqual(note.content, "hello")
    XCTAssertEqual(note.isMarkdown, true)
  }

  func testGoldenSoftwareLicense() throws {
    let json = #"""
    {"title":"IDE","softwareName":"CoolIDE","licenseKey":"ABCD-EFGH","version":"3.2",
     "licensee":"Alice","email":"a@b.example","purchaseDate":"2024-01-01",
     "expirationDate":"2025-01-01","notes":null,"tags":[],"travelSafe":true}
    """#
    let lic = try XCTUnwrap(try decode(json, "SOFTWARE_LICENSE").softwareLicense)
    XCTAssertEqual(lic.licenseKey, "ABCD-EFGH")
  }

  func testGoldenPasskey() throws {
    // personal-passkey-form.tsx: display fields + provider fields (passkeySignCount
    // is a NUMBER, decoded only by PasskeyFullBlobPayload, not the display path).
    let json = #"""
    {"title":"GitHub","relyingPartyId":"github.com","relyingPartyName":"GitHub",
     "username":"alice","credentialId":"Y3JlZA","creationDate":"2024-01-01",
     "deviceInfo":"iPhone","notes":null,"tags":[],"travelSafe":true,
     "passkeyPrivateKeyJwk":"{\"kty\":\"EC\"}","passkeyUserHandle":"dWg",
     "passkeySignCount":5}
    """#
    let pk = try XCTUnwrap(try decode(json, "PASSKEY").passkey)
    XCTAssertEqual(pk.relyingPartyId, "github.com")
    // The numeric passkeySignCount must not break the display-path blob decode.
  }

  func testGoldenLogin() throws {
    // personal-login-form path (buildPersonalEntryPayload): password present,
    // totp.digits/period are NUMBERS.
    let json = #"""
    {"title":"Login","username":"alice","password":"s3cr3t","url":"https://b.example",
     "notes":null,"tags":[],"totp":{"secret":"JBSWY","algorithm":"SHA1","digits":6,"period":30},
     "travelSafe":true}
    """#
    let d = try decode(json, "LOGIN")
    XCTAssertEqual(d.password, "s3cr3t")
    XCTAssertEqual(d.totpDigits, 6)
    XCTAssertEqual(d.totpPeriod, 30)
  }

  func testLoginToleratesStringTotpDigitsWithoutFailingWholeBlob() throws {
    // Defense for the same bug class on the LOGIN path: a TOTP digits/period that
    // drifts to a string must not throw the whole blob decode.
    let json = #"""
    {"title":"Login","username":"alice","password":"s3cr3t",
     "totp":{"secret":"JBSWY","digits":"8","period":"60"}}
    """#
    let d = try decode(json, "LOGIN")
    XCTAssertEqual(d.password, "s3cr3t")
    XCTAssertEqual(d.totpDigits, 8)
    XCTAssertEqual(d.totpPeriod, 60)
  }

  func testLoginToleratesNonNumericTotpDigitsWithoutFailingWholeBlob() throws {
    // A garbage digits value → totpDigits nil, but the entry still decodes.
    let json = #"""
    {"title":"Login","username":"alice","password":"s3cr3t",
     "totp":{"secret":"JBSWY","digits":true,"period":[30]}}
    """#
    let d = try decode(json, "LOGIN")
    XCTAssertEqual(d.password, "s3cr3t")
    XCTAssertNil(d.totpDigits)
    XCTAssertNil(d.totpPeriod)
    XCTAssertEqual(d.totpSecret, "JBSWY")
  }

  // MARK: - C1 custom fields

  func testGoldenLoginWithCustomFields() throws {
    // Happy-path: LOGIN blob with well-formed customFields decodes all fields.
    let json = #"""
    {"title":"Login","username":"alice","password":"s3cr3t","url":"https://b.example",
     "notes":null,"tags":[],
     "customFields":[
       {"label":"Recovery","value":"abc123","type":"text"},
       {"label":"API Key","value":"secret-key","type":"hidden"},
       {"label":"Portal","value":"https://portal.example","type":"url"}
     ]}
    """#
    let d = try decode(json, "LOGIN")
    XCTAssertEqual(d.password, "s3cr3t")
    XCTAssertEqual(d.customFields.count, 3)
    XCTAssertEqual(d.customFields[0].label, "Recovery")
    XCTAssertEqual(d.customFields[0].value, "abc123")
    XCTAssertEqual(d.customFields[0].kind, .text)
    XCTAssertEqual(d.customFields[1].label, "API Key")
    XCTAssertEqual(d.customFields[1].kind, .hidden)
    XCTAssertEqual(d.customFields[2].label, "Portal")
    XCTAssertEqual(d.customFields[2].kind, .url)
  }

  func testCustomFieldsValueDriftToleratesNumericAndObjectValue() throws {
    // Red-capable (RT7): numeric `value` and object `value` in a LOGIN blob with
    // a real password → assert detail non-nil, password preserved, drifted
    // field .value == "". Goes RED if FlexibleString is reverted to String?.
    let json = #"""
    {"title":"Login","username":"alice","password":"s3cr3t",
     "customFields":[
       {"label":"Count","value":42,"type":"text"},
       {"label":"Meta","value":{"nested":true},"type":"text"}
     ]}
    """#
    let d = try decode(json, "LOGIN")
    XCTAssertNotNil(d, "blob decode must not fail on drifted customField value types")
    XCTAssertEqual(d.password, "s3cr3t")
    XCTAssertEqual(d.customFields.count, 2)
    // Numeric value is stringified by FlexibleString ("42").
    XCTAssertEqual(d.customFields[0].value, "42")
    // Object/nested value → FlexibleString.value == nil → mapped to "".
    XCTAssertEqual(d.customFields[1].value, "")
  }

  func testCustomFieldsElementDriftSkipsJunkPreservesValidAndPassword() throws {
    // Red-capable (RT7 / F1 guard): junk elements ("junk", null) must be skipped
    // and the one valid element must survive. Goes RED if plain [CustomFieldPayload]
    // is used instead of LossyCustomFields.
    let json = #"""
    {"title":"Login","username":"alice","password":"s3cr3t",
     "customFields":["junk", null, {"label":"PIN","value":"1234","type":"text"}]}
    """#
    let d = try decode(json, "LOGIN")
    XCTAssertEqual(d.password, "s3cr3t")
    XCTAssertEqual(d.customFields.count, 1)
    XCTAssertEqual(d.customFields[0].label, "PIN")
    XCTAssertEqual(d.customFields[0].value, "1234")
  }

  func testCustomFieldsElementOrderingAndCursorAdvance() throws {
    // Red-capable (T8 / cursor-advance): junk elements must be consumed, valid
    // elements must appear in order with no off-by-one pairing.
    let json = #"""
    {"title":"Login","username":"alice","password":"s3cr3t",
     "customFields":["junk",{"label":"A","value":"1","type":"text"},42,{"label":"B","value":"2","type":"text"}]}
    """#
    let d = try decode(json, "LOGIN")
    XCTAssertEqual(d.customFields.map(\.label), ["A", "B"])
    XCTAssertEqual(d.customFields.map(\.value), ["1", "2"])
  }

  func testCustomFieldsAbsentKeyDecodesToEmpty() throws {
    // Blob that omits the `customFields` key entirely → customFields == [].
    let json = #"""
    {"title":"Login","username":"alice","password":"s3cr3t","url":"https://b.example"}
    """#
    let d = try decode(json, "LOGIN")
    XCTAssertEqual(d.customFields, [])
  }
}
