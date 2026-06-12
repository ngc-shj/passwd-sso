import AuthenticationServices
import Shared
import SwiftUI

/// Presents a list of matched vault entries for the user to pick from.
///
/// Per plan §"App-side AutoFill (resolves S24)": for app-bundle-ID requests (non-URL),
/// the bundle ID is shown prominently and an extra confirmation tap is required.
///
/// Search spans ALL entries (matched first). Two guards mirror the browser
/// extension's canFill policy:
/// - selecting a NON-host-matched entry requires a mismatch confirmation
///   (one-tap injection into a phishing page must not be possible);
/// - passkey entries surfaced by a password-ceremony search are display-only
///   (filling one would inject an empty password).
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
  /// The passkey ceremony passes true — its rows ARE the selectable passkeys.
  /// In the password ceremony (default false) passkey entries are display-only.
  var passkeysSelectable: Bool = false

  @State private var pendingConfirmation: FillConfirmation?
  @State private var searchText: String = ""

  private var isSearching: Bool {
    !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// Default view shows `matched`; an active search filters across `all`.
  private var displayed: [VaultEntrySummary] {
    guard isSearching else { return matched }
    return all.filter { summaryMatchesSearch($0, query: searchText) }
  }

  private var matchedIds: Set<String> {
    Set(matched.map(\.id))
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

  /// Host of the page being filled (URL-type request), for the mismatch sheet.
  private var requestHost: String? {
    serviceIdentifiers
      .first { $0.type.rawValue != Self.appServiceIdentifierTypeRawValue }
      .map { URL(string: $0.identifier)?.host ?? $0.identifier }
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
    .sheet(item: $pendingConfirmation) { confirmation in
      switch confirmation {
      case .appSide(let summary):
        appSideConfirmationSheet(for: summary)
      case .hostMismatch(let summary):
        hostMismatchConfirmationSheet(for: summary)
      }
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
    List {
      Section {
        ForEach(displayed) { summary in
          let displayOnly = !passkeysSelectable && summary.relyingPartyId != nil
          Button {
            handleSelection(summary)
          } label: {
            CredentialRowView(summary: summary, displayOnly: displayOnly)
          }
          .buttonStyle(.plain)
          .disabled(displayOnly)
        }
      } header: {
        if isSearching {
          Text("Search Results")
        }
      }
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
          pendingConfirmation = nil
          onSelect(summary)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)

        Button("Cancel", role: .cancel) {
          pendingConfirmation = nil
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

  /// Mismatch guard (canFill parity with the browser extension): an entry found
  /// via search whose hosts do NOT match the page being filled gets an explicit
  /// warning instead of a one-tap fill.
  private func hostMismatchConfirmationSheet(for summary: VaultEntrySummary) -> some View {
    NavigationStack {
      VStack(spacing: 24) {
        Image(systemName: "exclamationmark.triangle")
          .font(.system(size: 48))
          .foregroundStyle(.orange)

        Text("Fill on a different site?")
          .font(.headline)
        Text("**\(summary.title)** is saved for:\n\(storedHostText(for: summary))")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        if let requestHost {
          Text("This site is:\n\(requestHost)")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        }

        Button("Fill Anyway") {
          pendingConfirmation = nil
          onSelect(summary)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)

        Button("Cancel", role: .cancel) {
          pendingConfirmation = nil
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

  private func storedHostText(for summary: VaultEntrySummary) -> String {
    summary.urlHost.isEmpty ? "—" : summary.urlHost
  }

  // MARK: - Selection logic

  private func handleSelection(_ summary: VaultEntrySummary) {
    if isAppSideRequest {
      // Extra confirmation tap required for app-side fills.
      pendingConfirmation = .appSide(summary)
    } else if !matchedIds.contains(summary.id) {
      // Non-host-matched entry reached via search — confirm before filling.
      pendingConfirmation = .hostMismatch(summary)
    } else {
      onSelect(summary)
    }
  }
}

// MARK: - Pending confirmation

private enum FillConfirmation: Identifiable {
  case appSide(VaultEntrySummary)
  case hostMismatch(VaultEntrySummary)

  var id: String {
    switch self {
    case .appSide(let summary): return "app-\(summary.id)"
    case .hostMismatch(let summary): return "host-\(summary.id)"
    }
  }
}

// MARK: - Row view

private struct CredentialRowView: View {
  let summary: VaultEntrySummary
  var displayOnly: Bool = false

  private var isPasskey: Bool { summary.relyingPartyId != nil }

  /// Passkey summaries usually carry the host in relyingPartyId, not urlHost.
  private var hostLine: String {
    summary.urlHost.isEmpty ? (summary.relyingPartyId ?? "") : summary.urlHost
  }

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: isPasskey ? "person.badge.key.fill" : "key.fill")
        .foregroundStyle(.blue)
        .frame(width: 28)

      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(summary.title)
            .font(.body)
            .lineLimit(1)
          if isPasskey {
            Text("Passkey")
              .font(.caption2.weight(.semibold))
              .padding(.horizontal, 6)
              .padding(.vertical, 2)
              .background(Capsule().fill(Color.blue.opacity(0.15)))
              .foregroundStyle(.blue)
          }
        }
        Text(summary.username)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        if !hostLine.isEmpty {
          Text(hostLine)
            .font(.caption)
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        }
      }

      Spacer()
    }
    .padding(.vertical, 4)
    // Display-only passkey rows are visually dimmed so the disabled state has
    // a visible cue (the fill itself happens through the passkey ceremony).
    .opacity(displayOnly ? 0.45 : 1)
  }
}
