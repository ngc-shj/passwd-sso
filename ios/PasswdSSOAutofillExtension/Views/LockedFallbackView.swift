import AuthenticationServices
import SwiftUI

/// Shown when the vault is locked (bridge_key not in Keychain).
/// Prompts the user to open the host app to unlock.
struct LockedFallbackView: View {
  let onOpen: () -> Void
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

          Text("Open passwd-sso to unlock your vault, then return here to fill.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal)
        }

        Button("Open passwd-sso") {
          onOpen()
        }
        .buttonStyle(.borderedProminent)
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
