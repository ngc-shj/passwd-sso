import Foundation
import Security

/// Keychain label of the AutoFill extension's OWN Secure Enclave DPoP key
/// (plan C4/S1). Distinct from the host's `com.passwd-sso.dpop.host`: SE keys
/// are immutable after creation, so the host key can never be re-homed for the
/// extension — instead this key is born accessible to BOTH targets. With the
/// single `$(AppIdentifierPrefix)jp.jpng.passwd-sso.shared` keychain-access-
/// groups entitlement on host and extension, the DEFAULT access group used by
/// `generateDPoPKey` IS the shared group (an explicit literal group string
/// fails with errSecMissingEntitlement on device — see BridgeKeyStore).
public let autofillDPoPKeyLabel = "com.passwd-sso.dpop.autofill"

/// Load the AutoFill DPoP key, generating it on first use. The host calls this
/// to mint a jkt-bound upload token; the extension calls it to sign the DPoP
/// proof on the registration upload.
public func getOrCreateAutofillDPoPKey() throws -> SecKey {
  if let existing = try? loadDPoPKey(label: autofillDPoPKeyLabel) {
    return existing
  }
  return try generateDPoPKey(label: autofillDPoPKeyLabel)
}
