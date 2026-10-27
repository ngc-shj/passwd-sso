import Combine
import Foundation
import Shared
import SwiftUI

/// Main-actor mirror of `PasskeyRequirementStore` for SwiftUI. The store is
/// written from the API client's actor (off the main thread), so views observe
/// this instead of `@AppStorage`, which would publish from that thread.
///
/// The AutoFill extension writes the same suite from another process. Its
/// writes arrive through the Darwin relay (`didChangeInAnyProcess`) while the
/// app is running; `refresh()` re-reads the suite at the points that must not
/// trust a possibly-missed notification (foreground entry, before a sync).
@MainActor
final class PasskeyRequirementMonitor: ObservableObject {
  static let shared = PasskeyRequirementMonitor(observeOtherProcesses: true)

  @Published private(set) var isRequired: Bool
  private let store: PasskeyRequirementStore
  private var subscription: AnyCancellable?

  init(store: PasskeyRequirementStore = PasskeyRequirementStore(), observeOtherProcesses: Bool = false) {
    self.store = store
    self.isRequired = store.isRequired
    subscription = NotificationCenter.default
      .publisher(for: PasskeyRequirementStore.didChange)
      .merge(with: NotificationCenter.default.publisher(for: PasskeyRequirementStore.didChangeInAnyProcess))
      .receive(on: RunLoop.main)
      .sink { [weak self] _ in self?.refresh() }
    if observeOtherProcesses {
      // `shared` lives for the process, so the observer pointer never dangles.
      PasskeyRequirementStore.observeOtherProcesses(
        observer: UnsafeRawPointer(Unmanaged.passUnretained(self).toOpaque()))
    }
  }

  /// Re-read the shared suite (e.g. after the extension wrote it).
  func refresh() {
    let current = store.isRequired
    if isRequired != current { isRequired = current }
  }

  /// "Open passkey settings": open the web passkey page in the system browser
  /// (the member registers the passkey there, signed in on the web) and count
  /// it as the user acting — clear the flag so the next foreground sync checks
  /// again. If the requirement still holds, that sync sets the flag again.
  func openPasskeySettings(using openURL: OpenURLAction) {
    guard let serverURL = loadServerConfig()?.baseURL else { return }
    let url = passkeySettingsURL(serverURL: serverURL, language: AppSettingsStore().appLanguage)
    store.clear()
    openURL(url)
  }
}

/// Whether an automatic (not user-initiated) server call may run now. While
/// the server refuses this member with `PASSKEY_REQUIRED`, background syncs,
/// foreground re-syncs, AutoFill token re-mints and favicon fetches would all
/// be refused the same way, so they wait until the user acts (opens the
/// passkey page, syncs manually, or unlocks) or a call succeeds.
func automaticServerCallsAllowed(store: PasskeyRequirementStore = PasskeyRequirementStore()) -> Bool {
  !store.isRequired
}
