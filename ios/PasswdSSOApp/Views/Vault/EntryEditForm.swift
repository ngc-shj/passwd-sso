import CryptoKit
import Foundation
import Shared
import SwiftUI

// MARK: - EntryForm

/// Unified form for creating and editing personal vault entries.
/// Mode `.create` presents an empty form; `.edit` pre-fills from an existing entry.
/// Tags are not editable on iOS (preserved server-side); a footnote explains this.
@MainActor
struct EntryForm: View {
  enum Mode {
    case create
    case edit(summary: VaultEntrySummary, initial: VaultEntryDetail)
  }

  let mode: Mode
  let vaultKey: SymmetricKey
  let userId: String
  let keyVersion: Int
  @Bindable var viewModel: VaultViewModel
  let apiClient: MobileAPIClient
  let hostSyncService: HostSyncService
  var cacheKey: SymmetricKey? = nil

  @State private var title: String
  @State private var username: String
  @State private var password: String
  @State private var url: String
  @State private var notes: String
  @State private var totpSecret: String

  @State private var isSaving: Bool = false
  @State private var saveError: String? = nil

  @Environment(\.dismiss) private var dismiss

  init(
    mode: Mode,
    vaultKey: SymmetricKey,
    userId: String,
    keyVersion: Int,
    viewModel: VaultViewModel,
    apiClient: MobileAPIClient,
    hostSyncService: HostSyncService,
    cacheKey: SymmetricKey? = nil
  ) {
    self.mode = mode
    self.vaultKey = vaultKey
    self.userId = userId
    self.keyVersion = keyVersion
    self.viewModel = viewModel
    self.apiClient = apiClient
    self.hostSyncService = hostSyncService
    self.cacheKey = cacheKey

    switch mode {
    case .create:
      _title = State(initialValue: "")
      _username = State(initialValue: "")
      _password = State(initialValue: "")
      _url = State(initialValue: "")
      _notes = State(initialValue: "")
      _totpSecret = State(initialValue: "")
    case .edit(_, let initial):
      _title = State(initialValue: initial.title)
      _username = State(initialValue: initial.username)
      _password = State(initialValue: initial.password)
      _url = State(initialValue: initial.url)
      _notes = State(initialValue: initial.notes)
      _totpSecret = State(initialValue: initial.totpSecret ?? "")
    }
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("Title") {
          TextField("Title", text: $title)
        }

        Section("Username") {
          TextField("Username", text: $username)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }

        Section("Password") {
          SecureField("Password", text: $password)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }

        Section("URL") {
          TextField("https://example.com", text: $url)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
        }

        Section("Notes") {
          TextField("Notes", text: $notes, axis: .vertical)
            .lineLimit(3...6)
        }

        Section("TOTP Secret") {
          SecureField("TOTP secret (optional)", text: $totpSecret)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }

        Section {
          Text("Tags, custom fields, generator settings, and password history are kept on save — edit those in the web app.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        if let error = saveError {
          Section {
            Text(error)
              .foregroundStyle(.red)
              .font(.caption)
          }
        }
      }
      .navigationTitle(navigationTitle)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            Task { await save() }
          }
          .disabled(!canSave || isSaving)
        }
      }
      .disabled(isSaving)
    }
  }

  // MARK: - Private

  // LocalizedStringKey (not String) so `.navigationTitle(_:)` binds the
  // localizing overload — a String variable would render untranslated.
  private var navigationTitle: LocalizedStringKey {
    switch mode {
    case .create: return "New Entry"
    case .edit: return "Edit Entry"
    }
  }

  private var canSave: Bool {
    switch mode {
    case .create:
      // Allow save when title or password is non-empty.
      return !title.isEmpty || !password.isEmpty
    case .edit(_, let initial):
      return hasChanges(from: initial)
    }
  }

  private func hasChanges(from initial: VaultEntryDetail) -> Bool {
    title != initial.title ||
    username != initial.username ||
    password != initial.password ||
    url != initial.url ||
    notes != initial.notes ||
    totpSecret != (initial.totpSecret ?? "")
    // Tags excluded — not editable on iOS.
  }

  private func save() async {
    isSaving = true
    saveError = nil
    defer { isSaving = false }

    let fields = EditableEntryFields(
      title: title,
      username: username,
      password: password,
      url: url,
      notes: notes,
      totpSecret: totpSecret
    )

    do {
      switch mode {
      case .create:
        try await viewModel.createEntry(
          userId: userId,
          fields: fields,
          vaultKey: vaultKey,
          keyVersion: keyVersion,
          apiClient: apiClient,
          hostSyncService: hostSyncService,
          cacheKey: cacheKey
        )
      case .edit(let summary, _):
        try await viewModel.saveEntry(
          entryId: summary.id,
          userId: userId,
          fields: fields,
          vaultKey: vaultKey,
          keyVersion: keyVersion,
          apiClient: apiClient,
          hostSyncService: hostSyncService,
          cacheKey: cacheKey
        )
      }
      dismiss()
    } catch {
      saveError = EntryForm.saveErrorMessage(for: error)
    }
  }

  /// Map a save error to a user-facing, localized message. Pure and
  /// `nonisolated` so it is unit-testable without MainActor dispatch.
  /// Does not interpolate `error.localizedDescription` — that would leak
  /// internal `MobileAPIError` case labels/associated values into the UI.
  // TODO(ios-quota-exceeded-message): consider MobileAPIError: LocalizedError
  // for richer per-case save messages instead of one generic fallback.
  nonisolated static func saveErrorMessage(for error: Error) -> String {
    if (error as? MobileAPIError) == .quotaExceeded {
      return String(localized: "You've reached your vault's item limit. Remove unused items and try again.")
    }
    return String(localized: "Could not save. Please try again.")
  }
}
