import SwiftUI

/// App settings. Currently hosts the auto-lock timeout, matching the browser
/// extension's fixed options (5/15/30/60 min, no "Never").
@MainActor
struct SettingsView: View {
  let autoLockService: AutoLockService

  @Environment(\.dismiss) private var dismiss
  private let store = AutoLockSettingsStore()

  private static let options = [5, 15, 30, 60]

  /// Drives the picker from the live service; writing updates the service,
  /// persists the choice, and resets the idle clock so shortening the window
  /// while Settings is open does not immediately auto-lock.
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

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("Auto-Lock", selection: autoLockSelection) {
            ForEach(Self.options, id: \.self) { minutes in
              Text("\(minutes) minutes").tag(minutes)
            }
          }
        } footer: {
          Text(
            "The vault locks after this much idle time. AutoFill needs the app "
              + "unlocked within this window; each fill still requires Face ID."
          )
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
