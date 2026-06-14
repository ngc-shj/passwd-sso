import CryptoKit
import Foundation
import XCTest
import Shared

// MARK: - Minimal CBOR decoder (test-only) — verifies the encoder's structure.

private indirect enum CB: Equatable {
  case int(Int)
  case bytes(Data)
  case text(String)
  case map([CBPair])
}

private struct CBPair: Equatable {
  let key: CB
  let value: CB
}

private func cbReadLen(_ d: Data, _ ai: Int, _ i: inout Int) -> Int {
  switch ai {
  case 0..<24: return ai
  case 24: let v = Int(d[i]); i += 1; return v
  case 25: let v = (Int(d[i]) << 8) | Int(d[i + 1]); i += 2; return v
  case 26:
    let v = (Int(d[i]) << 24) | (Int(d[i + 1]) << 16) | (Int(d[i + 2]) << 8) | Int(d[i + 3])
    i += 4; return v
  default: fatalError("unsupported additional info \(ai)")
  }
}

private func cbDecode(_ d: Data, _ i: inout Int) -> CB {
  let b = d[i]; i += 1
  let major = b >> 5
  let ai = Int(b & 0x1f)
  switch major {
  case 0: return .int(cbReadLen(d, ai, &i))
  case 1: return .int(-1 - cbReadLen(d, ai, &i))
  case 2:
    let n = cbReadLen(d, ai, &i); let r = d.subdata(in: i..<(i + n)); i += n; return .bytes(r)
  case 3:
    let n = cbReadLen(d, ai, &i); let r = d.subdata(in: i..<(i + n)); i += n
    return .text(String(decoding: r, as: UTF8.self))
  case 5:
    let n = cbReadLen(d, ai, &i)
    var pairs: [CBPair] = []
    for _ in 0..<n {
      let k = cbDecode(d, &i); let v = cbDecode(d, &i)
      pairs.append(CBPair(key: k, value: v))
    }
    return .map(pairs)
  default: fatalError("unsupported major \(major)")
  }
}

private func decodeCBOR(_ data: Data) -> CB {
  var i = 0
  let v = cbDecode(data, &i)
  return v
}

// MARK: - Tests

final class PasskeyRegistrationTests: XCTestCase {
  // Fixed, valid P-256 scalar (1..32) so outputs are deterministic.
  private var pinnedKey: P256.Signing.PrivateKey {
    let scalar = Data((1...32).map { UInt8($0) })
    return try! P256.Signing.PrivateKey(rawRepresentation: scalar)
  }

  // MARK: COSE

  func testCOSEKeyHasCanonicalFramingAndCorrectCoordinates() {
    let pub = pinnedKey.publicKey
    let cose = coseEC2PublicKey(pub)
    // Canonical CBOR framing prefix: map(5) | 1:2 | 3:-7 | -1:1 | -2:bstr(32) ...
    let prefix: [UInt8] = [0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]
    XCTAssertEqual(Array(cose.prefix(10)), prefix)

    guard case let .map(pairs) = decodeCBOR(cose) else { return XCTFail("not a map") }
    func value(_ k: Int) -> CB? { pairs.first { $0.key == .int(k) }?.value }
    XCTAssertEqual(value(1), .int(2))     // kty EC2
    XCTAssertEqual(value(3), .int(-7))    // alg ES256
    XCTAssertEqual(value(-1), .int(1))    // crv P-256
    let raw = pub.rawRepresentation
    XCTAssertEqual(value(-2), .bytes(Data(raw.prefix(32))))  // x
    XCTAssertEqual(value(-3), .bytes(Data(raw.suffix(32))))  // y
  }

  // Golden byte-vector: pins the EXACT wire bytes (framing + length prefixes),
  // not just decoder-recoverable field values. The expected sequence is built
  // from the canonical COSE_Key framing for ES256/P-256 + the pinned key's
  // raw x‖y, so a change to integer-length encoding, map-key order, or bstr
  // framing in coseEC2PublicKey fails here even though the CBOR would still
  // decode. (No cross-impl TS-captured fixture exists — see deviation log;
  // the wire bytes are additionally cross-checked end-to-end by the server
  // accepting the blob and the shipped assertion decoders reading it back.)
  func testCOSEKeyExactGoldenBytes() {
    let raw = pinnedKey.publicKey.rawRepresentation  // 64: x(32)‖y(32)
    var expected = Data([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20])
    expected.append(raw.prefix(32))                  // x
    expected.append(contentsOf: [0x22, 0x58, 0x20])  // key -3, bstr(32)
    expected.append(raw.suffix(32))                  // y
    XCTAssertEqual(coseEC2PublicKey(pinnedKey.publicKey), expected)
  }

  func testNoneAttestationObjectExactGoldenBytes() {
    let authData = Data([0xAA, 0xBB, 0xCC])
    // map(3) | "attStmt":map(0) | "authData":bstr(3) | "fmt":"none"
    var expected = Data([0xa3])
    expected.append(contentsOf: [0x67]); expected.append(Data("attStmt".utf8))
    expected.append(0xa0)  // empty map
    expected.append(contentsOf: [0x68]); expected.append(Data("authData".utf8))
    expected.append(contentsOf: [0x43]); expected.append(authData)  // bstr(3)
    expected.append(contentsOf: [0x63]); expected.append(Data("fmt".utf8))
    expected.append(contentsOf: [0x64]); expected.append(Data("none".utf8))  // tstr(4)
    XCTAssertEqual(buildNoneAttestationObject(authData: authData), expected)
  }

  // MARK: authData

  func testRegistrationAuthDataLayout() {
    let credId = Data((100..<132).map { UInt8($0) })  // 32 bytes
    let cose = coseEC2PublicKey(pinnedKey.publicKey)
    let authData = buildRegistrationAuthData(rpId: "webauthn.io", signCount: 0, credentialId: credId, coseKey: cose)

    XCTAssertEqual(Data(authData.prefix(32)), Data(SHA256.hash(data: Data("webauthn.io".utf8))))
    XCTAssertEqual(authData[32], 0x45, "flags must be UP|UV|AT (no BE/BS — matches the extension; BS=1 breaks Safari getAuthenticatorData)")
    XCTAssertEqual(Array(authData[33..<37]), [0, 0, 0, 0], "signCount 0 BE")
    XCTAssertEqual(Array(authData[37..<53]), Array(repeating: 0, count: 16), "AAGUID all zero")
    XCTAssertEqual(Array(authData[53..<55]), [0x00, 0x20], "credIdLen = 32 BE")
    XCTAssertEqual(authData.subdata(in: 55..<87), credId)
    XCTAssertEqual(authData.subdata(in: 87..<authData.count), cose)
  }

  // MARK: attestationObject

  func testNoneAttestationObjectStructure() {
    let authData = Data([0x01, 0x02, 0x03])
    let obj = buildNoneAttestationObject(authData: authData)
    guard case let .map(pairs) = decodeCBOR(obj) else { return XCTFail("not a map") }
    XCTAssertEqual(pairs.count, 3)
    // String keys in sorted order: attStmt, authData, fmt
    XCTAssertEqual(pairs[0].key, .text("attStmt"))
    XCTAssertEqual(pairs[0].value, .map([]))
    XCTAssertEqual(pairs[1].key, .text("authData"))
    XCTAssertEqual(pairs[1].value, .bytes(authData))
    XCTAssertEqual(pairs[2].key, .text("fmt"))
    XCTAssertEqual(pairs[2].value, .text("none"))
  }

  // MARK: JWK round-trip

  func testGeneratedJWKRoundTripsToSamePublicKey() throws {
    let gen = makePasskey(privateKey: pinnedKey, credentialId: Data(count: 32))
    let recovered = try decodeP256PrivateKeyJWK(Data(gen.privateKeyJWKString.utf8))
    XCTAssertEqual(recovered.publicKey.rawRepresentation, pinnedKey.publicKey.rawRepresentation)
  }

  func testGeneratedPasskeyExposesCoseMatchingKey() {
    let gen = makePasskey(privateKey: pinnedKey, credentialId: Data(count: 32))
    XCTAssertEqual(gen.publicKeyCOSE, coseEC2PublicKey(pinnedKey.publicKey))
  }

  // MARK: generate

  func testGeneratePasskeyProducesRandomDistinctCredentials() {
    let a = generatePasskey()
    let b = generatePasskey()
    XCTAssertEqual(a.credentialId.count, 32)
    XCTAssertNotEqual(a.credentialId, b.credentialId)
    XCTAssertNotEqual(a.privateKey.rawRepresentation, b.privateKey.rawRepresentation)
  }
}
