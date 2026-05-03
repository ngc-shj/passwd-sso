import AuthenticationServices
import Shared
import SwiftUI
import UIKit

final class CredentialProviderViewController: ASCredentialProviderViewController {

  // MARK: - Resolver

  private lazy var resolver: CredentialResolver = {
    let bridgeKeyStore = BridgeKeyStore(
      accessGroup: AppGroupContainer.identifier
    )
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

  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    // Convert to Sendable ServiceIdentifier before the actor hop.
    let sendable = serviceIdentifiers.map { ServiceIdentifier(from: $0) }
    let originalIdents = serviceIdentifiers.map {
      ASCredentialServiceIdentifier(identifier: $0.identifier, type: $0.type)
    }
    Task { @MainActor in
      do {
        let candidates = try await resolver.resolveCandidates(for: sendable)
        presentPicker(with: candidates, serviceIdentifiers: originalIdents)
      } catch CredentialResolver.Error.vaultLocked {
        presentLockedSheet()
      } catch {
        cancel(with: error)
      }
    }
  }

  /// Per plan §"Per-fill biometric": per-fill biometric is required. Always require user interaction.
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

  /// Single-credential path: iOS already knows which credential to provide.
  override func prepareInterfaceToProvideCredential(
    for credentialIdentity: ASPasswordCredentialIdentity
  ) {
    Task { @MainActor in
      do {
        let detail = try await resolver.decryptEntryDetail(
          entryId: credentialIdentity.recordIdentifier ?? ""
        )
        let credential = ASPasswordCredential(user: detail.username, password: detail.password)
        extensionContext.completeRequest(withSelectedCredential: credential)
      } catch {
        cancel(with: error)
      }
    }
  }

  override func prepareInterfaceForExtensionConfiguration() {
    // Configuration UI — not needed for credential provider; no-op.
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
        let candidates = try await resolver.resolveCandidates(for: sendable)
        let withTOTP = candidates.filter { $0.hasTOTP }
        presentOneTimeCodePicker(with: withTOTP, serviceIdentifiers: originalIdents)
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
    with candidates: [VaultEntrySummary],
    serviceIdentifiers: [ASCredentialServiceIdentifier]
  ) {
    let view = CredentialPickerView(
      candidates: candidates,
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
    with candidates: [VaultEntrySummary],
    serviceIdentifiers: [ASCredentialServiceIdentifier]
  ) {
    let view = OneTimeCodePickerView(
      candidates: candidates,
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
      onOpen: { [weak self] in
        self?.openHostApp()
      },
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

  // MARK: - Host-app deep link (iOS 17+)

  private func openHostApp() {
    if #available(iOS 17.0, *) {
      // extensionContext.open is not available to credential provider extensions;
      // dismiss so the user can switch to the host app manually.
      cancel(with: nil)
    } else {
      cancel(with: nil)
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

