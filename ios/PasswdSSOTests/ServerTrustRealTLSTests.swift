import Foundation
import Security
import XCTest

@testable import Shared

/// Real-TLS integration tests for the leaf-key pinning path.
///
/// The seam tests in `ServerTrustServiceTests` inject the probe *outcome*, so
/// they never drive `LeafKeyPinningDelegate`'s server-trust challenge — meaning
/// a deleted `flagMismatch()` call or a broken leaf-key comparison would still
/// pass there. These tests close that gap: a real `URLSession` completes a
/// genuine TLS handshake against a loopback `LocalTLSServer`, so the delegate's
/// `SecTrust` evaluation, leaf-key extraction, and pin comparison all run for
/// real.
///
/// ## Fixtures (`fixtures/TLS/`)
///
/// Generated once with OpenSSL (EC P-256), committed as test-only key material
/// — NOT production secrets, scoped to `localhost`:
///
/// ```
/// # Local test CA
/// openssl ecparam -name prime256v1 -genkey -noout -out ca.key
/// openssl req -x509 -new -key ca.key -sha256 -days 36500 \
///   -subj "/CN=PasswdSSO Test Local CA" \
///   -addext "basicConstraints=critical,CA:TRUE" -out ca.crt
/// openssl x509 -in ca.crt -outform DER -out testLocalCA.der
///
/// # Two leaves signed by that CA (same host, different keys)
/// #   leafA = the pinned "good" server
/// #   leafB = a rotated / attacker key
/// openssl x509 -req -in leafX.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
///   -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1\n...") ...
/// openssl pkcs12 -export -inkey leafX.key -in leafX.crt -certfile ca.crt \
///   -passout pass:passwd-sso-test -out tlsLeafX.p12 -legacy
/// ```
///
/// Both leaves chain to the same CA, so installing that CA as the trust anchor
/// lets both pass default evaluation — isolating the pin match/mismatch to the
/// leaf-key comparison, which is the boundary under test.
final class ServerTrustRealTLSTests: XCTestCase {

  /// Apple caps TLS server-leaf validity at ~398 days, so the fixtures are
  /// SHORT-LIVED and eventually expire. When they do, `SecTrustEvaluateWithError`
  /// fails with a cryptic `-67901`, which would read as a real pinning
  /// regression in every case. Fail fast in setUp instead with an actionable
  /// message — pointing at the regeneration script — so an expired fixture
  /// never masquerades as a bug.
  ///
  /// The probe IS the check: evaluate each leaf against the local CA anchor at
  /// the current date. That succeeds only while the leaf is within its validity
  /// window, so a lapse surfaces here rather than as four confusing failures.
  override func setUpWithError() throws {
    try super.setUpWithError()
    let ca = try loadLocalTestCA()
    for fixture in ["tlsLeafA", "tlsLeafB"] {
      let leaf = try loadLeafCertificate(fromFixture: fixture)
      var trust: SecTrust?
      XCTAssertEqual(
        SecTrustCreateWithCertificates(leaf, SecPolicyCreateBasicX509(), &trust),
        errSecSuccess)
      let secTrust = try XCTUnwrap(trust)
      XCTAssertEqual(SecTrustSetAnchorCertificates(secTrust, [ca] as CFArray), errSecSuccess)
      XCTAssertEqual(SecTrustSetAnchorCertificatesOnly(secTrust, true), errSecSuccess)
      var error: CFError?
      if !SecTrustEvaluateWithError(secTrust, &error) {
        XCTFail(
          """
          TLS test fixture \(fixture).p12 no longer evaluates against the local CA \
          (likely expired — Apple caps leaves at 397 days). Regenerate with:
            ios/scripts/generate-tls-test-fixtures.sh
          Underlying: \(String(describing: error))
          """)
      }
    }
  }

  /// Trust evaluator that installs the local test CA as the sole anchor, then
  /// runs the real `SecTrustEvaluateWithError`. This replaces ONLY the platform
  /// CA-root set — every other check in the delegate (host binding, leaf-key
  /// comparison, redirect guard) runs unmodified against the real handshake.
  private func anchorPinningEvaluator() throws -> @Sendable (SecTrust) -> Bool {
    let ca = try loadLocalTestCA()
    return { serverTrust in
      guard SecTrustSetAnchorCertificates(serverTrust, [ca] as CFArray) == errSecSuccess,
        // Only our CA is an anchor — a system-root fallback would let a real
        // MITM cert through and mask a pinning regression.
        SecTrustSetAnchorCertificatesOnly(serverTrust, true) == errSecSuccess
      else {
        return false
      }
      var error: CFError?
      return SecTrustEvaluateWithError(serverTrust, &error)
    }
  }

  private func loadLocalTestCA() throws -> SecCertificate {
    let bundle = Bundle(for: LocalTLSServer.self)
    let url = try XCTUnwrap(
      bundle.url(forResource: "testLocalCA", withExtension: "der")
        ?? bundle.url(forResource: "testLocalCA", withExtension: "der", subdirectory: "TLS"),
      "testLocalCA.der fixture missing from the test bundle")
    let der = try Data(contentsOf: url)
    return try XCTUnwrap(
      SecCertificateCreateWithData(nil, der as CFData),
      "testLocalCA.der is not a valid DER certificate")
  }

  /// Compute the pin a delegate WOULD capture for a fixture leaf, using the same
  /// `LeafKeyPinningDelegate.leafKeyHash` code path the delegate uses — so the
  /// expected value can never drift from the observed one.
  private func expectedLeafKeyHash(forLeafCertificateIn p12Fixture: String) throws -> Data {
    let leaf = try loadLeafCertificate(fromFixture: p12Fixture)
    return try XCTUnwrap(
      LeafKeyPinningDelegate.leafKeyHash(for: leaf),
      "could not derive leaf-key hash from \(p12Fixture)")
  }

  /// Import the PKCS#12 fixture and return its leaf certificate.
  private func loadLeafCertificate(fromFixture p12Fixture: String) throws -> SecCertificate {
    let bundle = Bundle(for: LocalTLSServer.self)
    let url = try XCTUnwrap(
      bundle.url(forResource: p12Fixture, withExtension: "p12")
        ?? bundle.url(forResource: p12Fixture, withExtension: "p12", subdirectory: "TLS"),
      "\(p12Fixture).p12 fixture missing from the test bundle")
    let data = try Data(contentsOf: url)
    var items: CFArray?
    let status = SecPKCS12Import(
      data as CFData,
      [kSecImportExportPassphrase as String: LocalTLSServer.fixturePassphrase] as CFDictionary,
      &items)
    XCTAssertEqual(status, errSecSuccess, "PKCS#12 import failed for \(p12Fixture)")
    let identity = try XCTUnwrap(
      (items as? [[String: Any]])?.first?[kSecImportItemIdentity as String] as! SecIdentity?)
    var certificate: SecCertificate?
    XCTAssertEqual(SecIdentityCopyCertificate(identity, &certificate), errSecSuccess)
    return try XCTUnwrap(certificate)
  }

  /// Drive a real GET over a URLSession bound to `delegate` and return the
  /// delegate outcome plus any transport error.
  /// The server binds to `127.0.0.1`; connect over the same literal so the
  /// client never resolves `localhost` to IPv6 `::1` (which the IPv4-only
  /// listener refuses, masking the trust logic under a connection error). The
  /// leaf SANs include `IP:127.0.0.1`.
  private let serverHost = "127.0.0.1"

  private func performHandshake(
    against port: UInt16,
    delegate: LeafKeyPinningDelegate
  ) async -> (data: Data?, error: Error?) {
    let config = URLSessionConfiguration.ephemeral
    config.waitsForConnectivity = false
    config.timeoutIntervalForRequest = 5
    let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let url = URL(string: "https://\(serverHost):\(port)/api/health/live")!
    do {
      let (data, _) = try await session.data(from: url)
      return (data, nil)
    } catch {
      return (nil, error)
    }
  }

  // MARK: - Case 1: default PKI trust (via local anchor) + pin match → success

  func testHandshakeSucceedsWhenLeafKeyMatchesPin() async throws {
    let server = try LocalTLSServer(identityFixture: "tlsLeafA")
    try server.start()
    defer { server.stop() }

    let pinnedHash = try expectedLeafKeyHash(forLeafCertificateIn: "tlsLeafA")
    let delegate = LeafKeyPinningDelegate(
      expectedLeafKeyHash: pinnedHash,
      expectedHost: serverHost,
      evaluateDefaultTrust: try anchorPinningEvaluator())

    let (data, error) = await performHandshake(against: server.port, delegate: delegate)

    XCTAssertNil(error, "a matching leaf key must complete the handshake: \(String(describing: error))")
    XCTAssertNotNil(data)
    XCTAssertFalse(delegate.pinMismatchDetected, "a matching pin must not flag a mismatch")
    XCTAssertEqual(delegate.capturedLeafKeyHash, pinnedHash,
                   "the delegate must capture the exact leaf key it validated against")
  }

  // MARK: - Case 2: default PKI trust succeeds but pin MISMATCHES → pinMismatch

  func testHandshakeFailsAndFlagsMismatchWhenLeafKeyDiffers() async throws {
    // Server presents leafB; the delegate pins leafA. Both chain to the same CA
    // so default trust passes — the ONLY thing that rejects is the leaf-key pin.
    let server = try LocalTLSServer(identityFixture: "tlsLeafB")
    try server.start()
    defer { server.stop() }

    let wrongPin = try expectedLeafKeyHash(forLeafCertificateIn: "tlsLeafA")
    let delegate = LeafKeyPinningDelegate(
      expectedLeafKeyHash: wrongPin,
      expectedHost: serverHost,
      evaluateDefaultTrust: try anchorPinningEvaluator())

    let (data, error) = await performHandshake(against: server.port, delegate: delegate)

    XCTAssertNil(data, "a mismatched leaf key must not yield a response body")
    XCTAssertNotNil(error, "a mismatched leaf key must fail the handshake")
    XCTAssertTrue(delegate.pinMismatchDetected,
                  "a real leaf-key mismatch must set the authoritative mismatch flag")
  }

  // MARK: - Case 3: default PKI trust FAILS (no anchor installed) → rejected

  func testHandshakeFailsWhenDefaultTrustFails() async throws {
    // Production trust evaluator (no local anchor) — the self-signed leaf has no
    // system-trusted chain, so default evaluation rejects it before any pin
    // check. `expectedLeafKeyHash: nil` so ONLY default trust can reject.
    let server = try LocalTLSServer(identityFixture: "tlsLeafA")
    try server.start()
    defer { server.stop() }

    let delegate = LeafKeyPinningDelegate(
      expectedLeafKeyHash: nil,
      expectedHost: serverHost)  // public init → real SecTrustEvaluateWithError

    let (data, error) = await performHandshake(against: server.port, delegate: delegate)

    XCTAssertNil(data, "an untrusted chain must not yield a response body")
    XCTAssertNotNil(error, "default-trust failure must fail the handshake")
    XCTAssertTrue(delegate.pinMismatchDetected,
                  "a failed default-trust evaluation must flag the identity as rejected")
  }

  // MARK: - Case 4: host mismatch rejected even when the key/chain are valid

  func testHandshakeFailsOnHostMismatchDespiteValidChain() async throws {
    // The chain + key are valid (leafA, local anchor) but the delegate expects a
    // different host, so the host-binding guard must reject before trusting.
    let server = try LocalTLSServer(identityFixture: "tlsLeafA")
    try server.start()
    defer { server.stop() }

    let pinnedHash = try expectedLeafKeyHash(forLeafCertificateIn: "tlsLeafA")
    let delegate = LeafKeyPinningDelegate(
      expectedLeafKeyHash: pinnedHash,
      expectedHost: "not-the-server.example",
      evaluateDefaultTrust: try anchorPinningEvaluator())

    let (data, error) = await performHandshake(against: server.port, delegate: delegate)

    XCTAssertNil(data, "a host mismatch must not yield a response body")
    XCTAssertNotNil(error, "a host mismatch must fail the handshake")
    XCTAssertTrue(delegate.pinMismatchDetected,
                  "a host mismatch must set the authoritative mismatch flag")
  }
}
