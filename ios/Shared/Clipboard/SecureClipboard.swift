import UIKit

/// Seam over the system pasteboard so the copy options (which `UIPasteboard`
/// does not expose for read-back) are assertable in tests.
public protocol PasteboardWriter {
  func write(_ value: String, options: [UIPasteboard.OptionsKey: Any])
}

public struct SystemPasteboardWriter: PasteboardWriter {
  public init() {}
  public func write(_ value: String, options: [UIPasteboard.OptionsKey: Any]) {
    UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: value]], options: options)
  }
}

/// Copies a secret to the pasteboard with the same protections used app-wide:
/// `.localOnly` (no Universal Clipboard / Handoff) and a finite `.expirationDate`
/// so the value self-clears. Single source for every clipboard write of vault
/// material (entry fields, TOTP codes, AutoFill auto-copy).
public enum SecureClipboard {
  public static let minClearSeconds = 1
  public static let maxClearSeconds = 600

  public static func copy(
    _ value: String,
    clearAfter seconds: Int,
    writer: PasteboardWriter = SystemPasteboardWriter()
  ) {
    let bounded = max(minClearSeconds, min(maxClearSeconds, seconds))
    writer.write(
      value,
      options: [
        .localOnly: true,
        .expirationDate: Date().addingTimeInterval(Double(bounded)),
      ]
    )
  }
}
