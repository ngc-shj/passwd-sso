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
  let autoLockService: AutoLockService

  @State private var detail: VaultEntryDetail?
  @State private var isPasswordVisible: Bool = false
  @State private var isScreenRecording: Bool = false

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    Group {
      if isScreenRecording {
        VStack(spacing: 16) {
          Image(systemName: "eye.slash")
            .font(.largeTitle)
          Text("Recording — content hidden")
            .font(.headline)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial)
      } else if let detail {
        detailContent(detail)
      } else {
        ProgressView("Decrypting…")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .navigationTitle(summary.title)
    .navigationBarTitleDisplayMode(.inline)
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
  }

  // MARK: - Detail content

  private func detailContent(_ d: VaultEntryDetail) -> some View {
    List {
      if !d.username.isEmpty {
        fieldRow(label: "Username", value: d.username, isSensitive: false)
      }

      passwordRow(d.password)

      if !d.url.isEmpty {
        fieldRow(label: "URL", value: d.url, isSensitive: false)
      }

      if !d.notes.isEmpty {
        Section("Notes") {
          Text(d.notes)
            .font(.caption)
        }
      }

      if let totpSecret = d.totpSecret, !totpSecret.isEmpty {
        Section("One-Time Code") {
          TOTPCodeView(params: TOTPParams(secret: totpSecret))
        }
      }
    }
    .listStyle(.insetGrouped)
  }

  private func fieldRow(label: String, value: String, isSensitive: Bool) -> some View {
    Section(label) {
      HStack {
        if isSensitive {
          SecureField("", text: .constant(value))
            .disabled(true)
        } else {
          Text(value)
            .font(.body)
        }
        Spacer()
        Button {
          copySecurely(value: value)
          autoLockService.recordActivity()
        } label: {
          Image(systemName: "doc.on.doc")
            .imageScale(.small)
        }
        .buttonStyle(.plain)
        .tint(.accentColor)
      }
    }
  }

  private func passwordRow(_ password: String) -> some View {
    Section("Password") {
      HStack {
        if isPasswordVisible {
          Text(password)
            .font(.body.monospaced())
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
            .imageScale(.small)
        }
        .buttonStyle(.plain)

        Button {
          copySecurely(value: password)
          autoLockService.recordActivity()
        } label: {
          Image(systemName: "doc.on.doc")
            .imageScale(.small)
        }
        .buttonStyle(.plain)
        .tint(.accentColor)
      }
    }
  }

  // MARK: - Private

  private func loadDetail() {
    let vm = VaultViewModel()
    detail = vm.loadDetail(
      for: summary.id,
      cacheData: cacheData,
      vaultKey: vaultKey,
      userId: userId
    )
  }

  /// Copy to pasteboard with localOnly + 60s expiration per plan §"Side-Channel Controls".
  private func copySecurely(value: String) {
    UIPasteboard.general.setItems(
      [[UIPasteboard.typeAutomatic: value]],
      options: [
        .localOnly: true,
        .expirationDate: Date().addingTimeInterval(60),
      ]
    )
  }
}
