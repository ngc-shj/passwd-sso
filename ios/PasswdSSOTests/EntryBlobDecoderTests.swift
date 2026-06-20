import Foundation
import XCTest
@testable import Shared

/// Unit tests for the shared `EntryBlobDecoder` — the single source of truth for
/// decoding server-shaped entry blobs into iOS view models (used by both the
/// host app and the AutoFill extension). Exercises the server's actual blob
/// shapes: null optional fields, absent password (non-LOGIN), tags as
/// {name,color} objects, the hasTOTP overview marker, and malformed input.
final class EntryBlobDecoderTests: XCTestCase {

  private func data(_ json: String) -> Data { Data(json.utf8) }

  // MARK: - summary()

  func testSummaryDecodesMinimalOverviewWithNullOptionals() throws {
    // Server overview blob with null username/urlHost and omitted additionalUrlHosts.
    let json = #"{"title":"Acme","username":null,"urlHost":null,"tags":[]}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e1", teamId: nil)
    )
    XCTAssertEqual(summary.id, "e1")
    XCTAssertEqual(summary.title, "Acme")
    XCTAssertEqual(summary.username, "")
    XCTAssertEqual(summary.urlHost, "")
    XCTAssertEqual(summary.additionalUrlHosts, [])
    XCTAssertEqual(summary.tags, [])
    XCTAssertFalse(summary.hasTOTP)
  }

  func testSummaryMapsTagObjectsToNames() throws {
    let json = #"{"title":"T","tags":[{"name":"work","color":"aaa"},{"name":"personal","color":null}]}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e2", teamId: "team-9")
    )
    XCTAssertEqual(summary.tags, ["work", "personal"])
    XCTAssertEqual(summary.teamId, "team-9")
  }

  func testSummaryReadsAdditionalUrlHostsAndTOTPMarker() throws {
    let json = #"""
    {"title":"Login","username":"u","urlHost":"example.com",
     "additionalUrlHosts":["alt.example.com","login.example.com"],
     "tags":[],"hasTOTP":true}
    """#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e3", teamId: nil)
    )
    XCTAssertEqual(summary.urlHost, "example.com")
    XCTAssertEqual(summary.additionalUrlHosts, ["alt.example.com", "login.example.com"])
    // The overview TOTP marker drives the AutoFill one-time-code picker filter.
    XCTAssertTrue(summary.hasTOTP)
  }

  func testSummaryDecodesRequireRepromptAndTravelSafe() throws {
    // Web-only overview flags must be decoded so an iOS edit can preserve them.
    let json = #"{"title":"T","urlHost":"x.com","tags":[],"requireReprompt":true,"travelSafe":true}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e3b", teamId: nil)
    )
    XCTAssertTrue(summary.requireReprompt)
    XCTAssertEqual(summary.travelSafe, true)
  }

  func testSummaryDecodesExplicitTravelSafeFalseAsFalseNotNil() throws {
    // An explicit travel-unsafe entry must decode to `false`, NOT nil — else an
    // iOS edit would omit the key and the web would read absent as travel-safe.
    let json = #"{"title":"T","urlHost":"x.com","tags":[],"travelSafe":false}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e3d", teamId: nil)
    )
    XCTAssertEqual(summary.travelSafe, false)
  }

  func testSummaryDefaultsRequireRepromptFalseAndTravelSafeNilWhenAbsent() throws {
    let json = #"{"title":"T","urlHost":"x.com","tags":[]}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e3c", teamId: nil)
    )
    XCTAssertFalse(summary.requireReprompt)
    XCTAssertNil(summary.travelSafe)
  }

  func testSummaryDefaultsHasTOTPFalseWhenMarkerAbsent() throws {
    // Entry encrypted before the hasTOTP marker shipped (or a non-LOGIN entry).
    let json = #"{"title":"NoMarker","urlHost":"x.com","tags":[]}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e4", teamId: nil)
    )
    XCTAssertFalse(summary.hasTOTP)
  }

  func testSummaryReturnsNilOnMalformedJSON() {
    XCTAssertNil(
      EntryBlobDecoder.summary(plaintext: data("{not json"), entryId: "e5", teamId: nil)
    )
  }

  // MARK: - detail()

  func testDetailDecodesLoginBlobWithTOTP() throws {
    let json = #"""
    {"title":"Login","username":"alice","password":"s3cret","url":"https://example.com",
     "notes":"hi","tags":[{"name":"work","color":"fff"}],
     "totp":{"secret":"JBSWY3DPEHPK3PXP","digits":6,"period":30}}
    """#
    let detail = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "e6", teamId: nil)
    )
    XCTAssertEqual(detail.password, "s3cret")
    XCTAssertEqual(detail.username, "alice")
    XCTAssertEqual(detail.url, "https://example.com")
    XCTAssertEqual(detail.notes, "hi")
    XCTAssertEqual(detail.tags, ["work"])
    XCTAssertEqual(detail.totpSecret, "JBSWY3DPEHPK3PXP")
    XCTAssertEqual(detail.totpDigits, 6)
    XCTAssertEqual(detail.totpPeriod, 30)
    XCTAssertNil(detail.totpAlgorithm)  // absent in JSON
  }

  func testDetailDecodesTOTPAlgorithmDigitsPeriod() throws {
    let json = #"""
    {"title":"Login","username":"a","password":"p",
     "totp":{"secret":"JBSWY3DPEHPK3PXP","algorithm":"SHA256","digits":8,"period":60}}
    """#
    let detail = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "e6b", teamId: nil)
    )
    XCTAssertEqual(detail.totpAlgorithm, "SHA256")
    XCTAssertEqual(detail.totpDigits, 8)
    XCTAssertEqual(detail.totpPeriod, 60)
  }

  func testDetailDecodesNonLoginBlobWithAbsentPassword() throws {
    // Secure-note / card / identity entries carry no `password` in the full
    // blob. Requiring it previously left the detail view stuck on "decrypting".
    let json = #"{"title":"Secure Note","notes":"body text","tags":[]}"#
    let detail = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "e7", teamId: nil)
    )
    XCTAssertEqual(detail.password, "")
    XCTAssertEqual(detail.notes, "body text")
    XCTAssertNil(detail.totpSecret)
  }

  func testDetailDecodesNullOptionalFields() throws {
    let json = #"{"title":"T","username":null,"password":null,"url":null,"notes":null,"tags":null}"#
    let detail = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "e8", teamId: nil)
    )
    XCTAssertEqual(detail.username, "")
    XCTAssertEqual(detail.password, "")
    XCTAssertEqual(detail.url, "")
    XCTAssertEqual(detail.notes, "")
    XCTAssertEqual(detail.tags, [])
  }

  func testDetailReturnsNilOnMalformedJSON() {
    XCTAssertNil(
      EntryBlobDecoder.detail(plaintext: data("not-json"), entryId: "e9", teamId: nil)
    )
  }

  // MARK: - detail() type-specific sub-structs

  func testDetailDecodesCreditCardBlob() throws {
    let json = #"""
    {"title":"Visa","cardholderName":"Alice A","cardNumber":"4111111111111111",
     "brand":"visa","expiryMonth":"12","expiryYear":"2030","cvv":"123","notes":"n"}
    """#
    let d = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "cc1", teamId: nil, entryType: "CREDIT_CARD")
    )
    let cc = try XCTUnwrap(d.creditCard)
    XCTAssertEqual(cc.cardholderName, "Alice A")
    XCTAssertEqual(cc.cardNumber, "4111111111111111")
    XCTAssertEqual(cc.brand, "visa")
    XCTAssertEqual(cc.expiryMonth, "12")
    XCTAssertEqual(cc.expiryYear, "2030")
    XCTAssertEqual(cc.cvv, "123")
    XCTAssertEqual(d.notes, "n")
    // Sibling sub-structs are nil; unconsumed LOGIN scalars are empty.
    XCTAssertNil(d.identity)
    XCTAssertNil(d.bankAccount)
    XCTAssertNil(d.secureNote)
    XCTAssertEqual(d.password, "")
    XCTAssertEqual(d.url, "")
  }

  func testDetailDecodesIdentityBlob() throws {
    let json = #"""
    {"title":"Me","fullName":"Alice Anderson","givenName":"Alice","familyName":"Anderson",
     "address":"1 Main St","addressLine1":"Apt 2","postalCode":"94016","city":"SF",
     "country":"US","email":"a@example.com","dateOfBirth":"1990-01-01","idNumber":"X12345",
     "issueDate":"2020-01-01","expiryDate":"2030-01-01"}
    """#
    let d = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "id1", teamId: nil, entryType: "IDENTITY")
    )
    let id = try XCTUnwrap(d.identity)
    XCTAssertEqual(id.fullName, "Alice Anderson")
    XCTAssertEqual(id.address, "1 Main St")
    XCTAssertEqual(id.addressLine1, "Apt 2")
    XCTAssertEqual(id.postalCode, "94016")
    XCTAssertEqual(id.city, "SF")
    XCTAssertEqual(id.country, "US")
    XCTAssertEqual(id.email, "a@example.com")
    XCTAssertEqual(id.dateOfBirth, "1990-01-01")
    XCTAssertEqual(id.idNumber, "X12345")
    XCTAssertEqual(id.expiryDate, "2030-01-01")
    XCTAssertNil(id.middleName)  // absent → nil
    XCTAssertNil(d.creditCard)
    XCTAssertEqual(d.password, "")
  }

  func testDetailDecodesBankAccountBlob() throws {
    let json = #"""
    {"title":"Checking","bankName":"Acme Bank","accountType":"checking",
     "accountHolderName":"Alice","accountNumber":"000123456","routingNumber":"110000000",
     "swiftBic":"ACMEUS33","iban":"US00ACME0001","branchName":"Downtown"}
    """#
    let d = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "ba1", teamId: nil, entryType: "BANK_ACCOUNT")
    )
    let ba = try XCTUnwrap(d.bankAccount)
    XCTAssertEqual(ba.bankName, "Acme Bank")
    XCTAssertEqual(ba.accountType, "checking")
    XCTAssertEqual(ba.accountHolderName, "Alice")
    XCTAssertEqual(ba.accountNumber, "000123456")
    XCTAssertEqual(ba.routingNumber, "110000000")
    XCTAssertEqual(ba.swiftBic, "ACMEUS33")
    XCTAssertEqual(ba.iban, "US00ACME0001")
    XCTAssertEqual(ba.branchName, "Downtown")
    XCTAssertNil(d.sshKey)
    XCTAssertNil(d.creditCard)
    // Unconsumed LOGIN scalars stay empty — no stray URL/Password row.
    XCTAssertEqual(d.url, "")
    XCTAssertEqual(d.password, "")
  }

  func testDetailDecodesSshKeyBlobUsesPassphraseAndCommentKeys() throws {
    // Blob keys are `passphrase`/`comment` (NOT sshPassphrase/sshComment).
    // The web client writes `keySize` as a JSON NUMBER (the SSH parser yields an
    // Int bit-length); decoding it as a bare String previously threw a
    // typeMismatch that failed the whole blob decode and left SSH entries stuck
    // on "decrypting". This mirrors the real server payload (numeric keySize).
    let json = #"""
    {"title":"deploy key","privateKey":"-----BEGIN-----","publicKey":"ssh-ed25519 AAA",
     "keyType":"ed25519","keySize":256,"fingerprint":"SHA256:abc",
     "passphrase":"hunter2","comment":"deploy@host"}
    """#
    let d = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "ssh1", teamId: nil, entryType: "SSH_KEY")
    )
    let key = try XCTUnwrap(d.sshKey)
    XCTAssertEqual(key.privateKey, "-----BEGIN-----")
    XCTAssertEqual(key.publicKey, "ssh-ed25519 AAA")
    XCTAssertEqual(key.keyType, "ed25519")
    XCTAssertEqual(key.keySize, "256")
    XCTAssertEqual(key.fingerprint, "SHA256:abc")
    XCTAssertEqual(key.passphrase, "hunter2")
    XCTAssertEqual(key.comment, "deploy@host")
    XCTAssertNil(d.bankAccount)
    XCTAssertEqual(d.url, "")
    XCTAssertEqual(d.password, "")
  }

  func testDetailDecodesSshKeyBlobToleratesStringKeySize() throws {
    // Defensive: a blob that carries `keySize` as a string (legacy/hand-edited
    // data) must still decode rather than throwing the whole blob away.
    let json = #"""
    {"title":"legacy key","privateKey":"-----BEGIN-----","keyType":"rsa",
     "keySize":"2048","fingerprint":"SHA256:xyz"}
    """#
    let d = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "ssh2", teamId: nil, entryType: "SSH_KEY")
    )
    let key = try XCTUnwrap(d.sshKey)
    XCTAssertEqual(key.keySize, "2048")
    XCTAssertEqual(key.keyType, "rsa")
  }

  func testDetailDecodesSshKeyBlobWithNullKeySize() throws {
    // `keySize || null` → JSON null when the parser could not estimate a size.
    let json = #"""
    {"title":"sizeless key","privateKey":"-----BEGIN-----","keyType":"ed25519",
     "keySize":null,"fingerprint":"SHA256:zzz"}
    """#
    let d = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "ssh3", teamId: nil, entryType: "SSH_KEY")
    )
    let key = try XCTUnwrap(d.sshKey)
    XCTAssertNil(key.keySize)
    XCTAssertEqual(key.keyType, "ed25519")
  }

  func testDetailDecodesSshKeyBlobWithMissingKeySize() throws {
    // keySize key omitted entirely (different decode path from explicit null).
    let json = #"""
    {"title":"k","privateKey":"-----BEGIN-----","keyType":"rsa","fingerprint":"SHA256:m"}
    """#
    let d = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "ssh4", teamId: nil, entryType: "SSH_KEY")
    )
    let key = try XCTUnwrap(d.sshKey)
    XCTAssertNil(key.keySize)
    XCTAssertEqual(key.keyType, "rsa")
  }

  func testDetailDecodesSshKeyBlobNormalizesWholeNumberDoubleKeySize() throws {
    // A whole-number double (256.0) normalizes to "256", not "256.0".
    let json = #"""
    {"title":"k","privateKey":"-----BEGIN-----","keyType":"rsa","keySize":256.0}
    """#
    let d = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "ssh5", teamId: nil, entryType: "SSH_KEY")
    )
    let key = try XCTUnwrap(d.sshKey)
    XCTAssertEqual(key.keySize, "256")
  }

  func testDetailToleratesNonScalarKeySizeWithoutFailingWholeBlob() throws {
    // Regression guard for the exact failure class this fix targets: an
    // unexpected JSON shape for ONE field must not throw the whole blob decode.
    // bool/array keySize → keySize nil, but the SSH entry still decodes.
    for badKeySize in ["true", "[2048]", #"{"bits":2048}"#] {
      let json = """
      {"title":"weird","privateKey":"-----BEGIN-----","keyType":"rsa",
       "keySize":\(badKeySize),"fingerprint":"SHA256:q"}
      """
      let d = try XCTUnwrap(
        EntryBlobDecoder.detail(plaintext: data(json), entryId: "ssh6", teamId: nil, entryType: "SSH_KEY"),
        "blob with keySize=\(badKeySize) should still decode"
      )
      let key = try XCTUnwrap(d.sshKey)
      XCTAssertNil(key.keySize, "non-scalar keySize=\(badKeySize) should decode to nil")
      XCTAssertEqual(key.keyType, "rsa")
    }
  }

  func testDetailDecodesSoftwareLicenseBlob() throws {
    let json = #"""
    {"title":"IDE","softwareName":"CoolIDE","licenseKey":"ABCD-EFGH","version":"3.2",
     "licensee":"Alice","email":"a@example.com","purchaseDate":"2024-01-01",
     "expirationDate":"2025-01-01"}
    """#
    let d = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "sl1", teamId: nil, entryType: "SOFTWARE_LICENSE")
    )
    let lic = try XCTUnwrap(d.softwareLicense)
    XCTAssertEqual(lic.softwareName, "CoolIDE")
    XCTAssertEqual(lic.licenseKey, "ABCD-EFGH")
    XCTAssertEqual(lic.version, "3.2")
    XCTAssertEqual(lic.licensee, "Alice")
    XCTAssertEqual(lic.email, "a@example.com")
    XCTAssertEqual(lic.purchaseDate, "2024-01-01")
    XCTAssertEqual(lic.expirationDate, "2025-01-01")
    XCTAssertNil(d.passkey)
    XCTAssertEqual(d.url, "")
    XCTAssertEqual(d.password, "")
  }

  func testDetailDecodesPasskeyDisplayBlobExcludesPrivateMaterial() throws {
    // Provider-private passkey* keys must never surface in the display struct.
    let json = #"""
    {"title":"GitHub","relyingPartyId":"github.com","relyingPartyName":"GitHub",
     "username":"alice","credentialId":"AQIDBA","creationDate":"2024-05-01",
     "deviceInfo":"iPhone","passkeyPrivateKeyJwk":"{\"d\":\"secret\"}","passkeyUserHandle":"dXNlcg"}
    """#
    let d = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "pk1", teamId: nil, entryType: "PASSKEY")
    )
    let pk = try XCTUnwrap(d.passkey)
    XCTAssertEqual(pk.relyingPartyId, "github.com")
    XCTAssertEqual(pk.relyingPartyName, "GitHub")
    XCTAssertEqual(pk.username, "alice")
    XCTAssertEqual(pk.credentialId, "AQIDBA")
    XCTAssertEqual(pk.creationDate, "2024-05-01")
    XCTAssertEqual(pk.deviceInfo, "iPhone")
    XCTAssertNil(d.softwareLicense)
    // url/password absent → empty. `username` legitimately carries "alice"
    // (shared key decoded unconditionally), so it is NOT asserted empty (T10).
    XCTAssertEqual(d.url, "")
    XCTAssertEqual(d.password, "")
  }

  func testDetailSecureNoteBodyComesFromContentNotNotes() throws {
    // The note body lives under `content`, never `notes` — pin both directions.
    let json = #"{"title":"Note","content":"the secret body","tags":[]}"#
    let d = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "sn1", teamId: nil, entryType: "SECURE_NOTE")
    )
    let note = try XCTUnwrap(d.secureNote)
    XCTAssertEqual(note.content, "the secret body")
    XCTAssertEqual(d.notes, "")  // body did NOT leak into top-level notes
  }

  func testDetailMinimalSubStructLeavesAbsentFieldsNil() throws {
    // Only one key present; every other credit-card field decodes to nil.
    let json = #"{"title":"Card","cardNumber":"4111"}"#
    let d = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "cc2", teamId: nil, entryType: "CREDIT_CARD")
    )
    let cc = try XCTUnwrap(d.creditCard)
    XCTAssertEqual(cc.cardNumber, "4111")
    XCTAssertNil(cc.cardholderName)
    XCTAssertNil(cc.brand)
    XCTAssertNil(cc.expiryMonth)
    XCTAssertNil(cc.cvv)
  }

  func testDetailLoginEntryTypeNilAndLoginAreEquivalent() throws {
    let json = #"{"title":"L","username":"a","password":"p","url":"https://x"}"#
    let nilType = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "l1", teamId: nil)
    )
    let loginType = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "l1", teamId: nil, entryType: "LOGIN")
    )
    XCTAssertEqual(nilType.username, loginType.username)
    XCTAssertEqual(nilType.password, loginType.password)
    XCTAssertEqual(nilType.url, loginType.url)
    // No sub-struct is populated for LOGIN under either form.
    for d in [nilType, loginType] {
      XCTAssertNil(d.secureNote)
      XCTAssertNil(d.creditCard)
      XCTAssertNil(d.identity)
      XCTAssertNil(d.bankAccount)
      XCTAssertNil(d.sshKey)
      XCTAssertNil(d.softwareLicense)
      XCTAssertNil(d.passkey)
    }
  }

  func testDetailTeamPathHonorsEntryTypeAndCarriesTeamId() throws {
    // Pins that the TeamEntryDecryptor call site's entryType + teamId reach the
    // sub-struct selection.
    let json = #"{"title":"Team Card","cardNumber":"4111111111111111","brand":"visa"}"#
    let d = try XCTUnwrap(
      EntryBlobDecoder.detail(plaintext: data(json), entryId: "tc1", teamId: "t1", entryType: "CREDIT_CARD")
    )
    XCTAssertEqual(d.teamId, "t1")
    XCTAssertEqual(d.creditCard?.cardNumber, "4111111111111111")
  }

  // MARK: - passkey overview / material (C3)

  func testSummarySurfacesPasskeyOverviewFields() throws {
    let json = #"{"title":"GitHub","username":"alice","relyingPartyId":"github.com","credentialId":"AQIDBA"}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "pk1", teamId: nil)
    )
    XCTAssertEqual(summary.relyingPartyId, "github.com")
    XCTAssertEqual(summary.credentialId, "AQIDBA")
  }

  func testSummaryLoginEntryHasNilPasskeyFields() throws {
    let json = #"{"title":"Acme","username":"u","urlHost":"acme.com","tags":[]}"#
    let summary = try XCTUnwrap(
      EntryBlobDecoder.summary(plaintext: data(json), entryId: "e1", teamId: nil)
    )
    XCTAssertNil(summary.relyingPartyId, "LOGIN entries are not passkeys")
    XCTAssertNil(summary.credentialId)
  }

  func testPasskeyMaterialDecodesDoubleEncodedJWK() throws {
    // passkeyPrivateKeyJwk is a JSON STRING containing the JWK object (double-encoded),
    // matching the browser extension's JSON.stringify(privateKeyJwk).
    let json = #"""
    {"title":"GitHub","relyingPartyId":"github.com","credentialId":"AQIDBA",\#
    "passkeyPrivateKeyJwk":"{\"kty\":\"EC\",\"crv\":\"P-256\",\"d\":\"abc\",\"x\":\"xx\",\"y\":\"yy\"}",\#
    "passkeyUserHandle":"BQYHCA"}
    """#
    let material = try XCTUnwrap(
      EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "pk1")
    )
    XCTAssertEqual(material.entryId, "pk1")
    XCTAssertEqual(material.relyingPartyId, "github.com")
    XCTAssertEqual(material.credentialId, "AQIDBA")
    XCTAssertEqual(material.userHandle, "BQYHCA")
    // The stored JWK is the inner object string; decodeP256PrivateKeyJWK parses it.
    XCTAssertEqual(String(decoding: material.privateKeyJWK, as: UTF8.self),
                   #"{"kty":"EC","crv":"P-256","d":"abc","x":"xx","y":"yy"}"#)
  }

  func testPasskeyMaterialDecodesSignCount() throws {
    let json = #"{"relyingPartyId":"github.com","credentialId":"AQIDBA","passkeyPrivateKeyJwk":"{}","passkeyUserHandle":"BQYHCA","passkeySignCount":42}"#
    let material = try XCTUnwrap(
      EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "pk1")
    )
    XCTAssertEqual(material.signCount, 42)
  }

  func testPasskeyMaterialSignCountDefaultsToZeroWhenAbsent() throws {
    let json = #"{"relyingPartyId":"github.com","credentialId":"AQIDBA","passkeyPrivateKeyJwk":"{}","passkeyUserHandle":"BQYHCA"}"#
    let material = try XCTUnwrap(
      EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "pk1")
    )
    XCTAssertEqual(material.signCount, 0)
  }

  func testPasskeyMaterialNegativeSignCountClampsToZero() throws {
    let json = #"{"relyingPartyId":"github.com","credentialId":"AQIDBA","passkeyPrivateKeyJwk":"{}","passkeyUserHandle":"BQYHCA","passkeySignCount":-5}"#
    let material = try XCTUnwrap(
      EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "pk1")
    )
    XCTAssertEqual(material.signCount, 0)
  }

  func testPasskeyMaterialReturnsNilWhenNotPasskey() {
    // LOGIN blob: no relyingPartyId / no passkeyPrivateKeyJwk.
    let json = #"{"title":"Acme","username":"u","password":"p","url":"acme.com"}"#
    XCTAssertNil(EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "e1"))
  }

  func testPasskeyMaterialReturnsNilWhenCredentialIdMissing() {
    // rpId + jwk present but credentialId absent → fail fast (F17).
    let json = #"{"relyingPartyId":"github.com","passkeyPrivateKeyJwk":"{}","passkeyUserHandle":"BQYHCA"}"#
    XCTAssertNil(EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "pk1"))
  }

  func testPasskeyMaterialReturnsNilWhenJWKIsBareObject() {
    // passkeyPrivateKeyJwk MUST be a JSON string (double-encoded). A bare JWK
    // object at that field is a type mismatch → decode fails → nil (T5 guard).
    let json = #"""
    {"relyingPartyId":"github.com","credentialId":"AQIDBA",\#
    "passkeyPrivateKeyJwk":{"kty":"EC","crv":"P-256","d":"abc"},\#
    "passkeyUserHandle":"BQYHCA"}
    """#
    XCTAssertNil(EntryBlobDecoder.passkeyMaterial(plaintext: data(json), entryId: "pk1"))
  }

  // MARK: - CacheEntry.entryType backward compat (C4)

  func testCacheEntryDecodesNilEntryTypeFromLegacyJSON() throws {
    let json = #"""
    {"id":"e1","aadVersion":0,"keyVersion":0,\#
    "encryptedBlob":{"ciphertext":"00","iv":"00","authTag":"00"},\#
    "encryptedOverview":{"ciphertext":"00","iv":"00","authTag":"00"}}
    """#
    let entry = try JSONDecoder().decode(CacheEntry.self, from: data(json))
    XCTAssertNil(entry.entryType, "legacy cache rows lack entryType → decode to nil")
  }

  func testCacheEntryDecodesPasskeyEntryType() throws {
    let json = #"""
    {"id":"pk1","aadVersion":1,"keyVersion":1,"entryType":"PASSKEY",\#
    "encryptedBlob":{"ciphertext":"00","iv":"00","authTag":"00"},\#
    "encryptedOverview":{"ciphertext":"00","iv":"00","authTag":"00"}}
    """#
    let entry = try JSONDecoder().decode(CacheEntry.self, from: data(json))
    XCTAssertEqual(entry.entryType, "PASSKEY")
  }
}
