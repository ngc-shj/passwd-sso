import XCTest
import Shared

/// C3: the no-lockout matrix — only a confirmed, id-matched upload completes.
final class PasskeyRegistrationOutcomeTests: XCTestCase {
  private func outcome(
    alg: Bool = true, vault: Bool = true, crypto: Bool = true,
    token: Bool = true, uploadedId: String? = "e1", expected: String = "e1"
  ) -> PasskeyRegistrationDecision {
    passkeyRegistrationOutcome(
      algorithmSupported: alg, vaultUnlocked: vault, cryptoSucceeded: crypto,
      hasUploadToken: token, uploadedEntryId: uploadedId, expectedEntryId: expected
    )
  }

  func testSuccessCompletes() {
    XCTAssertEqual(outcome(), .complete)
  }

  func testUnsupportedAlgorithmCancels() {
    XCTAssertEqual(outcome(alg: false), .cancel(.unsupportedAlgorithm))
  }

  func testVaultLockedCancels() {
    XCTAssertEqual(outcome(vault: false), .cancel(.vaultLocked))
  }

  func testCryptoFailureCancels() {
    XCTAssertEqual(outcome(crypto: false), .cancel(.cryptoFailed))
  }

  func testNoTokenCancels() {
    XCTAssertEqual(outcome(token: false), .cancel(.noUploadToken))
  }

  func testUploadFailureCancels() {
    XCTAssertEqual(outcome(uploadedId: nil), .cancel(.uploadFailed))
  }

  func testIdMismatchCancels() {
    XCTAssertEqual(outcome(uploadedId: "other", expected: "e1"), .cancel(.idMismatch))
  }

  /// Precedence: an earlier failure wins even if a later input would also fail
  /// (a credential is never returned when ANY guard fails).
  func testEarliestFailureWins() {
    XCTAssertEqual(
      outcome(alg: false, vault: false, crypto: false, token: false, uploadedId: nil),
      .cancel(.unsupportedAlgorithm)
    )
  }
}
