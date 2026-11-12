import Foundation
import XCTest

@testable import PasswdSSOApp
@testable import Shared

final class ServerURLSetupViewModelTests: XCTestCase {
  private struct DiscardFailed: Error {}

  private func makeIsolatedDefaults() -> (UserDefaults, String) {
    let name = "com.test.server-url-setup.\(UUID().uuidString)"
    return (UserDefaults(suiteName: name)!, name)
  }

  func testDiscardsTokensUnlessReverifyingTheSameServer() throws {
    let (defaults, name) = makeIsolatedDefaults()
    defer { defaults.removePersistentDomain(forName: name) }
    var discards = 0
    let viewModel = ServerURLSetupViewModel(
      defaults: defaults,
      discardPreviousServerTokens: { discards += 1 }
    )

    // No readable previous config: Keychain tokens may still survive lost
    // defaults, so they are discarded too.
    try viewModel.persist(ServerConfig(baseURL: URL(string: "https://a.example")!))
    XCTAssertEqual(discards, 1)

    try viewModel.persist(ServerConfig(baseURL: URL(string: "https://a.example")!))
    XCTAssertEqual(discards, 1, "re-verifying the same server keeps its tokens")

    try viewModel.persist(ServerConfig(baseURL: URL(string: "https://b.example")!))
    XCTAssertEqual(discards, 2, "a different server must not inherit the previous server's tokens")
    XCTAssertEqual(loadServerConfig(defaults: defaults)?.baseURL, URL(string: "https://b.example")!)
  }

  func testFailedDiscardLeavesThePreviousServerConfigured() throws {
    let (defaults, name) = makeIsolatedDefaults()
    defer { defaults.removePersistentDomain(forName: name) }
    saveServerConfig(ServerConfig(baseURL: URL(string: "https://a.example")!), defaults: defaults)
    let viewModel = ServerURLSetupViewModel(
      defaults: defaults,
      discardPreviousServerTokens: { throw DiscardFailed() }
    )

    XCTAssertThrowsError(try viewModel.persist(ServerConfig(baseURL: URL(string: "https://b.example")!)))
    XCTAssertEqual(loadServerConfig(defaults: defaults)?.baseURL, URL(string: "https://a.example")!)
  }
}
