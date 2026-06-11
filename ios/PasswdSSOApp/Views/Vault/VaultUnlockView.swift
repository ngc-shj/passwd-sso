import CryptoKit
import Foundation
import Shared
import SwiftUI

/// Passphrase entry screen that drives VaultUnlocker.
/// When `biometricUnlock` is non-nil, a "Unlock with \(biometryLabel)" button is shown
/// above the passphrase field. It is NOT auto-triggered: locking must show the lock
/// screen and stay locked until the user explicitly taps the button (auto-prompting on
/// appear re-unlocked instantly the moment the user locked while looking at the device).
struct VaultUnlockView: View {
  let unlocker: VaultUnlocker
  let onUnlocked: @MainActor (UnlockResult) -> Void
  /// Non-nil when biometric re-unlock is available. Nil = passphrase-only.
  let biometricUnlock: (@MainActor @Sendable () async -> Void)?
  /// Human-readable biometry label derived from LAContext.biometryType by the caller.
  let biometryLabel: String

  @State private var passphrase: String = ""
  @State private var isLoading: Bool = false
  @State private var errorMessage: String?

  init(
    unlocker: VaultUnlocker,
    biometricUnlock: (@MainActor @Sendable () async -> Void)? = nil,
    biometryLabel: String = "biometrics",
    onUnlocked: @MainActor @escaping (UnlockResult) -> Void
  ) {
    self.unlocker = unlocker
    self.biometricUnlock = biometricUnlock
    self.biometryLabel = biometryLabel
    self.onUnlocked = onUnlocked
  }

  var body: some View {
    VStack(spacing: 24) {
      Text("passwd-sso")
        .font(.largeTitle.bold())

      Text("Enter your master passphrase to unlock the vault.")
        .font(.body)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)

      if let biometricUnlock {
        Button {
          Task { @MainActor in await biometricUnlock() }
        } label: {
          Label("Unlock with \(biometryLabel)", systemImage: "faceid")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
      }

      SecureField("Master passphrase", text: $passphrase)
        .textContentType(.password)
        .submitLabel(.go)
        .onSubmit { Task { await attemptUnlock() } }
        // Match the ServerURLSetupView URL-field baseline (≈52pt tap height)
        // rather than the compact .roundedBorder style.
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))

      if let error = errorMessage {
        Text(error)
          .font(.caption)
          .foregroundStyle(.red)
      }

      Button("Unlock") {
        Task { await attemptUnlock() }
      }
      .buttonStyle(.bordered)
      .controlSize(.large)
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
