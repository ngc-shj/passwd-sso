import AuthenticationServices
import Shared
import SwiftUI

// MARK: - Sign-in state

enum SignInViewState: Equatable {
  case idle
  case signingIn
  case error(message: String)
}

// MARK: - Presentation context bridge

/// Bridges SwiftUI window into `ASWebAuthenticationPresentationContextProviding`.
/// Marked `@MainActor` so all property access is main-thread safe; `@unchecked Sendable`
/// satisfies the `Sendable` requirement in `AuthCoordinator.startSignIn`.
@MainActor
final class WindowProvider: NSObject, ASWebAuthenticationPresentationContextProviding,
  @unchecked Sendable
{
  weak var window: UIWindow?

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    window ?? UIWindow()
  }
}

// MARK: - View

struct SignInView: View {
  let coordinator: AuthCoordinator
  let onSignedIn: (TokenPair) -> Void
  #if DEBUG
  let onDebugVaultReady: (DebugVaultLoader.LoadedState) -> Void
  #endif

  @State private var state: SignInViewState = .idle
  @State private var windowProvider = WindowProvider()

  var body: some View {
    VStack(spacing: 32) {
      Spacer()

      Text("passwd-sso")
        .font(.largeTitle.bold())

      switch state {
      case .idle:
        EmptyView()
      case .signingIn:
        ProgressView("Signing in…")
      case .error(let message):
        Text(message)
          .font(.footnote)
          .foregroundStyle(.red)
          .multilineTextAlignment(.center)
          .padding(.horizontal)
      }

      Button {
        Task { await signIn() }
      } label: {
        Text("Sign in to passwd-sso")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .disabled(state == .signingIn)

      #if DEBUG
      Button("Load Test Vault (DEBUG)") {
        Task { await loadDebugVault() }
      }
      .buttonStyle(.bordered)
      .tint(.orange)
      .disabled(state == .signingIn)
      #endif

      Spacer()
      Spacer()
    }
    .padding()
    .background {
      WindowCapture(windowProvider: windowProvider)
    }
  }

  @MainActor
  private func signIn() async {
    state = .signingIn
    do {
      let pair = try await coordinator.startSignIn(presentationContext: windowProvider)
      onSignedIn(pair)
    } catch AuthError.webAuthCancelled {
      state = .idle
    } catch {
      state = .error(message: error.localizedDescription)
    }
  }

  #if DEBUG
  @MainActor
  private func loadDebugVault() async {
    state = .signingIn
    do {
      try DebugVaultLoader.reset()
      let loadedState = try await DebugVaultLoader.loadFixtureVault()
      onDebugVaultReady(loadedState)
    } catch {
      state = .error(message: "DEBUG: \(error.localizedDescription)")
    }
  }
  #endif
}

// MARK: - Window capture helper

/// Zero-size view that captures the UIWindow from the SwiftUI hierarchy.
private struct WindowCapture: UIViewRepresentable {
  let windowProvider: WindowProvider

  func makeUIView(context: Context) -> UIView {
    let view = UIView()
    view.backgroundColor = .clear
    return view
  }

  func updateUIView(_ uiView: UIView, context: Context) {
    DispatchQueue.main.async {
      windowProvider.window = uiView.window
    }
  }
}
