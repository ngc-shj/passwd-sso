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
  @State private var isShowingSignOutConfirm: Bool = false
  @FocusState private var searchFocused: Bool

  var body: some View {
    NavigationStack {
      Group {
        if isScreenRecording {
          ScreenRecordingOverlay()
        } else if viewModel.searchQuery.isEmpty {
          categoryGrid
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
            Button(role: .destructive) {
              // Confirm before sign-out (unlike Lock): it clears tokens/cache and
              // requires a full re-sign-in. Dialog is presented at body level.
              isShowingSignOutConfirm = true
            } label: {
              Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
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
      // Anchored at body level (NOT inside the Menu, where dismissal races the
      // menu collapse). signOut() ends in .loggedOut → RootView routes to setup.
      .confirmationDialog(
        "Sign out of passwd-sso?",
        isPresented: $isShowingSignOutConfirm,
        titleVisibility: .visible
      ) {
        Button("Sign Out", role: .destructive) {
          autoLockService.signOut()
        }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("This clears the local session. You'll need to sign in and unlock again.")
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

  // MARK: - Category landing grid

  /// One card per displayed category. Type cards (and Codes/Favorites) appear
  /// only when non-empty; All is always shown; one card per distinct tag.
  private struct LandingItem: Identifiable {
    let id: String
    let category: VaultCategory
    let symbol: String
    let label: String
    let count: Int
  }

  private var displayedCategories: [LandingItem] {
    let counts = categoryCounts(viewModel.allSummaries)
    var items: [LandingItem] = [
      LandingItem(id: "all", category: .all, symbol: "tray.full",
                  label: String(localized: "All"), count: counts[.all] ?? 0),
    ]
    for type in EntryTypeCategory.allCases {
      let count = counts[.type(type)] ?? 0
      if count > 0 {
        items.append(LandingItem(id: "type-\(type.rawValue)", category: .type(type),
                                 symbol: type.sfSymbol, label: type.localizedLabel, count: count))
      }
    }
    if let count = counts[.codes], count > 0 {
      items.append(LandingItem(id: "codes", category: .codes, symbol: "clock",
                               label: String(localized: "Codes"), count: count))
    }
    if let count = counts[.favorites], count > 0 {
      items.append(LandingItem(id: "favorites", category: .favorites, symbol: "star",
                               label: String(localized: "Favorites"), count: count))
    }
    for tag in distinctTags(viewModel.allSummaries) {
      items.append(LandingItem(id: "tag-\(tag)", category: .tag(tag), symbol: "tag",
                               label: tag, count: counts[.tag(tag)] ?? 0))
    }
    return items
  }

  private var categoryGrid: some View {
    ScrollView {
      LazyVGrid(
        columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
        spacing: 12
      ) {
        ForEach(displayedCategories) { item in
          NavigationLink {
            VaultCategoryListView(
              category: item.category,
              navigationTitle: item.label,
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
            CategoryCard(symbol: item.symbol, label: item.label, count: item.count)
          }
          .buttonStyle(.plain)
        }
      }
      .padding()
    }
    .overlay {
      if viewModel.allSummaries.isEmpty {
        Text("No entries")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
  }

  // MARK: - Entry list (search results)

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
        EntrySummaryRow(summary: summary)
      }
    }
    .listStyle(.plain)
    .overlay {
      if viewModel.filteredSummaries.isEmpty {
        Text("No matches")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
  }

  private func updateScreenRecordingState() {
    isScreenRecording = UIScreen.main.isCaptured
  }
}
