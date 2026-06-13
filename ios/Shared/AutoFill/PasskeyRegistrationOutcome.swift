import Foundation

/// Why a passkey registration was cancelled (every non-success path).
public enum PasskeyRegistrationFailure: Equatable, Sendable {
  case unsupportedAlgorithm
  case vaultLocked
  case cryptoFailed
  case noUploadToken
  case uploadFailed
  case idMismatch
}

/// The single decision that gates `completeRegistrationRequest`. Only `.complete`
/// returns a credential to the relying party — everything else cancels.
public enum PasskeyRegistrationDecision: Equatable, Sendable {
  case cancel(PasskeyRegistrationFailure)
  case complete
}

/// Pure, exhaustive decision for the no-lockout invariant: a credential is
/// returned to the RP ONLY after the server confirmed a durable, id-matched
/// upload. The VC gathers each input (algorithm support, biometric/vault unlock,
/// crypto build, cached token, upload result) and calls this; it completes the
/// registration only on `.complete`, and cancels on any `.cancel`. Keeping the
/// precedence here (not in the imperative VC body) makes the invariant testable
/// against the sealed ASCredentialProviderExtensionContext.
public func passkeyRegistrationOutcome(
  algorithmSupported: Bool,
  vaultUnlocked: Bool,
  cryptoSucceeded: Bool,
  hasUploadToken: Bool,
  uploadedEntryId: String?,   // nil ⇒ the create POST did not return a 2xx id
  expectedEntryId: String
) -> PasskeyRegistrationDecision {
  guard algorithmSupported else { return .cancel(.unsupportedAlgorithm) }
  guard vaultUnlocked else { return .cancel(.vaultLocked) }
  guard cryptoSucceeded else { return .cancel(.cryptoFailed) }
  guard hasUploadToken else { return .cancel(.noUploadToken) }
  guard let id = uploadedEntryId else { return .cancel(.uploadFailed) }
  guard id == expectedEntryId else { return .cancel(.idMismatch) }
  return .complete
}
