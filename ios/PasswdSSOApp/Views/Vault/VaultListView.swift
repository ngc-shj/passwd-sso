import CryptoKit
import Foundation
import Shared
import SwiftUI
import UIKit

/// Main vault list view — shows decrypted entry summaries.
@MainActor
struct VaultListView: View {
  @Bindable var viewModel: VaultViewModel
  let cacheData: CacheData
  let vaultKey: SymmetricKey
  let userId: String
  let autoLockService: AutoLockService

  @State private var isScreenRecording: Bool = false

  var body: some View {
    NavigationStack {
      Group {
        if isScreenRecording {
          screenRecordingOverlay
        } else {
          entryList
        }
      }
      .navigationTitle("passwd-sso")
      .toolbar {
        ToolbarItem(placement: .navigationBarTrailing) {
          Button("Lock", role: .destructive) {
            autoLockService.lock()
          }
        }
      }
      .searchable(text: $viewModel.searchQuery, prompt: "Search entries")
      .onTapGesture {
        autoLockService.recordActivity()
      }
    }
    .onAppear {
      viewModel.loadFromCache(cacheData: cacheData, vaultKey: vaultKey, userId: userId)
      updateScreenRecordingState()
    }
    .onReceive(
      NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)
    ) { _ in
      updateScreenRecordingState()
    }
  }

  // MARK: - Entry list

  private var entryList: some View {
    List(viewModel.filteredSummaries) { summary in
      NavigationLink {
        EntryDetailView(
          summary: summary,
          cacheData: cacheData,
          vaultKey: vaultKey,
          userId: userId,
          autoLockService: autoLockService
        )
      } label: {
        entryRow(summary)
      }
    }
    .listStyle(.plain)
    .overlay {
      if viewModel.filteredSummaries.isEmpty {
        emptyState
      }
    }
  }

  private func entryRow(_ summary: VaultEntrySummary) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(summary.title)
        .font(.body)
        .lineLimit(1)
      Text(summary.username)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
    .padding(.vertical, 2)
  }

  private var emptyState: some View {
    VStack(spacing: 8) {
      Text(viewModel.searchQuery.isEmpty ? "No entries" : "No matches")
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: - Screen recording overlay

  private var screenRecordingOverlay: some View {
    VStack(spacing: 16) {
      Image(systemName: "eye.slash")
        .font(.largeTitle)
      Text("Recording — content hidden")
        .font(.headline)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(.regularMaterial)
  }

  private func updateScreenRecordingState() {
    isScreenRecording = UIScreen.main.isCaptured
  }
}
