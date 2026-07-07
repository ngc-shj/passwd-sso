import SwiftUI
import Shared
import UIKit

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
    case .system: L10n.string("System")
    case .light: L10n.string("Light")
    case .dark: L10n.string("Dark")
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
    case .system: L10n.string("System")
    case .ja: L10n.string("日本語")
    case .en: L10n.string("English")
    }
  }
}

/// App settings, mirroring the browser extension's options: auto-lock timeout,
/// vault timeout action, clipboard auto-clear, and theme.
@MainActor
struct SettingsView: View {
  let autoLockService: AutoLockService
  let apiClient: MobileAPIClient

  @Environment(\.dismiss) private var dismiss
  @AppStorage("appTheme", store: .appGroup) private var theme: AppTheme = .system
  private let store = AppSettingsStore()

  /// Observed so THIS sheet re-evaluates its own body on a language change.
  /// The sheet is presented in a detached context; relying on the presenter's
  /// `\.locale` environment to propagate across the sheet boundary proved
  /// unreliable, so the sheet subscribes to the refresh directly and re-resolves
  /// its `Text("…")` / `L10n.string(…)` in place (the resolution layer is not
  /// memoized) while staying open.
  @ObservedObject private var languageRefresh = LanguageRefresh.shared

  /// Mirror of the stored language preference, driving the picker selection.
  @State private var language: AppLanguage = AppSettingsStore().appLanguage

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

  private var autoCopyCustomFieldSelection: Binding<Bool> {
    Binding(
      get: { store.autoCopyCustomField },
      set: { newValue in
        store.autoCopyCustomField = newValue
        autoLockService.recordActivity()
      }
    )
  }

  private var faviconSelection: Binding<Bool> {
    Binding(
      get: { store.fetchFaviconsCached },
      set: { newValue in
        store.fetchFaviconsCached = newValue
        Task { try? await apiClient.setFaviconPref(newValue) }
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
        // Apply immediately (no restart): re-points Bundle.main string lookup
        // and bumps the app-wide refresh token so rendered views re-localize.
        store.applyAppLanguage()
        LanguageRefresh.shared.bump()
        autoLockService.recordActivity()
      }
    )
  }

  /// Current server URL — surfaced here because launch restoration skips the
  /// setup screen, so this is the only place a signed-in user can confirm it.
  private var serverURLDisplay: String {
    loadServerConfig()?.baseURL.absoluteString ?? L10n.string("Not configured")
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
          Toggle("Auto-copy custom field after fill", isOn: autoCopyCustomFieldSelection)
        } header: {
          Text("Clipboard")
        } footer: {
          Text("When on, filling a login that has a one-time-code copies the current code to the clipboard so you can paste it. The clipboard clears after the time above and never syncs to your other devices.\n\nCustom-field auto-copy copies a single non-hidden custom field after a fill; hidden fields are never auto-copied (copy them from the entry instead). A one-time-code takes priority for the clipboard.")
        }

        Section {
          Toggle("Show site icons", isOn: faviconSelection)
        } header: {
          Text("Icons")
        } footer: {
          Text("When on, entry domain names are sent to the passwd-sso server to fetch site icons.")
        }

        Section("Appearance") {
          Picker("Theme", selection: $theme) {
            ForEach(AppTheme.allCases, id: \.self) { option in
              Text(option.label).tag(option)
            }
          }
        }

        Section("Language") {
          Picker("Language", selection: languageSelection) {
            ForEach(AppLanguage.allCases, id: \.self) { option in
              Text(option.label).tag(option)
            }
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

        Section {
          LabeledContent("Version") {
            Text(AppVersion.display())
              .foregroundStyle(.secondary)
          }
        }
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .task {
        if let on = try? await apiClient.getFaviconPref() {
          store.fetchFaviconsCached = on
        }
      }
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    // A `.sheet` is presented in its own context and does NOT inherit the
    // WindowGroup's `.preferredColorScheme`, so the sheet must set its own to stay
    // in sync with the app behind it. We pass a CONCRETE scheme (never `nil`):
    // `.preferredColorScheme(nil)` does not revert a previously-applied override
    // on a sheet, so `.system` would get stuck on whatever was last forced
    // (e.g. System→Light→System left the sheet on Light). For `.system` we resolve
    // the device's actual appearance and pass that explicitly.
    .preferredColorScheme(sheetColorScheme)
  }

  /// The sheet's color scheme. For an explicit `.light`/`.dark` theme, that scheme;
  /// for `.system`, the device's CURRENT appearance resolved concretely (so we
  /// never pass `nil`, which a sheet will not honor as a revert).
  ///
  /// Reads the device style from the active window scene's trait, NOT
  /// `UITraitCollection.current` — the latter reflects the *effective* (possibly
  /// overridden) trait of the view being drawn, so under this sheet's own
  /// `.preferredColorScheme` it would feed back the forced value instead of the
  /// device setting. The window-scene trait is independent of per-view overrides.
  private var sheetColorScheme: ColorScheme {
    if let override = theme.colorScheme { return override }
    // Prefer the foreground-active window scene; `connectedScenes` is unordered
    // and may briefly lack an active scene mid-transition or hold several under
    // multi-window. Fall back to the current trait rather than hard-coding a
    // scheme so a dark device is never momentarily mis-tinted light.
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let deviceStyle = (scenes.first { $0.activationState == .foregroundActive } ?? scenes.first)?
      .traitCollection.userInterfaceStyle ?? UITraitCollection.current.userInterfaceStyle
    return deviceStyle == .dark ? .dark : .light
  }
}
