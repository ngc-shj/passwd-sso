import Shared
import XCTest

final class PasswdSSOTests: XCTestCase {
  func testSharedFrameworkLinks() {
    XCTAssertFalse(Shared.frameworkVersion.isEmpty)
  }
}
