import Foundation
import Network
import Security

/// A minimal loopback HTTPS server for real-TLS integration tests.
///
/// It terminates a genuine TLS handshake using a self-signed leaf identity
/// loaded from a bundled PKCS#12 fixture, then answers exactly one request path
/// with the passwd-sso health contract body. The point is to drive
/// `LeafKeyPinningDelegate` through an ACTUAL handshake — `SecTrust`, leaf-key
/// extraction, and pin comparison — rather than an injected probe outcome.
///
/// Scope: `NWListener` on `127.0.0.1`, ephemeral port. Not a general HTTP
/// server — it reads once and replies once.
///
/// `@unchecked Sendable`: the `NWListener` callbacks run on `queue` and are
/// `@Sendable`; all mutable state they touch (`port`, readiness) is funneled
/// through `stateLock`, and `responseBody`/`listener` are immutable after init.
final class LocalTLSServer: @unchecked Sendable {
  enum ServerError: Error {
    case fixtureMissing(String)
    case identityLoadFailed(OSStatus)
    case listenerFailed(String)
    case noPort
  }

  private let listener: NWListener
  private let responseBody: Data
  private let queue = DispatchQueue(label: "LocalTLSServer")

  private let stateLock = NSLock()
  private var _port: UInt16 = 0
  private var _failure: String?

  /// The port the listener bound to. Available after `start()` returns.
  var port: UInt16 {
    stateLock.lock()
    defer { stateLock.unlock() }
    return _port
  }

  /// Loads the leaf identity from `fixtures/TLS/<name>.p12` and configures a
  /// TLS listener that presents it.
  init(
    identityFixture: String,
    responseJSON: String = #"{"status":"alive"}"#
  ) throws {
    let identity = try Self.loadIdentity(fixture: identityFixture)
    self.responseBody = Data(responseJSON.utf8)

    let tlsOptions = NWProtocolTLS.Options()
    let secIdentity = sec_identity_create(identity)!
    sec_protocol_options_set_local_identity(tlsOptions.securityProtocolOptions, secIdentity)
    sec_protocol_options_set_min_tls_protocol_version(
      tlsOptions.securityProtocolOptions, .TLSv12)

    let params = NWParameters(tls: tlsOptions)
    params.allowLocalEndpointReuse = true
    // Bind to IPv4 loopback only. `prohibitedInterfaceTypes` / `requiredInterfaceType`
    // are not needed — restricting the address family keeps the client's
    // `127.0.0.1` connection on the same stack the listener accepts on.
    if let ipOptions = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
      ipOptions.version = .v4
    }

    // OS-assigned ephemeral port via the `port:` argument (NOT requiredLocalEndpoint,
    // which with `.any` can leave the listener without a concrete bound port).
    self.listener = try NWListener(using: params, on: .any)
  }

  /// PKCS#12 export password used by the fixtures. Not a secret — test key
  /// material only.
  static let fixturePassphrase = "passwd-sso-test"

  private static func loadIdentity(fixture: String) throws -> SecIdentity {
    let bundle = Bundle(for: LocalTLSServer.self)
    guard let url = bundle.url(forResource: fixture, withExtension: "p12")
      ?? bundle.url(forResource: fixture, withExtension: "p12", subdirectory: "TLS")
    else {
      throw ServerError.fixtureMissing("\(fixture).p12")
    }
    let data = try Data(contentsOf: url)
    let options = [kSecImportExportPassphrase as String: fixturePassphrase]
    var items: CFArray?
    let status = SecPKCS12Import(data as CFData, options as CFDictionary, &items)
    guard status == errSecSuccess,
      let array = items as? [[String: Any]],
      let first = array.first,
      let identityRef = first[kSecImportItemIdentity as String]
    else {
      throw ServerError.identityLoadFailed(status)
    }
    return identityRef as! SecIdentity  // swiftlint:disable:this force_cast
  }

  /// Start listening and resolve the bound port. Throws if the listener never
  /// reaches `.ready`.
  func start(timeout: TimeInterval = 5) throws {
    let ready = DispatchSemaphore(value: 0)

    listener.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        self.setPort(self.listener.port?.rawValue ?? 0)
        ready.signal()
      case .failed(let error):
        self.setFailure("\(error)")
        ready.signal()
      default:
        break
      }
    }

    listener.newConnectionHandler = { [weak self] connection in
      self?.handle(connection)
    }

    listener.start(queue: queue)

    if ready.wait(timeout: .now() + timeout) == .timedOut {
      listener.cancel()
      throw ServerError.listenerFailed("listener did not become ready within \(timeout)s")
    }
    stateLock.lock()
    let failure = _failure
    let boundPort = _port
    stateLock.unlock()
    if let failure {
      throw ServerError.listenerFailed(failure)
    }
    guard boundPort != 0 else { throw ServerError.noPort }
  }

  private func setPort(_ value: UInt16) {
    stateLock.lock()
    _port = value
    stateLock.unlock()
  }

  private func setFailure(_ value: String) {
    stateLock.lock()
    _failure = value
    stateLock.unlock()
  }

  func stop() {
    listener.cancel()
  }

  /// Read the request (best-effort), then write a single fixed HTTP/1.1
  /// response and close.
  private func handle(_ connection: NWConnection) {
    let body = responseBody
    connection.start(queue: queue)
    connection.receive(minimumIncompleteLength: 1, maximumLength: 8 * 1024) { _, _, _, _ in
      let header =
        "HTTP/1.1 200 OK\r\n"
        + "Content-Type: application/json\r\n"
        + "Content-Length: \(body.count)\r\n"
        + "Connection: close\r\n\r\n"
      var payload = Data(header.utf8)
      payload.append(body)
      connection.send(
        content: payload,
        completion: .contentProcessed { _ in
          connection.cancel()
        })
    }
  }
}
