import Foundation
import XCTest
@testable import PasswdSSOApp
@testable import Shared

/// Coverage for `recordPresence` (plan C2/C7) — the delete-on-mismatch /
/// keep-on-error decision extracted out of RootView so it is testable without
/// driving the full app state machine.
final class PresenceRecorderTests: XCTestCase {

  private func makeWrappedAuthHash() -> WrappedAuthHash {
    WrappedAuthHash(
      ciphertext: Data([0x01]),
      iv: Data(repeating: 0x01, count: 12),
      authTag: Data(repeating: 0x01, count: 16),
      issuedAt: Date()
    )
  }

  /// `verify` returning `true` (200 — presence recorded) must leave the cached
  /// authHash untouched.
  func testVerifiedTrue_keepsCachedAuthHash() async throws {
    let store = MockWrappedKeyStore()
    try store.saveAuthHash(makeWrappedAuthHash())

    await recordPresence(
      authHash: "hash", verify: { _ in true }, wrappedKeyStore: store)

    XCTAssertNotNil(try store.loadAuthHash(), "a successful verify must not delete the cache")
  }

  /// `verify` returning `false` (422 AUTH_HASH_MISMATCH) must delete the cached
  /// authHash so a stale hash is not re-presented on the next biometric unlock.
  func testVerifiedFalse_deletesCachedAuthHash() async throws {
    let store = MockWrappedKeyStore()
    try store.saveAuthHash(makeWrappedAuthHash())

    await recordPresence(
      authHash: "hash", verify: { _ in false }, wrappedKeyStore: store)

    XCTAssertNil(try store.loadAuthHash(), "a 422 mismatch must delete the cached authHash")
  }

  /// A thrown error (401-ladder exhaustion, network failure, 429, ACCOUNT_LOCKED)
  /// proves nothing about whether the hash is wrong — the cache must survive.
  func testVerifyThrows_keepsCachedAuthHash() async throws {
    struct Boom: Error {}
    let store = MockWrappedKeyStore()
    try store.saveAuthHash(makeWrappedAuthHash())

    await recordPresence(
      authHash: "hash", verify: { _ in throw Boom() }, wrappedKeyStore: store)

    XCTAssertNotNil(try store.loadAuthHash(), "a thrown verify error must not delete the cache")
  }

  /// The exact hash passed to `recordPresence` must be the one handed to `verify`.
  func testPassesAuthHashThroughToVerify() async {
    let received = ReceivedHash()
    let store = MockWrappedKeyStore()

    await recordPresence(
      authHash: "the-hash",
      verify: { hash in
        received.set(hash)
        return true
      },
      wrappedKeyStore: store
    )

    XCTAssertEqual(received.value, "the-hash")
  }
}

/// `verify` is `@Sendable`, so the captured sink must be too.
private final class ReceivedHash: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: String?

  func set(_ hash: String) {
    lock.lock(); defer { lock.unlock() }
    stored = hash
  }

  var value: String? {
    lock.lock(); defer { lock.unlock() }
    return stored
  }
}
