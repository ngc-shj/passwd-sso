import CryptoKit
import LocalAuthentication
import OSLog
import Shared
import SwiftUI

// MARK: - Root app state

enum AppState {
  /// Pre-restore splash. Initial state on cold launch; replaced by the result of
  /// SessionRestorer.restore() in RootView's .task before anything else renders
  /// (so the URL screen never flashes on a returning launch).
  case launching
  case setup
  case signIn(serverConfig: ServerConfig, coordinator: AuthCoordinator)
  case signedIn(serverConfig: ServerConfig, apiClient: MobileAPIClient)
  /// Transitional splash shown while handleVaultUnlocked runs its async sync,
  /// so the passphrase/Face ID screen does not linger during the unlock→list gap.
  case unlocking
  case vaultUnlocked(
    serverConfig: ServerConfig,
    vaultKey: SymmetricKey,
    userId: String,
    keyVersion: Int,
    cacheData: CacheData,
    autoLockService: AutoLockService,
    apiClient: MobileAPIClient,
    cacheKey: SymmetricKey?
  )
  // Locked but still signed in: re-unlock needs only the passphrase, keeping the
  // server config + token (no OAuth re-sign-in). Carries serverConfig/apiClient
  // so the passphrase screen can call /api/vault/unlock/data again.
  case vaultLocked(serverConfig: ServerConfig, apiClient: MobileAPIClient)
  case demo(DemoVault)
}

// MARK: - Root view

struct RootView: View {
  /// Called when vault is unlocked so the app shell can wire foreground sync +
  /// drain + AutoFill upload-token re-mint.
  let onVaultReady: (HostSyncService, RollbackFlagDrain, SymmetricKey, String, AutofillTokenRefresher?, SymmetricKey) -> Void

  @State private var appState: AppState = .launching

  // Shared dependency instances kept alive across state transitions
  @State private var hostSyncService: HostSyncService?

  /// Error surfaced by the biometric-unlock closure onto the passphrase screen —
  /// e.g. Face ID authenticated but the cacheless resync failed (offline / dead
  /// token / stale legacy cache). Replaces the previous silent bounce.
  @State private var biometricErrorText: String?

  /// Drives in-place re-localization on a language change without re-creating the
  /// view tree (so an open Settings sheet stays open and the vault stays
  /// unlocked). A `bump()` re-runs `body`, which re-reads `languageLocale`.
  @ObservedObject private var languageRefresh = LanguageRefresh.shared

  /// The override locale for the current preference. Reads `languageRefresh.token`
  /// so this value (and thus the `.environment(\.locale,)` it feeds) changes on a
  /// bump, forcing the subtree — including the presented sheet — to re-evaluate.
  private var languageLocale: Locale {
    _ = languageRefresh.token
    return AppSettingsStore().appLanguage.localeOverride ?? .autoupdatingCurrent
  }

  var body: some View {
    Group {
      switch appState {
      case .launching, .unlocking:
        // Neutral splash: launch restoration runs in .task (so the URL screen
        // never flashes); .unlocking covers the post-unlock sync gap.
        launchSplash

      case .setup:
        ServerURLSetupView(
          onReady: { config in
            let tokenStore = HostTokenStore()
            let coordinator = AuthCoordinator(serverConfig: config, tokenStore: tokenStore)
            appState = .signIn(serverConfig: config, coordinator: coordinator)
          },
          onEnterDemo: {
            if let demo = try? DemoVaultFactory.makeDemoVault() {
              appState = .demo(demo)
            }
          }
        )

      case .signIn(let config, let coordinator):
        makeSignInView(config: config, coordinator: coordinator)

      case .signedIn(let serverConfig, let apiClient):
        // Arriving via sign-in / app entry → auto-prompt Face ID on appear.
        vaultLockedScreen(serverConfig: serverConfig, apiClient: apiClient, autoPromptOnAppear: true)

      case .vaultUnlocked(let serverConfig, let vaultKey, let userId, let keyVersion, let cacheData, let autoLockService, let apiClient, let cacheKey):
        VaultListView(
          cacheData: cacheData,
          vaultKey: vaultKey,
          userId: userId,
          keyVersion: keyVersion,
          autoLockService: autoLockService,
          apiClient: apiClient,
          hostSyncService: hostSyncService ?? makeFallbackSyncService(apiClient: apiClient),
          cacheKey: cacheKey
        )
        .onChange(of: autoLockService.state) { _, newState in
          switch newState {
          case .locked:
            // Lock drops the vault key + bridge key, but keeps the server config
            // and token: re-unlock needs only the passphrase, not a full sign-in.
            appState = .vaultLocked(serverConfig: serverConfig, apiClient: apiClient)
            // Clear QuickType identities — no inline hints for a locked vault.
            Task { await CredentialIdentityRegistrar().clear() }
          case .loggedOut(let reason):
            // Tokens/cache already cleared by signOut(). Manual Sign Out routes to
            // the URL screen (the deliberate change-server path); an idle-timeout
            // logout skips it and goes straight to sign-in (the server is known).
            switch reason {
            case .manual:
              appState = .setup
            case .idleTimeout:
              appState = .signIn(
                serverConfig: serverConfig,
                coordinator: AuthCoordinator(serverConfig: serverConfig)
              )
            }
            // Single chokepoint for clearing the tenant policy + QuickType
            // (mirrors the extension clearing it on disconnect). Runs for both
            // reasons — both are full sign-outs.
            AppSettingsStore().clearTenantPolicy()
            Task { await CredentialIdentityRegistrar().clear() }
          case .unlocked:
            break
          }
        }

      case .vaultLocked(let serverConfig, let apiClient):
        // Re-unlock via passphrase (token still valid). The "Sign in again"
        // fallback covers an expired/invalid token.
        VStack(spacing: 16) {
          // Reached by an in-app lock (explicit Lock / idle timeout) → do NOT
          // auto-prompt on appear (it would re-unlock instantly while the user
          // is present). A real foreground re-entry still auto-prompts (scenePhase).
          vaultLockedScreen(serverConfig: serverConfig, apiClient: apiClient, autoPromptOnAppear: false)
          Button("Sign in again") {
            // Skip the URL screen on explicit re-auth — the server config is
            // already known. A fresh coordinator reuses the persisted SE key.
            appState = .signIn(
              serverConfig: serverConfig,
              coordinator: AuthCoordinator(serverConfig: serverConfig)
            )
          }
          .buttonStyle(.bordered)
          .controlSize(.large)
          .padding(.bottom)
        }

      case .demo(let demo):
        DemoVaultView(demo: demo, onExit: { appState = .setup })
      }
    }
    // Re-evaluate content bodies in place on a language change so already-rendered
    // Text("…") / L10n.string(…) re-resolve against the freshly-applied
    // LanguageBundle. We read `languageRefresh.token` via `.environment` below
    // (NOT `.id`, which would re-create the subtree and dismiss the open Settings
    // sheet — theme switching keeps the sheet open, language must match). RootView
    // observes `languageRefresh`, so a bump re-runs this body; the changed
    // `\.locale` environment propagates the invalidation into descendants
    // (including the presented sheet, which inherits the environment).
    .environment(\.locale, languageLocale)
    .task {
      // One-shot launch restoration. Guard on .launching so a later view
      // re-appear does not re-run it.
      guard case .launching = appState else { return }
      let result = await SessionRestorer.live().restore()
      switch result {
      case .needsSetup:
        appState = .setup
      case .needsSignIn(let config):
        appState = .signIn(
          serverConfig: config,
          coordinator: AuthCoordinator(serverConfig: config)
        )
      case .needsUnlock(let config, let apiClient):
        appState = .signedIn(serverConfig: config, apiClient: apiClient)
      case .needsReauth(let config, let apiClient):
        // Refresh failed (dead session OR transient server error — ambiguous at
        // launch). Route to the unlock-or-resign-in screen: local unlock of the
        // cached vault works offline, and "Sign in again" re-auths. No
        // destructive cleanup (the signal is not reliably "revoked").
        appState = .vaultLocked(serverConfig: config, apiClient: apiClient)
      }
    }
  }

  /// Neutral branded splash for `.launching` / `.unlocking`.
  private var launchSplash: some View {
    VStack(spacing: 24) {
      Text("passwd-sso").font(.largeTitle.bold())
      ProgressView()
    }
  }

  // MARK: - Sign-in view factory

  @ViewBuilder
  private func makeSignInView(config: ServerConfig, coordinator: AuthCoordinator) -> some View {
    SignInView(
      coordinator: coordinator,
      serverURL: config.baseURL,
      onSignedIn: { _ in
        Task { @MainActor in
          let apiClient = await buildRealAPIClient(
            serverConfig: config,
            coordinator: coordinator
          )
          appState = .signedIn(serverConfig: config, apiClient: apiClient)
        }
      },
      onEnterDemo: {
        if let demo = try? DemoVaultFactory.makeDemoVault() {
          appState = .demo(demo)
        }
      }
    )
  }

  // MARK: - Vault locked / unlock entry

  private func vaultLockedScreen(
    serverConfig: ServerConfig,
    apiClient: MobileAPIClient,
    autoPromptOnAppear: Bool
  ) -> some View {
    let bks = BridgeKeyStore()
    let wks = AppGroupWrappedKeyStore()
    let cacheURL = (try? AppGroupContainer.cacheFileURL()) ?? URL(fileURLWithPath: "/dev/null")
    let unlocker = VaultUnlocker(
      apiClient: apiClient,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL
    )

    // Compute biometric availability synchronously (nonisolated, no actor hop).
    let laContext = LAContext()
    let biometricsAvailable = unlocker.biometricUnlockAvailable()
      && laContext.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)

    // Human-readable label derived from the detected biometry type.
    let biometryLabel: String
    switch laContext.biometryType {
    // Apple product names — localized system-side, kept literal here.
    case .faceID:  biometryLabel = "Face ID"
    case .touchID: biometryLabel = "Touch ID"
    default:       biometryLabel = L10n.string("biometrics")
    }

    let biometricUnlock: (@MainActor @Sendable () async -> Void)?
    if biometricsAvailable {
      biometricUnlock = { @MainActor @Sendable in
        // Clear any prior banner at the start of an attempt.
        biometricErrorText = nil
        do {
          let result = try await unlocker.unlockWithBiometrics(
            reason: L10n.string("Unlock your passwd-sso vault.")
          )
          let outcome = await handleVaultUnlocked(
            unlockResult: result,
            serverConfig: serverConfig,
            apiClient: apiClient,
            bridgeKeyStore: bks,
            wrappedKeyStore: wks,
            // Offline path: no fresh policy fetch — must not clear a persisted value.
            policyAuthoritative: false
          )
          // Face ID succeeded but the cacheless resync failed — surface an explicit
          // banner instead of the former silent bounce. A dead session routes to
          // "sign in again"; a mere offline failure to "try again with passphrase".
          switch outcome {
          case .reachedVault:
            break
          case .failedSessionExpired:
            biometricErrorText = L10n.string("Your session has expired. Please sign in again.")
          case .failedOffline:
            biometricErrorText = L10n.string(
              "Your session is out of date. Enter your passphrase to unlock.")
          }
        } catch {
          // A biometric cancel / mismatch shows no banner (stays on passphrase
          // screen); any other error surfaces the explicit message.
          biometricErrorText = biometricUnlockError(
            from: error, syncFailedCacheless: false,
            message: L10n.string("Your session is out of date. Enter your passphrase to unlock."))
        }
      }
    } else {
      biometricUnlock = nil
    }

    return VaultUnlockView(
      unlocker: unlocker,
      biometricUnlock: biometricUnlock,
      biometryLabel: biometryLabel,
      autoPromptOnAppear: autoPromptOnAppear,
      externalError: biometricErrorText
    ) { result in
      Task { @MainActor in
        // A passphrase attempt clears any lingering biometric banner.
        biometricErrorText = nil
        _ = await handleVaultUnlocked(
          unlockResult: result,
          serverConfig: serverConfig,
          apiClient: apiClient,
          bridgeKeyStore: bks,
          wrappedKeyStore: wks,
          // Passphrase unlock freshly fetched the policy — authoritative.
          policyAuthoritative: true
        )
      }
    }
  }

  /// Drives the post-unlock sync + state transition. On a cacheless resync failure
  /// with no trustworthy local cache it fails closed to `.vaultLocked` and reports
  /// WHY (dead session vs offline) so the caller shows the correct banner.
  @discardableResult
  @MainActor
  private func handleVaultUnlocked(
    unlockResult: UnlockResult,
    serverConfig: ServerConfig,
    apiClient: MobileAPIClient,
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore,
    policyAuthoritative: Bool
  ) async -> UnlockedResult {
    // MUST be the first statement — regression guard for the post-unlock flicker
    // fix (#3): replaces the passphrase/Face ID screen with the splash before the
    // async sync below, so it does not linger during the unlock→list gap. Do not
    // move below the first await.
    appState = .unlocking

    // Persist the tenant auto-lock policy BEFORE applyPersistedTimeout reads the
    // effective interval. Biometric (non-authoritative) is a no-op so it can't
    // wipe the value persisted by the last passphrase unlock.
    AppSettingsStore().applyTenantPolicy(
      unlockResult.tenantAutoLockMinutes, policyAuthoritative: policyAuthoritative
    )
    let vaultKey = unlockResult.vaultKey

    let fetcher = EntryFetcher(apiClient: apiClient)
    let cacheURL = (try? AppGroupContainer.cacheFileURL()) ?? URL(fileURLWithPath: "/dev/null")
    let syncService = HostSyncService(
      apiClient: apiClient,
      entryFetcher: fetcher,
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: wrappedKeyStore,
      cacheURL: cacheURL
    )
    self.hostSyncService = syncService

    // Build the rollback-flag drain for this session.
    let flagDirectory = (try? AppGroupContainer.url().appending(path: "vault", directoryHint: .isDirectory))
      ?? URL(fileURLWithPath: "/dev/null")
    let drain = RollbackFlagDrain(
      apiClient: apiClient,
      flagDirectory: flagDirectory,
      deviceId: { DeviceIdentifier.stable() }
    )

    // Drain any flags from previous AutoFill cycles before the first sync.
    await drain.drainPendingFlags(vaultKey: vaultKey)

    let syncReport: SyncReport?
    // Whether the sync failed specifically because the session is dead (refresh
    // token expired / replay-revoked). Drives the fail-closed banner choice.
    var sessionExpired = false
    do {
      syncReport = try await syncService.runSync(
        vaultKey: vaultKey, userId: unlockResult.userId, cacheKey: unlockResult.cacheKey)
    } catch {
      // A sync failure here must NOT wipe tokens mid-unlock. When a valid local
      // cache exists we fall back to it (offline-tolerant); when it does not, the
      // caller fails closed and uses `sessionExpired` to pick the banner.
      sessionExpired = syncFailedSessionExpired(from: error)
      // Diagnostic only (no secrets — MobileAPIError cases carry no token data).
      Logger(subsystem: AppGroupContainer.loggerSubsystem, category: "sync")
        .error("unlock-time runSync failed: \(String(describing: error), privacy: .public)")
      syncReport = nil
    }

    let tokenStore = HostTokenStore()
    let autoLockService = AutoLockService(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: wrappedKeyStore,
      tokenStore: tokenStore,
      cacheURL: cacheURL
    )

    // Read the persisted cache AT MOST ONCE, and ONLY when the unlock recovered a
    // valid local cache. On the cacheRecovered==false path we must NEVER re-read the
    // file: the stale/rolled-back cache must not be trusted, and re-reading with a
    // second (independent) expectedCounter would re-open a counter-splice window (S2).
    let persistedCache: CacheData?
    if unlockResult.cacheRecovered, let blob = try? bridgeKeyStore.readDirect() {
      persistedCache = try? readCacheFile(
        path: cacheURL,
        vaultKey: vaultKey,
        expectedHostInstallUUID: blob.hostInstallUUID,
        expectedCounter: blob.cacheVersionCounter
      )
    } else {
      persistedCache = nil
    }

    let outcome = decidePostSync(
      syncReport: syncReport,
      cacheRecovered: unlockResult.cacheRecovered,
      persistedCache: persistedCache
    )

    let cacheData: CacheData
    switch outcome {
    case .useFreshCache:
      // Use the cache the sync just built in-memory. Re-reading the encrypted file
      // here races the write on the first unlock (fresh bridge-key counter/UUID
      // window), which left the list empty until a second unlock.
      cacheData = syncReport?.cacheData ?? persistedCache ?? emptyCacheData(userId: unlockResult.userId)
    case .useLocalCache:
      // Sync failed (e.g. offline) — fall back to the last persisted cache.
      cacheData = persistedCache ?? emptyCacheData(userId: unlockResult.userId)
    case .useEmptyCache:
      // Valid unlock, sync failed, no persisted cache — a brand-new / first-offline
      // vault. Present an empty vault (the passphrase was valid → this is success).
      cacheData = emptyCacheData(userId: unlockResult.userId)
    case .failLocked:
      // Face ID recovered the vault key but the resync failed and there is no
      // trustworthy local cache. Fail closed to the locked screen (never present an
      // empty vault as success) and let the caller surface an explicit error —
      // "sign in again" for a dead session, "try again" when merely offline.
      appState = .vaultLocked(serverConfig: serverConfig, apiClient: apiClient)
      return failClosedResult(sessionExpired: sessionExpired)
    }

    // Recover the authoritative keyVersion from the synced entries when a fresh sync
    // succeeded (the biometric cacheless path defaults keyVersion=1, which must NOT
    // reach the server on a later create/edit). Falls back to the unlock's value.
    let effectiveKeyVersion = syncedKeyVersion(from: syncReport) ?? unlockResult.keyVersion

    // Mint + stage the AutoFill upload token (plan C6 — passkey registration).
    // Best-effort: a mint failure must not affect the unlock flow.
    let tokenRefresher = AutofillTokenRefresher(apiClient: apiClient)
    await tokenRefresher.refresh()

    onVaultReady(syncService, drain, vaultKey, unlockResult.userId, tokenRefresher, unlockResult.cacheKey)

    // Register QuickType inline-suggestion identities for the just-synced set
    // (personal + team — team requires the REAL cacheKey from unlock to unwrap
    // the persisted team keys; readDirect's bridge_key is empty).
    await refreshCredentialIdentities(
      from: cacheData, vaultKey: vaultKey, userId: unlockResult.userId,
      cacheKey: unlockResult.cacheKey, wrappedKeyStore: AppGroupWrappedKeyStore())

    applyPersistedTimeout(to: autoLockService)
    autoLockService.startTimer()
    appState = .vaultUnlocked(
      serverConfig: serverConfig,
      vaultKey: vaultKey,
      userId: unlockResult.userId,
      keyVersion: effectiveKeyVersion,
      cacheData: cacheData,
      autoLockService: autoLockService,
      apiClient: apiClient,
      cacheKey: unlockResult.cacheKey
    )
    return .reachedVault
  }

  /// Synthesize an empty cache for the degenerate fallback (no fresh sync, no
  /// persisted cache, but cacheRecovered==true so this is a benign offline case).
  private func emptyCacheData(userId: String) -> CacheData {
    CacheData(
      header: CacheHeader(
        cacheVersionCounter: 0,
        cacheIssuedAt: Date(),
        lastSuccessfulRefreshAt: Date(),
        entryCount: 0,
        hostInstallUUID: Data(repeating: 0, count: 16),
        userId: userId
      ),
      entries: "[]".data(using: .utf8)!
    )
  }

  /// Derive the authoritative keyVersion from a completed sync's entries (first
  /// personal entry), matching `VaultUnlocker.unlockWithBiometrics`. Returns nil when
  /// the sync did not surface a cache.
  private func syncedKeyVersion(from syncReport: SyncReport?) -> Int? {
    guard let entriesData = syncReport?.cacheData?.entries,
          let entries = try? JSONDecoder().decode([CacheEntry].self, from: entriesData)
    else { return nil }
    return max(1, entries.first(where: { $0.teamId == nil })?.keyVersion ?? 1)
  }

  /// Restore the persisted auto-lock timeout onto a freshly-created service
  /// before its timer starts. Applied at every unlock site (real + DEBUG).
  @MainActor
  private func applyPersistedTimeout(to service: AutoLockService) {
    let store = AppSettingsStore()
    // Effective = tenant override (if any) else the user's setting.
    service.autoLockMinutes = store.effectiveAutoLockMinutes
    service.timeoutAction = store.vaultTimeoutAction
  }

  private func makeFallbackSyncService(apiClient: MobileAPIClient) -> HostSyncService {
    let bks = BridgeKeyStore()
    let wks = AppGroupWrappedKeyStore()
    let fetcher = EntryFetcher(apiClient: apiClient)
    let cacheURL = (try? AppGroupContainer.cacheFileURL()) ?? URL(fileURLWithPath: "/dev/null")
    return HostSyncService(
      apiClient: apiClient,
      entryFetcher: fetcher,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      cacheURL: cacheURL
    )
  }

  /// Build an API client using the real SE signer from the coordinator.
  /// Falls back to a no-op signer if the key is not available.
  @MainActor
  private func buildRealAPIClient(
    serverConfig: ServerConfig,
    coordinator: AuthCoordinator
  ) async -> MobileAPIClient {
    let signer: any DPoPSigner
    let jwk: [String: String]
    let tokenStore: HostTokenStore
    if let realSigner = try? await coordinator.currentSigner(),
       let realJWK = try? await coordinator.currentJWK() {
      signer = realSigner
      jwk = realJWK
    } else {
      signer = NoOpDPoPSigner()
      jwk = [:]
    }
    tokenStore = coordinator.tokenStore
    return MobileAPIClient(
      serverURL: serverConfig.baseURL,
      signer: signer,
      jwk: jwk,
      tokenStore: tokenStore
    )
  }
}


// MARK: - No-op DPoP signer (replaces PlaceholderDPoPSigner)

/// Used only when the SE key is not yet available (before sign-in completes).
/// Any call to sign() will throw, preventing accidental use of unsigned proofs.
private struct NoOpDPoPSigner: DPoPSigner, @unchecked Sendable {
  func sign(input: Data) async throws -> Data {
    throw NSError(domain: "NoOpDPoPSigner", code: -1, userInfo: [
      NSLocalizedDescriptionKey: "DPoP key not loaded — sign in first",
    ])
  }
}
