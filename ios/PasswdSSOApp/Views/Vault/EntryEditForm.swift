import CryptoKit
import Foundation
import Shared
import SwiftUI

/// Form view for editing a personal vault entry.
/// Presents editable fields for title, username, password, url, notes, totpSecret, and tags.
@MainActor
struct EntryEditForm: View {
  let summary: VaultEntrySummary
  let initialDetail: VaultEntryDetail
  let vaultKey: SymmetricKey
  let userId: String
  @Bindable var viewModel: VaultViewModel
  let apiClient: MobileAPIClient
  let hostSyncService: HostSyncService
  let onSaved: () -> Void

  @State private var title: String
  @State private var username: String
  @State private var password: String
  @State private var url: String
  @State private var notes: String
  @State private var totpSecret: String
  @State private var tagsText: String

  @State private var isSaving: Bool = false
  @State private var saveError: String? = nil

  @Environment(\.dismiss) private var dismiss

  init(
    summary: VaultEntrySummary,
    initialDetail: VaultEntryDetail,
    vaultKey: SymmetricKey,
    userId: String,
    viewModel: VaultViewModel,
    apiClient: MobileAPIClient,
    hostSyncService: HostSyncService,
    onSaved: @escaping () -> Void
  ) {
    self.summary = summary
    self.initialDetail = initialDetail
    self.vaultKey = vaultKey
    self.userId = userId
    self.viewModel = viewModel
    self.apiClient = apiClient
    self.hostSyncService = hostSyncService
    self.onSaved = onSaved

    _title = State(initialValue: initialDetail.title)
    _username = State(initialValue: initialDetail.username)
    _password = State(initialValue: initialDetail.password)
    _url = State(initialValue: initialDetail.url)
    _notes = State(initialValue: initialDetail.notes)
    _totpSecret = State(initialValue: initialDetail.totpSecret ?? "")
    _tagsText = State(initialValue: initialDetail.tags.joined(separator: ", "))
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

        Section("Tags") {
          TextField("tag1, tag2, tag3", text: $tagsText)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }

        if let error = saveError {
          Section {
            Text(error)
              .foregroundStyle(.red)
              .font(.caption)
          }
        }
      }
      .navigationTitle("Edit Entry")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            Task { await save() }
          }
          .disabled(!hasChanges || isSaving)
        }
      }
      .disabled(isSaving)
    }
  }

  // MARK: - Private

  private var hasChanges: Bool {
    title != initialDetail.title ||
    username != initialDetail.username ||
    password != initialDetail.password ||
    url != initialDetail.url ||
    notes != initialDetail.notes ||
    totpSecret != (initialDetail.totpSecret ?? "") ||
    tagsText != initialDetail.tags.joined(separator: ", ")
  }

  private var parsedTags: [String] {
    tagsText
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
  }

  private func save() async {
    isSaving = true
    saveError = nil
    defer { isSaving = false }

    let urlHost = URL(string: url)?.host ?? ""
    let detail = EntryPlaintext(
      title: title,
      username: username,
      password: password,
      url: url.isEmpty ? nil : url,
      notes: notes.isEmpty ? nil : notes,
      totpSecret: totpSecret.isEmpty ? nil : totpSecret,
      tags: parsedTags
    )
    let overview = OverviewPlaintext(
      title: title,
      username: username,
      urlHost: urlHost.isEmpty ? nil : urlHost,
      tags: parsedTags
    )

    do {
      try await viewModel.saveEntry(
        entryId: summary.id,
        userId: userId,
        detail: detail,
        overview: overview,
        vaultKey: vaultKey,
        apiClient: apiClient,
        hostSyncService: hostSyncService
      )
      onSaved()
      dismiss()
    } catch {
      saveError = "Save failed: \(error.localizedDescription)"
    }
  }
}
