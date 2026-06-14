import AuthenticationServices
import OSLog
import Shared
import SwiftUI
import UIKit

final class CredentialProviderViewController: ASCredentialProviderViewController {

  // Diagnostic only — confirms the extension is invoked and which branch runs,
  // so the AutoFill "vault locked" symptom is traceable in Console.app.
  private static let log = Logger(subsystem: "jp.jpng.passwd-sso", category: "autofill")

  // Work deferred until the extension view is foreground (viewDidAppear) — the
  // reliable point for the biometric keychain read (`evaluateAccessControl`),
  // which fails with -1004 ("not running foreground") when run earlier. EVERY
  // fill path (password list, password provide, TOTP list, passkey list, passkey
  // provide) must route its first biometric through this deferral — a direct
  // call from prepare* surfaces as a bogus "Vault is Locked" sheet.
  // `foregroundWorkStarted` guards viewDidAppear firing more than once.
  private var pendingForegroundWork: (() -> Void)?
  private var foregroundWorkStarted = false

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
    // Defer resolveCandidates (a biometric keychain read) to viewDidAppear —
    // running it here fails with -1004 ("Caller is not running foreground"),
    // which used to surface as a bogus "Vault is Locked" sheet.
    deferToForeground { [weak self] in
      self?.runPasswordList(sendable: sendable, originalIdents: originalIdents)
    }
  }

  /// Resolve password candidates (foreground biometric) and present the picker.
  @MainActor
  private func runPasswordList(
    sendable: [ServiceIdentifier],
    originalIdents: [ASCredentialServiceIdentifier]
  ) {
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
  /// invokes. For a passkey ceremony (non-empty relyingPartyIdentifier) we
  /// present a passkey picker filtered to the requested rpId; password-only
  /// ceremonies keep presenting the password list.
  @available(iOS 17.0, *)
  override func prepareCredentialList(
    for serviceIdentifiers: [ASCredentialServiceIdentifier],
    requestParameters: ASPasskeyCredentialRequestParameters
  ) {
    let rpId = requestParameters.relyingPartyIdentifier
    if rpId.isEmpty {
      presentCredentialList(for: serviceIdentifiers)
    } else {
      presentPasskeyList(for: serviceIdentifiers, requestParameters: requestParameters)
    }
  }

  /// Present a passkey picker for the requested rpId. On selection, build the
  /// assertion from the OS-provided request parameters (clientDataHash etc.).
  @available(iOS 17.0, *)
  @MainActor
  private func presentPasskeyList(
    for serviceIdentifiers: [ASCredentialServiceIdentifier],
    requestParameters: ASPasskeyCredentialRequestParameters
  ) {
    let sendable = serviceIdentifiers.map { ServiceIdentifier(from: $0) }
    let originalIdents = serviceIdentifiers.map {
      ASCredentialServiceIdentifier(identifier: $0.identifier, type: $0.type)
    }
    let request = PasskeyAssertionRequest(
      relyingPartyId: requestParameters.relyingPartyIdentifier,
      clientDataHash: requestParameters.clientDataHash,
      userVerificationRequired: requestParameters.userVerificationPreference == .required
    )
    deferToForeground { [weak self] in
      self?.runPasskeyList(sendable: sendable, originalIdents: originalIdents, request: request)
    }
  }

  /// Resolve passkey candidates (foreground biometric) and present the picker.
  @available(iOS 17.0, *)
  @MainActor
  private func runPasskeyList(
    sendable: [ServiceIdentifier],
    originalIdents: [ASCredentialServiceIdentifier],
    request: PasskeyAssertionRequest
  ) {
    Task { @MainActor in
      do {
        let result = try await resolver.resolveCandidates(for: sendable)
        let matches = filterPasskeyCandidates(result.all, rpId: request.relyingPartyId)
        let view = CredentialPickerView(
          matched: matches,
          // Search stays within passkey candidates — offering a non-passkey
          // entry in a passkey ceremony would be wrong, so `all` == `matches`.
          all: matches,
          serviceIdentifiers: originalIdents,
          onSelect: { [weak self] summary in
            self?.completePasskeyAssertion(entryId: summary.id, request: request)
          },
          onCancel: { [weak self] in self?.cancel(with: nil) },
          emptyStateText: "No passkeys for this site",
          passkeysSelectable: true
        )
        presentSwiftUI(view)
      } catch CredentialResolver.Error.vaultLocked {
        presentLockedSheet()
      } catch {
        cancel(with: error)
      }
    }
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
    switch credentialRequest.type {
    case .password:
      let recordId = credentialRequest.credentialIdentity.recordIdentifier ?? ""
      deferToForeground { [weak self] in
        self?.completePasswordProvide(recordId: recordId)
      }
    case .passkeyAssertion:
      guard
        let passkeyRequest = credentialRequest as? ASPasskeyCredentialRequest,
        let identity = passkeyRequest.credentialIdentity as? ASPasskeyCredentialIdentity,
        let recordId = identity.recordIdentifier, !recordId.isEmpty
      else {
        cancel(with: nil)
        return
      }
      let request = PasskeyAssertionRequest(
        relyingPartyId: identity.relyingPartyIdentifier,
        clientDataHash: passkeyRequest.clientDataHash,
        userVerificationRequired: passkeyRequest.userVerificationPreference == .required
      )
      deferToForeground { [weak self] in
        self?.completePasskeyAssertion(entryId: recordId, request: request)
      }
    default:
      cancel(with: nil)
    }
  }

  /// Decrypt the single requested entry (foreground biometric) and complete.
  @MainActor
  private func completePasswordProvide(recordId: String) {
    Task { @MainActor in
      do {
        let detail = try await resolver.decryptEntryDetail(entryId: recordId)
        let credential = ASPasswordCredential(user: detail.username, password: detail.password)
        autoCopyTotpIfEnabled(detail)
        extensionContext.completeRequest(withSelectedCredential: credential)
      } catch {
        cancel(with: error)
      }
    }
  }

  /// Resolve the chosen passkey entry, build the assertion, and complete the
  /// request. UV/UP are true (every fill is biometric-gated); signCount comes from
  /// the persisted monotonic store; BE/BS are set (iOS treats provider passkeys as
  /// synced and the system rejects the assertion without the backup-state flag).
  @available(iOS 17.0, *)
  private func completePasskeyAssertion(entryId: String, request: PasskeyAssertionRequest) {
    Task { @MainActor in
      do {
        var material = try await resolver.decryptPasskeyMaterial(entryId: entryId)
        defer { material.zeroPrivateKey() }
        // Persisted, monotonic sign count so consecutive offline assertions are
        // accepted by the RP's counter check.
        let signCount = PasskeySignCountStore().next(
          credentialId: material.credentialId, floor: material.signCount
        )
        let outputs = try buildPasskeyAssertion(material: material, request: request, signCount: signCount)
        let credential = ASPasskeyAssertionCredential(
          userHandle: outputs.userHandle,
          relyingParty: outputs.relyingParty,
          signature: outputs.signature,
          clientDataHash: request.clientDataHash,
          authenticatorData: outputs.authenticatorData,
          credentialID: outputs.credentialID
        )
        // The async result is the completion handler's `expired` flag (OS
        // background-task lifecycle), NOT a delivery success/failure. Calling
        // this completes+dismisses the request; there is no "delivered" bool.
        // (The previous `if !delivered` logged a false "system rejected" on the
        // normal success path, where expired == false.)
        _ = await extensionContext.completeAssertionRequest(using: credential)
      } catch {
        Self.log.error("completePasskeyAssertion FAILED: \(String(describing: error), privacy: .public)")
        cancel(with: error)
      }
    }
  }

  // MARK: - Passkey registration (plan C7)

  /// Sendable inputs captured from the OS registration request before the
  /// foreground deferral (the AS* request types are not Sendable).
  private struct PasskeyRegistrationInput: Sendable {
    let relyingPartyId: String
    let userName: String
    let userHandle: Data
    let clientDataHash: Data
    let algorithmSupported: Bool
  }

  /// Synchronous-upload registration: generate a P-256 credential, E2E-encrypt
  /// it, POST it to the server over the DPoP-bound upload channel, and return
  /// the attestation ONLY after the server confirmed the save. Every failure
  /// cancels (iOS falls through to iCloud Keychain) — a credential the server
  /// has not durably stored must never reach the relying party (no-lockout).
  @available(iOS 17.0, *)
  override func prepareInterface(forPasskeyRegistration registrationRequest: any ASCredentialRequest) {
    guard
      let request = registrationRequest as? ASPasskeyCredentialRequest,
      let identity = request.credentialIdentity as? ASPasskeyCredentialIdentity,
      !identity.relyingPartyIdentifier.isEmpty,
      !identity.userHandle.isEmpty
    else {
      cancel(with: nil)
      return
    }
    let input = PasskeyRegistrationInput(
      relyingPartyId: identity.relyingPartyIdentifier,
      userName: identity.userName,
      userHandle: identity.userHandle,
      clientDataHash: request.clientDataHash,
      algorithmSupported: request.supportedAlgorithms.contains(.ES256)
    )
    deferToForeground { [weak self] in
      self?.runPasskeyRegistration(input: input)
    }
  }

  /// Gather every outcome input (algorithm, vault/biometric, crypto, token,
  /// upload), then let `passkeyRegistrationOutcome` make the SINGLE decision.
  /// `completeRegistrationRequest` is reachable from exactly one branch.
  @available(iOS 17.0, *)
  @MainActor
  private func runPasskeyRegistration(input: PasskeyRegistrationInput) {
    Task { @MainActor in
      let entryId = UUID().uuidString.lowercased()

      var vaultUnlocked = false
      var cryptoSucceeded = false
      var hasUploadToken = false
      var uploadedEntryId: String?
      var generated: GeneratedPasskey?
      var attestationObject = Data()
      var encryption: CredentialResolver.RegistrationEncryption?

      if input.algorithmSupported {
        do {
          let passkey = generatePasskey()
          let authData = buildRegistrationAuthData(
            rpId: input.relyingPartyId,
            signCount: 0,
            credentialId: passkey.credentialId,
            coseKey: passkey.publicKeyCOSE
          )
          attestationObject = buildNoneAttestationObject(authData: authData)
          let (blob, overview) = try PasskeyEntryBlobBuilder.buildCreate(
            rpId: input.relyingPartyId,
            rpName: input.relyingPartyId,
            userName: input.userName,
            userHandle: input.userHandle,
            userDisplayName: input.userName,
            passkey: passkey,
            creationDate: ISO8601DateFormatter().string(from: Date())
          )
          // Biometric gate + vault unwrap + AAD-bound encryption. The plaintext
          // blob (private-key JWK inside) stays in this scope only; zeroing is
          // best-effort (S4 — CryptoKit owns the P256 key buffer).
          encryption = try await resolver.encryptPasskeyEntry(
            entryId: entryId,
            blobPlaintext: blob,
            overviewPlaintext: overview
          )
          vaultUnlocked = true
          cryptoSucceeded = true
          generated = passkey
        } catch CredentialResolver.Error.vaultLocked {
          Self.log.error("passkey registration: vault locked")
        } catch {
          Self.log.error("passkey registration: crypto/encrypt failed: \(String(describing: error), privacy: .public)")
          // encryptPasskeyEntry only ran after biometrics if crypto reached it;
          // treat any non-lock failure as a crypto failure (still a cancel).
          vaultUnlocked = true
        }
      }

      if let encryption {
        let uploadTokenStore = UploadTokenStore()
        if let stored = try? uploadTokenStore.loadValid(),
           let serverConfig = loadServerConfig(),
           let dpopKey = try? getOrCreateAutofillDPoPKey(),
           let extensionJWK = try? exportPublicKeyJWK(key: dpopKey) {
          hasUploadToken = true
          let uploader = EntryUploader(
            serverURL: serverConfig.baseURL,
            signer: SecureEnclaveDPoPSigner(key: dpopKey),
            jwk: extensionJWK,
            accessToken: stored.token,
            initialNonce: stored.dpopNonce,
            onNonceUpdate: { [uploadTokenStore] nonce in try? uploadTokenStore.saveNonce(nonce) }
          )
          let body = CreateEntryRequest(
            id: entryId,
            encryptedBlob: encryption.encryptedBlob,
            encryptedOverview: encryption.encryptedOverview,
            keyVersion: encryption.keyVersion,
            aadVersion: 1,
            entryType: "PASSKEY"
          )
          do {
            uploadedEntryId = try await uploader.createEntry(body: body)
          } catch {
            Self.log.error("passkey registration: upload failed: \(String(describing: error), privacy: .public)")
          }
        } else {
          Self.log.error("passkey registration: no valid upload token / server config")
        }
      }

      // THE single decision point (C3). Only `.complete` returns a credential.
      let decision = passkeyRegistrationOutcome(
        algorithmSupported: input.algorithmSupported,
        vaultUnlocked: vaultUnlocked,
        cryptoSucceeded: cryptoSucceeded,
        hasUploadToken: hasUploadToken,
        uploadedEntryId: uploadedEntryId,
        expectedEntryId: entryId
      )
      guard decision == .complete, let encryption, let passkey = generated else {
        Self.log.error("passkey registration cancelled: \(String(describing: decision), privacy: .public)")
        cancel(with: nil)
        return
      }

      // Server save is confirmed — everything below is best-effort local
      // bookkeeping and must NOT cancel the ceremony anymore.
      await persistRegistrationLocally(
        input: input, entryId: entryId, encryption: encryption, passkey: passkey
      )

      let credential = ASPasskeyRegistrationCredential(
        relyingParty: input.relyingPartyId,
        clientDataHash: input.clientDataHash,
        credentialID: passkey.credentialId,
        attestationObject: attestationObject
      )
      // The async result is the completion handler's `expired` flag (whether the
      // OS prematurely ended a background completion task) — NOT a delivery
      // success/failure signal. Calling this method already completes+dismisses
      // the request; there is no per-call "delivered" boolean. Do not treat it
      // as failure (the previous code logged a false "is now unused" on success).
      _ = await extensionContext.completeRegistrationRequest(using: credential)
    }
  }

  /// Append the confirmed entry to the local cache and register its QuickType
  /// identity so an immediate assertion on this device works before the next
  /// host sync. Failures are logged only — the server copy is durable.
  @available(iOS 17.0, *)
  @MainActor
  private func persistRegistrationLocally(
    input: PasskeyRegistrationInput,
    entryId: String,
    encryption: CredentialResolver.RegistrationEncryption,
    passkey: GeneratedPasskey
  ) async {
    let cacheEntry = CacheEntry(
      id: entryId,
      teamId: nil,
      aadVersion: 1,
      keyVersion: encryption.keyVersion,
      encryptedBlob: encryption.encryptedBlob,
      encryptedOverview: encryption.encryptedOverview,
      entryType: "PASSKEY"
    )
    do {
      try await resolver.appendEntryToCache(cacheEntry)
    } catch {
      Self.log.error("passkey registration: cache append failed (next host sync recovers): \(String(describing: error), privacy: .public)")
    }
    await CredentialIdentityRegistrar().add(passkeys: [
      PasskeyIdentitySpec(
        relyingPartyIdentifier: input.relyingPartyId,
        userName: input.userName,
        credentialID: passkey.credentialId,
        userHandle: input.userHandle,
        recordIdentifier: entryId
      )
    ])
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
    deferToForeground { [weak self] in
      self?.runOneTimeCodeList(sendable: sendable, originalIdents: originalIdents)
    }
  }

  /// Resolve TOTP candidates (foreground biometric) and present the picker.
  @available(iOS 17.0, *)
  @MainActor
  private func runOneTimeCodeList(
    sendable: [ServiceIdentifier],
    originalIdents: [ASCredentialServiceIdentifier]
  ) {
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

  /// Route a fill's first biometric through the viewDidAppear deferral: show
  /// the progress view now, run `work` once the extension is reliably
  /// foreground. Every prepare* entry point MUST use this instead of calling
  /// the resolver directly — see `pendingForegroundWork`.
  @MainActor
  private func deferToForeground(_ work: @escaping () -> Void) {
    // Re-arm the single-fire guard per entry point (F5): if iOS reuses this VC
    // for a second prepare* call (e.g. a registration after a list), a stale
    // `foregroundWorkStarted == true` would silently drop the new deferred work
    // and hang the ceremony with no cancel.
    foregroundWorkStarted = false
    pendingForegroundWork = work
    presentSwiftUI(FillProgressView())
  }

  /// The extension is reliably foreground here, so a deferred fill's biometric
  /// (`evaluateAccessControl`) can run without -1004. Consume once.
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard let work = pendingForegroundWork, !foregroundWorkStarted else { return }
    foregroundWorkStarted = true
    pendingForegroundWork = nil
    work()
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

  /// Best-effort: after a login fill, copy the entry's current TOTP code to the
  /// clipboard when the user opted in. Must run BEFORE `completeRequest`, which
  /// dismisses (and may tear down) the extension. Never throws — a TOTP failure
  /// must not affect the password fill.
  @MainActor
  private func autoCopyTotpIfEnabled(_ detail: VaultEntryDetail) {
    let settings = AppSettingsStore()
    if let code = totpToCopy(detail: detail, autoCopy: settings.autoCopyTotp, now: Date()) {
      SecureClipboard.copy(code, clearAfter: settings.clipboardClearSeconds)
    }
  }

  private func completePasswordFill(for summary: VaultEntrySummary) {
    Task { @MainActor in
      do {
        let detail = try await resolver.decryptEntryDetail(entryId: summary.id)
        let credential = ASPasswordCredential(user: detail.username, password: detail.password)
        autoCopyTotpIfEnabled(detail)
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
        let code = try generateTOTPCode(
          params: TOTPParams(
            secret: secret,
            algorithm: detail.totpAlgorithm,
            digits: detail.totpDigits,
            period: detail.totpPeriod
          ),
          at: Date()
        )
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
    // Replace any previously-presented child (e.g. the foreground spinner) so a
    // single hosted view is shown at a time (spinner → picker / locked sheet).
    for child in children {
      child.willMove(toParent: nil)
      child.view.removeFromSuperview()
      child.removeFromParent()
    }
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

