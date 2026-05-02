import AuthenticationServices
import Shared
import SwiftUI

/// Presents a list of matched vault entries for the user to pick from.
///
/// Per plan §"App-side AutoFill (resolves S24)": for app-bundle-ID requests (non-URL),
/// the bundle ID is shown prominently and an extra confirmation tap is required.
struct CredentialPickerView: View {
  let candidates: [VaultEntrySummary]
  let serviceIdentifiers: [ASCredentialServiceIdentifier]
  let onSelect: (VaultEntrySummary) -> Void
  let onCancel: () -> Void

  @State private var pendingAppSideSelection: VaultEntrySummary?

  private var isAppSideRequest: Bool {
    if #available(iOS 26.2, *) {
      return serviceIdentifiers.contains { $0.type == .app }
    }
    // Before iOS 26.2 there is no .app type; use URL type only.
    return false
  }

  private var bundleID: String? {
    if #available(iOS 26.2, *) {
      return serviceIdentifiers.first(where: { $0.type == .app })?.identifier
    }
    return nil
  }

  var body: some View {
    NavigationStack {
      Group {
        if candidates.isEmpty {
          emptyView
        } else {
          candidateList
        }
      }
      .navigationTitle("passwd-sso")
      .navigationBarTitleDisplayMode(.inline)
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
      Text("No matching credentials")
        .font(.headline)
      Text("No passwords stored for this site.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var candidateList: some View {
    List(candidates) { summary in
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

        Button("Cancel", role: .cancel) {
          pendingAppSideSelection = nil
        }
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
