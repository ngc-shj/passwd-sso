import XCTest
import Shared
@testable import PasswdSSOApp

/// Guards that `filteredSummaries` (the basis for the `.all` category and the
/// flat search list) keeps today's behavior after the landing refactor.
@MainActor
final class VaultFilterTests: XCTestCase {
  private func s(_ id: String, title: String, username: String = "u", urlHost: String = "x.com") -> VaultEntrySummary {
    VaultEntrySummary(id: id, title: title, username: username, urlHost: urlHost)
  }

  func testEmptySearchReturnsAll() {
    let vm = VaultViewModel()
    vm.injectSummaries([s("a", title: "Alpha"), s("b", title: "Beta")])
    XCTAssertEqual(Set(vm.filteredSummaries.map(\.id)), ["a", "b"])
  }

  func testSearchFiltersByTitleUsernameHost() {
    let vm = VaultViewModel()
    vm.injectSummaries([
      s("a", title: "GitHub", username: "alice"),
      s("b", title: "GitLab", username: "bob", urlHost: "gitlab.com"),
    ])
    vm.searchQuery = "github"
    XCTAssertEqual(vm.filteredSummaries.map(\.id), ["a"])
    vm.searchQuery = "bob"
    XCTAssertEqual(vm.filteredSummaries.map(\.id), ["b"])
    vm.searchQuery = "gitlab.com"
    XCTAssertEqual(vm.filteredSummaries.map(\.id), ["b"])
  }
}
