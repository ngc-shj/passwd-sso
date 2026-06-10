import CryptoKit
import Foundation
import Shared
import SwiftUI

/// Passphrase entry screen that drives VaultUnlocker.
struct VaultUnlockView: View {
  let unlocker: VaultUnlocker
  let onUnlocked: @MainActor (UnlockResult) -> Void

  @State private var passphrase: String = ""
  @State private var isLoading: Bool = false
  @State private var errorMessage: String?

  var body: some View {
    VStack(spacing: 24) {
      Text("passwd-sso")
        .font(.largeTitle.bold())

      Text("Enter your master passphrase to unlock the vault.")
        .font(.body)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)

      SecureField("Master passphrase", text: $passphrase)
        .textFieldStyle(.roundedBorder)
        .textContentType(.password)
        .submitLabel(.go)
        .onSubmit { Task { await attemptUnlock() } }

      if let error = errorMessage {
        Text(error)
          .font(.caption)
          .foregroundStyle(.red)
      }

      Button("Unlock") {
        Task { await attemptUnlock() }
      }
      .buttonStyle(.borderedProminent)
      .disabled(passphrase.isEmpty || isLoading)

      if isLoading {
        ProgressView()
      }
    }
    .padding(32)
  }

  // MARK: - Private

  private func attemptUnlock() async {
    isLoading = true
    errorMessage = nil
    do {
      let result = try await unlocker.unlock(passphrase: passphrase)
      passphrase = ""
      // Keep isLoading = true on success: the parent runs the initial entry
      // sync before swapping in the vault list. Resetting here would re-show
      // this passphrase screen (without the spinner) during that ~1s gap.
      await MainActor.run {
        onUnlocked(result)
      }
    } catch VaultUnlockError.invalidPassphrase {
      errorMessage = "Incorrect passphrase. Please try again."
      passphrase = ""
      isLoading = false
    } catch {
      errorMessage = "Unable to unlock vault. Check your connection and try again."
      isLoading = false
    }
  }
}
