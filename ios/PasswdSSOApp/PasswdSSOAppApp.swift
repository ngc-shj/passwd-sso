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
      // Identity register/clear are fire-and-forget Tasks. On scene thrash the
      // `.active` re-sync+register is the last writer once the app settles
      // foreground, so any transient inconsistency self-heals; the `.background`
      // clear is the privacy boundary (the blur overlay covers `.inactive`).
      .onChange(of: scenePhase) { _, newPhase in
        switch newPhase {
        case .active:
          // Per plan §"Foreground sync (primary path)": drain flags then re-sync.
          Task {
            guard let vaultKey = currentVaultKey else { return }
            // 1. Drain any rollback flags written by the AutoFill extension.
            if let drain = activeDrain {
              await drain.drainPendingFlags(vaultKey: vaultKey)
            }
            // 2. Re-sync the encrypted-entries cache.
            guard let syncService = activeSyncService,
                  let userId = currentUserId else { return }
            let report = try? await syncService.runSync(vaultKey: vaultKey, userId: userId)
            // 3. Re-register QuickType identities for the freshly-synced set.
            if let cacheData = report?.cacheData {
              let summaries = decryptPersonalOverviews(
                from: cacheData, vaultKey: vaultKey, userId: userId
              )
              await CredentialIdentityRegistrar().replace(with: summaries)
            }
          }
        case .background:
          // No inline-suggestion identities while not foreground+unlocked.
          Task { await CredentialIdentityRegistrar().clear() }
        case .inactive:
          break
        @unknown default:
          break
        }
      }
      .preferredColorScheme(theme.colorScheme)
      .task {
        // Launch invariant: a crash/reboot can strand identities in the OS store
        // (it survives termination). Clear at launch so "vault locked ⇒ no inline
        // suggestions" holds; they repopulate only after a successful unlock+sync.
        await CredentialIdentityRegistrar().clear()
      }
    }
  }
}
