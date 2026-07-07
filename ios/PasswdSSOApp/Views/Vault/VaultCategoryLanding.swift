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
      ZStack {
        RoundedRectangle(cornerRadius: 32 * 0.22, style: .continuous)
          .fill(Color.accentColor)
          .frame(width: 32, height: 32)
        Image(systemName: symbol)
          .font(.system(size: 32 * 0.5))
          .foregroundStyle(.white)
      }
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
  let showFavicons: Bool

  var body: some View {
    HStack(spacing: 12) {
      EntryIconView(
        entryType: summary.entryType,
        urlHost: summary.urlHost,
        showFavicons: showFavicons
      )
      VStack(alignment: .leading, spacing: 2) {
        Text(summary.title)
          .font(.body)
          .lineLimit(1)
        Text(summary.username)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
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
  var autoLockService: AutoLockService? = nil
  @Bindable var viewModel: VaultViewModel
  var apiClient: MobileAPIClient? = nil
  var hostSyncService: HostSyncService? = nil
  var cacheKey: SymmetricKey? = nil
  var isReadOnly: Bool = false
  var showFavicons: Bool = false

  // Seed synchronously so an already-active recording never shows a frame of
  // entries before onAppear flips the flag.
  @State private var isScreenRecording = UIScreen.main.isCaptured
  @FocusState private var searchFocused: Bool

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
              hostSyncService: hostSyncService,
              cacheKey: cacheKey,
              isReadOnly: isReadOnly,
              showFavicons: showFavicons
            )
          } label: {
            EntrySummaryRow(summary: summary, showFavicons: showFavicons)
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
    // Self-built bottom bar (not `.searchable`) so a sort control can sit on the
    // SAME row, left of the search field — like the iOS Passwords app. The
    // system `.searchable` field is system-managed with no adjacent slot on
    // iOS 17/18; this HStack works identically on all supported versions. The
    // whole bar is hidden during screen recording (rows are already gated
    // above), so no entry-derived UI renders while capturing.
    .safeAreaInset(edge: .bottom) {
      if !isScreenRecording {
        categoryBottomBar
      }
    }
    .onAppear { isScreenRecording = UIScreen.main.isCaptured }
    .onReceive(
      NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)
    ) { _ in
      isScreenRecording = UIScreen.main.isCaptured
    }
  }

  /// Bottom bar: a sort Menu (↑↓) on the leading edge, then the search field —
  /// mirrors the iOS Passwords app category screen. Binds the shared
  /// `viewModel.searchQuery` / `sortOption` / `sortDirection`.
  private var categoryBottomBar: some View {
    HStack(spacing: 12) {
      EntrySortMenu(
        sortOption: $viewModel.sortOption,
        sortDirection: $viewModel.sortDirection,
        onChange: { autoLockService?.recordActivity() }
      )
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
    }
    .padding(.horizontal)
    .padding(.vertical, 8)
    .background(.bar)
  }
}

/// Sort control shared by the category screens: a Menu showing an
/// ascending/descending toggle and the four sort keys, matching the iOS
/// Passwords app. Bindings write the shared VaultViewModel state (persisted).
struct EntrySortMenu: View {
  @Binding var sortOption: EntrySortOption
  @Binding var sortDirection: EntrySortDirection
  var onChange: () -> Void = {}

  var body: some View {
    Menu {
      Picker("Direction", selection: directionBinding) {
        Label("Descending", systemImage: "arrow.down").tag(EntrySortDirection.descending)
        Label("Ascending", systemImage: "arrow.up").tag(EntrySortDirection.ascending)
      }
      Picker("Sort by", selection: optionBinding) {
        Text("Title").tag(EntrySortOption.title)
        Text("Created date").tag(EntrySortOption.createdAt)
        Text("Updated date").tag(EntrySortOption.updatedAt)
        Text("Website").tag(EntrySortOption.website)
      }
    } label: {
      Image(systemName: "arrow.up.arrow.down")
        .font(.body)
        .frame(width: 44, height: 44)
        .background(Color(.secondarySystemBackground), in: Circle())
    }
    .accessibilityLabel("Sort")
    // Stable, non-localized handle for UI tests (the label is localized).
    .accessibilityIdentifier("category-sort-button")
  }

  private var optionBinding: Binding<EntrySortOption> {
    Binding(get: { sortOption }, set: { sortOption = $0; onChange() })
  }
  private var directionBinding: Binding<EntrySortDirection> {
    Binding(get: { sortDirection }, set: { sortDirection = $0; onChange() })
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
