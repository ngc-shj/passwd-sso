import Shared
import XCTest

/// Smoke test that the Shared framework links and exposes its public surface.
final class SharedFrameworkTests: XCTestCase {
  func testSharedFrameworkLinks() {
    XCTAssertFalse(Shared.frameworkVersion.isEmpty)
  }
}
