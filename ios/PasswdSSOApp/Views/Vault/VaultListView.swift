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
  /// The REAL cacheKey from unlock (nil in debug). Needed to decrypt team entries
  /// in-app + persist/read team keys; cannot be re-derived (readDirect is empty).
  let cacheKey: SymmetricKey?

  @State private var isScreenRecording: Bool = UIScreen.main.isCaptured
  @State private var isShowingSettings: Bool = false
  @State private var isShowingCreateForm: Bool = false
  @State private var isShowingSignOutConfirm: Bool = false
  @State private var isSyncing: Bool = false
  @State private var syncError: String?
  @FocusState private var searchFocused: Bool
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        vaultSwitcher
        Group {
          if isScreenRecording {
            ScreenRecordingOverlay()
          } else if viewModel.searchQuery.isEmpty {
            categoryGrid
          } else {
            entryList
          }
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
            // Re-fetch from the server, rebuild the local cache, and rebind the
            // list so an entry/passkey registered externally (AutoFill
            // extension, web) appears without a lock/unlock cycle. Pull-to-
            // refresh on the list runs the same `sync()`.
            Button {
              Task { await sync() }
            } label: {
              Label("Sync now", systemImage: "arrow.clockwise")
            }
            .disabled(isSyncing)
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
          hostSyncService: hostSyncService,
          cacheKey: cacheKey
        )
      }
      // Search moved from the top navigation drawer to the bottom bar (native
      // Passwords-app pattern). Activity tracking stays on query change.
      .onChange(of: viewModel.searchQuery) { _, _ in
        autoLockService.recordActivity()
      }
      // Returning to the app re-binds the list from a fresh sync, so a passkey/
      // entry registered while away (AutoFill extension in Safari, web) appears
      // automatically — no lock/unlock or manual sync. Silent on failure.
      .onChange(of: scenePhase) { _, newPhase in
        if newPhase == .active {
          Task { await sync(surfaceErrors: false) }
        }
      }
      .alert(
        "Sync failed",
        isPresented: Binding(get: { syncError != nil }, set: { if !$0 { syncError = nil } })
      ) {
        Button("OK", role: .cancel) { syncError = nil }
      } message: {
        Text(syncError ?? "")
      }
      // Anchored at body level (NOT inside the Menu, where dismissal races the
      // menu collapse). Manual signOut() ends in .loggedOut(.manual) → RootView
      // routes to the URL setup screen (the deliberate change-server path).
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
      reload(cacheData)
      updateScreenRecordingState()
    }
    .onReceive(
      NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)
    ) { _ in
      updateScreenRecordingState()
    }
  }

  // MARK: - Vault switcher (personal vs team)

  /// Segmented switcher making the team vault clearly separate from the personal
  /// one. Hidden entirely when the user belongs to no team (personal-only users
  /// see no change). Switching scope re-filters the grid/list to that vault.
  @ViewBuilder private var vaultSwitcher: some View {
    if !viewModel.teamDirectory.isEmpty {
      Picker("Vault", selection: $viewModel.scope) {
        Text("Personal").tag(VaultScope.personal)
        ForEach(viewModel.teamDirectory) { team in
          Text(team.name).tag(VaultScope.team(team.id))
        }
      }
      .pickerStyle(.segmented)
      .padding(.horizontal)
      .padding(.vertical, 8)
      .onChange(of: viewModel.scope) { _, _ in
        autoLockService.recordActivity()
        viewModel.searchQuery = ""
      }
    }
  }

  /// Decrypt + bind a fresh cache: use the unlock-time cacheKey (for team entries)
  /// and load the team directory (for switcher labels), then hand both to the VM.
  private func reload(_ data: CacheData) {
    let teamDir = cacheKey.map { TeamDirectoryStore().load(cacheKey: $0, userId: userId) } ?? []
    viewModel.loadFromCache(
      cacheData: data, vaultKey: vaultKey, userId: userId,
      cacheKey: cacheKey, teamDirectory: teamDir)
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

      if !viewModel.isTeamScope {
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
    // Use filteredSummaries (== allSummaries while not searching, but also honors
    // any team filter) so card counts match the entries the pushed list shows.
    let counts = categoryCounts(viewModel.filteredSummaries)
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
    for tag in distinctTags(viewModel.filteredSummaries) {
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
              hostSyncService: hostSyncService,
              cacheKey: cacheKey
            )
          } label: {
            CategoryCard(symbol: item.symbol, label: item.label, count: item.count)
          }
          .buttonStyle(.plain)
        }
      }
      .padding()
    }
    .refreshable { await sync() }
    .overlay {
      if viewModel.filteredSummaries.isEmpty {
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
          hostSyncService: hostSyncService,
          cacheKey: cacheKey
        )
      } label: {
        EntrySummaryRow(summary: summary)
      }
    }
    .listStyle(.plain)
    .refreshable { await sync() }
    .overlay {
      if viewModel.filteredSummaries.isEmpty {
        Text("No matches")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
  }

  /// Re-fetch entries from the server, rebuild the encrypted cache, and rebind
  /// the visible list from the fresh cache. Best-effort, single-flight via
  /// `isSyncing`. Backs the "Sync now" menu item, pull-to-refresh, and the
  /// silent foreground auto-refresh.
  ///
  /// `surfaceErrors`: manual triggers (button / pull) show a non-blocking alert
  /// on failure; the automatic foreground refresh stays silent (a transient
  /// offline state must not pop an alert just for returning to the app).
  @MainActor
  private func sync(surfaceErrors: Bool = true) async {
    // Never sync (decrypt into the view's state) once the vault has locked —
    // defence-in-depth against a background idle-lock racing an in-flight or
    // queued foreground refresh.
    guard autoLockService.state == .unlocked else { return }
    guard !isSyncing else { return }
    isSyncing = true
    defer { isSyncing = false }
    // Manual sync is a user action → reset the idle-lock timer. The silent
    // foreground auto-refresh is NOT user interaction, so it must not extend the
    // auto-lock window just because the app returned to the foreground.
    if surfaceErrors { autoLockService.recordActivity() }
    do {
      let report = try await hostSyncService.runSync(
        vaultKey: vaultKey, userId: userId, cacheKey: cacheKey)
      if let fresh = report.cacheData {
        reload(fresh)
      }
    } catch MobileAPIError.authenticationRequired {
      if surfaceErrors {
        syncError = String(localized: "Your session expired. Lock and unlock to sign in again.")
      }
    } catch {
      if surfaceErrors {
        syncError = String(localized: "Couldn't sync. Check your connection and try again.")
      }
    }
  }

  private func updateScreenRecordingState() {
    isScreenRecording = UIScreen.main.isCaptured
  }
}
