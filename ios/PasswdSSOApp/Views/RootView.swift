import CryptoKit
import Shared
import SwiftUI

// MARK: - Root app state

enum AppState {
  case setup
  case signIn(serverConfig: ServerConfig, coordinator: AuthCoordinator)
  case signedIn(serverConfig: ServerConfig, tokens: TokenPair, apiClient: MobileAPIClient)
  case vaultUnlocked(
    vaultKey: SymmetricKey,
    userId: String,
    cacheData: CacheData,
    autoLockService: AutoLockService,
    apiClient: MobileAPIClient
  )
  case vaultLocked
}

// MARK: - Root view

struct RootView: View {
  let onCoordinatorReady: (AuthCoordinator) -> Void
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
          onCoordinatorReady(coordinator)
          appState = .signIn(serverConfig: config, coordinator: coordinator)
        }

      case .signIn(let config, let coordinator):
        makeSignInView(config: config, coordinator: coordinator)

      case .signedIn(let serverConfig, _, let apiClient):
        vaultLockedScreen(serverConfig: serverConfig, apiClient: apiClient)

      case .vaultUnlocked(let vaultKey, let userId, let cacheData, let autoLockService, let apiClient):
        VaultListView(
          viewModel: VaultViewModel(),
          cacheData: cacheData,
          vaultKey: vaultKey,
          userId: userId,
          autoLockService: autoLockService,
          apiClient: apiClient,
          hostSyncService: hostSyncService ?? makeFallbackSyncService(apiClient: apiClient)
        )
        .onChange(of: autoLockService.state) { _, newState in
          if newState == .locked {
            appState = .vaultLocked
          }
        }

      case .vaultLocked:
        // Auto-lock dropped bridge_key from Keychain; vault must be re-unlocked
        // (in production via passphrase, in DEBUG via fixture reload).
        // Keep "passwd-sso" text for UITest compatibility.
        VStack(spacing: 24) {
          Text("passwd-sso")
            .font(.largeTitle.bold())
          Text("Vault locked")
            .foregroundStyle(.secondary)
          Button("Sign in again") {
            // Reset to setup so the user can re-enter passphrase (or use DEBUG fixture).
            appState = .setup
          }
          .buttonStyle(.borderedProminent)
        }
        .padding()
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

  private func vaultLockedScreen(serverConfig: ServerConfig, apiClient: MobileAPIClient) -> some View {
    let bks = BridgeKeyStore(accessGroup: "\(serverConfig.teamId).com.passwd-sso.shared")
    let wks = AppGroupWrappedKeyStore()
    let unlocker = VaultUnlocker(
      apiClient: apiClient,
      bridgeKeyStore: bks,
      wrappedKeyStore: wks
    )

    return VaultUnlockView(unlocker: unlocker) { result in
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

    _ = try? await syncService.runSync(vaultKey: vaultKey, userId: unlockResult.userId)

    let tokenStore = HostTokenStore()
    let autoLockService = AutoLockService(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: wrappedKeyStore,
      tokenStore: tokenStore,
      cacheURL: cacheURL
    )

    let blob = try? bridgeKeyStore.readDirect()
    let cacheData: CacheData
    if let blob, let data = try? readCacheFile(
      path: cacheURL,
      vaultKey: vaultKey,
      expectedHostInstallUUID: blob.hostInstallUUID,
      expectedCounter: blob.cacheVersionCounter
    ) {
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

    autoLockService.startTimer()
    appState = .vaultUnlocked(
      vaultKey: vaultKey,
      userId: unlockResult.userId,
      cacheData: cacheData,
      autoLockService: autoLockService,
      apiClient: apiClient
    )
  }

  private func makeFallbackSyncService(apiClient: MobileAPIClient) -> HostSyncService {
    let bks = BridgeKeyStore(accessGroup: "TEAMID.com.passwd-sso.shared")
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
    let bks = BridgeKeyStore(accessGroup: AppGroupContainer.identifier)
    let wks = AppGroupWrappedKeyStore()
    let cacheURL = (try? AppGroupContainer.cacheFileURL()) ?? URL(fileURLWithPath: "/dev/null")
    let autoLockService = AutoLockService(
      bridgeKeyStore: bks,
      wrappedKeyStore: wks,
      tokenStore: HostTokenStore(),
      cacheURL: cacheURL
    )
    autoLockService.startTimer()
    appState = .vaultUnlocked(
      vaultKey: state.vaultKey,
      userId: state.userId,
      cacheData: state.cacheData,
      autoLockService: autoLockService,
      apiClient: debugApiClient
    )
  }
  #endif
}

// MARK: - ServerConfig TeamID placeholder

private extension ServerConfig {
  var teamId: String { "TEAMID" }
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
