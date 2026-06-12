import XCTest

@testable import Shared

final class PasskeySignCountStoreTests: XCTestCase {
  private let suiteName = "test.passkeySignCount"
  private var defaults: UserDefaults!

  override func setUp() {
    super.setUp()
    defaults = UserDefaults(suiteName: suiteName)
    defaults.removePersistentDomain(forName: suiteName)
  }

  override func tearDown() {
    defaults.removePersistentDomain(forName: suiteName)
    super.tearDown()
  }

  func testFirstUseEmitsFloorPlusOne() {
    let store = PasskeySignCountStore(defaults: defaults)
    XCTAssertEqual(store.next(credentialId: "cred", floor: 5), 6)
  }

  func testConsecutiveUsesIncreaseMonotonically() {
    let store = PasskeySignCountStore(defaults: defaults)
    XCTAssertEqual(store.next(credentialId: "cred", floor: 0), 1)
    XCTAssertEqual(store.next(credentialId: "cred", floor: 0), 2)
    XCTAssertEqual(store.next(credentialId: "cred", floor: 0), 3)
  }

  func testHigherFloorOverridesStaleLocalCounter() {
    let store = PasskeySignCountStore(defaults: defaults)
    _ = store.next(credentialId: "cred", floor: 0)  // local → 1
    // A web-side use raised the server counter and synced a higher floor.
    XCTAssertEqual(store.next(credentialId: "cred", floor: 10), 11)
    XCTAssertEqual(store.next(credentialId: "cred", floor: 0), 12)
  }

  func testCountersAreIsolatedPerCredential() {
    let store = PasskeySignCountStore(defaults: defaults)
    XCTAssertEqual(store.next(credentialId: "a", floor: 0), 1)
    XCTAssertEqual(store.next(credentialId: "b", floor: 0), 1)
    XCTAssertEqual(store.next(credentialId: "a", floor: 0), 2)
  }
}
