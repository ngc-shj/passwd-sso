import Foundation

/// Port of extension/src/lib/url-matching.ts.

/// Extract the normalized host from a URL string.
/// Returns nil for non-http(s) URLs or unparseable strings.
public func extractHost(_ urlString: String) -> String? {
  guard let url = URL(string: urlString),
        let scheme = url.scheme?.lowercased(),
        (scheme == "http" || scheme == "https"),
        let host = url.host, !host.isEmpty else {
    return nil
  }
  return normalizeHost(host)
}

/// Strip www. prefix (case-insensitive) and lowercase.
private func normalizeHost(_ host: String) -> String {
  var result = host.lowercased()
  if result.hasPrefix("www.") {
    result = String(result.dropFirst(4))
  }
  return result
}

/// True if current host matches stored host exactly, or is a subdomain of it.
/// Both inputs are normalized before comparison.
public func isHostMatch(stored: String, current: String) -> Bool {
  let e = normalizeHost(stored)
  let t = normalizeHost(current)
  if e == t { return true }
  return t.hasSuffix(".\(e)")
}

/// Protocol for entries that can be sorted by URL match.
public protocol URLMatchable {
  var urlHost: String { get }
  var additionalUrlHosts: [String] { get }
}

/// Sort entries so URL-matched ones appear first.
public func sortByURLMatch<T: URLMatchable>(_ entries: [T], tabHost: String?) -> [T] {
  guard let tabHost else { return entries }
  var matched: [T] = []
  var other: [T] = []
  for entry in entries {
    let primary = !entry.urlHost.isEmpty && isHostMatch(stored: entry.urlHost, current: tabHost)
    let additional = entry.additionalUrlHosts.contains { isHostMatch(stored: $0, current: tabHost) }
    if primary || additional {
      matched.append(entry)
    } else {
      other.append(entry)
    }
  }
  return matched + other
}
