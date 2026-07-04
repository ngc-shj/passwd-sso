import CryptoKit
import Foundation
import Shared
import SwiftUI

/// Passphrase entry screen that drives VaultUnlocker.
/// When `biometricUnlock` is non-nil, a "Unlock with \(biometryLabel)" button is shown
/// above the passphrase field, and biometric unlock auto-prompts ONLY on a genuine
/// foreground RE-ENTRY (background → active), never when the vault locks while the app
/// is already active (explicit Lock or idle timeout). Auto-prompting on appear re-unlocked
/// instantly the moment the user locked while looking at the device; gating on a real
/// foreground transition keeps in-app locks "stuck" on the lock screen while still
/// auto-prompting when the user comes back to the app.
struct VaultUnlockView: View {
  let unlocker: VaultUnlocker
  let onUnlocked: @MainActor (UnlockResult) -> Void
  /// Non-nil when biometric re-unlock is available. Nil = passphrase-only.
  let biometricUnlock: (@MainActor @Sendable () async -> Void)?
  /// Human-readable biometry label derived from LAContext.biometryType by the caller.
  let biometryLabel: String
  /// True when this screen is reached by ENTERING the app (sign-in / launch) — auto-prompt
  /// on appear. False when reached by an in-app lock (explicit Lock / idle timeout) — stay
  /// locked on appear (a later foreground re-entry still auto-prompts via scenePhase).
  let autoPromptOnAppear: Bool
  /// Error surfaced by the parent's biometric-unlock closure (e.g. a cacheless resync
  /// failed after a successful Face ID). Takes precedence over the view's own
  /// passphrase-attempt error; nil = no external error.
  let externalError: String?

  @Environment(\.scenePhase) private var scenePhase
  @State private var passphrase: String = ""
  @State private var isLoading: Bool = false
  /// Armed only by a `.background` phase, so auto-prompt fires on the next `.active`
  /// (a real foreground re-entry) — NOT when the lock screen first appears in-app
  /// (no scene transition) and NOT on a `.inactive`→`.active` blip (Control Center).
  @State private var autoPromptArmed: Bool = false
  @State private var errorMessage: String?

  init(
    unlocker: VaultUnlocker,
    biometricUnlock: (@MainActor @Sendable () async -> Void)? = nil,
    biometryLabel: String = L10n.string("biometrics"),
    autoPromptOnAppear: Bool = false,
    externalError: String? = nil,
    onUnlocked: @MainActor @escaping (UnlockResult) -> Void
  ) {
    self.unlocker = unlocker
    self.biometricUnlock = biometricUnlock
    self.biometryLabel = biometryLabel
    self.autoPromptOnAppear = autoPromptOnAppear
    self.externalError = externalError
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

      if let error = resolveDisplayError(external: externalError, internalError: errorMessage) {
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
    .onAppear {
      // Sign-in / app-entry arrival → auto-prompt. An in-app lock (autoPromptOnAppear
      // == false) surfaces this screen without prompting (stays locked).
      if autoPromptOnAppear { fireBiometricPrompt() }
    }
    .onChange(of: scenePhase) { _, newPhase in
      switch newPhase {
      case .background:
        // A real app exit — arm auto-prompt for the next foreground re-entry.
        autoPromptArmed = true
      case .active:
        guard autoPromptArmed else { return }
        autoPromptArmed = false
        fireBiometricPrompt()
      default:
        break
      }
    }
  }

  /// Invoke the biometric unlock once, if available and not already unlocking.
  private func fireBiometricPrompt() {
    guard !isLoading, let biometricUnlock else { return }
    Task { @MainActor in await biometricUnlock() }
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
      errorMessage = L10n.string("Incorrect passphrase. Please try again.")
      passphrase = ""
      isLoading = false
    } catch {
      errorMessage = L10n.string("Unable to unlock vault. Check your connection and try again.")
      isLoading = false
    }
  }
}
