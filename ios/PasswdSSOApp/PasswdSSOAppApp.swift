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
  @State private var currentCacheKey: SymmetricKey?
  @State private var activeTokenRefresher: AutofillTokenRefresher?

  private let backgroundSyncContext = BackgroundSyncContext()

  @Environment(\.scenePhase) private var scenePhase
  @AppStorage("appTheme", store: .appGroup) private var theme: AppTheme = .system

  init() {
    // BGTaskScheduler mandates registering the launch handler before the app
    // finishes launching; the sync state arrives later via onVaultReady.
    let context = backgroundSyncContext
    BackgroundSyncTask.register(
      syncService: { context.currentSyncService() },
      vaultKey: { context.currentVaultKey() },
      userId: { context.currentUserId() },
      cacheKey: { context.currentCacheKey() }
    )
  }

  var body: some Scene {
    WindowGroup {
      ZStack {
        RootView(
          onVaultReady: { syncService, drain, vaultKey, userId, tokenRefresher, cacheKey in
            activeSyncService = syncService
            activeDrain = drain
            currentVaultKey = vaultKey
            currentUserId = userId
            currentCacheKey = cacheKey
            activeTokenRefresher = tokenRefresher
            backgroundSyncContext.update(
              syncService: syncService, vaultKey: vaultKey, userId: userId, cacheKey: cacheKey
            )
            BackgroundSyncTask.scheduleNext()
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
            // 0. Re-mint the short-lived AutoFill upload token (plan C6) so a
            // passkey registration started soon after foregrounding finds a
            // live token. Best-effort; independent of the sync result below.
            if let refresher = activeTokenRefresher {
              await refresher.refresh()
            }
            // 1. Drain any rollback flags written by the AutoFill extension.
            if let drain = activeDrain {
              await drain.drainPendingFlags(vaultKey: vaultKey)
            }
            // 2. Re-sync the encrypted-entries cache.
            guard let syncService = activeSyncService,
                  let userId = currentUserId else { return }
            let report: SyncReport?
            do {
              report = try await syncService.runSync(
                vaultKey: vaultKey, userId: userId, cacheKey: currentCacheKey)
            } catch MobileAPIError.authenticationRequired {
              // Refresh token dead — no recovery in background; just stop.
              return
            } catch {
              // Transient error — keep using cached data; do nothing.
              return
            }
            // 3. Re-register QuickType identities for the freshly-synced set
            //    (personal + team via cacheKey-unwrapped team keys).
            if let cacheData = report?.cacheData {
              await refreshCredentialIdentities(
                from: cacheData, vaultKey: vaultKey, userId: userId,
                cacheKey: currentCacheKey, wrappedKeyStore: AppGroupWrappedKeyStore()
              )
            }
          }
        case .background:
          // Do NOT clear credential identities on background. Using a passkey
          // requires leaving passwd-sso for the relying-party app (e.g. Safari),
          // which backgrounds us — clearing here unregistered the passkey before
          // the ceremony reached it, so iOS fell back to the non-interactive
          // prepareCredentialList path where the biometric bridge_key read is
          // disallowed (errSecInteractionNotAllowed / -25308 → "Vault is Locked").
          // Identities are non-secret metadata (the fill is still biometric-gated
          // in the extension); they are cleared on vault lock / sign-out (RootView)
          // and at launch (crash recovery), which is the real privacy boundary.
          //
          // Refresh the pending BGTask request so the 15-min cache top-up window
          // starts from the moment we actually went to background.
          if backgroundSyncContext.currentVaultKey() != nil {
            BackgroundSyncTask.scheduleNext()
          }
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
