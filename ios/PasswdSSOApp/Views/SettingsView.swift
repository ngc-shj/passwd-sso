import SwiftUI
import Shared

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

extension AppLanguage {
  /// Picker label. `.system` reuses the existing translated "System" catalog key
  /// (also used by the theme picker; en "System" / ja "システム") — safe because it
  /// is an existing key, not because it is untranslated. The endonyms `.ja`/`.en`
  /// are separate `shouldTranslate:false` catalog entries, so `String(localized:)`
  /// returns the key literal ("日本語"/"English") identically in both locales and
  /// they do not trip the catalog-completeness test.
  var label: String {
    switch self {
    case .system: String(localized: "System")
    case .ja: String(localized: "日本語")
    case .en: String(localized: "English")
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

  /// Mirror of the stored language preference so the picker updates immediately
  /// even though the rendered language only flips on relaunch (restart-to-apply).
  @State private var language: AppLanguage = AppSettingsStore().appLanguage
  /// True once the user picks a language whose resolved code differs from the
  /// one the app launched with — i.e. a relaunch is needed to apply it.
  @State private var pendingRestart = false
  /// The localization the app resolved at launch; the restart-notice comparison
  /// is done in resolved-code space so picking the already-active language shows
  /// no notice.
  private let launchEffectiveCode = Bundle.main.preferredLocalizations.first

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

  private var autoCopyTotpSelection: Binding<Bool> {
    Binding(
      get: { store.autoCopyTotp },
      set: { newValue in
        store.autoCopyTotp = newValue
        autoLockService.recordActivity()
      }
    )
  }

  private var languageSelection: Binding<AppLanguage> {
    Binding(
      get: { language },
      set: { newValue in
        language = newValue
        store.appLanguage = newValue
        // Show the restart notice only when the choice actually changes the
        // resolved language from what the app launched with.
        pendingRestart = newValue.effectiveCode != launchEffectiveCode
        autoLockService.recordActivity()
      }
    )
  }

  /// Current server URL — surfaced here because launch restoration skips the
  /// setup screen, so this is the only place a signed-in user can confirm it.
  private var serverURLDisplay: String {
    loadServerConfig()?.baseURL.absoluteString ?? String(localized: "Not configured")
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

        Section {
          Picker("Auto-Clear", selection: clipboardSelection) {
            ForEach(AppSettingsStore.clipboardOptions, id: \.self) { seconds in
              Text("\(seconds) seconds").tag(seconds)
            }
          }
          Toggle("Auto-copy TOTP after fill", isOn: autoCopyTotpSelection)
        } header: {
          Text("Clipboard")
        } footer: {
          Text("When on, filling a login that has a one-time-code copies the current code to the clipboard so you can paste it. The clipboard clears after the time above and never syncs to your other devices.")
        }

        Section("Appearance") {
          Picker("Theme", selection: $theme) {
            ForEach(AppTheme.allCases, id: \.self) { option in
              Text(option.label).tag(option)
            }
          }
        }

        Section {
          Picker("Language", selection: languageSelection) {
            ForEach(AppLanguage.allCases, id: \.self) { option in
              Text(option.label).tag(option)
            }
          }
        } header: {
          Text("Language")
        } footer: {
          if pendingRestart {
            Text("Language changed. Restart the app to apply.")
          }
        }

        Section {
          LabeledContent("URL") {
            Text(serverURLDisplay)
              .foregroundStyle(.secondary)
              .textSelection(.enabled)
          }
        } header: {
          Text("Server")
        } footer: {
          Text("To use a different server, sign out and set up again.")
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
