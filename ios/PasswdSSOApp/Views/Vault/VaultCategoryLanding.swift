import CryptoKit
import Foundation
import Shared
import SwiftUI
import UIKit

/// A single category card on the landing grid: icon + label + count.
struct CategoryCard: View {
  let symbol: String
  let label: String
  let count: Int

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: symbol)
        .font(.title2)
        .frame(width: 32)
        .foregroundStyle(.tint)
      VStack(alignment: .leading, spacing: 2) {
        Text(label)
          .font(.body)
          .lineLimit(1)
        Text("\(count)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
    .padding()
    .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
  }
}

/// Shared list row (title + username) used by the flat list and category lists.
struct EntrySummaryRow: View {
  let summary: VaultEntrySummary

  var body: some View {
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
}

/// Filtered entry list pushed from a landing category card. Owns its own
/// screen-recording overlay (it is a pushed view, not covered by the root's).
@MainActor
struct VaultCategoryListView: View {
  let category: VaultCategory
  let navigationTitle: String
  let cacheData: CacheData
  let vaultKey: SymmetricKey
  let userId: String
  let keyVersion: Int
  let autoLockService: AutoLockService
  @Bindable var viewModel: VaultViewModel
  let apiClient: MobileAPIClient
  let hostSyncService: HostSyncService

  @State private var isScreenRecording = false

  // Compose with the live search query (filteredSummaries) then the category.
  private var entries: [VaultEntrySummary] {
    viewModel.filteredSummaries.filter { matches($0, category) }
  }

  var body: some View {
    Group {
      if isScreenRecording {
        ScreenRecordingOverlay()
      } else {
        List(entries) { summary in
          NavigationLink {
            EntryDetailView(
              summary: summary,
              cacheData: cacheData,
              vaultKey: vaultKey,
              userId: userId,
              keyVersion: keyVersion,
              autoLockService: autoLockService,
              viewModel: viewModel,
              apiClient: apiClient,
              hostSyncService: hostSyncService
            )
          } label: {
            EntrySummaryRow(summary: summary)
          }
        }
        .listStyle(.plain)
        .overlay {
          if entries.isEmpty {
            Text(viewModel.searchQuery.isEmpty ? "No entries" : "No matches")
              .foregroundStyle(.secondary)
              .frame(maxWidth: .infinity, maxHeight: .infinity)
          }
        }
      }
    }
    .navigationTitle(navigationTitle)
    .navigationBarTitleDisplayMode(.inline)
    .onAppear { isScreenRecording = UIScreen.main.isCaptured }
    .onReceive(
      NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)
    ) { _ in
      isScreenRecording = UIScreen.main.isCaptured
    }
  }
}

/// The "content hidden during screen recording" placeholder (shared by the
/// vault screens so the cue is identical everywhere).
struct ScreenRecordingOverlay: View {
  var body: some View {
    VStack(spacing: 16) {
      Image(systemName: "eye.slash")
        .font(.largeTitle)
      Text("Recording — content hidden")
        .font(.headline)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(.regularMaterial)
  }
}
