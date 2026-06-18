import CryptoKit
import Foundation
import Shared
import SwiftUI
import UIKit

/// Shows full entry detail — decrypts blob on appear, clears on disappear.
@MainActor
struct EntryDetailView: View {
  let summary: VaultEntrySummary
  let cacheData: CacheData
  let vaultKey: SymmetricKey
  let userId: String
  let keyVersion: Int
  let autoLockService: AutoLockService
  @Bindable var viewModel: VaultViewModel
  let apiClient: MobileAPIClient
  let hostSyncService: HostSyncService
  var cacheKey: SymmetricKey? = nil

  @State private var detail: VaultEntryDetail?
  @State private var loadFailed: Bool = false
  @State private var isPasswordVisible: Bool = false
  @State private var isScreenRecording: Bool = UIScreen.main.isCaptured
  @State private var isShowingEditForm: Bool = false

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    Group {
      if isScreenRecording {
        ScreenRecordingOverlay()
      } else if let detail {
        detailContent(detail)
      } else if loadFailed {
        VStack(spacing: 12) {
          Image(systemName: "exclamationmark.triangle")
            .font(.largeTitle)
            .foregroundStyle(.secondary)
          Text("Couldn't decrypt this entry.")
            .foregroundStyle(.secondary)
          Button("Retry") {
            loadFailed = false
            loadDetail()
          }
          .buttonStyle(.bordered)
          .controlSize(.large)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ProgressView("Decrypting…")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .navigationTitle(summary.title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      // Edit is LOGIN-only on iOS: the edit form is login-shaped and would
      // corrupt a non-login entry on save (empty login scalars + login-shaped
      // overview). Non-login entries are edited in the web app. nil/unknown
      // entryType falls back to LOGIN, so the button shows during load.
      if EntryTypeCategory.isEditableOnIOS(rawType: detail?.entryType) {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Edit") {
            isShowingEditForm = true
          }
        }
      }
    }
    // Re-decrypt from the VM's now-fresh cache when the edit sheet closes, so a
    // just-saved edit is reflected immediately (the VM refreshes cacheData after
    // the PUT+sync; without this trigger the view keeps showing pre-edit values).
    .sheet(isPresented: $isShowingEditForm, onDismiss: { loadDetail() }) {
      if let detail {
        EntryForm(
          mode: .edit(summary: summary, initial: detail),
          vaultKey: vaultKey,
          userId: userId,
          keyVersion: keyVersion,
          viewModel: viewModel,
          apiClient: apiClient,
          hostSyncService: hostSyncService,
          cacheKey: cacheKey
        )
      }
    }
    .onAppear {
      loadDetail()
      isScreenRecording = UIScreen.main.isCaptured
    }
    .onReceive(
      NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)
    ) { _ in
      isScreenRecording = UIScreen.main.isCaptured
    }
    .onDisappear {
      detail = nil
    }
    // Clear decrypted secrets the moment the vault locks/logs out while this
    // view stays foregrounded (lock() does not unmount it). The detail now
    // holds SSH private keys, card numbers, IBANs — a larger surface than the
    // password+TOTP it once carried, so don't leave it resident past lock.
    .onChange(of: autoLockService.state) { _, newState in
      if newState != .unlocked {
        detail = nil
      }
    }
  }

  // MARK: - Detail content

  @ViewBuilder
  private func detailContent(_ d: VaultEntryDetail) -> some View {
    List {
      // Render the field set for the entry's type. Each per-type section lives
      // in EntryDetailTypeSections.swift; LOGIN keeps its original rows so its
      // rendering is structurally unchanged.
      switch EntryTypeCategory.from(rawType: d.entryType) {
      case .login: loginSections(d)
      case .secureNote: secureNoteSection(d.secureNote)
      case .creditCard: creditCardSection(d.creditCard, notes: d.notes)
      case .identity: identitySection(d.identity, notes: d.notes)
      case .bankAccount: bankAccountSection(d.bankAccount, notes: d.notes)
      case .sshKey: sshKeySection(d.sshKey, notes: d.notes)
      case .softwareLicense: softwareLicenseSection(d.softwareLicense, notes: d.notes)
      case .passkey: passkeySection(d.passkey, notes: d.notes)
      }

      // Read-only display of preserved-but-not-iOS-editable data, so the user
      // can see these values still exist after an iOS edit.
      if !d.tags.isEmpty {
        Section("Tags") {
          Text(d.tags.joined(separator: ", "))
            .font(.body)
        }
      }

      // The edit-preservation note only applies to LOGIN (the one type editable
      // on iOS). For non-login types editing happens in the web app entirely.
      if EntryTypeCategory.isEditableOnIOS(rawType: d.entryType) {
        Section {
          Text("Tags, custom fields, generator settings, and password history are kept when you save an edit here — edit those in the web app.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      } else {
        Section {
          Text("Edit this entry in the web app.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    }
    .listStyle(.insetGrouped)
  }

  // LOGIN field set — unchanged from the original detail layout.
  @ViewBuilder
  private func loginSections(_ d: VaultEntryDetail) -> some View {
    // Show the same fields as the edit form (even when empty) so opening Edit
    // doesn't surprise the user with rows that weren't there. Empty fields
    // render a muted "Not set" rather than being hidden.
    fieldRow(label: "Username", value: d.username)
    passwordRow(d.password)
    fieldRow(label: "URL", value: d.url)

    Section("Notes") {
      if d.notes.isEmpty {
        notSetText
      } else {
        Text(d.notes)
          .font(.caption)
          .privacySensitive()
      }
    }

    Section("One-Time Code") {
      if let totpSecret = d.totpSecret, !totpSecret.isEmpty {
        TOTPCodeView(params: TOTPParams(
          secret: totpSecret,
          algorithm: d.totpAlgorithm,
          digits: d.totpDigits,
          period: d.totpPeriod
        ))
      } else {
        notSetText
      }
    }
  }

  var notSetText: some View {
    Text("Not set")
      .font(.body)
      .foregroundStyle(.secondary)
  }

  // LocalizedStringKey (not String) so `Section(_:)` binds the localizing
  // overload — callers pass literals ("Username"/"URL") that must translate.
  func fieldRow(label: LocalizedStringKey, value: String) -> some View {
    Section(label) {
      if value.isEmpty {
        notSetText
      } else {
        HStack {
          Text(value)
            .font(.body)
          Spacer()
          Button {
            copySecurely(value: value)
            autoLockService.recordActivity()
          } label: {
            Image(systemName: "doc.on.doc")
              .frame(minWidth: 44, minHeight: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .tint(.accentColor)
        }
      }
    }
  }

  private func passwordRow(_ password: String) -> some View {
    Section("Password") {
      HStack {
        if isPasswordVisible {
          Text(password)
            .font(.body.monospaced())
            .privacySensitive()
        } else {
          SecureField("", text: .constant(password))
            .disabled(true)
        }
        Spacer()
        Button {
          isPasswordVisible.toggle()
          autoLockService.recordActivity()
        } label: {
          Image(systemName: isPasswordVisible ? "eye.slash" : "eye")
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        Button {
          copySecurely(value: password)
          autoLockService.recordActivity()
        } label: {
          Image(systemName: "doc.on.doc")
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .tint(.accentColor)
      }
    }
  }

  // MARK: - Private

  private func loadDetail() {
    // Read from the VM's fresh cache first (set after any create/edit+sync);
    // fall back to the prop captured at navigation time only when no VM cache
    // is available yet. The prop goes stale after a write refreshes the VM cache.
    let effectiveCacheData = viewModel.cacheData ?? cacheData
    let loaded = viewModel.loadDetail(
      for: summary.id,
      cacheData: effectiveCacheData,
      vaultKey: vaultKey,
      userId: userId,
      cacheKey: cacheKey
    )
    detail = loaded
    loadFailed = (loaded == nil)
  }

  /// Copy to pasteboard with localOnly + a configurable auto-clear expiration
  /// (AppSettingsStore.clipboardClearSeconds) per plan §"Side-Channel Controls".
  func copySecurely(value: String) {
    SecureClipboard.copy(value, clearAfter: AppSettingsStore().clipboardClearSeconds)
  }
}
