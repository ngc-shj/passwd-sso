import CryptoKit
import Shared
import SwiftUI

@main
struct PasswdSSOAppApp: App {
  // AuthCoordinator is created inside RootView once the server URL is known.
  // We keep a reference here solely to forward Universal Link callbacks.
  @State private var activeCoordinator: AuthCoordinator?
  @State private var activeSyncService: HostSyncService?
  @State private var currentVaultKey: SymmetricKey?
  @State private var currentUserId: String?

  @Environment(\.scenePhase) private var scenePhase

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
      .onChange(of: scenePhase) { _, newPhase in
        // Per plan §"Foreground sync (primary path)": re-sync on foreground.
        if newPhase == .active {
          Task {
            guard let syncService = activeSyncService,
                  let vaultKey = currentVaultKey,
                  let userId = currentUserId else { return }
            _ = try? await syncService.runSync(vaultKey: vaultKey, userId: userId)
          }
        }
      }
    }
  }
}
