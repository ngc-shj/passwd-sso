import CryptoKit
import Foundation
import Shared
import SwiftUI
import UIKit

/// Main vault list view — shows decrypted entry summaries.
@MainActor
struct VaultListView: View {
  // Owned by the view (created once, survives parent re-renders). Passing an
  // inline-constructed VaultViewModel from the parent caused a fresh, empty
  // model to replace the loaded one on the next re-render (e.g. the foreground
  // re-sync), showing "No entries" despite a fully-decoded cache.
  @State private var viewModel = VaultViewModel()
  let cacheData: CacheData
  let vaultKey: SymmetricKey
  let userId: String
  let keyVersion: Int
  let autoLockService: AutoLockService
  let apiClient: MobileAPIClient
  let hostSyncService: HostSyncService

  @State private var isScreenRecording: Bool = false
  @State private var isShowingSettings: Bool = false
  @State private var isShowingCreateForm: Bool = false
  @FocusState private var searchFocused: Bool

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
        // Matches the iOS 26 native Passwords app: secondary actions live behind
        // a single top-right "⋯" menu; the primary Create (+) action and search
        // move to the bottom bar (see `bottomBar`). One top-right control means
        // no two toolbar items can merge into one glass capsule.
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            Button {
              autoLockService.recordActivity()
              isShowingSettings = true
            } label: {
              Label("Settings", systemImage: "gearshape")
            }
            Button(role: .destructive) {
              autoLockService.lock()
            } label: {
              Label("Lock", systemImage: "lock")
            }
          } label: {
            Image(systemName: "ellipsis.circle")
          }
          .accessibilityLabel("More")
        }
      }
      .safeAreaInset(edge: .bottom) {
        if !isScreenRecording {
          bottomBar
        }
      }
      .sheet(isPresented: $isShowingSettings) {
        SettingsView(autoLockService: autoLockService)
      }
      .sheet(isPresented: $isShowingCreateForm) {
        EntryForm(
          mode: .create,
          vaultKey: vaultKey,
          userId: userId,
          keyVersion: keyVersion,
          viewModel: viewModel,
          apiClient: apiClient,
          hostSyncService: hostSyncService
        )
      }
      // Search moved from the top navigation drawer to the bottom bar (native
      // Passwords-app pattern). Activity tracking stays on query change.
      .onChange(of: viewModel.searchQuery) { _, _ in
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

  // MARK: - Bottom bar (search + create)

  /// Native Passwords-app pattern: a search field fills the bottom bar with the
  /// Create (+) button on the trailing side. + is hidden under a team filter
  /// (team create unsupported). Pinned via `.safeAreaInset(edge: .bottom)`.
  private var bottomBar: some View {
    HStack(spacing: 12) {
      HStack(spacing: 6) {
        Image(systemName: "magnifyingglass")
          .foregroundStyle(.secondary)
        TextField("Search", text: $viewModel.searchQuery)
          .textFieldStyle(.plain)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .focused($searchFocused)
          .submitLabel(.search)
        if !viewModel.searchQuery.isEmpty {
          Button {
            viewModel.searchQuery = ""
          } label: {
            Image(systemName: "xmark.circle.fill")
              .foregroundStyle(.secondary)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Clear search")
        }
      }
      .padding(.horizontal, 12)
      .frame(minHeight: 44)
      .background(Color(.secondarySystemBackground), in: Capsule())

      if viewModel.filterTeamId == nil {
        Button {
          autoLockService.recordActivity()
          isShowingCreateForm = true
        } label: {
          Image(systemName: "plus")
            .font(.title2)
            .frame(width: 44, height: 44)
            .background(Color(.secondarySystemBackground), in: Circle())
        }
        .buttonStyle(.plain)
        .tint(.accentColor)
        .accessibilityLabel("Create entry")
      }
    }
    .padding(.horizontal)
    .padding(.vertical, 8)
    .background(.bar)
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
          keyVersion: keyVersion,
          autoLockService: autoLockService,
          viewModel: viewModel,
          apiClient: apiClient,
          hostSyncService: hostSyncService
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
