import SwiftUI

/// Minimal progress UI shown while a deferred fill (password, TOTP, or passkey)
/// waits for its biometric. The biometric itself is triggered from the host view
/// controller's `viewDidAppear` (the reliable foreground point) — not from this
/// view's `onAppear`, which fires before the extension window is key and fails
/// the biometric with -1004 ("Caller is not running foreground").
struct FillProgressView: View {
  var body: some View {
    VStack(spacing: 16) {
      ProgressView()
      Text("Authenticating…")
        .font(.callout)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
