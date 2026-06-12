import Foundation
import Shared

/// A landing-grid category. Categories are filters, not a partition — an entry
/// can match several (Login + Codes + Favorite + a Tag).
enum VaultCategory: Hashable {
  case all
  case type(EntryTypeCategory)
  case codes
  case favorites
  case tag(String)
}

/// Pure, deterministic membership test (no I/O, no clock).
func matches(_ summary: VaultEntrySummary, _ category: VaultCategory) -> Bool {
  switch category {
  case .all: true
  case .type(let t): EntryTypeCategory.from(rawType: summary.entryType) == t
  case .codes: summary.hasTOTP
  case .favorites: summary.isFavorite
  case .tag(let name): summary.tags.contains(name)
  }
}

/// Distinct tags across the summaries, sorted for stable display order.
func distinctTags(_ summaries: [VaultEntrySummary]) -> [String] {
  Set(summaries.flatMap { $0.tags }).sorted()
}

/// Count per category. Includes All / Codes / Favorites unconditionally, each
/// entry type with a non-zero count, and one entry per distinct tag.
func categoryCounts(_ summaries: [VaultEntrySummary]) -> [VaultCategory: Int] {
  var counts: [VaultCategory: Int] = [
    .all: summaries.count,
    .codes: summaries.filter { matches($0, .codes) }.count,
    .favorites: summaries.filter { matches($0, .favorites) }.count,
  ]
  for type in EntryTypeCategory.allCases {
    let c = summaries.filter { matches($0, .type(type)) }.count
    if c > 0 { counts[.type(type)] = c }
  }
  for tag in distinctTags(summaries) {
    counts[.tag(tag)] = summaries.filter { matches($0, .tag(tag)) }.count
  }
  return counts
}
