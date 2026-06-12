import Foundation
import UIKit
import XCTest
import Shared

/// Captures the options passed to `SecureClipboard.copy` (UIPasteboard does not
/// expose them for read-back).
private final class MockPasteboardWriter: PasteboardWriter {
  var lastValue: String?
  var lastOptions: [UIPasteboard.OptionsKey: Any]?
  func write(_ value: String, options: [UIPasteboard.OptionsKey: Any]) {
    lastValue = value
    lastOptions = options
  }
}

final class SecureClipboardTests: XCTestCase {
  func testCopySetsValueLocalOnlyAndFutureExpiration() {
    let writer = MockPasteboardWriter()
    let before = Date()
    SecureClipboard.copy("hunter2", clearAfter: 30, writer: writer)

    XCTAssertEqual(writer.lastValue, "hunter2")
    XCTAssertEqual(writer.lastOptions?[.localOnly] as? Bool, true)
    let expiry = try? XCTUnwrap(writer.lastOptions?[.expirationDate] as? Date)
    XCTAssertNotNil(expiry)
    XCTAssertGreaterThan(expiry!, before)
    XCTAssertLessThanOrEqual(expiry!.timeIntervalSince(before), 31)
  }

  func testCopyClampsBelowMinimum() {
    let writer = MockPasteboardWriter()
    let before = Date()
    SecureClipboard.copy("x", clearAfter: 0, writer: writer)
    let expiry = writer.lastOptions?[.expirationDate] as? Date
    // Clamped up to minClearSeconds (1), so still in the future, not in the past.
    XCTAssertGreaterThan(expiry ?? .distantPast, before)
    XCTAssertLessThanOrEqual((expiry ?? .distantFuture).timeIntervalSince(before), 2)
  }

  func testCopyClampsAboveMaximum() {
    let writer = MockPasteboardWriter()
    let before = Date()
    SecureClipboard.copy("x", clearAfter: 100_000, writer: writer)
    let expiry = writer.lastOptions?[.expirationDate] as? Date
    XCTAssertLessThanOrEqual(
      (expiry ?? .distantFuture).timeIntervalSince(before),
      Double(SecureClipboard.maxClearSeconds) + 1
    )
  }
}
