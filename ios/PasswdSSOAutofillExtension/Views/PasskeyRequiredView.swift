import SwiftUI
import UIKit

/// Shown before a passkey registration is cancelled because the server refused
/// it with `PASSKEY_REQUIRED` (the host's AutoFill-token mint, or this upload):
/// the tenant requires the member to register a passkey on the web first, and
/// until then passwd-sso cannot save passkeys.
///
/// The system sheet shows no reason for a provider's cancel, so this view is
/// the only place the user learns why. A credential provider extension cannot
/// open URLs or launch apps, so the passkey page is shown as copyable text
/// rather than a link. Dismissing cancels the request; iOS then lets the user
/// pick another passkey provider (e.g. iCloud Keychain) for this site.
struct PasskeyRequiredView: View {
  /// The web passkey page, or nil when no server is configured.
  let passkeySettingsURL: URL?
  let onDismiss: () -> Void

  @State private var copied = false

  var body: some View {
    NavigationStack {
      VStack(spacing: 24) {
        Spacer()

        Image(systemName: "person.badge.key")
          .font(.system(size: 56))
          .foregroundStyle(.secondary)

        VStack(spacing: 8) {
          Text("Passkey Required")
            .font(.title2)
            .fontWeight(.semibold)

          Text("Your organization requires a passkey for your passwd-sso account. Until you register one in your browser, passwd-sso can't save new passkeys. For this site, use another passkey provider, such as iCloud Keychain, for now.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal)
        }

        if let passkeySettingsURL {
          VStack(spacing: 8) {
            Text(verbatim: passkeySettingsURL.absoluteString)
              .font(.footnote.monospaced())
              .multilineTextAlignment(.center)
              .textSelection(.enabled)
              .padding(.horizontal)
            Button(copied ? "Copied" : "Copy Link") {
              UIPasteboard.general.string = passkeySettingsURL.absoluteString
              copied = true
            }
            .buttonStyle(.bordered)
          }
        }

        Button("OK") {
          onDismiss()
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .padding(.top, 8)

        Spacer()
      }
      .padding()
      .navigationTitle("passwd-sso")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: onDismiss)
        }
      }
    }
  }
}
