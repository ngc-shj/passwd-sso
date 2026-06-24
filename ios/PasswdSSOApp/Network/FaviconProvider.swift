import Foundation
import Shared

/// Builds server-proxied favicon URLs. All requests go through the app's own
/// server — no third-party hosts are ever contacted from iOS (T14).
enum FaviconProvider {
  /// Returns the URL for `GET <serverURL>/api/mobile/favicon?host=<h>&size=<s>`.
  ///
  /// Returns `nil` for empty or whitespace-only host values — there is no point
  /// sending a request the server would reject immediately. The server handles
  /// all other validation (IP addresses, .local, localhost, etc.).
  ///
  /// - Parameters:
  ///   - serverURL: The app's configured server base URL (e.g. https://example.com).
  ///   - host: The eTLD+1 or subdomain to fetch a favicon for.
  ///   - size: Requested icon dimension in logical pixels (e.g. 32, 64).
  static func iconURL(serverURL: URL, host: String, size: Int) -> URL? {
    guard !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }

    var components = URLComponents(
      url: serverURL.appending(path: APIPath.mobileFavicon, directoryHint: .notDirectory),
      resolvingAgainstBaseURL: false
    )
    // Percent-encode the host so characters like '+', '&', '=' that carry special
    // meaning in query strings are escaped. Start from urlQueryAllowed and remove
    // the characters that would be misinterpreted as query delimiters.
    var allowedInQueryValue = CharacterSet.urlQueryAllowed
    allowedInQueryValue.remove(charactersIn: "+&=")
    let encodedHost = host.addingPercentEncoding(withAllowedCharacters: allowedInQueryValue) ?? host
    let encodedSize = String(size)
    components?.percentEncodedQueryItems = [
      URLQueryItem(name: "host", value: encodedHost),
      URLQueryItem(name: "size", value: encodedSize),
    ]
    return components?.url
  }
}
