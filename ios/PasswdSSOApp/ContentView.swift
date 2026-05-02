import Shared
import SwiftUI

struct ContentView: View {
  var body: some View {
    VStack(spacing: 16) {
      Text("passwd-sso")
        .font(.largeTitle)
      Text("Shared framework v\(Shared.frameworkVersion)")
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
    .padding()
  }
}

#Preview {
  ContentView()
}
