import Shared
import SwiftUI
import UIKit

/// Displays a live TOTP code with countdown ring and a copy button.
/// Ticks every second using a Timer published through a @State timer task.
@MainActor
struct TOTPCodeView: View {
  let params: TOTPParams

  @State private var currentCode: String = "------"
  @State private var secondsRemaining: Int = 30
  @State private var copyConfirmed: Bool = false
  @State private var timerTask: Task<Void, Never>?

  var body: some View {
    VStack(spacing: 12) {
      ZStack {
        Circle()
          .stroke(Color.secondary.opacity(0.2), lineWidth: 3)
          .frame(width: 48, height: 48)

        Circle()
          .trim(from: 0, to: CGFloat(secondsRemaining) / CGFloat(params.period))
          .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 3, lineCap: .round))
          .frame(width: 48, height: 48)
          .rotationEffect(.degrees(-90))
          .animation(.linear(duration: 1), value: secondsRemaining)

        Text("\(secondsRemaining)")
          .font(.caption2.monospacedDigit())
          .foregroundStyle(.secondary)
      }

      TextField("", text: .constant(currentCode))
        .textContentType(.oneTimeCode)
        .font(.title2.monospacedDigit())
        .multilineTextAlignment(.center)
        .disabled(true)
        .privacySensitive()

      Button(copyConfirmed ? "Copied!" : "Copy") {
        copyToClipboard()
      }
      .buttonStyle(.borderedProminent)
      .disabled(currentCode == "------")
    }
    .onAppear {
      refresh()
      startTimer()
    }
    .onDisappear {
      timerTask?.cancel()
      timerTask = nil
    }
  }

  // MARK: - Private

  private func refresh() {
    let now = Date()
    if let code = try? generateTOTPCode(params: params, at: now) {
      currentCode = code
    }
    let epoch = Int(now.timeIntervalSince1970)
    secondsRemaining = params.period - (epoch % params.period)
  }

  private func startTimer() {
    timerTask?.cancel()
    timerTask = Task { @MainActor in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        refresh()
      }
    }
  }

  private func copyToClipboard() {
    UIPasteboard.general.setItems(
      [[UIPasteboard.typeAutomatic: currentCode]],
      options: [
        .localOnly: true,
        .expirationDate: Date().addingTimeInterval(60),
      ]
    )
    withAnimation { copyConfirmed = true }
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      copyConfirmed = false
    }
  }
}
