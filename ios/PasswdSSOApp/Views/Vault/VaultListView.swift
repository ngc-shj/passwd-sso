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
        // Layout rationale:
        //  - Create (+) sits ALONE on the trailing edge — the conventional iOS
        //    spot for the primary "add" action (Mail/Notes/Contacts), isolated
        //    from the destructive Lock so the two never sit adjacent.
        //  - Settings (gear) and Lock are the vault-management actions on the
        //    leading edge. (ToolbarSpacer would split them into separate glass
        //    capsules on iOS 26, but it's an iOS-26-only symbol absent from the
        //    iOS-18 SDK that CI builds against — so it cannot be referenced even
        //    behind #available. On iOS < 26 they render as distinct controls.)
        //  - Create is hidden while a team filter is active (team create unsupported).
        ToolbarItem(placement: .topBarLeading) {
          Button {
            autoLockService.recordActivity()
            isShowingSettings = true
          } label: {
            Image(systemName: "gearshape")
          }
          .accessibilityLabel("Settings")
        }
        ToolbarItem(placement: .topBarLeading) {
          Button("Lock", role: .destructive) {
            autoLockService.lock()
          }
        }
        if viewModel.filterTeamId == nil {
          ToolbarItem(placement: .topBarTrailing) {
            Button {
              autoLockService.recordActivity()
              isShowingCreateForm = true
            } label: {
              Image(systemName: "plus")
            }
            .accessibilityLabel("Create entry")
          }
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
      .searchable(
        text: $viewModel.searchQuery,
        placement: .navigationBarDrawer(displayMode: .always),
        prompt: "Search entries"
      )
      // Activity tracking moved to explicit action sites (Lock button,
      // search-query change, navigation) so it never competes with
      // NavigationLink hit-testing inside the List.
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
