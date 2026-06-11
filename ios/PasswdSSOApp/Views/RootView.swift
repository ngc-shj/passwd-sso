import CryptoKit
import LocalAuthentication
import Shared
import SwiftUI

// MARK: - Root app state

enum AppState {
  case setup
  case signIn(serverConfig: ServerConfig, coordinator: AuthCoordinator)
  case signedIn(serverConfig: ServerConfig, tokens: TokenPair, apiClient: MobileAPIClient)
  case vaultUnlocked(
    serverConfig: ServerConfig,
    vaultKey: SymmetricKey,
    userId: String,
    keyVersion: Int,
    cacheData: CacheData,
    autoLockService: AutoLockService,
    apiClient: MobileAPIClient
  )
  // Locked but still signed in: re-unlock needs only the passphrase, keeping the
  // server config + token (no OAuth re-sign-in). Carries serverConfig/apiClient
  // so the passphrase screen can call /api/vault/unlock/data again.
  case vaultLocked(serverConfig: ServerConfig, apiClient: MobileAPIClient)
}

// MARK: - Root view

struct RootView: View {
  /// Called when vault is unlocked so the app shell can wire foreground sync + drain.
  let onVaultReady: (HostSyncService, RollbackFlagDrain, SymmetricKey, String) -> Void

  @State private var appState: AppState = .setup

  // Shared dependency instances kept alive across state transitions
  @State private var hostSyncService: HostSyncService?

  var body: some View {
    Group {
      switch appState {
      case .setup:
        ServerURLSetupView { config in
          let tokenStore = HostTokenStore()
          let coordinator = AuthCoordinator(serverConfig: config, tokenStore: tokenStore)
          appState = .signIn(serverConfig: config, coordinator: coordinator)
        }

      case .signIn(let config, let coordinator):
        makeSignInView(config: config, coordinator: coordinator)

      case .signedIn(let serverConfig, _, let apiClient):
        // Arriving via sign-in / app entry → auto-prompt Face ID on appear.
        vaultLockedScreen(serverConfig: serverConfig, apiClient: apiClient, autoPromptOnAppear: true)

      case .vaultUnlocked(let serverConfig, let vaultKey, let userId, let keyVersion, let cacheData, let autoLockService, let apiClient):
        VaultListView(
          cacheData: cacheData,
          vaultKey: vaultKey,
          userId: userId,
          keyVersion: keyVersion,
          autoLockService: autoLockService,
          apiClient: apiClient,
          hostSyncService: hostSyncService ?? makeFallbackSyncService(apiClient: apiClient)
        )
        .onChange(of: autoLockService.state) { _, newState in
          switch newState {
          case .locked:
            // Lock drops the vault key + bridge key, but keeps the server config
            // and token: re-unlock needs only the passphrase, not a full sign-in.
            appState = .vaultLocked(serverConfig: serverConfig, apiClient: apiClient)
            // Clear QuickType identities — no inline hints for a locked vault.
            Task { await CredentialIdentityRegistrar().clear() }
          case .loggedOut:
            // Logout-on-timeout cleared tokens/cache — route to setup/sign-in.
            appState = .setup
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
            appState = .setup
          }
          .buttonStyle(.bordered)
          .controlSize(.large)
          .padding(.bottom)
        }
      }
    }
  }

  // MARK: - Sign-in view factory

  @ViewBuilder
  private func makeSignInView(config: ServerConfig, coordinator: AuthCoordinator) -> some View {
    #if DEBUG
    SignInView(
      coordinator: coordinator,
      onSignedIn: { pair in
        Task { @MainActor in
          let apiClient = await buildRealAPIClient(
            serverConfig: config,
            coordinator: coordinator
          )
          appState = .signedIn(serverConfig: config, tokens: pair, apiClient: apiClient)
        }
      },
      onDebugVaultReady: { state in
        handleDebugVaultLoaded(state, serverConfig: config, coordinator: coordinator)
      }
    )
    #else
    SignInView(
      coordinator: coordinator,
      onSignedIn: { pair in
        Task { @MainActor in
          let apiClient = await buildRealAPIClient(
            serverConfig: config,
            coordinator: coordinator
          )
          appState = .signedIn(serverConfig: config, tokens: pair, apiClient: apiClient)
        }
      }
    )
    #endif
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
    default:       biometryLabel = String(localized: "biometrics")
    }

    let biometricUnlock: (@MainActor @Sendable () async -> Void)?
    if biometricsAvailable {
      biometricUnlock = { @MainActor @Sendable in
        do {
          let result = try await unlocker.unlockWithBiometrics(
            reason: String(localized: "Unlock your passwd-sso vault.")
          )
          await handleVaultUnlocked(
            unlockResult: result,
            serverConfig: serverConfig,
            apiClient: apiClient,
            bridgeKeyStore: bks,
            wrappedKeyStore: wks
          )
        } catch {
          // Biometric cancel/fail → silent fallback to passphrase
        }
      }
    } else {
      biometricUnlock = nil
    }

    return VaultUnlockView(
      unlocker: unlocker,
      biometricUnlock: biometricUnlock,
      biometryLabel: biometryLabel,
      autoPromptOnAppear: autoPromptOnAppear
    ) { result in
      Task { @MainActor in
        await handleVaultUnlocked(
          unlockResult: result,
          serverConfig: serverConfig,
          apiClient: apiClient,
          bridgeKeyStore: bks,
          wrappedKeyStore: wks
        )
      }
    }
  }

  @MainActor
  private func handleVaultUnlocked(
    unlockResult: UnlockResult,
    serverConfig: ServerConfig,
    apiClient: MobileAPIClient,
    bridgeKeyStore: BridgeKeyStore,
    wrappedKeyStore: any WrappedKeyStore
  ) async {
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

    let syncReport = try? await syncService.runSync(vaultKey: vaultKey, userId: unlockResult.userId)

    let tokenStore = HostTokenStore()
    let autoLockService = AutoLockService(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: wrappedKeyStore,
      tokenStore: tokenStore,
      cacheURL: cacheURL
    )

    let cacheData: CacheData
    if let freshCache = syncReport?.cacheData {
      // Use the cache the sync just built in-memory. Re-reading the encrypted
      // file here races the write on the first unlock (fresh bridge-key
      // counter/UUID window), which left the list empty until a second unlock.
      cacheData = freshCache
    } else if let blob = try? bridgeKeyStore.readDirect(), let data = try? readCacheFile(
      path: cacheURL,
      vaultKey: vaultKey,
      expectedHostInstallUUID: blob.hostInstallUUID,
      expectedCounter: blob.cacheVersionCounter
    ) {
      // Sync failed (e.g. offline) — fall back to the last persisted cache.
      cacheData = data
    } else {
      cacheData = CacheData(
        header: CacheHeader(
          cacheVersionCounter: 0,
          cacheIssuedAt: Date(),
          lastSuccessfulRefreshAt: Date(),
          entryCount: 0,
          hostInstallUUID: Data(repeating: 0, count: 16),
          userId: unlockResult.userId
        ),
        entries: "[]".data(using: .utf8)!
      )
    }

    onVaultReady(syncService, drain, vaultKey, unlockResult.userId)

    // Register QuickType inline-suggestion identities for the just-synced set.
    await refreshCredentialIdentities(cacheData: cacheData, vaultKey: vaultKey, userId: unlockResult.userId)

    applyPersistedTimeout(to: autoLockService)
    autoLockService.startTimer()
    appState = .vaultUnlocked(
      serverConfig: serverConfig,
      vaultKey: vaultKey,
      userId: unlockResult.userId,
      keyVersion: unlockResult.keyVersion,
      cacheData: cacheData,
      autoLockService: autoLockService,
      apiClient: apiClient
    )
  }

  /// Restore the persisted auto-lock timeout onto a freshly-created service
  /// before its timer starts. Applied at every unlock site (real + DEBUG).
  @MainActor
  private func applyPersistedTimeout(to service: AutoLockService) {
    let store = AppSettingsStore()
    service.autoLockMinutes = store.minutes
    service.timeoutAction = store.vaultTimeoutAction
  }

  /// Replace the QuickType credential-identity set from the freshly-synced
  /// personal entries. Identities exist only while unlocked (cleared on
  /// lock/logout/background/launch).
  @MainActor
  private func refreshCredentialIdentities(
    cacheData: CacheData, vaultKey: SymmetricKey, userId: String
  ) async {
    let summaries = decryptPersonalOverviews(from: cacheData, vaultKey: vaultKey, userId: userId)
    await CredentialIdentityRegistrar().replace(with: summaries)
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

  #if DEBUG
  /// Transition directly to .vaultUnlocked using the fixture state loaded by DebugVaultLoader.
  /// The apiClient uses a NoOpDPoPSigner since the DEBUG vault doesn't sync.
  @MainActor
  private func handleDebugVaultLoaded(
    _ state: DebugVaultLoader.LoadedState,
    serverConfig: ServerConfig,
    coordinator: AuthCoordinator
  ) {
    let debugApiClient = MobileAPIClient(
      serverURL: URL(string: "https://debug.local")!,
      signer: NoOpDPoPSigner(),
      jwk: [:],
      tokenStore: HostTokenStore()
    )
    let bks = BridgeKeyStore()
    let wks = AppGroupWrappedKeyStore()
    let cacheURL = (try? AppGroupContainer.cacheFileURL()) ?? URL(fileURLWithPath: "/dev/null")
    let autoLockService = AutoLockService(
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      tokenStore: HostTokenStore(),
      cacheURL: cacheURL
    )
    applyPersistedTimeout(to: autoLockService)
    autoLockService.startTimer()
    let cacheData = state.cacheData
    let vaultKey = state.vaultKey
    let userId = state.userId
    Task { await refreshCredentialIdentities(cacheData: cacheData, vaultKey: vaultKey, userId: userId) }
    appState = .vaultUnlocked(
      serverConfig: serverConfig,
      vaultKey: state.vaultKey,
      userId: state.userId,
      keyVersion: state.keyVersion,
      cacheData: state.cacheData,
      autoLockService: autoLockService,
      apiClient: debugApiClient
    )
  }
  #endif
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
