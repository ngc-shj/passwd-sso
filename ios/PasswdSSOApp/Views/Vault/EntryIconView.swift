import Foundation
import SwiftUI

// Decision enum for which icon to render.
enum IconDecision: Equatable {
  case symbol(String)
  case favicon(host: String)
}

/// Renders the leading icon for a vault entry row.
/// LOGIN entries show a favicon when showFavicons is ON and the host is non-empty;
/// all other paths show an SF Symbol badge.
struct EntryIconView: View {
  let entryType: String?
  let urlHost: String
  let showFavicons: Bool
  var size: CGFloat = 32

  var body: some View {
    switch Self.decision(entryType: entryType, urlHost: urlHost, showFavicons: showFavicons) {
    case .symbol(let name):
      symbolBadge(name: name)
    case .favicon(let host):
      FaviconImageView(host: host, size: size)
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
    }
  }

  // White glyph on accent-colored filled rounded-rect badge — the same idiom
  // as CategoryCard after the C6 restyle.
  private func symbolBadge(name: String) -> some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
        .fill(Color.accentColor)
        .frame(width: size, height: size)
      Image(systemName: name)
        .font(.system(size: size * 0.5))
        .foregroundStyle(.white)
    }
  }

  // Pure decision seam — testable without SwiftUI rendering.
  static func decision(
    entryType: String?,
    urlHost: String,
    showFavicons: Bool
  ) -> IconDecision {
    let category = EntryTypeCategory.from(rawType: entryType)
    guard category == .login else {
      return .symbol(category.rowSymbol)
    }
    // LOGIN: check opt-in and host
    guard showFavicons, !urlHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return .symbol("globe")
    }
    return .favicon(host: urlHost)
  }
}

// MARK: - FaviconImageView

/// Loads a favicon via FaviconLoader and shows a globe placeholder while loading
/// or on any failure. Uses .task for automatic cancellation on disappear (NFR-2).
struct FaviconImageView: View {
  let host: String
  var size: CGFloat

  @State private var image: Image?

  var body: some View {
    Group {
      if let image {
        image
          .resizable()
          .scaledToFill()
      } else {
        // Placeholder while loading or on failure
        ZStack {
          RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
            .fill(Color.accentColor)
            .frame(width: size, height: size)
          Image(systemName: "globe")
            .font(.system(size: size * 0.5))
            .foregroundStyle(.white)
        }
      }
    }
    .task(id: host) {
      // Use the larger of 32/64 buckets for better quality on Retina
      let bucket = size <= 32 ? 32 : 64
      image = await FaviconLoader.shared?.image(forHost: host, size: bucket)
    }
  }
}
