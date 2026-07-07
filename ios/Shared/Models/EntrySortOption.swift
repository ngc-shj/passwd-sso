import Foundation

/// Sort key for the vault list. Mirrors web `entry-sort.ts` (`title`/
/// `createdAt`/`updatedAt`); `website` is iOS-only (no web reference — see
/// plan F1). String-backed for persistence in `AppSettingsStore`.
public enum EntrySortOption: String, CaseIterable, Sendable {
  case title
  case createdAt
  case updatedAt
  case website
}

extension EntrySortOption {
  /// Favorites-first, then the selected key. Mirrors web
  /// `compareEntriesWithFavorite`: favorites always precede non-favorites,
  /// regardless of key, applied BEFORE the per-key comparison.
  ///
  /// - title/website: ascending, case-insensitive (`localizedCaseInsensitiveCompare`).
  /// - createdAt/updatedAt: descending (newest first); nil sorts last.
  /// - website: empty (`""`) urlHost sorts last (never nil — see VaultEntrySummary).
  ///
  /// Swift's `sorted(by:)` is not guaranteed stable, so ties (including the
  /// nil/nil and ""/""cases) are broken by the original index to preserve
  /// input order.
  public func sorted(_ summaries: [VaultEntrySummary]) -> [VaultEntrySummary] {
    let indexed = Array(summaries.enumerated())
    let result = indexed.sorted { lhs, rhs in
      let (li, l) = lhs
      let (ri, r) = rhs
      if l.isFavorite != r.isFavorite {
        return l.isFavorite
      }
      switch keyCompare(l, r) {
      case .orderedAscending: return true
      case .orderedDescending: return false
      case .orderedSame: return li < ri
      }
    }
    return result.map(\.1)
  }

  private func keyCompare(_ l: VaultEntrySummary, _ r: VaultEntrySummary) -> ComparisonResult {
    switch self {
    case .title:
      return l.title.localizedCaseInsensitiveCompare(r.title)
    case .website:
      return compareSortLast(l.urlHost, r.urlHost, isEmpty: { $0.isEmpty }) {
        $0.localizedCaseInsensitiveCompare($1)
      }
    case .createdAt:
      return compareDateDescending(l.createdAt, r.createdAt)
    case .updatedAt:
      return compareDateDescending(l.updatedAt, r.updatedAt)
    }
  }

  /// Descending date compare (newest first); nil sorts after all non-nil dates.
  private func compareDateDescending(_ l: Date?, _ r: Date?) -> ComparisonResult {
    switch (l, r) {
    case (nil, nil): return .orderedSame
    case (nil, _): return .orderedDescending  // l sorts after r
    case (_, nil): return .orderedAscending   // l sorts before r
    case let (lv?, rv?):
      if lv == rv { return .orderedSame }
      return lv > rv ? .orderedAscending : .orderedDescending
    }
  }

  /// Ascending compare where the "empty" sentinel sorts last (used for
  /// website's `""` urlHost, the non-optional analogue of nil-last dates).
  private func compareSortLast<T>(
    _ l: T, _ r: T, isEmpty: (T) -> Bool, compare: (T, T) -> ComparisonResult
  ) -> ComparisonResult {
    switch (isEmpty(l), isEmpty(r)) {
    case (true, true): return .orderedSame
    case (true, false): return .orderedDescending
    case (false, true): return .orderedAscending
    case (false, false): return compare(l, r)
    }
  }
}
