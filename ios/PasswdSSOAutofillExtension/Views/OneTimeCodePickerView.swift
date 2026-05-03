import AuthenticationServices
import Shared
import SwiftUI

/// Presents a list of vault entries that have TOTP secrets for the user to pick from.
/// On selection, generates the current TOTP code and returns it via `onSelect`.
struct OneTimeCodePickerView: View {
  let candidates: [VaultEntrySummary]
  let serviceIdentifiers: [ASCredentialServiceIdentifier]
  let onSelect: (VaultEntrySummary) -> Void
  let onCancel: () -> Void

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
  }

  // MARK: - Subviews

  private var emptyView: some View {
    VStack(spacing: 16) {
      Image(systemName: "number.circle.fill")
        .font(.system(size: 44))
        .foregroundStyle(.secondary)
      Text("No matching one-time codes")
        .font(.headline)
      Text("No TOTP entries stored for this site.")
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
        onSelect(summary)
      } label: {
        TOTPRowView(summary: summary)
      }
      .buttonStyle(.plain)
    }
    .listStyle(.insetGrouped)
  }
}

// MARK: - TOTP row

private struct TOTPRowView: View {
  let summary: VaultEntrySummary

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "number.circle.fill")
        .foregroundStyle(.orange)
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

      Image(systemName: "chevron.right")
        .font(.caption)
        .foregroundStyle(.tertiary)
    }
    .padding(.vertical, 4)
  }
}
