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
  @State private var appState: AppState = .setup

  // Shared dependency instances kept alive across state transitions
  @State private var bridgeKeyStore: BridgeKeyStore?
  @State private var hostSyncService: HostSyncService?
  @State private var currentVaultKey: SymmetricKey?

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
        SignInView(coordinator: coordinator) { pair in
          // AuthCoordinator already saved tokens in HostTokenStore during sign-in.
          // Build a placeholder API client; Step 8 will thread the real DPoP signer.
          let apiClient = buildAPIClient(serverConfig: config, tokenStore: HostTokenStore())
          appState = .signedIn(serverConfig: config, tokens: pair, apiClient: apiClient)
        }

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
        // Keep "passwd-sso" text for UITest compatibility
        VStack(spacing: 16) {
          Text("passwd-sso")
            .font(.largeTitle.bold())
          Text("Vault locked")
            .foregroundStyle(.secondary)
        }
        .padding()
      }
    }
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
    currentVaultKey = vaultKey

    // Perform initial sync
    let fetcher = EntryFetcher(apiClient: apiClient)
    let syncService = HostSyncService(
      apiClient: apiClient,
      entryFetcher: fetcher,
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: wrappedKeyStore,
      cacheURL: (try? AppGroupContainer.cacheFileURL()) ?? URL(fileURLWithPath: "/dev/null")
    )
    self.hostSyncService = syncService

    // Run initial sync and load cache
    let report = try? await syncService.runSync(
      vaultKey: vaultKey,
      userId: unlockResult.userId
    )

    // Build auto-lock service
    let tokenStore = HostTokenStore()
    let cacheURL = (try? AppGroupContainer.cacheFileURL()) ?? URL(fileURLWithPath: "/dev/null")
    let autoLockService = AutoLockService(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: wrappedKeyStore,
      tokenStore: tokenStore,
      cacheURL: cacheURL
    )

    // Load cache data
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
      // Fallback: empty cache
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

    _ = report  // sync report can be surfaced to UI in a later step

    autoLockService.startTimer()
    appState = .vaultUnlocked(
      vaultKey: vaultKey,
      userId: unlockResult.userId,
      cacheData: cacheData,
      autoLockService: autoLockService,
      apiClient: apiClient
    )
  }

  /// Fallback sync service for the vaultUnlocked state when hostSyncService was not retained.
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

  private func buildAPIClient(serverConfig: ServerConfig, tokenStore: HostTokenStore) -> MobileAPIClient {
    // Placeholder signer — real DPoP signer is built during AuthCoordinator sign-in.
    // Step 8 will close the round-trip by threading the signer into MobileAPIClient via the coordinator.
    let emptySigner = PlaceholderDPoPSigner()
    return MobileAPIClient(
      serverURL: serverConfig.baseURL,
      signer: emptySigner,
      jwk: [:],
      tokenStore: tokenStore
    )
  }
}

// MARK: - ServerConfig TeamID placeholder

private extension ServerConfig {
  var teamId: String { "TEAMID" }
}

// MARK: - Placeholder DPoP signer for the post-sign-in state

private struct PlaceholderDPoPSigner: DPoPSigner, @unchecked Sendable {
  func sign(input: Data) async throws -> Data {
    throw NSError(domain: "PlaceholderSigner", code: -1, userInfo: nil)
  }
}
