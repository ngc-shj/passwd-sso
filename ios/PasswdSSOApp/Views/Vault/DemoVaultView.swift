import CryptoKit
import Foundation
import Shared
import SwiftUI
import UIKit

// MARK: - DemoLandingItem

/// A single entry in the demo category grid. Identifiable for ForEach.
private struct DemoLandingItem: Identifiable {
  let id: String
  let category: VaultCategory
  let symbol: String
  let label: String
  let count: Int
}

// MARK: - DemoVaultView

/// Read-only vault browser for Demo Mode. Hydrates from an in-memory DemoVault
/// produced by DemoVaultFactory. Holds no live-service dependencies — no network,
/// no Keychain, no shared-state writes. See DemoModeStateTests grep gate.
@MainActor
struct DemoVaultView: View {
  let demo: DemoVault
  let onExit: () -> Void

  // Ephemeral settings-backed VM: Demo Mode must not read/write the real
  // App Group sort preference (isolation contract — see DemoModeStateTests).
  @State private var viewModel = VaultViewModel.makeEphemeral()
  @State private var isScreenRecording: Bool = UIScreen.main.isCaptured

  private let presentation = DemoVaultPresentation()

  var body: some View {
    NavigationStack {
      Group {
        if isScreenRecording {
          ScreenRecordingOverlay()
        } else if viewModel.searchQuery.isEmpty {
          categoryGrid
        } else {
          searchResultsList
        }
      }
      .navigationTitle("passwd-sso")
      .searchable(text: $viewModel.searchQuery, prompt: Text("Search"))
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          demoBanner
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button(presentation.exitLabel) { onExit() }
        }
      }
    }
    .onAppear {
      viewModel.loadFromCache(
        cacheData: demo.cacheData,
        vaultKey: demo.vaultKey,
        userId: demo.userId,
        cacheKey: nil,
        teamDirectory: []
      )
      isScreenRecording = UIScreen.main.isCaptured
    }
    .onReceive(
      NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)
    ) { _ in
      isScreenRecording = UIScreen.main.isCaptured
    }
  }

  // MARK: - Demo mode banner

  private var demoBanner: some View {
    Text("Demo Mode")
      .font(.caption.bold())
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(Color.accentColor.opacity(0.15))
      .foregroundStyle(Color.accentColor)
      .clipShape(Capsule())
  }

  // MARK: - Category grid

  private var landingItems: [DemoLandingItem] {
    let summaries = viewModel.filteredSummaries
    let counts = categoryCounts(summaries)
    var items: [DemoLandingItem] = [
      DemoLandingItem(
        id: "all", category: .all, symbol: "tray.full",
        label: L10n.string("All"), count: counts[.all] ?? 0
      ),
    ]
    for type in EntryTypeCategory.allCases {
      let count = counts[.type(type)] ?? 0
      if count > 0 {
        items.append(DemoLandingItem(
          id: "type-\(type.rawValue)", category: .type(type),
          symbol: type.sfSymbol, label: type.localizedLabel, count: count
        ))
      }
    }
    return items
  }

  private var categoryGrid: some View {
    ScrollView {
      LazyVGrid(
        columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
        spacing: 12
      ) {
        ForEach(landingItems) { item in
          NavigationLink {
            VaultCategoryListView(
              category: item.category,
              navigationTitle: item.label,
              cacheData: demo.cacheData,
              vaultKey: demo.vaultKey,
              userId: demo.userId,
              keyVersion: 1,
              viewModel: viewModel,
              isReadOnly: true,
              showFavicons: presentation.showsFavicons
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
      if viewModel.filteredSummaries.isEmpty {
        Text("No entries")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
  }

  // MARK: - Search results list

  private var searchResultsList: some View {
    List(viewModel.filteredSummaries) { summary in
      NavigationLink {
        EntryDetailView(
          summary: summary,
          cacheData: demo.cacheData,
          vaultKey: demo.vaultKey,
          userId: demo.userId,
          keyVersion: 1,
          viewModel: viewModel,
          isReadOnly: true,
          showFavicons: presentation.showsFavicons
        )
      } label: {
        EntrySummaryRow(summary: summary, showFavicons: presentation.showsFavicons)
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
}
