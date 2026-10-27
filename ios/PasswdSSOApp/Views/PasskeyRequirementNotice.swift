import Combine
import Foundation
import Shared
import SwiftUI

/// Main-actor mirror of `PasskeyRequirementStore` for SwiftUI. The store is
/// written from the API client's actor (off the main thread), so views observe
/// this instead of `@AppStorage`, which would publish from that thread.
@MainActor
final class PasskeyRequirementMonitor: ObservableObject {
  static let shared = PasskeyRequirementMonitor()

  @Published private(set) var isRequired: Bool
  private let store: PasskeyRequirementStore
  private var subscription: AnyCancellable?

  init(store: PasskeyRequirementStore = PasskeyRequirementStore()) {
    self.store = store
    self.isRequired = store.isRequired
    subscription = NotificationCenter.default
      .publisher(for: PasskeyRequirementStore.didChange)
      .receive(on: RunLoop.main)
      .sink { [weak self] _ in
        guard let self else { return }
        self.isRequired = self.store.isRequired
      }
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
