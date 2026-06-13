import Foundation
import Security
import XCTest

@testable import Shared

// Uses FakeKeychain from HostTokenStoreTests.swift (same target).

final class UploadTokenStoreTests: XCTestCase {
  private var keychain: FakeKeychain!
  private var store: UploadTokenStore!

  override func setUp() {
    super.setUp()
    keychain = FakeKeychain()
    store = UploadTokenStore(service: "com.test.upload-token", keychain: keychain)
  }

  func testSaveAndLoadRoundTripsTokenExpiryAndNonce() throws {
    let expiry = Date(timeIntervalSince1970: 1_800_000_000)

    try store.save(token: "up_tok_1", expiresAt: expiry, dpopNonce: "nonce-1")

    let loaded = try XCTUnwrap(try store.load())
    XCTAssertEqual(loaded.token, "up_tok_1")
    XCTAssertEqual(
      loaded.expiresAt.timeIntervalSince1970, expiry.timeIntervalSince1970, accuracy: 1
    )
    XCTAssertEqual(loaded.dpopNonce, "nonce-1")
  }

  func testLoadReturnsNilWhenNoTokenStored() throws {
    XCTAssertNil(try store.load())
  }

  func testSaveWithoutNonceDropsPreviouslyStagedNonce() throws {
    try store.save(token: "t1", expiresAt: Date(), dpopNonce: "stale-nonce")

    try store.save(token: "t2", expiresAt: Date(), dpopNonce: nil)

    let loaded = try XCTUnwrap(try store.load())
    XCTAssertNil(loaded.dpopNonce)
  }

  func testLoadValidReturnsTokenBeforeExpiry() throws {
    let now = Date(timeIntervalSince1970: 1_000_000)
    try store.save(token: "t", expiresAt: now.addingTimeInterval(60), dpopNonce: nil)

    let valid = try store.loadValid(now: now)

    XCTAssertEqual(valid?.token, "t")
  }

  func testLoadValidReturnsNilAtOrAfterExpiry() throws {
    let now = Date(timeIntervalSince1970: 1_000_000)
    try store.save(token: "t", expiresAt: now, dpopNonce: nil)

    XCTAssertNil(try store.loadValid(now: now))
  }

  func testSaveNonceUpdatesOnlyTheNonce() throws {
    try store.save(token: "t", expiresAt: Date().addingTimeInterval(60), dpopNonce: "n1")

    try store.saveNonce("n2")

    let loaded = try XCTUnwrap(try store.load())
    XCTAssertEqual(loaded.token, "t")
    XCTAssertEqual(loaded.dpopNonce, "n2")
  }

  func testClearRemovesEverything() throws {
    try store.save(token: "t", expiresAt: Date(), dpopNonce: "n")

    try store.clear()

    XCTAssertNil(try store.load())
  }

  func testClearOnEmptyStoreSucceeds() throws {
    XCTAssertNoThrow(try store.clear())
  }

  func testWriteOrderIsExpiryBeforeToken() throws {
    try store.save(token: "t", expiresAt: Date(), dpopNonce: nil)

    let tokenIdx = try XCTUnwrap(keychain.writeLog.firstIndex(of: "upload_token"))
    let expiryIdx = try XCTUnwrap(keychain.writeLog.firstIndex(of: "upload_token_expiry"))
    XCTAssertLessThan(expiryIdx, tokenIdx)
  }
}
