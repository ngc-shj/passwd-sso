import AuthenticationServices
import SwiftUI

/// Shown when the vault is locked (bridge_key not in Keychain). Credential
/// provider extensions have no supported API to launch the host app, so this
/// only instructs the user to open passwd-sso manually, then dismisses.
struct LockedFallbackView: View {
  let onDismiss: () -> Void

  var body: some View {
    NavigationStack {
      VStack(spacing: 24) {
        Spacer()

        Image(systemName: "lock.fill")
          .font(.system(size: 56))
          .foregroundStyle(.secondary)

        VStack(spacing: 8) {
          Text("Vault is Locked")
            .font(.title2)
            .fontWeight(.semibold)

          Text("Open the passwd-sso app and unlock your vault, then come back here to fill.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal)
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
