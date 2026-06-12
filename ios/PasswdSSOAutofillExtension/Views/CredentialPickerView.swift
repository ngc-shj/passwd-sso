import AuthenticationServices
import Shared
import SwiftUI

/// Presents a list of matched vault entries for the user to pick from.
///
/// Per plan §"App-side AutoFill (resolves S24)": for app-bundle-ID requests (non-URL),
/// the bundle ID is shown prominently and an extra confirmation tap is required.
struct CredentialPickerView: View {
  /// Host-matched entries, shown by default.
  let matched: [VaultEntrySummary]
  /// Every entry (matched first), searched when the search field is non-empty.
  let all: [VaultEntrySummary]
  let serviceIdentifiers: [ASCredentialServiceIdentifier]
  let onSelect: (VaultEntrySummary) -> Void
  let onCancel: () -> Void
  /// Empty-state headline. Defaults to the password copy; the passkey list
  /// passes a passkey-specific string so a no-match passkey ceremony isn't
  /// mislabelled as "No passwords".
  var emptyStateText: LocalizedStringKey = "No passwords for this site"

  @State private var pendingAppSideSelection: VaultEntrySummary?
  @State private var searchText: String = ""

  private var isSearching: Bool {
    !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// Default view shows `matched`; an active search filters across `all`.
  private var displayed: [VaultEntrySummary] {
    guard isSearching else { return matched }
    return all.filter { summaryMatchesSearch($0, query: searchText) }
  }

  // The `.app` IdentifierType is iOS 26+ only and isn't present in iOS 18 SDKs.
  // Reference its rawValue (1) instead of the symbol `.app` so this file
  // compiles on Xcode 16 / iOS 18 SDK as well as Xcode 26 / iOS 26 SDK.
  // Pre-iOS-26 devices never produce rawValue 1 (only `.URL` = 0), so the
  // check is also safe at runtime.
  private static let appServiceIdentifierTypeRawValue = 1

  private var isAppSideRequest: Bool {
    serviceIdentifiers.contains {
      $0.type.rawValue == Self.appServiceIdentifierTypeRawValue
    }
  }

  private var bundleID: String? {
    serviceIdentifiers.first {
      $0.type.rawValue == Self.appServiceIdentifierTypeRawValue
    }?.identifier
  }

  var body: some View {
    NavigationStack {
      Group {
        if displayed.isEmpty {
          emptyView
        } else {
          candidateList
        }
      }
      .navigationTitle("passwd-sso")
      .navigationBarTitleDisplayMode(.inline)
      .searchable(text: $searchText, prompt: "Search all entries")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: onCancel)
        }
      }
    }
    .sheet(item: $pendingAppSideSelection) { summary in
      appSideConfirmationSheet(for: summary)
    }
  }

  // MARK: - Subviews

  private var emptyView: some View {
    VStack(spacing: 16) {
      Image(systemName: "key.slash")
        .font(.system(size: 44))
        .foregroundStyle(.secondary)
      if isSearching {
        Text("No matches")
          .font(.headline)
      } else {
        Text(emptyStateText)
          .font(.headline)
        Text("Search to browse all entries.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
      }
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var candidateList: some View {
    List(displayed) { summary in
      Button {
        handleSelection(summary)
      } label: {
        CredentialRowView(summary: summary)
      }
      .buttonStyle(.plain)
    }
    .listStyle(.insetGrouped)
  }

  private func appSideConfirmationSheet(for summary: VaultEntrySummary) -> some View {
    NavigationStack {
      VStack(spacing: 24) {
        Image(systemName: "app.badge.checkmark")
          .font(.system(size: 48))
          .foregroundStyle(.blue)

        if let bundleID {
          Text("Fill for app?")
            .font(.headline)
          Text("Fill **\(summary.username)** for app:\n\(bundleID)")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        }

        Button("Fill") {
          pendingAppSideSelection = nil
          onSelect(summary)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)

        Button("Cancel", role: .cancel) {
          pendingAppSideSelection = nil
        }
        .controlSize(.large)
        .foregroundStyle(.red)
      }
      .padding()
      .navigationTitle("Confirm Fill")
      .navigationBarTitleDisplayMode(.inline)
    }
    .presentationDetents([.medium])
  }

  // MARK: - Selection logic

  private func handleSelection(_ summary: VaultEntrySummary) {
    if isAppSideRequest {
      // Extra confirmation tap required for app-side fills.
      pendingAppSideSelection = summary
    } else {
      onSelect(summary)
    }
  }
}

// MARK: - Row view

private struct CredentialRowView: View {
  let summary: VaultEntrySummary

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "key.fill")
        .foregroundStyle(.blue)
        .frame(width: 28)

      VStack(alignment: .leading, spacing: 2) {
        Text(summary.title)
          .font(.body)
          .lineLimit(1)
        Text(summary.username)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        if !summary.urlHost.isEmpty {
          Text(summary.urlHost)
            .font(.caption)
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        }
      }

      Spacer()
    }
    .padding(.vertical, 4)
  }
}
