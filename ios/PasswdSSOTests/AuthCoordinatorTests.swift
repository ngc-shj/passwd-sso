import CryptoKit
import Foundation
import Security
import XCTest

@testable import PasswdSSOApp
@testable import Shared

/// Tests for AuthCoordinator.currentSigner() and currentJWK().
///
/// Note: Secure Enclave is unavailable in the iOS simulator. These tests use
/// software P-256 keys generated via SecKeyCreateRandomKey without the
/// kSecAttrTokenIDSecureEnclave attribute — same API surface, hardware-agnostic.
final class AuthCoordinatorTests: XCTestCase {

  // MARK: - currentSigner_returnsValidSigner

  func testCurrentSigner_noKeyLoaded_throws() async {
    let config = ServerConfig(baseURL: URL(string: "https://test.passwd-sso.example")!)
    let coordinator = AuthCoordinator(serverConfig: config)

    do {
      _ = try await coordinator.currentSigner()
      XCTFail("Expected AuthError.keyGenerationFailed when no key is loaded")
    } catch AuthError.keyGenerationFailed {
      // Expected.
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  func testCurrentJWK_noKeyLoaded_throws() async {
    let config = ServerConfig(baseURL: URL(string: "https://test.passwd-sso.example")!)
    let coordinator = AuthCoordinator(serverConfig: config)

    do {
      _ = try await coordinator.currentJWK()
      XCTFail("Expected AuthError.keyGenerationFailed when no key is loaded")
    } catch AuthError.keyGenerationFailed {
      // Expected.
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  func testCurrentSigner_afterKeyLoad_returnsValidSigner() async throws {
    // Generate a software P-256 key (no SE in simulator).
    let label = "com.test.dpop.\(UUID().uuidString)"
    let rawKey = try makeSoftwareP256Key(label: label)
    let wrapped = SendableSecKey(rawKey)
    let coordinator = AuthCoordinatorFixture(wrapped: wrapped)

    let signer = try await coordinator.currentSigner()

    // Verify the signer can produce a valid 64-byte raw ECDSA signature.
    let input = Data("header.payload".utf8)
    let signature = try await signer.sign(input: input)
    XCTAssertEqual(signature.count, 64, "Raw r||s ECDSA signature must be 64 bytes")
  }

  func testCurrentJWK_afterKeyLoad_containsRequiredFields() async throws {
    let label = "com.test.dpop.\(UUID().uuidString)"
    let rawKey = try makeSoftwareP256Key(label: label)
    let wrapped = SendableSecKey(rawKey)
    let coordinator = AuthCoordinatorFixture(wrapped: wrapped)

    let jwk = try await coordinator.currentJWK()

    XCTAssertEqual(jwk["kty"], "EC")
    XCTAssertEqual(jwk["crv"], "P-256")
    XCTAssertNotNil(jwk["x"], "JWK must contain x coordinate")
    XCTAssertNotNil(jwk["y"], "JWK must contain y coordinate")
  }

  // MARK: - Helpers

  /// Generate a software (non-SE) P-256 key for simulator testing.
  private func makeSoftwareP256Key(label: String) throws -> SecKey {
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: false,
        kSecAttrApplicationLabel as String: label,
      ] as [String: Any],
    ]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw AuthError.keyGenerationFailed
    }
    return key
  }


}

// MARK: - Fixture subclass that pre-loads a key

/// Sendable wrapper around SecKey (a CF object that is immutable after creation).
final class SendableSecKey: @unchecked Sendable {
  let key: SecKey
  init(_ key: SecKey) { self.key = key }
}

/// Exposes an actor-isolated initializer that injects a pre-generated key,
/// bypassing the Secure Enclave (which is unavailable in the simulator).
actor AuthCoordinatorFixture: AuthCoordinatorProtocol {
  private let wrappedKey: SendableSecKey

  /// Accept a `SendableSecKey` so the `SecKey` crosses the actor boundary safely.
  init(wrapped: SendableSecKey) {
    self.wrappedKey = wrapped
  }

  func currentSigner() throws -> SecureEnclaveDPoPSigner {
    SecureEnclaveDPoPSigner(key: wrappedKey.key)
  }

  func currentJWK() throws -> [String: String] {
    try exportPublicKeyJWK(key: wrappedKey.key)
  }
}

// MARK: - Protocol for testability

protocol AuthCoordinatorProtocol: Actor {
  func currentSigner() throws -> SecureEnclaveDPoPSigner
  func currentJWK() throws -> [String: String]
}

extension AuthCoordinator: AuthCoordinatorProtocol {}
