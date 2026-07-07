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

/// Sort direction, independent of the key (matches the iOS Passwords app's
/// 昇順/降順 toggle). String-backed for persistence.
public enum EntrySortDirection: String, CaseIterable, Sendable {
  case ascending
  case descending
}

extension EntrySortOption {
  /// The natural direction for this key when the user has expressed no
  /// preference. Titles/websites read best A→Z (ascending); dates read best
  /// newest-first (descending). Used only as the persisted default.
  public var defaultDirection: EntrySortDirection {
    switch self {
    case .title, .website: return .ascending
    case .createdAt, .updatedAt: return .descending
    }
  }
}

extension EntrySortOption {
  /// Favorites-first, then the selected key in the given direction.
  ///
  /// Invariants (independent of `direction`):
  /// - favorites always precede non-favorites (applied BEFORE the per-key compare);
  /// - entries with no value on the key (nil date, empty `""` urlHost) always
  ///   sort LAST — they never bubble to the top when the direction flips;
  /// - ties are broken by original index, so the sort is STABLE (Swift's
  ///   `sorted(by:)` is not guaranteed stable).
  ///
  /// `direction` flips only the ordering AMONG populated values.
  public func sorted(
    _ summaries: [VaultEntrySummary],
    direction: EntrySortDirection
  ) -> [VaultEntrySummary] {
    let indexed = Array(summaries.enumerated())
    let result = indexed.sorted { lhs, rhs in
      let (li, l) = lhs
      let (ri, r) = rhs
      if l.isFavorite != r.isFavorite {
        return l.isFavorite
      }
      switch keyCompare(l, r, direction: direction) {
      case .orderedAscending: return true
      case .orderedDescending: return false
      case .orderedSame: return li < ri
      }
    }
    return result.map(\.1)
  }

  private func keyCompare(
    _ l: VaultEntrySummary, _ r: VaultEntrySummary, direction: EntrySortDirection
  ) -> ComparisonResult {
    switch self {
    case .title:
      return applyDirection(l.title.localizedCaseInsensitiveCompare(r.title), direction)
    case .website:
      return compareSortLast(l.urlHost, r.urlHost, isEmpty: { $0.isEmpty }) {
        applyDirection($0.localizedCaseInsensitiveCompare($1), direction)
      }
    case .createdAt:
      return compareDate(l.createdAt, r.createdAt, direction: direction)
    case .updatedAt:
      return compareDate(l.updatedAt, r.updatedAt, direction: direction)
    }
  }

  /// Flip an ascending-by-value comparison to descending when requested.
  private func applyDirection(
    _ result: ComparisonResult, _ direction: EntrySortDirection
  ) -> ComparisonResult {
    guard direction == .descending else { return result }
    switch result {
    case .orderedAscending: return .orderedDescending
    case .orderedDescending: return .orderedAscending
    case .orderedSame: return .orderedSame
    }
  }

  /// Date compare honoring `direction`; nil sorts last regardless of direction.
  private func compareDate(
    _ l: Date?, _ r: Date?, direction: EntrySortDirection
  ) -> ComparisonResult {
    switch (l, r) {
    case (nil, nil): return .orderedSame
    case (nil, _): return .orderedDescending  // l (nil) sorts after r
    case (_, nil): return .orderedAscending   // l sorts before r (nil)
    case let (lv?, rv?):
      if lv == rv { return .orderedSame }
      // Ascending = oldest first; direction flips to newest first.
      let ascending: ComparisonResult = lv < rv ? .orderedAscending : .orderedDescending
      return applyDirection(ascending, direction)
    }
  }

  /// Compare where the "empty" sentinel always sorts last (used for website's
  /// `""` urlHost), independent of `direction` — the populated-value compare
  /// (passed in) already carries the direction.
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
