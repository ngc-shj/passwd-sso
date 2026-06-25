import Foundation

/// Read-only flags describing Demo Mode capabilities. Consumed by DemoVaultView
/// and unit-tested (DemoModeStateTests) as the falsifiable isolation proof that
/// demo never enables mutation, sync, or favicon fetch.
public struct DemoVaultPresentation: Sendable {
  public let showsMutationAffordances: Bool = false
  public let showsSyncControls: Bool = false
  public let showsFavicons: Bool = false
  /// Label for the exit affordance. String (not LocalizedStringKey) for Sendable conformance.
  public let exitLabel: String = "Exit Demo"

  public init() {}
}
