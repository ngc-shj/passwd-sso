import Shared
import SwiftUI

@main
struct PasswdSSOAppApp: App {
  // AuthCoordinator is created inside RootView once the server URL is known.
  // We keep a reference here solely to forward Universal Link callbacks.
  @State private var activeCoordinator: AuthCoordinator?

  var body: some Scene {
    WindowGroup {
      RootView(onCoordinatorReady: { coordinator in
        activeCoordinator = coordinator
      })
      .onOpenURL { url in
        // Forward Universal Link callbacks to the active coordinator.
        // The coordinator's handleUniversalLink is a no-op if no session is pending.
        if let coordinator = activeCoordinator {
          Task { await coordinator.handleUniversalLink(url) }
        }
      }
    }
  }
}
