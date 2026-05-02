import Foundation
import CryptoKit

/// Port of extension/src/lib/totp.ts — RFC 6238 implementation without external deps.

public enum TOTPAlgorithm: String, Sendable {
  case sha1 = "SHA1"
  case sha256 = "SHA256"
  case sha512 = "SHA512"
}

public struct TOTPParams: Sendable, Equatable {
  public let secret: String       // Base32
  public let algorithm: TOTPAlgorithm
  public let digits: Int          // 6-8
  public let period: Int          // 15-60 seconds

  public init(
    secret: String,
    algorithm: TOTPAlgorithm = .sha1,
    digits: Int = 6,
    period: Int = 30
  ) {
    self.secret = secret
    self.algorithm = algorithm
    self.digits = digits
    self.period = period
  }
}

public enum TOTPError: Error, Equatable {
  case invalidParams
  case invalidBase32Secret
}

/// Generate a TOTP code for the given params at the specified time.
public func generateTOTPCode(params: TOTPParams, at time: Date = Date()) throws -> String {
  guard params.digits >= 6, params.digits <= 8 else { throw TOTPError.invalidParams }
  guard params.period >= 15, params.period <= 60 else { throw TOTPError.invalidParams }

  let secretBytes = try base32Decode(params.secret)
  let counter = UInt64(time.timeIntervalSince1970) / UInt64(params.period)

  var counterBE = counter.bigEndian
  let counterData = withUnsafeBytes(of: &counterBE) { Data($0) }

  let mac = hmac(algorithm: params.algorithm, key: secretBytes, message: counterData)
  let code = dynamicTruncate(mac: mac, digits: params.digits)
  return String(format: "%0\(params.digits)d", code)
}

// MARK: - HMAC dispatch

private func hmac(algorithm: TOTPAlgorithm, key: Data, message: Data) -> Data {
  switch algorithm {
  case .sha1:
    var h = HMAC<Insecure.SHA1>(key: SymmetricKey(data: key))
    h.update(data: message)
    return Data(h.finalize())
  case .sha256:
    var h = HMAC<SHA256>(key: SymmetricKey(data: key))
    h.update(data: message)
    return Data(h.finalize())
  case .sha512:
    var h = HMAC<SHA512>(key: SymmetricKey(data: key))
    h.update(data: message)
    return Data(h.finalize())
  }
}

// MARK: - RFC 4226 §5.4 Dynamic Truncation

private func dynamicTruncate(mac: Data, digits: Int) -> Int {
  let bytes = [UInt8](mac)
  let offset = Int(bytes[bytes.count - 1] & 0x0F)
  let p: UInt32 =
    (UInt32(bytes[offset]) & 0x7F) << 24 |
    UInt32(bytes[offset + 1]) << 16 |
    UInt32(bytes[offset + 2]) << 8 |
    UInt32(bytes[offset + 3])
  let modulus = Int(pow(10.0, Double(digits)))
  return Int(p) % modulus
}

// MARK: - RFC 4648 §6 Base32 Decode

private let base32Alphabet: [Character: UInt8] = {
  var table: [Character: UInt8] = [:]
  let chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  for (i, c) in chars.enumerated() {
    table[c] = UInt8(i)
  }
  return table
}()

private func base32Decode(_ input: String) throws -> Data {
  let upper = input.uppercased().filter { $0 != "=" }
  var bits = 0
  var bitCount = 0
  var result = Data()

  for char in upper {
    guard let value = base32Alphabet[char] else {
      throw TOTPError.invalidBase32Secret
    }
    bits = (bits << 5) | Int(value)
    bitCount += 5
    if bitCount >= 8 {
      bitCount -= 8
      result.append(UInt8((bits >> bitCount) & 0xFF))
    }
  }
  return result
}
