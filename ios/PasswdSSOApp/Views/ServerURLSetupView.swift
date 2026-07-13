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
    /// A pin already exists for this URL but the probe failed — the server's TLS
    /// identity may have legitimately rotated (cert renewal) OR an attacker is
    /// on-path. Recovery requires an explicit user action so it stays fail-closed
    /// against a silent MITM.
    case trustMismatch(URL)
    case ready(ServerConfig)
  }

  var urlText: String = ""
  var state: State = .idle

  private let defaults: UserDefaults
  private let trustService: ServerTrustService

  init(
    defaults: UserDefaults = UserDefaults(suiteName: AppGroupContainer.identifier) ?? .standard,
    trustService: ServerTrustService = ServerTrustService(),
    reverifyURL: URL? = nil
  ) {
    self.defaults = defaults
    self.trustService = trustService
    // Pre-fill the last successfully-probed server URL so it isn't re-typed
    // on every launch.
    if let config = loadServerConfig(defaults: defaults) {
      self.urlText = config.baseURL.absoluteString
    }
    // Launched because a pinned server's TLS identity changed: open directly on
    // the re-verify affordance for that URL, rather than a blank setup screen.
    if let reverifyURL {
      self.urlText = reverifyURL.absoluteString
      self.state = .trustMismatch(reverifyURL)
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
      // A probe failure with an existing pin is the TLS-rotation / MITM fork:
      // offer explicit re-verification instead of a dead-end error.
      if await trustService.currentPinExists(for: url) {
        state = .trustMismatch(url)
      } else {
        state = .probeFailed(error.localizedDescription)
      }
    }
  }

  /// Re-verify a server whose stored pin no longer matches. Only reachable from
  /// an explicit user tap on the trust-mismatch prompt. Atomic: the old pin is
  /// replaced ONLY after the new certificate passes verification, so a failed
  /// re-verification leaves the existing pin intact (no lockout, no unpinned
  /// window).
  @MainActor
  func reverifyServerIdentity(_ url: URL) async {
    state = .probing
    do {
      try await trustService.reestablishTrust(
        serverURL: url,
        healthURL: url.appending(path: APIPath.healthLive, directoryHint: .notDirectory)
      )
      let config = ServerConfig(baseURL: url)
      persist(config)
      state = .ready(config)
    } catch {
      // Old pin is still in place; keep the mismatch affordance so the user can
      // retry rather than dropping to a dead-end error.
      state = .trustMismatch(url)
    }
  }

  // MARK: - Helpers

  private func parseAndValidate(_ raw: String) -> URL? {
    guard
      var components = URLComponents(string: raw),
      let scheme = components.scheme?.lowercased(),
      components.host?.isEmpty == false
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
  @State private var viewModel: ServerURLSetupViewModel
  let onReady: (ServerConfig) -> Void
  var onEnterDemo: (() -> Void)?

  /// `reverifyURL` non-nil opens the screen directly in the trust-mismatch state
  /// for a pinned server whose TLS identity changed (launch-restore routing).
  init(
    reverifyURL: URL? = nil,
    onReady: @escaping (ServerConfig) -> Void,
    onEnterDemo: (() -> Void)? = nil
  ) {
    _viewModel = State(wrappedValue: ServerURLSetupViewModel(reverifyURL: reverifyURL))
    self.onReady = onReady
    self.onEnterDemo = onEnterDemo
  }

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

        if case .trustMismatch(let url) = viewModel.state {
          VStack(spacing: 12) {
            Text("This server's security identity has changed since you last connected. This can happen after a certificate renewal — or it can indicate someone is intercepting the connection. Only re-verify if you expected this change.")
              .font(.footnote)
              .foregroundStyle(.orange)
              .multilineTextAlignment(.center)

            Button(role: .destructive) {
              Task { await viewModel.reverifyServerIdentity(url) }
            } label: {
              Text("Re-verify server identity")
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .accessibilityIdentifier("server-setup-reverify-button")
          }
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
