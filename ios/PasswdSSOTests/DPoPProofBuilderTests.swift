import CryptoKit
import Foundation
import XCTest

@testable import Shared

// MARK: - Fakes

/// Deterministic signer that returns a fixed 64-byte signature.
struct FakeSigner: DPoPSigner {
  let signature: Data

  init(signature: Data = Data(repeating: 0xAB, count: 64)) {
    self.signature = signature
  }

  func sign(input: Data) async throws -> Data { signature }
}

/// Deterministic random source.
struct FakeRandom: RandomSource {
  let value: Data

  init(value: Data = Data(repeating: 0x42, count: 16)) {
    self.value = value
  }

  func bytes(_ count: Int) throws -> Data { Data(value.prefix(count)) }
}

// MARK: - Tests

final class DPoPProofBuilderTests: XCTestCase {

  // Known JWK for a P-256 key (values are illustrative base64url strings).
  private let knownJWK: [String: String] = [
    "kty": "EC",
    "crv": "P-256",
    "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "y": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ]

  func testHeaderJSONCanonical() async throws {
    let proof = try await buildDPoPProof(
      htm: "POST",
      htu: "https://example.com/api/mobile/token",
      jwk: knownJWK,
      signer: FakeSigner(),
      random: FakeRandom(),
      now: Date(timeIntervalSince1970: 1_000_000)
    )

    let parts = proof.jws.split(separator: ".", maxSplits: 2)
    XCTAssertEqual(parts.count, 3)

    let headerData = try base64URLDecode(String(parts[0]))
    let headerJSON = try JSONSerialization.jsonObject(with: headerData) as! [String: Any]

    XCTAssertEqual(headerJSON["alg"] as? String, "ES256")
    XCTAssertEqual(headerJSON["typ"] as? String, "dpop+jwt")
    XCTAssertNotNil(headerJSON["jwk"])

    // Exact byte-for-byte canonical header check — keys must be alphabetically sorted.
    let headerString = String(data: headerData, encoding: .utf8)!
    let jwkJSONString = #"{"crv":"P-256","kty":"EC","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}"#
    let expectedHeader = #"{"alg":"ES256","jwk":\#(jwkJSONString),"typ":"dpop+jwt"}"#
    XCTAssertEqual(headerString, expectedHeader)
  }

  func testPayloadContainsRequiredClaims() async throws {
    let fixedNow = Date(timeIntervalSince1970: 1_700_000_000)
    let proof = try await buildDPoPProof(
      htm: "GET",
      htu: "https://example.com/resource",
      jwk: knownJWK,
      signer: FakeSigner(),
      random: FakeRandom(),
      now: fixedNow
    )

    let parts = proof.jws.split(separator: ".", maxSplits: 2)
    let payloadData = try base64URLDecode(String(parts[1]))
    let payload = try JSONSerialization.jsonObject(with: payloadData) as! [String: Any]

    XCTAssertEqual(payload["htm"] as? String, "GET")
    XCTAssertEqual(payload["htu"] as? String, "https://example.com/resource")
    XCTAssertNotNil(payload["jti"])
    XCTAssertNotNil(payload["iat"])
  }

  func testIatIsIntegerNotFloat() async throws {
    let proof = try await buildDPoPProof(
      htm: "POST",
      htu: "https://example.com/token",
      jwk: knownJWK,
      signer: FakeSigner(),
      random: FakeRandom(),
      now: Date(timeIntervalSince1970: 1_700_000_001)
    )

    let parts = proof.jws.split(separator: ".", maxSplits: 2)
    let payloadData = try base64URLDecode(String(parts[1]))
    // iat must serialize as an integer in JSON (no decimal point).
    let payloadString = String(data: payloadData, encoding: .utf8)!
    XCTAssertTrue(payloadString.contains("\"iat\":1700000001"), "iat must be an integer: \(payloadString)")
    XCTAssertFalse(payloadString.contains("\"iat\":1700000001.0"), "iat must not be float: \(payloadString)")
  }

  func testAthAddedWhenProvided() async throws {
    let proof = try await buildDPoPProof(
      htm: "POST",
      htu: "https://example.com/resource",
      jwk: knownJWK,
      ath: "someAthValue",
      signer: FakeSigner(),
      random: FakeRandom(),
      now: Date(timeIntervalSince1970: 1_000_000)
    )

    let parts = proof.jws.split(separator: ".", maxSplits: 2)
    let payloadData = try base64URLDecode(String(parts[1]))
    let payload = try JSONSerialization.jsonObject(with: payloadData) as! [String: Any]
    XCTAssertEqual(payload["ath"] as? String, "someAthValue")
  }

  func testAthOmittedWhenNil() async throws {
    let proof = try await buildDPoPProof(
      htm: "POST",
      htu: "https://example.com/token",
      jwk: knownJWK,
      ath: nil,
      signer: FakeSigner(),
      random: FakeRandom(),
      now: Date(timeIntervalSince1970: 1_000_000)
    )

    let parts = proof.jws.split(separator: ".", maxSplits: 2)
    let payloadData = try base64URLDecode(String(parts[1]))
    let payload = try JSONSerialization.jsonObject(with: payloadData) as! [String: Any]
    XCTAssertNil(payload["ath"])
  }

  func testNonceAddedWhenProvided() async throws {
    let proof = try await buildDPoPProof(
      htm: "POST",
      htu: "https://example.com/token",
      jwk: knownJWK,
      nonce: "server-nonce-xyz",
      signer: FakeSigner(),
      random: FakeRandom(),
      now: Date(timeIntervalSince1970: 1_000_000)
    )

    let parts = proof.jws.split(separator: ".", maxSplits: 2)
    let payloadData = try base64URLDecode(String(parts[1]))
    let payload = try JSONSerialization.jsonObject(with: payloadData) as! [String: Any]
    XCTAssertEqual(payload["nonce"] as? String, "server-nonce-xyz")
  }

  func testNonceOmittedWhenNil() async throws {
    let proof = try await buildDPoPProof(
      htm: "POST",
      htu: "https://example.com/token",
      jwk: knownJWK,
      nonce: nil,
      signer: FakeSigner(),
      random: FakeRandom(),
      now: Date(timeIntervalSince1970: 1_000_000)
    )

    let parts = proof.jws.split(separator: ".", maxSplits: 2)
    let payloadData = try base64URLDecode(String(parts[1]))
    let payload = try JSONSerialization.jsonObject(with: payloadData) as! [String: Any]
    XCTAssertNil(payload["nonce"])
  }

  func testJWSSplitsIntoThreeParts() async throws {
    let proof = try await buildDPoPProof(
      htm: "POST",
      htu: "https://example.com/token",
      jwk: knownJWK,
      signer: FakeSigner(),
      random: FakeRandom(),
      now: Date(timeIntervalSince1970: 1_000_000)
    )

    let parts = proof.jws.split(separator: ".", maxSplits: 2)
    XCTAssertEqual(parts.count, 3, "JWS must be header.payload.signature")
  }

  func testHtmAndHtuRoundTrip() async throws {
    let proof = try await buildDPoPProof(
      htm: "DELETE",
      htu: "https://api.example.com/resource/123",
      jwk: knownJWK,
      signer: FakeSigner(),
      random: FakeRandom(),
      now: Date(timeIntervalSince1970: 1_000_000)
    )

    let parts = proof.jws.split(separator: ".", maxSplits: 2)
    let payloadData = try base64URLDecode(String(parts[1]))

    struct Payload: Decodable {
      let htm: String
      let htu: String
      let iat: Int
    }
    let payload = try JSONDecoder().decode(Payload.self, from: payloadData)
    XCTAssertEqual(payload.htm, "DELETE")
    XCTAssertEqual(payload.htu, "https://api.example.com/resource/123")
    XCTAssertEqual(payload.iat, 1_000_000)
  }

  func testJtiIsUniqueAcrossConsecutiveCalls() async throws {
    // Use SecRandom (real random source) to verify uniqueness.
    let proof1 = try await buildDPoPProof(
      htm: "POST",
      htu: "https://example.com/token",
      jwk: knownJWK,
      signer: FakeSigner(),
      now: Date(timeIntervalSince1970: 1_000_000)
    )
    let proof2 = try await buildDPoPProof(
      htm: "POST",
      htu: "https://example.com/token",
      jwk: knownJWK,
      signer: FakeSigner(),
      now: Date(timeIntervalSince1970: 1_000_000)
    )
    XCTAssertNotEqual(proof1.jti, proof2.jti)
  }

  func testSignatureIsBase64URLNoPadding() async throws {
    let proof = try await buildDPoPProof(
      htm: "POST",
      htu: "https://example.com/token",
      jwk: knownJWK,
      signer: FakeSigner(),
      random: FakeRandom(),
      now: Date(timeIntervalSince1970: 1_000_000)
    )

    let parts = proof.jws.split(separator: ".", maxSplits: 2)
    XCTAssertEqual(parts.count, 3)
    let sigPart = String(parts[2])
    XCTAssertFalse(sigPart.contains("="), "signature must not be padded")
    XCTAssertFalse(sigPart.contains("+"), "signature must use URL-safe alphabet")
    XCTAssertFalse(sigPart.contains("/"), "signature must use URL-safe alphabet")
  }

  func testMissingJWKFieldThrows() async {
    let badJWK: [String: String] = ["kty": "EC"]  // missing crv, x, y
    do {
      _ = try await buildDPoPProof(
        htm: "POST",
        htu: "https://example.com/token",
        jwk: badJWK,
        signer: FakeSigner(),
        random: FakeRandom()
      )
      XCTFail("Expected DPoPProofError.missingJWKField to be thrown")
    } catch DPoPProofError.missingJWKField {
      // Expected.
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }
}
