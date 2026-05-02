import AuthenticationServices
import Shared
import UIKit

final class CredentialProviderViewController: ASCredentialProviderViewController {
  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    // Step 4 placeholder: real matching arrives in Step 8.
    _ = Shared.frameworkVersion
  }

  override func provideCredentialWithoutUserInteraction(
    for credentialIdentity: ASPasswordCredentialIdentity
  ) {
    extensionContext.cancelRequest(
      withError: NSError(
        domain: ASExtensionErrorDomain,
        code: ASExtensionError.userInteractionRequired.rawValue
      )
    )
  }

  override func prepareInterfaceForExtensionConfiguration() {
    // Required by ASCredentialProviderViewController; populated in Step 8.
  }
}
