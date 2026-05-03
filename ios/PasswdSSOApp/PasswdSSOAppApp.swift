import CryptoKit
import Shared
import SwiftUI

@main
struct PasswdSSOAppApp: App {
  // AuthCoordinator is created inside RootView once the server URL is known.
  // We keep a reference here solely to forward Universal Link callbacks.
  @State private var activeCoordinator: AuthCoordinator?
  @State private var activeSyncService: HostSyncService?
  @State private var activeDrain: RollbackFlagDrain?
  @State private var currentVaultKey: SymmetricKey?
  @State private var currentUserId: String?

  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      ZStack {
        RootView(
          onCoordinatorReady: { coordinator in
            activeCoordinator = coordinator
          },
          onVaultReady: { syncService, drain, vaultKey, userId in
            activeSyncService = syncService
            activeDrain = drain
            currentVaultKey = vaultKey
            currentUserId = userId
          }
        )
        .onOpenURL { url in
          // Forward Universal Link callbacks to the active coordinator.
          // The coordinator's handleUniversalLink is a no-op if no session is pending.
          if let coordinator = activeCoordinator {
            Task { await coordinator.handleUniversalLink(url) }
          }
        }

        // App-Switcher snapshot blur: overlay when scene is .inactive (the transition
        // used by the App Switcher). Using .inactive rather than .background because iOS
        // takes the snapshot during the .inactive phase — .background fires too late.
        if scenePhase != .active {
          Rectangle()
            .background(.ultraThinMaterial)
            .ignoresSafeArea()
        }
      }
      .onChange(of: scenePhase) { _, newPhase in
        // Per plan §"Foreground sync (primary path)": drain flags then re-sync on foreground.
        if newPhase == .active {
          Task {
            guard let vaultKey = currentVaultKey else { return }
            // 1. Drain any rollback flags written by the AutoFill extension.
            if let drain = activeDrain {
              await drain.drainPendingFlags(vaultKey: vaultKey)
            }
            // 2. Re-sync the encrypted-entries cache.
            guard let syncService = activeSyncService,
                  let userId = currentUserId else { return }
            _ = try? await syncService.runSync(vaultKey: vaultKey, userId: userId)
          }
        }
      }
    }
  }
}
