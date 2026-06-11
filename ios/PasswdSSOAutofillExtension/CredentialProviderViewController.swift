import AuthenticationServices
import Shared
import SwiftUI
import UIKit

final class CredentialProviderViewController: ASCredentialProviderViewController {

  // MARK: - Resolver

  private lazy var resolver: CredentialResolver = {
    // No explicit access group: the item lives in the app's default keychain
    // access group (the single `$(AppIdentifierPrefix)…shared` entitlement),
    // which the host app shares. An App Group id is not a valid keychain
    // access group on device.
    let bridgeKeyStore = BridgeKeyStore()
    let wrappedKeyStore = AppGroupWrappedKeyStore()
    let cacheURL = (try? AppGroupContainer.cacheFileURL()) ?? URL(fileURLWithPath: "/dev/null")
    let flagDir = (try? AppGroupContainer.url()
      .appending(path: "vault", directoryHint: .isDirectory)) ?? URL(fileURLWithPath: "/dev/null")
    let flagWriter = AppGroupRollbackFlagWriter(directory: flagDir)
    return CredentialResolver(
      bridgeKeyStore: bridgeKeyStore,
      wrappedKeyStore: wrappedKeyStore,
      cacheURL: cacheURL,
      rollbackFlagWriter: flagWriter
    )
  }()

  // MARK: - Password fill (Step 8)
  //
  // Deployment target is iOS 17.0, so iOS always calls the iOS 17+ method
  // variants below; the legacy ASPasswordCredentialIdentity-based overrides are
  // never invoked and are intentionally absent. The requestParameters list
  // variant is the one iOS 18/26 actually calls — without it the picker was
  // presented blank (no prepare* ran). It delegates to the shared presentation.

  /// Shared password-list presentation, called by the iOS 17+ entry point.
  private func presentCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    // Convert to Sendable ServiceIdentifier before the actor hop.
    let sendable = serviceIdentifiers.map { ServiceIdentifier(from: $0) }
    let originalIdents = serviceIdentifiers.map {
      ASCredentialServiceIdentifier(identifier: $0.identifier, type: $0.type)
    }
    Task { @MainActor in
      do {
        let result = try await resolver.resolveCandidates(for: sendable)
        presentPicker(
          matched: result.matched,
          all: result.all,
          serviceIdentifiers: originalIdents
        )
      } catch CredentialResolver.Error.vaultLocked {
        presentLockedSheet()
      } catch {
        cancel(with: error)
      }
    }
  }

  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    presentCredentialList(for: serviceIdentifiers)
  }

  /// iOS 17+ passkey-aware list entry point — the variant iOS 18/26 actually
  /// invokes. Passkeys are unsupported, so the request parameters are ignored
  /// and we present the password list.
  @available(iOS 17.0, *)
  override func prepareCredentialList(
    for serviceIdentifiers: [ASCredentialServiceIdentifier],
    requestParameters: ASPasskeyCredentialRequestParameters
  ) {
    presentCredentialList(for: serviceIdentifiers)
  }

  override func prepareInterfaceForExtensionConfiguration() {
    // Configuration UI — not needed for credential provider; no-op.
  }

  // MARK: - Single-credential fill (iOS 17+)

  /// Per-fill biometric is mandatory: never fill silently. Always require user
  /// interaction so the subsequent prepare-to-provide path runs the biometric
  /// Keychain read.
  @available(iOS 17.0, *)
  override func provideCredentialWithoutUserInteraction(
    for credentialRequest: any ASCredentialRequest
  ) {
    extensionContext.cancelRequest(
      withError: NSError(
        domain: ASExtensionErrorDomain,
        code: ASExtensionError.userInteractionRequired.rawValue
      )
    )
  }

  /// Single-credential path: iOS already knows which credential to provide.
  @available(iOS 17.0, *)
  override func prepareInterfaceToProvideCredential(
    for credentialRequest: any ASCredentialRequest
  ) {
    // Only password requests are supported; cancel passkey assertions rather
    // than completing them with the wrong credential type.
    guard credentialRequest.type == .password else {
      cancel(with: nil)
      return
    }
    let recordId = credentialRequest.credentialIdentity.recordIdentifier ?? ""
    Task { @MainActor in
      do {
        let detail = try await resolver.decryptEntryDetail(entryId: recordId)
        let credential = ASPasswordCredential(user: detail.username, password: detail.password)
        extensionContext.completeRequest(withSelectedCredential: credential)
      } catch {
        cancel(with: error)
      }
    }
  }

  // MARK: - TOTP fill (Step 9, iOS 17+)

  @available(iOS 17.0, *)
  override func prepareOneTimeCodeCredentialList(
    for serviceIdentifiers: [ASCredentialServiceIdentifier]
  ) {
    let sendable = serviceIdentifiers.map { ServiceIdentifier(from: $0) }
    let originalIdents = serviceIdentifiers.map {
      ASCredentialServiceIdentifier(identifier: $0.identifier, type: $0.type)
    }
    Task { @MainActor in
      do {
        let result = try await resolver.resolveCandidates(for: sendable)
        // Default view = host-matched entries flagged as having TOTP. Search
        // spans all entries WITHOUT the hasTOTP gate, because the overview-blob
        // hasTOTP marker is unreliable for legacy entries (see
        // TODO(ios-autofill-hastotp)); completeTOTPFill guards on the actual
        // decrypted secret, so a non-TOTP pick is a safe no-op.
        presentOneTimeCodePicker(
          matched: result.matched.filter { $0.hasTOTP },
          all: result.all,
          serviceIdentifiers: originalIdents
        )
      } catch CredentialResolver.Error.vaultLocked {
        presentLockedSheet()
      } catch {
        cancel(with: error)
      }
    }
  }

  // MARK: - UI presentation helpers

  @MainActor
  private func presentPicker(
    matched: [VaultEntrySummary],
    all: [VaultEntrySummary],
    serviceIdentifiers: [ASCredentialServiceIdentifier]
  ) {
    let view = CredentialPickerView(
      matched: matched,
      all: all,
      serviceIdentifiers: serviceIdentifiers,
      onSelect: { [weak self] summary in
        self?.completePasswordFill(for: summary)
      },
      onCancel: { [weak self] in
        self?.cancel(with: nil)
      }
    )
    presentSwiftUI(view)
  }

  @MainActor
  private func presentOneTimeCodePicker(
    matched: [VaultEntrySummary],
    all: [VaultEntrySummary],
    serviceIdentifiers: [ASCredentialServiceIdentifier]
  ) {
    let view = OneTimeCodePickerView(
      matched: matched,
      all: all,
      serviceIdentifiers: serviceIdentifiers,
      onSelect: { [weak self] summary in
        self?.completeTOTPFill(for: summary)
      },
      onCancel: { [weak self] in
        self?.cancel(with: nil)
      }
    )
    presentSwiftUI(view)
  }

  @MainActor
  private func presentLockedSheet() {
    let view = LockedFallbackView(
      onDismiss: { [weak self] in
        self?.cancel(with: nil)
      }
    )
    presentSwiftUI(view)
  }

  // MARK: - Completion

  private func completePasswordFill(for summary: VaultEntrySummary) {
    Task { @MainActor in
      do {
        let detail = try await resolver.decryptEntryDetail(entryId: summary.id)
        let credential = ASPasswordCredential(user: detail.username, password: detail.password)
        extensionContext.completeRequest(withSelectedCredential: credential)
      } catch {
        cancel(with: error)
      }
    }
  }

  private func completeTOTPFill(for summary: VaultEntrySummary) {
    Task { @MainActor in
      do {
        let detail = try await resolver.decryptEntryDetail(entryId: summary.id)
        guard let secret = detail.totpSecret else {
          cancel(with: nil)
          return
        }
        let code = try generateTOTPCode(params: TOTPParams(secret: secret), at: Date())
        if #available(iOS 18.0, *) {
          let credential = ASOneTimeCodeCredential(code: code)
          await extensionContext.completeOneTimeCodeRequest(using: credential)
        } else {
          cancel(with: nil)
        }
      } catch {
        cancel(with: error)
      }
    }
  }

  // MARK: - Shared helpers

  @MainActor
  private func presentSwiftUI<V: View>(_ view: V) {
    let host = UIHostingController(rootView: view)
    addChild(host)
    host.view.translatesAutoresizingMaskIntoConstraints = false
    self.view.addSubview(host.view)
    NSLayoutConstraint.activate([
      host.view.topAnchor.constraint(equalTo: self.view.topAnchor),
      host.view.leadingAnchor.constraint(equalTo: self.view.leadingAnchor),
      host.view.trailingAnchor.constraint(equalTo: self.view.trailingAnchor),
      host.view.bottomAnchor.constraint(equalTo: self.view.bottomAnchor),
    ])
    host.didMove(toParent: self)
  }

  private func cancel(with error: Swift.Error?) {
    let nsError: NSError
    if let error {
      nsError = error as NSError
    } else {
      nsError = NSError(
        domain: ASExtensionErrorDomain,
        code: ASExtensionError.failed.rawValue
      )
    }
    extensionContext.cancelRequest(withError: nsError)
  }
}

