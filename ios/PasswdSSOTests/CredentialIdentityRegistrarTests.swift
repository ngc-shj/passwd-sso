import XCTest

@testable import Shared

/// Tests for the pure `CredentialIdentityRegistrar.specs(from:)` mapper and the
/// store-seam wiring (replace-when-enabled / no-op-when-disabled / clear).
final class CredentialIdentityRegistrarTests: XCTestCase {

  private func summary(
    _ id: String,
    urlHost: String,
    additional: [String] = [],
    username: String = "user"
  ) -> VaultEntrySummary {
    VaultEntrySummary(
      id: id, title: "T", username: username, urlHost: urlHost, additionalUrlHosts: additional
    )
  }

  // MARK: - Pure mapper (8 cases)

  func testSpecs_hostOnlyProducesOneSpecWithCorrectFields() {
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "amazon.co.jp", username: "alice")
    ])
    XCTAssertEqual(specs, [
      CredentialIdentitySpec(host: "amazon.co.jp", user: "alice", recordIdentifier: "e1")
    ])
  }

  func testSpecs_bothEmptyExcluded() {
    let specs = CredentialIdentityRegistrar.specs(from: [summary("e1", urlHost: "", additional: [])])
    XCTAssertTrue(specs.isEmpty)
  }

  func testSpecs_emptyUrlHostButAdditionalHostIncluded() {
    // Skip rule is "both empty", NOT "urlHost empty".
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "", additional: ["a.com"])
    ])
    XCTAssertEqual(specs.map(\.host), ["a.com"])
    XCTAssertEqual(specs.map(\.recordIdentifier), ["e1"])
  }

  func testSpecs_additionalHostsFanOutSameRecordIdentifier() {
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "a.com", additional: ["b.com", "c.com"], username: "u")
    ])
    XCTAssertEqual(specs.map(\.host), ["a.com", "b.com", "c.com"])
    XCTAssertEqual(Set(specs.map(\.recordIdentifier)), ["e1"])
    XCTAssertEqual(Set(specs.map(\.user)), ["u"])
  }

  func testSpecs_emptyStringInsideAdditionalDropped() {
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "a.com", additional: ["b.com", "", "  "])
    ])
    XCTAssertEqual(specs.map(\.host), ["a.com", "b.com"])
    XCTAssertFalse(specs.contains { $0.host.isEmpty })
  }

  func testSpecs_emptyUsernameStillProducesSpec() {
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "a.com", username: "")
    ])
    XCTAssertEqual(specs, [CredentialIdentitySpec(host: "a.com", user: "", recordIdentifier: "e1")])
  }

  func testSpecs_multipleSummariesFlatMapWithCorrectIds() {
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "a.com"),
      summary("e2", urlHost: "b.com"),
    ])
    XCTAssertEqual(specs.count, 2)
    XCTAssertEqual(specs.first { $0.host == "a.com" }?.recordIdentifier, "e1")
    XCTAssertEqual(specs.first { $0.host == "b.com" }?.recordIdentifier, "e2")
  }

  func testSpecs_emptyInputReturnsEmpty() {
    XCTAssertTrue(CredentialIdentityRegistrar.specs(from: []).isEmpty)
  }

  func testSpecs_dedupesIdenticalHostUserPairs() {
    // urlHost also present in additionalUrlHosts → only one spec.
    let specs = CredentialIdentityRegistrar.specs(from: [
      summary("e1", urlHost: "a.com", additional: ["a.com"], username: "u")
    ])
    XCTAssertEqual(specs, [CredentialIdentitySpec(host: "a.com", user: "u", recordIdentifier: "e1")])
  }

  // MARK: - Registrar wiring (fake store)

  func testReplace_whenEnabled_storesMappedSpecs() async {
    let store = FakeIdentityStore(enabled: true)
    let registrar = CredentialIdentityRegistrar(store: store)
    await registrar.replace(with: [summary("e1", urlHost: "a.com", username: "u")])

    let replaced = await store.replacedSpecs
    XCTAssertEqual(replaced, [CredentialIdentitySpec(host: "a.com", user: "u", recordIdentifier: "e1")])
  }

  func testReplace_whenDisabled_isNoOp() async {
    let store = FakeIdentityStore(enabled: false)
    let registrar = CredentialIdentityRegistrar(store: store)
    await registrar.replace(with: [summary("e1", urlHost: "a.com")])

    let count = await store.replaceCount
    XCTAssertEqual(count, 0, "replace must not be called when the provider is disabled")
  }

  func testClear_callsRemoveAll() async {
    let store = FakeIdentityStore(enabled: true)
    let registrar = CredentialIdentityRegistrar(store: store)
    await registrar.clear()

    let count = await store.removeAllCount
    XCTAssertEqual(count, 1)
  }
}

/// In-memory fake for CredentialIdentityStoring (actor → Sendable, no real
/// ASCredentialIdentityStore which is entitlement/device-dependent).
private actor FakeIdentityStore: CredentialIdentityStoring {
  private let enabled: Bool
  private(set) var replacedSpecs: [CredentialIdentitySpec]?
  private(set) var replaceCount = 0
  private(set) var removeAllCount = 0

  init(enabled: Bool) { self.enabled = enabled }

  func isEnabled() async -> Bool { enabled }
  func replace(with specs: [CredentialIdentitySpec]) async {
    replacedSpecs = specs
    replaceCount += 1
  }
  func removeAll() async { removeAllCount += 1 }
}
