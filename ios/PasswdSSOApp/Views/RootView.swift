import Shared
import SwiftUI

// MARK: - Root app state

enum AppState {
  case setup
  case signIn(serverConfig: ServerConfig, coordinator: AuthCoordinator)
  case signedIn(tokens: TokenPair)
  case vaultLocked
}

// MARK: - Root view

struct RootView: View {
  let onCoordinatorReady: (AuthCoordinator) -> Void
  @State private var appState: AppState = .setup

  var body: some View {
    switch appState {
    case .setup:
      ServerURLSetupView { config in
        let tokenStore = HostTokenStore()
        let coordinator = AuthCoordinator(serverConfig: config, tokenStore: tokenStore)
        onCoordinatorReady(coordinator)
        appState = .signIn(serverConfig: config, coordinator: coordinator)
      }

    case .signIn(_, let coordinator):
      SignInView(coordinator: coordinator) { pair in
        appState = .signedIn(tokens: pair)
      }

    case .signedIn:
      // Vault unlock / browse UI arrives in Step 7.
      // Keep "passwd-sso" text so PasswdSSOUITests.testAppLaunches continues to pass.
      VStack(spacing: 16) {
        Text("passwd-sso")
          .font(.largeTitle.bold())
        Text("Vault locked — unlock coming in Step 7")
          .foregroundStyle(.secondary)
      }
      .padding()

    case .vaultLocked:
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
