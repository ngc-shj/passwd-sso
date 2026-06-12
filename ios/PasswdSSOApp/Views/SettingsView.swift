import SwiftUI

extension AppTheme {
  var colorScheme: ColorScheme? {
    switch self {
    case .system: nil
    case .light: .light
    case .dark: .dark
    }
  }

  var label: String {
    switch self {
    case .system: String(localized: "System")
    case .light: String(localized: "Light")
    case .dark: String(localized: "Dark")
    }
  }
}

/// App settings, mirroring the browser extension's options: auto-lock timeout,
/// vault timeout action, clipboard auto-clear, and theme.
@MainActor
struct SettingsView: View {
  let autoLockService: AutoLockService

  @Environment(\.dismiss) private var dismiss
  @AppStorage("appTheme", store: .appGroup) private var theme: AppTheme = .system
  private let store = AppSettingsStore()

  private static let lockOptions = [5, 15, 30, 60]

  /// True when the tenant enforces an auto-lock interval (overrides the user's).
  private var isTenantEnforced: Bool { store.tenantAutoLockMinutes != nil }

  /// Picker options: the standard set, plus the enforced value when it isn't one
  /// of them (so the disabled picker renders the enforced value instead of blank).
  private var autoLockOptions: [Int] {
    if let enforced = store.tenantAutoLockMinutes, !Self.lockOptions.contains(enforced) {
      return Self.lockOptions + [enforced]
    }
    return Self.lockOptions
  }

  private var autoLockSelection: Binding<Int> {
    Binding(
      get: { autoLockService.autoLockMinutes },
      set: { newValue in
        autoLockService.autoLockMinutes = newValue
        store.minutes = newValue
        autoLockService.recordActivity()
      }
    )
  }

  private var timeoutActionSelection: Binding<VaultTimeoutAction> {
    Binding(
      get: { autoLockService.timeoutAction },
      set: { newValue in
        autoLockService.timeoutAction = newValue
        store.vaultTimeoutAction = newValue
        autoLockService.recordActivity()
      }
    )
  }

  private var clipboardSelection: Binding<Int> {
    Binding(
      get: { store.clipboardClearSeconds },
      set: { newValue in
        store.clipboardClearSeconds = newValue
        autoLockService.recordActivity()
      }
    )
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("Auto-Lock", selection: autoLockSelection) {
            ForEach(autoLockOptions, id: \.self) { minutes in
              Text("\(minutes) minutes").tag(minutes)
            }
          }
          // Disabled when the tenant enforces the interval (the value still shows
          // via the autoLockOptions extra entry above).
          .disabled(isTenantEnforced)
          Picker("On Timeout", selection: timeoutActionSelection) {
            Text("Lock").tag(VaultTimeoutAction.lock)
            Text("Log Out").tag(VaultTimeoutAction.logout)
          }
        } header: {
          Text("Security")
        } footer: {
          VStack(alignment: .leading, spacing: 4) {
            // Single string literal (not `+` concatenation) so it binds the
            // LocalizedStringKey overload and extracts as one catalog key.
            Text("The vault locks after this much idle time (\"Log Out\" also clears the session). AutoFill needs the app unlocked within this window; each fill still requires Face ID.")
            if isTenantEnforced {
              Text("Set by your organization.")
            }
          }
        }

        Section("Clipboard") {
          Picker("Auto-Clear", selection: clipboardSelection) {
            ForEach(AppSettingsStore.clipboardOptions, id: \.self) { seconds in
              Text("\(seconds) seconds").tag(seconds)
            }
          }
        }

        Section("Appearance") {
          Picker("Theme", selection: $theme) {
            ForEach(AppTheme.allCases, id: \.self) { option in
              Text(option.label).tag(option)
            }
          }
        }
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}
