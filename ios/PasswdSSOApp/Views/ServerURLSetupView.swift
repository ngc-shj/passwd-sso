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

  init(defaults: UserDefaults = UserDefaults(suiteName: "group.com.passwd-sso.shared") ?? .standard) {
    self.defaults = defaults
  }

  @MainActor
  func continueButtonTapped() async {
    let trimmed = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = parseAndValidate(trimmed) else {
      state = .probeFailed("Enter a valid https:// URL (http:// allowed for localhost).")
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

    let isLocalhost = host == "localhost" || host.hasSuffix(".localhost.localdomain")

    guard scheme == "https" || (scheme == "http" && isLocalhost) else { return nil }
    components.path = ""
    components.query = nil
    components.fragment = nil
    return components.url
  }

  /// Probe AASA reachability and /api/health/live.
  private func probeServer(_ base: URL) async throws {
    async let aasaCheck: Void = fetchURL(base.appending(path: "/.well-known/apple-app-site-association", directoryHint: .notDirectory))
    async let healthCheck: Void = fetchURL(base.appending(path: "/api/health/live", directoryHint: .notDirectory))
    _ = try await (aasaCheck, healthCheck)
  }

  private func fetchURL(_ url: URL) async throws {
    var request = URLRequest(url: url)
    request.timeoutInterval = 10
    let (_, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode < 500 else {
      throw ProbeError.unreachable(url.absoluteString)
    }
  }

  private func persist(_ config: ServerConfig) {
    guard let data = try? JSONEncoder().encode(config) else { return }
    defaults.set(data, forKey: "serverConfig")
  }
}

private enum ProbeError: LocalizedError {
  case unreachable(String)

  var errorDescription: String? {
    switch self {
    case .unreachable(let url): "Could not reach \(url). Check the URL and your network."
    }
  }
}

// MARK: - View

struct ServerURLSetupView: View {
  @State private var viewModel = ServerURLSetupViewModel()
  let onReady: (ServerConfig) -> Void

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
        .disabled(viewModel.urlText.isEmpty || {
          if case .probing = viewModel.state { return true }
          return false
        }())

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
