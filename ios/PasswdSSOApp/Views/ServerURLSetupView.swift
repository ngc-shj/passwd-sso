import Foundation
import Shared
import SwiftUI

// MARK: - View model

@Observable
final class ServerURLSetupViewModel: @unchecked Sendable {
  enum State: Equatable {
    case idle
    case probing
    case probeFailed(String)
    case ready(ServerConfig)
  }

  var urlText: String = ""
  var state: State = .idle

  private let defaults: UserDefaults
  private let trustService: ServerTrustService

  init(
    defaults: UserDefaults = UserDefaults(suiteName: AppGroupContainer.identifier) ?? .standard,
    trustService: ServerTrustService = ServerTrustService()
  ) {
    self.defaults = defaults
    self.trustService = trustService
    // Pre-fill the last successfully-probed server URL so it isn't re-typed
    // on every launch.
    if let config = loadServerConfig(defaults: defaults) {
      self.urlText = config.baseURL.absoluteString
    }
  }

  @MainActor
  func continueButtonTapped() async {
    let trimmed = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = parseAndValidate(trimmed) else {
      state = .probeFailed(L10n.string("Enter a valid https:// URL."))
      return
    }

    state = .probing
    do {
      try await probeServer(url)
      let config = ServerConfig(baseURL: url)
      persist(config)
      state = .ready(config)
    } catch {
      state = .probeFailed(error.localizedDescription)
    }
  }

  // MARK: - Helpers

  private func parseAndValidate(_ raw: String) -> URL? {
    guard
      var components = URLComponents(string: raw),
      let scheme = components.scheme?.lowercased(),
      let host = components.host
    else { return nil }

    guard scheme == "https" else { return nil }
    // Preserve basePath in the path component (e.g. "/passwd-sso") — every
    // API call from MobileAPIClient appends to baseURL, so a basePath-mounted
    // deployment requires the path to remain. Trailing slash trimmed for
    // canonical URL building downstream.
    if components.path.hasSuffix("/") {
      components.path = String(components.path.dropLast())
    }
    components.query = nil
    components.fragment = nil
    return components.url
  }

  /// Validate the exact passwd-sso health contract and establish the TLS pin.
  private func probeServer(_ base: URL) async throws {
    try await trustService.establishTrust(
      serverURL: base,
      healthURL: base.appending(path: APIPath.healthLive, directoryHint: .notDirectory)
    )
  }

  private func persist(_ config: ServerConfig) {
    saveServerConfig(config, defaults: defaults)
  }
}

// MARK: - View

struct ServerURLSetupView: View {
  @State private var viewModel = ServerURLSetupViewModel()
  let onReady: (ServerConfig) -> Void
  var onEnterDemo: (() -> Void)? = nil

  var body: some View {
    NavigationStack {
      VStack(spacing: 24) {
        Spacer()

        Text("passwd-sso")
          .font(.largeTitle.bold())

        Text("Enter your passwd-sso server URL to get started.")
          .multilineTextAlignment(.center)
          .foregroundStyle(.secondary)

        TextField("https://my.passwd-sso.example", text: $viewModel.urlText)
          .accessibilityIdentifier("server-setup-url-field")
          .keyboardType(.URL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .textContentType(.URL)
          .submitLabel(.done)
          .onSubmit { Task { await viewModel.continueButtonTapped() } }
          .padding()
          .background(Color(.secondarySystemBackground))
          .clipShape(RoundedRectangle(cornerRadius: 10))

        if case .probeFailed(let message) = viewModel.state {
          Text(message)
            .font(.footnote)
            .foregroundStyle(.red)
            .multilineTextAlignment(.center)
        }

        Button {
          Task { await viewModel.continueButtonTapped() }
        } label: {
          if case .probing = viewModel.state {
            ProgressView()
              .frame(maxWidth: .infinity)
          } else {
            Text("Continue")
              .frame(maxWidth: .infinity)
          }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .accessibilityIdentifier("server-setup-primary-button")
        .disabled(viewModel.urlText.isEmpty || {
          if case .probing = viewModel.state { return true }
          return false
        }())

        if let onEnterDemo {
          Button {
            onEnterDemo()
          } label: {
            Text("Try Demo Mode")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)
          .controlSize(.large)
          .accessibilityIdentifier("server-setup-demo-button")
        }

        Spacer()
        Spacer()
      }
      .padding()
      .navigationTitle("Server Setup")
      .navigationBarTitleDisplayMode(.inline)
      .onChange(of: viewModel.state) { _, newState in
        if case .ready(let config) = newState {
          onReady(config)
        }
      }
    }
  }
}
