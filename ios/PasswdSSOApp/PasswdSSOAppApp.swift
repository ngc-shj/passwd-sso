import CryptoKit
import Shared
import SwiftUI

@main
struct PasswdSSOAppApp: App {
  // The OAuth sign-in callback (passwd-sso:// custom scheme) is captured
  // directly by ASWebAuthenticationSession inside AuthCoordinator, so the app
  // shell does not need to forward any incoming URLs.
  @State private var activeSyncService: HostSyncService?
  @State private var activeDrain: RollbackFlagDrain?
  @State private var currentVaultKey: SymmetricKey?
  @State private var currentUserId: String?

  @Environment(\.scenePhase) private var scenePhase
  @AppStorage("appTheme", store: .appGroup) private var theme: AppTheme = .system

  var body: some Scene {
    WindowGroup {
      ZStack {
        RootView(
          onVaultReady: { syncService, drain, vaultKey, userId in
            activeSyncService = syncService
            activeDrain = drain
            currentVaultKey = vaultKey
            currentUserId = userId
          }
        )

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
      .preferredColorScheme(theme.colorScheme)
    }
  }
}
