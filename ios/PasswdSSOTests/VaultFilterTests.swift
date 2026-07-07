import XCTest
import Shared
@testable import PasswdSSOApp

/// Guards that `filteredSummaries` (the basis for the `.all` category and the
/// flat search list) keeps today's behavior after the landing refactor.
@MainActor
final class VaultFilterTests: XCTestCase {
  private func s(
    _ id: String, title: String, username: String = "u", urlHost: String = "x.com"
  ) -> VaultEntrySummary {
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

  // MARK: - T-VM-SORT (sortOption applied as filteredSummaries' final step)

  private func makeSuiteDefaults() -> UserDefaults {
    let suiteName = "test.vaultfilter.\(UUID().uuidString)"
    return UserDefaults(suiteName: suiteName)!
  }

  func testDefaultSortIsTitle() {
    let vm = VaultViewModel(settings: AppSettingsStore(defaults: makeSuiteDefaults()))
    XCTAssertEqual(vm.sortOption, .title)
  }

  func testFilteredSummariesAppliesSortAfterScopeAndSearch() {
    let vm = VaultViewModel(settings: AppSettingsStore(defaults: makeSuiteDefaults()))
    vm.injectSummaries([
      s("b", title: "Beta", username: "bob", urlHost: "beta.com"),
      s("a", title: "Alpha", username: "alice", urlHost: "alpha.com"),
    ])
    vm.searchQuery = "" // no search filter, but sort must still apply
    vm.sortOption = .title
    XCTAssertEqual(vm.filteredSummaries.map(\.id), ["a", "b"])
  }

  func testChangingSortOptionReordersFilteredSummaries() {
    let vm = VaultViewModel(settings: AppSettingsStore(defaults: makeSuiteDefaults()))
    // Distinct hosts so .website produces a genuine host-based reorder that is
    // the INVERSE of the title order — proving the VM applies the website key,
    // not merely preserving input order via stability.
    vm.injectSummaries([
      s("b", title: "Beta", urlHost: "alpha.com"),
      s("a", title: "Alpha", urlHost: "zeta.com"),
    ])
    vm.sortOption = .title
    XCTAssertEqual(vm.filteredSummaries.map(\.id), ["a", "b"])  // Alpha < Beta

    vm.sortOption = .website
    XCTAssertEqual(vm.filteredSummaries.map(\.id), ["b", "a"])  // alpha.com < zeta.com
  }

  func testChangingSortDirectionReordersFilteredSummaries() {
    let vm = VaultViewModel(settings: AppSettingsStore(defaults: makeSuiteDefaults()))
    vm.injectSummaries([
      s("b", title: "Beta"),
      s("a", title: "Alpha"),
    ])
    vm.sortOption = .title
    vm.sortDirection = .ascending
    XCTAssertEqual(vm.filteredSummaries.map(\.id), ["a", "b"])

    vm.sortDirection = .descending
    XCTAssertEqual(vm.filteredSummaries.map(\.id), ["b", "a"])
  }

  func testDefaultSortDirectionFollowsKey() {
    let vm = VaultViewModel(settings: AppSettingsStore(defaults: makeSuiteDefaults()))
    // Default key .title → natural ascending direction.
    XCTAssertEqual(vm.sortDirection, .ascending)
  }
}
